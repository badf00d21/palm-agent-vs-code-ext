# Hygiene Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split three oversized production modules into focused files without changing runtime behavior.

**Architecture:** Move parse helpers next to the completion runner (re-export so old imports keep working). Move `propose_edit` invoke next to other tools. Move `ReviewCard` next to other webview components. Tests stay; one `fakeEnv()` helper.

**Tech Stack:** TypeScript, Vitest, React (webview)

## Global Constraints

- `packages/agent-core` has zero `import 'vscode'`
- No new npm packages; Vitest stays
- `kind` branching stays `if` / `classifyEditBlock`, not a class hierarchy
- `deliverCompletion` stays in `local-inference.ts`
- Native `tool_calls` → `parseToolCallsFromContent` → SEARCH/REPLACE fences as `propose_edit` (order unchanged)
- Existing test asserts unchanged; `parseToolCallsFromContent` still importable from `local-inference.js`
- pnpm may be missing: run `packages/*/node_modules/.bin/vitest`
- PowerShell: `;` not `&&`
- Do not rewrite `local-inference.test.ts` cases except `fakeEnv()`
- Do not change SEARCH/REPLACE, Keep All, or CSS class names

## File map

- Create: `packages/agent-core/src/model/completion-parse.ts` — JSON/fence-adjacent tool-call parse
- Modify: `packages/agent-core/src/model/local-inference.ts` — re-export parse; keep `deliverCompletion` + HTTP
- Modify: `packages/agent-core/src/model/chat-stream.ts` — may keep importing parse from `local-inference.js`
- Create: `packages/agent-core/src/tools/propose-edit.ts` — `invokeProposeEdit` + `searchLooksLikeRegex`
- Modify: `packages/agent-core/src/tools/tools.ts` — tool list; `propose_edit.invoke` delegates
- Create: `packages/agent-core/test/model/completion-parse.test.ts` — one smoke import from the new module
- Modify: `packages/agent-core/test/model/local-inference.test.ts` — `fakeEnv()` only in Task 3
- Create: `packages/extension/src/webview/ReviewCard.tsx`
- Modify: `packages/extension/src/webview/App.tsx` — import `ReviewCard`

---

### Task 1: `completion-parse.ts`

**Files:**
- Create: `packages/agent-core/src/model/completion-parse.ts`
- Modify: `packages/agent-core/src/model/local-inference.ts`
- Test: `packages/agent-core/test/model/completion-parse.test.ts`

**Produces:**
- `export interface ChatToolCall { id?: string; function?: { name?: string; arguments?: unknown } }`
- `export function parseToolCallsFromContent(text: string): ChatToolCall[]`
- `local-inference.ts` re-exports `parseToolCallsFromContent` (and `ChatToolCall` if needed)

**Consumes:** `jsonc-parser` `parse as parseJsonc`; no `vscode`

- [ ] **Step 1: Write failing smoke test**

Create `packages/agent-core/test/model/completion-parse.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseToolCallsFromContent } from "../../src/model/completion-parse.js";

describe("completion-parse module", () => {
  it("parses a name+arguments object from the new module path", () => {
    const calls = parseToolCallsFromContent('{"name": "get_context", "arguments": {}}');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.function?.name).toBe("get_context");
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`completion-parse.js` missing)

Run: `packages/agent-core/node_modules/.bin/vitest run test/model/completion-parse.test.ts`

Expected: FAIL (cannot resolve module)

- [ ] **Step 3: Implement** — move these functions **verbatim** from `local-inference.ts` (currently private helpers + export). `jsonc-parser` import moves here. Do not move `toolCallArgs` (still used by `deliverCompletion`).

```ts
import { parse as parseJsonc } from "jsonc-parser";

export interface ChatToolCall {
  id?: string;
  function?: { name?: string; arguments?: unknown };
}

