import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api';
import ClientsTabs from '../components/clients/ClientsTabs.jsx';
import Combo from '../components/Combo.jsx';
import AtsDataTools from '../components/AtsDataTools.jsx';
import Pager, { usePaged } from '../components/Pager.jsx';
import {
  AGREEMENT_STATUS_CODES, agreementStatusLabel, agreementBadgeClass, agreementIsActive,
  protoDate,
} from '../atsVocab';
import { useAuth } from '../context/AuthContext.jsx';
import { can } from '../permissions';
import { downloadAgreementPdf } from '../components/agreements/AgreementPanel.jsx';

// The monthly agreement report (moved here from the Requirements screen's old
// "Agreement Report" sub-tab, §5): counts from each client's own milestones;
// months with no activity are not shown.
const MONTH = (value) => {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return { key: d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }), at: d };
};

// ---------------------------------------------------------------------------
// The Agreements tab of the Clients module.
//
//   Add Client → GST / TDS / Payment Terms → Agreement → Preview
//     → Upload / Generate → Send to Client → Client View
//     → Client Confirmation / Signed Copy → Agreement Active
//
// This screen is the whole pipeline in one place: every client's agreement,
// which stage it is at, and how many of that client's requirements are held
// at the gate behind it. The per-client actions live on the client's own
// Agreement tab (ClientDetail), which this links straight into.
// ---------------------------------------------------------------------------
const STEPS = [
  ['DRAFT', 'Draft', 'Generated or uploaded, not yet sent'],
  ['SENT', 'Sent', 'Out with the client for signature'],
  ['VIEWED', 'Viewed', 'The client has opened the document'],
  ['CLIENT_CONFIRMATION_PENDING', 'Client Confirmation Pending', 'Confirmation formally requested'],
  ['SIGNED', 'Signed', 'Client e-signed and confirmed by OTP — awaiting TeamLink countersign'],
  ['ACTIVE', 'Active', 'Countersigned — requirements can go live and profiles can be shared'],
  ['EXPIRED', 'Expired', 'Past its end date — requirements are blocked again'],
  ['REJECTED', 'Rejected', 'Declined by the client'],
];

