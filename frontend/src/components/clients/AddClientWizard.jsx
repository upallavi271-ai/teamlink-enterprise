import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import Combo from '../Combo.jsx';
import {
  deptOptions, LOCS, INDIAN_STATES, CLIENT_INDUSTRIES, PAYMENT_TERMS,
} from '../../atsVocab';
import { useClientDuplicateCheck, ClientDuplicateWarning } from './ClientDuplicateCheck.jsx';
import './clientsrole.css';

// ---------------------------------------------------------------------------
// CLIENTS ROLE SPEC §9 — Add Client is ONE form in THREE steps:
//
//   1 Basic      Name · Industry · Address · Owner BDE
//   2 Contacts   HR name · phone · email (at least one contact)
//   3 Agreement  Fee % · Guarantee days · Payment terms · Agreement file
//
// The EXISTING duplicate guard runs before anything is saved: the form asks
// POST /clients/check-duplicate (utils/clientDuplicates.js — same name,
// GSTIN, PAN, phone, email …) when a matching field is left and again on
// Save, and POST /clients refuses a blocking match (409) unless "Create New
// Anyway" was clicked — audit-logged with the note.
//
// A BDE adding a client is its Owner BDE (shown locked); the server enforces
// the same. The agreement is then generated from these terms, or the file's
// text stored through the existing POST /clients/:id/agreement/upload — the
// e-sign lifecycle (Send → Signed → Active) continues on the client's
// Agreements tab exactly as before.
// ---------------------------------------------------------------------------
const STEPS = [
  [1, 'Basic', 'Name, industry, address, owner'],
  [2, 'Contacts', 'HR name, phone, email'],
  [3, 'Agreement', 'Fee, guarantee, terms, file'],
];
const today = () => new Date().toISOString().slice(0, 10);
const nextYear = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEXT_FILE = /\.(txt|md|html?|rtf)$/i;

function emptyForm(user, ownerLocked) {
  return {
    name: '', industry: '', gst: '', ownerDepartment: deptOptions(user)[0] || 'IT',
    houseNumber: '', street: '', area: '', location: LOCS[0], state: '', pincode: '', country: 'India',
    bdeOwner: ownerLocked || '',
    contactName: '', contactDesignation: 'HR', contactPhone: '', contactEmail: '',
    secondaryContactName: '', secondaryContactDesignation: '', secondaryContactPhone: '', secondaryContactEmail: '',
    billingContactName: '', billingContactEmail: '', billingContactPhone: '',
    agreementFeePercent: 8.33, guaranteeDays: 30, paymentTerms: PAYMENT_TERMS[0],
    agreementStart: today(), agreementEnd: nextYear(),
    status: 'Active', activeDate: today(),
  };
}

