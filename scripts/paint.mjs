/**
 * Canvas seeding script — paints a small starter scene.
 *
 * Pixel Commons enforces one pixel per session per cooldown, and this script
 * respects that rule: it opens one short-lived session per pixel, exactly what a
 * real crowd of visitors would do, instead of trying to bypass the server.
 *
 *   node scripts/paint.mjs                # paint onto the deployed canvas
 *   node scripts/paint.mjs --dry-run      # only report how many pixels it would paint
 *   PIXEL_COMMONS_URL=http://127.0.0.1:8787 node scripts/paint.mjs
 */

const BASE = (process.env.PIXEL_COMMONS_URL || 'https://pixel-commons.pages.dev').replace(/\/$/, '');
const DRY = process.argv.includes('--dry-run');
const W = 256;
const H = 256;

/* Palette indices from shared/rle.ts (PICO-8 colours). */
const C = {
  black: 0,
  navy: 1,
  plum: 2,
  forest: 3,
  brown: 4,
  slate: 5,
  grey: 6,
  white: 7,
  red: 8,
  orange: 9,
  yellow: 10,
  green: 11,
  sky: 12,
  lilac: 13,
  pink: 14,
  peach: 15,
};

/**
 * A deliberately sparse scene: it stays readable as pixel art while costing only
 * a few hundred pixels, which is what makes it a realistic seed for a shared
 * canvas rather than a pre-rendered image dumped by the owner.
 */
function buildArt() {
  const px = new Map();
  const set = (x, y, c) => {
    if (x >= 0 && y >= 0 && x < W && y < H) px.set(y * W + x, c);
  };

  // --- sun (arc of pixels, not a filled disc) ------------------------------
  const sunX = 128;
  const sunY = 104;
  for (let a = 0; a < 360; a += 4) {
    const rad = (a * Math.PI) / 180;
    for (const radius of [18, 22, 26]) {
      set(Math.round(sunX + Math.cos(rad) * radius), Math.round(sunY + Math.sin(rad) * radius), radius === 26 ? C.peach : C.yellow);
    }
  }
  for (let y = sunY - 14; y <= sunY + 14; y++) {
    for (let x = sunX - 14; x <= sunX + 14; x++) {
      const d = Math.hypot(x - sunX, y - sunY);
      if (d < 14 && (x + y) % 3 === 0) set(x, y, C.yellow);
      else if (d < 9) set(x, y, C.white);
    }
  }

  // --- horizon line -------------------------------------------------------
  for (let x = 16; x < 240; x++) {
    set(x, 140, C.orange);
    if (x % 7 < 3) set(x, 141, C.red);
  }

  // --- mountain ridges (outlines) ----------------------------------------
  const ridge = (baseY, height, colour, step = 1) => {
    let prevY = baseY;
    for (let x = 8; x < 248; x += step) {
      const y = Math.round(baseY - Math.abs(Math.sin(x / 23)) * height);
      set(x, y, colour);
      // connect with the previous column so the ridge is continuous
      for (let fill = Math.min(prevY, y); fill <= Math.max(prevY, y); fill++) {
        if (Math.abs(fill - y) <= 2) set(x, fill, colour);
      }
      prevY = y;
    }
  };
  ridge(150, 44, C.slate);
  ridge(160, 30, C.plum);

  // --- snow caps on the tallest peaks ------------------------------------
  for (const peakX of [40, 118, 196]) {
    for (let dy = 0; dy < 5; dy++) {
      for (let dx = -4 + dy; dx <= 4 - dy; dx++) set(peakX + dx, 106 + dy, C.white);
    }
  }

  // --- water: dashed ripples ---------------------------------------------
  for (let y = 168; y < 220; y += 4) {
    for (let x = 12 + ((y / 4) % 3) * 4; x < 244; x += 9) {
      set(x, y, C.sky);
      set(x + 1, y, C.sky);
      if (y % 8 === 0) set(x + 2, y, C.navy);
    }
  }

  // --- hills --------------------------------------------------------------
  // Deliberately sparse: one outline column every 3 px plus a few grass ticks.
  // A dense fill would cost thousands of pixels and dominate a shared canvas.
  for (let x = 0; x < W; x += 3) {
    const hill = 224 + Math.round(Math.sin(x / 26) * 5);
    set(x, hill, C.green);
    set(x + 1, hill, C.forest);
    if (x % 9 === 0) set(x, hill + 2, C.forest);
  }

  // --- trees --------------------------------------------------------------
  for (const tx of [24, 46, 208, 232]) {
    for (let dy = 0; dy < 14; dy++) {
      const spread = Math.floor(dy / 3);
      for (let dx = -spread; dx <= spread; dx++) set(tx + dx, 206 + dy, C.forest);
    }
    for (let dy = 0; dy < 6; dy++) set(tx, 220 + dy, C.brown);
  }

  // --- signature heart ----------------------------------------------------
  const heart = ['0110011001', '1111111111', '1111111111', '0111111110', '0011111100', '0001111000', '0000110000'];
  heart.forEach((row, ry) => {
    row.split('').forEach((bit, rx) => {
      if (bit === '1') set(30 + rx, 176 + ry, C.pink);
    });
  });

  // --- a tiny "PC" monogram, bottom-right --------------------------------
  const mono = [
    '1111 1111',
    '1000 1000',
    '1110 1000',
    '1000 1000',
    '1000 1111',
  ];
  mono.forEach((row, ry) => {
    row.split('').forEach((bit, rx) => {
      if (bit === '1') set(196 + rx, 178 + ry, C.white);
    });
  });

  return px;
}

async function paintPixel(colour, x, y) {
  const sessionRes = await fetch(`${BASE}/api/session`);
  if (!sessionRes.ok) throw new Error(`session failed: ${sessionRes.status}`);
  const cookies = (sessionRes.headers.getSetCookie?.() ?? []).map((v) => v.split(';')[0]).join('; ');

  const url = new URL(BASE);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';

  const ws = new WebSocket(url.toString(), { headers: { cookie: cookies, origin: BASE } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws timeout')), 20000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('ws error'));
    });
  });

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('place timeout')), 20000);
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.t === 'welcome') ws.send(JSON.stringify({ t: 'place', x, y, c: colour, nonce: `${x}-${y}` }));
      else if (msg.t === 'pixels') {
        clearTimeout(timer);
        resolve('ok');
      } else if (msg.t === 'reject') {
        clearTimeout(timer);
        resolve(msg.reason);
      }
    });
  });

  ws.close();
  return result;
}

const art = buildArt();
console.log(`artwork: ${art.size} pixels on a ${W}x${H} canvas → ${BASE}`);
if (DRY) process.exit(0);

const entries = [...art.entries()];
let done = 0;
let rejected = 0;
let failed = 0;
const started = Date.now();

// Modest parallelism — like a handful of visitors arriving together. Each pixel
// still goes through a separate session, so per-session cooldown stays honest.
const CONCURRENCY = 10;
let index = 0;

async function worker() {
  while (index < entries.length) {
    const i = index++;
    const [idx, colour] = entries[i];
    const x = idx % W;
    const y = Math.floor(idx / W);
    try {
      const result = await paintPixel(colour, x, y);
      if (result === 'ok') {
        done++;
        if (done % 40 === 0) process.stdout.write(`\rpainted ${done}/${entries.length}`);
      } else if (result === 'unchanged') {
        done++;
      } else rejected++;
    } catch {
      failed++;
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\ndone: ${done} accepted, ${rejected} rejected, ${failed} errors, ${seconds}s`);
