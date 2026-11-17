import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../../api';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Kpi, Kpis, Panel, Banner, Field, Empty, Pill, Tag, ConfirmModal, fmtNum, fmtDateTime } from '../ui.jsx';
import SenderPick from '../marketing/SenderPick.jsx';
import '../marketing/marketing.css';

// AI MARKETING > CLIENT PROJECTS > PLANS MEETING. The team makes a link for a client (name, WhatsApp number, language) and sends it on WhatsApp from TeamLink. The client opens it on their phone: an automated
// assistant shows the plans slide by slide and speaks them in English, Telugu or Hindi, answers questions from a fixed list, and takes a callback request. This page shows who opened it, how far they watched, what
// they asked and who wants a call: a client who asked for a call is at the top with a CALL button (TeamLink rings your phone first, then the client, on the line you pick) and the person who made the link also gets a
// bell and, when switched on, a WhatsApp. Nothing is sent or dialled until a person presses a button. Server: marketing/meeting.js. The client's page: components/omni/marketing/PlansMeetingPage.jsx.
const LANG = { en: 'English', te: 'తెలుగు', hi: 'हिन्दी' };
const TONE = { Hot: 'red', Warm: 'warn', Cold: 'draft', 'Not opened': 'draft' };
const CHOICE = { trial: 'wants the ₹999 trial', starter: 'chose Starter', growth: 'chose Growth', premium: 'chose Premium', team: 'asked for a call' };
const WINDOW = { asap: 'as soon as possible', morning: 'morning (9 to 12)', afternoon: 'afternoon (12 to 4)', evening: 'evening (4 to 7)' };
const linkOf = (m) => `${window.location.origin}/plans-meeting/${m.token}`;
const telOf = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length === 10 ? `+91${d}` : `+${d}`; }; // opens the phone's own dialler
const waiting = (m) => !!m.handoverAt && (!m.calledAt || m.calledAt < m.handoverAt); // asked for a call and nobody has called since

