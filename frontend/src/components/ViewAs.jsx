import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import api, { ACT_MODE_KEY, VIEW_AS_KEY, actAsMode, viewAsToken } from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { workRoleLabel } from '../permissions';
import './ViewAs.css';

// ---------------------------------------------------------------------------
// SUPER ADMIN "VIEW AS" (read-only) AND "ACT AS" (real changes)
// (backend: utils/viewAs.js, utils/actAs.js, routes/viewAs.js).
//
// The token lives in THIS TAB's sessionStorage only (api.js reads it ahead of
// the normal localStorage token), so the Super Admin's other tabs stay the
// Super Admin. Tokens never go into a URL. View as and Act as share the slot;
// ACT_MODE_KEY says which one it is.
// ---------------------------------------------------------------------------

const RETURN_KEY = 'tl_viewas_return';
export const NOTICE_KEY = 'tl_viewas_notice';

export function isViewingAs() { return !!viewAsToken(); }
export function isActingAs() { return actAsMode(); }

function keepToken(token, mode) {
  try {
    sessionStorage.setItem(VIEW_AS_KEY, token);
    sessionStorage.setItem(ACT_MODE_KEY, mode);
  } catch {
    throw new Error('This browser blocks tab storage, so View as cannot start here.');
  }
}

// Start: ask the server for a read-only token for the target, keep it in this
// tab, and reload to "/" — the target's own landing page.
export async function startViewAs(userId) {
  const res = await api.post(`/admin/view-as/${encodeURIComponent(userId)}`);
  try { sessionStorage.setItem(RETURN_KEY, window.location.pathname + window.location.search); } catch { /* no storage */ }
  keepToken(res.data.token, 'view');
  window.location.assign('/');
}

// Act as straight from the picker (after the person confirmed).
export async function startActAs(userId) {
  const res = await api.post(`/admin/view-as/${encodeURIComponent(userId)}/act`);
  try { sessionStorage.setItem(RETURN_KEY, window.location.pathname + window.location.search); } catch { /* no storage */ }
  keepToken(res.data.token, 'act');
  window.location.assign('/');
}

// From the View-as banner: the same person, now with real changes. Stays on this screen.
export async function switchToActAs() {
  const res = await api.post('/admin/view-as/switch-to-act');
  keepToken(res.data.token, 'act');
  window.location.reload();
}

// From the Act-as banner: back to the read-only view of the same person.
export async function backToReadOnly() {
  const res = await api.post('/admin/view-as/back-to-read-only');
  keepToken(res.data.token, 'view');
  window.location.reload();
}

// Exit: tell the server (audit row), drop this tab's token, reload as the
// Super Admin — back on the screen View as / Act as was started from.
export async function exitViewAs(notice) {
  const acting = actAsMode();
  try { await api.post(acting ? '/admin/view-as/act-exit' : '/admin/view-as/exit'); } catch { /* the token may already have expired */ }
  let back = '/admin/view-as';
  try {
    back = sessionStorage.getItem(RETURN_KEY) || back;
    sessionStorage.removeItem(VIEW_AS_KEY);
    sessionStorage.removeItem(ACT_MODE_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    if (notice) sessionStorage.setItem(NOTICE_KEY, notice);
  } catch { /* nothing stored */ }
  window.location.assign(back);
}

// The plain-words question before Act as starts (banner switch and picker button).
export function ActAsConfirm({ name, byName, busy, error, onYes, onNo }) {
  return (
    <div className="tl-actas-back" role="presentation" onClick={busy ? undefined : onNo}>
      <div className="tl-actas-dialog" role="alertdialog" aria-modal="true" aria-labelledby="tl-actas-h" onClick={(e) => e.stopPropagation()}>
        <h2 id="tl-actas-h">Act as {name}?</h2>
        <p>
          You will make <b>real changes</b> as <b>{name}</b>. Every change is recorded as done by{' '}
          <b>{byName || 'you'}</b> acting as <b>{name}</b>.
        </p>
        <p>Passwords, roles and security settings stay blocked. Anything that sends a message to a real person asks you first.</p>
        {error && <div className="tl-actas-err" role="alert">{error}</div>}
        <div className="tl-actas-btns">
          <button type="button" className="tl-actas-no" onClick={onNo} disabled={busy}>Cancel</button>
          <button type="button" className="tl-actas-yes" onClick={onYes} disabled={busy}>{busy ? 'Opening…' : `Yes, act as ${name}`}</button>
        </div>
      </div>
    </div>
  );
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

// The separate "Act as (edit)" button next to View as (picker rows).
export function ActAsButton({ userId, name, active = true, superAdmin = false, admin = false, className = 'btn btn-sm tl-actas-open' }) {
  const { user } = useAuth();
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!user || user.role !== 'SUPER_ADMIN' || user.viewAs) return null;
  if (!userId || !active || superAdmin || admin || userId === user.id) return null;
  async function go() {
    setBusy(true); setError('');
    try {
      await startActAs(userId);
    } catch (err) {
      setBusy(false);
      setError(err?.response?.data?.error || err.message || 'Could not start Act as.');
    }
  }
  return (
    <>
      <button type="button" className={className} onClick={() => setAsk(true)}
        title={`Use the app as ${name || 'this person'} with their real edit rights`}>
        ✎ Act as (edit)
      </button>
      {ask && <ActAsConfirm name={name} byName={user.name} busy={busy} error={error} onYes={go} onNo={() => { setAsk(false); setError(''); }} />}
    </>
  );
}

function minutesLeft(expiresAt) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 60000)) : null;
}

