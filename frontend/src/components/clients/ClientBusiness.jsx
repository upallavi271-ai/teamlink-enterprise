import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Modal from '../Modal.jsx';
import { ClientLifecycleDialog, businessItemsFor } from './ClientLifecycle.jsx';
import './clientBusiness.css';
import Combo from '../Combo.jsx';
import useClientLabel from './useClientLabel.js'; // one company, many locations: "Name - Location" for same-name clients (2026-10-22)
import { ViewAgreementPicker } from '../agreements/SignedAgreementFiles.jsx'; // the one shared "View agreement" (asks which client)

// ---------------------------------------------------------------------------
// BDE BUSINESS WORKSPACE (user spec 2026-10-10)
//
//   BdeWorkspace     the Dashboard box "My Business Workspace": four tiles (My clients, My jobs, Follow-ups due,
//                    Pending approvals) and five plain buttons (Add client, Create requirement, Pause, Add follow-up,
//                    Send for approval). Real counts from GET /clients/my-business. No dropdown menus.
//   FollowUpsPanel   the follow-ups and meetings that are due (Clients page), each with a Done button.
//   ClientBusiness   one client's page: onboarding steps, follow-ups / meetings / client feedback with history,
//                    and the asks a Manager / Admin decides (Send for approval, Change owner, Same as another client).
// Every word is plain on purpose (15-20 year old test). The server decides every button.
// ---------------------------------------------------------------------------
const niceDate = (d) => {
  if (!d) return '';
  const t = new Date(`${String(d).slice(0, 10)}T00:00:00`);
  return Number.isNaN(t.getTime()) ? String(d) : t.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};
const todayStr = () => new Date().toISOString().slice(0, 10);

// ---- add a follow-up / meeting / feedback -------------------------------------------------------------
export function AddItemDialog({ client, clients, defaultKind = 'followup', onClose, onDone }) {
  const clientLabel = useClientLabel();
  const [kind, setKind] = useState(defaultKind);
  const [clientId, setClientId] = useState(client ? client.id : '');
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [dueDate, setDueDate] = useState(todayStr());
  const [dueTime, setDueTime] = useState('');
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dated = kind === 'followup' || kind === 'meeting';
  const words = { followup: 'Follow-up', meeting: 'Meeting', feedback: 'Client feedback', hiring: 'Hiring update' };

  async function save() {
    if (!clientId) { setError('Pick the client.'); return; }
    setBusy(true); setError('');
    try {
      const path = dated ? 'followups' : 'feedback';
      const res = await api.post(`/clients/${clientId}/${path}`, dated
        ? { kind, title: title.trim(), note: note.trim(), dueDate, dueTime: dueTime || undefined, meetingLink: link.trim() || undefined }
        : { kind, note: note.trim() });
      onDone?.(res.data?.message || 'Saved.');
    } catch (err) {
      setError(err.response?.data?.error || 'That did not save. Please try again.');
    } finally { setBusy(false); }
  }
  return (
    <Modal
      title={client ? `${words[kind]} — ${client.name}` : words[kind]}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        </>
      )}
    >
      <div className="cbz-form">
        {!client && (
          <label className="field">
            <span>Client</span>
            <Combo value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">Pick a client</option>
              {(clients || []).map((c) => <option key={c.id} value={c.id}>{clientLabel(c)}</option>)}
            </Combo>
          </label>
        )}
        <div className="cbz-kinds" role="group" aria-label="What is it">
          {Object.entries(words).map(([k, label]) => (
            <button key={k} type="button" className={`btn btn-sm${kind === k ? ' btn-primary' : ''}`} aria-pressed={kind === k} onClick={() => setKind(k)}>{label}</button>
          ))}
        </div>
        {dated ? (
          <>
            <label className="field">
              <span>{kind === 'meeting' ? 'What is the meeting about?' : 'What do you need to do?'}</span>
              <input type="text" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder={kind === 'meeting' ? 'Talk about the new openings' : 'Call the HR about the pending profiles'} />
            </label>
            <div className="cbz-row">
              <label className="field">
                <span>Date</span>
                <input type="date" value={dueDate} min={todayStr()} onChange={(e) => setDueDate(e.target.value)} />
              </label>
              <label className="field">
                <span>Time (optional)</span>
                <input type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
              </label>
            </div>
            {kind === 'meeting' && (
              <label className="field">
                <span>Meeting link (optional)</span>
                <input type="text" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://" />
              </label>
            )}
            <label className="field">
              <span>Note (optional)</span>
              <textarea rows="2" value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            <div className="small-muted">You get a reminder in the bell on that day.</div>
          </>
        ) : (
          <label className="field">
            <span>{kind === 'hiring' ? 'What did the client say about hiring?' : 'What did the client say?'}</span>
            <textarea rows="3" autoFocus value={note} onChange={(e) => setNote(e.target.value)} />
            <span className="small-muted">Saved in the client history with your name and time. It cannot be changed later.</span>
          </label>
        )}
        {error && <div className="error-text">{error}</div>}
      </div>
    </Modal>
  );
}

