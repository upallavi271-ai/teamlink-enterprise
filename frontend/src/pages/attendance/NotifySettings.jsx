import { useEffect, useState } from 'react';
import api from '../../api';
import { Panel, PanelHead } from '../../components/proto.jsx';

// ---------------------------------------------------------------------------
// HRMS item 14 — "Who gets told, and how". One row per event, two plain
// switches: In the app · By email. A leave decision is emailed at once;
// everything else goes into ONE daily email per person (no floods).
// Server: backend/src/utils/hrmsNotify.js (GET / PUT /attendance/notify-settings).
// ---------------------------------------------------------------------------
export default function NotifySettings() {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/attendance/notify-settings')
      .then((r) => { setData(r.data); setDraft(r.data.settings); })
      .catch((e) => setErr(e.response?.data?.error || 'Could not load the notification settings.'));
  }, []);

  if (err && !data) return <div className="notice red" style={{ marginTop: 16 }}>{err}</div>;
  if (!data || !draft) return null;

  const flip = (key, ch) => setDraft((d) => ({ ...d, events: { ...d.events, [key]: { ...d.events[key], [ch]: !d.events[key][ch] } } }));
  async function save() {
    setSaving(true); setMsg(''); setErr('');
    try {
      const r = await api.put('/attendance/notify-settings', { emailsOn: !!draft.emailsOn, events: draft.events, digestTime: draft.digestTime, reminderTime: draft.reminderTime, taskDueDays: Number(draft.taskDueDays) });
      setDraft(r.data.settings); setMsg('Saved.');
    } catch (e) { setErr(e.response?.data?.error || 'Could not save. Try again.'); } finally { setSaving(false); }
  }
  const box = { width: 16, height: 16, minHeight: 0 };

  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title="Who gets told, and how">
        <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </PanelHead>
      <div style={{ padding: '12px 18px' }}>
        <div className="small-muted" style={{ fontSize: 12.5, marginBottom: 10, lineHeight: 1.55 }}>
          Each person gets <b>one note per event per day</b> in the app. Emails are grouped into <b>one email a day</b> per person —
          only a leave approval or rejection is emailed straight away.
          {data.waiting > 0 && <> {data.waiting} item(s) are waiting for today&apos;s email.</>}
        </div>
        <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontWeight: 600, marginBottom: 10 }}>
          <input type="checkbox" style={box} checked={!!draft.emailsOn} onChange={() => setDraft({ ...draft, emailsOn: !draft.emailsOn })} />
          Send emails
          <span className={`status ${draft.emailsOn ? 'active' : 'pending'}`}>{draft.emailsOn ? 'On' : 'Off — nothing is emailed yet'}</span>
        </label>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Event</th><th style={{ textAlign: 'center' }}>In the app</th><th style={{ textAlign: 'center' }}>By email</th></tr></thead>
            <tbody>
              {data.events.map((ev) => (
                <tr key={ev.key}>
                  <td>{ev.label}<div className="small-muted" style={{ fontSize: 11 }}>{ev.instant ? 'Email goes at once' : 'Email in the daily email'}</div></td>
                  <td style={{ textAlign: 'center' }}><input type="checkbox" style={box} aria-label={`${ev.label} in the app`} checked={!!draft.events[ev.key]?.inApp} onChange={() => flip(ev.key, 'inApp')} /></td>
                  <td style={{ textAlign: 'center' }}><input type="checkbox" style={box} aria-label={`${ev.label} by email`} checked={!!draft.events[ev.key]?.email} onChange={() => flip(ev.key, 'email')} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="grid-2" style={{ marginTop: 10 }}>
          <div className="field">
            <label>Daily email goes at</label>
            <input type="time" value={draft.digestTime} onChange={(e) => setDraft({ ...draft, digestTime: e.target.value })} style={{ maxWidth: 140 }} />
          </div>
          <div className="field">
            <label>Task and target reminders at</label>
            <input type="time" value={draft.reminderTime} onChange={(e) => setDraft({ ...draft, reminderTime: e.target.value })} style={{ maxWidth: 140 }} />
          </div>
          <div className="field">
            <label>Remind about a task this many days before it is due</label>
            <input type="number" min="0" max="7" value={draft.taskDueDays} onChange={(e) => setDraft({ ...draft, taskDueDays: e.target.value })} style={{ maxWidth: 100 }} />
          </div>
        </div>
        {msg && <div className="notice">{msg}</div>}
        {err && <div className="notice red">{err}</div>}
      </div>
    </Panel>
  );
}
