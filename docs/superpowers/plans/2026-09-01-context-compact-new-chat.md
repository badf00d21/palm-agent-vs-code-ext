# Context Compact + New Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stub old tool bodies before every inference, slide the model context to the last 3 turns at 80% window use, and let the human start a clean chat without a confirm dialog.

**Architecture:** Pure `compactContext` mutates `ModelContext.getItems()` in `EditorAgent.run` before `runLocalChatCompletions`. `lastUsed` comes from `context_usage`; `max` is injected by `sessionHost` from `/api/ps`. New chat is `reviewStore.clear()` + `session.reset()` + `{ type: "session_cleared" }`. Slide emits `{ type: "context_trimmed" }` as a status line; the visible transcript is not deleted.

**Tech Stack:** TypeScript, Vitest, `@mozaik-ai/core` `ModelContext` / `SemanticEvent`, existing webview `postMessage` protocol

## Global Constraints

- `packages/agent-core` has zero `import 'vscode'` and does not call Ollama `/api/*`
- Stub text is exactly `[omitted from context; call again if needed]`
- `KEEP_TURNS = 3`; `SLIDE_RATIO = 0.8`
- Slide only when `lastUsed` is a finite number, `max` is a number `> 0`, `lastUsed / max >= 0.8`, and there are more than 3 `UserMessageItem`s
- `trimmed === true` only when turns were dropped, never for stub-only
- Compact does not throw
- New chat: no confirm, no keybinding; disabled while busy or chat empty
- Pending review is dropped with no `diff_settled`
- Host tokens only; no header bar; New chat is a secondary composer button
- Status copy is exactly `Context trimmed to last 3 turns`
- pnpm may be missing: run `packages/*/node_modules/.bin/vitest`
- No LLM summary, no ring color thresholds, no `numCtx` setting

## File map

- `packages/agent-core/src/context/compact.ts` — `compactContext`, constants, `CONTEXT_TRIMMED_EVENT`
- `packages/agent-core/test/context/compact.test.ts` — stub + slide
- `packages/agent-core/src/participants/editor-agent.ts` — compact before inference, emit trim event
- `packages/agent-core/src/participants/ui-bridge.ts` — map trim event
- `packages/agent-core/src/session/session.ts` — `reset`, `setLastUsed`, `setContextMax`, rebuild environment
- `packages/shared/src/index.ts` — `new_chat`, `session_cleared`, `context_trimmed`
- `packages/extension/src/sessionHost.ts` — feed budget from `context_usage`
- `packages/extension/src/reviewStore.ts` — `clear()`
- `packages/extension/src/webview/chatMessages.ts` — status line
- `packages/extension/src/webview/App.tsx` + `App.css` — New chat button, status bubble, `session_cleared`
- `packages/extension/src/chatViewProvider.ts` + `extension.ts` + `package.json` — route + command
- `packages/extension/DESIGN.md` — Status label + New chat secondary

---

### Task 1: `compactContext`

**Files:**
- Create: `packages/agent-core/src/context/compact.ts`
- Test: `packages/agent-core/test/context/compact.test.ts`

**Produces:**
- `KEEP_TURNS = 3`
- `SLIDE_RATIO = 0.8`
- `STUB_TEXT = "[omitted from context; call again if needed]"`
- `CONTEXT_TRIMMED_EVENT = "context_trimmed"`
- `CompactBudget { lastUsed?: number; max: number | null }`
- `compactContext(items: ContextItem[], budget: CompactBudget): { trimmed: boolean }` — mutates `items` in place

- [ ] **Step 1: Write the failing test**

Create `packages/agent-core/test/context/compact.test.ts`:

```ts
import {
  DeveloperMessageItem,
  FunctionCallItem,
  FunctionCallOutputItem,
  ModelContext,
  ModelMessageItem,
  UserMessageItem,
} from "@mozaik-ai/core";
import { describe, expect, it } from "vitest";
import { compactContext, STUB_TEXT } from "../../src/context/compact.js";

function addTurn(
  ctx: ModelContext,
  user: string,
  tool?: { callId: string; output: string },
): void {
  ctx.addContextItem(UserMessageItem.create(user));
  if (!tool) {
    ctx.addContextItem(ModelMessageItem.rehydrate({ text: "ok" }));
    return;
  }
  ctx.addContextItem(
    FunctionCallItem.rehydrate({
      callId: tool.callId,
      name: "read_file",
      args: '{"path":"a.ts"}',
    }),
  );
  ctx.addContextItem(FunctionCallOutputItem.create(tool.callId, tool.output));
  ctx.addContextItem(ModelMessageItem.rehydrate({ text: "ok" }));
}

function users(ctx: ModelContext): string[] {
  return ctx
    .getItems()
    .filter((item) => item instanceof UserMessageItem)
    .map((item) => item.content.text);
}

function outputText(ctx: ModelContext, callId: string): string | undefined {
  const item = ctx
    .getItems()
    .find((entry) => entry instanceof FunctionCallOutputItem && entry.callId === callId);
  return item instanceof FunctionCallOutputItem ? item.output.text : undefined;
}

describe("compactContext", () => {
  it("stubs older-turn tool output and leaves the latest turn intact", () => {
    const ctx = ModelContext.create("t");
    ctx.addContextItem(DeveloperMessageItem.create("sys"));
    addTurn(ctx, "first", { callId: "c1", output: "FILE BODY" });
    addTurn(ctx, "second", { callId: "c2", output: "NEW BODY" });
    const { trimmed } = compactContext(ctx.getItems(), { max: null });
    expect(trimmed).toBe(false);
    expect(outputText(ctx, "c1")).toBe(STUB_TEXT);
    expect(outputText(ctx, "c2")).toBe("NEW BODY");
    const call = ctx.getItems().find((item) => item instanceof FunctionCallItem);
    expect(call).toMatchObject({ callId: "c1", name: "read_file" });
  });

  it("slides to the last 3 user turns when over 80%", () => {
    const ctx = ModelContext.create("t");
    ctx.addContextItem(DeveloperMessageItem.create("sys"));
    addTurn(ctx, "t1");
    addTurn(ctx, "t2");
    addTurn(ctx, "t3");
    addTurn(ctx, "t4");
    const { trimmed } = compactContext(ctx.getItems(), { lastUsed: 9000, max: 10000 });
    expect(trimmed).toBe(true);
    expect(users(ctx)).toEqual(["t2", "t3", "t4"]);
    expect(ctx.getItems()[0]).toBeInstanceOf(DeveloperMessageItem);
  });

  it("does not slide below 80% and still stubs older outputs", () => {
    const ctx = ModelContext.create("t");
    ctx.addContextItem(DeveloperMessageItem.create("sys"));
    addTurn(ctx, "t1", { callId: "c1", output: "OLD" });
    addTurn(ctx, "t2");
    addTurn(ctx, "t3");
    addTurn(ctx, "t4");
    const { trimmed } = compactContext(ctx.getItems(), { lastUsed: 7000, max: 10000 });
    expect(trimmed).toBe(false);
    expect(users(ctx)).toEqual(["t1", "t2", "t3", "t4"]);
    expect(outputText(ctx, "c1")).toBe(STUB_TEXT);
  });

  it("does not slide when max is null", () => {
    const ctx = ModelContext.create("t");
    ctx.addContextItem(DeveloperMessageItem.create("sys"));
    addTurn(ctx, "t1");
    addTurn(ctx, "t2");
    addTurn(ctx, "t3");
    addTurn(ctx, "t4");
    const { trimmed } = compactContext(ctx.getItems(), { lastUsed: 9000, max: null });
    expect(trimmed).toBe(false);
    expect(users(ctx)).toHaveLength(4);
  });

  it("does not slide when already at 3 turns over the ratio", () => {
    const ctx = ModelContext.create("t");
    ctx.addContextItem(DeveloperMessageItem.create("sys"));
    addTurn(ctx, "t1");
    addTurn(ctx, "t2");
    addTurn(ctx, "t3");
    const { trimmed } = compactContext(ctx.getItems(), { lastUsed: 9000, max: 10000 });
    expect(trimmed).toBe(false);
    expect(users(ctx)).toHaveLength(3);
  });

  it("is idempotent after a slide", () => {
    const ctx = ModelContext.create("t");
    ctx.addContextItem(DeveloperMessageItem.create("sys"));
    addTurn(ctx, "t1", { callId: "c1", output: "OLD" });
    addTurn(ctx, "t2");
    addTurn(ctx, "t3");
    addTurn(ctx, "t4");
    compactContext(ctx.getItems(), { lastUsed: 9000, max: 10000 });
    const snapshot = ctx.getItems().map((item) => item);
    const again = compactContext(ctx.getItems(), { lastUsed: 9000, max: 10000 });
    expect(again.trimmed).toBe(false);
    expect(ctx.getItems()).toEqual(snapshot);
    expect(outputText(ctx, "c1")).toBeUndefined();
  });

  it("no-ops on system-only context", () => {
    const ctx = ModelContext.create("t");
    ctx.addContextItem(DeveloperMessageItem.create("sys"));
    expect(compactContext(ctx.getItems(), { lastUsed: 9000, max: 10000 })).toEqual({
      trimmed: false,
    });
    expect(ctx.getItems()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `packages/agent-core/node_modules/.bin/vitest run test/context/compact.test.ts`

Expected: FAIL — cannot find module `../../src/context/compact.js`

- [ ] **Step 3: Write minimal implementation**

Create `packages/agent-core/src/context/compact.ts`:

```ts
import {
  FunctionCallOutputItem,
  UserMessageItem,
  type ContextItem,
} from "@mozaik-ai/core";

