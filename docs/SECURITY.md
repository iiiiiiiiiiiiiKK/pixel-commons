# Security & privacy

This document describes what Pixel Commons protects, how, and what it deliberately does **not** do.

## 1. Threat model

| Adversary | Capability | Mitigation |
| --- | --- | --- |
| Curious visitor | Devtools access to the JS bundle | The bundle contains no authority: cooldown, bounds and palette live server-side |
| Impatient painter | Wants to bypass the 30 s cooldown | Cooldown is keyed to a server-side session, not a client flag; a reconnect does not reset it |
| Scripted spammer | Automated WebSocket frames | 12 msg/s per connection, 40 writes/10 s per connection, 2 kB frame cap, per-session report limit |
| Identity forger | Edits cookies / message fields | Session cookie is HMAC-signed; an invalid signature is discarded and replaced, never trusted |
| Privilege escalator | Calls `/api/admin/*` directly | Server checks a signed admin cookie on every admin route; anonymous calls get 401 |
| Cross-site attacker | Loads the API from another origin | CORS is same-origin by default; extra origins must be listed in `ALLOWED_ORIGINS`. Cookies are `SameSite=Lax` same-origin, `SameSite=None; Secure` only for explicitly allowed cross-site origins |
| Content abuser | Draws harassment / advertising | Report queue, admin resolve/reject, reset, maintenance mode, full audit trail |

## 2. Identity design

```
pc_sid = <random 128-bit id> "." HMAC-SHA256(SESSION_SECRET, id)   →  base64url
```

- Generated on first `GET /api/session`; `HttpOnly`, `Path=/`, `Max-Age=30d`.
- Stored **only** in the cookie — the server keeps no cookie table. Verification is stateless.
- Public handle: `SHA-256("handle:" + sessionId)` → `adjective-animal-123`. Derived, stable, non-reversible.
- No email, no password, no device fingerprint, no IP storage, no analytics SDK.

**Consequence, stated plainly:** clearing cookies yields a new identity and therefore a fresh cooldown. This is
a deliberate trade-off — collecting identities to prevent it would be worse for a public art project. Abuse is
handled by rate limits and moderation instead.

## 3. Authorisation

| Action | Who | Enforced where |
| --- | --- | --- |
| Place a pixel | anyone with a session | `CanvasRoom.handlePlace` (cooldown, bounds, palette, burst, budget) |
| Report a pixel | anyone with a session | `CanvasRoom.handleReport` (+ 10/hour limit) |
| Read history / snapshots | anyone | `worker/app.ts` → DO |
| Export PNG | anyone | `worker/app.ts` → DO `renderPng` |
| Publish / clear notice | admin | `requireAdmin` → signed cookie → DO `adminAction` |
| Undo last pixel | admin | same |
| Reset canvas | admin | same; UI additionally requires typing `RESET` |
| Resolve / reject reports | admin | same |
| Read audit trail | admin | same |

The client hides admin buttons for non-admins, but hiding is cosmetic — every mutation re-checks the cookie
server-side. Removing the `ADMIN_TOKEN` secret disables the whole surface with a 503.

## 4. Input validation

Every inbound WebSocket frame is:

1. Rejected if binary or larger than 2 048 bytes.
2. Rejected if the connection exceeds its message budget.
3. JSON-parsed inside a `try` — malformed JSON yields `bad_request`, never a crash.
4. Type-checked per message: integer coordinates, integer palette index, `reason` from an enum whitelist.
5. Range-checked: `0 ≤ x < width`, `0 ≤ y < height`, `0 ≤ c < palette.length`.
6. Checked against `unchanged` (writing the same colour is refused and does **not** burn the cooldown).

HTTP bodies are parsed defensively: `/api/admin/login` and `/api/admin/action` both treat a non-JSON body as a
400, and the admin action name is whitelisted against a fixed list.

## 5. Resource limits

| Resource | Guard |
| --- | --- |
| Frames | 2 kB max, text only |
| Message rate | 12/s per connection |
| Write bursts | 40 per 10 s per connection (defeats reconnect loops) |
| Reports | 10 / hour per handle; 500 queued rows max |
| History | 2 000 live rows (oldest trimmed; snapshots retain history) |
| Snapshots | 96 max, one per 10 min of activity |
| Canvas | 200 000 accepted pixels max |
| Login attempts | 10 per 5 min per client (per isolate) |

These bounds keep a single abusive client from exhausting Durable Object storage or the daily request quota.

## 6. Data at rest

Durable Object SQLite stores: `cells`, `history`, `players` (session id + derived handle + counter + last write
time), `reports`, `audit`, `snapshots`, `meta`. That is the entire dataset.

- No cookies, tokens or secrets are ever written to it.
- `SESSION_SECRET` and `ADMIN_TOKEN` live only in platform secrets / `.dev.vars` (gitignored).
- Backups, if you add them via the DO `/backup` RLE endpoint, are canvas-only blobs.

## 7. Transport & headers

- All deployed origins are HTTPS; WebSockets use `wss:`.
- Cookies get `Secure` on HTTPS. Cross-site mode adds `SameSite=None` (required for the GH Pages build) and is
  only activated when the request's `Origin` differs from the API origin.
- API responses are `cache-control: no-store`.
- `OPTIONS` preflights are answered only for allowed origins; anything else receives 403.

## 8. Dependencies

- Runtime: **zero** production dependencies in the Worker (Cloudflare runtime built-ins only).
- Front-end: React + React DOM.
- Dev: Vite, TypeScript, Wrangler, Vitest, Playwright.
- `npm audit` → **0 vulnerabilities**. An `overrides` entry pins `undici` to a patched range because the
  version pulled in transitively by tooling had advisories.

## 9. Disclosure

Found a vulnerability? Open a private security advisory on the GitHub repository, or contact
[@0xkillcoin](https://x.com/0xkillcoin). Please do not test against the public canvas with destructive payloads
(canvas resets and mass writes) — a local `wrangler dev` instance is the right place for that.

## 10. Privacy summary

Collected: a random session id, a derived nickname, a count of pixels placed, the pixels themselves.
Not collected: email, name, IP, user agent, referrer, geolocation, or any third-party analytics.
Retention: pixels and history persist until an admin resets the canvas; `players` rows persist so cooldowns
survive reconnects. There is no per-user deletion path because there is no per-user account — this is
documented rather than hidden.
