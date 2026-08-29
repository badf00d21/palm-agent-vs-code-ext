import * as vscode from "vscode";
import type { AgentSession } from "@palm-agent/agent-core";
import type { ExtToWebview, WebviewToExt } from "@palm-agent/shared";
import type { ReviewStore } from "./reviewStore";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "palmAgent.chat";

  private readonly session: AgentSession;
  private readonly store: ReviewStore;

  constructor(
    private readonly extensionUri: vscode.Uri,
    host: { session: AgentSession; store: ReviewStore },
  ) {
    this.session = host.session;
    this.store = host.store;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    const post = (event: ExtToWebview) => {
      void webviewView.webview.postMessage(event);
    };

    this.session.setSink(post);
    webviewView.webview.onDidReceiveMessage((message: WebviewToExt) => {
      void this.routeMessage(message, post);
    });
  }

  private async routeMessage(
    message: WebviewToExt,
    post: (event: ExtToWebview) => void,
  ): Promise<void> {
    switch (message.type) {
      case "user_message":
        await this.session.startTurn(message.text);
        return;
      case "cancel":
        this.session.cancel();
        return;
      case "apply_diff": {
        const event = await this.store.apply(message.id);
        post(event);
        return;
      }
      case "reject_diff":
        post(this.store.reject(message.id));
        return;
      case "open_diff": {
        const found = this.store.lookup(message.id, message.path);
        if ("error" in found) {
          post({ type: "error", message: found.error });
          return;
        }
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!root) {
          post({ type: "error", message: "No workspace folder open" });
          return;
        }
        const diskUri = vscode.Uri.joinPath(root, found.path);
        const proposedUri = vscode.Uri.from({
          scheme: "palm-agent",
          path: "/" + found.path,
        });
        await vscode.commands.executeCommand(
          "vscode.diff",
          diskUri,
          proposedUri,
          `${found.path} (proposed)`,
        );
        return;
      }
      default:
        return;
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "index.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "index.css"),
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Palm Agent</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
