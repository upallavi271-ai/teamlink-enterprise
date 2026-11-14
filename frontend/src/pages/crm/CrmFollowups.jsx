// CRM > FOLLOW-UPS (founder 2026-11-06, upgraded 2026-11-14): opens on NEEDS ACTION (due today + overdue, late first); Upcoming and Completed are the other tabs. "+ Follow-up" adds one for a lead, deal or account;
// filters by date range, owner, priority and type; each count is in its tab (late ones in red). A late follow-up is a red row that says how many days late it is, and whether the managers were told.
// Done asks what came of it (an outcome), what happened, and the next follow-up with its date, time, type and priority - the outcome and note go on the
// record's timeline. Follow-ups are added from a lead, a deal or an account (crmShared.jsx TaskList); the reminders are crm/sales.js runDue(), the
// overdue alert to the managers is crm/sales.js escalateOverdue().
import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { useCrm, errOf, dateOf, istToday, daysLate, RecLink, PriorityPill, DateField } from './crmShared.jsx';

const TABS = [['action', 'Needs action'], ['upcoming', 'Upcoming'], ['done', 'Completed']];
export const REMIND_WORDS = { 0: 'At the time', 15: '15 minutes before', 60: '1 hour before', 1440: '1 day before' };

// "Done": what came of it, what happened, and optionally the next follow-up (used here and in TaskList)
export function DoneDialog({ task, onClose, onDone }) {
  const { toast, me } = useCrm();
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');
  const [next, setNext] = useState('');
  const [nextTime, setNextTime] = useState('');
  const [nextTitle, setNextTitle] = useState('');
  const [nextType, setNextType] = useState(task.type || 'Call');
  const [nextPriority, setNextPriority] = useState(task.priority || 'Medium');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api.post(`/crm/tasks/${task.id}/done`, { note, outcome: outcome || undefined, next: next ? { dueDate: next, dueTime: nextTime || undefined, title: nextTitle || undefined, type: nextType, priority: nextPriority } : undefined });
      toast(next ? 'Done. The next follow-up is set.' : 'Done.');
      onDone();
    } catch (e) { toast(errOf(e, 'This could not be saved.')); setBusy(false); }
  }
  return (
    <Modal title={`Done: ${task.title}`} onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <div className="field">
        <label>What came of it?</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {me.lists.outcomes.map((o) => <button key={o} type="button" className={`btn btn-sm${outcome === o ? ' btn-primary' : ''}`} aria-pressed={outcome === o} onClick={() => setOutcome(outcome === o ? '' : o)}>{o}</button>)}
        </div>
      </div>
      <div className="field"><label>What happened?</label><textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Spoke to them: wants the proposal by Friday" /></div>
      <div className="small-muted" style={{ marginBottom: 8 }}>This is written on the timeline of the record.</div>
      <div className="section-label" style={{ marginTop: 4 }}>Next follow-up (optional)</div>
      <div className="grid-2">
        <div className="field"><label>Date</label><DateField min={istToday()} value={next} onChange={setNext} aria-label="Next follow-up date" /></div>
        <div className="field"><label>Time</label><input type="time" value={nextTime} disabled={!next} onChange={(e) => setNextTime(e.target.value)} /></div>
      </div>
      <div className="field"><label>What to do then</label><input type="text" value={nextTitle} disabled={!next} onChange={(e) => setNextTitle(e.target.value)} placeholder={task.title} /></div>
      <div className="grid-2">
        <div className="field"><label>Type</label><select value={nextType} disabled={!next} onChange={(e) => setNextType(e.target.value)}>{me.lists.taskTypes.map((x) => <option key={x}>{x}</option>)}</select></div>
        <div className="field"><label>Priority</label><select value={nextPriority} disabled={!next} onChange={(e) => setNextPriority(e.target.value)}>{me.lists.priorities.map((x) => <option key={x}>{x}</option>)}</select></div>
      </div>
    </Modal>
  );
}

