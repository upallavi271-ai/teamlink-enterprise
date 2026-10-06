// ---------------------------------------------------------------------------
// THE CLIENT FORM IN 9 SECTIONS (2026-10-05) — used by Add client and Edit
// client (one form, never two copies).
//
//   1 Client basic details   2 Primary contact   3 Ownership   4 Commercial
//   (open)                   (open)              (open)        (open)
//   5 Agreement details   6 Tax & billing   7 Payment details   8 Documents
//   9 Internal notes      (collapsed)
//
// Each header: a one-line plain hint, "3 of 6 filled", ✓ when its required
// fields are done. Required (*) — only these ten: Company name, Industry,
// Contact name / email / mobile, Department, BDE / Account manager, Fee,
// Payment terms, Replacement guarantee. Everything else is optional.
//
// Fee / guarantee / payment days live in section 4 ONLY; section 5 shows the
// same values, linked, never typed twice. Internal notes (section 9) never
// reach the client (server: utils/clientProfile.js + clientRedact.js).
// The server checks everything again — this is the friendly version.
// ---------------------------------------------------------------------------
import { createContext, useContext, useEffect, useState } from 'react';
import api from '../../api';
import Combo from '../Combo.jsx';
import { Help } from '../ui/Guide.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { deptOptions, LOCS, INDIAN_STATES, CLIENT_INDUSTRIES } from '../../atsVocab';
import './clientForm.css';

export const COMPANY_TYPES = ['Corporate', 'MNC', 'Startup', 'SME', 'Consultancy', 'Other'];
export const SOURCES = ['BDE', 'Referral', 'Website', 'Existing Client', 'Other'];
export const COMM = ['Email', 'WhatsApp', 'Phone'];
export const PAY_METHODS = ['Bank transfer (NEFT / RTGS / IMPS)', 'UPI', 'Cheque', 'Other'];
const FEE_TYPES = [['PERCENT_CTC', '% of annual CTC'], ['FIXED', 'Fixed amount'], ['PER_CANDIDATE', 'Per candidate']];
const DOC_KINDS = [['AGREEMENT', 'Agreement'], ['GST', 'GST certificate'], ['REGISTRATION', 'Company registration'], ['PAN', 'PAN'], ['OTHER', 'Other']];

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;
const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const digits = (v) => String(v || '').replace(/\D/g, '');
const str = (v) => (v === null || v === undefined ? '' : String(v));
const blank = (v) => !String(v ?? '').trim();
const today = () => new Date().toISOString().slice(0, 10);

export function guaranteeWords(d) {
  const n = Number(d);
  if (!Number.isFinite(n) || String(d).trim() === '') return '';
  if (n === 0) return 'No replacement';
  return ({ 30: 'One Month', 60: 'Two Months', 90: 'Three Months' })[n] || `${n} Days`;
}

// ---- form <-> client record -------------------------------------------------
export function emptyClientForm(user, ownerLocked, defaults) {
  const d = defaults || {};
  return {
    name: '', clientCode: '', companyType: '', industry: '', website: '', companyEmail: '', landline: '',
    street: '', area: '', location: LOCS[0], state: '', country: 'India', pincode: '',
    contactName: '', contactDesignation: '', contactEmail: '', contactPhone: '', contactAltPhone: '', contactWhatsApp: '',
    waSame: true, commPrimary: 'Email',
    ownerDepartment: deptOptions(user)[0] || '', bdeOwner: ownerLocked || '', secondaryBde: '', accountManager: '', clientSource: ownerLocked ? 'BDE' : '',
    feeType: 'PERCENT_CTC', agreementFeePercent: str(d.feePercent ?? 8.33), feeAmount: '',
    gstApplicable: 'Yes', gstPercent: '18', tdsApplicable: 'No', tdsPercent: '10',
    paymentDays: str(d.paymentDays ?? 6), invoiceMode: 'after', invoiceDays: '6', invoiceOther: '',
    guaranteeDays: str(d.guaranteeDays ?? 30), replacementTerms: '',
    agreementTemplate: d.templateName || 'Vendor Services Agreement', agreementStart: '', agreementEnd: '', specialTerms: '',
    legalName: '', billingSameAsAddress: true, billingAddress: '', gst: '', pan: '', tan: '', billingEmail: '', invoiceEmail: '',
    billingContactName: '', billingContactPhone: '', billingContactEmail: '',
    paymentMethod: '', paymentBankName: '', paymentUpi: '', paymentReferenceNote: '',
    bankAccountHolder: '', bankAccountNo: '', bankIfsc: '',
    internalNotes: '', specialInstructions: '', recruitmentInstructions: '', internalRemarks: '',
    status: 'Active', activeDate: today(),
  };
}

export function formFromClient(c) {
  const pay = (String(c.paymentTerms || '').match(/within (\d+) days/i) || [])[1];
  const trig = String(c.invoiceTrigger || '').trim();
  let invoiceMode = 'after';
  let invoiceDays = (trig.match(/(\d+)\s*day/i) || String(c.paymentTerms || '').match(/invoice (\d+) days after joining/i) || [])[1] || '6';
  let invoiceOther = '';
  if (/^on joining/i.test(trig)) { invoiceMode = 'on'; invoiceDays = '0'; } else if (trig && !/\d+\s*day/i.test(trig) && !/^candidate joining$/i.test(trig)) { invoiceMode = 'other'; invoiceOther = trig; }
  const g = String(c.guaranteePeriod || '');
  const gm = g.match(/(\d+)\s*(day|month)/i);
  const guaranteeDays = /no replacement/i.test(g) ? '0' : (gm ? String(/month/i.test(gm[2]) ? Number(gm[1]) * 30 : Number(gm[1])) : '30');
  const f = {};
  Object.keys(emptyClientForm(null, null, null)).forEach((k) => { f[k] = str(c[k]); });
  return {
    ...f,
    waSame: !c.contactWhatsApp || digits(c.contactWhatsApp) === digits(c.contactPhone),
    feeType: c.feeType || 'PERCENT_CTC',
    gstApplicable: c.gstApplicable || 'Yes', tdsApplicable: c.tdsApplicable || 'No',
    paymentDays: pay || '6', invoiceMode, invoiceDays, invoiceOther, guaranteeDays,
    billingSameAsAddress: c.billingSameAsAddress !== false && !c.billingAddress,
    bankAccountNo: '',
    country: c.country || 'India',
  };
}

