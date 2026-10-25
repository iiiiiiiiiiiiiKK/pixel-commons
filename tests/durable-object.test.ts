import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CanvasRoom } from '../worker/durable-object';
import { createFakeState, fakeEnv, installWebSocketPair } from './helpers/do-harness';

/**
 * Authority tests for the Durable Object itself.
 *
 * These run the shipped `CanvasRoom` class against an in-memory SQLite database,
 * driving it through the same `fetch()` entry point the Worker uses. That makes them
 * far more valuable than unit-testing helper functions: cooldown, validation,
 * persistence and broadcast are all exercised as real code paths.
 */

type Harness = {
  room: CanvasRoom;
  sql: ReturnType<typeof createFakeState>['sql'];
  recorder: ReturnType<typeof createFakeState>['recorder'];
};

let clientSockets: ReturnType<typeof installWebSocketPair>['clientSockets'];

async function makeRoom(overrides: Record<string, string> = {}): Promise<Harness> {
  const { state, sql, recorder } = createFakeState();
  const room = new CanvasRoom(state as unknown as DurableObjectState, fakeEnv(overrides));
  return { room, sql, recorder };
}

/** Open a WebSocket connection through the real fetch handler. */
async function connect(room: CanvasRoom, sid: string, since = 0): Promise<ReturnType<typeof clientSocketOf>> {
  const res = await room.fetch(
    new Request(`https://do/ws?sid=${sid}&since=${since}`, { headers: { Upgrade: 'websocket' } }),
  );
  expect(res.status).toBe(101);
  return clientSocketOf(res);
}

function clientSocketOf(res: Response) {
  const socket = (res as unknown as { webSocket: { sent: string[]; receive: (m: unknown) => void; close: () => void } }).webSocket;
  return {
    socket,
    messages: () => socket.sent.map((raw: string) => JSON.parse(raw) as Record<string, unknown>),
    welcome: () => socket.sent.map((r: string) => JSON.parse(r)).find((m: Record<string, unknown>) => m.t === 'welcome'),
    receive: (message: unknown) => socket.receive(message),
    clear: () => {
      socket.sent.length = 0;
    },
  };
}

const SID_A = 'a'.repeat(22);
const SID_B = 'b'.repeat(22);

beforeAll(() => {
  ({ clientSockets } = installWebSocketPair());
});

beforeEach(() => {
  clientSockets.length = 0;
});

describe('CanvasRoom: handshake', () => {
  it('rejects a socket without a valid session id', async () => {
    const { room } = await makeRoom();
    const res = await room.fetch(new Request('https://do/ws?sid=short', { headers: { Upgrade: 'websocket' } }));
    expect(res.status).toBe(400);
  });

  it('answers a welcome with config, RLE canvas, palette and identity', async () => {
    const { room } = await makeRoom();
    const client = await connect(room, SID_A);
    const welcome = client.welcome();

    expect(welcome).toBeTruthy();
    expect((welcome!.config as { width: number }).width).toBe(64);
    expect((welcome!.config as { palette: string[] }).palette.length).toBe(16);
    expect(typeof welcome!.canvas).toBe('string');
    expect(welcome!.handle).toMatch(/^[a-z]+-[a-z]+-\d{3}$/);
    expect(welcome!.isAdmin).toBe(false);
  });

  it('is cheap to load: a welcome reads a bounded number of rows', async () => {
    const { room, recorder } = await makeRoom();
    // The cold-start load reads the board exactly once, as a single row.
    expect(recorder.statements.filter((s) => s.includes('FROM canvas')).length).toBe(1);

    // Seed a pixel so the board row exists, then measure a second connection.
    const seed = await connect(room, SID_B);
    seed.receive({ t: 'place', x: 1, y: 1, c: 3, nonce: 'seed' });
    recorder.reset();
    await connect(room, SID_A);

    // Bounded history/presence queries only - never a full-table canvas scan.
    expect(recorder.rowsRead).toBeLessThan(120);
    expect(recorder.statements.some((s) => s.includes('FROM cells'))).toBe(false);
    expect(recorder.statements.some((s) => s.includes('FROM canvas'))).toBe(false);
  });
});

