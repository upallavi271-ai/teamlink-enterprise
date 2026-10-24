import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../../api';
import Combo from '../Combo.jsx';
import WaChatPane from './WaChatPane.jsx';
import WaChatAdmin from './WaChatAdmin.jsx';
import useVisiblePoll from './useVisiblePoll.js';
import { listTime, markRowRead, tickOf, followUpWhen } from './waChatLogic.js';
import './conversation.css';
import './messaging.css';
import './waChats.css';

// ---------------------------------------------------------------------------
// WHATSAPP CHATS (Follow-ups > WhatsApp chats) - ONE screen for the recruiter:
//   left   the chats (latest first): name, requirement, last words, time, unread, "Sending from", step, follow-up
//   right  the chat: bubbles, ticks, pictures / PDFs / voice notes, the follow-up, the box to answer
// New replies come by themselves: the list asks the server every 30 seconds (one small question; the whole list is read again only when
// something changed) and the open chat every 10 seconds, only while this page is visible.
// ---------------------------------------------------------------------------
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const AUD = { CANDIDATE: 'candidates', CLIENT: 'clients', EMPLOYEE: 'employees' };
const TYPE_WORD = { CANDIDATE: '', CLIENT: 'Client', EMPLOYEE: 'Employee' };
const STATES = [['all', 'Everything', 'all'], ['unread', 'Unread', 'unread'], ['needsReply', 'Needs reply', 'needsReply'], ['waiting', 'Waiting for candidate', 'waiting'], ['followups', "Today's follow-ups", 'followups']];
const INTENT_WORD = { interested: 'Interested', not_interested: 'Not interested', call_back: 'Call back' };
const initials = (n) => String(n || '?').replace(/ZZTEST|\(.*\)/g, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';

function Row({ r, on, onPick }) {
  const tick = r.last.direction === 'out' ? tickOf(r.last.state) : null;
  return (
    <button type="button" className={`wc-row${r.unread > 0 ? ' unread' : ''}${on ? ' on' : ''}`} onClick={() => onPick(r)} aria-current={on ? 'true' : undefined}>
      <span className="wc-avatar" aria-hidden="true">{initials(r.name)}</span>
      <span className="wc-rowmain">
        <span className="wc-rowtop"><b className="wc-name">{r.name}</b><small className="wc-time">{listTime(r.last.at)}</small></span>
        {(r.requirement || TYPE_WORD[r.personType]) && (
          <span className="wc-req">{TYPE_WORD[r.personType] ? `${TYPE_WORD[r.personType]}` : ''}{TYPE_WORD[r.personType] && r.requirement ? ' · ' : ''}{r.requirement ? `${r.requirement.title || 'Requirement'}${r.requirement.client ? ` · ${r.requirement.client}` : ''}` : ''}</span>
        )}
        <span className="wc-prev">
          {tick && <span className={`wc-tick ${tick.tone}`} aria-label={tick.word}>{tick.glyph}</span>}
          <span className="wc-prevtext">{r.last.direction === 'out' ? 'You: ' : ''}{r.last.text || '(no words)'}</span>
          {r.unread > 0 && <span className="wc-badge" aria-label={`${r.unread} new`}>{r.unread}</span>}
        </span>
        <span className="wc-chips">
          {r.step && <span className="wc-chip blue">{r.step.label}</span>}
          <span className="wc-chip grey">{r.sendingFrom ? `Sending from ${r.sendingFrom}` : 'Main number'}</span>
          {r.intent && <span className="wc-chip violet">{INTENT_WORD[r.intent] || r.intent}</span>}
          {r.followUp && r.followUp.replied && <span className="wc-chip amber">Candidate replied: review</span>}
          {r.followUp && !r.followUp.replied && r.followUp.due && <span className="wc-chip red">Follow-up {followUpWhen(r.followUp.dueDate, r.followUp.dueTime).toLowerCase()}</span>}
          {r.ownerName && <span className="wc-chip grey">{r.ownerName}</span>}
        </span>
      </span>
    </button>
  );
}

export default function WaChats({ onUnread }) {
  const [sp, setSp] = useSearchParams();
  const [cfg, setCfg] = useState(null);
  const [cfgErr, setCfgErr] = useState('');
  const [f, setF] = useState({ state: 'all', q: '', numberId: '', requirementId: '' });
  const [qLive, setQLive] = useState('');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [lost, setLost] = useState(false);
  const cursor = useRef(0);
  const onUnreadRef = useRef(onUnread);
  onUnreadRef.current = onUnread;

  const chatParam = sp.get('chat') || '';
  const [pt, pid] = chatParam.split(':');
  const sel = pt && pid && AUD[pt] ? { personType: pt, audience: AUD[pt], personId: pid, key: chatParam } : null;
  const selectChat = (r) => { const n = new URLSearchParams(sp); if (r) n.set('chat', r.key); else n.delete('chat'); setSp(n, { replace: true }); };

  const loadCfg = useCallback(() => api.get('/wa-chats/config').then((r) => { setCfg(r.data); setCfgErr(''); }).catch((e) => { if (e.response && e.response.status === 401) setLost(true); setCfgErr(errOf(e, 'Could not open WhatsApp chats.')); }), []);
  useEffect(() => { loadCfg(); }, [loadCfg]);

  const params = useMemo(() => { const p = {}; Object.entries(f).forEach(([k, v]) => { if (v) p[k] = v; }); return p; }, [f]);
  const load = useCallback((quiet = false) => api.get('/wa-chats', { params }).then((r) => {
    setData(r.data); setErr(''); cursor.current = r.data.now;
    if (onUnreadRef.current) onUnreadRef.current(r.data.unreadChats || 0);
  }).catch((e) => {
    if (e.response && e.response.status === 401) setLost(true);
    if (!quiet) setErr(errOf(e, 'Could not open the chats.'));
  }), [params]);
  useEffect(() => { load(); }, [load]);

  // typing in the search box waits a moment
  useEffect(() => { const t = setTimeout(() => setF((x) => (x.q === qLive ? x : { ...x, q: qLive })), 300); return () => clearTimeout(t); }, [qLive]);

  // new replies without a refresh: one small question every 30 seconds; the whole list is read again only when something changed
  useVisiblePoll(async (signal) => {
    const r = await api.get('/wa-chats/changes', { params: { since: cursor.current }, signal });
    if (onUnreadRef.current) onUnreadRef.current(r.data.unreadChats || 0);
    if (r.data.changed > 0) await load(true);
    else cursor.current = r.data.now;
    return true;
  }, 30000, { enabled: !!cfg && !cfgErr && !lost });

  const setFilter = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const onRead = useCallback((key, unreadChats) => {
    setData((d) => (d ? { ...d, rows: markRowRead(d.rows, key), unreadChats: unreadChats != null ? unreadChats : d.unreadChats } : d));
    if (unreadChats != null && onUnreadRef.current) onUnreadRef.current(unreadChats);
  }, []);

  const selRow = sel && data ? data.rows.find((r) => r.key === sel.key) || null : null;
  const isAdmin = !!(cfg && cfg.isAdmin);

  if (lost) return <div className="msg-box red">Your sign-in ended. <Link to="/login">Sign in again</Link> to see your WhatsApp chats.</div>;
  if (cfgErr) return <div className="msg-box red">{cfgErr} <button type="button" className="btn btn-sm" onClick={loadCfg}>Try again</button></div>;
  if (!cfg) return <div className="wc-skel-list" aria-busy="true"><div className="wc-skel wc-skel-row" /><div className="wc-skel wc-skel-row" /><div className="wc-skel wc-skel-row" /></div>;
  if (!cfg.allowed) return <div className="msg-box orange">{cfg.reason || 'Your role does not follow up people on WhatsApp, so there are no chats for you.'}</div>;

  const noNumber = cfg.numbers && !cfg.numbers.legacy && (cfg.numbers.numbers || []).length === 0;
  const counts = (data && data.counts) || {};
  const numbers = (data && data.numbers) || [];
  const reqs = (data && data.requirements) || [];
  const anyFilter = f.state !== 'all' || f.q || f.numberId || f.requirementId;

  return (
    <div className="wc-wrap">
      {cfg.test.mode && <div className="msg-box blue" role="status"><b>Test mode:</b> messages are not really sent, and replies you see may be pretend ones (marked TEST).</div>}
      {!cfg.channel.configured && (
        <div className="msg-box orange" role="alert"><b>WhatsApp is not connected.</b> {cfg.channel.reason || 'Messages cannot be sent yet.'}{isAdmin && <> <Link to="/admin/integrations">Connect it in Integrations</Link>.</>}{!isAdmin && ' Ask the Admin to connect it.'}</div>
      )}
      {noNumber && <div className="msg-box orange" role="alert"><b>No WhatsApp number is assigned to you yet.</b> Ask the Admin.</div>}
      {cfg.channel.configured && !cfg.webhook.seenAt && (
        <div className="msg-box blue">
          {isAdmin
            ? <>Replies arrive only when the WhatsApp webhook is connected. No reply has reached TeamLink yet. Admin: <Link to="/admin/integrations">Integrations &gt; WhatsApp numbers &gt; Reconnect</Link>. On this computer you need the tunnel steps at the bottom of this list.</>
            : 'No WhatsApp reply has reached TeamLink yet. If candidates say they replied, tell the Admin to check the WhatsApp connection.'}
        </div>
      )}
      {cfg.needsReview > 0 && <div className="msg-box orange"><b>{cfg.needsReview}</b> {cfg.needsReview === 1 ? 'reply from a number we do not know is' : 'replies from numbers we do not know are'} waiting. <Link to="/omni-channel/inbox/review">Check them in Needs review</Link>.</div>}

      <div className={`wc${sel ? ' has-open' : ''}`}>
        <aside className="wc-list" aria-label="WhatsApp chats">
          <div className="wc-filters">
            <div className="wc-statechips" role="group" aria-label="Show">
              {STATES.map(([k, label, ck]) => (
                <button key={k} type="button" className={`cv-chip${f.state === k ? ' on' : ''}`} onClick={() => setFilter('state')(k)}>{label}{data ? <em>{counts[ck] != null ? counts[ck] : 0}</em> : null}</button>
              ))}
            </div>
            <input
              className="wc-search" value={qLive} onChange={(e) => setQLive(e.target.value)} aria-label="Search the chats"
              placeholder={cfg.masked ? 'Search a name or a requirement' : 'Search a name, or the last digits of a phone'}
            />
            <div className="wc-selects">
              {numbers.length > 1 && (
                <Combo value={f.numberId} onChange={(e) => setFilter('numberId')(e.target.value)} emptyText="No such number" aria-label="Number">
                  <option value="">All my numbers</option>
                  {numbers.map((n) => <option key={n.id} value={n.id}>{n.label} ({n.count})</option>)}
                </Combo>
              )}
              {reqs.length > 1 && (
                <Combo value={f.requirementId} onChange={(e) => setFilter('requirementId')(e.target.value)} emptyText="No such requirement" aria-label="Requirement">
                  <option value="">All requirements</option>
                  {reqs.map((r) => <option key={r.id} value={r.id}>{r.title}{r.client ? ` · ${r.client}` : ''} ({r.count})</option>)}
                </Combo>
              )}
            </div>
          </div>
          <div className="wc-rows">
            {err && <div className="msg-box red">{err} <button type="button" className="btn btn-sm" onClick={() => load()}>Try again</button></div>}
            {!data && !err && <div className="wc-skel-list" aria-busy="true">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="wc-skel wc-skel-row" />)}</div>}
            {data && data.rows.length === 0 && (
              <div className="wc-empty">
                {anyFilter ? 'No chats match these filters.' : 'No WhatsApp chats yet. When a candidate replies on WhatsApp, the chat appears here by itself.'}
                {anyFilter && <div><button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => { setQLive(''); setF({ state: 'all', q: '', numberId: '', requirementId: '' }); }}>Clear the filters</button></div>}
              </div>
            )}
            {data && data.rows.map((r) => <Row key={r.key} r={r} on={!!sel && sel.key === r.key} onPick={selectChat} />)}
          </div>
          {data && data.total > data.rows.length && <div className="small-muted">Showing the latest {data.rows.length} of {data.total} chats. Use the search to find an older one.</div>}
        </aside>
        <section className="wc-chatcol">
          {sel
            ? <WaChatPane key={sel.key} audience={sel.audience} personId={sel.personId} row={selRow} cfg={cfg} onBack={() => selectChat(null)} onRead={onRead} onChanged={() => load(true)} />
            : <div className="wc-pane wc-none">Pick a chat on the left to read it and answer. The follow-up for that person is on the same screen.</div>}
        </section>
      </div>
      {isAdmin && <WaChatAdmin cfg={cfg} selected={sel ? { audience: sel.audience, personId: sel.personId, name: selRow ? selRow.name : '' } : null} onDone={() => { load(); loadCfg(); }} />}
    </div>
  );
}