const COMMERCIAL_KEYS = ['agreementFeePercent', 'feeType', 'feeAmount', 'gstApplicable', 'gstPercent', 'tdsApplicable', 'tdsPercent',
  'paymentTerms', 'paymentDue', 'invoiceTrigger', 'guaranteePeriod', 'replacementTerms', 'specialTerms', 'agreementTemplate', 'agreementStart', 'agreementEnd'];

// The body POST / PUT /clients receives.
export function bodyFromForm(f, { canCommercial = true } = {}) {
  const b = {};
  ['name', 'clientCode', 'companyType', 'industry', 'website', 'companyEmail', 'landline', 'street', 'area', 'location', 'state', 'country', 'pincode',
    'contactName', 'contactDesignation', 'contactEmail', 'contactPhone', 'contactAltPhone', 'commPrimary',
    'ownerDepartment', 'bdeOwner', 'secondaryBde', 'accountManager', 'clientSource',
    'replacementTerms', 'agreementTemplate', 'agreementStart', 'agreementEnd', 'specialTerms',
    'legalName', 'billingAddress', 'gst', 'pan', 'tan', 'billingEmail', 'invoiceEmail', 'billingContactName', 'billingContactPhone', 'billingContactEmail',
    'paymentMethod', 'paymentBankName', 'paymentUpi', 'paymentReferenceNote', 'bankAccountHolder', 'bankIfsc',
    'internalNotes', 'specialInstructions', 'recruitmentInstructions', 'internalRemarks', 'status', 'activeDate',
  ].forEach((k) => { if (f[k] !== undefined) b[k] = String(f[k] ?? '').trim(); });
  ['gst', 'pan', 'tan', 'bankIfsc'].forEach((k) => { b[k] = b[k].toUpperCase(); });
  b.contactWhatsApp = f.waSame ? b.contactPhone : String(f.contactWhatsApp || '').trim();
  b.billingSameAsAddress = !!f.billingSameAsAddress;
  if (f.billingSameAsAddress) b.billingAddress = '';
  b.feeType = f.feeType;
  b.agreementFeePercent = f.feeType === 'PERCENT_CTC' ? f.agreementFeePercent : '';
  b.feeAmount = f.feeType === 'PERCENT_CTC' ? '' : f.feeAmount;
  b.gstApplicable = f.gstApplicable;
  b.gstPercent = f.gstApplicable === 'Yes' ? f.gstPercent : '0';
  b.tdsApplicable = f.tdsApplicable;
  b.tdsPercent = f.tdsApplicable === 'Yes' ? f.tdsPercent : '0';
  const d = Number(f.paymentDays);
  const inv = f.invoiceMode === 'on' ? 'Invoice on the joining day' : (f.invoiceMode === 'other' ? `Invoice: ${String(f.invoiceOther || '').trim()}` : `Invoice ${Number(f.invoiceDays) || 0} days after joining`);
  b.invoiceTrigger = f.invoiceMode === 'on' ? 'On joining' : (f.invoiceMode === 'other' ? String(f.invoiceOther || '').trim() : `After joining + ${Number(f.invoiceDays) || 0} days`);
  b.paymentTerms = blank(f.paymentDays) ? '' : `${inv}; payment due within ${d} days of invoice`;
  b.paymentDue = blank(f.paymentDays) ? '' : `${d} days after invoice`;
  const g = Number(f.guaranteeDays);
  b.guaranteePeriod = blank(f.guaranteeDays) ? '' : (g === 0 ? 'No replacement' : `${g} Days`);
  if (String(f.bankAccountNo || '').trim()) b.bankAccountNo = String(f.bankAccountNo).replace(/\s/g, '');
  if (!canCommercial) COMMERCIAL_KEYS.forEach((k) => { delete b[k]; });
  return b;
}

// ---- the sections -----------------------------------------------------------
export const SECTIONS = [
  { id: 'basic', title: '1. Client basic details', hint: 'Who the client company is and where it is', required: ['name', 'industry'],
    fields: ['name', 'clientCode', 'companyType', 'industry', 'website', 'companyEmail', 'landline', 'street', 'location', 'state', 'country', 'pincode'] },
  { id: 'contact', title: '2. Primary contact', hint: 'Who we talk to at the client', required: ['contactName', 'contactEmail', 'contactPhone'],
    fields: ['contactName', 'contactDesignation', 'contactEmail', 'contactPhone', 'contactAltPhone', 'contactWhatsApp', 'commPrimary'] },
  { id: 'owner', title: '3. Ownership', hint: 'Who looks after this client at TeamLink', required: ['ownerDepartment', 'bdeOwner'],
    fields: ['ownerDepartment', 'bdeOwner', 'secondaryBde', 'accountManager', 'clientSource'] },
  { id: 'commercial', title: '4. Commercial', hint: 'What the client pays us, and when', required: ['fee', 'paymentDays', 'guaranteeDays'],
    fields: ['feeType', 'fee', 'gstApplicable', 'tdsApplicable', 'paymentDays', 'invoiceMode', 'guaranteeDays', 'replacementTerms'] },
  { id: 'agreement', title: '5. Agreement details', hint: 'The agreement we make from these details (see it on the right). Steps: Draft → Sent → Signed → Active', required: [],
    fields: ['agreementTemplate', 'agreementStart', 'agreementEnd', 'specialTerms'] },
  { id: 'tax', title: '6. Tax & billing', hint: 'What goes on our invoices to this client', required: [],
    fields: ['legalName', 'billingAddress', 'gst', 'pan', 'tan', 'billingEmail', 'invoiceEmail', 'billingContactName', 'billingContactPhone', 'billingContactEmail'] },
  { id: 'payment', title: '7. Payment details', hint: 'How the client usually pays us (for tracking payments)', required: [],
    fields: ['paymentMethod', 'paymentBankName', 'paymentUpi', 'paymentReferenceNote'] },
  { id: 'docs', title: '8. Documents', hint: 'Agreement, GST certificate, PAN … with expiry dates', required: [], fields: [] },
  { id: 'notes', title: '9. Internal notes', hint: 'Only for TeamLink — the client never sees these', required: [],
    fields: ['internalNotes', 'specialInstructions', 'recruitmentInstructions', 'internalRemarks'] },
];
export const SECTION_OF = {};
SECTIONS.forEach((s) => s.fields.forEach((f) => { SECTION_OF[f] = s.id; }));
Object.assign(SECTION_OF, { agreementFeePercent: 'commercial', feeAmount: 'commercial', invoiceDays: 'commercial', invoiceOther: 'commercial', gstPercent: 'commercial', tdsPercent: 'commercial', area: 'basic', bankAccountNo: 'payment', bankIfsc: 'payment', bankAccountHolder: 'payment' });

