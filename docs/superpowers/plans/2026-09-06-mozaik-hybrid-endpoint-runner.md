# Mozaik hybrid (endpoint stream + FunctionCallRunner) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route tool invoke formatting through Mozaik’s `DefaultFunctionCallRunner` and replace our Chat Completions HTTP/SSE client with `OpenAIChatCompletions.stream`, while keeping the custom turn loop, mid-stream UI (fence/narration/usage), and tool guards.

**Architecture:** Stay on `EditorAgent` / `ResearchWorker` turn loops (no `runLoop`). Expose `runtime.getFunctionCallRunner()` via `AgenticEnvironment`. For inference, call `OpenAIChatCompletions.stream` directly (not `DefaultInferenceRunner`, which filters model names), consume raw OpenAI chunks with existing `applyChatChunk` / `streamMode`, and treat the final `inference.output` event as the assembled completion.

**Tech Stack:** `@mozaik-ai/core` 4.0.6, Vitest, TypeScript strict, pnpm workspace `@palm-agent/agent-core`.

**Spec:** `docs/superpowers/specs/2026-09-06-mozaik-hybrid-endpoint-runner-design.md`

## Global Constraints

- Do **not** call Mozaik `runLoop` / `AgentLoop` / `FunctionCallState`.
- Do **not** route inference through `DefaultInferenceRunner` (model-name allowlist).
- Keep tool guards: unknown tool, identical-call cap, wind-down explore block, empty-completion recovery.
- Keep `streamMode` + narration mute on SEARCH fences; keep reasoning out of `ModelContext`.
- `@mozaik-ai/core` stays `^4.0.6` (string tool outputs already raw).
- `FunctionCallRunner` interface is **not** exported from `@mozaik-ai/core` 4.0.6 — define a local type with the same `run` signature.
- Commits: only when the user explicitly asks; otherwise skip every “Commit” step.

## File map

| File | Role |
|---|---|
| `packages/agent-core/src/runtime/function-call-runner.ts` | Local `FunctionCallRunner` type alias |
| `packages/agent-core/src/runtime/environment.ts` | `getFunctionCallRunner()` |
| `packages/agent-core/src/participants/editor-agent.ts` | Guard → runner → deliver |
| `packages/agent-core/src/research/worker.ts` | Same tool path |
| `packages/agent-core/src/model/mozaik-chat-endpoint.ts` | Build `OpenAIChatCompletions` + stream adapter |
| `packages/agent-core/src/model/local-inference.ts` | Use endpoint stream instead of raw `fetch` SSE |
| `docs/mozaik-divergences.md` | Update #1 / #2 after each slice |

---

### Task 1: Expose `getFunctionCallRunner` on `AgenticEnvironment`

**Files:**
- Create: `packages/agent-core/src/runtime/function-call-runner.ts`
- Modify: `packages/agent-core/src/runtime/environment.ts`
- Modify: `packages/agent-core/test/runtime/environment.test.ts`

**Interfaces:**
- Consumes: `defineRuntime().resolveRuntime().getFunctionCallRunner()` from Mozaik runtime
- Produces: `AgenticEnvironment.getFunctionCallRunner(): FunctionCallRunner` and exported local type

- [ ] **Step 1: Write the failing test**

Append to `packages/agent-core/test/runtime/environment.test.ts`:

```ts
it("exposes Mozaik DefaultFunctionCallRunner via getFunctionCallRunner", async () => {
  const environment = new AgenticEnvironment();
  const runner = environment.getFunctionCallRunner();
  const tool = {
    name: "echo",
    description: "echo",
    strict: true,
    type: "function" as const,
    parameters: { type: "object", properties: {}, required: [] },
    invoke: async () => "hello\nworld",
  };
  const item = await runner.run(
    FunctionCallItem.rehydrate({ callId: "c1", name: "echo", args: "{}" }),
    tool,
  );
  expect(item.callId).toBe("c1");
  expect(item.output.text).toBe("hello\nworld");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm exec pnpm -- --filter @palm-agent/agent-core exec vitest run test/runtime/environment.test.ts`