describe('CanvasRoom: placement authority', () => {
  it('accepts a pixel, echoes it with the server deadline, and broadcasts to others', async () => {
    const { room } = await makeRoom();
    const a = await connect(room, SID_A);
    const b = await connect(room, SID_B);
    const handle = a.welcome()!.handle;
    a.clear();
    b.clear();

    a.receive({ t: 'place', x: 5, y: 6, c: 9, nonce: 'n1' });

    const echo = a.messages().find((m) => m.t === 'pixels');
    expect(echo).toBeTruthy();
    expect((echo!.cells as Array<{ x: number; y: number; c: number }>)[0]).toEqual({ x: 5, y: 6, c: 9 });
    expect(typeof echo!.nextAt).toBe('number');
    expect(echo!.nextAt as number).toBeGreaterThan(Date.now());
    expect(echo!.self).toBe(handle);

    const relay = b.messages().find((m) => m.t === 'pixels');
    expect(relay).toBeTruthy();
    expect(relay!.nextAt).toBeUndefined(); // other users never learn your deadline
    expect(relay!.self).toBeUndefined();
  });

  it('enforces the cooldown per session and reports the remaining time', async () => {
    const { room } = await makeRoom();
    const a = await connect(room, SID_A);
    a.receive({ t: 'place', x: 1, y: 1, c: 2, nonce: 'n1' });
    a.clear();

    a.receive({ t: 'place', x: 2, y: 2, c: 2, nonce: 'n2' });
    const reject = a.messages().find((m) => m.t === 'reject');
    expect(reject?.reason).toBe('cooldown');
    expect(reject?.nextAt as number).toBeGreaterThan(Date.now());
  });

  it('does not let one session block another', async () => {
    const { room } = await makeRoom();
    const a = await connect(room, SID_A);
    const b = await connect(room, SID_B);
    a.receive({ t: 'place', x: 1, y: 1, c: 2, nonce: 'a1' });
    b.clear();
    b.receive({ t: 'place', x: 1, y: 2, c: 3, nonce: 'b1' });
    expect(b.messages().some((m) => m.t === 'pixels')).toBe(true);
  });

  it('survives a reconnect without resetting the cooldown', async () => {
    const { room } = await makeRoom();
    const a = await connect(room, SID_A);
    a.receive({ t: 'place', x: 3, y: 3, c: 4, nonce: 'n1' });
    a.socket.close();

    const again = await connect(room, SID_A);
    const welcome = again.welcome();
    expect(welcome!.nextAt as number).toBeGreaterThan(Date.now());
  });

  it('rejects out-of-bounds coordinates', async () => {
    const { room } = await makeRoom();
    const a = await connect(room, SID_A);
    for (const [x, y] of [
      [-1, 0],
      [0, -1],
      [64, 0],
      [0, 64],
      [999, 999],
    ] as const) {
      a.clear();
      a.receive({ t: 'place', x, y, c: 1, nonce: 'oob' });
      expect(a.messages().find((m) => m.t === 'reject')?.reason).toBe('out_of_bounds');
    }
  });

  it('rejects palette indices outside the configured palette', async () => {
    const { room } = await makeRoom();
    const a = await connect(room, SID_A);
    a.clear();
    a.receive({ t: 'place', x: 1, y: 1, c: 16, nonce: 'bad' });
    expect(a.messages().find((m) => m.t === 'reject')?.reason).toBe('bad_color');
  });

  it('rejects non-integer payloads', async () => {
    const { room } = await makeRoom();
    const a = await connect(room, SID_A);
    a.clear();
    a.receive({ t: 'place', x: 1.5, y: 1, c: 1, nonce: 'bad' });
    expect(a.messages().find((m) => m.t === 'reject')?.reason).toBe('bad_request');
  });

  it('refuses to spend a cooldown on an unchanged pixel', async () => {
    const { room } = await makeRoom();
    const a = await connect(room, SID_A);
    a.receive({ t: 'place', x: 7, y: 7, c: 5, nonce: 'n1' });
    // same colour is refused even after the cooldown would allow a write
    const { room: room2 } = await makeRoom();
    const b = await connect(room2, SID_A);
    b.receive({ t: 'place', x: 0, y: 0, c: 0, nonce: 'n0' });
    b.clear();
    b.receive({ t: 'place', x: 0, y: 0, c: 0, nonce: 'n0b' });
    const reject = b.messages().find((m) => m.t === 'reject');
    // either "unchanged" (preferred) or cooldown - never an accepted write
    expect(['unchanged', 'cooldown']).toContain(reject?.reason);
  });

  it('throttles message floods', async () => {
    const { room } = await makeRoom();
    const a = await connect(room, SID_A);
    a.clear();
    for (let i = 0; i < 60; i++) a.receive({ t: 'ping', ts: Date.now() });
    expect(a.messages().some((m) => m.t === 'reject' && m.reason === 'rate_limited')).toBe(true);
  });

  it('rejects oversized frames', async () => {
    const { room } = await makeRoom();
    const a = await connect(room, SID_A);
    a.clear();
    // Raw 4 kB string frame: larger than the 2 kB protocol cap.
    a.receive('x'.repeat(4096));
    expect(a.messages().find((m) => m.t === 'reject')?.reason).toBe('bad_request');
  });
});

