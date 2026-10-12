import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { StatusTabs } from '../ui/ListPageHeader.jsx';
import { DupPairCard } from './DupCheckPanel.jsx';
import './Duplicates.css';

// ---------------------------------------------------------------------------
// THE DUPLICATES TAB of Candidates & Pipeline.
//   tabs     Must sort out · Waiting for the TL · Maybe · Older ones · Done  (counts)
//   filters  Level · Department · Recruiter · Where from · dates · search — each option shows how many it would find
//   bulk     tick several → "Not duplicates" (one reason) · "Ask TL to merge" (recruiter) / "Merge" (TL, Admin)
//   TL       "Obvious ones": same phone + same name, different jobs — a proposal list; nothing merges until Approve
//   Undo     the last merges with an Undo button (7 days)
// Paged and indexed on the server (utils/candidateDupResolve.js worklist).
// ---------------------------------------------------------------------------
const err = (e, fallback) => e?.response?.data?.error || fallback;

function Facet({ label, value, onChange, options, allLabel }) {
  if (!options || options.length === 0) return null;
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{allLabel}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{`${o.label} (${o.count})`}</option>)}
    </select>
  );
}

function Obvious({ onChanged }) {
  const [data, setData] = useState(null);
  const [pick, setPick] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState(false);

  function load() { return api.get('/candidate-duplicates/auto-merge').then((r) => setData(r.data)).catch(() => setData({ proposals: [] })); }
  useEffect(() => { if (open && !data) load(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function approve() {
    setBusy(true); setMsg('');
    try {
      const r = await api.post('/candidate-duplicates/auto-merge/approve', { flagIds: [...pick] });
      setMsg(r.data.message); setPick(new Set()); await load(); if (onChanged) onChanged();
    } catch (e) { setMsg(err(e, 'Could not merge.')); } finally { setBusy(false); }
  }
  const list = (data && data.proposals) || [];
  const approvable = list.filter((p) => p.canApprove);
  return (
    <section className="dupx-sub">
      <h3>Obvious ones — a list to approve</h3>
      <div className="small-muted">Same phone, same name, different jobs. Nothing is merged until a TL or Admin approves.</div>
      {!open && <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setOpen(true)}>Show the list</button>}
      {open && !data && <div className="small-muted" style={{ marginTop: 8 }}>Loading…</div>}
      {open && data && (
        <>
          {list.length === 0 && <div className="small-muted" style={{ marginTop: 8 }}>No obvious ones right now.</div>}
          {list.slice(0, 100).map((p) => (
            <div key={p.flagId} className="dupx-prop">
              <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {p.canApprove && <input type="checkbox" style={{ width: 'auto', height: 'auto' }} checked={pick.has(p.flagId)} onChange={(e) => setPick((s) => { const n = new Set(s); if (e.target.checked) n.add(p.flagId); else n.delete(p.flagId); return n; })} />}
                <span><b>{p.merge.name}</b>{' → into '}<b>{p.keep.name}</b></span>
              </label>
              <span className="small-muted">{`${p.applicationsMoved} job(s) move${p.recruiter ? ` · ${p.recruiter}` : ''}`}</span>
            </div>
          ))}
          {approvable.length > 0 && (
            <div className="dupx-actions">
              <button type="button" className="btn btn-primary" disabled={busy || pick.size === 0} onClick={approve}>{busy ? 'Merging…' : `Approve ${pick.size || ''} merge${pick.size === 1 ? '' : 's'}`}</button>
              <button type="button" className="btn" onClick={() => setPick(new Set(approvable.map((p) => p.flagId)))}>Tick all I can approve</button>
            </div>
          )}
          {list.length > 0 && approvable.length === 0 && <div className="dupx-note">Only a TL of the team or an Admin can approve these.</div>}
          {msg && <div className="notice" style={{ marginTop: 8 }}>{msg}</div>}
        </>
      )}
    </section>
  );
}

function RecentMerges({ refreshKey, onChanged }) {
  const [rows, setRows] = useState(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { api.get('/candidate-duplicates/merges').then((r) => setRows(r.data.merges || [])).catch(() => setRows([])); }, [refreshKey]);
  if (!rows || rows.length === 0) return null;
  async function undo(id) {
    setMsg('');
    try { const r = await api.post(`/candidate-duplicates/merges/${id}/undo`); setMsg(r.data.message); setRows((x) => x.map((m) => (m.id === id ? { ...m, status: 'UNDONE', canUndo: false } : m))); if (onChanged) onChanged(); } catch (e) { setMsg(err(e, 'Could not undo.')); }
  }
  return (
    <section className="dupx-sub">
      <h3>Recent merges</h3>
      {rows.slice(0, 8).map((m) => (
        <div key={m.id} className="dupx-prop">
          <span>{m.summary}<span className="small-muted">{` · ${m.by || ''}`}</span></span>
          {m.status === 'UNDONE' ? <span className="small-muted">Undone</span> : m.canUndo ? <button type="button" className="btn btn-sm" onClick={() => undo(m.id)}>Undo</button> : <span className="small-muted">Undo time is over</span>}
        </div>
      ))}
      {msg && <div className="notice" style={{ marginTop: 8 }}>{msg}</div>}
    </section>
  );
}

export default function DupWorklist({ onCountChange }) {
  const [tab, setTab] = useState('must');
  const [f, setF] = useState({ level: '', department: '', recruiter: '', source: '', from: '', to: '', search: '' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState(new Set());
  const [tick, setTick] = useState(0);
  const [bulkAsk, setBulkAsk] = useState(false);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState('');
  const seq = useRef(0);

  useEffect(() => { setPage(1); setSel(new Set()); }, [tab, f.level, f.department, f.recruiter, f.source, f.from, f.to, f.search]);
  useEffect(() => {
    seq.current += 1; const mine = seq.current;
    setLoading(true);
    const t = setTimeout(() => {
      api.get('/candidate-duplicates/worklist', { params: { tab, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), page, pageSize: 25 } })
        .then((r) => { if (mine === seq.current) { setData(r.data); setError(''); if (onCountChange) onCountChange(r.data); } })
        .catch((e) => { if (mine === seq.current) setError(err(e, 'Could not load the duplicates. Please try again.')); })
        .finally(() => { if (mine === seq.current) setLoading(false); });
    }, f.search ? 300 : 0);
    return () => clearTimeout(t);
  }, [tab, f, page, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = () => setTick((n) => n + 1);
  const rows = (data && data.rows) || [];
  const viewer = (data && data.viewer) || {};
  const setFilter = (p) => setF((x) => ({ ...x, ...p }));
  const toggle = (id, on) => setSel((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const tabs = ((data && data.tabs) || [{ key: 'must', label: 'Must sort out' }]).map((t) => ({ ...t, hint: t.key === 'must' ? 'Looks like the same person, and still at the first step' : t.key === 'requests' ? 'A recruiter asked for a merge and the TL has not answered' : t.key === 'maybe' ? 'Same name and city, college or company — a warning only, nothing is held' : t.key === 'older' ? 'Duplicates of people who are already past the first step' : 'Already sorted out' }));
  const canBulkNot = rows.some((r) => sel.has(r.flag.id) && r.caps.canResolve);
  const canBulkMerge = rows.some((r) => sel.has(r.flag.id) && r.caps.canMerge);
  const canBulkAsk = rows.some((r) => sel.has(r.flag.id) && r.caps.canRequestMerge);

  async function bulk(action) {
    setMsg('');
    try {
      const r = await api.post('/candidate-duplicates/bulk', { action, flagIds: [...sel], reason });
      setMsg(r.data.message); setSel(new Set()); setBulkAsk(false); setReason(''); reload();
    } catch (e) { setMsg(err(e, 'Could not do this.')); }
  }

  return (
    <div className="dupx-list">
      <div className="small-muted" style={{ marginBottom: 8 }}>
        These people look like someone already on file. Each one stays at the first step until you merge them, say they are different people, or reject them.
      </div>
      <StatusTabs label="Duplicates" className="dupx-tabs" tabs={tabs} value={tab} onChange={setTab} />
      <div className="dupx-filters">
        <input type="search" aria-label="Search" placeholder="Search a name or phone" value={f.search} onChange={(e) => setFilter({ search: e.target.value })} style={{ minWidth: 200 }} />
        {data && <Facet label="How sure" value={f.level} onChange={(v) => setFilter({ level: v })} options={data.facets.level} allLabel="How sure: any" />}
        {data && <Facet label="Department" value={f.department} onChange={(v) => setFilter({ department: v })} options={data.facets.department} allLabel="All departments" />}
        {data && <Facet label="Recruiter" value={f.recruiter} onChange={(v) => setFilter({ recruiter: v })} options={data.facets.recruiter} allLabel="All recruiters" />}
        {data && <Facet label="Where from" value={f.source} onChange={(v) => setFilter({ source: v })} options={data.facets.source} allLabel="Where from: any" />}
        <label className="small-muted">From <input type="date" value={f.from} onChange={(e) => setFilter({ from: e.target.value })} /></label>
        <label className="small-muted">To <input type="date" value={f.to} onChange={(e) => setFilter({ to: e.target.value })} /></label>
        {Object.values(f).some(Boolean) && <button type="button" className="btn btn-sm" onClick={() => setF({ level: '', department: '', recruiter: '', source: '', from: '', to: '', search: '' })}>Clear filters</button>}
      </div>

      {data && data.supported === false && <div className="dupx-empty">Duplicate checking is not switched on yet.</div>}
      {data && data.supported && !data.backfilled && tab === 'must' && (
        <div className="notice amber" style={{ marginBottom: 10 }}>
          Profiles added before today have not been checked yet. New people are checked as they come in. Ask your admin to run the one-time check.
        </div>
      )}
      {data && data.supported && data.gate === false && <div className="notice amber" style={{ marginBottom: 10 }}>The first-step hold is switched off. Duplicates are still found, but nobody is stopped.</div>}

      {sel.size > 0 && (
        <div className="dupx-bulk" role="region" aria-label="Selected">
          <b>{`${sel.size} selected`}</b>
          {canBulkNot && <button type="button" className="btn btn-sm" onClick={() => setBulkAsk((v) => !v)}>Not duplicates</button>}
          {canBulkMerge && <button type="button" className="btn btn-sm btn-primary" onClick={() => bulk('merge')}>Merge</button>}
          {!canBulkMerge && canBulkAsk && <button type="button" className="btn btn-sm btn-primary" onClick={() => bulk('request-merge')}>Ask TL to merge</button>}
          <button type="button" className="btn btn-sm" onClick={() => setSel(new Set())}>Clear</button>
          {bulkAsk && (
            <span className="dupx-ask-row" style={{ flex: '1 1 100%' }}>
              <input value={reason} maxLength={300} placeholder="Why are they different people? (one reason for all)" onChange={(e) => setReason(e.target.value)} style={{ flex: '1 1 240px' }} />
              <button type="button" className="btn btn-sm btn-primary" disabled={reason.trim().length < 3} onClick={() => bulk('not-duplicate')}>Save</button>
            </span>
          )}
        </div>
      )}
      {msg && <div className="notice" style={{ marginBottom: 10 }}>{msg}</div>}
      {error && <div className="error-text">{error}</div>}
      {loading && !data && <div className="small-muted">Loading…</div>}

      {data && data.supported && rows.length === 0 && !loading && (
        <div className="dupx-empty">
          <b>{tab === 'must' ? 'Nothing waiting. Everyone at the first step is clear.' : 'Nothing here.'}</b>
          {tab === 'must' ? 'New duplicates show up here as soon as someone is added.' : 'Try another tab or clear the filters.'}
        </div>
      )}
      {rows.map((it) => (
        <DupPairCard key={it.flag.id} item={{ ...it, role: 'new' }} selectable selected={sel.has(it.flag.id)} onSelect={(on) => toggle(it.flag.id, on)} onChanged={() => { reload(); }} />
      ))}
      {data && data.pages > 1 && (
        <div className="dupx-pager">
          <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Back</button>
          <span className="small-muted">{`Page ${data.page} of ${data.pages} · ${data.total} in this list`}</span>
          <button type="button" className="btn btn-sm" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      )}

      {(viewer.lead || viewer.global) && tab === 'must' && <Obvious onChanged={reload} />}
      <RecentMerges refreshKey={tick} onChanged={reload} />
      {viewer.global && (
        <div className="small-muted" style={{ marginTop: 14 }}>
          <Link to="/candidates/duplicates">Whole-database group review (older screen) →</Link>
        </div>
      )}
    </div>
  );
}
