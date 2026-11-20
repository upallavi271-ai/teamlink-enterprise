import { useEffect, useState } from 'react';
import api from '../../api';
import StatusChip from '../ui/StatusChip.jsx';
import './reminders.css';

// ---------------------------------------------------------------------------
// Administration > Step timing > "Interview and joining reminders to candidates" (founder 2026-11-20).
//   the one switch (OFF until the founder has checked one test message), the ways allowed, the earliest / latest hour,
//   the default steps (2 days before 10:00 ...) for an interview and a joining, per department, and the words in English and Telugu.
// (backend: /api/ats/reminders/settings, /templates, /test; utils/scheduledReminders.js)
// ---------------------------------------------------------------------------
const WAYS = [['WhatsApp', 'WhatsApp'], ['SMS', 'SMS'], ['Email', 'Email']];
const clone = (x) => JSON.parse(JSON.stringify(x));

function StepList({ steps, onChange, edit, max }) {
  const set = (i, p) => onChange(steps.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const kindOf = (s) => (s.hours ? 'hours' : 'days');
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {steps.map((s, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <div key={i} className="rem-actions" style={{ alignItems: 'center' }}>
          <select disabled={!edit} value={kindOf(s)} aria-label="Kind of step" onChange={(e) => onChange(steps.map((x, j) => (j === i ? (e.target.value === 'hours' ? { hours: 2 } : { days: 1, at: '17:00' }) : x)))}>
            <option value="days">Days before, at a time</option>
            <option value="hours">Hours before</option>
          </select>
          {s.hours ? (
            <><input type="number" min="1" max="48" disabled={!edit} style={{ width: 60 }} value={s.hours} aria-label="Hours before" onChange={(e) => set(i, { hours: Number(e.target.value) })} /> hours before</>
          ) : (
            <>
              <input type="number" min="0" max="30" disabled={!edit} style={{ width: 60 }} value={s.days} aria-label="Days before" onChange={(e) => set(i, { days: Number(e.target.value) })} /> {s.days === 0 ? 'on the day, at' : 'days before, at'}
              <input type="time" disabled={!edit} value={s.at} aria-label="Time of day" onChange={(e) => set(i, { at: e.target.value })} />
            </>
          )}
          {edit && <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange(steps.filter((_, j) => j !== i))}>Remove</button>}
        </div>
      ))}
      {steps.length === 0 && <div className="small-muted">No messages: nothing is planned by default.</div>}
      {edit && steps.length < max && <div><button type="button" className="btn btn-sm" onClick={() => onChange([...steps, { days: 1, at: '17:00' }])}>+ Add a step</button></div>}
    </div>
  );
}

