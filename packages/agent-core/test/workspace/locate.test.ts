import { describe, expect, it } from "vitest";
import { locateWorkspaceFile } from "../../src/workspace/locate.js";
import type { WorkspacePort } from "../../src/workspace/port.js";

function port(overrides: Partial<WorkspacePort> = {}): WorkspacePort {
  return {
    hasWorkspace: () => true,
    readFile: async () => {
      throw new Error("ENOENT");
    },
    listDir: async () => [],
    search: async () => [],
    findFiles: async () => [],
    documentSymbols: async () => [],
    references: async () => [],
    hover: async () => "",
    exists: async () => "absent" as const,
    getContext: async () => ({ activeFile: null, selection: null }),
    ...overrides,
  };
}

describe("locateWorkspaceFile", () => {
  it("reads a direct relative path", async () => {
    const found = await locateWorkspaceFile(
      port({ readFile: async (path) => `from ${path}` }),
      "src\\abc-import.ts",
    );
    expect(found).toEqual({ path: "src/abc-import.ts", text: "from src/abc-import.ts" });
  });

  it("resolves a unique basename", async () => {
    const found = await locateWorkspaceFile(
      port({
        readFile: async (path) => {
          if (path === "src/abc-import.ts") {
            return "ok";
          }
          throw new Error(`ENOENT ${path}`);
        },
        findFiles: async () => ["src/abc-import.ts"],
      }),
      "abc-import.ts",
    );
    expect(found).toEqual({ path: "src/abc-import.ts", text: "ok" });
  });

  it("reports ambiguous basenames", async () => {
    const found = await locateWorkspaceFile(
      port({
        findFiles: async () => ["a/foo.ts", "b/foo.ts"],
      }),
      "foo.ts",
    );
    expect(found).toEqual({ error: "Ambiguous file foo.ts: a/foo.ts, b/foo.ts" });
  });
});
