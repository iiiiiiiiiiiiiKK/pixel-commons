/**
 * Wire protocol shared by the Cloudflare Worker, the Durable Object and the browser client.
 *
 * Design goals
 *  - Every mutation is a tiny, compressed, versioned delta (never a full canvas).
 *  - Clients never decide authority: they send an intent, the server validates it and
 *    broadcasts the *accepted* pixel back with the authoritative colour and timestamp.
 *  - All payloads are JSON so they can be inspected from the browser devtools.
 */

export type Cell = {
  /** x coordinate, 0-based */
  x: number;
  /** y coordinate, 0-based */
  y: number;
  /** palette index (0-15 for the default palette, up to 63 for custom palettes) */
  c: number;
};

export type ServerConfig = {
  width: number;
  height: number;
  palette: string[];
  cooldownMs: number;
  onlineCount: number;
  /** server time (epoch ms) when this snapshot was produced */
  serverTime: number;
  /** monotonic version of the authoritative canvas */
  version: number;
  /** total number of accepted pixels since the canvas was created */
  totalPixels: number;
  canvasId: string;
  canvasName: string;
  /** the currently published maintenance notice, or null */
  notice: Notice | null;
  /**
   * False when durable storage is temporarily refusing writes (free-tier quota or a
   * platform hiccup). The canvas keeps working in memory; the UI surfaces this so a
   * user is never told a pixel was saved for good when it may not have been.
   */
  storageHealthy?: boolean;
};

export type Notice = {
  message: string;
  level: 'info' | 'warn' | 'maintenance';
  since: number;
  updatedBy: string;
};

export type HistoryEntry = {
  id: number;
  x: number;
  y: number;
  c: number;
  /** previous colour index at that position, or null when the cell was untouched (background) */
  prev: number | null;
  at: number;
  /** short, non-personal display handle of the author */
  by: string;
};

export type MoveEntry = {
  id: number;
  x: number;
  y: number;
  c: number;
  at: number;
};

export type Player = {
  handle: string;
  pixels: number;
  /** epoch ms of last accepted pixel, 0 when the player has not painted yet */
  lastAt: number;
};

export type Report = {
  id: number;
  x: number;
  y: number;
  reason: string;
  note: string;
  at: number;
  status: 'open' | 'resolved' | 'rejected';
  by: string;
};

/** Client -> server messages */
export type ClientMessage =
  | { t: 'hello'; since?: number }
  | { t: 'place'; x: number; y: number; c: number; nonce: string }
  | { t: 'ping'; ts: number }
  | { t: 'report'; x: number; y: number; reason: ReportReason; note?: string };

export type ReportReason = 'offensive' | 'spam' | 'copyright' | 'other';

/** Server -> client messages */
export type ServerMessage =
  | ({ t: 'welcome' } & WelcomePayload)
  | { t: 'pong'; ts: number; serverTime: number }
  | { t: 'presence'; online: number; players: Player[] }
  | {
      t: 'pixels';
      /** authoritative accepted pixels (delta) */
      cells: Cell[];
      /** id of the newest history row, so clients can keep the live feed in sync */
      lastId: number;
      /** per-connection cooldown deadline (epoch ms); only sent to the author */
      nextAt?: number;
      /** total accepted pixels on the canvas */
      totalPixels: number;
      version: number;
      /** the author's handle, only sent to the author */
      self?: string;
      /** present and false only when the server failed to persist this write */
      storageHealthy?: boolean;
    }
  | { t: 'reject'; reason: RejectReason; message: string; nextAt?: number; retryAfterMs?: number }
  | { t: 'notice'; notice: Notice | null }
  | { t: 'error'; message: string };

export type WelcomePayload = {
  config: ServerConfig;
  /** RLE-encoded authoritative canvas, base64url */
  canvas: string;
  /** recent moves, newest first */
  recent: MoveEntry[];
  /** history entries newer than the client's `since` (ascending) */
  history: HistoryEntry[];
  /** the id of the newest history row server-side */
  lastId: number;
  /** the connecting user's cooldown deadline (epoch ms) */
  nextAt: number;
  /** this connection's display handle */
  handle: string;
  /** whether the current session carries admin rights */
  isAdmin: boolean;
  /** your own summary: pixels placed */
  me: { pixels: number };
  /** open reports count, only sent to admins */
  openReports?: number;
};

export type RejectReason =
  | 'cooldown'
  | 'out_of_bounds'
  | 'bad_color'
  | 'bad_request'
  | 'rate_limited'
  | 'maintenance'
  | 'forbidden'
  | 'unchanged'
  | 'server_error';

export type SnapshotMeta = {
  version: number;
  width: number;
  height: number;
  totalPixels: number;
  takenAt: number;
  canvasName: string;
};

export type AdminAction = {
  id: number;
  action: string;
  detail: string;
  by: string;
  at: number;
};

export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  offensive: 'Offensive content',
  spam: 'Spam / advertising',
  copyright: 'Copyright issue',
  other: 'Something else',
};
