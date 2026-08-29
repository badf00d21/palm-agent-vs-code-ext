# v1 Mozaik loop — design spec

**Datum:** 2026-08-29  
**Status:** odobren  
**Zamenjuje:** v0 echo (`packages/extension/src/echo.ts`)  
**Ne pokriva:** v2 apply/diff, v3 token streaming / @-context / cancel, v4 terminal, v5 IPC

---

## Cilj

Korisnik u sidebar chatu pita o kodu u otvorenom workspace-u. Agent (Mozaik, u extension host-u) sme da čita workspace preko četiri tool-a i da odgovori tekstom. Odgovor nije echo.

**Gotovo je kad važi sve ovo:**

1. F5 → pitanje o lokalnom fajlu → agent zove `read_file` ili `search` → odgovor koristi sadržaj fajla.
2. `packages/agent-core` nema nijedan `import 'vscode'`.
3. Unit testovi iz odeljka Testovi prolaze bez živog Ollama-a.
4. Ollama nedostupan → `error` sa čitljivom porukom, ekstenzija ne crash-uje.

---

## Zaključane odluke (ne preispituj u implementaciji)

- Runtime: `@mozaik-ai/core` — pun bus (`AgenticEnvironment` + agent + observer). Pristup A.
- Agent ostaje u extension host-u (ne child process).
- `agent-core` je čist od editora. Workspace I/O ide kroz injektovani `WorkspacePort`.
- Modeli: samo Ollama Chat Completions. Default model `qwen3:14b`. Korisnik prebacuje na `qwen2.5-coder:14b` settingom kad model stigne. Ime modela ne sme biti `gpt-*` / `o1`–`o9` / `text-*`.
- Edit format / apply: van opsega (v2). Nema `propose_edit`.
- Token streaming, `@file` autocomplete, `cancel` run: van opsega (v3). `cancel` poruka se i dalje ignoriše.
- Jedan run u isto vreme. Druga `user_message` dok run traje → `error` „agent is busy“.
- Jedan `ModelContext` po session-u (webview već ima `retainContextWhenHidden: true`). Reset samo na reload Extension Development Host-a.

Tačna Mozaik imena klasa (`BaseAgent` vs `BaseAgentParticipant`, `BaseObserver` vs `BaseObserverParticipant`, `sendMessage` vs `onMessage`) potvrđuju se uz instalirani paket i `jigjoy-ai/cli-agent-starter`. Semantika ispod ostaje.

---

## Van opsega

Codebase indexing, multi-agent, Tab/autocomplete, MCP, git checkpoints, cloud/Anthropic fallback, VS Code SecretStorage, write na disk, unified diff, terminal.

---

## Arhitektura

```
webview (App.tsx)
    user_message
         │
         ▼
extension (ChatViewProvider)
    session.startTurn(text)
         │
         ▼
agent-core
    AgenticEnvironment
      ├─ EditorAgent     (loop: inference ↔ tools)
      └─ UIBridge        (observer → ExtToWebview events)
         │
         ▼
WorkspacePort (interface u agent-core)
         │
         ▼
extension (VsCodeWorkspacePort)
    workspace.fs / activeTextEditor / @vscode/ripgrep
```

**Pravilo paketa**

| Paket | Sme | Ne sme |
|---|---|---|
| `agent-core` | Mozaik, tool šeme, port interface, session API | `import 'vscode'`, čitanje diska, spawn rg |
| `extension` | implementacija porta, settings, webview wiring | agent loop, Mozaik participant logika |
| `shared` | `WebviewToExt` / `ExtToWebview` | runtime zavisnosti |

v0 `handleUserMessage` u `echo.ts` se uklanja. Host na `user_message` zove session, ne echo.

---

## Session API (`agent-core`)

Extension konstruiše session jednom u `activate()` i drži ga dok je ekstenzija živa. `SessionEventSink` se postavlja u `resolveWebviewView` (i ponovo ako se webview rekreira). Do tada sink je no-op.

```ts
interface ModelConfig {
  baseUrl: string; // npr. http://localhost:11434/v1
  model: string;   // npr. qwen3:14b
  apiKey: string;  // "not-needed"
}

interface AgentSession {
  readonly busy: boolean;
  startTurn(text: string): Promise<void>;
}
```

`startTurn`:

- trimovan prazan tekst → emituje `{ type: "error", message: "Empty message" }`, ne startuje inference.
- `busy === true` → emituje `{ type: "error", message: "Agent is busy" }`, ne enqueue-uje.
- nema workspace-a (port `hasWorkspace() === false`) → `{ type: "error", message: "No workspace folder open" }`.
- inače: `busy = true`, pošalje tekst u environment, čeka kraj run-a, emituje `done` (ili `error` ako run pukne), `busy = false`.