const valueOf = (f, k) => {
  if (k === 'fee') return f.feeType === 'PERCENT_CTC' ? f.agreementFeePercent : f.feeAmount;
  if (k === 'billingAddress') return f.billingSameAsAddress ? 'same' : f.billingAddress;
  if (k === 'contactWhatsApp') return f.waSame ? f.contactPhone : f.contactWhatsApp;
  if (k === 'invoiceMode') return f.invoiceMode;
  return f[k];
};
export function sectionStats(f, s) {
  const filled = s.fields.filter((k) => !blank(valueOf(f, k))).length;
  const done = s.required.every((k) => !blank(valueOf(f, k)));
  return { filled, total: s.fields.length, done };
}

// { field: message } in plain words. mode 'create' = the 10 required.
export function validateClientForm(f, mode, { canCommercial = true } = {}) {
  const e = {};
  const up = (v) => String(v || '').trim().toUpperCase();
  if (blank(f.name)) e.name = 'Write the company name.';
  if (mode === 'create') {
    if (blank(f.industry)) e.industry = 'Pick the industry.';
    if (blank(f.contactName)) e.contactName = 'Write the contact person\'s name.';
    if (blank(f.contactEmail)) e.contactEmail = 'Write the contact email.';
    if (blank(f.contactPhone)) e.contactPhone = 'Write the contact mobile number.';
    if (blank(f.ownerDepartment)) e.ownerDepartment = 'Pick the department.';
    if (blank(f.bdeOwner)) e.bdeOwner = 'Pick the client manager (BDE).';
    if (canCommercial) {
      if (f.feeType === 'PERCENT_CTC' && blank(f.agreementFeePercent)) e.agreementFeePercent = 'Write the fee %.';
      if (f.feeType !== 'PERCENT_CTC' && blank(f.feeAmount)) e.feeAmount = 'Write the fee amount in ₹.';
      if (blank(f.paymentDays)) e.paymentDays = 'Pick the payment days.';
      if (blank(f.guaranteeDays)) e.guaranteeDays = 'Write the replacement guarantee in days.';
    }
  }
  if (!blank(f.contactEmail) && !EMAIL_RE.test(f.contactEmail.trim())) e.contactEmail = 'The email does not look right — for example name@company.com.';
  ['companyEmail', 'billingEmail', 'invoiceEmail', 'billingContactEmail'].forEach((k) => { if (!blank(f[k]) && !EMAIL_RE.test(String(f[k]).trim())) e[k] = 'The email does not look right — for example accounts@company.com.'; });
  if (!blank(f.contactPhone) && digits(f.contactPhone).length < 10) e.contactPhone = 'The mobile number needs 10 digits.';
  if (!blank(f.pincode) && !/^\d{6}$/.test(String(f.pincode).trim())) e.pincode = 'Pincode is 6 digits, like 500072.';
  if (!blank(f.gst) && !GSTIN_RE.test(up(f.gst))) e.gst = 'GSTIN is 15 letters/numbers, like 36AABCT1234C1Z5.';
  if (!blank(f.pan) && !PAN_RE.test(up(f.pan))) e.pan = 'PAN is 10 letters/numbers, like AABCT1234C.';
  if (!blank(f.bankIfsc) && !IFSC_RE.test(up(f.bankIfsc))) e.bankIfsc = 'IFSC is 11 letters/numbers, like HDFC0001234.';
  if (!blank(f.bankAccountNo) && !/^\d{6,18}$/.test(String(f.bankAccountNo).replace(/\s/g, ''))) e.bankAccountNo = 'The account number is 6 to 18 digits.';
  if (canCommercial) {
    if (f.feeType === 'PERCENT_CTC' && !blank(f.agreementFeePercent) && !(Number(f.agreementFeePercent) > 0 && Number(f.agreementFeePercent) <= 100)) e.agreementFeePercent = 'The fee % is between 0 and 100, like 8.33.';
    if (f.feeType !== 'PERCENT_CTC' && !blank(f.feeAmount) && !(Number(f.feeAmount) > 0)) e.feeAmount = 'The amount must be more than 0.';
    if (!blank(f.guaranteeDays) && !(Number.isInteger(Number(f.guaranteeDays)) && Number(f.guaranteeDays) >= 0)) e.guaranteeDays = 'Whole days, like 30 (0 = no replacement).';
    if (!blank(f.paymentDays) && !(Number.isInteger(Number(f.paymentDays)) && Number(f.paymentDays) >= 0)) e.paymentDays = 'Whole days, like 6.';
    if (f.invoiceMode === 'after' && !(Number.isInteger(Number(f.invoiceDays)) && Number(f.invoiceDays) >= 0)) e.invoiceDays = 'Whole days, like 6.';
    if (f.invoiceMode === 'other' && blank(f.invoiceOther)) e.invoiceOther = 'Say when the invoice goes.';
    if (!blank(f.agreementStart) && !blank(f.agreementEnd) && f.agreementEnd < f.agreementStart) e.agreementEnd = 'The expiry date is before the effective date.';
  }
  return e;
}

