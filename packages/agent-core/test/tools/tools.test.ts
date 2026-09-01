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
  it("omits propose_edit but exposes write and edit", () => {
    const names = toolsVisibleToModel(createWorkspaceTools(fakePort(), fakeHost())).map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("write");
    expect(names).toContain("edit");
    expect(names).not.toContain("propose_edit");
  });

  it("declares write and edit with flat args, not a nested files array", () => {
    const tools = createWorkspaceTools(fakePort(), fakeHost());
    const write = tools.find((t) => t.name === "write");
    const edit = tools.find((t) => t.name === "edit");
    expect(Object.keys(write?.parameters.properties ?? {})).toEqual(["path", "content"]);
    expect(Object.keys(edit?.parameters.properties ?? {})).toEqual([
      "path",
      "old_string",
      "new_string",
    ]);
  });
});

describe("write", () => {
  it("proposes a create when the path is absent", async () => {
    const merged: unknown[] = [];
    const invoke = getInvoke(
      "write",
      fakePort({ exists: async () => "absent" }),
      fakeHost({
        merge: (files) => {
          merged.push(...files);
          return { id: "rev_1", paths: files.map((f) => f.path) };
        },
      }),
    );
    expect(await invoke({ path: "src/model.rs", content: "pub struct Task {}\n" })).toBe(
      "Proposed review rev_1: src/model.rs",
    );
    expect(merged).toEqual([
      { path: "src/model.rs", original: "", proposed: "pub struct Task {}\n", kind: "create" },
    ]);
  });

  it("proposes an edit with the real diff when the file already exists", async () => {
    // Erroring here is what put the model in the retry loop; an overwrite must
    // reach the human as a reviewable diff instead.
    const merged: unknown[] = [];
    const invoke = getInvoke(
      "write",
      fakePort({ exists: async () => "file", readFile: async () => "old body\n" }),
      fakeHost({
        merge: (files) => {
          merged.push(...files);
          return { id: "rev_1", paths: files.map((f) => f.path) };
        },
      }),
    );
    expect(await invoke({ path: "a.ts", content: "new body\n" })).toBe(
      "Proposed review rev_1: a.ts",
    );
    expect(merged).toEqual([
      { path: "a.ts", original: "old body\n", proposed: "new body\n", kind: "edit" },
    ]);
  });

  it("rejects a write that changes nothing", async () => {
    const invoke = getInvoke(
      "write",
      fakePort({ exists: async () => "file", readFile: async () => "same\n" }),
    );
    expect(await invoke({ path: "a.ts", content: "same\n" })).toBe(
      "Error: a.ts already contains exactly this content",
    );
  });

  it("rejects writing content to a directory path", async () => {
    const invoke = getInvoke("write", fakePort());
    expect(await invoke({ path: "src/", content: "x" })).toBe(
      "Error: mkdir cannot have file content",
    );
  });

  it("rejects writing over an existing directory", async () => {
    const invoke = getInvoke("write", fakePort({ exists: async () => "dir" }));
    expect(await invoke({ path: "src", content: "x" })).toBe(
      "Error: src is a directory, not a file",
    );
  });

  it("proposes mkdir for a trailing slash with empty content", async () => {
    const merged: unknown[] = [];
    const invoke = getInvoke(
      "write",
      fakePort({ exists: async () => "absent" }),
      fakeHost({
        merge: (files) => {
          merged.push(...files);
          return { id: "rev_1", paths: files.map((f) => f.path) };
        },
      }),
    );
    expect(await invoke({ path: "src/components/", content: "" })).toBe(
      "Proposed review rev_1: src/components/",
    );
    expect(merged).toEqual([
      { path: "src/components/", original: "", proposed: "", kind: "mkdir" },
    ]);
  });

  it("requires path and content", async () => {
    const invoke = getInvoke("write", fakePort());
    expect(await invoke({ content: "x" })).toBe("Error: write requires path");
    expect(await invoke({ path: "a.ts" })).toContain("Error: write requires content");
  });

  it("creates an empty file for empty content", async () => {
    const merged: unknown[] = [];
    const invoke = getInvoke(
      "write",
      fakePort({ exists: async () => "absent" }),
      fakeHost({
        merge: (files) => {
          merged.push(...files);
          return { id: "rev_1", paths: files.map((f) => f.path) };
        },
      }),
    );
    expect(await invoke({ path: "empty.txt", content: "" })).toBe("Proposed review rev_1: empty.txt");
    expect(merged).toEqual([
      { path: "empty.txt", original: "", proposed: "", kind: "create" },
    ]);
  });
});

