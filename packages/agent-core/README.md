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

Default model: `deepseek-v4-pro` (Ollama alias za lokalni qwen coder, da ime bude Mozaik-legalno).

## Tool-ovi

| Tool | Uloga |
|---|---|
| `read_file` | UTF-8, cap 100k |
| `list_dir` | jedan nivo |
| `search` | sadržaj, cap 50 |
| `get_context` | aktivni fajl + selekcija |
| `propose_edit` | literalni SEARCH/REPLACE na postojećem fajlu; human Keep/Undo |

`search` u `propose_edit` je tačan substring iz `read_file`, ne regex i ne `{[^}]*}` wildcard.

`read_file` / `propose_edit` prihvataju i samo ime fajla (`abc-import.ts`) ako je jedinstveno u workspace-u. Ako SEARCH promaši, a u fajlu postoji jedna funkcija tog imena, tool vrati njen tačan tekst da model kopira — ne primenjuje izmenu sam.

## Testovi

```bash
npx vitest run
```

iz ovog paketa, ili `pnpm --filter @palm-agent/agent-core test`. Testovi su u `test/`, isti raspored kao `src/`. Nema živog Ollama-a: fetch i port se stubuju.
