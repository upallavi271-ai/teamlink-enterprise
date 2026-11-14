// ---------------------------------------------------------------------------
// CRM - CALL, WHATSAPP AND EMAIL FROM A RECORD (founder 2026-11-14: "call, mail, wtsp dheyni meedha click chesina work avvali ... proper ga integrate avvali").
// One window for the three ways of reaching the person on a lead / deal / customer. It always opens, always says what is connected in Administration ->
// Integrations, and does the real thing when it is:
//   Email     "Send email" through the connected mailbox (from the person, replies come to them)      else "Open in my mail app" (TeamLink cannot see if it was sent)
//   WhatsApp  "Send on WhatsApp" through the connected number                                         else "Open in WhatsApp" (wa.me)
//   Call      "Call now": the person's own phone rings first, then the customer (Cloud Telephony)      else the phone's dialler (tel:)
// Every contact is written on the record's timeline by the server; after a call "How did it go?" saves what came of it and the next follow-up.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { useCrm, errOf, istToday, addDays } from './crmShared.jsx'; // eslint-disable-line import/no-cycle

const TABS = [['Email', '✉️ Email'], ['WhatsApp', '💬 WhatsApp'], ['Call', '📞 Call']];
const digitsOf = (v) => String(v || '').replace(/\D/g, '');
const intl = (v) => { const d = digitsOf(v); if (d.length === 10) return `91${d}`; if (d.length === 11 && d.startsWith('0')) return `91${d.slice(1)}`; return d; };

function Notice({ tone = 'warn', children }) {
  return <div className="notice" role="status" style={{ marginBottom: 10, fontSize: 13, ...(tone === 'warn' ? { borderColor: 'var(--amber, #d97706)' } : {}) }}>{children}</div>;
}

