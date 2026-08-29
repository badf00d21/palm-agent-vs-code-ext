import * as vscode from "vscode";
import { ChatViewProvider } from "./chatViewProvider";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatViewProvider(context.extensionUri);

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
