import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { FacetSelect, useLocalFacets } from '../ui/ListPageHeader.jsx';
import Pager, { usePaged } from '../Pager.jsx';
import '../followups/followups.css';

// ---------------------------------------------------------------------------
// WHO HAS PENDING WORK (ATS change list §13 — "Managers should see who has
// work waiting and who did what today, without asking").
//
//   Person | Pending | Late | Follow-ups late | Steps moved (today)
//
// For TL / STL / Manager / Admin, their area only — GET /api/ats-daily/
// pending-work (backend utils/dailyReport.js pendingWork) refuses anyone else.
// Filters cascade Department → Team with counts; the list is held whole, so
// the options are counted here over the rows matching the other filter.
// ---------------------------------------------------------------------------

const FIELDS = [
  { key: 'department', get: (r) => r.department },
  { key: 'team', get: (r) => r.team, label: (v, r) => r.teamName || v },
];

function Num({ v, tone, to }) {
  if (!v) return <td className="num fux-dash">0</td>;
  const cls = `num ${tone || ''}`;
  return <td className={cls}>{to ? <Link to={to}>{v}</Link> : v}</td>;
}

export default function PendingWork() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [values, setValues] = useState({ department: '', team: '' });
  useEffect(() => {
    api.get('/ats-daily/pending-work')
      .then((r) => setData(r.data))
      .catch((e) => setErr(e.response?.data?.error || 'Could not load who has work waiting. Please try again.'));
  }, []);
  const rows = data ? data.rows : [];
  const facets = useLocalFacets(rows, FIELDS, values);
  const shown = useMemo(() => rows.filter((r) => (!values.department || r.department === values.department)
    && (!values.team || r.team === values.team)), [rows, values]);
  const page = usePaged(shown, 25);

  if (err) return <div className="fux-err">{err}</div>;
  if (!data) return <div className="small-muted">Loading who has pending work…</div>;
  const lateTotal = shown.reduce((n, r) => n + r.late, 0);
  const fuLateTotal = shown.reduce((n, r) => n + r.followUpsLate, 0);
  return (
    <div className="fux-pw">
      <div className="fux-dr-bar">
        <FacetSelect label="Department" value={values.department} allLabel="All departments" options={facets.department} onChange={(v) => setValues({ department: v, team: '' })} />
        <FacetSelect label="Team" value={values.team} allLabel="All teams" options={facets.team} onChange={(v) => setValues((x) => ({ ...x, team: v }))} />
        {(values.department || values.team) && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setValues({ department: '', team: '' })}>Clear</button>}
      </div>
      <div className={`fux-banner ${lateTotal || fuLateTotal ? 'is-orange' : 'is-green'}`}>
        {lateTotal || fuLateTotal
          ? <><b>{lateTotal} late tasks</b> and <b>{fuLateTotal} late follow-ups</b> in your area. The people with the most late work are at the top.</>
          : <b>Nothing is late in your area.</b>}
      </div>
      {!shown.length ? <div className="small-muted">Nobody in this list.</div> : (
        <>
          <div className="fux-table-wrap">
            <table className="fux-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Department</th>
                  <th className="num" title="Next steps waiting on this person now">Waiting</th>
                  <th className="num" title="Past their due date">Late</th>
                  <th className="num" title="Follow-ups past their due date and not done">Follow-ups late</th>
                  <th className="num" title="Candidates this person moved to another step today">Steps moved today</th>
                </tr>
              </thead>
              <tbody>
                {page.slice.map((r) => (
                  <tr key={r.key}>
                    <td><b>{r.name}</b>{r.teamName && <div className="fux-note" style={{ marginTop: 0 }}>{r.teamName}</div>}</td>
                    <td className="cell-muted">{r.department || '—'}</td>
                    <Num v={r.pending} tone="" to={r.userId ? `/ats/team?view=pending&owner=${encodeURIComponent(r.userId)}` : null} />
                    <Num v={r.late} tone="fux-red" to={r.userId ? `/ats/team?view=pending&owner=${encodeURIComponent(r.userId)}&due=overdue` : null} />
                    <Num v={r.followUpsLate} tone="fux-red" />
                    <Num v={r.stepsMoved} tone="fux-green" />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} noun="people" />
        </>
      )}
      <div className="fux-note">{data.note}</div>
    </div>
  );
}
