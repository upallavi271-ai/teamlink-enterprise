import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import api from '../../api';
import StatusChip from '../ui/StatusChip.jsx';
import {
  istDate, istTime, fromIst, addDays, when, STATUS_WORD, STATUS_TONE,
} from './remUtil.js';
import AdvancedScheduler, {
  defaultRecurring, specPayload, useSchedulePreview, ScheduleSummary,
} from './AdvancedScheduler.jsx';
import ScheduleList from './ScheduleList.jsx';
import './reminders.css';

// ---------------------------------------------------------------------------
// "Schedule a message" - a tab of the candidate profile (founder 2026-11-20: "there must be an option to schedule ANY kind of message").
// A recruiter / team lead writes any message to this candidate and schedules it for a later date and time on WhatsApp, SMS or Email, then sees
// every scheduled / sent / failed / cancelled message of the person; edits or cancels a waiting one; "Send again" on a failed one makes a new one.
// The automatic interview / joining reminders of the person are listed below, read-only: one place to see everything scheduled.
// BDE side: only the numbers. (backend: /api/ats/reminders/messages/*, utils/scheduledMessages.js)
// ---------------------------------------------------------------------------
const fillWords = (text, ctx) => String(text || '').replace(/\{([a-z_]+)\}/gi, (m, n) => (ctx && ctx[n.toLowerCase()] != null && ['name', 'recruiter', 'company', 'requirement', 'client'].includes(n.toLowerCase()) ? ctx[n.toLowerCase()] : m));
const roundUp5 = (ms) => Math.ceil(ms / 300000) * 300000;
const sectionOf = (m) => (m.status === 'planned' ? 'planned' : ['sent', 'delivered'].includes(m.status) ? 'sent' : ['failed', 'skipped'].includes(m.status) ? 'failed' : 'cancelled');

function Row({ m, onEdit, onCancel, onAgain, busy }) {
  const [open, setOpen] = useState(false);
  const section = sectionOf(m);
  return (
    <div className="sm-row" data-testid={`sm-row-${section}`}>
      <div className="sm-row-top">
        <b>{when(m.sendAt)}</b>
        <span className="small-muted">{m.channel}</span>
        <StatusChip tone={section === 'planned' ? 'blue' : STATUS_TONE[m.status] || 'grey'}>{section === 'planned' ? 'Waiting' : (STATUS_WORD[m.status] || m.status)}</StatusChip>
        {m.deliveryStatus && section === 'sent' && m.deliveryStatus !== 'Sent' && <span className="small-muted">{m.deliveryStatus}</span>}
        <span className="small-muted sm-by">{m.createdBy ? `by ${m.createdBy}` : ''}</span>
      </div>
      {m.channel === 'Email' && m.subject && <div className="small-muted" style={{ fontSize: 12 }}>{`Subject: ${m.subject}`}</div>}
      <div className="sm-words">{(section === 'sent' && m.text) || m.body}</div>
      {m.reason && section !== 'planned' && <div className={section === 'failed' ? 'rem-bad' : 'rem-hist'}>{m.reason}</div>}
      {m.reason && section === 'planned' && <div className="rem-warn">{m.reason}</div>}
      <div className="rem-actions" style={{ marginTop: 4 }}>
        {section === 'planned' && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onEdit(m)}>Edit</button>}
        {section === 'planned' && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => onCancel(m)}>Cancel</button>}
        {section === 'failed' && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => onAgain(m)}>Send again</button>}
        {m.history && m.history.length > 1 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(!open)}>{open ? 'Hide history' : 'History'}</button>}
      </div>
      {open && <div className="rem-hist">{m.history.map((h) => `${when(h.at)} · ${h.by}: ${h.text}`).join('\n')}</div>}
    </div>
  );
}

