# Architecture

How Pixel Commons is put together, and *why* each piece is where it is.

## 1. The core problem

A collaborative canvas has one question at its centre: **who decides what is true?**

If the browser decides, then the cooldown, the palette, and even the coordinates are suggestions. Any user
with devtools can paint the whole board in a second, impersonate someone else's turn, or write outside the
canvas. That is exactly how most toy canvas demos behave.

Pixel Commons inverts it:

```
client intent  ──►  server validation  ──►  authoritative state  ──►  broadcast delta
```

The client sends an *intent* (`{t:'place', x, y, c}`). It never sends a colour value that gets rendered
directly, never decides whether its own cooldown is over, and never assumes a write succeeded. The
server's echo is the only thing that repaints the pixel.

## 2. Component map

| Component | Path | Responsibility |
| --- | --- | --- |
| Front-end | `src/` | Canvas rendering, input (mouse/touch/pinch), panels, dialogs, admin console |
| Socket hook | `src/lib/useCanvasSocket.ts` | Connection lifecycle, backoff, heartbeat, message dispatch |
| Worker entry | `worker/index.ts` | Exports `CanvasRoom` for Durable Object hosting + the default fetch handler |
| Router / API | `worker/app.ts` | Session cookies, CORS, `/api/*`, `/ws` upgrade forwarding, admin auth |
| CanvasRoom | `worker/durable-object.ts` | Authoritative canvas, cooldown, limits, history, snapshots, reports, audit |
| Session | `worker/session.ts` | HMAC-signed cookies, stable display handles |
| PNG | `worker/png.ts` | Dependency-free PNG encoder using `CompressionStream('deflate')` |
| Shared codec | `shared/rle.ts` | Run-length encoding, palette parsing, base64url |
| Pages functions | `functions/[[path]].ts` | Serves static assets, forwards `/api` + `/ws` to the Worker |
| Deploy helper | `scripts/deploy.mjs` | Build + `wrangler deploy` + `wrangler pages deploy` |

## 3. Data flow: placing a pixel

```
1. browser            →  POST/GET /api/session                     (once per visitor)
2. worker/app.ts      →  HMAC-sign session id, Set-Cookie: pc_sid   (HttpOnly, 30 days)
3. browser            →  WSS /ws?since=<lastHistoryId>              (cookie travels automatically)
4. worker/app.ts      →  DurableObjectStub.fetch(/ws?sid=…&since=…) (101 passed through verbatim)
5. CanvasRoom         →  welcome {config, RLE canvas, recent, history, nextAt, handle}
6. browser            →  {t:'place', x, y, c, nonce}
7. CanvasRoom         →  validate: maintenance? cooldown? burst? bounds? palette? budget? unchanged?
8. CanvasRoom         →  SQL: upsert cells, insert history, upsert players, bump meta
9. CanvasRoom         →  broadcast {t:'pixels', cells:[{x,y,c}], lastId, totalPixels, version}
                         (+ nextAt and self only to the author)
10. every browser     →  paint one 1×1 rect on the offscreen board, patch the feed
```

Steps 7–9 all happen inside a single Durable Object, so there is no interleaving between validation and the
write. Two users racing for the same cell produce one accepted write and one clearly ordered history row —
no lost updates, no torn state.

## 4. Data model (Durable Object SQLite)

One canvas = one Durable Object instance, addressed by `idFromName('main')`. All tables live in that
object's SQLite database.

```sql
meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)
  -- version, totalPixels, lastSnapshotAt, canvasName, notice(JSON)

cells(idx INTEGER PRIMARY KEY, c INTEGER NOT NULL)
  -- sparse overrides: only painted cells are stored; missing = palette[0]

history(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  x INTEGER, y INTEGER, c INTEGER,
  prev INTEGER NULL,           -- previous colour index, NULL when the cell was untouched
  at INTEGER,                  -- epoch ms, server clock
  by TEXT                      -- stable anonymous handle
)

players(session TEXT PRIMARY KEY, handle TEXT, pixels INTEGER, last_at INTEGER)

reports(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  x INTEGER, y INTEGER, reason TEXT, note TEXT,
  at INTEGER, status TEXT,     -- open | resolved | rejected
  by TEXT
)

audit(id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT, detail TEXT, by TEXT, at INTEGER)

snapshots(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER, version INTEGER,
  rle BLOB,                    -- RLE-encoded palette indices
  total_pixels INTEGER
)
```

