import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api';
import Modal from '../Modal.jsx';
import './clientsrole.css';

// ---------------------------------------------------------------------------
// CLIENTS ROLE SPEC §7 — ONE main button per row, by role — and §8.5 the
// quick actions (+ Requirement · Call · Add Note) that work without opening
// the client:
//
//   BDE         + New job                      (+ Call · Note)
//   TL          Jobs                           (+ Job)
//   Accounts    Unpaid / Make invoice          (+ Note)
//   Admin       Edit (incl. client manager)    (+ Job · Call · Note)
//   Management  View  (view only)              (+ Call)
//   Pause / Reactivate / Ask to pause / Archive / Restore / Delete: the
//   Client 360 header (the server's lifecycleActions decide).
//
// `meta.actions` (GET /clients/meta) decides every button — the same can() /
// role rules the API enforces. Call is a tel: link and is drawn only for a
// login that is sent the client's phone at all (never a TL / Recruiter /
// Accounts).
// ---------------------------------------------------------------------------
const reqNew = (c) => `/requirements?new=1&clientId=${encodeURIComponent(c.id)}`;
const reqList = (c) => `/requirements?clientId=${encodeURIComponent(c.id)}`;

export function NoteModal({ client, onClose, onSaved }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function save() {
    if (!text.trim()) return setError('Write the note first.');
    setSaving(true);
    setError('');
    try {
      await api.post(`/clients/${client.id}/notes`, { note: text.trim() });
      onSaved?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save the note. Try again.');
    } finally {
      setSaving(false);
    }
    return null;
  }
  return (
    <Modal
      title={`Add note — ${client.name}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save note'}</button>
        </>
      )}
    >
      <label className="field">
        <span>Note</span>
        <textarea rows="4" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Call summary, follow-up, anything the next person should know…" />
      </label>
      <div className="small-muted" style={{ fontSize: 11.5 }}>Saved in Notes with your name and time.</div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

// Simplicity checklist #11 — no "⋯" menu. Change client manager is in Edit
// (the Client manager (BDE) field); Pause / Reactivate / Ask to pause /
// Archive / Restore / Delete are buttons in the Client 360 header (the row
// opens Client 360).
export default function ClientRowActions({ c, meta, onEdit, onNote }) {
  const navigate = useNavigate();
  if (!meta) return null;
  const a = meta.actions || {};
  const role = meta.role;
  const stop = (e) => e.stopPropagation();

  let main = null;
  if (role === 'bde' && a.newRequirement && !(c.lifecycle === 'Paused' || c.lifecycle === 'Archived')) {
    main = <button type="button" className="btn btn-sm btn-primary" onClick={() => navigate(reqNew(c))}>+ New job</button>;
  } else if (role === 'tl') {
    main = <button type="button" className="btn btn-sm" onClick={() => navigate(reqList(c))}>Jobs</button>;
  } else if (role === 'accounts') {
    main = (
      <>
        <button type="button" className="btn btn-sm" onClick={() => navigate(`/clients/${c.id}?tab=invoices`)}>Unpaid</button>
        {a.generateInvoice && (
          <button type="button" className="btn btn-sm btn-primary" title="Make an invoice for a joining of this client" onClick={() => navigate(`/invoices?client=${encodeURIComponent(c.name)}&join=new`)}>
            Make invoice
          </button>
        )}
      </>
    );
  } else if (role === 'admin' && a.edit) {
    main = <button type="button" className="btn btn-sm" onClick={() => onEdit?.(c)}>Edit</button>;
  } else {
    main = <button type="button" className="btn btn-sm" onClick={() => navigate(`/clients/${c.id}`)}>View</button>;
  }

  const paused = c.lifecycle === 'Paused' || c.lifecycle === 'Archived';

  const showQuickReq = a.newRequirement && role !== 'bde' && role !== 'mgmt' && !paused;
  return (
    <div className="clrole-actions" onClick={stop}>
      {main}
      {showQuickReq && (
        <button type="button" className="clrole-quick" title="New job for this client" onClick={() => navigate(reqNew(c))}>+ Job</button>
      )}
      {a.call && c.contactPhone && (
        <a className="clrole-quick" href={`tel:${String(c.contactPhone).replace(/[^\d+]/g, '')}`} title={`Call ${c.contactName || 'the client'} — ${c.contactPhone}`}>Call</a>
      )}
      {a.note && (
        <button type="button" className="clrole-quick" title="Add a note to this client" onClick={() => onNote?.(c)}>Note</button>
      )}
    </div>
  );
}
