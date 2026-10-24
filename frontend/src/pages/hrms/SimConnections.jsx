import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import Combo from '../../components/Combo.jsx';
import '../vendor/vendorPortal.css';
import '../vendor/vendorModules.css';

// ---------------------------------------------------------------------------
// EMPLOYEE SERVICES -> ASSETS -> "SIM & connections" (2026-10-14). The company's numbers (mobile number, SIM serial,
// plan, who holds it, Active / Suspended / Disconnected) and the requests it raises to the telecom vendor (new
// connection, replacement SIM, port-out, plan change). SIM Card is already an asset category: "Import from SIM Card
// assets" reads those assets, shows a PREVIEW, and only the rows you tick are added (the assets are not changed).
// Server: routes/simConnections.js. Not a sidebar entry.
// ---------------------------------------------------------------------------
const two = (n) => String(n).padStart(2, '0');
const day = (s) => { if (!s) return '—'; const d = new Date(s); return Number.isNaN(d.getTime()) ? '—' : `${two(d.getDate())}-${two(d.getMonth() + 1)}-${d.getFullYear()}`; };
const errText = (e, f) => (e?.response ? e.response.data?.error || f : 'Cannot reach the server. Try again.');
const SIM_TONE = { Active: 'green', Suspended: 'yellow', Disconnected: 'grey' };
const REQ_TONE = { Open: 'yellow', 'In progress': 'blue', Done: 'green', Rejected: 'red' };

