import { describe, expect, it } from "vitest";
import { findSymbolPosition } from "../../src/tools/symbol-position.js";

describe("findSymbolPosition", () => {
  it("points at the first whole-word occurrence", () => {
    const src = ["use crate::model;", "", "pub fn display_tasks() {}"].join("\n");
    expect(findSymbolPosition(src, "display_tasks")).toEqual({ line: 2, character: 7 });
  });

  it("does not match a symbol embedded in a longer identifier", () => {
    const src = ["let display_tasks_count = 0;", "fn display_tasks() {}"].join("\n");
    expect(findSymbolPosition(src, "display_tasks")).toEqual({ line: 1, character: 3 });
  });

  it("treats underscores and digits as part of a word", () => {
    expect(findSymbolPosition("value2 = 1", "value")).toBeUndefined();
    expect(findSymbolPosition("my_value = 1", "value")).toBeUndefined();
  });

  it("matches identifiers in any script, not just ascii", () => {
    expect(findSymbolPosition("fn пример() {}", "пример")).toEqual({ line: 0, character: 3 });
  });

  it("prefers the given line when the name appears more than once", () => {
    const src = ["// display_tasks is documented here", "", "fn display_tasks() {}"].join("\n");
    expect(findSymbolPosition(src, "display_tasks", 3)).toEqual({ line: 2, character: 3 });
  });

  it("falls back to the first occurrence when the given line does not contain it", () => {
    const src = ["fn display_tasks() {}", "let x = 1;"].join("\n");
    expect(findSymbolPosition(src, "display_tasks", 2)).toEqual({ line: 0, character: 3 });
  });

  it("ignores an out-of-range line instead of failing", () => {
    expect(findSymbolPosition("fn a() {}", "a", 99)).toEqual({ line: 0, character: 3 });
  });

  it("returns undefined for a symbol that is not there", () => {
    expect(findSymbolPosition("fn a() {}", "missing")).toBeUndefined();
  });

  it("returns undefined for an empty symbol", () => {
    expect(findSymbolPosition("fn a() {}", "   ")).toBeUndefined();
  });

  it("handles CRLF files", () => {
    expect(findSymbolPosition("one\r\nfn target() {}\r\n", "target")).toEqual({
      line: 1,
      character: 3,
    });
  });
});
