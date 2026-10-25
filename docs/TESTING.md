# Testing

Every number in the README comes from a command in this document. Nothing is estimated.

## Summary

| Suite | Command | Result |
| --- | --- | --- |
| Unit | `npm test` | **13 / 13 passed** |
| Integration (live origin) | `node tests/integration.mjs` | **43 / 43 passed** |
| E2E desktop (Chromium) | `npx playwright test --project=desktop-chromium` | **7 passed, 1 skipped** |
| E2E mobile (iPhone 13 / WebKit) | `npx playwright test --project=iphone-13` | **8 passed** |
| Typecheck | `npm run typecheck` | clean |
| Production build | `npm run build` | clean (`dist/` ~186 kB JS, 59 kB gzip) |
| Dependency audit | `npm audit` | **0 vulnerabilities** |

## 1. Unit tests

```bash
npm test
```

Covers the parts where a subtle bug would be invisible until the canvas corrupts:

- RLE round-trips: uniform canvas, alternating noise, the 65 535 run cap, malformed blobs never exceeding the
  target length.
- `encodeCanvas`/`decodeCanvas` index preservation.
- base64url round-trips with no `+`, `/`, `=` leakage.
- `parseHex` / `normaliseHex` accepting 3- and 6-digit forms and rejecting everything else.
- Palette expansion to RGB triplets; the default palette is exactly 16 valid `#rrggbb` entries.
- Canvas id slugification.

## 2. Integration suite

```bash
export PIXEL_COMMONS_URL=https://pixel-commons.pages.dev
node tests/integration.mjs

# to include admin mutations:
ADMIN_TOKEN=<token> node tests/integration.mjs
```

It drives the real HTTP + WebSocket surface with plain `fetch` and Node's `WebSocket` — no mocks and no
test-only endpoints. Each assertion is listed here with what it proves:

### Session & identity
- `health endpoint reports canvas geometry` — `/api/health` answers with real config.
- `session issues an HttpOnly cookie` — `Set-Cookie` carries a signed `pc_sid`.
- `session cookie is HttpOnly + SameSite` — flags verified from the raw header.
- `session exposes a stable display handle` — pattern `^[a-z]+-[a-z]+-\d{3}$`.

### Realtime
- `websocket handshake returns welcome` — a real 101 upgrade through Pages → Worker → Durable Object.
- `welcome carries an RLE canvas blob` — the board arrives compressed, not as 65 536 bytes.
- `welcome carries the palette`.
- `server echoes the accepted pixel to its author` — client never self-confirms.
- `author receives the authoritative cooldown deadline` — `nextAt` is in the future, from the server clock.
- `pixel is broadcast to other online users` — second socket receives the same delta.
- `second immediate write is rejected by the server` — `reason: cooldown`.
- `cooldown is per-session, not global` — a different session can write immediately.
- `simultaneous writers settle on one authoritative value` — race resolves to one colour, no corruption.
- `presence reports the number of live connections`.

### Validation
- `negative coordinates are rejected`.
- `coordinates outside the canvas are rejected`.
- `out-of-palette colour indices are rejected` (`bad_color`).
- `malformed placement payloads are rejected` (`bad_request`).
- `unknown message types are rejected` (`bad_request`).
- `per-connection message flood is rate limited` — a 15 ms ping loop trips `rate_limited`.

### Persistence & history
- `accepted pixels are persisted and readable over HTTP`.
- `history records the author handle for each pixel`.
- `reconnect replays history after the cursor` — `?since=<id>` returns only newer rows.
- `reconnect restores the same identity` — handle is stable across sockets.
- `snapshot index is queryable`.

### Export
- `PNG export returns a valid PNG file` — magic bytes `89 50 4e 47`, `content-type: image/png`.
- `PNG dimensions match the canvas` — IHDR width parsed out of the file.

