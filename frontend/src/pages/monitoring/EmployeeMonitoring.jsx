import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api';
import ListPageHeader from '../../components/ui/ListPageHeader.jsx';
import ExportMenu from '../../components/ExportMenu.jsx';
import Combo from '../../components/Combo.jsx';
import {
  KpiRow, KpiTile, Panel, BarList, Pill,
} from '../../components/atskit/AtsKit.jsx';
import './monitoring.css';

// ---------------------------------------------------------------------------
// HRMS -> EMPLOYEE MONITORING (2026-11-04). How office PCs are used in work hours, from the TeamLink desktop agent the
// employee installs and agrees to (backend: routes/monitoring.js, utils/monitoring.js; the agent: backend/agent/TeamLinkMonitor.ps1).
//   HR / Admin  Live Dashboard · Reports · App usage · Alerts · Attendance · Productivity rules · Devices · Audit log · Settings · My activity
//   TL / STL / Manager  Live Dashboard · Reports · App usage · Alerts (their own team) · Productivity rules (to read) · My activity
//   IT Admin    Devices · Agent settings · My activity: PCs and agents, nobody's activity
//   everyone    My activity: their own day, their PCs and the notice they accepted
// Only the app name, window title and active / idle time are recorded - never keystrokes, passwords, the clipboard,
// screenshots or chat content - and only after the employee accepts the notice.
// ---------------------------------------------------------------------------
const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const tm = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }) : '—');
const dt = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) : '—');
// under an hour reads in minutes: "0.0 h" said nothing about 2 minutes of work
const h = (v) => { if (v == null) return '—'; const n = Number(v); if (!n) return '0 h'; return n < 1 ? `${Math.max(1, Math.round(n * 60))} min` : `${n.toFixed(1)} h`; };
const dur = (sec) => (sec < 60 ? `${sec} sec` : sec < 3600 ? `${Math.round(sec / 60)} min` : `${(sec / 3600).toFixed(1)} h`);
// 8.25 -> "8 h 15 min", 0.4 -> "24 min" (the work day line: "4 h active out of 8 h 15 min")
const hmins = (mins) => { const m = Math.max(0, Math.round(Number(mins) || 0)); if (!m) return '0 min'; const a = Math.floor(m / 60); const b = m % 60; return a ? `${a} h${b ? ` ${b} min` : ''}` : `${b} min`; };
const hm = (v) => { const m = Math.round(Number(v || 0) * 60); if (!m) return '0 min'; const a = Math.floor(m / 60); const b = m % 60; return a ? `${a} h${b ? ` ${b} min` : ''}` : `${b} min`; };
const clock = (x) => { if (!x) return ''; const [a, b] = String(x).split(':').map(Number); return `${a % 12 || 12}${b ? `:${String(b).padStart(2, '0')}` : ''} ${a < 12 ? 'am' : 'pm'}`; };
// One bar for the whole day from start to end of work: active, idle, break, away from the PC, and what is still to come.
function DayBar({ r }) {
  const day = Number(r.dayHours) || 0;
  if (!day) return null;
  const parts = [['active', r.activeHours], ['idle', r.idleHours], ['break', r.breakHours], ['away', r.awayHours], ['rest', Math.max(0, day - (Number(r.elapsedHours) || 0))]];
  const tip = `Active ${hm(r.activeHours)} · Idle ${hm(r.idleHours)} · Break ${hm(r.breakHours)} · Not on the PC ${hm(r.awayHours)}`;
  return <div className="mon-day" title={tip}>{parts.map(([k, v]) => (Number(v) > 0 ? <i key={k} className={k} style={{ width: `${Math.min(100, (Number(v) / day) * 100)}%` }} /> : null))}</div>;
}
const pct = (v) => (v == null ? '—' : `${v}%`);
const CAT_TONE = { productive: 'green', neutral: 'slate', unproductive: 'red' };
const CAT_WORD = { productive: 'Productive', neutral: 'Neutral', unproductive: 'Unproductive' };
const STATUS_TONE = { Online: 'green', Idle: 'amber', 'On break': 'teal', 'Clocked out': 'slate', Stopped: 'red', 'On leave': 'violet', Offline: 'slate', 'Laptop closed': 'blue', 'Old agent': 'red' };
const STATUS_TIP = { 'Laptop closed': 'The laptop was closed (asleep). It shows Online again the moment it is opened.', 'Old agent': 'This PC runs an agent older than 2.1, which does not come back after sleep. Restart the PC once: it then updates itself.' };

function useGet(url, params, deps = []) {
  const [st, setSt] = useState({ data: null, error: '', loading: true });
  const load = useCallback(() => {
    if (!url) return;
    setSt((s) => ({ ...s, loading: true, error: '' }));
    api.get(url, params ? { params } : undefined)
      .then((r) => setSt({ data: r.data, error: '', loading: false }))
      .catch((e) => setSt({ data: null, error: errOf(e, 'Could not load this.'), loading: false }));
  }, [url, JSON.stringify(params || {})]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [load, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...st, reload: load };
}

export default function EmployeeMonitoring() {
  const [params, setParams] = useSearchParams();
  const me = useGet('/monitoring/me');
  const admin = !!(me.data && me.data.isAdmin);
  const lead = !!(me.data && me.data.isLead);
  const it = !!(me.data && me.data.isIt);
  const tabs = admin
    ? [['overview', 'Live Dashboard'], ['keyboard', 'Keyboard'], ['reports', 'Reports'], ['usage', 'App usage'], ['alerts', 'Alerts'], ['misuse', 'Misuse'], ['attendance', 'Attendance'], ['tasks', 'Tasks vs work'], ['categories', 'Productivity rules'], ['devices', 'Devices'], ['agentver', 'Agent versions'], ['audit', 'Audit log'], ['datasec', 'Data security'], ['settings', 'Settings'], ['mine', 'My activity']]
    : lead ? [['overview', 'Live Dashboard'], ['keyboard', 'Keyboard'], ['reports', 'Reports'], ['usage', 'App usage'], ['alerts', 'Alerts'], ['misuse', 'Misuse'], ['tasks', 'Tasks vs work'], ['categories', 'Productivity rules'], ['mine', 'My activity']]
      : it ? [['devices', 'Devices'], ['agentver', 'Agent versions'], ['settings', 'Agent settings'], ['mine', 'My activity']] : [['mine', 'My activity']];
  const tab = tabs.some(([k]) => k === params.get('tab')) ? params.get('tab') : tabs[0][0];
  const employee = params.get('employee');
  const go = (t, extra = {}) => setParams({ tab: t, ...extra });

  if (me.loading && !me.data) return <div className="small-muted">Loading…</div>;
  if (me.error) return <div className="notice red">{me.error}</div>;
  return (
    <div className="mon">
      <ListPageHeader
        title="Employee Monitoring"
        question={admin || lead || it
          ? 'How office PCs are used in work hours: active time, idle time and the apps used. Only what employees agreed to is recorded.'
          : 'What TeamLink records on your office PC in work hours, and the notice you accepted.'}
      />
      {tabs.length > 1 && (
        <div className="tabs" style={{ marginBottom: 14 }}>
          {tabs.map(([k, label]) => <div key={k} className={`tab${tab === k && !employee ? ' active' : ''}`} onClick={() => go(k)}>{label}</div>)}
        </div>
      )}
      {(admin || lead) && !employee && <MisuseBanner onGo={() => go('misuse')} />}
      {employee && (admin || lead)
        ? <EmployeeDetail id={employee} onBack={() => go(tab)} />
        : (
          <>
            {tab === 'overview' && <Overview onOpen={(id) => go('overview', { employee: id })} />}
            {tab === 'keyboard' && <Keyboard onOpen={(id) => go('keyboard', { employee: id })} />}
            {tab === 'categories' && <Categories />}
            {tab === 'reports' && <Reports admin={admin} onOpen={(id) => go('reports', { employee: id })} />}
            {tab === 'attendance' && <AttendanceTab />}
            {tab === 'tasks' && <TasksVsWork onOpen={(id) => go('tasks', { employee: id })} />}
            {tab === 'usage' && <Usage />}
            {tab === 'audit' && <Audit />}
            {tab === 'datasec' && <DataSecurity />}
            {tab === 'alerts' && <Alerts onOpen={(id) => go('alerts', { employee: id })} />}
            {tab === 'misuse' && <Misuse onOpen={(id) => go('misuse', { employee: id })} />}
            {tab === 'devices' && <Devices manage />}
            {tab === 'agentver' && <AgentVersions />}
            {tab === 'settings' && <Settings />}
            {tab === 'mine' && <Mine me={me} />}
          </>
        )}
    </div>
  );
}

// Which website, out of a browser's window title: "Some video - YouTube - Google Chrome" -> YouTube, "Some video"
// (founder 2026-11-05: "just chrome antey telidhu kadha").
const BROWSER_APPS = ['chrome', 'msedge', 'firefox', 'opera', 'brave', 'iexplore', 'vivaldi', 'safari'];
function siteOf(app, title) {
  if (!title || !BROWSER_APPS.includes(String(app || '').toLowerCase())) return { site: null, page: title || null };
  // an incognito / InPrivate / private window is still tracked (founder 2026-11-13): drop the marker so the real site shows, and flag it
  const incog = /(incognito|inprivate|private[ -]?browsing)/i.test(title);
  const cleaned = String(title).replace(/[([{|-]\s*(incognito|inprivate|private[ -]?browsing)\s*[)\]}]?/ig, ' ');
  const parts = cleaned.replace(/\s+[-–|]\s+(Google Chrome|Microsoft.*Edge|Mozilla Firefox|Brave|Opera|Vivaldi)$/i, '').split(/\s+[-–|]\s+/).filter(Boolean);
  let site = parts.pop() || null;
  if (site) site = site.replace(/^[\s–—|-]+/, '').trim() || null;
  if (incog) site = site ? `${site} (incognito)` : 'Incognito page';
  return { site, page: parts.join(' - ') || null };
}

// which time column to highlight for a chosen status, and the one line that says what is shown
const HI_OF = { Online: 'active', Idle: 'idle', 'On break': 'break', Offline: 'away' };
const HI_WORD = { Online: 'Active people and how long each has been working.', Idle: 'Idle people and how long each has been idle.', 'On break': 'People on a break and how long each has been on it.', Offline: 'People off the PC and how long the PC has had no signal.' };
// ------------------------------------------------------------------------------------------------ Misuse (the same button over and over)
// Every continuous single-button stretch - a key held / tapped again and again, an auto-clicker, a mouse mover or input from a program
// - across the people the viewer may see, with a remark the admin / team lead can add (founder 2026-11-12: "ilaanti unwanted misuse
// chesnavi anni, oka tab lo remark or else edhaina oka name tho ... and at the same time popup avvali"). The employee sees a popup on
// their own screen while it happens (agent 3.0). A red banner above every tab says how many there are today. Nothing typed is kept.
const MISUSE_WORD = { key: 'Key held / tapped', click: 'Auto-clicker', mouse: 'Mouse only (fake?)', software: 'Program input' };
const MISUSE_TONE = { key: 'red', click: 'red', mouse: 'amber', software: 'violet' };
function MisuseBanner({ onGo }) {
  const { data } = useGet('/monitoring/misuse', { from: todayIst(), to: todayIst(), min: 2 });
  const n = (data && data.events && data.events.length) || 0;
  if (!n) return null;
  return (
    <div className="mon-misuse-banner" role="button" tabIndex={0} onClick={onGo} onKeyDown={(e) => { if (e.key === 'Enter') onGo(); }}>
      <span className="dot" />
      <span><b>{`${n} misuse alert${n === 1 ? '' : 's'} today`}</b> - someone kept pressing one button (a key held down, an auto-clicker or a mouse mover). The employee was warned on their screen. Click to see who and add a remark.</span>
    </div>
  );
}
function NoteCell({ e, onSave }) {
  const [val, setVal] = useState(e.note || '');
  const [saved, setSaved] = useState(false);
  useEffect(() => { setVal(e.note || ''); }, [e.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = () => { if (val.trim() !== (e.note || '')) { onSave(e, val.trim()); setSaved(true); setTimeout(() => setSaved(false), 1600); } };
  return (
    <div className="mon-note" onClick={(ev) => ev.stopPropagation()}>
      <input type="text" value={val} placeholder="Add a remark / name…" maxLength={400} onChange={(ev) => setVal(ev.target.value)} onBlur={commit} onKeyDown={(ev) => { if (ev.key === 'Enter') ev.target.blur(); }} />
      {saved ? <span className="small-muted ok"> saved</span> : (e.noteBy && <div className="small-muted">{e.noteBy}</div>)}
    </div>
  );
}
function Misuse({ onOpen }) {
  const [from, setFrom] = useState(todayIst());
  const [to, setTo] = useState(todayIst());
  const [min, setMin] = useState(2);
  const [dept, setDept] = useState('');
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const { data, error, loading } = useGet('/monitoring/misuse', { from, to, min });
  const events = (data && data.events) || [];
  const range = from !== to;
  const depts = useMemo(() => [...new Set(events.map((x) => x.department).filter(Boolean))].sort(), [events]);
  const rows = events.filter((x) => (!dept || x.department === dept) && (!kind || x.kind === kind)
    && (!q.trim() || `${x.name} ${x.code || ''} ${x.label} ${x.place || ''} ${x.note || ''}`.toLowerCase().includes(q.trim().toLowerCase())));
  const saveNote = async (e, value) => {
    try { await api.post('/monitoring/misuse/note', { employeeId: e.employeeId, day: e.day, from: e.from, note: value }); e.note = value; } catch (_) { /* a transient save error: the next load shows the truth */ }
  };
  return (
    <>
      <div className="small-muted">The same key or button pressed again and again - a key held down, an auto-clicker, a mouse mover, or input sent by a program - which looks like fake activity. The employee gets a popup on their own screen while it is happening. Open a person for the full day, or give each one a remark or a name. Nothing typed is ever recorded.</div>
      <div className="mon-bar">
        <label>From <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value || todayIst())} /></label>
        <label>To <input type="date" value={to} max={todayIst()} min={from} onChange={(e) => setTo(e.target.value || todayIst())} /></label>
        <Combo value={min} onChange={(e) => setMin(Number(e.target.value))} aria-label="Least minutes">
          <option value={1}>1 min or more</option>
          <option value={2}>2 min or more</option>
          <option value={5}>5 min or more</option>
          <option value={10}>10 min or more</option>
        </Combo>
        <Combo value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department">
          <option value="">All departments</option>
          {depts.map((d) => <option key={d} value={d}>{d}</option>)}
        </Combo>
        <Combo value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
          <option value="">All kinds</option>
          {Object.entries(MISUSE_WORD).map(([k, w]) => <option key={k} value={k}>{w}</option>)}
        </Combo>
        <input type="search" placeholder="Search a name, key or remark" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <div className="notice red">{error}</div>}
      <table className="mon-table">
        <thead><tr><th>Employee</th><th>What happened</th><th>Where (app / website)</th><th>When</th><th className="num">How long</th><th className="num">Times</th><th>Remark / name</th></tr></thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id}>
              <td className="row-link" onClick={() => onOpen(e.employeeId)} title="Open this person's day"><b>{e.name}</b>{e.code && <div className="small-muted">{e.code}</div>}{e.department && <div className="small-muted">{e.department}</div>}</td>
              <td><Pill tone={MISUSE_TONE[e.kind] || 'slate'}>{MISUSE_WORD[e.kind] || e.kind}</Pill><div className="small-muted">{e.label}</div></td>
              <td>{e.place ? <><b>{e.place}</b>{e.placeKind === 'site' && <span className="small-muted"> · website</span>}</> : <span className="small-muted">Not recorded</span>}</td>
              <td style={{ whiteSpace: 'nowrap' }}>{range && <div className="small-muted">{e.day}</div>}{`${e.fromTime} – ${e.toTime}`}</td>
              <td className="num"><b>{`${e.minutes} min`}</b></td>
              <td className="num">{Number(e.presses || 0).toLocaleString('en-IN')}</td>
              <td><NoteCell e={e} onSave={saveNote} /></td>
            </tr>
          ))}
          {!rows.length && !loading && <tr><td colSpan={7} className="small-muted">{events.length ? 'None match these filters.' : 'No continuous single-button use in this period. PCs record this once they are on agent 3.0 or later.'}</td></tr>}
        </tbody>
      </table>
      {events.length > 0 && <div className="small-muted" style={{ marginTop: 8 }}>{`${rows.length} of ${events.length} shown · ${data.people} ${data.people === 1 ? 'person' : 'people'}.`}</div>}
    </>
  );
}

// ------------------------------------------------------------------------------------------------ Keyboard (Keys . Clicks, its own tab)