Observer emituje evente kroz callback koji session dobije na konstrukciji:

```ts
type SessionEventSink = (event: ExtToWebview) => void;
```

Extension sink = `webview.postMessage`. Ako view još nije resolved, event se drop-uje (ne baferuje se).

---

## WorkspacePort

Definicija živi u `agent-core`. Extension implementira.

```ts
interface DirEntry {
  name: string;
  type: "file" | "dir";
}

interface SearchHit {
  path: string; // relativna na workspace root, POSIX separators
  line: number; // 1-based
  text: string; // sadržaj linije, trim end
}

interface EditorContext {
  activeFile: string | null; // relativna putanja ili null
  selection: string | null;  // izabrani tekst ili null
}

interface WorkspacePort {
  hasWorkspace(): boolean;
  readFile(path: string): Promise<string>;
  listDir(path: string): Promise<DirEntry[]>;
  search(query: string, glob?: string): Promise<SearchHit[]>;
  getContext(): Promise<EditorContext>;
}
```

**Path pravila**

- Ulaz sme biti relativan (`src/echo.ts`) ili apsolutan unutar workspace root-a.
- Resolve: `path.normalize` + mora ostati unutar workspace root-a (realpath). `..` escape → baciti grešku `Path is outside the workspace`.
- Više workspace foldera: prvi folder je root. Putanja koja pogađa drugi folder je van opsega za v1 (tretiraj kao outside).
- Relativne putanje u tool rezultatima koriste `/`, ne `\`.

**Implementacija u extension-u**

- `readFile` — `vscode.workspace.fs.readFile`, decode UTF-8. Binarni / decode fail → tool error string.
- `listDir` — `vscode.workspace.fs.readDirectory`, jedan nivo.
- `search` — `@vscode/ripgrep` binary, cwd = workspace root. `glob` ide kao rg `--glob` ako je dat.
- `getContext` — `vscode.window.activeTextEditor`: relativna putanja dokumenta + `document.getText(selection)` ako selekcija nije prazna.

---

## Učesnici i loop

**EditorAgent**

- `onMessage(text)`: doda user turn u `ModelContext`, zove `runInference`.
- `onFunctionCall(item)`: prati `callId` u pending setu, `executeFunctionCall`.
- `onFunctionCallOutput(item)`: skloni `callId`; kad je pending prazan, `runInference` ponovo.
- Sopstveni model output (poruka / reasoning) dodaje u isti `ModelContext` ako Mozaik to ne radi sam (potvrdi uz starter).

**UIBridge (observer)**

- Ne zove `runInference` ni tool-ove.
- Spoljni model tekst → `{ type: "assistant_delta", text }`. U v1 to je ceo emitovani komad, ne token stream. Svaki emit = jedan assistant bubble. Više model poruka u istom turnu = više bubble-ova (prihvatljivo; spajanje je v3).
- Spoljni function call → `{ type: "tool_call", name, args }`.
- Ne emituje `done` — to radi session na kraju `startTurn`.

**Ulaz od čoveka**

Nema posebnog Human participant-a u UI-u. Extension zove isti mehanizam koji starter koristi da gurne user tekst u environment (`sendMessage` ili `agent.onMessage`).

**Sistemski prompt (fiksan tekst u agent-core)**

You are a coding assistant in a local workspace. Use the provided tools to read the workspace before answering questions about code. Do not invent file contents. You cannot write files or apply patches in this version — only read, list, search, and report the active editor context.

---

## Tools

Šeme i handleri u `agent-core`. Handler samo validira argumente i zove port. Port grešku pretvara u tool result string (run nastavlja).

| Tool | Args | Ponašanje | Limit |
|---|---|---|---|
| `read_file` | `path: string` (required) | `port.readFile` | Ako `text.length > 100_000`, vrati prvih 100_000 + `\n[truncated]` |
| `list_dir` | `path: string` (required) | `port.listDir` | Jedan nivo, bez rekurzije |
| `search` | `query: string` (required), `glob?: string` | `port.search` | Prazan `query` → tool error. Max 50 hitova; ako ih ima više, poslednji red `[truncated to 50 hits]` |
| `get_context` | (nema) | `port.getContext` | `activeFile` / `selection` mogu biti null |

Nema drugih tool-ova u v1.

---

## Protokol (webview)

Postojeći tipovi u `packages/shared` se ne šire.

**v1 koristi**

- In: `user_message`
- Out: `assistant_delta`, `tool_call`, `done`, `error`

**v1 ignoriše**

- In: `apply_diff`, `reject_diff`, `cancel`
- Out: `diff_proposed` (niko ne emituje)

**UI**

- User bubble ostaje kako jeste.
- `assistant_delta` — novi assistant bubble (isti kao v0).
- `tool_call` — jedan sivi red u listi, npr. `read_file  src/echo.ts` (ime + kratak prikaz args). Nije poseban panel.
- `busy` od slanja do `done` ili `error`.
- `error` — assistant bubble `Error: …` i `busy = false`.

---

## Config

VS Code contributes.configuration (extension):

| Setting | Default | Namena |
|---|---|---|
| `palmAgent.ollamaBaseUrl` | `http://localhost:11434/v1` | Chat Completions base |
| `palmAgent.model` | `qwen3:14b` | Ime modela za Ollama |

