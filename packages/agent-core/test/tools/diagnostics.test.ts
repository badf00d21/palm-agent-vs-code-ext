import { describe, expect, it } from "vitest";
import { formatDiagnostics, invokeDiagnostics } from "../../src/tools/diagnostics.js";
import type { Diagnostic, WorkspacePort } from "../../src/workspace/port.js";

function fakePort(overrides: Partial<WorkspacePort> = {}): WorkspacePort {
  return {
    hasWorkspace: () => true,
    readFile: async () => "",
    listDir: async () => [],
    search: async () => [],
    findFiles: async () => [],
    documentSymbols: async () => [],
    references: async () => [],
    hover: async () => "",
    exists: async () => "absent" as const,
    getContext: async () => ({ activeFile: null, selection: null }),
    diagnostics: async () => [],
    ...overrides,
  };
}

const err = (path: string, line: number, message: string): Diagnostic => ({
  path,
  line,
  severity: "error",
  message,
});
const warn = (path: string, line: number, message: string): Diagnostic => ({
  path,
  line,
  severity: "warning",
  message,
});

describe("formatDiagnostics", () => {
  it("says clean-or-unchecked, not just empty, when there are no rows", () => {
    const out = formatDiagnostics([]);
    expect(out).toContain("No errors or warnings reported in the workspace");
    expect(out).toContain("Do not treat this as confirmation the code is correct");
  });

  it("names the file when scoped to one", () => {
    const out = formatDiagnostics([], "src/a.ts");
    expect(out).toContain("for src/a.ts");
  });

  it("emits path:line: rows so tool-locations can pick them up", () => {
    const out = formatDiagnostics([err("src/a.ts", 12, "Cannot find name 'foo'.")]);
    expect(out).toBe("src/a.ts:12: error: Cannot find name 'foo'.");
  });

  it("includes source and code when present", () => {
    const out = formatDiagnostics([
      { path: "src/a.ts", line: 5, severity: "error", message: "unused var", source: "eslint", code: "no-unused-vars" },
    ]);
    expect(out).toBe("src/a.ts:5: error: [eslint] unused var (no-unused-vars)");
  });

  it("caps at 40 rows and appends a count of the rest", () => {
    const many = Array.from({ length: 45 }, (_, i) => err("a.ts", i + 1, "boom"));
    const out = formatDiagnostics(many);
    const lines = out.split("\n");
    expect(lines).toHaveLength(41);
    expect(lines.at(-1)).toBe("[5 more]");
  });

  it("does not append a truncation marker on an exactly full page", () => {
    const exact = Array.from({ length: 40 }, (_, i) => err("a.ts", i + 1, "boom"));
    expect(formatDiagnostics(exact)).not.toContain("more]");
  });
});

describe("invokeDiagnostics", () => {
  it("returns the ambiguous-empty message for a clean workspace", async () => {
    const invoke = (args: Record<string, unknown>) => invokeDiagnostics(args, fakePort());
    const out = await invoke({});
    expect(out).toContain("No errors or warnings reported in the workspace");
  });

  it("lists errors and warnings together by default", async () => {
    const port = fakePort({
      diagnostics: async () => [err("a.ts", 1, "bad"), warn("a.ts", 2, "meh")],
    });
    const out = await invokeDiagnostics({}, port);
    expect(out).toBe(["a.ts:1: error: bad", "a.ts:2: warning: meh"].join("\n"));
  });

  it("filters to errors only when asked", async () => {
    const port = fakePort({
      diagnostics: async () => [err("a.ts", 1, "bad"), warn("a.ts", 2, "meh")],
    });
    const out = await invokeDiagnostics({ severity: "error" }, port);
    expect(out).toBe("a.ts:1: error: bad");
  });

  it("truncates a long list from the port", async () => {
    const port = fakePort({
      diagnostics: async () => Array.from({ length: 50 }, (_, i) => err("a.ts", i + 1, "bad")),
    });
    const out = await invokeDiagnostics({}, port);
    expect(out).toContain("[10 more]");
  });

  it("resolves a unique filename and scopes the port call to it", async () => {
    const asked: Array<string | undefined> = [];
    const port = fakePort({
      readFile: async (path) => {
        if (path === "src/abc-import.ts") {
          return "export const x = 1;\n";
        }
        throw new Error(`ENOENT ${path}`);
      },
      findFiles: async (name) => (name === "abc-import.ts" ? ["src/abc-import.ts"] : []),
      diagnostics: async (path) => {
        asked.push(path);
        return [];
      },
    });
    const out = await invokeDiagnostics({ path: "abc-import.ts" }, port);
    expect(asked).toEqual(["src/abc-import.ts"]);
    expect(out).toContain("for src/abc-import.ts");
  });

  it("reports a file that does not exist as an error", async () => {
    const port = fakePort({
      readFile: async () => {
        throw new Error("ENOENT nope.ts");
      },
    });
    const out = await invokeDiagnostics({ path: "nope.ts" }, port);
    expect(out).toMatch(/^Error: /);
  });
});
