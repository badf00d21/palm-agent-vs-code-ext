import {
  DeveloperMessageItem,
  FunctionCallItem,
  FunctionCallOutputItem,
  ModelContext,
  ModelMessageItem,
  UserMessageItem,
  type Tool,
} from "@mozaik-ai/core";
import { AgenticEnvironment, BaseParticipant, createSemanticEvent } from "../runtime/environment.js";
import {
  compactContext,
  CONTEXT_TRIMMED_EVENT,
  type CompactBudget,
} from "../context/compact.js";
import { runLocalChatCompletions } from "../model/local-inference.js";
import { toolsVisibleToModel } from "../tools/tools.js";

function sliceError(error: unknown): string {
  const message = error instanceof Error && error.message ? error.message : String(error);
  return message.slice(0, 400);
}

/** Explore + a few edits routinely exceeds 12; the cap is a runaway brake, not a goal. */
export const MAX_INFERENCE_STEPS = 20;
/** Leave this many inferences for write/edit instead of another search. */
export const WIND_DOWN_STEPS = 3;

const WRITE_TOOLS = new Set(["write", "edit", "propose_edit"]);
const EXPLORE_TOOLS = new Set([
  "search",
  "glob",
  "list_dir",
  "outline",
  "read_file",
  "web_fetch",
  "docs_search",
  "research",
  "diagnostics",
  "references",
  "hover",
  "get_context",
]);

const WIND_DOWN_NUDGE =
  "Few inference steps remain this turn. Stop searching and reading. " +
  "If you have a change, call write or edit now with old_string you already have. " +
  "If you do not, answer the user in one short sentence. Do not start research.";

/**
 * Ollama's gemma4 tool dialect mangles arguments that carry code (braces,
 * quotes, newlines) and then returns an empty body, so the attempt never
 * reaches us — the turn would just die. Steer the retry to SEARCH/REPLACE
 * markers, which arrive as ordinary text we can parse and correct even when
 * the model gets them slightly wrong.
 */
const EMPTY_COMPLETION_RECOVERY =
  "Your last reply was lost before it reached the workspace — the provider could not parse it. " +
  "This happens when a tool call carries code. Do not call write or edit for this change. " +
  "Instead put the change directly in your message as a block that looks exactly like this:\n" +
  "path/to/file\n<<<<<<< SEARCH\nexact old text\n=======\nnew text\n>>>>>>> REPLACE\n" +
  "For a new file leave the SEARCH part empty. Send only these blocks and one short sentence.";

/** One nudge per turn; a second empty completion means the model is stuck. */
const MAX_EMPTY_RECOVERIES = 1;

/**
 * How many times one identical call (same tool, same arguments) may actually run
 * in a turn. Two is deliberate: re-reading a file after editing it is normal, so
 * only the third identical call is a loop. Observed 2026-09-01, where the model
 * called read_file on a missing path six times and burned the step budget.
 */
const MAX_IDENTICAL_CALLS = 2;

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

export class EditorAgent extends BaseParticipant {
  private readonly pendingCalls = new Set<string>();
  private turnGeneration = 0;
  private signal: AbortSignal | undefined;
  private inferenceSteps = 0;
  private emptyRecoveries = 0;
  private woundDown = false;
  private lastToolWasWrite = false;
  private readonly callCounts = new Map<string, number>();

  constructor(
    private readonly environment: AgenticEnvironment,
    private readonly context: ModelContext,
    private readonly tools: Tool[],
    private readonly model: string,
    private readonly onIdle: (generation: number) => void,
    private readonly onFailed: (message: string, generation: number) => void,
    private readonly onActivity?: (generation: number) => void,
    private readonly onWaitForModel?: (generation: number) => void,
    private readonly onTrace?: (line: string) => void,
    private readonly getBudget: () => CompactBudget = () => ({ max: null }),
  ) {
    super("Editor Agent", "agent");
  }

