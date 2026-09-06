# opencode harvest — design spec

**Datum:** 2026-09-01
**Status:** predlog — delimično isporučeno, vidi status tabelu ispod
**Nastavlja:** v3 streaming/context UX, hygiene split
**Ne pokriva:** fork opencode-a, zamenu Mozaik runtime-a, multi-provider sloj

---

## Status isporuke (dopunjeno 2026-09-06)

Telo ispod je original od 2026-09-01 i **ne dira se** — to je zapis odluke u
trenutku kad je doneta. Ova tabela kaže šta je od toga stvarno isporučeno.

| Stavka | Status | Gde |
|---|---|---|
| P0 `write` + `edit` ravni argumenti | **isporučeno** | `tools/propose-edit.ts` |
| P1 permission sistem | **nije** | v4, uz terminal tool |
| P1 `doom_loop` detekcija | **isporučeno** | `MAX_IDENTICAL_CALLS` u `participants/editor-agent.ts` |
| P2 compaction | **isporučeno** (naša skala) | `context/compact.ts`, spec `2026-09-01-context-compact-new-chat-design.md` |
| P3 agent definicije (format) | **nije** | — |
| P4 Zod tool schemas | **nije** | šeme su i dalje ručni JSON Schema |
| P5 `AGENTS.md` discovery | **isporučeno** | `context/instructions.ts` |
| P6 `glob` | **isporučeno** | `tools/tools.ts` |
| P6 `question` | **isporučeno** | `tools/question.ts` |
| P6 diagnostics / typecheck | **isporučeno** | `tools/diagnostics.ts`, spec `2026-09-06-diagnostics-web-docs-tools-design.md` |
| P6 `webfetch` | **isporučeno** | `tools/web.ts` |
| P6 `websearch` | **odbijeno, zamenjeno** | umesto SERP-a → `docs_search` (Context7, bez ključa); obrazloženje u `2026-09-06-diagnostics-web-docs-tools-design.md` |
| P6 `apply_patch` | **nije** (i dalje odloženo) | P0 je rešio bol |
| P6 `todowrite` | **preskočeno** | kako je i predloženo — 16k ga ne trpi |

Isporučeno **van** ovog spec-a (nije bilo u harvest listi):

- `delete_file` — `2026-09-06-delete-file-tool-design.md`
- `research` (multi-agent fan-out) — `2026-09-06-research-mode-design.md`; opencode ima
  `task`, ali naša verzija je opravdana kontekst-budžetom, ne brzinom
- flat transcript redesign — `2026-09-06-flat-transcript-redesign-design.md`

---

## Kontekst odluke

Razmatran je fork `anomalyco/opencode` (MIT, TypeScript, 203k★, 15.6k commit-ova,
1.5k otvorenih PR-ova) uz zamenu agent loop-a Mozaik-om. **Odbačeno**, iz dva razloga:

1. **VS Code ekstenzija u `sdks/vscode` je terminal launcher**, ne native UI.
   Otvara TUI u split terminalu (`Ctrl+Esc`), ubacuje `@File#L37-42` reference,
   prosleđuje selekciju. Nema webview chata, nema `vscode.diff` review-a, nema
   Keep All / Undo All. Jedina stvar zbog koje bi se forkovalo — ne postoji.
   To je istovremeno **dokaz da rupa koju popunjavamo postoji**.
2. **Transplantacija kičme = trajna divergencija.** 15.6k commit-ova i 1.5k
   otvorenih PR-ova znači da se upstream pomera brzo. Zamena loop-a ubija merge
   zauvek — čime se gubi jedini razlog za fork.

**Usvojeni pristup:** zadržati `agent-core` i Mozaik bus, portovati pojedinačne
module. MIT dozvoljava kopiranje uz zadržan copyright notice.

---

## Filter za sve odluke ispod

opencode cilja frontier modele sa 200k+ konteksta. Naš target je **gemma4:12b sa
16k**. Njihov `COMPACTION_BUFFER` (~20k tokena) je veći od celog našeg prozora.

Zato je kriterijum: *da li ovo preživi 16k prozor i slab model?*

Empirijski ishod: **config / permission gate / context budžet slojevi se portuju
čisto** (model-nezavisni su). **Prompt-zavisni i kontekst-gladni slojevi ne**
(traže jak model ili pojedu ceo prozor).

Sve stavke ispod su **ispod** agent loop-a ili **pored** njega. Nijedna ne dira
Mozaik kičmu — to je i razlog zašto pristup „port po modulima" radi.

---

