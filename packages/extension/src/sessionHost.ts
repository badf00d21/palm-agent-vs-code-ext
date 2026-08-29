import {
  createAgentSession,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  type AgentSession,
  type ModelConfig,
} from "@palm-agent/agent-core";
import * as vscode from "vscode";
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

export function createSessionHost(): AgentSession {
  return createAgentSession(createVsCodeWorkspacePort(), readModelConfig());
}
