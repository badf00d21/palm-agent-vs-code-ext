# Create File + Mkdir Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Propose new files and empty directories via the same SEARCH/REPLACE fences; Keep All writes them; existing edits stay unchanged.

**Architecture:** Classify parsed blocks (`edit` | `create` | `mkdir`). `propose_edit` still invokes internally. `WorkspacePort.exists` is read-only. Writes stay in the extension `applyFiles` / `fs.createDirectory`. The review card carries `kind` so mkdir has no diff.

**Tech Stack:** TypeScript, Vitest, VS Code `WorkspaceEdit` / `workspace.fs`

## Global Constraints

- `packages/agent-core` has zero `import 'vscode'`
- No `create_file` / `mkdir` in the Ollama tools array
- Empty SEARCH + body + path without `/` = create file
- Empty SEARCH + empty REPLACE + path ending `/` = mkdir
- Empty SEARCH + empty REPLACE without `/` = create empty file
- Target already exists → `Error: <path> already exists` (no overwrite)
- Trailing `/` + non-empty REPLACE → `Error: mkdir cannot have file content`
- Non-empty SEARCH + trailing `/` → `Error: path is a directory`
- Undo All only discards the pending review; no delete after Keep All
- `ProposedFile.kind` is `"edit" | "create" | "mkdir"`
- pnpm may be missing: run `packages/*/node_modules/.bin/vitest`
- Do not implement file/dir delete

## File map

- `packages/agent-core/src/tools/edit-blocks.ts` — `classifyEditBlock`
- `packages/agent-core/src/tools/review.ts` — `kind` on `ProposedFile`
- `packages/agent-core/src/workspace/port.ts` — `exists`
- `packages/agent-core/src/tools/tools.ts` — propose_edit + prompt
- `packages/shared/src/index.ts` — `DiffFile.kind`
- `packages/extension/src/reviewStore.ts` — stale/apply/lookup by kind
- `packages/extension/src/sessionHost.ts` — apply create/mkdir
- `packages/extension/src/workspacePort.ts` — `exists`
- `packages/extension/src/chatViewProvider.ts` — empty left side for create; no diff for mkdir
- `packages/extension/src/webview/chatMessages.ts` + `App.tsx` — `new` label; mkdir not a diff link
- Every `fakePort` / `WorkspacePort` stub gets `exists`

---

### Task 1: Classify blocks + `ProposedFile.kind`

**Files:**
- Modify: `packages/agent-core/src/tools/edit-blocks.ts`
- Modify: `packages/agent-core/src/tools/review.ts`
- Test: `packages/agent-core/test/tools/edit-blocks.test.ts`

**Produces:**
- `export type EditKind = "edit" | "create" | "mkdir"`
- `export function classifyEditBlock(block: { path: string; search: string; replace: string }): { ok: true; kind: EditKind; path: string } | { ok: false; error: string }`
- `ProposedFile.kind: EditKind` (required)

- [ ] **Step 1: Write failing tests** (append to `edit-blocks.test.ts`)

```ts
import { classifyEditBlock, parseSearchReplaceBlocks } from "../../src/tools/edit-blocks.js";

describe("classifyEditBlock", () => {
  it("classifies a non-empty search as edit", () => {
    expect(classifyEditBlock({ path: "a.ts", search: "old", replace: "new" })).toEqual({
      ok: true,
      kind: "edit",
      path: "a.ts",
    });
  });

  it("classifies empty search with a body as create", () => {
    expect(classifyEditBlock({ path: "src/foo.ts", search: "", replace: "export const x = 1;\n" })).toEqual({
      ok: true,
      kind: "create",
      path: "src/foo.ts",
    });
  });

  it("classifies empty search and replace on a trailing-slash path as mkdir", () => {
    expect(classifyEditBlock({ path: "src/components", search: "", replace: "" })).toEqual({
      ok: false,
      error: "mkdir cannot have file content",
    });
    expect(classifyEditBlock({ path: "src/components/", search: "", replace: "" })).toEqual({
      ok: true,
      kind: "mkdir",
      path: "src/components/",
    });
  });

  it("rejects a mkdir path that has a replace body", () => {
    expect(classifyEditBlock({ path: "dir/", search: "", replace: "nope" })).toEqual({
      ok: false,
      error: "mkdir cannot have file content",
    });
  });

  it("rejects a non-empty search on a directory path", () => {
    expect(classifyEditBlock({ path: "dir/", search: "x", replace: "y" })).toEqual({
      ok: false,
      error: "path is a directory",
    });
  });
});
```

