import {
  mergePending,
  type PendingReview,
  type ProposedFile,
  type ReviewHost,
} from "@palm-agent/agent-core";
import type { ExtToWebview } from "@palm-agent/shared";

export interface ReviewStore {
  merge: ReviewHost["merge"];
  apply(id: string): Promise<ExtToWebview>;
  reject(id: string): ExtToWebview;
  lookup(
    id: string,
    path?: string,
  ): { path: string; proposed: string; kind: ProposedFile["kind"] } | { error: string };
  proposedFor(posixPath: string): string | undefined;
  onDidChangeProposed(listener: (path: string) => void): { dispose(): void };
  clear(): void;
}

export interface ReviewStoreDeps {
  emit: (event: ExtToWebview) => void;
  readFile: (path: string) => Promise<string>;
  exists: (path: string) => Promise<"file" | "dir" | "absent">;
  applyFiles: (
    files: Array<{ path: string; proposed: string; kind: ProposedFile["kind"] }>,
  ) => Promise<void>;
  /**
   * Called with the files that just landed on disk. Not awaited: whatever it
   * reports arrives after the review is already settled.
   */
  onApplied?: (paths: string[]) => void;
  createId?: () => string;
}

export function createReviewStore(deps: ReviewStoreDeps): ReviewStore {
  let pending: PendingReview | undefined;
  const createId = deps.createId ?? (() => `rev_${Math.random().toString(36).slice(2, 10)}`);
  const listeners = new Set<(path: string) => void>();

  function notifyProposedChange(path: string): void {
    for (const listener of listeners) {
      listener(path);
    }
  }

  function onDidChangeProposed(listener: (path: string) => void): { dispose(): void } {
    listeners.add(listener);
    return {
      dispose() {
        listeners.delete(listener);
      },
    };
  }

  function merge(files: ProposedFile[]): { id: string; paths: string[] } {
    pending = mergePending(pending, files, createId);
    for (const file of files) {
      notifyProposedChange(file.path);
    }
    deps.emit({
      type: "diff_proposed",
      id: pending.id,
      files: pending.files.map((f) => ({ path: f.path, kind: f.kind })),
    });
    return { id: pending.id, paths: pending.files.map((f) => f.path) };
  }

  async function apply(id: string): Promise<ExtToWebview> {
    if (id !== pending?.id) {
      return { type: "error", message: "No pending review" };
    }
    const active = pending;

    for (const file of active.files) {
      if (file.kind === "create" || file.kind === "mkdir") {
        const presence = await deps.exists(file.path);
        if (presence !== "absent") {
          return { type: "error", message: `File changed since proposal: ${file.path}` };
        }
        continue;
      }
      // readFile reports what the human currently sees -- the unsaved buffer when
      // there is one, otherwise disk. `original` was captured the same way, so a
      // single comparison covers an edit in the editor and a change underneath
      // it alike. Saving an already-dirty file does not trip it, because saving
      // does not change the text.
      const current = await deps.readFile(file.path);
      if (current !== file.original) {
        return {
          type: "error",
          message: `File changed since proposal: ${file.path}. Ask again so the agent can re-read it.`,
        };
      }
    }

    try {
      await deps.applyFiles(
        active.files.map((f) => ({ path: f.path, proposed: f.proposed, kind: f.kind })),
      );
    } catch (err) {
      return { type: "error", message: String(err).slice(0, 400) };
    }

    if (pending !== active) {
      return { type: "error", message: "No pending review" };
    }
    const formerPaths = active.files.map((f) => f.path);
    pending = undefined;
    for (const path of formerPaths) {
      notifyProposedChange(path);
    }
    // A directory has nothing to analyse. Deliberately not awaited: the review
    // is settled now, and what the language servers make of the change follows
    // whenever they are ready.
    const edited = active.files.filter((f) => f.kind !== "mkdir").map((f) => f.path);
    if (edited.length > 0) {
      deps.onApplied?.(edited);
    }
    return { type: "diff_settled", id, status: "kept" };
  }

  function reject(id: string): ExtToWebview {
    if (id !== pending?.id) {
      return { type: "error", message: "No pending review" };
    }

    const formerPaths = pending.files.map((f) => f.path);
    pending = undefined;
    for (const path of formerPaths) {
      notifyProposedChange(path);
    }
    return { type: "diff_settled", id, status: "undone" };
  }

  function lookup(
    id: string,
    path?: string,
  ): { path: string; proposed: string; kind: ProposedFile["kind"] } | { error: string } {
    if (id !== pending?.id) {
      return { error: "No pending review" };
    }

    if (path) {
      const file = pending.files.find((f) => f.path === path);
      if (!file) {
        return { error: "File is not in the review" };
      }
      if (file.kind === "mkdir") {
        return { error: "Directory has no diff" };
      }
      return { path: file.path, proposed: file.proposed, kind: file.kind };
    }

    const file = pending.files.find((f) => f.kind !== "mkdir");
    if (!file) {
      return { error: "Directory has no diff" };
    }
    return { path: file.path, proposed: file.proposed, kind: file.kind };
  }

  function proposedFor(posixPath: string): string | undefined {
    const normalized = posixPath.replace(/^\//, "");
    const file = pending?.files.find((f) => f.path === normalized);
    return file?.proposed;
  }

  function clear(): void {
    if (!pending) {
      return;
    }
    const formerPaths = pending.files.map((f) => f.path);
    pending = undefined;
    for (const path of formerPaths) {
      notifyProposedChange(path);
    }
  }

  return { merge, apply, reject, lookup, proposedFor, onDidChangeProposed, clear };
}
