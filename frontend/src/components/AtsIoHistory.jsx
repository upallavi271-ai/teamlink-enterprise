// ---------------------------------------------------------------------------
// The History button (spec 2026-10-03 §B; "Approvals & history" for approvers):
//   Imports   every import batch of the last 7 days; "Undo import" within 24 h
//             (refused by the server when a record changed since)
//   Requests  import requests (BDE → Admin / Manager approves); approvers
//             approve or reject here, requesters see where theirs stand
//   Exports   big exports prepared in the background — download here
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../api';
import { Modal } from './proto.jsx';

const when = (v) => (v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

function saveBlob(res, fallback) {
  const cd = res.headers?.['content-disposition'] || '';
  const m = /filename="?([^";]+)"?/.exec(cd);
  const href = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = href; a.download = (m && m[1]) || fallback; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(href), 2000);
}

export default function AtsIoHistory({ approver = false, onClose, onChanged }) {
  const [tab, setTab] = useState('imports');
  const [data, setData] = useState({ batches: null, requests: null, exports: null });
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState('');

  function load() {
    Promise.all([
      api.get('/ats-io/import/batches').then((r) => r.data.batches).catch(() => []),
      api.get('/ats-io/import/requests').then((r) => r.data.requests).catch(() => []),
      api.get('/ats-io/export-files').then((r) => r.data.exports).catch(() => []),
    ]).then(([batches, requests, exports]) => setData({ batches, requests, exports }));
  }
  useEffect(load, []);

  async function act(key, fn, okText) {
    setBusy(key); setMsg(null);
    try { const r = await fn(); setMsg({ ok: true, text: okText(r) }); load(); if (onChanged) onChanged(); } catch (e) {
      const d = e.response?.data || {};
      setMsg({ ok: false, text: `${d.error || 'That did not work.'}${d.changed ? ` (${d.changed.slice(0, 3).map((c) => `${c.name || c.model}: ${c.why}`).join('; ')})` : ''}` });
    } finally { setBusy(''); }
  }
  const undo = (b) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Undo the import "${b.label}" (${b.records} record(s))? Created records are removed and updated ones go back to how they were.`)) return;
    act(`u-${b.id}`, () => api.post(`/ats-io/import/batches/${b.id}/undo`), (r) => r.data.message);
  };
  const approve = (q) => act(`a-${q.id}`, () => api.post(`/ats-io/import/requests/${q.id}/approve`, {}), (r) => `Approved — ${r.data.totals.create} created, ${r.data.totals.update} updated.`);
  const reject = (q) => {
    // eslint-disable-next-line no-alert
    const reason = window.prompt('Why is this import rejected? (the requester is told)');
    if (!reason) return;
    act(`r-${q.id}`, () => api.post(`/ats-io/import/requests/${q.id}/reject`, { reason }), () => 'Rejected — the requester is told.');
  };
  const download = (x) => act(`x-${x.id}`, async () => saveBlob(await api.get(`/ats-io/export-files/${x.id}`, { responseType: 'blob' }), x.filename), () => `Downloaded ${x.filename}.`);

  const pending = (data.requests || []).filter((q) => q.status === 'Pending').length;
  const TABS = [['imports', 'Imports'], ['requests', `Requests${pending ? ` (${pending})` : ''}`], ['exports', 'Big exports']];

  return (
    <Modal wide title={approver ? 'Imports, approvals & exports' : 'My imports & exports'} onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      <div className="atsio-dlg atsio-hist">
        <div className="tabs" role="tablist" style={{ marginBottom: 10 }}>
          {TABS.map(([k, l]) => <div key={k} role="tab" tabIndex={0} aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)} onKeyDown={(e) => { if (e.key === 'Enter') setTab(k); }}>{l}</div>)}
        </div>
        {msg && <div className={`notice ${msg.ok ? '' : 'red'}`} style={{ marginBottom: 8 }}><span>{msg.text}</span></div>}

        {tab === 'imports' && (data.batches === null ? <div className="small-muted">Loading…</div> : data.batches.length === 0
          ? <div className="small-muted">No imports in the last 7 days.</div> : (
            <div className="tbl-wrap"><table>
              <thead><tr><th>When</th><th>What</th><th>By</th><th>Records</th><th /></tr></thead>
              <tbody>
                {data.batches.map((b) => (
                  <tr key={b.id}>
                    <td>{when(b.at)}<div className="small-muted" style={{ fontSize: 11 }}>{b.id}</div></td>
                    <td>{b.label}<div className="small-muted" style={{ fontSize: 11 }}>{b.file}</div></td>
                    <td>{b.by}</td>
                    <td>{`${b.created} new · ${b.updated} updated`}</td>
                    <td>
                      {b.undone ? <span className="small-muted">{`Undone ${when(b.undoneAt)}`}</span>
                        : b.canUndo ? <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => undo(b)}>Undo import</button>
                          : <span className="small-muted">Undo period over</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          ))}

        {tab === 'requests' && (data.requests === null ? <div className="small-muted">Loading…</div> : data.requests.length === 0
          ? <div className="small-muted">{approver ? 'No import requests.' : 'You have not sent any import for approval.'}</div> : (
            <div className="tbl-wrap"><table>
              <thead><tr><th>When</th><th>What</th><th>From</th><th>Rows</th><th>Status</th><th /></tr></thead>
              <tbody>
                {data.requests.map((q) => (
                  <tr key={q.id}>
                    <td>{when(q.requestedAt)}</td>
                    <td>{q.label}<div className="small-muted" style={{ fontSize: 11 }}>{q.file}</div></td>
                    <td>{q.requestedBy}</td>
                    <td>{q.totals ? `${q.totals.valid} valid · ${q.totals.duplicate || 0} duplicates` : ''}</td>
                    <td>{q.status}{q.decidedBy ? <div className="small-muted" style={{ fontSize: 11 }}>{`${q.decidedBy}${q.note && q.status === 'Rejected' ? ` — ${q.note}` : ''}`}</div> : null}</td>
                    <td>
                      {approver && q.status === 'Pending' && (
                        <span style={{ display: 'inline-flex', gap: 6 }}>
                          <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => approve(q)}>Approve</button>
                          <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => reject(q)}>Reject</button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          ))}

        {tab === 'exports' && (data.exports === null ? <div className="small-muted">Loading…</div> : data.exports.length === 0
          ? <div className="small-muted">Exports over 10,000 rows are prepared in the background and appear here (kept 7 days).</div> : (
            <div className="tbl-wrap"><table>
              <thead><tr><th>When</th><th>Export</th><th>Rows</th><th>Status</th><th /></tr></thead>
              <tbody>
                {data.exports.map((x) => (
                  <tr key={x.id}>
                    <td>{when(x.at)}</td>
                    <td>{x.title}<div className="small-muted" style={{ fontSize: 11 }}>{x.filename}</div></td>
                    <td>{Number(x.rows || 0).toLocaleString('en-IN')}</td>
                    <td>{x.status === 'ready' ? 'Ready' : x.status === 'failed' ? 'Failed' : 'Preparing…'}</td>
                    <td>{x.status === 'ready' && <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => download(x)}>Download</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          ))}
      </div>
    </Modal>
  );
}
