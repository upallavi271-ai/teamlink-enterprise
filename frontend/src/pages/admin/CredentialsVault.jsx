import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import MultiPick from '../../components/MultiPick.jsx';
import './CredentialsVault.css';

// ---------------------------------------------------------------------------
// ADMINISTRATION -> COMPANY SETUP -> CREDENTIALS VAULT (founder 2026-11-21): every company login (Naukri, Shine, HRMS, Hostinger,
// Gmail, bank / GST portals, anything) in one place. A tab of Company Setup (nav.js SETUP_TABS), never a sidebar module.
// Passwords are encrypted on the server and never come with the list: Show / Copy asks for the viewer's OWN TeamLink password
// (valid 5 minutes), then shows the value for 30 seconds or copies it. Server: routes/credentialVault.js.
// ---------------------------------------------------------------------------
const errText = (e, f = 'That did not work. Try again.') => (e?.response ? e.response.data?.error || f : 'Cannot reach the server. Try again.');
const two = (n) => String(n).padStart(2, '0');
const when = (s) => { if (!s) return ''; const d = new Date(s); return `${two(d.getDate())}-${two(d.getMonth() + 1)}-${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`; };
const day = (s) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? `${s.slice(8, 10)}-${s.slice(5, 7)}-${s.slice(0, 4)}` : '');
const safeHref = (u) => (/^https?:\/\//i.test(u || '') ? u : null);

function saveBlob(res, fallback) {
  const cd = res.headers?.['content-disposition'] || '';
  const m = /filename="?([^";]+)"?/.exec(cd);
  const name = (m && m[1]) || fallback;
  const href = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = href; a.download = name; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(href), 2000);
  return name;
}
async function blobError(err) {
  const data = err?.response?.data;
  if (data instanceof Blob) { try { return JSON.parse(await data.text()); } catch { return {}; } }
  return data || {};
}

