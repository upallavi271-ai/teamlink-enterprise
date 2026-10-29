import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { shrinkAll } from './shrinkPhoto.js';
import PhotoPicker from './PhotoPicker.jsx'; // Take a photo / Choose photos / Choose PDF (2026-10-28)
import BillLineAssets, { PaymentBlock, ItemCells } from './BillLineAssets.jsx'; // each item -> asset -> who had it on the bill date / now (2026-10-28) // phone photos made small (JPG) before upload - founder 2026-10-28
import vendorApi, { vendorError } from '../../vendorApi';
import Modal from '../../components/Modal.jsx';
import Combo from '../../components/Combo.jsx';
import BillSteps from '../../components/BillSteps.jsx';
import { openVendorFile } from './VendorShell.jsx';
import VendorPager from './VendorPager.jsx';
import { VendorIoBar } from './VendorIo.jsx';
import { day } from './vendorFormat.js';
import { rs, HistoryList } from './assetPortalCommon.jsx';
import {
  STATUS_TONE, STATUS_WORDS, STATUS_HELP, pickFiles, newIdemKey, liveTotals, parseMoney, LIMITS,
} from './billUploadLogic.js';
import './vendorModules.css';
import './billUploads.css';

// UPLOAD REPAIR BILL (Assets Vendor Portal, 2026-10-21). The vendor takes a photo of a handwritten or printed bill (or picks a scan / PDF), chooses
// the repair, and sends it. The bill is read in the background; the vendor sees where it is, can correct what was read wrongly, and can replace the
// file - until Accounts approves it. Nothing here approves, pays or posts anything: the server decides, this file only draws it.
const B = '/asset-portal/bill-uploads';
const FIELDS = [
  ['invoiceNo', 'Invoice number', 'text'], ['invoiceDate', 'Invoice date', 'date'], ['serviceDate', 'Repair date (if written)', 'date'], ['assetRef', 'Asset ID or serial number', 'text'],
  ['vendorNameOnBill', 'Your name on the bill', 'text'], ['subtotal', 'Amount before GST', 'money'], ['gst', 'GST', 'money'], ['total', 'Total', 'money'],
];

export function StatusTag({ status, label }) {
  return <span className={`vp-tag vp-${STATUS_TONE[status] || 'grey'}`}>{label || STATUS_WORDS[status] || status}</span>;
}

// ---- the button (Repairs page, a repair's window, Invoices page) --------------------------------------------------------------------
export function UploadBillButton({ repairId = null, label = 'Upload repair bill', className = 'btn btn-primary', onDone }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>{label}</button>
      {open && <UploadWindow repairId={repairId} onClose={() => setOpen(false)} onDone={onDone} />}
    </>
  );
}

