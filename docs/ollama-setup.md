# Ollama setup za Palm Agent

Hardver: RTX 4070 Ti 12GB VRAM + ~100GB RAM. Ollama servira lokalni model preko Chat Completions (`http://localhost:11434/v1`); ime modela ide u zahtev kao-jeste (`palmAgent.model`, default `gemma4:12b`).

## Zašto je context length kritičan

Ollama default context je **4096 tokena**. Kad prompt pređe to, Ollama **tiho seče od vrha** — prvi ispadaju system prompt i tool šeme, i model počne da "ludi": roleplay, ignoriše `propose_edit`, odgovara bez tool-ova. Naš system prompt + tool šeme su ~1k tokena, jedan `read_file` je do 24k karaktera (~6k tokena), pa realan turn probije 4k već posle prvog čitanja.

**Minimum za rad: 16384 po slotu.** Nikad ne ostavljaj default.

Napomena: preko OpenAI-kompatibilnog `/v1` endpointa `num_ctx` NE može da se pošalje po zahtevu — mora na serveru (env) ili u modelu (Modelfile).

## ZAMKA: `OLLAMA_CONTEXT_LENGTH` se DELI po paralelnim slotovima

Ollama pravi `OLLAMA_NUM_PARALLEL` slotova (ume i sam da izabere 4) i **ukupni context deli na njih**: `CONTEXT_LENGTH=16384` + 4 slota = **4096 po zahtevu** — nazad na default trap. U ollama logu to vidiš kao `n_ctx_slot = 4096` i četiri `slot get_availabl: id 0..3` linije.

Za interaktivnog agenta hoćeš **jedan veliki slot**: `OLLAMA_NUM_PARALLEL: 1`. (Palm Agent ionako šalje jedan zahtev u letu; paralelizam na 12GB samo seče context.)

## Docker compose (naš setup)

```yaml
environment:
  OLLAMA_CONTEXT_LENGTH: 16384
  OLLAMA_NUM_PARALLEL: 1        # bez ovoga se context deli po slotovima!
  OLLAMA_FLASH_ATTENTION: 1
  OLLAMA_KV_CACHE_TYPE: q8_0
  OLLAMA_KEEP_ALIVE: "-1"
```

pa `docker compose up -d --force-recreate ollama`. Flash attention + KV q8_0 ≈ upola manji KV cache — razlika između "16k staje" i "16k ne staje" na 12GB.

**Provera posle restarta** — u ollama logu pri prvom zahtevu mora da piše `n_ctx_slot = 16384`; ili `ollama ps` posle prvog zahteva.

**Eviction upozorenje:** na 12GB stane jedan model. Ako open-webui (ili bilo šta drugo) povuče drugi model (chat, title-generation…), gemma se izbaci iz VRAM-a i sledeći Palm turn opet plaća hladno učitavanje (~50s na 14B klasi). Ako turn-ovi stalno traju ~50s umesto par sekundi — ovo je razlog. `OLLAMA_KEEP_ALIVE: "-1"` čuva model od idle eviction-a, ali ne od istiskivanja drugim modelom.

(Ako nekad pokrećeš Windows Ollama app umesto kontejnera: iste promenljive preko `setx` + restart aplikacije.)

## Finije: num_ctx po modelu (Modelfile varijanta)

Kad hoćeš različit context po modelu (npr. 16k za dense u VRAM-u, 32k za MoE hibrid):

```bash
printf 'FROM gemma4:12b\nPARAMETER num_ctx 16384\n' > palm-gemma.Modelfile; ollama create palm-gemma4 -f palm-gemma.Modelfile
```

pa u VS Code settings postavi `palmAgent.model: palm-gemma4` (**reload window** — config se čita pri startu ekstenzije).

## VRAM budžet (12GB)

- Dense modeli (`gemma4:12b`, `qwen2.5-coder:14b` Q4 ≈ 8–9GB): + 16k ctx KV (q8_0) ≈ 1.5–2GB → staje. 32k je tesno — ostani na 16k.
- MoE modeli: GPU drži attention + KV, eksperti idu u RAM — zato veći `num_ctx` postaje izvodljiv i pored 12GB.

## Kandidati za probe modela (stanje avgust 2026)

| Slot | Model | context | Napomena |
|---|---|---|---|
| interaktivni default | `qwen3.6:35b-a3b` | 32768 | MoE 35B / 3B aktivnih, agentic-tuned (SWE-bench V 73.4); Q4 ~20GB → hibridno GPU+RAM |
| brzi / pouzdan format | `gemma4:12b` | 16384 | ceo u VRAM, pouzdan tool format (trenutni default) |
| heavy (plan/review, kasnije) | Qwen3.5-122B-A10B kvant | 32768 | ~70GB u RAM; spor, ali za jedan plan-korak po zadatku |

Zamena modela = promeni `palmAgent.model` u settings + reload window. Pri poređenju kandidata drži isti context i isti zadatak (npr. "preimenuj funkciju X u fajlu Y" + jedan multi-file refactor).
