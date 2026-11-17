import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../../api';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { Btn, TinyBtn, Pill, Tag, ConfirmModal, Empty, fmtDateTime } from '../ui.jsx';
import SenderPick from '../marketing/SenderPick.jsx';
import '../marketing/marketing.css';
import './mkMeeting.css';

// AI MARKETING > CLIENT PROJECTS > PLANS MEETING: the team's dashboard. The team makes a link for a client (name, WhatsApp number, language) and sends it on WhatsApp from TeamLink. The client opens it on their phone:
// an automated assistant shows the plans slide by slide and speaks them in English, Telugu or Hindi, answers questions from a fixed list, and takes a callback request. This page shows who opened it, how far they
// watched, what they asked and who wants a call: the clients waiting for a call are on top with a CALL button (TeamLink rings your phone first, then the client, on the line you pick), and the person who made the
// link also gets a bell and, when switched on, a WhatsApp. Making a link, the calling line and the alert are in the narrow column on the right. Nothing is sent or dialled until a person presses a button.
// Server: marketing/meeting.js. The client's page: components/omni/marketing/PlansMeetingPage.jsx.
const LANG = { en: 'English', te: 'తెలుగు', hi: 'हिन्दी' };
const TONE = { Hot: 'red', Warm: 'warn', Cold: 'draft', 'Not opened': 'draft' };
const CHOICE = { trial: 'wants the ₹999 trial', starter: 'chose Starter', growth: 'chose Growth', premium: 'chose Premium', team: 'asked for a call' };
const WINDOW = { asap: 'as soon as possible', morning: 'morning (9 to 12)', afternoon: 'afternoon (12 to 4)', evening: 'evening (4 to 7)' };
const linkOf = (m) => `${window.location.origin}/m/${m.id}`; // the short address: it opens the full link behind it
const telOf = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length === 10 ? `+91${d}` : `+${d}`; }; // opens the phone's own dialler
const waiting = (m) => !!m.handoverAt && (!m.calledAt || m.calledAt < m.handoverAt); // asked for a call and nobody has called since
const FILTERS = [['waiting', 'Waiting for your call'], ['Hot', 'Hot'], ['Warm', 'Warm'], ['Cold', 'Cold'], ['Not opened', 'Not opened']];

