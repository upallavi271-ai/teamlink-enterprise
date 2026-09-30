import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api';
import Modal from '../Modal.jsx';
import Combo from '../Combo.jsx';
import './clientsrole.css';

// ---------------------------------------------------------------------------
// CLIENTS ROLE SPEC §7 — ONE main button per row, by role — and §8.5 the
// quick actions (+ Requirement · Call · Add Note) that work without opening
// the client:
//
//   BDE         + New Requirement              (+ Call · Note)
//   TL          View Requirements              (+ Requirement)
//   Accounts    View Outstanding / Generate Invoice   (+ Note)
//   Admin       Edit  ⋯ Reassign Owner · Deactivate · Delete  (+ Req · Call · Note)
//   Management  View  (view only)              (+ Call)
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
      setError(err.response?.data?.error || 'Could not save the note');
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
      <div className="small-muted" style={{ fontSize: 11.5 }}>Saved to this client&apos;s Activity with your name and the time.</div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

export function ReassignModal({ client, onClose, onSaved }) {
  const [options, setOptions] = useState(null);
  const [owner, setOwner] = useState(client.bdeOwner || '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.get('/clients/owner-options').then((r) => setOptions(r.data)).catch(() => setOptions([]));
  }, []);
  async function save() {
    setSaving(true);
    setError('');
    try {
      await api.put(`/clients/${client.id}`, { bdeOwner: owner.trim() });
      onSaved?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not reassign the owner');
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title={`Reassign Owner BDE — ${client.name}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={saving || owner.trim() === String(client.bdeOwner || '').trim()} onClick={save}>
            {saving ? 'Saving…' : 'Reassign'}
          </button>
        </>
      )}
    >
      <label className="field">
        <span>Owner BDE</span>
        <Combo creatable value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">— Unassigned —</option>
          {(options || []).map((u) => <option key={u.id} value={u.name}>{u.name}</option>)}
        </Combo>
      </label>
      <div className="small-muted" style={{ fontSize: 11.5 }}>
        {`Currently: ${client.bdeOwner || 'Unassigned'}. The new owner sees this client under My Clients. The change is recorded in the client's Activity.`}
      </div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

export default function ClientRowActions({ c, meta, onChanged, onEdit, onNote, onReassign }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  if (!meta) return null;
  const a = meta.actions || {};
  const role = meta.role;
  const stop = (e) => e.stopPropagation();

  let main = null;
  if (role === 'bde' && a.newRequirement) {
    main = <button type="button" className="btn btn-sm btn-primary" onClick={() => navigate(reqNew(c))}>+ New Requirement</button>;
  } else if (role === 'tl') {
    main = <button type="button" className="btn btn-sm" onClick={() => navigate(reqList(c))}>View Requirements</button>;
  } else if (role === 'accounts') {
    main = (
      <>
        <button type="button" className="btn btn-sm" onClick={() => navigate(`/clients/${c.id}?tab=invoices`)}>View Outstanding</button>
        {a.generateInvoice && (
          <button type="button" className="btn btn-sm btn-primary" title="Raise an invoice for this client's joining" onClick={() => navigate(`/invoices?client=${encodeURIComponent(c.name)}&join=new`)}>
            Generate Invoice
          </button>
        )}
      </>
    );
  } else if (role === 'admin' && a.edit) {
    main = <button type="button" className="btn btn-sm" onClick={() => onEdit?.(c)}>Edit</button>;
  } else {
    main = <button type="button" className="btn btn-sm" onClick={() => navigate(`/clients/${c.id}`)}>View</button>;
  }

  async function setStatus(next) {
    setOpen(false);
    if (!window.confirm(`${next === 'Inactive' ? 'Deactivate' : 'Activate'} ${c.name}?`)) return;
    try {
      await api.put(`/clients/${c.id}`, { status: next });
      onChanged?.();
    } catch (err) {
      window.alert(err.response?.data?.error || 'Could not change the status');
    }
  }
  async function remove() {
    setOpen(false);
    if (!window.confirm(`Delete ${c.name}? This cannot be undone. A client with requirements, invoices or portal logins is never deleted — deactivate it instead.`)) return;
    try {
      await api.delete(`/clients/${c.id}`);
      onChanged?.();
    } catch (err) {
      window.alert(err.response?.data?.error || 'Could not delete this client');
    }
  }

  const showQuickReq = a.newRequirement && role !== 'bde' && role !== 'mgmt';
  const menu = role === 'admin' && (a.reassign || a.deactivate || a.delete);
  return (
    <div className="clrole-actions" onClick={stop}>
      {main}
      {showQuickReq && (
        <button type="button" className="clrole-quick" title="+ New requirement for this client" onClick={() => navigate(reqNew(c))}>+ Req</button>
      )}
      {a.call && c.contactPhone && (
        <a className="clrole-quick" href={`tel:${String(c.contactPhone).replace(/[^\d+]/g, '')}`} title={`Call ${c.contactName || 'the client'} — ${c.contactPhone}`}>Call</a>
      )}
      {a.note && (
        <button type="button" className="clrole-quick" title="Add a note to this client" onClick={() => onNote?.(c)}>Note</button>
      )}
      {menu && (
        <div className="clrole-more" ref={ref}>
          <button type="button" className="clrole-quick" aria-haspopup="menu" aria-expanded={open} title="More actions" onClick={() => setOpen((o) => !o)}>⋯</button>
          {open && (
            <div className="clrole-menu" role="menu">
              {a.reassign && <button type="button" role="menuitem" onClick={() => { setOpen(false); onReassign?.(c); }}>Reassign Owner</button>}
              {a.deactivate && (c.status === 'Inactive'
                ? <button type="button" role="menuitem" onClick={() => setStatus('Active')}>Activate</button>
                : <button type="button" role="menuitem" onClick={() => setStatus('Inactive')}>Deactivate</button>)}
              {a.delete && <button type="button" role="menuitem" className="danger" onClick={remove}>Delete client</button>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
