# read_file ranges + newline-normalized SEARCH

**Datum:** 2026-08-30  
**Status:** odobren implementacijom (`implementiraj to`)  
**Ne pokriva:** apply-model, fuzzy function rewrite, embeddings

## Cilj

1. `read_file` može da vrati samo opseg linija (1-based, inclusive) — manji kontekst, lakši tačan SEARCH.
2. Matcher tretira `\r\n` i goli `\r` kao isti prelom kao `\n` pri line-window match-u. Sadržaj linija i dalje mora da se poklopi (trim/trimEnd ostaju). Nema pogodi-funkciju.

## Ponašanje

- `start_line` / `end_line` opciono. Samo path = ceo fajl (kao sad, 100k cap).
- Telo je sirovi slice iz fajla, **bez** `12|` prefiksa. Header: `[lines: a-b of N]` kad je opseg zadat; `[path: …]` kad je path razrešen.
- `start_line < 1`, `start > end`, ili `start` izvan fajla → `Error: …`. `end` preko EOF se seče do poslednje linije.
- `propose_edit.search` se i dalje kopira iz tog tela, ne iz headera.

## Van opsega

Cursor apply-model, auto-write na disk, semantički index.
