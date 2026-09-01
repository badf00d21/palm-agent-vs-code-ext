import type { SourcePosition } from "../workspace/port.js";

/**
 * A word boundary defined by what a character is, not by what any language calls
 * an identifier: letters, digits and underscore run together, everything else
 * separates. That covers identifiers in every language we could be looking at
 * without encoding one.
 */
function isWordChar(char: string): boolean {
  return /[\p{L}\p{N}_]/u.test(char);
}

function wholeWordIndex(line: string, symbol: string, from = 0): number {
  let index = line.indexOf(symbol, from);
  while (index >= 0) {
    const before = index > 0 ? (line[index - 1] ?? "") : "";
    const after = line[index + symbol.length] ?? "";
    if (!isWordChar(before) && !isWordChar(after)) {
      return index;
    }
    index = line.indexOf(symbol, index + 1);
  }
  return -1;
}

/**
 * Where to point a language provider when the model names a symbol rather than
 * a position. The first whole-word occurrence is normally the declaration, which
 * is exactly where a references or hover request wants to land.
 *
 * `preferLine` (1-based) narrows the search to one line first, so a caller that
 * already has a line number from `outline` gets that occurrence instead of an
 * earlier unrelated one.
 */
export function findSymbolPosition(
  content: string,
  symbol: string,
  preferLine?: number,
): SourcePosition | undefined {
  const name = symbol.trim();
  if (!name) {
    return undefined;
  }
  const lines = content.split(/\r?\n/);

  if (preferLine !== undefined && preferLine >= 1 && preferLine <= lines.length) {
    const character = wholeWordIndex(lines[preferLine - 1] ?? "", name);
    if (character >= 0) {
      return { line: preferLine - 1, character };
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const character = wholeWordIndex(lines[i] ?? "", name);
    if (character >= 0) {
      return { line: i, character };
    }
  }
  return undefined;
}
