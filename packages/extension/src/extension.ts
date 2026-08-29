import * as vscode from "vscode";
import { ChatViewProvider } from "./chatViewProvider";
import { createSessionHost } from "./sessionHost";

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("Palm Agent");
  log.appendLine("activated");
  log.show(true);
  console.log("[palm-agent] activated");

  try {
    const host = createSessionHost();
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
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.appendLine(`activate failed: ${message}`);
    void vscode.window.showErrorMessage(`Palm Agent failed to start: ${message}`);
    throw error;
  }
}

export function deactivate(): void {}
