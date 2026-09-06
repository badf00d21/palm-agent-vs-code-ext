# Mozaik Cloud session link — design spec

**Datum:** 2026-09-06
**Status:** implementirano
**Nastavlja:** `attachCloud` u `packages/agent-core/src/runtime/cloud.ts` (postojeći `CloudExporter` wiring), `open_url` protokol poruku iz webview ↔ ext
**Ne pokriva:** prikaz cloud statusa (connected/error) u UI-ju, retry/reconnect indikator, bilo šta oko `cloud-sdk` exporter internals

---

## Cilj

Mozaik Cloud session URL, koji je ranije završavao samo u Output-channel trace-u (niko ga ne vidi), postaje vidljiv u chat UI-ju kao dokaz da agent radi na Mozaik bus-u.

**Gotovo je kad važi sve ovo:**

1. Kad je `MOZAIK_API_KEY` postavljen, `cloud_session` event sa URL-om se pojavi kao `.btn-ghost` dugme u composer action redu ("Cloud session ↗"), ne kao chat poruka.
2. Klik na dugme otvara URL kroz postojeći `open_url` protokol (`vscode.env.openExternal`), bez novog message tipa.
3. New chat (`session_cleared`) sinhrono briše prikazani URL pre nego što nova sesija stigne do svog `cloud_session`-a, tako da se nikad ne vidi stara veza.
4. Bez `MOZAIK_API_KEY` nema cloud sesije, pa se dugme uopšte ne renderuje.
5. Testovi za `applyCloudSession` i `chatMessages`/`cloud.test.ts` prolaze.

---

## Zaključane odluke

| Tema | Izbor |
|---|---|
| Gde se prikazuje | Persistentno dugme u composer-u, ne u scrolling transcript-u |
| Reducer | Zaseban `applyCloudSession`, odvojen od `applyExtMessage`/`ChatLine` |
| Otvaranje linka | Reuse postojećeg `open_url` (`isSafeMarkdownUrl` dozvoljava `http:`/`https:`/`mailto:`) — nema novog message tipa |
| Redosled clear vs novi URL | `session_cleared` čisti odmah; reducer dodatno brani ako `cloud_session` ipak stigne van reda |
| Bez API key-a | Dugme se ne renderuje (nema `cloud_session` eventa) |

---

## Arhitektura

| Deo | Gde |
|---|---|
| Cloud exporter attach + `onSessionUrl` | `packages/agent-core/src/runtime/cloud.ts` (`attachCloud`) |
| Poziv iz sesije | `packages/agent-core/src/session/session.ts` `rebuild()` — `attachCloud(environment, { apiKey, endpoint }, trace, (url) => sink({ type: "cloud_session", url }))` |
| Wire tip | `packages/shared/src/index.ts` — `{ type: "cloud_session"; url: string }` u `ExtToWebview` |
| Reducer (odvojen od transcripta) | `applyCloudSession` u `packages/extension/src/webview/chatMessages.ts` |
| UI state + render | `cloudUrl` state i `.cloud-session-link` dugme u `packages/extension/src/webview/App.tsx` |
| Otvaranje linka | `open_url` case u `packages/extension/src/chatViewProvider.ts` + `isSafeMarkdownUrl` u `packages/extension/src/safeUrl.ts` |
| API key izvor | `readMozaikCloudOptions()` u `packages/extension/src/loadEnv.ts` (`process.env.MOZAIK_API_KEY`) |

---

## Ponašanje