describe("edit", () => {
  it("replaces one literal string in an existing file", async () => {
    const merged: unknown[] = [];
    const invoke = getInvoke(
      "edit",
      fakePort({ readFile: async () => "alpha\nbeta\n" }),
      fakeHost({
        merge: (files) => {
          merged.push(...files);
          return { id: "rev_1", paths: files.map((f) => f.path) };
        },
      }),
    );
    expect(
      await invoke({ path: "a.ts", old_string: "alpha", new_string: "ALPHA" }),
    ).toBe("Proposed review rev_1: a.ts");
    expect(merged).toEqual([
      { path: "a.ts", original: "alpha\nbeta\n", proposed: "ALPHA\nbeta\n", kind: "edit" },
    ]);
  });

  it("names old_string in a not-found error, not SEARCH", async () => {
    const invoke = getInvoke("edit", fakePort({ readFile: async () => "only this\n" }));
    const out = await invoke({ path: "a.ts", old_string: "getUser", new_string: "fetchUser" });
    expect(out).toBe("Error: old_string not found in a.ts");
    expect(out).not.toContain("Search");
  });

  it("names old_string when the match is ambiguous", async () => {
    const invoke = getInvoke("edit", fakePort({ readFile: async () => "dup\ndup\n" }));
    expect(await invoke({ path: "a.ts", old_string: "dup", new_string: "x" })).toBe(
      "Error: old_string matches more than once in a.ts",
    );
  });

  it("returns the exact function text using old_string wording", async () => {
    const invoke = getInvoke(
      "edit",
      fakePort({ readFile: async () => "function collectVoices() {\n  return 1;\n}\n" }),
    );
    const out = await invoke({
      path: "a.ts",
      old_string: "function collectVoices() {\n  return 9;\n}",
      new_string: "function collectVoices() {\n  return 2;\n}",
    });
    expect(out).toContain("Use this exact text as old_string");
    expect(out).toContain("function collectVoices() {\n  return 1;\n}");
  });

  it("steers an empty old_string toward write", async () => {
    const invoke = getInvoke("edit", fakePort());
    const out = await invoke({ path: "a.ts", old_string: "", new_string: "x" });
    expect(out).toContain("Error: edit requires old_string");
    expect(out).toContain("write");
  });

  it("rejects identical old_string and new_string with tool wording", async () => {
    const invoke = getInvoke("edit", fakePort({ readFile: async () => "function foo() {}\n" }));
    expect(
      await invoke({ path: "a.ts", old_string: "function foo() {}", new_string: "function foo() {}" }),
    ).toBe("Error: old_string and new_string are identical");
  });

  it("requires path", async () => {
    const invoke = getInvoke("edit", fakePort());
    expect(await invoke({ old_string: "a", new_string: "b" })).toBe("Error: edit requires path");
  });
});

describe("write + edit across calls", () => {
  it("collects separate calls into one review instead of one batched payload", async () => {
    // The point of flat args: four small calls replace one huge files[] array,
    // and ReviewHost.merge still yields a single card.
    const seen: string[][] = [];
    const host: ReviewHost = {
      merge: (files) => {
        seen.push(files.map((f) => f.path));
        return { id: "rev_1", paths: files.map((f) => f.path) };
      },
    };
    const port = fakePort({ exists: async () => "absent" });
    const tools = createWorkspaceTools(port, host);
    const write = tools.find((t) => t.name === "write")?.invoke;
    if (!write) {
      throw new Error("missing write");
    }
    await write({ path: "model.rs", content: "a" });
    await write({ path: "view.rs", content: "b" });
    expect(seen).toEqual([["model.rs"], ["view.rs"]]);
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
