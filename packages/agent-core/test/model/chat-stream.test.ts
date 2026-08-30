import { describe, expect, it } from "vitest";
import {
  applyChatChunk,
  emptyAssembly,
  iterateSseData,
  readSseChatCompletion,
  streamMode,
} from "../../src/model/chat-stream.js";

describe("iterateSseData", () => {
  it("yields data payloads and stops at [DONE]", () => {
    const text = [
      'data: {"choices":[{"delta":{"content":"Hi"}}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    expect(iterateSseData(text)).toEqual(['{"choices":[{"delta":{"content":"Hi"}}]}']);
  });

  it("ignores data payloads after [DONE] in the same text", () => {
    const text = [
      'data: {"choices":[{"delta":{"content":"A"}}]}',
      "",
      "data: [DONE]",
      "",
      'data: {"choices":[{"delta":{"content":"B"}}]}',
      "",
    ].join("\n");
    expect(iterateSseData(text)).toEqual(['{"choices":[{"delta":{"content":"A"}}]}']);
  });
});

describe("applyChatChunk + streamMode", () => {
  it("accumulates prose deltas", () => {
    const acc = emptyAssembly();
    const a = applyChatChunk(acc, { choices: [{ delta: { content: "Hel" } }] });
    const b = applyChatChunk(acc, { choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] });
    expect(a.contentDelta).toBe("Hel");
    expect(b.contentDelta).toBe("lo");
    expect(acc.content).toBe("Hello");
    expect(acc.finishReason).toBe("stop");
    expect(streamMode(acc)).toBe("prose");
  });

  it("switches to tool when content contains a SEARCH fence", () => {
    const acc = emptyAssembly();
    applyChatChunk(acc, { choices: [{ delta: { content: "public/audio.js\n<<<<<<< SEARCH\n" } }] });
    expect(streamMode(acc)).toBe("tool");
  });

  it("switches to tool when content starts with {", () => {
    const acc = emptyAssembly();
    applyChatChunk(acc, { choices: [{ delta: { content: '{"name"' } }] });
    expect(streamMode(acc)).toBe("tool");
  });

  it("switches to tool on native tool_calls", () => {
    const acc = emptyAssembly();
    applyChatChunk(acc, {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: "" } }],
          },
        },
      ],
    });
    applyChatChunk(acc, {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"path":"a.ts"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    expect(streamMode(acc)).toBe("tool");
    expect(acc.toolCalls[0]).toEqual({
      id: "call_1",
      function: { name: "read_file", arguments: '{"path":"a.ts"}' },
    });
  });

  it("records usage from a final chunk with empty choices", () => {
    const acc = emptyAssembly();
    applyChatChunk(acc, { choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] });
    applyChatChunk(acc, {
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    });
    expect(acc.content).toBe("Hi");
    expect(acc.usage).toEqual({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
  });

  it("leaves usage unset when the stream has no usage field", () => {
    const acc = emptyAssembly();
    applyChatChunk(acc, { choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] });
    expect(acc.usage).toBeUndefined();
  });
});

describe("readSseChatCompletion", () => {
  it("emits prose deltas and not a second copy at the end", async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const deltas: string[] = [];
    const acc = await readSseChatCompletion(
      new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
      (text) => deltas.push(text),
    );
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(acc.content).toBe("Hello");
  });

  it("does not emit deltas for tool JSON content", async () => {
    const json = '{"name":"read_file","arguments":{"path":"a.ts"}}';
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: json }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    const deltas: string[] = [];
    const acc = await readSseChatCompletion(
      new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
      (text) => deltas.push(text),
    );
    expect(deltas).toEqual([]);
    expect(streamMode(acc)).toBe("tool");
    expect(acc.content).toBe(json);
  });

  it("does not emit deltas for SEARCH/REPLACE fence content", async () => {
    const fence = "public/audio.js\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE";
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: fence }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    const deltas: string[] = [];
    const acc = await readSseChatCompletion(
      new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
      (text) => deltas.push(text),
    );
    expect(deltas).toEqual([]);
    expect(streamMode(acc)).toBe("tool");
    expect(acc.content).toBe(fence);
  });

  it("does not emit after abort", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(s) {
        s.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"{"}}]}\n\n'));
        controller.abort();
        s.close();
      },
    });
    await expect(
      readSseChatCompletion(
        new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
        () => undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects with AbortError when aborted while a read is pending", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start() {
        /* leave the stream open so reader.read() waits */
      },
    });
    const pending = readSseChatCompletion(
      new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
      () => undefined,
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("applies only payloads before [DONE]", async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"A"}}]}',
      "",
      "data: [DONE]",
      "",
      'data: {"choices":[{"delta":{"content":"B"},"finish_reason":"stop"}]}',
      "",
    ].join("\n");
    const deltas: string[] = [];
    const acc = await readSseChatCompletion(
      new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
      (text) => deltas.push(text),
    );
    expect(deltas).toEqual(["A"]);
    expect(acc.content).toBe("A");
  });
});
