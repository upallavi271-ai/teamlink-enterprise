import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import Combo from '../../components/Combo.jsx';
import BillSteps from '../../components/BillSteps.jsx';
import { STATUS_TONE, STATUS_WORDS, liveTotals, parseMoney } from '../vendor/billUploadLogic.js';
import '../vendor/vendorPortal.css';
import '../vendor/billUploads.css';

// ---------------------------------------------------------------------------
// ACCOUNTS -> Office & Accounts -> Bills from vendors -> "Uploaded bills (AI read)" (2026-10-21).
// Repair bills that vendors UPLOADED as photos / scans / PDFs, handwritten or printed. The picture is on one side, what was read from it on the
// other. Anything the AI was not sure about is amber ("Check this") and empty if it could not be read - never guessed. Nothing is approved
// by itself: a person ticks what they checked, then Approve & send to Accounts. Approving adds ONE vendor bill and ONE payable (Pending to pay,
// never paid) and puts the verified invoice no., amounts and date on the repair record. It never marks the repair finished. Server: routes/vendorBillUploads.js.
// ---------------------------------------------------------------------------
const inr = (n) => (n === null || n === undefined || n === '' ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
const two = (n) => String(n).padStart(2, '0');
const day = (s) => {
  if (!s) return '—';
  const d = new Date(String(s).length === 10 ? `${s}T00:00:00` : s);
  return Number.isNaN(d.getTime()) ? String(s) : `${two(d.getDate())}-${two(d.getMonth() + 1)}-${d.getFullYear()}`;
};
const errText = (e, f) => (e?.response ? e.response.data?.error || f : 'Cannot reach the server. Try again.');
const U = '/vendor-bills/uploads';
const MODES = ['Bank Transfer', 'UPI', 'Cash', 'Credit Card', 'Debit Card', 'Cheque', 'Other'];
const CHIPS = [['NEEDS_REVIEW', 'Needs review'], ['PENDING_APPROVAL', 'Waiting for approval'], ['APPROVED', 'Approved'], ['SYNCED', 'Synced'], ['REJECTED', 'Rejected'], ['NOT_SENT', 'Not sent yet']];

export function AiLight({ ai }) {
  if (!ai) return null;
  return (
    <div className={`bu-notice${ai.ready ? '' : ' red'}`} style={{ margin: '0 0 10px' }} role="status">
      <strong>AI bill reading: {ai.ready ? 'Ready' : 'Not set up'}.</strong>{' '}
      {ai.ready ? `Bills are read by ${ai.provider === 'claude-vision' ? 'Claude' : ai.provider}${ai.model ? ` (${ai.model})` : ''}. A person still approves every bill.`
        : 'Vendors can still upload bills. Nothing is read automatically: you type the details from the picture. To switch it on: Administration → Integrations → AI Assistant → add the Anthropic key.'}
    </div>
  );
}

// ---- the list ---------------------------------------------------------------------------------------------------------------------------
export default function UploadedBills({ onChanged, onCounts }) {
  const [d, setD] = useState(null);
  const [status, setStatus] = useState('NEEDS_REVIEW');
  const [vendorId, setVendorId] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    api.get(U, { params: { status: status || undefined, vendorId: vendorId || undefined, q: q || undefined } })
      .then((r) => { setD(r.data); setErr(''); if (onCounts) onCounts(r.data.waiting); })
      .catch((e) => { if (e.response?.status !== 403) setErr(errText(e, 'Could not load the uploaded bills.')); });
  }, [status, vendorId, q, onCounts]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => { const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (!msg) return undefined; const t = setTimeout(() => setMsg(''), 5000); return () => clearTimeout(t); }, [msg]);
  if (!d) return <div className="empty-mini">Loading&hellip;</div>;
  const count = Object.fromEntries((d.facets.status || []).map((x) => [x.value, x.count]));
  return (
    <>
      <AiLight ai={d.ai} />
      {msg && <div className="notice green" style={{ marginBottom: 8 }}><span>{msg}</span></div>}
      {err && <div className="notice red" style={{ marginBottom: 8 }}><span>{err}</span></div>}
      <div className="vb-bar">
        <div className="vb-status">
          {CHIPS.map(([k, label]) => (
            <button type="button" key={k} className={`vb-chip vb-${STATUS_TONE[k]}${status === k ? ' on' : ''}`} onClick={() => setStatus(status === k ? '' : k)}>{label} <b>{count[k] || 0}</b></button>
          ))}
        </div>
        <Combo value={vendorId} onChange={(e) => setVendorId(e.target.value)} aria-label="Vendor">
          <option value="">All vendors</option>
          {(d.facets.vendor || []).map((v) => <option key={v.value} value={v.value}>{v.label} ({v.count})</option>)}
        </Combo>
        <input type="search" placeholder="Search bill, invoice no., vendor, asset" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search uploaded bills" />
      </div>
      {!d.rows.length ? (
        <div className="empty-mini">{status ? `No uploaded bill is "${STATUS_WORDS[status].toLowerCase()}" right now.` : 'No uploaded bill matches.'}</div>
      ) : (
        <div className="tbl-wrap vb-table">
          <table className="bu-table">
            <thead><tr><th>Bill</th><th>Vendor</th><th>Repair / asset</th><th>Invoice no.</th><th>Invoice date</th><th className="num">Total</th><th>Checks</th><th>Status</th><th /></tr></thead>
            <tbody>
              {d.rows.map((b) => (
                <tr key={b.id}>
                  <td className="vb-nowrap"><strong>{b.code}</strong>{b.version > 1 ? <span className="cell-muted"> v{b.version}</span> : null}
                    <div className="cell-muted">{day(String(b.uploadedAt).slice(0, 10))} &middot; {b.fileCount} file{b.fileCount === 1 ? '' : 's'}</div>
                    {b.aiBadge && <span className="vb-src">{b.aiBadge}</span>}</td>
                  <td className="bu-name-wrap">{b.vendorName}</td>
                  <td className="bu-name-wrap">{b.repairNo || '—'}<div className="cell-muted">{b.assetCode ? `${b.assetCode} · ${b.assetName || ''}` : 'asset not chosen'}</div></td>
                  <td>{b.invoiceNo || '—'}</td>
                  <td>{day(b.invoiceDate)}</td>
                  <td className="num"><strong>{inr(b.total)}</strong></td>
                  <td>{b.flagCount ? <span className="bu-chip">{b.flagCount} to check</span> : <span className="bu-chip ok">clear</span>}</td>
                  <td><span className={`vp-tag vp-${STATUS_TONE[b.status]}`}>{b.statusLabel}</span>{b.syncError ? <div className="vb-red cell-muted">sync did not finish</div> : null}</td>
                  <td><button type="button" className="btn btn-sm" onClick={() => setOpen(b.id)}>{['NEEDS_REVIEW', 'PENDING_APPROVAL'].includes(b.status) && d.access?.canReview ? 'Check' : 'View'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <UploadReview id={open} onClose={() => { setOpen(null); load(); }} onDone={(m, booked) => { setOpen(null); setMsg(m); load(); if (booked && onChanged) onChanged(); }} />}
    </>
  );
}

// ---- the bill picture(s) ------------------------------------------------------------------------------------------------------------------
function Viewer({ id, files }) {
  const [urls, setUrls] = useState({});
  const [page, setPage] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [err, setErr] = useState('');
  const keep = useRef({});
  useEffect(() => {
    let live = true;
    files.forEach((f) => {
      if (keep.current[f.id]) return;
      api.get(`${U}/${id}/files/${f.id}?inline=1`, { responseType: 'blob' })
        .then((r) => { const u = URL.createObjectURL(r.data); keep.current[f.id] = u; if (live) setUrls((x) => ({ ...x, [f.id]: u })); })
        .catch(() => { if (live) setErr('Could not load the bill picture.'); });
    });
    return () => { live = false; };
  }, [id, files]);
  useEffect(() => () => { Object.values(keep.current).forEach((u) => URL.revokeObjectURL(u)); keep.current = {}; }, []);
  const f = files[page] || files[0];
  const url = f ? urls[f.id] : null;
  const isPdf = f && f.mime === 'application/pdf';
  return (
    <div className="bur-viewer">
      <div className="bur-viewer-bar">
        {files.length > 1 && files.map((x, i) => <button type="button" key={x.id} className={`btn btn-sm${i === page ? ' btn-primary' : ''}`} onClick={() => setPage(i)}>Page {i + 1}</button>)}
        {!isPdf && (
          <>
            <button type="button" className="btn btn-sm" onClick={() => setZoom((z) => Math.max(40, z - 20))} aria-label="Zoom out">&minus;</button>
            <span className="cell-muted">{zoom}%</span>
            <button type="button" className="btn btn-sm" onClick={() => setZoom((z) => Math.min(400, z + 20))} aria-label="Zoom in">+</button>
            <button type="button" className="btn btn-sm" onClick={() => setZoom(100)}>Fit</button>
          </>
        )}
        {f && <span className="cell-muted bu-name-wrap">{f.name}</span>}
      </div>
      <div className="bur-viewer-body">
        {err && <div className="notice red"><span>{err}</span></div>}
        {!url && !err && <div className="empty-mini">Loading the bill&hellip;</div>}
        {url && (isPdf ? <iframe title={`Bill ${f.name}`} src={url} /> : <img src={url} alt={`Bill page ${page + 1}`} style={{ width: `${zoom}%` }} />)}
      </div>
    </div>
  );
}

// ---- the review window ------------------------------------------------------------------------------------------------------------------------
const FIELDS = [
  ['invoiceNo', 'Invoice number', 'text'], ['invoiceDate', 'Invoice date', 'date'], ['serviceDate', 'Repair date', 'date'], ['assetRef', 'Asset ID / serial on the bill', 'text'],
  ['vendorNameOnBill', 'Vendor name on the bill', 'text'], ['subtotal', 'Amount before GST', 'money'], ['gst', 'GST', 'money'], ['total', 'Total', 'money'],
];
const PARTS = [['cgst', 'CGST'], ['sgst', 'SGST'], ['igst', 'IGST']];
const toForm = (u) => ({
  ...Object.fromEntries([...FIELDS.map(([k]) => k), ...PARTS.map(([k]) => k)].map((k) => [k, u.fields[k] == null ? '' : String(u.fields[k])])),
  workDescription: u.fields.workDescription || '', repairId: u.repair ? u.repair.id : '', assetId: u.asset ? u.asset.id : '',
  lines: u.lines.map((l) => ({ description: l.description || '', quantity: l.quantity == null ? '' : String(l.quantity), rate: l.rate == null ? '' : String(l.rate), amount: l.amount == null ? '' : String(l.amount), unclear: !!l.unclear })),
});
const sameLines = (a, b) => a.length === b.length && a.every((l, i) => ['description', 'quantity', 'rate', 'amount'].every((k) => (l[k] || '').trim() === (b[i][k] || '').trim()));

function UploadReview({ id, onClose, onDone }) {
  const [d, setD] = useState(null);
  const [access, setAccess] = useState({});
  const [aiReady, setAiReady] = useState(false);
  const [form, setForm] = useState(null);
  const [checked, setChecked] = useState({});
  const [notDup, setNotDup] = useState(false);
  const [cats, setCats] = useState([]);
  const [ap, setAp] = useState({ category: '', paymentMode: 'Bank Transfer', dueDate: '', reviewNote: '' });
  const [panel, setPanel] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const fill = (u) => { setD(u); setForm(toForm(u)); setAp((x) => ({ ...x, category: x.category || u.defaultCategory || '', reviewNote: x.reviewNote || u.review.reviewNote || '' })); };
  useEffect(() => {
    api.get(`${U}/${id}`).then((r) => { fill(r.data.upload); setAccess(r.data.access || {}); setAiReady(!!(r.data.ai && r.data.ai.ready)); }).catch((e) => setError(errText(e, 'Could not open this bill.')));
    api.get('/office-expenses/categories').then((r) => setCats((r.data || []).map((c) => c.name))).catch(() => {});
  }, [id]);
  const inReview = d && ['NEEDS_REVIEW', 'PENDING_APPROVAL'].includes(d.status);
  const canEdit = inReview && access.canEdit;
  const canReview = inReview && access.canReview;
  const set = (k) => (e) => setForm((x) => ({ ...x, [k]: e.target.value }));
  const setLine = (i, k, v) => setForm((x) => ({ ...x, lines: x.lines.map((l, j) => (j === i ? { ...l, [k]: v, unclear: false } : l)) }));
  const live = useMemo(() => (form ? liveTotals(form, form.lines) : null), [form]);

  const diff = () => {
    if (!d || !form) return {};
    const body = {};
    [...FIELDS, ...PARTS.map(([k, l]) => [k, l, 'money'])].forEach(([k, , type]) => {
      const cur = d.fields[k] == null ? '' : String(d.fields[k]);
      const now = (form[k] || '').trim();
      if (now !== cur) { body[k] = now === '' ? null : now; if (type === 'money' && now && parseMoney(now) === null) body.__bad = k; }
    });
    if ((form.workDescription || '').trim() !== (d.fields.workDescription || '')) body.workDescription = form.workDescription.trim() || null;
    if (form.repairId !== (d.repair ? d.repair.id : '')) body.repairId = form.repairId || null;
    else if (form.assetId !== (d.asset ? d.asset.id : '')) body.assetId = form.assetId || null;
    if (!sameLines(toForm(d).lines, form.lines)) body.lines = form.lines.map((l) => ({ description: l.description, quantity: l.quantity, rate: l.rate, amount: l.amount }));
    return body;
  };
  const dirty = !!d && !!form && Object.keys(diff()).length > 0;

  async function save() {
    const body = diff();
    if (body.__bad) { setError('Write the amounts as numbers, like 1500 or 1,500.50.'); return null; }
    if (!Object.keys(body).length) return d;
    setBusy(true); setError(''); setMsg('');
    try {
      const r = await api.patch(`${U}/${id}`, { ...body, updatedAt: d.updatedAt });
      fill(r.data.upload); setMsg('Saved. Your changes are in the history.');
      return r.data.upload;
    } catch (e) { setError(errText(e, 'Could not save.')); return null; } finally { setBusy(false); }
  }
  // flags still open (server's words), the ones a person may tick, and the ones that must be fixed
  const openFlags = (u) => (u ? u.flags.filter((f) => (f.level === 'block' || f.level === 'check') && !f.acked) : []);
  async function approve() {
    let u = d;
    if (dirty) { u = await save(); if (!u) return; }
    const left = openFlags(u).filter((f) => !(f.level === 'check' && checked[f.key]) && !(f.code === 'duplicate' && notDup));
    if (left.length) { setError(`${left.length === 1 ? 'One thing is' : `${left.length} things are`} still open: ${left[0].message}${left.length > 1 ? ' …' : ''}`); return; }
    setBusy(true); setError('');
    try {
      const r = await api.post(`${U}/${id}/approve`, {
        acknowledge: openFlags(u).filter((f) => f.level === 'check' && checked[f.key]).map((f) => f.key), confirmNotDuplicate: notDup && openFlags(u).some((f) => f.code === 'duplicate'),
        category: ap.category, paymentMode: ap.paymentMode, dueDate: ap.dueDate || undefined, reviewNote: ap.reviewNote || undefined,
      });
      onDone(r.data.message, true);
    } catch (e) {
      if (e.response?.data?.unresolved) setError(e.response.data.error);
      else setError(errText(e, 'Could not approve.'));
    } finally { setBusy(false); }
  }
  async function post(path, body, okMsg) {
    setBusy(true); setError('');
    try { const r = await api.post(`${U}/${id}/${path}`, body || {}); if (path === 'reread') { setMsg(r.data.message); fill(r.data.upload); } else onDone(r.data.message || okMsg, false); } catch (e) { setError(errText(e, 'Could not do that.')); } finally { setBusy(false); }
  }

  const fieldFlag = (k) => (d ? d.flags.filter((f) => f.field === k && (f.level === 'check' || f.level === 'block') && !f.acked) : []);
  const unclearField = (k) => !!(d && d.fieldMeta[k] && d.fieldMeta[k].unclear);
  const cand = d?.candidates || { repairs: [], assets: [] };
  const open = openFlags(d);

  let foot = <button type="button" className="btn" onClick={onClose}>Close</button>;
  if (canReview && !panel) {
    foot = (
      <>
        {aiReady && access.canEdit && <button type="button" className="btn" disabled={busy || dirty} onClick={() => post('reread')} title={dirty ? 'Save your changes first' : 'Read the bill again with AI; what you typed stays'}>Read with AI again</button>}
        {access.canEdit && <button type="button" className="btn" disabled={busy} onClick={() => { setPanel('back'); setText(''); }}>Send back to vendor</button>}
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => { setPanel('reject'); setText(''); }}>Reject</button>
        {canEdit && <button type="button" className="btn" disabled={busy || !dirty} onClick={save}>Save changes</button>}
        <button type="button" className="btn btn-primary" disabled={busy} onClick={approve}>{busy ? 'Working…' : 'Approve & send to Accounts'}</button>
      </>
    );
  } else if (panel) {
    foot = (
      <>
        <button type="button" className="btn" onClick={() => setPanel('')}>Back</button>
        {panel === 'reject'
          ? <button type="button" className="btn btn-danger" disabled={busy || text.trim().length < 3} onClick={() => post('reject', { reason: text })}>Reject bill</button>
          : <button type="button" className="btn btn-primary" disabled={busy || text.trim().length < 3} onClick={() => post('send-back', { note: text })}>Send back</button>}
      </>
    );
  } else if (d && d.status === 'APPROVED' && access.canReview) {
    foot = (<><button type="button" className="btn" onClick={onClose}>Close</button><button type="button" className="btn btn-primary" disabled={busy} onClick={() => post('retry-sync', {}, 'Synced.')}>Try the sync again</button></>);
  }

  return (
    <Modal title={d ? `Uploaded bill ${d.code}${d.version > 1 ? ` (version ${d.version})` : ''}` : 'Uploaded bill'} note={d ? d.vendor.name : ''} size="xwide" onClose={onClose} footer={foot}>
      {error && <div className="notice red" style={{ marginBottom: 8 }}><span>{error}</span></div>}
      {msg && <div className="notice green" style={{ marginBottom: 8 }}><span>{msg}</span></div>}
      {!d && !error && <div className="empty-mini">Loading&hellip;</div>}
      {d && form && (
        <>
          <BillSteps status={d.status} />
          <div className="bur-split">
            <Viewer id={id} files={d.files} />
            <div>
              <p className="cell-muted" style={{ marginTop: 0 }}>
                <span className={`vp-tag vp-${STATUS_TONE[d.status]}`}>{d.statusLabel}</span>{' '}
                Uploaded {day(String(d.uploadedAt).slice(0, 10))} by {d.uploadedByName}.{' '}
                {d.ai.state === 'done' ? 'Read by AI: check the amber boxes against the picture.' : d.ai.state ? 'Not read by AI: type the details from the picture.' : ''}
                {d.remarks ? <> Vendor&apos;s remark: &ldquo;{d.remarks}&rdquo;.</> : null}
              </p>
              {d.review.sentBackNote && d.status === 'NOT_SENT' && <div className="bu-notice">Sent back to the vendor: {d.review.sentBackNote}</div>}
              {d.review.rejectionReason && <div className="bu-notice red">Rejected: {d.review.rejectionReason}</div>}
              {d.sync.syncError && <div className="bu-notice red">The sync did not finish: {d.sync.syncError}</div>}
              {d.sync.billCode && <p className="cell-muted">Vendor bill <strong>{d.sync.billCode}</strong>{d.sync.expenseCode ? <> &middot; payable <strong>{d.sync.expenseCode}</strong> (not paid)</> : null}. The repair record has the verified invoice number, amounts and date; its repair step and the asset status were not changed.</p>}

              {inReview && open.length > 0 && (
                <div className="vm-block" style={{ marginTop: 0 }}>
                  <h4>Before you approve</h4>
                  {open.map((f) => (
                    <div className="bur-ack" key={`${f.key}-${f.sig || ''}`}>
                      {f.level === 'check' || f.code === 'duplicate' ? (
                        <input type="checkbox" id={`ack-${f.key}`} checked={f.code === 'duplicate' ? notDup : !!checked[f.key]} disabled={!canReview}
                          onChange={(e) => (f.code === 'duplicate' ? setNotDup(e.target.checked) : setChecked((x) => ({ ...x, [f.key]: e.target.checked })))} />
                      ) : <span aria-hidden="true">&#9888;</span>}
                      <label htmlFor={`ack-${f.key}`}>
                        <span className="bu-chip">{f.level === 'block' && f.code !== 'duplicate' ? 'Must be fixed' : 'Check this'}</span>{' '}
                        {f.message}
                        {f.code === 'duplicate' ? <strong> Tick if this is NOT the same bill.</strong> : (f.level === 'check' ? <span className="cell-muted"> Tick when you have checked it on the bill.</span> : null)}
                      </label>
                    </div>
                  ))}
                </div>
              )}
              {inReview && open.length === 0 && <div className="bu-notice" style={{ borderColor: '#0F6B4F', background: '#e5f0ea' }}>Nothing is open. It still needs your approval.</div>}
              {d.flags.filter((f) => f.level === 'info').map((f) => <div key={`${f.code}-${f.field}`} className="cell-muted" style={{ fontSize: 12 }}>&#8505; {f.message}</div>)}

              <div className="vm-grid" style={{ marginTop: 10 }}>
                {FIELDS.map(([k, label, type]) => {
                  const m = d.fieldMeta[k] || {};
                  const marked = unclearField(k);
                  const fl = fieldFlag(k);
                  return (
                    <label key={k} className={`bu-field${marked ? ' bu-unclear' : (fl.length ? ' bu-flag' : '')}`}>
                      <span className="bu-lab">{label}{marked || fl.length ? <span className="bu-chip">Check this</span> : null}
                        {m.confidence != null && !m.edited ? <span className="bur-conf">AI {Math.round(m.confidence * 100)}%</span> : null}
                        {m.edited ? <span className="bur-edited">typed by {m.by === 'Vendor' ? 'the vendor' : 'Accounts'}{m.aiValue !== undefined ? ` (AI read: ${m.aiValue == null ? 'nothing' : m.aiValue})` : ''}</span> : null}
                        {m.derived ? <span className="bur-conf">worked out</span> : null}
                      </span>
                      {type === 'date'
                        ? <input type="date" value={form[k]} disabled={!canEdit} onChange={set(k)} />
                        : <input type="text" inputMode={type === 'money' ? 'decimal' : undefined} value={form[k]} disabled={!canEdit} onChange={set(k)} placeholder={marked ? 'Not readable — type it from the bill' : ''} />}
                      {m.note ? <span className="cell-muted">AI note: {m.note}</span> : null}
                    </label>
                  );
                })}
              </div>
              <details style={{ marginTop: 6 }} open={PARTS.some(([k]) => form[k])}>
                <summary className="cell-muted">GST parts (CGST / SGST / IGST)</summary>
                <div className="vm-grid">
                  {PARTS.map(([k, label]) => <label key={k} className="bu-field"><span className="bu-lab">{label}</span><input type="text" inputMode="decimal" value={form[k]} disabled={!canEdit} onChange={set(k)} /></label>)}
                </div>
              </details>
              <label className="bu-field" style={{ marginTop: 8 }}><span className="bu-lab">Repair work</span><textarea rows={2} maxLength={1000} value={form.workDescription} disabled={!canEdit} onChange={set('workDescription')} /></label>

              <h4 style={{ margin: '12px 0 6px' }}>Items on the bill</h4>
              <div className="tbl-wrap vp-scroll">
                <table className="bu-lines">
                  <thead><tr><th>#</th><th>What</th><th>Quantity</th><th>Rate</th><th>Amount</th>{canEdit && <th />}</tr></thead>
                  <tbody>
                    {form.lines.map((l, i) => (
                      <tr key={i} className={l.unclear ? 'bu-unclear' : undefined}>
                        <td>{i + 1}{l.unclear ? <span className="bu-chip">Check this</span> : null}</td>
                        <td className="bu-desc"><input type="text" value={l.description} maxLength={300} disabled={!canEdit} onChange={(e) => setLine(i, 'description', e.target.value)} aria-label={`Line ${i + 1} what`} /></td>
                        <td><input type="text" inputMode="decimal" value={l.quantity} disabled={!canEdit} onChange={(e) => setLine(i, 'quantity', e.target.value)} aria-label={`Line ${i + 1} quantity`} /></td>
                        <td><input type="text" inputMode="decimal" value={l.rate} disabled={!canEdit} onChange={(e) => setLine(i, 'rate', e.target.value)} aria-label={`Line ${i + 1} rate`} /></td>
                        <td><input type="text" inputMode="decimal" value={l.amount} disabled={!canEdit} onChange={(e) => setLine(i, 'amount', e.target.value)} aria-label={`Line ${i + 1} amount`} /></td>
                        {canEdit && <td><button type="button" className="btn btn-sm btn-ghost" onClick={() => setForm((x) => ({ ...x, lines: x.lines.filter((_, j) => j !== i) }))}>Remove</button></td>}
                      </tr>
                    ))}
                    {!form.lines.length && <tr><td colSpan={6} className="cell-muted">No items were read.</td></tr>}
                  </tbody>
                </table>
              </div>
              {canEdit && <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => setForm((x) => ({ ...x, lines: [...x.lines, { description: '', quantity: '', rate: '', amount: '', unclear: false }] }))}>Add a line</button>}
              {live && (
                <div className="bu-live" role="status">
                  {live.lineProblems.length > 0 && <div className="warn">Line {live.lineProblems.join(', ')}: quantity x rate is not the amount written.</div>}
                  {live.linesVsSubtotal ? <div className={live.linesVsSubtotal.ok ? 'ok' : 'warn'}>{live.linesVsSubtotal.text}</div> : <div className="cell-muted">Lines total: {live.linesSum === null ? 'fill every line amount to see it' : live.linesSum}</div>}
                  {live.totalVsParts && <div className={live.totalVsParts.ok ? 'ok' : 'warn'}>{live.totalVsParts.text}</div>}
                </div>
              )}

              <div className="vm-grid" style={{ marginTop: 12 }}>
                <label className="bu-field"><span className="bu-lab">Repair record</span>
                  <Combo value={form.repairId} onChange={(e) => setForm((x) => ({ ...x, repairId: e.target.value }))} disabled={!canEdit} aria-label="Repair" placeholder="Type to search">
                    <option value="">Not chosen</option>
                    {(d.repair && !cand.repairs.some((r) => r.id === d.repair.id) ? [{ id: d.repair.id, repairNo: d.repair.repairNo, assetCode: d.asset ? d.asset.assetCode : '', issue: d.repair.issue }] : []).concat(cand.repairs).map((r) => <option key={r.id} value={r.id}>{r.repairNo} &middot; {r.assetCode}{r.issue ? ` · ${String(r.issue).slice(0, 40)}` : ''}</option>)}
                  </Combo>
                </label>
                {!form.repairId && (
                  <label className="bu-field"><span className="bu-lab">Asset</span>
                    <Combo value={form.assetId} onChange={(e) => setForm((x) => ({ ...x, assetId: e.target.value }))} disabled={!canEdit} aria-label="Asset" placeholder="Type to search">
                      <option value="">Not chosen</option>
                      {cand.assets.map((a) => <option key={a.id} value={a.id}>{a.assetCode} &middot; {a.name}{a.serialNumber ? ` · ${a.serialNumber}` : ''}</option>)}
                    </Combo>
                  </label>
                )}
              </div>
              {d.repair && <p className="cell-muted" style={{ marginBottom: 0 }}>Repair {d.repair.repairNo} ({d.repair.status}){d.repair.estimateTotal != null ? ` · vendor estimate ${inr(d.repair.estimateTotal)}` : ''}{d.repair.cost ? ` · cost on record ${inr(d.repair.cost)}` : ''}.</p>}

              {canReview && !panel && (
                <div className="vm-block">
                  <h4>When you approve</h4>
                  <div className="vm-grid">
                    <label className="bu-field"><span className="bu-lab">Category</span>
                      <Combo creatable value={ap.category} onChange={(e) => setAp((x) => ({ ...x, category: e.target.value }))} aria-label="Category">
                        <option value="">Pick&hellip;</option>
                        {cats.map((c) => <option key={c} value={c}>{c}</option>)}
                      </Combo>
                    </label>
                    <label className="bu-field"><span className="bu-lab">Payment mode</span>
                      <Combo value={ap.paymentMode} onChange={(e) => setAp((x) => ({ ...x, paymentMode: e.target.value }))} aria-label="Payment mode">{MODES.map((m) => <option key={m} value={m}>{m}</option>)}</Combo>
                    </label>
                    <label className="bu-field"><span className="bu-lab">Pay by (if you know)</span><input type="date" value={ap.dueDate} onChange={(e) => setAp((x) => ({ ...x, dueDate: e.target.value }))} /></label>
                  </div>
                  <label className="bu-field" style={{ marginTop: 6 }}><span className="bu-lab">Note (stays with Accounts)</span><input type="text" maxLength={1000} value={ap.reviewNote} onChange={(e) => setAp((x) => ({ ...x, reviewNote: e.target.value }))} /></label>
                  <p className="cell-muted" style={{ marginBottom: 0 }}>Approving adds ONE vendor bill and ONE payable (&ldquo;Pending to pay&rdquo;, not paid) and updates the repair record. The bank statement decides when it is paid.</p>
                </div>
              )}
              {panel === 'reject' && (
                <div className="vm-block"><h4>Why is it rejected? The vendor will see this.</h4><textarea rows={3} style={{ width: '100%' }} value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: this invoice is for another company" /></div>
              )}
              {panel === 'back' && (
                <div className="vm-block"><h4>What should the vendor correct? The vendor will see this.</h4><textarea rows={3} style={{ width: '100%' }} value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: please upload a clearer photo of the last page" /></div>
              )}

              <h4 style={{ margin: '14px 0 6px' }}>History</h4>
              <ul className="vm-hist">
                {d.history.slice(0, 40).map((h) => (
                  <li key={h.id}>
                    <strong>{h.by}</strong>{' '}
                    {h.kind === 'edit' && h.field ? `changed ${h.field}: ${h.from ?? '-'} → ${h.to ?? '-'}` : (h.note || h.kind)}
                    {!h.visibleToVendor ? <span className="cell-muted"> (Accounts only)</span> : null}
                    <span className="cell-muted"> &middot; {day(String(h.at).slice(0, 10))} {String(h.at).slice(11, 16)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
