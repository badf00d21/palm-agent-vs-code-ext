import { describe, expect, it, vi } from "vitest";
import { createReviewStore } from "./reviewStore";

describe("createReviewStore", () => {
  it("emits diff_proposed on merge", () => {
    const events: unknown[] = [];
    const store = createReviewStore({
      emit: (e) => events.push(e),
      readFile: async () => "a",
      exists: async () => "file",
      applyFiles: async () => undefined,
      createId: () => "rev_1",
    });
    store.merge([{ path: "a.ts", original: "a", proposed: "b", kind: "edit" }]);
    expect(events).toEqual([
      { type: "diff_proposed", id: "rev_1", files: [{ path: "a.ts", kind: "edit" }] },
    ]);
  });

  it("does not write when disk is stale", async () => {
    let wrote = false;
    const store = createReviewStore({
      emit: () => undefined,
      readFile: async () => "changed",
      exists: async () => "file",
      applyFiles: async () => {
        wrote = true;
      },
      createId: () => "rev_1",
    });
    store.merge([{ path: "a.ts", original: "a", proposed: "b", kind: "edit" }]);
    const result = await store.apply("rev_1");
    expect((result as { message: string }).message).toContain("File changed since proposal: a.ts");
    expect(wrote).toBe(false);
    expect(store.lookup("rev_1", "a.ts")).toEqual({ path: "a.ts", proposed: "b", kind: "edit" });
  });

  it("reports the applied files so problems can be checked, skipping directories", async () => {
    const reported: string[][] = [];
    const store = createReviewStore({
      emit: () => undefined,
      readFile: async () => "a",
      exists: async () => "absent",
      applyFiles: async () => undefined,
      onApplied: (paths) => reported.push(paths),
      createId: () => "rev_1",
    });
    store.merge([
      { path: "a.ts", original: "", proposed: "b", kind: "create" },
      { path: "src/", original: "", proposed: "", kind: "mkdir" },
    ]);
    await store.apply("rev_1");
    expect(reported).toEqual([["a.ts"]]);
  });

  it("does not report anything when the apply was refused", async () => {
    const reported: string[][] = [];
    const store = createReviewStore({
      emit: () => undefined,
      readFile: async () => "changed",
      exists: async () => "file",
      applyFiles: async () => undefined,
      onApplied: (paths) => reported.push(paths),
      createId: () => "rev_1",
    });
    store.merge([{ path: "a.ts", original: "a", proposed: "b", kind: "edit" }]);
    await store.apply("rev_1");
    expect(reported).toEqual([]);
  });

  it("clears pending on reject", () => {
    const events: unknown[] = [];
    const store = createReviewStore({
      emit: (e) => events.push(e),
      readFile: async () => "a",
      exists: async () => "file",
      applyFiles: async () => undefined,
      createId: () => "rev_1",
    });
    store.merge([{ path: "a.ts", original: "a", proposed: "b", kind: "edit" }]);
    expect(store.reject("rev_1")).toEqual({ type: "diff_settled", id: "rev_1", status: "undone" });
    expect(store.lookup("rev_1")).toEqual({ error: "No pending review" });
  });

  it("returns No pending review for a wrong id", async () => {
    const store = createReviewStore({
      emit: () => undefined,
      readFile: async () => "a",
      exists: async () => "file",
      applyFiles: async () => undefined,
    });
    expect(await store.apply("nope")).toEqual({ type: "error", message: "No pending review" });
    expect(store.reject("nope")).toEqual({ type: "error", message: "No pending review" });
  });

  it("notifies proposed-path listeners on merge and after apply/reject", async () => {
    const changed: string[] = [];
    const store = createReviewStore({
      emit: () => undefined,
      readFile: async () => "a",
      exists: async () => "file",
      applyFiles: async () => undefined,
      createId: () => "rev_1",
    });
    store.onDidChangeProposed((path) => changed.push(path));
    store.merge([{ path: "a.ts", original: "a", proposed: "b", kind: "edit" }]);
    expect(changed).toEqual(["a.ts"]);
    expect(await store.apply("rev_1")).toEqual({ type: "diff_settled", id: "rev_1", status: "kept" });
    expect(changed).toEqual(["a.ts", "a.ts"]);

    changed.length = 0;
    store.merge([
      { path: "a.ts", original: "a", proposed: "b", kind: "edit" },
      { path: "b.ts", original: "c", proposed: "d", kind: "edit" },
    ]);
    expect(changed).toEqual(["a.ts", "b.ts"]);
    expect(store.reject("rev_1")).toEqual({ type: "diff_settled", id: "rev_1", status: "undone" });
    expect(changed).toEqual(["a.ts", "b.ts", "a.ts", "b.ts"]);
  });

  it("refuses when what the human sees changed after the proposal", async () => {
    // readFile reports the unsaved buffer when there is one, so this is both the
    // "edited in the editor" and the "changed underneath us" case.
    let wrote = false;
    const store = createReviewStore({
      emit: () => undefined,
      readFile: async () => "edited since",
      exists: async () => "file",
      applyFiles: async () => {
        wrote = true;
      },
      createId: () => "rev_1",
    });
    store.merge([{ path: "a.ts", original: "a", proposed: "b", kind: "edit" }]);
    const result = await store.apply("rev_1");
    expect(result).toMatchObject({ type: "error" });
    expect((result as { message: string }).message).toContain("File changed since proposal: a.ts");
    expect(wrote).toBe(false);
    // The review survives, so the human can retry rather than lose the proposal.
    expect(store.lookup("rev_1", "a.ts")).toEqual({ path: "a.ts", proposed: "b", kind: "edit" });
  });

  it("applies against an unsaved buffer whose text still matches the proposal", async () => {
    // Proposing against a dirty file and keeping it is the ordinary case now,
    // not a conflict: the snapshot came from the same buffer.
    let wrote = false;
    const store = createReviewStore({
      emit: () => undefined,
      readFile: async () => "unsaved text",
      exists: async () => "file",
      applyFiles: async () => {
        wrote = true;
      },
      createId: () => "rev_1",
    });
    store.merge([{ path: "a.ts", original: "unsaved text", proposed: "b", kind: "edit" }]);
    expect(await store.apply("rev_1")).toEqual({ type: "diff_settled", id: "rev_1", status: "kept" });
    expect(wrote).toBe(true);
  });

  it("tells the human what to do when the file moved on", async () => {
    const store = createReviewStore({
      emit: () => undefined,
      readFile: async () => "changed",
      exists: async () => "file",
      applyFiles: async () => undefined,
      createId: () => "rev_1",
    });
    store.merge([{ path: "a.ts", original: "a", proposed: "b", kind: "edit" }]);
    const result = await store.apply("rev_1");
    expect((result as { message: string }).message).toContain("Ask again");
  });

  it("passes create kind to applyFiles and skips readFile stale", async () => {
    const applied: unknown[] = [];
    const store = createReviewStore({
      emit: () => undefined,
      readFile: async () => {
        throw new Error("should not read a missing create target");
      },
      exists: async () => "absent",
      applyFiles: async (files) => {
        applied.push(...files);
      },
      createId: () => "rev_1",
    });
    store.merge([{ path: "n.ts", original: "", proposed: "hi\n", kind: "create" }]);
    expect(await store.apply("rev_1")).toEqual({ type: "diff_settled", id: "rev_1", status: "kept" });
    expect(applied).toEqual([{ path: "n.ts", proposed: "hi\n", kind: "create" }]);
  });

  it("does not apply create if the path appeared on disk", async () => {
    let wrote = false;
    const store = createReviewStore({
      emit: () => undefined,
      readFile: async () => {
        throw new Error("should not read a create that exists()");
      },
      exists: async () => "file",
      applyFiles: async () => {
        wrote = true;
      },
      createId: () => "rev_1",
    });
    store.merge([{ path: "n.ts", original: "", proposed: "hi\n", kind: "create" }]);
    expect(await store.apply("rev_1")).toEqual({
      type: "error",
      message: "File changed since proposal: n.ts",
    });
    expect(wrote).toBe(false);
  });

  it("passes mkdir kind to applyFiles", async () => {
    const applied: unknown[] = [];
    const store = createReviewStore({
      emit: () => undefined,
      readFile: async () => {
        throw new Error("should not read a mkdir target");
      },
      exists: async () => "absent",
      applyFiles: async (files) => {
        applied.push(...files);
      },
      createId: () => "rev_1",
    });
    store.merge([{ path: "d/", original: "", proposed: "", kind: "mkdir" }]);
    expect(await store.apply("rev_1")).toEqual({ type: "diff_settled", id: "rev_1", status: "kept" });
    expect(applied).toEqual([{ path: "d/", proposed: "", kind: "mkdir" }]);
  });

  it("lookup rejects mkdir paths", () => {
    const store = createReviewStore({
      emit: () => undefined,
      readFile: async () => "",
      exists: async () => "absent",
      applyFiles: async () => undefined,
      createId: () => "rev_1",
    });
    store.merge([{ path: "d/", original: "", proposed: "", kind: "mkdir" }]);
    expect(store.lookup("rev_1", "d/")).toEqual({ error: "Directory has no diff" });
  });

  it("lookup without path skips mkdir", () => {
    const store = createReviewStore({
      emit: () => undefined,
      readFile: async () => "",
      exists: async () => "absent",
      applyFiles: async () => undefined,
      createId: () => "rev_1",
    });
    store.merge([
      { path: "d/", original: "", proposed: "", kind: "mkdir" },
      { path: "a.ts", original: "", proposed: "x", kind: "create" },
    ]);
    expect(store.lookup("rev_1")).toEqual({ path: "a.ts", proposed: "x", kind: "create" });
  });

  it("does not call applyFiles on reject", () => {
    let wrote = false;
    const store = createReviewStore({
      emit: () => undefined,
      readFile: async () => "a",
      exists: async () => "file",
      applyFiles: async () => {
        wrote = true;
      },
      createId: () => "rev_1",
    });
    store.merge([{ path: "a.ts", original: "a", proposed: "b", kind: "edit" }]);
    store.reject("rev_1");
    expect(wrote).toBe(false);
  });

  it("clear drops pending without diff_settled", async () => {
    const events: unknown[] = [];
    const changed: string[] = [];
    const store = createReviewStore({
      emit: (e) => events.push(e),
      readFile: async () => "a",
      exists: async () => "file",
      applyFiles: async () => undefined,
      createId: () => "rev_1",
    });
    store.onDidChangeProposed((path) => changed.push(path));
    store.merge([{ path: "a.ts", original: "a", proposed: "b", kind: "edit" }]);
    events.length = 0;
    store.clear();
    expect(events).toEqual([]);
    expect(changed).toEqual(["a.ts", "a.ts"]);
    expect(await store.apply("rev_1")).toEqual({ type: "error", message: "No pending review" });
    store.clear();
    expect(await store.apply("rev_1")).toEqual({ type: "error", message: "No pending review" });
  });

  it("proposes a delete and passes it to applyFiles like any other kind", async () => {
    const applied: unknown[] = [];
    const events: unknown[] = [];
    const store = createReviewStore({
      emit: (e) => events.push(e),
      readFile: async () => "old body\n",
      exists: async () => "file",
      applyFiles: async (files) => {
        applied.push(...files);
      },
      createId: () => "rev_1",
    });
    store.merge([{ path: "old.ts", original: "old body\n", proposed: "", kind: "delete" }]);
    expect(events).toEqual([
      { type: "diff_proposed", id: "rev_1", files: [{ path: "old.ts", kind: "delete" }] },
    ]);
    expect(await store.apply("rev_1")).toEqual({ type: "diff_settled", id: "rev_1", status: "kept" });
    expect(applied).toEqual([{ path: "old.ts", proposed: "", kind: "delete" }]);
  });

  it("refuses a delete when the file changed since the proposal", async () => {
    let wrote = false;
    const store = createReviewStore({
      emit: () => undefined,
      readFile: async () => "changed underneath",
      exists: async () => "file",
      applyFiles: async () => {
        wrote = true;
      },
      createId: () => "rev_1",
    });
    store.merge([{ path: "old.ts", original: "old body\n", proposed: "", kind: "delete" }]);
    const result = await store.apply("rev_1");
    expect((result as { message: string }).message).toContain("File changed since proposal: old.ts");
    expect(wrote).toBe(false);
  });

  it("merges a delete alongside a create and an edit into one pending review", () => {
    const events: unknown[] = [];
    const store = createReviewStore({
      emit: (e) => events.push(e),
      readFile: async () => "a",
      exists: async () => "file",
      applyFiles: async () => undefined,
      createId: () => "rev_1",
    });
    store.merge([{ path: "a.ts", original: "a", proposed: "b", kind: "edit" }]);
    store.merge([{ path: "n.ts", original: "", proposed: "hi\n", kind: "create" }]);
    store.merge([{ path: "old.ts", original: "old body\n", proposed: "", kind: "delete" }]);
    const last = events[events.length - 1] as { files: unknown[] };
    expect(last.files).toEqual([
      { path: "a.ts", kind: "edit" },
      { path: "n.ts", kind: "create" },
      { path: "old.ts", kind: "delete" },
    ]);
  });

  it("returns No pending review when clear runs while applyFiles is pending", async () => {
    let releaseApply!: () => void;
    let applyStarted = false;
    const applyBlocked = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const store = createReviewStore({
      emit: () => undefined,
      readFile: async () => "a",
      exists: async () => "file",
      applyFiles: async () => {
        applyStarted = true;
        await applyBlocked;
      },
      createId: () => "rev_1",
    });
    store.merge([{ path: "a.ts", original: "a", proposed: "b", kind: "edit" }]);
    const result = store.apply("rev_1");
    await vi.waitFor(() => {
      expect(applyStarted).toBe(true);
    });
    store.clear();
    releaseApply();
    await expect(result).resolves.toEqual({ type: "error", message: "No pending review" });
  });
});