// "+ Follow-up": pick WHAT it is for (search a lead, a deal or an account by name), then say what to do and when (founder 2026-11-14).
function NewFollowUp({ onClose, onAdded }) {
  const { me, toast } = useCrm();
  const [q, setQ] = useState('');
  const [found, setFound] = useState(null);
  const [rec, setRec] = useState(null); // { kind, id, name, sub }
  const [title, setTitle] = useState('');
  const [type, setType] = useState('Call');
  const [priority, setPriority] = useState('Medium');
  const [due, setDue] = useState(istToday());
  const [time, setTime] = useState('');
  const [before, setBefore] = useState(String(me.lists.defaultRemindBefore));
  const [inApp, setInApp] = useState(true);
  const [wa, setWa] = useState(false);
  const [sms, setSms] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) { setFound(null); return undefined; }
    let alive = true;
    const t = setTimeout(() => {
      const get = (path, params) => api.get(`/crm/${path}`, { params: { q: text, ...params } }).then((r) => r.data.rows || []).catch(() => []);
      Promise.all([get('leads', { status: 'all' }), get('deals', {}), get('accounts', {})]).then(([ls, ds, as]) => {
        if (!alive) return;
        setFound([
          ...ls.slice(0, 6).map((l) => ({ kind: 'lead', id: l.id, name: l.company, sub: `Lead · ${[l.contactName, l.stage].filter(Boolean).join(' · ')}` })),
          ...ds.slice(0, 6).map((d) => ({ kind: 'deal', id: d.id, name: d.title, sub: `Deal · ${[d.accountName, d.stage].filter(Boolean).join(' · ')}` })),
          ...as.slice(0, 6).map((a) => ({ kind: 'account', id: a.id, name: a.name, sub: `${a.kind === 'Client' ? 'Customer' : 'Account'}${a.city ? ` · ${a.city}` : ''}` })),
        ]);
      });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);
  async function save() {
    setBusy(true);
    try {
      await api.post('/crm/tasks', { title: title.trim(), dueDate: due, dueTime: time || undefined, type, priority, remindBefore: Number(before), notifyApp: inApp, notifyWhatsapp: wa, notifySms: sms, [`${rec.kind}Id`]: rec.id });
      toast('Follow-up added.');
      onAdded();
    } catch (e) { toast(errOf(e, 'The follow-up could not be added.')); setBusy(false); }
  }
  const ready = rec && title.trim() && due;
  return (
    <Modal title="New follow-up" onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy || !ready} onClick={save}>{busy ? 'Saving…' : 'Add follow-up'}</button></>}>
      <div className="field">
        <label>For which lead, deal or account?</label>
        {rec ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', border: '1px solid var(--line)', borderRadius: 8 }}>
            <span style={{ flex: 1, minWidth: 0 }}><b>{rec.name}</b><div className="small-muted" style={{ fontSize: 11.5 }}>{rec.sub}</div></span>
            <button type="button" className="btn btn-sm" onClick={() => { setRec(null); setQ(''); }}>Change</button>
          </div>
        ) : (
          <>
            <input type="text" autoFocus placeholder="Type a company, person or deal name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search leads, deals and accounts" />
            {found && !found.length && <div className="small-muted" style={{ marginTop: 6 }}>Nothing found. Add the lead first from Leads.</div>}
            {found && found.length > 0 && (
              <div style={{ border: '1px solid var(--line)', borderRadius: 8, marginTop: 6, maxHeight: 220, overflowY: 'auto' }}>
                {found.map((x) => (
                  <button key={`${x.kind}${x.id}`} type="button" onClick={() => setRec(x)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px', border: 0, borderBottom: '1px solid var(--line-soft)', background: 'transparent', cursor: 'pointer' }}>
                    <b>{x.name}</b><div className="small-muted" style={{ fontSize: 11.5 }}>{x.sub}</div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <div className="field"><label>What to do</label><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Call about the revised quote" /></div>
      <div className="grid-2">
        <div className="field"><label>Type</label><select value={type} onChange={(e) => setType(e.target.value)}>{me.lists.taskTypes.map((x) => <option key={x}>{x}</option>)}</select></div>
        <div className="field"><label>Priority</label><select value={priority} onChange={(e) => setPriority(e.target.value)}>{me.lists.priorities.map((x) => <option key={x}>{x}</option>)}</select></div>
      </div>
      <div className="grid-2">
        <div className="field"><label>Date</label><DateField value={due} onChange={setDue} aria-label="Due date" /></div>
        <div className="field"><label>Time</label><input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></div>
      </div>
      <div className="small-muted" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
        <span>Remind:</span>
        <select value={before} onChange={(e) => setBefore(e.target.value)} style={{ width: 150 }} aria-label="Remind before">{Object.entries(REMIND_WORDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <label><input type="checkbox" checked={inApp} onChange={(e) => setInApp(e.target.checked)} style={{ width: 'auto' }} /> In app</label>
        <label><input type="checkbox" checked={wa} onChange={(e) => setWa(e.target.checked)} style={{ width: 'auto' }} /> WhatsApp</label>
        <label><input type="checkbox" checked={sms} onChange={(e) => setSms(e.target.checked)} style={{ width: 'auto' }} /> SMS</label>
      </div>
    </Modal>
  );
}

// Reschedule: any day and time (Snooze has the quick ones)
function RescheduleDialog({ task, onClose, onDone }) {
  const { toast } = useCrm();
  const [date, setDate] = useState(task.dueDate < istToday() ? istToday() : task.dueDate);
  const [time, setTime] = useState(task.dueTime || '');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await api.post(`/crm/tasks/${task.id}/snooze`, { dueDate: date, dueTime: time }); toast(`Moved to ${dateOf(date)}${time ? ` at ${time}` : ''}.`); onDone(); } catch (e) { toast(errOf(e, 'This could not be moved.')); setBusy(false); }
  }
  return (
    <Modal title={`Move: ${task.title}`} onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy || !date} onClick={save}>{busy ? 'Saving…' : 'Move it'}</button></>}>
      <div className="grid-2">
        <div className="field"><label>New date</label><DateField min={istToday()} value={date} onChange={setDate} aria-label="New date" /></div>
        <div className="field"><label>New time (optional)</label><input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></div>
      </div>
      <div className="small-muted">It reminds again at the new time, and the managers are told again if it goes late again.</div>
    </Modal>
  );
}

export default function CrmFollowups() {
  const { me, toast, version, changed } = useCrm();
  const [tab, setTab] = useState('action'); // Needs action = due today + overdue
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [owner, setOwner] = useState('');
  const [priority, setPriority] = useState('');
  const [type, setType] = useState('');
  const [rows, setRows] = useState(null);
  const [counts, setCounts] = useState(null);
  const [err, setErr] = useState('');
  const [doing, setDoing] = useState(null);
  const [moving, setMoving] = useState(null);
  const [adding, setAdding] = useState(false);
  const loadCounts = () => api.get('/crm/tasks/counts', { params: { owner: owner || undefined } }).then((r) => setCounts(r.data.counts)).catch(() => setCounts(null));
  // `current()` says whether this answer is still the one wanted: a slow answer for a tab already left must never replace the newer list
  const fetchRows = (current = () => true) => api.get('/crm/tasks', { params: { when: tab, all: 1, from: from || undefined, to: to || undefined, owner: owner || undefined, priority: priority || undefined, type: type || undefined } })
    .then((r) => { if (current()) { setRows(r.data.tasks); setErr(''); } }).catch((e) => { if (current()) setErr(errOf(e, 'The follow-ups could not be read.')); });
  const load = () => fetchRows();
  useEffect(() => { loadCounts(); }, [owner, version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { let alive = true; setRows(null); fetchRows(() => alive); return () => { alive = false; }; }, [tab, from, to, owner, priority, type, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = () => { load(); loadCounts(); };
  async function cancel(t) {
    try { await api.post(`/crm/tasks/${t.id}/cancel`); toast('Cancelled.'); refresh(); } catch (e) { toast(errOf(e, 'This could not be cancelled.')); }
  }
  // Snooze: move to another day, keeping its time; it reminds again, and a managers' alert can fire again if it goes late again
  async function snooze(t, days) {
    const d = new Date(Date.parse(`${istToday()}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
    try { await api.post(`/crm/tasks/${t.id}/snooze`, { dueDate: d }); toast(`Moved to ${dateOf(d)}.`); refresh(); } catch (e) { toast(errOf(e, 'This could not be moved.')); }
  }
  const today = istToday();
  const canTick = me.canEdit && tab !== 'done';
  const cols = 7 + (canTick ? 1 : 0) + (me.seesAll ? 1 : 0);
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Follow-ups</h1><div className="page-sub">What needs doing: calls, meetings, visits and messages that are due today or late come first, with their reminders.</div></div>
        {me.canEdit && <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>+ Follow-up</button>}
      </div>
      <div className="tabs" role="tablist">
        {TABS.map(([k, l]) => {
          const n = k === 'action' ? (counts ? counts.needsAction : null) : (k === 'upcoming' && counts ? counts.upcoming : null);
          const late = k === 'action' && counts ? counts.overdue : 0;
          return (
            <div key={k} role="tab" tabIndex={0} aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)} onKeyDown={(e) => { if (e.key === 'Enter') setTab(k); }}>
              {l}{n != null && <span style={{ marginLeft: 6, padding: '0 7px', borderRadius: 10, fontSize: 11.5, fontWeight: 700, background: late > 0 ? 'var(--red)' : 'var(--line-soft, #e8ebf0)', color: late > 0 ? '#fff' : 'inherit' }}>{n}</span>}
              {late > 0 && <span style={{ marginLeft: 6, fontSize: 11.5, color: 'var(--red)', fontWeight: 600 }}>{late} late</span>}
            </div>
          );
        })}
      </div>
      <div className="filter-row">
        <DateField value={from} onChange={setFrom} aria-label="From" style={{ width: 150 }} />
        <DateField value={to} onChange={setTo} aria-label="To" style={{ width: 150 }} />
        <select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority"><option value="">Any priority</option>{me.lists.priorities.map((p) => <option key={p}>{p}</option>)}</select>
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type"><option value="">Any type</option>{me.lists.taskTypes.map((p) => <option key={p}>{p}</option>)}</select>
        {me.seesAll && <select value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Owner"><option value="">Everyone</option>{me.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
      </div>
      {err && <div className="notice" role="alert">{err}</div>}
      <div className="tbl-wrap">
        <table>
          <thead><tr>{canTick && <th style={{ width: 28 }} aria-label="Done" />}<th>Due</th><th>Priority</th><th>Type</th><th>Follow-up</th><th>For</th>{me.seesAll && <th>Owner</th>}<th>Reminder</th><th>{tab === 'done' ? 'What came of it' : ''}</th></tr></thead>
          <tbody>
            {rows == null && !err && <tr><td colSpan={cols + 1} className="small-muted">Loading…</td></tr>}
            {rows && !rows.length && <tr><td colSpan={cols + 1}><div className="empty"><h3>{tab === 'action' ? 'Nothing needs action' : 'Nothing here'}</h3>{tab === 'action' ? 'No follow-up is due today or late. Well done.' : 'No follow-ups in this view.'}</div></td></tr>}
            {(rows || []).map((t) => {
              const late = t.status === 'Open' && t.dueDate < today;
              return (
                <tr key={t.id} style={late ? { background: 'rgba(220, 38, 38, 0.06)' } : undefined}>
                  {canTick && <td><input type="checkbox" checked={false} onChange={() => setDoing(t)} aria-label={`Mark "${t.title}" done`} title="Done: say what came of it and set the next follow-up" style={{ width: 'auto' }} /></td>}
                  <td style={{ color: late ? 'var(--red)' : undefined, fontWeight: t.status === 'Open' && t.dueDate <= today ? 600 : undefined, whiteSpace: 'nowrap' }}>
                    {t.dueDate === today ? 'Today' : dateOf(t.dueDate)}{t.dueTime ? ` · ${t.dueTime}` : ''}
                    {late && <div style={{ fontSize: 11.5 }}>{daysLate(t.dueDate)} day{daysLate(t.dueDate) === 1 ? '' : 's'} late{t.escalatedAt ? ' · manager told' : ''}</div>}
                  </td>
                  <td><PriorityPill v={t.priority} /></td>
                  <td>{t.type || 'Call'}</td>
                  <td>{t.title}</td>
                  <td>{t.recordName ? <RecLink kind={t.recordKind} id={t.recordId}>{t.recordName}</RecLink> : '—'}</td>
                  {me.seesAll && <td>{t.ownerName || '—'}</td>}
                  <td className="small-muted" style={{ fontSize: 12 }}>
                    {t.notifyApp == null ? 'Daily list' : [REMIND_WORDS[t.remindBefore] || 'At the time', t.notifyWhatsapp ? 'WhatsApp' : '', t.notifySms ? 'SMS' : ''].filter(Boolean).join(' · ')}
                    {t.reminderSentAt ? <div>Sent</div> : null}
                    {t.reminderNote ? <div>{t.reminderNote}</div> : null}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {tab === 'done' ? <span className="small-muted">{[t.outcome, t.doneNote].filter(Boolean).join(' · ') || '—'}</span> : (me.canEdit && (
                      <span style={{ display: 'flex', gap: 6 }}>
                        <select value="" onChange={(e) => { const v = e.target.value; if (v === 'pick') setMoving(t); else if (v) snooze(t, Number(v)); }} aria-label={`Snooze or move "${t.title}"`} style={{ width: 'auto', padding: '2px 6px', fontSize: 12.5 }}>
                          <option value="">Snooze…</option><option value="1">Tomorrow</option><option value="3">In 3 days</option><option value="7">Next week</option><option value="pick">Pick a date…</option>
                        </select>
                        <button type="button" className="btn btn-sm" onClick={() => cancel(t)}>Cancel</button>
                      </span>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {doing && <DoneDialog task={doing} onClose={() => setDoing(null)} onDone={() => { setDoing(null); refresh(); if (changed) changed(); }} />}
      {moving && <RescheduleDialog task={moving} onClose={() => setMoving(null)} onDone={() => { setMoving(null); refresh(); }} />}
      {adding && <NewFollowUp onClose={() => setAdding(false)} onAdded={() => { setAdding(false); refresh(); }} />}
    </div>
  );
}
