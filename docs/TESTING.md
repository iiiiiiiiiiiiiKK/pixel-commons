# Testing

Every number in the README comes from a command in this document. Nothing is estimated.

## Summary

| Suite | Command | Result |
| --- | --- | --- |
| Unit + Durable Object authority | `npm test` | **39 / 39 passed** |
| Integration (live origin) | `node tests/integration.mjs` | **40 / 40 passed** |
| E2E desktop (Chromium) | `npx playwright test --project=desktop-chromium` | **7 passed, 1 skipped** |
| E2E mobile (iPhone 13 / WebKit) | `npx playwright test --project=iphone-13` | **7 passed + 1 on retry** |
| Typecheck | `npm run typecheck` | clean |
| Production build | `npm run build` | clean (`dist/` about 186 kB JS, 59 kB gzip) |
| Dependency audit | `npm audit` | **0 vulnerabilities** |

## 1. Unit and Durable Object tests

```bash
npm test
```

Two files, 39 tests.

### `tests/rle.test.ts` (13 tests) - the codec

- RLE round-trips: uniform canvas, alternating noise, the 65 535 run cap, malformed blobs never exceeding the
  target length.
- `encodeCanvas` / `decodeCanvas` index preservation.
- base64url round-trips with no `+`, `/`, `=` leakage.
- `parseHex` / `normaliseHex` accepting 3- and 6-digit forms and rejecting everything else.
- Palette expansion to RGB triplets; the default palette is exactly 16 valid `#rrggbb` entries.
- Canvas id slugification.

### `tests/durable-object.test.ts` (26 tests) - the authority

These run the **shipped** `CanvasRoom` class through its real `fetch()` entry point against an in-memory
SQLite database (`node:sqlite`) plus a `WebSocketPair` shim, so cooldown, validation, persistence and
broadcast are exercised as real code paths rather than mocked helpers. Harness: `tests/helpers/do-harness.ts`.

Coverage:

- Session handshake: invalid session id rejected; welcome carries config, RLE canvas, palette, derived handle.
- Cost of a connection: the board is one row; bounded history/presence queries; no `cells` table scan.
- Placement: accepted pixel echoed to author with `nextAt`; broadcast to others without leaking the author's
  deadline; per-session cooldown; one session does not block another; cooldown survives a reconnect.
- Validation: negative and out-of-canvas coordinates, out-of-palette index, non-integer payload, oversized
  frame, message flood, unchanged pixel (never spends the cooldown).
- Persistence: exactly one `canvas` row write per pixel and zero row reads; a fresh object instance restores
  board + history from storage (the simulated Durable Object restart).
- Moderation: reports land in the queue, report rate limit, reset clears canvas/history but keeps the audit
  trail, notice publish/clear, maintenance blocks writes, undo reverts to the previous colour, and "nothing to
  undo" reports failure instead of pretending success.
- Export: PNG magic bytes and IHDR width for 1x and 4x.

## 2. Integration suite

```bash
export PIXEL_COMMONS_URL=https://pixel-commons.pages.dev
node tests/integration.mjs

# to include admin mutations:
ADMIN_TOKEN=<token> node tests/integration.mjs
```

It drives the real HTTP + WebSocket surface with plain `fetch` and Node's `WebSocket` - no mocks and no
test-only endpoints.

### Session and identity
- `health endpoint reports canvas geometry` - `/api/health` answers with real config.
- `session issues an HttpOnly cookie` - `Set-Cookie` carries a signed `pc_sid`.
- `session cookie is HttpOnly + SameSite` - flags verified from the raw header.
- `session exposes a stable display handle` - pattern `^[a-z]+-[a-z]+-\d{3}$`.

### Realtime
- `websocket handshake returns welcome` - a real 101 upgrade through Pages -> Worker -> Durable Object.
- `welcome carries an RLE canvas blob` - the board arrives compressed, not as 65 536 bytes.
- `welcome carries the palette`.
- `server echoes the accepted pixel to its author` - the client never self-confirms.
- `author receives the authoritative cooldown deadline` - `nextAt` is in the future, from the server clock.
- `pixel is broadcast to other online users` - a second socket receives the same delta.
- `second immediate write is rejected by the server` - `reason: cooldown`.
- `cooldown is per-session, not global` - a different session can write immediately.
- `simultaneous writers settle on one authoritative value` - the race resolves to one colour, no corruption.
- `presence reports the number of live connections`.

### Validation
- `negative coordinates are rejected`.
- `coordinates outside the canvas are rejected`.
- `out-of-palette colour indices are rejected` (`bad_color`).
- `malformed placement payloads are rejected` (`bad_request`).
- `unknown message types are rejected` (`bad_request`).
- `per-connection message flood is rate limited` - a 15 ms ping loop trips `rate_limited`.

### Persistence and history
- `accepted pixels are persisted and readable over HTTP`.
- `history records the author handle for each pixel`.
- `reconnect replays history after the cursor` - `?since=<id>` returns only newer rows.
- `reconnect restores the same identity` - the handle is stable across sockets.
- `snapshot index is queryable`.

### Export
- `PNG export returns a valid PNG file` - magic bytes `89 50 4e 47`, `content-type: image/png`.
- `PNG dimensions match the canvas` - IHDR width parsed out of the file.