### Why sparse `cells` instead of a blob?

A blob would rewrite 65 536 bytes on every pixel. With a sparse table a single pixel is a 1-row upsert, and
`exportRle()` reconstructs the full board only when a client connects or an export is requested.

### Why RLE?

The wire format and the snapshot format are the same: `[value, runLenLo, runLenHi]` triples capped at
65 535 per run. An empty 256×256 canvas is **8 base64url characters**. A realistic community drawing is a few
hundred bytes to a few dozen kB — small enough to send in a `welcome` message without chunking.

## 5. Limits and their rationale

| Limit | Value | Why |
| --- | --- | --- |
| Cooldown | 30 s / session | The core fairness mechanic; configurable via `COOLDOWN_SECONDS` |
| Messages per connection | 12 / s | Kills flooding without punishing normal play |
| Writes per connection | 40 / 10 s | Stops reconnect-loop abuse that would otherwise bypass cooldown |
| Reports per session | 10 / hour | Keeps the moderation queue readable |
| Report queue size | 500 | Bounded storage |
| Live history rows | 2 000 (trimmed) | Bounded storage; older data survives in snapshots |
| Snapshots | 96, every 10 min of activity | Bounded storage, useful time machine |
| Total accepted pixels | 200 000 | Hard guard on storage and export size |
| Message size | 2 048 bytes | Nothing legitimate is larger |

## 6. Front-end rendering

- `PixelCanvas` keeps an **offscreen 1px-per-cell canvas** as the source of truth for paint.
- A delta writes `fillRect(x, y, 1, 1)` on that offscreen board and re-blits only the visible region.
- The visible canvas is sized to `CSS box × devicePixelRatio`, with `imageSmoothingEnabled = false`, so pixels
  stay square and crisp from `1×` to `40×`.
- Pan/zoom mutate a viewport `{scale, offsetX, offsetY}` only — never the board.
- `clampViewport` guarantees at least 64 px of board stay on screen, so the canvas can never be "lost".
- Long-press (touch) and shift-click (desktop) open the report dialog instead of placing.

## 7. Deployment topology (and the WebSocket caveat)

```
browser ──► Pages (static + functions) ──► service binding ──► Worker ──► Durable Object
```

Two facts drove this design:

1. **Pages cannot host a Durable Object.** Durable Object classes must be deployed by a Worker. Pages can only
   *bind* to one, and the binding only resolves for a namespace that already exists in the same account.
2. **A `fetch()` subrequest cannot return `101 Switching Protocols`.** So a Pages Function cannot "proxy" a
   WebSocket by calling the Worker over plain HTTP — the upgrade response has nowhere to go. A **service
   binding** (`env.BACKEND.fetch()`) hands the upgraded socket back intact, which is why `wrangler.pages.jsonc`
   declares one.

The Worker deployment is therefore the source of truth for the API. Pages is a convenience origin with a
nicer domain; the Worker's own `*.workers.dev` URL serves the exact same thing.

Static-only hosting (GitHub Pages) can run the front-end but not the backend; it points at the API through
`VITE_API_BASE`, and the API then accepts that origin via `ALLOWED_ORIGINS` with `SameSite=None` cookies.

## 8. Trade-offs worth naming

- **Single Durable Object per canvas.** Great for consistency and simplicity, limited for geographic latency.
  Multiple canvases would be multiple names (the code already keys on a name).
- **No hibernation WebSockets.** The room keeps in-memory connection state and performs synchronous fan-out.
  Hibernation would cut duration billing but complicates the cooldown bookkeeping; the current design keeps it
  auditable. Listed as roadmap.
- **Anonymous identity = cheap cooldown resets.** Clearing cookies yields a new session. The mitigation is
  rate limiting plus moderation, not identity verification, because collecting identities was judged worse
  than the abuse.
- **Snapshot granularity is coarse** (every 10 minutes of activity, capped) to keep storage small.
