# Deployment guide

Two deployment shapes are supported. Both run the **same** Worker code; pick the one that matches your
constraints.

| Shape | What you get | When to use it |
| --- | --- | --- |
| **A. Worker only** | `https://pixel-commons.<subdomain>.workers.dev` — UI, API and Durable Object all in one | Simplest. Default. |
| **B. Worker + Pages** | `https://pixel-commons.pages.dev` serving the UI and forwarding `/api` + `/ws` | You want a `pages.dev` domain, or you plan to attach a custom domain to Pages. |
| **C. Static front-end (GitHub Pages) + Worker API** | GH Pages UI talking to the Worker API | You want the repo browsable as a live demo on GitHub Pages. Static-only, no backend there. |

---

## 0. Prerequisites

```bash
node -v      # >= 20
npm install
```

A Cloudflare account is enough — the Free plan includes Workers, Durable Objects (SQLite backend) and Pages.

Create a token with **Create Token → "Edit Cloudflare Workers"** template, then verify:

```bash
npx wrangler whoami
```

---

## 1. Generate secrets

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # SESSION_SECRET
node -e "console.log('pc_' + require('crypto').randomBytes(24).toString('base64url'))"  # ADMIN_TOKEN
```

Put them in `.dev.vars` for local runs. **Never** commit that file — it is already in `.gitignore`.

---

## 2. Shape A — Worker only

```bash
npm run build

npx wrangler secret put SESSION_SECRET     # paste the value
npx wrangler secret put ADMIN_TOKEN        # optional; omit to disable the admin console

npx wrangler deploy
```

`wrangler deploy` applies the Durable Object migration declared in `wrangler.jsonc`:

```jsonc
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["CanvasRoom"] }]
```

Verify:

```bash
curl https://pixel-commons.<subdomain>.workers.dev/api/health
# {"ok":true,"width":256,"height":256,"cooldownSeconds":30,...}
```

---

## 3. Shape B — Worker + Pages

Pages cannot *define* Durable Objects (only Workers can) and a Pages Function cannot answer
`101 Switching Protocols`. So Pages serves the UI and forwards the realtime traffic to the Worker through a
**service binding**.

### 3.1 Deploy the Worker first

Same as Shape A. **Order matters** — the Pages binding resolves against an existing Worker.

### 3.2 Create the Pages project

```bash
npx wrangler pages project create pixel-commons --production-branch main
```

### 3.3 Attach the service binding + variables

Cloudflare dashboard → **Workers & Pages → pixel-commons (Pages) → Settings → Bindings**:

| Type | Variable name | Value |
| --- | --- | --- |
| Service binding | `BACKEND` | service `pixel-commons`, environment `production` |
| Plain text | `ALLOWED_ORIGINS` | `https://<you>.github.io` (comma separated, only if you use Shape C) |
| Secret | `SESSION_SECRET` | same value as the Worker |
| Secret | `ADMIN_TOKEN` | same value as the Worker (optional) |

> Prefer declarative config? `wrangler.pages.jsonc` in this repo contains the equivalent
> `services` + `vars` block. Keep **one** source of truth: either the file or the dashboard.

### 3.4 Deploy

```bash
npx wrangler pages deploy dist --project-name pixel-commons --branch main
```

### 3.5 Verify

```bash
curl https://pixel-commons.pages.dev/api/health
# 200 with the same JSON body as the Worker

# WebSocket upgrade must reach the Durable Object:
node -e "const w=new WebSocket('wss://pixel-commons.pages.dev/ws');w.onopen=()=>{console.log('open');w.close()};w.onerror=()=>console.log('error')"
# a bare connection is refused with 401 (no session cookie) — that is correct:
# what matters is that you get an HTTP response, not a hanging socket.
```

The full browser flow is covered by `npm run test:e2e` against the Pages URL.

