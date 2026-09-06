# INIT.md — coding-agent

> Radni naziv: **coding-palm-agent** (slobodno preimenuj). Ovaj fajl je jedini izvor istine za *šta gradimo i kako*.
> Može da posluži i kao kontekst za coding agenta — preimenuj u `AGENTS.md`/`CLAUDE.md` ili ga referenciraj iz njih.

---

## Cilj

Interaktivni, in-editor coding agent (paradigma nalik Cursoru) izgrađen na **Mozaik** runtime-u.
Human-in-the-loop: chat o kodu → predlog izmene → **review svakog diff-a** → primena. Ne batch/autonomni „goal → PR".

**Krajnji domet:** Tier 2 (chat + inline edit + agent mode + indexing + checkpoints).
**Sada:** dokazati jezgro kao **VS Code ekstenziju**; fork VS Code-a tek kad udarimo u zid oko editor-UX-a.

---

## Zaključane odluke

Ovo su odluke donete namerno — ne preispituj ih bez razloga, gradi na njima.

1. **Delivery: extension-first.** Prvo obična VS Code ekstenzija. Fork dolazi kad zatrebaju stvari koje ext API ne da lepo (inline Cmd+K widget, custom diff decoracije po hunk-u, Tab UI).
2. **Runtime: `@mozaik-ai/core` ^4.** Participant-on-bus model (`defineRuntime`). Referenca za TS API: **`jigjoy-ai/cli-agent-starter`** (minimalno i čisto). Za *arhitekturu agent mode-a*: **`jigjoy-ai/baro`** (čitaj `docs/collective-runtime.md`, ne ceo tree — velik je i dobrim delom Rust). `MOZAIK_API_KEY` šalje loop evente na Mozaik Cloud (`@mozaik-ai/cloud-sdk`); nije LLM ključ.
3. **`agent-core` je čist od editora.** Nijedan `import 'vscode'` u tom paketu. To je jedini deo koji preživljava prelazak na fork; komunicira sa editorom preko tool callback-ova, ne direktno.
4. **Agent u ext host-u za v0–v4**, pa ekstrakcija u zaseban Node proces (JSON-RPC preko stdio) u v5. Ne komplikuj sa IPC-om dok loop ne radi.
5. **Edit format: SEARCH/REPLACE blokovi.** Applier → `vscode.WorkspaceEdit` (undo-friendly) → `TextDocument.save()` na Keep All → preview kroz native `vscode.diff` → accept/reject. **Ne** unified diff (LLM-ovi ga lošije proizvode).
6. **Modeli preko OpenAI-kompatibilnog sloja.** Jezgro ne koristi Mozaikov routing po imenu modela — `runLocalChatCompletions` sam gađa `${OPENAI_BASE_URL}/chat/completions`, pa ime modela ide endpoint-u kakvo jeste (bez filtera). Brz lokalni model u VRAM-u za interaktivnu petlju; jak (RAM MoE ili cloud) za teško planiranje.
7. **Van opsega dok jezgro ne radi:** codebase indexing/embeddings, autocomplete/Tab, MCP, git checkpoints.
   **Izuzetak (2026-09-06): multi-agent je delimično ušao** — `research` tool diže read-only radnike na istom Mozaik bus-u (`docs/superpowers/specs/2026-09-06-research-mode-design.md`). Prošao je jer je *read-only*: bez pisanja nema file lease-ova ni `human_build` gate-a iz orchestration spec-a, pa nije trebalo dizati Board/Broker runtime. Multi-agent koji **piše** ostaje van opsega.

---

## Stack

- **Node** LTS (20+), **pnpm** (monorepo), **TypeScript** (strict)
- **VS Code** ekstenzija (Extension Host) + **React webview** (Vite build)
- **`@mozaik-ai/core`** — agent runtime
- **`@vscode/ripgrep`** — reuse VS Code-ov rg binary za search
- Lokalni modeli: **Ollama** (`http://localhost:11434/v1`), fallback cloud preko API-ja
- Hardver dev mašine: RTX 4070 Ti 12GB VRAM + 128GB RAM → 14B-klasa u VRAM-u (~40–55 tok/s), veliki MoE u RAM-u za heavy faze

---

## Layout (pnpm monorepo)

```
coding-agent/
  pnpm-workspace.yaml
  package.json
  INIT.md
  .env.example
  packages/
    extension/            # VS Code ekstenzija (ext host)
      src/extension.ts    # activate(): registruje view + komande, hostuje agenta
      src/webview/        # React chat UI → dist
      package.json        # contributes: views, commands, keybindings
    agent-core/           # Mozaik loop, tools, model  ← seli se u fork netaknut
      src/index.ts        # javni API (nema import 'vscode')
      src/session/        # createAgentSession, startTurn guards
      src/context/        # compactContext, token-budget sliding window
      src/participants/   # EditorAgent, UIBridge
      src/tools/          # read_file, list_dir, search, get_context, propose_edit
      src/model/          # Ollama Chat Completions + ModelConfig
      src/workspace/      # WorkspacePort + path helpers
    shared/               # tipovi za poruke ext ↔ webview ↔ (kasnije) agent proces
```

