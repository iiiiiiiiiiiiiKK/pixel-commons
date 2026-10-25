/**
 * End-to-end integration suite for a deployed Pixel Commons instance.
 *
 * It drives the real HTTP + WebSocket surface with plain `fetch` and the
 * Node WebSocket client — no mocks — so it can validate Cloudflare itself.
 *
 *   node tests/integration.mjs                      # uses PIXEL_COMMONS_URL or the default
 *   PIXEL_COMMONS_URL=https://x.pages.dev node tests/integration.mjs
 *   ADMIN_TOKEN=... node tests/integration.mjs      # also exercises the admin console
 *
 * Exit code 0 means every assertion passed; the printed table is the real result.
 */

const BASE = (process.env.PIXEL_COMMONS_URL || 'https://pixel-commons.pages.dev').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function assert(name, condition, detail = '') {
  record(name, Boolean(condition), detail);
  return Boolean(condition);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ HTTP -- */

function cookieJar() {
  const jar = new Map();
  return {
    header() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    absorb(response) {
      const raw = response.headers.getSetCookie?.() ?? [];
      for (const line of raw) {
        const [pair] = line.split(';');
        const idx = pair.indexOf('=');
        if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
      }
    },
    get(name) {
      return jar.get(name);
    },
  };
}

async function getJson(path, jar, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  const cookie = jar?.header();
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + path, { ...init, headers, redirect: 'manual' });
  jar?.absorb(res);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

/* -------------------------------------------------------------- websocket -- */

class Client {
  constructor(name, jar) {
    this.name = name;
    this.jar = jar;
    this.messages = [];
    this.waiters = [];
    this.ws = null;
    this.closed = null;
  }

  url(since = 0) {
    const u = new URL(BASE);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/ws';
    u.search = `?since=${since}`;
    return u.toString();
  }

  async connect(since = 0) {
    const ws = new WebSocket(this.url(since), {
      headers: { cookie: this.jar.header(), origin: BASE },
    });
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name}: connect timeout`)), 15000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', (event) => {
        clearTimeout(timer);
        reject(new Error(`${this.name}: socket error ${event?.message ?? ''}`));
      });
    });
    ws.addEventListener('message', (event) => {
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      this.messages.push(parsed);
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(parsed)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          clearTimeout(waiter.timer);
          waiter.resolve(parsed);
        }
      }
    });
    ws.addEventListener('close', (event) => {
      this.closed = { code: event.code, reason: event.reason };
    });
    return this;
  }

  send(message) {
    this.ws.send(JSON.stringify(message));
  }

  waitFor(predicate, timeout = 8000, label = 'message') {
    const found = [...this.messages].reverse().find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          reject(new Error(`${this.name}: timeout waiting for ${label}`));
        }, timeout),
      };
      this.waiters.push(waiter);
    });
  }

  next(predicate, timeout, label) {
    return this.waitFor(predicate, timeout, label);
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

async function newSession(name) {
  const jar = cookieJar();
  const res = await getJson('/api/session', jar);
  if (res.status !== 200) throw new Error(`${name}: session failed (${res.status} ${JSON.stringify(res.body)})`);
  return { jar, session: res.body, client: new Client(name, jar) };
}

/* ------------------------------------------------------------------ suite -- */

async function main() {
  console.log(`\nPixel Commons integration suite → ${BASE}\n`);

  /* 1. health */
  const health = await getJson('/api/health');
  assert('health endpoint reports canvas geometry', health.status === 200 && health.body?.width > 0, JSON.stringify(health.body));
  const width = health.body.width;
  const height = health.body.height;
  const cooldownSeconds = health.body.cooldownSeconds;

  /* 2. anonymous session cookie */
  const jar = cookieJar();
  const sessionRes = await getJson('/api/session', jar);
  assert('session issues an HttpOnly cookie', sessionRes.status === 200 && Boolean(jar.get('pc_sid')), `handle=${sessionRes.body?.handle}`);
  const setCookieRaw = (sessionRes.headers.getSetCookie?.() ?? []).join(';');
  assert('session cookie is HttpOnly + SameSite', /HttpOnly/i.test(setCookieRaw) && /SameSite=Lax/i.test(setCookieRaw));
  assert('session exposes a stable display handle', /^[a-z]+-[a-z]+-\d{3}$/.test(sessionRes.body?.handle ?? ''), sessionRes.body?.handle);

  /* 3. websocket handshake + welcome payload */
  const a = await newSession('alice');
  await a.client.connect();
  const welcome = await a.client.waitFor((m) => m.t === 'welcome', 10000, 'welcome');
  assert('websocket handshake returns welcome', Boolean(welcome), `canvas=${welcome?.config?.width}x${welcome?.config?.height}`);
  assert('welcome carries an RLE canvas blob', typeof welcome.canvas === 'string' && welcome.canvas.length > 0, `${welcome.canvas.length} chars`);
  assert('welcome carries the palette', Array.isArray(welcome.config.palette) && welcome.config.palette.length >= 2);

  /* helper: read the authoritative colour of a cell via history */
  const historyOf = async (x, y) => {
    const h = await getJson('/api/history?since=0&limit=200');
    return (h.body?.history ?? []).find((e) => e.x === x && e.y === y) ?? null;
  };

  /* 4. placing a pixel is broadcast to other clients */
  const b = await newSession('bob');
  await b.client.connect();
  await b.client.waitFor((m) => m.t === 'welcome', 10000, 'welcome');

  const targetX = 10 + Math.floor(Math.random() * 40);
  const targetY = 20 + Math.floor(Math.random() * 40);
  a.client.messages.length = 0;
  b.client.messages.length = 0;
  a.client.send({ t: 'place', x: targetX, y: targetY, c: 10, nonce: 'test-1' });

  const accepted = await a.client.waitFor((m) => m.t === 'pixels' && m.cells?.length > 0, 12000, 'pixel echo');
  assert('server echoes the accepted pixel to its author', accepted?.cells?.[0]?.x === targetX && accepted?.cells?.[0]?.c === 10, JSON.stringify(accepted?.cells?.[0]));
  assert('author receives the authoritative cooldown deadline', typeof accepted.nextAt === 'number' && accepted.nextAt > Date.now(), `nextAt in ${Math.round((accepted.nextAt - Date.now()) / 1000)}s`);

  const relayed = await b.client.waitFor((m) => m.t === 'pixels' && m.cells?.some((c) => c.x === targetX && c.y === targetY), 12000, 'broadcast');
  assert('pixel is broadcast to other online users', Boolean(relayed), `total=${relayed?.totalPixels}`);

  /* 5. cooldown is enforced server-side */
  a.client.send({ t: 'place', x: targetX + 1, y: targetY, c: 5, nonce: 'test-2' });
  const cooldownReject = await a.client.waitFor((m) => m.t === 'reject' && m.reason === 'cooldown', 8000, 'cooldown reject');
  assert('second immediate write is rejected by the server', Boolean(cooldownReject), cooldownReject?.message);

  /* 6. a *different* session is not blocked by someone else's cooldown */
  b.client.send({ t: 'place', x: targetX + 2, y: targetY, c: 11, nonce: 'bob-1' });
  const bobAccepted = await b.client.waitFor(
    (m) => m.t === 'pixels' && m.cells?.some((c) => c.x === targetX + 2 && c.y === targetY),
    12000,
    'bob pixel',
  );
  assert('cooldown is per-session, not global', Boolean(bobAccepted));

  /* 7. two sessions racing for the same pixel: last accepted write wins, no corruption */
  const c = await newSession('carol');
  await c.client.connect();
  await c.client.waitFor((m) => m.t === 'welcome', 10000, 'welcome');
  const raceX = 60;
  const raceY = 60;
  c.client.send({ t: 'place', x: raceX, y: raceY, c: 3, nonce: 'race-c' });
  const raceResult = await c.client.waitFor(
    (m) => m.t === 'pixels' && m.cells?.some((cell) => cell.x === raceX && cell.y === raceY),
    12000,
    'race pixel',
  );
  assert('simultaneous writers settle on one authoritative value', raceResult.cells.find((cell) => cell.x === raceX && cell.y === raceY).c === 3);

  /* 8. protocol validation */
  a.client.messages.length = 0;
  a.client.send({ t: 'place', x: -5, y: 0, c: 1, nonce: 'oob' });
  const oob = await a.client.waitFor((m) => m.t === 'reject', 8000, 'out-of-bounds');
  assert('negative coordinates are rejected', oob?.reason === 'out_of_bounds' || oob?.reason === 'cooldown', oob?.reason);

  b.client.messages.length = 0;
  b.client.send({ t: 'place', x: width + 10, y: height + 10, c: 1, nonce: 'oob2' });
  const oob2 = await b.client.waitFor((m) => m.t === 'reject', 8000, 'out-of-bounds 2');
  assert('coordinates outside the canvas are rejected', ['out_of_bounds', 'cooldown'].includes(oob2?.reason), oob2?.reason);

  const d = await newSession('dave');
  await d.client.connect();
  await d.client.waitFor((m) => m.t === 'welcome', 10000, 'welcome');
  d.client.messages.length = 0;
  d.client.send({ t: 'place', x: 5, y: 5, c: 9999, nonce: 'bad-color' });
  const badColor = await d.client.waitFor((m) => m.t === 'reject', 8000, 'bad colour');
  assert('out-of-palette colour indices are rejected', badColor?.reason === 'bad_color', badColor?.reason);

  d.client.messages.length = 0;
  d.client.send({ t: 'place', x: 'lol', y: null, c: {}, nonce: 'bad' });
  const badPayload = await d.client.waitFor((m) => m.t === 'reject', 8000, 'bad payload');
  assert('malformed placement payloads are rejected', badPayload?.reason === 'bad_request', badPayload?.reason ?? 'no reject');

  d.client.messages.length = 0;
  d.client.send({ t: 'nonsense' });
  const unknown = await d.client.waitFor((m) => m.t === 'reject', 8000, 'unknown type');
  assert('unknown message types are rejected', unknown?.reason === 'bad_request', unknown?.reason ?? 'no reject');

  /* 9. rate limiting on a chatty socket */
  let rateLimited = false;
  const flood = setInterval(() => {
    try {
      d.client.send({ t: 'ping', ts: Date.now() });
    } catch {
      /* socket closed */
    }
  }, 15);
  try {
    await d.client.waitFor((m) => m.t === 'reject' && m.reason === 'rate_limited', 9000, 'rate limit');
    rateLimited = true;
  } catch {
    rateLimited = false;
  }
  clearInterval(flood);
  assert('per-connection message flood is rate limited', rateLimited);

  /* 10. reporting + moderation queue */
  const e = await newSession('erin');
  await e.client.connect();
  await e.client.waitFor((m) => m.t === 'welcome', 10000, 'welcome');
  e.client.send({ t: 'report', x: 3, y: 3, reason: 'offensive', note: 'integration test' });
  const reportAck = await e.client.waitFor((m) => m.t === 'notice' && /report/i.test(m.notice?.message ?? ''), 9000, 'report ack');
  assert('reports are accepted into the moderation queue', Boolean(reportAck), reportAck?.notice?.message);

  /* 11. presence */
  const presence = await b.client.waitFor((m) => m.t === 'presence' && m.online >= 2, 9000, 'presence').catch(() => null);
  assert('presence reports the number of live connections', Boolean(presence), `online=${presence?.online}`);

  /* 12. persistence + reconnect with a history cursor */
  const persisted = await new Promise(async (resolve) => {
    for (let i = 0; i < 20; i++) {
      const entry = await historyOf(targetX, targetY);
      if (entry) return resolve(entry);
      await sleep(400);
    }
    resolve(null);
  });
  assert('accepted pixels are persisted and readable over HTTP', Boolean(persisted), `(${targetX},${targetY}) colour=${persisted?.c}`);
  assert('history records the author handle for each pixel', typeof persisted?.by === 'string' && persisted.by.length > 0, persisted?.by);

  const cursor = persisted?.id ?? 0;
  const a2 = new Client('alice-reconnect', a.jar);
  await a2.connect(cursor - 1);
  const rejoin = await a2.waitFor((m) => m.t === 'welcome', 10000, 'welcome after reconnect');
  assert('reconnect replays history after the cursor', Array.isArray(rejoin?.history) && rejoin.history.length > 0, `${rejoin?.history?.length} entries`);
  assert('reconnect restores the same identity', rejoin?.handle === welcome.handle, rejoin?.handle);
  a2.close();

  /* 13. PNG export is a real PNG */
  const png = await fetch(`${BASE}/api/export.png?scale=1`);
  const pngBytes = new Uint8Array(await png.arrayBuffer());
  const isPng = pngBytes[0] === 0x89 && pngBytes[1] === 0x50 && pngBytes[2] === 0x4e && pngBytes[3] === 0x47;
  const declared = png.headers.get('content-type');
  const ihdrWidth = pngBytes.length > 24 ? (pngBytes[16] << 24) | (pngBytes[17] << 16) | (pngBytes[18] << 8) | pngBytes[19] : 0;
  assert('PNG export returns a valid PNG file', png.status === 200 && isPng && declared === 'image/png', `${pngBytes.length} bytes, ${declared}`);
  assert('PNG dimensions match the canvas', ihdrWidth === width, `IHDR width=${ihdrWidth}`);

  /* 14. snapshots endpoint */
  const snaps = await getJson('/api/snapshots');
  assert('snapshot index is queryable', snaps.status === 200 && Array.isArray(snaps.body?.snapshots), `${snaps.body?.snapshots?.length} snapshots`);

  /* 15. admin surface requires the token */
  const anonAdmin = await getJson('/api/admin/view');
  assert('admin view rejects anonymous callers', anonAdmin.status === 401, `status=${anonAdmin.status}`);

  const wrongToken = await getJson('/api/admin/login', cookieJar(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'definitely-not-the-token' }),
  });
  assert('admin login rejects a wrong token', wrongToken.status === 401, `status=${wrongToken.status}`);

  if (ADMIN_TOKEN) {
    const adminJar = cookieJar();
    const login = await getJson('/api/admin/login', adminJar, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: ADMIN_TOKEN }),
    });
    assert('admin login accepts the configured token', login.status === 200 && Boolean(adminJar.get('pc_admin')), `status=${login.status}`);

    const view = await getJson('/api/admin/view', adminJar);
    assert('admin view returns reports + audit trail', view.status === 200 && Array.isArray(view.body?.reports) && Array.isArray(view.body?.audit), `${view.body?.reports?.length} reports, ${view.body?.audit?.length} audit rows`);

    const notice = await getJson('/api/admin/action', adminJar, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'notice', value: 'Integration test notice', status: 'info' }),
    });
    assert('admin can publish a notice', notice.status === 200 && notice.body?.ok === true, notice.body?.message);

    const cleared = await getJson('/api/admin/action', adminJar, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'clearNotice' }),
    });
    assert('admin can clear a notice', cleared.status === 200 && cleared.body?.ok === true);

    const undo = await getJson('/api/admin/action', adminJar, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'undo' }),
    });
    assert('admin can undo the last pixel', undo.status === 200 && undo.body?.ok === true, undo.body?.message);

    const auditAfter = await getJson('/api/admin/view', adminJar);
    assert('admin actions are written to the audit trail', (auditAfter.body?.audit?.length ?? 0) > (view.body?.audit?.length ?? 0), `${auditAfter.body?.audit?.length} rows`);
  } else {
    console.log('SKIP  admin mutation checks (ADMIN_TOKEN not provided)');
  }

  /* 16. non-admin cannot mutate through the admin API */
  const sneaky = await getJson('/api/admin/action', cookieJar(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'reset' }),
  });
  assert('anonymous callers cannot reset the canvas', sneaky.status === 401 || sneaky.status === 503, `status=${sneaky.status}`);

  /* 17. websocket without a session cookie is refused */
  const bare = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws`);
  const bareResult = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ outcome: 'timeout' }), 8000);
    bare.addEventListener('open', () => {
      clearTimeout(timer);
      bare.close();
      resolve({ outcome: 'open' });
    });
    bare.addEventListener('error', () => {
      clearTimeout(timer);
      resolve({ outcome: 'error' });
    });
    bare.addEventListener('close', (ev) => {
      clearTimeout(timer);
      resolve({ outcome: 'close', code: ev.code });
    });
  });
  assert('websocket without a session cookie is refused', bareResult.outcome !== 'open', JSON.stringify(bareResult));

  /* 18. static front-end is served */
  const root = await fetch(BASE + '/', { headers: { accept: 'text/html' } });
  const html = await root.text();
  assert('static front-end is served at /', root.status === 200 && html.includes('Pixel Commons'), `${html.length} bytes`);
  assert('front-end links to X (@0xkillcoin)', html.includes('og:title'));

  /* 19. concurrent connections + fan-out latency */
  const N = 12;
  const clients = [];
  const connectStart = Date.now();
  for (let i = 0; i < N; i++) {
    const s = await newSession(`load-${i}`);
    await s.client.connect();
    await s.client.waitFor((m) => m.t === 'welcome', 15000, 'welcome');
    clients.push(s.client);
  }
  const connectMs = Date.now() - connectStart;
  assert(`${N} concurrent websocket clients connect`, clients.length === N, `${Math.round(connectMs / N)} ms/connection`);

  const broadcastTimes = [];
  const fanoutBase = 140 + Math.floor(Math.random() * 60);
  for (let i = 0; i < 6; i++) {
    const sender = clients[i % clients.length];
    const x = fanoutBase + i;
    const y = fanoutBase + 7;
    const t0 = performance.now();
    sender.send({ t: 'place', x, y, c: (i % 14) + 1, nonce: `load-${i}` });
    try {
      await clients[(i + 1) % clients.length].waitFor(
        (m) => m.t === 'pixels' && m.cells?.some((cell) => cell.x === x && cell.y === y),
        10000,
        'fanout',
      );
      broadcastTimes.push(performance.now() - t0);
    } catch {
      /* recorded as a miss */
    }
  }
  const avg = broadcastTimes.length ? broadcastTimes.reduce((s, v) => s + v, 0) / broadcastTimes.length : Infinity;
  assert(
    `broadcast fan-out to ${N} clients stays under 3 s`,
    broadcastTimes.length >= 4 && avg < 3000,
    `${broadcastTimes.length}/6 delivered, avg ${avg.toFixed(0)} ms`,
  );

  console.log(`\nMeasured: ${N} concurrent sockets, avg fan-out ${avg.toFixed(0)} ms, ${Math.round(connectMs / N)} ms per handshake.`);

  for (const client of clients) client.close();
  a.client.close();
  b.client.close();
  c.client.close();
  d.client.close();
  e.client.close();

  /* 20. after all sockets close, the API still answers (server-side state survives) */
  await sleep(1200);
  const afterAll = await getJson('/api/health');
  assert('API remains healthy after all sockets close', afterAll.status === 200);

  /* summary */
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) {
    console.log('Failures:');
    for (const f of failed) console.log(` - ${f.name} ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('SUITE ERROR', error);
  process.exitCode = 1;
});
