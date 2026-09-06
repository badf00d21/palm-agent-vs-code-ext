# Flat transcript + unified button system — design spec

**Datum:** 2026-09-06
**Status:** implementirano
**Nastavlja:** `docs/superpowers/specs/2026-08-30-v3-streaming-context-ux-design.md` (tool_call redovi, `AssistantMarkdown`, composer @-suggest)
**Ne pokriva:** collapsible review dock i `StatusOrb` — vidi `docs/superpowers/specs/2026-09-06-review-dock-status-orb-design.md`; remap orb boja na `--vscode-*`; `get_context.selection`

---

## Cilj

Transcript više ne crta svaku poruku kao obojen bubble. Hijerarhija dolazi iz vertikalnog ritma, tipografske težine i boje, ne iz kutija. Dugmad su bila razbacana po šest skoro-identičnih selektora — svaka kopija je referencirala drugi podskup `--vscode-*` tokena, pa je theme sync driftovao iz kartice u karticu. Ovaj ciklus to svodi na jedan `.btn` sistem.

**Gotovo je kad važi sve ovo:**

1. Poruke u transkriptu su `<article class="msg msg-{role}">` bez pozadine, ivice ili `border-radius` na kontejneru poruke.
2. Uklonjen je uppercase `.role` label; pristupačna informacija je sačuvana kao `aria-label` na `<article>`, izvedena iz `roleLabel()`.
3. Marker glyph tool reda (`⏺`) je pravi `aria-hidden="true"` `<span>`, ne CSS `content`.
4. `ReviewCard`, `QuestionCard`, `ResearchCard` više ne koriste `editorWidget-background` fill; zadržavaju samo ivicu/rule kao affordance za interaktivni widget.
5. Šest dupliranih button selektora (`.review-actions button`, `.review-head button`, `.question-options button`, `.question-form button`, `.composer button`, `.research-digest-toggle`) je zamenjeno sa `.btn` + `.btn-primary` / `.btn-secondary` / `.btn-ghost`, sa jednim `:focus-visible` pravilom.
6. Nijedna boja u izmenjenim pravilima nije hardkodovana — sve su `--vscode-*` tokeni, sa `--vscode-contrastBorder` prvim u fallback lancu za ivice.
7. Postoji `@media (forced-colors: active)` blok koji vraća realne ivice/`forced-color-adjust: none` tamo gde flat dizajn inače zavisi od fill-a.
8. `prefers-reduced-motion: reduce` i dalje gasi/smiruje animacije koje su ostale (`tool-pulse`, `research-pulse`).

---

## Zaključane odluke (posmatrano u kodu)

| Tema | Izbor |
|---|---|
| Kontejner poruke | Bez fill/border/radius; hijerarhija iz spacing-a i tipografije |
| Razmak između poruka | `.messages { gap: 18px }`, razmak *unutar* jedne poruke ostaje tesan |
| Role label | Uklonjen vizuelno; premešten u `aria-label` (`roleLabel()`), ne izbrisan |
| Tool marker | Pravi `<span aria-hidden>` element, ne `::before { content }` |
| Kartice (Review/Question/Research) | Zadržavaju rule/border affordance, gube pozadinu |
| Dugmad | Jedan `.btn` sistem sa tri varijante umesto šest dupliranih selektora |
| Ivice | `--vscode-contrastBorder` prvi u fallback lancu (forsira pravu ivicu u high-contrast temama) |
| High contrast | Poseban `forced-colors: active` blok vraća prave ivice/pozadine gde flat dizajn zavisi od suptilnog fill-a |

---

## Arhitektura

Sve izmene su u `packages/extension/src/webview` — CSS u `App.css`, markup u `App.tsx`, `ReviewCard.tsx`, `QuestionCard.tsx`, `ResearchCard.tsx`. `chatMessages.ts` (parsing/state) nije diran ovim ciklusom.

```
.messages (gap: 18px, flex column)
 ├─ <article class="msg msg-user" aria-label="You">        ← border-left rule
 ├─ <article class="msg msg-assistant" aria-label="Agent">  ← bez ikakvog chrome-a
 ├─ <article class="msg msg-tool is-running" aria-label="Tool">
 │     <p class="tool-line">
 │       <span class="tool-marker" aria-hidden="true">⏺</span>
 │       <span>read_file  src/foo.ts</span>
 │     </p>
 ├─ <article class="msg msg-status" aria-label="Status">
 ├─ <article class="msg msg-question" aria-label="Question">  ← border-left rule, QuestionCard unutra
 └─ <article class="msg msg-research msg-research-{status}" aria-label="Research">  ← border-left rule, ResearchCard unutra

review-dock (van .messages, vidi drugi spec)
 └─ <article class="msg msg-review" aria-label="Review">   ← puna 1px ivica, veći affordance
       ReviewCard unutra (btn-primary Keep All / btn-secondary Undo All / btn-ghost Review)
```

