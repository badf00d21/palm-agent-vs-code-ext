import type { ToolLocation } from "@palm-agent/shared";

/** Enough rows to act on; a longer list belongs in the model's context, not the UI. */
export const TOOL_LOCATION_LIMIT = 40;
/** The row is a hint, not the file. */
const TEXT_LIMIT = 200;

/**
 * `src/controller.rs:18: self.view.get_input(...)` — the shape search and
 * references already emit. Anchored, so a line of file content that merely
 * mentions a path is not mistaken for a result row.
 */
const ROW_RE = /^([^\s:][^:]*?):(\d+):\s?(.*)$/;

/**
 * Pulls the places a tool reported out of its raw output, so the UI can offer
 * them as somewhere to go. Read straight from the tool result rather than from
 * the model's prose: what the tool found is a fact, how the model chose to
 * phrase it is not.
 */
export function extractToolLocations(output: string): ToolLocation[] {
  const found: ToolLocation[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (found.length >= TOOL_LOCATION_LIMIT) {
      break;
    }
    const match = ROW_RE.exec(line.trimEnd());
    if (!match) {
      continue;
    }
    const [, path, lineNumber, text] = match;
    const number = Number(lineNumber);
    if (!Number.isInteger(number) || number < 1) {
      continue;
    }
    found.push({
      path: path!,
      line: number,
      text: (text ?? "").slice(0, TEXT_LIMIT),
    });
  }
  return found;
}
