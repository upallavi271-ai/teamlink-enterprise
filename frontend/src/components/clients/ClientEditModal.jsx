import { useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import Combo from '../Combo.jsx';
import { CLIENT_INDUSTRIES, CLIENT_STATUSES, INDIAN_STATES, PAYMENT_TERMS } from '../../atsVocab';
import { useClientDuplicateCheck, ClientDuplicateWarning } from './ClientDuplicateCheck.jsx';

// ---------------------------------------------------------------------------
// Edit the Client Master (review #2 §8): Client ID · Display Name · Legal Name
// · GSTIN · PAN · Industry · Location · Primary Contact · Agreement dates ·
// Payment Terms, plus ownership. Only the CHANGED fields are sent. Changing
// the name / GSTIN / PAN / phone / email re-runs the duplicate check, and the
// server refuses a same-GSTIN / PAN / name collision unless "Save Anyway" was
// clicked (audit-logged with the note).
// ---------------------------------------------------------------------------
const FIELDS = [
  'clientCode', 'name', 'legalName', 'gst', 'pan', 'industry', 'ownerDepartment', 'status', 'location', 'state',
  'contactName', 'contactDesignation', 'contactPhone', 'contactEmail',
  'paymentTerms', 'guaranteePeriod', 'agreementFeePercent', 'agreementStart', 'agreementEnd',
  'accountManager', 'bdeOwner',
];
const COMMERCIAL = ['paymentTerms', 'guaranteePeriod', 'agreementFeePercent'];
const str = (v) => (v === null || v === undefined ? '' : String(v));

// `canReassign` — Owner BDE is changed by an Admin only (clients role spec
// §7; PUT /clients/:id refuses anyone else), so the field is drawn only then.
export default function ClientEditModal({ client, canCommercial, canReassign = false, onClose, onSaved }) {
  const initial = Object.fromEntries(FIELDS.map((k) => [k, str(client[k])]));
  const [form, setForm] = useState(initial);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const dup = useClientDuplicateCheck({ excludeId: client.id });
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const checkDup = () => { dup.check(form, initial); };

  async function save() {
    setError('');
    if (!form.name.trim()) return setError('The display name cannot be blank.');
    const changed = FIELDS.filter((k) => form[k].trim() !== initial[k].trim() && (canCommercial || !COMMERCIAL.includes(k))
      && (canReassign || k !== 'bdeOwner'));
    if (!changed.length) return onClose();
    const found = await dup.check(form, initial);
    if (found.matches.length && !found.acked) {
      return setError('Possible duplicate found — review the existing client(s) above, then View Existing or Save Anyway.');
    }
    const body = Object.fromEntries(changed.map((k) => [k, form[k].trim()]));
    setSaving(true);
    try {
      const res = await api.put(`/clients/${client.id}`, { ...body, ...dup.overrideBody() });
      onSaved(res.data);
    } catch (err) {
      if (err.response?.status === 409 && err.response.data?.duplicates) {
        dup.fromServer(err.response.data);
        setError(err.response.data.error);
      } else {
        setError(err.response?.data?.error || 'Could not save the client');
      }
    } finally {
      setSaving(false);
    }
    return null;
  }

  const input = (k, props = {}) => (
    <input value={form[k]} onChange={(e) => set({ [k]: e.target.value })} {...props} />
  );

  return (
    <Modal
      title={`Edit client — ${client.name}`}
      size="wide"
      onClose={onClose}
      footer={(
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="button" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
        </>
      )}
    >
      <ClientDuplicateWarning dup={dup} anywayLabel="Save Anyway" subject="this client" mergeWith={client.id} />
      <h4 style={{ fontSize: 12, color: 'var(--ink-soft)', margin: '0 0 8px' }}>Client Master</h4>
      <div className="grid-2">
        <label className="field">
          <span>Client ID</span>
          {input('clientCode', { placeholder: client.displayCode ? `${client.displayCode} (display code — set an ID to replace it)` : '' })}
        </label>
        <label className="field"><span>Display Name *</span>{input('name', { onBlur: checkDup })}</label>
        <label className="field"><span>Legal Name</span>{input('legalName', { onBlur: checkDup })}</label>
        <label className="field"><span>GSTIN</span>{input('gst', { onBlur: checkDup, placeholder: '36AAAAA0000A1Z5' })}</label>
        <label className="field"><span>PAN</span>{input('pan', { onBlur: checkDup, placeholder: 'AAAAA0000A' })}</label>
        <label className="field">
          <span>Industry</span>
          <Combo creatable value={form.industry} onChange={(e) => set({ industry: e.target.value })}>
            <option value="">— Select —</option>
            {CLIENT_INDUSTRIES.map((x) => <option key={x}>{x}</option>)}
          </Combo>
        </label>
        <label className="field"><span>City / Location</span>{input('location')}</label>
        <label className="field">
          <span>State</span>
          <Combo value={form.state} onChange={(e) => set({ state: e.target.value })}>
            <option value="">State</option>
            {INDIAN_STATES.map((x) => <option key={x}>{x}</option>)}
          </Combo>
        </label>
        <label className="field">
          <span>Status</span>
          <Combo value={form.status} onChange={(e) => set({ status: e.target.value })}>
            <option value="">—</option>
            {CLIENT_STATUSES.map((x) => <option key={x}>{x}</option>)}
          </Combo>
        </label>
        <label className="field"><span>Owner Department</span>{input('ownerDepartment')}</label>
      </div>

      <h4 style={{ fontSize: 12, color: 'var(--ink-soft)', margin: '14px 0 8px' }}>Primary Contact</h4>
      <div className="grid-2">
        <label className="field"><span>Name</span>{input('contactName')}</label>
        <label className="field"><span>Designation</span>{input('contactDesignation')}</label>
        <label className="field"><span>Phone</span>{input('contactPhone', { onBlur: checkDup })}</label>
        <label className="field"><span>Email</span>{input('contactEmail', { onBlur: checkDup })}</label>
      </div>

      <h4 style={{ fontSize: 12, color: 'var(--ink-soft)', margin: '14px 0 8px' }}>Agreement &amp; Payment Terms</h4>
      <div className="grid-2">
        <label className="field"><span>Agreement Start</span>{input('agreementStart', { type: 'date' })}</label>
        <label className="field"><span>Agreement End</span>{input('agreementEnd', { type: 'date' })}</label>
        {canCommercial && (
          <>
            <label className="field">
              <span>Payment Terms</span>
              <Combo creatable value={form.paymentTerms} onChange={(e) => set({ paymentTerms: e.target.value })}>
                <option value="">—</option>
                {PAYMENT_TERMS.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
            <label className="field"><span>Replacement / Guarantee Period</span>{input('guaranteePeriod', { placeholder: 'e.g. 3 Months' })}</label>
            <label className="field"><span>Recruitment Fee %</span>{input('agreementFeePercent', { type: 'number', step: '0.01' })}</label>
          </>
        )}
      </div>
      <div className="small-muted" style={{ fontSize: 11.5 }}>
        The agreement status itself moves through the agreement workflow (Generate → Send → Signed → Active), not here.
      </div>

      <h4 style={{ fontSize: 12, color: 'var(--ink-soft)', margin: '14px 0 8px' }}>Ownership</h4>
      <div className="grid-2">
        <label className="field"><span>Account Manager</span>{input('accountManager')}</label>
        {canReassign && <label className="field"><span>Owner BDE</span>{input('bdeOwner')}</label>}
      </div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}
