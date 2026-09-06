import { DeveloperMessageItem, ModelContext } from "@mozaik-ai/core";
import { attachCloud } from "../runtime/cloud.js";
import { AgenticEnvironment, BaseParticipant } from "../runtime/environment.js";
import type { ExtToWebview } from "@palm-agent/shared";
import type { CompactBudget } from "../context/compact.js";
import { loadWorkspaceInstructions } from "../context/instructions.js";
import type { ChatCompletionFetch } from "../model/local-inference.js";
import type { ModelConfig } from "../model/config.js";
import { EditorAgent } from "../participants/editor-agent.js";
import { UIBridge } from "../participants/ui-bridge.js";
import type { QuestionHost } from "../tools/question.js";
import { createResearchTool } from "../tools/research.js";
import type { ReviewHost } from "../tools/review.js";
import { SYSTEM_PROMPT, createWorkspaceTools } from "../tools/tools.js";
import type { WorkspacePort } from "../workspace/port.js";
import { assertCanStartTurn } from "./session-guards.js";

export type SessionEventSink = (event: ExtToWebview) => void;

/** Diagnostic line sink (VS Code OutputChannel in the extension). Never receives file contents. */
export type SessionTrace = (line: string) => void;

export interface AgentSession {
  readonly busy: boolean;
  startTurn(text: string): Promise<void>;
  cancel(): void;
  setSink(sink: SessionEventSink): void;
  reset(): void;
  setLastUsed(used: number): void;
  setContextMax(max: number | null): void;
  /** Hands the human's answer to a waiting `question` tool call. */
  answerQuestion(id: string, answer: string): void;
}

/** Idle between tool steps. Must not run while Ollama is generating. */
const IDLE_TIMEOUT_MS = 120_000;
/** Cold 14B load + one completion. */
const INFERENCE_TIMEOUT_MS = 600_000;

function idleTimedOut(): string {
  return `Turn timed out after ${IDLE_TIMEOUT_MS / 1000}s without progress. Send again or press Stop.`;
}

function inferenceTimedOut(): string {
  return `The model did not finish in ${INFERENCE_TIMEOUT_MS / 1000}s. Send again, or press Stop.`;
}

export interface CreateSessionOptions {
  mozaikApiKey?: string;
  mozaikCloudEndpoint?: string;
  fetchImpl?: ChatCompletionFetch;
}

