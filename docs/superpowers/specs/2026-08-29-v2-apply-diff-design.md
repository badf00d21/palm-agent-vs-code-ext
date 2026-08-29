# v2 Apply/diff — design spec

**Datum:** 2026-08-29  
**Status:** odobren  
**Nastavlja:** `docs/superpowers/specs/2026-08-29-v1-mozaik-loop-design.md`  
**Ne pokriva:** create fajl, delete fajl, per-hunk Accept, unified diff, token streaming, cancel, terminal, IPC

---

## Cilj

Korisnik zamoli agenta da izmeni kod. Agent predloži SEARCH/REPLACE preko `propose_edit`. Čovek vidi jednu Cursor-like karticu (collapsible lista fajlova, **Undo All** / **Keep All** / **Review**), pregleda native `vscode.diff` na klik, pa Keep All upiše izmene kroz `WorkspaceEdit` (undo u editoru).

**Gotovo je kad važi sve ovo:**

1. F5 → „preimenuj `getUser` u `fetchUser` u dva postojeća fajla“ → agent zove `propose_edit` → kartica sa oba path-a → Review otvara diff → Keep All → disk promenjen, Ctrl+Z vraća.
2. SEARCH koji ne postoji → tool greška agentu, kartica se ne menja.
3. `packages/agent-core` i dalje nema `import 'vscode'`.
4. Unit testovi iz odeljka Testovi prolaze bez Ollama-a i bez VS Code UI-ja.

---

## Zaključane odluke

- Pristup **A:** matcher (SEARCH/REPLACE) živi u `agent-core`. Pending review i VS Code API žive u `extension` iza `ReviewHost`.
- `propose_edit` **ne čeka** Keep/Undo. Tool odmah vrati tekst. Turn sme da se završi dok kartica stoji.
- Jedan pending review po session-u. Novi uspešan `propose_edit` se **ulije**: novi path se doda na kraj liste; isti path zameni proposed tekst, redosled ostaje.
- Kartica: jedna, collapse lista, akcije **Undo All** / **Keep All** / **Review**. Isti `id` se update-uje — nema nove kartice po svakom tool pozivu.
- Review i klik na path otvaraju `vscode.diff`. Ništa se ne otvara samo.
- Samo postojeći fajlovi. Create i delete su sledeći korak posle v2, ne deo ovog milestone-a.
- Apply je **all-or-nothing** na ceo review. Stale disk (bilo koji fajl ≠ snapshot) → nijedan fajl se ne piše, pending ostaje, `error` u chatu.
- `WorkspacePort` ostaje read-only. Agent ne piše na disk.
- Edit format je SEARCH/REPLACE, ne unified diff i ne ceo fajl-rewrite kao primarni format.
- Protokol: Keep All = `apply_diff`, Undo All = `reject_diff`. Review/klik = `open_diff`.

---

## Van opsega

Create fajl, delete fajl, per-hunk Accept, auto-otvaranje diff taba, više paralelnih review-ova, git checkpoints, MCP, streaming, `cancel`, pisanje van `WorkspaceEdit`.

---

## Arhitektura

```
propose_edit (agent-core)
  → port.readFile(path)
  → applySearchReplace(original, blocks)   // čist string
  → reviewHost.merge([{ path, original, proposed }])
       → pending (jedan)
       → sink({ type: "diff_proposed", id, files })
open_diff  → vscode.diff(diskUri, proposedUri)
apply_diff → ako svi disk == original → WorkspaceEdit(ceo fajl = proposed) → diff_settled kept
reject_diff → obriši pending → diff_settled undone
```

| Paket | Sme | Ne sme |
|---|---|---|
| `agent-core` | matcher, `propose_edit`, `ReviewHost` tip | `import 'vscode'`, `WorkspaceEdit`, virtual doc |
| `extension` | pending store, preview, Apply/Reject, `vscode.diff` | SEARCH/REPLACE algoritam |
| `shared` | poruke navedene dole | runtime |

UIBridge i dalje emituje `tool_call` za `propose_edit` kao za ostale tool-ove. Kartica dolazi od `diff_proposed`, ne od `tool_call`.

---

## ReviewHost i session

`createAgentSession` dobija `ReviewHost` pored porta.

```ts
interface ProposedFile {
  path: string;      // workspace-relative, POSIX
  original: string;  // sadržaj u trenutku match-a
  proposed: string;  // posle svih blokova za taj path
}

interface ReviewHost {
  merge(files: ProposedFile[]): { id: string; paths: string[] };
}
```

`merge`:

- Ako pending nema: novi `id` (npr. `rev_` + kratak random), pending = ovi fajlovi tim redom.
- Ako pending ima: isti `id`; za svaki ulaz, zameni fajl sa istim `path` ili append.
- Uvek emituje `{ type: "diff_proposed", id, files: [{ path }] }` sa **celom** trenutnom listom.
- Vraća `{ id, paths }` (paths = trenutna lista).

