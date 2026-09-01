import { describe, expect, it } from "vitest";
import {
  TOOL_LOCATION_LIMIT,
  extractToolLocations,
} from "../../src/participants/tool-locations.js";

describe("extractToolLocations", () => {
  it("reads the rows references emits", () => {
    const output = [
      "src/view.rs:3: pub fn display_tasks() {}",
      "src/controller.rs:18: self.view.display_tasks(&tasks);",
    ].join("\n");
    expect(extractToolLocations(output)).toEqual([
      { path: "src/view.rs", line: 3, text: "pub fn display_tasks() {}" },
      { path: "src/controller.rs", line: 18, text: "self.view.display_tasks(&tasks);" },
    ]);
  });

  it("keeps a row whose text is empty", () => {
    expect(extractToolLocations("a.ts:7:")).toEqual([{ path: "a.ts", line: 7, text: "" }]);
  });

  it("ignores lines that are not result rows", () => {
    const output = ["No matches", "[truncated to 50 hits]", "some prose here"].join("\n");
    expect(extractToolLocations(output)).toEqual([]);
  });

  it("ignores a row with a line number of zero", () => {
    expect(extractToolLocations("a.ts:0: nope")).toEqual([]);
  });

  it("does not treat an error message as a location", () => {
    expect(extractToolLocations("Error: old_string not found in a.ts")).toEqual([]);
  });

  it("keeps the colon-bearing tail of a source line intact", () => {
    expect(extractToolLocations("a.rs:12: let map: HashMap<String, u32> = x;")).toEqual([
      { path: "a.rs", line: 12, text: "let map: HashMap<String, u32> = x;" },
    ]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: TOOL_LOCATION_LIMIT + 10 }, (_, i) => `a.ts:${i + 1}: x`).join(
      "\n",
    );
    expect(extractToolLocations(many)).toHaveLength(TOOL_LOCATION_LIMIT);
  });

  it("clips a very long source line", () => {
    const [hit] = extractToolLocations(`a.ts:1: ${"x".repeat(500)}`);
    expect(hit?.text.length).toBe(200);
  });

  it("returns nothing for empty output", () => {
    expect(extractToolLocations("")).toEqual([]);
  });
});
