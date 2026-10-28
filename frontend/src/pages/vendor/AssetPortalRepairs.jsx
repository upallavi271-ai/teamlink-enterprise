import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import vendorApi, { vendorError } from '../../vendorApi';
import Modal from '../../components/Modal.jsx';
import VendorShell, { openVendorFile } from './VendorShell.jsx';
import VendorPager from './VendorPager.jsx';
import { day } from './vendorFormat.js';
import { StepTag, StepRow, HistoryList, PayTag, PayLine, STEP_HELP, STEPS, WarrantyTag, AmountCell, rs, changedFields } from './assetPortalCommon.jsx';
import { VendorIoBar } from './VendorIo.jsx';
import { UploadBillButton } from './AssetPortalBillUploads.jsx'; // Upload repair bill (photo / scan / PDF, read by AI, checked by Accounts)
import useAutoRefresh from './useAutoRefresh.js';
import { HistoryBody } from './AssetPortalHistory.jsx';
import './vendorModules.css';

// /vendor/asset-portal/repairs - Repairs in the Assets Vendor Portal. These are the company's OWN repair records (the same ones Accounts reads):
// the vendor never starts a new repair, it moves the company's one step at a time and gives its estimate, final cost, GST, invoice number
// and invoice file. Nothing here marks anything paid or posts to the books; Accounts does that itself. Every change is written to the
// repair's history (who, when, old to new) and cannot be erased.
const SORTS = [['dateReported', 'Reported on'], ['repairNo', 'Repair number'], ['assetCode', 'Asset ID'], ['stage', 'Step'], ['estimate', 'Estimate'], ['finalCost', 'Final cost']];

// REPAIRS & HRMS TICKETS (one of the four modules, 27 Oct 2026): Repairs | HRMS tickets | Repair history (the old /history address opens the last tab)
// Stage C (28 Oct): inside Repairs, the plain tabs Active / Awaiting your action / In progress / Waiting for approval / Completed / Closed.
export default function AssetPortalRepairs() {
  const [params, setParams] = useSearchParams();
  const tab = ['history', 'tickets'].includes(params.get('tab')) ? params.get('tab') : 'repairs';
  const go = (t) => { const n = new URLSearchParams(params); if (t === 'repairs') n.delete('tab'); else n.set('tab', t); n.delete('open'); setParams(n, { replace: true }); };
  return (
    <VendorShell title="Repairs & HRMS Tickets" sub="The repairs the company has given you: update each step, add your estimate, final cost and invoice. Every change is in Repair history.">
      <div className="vp-seg vio-tabs" role="tablist" aria-label="Repairs or history">
        <button type="button" role="tab" aria-selected={tab === 'repairs'} className={`vp-chip${tab === 'repairs' ? ' on' : ''}`} onClick={() => go('repairs')}>Repairs</button>
        <button type="button" role="tab" aria-selected={tab === 'tickets'} className={`vp-chip${tab === 'tickets' ? ' on' : ''}`} onClick={() => go('tickets')}>HRMS tickets</button>
        <button type="button" role="tab" aria-selected={tab === 'history'} className={`vp-chip${tab === 'history' ? ' on' : ''}`} onClick={() => go('history')}>Repair history</button>
      </div>
      {tab === 'history' ? <HistoryBody /> : tab === 'tickets' ? <Tickets /> : <Body />}
    </VendorShell>
  );
}