| Deo | Gde |
|---|---|
| Poruka bez chrome-a, per-role treatment | `App.css` (`.msg`, `.msg-user`, `.msg-assistant`, `.msg-tool`, `.msg-status`) |
| `aria-label` po roli | `App.tsx` → `roleLabel()`, primenjen na `<article>` |
| Tool marker glyph | `App.tsx` (`<span className="tool-marker" aria-hidden="true">⏺</span>`) |
| Kartice bez fill-a | `App.css` (`.msg-review`, `.msg-question`, `.msg-research`) |
| Dugme sistem | `App.css` (`.btn`, `.btn-primary`, `.btn-secondary`, `.btn-ghost`) |
| Primena dugmadi | `App.tsx`, `ReviewCard.tsx`, `QuestionCard.tsx`, `ResearchCard.tsx` |
| High contrast | `App.css` → `@media (forced-colors: active)` |

---

## Ponašanje

### Transcript bez bubble-ova

`.messages` je flex kolona sa `gap: 18px` između poruka (komentar u CSS-u: "Generous space between turns is what reads as structure once the message boxes are gone; keep spacing *within* a turn tight instead."). `.msg` sam po sebi nema pozadinu, ivicu ni radius — to je ostavljeno per-role pravilima ispod.

### Per-role tretman

- **`.msg-user`** — `border-left: 2px solid var(--vscode-contrastBorder, var(--vscode-focusBorder))` + `padding-left: 12px`. Ovo je jedina "kotva" na koju čitalac skenira unazad ("gde sam ja nešto pitao"), pa dobija tihi levi rule umesto ispunjenog bubble-a.
- **`.msg-assistant`** — `padding: 0`, bez ivice, bez markera, bez labela. Namerno nedekorisano: odsustvo chrome-a JE glas asistenta. Greška se i dalje razlikuje bojom (`.msg-assistant.is-error p { color: var(--vscode-errorForeground) }`), ne okvirom.
- **`.msg-tool`** — jedan kompaktan, monospace, zatamnjen red: `color: var(--vscode-descriptionForeground)`, `font-family: var(--vscode-editor-font-family)`, `font-size: 12px`. `.tool-line` je flex baseline sa `gap: 6px` između marker glyph-a i teksta. `.msg-tool.is-running` dobija `animation: tool-pulse 1.6s ease-in-out infinite` (opacity 0.55 ↔ 0.9); `prefers-reduced-motion: reduce` gasi animaciju i fiksira `opacity: 0.7`.
- **`.msg-status`** — `color: var(--vscode-descriptionForeground)`, `font-size: 12px`, bez ikakvog okvira.
- Greška u assistant redu (`isPlainErrorText`) dobija klasu `is-error` na `<article>`, koja boji samo tekst (`var(--vscode-errorForeground)`), ne dodaje pozadinu.

### Role chip uklonjen, ne pristupačnost izgubljena

Uppercase `.role` label koji je nekad stajao na svakoj poruci je uklonjen iz vizuelnog prikaza. Ta informacija nije izbrisana — premeštena je u `aria-label` na `<article>`, generisan istom `roleLabel()` funkcijom (`App.tsx`, mapira `role` → `"You" | "Tool" | "Review" | "Status" | "Question" | "Research" | "Agent"`). Ovo je namerna a11y odluka: screen reader i dalje najavljuje ulogu poruke, samo vizuelno više nema chip-a koji zauzima prostor i vizuelnu težinu. Waiting red iz `messages-status` istim putem dobija `aria-label="Agent"` + `aria-live="polite"` + `aria-busy="true"`.

Marker glyph tool reda (`⏺`) je pravi `<span aria-hidden="true">⏺</span>` element u markup-u, ne CSS `::before { content: "⏺" }`. Razlog: `aria-hidden` na pravom elementu garantuje da screen reader ne pokuša da pročita glyph kao reč ili emoji; CSS-generisan `content` na pseudo-elementu ume da procuri u accessibility tree u zavisnosti od browser/AT kombinacije, a ovde je namera da glyph bude čisto vizuelni marker dok tekst posle njega nosi sadržaj.

### Kartice zadržavaju affordance, gube fill

`ReviewCard`, `QuestionCard`, `ResearchCard` su i dalje interaktivni widgeti (nešto se klika, popunjava ili gate-uje), pa ne mogu potpuno da nestanu u flat transcript — ali su izgubile `editorWidget-background` popunu koju su ranije imale.