export default function Agreements() {
  const navigate = useNavigate();
  const { user } = useAuth();
  // The client desk (SA / Admin / Manager / Asst Manager / BDE) works from the
  // Clients data and opens the client's Agreement tab; the accounts desk sees
  // the signed agreements only, read-only (GET /agreement/list decides).
  // Clients role spec: the desk view is for a login with the Clients list
  // AND Agreement Lifecycle view (Admin, Management, BDE — own clients —,
  // Accounts). A TL has the Clients list but no agreements (§5 ❌); a
  // Recruiter has neither.
  const clientList = can(user, 'ats', 'clients', 'Client List', 'view');
  const lifecycleView = can(user, 'ats', 'clients', 'Agreement Lifecycle', 'view');
  const desk = clientList && lifecycleView;
  const blocked = clientList && !lifecycleView;
  const [clients, setClients] = useState([]);
  const [execution, setExecution] = useState(new Map());
  const [listError, setListError] = useState('');
  const [showReport, setShowReport] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (blocked) return;
    api.get('/agreement/list')
      .then((res) => {
        const rows = res.data.rows || [];
        setExecution(new Map(rows.map((r) => [r.id, r])));
        if (!desk) {
          setClients(rows.map((r) => ({
            id: r.id, name: r.name, clientCode: r.clientCode, agreementId: r.agreementId, agreementStatus: r.status,
            agreementSignedBy: r.signedBy, agreementSignedAt: r.signedAt, agreementActivatedAt: r.activatedAt,
            agreementStart: r.start, agreementEnd: r.end, agreementFeePercent: r.feePercent, createdAt: r.sentAt,
          })));
        }
      })
      .catch((err) => setListError(err.response?.data?.error || ''));
    if (desk) api.get('/clients').then((res) => setClients(res.data)).catch(() => setClients([]));
  }, [desk, blocked]);
  const openRow = (c) => navigate(desk ? `/clients/${c.id}?tab=agreement` : `/agreements/${c.id}`);

  const counts = useMemo(() => {
    const out = {};
    clients.forEach((c) => { out[c.agreementStatus] = (out[c.agreementStatus] || 0) + 1; });
    return out;
  }, [clients]);

  // Counted by the server in the viewer's scope (GET /clients): live
  // requirements, and those held at Draft / Agreement Check behind the gate.
  const byId = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients]);
  const blockedFor = (clientId) => byId.get(clientId)?.gatedRequirements || 0;
  const liveFor = (clientId) => byId.get(clientId)?.openRequirements || 0;

  const months = useMemo(() => {
    const out = {};
    const bump = (value, key) => {
      const m = MONTH(value);
      if (!m) return;
      out[m.key] = out[m.key] || { created: 0, signed: 0, active: 0, expired: 0, pending: 0, at: m.at };
      out[m.key][key] += 1;
    };
    clients.forEach((c) => {
      bump(c.createdAt, 'created');
      if (c.agreementSignedAt) bump(c.agreementSignedAt, 'signed');
      if (c.agreementStatus === 'ACTIVE') bump(c.agreementActivatedAt || c.agreementSignedAt || c.createdAt, 'active');
      if (c.agreementStatus === 'EXPIRED') bump(c.agreementEnd, 'expired');
      if (['DRAFT', 'SENT'].includes(c.agreementStatus)) bump(c.createdAt, 'pending');
    });
    return Object.entries(out).sort((a, b) => b[1].at - a[1].at);
  }, [clients]);

  const rows = useMemo(() => clients.filter((c) => {
    if (statusFilter && c.agreementStatus !== statusFilter) return false;
    if (search && !`${c.name} ${c.agreementId || ''} ${c.clientCode || ''}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [clients, statusFilter, search]);
  const paged = usePaged(rows);

  if (blocked) {
    return (
      <div>
        <ClientsTabs active="agreements" />
        <div className="notice">Client agreements are not part of your Clients view — they are with the BDE team, Accounts and Admin.</div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Agreements</h1>
          <div className="page-sub">{desk ? 'Jobs workspace — the service agreement lifecycle across every client account' : 'Signed client agreements — view and download (read-only)'}</div>
        </div>
        {/* Template · Import · Export: the agreement register (the rows shown)
            and agreement status / fee / date updates for clients on file. */}
        {desk && <AtsDataTools
          module="agreements"
          kinds={['agreements']}
          onImported={() => api.get('/clients').then((res) => setClients(res.data)).catch(() => {})}
          body={() => ({ ids: statusFilter || search ? rows.map((c) => c.id) : null })}
        />}
      </div>

      <ClientsTabs active="agreements" />

      {listError && !desk && <div className="notice red"><span>{listError}</span></div>}
      <div className="notice">
        <div>
          <b>Agreement workflow.</b>
          {' Add Client → Generate → Send to client (email + SMS + WhatsApp) → client reads it, presses OK, Proceed → '}
          e-signs (type / draw / upload) → confirms with an OTP on their registered mobile → Signed → TeamLink countersigns → Active.
          <div style={{ marginTop: 4 }}>
            A client requirement cannot go live until its agreement is <b>Active</b>. Requirements raised
            before that are parked at <b>Agreement Check</b> — the server refuses to open them, it does not
            merely hide the button.
          </div>
        </div>
      </div>

      <div className="statbar">
        {STEPS.map(([code, label]) => (
          <div
            key={code}
            className="statitem"
            style={{ cursor: 'pointer', borderColor: statusFilter === code ? 'var(--navy)' : undefined }}
            onClick={() => setStatusFilter(statusFilter === code ? '' : code)}
          >
            <div className="n">{counts[code] || 0}</div>
            <div className="l">{label}</div>
          </div>
        ))}
      </div>

      <div className="filter-row">
        <input placeholder="Search client, code or agreement id…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Combo value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All agreement statuses</option>
          {AGREEMENT_STATUS_CODES.map((s) => <option key={s} value={s}>{agreementStatusLabel(s)}</option>)}
        </Combo>
        <button type="button" className="btn btn-sm" disabled={!search && !statusFilter} onClick={() => { setSearch(''); setStatusFilter(''); }}>Clear filters</button>
        <span className="cell-muted" style={{ fontSize: 12 }}>{`${rows.length} agreement(s)`}</span>
      </div>

      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Client</th><th>Client Code</th><th>Agreement ID</th><th>Status</th>
              <th>Source</th><th>Fee %</th><th>Agreement Date</th><th>Expiry</th>
              <th>Signed By</th><th>Execution</th>{desk && <><th>Live Reqs</th><th>Held at Gate</th></>}<th>Action</th>
            </tr>
          </thead>
          <tbody>
            {paged.slice.map((c) => (
              <tr key={c.id} className="row-link" onClick={() => openRow(c)}>
                <td>{c.name}</td>
                <td className="cell-muted">{c.clientCode || '—'}</td>
                <td className="cell-muted">{c.agreementId || '—'}</td>
                <td><span className={`status ${agreementBadgeClass(c.agreementStatus)}`}>{agreementStatusLabel(c.agreementStatus)}</span></td>
                <td className="cell-muted">{c.agreementSource || '—'}</td>
                <td className="cell-muted">{c.agreementFeePercent != null ? `${c.agreementFeePercent}%` : '—'}</td>
                <td className="cell-muted">{c.agreementStart || (c.agreementActivatedAt ? protoDate(c.agreementActivatedAt) : '—')}</td>
                <td className="cell-muted">{c.agreementEnd || '—'}</td>
                <td className="cell-muted">{c.agreementSignedBy || '—'}</td>
                <td>
                  {execution.get(c.id)?.awaitingCountersign && <span className="status pending">Awaiting countersign</span>}
                  {execution.get(c.id)?.linkExpired && <span className="status rejected">Link expired</span>}
                  {!execution.get(c.id)?.awaitingCountersign && !execution.get(c.id)?.linkExpired && <span className="cell-muted">—</span>}
                </td>
                {desk && <td>{liveFor(c.id)}</td>}
                {desk && (
                  <td>
                    {agreementIsActive(c.agreementStatus)
                      ? <span className="cell-muted">0</span>
                      : <b style={{ color: blockedFor(c.id) ? 'var(--red)' : undefined }}>{blockedFor(c.id)}</b>}
                  </td>
                )}
                <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
                  <Link className="btn btn-sm" to={desk ? `/clients/${c.id}?tab=agreement` : `/agreements/${c.id}`}>Open Agreement</Link>
                  {execution.get(c.id)?.pdfAvailable && (
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => downloadAgreementPdf(c.id, `${c.agreementId || 'agreement'}-${String(c.name).replace(/[^\w.-]+/g, '-')}`).catch(() => {})}>PDF</button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={desk ? 13 : 11} className="small-muted" style={{ padding: 16 }}>No agreements match.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager page={paged} noun="agreements" />

      <div style={{ margin: '14px 0 6px' }}>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowReport((v) => !v)}>
          {showReport ? '▾ Monthly agreement report' : '▸ Monthly agreement report'}
        </button>
      </div>
      {showReport && (months.length === 0
        ? <div className="empty-mini">No agreement activity recorded yet.</div>
        : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Month</th><th>Agreements Created</th><th>Signed</th><th>Active</th><th>Expired</th><th>Pending</th></tr></thead>
              <tbody>
                {months.map(([key, m]) => (
                  <tr key={key}>
                    <td><b>{key}</b></td><td>{m.created}</td><td className="cell-muted">{m.signed}</td>
                    <td className="cell-muted">{m.active}</td><td className="cell-muted">{m.expired}</td><td className="cell-muted">{m.pending}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      <div className="section-label">What each status means</div>
      <div className="card">
        {STEPS.map(([code, label, note]) => (
          <div className="kv" key={code}>
            <span className="k"><span className={`status ${agreementBadgeClass(code)}`}>{label}</span></span>
            <span className="cell-muted">{note}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
