// "+ New Expense" (one-page spec 10) and its Edit (spec 13) — the CLEAN modal.
// Required: date, category, description, vendor / paid to, payment mode and
// amount. Optional: GST %, bill / invoice number, the bill file, status (new
// only) and notes. GST Amount = Amount × GST % and Total = Amount + GST are
// worked out as you type. The Expense ID, Added By and Created At are the
// server's. The older full form (ExpenseModal.jsx) is still one press away —
// "Edit (full details)" — for TDS, HSN, GST treatment and the rest.
//
// ONE SCROLLING PAGE: the sections sit one below the other under their own
// headings, a field is checked when you leave it, and Save takes you to the
// first field that still needs fixing. The action bar (Cancel / Save) stays
// on screen (onepage.css .oe-qx .modal-foot). "+ Add Vendor" beside the
// Vendor box adds a vendor without leaving the form and picks it.
import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import Combo from '../../components/Combo.jsx';
import { APPROVAL, ApprovalBadge } from './approval.jsx';
import { money2, todayIso, fmtD } from './officeUtil';
import { FormSection, useJumpToInvalid } from './FormSections.jsx';
import AddVendorModal from './AddVendorModal.jsx';

export const NEW_MODES = ['Bank Transfer', 'UPI', 'Cash', 'Credit Card', 'Debit Card', 'Cheque', 'Other'];
const GST_RATES = [0, 5, 12, 18, 28];
// Spec 11: PDF, JPG, JPEG, PNG. The server (utils/attachments.js) checks the
// file's first bytes as well and takes up to 5 MB.
const BILL_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];
const BILL_EXT = /\.(pdf|png|jpe?g)$/i;
const BILL_MAX = 5 * 1024 * 1024;
const r2 = (n) => Math.round(n * 100) / 100;