Note: empty search + empty replace **without** `/` is create (empty file), not an error. Add:

```ts
  it("classifies empty search and replace without a slash as create", () => {
    expect(classifyEditBlock({ path: "empty.txt", search: "", replace: "" })).toEqual({
      ok: true,
      kind: "create",
      path: "empty.txt",
    });
  });
```

The first mkdir test above must **not** treat `src/components` as mkdir. Fix the test: only the `src/components` + empty+empty case is create (no slash). Remove the incorrect `ok: false` expectation for `src/components`.

Correct mkdir pair:

```ts
  it("does not treat a slashless empty block as mkdir", () => {
    expect(classifyEditBlock({ path: "src/components", search: "", replace: "" })).toEqual({
      ok: true,
      kind: "create",
      path: "src/components",
    });
  });
```

- [ ] **Step 2: Run tests — expect FAIL** (`classifyEditBlock` missing)

Run: `packages/agent-core/node_modules/.bin/vitest run test/tools/edit-blocks.test.ts`

- [ ] **Step 3: Implement**

```ts
export type EditKind = "edit" | "create" | "mkdir";

export function classifyEditBlock(block: {
  path: string;
  search: string;
  replace: string;
}): { ok: true; kind: EditKind; path: string } | { ok: false; error: string } {
  const raw = block.path.trim();
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
```

Add `kind: EditKind` to `ProposedFile` in `review.ts`. Existing test merges that omit `kind` will fail typecheck — default in those tests to `kind: "edit"` in Task 3/4, or make `kind` optional with merge default `"edit"`. **Lock: `kind` required; update call sites in later tasks.** For this task only change the type and add `kind: "edit"` to `review.test.ts` fixtures.

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Commit** `feat: classify create and mkdir edit blocks`

---

### Task 2: `WorkspacePort.exists`

**Files:**
- Modify: `packages/agent-core/src/workspace/port.ts`
- Modify: `packages/extension/src/workspacePort.ts`
- Modify every `WorkspacePort` literal: `test/tools/tools.test.ts`, `test/session/session.test.ts`, `test/workspace/locate.test.ts` (and any other stub)

**Produces:** `exists(path: string): Promise<"file" | "dir" | "absent">`  
Strip trailing `/` before stat.

- [ ] **Step 1: Failing test** in `packages/agent-core/test/workspace/port-exists.test.ts` is optional if you test via propose_edit in Task 3. Prefer a small vscode-free unit: a fake port in tools tests. Skip a dedicated file — Task 3 covers behavior. This task only adds the method so the typechecker fails until stubs compile.

- [ ] **Step 2: Add to the interface**

```ts
  /** Workspace-relative POSIX path. Trailing slashes ignored. */
  exists(path: string): Promise<"file" | "dir" | "absent">;
```

- [ ] **Step 3: Default fake**

```ts
exists: async () => "absent" as const,
```

in every stub, then `...overrides`.

- [ ] **Step 4: VS Code impl**

```ts
async exists(input: string) {
  const root = workspaceRoot();
  if (!root) {
    throw new Error("No workspace folder open");
  }
  const rel = input.replace(/\/+$/, "");
  const abs = resolveWorkspacePath(root, rel);
  try {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(abs));
    return stat.type === vscode.FileType.Directory ? "dir" : "file";
  } catch {
    return "absent";
  }
},
```

- [ ] **Step 5: `tsc` / existing tests still pass**

Run: `packages/agent-core/node_modules/.bin/vitest run` and `packages/extension/node_modules/.bin/vitest run`

- [ ] **Step 6: Commit** `feat: add WorkspacePort.exists`

---

### Task 3: `propose_edit` create/mkdir + prompt