Pravilo: fakt o editoru → `extension`; fakt o agentu/loop-u → `agent-core`; tip poruke → `shared`.

---

## Protokol poruka (ext ↔ webview)

Drži u `shared/`. Isti oblik kasnije ide preko JSON-RPC-a kad se agent izdvoji (v5).

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

---

## Mapa milestone-ova

| Ver | Rezultat | Fokus |
|---|---|---|
| **v0** | F5 → panel u sidebar-u, poruka ode i vrati se | infra |
| v1 | Chat sa agentom, read-only tools (`read_file`/`list_dir`/`search`/`get_context`) | Mozaik loop |
| v2 | **Apply/diff** — predloži → review (`vscode.diff`) → primeni (`WorkspaceEdit`) | najteže |
| v3 | Token streaming + tool viz + @-context | UX |
| v4 | Terminal tool iza approval gate-a | agentic |
| v5 | Izdvoji agenta u zaseban proces (JSON-RPC/stdio) | priprema za fork |

Detaljan plan po fazama: vidi `plan-implementacije-vscode-agent.md`.

### Gde smo (2026-09-06)

v0–v3 rade. v4 (terminal iza approval gate-a) i v5 (izdvajanje procesa) još nisu počeli.

Trenutni tool surface koji model vidi:

| Grupa | Tools |
|---|---|
| Čitanje | `read_file`, `list_dir`, `search`, `glob`, `outline`, `get_context` |
| Language server | `references`, `hover`, `diagnostics` |
| Izmene (predlog → review) | `write`, `edit`, `delete_file` (+ interni `propose_edit` kao fence fallback) |
| Mreža | `web_fetch`, `docs_search` (Context7, bez ključa) |
| Ljudski input | `question` |
| Fan-out | `research` |

Napomena o budžetu: svaka tool šema se šalje uz **svaki** inference poziv. Sa
ovoliko alata to je nezanemarljiv deo 16k prozora — pre dodavanja novog alata
proveri context ring, ne samo da li alat radi.

---

## Prvi korak — v0 (cilj prve sesije)

```bash
# 1. monorepo skelet
mkdir coding-agent && cd coding-agent
pnpm init
printf "packages:\n  - 'packages/*'\n" > pnpm-workspace.yaml

# 2. ekstenzija
pnpm dlx yo code   # → New Extension (TypeScript), smesti u packages/extension
#    (ili ručno: yeoman generiše, pa premesti u packages/extension)

# 3. prazan React webview panel u sidebar-u
#    - registruj WebviewViewProvider (contributes.views)
#    - komanda `agent.focus` + keybinding
#    - Vite build za webview → extension učitava dist sa nonce + CSP
```

**Definicija gotovog za v0:** pokreneš Extension Development Host (F5), vidiš svoj panel u sidebar-u, dugme pošalje `user_message` u ext host i vrati `assistant_delta` nazad u webview (za sad echo). Kad ovo radi — v1 (Mozaik loop) ide brzo jer `cli-agent-starter` ima skoro sve.

---

## Env / modeli

`.env.example` (kopiraj u `.env`, ne commit-uj `.env`):

```bash
# Mozaik Cloud (https://app.jigjoy.ai) — live loop view. Nije LLM ključ.
MOZAIK_API_KEY=
# MOZAIK_CLOUD_ENDPOINT=https://api.app.jigjoy.ai

# Provider keys for inference
ANTHROPIC_API_KEY=
OPENAI_API_KEY=not-needed
OPENAI_BASE_URL=http://localhost:11434/v1
# Preporuka za start: gemma4:12b (pouzdan tool-format); qwen2.5-coder:14b kao fallback
LOCAL_MODEL=gemma4:12b
```

Za produkciju ključeve drži u VS Code **SecretStorage**, ne u kodu.

---

## Konvencije

- TypeScript `strict: true`; `agent-core` bez ijednog `import 'vscode'`.
- Tools su čiste funkcije sa deklarisanim schema-ma; side-effect (pisanje na disk) ide isključivo kroz applier u ext host-u, agent samo *predlaže* (`propose_edit`).
- Bez tajni u kodu i logovima; ne loguj sadržaj korisničkih fajlova bez potrebe.
- Svaki novi participant se dodaje `join`-om na environment i ne dira postojeće (to je poenta bus modela).
- Potvrdi tačne Mozaik potpise (`AgenticEnvironment`, `BaseAgentParticipant`, `BaseObserver`, `runInference`, `onExternalModelMessage`, `onFunctionCall`) uz `cli-agent-starter` — menjaju se po verzijama.

---

## Reference

- `jigjoy-ai/cli-agent-starter` — minimalni TS Mozaik loop (API istina)
- `jigjoy-ai/mozaik` — framework
- `jigjoy-ai/baro` + `docs/collective-runtime.md` — arhitektura za budući agent mode (Board = jedini writer stanja, Broker leases, worktree izolacija, tool-less Critic, Surgeon replan)