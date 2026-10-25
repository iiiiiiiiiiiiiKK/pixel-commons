import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { Modal } from './Panels';

type AdminView = Awaited<ReturnType<typeof api.adminView>>;

/**
 * Admin console. Every action here is re-verified server-side: the UI merely
 * hides controls, it never grants authority. Buttons show real server results
 * and surface failures instead of pretending success.
 */
export default function AdminConsole({
  isAdmin,
  onClose,
  onNotice,
  onRefresh,
}: {
  isAdmin: boolean;
  onClose: () => void;
  onNotice: (message: string, kind: 'ok' | 'error' | 'info') => void;
  onRefresh: () => void;
}) {
  const [token, setToken] = useState('');
  const [view, setView] = useState<AdminView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noticeText, setNoticeText] = useState('');
  const [noticeLevel, setNoticeLevel] = useState<'info' | 'warn' | 'maintenance'>('info');
  const [confirmReset, setConfirmReset] = useState('');

  const loadView = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setView(await api.adminView());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the admin view.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) void loadView();
  }, [isAdmin, loadView]);

  const login = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.adminLogin(token.trim());
      setToken('');
      await loadView();
      onNotice('Admin signed in.', 'ok');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  const run = async (body: Record<string, unknown>, success: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.adminAction(body);
      onNotice(result.message || success, result.ok ? 'ok' : 'error');
      await loadView();
      onRefresh();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Action failed.';
      setError(message);
      onNotice(message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!isAdmin) {
    return (
      <Modal title="Admin sign-in" onClose={onClose}>
        <p className="fineprint">
          Admins can reset the canvas, publish maintenance notices, undo the last pixel and open the reports queue.
          The token is verified on the server and exchanged for a short-lived signed cookie.
        </p>
        <label className="field">
          <span>Admin token</span>
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void login();
            }}
            placeholder="ADMIN_TOKEN"
            autoComplete="current-password"
            data-testid="admin-token"
          />
        </label>
        {error && <p className="error-text" data-testid="admin-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="ghost-btn" onClick={onClose}>
            cancel
          </button>
          <button type="button" className="primary-btn" disabled={busy || !token} onClick={() => void login()} data-testid="admin-login">
            {busy ? 'checking…' : 'sign in'}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Admin console" onClose={onClose} wide>
      {error && <p className="error-text" data-testid="admin-error">{error}</p>}

      <div className="admin-grid">
        <section>
          <h3 className="sub-head">Broadcast notice</h3>
          <label className="field">
            <span>Level</span>
            <select value={noticeLevel} onChange={(event) => setNoticeLevel(event.target.value as typeof noticeLevel)}>
              <option value="info">info</option>
              <option value="warn">warn</option>
              <option value="maintenance">maintenance (blocks painting)</option>
            </select>
          </label>
          <label className="field">
            <span>Message</span>
            <textarea
              rows={2}
              maxLength={280}
              value={noticeText}
              onChange={(event) => setNoticeText(event.target.value)}
              placeholder="Theme day: build a tiny garden in the bottom-left quadrant"
              data-testid="notice-text"
            />
          </label>
          <div className="row gap">
            <button
              type="button"
              className="primary-btn"
              disabled={busy || noticeText.trim().length === 0}
              onClick={() => void run({ action: 'notice', value: noticeText, status: noticeLevel }, 'Notice published.')}
              data-testid="publish-notice"
            >
              publish
            </button>
            <button
              type="button"
              className="ghost-btn"
              disabled={busy}
              onClick={() => void run({ action: 'clearNotice' }, 'Notice cleared.')}
              data-testid="clear-notice"
            >
              clear
            </button>
          </div>

          <h3 className="sub-head">Canvas</h3>
          <div className="row gap wrap">
            <button
              type="button"
              className="ghost-btn"
              disabled={busy}
              onClick={() => void run({ action: 'undo' }, 'Undone.')}
              data-testid="admin-undo"
            >
              undo last pixel
            </button>
            <a className="ghost-btn" href="/api/export.png?scale=4" target="_blank" rel="noreferrer">
              export PNG
            </a>
          </div>
          <label className="field">
            <span>Type RESET to clear the whole canvas</span>
            <input value={confirmReset} onChange={(event) => setConfirmReset(event.target.value)} placeholder="RESET" />
          </label>
          <button
            type="button"
            className="danger-btn"
            disabled={busy || confirmReset !== 'RESET'}
            onClick={() => {
              void run({ action: 'reset' }, 'Canvas reset.');
              setConfirmReset('');
            }}
            data-testid="admin-reset"
          >
            reset canvas
          </button>
        </section>

        <section>
          <h3 className="sub-head">Reports {view ? `(${view.reports.filter((r) => r.status === 'open').length} open)` : ''}</h3>
          {!view ? (
            <p className="fineprint">loading…</p>
          ) : view.reports.length === 0 ? (
            <p className="fineprint">No reports yet.</p>
          ) : (
            <ul className="report-list" data-testid="report-list">
              {view.reports.slice(0, 12).map((report) => (
                <li key={report.id} className={report.status}>
                  <div>
                    <strong className="mono">
                      ({report.x},{report.y})
                    </strong>{' '}
                    <span className={`chip ${report.status}`}>{report.status}</span>
                    <small>
                      {report.reason} · {new Date(report.at).toLocaleString()}
                      {report.note ? ` · ${report.note}` : ''}
                    </small>
                  </div>
                  {report.status === 'open' && (
                    <div className="row gap">
                      <button
                        type="button"
                        className="ghost-btn small"
                        disabled={busy}
                        onClick={() => void run({ action: 'resolveReport', id: report.id, status: 'resolved' }, 'Resolved.')}
                      >
                        resolve
                      </button>
                      <button
                        type="button"
                        className="ghost-btn small"
                        disabled={busy}
                        onClick={() => void run({ action: 'resolveReport', id: report.id, status: 'rejected' }, 'Rejected.')}
                      >
                        reject
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3 className="sub-head">Audit trail</h3>
          {!view ? (
            <p className="fineprint">loading…</p>
          ) : view.audit.length === 0 ? (
            <p className="fineprint">No admin actions recorded yet.</p>
          ) : (
            <ul className="audit-list" data-testid="audit-list">
              {view.audit.map((entry) => (
                <li key={entry.id}>
                  <span className="mono">{entry.action}</span> {entry.detail}
                  <small>{new Date(entry.at).toLocaleString()}</small>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}
