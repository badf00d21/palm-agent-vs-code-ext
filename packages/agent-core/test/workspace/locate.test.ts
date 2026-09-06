import { describe, expect, it } from "vitest";
import {
  locateWorkspaceFile,
  resolveWorkspaceFilePath,
} from "../../src/workspace/locate.js";
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
    diagnostics: async () => [],
    ...overrides,
  };
}

describe("resolveWorkspaceFilePath", () => {
  it("keeps a path that already points at a file", async () => {
    const p = port({ exists: async () => "file" });
    expect(await resolveWorkspaceFilePath(p, "src/Blog.jsx")).toEqual({ path: "src/Blog.jsx" });
  });

  it("resolves a bare filename the model cited in prose", async () => {
    // The model writes "Blog.jsx:42" as often as a full path; joining that onto
    // the workspace root points at a file that is not there.
    const p = port({
      exists: async () => "absent",
      findFiles: async (name) => (name === "Blog.jsx" ? ["src/pages/Blog.jsx"] : []),
    });
    expect(await resolveWorkspaceFilePath(p, "Blog.jsx")).toEqual({ path: "src/pages/Blog.jsx" });
  });

  it("resolves a bare name even when it came with a wrong directory", async () => {
    const p = port({
      exists: async () => "absent",
      findFiles: async (name) => (name === "Blog.jsx" ? ["src/pages/Blog.jsx"] : []),
    });
    expect(await resolveWorkspaceFilePath(p, "components/Blog.jsx")).toEqual({
      path: "src/pages/Blog.jsx",
    });
  });

  it("names the candidates instead of opening the wrong file", async () => {
    const p = port({
      exists: async () => "absent",
      findFiles: async () => ["a/index.js", "b/index.js"],
    });
    const out = await resolveWorkspaceFilePath(p, "index.js");
    expect(out).toEqual({ error: "Ambiguous file index.js: a/index.js, b/index.js" });
  });

  it("says the file is not in the workspace when nothing matches", async () => {
    const p = port({ exists: async () => "absent", findFiles: async () => [] });
    expect(await resolveWorkspaceFilePath(p, "Nope.jsx")).toEqual({
      error: "No file named Nope.jsx in this workspace",
    });
  });

  it("rejects an empty path", async () => {
    expect(await resolveWorkspaceFilePath(port(), "  ")).toEqual({ error: "Path is empty" });
  });

  it("normalises backslashes and a leading ./", async () => {
    const seen: string[] = [];
    const p = port({
      exists: async (path) => {
        seen.push(path);
        return "file";
      },
    });
    await resolveWorkspaceFilePath(p, ".\\src\\Blog.jsx");
    expect(seen).toEqual(["src/Blog.jsx"]);
  });
});

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
