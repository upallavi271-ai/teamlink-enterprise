// CRM > FOLLOW-UPS (founder 2026-11-06, upgraded 2026-11-14): Today, Overdue, Upcoming and Completed, each with a count (Overdue in red), and a date range,
// an owner, a priority and a type filter. A late follow-up is a red row that says how many days late it is, and whether the managers were told.
// Done asks what came of it (an outcome), what happened, and the next follow-up with its date, time, type and priority - the outcome and note go on the
// record's timeline. Follow-ups are added from a lead, a deal or an account (crmShared.jsx TaskList); the reminders are crm/sales.js runDue(), the
// overdue alert to the managers is crm/sales.js escalateOverdue().
import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { useCrm, errOf, dateOf, istToday, daysLate, RecLink, PriorityPill } from './crmShared.jsx';

const TABS = [['overdue', 'Overdue'], ['today', 'Today'], ['upcoming', 'Upcoming'], ['done', 'Completed']];
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
        <div className="field"><label>Date</label><input type="date" min={istToday()} value={next} onChange={(e) => setNext(e.target.value)} /></div>
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

export default function CrmFollowups() {
  const { me, toast, version } = useCrm();
  const [tab, setTab] = useState('today');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [owner, setOwner] = useState('');
  const [priority, setPriority] = useState('');
  const [type, setType] = useState('');
  const [rows, setRows] = useState(null);
  const [counts, setCounts] = useState(null);
  const [err, setErr] = useState('');
  const [doing, setDoing] = useState(null);
  const loadCounts = () => api.get('/crm/tasks/counts', { params: { owner: owner || undefined } }).then((r) => setCounts(r.data.counts)).catch(() => setCounts(null));
  // `current()` says whether this answer is still the one wanted: a slow answer for a tab already left (the page opens on Today, then jumps to Overdue)
  // must never replace the newer list
  const fetchRows = (current = () => true) => api.get('/crm/tasks', { params: { when: tab, all: 1, from: from || undefined, to: to || undefined, owner: owner || undefined, priority: priority || undefined, type: type || undefined } })
    .then((r) => { if (current()) { setRows(r.data.tasks); setErr(''); } }).catch((e) => { if (current()) setErr(errOf(e, 'The follow-ups could not be read.')); });
  const load = () => fetchRows();
  // open on Overdue when there is something late, so it is never missed: decided once, from the first counts
  const [picked, setPicked] = useState(false);
  useEffect(() => { loadCounts(); }, [owner, version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!picked && counts) { setPicked(true); if (counts.overdue > 0) setTab('overdue'); } }, [counts, picked]);
  useEffect(() => { let alive = true; setRows(null); fetchRows(() => alive); return () => { alive = false; }; }, [tab, from, to, owner, priority, type, version]); // eslint-disable-line react-hooks/exhaustive-deps
  async function cancel(t) {
    try { await api.post(`/crm/tasks/${t.id}/cancel`); toast('Cancelled.'); load(); loadCounts(); } catch (e) { toast(errOf(e, 'This could not be cancelled.')); }
  }
  // Snooze: move to another day, keeping its time; it reminds again, and a managers' alert can fire again if it goes late again
  async function snooze(t, days) {
    const d = new Date(Date.parse(`${istToday()}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
    try { await api.post(`/crm/tasks/${t.id}/snooze`, { dueDate: d }); toast(`Moved to ${dateOf(d)}.`); load(); loadCounts(); } catch (e) { toast(errOf(e, 'This could not be moved.')); }
  }
  const today = istToday();
  const countOf = (k) => (counts && counts[k] != null ? counts[k] : null);
  return (
    <div className="page">
      <div className="page-head"><div><h1>Follow-ups</h1><div className="page-sub">Calls, meetings, visits and messages due, with their reminders. Add one from a lead, a deal or an account.</div></div></div>
      {counts && counts.overdue > 0 && tab !== 'overdue' && (
        <div className="notice" role="button" tabIndex={0} onClick={() => setTab('overdue')} onKeyDown={(e) => { if (e.key === 'Enter') setTab('overdue'); }} style={{ cursor: 'pointer', borderColor: 'var(--red)', color: 'var(--red)' }}>
          <b>{counts.overdue} follow-up{counts.overdue === 1 ? ' is' : 's are'} overdue.</b> Click to see {counts.overdue === 1 ? 'it' : 'them'}.
        </div>
      )}
      <div className="tabs" role="tablist">
        {TABS.map(([k, l]) => {
          const n = k === 'done' ? null : countOf(k);
          return (
            <div key={k} role="tab" tabIndex={0} aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)} onKeyDown={(e) => { if (e.key === 'Enter') setTab(k); }}>
              {l}{n != null && <span style={{ marginLeft: 6, padding: '0 7px', borderRadius: 10, fontSize: 11.5, fontWeight: 700, background: k === 'overdue' && n > 0 ? 'var(--red)' : 'var(--line-soft, #e8ebf0)', color: k === 'overdue' && n > 0 ? '#fff' : 'inherit' }}>{n}</span>}
            </div>
          );
        })}
      </div>
      <div className="filter-row">
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" style={{ width: 150 }} />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" style={{ width: 150 }} />
        <select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority"><option value="">Any priority</option>{me.lists.priorities.map((p) => <option key={p}>{p}</option>)}</select>
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type"><option value="">Any type</option>{me.lists.taskTypes.map((p) => <option key={p}>{p}</option>)}</select>
        {me.seesAll && <select value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Owner"><option value="">Everyone</option>{me.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
      </div>
      {err && <div className="notice" role="alert">{err}</div>}
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Due</th><th>Priority</th><th>Type</th><th>Follow-up</th><th>For</th>{me.seesAll && <th>Owner</th>}<th>Reminder</th><th>{tab === 'done' ? 'What came of it' : ''}</th></tr></thead>
          <tbody>
            {rows == null && !err && <tr><td colSpan={8} className="small-muted">Loading…</td></tr>}
            {rows && !rows.length && <tr><td colSpan={8}><div className="empty"><h3>Nothing here</h3>{tab === 'overdue' ? 'Nothing is overdue. Well done.' : 'No follow-ups in this view.'}</div></td></tr>}
            {(rows || []).map((t) => {
              const late = t.status === 'Open' && t.dueDate < today;
              return (
                <tr key={t.id} style={late ? { background: 'rgba(220, 38, 38, 0.06)' } : undefined}>
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
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => setDoing(t)}>Done</button>
                        <select value="" onChange={(e) => { if (e.target.value) snooze(t, Number(e.target.value)); }} aria-label={`Snooze "${t.title}"`} style={{ width: 'auto', padding: '2px 6px', fontSize: 12.5 }}>
                          <option value="">Snooze…</option><option value="1">Tomorrow</option><option value="3">In 3 days</option><option value="7">Next week</option>
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
      {doing && <DoneDialog task={doing} onClose={() => setDoing(null)} onDone={() => { setDoing(null); load(); loadCounts(); }} />}
    </div>
  );
}