function Body() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [f, setF] = useState({ q: '', bucket: params.get('bucket') || (params.get('stage') ? '' : 'Active'), stage: params.get('stage') || '', category: '', payment: '', from: '', to: '', sort: 'dateReported', dir: 'desc', page: 1 });
  const [qDeb, setQDeb] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(params.get('open') || null);
  useEffect(() => { const t = setTimeout(() => setQDeb(f.q), 250); return () => clearTimeout(t); }, [f.q]);
  const load = useCallback(() => {
    vendorApi.get('/asset-portal/repairs', { params: { q: qDeb || undefined, bucket: f.bucket || undefined, stage: f.stage || undefined, category: f.category || undefined, payment: f.payment || undefined, from: f.from || undefined, to: f.to || undefined, sort: f.sort, dir: f.dir, page: f.page } })
      .then((r) => { setData(r.data); setError(''); }).catch((e) => setError(vendorError(e, 'Could not load your repairs.')));
  }, [qDeb, f.bucket, f.stage, f.category, f.payment, f.from, f.to, f.sort, f.dir, f.page]);
  useEffect(() => { load(); }, [load]);
  const fresh = useAutoRefresh(load, data); // a repair the company approves in HRMS shows here by itself, no reload
  const set = (patch) => setF((x) => ({ ...x, page: 1, ...patch }));
  const close = () => { setOpen(null); if (params.get('open')) { const n = new URLSearchParams(params); n.delete('open'); setParams(n, { replace: true }); } };
  const rows = data?.rows || [];
  const filtered = !!(f.q || f.stage || f.category || f.payment || f.from || f.to || (f.bucket && f.bucket !== 'Active'));
  const s = data?.summary;
  return (
    <>
      {error && <div className="notice red" style={{ marginBottom: 10 }}><span>{error} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>}
      {data?.canEdit && (
        <div className="vm-row" style={{ marginBottom: 10 }}>
          <UploadBillButton onDone={load} />
          <span className="cell-muted">Take a photo of your bill, handwritten or printed. Accounts checks it. Follow it in Invoices, My bills.</span>
        </div>
      )}
      {s && (
        <div className="vp-tiles">
          <div className="vp-tile"><span>Repairs</span><b>{s.count}</b></div>
          <div className="vp-tile orange"><span>Still open</span><b>{s.open}</b></div>
          <div className="vp-tile"><span>Your estimates</span><b>{rs(s.estimateTotal)}</b></div>
          <div className="vp-tile green"><span>Final cost</span><b>{rs(s.finalTotal)}</b></div>
        </div>
      )}
      <VendorIoBar list="repairs" params={{ ...f, q: qDeb }} importKey="repair-updates" onImported={load} />
      {fresh.text && <div className="cell-muted vio-updated" role="status">{fresh.text}. New repair jobs from the company show here by themselves.</div>}
      <div className="vp-filters" role="search">
        <input className="vp-search" type="search" placeholder="Search repair number, asset or problem" value={f.q} onChange={(e) => set({ q: e.target.value })} aria-label="Search" />
        <div className="vp-seg" role="tablist" aria-label="Which repairs">
          {BUCKET_TABS.map(([b, label]) => {
            const n = b ? (data?.buckets?.find((x) => x.value === b) || {}).count || 0 : data?.all || 0;
            return <button type="button" key={b || 'all'} role="tab" aria-selected={f.bucket === b && !f.stage} className={`vp-chip${f.bucket === b && !f.stage ? ' on' : ''}`} onClick={() => set({ bucket: b, stage: '' })}>{label} ({n})</button>;
          })}
          {f.stage && <button type="button" className="vp-chip on" onClick={() => set({ stage: '' })} title="Remove this step filter">Step: {f.stage} ✕</button>}
        </div>
        <select aria-label="Payment status" value={f.payment} onChange={(e) => set({ payment: e.target.value })}><option value="">Any payment status</option>{(data?.facets.payment || []).map((o) => <option key={o.value} value={o.value}>{o.value} ({o.count})</option>)}</select>
        <select aria-label="Category" value={f.category} onChange={(e) => set({ category: e.target.value })}>
          <option value="">Any category</option>
          {(data?.facets.category || []).map((o) => <option key={o.value} value={o.value}>{o.value} ({o.count})</option>)}
        </select>
        <div className="vp-dates">
          <input type="date" aria-label="Reported from" value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.target.value })} />
          <span className="vp-to">to</span>
          <input type="date" aria-label="Reported to" value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.target.value })} />
        </div>
        <select aria-label="Sort by" value={f.sort} onChange={(e) => set({ sort: e.target.value })}>{SORTS.map(([k, l]) => <option key={k} value={k}>Sort: {l}</option>)}</select>
        <button type="button" className="btn btn-sm" onClick={() => set({ dir: f.dir === 'asc' ? 'desc' : 'asc' })}>{f.dir === 'asc' ? 'Oldest first' : 'Newest first'}</button>
        {filtered && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setF({ q: '', bucket: 'Active', stage: '', category: '', payment: '', from: '', to: '', sort: 'dateReported', dir: 'desc', page: 1 })}>Clear</button>}
      </div>
      {!data ? <div className="empty-mini">Loading&hellip;</div> : !rows.length ? (
        <div className="vp-empty">
          {data.all ? <><h3>No repair matches</h3><p>Clear the search to see all {data.all}.</p></> : <><h3>No repairs yet</h3><p>When the company sends you an asset to repair, it shows here.</p></>}
        </div>
      ) : (
        <>
          <div className="tbl-wrap vp-scroll">
            <table>
              <thead><tr><th>Repair</th><th>Asset</th><th>Problem</th><th>Reported</th><th>Repair step</th><th>Warranty</th><th className="num">Estimate</th><th className="num">Final cost</th><th>Invoice</th><th>Payment</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="vp-row-click" onClick={() => setOpen(r.id)}>
                    <td><strong>{r.repairNo}</strong>{r.fromCompany && r.stage === 'Awaiting repair' && <span className="vp-tag vp-green" title="The company approved this repair and is waiting for you to take it.">New job</span>}{r.ticketRef && <div className="cell-muted">Ticket {r.ticketRef}</div>}</td>
                    <td>{r.assetCode} &middot; {r.assetName}</td>
                    <td>{r.issue || '-'}</td>
                    <td>{day(r.dateReported)}</td>
                    <td><StepTag step={r.stage} />{r.bucket === 'Awaiting your action' && <div><span className="vp-tag vp-orange">Accept or reject</span></div>}{r.decision === 'Rejected' && <div className="cell-muted">You could not take it</div>}{r.replacement && r.replacement.status !== 'Rejected' && <div className="cell-muted">Replacement: {r.replacement.status}</div>}</td>
                    <td><WarrantyTag w={r.warranty} />{r.underWarranty ? <div className="cell-muted">Marked under warranty</div> : null}</td>
                    <td className="num">{rs(r.estimateTotal)}</td>
                    <td className="num">{rs(r.finalTotal)}</td>
                    <td>{r.hasInvoice ? 'Attached' : (r.invoiceNo || '-')}</td>
                    <td><PayTag pay={r.payment} /></td>
                    <td><button type="button" className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setOpen(r.id); }}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <VendorPager data={data} onPage={(page) => setF((x) => ({ ...x, page }))} />
        </>
      )}
      {open && <RepairDetail id={open} onClose={close} onChanged={load} />}
    </>
  );
}

