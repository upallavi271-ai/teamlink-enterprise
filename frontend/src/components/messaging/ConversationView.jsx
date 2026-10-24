import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api';
import ContactDialog from './ContactDialog.jsx';
import ChannelStrip from './ChannelStrip.jsx';
import { useUsable, purposesFor, templateFor, smsInfo, CHANNEL_ICON } from './msgKit.js';
import './messaging.css';
import './conversation.css';
import Combo from '../Combo.jsx';
import { useWaSender } from './WaSender.jsx';

// ---------------------------------------------------------------------------
// ONE PERSON, ONE CONVERSATION — Call, Mail, WhatsApp and SMS in time order, with a reply box.
//
//   <ConversationView audience="candidates" personId name applicationId requirementId onChanged />
//
// Used in four places: the candidate page (Conversation tab), the client page, a follow-up's drawer and the
// Inbox. Whatever the viewer may do comes from the SERVER (GET /conversations/person/…): a viewer who may not see
// the number sees names and hints only ("98••••3210"), the Call button goes through TeamLink, and nothing opens in
// their own app.
// ---------------------------------------------------------------------------

const WORD = { Email: 'Mail', WhatsApp: 'WhatsApp', SMS: 'SMS', Call: 'Call', Best: 'Best channel' };
const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) : '');
const TICK = { sent: 'Sent', delivered: 'Delivered ✓✓', read: 'Read ✓✓', failed: 'Not delivered', replied: 'Reply', call: 'Call saved', opened: 'Opened in own app', asked: 'Asked a colleague', waiting: 'Waiting to send', notsent: 'Not sent' };
const NEXT_WORDS = [['Remind', 'Remind me'], ['WhatsApp', 'Try WhatsApp'], ['SMS', 'Try SMS'], ['Email', 'Try Mail'], ['Call', 'Call them']];

function Bubble({ m }) {
  const cls = m.channel === 'Call' ? 'call' : m.direction;
  return (
    <div className={`cv-msg ${cls}${m.stop ? ' stop' : ''}`}>
      <div className="cv-meta">
        <span className={`cv-badge ${m.channel}`}>{CHANNEL_ICON[m.channel] || ''} {WORD[m.channel] || m.channel}</span>
        <b>{m.direction === 'in' ? 'They wrote' : (m.who || 'TeamLink')}</b>
        <span>{when(m.at)}</span>
        {m.waNumber && <span title={m.waNumber.displayNumber || ''}>· {m.waNumber.label}</span>}
        {m.template && m.direction === 'out' && <span>· {m.template}</span>}
        {m.auto && <span>· automatic ({m.trigger})</span>}
      </div>
      {m.subject && <div className="cv-subject">{m.subject}</div>}
      {m.body && <div className="cv-body">{m.body}</div>}
      <div className={`cv-state ${m.state}`}>
        {m.stop ? 'They asked us to stop. Nothing more is sent on this channel.' : (m.direction === 'out' ? (TICK[m.state] || m.stateWord) : (m.channel === 'Email' ? 'Reply by mail' : `Reply on ${WORD[m.channel] || m.channel}`))}
        {m.direction === 'out' && m.to ? ` · to ${m.to}` : ''}
        {m.state === 'failed' && m.detail ? ` · ${m.detail}` : ''}
      </div>
      {m.note && <div className="cv-note">{m.note}</div>}
      {!m.note && m.detail && /Best channel/.test(m.detail) && <div className="cv-note">{m.detail.slice(m.detail.indexOf('Best channel'))}</div>}
    </div>
  );
}

