# Context usage + markdown chat — design spec

**Datum:** 2026-08-30  
**Status:** predlog — čeka review  
**Nastavlja:** v3 chat UX (sidebar composer, `assistant_delta`)  
**Ne pokriva:** syntax highlight, tabele, clear-context, boja na 90%, model picker, advertised `/api/show` window, char-count estimate

---

## Cilj

Čovek vidi koliko je učitani Ollama prozor pun (kao Cursorov prsten) i čita Agent odgovore kao markdown, ne kao sirovi `**bold**`.

**Gotovo je kad važi sve ovo:**

1. Posle inference koraka webview dobija `{ type: "context_usage", used, max }`. Prsten u composeru; hover `4.2k / 16k`.
2. `used` je `usage.total_tokens` sa Chat Completions (`stream_options.include_usage: true`).
3. `max` je `context_length` učitanog modela sa nativnog `/api/ps` (ne advertised `/api/show`).
4. Agent bubble renderuje GFM (naslovi, bold/italic, liste, linkovi, fenced/inline code) bez syntax highlight-a i bez HTML-a.
5. User / tool / review / `Error: …` ostaju plain text.
6. `agent-core` i dalje nema `import 'vscode'` i ne zove Ollama `/api/*`.
7. Testovi ispod prolaze bez živog Ollama-a i bez VS Code UI-ja.

---

## Zaključane odluke

- Signal je podeljen: core čita OpenAI `usage`; extension čita `/api/ps` i dopunjuje `max`.
- Semantic event u core-u: `context_usage` (isti string kao `NARRATION_EVENT` obrazac), payload `{ used: number }`.
- `used = total_tokens` (prompt + completion tog koraka) posle svakog inference koraka, uključujući tool-call korake.
- Jedan event ka webview-u: `{ type: "context_usage", used: number, max: number | null }`. Core emituje samo `used`; `sessionHost` doda `max`.
- Linkovi u markdownu: samo `http`, `https`, `mailto`. Ostalo se ne otvara.
- `/api/ps` URL: sa `palmAgent.ollamaBaseUrl` skini trailing `/v1` (npr. `http://localhost:11434/v1` → `http://localhost:11434/api/ps`).
- Match u `models[]` po `palmAgent.model`. Polje je `context_length` tog zapisa.
- Keš `max` po imenu modela. Prvi fetch posle prvog usage-a (model je tad u VRAM-u). Ponovo samo ako se model u settings promeni, ili ako je keš prazan i stigne novi usage.
- Nema `usage` → nema eventa. Prsten ostaje sakriven. Chat radi kao sad.
- `/api/ps` fail / prazna lista / model nije u listi / nema `context_length` → `max: null`. Tooltip samo `4.2k`. Prsten 0% (ne lažemo procenat). Jedan pokušaj, nema retry petlje.
- `used > max` → prsten 100%, tooltip i dalje tačne brojke.
- Prsten: ~14px SVG u `composer-actions`, levo od dugmadi. Staza `--vscode-widget-border`, popuna `--vscode-progressBar-background`. Brojke samo u `title`. Skriven dok ne stigne prvi `context_usage`. Nema click, nema header bar, nema hex.
- Markdown samo u Agent bubble-u: `react-markdown` + `remark-gfm`. Bez `rehype-raw`. Code: editor font, host editor/widget tokeni, bez highlight-a.
- Link click → `vscode.env.openExternal` (webview postMessage). Fail je tih.
- Streaming: svaki `assistant_delta` re-renderuje markdown. Polu-napisan fence sme kratko da izgleda čudno.
- Ako renderer baci: fallback na plain text za taj bubble.
- `applyExtMessage` ignoriše `context_usage` — nije chat linija.

---

## Van opsega

Syntax highlight, tabele, task list stil, HTML u odgovoru, markdown za user/tool/review, clear/compact context, pragovi boje, model picker, `/api/show` advertised window, ručni `palmAgent.numCtx`, procena iz karaktera.

---

## Wire

```
Ollama /v1/chat/completions + stream_options.include_usage
        → poslednji SSE chunk { choices: [], usage: { total_tokens } }
        → agent-core semantic event { used }
        → UIBridge { type: "context_usage", used }
        → sessionHost + /api/ps context_length
        → webview { type: "context_usage", used, max }
        → composer prsten
```

Markdown ne ide kroz protokol. Webview i dalje prima `assistant_delta` stringove.

---

## Testovi (obavezni)

| Ponašanje | Očekivanje |
|---|---|
| SSE chunk prazan `choices` + `usage.total_tokens: 4200` | assembly `used = 4200`; event emitovan |
| Request body | `stream_options.include_usage === true` |
| Nema `usage` u streamu | nema `context_usage`; turn i dalje `done` |
| UIBridge | `{ type: "context_usage", used }`; nije bubble |
| Base `…/v1` + model u `/api/ps` sa `context_length: 16384` | webview event `max: 16384` |
| `/api/ps` fail / prazno / nema modela | `max: null` |
| Drugi usage, isti model | `/api/ps` se ne zove ponovo |
| `applyExtMessage` + `context_usage` | poruke nepromenjene |
| Tooltip helper `4210, 16384` | `4.2k / 16k` |
| Tooltip helper `4210, null` | `4.2k` |
| GFM renderer: `**x**` + fence | bold + code block |
| Tekst `Error: boom` | plain, ne markdown |

---

## Rizici

- Stari Ollama bez `include_usage`: prsten se ne pojavi — prihvaćeno, chat ostaje.
- `/api/ps` `context_length` ime polja zavisi od verzije Ollama-a; ako fali, `max: null`.
- Keš zastari ako korisnik promeni `num_ctx` u Modelfile bez promene imena modela — prihvaćeno (osvežava se tek na promenu imena ili prazan keš).
- `openExternal` za `javascript:` / nenačinjene sheme: samo `http(s)` i `mailto`.
