# Collapsible Review Dock + Status Orb Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the pending-review dock collapsible with a always-visible summary count, replace the three-dot waiting indicator with a Uiverse status orb that stays idle without hue-shifting, and remove the Add selection button and its protocol.

**Architecture:** Pure `reviewDockSummary` in `chatMessages.ts`. `App.tsx` owns dock `expanded` state (open on first pending in the webview session, then remember). New `StatusOrb` component + CSS ported from Uiverse MIT loader; busy class toggles `colorize`. Protocol cleanup removes `get_selection` / `selection` from shared + host + webview.

**Tech Stack:** React webview, TypeScript, Vitest, existing VS Code theme CSS variables

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-06-review-dock-status-orb-design.md`
- No `agent-core` changes
- Summary label English with middle dot `·`: `1 review · 1 file` / `2 reviews · 5 files`
- Count only **pending** reviews (and their files) for the summary
- Dock visible only while there is at least one pending review; expanded body may still list all `dockedReviews` order (pending first) when open — prefer showing only pending cards in the body to match the summary (settled cards leave the dock when no longer pending-only UI). **Implement:** body maps `reviews.filter(r => r.status === "pending")` OR keep current `dockedReviews` which already puts pending first — if any non-pending remain in `dockedReviews` while a pending exists, showing them is OK and matches today’s dock. Simplest: keep `const reviews = dockedReviews(messages)` and gate dock with `reviews.some(r => r.status === "pending")`; summary counts only pending.
- Orb `--size: 0.22`; mask id `status-orb-clip`
- Idle: no `colorize`; busy: `colorize` + existing waiting copy
- Keep `WorkspacePort.getContext().selection` for agent `get_context`
- Attribution comment for Uiverse MIT in CSS
- `prefers-reduced-motion: reduce` disables orb animations
- Run tests via `corepack pnpm --filter @palm-agent/extension exec vitest run …` (or package-local vitest)

## File map

- `packages/extension/src/webview/chatMessages.ts` — `reviewDockSummary`
- `packages/extension/src/webview/chatMessages.test.ts` — summary tests
- `packages/extension/src/webview/StatusOrb.tsx` — orb markup
- `packages/extension/src/webview/App.css` — orb + dock summary styles; remove waiting-dots
- `packages/extension/src/webview/App.tsx` — collapse dock, StatusOrb, remove Add selection
- `packages/extension/src/chatViewProvider.ts` — remove `get_selection` case
- `packages/shared/src/index.ts` — remove `get_selection` / `selection` message types

---

### Task 1: `reviewDockSummary`

**Files:**
- Modify: `packages/extension/src/webview/chatMessages.ts`
- Test: `packages/extension/src/webview/chatMessages.test.ts`

**Interfaces:**
- Consumes: `ReviewLine` from same module
- Produces:
  ```ts
  export function reviewDockSummary(reviews: ReviewLine[]): {
    reviewCount: number;
    fileCount: number;
    label: string;
  }
  ```
  Counts only `status === "pending"`. Empty / no pending → `{ reviewCount: 0, fileCount: 0, label: "" }`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/extension/src/webview/chatMessages.test.ts` (import `reviewDockSummary`):