Apply, Undo i preview **nisu** na `ReviewHost`. To radi extension na webview poruke, nad istim pending store-om koji `merge` mutira.

Extension konstruiše store + host u `activate` / session host i predaje ga session-u.

---

## Tool `propose_edit`

```ts
{
  name: "propose_edit",
  files: Array<{ path: string; search: string; replace: string }>
}
```

`files` je required, min 1. Ista `path` sme više puta: blokovi se primene **redom** na isti tekst (prvi `readFile`, zatim svaki blok na rezultat).

**Redosled u jednom invoke:**

1. Grupiši blokove po `path`, zadrži redosled prve pojave path-a, unutar path-a redosled blokova.
2. Za svaki path: `readFile`. Nedostatak fajla ili path escape → **ceo invoke fail**, `merge` se ne zove.
3. Za svaki blok: `applySearchReplace`. Miss ili ambiguous → **ceo invoke fail**, `merge` se ne zove.
4. `reviewHost.merge` sa svim uspešnim `{ path, original, proposed }`.
5. Tool result (string): `Proposed review <id>: path1, path2, …`

Prazan `path`, prazan `search` → fail tog invoke-a. `replace` sme biti prazan (brisanje matching span-a unutar fajla — to nije delete fajla).

---

## Matcher (`applySearchReplace`)

Ulaz: `content: string`, `search: string`, `replace: string`.  
Izlaz: novi tekst, ili greška `Search not found in <path>` / `Search matches more than once in <path>`.

Pre match-a: normalizuj samo za poređenje sa `\r\n` → `\n`. Zamena se radi na originalnom `content` (zadrži originalne line endinge u nepromenjenom delu).

**1. Exact.** Broj nepreklapajućih pojava `search` kao substring u `content`.

- 1 → zameni tu pojavu sa `replace`.
- \>1 → ambiguous.
- 0 → korak 2.

**2. Whitespace-insensitive.** Radi se samo ako exact nije našao nijednu pojavu.

- Normalizuj line endinge za split: `\r\n` → `\n`. `contentLines = content.split("\n")`. `searchLines = search.split("\n")`; ako je poslednja `search` linija `""`, odbaci je (LLM trailing newline).
- `countWindows(norm)`: broj indeksa `i` gde `contentLines.slice(i, i + searchLines.length)` ima istu dužinu i `norm(contentLine) === norm(searchLine)` za svaku liniju.
- Ako `countWindows(trimEnd) === 1` → koristi taj `i`.
- Inače ako `countWindows(trimEnd) === 0` i `countWindows(trim) === 1` → koristi taj `i`.
- Inače ako bilo koji brojač `> 1` → ambiguous.
- Inače → not found.
- Zamena: `contentLines.slice(0, i).concat(replace.split("\n")).concat(contentLines.slice(i + searchLines.length)).join(originalSep)` gde je `originalSep` `\r\n` ako `content` sadrži `\r\n`, inače `\n`. `replace` se ne trimuje.

Nema fuzzy token match, nema Levenshtein.

---

## Pending store (extension)

```ts
interface PendingReview {
  id: string;
  files: Array<{ path: string; original: string; proposed: string }>;
}
```

Jedan `PendingReview | undefined` po session-u.

**Keep All (`apply_diff`):**

- `id` ≠ pending.id ili nema pending → `{ type: "error", message: "No pending review" }`.
- Za svaki fajl: `readFile` sada. Ako bilo koji ≠ `original` → `{ type: "error", message: "File changed since proposal: <path>" }` (prvi stale path), ništa ne piši.
- Inače: jedan `WorkspaceEdit` — za svaki path `replace` celog dokumenta sa `proposed` (otvori TextDocument ako treba, range 0–kraj). `workspace.applyEdit`. Uspeh → obriši pending, `{ type: "diff_settled", id, status: "kept" }`. Fail applyEdit → `error` sa kratkom porukom, pending ostaje.

**Undo All (`reject_diff`):**

- Pogrešan / nestali id → `No pending review`.
- Inače obriši pending, `{ type: "diff_settled", id, status: "undone" }`. Disk nedirnut.

**Preview (`open_diff`):**

- `{ type: "open_diff", id: string, path?: string }`
- Bez `path` → prvi fajl u pending listi (Review dugme).
- Sa `path` → taj fajl ako je u pending.
- Nepostojeći id/path → `error` `No pending review` / `File is not in the review`.
- `vscode.commands.executeCommand("vscode.diff", diskUri, proposedUri, "<path> (proposed)")`.
- `proposedUri` je virtualni dokument (`TextDocumentContentProvider`, scheme `palm-agent`). Sadržaj = `proposed` za taj path. Provider čita iz pending store-a.

Keep/Undo/Review su dozvoljeni i dok je `session.busy === true`.

---

## Protokol (`packages/shared`)

`DiffFile` postaje samo path (search/replace više ne idu preko žice):

