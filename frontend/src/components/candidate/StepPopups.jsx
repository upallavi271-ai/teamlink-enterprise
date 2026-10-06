// ---------------------------------------------------------------------------
// STEP POPUPS (ATS layout v3, 2026-10-03) — the same small windows wherever a
// step is taken: a drag on the Progress board, the profile's next-step
// button, or the list's "Next step" button.
//
//   verify   Verified → TL check      a checklist (skills, experience, CTC,
//                                     notice period, interest, documents) →
//                                     "Send to team lead". The answers ride on
//                                     the stage event's comment.
//   tl       TL check                 Approve (→ BDE Review) / Send back (reason)
//   bde      BDE Review               Approve (→ Shared with Client) / Send back
//   client   Shared with Client       Shortlisted / Rejected / On hold
//   reject   any step                 Rejected by + reason + note (all needed),
//                                     then "other matching jobs" (same
//                                     department — StillFits / resumeMatch)
//   joined   Selected / Offer → Joined  joining date, final CTC, commission %
//                                     → Save raises the Accounts invoice
//                                     through the one joining path
//                                     (utils/joining.js onApplicationJoined)
//
// Every move goes through the server's own rules (POST /candidates/board/move
// → applyStageMove: one phase at a time, role ownership, scope). A refusal is
// shown in plain words. onDone({ text, undo }) reports what happened; undo =
// { id, stage, name } lets the caller offer Undo.
//
// <StepPopup kind app user onClose onDone onNeedInterview />
//   app: { id (application id), candidateId, name, stage, internal, facts? }
//   facts (optional): { skills, experienceYears, currentSalary, expectedSalary, noticePeriod }
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import Combo from '../Combo.jsx';
import { HOLD_REASON_CATEGORIES } from '../../atsVocab';
import {
  RejectFields, rejectReady, rejectPayload, EMPTY_REJECT,
} from '../rejections/rejectionUi.jsx';
import StillFits, { forgetStillFits } from '../rejections/StillFits.jsx';
import './StepPopups.css';

const SOURCED = ['NEW', 'AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED'];
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const inDays = (n) => new Date(Date.now() + 330 * 60000 + n * 86400000).toISOString().slice(0, 10);
const rupees = (n) => (Number(n) > 0 ? `₹${Number(n).toLocaleString('en-IN')} a year` : '');
const errText = (err, fallback) => (err && err.response && err.response.data && err.response.data.error) || fallback;

// Which popup a drag from one board column to another opens (null = move straight away).
export function popupForDrop(fromKey, toKey, card) {
  if (toKey === 'rejected') return 'reject';
  if (toKey === 'joined') return 'joined';
  if (toKey === 'interview') return 'interview';
  if (toKey === 'tl' && ['sourced', 'verified'].includes(fromKey)) return 'verify';
  if (toKey === 'bde' && fromKey === 'tl' && !(card && card.internal)) return 'tl';
  if (toKey === 'shared' && fromKey === 'bde') return 'bde';
  return null;
}

// The one move every popup makes: the board's move (plain-word refusals),
// with the same-client warning asked once.
async function boardMove(applicationId, column, extra = {}) {
  try {
    return (await api.post('/candidates/board/move', { applicationId, column, ...extra })).data;
  } catch (err) {
    const d = err.response && err.response.data;
    if (d && d.code === 'SAME_CLIENT_REJECTED') {
      // eslint-disable-next-line no-alert
      if (!window.confirm(`${d.warning}.\n\nSend to this client again anyway?`)) return null;
      return (await api.post('/candidates/board/move', {
        applicationId, column, ...extra, confirmSameClient: true,
      })).data;
    }
    throw err;
  }
}

function Choice({
  on, onClick, title, text, tone,
}) {
  return (
    <button type="button" className={`stp-choice${on ? ' is-on' : ''}${tone ? ` is-${tone}` : ''}`} aria-pressed={on} onClick={onClick}>
      <b>{title}</b>
      <span>{text}</span>
    </button>
  );
}