```ts
describe("reviewDockSummary", () => {
  it("formats one pending review and one file", () => {
    expect(
      reviewDockSummary([
        {
          role: "review",
          id: "r1",
          files: [{ path: "a.ts", kind: "edit" }],
          status: "pending",
        },
      ]),
    ).toEqual({ reviewCount: 1, fileCount: 1, label: "1 review · 1 file" });
  });

  it("sums files across pending reviews and ignores settled", () => {
    expect(
      reviewDockSummary([
        {
          role: "review",
          id: "r1",
          files: [
            { path: "a.ts", kind: "edit" },
            { path: "b.ts", kind: "create" },
          ],
          status: "pending",
        },
        {
          role: "review",
          id: "r2",
          files: [
            { path: "c.ts", kind: "edit" },
            { path: "d.ts", kind: "edit" },
            { path: "e.ts", kind: "mkdir" },
          ],
          status: "pending",
        },
        {
          role: "review",
          id: "old",
          files: [{ path: "z.ts", kind: "edit" }],
          status: "kept",
        },
      ]),
    ).toEqual({ reviewCount: 2, fileCount: 5, label: "2 reviews · 5 files" });
  });

  it("returns empty label when there are no pending reviews", () => {
    expect(reviewDockSummary([])).toEqual({
      reviewCount: 0,
      fileCount: 0,
      label: "",
    });
    expect(
      reviewDockSummary([
        {
          role: "review",
          id: "old",
          files: [{ path: "z.ts", kind: "edit" }],
          status: "kept",
        },
      ]),
    ).toEqual({ reviewCount: 0, fileCount: 0, label: "" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `corepack pnpm --filter @palm-agent/extension exec vitest run src/webview/chatMessages.test.ts -t reviewDockSummary`

Expected: FAIL — `reviewDockSummary` is not exported / not defined.

- [ ] **Step 3: Implement**

In `packages/extension/src/webview/chatMessages.ts`, after `dockedReviews`:

```ts
export function reviewDockSummary(reviews: ReviewLine[]): {
  reviewCount: number;
  fileCount: number;
  label: string;
} {
  const pending = reviews.filter((review) => review.status === "pending");
  const reviewCount = pending.length;
  const fileCount = pending.reduce((sum, review) => sum + review.files.length, 0);
  if (reviewCount === 0) {
    return { reviewCount: 0, fileCount: 0, label: "" };
  }
  const reviewWord = reviewCount === 1 ? "review" : "reviews";
  const fileWord = fileCount === 1 ? "file" : "files";
  return {
    reviewCount,
    fileCount,
    label: `${reviewCount} ${reviewWord} · ${fileCount} ${fileWord}`,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `corepack pnpm --filter @palm-agent/extension exec vitest run src/webview/chatMessages.test.ts -t reviewDockSummary`

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/webview/chatMessages.ts packages/extension/src/webview/chatMessages.test.ts
git commit -m "$(cat <<'EOF'
Add reviewDockSummary for collapsible review dock labels.

EOF
)"
```

---

### Task 2: `StatusOrb` + CSS

**Files:**
- Create: `packages/extension/src/webview/StatusOrb.tsx`
- Modify: `packages/extension/src/webview/App.css` (orb styles; leave wiring to Task 3)

**Interfaces:**
- Consumes: nothing
- Produces: `export function StatusOrb({ busy }: { busy: boolean }): JSX.Element`

- [ ] **Step 1: Create `StatusOrb.tsx`**

```tsx
/** Uiverse loader (andrew-manzyk/young-walrus-64), MIT — busy toggles hue animation via CSS. */
export function StatusOrb({ busy }: { busy: boolean }) {
  return (
    <div
      className={`status-orb${busy ? " is-busy" : ""}`}
      aria-hidden="true"
    >
      <svg width="100" height="100" viewBox="0 0 100 100">
        <defs>
          <mask id="status-orb-clip">
            <polygon points="0,0 100,0 100,100 0,100" fill="black" />
            <polygon points="25,25 75,25 50,75" fill="white" />
            <polygon points="50,25 75,75 25,75" fill="white" />
            <polygon points="35,35 65,35 50,65" fill="white" />
            <polygon points="35,35 65,35 50,65" fill="white" />
            <polygon points="35,35 65,35 50,65" fill="white" />
            <polygon points="35,35 65,35 50,65" fill="white" />
          </mask>
        </defs>
      </svg>
      <div className="status-orb-box" />
    </div>
  );
}
```

- [ ] **Step 2: Add CSS to `App.css`**

Replace the existing “Waiting indicator” section (`.waiting-dots` …) with:

```css
/* -------------------------------------------------------------------- */
/* Status orb — Uiverse young-walrus-64 (MIT, andrew-manzyk), scaled.     */
/* Idle keeps lava motion; .is-busy adds hue colorize.                   */
/* -------------------------------------------------------------------- */

.status-orb {
  --color-one: #ffbf48;
  --color-two: #be4a1d;
  --color-three: #ffbf4780;
  --color-four: #bf4a1d80;
  --color-five: #ffbf4740;
  --time-animation: 2s;
  --size: 0.22;
  position: relative;
  width: 100px;
  height: 100px;
  flex: 0 0 auto;
  border-radius: 50%;
  transform: scale(var(--size));
  transform-origin: left center;
  box-shadow:
    0 0 25px 0 var(--color-three),
    0 20px 50px 0 var(--color-four);
}

.status-orb.is-busy {
  animation: status-orb-colorize calc(var(--time-animation) * 3) ease-in-out infinite;
}

.status-orb::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  width: 100px;
  height: 100px;
  border-radius: 50%;
  border-top: solid 1px var(--color-one);
  border-bottom: solid 1px var(--color-two);
  background: linear-gradient(180deg, var(--color-five), var(--color-four));
  box-shadow:
    inset 0 10px 10px 0 var(--color-three),
    inset 0 -10px 10px 0 var(--color-four);
}

