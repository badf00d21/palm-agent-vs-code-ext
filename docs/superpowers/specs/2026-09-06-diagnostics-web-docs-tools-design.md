# diagnostics + web_fetch/docs_search tool-ovi — design spec

**Datum:** 2026-09-06
**Status:** implementirano
**Nastavlja:** `docs/superpowers/specs/2026-09-01-opencode-harvest-design.md` (Prioritet 6: `diagnostics / typecheck`, `webfetch`; Ne portovati: LSP, websearch)
**Ne pokriva:** permission gate (`ask`/`allow`/`deny`) oko ovih alata; `websearch` (Exa/Parallel); LSP navigacija (`references`/`hover`/`outline` — već postoje, nepromenjeni)

---

## Cilj

Zatvoriti dve konkretne rupe iz opencode istraživanja bez uvođenja LSP sloja ili plaćenog search providera, i ukloniti guard koji je štitio od routing problema koje ovaj kod nikad nije imao.

**Gotovo je kad važi sve ovo:**

1. `diagnostics` tool čita greške/upozorenja iz `WorkspacePort` i vraća `path:line: message` redove, capovane na 40, sa porukom koja razlikuje "čisto" od "niko nije proverio".
2. `web_fetch` i `docs_search` postoje kao native tool-ovi u `createWebTools`, registrovani u `createWorkspaceTools`, oba capovana na ~3000 karaktera i uvijena u untrusted fence sa defused markerima.
3. `docs_search` radi Context7 resolve+fetch u **jednom** tool pozivu, bez API ključa.
4. `isForbiddenModelName` i njena grana u `session-guards.ts` su uklonjeni; nema preostalih referenci u `packages/`.
5. Testovi u `diagnostics.test.ts` i `web.test.ts` prolaze, uključujući test koji specifično proverava defuse marker ponašanje.

---

## Zaključane odluke

| Tema | Izbor | Zašto |
|---|---|---|
| Format diagnostics reda | `path:line: severity: [source] message (code)` | poklapa `ROW_RE` u `tool-locations.ts` → klikabilno u UI-ju besplatno |
| Prazan rezultat diagnostics-a | posebna poruka, ne `"No matches"` | prazno je ambiguous (čisto vs. niko nije proverio); model ne sme da pročita ćutanje kao "proverio sam" |
| `diagnostics` staleness | dokumentovano u tool description-u, ne rešeno kodom | `write`/`edit` ne diraju disk dok čovek ne pritisne Keep All — diagnostics vidi samo pre-edit stanje |
| Cap za web sadržaj | ~3000 karaktera (`WEB_CONTENT_LIMIT`), oštrije od `READ_LIMIT` (24 000) | `compact.ts` samo štopuje ili baca ceo tool output, nikad delimično seče — trunk mora biti po-tool, ne posle-fakta |
| Prompt injection u web sadržaju | `wrapUntrusted` fence + `defuseMarkers` | dovučeni sadržaj je podatak, ne instrukcija; stranica koja sadrži sam marker ne sme da prevremeno zatvori fence |
| Context7 auth | bez API ključa | verifikovano živim HTTP pozivima da `/api/v2/libs/search` i `/api/v2/context` rade anonimno; ključ samo diže rate limit |
| `docs_search` shape | jedan tool poziv, ne dva (resolve pa fetch) | slab lokalni model pouzdano ne uspeva da ulanči dva zavisna tool poziva |
| `websearch` | **nije napravljen** | traži plaćeni provider ključ (Exa/Parallel), SERP je manje token-gust od kurirane dokumentacije — loš trade na 16k prozoru; vidi Van opsega |
| HTML parsing | ručno pisan `htmlToText`, bez nove npm zavisnosti | `agent-core` je na putu ka izdvajanju u zaseban proces za v5; svaka nova zavisnost je cena koju treba platiti dvaput |
| `isForbiddenModelName` | uklonjen | Mozaik routing po imenu modela se ne koristi — `runLocalChatCompletions` gađa `${OPENAI_BASE_URL}/chat/completions` direktno, pa ime modela ide na endpoint kakvo jeste; guard je blokirao legitimna imena bez razloga |

---

## Arhitektura

