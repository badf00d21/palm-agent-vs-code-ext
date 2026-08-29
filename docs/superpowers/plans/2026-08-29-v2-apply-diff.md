# v2 Apply/diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the agent propose SEARCH/REPLACE edits; the human reviews one Cursor-like file card and Keep All applies a `WorkspaceEdit`.

**Architecture:** Pure matcher and `propose_edit` live in `agent-core`. `ReviewHost.merge` is implemented by an extension `ReviewStore` (one pending review, merge-on-repeat). The webview shows a collapsible card (Undo All / Keep All / Review). Preview is native `vscode.diff` against a `palm-agent` virtual document. Disk writes happen only on Keep All.

**Tech Stack:** existing pnpm monorepo, Vitest, VS Code `WorkspaceEdit` + `TextDocumentContentProvider`, no new packages.

**Spec:** `docs/superpowers/specs/2026-08-29-v2-apply-diff-design.md`

## Global Constraints

- `packages/agent-core` has zero `import 'vscode'` (and no `require('vscode')`).
- `WorkspacePort` stays read-only. Agent never writes disk.
- One pending review per session. Successful `propose_edit` merges (same path replaces, new path appends).
- `propose_edit` returns immediately; Keep/Undo do not block the tool.
- Existing files only. No create, no delete-file.
- Error copy is verbatim from the spec (`Error: propose_edit requires path and search`, `Error: Search not found in <path>`, `Error: Search matches more than once in <path>`, `No pending review`, `File is not in the review`, `File changed since proposal: <path>`).
- Keep All = `apply_diff`, Undo All = `reject_diff`, Review/click = `open_diff`.
- Commits are owned by the human; treat each Task's commit step as optional.
- Do not load `.env` in the extension host. Do not implement streaming, `cancel`, or per-hunk accept.

## File structure

| File | Responsibility |
|---|---|
| `packages/shared/src/index.ts` | `DiffFile`, `open_diff`, `diff_settled` |
| `packages/agent-core/src/search-replace.ts` | `applySearchReplace` |
| `packages/agent-core/src/review.ts` | `ProposedFile`, `PendingReview`, `ReviewHost`, `mergePending` |
| `packages/agent-core/src/tools.ts` | `propose_edit` + updated `SYSTEM_PROMPT` |
| `packages/agent-core/src/session.ts` | `createAgentSession(..., reviewHost)` |
| `packages/agent-core/src/index.ts` | Export review types |
| `packages/extension/src/reviewStore.ts` | Pending store, apply/reject, proposed lookup |
| `packages/extension/src/sessionHost.ts` | Build store + session |
| `packages/extension/src/chatViewProvider.ts` | Route apply/reject/open |
| `packages/extension/src/extension.ts` | Register `palm-agent` content provider |
| `packages/extension/src/webview/chatMessages.ts` | Review line reducer |
| `packages/extension/src/webview/App.tsx` | Review card UI |
| `packages/extension/src/webview/App.css` | Card styles |

---

### Task 1: Shared protocol

**Files:**
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: current `WebviewToExt` / `ExtToWebview`
- Produces: `DiffFile { path: string }`, `open_diff`, `diff_settled`

- [ ] **Step 1: Replace shared types**

`packages/shared/src/index.ts` must be exactly:

```ts
export interface DiffFile {
  path: string;
}

export type WebviewToExt =
  | { type: "user_message"; text: string }
  | { type: "apply_diff"; id: string }
  | { type: "reject_diff"; id: string }
  | { type: "open_diff"; id: string; path?: string }
  | { type: "cancel" };

export type ExtToWebview =
  | { type: "assistant_delta"; text: string }
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "diff_proposed"; id: string; files: DiffFile[] }
  | { type: "diff_settled"; id: string; status: "kept" | "undone" }
  | { type: "done" }
  | { type: "error"; message: string };
```

- [ ] **Step 2: Typecheck dependents**

Run: `pnpm --filter @palm-agent/agent-core exec tsc --noEmit` if a tsconfig exists; otherwise `pnpm --filter @palm-agent/agent-core test` and `pnpm --filter palm-agent test`.

