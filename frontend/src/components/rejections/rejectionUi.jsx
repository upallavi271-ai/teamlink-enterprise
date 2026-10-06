// ---------------------------------------------------------------------------
// REJECTIONS — small shared pieces (spec 2026-10-03 §A1, change list §10).
//
//   RejectFields     the reject form, the same in every reject dialog:
//                    whose decision · kind (two big cards) · reason (required)
//                    · note (required) · what the client said (Client only)
//   rejectReady()    may the form be sent
//   rejectPayload()  the body for PATCH /applications/:id/stage (and bulk)
//   RejectedBadge    "Rejected 2×" on a list row; hover lists the details
//   shortDate()      "12 Oct"
//
// The record is the existing one (the stage event into REJECTED). Nothing
// here stores anything of its own.
// ---------------------------------------------------------------------------
import { useId } from 'react';
import Combo from '../Combo.jsx';
import { REJECTED_BY_OPTIONS, REJECTION_REASONS_BY_SIDE, REJECTION_REASON_CATEGORIES } from '../../atsVocab';
import './Rejections.css';

// "Do not use" reasons — the same list the server keeps (utils/rejections.js).
export const DNU_REASONS = ['Fake Resume / Documents', 'Abusive Behaviour', 'Absconded', 'Other'];
// Plain words for whose decision it was.
const SIDE_WORDS = { Client: 'Client', Internal: 'Our team', Candidate: 'Candidate said no' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function shortDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const thisYear = d.getFullYear() === new Date().getFullYear();
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${thisYear ? '' : ` ${d.getFullYear()}`}`;
}

export const EMPTY_REJECT = { rejectedBy: '', rejectKind: 'not_suitable', reasonCategory: '', reasonDetail: '', clientSaid: '' };

export function rejectReady(v) {
  return !!(v && v.rejectedBy && String(v.reasonCategory || '').trim() && String(v.reasonDetail || '').trim());
}
export function rejectPayload(v) {
  return {
    stage: 'REJECTED',
    rejectedBy: v.rejectedBy,
    rejectKind: v.rejectKind === 'do_not_use' ? 'do_not_use' : 'not_suitable',
    reasonCategory: String(v.reasonCategory || '').trim(),
    reasonDetail: String(v.reasonDetail || '').trim(),
    // The client's own words ride on the event's comment.
    ...(v.rejectedBy === 'Client' && String(v.clientSaid || '').trim() ? { comment: String(v.clientSaid).trim() } : {}),
  };
}

// allowDnu: false hides the "Do not use" card (e.g. a bulk reject of many).
export function RejectFields({ value, onChange, allowDnu = true }) {
  const v = value || EMPTY_REJECT;
  const group = useId();
  const set = (patch) => onChange({ ...v, ...patch });
  const dnu = v.rejectKind === 'do_not_use';
  const reasons = dnu ? DNU_REASONS : (REJECTION_REASONS_BY_SIDE[v.rejectedBy] || REJECTION_REASON_CATEGORIES);
  return (
    <div className="rjx-form">
      {allowDnu && (
        <div className="rjx-kinds" role="radiogroup" aria-label="Kind of reject">
          <label className={`rjx-kind${!dnu ? ' is-on' : ''}`}>
            <input type="radio" name={group} checked={!dnu} onChange={() => set({ rejectKind: 'not_suitable', reasonCategory: '' })} />
            <span>
              <b>Not suitable for this job</b>
              Only this job. The person still shows up for other jobs.
            </span>
          </label>
          <label className={`rjx-kind is-dnu${dnu ? ' is-on' : ''}`}>
            <input type="radio" name={group} checked={dnu} onChange={() => set({ rejectKind: 'do_not_use', reasonCategory: '', rejectedBy: v.rejectedBy === 'Client' ? '' : v.rejectedBy })} />
            <span>
              <b>Do not use — needs TL approval</b>
              Fake resume, abuse, absconded. Once the TL approves, blocked from every job.
            </span>
          </label>
        </div>
      )}

      <div className="rjx-field">
        <span>Whose decision? *</span>
        <div className="contact-methods">
          {REJECTED_BY_OPTIONS.filter((o) => !(dnu && o.value === 'Client')).map((o) => (
            <button
              key={o.value}
              type="button"
              title={o.hint}
              className={`contact-method${v.rejectedBy === o.value ? ' is-on' : ''}`}
              onClick={() => set({ rejectedBy: o.value, reasonCategory: dnu ? v.reasonCategory : '' })}
            >
              {SIDE_WORDS[o.value] || o.label}
            </button>
          ))}
        </div>
      </div>

      <label className="rjx-field">
        <span>Reason *</span>
        <Combo
          creatable
          disabled={!v.rejectedBy}
          value={v.reasonCategory}
          onChange={(e) => set({ reasonCategory: e.target.value })}
        >
          <option value="">{v.rejectedBy ? 'Choose a reason…' : 'Choose whose decision first'}</option>
          {reasons.map((x) => <option key={x} value={x}>{x}</option>)}
        </Combo>
      </label>

      <label className="rjx-field">
        <span>Short note *</span>
        <textarea
          rows="2"
          maxLength={1000}
          placeholder={dnu ? 'What happened? The TL reads this before approving.' : 'One line on what happened, e.g. "Wants 12 LPA, budget is 9"'}
          value={v.reasonDetail}
          onChange={(e) => set({ reasonDetail: e.target.value })}
        />
      </label>

      {v.rejectedBy === 'Client' && (
        <label className="rjx-field">
          <span>What did the client say?</span>
          <textarea
            rows="2"
            maxLength={1000}
            placeholder="The client's own words (from the mail or call)"
            value={v.clientSaid}
            onChange={(e) => set({ clientSaid: e.target.value })}
          />
        </label>
      )}

      {dnu && (
        <div className="rjx-wait">This job is rejected now. The block on every other job starts only after the TL approves.</div>
      )}
    </div>
  );
}

// "Rejected 2×" — or "Do not use" (red) / "Do not use asked" (orange).
// row: { rejectedTimes, rejectedHistory, rejectedHiddenCount, doNotUse }
// minTimes: the Rejected tab passes 2 (every row there is rejected once).
export function RejectedBadge({ row, minTimes = 1 }) {
  if (!row) return null;
  const hist = row.rejectedHistory || [];
  const lines = hist.map((h) => `${h.requirementTitle || 'Job'}${h.clientName ? ` (${h.clientName})` : ''} — ${h.byLabel || ''}${h.reason ? `, ${h.reason}` : ''}${h.at ? `, ${shortDate(h.at)}` : ''}`);
  if (row.rejectedHiddenCount > 0) lines.push(`${row.rejectedHiddenCount} more on other teams' jobs`);
  const tip = lines.join('\n');
  return (
    <>
      {row.doNotUse === 'approved' && <span className="rjx-badge" title={`Do not use — blocked from every job.${tip ? `\n${tip}` : ''}`}>Do not use</span>}
      {row.doNotUse === 'pending' && <span className="rjx-badge is-wait" title="Do not use — waiting for the TL to approve">Do not use asked</span>}
      {row.doNotUse !== 'approved' && row.rejectedTimes >= minTimes && (
        <span className="rjx-badge" title={tip || undefined}>{`Rejected ${row.rejectedTimes}×`}</span>
      )}
    </>
  );
}

// A stage move that may meet the same-client warning. Calls send(extra);
// when the server answers SAME_CLIENT_REJECTED it asks, and on "yes" sends
// again with { confirmSameClient: true }. Returns true when sent.
export async function sendWithSameClientCheck(send, ask = (msg) => window.confirm(msg)) {
  try {
    await send({});
    return true;
  } catch (err) {
    const d = err.response && err.response.data;
    if (!d || d.code !== 'SAME_CLIENT_REJECTED') throw err;
    // eslint-disable-next-line no-alert
    if (!ask(`${d.warning}.\n\nSend to this client again anyway?`)) return false;
    await send({ confirmSameClient: true });
    return true;
  }
}
