# Design: Mozaik hybrid — endpoint stream + FunctionCallRunner

**Datum:** 2026-09-06  
**Status:** complete (slice-2 done)  
**Plan:** `docs/superpowers/plans/2026-09-06-mozaik-hybrid-endpoint-runner.md`  
**Paket:** `@mozaik-ai/core` 4.0.6  
**Cilj:** maksimalno koristiti Mozaik gde već radi, bez `runLoop` (mid-stream UI hook ne postoji).

---

## Problem

Imamo četiri dokumentovana odstupanja (`docs/mozaik-divergences.md`). Dva od njih
su delimično rešiva bez gubitka produkta:

1. **Inference** — pišemo sopstveni HTTP/SSE (`runLocalChatCompletions`) iako
   Mozaik `OpenAIChatCompletions.stream` već yield-uje **sirove OpenAI chunkove**,
   pa tek na kraju `inference.output`.
2. **Tool izvršavanje** — `invokeTool` duplira formatiranje koje je u 4.0.6
   ispravljeno u `DefaultFunctionCallRunner` (string bez `JSON.stringify`).
   Runner nije exportovan, ali je dostupan preko
   `runtime.getFunctionCallRunner()` posle `initializeRuntime`.

Full `runLoop` / `FunctionCallState` **nije** u opsegu: `InferenceStreamingState`
šalje mid-stream chunkove samo u hardkodovani `EventPublisherLoopVisitor`
(cloud `inference.stream`), ne u naš agent/UI. Fence, narracija i usage bi
nestali ili bi zahtevali upstream hook.

---

## Non-goals

