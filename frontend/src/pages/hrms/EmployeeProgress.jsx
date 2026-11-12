// EMPLOYEE PROGRESS ON THE HRMS DASHBOARD (founder 2026-11-06: targets completed, attendance, performance & development, department wise; "only one round
// graph, all the department details"). Server: GET /hrms/dashboard/progress (utils/employeeProgress.js), so it follows the dashboard's filters and scope.
//
// ONE donut, first and alone with its legend: "first ahh round chart kanipinchali, table ane button evvu". Each slice is a department, sized by its people,
// because a donut shows parts of a whole and people are the whole here. The Table button opens the figures beside it. Only Active people of active
// departments (utils/employeeProgress.js counted). Hovering a slice or a row lights both. Colours are the validated categorical palette, one each, kept per
// department so a filter never repaints one (employee-progress.css). Past eight departments the rest are grey and named in the legend. Once the list is down
// to one department, the same donut shows who has met all their targets. "No data" is a dash, never 0%.
import { useEffect, useState } from 'react';
import api from '../../api';
import ChartCard, { useTip } from '../../components/charts/ChartCard.jsx';
import { SectionLabel, StatRow } from '../../components/proto.jsx';
import './employee-progress.css';

const show = (v) => (v == null ? '—' : `${v}%`);
const DEPARTMENT_SLOT = { Education: 1, Medical: 2, Manufacturing: 3, BDE: 4, 'R&D': 5, HR: 6, Administration: 7, Accounts: 8 };
// One colour each: a department's own slot, or the next one nobody here has.
function slotsFor(rows) {
  const taken = new Set(rows.map((r) => DEPARTMENT_SLOT[r.name]).filter(Boolean));
  const out = new Map();
  rows.forEach((r) => {
    let slot = DEPARTMENT_SLOT[r.name];
    if (!slot) {
      slot = [1, 2, 3, 4, 5, 6, 7, 8].find((n) => !taken.has(n)) || 'n';
      if (slot !== 'n') taken.add(slot);
    }
    out.set(r.key, slot);
  });
  return out;
}
const COLUMNS = [
  { key: 'targetsPct', name: 'Targets', title: (r, people) => (people ? `${r.targetsMet} of ${r.targetsPeople} targets${r.joiningTarget != null ? `, ${r.joinings} of ${r.joiningTarget} joinings` : ''}` : `${r.targetsMet} of ${r.targetsPeople} people met all targets`) },
  // THE JOINING COUNT (founder 2026-11-12): Targets is the share of people who reached their WHOLE target, so a team part way shows 0%. This column is the
  // count itself: joinings from the ATS (the Recruiter joinings rule) against the joining targets of the people who have one.
  { key: 'joinings', name: 'Joinings', hint: 'ATS joinings this month out of the joining targets', fmt: (r) => (r.joiningTarget == null ? '—' : `${r.joinings} of ${r.joiningTarget}`), title: (r) => (r.joiningTarget == null ? 'No joining target this month' : `${r.joinings} joined in the ATS this month, against joining targets of ${r.joiningTarget}`) },
  { key: 'attendancePct', name: 'Attendance', title: (r) => `${r.daysWorked} of ${r.workingDays} working days` },
  { key: 'scorePct', name: 'Performance', title: (r, people) => (r.scorePct == null ? 'No review yet' : people ? `Review score ${r.scorePct} of 100` : `Average score of ${r.reviewed} reviewed`) },
  { key: 'trainingPct', name: 'Training', title: (r) => `${r.trainingDone} of ${r.trainingTotal} courses done` },
];

