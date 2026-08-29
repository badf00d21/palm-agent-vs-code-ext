import type { ExtToWebview } from "@palm-agent/shared";

export function handleUserMessage(text: string): ExtToWebview[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [{ type: "error", message: "Empty message" }];
  }
  return [{ type: "assistant_delta", text: trimmed }, { type: "done" }];
}