- Ne prelazimo na `runLoop` / `AgentLoop`.
- Ne menjamo `BaseParticipant` / `producerId` filtriranje (#3).
- Ne menjamo `compactContext` politiku (#4).
- Ne tražimo injectable `FunctionCallRunner` kao blocker (koristimo default iz runtime-a).
- Ne uklanjamo guardove: `doom_loop` (`MAX_IDENTICAL_CALLS`), wind-down,
  unknown-tool poruke, empty-completion recovery.

---

## Ciljna arhitektura

```
EditorAgent / ResearchWorker          (naša turn petlja)
        │
        ├─ inference ──► OpenAIChatCompletions.stream(InferenceInput)
        │                      │
        │                      ├─ raw chunks  → streamMode, narracija, usage, reasoning
        │                      └─ inference.output → deliver FunctionCall / ModelMessage
        │
        └─ tools ──────► guards (naši) → runtime.getFunctionCallRunner().run(call, tool)
                                         → deliverFunctionCallOutput
```

Bus i participant fasada ostaju. Menjaju se samo **kako se zove model** i
**kako se formatira uspešan tool invoke**.

---

## Slice 1 — Tool path preko Mozaik runnera

### Danas

`EditorAgent.runTool` / `ResearchWorker` sami:
`JSON.parse` → `tool.invoke` → `typeof string ? raw : JSON.stringify`, plus
Error stringovi za guardove.

### Posle

1. `AgenticEnvironment` izloži runner:
   ```ts
   getFunctionCallRunner(): FunctionCallRunner  // via resolveRuntime().getFunctionCallRunner()
   ```
   Tip `FunctionCallRunner` možda nije u public exportu 4.0.6 — proveriti; ako
   nije, lokalni tip sa istim potpisom (`run(call, tool) => Promise<FunctionCallOutputItem>`).

2. U `invokeTool` (oba participant-a):
   - Guardovi (unknown tool, identical-call, wind-down explore block) i dalje
     vraćaju `FunctionCallOutputItem.create(callId, "Error: …")` **bez** poziva runnera.
   - Inače: `const item = await env.getFunctionCallRunner().run(call, tool)` pa
     `deliverFunctionCallOutput(this, item)`.
   - `lastToolWasWrite` i dalje postavljamo lokalno pre/posle uspešnog invoke-a
     (runner ne zna za WRITE_TOOLS).

3. Napomena: Mozaik catch poruka je `Error calling tool: …`; naši guardovi ostaju
   `Error: …`. Namerno različito — guard vs runtime fail.

4. Ažurirati komentar u `editor-agent.ts` (više ne „bypass zbog stringify“) i
   `mozaik-divergences.md` #2.

### Testovi

- Unit: mock runner; assert da se zove samo kad guard ne blokira.
- Postojeći tool/edit testovi ne smeju da se pokvare (string output i dalje raw).

---

## Slice 2 — Inference preko `OpenAIChatCompletions`

### Danas

`runLocalChatCompletions`: ručni `fetch` + `readSseChatCompletion` + assemble +
emit bus eventi.

### Posle

1. Pri `initializeRuntime` (ili lazy u environment): registrovati model(e) nije
   obavezno ako **ne** koristimo `DefaultInferenceRunner` — zovemo endpoint
   direktno:
   ```ts
   new OpenAIChatCompletions(undefined, {
     baseURL: process.env.OPENAI_BASE_URL,
     apiKey: process.env.OPENAI_API_KEY ?? "not-needed",
   })
   ```
   Ime modela i dalje ide u `InferenceInput.model` kakvo jeste (DeepSeek / Ollama),
   bez Mozaik `supportedModels` name filtera — zato **ne** rutiramo kroz
   `DefaultInferenceRunner` (on traži ime u listi).

2. Zameniti HTTP sloj u `local-inference.ts` (ili novi tanki modul
   `mozaik-chat-stream.ts`):
   - `for await (const event of endpoint.stream(input))`
   - Ako `event?.type === "inference.output"` → final assemble iz `payload`
     (items + tokenUsage + `rowResponse` ako treba finish_reason).
   - Inače tretirati kao OpenAI chunk: postojeći `applyChatChunk` /
     `streamMode` / `onProseDelta` put.

3. Gradnja `InferenceInput`: context (`ModelContext`), tools, model, streaming
   true, max tokens / reasoningEffort po potrebi. Mapper Mozaika već mapira
   context item-e slično našem `toChatMessages` — proveriti parity (posebno
   grouping tool_calls na jedan assistant message).

4. Zadržati post-processing na kraju: `parseToolCallsFromContent`,
   SEARCH/REPLACE → synthetic `propose_edit`, empty recovery, length-cap poruke.
   To nije Mozaikovo; ostaje naše.

5. `extraBody` / `stream_options.include_usage`: OpenAI SDK stream mora i dalje
   da dobije usage. Proveriti da li `OpenAIChatCompletions` `extraBody` ili
   `buildRequest` to podržava; ako ne, proslediti kroz constructor `extraBody`
   ili zadržati mali lokalni patch samo za usage.

### Rizici Slice 2

| Rizik | Mitigacija |
|---|---|
| Chunk oblik OpenAI SDK vs naš ručni SSE JSON | Adapter: ako chunk već objekat, `applyChatChunk`; regression test sa snimljenim chunkovima |
| `supportedModels` name lock ako neko slučajno uđe u DefaultInferenceRunner | Ne koristiti runner; dokumentovati |
| `ReasoningItem` u final payload — mi ga ne želimo u context | I dalje ne add-ujemo ReasoningItem u ModelContext; reasoning samo za trace iz chunk/final |
| Parity tool message layout | Diff našeg `toChatMessages` vs mapper; fixture test |

---

## Šta ostaje „naše“ (namerno)

| Mehanizam | Zašto |
|---|---|
| Turn petlja u `EditorAgent` | HITL, cancel/generation, step budget |
| Guardovi alata | Produkt, ne framework |
| `streamMode` + narracija | runLoop ih ne daje UI-ju |
| Empty / length recovery | Provider quirk (gemma / reasoning budget) |
| SEARCH/REPLACE u content → propose_edit | Edit format odluka #5 |
| `compactContext` | Produkt politika |

---

## Redosled implementacije

1. **Slice 1** (mali, nizak rizik) — runner za tool output.  
2. Ažurirati divergences.  
3. **Slice 2** — endpoint stream; držati `chat-stream.ts` assemble logiku.  
4. Opciono kasnije: upstream issue za injectable `LoopVisitor` / mid-stream app hook → tek tad razmatrati `runLoop`.

---

## Definicija gotovog

- [x] Tool uspeh ide kroz `getFunctionCallRunner().run`; string fajlova i dalje raw u contextu.
- [x] Guardovi i dalje blokiraju bez poziva runnera.
- [x] Inference (posle slice 2) koristi `OpenAIChatCompletions.stream`; narracija + fence mute + usage meter rade.
- [x] Nema `runLoop` u call graphu agent turna.
- [x] `mozaik-divergences.md` #1/#2 ažurirani: delimično zatvoreni / novi razlog za ostatak.
- [x] Postojeći agent-core testovi prolaze; dodati 1–2 uska testa za runner guard + chunk vs `inference.output` granu.

---

## Odlučeno

- Hibrid: **endpoint stream + default FunctionCallRunner**, ne full B (`runLoop`).
- Participant fasada i custom turn loop ostaju.
