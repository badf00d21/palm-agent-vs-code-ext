# v1 Mozaik Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the v0 echo with an in-process Mozaik agent that can read the workspace through four tools and answer in the sidebar chat.

**Architecture:** `agent-core` owns `AgenticEnvironment`, `EditorAgent`, `UIBridge`, tool schemas, and `createAgentSession`. The extension injects `WorkspacePort` (VS Code fs / active editor / ripgrep), reads Ollama settings, and forwards `ExtToWebview` events to the webview. `runInference` is fire-and-forget; the session becomes idle when the agent emits `onModelMessage` with no pending tool calls (or on error).

**Tech Stack:** `@mozaik-ai/core` ^3.13.0 (match `jigjoy-ai/cli-agent-starter`), Vitest, existing Vite/esbuild extension, `@vscode/ripgrep`, Ollama Chat Completions.

**Spec:** `docs/superpowers/specs/2026-08-29-v1-mozaik-loop-design.md`

## Global Constraints

- `packages/agent-core` has zero `import 'vscode'` (and no `require('vscode')`).
- Ollama only: default `palmAgent.model` = `qwen3:14b`, `palmAgent.ollamaBaseUrl` = `http://localhost:11434/v1`, `apiKey` literal `not-needed`.
- Model names matching `gpt-*` / `chatgpt-*` / `o1`–`o9` / `text-*` / `davinci*` are rejected before inference.
- No `propose_edit`, no token streaming, no `cancel` handling, no `.env` loading in the extension host.
- Shared protocol types are not extended.
- Error copy is verbatim from the spec (`Empty message`, `Agent is busy`, `No workspace folder open`, `Cannot reach Ollama at <baseUrl>. Is it running?`, `Model name routes to the wrong API. Use a local Ollama name such as qwen3:14b.`).
- Commits are owned by the human; treat each Task's commit step as optional.

## File structure

| File | Responsibility |
|---|---|
| `packages/agent-core/src/paths.ts` | Resolve/reject workspace-relative paths |
| `packages/agent-core/src/config.ts` | `ModelConfig` + forbidden-name check |
| `packages/agent-core/src/port.ts` | `WorkspacePort` + DTOs |
| `packages/agent-core/src/session-guards.ts` | Pure `startTurn` preconditions |
| `packages/agent-core/src/tools.ts` | Four Mozaik `Tool` objects |
| `packages/agent-core/src/participants/editor-agent.ts` | Inference + tool loop |
| `packages/agent-core/src/participants/ui-bridge.ts` | Observer → `ExtToWebview` |
| `packages/agent-core/src/session.ts` | `createAgentSession` |
| `packages/agent-core/src/index.ts` | Public exports |
| `packages/extension/src/workspacePort.ts` | VS Code + ripgrep port |
| `packages/extension/src/sessionHost.ts` | Settings → session |
| `packages/extension/src/webview/chatMessages.ts` | Pure message reducer for UI + tests |
| `packages/extension/src/echo.ts` | Deleted after wiring |

**Mozaik API to copy (cli-agent-starter, `@mozaik-ai/core` ^3.13.0):**

- Classes: `BaseParticipant` (not `BaseAgentParticipant`).
- Capabilities: `sendMessage(environment, text, caller)`, `runInference({ model, tools, context, environment, caller })`, `executeFunctionCall(environment, item, tool, caller)`.
- `runInference` / `executeFunctionCall` return `void`.
- Tool shape: `{ name, description, parameters, strict: true, type: "function", invoke }`.
- Items: `DeveloperMessageItem`, `UserMessageItem`, `FunctionCallItem`, `FunctionCallOutputItem`, `ModelMessageItem`.
- Observer: `onExternalModelMessage(source, item)`, `onExternalFunctionCall(source, item)`.
- Env: set `process.env.OPENAI_BASE_URL` and `process.env.OPENAI_API_KEY` before the first `runInference`.

If the installed package rejects unknown model ids, inspect its exports for a custom/OpenAI-compatible registration helper and use `qwen3:14b` through Chat Completions. Do not rename the user-facing setting to a `gpt-*` id.

---

### Task 1: Workspace path helper

**Files:**
- Create: `packages/agent-core/src/paths.ts`
- Create: `packages/agent-core/src/paths.test.ts`
- Create: `packages/agent-core/vitest.config.ts`
- Modify: `packages/agent-core/package.json`
- Modify: `package.json` (root `test` already runs `-r`)

**Interfaces:**
- Consumes: nothing
- Produces: `toPosix(p: string): string`, `resolveWorkspacePath(workspaceRoot: string, input: string): string`, `toWorkspaceRelative(workspaceRoot: string, absPath: string): string`

- [ ] **Step 1: Add agent-core test runner**

`packages/agent-core/package.json`:

```json
{
  "name": "@palm-agent/agent-core",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./src/index.ts"
    }
  },
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.8.3",
    "vitest": "^3.1.2"
  }
}
```

`packages/agent-core/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
```

Run from repo root: `pnpm install`

- [ ] **Step 2: Write the failing tests**

`packages/agent-core/src/paths.test.ts`:

```ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkspacePath, toPosix, toWorkspaceRelative } from "./paths.js";

const root = path.join("D:", "ws");

describe("resolveWorkspacePath", () => {
  it("resolves a relative file inside the root", () => {
    const abs = resolveWorkspacePath(root, "src/echo.ts");
    expect(abs).toBe(path.resolve(root, "src/echo.ts"));
  });

  it("rejects parent escape", () => {
    expect(() => resolveWorkspacePath(root, "../secret.txt")).toThrow(
      "Path is outside the workspace",
    );
  });

  it("rejects an absolute path outside the root", () => {
    expect(() => resolveWorkspacePath(root, "C:\\Windows\\notepad.exe")).toThrow(
      "Path is outside the workspace",
    );
  });
});

describe("toWorkspaceRelative", () => {
  it("uses posix separators", () => {
    const abs = path.resolve(root, "src", "echo.ts");
    expect(toWorkspaceRelative(root, abs)).toBe("src/echo.ts");
  });
});

describe("toPosix", () => {
  it("replaces backslashes", () => {
    expect(toPosix("src\\echo.ts")).toBe("src/echo.ts");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @palm-agent/agent-core test`

Expected: FAIL — `Cannot find module './paths.js'`

- [ ] **Step 4: Implement paths**

`packages/agent-core/src/paths.ts`:

```ts
import path from "node:path";

export function toPosix(p: string): string {
  return p.replaceAll("\\", "/");
}

export function resolveWorkspacePath(workspaceRoot: string, input: string): string {
  const root = path.resolve(workspaceRoot);
  const abs = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Path is outside the workspace");
  }
  return abs;
}

export function toWorkspaceRelative(workspaceRoot: string, absPath: string): string {
  return toPosix(path.relative(path.resolve(workspaceRoot), path.resolve(absPath)));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @palm-agent/agent-core test`

Expected: PASS (3 describes / 5 tests)

- [ ] **Step 6: Optional commit**

```
feat(agent-core): add workspace path resolver
```

---

### Task 2: Model config and startTurn guards

**Files:**
- Create: `packages/agent-core/src/config.ts`
- Create: `packages/agent-core/src/config.test.ts`
- Create: `packages/agent-core/src/session-guards.ts`
- Create: `packages/agent-core/src/session-guards.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `ModelConfig { baseUrl: string; model: string; apiKey: string }`
  - `isForbiddenModelName(model: string): boolean`
  - `assertCanStartTurn(text: string, state: { busy: boolean; hasWorkspace: boolean; model: string }): { type: "error"; message: string } | null`

- [ ] **Step 1: Write failing tests**

`packages/agent-core/src/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isForbiddenModelName } from "./config.js";

describe("isForbiddenModelName", () => {
  it("allows qwen3:14b", () => {
    expect(isForbiddenModelName("qwen3:14b")).toBe(false);
  });

  it("rejects gpt-4", () => {
    expect(isForbiddenModelName("gpt-4")).toBe(true);
  });

  it("rejects o3-mini", () => {
    expect(isForbiddenModelName("o3-mini")).toBe(true);
  });
});
```

`packages/agent-core/src/session-guards.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { assertCanStartTurn } from "./session-guards.js";

const ok = { busy: false, hasWorkspace: true, model: "qwen3:14b" };