Expected: FAIL — `getFunctionCallRunner is not a function` (or compile error).

- [ ] **Step 3: Add local type + environment method**

Create `packages/agent-core/src/runtime/function-call-runner.ts`:

```ts
import type { FunctionCallItem, FunctionCallOutputItem, Tool } from "@mozaik-ai/core";

/** Mozaik's FunctionCallRunner is not exported from @mozaik-ai/core 4.0.6. */
export type FunctionCallRunner = {
  run(call: FunctionCallItem, tool: Tool): Promise<FunctionCallOutputItem>;
};
```

In `AgenticEnvironment` (`environment.ts`), add:

```ts
import type { FunctionCallRunner } from "./function-call-runner.js";

getFunctionCallRunner(): FunctionCallRunner {
  return this.api.resolveRuntime().getFunctionCallRunner();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm exec pnpm -- --filter @palm-agent/agent-core exec vitest run test/runtime/environment.test.ts`

Expected: PASS (string output is raw, not JSON-quoted).

- [ ] **Step 5: Commit** (skip unless user asked)

```bash
git add packages/agent-core/src/runtime/function-call-runner.ts packages/agent-core/src/runtime/environment.ts packages/agent-core/test/runtime/environment.test.ts
git commit -m "feat(agent-core): expose Mozaik FunctionCallRunner from environment"
```

---

### Task 2: EditorAgent — guards then Mozaik runner

**Files:**
- Modify: `packages/agent-core/src/participants/editor-agent.ts`
- Test: `packages/agent-core/test/participants/editor-agent.test.ts` (existing cases must keep passing)

**Interfaces:**
- Consumes: `environment.getFunctionCallRunner().run(call, tool)`
- Produces: same bus delivery; guard errors still `Error: …` strings without calling runner

- [ ] **Step 1: Confirm existing tool tests still describe the contract**

Existing tests already cover: identical-call block, unknown tool, bad JSON, throw → `Error:`, raw string output. No new test file required if behavior stays identical. Optionally add one spy test:

```ts
it("does not invoke the tool when identical-call guard fires", async () => {
  // same as existing "blocks a third identical call…" — assert ran === 2
});
```

(Reuse existing test; do not duplicate.)

- [ ] **Step 2: Refactor `invokeTool` / `runTool`**

Replace the successful-invoke branch so:

1. Guards (unknown tool, identical cap, wind-down explore, bad JSON) still return an error **string**; `invokeTool` wraps with `FunctionCallOutputItem.create`.
2. On the happy path + tool.invoke throw path: call Mozaik runner instead of local stringify.

Concrete shape for `invokeTool`:

```ts
private async invokeTool(item: FunctionCallItem, generation: number): Promise<void> {
  const started = Date.now();
  const guarded = this.guardTool(item);
  let outputItem: FunctionCallOutputItem;
  if (guarded !== null) {
    outputItem = FunctionCallOutputItem.create(item.callId, guarded);
  } else {
    const tool = this.tools.find((t) => t.name === item.name)!;
    try {
      outputItem = await this.environment.getFunctionCallRunner().run(item, tool);
      this.lastToolWasWrite = WRITE_TOOLS.has(item.name);
    } catch (error) {
      // Runner normally returns Error calling tool; this is delivery/runtime failure.
      this.lastToolWasWrite = false;
      outputItem = FunctionCallOutputItem.create(item.callId, `Error: ${sliceError(error)}`);
    }
  }
  this.onTrace?.(
    `tool ${item.name} (${item.callId}) done in ${Date.now() - started}ms, output=${outputItem.output.text.length}ch${
      outputItem.output.text.startsWith("Error") ? " (error fed back)" : ""
    }`,
  );
  try {
    this.environment.deliverFunctionCallOutput(this, outputItem);
  } catch (error) {
    this.pendingCalls.delete(item.callId);
    if (!this.isStale(generation)) {
      this.onFailed(sliceError(error), generation);
    }
  }
}
```

Move unknown-tool / identical / wind-down / bad-JSON checks into `guardTool(item): string | null` (return error text or `null` to proceed).

