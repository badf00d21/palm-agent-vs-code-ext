import { describe, expect, it } from "vitest";
import { applyExtMessage, type ChatLine } from "./chatMessages";

describe("applyExtMessage", () => {
  it("appends assistant text", () => {
    const next = applyExtMessage([], { type: "assistant_delta", text: "hi" });
    expect(next).toEqual([{ role: "assistant", text: "hi" }]);
  });

  it("appends a tool line without throwing", () => {
    const next = applyExtMessage([], {
      type: "tool_call",
      name: "read_file",
      args: { path: "src/echo.ts" },
    });
    expect(next[0]).toEqual({ role: "tool", text: "read_file  src/echo.ts" });
  });

  it("formats error lines", () => {
    const next = applyExtMessage([], { type: "error", message: "Agent is busy" });
    expect(next[0]?.text).toBe("Error: Agent is busy");
  });

  it("ignores done", () => {
    const prev: ChatLine[] = [{ role: "user", text: "x" }];
    expect(applyExtMessage(prev, { type: "done" })).toBe(prev);
  });
});
