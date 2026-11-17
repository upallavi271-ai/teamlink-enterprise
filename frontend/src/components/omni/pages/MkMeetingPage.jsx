import { useCallback, useEffect, useRef, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Kpi, Kpis, Panel, Banner, Field, Empty, Pill, Tag, ConfirmModal, fmtNum, fmtDateTime } from '../ui.jsx';
import SenderPick from '../marketing/SenderPick.jsx';
import '../marketing/marketing.css';

// AI MARKETING > CLIENT PROJECTS > PLANS MEETING. The team makes a link for a client (name, WhatsApp number, language) and sends it on WhatsApp from TeamLink. The client opens it on their phone: an automated
// assistant shows the plans slide by slide and speaks them in English, Telugu or Hindi, answers questions from a fixed list, and takes a callback request. This page shows who opened it, how far they watched, what
// they asked and who wants a call. Nothing is sent until a person presses "Send on WhatsApp". Server: marketing/meeting.js. The client's page: components/omni/marketing/PlansMeetingPage.jsx.
const LANG = { en: 'English', te: 'తెలుగు', hi: 'हिन्दी' };
const TONE = { Hot: 'red', Warm: 'warn', Cold: 'draft', 'Not opened': 'draft' };
const CHOICE = { trial: 'wants the ₹999 trial', starter: 'chose Starter', growth: 'chose Growth', premium: 'chose Premium', team: 'asked for a call' };
const WINDOW = { asap: 'as soon as possible', morning: 'morning (9 to 12)', afternoon: 'afternoon (12 to 4)', evening: 'evening (4 to 7)' };
const linkOf = (m) => `${window.location.origin}/plans-meeting/${m.token}`;

function Row({ m, busy, onSend, onCopy, onDelete }) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState(null);
  const [numberId, setNumberId] = useState('');
  const asked = m.questions || [];
  const progress = m.maxSlide ? `reached slide ${m.maxSlide + 1} of ${m.slides}${m.finishedAt ? ' (finished)' : ''}` : (m.views ? 'opened, not started' : 'not opened yet');
  return (
    <div className="mk-row" style={{ alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <button type="button" onClick={() => setOpen(!open)} style={{ all: 'unset', cursor: 'pointer', fontWeight: 700 }}>{m.name || (m.source === 'open' ? 'Opened without a link' : 'No name')}</button>{' '}
        <Pill tone={TONE[m.interest]} dot>{m.interest}</Pill> <Tag>{LANG[m.language] || m.language}</Tag>{m.sentAt ? <Tag green title="Sent from TeamLink">Sent on WhatsApp</Tag> : null}
        <small>{m.phoneMasked || 'no number yet'} · made by {m.createdByName || 'a visitor'} on {fmtDateTime(m.createdAt)} · {progress}{m.views ? ` · opened ${m.views} time${m.views === 1 ? '' : 's'}${m.lastOpenedAt ? `, last ${fmtDateTime(m.lastOpenedAt)}` : ''}` : ''}</small>
        {m.choice ? <small style={{ color: '#166534', fontWeight: 700 }}>{CHOICE[m.choice]}{m.callbackWindow ? `: call ${WINDOW[m.callbackWindow] || m.callbackWindow}` : ''}{m.handoverAt ? ` (asked ${fmtDateTime(m.handoverAt)})` : ''}</small> : null}
        {asked.length ? <small>Asked: {asked.slice(-3).map((x) => `“${x.q}”`).join(', ')}{asked.length > 3 ? ` and ${asked.length - 3} more` : ''}</small> : null}
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
  const timer = useRef(null);
  const load = useCallback(() => omni.get('/gs/marketing/meetings').then((x) => { setD(x); setSpots((cur) => (cur == null ? x.settings.spotsLeft : cur)); setErr(''); }).catch((e) => setErr(errOf(e, 'The meetings could not be read.'))), []);
  useEffect(() => { load(); timer.current = setInterval(load, 30000); return () => clearInterval(timer.current); }, [load]);
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
  const copy = async (m) => { try { await navigator.clipboard.writeText(linkOf(m)); toast('Link copied'); } catch { window.prompt('Copy the link:', linkOf(m)); } };
  const del = async (m) => {
    setBusy(`del${m.id}`);
    try { const r = await omni.del(`/gs/marketing/meetings/${m.id}`); toast(r.ok); await load(); } catch (e) { toast(errOf(e, 'It could not be removed.')); } finally { setBusy(''); }
  };
  const saveSpots = async () => {
    setBusy('spots'); setErr('');
    try { const r = await omni.put('/gs/marketing/meetings/settings', { spotsLeft: Number(spots) }); toast(r.ok); await load(); } catch (e) { const m = errOf(e, 'It could not be saved.'); setErr(m); toast(m); } finally { setBusy(''); }
  };
  const shown = d.items.filter((m) => (filter ? m.interest === filter : true));
  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="Plans meeting" lead="Make a link for a client and send it on WhatsApp. The client opens it on their phone and an automated assistant shows the plans and speaks them in English, Telugu or Hindi, answers their questions and takes a callback request. You see here who watched, how far, and who wants a call.">
        <Btn onClick={() => window.open('/plans-meeting', '_blank', 'noopener')} title="Opens the meeting the way a client sees it. It is saved as “Opened without a link”.">▶ Try it yourself</Btn>
      </PageHead>
      {err ? <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={() => setErr('')}>Close</button></Banner> : null}
      <Kpis>
        <Kpi label="Links made" icon="☎" value={fmtNum(c.total)} meta="last 300" />
        <Kpi label="Hot" icon="▲" value={fmtNum(c.hot)} tone={c.hot ? 'warn' : 'neutral'} meta="chose a plan or asked for a call" />
        <Kpi label="Warm" icon="●" value={fmtNum(c.warm)} meta="watched most of it or asked questions" />
        <Kpi label="Cold" icon="▼" value={fmtNum(c.cold)} meta="opened only" />
        <Kpi label="Not opened" icon="?" value={fmtNum(c.notOpened)} tone={c.notOpened ? 'warn' : 'neutral'} meta="send the link again" />
      </Kpis>
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
      <Panel title="Your meetings" sub="Newest first. Press a name to see the link, send it, and read everything the client asked." style={{ marginTop: 14 }} right={<select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Show"><option value="">All</option><option value="Hot">Hot</option><option value="Warm">Warm</option><option value="Cold">Cold</option><option value="Not opened">Not opened</option></select>}>
        {shown.length === 0 ? <Empty title="No meetings here yet">Make a link above, then send it to a client on WhatsApp.</Empty> : shown.map((m) => <Row key={m.id} m={m} busy={busy} onSend={send} onCopy={copy} onDelete={(x) => setAsk(x)} />)}
      </Panel>
      {ask ? <ConfirmModal title="Remove this meeting link?" text={`The link for ${ask.name || 'this client'} stops working at once and leaves this list.`} yes="Remove it" danger onNo={() => setAsk(null)} onYes={() => { const x = ask; setAsk(null); del(x); }} /> : null}
    </div>
  );
}
