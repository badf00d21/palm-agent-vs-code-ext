# Collapsible review dock + status orb — design spec

**Datum:** 2026-09-06  
**Status:** odobren (chat)  
**Nastavlja:** review dock iznad chata (`dockedReviews` u webview-u)  
**Ne pokriva:** redesign `ReviewCard` / Keep·Undo·Review; theme-remap orb boja na VS Code vars; agent `get_context.selection`

---

## Cilj

Chat panel troši manje vertikalnog prostora na pending review, uklanja nekorišćeno **Add selection** dugme, i zamenjuje tri tačke waiting indikatora Uiverse orb-om koji ostaje i kad je agent idle (bez promene boje).

**Gotovo je kad važi sve ovo:**

1. Dok ima pending review-a, summary red je uvek vidljiv (`N review(s) · M file(s)`); kartice se sklapaju/otvaraju jednim toggle-om.
2. Prvi pending u sesiji otvara dock; posle toga pamti poslednje expanded/collapsed dok ima pending; nestanak pending + sledeći pending opet počinje expanded.
3. Orb je uvek na dnu transcripta; idle = lava bez `colorize`; busy = `colorize` + postojeći waiting tekst.
4. **Add selection** dugme i `get_selection` / `selection` poruke više nisu u webview ↔ ext protokolu za taj flow.
5. Unit testovi za summary label prolaze.

---

## Zaključane odluke (brainstorm)

| Tema | Izbor |
|---|---|
| Orb pozicija | B — samo u transcriptu (dno) |
| Dock default | C — prvi pending expanded, zatim pamti stanje |
| Summary count | C — reviews **i** files |
| Pristup | 1 — `StatusOrb` + collapsible dock u `App.tsx` |

---

## Arhitektura

Sve u `packages/extension/src/webview` (+ tanko čišćenje `shared` / `chatViewProvider`). Bez izmena `agent-core`.

```
┌ review-dock ─────────────────┐
│ [ReviewCard…]   ← ako expanded│
│ N reviews · M files   ▾/▴     │  ← uvek kad ima pending
├──────────────────────────────┤
│ transcript…                   │
│                    (StatusOrb)│  ← uvek na dnu .messages
├ composer ────────────────────┤
│ New chat · Send/Stop          │  ← bez Add selection
└──────────────────────────────┘
```

| Deo | Gde |
|---|---|
| Collapse + summary UI | `App.tsx` + `App.css` |
| Summary label helper | `chatMessages.ts` → `reviewDockSummary` |
| Orb | `StatusOrb.tsx` + CSS (Uiverse MIT, klasa `.status-orb`) |
| Waiting | zameniti `.waiting-dots` orb-om + postojeći tekst |
| Remove Add selection | `App.tsx`, `chatViewProvider.ts`, `shared` tipovi |

---

## Ponašanje

### Review dock

- Vidljiv samo dok `dockedReviews(messages)` nije prazan.
- Summary bar uvek ispod body-ja: label iz `reviewDockSummary`, klik/toggle, `aria-expanded`, chevron.
- **Prvi** put u sesiji kad `reviews.length` pređe 0 → `expanded = true`.
- Dok `reviews.length > 0`, ručni toggle ostaje.
- Kad `reviews.length` padne na 0, zaboravi preference; sledeći pending opet expanded.
- Mid-turn rast broja fajlova/kartica **ne** forsira expand.
- `New chat` (`session_cleared`) prazni poruke → dock nestaje (isti reset).

Label pravila:

- `1 review · 1 file`
- `2 reviews · 5 files`
- engleski, en-dash `·` kao separator

### Status orb

- Uvek renderovan na dnu `.messages` (i kad je transcript prazan).
- Prop `busy`: isti uslov kao današnji waiting red  
  `busy && lastLine?.role !== "assistant" && !awaitingAnswer && !researchInFlight`.
- **Idle (`busy=false`):** SVG lava / rotation / roundness rade; **nema** `animation: colorize` (boja fiksna).
- **Busy:** doda klasu `is-busy` → uključi `colorize`; pored orb-a isti tekst kao sada (`Waiting for reply` / `Loading model / thinking… Ns`).
- Skala: `--size: 0.22` (~22px vizuelno na 100px bazi).
- Unique SVG `mask` `id` (npr. `status-orb-clip`) da ne sudara druge maske.
- `prefers-reduced-motion: reduce`: ugasi rotation/roundness/colorize; busy i dalje pokazuje orb + tekst.

Izvor animacije: [uiverse.io/andrew-manzyk/young-walrus-64](https://uiverse.io/andrew-manzyk/young-walrus-64) (MIT). Attribution u kratkom CSS komentaru.

### Add selection

- Ukloni dugme iz composera.
- Ukloni webview handler za `msg.type === "selection"` i hint `"No selection"`.
- Ukloni `case "get_selection"` u `chatViewProvider.ts`.
- Ukloni `{ type: "get_selection" }` i `{ type: "selection"; text }` iz `packages/shared`.
- **Ostaje:** `WorkspacePort.getContext().selection` za agent tool `get_context` — nije deo ovog dugmeta.

---

## Komponente

### `reviewDockSummary(reviews: ReviewLine[])`

```ts
{ reviewCount: number; fileCount: number; label: string }
```

`fileCount` = suma `review.files.length` preko svih docked pending kartica. Prazan niz → nule i `label: ""`.

### `StatusOrb({ busy: boolean })`

Markup ekvivalent Uiverse HTML-a (loader → `status-orb`, mask id unique). CSS u `App.css` pod `.status-orb` / `.status-orb.is-busy`.

### `App.tsx` dock

```tsx
{reviews.length > 0 ? (
  <div className="review-dock">
    {expanded ? <div className="review-dock-body">…cards…</div> : null}
    <button type="button" className="review-dock-summary" aria-expanded={expanded}>
      {label} …
    </button>
  </div>
) : null}
```

`expanded` state + efekat: na prelaz `0 → >0` setuj `true`; ne diraj dok je `>0`.

---

## Testovi

`chatMessages.test.ts`:

- jedan review, jedan file → `1 review · 1 file`
- dva review-a, pet fajlova → `2 reviews · 5 files`
- prazan → `reviewCount/fileCount` 0, `label` `""`

Nema React component snapshot testova za orb (CSS-only vizuel).

---

## Van opsega

- Per-card collapse (već postoji file list toggle u `ReviewCard`)
- Persist expanded u `localStorage` / workspace state (samo in-memory sesija webview-a)
- Remap orange orb na `--vscode-*` boje
- Izmene Keep All / Undo All / Review flow
