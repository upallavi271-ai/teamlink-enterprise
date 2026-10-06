import { useState } from 'react';
import api from '../../api';
import { initials } from '../../atsVocab';
import { productRole } from '../../permissions';
import Modal from '../Modal.jsx';
import StatusChip from '../ui/StatusChip.jsx';
import { ContactButtons } from './ProfileSlots.jsx';
import './ProfileTop.css';

// ---------------------------------------------------------------------------
// The profile's TOP (Candidates §7): initials circle, name, phone, email,
// location, current step, and the big Call / WhatsApp / Mail / SMS buttons
// (ContactButtons slot). Shared by the big window and the full page.
//
// ProfileTools: Archive / Bring back (Team lead, Admin, Super Admin) and the
// real Delete (Super Admin only, duplicate or wrong entry only) — the server
// checks every rule again (routes/candidatesBoard.js).
// ---------------------------------------------------------------------------
const code = (c) => c.code || `CAN-${String(c.id || '').slice(-8).toUpperCase()}`;
const ARCHIVE_ROLES = ['SUPER_ADMIN', 'ADMIN', 'STL', 'TL'];
export const mayArchive = (user) => !!user && (ARCHIVE_ROLES.includes(user.role) || ARCHIVE_ROLES.includes(productRole(user, 'ats')));
export const isSuperAdmin = (user) => !!user && (user.role === 'SUPER_ADMIN' || productRole(user, 'ats') === 'SUPER_ADMIN');

export default function ProfileTop({
  c, app, internal, onChanged, extra = null,
}) {
  if (!c) return null;
  const stage = app ? (app.stageLabel || app.stageGroupLabel) : null;
  return (
    <div className="cpt">
      <span className="cpt-ini" aria-hidden="true">{initials(c.name)}</span>
      <div className="cpt-main">
        <div className="cpt-name">
          {c.name}
          <span className="cpt-code" title={c.id}>{code(c)}</span>
          {c.profileStatus === 'Archived' && <span className="cpt-flag is-orange">Archived</span>}
          {c.profileStatus === 'Do Not Use' && <span className="cpt-flag is-red">Do not use</span>}
        </div>
        <div className="cpt-facts">
          {c.phone && <span>{c.phone}</span>}
          {c.email && <span className="cpt-email">{c.email}</span>}
          {c.location && <span>{c.location}</span>}
          {c.experienceYears != null && <span>{`${c.experienceYears} yrs exp`}</span>}
        </div>
        <div className="cpt-step">
          <span className="small-muted">Current step:</span>
          {' '}
          {stage ? <StatusChip status={app.stageGroupLabel || stage}>{stage}</StatusChip> : <span className="small-muted">Not in any job yet</span>}
          {app && app.requirement && <span className="small-muted">{` · ${app.requirement.title || ''}`}</span>}
        </div>
      </div>
      <div className="cpt-btns">
        <ContactButtons c={c} app={app} internal={internal} onChanged={onChanged} />
        {extra}
      </div>
    </div>
  );
}

export function ProfileTools({
  c, user, onChanged, onDeleted,
}) {
  const [dlg, setDlg] = useState(null); // 'archive' | 'delete'
  const [reason, setReason] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const archived = c.profileStatus === 'Archived';
  const canArchive = mayArchive(user) && c.profileStatus !== 'Do Not Use';
  const canDelete = isSuperAdmin(user);
  if (!canArchive && !canDelete) return null;

  async function doArchive(on) {
    setBusy(true); setMsg(null);
    try {
      await api.post(`/candidates/${c.id}/${on ? 'archive' : 'unarchive'}`, { reason });
      setDlg(null); setReason('');
      setMsg({ ok: true, text: on ? `${c.name} is archived — hidden from every list. Nothing was deleted.` : `${c.name} is back in the lists.` });
      if (onChanged) onChanged();
    } catch (err) {
      setMsg({ ok: false, text: err.response?.data?.error || 'That did not work. Try again.' });
    } finally { setBusy(false); }
  }
  async function doDelete() {
    setBusy(true); setMsg(null);
    try {
      await api.delete(`/candidates/${c.id}`, { data: { reason, confirmName } });
      setDlg(null);
      if (onDeleted) onDeleted(c);
    } catch (err) {
      setMsg({ ok: false, text: err.response?.data?.error || 'Could not delete. Please try again.' });
      setDlg(null);
    } finally { setBusy(false); }
  }

  return (
    <div className="cpt-tools">
      {canArchive && !archived && <button type="button" className="btn btn-sm" onClick={() => { setReason(''); setDlg('archive'); }}>Archive</button>}
      {canArchive && archived && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => doArchive(false)}>Bring back</button>}
      {canDelete && <button type="button" className="btn btn-sm btn-ghost cpt-del" onClick={() => { setReason(''); setConfirmName(''); setDlg('delete'); }}>Delete (wrong entry)</button>}
      {msg && <span className={msg.ok ? 'cpt-ok' : 'error-text'}>{msg.text}</span>}

      {dlg === 'archive' && (
        <Modal
          title={`Archive ${c.name}?`}
          onClose={() => setDlg(null)}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setDlg(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={busy || !reason.trim()} onClick={() => doArchive(true)}>Archive</button>
            </>
          )}
        >
          <div className="small-muted" style={{ marginBottom: 8 }}>
            Archived people are hidden from every list. Nothing is deleted. You can bring them back from People → Archived.
          </div>
          <label className="field">
            <span>Why? *</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Not looking for a job any more" />
          </label>
        </Modal>
      )}

      {dlg === 'delete' && (
        <Modal
          title={`Delete ${c.name} for good?`}
          onClose={() => setDlg(null)}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setDlg(null)}>Cancel</button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy || !reason || confirmName.trim().toLowerCase() !== String(c.name || '').trim().toLowerCase()}
                onClick={doDelete}
              >
                Delete for good
              </button>
            </>
          )}
        >
          <div className="notice red" style={{ marginBottom: 8 }}>
            Only for a duplicate or a wrong entry. This cannot be undone. For anyone else, use Archive.
          </div>
          <div className="field">
            <span>Why? *</span>
            <div className="contact-methods">
              {['Duplicate', 'Wrong entry'].map((r) => (
                <button key={r} type="button" className={`contact-method${reason === r ? ' is-on' : ''}`} onClick={() => setReason(r)}>{r}</button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>{`Type the name to confirm: ${c.name}`}</span>
            <input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />
          </label>
        </Modal>
      )}
    </div>
  );
}
