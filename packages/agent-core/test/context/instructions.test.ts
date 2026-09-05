import { describe, expect, it } from "vitest";
import {
  INSTRUCTIONS_CHAR_LIMIT,
  formatInstructions,
  loadWorkspaceInstructions,
} from "../../src/context/instructions.js";
import type { WorkspacePort } from "../../src/workspace/port.js";

function fakePort(files: Record<string, string>): WorkspacePort {
  return {
    hasWorkspace: () => true,
    readFile: async (path) => {
      const body = files[path];
      if (body === undefined) {
        throw new Error(`ENOENT ${path}`);
      }
      return body;
    },
    listDir: async () => [],
    search: async () => [],
    findFiles: async () => [],
    documentSymbols: async () => [],
    references: async () => [],
    hover: async () => "",
    exists: async (path) => (files[path] === undefined ? "absent" : "file"),
    getContext: async () => ({ activeFile: null, selection: null }),
    diagnostics: async () => [],
  };
}

describe("loadWorkspaceInstructions", () => {
  it("returns null when the workspace has no instruction file", async () => {
    expect(await loadWorkspaceInstructions(fakePort({}))).toBeNull();
  });

  it("loads AGENTS.md and names it in the header", async () => {
    const out = await loadWorkspaceInstructions(fakePort({ "AGENTS.md": "Use pnpm." }));
    expect(out).toContain("AGENTS.md");
    expect(out).toContain("Use pnpm.");
  });

  it("prefers AGENTS.md over CLAUDE.md", async () => {
    const out = await loadWorkspaceInstructions(
      fakePort({ "AGENTS.md": "from agents", "CLAUDE.md": "from claude" }),
    );
    expect(out).toContain("from agents");
    expect(out).not.toContain("from claude");
  });

  it("falls back to CLAUDE.md", async () => {
    const out = await loadWorkspaceInstructions(fakePort({ "CLAUDE.md": "from claude" }));
    expect(out).toContain("CLAUDE.md");
    expect(out).toContain("from claude");
  });

  it("skips a file that is only whitespace", async () => {
    expect(await loadWorkspaceInstructions(fakePort({ "AGENTS.md": "   \n\n" }))).toBeNull();
  });

  it("survives an unreadable instruction file", async () => {
    const port: WorkspacePort = {
      ...fakePort({}),
      exists: async () => "file",
      readFile: async () => {
        throw new Error("EACCES");
      },
    };
    expect(await loadWorkspaceInstructions(port)).toBeNull();
  });
});

describe("formatInstructions", () => {
  it("keeps a normal file whole", () => {
    const out = formatInstructions("AGENTS.md", "line one\nline two");
    expect(out).toContain("line one\nline two");
    expect(out).not.toContain("truncated");
  });

  it("truncates past the limit and says so", () => {
    // Instructions sit ahead of the first user message and are never trimmed,
    // so an oversized file would permanently starve a 16k context.
    const long = "x".repeat(INSTRUCTIONS_CHAR_LIMIT + 500);
    const out = formatInstructions("AGENTS.md", long);
    expect(out).toContain(`[truncated: AGENTS.md is longer than ${INSTRUCTIONS_CHAR_LIMIT}`);
    expect(out.length).toBeLessThan(long.length + 400);
  });
});
