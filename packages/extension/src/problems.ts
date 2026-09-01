import { toWorkspaceRelative } from "@palm-agent/agent-core";
import type { ExtToWebview } from "@palm-agent/shared";
import * as vscode from "vscode";
import { buildProblemReport, type Problem } from "./problemSummary";

/** Longest we wait for a language server to react to the edit before reporting. */
const SETTLE_TIMEOUT_MS = 4000;
/** Once the first report lands, the rest usually follows within a moment. */
const GRACE_MS = 400;

function severityOf(severity: vscode.DiagnosticSeverity): Problem["severity"] | null {
  if (severity === vscode.DiagnosticSeverity.Error) {
    return "error";
  }
  if (severity === vscode.DiagnosticSeverity.Warning) {
    return "warning";
  }
  // Hints and information are editor chrome, not something an edit broke.
  return null;
}

/**
 * Waits for the diagnostics of these files to change, or for the timeout.
 * Language servers re-analyse asynchronously, so reading straight after
 * applyEdit would report the state from before the change.
 */
function waitForSettle(targets: Set<string>): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (delay: number): void => {
      if (done) {
        return;
      }
      done = true;
      subscription.dispose();
      clearTimeout(timer);
      setTimeout(resolve, delay);
    };
    const timer = setTimeout(() => finish(0), SETTLE_TIMEOUT_MS);
    const subscription = vscode.languages.onDidChangeDiagnostics((event) => {
      if (event.uris.some((uri) => targets.has(uri.toString()))) {
        finish(GRACE_MS);
      }
    });
  });
}

/**
 * Reports what the language servers make of the files the human just kept.
 * Reads diagnostics the editor already computed, so no command runs and no
 * language is named here. Costs no context: the model is never told, and the
 * human decides whether to ask about it.
 */
export async function reportProblemsAfterApply(
  emit: (event: ExtToWebview) => void,
  paths: string[],
): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    return;
  }
  const uris = paths.map((path) => vscode.Uri.joinPath(root, path));
  await waitForSettle(new Set(uris.map((uri) => uri.toString())));

  const problems: Problem[] = [];
  for (const uri of uris) {
    for (const diagnostic of vscode.languages.getDiagnostics(uri)) {
      const severity = severityOf(diagnostic.severity);
      if (!severity) {
        continue;
      }
      problems.push({
        path: toWorkspaceRelative(root.fsPath, uri.fsPath),
        line: diagnostic.range.start.line + 1,
        severity,
        source: diagnostic.source,
        message: diagnostic.message,
      });
    }
  }

  const report = buildProblemReport(problems);
  if (report) {
    emit({ type: "problems", ...report });
  }
}
