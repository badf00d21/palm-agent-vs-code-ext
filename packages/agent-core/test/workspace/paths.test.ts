import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkspacePath, toPosix, toWorkspaceRelative } from "../../src/workspace/paths.js";

const root = path.join("D:", "ws");

describe("resolveWorkspacePath", () => {
  it("resolves a relative file inside the root", () => {
    const abs = resolveWorkspacePath(root, "src/echo.ts");
    expect(abs).toBe(path.resolve(root, "src/echo.ts"));
  });

  it("rejects parent escape", () => {
    expect(() => resolveWorkspacePath(root, "../secret.txt")).toThrow(
      "Path is outside the workspace",
    );
  });

  it("rejects an absolute path outside the root", () => {
    expect(() => resolveWorkspacePath(root, "C:\\Windows\\notepad.exe")).toThrow(
      "Path is outside the workspace",
    );
  });
});

describe("toWorkspaceRelative", () => {
  it("uses posix separators", () => {
    const abs = path.resolve(root, "src", "echo.ts");
    expect(toWorkspaceRelative(root, abs)).toBe("src/echo.ts");
  });
});

describe("toPosix", () => {
  it("replaces backslashes", () => {
    expect(toPosix("src\\echo.ts")).toBe("src/echo.ts");
  });
});