| Deo | Gde |
|---|---|
| `diagnostics` tool logika, formatiranje, poruke | `packages/agent-core/src/tools/diagnostics.ts` |
| `Diagnostic` / `DiagnosticSeverity` tipovi, `diagnostics(path?)` na portu | `packages/agent-core/src/workspace/port.ts` |
| VS Code implementacija (`vscode.languages.getDiagnostics`) | `packages/extension/src/workspacePort.ts` |
| Post-apply problem report za UI (raniji, nepromenjeni potrošač istog API-ja) | `packages/extension/src/problems.ts` |
| `web_fetch` / `docs_search` logika, `createWebTools` | `packages/agent-core/src/tools/web.ts` |
| Registracija sva tri tool-a u model-vidljivu listu | `packages/agent-core/src/tools/tools.ts` (`createWorkspaceTools`) |
| Clickable redovi u UI-ju iz `path:line:` shape-a | `packages/agent-core/src/participants/tool-locations.ts` (`ROW_RE`) |
| Kontekst budžet koji diktira per-tool cap | `packages/agent-core/src/context/compact.ts` |
| Uklonjen guard | `packages/agent-core/src/session/session-guards.ts` (branch obrisan), poziv iz `model/config.ts` |
| Zapisan razlog uklanjanja | `AGENTS.md` odluka #6, `docs/mozaik-divergences.md` (sekcija 1) |

---

## Ponašanje

### `diagnostics`

- Argumenti: opcioni `path` (workspace-relative ili unique filename, resolvovan preko `locateWorkspaceFile`) i opcioni `severity: "error"` da suzi na samo greške; bez `severity` vraća greške i upozorenja zajedno.
- Port poziv: `port.diagnostics(target)`. VS Code implementacija u `workspacePort.ts` čita `vscode.languages.getDiagnostics(uri)` (scoped) ili `vscode.languages.getDiagnostics()` (ceo workspace), filtrira `severityOf` na samo `Error`/`Warning` (Hint/Information su editor chrome i nikad ne stižu do modela) — isti filter koji `problems.ts` već koristi za post-apply UI report, samo duplirana funkcija, ne deljena.
- `formatDiagnostics` je čista funkcija (testabilna bez porta): svaki red je `${path}:${line}: ${severity}: [${source}] ${message} (${code})`, whitespace kolabsovan, poruka sečena na `MESSAGE_LIMIT = 200` karaktera. Ceo rezultat capovan na `DIAGNOSTICS_LIMIT = 40` redova, sa `[N more]` na kraju ako ima viška.
- Prazan rezultat → `noDiagnosticsMessage(target)`: "No errors or warnings reported {for X | in the workspace}. This may mean the code is clean, or that no language server has checked it yet... Do not treat this as confirmation the code is correct; read the file if the change is significant." Ovo je namerno **drugačija** poruka od `NO_LANGUAGE_SUPPORT` u `tools.ts` ("No answer from language support for this file...") — `NO_LANGUAGE_SUPPORT` pokriva `references`/`hover`, gde prazno znači "provajder nije odgovorio uopšte" (kategorički fail). Kod `diagnostics` prazno je **legitiman mogući odgovor** (provajder je odgovorio, i rekao "nula problema") pomešan sa istim "provajder nikad nije ni pogledao" slučajem — pa poruka mora da ostavi oba čitanja otvorena umesto da tvrdi da provajder ćuti.
- Tool description eksplicitno kaže: "It reports the code as it stands on disk, so it will not show the effect of an edit you just proposed — the human has not applied it yet." Razlog: `write`/`edit` idu kroz `reviewHost.merge` → review karticu → Keep All, i ne diraju disk dok čovek ne potvrdi, pa `diagnostics` pozvan odmah posle `edit`-a i dalje vidi pre-edit stanje.

### `web_fetch`

- Prihvata samo `http:`/`https:` (`isFetchableUrl`); sve ostalo (`file:`, `data:`) vraća `Error:` bez mrežnog poziva.
- `fetchWithTimeout` koristi `AbortController` sa `REQUEST_TIMEOUT_MS = 15_000`; caller-ov abort signal (prekinut turn) se prosleđuje istom kontroleru. 15s je bitno kraće od `IDLE_TIMEOUT_MS` (120s u `session/session.ts`) da zaglavljen fetch ne pojede ceo turn.
- HTML (po `content-type` ili sniffu `<html`) prolazi kroz `htmlToText`: skida `script`/`style`/`noscript`/`template`/`svg` i komentare pre stripovanja tagova, pretvara block-elemente u nove redove, `<li>` u `- `, unescape-uje šaku entiteta, kolabsuje whitespace. Non-HTML sadržaj se samo trimuje.
- Rezultat prolazi kroz `truncate` (cap `WEB_CONTENT_LIMIT = 3_000` karaktera, `[truncated]` marker) pa kroz `wrapUntrusted(url, text)`.

### `docs_search`

