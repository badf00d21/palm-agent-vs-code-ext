# `@palm-agent/agent-core`

Mozaik petlja Palm Agenta: chat turn, tool-ovi, SEARCH/REPLACE matcher, lokalni Ollama runner.

Ovaj paket **nema** `import 'vscode'`. Editor (VS Code / kasnije fork) priča preko `WorkspacePort` i `ReviewHost`. Zato se `agent-core` seli netaknut kad agent izađe iz extension host-a (v5).

Javni ulaz je samo `@palm-agent/agent-core` (`src/index.ts`). Extension ne importuje unutrašnje foldere.

## Layout

```
src/
  index.ts                 javni exporti
  session/                 createAgentSession, startTurn preduslovi
  participants/            EditorAgent (inference + tool loop), UIBridge (bus → ExtToWebview)
  tools/                   Mozaik tool šeme, propose_edit, matcher, mergePending
  model/                   ModelConfig, Ollama Chat Completions, JSON tool-call parser
  workspace/               WorkspacePort tipovi, path escape
test/                      isti raspored foldera kao src/
```

Pravilo iz `AGENTS.md`: fakt o agentu/loop-u ostaje ovde; fakt o editoru ide u `packages/extension`; tip poruke u `packages/shared`.

## Kako je spojeno

1. Extension pravi `WorkspacePort` (fs, ripgrep, aktivni editor) i `ReviewHost` (pending review + `WorkspaceEdit`).
2. `createAgentSession(port, config, sink, reviewHost)` diže `AgenticEnvironment`, `EditorAgent` i `UIBridge`.
3. `startTurn` šalje user tekst na bus. Agent zove tool-ove; `propose_edit` samo predlaže (ne piše disk).
4. Lokalni model ide na Chat Completions (`OPENAI_BASE_URL`, default Ollama). Ime modela ne sme biti `gpt-*` / `o1`–`o9` / `text-*` — Mozaik bi to rutirao na Responses API.
5. Tool output ide modelu **sirov** — Mozaikov `executeFunctionCall` je namerno zaobiđen jer JSON.stringify-uje svaki output (model bi čitao kod kao escaped jedan red). Greške tool-ova (nepoznat tool, loš JSON u argumentima, throw iz invoke) vraćaju se modelu kao output tog poziva da se sam ispravi — ne obaraju turn.
6. Prozu koju model napiše uz native tool call UIBridge prosleđuje webview-u kao `assistant_delta` (SemanticEvent `assistant_narration`); u kontekst ne ulazi.

Default model: `gemma4:12b` (Ollama Chat Completions; pouzdan tool-format). Ollama context podesi po [docs/ollama-setup.md](../../docs/ollama-setup.md) — bez toga Ollama tiho seče prompt na 4096 tokena.

## Tool-ovi

| Tool | Uloga |
|---|---|
| `read_file` | UTF-8, cap 24k karaktera; preko toga `[truncated: continue with read_file start_line=N]` |
| `list_dir` | jedan nivo |
| `search` | sadržaj, cap 50 |
| `get_context` | aktivni fajl + selekcija |
| `propose_edit` | literalni SEARCH/REPLACE na postojećem fajlu; human Keep/Undo |

`search` u `propose_edit` je tačan substring iz `read_file`, ne regex i ne `{[^}]*}` wildcard.

`read_file` / `propose_edit` prihvataju i samo ime fajla (`abc-import.ts`) ako je jedinstveno. `read_file` može `start_line` / `end_line` (1-based); telo je sirovi slice, header `[lines: a-b of N]` se ne kopira u SEARCH. Ako SEARCH promaši, a u fajlu postoji jedna funkcija tog imena, tool vrati njen tačan tekst — ne primenjuje izmenu sam. Matcher izjednačava `\n` / `\r\n` / `\r`.

## Testovi

```bash
npx vitest run
```

iz ovog paketa, ili `pnpm --filter @palm-agent/agent-core test`. Testovi su u `test/`, isti raspored kao `src/`. Nema živog Ollama-a: fetch i port se stubuju.