.status-orb-box {
  width: 100px;
  height: 100px;
  background: linear-gradient(180deg, var(--color-one) 30%, var(--color-two) 70%);
  mask: url(#status-orb-clip);
  -webkit-mask: url(#status-orb-clip);
}

.status-orb svg {
  position: absolute;
}

.status-orb svg #status-orb-clip {
  filter: contrast(15);
  animation: status-orb-roundness calc(var(--time-animation) / 2) linear infinite;
}

.status-orb svg #status-orb-clip polygon {
  filter: blur(7px);
}

.status-orb svg #status-orb-clip polygon:nth-child(1) {
  transform-origin: 75% 25%;
  transform: rotate(90deg);
}

.status-orb svg #status-orb-clip polygon:nth-child(2) {
  transform-origin: 50% 50%;
  animation: status-orb-rotation var(--time-animation) linear infinite reverse;
}

.status-orb svg #status-orb-clip polygon:nth-child(3) {
  transform-origin: 50% 60%;
  animation: status-orb-rotation var(--time-animation) linear infinite;
  animation-delay: calc(var(--time-animation) / -3);
}

.status-orb svg #status-orb-clip polygon:nth-child(4) {
  transform-origin: 40% 40%;
  animation: status-orb-rotation var(--time-animation) linear infinite reverse;
}

.status-orb svg #status-orb-clip polygon:nth-child(5) {
  transform-origin: 40% 40%;
  animation: status-orb-rotation var(--time-animation) linear infinite reverse;
  animation-delay: calc(var(--time-animation) / -2);
}

.status-orb svg #status-orb-clip polygon:nth-child(6) {
  transform-origin: 60% 40%;
  animation: status-orb-rotation var(--time-animation) linear infinite;
}

.status-orb svg #status-orb-clip polygon:nth-child(7) {
  transform-origin: 60% 40%;
  animation: status-orb-rotation var(--time-animation) linear infinite;
  animation-delay: calc(var(--time-animation) / -1.5);
}

@keyframes status-orb-rotation {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}

@keyframes status-orb-roundness {
  0% {
    filter: contrast(15);
  }
  20%,
  40% {
    filter: contrast(3);
  }
  60%,
  100% {
    filter: contrast(15);
  }
}

@keyframes status-orb-colorize {
  0% {
    filter: hue-rotate(0deg);
  }
  20% {
    filter: hue-rotate(-30deg);
  }
  40% {
    filter: hue-rotate(-60deg);
  }
  60% {
    filter: hue-rotate(-90deg);
  }
  80% {
    filter: hue-rotate(-45deg);
  }
  100% {
    filter: hue-rotate(0deg);
  }
}

