import { useCallback, useEffect, useState } from 'react';
import vendorApi, { vendorError } from '../../vendorApi';
import VendorShell, { useVendorMe } from './VendorShell.jsx';
import './vendorModules.css';

// /vendor/m/sim_connections - SIM and Connections (2026-10-14). The company's numbers (number, SIM serial, plan, who
// holds it) and its requests (new connection, replacement SIM, port-out, plan change). The vendor marks a SIM Active /
// Suspended / Disconnected (recorded, the company is told) and moves each request forward with a note.
const two = (n) => String(n).padStart(2, '0');
const day = (s) => { if (!s) return '—'; const d = new Date(s); return Number.isNaN(d.getTime()) ? '—' : `${two(d.getDate())}-${two(d.getMonth() + 1)}-${d.getFullYear()}`; };
const SIM_TONE = { Active: 'green', Suspended: 'yellow', Disconnected: 'grey' };
const REQ_TONE = { Open: 'yellow', 'In progress': 'blue', Done: 'green', Rejected: 'red' };
const KIND = { new: 'New connection', replacement: 'Replacement SIM', port_out: 'Port-out', plan_change: 'Plan change' };

export default function VendorSim() {
  return (
    <VendorShell moduleKey="sim_connections" title="SIM and connections" sub="The company's numbers and the requests it has sent you.">
      <Body />
    </VendorShell>
  );
}

function Body() {
  const me = useVendorMe();
  const readOnly = !!me.preview;
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState('');
  const [notes, setNotes] = useState({});
  const [q, setQ] = useState('');
  const load = useCallback(() => {
    vendorApi.get('/sim').then((r) => { setD(r.data); setError(''); }).catch((e) => setError(vendorError(e, 'Could not load the numbers.')));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(''), 4000); return () => clearTimeout(t); }, [toast]);

  async function setStatus(s, status) {
    if (status === 'Disconnected' && !window.confirm(`Disconnect ${s.mobileNumber}? It cannot be switched on again from here.`)) return;
    setBusy(s.id); setError('');
    try { const r = await vendorApi.post(`/sim/${s.id}/status`, { status }); setToast(r.data.message); load(); } catch (e) { setError(vendorError(e, 'Could not change the status.')); } finally { setBusy(''); }
  }
  async function updateReq(r, status) {
    setBusy(r.id); setError('');
    try { const res = await vendorApi.post(`/sim/requests/${r.id}/update`, { status, note: notes[r.id] || '' }); setToast(res.data.message); setNotes((n) => ({ ...n, [r.id]: '' })); load(); } catch (e) { setError(vendorError(e, 'Could not update the request.')); } finally { setBusy(''); }
  }
  const s = d?.summary;
  const rows = (d?.rows || []).filter((x) => !q || [x.mobileNumber, x.simSerial, x.employeeName, x.plan].some((v) => String(v || '').toLowerCase().includes(q.toLowerCase())));
  return (
    <>
      {toast && <div className="notice green" style={{ marginBottom: 10 }} role="status"><span>{toast}</span></div>}
      {error && <div className="notice red" style={{ marginBottom: 10 }} role="alert"><span>{error} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>}
      {!d ? <div className="empty-mini">Loading…</div> : (
        <>
          <div className="vp-tiles">
            <div className="vp-tile"><span>Numbers</span><b>{s.total}</b></div>
            <div className="vp-tile green"><span>Active</span><b>{s.active}</b></div>
            <div className="vp-tile orange"><span>Suspended</span><b>{s.suspended}</b></div>
            <div className="vp-tile"><span>Disconnected</span><b>{s.disconnected}</b></div>
          </div>

          <h3 className="vm-h3">Requests from the company</h3>
          {!d.requests.length ? <div className="vp-none">No requests right now.</div> : (
            <div className="tbl-wrap vp-table">
              <table>
                <thead><tr><th>Request</th><th>What</th><th>Number</th><th>Status</th><th>Your note</th><th>Update</th></tr></thead>
                <tbody>
                  {d.requests.map((r) => (
                    <tr key={r.id}>
                      <td><strong>{r.requestCode}</strong><div className="cell-muted">{day(r.createdAt)}</div></td>
                      <td>{KIND[r.kind] || r.kind}{r.details && <div className="cell-muted">{r.details}</div>}</td>
                      <td>{r.simNumber || '—'}</td>
                      <td><span className={`vp-tag vp-${REQ_TONE[r.status] || 'grey'}`}>{r.status}</span>{r.vendorNote && <div className="cell-muted">{r.vendorNote}</div>}</td>
                      <td>{r.nextStatuses.length > 0 && d.canHandle && <input aria-label={`Note for ${r.requestCode}`} value={notes[r.id] || ''} maxLength={500} placeholder="Add a note" onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} />}</td>
                      <td className="vm-acts">
                        {d.canHandle && r.nextStatuses.map((n) => (
                          <button key={n} type="button" className={`btn btn-sm${n === 'Done' ? ' btn-primary' : ''}`} disabled={busy === r.id || readOnly} onClick={() => updateReq(r, n)}>{n === 'Done' ? 'Mark done' : (n === 'Rejected' ? 'Reject' : 'Start work')}</button>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3 className="vm-h3">Company numbers</h3>
          <div className="vp-filters" role="search">
            <input className="vp-search" type="search" placeholder="Search number, SIM serial, name, plan" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search numbers" />
          </div>
          {!d.rows.length ? <div className="vp-empty"><h3>No numbers yet</h3><p>The company adds its numbers here. They will show up as soon as it does.</p></div> : (
            <div className="tbl-wrap vp-table">
              <table>
                <thead><tr><th>Mobile number</th><th>SIM serial</th><th>Plan</th><th>Held by</th><th>Status</th><th>Change status</th></tr></thead>
                <tbody>
                  {rows.map((x) => (
                    <tr key={x.id}>
                      <td><strong>{x.mobileNumber}</strong></td><td>{x.simSerial || '—'}</td><td>{x.plan || '—'}</td><td>{x.employeeName || <span className="cell-muted">Not given</span>}</td>
                      <td><span className={`vp-tag vp-${SIM_TONE[x.status] || 'grey'}`}>{x.status}</span></td>
                      <td className="vm-acts">
                        {d.canUpdate && x.status !== 'Disconnected' && (
                          <>
                            {x.status !== 'Active' && <button type="button" className="btn btn-sm btn-primary" disabled={busy === x.id || readOnly} onClick={() => setStatus(x, 'Active')}>Activate</button>}
                            {x.status !== 'Suspended' && <button type="button" className="btn btn-sm" disabled={busy === x.id || readOnly} onClick={() => setStatus(x, 'Suspended')}>Suspend</button>}
                            <button type="button" className="btn btn-sm btn-danger" disabled={busy === x.id || readOnly} onClick={() => setStatus(x, 'Disconnected')}>Disconnect</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!rows.length && <tr><td colSpan={6} className="cell-muted">No number matches the search.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
