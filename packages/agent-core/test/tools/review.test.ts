import { describe, expect, it } from "vitest";
import { mergePending, type ProposedFile } from "../../src/tools/review.js";

const a = (proposed: string): ProposedFile => ({
  path: "a.ts",
  original: "old-a",
  proposed,
  kind: "edit",
});

const b: ProposedFile = { path: "b.ts", original: "old-b", proposed: "new-b", kind: "edit" };

describe("mergePending", () => {
  it("creates an id and one path on an empty store", () => {
    const next = mergePending(undefined, [a("new-a")], () => "rev_1");
    expect(next.id).toBe("rev_1");
    expect(next.files.map((f) => f.path)).toEqual(["a.ts"]);
    expect(next.files[0]?.proposed).toBe("new-a");
  });

  it("replaces the same path and keeps length 1", () => {
    const first = mergePending(undefined, [a("one")], () => "rev_1");
    const next = mergePending(first, [a("two")], () => "rev_unused");
    expect(next.id).toBe("rev_1");
    expect(next.files).toHaveLength(1);
    expect(next.files[0]?.proposed).toBe("two");
  });

  it("appends a new path after the old one", () => {
    const first = mergePending(undefined, [a("one")], () => "rev_1");
    const next = mergePending(first, [b], () => "rev_unused");
    expect(next.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
  });
});
