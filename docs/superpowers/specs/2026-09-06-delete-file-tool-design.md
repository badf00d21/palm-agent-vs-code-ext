# `delete_file` tool — design spec

**Datum:** 2026-09-06
**Status:** implementirano
**Nastavlja:** `docs/superpowers/specs/2026-08-30-create-file-mkdir-design.md` (isti propose→review→apply pipeline, treća vrsta `kind`)
**Ne pokriva:** brisanje direktorijuma/rmdir, batch delete više fajlova jednim pozivom, undo-friendly recovery posle Keep All, research worker pristup ovom toolu

---

## Cilj

Agent može da **predloži** brisanje postojećeg fajla istim Keep All / Undo All flow-om kao `write` i `edit`. Disk se ne dira pre Keep All. Brisanje je jedina nepovratna operacija u ovom pipeline-u, pa ljudska kapija ovde mora da bude čvršća, ne slabija.

**Gotovo je kad važi sve ovo:**

1. Model pozove `delete_file({ path })` na postojeći fajl → `reviewHost.merge` dobija `{ path, original, proposed: "", kind: "delete" }` → `diff_proposed` → kartica u review dock-u.
2. Delete se u kartici vidi drugačije od edit/create: strikethrough, error boja, eksplicitna `delete` oznaka — čovek koji skenira review ne može da ga zameni sa edit-om.
3. Keep All briše fajl kroz `WorkspaceEdit.deleteFile` na **istom** edit objektu kao ostale promene u tom review-u (ista undo transakcija), ne kroz `vscode.workspace.fs.delete`.
4. Undo All pre Keep All ne dira disk — isto kao za svaki drugi pending review.
5. `delete_file` odbija direktorijum, nepostojeći fajl i putanju van workspace-a, uvek kao `Error: ...` string koji model može da ispravi.
6. `reviewStore.ts` je nepromenjen za ovaj slučaj — delete prolazi kroz isti staleness guard kao edit (odbijen ako se fajl promenio ispod).
7. Research worker (`filterReadOnlyTools`) nema pristup `delete_file` — allow-list ga isključuje po difoltu.
8. Testovi u `tools.test.ts`, `applyFiles.test.ts`, `reviewStore.test.ts` prolaze.

---

## Zaključane odluke

| Tema | Izbor |
|---|---|
| Tool granularnost | Jedan poziv = jedan fajl, flat `{ path }` args (isti razlog kao `write`/`edit`: ugnježdeni nizovi lome Ollama tool parser) |
| Mehanizam brisanja | `WorkspaceEdit.deleteFile`, ne `vscode.workspace.fs.delete` |
| Direktorijum kao target | `Error:` — v1 ne pokušava da pogodi šta „obriši direktorijum" treba da znači |
| Nepostojeći fajl kao target | `Error:` umesto tihog no-op-a — model se ispravlja i pokušava ponovo |
| `reviewStore.ts` izmena | Nijedna — delete pada u postojeću ne-create/mkdir granu |
| Research worker pristup | Nema — `READ_ONLY_TOOL_NAMES` je allow-list, fail-closed |
| `ProposedKind` | Proširen sa `EditKind` (`"edit" \| "create" \| "mkdir"`) na `EditKind \| "delete"` |

---

## Arhitektura

| Deo | Gde |
|---|---|
| Tool invoke | `invokeDeleteFile` u `packages/agent-core/src/tools/propose-edit.ts` |
| Tool registracija + schema | `packages/agent-core/src/tools/tools.ts` (`delete_file` u `createWorkspaceTools`) |
| `SYSTEM_PROMPT` red | isto u `tools.ts`: „To delete an existing file, call delete_file with its path…" |
| Kind tip | `ProposedKind` u `packages/agent-core/src/tools/review.ts` |
| Wire tip za webview | `DiffFile.kind` u `packages/shared/src/index.ts` |
| Apply na disk | `applyFiles` u `packages/extension/src/applyFiles.ts` |
| Staleness guard | `reviewStore.ts` `apply()` — bez izmene, postojeća grana |
| UI kartica | `ReviewCard.tsx` + `App.css` (`.review-file-delete`, `.review-kind-delete`) |
| Path resolucija | `resolveWorkspaceFilePath` u `packages/agent-core/src/workspace/locate.ts` (isti helper kao `read_file`/`edit`) |
| Research worker izolacija | `READ_ONLY_TOOL_NAMES` u `packages/agent-core/src/research/worker.ts` |

---

## Ponašanje

### `invokeDeleteFile` (propose-edit.ts)

