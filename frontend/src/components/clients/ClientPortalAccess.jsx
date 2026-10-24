import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Modal from '../Modal.jsx';
import PortalTickList from './PortalTickList.jsx';
import StatusChip from '../ui/StatusChip.jsx';
import './portalAccess.css';

// ---------------------------------------------------------------------------
// Client 360 -> "Portal access" (spec B1, 2026-10-03). Who at this client can
// sign in to the client portal, and the one main button: Add user.
//   BDE (client owner)      Add user = a REQUEST; "Ask to switch off".
//   SA / Admin / Manager    Add user = created at once; approve / decline
//   (their departments)     requests; send a new link; change the ticks; switch
//                           off / on; "Still needed" (quarterly check).
// Everything is decided on the server (routes/portalLogins.js); this screen
// only draws what GET /api/portal/logins/client/:id says this login may do.
// No password is ever shown: the client sets their own from a 48-hour link.
// ---------------------------------------------------------------------------
const TONE = { green: 'green', blue: 'blue', orange: 'amber', red: 'red' };
const when = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : null);

function LinkOnce({ link }) {
  if (!link) return null;
  return (
    <div className="tlpa-link">
      <b>The email did not go out.</b> Email this link to the client. It works once, for 48 hours.
      <code>{link}</code>
      <button type="button" className="btn btn-sm" onClick={() => navigator.clipboard && navigator.clipboard.writeText(link)}>Copy link</button>
    </div>
  );
}

