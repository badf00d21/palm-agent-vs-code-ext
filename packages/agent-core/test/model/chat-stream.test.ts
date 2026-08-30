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
});
