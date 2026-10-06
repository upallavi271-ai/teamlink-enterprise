// Add / edit an expense — the accounting application's full expense record in
// one 3-column grid, a summary that recalculates as you type, and (editing
// only) Delete. GST and TDS are entered as a rate and the amounts follow; they
// are stored as amounts. The same form serves "+ New expense", without Delete.
//
// ONE SCROLLING PAGE: five headed sections one below the other (no steps), a
// sticky index that follows the section in view, each checked field checked
// as you leave it, Save taking you to the first field that needs fixing, and
// the Cancel / Save bar always on screen (onepage.css .oe-fs-modal).
import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import Combo from '../../components/Combo.jsx';
import { checkGstin, GST_STATES } from '../../utils/gstin';
import { money2, todayIso, fmtD } from './officeUtil';
import { APPROVAL } from './approval.jsx';
import { FormSection, SectionIndex, useJumpToInvalid } from './FormSections.jsx';
import AddVendorModal from './AddVendorModal.jsx';

const FREQ = ['Monthly', 'Quarterly', '3 Times a Year', 'Half-Yearly', 'Yearly', 'One-Time'];
// Months a frequency covers when no custom figure is typed — the same table the
// API uses (routes/office.js FREQ_MONTHS).
const FREQ_MONTHS = {
  Monthly: 1, Quarterly: 3, '3 Times a Year': 4, 'Half-Yearly': 6, Yearly: 12, 'One-Time': 12,
};
const SUPPLY = ['Goods', 'Service'];
const TREAT = ['Registered Business - Regular', 'Registered Business - Composition', 'Unregistered Business', 'Consumer',
  'Overseas', 'Special Economic Zone', 'Deemed Export', 'Tax Deductor', 'SEZ Developer'];
const STATES = [...new Set(Object.values(GST_STATES))].sort();
// The form's sections, top to bottom (the same order the fields always had).
const SECTIONS = [
  { id: 'oe-xm-s-basics', title: 'Basics', short: 'Basics' },
  { id: 'oe-xm-s-amount', title: 'Amount & tax', short: 'Amount & tax' },
  { id: 'oe-xm-s-vendor', title: 'Vendor & GST', short: 'Vendor & GST' },
  { id: 'oe-xm-s-billing', title: 'Billing & payment', short: 'Billing' },
  { id: 'oe-xm-s-proof', title: 'Attachment & summary', short: 'Summary' },
];

// The proof upload goes through utils/attachments.js on the server, which
// takes these four types up to 5 MB and checks the file's first bytes.
const PROOF_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
const PROOF_MAX = 5 * 1024 * 1024;

const BLANK = {
  category: '', expenseDate: todayIso(), expenseAccount: '',
  frequency: 'Monthly', monthsCovered: '', entryKind: 'expense',
  description: '',
  baseAmount: '', gstApplicable: 'Yes', gstRatePct: '18',
  tdsApplicable: 'No', tdsRatePct: '0', supplyType: 'Service',
  hsnSac: '', vendor: '', vendorGstin: '',
  gstTreatment: 'Registered Business - Regular', sourceState: '', destState: '',
  reverseCharge: 'No', billableClient: '', reportingTags: '',
  paymentMode: 'Bank Transfer', billNumber: '',
  dueDate: '', location: '',
  remarks: '',
  // Spec A: a new expense is Pending approval; an approver may record one
  // straight in as Approved or Paid.
  approvalStatus: 'PENDING', overrideReason: '',
};

