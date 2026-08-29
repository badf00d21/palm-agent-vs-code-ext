import {
  BaseParticipant,
  FunctionCallItem,
  ModelMessageItem,
  type Participant,
} from "@mozaik-ai/core";
import type { ExtToWebview } from "@palm-agent/shared";

export function eventsFromFunctionCall(name: string, args: unknown): ExtToWebview {
  return { type: "tool_call", name, args };
}

export function eventFromModelText(text: string): ExtToWebview | null {
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
}
