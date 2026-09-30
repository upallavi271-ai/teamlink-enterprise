// Interviews & Joining -> Joining.
//
//   Offer Accepted -> Documents -> Joining Scheduled -> Joined
//
// and then the fork that matters (the actual workflow, 2026-09-29):
//   Client Placement       Joined -> Guarantee / Replacement -> Accounts ->
//                          Invoice -> Payment -> Reports
//   TeamLink Internal Hire Joined -> HRMS employee record (Create HRMS Employee)
//
// Columns, as specified: Candidate · Client · Requirement · Offer Status ·
// Joining Date · Joining Status · Owner — plus the hiring type and, for a
// client placement, the invoice that joining actually raised.

import { useMemo, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { can } from '../../permissions';
import AtsDataTools from '../../components/AtsDataTools.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import { offerStatusClass, joiningStatusClass } from '../../atsVocab';
import {
  fmtDate, money, useWorkspace, Banner, Panel, HiringTypeChip, IntJoinFilters,
  EMPTY_INTJOIN_FILTERS, matchesShared, INTJOIN_TABS,
  usePersonApplicationIds, IntJoinEmpty, sortIntJoin,
} from './intjoinShared.jsx';

export default function Joining() {
  const { user } = useAuth();
  const { data, error, notice, act, load } = useWorkspace('/ats/joining');
  const [filters, setFilters] = useState(EMPTY_INTJOIN_FILTERS);
  const personIds = usePersonApplicationIds(filters);
  const [dialog, setDialog] = useState(null);
  const canAct = can(user, 'ats', 'interviews', 'Joining', 'edit');
  const canSeeInvoice = can(user, 'accounts', 'accounts', 'Invoices', 'view');
  const canHire = can(user, 'ats', 'interviews', 'Internal Hiring', 'approve');

  const setFilter = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const rows = useMemo(
    () => sortIntJoin(
      (data.rows || []).filter((r) => matchesShared(r, filters, r.joiningDate, personIds)
        && (!filters.status || r.joiningStatus === filters.status)),
      filters.sort, (r) => r.joiningDate,
    ),
    [data.rows, filters, personIds],
  );
  const statuses = useMemo(
    () => [...new Set((data.rows || []).map((r) => r.joiningStatus).filter(Boolean))].sort()
      .map((s) => ({ value: s, label: s })),
    [data.rows],
  );
  const page = usePaged(rows);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Joining</h1>
          <div className="page-sub">
            Joining Confirmation — both kinds of hire come from Offer Accepted. A client placement is marked
            joined, its guarantee period runs (the client&apos;s agreed terms) and Accounts raises the invoice
            (Invoice → Payment). If the candidate leaves inside the guarantee, record it here: a replacement
            is due. A TeamLink internal hire, once joined, becomes an HRMS employee (Create HRMS Employee).
          </div>
        </div>
        {/* Template · Import · Export — the rows shown (server-scoped
            /ats/joining, narrowed to the filtered rows) and the matching import. */}
        <AtsDataTools
          module="joining"
          kinds={['joining']}
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
        noun="candidates"
        storageKey="joining"
        statuses={statuses}
        statusLabel="Joining status"
        statusAll="All joining statuses"
        dateLabel="Joining date"
      />

      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Candidate</th><th>Client</th><th>Requirement</th><th>Hiring Type</th>
              <th>Offer Status</th><th>Joining Date</th><th>Joining Status</th><th>Guarantee</th><th>Owner</th>
              <th>Billing</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {page.slice.map((r) => {
              const internal = r.hiringType === 'TeamLink Internal Hire';
              return (
                <tr key={r.id}>
                  <td className="row-link"><Link to={`/candidates/${r.candidate.id}`}>{r.candidate.name}</Link></td>
                  <td className="small-muted">{internal ? 'TeamLink (internal)' : (r.requirement.client?.name || '—')}</td>
                  <td className="row-link"><Link to={`/requirements/${r.requirement.id}`}>{r.requirement.title}</Link></td>
                  <td><HiringTypeChip value={r.hiringType} /></td>
                  <td>
                    <span className={'status ' + offerStatusClass(r.offerStatus)}>{r.offerStatus}</span>
                    {!internal && <div className="small-muted" style={{ fontSize: 11 }}>the client&apos;s offer</div>}
                  </td>
                  <td className="small-muted">{fmtDate(r.joiningDate)}</td>
                  <td><span className={'status ' + joiningStatusClass(r.joiningStatus)}>{r.joiningStatus}</span></td>
                  <td className="small-muted" style={{ fontSize: 12 }}>
                    {internal ? '—' : r.guaranteeEnds ? (
                      <>
                        {r.inGuarantee ? <span className="status pending">Running</span> : <span className="small-muted">{['Replacement Due', 'Replaced', 'Left after Guarantee'].includes(r.joiningStatus) ? r.joiningStatus : 'Completed'}</span>}
                        <div>{`${r.guaranteePeriod || ''} · to ${fmtDate(r.guaranteeEnds)}`}</div>
                      </>
                    ) : (r.guaranteePeriod ? `${r.guaranteePeriod} (from joining)` : '—')}
                  </td>
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
                        {!['JOINED', 'HIRED'].includes(r.stage) && r.joiningStatus !== 'Joined' && (
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
                        {['JOINED', 'HIRED'].includes(r.stage) && internal && canHire && !r.hrmsEmployeeId && (
                          <button
                            className="btn btn-sm btn-primary"
                            onClick={() => act(() => api.post(`/ats/internal-hiring/${r.id}/create-employee`))}
                          >
                            Create HRMS Employee
                          </button>
                        )}
                        {internal && r.hrmsEmployeeId && <span className="small-muted">In HRMS</span>}
                        {['JOINED', 'HIRED'].includes(r.stage) && !internal && !['Replacement Due', 'Replaced', 'Left after Guarantee'].includes(r.joiningStatus) && (
                          <button className="btn btn-sm" onClick={() => setDialog({ kind: 'left', row: r })}>Candidate Left</button>
                        )}
                        {!internal && r.joiningStatus === 'Replacement Due' && (
                          <button className="btn btn-sm btn-primary" onClick={() => act(() => api.post(`/ats/joining/${r.id}/replaced`, {}), 'Replacement recorded.')}>Replacement Provided</button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan="11" style={{ padding: 0 }}><IntJoinEmpty loading={data.loading} filters={filters} onClear={() => setFilters(EMPTY_INTJOIN_FILTERS)} noun="candidates" title="Nobody is at joining stage yet." /></td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager page={page} noun="candidates" />

      {dialog?.kind === 'left' && (
        <LeftForm
          row={dialog.row}
          onClose={() => setDialog(null)}
          onSubmit={(leftOn, reason) => act(
            () => api.post(`/ats/joining/${dialog.row.id}/left`, { leftOn, reason }),
            'Recorded. Inside the guarantee the placement is flagged Replacement Due; after it, no replacement is owed.',
          ).then((ok) => ok && setDialog(null))}
        />
      )}
      {dialog?.kind === 'schedule' && (
        <ScheduleForm
          row={dialog.row}
          onClose={() => setDialog(null)}
          onSubmit={(joiningDate, offeredCtc) => act(
            () => api.post(`/ats/joining/${dialog.row.id}/schedule`, { joiningDate, offeredCtc }),
            `Joining scheduled for ${fmtDate(joiningDate)}.`,
          ).then((ok) => ok && setDialog(null))}
        />
      )}
    </div>
  );
}

// A placement who left: inside the client's guarantee → Replacement Due.
function LeftForm({ row, onClose, onSubmit }) {
  const [leftOn, setLeftOn] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  return (
    <Panel
      title={`Candidate left — ${row.candidate.name}`}
      subtitle={`${row.requirement.title} · ${row.requirement.client?.name || ''} · guarantee ${row.guaranteePeriod || '—'}${row.guaranteeEnds ? ` to ${fmtDate(row.guaranteeEnds)}` : ''}`}
      onClose={onClose}
    >
      <form onSubmit={(e) => { e.preventDefault(); onSubmit(leftOn, reason); }}>
        <div className="grid-3">
          <label className="field">
            <span>Left on *</span>
            <input required type="date" value={leftOn} onChange={(e) => setLeftOn(e.target.value)} />
          </label>
          <label className="field" style={{ gridColumn: 'span 2' }}>
            <span>Why *</span>
            <input required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. resigned in week 3, relocated" />
          </label>
        </div>
        <button className="btn btn-primary btn-sm" type="submit" disabled={!reason.trim()}>Record</button>
      </form>
    </Panel>
  );
}

function ScheduleForm({ row, onClose, onSubmit }) {
  const [joiningDate, setJoiningDate] = useState(row.joiningDate || new Date().toISOString().slice(0, 10));
  const internal = row.hiringType === 'TeamLink Internal Hire';
  const [offeredCtc, setOfferedCtc] = useState(row.offeredCtc || '');
  return (
    <Panel
      title={`${internal ? 'Schedule joining' : 'Client joining'} — ${row.candidate.name}`}
      subtitle={`${row.requirement.title} · ${internal ? `TeamLink internal hire · documents ${row.documentsStatus}` : row.requirement.client?.name}`}
      onClose={onClose}
    >
      <form onSubmit={(e) => { e.preventDefault(); onSubmit(joiningDate, internal ? undefined : offeredCtc); }}>
        <div className="grid-3">
          <label className="field">
            <span>Joining date *</span>
            <input required type="date" value={joiningDate} onChange={(e) => setJoiningDate(e.target.value)} />
          </label>
          {!internal && (
            <label className="field">
              <span>Annual CTC agreed with the client (₹)</span>
              <input type="number" min="1" value={offeredCtc} onChange={(e) => setOfferedCtc(e.target.value)} placeholder="Optional — else the salary band" />
            </label>
          )}
        </div>
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
