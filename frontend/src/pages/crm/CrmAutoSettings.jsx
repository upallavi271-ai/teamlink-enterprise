// CRM settings > Automatic follow-through (founder 2026-11-06: "mottham antha automatic ga avvali"): the switch, the steps a new lead gets, the AI call's words and the meetings. crm/autopilot.js does the work.
import { useEffect, useState } from 'react';
import api from '../../api';
import { useCrm, errOf } from './crmShared.jsx';

const WORDS = { email: 'Mail', sms: 'SMS', whatsapp: 'WhatsApp', call: 'AI call' };
const when = (h) => { const n = Number(h); if (!n) return 'At once'; return n < 24 ? `After ${n} hour${n === 1 ? '' : 's'}` : `After ${Math.round((n / 24) * 10) / 10} day${n === 24 ? '' : 's'}`; };

export default function CrmAutoSettings() {
  const { toast } = useCrm();
  const [f, setF] = useState(null);
  const [counts, setCounts] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/crm/autopilot').then((r) => { setF(r.data.settings); setCounts(r.data.counts || {}); }).catch(() => setF(null)); }, []);
  if (!f) return null;
  const setStep = (id, k, v) => setF({ ...f, steps: f.steps.map((s) => (s.id === id ? { ...s, [k]: v } : s)) });
  const setMeet = (k, v) => setF({ ...f, meeting: { ...f.meeting, [k]: v } });
  async function save(next = f) {
    setBusy(true);
    try { const r = await api.put('/crm/autopilot', next); setF(r.data.settings); toast(r.data.settings.on ? 'Saved. Automatic follow-through is on.' : 'Saved. Automatic follow-through is off.'); } catch (e) { toast(errOf(e, 'This could not be saved.')); } finally { setBusy(false); }
  }
  function flip() {
    if (!f.on && !window.confirm('Turn this on? From now on, every NEW lead gets real mails, SMS, WhatsApp and AI calls by itself. Leads you already have are not contacted.')) return;
    save({ ...f, on: !f.on });
  }
  return (
    <>
      <div className="section-label">Automatic follow-through</div>
      <div className="card" style={{ padding: 12, marginBottom: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 300px' }}>
          <b>{f.on ? 'On: new leads are worked automatically' : 'Off: nothing goes out by itself'}</b>
          <div className="small-muted" style={{ fontSize: 12 }}>{f.on ? `Working leads added since ${new Date(f.armedAt).toLocaleString('en-GB')}. Sent ${counts.sent || 0}, waiting ${counts.waiting || 0}, failed ${counts.failed || 0}.` : 'Only leads that arrive after you turn it on are contacted. Nothing goes in quiet hours, and anybody who opts out is left alone.'}</div>
        </div>
        <button type="button" className={`btn btn-sm${f.on ? '' : ' btn-primary'}`} disabled={busy} onClick={flip}>{f.on ? 'Turn off' : 'Turn on'}</button>
      </div>
      <p className="small-muted" style={{ marginTop: 0 }}>What a new lead gets. {'{name}'}, {'{company}'} and {'{owner}'} are filled in. It stops once the lead is past Contacted, Won or Lost, or somebody presses Stop on the lead.</p>
      {f.steps.map((s) => (
        <div key={s.id} style={{ borderBottom: '1px solid var(--line-soft)', padding: '8px 0' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 600, fontSize: 13, minWidth: 110 }}><input type="checkbox" checked={s.on} onChange={(e) => setStep(s.id, 'on', e.target.checked)} style={{ width: 'auto' }} />{WORDS[s.channel]}</label>
            <input type="number" min={0} max={720} value={s.afterHours} onChange={(e) => setStep(s.id, 'afterHours', Number(e.target.value))} aria-label={`Hours after the lead came, ${WORDS[s.channel]}`} style={{ width: 80 }} />
            <span className="small-muted" style={{ fontSize: 12 }}>{`hours after the lead came (${when(s.afterHours)})`}</span>
          </div>
          {s.subject !== undefined && <input type="text" value={s.subject} onChange={(e) => setStep(s.id, 'subject', e.target.value)} aria-label="Subject" placeholder="Subject" style={{ marginTop: 6 }} />}
          {s.body !== undefined && <textarea rows={2} value={s.body} onChange={(e) => setStep(s.id, 'body', e.target.value)} aria-label="Message" style={{ marginTop: 6 }} />}
        </div>
      ))}
      <div className="field" style={{ marginTop: 10 }}><label>What the AI says on the call</label><textarea rows={5} value={f.callScript} onChange={(e) => setF({ ...f, callScript: e.target.value })} /></div>
      <div className="section-label">Meetings</div>
      <label style={{ display: 'block', marginBottom: 8, fontSize: 13 }}><input type="checkbox" checked={f.meeting.on} onChange={(e) => setMeet('on', e.target.checked)} style={{ width: 'auto' }} /> Book meetings by themselves: a lead who says yes on the AI call, and customers every so often</label>
      <div className="grid-3">
        <div className="field"><label>Time of day</label><input type="time" value={f.meeting.time} onChange={(e) => setMeet('time', e.target.value)} /></div>
        <div className="field"><label>Length</label><select value={f.meeting.minutes} onChange={(e) => setMeet('minutes', Number(e.target.value))}>{[15, 30, 45, 60].map((m) => <option key={m} value={m}>{`${m} minutes`}</option>)}</select></div>
        <div className="field"><label>Customers: a check-in every (days, 0 = never)</label><input type="number" min={0} max={365} value={f.meeting.customerEveryDays} onChange={(e) => setMeet('customerEveryDays', Number(e.target.value))} /></div>
      </div>
      <div className="field"><label>Meeting link (Google Meet or Zoom room, optional)</label><input type="url" value={f.meeting.link} onChange={(e) => setMeet('link', e.target.value)} placeholder="https://meet.google.com/..." /></div>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => save()} style={{ marginBottom: 14 }}>Save automatic follow-through</button>
      <SalesAi />
    </>
  );
}

// The AI sales assistant (crm/salesAgent.js): a lead who writes back by WhatsApp, SMS or mail is answered by the AI, from what is written here only.
function SalesAi() {
  const { toast } = useCrm();
  const [a, setA] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/crm/sales-ai').then((r) => setA(r.data.settings)).catch(() => setA(null)); }, []);
  if (!a) return null;
  async function save(next = a) {
    setBusy(true);
    try { const r = await api.put('/crm/sales-ai', next); setA(r.data.settings); toast(r.data.settings.on ? 'Saved. The AI answers leads who write back.' : 'Saved. The AI assistant is off.'); } catch (e) { toast(errOf(e, 'This could not be saved.')); } finally { setBusy(false); }
  }
  function flip() {
    if (!a.on && !window.confirm('Turn the AI assistant on? From now on, a lead who replies by WhatsApp, SMS or mail gets an answer from the AI, using only what is written here.')) return;
    save({ ...a, on: !a.on });
  }
  return (
    <>
      <div className="section-label">AI assistant: answers leads who write back</div>
      <div className="card" style={{ padding: 12, marginBottom: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 300px' }}>
          <b>{a.on ? 'On: the AI answers replies on WhatsApp, SMS and mail' : 'Off: a person answers every reply'}</b>
          <div className="small-muted" style={{ fontSize: 12 }}>It says it is an AI assistant, answers only from the text below, and books a call when the lead agrees. When a person is needed it tells the lead someone will get back and gives the lead to its owner.</div>
        </div>
        <button type="button" className={`btn btn-sm${a.on ? '' : ' btn-primary'}`} disabled={busy} onClick={flip}>{a.on ? 'Turn off' : 'Turn on'}</button>
      </div>
      <div className="field"><label>What TeamLink does (the AI says nothing beyond this)</label><textarea rows={4} value={a.about} onChange={(e) => setA({ ...a, about: e.target.value })} /></div>
      <div className="field"><label>What may be said about price (no figure here = the AI never names one)</label><textarea rows={2} value={a.pricing} onChange={(e) => setA({ ...a, pricing: e.target.value })} /></div>
      <div className="field"><label>Questions and answers (optional, one per line: question - answer)</label><textarea rows={4} value={a.faq} onChange={(e) => setA({ ...a, faq: e.target.value })} placeholder="Do you hire for night shifts? - Yes, for IT support and medical roles." /></div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '4px 0 12px' }}>
        <input type="checkbox" checked={a.useClaude !== false} onChange={(e) => setA({ ...a, useClaude: e.target.checked })} style={{ width: 'auto', marginTop: 3 }} />
        <span><b>Use Claude for these replies and the AI meeting</b><span className="small-muted" style={{ display: 'block', fontSize: 12 }}>Fast and natural in English and Telugu; billed by Anthropic per meeting. Off: the server&apos;s own model answers (free, slower, weaker in Telugu). If Claude is not available, the server&apos;s model answers that turn by itself.</span></span>
      </label>
      <div className="field" style={{ maxWidth: 260 }}><label>AI answers per lead per day (then a person takes over)</label><input type="number" min={1} max={30} value={a.maxPerDay} onChange={(e) => setA({ ...a, maxPerDay: Number(e.target.value) })} /></div>
      <p className="small-muted" style={{ marginTop: 0 }}>Calls are booked at the meeting time and with the meeting link set above. Mail replies need the company mailbox connected in Administration → Integrations.</p>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => save()} style={{ marginBottom: 14 }}>Save AI assistant</button>
    </>
  );
}
