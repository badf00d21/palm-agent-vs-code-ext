# Content SEARCH/REPLACE — design spec

**Datum:** 2026-08-30  
**Status:** odobren (pristup dogovoren u sesiji; implementacija odmah)  
**Nastavlja:** v2 apply/diff, v3 streaming  
**Ne pokriva:** Gemma `call:propose_edit{…}` dijalekat, whole-file write, create/delete, per-hunk Accept, unified diff

---

## Cilj

Slabi lokalni modeli (Gemma 12B) predlažu izmene kao **tekstualne SEARCH/REPLACE blokove u `content`**, ne kao JSON `propose_edit` argumente. Ollama tool-parser više ne vidi 13k escaped koda. Applier, matcher i review kartica ostaju isti.

**Gotovo je kad važi sve ovo:**

1. Ollama `tools` niz **ne sadrži** `propose_edit`. Read-only toolovi ostaju.
2. Assistant `content` sa aider blokovima postaje isti interni `propose_edit` invoke → `diff_proposed` kartica.
3. Fence se **ne** streamuje u Agent bubble od `<<<<<<< SEARCH` nadalje.
4. `read_file` sa `start_line` bez `end_line` vraća najviše **80** linija, ne do EOF.
5. `agent-core` i dalje nema `import 'vscode'`.
6. Testovi ispod prolaze bez živog Ollama-a.

---

## Zaključane odluke

- Jedan edit protokol: aider fence u `content`. Nema dual-path „tool ili fence“ u šemi.
- `propose_edit` **ostaje** Mozaik tool za `invoke` (matcher, merge, review). Nije u `mapTools` / HTTP body.
- Posle streama, kompletan blok → sintetizovan `FunctionCallItem` (`name: "propose_edit"`, `args` = `{"files":[…]}`). Isti retry (`Search not found` + tačno telo).
- Prednost u `deliverCompletion`: native `tool_calls` → JSON tool u content (`parseToolCallsFromContent`) → SEARCH/REPLACE blokovi → prose / empty fail.
- Format (tačno, trim na marker linijama):

```
path/to/file
<<<<<<< SEARCH
old
=======
new
>>>>>>> REPLACE
```

- Path je poslednja ne-prazna linija pre `<<<<<<< SEARCH` koja nije ` ``` ` fence. Dozvoljen prefiks `path:`. Surrounding backticks se skidaju.
- Više blokova = više `files` u jednom `propose_edit`.
- Nepotpun blok (nema `=======` ili `>>>>>>> REPLACE`) se ignoriše. Ako nema nijednog kompletnog, poruka je običan assistant tekst.
- Stream: `streamMode` postaje `"tool"` čim `acc.content` sadrži `<<<<<<< SEARCH`. Raniji prose sme da ostane u bubble-u; path linija sme da procuri. Ne bufferovati unazad.
- `start_line` bez `end_line`: `end = start + 79` (80 linija inclusive), zatim postojeći `READ_LIMIT`.
- Gemma `call:propose_edit` se **ne** parsira. Prompt nalaže fence.
- JSON `propose_edit` u content fence-u i dalje radi preko postojećeg `parseToolCallsFromContent` (prednost 2) — to nije šema ka Ollami.

---

## Van opsega

Gemma native dijalekat, whole-file replace, create/delete, per-hunk, chip + file body, promena review UI-ja, v4 terminal.

---

## Arhitektura

```
Ollama tools = read_file, list_dir, search, get_context
Ollama content  → parseSearchReplaceBlocks
                 → FunctionCallItem propose_edit
                 → EditorAgent.invoke (postojeći)
                 → ReviewHost.merge → diff_proposed
```

`toolsVisibleToModel(tools)` filtrira `propose_edit`. `EditorAgent.run` šalje samo to u `runLocalChatCompletions`.

---

## Prompt

`SYSTEM_PROMPT` više ne nalaže `propose_edit` tool. Nalaže fence, mali hunk (jedna funkcija / ~20–40 linija), `start_line` **i** `end_line` posle search-a, SEARCH iz slice-a ne iz headera.

---

## Testovi (obavezni)

| Ponašanje | Očekivanje |
|---|---|
| Jedan blok sa path iznad | `{ path, search, replace }` |
| `path: foo.ts` i `` `foo.ts` `` | path `foo.ts` |
| Dva bloka | dva file unosa |
| Nedostaje `>>>>>>> REPLACE` | `[]` |
| Native tool_calls + fence u content | native pobeđuje |
| Samo fence u SSE content | `deliverFunctionCall` `propose_edit`, bez `Empty completion` |
| `streamMode` posle `<<<<<<< SEARCH` | `"tool"` |
| `toolsVisibleToModel` | bez `propose_edit` |
| HTTP body.tools iz EditorAgent | bez `propose_edit` ako je u invoke listi |
| `read_file` `{ start_line: 10 }` na 200 linija | `[lines: 10-89 of 200]` |

---

## Rizici

- Sledeći inference korak vidi `tool_calls: propose_edit` u istoriji a tool nije u šemi — prihvatljivo.
- Path linija u bubble-u pre markera — prihvatljivo u v1.
- Model i dalje emituje `call:propose_edit` → Ollama empty — sledeći korak, van ove spec.
