// Interviews & Joining -> Offers (change list §12 + the simplicity checklist,
// 2026-10-03).
//
//   Selected → Prepare offer (CTC, joining date) → TL approves & sends the
//   letter (from the template) → the candidate accepts / declines on their
//   TeamLink page (or tells the recruiter, who records it here) → Joining.
//
// Both kinds of hire use it: a client placement's offer is the client's
// (recorded with the CTC the fee is worked out on); an internal hire's is
// TeamLink's own. Nothing here raises an invoice or creates an employee —
// that happens at Joining.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import CandidateDrawer from '../../components/CandidateDrawer.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { can } from '../../permissions';
import AtsDataTools from '../../components/AtsDataTools.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import ListPageHeader, { StatusTabs } from '../../components/ui/ListPageHeader.jsx';
import StatusChip from '../../components/ui/StatusChip.jsx';
import { Modal } from '../../components/proto.jsx';
import '../../components/interviews/Interviews.css';
import './offersB3.css';
import {
  fmtDate, money, useWorkspace, Banner, IntJoinEmpty, EMPTY_INTJOIN_FILTERS, useIntJoinList,
} from './intjoinShared.jsx';

const PREPARED = 'Offer being prepared';
// The step, in plain words and the four colours.
function stepOf(r) {
  if (r.offerStatus === PREPARED) return { id: 'approval', text: 'Waiting for approval', tone: 'amber' };
  if (r.offerStatus === 'Offer Released') return { id: 'candidate', text: 'Waiting for candidate', tone: 'blue' };
  if (r.offerStatus === 'Offer Accepted' || ['OFFER_ACCEPTED', 'JOINED', 'HIRED'].includes(r.stage)) return { id: 'accepted', text: 'Accepted', tone: 'green' };
  if (r.offerStatus === 'Offer Declined') return { id: 'prepare', text: 'Declined — offer again?', tone: 'red' };
  // B3: not answered in time.
  if (r.offerStatus === 'Offer Expired') return { id: 'prepare', text: 'Expired — offer again?', tone: 'red' };
  return { id: 'prepare', text: 'To prepare', tone: 'amber' };
}
const VIEWS = [
  ['prepare', 'To prepare'], ['approval', 'Waiting for approval'], ['candidate', 'Waiting for candidate'], ['accepted', 'Accepted'], ['all', 'All'],
];
const first = (n) => String(n || '').replace(/^ZZTEST\S*\s*/i, '').split(/\s+/)[0] || 'The candidate';