// ---- pause something (a client or a job) ----------------------------------------------------------------
function PauseDialog({ ws, onClose, onDone }) {
  const [what, setWhat] = useState('client');
  const [id, setId] = useState('');
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const clients = (ws.clients || []).filter((c) => c.lifecycle === 'Active');
  const jobs = (ws.requirements || []).filter((r) => !['ON_HOLD', 'CLOSED', 'DRAFT'].includes(r.status));
  const list = what === 'client' ? clients : jobs;
  async function save() {
    if (!id) { setError(`Pick the ${what}.`); return; }
    if (reason.trim().length < 3) { setError('Write why (at least 3 letters).'); return; }
    if (what === 'job' && !until) { setError('Pick the date to look at this requirement again.'); return; }
    setBusy(true); setError('');
    try {
      const res = what === 'client'
        ? await api.post(`/clients/${id}/pause`, { reason: reason.trim() })
        : await api.post(`/requirements/${id}/pause`, { reason: reason.trim(), until });
      onDone?.(res.data?.message || res.data?.ok || 'Paused.');
    } catch (err) {
      setError(err.response?.data?.error || 'That did not work. Please try again.');
    } finally { setBusy(false); }
  }
  return (
    <Modal
      title="Pause"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Working…' : 'Pause'}</button>
        </>
      )}
    >
      <div className="cbz-form">
        <div className="cbz-kinds" role="group" aria-label="What to pause">
          <button type="button" className={`btn btn-sm${what === 'client' ? ' btn-primary' : ''}`} onClick={() => { setWhat('client'); setId(''); }}>A client</button>
          {/* 2026-10-13: a job is only Open or Closed; to stop a job, close it with the reason "On hold". */}
        </div>
        <ul className="cllc-explain">
          <li>Nothing is deleted. All history stays.</li>
          <li>{what === 'client' ? 'No new requirements or people are sent until you resume.' : 'The requirement is off the job sites until you resume it.'}</li>
        </ul>
        <label className="field">
          <span>{what === 'client' ? 'Which client?' : 'Which requirement?'}</span>
          <Combo value={id} onChange={(e) => setId(e.target.value)}>
            <option value="">{list.length ? 'Pick one' : (what === 'client' ? 'No active client to pause' : 'No open requirement to pause')}</option>
            {list.map((x) => <option key={x.id} value={x.id}>{what === 'client' ? x.name : `${x.code ? `${x.code} · ` : ''}${x.title}${x.clientName ? ` (${x.clientName})` : ''}`}</option>)}
          </Combo>
        </label>
        <label className="field">
          <span>Why?</span>
          <textarea rows="2" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Why? (needed)" />
        </label>
        {what === 'job' && (
          <label className="field">
            <span>Look at this requirement again on</span>
            <input type="date" value={until} min={todayStr()} onChange={(e) => setUntil(e.target.value)} />
          </label>
        )}
        {error && <div className="error-text">{error}</div>}
      </div>
    </Modal>
  );
}