const fromRow = (r) => ({
  ...BLANK,
  category: r.category || '',
  expenseDate: r.expenseDate || todayIso(),
  expenseAccount: r.expenseAccount || '',
  frequency: r.frequency || 'Monthly',
  monthsCovered: r.monthsCovered && r.monthsCovered !== (FREQ_MONTHS[r.frequency] || 1) ? String(r.monthsCovered) : '',
  entryKind: r.entryKind || 'expense',
  description: r.description || '',
  baseAmount: String(r.base ?? ''),
  gstApplicable: (r.gst || 0) > 0 || (r.gstRate || 0) > 0 ? 'Yes' : 'No',
  gstRatePct: String(r.gstRate ?? 0),
  tdsApplicable: (r.tds || 0) > 0 || (r.tdsRate || 0) > 0 ? 'Yes' : 'No',
  tdsRatePct: String(r.tdsRate ?? 0),
  supplyType: r.supplyType || 'Service',
  hsnSac: r.hsnSac || '',
  vendor: r.vendor || '',
  vendorGstin: r.vendorGstin || '',
  gstTreatment: r.gstTreatment || 'Registered Business - Regular',
  sourceState: r.sourceState || '',
  destState: r.destState || '',
  reverseCharge: r.reverseCharge ? 'Yes' : 'No',
  billableClient: r.billableClient || '',
  reportingTags: r.reportingTags || '',
  paymentMode: r.paymentMode || 'Bank Transfer',
  billNumber: r.billNumber || '',
  dueDate: r.dueDate || '',
  location: r.location || '',
  remarks: r.remarks || '',
});

