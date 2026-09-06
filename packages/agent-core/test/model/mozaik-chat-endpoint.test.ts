import { ModelContext, UserMessageItem } from "@mozaik-ai/core";
import { describe, expect, it, vi } from "vitest";
import { collectMozaikChatStream } from "../../src/model/mozaik-chat-endpoint.js";

function input() {
  const context = ModelContext.create();
  context.addContextItem(UserMessageItem.create("x"));
  return { model: "test", streaming: true, context };
}

describe("collectMozaikChatStream", () => {
  it("applies raw chunks and merges final token usage", async () => {
    const prose: string[] = [];
    const fakeEndpoint = {
      async *stream() {
        yield { choices: [{ delta: { content: "Hi" }, finish_reason: null }] };
        yield {
          type: "inference.output",
          payload: {
            items: [],
            tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 42 },
            rowResponse: {
              choices: [{ finish_reason: "stop", message: { content: "Hi" } }],
            },
          },
        };
      },
    };

    const assembled = await collectMozaikChatStream({
      endpoint: fakeEndpoint as never,
      input: input(),
      onProseDelta: (delta) => prose.push(delta),
    });

    expect(prose.join("")).toBe("Hi");
    expect(assembled.content).toBe("Hi");
    expect(assembled.finishReason).toBe("stop");
    expect(assembled.usage).toEqual({
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 42,
    });
  });

  it("prefers OpenAI row response usage", async () => {
    const fakeEndpoint = {
      async *stream() {
        yield {
          type: "inference.output",
          payload: {
            tokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            rowResponse: {
              usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
              choices: [],
            },
          },
        };
      },
    };

    const assembled = await collectMozaikChatStream({
      endpoint: fakeEndpoint as never,
      input: input(),
    });

    expect(assembled.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    });
  });

  it("does not narrate SEARCH/REPLACE fence content", async () => {
    const fence = "public/audio.js\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE";
    const prose: string[] = [];
    const fakeEndpoint = {
      async *stream() {
        yield { choices: [{ delta: { content: fence }, finish_reason: "stop" }] };
      },
    };

    const assembled = await collectMozaikChatStream({
      endpoint: fakeEndpoint as never,
      input: input(),
      onProseDelta: (delta) => prose.push(delta),
    });

    expect(prose).toEqual([]);
    expect(assembled.content).toBe(fence);
  });

  it("aborts a pending iterator read and closes the endpoint stream", async () => {
    const controller = new AbortController();
    let resolvePending: ((result: IteratorResult<never>) => void) | undefined;
    const cleanup = vi.fn();
    const iterator: AsyncIterator<never> = {
      next: vi.fn(
        () =>
          new Promise<IteratorResult<never>>((resolve) => {
            resolvePending = resolve;
          }),
      ),
      return: vi.fn(async (): Promise<IteratorResult<never>> => {
        cleanup();
        resolvePending?.({ done: true, value: undefined });
        return { done: true, value: undefined };
      }),
    };
    const fakeEndpoint = {
      stream: () => ({
        [Symbol.asyncIterator]: () => iterator,
      }),
    };

    const collecting = collectMozaikChatStream({
      endpoint: fakeEndpoint as never,
      input: input(),
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();

    await expect(collecting).rejects.toMatchObject({ name: "AbortError" });
    expect(iterator.return).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
