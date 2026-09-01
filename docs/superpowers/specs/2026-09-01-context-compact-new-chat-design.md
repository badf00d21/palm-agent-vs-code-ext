# Context compact + New chat — design spec

**Datum:** 2026-09-01  
**Status:** odobren  
**Nastavlja:** `docs/superpowers/specs/2026-08-30-context-usage-markdown-design.md` (prsten meri prozor; clear/compact je tamo bio van opsega)  
**Ne pokriva:** LLM summary, pragovi boje na prstenu, auto-new-chat, compact tela trenutnog turna, zatvaranje `vscode.diff` taba, ručni `numCtx`, procena iz karaktera

---

## Cilj

Čovek može da krene čist chat jednim klikom, a agent ne šalje Ollama-u natečena stara tool tela. Kad i to nije dovoljno, stariji turnovi ispadnu iz **model** konteksta pre overflow-a, uz jednu status liniju u UI.

**Gotovo je kad važi sve ovo:**

1. New chat prazni webview, agent `ModelContext` (ostaje samo system prompt) i pending review. Nema confirm. Disabled dok je agent busy ili je chat prazan.
2. Pre svakog inference-a, `FunctionCallOutputItem` van poslednjeg turna postaje stub; `FunctionCallItem` ostaje.
3. Ako postoje `lastUsed` i `max` i `lastUsed / max >= 0.8` i ima više od 3 user turna, drop najstarijih dok ne ostanu 3 (uključujući trenutni). Webview dobija `{ type: "context_trimmed" }` i status liniju. Chat istorija se ne briše.
4. Ako `max` ili `lastUsed` fale — samo stub, nema slide, nema status linije.
5. `packages/agent-core` i dalje nema `import 'vscode'` i ne zove Ollama `/api/*`.
6. Testovi ispod prolaze bez živog Ollama-a i bez VS Code UI-ja.

---

## Zaključane odluke

- Pristup: čiste funkcije u `agent-core`, mutate `ModelContext.items` (isti niz koji vraća `getItems()`), `EditorAgent.run` zove compact **pre** `runLocalChatCompletions`.
- Turn = od `UserMessageItem` (uključivo) do sledećeg (isključivo). `DeveloperMessageItem` je uvek prvi i nikad se ne dira.
- Compact ide **posle** `addContextItem(user)`, **pre** inference. Poslednji turn je onaj koji tek počinje, pa se tela prethodnog turna stubuju pre prvog tokena novog pitanja.
- Stub tekst (tačno): `[omitted from context; call again if needed]`. Isti `callId`. Već stubovan output se ne dira. Svi toolovi, ne samo `read_file`.
- `KEEP_TURNS = 3`. `SLIDE_RATIO = 0.8`. Slide je jedan rez do 3 turna, ne petlja po stale `lastUsed`.
- `lastUsed` = `usage.total_tokens` sa prethodnog inference koraka (isti izvor kao prsten). `max` i dalje dolazi iz extension `/api/ps` preko `sessionHost`.
- `max === null` ili nema `lastUsed` ili `max <= 0` → nema slide.
- Slide nikad ne dropuje trenutni turn. Drop je uvek ceo turn (call + output + assistant), nikad nepar.
- `context_trimmed` samo kad je bar jedan turn dropovan. Stub je tih. Drugi compact u istom turnu bez novog dropa ne emituje ponovo.
- Semantic event u core-u: `context_trimmed` (isti obrazac kao `context_usage` / `NARRATION_EVENT`), prazan payload. UIBridge → `{ type: "context_trimmed" }`. Copy je u webview-u, ne u payload-u: `Context trimmed to last 3 turns`.
- New chat: `{ type: "new_chat" }` → ako `busy`, no-op. Inače `reviewStore.clear()` (pending = undefined, **nema** `diff_settled`), `session.reset()`, `{ type: "session_cleared" }`.
- `reset()` pravi novi `AgenticEnvironment` + `ModelContext` + agent/UI/user; isti `sink`. Ne zove `cancel` (nema `Cancelled` pa prazan chat). `lastUsed` se briše; keš `max` u `contextWindow` ostaje (isti model). `generation` sme da raste dalje. Stari environment se baca — zato je `reset` dozvoljen samo kad nije `busy`.
- Nema confirm dijaloga. Nema keybindinga. Command Palette: `palmAgent.newChat` (ista putanja kao dugme).
- Dugme **New chat**: secondary, u `composer-actions` levo od Add selection. Disabled kad `busy` ili `messages.length === 0`.
- Composer textarea ostaje (nije istorija). Prsten se sakrije dok ne stigne novi `context_usage`. Otvoren `vscode.diff` se ne zatvara.
- Status linija: `{ role: "status", text: "Context trimmed to last 3 turns" }`. Nije markdown. Labela **Status**, 11px uppercase, 70% opacity, kao You/Agent/Tool/Review.
- `applyExtMessage`: `context_trimmed` dodaje status liniju; `session_cleared` i `context_usage` ne menjaju niz.
- App: `context_trimmed` ide kroz `applyExtMessage` i **ne** gasi `busy`. `session_cleared` **ne** ide kroz `applyExtMessage` kao reset niza — App postavlja `messages = []`, `context = null`, `busy = false`.
- DESIGN.md: New chat je secondary kao Add selection; nova role labela Status (isti 11px uppercase, 70% opacity).
- Command dok webview još nije `resolve`-ovan: i dalje `clear` + `reset`; `session_cleared` se šalje samo ako postoji `post`.
- Compact ne baca. Loš args JSON nije razlog da se output ne stubuje.