// ---- send a client for approval ----------------------------------------------------------------------------
function SubmitDialog({ ws, onClose, onDone }) {
  const clientLabel = useClientLabel();
  const [id, setId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!id) { setError('Pick the client.'); return; }
    setBusy(true); setError('');
    try {
      const res = await api.post(`/clients/${id}/submit-approval`, { note: note.trim() });
      onDone?.(res.data?.message || 'Sent.');
    } catch (err) {
      setError(err.response?.data?.error || 'That did not work. Please try again.');
    } finally { setBusy(false); }
  }
  return (
    <Modal
      title="Send for approval"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Sending…' : 'Send for approval'}</button>
        </>
      )}
    >
      <div className="cbz-form">
        <ul className="cllc-explain"><li>The Manager of the department or an Admin checks the client.</li><li>You see the answer under Requests.</li></ul>
        <label className="field">
          <span>Which client?</span>
          <Combo value={id} onChange={(e) => setId(e.target.value)}>
            <option value="">Pick a client</option>
            {(ws.clients || []).map((c) => <option key={c.id} value={c.id}>{clientLabel(c)}</option>)}
          </Combo>
        </label>
        <label className="field">
          <span>Anything the approver should know? (optional)</span>
          <textarea rows="2" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {error && <div className="error-text">{error}</div>}
      </div>
    </Modal>
  );
}

// ---- THE DASHBOARD BOX ---------------------------------------------------------------------------------------
export function BdeWorkspace({ w }) {
  const [ws, setWs] = useState(w.ws);
  const [dialog, setDialog] = useState('');
  const [flash, setFlash] = useState('');
  const tiles = w.tiles || [];
  const can = ws.can || {};
  // The dashboard page may come from a short cache: read the numbers fresh once, so a request just sent is counted.
  useEffect(() => { api.get('/clients/my-business').then((r) => setWs(r.data)).catch(() => {}); }, []);
  function reload(msg) {
    setDialog('');
    if (msg) setFlash(String(msg));
    api.get('/clients/my-business').then((r) => setWs(r.data)).catch(() => {});
  }
  const counts = ws.counts || {};
  const live = {
    clients: counts.clients,
    jobs: counts.requirements,
    followups: counts.followUpsDue,
    pending: counts.pending,
  };
  return (
    <section className="panel cbz-ws" aria-label="My Business Workspace">
      <div className="cbz-ws-head"><h3>{w.title}</h3></div>
      <div className="cbz-tiles">
        {tiles.map((t) => {
          const n = live[t.id] ?? t.count;
          const tone = (t.id === 'followups' || t.id === 'pending') ? (n ? 'amber' : 'green') : 'blue';
          return (
            <Link key={t.id} to={t.to} className={`cbz-tile t-${tone}`}>
              <span className="cbz-tile-l">{t.label}</span>
              <span className="cbz-tile-n">{n}</span>
              <span className="cbz-tile-s">{t.id === 'clients' && counts.deskClients != null ? `Assigned to you · Desk clients: ${counts.deskClients}` : t.id === 'followups' && counts.followUpsDue ? `${counts.followUpsClient} client · ${counts.followUpsPeople} candidate` : t.sub}</span>
            </Link>
          );
        })}
      </div>
      <div className="cbz-qa-title">Quick actions</div>
      <div className="cbz-qa">
        {can.addClient && <Link className="btn btn-primary" to="/clients?add=1">+ Add client</Link>}
        {can.createRequirement && <Link className="btn" to="/requirements?new=1">+ Create requirement</Link>}
        {can.pause && <button type="button" className="btn" onClick={() => setDialog('pause')}>Pause</button>}
        {can.followUp && <button type="button" className="btn" onClick={() => setDialog('followup')}>+ Add follow-up</button>}
        {can.submitApproval && <button type="button" className="btn" onClick={() => setDialog('submit')}>Send for approval</button>}
        <ViewAgreementPicker clients={ws.clients || []} />
      </div>
      {flash && <div className="notice cbz-flash" role="status">{flash}</div>}
      {dialog === 'pause' && <PauseDialog ws={ws} onClose={() => setDialog('')} onDone={reload} />}
      {dialog === 'followup' && <AddItemDialog clients={ws.clients} onClose={() => setDialog('')} onDone={reload} />}
      {dialog === 'submit' && <SubmitDialog ws={ws} onClose={() => setDialog('')} onDone={reload} />}
    </section>
  );
}

