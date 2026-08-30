import {
  AgenticEnvironment,
  AgenticError,
  BaseParticipant,
  FunctionCallItem,
  FunctionCallOutputItem,
  ModelContext,
  ModelMessageItem,
  UserMessageItem,
  executeFunctionCall,
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
  private readonly failedCallIds = new Set<string>();
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
  ) {
    super();
  }

  beginTurn(generation: number, signal: AbortSignal): void {
    this.turnGeneration = generation;
    this.signal = signal;
    this.pendingCalls.clear();
    this.failedCallIds.clear();
    this.inferenceSteps = 0;
  }

  override onMessage(message: string): void {
    this.context.addContextItem(UserMessageItem.create(message));
    this.run();
  }

  override onFunctionCall(item: FunctionCallItem): void {
    const generation = this.turnGeneration;
    if (this.isStale(generation)) {
      return;
    }
    this.pendingCalls.add(item.callId);
    this.context.addContextItem(item);
    const tool = this.tools.find((t) => t.name === item.name);
    if (!tool) {
      this.pendingCalls.delete(item.callId);
      this.onFailed(`Tool ${item.name} not found`, generation);
      return;
    }
    try {
      JSON.parse(item.args);
      executeFunctionCall(this.environment, item, this.wrapTool(item, tool, generation), this);
    } catch (error) {
      this.pendingCalls.delete(item.callId);
      if (!this.isStale(generation)) {
        this.onFailed(sliceError(error), generation);
      }
    }
  }

  override onFunctionCallOutput(item: FunctionCallOutputItem): void {
    const generation = this.turnGeneration;
    this.context.addContextItem(item);
    this.pendingCalls.delete(item.callId);
    if (this.failedCallIds.delete(item.callId)) {
      return;
    }
    if (this.isStale(generation)) {
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
      return;
    }
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

  private wrapTool(item: FunctionCallItem, tool: Tool, generation: number): Tool {
    return {
      ...tool,
      invoke: async (args) => {
        try {
          return await tool.invoke(args);
        } catch (error) {
          this.pendingCalls.delete(item.callId);
          this.failedCallIds.add(item.callId);
          if (!this.isStale(generation)) {
            this.onFailed(sliceError(error), generation);
          }
          return `Error: ${sliceError(error)}`;
        }
      },
    };
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
    this.onActivity?.(generation);
    this.inferenceSteps += 1;
    if (this.inferenceSteps > MAX_INFERENCE_STEPS) {
      this.onFailed("Too many tool steps in one turn", generation);
      return;
    }
    void runLocalChatCompletions({
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