## Prioritet 0 — Edit transport: `write` + `edit` kao native tool-ovi

Dodato 2026-09-01 posle povratne informacije da `propose_edit` u praksi nije
zadovoljavajući. Ovo je jedina stavka koja **menja zaključanu odluku** — i to
odluku iz `content-search-replace-design.md`, ne odluku #5 iz `AGENTS.md`.

### Dokaz da je problem transport, a ne format

Sve četiri greške popravljene tokom 2026-09-01 imale su isti oblik: *model nije
uspeo da ispravno ispiše fence u slobodnom tekstu.*

1. Model uopšte ne emituje markere, lepi ```-fence umesto njih
2. Botched marker (`Model.h <<<<<<`) — near miss koji parser ne prepoznaje
3. Suvišan zatvarajući `=======` ostaje kao poslednja linija fajla
4. Gemma imitira `call:propose_edit{…}` kao native dijalekat → Ollama parser puca

Nijedna nije bila „SEARCH/REPLACE je pogrešan koncept". Istovremeno, u istim
logovima **native tool pozivi rade besprekorno** (`read_file`, `list_dir`,
desetine poziva). Fence je slaba karika, ne model.

### Strukturni uzrok

opencode-ov `edit` radi **jednu zamenu u jednom fajlu po pozivu**, i ima odvojen
`write` za cele fajlove.

Naš `propose_edit` prima **niz fajlova, svaki sa search+replace parom**. To
batch-ovanje pravi ogroman ugnežden JSON — tačno ono na čemu je Ollama tool
parser pukao i zbog čega je alat izbačen iz šeme
(`content-search-replace-design.md`, red 12: „Ollama tool-parser više ne vidi 13k
escaped koda").

Zaključak: alat nije bio pogrešan — **oblik argumenata je bio pogrešan.**

### Predlog

Dva nova native tool-a, oba sa **ravnim argumentima**:

| Tool | Argumenti | Namena |
|---|---|---|
| `write` | `{ path, content }` | nov fajl ili pun sadržaj |
| `edit` | `{ path, old_string, new_string }` | jedna literalna zamena |

- **Jedan poziv = jedna promena.** Bez nizova, bez ugnežđivanja.
- Za `write` nema SEARCH-a uopšte → cela krhkost matchovanja nestaje sa create puta.
  To je bio scenario koji je najviše pucao (MVC primer, 4 nova fajla).
- `edit` je isti SEARCH/REPLACE koncept — **odluka #5 iz `AGENTS.md` ostaje na snazi**,
  menja se samo transport (tekst → JSON args).
- Postojeći `applySearchReplace` matcher se koristi nepromenjen (whitespace
  tolerancija, ambiguous/not-found detekcija, `Use this exact text` retry).
- **Fence parsing ostaje kao fallback**, za modele koji ga preferiraju.

### Ugovor koji se NE menja

Oba alata i dalje idu kroz `reviewHost.merge` → `diff_proposed` → review kartica
→ Keep All. **Ne diraju disk.** Propose/review ugovor iz `PRODUCT.md` ostaje
netaknut — menja se samo kako model izražava predlog.

### Rizik i mitigacija

Rizik je onaj isti zbog kog je alat prvobitno sklonjen: veliki escaped string u
JSON args. Mitigacije:

- Ravni argumenti umesto ugnežđenog niza — bitno manje za parser
- Jedna promena po pozivu → manji payload
- Fence fallback ostaje ako native pukne
- Merljivo: promena je na nivou šeme, laka za A/B na istom promptu

---

## Prioritet 1 — Permission sistem (uzeti ceo model)

Direktno rešava v4 (`terminal tool iza approval gate-a`) iz mape milestone-ova.

opencode model, verbatim iz njihove dokumentacije:

- Tri ishoda: `"allow"` | `"ask"` | `"deny"`
- Gate-uje: `read`, `edit`, `bash`, `glob`, `grep`, `task`, `lsp`, `webfetch`,
  `websearch`, `external_directory`, `question`, `skill`, `doom_loop`
- Wildcard pattern matching, **poslednje pravilo koje se poklopi pobeđuje**:

```json
{
  "permission": {
    "bash": { "*": "ask", "git *": "allow", "rm *": "deny" },
    "edit": { "*": "deny", "packages/web/src/content/docs/*.mdx": "allow" }
  }
}
```

- Runtime izbor: `once` | `always` (za trajanje sesije) | `reject`
- Default-i: većina `allow`; `doom_loop` i `external_directory` su `ask`;
  `.env` denied, `.env.example` allowed
- Per-agent override, i u JSON-u i u markdown frontmatter-u

**Zašto se portuje čisto:** čist config + runtime gate. Nula zavisnosti od
sposobnosti modela.

**Tačke integracije kod nas:**

| Šta | Gde |
|---|---|
| Provera pre `tool.invoke` | `EditorAgent.runTool` (`participants/editor-agent.ts`) |
| Ask → webview round-trip | novi tipovi poruka u `packages/shared` |
| UI za odobrenje | `webview/App.tsx`, po uzoru na `ReviewCard` |
| Config čitanje | `palmAgent.*` u `sessionHost.ts` |

**Integracioni rizik (bitno):** `IDLE_TIMEOUT_MS` je 120s u `session/session.ts`.
Ljudsko odobrenje ume da traje duže. Tajmer mora da se **pauzira dok se čeka
odobrenje**, inače turn pukne usred approval dijaloga. Isto važi i za
`turnAbort` — odbijanje ne sme da sruši ceo turn, nego da se vrati modelu kao
tool output (isti put kojim već idu `Error:` poruke).

**`doom_loop` je besplatna pobeda.** U logu od 2026-09-01 model je pozvao
`read_file("controller.c")` **šest puta zaredom** sa `output=0ch`, i potrošio
korake do `MAX_INFERENCE_STEPS`. Detekcija ponovljenog identičnog tool poziva
rešava tačno to.

---

## Prioritet 2 — Compaction (uzeti strukturu, preskalirati brojeve)

Već imamo `src/context/compact.ts`. Vredi uporediti pre nego što se stabilizuje.

opencode strategija:

- Prag: context window − rezervisani output − `COMPACTION_BUFFER` (~20k)
- Štiti skorašnje turn-ove u budžetu **2k–15k tokena**
- **Tool output pruning:** unazad-skenirajući algoritam; seče tek kad ukupan
  tool output pređe **40k** *i* kad se seče bar **20k**
- Summary je assistant poruka sa `summary: true`; media se strip-uje
- Posle kompakcije **replay-uje poslednju user poruku**; kod proaktivne
  kompakcije ubacuje sintetički „Continue if you have next steps"
- Prvo pokušava „Session Memory Compact" (struktuirani podaci umesto LLM poziva)

**Šta se ne portuje:** svi brojevi. 20k buffer > 16k prozor.

**Šta se portuje — i najvažniji nalaz:**

Na 16k prozoru **pruning tool outputa je važniji od sumarizacije**. Jedan
`read_file` na `READ_LIMIT` (24.000 karaktera ≈ 6k tokena) pojede ~40% prozora.
opencode to rešava tek na 40k; kod nas to mora da se dešava agresivno i rano.

Konkretno vredno preuzeti:
- Zaštićeni prozor skorašnjih turn-ova (preskalirati na ~1k–3k)
- Prioritetno sečenje **starih tool outputa**, ne prose (file read-ovi su balast)
- Replay poslednje user poruke posle kompakcije
- Sumarizacija kao *handoff* (cilj / otkrića / urađeno / relevantni fajlovi),
  ne kao apstraktna kompresija

**Nota:** „Session Memory Compact" (izbegavanje LLM poziva) je posebno vredan na
lokalnom modelu, gde je svaki poziv skup. Ne trošiti gemma4 na sumarizaciju ako
se isti podatak može sklopiti struktuirano.

---

## Prioritet 3 — Agent definicije (uzeti format, ne runtime)

Ovo je most ka baro agent modu iz `AGENTS.md` odluke #2.

opencode format: markdown fajl sa frontmatter-om u `.opencode/agents/`
(ili `~/.config/opencode/agents/`), **ime fajla = ime agenta**.

Polja: `description` (obavezno), `mode` (`primary` | `subagent` | `all`),
`model`, `temperature`, `top_p`, `prompt` (`{file:./path}`), `permission`,
`steps` (max iteracija), `color`, `hidden`, `disable`.

Ugrađeni: **build** (pun pristup), **plan** (edit/bash na `"ask"`),
**general** / **explore** (read-only) / **scout** (read-only, eksterni docs).

**Uzeti:** format definicije. Markdown + frontmatter je dobra prenosiva
konvencija, i `plan` vs `build` podela se preslikava na naše postojeće
`toolsVisibleToModel` filtriranje.

**Ne uzeti (za sada):** runtime delegacije. opencode koristi parent/child sesije
sa navigacijom (`session_child_cycle` itd.). **Kod nas svaka agent definicija
prirodno postaje Mozaik participant koji se `join`-uje na bus** — što je čistije
od njihovog modela i poklapa se sa konvencijom iz `AGENTS.md` („svaki novi
participant se dodaje `join`-om i ne dira postojeće"). **Ovde Mozaik zarađuje
svoje mesto.**

**Realnost:** subagent delegacija na 12B lokalnom modelu je preambiciozna.
Format uzeti sada, runtime odložiti do baro faze.

---

## Prioritet 4 — Custom tools API (ergonomija, nizak rizik)

opencode: `.opencode/tools/*.ts`, **ime fajla = ime tool-a**, više export-a daje
`<fajl>_<export>`. Custom tool overrides ugrađeni istog imena.

```typescript
import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Query the project database",
  args: {
    query: tool.schema.string().describe("SQL query to execute"),
  },
  async execute(args) {
    return `Executed query: ${args.query}`
  },
})
```

Args su **Zod** (`tool.schema` je Zod). Context koji tool dobija:
`agent`, `sessionID`, `messageID`, `directory`, `worktree`. Vraća string.

**Uzeti:** oblik. Naše tool definicije u `createWorkspaceTools` su već skoro to,
ali sa ručno pisanim JSON Schema objektima. Zod bi uklonio drift između sheme i
TS tipova — realna ergonomska dobit, mali rizik.

**Nota:** `execute` vraća **string**, kao i kod nas. Naša odluka da zaobiđemo
Mozaik `executeFunctionCall` (jer JSON.stringify-uje output) je time potvrđena
kao ispravna — vidi komentar u `editor-agent.ts`.

---

## Prioritet 5 — AGENTS.md discovery (jeftino, ali pažljivo sa budžetom)

opencode redosled: lokalni `AGENTS.md` (traverzuje naviše), pa `CLAUDE.md`, pa
globalni `~/.config/opencode/AGENTS.md`, pa `~/.claude/CLAUDE.md`. Prvi koji se
poklopi u svakoj kategoriji pobeđuje. Plus:

```json
{ "instructions": ["docs/guidelines.md", "packages/*/AGENTS.md"] }
```

**Uzeti:** discovery + glob. Ironija: **naš repo ima `AGENTS.md` koji naš agent
trenutno ne vidi** — `SYSTEM_PROMPT` je hardkodiran string.

**NE uzeti: remote URL-ove.** opencode dozvoljava fetch instrukcija sa URL-a (5s
timeout). Ubacivanje udaljenog sadržaja pravo u system prompt je prompt-injection
vektor. Samo lokalni fajlovi.

**Budžet upozorenje:** naš `AGENTS.md` je 150+ linija. Ubacivanje celog u 16k
prozor pojede ozbiljan deo. Treba mu limit (npr. prvih N tokena) ili odabir
sekcija — ne slepo konkateniranje.

---

## Prioritet 6 — Tool gap-ovi

Revidirano 2026-09-01 posle povratne informacije: `propose_edit` u praksi nije
zadovoljavajući. Vidi Prioritet 0 iznad za `write` / `edit`.

| Tool | Odluka | Razlog |
|---|---|---|
| `write` | **uzeti** | vidi Prioritet 0 — ravni argumenti, rešava create put |
| `edit` (jedna zamena) | **uzeti** | vidi Prioritet 0 — isti koncept, pouzdan transport |
| `glob` | **uzeti** | `port.findFiles` postoji, ali model nema glob tool |
| diagnostics / typecheck | **uzeti** | jeftina zamena za LSP |
| `question` | **uzeti** | deli suspend/resume kolo sa permission „ask" |
| `webfetch` | **uzeti, uz limit** | vidi ograničenja ispod |
| `websearch` | **uzeti, uz izbor providera** | traži Exa/Parallel ključ; odstupa od local-first |
| `apply_patch` | odloženo | treći format za isti posao; tek ako `write`+`edit` ne reše |
| `todowrite` | preskočiti | troši kontekst; 16k ga ne trpi |

### `question`

Isto suspend/resume kolo kao permission `"ask"`: tool poziv čeka webview
round-trip. Ako se Prioritet 1 uradi prvi, ovo je mali dodatak — ista pauza
`IDLE_TIMEOUT_MS` tajmera, isti put nazad kroz tool output.

Poklapa se sa human-in-the-loop tezom iz `PRODUCT.md`.

### `webfetch` / `websearch` — dva ograničenja

**Bezbednost.** Dovučeni sadržaj je **podatak, ne instrukcija**. Mora ući u
kontekst jasno označen kao nepouzdan. Agent koji predlaže izmene koda je meta:
injektovan sadržaj može da pokuša da usmeri predlog. Isto rezonovanje kao odbijanje
remote URL-ova u Prioritetu 5 — s tim što je ovde feature legitiman, pa se rešava
označavanjem, ne zabranom.

**Kontekst budžet.** Na 16k prozoru jedna web stranica pojede sesiju. Potreban
limit znatno oštriji od `READ_LIMIT` (24k karaktera) — reda **2–4k karaktera**,
uz `[truncated]` marker po uzoru na postojeći `read_file`.

**Provider.** `websearch` traži Exa ili Parallel (API ključ, trošak). Odstupanje
od local-first postavke; svesna odluka, ne previd. Ključ ide u VS Code
SecretStorage, ne u config.

Oba idu iza permission gate-a iz Prioriteta 1 — opencode ih tretira isto.

---

## Ne portovati (eksplicitno)

- **Multi-provider sloj** (75+ providera preko AI SDK). Ollama-first je
  zaključana odluka #6. Ogromna složenost, nula dobiti.
- **Variants sistem** (`reasoningEffort`, `thinking.budgetTokens`). Podešavanje
  frontier reasoning-a; gemma4 nema šta s tim.
- **LSP** (28+ servera). Skupo, memorijski i latencijski. **Njihova sopstvena
  dokumentacija preporučuje alternativu:** dokumentovati lint/typecheck komande
  u instrukcijama pa da ih agent pokreće direktno. To je ~5% posla za većinu
  vrednosti — i uklapa se u permission gate iz Prioriteta 1.
- **TUI / terminal-first slojevi**, session sharing, Slack, enterprise, desktop.
- **Parent/child session navigacija.** Mozaik bus je zamenjuje.
- **Remote instrukcije preko URL-a** (`instructions` sa mrežnim putanjama).
  Injection vektor. `webfetch` pokriva legitimnu potrebu — uz označavanje
  sadržaja kao nepouzdanog i iza permission gate-a.

---

## Potvrde postojećih odluka

Istraživanje je potvrdilo tri naše zaključane odluke:

1. **Edit format.** opencode `edit` tool koristi *„exact string replacements"* —
   ne unified diff, ne whole-file. Ista mehanika kao naši SEARCH/REPLACE blokovi.
   Odluka #5 potvrđena nezavisno.
2. **Tool output kao string.** Njihov `execute` vraća string; naš bypass Mozaik
   runner-a koji JSON.stringify-uje je bio ispravan potez.
3. **Native diff review je prazna niša.** Projekat sa 203k zvezdica ima samo
   terminal wrapper za VS Code. `PRODUCT.md` pozicioniranje stoji.

---

## Predloženi redosled

0. **`write` + `edit` kao native tool-ovi** — najveća trenutna bol; menja
   transport, ne format. Fence ostaje kao fallback, pa je povratak jeftin.
1. **Permissions + `doom_loop`** — otključava v4, i odmah gasi read-file petlju
   viđenu u logu 2026-09-01.
2. **`question`** — jeftin odmah posle permission ask-flow-a (deli isto kolo).
3. **Compaction poređenje** — dok je `compact.ts` još svež; naglasak na
   agresivnom pruningu tool outputa, ne na sumarizaciji.
4. **AGENTS.md discovery** — jeftino, uz budžet limit.
5. **Zod tool schemas + `glob`** — ergonomija.
6. **`webfetch` / `websearch`** — iza permission gate-a, uz oštar truncate.
7. **Agent definicije (format)** — priprema za baro fazu.

`apply_patch` namerno nije u listi: razmotriti tek ako korak 0 ne reši bol.

---

## Rizici

- Approval flow ↔ `IDLE_TIMEOUT_MS` interakcija (vidi Prioritet 1). Najverovatniji
  izvor bug-ova u v4. Isto važi za `question`.
- **`write` / `edit` u šemi vraćaju rizik zbog kog je `propose_edit` sklonjen**
  (veliki escaped string u JSON args). Ravni argumenti i jedna promena po pozivu
  su mitigacija, ne garancija — meriti pre nego što se fence fallback ukloni.
- `webfetch` unosi nepouzdan sadržaj u kontekst agenta koji predlaže izmene koda.
  Označavanje kao podatak je obavezno, ne opciono.
- Injektovanje `AGENTS.md` u 16k prozor bez limita može da izgladni pravi rad.
- Zod dodaje dependency u `agent-core`; proveriti da ne povlači ništa što bi
  smetalo v5 ekstrakciji u zaseban proces.
- Portovan kod mora da zadrži MIT copyright notice.
