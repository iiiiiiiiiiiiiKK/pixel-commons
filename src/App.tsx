import { useCallback, useEffect, useRef, useState } from 'react';
import type { Cell, ServerConfig } from '../shared/protocol';
import { unpackRle, base64UrlToBytes } from '../shared/rle';
import { api, ApiError, isStaticBuild, apiBase } from './lib/api';
import { useCanvasSocket } from './lib/useCanvasSocket';
import { useT, type MessageKey } from './lib/i18n';
import PixelCanvas from './components/PixelCanvas';
import AdminConsole from './components/AdminConsole';
import {
  ActivityFeed,
  ConnectionBanner,
  CooldownBar,
  Header,
  HelpDialog,
  HistoryDialog,
  NoticeBanner,
  Palette,
  ReportDialog,
  ToastStack,
  type Toast,
} from './components/Panels';

type ShareTarget = { x: number; y: number; z: number } | null;

function readShareTarget(): ShareTarget {
  const params = new URLSearchParams(location.search);
  const x = Number.parseInt(params.get('x') ?? '', 10);
  const y = Number.parseInt(params.get('y') ?? '', 10);
  const z = Number.parseFloat(params.get('z') ?? '');
  if (Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0) {
    return { x, y, z: Number.isFinite(z) ? Math.min(40, Math.max(1, z)) : 10 };
  }
  return null;
}

/** Server rejections carry a stable reason code, which is what gets localised. */
const REJECT_KEYS: Record<string, MessageKey> = {
  cooldown: 'reject.cooldown',
  out_of_bounds: 'reject.out_of_bounds',
  bad_color: 'reject.bad_color',
  bad_request: 'reject.bad_request',
  rate_limited: 'reject.rate_limited',
  maintenance: 'reject.maintenance',
  forbidden: 'reject.forbidden',
  unchanged: 'reject.unchanged',
  server_error: 'reject.server_error',
};

