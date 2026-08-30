# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are software developers installing a public VS Code extension. They work in a local workspace, talk to a coding agent in the sidebar, and decide whether proposed edits land on disk.

The builder of this repo is also a user (F5 Extension Development Host, local Ollama). That is the current operating environment, not a separate product.

## Product Purpose

Palm Agent (working / display name; **not locked**) is an in-editor coding agent: chat about code, propose a change, review every diff, then apply. Success today is a human-in-the-loop turn — not an autonomous goal-to-PR agent.

The long-term ceiling is Tier 2 (chat + inline edit + agent mode + indexing + checkpoints). The present job is to prove the core as a VS Code extension; a VS Code fork waits until the extension API blocks editor UX.

## Positioning

The mechanism a generic chat sidebar cannot copy: the agent only **proposes** SEARCH/REPLACE; the human reviews via native `vscode.diff` and Keep All / Undo All (`WorkspaceEdit`, undo-friendly). The model loop stays in `agent-core` with no `import 'vscode'`, so the same loop can later leave the extension host.

## Operating Context

- VS Code sidebar webview (`palmAgent.chat`), command `agent.focus`.
- Open workspace folder required. Tools read the workspace; writes happen only after Keep All.
- Local models via Ollama Chat Completions (`http://localhost:11434/v1`). Do not use `gpt-*` / `o1`–`o9` / `text-*` names (wrong API).
- Typical turn: user message (optional `@path` mention, optional editor selection) → streamed assistant prose → tool rows → optional review card → Keep / Undo / Stop.

## Capabilities and Constraints

Confirmed now:

- Streaming assistant prose in one bubble; tool rows running → done; `@` inserts a workspace path only (agent reads via tools; file bodies are not attached — option B deferred).
- `propose_edit` never writes disk. Review is all-or-nothing per pending review.
- `agent-core` has zero `import 'vscode'`. Agent stays in the extension host through v4; v5 is a separate Node process.
- Out of scope until the core is solid: indexing/embeddings, multi-agent, Tab autocomplete, MCP, git checkpoints, create/delete file, per-hunk accept, terminal tool.

Open decisions:

- Public product name and voice (display name in the extension is currently **Palm Agent**).
- Cloud/API-key production storage (SecretStorage planned; not required for local Ollama).

## Brand Commitments

None locked. Extension `displayName` is "Palm Agent"; AGENTS.md still allows renaming. Do not treat "Palm Agent" as a final brand.

## Evidence on Hand

- Product intent and locked architecture: repo-root `AGENTS.md`.
- Chat UI: `packages/extension/src/webview/`.
- No customer quotes, press, pricing, or marketing assets. Do not invent testimonials or usage numbers.

## Product Principles

1. The human reviews every write. Propose, don't apply.
2. Extension-first: ship in VS Code until the API is the wall.
3. Editor facts stay in the extension; the agent loop stays portable.
4. Local Chat Completions first; model names must not route to the wrong protocol.
5. One job in the sidebar: understand code and land a reviewed edit — not a batch agent.