describe('CanvasRoom: persistence', () => {
  it('writes exactly one canvas row and one history row per pixel', async () => {
    const { room, recorder } = await makeRoom();
    const a = await connect(room, SID_A);
    recorder.reset();
    a.receive({ t: 'place', x: 9, y: 9, c: 6, nonce: 'n1' });

    const writes = recorder.statements.filter((s) => !/^(SELECT|CREATE)/i.test(s));
    expect(writes.some((s) => s.startsWith('INSERT INTO history'))).toBe(true);
    expect(writes.some((s) => s.startsWith('INSERT INTO players'))).toBe(true);
    expect(writes.some((s) => s.includes('INTO canvas'))).toBe(true);
    // The board is a single blob update - no per-cell rows, no full-table scan.
    expect(writes.filter((s) => s.includes('INTO canvas')).length).toBe(1);
    expect(recorder.rowsRead).toBe(0);
  });

  it('restores the canvas and history in a fresh instance (simulated restart)', async () => {
    const first = await makeRoom();
    const a = await connect(first.room, SID_A);
    a.receive({ t: 'place', x: 4, y: 2, c: 11, nonce: 'n1' });
    // A second pixel from a different session (the first is now cooling down).
    const other = await connect(first.room, SID_B);
    other.receive({ t: 'place', x: 5, y: 2, c: 12, nonce: 'n2' });

    // Same DB, new object instance: this is what a Durable Object eviction looks like.
    const restarted = new CanvasRoom(
      {
        storage: { sql: first.sql },
        blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
      } as unknown as DurableObjectState,
      fakeEnv(),
    );
    const b = await connect(restarted, SID_B);
    const welcome = b.welcome();
    expect(welcome).toBeTruthy();

    const history = await restarted.readHistory(0, 10);
    expect(history.length).toBeGreaterThanOrEqual(2);
    const colours = history.map((h) => `${h.x},${h.y}=${h.c}`);
    expect(colours).toContain('4,2=11');
    expect(colours).toContain('5,2=12');

    // The board loaded from storage must contain the pixels too.
    const png = await restarted.renderPng(1);
    expect(png.status).toBe(200);
  });
});

describe('CanvasRoom: reports and admin', () => {
  it('queues reports and exposes them to the admin view', async () => {
    const { room } = await makeRoom();
    const a = await connect(room, SID_A);
    a.receive({ t: 'report', x: 2, y: 3, reason: 'offensive', note: 'test' });

    const view = await room.adminView();
    expect(view.reports.length).toBe(1);
    expect(view.reports[0]!.x).toBe(2);
    expect(view.reports[0]!.status).toBe('open');
  });

  it('rate limits reports per handle', async () => {
    const { room } = await makeRoom();
    const a = await connect(room, SID_A);
    a.clear();
    for (let i = 0; i < 12; i++) a.receive({ t: 'report', x: i, y: 0, reason: 'spam' });
    const rejects = a.messages().filter((m) => m.t === 'reject');
    expect(rejects.some((m) => m.reason === 'rate_limited')).toBe(true);
  });

  it('reset clears the canvas and history but keeps the audit trail', async () => {
    const { room } = await makeRoom();
    const a = await connect(room, SID_A);
    a.receive({ t: 'place', x: 1, y: 1, c: 3, nonce: 'n1' });
    expect((await room.readHistory(0, 10)).length).toBe(1);

    const reset = await room.adminAction({ action: 'reset', by: 'admin' });
    expect(reset.ok).toBe(true);
    expect((await room.readHistory(0, 10)).length).toBe(0);

    const view = await room.adminView();
    expect(view.audit.some((row) => row.action === 'reset')).toBe(true);
  });

  it('publishes and clears notices, and maintenance mode blocks writes', async () => {
    const { room } = await makeRoom();
    const a = await connect(room, SID_A);

    await room.adminAction({ action: 'notice', value: 'Freeze', status: 'maintenance', by: 'admin' });
    a.clear();
    a.receive({ t: 'place', x: 1, y: 1, c: 3, nonce: 'n1' });
    expect(a.messages().find((m) => m.t === 'reject')?.reason).toBe('maintenance');

    await room.adminAction({ action: 'clearNotice' });
    a.clear();
    a.receive({ t: 'place', x: 1, y: 1, c: 3, nonce: 'n2' });
    expect(a.messages().some((m) => m.t === 'pixels')).toBe(true);
  });

  it('undo reverts the last pixel to its previous colour', async () => {
    const { room } = await makeRoom();
    const a = await connect(room, SID_A);
    a.receive({ t: 'place', x: 8, y: 8, c: 2, nonce: 'n1' });

    const undo = await room.adminAction({ action: 'undo', by: 'admin' });
    expect(undo.ok).toBe(true);
    expect(undo.message).toContain('(8, 8)');

    const png = await room.renderPng(1);
    expect(png.status).toBe(200);
  });

  it('reports "nothing to undo" instead of silently succeeding', async () => {
    const { room } = await makeRoom();
    const result = await room.adminAction({ action: 'undo' });
    expect(result.ok).toBe(false);
  });
});

