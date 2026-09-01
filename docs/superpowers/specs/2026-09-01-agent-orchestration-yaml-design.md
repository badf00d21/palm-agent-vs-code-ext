# Agent orchestration YAML — design spec

**Datum:** 2026-09-01  
**Status:** predlog  
**Nastavlja:** Superpowers brainstorm → spec → plan; Mozaik `join` ostaje kasnija faza (`AGENTS.md` odluka #2 / baro)  
**Ne pokriva:** Mozaik worker `join`, Board claim/lease runtime, extension komanda `build`, UI za talase, LLM nagađanje `blocked_by`, `wave:` polje, YAML anchors/merge keys

---

## Cilj

Posle odobrenog speca i implementation plana, agent dobije treći artefakt koji **može da parsira**: ko sme koji task, koji fajlovi su lease, šta blokira šta. Čovek kaže **build** da bi se implementacija uopšte smela pokrenuti. Koraci (test, kod, commit) ostaju u planu.

**Gotovo je kad važi sve ovo:**

1. Postoji `docs/superpowers/orchestrations/<stem>.yaml` uz plan istog stem-a. Schema je `palm.orchestration/v1`.
2. Čista funkcija parsira taj YAML u tip; odbija nepoznata polja, anchors, i nedostajući `schema` / `gate` / `spec` / `plan` / `tasks`.
3. Čista funkcija izvlaci raspored iz Superpowers plana (`### Task N:` + `Files:` + opciono `Consumes:`). Ne izmišlja zavisnosti. Ako nema `Consumes`, `blocked_by: []`.
4. Validator: implementer mora imati bar jedan file; critic ima prazan `files`; dva implementera koja dele path moraju imati `blocked_by` u jednom smeru (inače error). `gate` na generisanom fajlu je uvek `human_build`.
5. Regeneracija iz plana **prepisuje** YAML. Živo stanje (claim, done, lease) nije u tom fajlu.
6. Nema `import 'vscode'` u `agent-core`. Nema novog Mozaik participaнта. Nema webview poruke.
7. Testovi ispod prolaze bez Ollama-a i bez VS Code UI-ja.

---

## Zaključane odluke

- Artefakt je za **agente**, ne kao treći esej. Jedan opcioni `#` komentar na vrhu sme (putanje spec/plan); telo je schema.
- Put: `docs/superpowers/orchestrations/YYYY-MM-DD-<feature>.yaml`. Stem = ime plana bez putanje, npr. plan `docs/superpowers/plans/2026-09-01-context-compact-new-chat.md` → `docs/superpowers/orchestrations/2026-09-01-context-compact-new-chat.yaml`.
- `schema: palm.orchestration/v1` tačno. Druga vrednost = parse error.
- `gate: human_build` na svemu što generator upiše. Parser prihvata samo `human_build` u v1 (nema `open`). Nijedan budući worker ne uzima task dok čovek eksplicitno ne kaže build — to polje je ugovor; v1 ga samo nosi, ne izvršava.
- Nema `wave:`. Talas se računa iz `blocked_by` + file lease (runtime, van ovog fajla).
- YAML na disku je **raspored**. Claim / lease / done žive kasnije na Boardu u memoriji (ili gitignored sidecar, van v1). Posle pada procesa, claimovi se gube.
- Ako plan i YAML divergiraju, **pobeđuje plan**; YAML se ponovo izvuče. Generator ne merge-uje ručne izmene YAML-a.
- Generator čita samo plan. Spec path se upisuje iz frontmatter-a plana ili iz argumenta poziva; ne parsira spec da bi crtao taskove.
- `blocked_by` se ne nagađa iz preklapanja fajlova i ne nagađa LLM. Izvor: `Consumes:` u tasku ako ime taska/id može da se veže; inače `[]`. File overlap bez `blocked_by` je **validator error**, ne tihi paralel.
- `role` je `implementer` | `critic`. Generator u v1 emituje samo `implementer` (jedan red po `### Task N`). Critic redovi se ne izmišljaju.
- `plan_heading` je tačan tekst headinga posle `### `, npr. `Task 1: compactContext`.
- `id` je `T` + broj iz headinga (`Task 1` → `T1`). Nema `T1a`. Ako heading nema broj, parse/generate error.
- `files`: repo-relativni POSIX, bez vodećeg `./`. Iz linija `- Create:` / `- Modify:` / `- Test:` (putanja je token posle dvotačke, odsečen na `:` line-range ako postoji, npr. `foo.ts:123-145` → `foo.ts`).
- `max_parallel`: obavezan integer `>= 1`. Generator stavlja `1` (konzervativno). Ne računa max iz grafa.
- `spec` i `plan` su repo-relativni POSIX pathovi, obavezni.
- Parser je **schema-specific** (ovaj oblik), ne generalni YAML 1.2. Nema biblioteke `yaml` u v1. Zabranjeno: aliases (`*`, `&`), tags (`!!`), merge (`<<`), multiline `|` / `>`, nested mape osim polja task objekta navedenih dole.
- Skill (projekat): `.cursor/skills/writing-orchestration/SKILL.md`. Zove se **posle** writing-plans, **pre** executing-plans / subagent-driven-development. Upstream Superpowers plugin se ne fork-uje.
- v1 **ne** `join`-uje workere. v1 je fajl + parse + generate + validate.

---

## Van opsega

Mozaik `join` implementera/critica, Board participant, extension `build` komanda / chat keyword, webview prikaz talasa, `wave:` polje, sidecar status YAML, git worktree po tasku, LLM-izveden `blocked_by`, critic auto-redovi, `gate: open`, generalni YAML engine, izmena `AGENTS.md` locked odluke #7 (multi-agent runtime i dalje van opsega).

---

## Wire

```
odobren spec + plan na disku
  → writing-orchestration skill
       orchestrationFromPlan(planMarkdown, { spec, plan })
       validateOrchestration(doc)
       write docs/superpowers/orchestrations/<stem>.yaml

budući runtime (nije v1)
  → parseOrchestration(yamlText)
  → Board čita raspored; claim/lease nisu u fajlu
  → human "build" otvara gate
  → worker čita samo svoj plan_heading iz plana
```

---

## Schema (`palm.orchestration/v1`)

```yaml
schema: palm.orchestration/v1
gate: human_build
spec: docs/superpowers/specs/2026-09-01-context-compact-new-chat-design.md
plan: docs/superpowers/plans/2026-09-01-context-compact-new-chat.md
max_parallel: 1
tasks:
  - id: T1
    plan_heading: "Task 1: compactContext"
    role: implementer
    files:
      - packages/agent-core/src/context/compact.ts
      - packages/agent-core/test/context/compact.test.ts
    blocked_by: []
  - id: T3
    plan_heading: "Task 3: EditorAgent compact before inference"
    role: implementer
    files:
      - packages/agent-core/src/participants/editor-agent.ts
      - packages/agent-core/test/participants/editor-agent.test.ts
    blocked_by:
      - T1
```

Dozvoljena polja dokumenta: `schema`, `gate`, `spec`, `plan`, `max_parallel`, `tasks`.  
Dozvoljena polja taska: `id`, `plan_heading`, `role`, `files`, `blocked_by`.  
Sve ostalo = error.

---

## API (agent-core)

Fajl: `packages/agent-core/src/orchestration/orchestration.ts`.

```ts
export const ORCHESTRATION_SCHEMA = "palm.orchestration/v1";

export type OrchestrationRole = "implementer" | "critic";
export type OrchestrationGate = "human_build";

export interface OrchestrationTask {
  id: string;
  planHeading: string;
  role: OrchestrationRole;
  files: string[];
  blockedBy: string[];
}

export interface OrchestrationDoc {
  schema: typeof ORCHESTRATION_SCHEMA;
  gate: OrchestrationGate;
  spec: string;
  plan: string;
  maxParallel: number;
  tasks: OrchestrationTask[];
}

export type OrchestrationError = { error: string };

export function parseOrchestration(text: string): OrchestrationDoc | OrchestrationError;

export function orchestrationFromPlan(
  planMarkdown: string,
  paths: { spec: string; plan: string },
): OrchestrationDoc | OrchestrationError;

export function validateOrchestration(
  doc: OrchestrationDoc,
): OrchestrationError | undefined;

export function formatOrchestration(doc: OrchestrationDoc): string;
```

`parse` + `format` su round-trip za dokument koji `format` proizvede (whitespace nije bitan; redosled taskova jeste).

`orchestrationFromPlan` greška ako nema nijednog `### Task <n>:`; ako Create/Modify/Test path fali na implementer tasku.

`validateOrchestration` (zove se i iz `parse` i iz `fromPlan`):

| Pravilo | Error copy (tačno) |
|---|---|
| `id` nije `T` + celi broj | `Invalid task id: <id>` |
| Duplikat `id` | `Duplicate task id: <id>` |
| `blocked_by` referiše nepoznat id | `Unknown blocked_by: <id>` |
| `blocked_by` ciklus | `blocked_by cycle` |
| implementer `files.length === 0` | `Implementer <id> has no files` |
| critic `files.length !== 0` | `Critic <id> must not lease files` |
| dva implementera dele path i nijedan nije u `blocked_by` drugog (direktno) | `File leased by independent tasks: <path>` |
| `max_parallel < 1` ili nije integer | `Invalid max_parallel` |
| path sa `\` ili sa `./` prefix | `Invalid path: <path>` |

Direktno `blocked_by`: A navede B ili B navede A. Transitivni lanac **ne** računa se kao dozvola za isti path (T1→T2→T3 ne dozvoljava T1 i T3 da dele fajl bez T1∈T3.blocked_by ili obrnuto). Namerno strogo: preklapanje kroz lanac i dalje zahteva eksplicitnu ivicu ili razdvojene fajlove.

---

## Skill

`.cursor/skills/writing-orchestration/SKILL.md`:

- Trigger: postoji odobren plan na `docs/superpowers/plans/…`; čovek još nije rekao build kao izvršenje.
- Radi: pročitaj plan, `orchestrationFromPlan`, `formatOrchestration`, upiši YAML, nemoj startovati taskove.
- Reci čoveku putanju YAML-a i da implementacija čeka eksplicitni **build**.
- Ne zovi subagent-driven-development.

---

## Testovi (obavezni)

| Ponašanje | Očekivanje |
|---|---|
| Golden: isečak T1 + T3, Consumes linija sadrži `T1` ili `Task 1` | `T3.blockedBy` sadrži `T1`; T1 files iz Create/Test linija |
| Plan task bez `Consumes` | `blocked_by: []` |
| Modify `foo.ts:123-145` | files ima `foo.ts` |
| Dva taska, isti `compact.ts`, prazan blocked_by | validate error `File leased by independent tasks: …` |
| Critic sa files | error |
| `parse` odbije `schema: other` | error |
| `parse` odbije `&anchor` | error |
| `format` → `parse` | deep-equal dokument |
| Nepoznato polje `wave` | error |
| `id: Task1` | `Invalid task id: Task1` |

Nije obavezno u v1: upis celog 1155-linijskog compact plana kao golden (prevelik). Fixture je mali isečak sa 2–3 taska u istom heading formatu.

---

## Rizici

- Postojeći planovi nemaju `Consumes:` (compact plan nema). Generator će dati prazan `blocked_by`, pa validator **pukne** na preklapanju fajlova ako ga ima, ili pusti lažni paralel ako ga nema. Prihvaćeno: v1 je stroža od starih planova; novi planovi trebaju `Consumes:` ili disjunktne fajlove. Nije cilj da se 2026-09-01 compact plan automatski orkestruje bez dopune `Consumes`.
- Schema-specific parser može odbiti legalan YAML 1.2 koji agent ručno ulepša. Prihvaćeno: `formatOrchestration` je kanonski oblik; ručni YAML van podskupa je error.
- `blocked_by: [T1]` iz `Consumes: compactContext` zahteva mapiranje imena na id. v1 mapira samo `T\d+` tokene u Consumes liniji i `Task <n>`. Slobodan naziv komponente bez broja se **ignoriše** (ne error), da generator ne pogađa.
