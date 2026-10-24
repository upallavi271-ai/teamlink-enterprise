import { useCallback, useEffect, useState } from 'react';
import api from '../../../api';
import AccountsReminderSettings from './AccountsReminderSettings.jsx';
import './ProofReminderAuto.css';

// THE DAILY ACCOUNTS SUMMARY (founder, 2026-10-21): it goes out BY ITSELF every day at 9:30 AM and 5:00 PM (India time) as WhatsApp, email and
// a bell, and only when something is pending. It is ON by default; nobody presses a button. This card shows the plain status (next round,
// last message), the two times, the On / Off switch, a test to yourself and the list of what was sent. WHO gets it is the table below
// (AccountsReminderSettings.jsx: "Who gets each reminder"). Backend: routes/proofReminders.js, utils/proofReminders.js.
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const TONE = { sent: 'green', failed: 'red', skipped: 'grey', sending: 'amber' };
const WORD = { sent: 'Accepted', failed: 'Not sent', skipped: 'Not needed', sending: 'Sending' };
const TIP = { sent: 'The mail server or WhatsApp accepted it. We cannot see if the person has read it.' };

export default function ProofReminderAuto({ flash }) {
  const [st, setSt] = useState(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState('');
  const [times, setTimes] = useState({ time1: '09:30', time2: '17:00' });
  const [again, setAgain] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/proof-reminders/status');
      setSt(data);
      setTimes({ time1: data.settings.time1, time2: data.settings.time2 });
    } catch (e) {
      if (e.response && (e.response.status === 403 || e.response.status === 401)) setHidden(true);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (hidden || !st) return null;
  const say = (m, tone) => (flash ? flash(m, tone) : null);
  const save = async (patch, ok) => {
    setBusy('save');
    try {
      const { data } = await api.put('/proof-reminders/settings', patch);
      say(ok || data.message);
      await load();
    } catch (e) { say(e.response?.data?.error || 'Could not save.', 'red'); }
    setBusy('');
  };
  const test = async () => {
    setBusy('test');
    try { const { data } = await api.post('/proof-reminders/test'); say(data.message); await load(); } catch (e) { say(e.response?.data?.error || 'The test could not be sent.', 'red'); }
    setBusy('');
  };
  const runNow = async (slot) => {
    if (again && !window.confirm('Send again even if these reminders were already sent today? The Accountants will get the message twice.')) return;
    setBusy(`run${slot}`);
    try { const { data } = await api.post('/proof-reminders/run', { slot, force: again }); say(data.message); await load(); } catch (e) { say(e.response?.data?.error || 'Could not send.', 'red'); }
    setBusy('');
  };
  const on = st.settings.enabled;
  const dirty = times.time1 !== st.settings.time1 || times.time2 !== st.settings.time2;
  const auto = st.automatic || {};

  return (
    <>
      <div className="prr-box" id="proof-auto">
        <div className="prr-top">
          <div>
            <h3>Daily Accounts summary: WhatsApp, email and bell</h3>
            <div className="small-muted">It goes out by itself every day at {st.rounds[0].timeLabel} and {st.rounds[1].timeLabel} ({st.timezone}), only when something is pending. Nobody has to press a button.</div>
          </div>
          <div>
            <span className={`acd-pill ${on ? 'green' : 'grey'}`}>{on ? 'ON: goes out by itself' : 'OFF: nothing is sent'}</span>{' '}
            {st.mayRun && <button type="button" className={`btn ${on ? '' : 'btn-primary'}`} disabled={busy === 'save'} onClick={() => save({ enabled: !on })}>{on ? 'Turn OFF' : 'Turn ON'}</button>}
          </div>
        </div>
        {!st.tableReady && <div className="notice amber"><span>The reminder list is not set up on this server yet, so nothing can be sent. Ask your admin to finish the update.</span></div>}

        <div className="prr-ready">
          <span>
            <b>{on && auto.next ? `Next reminder: ${auto.next.label}` : 'Next reminder: none (it is switched off)'}</b>
            {' · '}
            <b>{auto.lastSent ? `Last sent: ${when(auto.lastSent)}` : 'Last sent: nothing yet'}</b>
          </span>
          <span>
            <span className={`acd-pill ${st.channels.whatsapp.connected ? 'green' : 'red'}`}>WhatsApp {st.channels.whatsapp.connected ? 'is connected' : 'is not ready (not connected)'}</span>{' '}
            <span className={`acd-pill ${st.channels.email.connected ? 'green' : 'red'}`}>Email {st.channels.email.connected ? 'is set up' : 'is not set up'}</span>{' '}
            <span className={`acd-pill ${st.pending.count ? 'amber' : 'green'}`}>{st.pending.count ? `${st.pending.count} proof${st.pending.count === 1 ? '' : 's'} missing now` : 'No proof missing now'}</span>
          </span>
          {!st.channels.whatsapp.connected && <span className="small-muted">Without WhatsApp, the email and the bell still go. Nothing is ever shown as sent when it was not.</span>}
          {st.recipients.map((r) => (
            <span key={r.id}>
              <b>{r.name}</b> gets {r.records} reminder{r.records === 1 ? '' : 's'}: WhatsApp number {r.hasWhatsApp ? 'yes' : <b style={{ color: '#b42318' }}>missing</b>}, email {r.hasEmail ? 'yes' : <b style={{ color: '#b42318' }}>missing</b>}
            </span>
          ))}
          {st.pending.noAccountant > 0 && <span style={{ color: '#b42318' }}>{st.pending.noAccountant} missing proof{st.pending.noAccountant === 1 ? ' has' : 's have'} nobody to tell, because no one has the Accountant role yet. Give someone the Accountant role (Administration, Users), or choose people in the table below.</span>}
        </div>

        {st.mayRun && (
          <div className="prr-row">
            <label>Morning time (India time)
              <input type="time" value={times.time1} onChange={(e) => setTimes({ ...times, time1: e.target.value })} />
            </label>
            <label>Evening time (India time)
              <input type="time" value={times.time2} onChange={(e) => setTimes({ ...times, time2: e.target.value })} />
            </label>
            <button type="button" className="btn btn-primary" disabled={!dirty || busy === 'save'} onClick={() => save(times, 'Saved.')}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
          </div>
        )}
        <div className="small-muted">If the server was off at that time, the message still goes out up to 2 hours later ({st.rounds[0].timeLabel} to {st.rounds[0].until}, {st.rounds[1].timeLabel} to {st.rounds[1].until}), once only. No message is sent when nothing is pending.</div>

        <div className="acd-btns">
          <button type="button" className="btn" disabled={busy === 'test'} onClick={test}>{busy === 'test' ? 'Sending…' : 'Send a test to me'}</button>
        </div>
        <div className="small-muted">The test goes only to your own WhatsApp number and email.</div>

        {st.mayRun && (
          <details style={{ marginTop: 8 }}>
            <summary>For emergencies only: send a round now</summary>
            <div className="acd-btns">
              <button type="button" className="btn" disabled={!!busy} onClick={() => runNow('first')}>Send the morning round now</button>
              <button type="button" className="btn" disabled={!!busy} onClick={() => runNow('second')}>Send the evening round now</button>
              <label className="small-muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <input type="checkbox" checked={again} onChange={(e) => setAgain(e.target.checked)} /> Send again even if already sent today
              </label>
            </div>
          </details>
        )}

        <details style={{ marginTop: 8 }}>
          <summary>See the messages{st.preview.sample ? ' (example: nothing is missing right now)' : ''}</summary>
          <b>WhatsApp</b>
          <div className="prr-pre">{st.preview.whatsapp}</div>
          <b>Email: {st.preview.emailSubject}</b>
          <div className="prr-pre">{st.preview.emailText}</div>
        </details>

        <h3 style={{ marginTop: 12 }}>What was sent</h3>
        {!st.runs.length ? <div className="small-muted">Nothing has been sent yet.</div> : (
          <div className="prr-wrap">
            <table className="prr-tbl">
              <thead><tr><th>When</th><th>Round</th><th>Who</th><th>How</th><th>Result</th><th>Why not</th></tr></thead>
              <tbody>
                {st.runs.map((r) => (
                  <tr key={r.id}>
                    <td>{when(r.at)}</td>
                    <td>{r.slot === 'test' ? 'Test' : `${r.day} · ${r.slot === 'first' ? 'morning' : 'evening'}${r.trigger === 'manual' ? ' (sent by hand)' : ''}`}</td>
                    <td>{r.userName || '—'}</td>
                    <td>{r.channel}</td>
                    <td><span className={`acd-pill ${TONE[r.status] || 'grey'}`} title={TIP[r.status] || ''}>{WORD[r.status] || r.status}</span>{r.attempts > 1 ? ` · ${r.attempts} tries` : ''}</td>
                    <td>{r.error || (r.nextAttemptAt && r.status === 'failed' ? `trying again at ${when(r.nextAttemptAt)}` : '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <AccountsReminderSettings flash={flash} onChanged={load} />
    </>
  );
}