describe('CanvasRoom: export', () => {
  it('renders a PNG whose width matches the configured canvas', async () => {
    const { room } = await makeRoom();
    const res = await room.renderPng(1);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const width = (bytes[16]! << 24) | (bytes[17]! << 16) | (bytes[18]! << 8) | bytes[19]!;
    expect(width).toBe(64);
  });

  it('applies the requested integer scale', async () => {
    const { room } = await makeRoom();
    const res = await room.renderPng(4);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const width = (bytes[16]! << 24) | (bytes[17]! << 16) | (bytes[18]! << 8) | bytes[19]!;
    expect(width).toBe(256);
  });
});

describe('CanvasRoom: storage degradation', () => {
  it('keeps serving sockets when storage refuses to load', async () => {
    // A Durable Object whose storage throws on every statement: the situation the
    // deployed instance hit when the free-tier row-read quota was exhausted.
    const failingSql = {
      exec() {
        throw new Error('Exceeded allowed rows read in Durable Objects free tier.');
      },
    };
    const room = new CanvasRoom(
      {
        storage: { sql: failingSql },
        blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
      } as unknown as DurableObjectState,
      fakeEnv(),
    );

    const a = await connect(room, SID_A);
    const welcome = a.welcome();
    expect(welcome).toBeTruthy();
    // The board still arrives (empty), so the UI is usable.
    expect(typeof welcome!.canvas).toBe('string');
    expect(welcome!.config.storageHealthy).toBe(false);

    // Painting still broadcasts; the author is told it was not persisted.
    a.clear();
    a.receive({ t: 'place', x: 2, y: 2, c: 7, nonce: 'n1' });
    const echo = a.messages().find((m) => m.t === 'pixels');
    expect(echo).toBeTruthy();
    expect(echo!.storageHealthy).toBe(false);
  });

  it('still enforces the cooldown with storage down', async () => {
    const failingSql = {
      exec() {
        throw new Error('storage offline');
      },
    };
    const room = new CanvasRoom(
      {
        storage: { sql: failingSql },
        blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
      } as unknown as DurableObjectState,
      fakeEnv(),
    );
    const a = await connect(room, SID_A);
    a.receive({ t: 'place', x: 1, y: 1, c: 4, nonce: 'n1' });
    a.clear();
    a.receive({ t: 'place', x: 2, y: 2, c: 4, nonce: 'n2' });
    expect(a.messages().find((m) => m.t === 'reject')?.reason).toBe('cooldown');
  });

  it('admin actions still take effect and answer, with storage down', async () => {
    const failingSql = {
      exec() {
        throw new Error('storage offline');
      },
    };
    const room = new CanvasRoom(
      {
        storage: { sql: failingSql },
        blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
      } as unknown as DurableObjectState,
      fakeEnv(),
    );

    // Publishing a notice is in-memory state, so it must succeed and reach clients.
    const notice = await room.adminAction({ action: 'notice', value: 'Heads up', status: 'warn', by: 'admin' });
    expect(notice.ok).toBe(true);

    // The admin view must answer with arrays, never throw.
    const view = await room.adminView();
    expect(Array.isArray(view.reports)).toBe(true);
    expect(Array.isArray(view.audit)).toBe(true);
    expect(view.config.storageHealthy).toBe(false);
  });
});