### Moderation and admin
- `reports are accepted into the moderation queue`.
- `admin view rejects anonymous callers` (401).
- `admin login rejects a wrong token` (401).
- `admin login accepts the configured token` (200 + signed cookie).
- `admin view returns reports + audit trail`.
- `admin can publish a notice` / `admin can clear a notice`.
- `admin can undo the last pixel`.
- `admin actions are written to the audit trail` - row count grows.
- `anonymous callers cannot reset the canvas`.

### Transport and scale
- `websocket without a session cookie is refused`.
- `static front-end is served at /`.
- `12 concurrent websocket clients connect`.
- `broadcast fan-out to 12 clients stays under 3 s`.

### Measured result (2026-10-25, production)

```
run 1: 12 concurrent sockets -> ~1.1 s per handshake, fan-out 6/6 delivered, avg 250 ms
run 2: 12 concurrent sockets -> ~1.65 s per handshake, fan-out 6/6 delivered, avg 309 ms
```

Interpretation: these numbers describe a single-region Durable Object under a light load test from one client
machine, not a capacity guarantee. Fan-out is one outbound frame per subscriber, so latency is dominated by
the distance from the tester to the object's region. The difference between the runs is network noise from the
test host, not a change in the app.

## 3. End-to-end tests (Playwright)

```bash
npx playwright install chromium webkit
PIXEL_COMMONS_URL=https://pixel-commons.pages.dev npx playwright test
```

Two projects run the same spec file:

- **desktop-chromium** - 1440x900, mouse input, wheel zoom, sidebar panels.
- **iphone-13** - real WebKit with a 390x844 viewport, `hasTouch`, device pixel ratio 3.

Spec coverage:

| Test | Desktop | iPhone |
| --- | --- | --- |
| Loads canvas, palette, X link, no console errors, canvas covers 25 %+ of viewport | yes | yes (palette via sheet) |
| Places a pixel at a deep-linked coordinate, verifies persisted colour | yes | yes (real tap) |
| Cooldown CTA shows a server-derived Ready/countdown | yes | yes |
| History dialog exposes working `/api/export.png` links, fetches a valid PNG | yes | yes |
| Help dialog documents rules and controls | yes | yes |
| Two browser contexts see the same canvas and presence of at least 2 | yes | yes |
| Auto-reconnect after `setOffline(true)` then `false` | yes | yes |
| Phone-only: palette/activity sheets, no horizontal overflow, all controls inside the viewport, tap places a pixel, zoom buttons work | skipped | yes |

Screenshots are written to `docs/screenshots/` from these runs - that is why every image in the README shows
the real deployed UI.

### Bugs these tests actually caught (and were fixed)

1. **`Expected exactly one result from SQL query, but got no results`** - `.one()` throws on an empty result in
   workerd. Every read was switched to `toArray()[0] ?? null`. This is why WebSocket upgrades returned 500 in
   production while the type checker was perfectly happy.
2. **Reconnect never restored `live`** - `setOffline(false)` fires `online` before the old socket's `close`, so
   `connect()` short-circuited on a dead socket. Reconnects now force a fresh socket and only clear the ref if
   it still points at the socket that closed.
3. **Overlay controls swallowed taps on mobile** - the canvas pointer-capture handler treated a palette tab
   press as a canvas press. Pointer handling now ignores events whose target is not the canvas surface.
4. **Durable Object free-tier row reads** - the original per-cell table made every `welcome` a full-table
   scan. Replaced with a single packed RLE board row held in memory and storage, so a pixel write performs
   zero row reads and one row write. Reported honestly in the README because the quota wall is a real
   production constraint, not a test artefact.
5. **Cross-site session was impossible** - the static build could not authenticate its WebSocket, because the
   browser refuses to send the `pc_sid` cookie to another origin. `/api/session` now also returns the same
   HMAC-signed value as a token, which the build stores in `sessionStorage` and passes as `?token=`. Verified
   by loading the GitHub Pages site in Chromium and watching the connection reach `live`.

### Flaky test, stated as such

On one iPhone-13 run the first spec (`loads the canvas...`) timed out on WS connect and then **passed on
retry**. The cause is the same quota-driven degraded mode described above: the Durable Object reports
`storageHealthy: false`, the room recreates, and the first socket of a cold instance occasionally misses its
welcome window. It is recorded here rather than hidden, and the summary line in the README says
"7 passed + 1 on retry" instead of claiming a clean 8/8.

## 4. What is *not* covered

Stated plainly so nobody over-trusts the suite.

- **Local `wrangler dev` could not be exercised on this Windows host.** `workerd` crashes at startup with a
  stack overflow (`thread 'main' has overflowed its stack`) - reproducible with a minimal capnp config and
  with older workerd builds, so it is an environment/host issue, not project code. Verification therefore ran
  against the deployed Cloudflare origin, which is the more meaningful target anyway.
- **True server restart / Durable Object eviction** was not forced on the deployed instance. It *is* covered
  deterministically in `tests/durable-object.test.ts`, which builds a second `CanvasRoom` over the same
  database and asserts the board and history reload.
- **Load testing stops at 12 concurrent sockets from one machine.** No claim about thousands of concurrent
  users is made anywhere.
- **Safari third-party cookie blocking** (relevant only to the GitHub Pages cross-site build) was not verified
  on physical Safari hardware; WebKit via Playwright does not enforce ITP the same way.