const KEYS = ['estimateCost', 'estimateGst', 'expectedDate', 'finalCost', 'finalGst', 'invoiceNo'];
const toForm = (r) => ({
  estimateCost: r.estimateCost ?? '', estimateGst: r.estimateGst ?? '', expectedDate: r.expectedDate || '', finalCost: r.finalCost ?? '', finalGst: r.finalGst ?? '', invoiceNo: r.invoiceNo || '', remarks: '',
});

function RepairDetail({ id, onClose, onChanged }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState(null);
  const [fileKey, setFileKey] = useState(0);
  const url = `/asset-portal/repairs/${encodeURIComponent(id)}`;
  const fill = (data) => { setD(data); setForm(toForm(data.repair)); };
  useEffect(() => { vendorApi.get(url).then((r) => fill(r.data)).catch((e) => setError(vendorError(e, 'Could not open this repair.'))); }, [url]);
  const set = (k) => (e) => setForm((x) => ({ ...x, [k]: e.target.value }));

  async function send(body, okText) {
    setBusy(true); setError(''); setMsg('');
    try {
      const r = await vendorApi.patch(url, { ...body, updatedAt: d.repair.updatedAt });
      fill(r.data);
      setMsg([r.data.changed && r.data.changed.length ? (okText || 'Saved.') : 'Nothing was changed.', ...(r.data.hints || [])].join(' '));
      onChanged();
    } catch (e) { setError(vendorError(e, 'Could not save.')); } finally { setBusy(false); }
  }
  const saveDetails = () => {
    const body = changedFields(form, toForm(d.repair), KEYS);
    if (form.remarks.trim()) body.remarks = form.remarks.trim();
    if (!Object.keys(body).length) { setMsg('Nothing was changed.'); return; }
    send(body);
  };
  const moveStep = () => send({ stage: d.repair.nextStage, ...(form.remarks.trim() ? { remarks: form.remarks.trim() } : {}) }, `Done: ${d.repair.nextStage}.`);
  async function upload() {
    if (!file) { setError('Choose the invoice file first (PDF, JPG or PNG).'); return; }
    setBusy(true); setError(''); setMsg('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (form.invoiceNo.trim() && form.invoiceNo.trim() !== (d.repair.invoiceNo || '')) fd.append('invoiceNo', form.invoiceNo.trim());
      const r = await vendorApi.post(`${url}/invoice`, fd);
      fill(r.data); setFile(null); setFileKey((k) => k + 1);
      setMsg([r.data.message || 'Invoice attached.', ...(r.data.hints || [])].join(' '));
      onChanged();
    } catch (e) { setError(vendorError(e, 'Could not attach the invoice.')); } finally { setBusy(false); }
  }
  async function sendToAccounts() {
    if (busy) return;
    setBusy(true); setError(''); setMsg('');
    try {
      const r2 = await vendorApi.post(`${url}/send-invoice`, {});
      fill(r2.data); setMsg(r2.data.message || 'Sent.'); onChanged();
    } catch (e) { setError(vendorError(e, 'Could not send the invoice.')); } finally { setBusy(false); }
  }
  async function openInvoice() {
    try { await openVendorFile({ kind: 'repair-invoice', id }); } catch (e) { setError(vendorError(e, 'Could not open the invoice.')); }
  }
  const r = d?.repair;
  const edit = d?.canEdit && r && r.stage !== 'Cancelled';
  const afterArrival = r && STEPS.indexOf(r.stage) >= 1;
  const estimateOpen = r && STEPS.indexOf(r.stage) <= 2;
  return (
    <Modal title={r ? `Repair ${r.repairNo}` : 'Repair'} size="wide" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      {error && <div className="notice red" style={{ marginBottom: 8 }}><span>{error}</span></div>}
      {msg && <div className="notice green" style={{ marginBottom: 8 }}><span>{msg}</span></div>}
      {!d && !error && <div className="empty-mini">Loading&hellip;</div>}
      {d && form && (
        <div className="vp-detail">
          {r.stage !== 'Cancelled' ? <StepRow step={r.stage} /> : <StepTag step="Cancelled" />}
          <p className="cell-muted" style={{ marginTop: 0 }}>{STEP_HELP[r.stage]}</p>
          <dl>
            <dt>Asset</dt><dd>{r.assetCode} &middot; {r.assetName}</dd>
            <dt>Category</dt><dd>{r.category}{r.assetType ? ` (${r.assetType})` : ''}</dd>
            <dt>Serial number</dt><dd>{r.serialNumber || '-'}</dd>
            <dt>Warranty</dt><dd>{r.warranty && r.warranty.until ? `${day(r.warranty.until)} ` : ''}<WarrantyTag w={r.warranty} /></dd>
            {!r.amountHidden && (<><dt>Asset amount</dt><dd><AmountCell r={r} /></dd></>)}
            <dt>Problem</dt><dd>{r.issue || '-'}</dd>
            {r.ticketRef && <><dt>Company ticket</dt><dd>{r.ticketRef}{r.approvedOn ? ` · approved on ${day(r.approvedOn)}` : ''}</dd></>}
            <dt>Kind of work</dt><dd>{r.repairType}{r.underWarranty ? ' (under warranty)' : ''}</dd>
            <dt>Reported on</dt><dd>{day(r.dateReported)}</dd>
            <dt>Expected back</dt><dd>{day(r.expectedDate)}</dd>
            <dt>Repair finished on</dt><dd>{day(r.repairDate)}</dd>
            <dt>Handed back on</dt><dd>{day(r.returnedDate)}</dd>
            <dt>Your estimate</dt><dd>{rs(r.estimateTotal)}{r.estimateGst ? ` (including GST ${rs(r.estimateGst)})` : ''}</dd>
            <dt>Final cost</dt><dd>{rs(r.finalTotal)}{r.finalGst ? ` (including GST ${rs(r.finalGst)})` : ''}</dd>
            <dt>Payment</dt><dd><PayTag pay={r.payment} /> <PayLine pay={r.payment} />{r.payment?.note && r.payment.status !== 'No invoice yet' ? <div className="cell-muted">{r.payment.note}</div> : null}</dd>
            <dt>Invoice</dt><dd>{r.invoiceNo || '-'}{r.invoice?.billCode ? ` (${r.invoice.billCode})` : ''}{r.hasInvoice ? <> &middot; <button type="button" className="link-btn" onClick={openInvoice}>Open {r.invoiceName}</button></> : null}</dd>
            <dt>Your last remark</dt><dd>{r.vendorRemarks || '-'}</dd>
            <dt>Your answer</dt><dd>{r.decision ? `${r.decision}${r.decisionAt ? ` on ${day(r.decisionAt)}` : ''}${r.decisionReason ? ` - ${r.decisionReason}` : ''}` : 'Not answered yet'}</dd>
            <dt>Parts / labour</dt><dd>{r.partsCost == null && r.labourCost == null ? '-' : `Parts ${rs(r.partsCost)} · Labour ${rs(r.labourCost)}`}</dd>
            <dt>Repair started / finished</dt><dd>{day(r.startDate)} / {day(r.completedDate || r.repairDate)}</dd>
            <dt>Outcome</dt><dd>{r.outcome || '-'}</dd>
            <dt>Work done</dt><dd>{r.workPerformed || '-'}</dd>
            <dt>Notes</dt><dd>{r.resolutionNotes || '-'}</dd>
            {r.replacement && <><dt>Replacement</dt><dd>{r.replacement.status}{r.replacement.decisionNote ? ` - ${r.replacement.decisionNote}` : ''}{r.replacement.replacementAssetCode ? ` · new asset ${r.replacement.replacementAssetCode}${r.replacement.replacementDate ? ` on ${day(r.replacement.replacementDate)}` : ''}` : ''}</dd></>}
          </dl>
          {r.inCompanyBooks && <div className="notice amber" style={{ marginTop: 10 }}><span>This repair is already in the company&apos;s books. If you change the cost or invoice, the change goes to Accounts to review. It does not change their books by itself.</span></div>}

          {edit && r.stage === 'Awaiting repair' && !r.decision && <DecisionBox url={url} onDone={(data, text) => { fill(data); setMsg(text); onChanged(); }} onError={setError} />}
          {edit && r.decision !== 'Rejected' && afterArrival && <WorkBox url={url} r={r} outcomes={d.outcomes || []} onDone={(data, text) => { if (data.repair && data.history) fill(data); setMsg(text); onChanged(); }} onError={setError} />}
          {edit && r.decision !== 'Rejected' && <ProofBox url={url} proofs={d.proofs || []} onDone={(data, text) => { if (data.repair) fill(data); setMsg(text); onChanged(); }} onError={setError} />}
          {!edit && (d.proofs || []).length > 0 && <ProofList proofs={d.proofs} onError={setError} />}
          {edit && afterArrival && r.decision !== 'Rejected' && !(r.replacement && ['Requested', 'Approved'].includes(r.replacement.status)) && <ReplacementBox url={url} onDone={(data, text) => { fill(data); setMsg(text); onChanged(); }} onError={setError} />}
          {edit && r.decision !== 'Rejected' && (
            <div className="vm-form" style={{ marginTop: 12 }}>
              <h4>Update this repair</h4>
              {r.nextStage && (
                <div style={{ marginBottom: 10 }}>
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={moveStep}>{r.nextStageButton}</button>
                  <span className="cell-muted"> &nbsp;moves it to &ldquo;{r.nextStage}&rdquo;. One step at a time.</span>
                </div>
              )}
              <div className="vm-grid">
                <label>Estimate (before GST)<input type="text" inputMode="decimal" value={form.estimateCost} disabled={!estimateOpen} onChange={set('estimateCost')} placeholder="for example 1500" /></label>
                <label>GST on the estimate<input type="text" inputMode="decimal" value={form.estimateGst} disabled={!estimateOpen} onChange={set('estimateGst')} /></label>
                <label>Expected back on<input type="date" value={form.expectedDate} disabled={!estimateOpen} onChange={set('expectedDate')} /></label>
                <label>Final cost (before GST)<input type="text" inputMode="decimal" value={form.finalCost} disabled={!afterArrival} onChange={set('finalCost')} placeholder={afterArrival ? 'for example 1400' : 'after the asset reaches you'} /></label>
                <label>GST on the final cost<input type="text" inputMode="decimal" value={form.finalGst} disabled={!afterArrival} onChange={set('finalGst')} /></label>
                <label>Invoice number<input type="text" value={form.invoiceNo} maxLength={80} disabled={!afterArrival} onChange={set('invoiceNo')} /></label>
              </div>
              <label style={{ display: 'block', marginTop: 8 }}>Remark for the company<textarea rows={2} maxLength={1000} value={form.remarks} onChange={set('remarks')} style={{ width: '100%' }} placeholder="What you found, what you did, anything they should know" /></label>
              <div style={{ marginTop: 8 }}><button type="button" className="btn btn-primary" disabled={busy} onClick={saveDetails}>{busy ? 'Saving...' : 'Save'}</button></div>

              <h4 style={{ marginTop: 16 }}>Invoice file</h4>
              {afterArrival ? (
                <div className="vm-row">
                  <input key={fileKey} type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files && e.target.files[0] ? e.target.files[0] : null)} aria-label="Invoice file" />
                  <button type="button" className="btn" disabled={busy || !file} onClick={upload}>{r.hasInvoice ? 'Replace the invoice' : 'Attach the invoice'}</button>
                  <span className="cell-muted">PDF, JPG or PNG, up to 5 MB.</span>
                </div>
              ) : <p className="cell-muted">You can attach the invoice after the asset has reached you.</p>}
              <div className="vm-row" style={{ marginTop: 8 }}>
                <UploadBillButton repairId={id} label="Upload bill for this repair" className="btn" onDone={onChanged} />
                <span className="cell-muted">A photo of a handwritten or printed bill. We read it; Accounts checks it. See it in Invoices, My bills.</span>
              </div>
              {r.canSendInvoice && (
                <div className="vm-row" style={{ marginTop: 8 }}>
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={sendToAccounts}>Send the invoice to Accounts</button>
                  <span className="cell-muted">Accounts checks it, pays it, and the status here updates by itself. You cannot mark it paid.</span>
                </div>
              )}
            </div>
          )}
          {!d.canEdit && <p className="cell-muted" style={{ marginTop: 10 }}>Your login can only look at repairs. Ask the company if you need to update them.</p>}

          <h4 style={{ margin: '14px 0 6px' }}>History of this repair</h4>
          <HistoryList rows={d.history} />
          {d.assetRepairs.length > 0 && (
            <>
              <h4 style={{ margin: '14px 0 6px' }}>Earlier and other repairs of this asset</h4>
              <div className="tbl-wrap vp-scroll"><table>
                <thead><tr><th>Repair</th><th>Problem</th><th>Reported</th><th>Step</th><th className="num">Final cost</th></tr></thead>
                <tbody>{d.assetRepairs.map((x) => <tr key={x.id}><td><strong>{x.repairNo}</strong></td><td>{x.issue || '-'}</td><td>{day(x.dateReported)}</td><td><StepTag step={x.stage} /></td><td className="num">{rs(x.finalTotal)}</td></tr>)}</tbody>
              </table></div>
              <h4 style={{ margin: '14px 0 6px' }}>History of this asset</h4>
              <HistoryList rows={d.assetHistory} showRepair />
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

// ---- STAGE C (28 Oct 2026): accept / reject, the work, proof files, replacement, HRMS tickets ------------------------------
const BUCKET_TABS = [['Active', 'Active'], ['Awaiting your action', 'Awaiting your action'], ['In progress', 'In progress'], ['Waiting for approval', 'Waiting for approval'], ['Completed', 'Completed'], ['Closed', 'Closed'], ['', 'All']];

function DecisionBox({ url, onDone, onError }) {
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  async function go(decision) {
    setBusy(true); onError('');
    try { const r = await vendorApi.post(`${url}/decision`, { decision, reason: reason.trim() }); onDone(r.data, r.data.message); } catch (e) { onError(vendorError(e, 'Could not send your answer.')); } finally { setBusy(false); }
  }
  return (
    <div className="vm-form" style={{ marginTop: 12 }}>
      <h4>Can you take this repair?</h4>
      {!rejecting ? (
        <div className="vm-row">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => go('Accepted')}>Accept</button>
          <button type="button" className="btn" disabled={busy} onClick={() => setRejecting(true)}>Reject</button>
          <span className="cell-muted">Accept, then press &ldquo;Asset received&rdquo; when it reaches you.</span>
        </div>
      ) : (
        <div>
          <label style={{ display: 'block' }}>Why can you not take it?<textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: '100%' }} placeholder="For example: no parts for this model" /></label>
          <div className="vm-row" style={{ marginTop: 6 }}>
            <button type="button" className="btn btn-primary" disabled={busy || reason.trim().length < 5} onClick={() => go('Rejected')}>Send: I cannot take it</button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setRejecting(false)}>Back</button>
          </div>
        </div>
      )}
    </div>
  );
}

