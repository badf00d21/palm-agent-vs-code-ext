import {
  DeveloperMessageItem,
  ModelContext,
  ModelMessageItem,
  UserMessageItem,
  type Tool,
} from "@mozaik-ai/core";
import type { ResearchWorker } from "@palm-agent/shared";
import { AgenticEnvironment, BaseParticipant } from "../runtime/environment.js";
import { runLocalChatCompletions, type ChatCompletionFetch } from "../model/local-inference.js";
import { filterReadOnlyTools, ResearchWorkerAgent, WORKER_SYSTEM_PROMPT } from "./worker.js";

/** More workers just deepen the queue on Ollama's single inference slot. */
export const MAX_SUBQUESTIONS = 4;
/** I/O (reads, ripgrep) overlaps freely; in-flight inference does not, so this stays small. */
export const MAX_CONCURRENT_WORKERS = 3;
/** Budget per worker finding — the whole point is the parent never pays for raw material. */
export const FINDING_CHAR_LIMIT = 350;
/** Hard cap on the assembled digest handed back to the parent agent. */
export const DIGEST_CHAR_LIMIT = 2000;
const SUBQUESTION_CHAR_LIMIT = 300;

const DECOMPOSE_SYSTEM =
  "You split a research question into independent sub-questions that separate workers can answer in parallel, " +
  `without talking to each other. Reply with ONLY a JSON array of at most ${MAX_SUBQUESTIONS} short strings, ` +
  "one sub-question per string. No prose, no markdown fence, no keys other than the array itself. " +
  "If the question is already narrow and cannot usefully be split, reply with a JSON array containing just that one question.";

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function stripFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

/**
 * Turns the decomposer's reply into sub-questions, tolerating a weak model that
 * ignores the "JSON only" instruction. Falls back to the original question as the
 * sole sub-question rather than failing the run outright.
 */
export function parseSubQuestions(raw: string, original: string): string[] {
  const candidates = [raw.trim(), stripFence(raw)];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        const questions = parsed
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim().slice(0, SUBQUESTION_CHAR_LIMIT))
          .filter((entry) => entry.length > 0);
        if (questions.length > 0) {
          return dedupe(questions).slice(0, MAX_SUBQUESTIONS);
        }
      }
    } catch {
      // Not JSON — fall through to the line heuristic below.
    }
  }
  // A single unstructured line is not a list — most often it is a weak model's
  // refusal or restated prose ("I cannot split this question."), and treating it
  // as one sub-question would research the model's excuse instead of the user's
  // actual question. Only a genuine multi-line list is trusted here.
  const lines = stripFence(raw)
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length > 0 && line.length <= SUBQUESTION_CHAR_LIMIT);
  if (lines.length > 1) {
    return dedupe(lines).slice(0, MAX_SUBQUESTIONS);
  }
  return [original];
}

/**
 * One-shot participant used only to run the decomposition inference call and
 * collect its answer. Joins the shared bus like any other participant; a
 * function call it did not expect (tools=[] is sent, but a weak model may still
 * emit one) or a failed/aborted completion both resolve to "" so the caller
 * falls back to a single worker instead of hanging.
 */
class OneShotAsker extends BaseParticipant {
  private settle: ((text: string) => void) | undefined;

  constructor() {
    super("Research Decomposer", "agent");
  }

  ask(params: {
    environment: AgenticEnvironment;
    model: string;
    prompt: string;
    signal: AbortSignal;
    fetchImpl?: ChatCompletionFetch;
  }): Promise<string> {
    return new Promise((resolve) => {
      this.settle = resolve;
      const context = ModelContext.create();
      context.addContextItem(DeveloperMessageItem.create(DECOMPOSE_SYSTEM));
      context.addContextItem(UserMessageItem.create(params.prompt));
      void runLocalChatCompletions({
        model: params.model,
        tools: [],
        context,
        environment: params.environment,
        caller: this,
        signal: params.signal,
        fetchImpl: params.fetchImpl,
        isCurrent: () => this.settle !== undefined,
        onEmptyCompletion: () => false,
        onFailed: () => this.resolveOnce(""),
      });
    });
  }

  override onModelMessage(item: ModelMessageItem): void {
    this.resolveOnce(item.content.text);
  }

  override onFunctionCall(): void {
    // A tool call means the model ignored "reply with only JSON" — treat it as
    // unusable output rather than letting the promise hang forever.
    this.resolveOnce("");
  }

  override onError(): void {
    this.resolveOnce("");
  }

  private resolveOnce(text: string): void {
    const settle = this.settle;
    this.settle = undefined;
    settle?.(text);
  }
}

export interface ResearchCoordinatorHost {
  /** The shared bus the parent EditorAgent and UIBridge are already joined to. */
  environment: AgenticEnvironment;
  model: string;
  /** The full workspace tool list; filtered to the read-only subset internally. */
  tools: Tool[];
  /** Injectable transport for tests; production omits it so global fetch is used. */
  fetchImpl?: ChatCompletionFetch;
  createId?: () => string;
  /** Fired once with the full initial fan-out, all workers "pending". */
  onStarted?: (workers: ResearchWorker[]) => void;
  /** Fired on every subsequent worker state change (running/activity/done/failed). */
  onWorkerEvent?: (worker: ResearchWorker) => void;
  /**
   * Fired alongside every onStarted/onWorkerEvent call. Research is I/O and model
   * time, not human time, so unlike `question` it must not clear the caller's idle
   * timer outright — it must keep bumping it for as long as the run makes progress.
   */
  onHeartbeat?: () => void;
}