function asToolCallObject(value: unknown): ChatToolCall | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const rec = value as Record<string, unknown>;
  const nested =
    rec.function && typeof rec.function === "object"
      ? (rec.function as Record<string, unknown>)
      : undefined;
  const name =
    (typeof nested?.name === "string" && nested.name) ||
    (typeof rec.name === "string" && rec.name) ||
    (typeof rec.function === "string" && rec.function) ||
    (typeof rec.tool === "string" && rec.tool) ||
    "";
  const args = nested?.arguments ?? rec.arguments ?? rec.args ?? rec.parameters;
  const hasArgs =
    nested !== undefined
      ? "arguments" in nested || "args" in nested
      : "arguments" in rec || "args" in rec || "parameters" in rec;
  if (!name || !hasArgs) {
    return null;
  }
  return { id: typeof rec.id === "string" ? rec.id : undefined, function: { name, arguments: args } };
}

function jsonValuesFrom(text: string): unknown[] {
  const values: unknown[] = [];
  const consider = (slice: string) => {
    const value = parseJsonc(slice);
    if (value !== undefined) {
      values.push(value);
    }
  };
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    consider(trimmed);
  }
  for (const fence of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    consider((fence[1] ?? "").trim());
  }
  const keyRe = /"(?:name|function|tool)"\s*:/g;
  let match: RegExpExecArray | null;
  let attempts = 0;
  while ((match = keyRe.exec(text)) !== null && attempts < 16) {
    const fromBrace = text.lastIndexOf("{", match.index);
    const fromBracket = text.lastIndexOf("[", match.index);
    const start = Math.max(fromBrace, fromBracket);
    if (start >= 0) {
      consider(text.slice(start));
      attempts += 1;
    }
  }
  return values;
}

function toolCallsFromValue(parsed: unknown): ChatToolCall[] {
  if (Array.isArray(parsed)) {
    return parsed.map(asToolCallObject).filter((call): call is ChatToolCall => call !== null);
  }
  const one = asToolCallObject(parsed);
  return one ? [one] : [];
}

/** Qwen/Ollama often emit a tool call as JSON in `message.content` instead of `tool_calls`. */
export function parseToolCallsFromContent(text: string): ChatToolCall[] {
  if (!text.trim()) {
    return [];
  }
  for (const parsed of jsonValuesFrom(text)) {
    const calls = toolCallsFromValue(parsed);
    if (calls.length > 0) {
      return calls;
    }
  }
  return [];
}
```

In `local-inference.ts`:
- Remove the moved functions and `jsonc-parser` import (if unused).
- Keep local `interface ChatToolCall` **or** import `{ parseToolCallsFromContent, type ChatToolCall }` from `./completion-parse.js` and delete the duplicate interface.
- Add: `export { parseToolCallsFromContent } from "./completion-parse.js";` so `chat-stream.ts` and `local-inference.test.ts` keep `from "./local-inference.js"` / `from "../../src/model/local-inference.js"`.
- `deliverCompletion` still calls `parseToolCallsFromContent(message.content ?? "")` with the same native → content JSON → fence order.

- [ ] **Step 4: Tests pass**

Run: `packages/agent-core/node_modules/.bin/vitest run test/model/completion-parse.test.ts test/model/local-inference.test.ts test/model/chat-stream.test.ts`

Expected: PASS. Existing `parseToolCallsFromContent` describe in `local-inference.test.ts` still imports from `local-inference.js`.

- [ ] **Step 5: Commit** `refactor: extract completion-parse from local-inference`

---

### Task 2: `propose-edit.ts`

**Files:**
- Create: `packages/agent-core/src/tools/propose-edit.ts`
- Modify: `packages/agent-core/src/tools/tools.ts`

**Consumes:** `classifyEditBlock`, `EditKind`, `locateWorkspaceFile`, `applySearchReplace`, `exactFunctionInFile`, `functionNameFromSearch`, `WorkspacePort`, `ReviewHost`, `ProposedFile`

**Produces:**
- `export type ProposeEditBlock = { path: string; search: string; replace: string }`
- `export function searchLooksLikeRegex(search: string): boolean`
- `export async function invokeProposeEdit(args: Record<string, unknown>, port: WorkspacePort, reviewHost: ReviewHost): Promise<string>`

`tools.test.ts` stays on `createWorkspaceTools` + `getInvoke("propose_edit", …)` — **do not change asserts**.

- [ ] **Step 1: Failing import (TDD for the new module)**

Temporarily add at the top of `packages/agent-core/test/tools/tools.test.ts` (remove after Step 3 if unused):

```ts
import { invokeProposeEdit } from "../../src/tools/propose-edit.js";
```

and one line in an existing describe (or a tiny `it`) that references it so the file typechecks:

```ts
  it("loads invokeProposeEdit from propose-edit", () => {
    expect(typeof invokeProposeEdit).toBe("function");
  });
