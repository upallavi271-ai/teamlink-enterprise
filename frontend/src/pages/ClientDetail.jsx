import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import api from '../api';
import Modal from '../components/Modal.jsx';
import {
  agreementStatusLabel, agreementBadgeClass, agreementIsActive, agreementIsSigned,
  stageLabel, stageBadgeClass, requirementStatusLabel, requirementBadgeClass,
  interviewStatusLabel, protoDate,
} from '../atsVocab';
import { isClientUser } from '../permissions';

// ---------------------------------------------------------------------------
// Client Detail.
//
// The old screen showed six fields. A client profile actually carries:
//   Company Name · Client Code · Industry · Business Type · Location · Address
//   · GST · TDS · Payment Terms · Account Manager · BDE · Agreement Status
//   · Agreement Date · Agreement Expiry · Contact Persons · Billing Contact
//   · Recruitment Contact
// and nine tabs:
//   Overview · Requirements · Candidates · Interviews · Selections · Joinings
//   · Invoices · Agreement · Activity
//
// Everything below the header comes from ONE scoped endpoint,
// GET /clients/:id/overview, which is where the redaction happens: a client
// login is never sent fee internals, salary internals, recruiter notes, AI
// evaluation detail or any other client's data. Hiding it here would be a
// courtesy; not sending it is the control.
// ---------------------------------------------------------------------------
const TABS = [
  ['overview', 'Overview'],
  ['requirements', 'Requirements'],
  ['candidates', 'Candidates'],
  ['interviews', 'Interviews'],
  ['selections', 'Selections'],
  ['joinings', 'Joinings'],
  ['invoices', 'Invoices'],
  ['agreement', 'Agreement'],
  ['activity', 'Activity'],
];

const EMPTY_OVERVIEW = {
  requirements: [], candidates: [], interviews: [], selections: [],
  joinings: [], invoices: [], activity: [], redacted: false,
};

function Row({ k, children }) {
  return <div className="kv"><span className="k">{k}</span><span>{children || '—'}</span></div>;
}

function Empty({ cols, children }) {
  return <tr><td colSpan={cols} className="small-muted" style={{ padding: 16 }}>{children}</td></tr>;
}

