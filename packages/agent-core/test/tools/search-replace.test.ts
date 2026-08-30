import { describe, expect, it } from "vitest";
import { applySearchReplace } from "../../src/tools/search-replace.js";

describe("applySearchReplace", () => {
  it("replaces one exact match", () => {
    const result = applySearchReplace("const getUser = 1;\n", "getUser", "fetchUser");
    expect(result).toEqual({ ok: true, text: "const fetchUser = 1;\n" });
  });

  it("matches a trimEnd window when exact fails", () => {
    const content = "function foo() {\n  return 1;\n}\n";
    const search = "function foo() {\n  return 1;\n}\n";
    const result = applySearchReplace(content, search.trimEnd() + "   \n", "function foo() {\n  return 2;\n}\n");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain("return 2");
    }
  });

  it("matches a trim window when indent differs", () => {
    const content = "    const x = 1;\n";
    const search = "  const x = 1; ";
    const result = applySearchReplace(content, search, "const x = 2;");
    expect(result).toEqual({ ok: true, text: "const x = 2;\n" });
  });

  it("rejects two exact matches", () => {
    const result = applySearchReplace("getUser getUser", "getUser", "fetchUser");
    expect(result).toEqual({ ok: false, reason: "ambiguous" });
  });

  it("returns not_found when nothing matches", () => {
    const result = applySearchReplace("hello\n", "getUser", "fetchUser");
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("matches a unique window when the file uses CR-only breaks", () => {
    const content = "KEEP\rone\rtwo\rAFTER\r";
    const result = applySearchReplace(content, "one\ntwo\n", "ONE\nTWO\n");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain("ONE");
      expect(result.text).toContain("KEEP");
      expect(result.text).toContain("AFTER");
    }
  });

  it("splices a CRLF trim window without doubling CR", () => {
    const prefix = "KEEP_PREFIX // unchanged\r\n";
    const suffix = "KEEP_SUFFIX // unchanged\r\n";
    const content = `${prefix}    const x = 1;\r\n${suffix}`;
    const result = applySearchReplace(content, "  const x = 1; ", "const x = 2;\r\n");
    expect(result).toEqual({
      ok: true,
      text: `${prefix}const x = 2;\r\n${suffix}`,
    });
    if (result.ok) {
      expect(result.text.includes("\r\r\n")).toBe(false);
      expect(result.text.slice(0, prefix.length)).toBe(prefix);
      expect(result.text.slice(-suffix.length)).toBe(suffix);
    }
  });
});
