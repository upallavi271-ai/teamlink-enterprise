// Interviews & Joining -> Internal Hiring.
//
//   TeamLink Internal Hire:
//     Selected -> Internal Offer -> Accepted -> Hired -> HRMS Employee Creation
//
// This screen lists ONLY internal hires, and it is the only place in the app
// where an ATS candidate becomes an HRMS employee. A client placement never
// appears here: a placed candidate joins the CLIENT's payroll, not TeamLink's,
// and is billed through Accounts instead.

import { useMemo, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { can } from '../../permissions';
import AtsDataTools from '../../components/AtsDataTools.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import { stageLabel, offerStatusClass, joiningStatusClass } from '../../atsVocab';
import {
  fmtDate, money, useWorkspace, Banner, IntJoinFilters,
  EMPTY_INTJOIN_FILTERS, matchesShared, INTJOIN_TABS,
  usePersonApplicationIds, IntJoinEmpty, sortIntJoin,
} from './intjoinShared.jsx';

export default function InternalHiring() {
  const { user } = useAuth();
  const { data, error, notice, act, load } = useWorkspace('/ats/internal-hiring');
  const [filters, setFilters] = useState(EMPTY_INTJOIN_FILTERS);
  const personIds = usePersonApplicationIds(filters);
  const canHire = can(user, 'ats', 'interviews', 'Internal Hiring', 'approve');
  const canSeeEmployees = can(user, 'hrms', 'hrms', 'Employee Management', 'view');

  const setFilter = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const rows = useMemo(
    () => sortIntJoin(
      (data.rows || []).filter((r) => matchesShared(r, filters, r.joiningDate, personIds)
        && (!filters.status || r.stage === filters.status)),
      filters.sort, (r) => r.joiningDate,
    ),
    [data.rows, filters, personIds],
  );
  const statuses = useMemo(
    () => [...new Set((data.rows || []).map((r) => r.stage).filter(Boolean))]
      .map((s) => ({ value: s, label: stageLabel(s) })),
    [data.rows],
  );
  const page = usePaged(rows);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Internal Hiring</h1>
          <div className="page-sub">
            TeamLink internal hires only: Selected → Offer → Offer Accepted → Joined → Hired → HRMS
            employee record. Client placements are never listed here and never become TeamLink employees —
            they are billed to the client instead.
          </div>
        </div>
        {/* Template · Import · Export — the rows shown (server-scoped
            /ats/internal-hiring, narrowed to the filtered rows) and the matching import. */}
        <AtsDataTools
          module="internal-hiring"
          kinds={['internal-hiring']}
          onImported={load}
          body={() => ({ ids: rows.length === (data.rows || []).length ? null : rows.map((r) => r.id) })}
        />
      </div>

      <div className="tabbar">
        {INTJOIN_TABS.map((t) => (
          <NavLink key={t.to} to={t.to} className={({ isActive }) => 'tab-btn' + (isActive ? ' active' : '')}>{t.label}</NavLink>
        ))}
      </div>

      <Banner error={error} notice={notice} />

      <IntJoinFilters
        filters={filters}
        setFilter={setFilter}
        opts={data.filterOptions || {}}
        onClear={() => setFilters(EMPTY_INTJOIN_FILTERS)}
        count={rows.length}
        total={(data.rows || []).length}
        noun="internal hires"
        storageKey="inthire"
        statuses={statuses}
        statusLabel="Stage"
        statusAll="All stages"
        dateLabel="Joining date"
        noClient
        noHiringType
      />

      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Candidate</th><th>Internal Requirement</th><th>Department</th><th>Stage</th>
              <th>Internal Offer</th><th>Offered CTC</th><th>Joining Date</th><th>Joining Status</th>
              <th>HRMS Employee</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {page.slice.map((r) => (
              <tr key={r.id}>
                <td className="row-link"><Link to={`/candidates/${r.candidate.id}`}>{r.candidate.name}</Link></td>
                <td className="row-link"><Link to={`/requirements/${r.requirement.id}`}>{r.requirement.title}</Link></td>
                <td className="small-muted">{r.requirement.department || '—'}</td>
                <td className="small-muted">{stageLabel(r.stage)}</td>
                <td><span className={'status ' + offerStatusClass(r.offerStatus)}>{r.offerStatus}</span></td>
                <td>{money(r.offeredCtc)}</td>
                <td className="small-muted">{fmtDate(r.joiningDate)}</td>
                <td><span className={'status ' + joiningStatusClass(r.joiningStatus)}>{r.joiningStatus}</span></td>
                <td>
                  {r.employee ? (
                    <>
                      <span className="status joined">{r.employee.employeeCode}</span>
                      <div className="small-muted" style={{ fontSize: 11 }}>{r.employee.designation} · {r.employee.employmentStatus}</div>
                      {canSeeEmployees && <Link className="row-link" to={`/employees/${r.employee.id}`}>Open in HRMS</Link>}
                    </>
                  ) : <span className="small-muted">Not created</span>}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {!canHire ? <span className="small-muted">—</span> : r.employee ? (
                    <span className="small-muted">In HRMS</span>
                  ) : r.joiningStatus === 'Joined' ? (
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => act(() => api.post(`/ats/internal-hiring/${r.id}/create-employee`))}
                    >
                      Create HRMS Employee
                    </button>
                  ) : (
                    <span className="small-muted">Complete joining first</span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan="10" style={{ padding: 0 }}><IntJoinEmpty loading={data.loading} filters={filters} onClear={() => setFilters(EMPTY_INTJOIN_FILTERS)} noun="internal hires" title="No TeamLink internal hires in the pipeline." /></td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager page={page} noun="internal hires" />

      <div className="card section" style={{ marginTop: 12 }}>
        <b>Why this screen is separate.</b> Only a TeamLink internal hire becomes an employee. A selected
        client-placement candidate joins the client, and the ATS hands that off to Accounts instead:
        Candidate Joined → Billing Pending → Invoice → Receivable → Payment → Bank Reconciliation.
        Sending every selected candidate to HRMS would put other companies’ staff on TeamLink’s payroll.
      </div>
    </div>
  );
}
