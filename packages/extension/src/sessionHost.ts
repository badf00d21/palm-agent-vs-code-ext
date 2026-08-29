import {
  createAgentSession,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  type AgentSession,
  type ModelConfig,
} from "@palm-agent/agent-core";
import type { ExtToWebview } from "@palm-agent/shared";
import * as vscode from "vscode";
import { createReviewStore, type ReviewStore } from "./reviewStore";
import { createVsCodeWorkspacePort } from "./workspacePort";

export function readModelConfig(): ModelConfig {
  const cfg = vscode.workspace.getConfiguration("palmAgent");
  return {
    baseUrl: cfg.get("ollamaBaseUrl", DEFAULT_BASE_URL),
    // deepseek-v4-pro = Ollama alias for local qwen coder (Mozaik ModelName limit)
    model: cfg.get("model", DEFAULT_MODEL),
    apiKey: "not-needed",
  };
}

async function applyFiles(files: Array<{ path: string; proposed: string }>): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    throw new Error("No workspace folder open");
  }
  const edit = new vscode.WorkspaceEdit();
  for (const file of files) {
    const uri = vscode.Uri.joinPath(root, file.path);
    const doc = await vscode.workspace.openTextDocument(uri);
    const end = doc.positionAt(doc.getText().length);
    edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), end), file.proposed);
  }
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    throw new Error("WorkspaceEdit was not applied");
  }
}

async function readOpenText(
  filePath: string,
): Promise<{ text: string; dirty: boolean } | undefined> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    return undefined;
  }
  const target = vscode.Uri.joinPath(root, filePath).toString();
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === target);
  if (!doc) {
    return undefined;
  }
  return { text: doc.getText(), dirty: doc.isDirty };
}

export function createSessionHost(): { session: AgentSession; store: ReviewStore } {
  const port = createVsCodeWorkspacePort();
  let emit: (event: ExtToWebview) => void = () => undefined;
  const store = createReviewStore({
    emit: (event) => emit(event),
    readFile: (path) => port.readFile(path),
    applyFiles,
    readOpenText,
  });
  const session = createAgentSession(port, readModelConfig(), (event) => emit(event), store);
  return {
    session: {
      get busy() {
        return session.busy;
      },
      startTurn: (text) => session.startTurn(text),
      cancel: () => session.cancel(),
      setSink(sink) {
        emit = sink;
        session.setSink(sink);
      },
    },
    store,
  };
}