```ts
interface DiffFile {
  path: string;
}

type WebviewToExt =
  | { type: "user_message"; text: string }
  | { type: "apply_diff"; id: string }
  | { type: "reject_diff"; id: string }
  | { type: "open_diff"; id: string; path?: string }
  | { type: "cancel" };

type ExtToWebview =
  | { type: "assistant_delta"; text: string }
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "diff_proposed"; id: string; files: DiffFile[] }
  | { type: "diff_settled"; id: string; status: "kept" | "undone" }
  | { type: "done" }
  | { type: "error"; message: string };
```

`cancel` i dalje ignorisan (v3).

---

## Webview

`ChatLine` postaje unija postojećeg `{ role, text }` i review linije (nije assistant bubble):

```ts
interface ReviewLine {
  role: "review";
  id: string;
  files: string[];
  status: "pending" | "kept" | "undone";
}
```

- `diff_proposed`: ako već postoji linija sa tim `id`, zameni `files` i ostavi `pending`. Inače append novu liniju.
- Kartica: header (npr. `N files`), collapse/expand lista path-ova, dok je `pending`: **Undo All**, **Keep All**, **Review**.
- Review → `open_diff` bez path.
- Klik na path → `open_diff` sa path.
- Keep All → `apply_diff`. Undo All → `reject_diff`.
- `diff_settled`: nađi `id`, set `status`, sakrij akcije. Lista ostaje (istorija).
- Posle `kept` / `undone`, klik na path ne šalje `open_diff` (pending je prazan).

`tool_call` za `propose_edit` ostaje sivi red iznad/između, kao ostali tool-ovi.

---

## Sistemski prompt

Zameni v1 rečenicu „You cannot write files…“ sa:

You can propose edits with the propose_edit tool (SEARCH/REPLACE on existing files only). Never write to disk yourself and never print a tool call as JSON. The human reviews a file list and chooses Keep All or Undo All. If search fails, retry with a more exact snippet from read_file. This repo is TypeScript; prefer *.ts / *.tsx when searching.

Ostali v1 tool-ovi ostaju. `propose_edit` se dodaje u `createWorkspaceTools`.

---

## Greške

| Uzrok | Gde | Poruka |
|---|---|---|
| prazan `files` / prazan path / prazan search | tool result | `Error: propose_edit requires path and search` |
| fajl ne postoji / outside workspace | tool result | postojeća `readFile` greška / `Path is outside the workspace` |
| SEARCH miss | tool result | `Error: Search not found in <path>` |
| SEARCH ambiguous | tool result | `Error: Search matches more than once in <path>` |
| pogrešan id / nema pending | chat `error` | `No pending review` |
| path nije u review | chat `error` | `File is not in the review` |
| disk ≠ snapshot | chat `error` | `File changed since proposal: <path>` |
| `applyEdit` fail | chat `error` | poruka iz VS Code, max 400 karaktera |

Ne logovati sadržaj fajlova.

---

## Predloženi fajlovi

**agent-core**

- `src/search-replace.ts` — `applySearchReplace`
- `src/review.ts` — `ReviewHost`, `ProposedFile`
- `src/tools.ts` — `propose_edit` + novi prompt
- `src/session.ts` — prima `ReviewHost`

**extension**

- `src/reviewStore.ts` — pending, `merge`, apply, reject, provider sadržaja
- `src/sessionHost.ts` — veže store kao `ReviewHost`
- `src/chatViewProvider.ts` — `apply_diff` / `reject_diff` / `open_diff`
- `src/webview/App.tsx` + `chatMessages.ts` — review kartica
- `src/extension.ts` — registruje `TextDocumentContentProvider`

**shared**

- `src/index.ts` — tipovi iz odeljka Protokol

---

## Testovi

Bez mreže, bez Ollama-a. Matcher i merge bez `vscode`.

1. Exact jedan match → proposed tačan.
2. Exact nula, `trimEnd` jedan prozor → match.
3. Exact nula, samo `trim` jedan prozor → match.
4. Dva exact → greška ambiguous, content nedirnut.
5. Nula posle oba prolaza → not found.
6. Dva bloka na isti path redom → oba primenjena.
7. `merge` prazan store → novi id, jedan path.
8. `merge` isti path → lista dužine 1, proposed novi.
9. `merge` novi path → lista dužine 2, redosled star→nov.
10. Webview: `diff_proposed` → review linija; drugi `diff_proposed` isti id → ista linija, nova lista.
11. Webview: `diff_settled` `kept` → status kept, bez akcija.
12. Stale apply (unit nad store logikom sa fake `readFile`/`applyEdit`): nijedan write, pending ostaje.

Ručni check: F5, rename u 2 fajla, kartica, Review, Keep All, Ctrl+Z.

---

## Zavisnosti

Nema novih paketa. Virtualni preview je VS Code `TextDocumentContentProvider` + `vscode.diff`.
