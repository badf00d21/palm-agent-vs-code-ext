import { describe, expect, it } from "vitest";
import type { WorkspacePort } from "../../src/workspace/port.js";
import type { ReviewHost } from "../../src/tools/review.js";
import { invokeProposeEdit } from "../../src/tools/propose-edit.js";
import { createWorkspaceTools, toolsVisibleToModel } from "../../src/tools/tools.js";

function fakeHost(overrides: Partial<ReviewHost> = {}): ReviewHost {
  return {
    merge: (files) => ({ id: "rev_1", paths: files.map((f) => f.path) }),
    ...overrides,
  };
}

function getInvoke(name: string, port: WorkspacePort, host: ReviewHost = fakeHost()) {
  const tool = createWorkspaceTools(port, host).find((t) => t.name === name);
  if (!tool) {
    throw new Error(`missing ${name}`);
  }
  return tool.invoke;
}

function fakePort(overrides: Partial<WorkspacePort> = {}): WorkspacePort {
  return {
    hasWorkspace: () => true,
    readFile: async () => "",
    listDir: async () => [],
    search: async () => [],
    findFiles: async () => [],
    exists: async () => "absent" as const,
    getContext: async () => ({ activeFile: null, selection: null }),
    ...overrides,
  };
}

describe("read_file", () => {
  it("truncates after 24000 characters and points at the next start_line", async () => {
    // 400 lines of 100 chars each ("x" * 99 + \n): the cap cuts exactly after line 240.
    const line = "x".repeat(99);
    const content = Array.from({ length: 400 }, () => line).join("\n") + "\n";
    const invoke = getInvoke("read_file", fakePort({ readFile: async () => content }));
    const out = await invoke({ path: "a.ts" });
    expect(out.startsWith(content.slice(0, 24_000))).toBe(true);
    expect(out.endsWith("\n[truncated: continue with read_file start_line=241]")).toBe(true);
  });

  it("truncates mid-line and repeats the cut line in the continue hint", async () => {
    const content = "x".repeat(24_010);
    const invoke = getInvoke("read_file", fakePort({ readFile: async () => content }));
    const out = await invoke({ path: "a.ts" });
    expect(out.endsWith("\n[truncated: continue with read_file start_line=1]")).toBe(true);
  });

  it("anchors the continue hint to file lines when a range was requested", async () => {
    // Lines are 1000 chars, range starts at line 5; cap cuts after 24 whole lines → resume at 29.
    const line = "y".repeat(999);
    const content = Array.from({ length: 60 }, () => line).join("\n") + "\n";
    const invoke = getInvoke("read_file", fakePort({ readFile: async () => content }));
    const out = await invoke({ path: "a.ts", start_line: 5, end_line: 60 });
    expect(out.startsWith("[lines: 5-60 of 60]\n")).toBe(true);
    expect(out.endsWith("\n[truncated: continue with read_file start_line=29]")).toBe(true);
  });

  it("resolves a unique filename via findFiles", async () => {
    const invoke = getInvoke(
      "read_file",
      fakePort({
        readFile: async (path) => {
          if (path === "src/abc-import.ts") {
            return "export const x = 1;\n";
          }
          throw new Error(`ENOENT ${path}`);
        },
        findFiles: async (name) => (name === "abc-import.ts" ? ["src/abc-import.ts"] : []),
      }),
    );
    expect(await invoke({ path: "abc-import.ts" })).toBe(
      "[path: src/abc-import.ts]\nexport const x = 1;\n",
    );
  });

  it("returns a raw line range without line-number prefixes", async () => {
    const invoke = getInvoke(
      "read_file",
      fakePort({ readFile: async () => "one\ntwo\nthree\nfour\n" }),
    );
    expect(await invoke({ path: "a.ts", start_line: 2, end_line: 3 })).toBe(
      "[lines: 2-3 of 4]\ntwo\nthree\n",
    );
  });

  it("rejects a start_line past the end of the file", async () => {
    const invoke = getInvoke(
      "read_file",
      fakePort({ readFile: async () => "only\n" }),
    );
    expect(await invoke({ path: "a.ts", start_line: 3, end_line: 4 })).toBe(
      "Error: start_line 3 is past end of file (1 lines)",
    );
  });

  it("caps start_line without end_line to 80 lines", async () => {
    const content = Array.from({ length: 200 }, (_, i) => `L${i + 1}`).join("\n") + "\n";
    const invoke = getInvoke("read_file", fakePort({ readFile: async () => content }));
    const out = await invoke({ path: "a.ts", start_line: 10 });
    expect(out.startsWith("[lines: 10-89 of 200]\n")).toBe(true);
    expect(out).toContain("L10\n");
    expect(out).toContain("L89\n");
    expect(out).not.toContain("L90\n");
  });
});