Delete local `typeof result === "string" ? result : JSON.stringify` path.

Update the old comment above `invokeTool` to:

```ts
/**
 * Runs the tool via Mozaik DefaultFunctionCallRunner (raw string outputs since
 * 4.0.6). Product guards (doom loop, wind-down, unknown name, bad JSON) short-
 * circuit before the runner and feed Error: … back as the call output.
 */
```

- [ ] **Step 3: Run editor-agent tests**

Run: `npm exec pnpm -- --filter @palm-agent/agent-core exec vitest run test/participants/editor-agent.test.ts`

Expected: PASS. If Mozaik runner’s throw path returns `Error calling tool:` instead of `Error:`, update the test that asserts `content.startsWith("Error:")` / contains message accordingly — prefer adjusting assertions to accept both prefixes **only** for runner-caught invoke throws; keep `Error:` for guards.

- [ ] **Step 4: Commit** (skip unless user asked)

```bash
git add packages/agent-core/src/participants/editor-agent.ts packages/agent-core/test/participants/editor-agent.test.ts
git commit -m "refactor(agent-core): run EditorAgent tools through Mozaik FunctionCallRunner"
```

---

### Task 3: ResearchWorker — same tool path

**Files:**
- Modify: `packages/agent-core/src/research/worker.ts`
- Test: `packages/agent-core/test/research/worker.test.ts`

**Interfaces:**
- Consumes: same `getFunctionCallRunner()` as Task 2
- Produces: identical worker behavior for guards + raw string outputs

- [ ] **Step 1: Mirror EditorAgent tool path in worker**

Apply the same `guardTool` + `getFunctionCallRunner().run` pattern in `ResearchWorker.invokeTool` / `runTool`. Worker has no wind-down explore set — keep only unknown / identical / bad-JSON guards.

- [ ] **Step 2: Run worker tests**

Run: `npm exec pnpm -- --filter @palm-agent/agent-core exec vitest run test/research/worker.test.ts`

Expected: PASS.

- [ ] **Step 3: Commit** (skip unless user asked)

```bash
git add packages/agent-core/src/research/worker.ts
git commit -m "refactor(agent-core): run research worker tools through Mozaik FunctionCallRunner"
```

---

### Task 4: Docs — Slice 1 closed in divergences

**Files:**
- Modify: `docs/mozaik-divergences.md`
- Modify: `docs/superpowers/specs/2026-09-06-mozaik-hybrid-endpoint-runner-design.md` (status → slice-1 done when true)

- [ ] **Step 1: Rewrite §2 and summary row**

§2 should say:
- Formatiranje izlaza ide preko `getFunctionCallRunner()` (Mozaik 4.0.6 raw strings).
- Ostaje naš path zbog guardova + participant turn loop; **ne** zbog stringify.
- Summary table row #2: glavni razlog = guardovi + turn loop, ne stringify.

Mark Slice 1 checkboxes in the design spec definition-of-done.

- [ ] **Step 2: Commit** (skip unless user asked)

```bash
git add docs/mozaik-divergences.md docs/superpowers/specs/2026-09-06-mozaik-hybrid-endpoint-runner-design.md
git commit -m "docs: record FunctionCallRunner hybrid for tool path"
```

---

### Task 5: Mozaik chat endpoint helper + unit test

**Files:**
- Create: `packages/agent-core/src/model/mozaik-chat-endpoint.ts`
- Create: `packages/agent-core/test/model/mozaik-chat-endpoint.test.ts`

**Interfaces:**
- Consumes: `OpenAIChatCompletions`, `InferenceInput`, `applyChatChunk`, `emptyAssembly`, `AssembledCompletion`
- Produces: `streamChatViaMozaikEndpoint(params) → Async generator or Promise<AssembledCompletion>` with prose deltas callback

- [ ] **Step 1: Write failing test for chunk vs inference.output split**