// ---- the upload window --------------------------------------------------------------------------------------------------------------
export function UploadWindow({ repairId = null, correctsId = null, onClose, onDone }) {
  const [opts, setOpts] = useState(null);
  const [repair, setRepair] = useState(repairId || '');
  const [asset, setAsset] = useState('');
  const [files, setFiles] = useState([]);
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);
  const key = useRef(newIdemKey());
  const urls = useRef(new Map());
  useEffect(() => { vendorApi.get(`${B}/options`).then((r) => setOpts(r.data)).catch((e) => setError(vendorError(e, 'Could not open the upload window.'))); }, []);
  useEffect(() => () => { urls.current.forEach((u) => URL.revokeObjectURL(u)); }, []);
  const previewOf = (f) => {
    if (!/^image\//.test(f.type)) return null;
    if (!urls.current.has(f)) urls.current.set(f, URL.createObjectURL(f));
    return urls.current.get(f);
  };
  const [preparing, setPreparing] = useState(false);
  const [progress, setProgress] = useState(null);
  const add = async (list) => {
    setPreparing(true); setError('');
    const s = await shrinkAll(Array.from(list || [])); // every photo becomes a small JPG first (big phone photos and HEIC used to be refused)
    setPreparing(false);
    const r = pickFiles(files, s.files, { maxFiles: opts?.limits.maxFiles || LIMITS.maxFiles, maxBytes: (opts?.limits.maxMb || 10) * 1048576 });
    setFiles(r.files); setError([...s.problems, r.error].filter(Boolean).join(' '));
  };
  const removeAt = (i) => setFiles((x) => { const f = x[i]; if (urls.current.has(f)) { URL.revokeObjectURL(urls.current.get(f)); urls.current.delete(f); } return x.filter((_, j) => j !== i); });
  const repairName = (r) => `${r.repairNo} · ${r.assetCode}${r.issue ? ` · ${r.issue.slice(0, 50)}` : ''}${r.open ? '' : ' (finished)'}`;
  const send = async (submit) => {
    if (busy) return;
    if (!files.length) { setError('Choose a photo or a PDF of the bill first.'); return; }
    setBusy(true); setError('');
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append('file', f, f.name));
      if (repair) fd.append('repairId', repair); else if (asset) fd.append('assetId', asset);
      if (remarks.trim()) fd.append('remarks', remarks.trim());
      if (!submit) fd.append('submit', 'false');
      const url = correctsId ? `${B}/${encodeURIComponent(correctsId)}/correct` : B;
      setProgress(0);
      const r = await vendorApi.post(url, fd, { headers: { 'Idempotency-Key': key.current }, timeout: 0, onUploadProgress: (ev) => { if (ev.total) setProgress(Math.round((ev.loaded / ev.total) * 100)); } });
      setDone(r.data);
      if (onDone) onDone(r.data.upload);
    } catch (e) {
      const st = e && e.response && e.response.status;
      setError(st === 413 ? 'The files are too big to send together. Send fewer pages at a time.' : vendorError(e, 'Could not upload the bill. Check the internet and try again.'));
    } finally { setBusy(false); setProgress(null); }
  };
  if (done) {
    const u = done.upload;
    return (
      <Modal title="Bill uploaded" onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>Close</button>}>
        <div className="notice green" style={{ marginBottom: 10 }}><span>{done.message}</span></div>
        <BillSteps status={u.status} />
        <p className="cell-muted">Bill {u.code}{u.repair ? ` for repair ${u.repair.repairNo}` : ''}. You can see it any time in <strong>My Bills</strong>. Until Accounts approves it, you can correct what we read wrongly or replace the file.</p>
      </Modal>
    );
  }
  return (
    <Modal
      title={correctsId ? 'Upload a corrected bill' : 'Upload repair bill'}
      size="wide"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" disabled={busy || !files.length} onClick={() => send(false)}>Save without sending</button>
          <button type="button" className="btn btn-primary" disabled={busy || !files.length} onClick={() => send(true)}>{busy ? (progress != null && progress < 100 ? `Uploading ${progress}%` : 'Uploading...') : 'Upload and send'}</button>
        </>
      )}
    >
      {error && <div className="notice red" style={{ marginBottom: 8 }}><span>{error}</span></div>}
      {!opts && !error && <div className="empty-mini">Loading&hellip;</div>}
      {opts && !opts.canEdit && <div className="notice amber"><span>Your login can only look. Ask the company to allow editing so you can upload bills.</span></div>}
      {opts && opts.canEdit && (
        <div className="vm-form" style={{ border: 'none', padding: 0, margin: 0 }}>
          <div className="vm-grid">
            <label className="bu-field"><span className="bu-lab">Which repair is this bill for?</span>
              <Combo value={repair} onChange={(e) => { setRepair(e.target.value); if (e.target.value) setAsset(''); }} aria-label="Repair" placeholder="Type to search">
                <option value="">Not linked to a repair yet</option>
                {opts.repairs.map((r) => <option key={r.id} value={r.id}>{repairName(r)}</option>)}
              </Combo>
            </label>
            {!repair && (
              <label className="bu-field"><span className="bu-lab">Which asset? (ID or serial number)</span>
                <Combo value={asset} onChange={(e) => setAsset(e.target.value)} aria-label="Asset" placeholder="Type to search">
                  <option value="">I do not know / the bill shows it</option>
                  {opts.assets.map((a) => <option key={a.id} value={a.id}>{a.code} &middot; {a.name}{a.serialNumber ? ` · ${a.serialNumber}` : ''}</option>)}
                </Combo>
              </label>
            )}
          </div>
          <div className="bu-drop" style={{ marginTop: 12 }}>
            <div className="vm-row">
              <PhotoPicker multiple sheets onPick={(l) => add(l)} />
              <span className="cell-muted">Handwritten or printed. Any phone photo, a PDF or an Excel / CSV file. Up to {opts.limits.maxFiles} files (pages). Photos are made smaller before sending. One bill with many pages = add every page.</span>
              {preparing && <span className="cell-muted" role="status">Getting the photos ready&hellip;</span>}
            </div>
            {files.length > 0 && (
              <div className="bu-thumbs">
                {files.map((f, i) => (
                  <div className="bu-thumb" key={`${f.name}-${f.size}-${f.lastModified}`}>
                    {previewOf(f) ? <img src={previewOf(f)} alt={`Page ${i + 1}`} /> : <div className="bu-pdf">{/\.(xlsx|xls|csv)$/i.test(f.name) ? 'EXCEL' : 'PDF'}</div>}
                    <div className="bu-name">{i + 1}. {f.name}</div>
                    <button type="button" aria-label={`Remove ${f.name}`} onClick={() => removeAt(i)}>&times;</button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <label className="bu-field" style={{ marginTop: 10 }}><span className="bu-lab">Remark for Accounts (if any)</span>
            <textarea rows={2} maxLength={500} value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Anything they should know about this bill" />
          </label>
          <p className="cell-muted" style={{ marginBottom: 0 }}>{opts.aiOn ? 'We read the bill for you. You can correct anything that is wrong.' : 'Accounts will read the bill and type the details.'} Nothing is paid until Accounts approves the bill.</p>
        </div>
      )}
    </Modal>
  );
}

// ---- MY BILLS (a tab on the Invoices page) -----------------------------------------------------------------------------------------
export function MyBills({ onChanged, showUpload = true }) {
  const [data, setData] = useState(null);
  const [f, setF] = useState({ q: '', status: '', from: '', to: '', sort: 'uploadedAt', dir: 'desc', page: 1 });
  const [qDeb, setQDeb] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  const [correct, setCorrect] = useState(null);
  useEffect(() => { const t = setTimeout(() => setQDeb(f.q), 250); return () => clearTimeout(t); }, [f.q]);
  const load = useCallback(() => {
    vendorApi.get(B, { params: { q: qDeb || undefined, status: f.status || undefined, from: f.from || undefined, to: f.to || undefined, sort: f.sort, dir: f.dir, page: f.page } })
      .then((r) => { setData(r.data); setError(''); }).catch((e) => setError(vendorError(e, 'Could not load your bills.')));
  }, [qDeb, f.status, f.from, f.to, f.sort, f.dir, f.page]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]); // a bill that is being read moves on by itself
  const set = (patch) => setF((x) => ({ ...x, page: 1, ...patch }));
  const rows = data?.rows || [];
  const s = data?.summary;
  const filtered = !!(f.q || f.status || f.from || f.to);
  const changed = () => { load(); if (onChanged) onChanged(); };
  return (
    <>
      {error && <div className="notice red" style={{ marginBottom: 10 }}><span>{error} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>}
      {showUpload ? (
        <div className="vm-row" style={{ marginBottom: 10 }}>
          <UploadBillButton onDone={changed} />
          <span className="cell-muted">Photo of a handwritten or printed bill. Accounts checks it before anything is added to your invoices.</span>
        </div>
      ) : <p className="cell-muted" style={{ marginTop: 0 }}>Photos and PDFs of the bills you uploaded. Accounts checks each one before anything is added to your invoices.</p>}
      {s && (
        <div className="vp-tiles">
          <div className="vp-tile"><span>Bills uploaded</span><b>{s.count}</b></div>
          <div className="vp-tile orange"><span>With Accounts</span><b>{s.waiting}</b></div>
          <div className="vp-tile green"><span>Approved</span><b>{s.approved}</b></div>
          <div className="vp-tile"><span>Need you</span><b>{s.needsYou}</b></div>
        </div>
      )}
      <VendorIoBar list="bill-uploads" params={{ ...f, q: qDeb }} />
      <div className="vp-filters" role="search">
        <input className="vp-search" type="search" placeholder="Search bill, invoice number, repair or asset" value={f.q} onChange={(e) => set({ q: e.target.value })} aria-label="Search" />
        <Combo value={f.status} onChange={(e) => set({ status: e.target.value })} aria-label="Status">
          <option value="">Any status</option>
          {(data?.facets.status || []).map((o) => <option key={o.value} value={o.value}>{o.label} ({o.count})</option>)}
        </Combo>
        <div className="vp-dates">
          <input type="date" aria-label="Uploaded from" value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.target.value })} />
          <span className="vp-to">to</span>
          <input type="date" aria-label="Uploaded to" value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.target.value })} />
        </div>
        <Combo value={f.sort} onChange={(e) => set({ sort: e.target.value })} aria-label="Sort by">
          <option value="uploadedAt">Sort: Uploaded on</option><option value="invoiceDate">Sort: Invoice date</option><option value="total">Sort: Total</option>
          <option value="status">Sort: Step</option><option value="invoiceNo">Sort: Invoice number</option>
        </Combo>
        <button type="button" className="btn btn-sm" onClick={() => set({ dir: f.dir === 'asc' ? 'desc' : 'asc' })}>{f.dir === 'asc' ? 'Oldest first' : 'Newest first'}</button>
        {filtered && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setF({ q: '', status: '', from: '', to: '', sort: 'uploadedAt', dir: 'desc', page: 1 })}>Clear</button>}
      </div>
      {!data ? <div className="empty-mini">Loading&hellip;</div> : !rows.length ? (
        <div className="vp-empty">{data.all ? <><h3>No bill matches</h3><p>Clear the search to see all {data.all}.</p></> : <><h3>No bills uploaded yet</h3><p>Press &ldquo;Upload repair bill&rdquo; and take a photo of your bill.</p></>}</div>
      ) : (
        <>
          <div className="tbl-wrap vp-scroll">
            <table className="bu-table">
              <thead><tr><th>Bill</th><th>Uploaded</th><th>Asset name</th><th>Assigned to</th><th>Asset match</th><th>Repair</th><th>Asset</th><th>Invoice number</th><th>Invoice date</th><th className="num">Total</th><th>Status</th><th>Note</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="vp-row-click" onClick={() => setOpen(r.id)}>
                    <td className={r.isNew ? 'bu-row-new' : undefined}><strong>{r.code}</strong>{r.version > 1 ? <span className="cell-muted"> v{r.version}</span> : null}{r.isNew ? <span className="bu-new">New</span> : null}<div className="cell-muted">{r.fileCount} file{r.fileCount === 1 ? '' : 's'}</div></td>
                    <td>{day(String(r.uploadedAt).slice(0, 10))}</td>
                    <ItemCells items={r.items} />
                    <td>{r.repairNo || '-'}</td>
                    <td className="bu-name-wrap">{r.assetCode ? `${r.assetCode} · ${r.assetName || ''}` : '-'}</td>
                    <td>{r.invoiceNo || '-'}</td>
                    <td>{day(r.invoiceDate)}</td>
                    <td className="num">{r.total == null ? '-' : rs(r.total)}</td>
                    <td><StatusTag status={r.status} label={r.statusLabel} /></td>
                    <td className="bu-name-wrap">{r.reason ? <span className="vp-why">{r.reason}</span> : '-'}</td>
                    <td><button type="button" className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setOpen(r.id); }}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <VendorPager data={data} onPage={(page) => setF((x) => ({ ...x, page }))} />
        </>
      )}
      {open && <BillDetail id={open} onClose={() => { setOpen(null); changed(); }} onChanged={changed} onOpen={setOpen} onCorrect={(u) => { setOpen(null); setCorrect(u); }} />}
      {correct && <UploadWindow repairId={correct.repair ? correct.repair.id : null} correctsId={correct.id} onClose={() => setCorrect(null)} onDone={changed} />}
    </>
  );
}

