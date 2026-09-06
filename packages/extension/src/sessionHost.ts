import {
  createAgentSession,
  DEEPSEEK_BASE_URL,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MODEL,
  isDeepSeekModel,
  type AgentSession,
  type ModelConfig,
  type WorkspacePort,
} from "@palm-agent/agent-core";
import { readMozaikCloudOptions } from "./loadEnv";
import { getDeepseekApiKey } from "./deepseekAuth";
import type { ExtToWebview } from "@palm-agent/shared";
import * as vscode from "vscode";
import { applyFiles } from "./applyFiles";
import { createContextWindow } from "./contextWindow";
import { reportProblemsAfterApply } from "./problems";
import { createReviewStore, type ReviewStore } from "./reviewStore";
import { createVsCodeWorkspacePort } from "./workspacePort";

export const MISSING_DEEPSEEK_KEY_MESSAGE =
  "DeepSeek API key is missing. Run “Palm Agent: Set DeepSeek API Key”, or set palmAgent.deepseekApiKey in Settings.";

export async function readModelConfig(
  secrets: vscode.SecretStorage,
): Promise<ModelConfig> {
  const cfg = vscode.workspace.getConfiguration("palmAgent");
  const rawModel = cfg.get<string>("model", DEFAULT_MODEL);
  const model = isDeepSeekModel(rawModel) ? rawModel : DEFAULT_MODEL;
  return {
    baseUrl: DEEPSEEK_BASE_URL,
    model,
    apiKey: await getDeepseekApiKey(secrets),
    maxOutputTokens: cfg.get("maxOutputTokens", DEFAULT_MAX_OUTPUT_TOKENS),
  };
}

export function createSessionHost(
  context: vscode.ExtensionContext,
  log?: { appendLine(line: string): void },
): { session: AgentSession; store: ReviewStore; port: WorkspacePort } {
  const port = createVsCodeWorkspacePort();
  const trace = (line: string): void => log?.appendLine(`[agent] ${line}`);
  let rawSink: (event: ExtToWebview) => void = () => undefined;

  /** Mutable config object — refreshed before each turn so Settings/Secret Storage apply live. */
  const modelConfig: ModelConfig = {
    baseUrl: DEEPSEEK_BASE_URL,
    model: DEFAULT_MODEL,
    apiKey: "",
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  };

  const contextWindow = createContextWindow({
    fetchImpl: fetch,
    baseUrl: () => modelConfig.baseUrl,
    model: () => modelConfig.model,
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
    onApplied: (paths) => {
      void reportProblemsAfterApply(emit, paths).catch(() => undefined);
    },
  });
  session = createAgentSession(
    port,
    modelConfig,
    emit,
    store,
    trace,
    readMozaikCloudOptions(),
  );

  const refreshConfig = async (): Promise<ModelConfig> => {
    const next = await readModelConfig(context.secrets);
    modelConfig.baseUrl = next.baseUrl;
    modelConfig.model = next.model;
    modelConfig.apiKey = next.apiKey;
    modelConfig.maxOutputTokens = next.maxOutputTokens;
    return modelConfig;
  };

  void refreshConfig().catch((error) => {
    trace(`config load failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  return {
    session: {
      get busy() {
        return session.busy;
      },
      async startTurn(text) {
        const config = await refreshConfig();
        if (!config.apiKey.trim()) {
          emit({ type: "error", message: MISSING_DEEPSEEK_KEY_MESSAGE });
          return;
        }
        return session.startTurn(text);
      },
      cancel: () => session.cancel(),
      reset: () => session.reset(),
      setLastUsed: (used) => session.setLastUsed(used),
      setContextMax: (max) => session.setContextMax(max),
      answerQuestion: (id, answer) => session.answerQuestion(id, answer),
      setSink(sink) {
        rawSink = sink;
      },
    },
    store,
    port,
  };
}
