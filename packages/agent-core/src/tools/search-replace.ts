export type SearchReplaceResult =
  | { ok: true; text: string }
  | { ok: false; reason: "not_found" | "ambiguous" };

function countExact(content: string, search: string): number {
  let count = 0;
  let from = 0;
  while (from <= content.length) {
    const index = content.indexOf(search, from);
    if (index < 0) {
      return count;
    }
    count += 1;
    from = index + Math.max(search.length, 1);
  }
  return count;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function lineSep(content: string): string {
  if (content.includes("\r\n")) {
    return "\r\n";
  }
  if (content.includes("\r")) {
    return "\r";
  }
  return "\n";
}

function lineWindows(
  contentLines: string[],
  searchLines: string[],
  norm: (line: string) => string,
): number[] {
  const hits: number[] = [];
  if (searchLines.length === 0 || searchLines.length > contentLines.length) {
    return hits;
  }
  for (let i = 0; i <= contentLines.length - searchLines.length; i += 1) {
    const ok = searchLines.every((line, j) => norm(contentLines[i + j] ?? "") === norm(line));
    if (ok) {
      hits.push(i);
    }
  }
  return hits;
}

function lineStartOffsets(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; ) {
    if (content[i] === "\r" && content[i + 1] === "\n") {
      i += 2;
      starts.push(i);
    } else if (content[i] === "\n" || content[i] === "\r") {
      i += 1;
      starts.push(i);
    } else {
      i += 1;
    }
  }
  return starts;
}

function trailingBreak(text: string): string {
  if (text.endsWith("\r\n")) {
    return "\r\n";
  }
  if (text.endsWith("\n") || text.endsWith("\r")) {
    return text.slice(-1);
  }
  return "";
}

function applyWindow(content: string, start: number, searchLen: number, replace: string): string {
  const starts = lineStartOffsets(content);
  const from = starts[start] ?? 0;
  const to = starts[start + searchLen] ?? content.length;
  const prefix = content.slice(0, from);
  const suffix = content.slice(to);
  const window = content.slice(from, to);
  const originalSep = lineSep(content);
  const replaceLines = replace.replace(/\r\n/g, "\n").split("\n");
  let replaceText = replaceLines.join(originalSep);
  const windowEnd = trailingBreak(window);
  if (windowEnd && !trailingBreak(replaceText)) {
    replaceText += windowEnd;
  }
  return prefix + replaceText + suffix;
}

export function applySearchReplace(
  content: string,
  search: string,
  replace: string,
): SearchReplaceResult {
  const exactCount = countExact(content, search);
  if (exactCount === 1) {
    const index = content.indexOf(search);
    return { ok: true, text: content.slice(0, index) + replace + content.slice(index + search.length) };
  }
  if (exactCount > 1) {
    return { ok: false, reason: "ambiguous" };
  }

  const contentLines = normalizeNewlines(content).split("\n");
  let searchLines = normalizeNewlines(search).split("\n");
  if (searchLines.length > 1 && searchLines[searchLines.length - 1] === "") {
    searchLines = searchLines.slice(0, -1);
  }

  const trimEndHits = lineWindows(contentLines, searchLines, (line) => line.trimEnd());
  if (trimEndHits.length === 1) {
    return {
      ok: true,
      text: applyWindow(content, trimEndHits[0]!, searchLines.length, replace),
    };
  }
  if (trimEndHits.length > 1) {
    return { ok: false, reason: "ambiguous" };
  }

  const trimHits = lineWindows(contentLines, searchLines, (line) => line.trim());
  if (trimHits.length === 1) {
    return {
      ok: true,
      text: applyWindow(content, trimHits[0]!, searchLines.length, replace),
    };
  }
  if (trimHits.length > 1) {
    return { ok: false, reason: "ambiguous" };
  }
  return { ok: false, reason: "not_found" };
}