- Argumenti: `library` (obavezno), `query` (opciono, fokusira temu).
- Poziva `GET {CONTEXT7_BASE}/libs/search?libraryName=...`, uzima `results[0].id`; ako nema rezultata ili je status 404 → `Error: no documentation library found for "X"`. Zatim `GET {CONTEXT7_BASE}/context?libraryId=...&type=txt[&query=...]`. Oba poziva anonimna, bez API ključa u header-ima ili URL-u.
- Ovo je **namerno kolabsovanje** Context7-ovog dvokoračnog resolve-library-id → get-library-docs toka u jedan tool poziv koji model vidi — jer slab lokalni model pouzdano ne uspeva da ulanči dva zavisna tool poziva (prvi rezultat mora da uđe u argument drugog).
- Rezultat prolazi kroz isti `truncate` + `wrapUntrusted("Context7 docs for {title} ({id})", text)`.

### Prompt injection (zajedničko za oba web tool-a)

- `wrapUntrusted` uvija sadržaj u eksplicitan disclaimer plus `<<<BEGIN UNTRUSTED CONTENT>>>` / `<<<END UNTRUSTED CONTENT>>>` fence.
- `defuseMarkers` pre uvijanja zamenjuje bilo koju pojavu `<<<(BEGIN|END) UNTRUSTED CONTENT>>>` **unutar** dovučenog sadržaja sa neutralisanom varijantom (`<<!$1 UNTRUSTED CONTENT!>>`). Bez ovoga bi stranica koja sadrži tačno taj string mogla da prevremeno zatvori fence i ostatak sebe učita kao "trusted" tekst iza njega — realna rupa nađena tokom review-a, ne hipotetička. `web.test.ts` je specifičan test za ovo ("defuses closing markers inside the page so content cannot escape the fence") koji proverava da posle defuse-a ima tačno jedan `BEGIN` i jedan `END` marker u izlazu, i da se hostilni tekst i dalje nalazi *pre* pravog `END` markera.

### Uklanjanje `isForbiddenModelName`

- Guard je postojao da blokira imena modela tipa `gpt-*`, `o1`–`o9`, `text-*` — u Mozaik-u ta imena bi se rutirala na pogrešan endpoint jer Mozaikov routing bira endpoint po imenu modela.
- Ovaj kod ne koristi taj routing: `runLocalChatCompletions` (u `model/local-inference.ts`) gađa `${OPENAI_BASE_URL}/chat/completions` direktno; ime modela ide u telo zahteva kakvo jeste, endpoint je fiksan konfiguracijom, ne imenom modela.
- Guard je time samo blokirao legitimna imena (npr. neko ko stvarno konfiguriše `gpt-oss` lokalno preko OpenAI-kompatibilnog sloja) bez ijedne stvarne koristi u ovoj arhitekturi.
- Uklonjena grana i import iz `session-guards.ts`; `grep -rn isForbiddenName packages/` (isključujući `dist/`/`node_modules/`) ne vraća ništa.
- Zapisano nezavisno na dva mesta pre ovog spec-a: `AGENTS.md` odluka #6 i `docs/mozaik-divergences.md` sekcija 1 ("Inference — `runLocalChatCompletions` umesto `OpenAIChatCompletions`").

---

## Komponente

### `formatDiagnostics(diagnostics: Diagnostic[], target?: string): string`

Čista funkcija, `packages/agent-core/src/tools/diagnostics.ts`. Prazan niz → `noDiagnosticsMessage(target)`. Inače mapira `formatRow` preko prvih `DIAGNOSTICS_LIMIT` (40) i dodaje `[N more]` ako je ulaz duži.

### `invokeDiagnostics(args: Record<string, unknown>, port: WorkspacePort): Promise<string>`

Resolvuje opcioni `path` preko `locateWorkspaceFile`, poziva `port.diagnostics(target)`, filtrira na `severity === "error"` ako je `args.severity === "error"`, prosleđuje `formatDiagnostics`.

### `WorkspacePort.diagnostics(path?: string): Promise<Diagnostic[]>`

```ts
export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
  path: string;      // workspace-relative POSIX
  line: number;       // 1-based
  severity: DiagnosticSeverity;
  message: string;
  source?: string;    // rust-analyzer, ts, eslint...
  code?: string;
}
```

VS Code implementacija (`packages/extension/src/workspacePort.ts`): `entries = input ? [[uri, vscode.languages.getDiagnostics(uri)]] : vscode.languages.getDiagnostics()`; po diagnostic-u `severityOf` mapira `vscode.DiagnosticSeverity.Error/Warning` na `"error"/"warning"` i `null` za Hint/Information (odbačeno).

