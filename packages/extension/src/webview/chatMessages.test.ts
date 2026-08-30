import { describe, expect, it } from "vitest";
import { applyExtMessage, shouldClearBusy, type ChatLine } from "./chatMessages";

describe("applyExtMessage", () => {
  it("appends assistant text", () => {
    const next = applyExtMessage([], { type: "assistant_delta", text: "hi" });
    expect(next).toEqual([{ role: "assistant", text: "hi" }]);
  });

  it("appends consecutive assistant deltas onto one line", () => {
    const first = applyExtMessage([], { type: "assistant_delta", text: "Hel" });
    const next = applyExtMessage(first, { type: "assistant_delta", text: "lo" });
    expect(next).toEqual([{ role: "assistant", text: "Hello" }]);
  });

  it("starts a new assistant line after a tool line", () => {
    const withTool = applyExtMessage([], {
      type: "tool_call",
      name: "read_file",
      args: { path: "a.ts" },
      id: "c1",
      status: "running",
    });
    const next = applyExtMessage(withTool, { type: "assistant_delta", text: "done" });
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual({ role: "assistant", text: "done" });
  });

  it("appends a tool line without throwing", () => {
    const next = applyExtMessage([], {
      type: "tool_call",
      name: "read_file",
      args: { path: "src/echo.ts" },
      id: "c1",
      status: "running",
    });
    expect(next[0]).toEqual({
      role: "tool",
      text: "read_file  src/echo.ts",
      id: "c1",
      status: "running",
    });
  });

  it("leaves messages unchanged when tool_call done has no matching id", () => {
    const prev: ChatLine[] = [{ role: "user", text: "x" }];
    const next = applyExtMessage(prev, {
      type: "tool_call",
      name: "",
      args: {},
      id: "missing",
      status: "done",
    });
    expect(next).toBe(prev);
  });

  it("updates a tool line from running to done by id", () => {
    const running = applyExtMessage([], {
      type: "tool_call",
      name: "read_file",
      args: { path: "a.ts" },
      id: "call_1",
      status: "running",
    });
    const done = applyExtMessage(running, {
      type: "tool_call",
      name: "",
      args: {},
      id: "call_1",
      status: "done",
    });
    expect(done).toHaveLength(1);
    expect(done[0]).toEqual({
      role: "tool",
      text: "read_file  a.ts",
      id: "call_1",
      status: "done",
    });
  });

  it("formats error lines", () => {
    const next = applyExtMessage([], { type: "error", message: "Agent is busy" });
    const line = next[0];
    expect(line && line.role !== "review" ? line.text : undefined).toBe("Error: Agent is busy");
  });

  it("ignores done", () => {
    const prev: ChatLine[] = [{ role: "user", text: "x" }];
    expect(applyExtMessage(prev, { type: "done" })).toBe(prev);
  });

  it("ignores context_usage", () => {
    const prev: ChatLine[] = [{ role: "user", text: "x" }];
    expect(applyExtMessage(prev, { type: "context_usage", used: 10, max: 100 })).toBe(prev);
  });

  it("creates and updates a review line by id", () => {
    const first = applyExtMessage([], {
      type: "diff_proposed",
      id: "rev_1",
      files: [{ path: "a.ts", kind: "edit" }],
    });
    expect(first).toEqual([
      { role: "review", id: "rev_1", files: [{ path: "a.ts", kind: "edit" }], status: "pending" },
    ]);
    const second = applyExtMessage(first, {
      type: "diff_proposed",
      id: "rev_1",
      files: [
        { path: "a.ts", kind: "edit" },
        { path: "b.ts", kind: "edit" },
      ],
    });
    expect(second).toHaveLength(1);
    expect(second[0]).toEqual({
      role: "review",
      id: "rev_1",
      files: [
        { path: "a.ts", kind: "edit" },
        { path: "b.ts", kind: "edit" },
      ],
      status: "pending",
    });
  });

  it("does not clear busy on review-store errors", () => {
    expect(shouldClearBusy({ type: "done" })).toBe(true);
    expect(shouldClearBusy({ type: "error", message: "Agent is busy" })).toBe(true);
    expect(shouldClearBusy({ type: "error", message: "No pending review" })).toBe(false);
    expect(shouldClearBusy({ type: "error", message: "File is not in the review" })).toBe(false);
    expect(shouldClearBusy({ type: "error", message: "File changed since proposal: a.ts" })).toBe(
      false,
    );
    expect(shouldClearBusy({ type: "error", message: "Directory has no diff" })).toBe(false);
    expect(shouldClearBusy({ type: "assistant_delta", text: "hi" })).toBe(false);
  });

  it("keeps create and mkdir kinds on the review line", () => {
    const next = applyExtMessage([], {
      type: "diff_proposed",
      id: "rev_1",
      files: [
        { path: "n.ts", kind: "create" },
        { path: "d/", kind: "mkdir" },
      ],
    });
    expect(next).toEqual([
      {
        role: "review",
        id: "rev_1",
        files: [
          { path: "n.ts", kind: "create" },
          { path: "d/", kind: "mkdir" },
        ],
        status: "pending",
      },
    ]);
  });

  it("settles a review as kept", () => {
    const pending = applyExtMessage([], {
      type: "diff_proposed",
      id: "rev_1",
      files: [{ path: "a.ts", kind: "edit" }],
    });
    const next = applyExtMessage(pending, { type: "diff_settled", id: "rev_1", status: "kept" });
    expect(next[0]).toMatchObject({ role: "review", status: "kept" });
  });
});
