import { useEffect, useState } from 'react';
import api from '../../api';
import StatCard, { StatRow } from '../ui/StatCard.jsx';
import { BarChart, DonutChart } from '../charts';
import '../clients/ccr.css';

// ---------------------------------------------------------------------------
// JOBS LIST — cards and charts above the table (ATS layout v3, 2026-10-03).
//
// GET /requirements/summary with the list's own filters (the chip is not
// applied — a card that opens a chip counts the whole filtered set). Every
// number is a count over the SAME where the list it opens uses
// (routes/requirements.js), so a card and its list never disagree.
//
//   cards (max 6)   Open jobs · Needs a TL · Needs a recruiter · Late ·
//                   Waiting for agreement · On hold — each opens its list
//   charts (max 3)  Job status chain (bar) · Open jobs by department (donut)
//                   · Open jobs by client (bars) — each bar / slice filters
//
//   onView(key)          switch the list's chip (open / needstl / unassigned)
//   onFilter(patch)      apply list filters ({ deadline }, { agreement }, …)
//   onDepartment(name)   the department filter (null when the role has none)
//   reloadKey            any value that changes after the list changed
// ---------------------------------------------------------------------------
export default function JobsSummary({
  params, views = [], onView, onFilter, onDepartment, reloadKey, activeStatus,
}) {
  const [sum, setSum] = useState(null);
  const key = JSON.stringify(params || {});
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api.get('/requirements/summary', { params })
        .then((res) => { if (live) setSum(res.data); })
        .catch(() => { if (live) setSum(null); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [key, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!sum) return null;
  const c = sum.cards || {};
  const has = (v) => views.includes(v);
  const chain = (sum.chain || []).map((s) => ({
    label: s.label,
    value: s.count,
    tone: s.tone,
    onClick: () => onFilter({ dstatus: activeStatus === s.key ? '' : s.key }),
  }));
  const depts = (sum.byDepartment || []).map((d) => ({
    label: d.name || 'No department',
    value: d.count,
    onClick: onDepartment && d.name ? () => onDepartment(d.name) : undefined,
  }));
  const clients = (sum.byClient || []).map((x) => ({ label: x.name, value: x.count, onClick: () => onFilter({ clientId: x.id }) }));
  return (
    <>
      <StatRow>
        <StatCard label="Open jobs" help="Jobs we are still finding people for" value={c.open} tone="blue" zeroText="No open jobs yet — press + Add job" onClick={has('open') ? () => onView('open') : undefined} hint={sum.total ? `of ${sum.total.toLocaleString('en-IN')} jobs` : undefined} />
        {c.needsTl !== null && c.needsTl !== undefined && has('needstl') && (
          <StatCard label="Needs a team lead" help="Jobs nobody leads yet — give each one a team lead (TL)" value={c.needsTl} tone="amber" zeroText="Every job has a team lead" upIsGood={false} onClick={() => onView('needstl')} />
        )}
        {c.needsRecruiter !== null && c.needsRecruiter !== undefined && has('unassigned') && (
          <StatCard label="Needs a recruiter" help="Jobs with no recruiter finding people yet" value={c.needsRecruiter} tone="amber" zeroText="Every job has a recruiter" upIsGood={false} onClick={() => onView('unassigned')} />
        )}
        <StatCard label="Late" help="Open jobs past the date the client wanted" value={c.late} tone="red" zeroText="Nothing late 🎉" upIsGood={false} onClick={() => onFilter({ deadline: 'overdue' })} hint="Past the due date" />
        {c.waitingAgreement !== null && c.waitingAgreement !== undefined && (
          <StatCard label="Waiting for agreement" help="Jobs that start once the client signs the agreement" value={c.waitingAgreement} tone="amber" zeroText="No job waiting" upIsGood={false} onClick={() => onFilter({ agreement: 'pending' })} />
        )}
        <StatCard label="On hold" help="Jobs paused for now (the client asked us to wait)" value={c.hold} tone="amber" zeroText="Nothing on hold" onClick={() => onFilter({ status: 'ON_HOLD' })} />
      </StatRow>
      {sum.total > 0 && (
        <div className="ccr-charts">
          <div className="ccr-chart">
            <h3>Jobs by status</h3>
            <div className="ccr-sub">Draft → Agreement Approved → Assigned → Open → On Hold → Filled / Closed. Click a bar.</div>
            <BarChart data={chain} height={210} title="Jobs by status" />
          </div>
          {depts.length > 0 && (
            <div className="ccr-chart">
              <h3>Open jobs by department</h3>
              <div className="ccr-sub">{onDepartment ? 'Click a department to see its jobs.' : 'Open jobs in your area.'}</div>
              <DonutChart data={depts} title="Open jobs by department" centerValue={(c.open || 0).toLocaleString('en-IN')} centerLabel="open" empty="No open jobs" />
            </div>
          )}
          {clients.length > 0 && (
            <div className="ccr-chart">
              <h3>Open jobs by client</h3>
              <div className="ccr-sub">The clients with the most open jobs. Click one.</div>
              <BarChart data={clients} horizontal title="Open jobs by client" />
            </div>
          )}
        </div>
      )}
    </>
  );
}