export default function AddClientWizard({ user, meta, onClose, onSaved }) {
  const ownerLocked = meta?.ownerLocked || null;
  const [form, setForm] = useState(() => emptyForm(user, ownerLocked));
  const [step, setStep] = useState(1);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [owners, setOwners] = useState([]);
  const [showMore, setShowMore] = useState(false);
  // Agreement: generate from the terms (default), store an uploaded file's
  // text, or leave it for later.
  const [agreementMode, setAgreementMode] = useState('generate');
  const [agreementFile, setAgreementFile] = useState({ name: '', text: '', note: '' });
  const [preview, setPreview] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const dup = useClientDuplicateCheck();
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const checkDup = () => { dup.check(form); };

  useEffect(() => {
    if (ownerLocked) return;
    api.get('/clients/owner-options').then((r) => setOwners(r.data || [])).catch(() => setOwners([]));
  }, [ownerLocked]);

  useEffect(() => {
    if (!showPreview) return undefined;
    const t = setTimeout(() => {
      api.get('/clients/agreement-preview', {
        params: {
          name: form.name, location: form.location, feePercent: form.agreementFeePercent, gst: form.gst,
          paymentTerms: form.paymentTerms, guaranteePeriod: `${form.guaranteeDays} Days`,
        },
      }).then((r) => setPreview(r.data.document)).catch(() => setPreview(''));
    }, 250);
    return () => clearTimeout(t);
  }, [showPreview, form.name, form.location, form.agreementFeePercent, form.gst, form.paymentTerms, form.guaranteeDays]);

  // Step checks — the same the server applies to a full (non-draft) save.
  function problem(n) {
    if (n === 1) {
      if (!form.name.trim()) return 'Enter the client (company) name.';
      if (!form.state) return 'Select the state of the client address.';
      if (!String(form.location || '').trim()) return 'Enter the city of the client address.';
    }
    if (n === 2) {
      if (!form.contactName.trim() || !form.contactPhone.trim() || !form.contactEmail.trim()) {
        return 'Add at least one contact — the HR name, phone and email.';
      }
      if (!EMAIL_RE.test(form.contactEmail.trim())) return 'The contact email does not look right.';
    }
    if (n === 3) {
      const fee = Number(form.agreementFeePercent);
      if (!Number.isFinite(fee) || fee <= 0 || fee > 100) return 'Enter the fee % (between 0 and 100).';
      const g = Number(form.guaranteeDays);
      if (!Number.isFinite(g) || g < 0) return 'Enter the guarantee period in days (0 for none).';
      if (form.agreementEnd && form.agreementStart && form.agreementEnd < form.agreementStart) return 'The agreement end date is before its start date.';
      if (agreementMode === 'upload' && !agreementFile.text.trim()) return 'Choose a text agreement file, or paste the agreement text, or pick another option.';
    }
    return '';
  }

  async function next() {
    const p = problem(step);
    if (p) return setError(p);
    setError('');
    if (step === 1 || step === 2) {
      // The duplicate check runs as soon as the identifying fields are in.
      const found = await dup.check(form);
      if (found.matches.length && !found.acked) {
        return setError('Possible duplicate found — review the existing client(s) above: open it, or confirm "Create New Anyway".');
      }
    }
    setStep((s) => Math.min(3, s + 1));
    return null;
  }

  async function pickFile(file) {
    if (!file) return setAgreementFile({ name: '', text: '', note: '' });
    if (file.size > 2 * 1024 * 1024) return setAgreementFile({ name: file.name, text: '', note: 'That file is over 2 MB.' });
    if (TEXT_FILE.test(file.name) || String(file.type).startsWith('text/')) {
      const text = await file.text();
      return setAgreementFile({ name: file.name, text, note: '' });
    }
    // The agreement is stored as its text (the same field the generated
    // document uses, so Preview / Send / e-sign keep working). A PDF / Word
    // file's text cannot be read here — keep its name and paste the text.
    return setAgreementFile({
      name: file.name,
      text: agreementFile.text,
      note: 'PDF / Word files are not read here — paste the agreement text below (the file name is kept with it).',
    });
  }

  async function save() {
    for (const n of [1, 2, 3]) {
      const p = problem(n);
      if (p) { setStep(n); return setError(p); }
    }
    setError('');
    // §9 — the existing duplicate guard, BEFORE saving.
    const found = await dup.check(form);
    if (found.matches.length && !found.acked) {
      setStep(1);
      return setError('Possible duplicate found — review the existing client(s) above: open it, or confirm "Create New Anyway".');
    }
    const { guaranteeDays, ...rest } = form;
    const body = {
      ...rest,
      guaranteePeriod: Number(guaranteeDays) === 0 ? 'No replacement' : `${Number(guaranteeDays)} Days`,
      createAgreement: agreementMode === 'generate',
      asDraft: false,
      ...dup.overrideBody(),
    };
    if (ownerLocked) body.bdeOwner = ownerLocked;
    setSaving(true);
    let created;
    try {
      created = (await api.post('/clients', body)).data;
    } catch (err) {
      setSaving(false);
      if (err.response?.status === 409 && err.response.data?.duplicates) {
        dup.fromServer(err.response.data);
        setStep(1);
        return setError(err.response.data.error);
      }
      return setError(err.response?.data?.error || 'Could not save this client');
    }
    let warning = '';
    if (agreementMode === 'upload') {
      try {
        await api.post(`/clients/${created.id}/agreement/upload`, { document: agreementFile.text, fileName: agreementFile.name || null });
      } catch (err) {
        warning = `Client saved, but the agreement file was not stored: ${err.response?.data?.error || 'upload failed'}. Upload it from the client's Agreements tab.`;
      }
    }
    setSaving(false);
    onSaved?.(created, warning);
    return null;
  }

  const input = (k, props = {}) => <input value={form[k] ?? ''} onChange={(e) => set({ [k]: e.target.value })} {...props} />;

  return (
    <Modal
      title="Add Client"
      size="wide"
      onClose={onClose}
      footer={(
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          {step > 1 && <button className="btn" type="button" onClick={() => { setError(''); setStep(step - 1); }}>← Back</button>}
          {step < 3
            ? <button className="btn btn-primary" type="button" onClick={next}>Next →</button>
            : <button className="btn btn-primary" type="button" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save Client'}</button>}
        </>
      )}
    >
      <div className="clrole-steps" role="tablist" aria-label="Add Client steps">
        {STEPS.map(([n, label, hint]) => (
          <button
            key={n}
            type="button"
            role="tab"
            aria-selected={step === n}
            className={`clrole-step${step === n ? ' on' : ''}${step > n ? ' done' : ''}`}
            title={hint}
            onClick={() => { if (n < step) { setError(''); setStep(n); } else if (n > step) next(); }}
          >
            <span className="n">{step > n ? '✓' : n}</span>
            <span>{label}</span>
          </button>
        ))}
      </div>

      {/* §8 — the existing duplicate warning, visible whichever step the
          matching value was typed on. */}
      <ClientDuplicateWarning dup={dup} anywayLabel="Create New Anyway" />

      {step === 1 && (
        <>
          <div className="grid-2">
            <label className="field">
              <span>Client name *</span>
              {input('name', { autoFocus: true, onBlur: checkDup, placeholder: 'Company / display name' })}
            </label>
            <label className="field">
              <span>Industry</span>
              <Combo creatable value={form.industry} onChange={(e) => set({ industry: e.target.value })}>
                <option value="">— Select —</option>
                {CLIENT_INDUSTRIES.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
            <label className="field">
              <span>Owner BDE</span>
              {ownerLocked ? (
                <>
                  <input value={ownerLocked} disabled />
                  <span className="clrole-locked">You own the clients you add.</span>
                </>
              ) : (
                <Combo creatable value={form.bdeOwner} onChange={(e) => set({ bdeOwner: e.target.value })}>
                  <option value="">— Unassigned —</option>
                  {owners.map((u) => <option key={u.id} value={u.name}>{u.name}</option>)}
                </Combo>
              )}
            </label>
            <label className="field">
              <span>Owner department</span>
              <Combo creatable value={form.ownerDepartment} onChange={(e) => set({ ownerDepartment: e.target.value })}>
                {deptOptions(user).map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
          </div>
          <div className="section-label">Address</div>
          <div className="grid-2">
            <label className="field"><span>Building / street</span>{input('street', { placeholder: 'e.g. 4th floor, Cyber Towers' })}</label>
            <label className="field"><span>Area</span>{input('area')}</label>
            <label className="field">
              <span>City *</span>
              <Combo creatable value={form.location} onChange={(e) => set({ location: e.target.value })}>
                {LOCS.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
            <label className="field">
              <span>State *</span>
              <Combo value={form.state} onChange={(e) => set({ state: e.target.value })}>
                <option value="">State</option>
                {INDIAN_STATES.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
            <label className="field"><span>Pin code</span>{input('pincode', { onBlur: checkDup })}</label>
            <label className="field">
              <span>GSTIN</span>
              {input('gst', { onBlur: checkDup, placeholder: 'Optional — checked for duplicates' })}
            </label>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <div className="clrole-hint">At least one contact is required — the HR person TeamLink works with.</div>
          <div className="clrole-contact">
            <div className="clrole-contact-head">Contact 1 — HR *</div>
            <div className="grid-2">
              <label className="field"><span>HR name *</span>{input('contactName', { autoFocus: true })}</label>
              <label className="field"><span>Designation</span>{input('contactDesignation', { placeholder: 'HR Manager' })}</label>
              <label className="field"><span>Phone *</span>{input('contactPhone', { onBlur: checkDup, inputMode: 'tel' })}</label>
              <label className="field"><span>Email *</span>{input('contactEmail', { onBlur: checkDup, type: 'email' })}</label>
            </div>
          </div>
          {showMore ? (
            <>
              <div className="clrole-contact">
                <div className="clrole-contact-head">Contact 2</div>
                <div className="grid-2">
                  <label className="field"><span>Name</span>{input('secondaryContactName')}</label>
                  <label className="field"><span>Designation</span>{input('secondaryContactDesignation')}</label>
                  <label className="field"><span>Phone</span>{input('secondaryContactPhone', { onBlur: checkDup })}</label>
                  <label className="field"><span>Email</span>{input('secondaryContactEmail', { onBlur: checkDup, type: 'email' })}</label>
                </div>
              </div>
              <div className="clrole-contact">
                <div className="clrole-contact-head">Billing contact (Accounts sees this one)</div>
                <div className="grid-2">
                  <label className="field"><span>Name</span>{input('billingContactName')}</label>
                  <label className="field"><span>Phone</span>{input('billingContactPhone', { onBlur: checkDup })}</label>
                  <label className="field"><span>Email</span>{input('billingContactEmail', { onBlur: checkDup, type: 'email' })}</label>
                </div>
              </div>
            </>
          ) : (
            <button type="button" className="btn btn-sm" onClick={() => setShowMore(true)}>+ Add another contact / billing contact</button>
          )}
        </>
      )}

      {step === 3 && (
        <>
          <div className="grid-2">
            <label className="field">
              <span>Fee % *</span>
              {input('agreementFeePercent', { type: 'number', step: '0.01', min: '0', max: '100' })}
            </label>
            <label className="field">
              <span>Guarantee (days) *</span>
              {input('guaranteeDays', { type: 'number', step: '1', min: '0' })}
            </label>
            <label className="field" style={{ gridColumn: '1 / -1' }}>
              <span>Payment terms</span>
              <Combo creatable value={form.paymentTerms} onChange={(e) => set({ paymentTerms: e.target.value })}>
                {PAYMENT_TERMS.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
            <label className="field"><span>Agreement start</span>{input('agreementStart', { type: 'date' })}</label>
            <label className="field"><span>Agreement end</span>{input('agreementEnd', { type: 'date' })}</label>
          </div>

          <div className="section-label">Agreement</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <input type="radio" name="agrmode" checked={agreementMode === 'generate'} onChange={() => setAgreementMode('generate')} style={{ width: 'auto' }} />
              Generate the agreement from these terms (TeamLink standard template)
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <input type="radio" name="agrmode" checked={agreementMode === 'upload'} onChange={() => setAgreementMode('upload')} style={{ width: 'auto' }} />
              Upload the client&apos;s own agreement file
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <input type="radio" name="agrmode" checked={agreementMode === 'later'} onChange={() => setAgreementMode('later')} style={{ width: 'auto' }} />
              Later — from the client&apos;s Agreements tab
            </label>
          </div>
          {agreementMode === 'upload' && (
            <div className="clrole-contact">
              <label className="field">
                <span>Agreement file</span>
                <input type="file" accept=".txt,.md,.html,.htm,.rtf,.pdf,.doc,.docx,text/*" onChange={(e) => pickFile(e.target.files[0] || null)} />
              </label>
              {agreementFile.note && <div className="clrole-hint" style={{ marginTop: 0 }}>{agreementFile.note}</div>}
              <label className="field">
                <span>{`Agreement text${agreementFile.name ? ` — ${agreementFile.name}` : ''}`}</span>
                <textarea rows="6" value={agreementFile.text} onChange={(e) => setAgreementFile({ ...agreementFile, text: e.target.value })} placeholder="The agreement text (read from a text file, or pasted)" />
              </label>
            </div>
          )}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowPreview((v) => !v)}>
            {showPreview ? '▾ Hide the agreement preview' : '▸ Preview the generated agreement'}
          </button>
          {showPreview && (
            <div className="small-muted" style={{ whiteSpace: 'pre-line', fontSize: 10.5, lineHeight: 1.5, maxHeight: 260, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 8, padding: 12, marginTop: 8 }}>
              {preview || 'Enter a company name to see the agreement.'}
            </div>
          )}
          <div className="clrole-hint" style={{ marginTop: 10 }}>
            The agreement starts as a Draft. Send it for e-signing from the client&apos;s Agreements tab — Signed → Active unlocks its requirements.
          </div>
        </>
      )}

      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}