export default function RemindersSettings() {
  const [d, setD] = useState(null);
  const [form, setForm] = useState(null);
  const [tpl, setTpl] = useState(null);
  const [dep, setDep] = useState('');
  const [lang, setLang] = useState('en');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState({ kind: 'interview', mode: 'offline', channel: 'WhatsApp', language: 'en' });
  const [testMsg, setTestMsg] = useState('');
  useEffect(() => {
    api.get('/ats/reminders/settings').then((r) => {
      setD(r.data); setForm(clone(r.data.settings));
      const t = {};
      Object.entries(r.data.templates).forEach(([k, langs]) => { t[k] = { en: langs.en.text, te: langs.te.text }; });
      setTpl(t);
    }).catch(() => setD(null));
  }, []);
  if (!d || !form || !tpl) return null;
  const edit = d.canEdit;
  const sch = dep ? { interview: ((form.schedule.departments[dep] || {}).interview) || form.schedule.interview, joining: ((form.schedule.departments[dep] || {}).joining) || form.schedule.joining } : form.schedule;
  const setSteps = (kind, steps) => {
    if (!dep) setForm({ ...form, schedule: { ...form.schedule, [kind]: steps } });
    else setForm({ ...form, schedule: { ...form.schedule, departments: { ...form.schedule.departments, [dep]: { ...(form.schedule.departments[dep] || {}), [kind]: steps } } } });
  };
  const dropDept = () => {
    const x = { ...form.schedule.departments }; delete x[dep];
    setForm({ ...form, schedule: { ...form.schedule, departments: x } });
  };
  async function save(extra = {}) {
    setBusy(true); setMsg(''); setErr('');
    try {
      const body = {
        enabled: form.enabled, channels: form.channels, earliestHour: Number(form.earliestHour), latestHour: Number(form.latestHour), nameClient: form.nameClient, carry: form.carry, schedule: form.schedule, ...extra,
      };
      const r = await api.put('/ats/reminders/settings', body);
      setForm(clone(r.data.settings)); setMsg(r.data.message || 'Saved.');
    } catch (e) { setErr(e.response?.data?.error || 'Could not save. Try again.'); } finally { setBusy(false); }
  }
  async function saveWords() {
    setBusy(true); setMsg(''); setErr('');
    try {
      const patch = {};
      Object.entries(tpl).forEach(([k, v]) => { patch[k] = { en: v.en, te: v.te }; });
      const r = await api.put('/ats/reminders/templates', { templates: patch });
      const t = {}; Object.entries(r.data.templates).forEach(([k, langs]) => { t[k] = { en: langs.en.text, te: langs.te.text }; });
      setTpl(t); setMsg('The words are saved.');
    } catch (e) { setErr(e.response?.data?.error || 'Could not save the words.'); } finally { setBusy(false); }
  }
  async function sendTest() {
    setTestMsg('Sending…');
    try { const r = await api.post('/ats/reminders/test', test); setTestMsg(`${r.data.message}${r.data.to ? ` (${r.data.to})` : ''}`); } catch (e) { setTestMsg(e.response?.data?.message || e.response?.data?.error || 'The test did not go.'); }
  }
  const chStatus = Object.fromEntries((d.channels || []).map((c) => [c.channel, c]));
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Interview and joining reminders to candidates</h3>
        {form.enabled ? <StatusChip tone="green">Sending On</StatusChip> : <StatusChip tone="amber">Sending Off</StatusChip>}
        {edit && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => save()}>{busy ? 'Saving…' : 'Save'}</button>}
      </div>
      <div style={{ padding: '8px 18px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="small-muted">
          When an offline or online interview is booked, or a joining date is set, the system plans scheduled messages to the candidate (default: 2 days before 10:00, 1 day before 17:00, and 2 hours before the interview / the morning of the joining at 08:00). The recruiter and the team lead choose the times and the number for each person, and see them on the candidate page, the interview calendar and the dashboard.
          While this is Off the plan is still made and shown (marked &quot;will not be sent&quot;), the recruiter and the team lead still get the bell, but nothing is sent to any candidate.
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" disabled={!edit} checked={!!form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          <b>Send interview and joining reminders to candidates</b>
          <span className="small-muted">Turn on after you have checked one test message below.</span>
        </label>
        <div>
          <b>Ways allowed</b>
          <div className="rem-actions" style={{ marginTop: 4 }}>
            {WAYS.map(([k, l]) => (
              <label key={k} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <input type="checkbox" disabled={!edit} checked={form.channels[k] !== false} onChange={(e) => setForm({ ...form, channels: { ...form.channels, [k]: e.target.checked } })} />
                {l}
                {chStatus[k] && !chStatus[k].ready && <span className="rem-warn">{k === 'SMS' ? 'not ready (SMS delivery is not verified yet)' : `not connected: ${chStatus[k].reason || ''}`}</span>}
              </label>
            ))}
          </div>
        </div>
        <div className="rem-actions" style={{ alignItems: 'center' }}>
          <label>Earliest hour <input type="number" min="0" max="23" disabled={!edit} style={{ width: 60 }} value={form.earliestHour} onChange={(e) => setForm({ ...form, earliestHour: e.target.value })} />:00</label>
          <label>Latest hour <input type="number" min="1" max="24" disabled={!edit} style={{ width: 60 }} value={form.latestHour} onChange={(e) => setForm({ ...form, latestHour: e.target.value })} />:00</label>
          <span className="small-muted">India time. Nothing goes outside these hours.</span>
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" disabled={!edit} checked={!!form.nameClient} onChange={(e) => setForm({ ...form, nameClient: e.target.checked })} />
          Name the client company in the message (otherwise &quot;our client&quot;, as in all other candidate messages)
        </label>

        <div>
          <b>Default steps</b>
          <div className="rem-actions" style={{ margin: '4px 0' }}>
            <select value={dep} onChange={(e) => setDep(e.target.value)} aria-label="Department">
              <option value="">All departments</option>
              {(d.departments || []).map((x) => <option key={x} value={x}>{`${x}${form.schedule.departments[x] ? ' (own schedule)' : ''}`}</option>)}
            </select>
            {dep && form.schedule.departments[dep] && edit && <button type="button" className="btn btn-sm btn-ghost" onClick={dropDept}>Use the company schedule for {dep}</button>}
            <span className="small-muted">{dep ? `${dep} uses these steps; the recruiter or TL can still change them for one candidate.` : 'Used by every department that has no schedule of its own.'}</span>
          </div>
          <div className="rem-grid" style={{ alignItems: 'start' }}>
            <div className="rem-box"><b>Interview</b><StepList edit={edit} max={d.max} steps={sch.interview} onChange={(s) => setSteps('interview', s)} /></div>
            <div className="rem-box"><b>Joining</b><StepList edit={edit} max={d.max} steps={sch.joining} onChange={(s) => setSteps('joining', s)} /></div>
          </div>
          <div className="small-muted" style={{ marginTop: 4 }}>A step that has already passed when the interview is booked is dropped and the rest are kept. An interview booked the same day sends the details at once.</div>
        </div>

        <div>
          <b>What to carry (when the booking does not say)</b>
          <div className="rem-grid" style={{ marginTop: 4 }}>
            <label>Interview<input disabled={!edit} value={form.carry.interview} onChange={(e) => setForm({ ...form, carry: { ...form.carry, interview: e.target.value } })} /></label>
            <label>Joining<input disabled={!edit} value={form.carry.joining} onChange={(e) => setForm({ ...form, carry: { ...form.carry, joining: e.target.value } })} /></label>
          </div>
        </div>

        <div>
          <b>The words</b>
          <div className="rem-actions" style={{ margin: '4px 0' }}>
            {[['en', 'English'], ['te', 'Telugu']].map(([k, l]) => <button key={k} type="button" className={`btn btn-sm${lang === k ? ' btn-primary' : ''}`} onClick={() => setLang(k)}>{l}</button>)}
            <span className="small-muted">Placeholders: {d.tokens.map((t) => `{{${t[0]}}}`).join(' ')}. A line whose placeholders are all empty is left out.</span>
          </div>
          {d.templateKeys.map(([k, label]) => (
            <label key={k} style={{ display: 'grid', gap: 2, marginBottom: 8 }}>
              <span className="small-muted">{label}</span>
              <textarea rows={7} disabled={!edit} value={tpl[k][lang]} onChange={(e) => setTpl({ ...tpl, [k]: { ...tpl[k], [lang]: e.target.value } })} />
            </label>
          ))}
          {edit && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={saveWords}>Save the words</button>}
        </div>

        {edit && (
          <div className="rem-box">
            <b>Send me a test reminder</b>
            <div className="small-muted">Sends a sample message (marked TEST) to your own phone or email from your employee profile. Nothing goes to any candidate.</div>
            <div className="rem-actions" style={{ marginTop: 6 }}>
              <select value={test.kind} onChange={(e) => setTest({ ...test, kind: e.target.value })} aria-label="Which message"><option value="interview">Interview</option><option value="joining">Joining</option></select>
              {test.kind === 'interview' && <select value={test.mode} onChange={(e) => setTest({ ...test, mode: e.target.value })} aria-label="Mode"><option value="offline">Offline</option><option value="online">Online</option><option value="phone">Phone</option></select>}
              <select value={test.channel} onChange={(e) => setTest({ ...test, channel: e.target.value })} aria-label="Way">{WAYS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <select value={test.language} onChange={(e) => setTest({ ...test, language: e.target.value })} aria-label="Language"><option value="en">English</option><option value="te">Telugu</option></select>
              <button type="button" className="btn btn-sm" onClick={sendTest}>Send me a test reminder</button>
            </div>
            {testMsg && <div className="notice" style={{ marginTop: 6 }}>{testMsg}</div>}
          </div>
        )}
        {msg && <div className="notice">{msg}</div>}
        {err && <div className="error-text">{err}</div>}
      </div>
    </div>
  );
}
