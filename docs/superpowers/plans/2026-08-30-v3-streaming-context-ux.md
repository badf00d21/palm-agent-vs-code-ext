# v3 Streaming + tool viz + @-context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream assistant prose into one bubble, show tool rows as running → done without dumping tool JSON, and let the composer insert `@path` plus the current selection.

**Architecture:** Ollama Chat Completions with `stream: true`. A new `chat-stream` assembler in `agent-core` classifies prose vs tool JSON; only prose emits `NARRATION_EVENT`. `UIBridge` shows narration and tool status, not `ModelMessageItem`. The webview appends consecutive `assistant_delta`s. `@` / selection never attach file bodies.

**Tech Stack:** existing pnpm monorepo, Vitest, Ollama SSE (`text/event-stream`), VS Code webview `postMessage`, `vscode.workspace.findFiles`.

**Spec:** `docs/superpowers/specs/2026-08-30-v3-streaming-context-ux-design.md`

## Global Constraints

- `packages/agent-core` has zero `import 'vscode'` (and no `require('vscode')`).
- Tool JSON and native `tool_calls` never become `assistant_delta`. Doubt = buffer.
- Stream deltas are UI-only (`NARRATION_EVENT`). Context still gets one `ModelMessageItem` or function calls at the end.
- `UIBridge.onExternalModelMessage` must not emit `assistant_delta`.
- `@` is a path in the textarea. Do not read or attach file bodies (deferred option B).
- Cancel / `AbortController` stay as they are; abort must not `deliverCompletion`.
- Commits are owned by the human; treat each Task's commit step as optional.
- No live Ollama in CI. Fake `fetchImpl` returns SSE.
- Do not implement create/delete file, per-hunk accept, `@folder`, chip UI, or file-body attach.

## File structure

| File | Responsibility |
|---|---|
| `packages/shared/src/index.ts` | `tool_call` id/status; suggest/selection messages |
| `packages/agent-core/src/model/chat-stream.ts` | SSE parse, chunk merge, prose vs tool mode |
| `packages/agent-core/src/model/local-inference.ts` | `stream: true`, wire assembler, no end-of-turn narration |
| `packages/agent-core/src/workspace/suggest.ts` | Pure `planFileSuggestions` (glob / empty) |
| `packages/agent-core/src/participants/ui-bridge.ts` | Narration + tool running/done only |
| `packages/agent-core/src/index.ts` | Export `planFileSuggestions` |
| `packages/extension/src/webview/chatMessages.ts` | Append deltas; tool row update by id |
| `packages/extension/src/webview/App.tsx` | Hide waiting on first prose; `@` popup; Add selection |
| `packages/extension/src/webview/App.css` | Suggest popup + tool running |
| `packages/extension/src/chatViewProvider.ts` | Route suggest/selection |
| `packages/extension/src/sessionHost.ts` | Expose `port` on the host |

---

### Task 1: Shared protocol

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/agent-core/src/participants/ui-bridge.ts` (add `id` + `status: "running"` so the repo typechecks; Task 5 adds `done`)

**Interfaces:**
- Consumes: current `WebviewToExt` / `ExtToWebview`
- Produces: `ToolCallStatus`, `tool_call` with `id` + `status`, `suggest_files`, `get_selection`, `file_suggestions`, `selection`

Do the protocol change and immediately make the repo typecheck by adding `id` + `status: "running"` at every `tool_call` construction site. Do **not** change UI append/merge behavior yet.

- [ ] **Step 1: Replace shared types**

`packages/shared/src/index.ts` must be exactly:

```ts
export interface DiffFile {
  path: string;
}

export type ToolCallStatus = "running" | "done";

export type WebviewToExt =
  | { type: "user_message"; text: string }
  | { type: "apply_diff"; id: string }
  | { type: "reject_diff"; id: string }
  | { type: "open_diff"; id: string; path?: string }
  | { type: "cancel" }
  | { type: "suggest_files"; query: string }
  | { type: "get_selection" };

export type ExtToWebview =
  | { type: "assistant_delta"; text: string }
  | { type: "tool_call"; name: string; args: unknown; id: string; status: ToolCallStatus }
  | { type: "diff_proposed"; id: string; files: DiffFile[] }
  | { type: "diff_settled"; id: string; status: "kept" | "undone" }
  | { type: "file_suggestions"; query: string; paths: string[] }
  | { type: "selection"; text: string | null }
  | { type: "done" }
  | { type: "error"; message: string };
