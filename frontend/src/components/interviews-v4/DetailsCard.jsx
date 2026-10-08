import { useEffect, useState } from 'react';
import { Avatar, Icon, Pill } from '../atskit/AtsKit.jsx';
import { interviewStatusLabel } from '../../atsVocab';
import {
  statusTone, isLateFeedback, cleanName, panelNames,
} from './calUtils.js';

// The right-hand "Interview details" card: the interview picked on the
// calendar (or the next one). Every field is the interview record's own —
// candidate, job, when, type, mode, client, interviewer / panel, recruiter,
// BDE, round, place / link — and the actions are the page's existing ones
// (passed in as `actions`, so what a login may do stays exactly as before).
const fmtWhen = (iso) => {
  if (!iso) return 'No time yet';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
};
const hire = (v) => (v === 'TeamLink Internal Hire' ? 'TeamLink hire' : v ? 'Client hire' : '');

function Field({ icon, label, children }) {
  return (
    <li className="iv4-df">
      <span className="iv4-df-ic"><Icon name={icon} size={16} /></span>
      <span className="iv4-df-txt">
        <span className="iv4-df-lbl">{label}</span>
        <span className="iv4-df-val">{children}</span>
      </span>
    </li>
  );
}

export default function DetailsCard({
  row, auto = false, onClear, onOpenCandidate, onFull, actions, loaded = true,
}) {
  const [tab, setTab] = useState('details');
  useEffect(() => { setTab('details'); }, [row && row.id]);
  if (!row) {
    return (
      <section className="ak-panel iv4-details" aria-label="Interview details">
        <header className="iv4-det-head"><h3>Interview details</h3></header>
        <div className="ak-empty">{loaded ? 'No interview to show. Pick one on the calendar.' : 'Loading…'}</div>
      </section>
    );
  }
  const tone = statusTone(row);
  const late = isLateFeedback(row);
  const r = row.requirement || {};
  const isPerson = String(row.mode || '') === 'In Person';
  const where = row.meetingLink
    ? <a href={row.meetingLink} target="_blank" rel="noreferrer" title={row.meetingLink}>Open meeting link</a>
    : (row.location || '—');
  const history = row.history || [];
  return (
    <section className="ak-panel iv4-details" aria-label="Interview details">
      <header className="iv4-det-head">
        <h3>Interview details</h3>
        {auto ? <span className="iv4-det-auto">Shown first</span> : (
          <button type="button" className="iv4-x" onClick={onClear} aria-label="Clear selection">×</button>
        )}
      </header>
      <div className="iv4-det-who">
        <Avatar name={cleanName(row.candidate?.name)} size={46} />
        <div className="iv4-det-name">
          <button type="button" className="iv4-link" onClick={() => onOpenCandidate(row)} title="Open the candidate (contact details, profile)">
            {cleanName(row.candidate?.name)}
          </button>
          <span className="iv4-det-sub" title={r.title}>{r.title}</span>
          <span className="iv4-det-sub">{[row.interviewCode, r.department].filter(Boolean).join(' · ')}</span>
          <span className="iv4-det-pills">
            <Pill tone={tone}>{row.statusLabel || row.status}</Pill>
            {late && <Pill tone="red">Feedback late</Pill>}
          </span>
        </div>
      </div>
      <div className="iv4-det-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'details'} className={tab === 'details' ? 'is-on' : ''} onClick={() => setTab('details')}>Details</button>
        <button type="button" role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'is-on' : ''} onClick={() => setTab('history')}>
          History{history.length ? ` (${history.length})` : ''}
        </button>
      </div>
      {tab === 'details' ? (
        <ul className="iv4-det-list">
          <Field icon="calendar" label="Date & time">
            {fmtWhen(row.interviewAt)}
            {row.rescheduleCount > 0 ? <span className="iv4-muted">{` · moved ${row.rescheduleCount}×`}</span> : null}
          </Field>
          <Field icon="chat" label="Interview type">{row.type || '—'}</Field>
          <Field icon="send" label="Mode">{row.mode === 'In Person' ? 'Offline (in person)' : (row.mode || '—')}</Field>
          <Field icon="building" label="Client">
            {r.client?.name || 'TeamLink (internal)'}
            {hire(row.hiringType) ? <span className="iv4-muted">{` · ${hire(row.hiringType)}`}</span> : null}
          </Field>
          <Field icon="user" label={(row.panel || []).length > 1 ? 'Interview panel' : 'Interviewer'}>{panelNames(row) || '—'}</Field>
          <Field icon="team" label="Recruiter / BDE">
            {[r.recruiter?.name, r.bde?.name].filter(Boolean).join(' / ') || '—'}
          </Field>
          <Field icon="clock" label="Round">{`Round ${row.round || 1}`}</Field>
          <Field icon="pin" label={isPerson ? 'Location' : 'Location / link'}>{where}</Field>
          {row.cancelReason && <Field icon="alert" label="Reason">{row.cancelReason}</Field>}
        </ul>
      ) : (
        <ul className="iv4-det-hist">
          {history.length === 0 && <li className="iv4-muted">Nothing recorded yet.</li>}
          {history.slice().reverse().slice(0, 12).map((h) => (
            <li key={h.id}>
              <b>{String(h.status).startsWith('REMINDER_') ? 'Reminder sent' : h.status === 'NO_SHOW' ? 'Did not attend' : interviewStatusLabel(h.status)}</b>
              {h.by && <span className="iv4-muted">{` · ${h.by}`}</span>}
              {h.reason && <div className="iv4-muted">{h.reason}</div>}
              <div className="iv4-muted">{new Date(h.createdAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
            </li>
          ))}
        </ul>
      )}
      <div className="iv4-det-actions">
        {actions}
        <div className="iv4-det-more">
          {row.meetingLink && <a className="btn btn-sm btn-primary" href={row.meetingLink} target="_blank" rel="noreferrer">Join</a>}
          <button type="button" className="btn btn-sm" onClick={() => onFull(row)}>View details</button>
        </div>
      </div>
    </section>
  );
}