describe("assertCanStartTurn", () => {
  it("rejects empty text", () => {
    expect(assertCanStartTurn("   ", ok)).toEqual({
      type: "error",
      message: "Empty message",
    });
  });

  it("rejects a second turn while busy", () => {
    expect(assertCanStartTurn("hi", { ...ok, busy: true })).toEqual({
      type: "error",
      message: "Agent is busy",
    });
  });

  it("rejects a missing workspace", () => {
    expect(assertCanStartTurn("hi", { ...ok, hasWorkspace: false })).toEqual({
      type: "error",
      message: "No workspace folder open",
    });
  });

  it("rejects a Responses-API model name", () => {
    expect(assertCanStartTurn("hi", { ...ok, model: "gpt-4" })).toEqual({
      type: "error",
      message:
        "Model name routes to the wrong API. Use a local Ollama name such as qwen3:14b.",
    });
  });

  it("allows a valid turn", () => {
    expect(assertCanStartTurn("hi", ok)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @palm-agent/agent-core test`

Expected: FAIL — modules not found

- [ ] **Step 3: Implement**

`packages/agent-core/src/config.ts`:

```ts
export interface ModelConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export function isForbiddenModelName(model: string): boolean {
  const m = model.trim().toLowerCase();
  if (m.startsWith("gpt-") || m.startsWith("chatgpt-") || m.startsWith("text-")) {
    return true;
  }
  if (m.startsWith("davinci")) {
    return true;
  }
  return /^o[1-9]/.test(m);
}
```

`packages/agent-core/src/session-guards.ts`:

```ts
import { isForbiddenModelName } from "./config.js";

export function assertCanStartTurn(
  text: string,
  state: { busy: boolean; hasWorkspace: boolean; model: string },
): { type: "error"; message: string } | null {
  if (text.trim().length === 0) {
    return { type: "error", message: "Empty message" };
  }
  if (state.busy) {
    return { type: "error", message: "Agent is busy" };
  }
  if (!state.hasWorkspace) {
    return { type: "error", message: "No workspace folder open" };
  }
  if (isForbiddenModelName(state.model)) {
    return {
      type: "error",
      message:
        "Model name routes to the wrong API. Use a local Ollama name such as qwen3:14b.",
    };
  }
  return null;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @palm-agent/agent-core test`

Expected: PASS

- [ ] **Step 5: Optional commit**

```
feat(agent-core): add model config and startTurn guards
```

---

### Task 3: Read-only tools over WorkspacePort

**Files:**
- Create: `packages/agent-core/src/port.ts`
- Create: `packages/agent-core/src/tools.ts`
- Create: `packages/agent-core/src/tools.test.ts`

**Interfaces:**
- Consumes: `WorkspacePort` from `port.ts`
- Produces: `createWorkspaceTools(port: WorkspacePort): Tool[]` with names `read_file`, `list_dir`, `search`, `get_context`. Each tool `invoke` returns a `string`.

Until `@mozaik-ai/core` is installed (Task 4), define a local `AgentTool` type in `tools.ts` with the same shape the starter uses. Task 4 switches the import to `Tool` from Mozaik without changing invoke behavior.

- [ ] **Step 1: Write port types**

`packages/agent-core/src/port.ts`:

```ts
export interface DirEntry {
  name: string;
  type: "file" | "dir";
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface EditorContext {
  activeFile: string | null;
  selection: string | null;
}

export interface WorkspacePort {
  hasWorkspace(): boolean;
  readFile(path: string): Promise<string>;
  listDir(path: string): Promise<DirEntry[]>;
  search(query: string, glob?: string): Promise<SearchHit[]>;
  getContext(): Promise<EditorContext>;
}
```

- [ ] **Step 2: Write failing tool tests**

`packages/agent-core/src/tools.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { WorkspacePort } from "./port.js";
import { createWorkspaceTools } from "./tools.js";

function getInvoke(name: string, port: WorkspacePort) {
  const tool = createWorkspaceTools(port).find((t) => t.name === name);
  if (!tool) {
    throw new Error(`missing ${name}`);
  }
  return tool.invoke;
}

function fakePort(overrides: Partial<WorkspacePort> = {}): WorkspacePort {
  return {
    hasWorkspace: () => true,
    readFile: async () => "",
    listDir: async () => [],
    search: async () => [],
    getContext: async () => ({ activeFile: null, selection: null }),
    ...overrides,
  };
}

describe("read_file", () => {
  it("truncates after 100000 characters", async () => {
    const invoke = getInvoke(
      "read_file",
      fakePort({ readFile: async () => "x".repeat(100_001) }),
    );
    const out = await invoke({ path: "a.ts" });
    expect(out.endsWith("\n[truncated]")).toBe(true);
    expect(out.startsWith("x".repeat(100_000))).toBe(true);
  });
});

describe("list_dir", () => {
  it("returns one level as text", async () => {
    const invoke = getInvoke(
      "list_dir",
      fakePort({
        listDir: async () => [
          { name: "a.ts", type: "file" },
          { name: "src", type: "dir" },
        ],
      }),
    );
    expect(await invoke({ path: "." })).toBe("file a.ts\ndir src");
  });
});

describe("search", () => {
  it("rejects an empty query", async () => {
    const invoke = getInvoke("search", fakePort());
    expect(await invoke({ query: "  " })).toBe("Error: Empty search query");
  });

  it("caps at 50 hits", async () => {
    const hits = Array.from({ length: 60 }, (_, i) => ({
      path: "f.ts",
      line: i + 1,
      text: "x",
    }));
    const invoke = getInvoke("search", fakePort({ search: async () => hits }));
    const out = await invoke({ query: "x" });
    expect(out).toContain("[truncated to 50 hits]");
    expect(out.split("\n").filter((l) => l.startsWith("f.ts:")).length).toBe(50);
  });
});

describe("get_context", () => {
  it("serializes nulls", async () => {
    const invoke = getInvoke("get_context", fakePort());
    expect(JSON.parse(await invoke({}))).toEqual({
      activeFile: null,
      selection: null,
    });
  });
});
```

- [ ] **Step 3: Run tests — expect FAIL**

Run: `pnpm --filter @palm-agent/agent-core test`

Expected: FAIL — `createWorkspaceTools` missing

- [ ] **Step 4: Implement tools**

`packages/agent-core/src/tools.ts`:

```ts
import type { WorkspacePort } from "./port.js";

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: true;
  type: "function";
  invoke: (args: Record<string, unknown>) => Promise<string>;
}

const READ_LIMIT = 100_000;
const SEARCH_LIMIT = 50;

export const SYSTEM_PROMPT =
  "You are a coding assistant in a local workspace. Use the provided tools to read the workspace before answering questions about code. Do not invent file contents. You cannot write files or apply patches in this version — only read, list, search, and report the active editor context.";

export function createWorkspaceTools(port: WorkspacePort): AgentTool[] {
  return [
    {
      name: "read_file",
      description: "Read a UTF-8 text file in the workspace. Path is relative to the workspace root.",
      strict: true,
      type: "function",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Workspace-relative path" } },
        required: ["path"],
      },
      invoke: async (args) => {
        const filePath = String(args.path ?? "");
        try {
          const text = await port.readFile(filePath);
          if (text.length > READ_LIMIT) {
            return `${text.slice(0, READ_LIMIT)}\n[truncated]`;
          }
          return text;
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    },
    {
      name: "list_dir",
      description: "List one directory level in the workspace.",
      strict: true,
      type: "function",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Workspace-relative directory" } },
        required: ["path"],
      },
      invoke: async (args) => {
        try {
          const entries = await port.listDir(String(args.path ?? ""));
          return entries.map((e) => `${e.type} ${e.name}`).join("\n");
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    },
    {
      name: "search",
      description: "Search workspace file contents with a text query. Optional glob limits files.",
      strict: true,
      type: "function",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          glob: { type: "string" },
        },
        required: ["query"],
      },
      invoke: async (args) => {
        const query = String(args.query ?? "").trim();
        if (!query) {
          return "Error: Empty search query";
        }
        const glob = typeof args.glob === "string" ? args.glob : undefined;
        try {
          const hits = await port.search(query, glob);
          const sliced = hits.slice(0, SEARCH_LIMIT);
          const lines = sliced.map((h) => `${h.path}:${h.line}:${h.text}`);
          if (hits.length > SEARCH_LIMIT) {
            lines.push("[truncated to 50 hits]");
          }
          return lines.join("\n") || "No matches";
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    },
    {
      name: "get_context",
      description: "Return the active editor file path and selected text, if any.",
      strict: true,
      type: "function",
      parameters: { type: "object", properties: {}, required: [] },
      invoke: async () => {
        try {
          return JSON.stringify(await port.getContext());
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    },
  ];
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @palm-agent/agent-core test`

Expected: PASS

- [ ] **Step 6: Optional commit**

```
feat(agent-core): add read-only workspace tools
```

---

### Task 4: Install Mozaik and align the Tool type

**Files:**
- Modify: `packages/agent-core/package.json`
- Modify: `packages/agent-core/src/tools.ts`
- Modify: `pnpm-workspace.yaml` (only if install asks to allow a new build script)

**Interfaces:**
- Consumes: `AgentTool` from Task 3
- Produces: `createWorkspaceTools` returns `Tool[]` from `@mozaik-ai/core`

- [ ] **Step 1: Add the dependency**

From repo root:

```
pnpm --filter @palm-agent/agent-core add @mozaik-ai/core@^3.13.0
```

If pnpm reports `ERR_PNPM_IGNORED_BUILDS`, add the package name under `allowBuilds` in `pnpm-workspace.yaml` (same pattern as `esbuild: true`) and re-run install.

- [ ] **Step 2: Confirm exports**

Open `node_modules/@mozaik-ai/core` (or its `package.json` `exports`) and confirm these names exist: `AgenticEnvironment`, `BaseParticipant`, `ModelContext`, `sendMessage`, `runInference`, `executeFunctionCall`, `Tool`, `DeveloperMessageItem`, `UserMessageItem`. If a name differs, use the installed name and keep the semantics in this plan.

- [ ] **Step 3: Switch tools.ts to `Tool`**

Replace the local `AgentTool` interface with:

```ts
import type { Tool } from "@mozaik-ai/core";
```

Change the return type of `createWorkspaceTools` to `Tool[]`. If `Tool.invoke` args are a generic, keep `Record<string, unknown>` and cast at the return if TypeScript requires it. Do not change invoke bodies.

- [ ] **Step 4: Re-run agent-core tests**

Run: `pnpm --filter @palm-agent/agent-core test`

Expected: PASS

- [ ] **Step 5: Optional commit**

```
chore(agent-core): add @mozaik-ai/core
```

---

### Task 5: Session, EditorAgent, UIBridge

**Files:**
- Create: `packages/agent-core/src/participants/editor-agent.ts`
- Create: `packages/agent-core/src/participants/ui-bridge.ts`
- Create: `packages/agent-core/src/session.ts`
- Create: `packages/agent-core/src/ui-bridge.test.ts`
- Create: `packages/agent-core/src/index.ts`
- Delete contents of placeholder `packages/agent-core/src/index.ts` (replace)

**Interfaces:**
- Consumes: `WorkspacePort`, `ModelConfig`, `createWorkspaceTools`, `assertCanStartTurn`, `SYSTEM_PROMPT`
- Produces:
  - `type SessionEventSink = (event: ExtToWebview) => void`
  - `interface AgentSession { readonly busy: boolean; startTurn(text: string): Promise<void>; setSink(sink: SessionEventSink): void }`
  - `createAgentSession(port: WorkspacePort, config: ModelConfig, sink?: SessionEventSink): AgentSession`

`startTurn` must not `await runInference` (it returns `void`). It returns a Promise that resolves when `EditorAgent` calls `onIdle` or `onFailed`, or after 120 seconds.

- [ ] **Step 1: Write UIBridge tests** (pure mapping; no live model)

`packages/agent-core/src/ui-bridge.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ExtToWebview } from "@palm-agent/shared";
import { eventsFromFunctionCall, eventFromModelText } from "./participants/ui-bridge.js";

describe("UIBridge mappers", () => {
  it("maps a function call", () => {
    expect(eventsFromFunctionCall("read_file", { path: "a.ts" })).toEqual({
      type: "tool_call",
      name: "read_file",
      args: { path: "a.ts" },
    } satisfies ExtToWebview);
  });

  it("maps model text", () => {
    expect(eventFromModelText("hello")).toEqual({
      type: "assistant_delta",
      text: "hello",
    });
  });

  it("skips empty model text", () => {
    expect(eventFromModelText("")).toBeNull();
  });
});
```

Add `@palm-agent/shared` as a `workspace:*` dependency of `agent-core` in this task (`pnpm --filter @palm-agent/agent-core add @palm-agent/shared@workspace:*`).

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @palm-agent/agent-core test`

Expected: FAIL — ui-bridge missing

- [ ] **Step 3: Implement UIBridge**

`packages/agent-core/src/participants/ui-bridge.ts`:

```ts
import {
  BaseParticipant,
  FunctionCallItem,
  ModelMessageItem,
  type Participant,
} from "@mozaik-ai/core";
import type { ExtToWebview } from "@palm-agent/shared";

export function eventsFromFunctionCall(name: string, args: unknown): ExtToWebview {
  return { type: "tool_call", name, args };
}

export function eventFromModelText(text: string): ExtToWebview | null {
  if (!text) {
    return null;
  }
  return { type: "assistant_delta", text };
}

export class UIBridge extends BaseParticipant {
  constructor(private readonly sink: () => (event: ExtToWebview) => void) {
    super();
  }

  override onExternalFunctionCall(_source: Participant, item: FunctionCallItem): void {
    const json = item.toJSON?.() as { name?: string; arguments?: unknown } | undefined;
    const name = json?.name ?? item.name ?? "tool";
    const args = json?.arguments ?? {};
    this.sink()(eventsFromFunctionCall(name, args));
  }

  override onExternalModelMessage(_source: Participant, item: ModelMessageItem): void {
    const text = item.content?.text ?? "";
    const event = eventFromModelText(text);
    if (event) {
      this.sink()(event);
    }
  }
}
```

If `FunctionCallItem` / `ModelMessageItem` fields differ in 3.13, adapt the mappers to the installed types and keep the emitted `ExtToWebview` shapes unchanged.

- [ ] **Step 4: Implement EditorAgent**

`packages/agent-core/src/participants/editor-agent.ts`:

```ts
import {
  AgenticEnvironment,
  BaseParticipant,
  FunctionCallItem,
  FunctionCallOutputItem,
  ModelContext,
  ModelMessageItem,
  UserMessageItem,
  executeFunctionCall,
  runInference,
  type Tool,
} from "@mozaik-ai/core";

export class EditorAgent extends BaseParticipant {
  private readonly pendingCalls = new Set<string>();

  constructor(
    private readonly environment: AgenticEnvironment,
    private readonly context: ModelContext,
    private readonly tools: Tool[],
    private readonly model: string,
    private readonly onIdle: () => void,
    private readonly onFailed: (message: string) => void,
  ) {
    super();
  }

  override onMessage(message: string): void {
    this.context.addContextItem(UserMessageItem.create(message));
    this.run();
  }

  override onFunctionCall(item: FunctionCallItem): void {
    this.pendingCalls.add(item.callId);
    this.context.addContextItem(item);
    const tool = this.tools.find((t) => t.name === item.name);
    if (!tool) {
      this.onFailed(`Tool ${item.name} not found`);
      return;
    }
    executeFunctionCall(this.environment, item, tool, this);
  }

  override onFunctionCallOutput(item: FunctionCallOutputItem): void {
    this.context.addContextItem(item);
    this.pendingCalls.delete(item.callId);
    if (this.pendingCalls.size === 0) {
      this.run();
    }
  }

  override onModelMessage(item: ModelMessageItem): void {
    this.context.addContextItem(item);
    if (this.pendingCalls.size === 0) {
      this.onIdle();
    }
  }

  override onError(error: { message: string }): void {
    const message = error.message ?? String(error);
    const unreachable = /fetch|ECONNREFUSED|ENOTFOUND|network/i.test(message);
    this.onFailed(
      unreachable
        ? `Cannot reach Ollama at ${process.env.OPENAI_BASE_URL ?? "the configured URL"}. Is it running?`
        : message.slice(0, 400),
    );
  }

  private run(): void {
    runInference({
      model: this.model,
      tools: this.tools,
      context: this.context,
      environment: this.environment,
      caller: this,
    });
  }
}
```

- [ ] **Step 5: Implement session**

`packages/agent-core/src/session.ts`:

```ts
import {
  AgenticEnvironment,
  BaseParticipant,
  DeveloperMessageItem,
  ModelContext,
  sendMessage,
} from "@mozaik-ai/core";
import type { ExtToWebview } from "@palm-agent/shared";
import type { ModelConfig } from "./config.js";
import { EditorAgent } from "./participants/editor-agent.js";
import { UIBridge } from "./participants/ui-bridge.js";
import type { WorkspacePort } from "./port.js";
import { assertCanStartTurn } from "./session-guards.js";
import { SYSTEM_PROMPT, createWorkspaceTools } from "./tools.js";

export type SessionEventSink = (event: ExtToWebview) => void;

export interface AgentSession {
  readonly busy: boolean;
  startTurn(text: string): Promise<void>;
  setSink(sink: SessionEventSink): void;
}

const TURN_TIMEOUT_MS = 120_000;

export function createAgentSession(
  port: WorkspacePort,
  config: ModelConfig,
  initialSink: SessionEventSink = () => undefined,
): AgentSession {
  let sink = initialSink;
  let busy = false;
  let settle: ((event: ExtToWebview) => void) | undefined;

  const finish = (event: ExtToWebview): void => {
    if (!busy) {
      return;
    }
    busy = false;
    const done = settle;
    settle = undefined;
    sink(event);
    done?.(event);
  };

  const environment = new AgenticEnvironment();
  const context = ModelContext.create("palm-agent");
  context.addContextItem(DeveloperMessageItem.create(SYSTEM_PROMPT));
  const tools = createWorkspaceTools(port);
  const user = new BaseParticipant();
  const agent = new EditorAgent(
    environment,
    context,
    tools,
    config.model,
    () => finish({ type: "done" }),
    (message) => finish({ type: "error", message }),
  );
  const ui = new UIBridge(() => sink);

  agent.join(environment);
  ui.join(environment);
  user.join(environment);

  const session: AgentSession = {
    get busy() {
      return busy;
    },
    setSink(next: SessionEventSink) {
      sink = next;
    },
    async startTurn(text: string) {
      const blocked = assertCanStartTurn(text, {
        busy,
        hasWorkspace: port.hasWorkspace(),
        model: config.model,
      });
      if (blocked) {
        sink(blocked);
        return;
      }
      process.env.OPENAI_BASE_URL = config.baseUrl;
      process.env.OPENAI_API_KEY = config.apiKey;
      busy = true;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          finish({
            type: "error",
            message: `Cannot reach Ollama at ${config.baseUrl}. Is it running?`,
          });
        }, TURN_TIMEOUT_MS);
        settle = () => {
          clearTimeout(timer);
          resolve();
        };
        sendMessage(environment, text.trim(), user);
      });
    },
  };

  return session;
}
```

`packages/agent-core/src/index.ts`:

```ts
export type { ModelConfig } from "./config.js";
export { isForbiddenModelName } from "./config.js";
export type { AgentSession, SessionEventSink } from "./session.js";
export { createAgentSession } from "./session.js";
export type { DirEntry, EditorContext, SearchHit, WorkspacePort } from "./port.js";
export { resolveWorkspacePath, toPosix, toWorkspaceRelative } from "./paths.js";
```

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @palm-agent/agent-core test`

Expected: PASS. If `join` / `toJSON` / `item.content` types fail, fix to the installed typings without changing event shapes.

- [ ] **Step 7: Grep for vscode**

Run: `rg "from ['\"]vscode['\"]" packages/agent-core`

Expected: no matches

- [ ] **Step 8: Optional commit**

```
feat(agent-core): wire Mozaik session and UIBridge
```

---

### Task 6: VS Code WorkspacePort, settings, session host

**Files:**
- Create: `packages/extension/src/workspacePort.ts`
- Create: `packages/extension/src/sessionHost.ts`
- Modify: `packages/extension/package.json`
- Modify: `packages/extension/src/extension.ts`

**Interfaces:**
- Consumes: `WorkspacePort`, `createAgentSession`, `ModelConfig`, `resolveWorkspacePath`, `toWorkspaceRelative`
- Produces: `createVsCodeWorkspacePort(): WorkspacePort`, `readModelConfig(): ModelConfig`, `createSessionHost(): { session: AgentSession }`

- [ ] **Step 1: Add extension dependencies and settings**

In `packages/extension/package.json`:

- dependencies: `"@palm-agent/agent-core": "workspace:*"`, `"@vscode/ripgrep": "^1.15.9"` (use the version pnpm resolves if the caret differs)
- under `contributes`, add:

```json
"configuration": {
  "title": "Palm Agent",
  "properties": {
    "palmAgent.ollamaBaseUrl": {
      "type": "string",
      "default": "http://localhost:11434/v1",
      "description": "Ollama Chat Completions base URL"
    },
    "palmAgent.model": {
      "type": "string",
      "default": "qwen3:14b",
      "description": "Ollama model name. Do not use gpt-* names."
    }
  }
}
```

From repo root: `pnpm install`

- [ ] **Step 2: Implement the port**

`packages/extension/src/workspacePort.ts`:

```ts
import { spawn } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";
import {
  resolveWorkspacePath,
  toWorkspaceRelative,
  type DirEntry,
  type EditorContext,
  type SearchHit,
  type WorkspacePort,
} from "@palm-agent/agent-core";
import * as vscode from "vscode";

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function createVsCodeWorkspacePort(): WorkspacePort {
  return {
    hasWorkspace: () => Boolean(workspaceRoot()),

    async readFile(input: string) {
      const root = workspaceRoot();
      if (!root) {
        throw new Error("No workspace folder open");
      }
      const abs = resolveWorkspacePath(root, input);
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(abs));
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    },

    async listDir(input: string) {
      const root = workspaceRoot();
      if (!root) {
        throw new Error("No workspace folder open");
      }
      const abs = resolveWorkspacePath(root, input);
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(abs));
      return entries.map(([name, type]): DirEntry => ({
        name,
        type: type === vscode.FileType.Directory ? "dir" : "file",
      }));
    },

    async search(query: string, glob?: string) {
      const root = workspaceRoot();
      if (!root) {
        throw new Error("No workspace folder open");
      }
      const args = ["--json", "--max-count", "50", "--", query];
      if (glob) {
        args.splice(0, 0, "--glob", glob);
      }
      const hits = await runRg(rgPath, args, root);
      return hits;
    },

    async getContext() {
      const root = workspaceRoot();
      const editor = vscode.window.activeTextEditor;
      if (!root || !editor) {
        return { activeFile: null, selection: null } satisfies EditorContext;
      }
      const activeFile = toWorkspaceRelative(root, editor.document.uri.fsPath);
      const selection = editor.selection.isEmpty
        ? null
        : editor.document.getText(editor.selection);
      return { activeFile, selection };
    },
  };
}

function runRg(bin: string, args: string[], cwd: string): Promise<SearchHit[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", () => {
      if (stderr && !stdout) {
        reject(new Error(stderr.trim()));
        return;
      }
      const hits: SearchHit[] = [];
      for (const line of stdout.split("\n")) {
        if (!line) {
          continue;
        }
        try {
          const row = JSON.parse(line) as {
            type?: string;
            data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
          };
          if (row.type !== "match" || !row.data?.path?.text) {
            continue;
          }
          hits.push({
            path: toWorkspaceRelative(cwd, row.data.path.text),
            line: row.data.line_number ?? 1,
            text: (row.data.lines?.text ?? "").replace(/\n$/, ""),
          });
        } catch {
          // skip malformed rg json lines
        }
      }
      resolve(hits);
    });
  });
}
```

If `@vscode/ripgrep` exports a different path symbol, use whatever the installed package documents (`rgPath` is the usual one).

- [ ] **Step 3: Implement sessionHost + activate**

`packages/extension/src/sessionHost.ts`:

```ts
import { createAgentSession, type AgentSession, type ModelConfig } from "@palm-agent/agent-core";
import * as vscode from "vscode";
import { createVsCodeWorkspacePort } from "./workspacePort";

export function readModelConfig(): ModelConfig {
  const cfg = vscode.workspace.getConfiguration("palmAgent");
  return {
    baseUrl: cfg.get("ollamaBaseUrl", "http://localhost:11434/v1"),
    model: cfg.get("model", "qwen3:14b"),
    apiKey: "not-needed",
  };
}

export function createSessionHost(): AgentSession {
  return createAgentSession(createVsCodeWorkspacePort(), readModelConfig());
}
```

`packages/extension/src/extension.ts` — construct the session in `activate` and pass it into the provider:

```ts
import * as vscode from "vscode";
import { ChatViewProvider } from "./chatViewProvider";
import { createSessionHost } from "./sessionHost";

export function activate(context: vscode.ExtensionContext): void {
  console.log("[palm-agent] activated");
  const session = createSessionHost();
  const provider = new ChatViewProvider(context.extensionUri, session);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("agent.focus", () => {
      void vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    }),
  );
}

export function deactivate(): void {}
```

Do not wire `user_message` yet (Task 7). This task may not compile until Task 7 updates `ChatViewProvider`'s constructor. If you implement Task 6 and 7 in one sitting, that is fine; do not leave a broken constructor overnight.

- [ ] **Step 4: Optional commit**

```
feat(extension): add VS Code workspace port and Ollama settings
```

---

### Task 7: Replace echo and render tool_call

**Files:**
- Create: `packages/extension/src/webview/chatMessages.ts`
- Create: `packages/extension/src/webview/chatMessages.test.ts`
- Modify: `packages/extension/src/webview/App.tsx`
- Modify: `packages/extension/src/chatViewProvider.ts`
- Delete: `packages/extension/src/echo.ts`
- Delete: `packages/extension/src/echo.test.ts`
- Modify: `packages/extension/src/webview/App.css` (`.bubble.tool` only)

**Interfaces:**
- Consumes: `AgentSession.setSink`, `AgentSession.startTurn`, `ExtToWebview`
- Produces: `applyExtMessage(messages: ChatLine[], msg: ExtToWebview): ChatLine[]` where `ChatLine = { role: "user" | "assistant" | "tool"; text: string }`

- [ ] **Step 1: Write failing reducer tests**

`packages/extension/src/webview/chatMessages.ts` does not exist yet.

`packages/extension/src/webview/chatMessages.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyExtMessage, type ChatLine } from "./chatMessages";

describe("applyExtMessage", () => {
  it("appends assistant text", () => {
    const next = applyExtMessage([], { type: "assistant_delta", text: "hi" });
    expect(next).toEqual([{ role: "assistant", text: "hi" }]);
  });

  it("appends a tool line without throwing", () => {
    const next = applyExtMessage([], {
      type: "tool_call",
      name: "read_file",
      args: { path: "src/echo.ts" },
    });
    expect(next[0]).toEqual({ role: "tool", text: "read_file  src/echo.ts" });
  });

  it("formats error lines", () => {
    const next = applyExtMessage([], { type: "error", message: "Agent is busy" });
    expect(next[0]?.text).toBe("Error: Agent is busy");
  });

  it("ignores done", () => {
    const prev: ChatLine[] = [{ role: "user", text: "x" }];
    expect(applyExtMessage(prev, { type: "done" })).toBe(prev);
  });
});
```

- [ ] **Step 2: Run extension tests — expect FAIL**

Run: `pnpm --filter palm-agent test`

Expected: FAIL — `chatMessages` missing (and existing echo tests still pass until deleted)

- [ ] **Step 3: Implement reducer + CSS**

`packages/extension/src/webview/chatMessages.ts`:

```ts
import type { ExtToWebview } from "@palm-agent/shared";

export interface ChatLine {
  role: "user" | "assistant" | "tool";
  text: string;
}

export function formatToolArgs(args: unknown): string {
  if (args && typeof args === "object" && "path" in args) {
    return String((args as { path: unknown }).path);
  }
  if (args && typeof args === "object" && "query" in args) {
    return String((args as { query: unknown }).query);
  }
  try {
    return JSON.stringify(args);
  } catch {
    return "";
  }
}

export function applyExtMessage(messages: ChatLine[], msg: ExtToWebview): ChatLine[] {
  if (msg.type === "assistant_delta") {
    return [...messages, { role: "assistant", text: msg.text }];
  }
  if (msg.type === "tool_call") {
    const detail = formatToolArgs(msg.args);
    return [...messages, { role: "tool", text: detail ? `${msg.name}  ${detail}` : msg.name }];
  }
  if (msg.type === "error") {
    return [...messages, { role: "assistant", text: `Error: ${msg.message}` }];
  }
  return messages;
}
```

Add to `packages/extension/src/webview/App.css`:

```css
.bubble.tool {
  opacity: 0.75;
  font-family: var(--vscode-editor-font-family);
  font-size: 12px;
}
```

- [ ] **Step 4: Update App.tsx**

Replace the local `ChatMessage` type and the `onMessage` handler with `ChatLine` + `applyExtMessage`. Render `role === "tool"` as role label `Tool`. Change the empty-state copy to: `Ask about a file in this workspace.` Keep `busy` toggling on `done` / `error` as today.

```tsx
if (msg.type === "done") {
  setBusy(false);
  return;
}
setMessages((prev) => applyExtMessage(prev, msg));
if (msg.type === "error") {
  setBusy(false);
}
```

- [ ] **Step 5: Wire ChatViewProvider and delete echo**

Constructor: `(extensionUri: vscode.Uri, private readonly session: AgentSession)`.

In `resolveWebviewView`, after setting html:

```ts
this.session.setSink((event) => {
  void webviewView.webview.postMessage(event);
});
webviewView.webview.onDidReceiveMessage((message: WebviewToExt) => {
  if (message.type !== "user_message") {
    return;
  }
  void this.session.startTurn(message.text);
});
```

Delete `packages/extension/src/echo.ts` and `packages/extension/src/echo.test.ts`.

- [ ] **Step 6: Run tests and build**

Run:

```
pnpm --filter @palm-agent/agent-core test
pnpm --filter palm-agent test
pnpm --filter palm-agent build
```

Expected: all PASS; `dist/extension.js` and `dist/webview/index.js` written.

- [ ] **Step 7: Optional commit**

```
feat: replace echo with Mozaik chat session
```

---

### Task 8: Manual verification (not CI)

**Files:** none (run only)

- [ ] **Step 1: Confirm Ollama**

```
ollama list
```

Expected: `qwen3:14b` present (or set `palmAgent.model` to whatever is installed that is not `gpt-*`).

- [ ] **Step 2: F5**

Launch `Run Extension`. In the Extension Development Host, open this repo as the workspace. Open Palm Agent chat.

- [ ] **Step 3: Happy path**

Send: `What does packages/extension/src/extension.ts do?`

Expected: a `tool` row (`read_file` or `search`), then an assistant answer that is not a verbatim echo of the question. Debug console contains `[palm-agent] activated`.

- [ ] **Step 4: Error path**

Stop Ollama (or set `palmAgent.ollamaBaseUrl` to `http://127.0.0.1:9/v1`). Send `hello`.

Expected: `Error: Cannot reach Ollama at …` (or the 120s timeout variant). Host does not crash.

---

## Spec coverage

| Spec item | Task |
|---|---|
| Path escape | 1 |
| Forbidden model / empty / busy / no workspace | 2 |
| Tool limits + empty search | 3 |
| Mozaik install | 4 |
| EditorAgent / UIBridge / session / `done` | 5 |
| Port + settings + ripgrep + `get_context` | 6 |
| Remove echo, `tool_call` UI | 7 |
| Manual F5 + Ollama down | 8 |
| No `vscode` in agent-core | 5 Step 7 |
| SYSTEM_PROMPT | 5 |
| Ignore apply/cancel | 7 (provider still returns early) |

## Self-review notes

- `runInference` is void: Task 5 uses `onIdle` / `onFailed` / 120s timeout instead of awaiting inference.
- Developer prompt is added once in `createAgentSession`, not on every `onMessage` (starter adds it every turn; do not copy that).
- `AgentTool` exists only until Task 4 switches to Mozaik `Tool`.
- Ripgrep `--json` line format is the standard `rg --json` match object used in Task 6.
