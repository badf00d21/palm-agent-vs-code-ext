# Gde odstupamo od Mozaika i zašto

**Datum:** 2026-09-06
**Verzija paketa:** `@mozaik-ai/core` 4.0.5

Registar mesta gde smo napisali svoje iako Mozaik to već ima. Svrha je dvojaka:
da odluka ne bude slučajna, i da se zna šta bi se vratilo na framework ako se
razlog ukloni.

**Ovo nije spisak zamerki.** Bus, participanti, context item-i i cloud
telemetrija su Mozaikovi i koriste se kakvi jesu. Odstupanja su četiri.

---

## Šta koristimo iz Mozaika

`defineRuntime`, `Participant`, `RuntimeState`, `SemanticEvent`,
`SituationSpecification`, `SituationHandler`, `ModelContext`, `ContextItem`, i
item klase (`FunctionCallItem`, `FunctionCallOutputItem`, `ModelMessageItem`,
`UserMessageItem`, `DeveloperMessageItem`, `SystemMessageItem`), tip `Tool`, i
`@mozaik-ai/cloud-sdk/exporter` za live loop view.

Bus je i dalje Mozaikov. Paralelni radnici rade zato što on emituje svakom
učesniku.

---

## 1. Inference — `runLocalChatCompletions` umesto `OpenAIChatCompletions`

**Mozaik ima:** `OpenAIChatCompletions implements Endpoint` (uz `OpenAIResponses`,
`AnthropicMessages`, `GeminiGenerateContent`), `DefaultInferenceRunner`,
`InferenceEndpointMapper`, `supportedModels`, `ModelSpecification`.

