import * as vscode from "vscode";
import { ChatViewProvider } from "./chatViewProvider";
import {
  clearDeepseekApiKey,
  promptAndStoreDeepseekApiKey,
} from "./deepseekAuth";
import { loadWorkspaceEnv } from "./loadEnv";
import { createSessionHost } from "./sessionHost";

export function activate(context: vscode.ExtensionContext): void {
  loadWorkspaceEnv(context.extensionPath);
  const log = vscode.window.createOutputChannel("Palm Agent");
  log.appendLine("activated");
  log.show(true);
  console.log("[palm-agent] activated");

  try {
    const host = createSessionHost(context, log);
    const provider = new ChatViewProvider(context.extensionUri, host);
    const proposedChange = new vscode.EventEmitter<vscode.Uri>();
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    status.text = "Palm Agent";
    status.tooltip = "Open Palm Agent chat";
    status.command = "agent.focus";
    status.show();

    context.subscriptions.push(
      log,
      status,
      proposedChange,
      host.store.onDidChangeProposed((posixPath) => {
        proposedChange.fire(vscode.Uri.from({ scheme: "palm-agent", path: "/" + posixPath }));
      }),
      vscode.workspace.registerTextDocumentContentProvider("palm-agent", {
        onDidChange: proposedChange.event,
        provideTextDocumentContent(uri) {
          return host.store.proposedFor(uri.path.replace(/^\//, "")) ?? "";
        },
      }),
      vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.commands.registerCommand("agent.focus", () => {
        void vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
      }),
      vscode.commands.registerCommand("palmAgent.newChat", () => {
        provider.newChat();
      }),
      vscode.commands.registerCommand("palmAgent.setDeepseekApiKey", async () => {
        const ok = await promptAndStoreDeepseekApiKey(context.secrets);
        if (ok) {
          void vscode.window.showInformationMessage("DeepSeek API key saved to Secret Storage.");
        }
      }),
      vscode.commands.registerCommand("palmAgent.clearDeepseekApiKey", async () => {
        await clearDeepseekApiKey(context.secrets);
        void vscode.window.showInformationMessage(
          "DeepSeek API key cleared from Secret Storage. Remove palmAgent.deepseekApiKey from Settings if you set it there.",
        );
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.appendLine(`activate failed: ${message}`);
    void vscode.window.showErrorMessage(`Palm Agent failed to start: ${message}`);
    throw error;
  }
}

export function deactivate(): void {}
