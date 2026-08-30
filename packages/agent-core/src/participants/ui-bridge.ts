import {
  BaseParticipant,
  FunctionCallItem,
  ModelMessageItem,
  SemanticEvent,
  type Participant,
} from "@mozaik-ai/core";
import type { ExtToWebview } from "@palm-agent/shared";
import { NARRATION_EVENT } from "../model/local-inference.js";

export function eventsFromFunctionCall(
  name: string,
  args: unknown,
  id = "call_unknown",
): ExtToWebview {
  return { type: "tool_call", name, args, id, status: "running" };
}

export function eventFromModelText(text: string): ExtToWebview | null {
  if (!text) {
    return null;
  }
  return { type: "assistant_delta", text };
}

export function eventFromNarration(item: SemanticEvent<unknown>): ExtToWebview | null {
  if (item.getType() !== NARRATION_EVENT) {
    return null;
  }
  const data = item.data as { text?: unknown } | null | undefined;
  const text = typeof data?.text === "string" ? data.text : "";
  if (!text) {
    return null;
  }
  return { type: "assistant_delta", text };
}

function parseFunctionCallArgs(raw: string): unknown {
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export class UIBridge extends BaseParticipant {
  constructor(private readonly sink: () => (event: ExtToWebview) => void) {
    super();
  }

  override onExternalFunctionCall(_source: Participant, item: FunctionCallItem): void {
    const name = item.name ?? "tool";
    const args = parseFunctionCallArgs(item.args);
    this.sink()(eventsFromFunctionCall(name, args));
  }

  override onExternalModelMessage(_source: Participant, item: ModelMessageItem): void {
    const text = item.content?.text ?? "";
    const event = eventFromModelText(text);
    if (event) {
      this.sink()(event);
    }
  }

  override onExternalEvent(_source: Participant, item: SemanticEvent<unknown>): void {
    const event = eventFromNarration(item);
    if (event) {
      this.sink()(event);
    }
  }
}
