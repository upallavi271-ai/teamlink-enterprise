// Interviews & Joining -> Offers.
//
//   Selected -> Offer -> Offer Accepted -> Documents -> (Joining)
//
// The same workspace serves both hiring types, and says which one each row is:
//   Client Placement       the offer is the client's placement offer
//   TeamLink Internal Hire the offer is an INTERNAL offer and ends in HRMS
// Nothing here raises an invoice and nothing here creates an employee — those
// happen at Joining and Internal Hiring respectively.

import { useMemo, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { can } from '../../permissions';
import AtsDataTools from '../../components/AtsDataTools.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import { stageLabel, offerStatusClass } from '../../atsVocab';
import {
  fmtDate, money, useWorkspace, Banner, Panel, HiringTypeChip, IntJoinFilters,
  EMPTY_INTJOIN_FILTERS, matchesShared, INTJOIN_TABS,
  usePersonApplicationIds, IntJoinEmpty, sortIntJoin,
} from './intjoinShared.jsx';

export default function Offers() {
  const { user } = useAuth();
  const { data, error, notice, act, load } = useWorkspace('/ats/offers');
  const [filters, setFilters] = useState(EMPTY_INTJOIN_FILTERS);
  const personIds = usePersonApplicationIds(filters);
  const [dialog, setDialog] = useState(null);
  const canAct = can(user, 'ats', 'interviews', 'Offers', 'edit');

  const setFilter = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const rows = useMemo(
    () => sortIntJoin(
      (data.rows || []).filter((r) => matchesShared(r, filters, r.offerDate, personIds)
        && (!filters.status || r.offerStatus === filters.status)),
      filters.sort, (r) => r.offerDate,
    ),
    [data.rows, filters, personIds],
  );
  const statuses = useMemo(
    () => [...new Set([...(data.offerStatuses || []), ...(data.rows || []).map((r) => r.offerStatus)].filter(Boolean))]
      .map((s) => ({ value: s, label: s })),
    [data.rows, data.offerStatuses],
  );
  const page = usePaged(rows);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Offers</h1>
          <div className="page-sub">
            Selected → Offer → Offer Accepted → <Link to="/ats/joining">Joining</Link>, for both kinds of hire (the
            actual workflow). A client placement&apos;s offer is the client&apos;s — record it here with the CTC the
            placement fee is worked out on. A TeamLink internal hire gets TeamLink&apos;s own offer and, after joining,
            an HRMS employee record.
          </div>
        </div>
        {/* Template · Import · Export — the rows shown (server-scoped
            /ats/offers, narrowed to the filtered rows) and the matching import. */}
        <AtsDataTools
          module="offers"
          kinds={['offers']}
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
        noun="offers"
        storageKey="offers"
        statuses={statuses}
        statusLabel="Offer status"
        statusAll="All offer statuses"
        dateLabel="Offer date"
      />

      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Candidate</th><th>Client</th><th>Requirement</th><th>Hiring Type</th>
              <th>Stage</th><th>Offer Status</th><th>Offer Date</th><th>Offered CTC</th>
              <th>Documents</th><th>Owner</th><th>Actions</th>
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
                  <td className="small-muted">{stageLabel(r.stage)}</td>
                  <td>
                    <span className={'status ' + offerStatusClass(r.offerStatus)}>
                      {internal && r.offerStatus === 'Offer Released' ? 'Internal Offer Released' : r.offerStatus}
                    </span>
                  </td>
                  <td className="small-muted">{fmtDate(r.offerDate)}</td>
                  <td>{money(r.offeredCtc)}</td>
                  <td className="small-muted">{r.documentsStatus}</td>
                  <td className="small-muted">{r.owner}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {!canAct ? <span className="small-muted">—</span> : (
                      <>
                        {/* Both kinds of hire: TeamLink's offer (internal) or the client's offer, recorded. */}
                        {(r.stage === 'SELECTED' || r.offerStatus === 'Offer Declined') && (
                          <button className="btn btn-sm btn-primary" onClick={() => setDialog({ kind: 'release', row: r })}>
                            {internal ? 'Release Internal Offer' : "Record Client's Offer"}
                          </button>
                        )}
                        {r.offerStatus === 'Offer Released' && (
                          <>
                            <button
                              className="btn btn-sm btn-primary"
                              onClick={() => act(() => api.post(`/ats/offers/${r.id}/accept`), `${r.candidate.name} — offer accepted.`)}
                            >
                              Mark Accepted
                            </button>{' '}
                            <button className="btn btn-sm btn-ghost" onClick={() => setDialog({ kind: 'decline', row: r })}>Declined</button>
                          </>
                        )}
                        {r.offerStatus === 'Offer Accepted' && r.documentsStatus !== 'Verified' && (
                          <button
                            className="btn btn-sm"
                            onClick={() => act(
                              () => api.post(`/ats/offers/${r.id}/documents`, { documentsStatus: r.documentsStatus === 'Submitted' ? 'Verified' : 'Submitted' }),
                              `Documents ${r.documentsStatus === 'Submitted' ? 'verified' : 'marked submitted'}.`,
                            )}
                          >
                            {r.documentsStatus === 'Submitted' ? 'Verify Documents' : 'Documents Submitted'}
                          </button>
                        )}
                        {r.offerStatus === 'Offer Accepted' && r.documentsStatus === 'Verified' && (
                          <Link className="btn btn-sm" to="/ats/joining">Go to Joining</Link>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan="11" style={{ padding: 0 }}><IntJoinEmpty loading={data.loading} filters={filters} onClear={() => setFilters(EMPTY_INTJOIN_FILTERS)} noun="offers" title="Nobody is at offer stage yet." /></td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager page={page} noun="offers" />

      {dialog?.kind === 'release' && (
        <ReleaseForm
          row={dialog.row}
          onClose={() => setDialog(null)}
          onSubmit={(body) => act(
            () => api.post(`/ats/offers/${dialog.row.id}/release`, body),
            `Offer released to ${dialog.row.candidate.name}.`,
          ).then((ok) => ok && setDialog(null))}
        />
      )}
      {dialog?.kind === 'decline' && (
        <DeclineForm
          row={dialog.row}
          onClose={() => setDialog(null)}
          onSubmit={(reason) => act(
            () => api.post(`/ats/offers/${dialog.row.id}/decline`, { reason }),
            'Offer marked declined — the candidate is not rejected automatically.',
          ).then((ok) => ok && setDialog(null))}
        />
      )}
    </div>
  );
}

function ReleaseForm({ row, onClose, onSubmit }) {
  const internal = row.hiringType === 'TeamLink Internal Hire';
  const [offeredCtc, setOfferedCtc] = useState(row.offeredCtc || '');
  const [offerDate, setOfferDate] = useState(new Date().toISOString().slice(0, 10));
  const [offerNotes, setOfferNotes] = useState('');
  return (
    <Panel
      title={`${internal ? 'Internal offer' : 'Offer'} — ${row.candidate.name}`}
      subtitle={`${row.requirement.title} · ${internal ? 'TeamLink internal hire' : row.requirement.client?.name}`}
      onClose={onClose}
    >
      <form onSubmit={(e) => { e.preventDefault(); onSubmit({ offeredCtc, offerDate, offerNotes }); }}>
        <div className="grid-3">
          <label className="field">
            <span>Offered CTC (annual, ₹) *</span>
            <input required type="number" min="1" value={offeredCtc} onChange={(e) => setOfferedCtc(e.target.value)} />
          </label>
          <label className="field">
            <span>Offer date *</span>
            <input required type="date" value={offerDate} onChange={(e) => setOfferDate(e.target.value)} />
          </label>
          <label className="field">
            <span>Notes</span>
            <input value={offerNotes} onChange={(e) => setOfferNotes(e.target.value)} placeholder="Optional" />
          </label>
        </div>
        <div className="small-muted" style={{ marginBottom: 10 }}>
          {internal
            ? 'A TeamLink internal hire is never invoiced. Once they join, Create HRMS Employee (Joining / Candidate 360) makes the HRMS employee record.'
            : `The offered CTC is what the placement fee is calculated on when this candidate joins — ${row.requirement.client?.name}'s agreed fee %, plus GST, less TDS.`}
        </div>
        <button className="btn btn-primary btn-sm" type="submit">Release offer</button>
      </form>
    </Panel>
  );
}

function DeclineForm({ row, onClose, onSubmit }) {
  const [reason, setReason] = useState('');
  return (
    <Panel title={`Offer declined — ${row.candidate.name}`} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); onSubmit(reason); }}>
        <label className="field" style={{ marginBottom: 10 }}>
          <span>Reason *</span>
          <textarea required rows="2" value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <div className="small-muted" style={{ marginBottom: 10 }}>
          A declined offer is recorded, not a rejection: the candidate stays where they are and the offer
          can be re-released.
        </div>
        <button className="btn btn-primary btn-sm" type="submit">Record decline</button>
      </form>
    </Panel>
  );
}
