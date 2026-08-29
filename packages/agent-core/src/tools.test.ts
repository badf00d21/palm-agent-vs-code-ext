import { describe, expect, it } from "vitest";
import type { WorkspacePort } from "./port.js";
import type { ReviewHost } from "./review.js";
import { createWorkspaceTools } from "./tools.js";

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
    getContext: async () => ({ activeFile: null, selection: null }),
    ...overrides,
  };
}

describe("read_file", () => {
  it("truncates after 100000 characters", async () => {
    const invoke = getInvoke(
      "read_file",
      fakePort({ readFile: async () => "x".repeat(100_001) }),
    );
    const out = await invoke({ path: "a.ts" });
    expect(out.endsWith("\n[truncated]")).toBe(true);
    expect(out.startsWith("x".repeat(100_000))).toBe(true);
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
    expect(out.split("\n").filter((l) => l.startsWith("f.ts:")).length).toBe(50);
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
      { path: "a.ts", original: "alpha\nbeta\n", proposed: "ALPHA\nBETA\n" },
      { path: "b.ts", original: "hello\n", proposed: "hi\n" },
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

  it("rejects empty files", async () => {
    const invoke = getInvoke("propose_edit", fakePort());
    expect(await invoke({ files: [] })).toBe("Error: propose_edit requires path and search");
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
    expect(merged[0]).toEqual([{ path: "src/a.ts", original: "hello\n", proposed: "hi\n" }]);
  });
});
