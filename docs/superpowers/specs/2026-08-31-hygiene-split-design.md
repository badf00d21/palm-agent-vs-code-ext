# Hygiene split — design spec

**Datum:** 2026-08-31  
**Status:** predlog — čeka review  
**Nastavlja:** postojeći SEARCH/REPLACE + review loop  
**Ne pokriva:** nove biblioteke, `node:test` umesto Vitest, cookbook “8 linija po funkciji”, polymorphism za `kind`, prepisivanje velikih test fajlova, promenu ponašanja

---

## Cilj

Raseci tri preduga produkciona modula da budu čitljivi po TypeScript skillu (mali, jedan posao), bez promene runtime ponašanja.

**Gotovo je kad važi sve ovo:**

1. `propose_edit` invoke živi u `packages/agent-core/src/tools/propose-edit.ts`; `createWorkspaceTools` i dalje registruje isti tool.
2. JSON/fence parse helperi žive u `packages/agent-core/src/model/completion-parse.ts`; `deliverCompletion` ostaje u `local-inference.ts` i zove ih.
3. `ReviewCard` živi u `packages/extension/src/webview/ReviewCard.tsx`; CSS klase ostaju u `App.css`.
4. Javni izvozi (`runLocalChatCompletions`, `parseToolCallsFromContent`, `createWorkspaceTools`, `SYSTEM_PROMPT`, `toolsVisibleToModel`) ostaju na istim modulima ili se re-exportuju da postojeći importi ne pucaju.
5. `packages/agent-core` i dalje nema `import 'vscode'`.
6. Vitest u oba paketa prolazi 1:1 (isti broj testova, isti asserti). Nema Ollama / F5 zahteva.

---

## Zaključane odluke

- Pristup 2: higijena + rascep samo predugih produkcionih fajlova.
- Nema novih npm paketa. Vitest ostaje.
- `kind` grananje ostaje `if` / classify tabela, ne class hierarchy.
- `deliverCompletion` **ne** ide u `completion-parse.ts` (drži Mozaik `deliverFunctionCall` pored runnera).
- Testovi se ne cepaju. Jedini test-diff: `fakeEnv()` helper u `local-inference.test.ts` umesto ponovljenog `as unknown as AgenticEnvironment`.
- Imena fajlova: `propose-edit.ts`, `completion-parse.ts`, `ReviewCard.tsx` (PascalCase kao ostale webview komponente koje budu izdvojene; danas su već `App.tsx`, `markdown.tsx`).

---

## Van opsega

Biome, zod, lefthook, zamena Vitest-a, 8-linijske funkcije svuda, `chat-stream.ts` rascep, `editor-agent.ts` rascep, `reviewStore.ts`, `session.ts`, brisanje mrtvog koda van ova tri fajla, UI/CSS redesign.

---

## Wire

```
createWorkspaceTools
  read_file / list_dir / search / get_context  → tools.ts
  propose_edit.invoke                          → propose-edit.ts

runLocalChatCompletions
  HTTP + SSE + usage                           → local-inference.ts
  parseToolCallsFromContent + json helpers     → completion-parse.ts
  deliverCompletion                            → local-inference.ts
    native tool_calls → content JSON → fences  (redosled nepromenjen)

App
  composer / bubbles / ring                    → App.tsx
  ReviewCard                                   → ReviewCard.tsx
```

Prioritet tool poziva u `deliverCompletion` ostaje: native `tool_calls` → `parseToolCallsFromContent` → `parseSearchReplaceBlocks` kao `propose_edit`.

---

## Error handling

`propose-edit.ts` vraća iste stringove (`Error: … already exists`, `Search not found`, `mkdir cannot have file content`, …). Nema novih poruka.

HTTP / empty completion / token-limit poruke ostaju u `local-inference.ts`.

---

## Testovi

| Ponašanje | Očekivanje |
|---|---|
| Postojeći `tools.test.ts` propose_edit slučajevi | prolaze bez izmene asserta |
| Postojeći `local-inference.test.ts` fence/JSON/native | prolaze; import `parseToolCallsFromContent` i dalje iz `local-inference.js` (re-export) |
| `editor-agent.test.ts` / `chat-stream.test.ts` | nedirani ili samo re-export |
| `chatMessages.test.ts` | nediran (kartica i dalje isti DOM ugovor) |
| `fakeEnv()` | jedan helper; ponašanje stubova identično |

---

## Extra higijena (samo uz rascep)

- `ProposeEditBlock` / grouped-path tipovi u `propose-edit.ts` umesto dugih inline objekata.
- `ReviewCardProps` imenovan umesto inline `{ message, postMessage }`.
- Nema `any`. Nema `return await` (već nema).

---

## Rizici

- Re-export zaborav → test import puca. Mitigacija: `local-inference.ts` re-exportuje `parseToolCallsFromContent`.
- `syntheticCallCounter` ostaje u `local-inference.ts` pored `deliverCompletion`.
- Webview Vite include: novi `ReviewCard.tsx` u istom folderu, bez nove tsconfig putanje.
