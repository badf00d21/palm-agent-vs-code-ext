import { locateWorkspaceFile } from "../workspace/locate.js";
import type { WorkspacePort } from "../workspace/port.js";
import { classifyEditBlock, type EditKind } from "./edit-blocks.js";
import { exactFunctionInFile, functionNameFromSearch } from "./named-function.js";
import type { ProposedFile, ReviewHost } from "./review.js";
import { applySearchReplace } from "./search-replace.js";

export type ProposeEditBlock = { path: string; search: string; replace: string };

export type ProposeEditGroup = {
  kind: EditKind;
  blocks: Array<{ search: string; replace: string }>;
};

/** Model invented a wildcard body (`{[^}]*}`), not a regex that already exists in the file. */
export function searchLooksLikeRegex(search: string): boolean {
  return /\{\s*\[\^\}?\]\*\}/.test(search);
}

export async function invokeProposeEdit(
  args: Record<string, unknown>,
  port: WorkspacePort,
  reviewHost: ReviewHost,
): Promise<string> {
  const raw: unknown[] = Array.isArray(args.files) ? args.files : [];
  const blocks: ProposeEditBlock[] = raw.map((row) => {
    const rec = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
    return {
      path: String(rec.path ?? ""),
      search: String(rec.search ?? ""),
      replace: String(rec.replace ?? ""),
    };
  });
  if (blocks.length === 0) {
    return (
      "Error: No SEARCH/REPLACE block found. To create or change a file, write:\n" +
      "path/to/file\n<<<<<<< SEARCH\n=======\nnew file body\n>>>>>>> REPLACE\n" +
      "Leave SEARCH empty for a new file. Pasting code in ``` fences writes nothing."
    );
  }
  if (blocks.some((b) => !b.path.trim())) {
    return "Error: every SEARCH/REPLACE block needs a file path on the line above it";
  }
  const classified: Array<ProposeEditBlock & { kind: EditKind }> = [];
  for (const block of blocks) {
    const result = classifyEditBlock(block);
    if (!result.ok) {
      return `Error: ${result.error}`;
    }
    if (result.kind === "edit" && block.search === block.replace) {
      return "Error: search and replace are identical";
    }
    classified.push({
      path: result.path,
      kind: result.kind,
      search: block.search,
      replace: block.replace,
    });
  }
  const regexSearch = classified.find((b) => searchLooksLikeRegex(b.search));
  if (regexSearch) {
    return `Error: search is a regex, not file text (${regexSearch.search.slice(0, 80)}). Copy the exact function from read_file.`;
  }
  const order: string[] = [];
  const grouped = new Map<string, ProposeEditGroup>();
  for (const block of classified) {
    const existing = grouped.get(block.path);
    if (!existing) {
      order.push(block.path);
      grouped.set(block.path, {
        kind: block.kind,
        blocks: [{ search: block.search, replace: block.replace }],
      });
      continue;
    }
    if (existing.kind !== block.kind) {
      return `Error: cannot mix ${existing.kind} and ${block.kind} on ${block.path}`;
    }
    if (block.kind === "create" || block.kind === "mkdir") {
      existing.blocks = [{ search: block.search, replace: block.replace }];
    } else {
      existing.blocks.push({ search: block.search, replace: block.replace });
    }
  }
  const proposed: ProposedFile[] = [];
  for (const filePath of order) {
    const group = grouped.get(filePath);
    if (!group) {
      continue;
    }
    if (group.kind === "create" || group.kind === "mkdir") {
      if ((await port.exists(filePath)) !== "absent") {
        return `Error: ${filePath} already exists`;
      }
      const last = group.blocks[group.blocks.length - 1];
      proposed.push({
        path: filePath,
        original: "",
        proposed: group.kind === "mkdir" ? "" : (last?.replace ?? ""),
        kind: group.kind,
      });
      continue;
    }
    const located = await locateWorkspaceFile(port, filePath);
    if ("error" in located) {
      return `Error: ${located.error}`;
    }
    const storedPath = located.path;
    let text = located.text;
    for (const block of group.blocks) {
      const result = applySearchReplace(text, block.search, block.replace);
      if (!result.ok) {
        if (result.reason === "ambiguous") {
          return `Error: Search matches more than once in ${storedPath}`;
        }
        const name = functionNameFromSearch(block.search);
        const exact = name ? exactFunctionInFile(text, name) : undefined;
        if (exact) {
          return `Error: Search not found in ${storedPath}. Use this exact text as search:\n---\n${exact}\n---`;
        }
        return `Error: Search not found in ${storedPath}`;
      }
      text = result.text;
    }
    proposed.push({ path: storedPath, original: located.text, proposed: text, kind: "edit" });
  }
  const merged = reviewHost.merge(proposed);
  return `Proposed review ${merged.id}: ${merged.paths.join(", ")}`;
}
