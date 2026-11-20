import { useEffect, useState } from 'react';
import api from '../../api';
import StatusChip from '../ui/StatusChip.jsx';
import './reminders.css';

// ---------------------------------------------------------------------------
// Administration > Step timing > "Automatic messages on ATS events" (the Candidate Follow-up Scheduler, founder 2026-11-20).
// Per trigger: on / off (ALL OFF until the founder switches them on), the way, the words, the timing (a delay after the event; a repeat every X
// at most N times until the condition ends; or messages before the interview / joining). The interview and joining reminders above keep working
// as they are. Every message these make shows on ATS > Scheduled Messages with its reason, and stops by itself when it no longer applies
// (the candidate replied, was rejected, withdrew, joined, the interview moved, the documents arrived). (backend: /api/ats/scheduled-messages/triggers)
// ---------------------------------------------------------------------------
const UNIT_WORD = { minutes: 'minutes', hours: 'hours', days: 'days' };

export default function AtsTriggersSettings() {
  const [d, setD] = useState(null);
  const [form, setForm] = useState(null);
  const [open, setOpen] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get('/ats/scheduled-messages/triggers').then((r) => { setD(r.data); setForm(JSON.parse(JSON.stringify(r.data.triggers))); }).catch(() => setD(null));
  }, []);
  if (!d || !form) return null;
  const edit = d.canEdit;
  const set = (k, p) => setForm({ ...form, [k]: { ...form[k], ...p } });
  const on = d.definitions.filter((t) => form[t.key].enabled).length;
  async function save() {
    setBusy(true); setMsg(''); setErr('');
    try { const r = await api.put('/ats/scheduled-messages/triggers', { triggers: form }); setForm(JSON.parse(JSON.stringify(r.data.triggers))); setMsg(r.data.message); } catch (e) { setErr(e.response?.data?.error || 'Could not save. Try again.'); } finally { setBusy(false); }
  }
  const num = (k, path, v) => {
    const t = form[k];
    if (path === 'count') set(k, { count: Number(v) });
    else set(k, { [path[0]]: { ...t[path[0]], [path[1]]: path[1] === 'value' ? Number(v) : v } });
  };
  return (
    <div className="panel" data-testid="ats-triggers">
      <div className="panel-head">
        <h3>Automatic messages on ATS events</h3>
        {on ? <StatusChip tone="green">{`${on} on`}</StatusChip> : <StatusChip tone="amber">All off</StatusChip>}
        {edit && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>}
      </div>
      <div style={{ padding: '8px 18px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="small-muted">
          When something happens in the ATS (a candidate is added, an interview is booked, documents are requested ...), the system can schedule a message to the candidate by itself.
          Each one is OFF until you switch it on. The messages show on ATS &gt; Scheduled Messages and stop by themselves when they no longer apply: the candidate replied (follow-ups), was rejected (interview messages),
          withdrew or did not join (all of that application), joined (joining reminders), the interview moved (new ones for the new time), the documents or the client&apos;s feedback came in.
          The interview and joining reminders above keep working as they are; switch on only one of the two for interviews.
        </div>
        {d.definitions.map((t) => {
          const v = form[t.key];
          return (
            <div key={t.key} className="rem-box" data-testid={`trigger-${t.key}`}>
              <div className="rem-actions" style={{ alignItems: 'center' }}>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" disabled={!edit} checked={!!v.enabled} onChange={(e) => set(t.key, { enabled: e.target.checked })} aria-label={`${t.label} on or off`} />
                  <b>{t.label}</b>
                </label>
                <span className="small-muted">{t.event}</span>
                {t.noResponse && <span className="small-muted">(stops when the candidate replies)</span>}
                <select disabled={!edit} value={v.channel} aria-label={`${t.label} way`} onChange={(e) => set(t.key, { channel: e.target.value })}>{['WhatsApp', 'SMS', 'Email'].map((c) => <option key={c} value={c}>{c}</option>)}</select>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(open === t.key ? '' : t.key)}>{open === t.key ? 'Hide' : 'Timing and words'}</button>
              </div>
              <div className="small-muted" style={{ fontSize: 12 }}>
                {t.mode === 'before' && `${v.offsets.map((o) => `${o.value} ${o.unit} before`).join(' and ')}`}
                {t.mode === 'after' && (v.delay.value ? `${v.delay.value} ${UNIT_WORD[v.delay.unit]} after` : 'At once')}
                {t.mode === 'repeat' && `${v.delay.value ? `${v.delay.value} ${UNIT_WORD[v.delay.unit]} after` : 'At once'}, then every ${v.every.value} ${v.every.unit}, at most ${v.count} message${v.count === 1 ? '' : 's'}`}
              </div>
              {open === t.key && (
                <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
                  {t.mode !== 'before' && (
                    <div className="rem-actions" style={{ alignItems: 'center' }}>
                      <span className="small-muted">First message</span>
                      <input type="number" min="0" max="720" style={{ width: 64 }} disabled={!edit} value={v.delay.value} aria-label="Delay" onChange={(e) => num(t.key, ['delay', 'value'], e.target.value)} />
                      <select disabled={!edit} value={v.delay.unit} aria-label="Delay unit" onChange={(e) => num(t.key, ['delay', 'unit'], e.target.value)}><option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option></select>
                      <span className="small-muted">after the event (0 = at once)</span>
                    </div>
                  )}
                  {t.mode === 'repeat' && (
                    <div className="rem-actions" style={{ alignItems: 'center' }}>
                      <span className="small-muted">Then every</span>
                      <input type="number" min="1" max="90" style={{ width: 64 }} disabled={!edit} value={v.every.value} aria-label="Repeat every" onChange={(e) => num(t.key, ['every', 'value'], e.target.value)} />
                      <select disabled={!edit} value={v.every.unit} aria-label="Repeat unit" onChange={(e) => num(t.key, ['every', 'unit'], e.target.value)}><option value="hours">hours</option><option value="days">days</option></select>
                      <span className="small-muted">at most</span>
                      <input type="number" min="1" max="10" style={{ width: 56 }} disabled={!edit} value={v.count} aria-label="At most" onChange={(e) => num(t.key, 'count', e.target.value)} />
                      <span className="small-muted">messages</span>
                    </div>
                  )}
                  {t.mode === 'before' && (
                    <div className="rem-actions" style={{ alignItems: 'center' }}>
                      {v.offsets.map((o, i) => (
                        // eslint-disable-next-line react/no-array-index-key
                        <span key={i} className="rem-actions" style={{ alignItems: 'center' }}>
                          <input type="number" min="1" max="30" style={{ width: 56 }} disabled={!edit} value={o.value} aria-label="Before" onChange={(e) => set(t.key, { offsets: v.offsets.map((x, j) => (j === i ? { ...x, value: Number(e.target.value) } : x)) })} />
                          <select disabled={!edit} value={o.unit} aria-label="Before unit" onChange={(e) => set(t.key, { offsets: v.offsets.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)) })}><option value="hours">hours</option><option value="days">days</option></select>
                          <span className="small-muted">before</span>
                          {edit && v.offsets.length > 1 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => set(t.key, { offsets: v.offsets.filter((_, j) => j !== i) })}>Remove</button>}
                        </span>
                      ))}
                      {edit && v.offsets.length < 3 && <button type="button" className="btn btn-sm" onClick={() => set(t.key, { offsets: [...v.offsets, { value: 2, unit: 'hours' }] })}>+ Add</button>}
                    </div>
                  )}
                  {v.channel === 'Email' && <label style={{ display: 'grid', gap: 2 }}><span className="small-muted">Subject</span><input disabled={!edit} value={v.subject} onChange={(e) => set(t.key, { subject: e.target.value })} /></label>}
                  <label style={{ display: 'grid', gap: 2 }}>
                    <span className="small-muted">{`Message. Placeholders: {name} {recruiter} {company} {requirement} {client}${['interview', 'joining'].includes(t.group) ? ` {${t.group === 'joining' ? 'joining_date' : 'interview_date} {interview_time'}}` : ''}`}</span>
                    <textarea rows={3} disabled={!edit} value={v.body} onChange={(e) => set(t.key, { body: e.target.value })} />
                  </label>
                  {edit && v.body !== t.defaultBody && <div><button type="button" className="btn btn-sm btn-ghost" onClick={() => set(t.key, { body: t.defaultBody })}>Use the standard words</button></div>}
                </div>
              )}
            </div>
          );
        })}
        {msg && <div className="notice">{msg}</div>}
        {err && <div className="error-text">{err}</div>}
      </div>
    </div>
  );
}