export const KEEP_TURNS = 3;
export const SLIDE_RATIO = 0.8;
export const STUB_TEXT = "[omitted from context; call again if needed]";
export const CONTEXT_TRIMMED_EVENT = "context_trimmed";

export interface CompactBudget {
  lastUsed?: number;
  max: number | null;
}

function userStarts(items: ContextItem[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < items.length; i += 1) {
    if (items[i] instanceof UserMessageItem) {
      starts.push(i);
    }
  }
  return starts;
}

function shouldSlide(budget: CompactBudget): boolean {
  const { lastUsed, max } = budget;
  return (
    typeof lastUsed === "number" &&
    Number.isFinite(lastUsed) &&
    typeof max === "number" &&
    max > 0 &&
    lastUsed / max >= SLIDE_RATIO
  );
}

export function compactContext(
  items: ContextItem[],
  budget: CompactBudget,
): { trimmed: boolean } {
  const starts = userStarts(items);
  const lastStart = starts[starts.length - 1] ?? items.length;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!(item instanceof FunctionCallOutputItem)) {
      continue;
    }
    if (i >= lastStart) {
      continue;
    }
    if (item.output.text === STUB_TEXT) {
      continue;
    }
    items[i] = FunctionCallOutputItem.create(item.callId, STUB_TEXT);
  }
  const afterStub = userStarts(items);
  if (!shouldSlide(budget) || afterStub.length <= KEEP_TURNS) {
    return { trimmed: false };
  }
  const keepFrom = afterStub[afterStub.length - KEEP_TURNS]!;
  const prefixEnd = afterStub[0]!;
  items.splice(prefixEnd, keepFrom - prefixEnd);
  return { trimmed: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `packages/agent-core/node_modules/.bin/vitest run test/context/compact.test.ts`

Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/agent-core/src/context/compact.ts packages/agent-core/test/context/compact.test.ts
git commit -m "feat: compact old tool bodies and slide to last 3 turns"
```

---

### Task 2: Protocol + UIBridge `context_trimmed`

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/agent-core/src/participants/ui-bridge.ts`
- Modify: `packages/agent-core/test/participants/ui-bridge.test.ts`

**Consumes:** `CONTEXT_TRIMMED_EVENT` from Task 1

**Produces:**
- `WebviewToExt` member `{ type: "new_chat" }`
- `ExtToWebview` members `{ type: "session_cleared" }` and `{ type: "context_trimmed" }`
- `eventFromContextTrimmed(item: SemanticEvent<unknown>): ExtToWebview | null`

- [ ] **Step 1: Write the failing test**

Append to `packages/agent-core/test/participants/ui-bridge.test.ts` (add imports `CONTEXT_TRIMMED_EVENT` from `../../src/context/compact.js` and `eventFromContextTrimmed`):

```ts
  it("maps a context_trimmed event", () => {
    expect(eventFromContextTrimmed(new SemanticEvent(CONTEXT_TRIMMED_EVENT, {}))).toEqual({
      type: "context_trimmed",
    });
  });

  it("ignores other events in eventFromContextTrimmed", () => {
    expect(eventFromContextTrimmed(new SemanticEvent("other", {}))).toBeNull();
  });
```

In the `UIBridge narration forwarding` describe, add:

```ts
  it("forwards context_trimmed through onExternalEvent to the sink", () => {
    const events: ExtToWebview[] = [];
    const bridge = new UIBridge(() => (event) => events.push(event));
    bridge.onExternalEvent(new BaseParticipant(), new SemanticEvent(CONTEXT_TRIMMED_EVENT, {}));
    expect(events).toEqual([{ type: "context_trimmed" }]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `packages/agent-core/node_modules/.bin/vitest run test/participants/ui-bridge.test.ts`

Expected: FAIL — `eventFromContextTrimmed` is not exported / `context_trimmed` is not assignable to `ExtToWebview`

- [ ] **Step 3: Write minimal implementation**

In `packages/shared/src/index.ts` add to `WebviewToExt`:

```ts
  | { type: "new_chat" }
```

Add to `ExtToWebview`:

```ts
  | { type: "session_cleared" }
  | { type: "context_trimmed" };
```

In `packages/agent-core/src/participants/ui-bridge.ts` import `CONTEXT_TRIMMED_EVENT` from `../context/compact.js` and add:

```ts
export function eventFromContextTrimmed(item: SemanticEvent<unknown>): ExtToWebview | null {
  if (item.getType() !== CONTEXT_TRIMMED_EVENT) {
    return null;
  }
  return { type: "context_trimmed" };
}
```

Change `onExternalEvent` to:

```ts
    const event =
      eventFromContextUsage(item) ?? eventFromNarration(item) ?? eventFromContextTrimmed(item);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `packages/agent-core/node_modules/.bin/vitest run test/participants/ui-bridge.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/index.ts packages/agent-core/src/participants/ui-bridge.ts packages/agent-core/test/participants/ui-bridge.test.ts
git commit -m "feat: map context_trimmed onto the webview protocol"
```

---

### Task 3: EditorAgent compact before inference

**Files:**
- Modify: `packages/agent-core/src/participants/editor-agent.ts`
- Modify: `packages/agent-core/test/participants/editor-agent.test.ts`

**Consumes:** `compactContext`, `CompactBudget`, `CONTEXT_TRIMMED_EVENT` from Task 1; UIBridge mapping from Task 2

**Produces:**
- `EditorAgent` constructor last parameter `getBudget: () => CompactBudget = () => ({ max: null })`
- `run()` calls `compactContext(this.context.getItems(), this.getBudget())` then, if `trimmed`, `environment.deliverSemanticEvent(this, new SemanticEvent(CONTEXT_TRIMMED_EVENT, {}))`, then `runLocalChatCompletions` as today

- [ ] **Step 1: Write the failing test**

Add imports to `packages/agent-core/test/participants/editor-agent.test.ts`: `DeveloperMessageItem`, `FunctionCallOutputItem`, `ModelMessageItem`, `UserMessageItem`, `STUB_TEXT` from compact, `UIBridge`.

Append a new describe (reuse the file's `beforeEach` fetch mock — put the describe **inside** the existing `describe("EditorAgent tool failure feedback")` or give it the same fetch `beforeEach`. Simplest: add tests at the end of the existing describe):

```ts
  it("stubs prior-turn tool output before the next inference", async () => {
    const environment = new AgenticEnvironment();
    const context = ModelContext.create("test");
    context.addContextItem(DeveloperMessageItem.create("sys"));
    context.addContextItem(UserMessageItem.create("first"));
    context.addContextItem(
      FunctionCallItem.rehydrate({ callId: "c1", name: "echo", args: "{}" }),
    );
    context.addContextItem(FunctionCallOutputItem.create("c1", "FILE BODY"));
    context.addContextItem(ModelMessageItem.rehydrate({ text: "done" }));
    const agent = new EditorAgent(
      environment,
      context,
      [echoTool("x")],
      "gemma4:12b",
      () => undefined,
      () => undefined,
    );
    agent.join(environment);
    agent.markActive(environment);
    agent.beginTurn(2, new AbortController().signal);
    agent.onMessage("second");
    await vi.waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    const tool = bodies[0]?.messages.find((m) => m.role === "tool");
    expect(tool?.content).toBe(STUB_TEXT);
    expect(tool?.tool_call_id).toBe("c1");
  });

  it("slides to 3 user turns and emits context_trimmed", async () => {
    const environment = new AgenticEnvironment();
    const context = ModelContext.create("test");
    context.addContextItem(DeveloperMessageItem.create("sys"));
    context.addContextItem(UserMessageItem.create("t1"));
    context.addContextItem(UserMessageItem.create("t2"));
    context.addContextItem(UserMessageItem.create("t3"));
    const events: ExtToWebview[] = [];
    const agent = new EditorAgent(
      environment,
      context,
      [echoTool("x")],
      "gemma4:12b",
      () => undefined,
      () => undefined,
      undefined,
      undefined,
      undefined,
      () => ({ lastUsed: 9000, max: 10000 }),
    );
    const ui = new UIBridge(() => (event) => events.push(event));
    agent.join(environment);
    ui.join(environment);
    agent.markActive(environment);
    agent.beginTurn(4, new AbortController().signal);
    agent.onMessage("t4");
    await vi.waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    const userTexts = (bodies[0]?.messages ?? [])
      .filter((m) => m.role === "user")
      .map((m) => m.content);
    expect(userTexts).toEqual(["t2", "t3", "t4"]);
    expect(events.some((e) => e.type === "context_trimmed")).toBe(true);
  });
```

Add `import type { ExtToWebview } from "@palm-agent/shared";` if missing.

- [ ] **Step 2: Run test to verify it fails**

Run: `packages/agent-core/node_modules/.bin/vitest run test/participants/editor-agent.test.ts`

Expected: FAIL — first request still contains `FILE BODY`, or 4 user messages, or no `context_trimmed`

- [ ] **Step 3: Write minimal implementation**

In `packages/agent-core/src/participants/editor-agent.ts`:

Add imports: `SemanticEvent` from `@mozaik-ai/core`; `compactContext`, `CONTEXT_TRIMMED_EVENT`, type `CompactBudget` from `../context/compact.js`.

Add constructor parameter after `onTrace`:

```ts
    private readonly getBudget: () => CompactBudget = () => ({ max: null }),
```

At the start of `run()`, after the `MAX_INFERENCE_STEPS` guard and before `onTrace` / `runLocalChatCompletions`:

```ts
    const { trimmed } = compactContext(this.context.getItems(), this.getBudget());
    if (trimmed) {
      this.environment.deliverSemanticEvent(this, new SemanticEvent(CONTEXT_TRIMMED_EVENT, {}));
    }
```

Do not change existing tests' `new EditorAgent(...)` call sites — the new argument is optional with a default.

- [ ] **Step 4: Run test to verify it passes**

Run: `packages/agent-core/node_modules/.bin/vitest run test/participants/editor-agent.test.ts`

Expected: PASS (including the two new tests)

- [ ] **Step 5: Commit**

```bash
git add packages/agent-core/src/participants/editor-agent.ts packages/agent-core/test/participants/editor-agent.test.ts
git commit -m "feat: compact ModelContext before each local inference step"
```

---

### Task 4: Session `reset` + budget setters

**Files:**
- Modify: `packages/agent-core/src/session/session.ts`
- Modify: `packages/agent-core/test/session/session.test.ts`

**Consumes:** `CompactBudget` / `EditorAgent` `getBudget` from Task 3

**Produces:**
- `AgentSession.reset(): void` — no-op if `busy`; otherwise new `AgenticEnvironment` + `ModelContext` (system prompt only) + new agent/UI/user joined; same `sink`; `lastUsed = undefined`; `contextMax` unchanged; does **not** call `cancel`
- `AgentSession.setLastUsed(used: number): void`
- `AgentSession.setContextMax(max: number | null): void`
- `EditorAgent` constructed with `() => ({ lastUsed, max: contextMax })`

- [ ] **Step 1: Write the failing test**

Append to `packages/agent-core/test/session/session.test.ts` inside the existing `describe` that already mocks `fetch` (the file has `afterEach` restoring fetch — add tests that set `globalThis.fetch` themselves, same as the cancel test).

```ts
  it("reset drops prior turns from the next request", async () => {
    const bodies: Array<{ messages: Array<{ role: string; content?: string | null }> }> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string | null }> });
      const body =
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n` +
        "data: [DONE]\n\n";
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    const session = createAgentSession(
      fakePort(),
      { baseUrl: "http://localhost:11434/v1", model: "gemma4:12b", apiKey: "not-needed" },
      () => undefined,
      { merge: (files) => ({ id: "rev_test", paths: files.map((f) => f.path) }) },
    );
    await session.startTurn("first");
    session.reset();
    await session.startTurn("second");
    const last = bodies[bodies.length - 1]!;
    const userTexts = last.messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(userTexts).toEqual(["second"]);
    expect(session.busy).toBe(false);
  });

  it("reset is a no-op while a turn is in flight", async () => {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const abort = (): void => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (init?.signal?.aborted) {
          abort();
          return;
        }
        init?.signal?.addEventListener("abort", abort, { once: true });
      });
    }) as typeof fetch;

    const session = createAgentSession(
      fakePort(),
      { baseUrl: "http://localhost:11434/v1", model: "gemma4:12b", apiKey: "not-needed" },
      () => undefined,
      { merge: (files) => ({ id: "rev_test", paths: files.map((f) => f.path) }) },
    );
    const running = session.startTurn("hello");
    expect(session.busy).toBe(true);
    session.reset();
    expect(session.busy).toBe(true);
    session.cancel();
    await running;
    expect(session.busy).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `packages/agent-core/node_modules/.bin/vitest run test/session/session.test.ts`