**Files:**
- Modify: `packages/agent-core/src/tools/tools.ts`
- Test: `packages/agent-core/test/tools/tools.test.ts`

**Consumes:** `classifyEditBlock`, `port.exists`  
**Produces:** merge of `{ path, original: "", proposed, kind: "create" | "mkdir" }` or existing edit path

Change validation: require `path.trim()` only (empty `search` allowed). Reject `search === replace` **only** when `kind === "edit"`.

For each block, `classifyEditBlock`. On `{ ok: false }` return `Error: ${error}`.

Group by classified `path`. A path may not mix kinds. More than one create/mkdir block per path: last wins (same as merge).

- `edit`: current `locateWorkspaceFile` + `applySearchReplace` loop; `kind: "edit"`
- `create` / `mkdir`: if `await port.exists(path) !== "absent"` return `Error: ${path} already exists`. Do **not** call `locateWorkspaceFile`. Push `{ path, original: "", proposed: kind === "mkdir" ? "" : block.replace, kind }`

- [ ] **Step 1: Failing tests** (append in `tools.test.ts`)

```ts
  it("proposes a create when search is empty and the path is absent", async () => {
    const merged: unknown[] = [];
    const invoke = getInvoke(
      "propose_edit",
      fakePort({ exists: async () => "absent" }),
      fakeHost({ merge: (files) => { merged.push(...files); return { id: "rev_1", paths: files.map((f) => f.path) }; } }),
    );
    const out = await invoke({
      files: [{ path: "src/foo.ts", search: "", replace: "export const foo = 1;\n" }],
    });
    expect(out).toBe("Proposed review rev_1: src/foo.ts");
    expect(merged).toEqual([
      { path: "src/foo.ts", original: "", proposed: "export const foo = 1;\n", kind: "create" },
    ]);
  });

  it("proposes mkdir for a trailing-slash empty block", async () => {
    const merged: unknown[] = [];
    const invoke = getInvoke(
      "propose_edit",
      fakePort({ exists: async () => "absent" }),
      fakeHost({ merge: (files) => { merged.push(...files); return { id: "rev_1", paths: files.map((f) => f.path) }; } }),
    );
    const out = await invoke({ files: [{ path: "src/components/", search: "", replace: "" }] });
    expect(out).toBe("Proposed review rev_1: src/components/");
    expect(merged).toEqual([
      { path: "src/components/", original: "", proposed: "", kind: "mkdir" },
    ]);
  });

  it("rejects empty search when the file already exists", async () => {
    const invoke = getInvoke("propose_edit", fakePort({ exists: async () => "file" }));
    expect(await invoke({ files: [{ path: "a.ts", search: "", replace: "x" }] })).toBe(
      "Error: a.ts already exists",
    );
  });

  it("rejects mkdir when the directory already exists", async () => {
    const invoke = getInvoke("propose_edit", fakePort({ exists: async () => "dir" }));
    expect(await invoke({ files: [{ path: "src/", search: "", replace: "" }] })).toBe(
      "Error: src/ already exists",
    );
  });

  it("rejects mkdir with a replace body", async () => {
    const invoke = getInvoke("propose_edit", fakePort());
    expect(await invoke({ files: [{ path: "dir/", search: "", replace: "x" }] })).toBe(
      "Error: mkdir cannot have file content",
    );
  });
```

Existing test `rejects empty files` / `requires path and search`: empty `files` still errors. A row with empty path still errors. Do **not** keep `Error: propose_edit requires path and search` for empty search on a valid create — only when every row lacks a path, or `files` is empty. Exact remaining copy: `Error: propose_edit requires path and search` if `blocks.length === 0 || blocks.some((b) => !b.path.trim())`.

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement invoke + two prompt sentences**

Append to `SYSTEM_PROMPT` (do not remove fence instructions):

`A new file is an empty SEARCH and the file body as REPLACE. A new empty directory is a path ending with / and both SEARCH and REPLACE empty. Never overwrite: if the path exists, read it and use a real SEARCH.`

- [ ] **Step 4: Tests pass** (all `tools.test.ts` including old propose_edit)

