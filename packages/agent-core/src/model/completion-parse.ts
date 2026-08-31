import { parse as parseJsonc } from "jsonc-parser";

export interface ChatToolCall {
  id?: string;
  function?: { name?: string; arguments?: unknown };
}

function asToolCallObject(value: unknown): ChatToolCall | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const rec = value as Record<string, unknown>;
  const nested =
    rec.function && typeof rec.function === "object"
      ? (rec.function as Record<string, unknown>)
      : undefined;
  const name =
    (typeof nested?.name === "string" && nested.name) ||
    (typeof rec.name === "string" && rec.name) ||
    (typeof rec.function === "string" && rec.function) ||
    (typeof rec.tool === "string" && rec.tool) ||
    "";
  const args = nested?.arguments ?? rec.arguments ?? rec.args ?? rec.parameters;
  const hasArgs =
    nested !== undefined
      ? "arguments" in nested || "args" in nested
      : "arguments" in rec || "args" in rec || "parameters" in rec;
  if (!name || !hasArgs) {
    return null;
  }
  return { id: typeof rec.id === "string" ? rec.id : undefined, function: { name, arguments: args } };
}

function jsonValuesFrom(text: string): unknown[] {
  const values: unknown[] = [];
  const consider = (slice: string) => {
    const value = parseJsonc(slice);
    if (value !== undefined) {
      values.push(value);
    }
  };
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    consider(trimmed);
  }
  for (const fence of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    consider((fence[1] ?? "").trim());
  }
  const keyRe = /"(?:name|function|tool)"\s*:/g;
  let match: RegExpExecArray | null;
  let attempts = 0;
  while ((match = keyRe.exec(text)) !== null && attempts < 16) {
    const fromBrace = text.lastIndexOf("{", match.index);
    const fromBracket = text.lastIndexOf("[", match.index);
    const start = Math.max(fromBrace, fromBracket);
    if (start >= 0) {
      consider(text.slice(start));
      attempts += 1;
    }
  }
  return values;
}

function toolCallsFromValue(parsed: unknown): ChatToolCall[] {
  if (Array.isArray(parsed)) {
    return parsed.map(asToolCallObject).filter((call): call is ChatToolCall => call !== null);
  }
  const one = asToolCallObject(parsed);
  return one ? [one] : [];
}

/** Qwen/Ollama often emit a tool call as JSON in `message.content` instead of `tool_calls`. */
export function parseToolCallsFromContent(text: string): ChatToolCall[] {
  if (!text.trim()) {
    return [];
  }
  for (const parsed of jsonValuesFrom(text)) {
    const calls = toolCallsFromValue(parsed);
    if (calls.length > 0) {
      return calls;
    }
  }
  return [];
}
