import { describe, expect, it } from "vitest";
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
    expect(result).toEqual({ type: "error", message: "File changed since proposal: a.ts" });
    expect(wrote).toBe(false);
    expect(store.lookup("rev_1", "a.ts")).toEqual({ path: "a.ts", proposed: "b", kind: "edit" });
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

  it("treats a dirty open buffer that differs from the snapshot as stale", async () => {
    let wrote = false;
    const store = createReviewStore({
      emit: () => undefined,
      readFile: async () => "a",
      exists: async () => "file",
      applyFiles: async () => {
        wrote = true;
      },
      readOpenText: async () => ({ text: "edited", dirty: true }),
      createId: () => "rev_1",
    });
    store.merge([{ path: "a.ts", original: "a", proposed: "b", kind: "edit" }]);
    const result = await store.apply("rev_1");
    expect(result).toEqual({ type: "error", message: "File changed since proposal: a.ts" });
    expect(wrote).toBe(false);
    expect(store.lookup("rev_1", "a.ts")).toEqual({ path: "a.ts", proposed: "b", kind: "edit" });
  });

  it("applies when a dirty open buffer still matches the snapshot", async () => {
    let wrote = false;
    const store = createReviewStore({
      emit: () => undefined,
      readFile: async () => "a",
      exists: async () => "file",
      applyFiles: async () => {
        wrote = true;
      },
      readOpenText: async () => ({ text: "a", dirty: true }),
      createId: () => "rev_1",
    });
    store.merge([{ path: "a.ts", original: "a", proposed: "b", kind: "edit" }]);
    expect(await store.apply("rev_1")).toEqual({ type: "diff_settled", id: "rev_1", status: "kept" });
    expect(wrote).toBe(true);
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
});
