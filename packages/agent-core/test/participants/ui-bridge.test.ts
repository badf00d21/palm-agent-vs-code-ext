import { BaseParticipant, SemanticEvent } from "@mozaik-ai/core";
import { describe, expect, it } from "vitest";
import type { ExtToWebview } from "@palm-agent/shared";
import { NARRATION_EVENT } from "../../src/model/local-inference.js";
import {
  UIBridge,
  eventFromModelText,
  eventFromNarration,
  eventsFromFunctionCall,
} from "../../src/participants/ui-bridge.js";

describe("UIBridge mappers", () => {
  it("maps a function call", () => {
    expect(eventsFromFunctionCall("read_file", { path: "a.ts" })).toEqual({
      type: "tool_call",
      name: "read_file",
      args: { path: "a.ts" },
    } satisfies ExtToWebview);
  });

  it("maps model text", () => {
    expect(eventFromModelText("hello")).toEqual({
      type: "assistant_delta",
      text: "hello",
    });
  });

  it("skips empty model text", () => {
    expect(eventFromModelText("")).toBeNull();
  });

  it("maps a narration event to assistant_delta", () => {
    expect(
      eventFromNarration(new SemanticEvent(NARRATION_EVENT, { text: "Reading the file first." })),
    ).toEqual({ type: "assistant_delta", text: "Reading the file first." });
  });

  it("ignores other semantic events and empty narration", () => {
    expect(eventFromNarration(new SemanticEvent("other", { text: "x" }))).toBeNull();
    expect(eventFromNarration(new SemanticEvent(NARRATION_EVENT, { text: "" }))).toBeNull();
    expect(eventFromNarration(new SemanticEvent(NARRATION_EVENT, {}))).toBeNull();
  });
});

describe("UIBridge narration forwarding", () => {
  it("forwards narration through onExternalEvent to the sink", () => {
    const events: ExtToWebview[] = [];
    const bridge = new UIBridge(() => (event) => events.push(event));

    bridge.onExternalEvent(
      new BaseParticipant(),
      new SemanticEvent(NARRATION_EVENT, { text: "Reading the file first." }),
    );
    bridge.onExternalEvent(new BaseParticipant(), new SemanticEvent("unrelated", { text: "no" }));

    expect(events).toEqual([{ type: "assistant_delta", text: "Reading the file first." }]);
  });
});
