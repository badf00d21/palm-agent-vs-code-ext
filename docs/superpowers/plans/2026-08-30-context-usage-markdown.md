# Context Usage + Markdown Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a compact composer context ring from Ollama `usage` + `/api/ps`, and render Agent bubbles as GFM without syntax highlight.

**Architecture:** `agent-core` parses OpenAI `usage` from the final SSE chunk and emits a `context_usage` semantic event. `UIBridge` maps it to `{ type: "context_usage", used }`. `sessionHost` attaches `max` from native `/api/ps` (cached by model). The webview renders a 14px ring and `react-markdown` + `remark-gfm` for assistant prose only.

**Tech Stack:** TypeScript, Vitest, Ollama OpenAI `/v1/chat/completions` + `/api/ps`, `react-markdown`, `remark-gfm`

## Global Constraints

- `packages/agent-core` has zero `import 'vscode'` and does not call Ollama `/api/*`
- `used = usage.total_tokens` after every inference step
- `max` is loaded-model `context_length` from `/api/ps`, never `/api/show`
- No `usage` → no `context_usage` event; chat still completes
- `/api/ps` fail / missing model / missing field → `max: null`; ring 0%; tooltip is `4.2k` only
- One `/api/ps` attempt per usage when cache is empty; cache successful `max` by model name
- Agent markdown: GFM headings, bold/italic, lists, links, fenced/inline code; no `rehype-raw`; no highlight
- User / tool / review / `Error: …` stay plain text
- Links: only `http`, `https`, `mailto` via `{ type: "open_url", url }` → `vscode.env.openExternal`; fail silently
- Ring: ~14px SVG in `composer-actions`, left of buttons; track `--vscode-widget-border`; fill `--vscode-progressBar-background`; numbers only in `title`
- Host tokens only; no hex; no header bar
- pnpm may be missing: run `packages/*/node_modules/.bin/vitest`
- Do not add syntax highlight, tables styling, clear-context, or a model picker

## File map

- `packages/agent-core/src/model/chat-stream.ts` — parse `usage` on chunks
- `packages/agent-core/src/model/local-inference.ts` — `stream_options.include_usage`, emit `CONTEXT_USAGE_EVENT`
- `packages/agent-core/src/participants/ui-bridge.ts` — map to `{ type: "context_usage", used }`
- `packages/shared/src/index.ts` — `context_usage` + `open_url`
- `packages/extension/src/contextWindow.ts` — `/v1` → `/api/ps`, parse `context_length`, cache
- `packages/extension/src/sessionHost.ts` — attach `max`
- `packages/extension/src/chatViewProvider.ts` — `open_url`
- `packages/extension/src/webview/contextMeter.ts` — tooltip + ring ratio
- `packages/extension/src/webview/markdown.tsx` — assistant GFM
- `packages/extension/src/webview/chatMessages.ts` — ignore `context_usage`
- `packages/extension/src/webview/App.tsx` + `App.css` — ring + markdown
- `packages/extension/package.json` — `react-markdown`, `remark-gfm`

---

### Task 1: Parse `usage` from SSE

**Files:**
- Modify: `packages/agent-core/src/model/chat-stream.ts`
- Test: `packages/agent-core/test/model/chat-stream.test.ts`

**Produces:**
- `AssembledCompletion.usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }`
- `applyChatChunk` writes `usage` when the chunk has a numeric `usage.total_tokens`, even if `choices` is empty

- [ ] **Step 1: Write the failing test**

Append to `packages/agent-core/test/model/chat-stream.test.ts`:

