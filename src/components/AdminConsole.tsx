import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useT } from '../lib/i18n';
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
  const { t, locale } = useT();
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
      setError(err instanceof ApiError ? err.message : t('admin.loadFailed'));
    } finally {
      setBusy(false);
    }
  }, [t]);

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
      onNotice(t('admin.signedIn'), 'ok');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('admin.signInFailed'));
    } finally {
      setBusy(false);
    }
  };

  const run = async (body: Record<string, unknown>, success: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.adminAction(body);
      // The server's message is the source of truth; it is English-only today, so a
      // successful action shows the localised confirmation instead when they differ.
      onNotice(result.ok ? success : result.message, result.ok ? 'ok' : 'error');
      await loadView();
      onRefresh();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : t('admin.actionFailed');
      setError(message);
      onNotice(message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!isAdmin) {
    return (
      <Modal title={t('admin.signInTitle')} onClose={onClose}>
        <p className="fineprint">{t('admin.signInIntro')}</p>
        <label className="field">
          <span>{t('admin.tokenLabel')}</span>
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
        {error && (
          <p className="error-text" data-testid="admin-error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="ghost-btn" onClick={onClose}>
            {t('admin.cancel')}
          </button>
          <button
            type="button"
            className="primary-btn"
            disabled={busy || !token}
            onClick={() => void login()}
            data-testid="admin-login"
          >
            {busy ? t('admin.checking') : t('admin.signIn')}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={t('admin.title')} onClose={onClose} wide>
      {error && (
        <p className="error-text" data-testid="admin-error">
          {error}
        </p>
      )}

      <div className="admin-grid">
        <section>
          <h3 className="sub-head">{t('admin.broadcast')}</h3>
          <label className="field">
            <span>{t('admin.level')}</span>
            <select value={noticeLevel} onChange={(event) => setNoticeLevel(event.target.value as typeof noticeLevel)}>
              <option value="info">{t('admin.levelInfo')}</option>
              <option value="warn">{t('admin.levelWarn')}</option>
              <option value="maintenance">{t('admin.levelMaintenance')}</option>
            </select>
          </label>
          <label className="field">
            <span>{t('admin.message')}</span>
            <textarea
              rows={2}
              maxLength={280}
              value={noticeText}
              onChange={(event) => setNoticeText(event.target.value)}
              placeholder={t('admin.messagePlaceholder')}
              data-testid="notice-text"
            />
          </label>
          <div className="row gap">
            <button
              type="button"
              className="primary-btn"
              disabled={busy || noticeText.trim().length === 0}
              onClick={() =>
                void run({ action: 'notice', value: noticeText, status: noticeLevel }, t('admin.publishDone'))
              }
              data-testid="publish-notice"
            >
              {t('admin.publish')}
            </button>
            <button
              type="button"
              className="ghost-btn"
              disabled={busy}
              onClick={() => void run({ action: 'clearNotice' }, t('admin.clearDone'))}
              data-testid="clear-notice"
            >
              {t('admin.clear')}
            </button>
          </div>

          <h3 className="sub-head">{t('admin.canvas')}</h3>
          <div className="row gap wrap">
            <button
              type="button"
              className="ghost-btn"
              disabled={busy}
              onClick={() => void run({ action: 'undo' }, t('admin.undoDone'))}
              data-testid="admin-undo"
            >
              {t('admin.undo')}
            </button>
            <a className="ghost-btn" href="/api/export.png?scale=4" target="_blank" rel="noreferrer">
              {t('admin.exportPng')}
            </a>
          </div>
          <label className="field">
            <span>{t('admin.resetLabel')}</span>
            <input value={confirmReset} onChange={(event) => setConfirmReset(event.target.value)} placeholder="RESET" />
          </label>
          <button
            type="button"
            className="danger-btn"
            disabled={busy || confirmReset !== 'RESET'}
            onClick={() => {
              void run({ action: 'reset' }, t('admin.resetDone'));
              setConfirmReset('');
            }}
            data-testid="admin-reset"
          >
            {t('admin.reset')}
          </button>
        </section>

        <section>
          <h3 className="sub-head">
            {t('admin.reports')}{' '}
            {view ? t('admin.openCount', { count: view.reports.filter((r) => r.status === 'open').length }) : ''}
          </h3>
          {!view ? (
            <p className="fineprint">{t('admin.loading')}</p>
          ) : view.reports.length === 0 ? (
            <p className="fineprint">{t('admin.noReports')}</p>
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
                      {report.reason} · {new Date(report.at).toLocaleString(locale)}
                      {report.note ? ` · ${report.note}` : ''}
                    </small>
                  </div>
                  {report.status === 'open' && (
                    <div className="row gap">
                      <button
                        type="button"
                        className="ghost-btn small"
                        disabled={busy}
                        onClick={() =>
                          void run({ action: 'resolveReport', id: report.id, status: 'resolved' }, t('admin.resolve'))
                        }
                      >
                        {t('admin.resolve')}
                      </button>
                      <button
                        type="button"
                        className="ghost-btn small"
                        disabled={busy}
                        onClick={() =>
                          void run({ action: 'resolveReport', id: report.id, status: 'rejected' }, t('admin.reject'))
                        }
                      >
                        {t('admin.reject')}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3 className="sub-head">{t('admin.audit')}</h3>
          {!view ? (
            <p className="fineprint">{t('admin.loading')}</p>
          ) : view.audit.length === 0 ? (
            <p className="fineprint">{t('admin.noAudit')}</p>
          ) : (
            <ul className="audit-list" data-testid="audit-list">
              {view.audit.map((entry) => (
                <li key={entry.id}>
                  <span className="mono">{entry.action}</span> {entry.detail}
                  <small>{new Date(entry.at).toLocaleString(locale)}</small>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}
