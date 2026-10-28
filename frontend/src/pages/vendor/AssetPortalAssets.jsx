import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import vendorApi, { vendorError } from '../../vendorApi';
import Modal from '../../components/Modal.jsx';
import VendorShell from './VendorShell.jsx';
import VendorPager from './VendorPager.jsx';
import { day } from './vendorFormat.js';
import { StepTag, HistoryList, PayTag, PayLine, WarrantyTag, AmountCell, rs, changedFields } from './assetPortalCommon.jsx';
import { VendorIoBar } from './VendorIo.jsx';
import useAutoRefresh from './useAutoRefresh.js';
import './vendorModules.css';

// /vendor/asset-portal/assets - Assets in the Assets Vendor Portal: the company's assets given to THIS vendor (and the ones the company sent
// it for repair), read from the company's own asset list by asset id: nothing is copied, so an asset can never appear twice. Search, filters,
// sorting and pages are done by the server, inside the vendor taken from the session. A login that may edit can add the brand, model,
// condition and serial number the company's list does not hold.
const SORTS = [['assetCode', 'Asset ID'], ['name', 'Name'], ['category', 'Category'], ['brand', 'Brand'], ['model', 'Model'], ['serialNumber', 'Serial number'], ['condition', 'Condition'], ['status', 'Status']];
// The company's asset list (HRMS) is the source of every row: brand, model and serial number are shown as HRMS holds them; a login that may edit can add what is missing.

export default function AssetPortalAssets() {
  return (
    <VendorShell title="Asset Register" sub="The company assets given to you: who has each one, its details and where it stands.">
      <Body />
    </VendorShell>
  );
}