```

- [ ] **Step 2: Unblock typecheck**

Update every `tool_call` object so it includes `id` and `status: "running"`:

- `packages/agent-core/src/participants/ui-bridge.ts` — `eventsFromFunctionCall`:

```ts
export function eventsFromFunctionCall(
  name: string,
  args: unknown,
  id = "call_unknown",
): ExtToWebview {
  return { type: "tool_call", name, args, id, status: "running" };
}
```

- `packages/agent-core/test/participants/ui-bridge.test.ts` — expected object gains `id: "call_unknown", status: "running"`.
- `packages/extension/src/webview/chatMessages.test.ts` — add `id: "c1", status: "running"` to the `tool_call` fixture. Reducer still appends a new line (Task 6 changes merge).

- [ ] **Step 3: Typecheck**

Run from repo root:

```
npx tsc -p packages/shared --noEmit
npx tsc -p packages/agent-core --noEmit
npx tsc -p packages/extension --noEmit
```

Expected: PASS (or only pre-existing errors unrelated to `tool_call`).

- [ ] **Step 4: Commit (optional)**

```
git add packages/shared/src/index.ts packages/agent-core/src/participants/ui-bridge.ts packages/agent-core/test/participants/ui-bridge.test.ts packages/extension/src/webview/chatMessages.test.ts
git commit -m "feat(v3): add stream-era protocol fields for tools and composer"
```

---

### Task 2: Chat stream assembler

**Files:**
- Create: `packages/agent-core/src/model/chat-stream.ts`
- Create: `packages/agent-core/test/model/chat-stream.test.ts`

**Interfaces:**
- Consumes: `parseToolCallsFromContent` from `local-inference.ts` (already exported)
- Produces:
  - `AssembledCompletion { content: string; finishReason: string | null; toolCalls: StreamToolCall[] }`
  - `StreamToolCall { id?: string; function?: { name?: string; arguments?: unknown } }`
  - `emptyAssembly(): AssembledCompletion`
  - `applyChatChunk(acc: AssembledCompletion, chunk: unknown): { contentDelta: string }`
  - `streamMode(acc: AssembledCompletion): "prose" | "tool"`
  - `iterateSseData(text: string): string[]`
  - `readSseChatCompletion(response: Response, onProseDelta: (text: string) => void, signal?: AbortSignal): Promise<AssembledCompletion>`

- [ ] **Step 1: Write the failing tests**

Create `packages/agent-core/test/model/chat-stream.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  applyChatChunk,
  emptyAssembly,
  iterateSseData,
  readSseChatCompletion,
  streamMode,
} from "../../src/model/chat-stream.js";

describe("iterateSseData", () => {
  it("yields data payloads and stops at [DONE]", () => {
    const text = [
      'data: {"choices":[{"delta":{"content":"Hi"}}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    expect(iterateSseData(text)).toEqual(['{"choices":[{"delta":{"content":"Hi"}}]}']);
  });
});

describe("applyChatChunk + streamMode", () => {
  it("accumulates prose deltas", () => {
    const acc = emptyAssembly();
    const a = applyChatChunk(acc, { choices: [{ delta: { content: "Hel" } }] });
    const b = applyChatChunk(acc, { choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] });
    expect(a.contentDelta).toBe("Hel");
    expect(b.contentDelta).toBe("lo");
    expect(acc.content).toBe("Hello");
    expect(acc.finishReason).toBe("stop");
    expect(streamMode(acc)).toBe("prose");
  });

  it("switches to tool when content starts with {", () => {
    const acc = emptyAssembly();
    applyChatChunk(acc, { choices: [{ delta: { content: '{"name"' } }] });
    expect(streamMode(acc)).toBe("tool");
  });

  it("switches to tool on native tool_calls", () => {
    const acc = emptyAssembly();
    applyChatChunk(acc, {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: "" } }],
          },
        },
      ],
    });
    applyChatChunk(acc, {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"path":"a.ts"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    expect(streamMode(acc)).toBe("tool");
    expect(acc.toolCalls[0]).toEqual({
      id: "call_1",
      function: { name: "read_file", arguments: '{"path":"a.ts"}' },
    });
  });
});

