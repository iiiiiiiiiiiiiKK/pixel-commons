# Contributing to Pixel Commons

Thanks for wanting to help. This is a small project with one very important invariant, so please read the
first section before writing code.

## The one rule

**The server decides. The client renders.**

Any change that lets the browser grant itself pixels, cooldown resets, colours outside the palette, or admin
powers will be rejected — even if it "looks nicer". If you find a place where this invariant is violated,
that is a bug worth reporting.

## Getting set up

```bash
git clone https://github.com/iiiiiiiiiiiiiKK/pixel-commons.git
cd pixel-commons
npm install
cp .env.example .dev.vars
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('base64url'))" >> .dev.vars
npm run build          # so the Worker can serve dist/
npx wrangler dev       # http://127.0.0.1:8787
```

Hot reload for the UI: run `npm run dev` in a second terminal (Vite on 5173, proxying `/api` and `/ws`).

## Before opening a PR

```bash
npm run typecheck
npm test
npm run build
```

If your change touches the network surface, also run the integration suite against a deployed origin:

```bash
PIXEL_COMMONS_URL=https://your-deployment.example node tests/integration.mjs
```

## Code conventions

- **TypeScript strict mode**, `noUncheckedIndexedAccess` on. No `any` in new code.
- **No new runtime dependencies in the Worker** unless there is no reasonable alternative. The Worker
  currently has zero.
- Comments explain *why*, not *what*. A comment that restates the next line will be removed.
- Keep the protocol in `shared/protocol.ts` as the single source of truth; both sides import it.
- `worker/durable-object.ts` owns all authority. Adding validation somewhere else invites a bypass.

## Areas where help is genuinely useful

1. **WebSocket hibernation** — reduce Durable Object duration billing without losing cooldown correctness.
2. **Tests around eviction** — force DO restarts and assert state reloads.
3. **Accessibility** — the canvas needs a keyboard-driven placement path.
4. **RLE/protocol efficiency** — batched deltas for multi-pixel undo or region operations.
5. **i18n** — the UI is English-only today.

## Reporting a bug

Include:

- the deployed URL you saw it on (or `wrangler dev` + version),
- the coordinate and roughly when, if it is canvas-related,
- browser and viewport,
- what you expected vs. what happened,
- console errors if any.

## Reporting a security issue

Do **not** open a public issue. Use a private GitHub security advisory, or contact
[@0xkillcoin](https://x.com/0xkillcoin) on X. Please avoid destructive testing against the public canvas
(no mass writes, no resets) — spin up your own deployment for that.

## Commit messages

Conventional-ish and specific:

```
fix(worker): tolerate empty SQL result sets (.one → toArray[0])
feat(ui): add long-press to report on touch devices
docs(readme): document the Pages service-binding requirement
```

## License

By contributing you agree your work is released under the [MIT License](LICENSE).