function Body() {
  const [params] = useSearchParams();
  const [data, setData] = useState(null);
  // 27 Oct 2026 (Stage B): every asset of yours, with who has it - All / With employees / In stock / Under repair
  const [f, setF] = useState({ q: '', view: params.get('view') || 'all', category: '', status: params.get('status') || '', condition: '', department: '', designation: '', assignment: '', sort: 'assetCode', dir: 'asc', page: 1 });
  const [qDeb, setQDeb] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  useEffect(() => { const t = setTimeout(() => setQDeb(f.q), 250); return () => clearTimeout(t); }, [f.q]);
  const load = useCallback(() => {
    vendorApi.get('/asset-portal/assets', { params: { q: qDeb || undefined, view: f.view, category: f.category || undefined, status: f.status || undefined, condition: f.condition || undefined, department: f.department || undefined, designation: f.designation || undefined, assignment: f.assignment || undefined, sort: f.sort, dir: f.dir, page: f.page } })
      .then((r) => { setData(r.data); setError(''); }).catch((e) => setError(vendorError(e, 'Could not load your assets.')));
  }, [qDeb, f.view, f.category, f.status, f.condition, f.department, f.designation, f.assignment, f.sort, f.dir, f.page]);
  useEffect(() => { load(); }, [load]);
  const fresh = useAutoRefresh(load, data); // new assets arrive by themselves from HRMS / Accounts: ask again every minute, no reload
  const set = (patch) => setF((x) => ({ ...x, page: 1, ...patch }));
  const rows = data?.rows || [];
  const filtered = !!(f.q || f.category || f.status || f.condition || f.department || f.designation || f.assignment);
  const opt = (list) => (list || []).map((o) => <option key={o.value} value={o.value}>{o.value} ({o.count})</option>);
  return (
    <>
      {error && <div className="notice red" style={{ marginBottom: 10 }}><span>{error} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>}
      <VendorIoBar list="assets" params={{ ...f, q: qDeb }} assetsNote />
      {fresh.text && <div className="cell-muted vio-updated" role="status">{fresh.text}. New assets from HRMS and Accounts show here by themselves.</div>}
      {data && data.tabs && (
        <div className="vp-seg vio-tabs" role="tablist" aria-label="Which assets">
          {[['all', 'All'], ['assigned', 'With employees'], ['available', 'In stock'], ['repair', 'Under repair']].map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={f.view === k} className={`vp-chip${f.view === k ? ' on' : ''}`} onClick={() => set({ view: k, status: '', assignment: '' })}>{l} ({data.tabs[k] || 0})</button>
          ))}
        </div>
      )}
      <div className="vp-filters" role="search">
        <input className="vp-search" type="search" placeholder="Search asset ID, serial number, employee name or employee ID" value={f.q} onChange={(e) => set({ q: e.target.value })} aria-label="Search" />
        <select aria-label="Department" value={f.department} onChange={(e) => set({ department: e.target.value })}><option value="">Any department</option>{opt(data?.facets.department)}</select>
        <select aria-label="Designation" value={f.designation} onChange={(e) => set({ designation: e.target.value })}><option value="">Any designation</option>{opt(data?.facets.designation)}</select>
        {f.view === 'all' && <select aria-label="With an employee or not" value={f.assignment} onChange={(e) => set({ assignment: e.target.value })}><option value="">Assigned or not</option>{opt(data?.facets.assignment)}</select>}
        <select aria-label="Category" value={f.category} onChange={(e) => set({ category: e.target.value })}><option value="">Any category</option>{opt(data?.facets.category)}</select>
        <select aria-label="Status" value={f.status} onChange={(e) => set({ status: e.target.value })}><option value="">Any status</option>{opt(data?.facets.status)}</select>
        <select aria-label="Condition" value={f.condition} onChange={(e) => set({ condition: e.target.value })}><option value="">Any condition</option>{opt(data?.facets.condition)}</select>
        <select aria-label="Sort by" value={f.sort} onChange={(e) => set({ sort: e.target.value })}>{SORTS.map(([k, l]) => <option key={k} value={k}>Sort: {l}</option>)}</select>
        <button type="button" className="btn btn-sm" onClick={() => set({ dir: f.dir === 'asc' ? 'desc' : 'asc' })}>{f.dir === 'asc' ? 'A to Z' : 'Z to A'}</button>
        {filtered && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setF((x) => ({ q: '', view: x.view, category: '', status: '', condition: '', department: '', designation: '', assignment: '', sort: 'assetCode', dir: 'asc', page: 1 }))}>Clear</button>}
      </div>
      {!data ? <div className="empty-mini">Loading&hellip;</div> : !rows.length ? (
        <div className="vp-empty">
          {data.assignedTotal ? <><h3>No asset matches</h3><p>Clear the search to see all {data.assignedTotal}.</p></> : <><h3>{f.view === 'repair' ? 'Nothing is under repair' : 'No available assets yet'}</h3><p>{f.view === 'repair' ? 'When the company approves a repair for you, the asset shows here.' : 'Assets that are free (in stock, not with an employee) show here by themselves, with their details from the company\'s asset list.'}</p></>}
        </div>
      ) : (
        <>
          <div className="tbl-wrap vp-scroll">
            <table>
              <thead><tr><th>Asset ID</th><th>Name</th><th>With</th><th>Brand and model</th><th>Serial number</th><th>Condition</th><th>Department</th><th>Warranty</th>{data.showAmounts && <th className="num">Amount</th>}<th>Status</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="vp-row-click" onClick={() => setOpen(r.id)}>
                    <td><strong>{r.assetCode}</strong></td>
                    <td>{r.name}<div className="cell-muted">{r.category}</div></td>
                    <td><HolderCell h={r.holder} since={r.assignedAt} /></td>
                    <td>{[r.brand, r.model].filter(Boolean).join(' ') || 'Not recorded'}</td>
                    <td>{r.serialNumber || 'Not recorded'}</td>
                    <td>{r.condition || 'Not recorded'}</td>
                    <td>{(r.holder && r.holder.department) || r.department || 'Not recorded'}</td>
                    <td><WarrantyTag w={r.warranty} /></td>
                    {data.showAmounts && <td className="num"><AmountCell r={r} /></td>}
                    <td>{r.repairStage ? <StepTag step={r.repairStage} /> : <span className="vp-tag vp-grey">{r.status}</span>}</td>
                    <td><button type="button" className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setOpen(r.id); }}>View</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <VendorPager data={data} onPage={(page) => setF((x) => ({ ...x, page }))} />
        </>
      )}
      {open && <AssetDetail id={open} onClose={() => setOpen(null)} onChanged={load} />}
    </>
  );
}

// WHO HAS IT (founder 2026-10-27): name, employee ID, designation - "Unassigned" when nobody holds it. Never anything else about the person.
function HolderCell({ h, since }) {
  if (!h) return <span className="vp-tag vp-grey">Unassigned</span>;
  return (
    <>
      <strong>{h.name || 'Not recorded'}</strong>{h.left && <span className="vp-tag vp-red" style={{ marginLeft: 4 }}>left the company</span>}
      <div className="cell-muted">{[h.employeeCode, h.designation].filter(Boolean).join(' · ') || 'Not recorded'}{since ? ` · since ${day(since.slice(0, 10))}` : ''}</div>
    </>
  );
}

