import { useEffect, useState } from 'react';
import api from '../../api';
import '../outreach/omni2.css';

// ONE communication timeline for a candidate (Conversation tab, full page and drawer): WhatsApp sent, Email sent, SMS sent, Call done, Campaign added,
// Reply received, Interview scheduled, Offer shared, Joined. Read only; labels and times only (never an address or message text, so it is safe for
// the BDE team). Server: GET /api/outreach/candidate-timeline/:id (merges messages, the one inbox, follow-ups, ATS steps and Omni-Channel campaigns).
const MARK = { whatsapp: 'W', email: 'E', sms: 'S', call: 'C', campaign: 'P', reply: 'R', interview: 'I', offer: 'O', joined: 'J' };
const WORD = { whatsapp: 'WhatsApp', email: 'Email', sms: 'SMS', call: 'Call', campaign: 'Campaign', reply: 'Reply', interview: 'Interview', offer: 'Offer', joined: 'Joined' };
const fmt = (iso) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });

export default function CommunicationTimeline({ candidateId }) {
  const [items, setItems] = useState(null);
  useEffect(() => { let on = true; api.get(`/outreach/candidate-timeline/${candidateId}`).then((r) => { if (on) setItems(r.data.items); }).catch(() => { if (on) setItems(null); }); return () => { on = false; }; }, [candidateId]);
  if (!items) return null; // a login without Omni-Channel access simply does not get this list
  return (
    <details className="oc2-block" open={items.length > 0 && items.length < 12}>
      <summary><b>Communication timeline</b> <span className="oc-note">({items.length} {items.length === 1 ? 'event' : 'events'})</span></summary>
      {items.length === 0 ? <div className="oc-note" style={{ marginTop: 6 }}>Nothing has been sent to or received from this person yet.</div> : (
        <ul className="oc2-tl">{items.map((e, i) => <li key={`${e.at}-${i}`}><span className={`oc2-ic ${e.icon}`} title={WORD[e.kind]} aria-hidden="true">{MARK[e.kind] || '?'}</span><span>{e.text}</span><time dateTime={e.at}>{fmt(e.at)}</time></li>)}</ul>
      )}
    </details>
  );
}
