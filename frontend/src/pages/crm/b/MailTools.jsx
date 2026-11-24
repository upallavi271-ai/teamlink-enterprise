// CRM wave B (2026-11-24) - the extra tools of the Call / WhatsApp / Email window of a record (CrmContact.jsx):
//   TemplatePicker  fill the message from a template (merge fields filled on the server for this record); "Save as template"
//   SendLater       the same message at a date and time (switch "Send later")
//   SmsPanel        an SMS from the record through the SMS gateway
//   OfficeCall      a call from the browser on the office SIM lines (recorded, transcribed, written on the timeline by itself)
import { useEffect, useState } from 'react';
import api from '../../../api';
import { useCrm, errOf } from '../crmShared.jsx';
import { useBrowserCall } from '../../../components/browsercall/CallProvider.jsx';
import { inHour, localToIso } from './bShared.jsx';

export function TemplatePicker({ record, channel = 'email', subject, text, onFill }) {
  const { toast } = useCrm();
  const [list, setList] = useState(null);
  const [saving, setSaving] = useState(false);
  const load = () => api.get('/crm/b/templates', { params: { channel } }).then((r) => setList(r.data.templates)).catch(() => setList([]));
  useEffect(() => { load(); }, [channel]); // eslint-disable-line react-hooks/exhaustive-deps
  async function pick(id) {
    if (!id) return;
    try { const r = await api.post(`/crm/b/templates/${id}/render`, { kind: record.kind, id: record.id }); onFill(r.data.subject, r.data.text); toast('Template filled in. Check it before sending.'); } catch (e) { toast(errOf(e, 'The template could not be used.')); }
  }
  async function saveAs() {
    const name = window.prompt('Name of the template (you can use {first_name}, {company}, {sender} in the text):');
    if (!name) return;
    setSaving(true);
    try { await api.post('/crm/b/templates', { name, channel, subject, body: text }); toast('Saved as your template.'); load(); } catch (e) { toast(errOf(e, 'The template could not be saved.')); } finally { setSaving(false); }
  }
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <select value="" onChange={(e) => pick(e.target.value)} aria-label="Use a template" style={{ width: 'auto' }}>
        <option value="">{list && !list.length ? 'No templates yet' : 'Use a template…'}</option>
        {(list || []).map((t) => <option key={t.id} value={t.id}>{t.shared ? '👥 ' : ''}{t.name}</option>)}
      </select>
      <button type="button" className="btn btn-sm" disabled={saving || !String(text || '').trim()} onClick={saveAs} title="Keep this message as a template for next time">Save as template</button>
    </span>
  );
}

export function SendLater({ record, channel, to, subject, text, onDone }) {
  const { toast } = useCrm();
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState(inHour());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function go() {
    setBusy(true); setErr('');
    try {
      await api.post('/crm/b/schedule', { kind: record.kind, id: record.id, channel, to, subject, text, sendAt: localToIso(when) });
      toast(`Scheduled: it goes ${new Date(when).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}.`);
      setOpen(false); if (onDone) onDone();
    } catch (e) { setErr(errOf(e, 'It could not be scheduled.')); } finally { setBusy(false); }
  }
  if (!open) return <button type="button" className="btn" onClick={() => setOpen(true)} disabled={!String(text || '').trim()} title="Send it at a date and time you pick">🕒 Send later</button>;
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Send at" style={{ width: 'auto' }} />
      <button type="button" className="btn btn-primary btn-sm" disabled={busy || !when} onClick={go}>{busy ? 'Saving…' : 'Schedule'}</button>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>Cancel</button>
      {err && <span style={{ color: 'var(--red)', fontSize: 12.5 }} role="alert">{err}</span>}
    </span>
  );
}

export function SmsPanel({ record, phone, onDone }) {
  const { toast } = useCrm();
  const [ready, setReady] = useState(null);
  const [to, setTo] = useState(phone || '');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { api.get('/crm/b/sms/ready').then((r) => setReady(r.data)).catch(() => setReady({ ready: false, reason: 'Could not read the SMS gateway.' })); }, []);
  useEffect(() => { setTo(phone || ''); }, [phone]);
  async function send() {
    setBusy(true); setErr(''); setNote('');
    try { const r = await api.post('/crm/b/sms', { kind: record.kind, id: record.id, to, text }); toast(`SMS sent to ${r.data.to}.`); setNote(r.data.sandbox ? 'Test server: accepted, not really sent.' : `Sent to ${r.data.to}. It is on the timeline.`); setText(''); if (onDone) onDone(); } catch (e) { setErr(errOf(e, 'The SMS was not sent.')); } finally { setBusy(false); }
  }
  return (
    <>
      {ready && !ready.ready && <div className="notice" role="status" style={{ marginBottom: 10, fontSize: 13, borderColor: 'var(--amber, #d97706)' }}>SMS is not connected: {ready.reason} An Admin connects an SMS gateway (with a DLT-approved template) in Administration → Integrations → SMS Gateway.</div>}
      {err && <div className="notice" role="alert" style={{ color: 'var(--red)', marginBottom: 10 }}>{err}</div>}
      {note && <div className="notice" role="status" style={{ marginBottom: 10, borderColor: 'var(--green, #16a34a)' }}>{note}</div>}
      <div className="field"><label>To (mobile number)</label><input value={to} onChange={(e) => setTo(e.target.value)} placeholder="98765 43210" aria-label="SMS number" /></div>
      <div className="field"><label>Message <span className="small-muted">({text.length}/160 a part)</span></label><textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} aria-label="SMS message" /></div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="btn btn-primary" disabled={busy || !text.trim() || !to.trim()} onClick={send}>{busy ? 'Sending…' : 'Send SMS'}</button>
        <TemplatePicker record={record} channel="sms" text={text} onFill={(s, t) => setText(t)} />
        <SendLater record={record} channel="SMS" to={to} text={text} />
      </div>
      <div className="small-muted" style={{ marginTop: 6, fontSize: 11.5 }}>In India an SMS goes out only inside the company's DLT-approved template; your words are its blank.</div>
    </>
  );
}

export function OfficeCall({ record, to, onDone }) {
  const bc = useBrowserCall();
  const [st, setSt] = useState(null);
  useEffect(() => { api.get('/crm/b/calls/status').then((r) => setSt(r.data)).catch(() => setSt({ canCall: false, reason: 'Could not read the phone lines.' })); }, []);
  if (!st) return null;
  if (!st.canCall) return <div className="small-muted" style={{ fontSize: 12, marginBottom: 8 }}>Office line from the browser: {st.reason}</div>;
  const can = bc && typeof bc.callCrm === 'function';
  return (
    <div className="card" style={{ padding: 10, marginBottom: 10 }}>
      <div className="small-muted" style={{ fontSize: 12.5, marginBottom: 6 }}>Call from this browser on the office line{st.lines.length > 1 ? 's' : ''} ({st.lines.map((l) => l.name).join(', ')}){st.testMode ? ' · Test mode: only the test numbers' : ''}{st.recording ? '. The call is recorded and what was said is written on the timeline.' : '.'}</div>
      <button type="button" className="btn btn-primary" disabled={!can || !String(to || '').replace(/\D/g, '')} onClick={() => { bc.callCrm({ kind: record.kind, id: record.id, name: record.name, to }); if (onDone) onDone(); }}>🎧 Call from the browser</button>
    </div>
  );
}
