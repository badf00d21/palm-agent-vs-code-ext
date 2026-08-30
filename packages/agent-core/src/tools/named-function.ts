/** Pull `function name` from a SEARCH block that looks like a whole function. */
export function functionNameFromSearch(search: string): string | undefined {
  const trimmed = search.trim();
  if (!trimmed.includes("{")) {
    return undefined;
  }
  const match = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
  return match?.[1];
}

/**
 * Exact source of one `function name(...) { ... }` in a file.
 * Used only to tell the model what to copy — does not apply edits.
 */
export function exactFunctionInFile(content: string, name: string): string | undefined {
  const re = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegExp(name)}\\b`, "g");
  const starts: Array<{ index: number; length: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    starts.push({ index: match.index, length: match[0].length });
  }
  if (starts.length !== 1) {
    return undefined;
  }
  const found = starts[0]!;
  const open = indexOfFunctionBody(content, found.index + found.length);
  if (open < 0) {
    return undefined;
  }
  const close = matchBrace(content, open);
  if (close < 0) {
    return undefined;
  }
  return content.slice(found.index, close + 1);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function indexOfFunctionBody(content: string, from: number): number {
  const paren = indexOfCode(content, from, "(");
  if (paren < 0) {
    return -1;
  }
  const closeParen = matchPair(content, paren, "(", ")");
  if (closeParen < 0) {
    return -1;
  }
  return indexOfCode(content, closeParen + 1, "{");
}

type Mode = "code" | "sq" | "dq" | "tpl" | "line" | "block";

function step(content: string, i: number, mode: Mode): { i: number; mode: Mode } {
  const c = content[i] ?? "";
  const n = content[i + 1] ?? "";
  if (mode === "line") {
    return { i: i + 1, mode: c === "\n" ? "code" : "line" };
  }
  if (mode === "block") {
    return c === "*" && n === "/" ? { i: i + 2, mode: "code" } : { i: i + 1, mode: "block" };
  }
  if (mode === "sq") {
    if (c === "\\") {
      return { i: i + 2, mode };
    }
    return { i: i + 1, mode: c === "'" ? "code" : "sq" };
  }
  if (mode === "dq") {
    if (c === "\\") {
      return { i: i + 2, mode };
    }
    return { i: i + 1, mode: c === '"' ? "code" : "dq" };
  }
  if (mode === "tpl") {
    if (c === "\\") {
      return { i: i + 2, mode };
    }
    return { i: i + 1, mode: c === "`" ? "code" : "tpl" };
  }
  if (c === "/" && n === "/") {
    return { i: i + 2, mode: "line" };
  }
  if (c === "/" && n === "*") {
    return { i: i + 2, mode: "block" };
  }
  if (c === "'") {
    return { i: i + 1, mode: "sq" };
  }
  if (c === '"') {
    return { i: i + 1, mode: "dq" };
  }
  if (c === "`") {
    return { i: i + 1, mode: "tpl" };
  }
  return { i: i + 1, mode: "code" };
}

function indexOfCode(content: string, from: number, target: string): number {
  let mode: Mode = "code";
  for (let i = from; i < content.length; ) {
    if (mode === "code" && content.startsWith(target, i)) {
      return i;
    }
    const next = step(content, i, mode);
    i = next.i;
    mode = next.mode;
  }
  return -1;
}

function matchPair(content: string, openIndex: number, open: string, close: string): number {
  let mode: Mode = "code";
  let depth = 0;
  for (let i = openIndex; i < content.length; ) {
    if (mode === "code") {
      if (content.startsWith(open, i)) {
        depth += 1;
        i += open.length;
        continue;
      }
      if (content.startsWith(close, i)) {
        depth -= 1;
        if (depth === 0) {
          return i;
        }
        i += close.length;
        continue;
      }
    }
    const next = step(content, i, mode);
    i = next.i;
    mode = next.mode;
  }
  return -1;
}

function matchBrace(content: string, openIndex: number): number {
  return matchPair(content, openIndex, "{", "}");
}