```ts
import { describe, expect, it, vi } from "vitest";
import { ModelContext, UserMessageItem } from "@mozaik-ai/core";
import { collectMozaikChatStream } from "../../src/model/mozaik-chat-endpoint.js";

describe("collectMozaikChatStream", () => {
  it("applies raw chunks then uses inference.output as the final assembly source for usage", async () => {
    const prose: string[] = [];
    const fakeEndpoint = {
      async *stream() {
        yield {
          choices: [{ delta: { content: "Hi" }, finish_reason: null }],
        };
        yield {
          type: "inference.output",
          payload: {
            items: [],
            tokenUsage: {
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 42,
            },
            rowResponse: {
              choices: [{ finish_reason: "stop", message: { content: "Hi" } }],
            },
          },
        };
      },
    };
    const assembled = await collectMozaikChatStream({
      endpoint: fakeEndpoint as never,
      input: {
        model: "test",
        streaming: true,
        context: (() => {
          const c = new ModelContext();
          c.addContextItem(UserMessageItem.create("x"));
          return c;
        })(),
      },
      onProseDelta: (d) => prose.push(d),
    });
    expect(prose.join("")).toBe("Hi");
    expect(assembled.content).toBe("Hi");
    expect(assembled.usage?.total_tokens).toBe(42);
  });
});
```

Adjust `tokenUsage` field names to match real `TokenUsage` getters in 4.0.6 (inspect `TokenUsage` in `index.d.ts` while implementing — use whatever the class exposes, e.g. `totalTokens` vs constructor args).

- [ ] **Step 2: Run test — expect FAIL**

Run: `npm exec pnpm -- --filter @palm-agent/agent-core exec vitest run test/model/mozaik-chat-endpoint.test.ts`

- [ ] **Step 3: Implement helper**

`packages/agent-core/src/model/mozaik-chat-endpoint.ts`:

```ts
import {
  OpenAIChatCompletions,
  type Endpoint,
  type InferenceInput,
} from "@mozaik-ai/core";
import {
  applyChatChunk,
  emptyAssembly,
  streamMode,
  type AssembledCompletion,
} from "./chat-stream.js";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "./config.js";

export function createMozaikChatEndpoint(options: {
  baseURL: string;
  apiKey: string;
  maxOutputTokens: number;
}): OpenAIChatCompletions {
  return new OpenAIChatCompletions(undefined, {
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    extraBody: {
      max_tokens: options.maxOutputTokens,
      stream_options: { include_usage: true },
    },
  });
}

function isInferenceOutput(
  event: unknown,
): event is { type: "inference.output"; payload: unknown } {
  return (
    !!event &&
    typeof event === "object" &&
    (event as { type?: string }).type === "inference.output"
  );
}

export async function collectMozaikChatStream(params: {
  endpoint: Pick<Endpoint, "stream">;
  input: InferenceInput;
  onProseDelta?: (delta: string) => void;
  signal?: AbortSignal;
}): Promise<AssembledCompletion> {
  const acc = emptyAssembly();
  let mode: "prose" | "tool" = "prose";
  for await (const event of params.endpoint.stream(params.input)) {
    if (params.signal?.aborted) {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      throw err;
    }
    if (isInferenceOutput(event)) {
      // Prefer content/tool_calls already accumulated from raw deltas.
      // Merge usage + finish_reason from final payload / rowResponse.
      const payload = event.payload as {
        tokenUsage?: { totalTokens?: number; /* + read real API */ };
        rowResponse?: {
          usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
          choices?: Array<{ finish_reason?: string | null }>;
        };
      };
      const row = payload.rowResponse;
      if (row?.usage?.total_tokens != null) {
        acc.usage = {
          prompt_tokens: row.usage.prompt_tokens ?? 0,
          completion_tokens: row.usage.completion_tokens ?? 0,
          total_tokens: row.usage.total_tokens,
        };
      }
      const fr = row?.choices?.[0]?.finish_reason;
      if (fr) {
        acc.finishReason = fr;
      }
      continue;
    }
    const { contentDelta } = applyChatChunk(acc, event);
    if (contentDelta && mode === "prose") {
      params.onProseDelta?.(contentDelta);
    }
    mode = streamMode(acc) === "tool" ? "tool" : mode;
    if (mode === "tool") {
      /* stop narrating further deltas — match chat-stream promote behavior */
    }
  }
  return acc;
}
```

