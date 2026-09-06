import { rgPath } from "@vscode/ripgrep";
import {
  WORKSPACE_NOISE_EXCLUDE,
  resolveWorkspacePath,
  toWorkspaceRelative,
  type DirEntry,
  type Diagnostic,
  type DiagnosticSeverity,
  type EditorContext,
  type SourcePosition,
  type SymbolLocation,
  type WorkspacePort,
  type WorkspaceSymbol,
} from "@palm-agent/agent-core";
import * as vscode from "vscode";
import { searchWorkspace } from "./rg";

/** VS Code files.exclude + search.exclude → ripgrep `--glob '!…'` forms. */
export function vscodeExcludeRgGlobs(): string[] {
  const files = vscode.workspace.getConfiguration("files").get<Record<string, unknown>>("exclude") ?? {};
  const search = vscode.workspace.getConfiguration("search").get<Record<string, unknown>>("exclude") ?? {};
  const merged = { ...files, ...search };
  const globs: string[] = [];
  for (const [pattern, enabled] of Object.entries(merged)) {
    if (enabled !== true) {
      continue;
    }
    const bare = pattern.startsWith("!") ? pattern.slice(1) : pattern;
    if (!bare) {
      continue;
    }
    globs.push(`!${bare}`);
  }
  return globs;
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** An open editor with unsaved edits; its text is what the human sees. */
function dirtyDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const target = uri.toString();
  return vscode.workspace.textDocuments.find(
    (doc) => doc.isDirty && doc.uri.toString() === target,
  );
}

/** A reference is far more useful as evidence when its source line comes along. */
async function lineTextAt(uri: vscode.Uri, line: number): Promise<string> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    return doc.lineAt(line).text.trim();
  } catch {
    return "";
  }
}

/** Hover contents arrive as markdown or as the legacy {language, value} pair. */
function hoverText(content: vscode.MarkdownString | vscode.MarkedString): string {
  if (typeof content === "string") {
    return content;
  }
  if ("value" in content) {
    return content.value;
  }
  return "";
}

/** Hints and information are editor chrome, not something worth the model's context. */
function severityOf(severity: vscode.DiagnosticSeverity): DiagnosticSeverity | null {
  if (severity === vscode.DiagnosticSeverity.Error) {
    return "error";
  }
  if (severity === vscode.DiagnosticSeverity.Warning) {
    return "warning";
  }
  return null;
}

function isDocumentSymbol(
  value: vscode.DocumentSymbol | vscode.SymbolInformation,
): value is vscode.DocumentSymbol {
  return "children" in value && "range" in value;
}

/**
 * Providers return either the nested DocumentSymbol shape or the flat
 * SymbolInformation one; agent-core sees one flat list either way. The kind is
 * carried as its LSP name, so no language vocabulary leaks into the agent.
 */
function flattenSymbols(
  raw: Array<vscode.DocumentSymbol | vscode.SymbolInformation>,
  depth = 0,
  out: WorkspaceSymbol[] = [],
): WorkspaceSymbol[] {
  for (const symbol of raw) {
    const range = isDocumentSymbol(symbol) ? symbol.range : symbol.location.range;
    out.push({
      name: symbol.name,
      kind: vscode.SymbolKind[symbol.kind].toLowerCase(),
      line: range.start.line + 1,
      depth,
    });
    if (isDocumentSymbol(symbol) && symbol.children.length > 0) {
      flattenSymbols(symbol.children, depth + 1, out);
    }
  }
  return out;
}

