# Gde odstupamo od Mozaika i zašto

**Datum:** 2026-09-06
**Verzija paketa:** `@mozaik-ai/core` 4.0.6

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

## 1. Inference — endpoint direktno, ne `DefaultInferenceRunner` / `runLoop`

**Mozaik ima:** `OpenAIChatCompletions implements Endpoint` (uz `OpenAIResponses`,
`AnthropicMessages`, `GeminiGenerateContent`), `DefaultInferenceRunner`,
`InferenceEndpointMapper`, `supportedModels`, `ModelSpecification`, plus
`runLoop` / `InferenceStreamingState`.

**Šta je zatvoreno (Slice 2):** HTTP/SSE i final assemble idu preko
`OpenAIChatCompletions.stream` — endpoint yield-uje **sirove OpenAI chunkove**
plus `inference.output`. Ručni `fetch` ostaje samo kao test escape hatch
(`fetchImpl`). `max_tokens` i `stream_options.include_usage` preko `extraBody`.
Ime modela i dalje ide u `InferenceInput.model` **kakvo jeste, bez filtera**
(`AGENTS.md`, odluka #6).

**Zašto i dalje imamo svoj path:** ne rutiramo kroz `DefaultInferenceRunner`
(name lock na `supportedModels`) niti `runLoop` (mid-stream chunkovi u
`runLoop` idu samo u cloud visitor, ne u naš UI). Turn petlju i post-parse
i dalje vodimo sami:

| Mehanizam | Gde ostaje naše |
|---|---|
| Turn petlja (`EditorAgent` / `ResearchWorker`) | HITL, cancel, step budget |
| `streamMode`, narracija, fence mute | mid-stream iz sirovih chunkova endpoint-a |
| `usage.total_tokens`, `reasoning_content` | lokalni `applyChatChunk` |
| Empty / length recovery | posle `inference.output` |
| SEARCH/REPLACE → synthetic `propose_edit` | post-parse, odluka #5 |

**Kad bi se vratilo:** kad `runLoop` dobije injectable app hook za mid-stream
UI, ili kad nam više ne treba slobodno ime modela van `supportedModels`.

---

## 2. Izvršavanje alata — participant turn loop + guardovi, ne `runLoop`

**Mozaik ima:** `DefaultFunctionCallRunner` + `FunctionCallState` u `runLoop`.

**Šta je zatvoreno (Slice 1):** formatiranje uspešnog izlaza alata ide preko
`runtime.getFunctionCallRunner().run()` — isti `DefaultFunctionCallRunner`
(Mozaik 4.0.6: string bez `JSON.stringify`, catch vraća grešku kao
`FunctionCallOutputItem`).

**Zašto i dalje imamo svoj path:** alatne pozive i dalje vodimo kroz
participant (`EditorAgent.invokeTool` / `ResearchWorker.invokeTool`), ne kroz
Mozaikov `runLoop` / `FunctionCallState`. Glavni razlog su **guardovi**
(`doom_loop`, unknown tool, wind-down explore block, loš JSON) i **custom turn
petlja** (HITL, cancel/generation, step budget,
`deliverFunctionCallOutput` preko fasade) — **ne** zbog stringify ili
dupliranog formatiranja izlaza.

**Kad bi se vratilo:** kad pređemo na Mozaik `runLoop` / FunctionCallState
(ili kad runner postane injectable i uklopimo ga u našu petlju bez gubitka
guardova i UI hook-ova).

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
| 1 | `OpenAIChatCompletions.stream` + lokalni mid-stream/post-parse | `DefaultInferenceRunner`, `runLoop` | UI hook-ovi; model bez filtera; fence/recovery/edit post-parse |
| 2 | `invokeTool` + `getFunctionCallRunner()` | `runLoop` / FunctionCallState | guardovi + custom turn petlja (formatiranje preko Mozaika) |
| 3 | `AgenticEnvironment` / `BaseParticipant` | `SituationSpecification`, `Agent` | override ergonomija + vlasništvo po `producerId` |
| 4 | `compactContext`, `instructions` | `Memory`, `ModelContextRepository`, `ReasoningItem` | politika trimovanja vezana za proizvod; razmišljanje van konteksta |

Tri od četiri su **zaobilaženja jednog konkretnog ponašanja**, ne odbacivanje
apstrakcije. Ako se to ponašanje promeni, povratak je jeftin — zato su granice
tanke i na jednom mestu.
