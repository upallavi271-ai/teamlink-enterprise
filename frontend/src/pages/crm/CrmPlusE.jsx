// ---------------------------------------------------------------------------
// CRM WAVE E SCREENS (2026-11-24): AI, mobile, activities & follow-ups. Everything here lives INSIDE the five CRM screens (no new sidebar item):
//   a record's AI box      the learned chance (AiPredict), the customer's mood (MoodChip), "Fill empty fields from a mail / card" (FillFromText)
//   a record's Calls tab   recorded browser calls with their summaries, "Summarise a call" (RecordCalls), field visit check-in (VisitButton)
//   a follow-up            repeat (RepeatPicker / RepeatLine), a video meeting link (VideoButton)
//   Leads                  "Scan a card / paste a mail" (AddLeadFromText)
//   Dashboard              the AI forecast (AiForecastCard) and unusual changes (AnomalyCard)
//   Follow-ups             Calendar: join Google / Microsoft (CalendarSyncCard); Visits (VisitsTab); "Install the app" (InstallAppCard)
//   CRM settings           the Admin switches and the AI's learning (PlusSettings)
// The server holds every rule (backend/src/routes/crmPlus.js and crm/plus.js, aiPredict.js, aiSignals.js, workPlus.js, calendarSync.js).
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { useCrm, errOf, money, dateOf, dateTimeOf, istToday, RecordForm, RecLink, DateField } from './crmShared.jsx'; // eslint-disable-line import/no-cycle
import { canPromptInstall, onInstallChange, promptInstall, isIos, isStandalone, pwaAvailable } from '../../pwa/pwa.js';
import { offlineState, onOfflineChange, syncOutbox } from './crmOffline.js';
import './CrmPlusE.css';

const pct = (n) => (n == null ? '—' : `${n}%`);
const tone = (p) => (p >= 60 ? 'var(--teal)' : p >= 30 ? 'var(--amber)' : 'var(--red)');
const MOOD_ICON = { Positive: '🙂', Neutral: '😐', Negative: '🙁' };

// ---- the learned chance (09.01 / 09.02) --------------------------------------------------------------------------------------------
export function AiPredict({ kind, id, refresh }) {
  const { me, toast } = useCrm();
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get(`/crm/pluse/ai/predict/${kind}/${id}`).then((r) => setD(r.data)).catch(() => setD(null));
  useEffect(() => { if (kind === 'lead' || kind === 'deal') load(); }, [kind, id, refresh]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d || d.closed) return null;
  async function retrain() {
    setBusy(true);
    try { await api.post('/crm/pluse/ai/train'); toast('The AI learned again from the closed records.'); load(); } catch (e) { toast(errOf(e, 'It could not learn now.')); } finally { setBusy(false); }
  }
  const word = kind === 'lead' ? 'likely to convert' : 'win chance';
  return (
    <div className="crmx-predict" data-testid="crm-ai-predict">
      {d.model.ready && d.probability != null ? (
        <>
          <div className="crmx-predict-num" style={{ color: tone(d.probability) }}>{d.probability}%</div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <b>{d.label}</b> <span className="small-muted" style={{ fontSize: 11.5 }}>({word}, learned from {d.model.samples} closed {kind}s · right {d.model.accuracy}% of the time)</span>
            {kind === 'deal' && <div className="small-muted" style={{ fontSize: 11.5 }}>History says {pct(d.modelProbability)}, the stage says {pct(d.stageProbability)}; both are joined.</div>}
            <div className="crmx-reasons">
              {d.reasons.up.map((r) => <span key={`u${r.why}`} className="crmx-up">▲ {r.why}</span>)}
              {d.reasons.down.map((r) => <span key={`d${r.why}`} className="crmx-down">▼ {r.why}</span>)}
            </div>
          </div>
        </>
      ) : (
        <div className="small-muted" style={{ fontSize: 12, flex: 1 }}>
          <b>Learned score:</b> {kind === 'deal' && d.probability != null ? `${d.probability}% by the stage for now. ` : 'not yet. '}{d.model.need}
        </div>
      )}
      {me.canAssign && <button type="button" className="btn btn-sm" disabled={busy} onClick={retrain} title="Learn again from every closed lead and deal">{busy ? 'Learning…' : 'Learn again'}</button>}
    </div>
  );
}

// ---- the customer's mood (09.10) ------------------------------------------------------------------------------------------------
export function MoodChip({ kind, id, refresh }) {
  const { toast } = useCrm();
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = (ai) => api.get(`/crm/pluse/ai/sentiment/${kind}/${id}`, { params: ai ? { ai: 1 } : {} }).then((r) => { setD(r.data); if (ai && r.data.ai) toast(r.data.ai.startsWith('The AI') ? r.data.ai : `Read again by ${r.data.ai}.`); }).catch(() => setD(null));
  useEffect(() => { if (kind !== 'contact') load(false); }, [kind, id, refresh]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d || !d.items.length) return null;
  const m = d.mood;
  return (
    <details className="crmx-mood" data-testid="crm-mood">
      <summary>
        <span className={`crmx-mood-chip ${String(m.label).toLowerCase().replace(/\s.*/, '')}`}>{MOOD_ICON[m.label] || '•'} Customer mood: {m.label}</span>
        {m.trend && <span className="small-muted" style={{ fontSize: 11.5 }}> · {m.trend}</span>}
        {m.intent && <span className="small-muted" style={{ fontSize: 11.5 }}> · {m.intent}</span>}
      </summary>
      <div style={{ padding: '6px 0 2px' }}>
        {d.items.slice(0, 8).map((x) => (
          <div key={x.id} style={{ fontSize: 12.5, padding: '2px 0' }}>
            {MOOD_ICON[x.sentiment.label]} <span className="small-muted">{dateOf(x.at)}</span> {x.subject || x.kind}{x.sentiment.intent ? <b style={{ fontWeight: 600 }}> · {x.sentiment.intent}</b> : null}
          </div>
        ))}
        <button type="button" className="crm-linkbtn" disabled={busy} onClick={() => { setBusy(true); load(true).finally(() => setBusy(false)); }}>{busy ? 'Reading…' : 'Read again with the AI'}</button>
      </div>
    </details>
  );
}