// The fixed banner on every page while viewing / acting as, plus the toast that
// shows the server's refusal whenever a blocked write is attempted, plus the
// "This will really send" question.
export function ViewAsBanner() {
  const { user } = useAuth();
  const ref = useRef(null);
  const [left, setLeft] = useState(null);
  const [toast, setToast] = useState('');
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [send, setSend] = useState(null);
  const viewing = !!(user && user.viewAs && isViewingAs());
  const acting = viewing && user.viewAs.mode === 'act';

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
  }, [viewing, acting]);

  useEffect(() => {
    if (!viewing) return undefined;
    const tick = () => {
      const m = minutesLeft(user.viewAs.expiresAt);
      setLeft(m);
      if (m === 0) exitViewAs(`${acting ? 'Act as' : 'View as'} ended — the 60-minute session expired.`);
    };
    tick();
    const t = setInterval(tick, 20000);
    return () => clearInterval(t);
  }, [viewing, acting, user]);

  useEffect(() => {
    let timer = null;
    const on = (e) => {
      setToast(e.detail || 'Read-only while viewing as.');
      clearTimeout(timer);
      timer = setTimeout(() => setToast(''), 6000);
    };
    window.addEventListener('tl:viewas-blocked', on);
    return () => { window.removeEventListener('tl:viewas-blocked', on); clearTimeout(timer); };
  }, []);

  // api.js asks here before a call that really reaches a person.
  useEffect(() => {
    const on = (e) => setSend(e.detail);
    window.addEventListener('tl:actas-confirm', on);
    return () => window.removeEventListener('tl:actas-confirm', on);
  }, []);
  const answer = (yes) => { if (send) send.resolve(yes); setSend(null); };

  async function doSwitch() {
    setBusy(true); setError('');
    try { await switchToActAs(); } catch (err) {
      setBusy(false);
      setError(err?.response?.data?.error || err.message || 'Could not switch to Act as.');
    }
  }
  async function doBack() {
    setBusy(true);
    try { await backToReadOnly(); } catch (err) {
      setBusy(false);
      setToast(err?.response?.data?.error || err.message || 'Could not go back to read-only.');
    }
  }

  if (!viewing) return send ? <SendAsk text={send.text} onAnswer={answer} /> : null;
  const scope = (user.scope && (user.scope.atsLabel || user.scope.label)) || '';
  const canSwitch = !acting && user.role !== 'ADMIN' && !['CLIENT', 'CANDIDATE'].includes(user.role);
  return (
    <>
      <div className={'tl-viewas-banner' + (acting ? ' is-act' : '')} ref={ref} role="status" aria-live="polite">
        <span className="tl-viewas-text">
          {acting ? (
            <>
              <span aria-hidden="true">⚠</span>{' '}
              <b>ACTING AS {user.name}</b>
              <span className="tl-viewas-sep"> · </span>{workRoleLabel(user)}
              <span className="tl-viewas-sep"> · </span><b>changes are real</b>
              {left != null && <span className="tl-viewas-left"> · {left} min left</span>}
            </>
          ) : (
            <>
              <span aria-hidden="true">👁</span>{' '}
              Viewing as <b>{user.name}</b>
              <span className="tl-viewas-sep"> · </span>{workRoleLabel(user)}
              {scope && <><span className="tl-viewas-sep"> · </span>{scope}</>}
              <span className="tl-viewas-sep"> — </span><b>read-only</b>
              {left != null && <span className="tl-viewas-left"> · {left} min left</span>}
            </>
          )}
        </span>
        <span className="tl-viewas-actions">
          {canSwitch && <button type="button" className="tl-viewas-switch" onClick={() => setAsk(true)}>Switch to Act as (edit)</button>}
          {acting && <button type="button" className="tl-viewas-switch" onClick={doBack} disabled={busy}>Back to read-only view</button>}
          <button type="button" className="tl-viewas-exit" onClick={() => exitViewAs()}>{acting ? 'Exit Act as' : 'Exit View as'}</button>
        </span>
      </div>
      {toast && <div className="tl-viewas-toast" role="alert">{toast}</div>}
      {ask && <ActAsConfirm name={user.name} byName={user.viewAs.byName} busy={busy} error={error} onYes={doSwitch} onNo={() => { setAsk(false); setError(''); }} />}
      {send && <SendAsk text={send.text} onAnswer={answer} />}
    </>
  );
}

// "This will really send to a real person" — once per send.
function SendAsk({ text, onAnswer }) {
  return (
    <div className="tl-actas-back" role="presentation">
      <div className="tl-actas-dialog" role="alertdialog" aria-modal="true" aria-labelledby="tl-actas-send-h">
        <h2 id="tl-actas-send-h">This will really send</h2>
        <p>{text}</p>
        <div className="tl-actas-btns">
          <button type="button" className="tl-actas-no" onClick={() => onAnswer(false)}>No, do not send</button>
          <button type="button" className="tl-actas-yes" onClick={() => onAnswer(true)}>Yes, send it</button>
        </div>
      </div>
    </div>
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