describe("toolsVisibleToModel", () => {
  it("omits propose_edit", () => {
    const names = toolsVisibleToModel(createWorkspaceTools(fakePort(), fakeHost())).map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).not.toContain("propose_edit");
  });
});

describe("list_dir", () => {
  it("returns one level as text", async () => {
    const invoke = getInvoke(
      "list_dir",
      fakePort({
        listDir: async () => [
          { name: "a.ts", type: "file" },
          { name: "src", type: "dir" },
        ],
      }),
    );
    expect(await invoke({ path: "." })).toBe("file a.ts\ndir src");
  });
});

describe("search", () => {
  it("rejects an empty query", async () => {
    const invoke = getInvoke("search", fakePort());
    expect(await invoke({ query: "  " })).toBe("Error: Empty search query");
  });

  it("caps at 50 hits", async () => {
    const hits = Array.from({ length: 60 }, (_, i) => ({
      path: "f.ts",
      line: i + 1,
      text: "x",
    }));
    const invoke = getInvoke("search", fakePort({ search: async () => hits }));
    const out = await invoke({ query: "x" });
    expect(out).toContain("[truncated to 50 hits]");
    expect(out.split("\n").filter((l: string) => l.startsWith("f.ts:")).length).toBe(50);
  });
});

describe("get_context", () => {
  it("serializes nulls", async () => {
    const invoke = getInvoke("get_context", fakePort());
    expect(JSON.parse(await invoke({}))).toEqual({
      activeFile: null,
      selection: null,
    });
  });
});

describe("propose-edit module", () => {
  it("loads invokeProposeEdit from propose-edit", () => {
    expect(typeof invokeProposeEdit).toBe("function");
  });
});

