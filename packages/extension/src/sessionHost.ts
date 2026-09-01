import {
  createAgentSession,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  type AgentSession,
  type ModelConfig,
  type WorkspacePort,
} from "@palm-agent/agent-core";
import type { ExtToWebview } from "@palm-agent/shared";
import * as vscode from "vscode";
import { applyFiles } from "./applyFiles";
import { createContextWindow } from "./contextWindow";
import { createReviewStore, type ReviewStore } from "./reviewStore";
import { createVsCodeWorkspacePort } from "./workspacePort";

export function readModelConfig(): ModelConfig {
  const cfg = vscode.workspace.getConfiguration("palmAgent");
  return {
    baseUrl: cfg.get("ollamaBaseUrl", DEFAULT_BASE_URL),
    model: cfg.get("model", DEFAULT_MODEL),
    apiKey: "not-needed",
  };
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

export function createSessionHost(log?: {
  appendLine(line: string): void;
}): { session: AgentSession; store: ReviewStore; port: WorkspacePort } {
  const port = createVsCodeWorkspacePort();
  const trace = (line: string): void => log?.appendLine(`[agent] ${line}`);
  let rawSink: (event: ExtToWebview) => void = () => undefined;
  const contextWindow = createContextWindow({
    fetchImpl: fetch,
    baseUrl: () => readModelConfig().baseUrl,
    model: () => readModelConfig().model,
  });
  let session!: AgentSession;
  const emit = (event: ExtToWebview): void => {
    if (event.type === "context_usage") {
      session.setLastUsed(event.used);
      void contextWindow.attachMax(event.used).then((full) => {
        session.setContextMax(full.max);
        trace(`event ${full.type} used=${full.used} max=${full.max ?? "null"}`);
        rawSink(full);
      });
      return;
    }
    trace(`event ${event.type}${event.type === "error" ? `: ${event.message.slice(0, 160)}` : ""}`);
    rawSink(event);
  };
  const store = createReviewStore({
    emit,
    readFile: (path) => port.readFile(path),
    exists: (path) => port.exists(path),
    applyFiles,
    readOpenText,
  });
  session = createAgentSession(port, readModelConfig(), emit, store, trace);
  return {
    session: {
      get busy() {
        return session.busy;
      },
      startTurn: (text) => session.startTurn(text),
      cancel: () => session.cancel(),
      reset: () => session.reset(),
      setLastUsed: (used) => session.setLastUsed(used),
      setContextMax: (max) => session.setContextMax(max),
      setSink(sink) {
        rawSink = sink;
      },
    },
    store,
    port,
  };
}
