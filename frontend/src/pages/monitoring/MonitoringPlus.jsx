import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Combo from '../../components/Combo.jsx';
import { Panel, Pill } from '../../components/atskit/AtsKit.jsx';

// ---------------------------------------------------------------------------
// EMPLOYEE MONITORING - OVERTIME, TRENDS, ALERT RULES (founder 2026-11-26; backend utils/monitoringPlus.js).
//   Overtime     work just outside work hours (app name + in use / idle only), per person, with their days.
//   Trends       week-by-week lines (active hours a day, productive %, idle hours a day, overtime) next to the company average.
//   Alert rules  HR's own rules ("YouTube over 30 minutes a day", "working after 21:00" ...) and the overtime window.
// ---------------------------------------------------------------------------
const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
const tm = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }) : '—');
const hm = (h) => { const m = Math.round((Number(h) || 0) * 60); return m ? `${Math.floor(m / 60)}h ${m % 60}m` : '—'; };
const errOf = (e, f) => (e && e.response && e.response.data && e.response.data.error) || f;

function useGet(url, params) {
  const [st, setSt] = useState({ data: null, error: '', loading: true });
  const load = useCallback(() => {
    setSt((s) => ({ ...s, loading: true, error: '' }));
    api.get(url, params ? { params } : undefined)
      .then((r) => setSt({ data: r.data, error: '', loading: false }))
      .catch((e) => setSt({ data: null, error: errOf(e, 'Could not load this.'), loading: false }));
  }, [url, JSON.stringify(params || {})]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [load]);
  return { ...st, reload: load };
}
function Range({ from, to, setFrom, setTo, children }) {
  const t = todayIst();
  return (
    <div className="mon-bar">
      <label>From <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
      <label>To <input type="date" value={to} min={from} max={t} onChange={(e) => setTo(e.target.value)} /></label>
      <button type="button" className="btn btn-sm" onClick={() => { setFrom(t); setTo(t); }}>Today</button>
      <button type="button" className="btn btn-sm" onClick={() => { setFrom(addDays(t, -6)); setTo(t); }}>Week</button>
      <button type="button" className="btn btn-sm" onClick={() => { setFrom(`${t.slice(0, 7)}-01`); setTo(t); }}>This month</button>
      {children}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ Overtime
export function Overtime({ onOpen }) {
  const [from, setFrom] = useState(addDays(todayIst(), -6));
  const [to, setTo] = useState(todayIst());
  const [open, setOpen] = useState(null);
  const { data, error } = useGet('/monitoring/overtime', { from, to });
  const detail = useGet('/monitoring/overtime', open ? { from, to, employeeId: open } : { from, to, employeeId: '__none__' });
  const s = data && data.settings;
  const rows = (data && data.rows) || [];
  return (
    <>
      <div className="small-muted" style={{ marginBottom: 8 }}>
        Work done just outside work hours{s ? ` (up to ${s.beforeMinutes} min before and ${s.afterMinutes / 60} h after)` : ''}: only the app name and whether the PC was in use are kept.
        It needs agent 3.5 on the PC and the person to have accepted the updated notice. {s && !s.enabled && <b>Overtime is switched off in Alert rules.</b>}
      </div>
      <Range from={from} to={to} setFrom={setFrom} setTo={setTo} />
      {error && <div className="notice red">{error}</div>}
      <div className="tbl-wrap">
        <table className="mon-table">
          <thead><tr><th>Employee</th><th>Department</th><th>Days with overtime</th><th>Overtime (in use)</th><th>Idle in overtime</th><th>Latest finish</th><th>Mostly in</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.employeeId} className="row-link" onClick={() => setOpen(open === r.employeeId ? null : r.employeeId)}>
                <td><b>{r.name}</b>{r.code && <div className="small-muted">{r.code}</div>}</td>
                <td>{r.department || '—'}</td>
                <td>{r.daysWithOvertime}</td>
                <td><b>{hm(r.activeHours)}</b></td>
                <td className="small-muted">{hm(r.idleHours)}</td>
                <td>{tm(r.latestEnd)}</td>
                <td className="small-muted">{(r.topApps || []).slice(0, 3).map((a) => `${a.name} ${a.minutes}m`).join(' · ') || '—'}</td>
              </tr>
            ))}
            {data && !rows.length && <tr><td colSpan={7} className="small-muted">No overtime in these days.</td></tr>}
          </tbody>
        </table>
      </div>
      {open && detail.data && detail.data.rows && detail.data.rows[0] && (
        <Panel title={`${detail.data.rows[0].name}: overtime by day`} action={onOpen ? { label: 'Open their activity', onClick: () => onOpen(open) } : null}>
          <div className="tbl-wrap">
            <table className="mon-table">
              <thead><tr><th>Day</th><th>From</th><th>To</th><th>In use</th><th>Idle</th><th>Apps</th></tr></thead>
              <tbody>
                {(detail.data.rows[0].days || []).map((d) => <tr key={d.day}><td>{d.day}</td><td>{tm(d.first)}</td><td>{tm(d.last)}</td><td><b>{hm(d.activeHours)}</b></td><td className="small-muted">{hm(d.idleHours)}</td><td className="small-muted">{d.topApps.map((a) => `${a.name} ${a.minutes}m`).join(' · ') || '—'}</td></tr>)}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </>
  );
}