.waiting-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
}

.is-waiting {
  color: var(--vscode-descriptionForeground);
}

.messages-status {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  margin-top: 4px;
}

@media (prefers-reduced-motion: reduce) {
  .status-orb.is-busy {
    animation: none;
  }

  .status-orb svg #status-orb-clip,
  .status-orb svg #status-orb-clip polygon {
    animation: none !important;
  }
}
```

Also add review-dock summary styles (used in Task 3):

```css
.review-dock-body {
  margin-bottom: 8px;
}

.review-dock-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  margin: 0;
  padding: 6px 2px 0;
  border: none;
  border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
  background: none;
  color: var(--vscode-descriptionForeground);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}

.review-dock-summary:hover {
  color: var(--vscode-foreground);
}

.review-dock-summary:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
}

.review-dock-chevron {
  flex: 0 0 auto;
  opacity: 0.8;
}
```

- [ ] **Step 3: Typecheck / build webview if the package has a script**

Run: `corepack pnpm --filter @palm-agent/extension exec tsc -p tsconfig.json --noEmit`  
(or the extension’s existing webview build). Expected: no errors from `StatusOrb.tsx`.

- [ ] **Step 4: Commit**

```bash
git add packages/extension/src/webview/StatusOrb.tsx packages/extension/src/webview/App.css
git commit -m "$(cat <<'EOF'
Add StatusOrb component and CSS from Uiverse loader.

EOF
)"
```

---

### Task 3: Wire dock collapse + orb in `App.tsx`

**Files:**
- Modify: `packages/extension/src/webview/App.tsx`

**Interfaces:**
- Consumes: `reviewDockSummary` (Task 1), `StatusOrb` (Task 2), existing `dockedReviews`
- Produces: UI behavior per spec

- [ ] **Step 1: Imports and state**

Add imports:

```ts
import { reviewDockSummary } from "./chatMessages";
import { StatusOrb } from "./StatusOrb";
```

(merge with existing `chatMessages` import).

Add state:

```ts
const [reviewExpanded, setReviewExpanded] = useState(true);
const prevPendingCount = useRef(0);
```

- [ ] **Step 2: Derived values and expand effect**

After `messages` / busy helpers (near where `reviews` is computed today):

```ts
const reviews = dockedReviews(messages);
const pendingReviews = reviews.filter((review) => review.status === "pending");
const hasPendingReview = pendingReviews.length > 0;
const dockSummary = reviewDockSummary(reviews);
const showOrbBusy =
  busy && lastLine?.role !== "assistant" && !awaitingAnswer && !researchInFlight;
