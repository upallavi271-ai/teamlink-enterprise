import { useCallback, useEffect, useState } from 'react';
import api from '../../api';

// ---------------------------------------------------------------------------
// POSITIONS inside one requirement (audit 114): e.g. 2 Assistant Professors + 1 Lab Assistant. Each has a title, a count and a CTC range, and
// tracks the people placed against it and how many joined. The requirement's headcount stays the total. Backend: routes/clientDepth.js.
// ---------------------------------------------------------------------------
const err = (e, f) => e?.response?.data?.error || f;
const inr = (n) => (n == null ? '' : `₹${Math.round(n).toLocaleString('en-IN')}`);

export default function RequirementPositions({ requirementId, onChanged }) {
  const [data, setData] = useState(null);
  const [rows, setRows] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get(`/ats-clients/requirements/${requirementId}/positions`).then((r) => { setData(r.data); setRows(null); }).catch(() => setData(null)), [requirementId]);
  useEffect(() => { load(); }, [load]);
  if (!data) return null;
  if (!data.positions.length && !data.canEdit) return null;
  async function save() {
    setBusy(true); setMsg('');
    try { await api.put(`/ats-clients/requirements/${requirementId}/positions`, { positions: rows.map((p) => ({ id: p.id, title: p.title, count: Number(p.count), ctcMin: p.ctcMin === '' ? null : p.ctcMin, ctcMax: p.ctcMax === '' ? null : p.ctcMax })) }); await load(); if (onChanged) onChanged(); setMsg('Saved. The headcount is now the total of the positions.'); } catch (e) { setMsg(err(e, 'Could not save the positions.')); } finally { setBusy(false); }
  }
  const editing = rows !== null;
  const list = editing ? rows : data.positions;
  const set = (i, patch) => setRows((r) => r.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <div className="card section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ fontSize: 13, marginBottom: 8 }}>Positions{data.positions.length ? ` (${data.positions.length}) · headcount ${data.total}` : ''}</h3>
        {data.canEdit && !editing && <button type="button" className="btn btn-sm" onClick={() => setRows(data.positions.length ? data.positions.map((p) => ({ ...p, ctcMin: p.ctcMin ?? '', ctcMax: p.ctcMax ?? '' })) : [{ title: '', count: 1, ctcMin: '', ctcMax: '' }])}>{data.positions.length ? 'Edit positions' : 'Add positions'}</button>}
      </div>
      {!list.length && <div className="small-muted">One position. Add positions when this requirement is for different roles.</div>}
      {list.map((p, i) => (editing ? (
        <div key={p.id || i} style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
          <input placeholder="Position title" value={p.title} aria-label="Position title" onChange={(e) => set(i, { title: e.target.value })} />
          <input type="number" min="1" style={{ width: 80 }} aria-label="Count" value={p.count} onChange={(e) => set(i, { count: e.target.value })} />
          <input type="number" min="0" style={{ width: 120 }} placeholder="CTC from" aria-label="CTC from" value={p.ctcMin} onChange={(e) => set(i, { ctcMin: e.target.value })} />
          <input type="number" min="0" style={{ width: 120 }} placeholder="CTC to" aria-label="CTC to" value={p.ctcMax} onChange={(e) => set(i, { ctcMax: e.target.value })} />
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRows((r) => r.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ) : (
        <div key={p.id} style={{ display: 'flex', gap: 12, padding: '3px 0', flexWrap: 'wrap' }}>
          <b>{p.title}</b><span>{p.count} needed</span>
          {(p.ctcMin != null || p.ctcMax != null) && <span className="small-muted">{inr(p.ctcMin)} – {inr(p.ctcMax)}</span>}
          <span className="small-muted">{p.candidates} in process · {p.selected} selected · {p.joined} joined · {p.open} open</span>
        </div>
      )))}
      {editing && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-sm" onClick={() => setRows((r) => [...r, { title: '', count: 1, ctcMin: '', ctcMax: '' }])}>+ Add a position</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save positions'}</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRows(null)}>Cancel</button>
        </div>
      )}
      {msg && <div className="small-muted" role="status">{msg}</div>}
    </div>
  );
}
