import type { Env } from './env';
import {
  adminCookie,
  clearAdminCookie,
  handleFor,
  resolveSession,
  safeEqual,
  sessionCookie,
  signAdmin,
  signedSessionValue,
  verifySessionToken,
} from './session';
import { readConfig } from './durable-object';

/* -------------------------------------------------------------------------- */
/*                                 environment                                 */
/* -------------------------------------------------------------------------- */

/**
 * The same routing core serves two deployments:
 *
 *  1. `worker/index.ts` - the Worker that owns the Durable Object and (optionally)
 *     the static assets. This is the canonical Cloudflare Workers deployment.
 *  2. `functions/` on Cloudflare Pages - a thin proxy that uses a service binding
 *     to reach the same Durable Object. Pages is used as the public origin when
 *     workers.dev is not a good fit (custom domains, corporate networks, DNS).
 */
export type AppEnv = Env & {
  /** Optional service binding used by the Pages Functions proxy. */
  BACKEND?: Fetcher;
  ASSETS?: Fetcher;
};

/* -------------------------------------------------------------------------- */
/*                                    CORS                                    */
/* -------------------------------------------------------------------------- */

function allowedOrigins(env: AppEnv): string[] {
  return (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * The API is same-origin by default. Extra origins are enabled explicitly through
 * ALLOWED_ORIGINS so the static GitHub Pages build can talk to the API without
 * opening it to the whole internet.
 */
function corsHeaders(request: Request, env: AppEnv): Record<string, string> | null {
  const origin = request.headers.get('Origin');
  if (!origin) return {}; // non-browser client (curl, tests): no CORS involved
  const self = new URL(request.url).origin;
  if (origin === self || allowedOrigins(env).includes(origin)) {
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
      vary: 'Origin',
    };
  }
  return null;
}

function jsonResponse(
  body: unknown,
  status: number,
  request: Request,
  env: AppEnv,
  extraHeaders: Record<string, string> = {},
): Response {
  const cors = corsHeaders(request, env);
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(cors ?? {}),
      ...extraHeaders,
    },
  });
}

function isSecure(request: Request): boolean {
  return new URL(request.url).protocol === 'https:';
}

function canvasStub(env: AppEnv): DurableObjectStub {
  return env.CANVAS.get(env.CANVAS.idFromName('main'));
}

async function requireAdmin(
  request: Request,
  env: AppEnv,
): Promise<{ ok: true; by: string } | { ok: false; response: Response }> {
  if (!env.ADMIN_TOKEN) {
    return {
      ok: false,
      response: jsonResponse(
        { error: 'admin_disabled', message: 'No ADMIN_TOKEN is configured on this deployment.' },
        503,
        request,
        env,
      ),
    };
  }
  const session = await resolveSession(request, env.SESSION_SECRET);
  if (!session.isAdmin) {
    return {
      ok: false,
      response: jsonResponse({ error: 'unauthorized', message: 'Admin sign-in required.' }, 401, request, env),
    };
  }
  return { ok: true, by: 'admin' };
}

/** Very small per-isolate throttle for admin login attempts. */
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function throttleLogin(key: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(key, { count: 1, resetAt: now + 5 * 60_000 });
    return true;
  }
  entry.count += 1;
  return entry.count <= 10;
}

/**
 * True when the browser is calling this API from a different origin - for example
 * the static GitHub Pages build talking to the Worker. Such requests need
 * `SameSite=None` cookies to survive, which is why the flag is derived from the
 * Origin header instead of being hard-coded.
 */
function isCrossSite(request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  return origin !== new URL(request.url).origin;
}

/* -------------------------------------------------------------------------- */
/*                                    routes                                  */
/* -------------------------------------------------------------------------- */