// The one round graph. A small gap between slices keeps neighbours apart.
function Donut({ slices, total, word, active, setActive }) {
  const tip = useTip();
  const size = 230;
  const width = 34;
  const r = (size - width) / 2;
  const c = 2 * Math.PI * r;
  const sum = slices.reduce((n, s) => n + s.value, 0);
  let start = 0;
  return (
    <svg className="epg-donut" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${total} ${word}: ${slices.map((s) => `${s.name} ${s.value}`).join(', ')}`}>
      <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={width} fill="none" className="epg-rail" />
      {slices.filter((s) => s.value > 0).map((s) => {
        const len = sum ? (s.value / sum) * c : 0;
        const gap = slices.filter((x) => x.value > 0).length > 1 ? 2.5 : 0;
        const el = (
          <circle key={s.key} cx={size / 2} cy={size / 2} r={r} strokeWidth={width} fill="none" className={`epg-slice epg-s${s.slot} epg-alt${s.alt || 0}${active && active !== s.key && active !== s.dept ? ' epg-dim' : ''}`}
            strokeDasharray={`${Math.max(len - gap, 0.5)} ${c}`} strokeDashoffset={-start} transform={`rotate(-90 ${size / 2} ${size / 2})`}
            onMouseEnter={(e) => { setActive(s.key); if (tip) tip.show(e, { title: s.name, rows: [{ name: `of ${sum} (${Math.round((s.value / sum) * 100)}%)`, value: s.value }] }); }}
            onMouseMove={(e) => tip && tip.show(e, { title: s.name, rows: [{ name: `of ${sum} (${Math.round((s.value / sum) * 100)}%)`, value: s.value }] })}
            onMouseLeave={() => { setActive(null); if (tip) tip.hide(); }} />
        );
        start += len;
        return el;
      })}
      <text x="50%" y="47%" textAnchor="middle" className="epg-big">{total}</text>
      <text x="50%" y="58%" textAnchor="middle" className="epg-word">{word}</text>
    </svg>
  );
}

const cell = (c, r) => (c.fmt ? c.fmt(r) : show(r[c.key]));

function Details({ rows, people, overall, slotFor, active, setActive, onPickDept }) {
  const clickable = !people && !!onPickDept;
  // a department the plan splits into teams (Education: Team A / Team B) is followed by one smaller row per team; the department row counts everybody
  const list = people ? rows : rows.flatMap((r) => [r, ...(r.teams || []).map((t, i) => ({ ...t, sub: true, parent: r.key, alt: i }))]);
  return (
    <div className="epg-tablewrap">
      <table className="epg-table">
        <thead>
          <tr>
            <th>{people ? 'Employee' : 'Department'}</th>
            {!people && <th className="num">People</th>}
            {COLUMNS.map((c) => <th key={c.key} className="num" title={c.hint}>{c.name}</th>)}
          </tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.key} className={`${active === r.key || (!r.sub && r.teams && (r.teams || []).some((t) => t.key === active)) ? 'on' : ''}${r.sub ? ' epg-sub' : ''}`} onMouseEnter={() => setActive(r.key)} onMouseLeave={() => setActive(null)}>
              <td>
                <span className="epg-who">
                  {slotFor(r) && <i className={`epg-s${slotFor(r)} epg-alt${r.alt || 0}`} />}
                  {clickable
                    ? <button type="button" title={`Show the people of ${r.sub ? r.parent : r.name}`} onClick={() => onPickDept(r.sub ? r.parent : r.key)}>{r.sub ? `↳ ${r.name}` : r.name}</button>
                    : <span>{r.name}</span>}
                </span>
              </td>
              {!people && <td className="num">{r.people}</td>}
              {COLUMNS.map((c) => <td key={c.key} className="num" title={c.title(r, people)}>{cell(c, r)}</td>)}
            </tr>
          ))}
        </tbody>
        {!people && (
          <tfoot>
            <tr>
              <td>All departments</td>
              <td className="num">{overall.people}</td>
              {COLUMNS.map((c) => <td key={c.key} className="num" title={c.title(overall, false)}>{cell(c, overall)}</td>)}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

export default function EmployeeProgress({ params, onPickDept }) {
  const [d, setD] = useState(null);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(null);
  const [table, setTable] = useState(false);
  const key = JSON.stringify(params);
  useEffect(() => {
    let live = true;
    api.get('/hrms/dashboard/progress', { params }).then((r) => { if (live) { setD(r.data); setFailed(false); } }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
    // params is a new object on every render: its contents are what matter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (failed) return <div className="notice red">Employee progress could not be loaded.</div>;
  if (!d) return <div className="cell-muted" style={{ margin: '12px 0' }}>Loading employee progress…</div>;
  const people = d.level === 'employee';
  const o = d.overall;
  const noTargets = o.people - o.targetsPeople;
  const slots = slotsFor(people ? [] : d.rows);
  const slices = people
    ? [
      { key: 'met', name: 'Met all targets', value: o.targetsMet, slot: 3 },
      { key: 'notYet', name: 'Not yet', value: o.targetsPeople - o.targetsMet, slot: 2 },
      { key: 'none', name: 'No target this month', value: noTargets, slot: 'n' },
    ]
    // a department the plan splits into teams (Education: Team A / Team B) is drawn as its teams, in the department's colour, one shade each
    : d.rows.flatMap((r) => (r.teams && r.teams.length
      ? r.teams.map((t, i) => ({ key: t.key, dept: r.key, name: `${r.name} · ${t.name}`, value: t.people, slot: slots.get(r.key), alt: i }))
      : [{ key: r.key, name: r.name, value: r.people, slot: slots.get(r.key) }]));
  return (
    <div className="hd-epg">
      <ChartCard
        title={people ? 'Employee performance' : 'Department wise employee performance'}
        sub={`${d.label}, so far. Active employees only. ${people ? 'The round graph shows who has met all their targets.' : 'The round graph shows people per department.'}`}
        isEmpty={d.rows.length === 0} empty="No employees match these filters."
      >
        <div className="epg-actions">
          <button type="button" className="tlc-toggle" aria-pressed={table} onClick={() => setTable((v) => !v)}>{table ? 'Hide table' : 'Table'}</button>
        </div>
        <div className={`epg-layout${table ? ' open' : ''}`}>
          <div>
            <Donut slices={slices} total={o.people} word={o.people === 1 ? 'person' : 'people'} active={people ? null : active} setActive={people ? () => {} : setActive} />
            {table && (
              <div className="epg-legend">
                {slices.map((s) => <span key={s.key}><i className={`epg-s${s.slot} epg-alt${s.alt || 0}`} />{s.name} {s.value}</span>)}
              </div>
            )}
          </div>
          {table
            ? <Details rows={d.rows} people={people} overall={o} slotFor={(r) => (people ? null : slots.get(r.key))} active={active} setActive={setActive} onPickDept={onPickDept} />
            : (
              <ul className="epg-key">
                {slices.map((s) => (
                  <li key={s.key} className={active === s.key ? 'on' : ''} onMouseEnter={() => !people && setActive(s.key)} onMouseLeave={() => setActive(null)}>
                    <i className={`epg-s${s.slot} epg-alt${s.alt || 0}`} />
                    {!people && onPickDept
                      ? <button type="button" title={`Show the people of ${s.dept || s.name}`} onClick={() => onPickDept(s.dept || s.key)}>{s.name}</button>
                      : <span>{s.name}</span>}
                    <b>{s.value}</b>
                  </li>
                ))}
              </ul>
            )}
        </div>
      </ChartCard>
    </div>
  );
}

// An employee's own month, on their dashboard.
export function MyProgress() {
  const [d, setD] = useState(null);
  useEffect(() => { api.get('/hrms/dashboard/progress/mine').then((r) => setD(r.data)).catch(() => setD(null)); }, []);
  if (!d || !d.me) return null;
  const m = d.me;
  return (
    <>
      <SectionLabel>My Progress This Month</SectionLabel>
      <StatRow columns={4} cells={[
        { value: m.targetsPeople ? `${m.targetsMet} of ${m.targetsPeople}` : '—', label: m.joiningTarget != null ? `My targets (${m.joinings} of ${m.joiningTarget} joinings)` : 'My targets done', to: '/performance' },
        { value: show(m.attendancePct), label: `My attendance (${m.daysWorked} of ${m.workingDays} days)`, to: '/attendance' },
        { value: m.scorePct == null ? '—' : `${m.scorePct} / 100`, label: 'My performance score', to: '/performance?tab=reports' },
        { value: `${m.trainingDone} of ${m.trainingTotal}`, label: 'My training done', to: '/performance?tab=lms' },
      ]} />
      <div style={{ height: 16 }} />
    </>
  );
}