- `args.path` prazan → `Error: delete_file requires path`.
- Putanja normalizovana `toPosix` + strip `./`; ako se završava na `/` → `Error: delete_file only deletes a single file, not a directory` (bez ijednog I/O poziva — trailing slash je dovoljan signal).
- `resolveWorkspaceFilePath(port, normalized)` — isti helper kao za `read_file`/`edit` (bare filename se rešava po basename-u, ambiguous → `Error: Ambiguous file X: ...`).
- Kad `resolveWorkspaceFilePath` ne nađe fajl (jer taj helper rezolvuje samo fajlove), eksplicitno se proveri `port.exists(normalized)`:
  - `"dir"` → `Error: X is a directory. delete_file only deletes a single file.` (jasnija poruka nego generičko „No file named").
  - inače → prosledi originalnu grešku iz `resolveWorkspaceFilePath` (`Error: No file named X in this workspace`).
- `port.exists` koji baca (putanja van workspace-a) → `Error: <message from port>` umesto crash-a.
- Kad je fajl nađen: `port.readFile(filePath)` čita `original` (isto kao `write` i `propose_edit` kad prave `edit` proposal — original mora biti uhvaćen da bi staleness guard imao osnovu za poređenje).
- Uspeh: `reviewHost.merge([{ path: filePath, original, proposed: "", kind: "delete" }])`, poruka `Proposed review <id>: <path>` — isti format kao `write`/`edit`.

### Review pipeline — zašto `reviewStore.ts` nije menjan

`reviewStore.apply()` grana samo na `kind === "create" || kind === "mkdir"` (mora da ne postoji na disku) nasuprot svemu ostalom (mora da se `readFile` poklapa sa `original`). `delete` pada u „sve ostalo" granu bez izmene koda: staleness guard proverava da trenutni sadržaj fajla i dalje odgovara onome što je pročitano u trenutku predloga, tačno kao za edit. Ovo je namerno zabeleženo kao nalaz, ne kao odsustvo rada — nova vrsta kind-a se uklopila u postojeću granu bez potrebe za novim case-om.

### Apply — `WorkspaceEdit.deleteFile`, ne `fs.delete`

U `applyFiles.ts`, `kind === "delete"` poziva `edit.deleteFile(uri, { ignoreIfNotExists: false })` na **istom** `vscode.WorkspaceEdit` objektu na koji `create`/`edit` fajlovi iz istog review-a pozivaju `edit.createFile`/`edit.insert`/`edit.replace`. Ovo je load-bearing odluka: `vscode.workspace.fs.delete` je zaseban I/O poziv koji **nije** deo VS Code-ove undo transakcije, pa bi brisanje van `WorkspaceEdit`-a preživelo čak i Ctrl+Z na ostale promene iz istog Keep All. Deleted fajl se ne stavlja u `toSave` listu (nema šta da se save-uje) i ne otvara se editor za njega.

### UI — kartica u `ReviewCard.tsx`

- `isDelete = file.kind === "delete"` bira `review-file-delete` klasu i `delete` label (nasuprot `new` za create, ništa za edit/mkdir).
- CSS u `App.css`: `.review-file-delete` → `color: var(--vscode-errorForeground); text-decoration: line-through;`; `.review-kind-delete` → ista boja, `font-weight: 600`, bez strikethrough-a (label ne treba precrtan, sam fajl treba).
- Delete fajl i dalje ima `open_diff` dugme dok je pending (nije `mkdir`), pa čovek može da vidi diff (original vs prazno) pre Keep All.
- `hasReviewable` (bar jedan fajl koji nije `mkdir`) i dalje uključuje delete, pa se „Review" dugme pojavljuje.

### Prompt

`SYSTEM_PROMPT` u `tools.ts` dobija jednu rečenicu: „To delete an existing file, call delete_file with its path. It does not delete anything itself; the human reviews it with Keep All / Undo All exactly like write and edit." — model se eksplicitno uči da je ovo propose-only tool, isto kao za `write`/`edit`.

### Research worker izolacija

`READ_ONLY_TOOL_NAMES` u `packages/agent-core/src/research/worker.ts` je allow-list (ne deny-list): sadrži `read_file`, `list_dir`, `search`, `outline`, `glob`, `references`, `hover`, `diagnostics`, `web_fetch`, `docs_search`. `delete_file` (kao `write`, `edit`, `propose_edit`, `question`) nije na listi, pa `filterReadOnlyTools` ga automatski isključi iz worker-ovog tool seta — nova opasna sposobnost fail-closed po difoltu, bez potrebe da neko eksplicitno doda izuzetak.

---

## Komponente

### `invokeDeleteFile(args, port, reviewHost): Promise<string>`

`packages/agent-core/src/tools/propose-edit.ts` — signatura ista kao `invokeWrite`/`invokeEdit`.

### Tool schema (`tools.ts`)

```ts
{
  name: "delete_file",
  description:
    "Propose deleting one existing file. path must already exist and must be a single file, not a directory. Does not delete anything itself: this only proposes the deletion, and the human reviews it with Keep All / Undo All exactly like write and edit. One call deletes one file; call again for another file.",
  strict: true,
  type: "function",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path or unique filename of the file to delete" },
    },
    required: ["path"],
  },
  invoke: async (args) => invokeDeleteFile(args, port, reviewHost),
}
```

### `ProposedKind` (`review.ts`)

```ts
export type ProposedKind = EditKind | "delete";
```

### `applyFiles` grananje (`applyFiles.ts`)

```ts
if (file.kind === "delete") {
  edit.deleteFile(uri, { ignoreIfNotExists: false });
  hasEdit = true;
  continue;
}
```

---

## Testovi

`packages/agent-core/test/tools/tools.test.ts` (`describe("delete_file")`):

| Ponašanje | Očekivanje |
|---|---|
| Postojeći fajl | `kind: "delete"`, `original` popunjen, `proposed: ""` |
| Nepostojeći fajl | `Error: ...` sa imenom fajla |
| Direktorijum (postoji kao dir) | `Error: X is a directory. delete_file only deletes a single file.` |
| Trailing slash bez I/O provere | `Error: delete_file only deletes a single file, not a directory` |
| Putanja van workspace-a (`port.exists` baca) | `Error: Path is outside the workspace`, ne crash |
| Prazan `path` | `Error: delete_file requires path` |
| Bare filename, jedinstven u workspace-u | rezolvuje se preko `findFiles`, isti kao `read_file` |
| Merge sa drugim predlozima (write + delete) | oba u `pending.files`, redosled poziva |
| Vidljivost modelu | `toolsVisibleToModel` sadrži `delete_file` |
| Flat schema | `Object.keys(tool.parameters.properties)` je tačno `["path"]` |

`packages/extension/src/applyFiles.test.ts`:

- Delete ide kroz isti `WorkspaceEdit` kao ostale promene, ne kroz `vscode.workspace.fs.delete` (assert na `edit.deleteFile` poziv).
- Delete ne otvara ni ne save-uje dokument.
- Delete bez ijednog drugog edita i dalje prolazi kroz `applyEdit`.

`packages/extension/src/reviewStore.test.ts`:

- Predlog delete-a se prosledi `applyFiles` kao svaki drugi kind.
- Delete se odbija ako se fajl promenio od predloga (`File changed since proposal: ...`).
- Delete se merguje pored create-a i edit-a u jedan pending review.

---

## Rizici / poznato ograničenje

**Undo All pre Keep All ne piše ništa na disk** — u skladu sa `packages/extension/PRODUCT.md` („Undo All writes nothing"), Undo All samo odbacuje pending review objekat u memoriji. Posle **Keep All**, jedini put nazad je VS Code-ov nativni undo stack (Ctrl+Z), ne ova ekstenzija. Za tekstualni edit ta asimetrija je bezopasna — editor za taj fajl je otvoren i fokusiran, Ctrl+Z je prirodan sledeći potez. Za delete je oštrija: obrisan fajl je namerno isključen iz `toSave` liste u `applyFiles.ts` (nema editor koji bi se save-ovao), pa ne postoji očigledan editor na koji bi čovek fokusirao Ctrl+Z da povrati fajl. Da li `WorkspaceEdit.deleteFile` unutar iste transakcije zaista ostavlja radnu Ctrl+Z putanju u praksi (fokus, koji editor, redosled sa ostalim `create`/`edit` iz istog review-a) **nije provereno ručnim testom u pokrenutom extension host-u** — samo unit testovima nad mock `vscode` API-jem. Ovo treba potvrditi pre nego što se korisnicima kaže da je delete „bezbedno" reverzibilan posle Keep All.

---

## Van opsega

- Brisanje direktorijuma / rmdir (samo `delete_file` na pojedinačni fajl)
- Batch delete više fajlova jednim tool pozivom (jedan poziv = jedan fajl, isto kao write/edit)
- Bilo kakav app-level recovery mehanizam za deleted fajl posle Keep All (van VS Code native undo)
- Ručna verifikacija undo ponašanja u pravom extension host-u (vidi Rizici gore)
- Davanje `delete_file` pristupa research worker-ima