const when = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return `${fmtD(d.toISOString().slice(0, 10))}, ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
};

function fromRow(r) {
  return {
    expenseDate: r.expenseDate || todayIso(),
    category: r.category || '',
    description: r.description || '',
    vendor: r.vendor || '',
    paymentMode: r.paymentMode || '',
    amount: r.base != null ? String(r.base) : '',
    gstPct: String(r.gstRate ?? 0),
    billNumber: r.billNumber || '',
    notes: r.remarks || r.notes || '',
    status: r.approvalStatus || 'PENDING',
    reason: '',
  };
}
const BLANK = () => ({
  expenseDate: todayIso(), category: '', description: '', vendor: '', paymentMode: '', amount: '', gstPct: '0',
  billNumber: '', notes: '', status: 'PENDING', reason: '',
});

export default function QuickExpenseModal({
  row, access, options, onClose, onSaved, onOpenFull,
}) {
  const editing = !!row;
  const acc = access || {};
  const status = editing ? (row.approvalStatus || 'PENDING') : 'PENDING';
  // Editing is for a Pending expense; Super Admin / Admin may correct a
  // later one with a reason (the API's rule — routes/office.js).
  const overriding = editing && status !== 'PENDING';
  const [f, setF] = useState(() => (editing ? fromRow(row) : BLANK()));
  const [cats, setCats] = useState(options?.categories || []);
  const [file, setFile] = useState(null);
  const [tried, setTried] = useState(false);
  const [err, setErr] = useState('');
  const [dup, setDup] = useState(null);
  const [busy, setBusy] = useState(false);
  const [savedId, setSavedId] = useState(editing ? row.id : null);
  const [touched, setTouched] = useState({});
  const [addVendor, setAddVendor] = useState(null); // null | { name } while Add Vendor is open
  const [masterVendors, setMasterVendors] = useState([]);
  const fileRef = useRef(null);
  const formRef = useRef(null);
  const jump = useJumpToInvalid(formRef);

  // The live category list (the 13 of the spec plus every one in use).
  useEffect(() => {
    api.get('/office-expenses/categories').then((r) => {
      const names = r.data.map((c) => c.name);
      setCats((cur) => [...new Set([...names, ...cur])].sort((a, b) => a.localeCompare(b)));
    }).catch(() => {});
  }, []);

  // The vendor master (GET /office-expenses/vendors) joins the vendors already
  // on bills, so a vendor added with "+ Add Vendor" is in the list at once.
  useEffect(() => {
    api.get('/office-expenses/vendors').then((r) => setMasterVendors(r.data.map((v) => v.name))).catch(() => {});
  }, []);

  const set = (k) => (e) => { const v = e && e.target ? e.target.value : e; setF((cur) => ({ ...cur, [k]: v })); setDup(null); };

  const amount = Number(f.amount);
  const gstPct = Number(f.gstPct) || 0;
  const gstAmt = Number.isFinite(amount) && amount > 0 ? r2((amount * gstPct) / 100) : 0;
  const total = Number.isFinite(amount) && amount > 0 ? r2(amount + gstAmt) : 0;
  // Editing without touching the money keeps the bill's own stored amounts.
  const moneyTouched = !editing || String(r2(amount)) !== String(r2(Number(row.base) || 0)) || gstPct !== Number(row.gstRate || 0);
  const shownGst = moneyTouched ? gstAmt : Number(row.gst || 0);
  const shownTotal = moneyTouched ? total : r2(Number(row.base || 0) + Number(row.gst || 0));

  const errors = useMemo(() => {
    const e = {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.expenseDate)) e.expenseDate = 'Pick the expense date';
    if (!f.category.trim()) e.category = 'Pick a category';
    if (!f.description.trim()) e.description = 'Say what it was for';
    if (!f.vendor.trim()) e.vendor = 'Who was paid?';
    if (!f.paymentMode) e.paymentMode = 'Pick how it was paid';
    if (!(amount > 0)) e.amount = 'Amount must be more than zero';
    else if (amount > 100000000) e.amount = 'That amount looks too large';
    if (!(gstPct >= 0 && gstPct <= 100)) e.gstPct = 'GST % is 0 to 100';
    if (overriding && !f.reason.trim()) e.reason = 'Say why this expense is being corrected';
    return e;
  }, [f, amount, gstPct, overriding]);
  const bad = (k) => (tried || touched[k]) && errors[k];
  // Checked on leaving the field (React's onBlur bubbles, so the wrapper
  // hears it for the input, the select and the type-to-search box alike).
  // Focus moving within the field (the box to its own "+ Add Vendor") is not leaving it.
  const touch = (k) => (e) => {
    if (e && e.relatedTarget && e.currentTarget && e.currentTarget.contains(e.relatedTarget)) return;
    setTouched((cur) => (cur[k] ? cur : { ...cur, [k]: true }));
  };
  const inv = (k) => (bad(k) ? 'true' : undefined);

  const pickFile = (e) => {
    const x = e.target.files && e.target.files[0];
    setErr('');
    if (!x) { setFile(null); return; }
    if (!BILL_TYPES.includes(x.type) && !BILL_EXT.test(x.name)) {
      setErr(`${x.name} is not a PDF, JPG, JPEG or PNG file.`); e.target.value = ''; setFile(null); return;
    }
    if (x.size > BILL_MAX) { setErr(`${x.name} is larger than 5 MB — attach a smaller scan.`); e.target.value = ''; setFile(null); return; }
    setFile(x);
  };

  const save = async (ev, allowDuplicate) => {
    if (ev) ev.preventDefault();
    setTried(true);
    setErr('');
    if (Object.keys(errors).length) { setErr('Fix the highlighted fields first.'); jump(); return; }
    const body = {
      form: 'quick',
      expenseDate: f.expenseDate,
      category: f.category.trim(),
      description: f.description.trim(),
      vendor: f.vendor.trim(),
      paymentMode: f.paymentMode,
      billNumber: f.billNumber.trim(),
      remarks: f.notes.trim(),
    };
    if (moneyTouched) {
      body.baseAmount = String(r2(amount));
      body.gstRatePct = String(gstPct);
      // A bill that carries TDS keeps its TDS rate; the amount follows the new base.
      if (editing && Number(row.tds || 0) > 0) body.tdsRatePct = String(row.tdsRate || 0);
    }
    if (!editing) {
      body.approvalStatus = f.status;
      if (allowDuplicate) body.allowDuplicate = true;
    }
    if (overriding) { body.override = true; body.overrideReason = f.reason.trim(); }
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
      const d = e2.response?.data;
      if (e2.response?.status === 409 && d?.duplicateOf) setDup(d);
      else setErr(d?.error || 'The expense could not be saved.');
      setBusy(false);
      return;
    }
    if (file) {
      const fd = new FormData();
      fd.append('file', file);
      try {
        await api.post(`/office-expenses/${id}/proof`, fd);
      } catch (e3) {
        // The expense itself is saved; Save again only retries the file.
        setErr(`The expense was saved, but ${file.name} could not be attached: ${e3.response?.data?.error || 'upload failed'}.`);
        setBusy(false);
        return;
      }
    }
    onSaved(id);
  };

  const modes = [...new Set([...NEW_MODES, ...(editing && f.paymentMode && !NEW_MODES.includes(f.paymentMode) ? [f.paymentMode] : [])])];
  const vendors = [...new Set([...(options?.vendors || []).map((v) => (typeof v === 'string' ? v : v.name)), ...masterVendors])]
    .sort((a, b) => a.localeCompare(b));
  // A vendor made in "+ Add Vendor" is picked; nothing else on the form moves.
  const vendorAdded = (v) => {
    setMasterVendors((cur) => [...new Set([...cur, v.name])]);
    setF((cur) => ({ ...cur, vendor: v.name }));
    setTouched((cur) => ({ ...cur, vendor: true }));
    setDup(null);
    setAddVendor(null);
  };
  const rates = [...new Set([...GST_RATES, ...(editing ? [Number(row.gstRate || 0)] : [])])].sort((a, b) => a - b);

  return (
    <Modal
      title={editing ? `Edit expense · ${row.expenseCode || ''}` : 'New Expense'}
      note={editing ? (overriding ? `${APPROVAL[status]?.long || status} — correction` : null) : 'Fields marked * are required'}
      size="oe-qx"
      onClose={onClose}
      footer={(
        <>
          {onOpenFull && (
            <button type="button" className="btn btn-ghost" onClick={onOpenFull} disabled={busy} title="The full expense form — TDS, HSN / SAC, GST treatment, due date and more">
              {editing ? 'Edit (full details)' : 'Full form'}
            </button>
          )}
          <span style={{ marginRight: 'auto' }} />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="oe-qx-form" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : (editing ? 'Save changes' : 'Save expense')}
          </button>
        </>
      )}
    >
      <form id="oe-qx-form" ref={formRef} className="oe-qx-grid oe-fs-form" onSubmit={save} noValidate>
        {overriding && (
          <div className="notice amber oe-qx-full" role="note">
            <span>
              This expense is <b>{APPROVAL[status]?.long || status}</b>. It can be edited only while Pending — as Super Admin / Admin you may
              still correct it, and the correction is written to the audit log with your reason.
            </span>
          </div>
        )}

        <div className="oe-qx-id oe-qx-full">
          <span><em>Expense ID</em><b className="num">{editing ? (row.expenseCode || '—') : 'Given on save'}</b></span>
          {editing && <span><em>Status</em><ApprovalBadge s={status} /></span>}
          {editing && <span><em>Added by</em>{row.createdBy?.name || '—'} · {when(row.createdAt)}</span>}
        </div>

        <FormSection id="oe-qx-s-expense" title="Expense" className="oe-qx-full" />
        <label className={`field${bad('expenseDate') ? ' oe-qx-bad' : ''}`} data-invalid={inv('expenseDate')} onBlur={touch('expenseDate')}><span>Expense Date *</span>
          <input type="date" value={f.expenseDate} onChange={set('expenseDate')} max="2100-12-31" aria-invalid={bad('expenseDate') ? true : undefined} />
          {bad('expenseDate') && <em className="oe-qx-err">{errors.expenseDate}</em>}
        </label>
        <div className={`field${bad('category') ? ' oe-qx-bad' : ''}`} data-invalid={inv('category')} onBlur={touch('category')}><span>Category *</span>
          <Combo creatable={!!acc.approver} value={f.category} onChange={set('category')} placeholder="Pick a category" aria-label="Category">
            {[...new Set([...cats, ...(f.category ? [f.category] : [])])].map((c) => <option key={c} value={c}>{c}</option>)}
          </Combo>
          {bad('category') && <em className="oe-qx-err">{errors.category}</em>}
        </div>

        <label className={`field oe-qx-full${bad('description') ? ' oe-qx-bad' : ''}`} data-invalid={inv('description')} onBlur={touch('description')}><span>Description *</span>
          <input value={f.description} maxLength={500} onChange={set('description')} placeholder="What the money was for — e.g. Cab to client meeting, Madhapur" aria-invalid={bad('description') ? true : undefined} />
          {bad('description') && <em className="oe-qx-err">{errors.description}</em>}
        </label>

        <FormSection id="oe-qx-s-vendor" title="Vendor & payment" className="oe-qx-full" />
        <div className={`field${bad('vendor') ? ' oe-qx-bad' : ''}`} data-invalid={inv('vendor')} onBlur={touch('vendor')}><span>Vendor / Paid To *</span>
          <Combo creatable value={f.vendor} onChange={set('vendor')} placeholder="Pick or type who was paid" aria-label="Vendor / Paid To">
            {[...new Set([...vendors, ...(f.vendor ? [f.vendor] : [])])].map((v) => <option key={v} value={v}>{v}</option>)}
          </Combo>
          {bad('vendor') && <em className="oe-qx-err">{errors.vendor}</em>}
          <button type="button" className="link-btn oe-addvendor"
            onClick={() => setAddVendor({ name: f.vendor && !vendors.some((x) => x.toLowerCase() === f.vendor.trim().toLowerCase()) ? f.vendor : '' })}>
            + Add Vendor
          </button>
        </div>
        <label className={`field${bad('paymentMode') ? ' oe-qx-bad' : ''}`} data-invalid={inv('paymentMode')} onBlur={touch('paymentMode')}><span>Payment Mode *</span>
          <select value={f.paymentMode} onChange={set('paymentMode')} aria-invalid={bad('paymentMode') ? true : undefined}>
            <option value="">— Pick —</option>
            {modes.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          {bad('paymentMode') && <em className="oe-qx-err">{errors.paymentMode}</em>}
        </label>

        <FormSection id="oe-qx-s-amount" title="Amount & GST" className="oe-qx-full" />
        <label className={`field${bad('amount') ? ' oe-qx-bad' : ''}`} data-invalid={inv('amount')} onBlur={touch('amount')}><span>Amount (₹, before GST) *</span>
          <input type="number" min="0" step="0.01" inputMode="decimal" value={f.amount} onChange={set('amount')} placeholder="0.00" aria-invalid={bad('amount') ? true : undefined} />
          {bad('amount') && <em className="oe-qx-err">{errors.amount}</em>}
        </label>
        <label className={`field${bad('gstPct') ? ' oe-qx-bad' : ''}`} data-invalid={inv('gstPct')} onBlur={touch('gstPct')}><span>GST %</span>
          <select value={String(gstPct)} onChange={set('gstPct')}>
            {rates.map((x) => <option key={x} value={String(x)}>{x}%</option>)}
          </select>
        </label>

        <div className="oe-qx-calc oe-qx-full" aria-live="polite">
          <div><span>Amount</span><b>{money2(moneyTouched ? (amount > 0 ? amount : 0) : row.base)}</b></div>
          <div><span>GST Amount{gstPct ? ` @ ${gstPct}%` : ''}</span><b>{money2(shownGst)}</b></div>
          <div className="tot"><span>Total (Amount + GST)</span><b>{money2(shownTotal)}</b></div>
        </div>
        {editing && Number(row.tds || 0) > 0 && (
          <div className="small-muted oe-qx-full oe-qx-tds">
            This bill also carries TDS {row.tdsRate ? `@ ${row.tdsRate}% ` : ''}({money2(row.tds)}) — it is kept as it is (paid to the vendor after TDS:
            {' '}{money2(r2(shownTotal - Number(row.tds || 0)))}). Change TDS in <b>Edit (full details)</b>.
          </div>
        )}

        <FormSection id="oe-qx-s-bill" title="Bill, status & notes" className="oe-qx-full" />
        <label className="field"><span>Bill / Invoice Number</span>
          <input value={f.billNumber} maxLength={60} onChange={set('billNumber')} placeholder="The vendor's invoice number" />
        </label>
        <label className="field"><span>Bill / Invoice Upload</span>
          <input ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/png,image/jpeg" onChange={pickFile} />
          <em className="oe-qx-hint">PDF, JPG, JPEG or PNG · up to 5 MB{editing && row.proofName ? ` · on file: ${row.proofName} (a new file replaces it)` : ''}</em>
        </label>

        {!editing && (
          <label className="field"><span>Status</span>
            <select value={f.status} onChange={set('status')} disabled={!acc.approver}>
              <option value="PENDING">Pending</option>
              {acc.approver && <option value="PAID">Paid</option>}
            </select>
            <em className="oe-qx-hint">{acc.approver ? 'Paid is recorded as your sign-off' : 'A new expense waits for the Accounts Admin / Approver to mark it paid'}</em>
          </label>
        )}
        {overriding && (
          <label className={`field${bad('reason') ? ' oe-qx-bad' : ''}`} data-invalid={inv('reason')} onBlur={touch('reason')}><span>Reason for the correction *</span>
            <input value={f.reason} onChange={set('reason')} placeholder="e.g. Vendor sent a revised invoice" aria-invalid={bad('reason') ? true : undefined} />
            {bad('reason') && <em className="oe-qx-err">{errors.reason}</em>}
          </label>
        )}

        <label className="field oe-qx-full"><span>Notes</span>
          <textarea rows={2} maxLength={1000} value={f.notes} onChange={set('notes')} />
        </label>

        {dup && (
          <div className="notice amber oe-qx-full" role="alert">
            <span>
              {dup.error}
              <span className="oe-qx-dup-a">
                <button type="button" className="btn btn-sm" onClick={() => setDup(null)}>Go back</button>
                <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => save(null, true)}>Save anyway</button>
              </span>
            </span>
          </div>
        )}
        {err && <div className="notice red oe-qx-full" role="alert" style={{ marginBottom: 0 }}><span>{err}</span></div>}
      </form>
      {addVendor && (
        <AddVendorModal
          initialName={addVendor.name}
          existingNames={vendors}
          onClose={() => setAddVendor(null)}
          onSaved={vendorAdded}
        />
      )}
    </Modal>
  );
}
