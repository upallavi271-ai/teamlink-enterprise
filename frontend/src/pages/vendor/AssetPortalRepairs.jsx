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

// REPAIRS & HRMS TICKETS (one of the four modules, 27 Oct 2026): Repairs | Repair history (the old /history address opens the second tab)
export default function AssetPortalRepairs() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'history' ? 'history' : 'repairs';
  const go = (t) => { const n = new URLSearchParams(params); if (t === 'repairs') n.delete('tab'); else n.set('tab', t); n.delete('open'); setParams(n, { replace: true }); };
  return (
    <VendorShell title="Repairs & HRMS Tickets" sub="The repairs the company has given you: update each step, add your estimate, final cost and invoice. Every change is in Repair history.">
      <div className="vp-seg vio-tabs" role="tablist" aria-label="Repairs or history">
        <button type="button" role="tab" aria-selected={tab === 'repairs'} className={`vp-chip${tab === 'repairs' ? ' on' : ''}`} onClick={() => go('repairs')}>Repairs</button>
        <button type="button" role="tab" aria-selected={tab === 'history'} className={`vp-chip${tab === 'history' ? ' on' : ''}`} onClick={() => go('history')}>Repair history</button>
      </div>
      {tab === 'history' ? <HistoryBody /> : <Body />}
    </VendorShell>
  );
}

function Body() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [f, setF] = useState({ q: '', stage: params.get('stage') || '', category: '', payment: '', from: '', to: '', sort: 'dateReported', dir: 'desc', page: 1 });
  const [qDeb, setQDeb] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(params.get('open') || null);
  useEffect(() => { const t = setTimeout(() => setQDeb(f.q), 250); return () => clearTimeout(t); }, [f.q]);
  const load = useCallback(() => {
    vendorApi.get('/asset-portal/repairs', { params: { q: qDeb || undefined, stage: f.stage || undefined, category: f.category || undefined, payment: f.payment || undefined, from: f.from || undefined, to: f.to || undefined, sort: f.sort, dir: f.dir, page: f.page } })
      .then((r) => { setData(r.data); setError(''); }).catch((e) => setError(vendorError(e, 'Could not load your repairs.')));
  }, [qDeb, f.stage, f.category, f.payment, f.from, f.to, f.sort, f.dir, f.page]);
  useEffect(() => { load(); }, [load]);
  const fresh = useAutoRefresh(load, data); // a repair the company approves in HRMS shows here by itself, no reload
  const set = (patch) => setF((x) => ({ ...x, page: 1, ...patch }));
  const close = () => { setOpen(null); if (params.get('open')) setParams({}, { replace: true }); };
  const rows = data?.rows || [];
  const filtered = !!(f.q || f.stage || f.category || f.payment || f.from || f.to);
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
        <div className="vp-seg">
          <button type="button" className={`vp-chip${f.stage === '' ? ' on' : ''}`} onClick={() => set({ stage: '' })}>All</button>
          {[...STEPS, 'Cancelled'].map((st) => {
            const n = (data?.stages.find((x) => x.value === st) || {}).count || 0;
            return n || f.stage === st ? <button type="button" key={st} className={`vp-chip${f.stage === st ? ' on' : ''}`} onClick={() => set({ stage: st })}>{st} ({n})</button> : null;
          })}
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
        {filtered && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setF({ q: '', stage: '', category: '', payment: '', from: '', to: '', sort: 'dateReported', dir: 'desc', page: 1 })}>Clear</button>}
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
                    <td><StepTag step={r.stage} /></td>
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
          </dl>
          {r.inCompanyBooks && <div className="notice amber" style={{ marginTop: 10 }}><span>This repair is already in the company&apos;s books. If you change the cost or invoice, the change goes to Accounts to review. It does not change their books by itself.</span></div>}

          {edit && (
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
