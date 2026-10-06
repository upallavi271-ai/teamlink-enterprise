import { useState } from 'react';
import { Modal } from '../proto.jsx';
import { RejectFields, EMPTY_REJECT, rejectReady } from '../rejections/rejectionUi.jsx';
import './Interviews.css';

// ---------------------------------------------------------------------------
// THE SHORT INTERVIEW FEEDBACK FORM (change list §11, 2026-10-03)
//   Rating 1–5 · Strengths · Concerns · Selected / Rejected / Hold
//   and, for our own panel only, "Did not attend" (reason + offer a new time).
//
// "Did not attend" lives HERE and only here — the calendar row has no No Show
// button (the user removed it). The record is the server's: rating → the
// four 1–5 criteria, strengths / concerns → the overall text
// (backend utils/shortFeedback.js). Never the AI interview score.
//
//   onSubmit({ rating, comment, result, nextRound? }, reject?) → Promise<boolean>
//   onNoShow({ reason, rescheduleAt? })                    → Promise<boolean>
//
// LAYOUT v3 (2026-10-03): Selected / Next round / On hold / Rejected + one
// comment. allowNextRound adds "Next round" (sent as result Selected +
// nextRound: true — the caller books Round + 1 in the Schedule popup).
// rejectForm shows the SHARED reject fields (rejections/rejectionUi.jsx) under
// Rejected; their value is passed to onSubmit as the second argument.
// ---------------------------------------------------------------------------
const OUTCOMES = [
  ['Selected', 'Selected', 'green'],
  ['NEXT', 'Next round', 'blue'],
  ['Hold', 'On hold', 'orange'],
  ['Rejected', 'Rejected', 'red'],
];
const NO_SHOW_REASONS = ['Phone switched off / not reachable', 'Said they will not come', 'Came late — interview missed', 'Emergency', 'Other'];

export function readShort(overall) {
  const s = String(overall || '');
  const m1 = s.match(/^Strengths:\s*([\s\S]*?)(?:\nConcerns:|$)/);
  const m2 = s.match(/(?:^|\n)Concerns:\s*([\s\S]*)$/);
  if (!m1 && !m2) return { strengths: s, concerns: '' };
  return { strengths: m1 ? m1[1].trim() : '', concerns: m2 ? m2[1].trim() : '' };
}
// The one rating of a saved feedback: the average of its 1–5 criteria.
export function ratingOf(fb) {
  if (!fb) return null;
  const xs = ['technical', 'communication', 'experience', 'roleFit'].map((k) => fb[k]).filter((v) => v != null);
  return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
}

