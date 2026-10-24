import { useEffect, useState } from 'react';
import { shared } from './omniApi.js';

// ---------------------------------------------------------------------------
// REPLIES ON THIS RECORD, inside a source app screen (HRMS employee, Accounts invoice / client contact, vendor). The same replies appear in Omni-Channel > Inbox & Replies; this
// panel shows only the ones matched to THIS record, with where they came from (the campaign) and which apps show them. The server checks that this login may see the person;
// when it may not (403) the panel draws nothing at all.   <RepliesPanel audience="employees" id={employee.id} />    audience: candidates | clients | employees | vendors
// ---------------------------------------------------------------------------
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }) : '');
export default function RepliesPanel({ audience, id, title = 'Replies (Omni-Channel)' }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let on = true;
    if (!id) return undefined;
    shared.get(`/replies/of/${audience}/${id}`).then((r) => { if (on) setRows(r.replies || []); }).catch(() => { if (on) setRows(null); });
    return () => { on = false; };
  }, [audience, id]);
  if (rows === null) return null;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      {rows.length === 0 ? <div className="small-muted">No reply from this person has been matched yet. Replies by WhatsApp, SMS or email appear here and in Omni-Channel &gt; Inbox &amp; Replies.</div> : (
        <table className="table">
          <thead><tr><th>When</th><th>Way</th><th>Reply</th><th>Answers</th><th>Shown in</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id}><td style={{ whiteSpace: 'nowrap' }}>{when(r.at)}</td><td>{r.channel || '—'}</td><td style={{ overflowWrap: 'anywhere' }}>{r.snippet || '—'}</td><td>{r.campaign ? r.campaign.name : '—'}</td><td>{(r.apps || []).join(', ')}</td></tr>)}</tbody>
        </table>
      )}
    </div>
  );
}
