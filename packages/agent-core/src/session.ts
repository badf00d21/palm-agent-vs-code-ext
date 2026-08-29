import {
  AgenticEnvironment,
  BaseParticipant,
  DeveloperMessageItem,
  ModelContext,
  sendMessage,
} from "@mozaik-ai/core";
import type { ExtToWebview } from "@palm-agent/shared";
import type { ModelConfig } from "./config.js";
import { EditorAgent } from "./participants/editor-agent.js";
import { UIBridge } from "./participants/ui-bridge.js";
import type { WorkspacePort } from "./port.js";
import { assertCanStartTurn } from "./session-guards.js";
import type { ReviewHost } from "./review.js";
import { SYSTEM_PROMPT, createWorkspaceTools } from "./tools.js";

export type SessionEventSink = (event: ExtToWebview) => void;

export interface AgentSession {
  readonly busy: boolean;
  startTurn(text: string): Promise<void>;
  cancel(): void;
  setSink(sink: SessionEventSink): void;
}

const TURN_TIMEOUT_MS = 120_000;

function turnTimedOut(): string {
  return `Turn timed out after ${TURN_TIMEOUT_MS / 1000}s without progress. Send again or press Stop.`;
}

export function createAgentSession(
  port: WorkspacePort,
  config: ModelConfig,
  initialSink: SessionEventSink = () => undefined,
  reviewHost: ReviewHost,
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

  const bumpIdleTimer = (fromGeneration: number): void => {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      turnAbort?.abort();
      finish(fromGeneration, { type: "error", message: turnTimedOut() });
    }, TURN_TIMEOUT_MS);
  };

  const finish = (fromGeneration: number, event: ExtToWebview): void => {
    if (fromGeneration !== generation || !busy) {
      return;
    }
    clearIdleTimer();
    turnAbort?.abort();
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

  const environment = new AgenticEnvironment();
  const context = ModelContext.create("palm-agent");
  context.addContextItem(DeveloperMessageItem.create(SYSTEM_PROMPT));
  const tools = createWorkspaceTools(port, reviewHost);
  const user = new BaseParticipant();
  const agent = new EditorAgent(
    environment,
    context,
    tools,
    config.model,
    (fromGeneration) => finish(fromGeneration, { type: "done" }),
    (message, fromGeneration) => finish(fromGeneration, { type: "error", message }),
    (fromGeneration) => bumpIdleTimer(fromGeneration),
  );
  const ui = new UIBridge(() => sink);

  agent.join(environment);
  ui.join(environment);
  user.join(environment);

  const session: AgentSession = {
    get busy() {
      return busy;
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
        model: config.model,
      });
      if (blocked) {
        sink(blocked);
        return;
      }
      process.env.OPENAI_BASE_URL = config.baseUrl;
      process.env.OPENAI_API_KEY = config.apiKey;
      generation += 1;
      const myGeneration = generation;
      turnAbort?.abort();
      turnAbort = new AbortController();
      agent.beginTurn(myGeneration, turnAbort.signal);
      agent.markActive(environment);
      busy = true;
      bumpIdleTimer(myGeneration);
      await new Promise<void>((resolve) => {
        settle = () => {
          resolve();
        };
        sendMessage(environment, text.trim(), user);
      });
    },
  };

  return session;
}