```

This is the only new tools test. Do not change existing propose_edit expects.

- [ ] **Step 2: Run — expect FAIL**

Run: `packages/agent-core/node_modules/.bin/vitest run test/tools/tools.test.ts`

Expected: FAIL (cannot resolve `propose-edit.js`)

- [ ] **Step 3: Implement** — move `searchLooksLikeRegex` and the current `propose_edit` `invoke` body into `invokeProposeEdit`. Named types as specified.

```ts
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
  if (blocks.length === 0 || blocks.some((b) => !b.path.trim())) {
    return "Error: propose_edit requires path and search";
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
```

In `tools.ts`: remove `searchLooksLikeRegex` and the invoke body. `propose_edit` entry:

```ts
invoke: async (args) => invokeProposeEdit(args, port, reviewHost),
```

Import `invokeProposeEdit` from `./propose-edit.js`. Drop unused imports that only served the old invoke (`classifyEditBlock`, `locateWorkspaceFile`, `applySearchReplace`, `named-function`, `ProposedFile` if unused). Keep `SYSTEM_PROMPT`, `toolsVisibleToModel`, read/list/search/context tools.

- [ ] **Step 4: Tests pass**

Run: `packages/agent-core/node_modules/.bin/vitest run test/tools/tools.test.ts`

Expected: PASS including the new typeof test and all old propose_edit cases.

- [ ] **Step 5: Commit** `refactor: extract invokeProposeEdit`

---

### Task 3: `fakeEnv()` in inference tests

**Files:**
- Modify: `packages/agent-core/test/model/local-inference.test.ts`

**Produces:** one helper; 19 `as unknown as AgenticEnvironment` stubs become `fakeEnv({ … })`.

- [ ] **Step 1: Add helper after `sseResponse`**

```ts
function fakeEnv(
  overrides: {
    deliverSemanticEvent?: AgenticEnvironment["deliverSemanticEvent"];
    deliverModelMessage?: AgenticEnvironment["deliverModelMessage"];
    deliverFunctionCall?: AgenticEnvironment["deliverFunctionCall"];
  } = {},
): AgenticEnvironment {
  return {
    deliverSemanticEvent: () => undefined,
    deliverModelMessage: () => undefined,
    deliverFunctionCall: () => {
      throw new Error("unexpected function call");
    },
    ...overrides,
  } as unknown as AgenticEnvironment;
}
```

Default `deliverFunctionCall` throws `"unexpected function call"` — same as most current stubs. Tests that throw `"should not deliver"` on `deliverModelMessage` pass that override. Tests that collect `deliverFunctionCall` items pass a collecting override (do not throw).

Example replacement for the first `runLocalChatCompletions` test:

```ts
    const delivered: ModelMessageItem[] = [];
    const environment = fakeEnv({
      deliverModelMessage: (_caller: unknown, item: ModelMessageItem) => {
        delivered.push(item);
      },
    });
```

Example for a test that must not deliver a model message:

```ts
    const environment = fakeEnv({
      deliverModelMessage: () => {
        throw new Error("should not deliver");
      },
      deliverFunctionCall: () => {
        throw new Error("should not deliver");
      },
    });
```

Replace every remaining inline `as unknown as AgenticEnvironment` object in this file the same way. Do not change `fetchImpl`, expects, or describe titles.

- [ ] **Step 2: Run**

Run: `packages/agent-core/node_modules/.bin/vitest run test/model/local-inference.test.ts`

Expected: PASS, same number of `it`s as before this task (plus Task 1 smoke file is separate).

- [ ] **Step 3: Commit** `test: share fakeEnv in local-inference tests`

---

### Task 4: `ReviewCard.tsx`

**Files:**
- Create: `packages/extension/src/webview/ReviewCard.tsx`
- Modify: `packages/extension/src/webview/App.tsx`

**Produces:**
- `export interface ReviewCardProps { message: ReviewLine; postMessage: (msg: WebviewToExt) => void }`
- `export function ReviewCard(props: ReviewCardProps): JSX`

CSS: do not move rules; classes stay `review-head`, `review-file`, `review-kind`, etc. in `App.css`.

No new webview unit test (spec). Extension vitest still compiles.

- [ ] **Step 1: Create `ReviewCard.tsx` with the current `ReviewCard` function from `App.tsx` (verbatim UI)**

```tsx
import { useState } from "react";
import type { WebviewToExt } from "@palm-agent/shared";
import type { ReviewLine } from "./chatMessages";

export interface ReviewCardProps {
  message: ReviewLine;
  postMessage: (msg: WebviewToExt) => void;
}

export function ReviewCard({ message, postMessage }: ReviewCardProps) {
  const [open, setOpen] = useState(message.status === "pending");
  const pending = message.status === "pending";
  const fileLabel = `${message.files.length} file${message.files.length === 1 ? "" : "s"}`;
  const statusText =
    message.status === "kept" ? "Kept" : message.status === "undone" ? "Undone" : undefined;
  const filesId = `review-files-${message.id}`;
  const hasReviewable = message.files.some((file) => file.kind !== "mkdir");

  return (
    <>
      <div className="review-head">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? filesId : undefined}
          aria-label={statusText ? `${fileLabel}, ${statusText}` : `${fileLabel}, pending review`}
          onClick={() => setOpen((value) => !value)}
        >
          {fileLabel}
        </button>
        {statusText ? <span className="review-status">{statusText}</span> : null}
      </div>
      {open ? (
        <div id={filesId}>
          <ul className="review-list">
            {message.files.map((file) => (
              <li key={file.path}>
                {pending && file.kind !== "mkdir" ? (
                  <button
                    type="button"
                    className="review-file"
                    onClick={() => postMessage({ type: "open_diff", id: message.id, path: file.path })}
                  >
                    {file.path}
                    {file.kind === "create" ? <span className="review-kind"> new</span> : null}
                  </button>
                ) : (
                  <span className={pending ? undefined : "review-file-static"}>
                    {file.path}
                    {file.kind === "create" ? <span className="review-kind"> new</span> : null}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {pending ? (
            <div className="review-actions">
              <button type="button" onClick={() => postMessage({ type: "reject_diff", id: message.id })}>
                Undo All
              </button>
              <button type="button" onClick={() => postMessage({ type: "apply_diff", id: message.id })}>
                Keep All
              </button>
              {hasReviewable ? (
                <button type="button" onClick={() => postMessage({ type: "open_diff", id: message.id })}>
                  Review
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
```

- [ ] **Step 2: `App.tsx`** — delete the local `ReviewCard` function; add `import { ReviewCard } from "./ReviewCard";`. Usage site unchanged: `<ReviewCard message={message} postMessage={postMessage} />`.

- [ ] **Step 3: Run**

Run: `packages/agent-core/node_modules/.bin/vitest run`  
then: `packages/extension/node_modules/.bin/vitest run`

Expected: all tests PASS. `chatMessages.test.ts` unchanged.

- [ ] **Step 4: Commit** `refactor: extract ReviewCard from App`

---

## Spec coverage

| Spec | Task |
|---|---|
| `completion-parse.ts` + re-export | 1 |
| `deliverCompletion` stays in `local-inference.ts` | 1 |
| `propose-edit.ts` + tools delegate | 2 |
| `ProposeEditBlock` / group types | 2 |
| `fakeEnv()` | 3 |
| `ReviewCard.tsx` + `ReviewCardProps` | 4 |
| No vscode in agent-core | 1–2 |
| Vitest 1:1 asserts (plus 1 smoke + 1 typeof) | 1–4 |
| No new libraries | all |

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-31-hygiene-split.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks

**2. Inline Execution** — this session, executing-plans, checkpoints

Which approach?
