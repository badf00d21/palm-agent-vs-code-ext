import { FunctionCallItem, FunctionCallOutputItem } from "@mozaik-ai/core";
import { BaseParticipant, createSemanticEvent } from "../../src/runtime/environment.js";
import { describe, expect, it } from "vitest";
import type { ExtToWebview } from "@palm-agent/shared";
import { CONTEXT_TRIMMED_EVENT } from "../../src/context/compact.js";
import { CONTEXT_USAGE_EVENT, NARRATION_EVENT } from "../../src/model/local-inference.js";
import {
  UIBridge,
  eventFromContextTrimmed,
  eventFromContextUsage,
  eventFromModelText,
  eventFromNarration,
  eventsFromFunctionCall,
  eventsFromFunctionCallOutput,
} from "../../src/participants/ui-bridge.js";

describe("UIBridge mappers", () => {
  it("maps a function call as running", () => {
    expect(eventsFromFunctionCall("read_file", { path: "a.ts" }, "call_1")).toEqual({
      type: "tool_call",
      name: "read_file",
      args: { path: "a.ts" },
      id: "call_1",
      status: "running",
    } satisfies ExtToWebview);
  });

  it("maps function output as done", () => {
    expect(eventsFromFunctionCallOutput("call_1")).toEqual({
      type: "tool_call",
      name: "",
      args: {},
      id: "call_1",
      status: "done",
    } satisfies ExtToWebview);
  });

  it("does not map model text to the sink", () => {
    expect(eventFromModelText("hello")).toBeNull();
  });

  it("skips empty model text", () => {
    expect(eventFromModelText("")).toBeNull();
  });

  it("maps a narration event to assistant_delta", () => {
    expect(
      eventFromNarration(createSemanticEvent(NARRATION_EVENT, { text: "Reading the file first." })),
    ).toEqual({ type: "assistant_delta", text: "Reading the file first." });
  });

  it("ignores other semantic events and empty narration", () => {
    expect(eventFromNarration(createSemanticEvent("other", { text: "x" }))).toBeNull();
    expect(eventFromNarration(createSemanticEvent(NARRATION_EVENT, { text: "" }))).toBeNull();
    expect(eventFromNarration(createSemanticEvent(NARRATION_EVENT, {}))).toBeNull();
  });

  it("maps a context_usage event", () => {
    expect(eventFromContextUsage(createSemanticEvent(CONTEXT_USAGE_EVENT, { used: 4200 }))).toEqual({
      type: "context_usage",
      used: 4200,
      max: null,
    });
  });

  it("ignores context_usage without a finite used", () => {
    expect(eventFromContextUsage(createSemanticEvent(CONTEXT_USAGE_EVENT, {}))).toBeNull();
  });

  it("maps a context_trimmed event", () => {
    expect(eventFromContextTrimmed(createSemanticEvent(CONTEXT_TRIMMED_EVENT, {}))).toEqual({
      type: "context_trimmed",
    });
  });

  it("ignores other events in eventFromContextTrimmed", () => {
    expect(eventFromContextTrimmed(createSemanticEvent("other", {}))).toBeNull();
  });
});

describe("UIBridge narration forwarding", () => {
  it("forwards narration through onExternalEvent to the sink", () => {
    const events: ExtToWebview[] = [];
    const bridge = new UIBridge(() => (event) => events.push(event));

    bridge.onExternalEvent(
      new BaseParticipant(),
      createSemanticEvent(NARRATION_EVENT, { text: "Reading the file first." }),
    );
    bridge.onExternalEvent(new BaseParticipant(), createSemanticEvent("unrelated", { text: "no" }));

    expect(events).toEqual([{ type: "assistant_delta", text: "Reading the file first." }]);
  });

  it("forwards context_usage through onExternalEvent to the sink", () => {
    const events: ExtToWebview[] = [];
    const bridge = new UIBridge(() => (event) => events.push(event));
    bridge.onExternalEvent(new BaseParticipant(), createSemanticEvent(CONTEXT_USAGE_EVENT, { used: 12 }));
    expect(events).toEqual([{ type: "context_usage", used: 12, max: null }]);
  });

  it("forwards context_trimmed through onExternalEvent to the sink", () => {
    const events: ExtToWebview[] = [];
    const bridge = new UIBridge(() => (event) => events.push(event));
    bridge.onExternalEvent(new BaseParticipant(), createSemanticEvent(CONTEXT_TRIMMED_EVENT, {}));
    expect(events).toEqual([{ type: "context_trimmed" }]);
  });
});

describe("UIBridge tool lifecycle", () => {
  it("emits running then done for a function call and its output", () => {
    const events: ExtToWebview[] = [];
    const bridge = new UIBridge(() => (event) => events.push(event));
    const source = new BaseParticipant();

    bridge.onExternalFunctionCall(
      source,
      FunctionCallItem.rehydrate({
        callId: "call_1",
        name: "read_file",
        args: '{"path":"a.ts"}',
      }),
    );
    bridge.onExternalFunctionCallOutput(source, FunctionCallOutputItem.create("call_1", "ok"));

    expect(events).toEqual([
      {
        type: "tool_call",
        name: "read_file",
        args: { path: "a.ts" },
        id: "call_1",
        status: "running",
      },
      {
        type: "tool_call",
        name: "",
        args: {},
        id: "call_1",
        status: "done",
      },
    ]);
  });
});