// ---- small pieces ------------------------------------------------------------
// docfill_ (2026-10-06): when the form was filled from a file, every Field
// reads its green ("Found in the file") / orange ("Not found") mark from here.
export const FillCtx = createContext(null);

function Field({ id, label, req, tip, error, children, wide, hint }) {
  const fill = useContext(FillCtx);
  const mark = fill ? fill.cls(id) : '';
  const tag = fill ? fill.tag(id) : null;
  return (
    <label className={`field cf-field${wide ? ' cf-wide' : ''}${error ? ' cf-bad' : ''}${mark}`} id={`cf-${id}`}>
      <span>{label}{req && <b className="cf-req" aria-label="required"> *</b>}{tag}{tip && <Help text={tip} />}</span>
      {children}
      {hint && !error && <small className="cf-hint">{hint}</small>}
      {error && <small className="cf-err" role="alert">{error}</small>}
    </label>
  );
}
function Seg({ value, options, onChange, disabled }) {
  return (
    <div className="cf-seg" role="radiogroup">
      {options.map(([v, l]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} disabled={disabled} className={`cf-seg-btn${value === v ? ' on' : ''}`} onClick={() => onChange(v)}>{l}</button>
      ))}
    </div>
  );
}

// Documents: a queue (Add client — uploaded once the client exists) or the
// live list (Edit client).
export function ClientDocuments({ clientId, queue, onQueue, canEdit = true }) {
  const [rows, setRows] = useState([]);
  const [available, setAvailable] = useState(true);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [draft, setDraft] = useState({ kind: 'AGREEMENT', name: '', expiryDate: '', pending: false, file: null });
  const [busy, setBusy] = useState(false);
  const load = () => {
    if (!clientId) return;
    api.get(`/clients/${clientId}/documents`).then((r) => { setRows(r.data.rows || []); setAvailable(r.data.available !== false); }).catch((e) => setErr(e.response?.data?.error || 'Could not load the documents.'));
  };
  useEffect(load, [clientId]);
  const list = clientId ? rows : (queue || []).map((q, i) => ({ ...q, id: `q${i}`, status: q.pending ? 'Pending' : statusOf(q.expiryDate), kindLabel: (DOC_KINDS.find(([k]) => k === q.kind) || [])[1], fileName: q.file?.name }));

  function pickFile(file) {
    setErr('');
    if (!file) return setDraft({ ...draft, file: null });
    if (!/\.(pdf|png|jpe?g)$/i.test(file.name)) return setErr('Only PDF, JPG or PNG files.');
    if (file.size > 5 * 1024 * 1024) return setErr('That file is over 5 MB. Please pick a smaller one.');
    return setDraft({ ...draft, file, name: draft.name || file.name.replace(/\.[^.]+$/, '') });
  }
  async function add() {
    if (!draft.file) return setErr('Choose a file first.');
    setErr(''); setMsg('');
    if (!clientId) {
      onQueue([...(queue || []), draft]);
      setDraft({ kind: 'OTHER', name: '', expiryDate: '', pending: false, file: null });
      return setMsg('Added. It uploads when you save the client.');
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('kind', draft.kind); fd.append('name', draft.name); fd.append('expiryDate', draft.expiryDate); fd.append('pending', draft.pending ? 'true' : 'false');
      fd.append('file', draft.file, draft.file.name);
      await api.post(`/clients/${clientId}/documents`, fd);
      setDraft({ kind: 'OTHER', name: '', expiryDate: '', pending: false, file: null });
      setMsg('Uploaded.');
      load();
    } catch (e) { setErr(e.response?.data?.error || 'The upload did not work. Please try again.'); }
    setBusy(false);
    return null;
  }
  async function remove(r) {
    if (!clientId) { onQueue((queue || []).filter((_, i) => `q${i}` !== r.id)); return; }
    if (!window.confirm(`Remove "${r.name}"?`)) return;
    try { await api.delete(`/clients/${clientId}/documents/${r.id}`); setMsg('Removed.'); load(); } catch (e) { setErr(e.response?.data?.error || 'Could not remove it.'); }
  }
  async function open(r) {
    const res = await api.get(`/clients/${clientId}/documents/${r.id}/file`, { responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  if (!available) return <div className="small-muted">Documents can be added after the database update.</div>;
  return (
    <div className="cf-docs">
      {list.length === 0 ? <div className="small-muted">No documents yet. Add the signed agreement, GST certificate or PAN below.</div> : (
        <ul className="cf-doclist">
          {list.map((r) => (
            <li key={r.id}>
              <div><b>{r.name}</b> <span className="small-muted">{`· ${r.kindLabel || 'Other'}${r.fileName ? ` · ${r.fileName}` : ''}`}</span></div>
              <div className="small-muted">
                {r.uploadedAt ? `Uploaded ${new Date(r.uploadedAt).toLocaleDateString('en-GB')}` : 'Uploads on save'}
                {r.expiryDate ? ` · ends ${r.expiryDate}` : ' · no expiry date'}
              </div>
              <span className={`cf-docstatus s-${String(r.status).toLowerCase().replace(/\s+/g, '-')}`}>{r.status}</span>
              <div className="cf-docbtns">
                {clientId && <button type="button" className="btn btn-sm" onClick={() => open(r)}>Open</button>}
                {canEdit && <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove(r)}>Remove</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div className="cf-docadd">
          <div className="cf-grid">
            <Field id="docKind" label="Document type">
              <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
                {DOC_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </Field>
            <Field id="docName" label="Document name"><input value={draft.name} placeholder="e.g. GST certificate 2026" onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
            <Field id="docExpiry" label="Expiry date" tip="When this document stops being valid. We show 'Expiring soon' 30 days before.">
              <input type="date" value={draft.expiryDate} onChange={(e) => setDraft({ ...draft, expiryDate: e.target.value })} />
            </Field>
            <Field id="docFile" label="File (PDF, JPG or PNG, up to 5 MB)">
              <input type="file" accept="application/pdf,image/png,image/jpeg" onChange={(e) => pickFile(e.target.files[0] || null)} />
            </Field>
          </div>
          <label className="cf-check"><input type="checkbox" checked={draft.pending} onChange={(e) => setDraft({ ...draft, pending: e.target.checked })} /> Still waiting for the final copy (mark as Pending)</label>
          <button type="button" className="btn btn-sm" disabled={busy || !draft.file} onClick={add}>{busy ? 'Uploading…' : (clientId ? 'Upload document' : 'Add document')}</button>
        </div>
      )}
      {msg && <div className="small-muted" role="status">{msg}</div>}
      {err && <div className="cf-err" role="alert">{err}</div>}
    </div>
  );
}
function statusOf(expiry) {
  const m = String(expiry || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return 'Valid';
  const end = new Date(`${expiry}T00:00:00`).getTime();
  const t = new Date(today()).getTime();
  if (end < t) return 'Expired';
  if (end - t <= 30 * 86400000) return 'Expiring soon';
  return 'Valid';
}

// ---- the form ------------------------------------------------------------------
export default function ClientForm({
  user: userProp, form, set, errors = {}, open, setOpen, canCommercial, canEditCode, ownerLocked, defaults,
  mode = 'add', client = null, docQueue, setDocQueue, onBlurIdentity,
  fill = null, // docfill_: useFillFromFile('client') from Add client, or null
}) {
  const auth = useAuth();
  const user = userProp || (auth && auth.user) || null;
  const [owners, setOwners] = useState([]);
  const [showBank, setShowBank] = useState(!!(client && (client.bankAccountMasked || client.bankIfsc || client.bankAccountHolder)));
  const templates = (defaults && defaults.templates) || [{ name: 'Vendor Services Agreement', note: 'TeamLink standard' }];
  useEffect(() => {
    if (ownerLocked) return;
    api.get('/clients/owner-options', { params: { department: form.ownerDepartment || '' } })
      .then((r) => setOwners(r.data || [])).catch(() => setOwners([]));
  }, [ownerLocked, form.ownerDepartment]);

  const inp = (k, props = {}) => <input value={form[k] ?? ''} onChange={(e) => set({ [k]: e.target.value })} {...props} />;
  const toggle = (id) => setOpen({ ...open, [id]: !open[id] });
  const lock = !canCommercial;
  const lockNote = lock ? <div className="cf-lock">These are the standard terms. Only an Admin changes them.</div> : null;
  const ownerLabel = (u) => `${u.name}${u.department ? ` · ${u.department}` : ''} · ${u.clients} client${u.clients === 1 ? '' : 's'}`;
  const deptOwners = owners.filter((u) => u.inDepartment);
  const otherOwners = owners.filter((u) => !u.inDepartment);
  const gw = guaranteeWords(form.guaranteeDays);

  const body = {
    basic: (
      <div className="cf-grid">
        <Field id="name" label="Company name" req error={errors.name}>{inp('name', { placeholder: 'e.g. Acme Technologies Pvt Ltd', onBlur: onBlurIdentity, autoFocus: mode === 'add' })}</Field>
        <Field id="clientCode" label="Client ID" tip="A short code for this client. Leave it empty and we make one (CLI0001…)." hint={canEditCode ? 'Empty = made for you' : 'Made for you'}>
          {inp('clientCode', { placeholder: client?.displayCode || 'CLI0001', disabled: !canEditCode })}
        </Field>
        <Field id="companyType" label="Company type">
          <select value={form.companyType} onChange={(e) => set({ companyType: e.target.value })}>
            <option value="">— Pick —</option>
            {COMPANY_TYPES.map((x) => <option key={x}>{x}</option>)}
          </select>
        </Field>
        <Field id="industry" label="Industry" req error={errors.industry}>
          <Combo creatable value={form.industry} onChange={(e) => set({ industry: e.target.value })}>
            <option value="">— Pick —</option>
            {CLIENT_INDUSTRIES.map((x) => <option key={x}>{x}</option>)}
          </Combo>
        </Field>
        <Field id="website" label="Website">{inp('website', { placeholder: 'e.g. www.acme.com' })}</Field>
        <Field id="companyEmail" label="Company email" error={errors.companyEmail}>{inp('companyEmail', { type: 'email', placeholder: 'e.g. info@acme.com' })}</Field>
        <Field id="landline" label="Company phone">{inp('landline', { inputMode: 'tel', placeholder: 'e.g. 040 2345 6789' })}</Field>
        <Field id="street" label="Company address" wide>{inp('street', { placeholder: 'e.g. Plot 12, Road No 5, Banjara Hills' })}</Field>
        <Field id="location" label="City">
          <Combo creatable value={form.location} onChange={(e) => set({ location: e.target.value })}>
            {LOCS.map((x) => <option key={x}>{x}</option>)}
          </Combo>
        </Field>
        <Field id="state" label="State">
          <Combo creatable value={form.state} onChange={(e) => set({ state: e.target.value })}>
            <option value="">Pick a state</option>
            {INDIAN_STATES.map((x) => <option key={x}>{x}</option>)}
          </Combo>
        </Field>
        <Field id="country" label="Country">{inp('country', { placeholder: 'India' })}</Field>
        <Field id="pincode" label="Pincode" error={errors.pincode}>{inp('pincode', { inputMode: 'numeric', placeholder: 'e.g. 500072', maxLength: 6 })}</Field>
      </div>
    ),
    contact: (
      <div className="cf-grid">
        <Field id="contactName" label="Name" req error={errors.contactName}>{inp('contactName', { placeholder: 'e.g. Priya Sharma' })}</Field>
        <Field id="contactDesignation" label="Designation">{inp('contactDesignation', { placeholder: 'e.g. HR Manager' })}</Field>
        <Field id="contactEmail" label="Email" req error={errors.contactEmail} tip="The agreement link and its signing code go to this email.">
          {inp('contactEmail', { type: 'email', placeholder: 'e.g. priya@acme.com', onBlur: onBlurIdentity })}
        </Field>
        <Field id="contactPhone" label="Mobile" req error={errors.contactPhone}>{inp('contactPhone', { inputMode: 'tel', placeholder: '10 digits, e.g. 9876543210', onBlur: onBlurIdentity })}</Field>
        <Field id="contactAltPhone" label="Alternate number">{inp('contactAltPhone', { inputMode: 'tel', placeholder: 'Another number (optional)' })}</Field>
        <Field id="contactWhatsApp" label="WhatsApp">
          <label className="cf-check"><input type="checkbox" checked={form.waSame} onChange={(e) => set({ waSame: e.target.checked })} /> Same as mobile</label>
          {!form.waSame && inp('contactWhatsApp', { inputMode: 'tel', placeholder: 'WhatsApp number' })}
        </Field>
        <Field id="commPrimary" label="Best way to reach them" wide>
          <Seg value={form.commPrimary} options={COMM.map((c) => [c, c])} onChange={(v) => set({ commPrimary: v })} />
        </Field>
      </div>
    ),
    owner: (
      <div className="cf-grid">
        <Field id="ownerDepartment" label="Department" req error={errors.ownerDepartment} tip="The team that works on this client's jobs.">
          <Combo creatable value={form.ownerDepartment} onChange={(e) => set({ ownerDepartment: e.target.value })}>
            <option value="">— Pick —</option>
            {deptOptions(user).map((x) => <option key={x}>{x}</option>)}
          </Combo>
        </Field>
        <Field id="bdeOwner" label="Client manager (BDE)" req error={errors.bdeOwner} tip="The TeamLink person (BDE) who owns this client and talks to them. The chosen department's BDEs are shown first, with how many clients each has.">
          {ownerLocked ? (
            <>
              <input value={ownerLocked} disabled />
              <small className="cf-hint">{mode === 'edit' ? 'Only an Admin changes who owns a client.' : 'You own the clients you add.'}</small>
            </>
          ) : (
            <Combo creatable value={form.bdeOwner} onChange={(e) => set({ bdeOwner: e.target.value })}>
              <option value="">— Pick —</option>
              {deptOwners.map((u) => <option key={u.id} value={u.name}>{ownerLabel(u)}</option>)}
              {otherOwners.map((u) => <option key={u.id} value={u.name}>{ownerLabel(u)}</option>)}
            </Combo>
          )}
        </Field>
        <Field id="secondaryBde" label="Second BDE">
          <Combo creatable value={form.secondaryBde} onChange={(e) => set({ secondaryBde: e.target.value })}>
            <option value="">— Nobody —</option>
            {owners.map((u) => <option key={u.id} value={u.name}>{ownerLabel(u)}</option>)}
          </Combo>
        </Field>
        <Field id="accountManager" label="Relationship owner" tip="The senior person who keeps the relationship (optional).">{inp('accountManager', { placeholder: 'e.g. a Manager\'s name' })}</Field>
        <Field id="clientSource" label="Where the client came from" wide>
          <Seg value={form.clientSource} options={SOURCES.map((c) => [c, c])} onChange={(v) => set({ clientSource: v })} />
        </Field>
      </div>
    ),
    commercial: (
      <>
        {lockNote}
        <div className="cf-grid">
          <Field id="feeType" label="Fee type" wide>
            <Seg value={form.feeType} options={FEE_TYPES} disabled={lock} onChange={(v) => set({ feeType: v })} />
          </Field>
          {form.feeType === 'PERCENT_CTC' ? (
            <Field id="agreementFeePercent" label="Fee %" req error={errors.agreementFeePercent} tip="Our fee as a % of the person's yearly salary (CTC). Standard: 8.33%.">
              {inp('agreementFeePercent', { type: 'number', step: '0.01', min: '0', max: '100', placeholder: '8.33', disabled: lock })}
            </Field>
          ) : (
            <Field id="feeAmount" label={form.feeType === 'FIXED' ? 'Fixed fee (₹)' : 'Fee per candidate (₹)'} req error={errors.feeAmount}>
              {inp('feeAmount', { type: 'number', step: '1', min: '0', placeholder: 'e.g. 25000', disabled: lock })}
            </Field>
          )}
          <Field id="gstApplicable" label="GST added?" tip="GST is the tax added on our invoice. Standard: 18%.">
            <Seg value={form.gstApplicable} options={[['Yes', 'Yes'], ['No', 'No']]} disabled={lock} onChange={(v) => set({ gstApplicable: v })} />
            {form.gstApplicable === 'Yes' && <div className="cf-inline">{inp('gstPercent', { type: 'number', step: '0.01', disabled: lock, style: { width: 90 } })}<span>%</span></div>}
          </Field>
          <Field id="tdsApplicable" label="TDS cut by the client?" tip="TDS = tax the client keeps from our payment and pays to the government for us.">
            <Seg value={form.tdsApplicable} options={[['Yes', 'Yes'], ['No', 'No']]} disabled={lock} onChange={(v) => set({ tdsApplicable: v })} />
            {form.tdsApplicable === 'Yes' && <div className="cf-inline">{inp('tdsPercent', { type: 'number', step: '0.01', disabled: lock, style: { width: 90 } })}<span>%</span></div>}
          </Field>
          <Field id="paymentDays" label="Payment terms" req error={errors.paymentDays} tip="How many days after our invoice the client must pay.">
            <div className="cf-inline">
              <select value={['6', '7', '15', '30'].includes(String(form.paymentDays)) ? String(form.paymentDays) : 'custom'} disabled={lock}
                onChange={(e) => set({ paymentDays: e.target.value === 'custom' ? '' : e.target.value })}>
                <option value="6">6 days (standard)</option>
                <option value="7">7 days</option>
                <option value="15">15 days</option>
                <option value="30">30 days</option>
                <option value="custom">Other…</option>
              </select>
              {!['6', '7', '15', '30'].includes(String(form.paymentDays)) && inp('paymentDays', { type: 'number', min: '0', placeholder: 'days', disabled: lock, style: { width: 90 } })}
            </div>
          </Field>
          <Field id="invoiceDays" label="When the invoice goes" error={errors.invoiceDays || errors.invoiceOther} tip="When we send the invoice after the person joins. Standard: 6 days after joining.">
            <Seg value={form.invoiceMode} disabled={lock} options={[['on', 'On joining'], ['after', 'After joining +'], ['other', 'Other']]} onChange={(v) => set({ invoiceMode: v })} />
            {form.invoiceMode === 'after' && <div className="cf-inline">{inp('invoiceDays', { type: 'number', min: '0', disabled: lock, style: { width: 90 } })}<span>days</span></div>}
            {form.invoiceMode === 'other' && inp('invoiceOther', { placeholder: 'e.g. at the end of the month', disabled: lock })}
          </Field>
          <Field id="guaranteeDays" label="Replacement guarantee (days)" req error={errors.guaranteeDays}
            tip="If the person leaves within this many days, we find a new one free. Standard: 30 days (One Month)." hint={gw ? `= ${gw}` : ''}>
            {inp('guaranteeDays', { type: 'number', min: '0', placeholder: '30', disabled: lock })}
          </Field>
          <Field id="replacementTerms" label="Replacement notes" wide>
            <textarea rows="2" value={form.replacementTerms} disabled={lock} placeholder="e.g. Replacement only for the same role" onChange={(e) => set({ replacementTerms: e.target.value })} />
          </Field>
        </div>
      </>
    ),
    agreement: (
      <>
        {lockNote}
        <div className="cf-grid">
          <Field id="agreementTemplate" label="Agreement template" req>
            <select value={form.agreementTemplate} disabled={lock} onChange={(e) => set({ agreementTemplate: e.target.value })}>
              {templates.map((t) => <option key={t.name} value={t.name}>{`${t.name}${t.note ? ` — ${t.note}` : ''}`}</option>)}
            </select>
          </Field>
          <div className="cf-linked cf-wide">
            <b>From section 4 (same values):</b>
            {` Fee ${form.feeType === 'PERCENT_CTC' ? `${form.agreementFeePercent || '—'}%` : `₹${form.feeAmount || '—'}`}`}
            {` · Guarantee ${form.guaranteeDays || '—'} days${gw ? ` (${gw})` : ''}`}
            {` · Payment within ${form.paymentDays || '—'} days`}
            {canCommercial && <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setOpen({ ...open, commercial: true }); setTimeout(() => document.getElementById('cf-sec-commercial')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); }}>Change them in section 4</button>}
          </div>
          <Field id="agreementStart" label="Effective date" tip="The day the agreement starts. It is printed at the top of the agreement.">{inp('agreementStart', { type: 'date', disabled: lock })}</Field>
          <Field id="agreementEnd" label="Expiry date" error={errors.agreementEnd} hint="Empty = it renews by itself">{inp('agreementEnd', { type: 'date', disabled: lock })}</Field>
          <Field id="specialTerms" label="Special terms" wide tip="Anything extra agreed with this client. It is printed in the agreement under 'Special terms'.">
            <textarea rows="2" value={form.specialTerms} disabled={lock} placeholder="e.g. Leadership roles are charged at 12%" onChange={(e) => set({ specialTerms: e.target.value })} />
          </Field>
        </div>
      </>
    ),
    tax: (
      <div className="cf-grid">
        <Field id="legalName" label="Legal company name" tip="The name on their GST certificate. It goes on the agreement and invoices." hint="Empty = the company name">
          {inp('legalName', { placeholder: 'e.g. Acme Technologies Private Limited', onBlur: onBlurIdentity })}
        </Field>
        <Field id="billingAddress" label="Billing address" wide>
          <label className="cf-check"><input type="checkbox" checked={form.billingSameAsAddress} onChange={(e) => set({ billingSameAsAddress: e.target.checked })} /> Same as company address</label>
          {!form.billingSameAsAddress && <textarea rows="2" value={form.billingAddress} placeholder="The address to print on invoices" onChange={(e) => set({ billingAddress: e.target.value })} />}
        </Field>
        <Field id="gst" label="GSTIN" error={errors.gst} tip="The client's 15-character GST number, like 36AABCT1234C1Z5.">
          {inp('gst', { placeholder: '36AABCT1234C1Z5', maxLength: 15, onBlur: onBlurIdentity, style: { textTransform: 'uppercase' } })}
        </Field>
        <Field id="pan" label="PAN" error={errors.pan} tip="The company's 10-character tax ID, like AABCT1234C.">
          {inp('pan', { placeholder: 'AABCT1234C', maxLength: 10, onBlur: onBlurIdentity, style: { textTransform: 'uppercase' } })}
        </Field>
        <Field id="tan" label="TAN" tip="Their 10-character TDS account number (only if they cut TDS).">{inp('tan', { placeholder: 'HYDA12345B', maxLength: 10, style: { textTransform: 'uppercase' } })}</Field>
        <Field id="billingEmail" label="Billing email" error={errors.billingEmail}>{inp('billingEmail', { type: 'email', placeholder: 'e.g. billing@acme.com' })}</Field>
        <Field id="invoiceEmail" label="Send invoices to" error={errors.invoiceEmail}>{inp('invoiceEmail', { type: 'email', placeholder: 'e.g. invoices@acme.com' })}</Field>
        <Field id="billingContactName" label="Accounts contact name">{inp('billingContactName', { placeholder: 'e.g. Ravi (Accounts)' })}</Field>
        <Field id="billingContactPhone" label="Accounts contact number">{inp('billingContactPhone', { inputMode: 'tel', placeholder: 'e.g. 9876543210' })}</Field>
        <Field id="billingContactEmail" label="Accounts contact email" error={errors.billingContactEmail}>{inp('billingContactEmail', { type: 'email', placeholder: 'e.g. ravi@acme.com' })}</Field>
      </div>
    ),
    payment: (
      <>
        <div className="cf-grid">
          <Field id="paymentMethod" label="How they pay us">
            <select value={form.paymentMethod} onChange={(e) => set({ paymentMethod: e.target.value })}>
              <option value="">— Pick —</option>
              {PAY_METHODS.map((x) => <option key={x}>{x}</option>)}
            </select>
          </Field>
          <Field id="paymentBankName" label="Their bank name">{inp('paymentBankName', { placeholder: 'e.g. HDFC Bank' })}</Field>
          <Field id="paymentUpi" label="Their UPI ID">{inp('paymentUpi', { placeholder: 'e.g. acme@hdfcbank' })}</Field>
          <Field id="paymentReferenceNote" label="What they write as the payment reference" tip="So Accounts can match their payment to our invoice, e.g. 'invoice number'.">
            {inp('paymentReferenceNote', { placeholder: 'e.g. Our invoice number' })}
          </Field>
        </div>
        {!showBank ? (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowBank(true)}>+ Add bank account (optional)</button>
        ) : (
          <div className="cf-bank">
            <div className="small-muted">Only if you really need it. The account number is stored locked (encrypted) and shown as the last 4 digits.</div>
            <div className="cf-grid">
              <Field id="bankAccountHolder" label="Account holder">{inp('bankAccountHolder', { placeholder: 'Name on the account' })}</Field>
              <Field id="bankAccountNo" label="Account number" error={errors.bankAccountNo} hint={client?.bankAccountMasked ? `Saved: ${client.bankAccountMasked} — type to replace` : ''}>
                {inp('bankAccountNo', { inputMode: 'numeric', autoComplete: 'off', placeholder: client?.bankAccountMasked || 'e.g. 50100123456789' })}
              </Field>
              <Field id="bankIfsc" label="IFSC" error={errors.bankIfsc} tip="The 11-character bank branch code, like HDFC0001234.">
                {inp('bankIfsc', { placeholder: 'HDFC0001234', maxLength: 11, style: { textTransform: 'uppercase' } })}
              </Field>
            </div>
          </div>
        )}
      </>
    ),
    docs: (
      <ClientDocuments clientId={mode === 'edit' && client ? client.id : null} queue={docQueue} onQueue={setDocQueue} />
    ),
    notes: (
      <>
        <div className="cf-private">🔒 Only TeamLink sees these. They are never in the agreement, the client's link, the PDF, the client portal or any email.</div>
        <div className="cf-grid">
          <Field id="internalNotes" label="Client notes" wide><textarea rows="2" value={form.internalNotes} placeholder="e.g. Prefers calls after 4 pm" onChange={(e) => set({ internalNotes: e.target.value })} /></Field>
          <Field id="specialInstructions" label="Special instructions" wide><textarea rows="2" value={form.specialInstructions} placeholder="e.g. Always copy the HR head on emails" onChange={(e) => set({ specialInstructions: e.target.value })} /></Field>
          <Field id="recruitmentInstructions" label="Recruitment instructions" wide><textarea rows="2" value={form.recruitmentInstructions} placeholder="e.g. Only candidates within 20 km" onChange={(e) => set({ recruitmentInstructions: e.target.value })} /></Field>
          <Field id="internalRemarks" label="Internal remarks" wide><textarea rows="2" value={form.internalRemarks} placeholder="Anything else for the team" onChange={(e) => set({ internalRemarks: e.target.value })} /></Field>
        </div>
      </>
    ),
  };

  return (
    <FillCtx.Provider value={fill && fill.state ? fill : null}>
    <div className="cf">
      {SECTIONS.map((s) => {
        const st = sectionStats(form, s);
        const bad = Object.keys(errors).some((k) => SECTION_OF[k] === s.id);
        const docCount = s.id === 'docs' ? (docQueue || []).length : 0;
        return (
          <section key={s.id} id={`cf-sec-${s.id}`} className={`cf-sec${open[s.id] ? ' open' : ''}${bad ? ' bad' : ''}`}>
            <button type="button" className="cf-sec-head" aria-expanded={!!open[s.id]} onClick={() => toggle(s.id)}>
              <span className="cf-sec-arrow" aria-hidden="true">{open[s.id] ? '▾' : '▸'}</span>
              <span className="cf-sec-title">
                <b>{s.title}</b>
                <small>{s.hint}</small>
              </span>
              <span className="cf-sec-count">
                {s.id === 'docs' ? (mode === 'add' ? (docCount ? `${docCount} added` : 'Optional') : 'Optional')
                  : `${st.filled} of ${st.total} filled`}
                {s.required.length > 0 && st.done && <span className="cf-tick" aria-label="required fields done"> ✓</span>}
                {bad && <span className="cf-bang" aria-label="has a problem"> !</span>}
              </span>
            </button>
            {open[s.id] && <div className="cf-sec-body">{body[s.id]}</div>}
          </section>
        );
      })}
    </div>
    </FillCtx.Provider>
  );
}