// How much each person used the keyboard and mouse - key presses and clicks in work hours - from the same per-person figures the Live
// Dashboard had in its Keys . Clicks column (founder 2026-11-12: "keep this in a separate tab"). A click opens the person for each key.
function Keyboard({ onOpen }) {
  const [date, setDate] = useState(todayIst());
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const [team, setTeam] = useState('');
  const { data, error, loading } = useGet('/monitoring/overview', { date });
  const rows = useMemo(() => ((data && data.rows) || [])
    .filter((r) => (!dept || r.department === dept) && (!team || r.team === team) && (!q.trim() || `${r.name} ${r.code || ''}`.toLowerCase().includes(q.trim().toLowerCase())))
    .sort((a, b) => (b.keys || 0) - (a.keys || 0) || String(a.name).localeCompare(String(b.name))), [data, dept, team, q]);
  const withData = rows.filter((r) => r.keys != null || r.clicks != null);
  return (
    <>
      <div className="small-muted">How much each person used the keyboard and mouse in work hours: key presses and clicks. Open a person to see each key one by one, by app and by hour. Letter keys and number keys are counted as a group - never the letters themselves.</div>
      <div className="mon-bar">
        <label>Day <input type="date" value={date} max={todayIst()} onChange={(e) => setDate(e.target.value || todayIst())} /></label>
        <input type="search" placeholder="Search a name or code" value={q} onChange={(e) => setQ(e.target.value)} />
        <Combo value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department">
          <option value="">All departments</option>
          {((data && data.departments) || []).map((d) => <option key={d} value={d}>{d}</option>)}
        </Combo>
        <Combo value={team} onChange={(e) => setTeam(e.target.value)} aria-label="Team">
          <option value="">All teams</option>
          {((data && data.teams) || []).map((d) => <option key={d} value={d}>{d}</option>)}
        </Combo>
      </div>
      {error && <div className="notice red">{error}</div>}
      <table className="mon-table">
        <thead><tr><th>Employee</th><th>Department</th><th className="num" title="Key presses in work hours. Letter keys and number keys are counted as a group.">Key presses</th><th className="num">Clicks</th><th>Most-used keys</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.employeeId} className="row-link" onClick={() => onOpen(r.employeeId)}>
              <td>
                <b>{r.name}</b>{r.code && <div className="small-muted">{r.code}</div>}
                {r.repeat && <div title={r.repeat.top} style={{ marginTop: 3 }}><Pill tone="red">{`Same key / click over and over · ${r.repeat.minutes} min`}</Pill></div>}
              </td>
              <td>{r.department || '—'}{r.team && <div className="small-muted">{r.team}</div>}</td>
              <td className="num">{r.keys == null ? <span className="small-muted">—</span> : <b>{Number(r.keys).toLocaleString('en-IN')}</b>}</td>
              <td className="num">{r.clicks == null ? <span className="small-muted">—</span> : Number(r.clicks).toLocaleString('en-IN')}</td>
              <td className="small-muted mon-item">{r.topKeys || '—'}</td>
            </tr>
          ))}
          {!rows.length && !loading && <tr><td colSpan={5} className="small-muted">Nobody to show for this day.</td></tr>}
          {rows.length > 0 && !withData.length && !loading && <tr><td colSpan={5} className="small-muted">No keyboard counts recorded for this day yet. PCs record these once they are on agent 2.6 or later.</td></tr>}
        </tbody>
      </table>
    </>
  );
}

