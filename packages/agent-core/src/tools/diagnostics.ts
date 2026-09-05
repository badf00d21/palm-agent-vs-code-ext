import { locateWorkspaceFile } from "../workspace/locate.js";
import type { Diagnostic, WorkspacePort } from "../workspace/port.js";

/** A glance at what's broken, not a Problems panel dump into a 16k context. */
const DIAGNOSTICS_LIMIT = 40;
/** A compiler message can run to a whole paragraph; one line per row is the point. */
const MESSAGE_LIMIT = 200;

/**
 * Empty is not good news here the way it is for search: the workspace could be
 * clean, or no language server has ever looked at it. Wording has to rule out
 * the model reading silence as "I checked, no bugs" instead of "nobody checked".
 */
function noDiagnosticsMessage(target: string | undefined): string {
  const scope = target ? `for ${target}` : "in the workspace";
  return (
    `No errors or warnings reported ${scope}. This may mean the code is clean, or that no ` +
    "language server has checked it yet (missing extension, or still starting). Do not treat " +
    "this as confirmation the code is correct; read the file if the change is significant."
  );
}

function formatRow(diagnostic: Diagnostic): string {
  const source = diagnostic.source ? `[${diagnostic.source}] ` : "";
  const code = diagnostic.code ? ` (${diagnostic.code})` : "";
  const message = `${diagnostic.severity}: ${source}${diagnostic.message}${code}`
    .replace(/\s+/g, " ")
    .slice(0, MESSAGE_LIMIT);
  return `${diagnostic.path}:${diagnostic.line}: ${message}`;
}

/**
 * Pure so it can be tested without a port: given the diagnostics the caller
 * already fetched and filtered, renders the `path:line: message` rows that
 * tool-locations.ts turns into clickable results, capped and truncation-marked.
 */
export function formatDiagnostics(diagnostics: Diagnostic[], target?: string): string {
  if (diagnostics.length === 0) {
    return noDiagnosticsMessage(target);
  }
  const shown = diagnostics.slice(0, DIAGNOSTICS_LIMIT);
  const lines = shown.map(formatRow);
  if (diagnostics.length > DIAGNOSTICS_LIMIT) {
    lines.push(`[${diagnostics.length - DIAGNOSTICS_LIMIT} more]`);
  }
  return lines.join("\n");
}

export async function invokeDiagnostics(
  args: Record<string, unknown>,
  port: WorkspacePort,
): Promise<string> {
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  let target: string | undefined;
  if (rawPath) {
    const located = await locateWorkspaceFile(port, rawPath);
    if ("error" in located) {
      return `Error: ${located.error}`;
    }
    target = located.path;
  }
  // Only "error" narrows anything today; any other value keeps the default
  // (errors and warnings), which is also what an unfiltered call returns.
  const onlyErrors = args.severity === "error";
  let found: Diagnostic[];
  try {
    found = await port.diagnostics(target);
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
  const filtered = onlyErrors ? found.filter((d) => d.severity === "error") : found;
  return formatDiagnostics(filtered, target);
}
