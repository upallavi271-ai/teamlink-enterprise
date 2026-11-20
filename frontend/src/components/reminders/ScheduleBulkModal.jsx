import { useEffect, useRef, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import {
  istDate, istTime, fromIst, addDays, when,
} from './remUtil.js';
import AdvancedScheduler, {
  defaultRecurring, specPayload, useSchedulePreview, ScheduleSummary,
} from './AdvancedScheduler.jsx';
import './reminders.css';

// ---------------------------------------------------------------------------
// "Schedule a message" for SEVERAL candidates at once (the Candidates & Pipeline list: tick the rows, then the action), and the Edit window
// of the Scheduled Messages page. The same sections as the candidate tab: how (WhatsApp / SMS / Email), when (one-time | recurring with the
// advanced choices), the words (templates, placeholders), the live summary. ONE schedule per candidate, made together; a candidate outside
// your area or one who asked not to be contacted is left out with the reason (backend: POST /api/ats/scheduled-messages).
//   <ScheduleBulkModal candidates={[{ id, name, applicationId }]} onClose onDone />      new, for the ticked candidates
//   <ScheduleBulkModal schedule={row} onClose onDone />                                   change one schedule
// ---------------------------------------------------------------------------
const fill = (text, ctx) => String(text || '').replace(/\{([a-z_]+)\}/gi, (m, n) => (ctx[n.toLowerCase()] != null ? ctx[n.toLowerCase()] : m));

export default function ScheduleBulkModal({ candidates = [], schedule = null, onClose, onDone }) {
  const [opt, setOpt] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [channel, setChannel] = useState(schedule ? schedule.channel : 'WhatsApp');
  const [howOften, setHowOften] = useState(schedule && schedule.kind === 'recurring' ? 'rec' : (schedule ? 'one' : 'rec'));
  const start = schedule ? (schedule.nextAt || schedule.startAt) : null;
  const [date, setDate] = useState(start ? istDate(start) : addDays(istDate(new Date().toISOString()), 1));
  const [time, setTime] = useState(start ? istTime(start) : '10:00');
  const [rec, setRec] = useState(() => (schedule ? {
    kind: 'recurring', frequency: schedule.frequency || 'daily', weekdays: schedule.weekdays && schedule.weekdays.length ? schedule.weekdays : [1], monthDay: schedule.monthDay || 1,
    intervalValue: schedule.intervalValue || 2, intervalUnit: schedule.intervalUnit || 'days', startDate: istDate(start), startTime: istTime(start), endMode: schedule.endMode || 'count',
    totalCount: schedule.totalCount || 5, endDate: schedule.endDate || addDays(istDate(start), 6), timezone: schedule.timezone || 'Asia/Kolkata', windowStart: schedule.windowStart || '07:00', windowEnd: schedule.windowEnd || '20:00',
  } : defaultRecurring()));
  const [subject, setSubject] = useState(schedule ? schedule.subject || '' : '');
  const [body, setBody] = useState(schedule ? schedule.body || '' : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);
  const idem = useRef(`${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  useEffect(() => {
    api.get('/ats/scheduled-messages/options').then((r) => {
      setOpt(r.data);
      if (!schedule) setRec((x) => ({ ...x, windowStart: r.data.hours.windowStart, windowEnd: r.data.hours.windowEnd }));
      const first = r.data.channels.find((c) => c.ready);
      if (!schedule && first && !r.data.channels.find((c) => c.channel === 'WhatsApp' && c.ready)) setChannel(first.channel);
    }).catch((e) => setLoadErr(e.response?.data?.error || 'Could not open the scheduler.'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const sendAt = fromIst(date, time);
  const payload = howOften === 'rec' ? specPayload(rec) : (sendAt ? { kind: 'one-time', startAt: sendAt } : null);
  const pv = useSchedulePreview(payload, !!opt);
  const title = schedule ? `Change the schedule - ${schedule.candidate ? schedule.candidate.name : ''}` : `Schedule a message - ${candidates.length} candidate${candidates.length === 1 ? '' : 's'}`;

  async function submit() {
    setErr('');
    if (!body.trim()) { setErr('Write the message first.'); return; }
    setBusy(true);
    try {
      const words = { channel, body, ...(channel === 'Email' ? { subject } : {}) };
      if (schedule) {
        const r = await api.patch(`/ats/scheduled-messages/${schedule.id}`, { ...words, ...payload });
        onDone && onDone(r.data);
        onClose();
        return;
      }
      const ids = [...new Set(candidates.map((c) => c.id))];
      const appIds = {};
      candidates.forEach((c) => { if (c.applicationId && !appIds[c.id]) appIds[c.id] = c.applicationId; });
      const r = await api.post('/ats/scheduled-messages', { ...words, ...payload, candidateIds: ids, applicationIds: appIds, idempotencyKey: idem.current });
      setResult(r.data);
      onDone && onDone(r.data);
    } catch (e) {
      const b = e.response?.data || {};
      if (b.created || b.skipped || b.refused) setResult(b);
      setErr(b.error || 'Could not schedule. Please try again.');
    } finally { setBusy(false); }
  }

  if (result) {
    const nameOf = (x) => x.name || (candidates.find((c) => c.id === x.candidateId) || {}).name || 'A candidate';
    return (
      <Modal title={`${title} - done`} onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>Close</button>}>
        <div className={`notice${(result.skipped || []).length + (result.refused || []).length ? ' amber' : ''}`} data-testid="sm-bulk-result">
          <b>{(result.created || []).length}</b>{` of ${candidates.length} scheduled${result.summary ? ` (${result.summary.label}, first ${when(result.summary.first)})` : ''}.`}
        </div>
        {(result.created || []).length > 0 && <div className="small-muted" style={{ margin: '6px 0' }}>{`Scheduled: ${result.created.map(nameOf).join(', ')}`}</div>}
        {[...(result.skipped || []), ...(result.refused || [])].map((x) => <div key={x.candidateId} className="rem-warn">{`${nameOf(x)}: ${x.reason}`}</div>)}
        <div className="small-muted" style={{ marginTop: 6 }}>See them all on ATS &gt; Scheduled Messages.</div>
      </Modal>
    );
  }

  return (
    <Modal
      title={title}
      size="wide"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || !opt || !body.trim() || body.length > ((opt && opt.maxLength) || 1000)} onClick={submit}>{busy ? 'Saving...' : (schedule ? 'Save changes' : 'Schedule message')}</button>
        </>
      )}
    >
      {loadErr && <div className="error-text">{loadErr}</div>}
      {!opt && !loadErr && <div className="small-muted">Loading…</div>}
      {opt && (
        <div className="sm-wrap" data-testid="sm-bulk">
          {!schedule && (
            <div>
              <div className="sm-label" style={{ marginTop: 0 }}>Recipient candidates</div>
              <div className="rem-quick">{candidates.slice(0, 30).map((c) => <span key={`${c.id}-${c.applicationId || ''}`} className="sm-recip">{c.name}</span>)}{candidates.length > 30 && <span className="small-muted">{`+${candidates.length - 30} more`}</span>}</div>
              <div className="small-muted" style={{ fontSize: 11.5 }}>Each candidate gets a schedule of their own. One outside your area, or one who asked not to be contacted, is left out with the reason.</div>
            </div>
          )}
          <div>
            <div className="sm-label">How should it go?</div>
            <div className="sm-ways" role="group" aria-label="Way">
              {opt.channels.map((c) => (
                <div key={c.channel} className="sm-way">
                  <button type="button" className={`btn btn-sm${channel === c.channel ? ' btn-primary' : ''}`} disabled={!c.ready} aria-pressed={channel === c.channel} onClick={() => setChannel(c.channel)}>{c.channel}</button>
                  {!c.ready && <div className="rem-need">{`Not connected${c.reason ? ` (${c.reason})` : ''}`}</div>}
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="sm-label">When should it go?</div>
            <div className="rem-quick" role="group" aria-label="One-time or recurring">
              <button type="button" className={`btn btn-sm${howOften === 'one' ? ' btn-primary' : ''}`} aria-pressed={howOften === 'one'} disabled={!!schedule && schedule.kind === 'recurring'} onClick={() => setHowOften('one')}>One-time message (send once)</button>
              <button type="button" className={`btn btn-sm${howOften === 'rec' ? ' btn-primary' : ''}`} aria-pressed={howOften === 'rec'} onClick={() => setHowOften('rec')}>Recurring message (send multiple times)</button>
            </div>
            {howOften === 'one' && (
              <div className="rem-actions" style={{ marginTop: 6 }}>
                <input type="date" aria-label="Date" value={date} min={istDate(new Date().toISOString())} onChange={(e) => setDate(e.target.value)} />
                <input type="time" aria-label="Time" value={time} onChange={(e) => setTime(e.target.value)} />
              </div>
            )}
            {howOften === 'rec' && <AdvancedScheduler value={rec} onChange={setRec} timezones={opt.timezones} hours={{ start: opt.hours.windowStart, end: opt.hours.windowEnd }} />}
          </div>
          <div>
            {channel === 'Email' && (
              <>
                <div className="sm-label">Subject</div>
                <input type="text" className="sm-subject" aria-label="Subject" maxLength={150} placeholder="A message from TeamLink" value={subject} onChange={(e) => setSubject(e.target.value)} />
              </>
            )}
            <div className="sm-label">Message</div>
            <div className="rem-quick" aria-label="Ready messages">
              {opt.templates.map((t) => <button type="button" key={t.key} className="btn btn-sm btn-ghost sm-chip" onClick={() => { setBody(t.body); if (channel === 'Email') setSubject(t.subject); }}>{t.label}</button>)}
            </div>
            <textarea className="sm-area" aria-label="Message" rows={5} value={body} placeholder="Write your message here, or pick a ready message above and change it." onChange={(e) => setBody(e.target.value)} />
            <div className="sm-count">
              <span className="rem-quick">{opt.placeholders.map((p) => <button type="button" key={p.key} className="btn btn-sm btn-ghost sm-chip" title={p.label} onClick={() => setBody((b) => `${b}{${p.key}}`)}>{`{${p.key}}`}</button>)}</span>
              <span className={body.length > opt.maxLength ? 'rem-bad' : 'small-muted'}>{`${body.length} / ${opt.maxLength}`}</span>
            </div>
            <div className="small-muted" style={{ fontSize: 11.5 }}>Placeholders are filled for each candidate when the message goes: {'{name}'} their first name, {'{recruiter}'} your name, {'{requirement}'} the job, {'{client}'} the client, {'{company}'} TeamLink.</div>
            {body.trim() && candidates[0] && (
              <div className="rem-text sm-preview"><div className="small-muted" style={{ marginBottom: 4 }}>{`Preview for ${candidates[0].name}`}</div>{[fill(body, { name: String(candidates[0].name || '').split(' ')[0], company: 'TeamLink' }), (opt.footer || {})[channel] || ''].filter(Boolean).join('\n\n')}</div>
            )}
          </div>
          <ScheduleSummary summary={pv.summary} error={pv.error} busy={pv.busy} />
          {err && <div className="rem-bad" role="alert">{err}</div>}
        </div>
      )}
    </Modal>
  );
}
