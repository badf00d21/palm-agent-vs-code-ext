
# Palm Agent


An in-editor coding agent for VS Code, built on the [Mozaik](https://github.com/jigjoy-ai)
participant-on-bus runtime.

It reads your code, answers questions about it, and proposes changes — but it
**never writes to disk on its own**. Every edit lands in a native `vscode.diff`
review that you Keep or Undo.

---

## What makes it different

**Proposals, not writes.** `write`, `edit` and `delete_file` all end in one
review card. Applying goes through `WorkspaceEdit`, so a whole multi-file change
is a single Ctrl+Z. After you keep it, the problems your language servers report
for those files appear as a status line you can click.

**Language support is delegated, never reimplemented.** Symbols, references,
hover and diagnostics come from whatever language extensions you already have,
so the agent works in any language you have support for — without a single
language keyword in our code. Files nothing handles fall back to a structural
outline that works the same for a language nobody has written support for.

**Parallel research on one bus.** A broad question is split into sub-questions
answered by concurrent read-only workers. See below.

**The core is editor-free.** `packages/agent-core` has zero `import "vscode"`,
so the same loop can run outside the extension host later.



P.S. We also have this cool orb.

<img src="docs/media/status-orb.svg" alt="Palm Agent status orb" width="32" height="32" align="left" />



---

## Getting started

Requires **Node 20+**, **pnpm**, and a **DeepSeek API key**.

```bash
pnpm install
pnpm build
```

Then press **F5** in VS Code to launch the Extension Development Host.

In that window:

1. Run **`Palm Agent: Set DeepSeek API Key`** from the Command Palette — the key
   goes into VS Code Secret Storage, not into `settings.json`.
2. Open the chat with **`Ctrl+Alt+A`** (`Cmd+Alt+A` on macOS), or run
   **`Palm Agent: Focus Chat`**.

To build an installable extension instead:

```bash
pnpm --filter palm-agent package   # produces a .vsix
```

### Settings

| Setting | Default | What it does |
|---|---|---|
| `palmAgent.model` | `deepseek-v4-flash` | `flash` for interactive work, `pro` for heavier planning |
| `palmAgent.maxOutputTokens` | `32000` | Output budget per completion. A reasoning model spends this on thinking *before* it writes an answer, so too low a value ends turns with an empty reply |
| `palmAgent.deepseekApiKey` | — | Fallback only; prefer the Secret Storage command above |

### Commands

`Palm Agent: Focus Chat` · `Palm Agent: New Chat` ·
`Palm Agent: Set DeepSeek API Key` · `Palm Agent: Clear DeepSeek API Key`

---

## How the agents run concurrently

This is the part worth reading the code for.

A broad question goes to `research`, which splits it into up to four independent
sub-questions and answers them with concurrent workers. Everything runs on **one
shared Mozaik bus** — the main `EditorAgent`, a one-shot decomposer, every
`ResearchWorkerAgent`, and the `UIBridge` are all joined to the same
`AgenticEnvironment`.

**Coordination is ownership, not locking.** Mozaik broadcasts every event to
every joined participant. `BaseParticipant` invokes its loop callbacks only for
events whose `producerId` is its own; everything else lands on `onExternal*`
no-ops. That single filter is what stops several workers and the main agent from
driving each other's loops. There is no mutex and no queue.

Because `UIBridge` is joined to the same bus, it sees every worker's progress as
it happens and streams live status to the sidebar while they are still running.

**Isolation.** Each worker owns a separate `ModelContext`, so nothing leaks
between them. Workers get a read-only tool subset and cannot propose edits, so
concurrency never races on the filesystem — writes stay serialized through the
one review you approve.

**Why fan out at all: context budget, not speed.** Workers read many files; the
parent receives only a capped digest. The main context never pays for the raw
material.

Start here:

| File | What it shows |
|---|---|
| `packages/agent-core/src/research/coordinator.ts` | fan-out, concurrency limits, digest assembly |
| `packages/agent-core/src/research/worker.ts` | the read-only worker, and why `producerId` matters |
| `packages/agent-core/src/runtime/environment.ts` | the facade over Mozaik's `defineRuntime` |

---

## Tools

| | |
|---|---|
| **Read** | `read_file` `list_dir` `glob` `search` `outline` `get_context` |
| **Language** | `references` `hover` `diagnostics` |
| **Change** (all reviewed) | `write` `edit` `delete_file` |
| **External** | `web_fetch` `docs_search` |
| **Human & agents** | `question` `research` |

---

## Layout

```
packages/
  agent-core/    Mozaik loop, tools, context, inference. No vscode imports.
  extension/     VS Code host, webview UI, review store, workspace port.
  shared/        Message types across the webview boundary.
docs/
  mozaik-divergences.md    where we wrote our own instead of Mozaik's, and why
  superpowers/specs/       design specs, one per feature
  superpowers/plans/       implementation plans
```

`AGENTS.md` holds the locked architectural decisions and is also loaded into the
agent's own context, so it follows the same rules you do.

---

## Development

```bash
pnpm test     # all packages
pnpm build    # webview + extension bundle
pnpm watch    # rebuild on change
```

`agent-core` is tested without a live model or a VS Code host: the inference
transport is injectable and the workspace is reached through a port, so both are
faked in tests.
