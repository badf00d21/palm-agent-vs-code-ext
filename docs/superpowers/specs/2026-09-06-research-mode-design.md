# Research mode (multi-agent fan-out) — design spec

**Datum:** 2026-09-06
**Status:** implementirano
**Nastavlja:** `docs/ollama-setup.md` (context-length trap koji je ceo razlog za ovaj alat); `docs/mozaik-divergences.md` (šta bus daje besplatno, šta ne)
**Ne pokriva:** MCP alate za worker-e, perzistenciju research run-ova preko New chat-a, nested research (worker koji zove research), promenu `MAX_SUBQUESTIONS`/`MAX_CONCURRENT_WORKERS` preko settings-a, streaming delta unutar jednog worker-a u UI (samo activity linije)

---

## Cilj

`research` je tool koji EditorAgent zove kad bi pitanje zahtevalo mnogo čitanja po mnogo fajlova. Umesto da glavni agent sam ide file-by-file i puni **svoj** 16k prozor sirovim sadržajem, pitanje se razbije na par pod-pitanja, svako ide na svog read-only worker-a, i glavni agent dobije samo kompaktan digest.

**Gotovo je kad važi sve ovo:**

1. `research(question)` postoji kao tool u punoj `createWorkspaceTools` listi i opisan je tako da model razume kad da ga koristi (široko pitanje preko mnogo fajlova), a kad ne (jedan poznat fajl, uzak lookup).
2. Dekompozicija ide preko jednog LLM poziva (`host.model` — isti model kao glavni turn, ne poseban; `tools: []`) koji vraća JSON niz od najviše `MAX_SUBQUESTIONS` (4) pod-pitanja; loš/prazan/non-JSON odgovor pada na **jedno** pod-pitanje = originalno pitanje.
3. Worker-i se izvršavaju na deljenom `AgenticEnvironment`-u sa concurrency cap-om `MAX_CONCURRENT_WORKERS` (3); worker sme samo read-only alate (`filterReadOnlyTools`).
4. Svaki worker vraća nalaz odsečen na `FINDING_CHAR_LIMIT` (350 karaktera); ceo digest je odsečen na `DIGEST_CHAR_LIMIT` (2000).
5. Glavni agent nikad ne vidi sirovi sadržaj fajlova koje su worker-i čitali — samo pitanje + nalaz po worker-u.
6. UI (`ResearchCard`) prikazuje live fan-out: started → per-worker running/activity/done/failed → settled, preko tri semantic eventa na istom busu koji već nosi `context_usage`/`context_trimmed`.
7. Idle timer glavnog turna se ne gasi tokom research-a (za razliku od `question`), nego se bump-uje na svaki worker event, jer je ovo model/I-O vreme, ne čovekovo vreme.
8. Jedan pao worker ne obara run; svi pali workeri → `Error:` glavnom agentu; abort usred run-a rešava run kao `cancelled` sa onim što je stiglo, nikad ne visi.
9. Testovi ispod prolaze bez živog Ollama-a.

---

## Zaključane odluke

