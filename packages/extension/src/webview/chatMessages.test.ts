import { describe, expect, it } from "vitest";
import {
  applyCloudSession,
  applyExtMessage,
  dockedReviews,
  reviewDockSummary,
  shouldClearBusy,
  transcriptLines,
  type ChatLine,
} from "./chatMessages";

describe("reviewDockSummary", () => {
  it("formats one pending review and one file", () => {
    expect(
      reviewDockSummary([
        {
          role: "review",
          id: "r1",
          files: [{ path: "a.ts", kind: "edit" }],
          status: "pending",
        },
      ]),
    ).toEqual({ reviewCount: 1, fileCount: 1, label: "1 review · 1 file" });
  });

  it("sums files across pending reviews and ignores settled", () => {
    expect(
      reviewDockSummary([
        {
          role: "review",
          id: "r1",
          files: [
            { path: "a.ts", kind: "edit" },
            { path: "b.ts", kind: "create" },
          ],
          status: "pending",
        },
        {
          role: "review",
          id: "r2",
          files: [
            { path: "c.ts", kind: "edit" },
            { path: "d.ts", kind: "edit" },
            { path: "e.ts", kind: "mkdir" },
          ],
          status: "pending",
        },
        {
          role: "review",
          id: "old",
          files: [{ path: "z.ts", kind: "edit" }],
          status: "kept",
        },
      ]),
    ).toEqual({ reviewCount: 2, fileCount: 5, label: "2 reviews · 5 files" });
  });

  it("returns empty label when there are no pending reviews", () => {
    expect(reviewDockSummary([])).toEqual({
      reviewCount: 0,
      fileCount: 0,
      label: "",
    });
    expect(
      reviewDockSummary([
        {
          role: "review",
          id: "old",
          files: [{ path: "z.ts", kind: "edit" }],
          status: "kept",
        },
      ]),
    ).toEqual({ reviewCount: 0, fileCount: 0, label: "" });
  });
});