export default function App() {
  const { t } = useT();
  const canvasRef = useRef<Uint8Array | null>(null);
  const [fullVersion, setFullVersion] = useState(0);
  const [patch, setPatch] = useState<Cell[]>([]);
  const [patchVersion, setPatchVersion] = useState(0);
  const [selectedColor, setSelectedColor] = useState(13);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [bootError, setBootError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [adminEnabled, setAdminEnabled] = useState(false);

  const [showHelp, setShowHelp] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [reportCell, setReportCell] = useState<{ x: number; y: number } | null>(null);
  const [snapshots, setSnapshots] = useState<Array<{ id: number; at: number; version: number; totalPixels: number }>>([]);
  const [focusRequest, setFocusRequest] = useState<{ x: number; y: number; nonce: number } | null>(null);
  const [mobilePanel, setMobilePanel] = useState<'palette' | 'activity' | null>(null);

  const pushToast = useCallback((message: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-3), { id, kind, message }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), kind === 'error' ? 6500 : 3800);
  }, []);

  const onCanvas = useCallback((canvas: Uint8Array) => {
    canvasRef.current = canvas;
    setFullVersion((v) => v + 1);
    setReady(true);
  }, []);

  const onPixels = useCallback((cells: Cell[]) => {
    const buffer = canvasRef.current;
    const config = configRef.current;
    if (!buffer || !config) return;
    for (const cell of cells) {
      if (cell.x >= 0 && cell.y >= 0 && cell.x < config.width && cell.y < config.height) {
        buffer[cell.y * config.width + cell.x] = cell.c;
      }
    }
    setPatch(cells);
    setPatchVersion((v) => v + 1);
  }, []);

  const onReset = useCallback((canvas: Uint8Array) => {
    canvasRef.current = canvas;
    setFullVersion((v) => v + 1);
  }, []);

  /**
   * The socket is only opened after `/api/session` succeeds. In the same-origin build
   * that is a formality; in the static cross-origin build the token returned by that
   * request is the only way to authenticate the WebSocket handshake, so waiting for it
   * avoids a guaranteed failed connection on first load.
   */
  const [bootstrap, setBootstrap] = useState<'pending' | 'ready' | 'failed'>('pending');
  const socket = useCanvasSocket({ onCanvas, onPixels, onReset, enabled: bootstrap === 'ready' });
  const configRef = useRef<ServerConfig | null>(null);
  configRef.current = socket.config;

  /* ------------------------------------------------------------- bootstrap */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = await api.session();
        if (cancelled) return;
        setAdminEnabled(session.adminEnabled);
        setBootstrap('ready');
      } catch (error) {
        if (cancelled) return;
        const message =
          error instanceof ApiError ? error.message : 'Could not reach the Pixel Commons server.';
        setBootstrap('failed');
        setBootError(message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ------------------------------------------------- share target on load */

  const appliedShare = useRef(false);
  useEffect(() => {
    if (!ready || appliedShare.current || !socket.config) return;
    const target = readShareTarget();
    if (!target) return;
    appliedShare.current = true;
    setFocusRequest({ x: target.x, y: target.y, nonce: Date.now() });
    pushToast(t('app.openedAt', { x: target.x, y: target.y }), 'info');
  }, [ready, socket.config, pushToast, t]);

  /* -------------------------------------------------------- cooldown state */

  const cooldownMs = socket.config?.cooldownMs ?? 30_000;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);
  const cooldownReady = socket.nextAt <= now;
  const canPlace = socket.state === 'online' && cooldownReady && socket.config !== null;

  /* ----------------------------------------------------------- rejection UI */

  const lastRejection = useRef<number>(0);
  useEffect(() => {
    if (!socket.rejection || socket.rejection.at === lastRejection.current) return;
    lastRejection.current = socket.rejection.at;
    const reason = socket.rejection.reason;
    const key = REJECT_KEYS[reason];
    // Fall back to the server's own text only for reasons we do not have a
    // translation for, so a new server-side rule never shows the wrong sentence.
    const message = key
      ? t(key, { seconds: Math.max(0, Math.ceil(((socket.rejection.nextAt ?? 0) - Date.now()) / 1000)) })
      : socket.rejection.message;
    pushToast(message, 'error');
  }, [socket.rejection, pushToast, t]);

  /* -------------------------------------------------------------- placing */

  const place = useCallback(
    (x: number, y: number, options: { report?: boolean } = {}) => {
      if (!socket.config) return;
      if (options.report) {
        setReportCell({ x, y });
        return;
      }
      if (socket.state !== 'online') {
        pushToast(t('app.offlinePixel'), 'error');
        return;
      }
      if (!cooldownReady) {
        pushToast(t('app.cooldownLeft', { seconds: Math.ceil((socket.nextAt - Date.now()) / 1000) }), 'info');
        return;
      }
      socket.place(x, y, selectedColor);
    },
    [cooldownReady, pushToast, selectedColor, socket, t],
  );

  const handlePlaceAttempt = useCallback(() => {
    const target = hover ?? (focusRequest ? { x: focusRequest.x, y: focusRequest.y } : null);
    if (!target) {
      pushToast(t('app.tapPixel'), 'info');
      return;
    }
    place(target.x, target.y);
  }, [focusRequest, hover, place, pushToast, t]);

  /* ---------------------------------------------------------------- share */

  const shareLink = useCallback(() => {
    const params = new URLSearchParams();
    if (hover) {
      params.set('x', String(hover.x));
      params.set('y', String(hover.y));
      params.set('z', '12');
    }
    const url = `${location.origin}${location.pathname}${params.toString() ? `?${params}` : ''}`;
    navigator.clipboard
      ?.writeText(url)
      .then(() => pushToast(t('app.shareCopied'), 'ok'))
      .catch(() => {
        window.prompt(t('app.copyPrompt'), url);
      });
  }, [hover, pushToast, t]);

  /* ------------------------------------------------------------- dialogs */

  const openHistory = useCallback(async () => {
    setShowHistory(true);
    try {
      const data = await api.snapshots();
      setSnapshots(data.snapshots);
    } catch {
      setSnapshots([]);
    }
  }, []);

  const jumpTo = useCallback((x: number, y: number) => {
    setFocusRequest({ x, y, nonce: Date.now() });
    setShowHistory(false);
  }, []);

  /* ------------------------------------------------------------- keyboard */

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (event.key === '?' || (event.key === '/' && event.shiftKey)) setShowHelp(true);
      else if (event.key.toLowerCase() === 'h') void openHistory();
      else if (event.key === '+' || event.key === '=') {
        document.querySelector<HTMLButtonElement>('[data-testid="zoom-in"]')?.click();
      } else if (event.key === '-') {
        document.querySelector<HTMLButtonElement>('[data-testid="zoom-out"]')?.click();
      } else if (event.key === '0') {
        document.querySelector<HTMLButtonElement>('[data-testid="zoom-fit"]')?.click();
      } else if (event.key.toLowerCase() === 'e') {
        window.open(`${apiBase}/api/export.png?scale=4`, '_blank', 'noopener');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openHistory]);

  /* --------------------------------------------------------------- render */

  if (bootError) {
    return (
      <div className="boot-error" data-testid="boot-error">
        <h1>{t('app.bootTitle')}</h1>
        <p>{bootError}</p>
        <p className="fineprint">
          {t('app.bootHint1')} <code>{apiBase || location.origin}</code>. {t('app.bootHint2')}{' '}
          <code>VITE_API_BASE</code> {t('app.bootHint3')}
        </p>
        <button type="button" className="primary-btn" onClick={() => location.reload()}>
          {t('app.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Header
        online={socket.online}
        state={socket.state}
        latency={socket.latency}
        totalPixels={socket.config?.totalPixels ?? 0}
        isAdmin={socket.session?.isAdmin ?? false}
        adminEnabled={adminEnabled}
        onOpenHelp={() => setShowHelp(true)}
        onOpenGallery={() => void openHistory()}
        onOpenAdmin={() => setShowAdmin(true)}
      />

      <div className="banner-stack">
        <ConnectionBanner state={socket.state} attempts={socket.attempts} onRetry={socket.retryNow} />
        {socket.config?.storageHealthy === false && (
          <div className="notice warn" role="alert" data-testid="storage-banner">
            <span className="notice-level">{t('app.storageLevel')}</span>
            <span className="notice-text">{t('app.storageText')}</span>
          </div>
        )}
        {socket.notice && <NoticeBanner notice={socket.notice} />}
      </div>

      <main className={`app-main ${ready ? 'ready' : 'loading'}`}>
        <aside className="side left">
          <Palette
            palette={socket.config?.palette ?? []}
            selected={selectedColor}
            onSelect={setSelectedColor}
            cooldownReady={cooldownReady}
          />
        </aside>

        <div className="stage-wrap">
          {!socket.config || !ready ? (
            <div className="canvas-skeleton" data-testid="canvas-skeleton">
              <div className="spinner" aria-hidden="true" />
              <p>{t('app.loadingCanvas')}</p>
              <small>{socket.state === 'connecting' ? t('app.connectingRoom') : t(`state.${socket.state}`)}</small>
            </div>
          ) : null}
          {socket.config && (
            <PixelCanvas
              config={socket.config}
              canvasRef={canvasRef}
              fullVersion={fullVersion}
              patch={patch}
              patchVersion={patchVersion}
              selectedColor={selectedColor}
              canPlace={canPlace}
              focusRequest={focusRequest}
              onPlace={(x, y, options) => place(x, y, options)}
              onReport={(x, y) => setReportCell({ x, y })}
              onHover={setHover}
            >
              <div className="canvas-overlay bottom">
                <CooldownBar
                  nextAt={socket.nextAt}
                  cooldownMs={cooldownMs}
                  state={socket.state}
                  canPlace={canPlace}
                  onTryPlace={handlePlaceAttempt}
                />
              </div>
              <div className="canvas-overlay top-right">
                <span className="coord" data-testid="coord-readout">
                  {hover ? `x ${hover.x} · y ${hover.y}` : `${socket.config.width}×${socket.config.height}`}
                </span>
                <button type="button" className="ghost-btn small" onClick={() => void shareLink()} data-testid="share-link">
                  {t('app.share')}
                </button>
                <button
                  type="button"
                  className="ghost-btn small"
                  onClick={() => (hover ? setReportCell(hover) : pushToast(t('app.hoverFirst'), 'info'))}
                  data-testid="report-open"
                >
                  {t('app.report')}
                </button>
              </div>
              <div className="mobile-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={mobilePanel === 'palette'}
                  className={mobilePanel === 'palette' ? 'active' : ''}
                  onClick={() => setMobilePanel((p) => (p === 'palette' ? null : 'palette'))}
                  data-testid="tab-colours"
                >
                  {t('app.tabColours')}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mobilePanel === 'activity'}
                  className={mobilePanel === 'activity' ? 'active' : ''}
                  onClick={() => setMobilePanel((p) => (p === 'activity' ? null : 'activity'))}
                  data-testid="tab-activity"
                >
                  {t('app.tabActivity')}
                </button>
              </div>
            </PixelCanvas>
          )}
        </div>

        <aside className="side right">
          <ActivityFeed
            history={socket.history}
            palette={socket.config?.palette ?? []}
            onJump={jumpTo}
            players={socket.players}
            handle={socket.session?.handle ?? ''}
          />
          <section className="panel meta-panel">
            <div className="panel-head">
              <h2>{t('app.sessionTitle')}</h2>
              <span className="chip">
                {socket.session?.isAdmin ? t('app.sessionAdmin') : t('app.sessionAnon')}
              </span>
            </div>
            <p className="fineprint">
              {t('app.handle')}{' '}
              <b className="mono" data-testid="handle">
                {socket.session?.handle ?? '—'}
              </b>
              <br />
              {t('app.pixelsPlaced')} <b>{socket.session?.pixels ?? 0}</b>
              <br />
              {t('app.cooldownPerPixel')} <b>{(cooldownMs / 1000).toFixed(0)}s</b> {t('app.perPixel')}
            </p>
            <button type="button" className="ghost-btn small" onClick={() => void socket.requestHistory()}>
              {t('app.refreshFeed')}
            </button>
          </section>
        </aside>
      </main>

      {mobilePanel && (
        <div
          className="mobile-sheet"
          role="dialog"
          aria-label={mobilePanel === 'palette' ? t('app.tabColours') : t('app.tabActivity')}
        >
          <div className="modal-head">
            <h2>{mobilePanel === 'palette' ? t('app.tabColours') : t('app.tabActivity')}</h2>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => setMobilePanel(null)}
              aria-label={t('modal.close')}
              data-testid="sheet-close"
            >
              ×
            </button>
          </div>
          {mobilePanel === 'palette' ? (
            <Palette
              palette={socket.config?.palette ?? []}
              selected={selectedColor}
              onSelect={(index) => {
                setSelectedColor(index);
                setMobilePanel(null);
              }}
              cooldownReady={cooldownReady}
            />
          ) : (
            <ActivityFeed
              history={socket.history}
              palette={socket.config?.palette ?? []}
              onJump={(x, y) => {
                jumpTo(x, y);
                setMobilePanel(null);
              }}
              players={socket.players}
              handle={socket.session?.handle ?? ''}
            />
          )}
        </div>
      )}

      <footer className="app-footer">
        <span>
          Pixel Commons · {t('app.footerLicence')} ·{' '}
          {isStaticBuild ? t('app.footerStatic') : t('app.footerWorker')} · {t('app.footerBuiltBy')}{' '}
          <a href="https://x.com/0xkillcoin" target="_blank" rel="noreferrer noopener">
            @0xkillcoin
          </a>
        </span>
      </footer>

      {showHelp && <HelpDialog cooldownSeconds={cooldownMs / 1000} onClose={() => setShowHelp(false)} />}
      {showHistory && (
        <HistoryDialog snapshots={snapshots} onClose={() => setShowHistory(false)} onJump={jumpTo} config={socket.config} />
      )}
      {showAdmin && (
        <AdminConsole
          isAdmin={socket.session?.isAdmin ?? false}
          onClose={() => setShowAdmin(false)}
          onNotice={pushToast}
          onRefresh={() => {
            socket.retryNow();
            void socket.requestHistory();
          }}
        />
      )}
      {reportCell && (
        <ReportDialog
          cell={reportCell}
          onClose={() => setReportCell(null)}
          onSubmit={(reason, note) => {
            socket.report(reportCell.x, reportCell.y, reason, note);
            setReportCell(null);
            pushToast(t('app.reportSent'), 'ok');
          }}
        />
      )}

      <ToastStack toasts={toasts} onDismiss={(id) => setToasts((prev) => prev.filter((x) => x.id !== id))} />
    </div>
  );
}

/* helpers kept local: the canvas module owns the canonical decoding path */
export const __test__ = { readShareTarget, unpackRle, base64UrlToBytes };
