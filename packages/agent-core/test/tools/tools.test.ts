import { describe, expect, it } from "vitest";
import type { WorkspacePort } from "../../src/workspace/port.js";
import { mergePending, type PendingReview, type ReviewHost } from "../../src/tools/review.js";
import { invokeProposeEdit } from "../../src/tools/propose-edit.js";
import { SYSTEM_PROMPT, createWorkspaceTools, toolsVisibleToModel } from "../../src/tools/tools.js";

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
    documentSymbols: async () => [],
    references: async () => [],
    hover: async () => "",
    exists: async () => "absent" as const,
    getContext: async () => ({ activeFile: null, selection: null }),
    diagnostics: async () => [],
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

describe("delete_file", () => {
  it("proposes a deletion for an existing file", async () => {
    const merged: unknown[] = [];
    const invoke = getInvoke(
      "delete_file",
      fakePort({ exists: async () => "file", readFile: async () => "old body\n" }),
      fakeHost({
        merge: (files) => {
          merged.push(...files);
          return { id: "rev_1", paths: files.map((f) => f.path) };
        },
      }),
    );
    expect(await invoke({ path: "src/old.ts" })).toBe("Proposed review rev_1: src/old.ts");
    expect(merged).toEqual([
      { path: "src/old.ts", original: "old body\n", proposed: "", kind: "delete" },
    ]);
  });

  it("errors on a missing file so the model self-corrects instead of proposing a no-op", async () => {
    const invoke = getInvoke("delete_file", fakePort({ exists: async () => "absent" }));
    const out = await invoke({ path: "src/gone.ts" });
    expect(out).toMatch(/^Error: /);
    expect(out).toMatch(/gone\.ts/);
  });

  it("errors on a directory instead of the file", async () => {
    const invoke = getInvoke("delete_file", fakePort({ exists: async () => "dir" }));
    expect(await invoke({ path: "src" })).toBe(
      "Error: src is a directory. delete_file only deletes a single file.",
    );
  });

  it("rejects a trailing-slash path as a directory without needing to check existence", async () => {
    const invoke = getInvoke("delete_file", fakePort());
    expect(await invoke({ path: "src/" })).toBe(
      "Error: delete_file only deletes a single file, not a directory",
    );
  });

  it("errors on a path outside the workspace instead of throwing", async () => {
    const invoke = getInvoke(
      "delete_file",
      fakePort({
        exists: async () => {
          throw new Error("Path is outside the workspace");
        },
      }),
    );
    await expect(invoke({ path: "../secret.txt" })).resolves.toBe(
      "Error: Path is outside the workspace",
    );
  });

  it("requires path", async () => {
    const invoke = getInvoke("delete_file", fakePort());
    expect(await invoke({})).toBe("Error: delete_file requires path");
  });

  it("resolves a unique bare filename the same way read_file does", async () => {
    const merged: unknown[] = [];
    const invoke = getInvoke(
      "delete_file",
      fakePort({
        exists: async (path) => (path === "src/old.ts" ? "file" : "absent"),
        findFiles: async (name) => (name === "old.ts" ? ["src/old.ts"] : []),
        readFile: async () => "old body\n",
      }),
      fakeHost({
        merge: (files) => {
          merged.push(...files);
          return { id: "rev_1", paths: files.map((f) => f.path) };
        },
      }),
    );
    expect(await invoke({ path: "old.ts" })).toBe("Proposed review rev_1: src/old.ts");
    expect(merged).toEqual([
      { path: "src/old.ts", original: "old body\n", proposed: "", kind: "delete" },
    ]);
  });

  it("merges into a pending review alongside other proposed changes", async () => {
    let pending: PendingReview | undefined;
    const host: ReviewHost = {
      merge: (files) => {
        pending = mergePending(pending, files, () => "rev_1");
        return { id: pending.id, paths: pending.files.map((f) => f.path) };
      },
    };
    const port = fakePort({
      exists: async (path) => (path === "old.ts" ? "file" : "absent"),
      readFile: async () => "old body\n",
    });
    const tools = createWorkspaceTools(port, host);
    const write = tools.find((t) => t.name === "write")?.invoke;
    const del = tools.find((t) => t.name === "delete_file")?.invoke;
    if (!write || !del) {
      throw new Error("missing tools");
    }
    await write({ path: "new.ts", content: "hello" });
    await del({ path: "old.ts" });
    expect(pending?.files).toEqual([
      { path: "new.ts", original: "", proposed: "hello", kind: "create" },
      { path: "old.ts", original: "old body\n", proposed: "", kind: "delete" },
    ]);
  });

  it("is visible to the model", () => {
    const names = toolsVisibleToModel(createWorkspaceTools(fakePort(), fakeHost())).map((t) => t.name);
    expect(names).toContain("delete_file");
  });

  it("declares delete_file with a flat path argument", () => {
    const tool = createWorkspaceTools(fakePort(), fakeHost()).find((t) => t.name === "delete_file");
    expect(Object.keys(tool?.parameters.properties ?? {})).toEqual(["path"]);
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

describe("outline", () => {
  it("uses the editor's symbols when a language extension handles the file", async () => {
    const invoke = getInvoke(
      "outline",
      fakePort({
        readFile: async () => "irrelevant when symbols exist\n",
        documentSymbols: async () => [
          { name: "Task", kind: "struct", line: 12, depth: 0 },
          { name: "new", kind: "method", line: 21, depth: 1 },
        ],
      }),
    );
    expect(await invoke({ path: "model.rs" })).toBe("12: struct Task\n21:   method new");
  });

  it("falls back to structure when nothing handles the file, and says so", async () => {
    const invoke = getInvoke(
      "outline",
      fakePort({
        readFile: async () => "widget Foo\n  slot bar\n",
        documentSymbols: async () => [],
      }),
    );
    const out = await invoke({ path: "a.unknown" });
    expect(out).toContain("[no language support for this file; showing outermost lines]");
    expect(out).toContain("1: widget Foo");
  });

  it("falls back rather than failing when the language server throws", async () => {
    // A server that is missing or still starting must not break the call.
    const invoke = getInvoke(
      "outline",
      fakePort({
        readFile: async () => "alpha\n",
        documentSymbols: async () => {
          throw new Error("no provider registered");
        },
      }),
    );
    expect(await invoke({ path: "a.ts" })).toContain("1: alpha");
  });

  it("reports a file with no structure at all", async () => {
    const invoke = getInvoke(
      "outline",
      fakePort({ readFile: async () => "\n\n}\n", documentSymbols: async () => [] }),
    );
    expect(await invoke({ path: "a.ts" })).toBe("[no declarations found]");
  });

  it("resolves a bare filename and reports the resolved path", async () => {
    const invoke = getInvoke(
      "outline",
      fakePort({
        readFile: async (path) => {
          if (path === "src/view.rs") {
            return "pub struct View;\n";
          }
          throw new Error(`ENOENT ${path}`);
        },
        findFiles: async (name) => (name === "view.rs" ? ["src/view.rs"] : []),
        documentSymbols: async () => [],
      }),
    );
    expect(await invoke({ path: "view.rs" })).toContain("[path: src/view.rs]");
  });

  it("reports a missing file as an error", async () => {
    const invoke = getInvoke(
      "outline",
      fakePort({
        readFile: async () => {
          throw new Error("ENOENT");
        },
      }),
    );
    expect(await invoke({ path: "nope.ts" })).toMatch(/^Error: /);
  });

  it("is visible to the model", () => {
    const names = toolsVisibleToModel(createWorkspaceTools(fakePort(), fakeHost())).map((t) => t.name);
    expect(names).toContain("outline");
  });
});

describe("references", () => {
  const src = ["use crate::view;", "", "pub fn display_tasks() {}"].join("\n");

  it("resolves the symbol to a position and lists uses with their source lines", async () => {
    const asked: unknown[] = [];
    const invoke = getInvoke(
      "references",
      fakePort({
        readFile: async () => src,
        references: async (path, at) => {
          asked.push({ path, at });
          return [
            { path: "src/view.rs", line: 3, text: "pub fn display_tasks() {}" },
            { path: "src/controller.rs", line: 18, text: "self.view.display_tasks(&tasks);" },
          ];
        },
      }),
    );
    expect(await invoke({ path: "src/view.rs", symbol: "display_tasks" })).toBe(
      [
        "src/view.rs:3: pub fn display_tasks() {}",
        "src/controller.rs:18: self.view.display_tasks(&tasks);",
      ].join("\n"),
    );
    expect(asked).toEqual([{ path: "src/view.rs", at: { line: 2, character: 7 } }]);
  });

  it("uses the line from outline when the name appears earlier in a comment", async () => {
    const withComment = ["// display_tasks does things", "", "pub fn display_tasks() {}"].join("\n");
    const asked: unknown[] = [];
    const invoke = getInvoke(
      "references",
      fakePort({
        readFile: async () => withComment,
        references: async (_path, at) => {
          asked.push(at);
          return [{ path: "a.rs", line: 3, text: "pub fn display_tasks() {}" }];
        },
      }),
    );
    await invoke({ path: "a.rs", symbol: "display_tasks", line: 3 });
    expect(asked).toEqual([{ line: 2, character: 7 }]);
  });

  it("caps a long list", async () => {
    const invoke = getInvoke(
      "references",
      fakePort({
        readFile: async () => src,
        references: async () =>
          Array.from({ length: 45 }, (_, i) => ({ path: "a.rs", line: i + 1, text: "use" })),
      }),
    );
    const out = await invoke({ path: "a.rs", symbol: "display_tasks" });
    expect(out).toContain("[5 more]");
  });

  it("does not let the model read silence as an empty result", async () => {
    const invoke = getInvoke(
      "references",
      fakePort({ readFile: async () => src, references: async () => [] }),
    );
    const out = await invoke({ path: "a.rs", symbol: "display_tasks" });
    expect(out).toContain("No answer from language support");
    expect(out).toContain("do not treat this as an empty result");
  });

  it("reports a symbol that is not in the file", async () => {
    const invoke = getInvoke("references", fakePort({ readFile: async () => src }));
    expect(await invoke({ path: "a.rs", symbol: "nope" })).toBe(
      "Error: nope does not appear in a.rs",
    );
  });

  it("requires a symbol", async () => {
    const invoke = getInvoke("references", fakePort({ readFile: async () => src }));
    expect(await invoke({ path: "a.rs" })).toBe("Error: symbol is required");
  });
});

describe("hover", () => {
  const src = "pub fn display_tasks() {}\n";

  it("returns the provider text", async () => {
    const invoke = getInvoke(
      "hover",
      fakePort({
        readFile: async () => src,
        hover: async () => "fn display_tasks(&self, tasks: &[Task])",
      }),
    );
    expect(await invoke({ path: "a.rs", symbol: "display_tasks" })).toBe(
      "fn display_tasks(&self, tasks: &[Task])",
    );
  });

  it("clips a long doc comment", async () => {
    const invoke = getInvoke(
      "hover",
      fakePort({ readFile: async () => src, hover: async () => "x".repeat(2000) }),
    );
    const out = await invoke({ path: "a.rs", symbol: "display_tasks" });
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThan(1300);
  });

  it("does not let the model read silence as an answer", async () => {
    const invoke = getInvoke(
      "hover",
      fakePort({ readFile: async () => src, hover: async () => "   " }),
    );
    expect(await invoke({ path: "a.rs", symbol: "display_tasks" })).toContain(
      "No answer from language support",
    );
  });

  it("feeds a provider failure back as an error", async () => {
    const invoke = getInvoke(
      "hover",
      fakePort({
        readFile: async () => src,
        hover: async () => {
          throw new Error("provider crashed");
        },
      }),
    );
    expect(await invoke({ path: "a.rs", symbol: "display_tasks" })).toBe("Error: provider crashed");
  });

  it("is visible to the model along with references", () => {
    const names = toolsVisibleToModel(createWorkspaceTools(fakePort(), fakeHost())).map((t) => t.name);
    expect(names).toContain("references");
    expect(names).toContain("hover");
  });
});

describe("question tool wiring", () => {
  const questionHost = { ask: async () => "axum" };

  it("is offered only when a host can put the question to a human", () => {
    const without = createWorkspaceTools(fakePort(), fakeHost()).map((t) => t.name);
    expect(without).not.toContain("question");
    const withHost = createWorkspaceTools(fakePort(), fakeHost(), questionHost).map((t) => t.name);
    expect(withHost).toContain("question");
  });

  it("invites the model to ask rather than warning it off", () => {
    // The model once reasoned "I'd ask, but I can't ask" and burned its whole
    // output budget deliberating instead. The description must read as a call.
    const tool = createWorkspaceTools(fakePort(), fakeHost(), questionHost).find(
      (t) => t.name === "question",
    );
    expect(tool?.description).toMatch(/Call this whenever/);
    expect(tool?.description).not.toMatch(/only when/);
  });

  it("tells the model in the system prompt that intent is worth asking about", () => {
    expect(SYSTEM_PROMPT).toMatch(/call question once/);
    // The old rule still stands for facts a tool can supply.
    expect(SYSTEM_PROMPT).toMatch(/Never ask the human for a path or snippet/);
  });
});

describe("glob", () => {
  it("returns matching paths sorted", async () => {
    const invoke = getInvoke(
      "glob",
      fakePort({ findFiles: async () => ["src/b.ts", "src/a.ts", "main.ts"] }),
    );
    expect(await invoke({ pattern: "**/*.ts" })).toBe("main.ts\nsrc/a.ts\nsrc/b.ts");
  });

  it("asks for one over the limit so a full page reads as truncated", async () => {
    const asked: Array<number | undefined> = [];
    const invoke = getInvoke(
      "glob",
      fakePort({
        findFiles: async (_pattern, limit) => {
          asked.push(limit);
          return Array.from({ length: 51 }, (_, i) => `f${String(i).padStart(3, "0")}.ts`);
        },
      }),
    );
    const out = await invoke({ pattern: "**/*.ts" });
    expect(asked).toEqual([51]);
    expect(out).toContain("[truncated to 50 files; narrow the pattern]");
    expect(out.split("\n").filter((l: string) => l.endsWith(".ts")).length).toBe(50);
  });

  it("does not claim truncation on an exactly full page", async () => {
    const invoke = getInvoke(
      "glob",
      fakePort({
        findFiles: async () => Array.from({ length: 50 }, (_, i) => `f${String(i).padStart(3, "0")}.ts`),
      }),
    );
    expect(await invoke({ pattern: "**/*.ts" })).not.toContain("truncated");
  });

  it("reports no matches", async () => {
    const invoke = getInvoke("glob", fakePort({ findFiles: async () => [] }));
    expect(await invoke({ pattern: "**/*.zig" })).toBe("No matches");
  });

  it("rejects an empty pattern", async () => {
    const invoke = getInvoke("glob", fakePort());
    expect(await invoke({ pattern: "  " })).toBe(
      "Error: glob requires a pattern, for example **/*.ts",
    );
  });

  it("feeds a port failure back as an error", async () => {
    const invoke = getInvoke(
      "glob",
      fakePort({
        findFiles: async () => {
          throw new Error("No workspace folder open");
        },
      }),
    );
    expect(await invoke({ pattern: "*.ts" })).toBe("Error: No workspace folder open");
  });

  it("is visible to the model", () => {
    const names = toolsVisibleToModel(createWorkspaceTools(fakePort(), fakeHost())).map((t) => t.name);
    expect(names).toContain("glob");
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