// a strong password, made in the browser (never sent anywhere until the form is saved)
const PICK_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const PICK_SYMBOLS = '!@#$%^&*-_=+?';
function makePassword(len = 16, symbols = true) {
  const pool = PICK_LETTERS + (symbols ? PICK_SYMBOLS : '');
  const buf = new Uint32Array(len);
  window.crypto.getRandomValues(buf);
  const out = Array.from(buf, (n) => pool[n % pool.length]);
  const need = [/[A-Z]/, /[a-z]/, /\d/, ...(symbols ? [/[!@#$%^&*\-_=+?]/] : [])];
  const fill = ['K', 'k', '7', '#'];
  need.forEach((re, i) => { if (!re.test(out.join(''))) out[i] = fill[i]; });
  return out.join('');
}

const TABS = [
  { key: 'list', label: 'All logins' },
  { key: 'expiring', label: 'Expiring / rotate soon' },
  { key: 'import', label: 'Import from Excel', need: 'import' },
  { key: 'log', label: 'Who opened what', need: 'view' },
  { key: 'access', label: 'Access', need: 'settings' },
];

export default function CredentialsVault() {
  const [params, setParams] = useSearchParams();
  const [me, setMe] = useState(null);
  const [error, setError] = useState('');
  const [reauth, setReauth] = useState(null); // { token, expiresAt }
  const [asking, setAsking] = useState(null); // { resolve, reject }
  const reauthRef = useRef(null);
  reauthRef.current = reauth;

  useEffect(() => {
    api.get('/credentials-vault/me').then((r) => setMe(r.data)).catch((e) => setError(errText(e, 'The vault could not be opened.')));
  }, []);

  // Runs fn(token) with a fresh password check: asks for the password when there is no valid ticket.
  const withReauth = useCallback(async (fn) => {
    const cur = reauthRef.current;
    const valid = cur && Date.parse(cur.expiresAt) - Date.now() > 5000;
    const token = valid ? cur.token : await new Promise((resolve, reject) => setAsking({ resolve, reject }));
    try {
      return await fn(token);
    } catch (e) {
      if (e?.response?.data?.code === 'REAUTH_NEEDED' || e?.response?.data?.code === 'VAULT_LOCKED') setReauth(null);
      throw e;
    }
  }, []);

  if (error) return <div className="card cv-page"><div className="notice red">{error}</div></div>;
  if (!me) return <div className="card cv-page small-muted">Loading…</div>;
  if (!me.open) {
    return (
      <div className="card cv-page">
        <h2 className="cv-h2">Credentials vault</h2>
        <div className="notice">The credentials vault is not part of your access. The Super Admin can grant it.</div>
      </div>
    );
  }
  const rights = me.rights || {};
  const tabs = TABS.filter((t) => !t.need || rights[t.need]);
  const tab = tabs.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'list';
  const setTab = (k) => { const p = new URLSearchParams(params); p.set('tab', k); setParams(p, { replace: true }); };

  return (
    <div className="card cv-page">
      <div className="cv-title">
        <h2 className="cv-h2">Credentials vault</h2>
        <span className="small-muted">{me.ownOnly ? 'The logins assigned to you.' : 'Every company login in one place. Passwords are encrypted and hidden; Show and Copy ask for your own TeamLink password.'}</span>
      </div>
      {!me.keyConfigured && <div className="notice amber">{me.keyMessage} Until then no password can be saved, shown or imported.</div>}
      {!me.ownOnly && (
        <div className="tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`tab tab-btn${tab === t.key ? ' active' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </div>
      )}
      {(tab === 'list' || tab === 'expiring' || me.ownOnly) && <VaultList me={me} rights={rights} expiringOnly={tab === 'expiring' && !me.ownOnly} withReauth={withReauth} />}
      {tab === 'import' && !me.ownOnly && <ImportPanel />}
      {tab === 'log' && !me.ownOnly && <AccessLog />}
      {tab === 'access' && !me.ownOnly && <AccessPanel />}
      {asking && (
        <ReauthModal
          me={me}
          onDone={(r) => { setReauth(r); const a = asking; setAsking(null); a.resolve(r.token); }}
          onCancel={() => { const a = asking; setAsking(null); a.reject(Object.assign(new Error('cancelled'), { cancelled: true })); }}
        />
      )}
    </div>
  );
}

// ---- password check ------------------------------------------------------------------------------------------------
function ReauthModal({ me, onDone, onCancel }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    if (!pw) { setErr('Type your password.'); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.post('/credentials-vault/reauth', { password: pw });
      setPw('');
      onDone(r.data);
    } catch (ex) { setErr(errText(ex)); setPw(''); } finally { setBusy(false); }
  };
  return (
    <Modal title="Confirm it is you" onClose={onCancel}>
      <form onSubmit={submit} autoComplete="off" className="cv-reauth">
        <p className="small-muted">Type your own TeamLink password. Showing and copying passwords then stays open for {me.reauthMinutes} minutes. After {me.lockAfter} wrong tries it is locked for {me.lockMinutes} minutes.</p>
        <label className="field"><span>Your TeamLink password</span>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <input type="password" name="cv-reauth" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="off" autoFocus data-testid="cv-reauth-input" />
        </label>
        {err && <div className="notice red" role="alert">{err}</div>}
        <div className="cv-row">
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Checking…' : 'Confirm'}</button>
          <button type="button" className="btn btn-sm" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

// ---- one secret: masked, Show (30 s) or Copy --------------------------------------------------------------------------
function SecretCell({ cred, field = 'password', withReauth, onMessage }) {
  const [shown, setShown] = useState(null);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState('');
  useEffect(() => {
    if (!shown) return undefined;
    const t = setInterval(() => setLeft((n) => { if (n <= 1) { setShown(null); return 0; } return n - 1; }), 1000);
    return () => clearInterval(t);
  }, [shown]);
  const has = field === 'extra' ? cred.hasExtra : cred.hasPassword;
  if (!has) return <span className="small-muted">{field === 'extra' ? '' : 'none saved'}</span>;
  const get = async (purpose) => {
    setBusy(purpose);
    try {
      const r = await withReauth((token) => api.post(`/credentials-vault/credentials/${cred.id}/reveal`, { field, purpose }, { headers: { 'X-Vault-Reauth': token } }));
      const v = r.data.value;
      const text = typeof v === 'string' ? v : Object.entries(v || {}).map(([k, val]) => `${({ recoveryCodes: '2FA recovery codes', pin: 'PIN', securityAnswers: 'Security answers', other: 'Other' })[k] || k}: ${val}`).join('\n');
      if (purpose === 'copy') {
        try {
          await navigator.clipboard.writeText(text);
          onMessage && onMessage({ ok: true, text: `Copied. Paste it now - the clipboard is cleared in ${r.data.seconds} seconds if it still holds it.` });
          setTimeout(async () => { try { if ((await navigator.clipboard.readText()) === text) await navigator.clipboard.writeText(''); } catch { /* no permission to read: leave it */ } }, r.data.seconds * 1000);
        } catch { onMessage && onMessage({ ok: false, text: 'This browser did not allow copying. Use Show instead.' }); }
      } else { setShown(text); setLeft(r.data.seconds); }
    } catch (e) {
      if (!e.cancelled) onMessage && onMessage({ ok: false, text: errText(e) });
    } finally { setBusy(''); }
  };
  return (
    <span className="cv-secret">
      {shown ? <code className="cv-plain" data-testid="cv-plain">{shown}</code> : <span className="cv-mask" aria-label="hidden">{field === 'extra' ? (cred.extraKinds || '••••') : '••••••••'}</span>}
      {shown ? <span className="small-muted">hides in {left}s</span> : null}
      {shown
        ? <button type="button" className="btn btn-sm" onClick={() => { setShown(null); setLeft(0); }}>Hide</button>
        : <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => get('show')}>{busy === 'show' ? '…' : 'Show'}</button>}
      <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => get('copy')}>{busy === 'copy' ? '…' : 'Copy'}</button>
    </span>
  );
}

// ---- the list ----------------------------------------------------------------------------------------------------------
const SORTS = [['platform', 'Platform'], ['label', 'Label'], ['username', 'Username'], ['renewal', 'Renewal date'], ['updated', 'Last changed']];
const STATUS_OPTS = [{ value: 'active', label: 'Active' }, { value: 'disabled', label: 'Disabled' }];

function VaultList({ me, rights, expiringOnly, withReauth }) {
  const [rows, setRows] = useState(null);
  const [opts, setOpts] = useState({ platforms: [], employees: [], departments: [] });
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState(null);
  const [f, setF] = useState({ q: '', platform: [], department: [], employee: [], status: [], expiring: false });
  const [sort, setSort] = useState('platform');
  const [picked, setPicked] = useState(new Set());
  const [edit, setEdit] = useState(null); // 'new' | row
  const [open, setOpen] = useState(null); // id
  const [bulk, setBulk] = useState(null); // 'assign' | 'delete'
  const [exporting, setExporting] = useState(null);

  const load = useCallback(() => {
    api.get('/credentials-vault/credentials').then((r) => { setRows(r.data.rows); setErr(''); }).catch((e) => setErr(errText(e, 'The list could not be loaded.')));
  }, []);
  useEffect(() => { load(); api.get('/credentials-vault/options').then((r) => setOpts(r.data)).catch(() => {}); }, [load]);
  useEffect(() => { setPicked(new Set()); }, [expiringOnly]);

  const shown = useMemo(() => {
    if (!rows) return [];
    const text = f.q.trim().toLowerCase();
    let list = rows.filter((r) => {
      if (expiringOnly && !(r.renewalState || r.rotateDue)) return false;
      if (f.platform.length && !f.platform.includes(r.platform)) return false;
      if (f.department.length && !f.department.includes(r.department || '(none)')) return false;
      if (f.employee.length && !r.assigned.some((a) => f.employee.includes(a.id)) && !(f.employee.includes('(none)') && !r.assigned.length)) return false;
      if (f.status.length && !f.status.includes(r.status)) return false;
      if (f.expiring && !(r.renewalState || r.rotateDue)) return false;
      if (text) {
        const hay = [r.platform, r.label, r.username, r.loginUrl, r.department, r.notes, r.owner && r.owner.name, ...r.assigned.map((a) => `${a.name} ${a.code}`)].join(' ').toLowerCase();
        if (!hay.includes(text)) return false;
      }
      return true;
    });
    const key = {
      platform: (r) => `${r.platform}|${r.label || r.username}`.toLowerCase(), label: (r) => (r.label || r.username).toLowerCase(), username: (r) => r.username.toLowerCase(),
      renewal: (r) => r.renewalDate || '9999', updated: (r) => r.updatedAt || '',
    }[sort];
    list = [...list].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    if (sort === 'updated') list.reverse();
    if (expiringOnly) list.sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));
    return list;
  }, [rows, f, sort, expiringOnly]);

  const platformOpts = useMemo(() => [...new Set([...(rows || []).map((r) => r.platform)])].sort().map((p) => ({ value: p, label: p })), [rows]);
  const deptOpts = useMemo(() => [...new Set([...(rows || []).map((r) => r.department || '(none)')])].sort().map((d) => ({ value: d, label: d === '(none)' ? 'No department' : d })), [rows]);
  const empOpts = useMemo(() => {
    const m = new Map();
    (rows || []).forEach((r) => r.assigned.forEach((a) => m.set(a.id, { value: a.id, label: a.name, sub: a.code })));
    return [{ value: '(none)', label: 'Nobody assigned' }, ...[...m.values()].sort((a, b) => a.label.localeCompare(b.label))];
  }, [rows]);
  const allEmpOpts = useMemo(() => opts.employees.map((e) => ({ value: e.id, label: e.name, sub: [e.code, e.department].filter(Boolean).join(' · ') })), [opts]);

  const togglePick = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allPicked = shown.length > 0 && shown.every((r) => picked.has(r.id));
  const pickAll = () => setPicked(allPicked ? new Set() : new Set(shown.map((r) => r.id)));
  const anyBulk = rights.assign || rights.edit || rights.delete;

  const runBulk = async (action, extra = {}) => {
    try {
      const r = await api.post('/credentials-vault/credentials/bulk', { ids: [...picked], action, ...extra });
      setMsg({ ok: true, text: `${r.data.done} login${r.data.done === 1 ? '' : 's'} ${({ assign: 'assigned', disable: 'disabled', enable: 'switched on', delete: 'deleted' })[action]}.` });
      setPicked(new Set()); setBulk(null); load();
    } catch (e) { setMsg({ ok: false, text: errText(e) }); }
  };

  const exportFile = async (withPasswords, confirmText) => {
    const filters = { ...f, expiring: f.expiring || expiringOnly };
    try {
      const call = (token) => api.post('/credentials-vault/export', { filters, withPasswords, confirmText }, { responseType: 'blob', headers: token ? { 'X-Vault-Reauth': token } : {} });
      const res = withPasswords ? await withReauth(call) : await call(null);
      const name = saveBlob(res, 'credentials.xlsx');
      setMsg({ ok: true, text: `Downloaded ${name} (${res.headers?.['x-export-rows'] || 0} logins).${withPasswords ? ' It holds passwords: keep it safe and delete it when done.' : ''}` });
      setExporting(null);
    } catch (e) {
      if (e.cancelled) return;
      const body = await blobError(e);
      setMsg({ ok: false, text: body.error || 'The export could not be made.' });
    }
  };

  return (
    <div className="cv-list">
      <div className="cv-toolbar">
        <input type="search" className="cv-search" placeholder="Search platform, username, employee, notes" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} autoComplete="off" aria-label="Search" />
        {!me.ownOnly && (
          <>
            <div className="cv-filter"><MultiPick id="cv-f-platform" options={platformOpts} value={f.platform} onChange={(v) => setF({ ...f, platform: v })} placeholder="Platform" /></div>
            <div className="cv-filter"><MultiPick id="cv-f-dept" options={deptOpts} value={f.department} onChange={(v) => setF({ ...f, department: v })} placeholder="Department" /></div>
            <div className="cv-filter"><MultiPick id="cv-f-emp" options={empOpts} value={f.employee} onChange={(v) => setF({ ...f, employee: v })} placeholder="Assigned employee" /></div>
            <div className="cv-filter"><MultiPick id="cv-f-status" options={STATUS_OPTS} value={f.status} onChange={(v) => setF({ ...f, status: v })} placeholder="Status" /></div>
            {!expiringOnly && <label className="cv-check"><input type="checkbox" checked={f.expiring} onChange={(e) => setF({ ...f, expiring: e.target.checked })} /> Expiring soon</label>}
          </>
        )}
        <label className="cv-sort">Sort <select value={sort} onChange={(e) => setSort(e.target.value)}>{SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <span className="cv-grow" />
        {rights.export && <button type="button" className="btn btn-sm" onClick={() => exportFile(false)}>Export (no passwords)</button>}
        {rights.export && rights.reveal && <button type="button" className="btn btn-sm" onClick={() => setExporting({ text: '' })}>Export with passwords…</button>}
        {rights.create && <button type="button" className="btn btn-sm btn-primary" onClick={() => setEdit('new')}>+ Add login</button>}
      </div>
      {expiringOnly && <p className="small-muted">Renewal date within {opts.expiringDays || 30} days or already past, and passwords not changed for {opts.rotateDays || 90} days or more.</p>}
      {msg && <div className={`notice ${msg.ok ? 'green' : 'red'}`} role="status">{msg.text} <button type="button" className="cv-x" aria-label="Dismiss" onClick={() => setMsg(null)}>×</button></div>}
      {err && <div className="notice red">{err}</div>}
      {picked.size > 0 && anyBulk && (
        <div className="cv-bulk" data-testid="cv-bulk">
          <b>{picked.size} ticked</b>
          {rights.assign && <button type="button" className="btn btn-sm" onClick={() => setBulk('assign')}>Assign to…</button>}
          {rights.edit && <button type="button" className="btn btn-sm" onClick={() => runBulk('disable')}>Disable</button>}
          {rights.edit && <button type="button" className="btn btn-sm" onClick={() => runBulk('enable')}>Switch on</button>}
          {rights.delete && <button type="button" className="btn btn-sm btn-danger" onClick={() => setBulk('delete')}>Delete…</button>}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPicked(new Set())}>Clear</button>
        </div>
      )}
      {!rows ? <div className="small-muted">Loading…</div> : (
        <div className="tbl-wrap">
          <table className="cv-table">
            <thead>
              <tr>
                {anyBulk && <th className="cv-c"><input type="checkbox" aria-label="Tick all" checked={allPicked} onChange={pickAll} /></th>}
                <th>Platform</th>
                <th>Username / Email</th>
                <th>Password</th>
                <th className="cv-hide-sm">Employee</th>
                <th className="cv-hide-sm">Department</th>
                <th className="cv-hide-sm">Renewal</th>
                <th>Status</th>
                <th aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={9} className="small-muted">{rows.length ? 'No login matches the filters.' : (me.ownOnly ? 'No login is assigned to you yet.' : 'No logins yet. Add one, or import your Excel sheet.')}</td></tr>}
              {shown.map((r) => (
                <tr key={r.id} className={r.status === 'disabled' ? 'cv-off' : ''} data-testid="cv-row">
                  {anyBulk && <td className="cv-c"><input type="checkbox" aria-label={`Tick ${r.platform} ${r.username}`} checked={picked.has(r.id)} onChange={() => togglePick(r.id)} /></td>}
                  <td><b>{r.platform}</b>{r.label && <div className="small-muted">{r.label}</div>}{safeHref(r.loginUrl) && <div><a href={safeHref(r.loginUrl)} target="_blank" rel="noopener noreferrer" className="cv-link">Open login page</a></div>}</td>
                  <td className="cv-user">{r.username}</td>
                  <td><SecretCell cred={r} withReauth={withReauth} onMessage={setMsg} /></td>
                  <td className="cv-hide-sm">{r.assigned.map((a) => a.name).join(', ') || <span className="small-muted">nobody</span>}</td>
                  <td className="cv-hide-sm">{r.department}</td>
                  <td className="cv-hide-sm">{r.renewalDate ? <span className={r.renewalState ? `cv-due ${r.renewalState}` : ''}>{day(r.renewalDate)}{r.renewalState === 'expired' ? ' (past)' : r.renewalState === 'soon' ? ` (${r.daysLeft}d)` : ''}</span> : ''}{r.rotateDue && <div className="cv-due soon">change password ({r.rotateDays}d old)</div>}</td>
                  <td>{r.status === 'disabled' ? <span className="chip">Disabled</span> : <span className="chip cv-on">Active</span>}</td>
                  <td><button type="button" className="btn btn-sm" onClick={() => setOpen(r.id)}>Details</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows && <div className="small-muted cv-count">{shown.length} of {rows.length} login{rows.length === 1 ? '' : 's'}</div>}
      {edit && <EditModal row={edit === 'new' ? null : edit} opts={opts} empOpts={allEmpOpts} rights={rights} onClose={() => setEdit(null)} onSaved={(t) => { setEdit(null); setMsg({ ok: true, text: t }); load(); }} />}
      {open && <DetailsDrawer id={open} rights={rights} withReauth={withReauth} onMessage={setMsg} onClose={() => setOpen(null)} onEdit={(row) => { setOpen(null); setEdit(row); }} onDeleted={() => { setOpen(null); setMsg({ ok: true, text: 'Login deleted.' }); load(); }} />}
      {bulk === 'assign' && <AssignModal count={picked.size} empOpts={allEmpOpts} onClose={() => setBulk(null)} onApply={(ids, mode) => runBulk('assign', { employeeIds: ids, mode })} />}
      {bulk === 'delete' && (
        <Modal title="Delete logins" onClose={() => setBulk(null)} footer={<><button type="button" className="btn btn-sm btn-danger" onClick={() => runBulk('delete', { confirm: true })}>Delete {picked.size}</button><button type="button" className="btn btn-sm" onClick={() => setBulk(null)}>Cancel</button></>}>
          <p>Delete {picked.size} login{picked.size === 1 ? '' : 's'} and their passwords from the vault? This cannot be undone. The history of who opened them stays.</p>
        </Modal>
      )}
      {exporting && (
        <Modal title="Export with passwords" onClose={() => setExporting(null)} footer={<><button type="button" className="btn btn-sm btn-danger" disabled={exporting.text.trim().toLowerCase() !== me.confirmWords.toLowerCase()} onClick={() => exportFile(true, exporting.text)}>Export with passwords</button><button type="button" className="btn btn-sm" onClick={() => setExporting(null)}>Cancel</button></>}>
          <p>The file will hold every password of the {shown.length} login{shown.length === 1 ? '' : 's'} in the list, in plain text. Anyone who gets the file can sign in to them. The export is recorded with your name.</p>
          <label className="field"><span>Type <b>{me.confirmWords}</b> to go on</span><input value={exporting.text} onChange={(e) => setExporting({ text: e.target.value })} autoComplete="off" /></label>
          <p className="small-muted">You will be asked for your TeamLink password.</p>
        </Modal>
      )}
    </div>
  );
}

function AssignModal({ count, empOpts, onClose, onApply }) {
  const [ids, setIds] = useState([]);
  const [mode, setMode] = useState('add');
  return (
    <Modal title={`Assign ${count} login${count === 1 ? '' : 's'}`} onClose={onClose} footer={<><button type="button" className="btn btn-sm btn-primary" disabled={!ids.length && mode === 'add'} onClick={() => onApply(ids, mode)}>Assign</button><button type="button" className="btn btn-sm" onClick={onClose}>Cancel</button></>}>
      <label className="field"><span>Employees who use them</span><MultiPick id="cv-assign" options={empOpts} value={ids} onChange={setIds} placeholder="Pick employees" /></label>
      <label className="cv-check"><input type="radio" name="cv-mode" checked={mode === 'add'} onChange={() => setMode('add')} /> Add to the people already assigned</label>
      <label className="cv-check"><input type="radio" name="cv-mode" checked={mode === 'replace'} onChange={() => setMode('replace')} /> Replace the people assigned</label>
    </Modal>
  );
}

// ---- add / edit ----------------------------------------------------------------------------------------------------------
function EditModal({ row, opts, empOpts, rights, onClose, onSaved }) {
  const [v, setV] = useState(() => ({
    platform: row ? row.platform : '', label: row ? row.label : '', loginUrl: row ? row.loginUrl : '', username: row ? row.username : '', password: '',
    assignedEmployeeIds: row ? row.assigned.map((a) => a.id) : [], department: row ? row.department : '', ownerEmployeeId: row && row.owner ? row.owner.id || '' : '',
    notes: row ? row.notes : '', renewalDate: row ? row.renewalDate : '', status: row ? row.status : 'active', employeeCanSee: row ? row.employeeCanSee : false,
    extra: { recoveryCodes: '', pin: '', securityAnswers: '', other: '' }, clearPassword: false, clearExtra: false,
  }));
  const [showPw, setShowPw] = useState(false);
  const [symbols, setSymbols] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setV({ ...v, [k]: e && e.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e });
  const setExtra = (k) => (e) => setV({ ...v, extra: { ...v.extra, [k]: e.target.value } });
  const platformOpts = opts.platforms.map((p) => ({ value: p, label: p }));
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    const body = { ...v };
    if (row && !rights.assign) delete body.assignedEmployeeIds;
    try {
      if (row) await api.put(`/credentials-vault/credentials/${row.id}`, body);
      else await api.post('/credentials-vault/credentials', body);
      onSaved(row ? 'Login saved.' : 'Login added. Its password is encrypted.');
    } catch (ex) { setErr(errText(ex)); } finally { setBusy(false); }
  };
  return (
    <Modal title={row ? `Edit ${row.platform} login` : 'Add a login'} size="wide" onClose={onClose}>
      <form onSubmit={submit} autoComplete="off" className="cv-form">
        <div className="cv-grid">
          <label className="field"><span>Platform</span>
            <MultiPick id="cv-platform" single allowCustom options={platformOpts} value={v.platform ? [v.platform] : []} onChange={(list) => setV({ ...v, platform: list[0] || '' })} placeholder="Naukri, Hostinger, Gmail …" />
          </label>
          <label className="field"><span>Label (optional)</span><input value={v.label} onChange={set('label')} maxLength={150} placeholder="e.g. Naukri - IT team" autoComplete="off" /></label>
          <label className="field"><span>Login URL (optional)</span><input value={v.loginUrl} onChange={set('loginUrl')} maxLength={500} placeholder="https://…" autoComplete="off" inputMode="url" /></label>
          <label className="field"><span>Username / Email</span><input value={v.username} onChange={set('username')} maxLength={200} required autoComplete="off" name="cv-username" /></label>
          <div className="field cv-span">
            <span>{row ? (row.hasPassword ? 'New password (leave empty to keep the saved one)' : 'Password') : 'Password'}</span>
            <div className="cv-row">
              <input type={showPw ? 'text' : 'password'} value={v.password} onChange={set('password')} maxLength={500} autoComplete="new-password" name="cv-secret-pw" className="cv-grow" data-testid="cv-pw-input" />
              <button type="button" className="btn btn-sm" onClick={() => setShowPw((s) => !s)}>{showPw ? 'Hide' : 'Show'}</button>
              <button type="button" className="btn btn-sm" onClick={() => { setV({ ...v, password: makePassword(16, symbols) }); setShowPw(true); }}>Generate</button>
              <label className="cv-check"><input type="checkbox" checked={symbols} onChange={(e) => setSymbols(e.target.checked)} /> with symbols</label>
            </div>
            {row && row.hasPassword && <label className="cv-check"><input type="checkbox" checked={v.clearPassword} onChange={set('clearPassword')} disabled={!!v.password} /> Remove the saved password</label>}
          </div>
          {(!row || rights.assign) && (
            <label className="field cv-span"><span>Employees who use it</span><MultiPick id="cv-emps" options={empOpts} value={v.assignedEmployeeIds} onChange={(list) => setV({ ...v, assignedEmployeeIds: list })} placeholder="Pick employees" /></label>
          )}
          <label className="field"><span>Department</span>
            <input value={v.department} onChange={set('department')} list="cv-depts" maxLength={100} autoComplete="off" />
            <datalist id="cv-depts">{opts.departments.map((d) => <option key={d} value={d} />)}</datalist>
          </label>
          <label className="field"><span>Owner (who manages it)</span>
            <select value={v.ownerEmployeeId} onChange={set('ownerEmployeeId')}><option value="">Nobody named</option>{empOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
          </label>
          <label className="field"><span>Renewal / expiry date</span><input type="date" value={v.renewalDate} onChange={set('renewalDate')} /></label>
          <label className="field"><span>Status</span><select value={v.status} onChange={set('status')}><option value="active">Active</option><option value="disabled">Disabled</option></select></label>
          <label className="field cv-span"><span>Notes (no passwords here)</span><textarea value={v.notes} onChange={set('notes')} maxLength={2000} rows={2} autoComplete="off" /></label>
        </div>
        <fieldset className="cv-fs">
          <legend>Extra secrets (encrypted like the password)</legend>
          {row && row.hasExtra && <p className="small-muted">Saved: {row.extraKinds}. Type here only to replace all of them.</p>}
          <div className="cv-grid">
            <label className="field"><span>2FA recovery codes</span><textarea rows={2} value={v.extra.recoveryCodes} onChange={setExtra('recoveryCodes')} autoComplete="off" spellCheck={false} /></label>
            <label className="field"><span>PIN</span><input type="password" value={v.extra.pin} onChange={setExtra('pin')} autoComplete="new-password" /></label>
            <label className="field"><span>Security answers</span><textarea rows={2} value={v.extra.securityAnswers} onChange={setExtra('securityAnswers')} autoComplete="off" spellCheck={false} /></label>
            <label className="field"><span>Other secret</span><textarea rows={2} value={v.extra.other} onChange={setExtra('other')} autoComplete="off" spellCheck={false} /></label>
          </div>
          {row && row.hasExtra && <label className="cv-check"><input type="checkbox" checked={v.clearExtra} onChange={set('clearExtra')} /> Remove the saved extra secrets</label>}
        </fieldset>
        <label className="cv-check cv-own"><input type="checkbox" checked={v.employeeCanSee} onChange={set('employeeCanSee')} /> The assigned employees can see this login and its password themselves (off = only people with vault access)</label>
        {err && <div className="notice red" role="alert">{err}</div>}
        <div className="cv-row">
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Saving…' : row ? 'Save' : 'Add login'}</button>
          <button type="button" className="btn btn-sm" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

// ---- details drawer ------------------------------------------------------------------------------------------------------
function DetailsDrawer({ id, rights, withReauth, onMessage, onClose, onEdit, onDeleted }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState(false);
  const load = useCallback(() => { api.get(`/credentials-vault/credentials/${id}`).then((r) => setD(r.data)).catch((e) => setErr(errText(e))); }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const esc = (e) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', esc); return () => document.removeEventListener('keydown', esc); }, [onClose]);
  const del = async () => { try { await api.delete(`/credentials-vault/credentials/${id}`); onDeleted(); } catch (e) { setErr(errText(e)); } };
  const c = d && d.credential;
  return (
    <div className="cv-drawer-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="cv-drawer" role="dialog" aria-label="Login details">
        <div className="cv-drawer-head">
          <h3>{c ? `${c.platform}${c.label ? ` - ${c.label}` : ''}` : 'Login'}</h3>
          <button type="button" className="close-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        {err && <div className="notice red">{err}</div>}
        {!c ? <div className="small-muted">Loading…</div> : (
          <div className="cv-drawer-body">
            <dl className="cv-dl">
              <dt>Username / Email</dt><dd className="cv-user">{c.username}</dd>
              <dt>Password</dt><dd><SecretCell cred={c} withReauth={withReauth} onMessage={onMessage} />{c.lastRotatedAt && <div className="small-muted">changed {when(c.lastRotatedAt)}</div>}</dd>
              {c.hasExtra && <><dt>Extra secrets</dt><dd><SecretCell cred={c} field="extra" withReauth={withReauth} onMessage={onMessage} /></dd></>}
              <dt>Login page</dt><dd>{safeHref(c.loginUrl) ? <a href={safeHref(c.loginUrl)} target="_blank" rel="noopener noreferrer">{c.loginUrl}</a> : <span className="small-muted">none</span>}</dd>
              <dt>Employees</dt><dd>{c.assigned.map((a) => `${a.name}${a.code ? ` (${a.code})` : ''}`).join(', ') || <span className="small-muted">nobody</span>}</dd>
              <dt>Employee can see own</dt><dd>{c.employeeCanSee ? 'Yes' : 'No'}</dd>
              <dt>Department</dt><dd>{c.department || <span className="small-muted">none</span>}</dd>
              <dt>Owner</dt><dd>{c.owner ? c.owner.name : <span className="small-muted">nobody named</span>}</dd>
              <dt>Renewal</dt><dd>{c.renewalDate ? day(c.renewalDate) : <span className="small-muted">none</span>}</dd>
              <dt>Status</dt><dd>{c.status === 'disabled' ? 'Disabled' : 'Active'}</dd>
              <dt>Notes</dt><dd className="cv-notes">{c.notes || <span className="small-muted">none</span>}</dd>
              <dt>Added</dt><dd>{when(c.createdAt)} by {c.createdByName || 'someone'}{c.imported ? ' (imported)' : ''}</dd>
              <dt>Last changed</dt><dd>{when(c.updatedAt)} by {c.updatedByName || 'someone'}</dd>
            </dl>
            <div className="cv-row">
              {rights.edit && <button type="button" className="btn btn-sm btn-primary" onClick={() => onEdit(c)}>Edit</button>}
              {rights.delete && !confirm && <button type="button" className="btn btn-sm btn-danger" onClick={() => setConfirm(true)}>Delete…</button>}
              {confirm && <><span>Delete this login and its password? This cannot be undone.</span><button type="button" className="btn btn-sm btn-danger" onClick={del}>Yes, delete</button><button type="button" className="btn btn-sm" onClick={() => setConfirm(false)}>No</button></>}
            </div>
            {rights.view && (
              <>
                <h4 className="cv-h4">History</h4>
                {d.history.length === 0 ? <div className="small-muted">Nothing yet.</div> : (
                  <ul className="cv-hist">
                    {d.history.map((h) => <li key={h.id}><b>{h.userName || 'someone'}</b> {h.what}{h.detail ? ` (${h.detail})` : ''} <span className="small-muted">{when(h.at)}{h.ip ? ` · ${h.ip}` : ''}</span></li>)}
                  </ul>
                )}
              </>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

// ---- import ----------------------------------------------------------------------------------------------------------------
function ImportPanel() {
  const [file, setFile] = useState(null);
  const [prev, setPrev] = useState(null);
  const [mapping, setMapping] = useState(null);
  const [choices, setChoices] = useState({});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [result, setResult] = useState(null);
  const [batches, setBatches] = useState([]);
  const [show, setShow] = useState('all');
  const inputRef = useRef(null);
  const loadBatches = useCallback(() => { api.get('/credentials-vault/import/batches').then((r) => setBatches(r.data.batches)).catch(() => {}); }, []);
  useEffect(() => { loadBatches(); }, [loadBatches]);

  const template = async () => {
    try { const r = await api.get('/credentials-vault/import/template', { responseType: 'blob' }); saveBlob(r, 'credentials-template.xlsx'); } catch (e) { setMsg({ ok: false, text: (await blobError(e)).error || 'The template could not be downloaded.' }); }
  };
  const send = async (f, map) => {
    if (!f) return;
    setBusy('preview'); setMsg(null); setResult(null); setChoices({});
    const fd = new FormData();
    fd.append('file', f);
    if (map) fd.append('mapping', JSON.stringify(map));
    try {
      const r = await api.post('/credentials-vault/import/preview', fd);
      setPrev(r.data);
      setMapping(Object.fromEntries((r.data.mapping || []).map((m) => [m.key, m.column === null || m.column === undefined ? '' : String(m.column)])));
    } catch (e) { setPrev(null); setMsg({ ok: false, text: errText(e) }); } finally { setBusy(''); }
  };
  const pick = (f) => { setFile(f); send(f, null); };
  const recheck = async (next) => {
    if (!prev || !prev.batchId) return;
    try { const r = await api.post('/credentials-vault/import/check', { batchId: prev.batchId, choices: next }); setPrev({ ...prev, rows: r.data.rows, counts: r.data.counts }); } catch (e) { setMsg({ ok: false, text: errText(e) }); }
  };
  const choose = (key, val) => { const next = { ...choices, [key]: val }; setChoices(next); recheck(next); };
  const apply = async () => {
    setBusy('apply');
    try {
      const r = await api.post('/credentials-vault/import/apply', { batchId: prev.batchId, choices });
      setResult(r.data); setPrev(null); setFile(null); if (inputRef.current) inputRef.current.value = '';
      loadBatches();
    } catch (e) { setMsg({ ok: false, text: errText(e) }); } finally { setBusy(''); }
  };
  const undo = async (id) => {
    try { const r = await api.post(`/credentials-vault/import/batches/${id}/undo`); setMsg({ ok: true, text: r.data.message }); setResult(null); loadBatches(); } catch (e) { setMsg({ ok: false, text: errText(e) }); }
  };
  const counts = prev && prev.counts;
  const rows = prev ? prev.rows.filter((r) => r.status !== 'skipped' && (show === 'all' || r.status === show)) : [];
  return (
    <div className="cv-import">
      <p className="small-muted">Bring in the logins kept in an Excel or CSV sheet. The file is read in memory and never saved; passwords are encrypted at once and the preview shows them hidden. Nothing is added until you press Import, and every import can be undone.</p>
      <div className="cv-row">
        <button type="button" className="btn btn-sm" onClick={template}>Download template</button>
        <label className="btn btn-sm btn-primary cv-file">
          {busy === 'preview' ? 'Reading…' : 'Choose the sheet'}
          <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" onChange={(e) => pick(e.target.files && e.target.files[0])} data-testid="cv-import-file" />
        </label>
        {file && <span className="small-muted">{file.name}</span>}
      </div>
      {msg && <div className={`notice ${msg.ok ? 'green' : 'red'}`} role="status">{msg.text}</div>}
      {result && (
        <div className="notice green cv-result" role="status">
          {result.message}
          <button type="button" className="btn btn-sm" onClick={() => undo(result.batchId)}>Undo this import</button>
        </div>
      )}
      {prev && (
        <>
          {prev.smartSheets && (
            <div className="notice" data-testid="cv-smart-sheets">
              <b>Every sheet was read</b> (the platform comes from each sheet&apos;s name; a name that is not an employee is kept as the label):{' '}
              {prev.smartSheets.map((x) => (x.skipped ? `${x.name.trim()}: skipped (${x.skipped})` : `${x.name.trim()}: ${x.logins}`)).join(' · ')}
            </div>
          )}
          {!prev.smartSheets && <h4 className="cv-h4">Which column is which</h4>}
          {prev.needsMapping && <div className="notice amber">These columns were not found: {prev.missing.join(', ')}. Pick them below and press Check again.</div>}
          {!prev.smartSheets && <>
          <div className="cv-map">
            {(prev.mapping || []).map((m) => (
              <label key={m.key} className="field"><span>{m.label}{m.need ? ' (needed)' : ''}</span>
                <select value={mapping ? mapping[m.key] : ''} onChange={(e) => setMapping({ ...mapping, [m.key]: e.target.value })}>
                  <option value="">Not in the sheet</option>
                  {prev.fileColumns.map((c) => <option key={c.index} value={String(c.index)}>{c.name}</option>)}
                </select>
              </label>
            ))}
          </div>
          <button type="button" className="btn btn-sm" disabled={!file || busy === 'preview'} onClick={() => send(file, Object.fromEntries(Object.entries(mapping || {}).map(([k, val]) => [k, val === '' ? null : Number(val)])))}>Check again</button>
          </>}
          {counts && !prev.needsMapping && (
            <>
              <div className="cv-counts">
                <button type="button" className={`cv-count ready${show === 'ready' ? ' on' : ''}`} onClick={() => setShow(show === 'ready' ? 'all' : 'ready')}>Ready {counts.ready}</button>
                <button type="button" className={`cv-count choice${show === 'choice' ? ' on' : ''}`} onClick={() => setShow(show === 'choice' ? 'all' : 'choice')}>Needs a choice {counts.choice}</button>
                <button type="button" className={`cv-count refused${show === 'refused' ? ' on' : ''}`} onClick={() => setShow(show === 'refused' ? 'all' : 'refused')}>Refused {counts.refused}</button>
                {counts.skipped > 0 && <span className="small-muted">{counts.skipped} example row{counts.skipped === 1 ? '' : 's'} skipped</span>}
              </div>
              <div className="tbl-wrap">
                <table className="cv-table">
                  <thead><tr><th>Row</th><th>Platform</th><th>Username / Email</th><th>Password</th><th>Employee</th><th>Department</th><th>Result</th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.row} data-testid="cv-prev-row">
                        <td>{r.where || r.row}</td>
                        <td>{r.platform}{r.label && <div className="small-muted">{r.label}</div>}</td>
                        <td className="cv-user">{r.username}</td>
                        <td><span className="cv-mask">{r.password || <span className="small-muted">none</span>}</span>{r.hasExtra && <div className="small-muted">+ extra secret</div>}</td>
                        <td>
                          {r.employees.map((e) => e.name).join(', ')}
                          {r.choices.map((ch) => (
                            <div key={ch.key}>
                              <select value={choices[ch.key] || ''} onChange={(e) => choose(ch.key, e.target.value)} aria-label={`Which ${ch.text}`}>
                                <option value="">Which &quot;{ch.text}&quot;?</option>
                                {ch.options.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.code}{o.department ? `, ${o.department}` : ''})</option>)}
                              </select>
                            </div>
                          ))}
                        </td>
                        <td>{r.department}</td>
                        <td>{r.status === 'ready' ? <span className="cv-count ready">Ready</span> : r.status === 'choice' ? <span className="cv-count choice">Needs a choice</span> : <span className="cv-count refused" title={r.reasons.join('; ')}>Refused: {r.reasons.join('; ')}</span>}</td>
                      </tr>
                    ))}
                    {rows.length === 0 && <tr><td colSpan={7} className="small-muted">No rows here.</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="cv-row">
                <button type="button" className="btn btn-primary btn-sm" disabled={!counts.ready || busy === 'apply'} onClick={apply}>{busy === 'apply' ? 'Importing…' : `Import ${counts.ready} login${counts.ready === 1 ? '' : 's'}`}</button>
                {counts.choice > 0 && <span className="small-muted">Rows that still need a choice are left out.</span>}
              </div>
            </>
          )}
        </>
      )}
      <h4 className="cv-h4">Recent imports</h4>
      {batches.length === 0 ? <div className="small-muted">None yet.</div> : (
        <div className="tbl-wrap">
          <table className="cv-table">
            <thead><tr><th>When</th><th>File</th><th>By</th><th>Added</th><th>State</th><th aria-label="Undo" /></tr></thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id}>
                  <td>{when(b.appliedAt || b.createdAt)}</td><td>{b.fileName}</td><td>{b.byName}</td><td>{b.createdRows}</td>
                  <td>{b.status === 'undone' ? `Undone ${when(b.undoneAt)} (${b.undoneRows} removed${b.keptRows ? `, ${b.keptRows} kept` : ''})` : 'Imported'}</td>
                  <td>{b.status === 'applied' && <button type="button" className="btn btn-sm" onClick={() => undo(b.id)}>Undo</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- who opened what -------------------------------------------------------------------------------------------------
const LOG_ACTIONS = [['', 'Everything'], ['show_password', 'Password shown'], ['copy_password', 'Password copied'], ['show_extra', 'Extra secret shown'], ['copy_extra', 'Extra secret copied'],
  ['create', 'Added'], ['edit', 'Changed'], ['delete', 'Deleted'], ['disable', 'Disabled'], ['assign', 'Assigned'], ['import', 'Imported'], ['undo_import', 'Import undone'],
  ['export', 'Exported'], ['export_with_passwords', 'Exported with passwords'], ['reauth_failed', 'Wrong password'], ['locked', 'Locked'], ['grant', 'Access changed']];
function AccessLog() {
  const [rows, setRows] = useState(null);
  const [action, setAction] = useState('');
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { api.get('/credentials-vault/access-log', { params: action ? { action } : {} }).then((r) => setRows(r.data.rows)).catch((e) => setErr(errText(e))); }, [action]);
  const t = text.trim().toLowerCase();
  const shown = (rows || []).filter((r) => !t || `${r.userName} ${r.credentialName} ${r.detail} ${r.ip}`.toLowerCase().includes(t));
  return (
    <div>
      <div className="cv-toolbar">
        <input type="search" className="cv-search" placeholder="Search person, login, IP" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" aria-label="Search the log" />
        <label className="cv-sort">Show <select value={action} onChange={(e) => setAction(e.target.value)}>{LOG_ACTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      </div>
      {err && <div className="notice red">{err}</div>}
      {!rows ? <div className="small-muted">Loading…</div> : (
        <div className="tbl-wrap">
          <table className="cv-table" data-testid="cv-log">
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Login</th><th className="cv-hide-sm">IP</th></tr></thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={5} className="small-muted">Nothing recorded.</td></tr>}
              {shown.map((r) => (
                <tr key={r.id} data-testid="cv-log-row">
                  <td>{when(r.at)}</td><td>{r.userName}</td><td>{r.what}{r.detail ? <div className="small-muted">{r.detail}</div> : null}</td><td>{r.credentialName}</td><td className="cv-hide-sm">{r.ip}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- per-person access (Super Admin) -----------------------------------------------------------------------------------
const GRANT_KEYS = [['view', 'See the list'], ['reveal', 'Show / Copy passwords'], ['manage', 'Add, edit, assign, delete'], ['import', 'Import'], ['export', 'Export']];
function AccessPanel() {
  const [grants, setGrants] = useState(null);
  const [q, setQ] = useState('');
  const [people, setPeople] = useState([]);
  const [msg, setMsg] = useState(null);
  const load = useCallback(() => { api.get('/credentials-vault/grants').then((r) => setGrants(r.data.grants)).catch((e) => setMsg({ ok: false, text: errText(e) })); }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (q.trim().length < 2) { setPeople([]); return undefined; }
    const t = setTimeout(() => { api.get('/credentials-vault/people', { params: { q } }).then((r) => setPeople(r.data.people)).catch(() => {}); }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const save = async (userId, rights) => {
    try { await api.put(`/credentials-vault/grants/${userId}`, { rights }); setMsg({ ok: true, text: 'Access saved.' }); load(); } catch (e) { setMsg({ ok: false, text: errText(e) }); }
  };
  const toggle = (g, k) => {
    const next = { ...g.rights, [k]: !g.rights[k] };
    if (k === 'view' && !next.view) GRANT_KEYS.forEach(([x]) => { next[x] = false; });
    if (k !== 'view' && next[k]) next.view = true;
    save(g.userId, next);
  };
  return (
    <div>
      <div className="notice">Only you (the Super Admin) can open the vault until you grant it. Two ways: <b>a whole role</b> in Administration &gt; Role Catalog &gt; Administration &gt; &quot;Credentials Vault&quot; (View = list, Approve = Show / Copy, Configure = import, Export), or <b>one person</b> here. Managers and Assistant Managers never see passwords unless you tick it.</div>
      {msg && <div className={`notice ${msg.ok ? 'green' : 'red'}`} role="status">{msg.text}</div>}
      <label className="field"><span>Give a person access</span><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a name or e-mail" autoComplete="off" /></label>
      {people.length > 0 && (
        <ul className="cv-people">
          {people.map((p) => <li key={p.id}>{p.name} <span className="small-muted">{p.email} · {p.role}</span> <button type="button" className="btn btn-sm" onClick={() => { save(p.id, { view: true }); setQ(''); }}>Give &quot;See the list&quot;</button></li>)}
        </ul>
      )}
      <h4 className="cv-h4">People with access</h4>
      {!grants ? <div className="small-muted">Loading…</div> : grants.length === 0 ? <div className="small-muted">Nobody yet (besides you).</div> : (
        <div className="tbl-wrap">
          <table className="cv-table">
            <thead><tr><th>Person</th>{GRANT_KEYS.map(([k, l]) => <th key={k} className="cv-c">{l}</th>)}<th aria-label="Remove" /></tr></thead>
            <tbody>
              {grants.map((g) => (
                <tr key={g.userId}>
                  <td>{g.name}<div className="small-muted">{g.email} · {g.role}</div></td>
                  {GRANT_KEYS.map(([k]) => <td key={k} className="cv-c"><input type="checkbox" checked={!!g.rights[k]} onChange={() => toggle(g, k)} aria-label={`${g.name} ${k}`} /></td>)}
                  <td><button type="button" className="btn btn-sm" onClick={() => save(g.userId, {})}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