### Moderation & admin
- `reports are accepted into the moderation queue`.
- `admin view rejects anonymous callers` (401).
- `admin login rejects a wrong token` (401).
- `admin login accepts the configured token` (200 + signed cookie).
- `admin view returns reports + audit trail`.
- `admin can publish a notice` / `admin can clear a notice`.
- `admin can undo the last pixel`.
- `admin actions are written to the audit trail` — row count grows.
- `anonymous callers cannot reset the canvas`.

### Transport & scale
- `websocket without a session cookie is refused`.
- `static front-end is served at /`.
- `12 concurrent websocket clients connect`.
- `broadcast fan-out to 12 clients stays under 3 s`.

### Measured result (2026-10-25, production)

```
12 concurrent sockets   →  ~1.1 s per handshake
fan-out to 12 sockets   →  6/6 delivered, avg 250 ms
```

Interpretation: the numbers describe a single-region Durable Object under a light load test from one client
machine, not a capacity guarantee. Fan-out is one outbound frame per subscriber, so latency is dominated by the
distance from the tester to the object's region.

## 3. End-to-end tests (Playwright)

```bash
npx playwright install chromium webkit
PIXEL_COMMONS_URL=https://pixel-commons.pages.dev npx playwright test
```

Two projects run the same spec file:

- **desktop-chromium** — 1440×900, mouse input, wheel zoom, sidebar panels.
- **iphone-13** — real WebKit with a 390×844 viewport, `hasTouch`, device pixel ratio 3.

Spec coverage:

| Test | Desktop | iPhone |
| --- | --- | --- |
| Loads canvas, palette, X link, no console errors, canvas ≥ 25 % of viewport | ✅ | ✅ (palette via sheet) |
| Places a pixel at a deep-linked coordinate, verifies persisted colour | ✅ | ✅ (real tap) |
| Cooldown CTA shows a server-derived `Ready`/countdown | ✅ | ✅ |
| History dialog exposes working `/api/export.png` links, fetches a valid PNG | ✅ | ✅ |
| Help dialog documents rules and controls | ✅ | ✅ |
| Two browser contexts see the same canvas and presence ≥ 2 | ✅ | ✅ |
| Auto-reconnect after `setOffline(true)` → `false` | ✅ | ✅ |
| Phone-only: palette/activity sheets, no horizontal overflow, all controls inside the viewport, tap places a pixel, zoom buttons work | skipped | ✅ |

Screenshots are written to `docs/screenshots/` from these runs — that is why every image in the README shows
the real deployed UI.

### Bugs these tests actually caught (and were fixed)

1. **`Expected exactly one result from SQL query, but got no results`** — `.one()` throws on an empty result in
   workerd. Every read was switched to `toArray()[0] ?? null`. This is why WebSocket upgrades returned 500.
2. **Reconnect never restored `live`** — `setOffline(false)` fires `online` before the old socket's `close`, so
   `connect()` short-circuited on a dead socket. Reconnects now force a fresh socket.
3. **Overlay controls swallowed taps on mobile** — the canvas pointer-capture handler treated the palette tab as
   a canvas press. Pointer handling now ignores events whose target is not the canvas surface.

## 4. What is *not* covered

Stated plainly so nobody over-trusts the suite:

- **Local `wrangler dev` could not be exercised on this Windows host.** `workerd` crashes at startup with a
  stack overflow (`thread 'main' has overflowed its stack`) — reproducible with a minimal capnp config and with
  older `workerd` builds, so it is an environment/host issue, not project code. All verification was therefore
  run against the deployed Cloudflare origin, which is the more meaningful target anyway.
- **True server restart / Durable Object eviction** was not forced. Persistence is proven indirectly: history,
  snapshots and cooldown state survive across many independent sockets and minutes of idle time, and the DO
  reloads its tables through `load()` on every cold start.
- **Load testing stops at 12 concurrent sockets from one machine.** No claim about thousands of concurrent
  users is made anywhere.
- **Safari third-party cookie blocking** (relevant only to the GitHub Pages cross-site build) was not verified
  on physical Safari hardware; WebKit via Playwright does not enforce ITP the same way.
