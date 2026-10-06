import { useEffect, useState } from 'react';
import api from '../../api';
import StatusChip from '../ui/StatusChip.jsx';
import './followups.css';

// ---------------------------------------------------------------------------
// FOLLOW-UP TIMELINE on the candidate profile (spec 2026-10-03, C1): every
// call / mail / WhatsApp attempt with its outcome ("Not picked", "Interested"),
// who and when — newest first. Read from GET /api/candidates/:id/followup-log
// (the existing follow-up log: CandidateMessage trigger Manual + the
// follow-up records). No second store.
//
//   <FollowUpTimeline candidateId={id} refreshKey={n} />
//   bump refreshKey after a contact is logged (QuickContact onLogged).
// ---------------------------------------------------------------------------

const ICON = { Call: '📞', Email: '✉️', WhatsApp: '💬', SMS: '💬', 'In Person': '🤝' };
const CHANNEL_WORD = { Call: 'Call', Email: 'Mail', WhatsApp: 'WhatsApp', SMS: 'SMS', 'In Person': 'Met' };
// Outcome colours: green good, orange waiting, red problem.
function outcomeTone(o) {
  const s = String(o || '').toLowerCase();
  if (!s) return 'grey';
  if (/not interested|wrong|switched|declin|fail/.test(s)) return 'red';
  if (/interested|answered|replied|sent|done|confirmed/.test(s)) return 'green';
  return 'amber'; // not picked, busy, call back, no response …
}
const MAIL_STATUS = {
  SENT: ['Sent', 'green'], FAILED: ['Failed', 'red'], QUEUED: ['Sending…', 'amber'], RETRY: ['Sending…', 'amber'],
  NOT_SENT_NO_PROVIDER: ['Not sent — mail account not set up', 'red'], NOT_SENT_SWITCHED_OFF: ['Not sent — candidate emails are switched off', 'amber'], OPENED_ON_DEVICE: ['Opened on their device', 'blue'],
};

function when(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  if (days <= 0 && new Date().toDateString() === d.toDateString()) return `Today, ${time}`;
  if (days <= 1) return `Yesterday, ${time}`;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

const PAGE = 10;

export default function FollowUpTimeline({ candidateId, refreshKey = 0, title = 'Follow-ups' }) {
  const [state, setState] = useState({ entries: null, error: '' });
  const [show, setShow] = useState(PAGE);
  useEffect(() => {
    if (!candidateId) return undefined;
    let live = true;
    api.get(`/candidates/${candidateId}/followup-log`)
      .then((r) => { if (live) setState({ entries: r.data.entries || [], error: '' }); })
      .catch((e) => { if (live) setState({ entries: [], error: e.response?.data?.error || 'Could not load the follow-ups. Please try again.' }); });
    return () => { live = false; };
  }, [candidateId, refreshKey]);

  const { entries, error } = state;
  if (entries === null) return <div className="small-muted">Loading follow-ups…</div>;
  if (error) return <div className="fux-err">{error}</div>;
  // Contacts and finished follow-ups are the story; "follow-up set" rows only
  // when they say when it is due.
  const items = entries.filter((e) => e.kind !== 'followup-set' || e.due);
  return (
    <div className="fux-timeline">
      {title && <div className="fux-section-title" style={{ marginTop: 0 }}>{title}</div>}
      {!items.length && <div className="small-muted">No calls, mails or WhatsApp yet. Use the Call, Mail or WhatsApp button above — it is logged here by itself.</div>}
      <ul className="fux-tl">
        {items.slice(0, show).map((e, i) => {
          const word = CHANNEL_WORD[e.channel] || e.channel || 'Follow-up';
          let headline = word;
          if (e.kind === 'followup-set') headline = `Follow-up planned${e.due ? ` for ${e.due}` : ''}`;
          if (e.kind === 'followup-done') headline = `Follow-up done${e.channel ? ` (${word})` : ''}`;
          const mail = e.kind === 'contact' && e.channel === 'Email' ? MAIL_STATUS[e.status] : null;
          return (
            // eslint-disable-next-line react/no-array-index-key
            <li className="fux-tl-item" key={`${e.kind}-${e.id || i}-${e.at}`}>
              <span className="fux-tl-icon" aria-hidden="true">{e.kind === 'contact' ? (ICON[e.channel] || '•') : (e.kind === 'followup-done' ? '✅' : '🗓️')}</span>
              <div className="fux-tl-main">
                <div className="fux-tl-top">
                  <b>{headline}</b>
                  {e.outcome && <StatusChip tone={outcomeTone(e.outcome)}>{e.outcome}</StatusChip>}
                  {mail && <StatusChip tone={mail[1]}>{mail[0]}</StatusChip>}
                </div>
                <div className="fux-tl-meta">
                  {[when(e.at), e.by ? `by ${e.by}` : null, e.requirement, e.purpose && e.purpose !== 'Follow-up' ? e.purpose : null].filter(Boolean).join(' · ')}
                </div>
                {e.said && <div className="fux-tl-said">{e.said}</div>}
              </div>
            </li>
          );
        })}
      </ul>
      {items.length > show && (
        <button type="button" className="btn btn-sm fux-tl-more" onClick={() => setShow((n) => n + PAGE)}>
          Show {Math.min(PAGE, items.length - show)} more
        </button>
      )}
    </div>
  );
}
