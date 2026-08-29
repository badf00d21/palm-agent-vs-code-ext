import { describe, expect, it } from "vitest";
import type { WorkspacePort } from "./port.js";
import { createWorkspaceTools } from "./tools.js";

function getInvoke(name: string, port: WorkspacePort) {
  const tool = createWorkspaceTools(port).find((t) => t.name === name);
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
