import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import StatusChip from '../ui/StatusChip.jsx';
import { when, STATUS_WORD, STATUS_TONE } from './remUtil.js';
import './reminders.css';

// ---------------------------------------------------------------------------
// The dashboard card "Reminders going out" (founder 2026-11-20): today and tomorrow, how many, how many failed. Opens a list
// (candidate, event, message time, way, status). Recruiter: own candidates; TL: the team; Manager / Admin: all; BDE side: the numbers only.
// Hidden when nothing is planned for today or tomorrow.
// ---------------------------------------------------------------------------
export default function RemindersGoingOutCard() {
  const [d, setD] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    api.get('/ats/reminders/upcoming').then((r) => { if (live) setD(r.data); }).catch(() => { if (live) setD(null); });
    return () => { live = false; };
  }, []);
  if (!d) return null;
  const total = d.today.total + d.tomorrow.total;
  if (!total) return null;
  const failed = d.today.failed + d.tomorrow.failed;
  const scopeWord = { own: 'your candidates', team: 'your team', all: 'everyone' }[d.scope] || '';
  // "your own messages" (written by a person on a candidate's Schedule a message tab) apart from the automatic interview / joining reminders
  const num = (label, b) => (
    <span>
      <b>{b.total}</b> {label}
      {b.failed > 0 && <> · <span className="rem-bad">{`${b.failed} failed`}</span></>}
      {b.total > 0 && b.own > 0 && <span className="small-muted">{` (${b.own} your own message${b.own === 1 ? '' : 's'}, ${b.automatic} automatic)`}</span>}
    </span>
  );
  return (
    <section className="panel rem-box" style={{ margin: '0 0 12px' }} aria-label="Reminders going out">
      <div className="rem-head">
        <b>Reminders going out</b>
        <span className="small-muted">{`Your own scheduled messages and the automatic interview / joining reminders${scopeWord ? ` · ${scopeWord}` : ''}`}</span>
        {!d.switchOn && <StatusChip tone="amber">Switched off: not being sent</StatusChip>}
        {failed > 0 && <StatusChip tone="red">{`${failed} failed`}</StatusChip>}
      </div>
      <div className="rem-card-nums">
        {num('today', d.today)}
        {num('tomorrow', d.tomorrow)}
        {!d.countOnly && <button type="button" className="btn btn-sm" onClick={() => setOpen(!open)}>{open ? 'Hide the list' : 'Open the list'}</button>}
      </div>
      {open && !d.countOnly && (
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table className="rem-table">
            <thead><tr><th>Candidate</th><th>Event</th><th>Message goes</th><th>Way</th><th>Status</th></tr></thead>
            <tbody>
              {(d.rows || []).map((r) => (
                <tr key={r.id}>
                  <td><Link to={r.own ? `/candidates/${r.candidateId}?tab=scheduled` : `/candidates/${r.candidateId}?app=${r.applicationId}`}>{r.candidate}</Link><div className="small-muted" style={{ fontSize: 11 }}>{r.role}</div></td>
                  <td>{r.own ? <span className="small-muted">Your own message</span> : `${r.kind === 'joining' ? 'Joining' : 'Interview'} ${when(r.eventAt)}`}</td>
                  <td><b>{when(r.sendAt)}</b><div className="small-muted" style={{ fontSize: 11 }}>{r.own ? 'Written by a person' : `Automatic: ${r.label}`}</div></td>
                  <td>{r.channel}</td>
                  <td><StatusChip tone={STATUS_TONE[r.status] || 'grey'}>{STATUS_WORD[r.status] || r.status}</StatusChip>{r.reason && ['failed', 'skipped'].includes(r.status) && <div className="rem-hist">{r.reason}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
