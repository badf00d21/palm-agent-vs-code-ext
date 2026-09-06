# Task 4 Report: Remove Add selection protocol

## Status: Complete

## Changes

### `packages/extension/src/webview/App.tsx`
- Removed **Add selection** button from composer actions.
- Removed `msg.type === "selection"` handler (textarea append + "No selection" hint).
- Removed unused `hint` / `setHint` state and composer hint UI (only used for selection flow).

### `packages/extension/src/chatViewProvider.ts`
- Deleted entire `case "get_selection"` block that called `port.getContext()` and posted `{ type: "selection" }`.

### `packages/shared/src/index.ts`
- Removed `{ type: "get_selection" }` from `WebviewToExt`.
- Removed `{ type: "selection"; text: string | null }` from `ExtToWebview`.

## Preserved (per spec)
- `WorkspacePort.getContext().selection` in `packages/extension/src/workspacePort.ts` — unchanged; agent still receives editor selection via `get_context` tool.

## Grep verification
```
rg "get_selection|type: \"selection\"" packages --glob '!**/node_modules/**'
```
**Result:** No matches in `packages/` (only historical references remain in `docs/`).

## Tests
```
corepack pnpm --filter palm-agent exec vitest run
```
**Result:** 10 files, 102 tests — all PASS.

Note: Brief specifies `--filter @palm-agent/extension`; actual package name is `palm-agent`.

## Commit
```
Remove Add selection button and get_selection protocol.
```

## Self-review
| Check | Result |
|---|---|
| Add selection UI removed | Yes |
| Protocol types removed from shared | Yes |
| Host handler removed | Yes |
| Agent `getContext().selection` intact | Yes |
| No protocol leftovers in packages | Yes |
| Tests pass | Yes |

## Concerns
- **Minor:** `packages/extension/DESIGN.md` still mentions "Add selection" in button docs — out of scope for this task; consider a follow-up doc cleanup.
- **Minor:** `.composer-hint` CSS remains unused until a future hint use case or doc-driven cleanup.

## Whole-branch review fixes
- Sized the StatusOrb outer box to its 22px visual footprint and moved scaling to a 100px inner wrapper.
- Made the review dock a fixed flex column with card overflow isolated to its body, keeping the summary visible.
- Preserved pending-only dock gating; passed only pending reviews to the summary helper.
- Added `aria-controls`/body `id`, removed orphaned `.composer-hint`, and corrected stale design-system claims.
- Documented StatusOrb as the intentional, deferred-theme exception to Host Paint and Resting-Flat rules.
- Added `App.layout.test.ts` regressions for dock scrolling/disclosure wiring and orb footprint scaling.

## Final verification
```
corepack pnpm --filter palm-agent exec vitest run
```
**Result:** 11 files, 105 tests — all PASS.

```
corepack pnpm --filter palm-agent run build
```
**Result:** PASS (webview and extension bundles).
