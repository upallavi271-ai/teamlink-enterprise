import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import api from '../../api';
import Modal from '../Modal.jsx';
import './clientLifecycle.css';
import Combo from '../Combo.jsx';

// ---------------------------------------------------------------------------
// CLIENT PAUSE / ARCHIVE / DELETE (user's spec 2026-10-03 §A).
//
//   Pause      reversible — client data stays; NO new requirement and NO new
//              candidate submission until Reactivate. Reason + audit.
//   Archive    hidden from the default lists, data and accounting intact.
//   Delete     Super Admin only, and only a client with no business records;
//              confirmed by typing the client's exact name.
//
// Which buttons a login gets comes from the server (lifecycleActions on each
// client row and on GET /clients/:id) — the same rules the API enforces.
// ---------------------------------------------------------------------------

export const lifecycleOf = (c) => {
  if (!c) return 'Active';
  if (c.lifecycle) return c.lifecycle;
  const s = String(c.status || '').toLowerCase();
  if (s === 'paused' || s === 'suspended') return 'Paused';
  if (s === 'archived') return 'Archived';
  if (s === 'inactive') return 'Inactive';
  return 'Active';
};

// The small "Client paused" warning shown wherever an open job / application
// of that client appears (Requirements rows, Requirement detail, Candidate 360).
export function ClientPausedBadge({ client, lifecycle, title }) {
  const lc = lifecycle || lifecycleOf(client);
  if (lc !== 'Paused' && lc !== 'Archived') return null;
  return (
    <span
      className={`cllc-badge ${lc === 'Paused' ? 'paused' : 'archived'}`}
      title={title || (lc === 'Paused'
        ? 'Client paused. No new people or requirements.'
        : 'Client archived. No new people or requirements. Records are kept.')}
    >
      {lc === 'Paused' ? 'Client paused' : 'Client archived'}
    </span>
  );
}

export function ClientPausedBanner({ clientName, lifecycle, children }) {
  if (lifecycle !== 'Paused' && lifecycle !== 'Archived') return null;
  return (
    <div className={`notice amber cllc-banner ${lifecycle === 'Paused' ? 'paused' : 'archived'}`}>
      <span>
        <b>{lifecycle === 'Paused' ? 'Client paused' : 'Client archived'}</b>
        {`: ${clientName || 'this client'}. `}
        {lifecycle === 'Paused'
          ? 'No new people or requirements. Work in progress stays.'
          : 'No new people or requirements. Every record is kept.'}
        {children}
      </span>
    </div>
  );
}

// The status chip of the client itself (list + Client 360 header).
export function LifecycleChip({ lifecycle }) {
  if (!lifecycle || lifecycle === 'Active') return null;
  return <span className={`cllc-chip ${lifecycle.toLowerCase()}`}>{lifecycle}</span>;
}

// Menu items / buttons, in one order everywhere.
export const LIFECYCLE_ITEMS = [
  ['pause', 'Pause client'],
  ['requestPause', 'Ask to pause'],
  ['reactivate', 'Resume client'],
  ['deactivate', 'Deactivate'],
  ['requestDeactivate', 'Ask to deactivate'],
  ['archive', 'Archive'],
  ['unarchive', 'Restore'],
  ['delete', 'Delete permanently'],
  ['requestDelete', 'Ask to delete'],
];
// BDE business workspace (2026-10-10): asks that a Manager / Admin decides. They sit on the client page's
// business card as plain buttons (ClientBusiness.jsx), not in the header.
export const BUSINESS_ITEMS = [
  ['submitApproval', 'Send for approval'],
  ['changeOwner', 'Change owner'],
  ['mergeNow', 'Merge with another client'],
];
export const businessItemsFor = (c) => {
  const a = (c && c.lifecycleActions) || {};
  return BUSINESS_ITEMS.filter(([k]) => a[k]);
};
export const lifecycleItemsFor = (c) => {
  const a = (c && c.lifecycleActions) || {};
  return LIFECYCLE_ITEMS.filter(([k]) => a[k]);
};

