import { useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryEntry, Notice, Player, ServerConfig } from '../../shared/protocol';
import { type ReportReason } from '../../shared/protocol';
import type { CanvasSocket, ConnectionState } from '../lib/useCanvasSocket';
import { exportPngUrl, snapshotPngUrl } from '../lib/api';
import { reasonKeys, useT } from '../lib/i18n';

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
  const { t, lang, toggle } = useT();
  const stateLabel: Record<ConnectionState, string> = {
    connecting: t('state.connecting'),
    online: t('state.online'),
    offline: t('state.offline'),
    reconnecting: t('state.reconnecting'),
    fatal: t('state.fatal'),
  };

  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <i /> <i /> <i /> <i />
        </span>
        <span className="brand-text">
          <strong>Pixel Commons</strong>
          <small>{t('brand.tagline')}</small>
        </span>
      </div>

      <div className="header-stats">
        <span className={`live-dot ${state}`} aria-hidden="true" />
        <span data-testid="connection-state" className="stat" data-state={state}>
          {stateLabel[state]}
        </span>
        <span className="stat" data-testid="online-count" title={t('header.onlineTitle')}>
          <b>{online}</b> {t('header.onlineCount')}
        </span>
        <span className="stat hide-sm" title={t('header.pixelsTitle')}>
          <b>{totalPixels.toLocaleString()}</b> {t('header.pixelCount')}
        </span>
        {latency !== null && (
          <span className="stat hide-md" title={t('header.latencyTitle')}>
            <b>{latency}</b> ms
          </span>
        )}
      </div>

      <nav className="header-nav">
        <button
          type="button"
          className="icon-btn lang-btn"
          onClick={toggle}
          title={t('lang.switchTo')}
          aria-label={t('lang.switchTo')}
          data-testid="lang-toggle"
          data-lang={lang}
        >
          <span className="lang-glyph" aria-hidden="true">
            <b>A</b>
            <i>文</i>
          </span>
          <span className="hide-sm">{t('lang.label')}</span>
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={onOpenGallery}
          title={t('nav.historyTitle')}
          data-testid="nav-history"
        >
          <span aria-hidden="true">◷</span>
          <span className="hide-sm">{t('nav.history')}</span>
        </button>
        <button type="button" className="icon-btn" onClick={onOpenHelp} title={t('nav.helpTitle')} data-testid="nav-help">
          <span aria-hidden="true">?</span>
          <span className="hide-sm">{t('nav.help')}</span>
        </button>
        {adminEnabled && (
          <button
            type="button"
            className={`icon-btn ${isAdmin ? 'active' : ''}`}
            onClick={onOpenAdmin}
            title={t('nav.adminTitle')}
            data-testid="nav-admin"
          >
            <span aria-hidden="true">⚙</span>
            <span className="hide-sm">{t('nav.admin')}</span>
          </button>
        )}
        <a
          className="x-link"
          href="https://x.com/0xkillcoin"
          target="_blank"
          rel="noreferrer noopener"
          title={t('nav.xTitle')}
          aria-label={t('nav.xTitle')}
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
  const { t } = useT();
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
        title={canPlace ? t('cooldown.placeTitle') : t('cooldown.waitingTitle')}
      >
        {ready ? t('cooldown.ready') : `${(remaining / 1000).toFixed(1)}s`}
      </button>
      <div
        className="cooldown-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
      >
        <div className="cooldown-fill" style={{ width: `${(1 - ratio) * 100}%` }} />
      </div>
      <span className="cooldown-hint" data-testid="cooldown-hint">
        {state !== 'online'
          ? t('cooldown.offlineHint')
          : ready
            ? t('cooldown.readyHint')
            : t('cooldown.waitingHint')}
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
  const { t } = useT();
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
    <section className="panel palette-panel" aria-label={t('palette.aria')} data-testid="palette">
      <div className="panel-head">
        <h2>{t('palette.title')}</h2>
        <span className={`chip ${cooldownReady ? 'ok' : ''}`}>
          {cooldownReady ? t('palette.ready') : t('palette.cooling')}
        </span>
      </div>

      <div className="swatches">
        {palette.map((hex, index) => (
          <button
            key={hex + index}
            type="button"
            className={`swatch ${selected === index ? 'selected' : ''}`}
            style={{ background: hex }}
            onClick={() => pick(index)}
            aria-label={t('palette.colour', { hex })}
            aria-pressed={selected === index}
            data-testid={`swatch-${index}`}
            title={hex}
          />
        ))}
      </div>

      {recent.length > 0 && (
        <>
          <h3 className="sub-head">{t('palette.recent')}</h3>
          <div className="swatches small">
            {recent.map((index) => (
              <button
                key={`recent-${index}`}
                type="button"
                className={`swatch ${selected === index ? 'selected' : ''}`}
                style={{ background: palette[index] ?? '#000' }}
                onClick={() => pick(index)}
                aria-label={t('palette.recentColour', { hex: palette[index] ?? '' })}
              />
            ))}
          </div>
        </>
      )}

      <h3 className="sub-head">{t('palette.customHead')}</h3>
      <div className="custom-row">
        <input
          type="color"
          value={custom}
          aria-label={t('palette.customAria')}
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
          {t('palette.apply', { index: nearest, hex: palette[nearest] ?? '' })}
        </button>
      </div>
      <p className="fineprint">{t('palette.footnote')}</p>
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
  const { t } = useT();
  return (
    <section className="panel activity-panel" aria-label={t('activity.aria')}>
      <div className="panel-head">
        <h2>{t('activity.title')}</h2>
        <span className="chip">
          {history.length === 0 ? t('activity.quiet') : t('activity.moves', { count: history.length })}
        </span>
      </div>

      {history.length === 0 ? (
        <p className="empty">{t('activity.empty')}</p>
      ) : (
        <ul className="activity-list" data-testid="activity-list">
          {history.slice(0, 14).map((entry) => (
            <li key={entry.id}>
              <button type="button" onClick={() => onJump(entry.x, entry.y)} title={t('activity.jumpTitle')}>
                <span className="dot" style={{ background: palette[entry.c] ?? '#000' }} />
                <span className="mono">
                  ({entry.x},{entry.y})
                </span>
                <span className="who">{entry.by === handle ? t('activity.you') : entry.by}</span>
                <time>{timeAgo(entry.at, t)}</time>
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3 className="sub-head">{t('activity.topPainters')}</h3>
      {players.length === 0 ? (
        <p className="fineprint">{t('activity.rankEmpty')}</p>
      ) : (
        <ol className="leaderboard" data-testid="leaderboard">
          {players.slice(0, 6).map((player, index) => (
            <li key={player.handle + index}>
              <span className="rank">{index + 1}</span>
              <span className="who">{player.handle === handle ? t('activity.you') : player.handle}</span>
              <span className="mono">{player.pixels}p</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function timeAgo(at: number, t?: (key: 'activity.now') => string): string {
  const diff = Math.max(0, Date.now() - at);
  if (diff < 5_000) return t ? t('activity.now') : 'now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

/* -------------------------------------------------------------------------- */
/*                                  banners                                   */
/* -------------------------------------------------------------------------- */

export function NoticeBanner({ notice, onDismiss }: { notice: Notice; onDismiss?: () => void }) {
  const { t } = useT();
  return (
    <div className={`notice ${notice.level}`} role="status">
      <span className="notice-level">{notice.level}</span>
      <span className="notice-text">{notice.message}</span>
      {onDismiss && (
        <button type="button" className="ghost-btn small" onClick={onDismiss} aria-label={t('notice.dismiss')}>
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
  const { t } = useT();
  if (state === 'online' || state === 'connecting') return null;
  if (state === 'fatal') {
    return (
      <div className="notice warn" role="alert">
        <span className="notice-level">{t('conn.sessionLevel')}</span>
        <span className="notice-text">{t('conn.sessionText')}</span>
        <button type="button" className="ghost-btn small" onClick={() => location.reload()}>
          {t('conn.reload')}
        </button>
      </div>
    );
  }
  return (
    <div className="notice warn" role="alert" data-testid="connection-banner">
      <span className="notice-level">
        {state === 'offline' ? t('conn.offlineLevel') : t('conn.retryLevel')}
      </span>
      <span className="notice-text">
        {state === 'offline'
          ? t('conn.offlineText')
          : `${t('conn.retryText')}${attempts > 1 ? t('conn.retryAttempt', { count: attempts }) : ''}…`}
      </span>
      <button type="button" className="ghost-btn small" onClick={onRetry}>
        {t('conn.retryNow')}
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
  const { t } = useT();
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
          <button type="button" className="ghost-btn" onClick={onClose} aria-label={t('modal.close')}>
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
  const { t } = useT();
  const [reason, setReason] = useState<ReportReason>('offensive');
  const [note, setNote] = useState('');
  return (
    <Modal title={t('report.title', { x: cell.x, y: cell.y })} onClose={onClose}>
      <p className="fineprint">{t('report.intro')}</p>
      <label className="field">
        <span>{t('report.reason')}</span>
        <select
          value={reason}
          onChange={(event) => setReason(event.target.value as ReportReason)}
          data-testid="report-reason"
        >
          {(Object.keys(reasonKeys) as ReportReason[]).map((value) => (
            <option key={value} value={value}>
              {t(reasonKeys[value])}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{t('report.details')}</span>
        <textarea
          value={note}
          maxLength={280}
          rows={3}
          onChange={(event) => setNote(event.target.value)}
          placeholder={t('report.placeholder')}
          data-testid="report-note"
        />
      </label>
      <div className="modal-actions">
        <button type="button" className="ghost-btn" onClick={onClose}>
          {t('report.cancel')}
        </button>
        <button type="button" className="primary-btn" onClick={() => onSubmit(reason, note)} data-testid="report-submit">
          {t('report.submit')}
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
  const { t, locale } = useT();
  return (
    <Modal title={t('history.title')} onClose={onClose} wide>
      <div className="history-grid">
        <div>
          <h3 className="sub-head">{t('history.download')}</h3>
          <p className="fineprint">{t('history.exportNote')}</p>
          <div className="row gap">
            <a
              className="primary-btn"
              href={exportPngUrl(1)}
              download={`pixel-commons-${config?.width ?? 256}.png`}
              data-testid="export-1x"
            >
              {t('history.png1x', { size: config?.width ?? 256 })}
            </a>
            <a className="ghost-btn" href={exportPngUrl(4)} download="pixel-commons-4x.png" data-testid="export-4x">
              {t('history.png4x')}
            </a>
          </div>

          <h3 className="sub-head">{t('history.jump')}</h3>
          <JumpForm onJump={onJump} maxX={(config?.width ?? 256) - 1} maxY={(config?.height ?? 256) - 1} />
        </div>

        <div>
          <h3 className="sub-head">{t('history.timeMachine')}</h3>
          {snapshots.length === 0 ? (
            <p className="fineprint">{t('history.snapshotEmpty')}</p>
          ) : (
            <ul className="snapshot-list" data-testid="snapshot-list">
              {snapshots.map((snapshot) => (
                <li key={snapshot.id}>
                  <div>
                    <strong>{new Date(snapshot.at).toLocaleString(locale)}</strong>
                    <small>
                      {t('history.snapshotMeta', {
                        pixels: snapshot.totalPixels.toLocaleString(),
                        version: snapshot.version,
                      })}
                    </small>
                  </div>
                  <a className="ghost-btn small" href={snapshotPngUrl(snapshot.id, 2)} target="_blank" rel="noreferrer">
                    {t('history.view')}
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
  const { t } = useT();
  const [x, setX] = useState('128');
  const [y, setY] = useState('128');
  const submit = () => {
    const nx = Math.max(0, Math.min(maxX, Number.parseInt(x, 10) || 0));
    const ny = Math.max(0, Math.min(maxY, Number.parseInt(y, 10) || 0));
    onJump(nx, ny);
  };
  return (
    <div className="row gap">
      <input
        className="num"
        value={x}
        onChange={(event) => setX(event.target.value)}
        aria-label={t('history.xAria')}
      />
      <input
        className="num"
        value={y}
        onChange={(event) => setY(event.target.value)}
        aria-label={t('history.yAria')}
      />
      <button type="button" className="primary-btn" onClick={submit} data-testid="jump-go">
        {t('history.centre')}
      </button>
    </div>
  );
}

export function HelpDialog({ cooldownSeconds, onClose }: { cooldownSeconds: number; onClose: () => void }) {
  const { t } = useT();
  return (
    <Modal title={t('help.title')} onClose={onClose} wide>
      <div className="help-grid">
        <section>
          <h3 className="sub-head">{t('help.rulesHead')}</h3>
          <ul className="rules">
            <li>{t('help.rule1')}</li>
            <li>
              {t('help.rule2a')} <b>{Math.round(cooldownSeconds)}</b> {t('help.rule2b')}
              {t('help.rule2c')}
            </li>
            <li>{t('help.rule3')}</li>
            <li>{t('help.rule4')}</li>
          </ul>
        </section>
        <section>
          <h3 className="sub-head">{t('help.controlsHead')}</h3>
          <ul className="rules">
            <li>
              <b>{t('help.desktopLead')}</b> {t('help.desktopText')}
            </li>
            <li>
              <b>{t('help.phoneLead')}</b> {t('help.phoneText')}
            </li>
            <li>
              {t('help.shareLead')} <code>?x=64&amp;y=96&amp;z=8</code> {t('help.shareText')}
            </li>
          </ul>
        </section>
        <section>
          <h3 className="sub-head">{t('help.fairHead')}</h3>
          <ul className="rules">
            <li>{t('help.fair1')}</li>
            <li>{t('help.fair2')}</li>
            <li>{t('help.fair3')}</li>
          </ul>
        </section>
        <section>
          <h3 className="sub-head">{t('help.ossHead')}</h3>
          <p className="fineprint">{t('help.ossText')}</p>
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
