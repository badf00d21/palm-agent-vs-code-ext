import { toPosix } from "../workspace/paths.js";

export interface EditBlock {
  path: string;
  search: string;
  replace: string;
}

export type EditKind = "edit" | "create" | "mkdir";

export function classifyEditBlock(block: {
  path: string;
  search: string;
  replace: string;
}): { ok: true; kind: EditKind; path: string } | { ok: false; error: string } {
  const raw = toPosix(block.path.trim()).replace(/^\.\//, "");
  const isDir = raw.endsWith("/");
  const path = isDir ? raw.replace(/\/+$/, "") + "/" : raw;
  const emptySearch = block.search === "";
  const emptyReplace = block.replace === "";
  if (isDir) {
    if (!emptySearch) {
      return { ok: false, error: "path is a directory" };
    }
    if (!emptyReplace) {
      return { ok: false, error: "mkdir cannot have file content" };
    }
    return { ok: true, kind: "mkdir", path };
  }
  if (emptySearch) {
    return { ok: true, kind: "create", path };
  }
  return { ok: true, kind: "edit", path };
}

const SEARCH_MARK = "<<<<<<< SEARCH";
const MID_MARK = "=======";
const REPLACE_MARK = ">>>>>>> REPLACE";

function normalizePath(raw: string): string {
  let path = raw.trim();
  if (path.startsWith("```")) {
    return "";
  }
  if (/^path:\s*/i.test(path)) {
    path = path.replace(/^path:\s*/i, "");
  }
  if (path.startsWith("`") && path.endsWith("`") && path.length >= 2) {
    path = path.slice(1, -1);
  }
  return path.trim();
}

function pathBefore(lines: string[], searchIndex: number): string {
  for (let i = searchIndex - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      continue;
    }
    const path = normalizePath(line);
    if (path) {
      return path;
    }
  }
  return "";
}

export function parseSearchReplaceBlocks(text: string): EditBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: EditBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if ((lines[i] ?? "").trim() !== SEARCH_MARK) {
      i += 1;
      continue;
    }
    const path = pathBefore(lines, i);
    const searchStart = i + 1;
    let mid = -1;
    let end = -1;
    for (let j = searchStart; j < lines.length; j += 1) {
      const trimmed = (lines[j] ?? "").trim();
      if (mid < 0 && trimmed === MID_MARK) {
        mid = j;
        continue;
      }
      if (mid >= 0 && trimmed === REPLACE_MARK) {
        end = j;
        break;
      }
    }
    if (!path || mid < 0 || end < 0) {
      i += 1;
      continue;
    }
    const replaceLines = lines.slice(mid + 1, end);
    // Some models wrap REPLACE in a closing separator too
    // ("<<<<<<< SEARCH\n=======\n<body>\n=======\n>>>>>>> REPLACE"), which would
    // otherwise leave a stray ======= as the last line of the written file. Drop
    // one trailing separator line, ignoring any blank lines after it.
    let lastLine = replaceLines.length - 1;
    while (lastLine >= 0 && replaceLines[lastLine]!.trim() === "") {
      lastLine -= 1;
    }
    if (lastLine >= 0 && replaceLines[lastLine]!.trim() === MID_MARK) {
      replaceLines.length = lastLine;
    }
    blocks.push({
      path,
      search: lines.slice(searchStart, mid).join("\n"),
      replace: replaceLines.join("\n"),
    });
    i = end + 1;
  }
  return blocks;
}

export function contentHasEditFence(text: string): boolean {
  return text.includes(SEARCH_MARK);
}

/**
 * A botched SEARCH/REPLACE attempt: a run of six or more `<` that
 * parseSearchReplaceBlocks() could not turn into a block — e.g. "Model.h
 * <<<<<<" (the real marker is "<<<<<<< SEARCH", seven of them). Six-in-a-row
 * never occurs in ordinary prose or code, so this stays clear of false
 * positives; we key on `<` only, so C++ template closers like
 * `vector<pair<int,int>>>>` never match. Used to feed the model the exact
 * format instead of surfacing the broken attempt as a final answer.
 */
export function looksLikeMalformedEditFence(text: string): boolean {
  if (parseSearchReplaceBlocks(text).length > 0) {
    return false;
  }
  return /<{6,}/.test(text);
}
