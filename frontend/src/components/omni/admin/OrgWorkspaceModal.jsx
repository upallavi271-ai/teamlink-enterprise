import { useCallback, useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmniStore, setDept } from '../omniStore.js';
import { fmtNum } from '../ui.jsx';
import '../gs.css';
import './admin.css';

// ---------------------------------------------------------------------------
// ORGANIZATION WORKSPACE (the prototype's "Switch Organization" modal). In TeamLink an organization is a department (a workspace): this lists the
// departments the login may open (an Admin / Manager see all of them, everybody else their own), with people and the credits used this month. Opening
// one picks it in the top-bar switcher (every Omni-Channel page then shows that department). "New Organization" (Admin only) adds a department NAME to
// the Omni-Channel list. Draw it anywhere (it carries its own .gsx wrapper):
//     {open && <OrgWorkspaceModal onClose={() => setOpen(false)} onToast={toast} onEnter={(name) => ...} />}
// ---------------------------------------------------------------------------
const shortRole = (r) => String(r || '').replace(/^Super Admin \/ /, '');
const initial = (n) => String(n || '?').trim().charAt(0).toUpperCase() || '?';

function CreateOrg({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const create = async () => {
    const t = name.trim();
    setErr('');
    if (!t) { setErr('Give the organization a name.'); return; }
    if (t.length < 2) { setErr('That name is too short.'); return; }
    setBusy(true);
    try { const r = await omni.post('/org', { name: t }); onCreated(r.name || t, r.ok); } catch (e) { setErr(errOf(e, 'It could not be created.')); setBusy(false); }
  };
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  return (
    <div className="modal-bg show" style={{ zIndex: 1300 }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Create Organization" style={{ width: 'min(460px,100%)' }}>
        <div className="modal-head"><div><b>Create Organization</b><p>Enter a name for your new organization workspace.</p></div><button type="button" className="close" aria-label="Close" onClick={onClose}>×</button></div>
        <div className="modal-body">
          <input className="org-input" autoFocus maxLength={80} placeholder="Organization Name" aria-label="Organization Name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
          {err && <div role="alert" style={{ marginTop: 10, background: '#fdeced', border: '1px solid #f4c9cc', color: '#9b1c1c', borderRadius: 10, padding: '8px 11px', fontSize: 11 }}>{err}</div>}
          <div className="adm-note">This adds a department name to the Omni-Channel list. People join it in Administration &gt; Departments and Users.</div>
        </div>
        <div className="modal-foot"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create'}</button></div>
      </div>
    </div>
  );
}

export default function OrgWorkspaceModal({ onClose, onToast, onEnter }) {
  const store = useOmniStore();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => omni.get('/org/overview').then((d) => { setData(d); setErr(''); }).catch((e) => setErr(errOf(e, 'The organizations could not be loaded.'))), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape' && !creating) onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose, creating]);

  const rows = data ? data.rows.filter((r) => !r.noDept) : [];
  const cards = data && data.all ? [{ name: '', title: 'All departments', people: rows.reduce((n, r) => n + r.people, 0), creditsUsed: rows.reduce((n, r) => n + r.creditsUsed, 0), creditsGiven: rows.reduce((n, r) => n + r.creditsGiven, 0), messages: rows.reduce((n, r) => n + r.messages, 0), all: true }, ...rows] : rows;
  const cur = store.dept || '';
  const isCurrent = (r) => (r.all ? !cur : cur.toLowerCase() === r.name.toLowerCase());
  const role = shortRole((data && data.yourRole) || '').toUpperCase();
  const pick = cards.find((r) => (sel === null ? false : r.name === sel));
  const enter = (r) => {
    setDept(r.all ? '' : r.name);
    if (onToast) onToast(`Switched to ${r.all ? 'All departments' : r.name}`);
    if (onEnter) onEnter(r.all ? '' : r.name);
    onClose();
  };
  return (
    <div className="gsx" style={{ background: 'transparent', minHeight: 0, overflow: 'visible' }}>
      <div className="modal-bg show" style={{ zIndex: 1200 }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="modal org-modal" role="dialog" aria-modal="true" aria-label="Organization Workspace">
          <div className="modal-head">
            <div><b style={{ fontSize: 19 }}>Organization Workspace</b><p>Manage your teams and subscription credits.</p></div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              {data && data.canCreate && <button type="button" className="btn primary" onClick={() => setCreating(true)}>＋ New Organization</button>}
              <button type="button" className="close" aria-label="Close" onClick={onClose}>×</button>
            </div>
          </div>
          <div className="modal-body">
            {err && <div role="alert" style={{ color: '#9b1c1c', fontSize: 12 }}>{err}</div>}
            {!data && !err && <div style={{ fontSize: 12, color: 'var(--muted)' }}>Loading…</div>}
            {data && (
              <div className="org-body">
                <div>
                  <div className="org-count">Your Organizations ({cards.length})</div>
                  <div className="org-grid adm-org-cards">
                    {cards.map((r) => (
                      <div key={r.name || '__all'} role="button" tabIndex={0} className={`org-card${sel === r.name ? ' sel' : ''}${isCurrent(r) ? ' active' : ''}`}
                        onClick={() => setSel(r.name)} onDoubleClick={() => enter(r)} onKeyDown={(e) => { if (e.key === 'Enter') enter(r); else if (e.key === ' ') { e.preventDefault(); setSel(r.name); } }}>
                        <div className="org-card-top"><div className="org-avatar">{initial(r.title || r.name)}</div><span className="org-role">{role}</span></div>
                        <span className="org-name">{r.title || r.name}</span>
                        <div className="org-meta"><span>👥 {fmtNum(r.people)} {r.people === 1 ? 'Member' : 'Members'}</span>{isCurrent(r) && <span className="org-current">● Current</span>}</div>
                      </div>
                    ))}
                    {!cards.length && <div className="adm-note">No department yet.</div>}
                  </div>
                </div>
                <div className="org-right">
                  {!pick ? (
                    <div className="org-empty"><div className="org-empty-ico">👥</div><p>Select an organization to view dashboard</p></div>
                  ) : (
                    <>
                      <div className="org-prev-head"><div className="org-avatar lg">{initial(pick.title || pick.name)}</div><div><b>{pick.title || pick.name}</b><small>{role} · {fmtNum(pick.people)} {pick.people === 1 ? 'member' : 'members'}</small></div></div>
                      <div className="org-prev-stats">
                        <div><small>Credits used this month</small><b>{fmtNum(pick.creditsUsed)}</b></div>
                        <div><small>Credits given</small><b>{fmtNum(pick.creditsGiven)}</b></div>
                        <div><small>Messages sent</small><b>{fmtNum(pick.messages)}</b></div>
                        <div><small>Team members</small><b>{fmtNum(pick.people)}</b></div>
                        <div><small>Your role</small><b>{data.yourRole}</b></div>
                      </div>
                      <button type="button" className="btn primary" style={{ width: '100%', marginTop: 16 }} disabled={isCurrent(pick)} onClick={() => enter(pick)}>{isCurrent(pick) ? '✓ Currently open' : `Open ${pick.title || pick.name}`}</button>
                      <div className="org-prev-note">{data.note}</div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      {creating && <CreateOrg onClose={() => setCreating(false)} onCreated={(name, ok) => { setCreating(false); setSel(name); load(); if (onToast) onToast(ok || `"${name}" created`); }} />}
    </div>
  );
}
