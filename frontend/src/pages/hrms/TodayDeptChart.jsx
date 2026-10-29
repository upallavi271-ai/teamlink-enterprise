// THE HRMS DASHBOARD'S ONE CHART (founder 2026-10-28: "HRMS dashboard clear ga, clarity ga, okka bar graph ina chart ina okati").
// PEOPLE on the attendance date, per department - the same people and the same day as the attendance cards above it
// (server: attendanceOverview.byDepartment), so every bar adds up to that department's headcount at work that day.
// One bar per department, biggest first: Present / Half day / On leave / Absent. The number sits inside a part when it fits,
// "x of y present" is at the end, hovering a part shows it, and Table view carries every figure. Week off / holiday people
// are not a status of work, so they are a note beside the bar, not a coloured part.
//
// Colours (today-dept-chart.css), run through the dataviz validator in this stack order: light #15803d #e0a100 #2a78d6 #d03b3b
// on #ffffff, dark #1f7f45 #c98500 #3d8fd6 #d03b3b on #1a1a19 - every check passes (light amber is under 3:1, so the numbers
// are printed on the bars and the table view exists).
import { useEffect, useRef, useState } from 'react';
import ChartCard, { DataTable, useTip } from '../../components/charts/ChartCard.jsx';
import './today-dept-chart.css';

const PARTS = [
  { key: 'present', name: 'Present', slot: 'tdc-p' },
  { key: 'halfDay', name: 'Half day', slot: 'tdc-h' },
  { key: 'onLeave', name: 'On leave', slot: 'tdc-l' },
  { key: 'absent', name: 'Absent', slot: 'tdc-a' },
];
const atWork = (r) => PARTS.reduce((n, p) => n + (r[p.key] || 0), 0); // the people expected at work that day
// people the day has nothing for yet: no device data / not checked in yet
const waitingWords = (r) => [r.noRecord ? `${r.noRecord} no device data` : '', r.notYet ? `${r.notYet} not checked in yet` : ''].filter(Boolean).join(', ');
const pct = (v, total) => (total ? Math.round((v / total) * 100) : 0);
// Does "12" fit inside a part this many px wide? 12px bold digits are ~7.2px each, plus padding.
const fits = (px, n) => px >= String(n).length * 7.2 + 12;

function Bars({ rows, top, onPickDept }) {
  const tip = useTip();
  const box = useRef(null);
  const [trackPx, setTrackPx] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const measure = () => { const t = el.querySelector('.tdc-track'); setTrackPx(t ? t.getBoundingClientRect().width : 0); };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(el);
    return () => ro && ro.disconnect();
  }, [rows.length]);

  return (
    <div className="tdc-rows" ref={box}>
      {rows.map((r) => {
        const work = atWork(r);
        const hide = () => tip && tip.hide();
        const all = { title: `${r.department} · ${work} at work`, rows: PARTS.map((p) => ({ name: `${p.name} (${pct(r[p.key], work)}%)`, value: r[p.key] || 0, slot: p.slot })) };
        return (
          <div key={r.department} className="tdc-row" aria-label={`${r.department}: ${PARTS.map((p) => `${p.name} ${r[p.key] || 0}`).join(', ')}`}>
            <button type="button" className="tdc-name" title={`Show only ${r.department}`} onClick={() => onPickDept && onPickDept(r.department)}
              onPointerMove={(e) => tip && tip.show(e, all)} onPointerLeave={hide}>{r.department}</button>
            <div className="tdc-track">
              {work === 0 ? <span className="tdc-none">{waitingWords(r) || (r.offDay ? 'Week off / holiday' : 'Nobody at work')}</span> : (
                <div className="tdc-bar" style={{ width: `${Math.max(3, (work / top) * 100)}%` }}>
                  {PARTS.map((p) => {
                    const v = r[p.key] || 0;
                    if (!v) return null;
                    const one = { title: r.department, rows: [{ name: `${p.name} (${pct(v, work)}%)`, value: v, slot: p.slot }] };
                    return (
                      <div key={p.key} className={`tdc-seg f${p.slot}`} style={{ flex: `${v} 1 0` }} tabIndex={0}
                        aria-label={`${r.department}, ${p.name}: ${v}`}
                        onPointerMove={(e) => tip && tip.show(e, one)} onPointerLeave={hide}
                        onFocus={(e) => tip && tip.show(e, all)} onBlur={hide}>
                        {fits((v / top) * trackPx, v) && <span>{v}</span>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="tdc-total">
              <b>{r.present + r.halfDay} of {work}</b>
              <small>{[work ? `${pct(r.present + r.halfDay, work)}% came` : '', r.offDay ? `+${r.offDay} off` : '', work ? waitingWords(r) : ''].filter(Boolean).join(' · ')}</small>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function TodayDeptChart({ rows, date, onPickDept }) {
  const list = (rows || []).filter((r) => r.total > 0);
  const top = Math.max(1, ...list.map(atWork));
  const sum = (k) => list.reduce((n, r) => n + (r[k] || 0), 0);
  const work = list.reduce((n, r) => n + atWork(r), 0);
  const table = (
    <DataTable
      headers={['Department', 'Present', 'Half day', 'On leave', 'Absent', 'Week off / holiday', 'No data yet', 'At work']}
      numeric={[1, 2, 3, 4, 5, 6, 7]}
      rows={[...list.map((r) => [r.department, r.present, r.halfDay, r.onLeave, r.absent, r.offDay, (r.noRecord || 0) + (r.notYet || 0), atWork(r)]),
        ['All departments', sum('present'), sum('halfDay'), sum('onLeave'), sum('absent'), sum('offDay'), sum('noRecord') + sum('notYet'), work]]}
    />
  );
  return (
    <div className="hd-tdc">
      <ChartCard
        title={`Who came to work, by department - ${date}`}
        sub={`${sum('present') + sum('halfDay')} of ${work} came (${pct(sum('present') + sum('halfDay'), work)}%). Click a department to see only it.`}
        table={table}
        isEmpty={!work}
        empty={!list.length ? 'No employees match these filters.' : (sum('noRecord') + sum('notYet')) ? `No attendance has come in for ${date} yet (${sum('noRecord') + sum('notYet')} people: no device data / not checked in).` : `Nobody was expected at work on ${date} (week off / holiday).`}
      >
        <div className="tdc-legend">
          {PARTS.map((p) => <span key={p.key}><i className={`f${p.slot}`} />{p.name} <b>{sum(p.key)}</b></span>)}
        </div>
        <Bars rows={list} top={top} onPickDept={onPickDept} />
      </ChartCard>
    </div>
  );
}