### 3.6 Common errors

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Deployment failed … Cannot create binding for class 'CanvasRoom'` | You declared a `durable_object_namespaces` binding on the Pages project for a class that Pages does not own | Remove it; use the **service binding** instead |
| `/api/*` returns 503 `backend_not_configured` | No `BACKEND` binding and no `BACKEND_ORIGIN` | Add the service binding (3.3) and redeploy |
| `/ws` returns 500 | A Durable Object SQL query assumed a row existed (fixed in `toArray()[0]`) or the binding is missing | Check the Worker logs: `npx wrangler tail pixel-commons` |
| `workers.dev` unreachable but `pages.dev` works | Some networks block `*.workers.dev` | Use the Pages origin — it is the same Worker behind it |

---

## 4. Shape C — GitHub Pages front-end

GitHub Pages is **static hosting only**. It can serve the React build but cannot run the Durable Object, so the
UI talks to the Worker API cross-origin.

### 4.1 Allow the origin

```bash
npx wrangler secret put ALLOWED_ORIGINS
# https://<user>.github.io
```

(Or set it as a plain-text var in `wrangler.jsonc` → `vars`, and redeploy.)

The API derives `SameSite=None; Secure` from the request's `Origin` header, so cross-site cookies work without
weakening the same-origin case.

### 4.2 Build the static bundle

```bash
VITE_API_BASE=https://pixel-commons.pages.dev \
VITE_BASE=/pixel-commons/ \
  npx vite build --outDir dist-pages
```

- `VITE_API_BASE` is baked into the bundle as `__API_BASE__`; every `fetch` and the WebSocket URL use it.
- `VITE_BASE` must match the repository name for project sites (`/<repo>/`); use `/` for user sites.

### 4.3 Publish

```bash
cd dist-pages
git init && git add -A && git commit -m "docs: publish static demo"
git branch -M gh-pages
git remote add origin https://github.com/<user>/pixel-commons.git
git push -f origin gh-pages
```

Then **Settings → Pages → Source: branch `gh-pages` / root**.

The repo also ships `.github/workflows/pages.yml`, which does exactly this on every push to `main` whenever
`PAGES_API_BASE` is set as a repository variable.

### 4.4 Caveats (specific and real)

- GitHub Pages has **no server runtime**. No cooldown enforcement, no history, no admin — those live in the
  Worker. If the Worker is down, the Pages build shows a clear "backend unreachable" error instead of pretending.
- Cross-site cookies require the browser to accept third-party cookies for `github.io`. Safari's ITP can block
  them, which means a *new* anonymous session per page load (the UI still works, your cooldown may reset more
  often). This is a browser policy limit, not something the app can override.
- The service worker / SPA fallback is handled by a `404.html` copy in the workflow, since GH Pages has no
  rewrite rules.

---

## 5. Verification checklist

Run these against whichever origin you deployed:

```bash
export PIXEL_COMMONS_URL=https://pixel-commons.pages.dev

curl -s $PIXEL_COMMONS_URL/api/health
node tests/integration.mjs            # 43 checks, HTTP + WebSocket
ADMIN_TOKEN=... node tests/integration.mjs   # + admin mutations
npm run test:e2e                      # desktop Chromium + iPhone 13 WebKit
```

Expected: `43/43 checks passed`, `7 passed / 1 skipped` (desktop), `8 passed` (iPhone).

---

## 6. Operations

| Task | Command |
| --- | --- |
| Live logs | `npx wrangler tail pixel-commons` |
| Change the cooldown | dashboard var `COOLDOWN_SECONDS`, or `wrangler.jsonc` → `vars`, then redeploy |
| Change the palette | `CANVAS_PALETTE=#000000,#ffffff,…` (2–32 entries) |
| Rotate the session secret | `npx wrangler secret put SESSION_SECRET` (all sessions reset — expected) |
| Disable the admin console | delete the `ADMIN_TOKEN` secret; `/api/admin/*` starts returning 503 |
| Roll back | `npx wrangler rollback` (Workers keeps prior versions) |
| Reset the canvas | admin console → *reset canvas* (type `RESET` to confirm), or `POST /api/admin/action {"action":"reset"}` |
| Export a backup | `GET /api/export.png?scale=4`, `GET /api/snapshots`, or the DO `/backup` RLE endpoint |

### Cost expectations (Free plan)

- Workers Free: 100 000 requests/day.
- Durable Objects Free: 100 000 requests/day, 13 000 GB-s/day compute, 5 GB SQLite storage.

A quiet community canvas uses a tiny fraction of that. This repo was deployed without purchasing any plan and
makes no claim of "unlimited" scale — a viral spike would hit the daily request ceiling.
