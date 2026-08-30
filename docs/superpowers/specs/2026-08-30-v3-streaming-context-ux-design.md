# v3 Streaming + tool viz + @-context — design spec

**Datum:** 2026-08-30  
**Status:** odobren  
**Nastavlja:** `docs/superpowers/specs/2026-08-29-v2-apply-diff-design.md`  
**Ne pokriva:** create/delete fajl, per-hunk Accept, chip + file body (opcija B), indexing, MCP, terminal, IPC

---

## Cilj

Chat se ponaša kao interaktivni editor agent: prose stiže token po token u **jedan** bubble, tool redovi pokazuju running → done, composer nudi `@putanja` i „Add selection“. Cancel ostaje kako je u v2 (Stop → `AbortController`).

**Gotovo je kad važi sve ovo:**

1. F5 → pitanje koje ne traži tool → tokeni se dopisuju u isti assistant bubble dok model radi; waiting nestaje na prvom prose.
2. Pitanje koje zove `read_file` → jedan tool red (`read_file  path`) prelazi running → done; tool JSON se **nikad** ne vidi u assistant bubble-u.
3. U composeru `@abc` predlaže do 20 workspace path-ova; izbor ubacuje `@src/foo.ts` u tekst. Send šalje taj string. Ext **ne** čita fajl da bi ga zalepio u prompt.
4. Add selection dopisuje trenutnu selekciju u textarea (ne šalje samo).
5. `packages/agent-core` i dalje nema `import 'vscode'`.
6. Testovi iz odeljka Testovi prolaze bez živog Ollama-a i bez VS Code UI-ja.

---

## Zaključane odluke

- Jedan v3 ciklus, ređeno: **streaming → tool viz → `@` + selekcija**. Cancel se ne dira.
- Streaming: pravi Ollama `stream: true` (pristup 1). Nema novog stream state machine-a u protokolu. Nema lažnog chunkovanja posle kompletnog JSON-a.
- Tool JSON (content koji izgleda kao call, ili native `tool_calls`) se **bufferuje** do kraja. UI vidi samo finalni prose i `tool_call` redove. Sumnja = buffer.
- Stream delte su **samo UI** (`NARRATION_EVENT` → `assistant_delta`). U Mozaik kontekst na kraju ide jedna `ModelMessageItem` ili function call-ovi, kao danas. Tokeni nisu posebne context poruke.
- Tool viz: isto `formatToolArgs` (ime + path/query). `tool_call` dobija `id` + `status: "running" | "done"`. Output tool-a se **ne** prikazuje.
- `@` je putanja u tekstu, ne chip i ne file body. Agent čita toolovima (`read_file` / `search`).
- **Odloženo B:** chip u UI + sadržaj fajla u payload-u (Cursor-stil). U kodu pored `suggest_files` handlera mora stajati komentar da se B razmotri kasnije. Ne implementirati B u v3.
- Add selection je posebno dugme; nije `@`.
- `suggest_files` koristi isti exclude/cap kao `findFiles` (20, `node_modules` / `dist` / `out` / `.git`), ali **prefix glob** `**/*{safe}*` — ne exact basename koji `findFiles` koristi za `read_file` locate.

---

## Van opsega

Create/delete fajl, per-hunk Accept, `@folder` / `@docs`, više workspace root-ova, drag-and-drop, attach file body, expand tool args JSON, sakrivanje uspešnih toolova, indexing, MCP, v4 terminal, v5 IPC, promena cancel semantike.

---

## Arhitektura

```
Ollama SSE (stream: true)
  → local-inference assembler
       ├─ looks like tool JSON / native tool_calls → buffer, no UI
       └─ prose chunk → SemanticEvent NARRATION_EVENT
            → UIBridge → assistant_delta (append in webview)
  → on stream end: deliverCompletion (postojeći parser)
       ├─ tool calls → FunctionCallItem (bus)
       └─ prose → jedna ModelMessageItem

FunctionCallItem  → UIBridge → tool_call { id, status: "running" }
FunctionCallOutput → UIBridge → tool_call { id, status: "done" }

webview suggest_files → ext prefix-glob (cap 20) → file_suggestions
webview get_selection → ext getContext → selection
```

