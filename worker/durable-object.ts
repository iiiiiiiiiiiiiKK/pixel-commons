import type {
  AdminAction,
  Cell,
  ClientMessage,
  HistoryEntry,
  MoveEntry,
  Notice,
  Player,
  Report,
  ReportReason,
  ServerConfig,
  ServerMessage,
  WelcomePayload,
} from '../shared/protocol';
import { REPORT_REASON_LABELS } from '../shared/protocol';
import { DEFAULT_PALETTE, packRle, unpackRle, bytesToBase64Url, paletteRgb } from '../shared/rle';
import type { Env } from './env';
import { handleFor } from './session';
import { encodePng, paletteToRgb } from './png';

/* -------------------------------------------------------------------------- */
/*                              configuration                                  */
/* -------------------------------------------------------------------------- */

type CanvasConfig = {
  width: number;
  height: number;
  name: string;
  palette: string[];
  cooldownMs: number;
};

const FALLBACK: CanvasConfig = {
  width: 256,
  height: 256,
  name: 'Pixel Commons',
  palette: DEFAULT_PALETTE,
  cooldownMs: 30_000,
};

function clampInt(value: string | undefined, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function readConfig(env: Env): CanvasConfig {
  const palette = (env.CANVAS_PALETTE ?? '')
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => /^#[0-9a-f]{6}$/.test(c));
  return {
    width: clampInt(env.CANVAS_WIDTH, 32, 1024, FALLBACK.width),
    height: clampInt(env.CANVAS_HEIGHT, 32, 1024, FALLBACK.height),
    name: (env.CANVAS_NAME ?? FALLBACK.name).slice(0, 48),
    palette: palette.length >= 2 ? palette.slice(0, 32) : FALLBACK.palette,
    cooldownMs: clampInt(env.COOLDOWN_SECONDS, 0, 3600, 30) * 1000,
  };
}

/* -------------------------------------------------------------------------- */
/*                                   limits                                    */
/* -------------------------------------------------------------------------- */

/** Max accepted pixels on the whole canvas. Guards storage and keeps exports sane. */
const MAX_TOTAL_PIXELS = 200_000;
/** Max live history rows kept in SQLite (older rows roll into snapshots). */
const HISTORY_LIMIT = 2_000;
/** How often the history table is scanned for trimming (writes between checks). */
const HISTORY_TRIM_EVERY = 200;
/** Per-session burst limiter: at most N messages per window. */
const BURST_WINDOW_MS = 10_000;
const BURST_MAX = 40;
/** Per-connection hard cap on messages per second. */
const MSG_PER_SEC = 12;
/** Snapshot cadence for time-travel history. */
const SNAPSHOT_MIN_INTERVAL_MS = 10 * 60_000;
const SNAPSHOT_MAX = 96;
const MAX_REPORTS = 500;

type ConnState = {
  id: string;
  sessionId: string;
  handle: string;
  ws: WebSocket;
  isAdmin: boolean;
  nextAt: number;
  pixels: number;
  windowStart: number;
  windowCount: number;
  lastMsgAt: number;
  msgBudget: number;
};

function json(message: ServerMessage): string {
  return JSON.stringify(message);
}

function nowMs(): number {
  return Date.now();
}

/**
 * `CanvasRoom` is the single source of truth for one canvas.
 *
 * Everything that could be abused lives here rather than in the browser:
 *  - cooldown is derived from the session, not from anything the client sends
 *  - coordinates and palette indices are validated against the current config
 *  - per-connection and per-session rate limits are enforced before any write
 *  - broadcasts only ever contain pixels the server itself accepted
 *
 * Storage layout (SQLite-backed Durable Object):
 *  meta(key TEXT PRIMARY KEY, value TEXT)
 *  cells(idx INTEGER PRIMARY KEY, c INTEGER)      -- sparse overrides over the background colour
 *  history(id INTEGER PRIMARY KEY AUTOINCREMENT, x, y, c, prev, at, by)
 *  players(session TEXT PRIMARY KEY, handle, pixels, last_at)
 *  reports(id INTEGER PRIMARY KEY AUTOINCREMENT, x, y, reason, note, at, status, by)
 *  audit(id INTEGER PRIMARY KEY AUTOINCREMENT, action, detail, by, at)
 *  snapshots(id INTEGER PRIMARY KEY AUTOINCREMENT, at, version, rle BLOB, total_pixels)
 */
export class CanvasRoom implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly config: CanvasConfig;
  private readonly connections = new Map<string, ConnState>();
  private readonly cooldownMap = new Map<string, number>();
  private roomVersion = 0;
  private totalPixels = 0;
  private notice: Notice | null = null;
  private canvasName: string;
  private openReports = 0;
  private lastSnapshotAt = 0;
  private loaded = false;
  /**
   * Authoritative pixel buffer, held in memory for the lifetime of the object.
   *
   * Keeping the board in RAM is what makes the storage model affordable: a pixel
   * write needs **zero** row reads (the previous colour is right here) and only one
   * row write (the packed blob). The earlier column-per-cell layout required a
   * full table scan to answer every `welcome`, which is O(n) reads per connection
   * and blows through the Durable Objects free tier on a busy canvas.
   */
  private board: Uint8Array;
  /** Counter used to run history trimming periodically instead of per write. */
  private writesSinceTrim = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.config = readConfig(env);
    this.canvasName = this.config.name;
    this.board = new Uint8Array(this.config.width * this.config.height);
    state.blockConcurrencyWhile(async () => {
      await this.load();
    });
  }

  private get totalCells(): number {
    return this.config.width * this.config.height;
  }

  /**
   * One-way migration from the original per-cell table to the packed board.
   *
   * The first release stored each painted cell as its own row. That layout made
   * every `welcome` a full-table scan, which is charged as row reads and exhausted
   * the Durable Objects free tier on a busy canvas. Existing deployments are carried
   * over transparently: read the old table once, pack it, drop it.
   */
  private migrateLegacyCells(): void {
    const sql = this.state.storage.sql;
    let rows: Array<{ idx: number; c: number }> = [];
    try {
      rows = sql.exec<{ idx: number; c: number }>(`SELECT idx, c FROM cells`).toArray();
    } catch {
      return; // no legacy table on a fresh database
    }
    if (rows.length === 0) return;
    for (const row of rows) {
      const idx = Number(row.idx);
      if (idx >= 0 && idx < this.board.length) this.board[idx] = Number(row.c);
    }
    sql.exec(`DROP TABLE IF EXISTS cells`);
    this.persistBoard();
    console.log('migrated_legacy_cells', rows.length);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    const sql = this.state.storage.sql;
    // `board` holds the packed canvas (RLE) as a single value. One row, one read.
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    sql.exec(
      `CREATE TABLE IF NOT EXISTS canvas (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         rle BLOB NOT NULL,
         version INTEGER NOT NULL DEFAULT 0,
         total_pixels INTEGER NOT NULL DEFAULT 0
       )`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS history (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         x INTEGER NOT NULL, y INTEGER NOT NULL, c INTEGER NOT NULL,
         prev INTEGER, at INTEGER NOT NULL, by TEXT NOT NULL
       )`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS players (
         session TEXT PRIMARY KEY, handle TEXT NOT NULL,
         pixels INTEGER NOT NULL DEFAULT 0, last_at INTEGER NOT NULL DEFAULT 0
       )`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS reports (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         x INTEGER NOT NULL, y INTEGER NOT NULL,
         reason TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
         at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', by TEXT NOT NULL
       )`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS audit (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
         by TEXT NOT NULL, at INTEGER NOT NULL
       )`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS snapshots (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         at INTEGER NOT NULL, version INTEGER NOT NULL,
         rle BLOB NOT NULL, total_pixels INTEGER NOT NULL
       )`,
    );

    const meta = new Map<string, string>();
    for (const row of sql.exec<{ key: string; value: string }>(`SELECT key, value FROM meta`).toArray()) {
      meta.set(row.key, row.value);
    }
    this.roomVersion = Number(meta.get('version') ?? 0) || 0;
    this.totalPixels = Number(meta.get('totalPixels') ?? 0) || 0;
    this.lastSnapshotAt = Number(meta.get('lastSnapshotAt') ?? 0) || 0;
    const noticeRaw = meta.get('notice');
    if (noticeRaw) {
      try {
        this.notice = JSON.parse(noticeRaw) as Notice;
      } catch {
        this.notice = null;
      }
    }
    if (meta.get('canvasName')) this.canvasName = meta.get('canvasName')!;

    // Load the packed board (single row). Missing row = a brand-new canvas.
    const stored = sql.exec<{ rle: ArrayBuffer; version: number; total_pixels: number }>(
      `SELECT rle, version, total_pixels FROM canvas WHERE id = 1`,
    ).toArray()[0];
    if (stored) {
      this.board = unpackRle(new Uint8Array(stored.rle), this.totalCells);
      this.roomVersion = Math.max(this.roomVersion, Number(stored.version) || 0);
      this.totalPixels = Math.max(this.totalPixels, Number(stored.total_pixels) || 0);
    } else {
      this.board = new Uint8Array(this.totalCells);
      this.migrateLegacyCells();
    }

    const openRow = sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM reports WHERE status = 'open'`)
      .toArray()[0] ?? null;
    this.openReports = Number(openRow?.n ?? 0);

    this.loaded = true;
  }

  /* ---------------------------------------------------------------------- */
  /*                              durable object                            */
  /* ---------------------------------------------------------------------- */

  async fetch(request: Request): Promise<Response> {
    await this.load();
    const url = new URL(request.url);

    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return this.handleSocket(request);
    }

    if (url.pathname.endsWith('/export.png')) {
      return this.renderPng(parseInt(url.searchParams.get('scale') ?? '1', 10));
    }

    if (url.pathname.endsWith('/snapshot.png')) {
      const id = parseInt(url.searchParams.get('id') ?? '0', 10) || 0;
      return this.renderPng(parseInt(url.searchParams.get('scale') ?? '1', 10), id);
    }

    if (url.pathname.endsWith('/admin') && request.method === 'POST') {
      const body = (await request.json()) as Parameters<CanvasRoom['adminAction']>[0];
      return Response.json(await this.adminAction(body));
    }

    if (url.pathname.endsWith('/adminview')) {
      return Response.json(await this.adminView());
    }

    if (url.pathname.endsWith('/history')) {
      const since = parseInt(url.searchParams.get('since') ?? '0', 10) || 0;
      const limit = Math.min(200, parseInt(url.searchParams.get('limit') ?? '100', 10) || 100);
      return Response.json({ history: this.history(since, limit), lastId: this.lastHistoryId() });
    }

    if (url.pathname.endsWith('/snapshots')) {
      return Response.json({ snapshots: await this.readSnapshotList() });
    }

    if (url.pathname.endsWith('/backup')) {
      const backup = await this.backup();
      return new Response(backup.rle as unknown as BodyInit, {
        headers: {
          'content-type': 'application/octet-stream',
          'x-canvas-version': String(backup.version),
          'x-canvas-total-pixels': String(backup.totalPixels),
          'x-canvas-taken-at': String(backup.at),
          'x-canvas-width': String(this.config.width),
          'x-canvas-height': String(this.config.height),
        },
      });
    }

    if (url.pathname.endsWith('/info')) {
      return Response.json({
        config: this.publicConfig(),
        recent: this.recentMoves(30),
        history: this.history(0, 60),
      });
    }

    return new Response('Not found', { status: 404 });
  }

  private publicConfig(): ServerConfig {
    return {
      width: this.config.width,
      height: this.config.height,
      palette: this.config.palette,
      cooldownMs: this.config.cooldownMs,
      onlineCount: this.connections.size,
      serverTime: nowMs(),
      version: this.roomVersion,
      totalPixels: this.totalPixels,
      canvasId: `${this.config.width}x${this.config.height}`,
      canvasName: this.canvasName,
      notice: this.notice,
    };
  }

  /* ---------------------------------------------------------------------- */
  /*                                websocket                               */
  /* ---------------------------------------------------------------------- */

  private async handleSocket(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get('sid') ?? '';
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(sessionId)) {
      return new Response('Invalid session', { status: 400 });
    }
    const isAdmin = url.searchParams.get('admin') === '1';
    const since = parseInt(url.searchParams.get('since') ?? '0', 10) || 0;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Hibernation is deliberately not used: the room keeps authoritative in-memory
    // state and broadcasts deltas, which is simpler to reason about for cooldowns.
    server.accept();

    const handle = await handleFor(sessionId);
    const id = crypto.randomUUID();
    const conn: ConnState = {
      id,
      sessionId,
      handle,
      ws: server,
      isAdmin,
      nextAt: await this.cooldownDeadline(sessionId),
      pixels: this.playerPixels(sessionId),
      windowStart: nowMs(),
      windowCount: 0,
      lastMsgAt: 0,
      msgBudget: MSG_PER_SEC,
    };
    this.connections.set(id, conn);

    const welcome: WelcomePayload = {
      config: this.publicConfig(),
      canvas: bytesToBase64Url(this.exportRle()),
      recent: this.recentMoves(30),
      history: this.history(since, 60),
      lastId: this.lastHistoryId(),
      nextAt: conn.nextAt,
      handle,
      isAdmin,
      me: { pixels: conn.pixels },
    };
    if (isAdmin) welcome.openReports = this.openReports;

    this.send(conn, { t: 'welcome', ...welcome });
    this.broadcastPresence();

    server.addEventListener('message', (event) => this.onMessage(conn, event));
    server.addEventListener('close', () => {
      this.connections.delete(id);
      this.broadcastPresence();
    });
    server.addEventListener('error', () => {
      this.connections.delete(id);
      this.broadcastPresence();
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private send(conn: ConnState, message: ServerMessage): void {
    try {
      conn.ws.send(json(message));
    } catch {
      this.connections.delete(conn.id);
    }
  }

  private onMessage(conn: ConnState, event: MessageEvent): void {
    const raw = event.data;
    if (typeof raw !== 'string') {
      this.send(conn, { t: 'error', message: 'Binary frames are not supported.' });
      return;
    }
    if (raw.length > 2_048) {
      this.send(conn, { t: 'reject', reason: 'bad_request', message: 'Message too large.' });
      return;
    }

    const now = nowMs();
    // Hard per-connection rate limit (all message types).
    if (now - conn.lastMsgAt > 1000) {
      conn.msgBudget = MSG_PER_SEC;
    }
    conn.lastMsgAt = now;
    conn.msgBudget -= 1;
    if (conn.msgBudget < 0) {
      this.send(conn, {
        t: 'reject',
        reason: 'rate_limited',
        message: 'Slow down a little.',
        retryAfterMs: 1000,
      });
      return;
    }

    let message: ClientMessage;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      this.send(conn, { t: 'reject', reason: 'bad_request', message: 'Malformed message.' });
      return;
    }

    switch (message.t) {
      case 'ping':
        this.send(conn, { t: 'pong', ts: Number(message.ts) || 0, serverTime: now });
        return;
      case 'hello':
        this.send(conn, {
          t: 'welcome',
          config: this.publicConfig(),
          canvas: bytesToBase64Url(this.exportRle()),
          recent: this.recentMoves(30),
          history: this.history(Number(message.since) || 0, 60),
          lastId: this.lastHistoryId(),
          nextAt: conn.nextAt,
          handle: conn.handle,
          isAdmin: conn.isAdmin,
          me: { pixels: conn.pixels },
          ...(conn.isAdmin ? { openReports: this.openReports } : {}),
        });
        return;
      case 'place':
        this.handlePlace(conn, message);
        return;
      case 'report':
        this.handleReport(conn, message);
        return;
      default:
        this.send(conn, { t: 'reject', reason: 'bad_request', message: 'Unknown message type.' });
    }
  }

  /* ---------------------------------------------------------------------- */
  /*                                placement                               */
  /* ---------------------------------------------------------------------- */

  private handlePlace(conn: ConnState, msg: { x: unknown; y: unknown; c: unknown; nonce: unknown }): void {
    const now = nowMs();

    // Burst limiter on actual writes (also protects against reconnect loops).
    if (now - conn.windowStart > BURST_WINDOW_MS) {
      conn.windowStart = now;
      conn.windowCount = 0;
    }
    conn.windowCount += 1;
    if (conn.windowCount > BURST_MAX) {
      this.send(conn, {
        t: 'reject',
        reason: 'rate_limited',
        message: 'Too many actions - take a breath.',
        retryAfterMs: BURST_WINDOW_MS - (now - conn.windowStart),
      });
      return;
    }

    if (this.notice?.level === 'maintenance') {
      this.send(conn, {
        t: 'reject',
        reason: 'maintenance',
        message: this.notice.message || 'The canvas is in maintenance mode.',
      });
      return;
    }

    if (now < conn.nextAt) {
      this.send(conn, {
        t: 'reject',
        reason: 'cooldown',
        message: `Cooldown: ${Math.ceil((conn.nextAt - now) / 1000)}s left.`,
        nextAt: conn.nextAt,
      });
      return;
    }

    const x = Number(msg.x);
    const y = Number(msg.y);
    const c = Number(msg.c);
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(c)) {
      this.send(conn, { t: 'reject', reason: 'bad_request', message: 'Invalid pixel payload.' });
      return;
    }
    if (x < 0 || y < 0 || x >= this.config.width || y >= this.config.height) {
      this.send(conn, {
        t: 'reject',
        reason: 'out_of_bounds',
        message: `Pixel (${x}, ${y}) is outside the ${this.config.width}x${this.config.height} canvas.`,
      });
      return;
    }
    if (c < 0 || c >= this.config.palette.length) {
      this.send(conn, { t: 'reject', reason: 'bad_color', message: 'That colour is not in the palette.' });
      return;
    }
    if (this.totalPixels >= MAX_TOTAL_PIXELS) {
      this.send(conn, {
        t: 'reject',
        reason: 'forbidden',
        message: 'This canvas reached its pixel budget. Ask an admin to archive it.',
      });
      return;
    }

    const idx = y * this.config.width + x;
    const prev = this.board[idx] ?? 0;
    if (prev === c) {
      this.send(conn, {
        t: 'reject',
        reason: 'unchanged',
        message: 'That pixel already has this colour - no cooldown spent.',
      });
      return;
    }

    const sql = this.state.storage.sql;
    const row = sql
      .exec<{ id: number }>(
        `INSERT INTO history (x, y, c, prev, at, by) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
        x,
        y,
        c,
        prev,
        now,
        conn.handle,
      )
      .toArray()[0] ?? null;
    const historyId = Number(row?.id ?? 0);

    this.board[idx] = c;
    this.totalPixels += 1;
    this.roomVersion += 1;

    sql.exec(
      `INSERT INTO players (session, handle, pixels, last_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(session) DO UPDATE SET pixels = pixels + 1, last_at = excluded.last_at, handle = excluded.handle`,
      conn.sessionId,
      conn.handle,
      now,
    );

    conn.pixels += 1;
    conn.nextAt = now + this.config.cooldownMs;
    this.cooldownMap.set(conn.sessionId, conn.nextAt);

    // Persist the board immediately: a hijacked or evicted isolate must never lose
    // an accepted pixel. `persistBoard` is one row write.
    this.persistBoard();

    // Broadcast the accepted pixel to everyone (including the author, so the client
    // never has to guess what the server accepted).
    const delta: ServerMessage = {
      t: 'pixels',
      cells: [{ x, y, c }],
      lastId: historyId,
      totalPixels: this.totalPixels,
      version: this.roomVersion,
    };
    for (const other of this.connections.values()) {
      if (other.id === conn.id) {
        this.send(other, { ...delta, nextAt: conn.nextAt, self: conn.handle } as ServerMessage);
      } else {
        this.send(other, delta);
      }
    }

    // Snapshots and history trimming are periodic housekeeping; they run after the
    // broadcast so latency never depends on them.
    this.maybeSnapshot(now);
    this.trimHistory();
  }

  /**
   * Serialise the in-memory board to RLE.
   *
   * No SQL involved - the earlier implementation scanned a `cells` table on every
   * call, which turned each WebSocket `welcome` into an O(canvas) row-read burst.
   */
  private exportRle(): Uint8Array {
    return packRle(this.board);
  }

  private persistBoard(): void {
    this.state.storage.sql.exec(
      `INSERT INTO canvas (id, rle, version, total_pixels) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET rle = excluded.rle, version = excluded.version, total_pixels = excluded.total_pixels`,
      packRle(this.board),
      this.roomVersion,
      this.totalPixels,
    );
  }

  private cooldownDeadline(sessionId: string): number {
    const cached = this.cooldownMap.get(sessionId);
    if (cached !== undefined) return cached;
    const row = this.state.storage.sql
      .exec<{ last_at: number }>(`SELECT last_at FROM players WHERE session = ?`, sessionId)
      .toArray()[0] ?? null;
    const last = Number(row?.last_at ?? 0);
    const deadline = last ? last + this.config.cooldownMs : 0;
    this.cooldownMap.set(sessionId, deadline);
    return deadline;
  }

  private playerPixels(sessionId: string): number {
    const row = this.state.storage.sql
      .exec<{ pixels: number }>(`SELECT pixels FROM players WHERE session = ?`, sessionId)
      .toArray()[0] ?? null;
    return Number(row?.pixels ?? 0);
  }

  /* ---------------------------------------------------------------------- */
  /*                                  reports                               */
  /* ---------------------------------------------------------------------- */

  private handleReport(
    conn: ConnState,
    msg: { x: unknown; y: unknown; reason: unknown; note?: unknown },
  ): void {
    const x = Number(msg.x);
    const y = Number(msg.y);
    const reason = String(msg.reason ?? '') as ReportReason;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= this.config.width || y >= this.config.height) {
      this.send(conn, { t: 'reject', reason: 'bad_request', message: 'Report points outside the canvas.' });
      return;
    }
    if (!(reason in REPORT_REASON_LABELS)) {
      this.send(conn, { t: 'reject', reason: 'bad_request', message: 'Unknown report reason.' });
      return;
    }
    const note = String(msg.note ?? '').slice(0, 280);
    const now = nowMs();
    const recent = this.state.storage.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM reports WHERE by = ? AND at > ?`,
        conn.handle,
        now - 60 * 60_000,
      )
      .toArray()[0] ?? null;
    if (Number(recent?.n ?? 0) >= 10) {
      this.send(conn, { t: 'reject', reason: 'rate_limited', message: 'Report limit reached for this hour.' });
      return;
    }
    const total = this.state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM reports`).toArray()[0] ?? null;
    if (Number(total?.n ?? 0) >= MAX_REPORTS) {
      this.send(conn, { t: 'reject', reason: 'rate_limited', message: 'The report queue is full. Try again later.' });
      return;
    }

    this.state.storage.sql.exec(
      `INSERT INTO reports (x, y, reason, note, at, status, by) VALUES (?, ?, ?, ?, ?, 'open', ?)`,
      x,
      y,
      reason,
      note,
      now,
      conn.handle,
    );
    this.openReports += 1;
    this.send(conn, {
      t: 'notice',
      notice: {
        message: `Report received for (${x}, ${y}). Thank you - moderators review the queue.`,
        level: 'info',
        since: now,
        updatedBy: 'system',
      },
    });
    for (const other of this.connections.values()) {
      if (other.isAdmin) this.send(other, { t: 'presence', online: this.connections.size, players: [] });
    }
  }

  /* ---------------------------------------------------------------------- */
  /*                              admin plumbing                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Entry point used by the Worker for privileged HTTP calls. The Worker has already
   * verified the admin cookie; this method performs the mutation and records an audit row.
   */
  async adminAction(body: {
    action: 'reset' | 'notice' | 'clearNotice' | 'undo' | 'resolveReport' | 'rename';
    x?: number;
    y?: number;
    value?: string;
    id?: number;
    status?: string;
    by?: string;
  }): Promise<{ ok: boolean; message: string }> {
    await this.load();
    const by = (body.by ?? 'admin').slice(0, 64);
    const sql = this.state.storage.sql;
    const now = nowMs();

    const audit = (action: string, detail: string) => {
      sql.exec(
        `INSERT INTO audit (action, detail, by, at) VALUES (?, ?, ?, ?)`,
        action,
        detail.slice(0, 500),
        by,
        now,
      );
    };

    switch (body.action) {
      case 'reset': {
        sql.exec(`DELETE FROM history`);
        sql.exec(`DELETE FROM snapshots`);
        sql.exec(`DELETE FROM players`);
        this.board.fill(0);
        this.totalPixels = 0;
        this.roomVersion += 1;
        this.lastSnapshotAt = 0;
        this.persistBoard();
        this.persistMeta();
        audit('reset', 'canvas cleared');
        this.broadcastSystem({
          t: 'welcome',
          config: this.publicConfig(),
          canvas: bytesToBase64Url(this.exportRle()),
          recent: [],
          history: [],
          lastId: 0,
          nextAt: 0,
          handle: 'system',
          isAdmin: false,
          me: { pixels: 0 },
        });
        return { ok: true, message: 'Canvas reset. Nobody keeps their cooldown debt.' };
      }
      case 'notice': {
        const level = (body.status === 'warn' || body.status === 'maintenance' ? body.status : 'info') as Notice['level'];
        this.notice = { message: (body.value ?? '').slice(0, 280), level, since: now, updatedBy: by };
        this.persistMeta();
        audit('notice', `${level}: ${this.notice.message}`);
        this.broadcast({ t: 'notice', notice: this.notice });
        return { ok: true, message: 'Notice published.' };
      }
      case 'clearNotice': {
        this.notice = null;
        this.persistMeta();
        audit('clearNotice', 'notice cleared');
        this.broadcast({ t: 'notice', notice: null });
        return { ok: true, message: 'Notice cleared.' };
      }
      case 'undo': {
        const last = sql
          .exec<{ id: number; x: number; y: number; prev: number | null; at: number }>(
            `SELECT id, x, y, prev, at FROM history ORDER BY id DESC LIMIT 1`,
          )
          .toArray()[0] ?? null;
        if (!last) return { ok: false, message: 'Nothing to undo.' };
        const idx = Number(last.y) * this.config.width + Number(last.x);
        this.board[idx] = last.prev === null ? 0 : Number(last.prev);
        sql.exec(`DELETE FROM history WHERE id = ?`, Number(last.id));
        this.roomVersion += 1;
        this.persistBoard();
        this.persistMeta();
        audit('undo', `pixel (${last.x}, ${last.y})`);
        this.broadcast({ t: 'pixels', cells: [], lastId: this.lastHistoryId(), totalPixels: this.totalPixels, version: this.roomVersion });
        this.broadcastSystem({
          t: 'welcome',
          config: this.publicConfig(),
          canvas: bytesToBase64Url(this.exportRle()),
          recent: this.recentMoves(30),
          history: this.history(0, 60),
          lastId: this.lastHistoryId(),
          nextAt: 0,
          handle: 'system',
          isAdmin: false,
          me: { pixels: 0 },
        });
        return { ok: true, message: `Reverted pixel (${last.x}, ${last.y}).` };
      }
      case 'rename': {
        const name = (body.value ?? '').slice(0, 48).trim();
        if (!name) return { ok: false, message: 'Name cannot be empty.' };
        this.canvasName = name;
        this.persistMeta();
        audit('rename', name);
        this.broadcast({ t: 'notice', notice: this.notice });
        return { ok: true, message: `Canvas renamed to "${name}".` };
      }
      case 'resolveReport': {
        const id = Number(body.id);
        const status = body.status === 'rejected' ? 'rejected' : 'resolved';
        sql.exec(`UPDATE reports SET status = ? WHERE id = ?`, status, id);
        this.openReports = Number(
          sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM reports WHERE status = 'open'`).toArray()[0]?.n ?? 0,
        );
        audit('resolveReport', `#${id} -> ${status}`);
        for (const other of this.connections.values()) {
          if (other.isAdmin) this.send(other, { t: 'presence', online: this.connections.size, players: [] });
        }
        return { ok: true, message: `Report #${id} marked ${status}.` };
      }
      default:
        return { ok: false, message: 'Unknown admin action.' };
    }
  }

  /** Read-only admin view (queue + audit trail + snapshots). */
  async adminView(): Promise<{
    reports: Report[];
    audit: AdminAction[];
    snapshots: Array<{ id: number; at: number; version: number; totalPixels: number }>;
    config: ServerConfig;
  }> {
    await this.load();
    const sql = this.state.storage.sql;
    const reports = sql
      .exec<Report>(`SELECT id, x, y, reason, note, at, status, by FROM reports ORDER BY status = 'open' DESC, id DESC LIMIT 100`)
      .toArray()
      .map((r) => ({ ...r, at: Number(r.at), id: Number(r.id), x: Number(r.x), y: Number(r.y) }));
    const audit = sql
      .exec<AdminAction>(`SELECT id, action, detail, by, at FROM audit ORDER BY id DESC LIMIT 60`)
      .toArray()
      .map((a) => ({ ...a, id: Number(a.id), at: Number(a.at) }));
    const snapshots = sql
      .exec<{ id: number; at: number; version: number; total_pixels: number }>(
        `SELECT id, at, version, total_pixels FROM snapshots ORDER BY id DESC LIMIT 40`,
      )
      .toArray()
      .map((s) => ({ id: Number(s.id), at: Number(s.at), version: Number(s.version), totalPixels: Number(s.total_pixels) }));
    return { reports, audit, snapshots, config: this.publicConfig() };
  }

  /** Render the current canvas, or a snapshot when `snapshotId` is provided. */
  async renderPng(scale: number, snapshotId?: number): Promise<Response> {
    await this.load();
    let indices: Uint8Array;
    if (snapshotId) {
      const row = this.state.storage.sql
        .exec<{ rle: ArrayBuffer }>(`SELECT rle FROM snapshots WHERE id = ?`, snapshotId)
        .toArray()[0] ?? null;
      if (!row) return new Response('Snapshot not found', { status: 404 });
      indices = unpackRle(new Uint8Array(row.rle), this.totalCells);
    } else {
      indices = unpackRle(this.exportRle(), this.totalCells);
    }
    const safeScale = Math.min(16, Math.max(1, Math.floor(scale) || 1));
    const { rgb, width, height } = paletteToRgb(
      indices,
      this.config.width,
      this.config.height,
      paletteRgb(this.config.palette),
      safeScale,
    );
    const png = await encodePng(rgb, width, height);
    return new Response(png as unknown as BodyInit, {
      headers: {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=30',
        'content-disposition': `inline; filename="pixel-commons-${width}x${height}.png"`,
      },
    });
  }

  async readHistory(since: number, limit = 100): Promise<HistoryEntry[]> {
    await this.load();
    return this.history(since, limit);
  }

  async readSnapshotList(): Promise<Array<{ id: number; at: number; version: number; totalPixels: number }>> {
    await this.load();
    return this.state.storage.sql
      .exec<{ id: number; at: number; version: number; total_pixels: number }>(
        `SELECT id, at, version, total_pixels FROM snapshots ORDER BY id DESC LIMIT 40`,
      )
      .toArray()
      .map((s) => ({ id: Number(s.id), at: Number(s.at), version: Number(s.version), totalPixels: Number(s.total_pixels) }));
  }

  /** Create a backup blob (RLE) for scheduled exports to R2. */
  async backup(): Promise<{ rle: Uint8Array; version: number; totalPixels: number; at: number }> {
    await this.load();
    return { rle: this.exportRle(), version: this.roomVersion, totalPixels: this.totalPixels, at: nowMs() };
  }

  /* ---------------------------------------------------------------------- */
  /*                              internal helpers                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Persist rarely-changing settings (name, notice, snapshot clock).
   *
   * `version` and `totalPixels` deliberately live in the `canvas` row instead, so a
   * pixel write costs exactly one row write (`persistBoard`) rather than five. On
   * the free tier that is the difference between ~100k and ~500k pixels per day.
   */
  private persistMeta(): void {
    const sql = this.state.storage.sql;
    const write = (key: string, value: string) =>
      sql.exec(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value);
    write('lastSnapshotAt', String(this.lastSnapshotAt));
    write('canvasName', this.canvasName);
    if (this.notice) write('notice', JSON.stringify(this.notice));
    else sql.exec(`DELETE FROM meta WHERE key = 'notice'`);
  }

  private lastHistoryId(): number {
    const row = this.state.storage.sql.exec<{ id: number }>(`SELECT id FROM history ORDER BY id DESC LIMIT 1`).toArray()[0] ?? null;
    return Number(row?.id ?? 0);
  }

  private history(since: number, limit: number): HistoryEntry[] {
    const rows = since
      ? this.state.storage.sql
          .exec<HistoryEntry>(
            `SELECT id, x, y, c, prev, at, by FROM history WHERE id > ? ORDER BY id ASC LIMIT ?`,
            since,
            limit,
          )
          .toArray()
      : this.state.storage.sql
          .exec<HistoryEntry>(`SELECT id, x, y, c, prev, at, by FROM history ORDER BY id DESC LIMIT ?`, limit)
          .toArray();
    return rows.map((r) => ({
      id: Number(r.id),
      x: Number(r.x),
      y: Number(r.y),
      c: Number(r.c),
      prev: r.prev === null || r.prev === undefined ? null : Number(r.prev),
      at: Number(r.at),
      by: String(r.by),
    }));
  }

  private recentMoves(limit: number): MoveEntry[] {
    return this.state.storage.sql
      .exec<MoveEntry>(`SELECT id, x, y, c, at FROM history ORDER BY id DESC LIMIT ?`, limit)
      .toArray()
      .map((r) => ({ id: Number(r.id), x: Number(r.x), y: Number(r.y), c: Number(r.c), at: Number(r.at) }));
  }

  private broadcast(message: ServerMessage): void {
    const payload = json(message);
    for (const conn of this.connections.values()) {
      try {
        conn.ws.send(payload);
      } catch {
        this.connections.delete(conn.id);
      }
    }
  }

  private broadcastSystem(message: ServerMessage): void {
    this.broadcast(message);
  }

  private broadcastPresence(): void {
    const players: Player[] = this.state.storage.sql
      .exec<{ handle: string; pixels: number; last_at: number }>(
        `SELECT handle, pixels, last_at FROM players ORDER BY pixels DESC, last_at DESC LIMIT 12`,
      )
      .toArray()
      .map((p) => ({ handle: String(p.handle), pixels: Number(p.pixels), lastAt: Number(p.last_at) }));
    this.broadcast({ t: 'presence', online: this.connections.size, players });
  }

  private maybeSnapshot(now: number): void {
    if (this.totalPixels === 0) return;
    const due = now - this.lastSnapshotAt >= SNAPSHOT_MIN_INTERVAL_MS || this.lastSnapshotAt === 0;
    if (!due) return;
    this.lastSnapshotAt = now;
    const sql = this.state.storage.sql;
    sql.exec(
      `INSERT INTO snapshots (at, version, rle, total_pixels) VALUES (?, ?, ?, ?)`,
      now,
      this.roomVersion,
      this.exportRle(),
      this.totalPixels,
    );
    sql.exec(
      `DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT ?)`,
      SNAPSHOT_MAX,
    );
    this.persistMeta();
  }

  /**
   * Keep the live history table bounded.
   *
   * Deliberately *not* run on every pixel: a `COUNT(*)` over the history table is a
   * full scan, and on the free tier that scan would be charged as rows read on every
   * single write. Trimming every `HISTORY_TRIM_EVERY` writes keeps the cost flat.
   */
  private trimHistory(): void {
    this.writesSinceTrim += 1;
    if (this.writesSinceTrim < HISTORY_TRIM_EVERY) return;
    this.writesSinceTrim = 0;
    const sql = this.state.storage.sql;
    const count = Number(sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM history`).toArray()[0]?.n ?? 0);
    if (count <= HISTORY_LIMIT) return;
    const excess = count - HISTORY_LIMIT;
    sql.exec(`DELETE FROM history WHERE id IN (SELECT id FROM history ORDER BY id ASC LIMIT ?)`, excess);
  }
}

export type { Cell };