- [ ] **Step 5: Commit** `feat: propose create file and mkdir`

---

### Task 4: Review store + protocol `kind`

**Files:**
- Modify: `packages/shared/src/index.ts` — `DiffFile` gains `kind: "edit" | "create" | "mkdir"`
- Modify: `packages/extension/src/reviewStore.ts`
- Modify: `packages/extension/src/reviewStore.test.ts`
- Modify: `packages/extension/src/webview/chatMessages.ts` — keep `files` as `{ path, kind }[]` on `ReviewLine`
- Modify: `packages/extension/src/webview/chatMessages.test.ts`

**Produces:**
- `applyFiles: (files: Array<{ path: string; proposed: string; kind: EditKind }>) => Promise<void>`
- `lookup` returns `{ path, proposed, kind }` or `{ error }`
- mkdir lookup: `{ error: "Directory has no diff" }`
- `diff_proposed.files` includes `kind`
- apply stale: for `create`/`mkdir`, if `exists` is not `absent` → `File changed since proposal: <path>` (do not `readFile`)
- apply edit: unchanged `readFile` / dirty buffer checks
- reject: still no `applyFiles` call

Add `exists` to `ReviewStoreDeps`:

```ts
exists: (path: string) => Promise<"file" | "dir" | "absent">;
```

- [ ] **Step 1: Failing tests** in `reviewStore.test.ts`

Every existing `merge([{ path, original, proposed }])` must add `kind: "edit"`.  
`diff_proposed` files become `{ path: "a.ts", kind: "edit" }`.

New:

```ts
  it("passes create kind to applyFiles and skips readFile stale", async () => {
    const applied: unknown[] = [];
    const store = createReviewStore({
      emit: () => undefined,
      readFile: async () => {
        throw new Error("should not read a missing create target");
      },
      exists: async () => "absent",
      applyFiles: async (files) => {
        applied.push(...files);
      },
      createId: () => "rev_1",
    });
    store.merge([{ path: "n.ts", original: "", proposed: "hi\n", kind: "create" }]);
    expect(await store.apply("rev_1")).toEqual({ type: "diff_settled", id: "rev_1", status: "kept" });
    expect(applied).toEqual([{ path: "n.ts", proposed: "hi\n", kind: "create" }]);
  });

  it("does not apply create if the path appeared on disk", async () => {
    let wrote = false;
    const store = createReviewStore({
      emit: () => undefined,
      readFile: async () => "nope",
      exists: async () => "file",
      applyFiles: async () => {
        wrote = true;
      },
      createId: () => "rev_1",
    });
    store.merge([{ path: "n.ts", original: "", proposed: "hi\n", kind: "create" }]);
    expect(await store.apply("rev_1")).toEqual({
      type: "error",
      message: "File changed since proposal: n.ts",
    });
    expect(wrote).toBe(false);
  });

  it("lookup rejects mkdir paths", () => {
    const store = createReviewStore({
      emit: () => undefined,
      readFile: async () => "",
      exists: async () => "absent",
      applyFiles: async () => undefined,
      createId: () => "rev_1",
    });
    store.merge([{ path: "d/", original: "", proposed: "", kind: "mkdir" }]);
    expect(store.lookup("rev_1", "d/")).toEqual({ error: "Directory has no diff" });
  });

  it("does not call applyFiles on reject", () => {
    let wrote = false;
    const store = createReviewStore({
      emit: () => undefined,
      readFile: async () => "a",
      exists: async () => "file",
      applyFiles: async () => {
        wrote = true;
      },
      createId: () => "rev_1",
    });
    store.merge([{ path: "a.ts", original: "a", proposed: "b", kind: "edit" }]);
    store.reject("rev_1");
    expect(wrote).toBe(false);
  });
```

Existing tests need `exists: async () => "file"` for edits (or `"absent"` is wrong — edit stale uses `readFile`, not exists). For edit apply, `exists` unused. Provide `exists: async () => "file"`.

- [ ] **Step 2: Run extension tests — FAIL**

- [ ] **Step 3: Implement store + `DiffFile` + `ReviewLine.files`**