const COPY = {
  pause: {
    title: 'Pause client',
    button: 'Pause client',
    tone: 'btn-primary',
    explain: [
      'Nothing is deleted.',
      'No new requirements or people sent until you resume.',
    ],
    reasonLabel: 'Why pause this client?',
  },
  requestPause: {
    title: 'Ask to pause',
    button: 'Send request',
    tone: 'btn-primary',
    explain: [
      'An Admin or the department Manager decides.',
      'Once approved: no new requirements or people sent.',
    ],
    reasonLabel: 'Why pause this client?',
  },
  reactivate: {
    title: 'Resume client',
    button: 'Resume',
    tone: 'btn-primary',
    explain: ['New requirements and people sent are allowed again.'],
    reasonLabel: 'Why resume this client?',
  },
  archive: {
    title: 'Archive client',
    button: 'Archive',
    tone: 'btn-danger',
    explain: [
      'Hidden from the list. Every record is kept.',
      'Restore it any time.',
    ],
    reasonLabel: 'Why archive this client?',
  },
  unarchive: {
    title: 'Restore client',
    button: 'Restore',
    tone: 'btn-primary',
    explain: ['The client comes back to the list.'],
    reasonLabel: 'Why restore this client?',
  },
  deactivate: {
    title: 'Deactivate client',
    button: 'Deactivate',
    tone: 'btn-danger',
    explain: ['Nothing is deleted. Every record is kept.', 'Resume the client any time.'],
    reasonLabel: 'Why deactivate this client?',
  },
  requestDeactivate: {
    title: 'Ask to deactivate',
    button: 'Send request',
    tone: 'btn-primary',
    explain: ['The Manager of the department or an Admin decides.', 'You see the answer under Requests.'],
    reasonLabel: 'Why deactivate this client?',
  },
  requestDelete: {
    title: 'Ask to delete',
    button: 'Send request',
    tone: 'btn-danger',
    explain: [
      'An Admin decides.',
      'If approved, the client leaves the lists. Every requirement, note and file is kept.',
    ],
    reasonLabel: 'Why delete this client?',
  },
  changeOwner: {
    title: 'Change owner',
    button: 'Change owner',
    tone: 'btn-primary',
    explain: ['Give this client to another BDE.', 'It changes at once. The reason is saved in the history.'],
    reasonLabel: 'Why change the owner?',
  },
  mergeNow: {
    title: 'Merge with another client',
    button: 'Merge',
    tone: 'btn-danger',
    explain: ['Use this when both are the same company.', 'This client stays. The other one is joined into it, with its requirements and history.'],
    reasonLabel: 'How do you know it is the same company?',
  },
  submitApproval: {
    title: 'Send client for approval',
    button: 'Send for approval',
    tone: 'btn-primary',
    explain: ['The Manager of the department or an Admin checks the client.', 'You see the answer under Requests.'],
    reasonLabel: 'Anything the approver should know? (optional)',
  },
  delete: {
    title: 'Delete client permanently',
    button: 'Delete permanently',
    tone: 'btn-danger',
    explain: [
      'Only for a client added by mistake. Cannot be undone.',
      'A client with any records is archived, not deleted.',
    ],
    reasonLabel: 'Why delete this client?',
  },
};
const PATHS = {
  pause: 'pause', requestPause: 'pause-request', reactivate: 'reactivate', archive: 'archive', unarchive: 'unarchive',
  deactivate: 'deactivate', requestDeactivate: 'request-deactivate', requestDelete: 'request-delete',
  changeOwner: 'change-owner', mergeNow: 'merge', submitApproval: 'submit-approval',
};

