import {
  FunctionCallItem,
  FunctionCallOutputItem,
  ModelContext,
  ModelMessageItem,
  UserMessageItem,
} from "@mozaik-ai/core";
import { AgenticEnvironment, BaseParticipant, type BusEvent } from "../../src/runtime/environment.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  mapContextToChatMessages,
  parseToolCallsFromContent,
  runLocalChatCompletions,
} from "../../src/model/local-inference.js";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../../src/model/config.js";

const BASE_URL = "http://localhost:11434/v1";

function sseResponse(deltas: unknown[]): Response {
  const body =
    deltas.map((delta) => `data: ${JSON.stringify({ choices: [delta] })}\n\n`).join("") +
    "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function fakeEnv(
  overrides: {
    deliverSemanticEvent?: AgenticEnvironment["deliverSemanticEvent"];
    deliverModelMessage?: AgenticEnvironment["deliverModelMessage"];
    deliverFunctionCall?: AgenticEnvironment["deliverFunctionCall"];
  } = {},
): AgenticEnvironment {
  return {
    deliverSemanticEvent: () => undefined,
    deliverModelMessage: () => undefined,
    deliverFunctionCall: () => {
      throw new Error("unexpected function call");
    },
    ...overrides,
  } as unknown as AgenticEnvironment;
}

describe("parseToolCallsFromContent", () => {
  it("parses the raw Qwen tool-call JSON", () => {
    const calls = parseToolCallsFromContent(
      '{"name": "search", "arguments": {"glob": "*.py", "query": "def"}}',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.function?.name).toBe("search");
  });

  it("does not treat a normal JSON answer as a tool call", () => {
    expect(parseToolCallsFromContent('{"language": "TypeScript"}')).toEqual([]);
  });

  it("parses get_context with empty arguments", () => {
    const calls = parseToolCallsFromContent('{"name": "get_context", "arguments": {}}');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.function?.name).toBe("get_context");
  });

  it("finds a tool call after many braces without scanning each one", () => {
    const junk = "interface X { a: { b: { c: number } } }\n".repeat(200);
    const started = Date.now();
    const calls = parseToolCallsFromContent(
      `${junk}{"name":"read_file","arguments":{"path":"a.ts"}}`,
    );
    expect(Date.now() - started).toBeLessThan(250);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.function?.name).toBe("read_file");
  });

  it("parses Qwen { function: \"propose_edit\", arguments } in a json fence", () => {
    const text = [
      "Agent",
      "```json",
      JSON.stringify({
        function: "propose_edit",
        arguments: {
          files: [
            {
              path: "src/abc-import.ts",
              search: "function collectVoices(body: string, defs: VoiceDef[]) {",
              replace: "function collectVoices(body: string, defs: VoiceDef[]) {\n  return [];\n}",
            },
          ],
        },
      }),
      "```",
    ].join("\n");
    const calls = parseToolCallsFromContent(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.function?.name).toBe("propose_edit");
    expect(calls[0]?.function?.arguments).toEqual({
      files: [
        {
          path: "src/abc-import.ts",
          search: "function collectVoices(body: string, defs: VoiceDef[]) {",
          replace: "function collectVoices(body: string, defs: VoiceDef[]) {\n  return [];\n}",
        },
      ],
    });
  });

  it("finds a fenced propose_edit after prose that contains a brace", () => {
    const text = [
      "Let's try this again.",
      "",
      "1. **Search**: `function importStandardAbc(abcNotation: string): SheetMusic {`",
      "",
      "```json",
      JSON.stringify({
        name: "propose_edit",
        arguments: {
          files: [
            {
              path: "src/abc-import.ts",
              search: "function importStandardAbc(abcNotation: string): SheetMusic {",
              replace: "function importStandardAbc(abcNotation: string): SheetMusic {\n  return convertToSheetMusic(parsed);\n}",
            },
          ],
        },
      }),
      "```",
    ].join("\n");
    const calls = parseToolCallsFromContent(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.function?.name).toBe("propose_edit");
  });
});

