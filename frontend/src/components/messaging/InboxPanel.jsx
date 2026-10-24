import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api';
import ChannelStrip from './ChannelStrip.jsx';
import ConversationView from './ConversationView.jsx';
import { CHANNEL_ICON } from './msgKit.js';
import './conversation.css';

// ---------------------------------------------------------------------------
// THE INBOX (Follow-ups > Inbox) — everybody who wrote back, and everybody waiting for an answer.
//   Filters with counts that follow each other (pick Medical and the other lists shrink to Medical),
//   a row = person · last message · channel · time · blue dot when unread,
//   open one = the conversation + reply box (Mail / WhatsApp / SMS / Call, templates), Mark done, Give to…
// Only the people the viewer may follow up are listed (same scope as the follow-ups).
// ---------------------------------------------------------------------------

const AUD = { CANDIDATE: 'candidates', CLIENT: 'clients', EMPLOYEE: 'employees' };
const TYPE_WORD = { CANDIDATE: 'Candidate', CLIENT: 'Client', EMPLOYEE: 'Employee' };
const CH_WORD = { Email: 'Mail', WhatsApp: 'WhatsApp', SMS: 'SMS', Call: 'Call' };
const STATE_DEFAULT = 'unread';

function ago(d) {
  if (!d) return '';
  const diff = Date.now() - new Date(d).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function Group({ label, items, value, onPick, all = 'All' }) {
  if (!items || !items.length) return null;
  return (
    <div className="cv-fgroup">
      <span className="l">{label}</span>
      <button type="button" className={`cv-chip${!value ? ' on' : ''}`} onClick={() => onPick('')}>{all}</button>
      {items.map((o) => (
        <button key={o.value} type="button" className={`cv-chip${value === o.value ? ' on' : ''}`} onClick={() => onPick(value === o.value ? '' : o.value)}>
          {o.label || CH_WORD[o.value] || o.value}<em>{o.count}</em>
        </button>
      ))}
    </div>
  );
}

// channel / state (optional): start pre-filtered, used by Omni-Channel > Communication (WhatsApp, SMS, Email, Calls, Conversations)
export default function InboxPanel({ onCount, channel = '', state = '' }) {
  const [f, setF] = useState({ state: state || STATE_DEFAULT, channel, type: '', department: '', assigned: '', q: '', from: '', to: '' });
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(null);
  const [page, setPage] = useState(1);
  const countRef = useRef(onCount); // a new function from the parent on every render must not restart the load
  countRef.current = onCount;

  const load = useCallback(() => {
    const params = { ...f, page };
    Object.keys(params).forEach((k) => { if (params[k] === '') delete params[k]; });
    if (params.from) params.from = new Date(`${params.from}T00:00:00+05:30`).getTime();
    if (params.to) params.to = new Date(`${params.to}T23:59:59+05:30`).getTime();
    api.get('/conversations/inbox', { params })
      .then((r) => { setData(r.data); setErr(''); if (countRef.current) countRef.current(r.data.unreadTotal || 0); })
      .catch((e) => setErr(e.response?.data?.error || 'Could not open the Inbox.'));
  }, [f, page]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  useEffect(() => { setF((x) => ({ ...x, channel, state: state || STATE_DEFAULT })); setPage(1); }, [channel, state]);
  const set = (k) => (v) => { setF((x) => ({ ...x, [k]: v })); setPage(1); };

  if (err) return <div className="msg-box red">{err}</div>;
  if (!data) return <div className="small-muted">Opening the Inbox…</div>;
  if (!data.ready) return <div className="msg-box orange">The Inbox is being set up. It will be here in a few minutes.</div>;
  if (data.allowed === false) return <div className="msg-box orange">Your role does not follow up people, so there is no Inbox for you.</div>;
  const fc = data.facets || {};

  return (
    <div className={`cv-inbox${open ? ' has-open' : ''}`}>
      <div className="cv-list-col">
        <ChannelStrip />
        <div className="cv-filters">
          <Group label="Show" items={(fc.state || []).filter((s) => s.value !== 'open')} value={f.state === 'open' ? '' : f.state} onPick={(v) => set('state')(v || 'open')} all="Everything open" />
          <Group label="On" items={fc.channel} value={f.channel} onPick={set('channel')} />
          <Group label="Who" items={fc.type} value={f.type} onPick={set('type')} />
          <Group label="Handled by" items={fc.assigned} value={f.assigned} onPick={set('assigned')} />
          <Group label="Department" items={fc.department} value={f.department} onPick={set('department')} />
          <div className="cv-fgroup">
            <span className="l">Date</span>
            <input type="date" value={f.from} onChange={(e) => set('from')(e.target.value)} aria-label="From" style={{ width: 140 }} />
            <span>to</span>
            <input type="date" value={f.to} onChange={(e) => set('to')(e.target.value)} aria-label="To" style={{ width: 140 }} />
          </div>
          <input value={f.q} onChange={(e) => set('q')(e.target.value)} placeholder="Search a name or a word" aria-label="Search" style={{ width: '100%', marginTop: 4 }} />
        </div>
        <div className="small-muted" style={{ marginBottom: 6 }}>
          {data.total} {data.total === 1 ? 'conversation' : 'conversations'}
          {data.unreadTotal > 0 ? ` · ${data.unreadTotal} with a reply nobody has read` : ''}
          {data.waitingTotal > 0 ? ` · ${data.waitingTotal} waiting for a reply` : ''}
        </div>
        <div className="cv-rows">
          {data.rows.length === 0 && (
            <div className="cv-empty">
              {f.state === 'unread' ? 'No new replies. You are all caught up.' : 'No conversations match these filters.'}
              {(f.channel || f.type || f.department || f.assigned || f.q || f.from || f.to) && (
                <div><button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setF({ state: 'open', channel: '', type: '', department: '', assigned: '', q: '', from: '', to: '' })}>Clear the filters</button></div>
              )}
            </div>
          )}
          {data.rows.map((r) => (
            <button
              key={r.id} type="button" className={`cv-row${r.unread > 0 ? ' unread' : ''}${open && open.id === r.id ? ' on' : ''}`}
              onClick={() => setOpen(r)}
            >
              <span className="dot" aria-label={r.unread > 0 ? 'Unread' : ''} />
              <span className="main">
                <span className="nm"><span>{r.name || 'Unknown'}</span><small>{ago(r.lastAt)}</small></span>
                <span className="sn">{r.direction === 'OUT' ? 'You: ' : ''}{r.snippet || '(no words)'}</span>
                {r.waNumbers && r.waNumbers.length > 0 && <span className="sn" title="The WhatsApp number(s) this chat runs on"> · {r.waNumbers.map((n) => n.label).join(', ')}</span>}
                <span className="tg">
                  <span>{CHANNEL_ICON[r.channel] || ''} {CH_WORD[r.channel] || r.channel}</span>
                  <span>{TYPE_WORD[r.personType]}</span>
                  {r.department && <span>{r.department}</span>}
                  <span>{r.ownerName ? `Handled by ${r.ownerName}` : 'Nobody yet'}</span>
                  {r.waiting && <span>⏳ waiting for a reply</span>}
                  {r.done && <span>✔ done</span>}
                  {r.unread > 1 && <span>{r.unread} new</span>}
                </span>
              </span>
            </button>
          ))}
        </div>
        {data.pages > 1 && (
          <div className="cv-fgroup" style={{ marginTop: 8 }}>
            <button type="button" className="btn btn-sm" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>Newer</button>
            <span>Page {data.page} of {data.pages}</span>
            <button type="button" className="btn btn-sm" disabled={data.page >= data.pages} onClick={() => setPage(data.page + 1)}>Older</button>
          </div>
        )}
      </div>
      <div className="cv-open-col">
        {open ? (
          <>
            <button type="button" className="btn btn-sm cv-back" onClick={() => { setOpen(null); load(); }}>← Back to the list</button>
            <ConversationView key={open.id} audience={AUD[open.personType]} personId={open.personId} name={open.name} onChanged={load} />
          </>
        ) : (
          <div className="cv-empty">Pick a conversation to read it and answer.</div>
        )}
      </div>
    </div>
  );
}
