import type { WorkspaceSymbol } from "../workspace/port.js";

/** A whole outline must stay far cheaper than reading the file it describes. */
export const OUTLINE_LIMIT = 100;
/** Long signatures would defeat the point of a cheap overview. */
export const OUTLINE_LINE_LIMIT = 120;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > OUTLINE_LINE_LIMIT ? `${flat.slice(0, OUTLINE_LINE_LIMIT)}…` : flat;
}

function truncated(rendered: string[], total: number): string {
  return total > rendered.length
    ? `${rendered.join("\n")}\n[${total - rendered.length} more; read_file a range for detail]`
    : rendered.join("\n");
}

export function formatSymbols(symbols: WorkspaceSymbol[]): string {
  const rendered = symbols
    .slice(0, OUTLINE_LIMIT)
    .map((symbol) => `${symbol.line}: ${"  ".repeat(Math.min(symbol.depth, 4))}${symbol.kind} ${clip(symbol.name)}`);
  return truncated(rendered, symbols.length);
}

/** Leading whitespace width, tabs counted as one so a file stays self-consistent. */
function indentOf(line: string): number {
  return (/^[ \t]*/.exec(line)?.[0] ?? "").length;
}

/** Braces, brackets and separators carry no structure worth listing. */
function hasWord(line: string): boolean {
  return /[\p{L}\p{N}]/u.test(line);
}

/**
 * Used when no language extension handles the file. Structure only: the lines a
 * reader's eye lands on are the ones at the outermost indentation, plus the next
 * level in, where members sit in most languages. No keyword list, so this works
 * the same for a language nobody has written support for.
 */
export function outlineByIndent(content: string): string {
  const lines = content.split(/\r?\n/);
  const candidates = lines
    .map((text, index) => ({ text, line: index + 1, indent: indentOf(text) }))
    .filter((row) => row.text.trim().length > 0 && hasWord(row.text));
  if (candidates.length === 0) {
    return "";
  }
  const indents = [...new Set(candidates.map((row) => row.indent))].sort((a, b) => a - b);
  const keep = new Set(indents.slice(0, 2));
  const kept = candidates.filter((row) => keep.has(row.indent));
  const rendered = kept
    .slice(0, OUTLINE_LIMIT)
    .map((row) => `${row.line}: ${clip(row.text)}`);
  return truncated(rendered, kept.length);
}
