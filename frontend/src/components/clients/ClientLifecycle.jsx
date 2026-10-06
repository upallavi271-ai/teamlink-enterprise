import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import api from '../../api';
import Modal from '../Modal.jsx';
import './clientLifecycle.css';

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
        ? 'Client paused. No new people or jobs.'
        : 'Client archived. No new people or jobs. Records are kept.')}
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
          ? 'No new people or jobs. Work in progress stays.'
          : 'No new people or jobs. Every record is kept.'}
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
  ['reactivate', 'Reactivate'],
  ['archive', 'Archive'],
  ['unarchive', 'Restore'],
  ['delete', 'Delete permanently'],
];
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
      'No new jobs or people sent until you reactivate.',
    ],
    reasonLabel: 'Why pause this client?',
  },
  requestPause: {
    title: 'Ask to pause',
    button: 'Send request',
    tone: 'btn-primary',
    explain: [
      'An Admin or the department Manager decides.',
      'Once approved: no new jobs or people sent.',
    ],
    reasonLabel: 'Why pause this client?',
  },
  reactivate: {
    title: 'Reactivate client',
    button: 'Reactivate',
    tone: 'btn-primary',
    explain: ['New jobs and people sent are allowed again.'],
    reasonLabel: 'Why reactivate this client?',
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

  useEffect(() => {
    if (mode !== 'delete') return;
    api.get(`/clients/${client.id}/delete-check`)
      .then((r) => setCheck(r.data))
      .catch((err) => setCheck({ error: err.response?.data?.error || 'Could not check this client. Please try again.' }));
  }, [mode, client.id]);

  if (!copy) return null;
  const blocked = mode === 'delete' && (!check || check.error || !check.canDelete);
  const nameOk = mode !== 'delete' || typed.trim() === String(client.name).trim();
  const reasonOk = reason.trim().length >= 3;
  const needsAgree = mode === 'delete' && !!check?.needsAgreementConfirm;

  async function submit() {
    if (!reasonOk) { setError('Write a reason (at least 3 letters).'); return; }
    if (!nameOk) { setError('Type the client\'s exact name to confirm.'); return; }
    if (needsAgree && !agreeOk) { setError('Tick "Delete the signed agreement too" to confirm.'); return; }
    setBusy(true);
    setError('');
    try {
      const res = mode === 'delete'
        ? await api.delete(`/clients/${client.id}`, { data: { confirmName: typed.trim(), reason: reason.trim(), confirmSignedAgreement: needsAgree ? agreeOk : undefined } })
        : await api.post(`/clients/${client.id}/${PATHS[mode]}`, { reason: reason.trim() });
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
            disabled={busy || blocked || !reasonOk || !nameOk || (needsAgree && !agreeOk)}
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

        {!blocked && (
          <>
            <label className="field">
              <span>{copy.reasonLabel} <b className="cllc-req">*</b></span>
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
// PAUSE REQUESTS — a small panel on the Clients page. Admins and the
// department Manager approve / reject; a BDE sees the requests they sent.
// ---------------------------------------------------------------------------
export function PauseRequestsPanel({ enabled, reloadKey, onChanged }) {
  const [data, setData] = useState(null);
  // Closed by default: one chip "Pause requests (N)" in the daily row.
  const [open, setOpen] = useState(false);
  const [rejecting, setRejecting] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  function load() {
    if (!enabled) return;
    api.get('/clients/pause-requests').then((r) => setData(r.data)).catch(() => setData(null));
  }
  useEffect(load, [enabled, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!enabled || !data) return null;
  const pending = data.requests.filter((r) => r.status === 'Pending');
  const mineDone = data.requests.filter((r) => r.mine && r.status !== 'Pending').slice(0, 5);
  if (!pending.length && !mineDone.length) return null;

  async function decide(r, action) {
    setBusy(r.id);
    setError('');
    try {
      const res = await api.post(`/clients/pause-requests/${r.id}/${action}`, action === 'reject' ? { reason: rejectReason.trim() } : {});
      setRejecting(null);
      setRejectReason('');
      load();
      onChanged?.(res.data?.message || (action === 'approve' ? `${r.clientName} is paused.` : 'Request rejected.'));
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save. Please try again.');
    } finally {
      setBusy('');
    }
  }

  const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  if (!open) {
    return (
      <button type="button" className="btn btn-sm clrole-daychip" onClick={() => setOpen(true)} aria-expanded={false}>
        {`Pause requests${pending.length ? ` (${pending.length})` : ''}`}
      </button>
    );
  }
  return (
    <div className="cllc-panel">
      <button type="button" className="cllc-panel-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span>
          <b>Pause requests</b>
          {pending.length ? <span className="cllc-count">{pending.length}</span> : null}
        </span>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="cllc-panel-body">
          {error && <div className="error-text">{error}</div>}
          {[...pending, ...mineDone].map((r) => (
            <div key={r.id} className="cllc-req-row">
              <div className="cllc-req-main">
                <Link to={`/clients/${r.clientId}`}><b>{r.clientName}</b></Link>
                {r.ownerDepartment ? <span className="small-muted">{` · ${r.ownerDepartment}`}</span> : null}
                <div className="cllc-req-reason">{`“${r.reason || '—'}”`}</div>
                <div className="small-muted">
                  {`Requested by ${r.requestedBy || '—'} · ${when(r.requestedAt)}`}
                  {r.status !== 'Pending' ? ` · ${r.status} by ${r.decidedBy || '—'}${r.decisionNote && r.status === 'Rejected' ? ` — ${r.decisionNote}` : ''}` : ''}
                </div>
              </div>
              <div className="cllc-req-act">
                {r.status !== 'Pending' && <span className={`cllc-chip ${r.status === 'Approved' ? 'approved' : 'rejected'}`}>{r.status}</span>}
                {r.status === 'Pending' && !r.canDecide && <span className="cllc-chip pending">Waiting for approval</span>}
                {r.canDecide && rejecting !== r.id && (
                  <>
                    <button type="button" className="btn btn-sm btn-primary" disabled={busy === r.id} onClick={() => decide(r, 'approve')}>Approve &amp; pause</button>
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
