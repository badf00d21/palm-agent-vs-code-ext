import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { afterAll, describe, expect, it } from "vitest";
import { searchWorkspace } from "./rg";

const fixture = mkdtempSync(path.join(tmpdir(), "palm-rg-"));
mkdirSync(path.join(fixture, "src"));
writeFileSync(
  path.join(fixture, "src", "style.ts"),
  "export function compileRawStyle() {\n  return 1;\n}\n",
);
writeFileSync(path.join(fixture, "readme.md"), "no hits here\n");

afterAll(() => {
  rmSync(fixture, { recursive: true, force: true });
});

describe("searchWorkspace", () => {
  // Regression for the stdin hang: rg without an explicit path reads the piped
  // stdin forever. Each test carries its own timeout so a hang fails fast.
  it("finds matches with workspace-relative posix paths and terminates", async () => {
    const hits = await searchWorkspace(rgPath, "compileRawStyle", fixture);
    expect(hits).toEqual([
      { path: "src/style.ts", line: 1, text: "export function compileRawStyle() {" },
    ]);
  }, 15_000);

  it("resolves empty for no matches instead of hanging", async () => {
    const hits = await searchWorkspace(rgPath, "definitely_not_present_zzz", fixture);
    expect(hits).toEqual([]);
  }, 15_000);

  it("honors a glob filter", async () => {
    const hits = await searchWorkspace(rgPath, "compileRawStyle", fixture, "*.md");
    expect(hits).toEqual([]);
  }, 15_000);
});
