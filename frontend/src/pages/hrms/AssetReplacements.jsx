import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';

// REPLACEMENT REQUESTS (Assets Vendor Portal Stage C, 28 Oct 2026; backend utils/assetRepairWork.js).
// A repair vendor says an asset cannot be repaired, or an employee's "Replacement" ticket was approved. HR / Admin:
//   Requested -> Approve (optional approval reference) or Reject (reason)
//   Approved  -> Record the new asset (its asset code) + what happens to the old one -> Completed
// The old asset is never deleted and keeps its asset code. Every step is in both assets' history and the audit trail.
const TONE = { Requested: 'pending', Approved: 'active', Completed: 'active', Rejected: 'rejected' };
const day = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('-') : '-');

export default function AssetReplacements({ canEdit, assetId = null, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [act, setAct] = useState(null); // { kind: 'approve' | 'reject' | 'complete', row }
  const load = () => api.get('/asset-inventory/replacements').then((r) => { setData(r.data); setError(''); }).catch((e) => setError(e.response?.data?.error || 'Could not load the replacement requests.'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = (data?.rows || []).filter((r) => (assetId ? r.originalAssetId === assetId : ['Requested', 'Approved'].includes(r.status)));
  if (!data && !error) return null;
  if (!assetId && !rows.length && !error) return null; // nothing waiting: the panel stays out of the way
  return (
    <div className="panel" style={{ marginBottom: 12, padding: 12 }}>
      <h3 style={{ fontSize: 14, margin: '0 0 8px' }}>{assetId ? 'Replacements of this asset' : `Replacement requests waiting (${rows.length})`}</h3>
      {error && <div className="notice red"><span>{error}</span></div>}
      {msg && <div className="notice green"><span>{msg}</span></div>}
      {!rows.length ? <div className="cell-muted">No replacement for this asset.</div> : (
        <div className="tbl-wrap"><table>
          <thead><tr><th>Asset</th><th>Why</th><th>Asked by</th><th>Status</th><th>New asset</th><th /></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}>
              <td><b>{r.originalAssetCode}</b>{r.originalAssetName ? <div className="cell-muted">{r.originalAssetName}</div> : null}{r.repairNo ? <div className="cell-muted">Repair {r.repairNo}</div> : null}</td>
              <td style={{ whiteSpace: 'normal', minWidth: 180 }}>{r.reason || '-'}{r.ticketRef ? <div className="cell-muted">Ticket {r.ticketRef}</div> : null}</td>
              <td>{r.requestedBy || '-'}<div className="cell-muted">{day(r.requestedAt)}</div></td>
              <td><span className={`status ${TONE[r.status] || ''}`}>{r.status}</span>{r.decidedBy ? <div className="cell-muted">{r.decidedBy} · {day(r.decidedAt)}</div> : null}{r.decisionNote ? <div className="cell-muted">{r.decisionNote}</div> : null}</td>
              <td>{r.replacementAssetCode ? <>{r.replacementAssetCode}<div className="cell-muted">{day(r.replacementDate)} · old: {r.originalFinalStatus}</div></> : '-'}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {canEdit && r.status === 'Requested' && <><button type="button" className="btn btn-sm btn-primary" onClick={() => setAct({ kind: 'approve', row: r })}>Approve</button> <button type="button" className="btn btn-sm" onClick={() => setAct({ kind: 'reject', row: r })}>Reject</button></>}
                {canEdit && r.status === 'Approved' && <button type="button" className="btn btn-sm btn-primary" onClick={() => setAct({ kind: 'complete', row: r })}>Record the new asset</button>}
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {act && <ActModal act={act} finalStatuses={data?.finalStatuses || []} onClose={() => setAct(null)} onDone={(m) => { setAct(null); setMsg(m); load(); if (onChanged) onChanged(); }} />}
    </div>
  );
}

function ActModal({ act, finalStatuses, onClose, onDone }) {
  const { kind, row } = act;
  const [f, setF] = useState({ note: '', approvalRef: '', replacementAssetId: '', replacementDate: new Date().toISOString().slice(0, 10), originalFinalStatus: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  async function save() {
    setBusy(true); setError('');
    try {
      const r = kind === 'complete'
        ? await api.post(`/asset-inventory/replacements/${row.id}/complete`, { replacementAssetId: f.replacementAssetId.trim(), replacementDate: f.replacementDate, originalFinalStatus: f.originalFinalStatus })
        : await api.post(`/asset-inventory/replacements/${row.id}/decide`, { approve: kind === 'approve', note: f.note.trim(), approvalRef: f.approvalRef.trim() });
      onDone(r.data.message || 'Saved.');
    } catch (e) { setError(e.response?.data?.error || 'Could not save.'); } finally { setBusy(false); }
  }
  const title = kind === 'approve' ? `Approve the replacement of ${row.originalAssetCode}` : kind === 'reject' ? `Reject the replacement of ${row.originalAssetCode}` : `Record the new asset for ${row.originalAssetCode}`;
  return (
    <Modal title={title} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving...' : 'Save'}</button></>}>
      {error && <div className="notice red" style={{ marginBottom: 8 }}><span>{error}</span></div>}
      {kind !== 'complete' ? (
        <>
          {kind === 'approve' && <label style={{ display: 'block', marginBottom: 8 }}>Approval reference (optional)<input type="text" maxLength={80} value={f.approvalRef} onChange={set('approvalRef')} placeholder="for example the mail or note number" style={{ width: '100%' }} /></label>}
          <label style={{ display: 'block' }}>{kind === 'reject' ? 'Why not?' : 'Note (optional)'}<textarea rows={3} maxLength={500} value={f.note} onChange={set('note')} style={{ width: '100%' }} /></label>
        </>
      ) : (
        <>
          <label style={{ display: 'block', marginBottom: 8 }}>New asset code<input type="text" value={f.replacementAssetId} onChange={set('replacementAssetId')} placeholder="Add the new asset in Assets first, then type its code" style={{ width: '100%' }} /></label>
          <label style={{ display: 'block', marginBottom: 8 }}>Replaced on<input type="date" value={f.replacementDate} onChange={set('replacementDate')} /></label>
          <label style={{ display: 'block' }}>What happens to the old asset?
            <div className="vm-row" role="radiogroup" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
              {finalStatuses.map((st) => <button type="button" key={st} role="radio" aria-checked={f.originalFinalStatus === st} className={`btn btn-sm${f.originalFinalStatus === st ? ' btn-primary' : ''}`} onClick={() => setF((x) => ({ ...x, originalFinalStatus: st }))}>{st}</button>)}
            </div>
          </label>
          <p className="cell-muted">The old asset is kept with its code and history; it is never deleted.</p>
        </>
      )}
    </Modal>
  );
}
