import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Combo from '../Combo.jsx';
import { followUpWhen, timeLabel } from './waChatLogic.js';

// THE FOLLOW-UP, ON THE SAME SCREEN (a strip above the messages).
//   * shows the next follow-up of this candidate (date, time, note) and the mark "Candidate replied: review"
//   * Mark done · Snooze · Schedule a follow-up (quick buttons: Tomorrow 10:00, In 3 days, Next week, or pick a date)
//   * the last finished ones (history)
// It reads and writes the SAME follow-up rows as the Follow-ups list, the dashboard and the reminders.
const errOf = (e, d) => (e.response && e.response.data && e.response.data.error) || d;

export default function WaChatFollowUp({ personId, applicationId, reloadKey = 0, onChanged }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [appId, setAppId] = useState(applicationId || '');
  const [open, setOpen] = useState(false);
  const [fold, setFold] = useState(false); // on a phone the strip shows one line until opened
  const [mode, setMode] = useState(null); // null | snooze | schedule | done
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('10:00');
  const [outcome, setOutcome] = useState('Answered');
  const [nextStep, setNextStep] = useState('No further action');
  const [msg, setMsg] = useState(null); // { ok, text }

  const load = useCallback(() => api.get(`/wa-chats/person/candidates/${personId}/followup`)
    .then((r) => { setData(r.data); setErr(''); })
    .catch((e) => setErr(errOf(e, 'Could not open the follow-up.'))), [personId]);
  useEffect(() => { setData(null); setMode(null); setMsg(null); load(); }, [load, reloadKey]);

  const apps = (data && data.applications) || [];
  const app = apps.find((a) => a.applicationId === appId) || apps.find((a) => a.open) || apps[0] || null;
  useEffect(() => { if (app && app.applicationId !== appId) setAppId(app.applicationId); }, [app, appId]);

  if (err) return <div className="wc-fu wc-fu-err"><span>{err}</span> <button type="button" className="btn btn-sm" onClick={load}>Try again</button></div>;
  if (!data) return <div className="wc-fu wc-skel-line" aria-busy="true" />;
  if (!app) return <div className="wc-fu"><b>Follow-up</b> <span className="small-muted">This person is not on a requirement yet, so there is no follow-up to set.</span></div>;

  const fu = app.open;
  const can = app.canRecord;
  const why = 'Only the owner of this requirement can change its follow-up.';
  const done = (text) => { setMode(null); setMsg({ ok: true, text }); setNote(''); load(); if (onChanged) onChanged(); };
  const quick = data.quick || [];

  const post = async (path, body, okText) => {
    setBusy(true); setMsg(null);
    try { await api.post(path, body); done(okText); } catch (e) { setMsg({ ok: false, text: errOf(e, 'That did not work.') }); } finally { setBusy(false); }
  };
  const snooze = (body) => post(`/wa-chats/person/candidates/${personId}/followup/${fu.id}/snooze`, body, 'Snoozed.');
  const schedule = (body) => post(`/wa-chats/person/candidates/${personId}/followup`, { applicationId: app.applicationId, note: note || undefined, ...body }, fu ? 'Follow-up moved.' : 'Follow-up set.');
  const needsDate = (data.needDate || []).includes(nextStep);
  const finish = async () => {
    if (needsDate && !date) { setMsg({ ok: false, text: 'Pick a date for the next step.' }); return; }
    await post(`/followups/${fu.id}/complete`, { outcome, nextStep, note: note || undefined, ...(needsDate ? { nextFollowUpAt: date, nextFollowUpTime: time || undefined } : {}) }, 'Marked done.');
  };
  const customBody = () => ({ dueDate: date, dueTime: time || undefined });

  return (
    <div className={`wc-fu${fold ? ' expanded' : ''}`} data-has-open={fu ? 'yes' : 'no'}>
      <div className="wc-fu-top">
        <b className="wc-fu-title">Follow-up</b>
        <button type="button" className="btn btn-sm wc-more-toggle" aria-expanded={fold} onClick={() => setFold(!fold)}>{fold ? 'Hide' : 'Options'}</button>
        {fu ? (
          <span className="wc-fu-now">
            <span className={`wc-chip ${fu.status === 'Overdue' ? 'red' : fu.status === 'Due Today' ? 'amber' : 'blue'}`}>{followUpWhen(fu.dueDate, fu.dueTime)}</span>
            {fu.repliedAt && <span className="wc-chip amber" title={`They wrote at ${timeLabel(fu.repliedAt)}`}>Candidate replied: review</span>}
            <span className="wc-fu-note">{fu.notes || fu.nextAction || ''}</span>
          </span>
        ) : <span className="small-muted">No follow-up is waiting.</span>}
        <span className="wc-fu-btns">
          {fu && <button type="button" className="btn btn-sm btn-primary" disabled={!can || busy} title={can ? '' : why} onClick={() => { setMode(mode === 'done' ? null : 'done'); setOpen(true); }}>Mark done</button>}
          {fu && <button type="button" className="btn btn-sm" disabled={!can || busy} title={can ? '' : why} onClick={() => { setMode(mode === 'snooze' ? null : 'snooze'); setOpen(true); }}>Snooze</button>}
          <button type="button" className="btn btn-sm" disabled={!can || busy} title={can ? '' : why} onClick={() => { setMode(mode === 'schedule' ? null : 'schedule'); setOpen(true); }}>{fu ? 'Change the time' : 'Schedule a follow-up'}</button>
          <button type="button" className="btn btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Details'}</button>
        </span>
      </div>
      {!can && <div className="small-muted">{why}</div>}
      {apps.length > 1 && (
        <div className="wc-fu-row">
          <label htmlFor="wc-fu-app">Requirement</label>
          <Combo id="wc-fu-app" value={app.applicationId} onChange={(e) => { setAppId(e.target.value); setMode(null); }} emptyText="No such requirement">
            {apps.map((a) => <option key={a.applicationId} value={a.applicationId}>{a.requirementTitle || 'Requirement'} · {a.stageLabel}{a.open ? ' · has a follow-up' : ''}</option>)}
          </Combo>
        </div>
      )}
      {mode && mode !== 'done' && (
        <div className="wc-fu-panel">
          <div className="wc-fu-quick">
            {quick.map((q) => (
              <button key={q.key} type="button" className="cv-chip" disabled={busy} onClick={() => (mode === 'snooze' ? snooze({ quick: q.key }) : schedule({ quick: q.key }))}>{q.label}</button>
            ))}
          </div>
          <div className="wc-fu-row">
            <label htmlFor="wc-fu-date">Or pick</label>
            <input id="wc-fu-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <input type="time" aria-label="Time" value={time} onChange={(e) => setTime(e.target.value)} />
            <button type="button" className="btn btn-sm btn-primary" disabled={busy || !date} onClick={() => (mode === 'snooze' ? snooze(customBody()) : schedule(customBody()))}>{mode === 'snooze' ? 'Snooze to this time' : 'Save this time'}</button>
          </div>
          {mode === 'schedule' && (
            <div className="wc-fu-row">
              <label htmlFor="wc-fu-note">Note</label>
              <input id="wc-fu-note" value={note} maxLength={400} placeholder="What to talk about (optional)" onChange={(e) => setNote(e.target.value)} />
            </div>
          )}
        </div>
      )}
      {mode === 'done' && fu && (
        <div className="wc-fu-panel">
          <div className="wc-fu-row">
            <label htmlFor="wc-fu-out">What happened?</label>
            <Combo id="wc-fu-out" value={outcome} onChange={(e) => setOutcome(e.target.value)} emptyText="No such answer">
              {(data.outcomes || []).map((o) => <option key={o} value={o}>{o}</option>)}
            </Combo>
          </div>
          <div className="wc-fu-row">
            <label htmlFor="wc-fu-next">What next?</label>
            <Combo id="wc-fu-next" value={nextStep} onChange={(e) => setNextStep(e.target.value)} emptyText="No such step">
              {(data.nextSteps || []).map((o) => <option key={o} value={o}>{o}</option>)}
            </Combo>
          </div>
          {needsDate && (
            <div className="wc-fu-row">
              <label htmlFor="wc-fu-nd">When?</label>
              <input id="wc-fu-nd" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              <input type="time" aria-label="Time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
          )}
          <div className="wc-fu-row">
            <label htmlFor="wc-fu-dn">Note</label>
            <input id="wc-fu-dn" value={note} maxLength={400} placeholder="Optional" onChange={(e) => setNote(e.target.value)} />
          </div>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={finish}>{busy ? 'Saving…' : 'Save and mark done'}</button>
        </div>
      )}
      {msg && <div className={`wc-fu-msg ${msg.ok ? 'ok' : 'bad'}`} role="status">{msg.text}</div>}
      {open && (
        <div className="wc-fu-more">
          {app.history.length === 0 ? <div className="small-muted">No finished follow-ups yet.</div> : (
            <ul>
              {app.history.map((h) => <li key={h.id}><b>{h.outcome || 'Done'}</b>{h.nextStep ? ` → ${h.nextStep}` : ''} <span className="small-muted">· {h.dueDate || ''}{h.ownerName ? ` · ${h.ownerName}` : ''}</span></li>)}
            </ul>
          )}
          <div className="small-muted">Step now: <b>{app.stageLabel}</b> · {app.requirementTitle}{app.clientName ? ` · ${app.clientName}` : ''}</div>
        </div>
      )}
    </div>
  );
}
