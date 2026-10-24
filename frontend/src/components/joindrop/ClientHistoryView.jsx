import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import StatusChip from '../ui/StatusChip.jsx';
import { dmy, when, errText } from './JdParts.jsx';
import './joindrop.css';

// ---------------------------------------------------------------------------
// CLIENT HISTORY: "what happened with this client, date by date" and a small strip of counts.
// Used on the Client page (History tab), in the ATS reports (Client history) and, with fewer lines, in the client's own portal.
// The server cuts it for each login (agreement steps, logins and invoices only for those who may see them).
// ---------------------------------------------------------------------------
const GROUP_TONE = {
  Client: 'blue', Agreement: 'yellow', Login: 'blue', Requirement: 'blue', Candidates: 'blue', Interview: 'blue', Joining: 'green', Drop: 'red', Replacement: 'yellow', Invoice: 'green',
};
const GROUPS = ['Client', 'Agreement', 'Login', 'Requirement', 'Candidates', 'Interview', 'Joining', 'Drop', 'Replacement', 'Invoice'];

export default function ClientHistoryView({ endpoint, portal = false }) {
  const [h, setH] = useState(null);
  const [err, setErr] = useState('');
  const [group, setGroup] = useState('');
  const [order, setOrder] = useState('old');
  useEffect(() => {
    setH(null); setErr('');
    api.get(endpoint).then((r) => setH(r.data)).catch((e) => setErr(errText(e, 'Could not load the history.')));
  }, [endpoint]);
  const events = useMemo(() => {
    const list = (h?.events || []).filter((e) => !group || e.group === group);
    return order === 'new' ? [...list].reverse() : list;
  }, [h, group, order]);
  if (err) return <div className="notice red"><span>{err}</span></div>;
  if (!h) return <div className="small-muted">Loading…</div>;
  const s = h.summary || {};
  const tiles = [
    ...(s.addedOn ? [[dmy(s.addedOn), 'Added to TeamLink']] : []),
    [s.jobsTotal, 'Requirements given'], [s.jobsOpen, 'Open now'], [s.jobsClosed, 'Closed'], [s.candidatesSent, 'Candidates sent'], [s.interviewsDone, 'Interviews done'],
    [s.joined, 'Joined'], [s.dropped, 'Dropped'], [s.replacementRequests, 'Replacements asked'],
    ...(s.logins != null ? [[s.logins, 'Logins'], [s.firstLoginOn ? dmy(s.firstLoginOn) : 'Not recorded', 'First sign-in'], [s.lastLoginOn ? dmy(s.lastLoginOn) : 'Not yet', 'Last sign-in']] : []),
    ...(s.invoicesRaised != null ? [[s.invoicesRaised, 'Invoices raised'], [s.invoicesPaid, 'Invoices paid']] : []),
  ];
  const present = GROUPS.filter((g) => (h.events || []).some((e) => e.group === g));
  return (
    <div>
      <div className="jd-strip">{tiles.map(([v, k]) => <div className="tile" key={k}><b>{v == null ? 0 : v}</b><span>{k}</span></div>)}</div>
      {(s.jobsPerMonth || []).length > 0 && <div className="small-muted" style={{ marginBottom: 8 }}><b>Requirements given each month:</b> {s.jobsPerMonth.map((m) => `${m.month} (${m.count})`).join(', ')}</div>}
      <div className="jd-filters" style={{ alignItems: 'center' }}>
        <button type="button" className={`btn btn-sm${!group ? ' btn-primary' : ''}`} onClick={() => setGroup('')}>Everything</button>
        {present.map((g) => <button key={g} type="button" className={`btn btn-sm${group === g ? ' btn-primary' : ''}`} onClick={() => setGroup(g)}>{g}</button>)}
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOrder(order === 'old' ? 'new' : 'old')}>{order === 'old' ? 'Oldest first' : 'Newest first'}</button>
      </div>
      {events.length === 0 ? <div className="small-muted">Nothing recorded yet.</div> : (
        <ul className="jd-hist">
          {events.map((e, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <li key={i}>
              <div className="when">{e.at ? when(e.at) : dmy(e.day)}</div>
              <div>
                <div><StatusChip status={e.group} tone={GROUP_TONE[e.group] || 'grey'} /> <b>{e.title}</b></div>
                {e.detail && <div style={{ overflowWrap: 'anywhere' }}>{e.detail}</div>}
                {!portal && e.who && <div className="by">{e.who}</div>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
