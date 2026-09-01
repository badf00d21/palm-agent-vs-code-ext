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
    expect(line?.role === "assistant" ? line.text : undefined).toBe("Error: Agent is busy");
  });

  it("adds an open question line", () => {
    const next = applyExtMessage([], {
      type: "question_asked",
      id: "q_1",
      question: "Which framework?",
      options: ["axum", "actix"],
    });
    expect(next[0]).toEqual({
      role: "question",
      id: "q_1",
      question: "Which framework?",
      options: ["axum", "actix"],
      answer: null,
      settled: false,
    });
  });

  it("settles the matching question with the answer", () => {
    const asked = applyExtMessage([], {
      type: "question_asked",
      id: "q_1",
      question: "Which framework?",
      options: [],
    });
    const next = applyExtMessage(asked, {
      type: "question_settled",
      id: "q_1",
      answer: "axum",
    });
    expect(next[0]).toMatchObject({ settled: true, answer: "axum" });
  });

  it("marks an unanswered question settled when the turn ends", () => {
    const asked = applyExtMessage([], {
      type: "question_asked",
      id: "q_1",
      question: "Which framework?",
      options: [],
    });
    const next = applyExtMessage(asked, { type: "question_settled", id: "q_1", answer: null });
    expect(next[0]).toMatchObject({ settled: true, answer: null });
  });

  it("leaves other questions alone when one settles", () => {
    let lines = applyExtMessage([], {
      type: "question_asked",
      id: "q_1",
      question: "First?",
      options: [],
    });
    lines = applyExtMessage(lines, {
      type: "question_asked",
      id: "q_2",
      question: "Second?",
      options: [],
    });
    lines = applyExtMessage(lines, { type: "question_settled", id: "q_2", answer: "b" });
    expect(lines[0]).toMatchObject({ id: "q_1", settled: false });
    expect(lines[1]).toMatchObject({ id: "q_2", settled: true, answer: "b" });
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

  it("appends a status line on context_trimmed", () => {
    const prev: ChatLine[] = [{ role: "user", text: "x" }];
    const next = applyExtMessage(prev, { type: "context_trimmed" });
    expect(next).toEqual([
      { role: "user", text: "x" },
      { role: "status", text: "Context trimmed to last 3 turns" },
    ]);
  });

  it("ignores session_cleared in the reducer", () => {
    const prev: ChatLine[] = [{ role: "user", text: "x" }];
    expect(applyExtMessage(prev, { type: "session_cleared" })).toBe(prev);
  });

  it("does not clear busy on context_trimmed or session_cleared", () => {
    expect(shouldClearBusy({ type: "context_trimmed" })).toBe(false);
    expect(shouldClearBusy({ type: "session_cleared" })).toBe(false);
  });
});
