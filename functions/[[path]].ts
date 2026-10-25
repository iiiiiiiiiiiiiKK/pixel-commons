/**
 * Cloudflare Pages Functions entry — the public origin for Pixel Commons.
 *
 * Deployment model
 * ---------------------------------------------------------------
 * The authoritative realtime room (SQLite-backed Durable Object `CanvasRoom`)
 * is deployed by the Worker in `worker/` and published at
 * `https://pixel-commons.<subdomain>.workers.dev`.
 *
 * This Pages project is the public front door:
 *
 *   browser ──► https://pixel-commons.pages.dev
 *                 ├─ /api/*, /ws, /healthz ──► forwarded to the Worker
 *                 └─ everything else        ──► static assets in `dist/`
 *
 * Forwarding uses, in order of preference:
 *   1. `CANVAS` Durable Object binding  → runs the API in-process (no extra hop)
 *   2. `BACKEND` service binding        → Worker-to-Worker, keeps the 101 upgrade
 *   3. `BACKEND_ORIGIN` plain fetch     → last resort, HTTP only (no WebSocket)
 *
 * A plain `fetch()` subrequest cannot carry a `101 Switching Protocols`
 * response, which is exactly why the service binding exists: it hands the
 * upgraded socket back intact.
 */

import { handleRequest } from '../worker/app';
import type { Env } from '../worker/env';

interface PagesEnv extends Env {
  BACKEND?: { fetch: (request: Request) => Promise<Response> };
  BACKEND_ORIGIN?: string;
}

const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
];

function isBackendPath(pathname: string): boolean {
  return pathname.startsWith('/api/') || pathname === '/ws' || pathname === '/healthz';
}

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Rebuild the request so upstream sees the public host/proto and no hop-by-hop headers. */
function forwardable(request: Request, url: URL): Request {
  const headers = new Headers(request.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);
  headers.set('x-forwarded-host', url.host);
  headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
  const init: RequestInit = { method: request.method, headers, redirect: 'manual' };
  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;
  return new Request(request.url, init);
}

export const onRequest: PagesFunction<PagesEnv> = async (context) => {
  const { request, env, next } = context;
  const url = new URL(request.url);

  if (!isBackendPath(url.pathname)) {
    // Static asset; Pages applies the SPA fallback itself.
    return next();
  }

  // 1. Durable Object bound directly to this Pages project: run the API in-process.
  if (env.CANVAS) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error('pages_api_error', error);
      return jsonError(500, 'server_error', 'Something went wrong on our side. Please retry.');
    }
  }

  // 2. Service binding to the Worker (preserves WebSocket upgrades).
  if (env.BACKEND) {
    try {
      return await env.BACKEND.fetch(forwardable(request, url));
    } catch (error) {
      console.error('backend_unreachable', error);
      return jsonError(502, 'backend_unreachable', 'The realtime backend did not answer. Try again shortly.');
    }
  }

  // 3. Last resort: plain origin fetch. HTTP works, WebSockets will not.
  const origin = (env.BACKEND_ORIGIN ?? '').trim().replace(/\/$/, '');
  if (!origin) {
    return jsonError(
      503,
      'backend_not_configured',
      'No CANVAS binding, BACKEND service binding or BACKEND_ORIGIN is configured for this Pages project.',
    );
  }
  try {
    return await fetch(origin + url.pathname + url.search, forwardable(request, url));
  } catch (error) {
    console.error('backend_unreachable', error);
    return jsonError(502, 'backend_unreachable', 'The realtime backend did not answer. Try again shortly.');
  }
};