function Row({ m, busy, note, onSend, onCopy, onDelete, onCall, onDial }) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState(null);
  const [numberId, setNumberId] = useState('');
  const asked = m.questions || [];
  const wants = waiting(m);
  const progress = m.maxSlide ? `slide ${m.maxSlide + 1} of ${m.slides}${m.finishedAt ? ' (finished)' : ''}` : (m.views ? 'opened, not started' : 'not opened yet');
  const who = m.name || (m.source === 'open' ? 'Opened without a link' : 'No name');
  return (
    <div className={`mkm-row${wants ? ' wants' : ''}`}>
      <span className="mkm-av" aria-hidden="true">{(m.name || '?').slice(0, 1)}</span>
      <div style={{ minWidth: 0 }}>
        <div className="mkm-name">
          <button type="button" onClick={() => setOpen(!open)}>{who}</button>
          <Pill tone={TONE[m.interest]} dot>{m.interest}</Pill>{wants ? <Pill tone="red">📞 Wants a call</Pill> : null}<Tag>{LANG[m.language] || m.language}</Tag>{m.source === 'inbound' || m.source === 'website' ? <Tag title="TeamLink offered this demo by itself, to a new person who wrote to us">{m.source === 'website' ? 'From the website' : 'From WhatsApp'}</Tag> : null}{m.sentAt ? <Tag green title="Sent from TeamLink">Sent</Tag> : null}{m.inCrm ? <Tag green title="This client is a lead in the CRM (Sales CRM > Leads)">In CRM</Tag> : null}
        </div>
        <div className="mkm-meta">
          {m.phone || 'no number yet'} · {progress}{m.views ? ` · opened ${m.views}×, last ${fmtDateTime(m.lastOpenedAt)}` : ''} · made by {m.createdByName || 'a visitor'}
          {m.choice ? <div><b>{CHOICE[m.choice]}{m.callbackWindow ? `: call ${m.callbackWindow === 'slot' ? `at ${m.slotText} (India time)` : (WINDOW[m.callbackWindow] || m.callbackWindow)}` : ''}{m.handoverAt ? ` (asked ${fmtDateTime(m.handoverAt)})` : ''}</b></div> : null}
          {m.slotAt && wants ? <div style={m.slotAt < Date.now() ? { color: '#b91c1c', fontWeight: 700 } : { color: '#9a5b00', fontWeight: 700 }}>📅 Call at {m.slotText}{m.slotAt < Date.now() ? ' (this time has passed: call now)' : ''}</div> : null}
          {m.calledAt ? <div style={{ color: m.calledAt >= (m.handoverAt || 0) ? '#166534' : undefined }}>Called {fmtDateTime(m.calledAt)} by {m.calledByName || 'the team'}{m.callLine ? ` on the ${String(m.callLine).toUpperCase()} line` : ''}</div> : null}
          {asked.length ? <div>Asked: {asked.slice(-2).map((x) => `“${x.q}”`).join(', ')}{asked.length > 2 ? ` and ${asked.length - 2} more` : ''}</div> : null}
        </div>
      </div>
      <div className="mkm-acts">
        {m.phone ? <button type="button" className={`mkm-call${wants ? '' : ' soft'}`} disabled={!!busy} onClick={() => onCall(m)} title="TeamLink rings YOUR phone first, then connects the client, on the line picked on the right">{busy === `call${m.id}` ? 'Calling…' : '📞 Call now'}</button> : null}
        {m.phone ? <a href={`tel:${telOf(m.phone)}`} onClick={() => onDial(m)} className="tiny-btn" style={{ textDecoration: 'none' }} title="Copies the number and tries to open your dialler (a phone does; a computer needs a calling app such as Phone Link)">Dial it myself</a> : null}
        <TinyBtn onClick={() => setOpen(!open)}>{open ? 'Close' : 'Open'}</TinyBtn>
      </div>
      {note ? <div className={`mkm-note${note.tone === 'ok' ? ' ok' : ''}`} role="status">{note.text}</div> : null}
      {open ? (
        <div className="mkm-more">
          {m.note ? <div>Your note: {m.note}</div> : null}
          <div className="lab">THE LINK</div>
          <input readOnly value={linkOf(m)} onFocus={(e) => e.target.select()} aria-label="The meeting link" />
          <div className="lab">CLIENT'S WHATSAPP NUMBER</div>
          <input value={phone != null ? phone : (m.phone || '')} maxLength={30} inputMode="tel" placeholder="+91…" onChange={(e) => setPhone(e.target.value)} aria-label="The client's WhatsApp number" />
          <SenderPick value={numberId} onChange={setNumberId} disabled={!!busy} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            <Btn small primary disabled={!!busy} onClick={() => onSend(m, { numberId, phone })}>{busy === `send${m.id}` ? 'Sending…' : (m.sentAt ? 'Send again on WhatsApp' : 'Send on WhatsApp from TeamLink')}</Btn>
            <Btn small onClick={() => onCopy(m)}>⧉ Copy link</Btn>
            <Btn small danger disabled={!!busy} onClick={() => onDelete(m)}>Remove</Btn>
          </div>
          {asked.length ? (
            <div>
              <div className="lab">EVERYTHING THEY ASKED</div>
              {asked.map((x, i) => <div key={i}>• {x.q}{x.id ? <span style={{ color: 'var(--muted)' }}> (answered {x.id})</span> : <span style={{ color: '#b45309' }}> (no answer found: call them)</span>}</div>)}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function MkMeetingPage() {
  const { toast } = useOmni();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [f, setF] = useState({ name: '', phone: '', language: 'en', note: '' });
  const [spots, setSpots] = useState(null);
  const [ask, setAsk] = useState(null);
  const [filter, setFilter] = useState('');
  const [lines, setLines] = useState(null); // the call lines (utils/callLines.js): API, Dinstar, SIP
  const [callLine, setCallLine] = useState('');
  const [notes, setNotes] = useState({}); // what the last Call now / Dial it myself did, kept next to that client's buttons (a toast, or a message at the top of a long page, is easy to miss)
  const [al, setAl] = useState(null); // { on, phone } being edited for the alert
  const [ed, setEd] = useState(null); // the answer being written: { id, q, answer: { en, te, hi }, keywords }
  const [au, setAu] = useState(null); // the automatic demo being edited: { on, website, numberIds } (an Admin's switch: marketing/meetingOffer.js)
  const timer = useRef(null);
  const load = useCallback(() => omni.get('/gs/marketing/meetings').then((x) => { setD(x); setSpots((cur) => (cur == null ? x.settings.spotsLeft : cur)); setAl((cur) => cur || { on: x.alert.on, phone: x.alert.phone }); setAu((cur) => cur || { on: x.offer.on, website: x.offer.website, numberIds: x.offer.numberIds }); setErr(''); }).catch((e) => setErr(errOf(e, 'The meetings could not be read.'))), []);
  useEffect(() => { load(); timer.current = setInterval(load, 20000); return () => clearInterval(timer.current); }, [load]);
  useEffect(() => { api.get('/messaging/call-lines').then((r) => { setLines(r.data); setCallLine((cur) => cur || r.data.default || 'api'); }).catch(() => setLines(null)); }, []);
  if (err && !d) return <div className="card panel" style={{ color: '#9b1c1c' }}>{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={load}>Try again</button></div>;
  if (!d) return <div className="card panel">Loading…</div>;
  const c = d.counts;
  const make = async () => {
    setBusy('make'); setErr('');
    try { const r = await omni.post('/gs/marketing/meetings', f); toast(r.ok); setF({ name: '', phone: '', language: f.language, note: '' }); await load(); } catch (e) { const m = errOf(e, 'The link could not be made.'); setErr(m); toast(m); } finally { setBusy(''); }
  };
  const send = async (m, o) => {
    setBusy(`send${m.id}`); setErr('');
    try { const r = await omni.post(`/gs/marketing/meetings/${m.id}/tell`, { ...(o.numberId ? { numberId: o.numberId } : {}), ...(o.phone != null && String(o.phone).trim() ? { phone: String(o.phone).trim() } : {}) }); toast(r.ok); await load(); } catch (e) { const x = errOf(e, 'It could not be sent.'); setErr(x); toast(x); } finally { setBusy(''); }
  };
  const note = (id, tone, text) => setNotes((n) => ({ ...n, [id]: { tone, text } }));
  const call = async (m) => {
    setBusy(`call${m.id}`); setErr(''); note(m.id, 'ok', 'Starting the call…');
    try { const r = await omni.post(`/gs/marketing/meetings/${m.id}/call`, { line: callLine || undefined }); note(m.id, 'ok', `${r.ok} If your phone does not ring within a minute, tell the team the line may be down.`); toast(r.ok); await load(); } catch (e) { const x = errOf(e, 'The call could not be started.'); note(m.id, 'err', x); setErr(x); toast(x); } finally { setBusy(''); }
  };
  // "Dial it myself": a computer often has no program for tel: links, so nothing would happen. The number is always copied and shown, and the link still tries the dialler.
  const dial = async (m) => {
    const n = telOf(m.phone);
    try { await navigator.clipboard.writeText(n); } catch { /* the message still shows the number */ }
    note(m.id, 'ok', `Dial ${n}${m.name ? ` (${m.name})` : ''}. The number is copied. If your computer did not open a dialler, dial it on your phone.`);
  };
  const copy = async (m) => { try { await navigator.clipboard.writeText(linkOf(m)); toast('Link copied'); } catch { window.prompt('Copy the link:', linkOf(m)); } };
  const del = async (m) => {
    setBusy(`del${m.id}`);
    try { const r = await omni.del(`/gs/marketing/meetings/${m.id}`); toast(r.ok); await load(); } catch (e) { toast(errOf(e, 'It could not be removed.')); } finally { setBusy(''); }
  };
  const saveSpots = async () => {
    setBusy('spots'); setErr('');
    try { const r = await omni.put('/gs/marketing/meetings/settings', { spotsLeft: Number(spots) }); toast(r.ok); await load(); } catch (e) { const m = errOf(e, 'It could not be saved.'); setErr(m); toast(m); } finally { setBusy(''); }
  };
  const saveAlert = async (on) => {
    setBusy('alert'); setErr('');
    try { const r = await omni.put('/gs/marketing/meetings/alert', { on, phone: (al && al.phone) || '' }); toast(r.ok); setAl({ on: r.alert.on, phone: r.alert.phone }); await load(); } catch (e) { const m = errOf(e, 'It could not be saved.'); setErr(m); toast(m); } finally { setBusy(''); }
  };
  const saveOffer = async () => {
    setBusy('offer'); setErr('');
    try { const r = await omni.put('/gs/marketing/meetings/offer', { on: !!au.on, website: !!au.website, numberIds: au.numberIds }); toast(r.ok); setAu({ on: r.offer.on, website: r.offer.website, numberIds: r.offer.numberIds }); await load(); } catch (e) { const m = errOf(e, 'It could not be saved.'); setErr(m); toast(m); } finally { setBusy(''); }
  };
  const openLink = `${window.location.origin}/plans-meeting`; // anybody who opens it starts a meeting of their own (a row "Opened without a link"); they type their number only when they ask for a call
  const shareText = `Want to see our social media plans, prices and offers? Watch a 5-minute automated demo in English, Telugu or Hindi, and ask for a call from our team: ${openLink}`;
  const shareCode = `<a href="${openLink}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 22px;border-radius:10px;background:#0a73c4;color:#fff;font:600 15px Arial,sans-serif;text-decoration:none">Watch our plans demo (5 min)</a>`;
  const copyText = async (text, what) => { try { await navigator.clipboard.writeText(text); toast(`${what} copied`); } catch { window.prompt(`Copy ${what.toLowerCase()}:`, text); } };
  const startAnswer = (q, id, answer, keywords) => setEd({ id: id || '', q, answer: { en: '', te: '', hi: '', ...(answer || {}) }, keywords: keywords || '' });
  const saveAnswer = async () => {
    setBusy('answer'); setErr('');
    try { const r = await omni.put('/gs/marketing/meetings/answers', { id: ed.id || undefined, q: ed.q, answer: ed.answer, keywords: ed.keywords }); toast(r.ok); setEd(null); await load(); } catch (e) { const m = errOf(e, 'It could not be saved.'); setErr(m); toast(m); } finally { setBusy(''); }
  };
  const dropAnswer = async (a) => {
    setBusy('answer');
    try { const r = await omni.del(`/gs/marketing/meetings/answers/${a.id}`); toast(r.ok); await load(); } catch (e) { toast(errOf(e, 'It could not be removed.')); } finally { setBusy(''); }
  };
  const countOf = { waiting: c.waiting || 0, Hot: c.hot, Warm: c.warm, Cold: c.cold, 'Not opened': c.notOpened };
  // who asked for a call and has not been called is on top
  const shown = d.items.filter((m) => (filter === 'waiting' ? waiting(m) : (filter ? m.interest === filter : true))).slice().sort((a, b) => (Number(waiting(b)) - Number(waiting(a))) || (waiting(a) && waiting(b) ? ((a.slotAt || 0) - (b.slotAt || 0)) || (b.handoverAt - a.handoverAt) : (b.createdAt - a.createdAt))); // waiting first: "as soon as possible" on top, then by the booked time, soonest first
  const picked = lines && lines.lines ? lines.lines.find((l) => l.id === callLine) : null;
  return (
    <div className="mkm">
      <div className="mkm-head">
        <div>
          <div className="mkm-eyebrow">AI Marketing</div>
          <h1>Plans meeting</h1>
          <p>Send a client a link on WhatsApp: an automated assistant presents the plans in English, Telugu or Hindi and answers questions. Clients who ask for a call appear first, with a Call button.</p>
        </div>
        <Btn onClick={() => window.open('/plans-meeting', '_blank', 'noopener')} title="Opens the meeting the way a client sees it. It is saved as “Opened without a link”.">▶ Try it yourself</Btn>
      </div>
      {err ? <div className="mkm-note" role="alert" style={{ margin: '0 0 10px' }}>{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={() => setErr('')}>Close</button></div> : null}

      <div className="mkm-kpis">
        {FILTERS.map(([k, label]) => (
          <button key={k} type="button" className={`mkm-kpi${k === 'waiting' && countOf.waiting ? ' warn' : ''}${filter === k ? ' on' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(filter === k ? '' : k)}>
            <span>{k === 'waiting' ? '📞 ' : ''}{label}</span><b>{countOf[k] || 0}</b>
          </button>
        ))}
      </div>

      <div className="mkm-grid">
        <div>
          <section className="mkm-card">
            <div className="mkm-listhead">
              <h3>Clients</h3>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>{filter ? `${shown.length} shown · ` : ''}{c.total} link{c.total === 1 ? '' : 's'} made{filter ? <> · <button type="button" className="link-btn" style={{ fontSize: 11 }} onClick={() => setFilter('')}>show all</button></> : ''}</span>
            </div>
            {shown.length === 0 ? <Empty title="No clients here yet">Make a link on the right, then send it to a client on WhatsApp.</Empty> : shown.map((m) => <Row key={m.id} m={m} busy={busy} note={notes[m.id]} onSend={send} onCall={call} onDial={dial} onCopy={copy} onDelete={(x) => setAsk(x)} />)}
          </section>

          <section className="mkm-card">
            <div className="mkm-listhead"><h3>Questions the assistant could not answer</h3><span style={{ fontSize: 11, color: 'var(--muted)' }}>{d.unanswered.length} waiting · {d.answers.length} added by you</span></div>
            <p>Write the answer once, in any language, and the assistant answers it (and the same words) for every client from then on. It never makes up policy: these are your words.</p>
            {ed ? (
              <div className="mkm-more" style={{ marginBottom: 10 }}>
                <div className="lab">THE QUESTION</div>
                <input value={ed.q} maxLength={300} onChange={(e) => setEd({ ...ed, q: e.target.value })} aria-label="The question" />
                {[['en', 'ANSWER IN ENGLISH'], ['te', 'ANSWER IN TELUGU (OPTIONAL)'], ['hi', 'ANSWER IN HINDI (OPTIONAL)']].map(([k, lab]) => (
                  <div key={k}><div className="lab">{lab}</div><textarea rows={2} maxLength={900} value={ed.answer[k] || ''} onChange={(e) => setEd({ ...ed, answer: { ...ed.answer, [k]: e.target.value } })} aria-label={lab} /></div>
                ))}
                <div className="lab">EXTRA WORDS THAT FIND THIS ANSWER (OPTIONAL, WITH COMMAS)</div>
                <input value={ed.keywords} maxLength={200} onChange={(e) => setEd({ ...ed, keywords: e.target.value })} placeholder="For example: logo, branding" aria-label="Extra words" />
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}><Btn small primary disabled={busy === 'answer'} onClick={saveAnswer}>Save the answer</Btn><Btn small onClick={() => setEd(null)}>Cancel</Btn></div>
              </div>
            ) : null}
            {d.unanswered.length === 0 ? <div className="mkm-meta" style={{ padding: '6px 2px' }}>Nothing is waiting. When a client asks something the assistant has no answer for, it appears here.</div> : d.unanswered.map((u) => (
              <div className="mkm-q" key={u.q}>
                <div><b>“{u.q}”</b><span className="mkm-meta"> asked {u.count} time{u.count === 1 ? '' : 's'}, last {fmtDateTime(u.lastAt)}</span></div>
                <Btn small primary onClick={() => startAnswer(u.q)}>Add an answer</Btn>
              </div>
            ))}
            {d.answers.length ? (
              <div style={{ marginTop: 10 }}>
                <div className="mkm-eyebrow" style={{ margin: '4px 0' }}>Answers you added</div>
                {d.answers.map((a) => (
                  <div className="mkm-q" key={a.id}>
                    <div><b>“{a.q}”</b><span className="mkm-meta"> {a.answer.en || a.answer.te || a.answer.hi}</span></div>
                    <div style={{ display: 'flex', gap: 6 }}><TinyBtn onClick={() => startAnswer(a.q, a.id, a.answer, (a.keywords || []).filter((k) => !String(a.q).toLowerCase().includes(k)).join(', '))}>Edit</TinyBtn><TinyBtn disabled={busy === 'answer'} onClick={() => dropAnswer(a)}>Remove</TinyBtn></div>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        </div>

        <aside className="mkm-side">
          <section className="mkm-card">
            <h3>New meeting link</h3>
            <p>One link for one client, valid for 30 days. Open the new row to send it.</p>
            <div className="mkm-form">
              <label>Client's name<input value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="For example: Ravi" /></label>
              <label>WhatsApp number<input value={f.phone} maxLength={30} inputMode="tel" onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="+91…" /></label>
              <div>
                <label style={{ marginBottom: 3 }}>The meeting starts in</label>
                <div className="mkm-chips">{Object.keys(LANG).map((k) => <button key={k} type="button" className={`mkm-chip${f.language === k ? ' on' : ''}`} onClick={() => setF({ ...f, language: k })}>{LANG[k]}</button>)}</div>
              </div>
              <label>Your note (only you see it)<input value={f.note} maxLength={200} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="For example: met at the expo" /></label>
              <div><Btn primary disabled={busy === 'make'} onClick={make}>{busy === 'make' ? 'Making…' : 'Make the link'}</Btn></div>
            </div>
          </section>

          <section className="mkm-card">
            <h3>Calls and alerts</h3>
            <p>A client who asks for a call rings the bell in TeamLink. The WhatsApp alert puts it on your phone too.</p>
            <div className="mkm-form">
              <label>Call the client from
                <select value={callLine} onChange={(e) => setCallLine(e.target.value)} aria-label="The line the call goes out on">
                  {lines && lines.lines ? lines.lines.map((l) => <option key={l.id} value={l.id} disabled={!l.ready}>{l.text}{l.from ? ` · client sees ${l.from}` : ''}{l.ready ? '' : ' · not connected'}</option>) : <option value="">Default line</option>}
                </select>
                <small>{picked ? (picked.ready ? `${picked.note || 'Your own phone rings first, then the client is connected.'}${picked.from ? ` The client sees ${picked.from}.` : ''}` : picked.reason) : 'Your own phone rings first; when you pick up, TeamLink dials the client.'}</small>
              </label>
              <label>My phone number
                <input value={(al && al.phone) || ''} maxLength={30} inputMode="tel" placeholder="+91…" onChange={(e) => setAl({ ...(al || { on: false }), phone: e.target.value })} aria-label="Your own phone number" />
                <small>{d.alert.phone ? `Saved: ${d.alert.phoneMasked}. ` : 'Nothing saved yet. '}It rings first when you press Call now. {d.alert.on ? 'The WhatsApp alert is ON.' : 'The WhatsApp alert is off.'}</small>
              </label>
              <div className="row">
                <Btn small primary disabled={busy === 'alert' || !((al && al.phone) || '').trim()} onClick={() => saveAlert(d.alert.on)}>Save my number</Btn>
                <Btn small disabled={busy === 'alert' || !((al && al.phone) || '').trim()} onClick={() => saveAlert(!d.alert.on)}>{d.alert.on ? 'Alert off' : 'Alert me on WhatsApp'}</Btn>
              </div>
            </div>
          </section>

          {au ? (
            <section className="mkm-card">
              <h3>Automatic demo for new enquiries</h3>
              <p>No need to add a number and send a link each time. When a <b>new person</b> writes to a number ticked here, TeamLink sends them their own demo link by itself, in their language. Once per person in 30 days; never after STOP; never to a candidate, employee or client contact.</p>
              <div className="mkm-form">
                <label className="mkm-check"><input type="checkbox" disabled={!d.offer.canEdit || busy === 'offer'} checked={!!au.on} onChange={(e) => setAu({ ...au, on: e.target.checked })} /> Offer the demo to new WhatsApp enquiries</label>
                <div className={au.on ? '' : 'mkm-dim'}>
                  <div className="lab">WHICH NUMBERS OFFER IT</div>
                  {d.offer.numbers && d.offer.numbers.length ? d.offer.numbers.map((n) => (
                    <label key={n.id} className="mkm-check"><input type="checkbox" disabled={!d.offer.canEdit || busy === 'offer'} checked={au.numberIds.includes(n.id)} onChange={(e) => setAu({ ...au, numberIds: e.target.checked ? [...au.numberIds, n.id] : au.numberIds.filter((x) => x !== n.id) })} /> {n.label}{n.number ? ` · ${n.number}` : ''}{n.isDefault ? ' (default)' : ''}</label>
                  )) : <small>No WhatsApp numbers are listed for your login. An Admin adds them in Administration &gt; Integrations &gt; WhatsApp numbers.</small>}
                  <small>{au.on && !au.numberIds.length ? 'Tick the number that should offer the demo, then press Save. ' : ''}On a ticked number the job-seeker assistant stays quiet for people who are not candidates.</small>
                </div>
                <label className="mkm-check"><input type="checkbox" disabled={!d.offer.canEdit || busy === 'offer'} checked={!!au.website} onChange={(e) => setAu({ ...au, website: e.target.checked })} /> Also send it to website-form leads who ask about marketing (approved template; leads who ask about HRMS or ATS keep their own demo)</label>
                {!d.offer.siteReady && d.offer.canEdit ? <div className="mkm-note" role="alert">This copy of TeamLink does not know its own https address (APP_BASE_URL), so links cannot be made. Ask the person who runs the server.</div> : null}
                {!d.offer.canEdit ? <small>Only an Admin can change this.</small> : (
                  <div className="row">
                    <Btn small primary disabled={busy === 'offer' || (au.on && !au.numberIds.length) || (au.on === d.offer.on && au.website === d.offer.website && [...au.numberIds].sort().join() === [...d.offer.numberIds].sort().join())} onClick={saveOffer}>{busy === 'offer' ? 'Saving…' : 'Save'}</Btn>
                  </div>
                )}
                <small>{d.offer.on ? 'ON for WhatsApp enquiries.' : 'OFF for WhatsApp enquiries.'} {d.offer.website ? 'ON for website leads.' : 'OFF for website leads.'} Last 30 days: <b>{d.offer.last30.offered}</b> offered · <b>{d.offer.last30.opened}</b> opened · <b>{d.offer.last30.wantCall}</b> asked for a call. At most {d.offer.cap} a day.</small>
              </div>
            </section>
          ) : null}

          <section className="mkm-card">
            <h3>Share the demo anywhere</h3>
            <p>One open link for your Instagram bio, website, posts and visiting cards. Each person who opens it gets a meeting of their own (a row “Opened without a link”); their number is asked only if they ask for a call.</p>
            <div className="mkm-form">
              <input readOnly value={openLink} onFocus={(e) => e.target.select()} aria-label="The open demo link" />
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <Btn small primary onClick={() => copyText(openLink, 'Link')}>⧉ Copy link</Btn>
                <Btn small onClick={() => copyText(shareText, 'Message')}>Copy a ready message</Btn>
                <Btn small onClick={() => copyText(shareCode, 'Button code')}>Copy website button code</Btn>
              </div>
            </div>
          </section>

          <section className="mkm-card">
            <h3>“First ten customers” offer</h3>
            <p>Nothing counts customers by itself, so you keep the number. At 0 the assistant stops mentioning the offer.</p>
            <div className="mkm-form">
              <div className="row" style={{ alignItems: 'center' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, textTransform: 'none', letterSpacing: 0, fontSize: 12, fontWeight: 600 }}>Spots left <input type="number" min={0} max={99} value={spots == null ? '' : spots} onChange={(e) => setSpots(e.target.value)} style={{ width: 70, marginTop: 0 }} /></label>
                <Btn small primary disabled={busy === 'spots' || spots === '' || spots == null || Number(spots) === d.settings.spotsLeft} onClick={saveSpots}>Save</Btn>
              </div>
            </div>
          </section>
        </aside>
      </div>
      {ask ? <ConfirmModal title="Remove this meeting link?" text={`The link for ${ask.name || 'this client'} stops working at once and leaves this list.`} yes="Remove it" danger onNo={() => setAsk(null)} onYes={() => { const x = ask; setAsk(null); del(x); }} /> : null}
    </div>
  );
}
