import { rgPath } from "@vscode/ripgrep";
import {
  resolveWorkspacePath,
  toWorkspaceRelative,
  type DirEntry,
  type EditorContext,
  type WorkspacePort,
} from "@palm-agent/agent-core";
import * as vscode from "vscode";
import { searchWorkspace } from "./rg";

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
      return searchWorkspace(rgPath, query, root, glob);
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
