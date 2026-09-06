import type { EditKind } from "./edit-blocks.js";

/**
 * `EditKind` is what `classifyEditBlock` can parse out of a SEARCH/REPLACE
 * fence or `write`'s args — it has no notion of deletion. `delete_file` is a
 * distinct tool with its own proposal shape, so the kind a review card can
 * carry is wider than what fence-parsing produces.
 */
export type ProposedKind = EditKind | "delete";

export interface ProposedFile {
  path: string;
  original: string;
  proposed: string;
  kind: ProposedKind;
}

export interface PendingReview {
  id: string;
  files: ProposedFile[];
}

export interface ReviewHost {
  merge(files: ProposedFile[]): { id: string; paths: string[] };
}

export function mergePending(
  pending: PendingReview | undefined,
  files: ProposedFile[],
  createId: () => string,
): PendingReview {
  if (!pending) {
    return { id: createId(), files: [...files] };
  }
  const next = pending.files.map((file) => ({ ...file }));
  for (const file of files) {
    const index = next.findIndex((row) => row.path === file.path);
    if (index >= 0) {
      next[index] = file;
    } else {
      next.push(file);
    }
  }
  return { id: pending.id, files: next };
}
