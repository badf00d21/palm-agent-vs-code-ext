# Plan implementacije — agentski coding alat (VS Code ekstenzija → kasnije fork)

**Cilj ove faze:** dokazati "mozak" (Mozaik agent loop) + pouzdan apply/diff kao *običnu VS Code ekstenziju*, pre nego što uložiš u fork. Ekstenzija je disposable — kad arhitektura proradi i udariš u zid oko editor UX-a, forkuješ i seliš agent-core paket kao-jeste.

**Princip:** najkraći put do "priča sa mnom o kodu" → pa "predlaže izmene" → pa "primenjuje izmene". Sve ostalo (indexing, multi-agent, Tab, MCP, checkpoints) namerno je van opsega ove faze.

---

## Stack i preduslovi

- **Node LTS** (18+), **pnpm** (monorepo)
- **VS Code** + `yo` / `generator-code` (ili ručno skele)
- **`@mozaik-ai/core`** — agent runtime
- **`@vscode/ripgrep`** — VS Code već isporučuje rg binary, reuse-uj ga za search
- **API ključ** modela (Anthropic/OpenAI) — u `.env` za dev, kasnije VS Code `SecretStorage`
- Referenca za tačne Mozaik potpise: **`jigjoy-ai/cli-agent-starter`** (Ink + `@mozaik-ai/core`) i `jigjoy-ai/mozaik`. Signaturi ispod su *ilustrativni* — potvrdi ih uz repo/docs jer se menjaju po verzijama.

---

## Layout (pnpm monorepo)

```
coding-agent/
  pnpm-workspace.yaml
  packages/
    extension/            # VS Code ekstenzija (extension host)
      src/extension.ts    # activate(): registruje view + komande, spawn/host agenta
      src/webview/        # React chat UI (Vite build → dist)
      package.json        # contributes: views, commands, keybindings
    agent-core/           # Mozaik environment, participants, tools  ← ovo seliš u fork
      src/environment.ts
      src/participants/
      src/tools/
    shared/               # tipovi za poruke ext ↔ webview ↔ agent
```

Zašto `agent-core` odvojen paket od starta: to je jedini deo koji preživljava prelazak na fork. Drži ga bez ijednog `import 'vscode'` — komunicira preko interfejsa (tool callbacks), ne direktno sa editorom.

---

## Roadmap (v0 → v5)

| Ver | Šta dobijaš | Fokus | Procena* |
|---|---|---|---|
| v0 | Skeleton: F5 → panel u sidebar-u | infra | 0.5–1 dan |
| v1 | Chat sa agentom, read-only tools | Mozaik loop | 3–5 dana |
| v2 | **Apply/diff** — predloži → review → primeni | najteže | 5–8 dana |
| v3 | Streaming + tool viz + @-context | UX | 3–5 dana |
| v4 | Terminal tool + approval gate | agentic | 2–4 dana |
| v5 | Izdvoji agenta u child proces (JSON-RPC) | priprema za fork | 2–4 dana |

*Procena za jednog dev-a koji zna stack; „igranje" varira.

---

## v0 — Skeleton (dovedi nešto na ekran)

1. `pnpm create` monorepo; `yo code` → TypeScript ekstenzija u `packages/extension`.
2. Registruj **`WebviewViewProvider`** u sidebar-u (`contributes.views`), prikaži prazan React panel.
3. Registruj komandu `agent.focus` + keybinding.
4. **Milestone:** F5 (Extension Development Host) → vidiš svoj panel, dugme šalje poruku u ext host i nazad.

Webview ↔ ext protokol (drži ga u `shared/`):

```ts
// webview → ext
{ type: 'user_message', text: string }
{ type: 'apply_diff', id: string } | { type: 'reject_diff', id: string }
{ type: 'cancel' }
// ext → webview
{ type: 'assistant_delta', text: string }
{ type: 'tool_call', name: string, args: unknown }
{ type: 'diff_proposed', id: string, files: DiffFile[] }
{ type: 'done' } | { type: 'error', message: string }
```

**Gotcha:** webview traži `acquireVsCodeApi()` + CSP `<meta>`. Postavi `localResourceRoots` i nonce za skripte odmah, kasnije je gnjavaža.

---

## v1 — Agent brain (Mozaik loop, in-process)

Za „igranje" drži Mozaik **u extension host-u** zasad (bez IPC-a). Odvajanje u proces je v5 — ne komplikuj dok ne dokažeš loop.

```ts
// agent-core/src/environment.ts (ILUSTRATIVNO — potvrdi potpise uz starter)
import { AgenticEnvironment, BaseAgentParticipant, BaseObserver } from "@mozaik-ai/core";

export function buildEnvironment(tools, onEvent) {
  const env = new AgenticEnvironment();

  class EditorAgent extends BaseAgentParticipant {
    // Nasleđuje agent loop: model emituje FunctionCallItem →
    // executeFunctionCall → kad pending calls presuše → runInference ponovo.
    // Registruješ mu tools: read_file, list_dir, search, get_context.
  }

  // Observer koji ne dira loop — samo prosleđuje evente webview-u
  class UIBridge extends BaseObserver {
    onExternalModelMessage(src, msg) { onEvent({ type: 'assistant_delta', text: msg }); }
    onExternalFunctionCall(src, call) { onEvent({ type: 'tool_call', name: call.name, args: call.args }); }
    onError(e) { onEvent({ type: 'error', message: String(e) }); }
  }

  env.join(new EditorAgent(/* model, tools */));
  env.join(new UIBridge());
  return env;
}
```

