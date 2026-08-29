import * as vscode from "vscode";
import { ChatViewProvider } from "./chatViewProvider";
import { createSessionHost } from "./sessionHost";

export function activate(context: vscode.ExtensionContext): void {
  console.log("[palm-agent] activated");
  const session = createSessionHost();
  const provider = new ChatViewProvider(context.extensionUri, session);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("agent.focus", () => {
      void vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    }),
  );
}

export function deactivate(): void {}