export default function ClientPortalAccess({ clientId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null); // { message, link }
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', portalPerms: [], reason: '' });
  const [formError, setFormError] = useState('');
  const [editing, setEditing] = useState(null); // { id, name, perms, reason }
  const [asking, setAsking] = useState(null); // { kind: 'decline'|'off', id, name }
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get(`/portal/logins/client/${clientId}`)
      .then((r) => { setData(r.data); setError(''); })
      .catch((e) => setError(e.response?.data?.error || 'Could not load the portal logins. Please try again.'));
  }, [clientId]);
  useEffect(load, [load]);

  function act(path, body, after) {
    setBusy(true); setError(''); setDone(null);
    return api.post(`/portal/logins${path}`, body || {})
      .then((r) => { setDone({ message: r.data.message || 'Saved.', link: r.data.link }); if (after) after(); load(); })
      .catch((e) => setError(e.response?.data?.error || 'That did not work. Please try again.'))
      .finally(() => setBusy(false));
  }

  if (error && !data) return <div className="notice red"><span>{error}</span></div>;
  if (!data) return <div className="small-muted">Loading…</div>;

  const { agreement, rights, logins, requests, history, types, permList = [], needsView = [] } = data;
  const canAdd = (rights.request || rights.approve) && agreement.active && data.seatsLeft > 0;
  const on = logins.filter((l) => !l.off);
  const off = logins.filter((l) => l.off);

  function openAdd() {
    setForm({ name: on.length ? '' : (data.client.suggestedName || ''), email: on.length ? '' : (data.client.suggestedEmail || ''), portalPerms: [], reason: '' });
    setFormError('');
    setAdding(true); setDone(null); setError('');
  }

  // Older logins (no ticks stored) start from the Reviewer boxes: that is what they could do.
  const reviewerPerms = (types.find((t) => t.value === 'REVIEWER') || {}).perms || [];
  function openEdit(l) {
    setEditing({ id: l.id, name: l.name, perms: l.perms || reviewerPerms, reason: '' });
    setFormError(''); setDone(null); setError('');
  }
  function submitAdd() {
    if (!form.name.trim()) { setFormError('Enter the person\'s name.'); return; }
    if (!form.email.trim()) { setFormError('Enter their work email.'); return; }
    if (!form.portalPerms.length) { setFormError('Tick at least one box, so this person can do something.'); return; }
    setFormError('');
    act(`/client/${clientId}/users`, form, () => setAdding(false));
  }
  function submitEdit() {
    if (!editing.perms.length) { setFormError('Tick at least one box, so this person can do something.'); return; }
    setFormError('');
    act(`/client/${clientId}/users/${editing.id}/perms`, { portalPerms: editing.perms, reason: editing.reason }, () => setEditing(null));
  }

  return (
    <div className="tlpa">
      <div className="tlpa-head">
        <div>
          <h3>Portal logins</h3>
          <div className="small-muted">
            {on.length ? `${on.length} of ${data.max} used` : `No logins yet. Up to ${data.max} people.`}
            {data.waiting ? ` · ${data.waiting} waiting for approval` : ''}
            {' · '}Agreement: <StatusChip status={agreement.words} tone={agreement.active ? 'green' : (agreement.expired ? 'red' : 'amber')} />
          </div>
        </div>
        {canAdd && (
          <button type="button" className="btn btn-primary tlpa-main" onClick={openAdd}>
            {rights.approve ? 'Add user' : 'Ask for a login'}
          </button>
        )}
      </div>

      {!agreement.active && (
        <div className={`notice ${agreement.expired ? 'red' : 'amber'}`}>
          <span>
            {agreement.expired
              ? 'The agreement has ended. Switch logins off until it is renewed.'
              : `Logins open only when the agreement is Active. Now: ${agreement.words}.`}
          </span>
        </div>
      )}
      {agreement.active && !canAdd && (rights.request || rights.approve) && data.seatsLeft === 0 && (
        <div className="notice amber"><span>All {data.max} logins are used. Switch one off to add someone.</span></div>
      )}
      {error && <div className="notice red"><span>{error}</span></div>}
      {done && (
        <div className="notice green"><span>{done.message}</span><LinkOnce link={done.link} /></div>
      )}

      {requests.length > 0 && (
        <div className="tlpa-section">
          <div className="tlpa-label">Waiting for approval</div>
          {requests.map((r) => (
            <div className="tlpa-row" key={r.id}>
              <div className="tlpa-who">
                <b>{r.kind === 'CLIENT_DISABLE' ? `Switch off: ${r.name}` : (r.kind === 'CLIENT_PERMS' ? `Change what ${r.name} can do` : r.name)}</b>
                <span className="small-muted">{r.email}{r.typeWords ? ` · ${r.typeWords}` : ''}</span>
                {r.chips?.length > 0 && <span className="tlpa-chips">{r.chips.map((c) => <StatusChip key={c} status={c} tone="blue" />)}</span>}
                <span className="small-muted">Asked by {r.requestedBy} on {when(r.createdAt)}{r.reason ? ` — "${r.reason}"` : ''}</span>
              </div>
              <div className="tlpa-actions">
                {rights.approve ? (
                  <>
                    <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(`/requests/${r.id}/approve`)}>
                      {r.kind === 'CLIENT_DISABLE' ? 'Switch off' : (r.kind === 'CLIENT_PERMS' ? 'Approve change' : 'Approve')}
                    </button>
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setAsking({ kind: 'decline', id: r.id, name: r.name }); setNote(''); }}>Decline</button>
                  </>
                ) : <StatusChip status="Waiting for Admin" tone="amber" />}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="tlpa-section">
        {on.length === 0 && requests.length === 0 && (
          <div className="tlpa-empty">
            Nobody from {data.client.name} can sign in yet.
            {canAdd ? ` Press ${rights.approve ? 'Add user' : 'Ask for a login'} to give someone a login.` : ''}
          </div>
        )}
        {on.map((l) => (
          <div className="tlpa-row" key={l.id}>
            <div className="tlpa-who">
              <b>{l.name}</b>
              <span className="small-muted">{l.email}</span>
              <span className="small-muted">
                {l.lastLoginAt ? `Last signed in ${when(l.lastLoginAt)}` : `Added ${when(l.createdAt)}`}
              </span>
              <span className="tlpa-chips">
                <StatusChip status={l.typeWords} tone="blue" />
                <StatusChip status={l.state.label} tone={TONE[l.state.tone]} />
                {l.flags.map((f) => <StatusChip key={f.key} status={f.label} tone={TONE[f.tone]} />)}
                {l.pendingDisable && <StatusChip status="Switch-off asked" tone="amber" />}
                {l.pendingPerms && <StatusChip status="Change asked" tone="amber" />}
              </span>
              <span className="tlpa-chips" aria-label="What they can do">
                {l.perms ? l.chips.map((c) => <span className="tlpa-pill" key={c}>{c}</span>) : <span className="tlpa-pill">Full access (older login)</span>}
              </span>
            </div>
            <div className="tlpa-actions">
              {rights.approve && (
                <>
                  {['invited', 'expired'].includes(l.state.key) && (
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => act(`/client/${clientId}/users/${l.id}/resend`)}>Send new link</button>
                  )}
                  {l.flags.some((f) => f.key === 'review') && (
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => act(`/client/${clientId}/users/${l.id}/keep`)}>Still needed</button>
                  )}
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => openEdit(l)}>Change what they can do</button>
                  <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => window.confirm(`Switch off ${l.name}? They will not be able to sign in.`) && act(`/client/${clientId}/users/${l.id}/disable`, {})}>Switch off</button>
                </>
              )}
              {!rights.approve && rights.request && !l.pendingPerms && (
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => openEdit(l)}>Ask to change what they can do</button>
              )}
              {!rights.approve && rights.request && !l.pendingDisable && (
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setAsking({ kind: 'off', id: l.id, name: l.name }); setNote(''); }}>Ask to switch off</button>
              )}
            </div>
          </div>
        ))}
      </div>

      {off.length > 0 && (
        <details className="tlpa-section">
          <summary className="tlpa-label">Switched off ({off.length})</summary>
          {off.map((l) => (
            <div className="tlpa-row" key={l.id}>
              <div className="tlpa-who">
                <b>{l.name}</b>
                <span className="small-muted">{l.email} · {l.typeWords}</span>
              </div>
              <div className="tlpa-actions">
                {rights.approve && agreement.active && data.seatsLeft > 0 && (
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => act(`/client/${clientId}/users/${l.id}/enable`)}>Switch on again</button>
                )}
              </div>
            </div>
          ))}
        </details>
      )}

      {history.length > 0 && (
        <details className="tlpa-section">
          <summary className="tlpa-label">Earlier requests ({history.length})</summary>
          {history.map((r) => (
            <div className="small-muted tlpa-hist" key={r.id}>
              {when(r.decidedAt || r.createdAt)} · {{ CLIENT_DISABLE: 'Switch off', CLIENT_PERMS: 'Change of ticks' }[r.kind] || 'New login'} {r.name} ({r.email}) — {r.status === 'Approved' ? 'approved' : 'declined'}{r.decidedBy ? ` by ${r.decidedBy}` : ''}{r.decisionNote ? `: ${r.decisionNote}` : ''}
            </div>
          ))}
        </details>
      )}

      {rights.approve && (
        <div className="small-muted" style={{ marginTop: 12 }}>
          Check every 3 months: <Link to="/clients/portal-logins">All client logins</Link>.
        </div>
      )}

      {adding && (
        <Modal
          title={rights.approve ? 'Add a client login' : 'Ask for a client login'}
          note={rights.approve ? 'They get an email link to set a password. It works once, for 48 hours.' : 'An Admin approves it. Then they get an invite email.'}
          onClose={() => setAdding(false)}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={submitAdd}
              >
                {busy ? 'Saving…' : (rights.approve ? 'Add and send invite' : 'Send request')}
              </button>
            </>
          )}
        >
          <div className="tlpa-form">
            <label>Person's full name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label>Their own work email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
            <div className="tlpa-label">What can they do?</div>
            <PortalTickList list={permList} presets={types} needsView={needsView} value={form.portalPerms} onChange={(v) => { setForm({ ...form, portalPerms: v }); setFormError(''); }} />
            {!rights.approve && (
              <label>Why (optional)<input value={form.reason} placeholder="e.g. hiring manager for the Java requirements" onChange={(e) => setForm({ ...form, reason: e.target.value })} /></label>
            )}
            {(formError || error) && <div className="notice red" role="alert"><span>{formError || error}</span></div>}
          </div>
        </Modal>
      )}

      {editing && (
        <Modal
          title={`${rights.approve ? 'Change what' : 'Ask to change what'} ${editing.name} can do`}
          note={rights.approve ? 'Saved at once. The change shows the next time they open the portal.' : 'An Admin approves the change.'}
          onClose={() => setEditing(null)}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={submitEdit}>{busy ? 'Saving…' : (rights.approve ? 'Save' : 'Send request')}</button>
            </>
          )}
        >
          <div className="tlpa-form">
            <PortalTickList list={permList} presets={types} needsView={needsView} value={editing.perms} onChange={(v) => { setEditing({ ...editing, perms: v }); setFormError(''); }} />
            {!rights.approve && (
              <label>Why (optional)<input value={editing.reason} placeholder="e.g. now handles the hiring" onChange={(e) => setEditing({ ...editing, reason: e.target.value })} /></label>
            )}
            {(formError || error) && <div className="notice red" role="alert"><span>{formError || error}</span></div>}
          </div>
        </Modal>
      )}

      {asking && (
        <Modal
          title={asking.kind === 'decline' ? `Decline: ${asking.name}` : `Ask to switch off ${asking.name}`}
          onClose={() => setAsking(null)}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setAsking(null)}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !note.trim()}
                onClick={() => (asking.kind === 'decline'
                  ? act(`/requests/${asking.id}/reject`, { note }, () => setAsking(null))
                  : act(`/client/${clientId}/users/${asking.id}/disable`, { reason: note }, () => setAsking(null)))}
              >
                {asking.kind === 'decline' ? 'Decline' : 'Send request'}
              </button>
            </>
          )}
        >
          <div className="tlpa-form">
            <label>{asking.kind === 'decline' ? 'Why? (the BDE will see this)' : 'Why? (e.g. left the company)'}
              <input value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            {error && <div className="notice red"><span>{error}</span></div>}
          </div>
        </Modal>
      )}
    </div>
  );
}