export default function Offers() {
  const { user } = useAuth();
  const { data, error, notice, act, load } = useWorkspace('/ats/offers');
  const [dialog, setDialog] = useState(null);
  const [openCand, setOpenCand] = useState(null); // the candidate window, opened right here
  const canEdit = can(user, 'ats', 'interviews', 'Offers', 'edit');
  const canApprove = can(user, 'ats', 'interviews', 'Offers', 'approve');
  const isAdmin = ['SUPER_ADMIN', 'ADMIN'].includes(user && user.role);
  const [view, setView] = useState(() => (canApprove && !canEdit ? 'approval' : 'prepare'));
  const list = useIntJoinList(data.rows, { dateOf: (r) => r.offerDate });
  const counts = useMemo(() => {
    const c = { all: list.rows.length };
    list.rows.forEach((r) => { const id = stepOf(r).id; c[id] = (c[id] || 0) + 1; });
    return c;
  }, [list.rows]);
  // First load: open the first step that has someone in it.
  const [picked, setPicked] = useState(false);
  useEffect(() => {
    if (picked || data.loading || !(data.rows || []).length) return;
    setPicked(true);
    if (!counts[view]) {
      const firstFull = VIEWS.find(([k]) => k !== 'all' && counts[k]);
      if (firstFull) setView(firstFull[0]);
    }
  }, [data.loading, data.rows, counts]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => list.rows.filter((r) => view === 'all' || stepOf(r).id === view), [list.rows, view]);
  const page = usePaged(rows);
  const close = () => setDialog(null);
  const run = (fn, msg) => act(fn, msg).then((ok) => { if (ok) close(); return ok; });
  // B3: offer expiry days + the candidate-emails switch, shown on the admin line.
  const offerSettings = data.offerSettings || null;
  const emailsOn = data.candidateEmailsOn === true;

  return (
    <div>
      <ListPageHeader
        title="Offers"
        question="People the client selected: make the offer, then note their yes or no."
        data={(
          <>
            <AtsDataTools
              module="offers"
              kinds={['offers']}
              onImported={load}
              body={() => ({ ids: rows.length === (data.rows || []).length ? null : rows.map((r) => r.id) })}
            />
          </>
        )}
      />

      {/* The Interviews · Feedback · Offers · Joining tabs are drawn above the page by
          Shell.jsx (components/InterviewTabs.jsx) — tabs of Interview Calendar. */}

      <Banner error={error} notice={notice} />

      <StatusTabs
        label="Offer step"
        tabs={VIEWS.map(([key, label]) => ({ key, label, count: counts[key] || 0 }))}
        value={view}
        onChange={setView}
        hideZero
      />
      {list.toolbar}

      <div className="tbl-wrap">
        <table>
          <thead>
            <tr><th>Candidate</th><th>Job</th><th>Yearly CTC</th><th>Joining date</th><th>Step</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {page.slice.map((r) => {
              const step = stepOf(r);
              const internal = r.hiringType === 'TeamLink Internal Hire';
              return (
                <tr key={r.id}>
                  <td className="row-link"><a href={`/candidates/${r.candidate.id}`} onClick={(e) => { e.preventDefault(); setOpenCand(r); }}>{r.candidate.name}</a></td>
                  <td>
                    <div>{r.requirement.title}</div>
                    <div className="small-muted" style={{ fontSize: 12 }}>{internal ? 'TeamLink (internal)' : r.requirement.client?.name || ''}</div>
                  </td>
                  <td>{r.offeredCtc ? money(r.offeredCtc) : <span className="small-muted">—</span>}</td>
                  <td className="small-muted">{r.joiningDate ? fmtDate(r.joiningDate) : '—'}</td>
                  <td>
                    <StatusChip status={step.text} tone={step.tone} />
                    {r.offerVersion && (
                      <div className="small-muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                        {`Letter v${r.offerVersion.version}`}
                        {step.id === 'candidate' && r.offerVersion.expiresAt ? ` · answer by ${fmtDate(r.offerVersion.expiresAt)}` : ''}
                        {step.id === 'candidate' && r.offerVersion.viewedAt ? ' · opened' : ''}
                        {r.offerVersion.signedAt && r.offerVersion.hasPdf ? ' · signed' : ''}
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="ivx-actions">
                      {step.id === 'prepare' && canEdit && (
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => setDialog({ kind: 'prepare', row: r })}>{['Offer Declined', 'Offer Expired'].includes(r.offerStatus) ? 'Offer again' : 'Prepare offer'}</button>
                      )}
                      {step.id === 'approval' && canApprove && (
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => setDialog({ kind: 'letter', row: r, approve: true })}>Check &amp; send</button>
                      )}
                      {step.id === 'approval' && !canApprove && <span className="small-muted">The team lead approves it.</span>}
                      {step.id === 'approval' && canEdit && (
                        <button type="button" className="btn btn-sm" onClick={() => setDialog({ kind: 'prepare', row: r })}>Change</button>
                      )}
                      {step.id === 'candidate' && (
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => setDialog({ kind: 'link', row: r })}>Send offer link</button>
                      )}
                      {step.id === 'candidate' && canEdit && (
                        <>
                          <button type="button" className="btn btn-sm" onClick={() => act(() => api.post(`/ats/offers/${r.id}/accept`), `Saved. ${first(r.candidate.name)} said yes. Next: joining.`)}>Candidate said yes</button>
                          <button type="button" className="btn btn-sm" onClick={() => setDialog({ kind: 'decline', row: r })}>Said no</button>
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDialog({ kind: 'prepare', row: r, change: true })}>Change offer</button>
                        </>
                      )}
                      {(['candidate', 'accepted'].includes(step.id) || r.offerVersion) && (
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDialog({ kind: 'letter', row: r })}>{r.offerVersion && r.offerVersion.version > 1 ? 'Letter & versions' : 'Letter'}</button>
                      )}
                      {step.id === 'accepted' && <Link className="btn btn-sm" to="/ats/joining">Joining →</Link>}
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan="6" style={{ padding: 0 }}>
                <IntJoinEmpty
                  loading={data.loading}
                  filters={list.active ? { q: 'x' } : EMPTY_INTJOIN_FILTERS}
                  onClear={list.clear}
                  noun="offers"
                  title={{ prepare: 'Nobody is waiting for an offer.', approval: 'No offers waiting for approval.', candidate: 'No offers waiting for an answer.', accepted: 'No accepted offers yet.' }[view] || 'No offers yet.'}
                />
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager page={page} noun="offers" />
      {isAdmin && (
        <div className="ivx-admin">
          <span>Every offer letter is made from one template.</span>
          <button type="button" className="btn btn-sm" onClick={() => setDialog({ kind: 'template' })}>Edit letter template</button>
        </div>
      )}
      {offerSettings && (
        <div className="ivx-admin">
          <span>
            {`Offers stay open for ${offerSettings.expiryDays} day${offerSettings.expiryDays === 1 ? '' : 's'}, then expire. `}
            {emailsOn ? 'Candidate emails: On.' : 'Candidate emails: Off — the app does not email candidates. Share the offer link by Copy or WhatsApp.'}
          </span>
          {isAdmin && <button type="button" className="btn btn-sm" onClick={() => setDialog({ kind: 'expiry' })}>Change days</button>}
        </div>
      )}

      {dialog?.kind === 'prepare' && (
        <PrepareForm
          change={!!dialog.change}
          row={dialog.row}
          onClose={close}
          onSubmit={(body) => run(() => api.post(`/ats/offers/${dialog.row.id}/prepare`, body), `Saved. Offer for ${first(dialog.row.candidate.name)} waits for approval.`)}
        />
      )}
      {dialog?.kind === 'letter' && (
        <LetterModal
          row={dialog.row}
          approve={dialog.approve && canApprove}
          onClose={close}
          onApprove={() => act(() => api.post(`/ats/offers/${dialog.row.id}/approve`, {})).then((ok) => { if (ok) setDialog({ kind: 'link', row: dialog.row, fresh: true }); return ok; })}
          onSendBack={() => setDialog({ kind: 'sendback', row: dialog.row })}
        />
      )}
      {dialog?.kind === 'sendback' && (
        <ReasonModal
          title={`Send back — ${dialog.row.candidate.name}`}
          label="What should change? *"
          placeholder="e.g. CTC is above the budget — check with the client"
          button="Send back"
          onClose={close}
          onSubmit={(reason) => run(() => api.post(`/ats/offers/${dialog.row.id}/send-back`, { reason }), 'Sent back to the recruiter with your note.')}
        />
      )}
      {dialog?.kind === 'decline' && (
        <ReasonModal
          title={`Offer declined — ${dialog.row.candidate.name}`}
          label="Why did they say no? *"
          placeholder="e.g. Got a better offer elsewhere"
          button="Save"
          onClose={close}
          onSubmit={(reason) => run(() => api.post(`/ats/offers/${dialog.row.id}/decline`, { reason }), 'Saved. The candidate is not rejected — you can offer again.')}
        />
      )}
      {dialog?.kind === 'template' && <TemplateModal onClose={close} onSaved={(msg) => { close(); act(async () => {}, msg); }} />}
      {dialog?.kind === 'link' && <OfferLinkModal row={dialog.row} fresh={!!dialog.fresh} canEdit={canEdit} onClose={() => { close(); load(); }} />}
      {dialog?.kind === 'expiry' && (
        <ExpiryModal
          days={offerSettings ? offerSettings.expiryDays : 7}
          onClose={close}
          onSave={(expiryDays) => run(() => api.put('/ats/offers/settings', { expiryDays }), `Saved. New offers stay open for ${expiryDays} days.`)}
        />
      )}
      {openCand && (
        <CandidateDrawer
          candidateId={openCand.candidate.id}
          applicationId={openCand.id}
          user={user}
          onClose={() => setOpenCand(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}

function PrepareForm({ row, onClose, onSubmit, change = false }) {
  const internal = row.hiringType === 'TeamLink Internal Hire';
  const [ctc, setCtc] = useState(row.offeredCtc || '');
  const [offerDate, setOfferDate] = useState(row.offerDate || new Date().toISOString().slice(0, 10));
  const [joiningDate, setJoiningDate] = useState(row.joiningDate || '');
  const [notes, setNotes] = useState(row.offerNotes && row.offerStatus === PREPARED ? row.offerNotes : '');
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); try { await onSubmit({ offeredCtc: ctc, offerDate, joiningDate, offerNotes: notes }); } finally { setBusy(false); } };
  return (
    <Modal
      title={`${change ? 'Change offer' : 'Prepare offer'} — ${row.candidate.name}`}
      onClose={onClose}
      footer={<button type="button" className="btn btn-primary" disabled={busy || !(Number(ctc) > 0)} onClick={save}>{busy ? 'Saving…' : 'Send for approval'}</button>}
    >
      <div className="ivx-fb">
        <div className="ivx-hint" style={{ marginTop: 0, marginBottom: 12 }}>{`${row.requirement.title} · ${internal ? 'TeamLink (internal)' : row.requirement.client?.name || ''}`}</div>
        <div className="ivx-sec">
          <b>Yearly CTC (₹) *</b>
          <input type="number" min="1" inputMode="numeric" placeholder="e.g. 450000" value={ctc} onChange={(e) => setCtc(e.target.value)} style={{ width: '100%' }} />
          {Number(ctc) > 0 && <div className="ivx-hint">{money(ctc)} a year</div>}
        </div>
        <div className="ivx-two ivx-sec">
          <label><b>Offer date</b><input type="date" value={offerDate} onChange={(e) => setOfferDate(e.target.value)} /></label>
          <label><b>Joining date</b><input type="date" value={joiningDate} onChange={(e) => setJoiningDate(e.target.value)} /></label>
        </div>
        <div className="ivx-sec">
          <b>Note in the letter</b>
          <textarea rows="2" maxLength={2000} placeholder="Optional, e.g. Night shifts on rotation" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <div className="ivx-hint">{change ? 'The letter the candidate has now stops working. The team lead checks the new one; it is sent as the next version (the old one stays in history).' : 'The team lead checks it, then the letter goes to the candidate.'}</div>
      </div>
    </Modal>
  );
}

function LetterModal({ row, approve, onClose, onApprove, onSendBack }) {
  const [letter, setLetter] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get(`/ats/offers/${row.id}/letter`).then((r) => setLetter(r.data)).catch((e) => setErr(e.response?.data?.error || 'Could not load the letter. Please try again.'));
  }, [row.id]);
  const send = async () => { setBusy(true); try { await onApprove(); } finally { setBusy(false); } };
  return (
    <Modal
      title={approve ? `Check & send — ${row.candidate.name}` : `Offer letter — ${row.candidate.name}`}
      onClose={onClose}
      wide
      footer={approve ? (
        <>
          <button type="button" className="btn btn-ghost" onClick={onSendBack}>Send back</button>
          <button type="button" className="btn btn-primary" disabled={busy || !letter} onClick={send}>{busy ? 'Sending…' : 'Approve & send'}</button>
        </>
      ) : null}
    >
      {err && <div className="error-text">{err}</div>}
      {!letter && !err && <div className="small-muted">Loading…</div>}
      {letter && (
        <>
          <pre className="ivx-letter">{letter.text}</pre>
          <div className="ivx-hint">
            {letter.sent
              ? `Sent ${fmtDate(letter.sentAt)}${letter.recipient ? ` to ${letter.recipient}` : ''}.`
              : 'This is how the letter will read. The candidate answers on the offer link (or their TeamLink page).'}
          </div>
          {!approve && <OfferVersions row={row} />}
        </>
      )}
    </Modal>
  );
}

function ReasonModal({ title, label, placeholder, button, onClose, onSubmit }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={<button type="button" className="btn btn-primary" disabled={busy || !reason.trim()} onClick={async () => { setBusy(true); try { await onSubmit(reason.trim()); } finally { setBusy(false); } }}>{button}</button>}
    >
      <div className="ivx-fb">
        <div className="ivx-sec">
          <b>{label}</b>
          <textarea rows="3" maxLength={1000} placeholder={placeholder} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}

// Admin: the one offer letter template ({{name}}, {{job}}, {{ctc}} …).
function TemplateModal({ onClose, onSaved }) {
  const [t, setT] = useState(null);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get('/ats/offers/letter-template').then((r) => { setT(r.data); setText(r.data.text); }).catch(() => setErr('Could not load the template. Please try again.'));
  }, []);
  async function save() {
    setBusy(true); setErr('');
    try {
      const r = await api.put('/ats/offers/letter-template', { text });
      onSaved(r.data.message || 'Saved.');
    } catch (e) { setErr(e.response?.data?.error || 'Could not save the template. Please try again.'); } finally { setBusy(false); }
  }
  return (
    <Modal
      title="Offer letter template"
      onClose={onClose}
      wide
      footer={<button type="button" className="btn btn-primary" disabled={busy || !t} onClick={save}>{busy ? 'Saving…' : 'Save template'}</button>}
    >
      {err && <div className="error-text">{err}</div>}
      {t && (
        <div className="ivx-fb">
          <textarea rows="14" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="ivx-hint">
            {'Words in {{ }} are filled in for each person: '}
            {(t.tokens || []).map((k) => `{{${k}}}`).join(' ')}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// B3 (2026-10-06): the candidate's offer link — Copy / WhatsApp / Email — and
// the letter's versions. Email follows the "Candidate emails" switch (OFF).
// ---------------------------------------------------------------------------
const VERSION_TONE = { Sent: 'blue', Accepted: 'green', Declined: 'red', Expired: 'red', Replaced: 'grey' };
const VERSION_WORD = { Sent: 'Waiting for answer', Accepted: 'Accepted & signed', Declined: 'Declined', Expired: 'Expired', Replaced: 'Replaced by a newer version' };

async function downloadVersionPdf(rowId, v) {
  const r = await api.get(`/ats/offers/${rowId}/versions/${v.id}/pdf`, { responseType: 'blob' });
  const url = URL.createObjectURL(r.data);
  const a = document.createElement('a');
  a.href = url; a.download = `offer-v${v.version}.pdf`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function OfferVersions({ row }) {
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.get(`/ats/offers/${row.id}/versions`).then((r) => setList(r.data.versions || [])).catch(() => setErr('Could not load the versions.'));
  }, [row.id]);
  if (err) return <div className="error-text">{err}</div>;
  if (!list) return null;
  if (!list.length) return <div className="ivx-hint">This offer was sent before letter versions were kept.</div>;
  return (
    <div className="ofv-list">
      <b>Versions</b>
      {list.map((v) => (
        <div key={v.id} className="ofv-row">
          <span className="ofv-v">{`v${v.version}`}</span>
          <span className="ofv-main">
            <StatusChip status={VERSION_WORD[v.status] || v.status} tone={VERSION_TONE[v.status] || 'grey'} />
            <span className="small-muted">
              {[`Sent ${fmtDate(v.sentAt)}${v.sentBy ? ` by ${v.sentBy}` : ''}`, v.offeredCtc ? money(v.offeredCtc) : null,
                v.status === 'Sent' && v.expiresAt ? `answer by ${fmtDate(v.expiresAt)}` : null,
                v.signedAt ? `signed ${fmtDate(v.signedAt)}${v.signedName ? ` by ${v.signedName}` : ''}${v.signedIp ? ` (IP ${v.signedIp})` : ''}` : null,
                v.declineReason ? `reason: ${v.declineReason}` : null].filter(Boolean).join(' · ')}
            </span>
          </span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => downloadVersionPdf(row.id, v).catch(() => setErr('Could not download the PDF.'))}>{v.hasPdf ? 'Signed PDF' : 'PDF'}</button>
        </div>
      ))}
    </div>
  );
}

function OfferLinkModal({ row, fresh, canEdit, onClose }) {
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState(fresh ? 'Offer sent. Now share the link with the candidate.' : '');
  const [busy, setBusy] = useState('');
  useEffect(() => {
    api.get(`/ats/offers/${row.id}/link`).then((r) => setInfo(r.data)).catch((e) => setErr(e.response?.data?.error || 'Could not load the link.'));
  }, [row.id]);
  async function call(key, fn) {
    setBusy(key); setErr('');
    try { const r = await fn(); if (r.data.version) setInfo(r.data); setMsg(r.data.message || ''); } catch (e) { setErr(e.response?.data?.error || 'That did not work. Please try again.'); } finally { setBusy(''); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(info.url); setMsg('Link copied. Paste it in a message to the candidate.'); } catch { setMsg('Select the link above and copy it.'); }
  }
  const v = info && info.version;
  return (
    <Modal title={`Offer link — ${row.candidate.name}`} onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>Done</button>}>
      <div className="ivx-fb ofl">
        {err && <div className="error-text">{err}</div>}
        {msg && !err && <div className="ofl-ok" role="status">{msg}</div>}
        {!info && !err && <div className="small-muted">Loading…</div>}
        {info && (
          <>
            <div className="ivx-hint" style={{ marginTop: 0 }}>
              {`Letter v${v.version} · ${VERSION_WORD[v.status] || v.status}${v.expiresAt ? ` · answer by ${fmtDate(v.expiresAt)}` : ''}${v.viewedAt ? ' · the candidate opened it' : ''}`}
            </div>
            {info.live ? (
              <>
                <input className="ofl-url" readOnly value={info.url} onFocus={(e) => e.target.select()} aria-label="Offer link" />
                <div className="ofl-btns">
                  <button type="button" className="btn btn-primary" onClick={copy}>Copy link</button>
                  <a className="btn" href={info.whatsappUrl} target="_blank" rel="noreferrer">Send on WhatsApp</a>
                  {canEdit && (
                    <button type="button" className="btn" disabled={!info.candidateEmailsOn || busy === 'email' || !info.emailTo} title={info.candidateEmailsOn ? '' : 'Candidate emails are switched off'} onClick={() => call('email', () => api.post(`/ats/offers/${row.id}/link/email`))}>
                      {busy === 'email' ? 'Sending…' : 'Email it'}
                    </button>
                  )}
                </div>
                <div className={`ofl-note${info.candidateEmailsOn ? '' : ' is-off'}`}>
                  {info.candidateEmailsOn
                    ? `Email goes to ${info.emailTo || '— (no email on the candidate)'}.`
                    : 'Candidate emails are OFF (Admin switch): the app does not email the candidate. Copy the link or send it on WhatsApp from your phone.'}
                </div>
                <div className="ivx-hint">The candidate opens it on their phone, reads the letter and presses Accept (they sign and confirm with a code from their email) or Decline.</div>
                {canEdit && (
                  <button type="button" className="btn btn-sm btn-ghost" disabled={busy === 'new'} onClick={() => call('new', () => api.post(`/ats/offers/${row.id}/link`))}>
                    {busy === 'new' ? 'Making…' : 'Make a new link (the old one stops)'}
                  </button>
                )}
              </>
            ) : (
              <div className="ofl-note is-off">{v.status === 'Expired' ? 'This offer has expired. Use "Offer again" to send a new version.' : 'There is no open link for this offer.'}</div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function ExpiryModal({ days, onClose, onSave }) {
  const [n, setN] = useState(String(days));
  const [busy, setBusy] = useState(false);
  const ok = Number.isInteger(Number(n)) && Number(n) >= 1 && Number(n) <= 60;
  return (
    <Modal title="How long an offer stays open" onClose={onClose} footer={<button type="button" className="btn btn-primary" disabled={!ok || busy} onClick={async () => { setBusy(true); try { await onSave(Number(n)); } finally { setBusy(false); } }}>Save</button>}>
      <div className="ivx-fb">
        <div className="ivx-sec">
          <b>Days *</b>
          <input type="number" min="1" max="60" inputMode="numeric" value={n} onChange={(e) => setN(e.target.value)} style={{ width: 120 }} />
          <div className="ivx-hint">After this many days an offer nobody answered becomes Expired: it can no longer be accepted, and the recruiter and team lead get a notice. Offers already sent keep their date.</div>
        </div>
      </div>
    </Modal>
  );
}