const EDIT_KEYS = ['brand', 'model', 'condition', 'serialNumber', 'serviceRemarks'];

function AssetDetail({ id, onClose, onChanged }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const url = `/asset-portal/assets/${encodeURIComponent(id)}`;
  const fill = (r) => { setD(r); setForm(Object.fromEntries(EDIT_KEYS.map((k) => [k, r.asset[k] || '']))); };
  useEffect(() => { vendorApi.get(url).then((r) => fill(r.data)).catch((e) => setError(vendorError(e, 'Could not open this asset.'))); }, [url]);
  async function save() {
    const body = changedFields(form, d.asset, EDIT_KEYS);
    if (!Object.keys(body).length) { setMsg('Nothing was changed.'); return; }
    setBusy(true); setError(''); setMsg('');
    try {
      const r = await vendorApi.patch(url, { ...body, updatedAt: d.asset.updatedAt });
      setMsg(r.data.message || 'Saved.');
      const fresh = await vendorApi.get(url);
      fill(fresh.data); onChanged();
    } catch (e) { setError(vendorError(e, 'Could not save.')); } finally { setBusy(false); }
  }
  const a = d?.asset;
  const set = (k) => (e) => setForm((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Modal title={a ? `${a.assetCode} - ${a.name}` : 'Asset'} size="wide" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      {error && <div className="notice red" style={{ marginBottom: 8 }}><span>{error}</span></div>}
      {msg && <div className="notice green" style={{ marginBottom: 8 }}><span>{msg}</span></div>}
      {!d && !error && <div className="empty-mini">Loading&hellip;</div>}
      {d && (
        <div className="vp-detail">
          <dl>
            <dt>Asset ID</dt><dd><strong>{a.assetCode}</strong></dd>
            <dt>Name</dt><dd>{a.name}</dd>
            <dt>Category</dt><dd>{a.category}{a.assetType ? ` (${a.assetType})` : ''}</dd>
            <dt>Assigned vendor</dt><dd>{a.assignedVendor}</dd>
            <dt>Current status</dt><dd><span className="vp-tag vp-grey">{a.status}</span>{a.repairStage && <> <StepTag step={a.repairStage} /> <span className="cell-muted">repair {a.repairNo}</span></>}</dd>
            <dt>Department</dt><dd>{(a.holder && a.holder.department) || a.department || 'Not recorded'}</dd>
            <dt>Seat</dt><dd>{a.location || 'Not recorded'}</dd>
            <dt>Bought on</dt><dd>{day(a.purchaseDate)}</dd>
            <dt>Warranty</dt><dd>{a.warranty && a.warranty.until ? `${day(a.warranty.until)} ` : ''}<WarrantyTag w={a.warranty} /></dd>
            <dt>AMC until</dt><dd>{day(a.amcUntil)}</dd>
            {!a.amountHidden && (<><dt>Amount</dt><dd><AmountCell r={a} /></dd></>)}
          </dl>

          {d.assignment && (
            <>
              <h4 style={{ margin: '14px 0 6px' }}>Who has it now</h4>
              {d.assignment.current ? (
                <dl>
                  <dt>Employee</dt><dd><strong>{d.assignment.current.name || 'Not recorded'}</strong>{d.assignment.current.left && <span className="vp-tag vp-red" style={{ marginLeft: 4 }}>left the company</span>}</dd>
                  <dt>Employee ID</dt><dd>{d.assignment.current.employeeCode || 'Not recorded'}</dd>
                  <dt>Designation</dt><dd>{d.assignment.current.designation || 'Not recorded'}</dd>
                  <dt>Department</dt><dd>{d.assignment.current.department || 'Not recorded'}</dd>
                  <dt>Given on</dt><dd>{d.assignment.assignedAt ? day(d.assignment.assignedAt.slice(0, 10)) : 'Not recorded'}</dd>
                  <dt>Given by</dt><dd>{d.assignment.assignedBy || 'Not recorded'}</dd>
                </dl>
              ) : <div className="vp-none">Unassigned - nobody holds this asset now.</div>}
              <h4 style={{ margin: '14px 0 6px' }}>Assignment history</h4>
              {d.assignment.history.length ? (
                <ul className="vm-hist">{d.assignment.history.map((e, i) => <li key={`${e.at}-${i}`}>{e.text}<span className="cell-muted"> · {e.at ? day(String(e.at).slice(0, 10)) : 'date not recorded'}{e.by ? ` · ${e.by}` : ''}</span></li>)}</ul>
              ) : <div className="vp-none">{d.assignment.note}</div>}
            </>
          )}

          <div className="vm-form" style={{ marginTop: 12 }}>
            <h4>Brand, model, condition and serial number</h4>
            {d.canEdit ? (
              <>
                <div className="vm-grid">
                  <label>Brand<input type="text" value={form.brand} maxLength={80} onChange={set('brand')} /></label>
                  <label>Model<input type="text" value={form.model} maxLength={80} onChange={set('model')} /></label>
                  <label>Condition
                    <select value={form.condition} onChange={set('condition')}><option value="">Not told</option>{d.conditions.map((c) => <option key={c} value={c}>{c}</option>)}</select>
                  </label>
                  <label>Serial number<input type="text" value={form.serialNumber} maxLength={120} onChange={set('serialNumber')} /></label>
                </div>
                <label style={{ display: 'block', marginTop: 8 }}>Your remarks about this asset<textarea rows={2} value={form.serviceRemarks} maxLength={1000} onChange={set('serviceRemarks')} style={{ width: '100%' }} /></label>
                <div style={{ marginTop: 8 }}><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving...' : 'Save'}</button></div>
              </>
            ) : (
              <dl>
                <dt>Brand</dt><dd>{a.brand || '-'}</dd>
                <dt>Model</dt><dd>{a.model || '-'}</dd>
                <dt>Condition</dt><dd>{a.condition || '-'}</dd>
                <dt>Serial number</dt><dd>{a.serialNumber || '-'}</dd>
                <dt>Remarks</dt><dd>{a.serviceRemarks || '-'}</dd>
              </dl>
            )}
            {d.editNote && <p className="cell-muted">{d.editNote}</p>}
            {!d.canEdit && !d.editNote && <p className="cell-muted">Your login can only look at assets. Ask the company if you need to change these details.</p>}
          </div>

          {d.purchase && (d.purchase.invoiceNo || d.purchase.payment) && (
            <>
              <h4 style={{ margin: '14px 0 6px' }}>Purchase</h4>
              <dl>
                <dt>Invoice number</dt><dd>{d.purchase.invoiceNo || '-'}</dd>
                <dt>Bought on</dt><dd>{day(d.purchase.purchaseDate)}</dd>
                {'amount' in d.purchase && (<><dt>Purchase value</dt><dd>{rs(d.purchase.amount)}</dd></>)}
                <dt>Payment</dt><dd>{d.purchase.payment ? <><PayTag pay={d.purchase.payment} /> <PayLine pay={d.purchase.payment} /></> : <span className="cell-muted">{d.purchase.note}</span>}</dd>
              </dl>
            </>
          )}
          <h4 style={{ margin: '14px 0 6px' }}>Repairs of this asset</h4>
          {!d.repairs.length ? <div className="vp-none">No repair yet.</div> : (
            <div className="tbl-wrap vp-scroll"><table>
              <thead><tr><th>Repair</th><th>Problem</th><th>Reported</th><th>Repair step</th><th className="num">Final cost</th><th>Payment</th></tr></thead>
              <tbody>{d.repairs.map((r) => (
                <tr key={r.id}>
                  <td><Link to={`/vendor/asset-portal/repairs?open=${encodeURIComponent(r.id)}`}><strong>{r.repairNo}</strong></Link></td>
                  <td>{r.issue || '-'}</td><td>{day(r.dateReported)}</td><td><StepTag step={r.stage} /></td>
                  <td className="num">{rs(r.finalTotal)}</td><td><PayTag pay={r.payment} /></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
          <h4 style={{ margin: '14px 0 6px' }}>History of this asset&apos;s repairs</h4>
          <HistoryList rows={d.history} showRepair />
          {Array.isArray(d.timeline) && d.timeline.length > 0 && (
            <>
              <h4 style={{ margin: '14px 0 6px' }}>Full history of this asset (oldest first)</h4>
              <div className="tbl-wrap vp-scroll"><table>
                <thead><tr><th>Date</th><th>What</th><th>Details</th></tr></thead>
                <tbody>{d.timeline.map((e, i) => (
                  <tr key={`${e.at}-${i}`}><td>{day(String(e.at).slice(0, 10))}</td><td>{e.kind}</td><td style={{ whiteSpace: 'normal' }}>{e.link ? <Link to={e.link}>{e.text}</Link> : e.text}</td></tr>
                ))}</tbody>
              </table></div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