Granice: heuristika i SSE u `agent-core`; `postMessage` routing u `extension`; spajanje bubble-ova i composer popup u webview. Nema `import 'vscode'` u `agent-core`.

---

## Protokol (`packages/shared`)

Postojeći tipovi ostaju. Dodaci su opciona polja i dva para za composer (ne pokreću turn).

```ts
{ type: "assistant_delta", text: string }

{ type: "tool_call", name: string, args: unknown, id: string, status: "running" | "done" }

// webview → ext (nije startTurn)
{ type: "suggest_files", query: string }
{ type: "get_selection" }

// ext → webview
{ type: "file_suggestions", query: string, paths: string[] }
{ type: "selection", text: string | null }
```

- `assistant_delta`: webview ako je poslednji `ChatLine` assistant — **append** `text`; inače novi bubble.
- `tool_call`: isti `id` + `done` update-uje postojeći tool red. `args` na `done` se ignorišu. Ako `id` fali (staro), novi red kao danas.
- `user_message`, `cancel`, `apply_diff`, `reject_diff`, `open_diff`, `done`, `error`, `diff_*` — bez izmene semantike.
- `suggest_files` sa praznim `query` (samo `@`): ext **ne** zove `findFiles`; vraća `{ paths: [] }`.

---

## Streaming (agent-core)

`runLocalChatCompletions` šalje `stream: true` i čita SSE telo (`data: {json}`, kraj `data: [DONE]`). Chunkovi se sklapaju u isti oblik kao današnji `ChatCompletionResponse` (content + `tool_calls` + finish_reason).

Klasifikacija, konzervativna, na **akumuliranom** content-u plus bilo kom native `tool_calls` chunku:

- Native `tool_calls` u bilo kom chunku → režim tool; dalje nema narracije.
- Akumulirani content, trim, počinje sa `{` ili izgleda kao tool JSON (`"name"` / `"function"` / `"tool"` kao u postojećem parseru) → režim tool; nema narracije.
- Inače režim prose: svaki **novi** komad content-a ide kao `NARRATION_EVENT`. UIBridge već mapira to na `assistant_delta`.

Na kraju streama: postojeći `deliverCompletion`. Ako je bio režim prose, `deliverModelMessage` i dalje ide (cela poruka u **kontekst**). `deliverCompletion` **ne** emituje `NARRATION_EVENT` za taj isti prose.

Da se bubble ne duplira: `UIBridge.onExternalModelMessage` **više ne šalje** `assistant_delta`. Prikaz prose-a ide samo preko `NARRATION_EVENT`. `eventFromModelText` se uklanja ili ostaje nekorišćen. Testovi UIBridge-a koji očekuju model-text → delta se menjaju.

`AbortSignal` prekida reader. Posle aborta: nema `deliverCompletion` (nema function call-a od pola JSON-a). `onFailed` ostaje postojeća cancel/error putanja.

Delimičan prose već prikazan ostaje na ekranu ako stream padne posle toga.

Ako heuristika bufferuje prose koji počinje sa `{`, korisnik vidi waiting pa ceo tekst odjednom. Prihvatljivo; nema rollback-a.

---

## Tool viz

`UIBridge.onExternalFunctionCall` → `{ type: "tool_call", id: callId, name, args, status: "running" }`.

`UIBridge.onExternalFunctionCallOutput` → `{ type: "tool_call", id: callId, name: "", args: {}, status: "done" }`. `FunctionCallOutputItem` ima samo `callId` + `output`. Webview match-uje po `id` i **ne** menja prikazano ime.