**Zapisani razlog** (`AGENTS.md`, odluka #6): jezgro ne koristi Mozaikov routing
po imenu modela — sami gađamo `${OPENAI_BASE_URL}/chat/completions`, pa ime
modela ide endpoint-u **kakvo jeste, bez filtera**. Istorijski: imena tipa
`gpt-*` / `o1-*` / `text-*` su rutirana na pogrešan API.

**Razlog koji se video tek kasnije, i teži je.** Potpis je:

```ts
stream(inferenceInput: InferenceInput): AsyncIterable<SemanticEvent>
```

To je **normalizovan** tok događaja. Sve što nam je rešilo najgore bugove traži
**sirove delte**:

| Mehanizam | Traži pristup sirovom stream-u |
|---|---|
| `streamMode` — prebacivanje u „tool" čim se pojavi `<<<<<<< SEARCH` | da, usred toka |
| Narracija po delti (jedan bubble koji raste) | da, tajming delti |
| `usage.total_tokens` za context meter | da, poslednji chunk |
| Hvatanje `reasoning_content` odvojeno od `content` | da, po polju delte |
| Detekcija praznog odgovora + oporavak | da, `finish_reason` |

Kroz normalizovan `SemanticEvent` tok ništa od toga ne bismo videli.

**Kad bi se vratilo:** ako `Endpoint` dobije pristup sirovim delta poljima
(uključujući `reasoning_content`) ili hook pre normalizacije.

---

## 2. Izvršavanje alata — `invokeTool` umesto runner-ovog

**Mozaik ima:** izvršavanje function call-a u `DefaultInferenceRunner`, uz
`FunctionCallExecutionOutput`.

**Zapisani razlog** (`editor-agent.ts:209`): runner **`JSON.stringify`-uje svaki
izlaz**, pa bi model sadržaj fajla čitao kao jedan escape-ovan red.

**Šta smo time dobili osim sirovog izlaza:** greške alata (nepoznato ime, loš
JSON, `invoke` koji baci) vraćaju se modelu **kao izlaz tog poziva**, pa se sam
ispravlja umesto da turn pukne — a par poziv/izlaz u kontekstu ostaje ceo. Na
toj šini kasnije leže `doom_loop` guard i format-guidance poruke.

**Kad bi se vratilo:** ako runner prestane da stringify-uje izlaz i dozvoli da
greška bude izlaz umesto izuzetka.

---

## 3. Ergonomija participanta — fasada u `runtime/environment.ts`

**Mozaik ima:** deklarativni model — `SituationSpecification` + `SituationHandler`,
plus gotove `Agent` / `Human` participante i `createAgent` / `createHuman`.

**Razlog:** hteli smo nasleđivanje sa override metodama (`onMessage`,
`onFunctionCall`, `onFunctionCallOutput`, `onModelMessage`, `onExternal*`) umesto
da svaki participant sam piše specifikacije.

**Bitno:** ovo je **fasada nad `defineRuntime`, ne zamena.** 231 linija koja
prevodi situacije u callback-e.

**Šta fasada nosi, a nije samo sintaksa:** filtriranje po `producerId`. Bus
emituje svaki događaj svima, a `BaseParticipant` zove `onFunctionCall` /
`onFunctionCallOutput` / `onModelMessage` **samo za događaje koje je taj
participant sam proizveo**; tuđi padaju na `onExternal*` no-op-ove. To je jedina
stvar koja sprečava da paralelni radnici i glavni `EditorAgent` voze petlje
jedni drugima (`research/worker.ts:105`).

**Kad bi se vratilo:** ako `Agent` dobije isto vlasništvo po `producerId` i
override tačke.

---

## 4. Kontekst — `compactContext` i `instructions`, ne `Memory` / `ModelContextRepository`

**Mozaik ima:** `Memory`, `ModelContextRepository`, i `ReasoningItem` kao
prvorazredni context item.

**Razlog:** `ModelContext` koristimo, ali politika **šta se izbacuje** je naša i
vezana za ovaj proizvod: `compactContext` stub-uje izlaze alata iz prethodnih
turn-ova, kliza prozor na poslednja 3 user turn-a preko `SLIDE_RATIO`, i **nikad
ne dira zonu ispred prve user poruke** — tamo sede `SYSTEM_PROMPT` i `AGENTS.md`.

Ne perzistiramo kontekst, pa `ModelContextRepository` nema šta da radi; New chat
gradi nov `ModelContext`.

`ReasoningItem` **namerno ne koristimo**: razmišljanje držimo van konteksta
(`AssembledCompletion.reasoning`), samo da bi trace mogao da kaže istinu.
Mozaik ima mesto za njega — mi smo odlučili da tamo ne ide.

**Kad bi se vratilo:** ako zatreba perzistencija sesija između prozora, ili ako
se pokaže da modelu treba sopstveno ranije razmišljanje u kontekstu.

---

## Nekorišćeno, ali ne zbog neslaganja

`McpClient` i `McpToolRegistry` — MCP je van opsega po `AGENTS.md` odluci #7,
dok jezgro ne radi. Nije odstupanje nego redosled.

---

## Sažetak

| # | Naše | Mozaikovo | Glavni razlog |
|---|---|---|---|
| 1 | `runLocalChatCompletions` | `OpenAIChatCompletions`, `DefaultInferenceRunner` | ime modela bez filtera; sirove delte za fence/narraciju/reasoning/usage |
| 2 | `invokeTool` | runner-ovo izvršavanje | runner stringify-uje izlaz; greška kao izlaz, ne kraj turn-a |
| 3 | `AgenticEnvironment` / `BaseParticipant` | `SituationSpecification`, `Agent` | override ergonomija + vlasništvo po `producerId` |
| 4 | `compactContext`, `instructions` | `Memory`, `ModelContextRepository`, `ReasoningItem` | politika trimovanja vezana za proizvod; razmišljanje van konteksta |

Tri od četiri su **zaobilaženja jednog konkretnog ponašanja**, ne odbacivanje
apstrakcije. Ako se to ponašanje promeni, povratak je jeftin — zato su granice
tanke i na jednom mestu.
