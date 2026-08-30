import {
  AgenticEnvironment,
  FunctionCallItem,
  ModelContext,
  ModelMessageItem,
  type Tool,
} from "@mozaik-ai/core";
import { describe, expect, it, vi } from "vitest";
import { EditorAgent } from "../../src/participants/editor-agent.js";

function boomTool(message: string): Tool {
  return {
    name: "boom",
    description: "throws",
    strict: true,
    type: "function",
    parameters: { type: "object", properties: {}, required: [] },
    invoke: async () => {
      throw new Error(message);
    },
  };
}

describe("EditorAgent missing tool", () => {
  it("clears pending and calls onFailed so the next model message can idle", () => {
    let failed: string | undefined;
    let idle = false;
    const agent = new EditorAgent(
      new AgenticEnvironment(),
      ModelContext.create("test"),
      [],
      "deepseek-v4-pro",
      () => {
        idle = true;
      },
      (message) => {
        failed = message;
      },
    );

    agent.onFunctionCall(
      FunctionCallItem.rehydrate({
        callId: "call_missing",
        name: "nope",
        args: "{}",
      }),
    );

    expect(failed).toBe("Tool nope not found");
    expect(idle).toBe(false);

    agent.onModelMessage(ModelMessageItem.rehydrate({ text: "done" }));
    expect(idle).toBe(true);
  });
});

describe("EditorAgent executeFunctionCall failures", () => {
  it("calls onFailed with the real tool error, not the Ollama-down string", async () => {
    let failed: string | undefined;
    const environment = new AgenticEnvironment();
    const agent = new EditorAgent(
      environment,
      ModelContext.create("test"),
      [boomTool("disk exploded")],
      "deepseek-v4-pro",
      () => undefined,
      (message) => {
        failed = message;
      },
    );
    agent.join(environment);

    agent.onFunctionCall(
      FunctionCallItem.rehydrate({
        callId: "call_boom",
        name: "boom",
        args: "{}",
      }),
    );

    await vi.waitFor(() => {
      expect(failed).toBe("disk exploded");
    });
    expect(failed).not.toMatch(/Cannot reach Ollama/);
  });

  it("slices a long executeFunctionCall error to 400 characters", async () => {
    let failed: string | undefined;
    const long = "x".repeat(500);
    const environment = new AgenticEnvironment();
    const agent = new EditorAgent(
      environment,
      ModelContext.create("test"),
      [boomTool(long)],
      "deepseek-v4-pro",
      () => undefined,
      (message) => {
        failed = message;
      },
    );
    agent.join(environment);

    agent.onFunctionCall(
      FunctionCallItem.rehydrate({
        callId: "call_long",
        name: "boom",
        args: "{}",
      }),
    );

    await vi.waitFor(() => {
      expect(failed).toBe(long.slice(0, 400));
    });
  });

  it("calls onFailed with the parse error when tool args are not JSON", async () => {
    let failed: string | undefined;
    const environment = new AgenticEnvironment();
    const agent = new EditorAgent(
      environment,
      ModelContext.create("test"),
      [boomTool("unused")],
      "deepseek-v4-pro",
      () => undefined,
      (message) => {
        failed = message;
      },
    );
    agent.join(environment);

    agent.onFunctionCall(
      FunctionCallItem.rehydrate({
        callId: "call_bad_args",
        name: "boom",
        args: "not-json",
      }),
    );

    await vi.waitFor(() => {
      expect(failed).toBeTruthy();
      expect(failed).not.toMatch(/Cannot reach Ollama/);
      expect(failed?.length).toBeLessThanOrEqual(400);
    });
  });
});
