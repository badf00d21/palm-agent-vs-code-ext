import * as vscode from "vscode";
import {
  planFileSuggestions,
  toWorkspaceRelative,
  type AgentSession,
  type WorkspacePort,
} from "@palm-agent/agent-core";
import type { ExtToWebview, WebviewToExt } from "@palm-agent/shared";
import { isSafeMarkdownUrl } from "./safeUrl";
import type { ReviewStore } from "./reviewStore";

type SessionHost = { session: AgentSession; store: ReviewStore; port: WorkspacePort };

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "palmAgent.chat";

  private readonly host: SessionHost;

  constructor(
    private readonly extensionUri: vscode.Uri,
    host: SessionHost,
  ) {
    this.host = host;
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

    this.host.session.setSink(post);
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
        await this.host.session.startTurn(message.text);
        return;
      case "cancel":
        this.host.session.cancel();
        return;
      case "apply_diff": {
        const event = await this.host.store.apply(message.id);
        post(event);
        return;
      }
      case "reject_diff":
        post(this.host.store.reject(message.id));
        return;
      case "open_diff": {
        const found = this.host.store.lookup(message.id, message.path);
        if ("error" in found) {
          post({ type: "error", message: found.error });
          return;
        }
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!root) {
          post({ type: "error", message: "No workspace folder open" });
          return;
        }
        const leftUri =
          found.kind === "create"
            ? vscode.Uri.from({ scheme: "palm-agent", path: "/.empty" })
            : vscode.Uri.joinPath(root, found.path);
        const proposedUri = vscode.Uri.from({
          scheme: "palm-agent",
          path: "/" + found.path,
        });
        await vscode.commands.executeCommand(
          "vscode.diff",
          leftUri,
          proposedUri,
          `${found.path} (proposed)`,
        );
        return;
      }
      case "suggest_files": {
        // Deferred: option B — chip + file contents in the user payload (Cursor-style).
        // Do not attach file bodies here.
        const plan = planFileSuggestions(message.query);
        if (plan.action === "empty") {
          post({ type: "file_suggestions", query: message.query, paths: [] });
          return;
        }
        try {
          const uris = await vscode.workspace.findFiles(plan.glob, plan.exclude, plan.max);
          const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const paths = root
            ? uris.map((uri) => toWorkspaceRelative(root, uri.fsPath))
            : [];
          post({ type: "file_suggestions", query: message.query, paths });
        } catch {
          post({ type: "file_suggestions", query: message.query, paths: [] });
        }
        return;
      }
      case "open_url": {
        if (!isSafeMarkdownUrl(message.url)) {
          return;
        }
        try {
          await vscode.env.openExternal(vscode.Uri.parse(message.url));
        } catch {
          /* fail silently */
        }
        return;
      }
      case "get_selection": {
        try {
          const ctx = await this.host.port.getContext();
          const text = ctx.selection && ctx.selection.length > 0 ? ctx.selection : null;
          post({ type: "selection", text });
        } catch {
          post({ type: "selection", text: null });
        }
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
