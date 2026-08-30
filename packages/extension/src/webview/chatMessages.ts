import type { ExtToWebview } from "@palm-agent/shared";

export interface TextLine {
  role: "user" | "assistant";
  text: string;
}

export interface ToolLine {
  role: "tool";
  text: string;
  id: string;
  status: "running" | "done";
}

export interface ReviewLine {
  role: "review";
  id: string;
  files: string[];
  status: "pending" | "kept" | "undone";
}

export type ChatLine = TextLine | ToolLine | ReviewLine;

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

export function isReviewStoreError(message: string): boolean {
  return (
    message === "No pending review" ||
    message === "File is not in the review" ||
    message.startsWith("File changed since proposal:")
  );
}

export function shouldClearBusy(msg: ExtToWebview): boolean {
  if (msg.type === "done") {
    return true;
  }
  if (msg.type === "error") {
    return !isReviewStoreError(msg.message);
  }
  return false;
}

export function applyExtMessage(messages: ChatLine[], msg: ExtToWebview): ChatLine[] {
  if (msg.type === "assistant_delta") {
    const last = messages[messages.length - 1];
    if (last && last.role === "assistant") {
      return [...messages.slice(0, -1), { role: "assistant", text: last.text + msg.text }];
    }
    return [...messages, { role: "assistant", text: msg.text }];
  }
  if (msg.type === "tool_call") {
    const existing = messages.findIndex((line) => line.role === "tool" && line.id === msg.id);
    if (existing >= 0 && msg.status === "done") {
      return messages.map((line, index) =>
        index === existing && line.role === "tool" ? { ...line, status: "done" } : line,
      );
    }
    if (msg.status === "done") {
      return messages;
    }
    const detail = formatToolArgs(msg.args);
    const text = detail ? `${msg.name}  ${detail}` : msg.name;
    return [...messages, { role: "tool", text, id: msg.id, status: msg.status }];
  }
  if (msg.type === "error") {
    return [...messages, { role: "assistant", text: `Error: ${msg.message}` }];
  }
  if (msg.type === "diff_proposed") {
    const files = msg.files.map((file) => file.path);
    const exists = messages.some((line) => line.role === "review" && line.id === msg.id);
    if (exists) {
      return messages.map((line) =>
        line.role === "review" && line.id === msg.id
          ? { ...line, files, status: "pending" as const }
          : line,
      );
    }
    return [...messages, { role: "review", id: msg.id, files, status: "pending" }];
  }
  if (msg.type === "diff_settled") {
    return messages.map((line) =>
      line.role === "review" && line.id === msg.id ? { ...line, status: msg.status } : line,
    );
  }
  return messages;
}