export default function ShortFeedbackForm({
  row, existing, kind = 'Internal', allowNoShow = false, allowNextRound = false, rejectForm = false, onSubmit, onNoShow, onClose,
}) {
  const [rating, setRating] = useState(ratingOf(existing) || 0);
  const [comment, setComment] = useState(String((existing && existing.overall) || ''));
  const [result, setResult] = useState((existing && existing.recommendation) || '');
  const [rej, setRej] = useState(EMPTY_REJECT);
  const [reason, setReason] = useState('');
  const [reasonText, setReasonText] = useState('');
  const [newTime, setNewTime] = useState('');
  const [busy, setBusy] = useState(false);
  const noShow = result === 'NO_SHOW';
  const fullReason = reason === 'Other' ? reasonText.trim() : [reason, reasonText.trim()].filter(Boolean).join(' — ');
  const outcomes = OUTCOMES.filter(([v]) => v !== 'NEXT' || allowNextRound);
  const rejectOk = result !== 'Rejected' || !rejectForm || rejectReady(rej);
  const ready = noShow ? !!fullReason : (rating > 0 && result && comment.trim() && rejectOk);
  const nextNo = (Number(row.round) || 1) + 1;

  async function save() {
    setBusy(true);
    try {
      const ok = noShow
        ? await onNoShow({ reason: fullReason, ...(newTime ? { rescheduleAt: new Date(newTime).toISOString() } : {}) })
        : await onSubmit(
          result === 'NEXT'
            ? { rating, comment: comment.trim(), result: 'Selected', recommendation: 'Selected', nextRound: true }
            : { rating, comment: comment.trim(), result, recommendation: result },
          result === 'Rejected' && rejectForm ? rej : null,
        );
      if (ok !== false) onClose();
    } finally { setBusy(false); }
  }

  const title = kind === 'Client' ? `What the client said — ${row.candidate.name}` : `Feedback — ${row.candidate.name}`;
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={(
        <button type="button" className="btn btn-primary" disabled={busy || !ready} onClick={save}>
          {busy ? 'Saving…' : noShow ? (newTime ? 'Save and book new time' : 'Save — did not attend') : result === 'NEXT' ? `Save and book round ${nextNo}` : 'Save feedback'}
        </button>
      )}
    >
      <div className="ivx-fb">
        <div className="ivx-hint" style={{ marginTop: 0, marginBottom: 12 }}>
          {[row.requirement && row.requirement.title, row.requirement && row.requirement.client && row.requirement.client.name].filter(Boolean).join(' · ')}
        </div>

        <div className="ivx-sec">
          <b>Result *</b>
          <div className="ivx-outs ivv3-outs" role="radiogroup" aria-label="Result">
            {outcomes.map(([v, label, tone]) => (
              <button key={v} type="button" role="radio" aria-checked={result === v} className={`ivx-out ${tone}${result === v ? ' is-on' : ''}`} onClick={() => setResult(v)}>{label}</button>
            ))}
            {allowNoShow && (
              <button type="button" role="radio" aria-checked={noShow} className={`ivx-out grey${noShow ? ' is-on' : ''}`} onClick={() => setResult('NO_SHOW')}>Did not attend</button>
            )}
          </div>
        </div>

        {noShow ? (
          <>
            <div className="ivx-sec">
              <b>Why? *</b>
              <select value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: '100%' }}>
                <option value="">Choose a reason…</option>
                {NO_SHOW_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              {(reason === 'Other' || reason) && (
                <input style={{ width: '100%', marginTop: 6 }} placeholder={reason === 'Other' ? 'What happened?' : 'Anything to add? (optional)'} value={reasonText} onChange={(e) => setReasonText(e.target.value)} />
              )}
            </div>
            <div className="ivx-sec">
              <b>Offer a new time?</b>
              <input type="datetime-local" value={newTime} onChange={(e) => setNewTime(e.target.value)} style={{ width: '100%' }} />
              <div className="ivx-hint">Leave empty to decide later. Everyone is told.</div>
            </div>
          </>
        ) : (
          <>
            <div className="ivx-sec">
              <b>Rating *</b>
              <div className="ivx-stars" role="radiogroup" aria-label="Rating 1 to 5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} type="button" role="radio" aria-checked={rating === n} className={`ivx-star${rating >= n ? ' is-on' : ''}`} onClick={() => setRating(n)}>{n}</button>
                ))}
              </div>
              <div className="ivx-hint">1 = poor · 5 = excellent</div>
            </div>
            <div className="ivx-sec">
              <b>Comment *</b>
              <textarea rows="3" maxLength={4000} placeholder={result === 'NEXT' ? 'What went well? What should the next round check?' : 'One or two lines, e.g. 5 years ICU, calm, clear English. 60-day notice.'} value={comment} onChange={(e) => setComment(e.target.value)} />
            </div>
            {result === 'NEXT' && <div className="ivx-hint">After saving, the booking window opens for round {nextNo}.</div>}
            {result === 'Rejected' && rejectForm && <RejectFields value={rej} onChange={setRej} />}
            {result === 'Rejected' && !rejectForm && kind === 'Internal' && <div className="ivx-hint">Your TL or client manager confirms the reject on the Feedback tab.</div>}
          </>
        )}
      </div>
    </Modal>
  );
}