export interface ResearchRunResult {
  status: "done" | "failed" | "cancelled";
  digest?: string;
  message?: string;
  workers: ResearchWorker[];
}

function buildDigest(workers: ResearchWorker[]): string {
  const lines: string[] = [];
  for (const worker of workers) {
    if (worker.status === "done" && worker.finding) {
      lines.push(`Q: ${worker.question}\nA: ${worker.finding}`);
    } else if (worker.status === "failed") {
      lines.push(`Q: ${worker.question}\n(failed: ${worker.error ?? "unknown error"})`);
    }
  }
  let digest = lines.join("\n\n");
  if (digest.length > DIGEST_CHAR_LIMIT) {
    digest = `${digest.slice(0, DIGEST_CHAR_LIMIT)}\n[digest truncated]`;
  }
  return digest;
}

/**
 * Decomposes `question`, fans it out to read-only workers on `host.environment`
 * with concurrency capped at MAX_CONCURRENT_WORKERS, and returns one compact
 * digest. Never rejects and never hangs: an abort mid-run resolves with whatever
 * findings are already in, marked "cancelled".
 */
export async function runResearch(
  question: string,
  host: ResearchCoordinatorHost,
  signal: AbortSignal,
): Promise<ResearchRunResult> {
  const createId = host.createId ?? (() => crypto.randomUUID());
  const readOnlyTools = filterReadOnlyTools(host.tools);

  if (signal.aborted) {
    return { status: "cancelled", workers: [], message: "Research cancelled before it started." };
  }

  let subQuestions: string[];
  try {
    const asker = new OneShotAsker();
    host.environment.join(asker);
    const raw = await asker.ask({
      environment: host.environment,
      model: host.model,
      prompt: question,
      signal,
      fetchImpl: host.fetchImpl,
    });
    subQuestions = parseSubQuestions(raw, question);
  } catch {
    subQuestions = [question];
  }
  if (subQuestions.length === 0) {
    subQuestions = [question];
  }

  const workers: ResearchWorker[] = subQuestions.map((subQuestion) => ({
    id: createId(),
    question: subQuestion,
    status: "pending",
    steps: 0,
  }));

  host.onStarted?.(workers.map((worker) => ({ ...worker })));
  host.onHeartbeat?.();

  const emit = (worker: ResearchWorker): void => {
    host.onWorkerEvent?.({ ...worker });
    host.onHeartbeat?.();
  };

  if (signal.aborted) {
    for (const worker of workers) {
      worker.status = "failed";
      worker.error = "Cancelled";
      emit(worker);
    }
    return { status: "cancelled", workers, message: "Research cancelled before it started." };
  }

  let nextIndex = 0;
  const runOne = async (): Promise<void> => {
    for (;;) {
      const myIndex = nextIndex;
      nextIndex += 1;
      if (myIndex >= workers.length) {
        return;
      }
      const worker = workers[myIndex];
      if (!worker) {
        return;
      }
      if (signal.aborted) {
        worker.status = "failed";
        worker.error = "Cancelled";
        emit(worker);
        continue;
      }
      worker.status = "running";
      emit(worker);

      const context = ModelContext.create();
      context.addContextItem(DeveloperMessageItem.create(WORKER_SYSTEM_PROMPT));

      const outcome = await new Promise<{ ok: true; text: string } | { ok: false; message: string }>(
        (resolve) => {
          const agent = new ResearchWorkerAgent(
            host.environment,
            context,
            readOnlyTools,
            host.model,
            {
              onActivity: (line) => {
                worker.activity = line;
                worker.steps += 1;
                emit(worker);
              },
              onDone: (text) => resolve({ ok: true, text }),
              onFailed: (message) => resolve({ ok: false, message }),
            },
            host.fetchImpl,
          );
          host.environment.join(agent);
          agent.start(worker.question, signal);
        },
      );

      if (outcome.ok) {
        worker.status = "done";
        worker.finding = outcome.text.trim().slice(0, FINDING_CHAR_LIMIT);
      } else {
        worker.status = "failed";
        worker.error = (signal.aborted ? "Cancelled" : outcome.message).slice(0, 400);
      }
      emit(worker);
    }
  };

  const runnerCount = Math.min(MAX_CONCURRENT_WORKERS, workers.length);
  await Promise.all(Array.from({ length: runnerCount }, () => runOne()));

  const digest = buildDigest(workers);
  const succeeded = workers.filter((worker) => worker.status === "done");

  if (signal.aborted) {
    return {
      status: "cancelled",
      workers,
      digest: digest || undefined,
      message: "Research cancelled before all workers finished.",
    };
  }
  if (succeeded.length === 0) {
    const reason = workers.find((worker) => worker.status === "failed")?.error ?? "unknown error";
    return {
      status: "failed",
      workers,
      message: `All research workers failed (${reason}).`,
    };
  }
  return { status: "done", workers, digest };
}