export default function CrmContactDialog({ record, channel: first = 'Email', onClose, onDone }) {
  const { me, toast } = useCrm();
  const [ch, setCh] = useState(first);
  const [ready, setReady] = useState(null);
  const [draft, setDraft] = useState(null);
  const [to, setTo] = useState({ Email: '', WhatsApp: '', Call: '' });
  const [subject, setSubject] = useState('');
  const [mailText, setMailText] = useState('');
  const [waText, setWaText] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [sentNote, setSentNote] = useState('');
  const [how, setHow] = useState(null); // after a call: { via: 'gateway' | 'phone' }
  const body = { kind: record.kind, id: record.id };

  useEffect(() => {
    api.get('/crm/contact/ready').then((r) => setReady(r.data)).catch(() => setReady({ email: { ready: false, reason: 'Could not read what is connected.' }, whatsapp: { ready: false, reason: '' }, call: { clickToCall: false, reason: '' } }));
    api.get('/crm/contact/draft', { params: body }).then((r) => {
      const d = r.data; setDraft(d);
      setTo({ Email: d.to.email || '', WhatsApp: d.to.phone || '', Call: d.to.phone || '' });
      setSubject(d.email.subject); setMailText(d.email.text); setWaText(d.whatsapp.text);
    }).catch((e) => setErr(errOf(e, 'This record could not be opened.')));
  }, [record.kind, record.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchTo = (c) => { setCh(c); setErr(''); setSentNote(''); setHow(null); };
  const setToFor = (c, v) => setTo((t) => ({ ...t, [c]: v }));
  const finish = () => { if (onDone) onDone(); };

  async function opened(channel, note) {
    try { await api.post('/crm/contact/opened', { ...body, channel, note }); finish(); } catch { /* the timeline line is a convenience; the app opened anyway */ }
  }
  async function send(channel) {
    setBusy(channel); setErr(''); setSentNote('');
    try {
      const r = await api.post('/crm/contact/send', channel === 'Email' ? { ...body, channel, to: to.Email, subject, text: mailText } : { ...body, channel, to: to.WhatsApp, text: waText });
      toast(channel === 'Email' ? `Email sent to ${r.data.to}.` : `WhatsApp sent to ${r.data.to}.`);
      setSentNote(channel === 'Email' ? `Sent to ${r.data.to}. It is on the timeline.` : `Sent to ${r.data.to} from ${(rd.whatsapp && rd.whatsapp.via) || r.data.via}. It is on the timeline.`);
      finish();
    } catch (e) {
      const d = e.response && e.response.data;
      setErr(errOf(e, 'It could not be sent.') + (d && d.outsideWindow ? ' WhatsApp only lets a business start a chat with an approved template; you can open WhatsApp on your own phone instead.' : ''));
    } finally { setBusy(''); }
  }
  async function startCall() {
    setBusy('Call'); setErr('');
    try {
      const r = await api.post('/crm/contact/call', { ...body, to: to.Call });
      toast(r.data.sandbox ? 'Test server: no real call was made.' : 'Your phone will ring first.');
      setSentNote(r.data.message); setHow({ via: 'gateway' }); finish();
    } catch (e) { setErr(errOf(e, 'The call could not be started.')); } finally { setBusy(''); }
  }

  const rd = ready || {};
  const mailReady = rd.email && rd.email.ready;
  const waReady = rd.whatsapp && rd.whatsapp.ready;
  const gwReady = rd.call && rd.call.clickToCall;
  const mailto = `mailto:${to.Email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(mailText)}`;
  const waLink = `https://wa.me/${intl(to.WhatsApp)}?text=${encodeURIComponent(waText)}`;
  const whereTo = (draft && draft.to) || {};

  return (
    <Modal title={`${record.name || whereTo.name || 'Contact'}${whereTo.company && whereTo.company !== record.name ? ` · ${whereTo.company}` : ''}`} size="wide" onClose={onClose} foot={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {TABS.map(([c, label]) => <button key={c} type="button" className={`btn btn-sm${ch === c ? ' btn-primary' : ''}`} aria-pressed={ch === c} onClick={() => switchTo(c)}>{label}</button>)}
      </div>
      {!ready && !err && <div className="small-muted">Checking what is connected…</div>}
      {err && <div className="notice" role="alert" style={{ color: 'var(--red)', marginBottom: 10 }}>{err}</div>}
      {sentNote && <div className="notice" role="status" style={{ marginBottom: 10, borderColor: 'var(--green, #16a34a)' }}>{sentNote}</div>}

      {ch === 'Email' && ready && (
        <>
          {mailReady
            ? <div className="small-muted" style={{ marginBottom: 8, fontSize: 12.5 }}>Sent from your own name through the company mailbox ({rd.email.from}). Replies come to you.</div>
            : <Notice>Email is not connected: {rd.email.reason} Ask an Admin to connect it in Administration → Integrations. Until then you can open your own mail app.</Notice>}
          <div className="field"><label>To</label><input type="email" value={to.Email} onChange={(e) => setToFor('Email', e.target.value)} placeholder="name@company.com" aria-label="To" /></div>
          <div className="field"><label>Subject</label><input value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" /></div>
          <div className="field"><label>Message</label><textarea rows={8} value={mailText} onChange={(e) => setMailText(e.target.value)} aria-label="Email message" /></div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {mailReady && <button type="button" className="btn btn-primary" disabled={busy === 'Email' || !to.Email || !subject.trim() || !mailText.trim()} onClick={() => send('Email')}>{busy === 'Email' ? 'Sending…' : 'Send email'}</button>}
            <a className={`btn${mailReady ? '' : ' btn-primary'}`} href={mailto} onClick={(e) => { if (!to.Email) { e.preventDefault(); setErr('Write the email address first.'); return; } opened('Email'); }} aria-disabled={!to.Email}>Open in my mail app</a>
            <AiDraft record={record} onText={(s, t) => { if (s) setSubject(s); setMailText(t); }} />
          </div>
        </>
      )}

      {ch === 'WhatsApp' && ready && (
        <>
          {waReady
            ? <div className="small-muted" style={{ marginBottom: 8, fontSize: 12.5 }}>Sent through {rd.whatsapp.via || 'the connected WhatsApp number'}. Free text reaches a person who messaged you in the last 24 hours; otherwise WhatsApp may ask for an approved template.</div>
            : <Notice>WhatsApp is not connected: {rd.whatsapp.reason} Ask an Admin to connect it in Administration → Integrations. Until then you can open WhatsApp on your own phone or computer.</Notice>}
          <div className="field"><label>To (mobile number)</label><input value={to.WhatsApp} onChange={(e) => setToFor('WhatsApp', e.target.value)} placeholder="98765 43210" aria-label="WhatsApp number" /></div>
          <div className="field"><label>Message</label><textarea rows={6} value={waText} onChange={(e) => setWaText(e.target.value)} aria-label="WhatsApp message" /></div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {waReady && <button type="button" className="btn btn-primary" disabled={busy === 'WhatsApp' || !digitsOf(to.WhatsApp) || !waText.trim()} onClick={() => send('WhatsApp')}>{busy === 'WhatsApp' ? 'Sending…' : 'Send on WhatsApp'}</button>}
            <a className={`btn${waReady ? '' : ' btn-primary'}`} href={waLink} target="_blank" rel="noopener noreferrer" onClick={(e) => { if (!digitsOf(to.WhatsApp)) { e.preventDefault(); setErr('Write the number first.'); return; } opened('WhatsApp'); }} aria-disabled={!digitsOf(to.WhatsApp)}>Open in WhatsApp</a>
          </div>
          <div className="small-muted" style={{ marginTop: 6, fontSize: 11.5 }}>"Open in WhatsApp" uses your own WhatsApp: TeamLink cannot see whether you pressed Send, and says so on the timeline.</div>
        </>
      )}

      {ch === 'Call' && ready && (
        <>
          {gwReady
            ? (rd.call.myPhone
              ? <div className="small-muted" style={{ marginBottom: 8, fontSize: 12.5 }}>Calls go through {rd.call.provider}: <b>your own phone rings first</b>, then {record.name || 'the customer'} is connected.{rd.call.recording ? ' The call is recorded.' : ''}</div>
              : <Notice>Your own phone number is not on your employee profile, so TeamLink does not know which phone to ring first. Add it on your profile, or use the phone's own dialler below.</Notice>)
            : <Notice>Calling through TeamLink is not connected: {rd.call.reason} Ask an Admin to connect Cloud Telephony in Administration → Integrations. Until then call from your phone and save how it went.</Notice>}
          <div className="field"><label>Number</label><input style={{ fontSize: 22, fontWeight: 700, letterSpacing: 0.5 }} value={to.Call} onChange={(e) => setToFor('Call', e.target.value)} placeholder="98765 43210" aria-label="Number to call" /></div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            {gwReady && rd.call.myPhone && <button type="button" className="btn btn-primary" disabled={busy === 'Call' || !digitsOf(to.Call)} onClick={startCall}>{busy === 'Call' ? 'Starting…' : '📞 Call now (my phone rings first)'}</button>}
            <a className={`btn${gwReady && rd.call.myPhone ? '' : ' btn-primary'}`} href={`tel:+${intl(to.Call)}`} onClick={(e) => { if (!digitsOf(to.Call)) { e.preventDefault(); setErr('Write the number first.'); return; } setHow({ via: 'phone' }); }} aria-disabled={!digitsOf(to.Call)}>{gwReady && rd.call.myPhone ? 'Use my phone\'s dialler' : '📞 Call from my phone'}</a>
            {!how && <button type="button" className="btn" onClick={() => setHow({ via: 'phone' })}>I already called: save how it went</button>}
          </div>
          {how && <HowDidItGo record={record} body={body} via={how.via} onSaved={() => { toast('Saved on the timeline.'); finish(); setHow(null); setSentNote('Saved.'); }} />}
        </>
      )}
      {!me.canEdit && <div className="small-muted">Your role can read the CRM but not contact from it.</div>}
    </Modal>
  );
}

// "✨ Draft with AI": the same assistant as the record's AI box; only when the AI integration is set up
function AiDraft({ record, onText }) {
  const { toast } = useCrm();
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      const r = await api.post(`/crm/ai/draft/${record.kind}/${record.id}`, { purpose: 'a polite first message that offers our recruitment services and asks for a short call' });
      const t = String(r.data.text || '').trim();
      const m = /^subject:\s*(.+)\n+([\s\S]*)$/i.exec(t);
      onText(m ? m[1].trim() : '', m ? m[2].trim() : t);
    } catch (e) { toast(errOf(e, 'The AI draft is not available.')); } finally { setBusy(false); }
  }
  return <button type="button" className="btn" disabled={busy} onClick={go} title="Writes a first draft you can change">{busy ? 'Writing…' : '✨ Draft with AI'}</button>;
}

// after a call: what came of it, a line about it, the next follow-up - written on the record's timeline
function HowDidItGo({ record, body, via, onSaved }) {
  const { me, toast } = useCrm();
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const today = istToday();
  async function save() {
    if (!outcome && !note.trim()) { toast('Pick what came of it or write a line about it.'); return; }
    setBusy(true);
    try {
      await api.post('/crm/activities', {
        kind: 'call', [`${record.kind}Id`]: record.id, subject: `Call outcome${outcome ? `: ${outcome}` : ''}${via === 'phone' ? ' (from the phone)' : ''}`,
        note: note.trim() || undefined, outcome: outcome || undefined,
        followUp: next ? { dueDate: next, title: `Follow up: ${record.name || 'call'}` } : undefined,
      });
      onSaved();
    } catch (e) { toast(errOf(e, 'This could not be saved.')); setBusy(false); }
  }
  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="section-label" style={{ margin: '0 0 6px' }}>How did it go?</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {me.lists.outcomes.map((o) => <button key={o} type="button" className={`btn btn-sm${outcome === o ? ' btn-primary' : ''}`} aria-pressed={outcome === o} onClick={() => setOutcome(outcome === o ? '' : o)}>{o}</button>)}
      </div>
      <div className="field"><label>What happened?</label><textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Spoke to the owner, wants a quote by Friday" /></div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, alignItems: 'center' }}>
        <span className="small-muted">Next follow-up:</span>
        {[['Tomorrow', 1], ['In 3 days', 3], ['Next week', 7]].map(([l, n]) => <button key={l} type="button" className={`btn btn-sm${next === addDays(today, n) ? ' btn-primary' : ''}`} onClick={() => setNext(next === addDays(today, n) ? '' : addDays(today, n))}>{l}</button>)}
      </div>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
    </div>
  );
}