- **`.msg-question`** i **`.msg-research`** — `border-left: 2px solid ...` (isti stil kao `.msg-user`, samo drugi fallback lanac za research: `var(--vscode-contrastBorder, var(--vscode-panel-border, var(--vscode-widget-border, transparent)))`). Research dodatno menja `border-left-color` po statusu: `msg-research-failed` → `--vscode-errorForeground`, `msg-research-cancelled` → `--vscode-contrastBorder, var(--vscode-descriptionForeground)`, `msg-research-done` → `--vscode-terminal-ansiGreen, var(--vscode-focusBorder)`.
- **`.msg-review`** — jedina kartica sa **punom** ivicom sa sve četiri strane (`border: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border, var(--vscode-widget-border, transparent)))`, `border-radius: 4px`, `padding: 10px 12px`), ne samo levi rule. Review dobija više vizuelne prisutnosti od Question/Research jer gate-uje pravu, nepovratnu akciju — Keep All / Undo All primenjuje ili odbacuje stvarne izmene fajlova (uključujući delete, obeležen `review-kind-delete` u errorForeground bojom), dok Question i Research samo prikupljaju odgovor ili prikazuju napredak. Veća prisutnost je namerna: korisnik ne sme da prokrklja pending review kao još jedan pasivan red teksta.

### Button sistem

Ranije je button CSS bio dupliran u ~6 selektora (`.review-actions button`, `.review-head button`, `.question-options button`, `.question-form button`, `.composer button`, `.research-digest-toggle`), svaki sa svojim podskupom `--vscode-*` tokena — otud drift kad bi se tema menjala. Sveden je na `.btn` bazu + tri varijante:

| Klasa | Mapiranje tokena |
|---|---|
| `.btn` (baza) | `background: transparent`, `color: var(--vscode-foreground)`, `border: none`, `border-radius: 4px`, `padding: 6px 12px` |
| `.btn-primary` | `background: var(--vscode-button-background)`, `color: var(--vscode-button-foreground)`; hover → `var(--vscode-button-hoverBackground)` |
| `.btn-secondary` | `background: var(--vscode-button-secondaryBackground)`, `color: var(--vscode-button-secondaryForeground)`; hover → `var(--vscode-button-secondaryHoverBackground)` |
| `.btn-ghost` | `background: none`, `color: var(--vscode-textLink-foreground)`, `padding: 2px 0`; hover → `var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground))` + underline |

Zajedničko za sve: `.btn:disabled { opacity: 0.5; cursor: default }` i jedan `.btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px }` umesto po-komponentnog fokus stila.

Primena varijante po dugmetu (stvarno stanje u kodu):

- **Composer** (`App.tsx`) — `New chat` → `btn btn-secondary`; `Send` / `Stop` → `btn btn-primary`; `Cloud session ↗` → `btn btn-ghost cloud-session-link`.
- **ReviewCard** — file-toggle disclosure → `btn btn-ghost review-toggle`; svaki file red (kad je pending i klikabilan za `open_diff`) → `btn btn-ghost` + `review-file`/`review-file-delete`; `Undo All` → `btn btn-secondary`; `Keep All` → `btn btn-primary`; `Review` → `btn btn-ghost`.
- **QuestionCard** — svaka opcija → `btn btn-secondary`; `Answer` submit → `btn btn-primary`.
- **ResearchCard** — `Show digest` / `Hide digest` → `btn btn-ghost research-digest-toggle`.

`.review-toggle` je jedini per-mesto override posle unifikacije: nasleđuje flat izgled `.btn-ghost`, ali prepisuje `color: var(--vscode-foreground)` jer je to disclosure kontrola (otvara/zatvara listu fajlova), ne navigacioni link, pa ne treba da liči na hyperlink.

### Fallback lanac za ivice

Većina ivica u izmenjenim pravilima (`.review-dock`, `.msg-review`, `.msg-research`, `pre` u assistant markdown-u, `.suggest`, `.research-digest`) koristi lanac:

```
var(--vscode-contrastBorder, var(--vscode-panel-border, var(--vscode-widget-border, transparent)))
```

Redosled nije proizvoljan: `--vscode-contrastBorder` je definisan **samo** u high-contrast temama — kad postoji, mora da pobedi, jer forced/high-contrast korisnik zavisi baš od te ivice da vidi granicu. `--vscode-panel-border` je sledeći jer je to stabilan, široko definisan token u većini standardnih tema. `--vscode-widget-border` je generičniji poslednji izbor za teme koje panel-border ne definišu. Krajnji `transparent` sprečava da neobeležena tema dobije default browser ivicu.

Napomena: `.composer` border-top koristi drugačiji redosled (`contrastBorder, widget-border, panel-border`) — ostatak lanca u fajlu je konzistentan, composer je jedino mesto gde se widget-border i panel-border zamenili mestima; nije menjano ovim ciklusom pa je zabeleženo kao zatečeno stanje, ne kao namerna odluka.

### High contrast (`forced-colors: active`)