```ts
it("records usage from a final chunk with empty choices", () => {
  const acc = emptyAssembly();
  applyChatChunk(acc, { choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] });
  applyChatChunk(acc, {
    choices: [],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  });
  expect(acc.content).toBe("Hi");
  expect(acc.usage).toEqual({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
});

it("leaves usage unset when the stream has no usage field", () => {
  const acc = emptyAssembly();
  applyChatChunk(acc, { choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] });
  expect(acc.usage).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `packages/agent-core/node_modules/.bin/vitest run test/model/chat-stream.test.ts`

Expected: FAIL — `usage` is undefined / property does not exist

- [ ] **Step 3: Write minimal implementation**

In `AssembledCompletion` add:

```ts
usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
```

At the start of `applyChatChunk`, before reading `choices`:

```ts
if (chunk && typeof chunk === "object") {
  const raw = (chunk as { usage?: unknown }).usage;
  if (raw && typeof raw === "object") {
    const total = (raw as { total_tokens?: unknown }).total_tokens;
    if (typeof total === "number" && Number.isFinite(total)) {
      const prompt = (raw as { prompt_tokens?: unknown }).prompt_tokens;
      const completion = (raw as { completion_tokens?: unknown }).completion_tokens;
      acc.usage = {
        prompt_tokens: typeof prompt === "number" ? prompt : 0,
        completion_tokens: typeof completion === "number" ? completion : 0,
        total_tokens: total,
      };
    }
  }
}
```

Keep the existing early return when `choices[0]` is missing so an empty-choices usage chunk does not throw.

- [ ] **Step 4: Run test to verify it passes**

Run: `packages/agent-core/node_modules/.bin/vitest run test/model/chat-stream.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agent-core/src/model/chat-stream.ts packages/agent-core/test/model/chat-stream.test.ts
git commit -m "feat: parse token usage from chat SSE chunks"
```

---

### Task 2: Request `include_usage` and emit `context_usage`

**Files:**
- Modify: `packages/agent-core/src/model/local-inference.ts`
- Test: `packages/agent-core/test/model/local-inference.test.ts`

**Consumes:** `AssembledCompletion.usage`
**Produces:**
- `export const CONTEXT_USAGE_EVENT = "context_usage"`
- `export interface ContextUsagePayload { used: number }`
- Request body includes `stream_options: { include_usage: true }`
- After a successful assembly, if `usage.total_tokens` is a finite number, `deliverSemanticEvent` with `{ used: total_tokens }`

- [ ] **Step 1: Write the failing test**

In the existing `runLocalChatCompletions` describe, add:

```ts
it("sends stream_options.include_usage and emits context_usage from total_tokens", async () => {
  const events: Array<{ type: string; data: unknown }> = [];
  const environment = {
    deliverSemanticEvent: (_caller: unknown, item: SemanticEvent<unknown>) => {
      events.push({ type: item.getType(), data: item.data });
    },
    deliverModelMessage: () => undefined,
    deliverFunctionCall: () => {
      throw new Error("unexpected function call");
    },
  } as unknown as AgenticEnvironment;

  const context = ModelContext.create("test");
  context.addContextItem(UserMessageItem.create("hi"));

  await runLocalChatCompletions({
    model: "gemma4:12b",
    context,
    tools: [],
    environment,
    caller: new BaseParticipant(),
    onFailed: () => undefined,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        stream_options?: { include_usage?: boolean };
      };
      expect(body.stream_options?.include_usage).toBe(true);
      const chunks = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`,
        "data: [DONE]\n\n",
      ].join("");
      return new Response(chunks, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    },
  });

  expect(events.some((e) => e.type === "context_usage" && (e.data as { used: number }).used === 12)).toBe(true);
});

it("does not emit context_usage when the stream has no usage", async () => {
  const types: string[] = [];
  const environment = {
    deliverSemanticEvent: (_caller: unknown, item: SemanticEvent<unknown>) => {
      types.push(item.getType());
    },
    deliverModelMessage: () => undefined,
    deliverFunctionCall: () => {
      throw new Error("unexpected function call");
    },
  } as unknown as AgenticEnvironment;
  const context = ModelContext.create("test");
  context.addContextItem(UserMessageItem.create("hi"));
  await runLocalChatCompletions({
    model: "gemma4:12b",
    context,
    tools: [],
    environment,
    caller: new BaseParticipant(),
    onFailed: () => undefined,
    fetchImpl: async () =>
      sseResponse([{ delta: { content: "ok" }, finish_reason: "stop" }]),
  });
  expect(types).not.toContain("context_usage");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `packages/agent-core/node_modules/.bin/vitest run test/model/local-inference.test.ts`

Expected: FAIL — `stream_options` missing and/or no `context_usage` event

- [ ] **Step 3: Write minimal implementation**

Export next to `NARRATION_EVENT`:

```ts
export const CONTEXT_USAGE_EVENT = "context_usage";

export interface ContextUsagePayload {
  used: number;
}
```

In the request body, after `body.stream = true`:

```ts
body.stream_options = { include_usage: true };
```

After `readSseChatCompletion` returns and `isCurrentTurn` is true, before empty-content failure handling:

```ts
const used = assembled.usage?.total_tokens;
if (typeof used === "number" && Number.isFinite(used)) {
  params.environment.deliverSemanticEvent(
    params.caller,
    new SemanticEvent<ContextUsagePayload>(CONTEXT_USAGE_EVENT, { used }),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `packages/agent-core/node_modules/.bin/vitest run test/model/local-inference.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agent-core/src/model/local-inference.ts packages/agent-core/test/model/local-inference.test.ts
git commit -m "feat: emit context_usage from completion token totals"
```

---

### Task 3: UIBridge + shared protocol

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/agent-core/src/participants/ui-bridge.ts`
- Test: `packages/agent-core/test/participants/ui-bridge.test.ts`
- Test: `packages/extension/src/webview/chatMessages.test.ts`
- Modify: `packages/extension/src/webview/chatMessages.ts`

**Produces:**
- `ExtToWebview` includes `{ type: "context_usage"; used: number; max: number | null }`
- `WebviewToExt` includes `{ type: "open_url"; url: string }`
- `eventFromContextUsage` → `{ type: "context_usage", used, max: null }` (host fills `max`)
- `applyExtMessage` returns the same array reference for `context_usage`

- [ ] **Step 1: Write the failing tests**

`ui-bridge.test.ts`:

```ts
import { CONTEXT_USAGE_EVENT } from "../../src/model/local-inference.js";
import { eventFromContextUsage } from "../../src/participants/ui-bridge.js";

it("maps a context_usage event", () => {
  expect(
    eventFromContextUsage(new SemanticEvent(CONTEXT_USAGE_EVENT, { used: 4200 })),
  ).toEqual({ type: "context_usage", used: 4200, max: null });
});

it("ignores context_usage without a finite used", () => {
  expect(eventFromContextUsage(new SemanticEvent(CONTEXT_USAGE_EVENT, {}))).toBeNull();
});
```

Also assert `onExternalEvent` forwards it.

`chatMessages.test.ts`:

```ts
it("ignores context_usage", () => {
  const prev: ChatLine[] = [{ role: "user", text: "x" }];
  expect(applyExtMessage(prev, { type: "context_usage", used: 10, max: 100 })).toBe(prev);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
- `packages/agent-core/node_modules/.bin/vitest run test/participants/ui-bridge.test.ts`
- `packages/extension/node_modules/.bin/vitest run src/webview/chatMessages.test.ts`

Expected: FAIL — exports / union members missing

- [ ] **Step 3: Write minimal implementation**

`shared/src/index.ts` — add the two union members.

`ui-bridge.ts`:

```ts
import { CONTEXT_USAGE_EVENT, NARRATION_EVENT } from "../model/local-inference.js";

export function eventFromContextUsage(item: SemanticEvent<unknown>): ExtToWebview | null {
  if (item.getType() !== CONTEXT_USAGE_EVENT) {
    return null;
  }
  const used = (item.data as { used?: unknown } | null | undefined)?.used;
  if (typeof used !== "number" || !Number.isFinite(used)) {
    return null;
  }
  return { type: "context_usage", used, max: null };
}
```

In `onExternalEvent`, try `eventFromContextUsage` then `eventFromNarration`.

`applyExtMessage`: `context_usage` falls through to `return messages` (same as `done`).

- [ ] **Step 4: Run tests to verify they pass**

Same vitest commands. Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/index.ts packages/agent-core/src/participants/ui-bridge.ts packages/agent-core/test/participants/ui-bridge.test.ts packages/extension/src/webview/chatMessages.ts packages/extension/src/webview/chatMessages.test.ts
git commit -m "feat: map context_usage onto the webview protocol"
```

---

### Task 4: `/api/ps` window + sessionHost attach

**Files:**
- Create: `packages/extension/src/contextWindow.ts`
- Test: `packages/extension/src/contextWindow.test.ts`
- Modify: `packages/extension/src/sessionHost.ts`

**Produces:**
- `export function ollamaNativeOrigin(baseUrl: string): string` — strip a trailing `/v1` (and extra slashes)
- `export function parseLoadedContextLength(payload: unknown, model: string): number | null`
- `export function createContextWindow(deps: { fetchImpl: typeof fetch; baseUrl: () => string; model: () => string }): { attachMax(used: number): Promise<{ type: "context_usage"; used: number; max: number | null }> }`
- Match `models[]` entry whose `name` or `model` equals the configured model; read numeric `context_length`
- Cache successful `max` per model name; on failure leave cache empty so the next usage retries once
- `sessionHost` `emit` intercepts `context_usage` and replaces `max` via `attachMax` (do not block other events)

- [ ] **Step 1: Write the failing tests**

`packages/extension/src/contextWindow.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createContextWindow, ollamaNativeOrigin, parseLoadedContextLength } from "./contextWindow";

describe("ollamaNativeOrigin", () => {
  it("strips a trailing /v1", () => {
    expect(ollamaNativeOrigin("http://localhost:11434/v1")).toBe("http://localhost:11434");
    expect(ollamaNativeOrigin("http://localhost:11434/v1/")).toBe("http://localhost:11434");
  });
});

describe("parseLoadedContextLength", () => {
  const payload = {
    models: [{ name: "gemma4:12b", model: "gemma4:12b", context_length: 16384 }],
  };
  it("reads context_length for the configured model", () => {
    expect(parseLoadedContextLength(payload, "gemma4:12b")).toBe(16384);
  });
  it("returns null when the model is missing", () => {
    expect(parseLoadedContextLength(payload, "other")).toBeNull();
    expect(parseLoadedContextLength({ models: [] }, "gemma4:12b")).toBeNull();
    expect(parseLoadedContextLength({}, "gemma4:12b")).toBeNull();
  });
});

describe("createContextWindow", () => {
  it("attaches max from /api/ps and caches the second call", async () => {
    let calls = 0;
    const window = createContextWindow({
      baseUrl: () => "http://localhost:11434/v1",
      model: () => "gemma4:12b",
      fetchImpl: async (url) => {
        calls += 1;
        expect(String(url)).toBe("http://localhost:11434/api/ps");
        return new Response(
          JSON.stringify({ models: [{ name: "gemma4:12b", context_length: 16384 }] }),
          { status: 200 },
        );
      },
    });
    await expect(window.attachMax(4210)).resolves.toEqual({
      type: "context_usage",
      used: 4210,
      max: 16384,
    });
    await expect(window.attachMax(5000)).resolves.toEqual({
      type: "context_usage",
      used: 5000,
      max: 16384,
    });
    expect(calls).toBe(1);
  });

  it("returns max null when /api/ps fails", async () => {
    const window = createContextWindow({
      baseUrl: () => "http://localhost:11434/v1",
      model: () => "gemma4:12b",
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    await expect(window.attachMax(12)).resolves.toEqual({
      type: "context_usage",
      used: 12,
      max: null,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `packages/extension/node_modules/.bin/vitest run src/contextWindow.test.ts`

Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

`ollamaNativeOrigin`: `baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "")`.

`parseLoadedContextLength`: if `payload.models` is an array, find entry where `name === model || model === model`, return `context_length` if it is a finite number, else null.

`createContextWindow`: keep `{ modelName, max }` when fetch succeeds with a number. On throw / !ok / null parse, do not store max. `attachMax` GETs `${origin}/api/ps`.

In `sessionHost`, construct `createContextWindow` with `fetch` and `readModelConfig`. In `emit`, if `event.type === "context_usage"`, `void attachMax(event.used).then((full) => { trace(...); rawSink(full); })` and return. Other events stay sync.

- [ ] **Step 4: Run test to verify it passes**

Run: `packages/extension/node_modules/.bin/vitest run src/contextWindow.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/contextWindow.ts packages/extension/src/contextWindow.test.ts packages/extension/src/sessionHost.ts
git commit -m "feat: attach loaded num_ctx from Ollama /api/ps"
```

---

### Task 5: Tooltip helper + composer ring

**Files:**
- Create: `packages/extension/src/webview/contextMeter.ts`
- Test: `packages/extension/src/webview/contextMeter.test.ts`
- Modify: `packages/extension/src/webview/App.tsx`
- Modify: `packages/extension/src/webview/App.css`

**Produces:**
- `export function formatContextTooltip(used: number, max: number | null): string`
- `export function contextRingRatio(used: number, max: number | null): number` — `0` when max is null or `<= 0`; otherwise `min(1, used / max)`
- Token format: `< 1000` as the integer; otherwise one decimal `k` with trailing `.0` stripped (`4210 → 4.2k`, `16384 → 16k`)

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { contextRingRatio, formatContextTooltip } from "./contextMeter";

describe("formatContextTooltip", () => {
  it("formats thousands with a / max", () => {
    expect(formatContextTooltip(4210, 16384)).toBe("4.2k / 16k");
  });
  it("omits max when null", () => {
    expect(formatContextTooltip(4210, null)).toBe("4.2k");
  });
});

describe("contextRingRatio", () => {
  it("is 0 without a max and clamps above 1", () => {
    expect(contextRingRatio(4210, null)).toBe(0);
    expect(contextRingRatio(18000, 16384)).toBe(1);
    expect(contextRingRatio(8192, 16384)).toBe(0.5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `packages/extension/node_modules/.bin/vitest run src/webview/contextMeter.test.ts`

Expected: FAIL — module not found

- [ ] **Step 3: Write helper + ring UI**

`formatContextTooltip` / `contextRingRatio` as specified.

In `App.tsx`:
- State: `context: { used: number; max: number | null } | null` starts `null`
- On `msg.type === "context_usage"`, `setContext({ used: msg.used, max: msg.max })` and do not treat it as a chat line (already ignored by `applyExtMessage`)
- In `.composer-actions`, before the buttons, if `context` is set, render a 14×14 SVG circle (`r=5.5`, `stroke-width=2`, circumference `2πr`). Track uses widget-border; dashoffset fill uses progressBar. `title={formatContextTooltip(...)}`. `aria-label` same string. `aria-hidden` false.

`.composer-actions`: `width: 100%`, `justify-content: space-between`, `align-items: center`. Wrap the two buttons in `<div className="composer-buttons">`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `packages/extension/node_modules/.bin/vitest run src/webview/contextMeter.test.ts src/webview/chatMessages.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/webview/contextMeter.ts packages/extension/src/webview/contextMeter.test.ts packages/extension/src/webview/App.tsx packages/extension/src/webview/App.css
git commit -m "feat: show a compact context ring in the composer"
```

---

### Task 6: Assistant markdown + open_url

**Files:**
- Modify: `packages/extension/package.json` — add `react-markdown` and `remark-gfm` dependencies
- Create: `packages/extension/src/webview/markdown.tsx`
- Create: `packages/extension/src/webview/markdown.test.ts`
- Modify: `packages/extension/src/webview/App.tsx`
- Modify: `packages/extension/src/webview/App.css`
- Modify: `packages/extension/src/chatViewProvider.ts`

**Produces:**
- `export function isSafeMarkdownUrl(href: string | undefined): boolean` — `http:`, `https:`, `mailto:`
- `export function isPlainErrorText(text: string): boolean` — `text.startsWith("Error: ")`
- `AssistantMarkdown` uses `react-markdown` + `remark-gfm`, no raw HTML. Custom `a` prevents default and calls `onOpenUrl(href)` only when safe; otherwise render children as a span.
- Class component error boundary falls back to `<p>{text}</p>`
- `open_url` in `routeMessage`: if `isSafeMarkdownUrl`, `void vscode.env.openExternal(vscode.Uri.parse(url))`; no error event on failure

- [ ] **Step 1: Install deps**

From `packages/extension`: add `"react-markdown"` and `"remark-gfm"` to `dependencies` and run `npm install` in that package (or repo-root `pnpm install` if the lockfile is pnpm). Prefer the same installer the repo already uses.

- [ ] **Step 2: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { AssistantMarkdown, isPlainErrorText, isSafeMarkdownUrl } from "./markdown";

describe("isSafeMarkdownUrl", () => {
  it("allows http(s) and mailto only", () => {
    expect(isSafeMarkdownUrl("https://example.com")).toBe(true);
    expect(isSafeMarkdownUrl("http://localhost")).toBe(true);
    expect(isSafeMarkdownUrl("mailto:a@b.c")).toBe(true);
    expect(isSafeMarkdownUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeMarkdownUrl("vscode://file")).toBe(false);
  });
});

describe("isPlainErrorText", () => {
  it("detects Error: prefix", () => {
    expect(isPlainErrorText("Error: boom")).toBe(true);
    expect(isPlainErrorText("**ok**")).toBe(false);
  });
});

describe("AssistantMarkdown", () => {
  it("renders bold and a fenced code block", () => {
    const html = renderToStaticMarkup(
      createElement(AssistantMarkdown, { text: "**x**\n\n```\ncode\n```", onOpenUrl: () => undefined }),
    );
    expect(html).toContain("<strong>x</strong>");
    expect(html).toContain("<pre>");
    expect(html).toContain("code");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `packages/extension/node_modules/.bin/vitest run src/webview/markdown.test.ts`

Expected: FAIL — module not found

- [ ] **Step 4: Write markdown + wire App and open_url**

Implement `markdown.tsx` as specified. In `App.tsx`, for `role === "assistant"` and not `isPlainErrorText`, wrap with the error boundary + `AssistantMarkdown`. `onOpenUrl` posts `{ type: "open_url", url }`.

CSS (host tokens only):

```css
.bubble.assistant .md p { margin: 0 0 0.6em; white-space: normal; }
.bubble.assistant .md p:last-child { margin-bottom: 0; }
.bubble.assistant .md pre {
  margin: 0.4em 0;
  padding: 8px;
  overflow: auto;
  font-family: var(--vscode-editor-font-family);
  font-size: 12px;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-widget-border);
  border-radius: 6px;
}
.bubble.assistant .md code { font-family: var(--vscode-editor-font-family); }
.bubble.assistant .md a { color: var(--vscode-textLink-foreground); }
.bubble.assistant .md ul, .bubble.assistant .md ol { margin: 0.4em 0; padding-left: 1.2em; }
.bubble.assistant .md h1, .bubble.assistant .md h2, .bubble.assistant .md h3 {
  font-size: inherit;
  font-weight: 600;
  margin: 0.6em 0 0.3em;
}
```

`chatViewProvider.ts` `open_url` case as specified. Import `isSafeMarkdownUrl` from the webview file only if the extension build can resolve it; otherwise duplicate the three-scheme check in a tiny `packages/extension/src/safeUrl.ts` used by both, to avoid pulling React into the extension bundle. Prefer `packages/extension/src/safeUrl.ts` shared by provider + markdown.

- [ ] **Step 5: Run tests to verify they pass**

Run:
- `packages/extension/node_modules/.bin/vitest run src/webview/markdown.test.ts src/webview/chatMessages.test.ts src/contextWindow.test.ts`
- `packages/agent-core/node_modules/.bin/vitest run`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/extension/package.json packages/extension/src/webview/markdown.tsx packages/extension/src/webview/markdown.test.ts packages/extension/src/webview/App.tsx packages/extension/src/webview/App.css packages/extension/src/chatViewProvider.ts packages/extension/src/safeUrl.ts
git commit -m "feat: render agent chat as GFM markdown"
```

---

### Task 7: Spec status + full test sweep

**Files:**
- Modify: `docs/superpowers/specs/2026-08-30-context-usage-markdown-design.md` — `Status: odobren`

- [ ] **Step 1: Flip spec status to odobren**
- [ ] **Step 2: Run both packages' vitest**

Expected: all PASS

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-08-30-context-usage-markdown-design.md docs/superpowers/plans/2026-08-30-context-usage-markdown.md
git commit -m "docs: approve context usage markdown spec and plan"
```