Expected: FAIL — `session.reset is not a function`

- [ ] **Step 3: Write minimal implementation**

In `packages/agent-core/src/session/session.ts`:

Extend `AgentSession`:

```ts
export interface AgentSession {
  readonly busy: boolean;
  startTurn(text: string): Promise<void>;
  cancel(): void;
  setSink(sink: SessionEventSink): void;
  reset(): void;
  setLastUsed(used: number): void;
  setContextMax(max: number | null): void;
}
```

Inside `createAgentSession`, replace the one-shot `const environment / context / agent / ui / user` with `let` and a `rebuild()` function. Hold budget in the closure:

```ts
  let lastUsed: number | undefined;
  let contextMax: number | null = null;
  let environment = new AgenticEnvironment();
  let context = ModelContext.create("palm-agent");
  let user = new BaseParticipant();
  let agent: EditorAgent;
  let ui: UIBridge;

  const getBudget = (): CompactBudget => ({ lastUsed, max: contextMax });

  const rebuild = (): void => {
    environment = new AgenticEnvironment();
    context = ModelContext.create("palm-agent");
    context.addContextItem(DeveloperMessageItem.create(SYSTEM_PROMPT));
    user = new BaseParticipant();
    agent = new EditorAgent(
      environment,
      context,
      tools,
      config.model,
      (fromGeneration) => finish(fromGeneration, { type: "done" }),
      (message, fromGeneration) => finish(fromGeneration, { type: "error", message }),
      (fromGeneration) => bumpIdleTimer(fromGeneration),
      (fromGeneration) => bumpInferenceTimer(fromGeneration),
      trace,
      getBudget,
    );
    ui = new UIBridge(() => sink);
    agent.join(environment);
    ui.join(environment);
    user.join(environment);
  };

  rebuild();
```

