import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Combo from '../Combo.jsx';
import WaChatMedia from './WaChatMedia.jsx';
import WaChatFollowUp from './WaChatFollowUp.jsx';
import { useUsable } from './msgKit.js';
import { useWaSender } from './WaSender.jsx';
import useVisiblePoll from './useVisiblePoll.js';
import {
  groupByDay, mergeMessages, tickOf, windowInfo, composerMode, timeLabel, newSendKey, shouldMarkRead,
} from './waChatLogic.js';

// ---------------------------------------------------------------------------
// ONE WHATSAPP CHAT: the header (who, requirement, step, quick actions), the follow-up strip, the bubbles, and the box to answer.
// Everything that matters is decided by the SERVER (who may see this chat, whether a message may go, the 24-hour rule); this file only shows it.
// New messages arrive by themselves: the open chat asks the server every 10 seconds (only while the page is visible).
// ---------------------------------------------------------------------------
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const EMOJI = ['😊', '🙏', '👍', '😀', '😁', '🙂', '😉', '👌', '👏', '🎉', '✅', '❌', '📞', '📄', '📅', '⏰', '📍', '💼', '🙌', '😅', '😔', '😢', '❤️', '🤝', '🌟', '✨', '👋', '🙂', '💬', '📝', '🔔', '📧'];
const INTENTS = [['interested', 'Interested'], ['not_interested', 'Not interested'], ['call_back', 'Call back']];

function Bubble({ m, tight, masked, onReply }) {
  const out = m.direction === 'out';
  const tick = out ? tickOf(m.state) : null;
  return (
    <div className={`wc-msg ${out ? 'out' : 'in'}${tight ? ' tight' : ''}${m.stop ? ' stop' : ''}${m.test ? ' test' : ''}`}>
      <div className="wc-bubble">
        {m.test && <span className="wc-testtag">TEST</span>}
        {out && m.who && <div className="wc-who">{m.who}{m.waNumber ? ` · ${m.waNumber.label}` : ''}</div>}
        {!out && m.waNumber && <div className="wc-who">to {m.waNumber.label}</div>}
        {(m.media || []).map((x) => <WaChatMedia key={x.id} media={x} />)}
        {m.text && <div className="wc-text">{m.text}</div>}
        {m.stop && <div className="wc-stopnote">They asked us to stop. Nothing more is sent to them on WhatsApp.</div>}
        {out && m.template && <div className="wc-tpl">Template: {m.template}</div>}
        <div className="wc-meta">
          <span>{timeLabel(m.at)}</span>
          {!out && onReply && <button type="button" className="wc-replybtn" onClick={onReply}>↩ Reply</button>}
          {out && <span className={`wc-tick ${tick.tone}`} title={tick.word} aria-label={tick.word}>{tick.glyph}</span>}
        </div>
        {out && m.state === 'failed' && <div className="wc-fail" role="alert">Not delivered: {m.failure || 'WhatsApp could not deliver this message.'}</div>}
      </div>
    </div>
  );
}

