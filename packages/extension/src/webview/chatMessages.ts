import type { ExtToWebview } from "@palm-agent/shared";

export interface ChatLine {
  role: "user" | "assistant" | "tool";
  text: string;
}

export function formatToolArgs(args: unknown): string {
  if (args && typeof args === "object" && "path" in args) {
    return String((args as { path: unknown }).path);
  }
  if (args && typeof args === "object" && "query" in args) {
    return String((args as { query: unknown }).query);
  }
  try {
    return JSON.stringify(args);
  } catch {
    return "";
  }
}

export function applyExtMessage(messages: ChatLine[], msg: ExtToWebview): ChatLine[] {
  if (msg.type === "assistant_delta") {
    return [...messages, { role: "assistant", text: msg.text }];
  }
  if (msg.type === "tool_call") {
    const detail = formatToolArgs(msg.args);
    return [...messages, { role: "tool", text: detail ? `${msg.name}  ${detail}` : msg.name }];
  }
  if (msg.type === "error") {
    return [...messages, { role: "assistant", text: `Error: ${msg.message}` }];
  }
  return messages;
}