export default function ClientDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'overview';
  const setTab = (t) => setParams(t === 'overview' ? {} : { tab: t }, { replace: true });

  const [client, setClient] = useState(null);
  const [data, setData] = useState(EMPTY_OVERVIEW);
  // Set when the API refuses this record for scope reasons.
  const [denied, setDenied] = useState('');
  const [signing, setSigning] = useState({ signedByName: '', signedByTitle: '' });
  const [signingLink, setSigningLink] = useState('');
  const [upload, setUpload] = useState({ open: false, fileName: '', document: '' });
  const [reject, setReject] = useState({ open: false, reason: '' });
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [showAgreement, setShowAgreement] = useState(false);

  function load() {
    api.get(`/clients/${id}`)
      .then((res) => setClient(res.data))
      .catch((err) => setDenied(err.response?.data?.error || 'This record is not available to you'));
    api.get(`/clients/${id}/overview`)
      .then((res) => setData({ ...EMPTY_OVERVIEW, ...res.data }))
      .catch(() => setData(EMPTY_OVERVIEW));
  }
  useEffect(load, [id]);

  async function agreementAction(path, body) {
    setError('');
    setNote('');
    try {
      const res = await api.post(`/clients/${id}/agreement/${path}`, body || {});
      if (res.data.signingPath) setSigningLink(`${window.location.origin}${res.data.signingPath}`);
      if (res.data.requirementsWaiting) {
        setNote(`${res.data.requirementsWaiting} requirement(s) were held at Agreement Check and can now be opened.`);
      }
      load();
      return true;
    } catch (err) {
      setError(err.response?.data?.error || 'Could not complete that action');
      return false;
    }
  }

  async function confirmAgreement(e) {
    e.preventDefault();
    if (await agreementAction('confirm', signing)) setSigning({ signedByName: '', signedByTitle: '' });
  }

  if (denied) return <div className="notice">{denied}</div>;
  if (!client) return <div className="small-muted">Loading…</div>;

  const c = client;
  const p = c.permissions || {};
  // The lifecycle buttons are the SAME can() results the API enforces.
  const canManage = !!p.lifecycle || !!p.share;
  const mine = isClientUser(user) && user?.clientId === c.id;
  const canSign = !!p.approve && mine && ['SENT', 'VIEWED', 'CLIENT_CONFIRMATION_PENDING'].includes(c.agreementStatus);
  const status = agreementStatusLabel(c.agreementStatus);
  const address = [c.houseNumber, c.street, c.landmark, c.area, c.location, c.state, c.pincode, c.country]
    .filter(Boolean).join(', ');

  const counts = {
    requirements: data.requirements.length,
    candidates: data.candidates.length,
    interviews: data.interviews.length,
    selections: data.selections.length,
    joinings: data.joinings.length,
    invoices: data.invoices.length,
    activity: data.activity.length,
  };

  return (
    <div>
      <Link className="small-muted" to="/clients">← Back to clients</Link>
      <div className="page-head" style={{ marginTop: 10 }}>
        <div>
          <h1 style={{ fontSize: 20 }}>{c.name}</h1>
          <div className="page-sub">
            {[c.clientCode, c.industry, c.businessType, c.location].filter(Boolean).join(' · ') || '—'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className={`status ${agreementBadgeClass(c.agreementStatus)}`}>{status}</span>
          <button className="btn btn-sm" onClick={() => setShowAgreement(true)}>
            {agreementIsActive(c.agreementStatus) ? 'View Agreement' : 'Open Agreement'}
          </button>
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}
      {note && <div className="notice">{note}</div>}
      {data.redacted && (
        <div className="notice">
          You are signed in as {c.name}. This view shows your own company, your requirements and the
          candidates shared with you — internal recruiter notes, AI evaluation detail, fee and salary
          internals and every other client&apos;s data are not sent to this login at all.
        </div>
      )}
      {!agreementIsActive(c.agreementStatus) && counts.requirements > 0 && (
        <div className="notice amber">
          The service agreement is <b>{status}</b>. Client requirements for {c.name} cannot go live until it
          is Active.
        </div>
      )}

      <div className="tabs" style={{ marginBottom: 16 }}>
        {TABS.map(([key, label]) => (
          <div key={key} className={`tab${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>
            {label}
            {counts[key] != null && counts[key] > 0 ? ` (${counts[key]})` : ''}
          </div>
        ))}
      </div>

      {/* ---------------------------------------------------------------- */}
      {tab === 'overview' && (
        <div className="two-col">
          <div>
            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>Company</h3>
              <div className="grid-2">
                <div>
                  <Row k="Company Name">{c.name}</Row>
                  <Row k="Client Code">{c.clientCode}</Row>
                  <Row k="Industry">{c.industry}</Row>
                  <Row k="Business Type">{c.businessType}</Row>
                  <Row k="Location">{c.location}</Row>
                </div>
                <div>
                  <Row k="Legal Name">{c.legalName}</Row>
                  <Row k="Client Type">{c.clientType}</Row>
                  <Row k="Website">{c.website}</Row>
                  <Row k="Status">{c.status}</Row>
                  <Row k="Priority">{c.priority}</Row>
                </div>
              </div>
              <Row k="Address">{address}</Row>
            </div>

            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>Commercial terms</h3>
              <div className="grid-2">
                <div>
                  <Row k="GST">{c.gst}</Row>
                  <Row k="GST %">{c.gstPercent != null ? `${c.gstPercent}%` : null}</Row>
                  <Row k="PAN">{c.pan}</Row>
                </div>
                <div>
                  <Row k="TDS">{c.tdsPercent != null ? `${c.tdsPercent}%` : null}</Row>
                  <Row k="TAN">{c.tan}</Row>
                  <Row k="Placement Fee">{c.agreementFeePercent != null ? `${c.agreementFeePercent}% of annual CTC` : null}</Row>
                </div>
              </div>
              <Row k="Payment Terms">{c.paymentTerms}</Row>
              <Row k="Invoice Trigger">{c.invoiceTrigger}</Row>
              <Row k="Guarantee Period">{c.guaranteePeriod}</Row>
            </div>

            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>Contact persons</h3>
              <div className="section-label">Primary contact</div>
              <Row k="Name">{[c.contactName, c.contactDesignation].filter(Boolean).join(' · ')}</Row>
              <Row k="Reach">{[c.contactEmail, c.contactPhone, c.contactWhatsApp].filter(Boolean).join(' · ')}</Row>
              <div className="section-label">Secondary contact</div>
              <Row k="Name">{[c.secondaryContactName, c.secondaryContactDesignation].filter(Boolean).join(' · ')}</Row>
              <Row k="Reach">{[c.secondaryContactEmail, c.secondaryContactPhone].filter(Boolean).join(' · ')}</Row>
              <div className="section-label">Billing contact</div>
              <Row k="Name">{[c.billingContactName, c.billingContactDesignation].filter(Boolean).join(' · ')}</Row>
              <Row k="Reach">{[c.billingContactEmail, c.billingContactPhone].filter(Boolean).join(' · ')}</Row>
              <div className="section-label">Recruitment contact</div>
              <Row k="Name">{[c.recruitmentContactName, c.recruitmentContactDesignation].filter(Boolean).join(' · ')}</Row>
              <Row k="Reach">{[c.recruitmentContactEmail, c.recruitmentContactPhone].filter(Boolean).join(' · ')}</Row>
            </div>
          </div>

          <div>
            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>Ownership</h3>
              <Row k="Account Manager">{c.accountManager}</Row>
              <Row k="BDE">{c.bdeOwner}</Row>
              <Row k="Owner Department">{c.ownerDepartment}</Row>
            </div>
            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>Agreement</h3>
              <Row k="Agreement Status"><span className={`status ${agreementBadgeClass(c.agreementStatus)}`}>{status}</span></Row>
              <Row k="Agreement ID">{c.agreementId}</Row>
              <Row k="Agreement Date">{c.agreementStart || (c.agreementActivatedAt ? protoDate(c.agreementActivatedAt) : null)}</Row>
              <Row k="Agreement Expiry">{c.agreementEnd}</Row>
              <Row k="Template">{c.agreementTemplate}</Row>
              <Row k="Source">{c.agreementSource}</Row>
              <div className="divider" />
              <button className="btn btn-sm" style={{ width: '100%', justifyContent: 'center' }} onClick={() => setTab('agreement')}>
                Go to the agreement workflow →
              </button>
            </div>
            {!data.redacted && (
              <div className="card">
                <h3 style={{ fontSize: 13, marginBottom: 10 }}>Risk</h3>
                <Row k="Risk Flag">{c.riskFlag}</Row>
                <Row k="Notes">{c.riskNotes}</Row>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {tab === 'requirements' && (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Requirement ID</th><th>Job Title</th><th>Department</th><th>Location</th>
                <th>Openings</th><th>Priority</th>
                {!data.redacted && <><th>Recruiter</th><th>BDE</th></>}
                <th>Target Date</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.requirements.map((r) => (
                <tr key={r.id} className="row-link">
                  <td><Link to={`/requirements/${r.id}`}>{r.reqCode || r.id.slice(0, 8)}</Link></td>
                  <td>{r.title}</td>
                  <td className="cell-muted">{r.department || '—'}</td>
                  <td className="cell-muted">{r.location || '—'}</td>
                  <td className="cell-muted">{r.openings}</td>
                  <td className="cell-muted">{r.priority}</td>
                  {!data.redacted && <><td className="cell-muted">{r.recruiterName || '—'}</td><td className="cell-muted">{r.bdeName || '—'}</td></>}
                  <td className="cell-muted">{r.targetDate || r.closingDate || '—'}</td>
                  <td><span className={`status ${requirementBadgeClass(r.status)}`}>{requirementStatusLabel(r.status)}</span></td>
                </tr>
              ))}
              {!data.requirements.length && <Empty cols={10}>No requirements in your scope for this client.</Empty>}
            </tbody>
          </table>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {tab === 'candidates' && (
        <>
          {data.redacted && (
            <div className="notice">
              Candidates shared with you. Resume scores, AI evaluation detail, recruiter notes, sourcing
              channel and salary expectations are internal and are not part of this response.
            </div>
          )}
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Candidate</th><th>Requirement</th><th>Location</th><th>Experience</th>
                  <th>Current Role</th>
                  {!data.redacted && <><th>Match</th><th>AI Score</th></>}
                  <th>Stage</th><th />
                </tr>
              </thead>
              <tbody>
                {data.candidates.map((a) => (
                  <tr key={a.id}>
                    <td>{a.candidateName}</td>
                    <td className="cell-muted">{a.requirementCode || a.requirementTitle}</td>
                    <td className="cell-muted">{a.candidateLocation || '—'}</td>
                    <td className="cell-muted">{a.candidateExperience != null ? `${a.candidateExperience} yrs` : '—'}</td>
                    <td className="cell-muted">{a.candidateDesignation || '—'}</td>
                    {!data.redacted && (
                      <>
                        <td className="cell-muted">{a.matchScore != null ? `${a.matchScore}%` : '—'}</td>
                        <td className="cell-muted">{a.aiInterviewScore != null ? `${a.aiInterviewScore}%` : '—'}</td>
                      </>
                    )}
                    <td><span className={`status ${stageBadgeClass(a.stage)}`}>{stageLabel(a.stage)}</span></td>
                    <td><Link className="btn btn-sm" to={`/candidates/${a.candidateId}`}>View</Link></td>
                  </tr>
                ))}
                {!data.candidates.length && <Empty cols={9}>No candidates yet.</Empty>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ---------------------------------------------------------------- */}
      {tab === 'interviews' && (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>Interview</th><th>Candidate</th><th>Requirement</th><th>When</th><th>Round</th><th>Type / Mode</th><th>Interviewer</th><th>Status</th><th>Result</th></tr>
            </thead>
            <tbody>
              {data.interviews.map((a) => (
                <tr key={a.id}>
                  <td>{a.interviewCode || '—'}</td>
                  <td>{a.candidateName}</td>
                  <td className="cell-muted">{a.requirementCode || a.requirementTitle}</td>
                  <td className="cell-muted">{a.interviewAt ? protoDate(a.interviewAt) : '—'}</td>
                  <td className="cell-muted">{a.interviewRound || '—'}</td>
                  <td className="cell-muted">{[a.interviewType, a.interviewMode].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="cell-muted">{a.interviewer || '—'}</td>
                  <td><span className="status review">{interviewStatusLabel(a.interviewStatus)}</span></td>
                  <td className="cell-muted">{a.interviewResult || '—'}</td>
                </tr>
              ))}
              {!data.interviews.length && <Empty cols={9}>No interviews scheduled for this client yet.</Empty>}
            </tbody>
          </table>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {tab === 'selections' && (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>Candidate</th><th>Requirement</th><th>Stage</th>{!data.redacted && <th>Offered CTC</th>}<th>Joining Date</th></tr>
            </thead>
            <tbody>
              {data.selections.map((a) => (
                <tr key={a.id}>
                  <td>{a.candidateName}</td>
                  <td className="cell-muted">{a.requirementCode || a.requirementTitle}</td>
                  <td><span className={`status ${stageBadgeClass(a.stage)}`}>{stageLabel(a.stage)}</span></td>
                  {!data.redacted && <td className="cell-muted">{a.offeredCtc != null ? `₹${a.offeredCtc}` : '—'}</td>}
                  <td className="cell-muted">{a.joiningDate || '—'}</td>
                </tr>
              ))}
              {!data.selections.length && <Empty cols={5}>Nobody selected yet.</Empty>}
            </tbody>
          </table>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {tab === 'joinings' && (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>Candidate</th><th>Requirement</th><th>Joining Date</th>{!data.redacted && <th>Offered CTC</th>}<th>Stage</th></tr>
            </thead>
            <tbody>
              {data.joinings.map((a) => (
                <tr key={a.id}>
                  <td>{a.candidateName}</td>
                  <td className="cell-muted">{a.requirementCode || a.requirementTitle}</td>
                  <td className="cell-muted">{a.joiningDate || '—'}</td>
                  {!data.redacted && <td className="cell-muted">{a.offeredCtc != null ? `₹${a.offeredCtc}` : '—'}</td>}
                  <td><span className={`status ${stageBadgeClass(a.stage)}`}>{stageLabel(a.stage)}</span></td>
                </tr>
              ))}
              {!data.joinings.length && <Empty cols={5}>No joinings recorded yet.</Empty>}
            </tbody>
          </table>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {tab === 'invoices' && (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>Invoice</th><th>Date</th><th>Due</th><th>Amount</th><th>GST</th><th>TDS</th><th>Status</th></tr>
            </thead>
            <tbody>
              {data.invoices.map((i) => (
                <tr key={i.id}>
                  <td><Link to={`/invoices/${i.id}`}>{i.invoiceNumber || i.id.slice(0, 8)}</Link></td>
                  <td className="cell-muted">{i.invoiceDate}</td>
                  <td className="cell-muted">{i.dueDate || '—'}</td>
                  <td>{i.amount}</td>
                  <td className="cell-muted">{i.gst}</td>
                  <td className="cell-muted">{i.tds}</td>
                  <td><span className={`status ${i.status === 'Paid' ? 'active' : i.status === 'Overdue' ? 'rejected' : 'pending'}`}>{i.status}</span></td>
                </tr>
              ))}
              {!data.invoices.length && <Empty cols={7}>No invoices yet.</Empty>}
            </tbody>
          </table>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {tab === 'agreement' && (
        <div className="two-col">
          <div>
            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 6 }}>Agreement workflow</h3>
              <div className="small-muted" style={{ marginBottom: 10 }}>
                Add Client → GST / TDS / Payment Terms → Agreement → Preview → Upload / Generate →
                Send to Client → Client View → Client Confirmation / Signed Copy → Agreement Active
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {['DRAFT', 'SENT', 'VIEWED', 'CLIENT_CONFIRMATION_PENDING', 'SIGNED', 'ACTIVE'].map((s) => (
                  <span
                    key={s}
                    className={`status ${c.agreementStatus === s ? agreementBadgeClass(s) : ''}`}
                    style={c.agreementStatus === s ? undefined : { background: 'var(--line-soft)', color: 'var(--ink-soft)' }}
                  >
                    {agreementStatusLabel(s)}
                  </span>
                ))}
              </div>
              {['EXPIRED', 'REJECTED'].includes(c.agreementStatus) && (
                <div className="notice amber" style={{ marginTop: 10, marginBottom: 0 }}>
                  {`This agreement is ${status}.`}
                  {c.agreementRejectedReason ? ` Reason: ${c.agreementRejectedReason}` : ''}
                  {' Regenerate or upload a new document to restart the workflow.'}
                </div>
              )}
            </div>

            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>Document</h3>
              <div
                style={{
                  border: '1px solid var(--line)', borderRadius: 8, padding: 16,
                  maxHeight: 360, overflowY: 'auto', background: 'var(--paper)',
                }}
              >
                {c.agreementDocument
                  ? <div className="small-muted" style={{ whiteSpace: 'pre-line', fontSize: 12, lineHeight: 1.6 }}>{c.agreementDocument}</div>
                  : <div className="small-muted">No agreement generated for this client yet.</div>}
              </div>
              {canManage && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                  <button
                    className="btn btn-sm"
                    onClick={() => agreementAction('generate')}
                    disabled={agreementIsSigned(c.agreementStatus)}
                  >
                    {c.agreementDocument ? 'Regenerate from client data' : 'Generate Agreement'}
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => setUpload({ open: true, fileName: '', document: c.agreementDocument || '' })}
                    disabled={agreementIsSigned(c.agreementStatus)}
                  >
                    Upload Agreement
                  </button>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => agreementAction('send')}
                    disabled={!c.agreementDocument || !['DRAFT', 'REJECTED', 'EXPIRED'].includes(c.agreementStatus)}
                  >
                    Send to Client
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => agreementAction('resend')}
                    disabled={!['SENT', 'VIEWED', 'CLIENT_CONFIRMATION_PENDING'].includes(c.agreementStatus)}
                  >
                    Resend
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => agreementAction('request-confirmation')}
                    disabled={!['SENT', 'VIEWED'].includes(c.agreementStatus)}
                  >
                    Request Client Confirmation
                  </button>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => agreementAction('activate')}
                    disabled={c.agreementStatus !== 'SIGNED'}
                  >
                    Activate Agreement
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => agreementAction('expire')}
                    disabled={!['ACTIVE', 'SIGNED'].includes(c.agreementStatus)}
                  >
                    Mark Expired
                  </button>
                </div>
              )}
              {signingLink && (
                <div className="section" style={{ marginTop: 12 }}>
                  <div className="small-muted">Signing link for the client (no TeamLink login needed):</div>
                  <input readOnly value={signingLink} onFocus={(e) => e.target.select()} style={{ width: '100%' }} />
                </div>
              )}
            </div>

            {canSign && (
              <div className="card section">
                <h3 style={{ fontSize: 14, marginBottom: 10 }}>Review &amp; e-sign</h3>
                <form onSubmit={confirmAgreement} className="filter-row" style={{ marginBottom: 0 }}>
                  <input
                    required
                    placeholder="Type your full name to sign"
                    value={signing.signedByName}
                    onChange={(e) => setSigning({ ...signing, signedByName: e.target.value })}
                  />
                  <input
                    placeholder="Designation (optional)"
                    value={signing.signedByTitle}
                    onChange={(e) => setSigning({ ...signing, signedByTitle: e.target.value })}
                  />
                  <button className="btn btn-sm btn-primary" type="submit">E-sign agreement</button>
                  <button className="btn btn-sm btn-danger" type="button" onClick={() => setReject({ open: true, reason: '' })}>
                    Reject
                  </button>
                </form>
              </div>
            )}
          </div>

          <div>
            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>Agreement record</h3>
              <Row k="Status"><span className={`status ${agreementBadgeClass(c.agreementStatus)}`}>{status}</span></Row>
              <Row k="Agreement ID">{c.agreementId}</Row>
              <Row k="Required">{c.agreementRequired}</Row>
              <Row k="Template">{c.agreementTemplate}</Row>
              <Row k="Source">{c.agreementSource}</Row>
              <Row k="Agreement Date">{c.agreementStart}</Row>
              <Row k="Agreement Expiry">{c.agreementEnd}</Row>
              <Row k="Fee">{c.agreementFeePercent != null ? `${c.agreementFeePercent}%` : null}</Row>
              <Row k="Signed Copy">{c.agreementSignedCopyName}</Row>
              {canManage && (
                <button
                  className="btn btn-sm"
                  style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
                  onClick={() => {
                    const fileName = window.prompt('File name of the signed copy you are attaching');
                    if (fileName) agreementAction('signed-copy', { fileName });
                  }}
                >
                  Attach signed copy
                </button>
              )}
            </div>
            <div className="card">
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>History</h3>
              <Row k="Draft">{protoDate(c.createdAt)}</Row>
              <Row k="Sent">{c.agreementSentAt ? protoDate(c.agreementSentAt) : null}</Row>
              <Row k="Viewed">{c.agreementViewedAt ? protoDate(c.agreementViewedAt) : null}</Row>
              <Row k="Confirmation requested">{c.agreementConfirmationRequestedAt ? protoDate(c.agreementConfirmationRequestedAt) : null}</Row>
              <Row k="Signed">
                {c.agreementSignedAt
                  ? `${protoDate(c.agreementSignedAt)} · ${c.agreementSignedBy || '—'}${c.agreementSignedByTitle ? ` (${c.agreementSignedByTitle})` : ''}`
                  : null}
              </Row>
              <Row k="Active">{c.agreementActivatedAt ? protoDate(c.agreementActivatedAt) : null}</Row>
              <Row k="Rejected">{c.agreementRejectedAt ? protoDate(c.agreementRejectedAt) : null}</Row>
            </div>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {tab === 'activity' && (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>When</th><th>Action</th><th>Entity</th><th>From</th><th>To</th>{!data.redacted && <th>By</th>}</tr></thead>
            <tbody>
              {data.activity.map((a) => (
                <tr key={a.id}>
                  <td className="cell-muted">{protoDate(a.createdAt)}</td>
                  <td>{a.action}</td>
                  <td className="cell-muted">{a.entity}</td>
                  <td className="cell-muted">{a.fromValue || '—'}</td>
                  <td className="cell-muted">{a.toValue || '—'}</td>
                  {!data.redacted && <td className="cell-muted">{a.by || 'System'}</td>}
                </tr>
              ))}
              {!data.activity.length && <Empty cols={6}>No activity recorded yet.</Empty>}
            </tbody>
          </table>
        </div>
      )}

      {upload.open && (
        <Modal
          title="Upload agreement"
          size="wide"
          onClose={() => setUpload({ ...upload, open: false })}
          footer={(
            <>
              <button className="btn" onClick={() => setUpload({ ...upload, open: false })}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  if (await agreementAction('upload', { document: upload.document, fileName: upload.fileName })) {
                    setUpload({ open: false, fileName: '', document: '' });
                  }
                }}
              >
                Store uploaded agreement
              </button>
            </>
          )}
        >
          <div className="small-muted" style={{ marginBottom: 10 }}>
            This app has no file store, so an uploaded agreement is kept as its text — the same field the
            generated document uses, so Preview, Send and the client signing link all keep working.
          </div>
          <label className="field">
            <span>File name</span>
            <input value={upload.fileName} onChange={(e) => setUpload({ ...upload, fileName: e.target.value })} placeholder="Orbit-MSA-signed.pdf" />
          </label>
          <label className="field">
            <span>Agreement text</span>
            <textarea rows="14" value={upload.document} onChange={(e) => setUpload({ ...upload, document: e.target.value })} />
          </label>
        </Modal>
      )}

      {reject.open && (
        <Modal
          title="Reject agreement"
          onClose={() => setReject({ open: false, reason: '' })}
          footer={(
            <>
              <button className="btn" onClick={() => setReject({ open: false, reason: '' })}>Cancel</button>
              <button
                className="btn btn-danger"
                onClick={async () => {
                  if (await agreementAction('reject', { reason: reject.reason })) setReject({ open: false, reason: '' });
                }}
              >
                Reject agreement
              </button>
            </>
          )}
        >
          <label className="field">
            <span>Reason</span>
            <textarea rows="4" value={reject.reason} onChange={(e) => setReject({ ...reject, reason: e.target.value })} />
          </label>
        </Modal>
      )}

      {showAgreement && (
        <Modal
          title={`Recruitment / Staffing Services Agreement — ${c.name}`}
          size="wide"
          onClose={() => setShowAgreement(false)}
          footer={(
            <>
              <button className="btn" onClick={() => setShowAgreement(false)}>Close</button>
              <button className="btn btn-primary" onClick={() => { setShowAgreement(false); setTab('agreement'); }}>
                Open the agreement workflow →
              </button>
            </>
          )}
        >
          <div className="notice amber">
            Generated from TeamLink&apos;s standard agreement template using this client&apos;s own commercial
            terms. The client signs it through the tokenised signing link — no external e-signature or DSC
            provider is connected.
          </div>
          <Row k="Status"><span className={`status ${agreementBadgeClass(c.agreementStatus)}`}>{status}</span></Row>
          <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 18, margin: '12px 0', maxHeight: 340, overflowY: 'auto' }}>
            <div style={{ textAlign: 'center', marginBottom: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--navy)' }}>TeamLink Consultants</div>
              <div style={{ fontWeight: 600, fontSize: 13, marginTop: 6 }}>RECRUITMENT / STAFFING SERVICES AGREEMENT</div>
              <div className="small-muted" style={{ fontStyle: 'italic' }}>
                {`Between ${c.name} ("Client") and TeamLink Consultants (OPC) Pvt. Ltd. ("Consultant")`}
              </div>
            </div>
            {c.agreementDocument
              ? <div className="small-muted" style={{ whiteSpace: 'pre-line', fontSize: 12, lineHeight: 1.6 }}>{c.agreementDocument}</div>
              : <div className="small-muted">No agreement generated for this client yet.</div>}
          </div>
        </Modal>
      )}
    </div>
  );
}