describe("mapContextToChatMessages", () => {
  it("folds a propose_edit call/output into prose so Gemma cannot imitate the tool", () => {
    const context = ModelContext.create();
    context.addContextItem(UserMessageItem.create("create files"));
    context.addContextItem(
      FunctionCallItem.rehydrate({
        callId: "call_s1",
        name: "propose_edit",
        args: JSON.stringify({ files: [{ path: "a.ts", search: "", replace: "x" }] }),
      }),
    );
    context.addContextItem(FunctionCallOutputItem.create("call_s1", "Proposed review rev_1: a.ts"));

    const messages = mapContextToChatMessages(context);

    // No assistant message advertises a propose_edit tool_call, and there is no
    // orphan tool result — both would teach the native call:propose_edit dialect.
    expect(
      messages.some(
        (m) =>
          m.role === "assistant" &&
          (m.tool_calls ?? []).some((t) => t.function.name === "propose_edit"),
      ),
    ).toBe(false);
    expect(messages.some((m) => m.role === "tool")).toBe(false);
    // The outcome survives as prose so the model knows it proposed the edit.
    expect(
      messages.some((m) => m.role === "assistant" && m.content === "Proposed review rev_1: a.ts"),
    ).toBe(true);
  });

  it("keeps a real tool (read_file) as a tool_call with a tool result", () => {
    const context = ModelContext.create();
    context.addContextItem(
      FunctionCallItem.rehydrate({
        callId: "call_1",
        name: "read_file",
        args: JSON.stringify({ path: "a.ts" }),
      }),
    );
    context.addContextItem(FunctionCallOutputItem.create("call_1", "file body"));

    const messages = mapContextToChatMessages(context);

    expect(
      messages.some(
        (m) =>
          m.role === "assistant" && (m.tool_calls ?? []).some((t) => t.function.name === "read_file"),
      ),
    ).toBe(true);
    expect(messages.some((m) => m.role === "tool" && m.tool_call_id === "call_1")).toBe(true);
  });
});

