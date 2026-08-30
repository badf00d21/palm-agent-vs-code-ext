import {
  AgenticEnvironment,
  FunctionCallItem,
  ModelContext,
  type Tool,
} from "@mozaik-ai/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorAgent } from "../../src/participants/editor-agent.js";

const BASE_URL = "http://localhost:11434/v1";

interface ChatMessage {
  role: string;
  content?: string | null;
  tool_call_id?: string;
}

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

function echoTool(output: string): Tool {
  return {
    name: "echo",
    description: "returns fixed output",
    strict: true,
    type: "function",
    parameters: { type: "object", properties: {}, required: [] },
    invoke: async () => output,
  };
}

function setup(tools: Tool[]) {
  const environment = new AgenticEnvironment();
  const state = { failed: undefined as string | undefined, idle: false };
  const agent = new EditorAgent(
    environment,
    ModelContext.create("test"),
    tools,
    "gemma4:12b",
    () => {
      state.idle = true;
    },
    (message) => {
      state.failed = message;
    },
  );
  agent.join(environment);
  agent.markActive(environment);
  agent.beginTurn(1, new AbortController().signal);
  return { agent, state };
}

describe("EditorAgent tool failure feedback", () => {
  const prevBase = process.env.OPENAI_BASE_URL;
  const prevKey = process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;
  let bodies: Array<{ messages: ChatMessage[] }>;

  beforeEach(() => {
    process.env.OPENAI_BASE_URL = BASE_URL;
    process.env.OPENAI_API_KEY = "not-needed";
    bodies = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as { messages: ChatMessage[] });
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
  });

  afterEach(() => {
    process.env.OPENAI_BASE_URL = prevBase;
    process.env.OPENAI_API_KEY = prevKey;
    globalThis.fetch = originalFetch;
  });

  function toolOutput(body: { messages: ChatMessage[] }): ChatMessage | undefined {
    return body.messages.find((m) => m.role === "tool");
  }

  it("feeds an unknown tool back to the model instead of failing the turn", async () => {
    const { agent, state } = setup([echoTool("unused")]);

    agent.onFunctionCall(
      FunctionCallItem.rehydrate({ callId: "call_missing", name: "nope", args: "{}" }),
    );

    await vi.waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    const output = toolOutput(bodies[0]!);
    expect(output?.tool_call_id).toBe("call_missing");
    expect(output?.content).toBe("Error: Unknown tool nope. Available tools: echo");
    expect(state.failed).toBeUndefined();
    await vi.waitFor(() => {
      expect(state.idle).toBe(true);
    });
  });

  it("feeds invalid JSON args back to the model and keeps the turn alive", async () => {
    const { agent, state } = setup([echoTool("unused")]);

    agent.onFunctionCall(
      FunctionCallItem.rehydrate({ callId: "call_bad_args", name: "echo", args: "not-json" }),
    );

    await vi.waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(toolOutput(bodies[0]!)?.content).toMatch(/^Error: Tool arguments are not valid JSON/);
    expect(state.failed).toBeUndefined();
  });

  it("treats empty args as an empty object instead of a parse error", async () => {
    const { agent, state } = setup([echoTool("fine")]);

    agent.onFunctionCall(
      FunctionCallItem.rehydrate({ callId: "call_empty", name: "echo", args: "" }),
    );

    await vi.waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(toolOutput(bodies[0]!)?.content).toBe("fine");
    expect(state.failed).toBeUndefined();
  });

  it("feeds a thrown tool error back with the real message, not the Ollama-down string", async () => {
    const { agent, state } = setup([boomTool("disk exploded")]);

    agent.onFunctionCall(
      FunctionCallItem.rehydrate({ callId: "call_boom", name: "boom", args: "{}" }),
    );

    await vi.waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(toolOutput(bodies[0]!)?.content).toBe("Error: disk exploded");
    expect(toolOutput(bodies[0]!)?.content).not.toMatch(/Cannot reach Ollama/);
    expect(state.failed).toBeUndefined();
  });

  it("slices a long thrown error to 400 characters", async () => {
    const long = "x".repeat(500);
    const { agent } = setup([boomTool(long)]);

    agent.onFunctionCall(
      FunctionCallItem.rehydrate({ callId: "call_long", name: "boom", args: "{}" }),
    );

    await vi.waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(toolOutput(bodies[0]!)?.content).toBe(`Error: ${long.slice(0, 400)}`);
  });

  it("delivers multiline tool output raw, without JSON escaping", async () => {
    const raw = 'line1\n  indented "quoted"\nline3 with \\backslash';
    const { agent } = setup([echoTool(raw)]);

    agent.onFunctionCall(
      FunctionCallItem.rehydrate({ callId: "call_raw", name: "echo", args: "{}" }),
    );

    await vi.waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(toolOutput(bodies[0]!)?.content).toBe(raw);
  });
});
