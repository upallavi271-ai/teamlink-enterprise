// ---------------------------------------------------------------------------
// THE CTC BANDS OF A SLAB FEE (founder ATS audit 2026-11-17). On the client form, when the fee type is "Slab":
// rows of "CTC up to ₹ ... -> fee %", the last band open ("and above"). Saved straight away with its own button
// (PUT /api/ats/fee-slabs/:clientId, Commercial Terms edit, audited). A new client is saved first, then the bands are set.
// The joining invoice picks the band from the person's CTC (utils/atsFlowConfig.js feeFor).
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../../api';

const EMPTY = [{ upTo: '500000', percent: '6' }, { upTo: '1000000', percent: '8.33' }, { upTo: '', percent: '10' }];

export default function FeeSlabs({ clientId, disabled = false }) {
  const [rows, setRows] = useState(EMPTY);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!clientId) return;
    api.get(`/ats/fee-slabs/${clientId}`).then((r) => {
      const list = (r.data && r.data.slabs) || [];
      if (list.length) setRows(list.map((s) => ({ upTo: s.upTo == null ? '' : String(s.upTo), percent: String(s.percent) })));
    }).catch(() => null);
  }, [clientId]);
  if (!clientId) return <div className="small-muted">Save the client first, then set the CTC bands here.</div>;
  const setRow = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  async function save() {
    setBusy(true); setMsg(null);
    try {
      const r = await api.put(`/ats/fee-slabs/${clientId}`, { slabs: rows.map((x) => ({ upTo: x.upTo === '' ? null : Number(x.upTo), percent: Number(x.percent) })) });
      setMsg({ ok: true, text: `Saved: ${r.data.text}` });
    } catch (e) { setMsg({ ok: false, text: (e.response && e.response.data && e.response.data.error) || 'Could not save the bands.' }); } finally { setBusy(false); }
  }
  return (
    <div>
      {rows.map((r, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
          <span className="small-muted" style={{ minWidth: 70 }}>{i === rows.length - 1 && r.upTo === '' ? 'Above' : 'CTC up to ₹'}</span>
          <input type="number" min="0" step="1000" value={r.upTo} disabled={disabled} placeholder="blank = and above" onChange={(e) => setRow(i, 'upTo', e.target.value)} style={{ width: 140 }} aria-label={`Band ${i + 1}: CTC up to`} />
          <span>→</span>
          <input type="number" min="0" max="50" step="0.01" value={r.percent} disabled={disabled} onChange={(e) => setRow(i, 'percent', e.target.value)} style={{ width: 80 }} aria-label={`Band ${i + 1}: fee %`} />
          <span>%</span>
          {rows.length > 1 && !disabled && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>}
        </div>
      ))}
      {!disabled && (
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <button type="button" className="btn btn-sm" onClick={() => setRows([...rows.slice(0, -1), { upTo: '', percent: '' }, rows[rows.length - 1]])}>+ Band</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save bands'}</button>
        </div>
      )}
      {msg && <div className={msg.ok ? 'small-muted' : 'error-text'} style={{ marginTop: 4 }}>{msg.text}</div>}
    </div>
  );
}