Flat dizajn se u normalnom režimu oslanja na suptilne fill-ove (hover pozadine, status tačkice) da prenese strukturu. Pod `forced-colors: active` browser fill boje pretvara u providne/sistemske, pa suptilni fill jednostavno nestane — struktura mora doći od stvarnih ivica. Blok:

- `.btn { border: 1px solid ButtonText }` — svako dugme dobija realnu ivicu, jer pozadina (transparent/button-background) više nije pouzdan signal.
- `.btn-ghost { border-color: transparent; text-decoration: underline }` — ghost dugme namerno ostaje bez ivice (nije "pravo" dugme vizuelno), ali dobija underline da se i dalje razlikuje kao klikabilno.
- `.msg-user, .msg-question { border-left-color: Highlight }` i `.msg-review, .msg-research { border-color: CanvasText }` — sistemske boje umesto `--vscode-*` tokena, jer u forced-colors režimu autor boje i nisu garantovano poštovane.
- `.research-status-dot { forced-color-adjust: none; border: 1px solid CanvasText }` — status tačkica je **čisti fill** (nema border u normalnom režimu), pa bi bez ovoga potpuno nestala pod forced-colors (fill postaje providan/sistemski, krug bez ivice = ništa vidljivo). `forced-color-adjust: none` isključuje browser-ovo forsiranje sistemskih boja baš na ovom elementu da bi border ostao vidljiv.
- `.tool-locations button:hover`, `.research-worker-head:hover:not(:disabled)`, `.suggest button:hover`, `.suggest button[aria-selected="true"]` — hover/selected pozadina (`--vscode-list-hoverBackground`) je isto tako fill-only signal koji bi nestao; `forced-color-adjust: none` + eksplicitno `background: Highlight; color: HighlightText` ga vraća sistemskim ekvivalentom.

**Ovo je neverifikovano**: gornji blok je rezonovan iz specifikacije `forced-colors` medija i poznatih sistemskih boja (`Highlight`, `HighlightText`, `ButtonText`, `CanvasText`), ali nikad nije stvarno renderovan u pravoj Windows High Contrast temi. Vidi `## Van opsega`.

### Reduced motion

`prefers-reduced-motion: reduce` gasi `tool-pulse` (`.msg-tool.is-running`, fiksira `opacity: 0.7`) i `research-pulse` (`.research-status-running`, fiksira `opacity: 1`, `transform: scale(1)`). Status orb animacije se gase istim media query-jem, ali su predmet drugog spec-a.

---

## Komponente

Nema novih komponenti/funkcija ovim ciklusom — sve izmene su markup + CSS unutar postojećih fajlova (`App.tsx`, `ReviewCard.tsx`, `QuestionCard.tsx`, `ResearchCard.tsx`, `App.css`). `chatMessages.ts` (state/parsing) nije diran.

`roleLabel(role: ChatLine["role"]): string` (`App.tsx`) — postojala je i pre ovog ciklusa za druge svrhe; sada je jedini izvor a11y imena uloge na `<article aria-label>`, pošto vizuelni `.role` chip više ne postoji.

---

## Testovi

`App.layout.test.ts` trenutno pokriva samo review-dock layout i status-orb skaliranje (deo `2026-09-06-review-dock-status-orb-design.md`). Za flat-transcript / button-sistem izmene iz ovog spec-a **nema posebnih CSS-regex testova** u trenutnom stanju repoa — ovo je gap, ne tvrdnja da testovi postoje. Ako se dodaju, prirodno mesto je isti `App.layout.test.ts` obrazac (regex nad `App.css` pravilima), npr.:

- `.msg` nema `background` / `border` / `border-radius` deklaraciju.
- `.btn-primary` referencira `--vscode-button-background`, `.btn-secondary` `--vscode-button-secondaryBackground`.
- `App.tsx` sadrži `aria-label={roleLabel(message.role)}` na `<article>`.
- Tool marker je `<span ... aria-hidden="true">⏺</span>`, ne CSS selector sa `content:`.

---

## Van opsega

- Collapsible review dock i `StatusOrb` (`.review-dock-summary`, `.status-orb`, waiting UI) — sopstveni spec: `docs/superpowers/specs/2026-09-06-review-dock-status-orb-design.md`. Taj rad je isti dan zamenio stari `.waiting-dots` waiting indikator; nije deo ovog spec-a.
- Remap orb boja na `--vscode-*` tokene.
- `WorkspacePort.getContext().selection` / `get_context` protokol.
- Stvarna verifikacija high-contrast bloka u pravoj Windows High Contrast temi (rezonovano iz specifikacije, nikad vizuelno provereno — vidi odeljak Ponašanje → High contrast).
- Ujednačavanje `.composer` border fallback redosleda sa ostatkom fajla.
- Novi automatizovani testovi za flat-transcript CSS pravila (trenutno pokriveno samo ručnim pregledom).