describe("runLocalChatCompletions", () => {
  const prevBase = process.env.OPENAI_BASE_URL;
  const prevKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    process.env.OPENAI_BASE_URL = prevBase;
    process.env.OPENAI_API_KEY = prevKey;
  });

  it("delivers a ModelMessageItem for a local model name without Unsupported model", async () => {
    process.env.OPENAI_BASE_URL = BASE_URL;
    process.env.OPENAI_API_KEY = "not-needed";

    const delivered: ModelMessageItem[] = [];
    const environment = fakeEnv({
      deliverModelMessage: (_caller: unknown, item: ModelMessageItem) => {
        delivered.push(item);
      },
    });

    const context = ModelContext.create();
    context.addContextItem(UserMessageItem.create("hi"));

    let failed: string | undefined;
    await runLocalChatCompletions({
      model: "deepseek-v4-pro",
      context,
      tools: [],
      environment,
      caller: new BaseParticipant(),
      onFailed: (message) => {
        failed = message;
      },
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe(`${BASE_URL}/chat/completions`);
        const body = JSON.parse(String(init?.body)) as { stream?: boolean; model: string; max_tokens: number };
        expect(body.stream).toBe(true);
        expect(body.model).toBe("deepseek-v4-pro");
        expect(body.max_tokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
        return sseResponse([
          { delta: { role: "assistant", content: "hello from qwen" }, finish_reason: "stop" },
        ]);
      },
    });

    expect(failed).toBeUndefined();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toBeInstanceOf(ModelMessageItem);
    expect(delivered[0]?.content.text).toBe("hello from qwen");
  });

  it("sends stream_options.include_usage and emits context_usage from total_tokens", async () => {
    const events: Array<{ type: string; data: unknown }> = [];
    const environment = fakeEnv({
      deliverSemanticEvent: (_caller: unknown, item: BusEvent) => {
        events.push({ type: item.type, data: item.payload });
      },
    });

    const context = ModelContext.create();
    context.addContextItem(UserMessageItem.create("hi"));

    await runLocalChatCompletions({
      model: "gemma4:12b",
      context,
      tools: [],
      environment,
      caller: new BaseParticipant(),
      onFailed: () => undefined,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          stream_options?: { include_usage?: boolean };
        };
        expect(body.stream_options?.include_usage).toBe(true);
        const chunks = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`,
          "data: [DONE]\n\n",
        ].join("");
        return new Response(chunks, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      },
    });

    expect(events.some((e) => e.type === "context_usage" && (e.data as { used: number }).used === 12)).toBe(
      true,
    );
  });

  it("does not emit context_usage when the stream has no usage", async () => {
    const types: string[] = [];
    const environment = fakeEnv({
      deliverSemanticEvent: (_caller: unknown, item: BusEvent) => {
        types.push(item.type);
      },
    });
    const context = ModelContext.create();
    context.addContextItem(UserMessageItem.create("hi"));
    await runLocalChatCompletions({
      model: "gemma4:12b",
      context,
      tools: [],
      environment,
      caller: new BaseParticipant(),
      onFailed: () => undefined,
      fetchImpl: async () => sseResponse([{ delta: { content: "ok" }, finish_reason: "stop" }]),
    });
    expect(types).not.toContain("context_usage");
  });

  it("maps fetch failure to the Ollama unreachable string", async () => {
    process.env.OPENAI_BASE_URL = BASE_URL;

    let failed = "";
    const environment = fakeEnv({
      deliverModelMessage: () => {
        throw new Error("should not deliver");
      },
      deliverFunctionCall: () => {
        throw new Error("should not deliver");
      },
    });

    await runLocalChatCompletions({
      model: "deepseek-v4-pro",
      context: ModelContext.create(),
      tools: [],
      environment,
      caller: new BaseParticipant(),
      onFailed: (message) => {
        failed = message;
      },
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });

    expect(failed).toBe(`Cannot reach Ollama at ${BASE_URL}. Is it running?`);
  });

  it("passes AbortSignal to fetch and maps abort to the Ollama unreachable string", async () => {
    process.env.OPENAI_BASE_URL = BASE_URL;
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    let delivered = false;
    let failed = "";

    const running = runLocalChatCompletions({
      model: "deepseek-v4-pro",
      context: ModelContext.create(),
      tools: [],
      environment: fakeEnv({
        deliverModelMessage: () => {
          delivered = true;
        },
        deliverFunctionCall: () => {
          delivered = true;
        },
      }),
      caller: new BaseParticipant(),
      onFailed: (message) => {
        failed = message;
      },
      signal: controller.signal,
      fetchImpl: (_url, init) => {
        seenSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => {
            const error = new Error("This operation was aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (init?.signal?.aborted) {
            abort();
            return;
          }
          init?.signal?.addEventListener("abort", abort, { once: true });
        });
      },
    });

    controller.abort();
    await running;

    expect(seenSignal).toBe(controller.signal);
    expect(delivered).toBe(false);
    expect(failed).toBe(`Cannot reach Ollama at ${BASE_URL}. Is it running?`);
  });

  it("treats a JSON tool call in message content as a function call", async () => {
    process.env.OPENAI_BASE_URL = BASE_URL;
    const calls: FunctionCallItem[] = [];
    const environment = fakeEnv({
      deliverModelMessage: () => {
        throw new Error("should not deliver text");
      },
      deliverFunctionCall: (_caller: unknown, item: FunctionCallItem) => {
        calls.push(item);
      },
    });

    await runLocalChatCompletions({
      model: "deepseek-v4-pro",
      context: ModelContext.create(),
      tools: [],
      environment,
      caller: new BaseParticipant(),
      onFailed: () => {
        throw new Error("should not fail");
      },
      fetchImpl: async () =>
        sseResponse([
          {
            delta: {
              role: "assistant",
              content: '{"name": "search", "arguments": {"glob": "*.py", "query": "def"}}',
            },
            finish_reason: "stop",
          },
        ]),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("search");
    expect(JSON.parse(calls[0]?.args ?? "{}")).toEqual({ glob: "*.py", query: "def" });
  });

  it("does not deliver a completion after the turn signal is aborted", async () => {
    process.env.OPENAI_BASE_URL = BASE_URL;
    const controller = new AbortController();
    let delivered = false;
    let failed = "";

    await runLocalChatCompletions({
      model: "deepseek-v4-pro",
      context: ModelContext.create(),
      tools: [],
      environment: fakeEnv({
        deliverModelMessage: () => {
          delivered = true;
        },
        deliverFunctionCall: () => {
          delivered = true;
        },
      }),
      caller: new BaseParticipant(),
      onFailed: (message) => {
        failed = message;
      },
      signal: controller.signal,
      fetchImpl: async () => {
        controller.abort();
        return sseResponse([
          { delta: { role: "assistant", content: "late" }, finish_reason: "stop" },
        ]);
      },
    });

    expect(delivered).toBe(false);
    expect(failed).toBe("");
  });

  it("fails the turn when the model hits the token limit with no content", async () => {
    process.env.OPENAI_BASE_URL = BASE_URL;
    let delivered = false;
    let failed = "";

    await runLocalChatCompletions({
      model: "deepseek-v4-pro",
      context: ModelContext.create(),
      tools: [],
      environment: fakeEnv({
        deliverModelMessage: () => {
          delivered = true;
        },
        deliverFunctionCall: () => {
          delivered = true;
        },
      }),
      caller: new BaseParticipant(),
      onFailed: (message) => {
        failed = message;
      },
      fetchImpl: async () =>
        sseResponse([
          { delta: { role: "assistant", content: "" }, finish_reason: "length" },
        ]),
    });

    expect(delivered).toBe(false);
    expect(failed).toMatch(/output limit/);
  });

  it("names reasoning as the cause when it ate the whole budget", async () => {
    // A reasoning model spends max_tokens on thinking before writing anything.
    // Dropping those deltas made the budget look like it vanished; the failure
    // has to say where it went or it reads as unexplained.
    process.env.OPENAI_BASE_URL = BASE_URL;
    let failed = "";

    await runLocalChatCompletions({
      model: "deepseek-v4-flash",
      context: ModelContext.create(),
      tools: [],
      environment: fakeEnv(),
      caller: new BaseParticipant(),
      onFailed: (message) => {
        failed = message;
      },
      fetchImpl: async () =>
        sseResponse([
          { delta: { reasoning_content: "Let me think about this at length. " } },
          { delta: { reasoning_content: "Still thinking." }, finish_reason: "length" },
        ]),
    });

    expect(failed).toMatch(/reasoning/i);
    expect(failed).toContain("characters of thinking");
  });

  it("uses the configured output budget instead of the default", async () => {
    process.env.OPENAI_BASE_URL = BASE_URL;
    let seen: number | undefined;

    await runLocalChatCompletions({
      model: "deepseek-v4-flash",
      maxOutputTokens: 64_000,
      context: ModelContext.create(),
      tools: [],
      environment: fakeEnv({ deliverModelMessage: () => undefined }),
      caller: new BaseParticipant(),
      onFailed: () => undefined,
      fetchImpl: async (_url, init) => {
        seen = (JSON.parse(String(init?.body)) as { max_tokens: number }).max_tokens;
        return sseResponse([{ delta: { content: "ok" }, finish_reason: "stop" }]);
      },
    });

    expect(seen).toBe(64_000);
  });

  it("drops an unfinished ramble that hit the token cap instead of keeping it as context", async () => {
    // A model whose reasoning channel leaks into content can spend the whole
    // output budget deliberating and stop mid-word. That text is not an answer,
    // and in a 16k window it would crowd out every later turn.
    process.env.OPENAI_BASE_URL = BASE_URL;
    let delivered = false;
    let failed = "";

    await runLocalChatCompletions({
      model: "gemma4:12b",
      context: ModelContext.create(),
      tools: [],
      environment: fakeEnv({
        deliverModelMessage: () => {
          delivered = true;
        },
        deliverFunctionCall: () => {
          delivered = true;
        },
      }),
      caller: new BaseParticipant(),
      onFailed: (message) => {
        failed = message;
      },
      fetchImpl: async () =>
        sseResponse([
          {
            delta: { content: "Wait, I'll just do it. Actually, I'll modify `view." },
            finish_reason: "length",
          },
        ]),
    });

    expect(delivered).toBe(false);
    expect(failed).toMatch(/without reaching an answer or a tool call/);
  });

  it("keeps a fence that hit the token cap, because it is still actionable", async () => {
    process.env.OPENAI_BASE_URL = BASE_URL;
    const calls: FunctionCallItem[] = [];
    let failed = "";

    const fence = [
      "a.ts",
      "<<<<<<< SEARCH",
      "old",
      "=======",
      "new",
      ">>>>>>> REPLACE",
      "and then I was cut off mid-",
    ].join("\n");

    await runLocalChatCompletions({
      model: "gemma4:12b",
      context: ModelContext.create(),
      tools: [],
      environment: fakeEnv({
        deliverFunctionCall: (_caller: unknown, item: FunctionCallItem) => {
          calls.push(item);
        },
      }),
      caller: new BaseParticipant(),
      onFailed: (message) => {
        failed = message;
      },
      fetchImpl: async () =>
        sseResponse([{ delta: { content: fence }, finish_reason: "length" }]),
    });

    expect(failed).toBe("");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("propose_edit");
  });

  it("keeps a native tool call that hit the token cap", async () => {
    process.env.OPENAI_BASE_URL = BASE_URL;
    const calls: FunctionCallItem[] = [];
    let failed = "";

    await runLocalChatCompletions({
      model: "gemma4:12b",
      context: ModelContext.create(),
      tools: [],
      environment: fakeEnv({
        deliverFunctionCall: (_caller: unknown, item: FunctionCallItem) => {
          calls.push(item);
        },
      }),
      caller: new BaseParticipant(),
      onFailed: (message) => {
        failed = message;
      },
      fetchImpl: async () =>
        sseResponse([
          {
            delta: {
              content: "thinking out loud",
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  function: { name: "read_file", arguments: '{"path":"a.ts"}' },
                },
              ],
            },
            finish_reason: "length",
          },
        ]),
    });

    expect(failed).toBe("");
    expect(calls).toHaveLength(1);
  });

  it("still delivers a complete answer that stopped normally", async () => {
    process.env.OPENAI_BASE_URL = BASE_URL;
    const delivered: ModelMessageItem[] = [];

    await runLocalChatCompletions({
      model: "gemma4:12b",
      context: ModelContext.create(),
      tools: [],
      environment: fakeEnv({
        deliverModelMessage: (_caller: unknown, item: ModelMessageItem) => {
          delivered.push(item);
        },
      }),
      caller: new BaseParticipant(),
      onFailed: () => {
        throw new Error("should not fail");
      },
      fetchImpl: async () =>
        sseResponse([{ delta: { content: "A long but finished answer." }, finish_reason: "stop" }]),
    });

    expect(delivered).toHaveLength(1);
  });

  it("fails when SSE finishes with empty content and no tool calls", async () => {
    process.env.OPENAI_BASE_URL = BASE_URL;
    let delivered = false;
    let failed = "";

    await runLocalChatCompletions({
      model: "deepseek-v4-pro",
      context: ModelContext.create(),
      tools: [],
      environment: fakeEnv({
        deliverModelMessage: () => {
          delivered = true;
        },
      }),
      caller: new BaseParticipant(),
      onFailed: (message) => {
        failed = message;
      },
      fetchImpl: async () =>
        sseResponse([
          { delta: { role: "assistant", content: "" }, finish_reason: "stop" },
        ]),
    });

    expect(delivered).toBe(false);
    expect(failed).toMatch(/Empty completion from provider/);
  });

  it("turns SEARCH/REPLACE content into a propose_edit function call", async () => {
    process.env.OPENAI_BASE_URL = BASE_URL;
    const calls: FunctionCallItem[] = [];
    const environment = fakeEnv({
      deliverModelMessage: () => {
        throw new Error("should not deliver fence text as a model message");
      },
      deliverFunctionCall: (_caller: unknown, item: FunctionCallItem) => {
        calls.push(item);
      },
    });

    const fence = [
      "public/audio.js",
      "<<<<<<< SEARCH",
      "hitDrum(bar);",
      "=======",
      "const hit = hitDrum(bar);",
      ">>>>>>> REPLACE",
    ].join("\n");

    await runLocalChatCompletions({
      model: "gemma4:12b",
      context: ModelContext.create(),
      tools: [],
      environment,
      caller: new BaseParticipant(),
      onFailed: () => {
        throw new Error("should not fail");
      },
      fetchImpl: async () =>
        sseResponse([{ delta: { role: "assistant", content: fence }, finish_reason: "stop" }]),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("propose_edit");
    expect(JSON.parse(calls[0]?.args ?? "{}")).toEqual({
      files: [
        {
          path: "public/audio.js",
          search: "hitDrum(bar);",
          replace: "const hit = hitDrum(bar);",
        },
      ],
    });
  });

  it("turns a fenced create in message.content into propose_edit with empty SEARCH", async () => {
    process.env.OPENAI_BASE_URL = BASE_URL;
    const calls: FunctionCallItem[] = [];
    const environment = fakeEnv({
      deliverModelMessage: () => {
        throw new Error("should not deliver fence text as a model message");
      },
      deliverFunctionCall: (_caller: unknown, item: FunctionCallItem) => {
        calls.push(item);
      },
    });

    const fence = [
      "src/new.ts",
      "<<<<<<< SEARCH",
      "=======",
      "export const x = 1;",
      ">>>>>>> REPLACE",
    ].join("\n");

    await runLocalChatCompletions({
      model: "gemma4:12b",
      context: ModelContext.create(),
      tools: [],
      environment,
      caller: new BaseParticipant(),
      onFailed: () => {
        throw new Error("should not fail");
      },
      fetchImpl: async () =>
        sseResponse([{ delta: { role: "assistant", content: fence }, finish_reason: "stop" }]),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("propose_edit");
    expect(JSON.parse(calls[0]?.args ?? "{}")).toEqual({
      files: [
        {
          path: "src/new.ts",
          search: "",
          replace: "export const x = 1;",
        },
      ],
    });
  });

  it("routes a botched fence marker into an empty propose_edit for self-correction", async () => {
    process.env.OPENAI_BASE_URL = BASE_URL;
    const calls: FunctionCallItem[] = [];
    const environment = fakeEnv({
      deliverModelMessage: () => {
        throw new Error("should not deliver the botched attempt as a model message");
      },
      deliverFunctionCall: (_caller: unknown, item: FunctionCallItem) => {
        calls.push(item);
      },
    });

    await runLocalChatCompletions({
      model: "gemma4:12b",
      context: ModelContext.create(),
      tools: [],
      environment,
      caller: new BaseParticipant(),
      onFailed: () => {
        throw new Error("should not fail");
      },
      fetchImpl: async () =>
        sseResponse([
          { delta: { role: "assistant", content: "Model.h <<<<<<" }, finish_reason: "stop" },
        ]),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("propose_edit");
    expect(JSON.parse(calls[0]?.args ?? "{}")).toEqual({ files: [] });
  });

  it("fails when the provider returns JSON instead of SSE", async () => {
    process.env.OPENAI_BASE_URL = BASE_URL;
    let delivered = false;
    let failed = "";

    await runLocalChatCompletions({
      model: "deepseek-v4-pro",
      context: ModelContext.create(),
      tools: [],
      environment: fakeEnv({
        deliverModelMessage: () => {
          delivered = true;
        },
        deliverFunctionCall: () => {
          delivered = true;
        },
      }),
      caller: new BaseParticipant(),
      onFailed: (message) => {
        failed = message;
      },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { role: "assistant", content: "hello from json" },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });

    expect(delivered).toBe(false);
    expect(failed).toMatch(/Empty completion from provider/);
  });

  it("fails when SSE has no data lines", async () => {
    process.env.OPENAI_BASE_URL = BASE_URL;
    let delivered = false;
    let failed = "";

    await runLocalChatCompletions({
      model: "deepseek-v4-pro",
      context: ModelContext.create(),
      tools: [],
      environment: fakeEnv({
        deliverModelMessage: () => {
          delivered = true;
        },
        deliverFunctionCall: () => {
          delivered = true;
        },
      }),
      caller: new BaseParticipant(),
      onFailed: (message) => {
        failed = message;
      },
      fetchImpl: async () =>
        new Response("data: [DONE]\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    });

    expect(delivered).toBe(false);
    expect(failed).toMatch(/Empty completion from provider/);
  });

  it("emits one narration for assembled prose that was not streamed", async () => {
    process.env.OPENAI_BASE_URL = BASE_URL;
    const narrations: string[] = [];
    const delivered: ModelMessageItem[] = [];

    await runLocalChatCompletions({
      model: "deepseek-v4-pro",
      context: ModelContext.create(),
      tools: [],
      environment: fakeEnv({
        deliverSemanticEvent: (_caller: unknown, item: BusEvent) => {
          narrations.push((item.payload as { text?: string }).text ?? "");
        },
        deliverModelMessage: (_caller: unknown, item: ModelMessageItem) => {
          delivered.push(item);
        },
      }),
      caller: new BaseParticipant(),
      onFailed: () => {
        throw new Error("should not fail");
      },
      fetchImpl: async () =>
        sseResponse([
          {
            delta: { role: "assistant", content: '{"language": "TypeScript"}' },
            finish_reason: "stop",
          },
        ]),
    });

    expect(narrations).toEqual(['{"language": "TypeScript"}']);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.content.text).toBe('{"language": "TypeScript"}');
  });

  it("does not narrate when content accompanies native tool_calls", async () => {
    process.env.OPENAI_BASE_URL = BASE_URL;
    const narrations: Array<BusEvent> = [];
    const calls: FunctionCallItem[] = [];
    const environment = fakeEnv({
      deliverSemanticEvent: (_caller: unknown, item: BusEvent) => {
        narrations.push(item);
      },
      deliverFunctionCall: (_caller: unknown, item: FunctionCallItem) => {
        calls.push(item);
      },
      deliverModelMessage: () => {
        throw new Error("should not deliver text");
      },
    });

    await runLocalChatCompletions({
      model: "deepseek-v4-pro",
      context: ModelContext.create(),
      tools: [],
      environment,
      caller: new BaseParticipant(),
      onFailed: () => {
        throw new Error("should not fail");
      },
      fetchImpl: async () =>
        sseResponse([
          {
            delta: {
              role: "assistant",
              content: "Reading the file first.",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "read_file", arguments: '{"path":"a.ts"}' },
                },
              ],
            },
            finish_reason: "stop",
          },
        ]),
    });

    expect(narrations).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.callId).toBe("call_1");
  });

  it("does not narrate when the tool call was parsed from content", async () => {
    process.env.OPENAI_BASE_URL = BASE_URL;
    const narrations: unknown[] = [];
    const calls: FunctionCallItem[] = [];
    const environment = fakeEnv({
      deliverSemanticEvent: (_caller: unknown, item: unknown) => {
        narrations.push(item);
      },
      deliverFunctionCall: (_caller: unknown, item: FunctionCallItem) => {
        calls.push(item);
      },
      deliverModelMessage: () => {
        throw new Error("should not deliver text");
      },
    });

    await runLocalChatCompletions({
      model: "deepseek-v4-pro",
      context: ModelContext.create(),
      tools: [],
      environment,
      caller: new BaseParticipant(),
      onFailed: () => {
        throw new Error("should not fail");
      },
      fetchImpl: async () =>
        sseResponse([
          {
            delta: {
              role: "assistant",
              content: '{"name": "search", "arguments": {"query": "def"}}',
            },
            finish_reason: "stop",
          },
        ]),
    });

    expect(narrations).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("assigns unique synthetic call ids across completions", async () => {
    process.env.OPENAI_BASE_URL = BASE_URL;
    const calls: FunctionCallItem[] = [];
    const environment = fakeEnv({
      deliverFunctionCall: (_caller: unknown, item: FunctionCallItem) => {
        calls.push(item);
      },
      deliverModelMessage: () => {
        throw new Error("should not deliver text");
      },
    });

    const params = {
      model: "deepseek-v4-pro" as const,
      tools: [],
      environment,
      caller: new BaseParticipant(),
      onFailed: () => {
        throw new Error("should not fail");
      },
      fetchImpl: async () =>
        sseResponse([
          {
            delta: {
              role: "assistant",
              content: '{"name": "search", "arguments": {"query": "def"}}',
            },
            finish_reason: "stop",
          },
        ]),
    };

    await runLocalChatCompletions({ ...params, context: ModelContext.create() });
    await runLocalChatCompletions({ ...params, context: ModelContext.create() });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.callId).toMatch(/^call_s\d+$/);
    expect(calls[1]?.callId).toMatch(/^call_s\d+$/);
    expect(calls[0]?.callId).not.toBe(calls[1]?.callId);
  });

  it("streams prose narration then delivers one ModelMessageItem without a second narration", async () => {
    process.env.OPENAI_BASE_URL = BASE_URL;
    const narrations: string[] = [];
    const delivered: ModelMessageItem[] = [];
    await runLocalChatCompletions({
      model: "gemma4:12b",
      context: ModelContext.create(),
      tools: [],
      environment: fakeEnv({
        deliverSemanticEvent: (_c: unknown, item: BusEvent) => {
          narrations.push((item.payload as { text?: string }).text ?? "");
        },
        deliverModelMessage: (_c: unknown, item: ModelMessageItem) => {
          delivered.push(item);
        },
      }),
      caller: new BaseParticipant(),
      onFailed: () => {
        throw new Error("should not fail");
      },
      fetchImpl: async () =>
        sseResponse([
          { delta: { content: "Hel" } },
          { delta: { content: "lo" }, finish_reason: "stop" },
        ]),
    });
    expect(narrations).toEqual(["Hel", "lo"]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.content.text).toBe("Hello");
  });

  it("does not deliver a completion when aborted after a partial SSE chunk", async () => {
    process.env.OPENAI_BASE_URL = BASE_URL;
    const controller = new AbortController();
    let deliveredModel = false;
    let deliveredCall = false;

    await runLocalChatCompletions({
      model: "gemma4:12b",
      context: ModelContext.create(),
      tools: [],
      environment: fakeEnv({
        deliverModelMessage: () => {
          deliveredModel = true;
        },
        deliverFunctionCall: () => {
          deliveredCall = true;
        },
      }),
      caller: new BaseParticipant(),
      onFailed: () => {
        /* AbortError maps to onFailed; completion must not be delivered */
      },
      signal: controller.signal,
      fetchImpl: async () => {
        const body = new ReadableStream<Uint8Array>({
          start(s) {
            s.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"{"}}]}\n\n'));
            controller.abort();
            s.close();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    expect(deliveredModel).toBe(false);
    expect(deliveredCall).toBe(false);
  });
});