const WORK_KEYS = ['partsCost', 'labourCost', 'startDate', 'completedDate', 'outcome', 'workPerformed', 'resolutionNotes'];
const workForm = (r) => ({ partsCost: r.partsCost ?? '', labourCost: r.labourCost ?? '', startDate: r.startDate || '', completedDate: r.completedDate || '', outcome: r.outcome || '', workPerformed: r.workPerformed || '', resolutionNotes: r.resolutionNotes || '' });
function WorkBox({ url, r, outcomes, onDone, onError }) {
  const [form, setForm] = useState(() => workForm(r));
  const [busy, setBusy] = useState(false);
  useEffect(() => { setForm(workForm(r)); }, [r]);
  const set = (k) => (e) => setForm((x) => ({ ...x, [k]: e.target.value }));
  const finished = ['Completed', 'Returned'].includes(r.stage);
  async function save() {
    const body = changedFields(form, workForm(r), WORK_KEYS);
    if (!Object.keys(body).length) { onDone({}, 'Nothing was changed.'); return; }
    setBusy(true); onError('');
    try { const res = await vendorApi.post(`${url}/work`, body); onDone(res.data, [res.data.message, ...(res.data.hints || [])].join(' ')); } catch (e) { onError(vendorError(e, 'Could not save the work.')); } finally { setBusy(false); }
  }
  return (
    <div className="vm-form" style={{ marginTop: 12 }}>
      <h4>The work</h4>
      <div className="vm-grid">
        <label>Parts cost<input type="text" inputMode="decimal" value={form.partsCost} onChange={set('partsCost')} placeholder="for example 1200" /></label>
        <label>Labour cost<input type="text" inputMode="decimal" value={form.labourCost} onChange={set('labourCost')} placeholder="for example 300" /></label>
        <label>Repair started on<input type="date" value={form.startDate} onChange={set('startDate')} /></label>
        <label>Repair finished on<input type="date" value={form.completedDate} disabled={!finished} onChange={set('completedDate')} title={finished ? '' : 'After you press "Repair done"'} /></label>
        <div className="vm-outcome"><span>Outcome</span><div className="vp-seg" role="radiogroup" aria-label="Outcome">{outcomes.map((o) => <button type="button" key={o} role="radio" aria-checked={form.outcome === o} className={`vp-chip${form.outcome === o ? ' on' : ''}`} onClick={() => setForm((x) => ({ ...x, outcome: x.outcome === o ? '' : o }))}>{o}</button>)}</div></div>
      </div>
      <label style={{ display: 'block', marginTop: 8 }}>Work done<textarea rows={2} maxLength={1000} value={form.workPerformed} onChange={set('workPerformed')} style={{ width: '100%' }} placeholder="What you repaired or replaced" /></label>
      <label style={{ display: 'block', marginTop: 8 }}>Notes for the company<textarea rows={2} maxLength={1000} value={form.resolutionNotes} onChange={set('resolutionNotes')} style={{ width: '100%' }} /></label>
      <div style={{ marginTop: 8 }}><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving...' : 'Save the work'}</button></div>
    </div>
  );
}

