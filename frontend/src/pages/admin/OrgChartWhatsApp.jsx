import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Combo from '../../components/Combo.jsx';
import Modal from '../../components/Modal.jsx';
import WaChatPane from '../../components/messaging/WaChatPane.jsx';
import ConversationView from '../../components/messaging/ConversationView.jsx';
import useVisiblePoll from '../../components/messaging/useVisiblePoll.js';
import { listTime, tickOf, markRowRead } from '../../components/messaging/waChatLogic.js';
import '../../components/messaging/conversation.css';
import '../../components/messaging/messaging.css';
import '../../components/messaging/waChats.css';

// ---------------------------------------------------------------------------
// ORGANIZATION CHART -> WHATSAPP (founder 2026-11-18: "on the organization chart, like the Green Start WhatsApp screen"): the chats with the
// company's people on ONE screen - the chats on the left (latest first, unread in bold, ticks on what you sent), the open chat on the right with what
// was sent and what they answered, and the box to write. Same chat, same rules as the candidate profile and Follow-ups > WhatsApp chats (WaChatPane,
// /api/wa-chats): the server decides who may be contacted, the 24-hour rule, templates, STOP. Nothing is copied or kept here. "Start a chat" picks
// anybody on the chart; the Message button on the chart opens this screen on that person.
// ---------------------------------------------------------------------------
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const initials = (n) => String(n || '?').replace(/\(.*\)/g, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
const STATES = [['all', 'All', 'all'], ['unread', 'Unread', 'unread'], ['needsReply', 'Needs reply', 'needsReply']];

function Row({ r, on, onPick }) {
  const tick = r.last && r.last.direction === 'out' && r.last.state ? tickOf(r.last.state) : null;
  return (
    <button type="button" className={`wc-row${r.unread > 0 ? ' unread' : ''}${on ? ' on' : ''}`} onClick={() => onPick(r)} aria-current={on ? 'true' : undefined}>
      <span className="wc-avatar" aria-hidden="true">{initials(r.name)}</span>
      <span className="wc-rowmain">
        <span className="wc-rowtop"><b className="wc-name">{r.name}</b><small className="wc-time">{r.fresh ? 'new' : listTime(r.last.at)}</small></span>
        {r.department && <span className="wc-req">{r.department}</span>}
        <span className="wc-prev">
          {tick && <span className={`wc-tick ${tick.tone}`} aria-label={tick.word}>{tick.glyph}</span>}
          <span className="wc-prevtext">{r.fresh ? 'No messages yet. Say hello.' : `${r.last.direction === 'out' ? 'You: ' : ''}${r.last.text || '(no words)'}`}</span>
          {r.unread > 0 && <span className="wc-badge" aria-label={`${r.unread} new`}>{r.unread}</span>}
        </span>
      </span>
    </button>
  );
}

export default function OrgChartWhatsApp({ people, personId, onSelect, onUnread }) {
  const [cfg, setCfg] = useState(null);
  const [cfgErr, setCfgErr] = useState('');
  const [state, setState] = useState('all');
  const [qLive, setQLive] = useState('');
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [lost, setLost] = useState(false);
  const [other, setOther] = useState(null); // the one-person conversation (Call, Mail, SMS) in a window
  const cursor = useRef(0);
  const onUnreadRef = useRef(onUnread);
  onUnreadRef.current = onUnread;

  const loadCfg = useCallback(() => api.get('/wa-chats/config').then((r) => { setCfg(r.data); setCfgErr(''); }).catch((e) => {
    if (e.response && e.response.status === 401) setLost(true);
    setCfgErr(errOf(e, 'Could not open WhatsApp chats.'));
  }), []);
  useEffect(() => { loadCfg(); }, [loadCfg]);

  const params = useMemo(() => ({ type: 'EMPLOYEE', ...(state !== 'all' ? { state } : {}), ...(q ? { q } : {}) }), [state, q]);
  const load = useCallback((quiet = false) => api.get('/wa-chats', { params }).then((r) => {
    setData(r.data); setErr(''); cursor.current = r.data.now;
    if (onUnreadRef.current) onUnreadRef.current(r.data.unreadChats || 0);
  }).catch((e) => {
    if (e.response && e.response.status === 401) setLost(true);
    if (!quiet) setErr(errOf(e, 'Could not open the chats.'));
  }), [params]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setTimeout(() => setQ(qLive.trim()), 300); return () => clearTimeout(t); }, [qLive]);

  // new replies without a refresh: one small question every 30 seconds; the list is read again only when something changed
  useVisiblePoll(async (signal) => {
    const r = await api.get('/wa-chats/changes', { params: { since: cursor.current }, signal });
    if (r.data.changed > 0) await load(true); else cursor.current = r.data.now;
    return true;
  }, 30000, { enabled: !!cfg && !cfgErr && !lost });

  const onRead = useCallback((key, unreadChats) => {
    setData((d) => (d ? { ...d, rows: markRowRead(d.rows, key), unreadChats: unreadChats != null ? unreadChats : d.unreadChats } : d));
    if (unreadChats != null && onUnreadRef.current) onUnreadRef.current(unreadChats);
  }, []);

  const who = personId ? (people || []).find((p) => p.id === personId) : null;
  const key = personId ? `EMPLOYEE:${personId}` : null;
  const rows = useMemo(() => {
    const list = (data && data.rows) || [];
    // somebody picked on the chart who has no chat yet: a row of their own at the top, so the screen shows who is open
    if (key && !list.some((r) => r.key === key)) {
      return [{ key, personId, name: who ? who.name : 'This person', department: who ? who.department : null, unread: 0, fresh: true, last: { at: Date.now(), direction: 'out', state: '', text: '' } }, ...list];
    }
    return list;
  }, [data, key, personId, who]);
  const selRow = key ? rows.find((r) => r.key === key) : null;
  const picks = useMemo(() => (people || []).filter((p) => !p.isViewer && p.messageable !== false), [people]);

  if (lost) return <div className="msg-box red">Your sign-in ended. <Link to="/login">Sign in again</Link> to see the chats.</div>;
  if (cfgErr) return <div className="msg-box red">{cfgErr} <button type="button" className="btn btn-sm" onClick={loadCfg}>Try again</button></div>;
  if (!cfg) return <div className="wc-skel-list" aria-busy="true"><div className="wc-skel wc-skel-row" /><div className="wc-skel wc-skel-row" /><div className="wc-skel wc-skel-row" /></div>;
  if (!cfg.allowed) return <div className="msg-box orange">{cfg.reason || 'Your role does not contact people on WhatsApp, so there are no chats for you.'}</div>;

  const isAdmin = !!cfg.isAdmin;
  const noNumber = cfg.numbers && !cfg.numbers.legacy && (cfg.numbers.numbers || []).length === 0;
  const counts = (data && data.counts) || {};
  const anyFilter = state !== 'all' || q;
  const firstName = (selRow ? selRow.name : who ? who.name : '').split(' ')[0];

  return (
    <div>
      {cfg.test && cfg.test.mode && <div className="msg-box blue" role="status"><b>Test mode:</b> messages are not really sent.</div>}
      {cfg.channel && !cfg.channel.configured && (
        <div className="msg-box orange" role="alert"><b>WhatsApp is not connected.</b> {cfg.channel.reason || 'Messages cannot be sent yet.'}{isAdmin && <> <Link to="/admin/integrations">Connect it in Integrations</Link>.</>}{!isAdmin && ' Ask the Admin to connect it.'}</div>
      )}
      {noNumber && <div className="msg-box orange" role="alert"><b>No WhatsApp number is assigned to you yet.</b> Ask the Admin.</div>}

      <div className={`ocw${key ? ' has-open' : ''}`}>
        <aside className="ocw-list" aria-label="WhatsApp chats">
          <div className="ocw-bar">
            <span className="ocw-title">💬 WhatsApp</span>
            <span className="ocw-sub">People of the company</span>
            <button type="button" className="ocw-ic" title="Refresh the chats" aria-label="Refresh the chats" onClick={() => { load(); }}>↻</button>
          </div>
          <div className="ocw-tools">
            <div className="ocw-tabs" role="group" aria-label="Show">
              {STATES.map(([k, label, ck]) => (
                <button key={k} type="button" className={state === k ? 'on' : ''} onClick={() => setState(k)}>{label}{data ? <em>{counts[ck] != null ? counts[ck] : 0}</em> : null}</button>
              ))}
            </div>
            <input className="ocw-search" value={qLive} onChange={(e) => setQLive(e.target.value)} placeholder="Search a name" aria-label="Search the chats" />
            <div className="ocw-start">
              <Combo value="" onChange={(e) => { if (e.target.value) onSelect(e.target.value); }} emptyText="Nobody with that name" placeholder="Start a chat: type a name" aria-label="Start a chat with">
                <option value="">Start a chat: type a name</option>
                {picks.map((p) => <option key={p.id} value={p.id}>{p.name}{p.department ? ` · ${p.department}` : ''}</option>)}
              </Combo>
            </div>
          </div>
          <div className="ocw-rows">
            {err && <div className="msg-box red">{err} <button type="button" className="btn btn-sm" onClick={() => load()}>Try again</button></div>}
            {!data && !err && <div className="wc-skel-list" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="wc-skel wc-skel-row" />)}</div>}
            {data && rows.length === 0 && (
              <div className="wc-empty">
                {anyFilter ? 'No chats match.' : 'No WhatsApp chats with your people yet. Use "Start a chat" above, or press Message on the chart. When they answer, the chat shows here by itself.'}
                {anyFilter && <div><button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => { setQLive(''); setQ(''); setState('all'); }}>Clear the filters</button></div>}
              </div>
            )}
            {data && rows.map((r) => <Row key={r.key} r={r} on={key === r.key} onPick={(x) => onSelect(x.personId)} />)}
          </div>
          {data && data.total > data.rows.length && <div className="small-muted" style={{ padding: '4px 10px' }}>Showing the latest {data.rows.length} of {data.total} chats. Search to find an older one.</div>}
        </aside>

        <section className="ocw-chat">
          {key ? (
            <>
              <div className="ocw-other">
                <span className="small-muted">Want to call or mail {firstName || 'them'} instead?</span>
                <button type="button" className="btn btn-sm" onClick={() => setOther({ id: personId, name: selRow ? selRow.name : (who ? who.name : '') })}>Call · Mail · SMS</button>
              </div>
              <WaChatPane key={key} audience="employees" personId={personId} row={selRow && !selRow.fresh ? selRow : null} cfg={cfg} hideIntent onBack={() => onSelect(null)} onRead={onRead} onChanged={() => load(true)} />
            </>
          ) : (
            <div className="ocw-none">
              <div className="ocw-none-ic" aria-hidden="true">💬</div>
              <b>Pick a chat on the left</b>
              <span>to read what was sent and what they answered, and to write.<br />Or press Message on the chart, or Start a chat above.</span>
            </div>
          )}
        </section>
      </div>

      {other && (
        <Modal title={`Call, Mail or SMS · ${other.name}`} size="wide" onClose={() => setOther(null)}>
          <ConversationView audience="employees" personId={other.id} name={other.name} />
        </Modal>
      )}
    </div>
  );
}
