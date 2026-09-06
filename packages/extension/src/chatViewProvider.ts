import * as vscode from "vscode";
import {
  planFileSuggestions,
  resolveWorkspaceFilePath,
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
  private post: ((event: ExtToWebview) => void) | undefined;
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    host: SessionHost,
  ) {
    this.host = host;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    const post = (event: ExtToWebview) => {
      void webviewView.webview.postMessage(event);
      this.maybeBadgeOnTurnEnd(event);
    };

    this.post = post;
    this.host.session.setSink(post);
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.clearBadge();
      }
    });
    webviewView.webview.onDidReceiveMessage((message: WebviewToExt) => {
      void this.routeMessage(message, post);
    });
  }

  newChat(): void {
    if (this.host.session.busy) {
      return;
    }
    this.host.store.clear();
    this.host.session.reset();
    this.clearBadge();
    this.post?.({ type: "session_cleared" });
  }

  /** Shown on the activity-bar / view icon when a turn ends while the chat is hidden. */
  private maybeBadgeOnTurnEnd(event: ExtToWebview): void {
    if (event.type !== "done" && event.type !== "error") {
      return;
    }
    if (!this.view || this.view.visible) {
      return;
    }
    this.view.badge = {
      value: 1,
      tooltip: event.type === "error" ? "Palm Agent needs attention" : "Palm Agent finished a reply",
    };
  }

  private clearBadge(): void {
    if (this.view) {
      this.view.badge = undefined;
    }
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
      case "open_location": {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!root) {
          post({ type: "error", message: "No workspace folder open" });
          return;
        }
        // The model cites files both as full paths and as bare names, so a click
        // has to resolve the same way read_file does. Joining a bare name onto
        // the workspace root points at a file that is not there.
        const found = await resolveWorkspaceFilePath(this.host.port, message.path);
        if ("error" in found) {
          post({ type: "error", message: found.error });
          return;
        }
        try {
          const uri = vscode.Uri.joinPath(root, found.path);
          const doc = await vscode.workspace.openTextDocument(uri);
          // The model counts from 1; clamp so a stale line number still opens.
          const line = Math.min(Math.max(message.line, 1), doc.lineCount) - 1;
          const at = new vscode.Range(line, 0, line, 0);
          const editor = await vscode.window.showTextDocument(doc, {
            preview: true,
            selection: at,
          });
          editor.revealRange(at, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        } catch (error) {
          post({
            type: "error",
            message: `Cannot open ${found.path}: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        return;
      }
      case "question_answered":
        this.host.session.answerQuestion(message.id, message.answer);
        return;
      case "new_chat":
        this.newChat();
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
