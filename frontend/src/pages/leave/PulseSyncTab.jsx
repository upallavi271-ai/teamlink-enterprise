import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { Panel, PanelHead, EmptyMini } from '../../components/proto.jsx';
import './LeaveExtras.css';
import Combo from '../../components/Combo.jsx';

// ---------------------------------------------------------------------------
// LEAVE > SYNC WITH PULSE (HRMS item 8). Pulse HRMS publishes no API we can call, so HR uploads Pulse's own
// "Leave History" export (xlsx / csv). 1) Check the file, 2) Apply, 3) result + CSV + Undo.
// Under it: "Old pending" - pending requests that are not genuine (the person left, a duplicate, dates long
// past), so Pending Approvals stays honest. Everything is decided on the server (routes/leavePulse.js).
// ---------------------------------------------------------------------------
const GROUPS = [
  ['update', 'Updated', 'green', 'Pulse already decided these. TeamLink will follow Pulse.'],
  ['create', 'Created', 'blue', 'In Pulse but not in TeamLink. They will be added (nobody is notified).'],
  ['unchanged', 'Unchanged', 'grey', 'Already the same on both sides.'],
  ['skipped', 'Skipped', 'orange', 'Left alone. The reason is written beside each one.'],
];
const fmt = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

function saveBlob(res, name) {
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function Tile({ tone, n, label }) {
  return <div className={`pls-tile pls-${tone}`}><div className="pls-n">{n}</div><div>{label}</div></div>;
}

function ResultTable({ rows }) {
  if (!rows.length) return <EmptyMini>Nothing here.</EmptyMini>;
  return (
    <div className="tbl-wrap lvx-table" style={{ maxHeight: 320, overflow: 'auto' }}>
      <table>
        <thead><tr><th>Row</th><th>Employee</th><th>Leave</th><th>Dates</th><th>Pulse says</th><th>Why</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.row}-${i}`}>
              <td className="lvx-muted">{r.row}</td>
              <td>{r.name || '-'}<div className="lvx-muted">{r.code}</div></td>
              <td className="lvx-muted">{r.type}</td>
              <td className="lvx-muted" style={{ whiteSpace: 'nowrap' }}>{fmt(r.from)}{r.to && r.to !== r.from ? ` - ${fmt(r.to)}` : ''}</td>
              <td className="lvx-muted">{r.pulseStatus}</td>
              <td className="lvx-muted">{r.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OnlyHere({ rows }) {
  if (!rows?.length) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <b>Only in TeamLink ({rows.length})</b>
      <div className="lvx-muted">Pulse does not list these pending requests at all. Nothing was changed. HR decides.</div>
      <div className="tbl-wrap lvx-table" style={{ maxHeight: 240, overflow: 'auto' }}>
        <table>
          <thead><tr><th>Employee</th><th>Leave</th><th>Dates</th><th>Pending since</th></tr></thead>
          <tbody>{rows.map((o) => <tr key={o.leaveId}><td>{o.name}<div className="lvx-muted">{o.code}</div></td><td className="lvx-muted">{o.type}</td><td className="lvx-muted">{fmt(o.from)}{o.to !== o.from ? ` - ${fmt(o.to)}` : ''}</td><td className="lvx-muted">{fmt(o.appliedOn)}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

function OldPending({ onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [reason, setReason] = useState('');
  const [picked, setPicked] = useState({});
  const [kind, setKind] = useState('');
  const [staleDays, setStaleDays] = useState('');
  const [busy, setBusy] = useState(false);
  function load() { api.get('/leave/pulse/old-pending').then((r) => { setData(r.data); setStaleDays(String(r.data.staleDays)); }).catch((e) => setError(e.response?.data?.error || 'Could not load the old requests.')); }
  useEffect(load, []);
  const rows = useMemo(() => (data?.rows || []).filter((r) => !kind || r.kind === kind), [data, kind]);
  const ids = Object.keys(picked).filter((k) => picked[k]);
  async function act(fn) {
    setError(''); setMsg('');
    if (!reason.trim()) { setError('Write a short reason first (it is saved with the change).'); return; }
    setBusy(true);
    try { const r = await fn(); setMsg(r); setPicked({}); load(); onChanged?.(); } catch (e) { setError(e.response?.data?.error || 'Could not do that.'); } finally { setBusy(false); }
  }
  const one = (id, action) => act(async () => { await api.post(`/leave/pulse/old-pending/${id}/close`, { action, reason: reason.trim() }); return action === 'approve' ? 'Approved (backdated).' : 'Closed as Rejected (old).'; });
  const many = () => act(async () => { const r = await api.post('/leave/pulse/old-pending/bulk-reject', { ids, reason: reason.trim() }); return `Closed ${r.data.closed} request(s) as Rejected${r.data.skipped ? `, ${r.data.skipped} skipped` : ''}.`; });
  async function saveDays() {
    setError(''); setMsg('');
    try { await api.put('/leave/pulse/settings', { staleDays: Number(staleDays) }); setMsg('Saved.'); load(); onChanged?.(); } catch (e) { setError(e.response?.data?.error || 'Could not save.'); }
  }
  if (!data) return <EmptyMini>{error || 'Loading...'}</EmptyMini>;
  const c = data.counts;
  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title="Old pending: decide or close" />
      <div style={{ padding: '8px 18px 14px' }}>
        <div className="lvx-muted" style={{ marginBottom: 8 }}>
          These are still Pending, but they are not counted in Pending Approvals: the person has left ({c.left}), it repeats another request ({c.duplicate}),
          or the dates are more than <input type="number" min="1" max="3650" value={staleDays} onChange={(e) => setStaleDays(e.target.value)} style={{ width: 70 }} /> days old ({c.old}).{' '}
          <button className="btn btn-sm" onClick={saveDays}>Save days</button>
        </div>
        <div className="pls-row">
          <label className="lvx-muted">Show <Combo className="combo-inline" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All ({data.rows.length})</option><option value="leaver">Person has left ({c.left})</option><option value="duplicate">Duplicates ({c.duplicate})</option><option value="old">Old dates ({c.old})</option></Combo></label>
          <input className="pls-reason" placeholder="Reason (needed for any change below)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="btn btn-sm btn-danger" disabled={busy || !ids.length} onClick={many}>Close {ids.length || ''} picked as Rejected</button>
        </div>
        {error && <div className="error-text">{error}</div>}
        {msg && <div className="pls-ok">{msg}</div>}
        {!rows.length ? <EmptyMini>No old pending requests. Pending Approvals is clean.</EmptyMini> : (
          <div className="tbl-wrap lvx-table" style={{ maxHeight: 420, overflow: 'auto' }}>
            <table>
              <thead><tr><th><input type="checkbox" aria-label="Pick all" style={{ width: 'auto' }} checked={ids.length === rows.length} onChange={(e) => setPicked(e.target.checked ? Object.fromEntries(rows.map((r) => [r.id, true])) : {})} /></th><th>Employee</th><th>Leave</th><th>Dates</th><th>Why it is here</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td><input type="checkbox" style={{ width: 'auto' }} checked={!!picked[r.id]} onChange={(e) => setPicked({ ...picked, [r.id]: e.target.checked })} aria-label={`Pick ${r.employee}`} /></td>
                    <td>{r.employee}<div className="lvx-muted">{r.code} - {r.employeeStatus}</div></td>
                    <td className="lvx-muted">{r.type}{r.halfDay ? ` (${r.halfDay})` : ''}</td>
                    <td className="lvx-muted" style={{ whiteSpace: 'nowrap' }}>{fmt(r.from)}{r.to !== r.from ? ` - ${fmt(r.to)}` : ''}<div>applied {fmt(r.appliedOn)}</div></td>
                    <td><span className="lvx-chip lvx-chip-grey">{r.why}</span></td>
                    <td><span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => one(r.id, 'reject')}>Close as Rejected</button>
                      {r.kind !== 'leaver' && <button className="btn btn-sm" disabled={busy} onClick={() => one(r.id, 'approve')}>Approve (backdated)</button>}
                    </span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Panel>
  );
}

export default function PulseSyncTab({ onChanged }) {
  const [status, setStatus] = useState(null);
  const [file, setFile] = useState(null);
  const [createNew, setCreateNew] = useState(true);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [show, setShow] = useState('update');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  function loadStatus() { api.get('/leave/pulse/status').then((r) => setStatus(r.data)).catch(() => setStatus(null)); }
  useEffect(loadStatus, []);
  const post = (path) => api.post(`${path}?create=${createNew ? 1 : 0}&createPending=${createNew ? 1 : 0}`, file, { headers: { 'Content-Type': 'application/octet-stream' }, transformRequest: [(d) => d] });

  async function check() {
    setError(''); setNote(''); setResult(null); setBusy('check');
    try { setPreview((await post('/leave/pulse/preview')).data); setShow('update'); } catch (e) { setPreview(null); setError(e.response?.data?.error || 'Could not read that file.'); } finally { setBusy(''); }
  }
  async function apply() {
    setError(''); setNote(''); setBusy('apply');
    try { const r = (await post('/leave/pulse/apply')).data; setResult(r); setPreview(null); setShow('update'); loadStatus(); onChanged?.(); } catch (e) { setError(e.response?.data?.error || 'Could not apply the sync.'); } finally { setBusy(''); }
  }
  async function csv(syncId) {
    try { saveBlob(await api.get(`/leave/pulse/result/${syncId}.csv`, { responseType: 'blob' }), 'pulse-sync-result.csv'); } catch { setError('Could not download the result.'); }
  }
  async function undo() {
    if (!window.confirm('Undo the last sync? Updated requests go back to Pending and created ones are removed.')) return;
    setError(''); setNote('');
    try { const r = (await api.post('/leave/pulse/undo')).data; setNote(`Undone: ${r.reverted} put back, ${r.removed} removed${r.kept ? `, ${r.kept} kept because they were changed since` : ''}.`); setResult(null); loadStatus(); onChanged?.(); } catch (e) { setError(e.response?.data?.error || 'Could not undo.'); }
  }

  const last = status?.last;
  const view = result || preview;
  const items = (view?.items || view?.results || []);
  const counts = view?.counts;
  const shown = items.filter((i) => i.action === show);
  const pend = status?.pending;
  return (
    <div>
      <Panel>
        <PanelHead title="Sync leave with Pulse HRMS" />
        <div style={{ padding: '8px 18px 14px' }}>
          <div className="pls-last">
            {last ? <>Last synced with Pulse: <b>{when(last.at)}</b> by <b>{last.by}</b>{last.undone ? ' (undone)' : ''}.</> : <>Not synced with Pulse yet.</>}
            {last?.undoable && <> <button className="btn btn-sm" onClick={undo}>Undo this sync</button></>}
          </div>
          <div className="lvx-muted" style={{ margin: '4px 0 10px' }}>
            Pulse HRMS does not give us a live connection, so the sync reads the <b>Leave History</b> file you download from Pulse (Excel or CSV).
            Decisions made in Pulse become decisions here. Nobody gets a message for each change: HR gets one summary.
          </div>
          {pend && <div className="pls-row" style={{ marginBottom: 8 }}>
            <span className="lvx-chip lvx-chip-warn">{pend.genuine} waiting for a decision</span>
            {pend.old + pend.left + pend.duplicate > 0 && <span className="lvx-chip lvx-chip-grey">{pend.old + pend.left + pend.duplicate} old or left out (see below)</span>}
          </div>}
          <div className="pls-row">
            <input type="file" accept=".xlsx,.xls,.csv" aria-label="Pulse Leave History file" onChange={(e) => { setFile(e.target.files?.[0] || null); setPreview(null); setResult(null); setError(''); }} />
            <label className="lvx-muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" style={{ width: 'auto' }} checked={createNew} onChange={(e) => setCreateNew(e.target.checked)} /> Add requests that are only in Pulse</label>
            {!preview && <button className="btn btn-primary" disabled={!file || busy === 'check'} onClick={check}>{busy === 'check' ? 'Reading...' : 'Check the file'}</button>}
            {preview && <button className="btn btn-primary" disabled={busy === 'apply' || (preview.counts.updated + preview.counts.created === 0)} onClick={apply}>{busy === 'apply' ? 'Working...' : `Apply: ${preview.counts.updated} update, ${preview.counts.created} add`}</button>}
          </div>
          {error && <div className="error-text" style={{ marginTop: 6 }}>{error}</div>}
          {note && <div className="pls-ok">{note}</div>}
          {counts && (
            <>
              <div className="pls-tiles" role="list" aria-label={result ? 'Result of the sync' : 'What will happen'}>
                <Tile tone="green" n={counts.updated} label="Updated" />
                <Tile tone="blue" n={counts.created} label="Created" />
                <Tile tone="grey" n={counts.unchanged} label="Unchanged" />
                <Tile tone="orange" n={counts.onlyInTeamLink} label="Only in TeamLink" />
                <Tile tone="red" n={counts.skipped} label="Skipped" />
              </div>
              <div className="lvx-muted">{result ? 'Done. This is what changed.' : 'Nothing has changed yet. This is what will happen when you press Apply.'}</div>
              <div className="pls-row" style={{ margin: '8px 0' }}>
                {GROUPS.map(([k, label]) => <button key={k} className={`btn btn-sm${show === k ? ' btn-primary' : ''}`} onClick={() => setShow(k)}>{label} ({counts[k === 'update' ? 'updated' : k === 'create' ? 'created' : k === 'unchanged' ? 'unchanged' : 'skipped']})</button>)}
                {result && <button className="btn btn-sm" onClick={() => csv(result.syncId)}>Download result (CSV)</button>}
              </div>
              <div className="lvx-muted" style={{ marginBottom: 4 }}>{GROUPS.find((g) => g[0] === show)?.[3]}</div>
              <ResultTable rows={shown} />
              <OnlyHere rows={view.only} />
            </>
          )}
        </div>
      </Panel>
      <OldPending onChanged={() => { loadStatus(); onChanged?.(); }} />
    </div>
  );
}
