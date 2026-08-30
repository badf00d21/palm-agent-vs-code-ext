import { parseToolCallsFromContent } from "./local-inference.js";

export interface StreamToolCall {
  id?: string;
  function?: { name?: string; arguments?: unknown };
}

export interface AssembledCompletion {
  content: string;
  finishReason: string | null;
  toolCalls: StreamToolCall[];
}

export function emptyAssembly(): AssembledCompletion {
  return { content: "", finishReason: null, toolCalls: [] };
}

export function iterateSseData(text: string): string[] {
  const out: string[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith("data:")) {
        continue;
      }
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") {
        continue;
      }
      out.push(data);
    }
  }
  return out;
}

export function applyChatChunk(
  acc: AssembledCompletion,
  chunk: unknown,
): { contentDelta: string } {
  if (!chunk || typeof chunk !== "object") {
    return { contentDelta: "" };
  }
  const choice = (chunk as { choices?: unknown[] }).choices?.[0];
  if (!choice || typeof choice !== "object") {
    return { contentDelta: "" };
  }
  const rec = choice as {
    finish_reason?: string | null;
    delta?: { content?: unknown; tool_calls?: unknown };
    message?: { content?: unknown; tool_calls?: unknown };
  };
  if (typeof rec.finish_reason === "string") {
    acc.finishReason = rec.finish_reason;
  }
  const delta = rec.delta ?? rec.message ?? {};
  let contentDelta = "";
  if (typeof delta.content === "string" && delta.content) {
    contentDelta = delta.content;
    acc.content += delta.content;
  }
  const calls = delta.tool_calls;
  if (Array.isArray(calls)) {
    for (const raw of calls) {
      if (!raw || typeof raw !== "object") {
        continue;
      }
      const call = raw as {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: unknown };
      };
      const index = typeof call.index === "number" ? call.index : acc.toolCalls.length;
      const current = acc.toolCalls[index] ?? { function: { name: "", arguments: "" } };
      if (call.id) {
        current.id = call.id;
      }
      current.function = current.function ?? { name: "", arguments: "" };
      if (typeof call.function?.name === "string") {
        current.function.name = `${current.function.name ?? ""}${call.function.name}`;
      }
      if (typeof call.function?.arguments === "string") {
        current.function.arguments = `${String(current.function.arguments ?? "")}${call.function.arguments}`;
      }
      acc.toolCalls[index] = current;
    }
  }
  return { contentDelta };
}

export function streamMode(acc: AssembledCompletion): "prose" | "tool" {
  if (acc.toolCalls.some((call) => call.id || call.function?.name)) {
    return "tool";
  }
  const trimmed = acc.content.trim();
  if (trimmed.startsWith("{")) {
    return "tool";
  }
  if (parseToolCallsFromContent(acc.content).length > 0) {
    return "tool";
  }
  return "prose";
}

export async function readSseChatCompletion(
  response: Response,
  onProseDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<AssembledCompletion> {
  if (signal?.aborted) {
    const error = new Error("This operation was aborted");
    error.name = "AbortError";
    throw error;
  }
  const acc = emptyAssembly();
  let mode: "prose" | "tool" | "unknown" = "unknown";
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    applySseText(acc, text, (delta) => {
      mode = promote(acc, mode, delta, onProseDelta);
    });
    if (signal?.aborted) {
      const error = new Error("This operation was aborted");
      error.name = "AbortError";
      throw error;
    }
    return acc;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => {
    void reader.cancel();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) {
        const error = new Error("This operation was aborted");
        error.name = "AbortError";
        throw error;
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        applySseText(acc, `${part}\n\n`, (delta) => {
          mode = promote(acc, mode, delta, onProseDelta);
        });
      }
    }
    if (buffer.trim()) {
      applySseText(acc, buffer, (delta) => {
        mode = promote(acc, mode, delta, onProseDelta);
      });
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  return acc;
}

function applySseText(
  acc: AssembledCompletion,
  text: string,
  onDelta: (contentDelta: string) => void,
): void {
  for (const data of iterateSseData(text)) {
    let chunk: unknown;
    try {
      chunk = JSON.parse(data) as unknown;
    } catch {
      continue;
    }
    const { contentDelta } = applyChatChunk(acc, chunk);
    onDelta(contentDelta);
  }
}

function promote(
  acc: AssembledCompletion,
  mode: "prose" | "tool" | "unknown",
  contentDelta: string,
  onProseDelta: (text: string) => void,
): "prose" | "tool" {
  const next = streamMode(acc);
  if (next === "tool") {
    return "tool";
  }
  if (contentDelta && (mode === "prose" || mode === "unknown")) {
    onProseDelta(contentDelta);
  }
  return "prose";
}
