import {
  AgenticEnvironment,
  DeveloperMessageItem,
  FunctionCallItem,
  FunctionCallOutputItem,
  ModelContext,
  ModelMessageItem,
  UserMessageItem,
  type Tool,
} from "@mozaik-ai/core";
import type { ExtToWebview } from "@palm-agent/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STUB_TEXT } from "../../src/context/compact.js";
import { EditorAgent } from "../../src/participants/editor-agent.js";
import { UIBridge } from "../../src/participants/ui-bridge.js";

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
  const context = ModelContext.create("test");
  // A user item keeps compaction from treating every tool output as prior-turn context.
  context.addContextItem(UserMessageItem.create("test"));
  const state = { failed: undefined as string | undefined, idle: false };
  const agent = new EditorAgent(
    environment,
    context,
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
  let bodies: Array<{ messages: ChatMessage[]; tools?: Array<{ function?: { name?: string } }> }>;

  beforeEach(() => {
    process.env.OPENAI_BASE_URL = BASE_URL;
    process.env.OPENAI_API_KEY = "not-needed";
    bodies = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(
        JSON.parse(String(init?.body)) as {
          messages: ChatMessage[];
          tools?: Array<{ function?: { name?: string } }>;
        },
      );
      const body =
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n` +
        "data: [DONE]\n\n";
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
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

  it("steers to SEARCH/REPLACE and retries when the provider returns nothing", async () => {
    // Ollama drops a gemma4 tool call it cannot parse and answers with an empty
    // body; the attempt never reaches us, so the only recovery is to re-ask on a
    // transport whose failures arrive as readable text.
    let calls = 0;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as { messages: ChatMessage[] });
      calls += 1;
      const delta =
        calls === 1
          ? { choices: [{ delta: { content: "" }, finish_reason: "stop" }] }
          : { choices: [{ delta: { content: "done" }, finish_reason: "stop" }] };
      return new Response(`data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    const { agent, state } = setup([echoTool("unused")]);
    agent.onMessage("add serde");

    await vi.waitFor(() => {
      expect(bodies).toHaveLength(2);
    });
    const retry = bodies[1]!.messages.filter((m) => m.role === "system").at(-1);
    expect(retry?.content).toContain("<<<<<<< SEARCH");
    expect(retry?.content).toContain("could not parse it");
    expect(state.failed).toBeUndefined();
    await vi.waitFor(() => {
      expect(state.idle).toBe(true);
    });
  });

  it("fails the turn when a second completion is empty too", async () => {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as { messages: ChatMessage[] });
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }) as typeof fetch;

    const { agent, state } = setup([echoTool("unused")]);
    agent.onMessage("add serde");

    await vi.waitFor(() => {
      expect(state.failed).toBe("Empty completion from provider");
    });
    // Exactly one nudge: the original call plus one retry, then it gives up.
    expect(bodies).toHaveLength(2);
  });

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

  it("does not advertise propose_edit in the Ollama tools list", async () => {
    const propose: Tool = {
      name: "propose_edit",
      description: "internal",
      strict: true,
      type: "function",
      parameters: { type: "object", properties: {}, required: [] },
      invoke: async () => "unused",
    };
    const { agent } = setup([echoTool("ok"), propose]);
    agent.onMessage("hi");
    await vi.waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    const names = (bodies[0]?.tools ?? []).map((t) => t.function?.name);
    expect(names).toContain("echo");
    expect(names).not.toContain("propose_edit");
  });

  it("stubs prior-turn tool output before the next inference", async () => {
    const environment = new AgenticEnvironment();
    const context = ModelContext.create("test");
    context.addContextItem(DeveloperMessageItem.create("sys"));
    context.addContextItem(UserMessageItem.create("first"));
    context.addContextItem(
      FunctionCallItem.rehydrate({ callId: "c1", name: "echo", args: "{}" }),
    );
    context.addContextItem(FunctionCallOutputItem.create("c1", "FILE BODY"));
    context.addContextItem(ModelMessageItem.rehydrate({ text: "done" }));
    const agent = new EditorAgent(
      environment,
      context,
      [echoTool("x")],
      "gemma4:12b",
      () => undefined,
      () => undefined,
    );
    agent.join(environment);
    agent.markActive(environment);
    agent.beginTurn(2, new AbortController().signal);
    agent.onMessage("second");
    await vi.waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    const tool = bodies[0]?.messages.find((m) => m.role === "tool");
    expect(tool?.content).toBe(STUB_TEXT);
    expect(tool?.tool_call_id).toBe("c1");
  });

  it("slides to 3 user turns and emits context_trimmed", async () => {
    const environment = new AgenticEnvironment();
    const context = ModelContext.create("test");
    context.addContextItem(DeveloperMessageItem.create("sys"));
    context.addContextItem(UserMessageItem.create("t1"));
    context.addContextItem(UserMessageItem.create("t2"));
    context.addContextItem(UserMessageItem.create("t3"));
    const events: ExtToWebview[] = [];
    const agent = new EditorAgent(
      environment,
      context,
      [echoTool("x")],
      "gemma4:12b",
      () => undefined,
      () => undefined,
      undefined,
      undefined,
      undefined,
      () => ({ lastUsed: 9000, max: 10000 }),
    );
    const ui = new UIBridge(() => (event) => events.push(event));
    agent.join(environment);
    ui.join(environment);
    agent.markActive(environment);
    agent.beginTurn(4, new AbortController().signal);
    agent.onMessage("t4");
    await vi.waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    const userTexts = (bodies[0]?.messages ?? [])
      .filter((m) => m.role === "user")
      .map((m) => m.content);
    expect(userTexts).toEqual(["t2", "t3", "t4"]);
    expect(events.some((e) => e.type === "context_trimmed")).toBe(true);
  });
});