// ------------------------------------------------------------------------------------------------ Overview
function Overview({ onOpen }) {
  const [date, setDate] = useState(todayIst());
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const [team, setTeam] = useState('');
  const [status, setStatus] = useState('');
  const [sortBy, setSortBy] = useState('');
  const { data, error, loading, reload } = useGet('/monitoring/overview', { date });
  const live = date === todayIst();
  // live: hours and scores every 30 seconds; who is doing what every 2 seconds, from the light /live (founder: "within sec lo updation jaragali")
  const [now, setNow] = useState(null);
  useEffect(() => {
    if (!live) { setNow(null); return undefined; }
    const t = setInterval(() => { if (!document.hidden) reload(); }, 30000);
    let busy = false;
    const read = () => {
      if (document.hidden || busy) return;
      busy = true;
      api.get('/monitoring/live').then((r) => setNow(r.data)).catch(() => {}).finally(() => { busy = false; });
    };
    read();
    const fast = setInterval(read, 2000);
    return () => { clearInterval(t); clearInterval(fast); };
  }, [live, reload]);
  const fresh = useMemo(() => new Map(((now && now.rows) || []).map((r) => [r.employeeId, r])), [now]);
  const allRows = useMemo(() => ((data && data.rows) || []).map((r) => ({ ...r, ...(fresh.get(r.employeeId) || {}) })), [data, fresh]);
  const rows = useMemo(() => {
    const out = allRows.filter((r) => (!dept || r.department === dept) && (!team || r.team === team)
      && (!status || r.status === status)
      && (!q.trim() || `${r.name} ${r.code || ''}`.toLowerCase().includes(q.trim().toLowerCase())));
    const n = (r, k) => Number(r[k]) || 0;
    const by = {
      active: (a, b) => n(b, 'activeHours') - n(a, 'activeHours'),
      idle: (a, b) => n(b, 'idleHours') - n(a, 'idleHours'),
      break: (a, b) => n(b, 'breakHours') - n(a, 'breakHours'),
      away: (a, b) => n(b, 'awayHours') - n(a, 'awayHours'),
      prod: (a, b) => n(a, 'productivity') - n(b, 'productivity'),
    }[sortBy];
    if (by) out.sort((a, b) => by(a, b) || String(a.name || '').localeCompare(String(b.name || '')));
    return out;
  }, [allRows, dept, team, status, q, sortBy]);
  // the statuses actually on the board now, in a sensible order, for the Status filter (founder 2026-11-12: "idle, break etc vetiki pettukovadaniki")
  // every status is offered, so any one can be filtered on even when nobody is in it right now (founder 2026-11-12: "dropdown lo anni raavali")
  const statusOptions = ['Online', 'Idle', 'On break', 'Offline', 'Laptop closed', 'Clocked out', 'Old agent', 'Stopped', 'On leave'];
  const c = data && data.cards ? { ...data.cards, ...((now && now.cards) || {}) } : null;
  const first = ((data && data.rows) || []).find((r) => r.workHours > 0) || null;
  const card = (s) => ({ active: status === s, onClick: live ? () => setStatus(status === s ? '' : s) : undefined });
  return (
    <>
      <div className="mon-bar">
        <label>Day <input type="date" value={date} max={todayIst()} onChange={(e) => { setDate(e.target.value || todayIst()); setStatus(''); }} /></label>
        <input type="search" placeholder="Search a name or code" value={q} onChange={(e) => setQ(e.target.value)} />
        <Combo value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department">
          <option value="">All departments</option>
          {((data && data.departments) || []).map((d) => <option key={d} value={d}>{d}</option>)}
        </Combo>
        <Combo value={team} onChange={(e) => setTeam(e.target.value)} aria-label="Team">
          <option value="">All teams</option>
          {((data && data.teams) || []).map((d) => <option key={d} value={d}>{d}</option>)}
        </Combo>
        <Combo value={sortBy} onChange={(e) => setSortBy(e.target.value)} aria-label="Sort by">
          <option value="">Sort: default</option>
          <option value="idle">Most idle</option>
          <option value="break">Most break</option>
          <option value="away">Most off the PC</option>
          <option value="active">Most active</option>
          <option value="prod">Least productive</option>
        </Combo>
        {live && (
          <Combo value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="">All statuses</option>
            {statusOptions.map((x) => <option key={x} value={x}>{x}</option>)}
          </Combo>
        )}
        {live && <span className="small-muted" style={{ marginLeft: 'auto' }}>Live: updates within seconds</span>}
      </div>
      {error && <div className="notice red">{error}</div>}
      {/* when a time-based status is filtered, that one time stands out (founder 2026-11-12: idle meedha click chesthey entha sepu idle lo vunnaro) */}
      {live && HI_OF[status] && <div className="small-muted" style={{ margin: '0 0 8px' }}>{HI_WORD[status]}</div>}
      <KpiRow>
        <KpiTile icon="users" tone="blue" label="Tracked" value={c ? c.tracked : null} loading={loading && !c} sub={live && status ? 'Show all with a PC' : 'With a registered PC'} {...(live ? { active: !status, onClick: () => setStatus('') } : {})} />
        <KpiTile icon="check" tone="green" label="Online" value={live && c ? c.online : (live ? null : '—')} loading={loading && !c} sub="Using the PC now" {...card('Online')} />
        <KpiTile icon="pause" tone="amber" label="Idle" value={live && c ? c.idle : (live ? null : '—')} loading={loading && !c} sub="PC on, not in use" {...card('Idle')} />
        <KpiTile icon="x" tone="slate" label="Offline" value={live && c ? c.offline : (live ? null : '—')} loading={loading && !c} sub={c && c.closed ? `No signal for 3 minutes · ${c.closed} laptop${c.closed === 1 ? '' : 's'} closed` : 'No signal for 3 minutes'} {...card('Offline')} />
        <KpiTile icon="pause" tone="violet" label="Away" value={live && c ? Math.max(0, (c.tracked || 0) - (c.online || 0) - (c.idle || 0) - (c.offline || 0) - (c.onLeave || 0)) : (live ? null : '—')} loading={loading && !c} sub={c ? `Break ${c.onBreak || 0} · Laptop closed ${c.closed || 0}` : 'On break or laptop closed'} title="On break, clocked out or laptop closed - so Online + Idle + Offline + Away + On leave add up to Tracked. Pick a status in the filter to see who." />
        <KpiTile icon="leave" tone="violet" label="On leave" value={c ? c.onLeave : null} loading={loading && !c} sub="Approved leave today" {...card('On leave')} />
        <KpiTile icon="clock" tone="teal" label="Avg active" value={c ? `${c.avgActiveHours} h` : null} loading={loading && !c} sub={`Avg idle ${c ? c.avgIdleHours : 0} h${first && first.workHours ? ` · out of ${hm(first.workHours)}` : ''}`} />
      </KpiRow>
      {first && first.workHours > 0 && (
        <div className="mon-dayline">
          <b>Work day {clock(first.workStart)} – {clock(first.workEnd)}</b>
          {first.lunchStart && <> · lunch {clock(first.lunchStart)} – {clock(first.lunchEnd)}</>}
          {first.personalBreakMinutes > 0 && <> · {first.personalBreakMinutes} min personal break</>}
          {' '}· <b>{hm(first.workHours)}</b> of work{live && first.elapsedHours < first.dayHours && <> · {hm(first.elapsedHours)} of the day has passed</>}
          <span className="mon-day-legend"><span><i className="active" /> Active</span><span><i className="idle" /> Idle</span><span><i className="break" /> Break</span><span><i className="away" /> Not on the PC</span>{live && <span><i className="rest" /> Still to come</span>}</span>
        </div>
      )}
      <div className="tbl-wrap">
        <table className="mon-table">
          <thead><tr><th>Employee</th><th>Department</th>{live && <th>Status</th>}{live && <th>Using now</th>}<th>First seen</th><th>Last seen</th><th className="mon-daycol">Work day</th><th className={`num${HI_OF[status] === 'active' ? ' mon-hi' : ''}`} title="Time the PC was in use, out of the work time (the day without the lunch break)">Active</th><th className={`num${HI_OF[status] === 'idle' ? ' mon-hi' : ''}`}>Idle</th><th className={`num${HI_OF[status] === 'break' ? ' mon-hi' : ''}`}>Break</th><th className={`num${HI_OF[status] === 'away' ? ' mon-hi' : ''}`} title="Work time that has passed with no signal from the PC: away, PC off, or not yet in">Not on PC</th><th className="num" title="Time in apps marked Productive, out of the active time">Productivity</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.employeeId} className="row-link" onClick={() => onOpen(r.employeeId)}>
                <td>
                  <b>{r.name}</b>{r.code && <div className="small-muted">{r.code}</div>}
                  {/* the same key / button over and over today (agent 2.5): a check, not a verdict */}
                  {r.repeat && <div title={r.repeat.top} style={{ marginTop: 3 }}><Pill tone="red">{`Same key / click over and over · ${r.repeat.minutes} min`}</Pill></div>}
                </td>
                <td>{r.department || '—'}{r.team && <div className="small-muted">{r.team}</div>}</td>
                {live && <td title={STATUS_TIP[r.status] || undefined}><Pill tone={STATUS_TONE[r.status] || 'slate'}>{r.status || '—'}</Pill>{r.status === 'Old agent' && <div className="small-muted">Restart the PC once</div>}</td>}
                {live && (() => {
                  const { site, page } = siteOf(r.currentApp, r.currentTitle);
                  return <td className="mon-now">{r.currentApp || <span className="small-muted">—</span>}{site && <> · <b>{site}</b></>}{r.doing && <> <Pill tone={r.doing === 'typing' ? 'green' : 'blue'}>{r.doing}</Pill></>}{page && <div className="small-muted" title={r.currentTitle}>{page}</div>}</td>;
                })()}
                <td>{tm(r.firstSeen)}</td>
                <td>{live && r.lastHeartbeat ? dt(r.lastHeartbeat) : tm(r.lastSeen)}</td>
                <td className="mon-daycol"><DayBar r={r} /></td>
                <td className={`num${HI_OF[status] === 'active' ? ' mon-hi' : ''}`}><b>{hm(r.activeHours)}</b>{r.workHours > 0 && <div className="small-muted">of {hm(r.workHours)}</div>}</td>
                <td className={`num${HI_OF[status] === 'idle' ? ' mon-hi' : ''}`}>{hm(r.idleHours)}</td>
                <td className={`num${HI_OF[status] === 'break' ? ' mon-hi' : ''}`}>{hm(r.breakHours)}</td>
                <td className={`num${HI_OF[status] === 'away' ? ' mon-hi' : ''}`}>{r.status === 'On leave' ? '—' : hm(r.awayHours)}</td>
                <td className="num">{pct(r.productivity)}</td>
              </tr>
            ))}
            {!rows.length && !loading && <tr><td colSpan={live ? 12 : 10} className="small-muted">{(data && data.rows && data.rows.length) ? 'Nobody matches these filters.' : 'No PC is registered yet. Settings has the steps to set one up.'}</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ------------------------------------------------------------------------------------------------ Dates (Reports, App usage, Audit log)
function RangeBar({ from, to, setFrom, setTo, children }) {
  const pick = (a, b) => { setFrom(a); setTo(b); };
  const t = todayIst();
  return (
    <div className="mon-bar">
      <label>From <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
      <label>To <input type="date" value={to} min={from} max={t} onChange={(e) => setTo(e.target.value)} /></label>
      <button type="button" className="btn btn-sm" onClick={() => pick(t, t)}>Today</button>
      <button type="button" className="btn btn-sm" onClick={() => pick(addDays(t, -6), t)}>Week</button>
      <button type="button" className="btn btn-sm" onClick={() => pick(`${t.slice(0, 7)}-01`, t)}>This month</button>
      {children}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ App & website usage
function Usage() {
  const [from, setFrom] = useState(addDays(todayIst(), -6));
  const [to, setTo] = useState(todayIst());
  const [department, setDepartment] = useState('');
  const { data, error } = useGet('/monitoring/usage', { from, to, department });
  const list = (rows, empty, noun) => (
    <table className="mon-table">
      <thead><tr><th>{noun}</th><th className="num">Time</th><th className="num">People</th><th>Category</th></tr></thead>
      <tbody>
        {rows.map((a) => (
          <tr key={a.key}><td><b>{a.name}</b></td><td className="num">{h(a.hours)}</td><td className="num">{a.people}</td><td>{a.category ? <Pill tone={CAT_TONE[a.category]}>{CAT_WORD[a.category]}</Pill> : <span className="small-muted">Not set</span>}</td></tr>
        ))}
        {!rows.length && <tr><td colSpan={4} className="small-muted">{empty}</td></tr>}
      </tbody>
    </table>
  );
  const s = data && data.split;
  return (
    <>
      <RangeBar from={from} to={to} setFrom={setFrom} setTo={setTo}>
        <Combo value={department} onChange={(e) => setDepartment(e.target.value)} aria-label="Department">
          <option value="">All departments</option>
          {((data && data.departments) || []).map((d) => <option key={d} value={d}>{d}</option>)}
        </Combo>
      </RangeBar>
      {error && <div className="notice red">{error}</div>}
      {s && (
        <KpiRow>
          <KpiTile icon="check" tone="green" label="Productive" value={h(s.productive)} sub="Active time" />
          <KpiTile icon="list" tone="slate" label="Neutral" value={h(s.neutral)} sub="Active time" />
          <KpiTile icon="alert" tone="red" label="Unproductive" value={h(s.unproductive)} sub="Active time" />
          <KpiTile icon="file" tone="amber" label="Not marked" value={h(s.unset)} sub="Mark them in Productivity rules" />
        </KpiRow>
      )}
      {data && (
        <div className="mon-two">
          <Panel title="Top apps" flush>{list(data.topApps, 'No app used in these days.', 'App')}</Panel>
          <Panel title="Top websites" sub="Sites with a rule, found in the browser's window title" flush>{list(data.topSites, 'No marked website used in these days.', 'Website')}</Panel>
        </div>
      )}
      {data && data.byDepartment.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <Panel title="By department" flush>
            <table className="mon-table">
              <thead><tr><th>Department</th><th className="num">Productive</th><th className="num">Neutral</th><th className="num">Unproductive</th><th className="num">Not marked</th></tr></thead>
              <tbody>{data.byDepartment.map((t) => <tr key={t.name}><td><b>{t.name}</b></td><td className="num">{h(t.productive)}</td><td className="num">{h(t.neutral)}</td><td className="num">{h(t.unproductive)}</td><td className="num">{h(t.unset)}</td></tr>)}</tbody>
            </table>
          </Panel>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------------------------------------ Alerts
const ALERT_TONE = { idle: 'amber', stopped: 'red', offline: 'red', low: 'slate' };
function Alerts({ onOpen }) {
  const [from, setFrom] = useState(addDays(todayIst(), -6));
  const [to, setTo] = useState(todayIst());
  const [kind, setKind] = useState('');
  const { data, error } = useGet('/monitoring/alerts', { from, to });
  const conf = useGet('/monitoring/settings');
  const all = (data && data.rows) || [];
  const rows = all.filter((r) => !kind || r.kind === kind);
  return (
    <>
      {conf.data && !conf.data.alertsEnabled && <div className="notice">Alerts are off. {conf.data.canEdit ? 'Switch them on in Settings.' : 'HR can switch them on.'}</div>}
      <RangeBar from={from} to={to} setFrom={setFrom} setTo={setTo}>
        <Combo value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind of alert">
          <option value="">All alerts</option>
          {Object.entries((data && data.kinds) || {}).map(([k, w]) => <option key={k} value={k}>{w}</option>)}
        </Combo>
      </RangeBar>
      {error && <div className="notice red">{error}</div>}
      <div className="tbl-wrap">
        <table className="mon-table">
          <thead><tr><th>When</th><th>Employee</th><th>Department</th><th>Alert</th><th>Detail</th></tr></thead>
          <tbody>
            {rows.map((r) => <tr key={r.id} className="row-link" onClick={() => onOpen(r.employeeId)}><td style={{ whiteSpace: 'nowrap' }}>{dt(r.at)}</td><td><b>{r.name}</b>{r.code && <div className="small-muted">{r.code}</div>}</td><td>{r.department || '—'}</td><td><Pill tone={ALERT_TONE[r.kind] || 'slate'}>{r.word}</Pill></td><td className="small-muted">{r.detail || '—'}</td></tr>)}
            {data && !rows.length && <tr><td colSpan={5} className="small-muted">No alerts in these days.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ------------------------------------------------------------------------------------------------ Attendance suggestions
// A working day with PC activity and no attendance at all. HR approves or dismisses; it only fills an empty day.
// TASKS VS WORK (founder 2026-11-10: "time sheet lo task assign cheskuntaru kadah, aa task ki, vallu work chesthunna dhaaniki match
// avuthundha ledha, entha percent match avuthundhi"): the HRMS tasks and the Timesheet Checklist of each day beside what was open.
const matchTone = (p) => (p == null ? 'slate' : p >= 60 ? 'green' : p >= 30 ? 'amber' : 'red');
function TasksVsWork({ onOpen }) {
  const [from, setFrom] = useState(todayIst());
  const [to, setTo] = useState(todayIst());
  const [q, setQ] = useState('');
  const [band, setBand] = useState('');
  const [open, setOpen] = useState({});
  const { data, error, loading } = useGet('/monitoring/task-match', { from, to });
  // filter by the match % (the same bands as the colour: 60+ good, 30-59 okay, under 30 poor, and No task open)
  const inBand = (r) => {
    if (!band) return true;
    if (band === 'none') return r.matchPct == null;
    if (r.matchPct == null) return false;
    if (band === 'good') return r.matchPct >= 60;
    if (band === 'ok') return r.matchPct >= 30 && r.matchPct < 60;
    if (band === 'poor') return r.matchPct < 30;
    return true;
  };
  const rows = ((data && data.rows) || []).filter((r) => (!q.trim() || `${r.name} ${r.code || ''} ${r.department || ''}`.toLowerCase().includes(q.trim().toLowerCase())) && inBand(r));
  const items = (list) => (list || []).map((x) => `${x.item} (${dur(x.seconds)})`).join(' · ');
  return (
    <>
      <div className="small-muted" style={{ marginBottom: 8 }}>
        Each day&apos;s HRMS tasks (Timesheet &gt; Tasks) and Timesheet Checklist, beside what was open on the PC. <b>Match</b> is the active time on windows that fit a task:
        its own words in the window title or app, or the kind of app the task needs (profiles: TeamLink ATS, Naukri; invoices: Accounts, Excel; code: GitHub, Claude).
        It reads the words, not the work.
      </div>
      <RangeBar from={from} to={to} setFrom={setFrom} setTo={setTo}>
        <input type="search" placeholder="Search a name, code or department" value={q} onChange={(e) => setQ(e.target.value)} />
        <Combo value={band} onChange={(e) => setBand(e.target.value)} aria-label="Match %">
          <option value="">Any match</option>
          <option value="good">Good — 60% and up</option>
          <option value="ok">Okay — 30 to 59%</option>
          <option value="poor">Poor — below 30%</option>
          <option value="none">No task open</option>
        </Combo>
      </RangeBar>
      {error && <div className="notice red">{error}</div>}
      {loading && !data && <div className="small-muted">Loading…</div>}
      <div className="tbl-wrap">
        <table className="mon-table">
          <thead><tr><th>Date</th><th>Employee</th><th className="num">Tasks</th><th className="num">Checklist</th><th className="num">Active</th><th className="num" title="Active time on windows that fit a task">On the tasks</th><th>Match</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => {
              const isOpen = !!open[r.key];
              return (
                <Fragment key={r.key}>
                  <tr className="row-link" onClick={() => setOpen({ ...open, [r.key]: !isOpen })}>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.day}</td>
                    <td><b>{r.name}</b><div className="small-muted">{[r.code, r.department].filter(Boolean).join(' · ')}</div></td>
                    <td className="num">{r.tasks.length}</td>
                    <td className="num">{r.checklist.length}</td>
                    <td className="num">{hm(r.activeHours)}</td>
                    <td className="num">{r.matchPct == null ? '—' : hm(r.matchedHours)}</td>
                    <td>{r.matchPct == null ? <span className="small-muted">No task open</span> : <><Pill tone={matchTone(r.matchPct)}>{r.matchPct}%</Pill>{r.ownPct != null && <div className="small-muted">{r.ownPct}% by the task&apos;s own words</div>}</>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}><button type="button" className="btn btn-sm btn-ghost">{isOpen ? 'Hide' : 'Details'}</button></td>
                  </tr>
                  {isOpen && (
                    <tr className="mon-task-detail">
                      <td colSpan={8}>
                        {r.tasks.length > 0 && (
                          <table className="mon-table">
                            <thead><tr><th>Task</th><th>Status</th><th className="num">Own words</th><th className="num">Related apps</th><th>Share of the day</th><th>Where the time went</th></tr></thead>
                            <tbody>
                              {r.tasks.map((t) => (
                                <tr key={t.id}>
                                  <td><b>{t.name}</b>{t.subTaskName && <div className="small-muted">{t.subTaskName}</div>}<div className="small-muted">{[t.startDate, t.endDate].filter(Boolean).join(' – ')}{t.priority ? ` · ${t.priority}` : ''}</div></td>
                                  <td>{t.status}</td>
                                  <td className="num">{hm(t.ownHours)}</td>
                                  <td className="num">{hm(t.relatedHours)}</td>
                                  <td><Pill tone={matchTone(t.sharePct)}>{t.sharePct == null ? '—' : `${t.sharePct}%`}</Pill></td>
                                  <td className="small-muted mon-item">{t.items.length ? items(t.items) : 'Nothing open on the PC fitted this task.'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        {r.checklist.length > 0 && (
                          <table className="mon-table" style={{ marginTop: 8 }}>
                            <thead><tr><th>Checklist</th><th>What they wrote</th><th className="num">Active in it</th><th>Match</th><th>Open on the PC then</th></tr></thead>
                            <tbody>
                              {r.checklist.map((c) => (
                                <tr key={`${c.from}-${c.to}-${c.description.slice(0, 20)}`}>
                                  <td style={{ whiteSpace: 'nowrap' }}>{c.from} – {c.to}<div className="small-muted">{c.status}</div></td>
                                  <td className="mon-item">{c.description}</td>
                                  <td className="num">{hm(c.activeHours)}{c.slotPct != null && <div className="small-muted">{c.slotPct}% of the slot</div>}</td>
                                  <td><Pill tone={matchTone(c.matchPct)}>{c.matchPct == null ? 'PC not used' : `${c.matchPct}%`}</Pill></td>
                                  <td className="small-muted mon-item">{c.items.length ? items(c.items) : '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        {!r.tasks.length && !r.checklist.length && <div className="small-muted" style={{ padding: 8 }}>No HRMS task was open for {r.name} on this day, and nothing was written in the Checklist.</div>}
                        {r.other.length > 0 && <div className="small-muted" style={{ padding: '8px 10px' }}><b>Did not fit any task:</b> {items(r.other)}</div>}
                        <div style={{ padding: '0 10px 8px' }}><button type="button" className="btn btn-sm" onClick={() => onOpen(r.employeeId)}>Open {r.name}&apos;s day</button></div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {data && !rows.length && <tr><td colSpan={8} className="small-muted">No PC activity in these days.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

// PRESENT / ABSENT FROM THE PC (founder 2026-11-10: "active hours count cheskoni, present / absent raavali, including percentage")
const MARK_TONE = { Present: 'green', 'Half day': 'amber', Absent: 'red', 'On leave': 'violet' };
function PcAttendance() {
  const [from, setFrom] = useState(`${todayIst().slice(0, 8)}01`);
  const [to, setTo] = useState(todayIst());
  const [view, setView] = useState('people');
  const [q, setQ] = useState('');
  const [department, setDepartment] = useState('');
  const [team, setTeam] = useState('');
  const [mark, setMark] = useState('');
  const [band, setBand] = useState('');
  const filters = { department, team, mark, band };
  const { data, error, loading } = useGet('/monitoring/pc-attendance', { from, to, ...filters });
  const anyFilter = department || team || mark || band || q.trim();
  const match = (r) => !q.trim() || `${r.name} ${r.code || ''} ${r.department || ''} ${r.team || ''}`.toLowerCase().includes(q.trim().toLowerCase());
  const people = ((data && data.people) || []).filter(match);
  const days = ((data && data.days) || []).filter(match);
  const tone = (m) => MARK_TONE[m] || 'slate';
  const bar = (pct) => <div className="mon-item-bar" style={{ maxWidth: 120 }}><i style={{ width: `${Math.max(2, Math.min(100, pct || 0))}%`, background: pct >= ((data && data.presentPct) || 75) ? '#22a06b' : pct >= ((data && data.halfPct) || 50) ? '#e59a1a' : '#d64545' }} /></div>;
  return (
    <Panel title="Present or absent, from the PC" sub={data ? `Active time out of the 8 h work day: Present at ${data.presentPct}% (6 h) or more, Half day at ${data.halfPct}% (4 h), Absent below. A reference beside HR attendance: it changes nothing.` : 'Active time out of the 8 h work day'} flush>
      <div style={{ padding: '10px 12px 0' }}>
        <RangeBar from={from} to={to} setFrom={setFrom} setTo={setTo}>
        <input type="search" placeholder="Search a name, code or department" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="mon-tabs" style={{ border: 0, padding: 0 }}>
          <button type="button" className={view === 'people' ? 'on' : ''} onClick={() => setView('people')}>Per employee</button>
          <button type="button" className={view === 'days' ? 'on' : ''} onClick={() => setView('days')}>Day by day</button>
        </span>
        <span style={{ marginLeft: 'auto' }}><ExportMenu url="/monitoring/pc-attendance" params={{ from, to, view, ...filters }} label="Export" /></span>
        </RangeBar>
        <div className="mon-bar">
          <Combo value={department} onChange={(e) => { setDepartment(e.target.value); setTeam(''); }} aria-label="Department">
            <option value="">All departments</option>
            {((data && data.departments) || []).map((d) => <option key={d} value={d}>{d}</option>)}
          </Combo>
          <Combo value={team} onChange={(e) => setTeam(e.target.value)} aria-label="Team">
            <option value="">All teams</option>
            {((data && data.teams) || []).map((d) => <option key={d} value={d}>{d}</option>)}
          </Combo>
          <Combo value={mark} onChange={(e) => setMark(e.target.value)} aria-label="Present, half day, absent or on leave">
            <option value="">Present, half day, absent</option>
            <option value="Present">Present</option>
            <option value="Half day">Half day</option>
            <option value="Absent">Absent</option>
            <option value="On leave">On leave</option>
          </Combo>
          <Combo value={band} onChange={(e) => setBand(e.target.value)} aria-label="Active %">
            <option value="">Any active %</option>
            <option value="present">75% or more</option>
            <option value="half">50% to 75%</option>
            <option value="low">Below 50%</option>
          </Combo>
          {anyFilter && <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setDepartment(''); setTeam(''); setMark(''); setBand(''); setQ(''); }}>Clear filters</button>}
          {data && <span className="small-muted">{view === 'people' ? `${people.length} of ${data.total} employee${data.total === 1 ? '' : 's'}` : `${days.length} day${days.length === 1 ? '' : 's'}`}{mark && view === 'people' ? ` with at least one ${mark.toLowerCase()} day` : ''}</span>}
        </div>
      </div>
      {error && <div className="notice red">{error}</div>}
      {loading && !data && <div className="small-muted" style={{ padding: 12 }}>Loading…</div>}
      <div className="tbl-wrap">
        {view === 'people' ? (
          <table className="mon-table">
            <thead><tr><th>Employee</th><th>Department</th><th className="num">Working days</th><th className="num">Present</th><th className="num">Half day</th><th className="num">Absent</th><th className="num">On leave</th><th className="num" title="Present days, and half days as half, out of the working days without leave">Attendance</th><th className="num">Active</th><th title="Active time out of the work time">Active %</th></tr></thead>
            <tbody>
              {people.map((r) => (
                <tr key={r.key}>
                  <td><b>{r.name}</b>{r.code && <div className="small-muted">{r.code}</div>}</td>
                  <td>{r.department || '—'}{r.team && <div className="small-muted">{r.team}</div>}</td>
                  <td className="num">{r.days}</td>
                  <td className="num">{r.present}</td>
                  <td className="num">{r.halfDays}</td>
                  <td className="num">{r.absent}</td>
                  <td className="num">{r.leave}</td>
                  <td className="num"><b>{r.attendancePct == null ? '—' : `${r.attendancePct}%`}</b></td>
                  <td className="num">{hm(r.activeHours)}{r.workHours > 0 && <div className="small-muted">of {hm(r.workHours)}</div>}</td>
                  <td><b>{r.pct == null ? '—' : `${r.pct}%`}</b>{r.pct != null && bar(r.pct)}</td>
                </tr>
              ))}
              {data && !people.length && <tr><td colSpan={10} className="small-muted">No monitored PC in these days.</td></tr>}
            </tbody>
          </table>
        ) : (
          <table className="mon-table">
            <thead><tr><th>Date</th><th>Employee</th><th>First</th><th>Last</th><th className="num">Active</th><th>Active %</th><th>From the PC</th></tr></thead>
            <tbody>
              {days.map((r) => (
                <tr key={r.key}>
                  <td style={{ whiteSpace: 'nowrap' }}>{r.day}</td>
                  <td><b>{r.name}</b><div className="small-muted">{[r.code, r.department].filter(Boolean).join(' · ')}</div></td>
                  <td>{r.first || '—'}</td><td>{r.last || '—'}</td>
                  <td className="num">{hm(r.activeHours)}<div className="small-muted">of {hm(r.workHours)}</div></td>
                  <td><b>{r.pct}%</b>{bar(r.pct)}</td>
                  <td><Pill tone={tone(r.mark)}>{r.mark}</Pill></td>
                </tr>
              ))}
              {data && !days.length && <tr><td colSpan={7} className="small-muted">No monitored PC in these days.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  );
}

function AttendanceTab() {
  const [from, setFrom] = useState(addDays(todayIst(), -13));
  const [to, setTo] = useState(addDays(todayIst(), -1));
  const { data, error, reload } = useGet('/monitoring/attendance-suggestions', { from, to });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [picked, setPicked] = useState({});
  const [busy, setBusy] = useState(false);
  const rows = (data && data.rows) || [];
  async function act(r, what) {
    setBusy(true); setMsg(''); setErr('');
    try {
      const out = await api.post(`/monitoring/attendance-suggestions/${what}`, { employeeId: r.employeeId, day: r.day, status: picked[r.key] || r.suggested });
      setMsg(out.data.message); reload();
    } catch (e) { setErr(errOf(e, 'Could not save.')); } finally { setBusy(false); }
  }
  return (
    <>
      <PcAttendance />
      <h3 className="mon-h3">Days to fill in HR attendance</h3>
      <div className="small-muted" style={{ marginBottom: 8 }}>Working days with PC activity but no attendance: no mark, no punch and no leave. Approve to fill the day, or dismiss it. Attendance that is already there is never changed.</div>
      <RangeBar from={from} to={to} setFrom={setFrom} setTo={setTo} />
      {msg && <div className="notice green">{msg}</div>}
      {(err || error) && <div className="notice red">{err || error}</div>}
      <div className="tbl-wrap">
        <table className="mon-table">
          <thead><tr><th>Date</th><th>Employee</th><th>First activity</th><th>Last activity</th><th className="num">Hours</th><th className="num">Active</th><th>Mark as</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td style={{ whiteSpace: 'nowrap' }}>{r.day}</td>
                <td><b>{r.name}</b><div className="small-muted">{[r.code, r.department].filter(Boolean).join(' · ')}</div></td>
                <td>{r.checkIn}</td><td>{r.checkOut}</td><td className="num">{h(r.hours)}</td><td className="num">{h(r.activeHours)}</td>
                <td><Combo value={picked[r.key] || r.suggested} onChange={(e) => setPicked({ ...picked, [r.key]: e.target.value })} aria-label={`Mark ${r.name} on ${r.day}`}><option value="Present">Present</option><option value="Half Day">Half Day</option></Combo></td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(r, 'approve')}>Approve</button>{' '}
                  <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => act(r, 'dismiss')}>Dismiss</button>
                </td>
              </tr>
            ))}
            {data && !rows.length && <tr><td colSpan={8} className="small-muted">Nothing to approve in these days.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ------------------------------------------------------------------------------------------------ Audit log
function Audit() {
  const [from, setFrom] = useState(addDays(todayIst(), -29));
  const [to, setTo] = useState(todayIst());
  const { data, error } = useGet('/monitoring/audit', { from, to });
  const rows = (data && data.rows) || [];
  return (
    <>
      <div className="small-muted" style={{ marginBottom: 8 }}>Who looked at whose activity, what was exported, settings changes and PCs set up or switched off.</div>
      <RangeBar from={from} to={to} setFrom={setFrom} setTo={setTo} />
      {error && <div className="notice red">{error}</div>}
      <div className="tbl-wrap">
        <table className="mon-table">
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr></thead>
          <tbody>
            {rows.map((r) => <tr key={r.id}><td style={{ whiteSpace: 'nowrap' }}>{dt(r.at)}</td><td><b>{r.who}</b></td><td>{r.action}</td><td className="small-muted mon-titles">{r.detail || '—'}</td></tr>)}
            {data && !rows.length && <tr><td colSpan={4} className="small-muted">Nothing in these days.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ------------------------------------------------------------------------------------------------ One employee
// THE DAY, CLICKABLE (founder 2026-11-11: "ahh colours lo dheyni meedha click chesina, ahh time lo vallu em open chesaro, mottham clear ga,
// indetail ga kaavali"). A click on any colour selects that whole stretch (green from 9:12 to 9:47, an idle spell, a break) and lists,
// under the bar, everything that was in front in it: when, how long, the app or website, and the page / file (the window title).
const kindOf = (r) => (r.break ? 'break' : r.idle ? 'idle' : 'active');
const KIND_WORD = { active: 'Active', idle: 'Idle (no mouse or keyboard)', break: 'Break' };
function blocksOf(rows) {
  const sorted = [...rows].sort((x, y) => new Date(x.start) - new Date(y.start));
  const out = [];
  sorted.forEach((r, i) => {
    const k = kindOf(r);
    const last = out[out.length - 1];
    const st = new Date(r.start).getTime(); const en = new Date(r.end).getTime();
    if (last && last.kind === k && st - last.to <= 2 * 60000) { last.to = Math.max(last.to, en); last.rows.push(r); last.idx.push(i); } else out.push({ kind: k, from: st, to: en, rows: [r], idx: [i] });
  });
  return { sorted, blocks: out };
}
function appWord(app) {
  const a = String(app || '');
  const known = { chrome: 'Chrome', msedge: 'Edge', firefox: 'Firefox', excel: 'Excel', winword: 'Word', powerpnt: 'PowerPoint', outlook: 'Outlook', explorer: 'File Explorer', whatsapp: 'WhatsApp', teams: 'Teams', 'ms-teams': 'Teams', code: 'VS Code', notepad: 'Notepad', acrord32: 'Adobe Reader', claude: 'Claude (app)', chatgpt: 'ChatGPT (app)', zoom: 'Zoom', anydesk: 'AnyDesk', locked: 'Screen locked', desktop: 'Desktop' };
  return known[a.toLowerCase()] || a || '—';
}
function BlockDetail({ block, onClose }) {
  const secs = (r) => Math.max(0, Math.round((new Date(r.end) - new Date(r.start)) / 1000));
  const total = Math.round((block.to - block.from) / 1000);
  // most of the time in ...: app / website, longest first
  const by = new Map();
  block.rows.forEach((r) => {
    const { site } = siteOf(r.app, r.title);
    const key = site ? `${appWord(r.app)} · ${site}` : appWord(r.app);
    by.set(key, (by.get(key) || 0) + secs(r));
  });
  const top = [...by.entries()].sort((x, y) => y[1] - x[1]);
  return (
    <div className={`mon-tl-detail ${block.kind}`}>
      <div className="mon-tl-dhead">
        <b>{`${tm(new Date(block.from).toISOString())} – ${tm(new Date(block.to).toISOString())}`}</b>
        <span>{` · ${KIND_WORD[block.kind]} · ${dur(total)}`}</span>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClose} style={{ marginLeft: 'auto' }}>Close</button>
      </div>
      {block.kind === 'break' ? (
        <div className="small-muted">{block.rows.some((r) => r.app === 'Personal break') ? 'Personal break: the first 15 minutes of idle time in the day count as a break.' : 'On a break (the TeamLink icon was set to Pause, or the lunch break). Nothing is recorded in a break.'}</div>
      ) : (
        <>
          {block.kind === 'idle' && <div className="small-muted" style={{ marginBottom: 6 }}>Nobody touched the mouse or keyboard in this time. This is what was left open on the screen:</div>}
          {block.kind === 'active' && top.length > 1 && (
            <div className="mon-tl-sum">{top.slice(0, 6).map(([k, v]) => <span key={k}><b>{k}</b>{` ${dur(v)}`}</span>)}</div>
          )}
          <table className="mon-table">
            <thead><tr><th>When</th><th className="num">How long</th><th>App / website</th><th>What was open</th></tr></thead>
            <tbody>
              {block.rows.map((r, i) => {
                const { site, page } = siteOf(r.app, r.title);
                return (
                  <tr key={i}>
                    <td style={{ whiteSpace: 'nowrap' }}>{`${tm(r.start)} – ${tm(r.end)}`}</td>
                    <td className="num">{dur(secs(r))}</td>
                    <td><b>{appWord(r.app)}</b>{site && <div className="small-muted">{site}</div>}</td>
                    <td className="mon-item">{(site ? page : r.title) || <span className="small-muted">{r.title === null && r.app && !['Locked', 'Desktop'].includes(r.app) ? 'Not shown (the app does not say)' : '—'}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
function Timeline({ rows, workStart, workEnd, day }) {
  const a = new Date(`${day}T${workStart}:00+05:30`).getTime();
  const b = new Date(`${day}T${workEnd}:00+05:30`).getTime();
  const span = Math.max(1, b - a);
  const pos = (t) => Math.min(100, Math.max(0, ((new Date(t).getTime() - a) / span) * 100));
  const hours = [];
  for (let t = a; t <= b; t += 3600000) hours.push(t);
  const { sorted, blocks } = useMemo(() => blocksOf(rows), [rows]);
  const [pick, setPick] = useState(null); // the index of the chosen stretch
  const blockOfRow = (i) => blocks.findIndex((x) => x.idx.includes(i));
  const chosen = pick != null ? blocks[pick] : null;
  return (
    <div className="mon-tl" aria-label="The day: active and idle">
      <div className="mon-tl-bar">
        {sorted.map((r, i) => {
          const l = pos(r.start); const w = Math.max(0.2, pos(r.end) - l);
          const bi = blockOfRow(i);
          return (
            <button
              type="button" key={i}
              className={`mon-tl-seg ${kindOf(r)}${pick === bi ? ' on' : ''}`}
              style={{ left: `${l}%`, width: `${w}%` }}
              title={`${tm(r.start)} – ${tm(r.end)} · ${r.break ? (r.app === 'Personal break' ? 'Personal break (first 15 min of idle)' : 'Break') : r.idle ? 'Idle' : `${appWord(r.app)}${r.title ? ` · ${r.title}` : ''}`} - click to see this stretch`}
              aria-label={`${tm(r.start)} to ${tm(r.end)}: ${KIND_WORD[kindOf(r)]}. Show what was open`}
              onClick={() => setPick(pick === bi ? null : bi)}
            />
          );
        })}
      </div>
      <div className="mon-tl-axis">
        {hours.map((t) => <span key={t} style={{ left: `${pos(t)}%` }}>{tm(t).replace(':00', '')}</span>)}
      </div>
      <div className="mon-tl-legend"><span><i className="active" /> Active</span><span><i className="idle" /> Idle</span><span><i className="break" /> Break</span><span><i /> No activity / PC off</span><span className="small-muted">Click any colour to see what was open then</span></div>
      {chosen && <BlockDetail block={chosen} onClose={() => setPick(null)} />}
    </div>
  );
}

// ONE KEY / BUTTON: WHERE AND WHEN (agent 2.7, founder 2026-11-12: "letter keys meedha click chesthey ... ey time nunchi ey time varaku,
// ey platform or app or website lo"). A click on a key in Keys and buttons pressed: its count by app / website, by hour, and each hour
// with the apps in it. Letter keys and number keys stay one count each - never split into single letters.
const hourWord = (hr) => { const h12 = (x) => `${x % 12 || 12} ${x < 12 || x === 24 ? 'am' : 'pm'}`; return `${h12(hr)} – ${h12(hr + 1)}`; };
function KeyDetail({ id, from, to, keyName, onClose }) {
  const { data, error, loading } = useGet(`/monitoring/employee/${id}/key-detail`, { from, to, key: keyName });
  const place = (r) => `${appWord(r.app)}${r.site ? ` · ${r.site}` : ''}`;
  return (
    <div className="mon-tl-detail" style={{ marginTop: 12 }}>
      <div className="mon-tl-dhead">
        <b>{keyName}</b>
        {data && <span>{` · ${Number(data.total).toLocaleString('en-IN')} times${from === to ? '' : ` · ${from} to ${to}`}`}</span>}
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClose} style={{ marginLeft: 'auto' }}>Close</button>
      </div>
      {error && <div className="notice red">{error}</div>}
      {loading && !data && <div className="small-muted">Loading…</div>}
      {data && data.grouped && <div className="small-muted" style={{ marginBottom: 8 }}>{`${keyName} are one count: where and when the typing happened is shown, never which single letter or digit (that would let what was typed be read back).`}</div>}
      {data && !data.total && <div className="small-muted">No app / time detail for this key yet. It is recorded from agent 2.7 on; this PC may still be on an older agent.</div>}
      {data && data.total > 0 && (
        <>
          <div className="mon-two">
            <div>
              <div className="small-muted" style={{ marginBottom: 4 }}>In which app / website</div>
              <BarList showShare rows={data.byApp.slice(0, 12).map((r, i) => ({ key: `${r.app}|${r.site}`, label: place(r), value: r.count, tone: ['blue', 'violet', 'teal', 'amber', 'green', 'pink', 'slate'][i % 7] }))} format={(n) => `${Number(n).toLocaleString('en-IN')} times`} />
            </div>
            <div>
              <div className="small-muted" style={{ marginBottom: 4 }}>In which hour</div>
              <BarList showShare rows={data.byHour.map((r) => ({ key: String(r.hour), label: hourWord(r.hour), value: r.count, tone: 'teal' }))} format={(n) => `${Number(n).toLocaleString('en-IN')} times`} />
            </div>
          </div>
          <table className="mon-table" style={{ marginTop: 10 }}>
            <thead><tr>{from !== to && <th>Day</th>}<th>Time</th><th>App / website</th><th className="num">Times</th></tr></thead>
            <tbody>
              {data.cells.map((c, i) => (
                <tr key={i}>
                  {from !== to && <td style={{ whiteSpace: 'nowrap' }}>{c.day}</td>}
                  <td style={{ whiteSpace: 'nowrap' }}>{hourWord(c.hour)}</td>
                  <td><b>{appWord(c.app)}</b>{c.site && <div className="small-muted">{c.site}</div>}</td>
                  <td className="num">{Number(c.count).toLocaleString('en-IN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// ONE APP / WEBSITE, OPENED FROM THE APP-WISE TABLE (agent 2.9): its keys / buttons and hourly typing.
function AppKeysDetail({ id, from, to, app, site, onClose }) {
  const { data, error, loading } = useGet(`/monitoring/employee/${id}/app-keys`, { from, to, app, site });
  return (
    <tr>
      <td colSpan={6} style={{ background: 'var(--surface-2, #f7f9fc)' }}>
        <div style={{ padding: '4px 2px' }}>
          <div className="mon-tl-dhead">
            <b>{`${appWord(app)}${site ? ` · ${site}` : ''}`}</b>
            {data && <span>{` · ${Number(data.total).toLocaleString('en-IN')} key presses`}</span>}
            <button type="button" className="btn btn-sm btn-ghost" onClick={onClose} style={{ marginLeft: 'auto' }}>Close</button>
          </div>
          {error && <div className="notice red">{error}</div>}
          {loading && !data && <div className="small-muted">Loading…</div>}
          {data && data.total > 0 && (
            <div className="mon-two">
              <BarList showShare rows={data.keys.slice(0, 12).map((k, i) => ({ key: k.name, label: k.name, value: k.count, tone: ['blue', 'violet', 'teal', 'amber', 'green', 'pink', 'slate'][i % 7] }))} format={(n) => `${Number(n).toLocaleString('en-IN')} times`} empty="No keys." />
              <BarList showShare rows={data.byHour.map((r) => ({ key: String(r.hour), label: hourWord(r.hour), value: r.count, tone: 'teal' }))} format={(n) => `${Number(n).toLocaleString('en-IN')} times`} empty="No hourly data." />
            </div>
          )}
          {data && !data.total && <div className="small-muted">No app / time detail yet for this app (recorded from agent 2.7 on).</div>}
        </div>
      </td>
    </tr>
  );
}
export function EmployeeDetail({ id, onBack, own = false }) {
  const [from, setFrom] = useState(todayIst());
  const [to, setTo] = useState(todayIst());
  const { data, error, loading } = useGet(`/monitoring/employee/${id}`, { from, to });
  const t = data && data.totals;
  const [appKey, setAppKey] = useState(null);
  const [keyPick, setKeyPick] = useState(null);
  const [focus, setFocus] = useState(''); // a time card clicked: active / idle / break // a key / button clicked in Keys and buttons pressed
  const [periodQ, setPeriodQ] = useState(''); // founder 2026-11-13: pick Active/Idle/Break on the person's page and filter the periods
  const [periodMin, setPeriodMin] = useState(0);
  const [appPick, setAppPick] = useState(null); // an app row clicked in the app-wise table
  const openApp = data && appKey ? data.apps.find((a) => a.key === appKey) : null;
  return (
    <>
      {onBack && <button type="button" className="btn btn-sm" onClick={onBack} style={{ marginBottom: 10 }}>← Back</button>}
      {data && !own && <h2 className="mon-h2">{data.employee.name}<span className="small-muted">{[data.employee.employeeCode, data.employee.department, data.employee.designation].filter(Boolean).join(' · ')}</span></h2>}
      <div className="mon-bar">
        <label>From <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value || todayIst())} /></label>
        <label>To <input type="date" value={to} min={from} max={todayIst()} onChange={(e) => setTo(e.target.value || from)} /></label>
        <button type="button" className="btn btn-sm" onClick={() => { setFrom(todayIst()); setTo(todayIst()); }}>Today</button>
        <button type="button" className="btn btn-sm" onClick={() => { setFrom(addDays(todayIst(), -6)); setTo(todayIst()); }}>7 days</button>
      </div>
      {error && <div className="notice red">{error}</div>}
      {loading && !data && <div className="small-muted">Loading…</div>}
      {data && (
        <>
          <KpiRow>
            {(() => { const fc = (k) => (data.timeline ? { active: focus === k, onClick: () => setFocus(focus === k ? '' : k) } : {}); return (
              <>
                <KpiTile icon="clock" tone="green" label="Active" value={h(t.activeHours)} sub={data.timeline ? 'Click for the active times' : `First ${tm(t.first)} · last ${tm(t.last)}`} {...fc('active')} />
                <KpiTile icon="pause" tone="amber" label="Idle" value={h(t.idleHours)} sub={data.timeline ? 'Click for the idle times' : 'PC on, not in use'} {...fc('idle')} />
                <KpiTile icon="pause" tone="teal" label="Break" value={h(t.breakHours)} sub={data.timeline ? 'Click for the break times' : 'Lunch and personal break'} {...fc('break')} />
                <KpiTile icon="trend" tone="blue" label="Productivity" value={pct(t.productivity)} sub="Productive apps, of the active time" />
                <KpiTile icon="calendar" tone="violet" label="Days with activity" value={data.perDay.length} sub={`${data.from} to ${data.to}`} />
              </>
            ); })()}
          </KpiRow>
          {data.timeline && (
            <div className="mon-bar" style={{ marginBottom: 8 }}>
              <label>Show periods
                <Combo value={focus} onChange={(e) => setFocus(e.target.value)} aria-label="Show periods">
                  <option value="">— pick one —</option>
                  <option value="active">Active periods</option>
                  <option value="idle">Idle periods</option>
                  <option value="break">Break periods</option>
                </Combo>
              </label>
              {focus && focus !== 'break' && <input type="search" placeholder="Filter by app or website" value={periodQ} onChange={(e) => setPeriodQ(e.target.value)} />}
              {focus && (
                <Combo value={periodMin} onChange={(e) => setPeriodMin(Number(e.target.value))} aria-label="Least length">
                  <option value={0}>Any length</option>
                  <option value={1}>1 min or more</option>
                  <option value={5}>5 min or more</option>
                  <option value={15}>15 min or more</option>
                  <option value={30}>30 min or more</option>
                </Combo>
              )}
            </div>
          )}
          {focus && data.timeline && (() => {
            const secs = (r) => Math.max(0, Math.round((new Date(r.end) - new Date(r.start)) / 1000));
            const q = periodQ.trim().toLowerCase();
            const kept = data.timeline.filter((r) => {
              const isFocus = focus === 'break' ? r.break : focus === 'idle' ? (r.idle && !r.break) : (!r.idle && !r.break);
              if (!isFocus) return false;
              if (periodMin && secs(r) < periodMin * 60) return false;
              if (q && focus !== 'break') { const { site } = siteOf(r.app, r.title); if (!`${appWord(r.app)} ${site || ''} ${r.title || ''}`.toLowerCase().includes(q)) return false; }
              return true;
            });
            const total = kept.reduce((n, r) => n + secs(r), 0);
            const WORD = { active: 'Active', idle: 'Idle', break: 'Break' };
            return (
              <Panel title={`${WORD[focus]} periods`} sub={`${kept.length} on this day · ${dur(total)} in all.${periodMin || q ? ' (filtered)' : ''}`}>
                {kept.length ? (
                  <table className="mon-table">
                    <thead><tr><th>When</th><th className="num">How long</th><th>{focus === 'break' ? 'Kind' : 'App / website'}</th></tr></thead>
                    <tbody>
                      {kept.map((r, i) => {
                        const { site } = siteOf(r.app, r.title);
                        return (
                          <tr key={i}>
                            <td style={{ whiteSpace: 'nowrap' }}>{`${tm(r.start)} – ${tm(r.end)}`}</td>
                            <td className="num">{dur(secs(r))}</td>
                            <td>{focus === 'break' ? (r.app === 'Personal break' ? 'Personal break (first 15 min of idle)' : 'Break / lunch') : <><b>{appWord(r.app)}</b>{site && <div className="small-muted">{site}</div>}</>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : <div className="small-muted">{`No ${focus === 'break' ? 'break' : focus} time on this day.`}</div>}
              </Panel>
            );
          })()}
          {data.timeline && (
            <Panel title="The day" sub={`Work hours ${data.workStart} – ${data.workEnd}`}>
              {data.timeline.length ? <Timeline rows={data.timeline} workStart={data.workStart} workEnd={data.workEnd} day={data.from} /> : <div className="ak-empty">No activity on this day.</div>}
            </Panel>
          )}
          {data.activity && data.activity.kbMin > 0 && (
            <Panel title="Typing and activity" sub={`${data.from === data.to ? 'This day' : `${data.from} to ${data.to}`} · active keyboard ${hmins(data.activity.kbMin)} · active mouse ${hmins(data.activity.mouseMin)} · typing speed about ${data.activity.speed} keys a minute${data.activity.longestTypingMin ? ` · longest unbroken typing ${hmins(data.activity.longestTypingMin)}` : ''}. Counts only, never what was typed.`}>
              <div className="mon-tl-sum">
                <span><b>Active typing</b>{` ${hmins(data.activity.kbMin)}`}</span>
                <span><b>Active mouse</b>{` ${hmins(data.activity.mouseMin)}`}</span>
                <span><b>Typing speed</b>{` ${data.activity.speed}/min`}</span>
                {data.activity.longestTypingMin > 0 && <span><b>Longest session</b>{` ${hmins(data.activity.longestTypingMin)}`}</span>}
                <span><b>Light</b>{` ${data.activity.light} min`}</span>
                <span><b>Moderate</b>{` ${data.activity.mod} min`}</span>
                <span><b>Heavy</b>{` ${data.activity.heavy} min`}</span>
                <span className="small-muted">(heavy = 70+ keys a minute)</span>
              </div>
              {data.activity.perApp && data.activity.perApp.length > 0 && (
                <>
                  <div className="small-muted" style={{ margin: '10px 0 4px' }}>By app / website — click a row to see the keys and hours. Hover a column title for what it means.</div>
                  <table className="mon-table">
                    <thead><tr><th>App / website</th><th className="num" title="How many keys were pressed in this app. Letters count as one group and numbers as one group - the amount of typing, never which letters.">Key presses</th><th className="num" title="Minutes actually spent typing in this app (minutes with at least one keystroke) - not just the app being open.">Active typing</th><th className="num" title="Mouse clicks plus wheel scrolls in this app.">Clicks / scroll</th><th className="num" title="Minutes actually spent using the mouse in this app.">Active mouse</th><th className="num" title="Keys a minute while typing (key presses divided by active typing minutes) - how fast they type here.">Speed</th></tr></thead>
                    <tbody>
                      {data.activity.perApp.map((a) => {
                        const open = appPick === `${a.app}|${a.site}`;
                        return (
                          <Fragment key={`${a.app}|${a.site}`}>
                            <tr className="row-link" onClick={() => setAppPick(open ? null : `${a.app}|${a.site}`)}>
                              <td><b>{appWord(a.app)}</b>{a.site && <div className="small-muted">{a.site}</div>}</td>
                              <td className="num">{Number(a.keys).toLocaleString('en-IN')}</td>
                              <td className="num">{hmins(a.kbMin)}</td>
                              <td className="num">{Number(a.clicks).toLocaleString('en-IN')}</td>
                              <td className="num">{hmins(a.mouseMin)}</td>
                              <td className="num">{a.speed}/min</td>
                            </tr>
                            {open && <AppKeysDetail id={id} from={from} to={to} app={a.app} site={a.site} onClose={() => setAppPick(null)} />}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </>
              )}
            </Panel>
          )}
          {data.keyCounts && (data.keyCounts.keys.length > 0 || data.keyCounts.mouse.length > 0) && (
            <Panel title="Keys and buttons pressed\" sub={`${data.from === data.to ? 'This day' : `${data.from} to ${data.to}`} · ${Number(data.keyCounts.keyTotal).toLocaleString('en-IN')} key presses · ${Number(data.keyCounts.clickTotal).toLocaleString('en-IN')} clicks. Letter keys and number keys are counted together, never one by one. Click any key or button to see where and when.`}>
              <div className="mon-two">
                <BarList rows={data.keyCounts.keys.slice(0, 15).map((k, i) => ({ key: k.name, label: k.name, value: k.count, onClick: () => setKeyPick(keyPick === k.name ? null : k.name), tone: ['blue', 'violet', 'teal', 'amber', 'green', 'pink', 'slate'][i % 7] }))} format={(n) => `${Number(n).toLocaleString('en-IN')} times`} empty="No key presses recorded." />
                <BarList rows={data.keyCounts.mouse.map((k, i) => ({ key: k.name, label: k.name, value: k.count, onClick: () => setKeyPick(keyPick === k.name ? null : k.name), tone: ['green', 'amber', 'slate', 'teal'][i % 4] }))} format={(n) => `${Number(n).toLocaleString('en-IN')} times`} empty="No clicks recorded." />
              </div>
              {keyPick && <KeyDetail key={`${keyPick}|${from}|${to}`} id={id} from={from} to={to} keyName={keyPick} onClose={() => setKeyPick(null)} />}
            </Panel>
          )}
          {(data.repeats || []).length > 0 && (
            <Panel title="Same key or button over and over" sub="10 minutes or more in a row: a key held down, an auto-clicker, a mouse mover, or input sent by a program. Only the key's name is known, never what was typed. Worth a word with the person - it can also be someone scrolling a long sheet with one key." flush>
              <table className="mon-table">
                <thead><tr><th>When</th><th className="num">Minutes</th><th>What</th><th className="num">Presses / moves</th></tr></thead>
                <tbody>
                  {data.repeats.map((x) => (
                    <tr key={`${x.from}-${x.kind}-${x.key}`}>
                      <td style={{ whiteSpace: 'nowrap' }}>{data.from !== data.to && <div className="small-muted">{x.day}</div>}{`${x.fromTime} – ${x.toTime}`}</td>
                      <td className="num"><b>{x.minutes}</b></td>
                      <td><Pill tone={x.kind === 'key' ? 'amber' : 'red'}>{x.label}</Pill></td>
                      <td className="num">{Number(x.presses || 0).toLocaleString('en-IN')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}
          {!data.timeline && data.perDay.length > 0 && (
            <Panel title="Day by day" flush>
              <table className="mon-table">
                <thead><tr><th>Day</th><th>First</th><th>Last</th><th className="num">Active</th><th className="num">Idle</th><th className="num">Productivity</th></tr></thead>
                <tbody>{data.perDay.map((d) => <tr key={d.day}><td>{d.day}</td><td>{tm(d.first)}</td><td>{tm(d.last)}</td><td className="num">{h(d.activeHours)}</td><td className="num">{h(d.idleHours)}</td><td className="num">{pct(d.productivity)}</td></tr>)}</tbody>
              </table>
            </Panel>
          )}
          <div className="mon-two">
            <Panel title="Most-used apps and websites" sub="By active time · every app is in the full list beside this">
              <BarList showShare rows={data.top10.map((a, i) => ({ key: a.key, label: a.name, value: a.seconds, onClick: () => setAppKey(a.key), tone: ['blue', 'violet', 'teal', 'amber', 'green', 'pink', 'slate', 'blue', 'violet', 'teal'][i] }))} format={dur} empty="No app used in this period." />
            </Panel>
            <Panel title={`All apps and websites (${data.apps.length})`} sub="Everything used in work hours - scroll for all. Click one to see what it was used for." flush>
              <div className="mon-scroll">
                <table className="mon-table">
                  <thead><tr><th>App / website</th><th className="num">Time</th><th>Category</th></tr></thead>
                  <tbody>
                    {data.apps.map((a) => (
                      <tr key={a.key} className="row-link" onClick={() => setAppKey(a.key)} title="See everything it was used for">
                        <td><b>{a.name}</b>{a.kind === 'site' && <span className="small-muted"> · website</span>}{a.topTitles.length > 0 && <div className="small-muted mon-titles">{a.topTitles.map((x) => `${x.title} (${x.minutes ? `${x.minutes} min` : 'under 1 min'})`).join(' · ')}</div>}</td>
                        <td className="num">{dur(a.seconds)}</td>
                        <td>{a.category ? <Pill tone={CAT_TONE[a.category]}>{CAT_WORD[a.category]}</Pill> : <span className="small-muted">Not set</span>}</td>
                      </tr>
                    ))}
                    {!data.apps.length && <tr><td colSpan={3} className="small-muted">No app used in this period.</td></tr>}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>
          {openApp && <AppWork app={openApp} who={data.employee.name} range={data.from === data.to ? data.from : `${data.from} to ${data.to}`} total={t.activeSeconds} onClose={() => setAppKey(null)} />}
        </>
      )}
    </>
  );
}

// Everything one app or website was used for, in one person's period: a summary line, every page / file / chat with its time,
// and the sittings in order (founder 2026-11-10: "overall summary kanipinchali, kaani complete work cover avvali").
const NOT_SHOWN = 'Not shown (the app does not say)';
// THE WORK IN PLAIN WORDS (founder 2026-11-11: "work done lo, vallu em em chesthunnaru in detail ga sum up chesthuu vundali; what was open
// lo, em em open chesaru ani vundali"): Work done opens with a written summary - each piece of work, how long and when - and the table
// under it; What was open stays the list of everything that was open.
function spans(times, when, max = 4) {
  const list = (times || []).map((t) => `${when(t.start)}–${tm(t.end)}`);
  return list.length > max ? `${list.slice(0, max).join(', ')} and ${list.length - max} more` : list.join(', ');
}
function WorkSummary({ app, done, when, total }) {
  const lines = [];
  if (app.teamlinkWork && app.teamlinkWork.lines.length) {
    app.teamlinkWork.lines.forEach((x) => {
      const named = (x.items || []).filter((i) => i.what);
      const eg = named.slice(0, 4).map((i) => `${i.what}${i.change ? ` (${i.change})` : ''}`);
      lines.push({ key: `w${x.area}${x.action}`, head: `${x.action}${x.count > 1 ? ` – ${x.count} times` : ''}`, area: x.area, detail: eg.length ? `${eg.join('; ')}${named.length > 4 ? `; and ${named.length - 4} more` : ''}` : '', at: `${when(x.first)}${x.count > 1 ? ` to ${tm(x.last)}` : ''}` });
    });
  }
  done.forEach((x) => {
    lines.push({ key: `d${x.area}${x.action}`, head: x.action, area: x.area, time: dur(x.seconds), detail: '', at: spans(x.times, when) });
  });
  if (!lines.length) return null;
  const pages = (app.items || []).filter((i) => i.item !== NOT_SHOWN).length;
  return (
    <div className="mon-sumup">
      <div className="mon-sumup-head">
        <b>What {app.teamlinkWork ? 'was done in TeamLink' : `was done in ${app.name}`}</b>
        <span className="small-muted">{dur(app.seconds)}{total ? ` · ${Math.round((app.seconds / total) * 100)}% of the active time` : ''}{pages ? ` · ${pages} ${pages === 1 ? 'thing' : 'different things'} open` : ''}</span>
      </div>
      <ul>
        {lines.slice(0, 25).map((l) => (
          <li key={l.key}>
            <b>{l.head}</b>{l.time && <> – {l.time}</>}{l.area && l.area !== app.name && <span className="small-muted"> · {l.area}</span>}
            {l.detail && <div>{l.detail}</div>}
            {l.at && <div className="small-muted">{l.at}</div>}
          </li>
        ))}
      </ul>
      {lines.length > 25 && <div className="small-muted">and {lines.length - 25} more below.</div>}
    </div>
  );
}

function AppWork({ app, who, range, total, onClose }) {
  const done = app.done || [];
  const [openRow, setOpenRow] = useState({}); // the rows opened to their details
  const toggle = (k) => setOpenRow((o) => ({ ...o, [k]: !o[k] }));
  const [tab, setTab] = useState(app.teamlinkWork && app.teamlinkWork.total ? 'work' : (done.length ? 'done' : 'items'));
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const items = app.items || [];
  const sittings = app.sittings || [];
  const named = items.filter((x) => x.item !== NOT_SHOWN);
  const first = sittings.length ? sittings[0].start : null;
  const last = sittings.length ? sittings[sittings.length - 1].end : null;
  const top = named.slice(0, 3).map((x) => `${x.item} (${dur(x.seconds)})`);
  const max = items.length ? items[0].seconds : 1;
  const oneDay = !range.includes(' to ');
  const when = (x) => (oneDay ? tm(x) : dt(x));
  return (
    <div className="mon-modal" role="dialog" aria-modal="true" aria-label={`${app.name}: what it was used for`} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mon-modal-box">
        <div className="mon-modal-head">
          <div>
            <h3>{app.name}{app.kind === 'site' && <span className="small-muted"> · website</span>} {app.category && <Pill tone={CAT_TONE[app.category]}>{CAT_WORD[app.category]}</Pill>}</h3>
            <div className="small-muted">{who} · {range}</div>
          </div>
          <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
        <div className="mon-summary">
          <b>{dur(app.seconds)}</b> in {app.name}{total ? ` (${Math.round((app.seconds / total) * 100)}% of the active time)` : ''}, in <b>{sittings.length}</b> {sittings.length === 1 ? 'sitting' : 'sittings'}{first && <> from {when(first)} to {when(last)}</>}.
          {app.titlesKnown && named.length > 0 && <> <b>{named.length}</b> different {named.length === 1 ? 'page, file or chat' : 'pages, files or chats'}{top.length ? <>; most time on {top.join(', ')}{named.length > 3 ? <>, and {named.length - 3} more</> : ''}.</> : '.'}</>}
          {!app.titlesKnown && <div className="notice" style={{ marginTop: 8 }}>This app&apos;s window always shows only its own name, so only the time is known, not what was open in it.{/claude/i.test(app.name) ? ' The same work on claude.ai in the browser shows the name of each chat.' : ''}</div>}
        </div>
        <div className="mon-tabs">
          {app.teamlinkWork && <button type="button" className={tab === 'work' ? 'on' : ''} onClick={() => setTab('work')}>Work done in TeamLink ({app.teamlinkWork.total})</button>}
          {!app.teamlinkWork && done.length > 0 && <button type="button" className={tab === 'done' ? 'on' : ''} onClick={() => setTab('done')}>Work done ({done.length})</button>}
          <button type="button" className={tab === 'items' ? 'on' : ''} onClick={() => setTab('items')}>What was opened ({items.length})</button>
          <button type="button" className={tab === 'sittings' ? 'on' : ''} onClick={() => setTab('sittings')}>Hour by hour ({sittings.length})</button>
        </div>
        <div className="mon-modal-body">
          {tab === 'work' && app.teamlinkWork && <WorkSummary app={app} done={[]} when={when} total={total} />}
          {tab === 'work' && app.teamlinkWork && (app.teamlinkWork.lines.length ? (
            <table className="mon-table">
              <thead><tr><th>Area</th><th>What was done</th><th className="num">How many</th><th>First – last</th></tr></thead>
              <tbody>
                {app.teamlinkWork.lines.map((x) => {
                  const k = `w|${x.area}|${x.action}`;
                  return (
                    <Fragment key={k}>
                      <tr className="row-link" onClick={() => toggle(k)} title="See each one">
                        <td>{x.area}</td>
                        <td><span className="mon-caret">{openRow[k] ? '▾' : '▸'}</span> {x.action}{x.items && x.items[0] && x.items[0].what && !openRow[k] && <div className="small-muted mon-item">{x.items.slice(0, 2).map((i) => i.what).filter(Boolean).join(' · ')}{x.items.length > 2 ? ` · +${x.items.length - 2} more` : ''}</div>}</td>
                        <td className="num">{x.count}</td>
                        <td className="small-muted" style={{ whiteSpace: 'nowrap' }}>{when(x.first)} – {when(x.last)}</td>
                      </tr>
                      {openRow[k] && (x.items || []).map((i, n) => (
                        <tr key={`${k}|${n}`} className="mon-sub">
                          <td className="small-muted" style={{ whiteSpace: 'nowrap' }}>{when(i.at)}</td>
                          <td colSpan={3}><b>{i.what || x.action}</b>{i.change && <span> · {i.change}</span>}{i.note && <span className="small-muted"> · {i.note}</span>}</td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          ) : <div className="ak-empty" style={{ padding: 16 }}>Nothing was saved in TeamLink in this period: only pages were looked at.</div>)}
          {tab === 'done' && (
            <>
              <WorkSummary app={app} done={done} when={when} total={total} />
              <div className="small-muted" style={{ padding: '8px 10px 0' }}>Read from the window: which file, page, folder or chat was in front. Click a line for each time it was open. What was typed is never recorded.</div>
              <table className="mon-table">
                <thead><tr><th>Area</th><th>What was done</th><th className="num">Time</th><th className="num" title="How many separate times it was in front">How many</th><th>First – last</th></tr></thead>
                <tbody>
                  {done.map((x) => {
                    const k = `d|${x.area}|${x.action}`;
                    return (
                      <Fragment key={k}>
                        <tr className="row-link" onClick={() => toggle(k)} title="See each time it was open">
                          <td>{x.area}</td>
                          <td className="mon-item"><span className="mon-caret">{openRow[k] ? '▾' : '▸'}</span> {x.action}</td>
                          <td className="num">{dur(x.seconds)}</td>
                          <td className="num">{x.count}</td>
                          <td className="small-muted" style={{ whiteSpace: 'nowrap' }}>{when(x.first)} – {when(x.last)}</td>
                        </tr>
                        {openRow[k] && (x.times || []).map((t, n) => (
                          <tr key={`${k}|${n}`} className="mon-sub">
                            <td />
                            <td className="small-muted" style={{ whiteSpace: 'nowrap' }}>{when(t.start)} – {tm(t.end)}</td>
                            <td className="num small-muted">{dur(t.seconds)}</td>
                            <td colSpan={2} />
                          </tr>
                        ))}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
          {tab === 'items' && (
            <table className="mon-table">
              <thead><tr><th>Page, file or chat</th><th className="num">Time</th><th>First – last</th><th className="num" title="How many separate times it was in front">Times</th></tr></thead>
              <tbody>
                {items.map((x) => (
                  <tr key={x.item}>
                    <td><div className="mon-item">{x.item}</div><div className="mon-item-bar"><i style={{ width: `${Math.max(2, (x.seconds / max) * 100)}%` }} /></div></td>
                    <td className="num">{dur(x.seconds)}</td>
                    <td className="small-muted" style={{ whiteSpace: 'nowrap' }}>{when(x.first)} – {when(x.last)}</td>
                    <td className="num">{x.opened}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {tab === 'sittings' && (
            <table className="mon-table">
              <thead><tr><th>When</th><th className="num">Time</th><th>What was open</th></tr></thead>
              <tbody>
                {sittings.map((x) => (
                  <tr key={String(x.start)}>
                    <td style={{ whiteSpace: 'nowrap' }}>{when(x.start)} – {tm(x.end)}</td>
                    <td className="num">{dur(x.seconds)}</td>
                    <td>{x.items.map((y) => <div key={y.item} className="mon-item">{y.item} <span className="small-muted">({dur(y.seconds)})</span></div>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ App categories
function Categories() {
  const { data, error, reload } = useGet('/monitoring/app-categories');
  const [form, setForm] = useState({ appName: '', kind: 'app', category: 'productive', department: '' });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  async function save(body) {
    setMsg(''); setErr('');
    try { await api.post('/monitoring/app-categories', body); setMsg(`Saved: ${body.appName} is ${CAT_WORD[body.category].toLowerCase()}.`); setForm({ appName: '', kind: 'app', category: 'productive', department: '' }); reload(); } catch (e) { setErr(errOf(e, 'Could not save.')); }
  }
  // every app in the "not marked" list at once
  async function markAll(category) {
    const list = (data && data.uncategorised) || [];
    if (!list.length || !window.confirm(`Mark all ${list.length} as ${CAT_WORD[category]}?`)) return;
    setMsg(''); setErr('');
    try {
      for (const u of list) await api.post('/monitoring/app-categories', { appName: u.appName, kind: 'app', category }); // eslint-disable-line no-await-in-loop
      setMsg(`${list.length} app${list.length === 1 ? '' : 's'} marked ${CAT_WORD[category].toLowerCase()}.`);
    } catch (e) { setErr(errOf(e, 'Could not save all of them.')); }
    reload();
  }
  async function change(row, category) {
    try { await api.put(`/monitoring/app-categories/${row.id}`, { category }); reload(); } catch (e) { setErr(errOf(e, 'Could not save.')); }
  }
  async function remove(row) {
    if (!window.confirm(`Remove the category of ${row.appName}?`)) return;
    try { await api.delete(`/monitoring/app-categories/${row.id}`); reload(); } catch (e) { setErr(errOf(e, 'Could not remove.')); }
  }
  const pick = (value, onChange, label) => (
    <Combo value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="productive">Productive</option><option value="neutral">Neutral</option><option value="unproductive">Unproductive</option>
    </Combo>
  );
  return (
    <>
      {data && !data.canEdit && <div className="notice">You can read these rules. HR changes them.</div>}
      <div className="small-muted" style={{ marginBottom: 8 }}>An <b>app</b> is matched by its name (chrome, excel, winword). A <b>website</b> is a word in the browser&apos;s window title (youtube, naukri, linkedin). A department&apos;s own rule wins over the rule for every department (LinkedIn for Recruitment, Tally for Accounts). The score is the active time in productive apps and websites.</div>
      {data && data.canEdit && <div className="mon-bar">
        <input placeholder="App (excel) or website word (naukri)" value={form.appName} onChange={(e) => setForm({ ...form, appName: e.target.value })} aria-label="App or website" />
        <Combo value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} aria-label="App or website"><option value="app">App</option><option value="site">Website</option></Combo>
        {pick(form.category, (v) => setForm({ ...form, category: v }), 'Category')}
        <Combo value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} aria-label="For which department">
          <option value="">Every department</option>
          {((data && data.departments) || []).map((d) => <option key={d} value={d}>{d}</option>)}
        </Combo>
        <button type="button" className="btn btn-primary btn-sm" disabled={!form.appName.trim()} onClick={() => save(form)}>Add</button>
      </div>}
      {msg && <div className="notice green">{msg}</div>}
      {(err || error) && <div className="notice red">{err || error}</div>}
      <div className="mon-rules">
        <Panel title="Marked apps and websites" sub={data ? `${data.rows.length} rules` : undefined} flush>
          <div className="mon-scroll">
          <table className="mon-table">
            <thead><tr><th>App / website</th><th>Department</th><th>Category</th><th>Set by</th><th /></tr></thead>
            <tbody>
              {((data && data.rows) || []).map((r) => (
                <tr key={r.id}>
                  <td><b>{r.appName}</b><div className="small-muted">{r.kind === 'site' ? 'Website' : 'App'}</div></td>
                  <td>{r.department || 'Every department'}</td>
                  <td>{data.canEdit ? pick(r.category, (v) => change(r, v), `Category of ${r.appName}`) : (CAT_WORD[r.category] || r.category)}</td>
                  <td className="small-muted">{r.setBy || '—'}</td>
                  <td>{data.canEdit && <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove(r)}>Remove</button>}</td>
                </tr>
              ))}
              {data && !data.rows.length && <tr><td colSpan={5} className="small-muted">Nothing marked yet.</td></tr>}
            </tbody>
          </table>
          </div>
        </Panel>
        {data && data.canEdit && <Panel title="Seen in the last 30 days, not marked" sub="An app not marked lowers the score: mark the ones used most" flush>
          {data && data.uncategorised.length > 1 && (
            <div className="mon-markall">
              <span className="small-muted">Mark all as:</span>
              {['productive', 'neutral', 'unproductive'].map((c) => <button key={c} type="button" className="btn btn-sm" onClick={() => markAll(c)}>{CAT_WORD[c]}</button>)}
            </div>
          )}
          <table className="mon-table">
            <thead><tr><th>App</th><th className="num">Active</th><th>Mark as</th></tr></thead>
            <tbody>
              {((data && data.uncategorised) || []).map((u) => (
                <tr key={u.appName}>
                  <td><b>{u.appName}</b></td>
                  <td className="num">{h(u.hours)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {['productive', 'neutral', 'unproductive'].map((c) => <button key={c} type="button" className="btn btn-sm" style={{ marginRight: 4 }} onClick={() => save({ appName: u.appName, kind: 'app', category: c })}>{CAT_WORD[c]}</button>)}
                  </td>
                </tr>
              ))}
              {data && !data.uncategorised.length && <tr><td colSpan={3} className="small-muted">Every app seen is marked.</td></tr>}
            </tbody>
          </table>
        </Panel>}
      </div>
    </>
  );
}

// ------------------------------------------------------------------------------------------------ Reports
function Reports({ onOpen, admin = false }) {
  const [from, setFrom] = useState(addDays(todayIst(), -6));
  const [to, setTo] = useState(todayIst());
  const [department, setDepartment] = useState('');
  const [view, setView] = useState('employee');
  const { data, error, loading } = useGet('/monitoring/reports', { from, to, department, view });
  const rows = (data && data.rows) || [];
  const nums = (r) => (
    <>
      <td className="num">{h(r.activeHours)}</td><td className="num">{h(r.idleHours)}</td><td className="num">{h(r.breakHours)}</td>
      <td className="num">{h(r.productiveHours)}</td><td className="num">{h(r.unproductiveHours)}</td><td className="num">{pct(r.productivity)}</td>
    </>
  );
  const heads = <><th className="num">Active</th><th className="num">Idle</th><th className="num">Break</th><th className="num">Productive</th><th className="num">Unproductive</th><th className="num">Score</th></>;
  return (
    <>
      <RangeBar from={from} to={to} setFrom={setFrom} setTo={setTo}>
        <Combo value={view} onChange={(e) => setView(e.target.value)} aria-label="Report">
          <option value="employee">Per employee</option>
          <option value="daily">Day by day (login, logout)</option>
          <option value="team">Per department</option>
          {admin && <option value="payroll">Payroll reference</option>}
        </Combo>
        <Combo value={department} onChange={(e) => setDepartment(e.target.value)} aria-label="Department">
          <option value="">All departments</option>
          {((data && data.departments) || []).map((d) => <option key={d} value={d}>{d}</option>)}
        </Combo>
        <span style={{ marginLeft: 'auto' }}><ExportMenu url="/monitoring/reports" params={{ from, to, department, view }} label="Export" /></span>
      </RangeBar>
      {view === 'payroll' && <div className="small-muted" style={{ marginBottom: 8 }}>A reference for HR. It deducts nothing: a PC that was off does not prove someone was absent.</div>}
      {error && <div className="notice red">{error}</div>}
      <div className="tbl-wrap">
        <table className="mon-table">
          <thead>
            {view === 'team' && <tr><th>Department</th><th className="num">Employees</th>{heads}</tr>}
            {view === 'daily' && <tr><th>Date</th><th>Employee</th><th>Login</th><th>Logout</th>{heads}</tr>}
            {view === 'employee' && <tr><th>Employee</th><th>Department</th><th className="num">Days</th>{heads}</tr>}
            {view === 'payroll' && <tr><th>Employee</th><th>Department</th><th className="num">Working days</th><th className="num">On PC</th><th className="num">Leave</th><th className="num">Neither</th><th className="num">Active</th><th className="num">Productive</th><th className="num">Idle</th><th className="num">Score</th></tr>}
          </thead>
          <tbody>
            {view === 'team' && rows.map((r) => <tr key={r.key}><td><b>{r.name}</b></td><td className="num">{r.employees}</td>{nums(r)}</tr>)}
            {view === 'daily' && rows.map((r) => <tr key={r.key} className="row-link" onClick={() => onOpen(r.employeeId)}><td style={{ whiteSpace: 'nowrap' }}>{r.day}{r.dayType && <div className="small-muted">{r.dayType}</div>}</td><td><b>{r.name}</b>{r.department && <div className="small-muted">{r.department}</div>}</td><td>{tm(r.login)}</td><td>{tm(r.logout)}</td>{nums(r)}</tr>)}
            {view === 'employee' && rows.map((r) => <tr key={r.key} className="row-link" onClick={() => onOpen(r.employeeId)}><td><b>{r.name}</b>{r.code && <div className="small-muted">{r.code}</div>}</td><td>{r.department || '—'}</td><td className="num">{r.days}</td>{nums(r)}</tr>)}
            {view === 'payroll' && rows.map((r) => <tr key={r.key} className="row-link" onClick={() => onOpen(r.employeeId)}><td><b>{r.name}</b>{r.code && <div className="small-muted">{r.code}</div>}</td><td>{r.department || '—'}</td><td className="num">{r.workingDays}</td><td className="num">{r.pcDays}</td><td className="num">{r.leaveDays}</td><td className="num">{r.noPcDays}</td><td className="num">{h(r.activeHours)}</td><td className="num">{h(r.productiveHours)}</td><td className="num">{h(r.idleHours)}</td><td className="num">{pct(r.productivity)}</td></tr>)}
            {data && !rows.length && !loading && <tr><td colSpan={13} className="small-muted">No activity in these days.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ------------------------------------------------------------------------------------------------ Devices
// ------------------------------------------------------------------------------------------------ Data security (who took data out)
// Who exported candidate / client / requirement / application data, how much, and a bulk pull flagged (founder 2026-11-12: the
// 360-review pick - a recruiter taking the database before leaving). Built from the export audit rows; only counts and scope, never
// the data itself. HR / Admin only.
function DataSecurity() {
  const [from, setFrom] = useState(todayIst());
  const [to, setTo] = useState(todayIst());
  const [q, setQ] = useState('');
  const { data, error, loading } = useGet('/monitoring/data-security', { from, to });
  const big = (data && data.big) || 200;
  const events = ((data && data.events) || []).filter((e) => !q.trim() || `${e.who} ${e.kind} ${e.entity} ${e.scope}`.toLowerCase().includes(q.trim().toLowerCase()));
  const t = (data && data.totals) || {};
  const num = (v) => (v == null ? '—' : Number(v).toLocaleString('en-IN'));
  return (
    <>
      <div className="small-muted" style={{ marginBottom: 8 }}>Who took candidate, client, requirement or application data out as a file, and how much - so a bulk pull of the database (for example a recruiter taking data before leaving) is caught. An export of <b>{big}+ rows at once</b> is flagged as a bulk pull. Only the counts and the scope are shown, never the data itself.</div>
      <RangeBar from={from} to={to} setFrom={setFrom} setTo={setTo}>
        <input type="search" placeholder="Search a name or data" value={q} onChange={(e) => setQ(e.target.value)} />
      </RangeBar>
      {error && <div className="notice red">{error}</div>}
      {loading && !data && <div className="small-muted">Loading…</div>}
      {t.bulk > 0 && (
        <div className="mon-misuse-banner" style={{ cursor: 'default' }}>
          <span className="dot" />
          <span><b>{`${t.bulk} bulk export${t.bulk === 1 ? '' : 's'}`}</b> of {big}+ rows in this period. Check who, below - a large pull of candidate or client data can be someone taking the database out.</span>
        </div>
      )}
      <KpiRow>
        <KpiTile icon="file" tone="blue" label="Exports" value={t.exports != null ? t.exports : '—'} sub="Candidate / client data files" />
        <KpiTile icon="list" tone="violet" label="Rows taken out" value={num(t.rows)} sub="Across all exports" />
        <KpiTile icon="users" tone="slate" label="People exporting" value={t.people != null ? t.people : '—'} sub="Who took data out" />
        <KpiTile icon="alert" tone="red" label="Bulk pulls" value={t.bulk != null ? t.bulk : '—'} sub={`${big}+ rows at once`} />
      </KpiRow>
      <Panel title="Who exported the most" sub="By rows taken out, in this period">
        <table className="mon-table">
          <thead><tr><th>Who</th><th className="num">Exports</th><th className="num">Rows</th><th className="num">Bulk pulls</th></tr></thead>
          <tbody>
            {((data && data.byPerson) || []).slice(0, 20).map((pr, i) => (
              <tr key={i}><td><b>{pr.who}</b></td><td className="num">{pr.exports}</td><td className="num">{num(pr.rows)}</td><td className="num">{pr.bulk ? <Pill tone="red">{pr.bulk}</Pill> : <span className="small-muted">—</span>}</td></tr>
            ))}
            {(!data || !(data.byPerson || []).length) && !loading && <tr><td colSpan={4} className="small-muted">No candidate or client data was exported in this period.</td></tr>}
          </tbody>
        </table>
      </Panel>
      <Panel title={`Every export (${events.length})`} sub="Newest first; a bulk pull is in red">
        <div className="mon-scroll">
          <table className="mon-table">
            <thead><tr><th>When</th><th>Who</th><th>Data</th><th>Format</th><th className="num">Rows</th><th>Scope</th></tr></thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{dt(e.at)}</td>
                  <td><b>{e.who}</b></td>
                  <td>{e.kind || e.entity}<div className="small-muted">{e.entity}</div></td>
                  <td>{e.format || '—'}</td>
                  <td className="num">{e.rows == null ? '—' : (e.bulk ? <Pill tone="red">{num(e.rows)}</Pill> : num(e.rows))}</td>
                  <td className="small-muted">{e.scope || '—'}</td>
                </tr>
              ))}
              {!events.length && !loading && <tr><td colSpan={6} className="small-muted">No exports match.</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

// ------------------------------------------------------------------------------------------------ Agent versions
// Which TeamLink agent each office PC is on, who is behind the latest, and who has not reported one (founder 2026-11-12, a rating
// follow-up: the "who is on which version" central view that was missing). PCs update themselves on the next connection; a restart
// makes it happen now. Reuses GET /monitoring/devices (it already carries agentVersion, outdated and online).
function AgentVersions() {
  const { data, error, loading } = useGet('/monitoring/devices');
  const latest = data && data.latestAgent;
  const active = ((data && data.rows) || []).filter((d) => d.isActive !== false);
  const withVer = active.filter((d) => d.agentVersion);
  const upToDate = withVer.filter((d) => !d.outdated).length;
  const behind = withVer.filter((d) => d.outdated);
  const noReport = active.filter((d) => !d.agentVersion).length;
  const online = active.filter((d) => d.online).length;
  const byVer = new Map();
  active.forEach((d) => { const v = d.agentVersion || 'Not reported'; byVer.set(v, (byVer.get(v) || 0) + 1); });
  const verRows = [...byVer.entries()].sort((a, b) => {
    if (a[0] === 'Not reported') return 1;
    if (b[0] === 'Not reported') return -1;
    return a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0; // newest version first
  });
  const behindSorted = [...behind].sort((a, b) => String(a.agentVersion).localeCompare(String(b.agentVersion)) || String((a.employee || {}).name || '').localeCompare(String((b.employee || {}).name || '')));
  return (
    <>
      <div className="small-muted" style={{ marginBottom: 8 }}>Which TeamLink agent each office PC is on. The latest is <b>{latest || '—'}</b>. A PC updates itself the next time it connects; a restart makes it update now. The PCs behind the latest are listed below, so you know who to ask to restart.</div>
      {error && <div className="notice red">{error}</div>}
      {loading && !data && <div className="small-muted">Loading…</div>}
      <KpiRow>
        <KpiTile icon="check" tone="green" label="Up to date" value={upToDate} sub={`On the latest (${latest || '—'})`} />
        <KpiTile icon="alert" tone="amber" label="Behind" value={behind.length} sub="An older agent - ask them to restart" />
        <KpiTile icon="x" tone="slate" label="Not reported" value={noReport} sub="No version seen yet" />
        <KpiTile icon="users" tone="blue" label="Online now" value={online} sub={`of ${active.length} PC${active.length === 1 ? '' : 's'}`} />
      </KpiRow>
      <Panel title="By version" sub="Every active PC, newest agent first">
        <BarList rows={verRows.map(([v, n]) => ({ key: v, label: v === latest ? `${v} (latest)` : v, value: n, tone: v === latest ? 'green' : v === 'Not reported' ? 'slate' : 'amber' }))} format={(n) => `${n} PC${n === 1 ? '' : 's'}`} />
      </Panel>
      <Panel title={`PCs behind the latest (${behind.length})`} sub="They update on the next connection; a restart does it now">
        {behindSorted.length ? (
          <div className="tbl-wrap">
            <table className="mon-table">
              <thead><tr><th>Employee</th><th>PC</th><th>Agent</th><th>Last seen</th><th>Status</th></tr></thead>
              <tbody>
                {behindSorted.map((d) => (
                  <tr key={d.id}>
                    <td><b>{d.employee ? d.employee.name : '—'}</b>{d.employee && d.employee.employeeCode && <div className="small-muted">{d.employee.employeeCode}{d.employee.department ? ` · ${d.employee.department}` : ''}</div>}</td>
                    <td>{d.deviceName || '—'}</td>
                    <td><Pill tone="amber">{d.agentVersion || '—'}</Pill></td>
                    <td style={{ whiteSpace: 'nowrap' }}>{d.lastSeenAt ? dt(d.lastSeenAt) : '—'}</td>
                    <td>{d.online ? <Pill tone="green">Online</Pill> : <span className="small-muted">Offline</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="small-muted">{withVer.length ? 'Every PC is on the latest agent.' : 'No PC has reported a version yet.'}</div>}
      </Panel>
    </>
  );
}

// ------------------------------------------------------------------------------------------------ Devices
// Reassign a PC to whoever uses it now (founder 2026-11-13): search the person, confirm; future activity records under them.
function ReassignModal({ device, onClose, onDone }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (q.trim().length < 2) { setRows([]); return undefined; }
    let live = true;
    const t = setTimeout(() => { api.get('/monitoring/people', { params: { q: q.trim() } }).then((r) => { if (live) setRows(r.data.rows || []); }).catch(() => { if (live) setRows([]); }); }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  const pick = async (emp) => {
    if (!window.confirm(`Reassign ${device.deviceName} to ${emp.name}?

From now its activity records under ${emp.name}, not ${device.employee ? device.employee.name : 'the current person'}. Past days stay as they are, and ${emp.name} is asked to accept the monitoring notice on the PC.`)) return;
    setBusy(true); setErr('');
    try { const r = await api.put(`/monitoring/devices/${device.id}/reassign`, { employeeId: emp.id }); onDone(r.data.message); } catch (e) { setErr(errOf(e, 'Could not reassign this PC.')); setBusy(false); }
  };
  return (
    <div className="mon-modal-back" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="mon-modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 6px' }}>Reassign {device.deviceName}</h3>
        <div className="small-muted">Now recording under <b>{device.employee ? device.employee.name : '—'}</b>. Pick the person who uses this PC now - its future activity records under them. Past days are unchanged.</div>
        <input autoFocus type="search" placeholder="Search a name or code" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%', marginTop: 10, boxSizing: 'border-box' }} />
        {err && <div className="notice red">{err}</div>}
        <div className="mon-scroll" style={{ maxHeight: 240, marginTop: 8 }}>
          {rows.map((emp) => (
            <button type="button" key={emp.id} className="mon-pick" disabled={busy} onClick={() => pick(emp)}>
              <b>{emp.name}</b> <span className="small-muted">{emp.employeeCode}{emp.department ? ` · ${emp.department}` : ''}</span>
            </button>
          ))}
          {q.trim().length >= 2 && !rows.length && <div className="small-muted" style={{ padding: 8 }}>No one matches.</div>}
          {q.trim().length < 2 && <div className="small-muted" style={{ padding: 8 }}>Type at least 2 letters to find the person.</div>}
        </div>
        <div style={{ marginTop: 10, textAlign: 'right' }}><button type="button" className="btn btn-sm" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

function Devices({ manage = false }) {
  const [reassign, setReassign] = useState(null);
  const { data, error, reload } = useGet('/monitoring/devices');
  const [msg, setMsg] = useState('');
  async function off(d) {
    if (!window.confirm(`Stop ${d.deviceName}${manage && d.employee ? ` (${d.employee.name})` : ''} from sending activity?`)) return;
    try { const r = await api.put(`/monitoring/devices/${d.id}/deactivate`); setMsg(r.data.message); reload(); } catch (e) { setMsg(errOf(e, 'Could not switch it off.')); }
  }
  async function approve(d) {
    try { const r = await api.put(`/monitoring/devices/${d.id}/approve`); setMsg(r.data.message); reload(); } catch (e) { setMsg(errOf(e, 'Could not approve it.')); }
  }
  async function switchOn(d) {
    try { const r = await api.put(`/monitoring/devices/${d.id}/reactivate`); setMsg(r.data.message); reload(); } catch (e) { setMsg(errOf(e, 'Could not switch it on.')); }
  }
  const rows = (data && data.rows) || [];
  const canAct = !manage || (data && data.canManage);
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const [stat, setStat] = useState('');
  const statusOf = (d) => (!d.isActive ? 'Switched off' : d.approved === false ? 'Waiting for approval' : d.online ? 'Online' : 'Offline');
  const depts = [...new Set(rows.map((d) => d.employee && d.employee.department).filter(Boolean))].sort();
  const shown = rows.filter((d) => (!q.trim() || `${(d.employee && d.employee.name) || ''} ${(d.employee && d.employee.employeeCode) || ''} ${d.deviceName || ''} ${(d.employee && d.employee.department) || ''}`.toLowerCase().includes(q.trim().toLowerCase())) && (!dept || (d.employee && d.employee.department) === dept) && (!stat || statusOf(d) === stat));
  return (
    <>
      {msg && <div className="notice">{msg}</div>}
      {error && <div className="notice red">{error}</div>}
      {data && manage && <div className="small-muted" style={{ marginBottom: 8 }}>{`Latest agent: ${data.latestAgent}. PCs update themselves unless that is switched off in Settings.`}{!data.canManage && ' You can look at PCs here; the Super Admin, Admin or IT Admin act on them.'}</div>}
      {manage && rows.length > 0 && (
        <div className="mon-bar">
          <input type="search" placeholder="Search a name, code or PC" value={q} onChange={(e) => setQ(e.target.value)} />
          {depts.length > 1 && (
            <Combo value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department">
              <option value="">All departments</option>
              {depts.map((d) => <option key={d} value={d}>{d}</option>)}
            </Combo>
          )}
          <Combo value={stat} onChange={(e) => setStat(e.target.value)} aria-label="Status">
            <option value="">All statuses</option>
            {['Online', 'Offline', 'Waiting for approval', 'Switched off'].map((x) => <option key={x} value={x}>{x}</option>)}
          </Combo>
          <span className="small-muted">{`${shown.length} of ${rows.length} PC${rows.length === 1 ? '' : 's'}`}</span>
        </div>
      )}
      <div className="tbl-wrap">
        <table className="mon-table">
          <thead><tr>{manage && <th>Employee</th>}<th>PC</th><th>System</th><th>Agent</th><th>Registered</th><th>Last seen</th><th>Status</th><th /></tr></thead>
          <tbody>
            {shown.map((d) => (
              <tr key={d.id}>
                {manage && <td><b>{d.employee ? d.employee.name : '—'}</b>{d.employee && d.employee.department && <div className="small-muted">{d.employee.department}</div>}</td>}
                <td>{d.deviceName}</td>
                <td className="small-muted">{d.os || '—'}</td>
                <td className="small-muted">{d.agentVersion || '—'}{d.outdated && <div><Pill tone="amber">Update due</Pill></div>}</td>
                <td>{dt(d.registeredAt)}</td>
                <td>{dt(d.lastSeenAt)}</td>
                <td>{!d.isActive ? <Pill tone="slate">Switched off</Pill> : d.approved === false ? <Pill tone="amber">Waiting for approval</Pill> : d.online ? <Pill tone="green">Online</Pill> : <Pill tone="amber">Offline</Pill>}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {!d.isActive && manage && data.canManage && <><button type="button" className="btn btn-sm btn-primary" onClick={() => switchOn(d)}>Switch on</button>{' '}</>}
                  {d.isActive && d.approved === false && data.canManage && <><button type="button" className="btn btn-sm btn-primary" onClick={() => approve(d)}>Approve</button>{' '}</>}
                  {manage && data.canManage && <>{' '}<button type="button" className="btn btn-sm" onClick={() => setReassign(d)}>Reassign</button></>}
                  {d.isActive && canAct && <>{' '}<button type="button" className="btn btn-sm" onClick={() => off(d)}>Deactivate</button></>}
                </td>
              </tr>
            ))}
            {data && !shown.length && <tr><td colSpan={manage ? 8 : 7} className="small-muted">{rows.length ? 'No PC matches these filters.' : 'No PC registered yet.'}</td></tr>}
          </tbody>
        </table>
      </div>
      {reassign && <ReassignModal device={reassign} onClose={() => setReassign(null)} onDone={(m) => { setReassign(null); setMsg(m); reload(); }} />}
    </>
  );
}

// ------------------------------------------------------------------------------------------------ Setting up a PC (Settings, My activity)
// A one-time code to type into the agent instead of a password. HR / Admin pick the employee; anyone else gets their own.
function SetUpCode({ pick = false }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);
  const [who, setWho] = useState(null);
  const [out, setOut] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!pick || q.trim().length < 2 || (who && who.name === q)) { setFound([]); return undefined; }
    const t = setTimeout(() => { api.get('/monitoring/people', { params: { q } }).then((r) => setFound(r.data.rows || [])).catch(() => setFound([])); }, 250);
    return () => clearTimeout(t);
  }, [q, pick]); // eslint-disable-line react-hooks/exhaustive-deps
  async function make() {
    setErr(''); setOut(null);
    try { const r = await api.post('/monitoring/setup-code', pick ? { employeeId: who.id } : {}); setOut(r.data); } catch (e) { setErr(errOf(e, 'Could not make a code.')); }
  }
  return (
    <div className="mon-code">
      <b>Set-up code</b>
      <div className="small-muted">{pick ? 'No password needed: make a code for the employee and type it into the agent.' : 'No password needed: type this code into the agent.'} One use, 30 minutes.</div>
      {pick && (
        <div className="mon-bar" style={{ margin: '8px 0 0' }}>
          <input type="search" placeholder="Search the employee's name or code" value={q} onChange={(e) => { setQ(e.target.value); setWho(null); setOut(null); }} aria-label="Employee" />
        </div>
      )}
      {pick && found.length > 0 && !who && (
        <ul className="mon-pick">
          {found.map((e) => <li key={e.id}><button type="button" className="btn btn-sm btn-ghost" onClick={() => { setWho(e); setQ(e.name); setFound([]); }}>{e.name}<span className="small-muted">{[e.employeeCode, e.department].filter(Boolean).map((x) => ` · ${x}`).join('')}</span></button></li>)}
        </ul>
      )}
      <button type="button" className="btn" style={{ marginTop: 8 }} disabled={pick && !who} onClick={make}>{pick ? 'Make the code' : 'Get my code'}</button>
      {err && <div className="notice red" style={{ marginTop: 8 }}>{err}</div>}
      {out && <div className="mon-code-box"><span>{out.code}</span><div className="small-muted">{`For ${out.employee}. The employee reads and accepts the notice themself on the PC.`}</div></div>}
    </div>
  );
}

// The download is the .cmd. Windows Defender quarantines the unsigned .exe as a Trojan (2026-11-05): it comes back only once it is code signed.
function SetUpPc({ pick = false }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function download() {
    setBusy(true); setErr('');
    try {
      const r = await api.get('/monitoring/agent', { responseType: 'blob' });
      const href = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = href; a.download = 'TeamLinkMonitorSetup.cmd'; document.body.appendChild(a); a.click();
      a.remove(); setTimeout(() => URL.revokeObjectURL(href), 2000);
    } catch { setErr('Could not download the file. Please try again.'); } finally { setBusy(false); }
  }
  return (
    <Panel title="Setting up an office PC" sub="Windows only. Takes about a minute on each PC.">
      <ol className="mon-steps">
        <li>On the office PC, sign in to TeamLink and press <b>Download the PC agent</b>. If the browser warns about the file, choose <b>Keep</b>.</li>
        <li>Double-click the downloaded file <b>TeamLinkMonitorSetup.cmd</b>. If Windows shows a blue box, press <b>More info</b> → <b>Run anyway</b>. No admin rights are needed.</li>
        <li>Type the <b>set-up code</b> below into the agent, or sign in with the employee&apos;s own TeamLink email and password.</li>
        <li>The employee reads the notice and accepts it.</li>
        <li>Done. A TeamLink icon stays next to the clock, it starts with Windows, and the PC appears under <b>Devices</b>.</li>
      </ol>
      <button type="button" className="btn btn-primary" style={{ marginTop: 10 }} disabled={busy} onClick={download}>{busy ? 'Downloading…' : 'Download the PC agent'}</button>
      {err && <div className="notice red" style={{ marginTop: 8 }}>{err}</div>}
      <SetUpCode pick={pick} />
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ Other rules for a department or an employee
function EmployeePick({ onPick }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);
  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return undefined; }
    const t = setTimeout(() => { api.get('/monitoring/people', { params: { q } }).then((r) => setFound(r.data.rows || [])).catch(() => setFound([])); }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <>
      <div className="mon-bar" style={{ margin: '8px 0 0' }}><input type="search" placeholder="Search the employee's name or code" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Employee" /></div>
      {found.length > 0 && (
        <ul className="mon-pick">
          {found.map((e) => <li key={e.id}><button type="button" className="btn btn-sm btn-ghost" onClick={() => { onPick(e); setQ(''); setFound([]); }}>{e.name}<span className="small-muted">{[e.employeeCode, e.department].filter(Boolean).map((x) => ` · ${x}`).join('')}</span></button></li>)}
        </ul>
      )}
    </>
  );
}

const EMPTY_RULE = { scope: 'department', target: '', who: '', workStart: '', workEnd: '', breakStart: '', breakEnd: '', idleThresholdMinutes: '', noTitles: false, excluded: false };
function Overrides() {
  const { data, reload } = useGet('/monitoring/overrides');
  const cats = useGet('/monitoring/app-categories');
  const [form, setForm] = useState(EMPTY_RULE);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const night = form.workStart && form.workEnd && form.workStart > form.workEnd;
  async function save() {
    setErr('');
    try {
      await api.post('/monitoring/overrides', { ...form, trackTitles: form.noTitles ? false : null });
      setForm(EMPTY_RULE); reload();
    } catch (e) { setErr(errOf(e, 'Could not save.')); }
  }
  async function remove(r) {
    if (!window.confirm(`Remove the rules for ${r.label}?`)) return;
    try { await api.delete(`/monitoring/overrides/${r.id}`); reload(); } catch (e) { setErr(errOf(e, 'Could not remove.')); }
  }
  const rows = (data && data.rows) || [];
  return (
    <Panel title="Other rules for a department or an employee" sub="Anything left empty stays as above. An employee's own rules win over their department's. If work ends after midnight it is a night shift, and it counts as the day it started.">
      <div className="mon-bar">
        <Combo value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value, target: '', who: '' })} aria-label="For"><option value="department">Department</option><option value="employee">Employee</option></Combo>
        {form.scope === 'department'
          ? <Combo value={form.target} onChange={set('target')} aria-label="Department"><option value="">Pick the department</option>{((cats.data && cats.data.departments) || []).map((d) => <option key={d} value={d}>{d}</option>)}</Combo>
          : (form.who ? <span className="mon-tag">{form.who} <button type="button" aria-label="Pick another employee" onClick={() => setForm({ ...form, target: '', who: '' })}>×</button></span> : null)}
      </div>
      {form.scope === 'employee' && !form.who && <EmployeePick onPick={(e) => setForm({ ...form, target: e.id, who: e.name })} />}
      <div className="mon-grid mon-grid-4" style={{ marginTop: 8 }}>
        <label>Work starts <input type="time" value={form.workStart} onChange={set('workStart')} /></label>
        <label>Work ends <input type="time" value={form.workEnd} onChange={set('workEnd')} /></label>
        <label>Break starts <input type="time" value={form.breakStart} onChange={set('breakStart')} /></label>
        <label>Break ends <input type="time" value={form.breakEnd} onChange={set('breakEnd')} /></label>
        <label>Idle after (minutes) <input type="number" min={1} max={60} value={form.idleThresholdMinutes} onChange={set('idleThresholdMinutes')} /></label>
      </div>
      {night && <div className="notice">This is a night shift: it ends the next morning.</div>}
      <div className="mon-checks">
        <label className="mon-check"><input type="checkbox" checked={form.noTitles} onChange={(e) => setForm({ ...form, noTitles: e.target.checked })} /> App names only, no window titles</label>
        <label className="mon-check"><input type="checkbox" checked={form.excluded} onChange={(e) => setForm({ ...form, excluded: e.target.checked })} /> Do not monitor at all</label>
      </div>
      {err && <div className="notice red">{err}</div>}
      <button type="button" className="btn" style={{ marginTop: 8 }} disabled={!form.target} onClick={save}>Save these rules</button>
      {rows.length > 0 && (
        <table className="mon-table" style={{ marginTop: 12 }}>
          <thead><tr><th>For</th><th>Work</th><th>Break</th><th>Idle after</th><th>Other</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><b>{r.label}</b><div className="small-muted">{r.scope === 'employee' ? 'Employee' : 'Department'}</div></td>
                <td>{r.workStart ? `${r.workStart} to ${r.workEnd}${r.workStart > r.workEnd ? ' (night)' : ''}` : '—'}</td>
                <td>{r.breakStart ? `${r.breakStart} to ${r.breakEnd}` : '—'}</td>
                <td>{r.idleThresholdMinutes ? `${r.idleThresholdMinutes} min` : '—'}</td>
                <td>{[r.excluded && 'Not monitored', r.trackTitles === false && 'App names only'].filter(Boolean).join(', ') || '—'}</td>
                <td><button type="button" className="btn btn-sm btn-ghost" onClick={() => remove(r)}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ Settings
function Settings() {
  const { data, error } = useGet('/monitoring/settings');
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setForm(data.canEdit ? { workStart: data.workStart, workEnd: data.workEnd, breakStart: data.breakStart || '', breakEnd: data.breakEnd || '', idleThresholdMinutes: data.idleThresholdMinutes, retentionDays: data.retentionDays, policyText: data.policyText, alertsEnabled: !!data.alertsEnabled, longIdleMinutes: data.longIdleMinutes, offlineMinutes: data.offlineMinutes, lowActivityHours: data.lowActivityHours, unauthorizedApps: data.unauthorizedApps || '', alertEmail: !!data.alertEmail, trackTitles: data.trackTitles !== false, reportEnabled: !!data.reportEnabled, reportFrequency: data.reportFrequency || 'daily', reportEmails: data.reportEmails || '', autoUpdate: data.autoUpdate !== false, deviceApproval: !!data.deviceApproval, itAdminIds: data.itAdminIds || '' } : { autoUpdate: data.autoUpdate !== false, deviceApproval: !!data.deviceApproval }); }, [data]);
  const [itPeople, setItPeople] = useState([]);
  useEffect(() => { if (data && data.itAdmins) setItPeople(data.itAdmins); }, [data]);
  if (error) return <div className="notice red">{error}</div>;
  if (!form) return <div className="small-muted">Loading…</div>;
  async function save() {
    setBusy(true); setMsg(''); setErr('');
    try { const r = await api.put('/monitoring/settings', form); setMsg(r.data.message || 'Saved.'); } catch (e) { setErr(errOf(e, 'Could not save.')); } finally { setBusy(false); }
  }
  const check = (k, label) => <label className="mon-check"><input type="checkbox" checked={!!form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.checked })} /> {label}</label>;
  const agentPanel = (
    <Panel title="PC agents" sub={data.canAgent ? 'For the Super Admin, Admin and IT Admin.' : 'The Super Admin, Admin or IT Admin changes these.'}>
      <div className="mon-checks">
        <fieldset disabled={!data.canAgent} className="mon-plain">
          {check('autoUpdate', 'PCs update the agent by themselves')}
          {check('deviceApproval', 'A new PC counts only after it is approved under Devices')}
        </fieldset>
      </div>
      {data.canChooseIt && data.canEdit && (
        <div style={{ marginTop: 10 }}>
          <b>IT Admins</b>
          <div className="small-muted">They manage PCs and agents, and they see nobody's activity.</div>
          <div className="mon-tags">
            {itPeople.map((p) => <span key={p.id} className="mon-tag">{p.name} <button type="button" aria-label={`Remove ${p.name}`} onClick={() => { const next = itPeople.filter((x) => x.id !== p.id); setItPeople(next); setForm({ ...form, itAdminIds: next.map((x) => x.id).join(',') }); }}>×</button></span>)}
            {!itPeople.length && <span className="small-muted">Nobody yet.</span>}
          </div>
          <EmployeePick onPick={(e) => { const next = [...itPeople.filter((x) => x.id !== e.id), e]; setItPeople(next); setForm({ ...form, itAdminIds: next.map((x) => x.id).join(',') }); }} />
        </div>
      )}
    </Panel>
  );
  const foot = (
    <>
      {msg && <div className="notice green">{msg}</div>}
      {err && <div className="notice red">{err}</div>}
      <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
    </>
  );
  if (!data.canEdit) return <div className="mon-settings">{agentPanel}{data.canAgent && foot}<SetUpPc /></div>;
  return (
    <div className="mon-settings">
      <Panel title="Work hours and records">
        <div className="mon-grid">
          <label>Work starts <input type="time" value={form.workStart} onChange={(e) => setForm({ ...form, workStart: e.target.value })} /></label>
          <label>Work ends <input type="time" value={form.workEnd} onChange={(e) => setForm({ ...form, workEnd: e.target.value })} /></label>
          <label>Lunch break starts <input type="time" value={form.breakStart} onChange={(e) => setForm({ ...form, breakStart: e.target.value })} /></label>
          <label>Lunch break ends <input type="time" value={form.breakEnd} onChange={(e) => setForm({ ...form, breakEnd: e.target.value })} /></label>
          <label>Idle after (minutes with no mouse or keyboard) <input type="number" min={1} max={60} value={form.idleThresholdMinutes} onChange={(e) => setForm({ ...form, idleThresholdMinutes: e.target.value })} /></label>
          <label>Keep records for (days) <input type="number" min={7} max={730} value={form.retentionDays} onChange={(e) => setForm({ ...form, retentionDays: e.target.value })} /></label>
        </div>
        {check('trackTitles', 'Record window titles (off: app names only, and websites cannot be told apart)')}
        <div className="small-muted">Only work hours (India time) are recorded; anything outside them is thrown away. The lunch break counts as Break, not idle, and keeps no app details. Older records are deleted by themselves. Screenshots: <b>off</b> - TeamLink never takes screenshots or reads what is typed.</div>
      </Panel>
      <Panel title="Alerts" sub="Sent to the team lead and HR by the bell, each kind at most once a day per person. Never on leave, holidays, or during lunch.">
        <label className="mon-check"><input type="checkbox" checked={form.alertsEnabled} onChange={(e) => setForm({ ...form, alertsEnabled: e.target.checked })} /> Send alerts</label>
        <div className="mon-grid" style={{ marginTop: 8 }}>
          <label>Long idle after (minutes) <input type="number" min={5} max={240} value={form.longIdleMinutes} onChange={(e) => setForm({ ...form, longIdleMinutes: e.target.value })} /></label>
          <label>No signal after (minutes) <input type="number" min={5} max={240} value={form.offlineMinutes} onChange={(e) => setForm({ ...form, offlineMinutes: e.target.value })} /></label>
          <label>Low activity under (hours in a day) <input type="number" min={1} max={12} value={form.lowActivityHours} onChange={(e) => setForm({ ...form, lowActivityHours: e.target.value })} /></label>
          <label>Unauthorized apps and websites (commas between them) <input value={form.unauthorizedApps} onChange={(e) => setForm({ ...form, unauthorizedApps: e.target.value })} placeholder="netflix, steam" /></label>
        </div>
        {check('alertEmail', 'Send them by mail too (needs company mail connected)')}
      </Panel>
      <Panel title="Report by mail" sub="A summary after work, about 7 pm, with the table attached. Goes only to the addresses here.">
        {check('reportEnabled', 'Send the report')}
        <div className="mon-grid" style={{ marginTop: 8 }}>
          <label>How often <Combo value={form.reportFrequency} onChange={(e) => setForm({ ...form, reportFrequency: e.target.value })} aria-label="How often"><option value="daily">Every working day</option><option value="weekly">Every Saturday, for the week</option></Combo></label>
          <label>To <input value={form.reportEmails} onChange={(e) => setForm({ ...form, reportEmails: e.target.value })} placeholder="hr@company.com, founder@company.com" /></label>
        </div>
      </Panel>
      <Overrides />
      {agentPanel}
      <Panel title={`Consent notice (version ${data.policyVersion})`} sub="Every employee reads and accepts this before anything is recorded. Changing it makes a new version that everyone accepts again.">
        <textarea rows={10} value={form.policyText} onChange={(e) => setForm({ ...form, policyText: e.target.value })} aria-label="Consent notice" style={{ width: '100%' }} />
      </Panel>
      <SetUpPc pick />
      {foot}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ My activity
function Mine({ me }) {
  const d = me.data;
  const [msg, setMsg] = useState('');
  async function accept() {
    try { const r = await api.post('/monitoring/me/consent', { policyVersion: d.settings.policyVersion }); setMsg(r.data.message); me.reload(); } catch (e) { setMsg(errOf(e, 'Could not save.')); }
  }
  if (!d.hasEmployee) return <div className="notice">Your login has no employee record, so nothing is recorded for you.</div>;
  const last = d.consents[0];
  return (
    <>
      <Panel title="The monitoring notice" sub={d.accepted ? `You accepted version ${d.settings.policyVersion}${last ? ` on ${dt(last.acceptedAt)}` : ''}.` : 'You have not accepted the current notice. Nothing is recorded on your PC until you do.'}>
        <div className="mon-policy">{d.policyText}</div>
        {!d.accepted && <button type="button" className="btn btn-primary" style={{ marginTop: 10 }} onClick={accept}>I have read it and I accept</button>}
        {msg && <div className="notice" style={{ marginTop: 8 }}>{msg}</div>}
      </Panel>
      <h3 className="mon-h3">My activity</h3>
      <EmployeeDetail id="me" own />
      <h3 className="mon-h3">My PCs</h3>
      <Devices />
      <div style={{ marginTop: 14 }}><SetUpPc /></div>
    </>
  );
}
