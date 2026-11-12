import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Combo from '../../components/Combo.jsx';
import { AiAssist } from '../../components/ComposeForm.jsx';

// ---------------------------------------------------------------------------
// Timesheet > Checklist (founder 2026-11-03). Each person writes what they did: the day (today by default), from / to time,
// status (Completed, Pending, In Progress) and a description, then Save. They see their own list; a TL also sees their whole team,
// one block per person, written or not (founder 2026-11-05: "tls ki valla andharu employee checklist kanipinchali and every day
// filters petukuntey"); the Super Admin sees everyone, department by department. Only the writer can change or remove a row.
// Backend: routes/timesheetChecklist.js.
// ---------------------------------------------------------------------------
const TONE = { Completed: 'active', Pending: 'pending', 'In Progress': 'info' };
const EMPTY = { fromTime: '', toTime: '', status: 'In Progress', description: '' };

// The days the buttons above the filters stand for, in India time.
const dayOf = (d) => d.toISOString().slice(0, 10);
function quickDays(today) {
  const t = new Date(`${today}T00:00:00Z`);
  const back = (n) => dayOf(new Date(t.getTime() - n * 86400000));
  return [
    { key: 'today', label: 'Today', from: today, to: '' },
    { key: 'yesterday', label: 'Yesterday', from: back(1), to: '' },
    { key: 'week', label: 'Last 7 days', from: back(6), to: today },
    { key: 'month', label: 'This month', from: `${today.slice(0, 8)}01`, to: today },
  ];
}