// ------------------------------------------------------------------------------------------------ Trends
function LineChart({ title, unit, a, b, labels, aName }) {
  const W = 640; const H = 190; const L = 44; const R = 12; const T = 14; const B = 34;
  const vals = [...a, ...b].filter((v) => v != null);
  const top = Math.max(1, ...vals) * 1.15;
  const x = (i) => L + (labels.length > 1 ? (i * (W - L - R)) / (labels.length - 1) : (W - L - R) / 2);
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const path = (arr) => arr.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(' ');
  const ticks = [0, top / 2, top].map((v) => Math.round(v * 10) / 10);
  return (
    <Panel title={title} sub={unit}>
      <div style={{ overflowX: 'auto' }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', minWidth: 420, height: 'auto' }} role="img" aria-label={title}>
          {ticks.map((t) => <g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--line)" /><text x={L - 6} y={y(t) + 4} textAnchor="end" fontSize="10" fill="var(--ink-soft)">{t}</text></g>)}
          {labels.map((l, i) => <text key={l} x={x(i)} y={H - 12} textAnchor="middle" fontSize="10" fill="var(--ink-soft)">{l.slice(8, 10)}/{l.slice(5, 7)}</text>)}
          <polyline points={path(b)} fill="none" stroke="var(--ink-faint)" strokeWidth="2" strokeDasharray="5 4" />
          <polyline points={path(a)} fill="none" stroke="var(--navy)" strokeWidth="2.5" />
          {a.map((v, i) => (v == null ? null : <circle key={`p${labels[i]}`} cx={x(i)} cy={y(v)} r="3.2" fill="var(--navy)"><title>{`${labels[i]}: ${v}`}</title></circle>))}
        </svg>
      </div>
      <div className="small-muted" style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <span><span style={{ display: 'inline-block', width: 14, height: 3, background: 'var(--navy)', verticalAlign: 'middle', marginRight: 6 }} />{aName}</span>
        <span><span style={{ display: 'inline-block', width: 14, height: 0, borderTop: '2px dashed var(--ink-faint)', verticalAlign: 'middle', marginRight: 6 }} />Company average</span>
      </div>
    </Panel>
  );
}
export function Trends() {
  const [weeks, setWeeks] = useState(8);
  const [department, setDepartment] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const people = useGet('/monitoring/reports', { from: addDays(todayIst(), -30), to: todayIst() });
  const { data, error } = useGet('/monitoring/trends', { weeks, ...(department ? { department } : {}), ...(employeeId ? { employeeId } : {}) });
  const list = (people.data && people.data.rows) || [];
  const depts = [...new Set(list.map((r) => r.department).filter(Boolean))].sort();
  const pick = (k) => ({ a: ((data && data.selection) || []).map((w) => w[k]), b: ((data && data.company) || []).map((w) => w[k]) });
  const labels = (data && data.weeks) || [];
  return (
    <>
      <div className="mon-bar">
        <Combo value={String(weeks)} onChange={(e) => setWeeks(Number(e.target.value))} aria-label="Weeks">
          {[4, 8, 12, 26].map((n) => <option key={n} value={n}>Last {n} weeks</option>)}
        </Combo>
        <Combo value={department} onChange={(e) => { setDepartment(e.target.value); setEmployeeId(''); }} aria-label="Department">
          <option value="">Everyone I can see</option>
          {depts.map((d) => <option key={d} value={d}>{d}</option>)}
        </Combo>
        <Combo value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} aria-label="Employee">
          <option value="">All people</option>
          {list.filter((r) => !department || r.department === department).map((r) => <option key={r.employeeId || r.key} value={r.employeeId || r.key}>{r.name}</option>)}
        </Combo>
      </div>
      {error && <div className="notice red">{error}</div>}
      {data && (
        <div className="mon-trends" style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))' }}>
          <LineChart title="Active hours a day" unit="average per working day" labels={labels} aName={data.label} {...pick('activeHoursPerDay')} />
          <LineChart title="Productive %" unit="productive share of active time" labels={labels} aName={data.label} {...pick('productivity')} />
          <LineChart title="Idle hours a day" unit="average per working day" labels={labels} aName={data.label} {...pick('idleHoursPerDay')} />
          <LineChart title="Overtime hours a week" unit="in use, per person" labels={labels} aName={data.label} {...pick('overtimeHoursPerPerson')} />
        </div>
      )}
      <div className="small-muted" style={{ marginTop: 8 }}>Each point is a week (Monday to Sunday). The dashed line is the whole company, numbers only.</div>
    </>
  );
}

