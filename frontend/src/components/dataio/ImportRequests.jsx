// ---------------------------------------------------------------------------
// Import requests — the Super Admin's approval queue for imports sent by roles
// that cannot import directly (backend routes/dataIo.js /requests).
//
//   Super Admin: every request, Pending first, with the dry-run preview
//                (what each row would create / change) and Approve / Reject.
//   Everyone else: their own requests and what became of them.
// Nothing is applied until a Super Admin approves; approving re-checks every
// row before writing it.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import './DataIoBar.css';

const fmt = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

export default function ImportRequests({ ioKey, onChanged }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null); // full request
  const [busy, setBusy] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [showAll, setShowAll] = useState(false);

  function load() {
    api.get('/io/requests', { params: ioKey ? { key: ioKey } : {} })
      .then((r) => setData(r.data)).catch(() => setData(null));
  }
  useEffect(load, [ioKey]);

  async function view(id) {
    setError(''); setReason('');
    try { setOpen((await api.get(`/io/requests/${id}`)).data); } catch (err) { setError(err.response?.data?.error || 'Could not open the request.'); }
  }
  async function decide(kind) {
    setError(''); setBusy(kind);
    try {
      const res = kind === 'approve'
        ? await api.post(`/io/requests/${open.id}/approve`, {})
        : await api.post(`/io/requests/${open.id}/reject`, { reason });
      const r = res.data.result;
      setMsg(kind === 'approve'
        ? `Approved — created ${r?.created || 0}, updated ${r?.updated || 0}${r?.failed?.length ? `, ${r.failed.length} row(s) failed` : ''}.`
        : 'Rejected — the requester has been told why.');
      setOpen(null); load(); if (onChanged) onChanged();
    } catch (err) {
      setError(err.response?.data?.error || 'That decision could not be saved.');
    } finally { setBusy(''); }
  }

  if (!data || !data.requests || !data.requests.length) return msg ? <div className="notice">{msg}</div> : null;
  const sa = !!data.superAdmin;
  const pending = data.requests.filter((r) => r.status === 'Pending');
  const list = showAll ? data.requests : (sa ? pending : data.requests.slice(0, 5));
  if (!list.length && !msg) return null;

  return (
    <div className="card section dio-requests">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <h3 style={{ fontSize: 13, margin: 0 }}>
          {sa ? `Import requests waiting for you (${pending.length})` : 'Your import requests'}
        </h3>
        <button type="button" className="btn btn-sm" onClick={() => setShowAll((s) => !s)}>{showAll ? 'Show fewer' : 'Show all'}</button>
      </div>
      {msg && <div className="notice" style={{ marginBottom: 8 }}>{msg}</div>}
      <table className="table">
        <thead><tr><th>Requested</th><th>By</th><th>File</th><th>Rows</th><th>Status</th><th /></tr></thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.id}>
              <td>{fmt(r.requestedAt)}</td>
              <td>{r.requestedBy}</td>
              <td>{r.fileName}</td>
              <td className="small-muted">{r.counts ? `${r.counts.create} new · ${r.counts.update} update` : '—'}</td>
              <td>
                <span className={`dio-act ${r.status === 'Approved' ? 'a-create' : r.status === 'Rejected' ? 'a-error' : 'a-update'}`}>{r.status}</span>
                {r.decidedBy && <div className="small-muted">{r.decidedBy} · {fmt(r.decidedAt)}</div>}
                {r.status === 'Rejected' && r.note && <div className="small-muted">“{r.note}”</div>}
              </td>
              <td><button type="button" className="btn btn-sm" onClick={() => view(r.id)}>{sa && r.status === 'Pending' ? 'Review' : 'View'}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {open && (
        <Modal
          title={`Import request — ${open.module || ''} · ${open.fileName}`}
          size="wide"
          onClose={() => setOpen(null)}
          foot={sa && open.status === 'Pending' ? (
            <>
              <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => decide('approve')}>{busy === 'approve' ? 'Applying…' : 'Approve & apply'}</button>
              <input placeholder="Reason (required to reject)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ minWidth: 240 }} />
              <button type="button" className="btn" disabled={!!busy || !reason.trim()} onClick={() => decide('reject')}>{busy === 'reject' ? 'Rejecting…' : 'Reject'}</button>
              <button type="button" className="btn" onClick={() => setOpen(null)}>Close</button>
            </>
          ) : <button type="button" className="btn" onClick={() => setOpen(null)}>Close</button>}
        >
          <div className="small-muted" style={{ marginBottom: 8 }}>
            Requested by <b>{open.requestedBy}</b> on {fmt(open.requestedAt)}{open.note ? ` — “${open.note}”` : ''}.
            {open.status === 'Pending' ? ' Approving re-checks every row and writes only the rows that still pass; every changed field is audited.' : ` ${open.status}${open.decidedBy ? ` by ${open.decidedBy}` : ''}.`}
          </div>
          {error && <div className="error-text">{error}</div>}
          {open.result && (
            <div className="notice" style={{ marginBottom: 8 }}>
              Result: created {open.result.created || 0}, updated {open.result.updated || 0}{open.result.failed?.length ? `, ${open.result.failed.length} failed` : ''}.
            </div>
          )}
          {open.preview && (
            <div className="dio-table">
              <table className="table">
                <thead><tr><th>Row</th><th>Record</th><th>Action</th><th>Changes</th></tr></thead>
                <tbody>
                  {(open.preview.rows || []).filter((r) => r.action === 'create' || r.action === 'update').map((r) => (
                    <tr key={r.line}>
                      <td>{r.line}</td>
                      <td>{r.label}</td>
                      <td><span className={`dio-act a-${r.action}`}>{r.action}</span></td>
                      <td className="small-muted">{(r.changes || []).map((c) => `${c.field}: ${c.from === '' || c.from == null ? '∅' : c.from} → ${c.to}`).join(' · ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