// `onSwitch(mode)` (optional): the Archive dialog then offers "Delete it
// instead" when this login may delete (keeps the header to 3 small buttons).
export function ClientLifecycleDialog({ client, mode, onClose, onDone, onSwitch }) {
  const copy = COPY[mode];
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState(null);
  const [agreeOk, setAgreeOk] = useState(false);
  const [newOwner, setNewOwner] = useState('');
  const [owners, setOwners] = useState(null);
  const [otherId, setOtherId] = useState('');
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);

  useEffect(() => {
    if (mode !== 'changeOwner') return;
    api.get('/clients/owner-options', { params: { department: client.ownerDepartment || undefined } })
      .then((r) => setOwners((r.data || []).filter((o) => o.name !== client.bdeOwner)))
      .catch(() => setOwners([]));
  }, [mode, client.ownerDepartment, client.bdeOwner]);
  useEffect(() => {
    if (mode !== 'mergeNow' || q.trim().length < 2) { setFound([]); return undefined; }
    const t = setTimeout(() => {
      api.get('/clients/picker', { params: { q: q.trim(), limit: 8 } }).then((r) => setFound((r.data?.rows || []).filter((x) => x.id !== client.id))).catch(() => setFound([]));
    }, 250);
    return () => clearTimeout(t);
  }, [mode, q, client.id]);

  useEffect(() => {
    if (mode !== 'delete') return;
    api.get(`/clients/${client.id}/delete-check`)
      .then((r) => setCheck(r.data))
      .catch((err) => setCheck({ error: err.response?.data?.error || 'Could not check this client. Please try again.' }));
  }, [mode, client.id]);

  if (!copy) return null;
  const blocked = mode === 'delete' && (!check || check.error || !check.canDelete);
  const nameOk = mode !== 'delete' || typed.trim() === String(client.name).trim();
  const reasonOk = mode === 'submitApproval' || reason.trim().length >= 3;
  const pickOk = (mode !== 'changeOwner' || !!newOwner) && (mode !== 'mergeNow' || !!otherId);
  const needsAgree = mode === 'delete' && !!check?.needsAgreementConfirm;

  async function submit() {
    if (!reasonOk) { setError('Write a reason (at least 3 letters).'); return; }
    if (!pickOk) { setError(mode === 'changeOwner' ? 'Pick the BDE who should get this client.' : 'Pick the other client.'); return; }
    if (!nameOk) { setError('Type the client\'s exact name to confirm.'); return; }
    if (needsAgree && !agreeOk) { setError('Tick "Delete the signed agreement too" to confirm.'); return; }
    setBusy(true);
    setError('');
    try {
      const res = mode === 'delete'
        ? await api.delete(`/clients/${client.id}`, { data: { confirmName: typed.trim(), reason: reason.trim(), confirmSignedAgreement: needsAgree ? agreeOk : undefined } })
        : mode === 'mergeNow'
          ? await api.post('/client-merge/merge', { primaryId: client.id, donorIds: [otherId], reason: reason.trim() })
          : await api.post(`/clients/${client.id}/${PATHS[mode]}`, {
          reason: reason.trim(),
          ...(mode === 'changeOwner' ? { newOwner } : {}),
          ...(mode === 'submitApproval' ? { note: reason.trim() } : {}),
        });
      onDone?.(res.data?.message || 'Done.', res.data, mode);
    } catch (err) {
      setError(err.response?.data?.error || 'That did not work. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  // Portalled to <body>: the dialog must never inherit a table cell's
  // no-wrap / overflow clipping.
  return createPortal((
    <Modal
      title={`${copy.title} — ${client.name}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className={`btn ${copy.tone}`}
            disabled={busy || blocked || !reasonOk || !pickOk || !nameOk || (needsAgree && !agreeOk)}
            onClick={submit}
          >
            {busy ? 'Working…' : copy.button}
          </button>
        </>
      )}
    >
      <div className="cllc-dialog">
        <ul className="cllc-explain">
          {copy.explain.map((t) => <li key={t}>{t}</li>)}
        </ul>

        {mode === 'archive' && onSwitch && client.lifecycleActions?.delete && (
          <div className="small-muted">
            {'Added by mistake? '}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => onSwitch('delete')}>Delete it instead</button>
          </div>
        )}
        {mode === 'delete' && !check && <div className="small-muted">Checking this client…</div>}
        {mode === 'delete' && check?.error && <div className="error-text">{check.error}</div>}
        {mode === 'delete' && check && !check.error && !check.canDelete && (
          <div className="notice red cllc-blockers">
            <div>
              <b>This client cannot be deleted.</b>
              {' It has: '}
              {check.blockers.map((b) => (b.key === 'agreement' ? b.label : `${b.count} ${b.label}`)).join(', ')}
              {'. Archive it instead.'}
            </div>
          </div>
        )}
        {mode === 'delete' && check && !check.error && check.duplicates?.length > 0 && (
          <div className="notice amber">
            <span>
              {'Looks like a duplicate of '}
              {check.duplicates.map((d, i) => (
                <span key={d.id || d.name}>
                  {i ? ', ' : ''}
                  {d.id ? <Link to={`/clients/${d.id}`}>{d.name}</Link> : d.name}
                </span>
              ))}
              {'? Merge duplicates with the Duplicate clients button.'}
            </span>
          </div>
        )}

        {!blocked && mode === 'changeOwner' && (
          <label className="field">
            <span>Give this client to</span>
            <Combo value={newOwner} onChange={(e) => setNewOwner(e.target.value)}>
              <option value="">{owners ? 'Pick a BDE' : 'Loading…'}</option>
              {(owners || []).map((o) => <option key={o.id} value={o.name}>{o.label || o.name}</option>)}
            </Combo>
          </label>
        )}
        {!blocked && mode === 'mergeNow' && (
          <div className="field">
            <span>The other client (same company)</span>
            <input type="text" value={q} onChange={(e) => { setQ(e.target.value); setOtherId(''); }} placeholder="Type part of the name" autoComplete="off" />
            {found.length > 0 && (
              <div className="cllc-pick">
                {found.map((x) => (
                  <button type="button" key={x.id} className={`btn btn-sm${otherId === x.id ? ' btn-primary' : ''}`} onClick={() => { setOtherId(x.id); setQ(x.name); setFound([]); }}>{x.name}</button>
                ))}
              </div>
            )}
          </div>
        )}
        {!blocked && (
          <>
            <label className="field">
              <span>{copy.reasonLabel}</span>
              <textarea rows="3" autoFocus value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} placeholder="Why? (needed)" />
            </label>
            {!reasonOk && <div className="small-muted" style={{ marginTop: -6 }}>Write a reason (at least 3 letters).</div>}
            {mode === 'delete' && (
              <label className="field">
                <span>
                  {'Type the client name to confirm: '}
                  <b className="cllc-name">{client.name}</b>
                </span>
                <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
              </label>
            )}
            {needsAgree && (
              <div className="notice amber">
                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <input type="checkbox" checked={agreeOk} onChange={(e) => setAgreeOk(e.target.checked)} />
                  <span>
                    <b>Delete the signed agreement too.</b>
                    {' This client has a signed agreement (nothing else). Its text and signed files are kept in the history log.'}
                  </span>
                </label>
              </div>
            )}
          </>
        )}
        {error && <div className="error-text">{error}</div>}
      </div>
    </Modal>
  ), document.body);
}

// ---------------------------------------------------------------------------
// REQUESTS - one small panel on the Clients page (BDE business workspace, 2026-10-10).
//   A BDE sees what they asked (pause, delete, deactivate, change of owner, merge, client approval, close a job)
//   and the answer; a Manager / Admin sees what waits for them and Approves or Rejects (a reason for a reject).
// (Kept under its old name PauseRequestsPanel too.)
// ---------------------------------------------------------------------------
const KIND_WORD = {
  pause: 'Pause', delete: 'Delete', deactivate: 'Deactivate', owner: 'Change owner', merge: 'Same as another client', approval: 'Approval', closejob: 'Close requirement',
};
export function RequestsPanel({ enabled, reloadKey, onChanged, defaultOpen = false }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(defaultOpen);
  const [rejecting, setRejecting] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  function load() {
    if (!enabled) return;
    api.get('/clients/requests').then((r) => setData(r.data)).catch(() => setData(null));
  }
  useEffect(load, [enabled, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (defaultOpen) setOpen(true); }, [defaultOpen]);

  if (!enabled || !data) return null;
  const all = data.requests || [];
  const pending = all.filter((r) => r.status === 'Pending');
  const done = all.filter((r) => r.mine && r.status !== 'Pending').slice(0, 8);
  const toDecide = pending.filter((r) => r.canDecide).length;
  if (!pending.length && !done.length) return null;

  async function decide(r, action) {
    setBusy(r.id);
    setError('');
    const base = r.kind === 'pause' ? '/clients/pause-requests' : '/clients/requests';
    try {
      const res = await api.post(`${base}/${r.id}/${action}`, action === 'reject' ? { reason: rejectReason.trim() } : {});
      setRejecting(null);
      setRejectReason('');
      load();
      onChanged?.(res.data?.message || (action === 'approve' ? 'Approved.' : 'Rejected.'));
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save. Please try again.');
    } finally {
      setBusy('');
    }
  }

  const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const askLine = (r) => {
    if (r.kind === 'owner') return `New owner: ${r.ask?.to || '—'}`;
    if (r.kind === 'merge') return `Same company as: ${r.ask?.to || '—'}`;
    if (r.kind === 'closejob') return `${r.ask?.to || 'Close'}`;
    return null;
  };
  const chipCount = toDecide || pending.filter((r) => r.mine).length;
  if (!open) {
    return (
      <button type="button" className="btn btn-sm clrole-daychip" onClick={() => setOpen(true)} aria-expanded={false}>
        {`Requests${chipCount ? ` (${chipCount})` : ''}`}
      </button>
    );
  }
  return (
    <div className="cllc-panel" id="client-requests">
      <button type="button" className="cllc-panel-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span>
          <b>{toDecide ? 'Requests to decide' : 'My requests'}</b>
          {chipCount ? <span className="cllc-count">{chipCount}</span> : null}
        </span>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="cllc-panel-body">
          {error && <div className="error-text">{error}</div>}
          {[...pending, ...done].map((r) => (
            <div key={r.id} className="cllc-req-row">
              <div className="cllc-req-main">
                <b>{KIND_WORD[r.kind] || r.kindLabel}</b>
                {' · '}
                {r.clientId ? <Link to={`/clients/${r.clientId}`}><b>{r.clientName}</b></Link> : <b>{r.clientName}</b>}
                {r.jobTitle ? <span className="small-muted">{` · ${r.jobTitle}`}</span> : null}
                {r.ownerDepartment ? <span className="small-muted">{` · ${r.ownerDepartment}`}</span> : null}
                {askLine(r) ? <div className="small-muted">{askLine(r)}</div> : null}
                <div className="cllc-req-reason">{`“${r.reason || '—'}”`}</div>
                <div className="small-muted">
                  {`Asked by ${r.requestedBy || '—'} · ${when(r.requestedAt)}`}
                  {r.status !== 'Pending' ? ` · ${r.status} by ${r.decidedBy || '—'}` : ''}
                </div>
              </div>
              <div className="cllc-req-act">
                {r.status !== 'Pending' && <span className={`cllc-chip ${r.status === 'Approved' ? 'approved' : 'rejected'}`}>{r.status}</span>}
                {r.status === 'Pending' && !r.canDecide && <span className="cllc-chip pending">Waiting for approval</span>}
                {r.canDecide && rejecting !== r.id && (
                  <>
                    <button type="button" className="btn btn-sm btn-primary" disabled={busy === r.id} onClick={() => decide(r, 'approve')}>Approve</button>
                    <button type="button" className="btn btn-sm" disabled={busy === r.id} onClick={() => { setRejecting(r.id); setRejectReason(''); }}>Reject</button>
                  </>
                )}
                {r.canDecide && rejecting === r.id && (
                  <div className="cllc-reject">
                    <input type="text" autoFocus placeholder="Why? (needed)" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
                    <button type="button" className="btn btn-sm btn-danger" disabled={busy === r.id || rejectReason.trim().length < 3} onClick={() => decide(r, 'reject')}>Reject</button>
                    <button type="button" className="btn btn-sm" onClick={() => setRejecting(null)}>Cancel</button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
export const PauseRequestsPanel = RequestsPanel;