// A plain hours:minutes box - 24-hour, no seconds and no AM/PM (founder 2026-11-12: "sec avasaramledhu, hours and minutes chaluu").
// Type the four digits (e.g. 0910) and it becomes 09:10; it saves the same "HH:MM" string the time picker did.
function TimeHM({ value, onChange, ariaLabel }) {
  const onInput = (e) => { const d = e.target.value.replace(/\D/g, '').slice(0, 4); onChange(d.length >= 3 ? `${d.slice(0, 2)}:${d.slice(2)}` : d); };
  const onBlur = (e) => {
    const d = e.target.value.replace(/\D/g, '');
    if (!d) { onChange(''); return; }
    const h = Math.min(23, parseInt(d.slice(0, 2) || '0', 10));
    const m = Math.min(59, parseInt((d.slice(2, 4) || '0').padEnd(2, '0'), 10));
    onChange(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  };
  return <input type="text" inputMode="numeric" placeholder="HH:MM" maxLength={5} value={value || ''} aria-label={ariaLabel} onChange={onInput} onBlur={onBlur} />;
}

function EntryForm({ statuses, initial, date, onSaved, onCancel }) {
  const [f, setF] = useState(initial || EMPTY);
  const [day, setDay] = useState(initial?.date || date);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  async function save() {
    setErr(''); setBusy(true);
    try {
      const body = { date: day, fromTime: f.fromTime, toTime: f.toTime, status: f.status, description: f.description };
      if (initial?.id) await api.put(`/timesheet-checklist/${initial.id}`, body); else await api.post('/timesheet-checklist', body);
      if (!initial?.id) setF(EMPTY);
      onSaved(initial?.id ? 'Saved.' : 'Added to your checklist.');
    } catch (e) { setErr(e.response?.data?.error || 'Could not save.'); } finally { setBusy(false); }
  }
  return (
    <div className="tcl-form">
      <label>Date<input type="date" value={day} max={new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10)} onChange={(e) => setDay(e.target.value)} /></label>
      <label>From<TimeHM value={f.fromTime} onChange={(v) => setF((x) => ({ ...x, fromTime: v }))} ariaLabel="From time, hours and minutes" /></label>
      <label>To<TimeHM value={f.toTime} onChange={(v) => setF((x) => ({ ...x, toTime: v }))} ariaLabel="To time, hours and minutes" /></label>
      <label>Status
        <select value={f.status} onChange={set('status')}>{statuses.map((s) => <option key={s} value={s}>{s}</option>)}</select>
      </label>
      <label className="tcl-desc">What did you do?<textarea rows={4} value={f.description} onChange={set('description')} placeholder="For example: called 20 candidates for the Staff Nurse requirement" /></label>
      {/* the same AI Assist as Timesheet (founder 2026-11-04): fixes the words of the description; nothing is saved until Save */}
      <AiAssist kind="checklist" title={`Work done${f.fromTime && f.toTime ? ` ${f.fromTime} to ${f.toTime}` : ''} (${f.status})`} text={f.description} onText={(t) => setF((x) => ({ ...x, description: t }))} />
      <div className="tcl-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving...' : 'Save'}</button>
        {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
      </div>
      {err && <div className="error-text">{err}</div>}
    </div>
  );
}

function Rows({ rows, showWho, showDate, statuses, onChanged, setError }) {
  const [editing, setEditing] = useState(null);
  async function remove(r) {
    if (!window.confirm(`Remove this checklist entry (${r.fromTime} to ${r.toTime})?`)) return;
    try { await api.delete(`/timesheet-checklist/${r.id}`); onChanged('Removed.'); } catch (e) { setError(e.response?.data?.error || 'Could not remove.'); }
  }
  if (!rows.length) return <div className="small-muted" style={{ padding: '8px 0' }}>Nothing written for this day yet.</div>;
  return (
    <table className="table tcl-table">
      <thead><tr>{showWho && <th>Employee</th>}{showDate && <th>Day</th>}<th>From</th><th>To</th><th>Status</th><th>What was done</th><th /></tr></thead>
      <tbody>
        {rows.map((r) => (editing === r.id ? (
          <tr key={r.id}><td colSpan={(showWho ? 6 : 5) + (showDate ? 1 : 0)}>
            <EntryForm statuses={statuses} initial={r} date={r.date} onCancel={() => setEditing(null)} onSaved={(m) => { setEditing(null); onChanged(m); }} />
          </td></tr>
        ) : (
          <tr key={r.id}>
            {showWho && <td><b>{r.name}</b><div className="small-muted">{r.employeeCode}{r.team ? ` · ${r.team}` : ''}</div></td>}
            {showDate && <td style={{ whiteSpace: 'nowrap' }}>{r.date}</td>}
            <td>{r.fromTime}</td>
            <td>{r.toTime}</td>
            <td><span className={`status ${TONE[r.status] || ''}`}>{r.status}</span></td>
            <td style={{ whiteSpace: 'pre-wrap' }}>{r.description}</td>
            <td style={{ whiteSpace: 'nowrap' }}>
              {r.mine && <><button type="button" className="btn btn-sm" onClick={() => setEditing(r.id)}>Edit</button>{' '}
                <button type="button" className="btn btn-sm" onClick={() => remove(r)}>Remove</button></>}
            </td>
          </tr>
        )))}
      </tbody>
    </table>
  );
}

// A TL's whole team for the days picked: who wrote and who has not, then each person's rows.
function TeamList({ roster, rows, range, statuses, narrowed, onChanged, setError }) {
  const [show, setShow] = useState('all'); // 'all' | 'wrote' | 'not'
  const wrote = roster.filter((p) => p.entries > 0);
  const notYet = roster.filter((p) => !p.entries);
  const byPerson = new Map();
  rows.forEach((r) => { if (!byPerson.has(r.userId)) byPerson.set(r.userId, []); byPerson.get(r.userId).push(r); });
  // a status or words filter shows only the people it finds
  const base = narrowed ? roster.filter((p) => byPerson.has(p.userId)) : roster;
  const list = show === 'wrote' ? base.filter((p) => p.entries > 0) : show === 'not' ? base.filter((p) => !p.entries) : base;
  if (!roster.length) return <div className="small-muted">Nobody is in your team yet.</div>;
  return (
    <>
      <div className="tcl-views">
        <button type="button" className={`tt-view${show === 'all' ? ' on' : ''}`} onClick={() => setShow('all')}>Everyone <b>{roster.length}</b></button>
        <button type="button" className={`tt-view${show === 'wrote' ? ' on' : ''}`} onClick={() => setShow('wrote')}>Written <b>{wrote.length}</b></button>
        <button type="button" className={`tt-view${show === 'not' ? ' on' : ''}`} onClick={() => setShow('not')}>Not written <b>{notYet.length}</b></button>
      </div>
      {!list.length && <div className="small-muted">Nobody here for these filters.</div>}
      {list.map((p) => (
        <div key={p.userId} className="tcl-person">
          <div className="tcl-person-head">
            <div><b>{p.name}</b> <span className="small-muted">{[p.employeeCode, p.designation, p.team].filter(Boolean).join(' · ')}</span></div>
            {p.entries
              ? <div className="tcl-counts">
                  {range && <span className="small-muted">{p.days} {p.days === 1 ? 'day' : 'days'}</span>}
                  {p.completed > 0 && <span className="status active">{p.completed} Completed</span>}
                  {p.inProgress > 0 && <span className="status info">{p.inProgress} In Progress</span>}
                  {p.pending > 0 && <span className="status pending">{p.pending} Pending</span>}
                </div>
              : <span className="status rejected">Not written</span>}
          </div>
          {byPerson.has(p.userId) && <Rows rows={byPerson.get(p.userId)} showWho={false} showDate={range} statuses={statuses} onChanged={onChanged} setError={setError} />}
        </div>
      ))}
    </>
  );
}

export default function TimesheetChecklist() {
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [department, setDepartment] = useState('');
  const [userId, setUserId] = useState('');
  const [to, setTo] = useState(''); // empty = the one day picked
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [qSent, setQSent] = useState('');
  useEffect(() => { const t = setTimeout(() => setQSent(q.trim()), 350); return () => clearTimeout(t); }, [q]);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    api.get('/timesheet-checklist', { params: { date, to: to || undefined, status: status || undefined, q: qSent || undefined, department: department || undefined, userId: userId || undefined } })
      .then((res) => { setData(res.data); setError(''); })
      .catch((e) => setError(e.response?.data?.error || 'Could not load the checklist.'));
  }, [date, to, status, qSent, department, userId]);
  useEffect(() => { load(); }, [load]);

  if (!data) return <div className="small-muted">{error || 'Loading...'}</div>;
  const others = data.scope !== 'self';
  const range = !!data.to && data.to !== data.date; // more than one day shown: a Day column
  const mineRows = data.rows.filter((r) => r.mine);
  const teamRows = data.rows.filter((r) => !r.mine);
  const people = data.people.filter((p) => !department || p.department === department);
  // A team that spans departments (somebody on the reporting line from another one) can be cut by department too.
  const teamDepts = [...new Set(data.people.map((p) => p.department))].sort();
  const showDept = data.scope === 'all' || (others && teamDepts.length > 1);
  const deptChoices = data.scope === 'all' ? data.departments : teamDepts.map((d) => ({ department: d, count: data.people.filter((p) => p.department === d).length }));
  const quick = quickDays(data.today);
  const pickDays = (x) => { setDate(x.from); setTo(x.to); };
  const quickOn = quick.find((x) => x.from === date && (x.to || '') === to);
  const changed = (m) => { setNotice(m); load(); };
  // The Super Admin's list: department by department.
  const groups = [...new Set(teamRows.map((r) => r.department))].sort().map((d) => ({ d, rows: teamRows.filter((r) => r.department === d) }));

  return (
    <div className="tcl">
      {error && <div className="error-text">{error}</div>}
      {notice && <div className="tt-notice-ok" role="status">{notice}</div>}

      {/* one click for the usual days (founder 2026-11-05: "every day filters"); From / To below for any other days */}
      <div className="tcl-views">
        {quick.map((x) => <button key={x.key} type="button" className={`tt-view${quickOn?.key === x.key ? ' on' : ''}`} onClick={() => pickDays(x)}>{x.label}</button>)}
      </div>

      {/* FILTERS ON TOP (founder 2026-11-04): days From - To, status, words, and (for leads) department / employee */}
      <div className="tcl-bar">
        <label>From<input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value || today)} /></label>
        <label>To<input type="date" value={to} min={date} max={today} onChange={(e) => setTo(e.target.value || '')} /></label>
        <label>Status
          <Combo value={status} onChange={(e) => setStatus(e.target.value || '')}>
            <option value="">Any status</option>
            {(data.statuses || []).map((s) => <option key={s} value={s}>{s}</option>)}
          </Combo>
        </label>
        <label>Search<input type="search" value={q} placeholder="Words in what was done, or a name" onChange={(e) => setQ(e.target.value)} /></label>
        {(to || status || q || department || userId) && <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-end' }} onClick={() => { setTo(''); setStatus(''); setQ(''); setDepartment(''); setUserId(''); setDate(today); }}>Clear filters</button>}
        {showDept && (
          <label>Department
            <Combo value={department} onChange={(e) => { setDepartment(e.target.value || ''); setUserId(''); }}>
              <option value="">All departments</option>
              {deptChoices.map((d) => <option key={d.department} value={d.department}>{`${d.department} (${d.count})`}</option>)}
            </Combo>
          </label>
        )}
        {others && (
          <label>Employee
            <Combo value={userId} onChange={(e) => setUserId(e.target.value || '')} departments={false}>
              <option value="">{data.scope === 'all' ? 'Everyone' : 'My whole team'}</option>
              {people.map((p) => <option key={p.userId} value={p.userId}>{`${p.name} · ${p.employeeCode}`}</option>)}
            </Combo>
          </label>
        )}
      </div>

      {data.canWrite && (
        <div className="panel" style={{ marginBottom: 14 }}>
          <div className="panel-head"><h3>My checklist{range ? ` · ${date} to ${data.to}` : (date === data.today ? ' today' : ` · ${date}`)}</h3></div>
          <div className="panel-pad">
            <EntryForm statuses={data.statuses} date={date} onSaved={changed} />
            <Rows rows={mineRows} showWho={false} showDate={range} statuses={data.statuses} onChanged={changed} setError={setError} />
          </div>
        </div>
      )}

      {others && (
        <div className="panel">
          <div className="panel-head"><h3>{data.scope === 'all' ? 'Everyone, department-wise' : 'My team'} <span className="small-muted">{data.scope === 'all' ? `(${teamRows.length})` : `· ${range ? `${date} to ${data.to}` : (date === data.today ? 'today' : date)}`}</span></h3></div>
          <div className="panel-pad">
            {data.scope === 'all'
              ? (groups.length ? groups.map((g) => (
                <div key={g.d} className="tcl-group">
                  <div className="tcl-group-head">{g.d} <span className="small-muted">({g.rows.length})</span></div>
                  <Rows rows={g.rows} showWho showDate={range} statuses={data.statuses} onChanged={changed} setError={setError} />
                </div>
              )) : <div className="small-muted">Nobody has written a checklist for this day yet.</div>)
              : <TeamList roster={data.roster || []} rows={teamRows} range={range} statuses={data.statuses} narrowed={!!(status || qSent)} onChanged={changed} setError={setError} />}
          </div>
        </div>
      )}
    </div>
  );
}
