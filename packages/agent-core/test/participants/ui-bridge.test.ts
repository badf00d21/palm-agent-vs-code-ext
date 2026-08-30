import { describe, expect, it } from "vitest";
import type { ExtToWebview } from "@palm-agent/shared";
import { eventsFromFunctionCall, eventFromModelText } from "../../src/participants/ui-bridge.js";

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
});