function ProofList({ proofs, onError }) {
  const openProof = async (p) => { try { await openVendorFile({ kind: 'repair-proof', id: p.id }); } catch (e) { onError(vendorError(e, 'Could not open the file.')); } };
  return (
    <ul className="vp-files">
      {proofs.map((p) => <li key={p.id}><button type="button" className="link-btn" onClick={() => openProof(p)}>{p.name}</button> <span className="cell-muted">{p.kind === 'earlier invoice' ? 'Earlier invoice · ' : ''}{day(p.at)}{p.note ? ` · ${p.note}` : ''}</span></li>)}
    </ul>
  );
}
function ProofBox({ url, proofs, onDone, onError }) {
  const [file, setFile] = useState(null);
  const [note, setNote] = useState('');
  const [key, setKey] = useState(0);
  const [busy, setBusy] = useState(false);
  async function upload() {
    if (!file) return;
    setBusy(true); onError('');
    try {
      const fd = new FormData(); fd.append('file', file); if (note.trim()) fd.append('note', note.trim());
      const r = await vendorApi.post(`${url}/proof`, fd);
      setFile(null); setNote(''); setKey((k) => k + 1); onDone(r.data, r.data.message);
    } catch (e) { onError(vendorError(e, 'Could not add the file.')); } finally { setBusy(false); }
  }
  return (
    <div className="vm-form" style={{ marginTop: 12 }}>
      <h4>Photos and proof of the work ({proofs.length})</h4>
      {proofs.length > 0 && <ProofList proofs={proofs} onError={onError} />}
      <div className="vm-row">
        <input key={key} type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files && e.target.files[0] ? e.target.files[0] : null)} aria-label="Proof file" />
        <input type="text" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What is this? (for example: after repair)" aria-label="About this file" />
        <button type="button" className="btn" disabled={busy || !file} onClick={upload}>Add the file</button>
      </div>
      <p className="cell-muted">Every file is kept. PDF, JPG or PNG.</p>
    </div>
  );
}

