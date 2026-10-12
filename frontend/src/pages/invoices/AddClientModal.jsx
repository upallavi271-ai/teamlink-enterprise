// "+ Add client" - Invoices. Adds a client to the SAME client list the ATS uses
// (POST /invoice-clients -> the central Client table, CLI auto ID, the ATS
// duplicate rules). It is saved as a DRAFT: a BDE or Admin completes it in
// Clients before it can get jobs. Fields (plain words): client name, company,
// contact person, email, phone, billing address, GSTIN.
import { useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import './addClient.css';

const BLANK = {
  clientName: '', company: '', contactName: '', email: '', phone: '', billingAddress: '', gstin: '',
};
const errText = (e, f) => (e?.response ? e.response.data?.error || f : 'Cannot reach the server. Try again.');

export default function AddClientModal({ initialName = '', onClose, onSaved }) {
  const [v, setV] = useState({ ...BLANK, clientName: initialName });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [fieldErr, setFieldErr] = useState({});
  const [dup, setDup] = useState(null); // { blocking, error, duplicates }
  const set = (k) => (e) => {
    const val = k === 'gstin' ? e.target.value.toUpperCase().replace(/\s+/g, '') : e.target.value;
    setV({ ...v, [k]: val });
    setFieldErr({ ...fieldErr, [k]: undefined });
    setDup(null);
  };

  async function save(confirmDuplicate) {
    setErr('');
    if (!v.clientName.trim()) { setFieldErr({ clientName: 'Write the client name.' }); return; }
    setBusy(true);
    try {
      const res = await api.post('/invoice-clients', { ...v, confirmDuplicate: confirmDuplicate === true });
      onSaved(res.data.client, res.data.message);
    } catch (e) {
      const d = e.response?.data || {};
      if (e.response?.status === 409 && d.duplicates) setDup(d);
      else if (d.field) setFieldErr({ [d.field]: d.error });
      else setErr(errText(e, 'The client could not be saved.'));
      setBusy(false);
    }
  }
  const field = (k, label, props = {}) => (
    <div className={`inv-acf${props.full ? ' inv-acf-full' : ''}`}>
      <label htmlFor={`ac-${k}`}>{label}</label>
      {props.area
        ? <textarea id={`ac-${k}`} rows={2} value={v[k]} maxLength={500} onChange={set(k)} />
        : <input id={`ac-${k}`} type={props.type || 'text'} value={v[k]} maxLength={props.max || 160} onChange={set(k)} placeholder={props.ph} autoComplete="off" />}
      {fieldErr[k] && <div className="inv-err">{fieldErr[k]}</div>}
    </div>
  );
  return (
    <Modal
      title="Add client"
      size="wide"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          {dup && !dup.blocking
            ? <button type="button" className="btn btn-primary" disabled={busy} onClick={() => save(true)}>Yes, it is a different client — save</button>
            : <button type="button" className="btn btn-primary" disabled={busy || (dup && dup.blocking)} onClick={() => save(false)}>{busy ? 'Saving…' : 'Save client'}</button>}
        </>
      )}
    >
      <div className="small-muted" style={{ marginBottom: 10 }}>
        The client goes into the same client list as the ATS. It stays a <b>draft</b> until a BDE or Admin completes it in Clients — so it can be billed here, but it cannot get jobs yet.
      </div>
      <div className="inv-acgrid">
        {field('clientName', 'Client name *', { ph: 'e.g. Orbit Hospitals' })}
        {field('company', 'Company (legal name)', { max: 200 })}
        {field('contactName', 'Contact person', { max: 120 })}
        {field('email', 'Email', { type: 'email' })}
        {field('phone', 'Phone', { type: 'tel', max: 30 })}
        {field('gstin', 'GSTIN', { max: 15, ph: '15 characters, optional' })}
        {field('billingAddress', 'Billing address', { area: true, full: true })}
      </div>
      {dup && (
        <div className={`notice ${dup.blocking ? 'red' : 'amber'}`} style={{ marginTop: 10 }}>
          <span>
            {dup.error}
            {(dup.duplicates || []).slice(0, 3).map((m) => (
              <div key={m.id} className="small-muted">{m.name} ({m.displayCode}){m.gst ? ` · ${m.gst}` : ''} — {m.reasons.map((r) => r.label).join('; ')}</div>
            ))}
          </span>
        </div>
      )}
      {err && <div className="notice red" style={{ marginTop: 10 }}><span>{err}</span></div>}
    </Modal>
  );
}