async function handleApi(request: Request, env: AppEnv, url: URL): Promise<Response> {
  const path = url.pathname;

  if (request.method === 'OPTIONS') {
    const cors = corsHeaders(request, env);
    if (!cors) return new Response('Origin not allowed', { status: 403 });
    return new Response(null, { status: 204, headers: cors });
  }

  /* ------------------------------- session ------------------------------- */
  if (path === '/api/session' && request.method === 'GET') {
    const { sessionId, issueCookie, isAdmin } = await resolveSession(request, env.SESSION_SECRET);
    const extra: Record<string, string> = {};
    if (issueCookie) {
      extra['set-cookie'] = sessionCookie(
        await signedSessionValue(env.SESSION_SECRET, sessionId),
        isSecure(request),
        isCrossSite(request),
      );
    }
    const info = await canvasStub(env).fetch('https://do/info');
    const data = (await info.json()) as {
      config: { cooldownMs: number; width: number; height: number; palette: string[]; canvasName: string };
      recent: unknown;
    };
    const cors = corsHeaders(request, env) ?? {};
    const crossSite = isCrossSite(request);
    return jsonResponse(
      {
        handle: await handleFor(sessionId),
        isAdmin,
        adminEnabled: Boolean(env.ADMIN_TOKEN),
        cooldownMs: data.config?.cooldownMs ?? 30_000,
        canvas: {
          width: data.config?.width,
          height: data.config?.height,
          palette: data.config?.palette,
          name: data.config?.canvasName,
        },
        recent: data.recent ?? [],
        // Only handed out to browser origins we explicitly trust. It is the same
        // HMAC-signed value the cookie holds, so a third party cannot forge it.
        ...(crossSite
          ? { token: await signedSessionValue(env.SESSION_SECRET, sessionId), crossSite: true }
          : {}),
      },
      200,
      request,
      env,
      { ...extra, ...cors },
    );
  }

  /* --------------------------------- ws ---------------------------------- */
  if (path === '/ws') {
    // Cross-origin builds (GitHub Pages) cannot rely on a third-party cookie, so they
    // pass the signed session token in the query string instead. Both paths end in the
    // same HMAC verification.
    const tokenSession = await verifySessionToken(env.SESSION_SECRET, url.searchParams.get('token'));
    const resolved = await resolveSession(request, env.SESSION_SECRET);
    const sessionId = tokenSession ?? (resolved.issueCookie ? null : resolved.sessionId);
    const isAdmin = resolved.isAdmin;
    if (!sessionId) {
      return jsonResponse(
        { error: 'no_session', message: 'Load /api/session first so the server can issue a session.' },
        401,
        request,
        env,
      );
    }
    const origin = request.headers.get('Origin');
    if (origin) {
      const self = new URL(request.url).origin;
      if (origin !== self && !allowedOrigins(env).includes(origin)) {
        return new Response('Origin not allowed', { status: 403 });
      }
    }
    const sinceParam = url.searchParams.get('since') ?? '0';
    const target = new URL('https://do/ws');
    target.searchParams.set('sid', sessionId);
    target.searchParams.set('since', /^\d{1,12}$/.test(sinceParam) ? sinceParam : '0');
    if (isAdmin) target.searchParams.set('admin', '1');

    // The upgrade request is forwarded verbatim so the 101 reaches the browser.
    return canvasStub(env).fetch(new Request(target.toString(), request));
  }

  /* -------------------------------- canvas ------------------------------- */
  if (path === '/api/export.png' || path === '/api/snapshot.png') {
    const scale = Math.min(16, Math.max(1, Number.parseInt(url.searchParams.get('scale') ?? '1', 10) || 1));
    const doPath =
      path === '/api/export.png'
        ? `https://do/export.png?scale=${scale}`
        : `https://do/snapshot.png?scale=${scale}&id=${Math.max(0, Number.parseInt(url.searchParams.get('id') ?? '0', 10) || 0)}`;
    const res = await canvasStub(env).fetch(doPath);
    return new Response(res.body, {
      status: res.status,
      headers: { ...Object.fromEntries(res.headers), ...(corsHeaders(request, env) ?? {}) },
    });
  }

  if (path === '/api/history' && request.method === 'GET') {
    const since = Math.max(0, Number.parseInt(url.searchParams.get('since') ?? '0', 10) || 0);
    const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '60', 10) || 60));
    const res = await canvasStub(env).fetch(`https://do/history?since=${since}&limit=${limit}`);
    return jsonResponse(await res.json(), 200, request, env);
  }

  if (path === '/api/snapshots' && request.method === 'GET') {
    const res = await canvasStub(env).fetch('https://do/snapshots');
    return jsonResponse(await res.json(), 200, request, env);
  }

  /* -------------------------------- admin -------------------------------- */
  if (path === '/api/admin/login' && request.method === 'POST') {
    if (!env.ADMIN_TOKEN) {
      return jsonResponse({ error: 'admin_disabled', message: 'Admin is disabled on this deployment.' }, 503, request, env);
    }
    const ipish = request.headers.get('cf-connecting-ip') ?? 'local';
    if (!throttleLogin(ipish)) {
      return jsonResponse({ error: 'rate_limited', message: 'Too many attempts. Try again in a few minutes.' }, 429, request, env);
    }
    let body: { token?: unknown } = {};
    try {
      body = (await request.json()) as { token?: unknown };
    } catch {
      return jsonResponse({ error: 'bad_request', message: 'Expected a JSON body.' }, 400, request, env);
    }
    const token = typeof body.token === 'string' ? body.token : '';
    if (!token || !safeEqual(token, env.ADMIN_TOKEN)) {
      return jsonResponse({ error: 'unauthorized', message: 'Wrong admin token.' }, 401, request, env);
    }
    return jsonResponse({ ok: true }, 200, request, env, {
      'set-cookie': adminCookie(await signAdmin(env.SESSION_SECRET), isSecure(request), isCrossSite(request)),
    });
  }

  if (path === '/api/admin/logout' && request.method === 'POST') {
    return jsonResponse({ ok: true }, 200, request, env, { 'set-cookie': clearAdminCookie(isSecure(request)) });
  }

  if (path === '/api/admin/action' && request.method === 'POST') {
    const auth = await requireAdmin(request, env);
    if (!auth.ok) return auth.response;
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonResponse({ error: 'bad_request', message: 'Expected a JSON body.' }, 400, request, env);
    }
    const allowed = ['reset', 'notice', 'clearNotice', 'undo', 'resolveReport', 'rename'] as const;
    const action = String(body.action ?? '');
    if (!allowed.includes(action as (typeof allowed)[number])) {
      return jsonResponse({ error: 'bad_request', message: 'Unknown action.' }, 400, request, env);
    }
    const res = await canvasStub(env).fetch('https://do/admin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, action, by: auth.by }),
    });
    const result = (await res.json()) as { ok: boolean; message: string };
    return jsonResponse(result, result.ok ? 200 : 400, request, env);
  }

  if (path === '/api/admin/view' && request.method === 'GET') {
    const auth = await requireAdmin(request, env);
    if (!auth.ok) return auth.response;
    const res = await canvasStub(env).fetch('https://do/adminview');
    return jsonResponse(await res.json(), 200, request, env);
  }

  /* ------------------------------- health -------------------------------- */
  if (path === '/api/health') {
    const config = readConfig(env);
    return jsonResponse(
      {
        ok: true,
        width: config.width,
        height: config.height,
        cooldownSeconds: config.cooldownMs / 1000,
        time: Date.now(),
      },
      200,
      request,
      env,
    );
  }

  return jsonResponse({ error: 'not_found', message: `No API route for ${path}` }, 404, request, env);
}

/* -------------------------------------------------------------------------- */
/*                                   entry                                    */
/* -------------------------------------------------------------------------- */

export async function handleRequest(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') {
    try {
      return await handleApi(request, env, url);
    } catch (error) {
      console.error('api_error', error);
      const detail = env.DEBUG_ERRORS === '1' && error instanceof Error ? `${error.name}: ${error.message}` : undefined;
      return jsonResponse(
        {
          error: 'server_error',
          message: 'Something went wrong on our side. Please retry.',
          ...(detail ? { detail } : {}),
        },
        500,
        request,
        env,
      );
    }
  }

  if (url.pathname === '/healthz') {
    return new Response('ok', { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
  }

  if (env.ASSETS) {
    // Static front-end (Vite build output); SPA fallback is configured in wrangler.jsonc.
    return env.ASSETS.fetch(request);
  }
  return new Response('Not found', { status: 404 });
}
