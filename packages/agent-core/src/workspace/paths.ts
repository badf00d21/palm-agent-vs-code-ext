import path from "node:path";

export function toPosix(p: string): string {
  return p.replaceAll("\\", "/");
}

export function resolveWorkspacePath(workspaceRoot: string, input: string): string {
  const root = path.resolve(workspaceRoot);
  const abs = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Path is outside the workspace");
  }
  return abs;
}

export function toWorkspaceRelative(workspaceRoot: string, absPath: string): string {
  return toPosix(path.relative(path.resolve(workspaceRoot), path.resolve(absPath)));
}