`chatMessages`: `ReviewLine.files: Array<{ path: string; kind: "edit" | "create" | "mkdir" }>`  
`applyExtMessage` copies `msg.files` as-is (already `{ path, kind }`).

Update `chatMessages.test.ts` diffs to include `kind: "edit"`.

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Commit** `feat: review create and mkdir kinds`

---

### Task 5: Apply + diff + card

**Files:**
- Modify: `packages/extension/src/sessionHost.ts` — `applyFiles` by kind; pass `exists` into the store
- Modify: `packages/extension/src/chatViewProvider.ts` — `open_diff`
- Modify: `packages/extension/src/webview/App.tsx` — label `new`; mkdir path is not a button
- Test: no VS Code UI test. Cover card mapping in `chatMessages` if not already. Manual F5 in done criteria.

**applyFiles:**

```ts
async function applyFiles(
  files: Array<{ path: string; proposed: string; kind: "edit" | "create" | "mkdir" }>,
): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    throw new Error("No workspace folder open");
  }
  const edit = new vscode.WorkspaceEdit();
  const mkdirs: string[] = [];
  for (const file of files) {
    if (file.kind === "mkdir") {
      mkdirs.push(file.path.replace(/\/+$/, ""));
      continue;
    }
    const uri = vscode.Uri.joinPath(root, file.path);
    if (file.kind === "create") {
      edit.createFile(uri, { ignoreIfExists: false });
      edit.insert(uri, new vscode.Position(0, 0), file.proposed);
      continue;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const end = doc.positionAt(doc.getText().length);
    edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), end), file.proposed);
  }
  if (edit.size > 0) {
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      throw new Error("WorkspaceEdit was not applied");
    }
  }
  for (const rel of mkdirs) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, rel));
  }
}
```

`WorkspaceEdit.size` may not exist — if the API has no `.size`, apply only when there is at least one create/edit, else skip `applyEdit`. Use a boolean `hasEdit`.

**open_diff:** if lookup error, post it (mkdir). If `kind === "create"`, left URI = `vscode.Uri.from({ scheme: "palm-agent", path: "/.empty" })` (provider returns `""` because `proposedFor` misses). Right URI unchanged. Title: `${path} (proposed)`.

**App.tsx ReviewCard:**  
- create: show `new` next to path; path still opens diff  
- mkdir: `<span>{path}</span>` even when pending (no `open_diff`)  
- header Review button: if **all** files are mkdir, hide Review; if mix, Review opens first **non-mkdir** (lookup without path should skip mkdir — implement `lookup()` to return first file with `kind !== "mkdir"`, or error if none)

- [ ] **Step 1:** `lookup()` without path skips mkdir (unit test in reviewStore)

```ts
  it("lookup without path skips mkdir", () => {
    const store = createReviewStore({ /* ... */ createId: () => "rev_1" });
    store.merge([
      { path: "d/", original: "", proposed: "", kind: "mkdir" },
      { path: "a.ts", original: "", proposed: "x", kind: "create" },
    ]);
    expect(store.lookup("rev_1")).toEqual({ path: "a.ts", proposed: "x", kind: "create" });
  });
```

- [ ] **Step 2: Implement apply + open_diff + card**

- [ ] **Step 3: Run**  
`packages/agent-core/node_modules/.bin/vitest run`  
`packages/extension/node_modules/.bin/vitest run`

- [ ] **Step 4: Commit** `feat: apply create file and mkdir`

- [ ] **Step 5: Manual F5** (human): create `src/foo/bar.ts`; mkdir `src/components/`; empty SEARCH on an existing file must error.

---

## Spec coverage

| Spec | Task |
|---|---|
| classify table | 1 |
| `exists` / already exists | 2–3 |
| propose_edit create/mkdir | 3 |
| prompt | 3 |
| review stale/apply/lookup | 4 |
| Keep All write + card + diff | 5 |
| No delete / no overwrite | all |
| Undo All no apply | 4 |

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-30-create-file-mkdir.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks

**2. Inline Execution** — this session, executing-plans, checkpoints

Which approach?