export function createAgentSession(
  port: WorkspacePort,
  config: ModelConfig,
  initialSink: SessionEventSink = () => undefined,
  reviewHost: ReviewHost,
  trace: SessionTrace = () => undefined,
  options: CreateSessionOptions = {},
): AgentSession {
  let sink = initialSink;
  let busy = false;
  let generation = 0;
  let turnAbort: AbortController | undefined;
  let settle: ((event: ExtToWebview) => void) | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const clearIdleTimer = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const armTimer = (fromGeneration: number, ms: number, message: string): void => {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      turnAbort?.abort();
      finish(fromGeneration, { type: "error", message });
    }, ms);
  };

  const bumpIdleTimer = (fromGeneration: number): void => {
    armTimer(fromGeneration, IDLE_TIMEOUT_MS, idleTimedOut());
  };

  const bumpInferenceTimer = (fromGeneration: number): void => {
    armTimer(fromGeneration, INFERENCE_TIMEOUT_MS, inferenceTimedOut());
  };

  const finish = (fromGeneration: number, event: ExtToWebview): void => {
    if (fromGeneration !== generation || !busy) {
      trace(
        `turn ${fromGeneration}: finish ${event.type} ignored (current=${generation} busy=${busy})`,
      );
      return;
    }
    trace(
      `turn ${fromGeneration}: finish ${event.type}${
        event.type === "error" ? ` "${event.message.slice(0, 160)}"` : ""
      }`,
    );
    clearIdleTimer();
    turnAbort?.abort();
    // Unblock any tool still waiting on a human, or its promise never settles.
    abandonQuestions();
    busy = false;
    const done = settle;
    settle = undefined;
    if (event.type === "done") {
      queueMicrotask(() => {
        sink(event);
        done?.(event);
      });
      return;
    }
    sink(event);
    done?.(event);
  };

  /**
   * A question is human time, not model time, so no timeout may run while one is
   * open — the inference timer armed before the tool call would otherwise fire
   * mid-dialog and blame Ollama for a person still reading. The timer is re-armed
   * once the last open question is settled.
   */
  const openQuestions = new Map<string, (answer: string) => void>();
  let questionSeq = 0;

  const settleQuestion = (id: string, answer: string): boolean => {
    const resolve = openQuestions.get(id);
    if (!resolve) {
      return false;
    }
    openQuestions.delete(id);
    resolve(answer);
    return true;
  };

  const abandonQuestions = (): void => {
    for (const id of [...openQuestions.keys()]) {
      settleQuestion(id, "");
      sink({ type: "question_settled", id, answer: null });
    }
  };

  const questionHost: QuestionHost = {
    ask: ({ question, options }) =>
      new Promise<string>((resolve) => {
        questionSeq += 1;
        const id = `q_${questionSeq}_${Math.random().toString(36).slice(2, 8)}`;
        openQuestions.set(id, resolve);
        clearIdleTimer();
        trace(`question ${id} asked, ${options.length} options`);
        sink({ type: "question_asked", id, question, options });
      }),
  };

  const tools = createWorkspaceTools(port, reviewHost, questionHost);
  /**
   * Built once, but reads `environment` and `turnAbort` through getters: both are
   * replaced on every rebuild() and every turn, and a value captured here would
   * point at a dead bus after the first New Chat.
   */
  tools.push(
    createResearchTool({
      getEnvironment: () => environment,
      getModel: () => config.model,
      tools,
      getSignal: () => turnAbort?.signal,
      fetchImpl: options.fetchImpl,
      // Research is model and I/O time, not human time, so the idle timer must
      // keep running — but it has to be bumped on every worker step or a run
      // past IDLE_TIMEOUT_MS would be killed as a stall.
      onHeartbeat: () => bumpIdleTimer(generation),
    }),
  );
  let lastUsed: number | undefined;
  let contextMax: number | null = null;
  let environment = new AgenticEnvironment();
  let context = ModelContext.create();
  let user = new BaseParticipant("User");
  let agent: EditorAgent;
  let ui: UIBridge;
  let cloud: ReturnType<typeof attachCloud> | undefined;

  const getBudget = (): CompactBudget => ({ lastUsed, max: contextMax });

  /**
   * Loaded lazily on the first turn of each context, not in rebuild(), because
   * reading the file is async. New chat rebuilds the context and clears this,
   * which doubles as the refresh point after the user edits AGENTS.md.
   */
  let instructionsLoaded = false;

  const loadInstructionsOnce = async (): Promise<void> => {
    if (instructionsLoaded) {
      return;
    }
    instructionsLoaded = true;
    const instructions = await loadWorkspaceInstructions(port);
    if (!instructions) {
      trace("instructions: none found");
      return;
    }
    trace(`instructions: loaded ${instructions.length}ch`);
    // Appended while the context still holds only SYSTEM_PROMPT, so it lands
    // ahead of every user message — where compactContext never trims it.
    context.addContextItem(DeveloperMessageItem.create(instructions));
  };

  const rebuild = (): void => {
    void cloud?.end();
    environment = new AgenticEnvironment();
    context = ModelContext.create();
    context.addContextItem(DeveloperMessageItem.create(SYSTEM_PROMPT));
    instructionsLoaded = false;
    user = new BaseParticipant("User");
    agent = new EditorAgent(
      environment,
      context,
      tools,
      () => config.model,
      (fromGeneration) => finish(fromGeneration, { type: "done" }),
      (message, fromGeneration) => finish(fromGeneration, { type: "error", message }),
      (fromGeneration) => bumpIdleTimer(fromGeneration),
      (fromGeneration) => bumpInferenceTimer(fromGeneration),
      trace,
      getBudget,
      () => config.maxOutputTokens,
      options.fetchImpl,
    );
    ui = new UIBridge(() => sink);
    agent.join(environment);
    ui.join(environment);
    user.join(environment);
    const apiKey = options.mozaikApiKey?.trim();
    cloud = apiKey
      ? attachCloud(environment, { apiKey, endpoint: options.mozaikCloudEndpoint }, trace, (url) =>
          sink({ type: "cloud_session", url }),
        )
      : undefined;
  };

  rebuild();

  const session: AgentSession = {
    get busy() {
      return busy;
    },
      reset() {
        if (busy) {
          return;
        }
        lastUsed = undefined;
        rebuild();
      },
      answerQuestion(id: string, answer: string) {
        if (!settleQuestion(id, answer)) {
          trace(`question ${id} answered but no longer open`);
          return;
        }
        trace(`question ${id} answered`);
        sink({ type: "question_settled", id, answer });
        // The model is working again, so a timeout is meaningful again.
        if (busy && openQuestions.size === 0) {
          bumpIdleTimer(generation);
        }
      },
      setLastUsed(used: number) {
        lastUsed = used;
      },
      setContextMax(max: number | null) {
        contextMax = max;
      },
      setSink(next: SessionEventSink) {
        sink = next;
      },
      cancel() {
        if (!busy) {
          return;
        }
        finish(generation, { type: "error", message: "Cancelled" });
      },
      async startTurn(text: string) {
      const blocked = assertCanStartTurn(text, {
        busy,
        hasWorkspace: port.hasWorkspace(),
      });
      if (blocked) {
        sink(blocked);
        return;
      }
      process.env.OPENAI_BASE_URL = config.baseUrl;
      process.env.OPENAI_API_KEY = config.apiKey;
      generation += 1;
      const myGeneration = generation;
      trace(`turn ${myGeneration}: start model=${config.model} base=${config.baseUrl}`);
      turnAbort?.abort();
      turnAbort = new AbortController();
      agent.beginTurn(myGeneration, turnAbort.signal);
      agent.markActive(environment);
      busy = true;
      bumpInferenceTimer(myGeneration);
      // busy is already set: reading the instruction file must not open a window
      // where cancel(), reset(), or a second startTurn think the agent is free.
      await loadInstructionsOnce();
      if (myGeneration !== generation || !busy) {
        trace(`turn ${myGeneration}: abandoned while loading instructions`);
        return;
      }
      await new Promise<void>((resolve) => {
        settle = () => {
          resolve();
        };
        environment.sendUserMessage(text.trim(), user);
      });
    },
  };

  return session;
}
