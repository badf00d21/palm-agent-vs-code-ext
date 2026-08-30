import { spawn } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";
import {
  resolveWorkspacePath,
  toWorkspaceRelative,
  type DirEntry,
  type EditorContext,
  type SearchHit,
  type WorkspacePort,
} from "@palm-agent/agent-core";
import * as vscode from "vscode";

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function createVsCodeWorkspacePort(): WorkspacePort {
  return {
    hasWorkspace: () => Boolean(workspaceRoot()),

    async readFile(input: string) {
      const root = workspaceRoot();
      if (!root) {
        throw new Error("No workspace folder open");
      }
      const abs = resolveWorkspacePath(root, input);
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(abs));
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    },

    async listDir(input: string) {
      const root = workspaceRoot();
      if (!root) {
        throw new Error("No workspace folder open");
      }
      const abs = resolveWorkspacePath(root, input);
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(abs));
      return entries.map(([name, type]): DirEntry => ({
        name,
        type: type === vscode.FileType.Directory ? "dir" : "file",
      }));
    },

    async search(query: string, glob?: string) {
      const root = workspaceRoot();
      if (!root) {
        throw new Error("No workspace folder open");
      }
      const args = ["--json", "--max-count", "50", "--", query];
      if (glob) {
        args.splice(0, 0, "--glob", glob);
      }
      const hits = await runRg(rgPath, args, root);
      return hits;
    },

    async findFiles(nameOrGlob: string) {
      const root = workspaceRoot();
      if (!root) {
        throw new Error("No workspace folder open");
      }
      const raw = nameOrGlob.replaceAll("\\", "/").replace(/^\.\//, "");
      const glob = raw.includes("/") || raw.includes("*") ? raw : `**/${raw}`;
      const uris = await vscode.workspace.findFiles(glob, "**/{node_modules,dist,out,.git}/**", 20);
      return uris.map((uri) => toWorkspaceRelative(root, uri.fsPath));
    },

    async getContext() {
      const root = workspaceRoot();
      const editor = vscode.window.activeTextEditor;
      if (!root || !editor) {
        return { activeFile: null, selection: null } satisfies EditorContext;
      }
      const activeFile = toWorkspaceRelative(root, editor.document.uri.fsPath);
      const selection = editor.selection.isEmpty
        ? null
        : editor.document.getText(editor.selection);
      return { activeFile, selection };
    },
  };
}

function runRg(bin: string, args: string[], cwd: string): Promise<SearchHit[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", () => {
      if (stderr && !stdout) {
        reject(new Error(stderr.trim()));
        return;
      }
      const hits: SearchHit[] = [];
      for (const line of stdout.split("\n")) {
        if (!line) {
          continue;
        }
        try {
          const row = JSON.parse(line) as {
            type?: string;
            data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
          };
          if (row.type !== "match" || !row.data?.path?.text) {
            continue;
          }
          hits.push({
            path: toWorkspaceRelative(cwd, row.data.path.text),
            line: row.data.line_number ?? 1,
            text: (row.data.lines?.text ?? "").replace(/\n$/, ""),
          });
        } catch {
          // skip malformed rg json lines
        }
      }
      resolve(hits);
    });
  });
}