  beginTurn(generation: number, signal: AbortSignal): void {
    this.turnGeneration = generation;
    this.signal = signal;
    this.pendingCalls.clear();
    this.inferenceSteps = 0;
    this.emptyRecoveries = 0;
    this.woundDown = false;
    this.lastToolWasWrite = false;
    this.callCounts.clear();
  }

  /** Returns true when a retry was scheduled, false to let the turn fail. */
  private recoverFromEmptyCompletion(generation: number): boolean {
    if (this.isStale(generation) || this.emptyRecoveries >= MAX_EMPTY_RECOVERIES) {
      return false;
    }
    this.emptyRecoveries += 1;
    this.onTrace?.("empty completion: steering to SEARCH/REPLACE and retrying");
    this.context.addContextItem(DeveloperMessageItem.create(EMPTY_COMPLETION_RECOVERY));
    this.run();
    return true;
  }

  override onMessage(message: string): void {
    this.context.addContextItem(UserMessageItem.create(message));
    this.run();
  }

  override onFunctionCall(item: FunctionCallItem): void {
    const generation = this.turnGeneration;
    if (this.isStale(generation)) {
      this.onTrace?.(`tool ${item.name} (${item.callId}) dropped: stale turn`);
      return;
    }
    this.onTrace?.(`tool ${item.name} (${item.callId}) start args=${item.args.slice(0, 100)}`);
    this.pendingCalls.add(item.callId);
    this.context.addContextItem(item);
    void this.invokeTool(item, generation);
  }

  override onFunctionCallOutput(item: FunctionCallOutputItem): void {
    const generation = this.turnGeneration;
    this.context.addContextItem(item);
    this.pendingCalls.delete(item.callId);
    if (this.isStale(generation)) {
      this.onTrace?.(`tool output (${item.callId}) recorded on stale turn`);
      return;
    }
    this.onActivity?.(generation);
    if (this.pendingCalls.size === 0) {
      if (this.lastToolWasWrite && this.remainingSteps() <= 1) {
        this.onTrace?.("write landed near step budget — finishing the turn");
        this.onIdle(generation);
        return;
      }
      this.run();
    }
  }

  override onModelMessage(item: ModelMessageItem): void {
    const generation = this.turnGeneration;
    if (this.isStale(generation)) {
      this.onTrace?.("model message dropped: stale turn");
      return;
    }
    this.onTrace?.(
      `model message ${item.content.text.length}ch pending=${this.pendingCalls.size}`,
    );
    this.context.addContextItem(item);
    if (this.pendingCalls.size === 0) {
      this.onIdle(generation);
    }
  }

  override onError(error: Error): void {
    const generation = this.turnGeneration;
    if (this.isStale(generation)) {
      return;
    }
    const message = error.message ?? String(error);
    const unreachable = /fetch|ECONNREFUSED|ENOTFOUND|network/i.test(message);
    this.onFailed(
      unreachable
        ? `Cannot reach Ollama at ${process.env.OPENAI_BASE_URL ?? "the configured URL"}. Is it running?`
        : message.slice(0, 400),
      generation,
    );
  }

  /**
   * Bypasses Mozaik's executeFunctionCall on purpose: its runner JSON.stringifies
   * every output, so the model would read file text as one escaped line. Outputs
   * must reach the model raw. Tool problems (unknown name, bad JSON args, a
   * throwing invoke) go back to the model as the call's output so it can correct
   * itself — they do not end the turn, and the call/output pairing in the context
   * stays intact for the next request.
   */
  private async invokeTool(item: FunctionCallItem, generation: number): Promise<void> {
    const started = Date.now();
    const output = await this.runTool(item);
    this.onTrace?.(
      `tool ${item.name} (${item.callId}) done in ${Date.now() - started}ms, output=${output.length}ch${
        output.startsWith("Error:") ? " (error fed back)" : ""
      }`,
    );
    try {
      this.environment.deliverFunctionCallOutput(
        this,
        FunctionCallOutputItem.create(item.callId, output),
      );
    } catch (error) {
      this.pendingCalls.delete(item.callId);
      if (!this.isStale(generation)) {
        this.onFailed(sliceError(error), generation);
      }
    }
  }

