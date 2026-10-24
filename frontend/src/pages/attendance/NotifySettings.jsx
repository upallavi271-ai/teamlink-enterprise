import { useEffect, useState } from 'react';
import api from '../../api';
import { Link } from 'react-router-dom';
import { Panel, PanelHead } from '../../components/proto.jsx';

// Attendance alert emails: three plain choices (default: Send at once).
const MODES = [['now', 'Send at once'], ['daily', 'Include in the daily email only'], ['off', 'Do not email']];
const timeOf = (iso) => new Date(iso).toLocaleString();

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
  const [queue, setQueue] = useState(null);
  const [busy, setBusy] = useState('');

  function load() {
    api.get('/attendance/notify-settings')
      .then((r) => { setData(r.data); setDraft(r.data.settings); })
      .catch((e) => setErr(e.response?.data?.error || 'Could not load the notification settings.'));
    api.get('/attendance/notify-queue').then((r) => setQueue(r.data)).catch(() => setQueue(null));
  }
  useEffect(load, []);

  if (err && !data) return <div className="notice red" style={{ marginTop: 16 }}>{err}</div>;
  if (!data || !draft) return null;

  const flip = (key, ch) => setDraft((d) => ({ ...d, events: { ...d.events, [key]: { ...d.events[key], [ch]: !d.events[key][ch] } } }));
  async function save() {
    setSaving(true); setMsg(''); setErr('');
    try {
      const r = await api.put('/attendance/notify-settings', { emailsOn: !!draft.emailsOn, mailMode: draft.mailMode, events: draft.events, digestTime: draft.digestTime, reminderTime: draft.reminderTime, taskDueDays: Number(draft.taskDueDays) });
      setDraft(r.data.settings); setMsg('Saved.'); load();
    } catch (e) { setErr(e.response?.data?.error || 'Could not save. Try again.'); } finally { setSaving(false); }
  }
  // One click: the master switch is saved at once (the rest of the page keeps what you changed).
  async function switchOn() {
    setBusy('on'); setMsg(''); setErr('');
    try { await api.put('/attendance/notify-settings', { emailsOn: true }); setMsg('Notification emails are ON.'); load(); } catch (e) { setErr(e.response?.data?.error || 'Could not switch on. Try again.'); } finally { setBusy(''); }
  }
  async function testMail() {
    setBusy('test'); setMsg(''); setErr('');
    try { const r = await api.post('/attendance/notify-test-mail'); setMsg(r.data.message); } catch (e) { setErr(e.response?.data?.error || 'The test email failed.'); } finally { setBusy(''); }
  }
  async function resend(id) {
    setBusy(id); setMsg(''); setErr('');
    try { const r = await api.post('/attendance/notify-resend/' + id); setMsg(r.data.status === 'Sent' ? 'Sent.' : 'Not sent: ' + r.data.status); load(); } catch (e) { setErr(e.response?.data?.error || 'Could not resend.'); } finally { setBusy(''); }
  }
  async function sendWaiting() {
    const n = queue ? queue.waitingCount : 0;
    if (!window.confirm('Send ' + Math.min(n, queue.cap) + ' waiting email(s) now, one by one? They were made while emails were off or mail was not set up.')) return;
    setBusy('waiting'); setMsg(''); setErr('');
    try {
      const r = await api.post('/attendance/notify-send-waiting', { confirm: true });
      setMsg(r.data.sent + ' sent, ' + r.data.failed + ' not sent' + (r.data.left ? ', ' + r.data.left + ' still waiting (press again)' : '') + '.');
      load();
    } catch (e) { setErr(e.response?.data?.error || 'Could not send.'); } finally { setBusy(''); }
  }
  const box = { width: 16, height: 16, minHeight: 0 };
  const modeButtons = (value, onPick, withSame) => (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {withSame && <button type="button" className={'btn btn-sm' + (!value ? ' btn-primary' : '')} onClick={() => onPick('')}>Same as above</button>}
      {MODES.map(([k, label]) => <button key={k} type="button" className={'btn btn-sm' + (value === k ? ' btn-primary' : '')} onClick={() => onPick(k)}>{label}</button>)}
    </span>
  );
  const setEventMode = (key, mode) => setDraft((d) => ({ ...d, events: { ...d.events, [key]: { ...d.events[key], mode } } }));

  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title="Who gets told, and how">
        <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </PanelHead>
      <div style={{ padding: '12px 18px' }}>
        {!draft.emailsOn && (
          <div className="notice red" style={{ marginBottom: 10, fontWeight: 600 }}>
            Notification emails are OFF — nobody is emailed (alerts still appear in the app).
            <div style={{ marginTop: 8 }}><button type="button" className="btn btn-primary" onClick={switchOn} disabled={busy === 'on'}>{busy === 'on' ? 'Switching on…' : 'Turn notification emails ON'}</button></div>
          </div>
        )}
        {data.mail && !data.mail.configured && (
          <div className="notice red" style={{ marginBottom: 10 }}>
            Mail is not set up, so emails cannot be sent. {data.mail.reason} <Link to="/admin/integrations">Set up Email in Integrations</Link>.
          </div>
        )}
        <div className="small-muted" style={{ fontSize: 12.5, marginBottom: 10, lineHeight: 1.55 }}>
          Each person gets <b>one note per event per day</b> in the app, and <b>one email per event per day</b>.
          Leave and late-coming decisions are always emailed at once. Choose how the attendance alert emails go:
          {data.waiting > 0 && <> {data.waiting} item(s) are waiting for the daily email.</>}
        </div>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Attendance alert emails (missing check-in, missing check-out, late coming, early logout)</div>
          {modeButtons(draft.mailMode, (m) => setDraft({ ...draft, mailMode: m }), false)}
          <div style={{ marginTop: 8 }}>
            <button type="button" className="btn btn-sm" onClick={testMail} disabled={busy === 'test'}>{busy === 'test' ? 'Sending…' : 'Send a test email to me'}</button>
          </div>
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
                  <td>{ev.label}<div className="small-muted" style={{ fontSize: 11 }}>{ev.attendance ? 'Email: pick below' : (ev.instant ? 'Email goes at once' : 'Email in the daily email')}</div>
                    {ev.attendance && <div style={{ marginTop: 4 }}>{modeButtons(draft.events[ev.key]?.mode || '', (m) => setEventMode(ev.key, m), true)}</div>}</td>
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
        {queue && (queue.failed.length > 0 || queue.waitingCount > 0) && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Emails that did not go out</div>
            {queue.waitingCount > 0 && (
              <div style={{ marginBottom: 8 }}>
                <span className="small-muted">{queue.waitingCount} email(s) from yesterday and today were never sent. They are not sent by themselves.</span>{' '}
                <button type="button" className="btn btn-sm btn-primary" onClick={sendWaiting} disabled={!queue.emailsOn || busy === 'waiting'}>Send the waiting ones now ({Math.min(queue.waitingCount, queue.cap)})</button>
                {!queue.emailsOn && <span className="small-muted"> Turn emails ON first.</span>}
              </div>
            )}
            {queue.failed.length > 0 && (
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th>To</th><th>Event</th><th>What happened</th><th /></tr></thead>
                  <tbody>
                    {queue.failed.map((r) => (
                      <tr key={r.id}>
                        <td>{r.recipient}</td>
                        <td>{r.title}<div className="small-muted" style={{ fontSize: 11 }}>{timeOf(r.createdAt)}</div></td>
                        <td><span className="status failed">{r.status}</span></td>
                        <td><button type="button" className="btn btn-sm" onClick={() => resend(r.id)} disabled={busy === r.id || !queue.emailsOn}>Resend</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
