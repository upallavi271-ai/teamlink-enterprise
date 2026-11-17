import { useEffect, useState } from 'react';
import api from '../api';

// SIGNED-IN DEVICES (backend routes/sessions.js): where this login is signed in now, sign one out or all others, the last 30
// days' sign-ins and how each ended. Super Admin / Admin also set the idle sign-out here. `userId` = an admin looking at
// somebody else's devices (Users screen).
const ENDED = {
  'signed out': 'Signed out', 'signed out from another device': 'Signed out from another device', admin: 'Signed out by an administrator',
  idle: 'Signed out (no activity)', expired: 'Expired after 8 hours',
};
const when = (s) => (s ? new Date(s).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

export function SessionsList({ userId = null, compact = false }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const base = userId ? `/auth/sessions/user/${userId}` : '/auth/sessions';
  const load = () => api.get(base).then((r) => setRows(r.data.sessions || [])).catch((e) => setErr(e.response?.data?.error || 'The devices could not be loaded.'));
  useEffect(() => { load(); }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps
  const endOne = async (sid) => {
    setBusy(true); setErr('');
    try { await api.post(userId ? `/auth/sessions/user/${userId}/${sid}/end` : `/auth/sessions/${sid}/end`); await load(); } catch (e) { setErr(e.response?.data?.error || 'That did not work.'); } finally { setBusy(false); }
  };
  if (!rows) return err ? <div className="error-text">{err}</div> : <div className="small-muted">Loading…</div>;
  const open = rows.filter((r) => r.open);
  const past = rows.filter((r) => !r.open).slice(0, compact ? 10 : 30);
  return (
    <div>
      {err && <div className="error-text">{err}</div>}
      <div style={{ fontWeight: 600, margin: '4px 0' }}>Signed in now ({open.length})</div>
      {!open.length && <div className="small-muted">No open sessions.</div>}
      {open.map((r) => (
        <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0', borderBottom: '1px solid var(--border, #eee)' }}>
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
            <b>{r.device}</b>{r.current && <span className="small-muted"> · this device</span>}
            <div className="small-muted">Signed in {when(r.createdAt)} · last active {when(r.lastSeenAt)}{r.ip ? ` · IP ${r.ip}` : ''}</div>
          </div>
          {!r.current && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => endOne(r.id)}>Sign out</button>}
        </div>
      ))}
      {!userId && open.filter((r) => !r.current).length > 0 && (
        <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} disabled={busy}
          onClick={async () => { setBusy(true); try { await api.post('/auth/sessions/end-others'); await load(); } finally { setBusy(false); } }}>
          Sign out all other devices
        </button>
      )}
      {past.length > 0 && (
        <>
          <div style={{ fontWeight: 600, margin: '12px 0 4px' }}>Earlier sign-ins (30 days)</div>
          <div className="table-wrap">
            <table className="table" style={{ fontSize: 12.5 }}>
              <thead><tr><th>Device</th><th>Signed in</th><th>Last active</th><th>How it ended</th><th>IP</th></tr></thead>
              <tbody>{past.map((r) => <tr key={r.id}><td>{r.device}</td><td>{when(r.createdAt)}</td><td>{when(r.lastSeenAt)}</td><td>{ENDED[r.ended] || r.ended || '—'}</td><td>{r.ip || '—'}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export default function SessionsCard({ style }) {
  const [idle, setIdle] = useState(null);
  const [saved, setSaved] = useState('');
  useEffect(() => { api.get('/auth/security/idle').then((r) => setIdle(r.data)).catch(() => {}); }, []);
  return (
    <div className="card section" style={style}>
      <h3 style={{ marginTop: 0 }}>Signed-in devices</h3>
      <SessionsList />
      {idle && idle.canManage && (
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border, #e5e7eb)' }}>
          <b>Idle sign-out</b> <span className="small-muted">(Super Admin / Admin, for everybody)</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
            <select value={idle.minutes} onChange={async (e) => { const r = await api.put('/auth/security/idle', { minutes: Number(e.target.value) }); setIdle({ ...idle, minutes: r.data.minutes }); setSaved('Saved. It applies from each person\'s next page load.'); }} style={{ width: 'auto' }}>
              {[0, 15, 30, 60, 120, 240].map((m) => <option key={m} value={m}>{m ? `After ${m} minutes with no activity` : 'Off'}</option>)}
            </select>
            {saved && <span className="small-muted">{saved}</span>}
          </div>
        </div>
      )}
      {idle && !idle.canManage && idle.minutes > 0 && <div className="small-muted" style={{ marginTop: 10 }}>You are signed out after {idle.minutes} minutes with no activity.</div>}
    </div>
  );
}
