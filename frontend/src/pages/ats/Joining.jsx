// Interviews & Joining -> Joining.
//
//   Offer Accepted -> Documents -> Joining Scheduled -> Joined
//
// and then the fork that matters:
//   Client Placement       Joined -> Billing Pending -> Invoice -> Receivable
//                          -> Payment -> Bank Reconciliation   (Accounts)
//   TeamLink Internal Hire Joined -> Hired -> HRMS employee    (Internal Hiring)
//
// Columns, as specified: Candidate · Client · Requirement · Offer Status ·
// Joining Date · Joining Status · Owner — plus the hiring type and, for a
// client placement, the invoice that joining actually raised.

import { useMemo, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { can } from '../../permissions';
import { offerStatusClass, joiningStatusClass } from '../../atsVocab';
import {
  fmtDate, money, useWorkspace, Banner, Panel, HiringTypeChip, IntJoinFilters,
  EMPTY_INTJOIN_FILTERS, matchesShared, INTJOIN_TABS,
} from './intjoinShared.jsx';

export default function Joining() {
  const { user } = useAuth();
  const { data, error, notice, act } = useWorkspace('/ats/joining');
  const [filters, setFilters] = useState(EMPTY_INTJOIN_FILTERS);
  const [dialog, setDialog] = useState(null);
  const canAct = can(user, 'ats', 'interviews', 'Joining', 'edit');
  const canSeeInvoice = can(user, 'accounts', 'accounts', 'Invoices', 'view');

  const setFilter = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const rows = useMemo(
    () => (data.rows || []).filter((r) => matchesShared(r, filters, r.joiningDate)),
    [data.rows, filters],
  );

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Joining</h1>
          <div className="page-sub">
            Offer Accepted → Documents → Joining Scheduled → Joined. A client placement hands off to
            Accounts on joining (Billing Pending → Invoice → Receivable); a TeamLink internal hire does
            not — it goes to Internal Hiring for HRMS employee creation.
          </div>
        </div>
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
      />

      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Candidate</th><th>Client</th><th>Requirement</th><th>Hiring Type</th>
              <th>Offer Status</th><th>Joining Date</th><th>Joining Status</th><th>Owner</th>
              <th>Billing</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const internal = r.hiringType === 'TeamLink Internal Hire';
              return (
                <tr key={r.id}>
                  <td className="row-link"><Link to={`/candidates/${r.candidate.id}`}>{r.candidate.name}</Link></td>
                  <td className="small-muted">{internal ? 'TeamLink (internal)' : (r.requirement.client?.name || '—')}</td>
                  <td className="row-link"><Link to={`/requirements/${r.requirement.id}`}>{r.requirement.title}</Link></td>
                  <td><HiringTypeChip value={r.hiringType} /></td>
                  <td><span className={'status ' + offerStatusClass(r.offerStatus)}>{r.offerStatus}</span></td>
                  <td className="small-muted">{fmtDate(r.joiningDate)}</td>
                  <td><span className={'status ' + joiningStatusClass(r.joiningStatus)}>{r.joiningStatus}</span></td>
                  <td className="small-muted">{r.owner}</td>
                  <td className="small-muted">
                    {internal ? (
                      <>Not applicable <div style={{ fontSize: 11 }}>internal hire — never invoiced</div></>
                    ) : r.invoice ? (
                      <>
                        <span className="status paid">Invoiced</span>
                        <div style={{ fontSize: 11 }}>
                          {money(r.invoice.amount)} + GST {money(r.invoice.gst)} − TDS {money(r.invoice.tds)} = <b>{money(r.invoice.total)}</b>
                        </div>
                        {canSeeInvoice && <Link className="row-link" to={`/invoices/${r.invoice.id}`}>Open invoice</Link>}
                      </>
                    ) : (
                      r.billingStatus
                    )}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {!canAct ? <span className="small-muted">—</span> : (
                      <>
                        {r.joiningStatus !== 'Joined' && (
                          <button className="btn btn-sm btn-primary" onClick={() => setDialog({ kind: 'schedule', row: r })}>
                            {r.joiningStatus === 'Joining Scheduled' ? 'Reschedule Joining' : 'Schedule Joining'}
                          </button>
                        )}{' '}
                        {r.joiningStatus === 'Joining Scheduled' && (
                          <button
                            className="btn btn-sm btn-primary"
                            onClick={() => act(() => api.post(`/ats/joining/${r.id}/joined`))}
                          >
                            Mark Joined
                          </button>
                        )}
                        {r.joiningStatus === 'Joined' && internal && (
                          <Link className="btn btn-sm" to="/ats/internal-hiring">Create HRMS Employee</Link>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan="10" className="small-muted" style={{ padding: 16 }}>Nobody is at joining stage yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {dialog?.kind === 'schedule' && (
        <ScheduleForm
          row={dialog.row}
          onClose={() => setDialog(null)}
          onSubmit={(joiningDate) => act(
            () => api.post(`/ats/joining/${dialog.row.id}/schedule`, { joiningDate }),
            `Joining scheduled for ${fmtDate(joiningDate)}.`,
          ).then((ok) => ok && setDialog(null))}
        />
      )}
    </div>
  );
}

function ScheduleForm({ row, onClose, onSubmit }) {
  const [joiningDate, setJoiningDate] = useState(row.joiningDate || new Date().toISOString().slice(0, 10));
  const internal = row.hiringType === 'TeamLink Internal Hire';
  return (
    <Panel
      title={`Schedule joining — ${row.candidate.name}`}
      subtitle={`${row.requirement.title} · ${internal ? 'TeamLink internal hire' : row.requirement.client?.name} · documents ${row.documentsStatus}`}
      onClose={onClose}
    >
      <form onSubmit={(e) => { e.preventDefault(); onSubmit(joiningDate); }}>
        <label className="field" style={{ maxWidth: 260 }}>
          <span>Joining date *</span>
          <input required type="date" value={joiningDate} onChange={(e) => setJoiningDate(e.target.value)} />
        </label>
        <div className="small-muted" style={{ marginBottom: 10 }}>
          {internal
            ? 'An internal hire’s joining date becomes their date of joining on the HRMS employee record.'
            : 'The joining date drives the invoice: invoice date is joining + 6 days and payment is due 6 days after that.'}
        </div>
        <button className="btn btn-primary btn-sm" type="submit">Save joining date</button>
      </form>
    </Panel>
  );
}
