import { describe, expect, it } from "vitest";
import { assertCanStartTurn } from "./session-guards.js";

const ok = { busy: false, hasWorkspace: true, model: "deepseek-v4-pro" };

describe("assertCanStartTurn", () => {
  it("rejects empty text", () => {
    expect(assertCanStartTurn("   ", ok)).toEqual({
      type: "error",
      message: "Empty message",
    });
  });

  it("rejects a second turn while busy", () => {
    expect(assertCanStartTurn("hi", { ...ok, busy: true })).toEqual({
      type: "error",
      message: "Agent is busy",
    });
  });

  it("rejects a missing workspace", () => {
    expect(assertCanStartTurn("hi", { ...ok, hasWorkspace: false })).toEqual({
      type: "error",
      message: "No workspace folder open",
    });
  });

  it("rejects a Responses-API model name", () => {
    expect(assertCanStartTurn("hi", { ...ok, model: "gpt-4" })).toEqual({
      type: "error",
      message:
        "Model name routes to the wrong API. Use a local Ollama name such as deepseek-v4-pro.",
    });
  });

  it("allows a valid turn", () => {
    expect(assertCanStartTurn("hi", ok)).toBeNull();
  });
});
