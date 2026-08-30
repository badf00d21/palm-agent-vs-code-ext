# Create file + mkdir — design spec

**Datum:** 2026-08-30  
**Status:** odobren  
**Nastavlja:** `docs/superpowers/specs/2026-08-30-content-search-replace-design.md`  
**Ne pokriva:** brisanje fajla ili direktorijuma, overwrite, whole-file replace postojećeg, Gemma `call:` dijalekat

---

## Cilj

Agent može da **predloži** novi fajl i prazan direktorijum istim SEARCH/REPLACE fence-om. Čovek i dalje vidi karticu i Keep All / Undo All. Disk se ne dira pre Keep All.

**Gotovo je kad važi sve ovo:**

1. F5 → „napravi `src/foo/bar.ts` sa …“ → fence sa praznim SEARCH → kartica sa path-om (oznaka new) → Review otvara `vscode.diff` prazno vs predlog → Keep All upisuje fajl (i roditelje).
2. F5 → „napravi prazan `src/components/`“ → fence `src/components/` + prazan SEARCH + prazan REPLACE → kartica, Review **ne** otvara diff → Keep All pravi prazan dir.
3. Prazan SEARCH na **postojeći** fajl → tool error `already exists`, nema overwrite, nema kartice za taj path.
4. Postojeći edit (ne-prazan SEARCH) ne regrese.
5. `agent-core` i dalje nema `import 'vscode'`.
6. Testovi ispod prolaze bez živog Ollama-a i bez VS Code UI-ja (apply se stubuje).

---

## Zaključane odluke

- Isti content protokol kao edit. Nema `create_file` / `mkdir` u Ollama `tools` nizu.
- Prazan SEARCH + ne-prazan REPLACE + path **bez** trailing `/` = **create file**.
- Prazan SEARCH + prazan REPLACE + path **sa** trailing `/` = **mkdir**.
- Prazan SEARCH + prazan REPLACE **bez** `/` = create **praznog** fajla (validno).
- Roditeljski folderi uz create file idu kroz `WorkspaceEdit.createFile` (VS Code pravi intermediate dirs). Eksplicitni mkdir je samo za prazan dir bez fajla.
- Ako target već postoji: `Error: … already exists`. Nikad tihi overwrite.
- Trailing `/` + bilo kakav REPLACE body: `Error: mkdir cannot have file content`.
- `ProposedFile` dobija `kind: "edit" | "create" | "mkdir"`. Edit ostaje `kind: "edit"` uz ne-prazan SEARCH.
- Undo All **samo** odbacuje pending review (ništa na disku). Posle Keep All nema auto-delete. Ctrl+Z važi za create file (WorkspaceEdit); mkdir posle Keep nema editor undo.
- Review za create: postojeći `vscode.diff` (leva strana prazna / nepostojeći fajl, desna predlog). Review za mkdir: dugme ne zove `open_diff`.
- Kartica: path; create ima oznaku `new`. mkdir path se prikazuje sa `/`.
- Jedan pending review i dalje merge-uje path-ove. Isti path: novi predlog zamenjuje stari.

---

## Van opsega

Brisanje fajla/dir-a, rmdir, overwrite, per-hunk, create van workspace-a, `.gitkeep` kao mkdir trik, novi Ollama toolovi.

---

## Wire

Create:

```
src/foo/bar.ts
<<<<<<< SEARCH
=======
export const bar = 1;
>>>>>>> REPLACE
```

Mkdir:

```
src/components/
<<<<<<< SEARCH
=======
>>>>>>> REPLACE
```

Parser (`parseSearchReplaceBlocks`) ostaje isti. Klasifikacija je posle parse-a:

| SEARCH | REPLACE | path ends with `/` | kind |
|---|---|---|---|
| ne-prazan | bilo šta | ne | `edit` (postojeći) |
| prazan | bilo šta | ne | `create` |
| prazan | prazan | da | `mkdir` |
| prazan | ne-prazan | da | error |
| ne-prazan | bilo šta | da | error (`path is a directory`) |

Path za mkdir se normalizuje sa trailing `/` u `ProposedFile.path` (POSIX). `locate` za create/mkdir **ne** sme da zahteva da fajl postoji.

---

## Apply / stale

**Create:** pre Keep, putanja ne postoji (ni kao fajl ni kao dir). Keep: `WorkspaceEdit.createFile` + insert `proposed`. Stale ako se pojavi na disku pre Keep.

**Mkdir:** pre Keep, putanja ne postoji. Keep: `vscode.workspace.fs.createDirectory` (rekurzivno). Stale ako postoji.

**Edit:** nepromenjeno (`original` mora da se poklapa sa diskom / čistim editorom).

`applyFiles` u extension host-u grana po `kind`. `WorkspacePort` i dalje nema write — write ostaje samo u ext apply, kao danas.

---

## Prompt

`SYSTEM_PROMPT` dobija dva reda: novi fajl = prazan SEARCH + sadržaj; novi prazan dir = path sa `/` i oba prazna. Ne zovi tool. Ne briši.

---

## Testovi (obavezni)

| Ponašanje | Očekivanje |
|---|---|
| Prazan SEARCH, body, `a.ts` | `kind: "create"`, `original: ""` |
| Prazan SEARCH, prazan REPLACE, `dir/` | `kind: "mkdir"` |
| Prazan SEARCH, body, `dir/` | `Error: mkdir cannot have file content` |
| Prazan SEARCH, postojeći `a.ts` | `Error: … already exists` |
| Mkdir, `dir/` već postoji | `Error: … already exists` |
| Ne-prazan SEARCH | i dalje `kind: "edit"` |
| Review store apply create | `applyFiles` dobija `kind: "create"` |
| Review store apply mkdir | `applyFiles` dobija `kind: "mkdir"`; `open_diff` na mkdir path → error, ne crash |
| Undo All pre Keep | nema poziva apply |

---

## Rizici

- Slab model stavi prazan SEARCH na postojeći fajl — namerno fail, retry sa pravim SEARCH.
- Mkdir posle Keep se ne vraća Ctrl+Z — prihvaćeno.
- `createFile` + dirty untitled sa istim imenom — van opsega; stale ako se pojavi na disku.