### `createWebTools(fetchImpl: WebFetchImpl = fetch): Tool[]`

Factory (ne module-level tool objekti) da testovi mogu da injektuju fake fetch — isti obrazac kao `runLocalChatCompletions` koji uzima `fetchImpl` u `local-inference.ts`. Vraća `[web_fetch, docs_search]`.

```ts
export type WebFetchImpl = (url: string, init?: RequestInit) => Promise<Response>;
```

### Interne funkcije u `web.ts`

- `htmlToText(html: string): string` — regex-bazirano čišćenje, bez parser zavisnosti.
- `wrapUntrusted(source: string, body: string): string` — dodaje disclaimer + fence.
- `defuseMarkers(body: string): string` — neutrališe markere unutar sadržaja pre uvijanja.
- `truncate(text: string): string` — trim + cap na `WEB_CONTENT_LIMIT` sa `[truncated]`.
- `isFetchableUrl(raw: string): boolean` — dozvoljava samo `http:`/`https:`.

### Registracija u `tools.ts`

`createWorkspaceTools` gradi `tools[]` (uključujući novi `diagnostics` unos, sa `path`/`severity` schema poljima) pa dodaje `...createWebTools()` bez argumenata (produkcioni `fetch`). Sva tri tool-a su bez feature flag-a — nema `toolsVisibleToModel` filtera na njih (za razliku od `propose_edit`, koji ostaje skriven kao fallback parser meta).

---

## Testovi

`packages/agent-core/test/tools/diagnostics.test.ts`:

- prazan niz → sadrži "No errors or warnings reported in the workspace" i "Do not treat this as confirmation the code is correct"
- scoped na fajl → sadrži "for src/a.ts"
- jedan diagnostic → tačan `path:line: severity: message` red
- `source`/`code` prisutni → uključeni u red kao `[source] message (code)`
- 45 ulaza → capovano na 40 + `[5 more]`
- tačno 40 ulaza → bez "more]" markera
- `invokeDiagnostics({})` na čistom portu → ambiguous-empty poruka
- default (bez `severity`) vraća greške i upozorenja zajedno
- `severity: "error"` filtrira samo greške
- port sa 50 stavki → `invokeDiagnostics` prijavljuje `[10 more]`
- unique filename resolving → port pozvan sa resolvovanim workspace-relative path-om
- fajl koji ne postoji → `Error:` prefiks

`packages/agent-core/test/tools/web.test.ts`:

- `web_fetch` strip-uje HTML do čitljivog teksta (script/style/liste)
- uvija sadržaj kao untrusted (disclaimer + fence markeri prisutni)
- **defuses closing markers inside the page so content cannot escape the fence** — hostilni ulaz sa oba markera u sadržaju; proverava tačno po jedan marker u izlazu i da hostilni tekst ostaje pre pravog `END` markera
- trunk preko cap-a + `[truncated]` marker, sa proverom tačnog broja karaktera unutar fence-a
- odbija ne-http(s) šeme (`file:`, `data:`) bez mrežnog poziva
- mrežni fail → `Error:` string umesto throw-a
- HTTP error status → `Error: HTTP 404 Not Found`
- timeout (`vi.useFakeTimers`, `advanceTimersByTimeAsync(15_000)`) → `Error: request timed out`
- `docs_search` resolvuje library i vraća docs (proverava oba fetch poziva: `libraryName=react`, pa `libraryId=%2Ffacebook%2Freact&query=useState`)
- library koji se ne nalazi → `Error: no documentation library found`
- trunk docs izlaza preko cap-a

---

## Van opsega

- `websearch` (generic search preko Exa/Parallel) — traži plaćen provider ključ i SERP je manje token-gust od kurirane dokumentacije; loš trade na 16k prozoru. Ostaje predlog u `2026-09-01-opencode-harvest-design.md`, nije napravljen.
- LSP navigacioni tool-ovi (28+ servera) — i dalje eksplicitno neportovano; `diagnostics` koristi ono što editor već računa preko `WorkspacePort`, ne novi LSP klijent.
- Permission gate (`allow`/`ask`/`deny`) oko `diagnostics`/`web_fetch`/`docs_search` — Prioritet 1 iz harvest doc-a, nije deo ovog rada.
- Deljenje `severityOf` implementacije između `workspacePort.ts` i `problems.ts` (trenutno duplirana, ne refaktorisana u zajednički helper).
- Keširanje web/docs rezultata preko poziva — svaki `web_fetch`/`docs_search` je svež HTTP poziv.