function Row({ m, busy, onSend, onCopy, onDelete, onCall }) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState(null);
  const [numberId, setNumberId] = useState('');
  const asked = m.questions || [];
  const wants = waiting(m);
  const progress = m.maxSlide ? `reached slide ${m.maxSlide + 1} of ${m.slides}${m.finishedAt ? ' (finished)' : ''}` : (m.views ? 'opened, not started' : 'not opened yet');
  const callBtn = m.phone ? (
    <>
      <Btn small primary={wants} disabled={!!busy} onClick={() => onCall(m)} title="TeamLink rings YOUR phone first, then connects the client, on the line picked above">{busy === `call${m.id}` ? 'Calling…' : '📞 Call now'}</Btn>
      <a href={`tel:${telOf(m.phone)}`} className="tiny-btn" style={{ textDecoration: 'none', display: 'inline-block' }} title="Opens this phone's own dialler">Call from this phone</a>
    </>
  ) : null;
  return (
    <div className="mk-row" style={{ alignItems: 'flex-start', ...(wants ? { background: '#fffaf0', borderRadius: 10, padding: '12px 10px' } : {}) }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <button type="button" onClick={() => setOpen(!open)} style={{ all: 'unset', cursor: 'pointer', fontWeight: 700 }}>{m.name || (m.source === 'open' ? 'Opened without a link' : 'No name')}</button>{' '}
        <Pill tone={TONE[m.interest]} dot>{m.interest}</Pill> {wants ? <Pill tone="red">📞 Wants a call</Pill> : null} <Tag>{LANG[m.language] || m.language}</Tag>{m.sentAt ? <Tag green title="Sent from TeamLink">Sent on WhatsApp</Tag> : null}
        <small>{m.phone || 'no number yet'} · made by {m.createdByName || 'a visitor'} on {fmtDateTime(m.createdAt)} · {progress}{m.views ? ` · opened ${m.views} time${m.views === 1 ? '' : 's'}${m.lastOpenedAt ? `, last ${fmtDateTime(m.lastOpenedAt)}` : ''}` : ''}</small>
        {m.choice ? <small style={{ color: '#166534', fontWeight: 700 }}>{CHOICE[m.choice]}{m.callbackWindow ? `: call ${WINDOW[m.callbackWindow] || m.callbackWindow}` : ''}{m.handoverAt ? ` (asked ${fmtDateTime(m.handoverAt)})` : ''}</small> : null}
        {m.calledAt ? <small style={{ color: m.calledAt >= (m.handoverAt || 0) ? '#166534' : 'var(--muted)' }}>Called {fmtDateTime(m.calledAt)} by {m.calledByName || 'the team'}{m.callLine ? ` on the ${String(m.callLine).toUpperCase()} line` : ''}</small> : null}
        {asked.length ? <small>Asked: {asked.slice(-3).map((x) => `“${x.q}”`).join(', ')}{asked.length > 3 ? ` and ${asked.length - 3} more` : ''}</small> : null}
        {callBtn ? <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>{callBtn}</div> : null}
        {open ? (
          <div style={{ marginTop: 8, background: '#f6f8f7', borderRadius: 10, padding: '10px 12px', fontSize: 12, lineHeight: 1.6 }}>
            {m.note ? <div style={{ marginBottom: 6 }}>Your note: {m.note}</div> : null}
            <div style={{ fontSize: 10, fontWeight: 800, color: '#166534' }}>THE LINK</div>
            <input readOnly value={linkOf(m)} onFocus={(e) => e.target.select()} aria-label="The meeting link" style={{ width: '100%', boxSizing: 'border-box', margin: '4px 0 8px', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 9px', font: 'inherit', fontSize: 11 }} />
            <div style={{ fontSize: 10, fontWeight: 800, color: '#166534' }}>CLIENT'S WHATSAPP NUMBER</div>
            <input value={phone != null ? phone : (m.phone || '')} maxLength={30} inputMode="tel" placeholder="+91…" onChange={(e) => setPhone(e.target.value)} aria-label="The client's WhatsApp number" style={{ width: '100%', boxSizing: 'border-box', margin: '4px 0', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 9px', font: 'inherit', fontSize: 12 }} />
            <SenderPick value={numberId} onChange={setNumberId} disabled={!!busy} />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
              <Btn small primary disabled={!!busy} onClick={() => onSend(m, { numberId, phone })}>{busy === `send${m.id}` ? 'Sending…' : (m.sentAt ? 'Send again on WhatsApp' : 'Send on WhatsApp from TeamLink')}</Btn>
              <Btn small onClick={() => onCopy(m)}>⧉ Copy link</Btn>
              <Btn small danger disabled={!!busy} onClick={() => onDelete(m)}>Remove</Btn>
            </div>
            {asked.length ? (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: '#166534' }}>EVERYTHING THEY ASKED</div>
                {asked.map((x, i) => <div key={i}>• {x.q}{x.id ? <span style={{ color: 'var(--muted)' }}> (answered {x.id})</span> : <span style={{ color: '#b45309' }}> (no answer found: call them)</span>}</div>)}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="mk-acts" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <TinyBtn onClick={() => setOpen(!open)}>{open ? 'Close' : 'Open'}</TinyBtn>
      </div>
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
  const [al, setAl] = useState(null); // { on, phone } being edited for the WhatsApp alert
  const timer = useRef(null);
  const load = useCallback(() => omni.get('/gs/marketing/meetings').then((x) => { setD(x); setSpots((cur) => (cur == null ? x.settings.spotsLeft : cur)); setAl((cur) => cur || { on: x.alert.on, phone: x.alert.phone }); setErr(''); }).catch((e) => setErr(errOf(e, 'The meetings could not be read.'))), []);
  useEffect(() => { load(); timer.current = setInterval(load, 20000); return () => clearInterval(timer.current); }, [load]);
  useEffect(() => { api.get('/messaging/call-lines').then((r) => { setLines(r.data); setCallLine((cur) => cur || r.data.default || 'api'); }).catch(() => setLines(null)); }, []);
  if (err && !d) return <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={load}>Try again</button></Banner>;
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
  const call = async (m) => {
    setBusy(`call${m.id}`); setErr('');
    try { const r = await omni.post(`/gs/marketing/meetings/${m.id}/call`, { line: callLine || undefined }); toast(r.ok); await load(); } catch (e) { const x = errOf(e, 'The call could not be started.'); setErr(x); toast(x); } finally { setBusy(''); }
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
  // who asked for a call and has not been called is at the top
  const shown = d.items.filter((m) => (filter ? m.interest === filter : true)).slice().sort((a, b) => (Number(waiting(b)) - Number(waiting(a))) || (b.createdAt - a.createdAt));
  const picked = lines && lines.lines ? lines.lines.find((l) => l.id === callLine) : null;
  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="Plans meeting" lead="Make a link for a client and send it on WhatsApp. The client opens it on their phone and an automated assistant shows the plans and speaks them in English, Telugu or Hindi, answers their questions and takes a callback request. You see here who watched, how far, and who wants a call, with a Call button.">
        <Btn onClick={() => window.open('/plans-meeting', '_blank', 'noopener')} title="Opens the meeting the way a client sees it. It is saved as “Opened without a link”.">▶ Try it yourself</Btn>
      </PageHead>
      {err ? <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={() => setErr('')}>Close</button></Banner> : null}
      <Kpis>
        <Kpi label="Waiting for your call" icon="📞" value={fmtNum(c.waiting || 0)} tone={c.waiting ? 'warn' : 'neutral'} meta="asked for a call, not called yet" />
        <Kpi label="Links made" icon="☎" value={fmtNum(c.total)} meta="last 300" />
        <Kpi label="Hot" icon="▲" value={fmtNum(c.hot)} tone={c.hot ? 'warn' : 'neutral'} meta="chose a plan or asked for a call" />
        <Kpi label="Warm" icon="●" value={fmtNum(c.warm)} meta="watched most of it or asked questions" />
        <Kpi label="Not opened" icon="?" value={fmtNum(c.notOpened)} tone={c.notOpened ? 'warn' : 'neutral'} meta="send the link again" />
      </Kpis>
      <Panel title="Calls and alerts" sub="When a client asks for a call, you get a bell in TeamLink. Switch on the WhatsApp alert to get it on your phone too, then press Call now." style={{ marginTop: 14 }}>
        <div className="form-grid">
          <Field label="CALL THE CLIENT FROM" hint={picked ? (picked.ready ? `${picked.note || 'Your own phone rings first, then the client is connected.'}${picked.from ? ` The client sees ${picked.from}.` : ''}` : picked.reason) : 'Your own phone rings first (the number on your employee profile); when you pick up, TeamLink dials the client.'}>
            <select value={callLine} onChange={(e) => setCallLine(e.target.value)} aria-label="The line the call goes out on">
              {lines && lines.lines ? lines.lines.map((l) => <option key={l.id} value={l.id} disabled={!l.ready}>{l.text}{l.from ? ` · client sees ${l.from}` : ''}{l.ready ? '' : ' · not connected'}</option>) : <option value="">Default line</option>}
            </select>
          </Field>
          <Field label="WHATSAPP ALERT TO MY NUMBER" hint={d.alert.on ? `On: alerts go to ${d.alert.phoneMasked}. Sent from the company WhatsApp number.` : 'Off. Type your own WhatsApp number and switch it on.'}>
            <input value={(al && al.phone) || ''} maxLength={30} inputMode="tel" placeholder="+91…" onChange={(e) => setAl({ ...(al || { on: false }), phone: e.target.value })} aria-label="Your WhatsApp number for alerts" />
          </Field>
          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Btn small primary disabled={busy === 'alert' || !((al && al.phone) || '').trim()} onClick={() => saveAlert(true)}>{d.alert.on ? 'Save my number' : 'Switch the WhatsApp alert on'}</Btn>
            {d.alert.on ? <Btn small disabled={busy === 'alert'} onClick={() => saveAlert(false)}>Switch it off</Btn> : null}
          </div>
        </div>
      </Panel>
      <Panel title="Make a meeting link" sub="One link for one client. It works for 30 days." style={{ marginTop: 14 }}>
        <div className="form-grid">
          <Field label="CLIENT'S NAME"><input value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="For example: Ravi" /></Field>
          <Field label="WHATSAPP NUMBER"><input value={f.phone} maxLength={30} inputMode="tel" onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="+91…" /></Field>
          <Field label="THE MEETING STARTS IN"><select value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })}>{Object.keys(LANG).map((k) => <option key={k} value={k}>{LANG[k]}</option>)}</select></Field>
          <Field label="YOUR NOTE (ONLY YOU SEE IT)"><input value={f.note} maxLength={200} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="For example: met at the expo" /></Field>
          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Btn primary disabled={busy === 'make'} onClick={make}>{busy === 'make' ? 'Making…' : 'Make the link'}</Btn>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>Then press Open on the new row to send it on WhatsApp from TeamLink. The client can change the language on the first screen.</span>
          </div>
        </div>
      </Panel>
      <Panel title="The “first ten customers” offer" sub="Nothing counts the customers by itself, so you keep the number. When it is 0 the assistant stops saying the first-ten offer." style={{ marginTop: 14 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12.5 }}>Spots left <input type="number" min={0} max={99} value={spots == null ? '' : spots} onChange={(e) => setSpots(e.target.value)} style={{ width: 80, marginLeft: 6 }} /></label>
          <Btn small primary disabled={busy === 'spots' || spots === '' || spots == null || Number(spots) === d.settings.spotsLeft} onClick={saveSpots}>Save</Btn>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>Now: {d.settings.spotsLeft} left.</span>
        </div>
      </Panel>
      <Panel title="Your meetings" sub="Clients waiting for a call come first. Press a name to see the link, send it, and read everything the client asked." style={{ marginTop: 14 }} right={<select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Show"><option value="">All</option><option value="Hot">Hot</option><option value="Warm">Warm</option><option value="Cold">Cold</option><option value="Not opened">Not opened</option></select>}>
        {shown.length === 0 ? <Empty title="No meetings here yet">Make a link above, then send it to a client on WhatsApp.</Empty> : shown.map((m) => <Row key={m.id} m={m} busy={busy} onSend={send} onCall={call} onCopy={copy} onDelete={(x) => setAsk(x)} />)}
      </Panel>
      {ask ? <ConfirmModal title="Remove this meeting link?" text={`The link for ${ask.name || 'this client'} stops working at once and leaves this list.`} yes="Remove it" danger onNo={() => setAsk(null)} onYes={() => { const x = ask; setAsk(null); del(x); }} /> : null}
    </div>
  );
}
