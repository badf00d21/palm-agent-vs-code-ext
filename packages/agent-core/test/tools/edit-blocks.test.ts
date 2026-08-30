import { describe, expect, it } from "vitest";
import { classifyEditBlock, parseSearchReplaceBlocks } from "../../src/tools/edit-blocks.js";

describe("parseSearchReplaceBlocks", () => {
  it("parses one block with a path line above SEARCH", () => {
    const text = [
      "I'll tidy drumBar.",
      "",
      "public/audio.js",
      "<<<<<<< SEARCH",
      "function drumBar(bar, time, spb) {",
      "  hitDrum(bar);",
      "}",
      "=======",
      "function drumBar(bar, time, spb) {",
      "  const hit = hitDrum(bar);",
      "}",
      ">>>>>>> REPLACE",
    ].join("\n");
    expect(parseSearchReplaceBlocks(text)).toEqual([
      {
        path: "public/audio.js",
        search: "function drumBar(bar, time, spb) {\n  hitDrum(bar);\n}",
        replace: "function drumBar(bar, time, spb) {\n  const hit = hitDrum(bar);\n}",
      },
    ]);
  });

  it("accepts a path: prefix and surrounding backticks", () => {
    const text = [
      "`src/foo.ts`",
      "<<<<<<< SEARCH",
      "a",
      "=======",
      "b",
      ">>>>>>> REPLACE",
      "",
      "path: src/bar.ts",
      "<<<<<<< SEARCH",
      "c",
      "=======",
      "d",
      ">>>>>>> REPLACE",
    ].join("\n");
    expect(parseSearchReplaceBlocks(text)).toEqual([
      { path: "src/foo.ts", search: "a", replace: "b" },
      { path: "src/bar.ts", search: "c", replace: "d" },
    ]);
  });

  it("ignores an incomplete block", () => {
    const text = ["public/audio.js", "<<<<<<< SEARCH", "old", "=======", "new"].join("\n");
    expect(parseSearchReplaceBlocks(text)).toEqual([]);
  });
});

describe("classifyEditBlock", () => {
  it("classifies a non-empty search as edit", () => {
    expect(classifyEditBlock({ path: "a.ts", search: "old", replace: "new" })).toEqual({
      ok: true,
      kind: "edit",
      path: "a.ts",
    });
  });

  it("classifies empty search with a body as create", () => {
    expect(classifyEditBlock({ path: "src/foo.ts", search: "", replace: "export const x = 1;\n" })).toEqual({
      ok: true,
      kind: "create",
      path: "src/foo.ts",
    });
  });

  it("classifies empty search and replace without a slash as create", () => {
    expect(classifyEditBlock({ path: "empty.txt", search: "", replace: "" })).toEqual({
      ok: true,
      kind: "create",
      path: "empty.txt",
    });
  });

  it("does not treat a slashless empty block as mkdir", () => {
    expect(classifyEditBlock({ path: "src/components", search: "", replace: "" })).toEqual({
      ok: true,
      kind: "create",
      path: "src/components",
    });
  });

  it("classifies empty search and replace on a trailing-slash path as mkdir", () => {
    expect(classifyEditBlock({ path: "src/components/", search: "", replace: "" })).toEqual({
      ok: true,
      kind: "mkdir",
      path: "src/components/",
    });
  });

  it("rejects a mkdir path that has a replace body", () => {
    expect(classifyEditBlock({ path: "dir/", search: "", replace: "nope" })).toEqual({
      ok: false,
      error: "mkdir cannot have file content",
    });
  });

  it("rejects a non-empty search on a directory path", () => {
    expect(classifyEditBlock({ path: "dir/", search: "x", replace: "y" })).toEqual({
      ok: false,
      error: "path is a directory",
    });
  });

  it("posix-normalizes a backslash mkdir path", () => {
    expect(classifyEditBlock({ path: "src\\components\\", search: "", replace: "" })).toEqual({
      ok: true,
      kind: "mkdir",
      path: "src/components/",
    });
  });

  it("strips a leading ./ after posix-normalizing a create path", () => {
    expect(classifyEditBlock({ path: ".\\src\\foo.ts", search: "", replace: "export const x = 1;\n" })).toEqual({
      ok: true,
      kind: "create",
      path: "src/foo.ts",
    });
  });
});