function ReplacementBox({ url, onDone, onError }) {
  const [openBox, setOpenBox] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  async function send() {
    setBusy(true); onError('');
    try { const r = await vendorApi.post(`${url}/replacement`, { reason: reason.trim() }); setOpenBox(false); setReason(''); onDone(r.data, r.data.message); } catch (e) { onError(vendorError(e, 'Could not send.')); } finally { setBusy(false); }
  }
  return (
    <div className="vm-form" style={{ marginTop: 12 }}>
      <h4>Cannot be repaired?</h4>
      {!openBox ? (
        <div className="vm-row"><button type="button" className="btn" onClick={() => setOpenBox(true)}>Ask for a replacement</button><span className="cell-muted">The company approves it and records the new asset. The old asset is kept.</span></div>
      ) : (
        <div>
          <label style={{ display: 'block' }}>Why can it not be repaired?<textarea rows={2} maxLength={800} value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: '100%' }} /></label>
          <div className="vm-row" style={{ marginTop: 6 }}>
            <button type="button" className="btn btn-primary" disabled={busy || reason.trim().length < 5} onClick={send}>Send to the company</button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setOpenBox(false)}>Back</button>
          </div>
        </div>
      )}
    </div>
  );
}

// HRMS TICKETS: every asset ticket raised in HRMS on one of your assets. A "Repair" ticket the company approves becomes a repair job.
function Tickets() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const load = useCallback(() => {
    vendorApi.get('/asset-portal/tickets', { params: { q: q || undefined, state: state || undefined } })
      .then((r) => { setData(r.data); setError(''); }).catch((e) => setError(vendorError(e, 'Could not load the tickets.')));
  }, [q, state]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  const fresh = useAutoRefresh(load, data);
  const rows = data?.rows || [];
  return (
    <>
      <p className="cell-muted">Problems employees reported in HRMS on your assets. When the company approves a repair, it becomes a job in Repairs.</p>
      {error && <div className="notice red" style={{ marginBottom: 10 }}><span>{error}</span></div>}
      {fresh.text && <div className="cell-muted vio-updated" role="status">{fresh.text}</div>}
      <div className="vp-filters" role="search">
        <input className="vp-search" type="search" placeholder="Search ticket, asset or problem" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search tickets" />
        <div className="vp-seg">
          <button type="button" className={`vp-chip${state === '' ? ' on' : ''}`} onClick={() => setState('')}>All ({data?.all || 0})</button>
          {(data?.states || []).map((s) => <button type="button" key={s.value} className={`vp-chip${state === s.value ? ' on' : ''}`} onClick={() => setState(s.value)}>{s.value === 'Open' ? 'Waiting for the company' : s.value} ({s.count})</button>)}
        </div>
      </div>
      {!data ? <div className="empty-mini">Loading&hellip;</div> : !rows.length ? (
        <div className="vp-empty"><h3>No tickets</h3><p>When an employee reports a problem with one of your assets, it shows here.</p></div>
      ) : (
        <div className="tbl-wrap vp-scroll"><table>
          <thead><tr><th>Ticket</th><th>Asset</th><th>Need</th><th>Problem</th><th>Raised by</th><th>Raised on</th><th>State</th><th>Repair job</th></tr></thead>
          <tbody>{rows.map((t) => (
            <tr key={t.ticketRef}>
              <td><strong>{t.ticketRef}</strong>{t.priority ? <div className="cell-muted">{t.priority}</div> : null}</td>
              <td>{t.assetCode} &middot; {t.assetName}</td>
              <td>{t.kind}</td>
              <td>{t.issue || '-'}</td>
              <td>{t.raisedBy ? <>{t.raisedBy.name}<div className="cell-muted">{[t.raisedBy.employeeCode, t.raisedBy.department].filter(Boolean).join(' · ')}</div></> : '-'}</td>
              <td>{day(t.raisedAt)}</td>
              <td>{t.state === 'Open' ? 'Waiting for the company' : t.state}{t.decidedAt ? <div className="cell-muted">{day(t.decidedAt)}</div> : null}</td>
              <td>{t.repairNo || '-'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}