export function createVsCodeWorkspacePort(): WorkspacePort {
  return {
    hasWorkspace: () => Boolean(workspaceRoot()),

    async readFile(input: string) {
      const root = workspaceRoot();
      if (!root) {
        throw new Error("No workspace folder open");
      }
      const uri = vscode.Uri.file(resolveWorkspacePath(root, input));
      // What the human is looking at, not what was last saved. Reading disk here
      // meant the agent reasoned about stale text and then proposed an edit the
      // apply guard had to refuse as changed.
      const unsaved = dirtyDocument(uri);
      if (unsaved) {
        return unsaved.getText();
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
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
      return searchWorkspace(rgPath, query, root, glob, vscodeExcludeRgGlobs());
    },

    async findFiles(nameOrGlob: string, limit = 20) {
      const root = workspaceRoot();
      if (!root) {
        throw new Error("No workspace folder open");
      }
      const raw = nameOrGlob.replaceAll("\\", "/").replace(/^\.\//, "");
      const glob = raw.includes("/") || raw.includes("*") ? raw : `**/${raw}`;
      const uris = await vscode.workspace.findFiles(glob, WORKSPACE_NOISE_EXCLUDE, limit);
      return uris.map((uri) => toWorkspaceRelative(root, uri.fsPath));
    },

    async documentSymbols(input: string) {
      const root = workspaceRoot();
      if (!root) {
        throw new Error("No workspace folder open");
      }
      const uri = vscode.Uri.file(resolveWorkspacePath(root, input));
      const raw = await vscode.commands.executeCommand<
        Array<vscode.DocumentSymbol | vscode.SymbolInformation>
      >("vscode.executeDocumentSymbolProvider", uri);
      return flattenSymbols(raw ?? []);
    },

    async references(input: string, at: SourcePosition) {
      const root = workspaceRoot();
      if (!root) {
        throw new Error("No workspace folder open");
      }
      const uri = vscode.Uri.file(resolveWorkspacePath(root, input));
      const found = await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeReferenceProvider",
        uri,
        new vscode.Position(at.line, at.character),
      );
      const out: SymbolLocation[] = [];
      for (const location of found ?? []) {
        out.push({
          path: toWorkspaceRelative(root, location.uri.fsPath),
          line: location.range.start.line + 1,
          text: await lineTextAt(location.uri, location.range.start.line),
        });
      }
      return out;
    },

    async hover(input: string, at: SourcePosition) {
      const root = workspaceRoot();
      if (!root) {
        throw new Error("No workspace folder open");
      }
      const uri = vscode.Uri.file(resolveWorkspacePath(root, input));
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        uri,
        new vscode.Position(at.line, at.character),
      );
      return (hovers ?? []).flatMap((hover) => hover.contents.map(hoverText)).join("\n").trim();
    },

    async exists(input: string) {
      const root = workspaceRoot();
      if (!root) {
        throw new Error("No workspace folder open");
      }
      const rel = input.replace(/\/+$/, "");
      const abs = resolveWorkspacePath(root, rel);
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(abs));
        return stat.type === vscode.FileType.Directory ? "dir" : "file";
      } catch {
        return "absent";
      }
    },

    async diagnostics(input?: string) {
      const root = workspaceRoot();
      if (!root) {
        throw new Error("No workspace folder open");
      }
      let entries: Array<[vscode.Uri, vscode.Diagnostic[]]>;
      if (input) {
        const uri = vscode.Uri.file(resolveWorkspacePath(root, input));
        entries = [[uri, vscode.languages.getDiagnostics(uri)]];
      } else {
        entries = vscode.languages.getDiagnostics();
      }
      const out: Diagnostic[] = [];
      for (const [uri, raw] of entries) {
        for (const diagnostic of raw) {
          const severity = severityOf(diagnostic.severity);
          if (!severity) {
            continue;
          }
          const code =
            typeof diagnostic.code === "object" && diagnostic.code !== null
              ? String(diagnostic.code.value)
              : diagnostic.code !== undefined
                ? String(diagnostic.code)
                : undefined;
          out.push({
            path: toWorkspaceRelative(root, uri.fsPath),
            line: diagnostic.range.start.line + 1,
            severity,
            message: diagnostic.message,
            source: diagnostic.source,
            code,
          });
        }
      }
      return out;
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
