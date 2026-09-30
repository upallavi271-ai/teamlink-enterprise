// "+ Add Vendor" — Office & Expenses. Opened from the Expenses & Bills toolbar
// and from the Vendor field of both expense forms. Saves through
// POST /office-expenses/vendors (the vendor master, routes/office.js), which
// refuses a name that already exists in any letter case with a 409.
//
// Its own dialog, portalled to <body> so it sits above an open expense modal
// without being inside that modal's <form>: Esc closes it (and only it), Tab
// stays inside it, focus goes back where it was on close. A bottom sheet on a
// phone (onepage.css .oe-vm).
import {
  useEffect, useId, useMemo, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import api from '../../api';
import { checkGstin, clean as cleanId } from '../../utils/gstin';
import { useJumpToInvalid } from './FormSections.jsx';
import { showToast } from './toast';

const BLANK = {
  name: '', contactPerson: '', phone: '', email: '', address: '', gstin: '', paymentTerms: '', notes: '',
};
const FIELDS = Object.keys(BLANK);
const TERMS = ['Immediate', 'Advance', 'Net 7', 'Net 15', 'Net 30', 'Net 45', 'Net 60'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const squash = (s) => String(s || '').trim().replace(/\s+/g, ' ');

function validate(v, names) {
  const e = {};
  const name = squash(v.name);
  if (!name) e.name = 'Vendor name is required';
  else if (name.length > 120) e.name = 'Keep the vendor name under 120 characters';
  else {
    const hit = names.find((x) => squash(x).toLowerCase() === name.toLowerCase());
    if (hit) e.name = `A vendor named "${hit}" already exists — pick it from the Vendor list`;
  }
  const phone = v.phone.trim();
  const digits = phone.replace(/\D/g, '').length;
  if (phone && (!/^[+()\d\s-]+$/.test(phone) || digits < 6 || digits > 15)) e.phone = 'Enter a valid phone number (6 to 15 digits)';
  if (v.email.trim() && !EMAIL.test(v.email.trim())) e.email = 'Enter a valid email address';
  const g = cleanId(v.gstin);
  if (g) { const c = checkGstin(g); if (!c.ok) e.gstin = c.error; }
  return e;
}

export default function AddVendorModal({
  initialName = '', existingNames = [], onClose, onSaved,
}) {
  const [v, setV] = useState(() => ({ ...BLANK, name: squash(initialName) }));
  const [master, setMaster] = useState([]);
  const [touched, setTouched] = useState({});
  const [tried, setTried] = useState(false);
  const [serverErr, setServerErr] = useState({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const dlgRef = useRef(null);
  const formRef = useRef(null);
  const titleId = useId();
  const jump = useJumpToInvalid(formRef);

  // The vendor master as well as the names the caller shows, so a duplicate is
  // caught before the round trip (the API checks again).
  useEffect(() => {
    let live = true;
    api.get('/office-expenses/vendors').then((r) => { if (live) setMaster(r.data.map((x) => x.name)); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const names = useMemo(() => [...new Set([...existingNames, ...master].filter(Boolean))], [existingNames, master]);
  const errors = useMemo(() => ({ ...validate(v, names), ...serverErr }), [v, names, serverErr]);
  const show = (k) => (tried || touched[k]) && errors[k];

  // Focus the first field on open; hand focus back on close.
  useEffect(() => {
    const prev = document.activeElement;
    const t = setTimeout(() => { const el = dlgRef.current && dlgRef.current.querySelector('input'); if (el) el.focus(); }, 0);
    return () => {
      clearTimeout(t);
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) prev.focus({ preventScroll: true });
    };
  }, []);

  const close = () => { if (!busy) onClose(); };
  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab' || !dlgRef.current) return;
    const els = [...dlgRef.current.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!els.length) return;
    const first = els[0];
    const last = els[els.length - 1];
    if (e.shiftKey && (document.activeElement === first || !dlgRef.current.contains(document.activeElement))) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const set = (k) => (e) => {
    const val = e.target.value;
    setV((cur) => ({ ...cur, [k]: val }));
    if (serverErr[k]) setServerErr((cur) => { const n = { ...cur }; delete n[k]; return n; });
  };
  const touch = (k) => () => setTouched((cur) => (cur[k] ? cur : { ...cur, [k]: true }));

  const save = async (e) => {
    e.preventDefault();
    e.stopPropagation(); // never reach an expense form this dialog was opened from
    setTried(true);
    setErr('');
    if (Object.keys(errors).length) { jump(); return; }
    const body = {
      name: squash(v.name),
      contactPerson: v.contactPerson.trim(),
      phone: v.phone.trim(),
      email: v.email.trim(),
      address: v.address.trim(),
      gstin: cleanId(v.gstin),
      paymentTerms: v.paymentTerms.trim(),
      notes: v.notes.trim(),
    };
    setBusy(true);
    try {
      const r = await api.post('/office-expenses/vendors', body);
      showToast(`Vendor "${r.data.name}" added`);
      setBusy(false);
      onSaved(r.data);
    } catch (e2) {
      const d = (e2.response && e2.response.data) || {};
      if (d.field && FIELDS.includes(d.field)) {
        setServerErr({ [d.field]: d.error });
        jump();
      } else {
        setErr(d.error || (e2.response ? 'The vendor could not be saved.' : 'No connection — the vendor was not saved. Try again.'));
      }
      setBusy(false);
    }
  };

  const fieldProps = (k) => ({
    'data-invalid': show(k) ? 'true' : undefined,
    className: `field${k === 'address' || k === 'notes' || k === 'name' ? ' oe-vm-full' : ''}${show(k) ? ' oe-qx-bad' : ''}`,
  });
  const inputProps = (k) => ({
    id: `${titleId}-${k}`,
    value: v[k],
    onChange: set(k),
    onBlur: touch(k),
    'aria-invalid': show(k) ? true : undefined,
    'aria-describedby': show(k) ? `${titleId}-${k}-err` : undefined,
  });
  const Err = ({ k }) => (show(k) ? <em className="oe-qx-err" id={`${titleId}-${k}-err`}>{errors[k]}</em> : null);

  return createPortal(
    <div className="overlay show oe-vm-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal oe-vm" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dlgRef} onKeyDown={onKeyDown}>
        <div className="modal-head">
          <h3 id={titleId} style={{ fontSize: 15 }}>Add Vendor</h3>
          <div className="cell-muted" style={{ fontSize: 11.5, marginLeft: 'auto', marginRight: 10 }}>Fields marked * are required</div>
          <button type="button" className="close-x" onClick={close} aria-label="Close" disabled={busy}>×</button>
        </div>
        <div className="modal-body">
          <form ref={formRef} id={`${titleId}-form`} className="oe-vm-grid" onSubmit={save} noValidate>
            <div {...fieldProps('name')}>
              <label htmlFor={`${titleId}-name`}><span>Vendor name *</span></label>
              <input {...inputProps('name')} maxLength={120} autoComplete="organization" placeholder="e.g. Sri Sai Stationers" />
              <Err k="name" />
            </div>
            <div {...fieldProps('contactPerson')}>
              <label htmlFor={`${titleId}-contactPerson`}><span>Contact person</span></label>
              <input {...inputProps('contactPerson')} maxLength={120} autoComplete="name" />
              <Err k="contactPerson" />
            </div>
            <div {...fieldProps('phone')}>
              <label htmlFor={`${titleId}-phone`}><span>Phone</span></label>
              <input {...inputProps('phone')} type="tel" inputMode="tel" maxLength={30} autoComplete="tel" placeholder="+91 98480 12345" />
              <Err k="phone" />
            </div>
            <div {...fieldProps('email')}>
              <label htmlFor={`${titleId}-email`}><span>Email</span></label>
              <input {...inputProps('email')} type="email" inputMode="email" maxLength={160} autoComplete="email" />
              <Err k="email" />
            </div>
            <div {...fieldProps('gstin')}>
              <label htmlFor={`${titleId}-gstin`}><span>GST / Tax ID (GSTIN)</span></label>
              <input {...inputProps('gstin')} maxLength={15} placeholder="15 characters, optional" onChange={(e) => set('gstin')({ target: { value: e.target.value.toUpperCase().replace(/\s+/g, '') } })} />
              {show('gstin') ? <Err k="gstin" /> : (cleanId(v.gstin) && checkGstin(cleanId(v.gstin)).ok
                ? <em className="oe-qx-hint oe-vm-ok">GSTIN valid · {checkGstin(cleanId(v.gstin)).stateName}</em>
                : <em className="oe-qx-hint">Filled in on this vendor&apos;s bills when a bill has no GSTIN of its own</em>)}
            </div>
            <div {...fieldProps('address')}>
              <label htmlFor={`${titleId}-address`}><span>Address</span></label>
              <textarea {...inputProps('address')} rows={2} maxLength={500} autoComplete="street-address" />
              <Err k="address" />
            </div>
            <div {...fieldProps('paymentTerms')}>
              <label htmlFor={`${titleId}-paymentTerms`}><span>Payment terms</span></label>
              <input {...inputProps('paymentTerms')} maxLength={200} list={`${titleId}-terms`} placeholder="e.g. Net 30" />
              <datalist id={`${titleId}-terms`}>{TERMS.map((t) => <option key={t} value={t} />)}</datalist>
              <Err k="paymentTerms" />
            </div>
            <div {...fieldProps('notes')}>
              <label htmlFor={`${titleId}-notes`}><span>Notes</span></label>
              <textarea {...inputProps('notes')} rows={2} maxLength={1000} />
              <Err k="notes" />
            </div>
            {err && <div className="notice red oe-vm-full" role="alert" style={{ marginBottom: 0 }}><span>{err}</span></div>}
          </form>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={close} disabled={busy}>Cancel</button>
          <button type="submit" form={`${titleId}-form`} className="btn btn-primary" disabled={busy} aria-busy={busy || undefined}>
            {busy ? <><span className="oe-spin oe-spin-sm" aria-hidden="true" /> Saving…</> : 'Save vendor'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