export default function ConversationView({
  audience = 'candidates', personId, name, applicationId, requirementId, onChanged, compact = false, readOnlyHint = '',
}) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [ch, setCh] = useState('Best');
  const [purpose, setPurpose] = useState(null);
  const [text, setText] = useState('');
  const [subject, setSubject] = useState('');
  const [touched, setTouched] = useState(false);
  const [pv, setPv] = useState(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const [callOpen, setCallOpen] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const [people, setPeople] = useState([]);
  const [pq, setPq] = useState('');
  const [wait, setWait] = useState(false);
  const [waitN, setWaitN] = useState(2);
  const [waitUnit, setWaitUnit] = useState('days');
  const [waitNext, setWaitNext] = useState('Remind');
  const [copied, setCopied] = useState(false);
  const usable = useUsable(audience);
  const lineRef = useRef(null);

  const load = useCallback(() => {
    if (!personId) return;
    api.get(`/conversations/person/${audience}/${personId}`)
      .then((r) => { setData(r.data); setErr(''); })
      .catch((e) => setErr(e.response?.data?.error || 'Could not open this conversation.'));
  }, [audience, personId]);
  useEffect(() => { setData(null); setRes(null); setPurpose(null); setTouched(false); setText(''); setSubject(''); load(); }, [load]);
  useEffect(() => { if (lineRef.current) lineRef.current.scrollTop = lineRef.current.scrollHeight; }, [data]);

  const masked = !!(data && data.mode === 'masked');
  const allowedKeys = data && data.purposes;
  const msgCh = ch === 'Call' ? 'Best' : ch;
  const previewCh = msgCh === 'Best' ? 'SMS' : msgCh;
  // WhatsApp: the company number the reply leaves from (only the numbers the Admin gave this login; an existing chat keeps its own number)
  const wa = useWaSender(ch === 'WhatsApp', pv && pv.waNumber);
  const purposes = useMemo(() => {
    const list = purposesFor(usable, msgCh === 'Best' ? ['Email', 'WhatsApp', 'SMS'] : [msgCh]);
    return allowedKeys ? list.filter((p) => allowedKeys.includes(p.key)) : list;
  }, [usable, msgCh, allowedKeys]);
  const tpl = purpose ? templateFor(usable, purpose, previewCh, 'English') : null;

  // first template of the chosen channel(s), unless the person picked one
  useEffect(() => {
    if (!usable || !data) return;
    // a reply starts as your own words; a role limited to certain templates (Accounts) starts on the first one
    if (purpose === null || (purpose && !purposes.some((p) => p.key === purpose))) setPurpose(allowedKeys && purposes[0] ? purposes[0].key : '');
  }, [usable, purposes, data]); // eslint-disable-line react-hooks/exhaustive-deps

  // the words with this person's real details
  useEffect(() => {
    if (purpose === null || !usable || !data || ch === 'Call') return undefined;
    if (purpose === '' && !text.trim()) { setPv(null); return undefined; } // your own words, nothing typed yet
    const t = setTimeout(() => {
      const own = purpose === '' || touched;
      api.post('/messaging/preview', {
        audience, ids: [personId], channels: [previewCh], kind: 'individual', purposeKey: purpose || undefined, applicationId, requirementId, purpose: purpose === '' ? 'Message' : undefined, waNumberId: previewCh === 'WhatsApp' ? wa.numberId : undefined,
        perChannel: { [previewCh]: { templateId: tpl ? tpl.id : undefined, ...(own ? { subject: subject || 'Message', body: text } : {}) } },
      }).then((r) => {
        setPv(r.data);
        const f = r.data.first;
        if (f && !touched && purpose !== '') { setText(f.text || ''); setSubject(f.subject || ''); }
      }).catch((e) => setPv({ error: e.response?.data?.error || 'Could not prepare the words.' }));
    }, 250);
    return () => clearTimeout(t);
  }, [audience, personId, previewCh, purpose, tpl && tpl.id, touched, touched ? text : '', usable, data && data.mode, ch, wa.numberId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function send() {
    setBusy(true); setRes(null); setCopied(false);
    try {
      const own = purpose === '' || touched;
      const body = {
        audience, id: personId, channel: ch, applicationId, requirementId, purposeKey: purpose || undefined, purpose: purpose === '' ? 'Message' : undefined, waNumberId: ch === 'WhatsApp' ? wa.numberId : undefined,
      };
      if (ch === 'Best') { if (own) { body.body = text; body.subject = subject || 'Message'; body.purposeKey = undefined; body.purpose = 'Message'; } } else {
        body.perChannel = { [ch]: { templateId: tpl ? tpl.id : undefined, ...(own ? { subject: subject || 'Message', body: text } : {}) } };
      }
      if (wait) body.awaitReply = { value: waitN, unit: waitUnit, next: waitNext };
      const r = await api.post('/conversations/send', body);
      setRes(r.data);
      if (r.data.ok) { setTouched(false); load(); if (onChanged) onChanged(); }
    } catch (e) { setRes({ ok: false, error: e.response?.data?.error || 'The message could not be sent.' }); } finally { setBusy(false); }
  }

  async function act(path, payload) {
    try { await api.post(`/conversations/person/${audience}/${personId}/${path}`, payload || {}); load(); if (onChanged) onChanged(); } catch (e) { setErr(e.response?.data?.error || 'That did not work.'); }
  }
  async function openPicker() {
    setPickOpen(!pickOpen);
    if (!people.length) {
      const r = await api.get('/conversations/assignees', { params: { audience, id: personId } }).catch(() => null);
      if (r) setPeople(r.data.people || []);
    }
  }
  async function askColleague(channel) {
    try {
      const r = await api.post('/conversations/request-contact', { audience, id: personId, channel, applicationId });
      setRes({ ok: true, asked: r.data.message });
      load();
    } catch (e) { setRes({ ok: false, error: e.response?.data?.error || 'Could not ask.' }); }
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(res && res.fallback ? `${res.fallback.subject ? `${res.fallback.subject}\n\n` : ''}${res.fallback.text}` : text); setCopied(true); } catch { setCopied(false); }
  };

  if (err && !data) return <div className="msg-box red">{err}</div>;
  if (!data) return <div className="small-muted">Opening the conversation…</div>;
  const t = data.thread || {};
  const strip = data.channels;
  const connected = (c) => (c === 'Best' ? true : (strip[c] ? strip[c].configured : false));
  const sms = ch === 'SMS' || (ch === 'Best' && false) ? smsInfo(text) : null;
  const callGw = strip && strip.Call && strip.Call.configured;
  const filteredPeople = people.filter((p) => !pq || `${p.name} ${p.role} ${p.department || ''}`.toLowerCase().includes(pq.toLowerCase()));

  return (
    <div className="cv">
      <div className="cv-head">
        <div>
          <h3>{name || data.person.name}</h3>
          <div className="cv-sub">
            {data.person.department ? `${data.person.department} · ` : ''}
            {t.ownerName ? `Handled by ${t.ownerName}` : 'Nobody handles this yet'}
            {t.done ? ` · Done${t.doneBy ? ` by ${t.doneBy}` : ''}` : ''}
            {t.waitUntil ? ` · Waiting for a reply until ${when(t.waitUntil)}` : ''}
          </div>
        </div>
        <div className="cv-actions">
          <button type="button" className="btn btn-sm" onClick={() => act('done', { done: !t.done })}>{t.done ? 'Open again' : 'Mark done'}</button>
          <button type="button" className="btn btn-sm" onClick={openPicker}>Give to…</button>
          {t.unread > 0 && <button type="button" className="btn btn-sm" onClick={() => act('read')}>Mark read</button>}
        </div>
      </div>
      {pickOpen && (
        <div className="cv-pick">
          <input value={pq} onChange={(e) => setPq(e.target.value)} placeholder="Search a person" aria-label="Search a person" />
          <div className="cv-pick-list">
            {filteredPeople.length === 0 && <span className="small-muted">Nobody found in your area.</span>}
            <button type="button" className="msg-chip" onClick={() => { act('assign', { userId: null }); setPickOpen(false); }}>Nobody</button>
            {filteredPeople.map((p) => (
              <button key={p.id} type="button" className={`msg-chip${t.ownerUserId === p.id ? ' on' : ''}`} onClick={() => { act('assign', { userId: p.id }); setPickOpen(false); }}>{p.name} · {p.role}</button>
            ))}
          </div>
        </div>
      )}
      {!compact && <ChannelStrip channels={strip} />}
      {masked && (
        <div className="msg-box blue">You reach {name || data.person.name} through TeamLink. Their number{data.hints.phone ? ` (${data.hints.phone})` : ''} and address stay hidden: the server fills in the message and sends it for you.</div>
      )}
      {data.person.doNotContact && <div className="msg-box red">This person asked not to be contacted. Nothing can be sent.</div>}
      {!masked && (
        <div className="cv-pref">
          <span>They like to be reached on:</span>
          {['Email', 'WhatsApp', 'SMS', 'Call'].map((c) => (
            <button key={c} type="button" className={`cv-chip${t.preferredChannel === c ? ' on' : ''}`} onClick={() => act('preferred', { channel: t.preferredChannel === c ? null : c })}>{WORD[c]}</button>
          ))}
        </div>
      )}

      <div className="cv-line" ref={lineRef} aria-live="polite">
        {data.timeline.length === 0 && <div className="cv-empty">Nothing yet. Say hello below.</div>}
        {data.timeline.map((m) => <Bubble key={m.id} m={m} />)}
      </div>
      {!data.mailboxConnected && data.timeline.some((m) => m.channel === 'Email') && (
        <div className="small-muted" style={{ marginTop: 4 }}>Only the mail we sent is shown. Connect an inbox to see replies.</div>
      )}

      {readOnlyHint && <div className="small-muted" style={{ marginTop: 6 }}>{readOnlyHint}</div>}
      {!data.person.doNotContact && (
        <div className="cv-reply">
          <div className="cv-chans" role="group" aria-label="How to reach them">
            {['Best', 'Email', 'WhatsApp', 'SMS', 'Call'].map((c) => (
              <button
                key={c} type="button" className={`cv-chan${ch === c ? ' on' : ''}${c === 'Best' ? ' best' : ''}`}
                onClick={() => { if (c === 'Call') { setCallOpen(true); } else { setCh(c); setRes(null); setTouched(false); } }}
              >
                <span>{c === 'Best' ? '✨ ' : `${CHANNEL_ICON[c]} `}{WORD[c]}</span>
                <small>{c === 'Best' ? 'Tries the best way' : c === 'Call' ? (callGw ? 'Through TeamLink' : (masked ? 'Ask a colleague' : 'Phone link')) : (connected(c) ? 'Sends from here' : (masked ? 'Not connected' : 'Not connected'))}</small>
              </button>
            ))}
          </div>
          {ch === 'WhatsApp' && wa.node}
          <div className="field">
            <label htmlFor="cv-tpl">Template</label>
            <Combo id="cv-tpl" value={purpose === null ? '' : (purpose === '' ? '__own' : purpose)} onChange={(e) => { setPurpose(e.target.value === '__own' ? '' : e.target.value); setTouched(false); setRes(null); }}>
              {purposes.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              {!allowedKeys && <option value="__own">Write my own message</option>}
            </Combo>
          </div>
          {msgCh !== 'WhatsApp' && (msgCh === 'Email' || msgCh === 'Best') && (
            <div className="field"><label htmlFor="cv-sub">Subject</label>
              <input id="cv-sub" value={subject} maxLength={200} onChange={(e) => { setSubject(e.target.value); setTouched(true); }} />
            </div>
          )}
          <div className="field">
            <label htmlFor="cv-body">Message{ch === 'Best' && purpose ? ' (shown as the SMS wording; each way uses its own template)' : ''}</label>
            <textarea id="cv-body" className="msg-textarea" rows={compact ? 4 : 5} value={text} placeholder={purpose === '' ? 'Type your message here.' : ''} onChange={(e) => { setText(e.target.value); setTouched(true); }} />
            {sms && <div className="msg-count">{sms.chars} letters = {sms.segments} SMS part(s)</div>}
          </div>
          {pv && pv.error && <div className="msg-box red">{pv.error}</div>}
          {pv && pv.first && pv.first.status !== 'queued' && ch !== 'Best' && (
            <div className="msg-box orange"><b>{pv.first.status === 'blocked' ? 'Cannot send from here.' : 'Cannot send yet.'}</b> {pv.first.reason}</div>
          )}
          {pv && pv.first && (pv.first.missing || []).length > 0 && <div className="msg-box orange">Not on this profile yet: {pv.first.missing.join(', ')}. Replace them in the message by hand.</div>}
          <div className="cv-wait">
            <label><input type="checkbox" style={{ width: 'auto' }} checked={wait} onChange={(e) => setWait(e.target.checked)} /> If there is no reply in</label>
            <input type="number" min="1" max="60" value={waitN} disabled={!wait} onChange={(e) => setWaitN(e.target.value)} aria-label="How many" />
            {['hours', 'days'].map((u) => <button key={u} type="button" disabled={!wait} className={`cv-chip${waitUnit === u ? ' on' : ''}`} onClick={() => setWaitUnit(u)}>{u === 'hours' ? 'hours' : 'days'}</button>)}
            <span>then</span>
            {NEXT_WORDS.map(([k, label]) => <button key={k} type="button" disabled={!wait} className={`cv-chip${waitNext === k ? ' on' : ''}`} onClick={() => setWaitNext(k)}>{label}</button>)}
          </div>

          {res && res.ok && !res.asked && (
            <div className="msg-box green">
              <b>{res.stillSending ? 'Sending…' : 'Sent'}</b> on {WORD[res.channel]}{res.result && res.result.address ? ` to ${res.result.address}` : ''}.
              {res.result && res.result.sandbox && <div>This is the test copy of TeamLink: nothing was really sent.</div>}
              {res.waiting && <div>We will remind you if nothing comes back by {when(res.waiting.until)}.</div>}
              {(res.attempts || []).filter((a) => a.status !== 'sent' && a.status !== 'sending').length > 0 && (
                <ul className="cv-attempts">
                  {res.attempts.filter((a) => a.status !== 'sent' && a.status !== 'sending').map((a) => <li key={a.channel}>{WORD[a.channel]} was not used: {a.reason || a.status}</li>)}
                </ul>
              )}
            </div>
          )}
          {res && res.asked && <div className="msg-box green">{res.asked}</div>}
          {res && res.ok === false && (
            <div className="msg-box red">
              <b>Not sent.</b> {res.error}
              {(res.attempts || []).length > 0 && (
                <ul className="cv-attempts">{res.attempts.map((a) => <li key={a.channel}>{WORD[a.channel]}: {a.reason || a.status}</li>)}</ul>
              )}
              {res.fallback && (
                <div style={{ marginTop: 6 }}>
                  <div className="msg-sent-text">{res.fallback.text}</div>
                  <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={copy}>{copied ? 'Copied' : 'Copy the message'}</button>
                  {res.fallback.canOpenOwnApp && data.has.email && <span className="small-muted"> or open it from the Mail / WhatsApp button of the Contact window.</span>}
                  {masked && <button type="button" className="btn btn-sm" style={{ marginLeft: 6 }} onClick={() => askColleague(ch === 'Best' ? 'WhatsApp' : ch)}>Ask a colleague to send it</button>}
                </div>
              )}
            </div>
          )}
          <div className="cv-actions" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-primary" disabled={busy || !text.trim() || (pv && pv.first && (pv.first.missing || []).length > 0 && !touched) || (ch === 'WhatsApp' && !wa.canSend)} onClick={send}>
              {busy ? 'Sending…' : (ch === 'Best' ? 'Send on the best channel' : `Send ${WORD[ch]}`)}
            </button>
          </div>
        </div>
      )}
      {callOpen && (
        <ContactDialog
          channel="Call" audience={audience} personId={personId} name={name || data.person.name}
          email={masked ? undefined : ''} phone={masked ? undefined : undefined}
          applicationId={applicationId} requirementId={requirementId}
          onClose={() => setCallOpen(false)} onLogged={() => { load(); if (onChanged) onChanged(); }}
        />
      )}
    </div>
  );
}
