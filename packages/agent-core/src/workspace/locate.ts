import { toPosix } from "./paths.js";
import type { WorkspacePort } from "./port.js";

export type LocatedFile = { path: string; text: string };

function normalizeInput(input: string): string {
  return toPosix(input.trim()).replace(/^\.\//, "");
}

function basename(posixPath: string): string {
  const parts = posixPath.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? posixPath;
}

/**
 * Resolve a path to something that exists, without reading it. Same rules as
 * locateWorkspaceFile — a bare filename is looked up by basename — because the
 * model mentions files both ways and a location it names must open either way.
 */
export async function resolveWorkspaceFilePath(
  port: WorkspacePort,
  input: string,
): Promise<{ path: string } | { error: string }> {
  const normalized = normalizeInput(input);
  if (!normalized) {
    return { error: "Path is empty" };
  }
  if ((await port.exists(normalized)) === "file") {
    return { path: normalized };
  }
  const name = basename(normalized);
  const hits = [...new Set(await port.findFiles(name))];
  if (hits.length === 1) {
    return { path: hits[0]! };
  }
  if (hits.length > 1) {
    return { error: `Ambiguous file ${name}: ${hits.join(", ")}` };
  }
  return { error: `No file named ${name} in this workspace` };
}

/** Read a workspace file by relative path or unique filename (`abc-import.ts`). */
export async function locateWorkspaceFile(
  port: WorkspacePort,
  input: string,
): Promise<LocatedFile | { error: string }> {
  const normalized = normalizeInput(input);
  if (!normalized) {
    return { error: "Path is empty" };
  }
  try {
    return { path: normalized, text: await port.readFile(normalized) };
  } catch (directError) {
    const name = basename(normalized);
    const hits = [...new Set(await port.findFiles(name))];
    if (hits.length === 1) {
      const path = hits[0]!;
      return { path, text: await port.readFile(path) };
    }
    if (hits.length > 1) {
      return { error: `Ambiguous file ${name}: ${hits.join(", ")}` };
    }
    return { error: directError instanceof Error ? directError.message : String(directError) };
  }
}