describe("propose_edit", () => {
  it("merges two files after sequential blocks on one path", async () => {
    const merged: unknown[] = [];
    const invoke = getInvoke(
      "propose_edit",
      fakePort({
        readFile: async (path) => {
          if (path === "a.ts") {
            return "alpha\nbeta\n";
          }
          return "hello\n";
        },
      }),
      {
        merge: (files) => {
          merged.push(files);
          return { id: "rev_1", paths: files.map((f) => f.path) };
        },
      },
    );
    const out = await invoke({
      files: [
        { path: "a.ts", search: "alpha", replace: "ALPHA" },
        { path: "b.ts", search: "hello", replace: "hi" },
        { path: "a.ts", search: "beta", replace: "BETA" },
      ],
    });
    expect(out).toBe("Proposed review rev_1: a.ts, b.ts");
    expect(merged[0]).toEqual([
      { path: "a.ts", original: "alpha\nbeta\n", proposed: "ALPHA\nBETA\n", kind: "edit" },
      { path: "b.ts", original: "hello\n", proposed: "hi\n", kind: "edit" },
    ]);
  });

  it("does not merge when search is missing", async () => {
    let called = false;
    const invoke = getInvoke(
      "propose_edit",
      fakePort({ readFile: async () => "only this\n" }),
      {
        merge: () => {
          called = true;
          return { id: "rev_1", paths: [] };
        },
      },
    );
    expect(await invoke({ files: [{ path: "a.ts", search: "getUser", replace: "fetchUser" }] })).toBe(
      "Error: Search not found in a.ts",
    );
    expect(called).toBe(false);
  });

  it("rejects empty files with format guidance", async () => {
    const invoke = getInvoke("propose_edit", fakePort());
    const out = await invoke({ files: [] });
    expect(out).toContain("No SEARCH/REPLACE block found");
    expect(out).toContain("<<<<<<< SEARCH");
  });

  it("rejects a block with no path with format guidance", async () => {
    const invoke = getInvoke("propose_edit", fakePort());
    expect(await invoke({ files: [{ path: "  ", search: "a", replace: "b" }] })).toBe(
      "Error: every SEARCH/REPLACE block needs a file path on the line above it",
    );
  });

  it("rejects a regex search instead of file text", async () => {
    let called = false;
    const invoke = getInvoke(
      "propose_edit",
      fakePort({ readFile: async () => "function meterBeats(meter: string): number {\n  return 4\n}\n" }),
      {
        merge: () => {
          called = true;
          return { id: "rev_1", paths: [] };
        },
      },
    );
    const out = await invoke({
      files: [
        {
          path: "src/abc-import.ts",
          search: "function meterBeats(meter: string): number {[^}]*}",
          replace: "function meterBeats(meter: string): number { return 4 }",
        },
      ],
    });
    expect(out).toContain("search is a regex");
    expect(called).toBe(false);
  });

  it("accepts file text that contains a real regex literal", async () => {
    const source =
      "function collectVoices() {\n  const inline = line.match(/^[V:([^\\]]+)]\\s*(.*)$/i)\n  return inline\n}\n";
    const invoke = getInvoke(
      "propose_edit",
      fakePort({ readFile: async () => source }),
    );
    const out = await invoke({
      files: [{ path: "src/abc-import.ts", search: source.trimEnd(), replace: "function collectVoices() {\n  return []\n}" }],
    });
    expect(out).toBe("Proposed review rev_1: src/abc-import.ts");
  });

  it("rejects identical search and replace", async () => {
    let called = false;
    const invoke = getInvoke(
      "propose_edit",
      fakePort({ readFile: async () => "function foo() {}\n" }),
      {
        merge: () => {
          called = true;
          return { id: "rev_1", paths: [] };
        },
      },
    );
    expect(
      await invoke({
        files: [{ path: "a.ts", search: "function foo() {}", replace: "function foo() {}" }],
      }),
    ).toBe("Error: search and replace are identical");
    expect(called).toBe(false);
  });

  it("stores a posix workspace-relative path after a successful read", async () => {
    const merged: unknown[] = [];
    const invoke = getInvoke(
      "propose_edit",
      fakePort({ readFile: async () => "hello\n" }),
      {
        merge: (files) => {
          merged.push(files);
          return { id: "rev_1", paths: files.map((f) => f.path) };
        },
      },
    );
    const out = await invoke({
      files: [{ path: ".\\src\\a.ts", search: "hello", replace: "hi" }],
    });
    expect(out).toBe("Proposed review rev_1: src/a.ts");
    expect(merged[0]).toEqual([{ path: "src/a.ts", original: "hello\n", proposed: "hi\n", kind: "edit" }]);
  });

  it("returns the exact function from the file when search is a near miss", async () => {
    const file = "function collectVoices() {\n  return 1;\n}\n";
    const invoke = getInvoke(
      "propose_edit",
      fakePort({ readFile: async () => file }),
    );
    const out = await invoke({
      files: [
        {
          path: "src/abc-import.ts",
          search: "function collectVoices() {\n  return 9;\n}",
          replace: "function collectVoices() {\n  return 2;\n}",
        },
      ],
    });
    expect(out).toContain("Use this exact text as search");
    expect(out).toContain("function collectVoices() {\n  return 1;\n}");
  });

  it("proposes a create when search is empty and the path is absent", async () => {
    const merged: unknown[] = [];
    const invoke = getInvoke(
      "propose_edit",
      fakePort({ exists: async () => "absent" }),
      fakeHost({ merge: (files) => { merged.push(...files); return { id: "rev_1", paths: files.map((f) => f.path) }; } }),
    );
    const out = await invoke({
      files: [{ path: "src/foo.ts", search: "", replace: "export const foo = 1;\n" }],
    });
    expect(out).toBe("Proposed review rev_1: src/foo.ts");
    expect(merged).toEqual([
      { path: "src/foo.ts", original: "", proposed: "export const foo = 1;\n", kind: "create" },
    ]);
  });

  it("proposes mkdir for a trailing-slash empty block", async () => {
    const merged: unknown[] = [];
    const invoke = getInvoke(
      "propose_edit",
      fakePort({ exists: async () => "absent" }),
      fakeHost({ merge: (files) => { merged.push(...files); return { id: "rev_1", paths: files.map((f) => f.path) }; } }),
    );
    const out = await invoke({ files: [{ path: "src/components/", search: "", replace: "" }] });
    expect(out).toBe("Proposed review rev_1: src/components/");
    expect(merged).toEqual([
      { path: "src/components/", original: "", proposed: "", kind: "mkdir" },
    ]);
  });

  it("rejects empty search when the file already exists and steers toward an edit", async () => {
    const invoke = getInvoke("propose_edit", fakePort({ exists: async () => "file" }));
    const out = await invoke({ files: [{ path: "a.ts", search: "", replace: "x" }] });
    expect(out).toContain("Error: a.ts already exists");
    expect(out).toContain("read_file");
  });

  it("rejects mkdir when the directory already exists", async () => {
    const invoke = getInvoke("propose_edit", fakePort({ exists: async () => "dir" }));
    expect(await invoke({ files: [{ path: "src/", search: "", replace: "" }] })).toBe(
      "Error: src/ already exists",
    );
  });

  it("rejects mkdir with a replace body", async () => {
    const invoke = getInvoke("propose_edit", fakePort());
    expect(await invoke({ files: [{ path: "dir/", search: "", replace: "x" }] })).toBe(
      "Error: mkdir cannot have file content",
    );
  });
});