Import type `CompactBudget` from `../context/compact.js`. `tools` stays created once (`createWorkspaceTools`).

On the returned object:

```ts
      reset() {
        if (busy) {
          return;
        }
        lastUsed = undefined;
        rebuild();
      },
      setLastUsed(used: number) {
        lastUsed = used;
      },
      setContextMax(max: number | null) {
        contextMax = max;
      },
```

`startTurn` still uses `agent`, `environment`, `user` from the closure (the current rebuild).

- [ ] **Step 4: Run test to verify it passes**

Run: `packages/agent-core/node_modules/.bin/vitest run test/session/session.test.ts`

Expected: PASS. Then run `packages/agent-core/node_modules/.bin/vitest run` and fix any `AgentSession` object-literal misses.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-core/src/session/session.ts packages/agent-core/test/session/session.test.ts
git commit -m "feat: reset the agent session without cancelling an in-flight turn"
```

---

### Task 5: `sessionHost` feeds budget

**Files:**
- Modify: `packages/extension/src/sessionHost.ts`

**Consumes:** `AgentSession.setLastUsed`, `setContextMax`, `reset` from Task 4

**Produces:** wrapper `session` forwards `reset`, `setLastUsed`, `setContextMax`. On `context_usage`, call `session.setLastUsed(event.used)` then existing `attachMax`, then `session.setContextMax(full.max)` before `rawSink(full)`.

No new test file (no VS Code). `tsc` / existing extension tests must still typecheck.

- [ ] **Step 1: Change `const session` so `emit` can call it**

Replace the bottom of `createSessionHost` with:

```ts
  let session!: AgentSession;
  const emit = (event: ExtToWebview): void => {
    if (event.type === "context_usage") {
      session.setLastUsed(event.used);
      void contextWindow.attachMax(event.used).then((full) => {
        session.setContextMax(full.max);
        trace(`event ${full.type} used=${full.used} max=${full.max ?? "null"}`);
        rawSink(full);
      });
      return;
    }
    trace(`event ${event.type}${event.type === "error" ? `: ${event.message.slice(0, 160)}` : ""}`);
    rawSink(event);
  };
  const store = createReviewStore({
    emit,
    readFile: (path) => port.readFile(path),
    exists: (path) => port.exists(path),
    applyFiles,
    readOpenText,
  });
  session = createAgentSession(port, readModelConfig(), emit, store, trace);
  return {
    session: {
      get busy() {
        return session.busy;
      },
      startTurn: (text) => session.startTurn(text),
      cancel: () => session.cancel(),
      reset: () => session.reset(),
      setLastUsed: (used) => session.setLastUsed(used),
      setContextMax: (max) => session.setContextMax(max),
      setSink(sink) {
        rawSink = sink;
      },
    },
    store,
    port,
  };