  private async runTool(item: FunctionCallItem): Promise<string> {
    const tool = this.tools.find((t) => t.name === item.name);
    if (!tool) {
      const names = this.tools.map((t) => t.name).join(", ");
      return `Error: Unknown tool ${item.name}. Available tools: ${names}`;
    }
    const signature = callSignature(item.name, item.args);
    const ran = this.callCounts.get(signature) ?? 0;
    if (ran >= MAX_IDENTICAL_CALLS) {
      this.onTrace?.(`tool ${item.name} (${item.callId}) blocked: identical call ran ${ran} times`);
      return (
        `Error: ${item.name} already ran ${ran} times this turn with these exact arguments and the result will not change. ` +
        "Do not repeat it. Work with the result you already have, call it with different arguments, or answer the user."
      );
    }
    this.callCounts.set(signature, ran + 1);
    if (this.remainingSteps() <= 1 && EXPLORE_TOOLS.has(item.name)) {
      return (
        "Error: Almost no steps left this turn. Do not search or read more. " +
        "Call write or edit with the text you already have, or answer the user."
      );
    }
    let args: unknown;
    try {
      args = item.args.trim() ? JSON.parse(item.args) : {};
    } catch (error) {
      return `Error: Tool arguments are not valid JSON (${sliceError(error)}). Repeat the call with arguments as one JSON object.`;
    }
    try {
      const result: unknown = await tool.invoke(args);
      this.lastToolWasWrite = WRITE_TOOLS.has(item.name);
      return typeof result === "string" ? result : (JSON.stringify(result) ?? "");
    } catch (error) {
      this.lastToolWasWrite = false;
      return `Error: ${sliceError(error)}`;
    }
  }

  private remainingSteps(): number {
    return MAX_INFERENCE_STEPS - this.inferenceSteps;
  }

  private steerTowardEdit(): void {
    if (this.woundDown || this.remainingSteps() > WIND_DOWN_STEPS) {
      return;
    }
    this.woundDown = true;
    this.onTrace?.(`wind-down: ${this.remainingSteps()} steps left — steering to write/edit`);
    this.context.addContextItem(DeveloperMessageItem.create(WIND_DOWN_NUDGE));
  }

  private isStale(generation: number): boolean {
    return generation !== this.turnGeneration || this.signal?.aborted === true;
  }

  private run(): void {
    const generation = this.turnGeneration;
    const signal = this.signal;
    if (this.isStale(generation)) {
      return;
    }
    this.onWaitForModel?.(generation);
    this.inferenceSteps += 1;
    if (this.inferenceSteps > MAX_INFERENCE_STEPS) {
      this.onTrace?.(
        `inference budget exhausted after ${MAX_INFERENCE_STEPS} steps — finishing the turn`,
      );
      this.onIdle(generation);
      return;
    }
    this.steerTowardEdit();
    const { trimmed } = compactContext(this.context.getItems(), this.getBudget());
    if (trimmed) {
      this.environment.deliverSemanticEvent(
        this,
        createSemanticEvent(CONTEXT_TRIMMED_EVENT, {}, this.getId()),
      );
    }
    this.onTrace?.(
      `inference step ${this.inferenceSteps}/${MAX_INFERENCE_STEPS} contextItems=${this.context.getItems().length}`,
    );
    void runLocalChatCompletions({
      trace: this.onTrace,
      model: this.model,
      tools: toolsVisibleToModel(this.tools),
      context: this.context,
      environment: this.environment,
      caller: this,
      signal,
      generation,
      isCurrent: () => !this.isStale(generation),
      onEmptyCompletion: () => this.recoverFromEmptyCompletion(generation),
      onFailed: (message) => {
        if (this.isStale(generation)) {
          return;
        }
        this.onFailed(message, generation);
      },
    });
  }
}