describe("readSseChatCompletion", () => {
  it("emits prose deltas and not a second copy at the end", async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const deltas: string[] = [];
    const acc = await readSseChatCompletion(
      new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
      (text) => deltas.push(text),
    );
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(acc.content).toBe("Hello");
  });

  it("does not emit deltas for tool JSON content", async () => {
    const json = '{"name":"read_file","arguments":{"path":"a.ts"}}';
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: json }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    const deltas: string[] = [];
    const acc = await readSseChatCompletion(
      new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
      (text) => deltas.push(text),
    );
    expect(deltas).toEqual([]);
    expect(streamMode(acc)).toBe("tool");
    expect(acc.content).toBe(json);
  });

  it("does not emit after abort", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(s) {
        s.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"{"}}]}\n\n'));
        controller.abort();
        s.close();
      },
    });
    await expect(
      readSseChatCompletion(
        new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
        () => undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `packages/agent-core`:

```
npx vitest run test/model/chat-stream.test.ts
```

Expected: FAIL — `Cannot find module` / `chat-stream.js` missing.

- [ ] **Step 3: Implement `chat-stream.ts`**

Create `packages/agent-core/src/model/chat-stream.ts`:

```ts
import { parseToolCallsFromContent } from "./local-inference.js";

export interface StreamToolCall {
  id?: string;
  function?: { name?: string; arguments?: unknown };
}

export interface AssembledCompletion {
  content: string;
  finishReason: string | null;
  toolCalls: StreamToolCall[];
}

export function emptyAssembly(): AssembledCompletion {
  return { content: "", finishReason: null, toolCalls: [] };
}

export function iterateSseData(text: string): string[] {
  const out: string[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith("data:")) {
        continue;
      }
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") {
        continue;
      }
      out.push(data);
    }
  }
  return out;
}

export function applyChatChunk(
  acc: AssembledCompletion,
  chunk: unknown,
): { contentDelta: string } {
  if (!chunk || typeof chunk !== "object") {
    return { contentDelta: "" };
  }
  const choice = (chunk as { choices?: unknown[] }).choices?.[0];
  if (!choice || typeof choice !== "object") {
    return { contentDelta: "" };
  }
  const rec = choice as {
    finish_reason?: string | null;
    delta?: { content?: unknown; tool_calls?: unknown };
    message?: { content?: unknown; tool_calls?: unknown };
  };
  if (typeof rec.finish_reason === "string") {
    acc.finishReason = rec.finish_reason;
  }
  const delta = rec.delta ?? rec.message ?? {};
  let contentDelta = "";
  if (typeof delta.content === "string" && delta.content) {
    contentDelta = delta.content;
    acc.content += delta.content;
  }
  const calls = delta.tool_calls;
  if (Array.isArray(calls)) {
    for (const raw of calls) {
      if (!raw || typeof raw !== "object") {
        continue;
      }
      const call = raw as {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: unknown };
      };
      const index = typeof call.index === "number" ? call.index : acc.toolCalls.length;
      const current = acc.toolCalls[index] ?? { function: { name: "", arguments: "" } };
      if (call.id) {
        current.id = call.id;
      }
      current.function = current.function ?? { name: "", arguments: "" };
      if (typeof call.function?.name === "string") {
        current.function.name = `${current.function.name ?? ""}${call.function.name}`;
      }
      if (typeof call.function?.arguments === "string") {
        current.function.arguments = `${String(current.function.arguments ?? "")}${call.function.arguments}`;
      }
      acc.toolCalls[index] = current;
    }
  }
  return { contentDelta };
}

export function streamMode(acc: AssembledCompletion): "prose" | "tool" {
  if (acc.toolCalls.some((call) => call.id || call.function?.name)) {
    return "tool";
  }
  const trimmed = acc.content.trim();
  if (trimmed.startsWith("{")) {
    return "tool";
  }
  if (parseToolCallsFromContent(acc.content).length > 0) {
    return "tool";
  }
  return "prose";
}

export async function readSseChatCompletion(
  response: Response,
  onProseDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<AssembledCompletion> {
  if (signal?.aborted) {
    const error = new Error("This operation was aborted");
    error.name = "AbortError";
    throw error;
  }
  const acc = emptyAssembly();
  let mode: "prose" | "tool" | "unknown" = "unknown";
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    applySseText(acc, text, (delta) => {
      mode = promote(acc, mode, delta, onProseDelta);
    });
    if (signal?.aborted) {
      const error = new Error("This operation was aborted");
      error.name = "AbortError";
      throw error;
    }
    return acc;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => {
    void reader.cancel();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) {
        const error = new Error("This operation was aborted");
        error.name = "AbortError";
        throw error;
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        applySseText(acc, `${part}\n\n`, (delta) => {
          mode = promote(acc, mode, delta, onProseDelta);
        });
      }
    }
    if (buffer.trim()) {
      applySseText(acc, buffer, (delta) => {
        mode = promote(acc, mode, delta, onProseDelta);
      });
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  return acc;
}

function applySseText(
  acc: AssembledCompletion,
  text: string,
  onDelta: (contentDelta: string) => void,
): void {
  for (const data of iterateSseData(text)) {
    let chunk: unknown;
    try {
      chunk = JSON.parse(data) as unknown;
    } catch {
      continue;
    }
    const { contentDelta } = applyChatChunk(acc, chunk);
    onDelta(contentDelta);
  }
}

function promote(
  acc: AssembledCompletion,
  mode: "prose" | "tool" | "unknown",
  contentDelta: string,
  onProseDelta: (text: string) => void,
): "prose" | "tool" {
  const next = streamMode(acc);
  if (next === "tool") {
    return "tool";
  }
  if (contentDelta && (mode === "prose" || mode === "unknown")) {
    onProseDelta(contentDelta);
  }
  return "prose";
}
```

Circular import: `chat-stream.ts` imports `parseToolCallsFromContent` from `local-inference.ts`, which will later import `readSseChatCompletion`. **Move `parseToolCallsFromContent` (and its private helpers it needs) only if the cycle breaks at runtime.** Prefer: keep `parseToolCallsFromContent` in `local-inference.ts` and import it from `chat-stream.ts`; `local-inference.ts` imports `readSseChatCompletion` — ESM cycle is OK if `parseToolCallsFromContent` is a function declaration / exported after init. If Vitest throws a cycle, move `parseToolCallsFromContent` + helpers into `packages/agent-core/src/model/tool-call-parse.ts` and import from both. Do that move in this task if needed; update existing `parseToolCallsFromContent` imports in tests to the new file.

- [ ] **Step 4: Run tests to verify they pass**

```
npx vitest run test/model/chat-stream.test.ts
```

Expected: PASS (working directory `packages/agent-core`).

- [ ] **Step 5: Commit (optional)**

```
git add packages/agent-core/src/model/chat-stream.ts packages/agent-core/test/model/chat-stream.test.ts packages/agent-core/src/model/tool-call-parse.ts
git commit -m "feat(v3): assemble Ollama SSE and classify prose vs tool JSON"
```

---

### Task 3: Wire streaming into `runLocalChatCompletions`

**Files:**
- Modify: `packages/agent-core/src/model/local-inference.ts`
- Modify: `packages/agent-core/test/model/local-inference.test.ts`

**Interfaces:**
- Consumes: `readSseChatCompletion`, `AssembledCompletion` from Task 2
- Produces: request body includes `stream: true`; SSE path emits incremental `NARRATION_EVENT` then `deliverCompletion` **without** a second narration; abort skips `deliverCompletion`

- [ ] **Step 1: Add SSE helper and stream tests**

In `packages/agent-core/test/model/local-inference.test.ts` add:

```ts
function sseResponse(deltas: unknown[]): Response {
  const body =
    deltas.map((delta) => `data: ${JSON.stringify({ choices: [delta] })}\n\n`).join("") +
    "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}
```

Add these cases (keep existing ones; convert their `jsonResponse({ choices: [{ message }] })` to `sseResponse([{ delta: message, finish_reason: message.finish_reason ?? "stop" }])` so every completion test hits the stream path).

New assertions to add on the first success test's `fetchImpl` body parse:

```ts
const body = JSON.parse(String(init?.body)) as { stream?: boolean; model: string; max_tokens: number };
expect(body.stream).toBe(true);
```

Add:

```ts
it("streams prose narration then delivers one ModelMessageItem without a second narration", async () => {
  process.env.OPENAI_BASE_URL = BASE_URL;
  const narrations: string[] = [];
  const delivered: ModelMessageItem[] = [];
  await runLocalChatCompletions({
    model: "gemma4:12b",
    context: ModelContext.create("test"),
    tools: [],
    environment: {
      deliverSemanticEvent: (_c: unknown, item: SemanticEvent<unknown>) => {
        narrations.push((item.data as { text?: string }).text ?? "");
      },
      deliverModelMessage: (_c: unknown, item: ModelMessageItem) => {
        delivered.push(item);
      },
      deliverFunctionCall: () => {
        throw new Error("unexpected function call");
      },
    } as unknown as AgenticEnvironment,
    caller: new BaseParticipant(),
    onFailed: () => {
      throw new Error("should not fail");
    },
    fetchImpl: async () =>
      sseResponse([
        { delta: { content: "Hel" } },
        { delta: { content: "lo" }, finish_reason: "stop" },
      ]),
  });
  expect(narrations).toEqual(["Hel", "lo"]);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]?.content.text).toBe("Hello");
});
```

Change the existing test **"delivers narration as a semantic event when content accompanies native tool calls"** to expect **zero** narrations (spec: native `tool_calls` ⇒ tool mode, no UI narration). Still expect the function call.

Add: abort after the first SSE prose chunk — `deliverFunctionCall` / `deliverModelMessage` never run. Reuse `AbortController`; `fetchImpl` returns a stream that aborts after enqueueing `'data: {"choices":[{"delta":{"content":"{"}}]}\n\n'`.

Every mock `environment` used with streamed prose must include `deliverSemanticEvent`. Mocks that only expect function calls can use `deliverSemanticEvent: () => undefined`.

- [ ] **Step 2: Run the new stream test — expect FAIL**

```
npx vitest run test/model/local-inference.test.ts
```

Expected: FAIL on `body.stream` and/or missing incremental narrations.

- [ ] **Step 3: Wire the runner**

In `runLocalChatCompletions`, set `body.stream = true`.

After `response.ok`:

```ts
const assembled = await readSseChatCompletion(
  response,
  (text) => {
    if (!isCurrentTurn(params) || !text) {
      return;
    }
    params.environment.deliverSemanticEvent(
      params.caller,
      new SemanticEvent<NarrationPayload>(NARRATION_EVENT, { text }),
    );
  },
  params.signal,
);
if (!isCurrentTurn(params)) {
  params.trace?.("completion dropped: stale turn");
  return;
}
deliverCompletion(params, {
  choices: [
    {
      finish_reason: assembled.finishReason,
      message: {
        content: assembled.content,
        tool_calls: assembled.toolCalls,
      },
    },
  ],
});
```

Wrap `readSseChatCompletion` in the existing `try/catch`. `AbortError` → `onFailed(formatInferenceFailure(...))` as today; do **not** call `deliverCompletion`.

In `deliverCompletion`, **delete** the block that emits `NARRATION_EVENT` when `nativeToolCalls.length > 0` and content is non-empty. Narration is stream-only.

`deliverCompletion` still parses content-JSON tool calls and delivers function calls / model messages as today.

- [ ] **Step 4: Run tests to verify they pass**

```
npx vitest run test/model/local-inference.test.ts test/model/chat-stream.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit (optional)**

```
git add packages/agent-core/src/model/local-inference.ts packages/agent-core/test/model/local-inference.test.ts
git commit -m "feat(v3): stream local Chat Completions and narrate prose only"
```

---

### Task 4: Append `assistant_delta` + hide waiting

**Files:**
- Modify: `packages/extension/src/webview/chatMessages.ts`
- Modify: `packages/extension/src/webview/chatMessages.test.ts`
- Modify: `packages/extension/src/webview/App.tsx`

**Interfaces:**
- Consumes: `assistant_delta` unchanged
- Produces: `applyExtMessage` concatenates onto the last assistant `ChatLine`

- [ ] **Step 1: Write the failing test**

Add to `packages/extension/src/webview/chatMessages.test.ts`:

```ts
it("appends consecutive assistant deltas onto one line", () => {
  const first = applyExtMessage([], { type: "assistant_delta", text: "Hel" });
  const next = applyExtMessage(first, { type: "assistant_delta", text: "lo" });
  expect(next).toEqual([{ role: "assistant", text: "Hello" }]);
});

it("starts a new assistant line after a tool line", () => {
  const withTool = applyExtMessage([], {
    type: "tool_call",
    name: "read_file",
    args: { path: "a.ts" },
    id: "c1",
    status: "running",
  });
  const next = applyExtMessage(withTool, { type: "assistant_delta", text: "done" });
  expect(next).toHaveLength(2);
  expect(next[1]).toEqual({ role: "assistant", text: "done" });
});
```

- [ ] **Step 2: Run test to verify it fails**

From `packages/extension`:

```
npx vitest run src/webview/chatMessages.test.ts
```

Expected: FAIL — two assistant lines `Hel` and `lo`.

- [ ] **Step 3: Implement append**

Replace the `assistant_delta` branch in `applyExtMessage`:

```ts
if (msg.type === "assistant_delta") {
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant") {
    return [...messages.slice(0, -1), { role: "assistant", text: last.text + msg.text }];
  }
  return [...messages, { role: "assistant", text: msg.text }];
}
```

In `App.tsx`, keep `busy` true until `done`/`error`. Hide the waiting article when the last message is an assistant line:

```tsx
{busy && messages[messages.length - 1]?.role !== "assistant" ? (
  <article className="bubble assistant waiting" aria-live="polite" aria-busy="true">
    ...
  </article>
) : null}
```

Keep the Stop button available while `busy`. Put Stop on the waiting article **and** (when waiting is hidden) a small Stop control on the composer row:

```tsx
{busy ? (
  <button type="button" className="waiting-stop" onClick={() => vscodeRef.current.postMessage({ type: "cancel" })}>
    Stop
  </button>
) : (
  <button type="submit" disabled={input.trim().length === 0}>Send</button>
)}
```

If Stop is already only inside the waiting article, move it so it remains visible during streaming.

- [ ] **Step 4: Run tests**

```
npx vitest run src/webview/chatMessages.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit (optional)**

```
git add packages/extension/src/webview/chatMessages.ts packages/extension/src/webview/chatMessages.test.ts packages/extension/src/webview/App.tsx
git commit -m "feat(v3): append streamed tokens into one assistant bubble"
```

---

### Task 5: UIBridge — narration only + tool done

**Files:**
- Modify: `packages/agent-core/src/participants/ui-bridge.ts`
- Modify: `packages/agent-core/test/participants/ui-bridge.test.ts`

**Interfaces:**
- Consumes: `FunctionCallItem.callId`, `FunctionCallOutputItem.callId`
- Produces:
  - `eventsFromFunctionCall(name, args, id): ExtToWebview` with `status: "running"`
  - `eventsFromFunctionCallOutput(id: string): ExtToWebview` with `name: ""`, `args: {}`, `status: "done"`
  - `onExternalModelMessage` is a no-op (no sink)

- [ ] **Step 1: Write the failing tests**

Replace/extend `packages/agent-core/test/participants/ui-bridge.test.ts` mapper tests:

```ts
it("maps a function call as running", () => {
  expect(eventsFromFunctionCall("read_file", { path: "a.ts" }, "call_1")).toEqual({
    type: "tool_call",
    name: "read_file",
    args: { path: "a.ts" },
    id: "call_1",
    status: "running",
  });
});

it("maps function output as done", () => {
  expect(eventsFromFunctionCallOutput("call_1")).toEqual({
    type: "tool_call",
    name: "",
    args: {},
    id: "call_1",
    status: "done",
  });
});

it("does not map model text to the sink", () => {
  expect(eventFromModelText("hello")).toBeNull();
});
```

Add a class test that constructs `FunctionCallItem.rehydrate({ callId: "call_1", name: "read_file", args: "{\"path\":\"a.ts\"}" })`, calls `onExternalFunctionCall`, then `FunctionCallOutputItem.create("call_1", "ok")` + `onExternalFunctionCallOutput`, and expects two sink events: running then done.

- [ ] **Step 2: Run tests — expect FAIL**

```
npx vitest run test/participants/ui-bridge.test.ts
```

Expected: FAIL — `eventsFromFunctionCallOutput` missing; `eventFromModelText` still returns a delta.

- [ ] **Step 3: Implement**

```ts
export function eventsFromFunctionCall(
  name: string,
  args: unknown,
  id: string,
): ExtToWebview {
  return { type: "tool_call", name, args, id, status: "running" };
}

export function eventsFromFunctionCallOutput(id: string): ExtToWebview {
  return { type: "tool_call", name: "", args: {}, id, status: "done" };
}

export function eventFromModelText(_text: string): ExtToWebview | null {
  return null;
}
```

`onExternalFunctionCall` passes `item.callId`.

```ts
override onExternalFunctionCallOutput(_source: Participant, item: FunctionCallOutputItem): void {
  this.sink()(eventsFromFunctionCallOutput(item.callId));
}

override onExternalModelMessage(): void {
  return;
}
```

Import `FunctionCallOutputItem`.

- [ ] **Step 4: Run tests**

```
npx vitest run test/participants/ui-bridge.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit (optional)**

```
git add packages/agent-core/src/participants/ui-bridge.ts packages/agent-core/test/participants/ui-bridge.test.ts
git commit -m "feat(v3): show tool running/done and stop echoing model messages"
```

---

### Task 6: Tool row merge in the webview

**Files:**
- Modify: `packages/extension/src/webview/chatMessages.ts`
- Modify: `packages/extension/src/webview/chatMessages.test.ts`
- Modify: `packages/extension/src/webview/App.tsx`
- Modify: `packages/extension/src/webview/App.css`

**Interfaces:**
- Consumes: `tool_call` with `id` + `status` from Task 1
- Produces: `ToolLine { role: "tool"; text: string; id: string; status: "running" | "done" }`

- [ ] **Step 1: Write the failing test**

```ts
it("updates a tool line from running to done by id", () => {
  const running = applyExtMessage([], {
    type: "tool_call",
    name: "read_file",
    args: { path: "a.ts" },
    id: "call_1",
    status: "running",
  });
  const done = applyExtMessage(running, {
    type: "tool_call",
    name: "",
    args: {},
    id: "call_1",
    status: "done",
  });
  expect(done).toHaveLength(1);
  expect(done[0]).toEqual({
    role: "tool",
    text: "read_file  a.ts",
    id: "call_1",
    status: "done",
  });
});
```

Update the existing tool-line test expected value to include `id` and `status: "running"`.

- [ ] **Step 2: Run — expect FAIL**

```
npx vitest run src/webview/chatMessages.test.ts
```

Expected: FAIL — two tool lines.

- [ ] **Step 3: Implement**

In `chatMessages.ts`:

```ts
export interface ToolLine {
  role: "tool";
  text: string;
  id: string;
  status: "running" | "done";
}

export type ChatLine = TextLine | ToolLine | ReviewLine;
```

`TextLine.role` is only `"user" | "assistant"`.

`tool_call` branch:

```ts
if (msg.type === "tool_call") {
  const existing = messages.findIndex((line) => line.role === "tool" && line.id === msg.id);
  if (existing >= 0 && msg.status === "done") {
    return messages.map((line, index) =>
      index === existing && line.role === "tool" ? { ...line, status: "done" } : line,
    );
  }
  const detail = formatToolArgs(msg.args);
  const text = detail ? `${msg.name}  ${detail}` : msg.name;
  return [...messages, { role: "tool", text, id: msg.id, status: msg.status }];
}
```

In `App.tsx`, add `className={`bubble ${message.role}${message.role === "tool" && message.status === "running" ? " running" : ""}`}`.

In `App.css`:

```css
.bubble.tool.running {
  opacity: 0.55;
}
```

- [ ] **Step 4: Run tests**

```
npx vitest run src/webview/chatMessages.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit (optional)**

```
git add packages/extension/src/webview/chatMessages.ts packages/extension/src/webview/chatMessages.test.ts packages/extension/src/webview/App.tsx packages/extension/src/webview/App.css
git commit -m "feat(v3): merge tool rows from running to done"
```

---

### Task 7: `planFileSuggestions` + ext routing

**Files:**
- Create: `packages/agent-core/src/workspace/suggest.ts`
- Create: `packages/agent-core/test/workspace/suggest.test.ts`
- Modify: `packages/agent-core/src/index.ts`
- Modify: `packages/extension/src/sessionHost.ts`
- Modify: `packages/extension/src/chatViewProvider.ts`

**Interfaces:**
- Consumes: `WorkspacePort.findFiles` is **not** used for prefix suggest (exact basename). Ext uses `vscode.workspace.findFiles`.
- Produces:

```ts
export const SUGGEST_EXCLUDE = "**/{node_modules,dist,out,.git}/**";
export const SUGGEST_LIMIT = 20;

export type FileSuggestPlan =
  | { action: "empty" }
  | { action: "search"; glob: string; exclude: string; max: number };

export function planFileSuggestions(query: string): FileSuggestPlan
```

- [ ] **Step 1: Write the failing tests**

`packages/agent-core/test/workspace/suggest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { planFileSuggestions, SUGGEST_EXCLUDE, SUGGEST_LIMIT } from "../../src/workspace/suggest.js";

describe("planFileSuggestions", () => {
  it("skips an empty query", () => {
    expect(planFileSuggestions("")).toEqual({ action: "empty" });
    expect(planFileSuggestions("   ")).toEqual({ action: "empty" });
  });

  it("strips glob metacharacters and builds a prefix glob", () => {
    expect(planFileSuggestions("ab*c")).toEqual({
      action: "search",
      glob: "**/*abc*",
      exclude: SUGGEST_EXCLUDE,
      max: SUGGEST_LIMIT,
    });
  });

  it("treats a query that sanitizes to empty as empty", () => {
    expect(planFileSuggestions("***")).toEqual({ action: "empty" });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```
npx vitest run test/workspace/suggest.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement planner + routing**

`packages/agent-core/src/workspace/suggest.ts`:

```ts
export const SUGGEST_EXCLUDE = "**/{node_modules,dist,out,.git}/**";
export const SUGGEST_LIMIT = 20;

export type FileSuggestPlan =
  | { action: "empty" }
  | { action: "search"; glob: string; exclude: string; max: number };

export function planFileSuggestions(query: string): FileSuggestPlan {
  const safe = query.replace(/[*?\[\]{}]/g, "").trim();
  if (!safe) {
    return { action: "empty" };
  }
  return {
    action: "search",
    glob: `**/*${safe}*`,
    exclude: SUGGEST_EXCLUDE,
    max: SUGGEST_LIMIT,
  };
}
```

Export `planFileSuggestions`, `SUGGEST_EXCLUDE`, `SUGGEST_LIMIT` from `packages/agent-core/src/index.ts`.

`createSessionHost` return value adds `port` (the `WorkspacePort` already constructed).

`ChatViewProvider` host type becomes `{ session; store; port }`.

In `routeMessage`, **before** the switch default, handle:

```ts
case "suggest_files": {
  // Deferred: option B — chip + file contents in the user payload (Cursor-style).
  // Do not attach file bodies here.
  const plan = planFileSuggestions(message.query);
  if (plan.action === "empty") {
    post({ type: "file_suggestions", query: message.query, paths: [] });
    return;
  }
  try {
    const uris = await vscode.workspace.findFiles(plan.glob, plan.exclude, plan.max);
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const paths = root
      ? uris.map((uri) => toWorkspaceRelative(root, uri.fsPath))
      : [];
    post({ type: "file_suggestions", query: message.query, paths });
  } catch {
    post({ type: "file_suggestions", query: message.query, paths: [] });
  }
  return;
}
case "get_selection": {
  try {
    const ctx = await this.host.port.getContext();
    const text = ctx.selection && ctx.selection.length > 0 ? ctx.selection : null;
    post({ type: "selection", text });
  } catch {
    post({ type: "selection", text: null });
  }
  return;
}
```

Pass `host` through so `this.host.port` exists (store `host` on the class instead of only `session`/`store`).

Import `planFileSuggestions` and `toWorkspaceRelative` from `@palm-agent/agent-core`.

- [ ] **Step 4: Run planner tests + extension typecheck**

```
npx vitest run test/workspace/suggest.test.ts
```

from `packages/agent-core`. Expected: PASS.

```
npx tsc -p packages/extension --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit (optional)**

```
git add packages/agent-core/src/workspace/suggest.ts packages/agent-core/test/workspace/suggest.test.ts packages/agent-core/src/index.ts packages/extension/src/sessionHost.ts packages/extension/src/chatViewProvider.ts
git commit -m "feat(v3): route @ file suggestions and editor selection"
```

---

### Task 8: Composer `@` popup + Add selection

**Files:**
- Modify: `packages/extension/src/webview/App.tsx`
- Modify: `packages/extension/src/webview/App.css`

**Interfaces:**
- Consumes: `suggest_files`, `file_suggestions`, `get_selection`, `selection` from Task 1 / Task 7
- Produces: textarea inserts `@posix/path `; Add selection appends selection text

No jsdom suite required (spec). Behavior is specified here; verify in EDH.

- [ ] **Step 1: Composer state**

In `App.tsx` add:

```ts
const [suggestions, setSuggestions] = useState<string[]>([]);
const [suggestQuery, setSuggestQuery] = useState<string | null>(null);
const [hint, setHint] = useState("");
const suggestTimer = useRef<number | undefined>(undefined);
const pendingSuggest = useRef<string | null>(null);
```

In the `message` listener, handle:

```ts
if (msg.type === "file_suggestions") {
  if (msg.query !== pendingSuggest.current) {
    return;
  }
  setSuggestions(msg.paths);
  return;
}
if (msg.type === "selection") {
  if (msg.text) {
    setInput((prev) => (prev ? `${prev}\n${msg.text}` : msg.text));
    setHint("");
  } else {
    setHint("No selection");
  }
  return;
}
```

`applyExtMessage` already ignores unknown types if you add a default `return messages` (it already does). Do **not** push `file_suggestions` into the transcript.

- [ ] **Step 2: Detect `@` token and debounce**

```ts
function activeAtQuery(value: string, caret: number): string | null {
  const upto = value.slice(0, caret);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(upto);
  return match ? (match[1] ?? "") : null;
}

function scheduleSuggest(query: string) {
  pendingSuggest.current = query;
  window.clearTimeout(suggestTimer.current);
  suggestTimer.current = window.setTimeout(() => {
    vscodeRef.current.postMessage({ type: "suggest_files", query });
  }, 150);
}
```

On textarea `onChange` / `onSelect`, compute `activeAtQuery(value, caret)`. If `null`, clear suggestions and `suggestQuery`. If `""` (bare `@`), post `suggest_files` with `query: ""` (ext returns `[]`) and do not show a stale list. If non-empty, `setSuggestQuery(query)` and `scheduleSuggest(query)`.

- [ ] **Step 3: Keyboard + insert**

```ts
function insertPath(path: string) {
  const el = textareaRef.current;
  const value = input;
  const caret = el?.selectionStart ?? value.length;
  const upto = value.slice(0, caret);
  const atStart = upto.lastIndexOf("@");
  if (atStart < 0) {
    return;
  }
  const next = `${value.slice(0, atStart)}@${path} ${value.slice(caret)}`;
  setInput(next);
  setSuggestions([]);
  setSuggestQuery(null);
}
```

Use `atStart = upto.lastIndexOf("@")` only (simpler, correct for the regex).

Tab/Enter (when `suggestions.length > 0`) preventDefault and insert `suggestions[0]` (or highlighted index if you add arrow keys). Escape clears the popup. ArrowUp/ArrowDown optional; if you skip them, Tab/Enter always take `paths[0]`.

Render above the textarea:

```tsx
{suggestQuery !== null ? (
  <ul className="suggest" role="listbox">
    {suggestions.length === 0 ? (
      <li className="suggest-empty">No files</li>
    ) : (
      suggestions.map((path) => (
        <li key={path}>
          <button type="button" onClick={() => insertPath(path)}>
            {path}
          </button>
        </li>
      ))
    )}
  </ul>
) : null}
{hint ? <p className="composer-hint">{hint}</p> : null}
```

Add a button next to Send:

```tsx
<button
  type="button"
  disabled={busy}
  onClick={() => vscodeRef.current.postMessage({ type: "get_selection" })}
>
  Add selection
</button>
```

- [ ] **Step 4: CSS**

```css
.suggest {
  list-style: none;
  margin: 0 0 6px;
  padding: 4px;
  max-height: 160px;
  overflow: auto;
  border: 1px solid var(--vscode-widget-border, transparent);
  background: var(--vscode-editorWidget-background);
}
.suggest button {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  color: inherit;
  font: inherit;
  padding: 4px 6px;
  cursor: pointer;
}
.suggest-empty,
.composer-hint {
  opacity: 0.7;
  margin: 0 0 6px;
  font-size: 12px;
}
```

- [ ] **Step 5: Rebuild**

```
npm run build --prefix packages/extension
```

Expected: exit 0.

- [ ] **Step 6: Commit (optional)**

```
git add packages/extension/src/webview/App.tsx packages/extension/src/webview/App.css
git commit -m "feat(v3): add @ file complete and Add selection in the composer"
```

---

### Task 9: Verification

**Files:** none (run only)

- [ ] **Step 1: Full unit suite**

```
npx vitest run
```

in `packages/agent-core` and `packages/extension`. Expected: all PASS.

- [ ] **Step 2: Manual EDH (spec checklist)**

F5 → Palm Agent sidebar:

1. Ask a question that should not need tools — tokens append in **one** bubble; Stop remains available.
2. Ask to read `package.json` — one tool row running → done; no JSON in the assistant bubble.
3. Type `@package` — suggestions; pick one; send — agent calls `read_file`; the user message is only the string with `@path`.
4. Select code in an editor, Add selection, send — selection text is in the composer / user bubble.
5. Stop mid-stream — busy clears; no half tool call.

- [ ] **Step 3: Commit (optional)**

Only if leftover files remain from earlier tasks.

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|---|---|
| `stream: true` SSE, classify prose vs tool | 2, 3 |
| Incremental `NARRATION_EVENT`, no second narration at end | 3 |
| Abort skips `deliverCompletion` | 2, 3 |
| Append `assistant_delta` | 4 |
| Waiting hides on first prose; Stop stays | 4 |
| `tool_call` id + running/done | 1, 5, 6 |
| `onExternalModelMessage` silent | 5 |
| `@` path only, prefix glob, empty query skips fs | 7, 8 |
| Deferred B comment on `suggest_files` | 7 |
| Add selection / No selection hint | 7, 8 |
| Tests without live Ollama | 2–7 |
| `agent-core` has no `vscode` | 2, 3, 5, 7 (`suggest.ts` is pure) |