// ---- fill empty fields from text (09.12) ----------------------------------------------------------------------------------------
const FIELD_WORDS = { company: 'Company', name: 'Name', contactName: 'Contact person', designation: 'Designation', phone: 'Phone', email: 'Email', industry: 'Industry', city: 'City', website: 'Website', gstin: 'GSTIN', pincode: 'Pincode', expectedValue: 'Expected value', value: 'Deal value', expectedClose: 'Expected close', nextStep: 'Next step' };
export function FillFromText({ kind, id, onApplied }) {
  const { toast } = useCrm();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [sug, setSug] = useState(null);
  const [pick, setPick] = useState({});
  const [busy, setBusy] = useState(false);
  async function read() {
    setBusy(true);
    try { const r = await api.post(`/crm/pluse/ai/fill/${kind}/${id}`, { text }); setSug(r.data); setPick(Object.fromEntries(Object.keys(r.data.suggest).map((k) => [k, true]))); } catch (e) { toast(errOf(e, 'The text could not be read.')); } finally { setBusy(false); }
  }
  async function apply() {
    const fields = Object.fromEntries(Object.entries(sug.suggest).filter(([k]) => pick[k]));
    if (!Object.keys(fields).length) return;
    setBusy(true);
    try { await api.put(`/crm/${kind}s/${id}`, fields); toast('Filled in.'); setOpen(false); setSug(null); setText(''); if (onApplied) onApplied(); } catch (e) { toast(errOf(e, 'This could not be saved.')); } finally { setBusy(false); }
  }
  return (
    <>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)} title="Paste a mail, a signature or call notes: the AI fills the fields that are still empty">✨ Fill from a mail</button>
      {open && (
        <Modal title="Fill empty fields from a mail or notes" onClose={() => setOpen(false)} foot={<><button type="button" className="btn" onClick={() => setOpen(false)}>Close</button>{sug ? <button type="button" className="btn btn-primary" disabled={busy || !Object.values(pick).some(Boolean)} onClick={apply}>Apply</button> : <button type="button" className="btn btn-primary" disabled={busy || text.trim().length < 6} onClick={read}>{busy ? 'Reading…' : 'Read it'}</button>}</>}>
          {!sug && <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the customer's mail, their signature or your call notes" aria-label="Text to read" />}
          {sug && (
            <>
              {!Object.keys(sug.suggest).length && <div className="small-muted">Nothing new: every field it found is already filled.</div>}
              {Object.entries(sug.suggest).map(([k, v]) => (
                <label key={k} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', fontSize: 13 }}>
                  <input type="checkbox" checked={!!pick[k]} onChange={(e) => setPick({ ...pick, [k]: e.target.checked })} style={{ width: 'auto' }} />
                  <span style={{ minWidth: 120 }} className="small-muted">{FIELD_WORDS[k] || k}</span><b>{k === 'expectedValue' || k === 'value' ? money(v) : k === 'expectedClose' ? dateOf(v) : String(v)}</b>
                </label>
              ))}
              <div className="small-muted" style={{ fontSize: 11.5, marginTop: 6 }}>Read by {sug.by === 'code' ? 'TeamLink (no AI needed)' : sug.by}. {sug.note || ''} Only empty fields are offered; nothing is saved until you press Apply.</div>
            </>
          )}
        </Modal>
      )}
    </>
  );
}