// ---- follow-ups that are due (Clients page) ---------------------------------------------------------------
export function FollowUpsPanel({ enabled, defaultOpen = false, reloadKey }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(defaultOpen);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  function load() {
    if (!enabled) return;
    api.get('/clients/my-business').then((r) => setData(r.data)).catch(() => setData(null));
  }
  useEffect(load, [enabled, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (defaultOpen) setOpen(true); }, [defaultOpen]);
  if (!enabled || !data) return null;
  const items = data.followUps || [];
  const due = items.filter((x) => x.late || x.dueToday);
  if (!items.length) return null;
  async function done(it) {
    setBusy(it.id); setError('');
    try { await api.post(`/clients/followups/${it.id}/done`, {}); load(); } catch (err) { setError(err.response?.data?.error || 'Could not save. Please try again.'); } finally { setBusy(''); }
  }
  if (!open) {
    return <button type="button" className="btn btn-sm clrole-daychip" onClick={() => setOpen(true)} aria-expanded={false}>{`Follow-ups${due.length ? ` (${due.length} due)` : ` (${items.length})`}`}</button>;
  }
  return (
    <div className="cllc-panel" id="client-followups">
      <button type="button" className="cllc-panel-head" onClick={() => setOpen(false)} aria-expanded>
        <span><b>My follow-ups and meetings</b>{due.length ? <span className="cllc-count">{due.length}</span> : null}</span>
        <span aria-hidden="true">▾</span>
      </button>
      <div className="cllc-panel-body">
        {error && <div className="error-text">{error}</div>}
        {items.map((it) => (
          <div key={it.id} className="cllc-req-row">
            <div className="cllc-req-main">
              <b>{it.kindLabel}</b>
              {' · '}
              <Link to={`/clients/${it.clientId}`}><b>{it.clientName}</b></Link>
              <div className="cllc-req-reason">{it.title}</div>
              <div className={`small-muted${it.late ? ' cbz-late' : ''}`}>
                {it.late ? `Late — was ${niceDate(it.dueDate)}` : (it.dueToday ? 'Today' : niceDate(it.dueDate))}
                {it.dueTime ? ` · ${it.dueTime}` : ''}
              </div>
            </div>
            <div className="cllc-req-act">
              {it.meetingLink ? <a className="btn btn-sm" href={it.meetingLink} target="_blank" rel="noreferrer">Open link</a> : null}
              <button type="button" className="btn btn-sm btn-primary" disabled={busy === it.id} onClick={() => done(it)}>Done</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- ONE CLIENT: onboarding + business activity -------------------------------------------------------------
export default function ClientBusiness({ client, enabled, onChanged }) {
  const [data, setData] = useState(null);
  const [add, setAdd] = useState('');
  const [dlg, setDlg] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [merges, setMerges] = useState([]);
  function loadMerges() {
    if (!enabled || !(client.lifecycleActions || {}).mergeNow) return;
    api.get('/client-merge/history', { params: { primaryId: client.id } }).then((r) => setMerges((r.data?.merges || []).filter((m) => m.undoable))).catch(() => setMerges([]));
  }
  useEffect(loadMerges, [enabled, client.id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function undoMerge(m) {
    setBusy(m.id); setError('');
    try { await api.post('/client-merge/undo', { mergeId: m.id, reason: 'Merged by mistake' }); setFlash('The merge is undone. The other client is back.'); loadMerges(); load(); onChanged?.(); } catch (err) { setError(err.response?.data?.error || 'Could not undo.'); } finally { setBusy(''); }
  }
  function load() {
    if (!enabled) return;
    api.get(`/clients/${client.id}/business`).then((r) => setData(r.data)).catch(() => setData(null));
  }
  useEffect(load, [enabled, client.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!enabled || !data) return null;
  const steps = data.onboarding?.steps || [];
  const extra = businessItemsFor(client);
  const may = client.lifecycleActions || {};
  const ownMayAdd = data.rights?.followUp && !client.colleagueView;
  async function done(it) {
    setBusy(it.id); setError('');
    try { await api.post(`/clients/followups/${it.id}/done`, {}); load(); } catch (err) { setError(err.response?.data?.error || 'Could not save.'); } finally { setBusy(''); }
  }
  const after = (msg) => { setAdd(''); setDlg(''); setFlash(String(msg || 'Saved.')); load(); onChanged?.(msg); };
  return (
    <section className="panel cbz-card" aria-label="Business">
      <div className="cbz-card-head">
        <h3>Business</h3>
        <span className="small-muted">{`Onboarding ${data.onboarding?.percent ?? 0}% done`}</span>
      </div>
      <ol className="cbz-steps">
        {steps.map((s) => (
          <li key={s.key} className={`cbz-step s-${s.state}`} title={s.note || ''}>
            <span className="cbz-dot" aria-hidden="true">{s.state === 'done' ? '✓' : s.state === 'rejected' ? '✕' : ''}</span>
            <span>{s.label}</span>
            {s.note && s.state !== 'done' ? <span className="small-muted cbz-step-note">{s.note}</span> : null}
          </li>
        ))}
      </ol>
      <div className="cbz-actions">
        {ownMayAdd && <button type="button" className="btn btn-sm" onClick={() => setAdd('followup')}>+ Follow-up</button>}
        {ownMayAdd && <button type="button" className="btn btn-sm" onClick={() => setAdd('meeting')}>+ Meeting</button>}
        {ownMayAdd && <button type="button" className="btn btn-sm" onClick={() => setAdd('feedback')}>+ Client feedback</button>}
        {extra.map(([k, label]) => <button key={k} type="button" className="btn btn-sm" onClick={() => setDlg(k)}>{label}</button>)}
      </div>
      {flash && <div className="notice cbz-flash" role="status">{flash}</div>}
      {error && <div className="error-text">{error}</div>}
      {(data.open || []).length > 0 && (
        <div className="cbz-list">
          <div className="cbz-list-t">Coming up</div>
          {data.open.map((it) => (
            <div key={it.id} className="cbz-item">
              <div>
                <b>{it.kindLabel}</b>{` · ${it.title || ''}`}
                <div className={`small-muted${it.late ? ' cbz-late' : ''}`}>{it.late ? `Late — was ${niceDate(it.dueDate)}` : (it.dueToday ? 'Today' : niceDate(it.dueDate))}{it.dueTime ? ` · ${it.dueTime}` : ''}{it.createdBy ? ` · set by ${it.createdBy}` : ''}</div>
              </div>
              <div className="cbz-item-act">
                {it.meetingLink ? <a className="btn btn-sm" href={it.meetingLink} target="_blank" rel="noreferrer">Open link</a> : null}
                {ownMayAdd && <button type="button" className="btn btn-sm btn-primary" disabled={busy === it.id} onClick={() => done(it)}>Done</button>}
              </div>
            </div>
          ))}
        </div>
      )}
      {(data.history || []).length > 0 && (
        <div className="cbz-list">
          <div className="cbz-list-t">History</div>
          {data.history.slice(0, 8).map((it) => (
            <div key={it.id} className="cbz-item">
              <div>
                <b>{it.kindLabel}</b>{it.title ? ` · ${it.title}` : ''}
                {it.note ? <div className="cbz-note">{it.note}</div> : null}
                <div className="small-muted">{`${niceDate(it.createdAt)} · ${it.createdBy || ''}${it.status === 'Done' && it.doneNote ? ` · done: ${it.doneNote}` : (it.status === 'Done' ? ' · done' : '')}`}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {(data.requests || []).length > 0 && (
        <div className="cbz-list">
          <div className="cbz-list-t">Requests on this client</div>
          {data.requests.map((r) => (
            <div key={r.id} className="cbz-item">
              <div><b>{r.kindLabel}</b>{` · ${r.status}${r.decidedBy ? ` by ${r.decidedBy}` : ''}`}<div className="small-muted">{`“${r.reason || ''}” · ${r.requestedBy || ''}`}</div></div>
            </div>
          ))}
        </div>
      )}
      {merges.length > 0 && (
        <div className="cbz-list">
          <div className="cbz-list-t">Merged clients (you can undo for 7 days)</div>
          {merges.map((m) => (
            <div key={m.id} className="cbz-item">
              <div><b>{(m.donorNames || []).join(', ')}</b><div className="small-muted">{`Joined into this client by ${m.mergedByName || '—'}, ${niceDate(m.createdAt)}`}</div></div>
              <div className="cbz-item-act"><button type="button" className="btn btn-sm" disabled={busy === m.id} onClick={() => undoMerge(m)}>Undo merge</button></div>
            </div>
          ))}
        </div>
      )}
      {add && <AddItemDialog client={client} defaultKind={add} onClose={() => setAdd('')} onDone={after} />}
      {dlg && <ClientLifecycleDialog key={dlg} client={client} mode={dlg} onClose={() => setDlg('')} onDone={after} />}
      {!may && null}
    </section>
  );
}