Wire `promote` the same way `readSseChatCompletion` does (copy the mute-on-tool behavior from `chat-stream.ts` rather than inventing a weaker version). Prefer extracting a shared `consumeAssembledDeltas(acc, delta, mode, onProse)` if duplication is >10 lines.

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Commit** (skip unless user asked)

---

### Task 6: Switch `runLocalChatCompletions` to Mozaik endpoint

**Files:**
- Modify: `packages/agent-core/src/model/local-inference.ts`
- Modify: `packages/agent-core/test/model/local-inference.test.ts`

**Interfaces:**
- Consumes: `createMozaikChatEndpoint` + `collectMozaikChatStream`
- Produces: same bus side effects as today (`NARRATION_EVENT`, `CONTEXT_USAGE_EVENT`, function calls, model message)

- [ ] **Step 1: Keep `fetchImpl` as a test escape hatch OR adapt tests**

Existing tests mock `globalThis.fetch` / `fetchImpl` with SSE strings. Two options (pick one, prefer A for less churn):

**A (recommended):** If `params.fetchImpl` is set, keep the current SSE path (tests unchanged). Production path (no `fetchImpl`) uses Mozaik endpoint.

**B:** Rewrite tests to mock `OpenAIChatCompletions.stream` (heavier).

Implement A:

```ts
if (params.fetchImpl) {
  // existing readSseChatCompletion path
} else {
  const endpoint = createMozaikChatEndpoint({
    baseURL: configuredBaseUrl(),
    apiKey: process.env.OPENAI_API_KEY ?? "not-needed",
    maxOutputTokens,
  });
  assembled = await collectMozaikChatStream({
    endpoint,
    input: {
      model: params.model,
      maxOutputTokens,
      streaming: true,
      tools: params.tools,
      context: params.context,
    },
    onProseDelta: (text) => { /* same narration deliverSemanticEvent */ },
    signal: params.signal,
  });
  // then same post-processing as today (empty recovery, propose_edit, etc.)
}
```

- [ ] **Step 2: Run local-inference + editor-agent + worker tests**

Run: `npm exec pnpm -- --filter @palm-agent/agent-core exec vitest run test/model/local-inference.test.ts test/participants/editor-agent.test.ts test/research/worker.test.ts`

Expected: PASS.

- [ ] **Step 3: Manual smoke (optional):** F5 / one chat turn against DeepSeek — narracija, tool call, read_file raw text in context.

- [ ] **Step 4: Commit** (skip unless user asked)

```bash
git commit -m "refactor(agent-core): stream chat completions via Mozaik OpenAIChatCompletions"
```

---

### Task 7: Docs — Slice 2 + definition of done

**Files:**
- Modify: `docs/mozaik-divergences.md` (§1)
- Modify: `docs/superpowers/specs/2026-09-06-mozaik-hybrid-endpoint-runner-design.md`

- [ ] **Step 1: Update divergences §1**

New reason for remaining divergence: we still own turn loop + post-parse (SEARCH→propose_edit, empty recovery); we use Mozaik **endpoint** not `DefaultInferenceRunner` / `runLoop`. Mid-stream still processed locally from raw chunks the endpoint yields.

- [ ] **Step 2: Tick definition-of-done in the design spec**

- [ ] **Step 3: Commit** (skip unless user asked)

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| `getFunctionCallRunner` on environment | 1 |
| Guards before runner; raw strings via Mozaik | 2, 3 |
| Divergences #2 update | 4 |
| `OpenAIChatCompletions.stream` + raw chunks + `inference.output` | 5, 6 |
| No `DefaultInferenceRunner` / no `runLoop` | Global + 6 |
| `extraBody` max_tokens + stream_options usage | 5 |
| `fetchImpl` / test parity | 6 option A |
| Divergences #1 + DoD | 7 |

## Placeholder scan

None intentional. TokenUsage property names in Task 5 test must be verified against `index.d.ts` at implement time (called out inline).

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-06-mozaik-hybrid-endpoint-runner.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — this session, task-by-task with checkpoints  

Which approach?
