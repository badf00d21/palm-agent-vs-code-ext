import { describe, expect, it } from "vitest";
import { createReviewStore } from "./reviewStore";

describe("createReviewStore", () => {
  it("emits diff_proposed on merge", () => {
    const events: unknown[] = [];
    const store = createReviewStore({
      emit: (e) => events.push(e),
      readFile: async () => "a",
      applyFiles: async () => undefined,
      createId: () => "rev_1",
    });
    store.merge([{ path: "a.ts", original: "a", proposed: "b" }]);
    expect(events).toEqual([{ type: "diff_proposed", id: "rev_1", files: [{ path: "a.ts" }] }]);
  });

  it("does not write when disk is stale", async () => {
    let wrote = false;
    const store = createReviewStore({
      emit: () => undefined,
      readFile: async () => "changed",
      applyFiles: async () => {
        wrote = true;
      },
      createId: () => "rev_1",
    });
    store.merge([{ path: "a.ts", original: "a", proposed: "b" }]);
    const result = await store.apply("rev_1");
    expect(result).toEqual({ type: "error", message: "File changed since proposal: a.ts" });
    expect(wrote).toBe(false);
    expect(store.lookup("rev_1", "a.ts")).toEqual({ path: "a.ts", proposed: "b" });
  });

  it("clears pending on reject", () => {
    const events: unknown[] = [];
    const store = createReviewStore({
      emit: (e) => events.push(e),
      readFile: async () => "a",
      applyFiles: async () => undefined,
      createId: () => "rev_1",
    });
    store.merge([{ path: "a.ts", original: "a", proposed: "b" }]);
    expect(store.reject("rev_1")).toEqual({ type: "diff_settled", id: "rev_1", status: "undone" });
    expect(store.lookup("rev_1")).toEqual({ error: "No pending review" });
  });

  it("returns No pending review for a wrong id", async () => {
    const store = createReviewStore({
      emit: () => undefined,
      readFile: async () => "a",
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
      applyFiles: async () => undefined,
      createId: () => "rev_1",
    });
    store.onDidChangeProposed((path) => changed.push(path));
    store.merge([{ path: "a.ts", original: "a", proposed: "b" }]);
    expect(changed).toEqual(["a.ts"]);
    expect(await store.apply("rev_1")).toEqual({ type: "diff_settled", id: "rev_1", status: "kept" });
    expect(changed).toEqual(["a.ts", "a.ts"]);

    changed.length = 0;
    store.merge([
      { path: "a.ts", original: "a", proposed: "b" },
      { path: "b.ts", original: "c", proposed: "d" },
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
      applyFiles: async () => {
        wrote = true;
      },
      readOpenText: async () => ({ text: "edited", dirty: true }),
      createId: () => "rev_1",
    });
    store.merge([{ path: "a.ts", original: "a", proposed: "b" }]);
    const result = await store.apply("rev_1");
    expect(result).toEqual({ type: "error", message: "File changed since proposal: a.ts" });
    expect(wrote).toBe(false);
    expect(store.lookup("rev_1", "a.ts")).toEqual({ path: "a.ts", proposed: "b" });
  });

  it("applies when a dirty open buffer still matches the snapshot", async () => {
    let wrote = false;
    const store = createReviewStore({
      emit: () => undefined,
      readFile: async () => "a",
      applyFiles: async () => {
        wrote = true;
      },
      readOpenText: async () => ({ text: "a", dirty: true }),
      createId: () => "rev_1",
    });
    store.merge([{ path: "a.ts", original: "a", proposed: "b" }]);
    expect(await store.apply("rev_1")).toEqual({ type: "diff_settled", id: "rev_1", status: "kept" });
    expect(wrote).toBe(true);
  });
});
