import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api';
import ClientModuleTabs from '../components/ClientModuleTabs.jsx';
import Combo from '../components/Combo.jsx';
import {
  AGREEMENT_STATUS_CODES, agreementStatusLabel, agreementBadgeClass, agreementIsActive,
  requirementIsLive, protoDate,
} from '../atsVocab';

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
  ['SIGNED', 'Signed', 'Signed copy received — awaiting activation'],
  ['ACTIVE', 'Active', 'Requirements for this client can go live'],
  ['EXPIRED', 'Expired', 'Past its end date — requirements are blocked again'],
  ['REJECTED', 'Rejected', 'Declined by the client'],
];

export default function Agreements() {
  const navigate = useNavigate();
  const [clients, setClients] = useState([]);
  const [requirements, setRequirements] = useState([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    api.get('/clients').then((res) => setClients(res.data)).catch(() => setClients([]));
    api.get('/requirements').then((res) => setRequirements(res.data)).catch(() => setRequirements([]));
  }, []);

  const counts = useMemo(() => {
    const out = {};
    clients.forEach((c) => { out[c.agreementStatus] = (out[c.agreementStatus] || 0) + 1; });
    return out;
  }, [clients]);

  const blockedFor = (clientId) => requirements
    .filter((r) => r.clientId === clientId && !r.internal && !requirementIsLive(r.status)).length;
  const liveFor = (clientId) => requirements
    .filter((r) => r.clientId === clientId && requirementIsLive(r.status)).length;

  const rows = useMemo(() => clients.filter((c) => {
    if (statusFilter && c.agreementStatus !== statusFilter) return false;
    if (search && !`${c.name} ${c.agreementId || ''} ${c.clientCode || ''}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [clients, statusFilter, search]);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Clients</h1>
          <div className="page-sub">Agreements — the service agreement lifecycle across every client account</div>
        </div>
      </div>

      <ClientModuleTabs active="agreements" />

      <div className="notice">
        <div>
          <b>Agreement workflow.</b>
          {' Add Client → GST / TDS / Payment Terms → Agreement → Preview → Upload / Generate → '}
          Send to Client → Client View → Client Confirmation / Signed Copy → Agreement Active.
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
        <span className="cell-muted" style={{ fontSize: 12 }}>{`${rows.length} agreement(s)`}</span>
      </div>

      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Client</th><th>Client Code</th><th>Agreement ID</th><th>Status</th>
              <th>Source</th><th>Fee %</th><th>Agreement Date</th><th>Expiry</th>
              <th>Signed By</th><th>Live Reqs</th><th>Held at Gate</th><th>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="row-link" onClick={() => navigate(`/clients/${c.id}?tab=agreement`)}>
                <td>{c.name}</td>
                <td className="cell-muted">{c.clientCode || '—'}</td>
                <td className="cell-muted">{c.agreementId || '—'}</td>
                <td><span className={`status ${agreementBadgeClass(c.agreementStatus)}`}>{agreementStatusLabel(c.agreementStatus)}</span></td>
                <td className="cell-muted">{c.agreementSource || '—'}</td>
                <td className="cell-muted">{c.agreementFeePercent != null ? `${c.agreementFeePercent}%` : '—'}</td>
                <td className="cell-muted">{c.agreementStart || (c.agreementActivatedAt ? protoDate(c.agreementActivatedAt) : '—')}</td>
                <td className="cell-muted">{c.agreementEnd || '—'}</td>
                <td className="cell-muted">{c.agreementSignedBy || '—'}</td>
                <td>{liveFor(c.id)}</td>
                <td>
                  {agreementIsActive(c.agreementStatus)
                    ? <span className="cell-muted">0</span>
                    : <b style={{ color: blockedFor(c.id) ? 'var(--red)' : undefined }}>{blockedFor(c.id)}</b>}
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <Link className="btn btn-sm" to={`/clients/${c.id}?tab=agreement`}>Open Agreement</Link>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan="12" className="small-muted" style={{ padding: 16 }}>No agreements match.</td></tr>
            )}
          </tbody>
        </table>
      </div>

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