function GiveTo({ audience, personId, ownerUserId, onDone }) {
  const [people, setPeople] = useState(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get(`/wa-chats/person/${audience}/${personId}/assignees`).then((r) => setPeople(r.data.people || [])).catch((e) => setErr(errOf(e, 'Could not open the list.')));
  }, [audience, personId]);
  const pick = async (userId) => {
    setBusy(true); setErr('');
    try { await api.post(`/wa-chats/person/${audience}/${personId}/assign`, { userId }); onDone(); } catch (e) { setErr(errOf(e, 'That did not work.')); } finally { setBusy(false); }
  };
  const shown = (people || []).filter((p) => !q || `${p.name} ${p.role} ${p.department || ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="wc-pop" role="group" aria-label="Give this chat to">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type to search a person" aria-label="Search a person" />
      {err && <div className="msg-box red">{err}</div>}
      {!people && !err && <div className="small-muted">Opening the list…</div>}
      <div className="wc-checklist">
        <label className="wc-check"><input type="checkbox" disabled={busy} checked={!ownerUserId} onChange={() => pick(null)} /> Nobody (anyone can pick it up)</label>
        {shown.map((p) => (
          <label key={p.id} className="wc-check">
            <input type="checkbox" disabled={busy} checked={ownerUserId === p.id} onChange={() => pick(p.id)} /> {p.name} <small>{p.role}{p.department ? ` · ${p.department}` : ''}</small>
          </label>
        ))}
        {people && shown.length === 0 && <div className="small-muted">Nobody found in your area.</div>}
      </div>
    </div>
  );
}

function MoveStep({ personId, applicationId, onDone }) {
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState('');
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  useEffect(() => { api.get(`/wa-chats/person/candidates/${personId}/steps`).then((r) => setInfo(r.data)).catch((e) => setErr(errOf(e, 'Could not open the steps.'))); }, [personId]);
  const app = info && (info.applications.find((a) => a.applicationId === applicationId) || info.applications[0]);
  if (err) return <div className="wc-pop"><div className="msg-box red">{err}</div></div>;
  if (!info) return <div className="wc-pop small-muted">Opening…</div>;
  if (!app) return <div className="wc-pop small-muted">This person is not on a requirement.</div>;
  const go = async () => {
    setBusy(true); setErr(''); setDone('');
    try {
      await api.patch(`/applications/${app.applicationId}/stage`, { stage: pick, comment: 'Moved from the WhatsApp chat' });
      setDone('Moved.'); setPick(''); onDone();
    } catch (e) { setErr(errOf(e, 'The move did not work.')); } finally { setBusy(false); }
  };
  return (
    <div className="wc-pop">
      <div className="small-muted">Now: <b>{app.stageLabel}</b> · {app.requirementTitle}</div>
      {app.moves.length === 0 ? <div className="small-muted">You cannot move this person from here.</div> : (
        <>
          <Combo value={pick} onChange={(e) => { setPick(e.target.value); setDone(''); }} emptyText="No such step" placeholder="Pick the new step">
            <option value="">Pick the new step</option>
            {app.moves.map((m) => <option key={m.code} value={m.code}>{m.label}</option>)}
          </Combo>
          <button type="button" className="btn btn-sm btn-primary" disabled={!pick || busy} onClick={go}>{busy ? 'Moving…' : 'Move to this step'}</button>
        </>
      )}
      {done && <div className="msg-box green">{done}</div>}
      {err && <div className="msg-box red">{err}</div>}
      <div className="small-muted">{info.note}</div>
    </div>
  );
}

function AddNote({ personId, applicationId, onDone }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const save = async () => {
    setBusy(true); setMsg(null);
    try { await api.post(`/candidates/${personId}/notes`, { body: text, applicationId: applicationId || undefined }); setText(''); setMsg({ ok: true, text: 'Note saved on the candidate.' }); onDone(); } catch (e) { setMsg({ ok: false, text: errOf(e, 'The note was not saved.') }); } finally { setBusy(false); }
  };
  return (
    <div className="wc-pop">
      <textarea rows={3} className="msg-textarea" value={text} maxLength={2000} placeholder="Write a note for your team (not sent to the candidate)" onChange={(e) => setText(e.target.value)} aria-label="Note" />
      <button type="button" className="btn btn-sm btn-primary" disabled={!text.trim() || busy} onClick={save}>{busy ? 'Saving…' : 'Save note'}</button>
      {msg && <div className={`msg-box ${msg.ok ? 'green' : 'red'}`}>{msg.text}</div>}
    </div>
  );
}

// embedded = inside the candidate's own profile (CandidateConversation.jsx): no name / profile buttons / follow-up strip (the profile has them), just a slim line, the messages and the reply box.
export default function WaChatPane({ audience, personId, row, cfg, onBack, onRead, onChanged, embedded = false }) {
  const isCand = audience === 'candidates';
  const [chat, setChat] = useState(null);
  const [msgs, setMsgs] = useState([]);
  const [err, setErr] = useState('');
  const [lost, setLost] = useState(false);
  const [older, setOlder] = useState({ has: false, busy: false });
  const [pop, setPop] = useState(''); // '' | give | step | note | emoji
  const [headOpen, setHeadOpen] = useState(false); // on a phone the details and actions are folded away
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState(null);
  const [tplPick, setTplPick] = useState('');
  const [tplText, setTplText] = useState('');
  const [quickPick, setQuickPick] = useState('');
  const [fuKey, setFuKey] = useState(0);
  const [newBelow, setNewBelow] = useState(0);
  const cursor = useRef(0);
  const sendKey = useRef(newSendKey());
  const box = useRef(null);
  const stick = useRef(true);
  const known = useRef(new Set());
  const taRef = useRef(null);
  const chatRef = useRef(null);
  const inflight = useRef(false); // a second click in the same moment must not send again (the server also keeps one message per key)
  chatRef.current = chat;
  const usable = useUsable(audience);
  const planned = chat && chat.sender && chat.sender.label ? { label: chat.sender.label, displayNumber: chat.sender.displayNumber } : null;
  const wa = useWaSender(true, planned);

  const base = `/wa-chats/person/${audience}/${personId}`;
  const markRead = useCallback(() => {
    api.post(`${base}/read`, {}).then((r) => { if (onRead) onRead(`${isCand ? 'CANDIDATE' : audience === 'clients' ? 'CLIENT' : 'EMPLOYEE'}:${personId}`, r.data.unreadChats); }).catch(() => {});
  }, [base, onRead, audience, personId, isCand]);

  const open = useCallback(() => {
    setChat(null); setMsgs([]); setErr(''); setLost(false); setPop(''); setText(''); setSendErr(null); setTplPick(''); setTplText(''); setQuickPick(''); setNewBelow(0);
    stick.current = true; known.current = new Set(); sendKey.current = newSendKey();
    return api.get(base).then((r) => {
      setChat(r.data); setMsgs(r.data.messages || []); cursor.current = r.data.cursor; setOlder({ has: !!r.data.hasOlder, busy: false });
      (r.data.messages || []).forEach((m) => known.current.add(m.id));
      if (shouldMarkRead({ visible: document.visibilityState === 'visible', unread: row ? row.unread : 1, newIncoming: false })) markRead();
    }).catch((e) => {
      if (e.response && e.response.status === 401) setLost(true);
      setErr(errOf(e, 'Could not open this chat.'));
    });
  }, [base, markRead]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { open(); }, [open]);

  // new messages arrive by themselves
  useVisiblePoll(async (signal) => {
    const r = await api.get(`${base}/messages`, { params: { since: cursor.current }, signal }).catch((e) => { if (e.response && e.response.status === 401) setLost(true); throw e; });
    const d = r.data;
    cursor.current = d.cursor;
    const fresh = (d.messages || []).filter((m) => !known.current.has(m.id));
    fresh.forEach((m) => known.current.add(m.id));
    const incoming = fresh.some((m) => m.direction === 'in');
    setMsgs((cur) => mergeMessages(cur, d.messages, d.updates));
    setChat((c) => (c ? { ...c, window: d.window || c.window } : c));
    if (d.optedOut !== undefined && chatRef.current && chatRef.current.optedOut !== d.optedOut) open(); // STOP came (or was undone): the whole chat state changes
    if (fresh.length && !stick.current) setNewBelow((n) => n + fresh.length);
    if (shouldMarkRead({ visible: document.visibilityState === 'visible', unread: 0, newIncoming: incoming })) markRead();
    if (incoming && onChanged) onChanged();
    return true;
  }, 10000, { enabled: !!chat && !lost, key: `${audience}:${personId}` });

  // keep the newest message in view (unless the person scrolled up to read)
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs, chat, fuKey]);
  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (stick.current) setNewBelow(0);
  };
  const jumpDown = () => { const el = box.current; if (el) { el.scrollTop = el.scrollHeight; stick.current = true; setNewBelow(0); } };

  const loadOlder = async () => {
    if (!msgs.length) return;
    setOlder((o) => ({ ...o, busy: true }));
    try {
      const r = await api.get(`${base}/messages`, { params: { before: msgs[0].at, limit: 40 } });
      stick.current = false;
      (r.data.messages || []).forEach((m) => known.current.add(m.id));
      setMsgs((cur) => mergeMessages(cur, r.data.messages, []));
      setOlder({ has: !!r.data.hasOlder, busy: false });
    } catch (e) { setErr(errOf(e, 'Could not load earlier messages.')); setOlder((o) => ({ ...o, busy: false })); }
  };

  const mode = composerMode(chat);
  const win = windowInfo(chat && chat.window);
  const masked = !!(chat && chat.masked);
  const templates = useMemo(() => (usable || []).filter((t) => t.channel === 'WhatsApp'), [usable]);
  const approved = useMemo(() => templates.filter((t) => t.waStatus === 'Approved' && t.waTemplateName), [templates]);

  const previewOf = useCallback(async (tplId) => {
    const t = templates.find((x) => x.id === tplId);
    if (!t) return '';
    const r = await api.post('/messaging/preview', {
      audience, ids: [personId], channels: ['WhatsApp'], kind: 'individual', purposeKey: t.purpose, applicationId: (chat && chat.person.applicationId) || undefined,
      waNumberId: wa.numberId, perChannel: { WhatsApp: { templateId: t.id } },
    });
    const first = r.data && r.data.first;
    return first ? (first.text || '') : '';
  }, [templates, audience, personId, chat, wa.numberId]);

  const pickQuick = async (id) => {
    setQuickPick(id);
    if (!id) return;
    try { const t = await previewOf(id); if (t) { setText(t); setTimeout(() => taRef.current && taRef.current.focus(), 30); } } catch (e) { setSendErr({ text: errOf(e, 'Could not prepare that quick reply.') }); }
  };
  const pickTemplate = async (id) => {
    setTplPick(id); setTplText('');
    if (!id) return;
    try { setTplText(await previewOf(id)); } catch (e) { setSendErr({ text: errOf(e, 'Could not prepare that template.') }); }
  };

  const doSend = async (body) => {
    if (inflight.current) return;
    inflight.current = true;
    setSending(true); setSendErr(null);
    try {
      await api.post(`${base}/send`, { ...body, waNumberId: wa.numberId || undefined, applicationId: (chat && chat.person.applicationId) || undefined }, { headers: { 'Idempotency-Key': sendKey.current } });
      sendKey.current = newSendKey(); // the next message is a new one
      setText(''); setQuickPick(''); setTplPick(''); setTplText(''); setPop('');
      stick.current = true;
      // show it at once: look again now and in a moment (the tick comes by itself afterwards)
      [300, 2500].forEach((ms) => setTimeout(() => {
        api.get(`${base}/messages`, { params: { since: cursor.current } }).then((r) => {
          cursor.current = r.data.cursor;
          (r.data.messages || []).forEach((m) => known.current.add(m.id));
          setMsgs((cur) => mergeMessages(cur, r.data.messages, r.data.updates));
          setChat((c) => (c ? { ...c, window: r.data.window || c.window } : c));
        }).catch(() => {});
      }, ms));
      if (onChanged) onChanged();
    } catch (e) {
      const d = (e.response && e.response.data) || {};
      if (e.response && e.response.status === 401) setLost(true);
      setSendErr({ text: d.error || 'The message was not sent.', code: d.code, needsTemplate: !!d.needsTemplate });
      if (d.code === 'OUTSIDE_24H') open();
      if (d.code === 'OPTED_OUT') open();
      sendKey.current = newSendKey();
    } finally { inflight.current = false; setSending(false); }
  };
  // "Reply" on their message: the cursor goes to the reply box (free typing while their 24 hours are open, else the approved-template picker)
  const startReply = () => {
    if (mode.mode === 'text') { if (taRef.current) taRef.current.focus(); return; }
    const el = document.getElementById('wc-tpl'); if (el) { el.scrollIntoView({ block: 'nearest' }); el.focus(); }
  };
  const sendText = () => { const t = text.trim(); if (t) doSend({ text: t }); };
  const sendResume = () => doSend({ attachResume: true, text: text.trim() || undefined });
  const sendTemplate = () => { const t = templates.find((x) => x.id === tplPick); if (t) doSend({ purposeKey: t.purpose, templateId: t.id }); };

  const setIntent = async (key) => {
    const next = chat.intent === key ? null : key;
    try { await api.post(`${base}/intent`, { intent: next }); setChat((c) => ({ ...c, intent: next })); if (onChanged) onChanged(); } catch (e) { setErr(errOf(e, 'The tag was not saved.')); }
  };

  const insertEmoji = (e) => {
    const el = taRef.current;
    const at = el ? el.selectionStart : text.length;
    setText((t) => `${t.slice(0, at)}${e}${t.slice(at)}`);
    setTimeout(() => { if (el) { el.focus(); el.selectionStart = at + e.length; el.selectionEnd = at + e.length; } }, 20);
  };

  if (lost) return <div className="wc-pane"><div className="msg-box red">Your sign-in ended. <Link to="/login">Sign in again</Link> and come back to this chat.</div></div>;
  if (err && !chat) {
    return (
      <div className="wc-pane">
        <button type="button" className="btn btn-sm wc-back" onClick={onBack}>← Back to the chats</button>
        <div className="msg-box red">{err} <button type="button" className="btn btn-sm" onClick={open}>Try again</button></div>
      </div>
    );
  }
  if (!chat) {
    return (
      <div className="wc-pane" aria-busy="true">
        <button type="button" className="btn btn-sm wc-back" onClick={onBack}>← Back to the chats</button>
        <div className="wc-skel wc-skel-head" /><div className="wc-skel wc-skel-bubble" /><div className="wc-skel wc-skel-bubble r" /><div className="wc-skel wc-skel-bubble" />
      </div>
    );
  }

  const p = chat.person;
  const lines = groupByDay(msgs);
  const profile = isCand ? `/candidates/${personId}` : audience === 'clients' ? `/clients/${personId}` : `/employees/${personId}`;
  const showPicker = wa.state && wa.state.mode === 'many';

  return (
    <div className={`wc-pane${embedded ? ' wc-embedded' : ''}`}>
      {embedded && (
        <div className="wc-embedhead">
          {chat.sender.label && <span className="wc-chip grey">From {chat.sender.label}</span>}
          {win.known && <span className={`wc-chip ${win.open ? 'green' : 'amber'}`}>{win.open ? win.short : 'Window closed: templates only'}</span>}
          {chat.owner && <span className="wc-chip grey">Handled by {chat.owner.name}</span>}
          {p.phone ? <a href={`tel:${p.phone}`}>{p.phone}</a> : (p.phoneHint ? <span title="TeamLink dials and writes for you; the number stays hidden">{p.phoneHint}</span> : null)}
          <span className="wc-embed-tags" role="group" aria-label="What did they say?">
            <span className="small-muted">Their answer:</span>
            {INTENTS.map(([k, label]) => <button key={k} type="button" className={`cv-chip${chat.intent === k ? ' on' : ''}`} onClick={() => setIntent(k)}>{label}</button>)}
          </span>
        </div>
      )}
      {!embedded && <div className={`wc-head${headOpen ? ' open' : ''}`}>
        <button type="button" className="btn btn-sm wc-back" onClick={onBack}>← Back to the chats</button>
        <div className="wc-head-main">
          <h3 className="wc-title">{p.name}</h3>
          <div className="wc-sub">
            {row && row.requirement && row.requirement.title ? `${row.requirement.title}${row.requirement.client ? ` · ${row.requirement.client}` : ''}` : (p.department || '')}
            {row && row.step && <span className="wc-chip blue">{row.step.label}</span>}
            {win.known && <span className={`wc-chip ${win.open ? 'green' : 'amber'}`}>{win.open ? win.short : 'Window closed: templates only'}</span>}
          </div>
          <button type="button" className="btn btn-sm wc-more-toggle" aria-expanded={headOpen} onClick={() => setHeadOpen(!headOpen)}>{headOpen ? 'Hide the details' : 'Details and actions'}</button>
          <div className="wc-sub wc-head-more">
            {chat.intent && <span className="wc-chip violet">{(INTENTS.find((i) => i[0] === chat.intent) || [0, chat.intent])[1]}</span>}
            <span className="wc-chip grey">Sending from {chat.sender.label || 'the company number'}</span>
            {chat.owner && <span className="wc-chip grey">Handled by {chat.owner.name}</span>}
          </div>
          <div className="wc-sub wc-head-more">
            {p.phone ? <a href={`tel:${p.phone}`}>{p.phone}</a> : (p.phoneHint ? <span title="TeamLink dials and writes for you; the number stays hidden">{p.phoneHint}</span> : null)}
          </div>
          <div className="wc-tags wc-head-more" role="group" aria-label="What did they say?">
            <span className="small-muted">Their answer:</span>
            {INTENTS.map(([k, label]) => <button key={k} type="button" className={`cv-chip${chat.intent === k ? ' on' : ''}`} onClick={() => setIntent(k)}>{label}</button>)}
          </div>
        </div>
        <div className="wc-head-btns wc-head-more">
          <Link className="btn btn-sm" to={profile}>Open profile</Link>
          {isCand && <button type="button" className={`btn btn-sm${pop === 'step' ? ' btn-primary' : ''}`} onClick={() => setPop(pop === 'step' ? '' : 'step')}>Move step</button>}
          {isCand && <button type="button" className={`btn btn-sm${pop === 'note' ? ' btn-primary' : ''}`} onClick={() => setPop(pop === 'note' ? '' : 'note')}>Add note</button>}
          {cfg && cfg.mayAssign && <button type="button" className={`btn btn-sm${pop === 'give' ? ' btn-primary' : ''}`} onClick={() => setPop(pop === 'give' ? '' : 'give')}>Give to…</button>}
        </div>
      </div>}
      {pop === 'give' && <GiveTo audience={audience} personId={personId} ownerUserId={chat.owner ? chat.owner.userId : null} onDone={() => { setPop(''); open(); if (onChanged) onChanged(); }} />}
      {pop === 'step' && isCand && <MoveStep personId={personId} applicationId={p.applicationId} onDone={() => { setFuKey((k) => k + 1); if (onChanged) onChanged(); }} />}
      {pop === 'note' && isCand && <AddNote personId={personId} applicationId={p.applicationId} onDone={() => setPop('')} />}
      {masked && <div className="msg-box blue">You reach {p.name} through TeamLink: their number and address stay hidden, and numbers written in the chat are covered.</div>}
      {isCand && !embedded && <WaChatFollowUp personId={personId} applicationId={p.applicationId} reloadKey={fuKey} onChanged={onChanged} />}

      <div className="wc-scroll" ref={box} onScroll={onScroll} aria-live="polite" aria-label={`Chat with ${p.name}`}>
        {older.has && <div className="wc-older"><button type="button" className="btn btn-sm" disabled={older.busy} onClick={loadOlder}>{older.busy ? 'Loading…' : 'Show earlier messages'}</button></div>}
        {lines.length === 0 && <div className="wc-empty">No WhatsApp messages yet. Say hello below.</div>}
        {lines.map((l) => (l.kind === 'day'
          ? <div key={`d${l.key}`} className="wc-day"><span>{l.label}</span></div>
          : <Bubble key={l.m.id} m={l.m} tight={l.tight} masked={masked} onReply={startReply} />))}
      </div>
      {newBelow > 0 && <button type="button" className="wc-newpill" onClick={jumpDown}>{newBelow} new {newBelow === 1 ? 'message' : 'messages'} ↓</button>}

      <div className="wc-composer">
        {mode.mode === 'blocked' && <div className="msg-box orange" role="alert"><b>You cannot write here.</b> {mode.reason}</div>}
        {mode.mode === 'template' && chat.canSend && <div className="msg-box orange" role="status">{mode.reason}</div>}
        {wa.state && ['many', 'none', 'down'].includes(wa.state.mode) ? wa.node : null}
        {showPicker && !embedded && chat.sender.label && <div className="small-muted">This chat runs on {chat.sender.label}. Pick another number above only if you want to start from it.</div>}
        {sendErr && <div className="msg-box red" role="alert"><b>Not sent.</b> {sendErr.text}</div>}

        {mode.mode === 'template' && chat.canSend && (
          <div className="wc-tplbox">
            <label htmlFor="wc-tpl">Approved template</label>
            <Combo id="wc-tpl" value={tplPick} onChange={(e) => pickTemplate(e.target.value)} emptyText="No approved template found" placeholder="Type to search a template">
              <option value="">Pick an approved template</option>
              {approved.map((t) => <option key={t.id} value={t.id}>{t.purposeLabel || t.name}{t.language ? ` (${t.language})` : ''}</option>)}
            </Combo>
            {approved.length === 0 && usable && <div className="small-muted">No template is approved by Meta yet. An Admin approves them in Message templates.</div>}
            {tplText && <div className="msg-preview wc-tplprev">{tplText}</div>}
            <div className="wc-send-row">
              <textarea className="msg-textarea" rows={2} disabled placeholder="Free typing opens as soon as they reply (then for 24 hours). Until then pick an approved template above." aria-label="Message (switched off)" />
              <button type="button" className="btn btn-primary" disabled={!tplPick || !tplText || sending} onClick={sendTemplate}>{sending ? 'Sending…' : 'Send template'}</button>
            </div>
          </div>
        )}

        {mode.mode === 'text' && (
          <>
            <div className="wc-toolbar">
              <div className="wc-emoji-wrap">
                <button type="button" className="btn btn-sm wc-emoji-btn" aria-label="Add an emoji" aria-expanded={pop === 'emoji'} onClick={() => setPop(pop === 'emoji' ? '' : 'emoji')}>😊</button>
                {pop === 'emoji' && <div className="wc-emojis" role="group" aria-label="Emoji">{EMOJI.map((e, i) => <button key={`${e}${i}`} type="button" onClick={() => insertEmoji(e)}>{e}</button>)}</div>}
              </div>
              <div className="wc-quick">
                <Combo value={quickPick} onChange={(e) => pickQuick(e.target.value)} emptyText="No quick reply found" placeholder="Quick replies: type to search">
                  <option value="">Quick replies (from Message templates)</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.purposeLabel || t.name}{t.language ? ` (${t.language})` : ''}</option>)}
                </Combo>
              </div>
              {isCand && !masked && <button type="button" className="btn btn-sm" disabled={sending} onClick={sendResume} title="Sends the candidate's own resume file">📎 Send their resume</button>}
            </div>
            <div className="wc-send-row">
              <textarea
                ref={taRef} className="msg-textarea" rows={2} value={text} maxLength={4000} aria-label="Your message"
                placeholder="Write your answer. Enter sends, Shift+Enter makes a new line."
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); sendText(); } }}
              />
              <button type="button" className="btn btn-primary wc-send" disabled={sending || !text.trim() || (wa.state && !wa.canSend)} onClick={sendText}>{sending ? 'Sending…' : 'Send'}</button>
            </div>
          </>
        )}
        {mode.mode === 'blocked' && (
          <div className="wc-send-row"><textarea className="msg-textarea" rows={2} disabled placeholder={mode.reason} aria-label="Message (switched off)" /><button type="button" className="btn btn-primary" disabled>Send</button></div>
        )}
      </div>
    </div>
  );
}