// ---- one bill ----------------------------------------------------------------------------------------------------------------------------
const toForm = (u) => ({
  ...Object.fromEntries(FIELDS.map(([k]) => [k, u.fields[k] == null ? '' : String(u.fields[k])])),
  workDescription: u.fields.workDescription || '', remarks: u.remarks || '',
  repairId: u.repair ? u.repair.id : '', assetId: u.asset ? u.asset.id : '',
  lines: u.lines.map((l) => ({ description: l.description || '', quantity: l.quantity == null ? '' : String(l.quantity), rate: l.rate == null ? '' : String(l.rate), amount: l.amount == null ? '' : String(l.amount), unclear: !!l.unclear })),
});

function BillDetail({ id, onClose, onChanged, onOpen, onCorrect }) {
  const [d, setD] = useState(null);
  const [form, setForm] = useState(null);
  const [opts, setOpts] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [repl, setRepl] = useState(null);
  const [replKey, setReplKey] = useState(0);
  const fill = (u) => { setD(u); setForm(toForm(u)); };
  useEffect(() => { vendorApi.get(`${B}/${encodeURIComponent(id)}`).then((r) => fill(r.data.upload)).catch((e) => setError(vendorError(e, 'Could not open this bill.'))); }, [id]);
  useEffect(() => { vendorApi.get(`${B}/options`).then((r) => setOpts(r.data)).catch(() => {}); }, []);
  const u = d;
  const can = u?.can || {};
  const set = (k) => (e) => setForm((x) => ({ ...x, [k]: e.target.value }));
  const setLine = (i, k, v) => setForm((x) => ({ ...x, lines: x.lines.map((l, j) => (j === i ? { ...l, [k]: v, unclear: false } : l)) }));
  const live = useMemo(() => (form ? liveTotals(form, form.lines) : null), [form]);

  function diff() {
    const body = {};
    FIELDS.forEach(([k, , type]) => {
      const cur = u.fields[k] == null ? '' : String(u.fields[k]);
      if ((form[k] || '').trim() !== cur) body[k] = form[k].trim() === '' ? null : form[k].trim();
      if (type === 'money' && body[k] && parseMoney(body[k]) === null) body.__bad = k;
    });
    if ((form.workDescription || '').trim() !== (u.fields.workDescription || '')) body.workDescription = form.workDescription.trim() || null;
    if ((form.remarks || '').trim() !== (u.remarks || '')) body.remarks = form.remarks.trim();
    if (form.repairId !== (u.repair ? u.repair.id : '')) body.repairId = form.repairId || null;
    else if (form.assetId !== (u.asset ? u.asset.id : '') && !form.repairId) body.assetId = form.assetId || null;
    const curLines = toForm(u).lines;
    const same = curLines.length === form.lines.length && curLines.every((l, i) => ['description', 'quantity', 'rate', 'amount'].every((k) => (l[k] || '').trim() === (form.lines[i][k] || '').trim()));
    if (!same) body.lines = form.lines.map((l) => ({ description: l.description, quantity: l.quantity, rate: l.rate, amount: l.amount }));
    return body;
  }
  async function save() {
    const body = diff();
    if (body.__bad) { setError(`Please write the ${FIELDS.find(([k]) => k === body.__bad)[1].toLowerCase()} as a number, like 1500 or 1,500.50.`); return; }
    if (!Object.keys(body).length) { setMsg('Nothing was changed.'); return; }
    setBusy(true); setError(''); setMsg('');
    try {
      const r = await vendorApi.patch(`${B}/${encodeURIComponent(id)}`, { ...body, updatedAt: u.updatedAt });
      fill(r.data.upload); setMsg(r.data.message || 'Saved.'); onChanged();
    } catch (e) { setError(vendorError(e, 'Could not save.')); } finally { setBusy(false); }
  }
  async function send() {
    setBusy(true); setError(''); setMsg('');
    try {
      if (Object.keys(diff()).filter((k) => k !== '__bad').length) await save();
      const r = await vendorApi.post(`${B}/${encodeURIComponent(id)}/submit`, {});
      fill(r.data.upload); setMsg(r.data.message || 'Sent.'); onChanged();
    } catch (e) { setError(vendorError(e, 'Could not send the bill.')); } finally { setBusy(false); }
  }
  async function replace() {
    if (!repl) { setError('Choose the new file first.'); return; }
    setBusy(true); setError(''); setMsg('');
    try {
      const fd = new FormData(); fd.append('file', repl, repl.name);
      const r = await vendorApi.post(`${B}/${encodeURIComponent(id)}/replace`, fd, { headers: { 'Idempotency-Key': newIdemKey() } });
      setRepl(null); setReplKey((k) => k + 1); onChanged(); onOpen(r.data.upload.id);
    } catch (e) { setError(vendorError(e, 'Could not replace the file.')); } finally { setBusy(false); }
  }
  const openFile = (f) => openVendorFile({ kind: 'bill-upload', id: `${id}:${f.id}` }).catch((e) => setError(vendorError(e, 'Could not open the file.')));
  const repairName = (r) => `${r.repairNo} · ${r.assetCode}${r.issue ? ` · ${r.issue.slice(0, 40)}` : ''}`;
  const unclear = new Set(u?.unclear || []);
  const noticeFor = (k) => (u?.notices || []).filter((n) => n.field === k);

  return (
    <Modal title={u ? `Bill ${u.code}${u.version > 1 ? ` (version ${u.version})` : ''}` : 'Bill'} size="xwide" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      {error && <div className="notice red" style={{ marginBottom: 8 }}><span>{error}</span></div>}
      {msg && <div className="notice green" style={{ marginBottom: 8 }}><span>{msg}</span></div>}
      {!u && !error && <div className="empty-mini">Loading&hellip;</div>}
      {u && form && (
        <div className="vp-detail">
          <BillSteps status={u.status} />
          <p className="cell-muted" style={{ marginTop: 0 }}><strong>{STATUS_WORDS[u.status]}.</strong> {STATUS_HELP[u.status]}{u.reading.text && ['NEEDS_REVIEW', 'PENDING_APPROVAL'].includes(u.status) ? ` ${u.reading.text}` : ''}</p>
          {u.sentBackNote && <div className="bu-notice"><strong>Accounts sent this back:</strong> {u.sentBackNote}</div>}
          {u.rejectionReason && <div className="bu-notice red"><strong>Why it was rejected:</strong> {u.rejectionReason}</div>}
          {u.correctsCode && <p className="cell-muted">This is the corrected bill for {u.correctsCode}.</p>}
          {u.invoiceCode && <p className="cell-muted">It is in your invoices as <strong>{u.invoiceCode}</strong>. Payment follows the company&apos;s usual process.</p>}
          {(u.notices || []).filter((n) => !n.field || !FIELDS.some(([k]) => k === n.field)).map((n) => <div className="bu-notice" key={`${n.code}-${n.field}`}>{n.message}</div>)}

          <h4 style={{ margin: '12px 0 6px' }}>The bill</h4>
          <div className="vm-row">
            {u.files.map((f, i) => <button type="button" className="btn btn-sm" key={f.id} onClick={() => openFile(f)}>Open page {i + 1}: {f.name}</button>)}
            <span className="cell-muted">Uploaded {day(String(u.uploadedAt).slice(0, 10))}{u.repair ? ` · repair ${u.repair.repairNo}` : ''}{u.asset ? ` · ${u.asset.code} ${u.asset.name || ''}` : ''}</span>
          </div>

          <h4 style={{ margin: '14px 0 6px' }}>What was read from the bill{can.edit ? ' (correct anything that is wrong)' : ''}</h4>
          <div className="vm-grid">
            {FIELDS.map(([k, label, type]) => {
              const marked = unclear.has(k);
              const ns = noticeFor(k);
              return (
                <label key={k} className={`bu-field${marked ? ' bu-unclear' : (ns.length ? ' bu-flag' : '')}`}>
                  <span className="bu-lab">{label}{marked || ns.length ? <span className="bu-chip">Check this</span> : null}</span>
                  {type === 'date'
                    ? <input type="date" value={form[k]} disabled={!can.edit} onChange={set(k)} />
                    : <input type="text" inputMode={type === 'money' ? 'decimal' : undefined} value={form[k]} maxLength={type === 'text' ? 160 : 20} disabled={!can.edit} onChange={set(k)} placeholder={marked ? 'Could not read this. Please type it.' : ''} />}
                  {ns.map((n) => <span key={n.code} className="cell-muted" style={{ color: '#a85a00' }}>{n.message}</span>)}
                </label>
              );
            })}
          </div>
          <label className="bu-field" style={{ marginTop: 8 }}><span className="bu-lab">Repair work</span>
            <textarea rows={2} maxLength={1000} value={form.workDescription} disabled={!can.edit} onChange={set('workDescription')} />
          </label>

          <h4 style={{ margin: '14px 0 6px' }}>Items on the bill</h4>
          <div className="tbl-wrap vp-scroll">
            <table className="bu-lines">
              <thead><tr><th>#</th><th>What</th><th>Quantity</th><th>Rate</th><th>Amount</th>{can.edit && <th />}</tr></thead>
              <tbody>
                {form.lines.map((l, i) => (
                  <tr key={i} className={l.unclear ? 'bu-unclear' : undefined}>
                    <td>{i + 1}{l.unclear ? <span className="bu-chip">Check this</span> : null}</td>
                    <td className="bu-desc"><input type="text" value={l.description} maxLength={300} disabled={!can.edit} onChange={(e) => setLine(i, 'description', e.target.value)} aria-label={`Line ${i + 1} what`} /></td>
                    <td><input type="text" inputMode="decimal" value={l.quantity} disabled={!can.edit} onChange={(e) => setLine(i, 'quantity', e.target.value)} aria-label={`Line ${i + 1} quantity`} /></td>
                    <td><input type="text" inputMode="decimal" value={l.rate} disabled={!can.edit} onChange={(e) => setLine(i, 'rate', e.target.value)} aria-label={`Line ${i + 1} rate`} /></td>
                    <td><input type="text" inputMode="decimal" value={l.amount} disabled={!can.edit} onChange={(e) => setLine(i, 'amount', e.target.value)} aria-label={`Line ${i + 1} amount`} /></td>
                    {can.edit && <td><button type="button" className="btn btn-sm btn-ghost" onClick={() => setForm((x) => ({ ...x, lines: x.lines.filter((_, j) => j !== i) }))} aria-label={`Remove line ${i + 1}`}>Remove</button></td>}
                  </tr>
                ))}
                {!form.lines.length && <tr><td colSpan={6} className="cell-muted">No items were read. Add them if you want Accounts to see them.</td></tr>}
              </tbody>
            </table>
          </div>
          <BillLineAssets rows={u.lineAssets} />
          <PaymentBlock p={u.payment} />
          {can.edit && <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => setForm((x) => ({ ...x, lines: [...x.lines, { description: '', quantity: '', rate: '', amount: '', unclear: false }] }))}>Add a line</button>}
          {live && (live.linesVsSubtotal || live.totalVsParts || live.lineProblems.length > 0) && (
            <div className="bu-live" role="status">
              {live.lineProblems.length > 0 && <div className="warn">Line {live.lineProblems.join(', ')}: quantity x rate is not the amount written.</div>}
              {live.linesVsSubtotal && <div className={live.linesVsSubtotal.ok ? 'ok' : 'warn'}>{live.linesVsSubtotal.text}</div>}
              {live.totalVsParts && <div className={live.totalVsParts.ok ? 'ok' : 'warn'}>{live.totalVsParts.text}</div>}
            </div>
          )}

          {can.edit && (
            <div className="vm-grid" style={{ marginTop: 12 }}>
              <label className="bu-field"><span className="bu-lab">Repair</span>
                <Combo value={form.repairId} onChange={(e) => setForm((x) => ({ ...x, repairId: e.target.value }))} aria-label="Repair" placeholder="Type to search">
                  <option value="">Not linked to a repair yet</option>
                  {(opts?.repairs || []).map((r) => <option key={r.id} value={r.id}>{repairName(r)}</option>)}
                </Combo>
              </label>
              {!form.repairId && (
                <label className="bu-field"><span className="bu-lab">Asset</span>
                  <Combo value={form.assetId} onChange={(e) => setForm((x) => ({ ...x, assetId: e.target.value }))} aria-label="Asset" placeholder="Type to search">
                    <option value="">Not chosen</option>
                    {(opts?.assets || []).map((a) => <option key={a.id} value={a.id}>{a.code} &middot; {a.name}</option>)}
                  </Combo>
                </label>
              )}
              <label className="bu-field"><span className="bu-lab">Remark for Accounts</span><input type="text" maxLength={500} value={form.remarks} onChange={set('remarks')} /></label>
            </div>
          )}

          {can.edit && (
            <div className="vm-row" style={{ marginTop: 12 }}>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving...' : 'Save changes'}</button>
              {can.submit && <button type="button" className="btn btn-primary" disabled={busy} onClick={send}>Send to Accounts</button>}
            </div>
          )}
          {can.edit && (
            <div className="vm-block">
              <h4>Wrong file? Replace it</h4>
              <div className="vm-row">
                <PhotoPicker key={replKey} small sheets onPick={(l, problems) => { setRepl(l[0] || null); if (problems.length) setError(problems.join(' ')); }} />{repl && <span className="cell-muted">{repl.name}</span>}
                <button type="button" className="btn" disabled={busy || !repl} onClick={replace}>Replace the file</button>
                <span className="cell-muted">The bill is read again. The old file stays in the history.</span>
              </div>
            </div>
          )}
          {can.correct && <div className="vm-row" style={{ marginTop: 12 }}><button type="button" className="btn btn-primary" onClick={() => onCorrect(u)}>Upload a corrected bill</button><span className="cell-muted">It is sent as a new bill linked to this one.</span></div>}
          {!can.edit && !can.correct && !['SUPERSEDED'].includes(u.status) && <p className="cell-muted" style={{ marginTop: 10 }}>This bill can no longer be changed.</p>}

          <h4 style={{ margin: '14px 0 6px' }}>History</h4>
          <HistoryList rows={u.history} />
        </div>
      )}
    </Modal>
  );
}