**Tools (v1, read-only):**

| Tool | Implementacija |
|---|---|
| `read_file(path)` | `vscode.workspace.fs.readFile` |
| `list_dir(path)` | `vscode.workspace.fs.readDirectory` |
| `search(query)` | `@vscode/ripgrep` child_process (reuse VS Code rg) |
| `get_context()` | aktivni fajl + `editor.selection` iz `window.activeTextEditor` |

Model provider: Mozaik bira providera po imenu modela (`runInference`), ključ čita iz env-a (`ANTHROPIC_API_KEY` itd.).

**Milestone:** u chat-u pitaš „šta radi `foo.ts`?", agent pozove `read_file`/`search`, odgovori. UIBridge streamuje. **Ovde imaš igračku koja vredi.**

**Gotcha:** dugotrajan agent blokira ext host event loop. Drži sve `async`, ne radi sync fs, i planiraj v5 ekstrakciju čim počne da „štuca".

---

## v2 — Apply/diff (ovde se sistem dokazuje)

Ovo je razlika između demoa i alata. Dva dela: **edit format** koji model pouzdano proizvodi + **applier** koji ga primeni.

**Edit format — SEARCH/REPLACE blokovi** (robusniji od „ceo fajl ponovo" i od unified diff-a za LLM-ove):

```
path/to/file.ts
const x = oldValue;
```

**Applier:**
1. Nađi `SEARCH` u fajlu — prvo exact match, pa fallback na whitespace-insensitive / fuzzy (trim + normalizacija indentacije). Ako ne nađe → vrati grešku agentu da retry-uje sa više konteksta.
2. Sklopi `vscode.WorkspaceEdit` (ne piši u fajl direktno — `WorkspaceEdit` je undo-friendly, važno za buduće checkpoint-e).
3. **Ne primenjuj odmah.** Emituj `diff_proposed` u webview.

**Review UI (najjednostavniji pouzdan put):**
- Preview: `vscode.commands.executeCommand('vscode.diff', origUri, proposedUri, 'Agent izmena')` — koristi native diff editor.
- Accept → `vscode.workspace.applyEdit(workspaceEdit)`. Reject → odbaci.
- Kasnije nadograđuješ na per-hunk accept, ali za v2 je fajl-nivo dovoljno.

Dodaj tool `propose_edit(files)` koji agent zove umesto da piše na disk. Applier je host-side; agent samo predlaže.

**Milestone:** „preimenuj `getUser` u `fetchUser` svuda" → agent predloži blokove → vidiš diff → Apply. To je Tier-1 srce.

---

## v3 — Streaming i kontekst UX

- **Token streaming:** UIBridge preko Mozaik stream handlera (`SemanticEvent` chunk-ovi) → `postMessage` delte. Model sa `streaming: true`.
- **Tool call viz:** prikaži u chat-u koji tool je pozvan i sa čim (iz `onExternalFunctionCall`).
- **@-context:** `@fajl` autocomplete u inputu → ubaci sadržaj u prompt; „dodaj selekciju" dugme.
- **Cancel:** `cancel` poruka prekida run (AbortController na inference-u).

---

## v4 — Terminal + approval gate

- Tool `run_terminal(cmd)` — ali **iza human approval-a**. Emituj `tool_call`, čekaj potvrdu iz webview-a pre izvršenja.
- Izvršenje: `child_process` sa capture-om stdout/stderr → vrati agentu kao tool result.
- **Gotcha:** hvatanje outputa iz `vscode.window.createTerminal` je bolno (pseudoterminal). Za capture koristi `child_process` direktno; VS Code terminal koristi samo za prikaz korisniku.

---

## v5 — Izdvoji agenta u proces (most ka forku)

Kad loop radi, preseli `agent-core` iz ext host-a u **poseban Node proces** (kao language server):
- `child_process.spawn` iz `extension.ts`, komunikacija **JSON-RPC preko stdio** (`vscode-jsonrpc`).
- Isti message tipovi iz `shared/`, sad idu preko RPC-a umesto direktnog poziva.
- Dobit: agent ne blokira ext host, preživljava window reload, isti proces reuse-uješ za CLI, i **ovo je tačno stanje iz kog forkuješ** (agent-core paket se ne menja, samo host oko njega).

---

## Van opsega u ovoj fazi (scope disciplina)

Ne diraj dok gornje ne radi glatko: **codebase indexing/embeddings, multi-agent (planner/reviewer/test-runner), autocomplete/Tab, MCP, git checkpoints, inline Cmd+K widget.** Sve to je Tier-2 nadogradnja koja ide *posle* forka, jer traži patch-eve u editor core-u.

---

## Kad preći na fork

Signal je konkretan: kad počneš da želiš stvari koje ekstenzija API ne da lepo — **inline Cmd+K widget u editoru, custom diff decoracije po hunk-u, Tab UI**. To je trenutak. Do tada ekstenzija radi sve što ti treba za validaciju, a `agent-core` prelazi netaknut.

---

### Prvi konkretan korak sada
`pnpm` monorepo + `yo code` skeleton + prazan sidebar webview (v0). Cilj prve sesije: F5 → panel na ekranu → poruka ode u ext host i vrati se. Sve dalje je nadogradnja na tu petlju.