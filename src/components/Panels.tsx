import { useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryEntry, Notice, Player, ServerConfig } from '../../shared/protocol';
import { REPORT_REASON_LABELS, type ReportReason } from '../../shared/protocol';
import type { CanvasSocket, ConnectionState } from '../lib/useCanvasSocket';
import { exportPngUrl, snapshotPngUrl } from '../lib/api';

/* -------------------------------------------------------------------------- */
/*                                   header                                   */
/* -------------------------------------------------------------------------- */

export function Header({
  online,
  state,
  latency,
  totalPixels,
  onOpenHelp,
  onOpenGallery,
  onOpenAdmin,
  isAdmin,
  adminEnabled,
}: {
  online: number;
  state: ConnectionState;
  latency: number | null;
  totalPixels: number;
  onOpenHelp: () => void;
  onOpenGallery: () => void;
  onOpenAdmin: () => void;
  isAdmin: boolean;
  adminEnabled: boolean;
}) {
  const stateLabel: Record<ConnectionState, string> = {
    connecting: 'connecting',
    online: 'live',
    offline: 'offline',
    reconnecting: 'reconnecting',
    fatal: 'session expired',
  };
  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <i /> <i /> <i /> <i />
        </span>
        <span className="brand-text">
          <strong>Pixel Commons</strong>
          <small>one canvas · everyone draws</small>
        </span>
      </div>

      <div className="header-stats">
        <span className={`live-dot ${state}`} aria-hidden="true" />
        <span data-testid="connection-state" className="stat">
          {stateLabel[state]}
        </span>
        <span className="stat" data-testid="online-count" title="People currently connected">
          <b>{online}</b> online
        </span>
        <span className="stat hide-sm" title="Total accepted pixels">
          <b>{totalPixels.toLocaleString()}</b> pixels
        </span>
        {latency !== null && (
          <span className="stat hide-md" title="Round-trip latency">
            <b>{latency}</b> ms
          </span>
        )}
      </div>

      <nav className="header-nav">
        <button type="button" className="icon-btn" onClick={onOpenGallery} title="History & snapshots">
          <span aria-hidden="true">◷</span>
          <span className="hide-sm">History</span>
        </button>
        <button type="button" className="icon-btn" onClick={onOpenHelp} title="Rules & help">
          <span aria-hidden="true">?</span>
          <span className="hide-sm">Help</span>
        </button>
        {adminEnabled && (
          <button
            type="button"
            className={`icon-btn ${isAdmin ? 'active' : ''}`}
            onClick={onOpenAdmin}
            title="Admin console"
          >
            <span aria-hidden="true">⚙</span>
            <span className="hide-sm">Admin</span>
          </button>
        )}
        <a
          className="x-link"
          href="https://x.com/0xkillcoin"
          target="_blank"
          rel="noreferrer noopener"
          title="Follow the maker on X"
          aria-label="Follow the maker on X (@0xkillcoin)"
          data-testid="x-link"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16">
            <path
              fill="currentColor"
              d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
            />
          </svg>
          <span className="x-handle">@0xkillcoin</span>
        </a>
      </nav>
    </header>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  cooldown                                  */
/* -------------------------------------------------------------------------- */

export function CooldownBar({
  nextAt,
  cooldownMs,
  state,
  onTryPlace,
  canPlace,
}: {
  nextAt: number;
  cooldownMs: number;
  state: ConnectionState;
  canPlace: boolean;
  onTryPlace: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);

  const remaining = Math.max(0, nextAt - now);
  const ratio = cooldownMs > 0 ? Math.min(1, remaining / cooldownMs) : 0;
  const ready = remaining === 0;

  return (
    <div className={`cooldown ${ready ? 'ready' : 'waiting'}`}>
      <button
        type="button"
        className="place-cta"
        onClick={onTryPlace}
        disabled={!canPlace}
        data-testid="place-cta"
        title={canPlace ? 'Place a pixel (or tap the canvas)' : 'Waiting for the server'}
      >
        {ready ? 'Ready' : `${(remaining / 1000).toFixed(1)}s`}
      </button>
      <div className="cooldown-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)}>
        <div className="cooldown-fill" style={{ width: `${(1 - ratio) * 100}%` }} />
      </div>
      <span className="cooldown-hint" data-testid="cooldown-hint">
        {state !== 'online'
          ? 'offline — server decides when you can paint'
          : ready
            ? 'pick a colour, tap the canvas'
            : 'server-enforced cooldown'}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                   palette                                  */
/* -------------------------------------------------------------------------- */

const RECENT_KEY = 'pc.recentColors';
const CUSTOM_KEY = 'pc.customColor';

export function Palette({
  palette,
  selected,
  onSelect,
  cooldownReady,
}: {
  palette: string[];
  selected: number;
  onSelect: (index: number) => void;
  cooldownReady: boolean;
}) {
  const [recent, setRecent] = useState<number[]>(() => {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      return raw ? (JSON.parse(raw) as number[]).slice(0, 8) : [];
    } catch {
      return [];
    }
  });
  const [custom, setCustom] = useState<string>(() => {
    try {
      return localStorage.getItem(CUSTOM_KEY) ?? '#ff004d';
    } catch {
      return '#ff004d';
    }
  });

  const pick = (index: number) => {
    onSelect(index);
    setRecent((prev) => {
      const next = [index, ...prev.filter((i) => i !== index)].slice(0, 8);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        /* storage may be unavailable in private mode */
      }
      return next;
    });
  };

  const nearest = useMemo(() => nearestPaletteIndex(palette, custom), [palette, custom]);

  return (
    <section className="panel palette-panel" aria-label="Colour palette" data-testid="palette">
      <div className="panel-head">
        <h2>Palette</h2>
        <span className={`chip ${cooldownReady ? 'ok' : ''}`}>{cooldownReady ? 'ready' : 'cooling'}</span>
      </div>

      <div className="swatches">
        {palette.map((hex, index) => (
          <button
            key={hex + index}
            type="button"
            className={`swatch ${selected === index ? 'selected' : ''}`}
            style={{ background: hex }}
            onClick={() => pick(index)}
            aria-label={`Colour ${hex}`}
            aria-pressed={selected === index}
            data-testid={`swatch-${index}`}
            title={hex}
          />
        ))}
      </div>

      {recent.length > 0 && (
        <>
          <h3 className="sub-head">Recent</h3>
          <div className="swatches small">
            {recent.map((index) => (
              <button
                key={`recent-${index}`}
                type="button"
                className={`swatch ${selected === index ? 'selected' : ''}`}
                style={{ background: palette[index] ?? '#000' }}
                onClick={() => pick(index)}
                aria-label={`Recent colour ${palette[index]}`}
              />
            ))}
          </div>
        </>
      )}

      <h3 className="sub-head">Custom → nearest palette</h3>
      <div className="custom-row">
        <input
          type="color"
          value={custom}
          aria-label="Custom colour"
          onChange={(event) => {
            setCustom(event.target.value);
            try {
              localStorage.setItem(CUSTOM_KEY, event.target.value);
            } catch {
              /* ignore */
            }
          }}
        />
        <button type="button" className="ghost-btn" onClick={() => pick(nearest)} data-testid="apply-custom">
          use #{nearest} · {palette[nearest]}
        </button>
      </div>
      <p className="fineprint">
        The canvas stores palette indices, so a custom colour snaps to its closest palette entry — that keeps the
        artwork consistent and the socket payload one byte per pixel.
      </p>
    </section>
  );
}

function nearestPaletteIndex(palette: string[], hex: string): number {
  const target = hexToRgb(hex);
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  palette.forEach((entry, index) => {
    const rgb = hexToRgb(entry);
    const distance = (rgb[0] - target[0]) ** 2 + (rgb[1] - target[1]) ** 2 + (rgb[2] - target[2]) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  return [
    Number.parseInt(full.slice(0, 2), 16) || 0,
    Number.parseInt(full.slice(2, 4), 16) || 0,
    Number.parseInt(full.slice(4, 6), 16) || 0,
  ];
}

/* -------------------------------------------------------------------------- */
/*                                  activity                                  */
/* -------------------------------------------------------------------------- */

export function ActivityFeed({
  history,
  palette,
  onJump,
  players,
  handle,
}: {
  history: HistoryEntry[];
  palette: string[];
  onJump: (x: number, y: number) => void;
  players: Player[];
  handle: string;
}) {
  return (
    <section className="panel activity-panel" aria-label="Recent activity">
      <div className="panel-head">
        <h2>Live activity</h2>
        <span className="chip">{history.length === 0 ? 'quiet' : `${history.length} moves`}</span>
      </div>

      {history.length === 0 ? (
        <p className="empty">No pixels yet. Place the very first one - it will be in the history forever.</p>
      ) : (
        <ul className="activity-list" data-testid="activity-list">
          {history.slice(0, 14).map((entry) => (
            <li key={entry.id}>
              <button type="button" onClick={() => onJump(entry.x, entry.y)} title="Centre the canvas here">
                <span className="dot" style={{ background: palette[entry.c] ?? '#000' }} />
                <span className="mono">({entry.x},{entry.y})</span>
                <span className="who">{entry.by === handle ? 'you' : entry.by}</span>
                <time>{timeAgo(entry.at)}</time>
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3 className="sub-head">Top painters</h3>
      {players.length === 0 ? (
        <p className="fineprint">Rankings appear after the first pixels land.</p>
      ) : (
        <ol className="leaderboard" data-testid="leaderboard">
          {players.slice(0, 6).map((player, index) => (
            <li key={player.handle + index}>
              <span className="rank">{index + 1}</span>
              <span className="who">{player.handle === handle ? 'you' : player.handle}</span>
              <span className="mono">{player.pixels}p</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function timeAgo(at: number): string {
  const diff = Math.max(0, Date.now() - at);
  if (diff < 5_000) return 'now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

/* -------------------------------------------------------------------------- */
/*                                  banners                                   */
/* -------------------------------------------------------------------------- */

export function NoticeBanner({ notice, onDismiss }: { notice: Notice; onDismiss?: () => void }) {
  return (
    <div className={`notice ${notice.level}`} role="status">
      <span className="notice-level">{notice.level}</span>
      <span className="notice-text">{notice.message}</span>
      {onDismiss && (
        <button type="button" className="ghost-btn small" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}

export function ConnectionBanner({
  state,
  attempts,
  onRetry,
}: {
  state: ConnectionState;
  attempts: number;
  onRetry: () => void;
}) {
  if (state === 'online' || state === 'connecting') return null;
  if (state === 'fatal') {
    return (
      <div className="notice warn" role="alert">
        <span className="notice-level">session</span>
        <span className="notice-text">Your session expired. Reload the page to get a fresh anonymous identity.</span>
        <button type="button" className="ghost-btn small" onClick={() => location.reload()}>
          reload
        </button>
      </div>
    );
  }
  return (
    <div className="notice warn" role="alert" data-testid="connection-banner">
      <span className="notice-level">{state === 'offline' ? 'offline' : 'retrying'}</span>
      <span className="notice-text">
        {state === 'offline'
          ? 'You are offline. Pixels cannot be sent until the connection returns.'
          : `Reconnecting to the canvas${attempts > 1 ? ` (attempt ${attempts})` : ''}…`}
      </span>
      <button type="button" className="ghost-btn small" onClick={onRetry}>
        retry now
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                   modals                                   */
/* -------------------------------------------------------------------------- */

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="ghost-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function ReportDialog({
  cell,
  onClose,
  onSubmit,
}: {
  cell: { x: number; y: number };
  onClose: () => void;
  onSubmit: (reason: ReportReason, note: string) => void;
}) {
  const [reason, setReason] = useState<ReportReason>('offensive');
  const [note, setNote] = useState('');
  return (
    <Modal title={`Report pixel (${cell.x}, ${cell.y})`} onClose={onClose}>
      <p className="fineprint">
        Reports go to a moderation queue with the offending coordinate, never to the public timeline. Misuse of the
        report form is rate limited per session.
      </p>
      <label className="field">
        <span>Reason</span>
        <select value={reason} onChange={(event) => setReason(event.target.value as ReportReason)} data-testid="report-reason">
          {Object.entries(REPORT_REASON_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Details (optional)</span>
        <textarea
          value={note}
          maxLength={280}
          rows={3}
          onChange={(event) => setNote(event.target.value)}
          placeholder="What is wrong with this area?"
          data-testid="report-note"
        />
      </label>
      <div className="modal-actions">
        <button type="button" className="ghost-btn" onClick={onClose}>
          cancel
        </button>
        <button type="button" className="primary-btn" onClick={() => onSubmit(reason, note)} data-testid="report-submit">
          send report
        </button>
      </div>
    </Modal>
  );
}

export function HistoryDialog({
  snapshots,
  onClose,
  onJump,
  config,
}: {
  snapshots: Array<{ id: number; at: number; version: number; totalPixels: number }>;
  onClose: () => void;
  onJump: (x: number, y: number) => void;
  config: ServerConfig | null;
}) {
  return (
    <Modal title="History & snapshots" onClose={onClose} wide>
      <div className="history-grid">
        <div>
          <h3 className="sub-head">Download</h3>
          <p className="fineprint">
            The export is rendered server-side from the authoritative canvas, so it always matches what everyone else
            sees.
          </p>
          <div className="row gap">
            <a className="primary-btn" href={exportPngUrl(1)} download={`pixel-commons-${config?.width ?? 256}.png`} data-testid="export-1x">
              PNG 1× ({config?.width ?? 256}px)
            </a>
            <a className="ghost-btn" href={exportPngUrl(4)} download="pixel-commons-4x.png" data-testid="export-4x">
              PNG 4×
            </a>
          </div>

          <h3 className="sub-head">Jump to a coordinate</h3>
          <JumpForm onJump={onJump} maxX={(config?.width ?? 256) - 1} maxY={(config?.height ?? 256) - 1} />
        </div>

        <div>
          <h3 className="sub-head">Time machine</h3>
          {snapshots.length === 0 ? (
            <p className="fineprint">
              A snapshot is taken automatically every 10 minutes of drawing activity. None exist yet — paint something
              and come back.
            </p>
          ) : (
            <ul className="snapshot-list" data-testid="snapshot-list">
              {snapshots.map((snapshot) => (
                <li key={snapshot.id}>
                  <div>
                    <strong>{new Date(snapshot.at).toLocaleString()}</strong>
                    <small>
                      {snapshot.totalPixels.toLocaleString()} pixels · v{snapshot.version}
                    </small>
                  </div>
                  <a className="ghost-btn small" href={snapshotPngUrl(snapshot.id, 2)} target="_blank" rel="noreferrer">
                    view
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

function JumpForm({ onJump, maxX, maxY }: { onJump: (x: number, y: number) => void; maxX: number; maxY: number }) {
  const [x, setX] = useState('128');
  const [y, setY] = useState('128');
  const submit = () => {
    const nx = Math.max(0, Math.min(maxX, Number.parseInt(x, 10) || 0));
    const ny = Math.max(0, Math.min(maxY, Number.parseInt(y, 10) || 0));
    onJump(nx, ny);
  };
  return (
    <div className="row gap">
      <input className="num" value={x} onChange={(event) => setX(event.target.value)} aria-label="X coordinate" />
      <input className="num" value={y} onChange={(event) => setY(event.target.value)} aria-label="Y coordinate" />
      <button type="button" className="primary-btn" onClick={submit} data-testid="jump-go">
        centre
      </button>
    </div>
  );
}

export function HelpDialog({ cooldownSeconds, onClose }: { cooldownSeconds: number; onClose: () => void }) {
  return (
    <Modal title="How Pixel Commons works" onClose={onClose} wide>
      <div className="help-grid">
        <section>
          <h3 className="sub-head">The rules</h3>
          <ul className="rules">
            <li>One shared canvas. Everyone paints the same artwork.</li>
            <li>
              One pixel every <b>{Math.round(cooldownSeconds)} seconds</b>, enforced by the server — refreshing or
              opening more tabs does not give you extra turns.
            </li>
            <li>Pixels are permanent unless an admin resets the canvas.</li>
            <li>No accounts, no email: you get a signed anonymous session that lasts 30 days.</li>
          </ul>
        </section>
        <section>
          <h3 className="sub-head">Controls</h3>
          <ul className="rules">
            <li>
              <b>Desktop:</b> scroll to zoom, drag to pan, click to place. Hold <kbd>Shift</kbd> + click a pixel to
              report it.
            </li>
            <li>
              <b>Phone:</b> pinch to zoom, drag with one finger to pan, tap to place. Long-press a pixel to report it.
            </li>
            <li>Share links look like <code>?x=64&amp;y=96&amp;z=8</code> and open centred on that pixel.</li>
          </ul>
        </section>
        <section>
          <h3 className="sub-head">Fair play</h3>
          <ul className="rules">
            <li>The client never decides cooldown, colour validity or coordinates — the Durable Object does.</li>
            <li>Rate limits apply per connection and per session; automated spam is dropped.</li>
            <li>Content reports are reviewed by admins; the queue and every admin action are logged.</li>
          </ul>
        </section>
        <section>
          <h3 className="sub-head">Open source</h3>
          <p className="fineprint">
            Pixel Commons is MIT licensed. Fork it, run your own canvas, or deploy it to your own Cloudflare account —
            the README walks through the whole thing.
          </p>
        </section>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/*                                    toast                                   */
/* -------------------------------------------------------------------------- */

export type Toast = { id: number; kind: 'ok' | 'error' | 'info'; message: string };

export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toast-stack" aria-live="polite" data-testid="toast-stack">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`} onClick={() => onDismiss(toast.id)} role="status">
          {toast.message}
        </div>
      ))}
    </div>
  );
}

export type { CanvasSocket };