// Coverage end = the expense date moved on by the months covered, less one day
// (1 Sep + 3 months − 1 day = 30 Nov). A day that does not exist in the target
// month is clamped to that month's last day first (31 Jan + 1 month → 28 Feb).
export function coverageEnd(iso, months) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m || !(months > 0)) return null;
  const y = Number(m[1]); const mo = Number(m[2]) - 1; const d = Number(m[3]);
  const tY = y + Math.floor((mo + months) / 12);
  const tM = (mo + months) % 12;
  const last = new Date(tY, tM + 1, 0).getDate();
  const end = new Date(tY, tM, Math.min(d, last));
  end.setDate(end.getDate() - 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${end.getFullYear()}-${p(end.getMonth() + 1)}-${p(end.getDate())}`;
}

const Hint = ({ children, tone }) => <div className={`oe-hint${tone ? ` ${tone}` : ''}`}>{children}</div>;

export default function ExpenseModal({
  row, options, access, ourState, onClose, onSaved,
}) {
  const [savedId, setSavedId] = useState(row ? row.id : null);
  const editing = !!row;
  const acc = access || {};
  const status = row ? (row.approvalStatus || 'PENDING') : 'PENDING';
  // Editing is for a Pending expense; Super Admin / Admin may still correct an
  // approved or paid one, with a reason (routes/office.js answers 409 otherwise).
  const overriding = editing && status !== 'PENDING';
  const [cats, setCats] = useState(null);
  const [newCat, setNewCat] = useState(null); // null | '' | the name being typed
  const [catErr, setCatErr] = useState('');
  const [form, setForm] = useState(() => (row ? fromRow(row) : { ...BLANK, destState: ourState || '' }));
  const [moneyDirty, setMoneyDirty] = useState(!editing);
  const [file, setFile] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [vendorGstins, setVendorGstins] = useState({});
  const [masterVendors, setMasterVendors] = useState([]);
  const [touched, setTouched] = useState({});
  const [tried, setTried] = useState(false);
  const [addVendor, setAddVendor] = useState(null); // null | { name } while Add Vendor is open
  const fileRef = useRef(null);
  const formRef = useRef(null);
  const jump = useJumpToInvalid(formRef);

  // The category list (spec A) — the active categories.
  const loadCats = () => api.get('/office-expenses/categories').then((r) => setCats(r.data.map((c) => c.name))).catch(() => setCats(null));
  useEffect(() => { loadCats(); }, []);

  useEffect(() => {
    api.get('/office-expenses/vendors').then((r) => {
      const m = {};
      r.data.forEach((v) => { if (v.gstin) m[v.name.trim().toLowerCase()] = v.gstin; });
      setVendorGstins(m);
      setMasterVendors(r.data.map((v) => v.name));
    }).catch(() => {});
  }, []);

  const set = (k, v) => setForm((cur) => ({ ...cur, [k]: v }));
  const setMoney = (k, v) => { setMoneyDirty(true); set(k, v); };
  const opts = options || {};

  // A valid vendor GSTIN names the state the supply comes from — filled in
  // when Source of supply is still empty.
  const withGstin = (cur, gstin) => {
    const c = gstin ? checkGstin(gstin) : null;
    return { ...cur, vendorGstin: gstin, sourceState: cur.sourceState || (c && c.ok ? c.stateName || '' : '') };
  };

  // Category → its vendors. A category billed by exactly one vendor fills the
  // vendor in by itself when the vendor box is still empty.
  const catVendors = (opts.vendorsByCategory || {})[form.category] || [];
  const pickCategory = (category) => {
    setForm((cur) => {
      const list = (opts.vendorsByCategory || {})[category] || [];
      const vendor = !cur.vendor.trim() && list.length === 1 ? list[0] : cur.vendor;
      const known = vendorGstins[vendor.trim().toLowerCase()];
      return withGstin({ ...cur, category, vendor }, cur.vendorGstin || known || '');
    });
  };
  const addCategory = async () => {
    const name = String(newCat || '').trim();
    setCatErr('');
    if (!name) { setCatErr('Type the new category'); return; }
    try {
      const r = await api.post('/office-expenses/categories', { name });
      await loadCats();
      setNewCat(null);
      pickCategory(r.data.name);
    } catch (e2) {
      const hit = e2.response?.data?.category;
      if (hit && hit.isActive) { setNewCat(null); pickCategory(hit.name); return; }
      setCatErr(e2.response?.data?.error || 'The category could not be added.');
    }
  };
  const pickVendor = (vendor) => {
    setForm((cur) => {
      const known = vendorGstins[String(vendor || '').trim().toLowerCase()];
      return withGstin({ ...cur, vendor }, cur.vendorGstin || known || '');
    });
  };

  // ---- the live summary ----
  const base = Number(form.baseAmount) || 0;
  const gstPct = form.gstApplicable === 'Yes' ? (Number(form.gstRatePct) || 0) : 0;
  const tdsPct = form.tdsApplicable === 'Yes' ? (Number(form.tdsRatePct) || 0) : 0;
  const gst = Math.round(base * gstPct) / 100;
  const tds = Math.round(base * tdsPct) / 100;
  // Editing without touching the money shows the bill's own stored amounts.
  const shown = !moneyDirty && row
    ? {
      base: row.base, gst: row.gst, tds: row.tds, gstPct: row.gstRate || 0, tdsPct: row.tdsRate || 0,
    }
    : {
      base, gst, tds, gstPct, tdsPct,
    };
  const net = Math.round((shown.base + shown.gst - shown.tds) * 100) / 100;
  const months = Number(form.monthsCovered) > 0 ? Math.round(Number(form.monthsCovered)) : (FREQ_MONTHS[form.frequency] || 1);
  const perMonth = Math.round((net / months) * 100) / 100;
  const endIso = coverageEnd(form.expenseDate, months);

  const gc = useMemo(() => (form.vendorGstin.trim() ? checkGstin(form.vendorGstin) : null), [form.vendorGstin]);
  const hsnBad = form.hsnSac.trim() && !/^(\d{4}|\d{6}|\d{8})$/.test(form.hsnSac.replace(/\s+/g, ''));
  const interState = form.sourceState && form.destState && form.sourceState !== form.destState;

  const pickFile = (e) => {
    const f = e.target.files && e.target.files[0];
    setErr('');
    if (!f) { setFile(null); return; }
    if (!PROOF_TYPES.includes(f.type)) { setErr(`${f.name} is not a PDF, PNG, JPEG or WebP file.`); e.target.value = ''; setFile(null); return; }
    if (f.size > PROOF_MAX) { setErr(`${f.name} is larger than 5 MB — attach a smaller scan.`); e.target.value = ''; setFile(null); return; }
    setFile(f);
  };

  const save = async (e) => {
    e.preventDefault();
    setErr('');
    setTried(true);
    // The same checks, in the same order, as before — now each is shown under
    // its own field too, and Save scrolls to the first one.
    const firstBad = Object.values(fieldErrors)[0];
    if (firstBad) { setErr(`${firstBad} Fix the highlighted fields first.`); jump(); return; }
    const body = { ...form, gstRatePct: String(gstPct), tdsRatePct: String(tdsPct) };
    delete body.gstApplicable;
    delete body.tdsApplicable;
    // Status and approver belong to the approval flow, not to the form.
    delete body.overrideReason;
    if (editing) delete body.approvalStatus;
    if (overriding) { body.override = true; body.overrideReason = form.overrideReason.trim(); }
    if (editing && !moneyDirty) { delete body.baseAmount; delete body.gstRatePct; delete body.tdsRatePct; }
    setBusy(true);
    let id = savedId;
    try {
      if (id) await api.patch(`/office-expenses/${id}`, body);
      else {
        const r = await api.post('/office-expenses', body);
        id = r.data.id;
        setSavedId(id);
      }
    } catch (e2) {
      setErr(e2.response?.data?.error || 'The expense could not be saved.');
      setBusy(false);
      return;
    }
    if (file) {
      const fd = new FormData();
      fd.append('file', file);
      try {
        await api.post(`/office-expenses/${id}/proof`, fd);
      } catch (e3) {
        // The bill itself is saved; a second Save only retries the file.
        setErr(`The expense was saved, but ${file.name} could not be attached: ${e3.response?.data?.error || 'upload failed'}.`);
        setBusy(false);
        return;
      }
    }
    onSaved();
  };

  const remove = async () => {
    setBusy(true); setErr('');
    try {
      await api.delete(`/office-expenses/${row.id}`);
      onSaved();
    } catch (e2) {
      setErr(e2.response?.data?.error || 'The expense could not be deleted.');
      setBusy(false);
      setConfirmDel(false);
    }
  };

  const onFile = row && row.proofName;

  // ---- single-page sections, blur checks, Add Vendor ----
  const vendorList = [...new Set([...(opts.allVendors || []), ...masterVendors])];
  const fieldErrors = {};
  if (!form.expenseDate) fieldErrors.expenseDate = 'Pick the expense date.';
  if (!form.category.trim()) fieldErrors.category = 'Pick a category.';
  if (overriding && !form.overrideReason.trim()) fieldErrors.overrideReason = 'Say why this approved expense is being corrected.';
  if (!(base > 0)) fieldErrors.baseAmount = 'Bill amount (before GST) must be more than zero.';
  if (gc && !gc.ok) fieldErrors.vendorGstin = `Vendor GSTIN: ${gc.error}`;
  if (hsnBad) fieldErrors.hsnSac = 'HSN / SAC must be 4, 6 or 8 digits.';
  const bad = (k) => (tried || touched[k]) && fieldErrors[k];
  const inv = (k) => (bad(k) ? 'true' : undefined);
  const touch = (k) => (e) => {
    if (e && e.relatedTarget && e.currentTarget && e.currentTarget.contains(e.relatedTarget)) return;
    setTouched((cur) => (cur[k] ? cur : { ...cur, [k]: true }));
  };
  const FieldErr = ({ k }) => (bad(k) ? <em className="oe-qx-err">{fieldErrors[k]}</em> : null);
  const vendorAdded = (v) => {
    const key = v.name.trim().toLowerCase();
    setMasterVendors((cur) => [...new Set([...cur, v.name])]);
    if (v.gstin) setVendorGstins((m) => ({ ...m, [key]: v.gstin }));
    // Only the vendor (and, when the new vendor has one and the bill has none,
    // its GSTIN) changes — everything typed so far stays as it is.
    setForm((cur) => withGstin({ ...cur, vendor: v.name }, cur.vendorGstin || v.gstin || ''));
    setTouched((cur) => ({ ...cur, vendor: true }));
    setAddVendor(null);
  };

  return (
    <Modal
      title={editing ? (overriding ? 'Correct an approved expense' : 'Edit expense') : 'Add Expense'}
      note={editing ? (row.vendor || row.billName) : null}
      size="wide oe-exp-modal oe-fs-modal"
      onClose={onClose}
      footer={(
        <>
          {editing && !confirmDel && (status === 'PENDING' || status === 'REJECTED' || acc.approver) && (
            <button type="button" className="btn oe-del" onClick={() => setConfirmDel(true)} disabled={busy}>Delete</button>
          )}
          {editing && confirmDel && (
            <span className="oe-del-confirm" role="alert">
              Delete this expense? This action will remove the expense record.
              <button type="button" className="btn btn-sm" onClick={() => setConfirmDel(false)} disabled={busy} autoFocus>Cancel</button>
              <button type="button" className="btn btn-sm oe-del" onClick={remove} disabled={busy}>Delete</button>
            </span>
          )}
          <span style={{ marginRight: 'auto' }} />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="oe-exp-form" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : (editing ? 'Save changes' : 'Add expense')}
          </button>
        </>
      )}
    >
      <SectionIndex sections={SECTIONS} label="Expense form sections" />
      <form id="oe-exp-form" ref={formRef} onSubmit={save} className="oe-form oe-fs-form" noValidate>
        {overriding && (
          <div className="notice amber oe-span3" role="note">
            <span>
              This expense is <b>{APPROVAL[status]?.long || status}</b>. It can be edited only while Pending approval — as
              {' '}Super Admin / Admin you may still correct it, and the correction is recorded in the audit log with your reason.
            </span>
          </div>
        )}
        {overriding && (
          <label className={`field oe-span3${bad('overrideReason') ? ' oe-qx-bad' : ''}`} data-invalid={inv('overrideReason')} onBlur={touch('overrideReason')}><span>Reason for the correction *</span>
            <input value={form.overrideReason} onChange={(e) => set('overrideReason', e.target.value)} placeholder="e.g. Vendor sent a revised invoice — GST rate was 12%, not 18%" />
            <FieldErr k="overrideReason" />
          </label>
        )}

        <FormSection id={SECTIONS[0].id} title={SECTIONS[0].title} className="oe-span3" />
        {/* Category · Expense date · Expense account */}
        <div className={`field${bad('category') ? ' oe-qx-bad' : ''}`} data-invalid={inv('category')} onBlur={touch('category')}><span>Category *</span>
          <Combo creatable={!!acc.approver} value={form.category} onChange={(e) => pickCategory(e.target.value)} placeholder={acc.approver ? 'Pick or type a category' : 'Pick a category'} aria-label="Category">
            {[...new Set([...(cats || opts.allCategories || []), ...(form.category ? [form.category] : [])])].sort((a, b) => a.localeCompare(b))
              .map((c) => <option key={c} value={c}>{c}</option>)}
          </Combo>
          <FieldErr k="category" />
          {acc.canEditCategories && newCat === null && (
            <button type="button" className="link-btn oe-addcat" onClick={() => { setNewCat(''); setCatErr(''); }}>+ Add new category</button>
          )}
          {newCat !== null && (
            <span className="oe-addcat-row">
              <input value={newCat} autoFocus maxLength={60} placeholder="New category name" aria-label="New category name" onChange={(e) => setNewCat(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCategory(); } if (e.key === 'Escape') setNewCat(null); }} />
              <button type="button" className="btn btn-sm btn-primary" onClick={addCategory}>Add</button>
              <button type="button" className="btn btn-sm" onClick={() => setNewCat(null)}>Cancel</button>
            </span>
          )}
          {catErr && <Hint tone="bad">{catErr}</Hint>}
        </div>
        <label className={`field${bad('expenseDate') ? ' oe-qx-bad' : ''}`} data-invalid={inv('expenseDate')} onBlur={touch('expenseDate')}><span>Expense date *</span>
          <input type="date" required value={form.expenseDate} onChange={(e) => set('expenseDate', e.target.value)} />
          <FieldErr k="expenseDate" />
        </label>
        <div className="field"><span>Expense account</span>
          <Combo creatable value={form.expenseAccount} onChange={(e) => set('expenseAccount', e.target.value)} placeholder="Ledger it is booked to" aria-label="Expense account">
            {[...new Set([...(opts.expenseAccounts || []), ...(opts.allCategories || [])])].sort().map((c) => <option key={c} value={c}>{c}</option>)}
          </Combo>
        </div>

        {/* Payment frequency · Custom months covered */}
        <label className="field"><span>Payment frequency</span>
          <select value={form.frequency} onChange={(e) => set('frequency', e.target.value)}>
            {[...new Set([...FREQ, form.frequency])].map((x) => <option key={x}>{x}</option>)}
          </select>
        </label>
        <label className="field"><span>Custom months covered</span>
          <input type="number" min="1" max="120" step="1" placeholder={`by frequency · ${FREQ_MONTHS[form.frequency] || 1}`} value={form.monthsCovered} onChange={(e) => set('monthsCovered', e.target.value)} />
          <Hint>Blank = what the frequency covers</Hint>
        </label>
        <label className="field"><span>Kind</span>
          <select value={form.entryKind} onChange={(e) => set('entryKind', e.target.value)}>
            <option value="expense">Expense — money the office spent</option>
            <option value="hand">Hand loan / owner&apos;s money — not an expense</option>
          </select>
        </label>

        {/* Reason */}
        <label className="field oe-span3"><span>Reason</span>
          <input value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="What the money was for — e.g. Office rent, Madhapur, September" />
          <Hint>Shown as the bill name in the table and searched by the filter bar</Hint>
        </label>

        <FormSection id={SECTIONS[1].id} title={SECTIONS[1].title} className="oe-span3" />
        {/* Bill amount · GST applicable · GST rate */}
        <label className={`field${bad('baseAmount') ? ' oe-qx-bad' : ''}`} data-invalid={inv('baseAmount')} onBlur={touch('baseAmount')}><span>Bill amount — before GST (₹) *</span>
          <input type="number" min="0" step="0.01" required inputMode="decimal" value={form.baseAmount} onChange={(e) => setMoney('baseAmount', e.target.value)} />
          <FieldErr k="baseAmount" />
        </label>
        <label className="field"><span>GST applicable</span>
          <select value={form.gstApplicable} onChange={(e) => { setMoney('gstApplicable', e.target.value); if (e.target.value === 'Yes' && !(Number(form.gstRatePct) > 0)) set('gstRatePct', '18'); }}>
            <option>Yes</option><option>No</option>
          </select>
        </label>
        <label className="field"><span>GST rate (%)</span>
          <select value={form.gstApplicable === 'Yes' ? form.gstRatePct : '0'} disabled={form.gstApplicable !== 'Yes'} onChange={(e) => setMoney('gstRatePct', e.target.value)}>
            {[...new Set([...(opts.gstRates || [0, 5, 12, 18, 28]).map(String), String(form.gstRatePct), '0'])]
              .sort((a, b) => Number(a) - Number(b)).map((r) => <option key={r} value={r}>{r}%</option>)}
          </select>
        </label>

        {/* TDS applicable · TDS rate · Goods or service */}
        <label className="field"><span>TDS applicable</span>
          <select value={form.tdsApplicable} onChange={(e) => { setMoney('tdsApplicable', e.target.value); if (e.target.value === 'Yes' && !(Number(form.tdsRatePct) > 0)) set('tdsRatePct', '10'); }}>
            <option>No</option><option>Yes</option>
          </select>
        </label>
        <label className="field"><span>TDS rate (%)</span>
          <select value={form.tdsApplicable === 'Yes' ? form.tdsRatePct : '0'} disabled={form.tdsApplicable !== 'Yes'} onChange={(e) => setMoney('tdsRatePct', e.target.value)}>
            {[...new Set([...(opts.tdsRates || [0, 1, 2, 5, 10]).map(String), String(form.tdsRatePct), '0'])]
              .sort((a, b) => Number(a) - Number(b)).map((r) => <option key={r} value={r}>{r}%</option>)}
          </select>
        </label>
        <label className="field"><span>Goods or service</span>
          <select value={form.supplyType} onChange={(e) => set('supplyType', e.target.value)}>{SUPPLY.map((x) => <option key={x}>{x}</option>)}</select>
        </label>

        {/* HSN/SAC */}
        <label className={`field${bad('hsnSac') ? ' oe-qx-bad' : ''}`} data-invalid={inv('hsnSac')} onBlur={touch('hsnSac')}><span>HSN / SAC</span>
          <input value={form.hsnSac} inputMode="numeric" maxLength={8} placeholder={form.supplyType === 'Goods' ? 'HSN, e.g. 8471' : 'SAC, e.g. 997212'} onChange={(e) => set('hsnSac', e.target.value.replace(/[^0-9]/g, ''))} />
          {hsnBad ? <Hint tone="bad">4, 6 or 8 digits</Hint> : <Hint>From the vendor&apos;s invoice — HSN for goods, SAC (starts 99) for services</Hint>}
        </label>

        <FormSection id={SECTIONS[2].id} title={SECTIONS[2].title} className="oe-span3" />
        {/* Paid to / Vendor · Vendor GSTIN */}
        <div className="field" onBlur={touch('vendor')}><span>Paid to / Vendor</span>
          <Combo creatable value={form.vendor} onChange={(e) => pickVendor(e.target.value)} placeholder={catVendors.length ? `${catVendors.length} vendor(s) in ${form.category}` : 'Pick or type a vendor'} aria-label="Paid to / Vendor">
            {catVendors.length > 0 ? (
              <>
                <optgroup label={`${form.category}`}>{catVendors.map((v) => <option key={v} value={v}>{v}</option>)}</optgroup>
                <optgroup label="Other vendors">{vendorList.filter((v) => !catVendors.includes(v)).map((v) => <option key={v} value={v}>{v}</option>)}</optgroup>
              </>
            ) : vendorList.map((v) => <option key={v} value={v}>{v}</option>)}
          </Combo>
          <button type="button" className="link-btn oe-addvendor"
            onClick={() => setAddVendor({ name: form.vendor && !vendorList.some((x) => x.toLowerCase() === form.vendor.trim().toLowerCase()) ? form.vendor : '' })}>
            + Add Vendor
          </button>
        </div>
        <label className={`field${bad('vendorGstin') ? ' oe-qx-bad' : ''}`} data-invalid={inv('vendorGstin')} onBlur={touch('vendorGstin')}><span>Vendor GSTIN</span>
          <input value={form.vendorGstin} maxLength={15} placeholder="15 characters" onChange={(e) => { const g = e.target.value.toUpperCase().replace(/\s+/g, ''); setForm((cur) => withGstin(cur, g)); }} />
          {gc && <Hint tone={gc.ok ? 'ok' : 'bad'}>{gc.ok ? `GSTIN valid · ${gc.stateName}` : gc.error}</Hint>}
          {!gc && <Hint>{shown.gst > 0 ? 'Without it the GST on this bill cannot be claimed' : 'Needed only when the bill carries GST'}</Hint>}
        </label>

        {/* GST treatment · Source of supply · Destination of supply */}
        <label className="field"><span>GST treatment</span>
          <select value={form.gstTreatment} onChange={(e) => set('gstTreatment', e.target.value)}>{[...new Set([...TREAT, form.gstTreatment])].map((x) => <option key={x}>{x}</option>)}</select>
        </label>
        <label className="field"><span>Source of supply</span>
          <select value={form.sourceState} onChange={(e) => set('sourceState', e.target.value)}>
            <option value="">— State —</option>
            {[...new Set([...STATES, form.sourceState].filter(Boolean))].map((x) => <option key={x}>{x}</option>)}
          </select>
        </label>
        <label className="field"><span>Destination of supply</span>
          <select value={form.destState} onChange={(e) => set('destState', e.target.value)}>
            <option value="">— State —</option>
            {[...new Set([...STATES, form.destState].filter(Boolean))].map((x) => <option key={x}>{x}</option>)}
          </select>
          {form.sourceState && form.destState && <Hint>{interState ? 'Inter-state — IGST' : 'Within the state — CGST + SGST'}</Hint>}
        </label>

        {/* Reverse charge */}
        <label className="field"><span>Reverse charge</span>
          <select value={form.reverseCharge} onChange={(e) => set('reverseCharge', e.target.value)}>
            <option>No</option><option>Yes</option>
          </select>
        </label>

        <FormSection id={SECTIONS[3].id} title={SECTIONS[3].title} className="oe-span3" />
        {/* Billable to a client · Reporting tags */}
        <div className="field"><span>Billable to a client</span>
          <Combo creatable value={form.billableClient} onChange={(e) => set('billableClient', e.target.value)} placeholder="Not billable" aria-label="Billable to a client">
            <option value="">Not billable</option>
            {(opts.clients || []).map((c) => <option key={c} value={c}>{c}</option>)}
          </Combo>
        </div>
        <label className="field"><span>Reporting tags</span>
          <input value={form.reportingTags} list="oe-tag-list" onChange={(e) => set('reportingTags', e.target.value)} placeholder="e.g. Hyderabad office, Q2 budget" />
          <datalist id="oe-tag-list">{(opts.tags || []).map((t) => <option key={t} value={t} />)}</datalist>
          <Hint>Separate tags with commas</Hint>
        </label>

        {/* Payment mode · Bill no · Payment status */}
        <label className="field"><span>Payment mode</span>
          <select value={form.paymentMode} onChange={(e) => set('paymentMode', e.target.value)}>
            {[...new Set(['Cash', 'Bank Transfer', 'UPI', 'Cheque', ...(opts.modes || []), form.paymentMode])].map((m) => <option key={m}>{m}</option>)}
          </select>
        </label>
        <label className="field"><span>Bill / Invoice no</span>
          <input value={form.billNumber} onChange={(e) => set('billNumber', e.target.value)} placeholder="The vendor's invoice number" />
        </label>
        {editing || !acc.approver ? (
          <div className="field"><span>Status</span>
            <div className="oe-static"><span className={`oe-appr ${(APPROVAL[status] || APPROVAL.PENDING).cls}`}>{(APPROVAL[status] || APPROVAL.PENDING).long}</span></div>
            <Hint>{editing ? 'Mark it paid from the row' : 'Every new expense waits for the Accounts Admin / Approver to mark it paid'}</Hint>
          </div>
        ) : (
          <label className="field"><span>Status on saving</span>
            <select value={form.approvalStatus} onChange={(e) => set('approvalStatus', e.target.value)}>
              <option value="PENDING">Pending</option>
              <option value="PAID">Paid (signed off by me)</option>
            </select>
            <Hint>Approver only — recorded as your sign-off</Hint>
          </label>
        )}

        {/* Due date · Signed off by */}
        <label className="field"><span>Due date</span>
          <input type="date" value={form.dueDate} onChange={(e) => set('dueDate', e.target.value)} />
        </label>
        <div className="field"><span>Signed off by</span>
          <div className="oe-static">{row && row.approvedBy ? row.approvedBy : <span className="small-muted">set when it is marked paid</span>}</div>
        </div>
        <label className="field"><span>Location</span>
          <input value={form.location} onChange={(e) => set('location', e.target.value)} placeholder="Office or branch" />
        </label>

        {/* Remarks */}
        <label className="field oe-span3"><span>Remarks</span>
          <input value={form.remarks} onChange={(e) => set('remarks', e.target.value)} />
        </label>

        <FormSection id={SECTIONS[4].id} title={SECTIONS[4].title} className="oe-span3" />
        {/* Attach bill or receipt */}
        <label className="field oe-span3"><span>Attach bill or receipt</span>
          <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp" onChange={pickFile} />
          <Hint>
            PDF, PNG, JPEG or WebP, up to 5 MB. The vendor&apos;s own tax invoice is what lets the GST be claimed.
            {onFile ? ` On file now: ${row.proofName} — a new file replaces it.` : ''}
          </Hint>
        </label>

        {/* The live summary */}
        <div className="oe-sum oe-span3" aria-live="polite">
          <div className="oe-sum-col">
            <div><span>Bill amount</span><b>{money2(shown.base)}</b></div>
            <div><span>GST @ {shown.gstPct}%</span><b>{money2(shown.gst)}</b></div>
            <div><span>Less TDS{shown.tdsPct ? ` @ ${shown.tdsPct}%` : ''}</span><b>− {money2(shown.tds)}</b></div>
            <div className="oe-sum-net"><span>Net amount paid</span><b>{money2(net)}</b></div>
          </div>
          <div className="oe-sum-col">
            <div><span>Months covered</span><b>{months}</b></div>
            <div><span>Monthly equivalent</span><b>{money2(perMonth)}</b></div>
            <div><span>Coverage end</span><b>{endIso ? fmtD(endIso) : '—'}</b></div>
            <div className="oe-sum-note">Net ÷ months covered · coverage ends the day before the same date {months} month{months === 1 ? '' : 's'} on</div>
          </div>
        </div>

        {err && <div className="notice red oe-span3" style={{ marginBottom: 0 }} role="alert"><span>{err}</span></div>}
      </form>
      {addVendor && (
        <AddVendorModal
          initialName={addVendor.name}
          existingNames={vendorList}
          onClose={() => setAddVendor(null)}
          onSaved={vendorAdded}
        />
      )}
    </Modal>
  );
}
