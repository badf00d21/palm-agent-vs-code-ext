import {
  AgenticEnvironment,
  BaseParticipant,
  FunctionCallItem,
  ModelContext,
  ModelMessageItem,
  UserMessageItem,
} from "@mozaik-ai/core";
import { afterEach, describe, expect, it } from "vitest";
import { parseToolCallsFromContent, runLocalChatCompletions } from "./local-inference.js";

const BASE_URL = "http://localhost:11434/v1";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
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
        const body = JSON.parse(String(init?.body)) as { model: string };
        expect(body.model).toBe("deepseek-v4-pro");
        return jsonResponse({
          choices: [{ message: { role: "assistant", content: "hello from qwen" } }],
        });
      },
    });

    expect(failed).toBeUndefined();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toBeInstanceOf(ModelMessageItem);
    expect(delivered[0]?.content.text).toBe("hello from qwen");
  });

  it("maps fetch failure to the Ollama unreachable string", async () => {
    process.env.OPENAI_BASE_URL = BASE_URL;

    let failed = "";
    const environment = {
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
      fetchImpl: async (_url, init) => {
        seenSignal = init?.signal;
        await new Promise<never>((_resolve, reject) => {
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
        jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: '{"name": "search", "arguments": {"glob": "*.py", "query": "def"}}',
              },
            },
          ],
        }),
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
        return jsonResponse({
          choices: [{ message: { role: "assistant", content: "late" } }],
        });
      },
    });

    expect(delivered).toBe(false);
    expect(failed).toBe("");
  });
});
