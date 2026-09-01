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

/**
 * Error copy names the match text the way the caller's tool does, so the model
 * fixes the argument it actually passed. Fence callers say SEARCH; the `edit`
 * tool says old_string.
 */
export interface EditLabels {
  /** Sentence-initial noun for the match text. */
  Search: string;
  search: string;
  replace: string;
}

export const FENCE_LABELS: EditLabels = {
  Search: "Search",
  search: "search",
  replace: "replace",
};

export const EDIT_TOOL_LABELS: EditLabels = {
  Search: "old_string",
  search: "old_string",
  replace: "new_string",
};

/** Model invented a wildcard body (`{[^}]*}`), not a regex that already exists in the file. */
export function searchLooksLikeRegex(search: string): boolean {
  return /\{\s*\[\^\}?\]\*\}/.test(search);
}

function proposedMessage(merged: { id: string; paths: string[] }): string {
  return `Proposed review ${merged.id}: ${merged.paths.join(", ")}`;
}

/**
 * Whole-file write. Flat args (`path`, `content`) instead of propose_edit's
 * nested files[] array: a weak local model plus Ollama's tool parser handle one
 * string far better than an array of search/replace pairs. Nothing reaches disk
 * — the proposal still goes through ReviewHost for Keep All / Undo All.
 *
 * Unlike a fence create, an existing path is not an error: it becomes an `edit`
 * proposal so the human reviews a real diff. Erroring there is what put the
 * model in the retry loop observed on 2026-09-01.
 */
export async function invokeWrite(
  args: Record<string, unknown>,
  port: WorkspacePort,
  reviewHost: ReviewHost,
): Promise<string> {
  const rawPath = String(args.path ?? "").trim();
  if (!rawPath) {
    return "Error: write requires path";
  }
  if (args.content === undefined || args.content === null) {
    return "Error: write requires content (use an empty string to create an empty file)";
  }
  const content = String(args.content);
  const classified = classifyEditBlock({ path: rawPath, search: "", replace: content });
  if (!classified.ok) {
    return `Error: ${classified.error}`;
  }
  const filePath = classified.path;

  let presence: "file" | "dir" | "absent";
  try {
    presence = await port.exists(filePath);
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }

  if (classified.kind === "mkdir") {
    if (presence !== "absent") {
      return `Error: ${filePath} already exists`;
    }
    return proposedMessage(reviewHost.merge([{ path: filePath, original: "", proposed: "", kind: "mkdir" }]));
  }
  if (presence === "dir") {
    return `Error: ${filePath} is a directory, not a file`;
  }
  if (presence === "absent") {
    return proposedMessage(
      reviewHost.merge([{ path: filePath, original: "", proposed: content, kind: "create" }]),
    );
  }

  let original: string;
  try {
    original = await port.readFile(filePath);
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (original === content) {
    return `Error: ${filePath} already contains exactly this content`;
  }
  return proposedMessage(
    reviewHost.merge([{ path: filePath, original, proposed: content, kind: "edit" }]),
  );
}

/**
 * One literal replacement in one file. Same SEARCH/REPLACE semantics and the
 * same matcher as the fence path — only the transport changes (JSON args
 * instead of markers the model has to spell exactly).
 */
export async function invokeEdit(
  args: Record<string, unknown>,
  port: WorkspacePort,
  reviewHost: ReviewHost,
): Promise<string> {
  const path = String(args.path ?? "").trim();
  if (!path) {
    return "Error: edit requires path";
  }
  const oldString = String(args.old_string ?? "");
  if (!oldString) {
    return "Error: edit requires old_string. To create a file or replace one whole, call write instead.";
  }
  return invokeProposeEdit(
    { files: [{ path, search: oldString, replace: String(args.new_string ?? "") }] },
    port,
    reviewHost,
    EDIT_TOOL_LABELS,
  );
}

export async function invokeProposeEdit(
  args: Record<string, unknown>,
  port: WorkspacePort,
  reviewHost: ReviewHost,
  labels: EditLabels = FENCE_LABELS,
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
      return `Error: ${labels.search} and ${labels.replace} are identical`;
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
    return `Error: ${labels.search} is a regex, not file text (${regexSearch.search.slice(0, 80)}). Copy the exact function from read_file.`;
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
        return group.kind === "create"
          ? `Error: ${filePath} already exists. To change it, read_file it and copy its exact text into ${labels.search} (do not leave ${labels.search} empty), or call write to replace the whole file.`
          : `Error: ${filePath} already exists`;
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
          return `Error: ${labels.Search} matches more than once in ${storedPath}`;
        }
        const name = functionNameFromSearch(block.search);
        const exact = name ? exactFunctionInFile(text, name) : undefined;
        if (exact) {
          return `Error: ${labels.Search} not found in ${storedPath}. Use this exact text as ${labels.search}:\n---\n${exact}\n---`;
        }
        return `Error: ${labels.Search} not found in ${storedPath}`;
      }
      text = result.text;
    }
    proposed.push({ path: storedPath, original: located.text, proposed: text, kind: "edit" });
  }
  return proposedMessage(reviewHost.merge(proposed));
}
