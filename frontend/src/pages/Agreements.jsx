import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import Combo from '../components/Combo.jsx';
import AtsDataTools from '../components/AtsDataTools.jsx';
import Pager, { usePaged } from '../components/Pager.jsx';
import ScopeLine from '../components/ScopeLine.jsx';
import { agreementIsActive } from '../atsVocab';
import { useAuth } from '../context/AuthContext.jsx';
import { can } from '../permissions';
import { downloadAgreementPdf } from '../components/agreements/AgreementPanel.jsx';
// Spec 6 — the step badge, and the Admin's agreement settings.
import { AgreementStepChip, AGREEMENT_STEPS, agreementStepLabel, agreementStepOf } from '../components/clients/AgreementStep.jsx';
import { AgreementSettingsButton } from '../components/agreements/AgreementSettings.jsx';
import AgreementLinkCard from '../components/agreements/AgreementLinkCard.jsx';
import Modal from '../components/Modal.jsx';

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
  // 2026-10-05: a TL VIEWS their team's client agreements (read-only list
  // from /agreement/list); the server says no to anyone else.
  const blocked = false;
  const [clients, setClients] = useState([]);
  const [execution, setExecution] = useState(new Map());
  const [listError, setListError] = useState('');
  // Never "No agreements yet" (or a bare count) while the list is loading.
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [showReport, setShowReport] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  // The agreement link dialog (SA / Admin): the client row it is for.
  const [linkFor, setLinkFor] = useState(null);

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
      .catch((err) => setListError(err.response?.data?.error || ''))
      .finally(() => { if (!desk) setLoaded(true); });
    if (desk) {
      api.get('/clients')
        .then((res) => { setClients(res.data); setLoadError(''); })
        .catch((err) => { setClients([]); setLoadError(err.response?.data?.error || 'Could not load agreements. Please try again.'); })
        .finally(() => setLoaded(true));
    }
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
    if (statusFilter && agreementStepOf(c.agreementStatus) !== statusFilter) return false;
    if (search && !`${c.name} ${c.agreementId || ''} ${c.clientCode || ''}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [clients, statusFilter, search]);
  const paged = usePaged(rows);

  if (blocked) {
    return (
      <div>
        <div className="notice">Agreements are not part of your role.</div>
      </div>
    );
  }

  // Spec 6 + simplicity checklist: the step is a choice with counts (zero
  // steps hidden), not a strip of eight boxes; 8 columns; plain words.
  const stepCounts = {};
  clients.forEach((c) => { const k = agreementStepOf(c.agreementStatus); stepCounts[k] = (stepCounts[k] || 0) + 1; });
  const stepOptions = [...AGREEMENT_STEPS.map(([k]) => k), 'REJECTED'].filter((k) => stepCounts[k]);
  const canSettings = can(user, 'ats', 'clients', 'Agreement Lifecycle', 'edit');

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Agreements</h1>
          <div className="page-sub">{desk ? 'Which client agreements need a next step?' : 'Signed client agreements. Read and download.'}</div>
          <div className="page-sub">{loaded ? <ScopeLine user={user} count={clients.length} noun="agreement" inline /> : 'Loading…'}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {canSettings && <AgreementSettingsButton />}
          {desk && <AtsDataTools
            module="agreements"
            kinds={['agreements']}
            onImported={() => api.get('/clients').then((res) => setClients(res.data)).catch(() => {})}
            body={() => ({ ids: statusFilter || search ? rows.map((c) => c.id) : null })}
          />}
        </div>
      </div>


      {listError && !desk && <div className="notice red"><span>{listError}</span></div>}
      {loadError && <div className="notice red"><span>{loadError}</span></div>}

      {/* 2026-10-05: signed by the client, waiting for TeamLink to sign & stamp
          and make it Active — one obvious chip with the count. */}
      {(stepCounts.SIGNED || 0) > 0 && (
        <div style={{ margin: '0 0 8px' }}>
          <button type="button" className={`btn btn-sm${statusFilter === 'SIGNED' ? ' btn-primary' : ''}`} onClick={() => setStatusFilter(statusFilter === 'SIGNED' ? '' : 'SIGNED')}>
            {`⏳ Waiting to be made Active (${stepCounts.SIGNED})`}
          </button>
        </div>
      )}
      <div className="filter-row">
        <input placeholder="Search client or agreement number…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Combo value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">Any step</option>
          {stepOptions.map((s) => <option key={s} value={s}>{`${agreementStepLabel(s)} (${stepCounts[s]})`}</option>)}
        </Combo>
        {(search || statusFilter) && <button type="button" className="btn btn-sm" onClick={() => { setSearch(''); setStatusFilter(''); }}>Clear all</button>}
        <span className="cell-muted" style={{ fontSize: 12 }}>{rows.length ? `${rows.length} agreement${rows.length === 1 ? '' : 's'}` : ''}</span>
      </div>

      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Client</th><th>Agreement no.</th><th>Step</th><th>Fee</th><th>Ends</th>
              {desk && <><th>Open jobs</th><th>Jobs waiting</th></>}<th />
            </tr>
          </thead>
          <tbody>
            {paged.slice.map((c) => (
              <tr key={c.id} className="row-link" onClick={() => openRow(c)}>
                <td><b>{c.name}</b></td>
                <td className="cell-muted">{c.agreementId || '—'}</td>
                <td>
                  <AgreementStepChip status={c.agreementStatus} />
                  {execution.get(c.id)?.awaitingCountersign && <span className="clrel-sub">Waiting for TeamLink to sign</span>}
                  {execution.get(c.id)?.linkExpired && <span className="clrel-sub" style={{ color: 'var(--red)' }}>Link ended. Make a new link.</span>}
                </td>
                <td className="cell-muted">{c.agreementFeePercent != null ? `${c.agreementFeePercent}%` : '—'}</td>
                <td className="cell-muted">{c.agreementEnd || (c.agreementStart ? 'Renews yearly' : '—')}</td>
                {desk && <td>{liveFor(c.id) || <span className="cell-muted">—</span>}</td>}
                {desk && (
                  <td>
                    {!agreementIsActive(c.agreementStatus) && blockedFor(c.id)
                      ? <b style={{ color: 'var(--amber)' }}>{blockedFor(c.id)}</b>
                      : <span className="cell-muted">—</span>}
                  </td>
                )}
                <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
                  {/* The row itself opens the agreement (no separate "Open"). */}
                  {execution.has(c.id) && (
                    <button type="button" className="btn btn-sm" onClick={() => navigate(`/agreements/${c.id}`)}>📄 View agreement</button>
                  )}
                  {canSettings && execution.has(c.id) && ['DRAFT', 'SENT', 'VIEWED'].includes(agreementStepOf(c.agreementStatus)) && (
                    <button type="button" className="btn btn-sm" onClick={() => setLinkFor(c)}>
                      {agreementStepOf(c.agreementStatus) === 'DRAFT' ? '🔗 Create agreement link' : '🔗 Link'}
                    </button>
                  )}
                  {execution.get(c.id)?.pdfAvailable && (
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => downloadAgreementPdf(c.id, `${c.agreementId || 'agreement'}-${String(c.name).replace(/[^\w.-]+/g, '-')}`).catch(() => {})}>PDF</button>
                  )}
                </td>
              </tr>
            ))}
            {!loaded && (
              <tr><td colSpan={desk ? 8 : 6} className="small-muted" style={{ padding: 16 }}>Loading agreements…</td></tr>
            )}
            {loaded && rows.length === 0 && (
              <tr><td colSpan={desk ? 8 : 6} className="small-muted" style={{ padding: 16 }}>{clients.length ? 'No agreements match. Clear the search or the step.' : 'No agreements yet. Add a client to make one.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager page={paged} noun="agreements" />
      {linkFor && (
        <Modal title={`Agreement link · ${linkFor.name}`} onClose={() => setLinkFor(null)}>
          <AgreementLinkCard
            clientId={linkFor.id}
            onChanged={() => api.get('/clients').then((res) => setClients(res.data)).catch(() => {})}
          />
        </Modal>
      )}

      <div style={{ margin: '14px 0 6px' }}>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowReport((v) => !v)}>
          {showReport ? '▾ Month by month' : '▸ Month by month'}
        </button>
      </div>
      {showReport && (months.length === 0
        ? <div className="empty-mini">No agreement activity yet.</div>
        : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Month</th><th>Drafts made</th><th>Signed</th><th>Active</th><th>Ended</th><th>Waiting</th></tr></thead>
              <tbody>
                {months.map(([key, m]) => (
                  <tr key={key}>
                    <td><b>{key}</b></td><td>{m.created || '—'}</td><td className="cell-muted">{m.signed || '—'}</td>
                    <td className="cell-muted">{m.active || '—'}</td><td className="cell-muted">{m.expired || '—'}</td><td className="cell-muted">{m.pending || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}
