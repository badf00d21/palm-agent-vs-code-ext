import {
  FunctionCallItem,
  FunctionCallOutputItem,
  ModelContext,
  ModelMessageItem,
  UserMessageItem,
  type Tool,
} from "@mozaik-ai/core";
import { AgenticEnvironment, BaseParticipant } from "../runtime/environment.js";
import { runLocalChatCompletions, type ChatCompletionFetch } from "../model/local-inference.js";

/**
 * The read-only surface a research worker may use. Deliberately the exact list
 * from the design brief. `write`, `edit`, `propose_edit`, `question` and
 * `research` itself are never included even when present in the host's full
 * tool list — a worker that edits files, blocks on a human, or recurses into
 * another fan-out is a bug, not a feature.
 */
const READ_ONLY_TOOL_NAMES = new Set([
  "read_file",
  "list_dir",
  "search",
  "outline",
  "glob",
  // Language-server lookups: tracing a symbol across the codebase is most of
  // what a research sub-question actually is.
  "references",
  "hover",
  "diagnostics",
  "web_fetch",
  "docs_search",
]);

/**
 * Named explicitly rather than matched by prefix. An allow-list fails closed:
 * a tool added later is excluded until someone decides it is safe here, which
 * is the right default when the thing being excluded is the ability to write.
 */
export function filterReadOnlyTools(tools: Tool[]): Tool[] {
  return tools.filter((tool) => READ_ONLY_TOOL_NAMES.has(tool.name));
}

export const WORKER_SYSTEM_PROMPT =
  "You are one of several research workers spawned to answer a piece of a larger question in parallel. " +
  "You own exactly one sub-question. Use only the tools you were given (all read-only) to find the answer; " +
  "you cannot write, edit, or propose any file change, and you cannot ask a human anything — do not attempt to. " +
  "Work efficiently: prefer outline before read_file, and read_file only the lines you need. " +
  "When you have enough to answer, reply with a short, dense answer of at most a few sentences (aim under 400 characters) " +
  "and stop calling tools. Cite files as path:line when it helps. If you cannot find an answer, say so in one sentence " +
  "instead of guessing.";

/** Mirrors EditorAgent's loop guard, scaled down: a worker owns one narrow sub-question. */
export const WORKER_MAX_INFERENCE_STEPS = 6;
/** Same rationale as EditorAgent: a third identical call is a loop, not a re-check. */
export const WORKER_MAX_IDENTICAL_CALLS = 2;

function sliceError(error: unknown): string {
  const message = error instanceof Error && error.message ? error.message : String(error);
  return message.slice(0, 400);
}

/** Stable key for one tool call, so key order in the model's JSON does not matter. */
function callSignature(name: string, rawArgs: string): string {
  let args = rawArgs.trim();
  try {
    const parsed: unknown = args ? JSON.parse(args) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      args = JSON.stringify(
        Object.keys(record)
          .sort()
          .map((key) => [key, record[key]]),
      );
    }
  } catch {
    /* unparsable args still compare fine as raw text */
  }
  return `${name} ${args}`;
}

/** Short, content-free activity line for progress UI — never the tool's output. */
export function describeToolCall(name: string, rawArgs: string): string {
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs.trim() ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    /* fall through with no target */
  }
  const target = String(args.path ?? args.pattern ?? args.query ?? args.symbol ?? "").slice(0, 80);
  return target ? `${name} ${target}` : name;
}

export interface ResearchWorkerCallbacks {
  /** Fired whenever the worker starts a tool call — a short, content-free label. */
  onActivity: (line: string) => void;
  /** Terminal success: the worker's raw final answer text (uncapped; the caller truncates). */
  onDone: (text: string) => void;
  /** Terminal failure. The run continues without this worker's finding. */
  onFailed: (message: string) => void;
}

/**
 * A read-only sibling of EditorAgent, sized for one sub-question instead of a whole
 * turn. Runs on the SAME AgenticEnvironment as the main agent and other workers —
 * Mozaik's bus broadcasts every event to every joined participant, but BaseParticipant
 * only calls onFunctionCall/onFunctionCallOutput/onModelMessage for events this
 * worker itself produced (matched by producerId); everything else lands on the
 * onExternal* no-ops it inherits unchanged. That producerId match is what keeps
 * concurrent workers — and the main EditorAgent — from driving each other's loops.
 */
export class ResearchWorkerAgent extends BaseParticipant {
  private readonly pendingCalls = new Set<string>();
  private readonly callCounts = new Map<string, number>();
  private inferenceSteps = 0;
  private signal: AbortSignal | undefined;
  private settled = false;