// --- Verify: the checklist → Send to team lead ---------------------------------
const CHECKS = [
  ['skills', 'Skills match the job', (f) => f.skills],
  ['experience', 'Experience checked', (f) => (f.experienceYears != null ? `${f.experienceYears} yrs` : '')],
  ['ctc', 'Current and expected CTC known', (f) => [f.currentSalary && `now ${f.currentSalary}`, f.expectedSalary && `wants ${f.expectedSalary}`].filter(Boolean).join(' · ')],
  ['notice', 'Notice period known', (f) => f.noticePeriod],
  ['interest', 'Interested in this job', () => ''],
  ['documents', 'Resume and documents on file', () => ''],
];
function VerifyDialog({ app, onClose, onDone }) {
  const [ticks, setTicks] = useState({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const f = app.facts || {};
  const missing = CHECKS.filter(([k]) => !ticks[k]);
  const ready = missing.length === 0 || note.trim().length >= 3;
  async function send() {
    setBusy(true); setError('');
    const line = CHECKS.map(([k, label]) => `${label.split(' ')[0]} ${ticks[k] ? '✓' : '✗'}`).join(' · ');
    const comment = `Verify checklist — ${line}${note.trim() ? `. Note: ${note.trim()}` : ''}`;
    try {
      const out = await boardMove(app.id, 'tl', { comment });
      if (!out) { setBusy(false); return; }
      onDone({ text: `Sent to team lead. ${app.name} is now at TL check.`, undo: { id: app.id, stage: app.stage, name: app.name } });
      onClose();
    } catch (err) {
      setError(errText(err, 'Could not send. Please try again.'));
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Verify — ${app.name}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || !ready} onClick={send}>
            {busy ? 'Sending…' : (app.internal ? 'Send to dept head / team lead' : 'Send to team lead')}
          </button>
        </>
      )}
    >
      <div className="small-muted" style={{ marginBottom: 8 }}>Tick what you checked with the person. The team lead sees this list.</div>
      <div className="stp-checks">
        {CHECKS.map(([k, label, fact]) => (
          <label key={k} className={`stp-check${ticks[k] ? ' is-on' : ''}`}>
            <input type="checkbox" checked={!!ticks[k]} onChange={(e) => setTicks((t) => ({ ...t, [k]: e.target.checked }))} />
            <span>
              <b>{label}</b>
              {fact(f) ? <span className="small-muted">{` · ${fact(f)}`}</span> : null}
            </span>
          </label>
        ))}
      </div>
      <label className="field" style={{ marginTop: 8 }}>
        <span>{missing.length ? `Note * (${missing.length} not ticked — say why)` : 'Note (optional)'}</span>
        <textarea rows="2" maxLength={600} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Documents come tomorrow" />
      </label>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

// --- Approve / Send back (TL check and BDE Review) -------------------------------
function ReviewDialog({
  app, onClose, onDone, who,
}) {
  const tl = who === 'tl';
  const [pick, setPick] = useState('approve');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function go() {
    setBusy(true); setError('');
    try {
      if (pick === 'approve') {
        const out = await boardMove(app.id, tl ? 'bde' : 'shared', { comment: tl ? 'Approved at TL check' : 'Approved at BDE Review — shared with the client' });
        if (!out) { setBusy(false); return; }
        onDone({
          text: tl ? `Approved. ${app.name} is now with the BDE.` : `Approved. ${app.name} is shared with the client.`,
          undo: { id: app.id, stage: app.stage, name: app.name },
        });
      } else {
        await api.post(tl ? `/candidates/applications/${app.id}/return` : `/candidates/applications/${app.id}/bde-return`, { reason });
        onDone({ text: tl ? `Sent back to the recruiter, with your reason.` : `Sent back to the team lead, with your reason.` });
      }
      onClose();
    } catch (err) {
      setError(errText(err, 'That did not work. Please try again.'));
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`${tl ? 'TL check' : 'BDE Review'} — ${app.name}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className={`btn ${pick === 'approve' ? 'btn-primary' : 'btn-danger'}`}
            disabled={busy || (pick === 'back' && reason.trim().length < 3)}
            onClick={go}
          >
            {busy ? 'Saving…' : pick === 'approve' ? (tl ? 'Approve — send to BDE' : 'Approve — send to client') : 'Send back'}
          </button>
        </>
      )}
    >
      <div className="stp-choices">
        <Choice on={pick === 'approve'} onClick={() => setPick('approve')} tone="green" title="Approve" text={tl ? 'Good profile. It goes to the client manager (BDE).' : 'Good profile. It is shared with the client now.'} />
        <Choice on={pick === 'back'} onClick={() => setPick('back')} tone="red" title="Send back" text={tl ? 'Back to the recruiter, with your reason.' : 'Back to the team lead, with your reason.'} />
      </div>
      {pick === 'back' && (
        <label className="field" style={{ marginTop: 8 }}>
          <span>Why is it going back? *</span>
          <textarea autoFocus rows="3" maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. CTC not confirmed, notice period too long" />
        </label>
      )}
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

// --- Reject (the same everywhere), then other matching jobs ------------------------
function RejectDialog({
  app, onClose, onDone, presetBy = '',
}) {
  const [v, setV] = useState({ ...EMPTY_REJECT, rejectedBy: presetBy });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  async function go() {
    setBusy(true); setError('');
    try {
      const { stage, ...rest } = rejectPayload(v); // eslint-disable-line no-unused-vars
      await boardMove(app.id, 'rejected', rest);
      forgetStillFits(app.candidateId);
      onDone({
        text: v.rejectKind === 'do_not_use' ? `Rejected. "Do not use" sent to the team lead to approve.` : `Rejected for this job. Saved.`,
        undo: v.rejectKind === 'do_not_use' ? null : { id: app.id, stage: app.stage, name: app.name },
      });
      setDone(true);
    } catch (err) {
      setError(errText(err, 'Could not reject. Please try again.'));
    } finally {
      setBusy(false);
    }
  }
  if (done) {
    return (
      <Modal
        title={`Rejected — ${app.name}`}
        onClose={onClose}
        footer={<button type="button" className="btn btn-primary" onClick={onClose}>Done</button>}
      >
        <div className="notice" style={{ marginBottom: 10 }}>Saved. Nothing is deleted — the person stays in People.</div>
        <div className="stp-label">Other matching jobs (same department)</div>
        {app.candidateId ? <StillFits candidateId={app.candidateId} full /> : <span className="small-muted">No other job to suggest.</span>}
      </Modal>
    );
  }
  return (
    <Modal
      title={`Reject — ${app.name}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-danger" disabled={busy || !rejectReady(v)} onClick={go}>
            {busy ? 'Saving…' : v.rejectKind === 'do_not_use' ? 'Reject and ask team lead' : 'Reject for this job'}
          </button>
        </>
      )}
    >
      <RejectFields value={v} onChange={setV} />
      {error && <div className="error-text" style={{ marginTop: 6 }}>{error}</div>}
    </Modal>
  );
}

// --- Client response: Shortlisted / Rejected / On hold -----------------------------
function ClientDialog({
  app, onClose, onDone, onReject,
}) {
  const [pick, setPick] = useState('');
  const [hold, setHold] = useState({ reasonCategory: '', reasonDetail: '', reviewOn: inDays(7) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function go() {
    setBusy(true); setError('');
    try {
      if (pick === 'short') {
        await api.patch(`/applications/${app.id}/stage`, { stage: 'CLIENT_SHORTLISTED', comment: 'Client response: shortlisted' });
        onDone({ text: `Saved. The client shortlisted ${app.name}. Next: book the interview.`, undo: { id: app.id, stage: app.stage, name: app.name } });
      } else {
        await api.patch(`/applications/${app.id}/stage`, { stage: 'HOLD', comment: 'Client response: on hold', ...hold });
        onDone({ text: `Saved. ${app.name} is on hold. It comes back to you on ${hold.reviewOn}.`, undo: { id: app.id, stage: app.stage, name: app.name } });
      }
      onClose();
    } catch (err) {
      setError(errText(err, 'That did not work. Please try again.'));
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Client response — ${app.name}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || !pick || (pick === 'hold' && !hold.reasonCategory)} onClick={go}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      )}
    >
      <div className="small-muted" style={{ marginBottom: 8 }}>What did the client say?</div>
      <div className="stp-choices is-3">
        <Choice on={pick === 'short'} onClick={() => setPick('short')} tone="green" title="Shortlisted" text="The client wants to meet. Book the interview next." />
        <Choice on={false} onClick={() => onReject()} tone="red" title="Rejected" text="The client said no. Say why." />
        <Choice on={pick === 'hold'} onClick={() => setPick('hold')} tone="yellow" title="On hold" text="The client will decide later." />
      </div>
      {pick === 'hold' && (
        <div className="stp-hold">
          <label className="field">
            <span>Reason *</span>
            <Combo creatable value={hold.reasonCategory} onChange={(e) => setHold({ ...hold, reasonCategory: e.target.value })}>
              <option value="">Choose a reason…</option>
              {HOLD_REASON_CATEGORIES.map((x) => <option key={x} value={x}>{x}</option>)}
            </Combo>
          </label>
          <label className="field">
            <span>Ask the client again on *</span>
            <input type="date" min={istToday()} value={hold.reviewOn} onChange={(e) => setHold({ ...hold, reviewOn: e.target.value })} />
          </label>
          <label className="field">
            <span>What did the client say? (optional)</span>
            <textarea rows="2" maxLength={600} value={hold.reasonDetail} onChange={(e) => setHold({ ...hold, reasonDetail: e.target.value })} />
          </label>
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

// --- Joined: joining date, final CTC, commission % → Accounts ----------------------
function JoinedDialog({ app, onClose, onDone }) {
  const [terms, setTerms] = useState(null);
  const [form, setForm] = useState({ joiningDate: istToday(), offeredCtc: '', feePercent: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get(`/candidates/board/joining-terms/${app.id}`)
      .then((r) => {
        setTerms(r.data);
        setForm({
          joiningDate: r.data.joiningDate ? String(r.data.joiningDate).slice(0, 10) : istToday(),
          offeredCtc: r.data.offeredCtc ? String(r.data.offeredCtc) : '',
          feePercent: r.data.feePercent != null ? String(r.data.feePercent) : '',
        });
      })
      .catch((err) => setError(errText(err, 'Could not open the joining details.')));
  }, [app.id]);
  const internal = terms ? terms.internal : !!app.internal;
  const ctcOk = internal || Number(form.offeredCtc) > 0;
  const feeOk = !terms || !terms.canSetFee || (Number(form.feePercent) > 0 && Number(form.feePercent) <= 50);
  // "Did not join" people are not marked joined from here.
  const dropped = !!(terms && terms.joiningStatus === 'Dropped');
  const notYet = !!(terms && terms.stage && terms.stage !== 'OFFER_ACCEPTED');
  async function save() {
    setBusy(true); setError('');
    try {
      // Through the Joining checklist (e2e gap 2, 2026-10-03): the joining
      // date first, then "Joined" — the same two steps as Joining screen, so
      // "Move step" can no longer skip them. The server refuses in plain words
      // when something is missing (e.g. documents not verified).
      const extra = {};
      if (Number(form.offeredCtc) > 0) extra.offeredCtc = Number(form.offeredCtc);
      if (terms && terms.canSetFee && form.feePercent !== '' && Number(form.feePercent) !== Number(terms.feePercent)) extra.feePercent = Number(form.feePercent);
      await api.post(`/ats/joining/${app.id}/schedule`, { joiningDate: form.joiningDate, ...(extra.offeredCtc ? { offeredCtc: extra.offeredCtc } : {}) });
      await api.post(`/ats/joining/${app.id}/joined`, extra);
      onDone({ text: internal ? `Saved. ${app.name} joined — added as an employee in HRMS.` : `Saved. ${app.name} joined. The invoice is now with Accounts.` });
      onClose();
    } catch (err) {
      setError(errText(err, 'Could not save the joining. Please try again.'));
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Joined — ${app.name}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || !terms || dropped || notYet || !form.joiningDate || !ctcOk || !feeOk} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      )}
    >
      {!terms && !error && <div className="small-muted">Loading…</div>}
      {dropped && <div className="notice red">{app.name} is marked &quot;Did not join&quot;. If they are joining after all, set a new joining date on the Joining screen first.</div>}
      {!dropped && notYet && <div className="notice">The offer comes first: press &quot;Prepare offer&quot; on the profile. When the candidate accepts, mark the joining here.</div>}
      {terms && !dropped && (
        <>
          <label className="field">
            <span>Joining date *</span>
            <input type="date" value={form.joiningDate} onChange={(e) => setForm({ ...form, joiningDate: e.target.value })} />
          </label>
          {!internal && (
            <label className="field">
              <span>Final CTC (₹ per year) *</span>
              <input type="number" min="1" step="1000" inputMode="numeric" placeholder="e.g. 850000" value={form.offeredCtc} onChange={(e) => setForm({ ...form, offeredCtc: e.target.value })} />
              <span className="small-muted">{rupees(form.offeredCtc) || (terms.expectedSalary ? `They asked for ${terms.expectedSalary}` : 'The yearly CTC in the offer letter')}</span>
            </label>
          )}
          {!internal && terms.canSetFee && (
            <label className="field">
              <span>Commission % *</span>
              <input type="number" min="0.1" max="50" step="0.01" value={form.feePercent} onChange={(e) => setForm({ ...form, feePercent: e.target.value })} />
              <span className="small-muted">
                {`Agreement with ${terms.clientName || 'the client'}: ${terms.feePercent}%.`}
                {Number(form.offeredCtc) > 0 && Number(form.feePercent) > 0 ? ` Fee ≈ ₹${Math.round((Number(form.offeredCtc) * Number(form.feePercent)) / 100).toLocaleString('en-IN')} + GST.` : ''}
              </span>
            </label>
          )}
          {!internal && !terms.canSetFee && (
            <div className="small-muted" style={{ marginBottom: 6 }}>Commission: the client&apos;s agreement % is used. Accounts checks it on the invoice.</div>
          )}
          <div className="notice" style={{ marginTop: 6 }}>
            {internal ? 'Save adds this person as an employee in HRMS.' : 'Save sends the joining to Accounts — the invoice is made from it.'}
          </div>
        </>
      )}
      {error && <div className="error-text" style={{ marginTop: 6 }}>{error}</div>}
    </Modal>
  );
}

// --- The one entry point ------------------------------------------------------------
export default function StepPopup({
  kind, app, onClose, onDone, onNeedInterview, presetBy = '',
}) {
  const [k, setK] = useState(kind);
  // presetBy: whose decision a Reject is, already known ("Client said no").
  const [by, setBy] = useState(presetBy || '');
  useEffect(() => { setK(kind); setBy(presetBy || ''); }, [kind, app && app.id, presetBy]); // eslint-disable-line react-hooks/exhaustive-deps
  // Interview: the existing Schedule window (with the ROUND) opens instead.
  useEffect(() => {
    if (k === 'interview' && app) {
      if (onNeedInterview) onNeedInterview(app);
      onClose();
    }
  }, [k]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!k || !app || k === 'interview') return null;
  const done = (x) => { if (onDone) onDone(x || {}); };
  if (k === 'verify') return <VerifyDialog app={app} onClose={onClose} onDone={done} />;
  if (k === 'tl') return <ReviewDialog who="tl" app={app} onClose={onClose} onDone={done} />;
  if (k === 'bde') return <ReviewDialog who="bde" app={app} onClose={onClose} onDone={done} />;
  if (k === 'client') return <ClientDialog app={app} onClose={onClose} onDone={done} onReject={() => { setBy('Client'); setK('reject'); }} />;
  if (k === 'reject') return <RejectDialog app={app} onClose={onClose} onDone={done} presetBy={by} />;
  if (k === 'joined') return <JoinedDialog app={app} onClose={onClose} onDone={done} />;
  return null;
}

// The popup a profile / list "next step" opens for a stage (null = none).
export function popupForStage(stage, { internal = false } = {}) {
  if (SOURCED.includes(stage) || ['RECRUITER_REVIEW', 'RECRUITER_APPROVED'].includes(stage)) return 'verify';
  if (stage === 'TL_REVIEW') return internal ? null : 'tl';
  if (['WITH_BDE', 'BDE_APPROVED'].includes(stage)) return 'bde';
  if (['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'].includes(stage)) return 'client';
  if (['OFFER_ACCEPTED'].includes(stage)) return 'joined';
  return null;
}