---

## Van opsega

LLM auto-summary, boja prstena na 90%, compact usred trenutnog turna (stub/slide trenutnih tool tela), zatvaranje diff taba, header bar, confirm modal, keybinding, `numCtx` iz settings, char-count fallback kad nema `max`.

---

## Wire

```
user_message
  → UserMessageItem
  → EditorAgent.run
       compactContext(items, { lastUsed, max })
         stub outputa van poslednjeg turna
         maybe splice starih turnova
         ako trimmed → SemanticEvent context_trimmed
            → UIBridge → { type: "context_trimmed" }
            → status linija u chatu
       runLocalChatCompletions
         usage.total_tokens → lastUsed
         context_usage → sessionHost + /api/ps → max na session

new_chat (dugme ili palmAgent.newChat)
  → busy? no-op
  → reviewStore.clear()
  → session.reset()
  → { type: "session_cleared" }
       App: messages=[], context=null
```

Granice: heuristika i mutate u `agent-core`; `/api/ps` i review store u `extension`; tipovi u `shared`. Nema `import 'vscode'` u `agent-core`.

---

## API (agent-core)

Fajl: `packages/agent-core/src/context/compact.ts`.

```ts
export const KEEP_TURNS = 3;
export const SLIDE_RATIO = 0.8;
export const STUB_TEXT = "[omitted from context; call again if needed]";
export const CONTEXT_TRIMMED_EVENT = "context_trimmed";

export interface CompactBudget {
  lastUsed?: number;
  max: number | null;
}

/** Mutates `items` in place (the array ModelContext.getItems() returns). */
export function compactContext(
  items: ContextItem[],
  budget: CompactBudget,
): { trimmed: boolean };
```

`trimmed === true` samo ako je bar jedan item uklonjen (slide), ne ako je samo stub.

Stub: za svaki `FunctionCallOutputItem` čiji index nije u poslednjem turnu i čiji `output.text !== STUB_TEXT`, zameni item sa `FunctionCallOutputItem.create(callId, STUB_TEXT)`.

Slide: ako `typeof lastUsed === "number" && Number.isFinite(lastUsed)` i `typeof max === "number" && max > 0` i `lastUsed / max >= SLIDE_RATIO` i broj `UserMessageItem > KEEP_TURNS`, `splice` od prvog user itema do user itema koji ostaje kao prvi od poslednjih `KEEP_TURNS`. Jednom, dok ne ostane tačno 3 user turna.

`AgentSession` dobija:

```ts
reset(): void;           // no-op if busy
setLastUsed(used: number): void;
setContextMax(max: number | null): void;
```

`sessionHost` na `context_usage`: `setLastUsed(used)`, pa `attachMax`, pa `setContextMax(full.max)` i sink kao sad.

---

## Protokol (`packages/shared`)

```ts
// webview → ext  (dodatak na WebviewToExt)
{ type: "new_chat" }

// ext → webview  (dodatak na ExtToWebview)
{ type: "session_cleared" }
{ type: "context_trimmed" }
```

---

## UI

- New chat: host secondary button, square, copy `New chat`. Nema header bara.
- Status bubble: ista kartica 6px kao ostale; tekst plain; role label `Status`.
- `session_cleared` → empty state copy ostaje isti („Ask about a file…”).
- Command: contributes `palmAgent.newChat`, title `Palm Agent: New Chat`, activation `onCommand:palmAgent.newChat`. Bez keybindinga.

`reviewStore.clear()`: ako nema pending, no-op. Ako ima, zapamti path-ove, `pending = undefined`, `notifyProposedChange` za te path-ove (diff provider pokaže prazno). Nema emit `diff_settled`.

---

## Greške

| Situacija | Ponašanje |
|---|---|
| `new_chat` dok je busy | no-op; nema `session_cleared`, nema `Cancelled` |
| `apply_diff` posle clear | postojeći `"No pending review"` |
| Compact na praznom / samo system | no-op, `trimmed: false` |
| 4 turna, `max: null` | stub, sva 4 ostanu, nema eventa |
| 4 turna, `used/max < 0.8` | stub, sva 4 ostanu, nema eventa |
| Već 3 turna preko praga | stub, `trimmed: false` |
| Drugi compact, isti niz | identičan niz, `trimmed: false` |
| Inference padne posle slide | status linija ostaje (context jeste usečen) |

---

## Testovi (obavezni)

| Ponašanje | Očekivanje |
|---|---|
| 2 turna, `read_file` output u prvom | prvi output = `STUB_TEXT`; `FunctionCallItem` ostaje; drugi turn netaknut; `trimmed: false` |
| 4 user turna, `lastUsed/max >= 0.8` | ostanu system + poslednja 3 user turna; `trimmed: true` |
| 4 turna, `lastUsed/max < 0.8` | 4 user turna ostanu; stariji outputi stub |
| 4 turna, `max: null` | 4 ostanu; `trimmed: false` |
| 3 turna, preko praga | `trimmed: false` |
| Drugi poziv na već compactovan niz | isti sadržaj; `trimmed: false` |
| `session.reset()` pa `startTurn` | radi; context posle reset-a samo system dok ne stigne user |
| `reset()` dok `startTurn` još nije settle-ovao | `busy` ostaje true; context se ne prazni |
| UIBridge `context_trimmed` event | `{ type: "context_trimmed" }` |
| `applyExtMessage` + `context_trimmed` | jedna `{ role: "status", text: "Context trimmed to last 3 turns" }` |
| `applyExtMessage` + `session_cleared` | isti niz (referenca ili deep-equal prev) |
| `reviewStore.clear()` pa `apply` | `{ type: "error", message: "No pending review" }` |

---

## Rizici

- Mozaik nema public remove API — oslanjamo se na to da je `getItems()` živi niz (`items.push` u core-u). Ako to ikad postane kopija, compact neće stići do HTTP-a. Test koji posle compact-a čita `context.getItems()` hvata to.
- `lastUsed` je sa **prošlog** koraka. Jedan turn sa mnogo `read_file` i dalje može da prebije 16k u toku turna — prihvaćeno (nema summary, nema stub trenutnog turna).
- Race: `setContextMax` je async posle `/api/ps`. Prvi turn posle reload-a može da vidi `max: null` i da ne slide-uje. Stub i dalje radi. Sledeći turn ima `max`.
- Stari `vscode.diff` tab posle New chat pokazuje prazan proposed sadržaj posle `notifyProposedChange` — prihvaćeno.