describe("dockedReviews", () => {
  it("docks pending reviews above settled ones and keeps them out of the transcript", () => {
    const messages: ChatLine[] = [
      { role: "user", text: "ok" },
      { role: "review", id: "old", files: [{ path: "a.ts", kind: "edit" }], status: "kept" },
      { role: "review", id: "live", files: [{ path: "b.ts", kind: "edit" }], status: "pending" },
    ];
    expect(dockedReviews(messages).map((review) => review.id)).toEqual(["live", "old"]);
    expect(transcriptLines(messages)).toEqual([{ role: "user", text: "ok" }]);
  });
});

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

  it("attaches reported locations when a tool finishes", () => {
    const running = applyExtMessage([], {
      type: "tool_call",
      name: "references",
      args: { symbol: "display_tasks" },
      id: "call_1",
      status: "running",
    });
    const done = applyExtMessage(running, {
      type: "tool_call",
      name: "",
      args: {},
      id: "call_1",
      status: "done",
      locations: [{ path: "src/view.rs", line: 3, text: "pub fn display_tasks() {}" }],
    });
    expect(done[0]).toMatchObject({
      role: "tool",
      status: "done",
      locations: [{ path: "src/view.rs", line: 3, text: "pub fn display_tasks() {}" }],
    });
  });

  it("finishes a tool that reported no locations without adding the field", () => {
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
    expect(done[0]).toMatchObject({ role: "tool", status: "done" });
    expect((done[0] as { locations?: unknown }).locations).toBeUndefined();
  });

  it("renders problems after apply as a status line with clickable rows", () => {
    const next = applyExtMessage([], {
      type: "problems",
      summary: "2 errors in the file you kept",
      locations: [
        { path: "src/view.rs", line: 12, text: "error: [rust-analyzer] expected &str" },
      ],
    });
    expect(next[0]).toEqual({
      role: "status",
      text: "2 errors in the file you kept",
      locations: [{ path: "src/view.rs", line: 12, text: "error: [rust-analyzer] expected &str" }],
    });
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

  it("ignores cloud_session in the transcript reducer", () => {
    const prev: ChatLine[] = [{ role: "user", text: "x" }];
    expect(applyExtMessage(prev, { type: "cloud_session", url: "https://cloud.example/s/1" })).toBe(
      prev,
    );
  });

  describe("applyCloudSession", () => {
    it("stays null with no cloud session configured", () => {
      expect(applyCloudSession(null, { type: "context_trimmed" })).toBeNull();
    });

    it("adopts the url from a cloud_session event", () => {
      expect(applyCloudSession(null, { type: "cloud_session", url: "https://cloud.example/s/1" })).toBe(
        "https://cloud.example/s/1",
      );
    });

    it("replaces a previous url with a new one", () => {
      const withFirst = applyCloudSession(null, {
        type: "cloud_session",
        url: "https://cloud.example/s/1",
      });
      expect(applyCloudSession(withFirst, { type: "cloud_session", url: "https://cloud.example/s/2" })).toBe(
        "https://cloud.example/s/2",
      );
    });

    it("clears a stale url on session_cleared so New Chat never shows the old session", () => {
      const withUrl = applyCloudSession(null, {
        type: "cloud_session",
        url: "https://cloud.example/s/1",
      });
      expect(applyCloudSession(withUrl, { type: "session_cleared" })).toBeNull();
    });

    it("leaves the url untouched for unrelated events", () => {
      const withUrl = applyCloudSession(null, {
        type: "cloud_session",
        url: "https://cloud.example/s/1",
      });
      expect(applyCloudSession(withUrl, { type: "done" })).toBe("https://cloud.example/s/1");
    });
  });

  describe("research", () => {
    const workers = [
      { id: "w1", question: "What does X do?", status: "pending" as const, steps: 0 },
      { id: "w2", question: "What does Y do?", status: "pending" as const, steps: 0 },
    ];

    it("starts a research line with all workers pending", () => {
      const next = applyExtMessage([], {
        type: "research_started",
        id: "r1",
        question: "How does the system work?",
        workers,
      });
      expect(next).toEqual([
        {
          role: "research",
          id: "r1",
          question: "How does the system work?",
          workers,
          status: "running",
        },
      ]);
    });

    it("replaces the matching worker by id and leaves others untouched", () => {
      const started = applyExtMessage([], {
        type: "research_started",
        id: "r1",
        question: "q",
        workers,
      });
      const updated = applyExtMessage(started, {
        type: "research_worker",
        id: "r1",
        worker: { id: "w1", question: "What does X do?", status: "running", activity: "read a.ts", steps: 1 },
      });
      const line = updated[0];
      expect(line?.role).toBe("research");
      if (line?.role !== "research") {
        throw new Error("expected research line");
      }
      expect(line.workers).toEqual([
        { id: "w1", question: "What does X do?", status: "running", activity: "read a.ts", steps: 1 },
        { id: "w2", question: "What does Y do?", status: "pending", steps: 0 },
      ]);
    });

    it("ignores a research_worker update for an unknown worker id without duplicating", () => {
      const started = applyExtMessage([], {
        type: "research_started",
        id: "r1",
        question: "q",
        workers,
      });
      const updated = applyExtMessage(started, {
        type: "research_worker",
        id: "r1",
        worker: { id: "unknown", question: "ghost", status: "running", steps: 0 },
      });
      expect(updated).toEqual(started);
    });

    it("ignores a research_worker update when the research id doesn't match", () => {
      const started = applyExtMessage([], {
        type: "research_started",
        id: "r1",
        question: "q",
        workers,
      });
      const updated = applyExtMessage(started, {
        type: "research_worker",
        id: "other",
        worker: { id: "w1", question: "What does X do?", status: "running", steps: 1 },
      });
      expect(updated).toEqual(started);
    });

    it("marks a done settle terminal and resolves lingering running/pending workers to done", () => {
      let lines = applyExtMessage([], {
        type: "research_started",
        id: "r1",
        question: "q",
        workers,
      });
      lines = applyExtMessage(lines, {
        type: "research_worker",
        id: "r1",
        worker: { id: "w1", question: "What does X do?", status: "running", steps: 2 },
      });
      lines = applyExtMessage(lines, {
        type: "research_settled",
        id: "r1",
        status: "done",
        digest: "the digest",
      });
      const line = lines[0];
      if (line?.role !== "research") {
        throw new Error("expected research line");
      }
      expect(line.status).toBe("done");
      expect(line.digest).toBe("the digest");
      expect(line.workers.every((worker) => worker.status !== "running" && worker.status !== "pending")).toBe(
        true,
      );
    });

    it("resolves lingering workers to failed with an error on a failed settle", () => {
      let lines = applyExtMessage([], {
        type: "research_started",
        id: "r1",
        question: "q",
        workers,
      });
      lines = applyExtMessage(lines, {
        type: "research_settled",
        id: "r1",
        status: "failed",
        message: "runtime crashed",
      });
      const line = lines[0];
      if (line?.role !== "research") {
        throw new Error("expected research line");
      }
      expect(line.status).toBe("failed");
      expect(line.message).toBe("runtime crashed");
      for (const worker of line.workers) {
        expect(worker.status).toBe("failed");
        expect(worker.error).toBe("runtime crashed");
      }
    });

    it("marks lingering workers cancelled-failed without clobbering a worker's own error", () => {
      let lines = applyExtMessage([], {
        type: "research_started",
        id: "r1",
        question: "q",
        workers,
      });
      lines = applyExtMessage(lines, {
        type: "research_worker",
        id: "r1",
        worker: { id: "w1", question: "What does X do?", status: "failed", error: "timed out", steps: 3 },
      });
      lines = applyExtMessage(lines, { type: "research_settled", id: "r1", status: "cancelled" });
      const line = lines[0];
      if (line?.role !== "research") {
        throw new Error("expected research line");
      }
      expect(line.status).toBe("cancelled");
      const w1 = line.workers.find((worker) => worker.id === "w1");
      const w2 = line.workers.find((worker) => worker.id === "w2");
      expect(w1?.error).toBe("timed out");
      expect(w2?.status).toBe("failed");
      expect(w2?.error).toBe("Cancelled");
    });

    it("does not touch other research lines or unrelated chat lines when settling", () => {
      let lines = applyExtMessage([{ role: "user", text: "hi" }], {
        type: "research_started",
        id: "r1",
        question: "q1",
        workers,
      });
      lines = applyExtMessage(lines, {
        type: "research_started",
        id: "r2",
        question: "q2",
        workers,
      });
      lines = applyExtMessage(lines, { type: "research_settled", id: "r1", status: "done" });
      expect(lines[0]).toEqual({ role: "user", text: "hi" });
      const r1 = lines.find((line) => line.role === "research" && line.id === "r1");
      const r2 = lines.find((line) => line.role === "research" && line.id === "r2");
      expect(r1?.role === "research" ? r1.status : undefined).toBe("done");
      expect(r2?.role === "research" ? r2.status : undefined).toBe("running");
    });

    it("does not clear busy on research events, letting the run's own rows show progress", () => {
      expect(
        shouldClearBusy({ type: "research_started", id: "r1", question: "q", workers }),
      ).toBe(false);
      expect(
        shouldClearBusy({
          type: "research_worker",
          id: "r1",
          worker: { id: "w1", question: "q", status: "running", steps: 1 },
        }),
      ).toBe(false);
      expect(shouldClearBusy({ type: "research_settled", id: "r1", status: "done" })).toBe(false);
      expect(shouldClearBusy({ type: "research_settled", id: "r1", status: "failed" })).toBe(false);
      expect(shouldClearBusy({ type: "research_settled", id: "r1", status: "cancelled" })).toBe(
        false,
      );
    });

    it("interleaves cleanly with an assistant delta after settling", () => {
      let lines = applyExtMessage([], {
        type: "research_started",
        id: "r1",
        question: "q",
        workers,
      });
      lines = applyExtMessage(lines, { type: "research_settled", id: "r1", status: "done" });
      lines = applyExtMessage(lines, { type: "assistant_delta", text: "Here's what I found" });
      expect(lines).toHaveLength(2);
      expect(lines[1]).toEqual({ role: "assistant", text: "Here's what I found" });
    });
  });
});
