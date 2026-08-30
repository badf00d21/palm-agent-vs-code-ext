import {
  AgenticEnvironment,
  BaseParticipant,
  FunctionCallItem,
  ModelContext,
  ModelMessageItem,
  SemanticEvent,
  UserMessageItem,
} from "@mozaik-ai/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseToolCallsFromContent,
  runLocalChatCompletions,
} from "../../src/model/local-inference.js";

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
    const environment = {
      deliverSemanticEvent: () => undefined,
      deliverModelMessage: (_caller: unknown, item: ModelMessageItem) => {
        delivered.push(item);
      },
      deliverFunctionCall: () => {
        throw new Error("unexpected function call");
      },
    } as unknown as AgenticEnvironment;

    const context = ModelContext.create("test");
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
        expect(body.max_tokens).toBe(4096);
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
    const environment = {
      deliverSemanticEvent: (_caller: unknown, item: SemanticEvent<unknown>) => {
        events.push({ type: item.getType(), data: item.data });
      },
      deliverModelMessage: () => undefined,
      deliverFunctionCall: () => {
        throw new Error("unexpected function call");
      },
    } as unknown as AgenticEnvironment;

    const context = ModelContext.create("test");
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
    const environment = {
      deliverSemanticEvent: (_caller: unknown, item: SemanticEvent<unknown>) => {
        types.push(item.getType());
      },
      deliverModelMessage: () => undefined,
      deliverFunctionCall: () => {
        throw new Error("unexpected function call");
      },
    } as unknown as AgenticEnvironment;
    const context = ModelContext.create("test");
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
    const environment = {
      deliverSemanticEvent: () => undefined,
      deliverModelMessage: () => {
        throw new Error("should not deliver");
      },
      deliverFunctionCall: () => {
        throw new Error("should not deliver");
      },
    } as unknown as AgenticEnvironment;

    await runLocalChatCompletions({
      model: "deepseek-v4-pro",
      context: ModelContext.create("test"),
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
      context: ModelContext.create("test"),
      tools: [],
      environment: {
        deliverSemanticEvent: () => undefined,
        deliverModelMessage: () => {
          delivered = true;
        },
        deliverFunctionCall: () => {
          delivered = true;
        },
      } as unknown as AgenticEnvironment,
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
    const environment = {
      deliverSemanticEvent: () => undefined,
      deliverModelMessage: () => {
        throw new Error("should not deliver text");
      },
      deliverFunctionCall: (_caller: unknown, item: FunctionCallItem) => {
        calls.push(item);
      },
    } as unknown as AgenticEnvironment;

    await runLocalChatCompletions({
      model: "deepseek-v4-pro",
      context: ModelContext.create("test"),
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
      context: ModelContext.create("test"),
      tools: [],
      environment: {
        deliverSemanticEvent: () => undefined,
        deliverModelMessage: () => {
          delivered = true;
        },
        deliverFunctionCall: () => {
          delivered = true;
        },
      } as unknown as AgenticEnvironment,
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
      context: ModelContext.create("test"),
      tools: [],
      environment: {
        deliverSemanticEvent: () => undefined,
        deliverModelMessage: () => {
          delivered = true;
        },
        deliverFunctionCall: () => {
          delivered = true;
        },
      } as unknown as AgenticEnvironment,
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
    expect(failed).toMatch(/output token limit/);
  });

  it("fails when SSE finishes with empty content and no tool calls", async () => {
    process.env.OPENAI_BASE_URL = BASE_URL;
    let delivered = false;
    let failed = "";

    await runLocalChatCompletions({
      model: "deepseek-v4-pro",
      context: ModelContext.create("test"),
      tools: [],
      environment: {
        deliverSemanticEvent: () => undefined,
        deliverModelMessage: () => {
          delivered = true;
        },
        deliverFunctionCall: () => {
          throw new Error("unexpected function call");
        },
      } as unknown as AgenticEnvironment,
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
    const environment = {
      deliverSemanticEvent: () => undefined,
      deliverModelMessage: () => {
        throw new Error("should not deliver fence text as a model message");
      },
      deliverFunctionCall: (_caller: unknown, item: FunctionCallItem) => {
        calls.push(item);
      },
    } as unknown as AgenticEnvironment;

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
      context: ModelContext.create("test"),
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
    const environment = {
      deliverSemanticEvent: () => undefined,
      deliverModelMessage: () => {
        throw new Error("should not deliver fence text as a model message");
      },
      deliverFunctionCall: (_caller: unknown, item: FunctionCallItem) => {
        calls.push(item);
      },
    } as unknown as AgenticEnvironment;

    const fence = [
      "src/new.ts",
      "<<<<<<< SEARCH",
      "=======",
      "export const x = 1;",
      ">>>>>>> REPLACE",
    ].join("\n");

    await runLocalChatCompletions({
      model: "gemma4:12b",
      context: ModelContext.create("test"),
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

  it("fails when the provider returns JSON instead of SSE", async () => {
    process.env.OPENAI_BASE_URL = BASE_URL;
    let delivered = false;
    let failed = "";

    await runLocalChatCompletions({
      model: "deepseek-v4-pro",
      context: ModelContext.create("test"),
      tools: [],
      environment: {
        deliverSemanticEvent: () => undefined,
        deliverModelMessage: () => {
          delivered = true;
        },
        deliverFunctionCall: () => {
          delivered = true;
        },
      } as unknown as AgenticEnvironment,
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
      context: ModelContext.create("test"),
      tools: [],
      environment: {
        deliverSemanticEvent: () => undefined,
        deliverModelMessage: () => {
          delivered = true;
        },
        deliverFunctionCall: () => {
          delivered = true;
        },
      } as unknown as AgenticEnvironment,
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
      context: ModelContext.create("test"),
      tools: [],
      environment: {
        deliverSemanticEvent: (_caller: unknown, item: SemanticEvent<unknown>) => {
          narrations.push((item.data as { text?: string }).text ?? "");
        },
        deliverModelMessage: (_caller: unknown, item: ModelMessageItem) => {
          delivered.push(item);
        },
        deliverFunctionCall: () => {
          throw new Error("unexpected function call");
        },
      } as unknown as AgenticEnvironment,
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
    const narrations: Array<SemanticEvent<unknown>> = [];
    const calls: FunctionCallItem[] = [];
    const environment = {
      deliverSemanticEvent: (_caller: unknown, item: SemanticEvent<unknown>) => {
        narrations.push(item);
      },
      deliverFunctionCall: (_caller: unknown, item: FunctionCallItem) => {
        calls.push(item);
      },
      deliverModelMessage: () => {
        throw new Error("should not deliver text");
      },
    } as unknown as AgenticEnvironment;

    await runLocalChatCompletions({
      model: "deepseek-v4-pro",
      context: ModelContext.create("test"),
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
    const environment = {
      deliverSemanticEvent: (_caller: unknown, item: unknown) => {
        narrations.push(item);
      },
      deliverFunctionCall: (_caller: unknown, item: FunctionCallItem) => {
        calls.push(item);
      },
      deliverModelMessage: () => {
        throw new Error("should not deliver text");
      },
    } as unknown as AgenticEnvironment;

    await runLocalChatCompletions({
      model: "deepseek-v4-pro",
      context: ModelContext.create("test"),
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
    const environment = {
      deliverSemanticEvent: () => undefined,
      deliverFunctionCall: (_caller: unknown, item: FunctionCallItem) => {
        calls.push(item);
      },
      deliverModelMessage: () => {
        throw new Error("should not deliver text");
      },
    } as unknown as AgenticEnvironment;

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

    await runLocalChatCompletions({ ...params, context: ModelContext.create("one") });
    await runLocalChatCompletions({ ...params, context: ModelContext.create("two") });

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
      context: ModelContext.create("test"),
      tools: [],
      environment: {
        deliverSemanticEvent: (_c: unknown, item: SemanticEvent<unknown>) => {
          narrations.push((item.data as { text?: string }).text ?? "");
        },
        deliverModelMessage: (_c: unknown, item: ModelMessageItem) => {
          delivered.push(item);
        },
        deliverFunctionCall: () => {
          throw new Error("unexpected function call");
        },
      } as unknown as AgenticEnvironment,
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
      context: ModelContext.create("test"),
      tools: [],
      environment: {
        deliverSemanticEvent: () => undefined,
        deliverModelMessage: () => {
          deliveredModel = true;
        },
        deliverFunctionCall: () => {
          deliveredCall = true;
        },
      } as unknown as AgenticEnvironment,
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