  constructor(
    private readonly environment: AgenticEnvironment,
    private readonly context: ModelContext,
    private readonly tools: Tool[],
    private readonly model: string,
    private readonly callbacks: ResearchWorkerCallbacks,
    private readonly fetchImpl?: ChatCompletionFetch,
  ) {
    super("Research Worker", "agent");
  }

  /** Adds the sub-question to context and kicks off the first inference step. */
  start(question: string, signal: AbortSignal): void {
    this.signal = signal;
    this.context.addContextItem(UserMessageItem.create(question));
    this.run();
  }

  override onFunctionCall(item: FunctionCallItem): void {
    if (this.isStale()) {
      return;
    }
    const runnableItem = item.args.trim()
      ? item
      : FunctionCallItem.rehydrate({ callId: item.callId, name: item.name, args: "{}" });
    this.callbacks.onActivity(describeToolCall(item.name, item.args));
    this.pendingCalls.add(item.callId);
    this.context.addContextItem(runnableItem);
    void this.invokeTool(runnableItem);
  }

  override onFunctionCallOutput(item: FunctionCallOutputItem): void {
    this.context.addContextItem(item);
    this.pendingCalls.delete(item.callId);
    if (this.isStale()) {
      return;
    }
    if (this.pendingCalls.size === 0) {
      this.run();
    }
  }

  override onModelMessage(item: ModelMessageItem): void {
    if (this.isStale()) {
      return;
    }
    this.context.addContextItem(item);
    if (this.pendingCalls.size === 0) {
      this.finish(item.content.text);
    }
  }

  override onError(error: Error): void {
    if (this.isStale()) {
      return;
    }
    this.fail(error.message ?? String(error));
  }

  private finish(text: string): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.callbacks.onDone(text);
  }

  private fail(message: string): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.callbacks.onFailed(sliceError(message));
  }

  private isStale(): boolean {
    return this.settled || this.signal?.aborted === true;
  }

  private async invokeTool(item: FunctionCallItem): Promise<void> {
    const guarded = this.guardTool(item);
    let outputItem: FunctionCallOutputItem;
    if (guarded !== null) {
      outputItem = FunctionCallOutputItem.create(item.callId, guarded);
    } else {
      const tool = this.tools.find((candidate) => candidate.name === item.name)!;
      try {
        outputItem = await this.environment.getFunctionCallRunner().run(item, tool);
      } catch (error) {
        outputItem = FunctionCallOutputItem.create(item.callId, `Error: ${sliceError(error)}`);
      }
    }
    try {
      this.environment.deliverFunctionCallOutput(this, outputItem);
    } catch (error) {
      this.pendingCalls.delete(item.callId);
      if (!this.isStale()) {
        this.fail(sliceError(error));
      }
    }
  }

  private guardTool(item: FunctionCallItem): string | null {
    const tool = this.tools.find((t) => t.name === item.name);
    if (!tool) {
      const names = this.tools.map((t) => t.name).join(", ");
      return `Error: Unknown tool ${item.name}. Available tools: ${names}`;
    }
    const signature = callSignature(item.name, item.args);
    const ran = this.callCounts.get(signature) ?? 0;
    if (ran >= WORKER_MAX_IDENTICAL_CALLS) {
      return (
        `Error: ${item.name} already ran ${ran} times this turn with these exact arguments and the result will not change. ` +
        "Work with the result you already have or answer with what you found."
      );
    }
    this.callCounts.set(signature, ran + 1);
    try {
      JSON.parse(item.args);
    } catch (error) {
      return `Error: Tool arguments are not valid JSON (${sliceError(error)}).`;
    }
    return null;
  }

  private run(): void {
    if (this.isStale()) {
      return;
    }
    this.inferenceSteps += 1;
    if (this.inferenceSteps > WORKER_MAX_INFERENCE_STEPS) {
      this.fail("Too many tool steps for this sub-question");
      return;
    }
    const signal = this.signal;
    void runLocalChatCompletions({
      model: this.model,
      tools: this.tools,
      context: this.context,
      environment: this.environment,
      caller: this,
      signal,
      fetchImpl: this.fetchImpl,
      isCurrent: () => !this.isStale(),
      onEmptyCompletion: () => false,
      // Deliberately unconditional: an abort mid-completion makes isStale() true
      // for exactly the reason this callback exists to report, so gating on it
      // (as EditorAgent does, where a *different* mechanism settles the turn on
      // abort) would drop the failure and leave the caller's promise unsettled
      // forever. fail() itself is idempotent against a result that already
      // settled through onDone/onModelMessage.
      onFailed: (message) => this.fail(message),
    });
  }
}
