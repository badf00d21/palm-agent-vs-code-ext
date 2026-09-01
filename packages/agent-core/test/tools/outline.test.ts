import { describe, expect, it } from "vitest";
import { OUTLINE_LIMIT, formatSymbols, outlineByIndent } from "../../src/tools/outline.js";
import type { WorkspaceSymbol } from "../../src/workspace/port.js";

describe("formatSymbols", () => {
  it("renders line, kind and name, nesting by depth", () => {
    const symbols: WorkspaceSymbol[] = [
      { name: "Task", kind: "struct", line: 12, depth: 0 },
      { name: "new", kind: "method", line: 21, depth: 1 },
    ];
    expect(formatSymbols(symbols)).toBe("12: struct Task\n21:   method new");
  });

  it("caps the list and says how much was left out", () => {
    const symbols: WorkspaceSymbol[] = Array.from({ length: OUTLINE_LIMIT + 5 }, (_, i) => ({
      name: `sym${i}`,
      kind: "function",
      line: i + 1,
      depth: 0,
    }));
    const out = formatSymbols(symbols);
    expect(out).toContain("[5 more; read_file a range for detail]");
    expect(out.split("\n")).toHaveLength(OUTLINE_LIMIT + 1);
  });

  it("flattens a multi-line signature so one symbol stays one line", () => {
    const symbols: WorkspaceSymbol[] = [
      { name: "fn wide(\n  a: u32,\n  b: u32,\n)", kind: "function", line: 3, depth: 0 },
    ];
    expect(formatSymbols(symbols).split("\n")).toHaveLength(1);
  });
});

describe("outlineByIndent", () => {
  // The fallback must not know a single language keyword: these cases are
  // different languages on purpose, and none of them is special-cased.
  it("keeps top level and the level members sit on, in a braces language", () => {
    const rust = [
      "use std::io;",
      "",
      "pub struct Task {",
      "    pub id: u32,",
      "}",
      "",
      "impl Task {",
      "    pub fn new(id: u32) -> Self {",
      "        Self { id }",
      "    }",
      "}",
    ].join("\n");
    expect(outlineByIndent(rust)).toBe(
      [
        "1: use std::io;",
        "3: pub struct Task {",
        "4: pub id: u32,",
        "7: impl Task {",
        "8: pub fn new(id: u32) -> Self {",
      ].join("\n"),
    );
  });

  it("works the same for an indentation language", () => {
    const python = ["import os", "", "class Task:", "    def __init__(self):", "        self.id = 0"].join(
      "\n",
    );
    expect(outlineByIndent(python)).toBe(
      ["1: import os", "3: class Task:", "4: def __init__(self):"].join("\n"),
    );
  });

  it("works for a language nobody wrote support for", () => {
    const invented = ["widget Foo", "  slot bar", "    detail hidden", "widget Baz"].join("\n");
    expect(outlineByIndent(invented)).toBe(
      ["1: widget Foo", "2: slot bar", "4: widget Baz"].join("\n"),
    );
  });

  it("drops lines that carry no word, like a lone closing brace", () => {
    const out = outlineByIndent(["fn a() {", "}", "fn b() {", "}"].join("\n"));
    expect(out).toBe("1: fn a() {\n3: fn b() {");
  });

  it("returns empty for a file with nothing but blanks and punctuation", () => {
    expect(outlineByIndent("\n\n   \n}\n")).toBe("");
  });

  it("handles a file with a single indentation level", () => {
    expect(outlineByIndent("alpha\nbeta\n")).toBe("1: alpha\n2: beta");
  });

  it("caps long output the same way symbols do", () => {
    const many = Array.from({ length: OUTLINE_LIMIT + 3 }, (_, i) => `line${i}`).join("\n");
    expect(outlineByIndent(many)).toContain("[3 more; read_file a range for detail]");
  });
});