- `attachCloud` je nepromenjen u svojoj glavnoj ulozi (trace log), samo dobija dodatni `onSessionUrl` callback pored `trace`. Kad exporter javi URL, i dalje se traceuje (`cloud session <url>`) i dodatno prosleđuje ka `onSessionUrl`.
- `session.ts` `rebuild()` kači cloud samo ako `options.mozaikApiKey` postoji (trim-ovan, ne prazan string); callback šalje `{ type: "cloud_session", url }` kroz `sink` — isti kanal kojim idu svi ostali `ExtToWebview` eventi.
- U `App.tsx`, `cloud_session` event **ne** ide kroz `applyExtMessage` (transcript reducer) — hvata se posebno u `onMessage` i postavlja `cloudUrl` preko `applyCloudSession`. `applyExtMessage` eksplicitno ignoriše `cloud_session` (test: "ignores cloud_session in the transcript reducer") jer taj event nikad ne treba da postane `ChatLine`.
- Dugme se renderuje samo `{cloudUrl ? <button className="btn btn-ghost cloud-session-link" onClick={() => postMessage({ type: "open_url", url: cloudUrl })} title={cloudUrl}>Cloud session ↗</button> : null}` — u `composer-actions` redu, pored `ContextRing`, pa ostaje na ekranu nezavisno od scroll pozicije transcripta.
- `session_cleared` u `App.tsx` handler-u poziva `setCloudUrl((current) => applyCloudSession(current, msg))` **u istom bloku** gde se prazni `messages`/`context`/`busy` — sinhrono, pre nego što nova sesija stigne do mreže i pošalje svoj `cloud_session`. `applyCloudSession` samog reducera takođe brani na `session_cleared` → `null`, nezavisno od redosleda poziva, pa čak i da event stigne van očekivanog reda stari URL ne procuri.
- Otvaranje: `open_url` je postojeći message tip u `WebviewToExt`; handler u `chatViewProvider.ts` proverava `isSafeMarkdownUrl` (dozvoljava `http:`, `https:`, `mailto:`) pre `vscode.env.openExternal`. Cloud exporter endpoint je `https://api.app.jigjoy.ai` (default u `cloud.ts`, `DEFAULT_CLOUD_ENDPOINT`), pa link prolazi proveru bez izmene `safeUrl.ts`.
- Bez `MOZAIK_API_KEY` u okruženju, `readMozaikCloudOptions()` ne vraća `mozaikApiKey`, `rebuild()` nikad ne zove `attachCloud`, `cloud_session` event se nikad ne emituje, `cloudUrl` ostaje `null` — dugme se prosto ne pojavljuje, bez posebne grane koda za to.

---

## Komponente

### `attachCloud(environment, attach, trace, onSessionUrl?)`

`packages/agent-core/src/runtime/cloud.ts` — postojeća signatura proširena opcionim petim (zapravo četvrtim pozicionim) parametrom:

```ts
export function attachCloud(
  environment: AgenticEnvironment,
  attach: CloudAttach,
  trace: CloudTrace,
  onSessionUrl?: (url: string) => void,
): CloudExporter
```

### `applyCloudSession(current: string | null, msg: ExtToWebview): string | null`

`packages/extension/src/webview/chatMessages.ts`:

```ts
export function applyCloudSession(current: string | null, msg: ExtToWebview): string | null {
  if (msg.type === "cloud_session") {
    return msg.url;
  }
  if (msg.type === "session_cleared") {
    return null;
  }
  return current;
}
```

### `cloud_session` u `ExtToWebview`

`packages/shared/src/index.ts`:

```ts
/** The Mozaik Cloud session URL for this run, once the exporter connects. */
| { type: "cloud_session"; url: string }
```

---

## Testovi

`packages/agent-core/test/runtime/cloud.test.ts`:

- `attachCloud` sa API key-om zove `createCloudExporter` sa očekivanim `projectKey`/`endpoint` i pridružuje cloud participant-a environment-u.
- `onSessionUrl` dobija URL pored `trace` kad exporter javi `onSessionUrl`.

`packages/extension/src/webview/chatMessages.test.ts`:

- `applyExtMessage` ignoriše `cloud_session` (transcript se ne menja).
- `applyCloudSession(null, cloud_session)` → URL.
- `applyCloudSession(<postojeći URL>, cloud_session sa novim URL-om)` → zamenjuje URL (poslednji session pobeđuje).
- `applyCloudSession(<URL>, session_cleared)` → `null`.
- `applyCloudSession(<URL>, done)` (bilo koji drugi event) → nepromenjeno, URL ostaje.

---

## Van opsega

- Vizuelni indikator cloud konekcije (connected/error/reconnecting)
- Prikaz cloud statusa unutar transcripta ili kao zasebna chat poruka
- Novi `WebviewToExt` message tip za otvaranje linkova (reuse `open_url`)
- Promene u `cloud-sdk` exporter-u ili retry logici