export default function ScheduleMessageTab({ candidateId, applicationId = null }) {
  const [d, setD] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const [channel, setChannel] = useState('WhatsApp');
  const [pick, setPick] = useState('tomorrow'); // in1h | today5 | tomorrow | custom
  const [date, setDate] = useState('');
  const [time, setTime] = useState('10:00');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [editing, setEditing] = useState(null); // the message being edited
  const [err, setErr] = useState('');
  const [suggest, setSuggest] = useState(null);
  const [note, setNote] = useState('');
  const [warn, setWarn] = useState('');
  const [busy, setBusy] = useState(false);
  // ADVANCED SCHEDULING (2026-11-20): one-time or recurring, more recipients, the live summary
  const [howOften, setHowOften] = useState('one'); // one | rec
  const [rec, setRec] = useState(() => defaultRecurring());
  const [others, setOthers] = useState([]); // more candidates: [{ id, name }]
  const [find, setFind] = useState('');
  const [found, setFound] = useState([]);
  const [editSched, setEditSched] = useState(null); // a repeating schedule being changed
  const [result, setResult] = useState(null); // { created, skipped, refused } of a many-candidates schedule
  const idem = useRef(`${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const area = useRef(null);
  const formRef = useRef(null);

  useEffect(() => {
    if (!candidateId) return undefined;
    let live = true;
    api.get(`/ats/reminders/messages/candidate/${candidateId}`, { params: applicationId ? { applicationId } : {} })
      .then((r) => { if (live) { setD(r.data); setLoadErr(''); } })
      .catch((e) => { if (live) { setD(null); setLoadErr(e.response?.data?.error || 'Could not load the scheduled messages.'); } });
    return () => { live = false; };
  }, [candidateId, applicationId, tick]);

  // the quick buttons set the date and time (India time); "Pick date and time" lets the person type them
  const choose = (kind) => {
    setPick(kind); setErr(''); setSuggest(null);
    const now = Date.now();
    if (kind === 'in1h') { const t = new Date(roundUp5(now + 3600000)).toISOString(); setDate(istDate(t)); setTime(istTime(t)); }
    else if (kind === 'today5') { setDate(istDate(new Date(now).toISOString())); setTime('17:00'); }
    else if (kind === 'tomorrow') { setDate(addDays(istDate(new Date(now).toISOString()), 1)); setTime('10:00'); }
  };
  useEffect(() => { if (!date) choose('tomorrow'); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const chOf = (name) => (d && d.channels ? d.channels.find((c) => c.channel === name) : null);
  // when the chosen way cannot be used for this person, move to one that can
  useEffect(() => {
    if (!d || !d.channels) return;
    const cur = d.channels.find((c) => c.channel === channel);
    if (cur && !cur.offered) { const first = d.channels.find((c) => c.offered); if (first) setChannel(first.channel); }
  }, [d]); // eslint-disable-line react-hooks/exhaustive-deps

  const sendAtIso = fromIst(date, time);
  const preview = useMemo(() => {
    if (!d || !d.context) return '';
    const words = fillWords(body, d.context).trim();
    const foot = (d.footer && d.footer[channel]) || '';
    return [words, foot].filter(Boolean).join('\n\n');
  }, [d, body, channel]);
  const previewSubject = useMemo(() => (d && d.context ? fillWords(subject || 'A message from TeamLink', d.context) : ''), [d, subject]);

  const resetForm = () => {
    setEditing(null); setEditSched(null); setBody(''); setSubject(''); setErr(''); setSuggest(null); choose('tomorrow');
    setOthers([]); setFind(''); setFound([]); idem.current = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  };
  // the window of the company (07:00-20:00) as the default of a new recurring schedule
  useEffect(() => { if (d && d.advanced && !editSched) setRec((r) => ({ ...r, windowStart: d.advanced.window.start, windowEnd: d.advanced.window.end })); }, [d && d.advanced]); // eslint-disable-line react-hooks/exhaustive-deps
  // more recipients: the candidate search of the app (only candidates this login may see are offered; the server checks again)
  useEffect(() => {
    if (!find.trim()) { setFound([]); return undefined; }
    const t = setTimeout(() => { api.get('/candidates/picker', { params: { q: find.trim() } }).then((r) => setFound((r.data.rows || []).filter((c) => c.id !== candidateId && !others.some((o) => o.id === c.id)).slice(0, 8))).catch(() => setFound([])); }, 250);
    return () => clearTimeout(t);
  }, [find]); // eslint-disable-line react-hooks/exhaustive-deps
  const advancedPayload = howOften === 'rec' ? specPayload(rec) : (sendAtIso ? { kind: 'one-time', startAt: sendAtIso } : null);
  const preview2 = useSchedulePreview(advancedPayload, !!d && d.access === 'full' && !editing);
  const insert = (text) => {
    const el = area.current;
    if (!el) { setBody((b) => `${b}${text}`); return; }
    const s = el.selectionStart == null ? body.length : el.selectionStart;
    const e = el.selectionEnd == null ? body.length : el.selectionEnd;
    const next = body.slice(0, s) + text + body.slice(e);
    setBody(next);
    setTimeout(() => { try { el.focus(); el.setSelectionRange(s + text.length, s + text.length); } catch { /* none */ } }, 0);
  };
  const applyTemplate = (t) => {
    setBody(t.body); if (channel === 'Email') setSubject(t.subject);
    setTimeout(() => { try { area.current && area.current.focus(); } catch { /* none */ } }, 0);
  };
  const toForm = () => { try { formRef.current && formRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch { /* none */ } };

  const submit = async () => {
    setErr(''); setSuggest(null); setNote(''); setWarn(''); setResult(null);
    if (!body.trim()) { setErr('Write the message first.'); return; }
    if (howOften === 'one' && !sendAtIso) { setErr('Pick the date and time when the message should go.'); return; }
    // a recurring message, a repeating schedule being changed, or more than one candidate: the schedule engine (/api/ats/scheduled-messages)
    if (howOften === 'rec' || editSched || others.length) {
      setBusy(true);
      try {
        const words = { channel, body, ...(channel === 'Email' ? { subject } : {}) };
        if (editSched) {
          const r = await api.patch(`/ats/scheduled-messages/${editSched.id}`, { ...words, ...specPayload(rec) });
          setNote(`Changes saved: ${r.data.schedule.frequencyLabel}. The messages already sent stay as they are.`);
        } else {
          const ids = [candidateId, ...others.map((o) => o.id)];
          const r = await api.post('/ats/scheduled-messages', {
            ...words, candidateIds: ids, ...(applicationId ? { applicationIds: { [candidateId]: applicationId } } : {}), idempotencyKey: idem.current,
            ...(howOften === 'rec' ? specPayload(rec) : { kind: 'one-time', startAt: sendAtIso }),
          });
          const s = r.data.summary;
          setNote(`Scheduled: ${s.label}${s.first ? `, first ${when(s.first)}` : ''}${ids.length > 1 ? ` - ${r.data.message}` : ''}.`);
          if (ids.length > 1) setResult(r.data);
        }
        resetForm(); reload();
      } catch (e) {
        const b = e.response?.data || {};
        setErr(b.error || 'Could not schedule the message. Please try again.');
        if (b.created || b.refused || b.skipped) setResult(b);
      } finally { setBusy(false); }
      return;
    }
    setBusy(true);
    try {
      const payload = { channel, sendAt: sendAtIso, body, ...(channel === 'Email' ? { subject } : {}), ...(applicationId ? { applicationId } : {}) };
      const r = editing ? await api.patch(`/ats/reminders/messages/${editing.id}`, payload) : await api.post(`/ats/reminders/messages/candidate/${candidateId}`, payload);
      setNote(`${editing ? 'Changes saved.' : 'Scheduled.'} It goes ${when(r.data.message.sendAt)} by ${r.data.message.channel}.`);
      setWarn(r.data.warning || '');
      resetForm(); reload();
    } catch (e) {
      setErr(e.response?.data?.error || 'Could not schedule the message. Please try again.');
      setSuggest(e.response?.data?.suggestion || null);
    } finally { setBusy(false); }
  };
  // a repeating schedule: its words and its timing come back into the form
  const editSchedule = (s) => {
    setEditing(null); setEditSched(s); setHowOften('rec'); setChannel(s.channel); setBody(s.body || ''); setSubject(s.subject || ''); setErr(''); setNote(''); setResult(null);
    const start = s.nextAt || s.startAt;
    setRec({
      kind: 'recurring', frequency: s.frequency || 'daily', weekdays: s.weekdays && s.weekdays.length ? s.weekdays : [1], monthDay: s.monthDay || 1, intervalValue: s.intervalValue || 2, intervalUnit: s.intervalUnit || 'days',
      startDate: istDate(start), startTime: istTime(start), endMode: s.endMode || 'count', totalCount: s.totalCount || 5, endDate: s.endDate || addDays(istDate(start), 6),
      timezone: s.timezone || 'Asia/Kolkata', windowStart: s.windowStart || '07:00', windowEnd: s.windowEnd || '20:00',
    });
    toForm();
  };
  const edit = (m) => {
    setEditSched(null); setHowOften('one');
    setEditing(m); setChannel(m.channel); setBody(m.body || ''); setSubject(m.subject || ''); setDate(istDate(m.sendAt)); setTime(istTime(m.sendAt)); setPick('custom'); setErr(''); setSuggest(null); setNote('');
    toForm();
  };
  const cancel = async (m) => {
    if (!window.confirm('Cancel this message? It will not be sent.')) return;
    setBusy(true); setErr(''); setNote('');
    try { await api.delete(`/ats/reminders/messages/${m.id}`); setNote('Cancelled.'); reload(); } catch (e) { setErr(e.response?.data?.error || 'Could not cancel it.'); } finally { setBusy(false); }
  };
  const again = (m) => {
    setEditing(null); setChannel(m.channel); setBody(m.body || ''); setSubject(m.subject || ''); setErr(''); setSuggest(null);
    choose('tomorrow'); setNote('The words are ready below. Pick a new time and press Schedule message.');
    toForm();
  };

  if (!d) return <div className="card section"><b>Schedule a message</b><div className="small-muted" style={{ marginTop: 6 }}>{loadErr || 'Loading...'}</div></div>;

  if (d.access === 'count') {
    return (
      <div className="card section sm-wrap">
        <b>Scheduled messages</b>
        <div className="small-muted" style={{ margin: '6px 0' }}>{d.note}</div>
        <div className="rem-card-nums">
          <span><b>{d.counts.planned}</b> waiting</span>
          <span><b>{d.counts.sent}</b> sent</span>
          <span><b>{d.counts.failed}</b> failed</span>
          <span><b>{d.automaticCount}</b> automatic reminders</span>
        </div>
      </div>
    );
  }

  const groups = { planned: [], sent: [], failed: [], cancelled: [] };
  d.messages.forEach((m) => groups[sectionOf(m)].push(m));
  groups.planned.sort((a, b) => a.sendAt.localeCompare(b.sendAt));
  ['sent', 'failed', 'cancelled'].forEach((k) => groups[k].sort((a, b) => b.sendAt.localeCompare(a.sendAt)));
  const over = body.length > d.maxLength;
  const offered = d.channels.filter((c) => c.offered).length;
  const quickBtn = (id, label, extra = {}) => (
    <button type="button" key={id} className={`btn btn-sm${pick === id ? ' btn-primary' : ''}`} onClick={() => choose(id)} {...extra}>{label}</button>
  );
  const nowIst = istTime(new Date().toISOString());
  const todayPast = nowIst >= '17:00';

  return (
    <div className="sm-wrap">
      <div className="card section" ref={formRef}>
        <div className="rem-head"><b>{editing || editSched ? 'Change a scheduled message' : 'Schedule a message'}</b><span className="small-muted">{`to ${d.candidate.name}: any message, sent later on WhatsApp, SMS or Email`}</span></div>
        {d.blocked && <div className="rem-bad" style={{ margin: '6px 0' }}>{d.blocked}</div>}
        {!d.blocked && offered === 0 && <div className="rem-warn" style={{ margin: '6px 0' }}>No way is available for this candidate right now. See the reasons below each way.</div>}

        <div className="sm-label">How should it go?</div>
        <div className="sm-ways" role="group" aria-label="Way">
          {d.channels.map((c) => (
            <div key={c.channel} className="sm-way">
              <button type="button" className={`btn btn-sm${channel === c.channel ? ' btn-primary' : ''}`} disabled={!c.offered} aria-pressed={channel === c.channel} onClick={() => setChannel(c.channel)}>{c.channel}</button>
              {!c.offered && c.reason && <div className="rem-need">{c.reason}</div>}
            </div>
          ))}
        </div>

        <div className="sm-label">When should it go?</div>
        {!editing && (
          <div className="rem-quick" role="group" aria-label="One-time or recurring" style={{ marginBottom: 6 }}>
            <button type="button" className={`btn btn-sm${howOften === 'one' ? ' btn-primary' : ''}`} aria-pressed={howOften === 'one'} disabled={!!editSched} onClick={() => setHowOften('one')}>One-time message (send once)</button>
            <button type="button" className={`btn btn-sm${howOften === 'rec' ? ' btn-primary' : ''}`} aria-pressed={howOften === 'rec'} onClick={() => setHowOften('rec')}>Recurring message (send multiple times)</button>
          </div>
        )}
        {howOften === 'rec' && <AdvancedScheduler value={rec} onChange={setRec} timezones={(d.advanced && d.advanced.timezones) || []} hours={d.advanced ? d.advanced.window : undefined} />}
        {howOften === 'one' && (
        <>
        <div className="rem-quick">
          {quickBtn('in1h', 'In 1 hour')}
          {quickBtn('today5', 'Today 5 PM', todayPast ? { disabled: true, title: 'It is already past 5 PM today' } : {})}
          {quickBtn('tomorrow', 'Tomorrow 10 AM')}
          {quickBtn('custom', 'Pick date and time')}
        </div>
        {pick === 'custom' && (
          <div className="rem-actions" style={{ marginTop: 6 }}>
            <input type="date" aria-label="Date" value={date} min={istDate(new Date().toISOString())} onChange={(e) => setDate(e.target.value)} />
            <input type="time" aria-label="Time" value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
        )}
        <div className="small-muted" style={{ marginTop: 4 }}>
          {sendAtIso ? `It goes ${when(sendAtIst(date, time))} (India time).` : 'Pick a date and time.'}
          {` Messages go between ${String(d.hours.earliest).padStart(2, '0')}:00 and ${String(d.hours.latest).padStart(2, '0')}:00, at least ${d.minAheadMinutes} minutes from now.`}
        </div>
        </>
        )}

        {!editing && !editSched && (
          <>
            <div className="sm-label">Recipient candidates</div>
            <div className="rem-quick" aria-label="Recipients">
              <span className="sm-recip">{d.candidate.name}</span>
              {others.map((o) => <span key={o.id} className="sm-recip">{o.name}<button type="button" className="link-btn" aria-label={`Remove ${o.name}`} onClick={() => setOthers(others.filter((x) => x.id !== o.id))}>×</button></span>)}
            </div>
            <input type="search" className="sm-subject" style={{ marginTop: 4 }} aria-label="Add more candidates" placeholder="Add more candidates: type a name or mobile" value={find} onChange={(e) => setFind(e.target.value)} />
            {found.length > 0 && (
              <div className="sm-found">
                {found.map((c) => <button type="button" key={c.id} className="btn btn-sm btn-ghost" onClick={() => { setOthers([...others, { id: c.id, name: c.name }]); setFind(''); setFound([]); }}>{`+ ${c.name}`}</button>)}
              </div>
            )}
            {others.length > 0 && <div className="small-muted" style={{ fontSize: 11.5 }}>Each candidate gets a schedule of their own (their own progress and stop rules). A candidate outside your area, or one who asked not to be contacted, is left out with the reason.</div>}
          </>
        )}

        {channel === 'Email' && (
          <>
            <div className="sm-label">Subject</div>
            <input type="text" className="sm-subject" aria-label="Subject" maxLength={150} placeholder="A message from TeamLink" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </>
        )}

        <div className="sm-label">Message</div>
        <div className="rem-quick" aria-label="Ready messages">
          {d.templates.map((t) => <button type="button" key={t.key} className="btn btn-sm btn-ghost sm-chip" onClick={() => applyTemplate(t)}>{t.label}</button>)}
        </div>
        <textarea ref={area} className="sm-area" aria-label="Message" rows={5} value={body} placeholder="Write your message here, or pick a ready message above and change it." onChange={(e) => setBody(e.target.value)} />
        <div className="sm-count">
          <span className="rem-quick">
            {d.placeholders.map((p) => <button type="button" key={p.key} className="btn btn-sm btn-ghost sm-chip" title={p.label} onClick={() => insert(`{${p.key}}`)}>{`{${p.key}}`}</button>)}
          </span>
          <span className={over ? 'rem-bad' : 'small-muted'}>{`${body.length} / ${d.maxLength}`}</span>
        </div>
        <div className="small-muted" style={{ fontSize: 11.5 }}>Placeholders are filled when the message goes: {'{name}'} the candidate's first name, {'{recruiter}'} your name, {'{requirement}'} the job, {'{client}'} the client, {'{company}'} TeamLink.</div>

        {body.trim() && (
          <div className="rem-text sm-preview" aria-label="Preview">
            <div className="small-muted" style={{ marginBottom: 4 }}>{`Preview: what ${d.candidate.firstName || 'the candidate'} will read`}</div>
            {channel === 'Email' && <div><b>{`Subject: ${previewSubject}`}</b></div>}
            {preview}
          </div>
        )}
        {channel === 'WhatsApp' && <div className="small-muted" style={{ fontSize: 11.5, marginTop: 4 }}>WhatsApp: if the candidate has not written to us in the last 24 hours, the message goes through the company's approved general template.</div>}
        {!editing && <ScheduleSummary summary={preview2.summary} error={preview2.error} busy={preview2.busy} />}

        {err && <div className="rem-bad" role="alert" style={{ marginTop: 6 }}>{err}</div>}
        {suggest && <div style={{ marginTop: 4 }}><button type="button" className="btn btn-sm" onClick={() => { setPick('custom'); setDate(istDate(suggest.sendAt)); setTime(istTime(suggest.sendAt)); setErr(''); setSuggest(null); }}>{`Use ${suggest.words}`}</button></div>}
        {note && <div className="rem-warn" style={{ marginTop: 6, color: 'var(--green, #15803d)' }} role="status">{note}</div>}
        {warn && <div className="rem-warn" style={{ marginTop: 4 }}>{warn}</div>}
        {result && (result.skipped?.length > 0 || result.refused?.length > 0) && (
          <div className="rem-warn" style={{ marginTop: 4 }} data-testid="sm-left-out">
            {[...(result.skipped || []), ...(result.refused || [])].map((x) => <div key={x.candidateId}>{`${x.name || 'A candidate'}: ${x.reason}`}</div>)}
          </div>
        )}
        <div className="rem-actions" style={{ marginTop: 8 }}>
          <button type="button" className="btn btn-primary" disabled={busy || over || !!d.blocked || offered === 0} onClick={submit}>{busy ? 'Saving...' : (editing || editSched ? 'Save changes' : 'Schedule message')}</button>
          {(editing || editSched) && <button type="button" className="btn btn-ghost" onClick={resetForm}>Stop editing</button>}
        </div>
        <div className="small-muted" style={{ fontSize: 11.5, marginTop: 6 }}>{d.note}</div>
      </div>

      <div className="card section" data-testid="sm-lists">
        <div className="rem-head"><b>Scheduled messages</b><span className="small-muted">{`${d.counts.planned} waiting · ${d.counts.sent} sent${d.counts.failed ? ` · ${d.counts.failed} failed` : ''}${d.counts.cancelled ? ` · ${d.counts.cancelled} cancelled` : ''}`}</span></div>
        {!d.messages.length && <div className="small-muted">Nothing scheduled for this candidate yet.</div>}
        {[['planned', 'Scheduled'], ['sent', 'Sent'], ['failed', 'Failed or not sent'], ['cancelled', 'Cancelled']].map(([k, label]) => groups[k].length > 0 && (
          <div key={k} className="sm-group">
            <div className="sm-label">{`${label} (${groups[k].length})`}</div>
            {groups[k].map((m) => <Row key={m.id} m={m} busy={busy} onEdit={edit} onCancel={cancel} onAgain={again} />)}
          </div>
        ))}
      </div>

      {d.schedules && d.schedules.length > 0 && (
        <div className="card section" data-testid="sm-schedules">
          <div className="rem-head"><b>Repeating and automatic schedules</b><span className="small-muted">Each line is one schedule: open it to see every message (scheduled, sent, delivered, failed).</span></div>
          <ScheduleList rows={d.schedules} onChanged={reload} onEdit={editSchedule} compact />
        </div>
      )}

      {d.automatic.length > 0 && (
        <div className="card section" data-testid="sm-auto">
          <div className="rem-head"><b>Automatic reminders</b><span className="small-muted">Interview and joining reminders the system sends by itself. Change them on the interview or joining screen.</span></div>
          {!d.autoSwitchOn && <div className="rem-warn" style={{ margin: '4px 0' }}>The automatic reminders are switched off for now (an Admin turns them on). Your own messages above are not affected.</div>}
          <div style={{ overflowX: 'auto' }}>
            <table className="rem-table">
              <thead><tr><th>Goes</th><th>What</th><th>Way</th><th>Status</th></tr></thead>
              <tbody>
                {d.automatic.map((a) => (
                  <tr key={a.id}>
                    <td><b>{when(a.sendAt)}</b></td>
                    <td>{a.label}{a.role && <div className="small-muted" style={{ fontSize: 11 }}>{a.role}</div>}</td>
                    <td>{a.channel}</td>
                    <td><StatusChip tone={STATUS_TONE[a.status] || 'grey'}>{STATUS_WORD[a.status] || a.status}</StatusChip>{a.reason && ['failed', 'skipped'].includes(a.status) && <div className="rem-hist">{a.reason}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// "Sat 21 Nov, 10:00 am" for a date and time typed in India time
function sendAtIst(date, time) { return fromIst(date, time); }