// ------------------------------------------------------------------------------------------------ Alert rules
const BLANK = { name: '', metric: 'app_minutes', target: '', minutes: 30, time: '21:00', departments: '', enabled: true };
export function AlertRules() {
  const { data, error, reload } = useGet('/monitoring/alert-rules');
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState('');
  const [ot, setOt] = useState(null);
  useEffect(() => { if (data) setOt(data.overtime); }, [data]);
  const edit = !!(data && data.canEdit);
  const save = async () => {
    setMsg('');
    try {
      await api.post('/monitoring/alert-rules', { ...form, departments: String(form.departments || '').split(',').map((d) => d.trim()).filter(Boolean) });
      setForm(null); setMsg('Rule saved.'); reload();
    } catch (e) { setMsg(errOf(e, 'Could not save the rule.')); }
  };
  const remove = async (id) => { try { await api.delete(`/monitoring/alert-rules/${id}`); reload(); } catch (e) { setMsg(errOf(e, 'Could not remove it.')); } };
  const toggle = async (r) => { try { await api.post('/monitoring/alert-rules', { ...r, enabled: !r.enabled }); reload(); } catch (e) { setMsg(errOf(e, 'Could not change it.')); } };
  const saveOt = async () => { try { const r = await api.put('/monitoring/overtime-settings', ot); setOt(r.data.overtime); setMsg('Overtime settings saved.'); } catch (e) { setMsg(errOf(e, 'Could not save.')); } };
  const what = (r) => (r.metric === 'app_minutes' ? `${r.target} over ${r.minutes} min a day` : r.metric === 'active_after' ? `working after ${r.time}` : `over ${r.minutes} min a day`);
  return (
    <>
      {error && <div className="notice red">{error}</div>}
      {msg && <div className="notice">{msg}</div>}
      <Panel title="Your alert rules" sub="Checked every 5 minutes with the other alerts; each rule rings once a day per person, to their team lead and HR (and by mail when alert mail is on in Settings). Alerts must be switched on in Settings." action={edit ? { label: 'New rule', onClick: () => setForm({ ...BLANK }) } : null}>
        <div className="tbl-wrap">
          <table className="mon-table">
            <thead><tr><th>Rule</th><th>Watches</th><th>Departments</th><th>State</th>{edit && <th />}</tr></thead>
            <tbody>
              {((data && data.rules) || []).map((r) => (
                <tr key={r.id}>
                  <td><b>{r.name}</b></td>
                  <td>{(data.metrics || {})[r.metric] || r.metric}<div className="small-muted">{what(r)}</div></td>
                  <td className="small-muted">{r.departments.length ? r.departments.join(', ') : 'All'}</td>
                  <td><Pill tone={r.enabled ? 'green' : 'slate'}>{r.enabled ? 'On' : 'Off'}</Pill></td>
                  {edit && (
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button type="button" className="btn btn-sm" onClick={() => toggle(r)}>{r.enabled ? 'Switch off' : 'Switch on'}</button>{' '}
                      <button type="button" className="btn btn-sm" onClick={() => setForm({ ...r, departments: r.departments.join(', ') })}>Edit</button>{' '}
                      <button type="button" className="btn btn-sm" onClick={() => remove(r.id)}>Remove</button>
                    </td>
                  )}
                </tr>
              ))}
              {data && !data.rules.length && <tr><td colSpan={5} className="small-muted">No rules yet.{edit ? ' Press New rule, for example "YouTube over 30 minutes a day".' : ''}</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>
      {form && (
        <Panel title={form.id ? 'Edit rule' : 'New rule'}>
          <div className="mon-form" style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))' }}>
            <label>Name <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="YouTube in work hours" /></label>
            <label>Watches
              <Combo value={form.metric} onChange={(e) => setForm({ ...form, metric: e.target.value })}>
                {Object.entries((data && data.metrics) || {}).map(([k, w]) => <option key={k} value={k}>{w}</option>)}
              </Combo>
            </label>
            {form.metric === 'app_minutes' && <label>App or website <input value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} placeholder="youtube" /></label>}
            {form.metric === 'active_after'
              ? <label>After (time) <input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} /></label>
              : <label>Minutes in a day <input type="number" min={5} max={720} value={form.minutes} onChange={(e) => setForm({ ...form, minutes: e.target.value })} /></label>}
            <label>Departments (empty = all) <input value={form.departments} onChange={(e) => setForm({ ...form, departments: e.target.value })} placeholder="BDE, Medical" /></label>
          </div>
          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-primary btn-sm" onClick={save}>Save rule</button>
            <button type="button" className="btn btn-sm" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </Panel>
      )}
      {ot && (
        <Panel title="Overtime" sub="How long before and after work hours the PC keeps counting, as overtime (app name and in use / idle only).">
          <div className="mon-form" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
            <label className="mon-check"><input type="checkbox" checked={!!ot.enabled} disabled={!edit} onChange={(e) => setOt({ ...ot, enabled: e.target.checked })} /> Record overtime</label>
            <label>Minutes before work <input type="number" min={0} max={240} value={ot.beforeMinutes} disabled={!edit} onChange={(e) => setOt({ ...ot, beforeMinutes: Number(e.target.value) })} /></label>
            <label>Minutes after work <input type="number" min={0} max={480} value={ot.afterMinutes} disabled={!edit} onChange={(e) => setOt({ ...ot, afterMinutes: Number(e.target.value) })} /></label>
            {edit && <button type="button" className="btn btn-primary btn-sm" onClick={saveOt}>Save</button>}
          </div>
        </Panel>
      )}
    </>
  );
}
