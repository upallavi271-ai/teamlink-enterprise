import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import api, { VIEW_AS_KEY, viewAsToken } from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { workRoleLabel } from '../permissions';
import './ViewAs.css';

// ---------------------------------------------------------------------------
// SUPER ADMIN "VIEW AS" — READ-ONLY (backend: utils/viewAs.js,
// routes/viewAs.js).
//
// The View-as token lives in THIS TAB's sessionStorage only (api.js reads it
// ahead of the normal localStorage token), so the Super Admin's other tabs
// stay the Super Admin. Tokens never go into a URL.
// ---------------------------------------------------------------------------

const RETURN_KEY = 'tl_viewas_return';
export const NOTICE_KEY = 'tl_viewas_notice';

export function isViewingAs() { return !!viewAsToken(); }

// Start: ask the server for a read-only token for the target, keep it in this
// tab, and reload to "/" — the target's own landing page.
export async function startViewAs(userId) {
  const res = await api.post(`/admin/view-as/${encodeURIComponent(userId)}`);
  try {
    sessionStorage.setItem(RETURN_KEY, window.location.pathname + window.location.search);
    sessionStorage.setItem(VIEW_AS_KEY, res.data.token);
  } catch {
    throw new Error('This browser blocks tab storage, so View as cannot start here.');
  }
  window.location.assign('/');
}

// Exit: tell the server (audit row), drop this tab's token, reload as the
// Super Admin — back on the screen View as was started from.
export async function exitViewAs(notice) {
  try { await api.post('/admin/view-as/exit'); } catch { /* the token may already have expired */ }
  let back = '/admin/view-as';
  try {
    back = sessionStorage.getItem(RETURN_KEY) || back;
    sessionStorage.removeItem(VIEW_AS_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    if (notice) sessionStorage.setItem(NOTICE_KEY, notice);
  } catch { /* nothing stored */ }
  window.location.assign(back);
}

// The row action on Users / Employee Management. Renders nothing unless the
// signed-in login is a Super Admin (not while already viewing as), the row has
// an active login, and that login is not a Super Admin.
export function ViewAsButton({ userId, name, active = true, superAdmin = false, className = 'btn btn-sm' }) {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  if (!user || user.role !== 'SUPER_ADMIN' || user.viewAs) return null;
  if (!userId || !active || superAdmin || userId === user.id) return null;
  async function go() {
    setBusy(true);
    try {
      await startViewAs(userId);
    } catch (err) {
      setBusy(false);
      // eslint-disable-next-line no-alert
      window.alert(err?.response?.data?.error || err.message || 'Could not start View as.');
    }
  }
  return (
    <button type="button" className={className} onClick={go} disabled={busy}
      title={`See the app exactly as ${name || 'this person'} sees it — read-only`}>
      {busy ? 'Opening…' : '👁 View as'}
    </button>
  );
}

function minutesLeft(expiresAt) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 60000)) : null;
}

// The fixed banner on every page while viewing as, plus the toast that shows
// the server's read-only refusal whenever a write is attempted.
export function ViewAsBanner() {
  const { user } = useAuth();
  const ref = useRef(null);
  const [left, setLeft] = useState(null);
  const [toast, setToast] = useState('');
  const viewing = !!(user && user.viewAs && isViewingAs());

  // Room for the banner: its real height (it wraps on a phone) as a CSS var.
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!viewing || !ref.current) {
      root.classList.remove('tl-viewas-on');
      root.style.removeProperty('--tl-viewas-h');
      return undefined;
    }
    root.classList.add('tl-viewas-on');
    const set = () => root.style.setProperty('--tl-viewas-h', `${ref.current ? ref.current.offsetHeight : 0}px`);
    set();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(set) : null;
    if (ro) ro.observe(ref.current);
    window.addEventListener('resize', set);
    return () => { if (ro) ro.disconnect(); window.removeEventListener('resize', set); };
  }, [viewing]);

  useEffect(() => {
    if (!viewing) return undefined;
    const tick = () => {
      const m = minutesLeft(user.viewAs.expiresAt);
      setLeft(m);
      if (m === 0) exitViewAs('View as ended — the 60-minute session expired.');
    };
    tick();
    const t = setInterval(tick, 20000);
    return () => clearInterval(t);
  }, [viewing, user]);

  useEffect(() => {
    let timer = null;
    const on = (e) => {
      setToast(e.detail || 'Read-only while viewing as.');
      clearTimeout(timer);
      timer = setTimeout(() => setToast(''), 4500);
    };
    window.addEventListener('tl:viewas-blocked', on);
    return () => { window.removeEventListener('tl:viewas-blocked', on); clearTimeout(timer); };
  }, []);

  if (!viewing) return null;
  const scope = (user.scope && (user.scope.atsLabel || user.scope.label)) || '';
  return (
    <>
      <div className="tl-viewas-banner" ref={ref} role="status" aria-live="polite">
        <span className="tl-viewas-text">
          <span aria-hidden="true">👁</span>{' '}
          Viewing as <b>{user.name}</b>
          <span className="tl-viewas-sep"> · </span>{workRoleLabel(user)}
          {scope && <><span className="tl-viewas-sep"> · </span>{scope}</>}
          <span className="tl-viewas-sep"> — </span><b>read-only</b>
          {left != null && <span className="tl-viewas-left"> · {left} min left</span>}
        </span>
        <button type="button" className="tl-viewas-exit" onClick={() => exitViewAs()}>Exit View as</button>
      </div>
      {toast && <div className="tl-viewas-toast" role="alert">{toast}</div>}
    </>
  );
}

// A one-off line on the Super Admin's screen after View as ended on its own.
export function ViewAsNotice() {
  const [text, setText] = useState('');
  useEffect(() => {
    try {
      const t = sessionStorage.getItem(NOTICE_KEY);
      if (t) { setText(t); sessionStorage.removeItem(NOTICE_KEY); }
    } catch { /* no storage */ }
  }, []);
  if (!text) return null;
  return (
    <div className="tl-viewas-toast tl-viewas-toast-info" role="status" onClick={() => setText('')}>{text}</div>
  );
}
