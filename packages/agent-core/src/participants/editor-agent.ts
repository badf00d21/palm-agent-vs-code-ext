import {
  AgenticEnvironment,
  AgenticError,
  BaseParticipant,
  FunctionCallItem,
  FunctionCallOutputItem,
  ModelContext,
  ModelMessageItem,
  UserMessageItem,
  type Tool,
} from "@mozaik-ai/core";
import { runLocalChatCompletions } from "../model/local-inference.js";

function sliceError(error: unknown): string {
  const message = error instanceof Error && error.message ? error.message : String(error);
  return message.slice(0, 400);
}

const MAX_INFERENCE_STEPS = 12;

export class EditorAgent extends BaseParticipant {
  private readonly pendingCalls = new Set<string>();
  private turnGeneration = 0;
  private signal: AbortSignal | undefined;
  private inferenceSteps = 0;

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
  ) {
    super();
  }

  beginTurn(generation: number, signal: AbortSignal): void {
    this.turnGeneration = generation;
    this.signal = signal;
    this.pendingCalls.clear();
    this.inferenceSteps = 0;
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

  override onError(error: AgenticError): void {
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
    let args: unknown;
    try {
      args = item.args.trim() ? JSON.parse(item.args) : {};
    } catch (error) {
      return `Error: Tool arguments are not valid JSON (${sliceError(error)}). Repeat the call with arguments as one JSON object.`;
    }
    try {
      const result: unknown = await tool.invoke(args);
      return typeof result === "string" ? result : (JSON.stringify(result) ?? "");
    } catch (error) {
      return `Error: ${sliceError(error)}`;
    }
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
      this.onFailed("Too many tool steps in one turn", generation);
      return;
    }
    this.onTrace?.(
      `inference step ${this.inferenceSteps}/${MAX_INFERENCE_STEPS} contextItems=${this.context.getItems().length}`,
    );
    void runLocalChatCompletions({
      trace: this.onTrace,
      model: this.model,
      tools: this.tools,
      context: this.context,
      environment: this.environment,
      caller: this,
      signal,
      generation,
      isCurrent: () => !this.isStale(generation),
      onFailed: (message) => {
        if (this.isStale(generation)) {
          return;
        }
        this.onFailed(message, generation);
      },
    });
  }
}
