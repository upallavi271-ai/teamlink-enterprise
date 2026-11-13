import { useEffect, useState } from 'react';
import api from '../../api';

// Administration > Integrations > Omni-Channel > "Who opens Omni-Channel like the Super Admin" (founder 2026-11-13: employees should open Omni-Channel the way the Super Admin does,
// but with only some permissions). One switch per kind of login. A kind that is ON opens Green Start in its own tab as its DEPARTMENT's login (Green Start's "Team Leader" role: no
// integrations, billing or workspace settings) and sees only that department's workspace. A kind that is OFF, or a person whose department has no ready login yet, keeps the native pages.
// Backend: routes/greenStartEmbed.js /access, /access/people, /access/check (Admin only).
function Chip({ tone, children }) {
  const bg = tone === 'live' ? '#e8f7ef' : tone === 'red' ? '#fdecec' : '#f1f3f6';
  const fg = tone === 'live' ? '#1c7c4a' : tone === 'red' ? '#b42318' : '#555';
  return <span style={{ background: bg, color: fg, borderRadius: 10, padding: '2px 8px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>{children}</span>;
}

export default function OmniGsAccess({ canConfigure }) {
  const [d, setD] = useState(null);
  const [on, setOn] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [q, setQ] = useState('');
  const [people, setPeople] = useState([]);
  const [res, setRes] = useState(null);
  useEffect(() => {
    api.get('/omni-gs/access').then((r) => { setD(r.data); setOn(r.data.kinds.filter((k) => k.on).map((k) => k.kind)); }).catch(() => setD({ kinds: [], error: true }));
  }, []);
  useEffect(() => {
    if (q.trim().length < 2) { setPeople([]); return undefined; }
    const t = setTimeout(() => { api.get('/omni-gs/access/people', { params: { q } }).then((r) => setPeople(r.data.people || [])).catch(() => setPeople([])); }, 250);
    return () => clearTimeout(t);
  }, [q]);
  if (!d) return null;
  if (d.error) return null;
  const dirty = JSON.stringify([...on].sort()) !== JSON.stringify(d.kinds.filter((k) => k.on).map((k) => k.kind).sort());
  const toggle = (k) => setOn((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));
  async function save() {
    setBusy(true); setMsg('');
    try { const r = await api.put('/omni-gs/access', { kinds: on }); setD(r.data); setOn(r.data.kinds.filter((k) => k.on).map((k) => k.kind)); setMsg('Saved. It applies the next time each person opens the page.'); } catch (e) { setMsg(e.response?.data?.error || 'It could not be saved.'); } finally { setBusy(false); }
  }
  async function check(p) {
    setRes({ loading: true, name: p.name }); setPeople([]); setQ('');
    try { const r = await api.get('/omni-gs/access/check', { params: { userId: p.id } }); setRes(r.data); } catch (e) { setRes({ error: e.response?.data?.error || 'It could not be checked.' }); }
  }
  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }}>
      <b>Who opens Omni-Channel like the Super Admin</b>
      <div className="small-muted" style={{ marginTop: 4, lineHeight: 1.6 }}>
        Tick a kind of login and its people open <b>Omni-Channel ↗</b> the same way you do: Green Start in its own tab, already signed in. They do not get everything:
        they open their <b>department&apos;s login</b> and see only that department&apos;s workspace, with Green Start&apos;s <b>&quot;Team Leader&quot; role</b>
        (campaigns, conversations, templates and customers; no integrations, billing or workspace settings). Super Admin and Admin always open it with every department.
        A kind that is not ticked, or a person whose department has no ready login yet (see the table above), keeps the native Omni-Channel pages.
      </div>
      <table className="table" style={{ marginTop: 10 }}>
        <thead><tr><th style={{ width: 60 }}>Opens Green Start</th><th>Kind of login</th><th>Note</th></tr></thead>
        <tbody>{d.kinds.map((k) => (
          <tr key={k.kind}>
            <td><input type="checkbox" aria-label={`${k.words} opens Green Start`} checked={on.includes(k.kind)} disabled={!canConfigure} onChange={() => toggle(k.kind)} /></td>
            <td><b>{k.words}</b></td>
            <td style={{ fontSize: 12 }}>{k.masked ? <span style={{ color: '#9a6b00' }}>The native pages hide phone numbers and emails for this kind. In Green Start they will see the full numbers of the people their department talks to.</span> : <span className="small-muted">—</span>}</td>
          </tr>
        ))}</tbody>
      </table>
      {canConfigure && <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}><button className="btn btn-primary" onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save'}</button>{msg && <span className="small-muted" role="status">{msg}</span>}</div>}

      <div style={{ marginTop: 16, borderTop: '1px solid #eee', paddingTop: 12 }}>
        <b>Check one person</b>
        <div className="small-muted" style={{ marginTop: 2 }}>Type a name to see what that person gets when they press Omni-Channel, and why.</div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type at least two letters of a name" aria-label="Find a person" style={{ marginTop: 8, width: 'min(360px, 100%)' }} />
        {people.length > 0 && <div style={{ marginTop: 6, display: 'grid', gap: 4, maxWidth: 420 }}>{people.map((p) => <button type="button" key={p.id} className="btn" style={{ textAlign: 'left' }} onClick={() => check(p)}>{p.name} <span className="small-muted">· {p.role}{p.department ? ` · ${p.department}` : ''}</span></button>)}</div>}
        {res && (
          <div className="small-muted" style={{ marginTop: 10, lineHeight: 1.6 }} role="status">
            {res.loading ? `Checking ${res.name}…` : res.error ? res.error : (
              <>
                <b style={{ color: 'inherit' }}>{res.name}</b> · {res.kindWords} {res.opens === 'green-start' ? <Chip tone="live">Opens Green Start</Chip> : (res.opens === 'native' ? <Chip>Sees the native pages</Chip> : <Chip tone="red">No Omni-Channel</Chip>)}
                <div style={{ marginTop: 4 }}>{res.why}</div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
