# Content SEARCH/REPLACE Implementation Plan

> **For agentic workers:** Tasks are tightly coupled — execute inline in one session with TDD. Do not dispatch parallel implementers.

**Goal:** Models propose edits as aider SEARCH/REPLACE blocks in `content`; `propose_edit` stays an internal invoke and is not sent to Ollama.

**Architecture:** Parse fences in `agent-core`, synthesize `FunctionCallItem`, hide fences from stream narration, cap `read_file` start-only windows at 80 lines.

**Tech Stack:** TypeScript, Vitest, existing Mozaik session / Ollama SSE assembler

## Global Constraints

- `packages/agent-core` has zero `import 'vscode'`
- Edit markers are exactly `<<<<<<< SEARCH`, `=======`, `>>>>>>> REPLACE`
- Ollama `tools` array never includes `propose_edit`
- Precedence: native `tool_calls` → JSON content tools → SEARCH/REPLACE blocks
- `start_line` without `end_line` → 80 lines inclusive (`end = start + 79`)
- No Gemma `call:propose_edit` parser
- pnpm may be missing from PATH — run `packages/agent-core/node_modules/.bin/vitest`

---

### Task 1: Parse SEARCH/REPLACE blocks

**Files:**
- Create: `packages/agent-core/src/tools/edit-blocks.ts`
- Test: `packages/agent-core/test/tools/edit-blocks.test.ts`

**Produces:** `parseSearchReplaceBlocks(text: string): { path: string; search: string; replace: string }[]`

- [x] Implement with TDD (see tests in repo)

---

### Task 2: Stream hide + synthesize propose_edit + hide tool from model

**Files:**
- Modify: `packages/agent-core/src/model/chat-stream.ts` (`streamMode`)
- Modify: `packages/agent-core/src/model/local-inference.ts` (`deliverCompletion`)
- Modify: `packages/agent-core/src/tools/tools.ts` (`toolsVisibleToModel`, prompt, read window)
- Modify: `packages/agent-core/src/participants/editor-agent.ts`
- Test: existing `chat-stream.test.ts`, `local-inference.test.ts`, `tools.test.ts`, `editor-agent.test.ts`

- [x] Implement with TDD

---

### Task 3: Docs

**Files:**
- Modify: `packages/agent-core/README.md`

- [x] Match shipped behavior