Expected: existing tests still PASS (they do not construct `DiffFile` with `search`/`replace`).

- [ ] **Step 3: Commit (optional, human)**

```
feat: slim DiffFile and add open_diff / diff_settled
```

---

### Task 2: SEARCH/REPLACE matcher

**Files:**
- Create: `packages/agent-core/src/search-replace.ts`
- Create: `packages/agent-core/src/search-replace.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `applySearchReplace(content: string, search: string, replace: string): { ok: true; text: string } | { ok: false; reason: "not_found" | "ambiguous" }`

- [ ] **Step 1: Write the failing tests**

`packages/agent-core/src/search-replace.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applySearchReplace } from "./search-replace.js";

describe("applySearchReplace", () => {
  it("replaces one exact match", () => {
    const result = applySearchReplace("const getUser = 1;\n", "getUser", "fetchUser");
    expect(result).toEqual({ ok: true, text: "const fetchUser = 1;\n" });
  });

  it("matches a trimEnd window when exact fails", () => {
    const content = "function foo() {\n  return 1;\n}\n";
    const search = "function foo() {\n  return 1;\n}\n";
    const result = applySearchReplace(content, search.trimEnd() + "   \n", "function foo() {\n  return 2;\n}\n");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain("return 2");
    }
  });

  it("matches a trim window when indent differs", () => {
    const content = "    const x = 1;\n";
    const search = "const x = 1;";
    const result = applySearchReplace(content, search, "const x = 2;");
    expect(result).toEqual({ ok: true, text: "const x = 2;\n" });
  });

  it("rejects two exact matches", () => {
    const result = applySearchReplace("getUser getUser", "getUser", "fetchUser");
    expect(result).toEqual({ ok: false, reason: "ambiguous" });
  });

  it("returns not_found when nothing matches", () => {
    const result = applySearchReplace("hello\n", "getUser", "fetchUser");
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @palm-agent/agent-core exec vitest run src/search-replace.test.ts`

Expected: FAIL — `Cannot find module './search-replace.js'`

- [ ] **Step 3: Implement matcher**

`packages/agent-core/src/search-replace.ts`:

```ts
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

function applyWindow(
  content: string,
  contentLines: string[],
  start: number,
  searchLen: number,
  replace: string,
): string {
  const originalSep = content.includes("\r\n") ? "\r\n" : "\n";
  const next = contentLines
    .slice(0, start)
    .concat(replace.split("\n"))
    .concat(contentLines.slice(start + searchLen));
  return next.join(originalSep);
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

  const contentLines = content.replace(/\r\n/g, "\n").split("\n");
  let searchLines = search.replace(/\r\n/g, "\n").split("\n");
  if (searchLines.length > 1 && searchLines[searchLines.length - 1] === "") {
    searchLines = searchLines.slice(0, -1);
  }

  const trimEndHits = lineWindows(contentLines, searchLines, (line) => line.trimEnd());
  if (trimEndHits.length === 1) {
    return {
      ok: true,
      text: applyWindow(content, contentLines, trimEndHits[0]!, searchLines.length, replace),
    };
  }
  if (trimEndHits.length > 1) {
    return { ok: false, reason: "ambiguous" };
  }

  const trimHits = lineWindows(contentLines, searchLines, (line) => line.trim());
  if (trimHits.length === 1) {
    return {
      ok: true,
      text: applyWindow(content, contentLines, trimHits[0]!, searchLines.length, replace),
    };
  }
  if (trimHits.length > 1) {
    return { ok: false, reason: "ambiguous" };
  }
  return { ok: false, reason: "not_found" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @palm-agent/agent-core exec vitest run src/search-replace.test.ts`

Expected: PASS (5 tests). If the `trimEnd` case fails because exact already matched, change that test's `search` so it is not an exact substring (add trailing spaces on an inner line only, not the whole string as a substring).

- [ ] **Step 5: Commit (optional, human)**

```
feat: add SEARCH/REPLACE matcher
```

---

### Task 3: Pending merge helper

**Files:**
- Create: `packages/agent-core/src/review.ts`
- Create: `packages/agent-core/src/review.test.ts`
- Modify: `packages/agent-core/src/index.ts`

**Interfaces:**
- Consumes: `ProposedFile`
- Produces: `mergePending(pending, files, createId): PendingReview`, `ReviewHost`

- [ ] **Step 1: Write the failing tests**

`packages/agent-core/src/review.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mergePending, type ProposedFile } from "./review.js";

const a = (proposed: string): ProposedFile => ({
  path: "a.ts",
  original: "old-a",
  proposed,
});

const b: ProposedFile = { path: "b.ts", original: "old-b", proposed: "new-b" };

describe("mergePending", () => {
  it("creates an id and one path on an empty store", () => {
    const next = mergePending(undefined, [a("new-a")], () => "rev_1");
    expect(next.id).toBe("rev_1");
    expect(next.files.map((f) => f.path)).toEqual(["a.ts"]);
    expect(next.files[0]?.proposed).toBe("new-a");
  });

  it("replaces the same path and keeps length 1", () => {
    const first = mergePending(undefined, [a("one")], () => "rev_1");
    const next = mergePending(first, [a("two")], () => "rev_unused");
    expect(next.id).toBe("rev_1");
    expect(next.files).toHaveLength(1);
    expect(next.files[0]?.proposed).toBe("two");
  });

  it("appends a new path after the old one", () => {
    const first = mergePending(undefined, [a("one")], () => "rev_1");
    const next = mergePending(first, [b], () => "rev_unused");
    expect(next.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @palm-agent/agent-core exec vitest run src/review.test.ts`

Expected: FAIL — module not found

- [ ] **Step 3: Implement review types + merge**

`packages/agent-core/src/review.ts`:

```ts
export interface ProposedFile {
  path: string;
  original: string;
  proposed: string;
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
```

Add to `packages/agent-core/src/index.ts`:

```ts
export type { PendingReview, ProposedFile, ReviewHost } from "./review.js";
export { mergePending } from "./review.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @palm-agent/agent-core exec vitest run src/review.test.ts`

Expected: PASS (3 tests)

- [ ] **Step 5: Commit (optional, human)**

```
feat: add pending review merge
```

---

### Task 4: `propose_edit` tool and session host arg

**Files:**
- Modify: `packages/agent-core/src/tools.ts`
- Modify: `packages/agent-core/src/tools.test.ts`
- Modify: `packages/agent-core/src/session.ts`
- Modify: `packages/agent-core/src/session.test.ts`
- Modify: `packages/extension/src/sessionHost.ts` (noop host only if Task 6 not done yet — prefer a throw-free stub `merge` that returns `{ id: "rev_pending", paths }` **without** emit; Task 6 replaces it)

**Interfaces:**
- Consumes: `applySearchReplace`, `ReviewHost`, `WorkspacePort.readFile`
- Produces: `createWorkspaceTools(port, reviewHost): Tool[]` including `propose_edit`

- [ ] **Step 1: Write failing `propose_edit` tests**

Add to `packages/agent-core/src/tools.test.ts` (update helper first so it compiles after the signature change — write tests against the new signature):

```ts
import type { ReviewHost } from "./review.js";

function fakeHost(overrides: Partial<ReviewHost> = {}): ReviewHost {
  return {
    merge: (files) => ({ id: "rev_1", paths: files.map((f) => f.path) }),
    ...overrides,
  };
}

function getInvoke(name: string, port: WorkspacePort, host: ReviewHost = fakeHost()) {
  const tool = createWorkspaceTools(port, host).find((t) => t.name === name);
  if (!tool) {
    throw new Error(`missing ${name}`);
  }
  return tool.invoke;
}
```

New cases:

```ts
describe("propose_edit", () => {
  it("merges two files after sequential blocks on one path", async () => {
    const merged: unknown[] = [];
    const invoke = getInvoke(
      "propose_edit",
      fakePort({
        readFile: async (path) => {
          if (path === "a.ts") {
            return "alpha\nbeta\n";
          }
          return "hello\n";
        },
      }),
      {
        merge: (files) => {
          merged.push(files);
          return { id: "rev_1", paths: files.map((f) => f.path) };
        },
      },
    );
    const out = await invoke({
      files: [
        { path: "a.ts", search: "alpha", replace: "ALPHA" },
        { path: "b.ts", search: "hello", replace: "hi" },
        { path: "a.ts", search: "beta", replace: "BETA" },
      ],
    });
    expect(out).toBe("Proposed review rev_1: a.ts, b.ts");
    expect(merged[0]).toEqual([
      { path: "a.ts", original: "alpha\nbeta\n", proposed: "ALPHA\nBETA\n" },
      { path: "b.ts", original: "hello\n", proposed: "hi\n" },
    ]);
  });

  it("does not merge when search is missing", async () => {
    let called = false;
    const invoke = getInvoke(
      "propose_edit",
      fakePort({ readFile: async () => "only this\n" }),
      {
        merge: () => {
          called = true;
          return { id: "rev_1", paths: [] };
        },
      },
    );
    expect(await invoke({ files: [{ path: "a.ts", search: "getUser", replace: "fetchUser" }] })).toBe(
      "Error: Search not found in a.ts",
    );
    expect(called).toBe(false);
  });

  it("rejects empty files", async () => {
    const invoke = getInvoke("propose_edit", fakePort());
    expect(await invoke({ files: [] })).toBe("Error: propose_edit requires path and search");
  });
});
```

Change `SYSTEM_PROMPT` expectation: do not add a prompt snapshot test unless one exists.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @palm-agent/agent-core exec vitest run src/tools.test.ts`

Expected: FAIL — `createWorkspaceTools` arity / missing `propose_edit`

- [ ] **Step 3: Implement tool + prompt + session arg**

Replace `SYSTEM_PROMPT` with exactly:

```ts
export const SYSTEM_PROMPT =
  "You are a coding assistant in a local workspace. Use the provided tools to read the workspace before answering questions about code. Do not invent file contents. You can propose edits with the propose_edit tool (SEARCH/REPLACE on existing files only). Never write to disk yourself and never print a tool call as JSON. The human reviews a file list and chooses Keep All or Undo All. If search fails, retry with a more exact snippet from read_file. This repo is TypeScript; prefer *.ts / *.tsx when searching.";
```

Change signature to `createWorkspaceTools(port: WorkspacePort, reviewHost: ReviewHost): Tool[]`.

Append tool (keep the four existing tools unchanged except they still close over `port` only):

```ts
{
  name: "propose_edit",
  description:
    "Propose SEARCH/REPLACE edits to existing workspace files. Does not write disk. The human reviews Keep All / Undo All.",
  strict: true,
  type: "function",
  parameters: {
    type: "object",
    properties: {
      files: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            search: { type: "string" },
            replace: { type: "string" },
          },
          required: ["path", "search", "replace"],
        },
      },
    },
    required: ["files"],
  },
  invoke: async (args) => {
    const raw = Array.isArray(args.files) ? args.files : [];
    const blocks = raw.map((row) => {
      const rec = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
      return {
        path: String(rec.path ?? ""),
        search: String(rec.search ?? ""),
        replace: String(rec.replace ?? ""),
      };
    });
    if (blocks.length === 0 || blocks.some((b) => !b.path.trim() || !b.search)) {
      return "Error: propose_edit requires path and search";
    }
    const order: string[] = [];
    const grouped = new Map<string, Array<{ search: string; replace: string }>>();
    for (const block of blocks) {
      if (!grouped.has(block.path)) {
        order.push(block.path);
        grouped.set(block.path, []);
      }
      grouped.get(block.path)!.push({ search: block.search, replace: block.replace });
    }
    const proposed: ProposedFile[] = [];
    for (const filePath of order) {
      let original: string;
      try {
        original = await port.readFile(filePath);
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
      let text = original;
      for (const block of grouped.get(filePath) ?? []) {
        const result = applySearchReplace(text, block.search, block.replace);
        if (!result.ok) {
          return result.reason === "ambiguous"
            ? `Error: Search matches more than once in ${filePath}`
            : `Error: Search not found in ${filePath}`;
        }
        text = result.text;
      }
      proposed.push({ path: filePath, original, proposed: text });
    }
    const merged = reviewHost.merge(proposed);
    return `Proposed review ${merged.id}: ${merged.paths.join(", ")}`;
  },
}
```

`session.ts`: add parameter `reviewHost: ReviewHost` and `createWorkspaceTools(port, reviewHost)`.

`session.test.ts`: pass `{ merge: (files) => ({ id: "rev_test", paths: files.map((f) => f.path) }) }` as the fourth argument to both `createAgentSession` calls.

`sessionHost.ts` (temporary stub until Task 6):

```ts
export function createSessionHost(): AgentSession {
  const reviewHost = {
    merge: (files: { path: string }[]) => ({
      id: "rev_stub",
      paths: files.map((f) => f.path),
    }),
  };
  return createAgentSession(createVsCodeWorkspacePort(), readModelConfig(), undefined, reviewHost);
}
```

If `createAgentSession` argument order is `(port, config, initialSink, reviewHost)`, keep `initialSink` optional default `() => undefined`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @palm-agent/agent-core test`

Expected: all agent-core tests PASS, including new `propose_edit` cases.

- [ ] **Step 5: Commit (optional, human)**

```
feat: add propose_edit tool
```

---

### Task 5: ReviewStore apply / reject / stale

**Files:**
- Create: `packages/extension/src/reviewStore.ts`
- Create: `packages/extension/src/reviewStore.test.ts`

**Interfaces:**
- Consumes: `mergePending`, `ProposedFile`, `ExtToWebview`
- Produces: `createReviewStore(deps)` with `merge`, `apply`, `reject`, `lookup`

```ts
export interface ReviewStore {
  merge: ReviewHost["merge"];
  apply(id: string): Promise<ExtToWebview>;
  reject(id: string): ExtToWebview;
  lookup(id: string, path?: string): { path: string; proposed: string } | { error: string };
  proposedFor(posixPath: string): string | undefined;
}

export interface ReviewStoreDeps {
  emit: (event: ExtToWebview) => void;
  readFile: (path: string) => Promise<string>;
  applyFiles: (files: Array<{ path: string; proposed: string }>) => Promise<void>;
  createId?: () => string;
}
```

- [ ] **Step 1: Write the failing stale/apply tests**

`packages/extension/src/reviewStore.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createReviewStore } from "./reviewStore";

describe("createReviewStore", () => {
  it("emits diff_proposed on merge", () => {
    const events: unknown[] = [];
    const store = createReviewStore({
      emit: (e) => events.push(e),
      readFile: async () => "a",
      applyFiles: async () => undefined,
      createId: () => "rev_1",
    });
    store.merge([{ path: "a.ts", original: "a", proposed: "b" }]);
    expect(events).toEqual([{ type: "diff_proposed", id: "rev_1", files: [{ path: "a.ts" }] }]);
  });

  it("does not write when disk is stale", async () => {
    let wrote = false;
    const store = createReviewStore({
      emit: () => undefined,
      readFile: async () => "changed",
      applyFiles: async () => {
        wrote = true;
      },
      createId: () => "rev_1",
    });
    store.merge([{ path: "a.ts", original: "a", proposed: "b" }]);
    const result = await store.apply("rev_1");
    expect(result).toEqual({ type: "error", message: "File changed since proposal: a.ts" });
    expect(wrote).toBe(false);
    expect(store.lookup("rev_1", "a.ts")).toEqual({ path: "a.ts", proposed: "b" });
  });

  it("clears pending on reject", () => {
    const events: unknown[] = [];
    const store = createReviewStore({
      emit: (e) => events.push(e),
      readFile: async () => "a",
      applyFiles: async () => undefined,
      createId: () => "rev_1",
    });
    store.merge([{ path: "a.ts", original: "a", proposed: "b" }]);
    expect(store.reject("rev_1")).toEqual({ type: "diff_settled", id: "rev_1", status: "undone" });
    expect(store.lookup("rev_1")).toEqual({ error: "No pending review" });
  });

  it("returns No pending review for a wrong id", async () => {
    const store = createReviewStore({
      emit: () => undefined,
      readFile: async () => "a",
      applyFiles: async () => undefined,
    });
    expect(await store.apply("nope")).toEqual({ type: "error", message: "No pending review" });
    expect(store.reject("nope")).toEqual({ type: "error", message: "No pending review" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter palm-agent exec vitest run src/reviewStore.test.ts`

Expected: FAIL — module not found

- [ ] **Step 3: Implement store**

`packages/extension/src/reviewStore.ts` — hold `let pending: PendingReview | undefined`. `merge` uses `mergePending`, then `emit({ type: "diff_proposed", id, files: pending.files.map(f => ({ path: f.path })) })`, return `{ id, paths }`.

`apply`: if `id !== pending?.id` → `{ type: "error", message: "No pending review" }`. Else for each file `readFile(path)`; if `!== original` return stale error (first path). Else `await applyFiles(...)`; on throw return `{ type: "error", message: String(err).slice(0, 400) }` and keep pending. On success clear pending, return `{ type: "diff_settled", id, status: "kept" }` (do not also emit — chatViewProvider posts the returned event).

`reject`: wrong id → error event; else clear and return `diff_settled` undone.

`lookup(id, path?)`: wrong id / no pending → `{ error: "No pending review" }`. If `path` given and missing → `{ error: "File is not in the review" }`. Else first file or that path.

`proposedFor(posixPath)`: strip leading `/` from virtual URI path, find pending file.

`createId` default: `rev_` + `Math.random().toString(36).slice(2, 10)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter palm-agent exec vitest run src/reviewStore.test.ts`

Expected: PASS

- [ ] **Step 5: Commit (optional, human)**

```
feat: add review store with stale apply guard
```

---

### Task 6: Extension host wiring

**Files:**
- Modify: `packages/extension/src/sessionHost.ts`
- Modify: `packages/extension/src/chatViewProvider.ts`
- Modify: `packages/extension/src/extension.ts`

**Interfaces:**
- Consumes: `createReviewStore`, `createAgentSession`, `WebviewToExt`
- Produces: live Keep/Undo/Review in Extension Host

- [ ] **Step 1: Session host returns session + store**

`packages/extension/src/sessionHost.ts`:

```ts
import {
  createAgentSession,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  type AgentSession,
  type ModelConfig,
} from "@palm-agent/agent-core";
import type { ExtToWebview } from "@palm-agent/shared";
import * as vscode from "vscode";
import { createReviewStore, type ReviewStore } from "./reviewStore";
import { createVsCodeWorkspacePort } from "./workspacePort";

export function readModelConfig(): ModelConfig {
  const cfg = vscode.workspace.getConfiguration("palmAgent");
  return {
    baseUrl: cfg.get("ollamaBaseUrl", DEFAULT_BASE_URL),
    model: cfg.get("model", DEFAULT_MODEL),
    apiKey: "not-needed",
  };
}

async function applyFiles(files: Array<{ path: string; proposed: string }>): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    throw new Error("No workspace folder open");
  }
  const edit = new vscode.WorkspaceEdit();
  for (const file of files) {
    const uri = vscode.Uri.joinPath(root, file.path);
    const doc = await vscode.workspace.openTextDocument(uri);
    const end = doc.positionAt(doc.getText().length);
    edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), end), file.proposed);
  }
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    throw new Error("WorkspaceEdit was not applied");
  }
}

export function createSessionHost(): { session: AgentSession; store: ReviewStore } {
  const port = createVsCodeWorkspacePort();
  let emit: (event: ExtToWebview) => void = () => undefined;
  const store = createReviewStore({
    emit: (event) => emit(event),
    readFile: (path) => port.readFile(path),
    applyFiles,
  });
  const session = createAgentSession(port, readModelConfig(), (event) => emit(event), store);
  return {
    session: {
      get busy() {
        return session.busy;
      },
      startTurn: (text) => session.startTurn(text),
      setSink(sink) {
        emit = sink;
        session.setSink(sink);
      },
    },
    store,
  };
}
```

Keep `setSink` in sync: both session (UIBridge) and store `emit` must use the latest webview sink. The wrapper above does that.

- [ ] **Step 2: Route webview messages**

`ChatViewProvider` constructor takes `{ session, store }`.

`onDidReceiveMessage`:

- `user_message` → `session.startTurn`
- `apply_diff` → `const event = await store.apply(id); postMessage(event)`
- `reject_diff` → `postMessage(store.reject(id))`
- `open_diff` → `const found = store.lookup(id, path); if ("error" in found) postMessage({ type: "error", message: found.error }); else executeCommand("vscode.diff", diskUri, proposedUri, `${found.path} (proposed)`)`

`diskUri`: `vscode.Uri.joinPath(workspaceFolders[0].uri, found.path)`.  
`proposedUri`: `vscode.Uri.from({ scheme: "palm-agent", path: "/" + found.path })`.

- [ ] **Step 3: Register content provider**

In `activate`:

```ts
const host = createSessionHost();
context.subscriptions.push(
  vscode.workspace.registerTextDocumentContentProvider("palm-agent", {
    provideTextDocumentContent(uri) {
      return host.store.proposedFor(uri.path.replace(/^\//, "")) ?? "";
    },
  }),
);
```

Pass `host.session` and `host.store` into `ChatViewProvider`.

- [ ] **Step 4: Build**

Run: `npm run build --prefix packages/extension`

Expected: esbuild + vite succeed. `createSessionHost` return type change must compile.

- [ ] **Step 5: Commit (optional, human)**

```
feat: wire review store to Keep All / vscode.diff
```

---

### Task 7: Review card webview

**Files:**
- Modify: `packages/extension/src/webview/chatMessages.ts`
- Modify: `packages/extension/src/webview/chatMessages.test.ts`
- Modify: `packages/extension/src/webview/App.tsx`
- Modify: `packages/extension/src/webview/App.css`

**Interfaces:**
- Consumes: `diff_proposed`, `diff_settled`
- Produces: `ChatLine` union + card actions

- [ ] **Step 1: Write failing reducer tests**

Replace `ChatLine` with:

```ts
export interface TextLine {
  role: "user" | "assistant" | "tool";
  text: string;
}

export interface ReviewLine {
  role: "review";
  id: string;
  files: string[];
  status: "pending" | "kept" | "undone";
}

export type ChatLine = TextLine | ReviewLine;
```

`applyExtMessage` tests to add:

```ts
it("creates and updates a review line by id", () => {
  const first = applyExtMessage([], {
    type: "diff_proposed",
    id: "rev_1",
    files: [{ path: "a.ts" }],
  });
  expect(first).toEqual([
    { role: "review", id: "rev_1", files: ["a.ts"], status: "pending" },
  ]);
  const second = applyExtMessage(first, {
    type: "diff_proposed",
    id: "rev_1",
    files: [{ path: "a.ts" }, { path: "b.ts" }],
  });
  expect(second).toHaveLength(1);
  expect(second[0]).toEqual({
    role: "review",
    id: "rev_1",
    files: ["a.ts", "b.ts"],
    status: "pending",
  });
});

it("settles a review as kept", () => {
  const pending = applyExtMessage([], {
    type: "diff_proposed",
    id: "rev_1",
    files: [{ path: "a.ts" }],
  });
  const next = applyExtMessage(pending, { type: "diff_settled", id: "rev_1", status: "kept" });
  expect(next[0]).toMatchObject({ role: "review", status: "kept" });
});
```

Narrow existing tests: they still use text lines (`next[0]?.text` is valid on text lines). For error/assistant, keep as-is.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter palm-agent exec vitest run src/webview/chatMessages.test.ts`

Expected: FAIL — `diff_proposed` ignored

- [ ] **Step 3: Implement reducer + card**

In `applyExtMessage`:

- `diff_proposed`: if a review line with `id` exists, map it to `{ ...line, files: msg.files.map(f => f.path), status: "pending" }`; else append.
- `diff_settled`: map matching id to `{ ...line, status: msg.status }`.

`App.tsx`: if `message.role === "review"`, render a card (not `<p>{message.text}</p>`):

- Header button toggles `open` local state (default open when `pending`).
- Title: `${message.files.length} file` / `files`.
- Status text when not pending: `Kept` / `Undone`.
- While `pending`: buttons **Undo All**, **Keep All**, **Review** (Review → `postMessage({ type: "open_diff", id })`).
- File buttons: while `pending`, `postMessage({ type: "open_diff", id, path })`. After settle, render path as inert text.

`roleLabel`: `review` → `Review`.

`App.css` (use VS Code vars only):

```css
.bubble.review {
  background: var(--vscode-editorWidget-background);
}

.review-head,
.review-actions,
.review-file {
  display: flex;
  gap: 8px;
  align-items: center;
}

.review-actions {
  margin-top: 8px;
  flex-wrap: wrap;
}

.review-file {
  background: none;
  border: none;
  color: var(--vscode-textLink-foreground);
  cursor: pointer;
  padding: 2px 0;
  font: inherit;
  text-align: left;
}

.review-file:disabled {
  color: inherit;
  cursor: default;
  opacity: 0.85;
}

.review-list {
  margin: 6px 0 0;
  padding-left: 16px;
}
```

Action buttons reuse `.composer button` or a `.review-actions button` clone (same vscode button colors).

- [ ] **Step 4: Run webview tests + build**

Run:

```
pnpm --filter palm-agent exec vitest run src/webview/chatMessages.test.ts
npm run build --prefix packages/extension
```

Expected: tests PASS, vite+esbuild succeed.

- [ ] **Step 5: Commit (optional, human)**

```
feat: render Keep All / Undo All / Review card
```

---

### Task 8: Verification

**Files:** none new

- [ ] **Step 1: Full unit suite**

Run from repo root (PATH must include pnpm, or use `npm run test --prefix packages/agent-core` and `npm test --prefix packages/extension`):

```
pnpm test
```

Expected: agent-core + extension tests PASS.

- [ ] **Step 2: Confirm no vscode import in agent-core**

Run: `rg "from ['\"]vscode['\"]" packages/agent-core`

Expected: no matches.

- [ ] **Step 3: Manual F5 checklist (human)**

1. Reload Extension Development Host after a successful `npm run build --prefix packages/extension` (the preLaunchTask must not fail on missing `pnpm`).
2. In a workspace with two files that both contain `getUser`, ask to rename to `fetchUser`.
3. See a `propose_edit` tool row, then one Review card with both paths.
4. Review opens `vscode.diff` for the first file; click the second path opens its diff. Nothing auto-opens on propose.
5. Keep All writes both files. Ctrl+Z undoes.
6. Repeat with a bad SEARCH: tool error, card unchanged.
7. After a proposal, edit the file by hand, Keep All → `File changed since proposal: …`, files not written.

---

## Self-review

**Spec coverage:** matcher (T2), merge (T3), propose_edit + prompt (T4), store stale/apply/reject (T5), vscode.diff + WorkspaceEdit + messages (T6), card UX (T7), done criteria (T8). Create/delete not tasked.

**Placeholders:** none.

**Types:** `ReviewHost.merge`, `ProposedFile`, `PendingReview`, `createWorkspaceTools(port, reviewHost)`, `createAgentSession(port, config, sink, reviewHost)`, `createReviewStore`, `open_diff` / `diff_settled` match the spec.