// ---- a new lead from a card photo or a pasted mail (09.12, 14.04) ------------------------------------------------------------------
export function AddLeadFromText({ onSaved }) {
  const { toast } = useCrm();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState('');
  const [preset, setPreset] = useState(null);
  const [note, setNote] = useState('');
  const file = useRef(null);
  async function fromText() {
    setBusy('text');
    try { const r = await api.post('/crm/pluse/ai/extract', { text }); setNote(r.data.note || ''); setPreset({ source: '', ...r.data.lead }); setOpen(false); } catch (e) { toast(errOf(e, 'The text could not be read.')); } finally { setBusy(''); }
  }
  async function fromPhoto(f) {
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { toast('The photo is bigger than 8 MB.'); return; }
    setBusy('photo');
    try {
      const r = await api.post('/crm/pluse/ai/card', f, { headers: { 'Content-Type': f.type || 'application/octet-stream' } });
      setText(r.data.text || ''); setNote('From the card photo: check the fields, then Save.');
      setPreset({ ...r.data.lead }); setOpen(false);
    } catch (e) { toast(errOf(e, 'The photo could not be read.')); } finally { setBusy(''); if (file.current) file.current.value = ''; }
  }
  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)} title="Take a photo of a visiting card, or paste a mail / signature: the lead form is filled for you">📇 Scan card / paste</button>
      {open && (
        <Modal title="A new lead from a card or a mail" onClose={() => setOpen(false)} foot={<><button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button><button type="button" className="btn btn-primary" disabled={!!busy || text.trim().length < 6} onClick={fromText}>{busy === 'text' ? 'Reading…' : 'Fill the lead form'}</button></>}>
          <div className="crmx-card-pick">
            <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
              {busy === 'photo' ? 'Reading the card…' : '📷 Photo of a visiting card'}
              <input ref={file} type="file" accept="image/jpeg,image/png" capture="environment" style={{ display: 'none' }} onChange={(e) => fromPhoto(e.target.files && e.target.files[0])} aria-label="Photo of a visiting card" />
            </label>
            <span className="small-muted" style={{ fontSize: 12 }}>JPG or PNG, the card filling the picture.</span>
          </div>
          <div className="small-muted" style={{ margin: '10px 0 4px' }}>…or paste a mail, a signature or the card text:</div>
          <textarea rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Priya Menon\nTalent Acquisition Manager\nZen Solutions Pvt Ltd\n+91 99887 76655 · priya@zen.co.in'} aria-label="Mail or card text" />
        </Modal>
      )}
      {preset && (
        <>
          {note && <div className="toast-stack" role="status"><div className="toast">{note}</div></div>}
          <RecordForm kind="lead" preset={preset} onClose={() => setPreset(null)} onSaved={(row) => { setPreset(null); if (onSaved) onSaved(row); }} />
        </>
      )}
    </>
  );
}

