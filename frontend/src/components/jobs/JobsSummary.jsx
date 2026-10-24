import { useEffect, useState } from 'react';
import api from '../../api';
import StatCard, { StatRow } from '../ui/StatCard.jsx';
import { useAgreementBlind } from '../../utils/agreementPrivacy.js';
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
  const blind = useAgreementBlind(); // TL / Recruiter / HR: no agreement words (2026-10-12)
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
        <StatCard label="Open requirements" help="Requirements we are still finding people for" value={c.open} tone="blue" zeroText="No open requirements yet. New requirements show here when they are opened." onClick={has('open') ? () => onView('open') : undefined} hint={sum.total ? `of ${sum.total.toLocaleString('en-IN')} requirements` : undefined} />
        {c.needsTl !== null && c.needsTl !== undefined && has('needstl') && (
          <StatCard label="Needs a team lead" help="Requirements nobody leads yet — give each one a team lead (TL)" value={c.needsTl} tone="amber" zeroText="Every requirement has a team lead" upIsGood={false} onClick={() => onView('needstl')} />
        )}
        {c.needsRecruiter !== null && c.needsRecruiter !== undefined && has('unassigned') && (
          <StatCard label="Needs a recruiter" help="Requirements with no recruiter finding people yet" value={c.needsRecruiter} tone="amber" zeroText="Every requirement has a recruiter" upIsGood={false} onClick={() => onView('unassigned')} />
        )}
        <StatCard label="Late" help="Open requirements past the date the client wanted" value={c.late} tone="red" zeroText="Nothing late 🎉" upIsGood={false} onClick={() => onFilter({ deadline: 'overdue' })} hint="Past the due date" />
        {/* 2026-10-13: a job is only Open or Closed. "Waiting for agreement" and "On hold" are no longer cards or states. */}
      </StatRow>
      {sum.total > 0 && (
        <div className="ccr-charts">
          <div className="ccr-chart">
            <h3>Requirements by status</h3>
            <div className="ccr-sub">Every requirement is either Open or Closed. Click a bar to see them.</div>
            <BarChart data={chain} height={210} title="Requirements by status" />
          </div>
          {depts.length > 0 && (
            <div className="ccr-chart">
              <h3>Open requirements by department</h3>
              <div className="ccr-sub">{onDepartment ? 'Click a department to see its requirements.' : 'Open requirements in your area.'}</div>
              <DonutChart data={depts} title="Open requirements by department" centerValue={(c.open || 0).toLocaleString('en-IN')} centerLabel="open" empty="No open requirements" />
            </div>
          )}
          {clients.length > 0 && (
            <div className="ccr-chart">
              <h3>Open requirements by client</h3>
              <div className="ccr-sub">The clients with the most open requirements. Click one.</div>
              <BarChart data={clients} horizontal title="Open requirements by client" />
            </div>
          )}
        </div>
      )}
    </>
  );
}
