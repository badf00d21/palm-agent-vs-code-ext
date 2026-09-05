import { FunctionCallItem, FunctionCallOutputItem, type Participant } from "@mozaik-ai/core";
import { BaseParticipant, type BusEvent } from "../runtime/environment.js";
import type { ExtToWebview } from "@palm-agent/shared";
import { CONTEXT_TRIMMED_EVENT } from "../context/compact.js";
import { CONTEXT_USAGE_EVENT, NARRATION_EVENT } from "../model/local-inference.js";
import { extractToolLocations } from "./tool-locations.js";

export function eventsFromFunctionCall(
  name: string,
  args: unknown,
  id: string,
): ExtToWebview {
  return { type: "tool_call", name, args, id, status: "running" };
}

export function eventsFromFunctionCallOutput(id: string, output = ""): ExtToWebview {
  const locations = extractToolLocations(output);
  return {
    type: "tool_call",
    name: "",
    args: {},
    id,
    status: "done",
    ...(locations.length > 0 ? { locations } : {}),
  };
}

export function eventFromModelText(_text: string): ExtToWebview | null {
  return null;
}

export function eventFromNarration(item: BusEvent): ExtToWebview | null {
  if (item.type !== NARRATION_EVENT) {
    return null;
  }
  const data = item.payload as { text?: unknown } | null | undefined;
  const text = typeof data?.text === "string" ? data.text : "";
  if (!text) {
    return null;
  }
  return { type: "assistant_delta", text };
}

export function eventFromContextUsage(item: BusEvent): ExtToWebview | null {
  if (item.type !== CONTEXT_USAGE_EVENT) {
    return null;
  }
  const used = (item.payload as { used?: unknown } | null | undefined)?.used;
  if (typeof used !== "number" || !Number.isFinite(used)) {
    return null;
  }
  return { type: "context_usage", used, max: null };
}

export function eventFromContextTrimmed(item: BusEvent): ExtToWebview | null {
  if (item.type !== CONTEXT_TRIMMED_EVENT) {
    return null;
  }
  return { type: "context_trimmed" };
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
    super("UI Bridge");
  }

  override onExternalFunctionCall(_source: Participant, item: FunctionCallItem): void {
    const name = item.name ?? "tool";
    const args = parseFunctionCallArgs(item.args);
    this.sink()(eventsFromFunctionCall(name, args, item.callId));
  }

  override onExternalFunctionCallOutput(_source: Participant, item: FunctionCallOutputItem): void {
    this.sink()(eventsFromFunctionCallOutput(item.callId, item.output.text));
  }

  override onExternalModelMessage(): void {
    return;
  }

  override onExternalEvent(_source: Participant, item: BusEvent): void {
    const event =
      eventFromContextUsage(item) ?? eventFromNarration(item) ?? eventFromContextTrimmed(item);
    if (event) {
      this.sink()(event);
    }
  }
}