export default function SimConnections({ canEdit = true }) {
  const [vendors, setVendors] = useState(null);
  const [kinds, setKinds] = useState([]);
  const [vendorId, setVendorId] = useState('');
  const [d, setD] = useState(null);
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [form, setForm] = useState(null); // { row | null }
  const [req, setReq] = useState(null);
  const [imp, setImp] = useState(null);
  useEffect(() => {
    api.get('/sim-connections/vendors').then((r) => { setVendors(r.data.vendors); setKinds(r.data.kinds); if (r.data.vendors.length === 1) setVendorId(r.data.vendors[0].id); })
      .catch((e) => setErr(e.response?.status === 503 ? 'SIM and connections are not switched on in the database yet. Ask the company to finish the setup.' : errText(e, 'Could not load the vendors.')));
  }, []);
  const load = useCallback(() => {
    api.get('/sim-connections', { params: { vendorId: vendorId || undefined } }).then((r) => { setD(r.data); setErr(''); }).catch((e) => { if (e.response?.status !== 503) setErr(errText(e, 'Could not load the numbers.')); });
  }, [vendorId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!msg) return undefined; const t = setTimeout(() => setMsg(''), 5000); return () => clearTimeout(t); }, [msg]);
  const rows = (d?.rows || []).filter((x) => !q || [x.mobileNumber, x.simSerial, x.employeeName, x.plan].some((v) => String(v || '').toLowerCase().includes(q.toLowerCase())));
  const noVendor = vendors && !vendors.length;
  return (
    <div className="vm-wrap">
      <div className="small-muted" style={{ marginBottom: 10 }}>Your company numbers and the requests you send to the telecom vendor. The vendor updates its side in its own portal.</div>
      {msg && <div className="notice green" style={{ marginBottom: 10 }}><span>{msg}</span></div>}
      {err && <div className="notice red" style={{ marginBottom: 10 }}><span>{err}</span></div>}
      {noVendor && <div className="notice amber" style={{ marginBottom: 10 }}><span>No telecom vendor yet. Add one in Administration → Company Setup → Vendors with the category “Airtel SIM / Telecom”, then give it a login.</span></div>}
      <div className="vp-filters" role="search">
        <Combo value={vendorId} onChange={(e) => setVendorId(e.target.value)} aria-label="Telecom vendor">
          <option value="">All telecom vendors</option>
          {(vendors || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </Combo>
        <input className="vp-search" type="search" placeholder="Search number, SIM serial, name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search numbers" />
        {canEdit && <button type="button" className="btn btn-primary" disabled={!vendorId} title={vendorId ? '' : 'Pick the vendor first'} onClick={() => setForm({ row: null })}>+ Add number</button>}
        {canEdit && <button type="button" className="btn" disabled={!vendorId} title={vendorId ? '' : 'Pick the vendor first'} onClick={() => setImp({ loading: true })}>Import from SIM Card assets</button>}
        {canEdit && <button type="button" className="btn" disabled={!vendorId} title={vendorId ? '' : 'Pick the vendor first'} onClick={() => setReq({ kind: 'new', simId: '', details: '' })}>Raise a request</button>}
      </div>
      {!d ? <div className="empty-mini">Loading…</div> : (
        <>
          {!d.rows.length ? <div className="vp-empty"><h3>No numbers yet</h3><p>Pick the vendor, then “Import from SIM Card assets” (reads the SIM assets you already have) or “+ Add number”.</p></div> : (
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Mobile number</th><th>Vendor</th><th>SIM serial</th><th>Plan</th><th>Held by</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {rows.map((x) => (
                    <tr key={x.id}>
                      <td><strong>{x.mobileNumber}</strong>{x.assetId && <div className="cell-muted">from an asset</div>}</td><td>{x.vendorName}</td><td>{x.simSerial || '—'}</td><td>{x.plan || '—'}</td><td>{x.employeeName || '—'}</td>
                      <td><span className={`vp-tag vp-${SIM_TONE[x.status] || 'grey'}`}>{x.status}</span></td>
                      <td>{canEdit && <button type="button" className="btn btn-sm" onClick={() => setForm({ row: x })}>Edit</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3 className="vm-h3">Requests to the vendor</h3>
          {!d.requests.length ? <div className="vp-none">No requests yet.</div> : (
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Request</th><th>What</th><th>Number</th><th>Status</th><th>Vendor note</th></tr></thead>
                <tbody>{d.requests.map((r) => <tr key={r.id}><td><strong>{r.requestCode}</strong><div className="cell-muted">{day(r.createdAt)}</div></td><td>{r.kindText}{r.details && <div className="cell-muted">{r.details}</div>}</td><td>{r.simNumber || '—'}</td><td><span className={`vp-tag vp-${REQ_TONE[r.status] || 'grey'}`}>{r.status}</span></td><td>{r.vendorNote || '—'}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </>
      )}
      {form && <SimForm row={form.row} vendorId={vendorId} onClose={() => setForm(null)} onDone={(m) => { setForm(null); setMsg(m); load(); }} />}
      {req && (
        <Modal
          title="Request to the telecom vendor" onClose={() => setReq(null)}
          footer={<><button type="button" className="btn" onClick={() => setReq(null)}>Cancel</button><button type="button" className="btn btn-primary" onClick={async () => {
            try { const r = await api.post('/sim-connections/requests', { vendorId, kind: req.kind, simId: req.simId || undefined, details: req.details }); setReq(null); setMsg(r.data.message); load(); } catch (e) { setReq({ ...req, error: errText(e, 'Could not send the request.') }); }
          }}>Send request</button></>}
        >
          <div className="vp-form">
            <label htmlFor="srK">What do you need?</label>
            <Combo id="srK" value={req.kind} onChange={(e) => setReq({ ...req, kind: e.target.value })}>{kinds.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</Combo>
            {req.kind !== 'new' && (
              <>
                <label htmlFor="srS">Which number</label>
                <Combo id="srS" value={req.simId} onChange={(e) => setReq({ ...req, simId: e.target.value })}>
                  <option value="">Pick the number…</option>
                  {(d?.rows || []).filter((x) => x.vendorId === vendorId).map((x) => <option key={x.id} value={x.id}>{x.mobileNumber}{x.employeeName ? ` · ${x.employeeName}` : ''}</option>)}
                </Combo>
              </>
            )}
            <label htmlFor="srD">Details</label>
            <textarea id="srD" rows={3} maxLength={800} value={req.details} onChange={(e) => setReq({ ...req, details: e.target.value })} placeholder="e.g. new connection for the new BDE, postpaid plan 499" />
            {req.error && <div className="error-text" role="alert">{req.error}</div>}
          </div>
        </Modal>
      )}
      {imp && <ImportPreview vendorId={vendorId} onClose={() => setImp(null)} onDone={(m) => { setImp(null); setMsg(m); load(); }} />}
    </div>
  );
}

function SimForm({ row, vendorId, onClose, onDone }) {
  const isNew = !row;
  const [v, setV] = useState({ mobileNumber: row?.mobileNumber || '', simSerial: row?.simSerial || '', plan: row?.plan || '', employeeId: row?.employeeId || '', status: row?.status || 'Active', notes: row?.notes || '' });
  const [emps, setEmps] = useState([]);
  const [eq, setEq] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    const t = setTimeout(() => { api.get('/sim-connections/employees', { params: { q: eq } }).then((r) => setEmps(r.data.employees)).catch(() => {}); }, 250);
    return () => clearTimeout(t);
  }, [eq]);
  async function save() {
    setErr('');
    try {
      const r = isNew ? await api.post('/sim-connections', { ...v, vendorId }) : await api.patch(`/sim-connections/${row.id}`, { simSerial: v.simSerial, plan: v.plan, employeeId: v.employeeId || null, notes: v.notes });
      onDone(r.data.message);
    } catch (e) { setErr(errText(e, 'Could not save.')); }
  }
  const list = emps.some((e) => e.id === v.employeeId) || !row?.employeeId ? emps : [{ id: row.employeeId, name: row.employeeName }, ...emps];
  return (
    <Modal title={isNew ? 'Add a number' : `Edit ${row.mobileNumber}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Save</button></>}>
      <div className="vp-form">
        <label htmlFor="smN">Mobile number</label>
        <input id="smN" value={v.mobileNumber} disabled={!isNew} maxLength={16} inputMode="tel" onChange={(e) => setV({ ...v, mobileNumber: e.target.value })} />
        <label htmlFor="smS">SIM serial (ICCID)</label><input id="smS" value={v.simSerial} maxLength={40} onChange={(e) => setV({ ...v, simSerial: e.target.value })} />
        <label htmlFor="smP">Plan</label><input id="smP" value={v.plan} maxLength={80} onChange={(e) => setV({ ...v, plan: e.target.value })} placeholder="e.g. Postpaid 499" />
        <label htmlFor="smE">Held by</label>
        <Combo id="smE" value={v.employeeId} onChange={(e) => setV({ ...v, employeeId: e.target.value })} onSearch={setEq}>
          <option value="">Nobody / in stock</option>
          {list.map((e) => <option key={e.id} value={e.id}>{e.name}{e.employeeCode ? ` (${e.employeeCode})` : ''}</option>)}
        </Combo>
        {isNew && (
          <>
            <div className="vp-lbl">Status</div>
            <div className="vp-choice" role="radiogroup" aria-label="Status">
              {['Active', 'Suspended', 'Disconnected'].map((s) => <button type="button" key={s} role="radio" aria-checked={v.status === s} className={`vp-chip${v.status === s ? ' on' : ''}`} onClick={() => setV({ ...v, status: s })}>{s}</button>)}
            </div>
          </>
        )}
        <label htmlFor="smNo">Notes</label><input id="smNo" value={v.notes} maxLength={300} onChange={(e) => setV({ ...v, notes: e.target.value })} />
        {err && <div className="error-text" role="alert" style={{ marginTop: 8 }}>{err}</div>}
      </div>
    </Modal>
  );
}

function ImportPreview({ vendorId, onClose, onDone }) {
  const [d, setD] = useState(null);
  const [tick, setTick] = useState(new Set());
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get('/sim-connections/import-preview', { params: { vendorId } }).then((r) => { setD(r.data); setTick(new Set(r.data.rows.filter((x) => x.action === 'import').map((x) => x.assetId))); }).catch((e) => setErr(errText(e, 'Could not read the SIM assets.')));
  }, [vendorId]);
  async function run() {
    setBusy(true); setErr('');
    try { const r = await api.post('/sim-connections/import', { vendorId, assetIds: [...tick] }); onDone(r.data.message); } catch (e) { setErr(errText(e, 'Could not import.')); setBusy(false); }
  }
  return (
    <Modal
      title={d ? `Import SIM numbers for ${d.vendor.name}` : 'Import SIM numbers'} size="xwide" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="btn btn-primary" onClick={run} disabled={busy || !tick.size}>{busy ? 'Importing…' : `Import ${tick.size} number${tick.size === 1 ? '' : 's'}`}</button></>}
    >
      {err && <div className="notice red" role="alert"><span>{err}</span></div>}
      {!d ? (err ? null : <div className="empty-mini">Reading your SIM Card assets…</div>) : (
        <>
          <div className="notice blue" style={{ marginBottom: 8 }}><span><strong>Preview only: nothing has been written yet.</strong> {d.summary.willImport} of {d.summary.total} SIM Card assets can be imported; {d.summary.skipped} are skipped. The assets themselves are never changed.</span></div>
          <div className="tbl-wrap" style={{ maxHeight: 380, overflow: 'auto' }}>
            <table>
              <thead><tr><th /><th>Asset</th><th>Mobile number</th><th>SIM serial</th><th>Held by</th><th>Status</th><th>What happens</th></tr></thead>
              <tbody>
                {d.rows.map((x) => (
                  <tr key={x.assetId} className={x.action === 'skip' ? 'cell-muted' : ''}>
                    <td><input type="checkbox" aria-label={`Import ${x.assetCode}`} disabled={x.action === 'skip'} checked={tick.has(x.assetId)} onChange={(e) => setTick((t) => { const n = new Set(t); if (e.target.checked) n.add(x.assetId); else n.delete(x.assetId); return n; })} /></td>
                    <td><strong>{x.assetCode}</strong><div className="cell-muted">{x.assetName}</div></td><td>{x.mobileNumber || '—'}</td><td>{x.simSerial || '—'}</td><td>{x.employeeName || '—'}</td><td>{x.status}</td>
                    <td>{x.action === 'import' ? 'Will be added' : x.why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