Jedan red po `id`. `propose_edit` i dalje pravi review karticu preko `diff_proposed`; tool red ostaje zasebno, bez dump-a SEARCH/REPLACE.

---

## @-context i selekcija

Composer ostaje jedan textarea. `@` je literal u tekstu.

1. Korisnik kuca `@` + prefiks. Debounce ~150ms. `{ type: "suggest_files", query }` gde je `query` tekst posle `@` do razmaka / kraja.
2. Ext: `vscode.workspace.findFiles` (ili port helper) sa globom `**/*{safe}*` gde je `safe` query bez glob metachar (`*?[]{}`). Cap 20, isti exclude kao `findFiles`. Nije exact-basename locate.
3. `{ type: "file_suggestions", query, paths }` mora da se poklopi sa poslednjim `query` u composeru; stari odgovor se baca.
4. Tab/Enter ubacuje `@` + POSIX workspace-relativan path + razmak. Escape zatvara popup. Prazna lista: „No files“.
5. Send: `user_message.text` je ceo composer string. Ext ne čita navedene fajlove.

**Add selection:** `{ type: "get_selection" }` → `getContext()`. Ako `selection` nije prazan, `{ type: "selection", text }` i webview dopisuje u textarea. Ako nema selekcije: `{ type: "selection", text: null }` i hint u composeru („No selection“), ne `error` bubble.

Komentar (obavezan) pored `suggest_files` u `chatViewProvider.ts`:

```ts
// Deferred: option B — chip + file contents in the user payload (Cursor-style).
// Do not attach file bodies here.
```

---

## Greške

| Situacija | Ponašanje |
|---|---|
| Loš SSE / prazan izbor / HTTP greška | `onFailed` → `{ type: "error" }`. Već prikazan prose ostaje. |
| Cancel usred streama | Reader staje, nema `deliverCompletion`. Busy se gasi kao danas. |
| Heuristika pogrešno bufferuje `{` prose | Čeka kraj, onda jedan bubble. |
| `suggest_files` prazan query | `{ paths: [] }`, bez `findFiles`. |
| `findFiles` baci | `{ paths: [] }`, bez error bubble-a. |
| Nema selekcije | Composer hint, ne chat error. |

---

## Testovi

Bez živog Ollama-a. Fake `fetchImpl` vraća SSE telo.

1. **Assembler:** prose chunkovi → narracije u redosledu; final `deliverModelMessage` jednom, bez druge narracije.
2. **Assembler:** content `{"name":"read_file",...}` ili native `tool_calls` → 0 narracija; na kraju function call kao danas.
3. **Assembler:** abort posle pola JSON-a → 0 function call, 0 model message.
4. **`applyExtMessage`:** dva `assistant_delta` zaredom → jedan assistant red, spojeni tekst.
5. **`applyExtMessage`:** `tool_call` running pa done isti `id` → jedan tool red, status done.
6. **UIBridge:** function call → running; output → done, isti `id`. `onExternalModelMessage` ne emituje `assistant_delta`.
7. **Suggest routing (čista fn):** prazan query → nema fs; neprazan → prefix glob, cap 20, bez `*?[]{}` iz query-ja.

Webview popup (Tab/Enter/Escape) nije obavezan unit test ako nema jsdom harness-a; ponašanje je specifikovano gore i proverava se ručno u EDH.

---

## Redosled implementacije

1. Stream assembler + webview append `assistant_delta`.
2. `tool_call` id/status + UIBridge output hook.
3. `suggest_files` / `get_selection` + composer.

---

## Ručna provera (EDH)

1. „šta radi ovaj repo?“ — tokeni u jednom bubble-u.
2. „pročitaj package.json“ — tool red running → done, bez JSON u chatu.
3. `@package` → predlog, insert, send — agent zove `read_file`, nije dobio body u user poruci.
4. Selektuj kod, Add selection, send.
5. Stop usred streama — busy gasi, nema lažnog tool call-a.