```

Delete the old `const emit` / `const session` duplicates so there is one of each.

- [ ] **Step 2: Typecheck**

Run: `packages/extension/node_modules/.bin/tsc --noEmit -p packages/extension/tsconfig.json`

Expected: exit 0. If `tsc` complains the wrapper is missing `reset` / `setLastUsed` / `setContextMax`, add those forwards — they are required by `AgentSession`.

- [ ] **Step 3: Commit**

```bash
git add packages/extension/src/sessionHost.ts
git commit -m "feat: push token usage and context max into the agent budget"
```

---

### Task 6: `reviewStore.clear`

**Files:**
- Modify: `packages/extension/src/reviewStore.ts`
- Modify: `packages/extension/src/reviewStore.test.ts`

**Produces:**
- `ReviewStore.clear(): void` — if no pending, no-op; else remember paths, `pending = undefined`, `notifyProposedChange` each path, **do not** emit `diff_settled`

- [ ] **Step 1: Write the failing test**

Append to `packages/extension/src/reviewStore.test.ts`:

```ts
  it("clear drops pending without diff_settled", async () => {
    const events: unknown[] = [];
    const changed: string[] = [];
    const store = createReviewStore({
      emit: (e) => events.push(e),
      readFile: async () => "a",
      exists: async () => "file",
      applyFiles: async () => undefined,
      createId: () => "rev_1",
    });
    store.onDidChangeProposed((path) => changed.push(path));
    store.merge([{ path: "a.ts", original: "a", proposed: "b", kind: "edit" }]);
    events.length = 0;
    store.clear();
    expect(events).toEqual([]);
    expect(changed).toEqual(["a.ts", "a.ts"]);
    expect(await store.apply("rev_1")).toEqual({ type: "error", message: "No pending review" });
    store.clear();
    expect(await store.apply("rev_1")).toEqual({ type: "error", message: "No pending review" });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `packages/extension/node_modules/.bin/vitest run src/reviewStore.test.ts`

Expected: FAIL — `store.clear is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `ReviewStore`:

```ts
  clear(): void;
```

Inside `createReviewStore`, before `return`:

```ts
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
```

Add `clear` to the returned object.

- [ ] **Step 4: Run test to verify it passes**

Run: `packages/extension/node_modules/.bin/vitest run src/reviewStore.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/reviewStore.ts packages/extension/src/reviewStore.test.ts
git commit -m "feat: drop a pending review on clear without emitting settled"
```

---

### Task 7: Webview message reducer

**Files:**
- Modify: `packages/extension/src/webview/chatMessages.ts`
- Modify: `packages/extension/src/webview/chatMessages.test.ts`

**Consumes:** `{ type: "context_trimmed" }` and `{ type: "session_cleared" }` from Task 2

**Produces:**
- `StatusLine { role: "status"; text: string }`
- `ChatLine` includes `StatusLine`
- `applyExtMessage` on `context_trimmed` appends `{ role: "status", text: "Context trimmed to last 3 turns" }`
- `applyExtMessage` on `session_cleared` returns `messages` unchanged (same reference)
- `shouldClearBusy` is false for both

- [ ] **Step 1: Write the failing test**

Append to `packages/extension/src/webview/chatMessages.test.ts`:

```ts
  it("appends a status line on context_trimmed", () => {
    const prev: ChatLine[] = [{ role: "user", text: "x" }];
    const next = applyExtMessage(prev, { type: "context_trimmed" });
    expect(next).toEqual([
      { role: "user", text: "x" },
      { role: "status", text: "Context trimmed to last 3 turns" },
    ]);
  });

  it("ignores session_cleared in the reducer", () => {
    const prev: ChatLine[] = [{ role: "user", text: "x" }];
    expect(applyExtMessage(prev, { type: "session_cleared" })).toBe(prev);
  });

  it("does not clear busy on context_trimmed or session_cleared", () => {
    expect(shouldClearBusy({ type: "context_trimmed" })).toBe(false);
    expect(shouldClearBusy({ type: "session_cleared" })).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `packages/extension/node_modules/.bin/vitest run src/webview/chatMessages.test.ts`

Expected: FAIL — no status line / `ChatLine` has no `status` role

- [ ] **Step 3: Write minimal implementation**

In `packages/extension/src/webview/chatMessages.ts` add:

```ts
export interface StatusLine {
  role: "status";
  text: string;
}
```

Change `ChatLine` to `TextLine | ToolLine | ReviewLine | StatusLine`.

In `applyExtMessage`, before the final `return messages`:

```ts
  if (msg.type === "context_trimmed") {
    return [...messages, { role: "status", text: "Context trimmed to last 3 turns" }];
  }
```

`session_cleared` already falls through to `return messages` (same reference). Leave it.

- [ ] **Step 4: Run test to verify it passes**

Run: `packages/extension/node_modules/.bin/vitest run src/webview/chatMessages.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/webview/chatMessages.ts packages/extension/src/webview/chatMessages.test.ts
git commit -m "feat: render context trim as a status chat line"
```

---

### Task 8: New chat button + status bubble

**Files:**
- Modify: `packages/extension/src/webview/App.tsx`
- Modify: `packages/extension/src/webview/App.css`
- Modify: `packages/extension/DESIGN.md`

**Consumes:** Task 7 `StatusLine`; Task 2 protocol

**Produces:** New chat secondary button; App handles `session_cleared` by resetting `messages` and `context` and `busy`; `context_trimmed` goes through `applyExtMessage` without clearing busy; Status label + bubble

- [ ] **Step 1: Update `roleLabel` and the message handler**

In `packages/extension/src/webview/App.tsx`, change `roleLabel`:

```ts
function roleLabel(role: ChatLine["role"]): string {
  if (role === "user") {
    return "You";
  }
  if (role === "tool") {
    return "Tool";
  }
  if (role === "review") {
    return "Review";
  }
  if (role === "status") {
    return "Status";
  }
  return "Agent";
}
```

In the `onMessage` listener, handle `session_cleared` **before** `context_usage`:

```ts
      if (msg.type === "session_cleared") {
        setMessages([]);
        setContext(null);
        setBusy(false);
        return;
      }
```

Leave `context_usage` as today. `context_trimmed` must **not** return early — it falls through to `applyExtMessage`. `shouldClearBusy` stays false for it.

In the bubble render, status uses the same plain `<p>{message.text}</p>` branch as user/tool (not `AssistantMarkdown`, not `ReviewCard`). Add CSS class `status` via existing `` `bubble ${message.role}` ``.

In `composer-buttons`, **before** Add selection:

```tsx
            <button
              type="button"
              className="secondary"
              disabled={busy || messages.length === 0}
              onClick={() => vscodeRef.current.postMessage({ type: "new_chat" })}
            >
              New chat
            </button>
```

- [ ] **Step 2: CSS + DESIGN.md**

Add to `packages/extension/src/webview/App.css` after `.bubble.review`:

```css
.bubble.status {
  background: transparent;
  opacity: 0.85;
}
```

In `packages/extension/DESIGN.md`:

- Buttons / Secondary: `Add selection and New chat use {colors.button-secondary-bg} / {colors.button-secondary-fg}.`
- Hierarchy / Label: add `Status` next to `You` / `Agent` / `Tool` / `Review`
- Message bubble signature: include status (plain text, no markdown)

- [ ] **Step 3: Typecheck webview + reducer tests**

Run:

```
packages/extension/node_modules/.bin/vitest run src/webview/chatMessages.test.ts
packages/extension/node_modules/.bin/tsc --noEmit -p packages/extension/tsconfig.json
```

Expected: both exit 0. `roleLabel` must handle `"status"` or `ChatLine` exhaustiveness fails.

- [ ] **Step 4: Commit**

```bash
git add packages/extension/src/webview/App.tsx packages/extension/src/webview/App.css packages/extension/DESIGN.md
git commit -m "feat: add New chat control and a status bubble for trimmed context"
```

---

### Task 9: Route `new_chat` + command

**Files:**
- Modify: `packages/extension/src/chatViewProvider.ts`
- Modify: `packages/extension/src/extension.ts`
- Modify: `packages/extension/package.json`

**Consumes:** `session.reset`, `store.clear`, `{ type: "new_chat" }`, `{ type: "session_cleared" }`

**Produces:**
- `ChatViewProvider.newChat()` — if `session.busy`, return; else `store.clear()`, `session.reset()`, `post?.({ type: "session_cleared" })`
- `routeMessage` case `"new_chat"` calls `newChat()`
- Command `palmAgent.newChat`, title `Palm Agent: New Chat`, activation `onCommand:palmAgent.newChat`, no keybinding

- [ ] **Step 1: Implement provider methods**

In `packages/extension/src/chatViewProvider.ts` add a field:

```ts
  private post: ((event: ExtToWebview) => void) | undefined;
```

In `resolveWebviewView`, after creating `post`, set `this.post = post`.

Add:

```ts
  newChat(): void {
    if (this.host.session.busy) {
      return;
    }
    this.host.store.clear();
    this.host.session.reset();
    this.post?.({ type: "session_cleared" });
  }
```

In `routeMessage` add:

```ts
      case "new_chat":
        this.newChat();
        return;
```

- [ ] **Step 2: Register the command**

In `packages/extension/package.json`:

`activationEvents` add `"onCommand:palmAgent.newChat"`.

In `contributes.commands` add:

```json
      {
        "command": "palmAgent.newChat",
        "title": "Palm Agent: New Chat"
      }
```

In `packages/extension/src/extension.ts`, inside the same `subscriptions.push`, add:

```ts
      vscode.commands.registerCommand("palmAgent.newChat", () => {
        provider.newChat();
      }),
```

`provider` is already in scope from `const provider = new ChatViewProvider(...)`.

- [ ] **Step 3: Run package tests**

Run:

```
packages/agent-core/node_modules/.bin/vitest run
packages/extension/node_modules/.bin/vitest run
```

Expected: PASS both packages.

- [ ] **Step 4: Commit**

```bash
git add packages/extension/src/chatViewProvider.ts packages/extension/src/extension.ts packages/extension/package.json
git commit -m "feat: wire New chat from the webview and the command palette"
```

---

## Manual check (not a task gate)

F5 Extension Development Host:

1. Empty chat → New chat disabled.
2. One question → New chat enabled; click → empty state, ring gone, composer text stays, no `Cancelled`.
3. Propose an edit, New chat → review card gone; Keep All on a stale id is `"No pending review"` if you still had a way to send it (you should not).
4. Four user turns with a fat `read_file` in turn 1, ring ≥ 80% → status line `Context trimmed to last 3 turns`; older bubbles still visible; next answer does not quote the stubbed file body unless it re-reads.
5. Stop in-flight → New chat disabled while Stop shows; after error/done, New chat works.
6. Command Palette `Palm Agent: New Chat` same as the button.

---

## Spec coverage

| Spec item | Task |
|---|---|
| Stub older tool outputs | 1, 3 |
| Slide at 80% to 3 turns | 1, 3 |
| No slide if `max`/`lastUsed` missing | 1 |
| `context_trimmed` event + status copy | 2, 7, 8 |
| Chat transcript kept on slide | 8 (no message delete except New chat) |
| `session.reset` + busy no-op | 4 |
| Budget from usage + `/api/ps` | 5 |
| `reviewStore.clear` no `diff_settled` | 6 |
| New chat button, disabled empty/busy | 8 |
| `session_cleared` App reset | 8, 9 |
| Command palette, no keybinding | 9 |
| DESIGN.md Status + secondary | 8 |
| No vscode in agent-core | 1–4 |
| No LLM summary | not implemented |