// ---- recorded calls + a call summary (09.05) ------------------------------------------------------------------------------------
export function useDictation(onText) {
  const rec = useRef(null);
  const [on, setOn] = useState(false);
  const Ctor = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
  const start = () => {
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = 'en-IN'; r.interimResults = false; r.continuous = true;
    r.onresult = (e) => { const t = [...e.results].slice(e.resultIndex).map((x) => x[0].transcript).join(' '); if (t) onText(t); };
    r.onend = () => setOn(false); r.onerror = () => setOn(false);
    rec.current = r; r.start(); setOn(true);
  };
  const stop = () => { try { rec.current && rec.current.stop(); } catch { /* already stopped */ } setOn(false); };
  return { supported: !!Ctor, on, start, stop };
}
export function DictateButton({ onText }) {
  const d = useDictation(onText);
  if (!d.supported) return null;
  return <button type="button" className={`btn btn-sm${d.on ? ' btn-primary' : ''}`} onClick={d.on ? d.stop : d.start} title="Speak instead of typing (the phone writes it down)">{d.on ? '⏹ Stop' : '🎤 Speak'}</button>;
}
export function RecordCalls({ kind, id, canEdit, onChanged }) {
  const { toast } = useCrm();
  const [d, setD] = useState(null);
  const [text, setText] = useState('');
  const [mins, setMins] = useState('');
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState('');
  const load = () => api.get(`/crm/pluse/calls/${kind}/${id}`).then((r) => setD(r.data)).catch(() => setD({ calls: [], phones: [] }));
  useEffect(() => { load(); }, [kind, id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function link(c) {
    setBusy(c.id);
    try { await api.post(`/crm/pluse/calls/${c.id}/link`, { kind, id }); toast('The call is on the timeline.'); load(); if (onChanged) onChanged(); } catch (e) { toast(errOf(e, 'This could not be added.')); } finally { setBusy(''); }
  }
  async function summarise(save) {
    setBusy(save ? 'save' : 'sum');
    try {
      const r = await api.post(`/crm/pluse/ai/call-summary/${kind}/${id}`, { text, save, durationSec: mins ? Number(mins) * 60 : undefined });
      setOut(r.data);
      if (save) { toast(r.data.saved && r.data.saved.taskId ? 'Saved on the timeline, with the next follow-up.' : 'Saved on the timeline.'); setText(''); setMins(''); setOut(null); if (onChanged) onChanged(); }
    } catch (e) { toast(errOf(e, 'The call could not be summarised.')); } finally { setBusy(''); }
  }
  return (
    <div className="crm-two">
      <div>
        <div className="section-label" style={{ marginTop: 0 }}>Recorded calls to this customer</div>
        {!d && <div className="small-muted">Loading…</div>}
        {d && !d.calls.length && <div className="small-muted">{d.phones.length ? 'No recorded browser call to these numbers yet.' : 'This record has no phone number.'}</div>}
        {d && d.calls.map((c) => (
          <div key={c.id} className="card" style={{ padding: 10, marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <b style={{ fontSize: 13 }}>📞 {dateTimeOf(c.at)}</b>
              <span className="small-muted" style={{ fontSize: 12 }}>{c.by || ''}{c.talkSec ? ` · ${Math.max(1, Math.round(c.talkSec / 60))} min` : ''}{c.status ? ` · ${c.status}` : ''}</span>
              {c.onTimeline ? <span className="status active" style={{ marginLeft: 'auto', fontSize: 11 }}>On the timeline</span>
                : canEdit && <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} disabled={busy === c.id} onClick={() => link(c)}>Add to timeline</button>}
            </div>
            <div style={{ fontSize: 12.5, marginTop: 4, whiteSpace: 'pre-wrap' }}>{c.summary || <span className="small-muted">{c.recording === 'processing' || c.recording === 'pending' ? 'The summary is being made…' : 'No summary for this call.'}</span>}</div>
          </div>
        ))}
      </div>
      {canEdit && (
        <div>
          <div className="section-label" style={{ marginTop: 0 }}>Summarise a call</div>
          <div className="card" style={{ padding: 10 }}>
            <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="What was said on the call (type, paste a transcript, or press Speak)" aria-label="What was said on the call" />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
              <DictateButton onText={(t) => setText((x) => `${x}${x ? ' ' : ''}${t}`)} />
              <input type="number" min={0} max={240} value={mins} onChange={(e) => setMins(e.target.value)} placeholder="Minutes" aria-label="How many minutes" style={{ width: 90 }} />
              <button type="button" className="btn btn-sm" disabled={!!busy || text.trim().length < 15} onClick={() => summarise(false)}>{busy === 'sum' ? 'Reading…' : '✨ Summarise'}</button>
              <button type="button" className="btn btn-primary btn-sm" disabled={!!busy || text.trim().length < 15} onClick={() => summarise(true)}>{busy === 'save' ? 'Saving…' : 'Save as the call'}</button>
            </div>
            {out && (
              <div style={{ marginTop: 8, fontSize: 13 }}>
                <div style={{ whiteSpace: 'pre-wrap' }}>{out.summary}</div>
                {out.nextStep && <div><b>Next:</b> {out.nextStep}{out.nextDate ? ` (${dateOf(out.nextDate)})` : ''}</div>}
                <div className="small-muted" style={{ fontSize: 11.5 }}>Tone: {out.sentiment}{out.intent ? ` · ${out.intent}` : ''} · interest {out.interest} · by {out.by === 'code' ? 'TeamLink (no AI needed)' : out.by}</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- field visit check-in (05.12) -----------------------------------------------------------------------------------------------
const where = () => new Promise((resolve) => {
  if (!navigator.geolocation) { resolve({}); return; }
  navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }), () => resolve({}), { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
});
export function VisitButton({ kind, id, name, onChanged }) {
  const { me, toast } = useCrm();
  const [open, setOpen] = useState(null); // my open visit
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState(null); // the check-out form
  const load = () => api.get('/crm/pluse/visits', { params: { open: 1 } }).then((r) => setOpen(r.data.visits.find((v) => v.userId === me.userId) || null)).catch(() => setOpen(null));
  useEffect(() => { load(); }, [kind, id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (kind === 'contact') return null;
  const here = open && open.recordId === id;
  async function checkIn() {
    setBusy(true);
    try { const pos = await where(); await api.post('/crm/pluse/visits/check-in', { kind, id, ...pos }); toast(pos.lat != null ? `Checked in at ${name}.` : `Checked in at ${name} (the location was not shared).`); load(); if (onChanged) onChanged(); } catch (e) { toast(errOf(e, 'Could not check in.')); } finally { setBusy(false); }
  }
  async function checkOut() {
    setBusy(true);
    try { const pos = await where(); const r = await api.post(`/crm/pluse/visits/${open.id}/check-out`, { ...pos, outcome: out.outcome || undefined, note: out.note || undefined }); toast(`Checked out: ${r.data.visit.minutes} min at ${name}.`); setOut(null); load(); if (onChanged) onChanged(); } catch (e) { toast(errOf(e, 'Could not check out.')); } finally { setBusy(false); }
  }
  return (
    <>
      {here ? <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => setOut({ outcome: '', note: '' })}>📍 Check out</button>
        : <button type="button" className="btn btn-sm" disabled={busy || !!open} title={open ? `You are checked in at ${open.recordName}` : 'A field visit: TeamLink notes the time and where you are'} onClick={checkIn}>📍 Check in</button>}
      {out && (
        <Modal title={`Check out of ${name}`} onClose={() => setOut(null)} foot={<><button type="button" className="btn" onClick={() => setOut(null)}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={checkOut}>{busy ? 'Saving…' : 'Check out'}</button></>}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {me.lists.outcomes.map((o) => <button key={o} type="button" className={`btn btn-sm${out.outcome === o ? ' btn-primary' : ''}`} onClick={() => setOut({ ...out, outcome: out.outcome === o ? '' : o })}>{o}</button>)}
          </div>
          <textarea rows={3} value={out.note} onChange={(e) => setOut({ ...out, note: e.target.value })} placeholder="What happened at the visit" aria-label="What happened at the visit" />
          <div style={{ marginTop: 6 }}><DictateButton onText={(t) => setOut((x) => ({ ...x, note: `${x.note}${x.note ? ' ' : ''}${t}` }))} /></div>
        </Modal>
      )}
    </>
  );
}
export function VisitsTab() {
  const { me } = useCrm();
  const [from, setFrom] = useState(istToday());
  const [to, setTo] = useState(istToday());
  const [owner, setOwner] = useState('');
  const [d, setD] = useState(null);
  useEffect(() => { api.get('/crm/pluse/visits', { params: { from, to, owner: owner || undefined } }).then((r) => setD(r.data)).catch(() => setD({ visits: [], totals: {} })); }, [from, to, owner]);
  return (
    <div data-testid="crm-visits">
      <div className="filter-row">
        <DateField value={from} onChange={setFrom} aria-label="From" style={{ width: 150 }} />
        <DateField value={to} onChange={setTo} aria-label="To" style={{ width: 150 }} />
        {me.seesAll && <select value={owner} onChange={(e) => setOwner(e.target.value)} style={{ width: 'auto' }} aria-label="Salesperson"><option value="">Everyone</option>{(me.owners || []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
        {d && <span className="small-muted">{d.totals.visits || 0} visit(s) · {d.totals.minutes || 0} min{d.totals.open ? ` · ${d.totals.open} still checked in` : ''}</span>}
      </div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>When</th><th>Who</th><th>Where</th><th>Time spent</th><th>Outcome</th><th>Map</th></tr></thead>
          <tbody>
            {!d && <tr><td colSpan={6} className="small-muted">Loading…</td></tr>}
            {d && !d.visits.length && <tr><td colSpan={6}><div className="empty"><h3>No visits</h3>Press "📍 Check in" on a lead, deal or customer when you reach their office.</div></td></tr>}
            {d && d.visits.map((v) => (
              <tr key={v.id}>
                <td>{dateTimeOf(v.inAt)}</td>
                <td>{v.userName || '—'}</td>
                <td><RecLink kind={v.recordKind} id={v.recordId}>{v.recordName || 'Open'}</RecLink></td>
                <td>{v.outAt ? `${v.minutes} min` : <span className="status pending">Checked in</span>}</td>
                <td>{v.outcome || '—'}{v.note ? <div className="small-muted" style={{ fontSize: 11.5 }}>{v.note}</div> : null}</td>
                <td>{v.inMap ? <a href={v.inMap} target="_blank" rel="noopener noreferrer">In</a> : <span className="small-muted">not shared</span>}{v.outMap ? <> · <a href={v.outMap} target="_blank" rel="noopener noreferrer">Out</a></> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- repeating follow-ups (05.08) and the video meeting (05.11) -----------------------------------------------------------------
export const REPEAT_WORDS = { '': 'Does not repeat', daily: 'Every day', weekdays: 'Every working day', weekly: 'Every week', fortnightly: 'Every 2 weeks', monthly: 'Every month', quarterly: 'Every 3 months' };
export function RepeatPicker({ value, until, onChange }) {
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <select value={value} onChange={(e) => onChange(e.target.value, until)} style={{ width: 160 }} aria-label="Repeat">{Object.entries(REPEAT_WORDS).map(([k, v]) => <option key={k} value={k}>🔁 {v}</option>)}</select>
      {value && <><span>until</span><DateField value={until} min={istToday()} onChange={(d) => onChange(value, d)} style={{ width: 150 }} aria-label="Repeat until" /></>}
    </span>
  );
}
export function RepeatLine({ task, canEdit, onChanged }) {
  const { toast } = useCrm();
  if (!task.repeatRule || task.status !== 'Open') return null;
  const act = (url, body, words) => api.post(url, body).then(() => { toast(words); onChanged(); }).catch((e) => toast(errOf(e, 'This could not be changed.')));
  return (
    <span className="crmx-repeat" title={task.repeatUntil ? `Until ${dateOf(task.repeatUntil)}` : 'Repeats until stopped'}>
      🔁 {REPEAT_WORDS[task.repeatRule]}{task.repeatUntil ? ` until ${dateOf(task.repeatUntil)}` : ''}
      {canEdit && <> · <button type="button" className="crm-linkbtn" onClick={() => act(`/crm/pluse/tasks/${task.id}/skip`, {}, 'Skipped: the next one is made.')}>skip this one</button> · <button type="button" className="crm-linkbtn" onClick={() => act(`/crm/pluse/tasks/${task.id}/repeat`, { repeat: null }, 'It will not repeat any more.')}>stop repeating</button></>}
    </span>
  );
}
export function VideoButton({ task, onChanged }) {
  const { toast } = useCrm();
  const [open, setOpen] = useState(false);
  const [prov, setProv] = useState(null);
  const [busy, setBusy] = useState('');
  if (!task || task.type !== 'Meeting' || task.status !== 'Open') return null;
  if (task.meetingUrl) return <a className="btn btn-sm" href={task.meetingUrl} target="_blank" rel="noopener noreferrer" title={`${task.meetingProvider || 'Video'} meeting`} onClick={(e) => e.stopPropagation()}>📹 Join {task.meetingProvider || 'meeting'}</a>;
  async function show(e) { e.stopPropagation(); setOpen(true); if (!prov) api.get('/crm/pluse/video/providers').then((r) => setProv(r.data)).catch(() => setProv({ providers: [] })); }
  async function make(p) {
    setBusy(p);
    try { const r = await api.post(`/crm/pluse/tasks/${task.id}/video`, { provider: p }); toast(`${r.data.provider} meeting made. Send the invite from the follow-up.`); setOpen(false); if (onChanged) onChanged(); } catch (e) { toast(errOf(e, 'No meeting link was made.')); } finally { setBusy(''); }
  }
  return (
    <>
      <button type="button" className="btn btn-sm" onClick={show} title="Make a Zoom, Google Meet or Teams meeting for this follow-up">📹 Video link</button>
      {open && (
        <Modal title="Make a video meeting" onClose={() => setOpen(false)} foot={<button type="button" className="btn" onClick={() => setOpen(false)}>Close</button>}>
          <p className="small-muted" style={{ marginTop: 0 }}>For {dateOf(task.dueDate)}{task.dueTime ? ` at ${task.dueTime}` : ''}. Nobody is invited by the provider: the link is kept on the follow-up and goes into "Send invite".</p>
          {!prov && <div className="small-muted">Loading…</div>}
          {prov && prov.providers.map((p) => (
            <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <b style={{ minWidth: 130 }}>{p.name}</b><span className="small-muted" style={{ flex: 1, fontSize: 12 }}>{p.why}</span>
              <button type="button" className={`btn btn-sm${p.ready ? ' btn-primary' : ''}`} disabled={!p.ready || !!busy} onClick={() => make(p.id)}>{busy === p.id ? 'Making…' : 'Make'}</button>
            </div>
          ))}
        </Modal>
      )}
    </>
  );
}

// ---- the AI forecast (09.07) ------------------------------------------------------------------------------------------------------
const monthName = (ym) => { const d = new Date(`${ym}-01T00:00:00`); return Number.isNaN(d.getTime()) ? ym : d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }); };
export function AiForecastCard() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = (ai) => api.get('/crm/pluse/ai/forecast', { params: ai ? { ai: 1 } : {} }).then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'The forecast could not be made.')));
  useEffect(() => { load(false); }, []);
  if (err) return <div className="notice">{err}</div>;
  if (!d) return null;
  const max = Math.max(1, ...d.months.map((m) => m.high), ...d.history.map((h) => h.won));
  return (
    <div className="card crmx-forecast" data-testid="crm-ai-forecast">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
        <b>✨ AI forecast</b><span className="small-muted" style={{ fontSize: 11.5 }}>{d.scope === 'team' ? 'the whole team' : 'your deals'} · learned win chances + the recent pace</span>
        <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => { setBusy(true); load(true).finally(() => setBusy(false)); }}>{busy ? 'Thinking…' : 'Explain with AI'}</button>
      </div>
      <div className="crmx-fc-months">
        {d.months.map((m) => (
          <div key={m.month} className="crmx-fc-month">
            <div className="small-muted" style={{ fontSize: 11.5 }}>{monthName(m.month)}</div>
            <div className="crmx-fc-big">{money(m.forecast)}</div>
            <div className="small-muted" style={{ fontSize: 11 }}>{money(m.low)} – {money(m.high)}</div>
            <div className="small-muted" style={{ fontSize: 11 }}>by stage %: {money(m.stageWeighted)}</div>
          </div>
        ))}
      </div>
      <div className="crmx-fc-bars" aria-label="Won per month, then the forecast">
        {d.history.slice(-6).map((h) => <div key={h.month} title={`${monthName(h.month)}: won ${money(h.won)}`}><span style={{ height: `${Math.round((h.won / max) * 100)}%` }} /><i>{monthName(h.month).slice(0, 3)}</i></div>)}
        {d.months.map((m) => <div key={m.month} className="f" title={`${monthName(m.month)}: likely ${money(m.forecast)}`}><span style={{ height: `${Math.round((m.forecast / max) * 100)}%` }} /><i>{monthName(m.month).slice(0, 3)}</i></div>)}
      </div>
      {d.story.map((s) => <div key={s} style={{ fontSize: 12.5, padding: '1px 0' }}>{s}</div>)}
      {d.aiText && <div className="card" style={{ padding: 8, marginTop: 6, fontSize: 13, whiteSpace: 'pre-wrap' }}>{d.aiText}</div>}
      {d.aiError && <div className="small-muted" style={{ fontSize: 11.5, marginTop: 4 }}>{d.aiError}</div>}
      {d.top.length > 0 && (
        <details style={{ marginTop: 6 }}><summary className="small-muted" style={{ cursor: 'pointer', fontSize: 12 }}>The deals that count most</summary>
          {d.top.map((t) => <div key={t.id} style={{ fontSize: 12.5 }}><RecLink kind="deal" id={t.id}>{t.title}</RecLink> <span className="small-muted">· {money(t.value)} at {t.chance}% · {monthName(t.month)}</span></div>)}
        </details>
      )}
    </div>
  );
}

// ---- unusual changes (09.13) ------------------------------------------------------------------------------------------------------
export function AnomalyCard() {
  const [d, setD] = useState(null);
  const [hide, setHide] = useState(false);
  useEffect(() => { api.get('/crm/pluse/ai/anomalies').then((r) => setD(r.data)).catch(() => setD(null)); }, []);
  if (!d || !d.alerts.length || hide) return null;
  return (
    <div className="card crmx-anomaly" role="status" data-testid="crm-anomalies">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><b>📈 Unusual changes last week</b><span className="small-muted" style={{ fontSize: 11.5 }}>against the 8 weeks before</span><button type="button" className="close-x" style={{ marginLeft: 'auto' }} onClick={() => setHide(true)} aria-label="Hide">×</button></div>
      {d.alerts.slice(0, 6).map((a) => <div key={`${a.metric}${a.text}`} style={{ fontSize: 13, padding: '2px 0', color: a.good ? 'var(--teal)' : a.severity === 'high' ? 'var(--red)' : undefined }}>{a.direction === 'up' ? '▲' : '▼'} {a.text}</div>)}
    </div>
  );
}

// ---- the calendar (05.04) -------------------------------------------------------------------------------------------------------
export function CalendarSyncCard() {
  const { toast } = useCrm();
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState('');
  const [busyEv, setBusyEv] = useState([]);
  const load = () => {
    api.get('/crm/pluse/calendar/status').then((r) => setD(r.data)).catch(() => setD(null));
    const t = istToday(); const t7 = new Date(Date.parse(`${t}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
    api.get('/crm/pluse/calendar/busy', { params: { from: t, to: t7 } }).then((r) => setBusyEv(r.data.events)).catch(() => setBusyEv([]));
  };
  useEffect(() => {
    load();
    const q = new URLSearchParams(window.location.search);
    if (q.get('calendar') === 'connected') toast('Your calendar is joined. Follow-ups go there now, and moves come back.');
    if (q.get('calendar') === 'failed') toast(`The calendar could not be joined (${q.get('why') || 'try again'}).`);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return null;
  async function join(p) {
    setBusy(p);
    try { const r = await api.get(`/crm/pluse/calendar/connect/${p}`); window.location.href = r.data.url; } catch (e) { toast(errOf(e, 'The calendar could not be joined.')); setBusy(''); }
  }
  async function sync() {
    setBusy('sync');
    try { const r = await api.post('/crm/pluse/calendar/sync'); const x = Object.values(r.data.result)[0] || {}; toast(x.error ? `Sync: ${x.error}` : `Synced: ${x.pushed || 0} added, ${x.updated || 0} moved, ${x.pulled || 0} moved from the calendar, ${x.removed || 0} taken off.`); load(); } catch (e) { toast(errOf(e, 'The sync did not work.')); } finally { setBusy(''); }
  }
  async function leave(p) {
    if (!window.confirm('Disconnect this calendar? The events already there stay; nothing new goes there.')) return; // eslint-disable-line no-alert
    await api.delete(`/crm/pluse/calendar/${p}`).catch(() => null); load();
  }
  const joined = Object.entries(d.providers).filter(([, p]) => p.joined);
  return (
    <div className="card crmx-cal" data-testid="crm-calendar-sync">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b>🗓 My Google / Outlook calendar</b>
        {!d.enabled && <span className="small-muted" style={{ fontSize: 12 }}>Calendar sync is off. An Admin turns it on in CRM settings.</span>}
        {d.enabled && Object.entries(d.providers).map(([k, p]) => (p.joined
          ? <span key={k} className="status active" title={p.lastError || ''}>{p.name}: {p.email || 'joined'}{p.syncedAt ? ` · synced ${dateTimeOf(p.syncedAt)}` : ''} <button type="button" className="crm-linkbtn" onClick={() => leave(k)}>disconnect</button></span>
          : <button key={k} type="button" className="btn btn-sm" disabled={!p.configured || !!busy} title={p.configured ? '' : 'An Admin adds the OAuth app in Administration → Integrations → CRM calendar sync'} onClick={() => join(k)}>{busy === k ? 'Opening…' : `Join ${p.name}`}</button>))}
        {d.enabled && joined.length > 0 && <button type="button" className="btn btn-sm btn-primary" style={{ marginLeft: 'auto' }} disabled={!!busy} onClick={sync}>{busy === 'sync' ? 'Syncing…' : 'Sync now'}</button>}
      </div>
      {joined.some(([, p]) => p.lastError) && <div className="small-muted" style={{ color: 'var(--red)', fontSize: 12, marginTop: 4 }}>{joined.map(([, p]) => p.lastError).filter(Boolean).join(' ')}</div>}
      {busyEv.length > 0 && (
        <details style={{ marginTop: 6 }}><summary className="small-muted" style={{ cursor: 'pointer', fontSize: 12 }}>Busy in my calendar this week ({busyEv.length})</summary>
          {busyEv.map((e) => <div key={`${e.provider}${e.startAt}${e.title}`} style={{ fontSize: 12.5 }}>{dateOf(e.date)} {e.time || 'all day'} · {e.title}{e.leadId ? <> · <RecLink kind="lead" id={e.leadId}>{e.leadName}</RecLink></> : null}{e.contactName ? ` · ${e.contactName}` : ''}</div>)}
        </details>
      )}
    </div>
  );
}

// ---- install the app (14.01) --------------------------------------------------------------------------------------------------
export function InstallAppCard() {
  const [can, setCan] = useState(canPromptInstall());
  const [gone, setGone] = useState(() => { try { return localStorage.getItem('tl_crm_install_hide') === '1'; } catch { return false; } });
  useEffect(() => onInstallChange(() => setCan(canPromptInstall())), []);
  if (!pwaAvailable || isStandalone() || gone || (!can && !isIos())) return null;
  const hide = () => { setGone(true); try { localStorage.setItem('tl_crm_install_hide', '1'); } catch { /* storage blocked */ } };
  return (
    <div className="card crmx-install">
      <span aria-hidden="true">📲</span>
      <div style={{ flex: 1, minWidth: 180, fontSize: 13 }}><b>TeamLink on your phone</b><div className="small-muted" style={{ fontSize: 12 }}>{can ? 'Opens like an app, with the CRM follow-ups and a new lead one tap away. Works with weak signal.' : 'iPhone: tap Share, then "Add to Home Screen".'}</div></div>
      {can && <button type="button" className="btn btn-primary btn-sm" onClick={() => promptInstall()}>Install</button>}
      <button type="button" className="close-x" onClick={hide} aria-label="Hide">×</button>
    </div>
  );
}

// ---- offline (14.03) --------------------------------------------------------------------------------------------------------------
export function OfflineBar() {
  const [s, setS] = useState(offlineState());
  useEffect(() => onOfflineChange(() => setS(offlineState())), []);
  if (s.online && !s.waiting && !s.failed.length && !s.servedFromCopy) return null;
  return (
    <div className={`crmx-offline${s.online ? '' : ' off'}`} role="status" data-testid="crm-offline-bar">
      {!s.online ? <b>You are offline.</b> : s.servedFromCopy ? <b>The server could not be reached.</b> : <b>Back online.</b>}
      {s.servedFromCopy && <span> Showing the copy saved {s.copyAt ? dateTimeOf(new Date(s.copyAt).toISOString()) : 'earlier'}.</span>}
      {s.waiting > 0 && <span> {s.waiting} change{s.waiting === 1 ? '' : 's'} waiting to be sent.</span>}
      {s.failed.length > 0 && <span style={{ color: 'var(--red)' }}> {s.failed.length} change{s.failed.length === 1 ? '' : 's'} could not be saved: {s.failed[0]}</span>}
      {s.online && s.waiting > 0 && <button type="button" className="btn btn-sm" onClick={() => syncOutbox()}>Send now</button>}
    </div>
  );
}

// ---- CRM settings: the switches (Admin) and the AI's learning ------------------------------------------------------------------
const SWITCHES = [
  ['calendarSync', 'Calendar sync: people may join their Google / Outlook calendar; follow-ups go there and moves come back (every 10 minutes)'],
  ['autoLinkCalls', 'Write recorded browser calls (with their summary) on the lead whose number was called, by themselves'],
  ['anomalyAlerts', 'Monday 10:00: tell the Sales managers about unusual changes of last week (one bell notice)'],
  ['visitNeedsLocation', 'A field visit check-in must share the phone\'s location'],
  ['offlineCopy', 'Keep a copy of the CRM lists on the phone, to read with no signal (cleared at sign-out)'],
];
export function PlusSettings() {
  const { toast } = useCrm();
  const [d, setD] = useState(null);
  const [cal, setCal] = useState(null);
  const [model, setModel] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get('/crm/pluse/plus-settings').then((r) => setD(r.data)).catch(() => setD(null));
    api.get('/crm/pluse/calendar/status').then((r) => setCal(r.data)).catch(() => setCal(null));
    api.get('/crm/pluse/ai/model').then((r) => setModel(r.data)).catch(() => setModel(null));
  }, []);
  if (!d || !d.canSee) return null;
  async function save(patch) {
    setBusy(true);
    try { const r = await api.put('/crm/pluse/plus-settings', { ...d.settings, ...patch }); setD({ ...d, settings: r.data.settings }); toast('Saved.'); } catch (e) { toast(errOf(e, 'This could not be saved.')); } finally { setBusy(false); }
  }
  const S = d.settings;
  return (
    <div data-testid="crm-plus-settings">
      <div className="section-label">Calendar, video and AI switches</div>
      {!d.canChange && <p className="small-muted" style={{ marginTop: 0 }}>Only an Admin turns these on or off.</p>}
      {SWITCHES.map(([k, words]) => (
        <label key={k} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', margin: '0 0 8px', fontWeight: 500 }}>
          <input type="checkbox" checked={!!S[k]} disabled={!d.canChange || busy} onChange={(e) => save({ [k]: e.target.checked })} style={{ width: 'auto', marginTop: 3 }} /> {words}
        </label>
      ))}
      <div className="grid-2">
        <div className="field"><label>"Video link" uses first</label><select value={S.videoProvider} disabled={!d.canChange || busy} onChange={(e) => save({ videoProvider: e.target.value })}><option value="">Ask each time</option><option value="zoom">Zoom</option><option value="meet">Google Meet</option><option value="teams">Microsoft Teams</option></select></div>
        <div className="field"><label>A meeting / calendar slot is</label><select value={S.meetingMinutes} disabled={!d.canChange || busy} onChange={(e) => save({ meetingMinutes: Number(e.target.value) })}>{[15, 30, 45, 60, 90].map((m) => <option key={m} value={m}>{m} minutes</option>)}</select></div>
      </div>
      {cal && cal.redirect && (
        <div className="small-muted" style={{ fontSize: 12, marginBottom: 8 }}>
          Register these addresses in the Google / Microsoft OAuth app (Administration → Integrations → CRM calendar sync holds the client ID and secret): <code>{cal.redirect.google}</code> and <code>{cal.redirect.microsoft}</code>.
          {!cal.providers.google.configured && !cal.providers.microsoft.configured && ' No OAuth app is saved yet.'}
        </div>
      )}
      {model && (
        <div className="small-muted" style={{ fontSize: 12, marginBottom: 8 }}>
          AI learning: leads {model.lead.ready ? `learned from ${model.lead.samples} (right ${model.lead.accuracy}%)` : model.lead.need}; deals {model.deal.ready ? `learned from ${model.deal.samples} (right ${model.deal.accuracy}%)` : model.deal.need}
        </div>
      )}
    </div>
  );
}