```

Ensure `lastLine`, `awaitingAnswer`, `researchInFlight` still exist as today.

```ts
useEffect(() => {
  const count = pendingReviews.length;
  if (prevPendingCount.current === 0 && count > 0) {
    setReviewExpanded(true);
  }
  prevPendingCount.current = count;
}, [pendingReviews.length]);
```

- [ ] **Step 3: Replace review-dock JSX**

Replace the current `{reviews.length > 0 ? ( <div className="review-dock">…` block with:

```tsx
{hasPendingReview ? (
  <div className="review-dock" aria-label="Review">
    {reviewExpanded ? (
      <div className="review-dock-body">
        {pendingReviews.map((review) => (
          <article key={review.id} className="msg msg-review" aria-label="Review">
            <ReviewCard message={review} postMessage={postMessage} />
          </article>
        ))}
      </div>
    ) : null}
    <button
      type="button"
      className="review-dock-summary"
      aria-expanded={reviewExpanded}
      onClick={() => setReviewExpanded((value) => !value)}
    >
      <span>{dockSummary.label}</span>
      <span className="review-dock-chevron" aria-hidden="true">
        {reviewExpanded ? "▴" : "▾"}
      </span>
    </button>
  </div>
) : null}
```

- [ ] **Step 4: Replace waiting row with always-on status row**

Remove the conditional that only renders waiting when busy. At the end of `.messages` (after transcript map), always render:

```tsx
<div className="messages-status">
  {showOrbBusy ? (
    <article
      className="msg msg-assistant is-waiting"
      aria-label="Agent"
      aria-live="polite"
      aria-busy="true"
    >
      <p className="waiting-line">
        <StatusOrb busy />
        {waitSeconds < 8
          ? "Waiting for reply"
          : `Loading model / thinking… ${waitSeconds}s`}
      </p>
    </article>
  ) : (
    <StatusOrb busy={false} />
  )}
</div>
```

Update empty-state condition if it referenced `!busy` only — empty copy may still hide when there is transcript; orb remains below. Prefer:

```tsx
{transcript.length === 0 && !hasPendingReview && !busy ? (
  <p className="empty">…</p>
) : (
  transcript.map(…)
)}
```

Scroll effect can keep scrolling to `lastElementChild` (now often the status row).

- [ ] **Step 5: Manual check list (F5)**

- No pending → no dock; idle orb at bottom without color shift.
- Propose edit → dock expands with cards + summary; collapse hides cards, summary stays; count updates if second proposal arrives while collapsed (stays collapsed).
- After Keep/Undo clears pending → dock gone; next proposal expands again.
- Send message → orb colorizes + waiting text; on done → idle orb again.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/webview/App.tsx packages/extension/src/webview/App.css
git commit -m "$(cat <<'EOF'
Wire collapsible review dock and status orb into chat UI.

EOF
)"
```

---

### Task 4: Remove Add selection protocol

**Files:**
- Modify: `packages/extension/src/webview/App.tsx`
- Modify: `packages/extension/src/chatViewProvider.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Removes: `WebviewToExt` `get_selection`; `ExtToWebview` `selection`
- Keeps: `EditorContext.selection` / `getContext` for the agent

- [ ] **Step 1: Remove UI + handler in `App.tsx`**

Delete the Add selection button block.

Delete the `msg.type === "selection"` branch in the message listener (including `"No selection"` hint).

If `hint` / `setHint` is only used for selection and suggest errors, keep hint for other uses; only remove selection-specific sets.

- [ ] **Step 2: Remove host case**

In `packages/extension/src/chatViewProvider.ts`, delete the entire `case "get_selection": { … }`.

- [ ] **Step 3: Remove shared types**

In `packages/shared/src/index.ts`:

- Remove `| { type: "get_selection" }` from `WebviewToExt`
- Remove `| { type: "selection"; text: string | null }` from `ExtToWebview`

- [ ] **Step 4: Grep for leftovers**

Run: `rg "get_selection|type: \"selection\"" packages --glob '!**/node_modules/**'`

Expected: no protocol hits (editor `selection` in `workspacePort` / DOM `selectionStart` may remain).

- [ ] **Step 5: Run extension tests**

Run: `corepack pnpm --filter @palm-agent/extension exec vitest run`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/webview/App.tsx packages/extension/src/chatViewProvider.ts packages/shared/src/index.ts
git commit -m "$(cat <<'EOF'
Remove Add selection button and get_selection protocol.

EOF
)"
```

---

## Plan self-review

| Spec requirement | Task |
|---|---|
| Collapsible dock + always-visible summary with counts | 1 + 3 |
| First pending expands; then remember; reset when pending gone | 3 |
| Orb always in transcript; idle no colorize; busy colorize + text | 2 + 3 |
| Remove Add selection + protocol | 4 |
| Unit tests for summary label | 1 |
| No agent-core / get_context.selection change | honored |
| reduced-motion | 2 |
| Uiverse MIT attribution | 2 |

No TBD placeholders. `reviewDockSummary` signature matches Task 3 import. Pending-only dock gate matches goal “dok ima pending”.
