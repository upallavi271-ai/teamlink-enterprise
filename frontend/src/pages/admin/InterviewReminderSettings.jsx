import { useEffect, useState } from 'react';
import api from '../../api';
import StatusChip from '../../components/ui/StatusChip.jsx';
import Combo from '../../components/Combo.jsx';

// ---------------------------------------------------------------------------
// Administration → Step timing → "Interview reminders" (user, 2026-10-10): who is reminded of an
// interview, when, and how. Four people are told: the candidate, the recruiter, the team lead (TL)
// and the client manager (BDE); the interviewer is told with the team. Saved with ONE button.
// (backend: utils/interviewReminderPlan.js, GET / PUT /api/ats/interview-reminder-plan)
// ---------------------------------------------------------------------------
const WAYS = [['WhatsApp', 'WhatsApp'], ['SMS', 'SMS'], ['Email', 'Mail']];
const COLS = [
  ['digest', 'Today\'s list (8:30 am)'], ['hourBefore', '1 hour before'], ['bell', 'App bell'], ['email', 'Mail'], ['whatsapp', 'WhatsApp'], ['sms', 'SMS'],
];

export default function InterviewReminderSettings() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get('/ats/interview-reminder-plan')
      .then((r) => { setData(r.data); setForm(JSON.parse(JSON.stringify(r.data.plan))); })
      .catch(() => setData(null));
  }, []);
  if (!data || !form) return null;
  const edit = data.canEdit;
  const setC = (k, v) => setForm({ ...form, candidate: { ...form.candidate, [k]: v } });
  const setP = (party, k, v) => setForm({ ...form, parties: { ...form.parties, [party]: { ...form.parties[party], [k]: v } } });
  const toggleWay = (w) => {
    const has = form.candidate.channels.includes(w);
    const next = has ? form.candidate.channels.filter((x) => x !== w) : [...form.candidate.channels, w];
    setC('channels', next);
  };
  async function save() {
    setBusy(true); setMsg(''); setErr('');
    try {
      const r = await api.put('/ats/interview-reminder-plan', { candidate: form.candidate, parties: form.parties, digestAt: form.digestAt, noShow: form.noShow, feedback: form.feedback, quiet: form.quiet, armed: form.armed });
      setForm(JSON.parse(JSON.stringify(r.data.plan)));
      setMsg(r.data.message || 'Saved.');
    } catch (e) { setErr(e.response?.data?.error || 'Could not save. Try again.'); } finally { setBusy(false); }
  }
  const staffOn = data.staff && data.staff.enabled !== false;
  const check = (checked, onChange, label) => (
    <input type="checkbox" checked={!!checked} disabled={!edit} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
  );
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Interview reminders</h3>
        {form.armed ? <StatusChip tone="green">Automatic sending On</StatusChip> : <StatusChip tone="amber">Automatic sending Off</StatusChip>}
        {!staffOn && <StatusChip tone="amber">Team bell off</StatusChip>}
        {edit && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>}
      </div>
      <div style={{ padding: '8px 18px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="small-muted">
          After an interview is booked, the candidate, the recruiter, the team lead (TL) and the client manager (BDE) are all reminded.
          The reminders for the team can be switched off in Interview Calendar. Messages to candidates need the &quot;Candidate emails&quot; switch above to be On
          ({data.candidateEmailsOn ? 'it is On' : 'it is Off now, so nothing goes to candidates'}).
        </div>
        {!edit && <div className="notice">Only a Super Admin, Admin or HR can change these. You can read them.</div>}
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          {check(form.armed, (v) => setForm({ ...form, armed: v }), 'Automatic sending')}
          <span>
            <b>Send the reminders by themselves</b>
            <span className="small-muted" style={{ display: 'block' }}>
              {form.armed ? 'On: mail, WhatsApp and SMS reminders go out as set below.' : 'Off: nothing is sent outside TeamLink by itself. The team still gets the app bell. Press Save after turning it on.'}
            </span>
          </span>
        </label>

        <div>
          <b>The candidate</b>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 6 }}>
            <label>{check(form.candidate.dayBefore, (v) => setC('dayBefore', v), '1 day before')} 1 day before</label>
            <label>{check(form.candidate.hourBefore, (v) => setC('hourBefore', v), '1 hour before')} 1 hour before</label>
            <label>{check(form.candidate.nowOnline, (v) => setC('nowOnline', v), '15 minutes before, online')} 15 minutes before (online, with the link)</label>
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
            <span>Reach them by:</span>
            {WAYS.map(([w, label]) => <label key={w}>{check(form.candidate.channels.includes(w), () => toggleWay(w), label)} {label}</label>)}
            <Combo value={form.candidate.strategy} disabled={!edit} onChange={(e) => setC('strategy', e.target.value)} aria-label="One way or all ways">
              <option value="first">The first one that works</option>
              <option value="all">Every one that works</option>
            </Combo>
          </div>
          <div className="small-muted" style={{ marginTop: 4 }}>
            If nobody tells the candidate within{' '}
            <input type="number" min={0} max={120} value={form.candidate.safetyNetMinutes} disabled={!edit} style={{ width: 60 }} aria-label="Minutes before the booking message goes by itself" onChange={(e) => setC('safetyNetMinutes', Number(e.target.value))} />
            {' '}minutes after a booking, move or cancel, the message goes by itself (0 = never).
          </div>
        </div>

        <div>
          <b>The team</b>
          <div className="tbl-wrap" style={{ border: 0, overflowX: 'auto' }}>
            <table className="ah-tbl" style={{ width: '100%' }}>
              <thead><tr><th style={{ textAlign: 'left' }}>Who</th>{COLS.map(([k, label]) => <th key={k} style={{ textAlign: 'center', fontSize: 12 }}>{label}</th>)}</tr></thead>
              <tbody>
                {data.parties.map((p) => (
                  <tr key={p.key}>
                    <td style={{ padding: '6px 8px 6px 0' }}>{p.label}</td>
                    {COLS.map(([k, label]) => (
                      <td key={k} style={{ textAlign: 'center' }}>{check(form.parties[p.key][k], (v) => setP(p.key, k, v), `${p.label}: ${label}`)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="small-muted">WhatsApp and SMS to the team go only if that channel is connected and the person&apos;s phone is on their profile. Mail follows the &quot;Candidate emails&quot; switch.</div>
          <div style={{ marginTop: 6 }}>
            Send the list of today&apos;s interviews at{' '}
            <input type="time" value={form.digestAt} disabled={!edit} aria-label="Time of today's list" onChange={(e) => setForm({ ...form, digestAt: e.target.value })} />
            {' '}(India time).
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label>
            {check(form.noShow.on, (v) => setForm({ ...form, noShow: { ...form.noShow, on: v } }), 'Did the candidate attend')}
            {' '}If an interview has no status{' '}
            <input type="number" min={10} max={180} value={form.noShow.afterMinutes} disabled={!edit} style={{ width: 60 }} aria-label="Minutes after the start" onChange={(e) => setForm({ ...form, noShow: { ...form.noShow, afterMinutes: Number(e.target.value) } })} />
            {' '}minutes after it started, ask the recruiter: &quot;Did the candidate attend?&quot;
          </label>
          <label>
            {check(form.feedback.on, (v) => setForm({ ...form, feedback: { ...form.feedback, on: v } }), 'Feedback pending')}
            {' '}If feedback is still missing{' '}
            <input type="number" min={1} max={48} value={form.feedback.afterHours} disabled={!edit} style={{ width: 60 }} aria-label="Hours after the interview" onChange={(e) => setForm({ ...form, feedback: { ...form.feedback, afterHours: Number(e.target.value) } })} />
            {' '}hours after the interview, remind the interviewer, the recruiter and the TL (once a day).
          </label>
          <label>
            {check(form.quiet, (v) => setForm({ ...form, quiet: v }), 'Quiet hours')}
            {' '}Keep the 1-day reminder for the morning when it would fall in quiet hours. The 1-hour and 15-minute reminders always go.
          </label>
        </div>
        {msg && <div className="notice green">{msg}</div>}
        {err && <div className="notice red">{err}</div>}
      </div>
    </div>
  );
}
