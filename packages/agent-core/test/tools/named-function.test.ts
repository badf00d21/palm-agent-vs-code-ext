import { describe, expect, it } from "vitest";
import { exactFunctionInFile, functionNameFromSearch } from "../../src/tools/named-function.js";

describe("functionNameFromSearch", () => {
  it("reads the name from a whole-function search", () => {
    expect(functionNameFromSearch("function collectVoices(body: string) {\n  return [];\n}")).toBe(
      "collectVoices",
    );
  });

  it("ignores a short identifier", () => {
    expect(functionNameFromSearch("collectVoices")).toBeUndefined();
  });
});

describe("exactFunctionInFile", () => {
  it("returns one unique function including template braces", () => {
    const file = [
      "const keep = 1;",
      "function collectVoices() {",
      "  slot.music += `${line} `;",
      "  return [];",
      "}",
      "const after = 2;",
      "",
    ].join("\n");
    expect(exactFunctionInFile(file, "collectVoices")).toBe(
      "function collectVoices() {\n  slot.music += `${line} `;\n  return [];\n}",
    );
  });

  it("returns undefined when the name appears twice", () => {
    const file = "function foo() { return 1; }\nfunction foo() { return 2; }\n";
    expect(exactFunctionInFile(file, "foo")).toBeUndefined();
  });
});