| Tema | Izbor |
|---|---|
| Zašto subagenti uopšte | Context-budžet mehanizam, ne mehanizam brzine (vidi Arhitektura → Rationale #1) |
| Paralelizam | I/O se preklapa; inference na Ollama-i ne — `OLLAMA_NUM_PARALLEL: 1` (`docs/ollama-setup.md`) |
| Worker tool surface | Explicit allow-list (`READ_ONLY_TOOL_NAMES`), ne prefix-match — fail-closed |
| Dekompozicija | Jedan `OneShotAsker` LLM poziv, `tools: []`, JSON-only prompt; garbage → fallback na originalno pitanje |
| Concurrency | `MAX_CONCURRENT_WORKERS = 3` runner-a koji vuku iz zajedničkog indeksa (work-stealing pool), ne `Promise.all` po worker-u |
| Idle timer | `onHeartbeat` bump na SVAKI worker event, za razliku od `question` koji timer gasi (`clearIdleTimer`) |
| Bus | Isti `AgenticEnvironment` kao glavni `EditorAgent`; nema poseban bus po worker-u |
| Cross-talk zaštita | `producerId` routing u `BaseParticipant` (nasleđeno, ne novo za research) — eksplicitan test |
| `getEnvironment`/`getSignal` | Live getteri, ne uhvaćene vrednosti — bus i AbortController se prave iznova po turnu/New chat |
| Digest sadržaj | `Q:`/`A:` parovi za uspele, `(failed: …)` za pale; string, ne struktura — ide direktno u model context |
| Van file-lease/human_build mašinerije | Da, jer je read-only (vidi Rationale #4) |

---

## Arhitektura

```
EditorAgent (glavni turn, 16k prozor)
   │ poziva tool "research"
   ▼
createResearchTool (tools/research.ts)
   │ join-uje "Research Coordinator" participant na environment
   │ emit research_started / research_worker / research_settled
   ▼
runResearch (research/coordinator.ts)
   │
   ├─ OneShotAsker  ──LLM (tools:[])──▶  JSON niz pod-pitanja
   │                                     (parseSubQuestions, fallback na 1)
   │
   ├─ workers[] = { id, question, status:"pending", steps:0 }
   │  onStarted(workers) ──▶ RESEARCH_STARTED_EVENT
   │
   └─ runOne() × min(3, workers.length)   ← work-stealing pool po nextIndex
         │
         ▼
      ResearchWorkerAgent (research/worker.ts)
         │ join-uje se na ISTI AgenticEnvironment
         │ read-only tools (filterReadOnlyTools)
         │ WORKER_MAX_INFERENCE_STEPS=6, WORKER_MAX_IDENTICAL_CALLS=2
         │ onActivity → emit RESEARCH_WORKER_EVENT (running + steps++)
         │ onDone(text) / onFailed(msg)
         ▼
      buildDigest(workers) → "Q:...\nA:..." odsečeno na DIGEST_CHAR_LIMIT
   │
   ▼
emit RESEARCH_SETTLED_EVENT { status, digest, message }
   │
   ▼
tool vraća digest (ili "Error: …" / "…cancelled…") EditorAgent-u
```

```
BusEvent (research_started | research_worker | research_settled)
   │  Mozaik bus: publish() broadcast svim joined participant-ima
   ▼
UIBridge.onExternalEvent → eventFromResearch (participants/ui-bridge.ts)
   │  payload je već ExtToWebview minus `type` — pass-through re-tag
   ▼
ExtToWebview { type: "research_started" | "research_worker" | "research_settled", ... }
   │  postMessage → webview
   ▼
ResearchCard.tsx (per-worker red, status dot, activity, "Show digest")
```

| Deo | Gde |
|---|---|
| Tool definicija + host wiring | `packages/agent-core/src/tools/research.ts` |
| Dekompozicija, pool, digest | `packages/agent-core/src/research/coordinator.ts` |
| Worker agent, allow-list, prompt | `packages/agent-core/src/research/worker.ts` |
| Session wiring (tool push, `onHeartbeat`) | `packages/agent-core/src/session/session.ts` |
| Bus → webview prevod | `packages/agent-core/src/participants/ui-bridge.ts` (`eventFromResearch`) |
| Tipovi protokola | `packages/shared/src/index.ts` (`ResearchWorker`, `research_started`, `research_worker`, `research_settled`) |
| UI panel | `packages/extension/src/webview/ResearchCard.tsx` |
| Testovi | `packages/agent-core/test/research/{coordinator,worker}.test.ts`, `packages/agent-core/test/tools/research.test.ts` |

---

## Ponašanje

### Zašto subagenti — context-budžet, ne brzina

Na 16k prozoru (`docs/ollama-setup.md`: `OLLAMA_CONTEXT_LENGTH: 16384`, minimum za rad), jedan `read_file` može vratiti do 24k karaktera (~6k tokena) — skoro 40% celog prozora glavnog agenta u jednom pozivu. Kad pitanje zahteva da se pogleda pet-šest fajlova da bi se sastavio odgovor, glavni agent bi context probio pre nego što uopšte stigne do odgovora.

`research` rešava to premeštanjem **čitanja** na worker-e čiji context niko drugi ne vidi. Worker pročita šta mu treba (svojih 16k, potpuno odvojeno od glavnog turna), i vrati nalaz odsečen na `FINDING_CHAR_LIMIT = 350` karaktera. Glavni agent plaća samo `Q: ... / A: ...` par po pod-pitanju, nikad sirovi `read_file` izlaz. To je cela poenta — komentar u kodu (`coordinator.ts`) to kaže eksplicitno: *"Budžet po worker nalazu — cela poenta je da roditelj nikad ne plaća sirovi materijal."*

### Zašto NIJE o brzini paralelizma

Ovo je namerno zapisano kao poznato ograničenje, ne kao prednost. `docs/ollama-setup.md` dokumentuje `OLLAMA_NUM_PARALLEL: 1` — Ollama pravi N slotova i **deli** ukupni context na njih (`CONTEXT_LENGTH=16384` / 4 slota = 4096 po zahtevu, nazad na context-trap). Za jedan veliki 16k slot mora `OLLAMA_NUM_PARALLEL: 1`.

Posledica: tri worker-a koja "rade paralelno" u `MAX_CONCURRENT_WORKERS = 3` pool-u zapravo **redom čekaju na isti inference slot** kad god pozovu model. Komentar u `coordinator.ts` na `MAX_SUBQUESTIONS` to kaže direktno: *"Više worker-a samo produbljuje red na Ollaminom jedinom inference slotu."* Ono što se stvarno preklapa je I/O — čitanje fajlova, ripgrep pretraga, mrežni `web_fetch` — dok worker A čeka na disk, worker B može da radi. Sam LLM poziv se ne preklapa. Concurrency cap od 3 postoji da ograniči taj red, ne da ubrza generisanje.

### Šta Mozaik daje besplatno, šta ne (vidi `docs/mozaik-divergences.md`)

Mozaikov bus je sinhrona broadcast petlja: `publish()` prolazi kroz svakog joined participant-a; handler promise-i se ne await-uju. To je **sve** što bus daje ovde — nema scheduler, nema queue, nema concurrency cap, nema back-pressure, nema cancellation. Svo to je bespoke u ovom paketu:

- concurrency cap → work-stealing pool u `runResearch` (`nextIndex`, `runnerCount = Math.min(MAX_CONCURRENT_WORKERS, workers.length)`)
- cancellation → eksplicitna provera `signal.aborted` na svakom koraku pool-a i unutar `ResearchWorkerAgent.isStale()`
- back-pressure prema glavnom agentu → `FINDING_CHAR_LIMIT` / `DIGEST_CHAR_LIMIT`, bespoke truncation, ne Mozaik

Šta bus **daje** besplatno: fan-in / observability. Svaki worker event stiže na `UIBridge` bez ijedne dodatne žice — `ResearchWorkerAgent` se samo `join`-uje na isti `environment` kao glavni `EditorAgent` i `UIBridge`, i njegovi eventi automatski prolaze kroz isti `onExternalEvent` put kao `context_usage`/`context_trimmed`. To je ono što čini live progress panel jeftinim: nula posebne infrastrukture za "reci UI-ju šta worker radi".

Cross-talk između worker-a (i između worker-a i glavnog `EditorAgent`-a) je sprečen `producerId` rutiranjem u `BaseParticipant`: bus emituje svaki event svima na busu, ali `BaseParticipant` zove `onFunctionCall`/`onFunctionCallOutput`/`onModelMessage` **samo** za evente koje je taj participant sam proizveo (`event.producerId === participant.getId()`); tuđi padaju na `onExternal*` no-op. Postoji eksplicitan test za ovo — `packages/agent-core/test/research/worker.test.ts` → `describe("ResearchWorkerAgent cross-talk")`, dva worker-a sa istim tool imenom (`echo`) na istom environment-u, proverava da poziv jednog ne pokrene tool drugog.

### Zašto su worker-i read-only po konstrukciji

`READ_ONLY_TOOL_NAMES` (`worker.ts`) je eksplicitan `Set`: `read_file`, `list_dir`, `search`, `outline`, `glob`, `references`, `hover`, `diagnostics`, `web_fetch`, `docs_search`. Nema `write`, `edit`, `propose_edit`, `question`, ni `research` samog sebe — worker koji piše fajl, blokira na čoveku, ili rekurzivno pravi novi fan-out je bug, ne feature.

Lista je **imenovana eksplicitno, ne prefix-match**: `filterReadOnlyTools` filtrira po članstvu u Set-u, ne po nekom `startsWith`. To fail-closed: nov alat dodat sutra ostaje isključen dok neko svesno ne odluči da je bezbedan ovde — pravi default kad je ono što se isključuje moć da se piše.

Read-only takođe znači da research zaobilazi celu file-lease / `human_build` gate mašineriju iz `docs/superpowers/specs/2026-09-01-agent-orchestration-yaml-design.md` (claim/lease po fajlu, `gate: human_build` pre nego što bilo koji worker sme da uzme task). Ta mašinerija postoji da spreči da dva pisca dele fajl bez koordinacije — pitanje koje ne postoji kad nijedan worker ne piše ništa. To je i razlog zašto je research bio prvi bezbedan multi-agent use case u ovom runtime-u: nema šta da se leasuje.

### Heartbeat, ne clear

`question` tool (`tools/question.ts` preko `session.ts`) zove `clearIdleTimer()` kad čoveka pita nešto — čeka na čoveka, pa idle timer nema smisla dok on ne odgovori. `research` je suprotno: to je model/I-O vreme, ne čovekovo vreme, pa mora da **nastavi** da bump-uje `IDLE_TIMEOUT_MS` (120_000ms, `session.ts`) na svaki worker event, ili dugačak run biva ubijen kao stall.

Wiring u `session.ts`:

```ts
createResearchTool({
  getEnvironment: () => environment,
  model: config.model,
  tools,
  getSignal: () => turnAbort?.signal,
  onHeartbeat: () => bumpIdleTimer(generation),
});
```

`onHeartbeat` se zove i iz `runResearch` na `onStarted` i na svaki `emit(worker)` u pool-u (dakle na svaki status prelaz i svaku activity liniju), tako da run od više minuta sa aktivnim worker-ima nikad ne udari u 120s limit sve dok stvarno napreduje.

### Live getteri, ne uhvaćene vrednosti

`ResearchHost.getEnvironment` i `getSignal` su funkcije, ne polja, jer se `environment` i `turnAbort` prave **iznova** po turnu i po New chat-u unutar `session.ts` (`rebuild()`). Tool se pravi jednom, zajedno sa ostalim workspace alatima, pri startu sesije — da su `environment`/`signal` uhvaćeni u tom trenutku, pokazivali bi na mrtav bus posle prvog New chat-a. Komentar u `research.ts` to kaže direktno; postoji i test za ovo (`research.test.ts` → *"reads the environment and signal live at call time, not at tool-construction time"*).

### Failure semantika

- **Jedan worker padne:** ostali nalazi se i dalje vraćaju; `buildDigest` za pali worker upiše `(failed: <error>)` red, run je `status: "done"` ako je bar jedan uspeo (`coordinator.test.ts` → *"keeps other findings when exactly one worker fails"*).
- **Svi padnu:** `status: "failed"`, tool vraća `Error: ${message}` glavnom agentu (poruka nosi razlog prvog pronađenog pada).
- **Abort usred run-a:** `signal.aborted` provera na ulazu u pool i unutar `ResearchWorkerAgent.isStale()` — run se rešava kao `cancelled` sa onim nalazima koji su već stigli, nikad ne visi.
- **Garbage dekompozicija:** `parseSubQuestions` ne prihvata jedan neobeleženi red teksta kao listu (to je najčešće odbijanje slabog modela ili prepričano pitanje) — samo prava multi-line lista se prihvata; inače fallback na `[original]`, tj. jedan worker istražuje originalno pitanje.

**Bug pronađen tokom implementacije** (zabeležen kao komentar u `worker.ts`, iznad `run()`): `onFailed` je prvobitno kopirao `EditorAgent`-ov `isStale()` guard pre poziva `this.fail(...)`. Problem: `isStale()` je tačno `true` na abort — a abort je baš slučaj koji `onFailed` mora da prijavi. Sa guard-om, pad na abort je bio tiho odbačen i `runResearch`-ov `Promise` koji čeka `onDone`/`onFailed` se nikad nije rešio — run je visio zauvek. Ispravka: poziv na `onFailed` u `run()` je namerno **bezuslovan** (bez `isStale()` provere); `fail()` sam po sebi je idempotentan protiv rezultata koji je već rešen kroz `onDone`/`onModelMessage`, pa dupli poziv ne štetuje. Test koji ovo pokriva: `worker.test.ts` → *"resolves via onFailed, never hangs, when aborted mid-run"*.

---

## Komponente

### `createResearchTool(host: ResearchHost): Tool` — `tools/research.ts`

```ts
export interface ResearchHost {
  getEnvironment: () => AgenticEnvironment;
  model: string;
  tools: Tool[];
  getSignal: () => AbortSignal | undefined;
  onHeartbeat?: () => void;
  createId?: () => string;
  fetchImpl?: ChatCompletionFetch;
}
```

Tool ime: `research`. Jedan string parametar `question` (required). Pravi `BaseParticipant("Research Coordinator", "agent")`, `join`-uje ga na environment isključivo da bi emitovao evente (`environment.deliverSemanticEvent` traži registrovanog participant-a po id-u).

### `runResearch(question, host, signal): Promise<ResearchRunResult>` — `research/coordinator.ts`

```ts
export const MAX_SUBQUESTIONS = 4;
export const MAX_CONCURRENT_WORKERS = 3;
export const FINDING_CHAR_LIMIT = 350;
export const DIGEST_CHAR_LIMIT = 2000;

export interface ResearchRunResult {
  status: "done" | "failed" | "cancelled";
  digest?: string;
  message?: string;
  workers: ResearchWorker[];
}
```

`parseSubQuestions(raw: string, original: string): string[]` — pokušava čist JSON, pa JSON unutar markdown fence-a, pa numbered/bulleted listu (samo ako ima >1 liniju); inače `[original]`.

`OneShotAsker` (interna klasa, `extends BaseParticipant`) — jedan LLM poziv sa `tools: []`; `onFunctionCall`/`onError` oba rešavaju na `""` umesto da vise, tako da čak i model koji ignoriše "JSON only" instrukciju ne blokira dekompoziciju.

### `ResearchWorkerAgent` — `research/worker.ts`

```ts
export const WORKER_MAX_INFERENCE_STEPS = 6;
export const WORKER_MAX_IDENTICAL_CALLS = 2;
export const WORKER_SYSTEM_PROMPT: string;

export function filterReadOnlyTools(tools: Tool[]): Tool[];
export function describeToolCall(name: string, rawArgs: string): string;

export class ResearchWorkerAgent extends BaseParticipant {
  constructor(
    environment: AgenticEnvironment,
    context: ModelContext,
    tools: Tool[],
    model: string,
    callbacks: ResearchWorkerCallbacks,
    fetchImpl?: ChatCompletionFetch,
  );
  start(question: string, signal: AbortSignal): void;
}

export interface ResearchWorkerCallbacks {
  onActivity: (line: string) => void;
  onDone: (text: string) => void;
  onFailed: (message: string) => void;
}
```

Read-only surface (`READ_ONLY_TOOL_NAMES`): `read_file`, `list_dir`, `search`, `outline`, `glob`, `references`, `hover`, `diagnostics`, `web_fetch`, `docs_search`.

### Protokol (`packages/shared/src/index.ts`)

```ts
export type ResearchWorkerStatus = "pending" | "running" | "done" | "failed";

export interface ResearchWorker {
  id: string;
  question: string;
  status: ResearchWorkerStatus;
  activity?: string;
  finding?: string;
  error?: string;
  steps: number;
}

// ExtToWebview dodatak
| { type: "research_started"; id: string; question: string; workers: ResearchWorker[] }
| { type: "research_worker"; id: string; worker: ResearchWorker }
| { type: "research_settled"; id: string; status: "done" | "failed" | "cancelled"; digest?: string; message?: string }
```

### `eventFromResearch(item: BusEvent): ExtToWebview | null` — `participants/ui-bridge.ts`

Pass-through re-tag: `{ type, ...(payload as object) }`. Namerno bez re-validacije polja — payload je već tipiziran na strani `coordinator.ts`, a delimičan copy ovde bi vremenom otišao iz sinhronizacije sa `shared` ugovorom svaki put kad on naraste.

### `ResearchCard` — `packages/extension/src/webview/ResearchCard.tsx`

Prikazuje pitanje, zbirni broj (`N done, M failed, ...`), po red za svakog worker-a (status dot, activity/status label, broj koraka, expand za finding/error), i "Show digest" toggle kad je `status === "done"` koji renderuje digest kroz `AssistantMarkdown` (isti markdown renderer kao asistentov odgovor).

---

## Testovi

`packages/agent-core/test/research/coordinator.test.ts`:

- `parseSubQuestions`: čist JSON, markdown fence, garbage → fallback, cap na `MAX_SUBQUESTIONS`, numbered-list heuristika
- `runResearch`: fan-out i agregacija digest-a; cap na finding/digest dužinu; jedan pao worker ne obara run; svi padnu → `status: "failed"`; abort usred run-a → `cancelled` bez hanga; nikad više od `MAX_CONCURRENT_WORKERS` istovremenih inference poziva; garbage dekompozicija → jedan worker na originalno pitanje

`packages/agent-core/test/research/worker.test.ts`:

- `filterReadOnlyTools`: čuva samo read-only surface, ispušta `write`/`edit`/`propose_edit`/`question`; ispušta nepoznat budući alat
- `describeToolCall`: content-free activity linija
- `ResearchWorkerAgent`: read-only tool poziv pa finish na model odgovor; fail posle previše koraka; blokira treći identičan poziv; **`onFailed` na abort usred run-a, nikad hang** (regresioni test za bug iz Rationale #7); nepoznato ime alata → error string, ne throw
- `describe("ResearchWorkerAgent cross-talk")`: dva worker-a sa istim tool imenom na istom environment-u — poziv jednog ne sme pokrenuti tool drugog (`producerId` routing)

`packages/agent-core/test/tools/research.test.ts`:

- traži `question`, vraća `Error:` kad prazan
- emituje `research_started`/`research_worker`/`research_settled` na deljenom busu i vraća digest
- svi worker-i padnu → `Error:` string
- signal već aborted → `cancelled` napomena bez hanga
- `getEnvironment`/`getSignal` se čitaju live u trenutku poziva, ne u trenutku konstrukcije tool-a

---

## Van opsega

- MCP alati u worker read-only listi (MCP je van opsega generalno po `docs/mozaik-divergences.md` napomeni o `McpClient`/`McpToolRegistry`)
- Perzistencija research run-a preko New chat-a (novi `environment` na reset, stari run i njegovi eventi se gube)
- Ugnježdeni research (worker koji poziva `research`) — eksplicitno isključen iz `READ_ONLY_TOOL_NAMES`
- Konfigurabilni `MAX_SUBQUESTIONS`/`MAX_CONCURRENT_WORKERS` preko VS Code settings-a
- Streaming delta teksta unutar jednog worker-a u UI (panel dobija samo status/activity/finding, ne token-by-token)
- Promena `OLLAMA_NUM_PARALLEL` da bi worker-i stvarno paralelno inferisali — van opsega jer deli 16k context na manje slotove (vidi Rationale #2), prihvaćeno ograničenje, ne bug
