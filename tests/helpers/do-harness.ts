/**
 * Local harness that runs the real `CanvasRoom` Durable Object class in Node.
 *
 * Why this exists: `workerd` (and therefore `wrangler dev` / vitest-pool-workers)
 * crashes at startup on some Windows hosts, and the Cloudflare Free plan has a hard
 * daily cap on Durable Object row reads that a load test can exhaust. Neither is a
 * reason to leave the authority logic untested.
 *
 * The harness supplies the two things `CanvasRoom` actually uses:
 *   - `state.storage.sql.exec(...)` backed by `node:sqlite` (same SQL dialect),
 *   - a `WebSocketPair`-shaped object that records frames and lets tests push
 *     messages into the object exactly like a browser would.
 *
 * Nothing in `worker/durable-object.ts` is mocked or modified for this — the class
 * under test is the one that ships.
 */

import { DatabaseSync } from 'node:sqlite';

type Row = Record<string, unknown>;

/** Mimics the Durable Object `SqlStorage` cursor surface that the room uses. */
class Cursor {
  constructor(private readonly rows: Row[]) {}

  toArray(): Row[] {
    return this.rows;
  }

  one(): Row {
    if (this.rows.length !== 1) {
      throw new Error(`Expected exactly one result from SQL query, but got ${this.rows.length === 0 ? 'no results' : 'multiple results'}.`);
    }
    return this.rows[0]!;
  }

  get length(): number {
    return this.rows.length;
  }

  [Symbol.iterator](): Iterator<Row> {
    return this.rows[Symbol.iterator]();
  }
}

/** Records every statement so tests can assert the read/write cost of an operation. */
export class SqlRecorder {
  statements: string[] = [];
  rowsRead = 0;
  rowsWritten = 0;

  reset(): void {
    this.statements = [];
    this.rowsRead = 0;
    this.rowsWritten = 0;
  }
}

export class FakeSqlStorage {
  constructor(
    private readonly db: DatabaseSync,
    private readonly recorder: SqlRecorder,
  ) {}

  exec<T = Row>(query: string, ...bindings: unknown[]): Cursor & { toArray(): T[] } {
    const trimmed = query.trim().replace(/\s+/g, ' ');
    this.recorder.statements.push(trimmed);
    const isRead = /^(SELECT|PRAGMA|WITH)/i.test(trimmed);
    const statement = this.db.prepare(query);
    if (isRead) {
      const rows = statement.all(...(bindings as never[])) as Row[];
      this.recorder.rowsRead += rows.length;
      return new Cursor(rows) as Cursor & { toArray(): T[] };
    }
    // A write with a RETURNING clause must be executed exactly once — `all()`
    // performs the write and hands back the returned rows.
    if (/RETURNING/i.test(trimmed)) {
      const rows = statement.all(...(bindings as never[])) as Row[];
      this.recorder.rowsWritten += 1;
      return new Cursor(rows) as Cursor & { toArray(): T[] };
    }
    statement.run(...(bindings as never[]));
    this.recorder.rowsWritten += 1;
    return new Cursor([]) as Cursor & { toArray(): T[] };
  }

  get databaseSize(): number {
    return 0;
  }
}

type Listener = (event: { data?: unknown }) => void;

/** Minimal WebSocket stand-in with the event API the room uses. */
export class FakeSocket {
  readonly sent: string[] = [];
  private listeners = new Map<string, Set<Listener>>();
  closed = false;
  closeCode: number | null = null;
  /** The other end of the pair: frames sent here land in its `sent` buffer. */
  peer: FakeSocket | null = null;

  send(data: string): void {
    if (this.closed) throw new Error('socket closed');
    // On Cloudflare a frame written to the server socket is delivered to the client.
    (this.peer ?? this).sent.push(data);
  }

  close(code = 1000): void {
    this.closed = true;
    this.closeCode = code;
    this.emit('close', {});
    this.peer?.emit('close', {});
  }

  accept(): void {
    /* no-op: the room calls this on the server socket */
  }

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** Deliver a client frame as if it arrived over the wire. */
  receive(message: unknown): void {
    const data = typeof message === 'string' ? message : JSON.stringify(message);
    // A frame written by the client is handled by the server end.
    (this.peer ?? this).emit('message', { data });
  }

  messages(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/** Build a `DurableObjectState` lookalike backed by an in-memory SQLite database. */
export function createFakeState() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA journal_mode = MEMORY');
  const recorder = new SqlRecorder();
  const sql = new FakeSqlStorage(db, recorder);
  const sockets = new Map<string, FakeSocket>();

  const state = {
    storage: {
      sql,
      get: async () => undefined,
      put: async () => undefined,
      delete: async () => false,
      list: async () => new Map(),
      setAlarm: async () => undefined,
      deleteAlarm: async () => undefined,
      transaction: async (fn: () => Promise<unknown>) => fn(),
    },
    blockConcurrencyWhile: async (fn: () => Promise<void>) => {
      await fn();
    },
    waitUntil: () => undefined,
    id: { toString: () => 'fake-id', name: 'main' },
  };

  return { state, sql, recorder, db, sockets };
}

/**
 * Installs the globals a Durable Object expects (`WebSocketPair`, and a `Response`
 * that tolerates `status: 101` + `webSocket`, which Node's built-in Response rejects).
 * Returns the client side of every pair the room creates.
 */
export function installWebSocketPair(): { clientSockets: FakeSocket[] } {
  const clientSockets: FakeSocket[] = [];
  class Pair {
    0: FakeSocket;
    1: FakeSocket;
    constructor() {
      // Cloudflare: index 0 = client side, index 1 = server side.
      this[0] = new FakeSocket();
      this[1] = new FakeSocket();
      this[0].peer = this[1];
      this[1].peer = this[0];
      clientSockets.push(this[0]);
    }
  }
  (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = Pair;

  const RealResponse = globalThis.Response;
  // Node's Response throws on 101, but that is exactly what an upgraded socket is.
  class UpgradableResponse {
    constructor(body?: unknown, init?: { status?: number; webSocket?: unknown; headers?: HeadersInit }) {
      if (init?.status === 101) {
        // Returning an object from a constructor replaces the instance.
        return {
          status: 101,
          statusText: 'Switching Protocols',
          ok: true,
          headers: new Headers(init.headers ?? {}),
          body: null,
          webSocket: init.webSocket,
        } as unknown as UpgradableResponse;
      }
      return new RealResponse(body as BodyInit | null, init as ResponseInit);
    }
  }
  (globalThis as unknown as { Response: unknown }).Response = UpgradableResponse as unknown as typeof Response;

  return { clientSockets };
}

/** Shape of the `env` the room needs (config only — no bindings are touched). */
export function fakeEnv(overrides: Record<string, string> = {}) {
  return {
    CANVAS_WIDTH: '64',
    CANVAS_HEIGHT: '64',
    CANVAS_NAME: 'Test Commons',
    COOLDOWN_SECONDS: '30',
    SESSION_SECRET: 'test-secret',
    ...overrides,
  } as never;
}