`apiKey` je uvek literal `not-needed`. Nije setting.

`.env.example` ostaje dokument. Extension **ne** učitava `.env` u v1. Runtime = settings → `ModelConfig` → session.

Ako je `palmAgent.model` `gpt-*` / `o1`–`o9` / `text-*`, session na `startTurn` emituje `error` i ne zove inference (pogrešan Mozaik routing).

---

## Greške (korisničke poruke)

| Uzrok | `error.message` |
|---|---|
| prazan tekst | `Empty message` |
| run već traje | `Agent is busy` |
| nema workspace foldera | `No workspace folder open` |
| zabranjeno ime modela | `Model name routes to the wrong API. Use a local Ollama name such as qwen3:14b.` |
| Ollama down / network | `Cannot reach Ollama at <baseUrl>. Is it running?` |
| model nije povučen | poruka iz providera, skraćena, bez stack-a |
| path escape | tool result, ne session `error` |

Ne logovati sadržaj korisničkih fajlova.

---

## Predloženi fajlovi

Ne implementirati u ovom dokumentu; ovo je mapa za plan.

**agent-core**

- `src/port.ts` — `WorkspacePort` i DTO tipovi
- `src/config.ts` — `ModelConfig`, validacija imena modela
- `src/tools.ts` — šeme + handleri
- `src/participants/editor-agent.ts`
- `src/participants/ui-bridge.ts`
- `src/session.ts` — `createAgentSession(port, config, sink)`
- `src/index.ts` — javni exporti

**extension**

- `src/workspacePort.ts` — `VsCodeWorkspacePort`
- `src/sessionHost.ts` — čita settings, pravi session, veže sink
- `src/chatViewProvider.ts` — `user_message` → `startTurn` (echo nestaje)
- `src/webview/App.tsx` — render `tool_call`
- `package.json` — settings + zavisnost `@vscode/ripgrep`

**shared** — bez izmene tipova.

---

## Testovi

Bez mreže, bez Ollama-a, bez `vscode` u `agent-core` testovima.

1. **Path escape** — fake port ili čisti resolve helper: `../outside` → greška.
2. **`read_file` truncate** — port vrati 100_001 karakter; tool output se završava sa `[truncated]`.
3. **`list_dir`** — vraća samo jedan nivo (handler ne zove rekurziju).
4. **`search` cap** — 60 hitova sa porta → 50 + truncate napomena.
5. **`startTurn` empty** — sink dobije `error` / `Empty message`.
6. **`startTurn` busy** — drugi poziv dok prvi traje → `Agent is busy`.
7. **`startTurn` no workspace** — `No workspace folder open`.
8. **Forbidden model name** — `gpt-4` → error, inference se ne zove.
9. **Fake runner** — user tekst „read echo.ts“ + stub inference koji emituje function call pa model message → sink vidi `tool_call` pa `assistant_delta` pa `done`.
10. **UI parser** — `tool_call` poruka ne ruši webview state (unit oko reducer-a ili postojećeg message handler-a, kad se izvuče iz `App.tsx`).

Ručni check (nije CI): F5, Ollama sa `qwen3:14b`, pitanje „šta radi `packages/extension/src/echo.ts`?“ — vidi se tool red, pa odgovor koji pominje echo ponašanje.

---

## Zavisnosti

- `@mozaik-ai/core` u `agent-core`
- `@vscode/ripgrep` u `extension`
- `agent-core` zavisnost extension-a kao `workspace:*`

pnpm 11: novi native build (`esbuild` već dozvoljen) odobriti kroz `allowBuilds` u `pnpm-workspace.yaml` ako install zatraži.
