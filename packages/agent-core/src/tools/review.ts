import type { EditKind } from "./edit-blocks.js";

export interface ProposedFile {
  path: string;
  original: string;
  proposed: string;
  kind: EditKind;
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
