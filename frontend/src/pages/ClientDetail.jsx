import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import api from '../api';
import Modal from '../components/Modal.jsx';
import {
  agreementStatusLabel, agreementBadgeClass, stageLabel, stageBadgeClass,
  requirementStatusLabel, protoDate,
} from '../atsVocab';
import { canManageAgreement, isClientUser } from '../permissions';


// The prototype's clientDetail() (line 7487): left column holds Client
// details, Requirements (n) and Candidates shared with this client; the right
// column holds Billing history. The agreement itself lives behind
// openAgreementModal() (line 7538).
const SHARED_STAGES = [
  'SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED',
  'INTERVIEW_COMPLETED', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'REJECTED',
];

export default function ClientDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [client, setClient] = useState(null);
  // Set when the API refuses this record for scope reasons.
  const [denied, setDenied] = useState('');
  const [requirements, setRequirements] = useState([]);
  const [signing, setSigning] = useState({ signedByName: '', signedByTitle: '' });
  const [signingLink, setSigningLink] = useState('');
  const [shared, setShared] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [error, setError] = useState('');
  const [showAgreement, setShowAgreement] = useState(false);

  function load() {
    api.get(`/clients/${id}`)
      .then((res) => setClient(res.data))
      .catch((err) => setDenied(err.response?.data?.error || 'This record is not available to you'));
    api.get(`/requirements?clientId=${id}`).then((res) => setRequirements(res.data));
    api.get('/applications')
      .then((res) => setShared(res.data.filter((a) => a.requirement?.clientId === id && SHARED_STAGES.includes(a.stage))))
      .catch(() => setShared([]));
    api.get('/invoices').then((res) => setInvoices(res.data.filter((i) => i.clientId === id))).catch(() => setInvoices([]));
  }
  useEffect(load, [id]);

  async function agreementAction(path) {
    setError('');
    try {
      const res = await api.post(`/clients/${id}/agreement/${path}`);
      if (res.data.signingPath) setSigningLink(`${window.location.origin}${res.data.signingPath}`);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not complete that action');
    }
  }

  async function confirmAgreement(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post(`/clients/${id}/agreement/confirm`, signing);
      setSigning({ signedByName: '', signedByTitle: '' });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not e-sign this agreement');
    }
  }

  if (denied) return <div className="notice">{denied}</div>;
  if (!client) return <div className="small-muted">Loading…</div>;

  const c = client;
  const canManage = canManageAgreement(user);
  const canSign = isClientUser(user) && user?.clientId === c.id && c.agreementStatus === 'SENT';
  const status = agreementStatusLabel(c.agreementStatus);

  return (
    <div>
      <Link className="small-muted" to="/clients">← Back to clients</Link>
      <div className="page-head" style={{ marginTop: 10 }}>
        <div>
          <h1 style={{ fontSize: 20 }}>{c.name}</h1>
          <div className="page-sub">{[c.industry, c.location].filter(Boolean).join(' · ') || '—'}</div>
        </div>
        <span className={`status ${agreementBadgeClass(c.agreementStatus)}`}>{status}</span>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="two-col">
        <div>
          <div className="card section">
            <h3 style={{ fontSize: 13, marginBottom: 10 }}>Client details</h3>
            <div className="grid-2">
              <div className="kv">
                <span className="k">Contact</span>
                <span>{[c.contactName, c.contactEmail, c.contactPhone].filter(Boolean).join(' — ') || '—'}</span>
              </div>
              <div className="kv"><span className="k">Account Manager</span><span>{c.accountManager || '—'}</span></div>
              <div className="kv"><span className="k">GST</span><span>{c.gst || '—'}</span></div>
              <div className="kv"><span className="k">TDS</span><span>{c.tdsPercent != null ? `${c.tdsPercent}%` : '—'}</span></div>
              <div className="kv"><span className="k">Payment Terms</span><span>{c.paymentTerms || '—'}</span></div>
              <div className="kv"><span className="k">Agreement Date</span><span>{c.agreementActivatedAt ? protoDate(c.agreementActivatedAt) : '—'}</span></div>
            </div>
            <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                className={`btn btn-sm${c.agreementStatus === 'ACTIVE' ? '' : ' btn-primary'}`}
                onClick={() => setShowAgreement(true)}
              >
                {c.agreementStatus === 'ACTIVE' ? 'View Agreement' : 'Open Agreement'}
              </button>
            </div>
          </div>

          <div className="card section">
            <h3 style={{ fontSize: 14, marginBottom: 10 }}>{`Requirements (${requirements.length})`}</h3>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Requirement</th><th>Openings</th><th>Status</th></tr></thead>
                <tbody>
                  {requirements.map((r) => (
                    <tr key={r.id} className="row-link">
                      <td><Link to={`/requirements/${r.id}`}>{r.title}</Link></td>
                      <td>{r.openings}</td>
                      <td><span className="status active">{requirementStatusLabel(r.status)}</span></td>
                    </tr>
                  ))}
                  {requirements.length === 0 && (
                    <tr><td colSpan="3" className="small-muted" style={{ padding: 16 }}>No requirements yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card section">
            <h3 style={{ fontSize: 14, marginBottom: 10 }}>Candidates shared with this client</h3>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Candidate</th><th>Requirement</th><th>Stage</th><th>Action</th></tr></thead>
                <tbody>
                  {shared.map((a) => (
                    <tr key={a.id}>
                      <td>{a.candidate?.name}</td>
                      <td>{a.requirement?.title}</td>
                      <td><span className={`status ${stageBadgeClass(a.stage)}`}>{stageLabel(a.stage)}</span></td>
                      <td><Link className="btn btn-sm" to={`/candidates/${a.candidateId}`}>View</Link></td>
                    </tr>
                  ))}
                  {shared.length === 0 && (
                    <tr><td colSpan="4" className="small-muted" style={{ padding: 16 }}>No candidates shared yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {canSign && (
            <div className="card section">
              <h3 style={{ fontSize: 14, marginBottom: 10 }}>Review &amp; e-sign</h3>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, maxHeight: 280, overflowY: 'auto', margin: 0 }}>
                {c.agreementDocument}
              </pre>
              <form onSubmit={confirmAgreement} className="filter-row" style={{ marginTop: 10, marginBottom: 0 }}>
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
              </form>
            </div>
          )}
        </div>

        <div>
          <div className="card">
            <h3 style={{ fontSize: 13, marginBottom: 10 }}>Billing history</h3>
            {invoices.map((i) => (
              <div className="kv" key={i.id}>
                <span className="k"><Link to={`/invoices/${i.id}`}>{i.invoiceNumber || i.id}</Link></span>
                <span className={`status ${i.status === 'Paid' ? 'active' : i.status === 'Overdue' ? 'rejected' : 'pending'}`}>{i.status}</span>
              </div>
            ))}
            {invoices.length === 0 && <div className="small-muted">No invoices yet.</div>}
          </div>
        </div>
      </div>

      {showAgreement && (
        <Modal
          title={`Recruitment / Staffing Services Agreement — ${c.name}`}
          onClose={() => setShowAgreement(false)}
          footer={(
            <>
              <button className="btn" onClick={() => setShowAgreement(false)}>Close</button>
              {canManage && (
                <button
                  className="btn"
                  onClick={() => agreementAction('generate')}
                  disabled={['CONFIRMED', 'ACTIVE'].includes(c.agreementStatus)}
                >
                  {c.agreementDocument ? 'Regenerate from client data' : 'Generate Agreement'}
                </button>
              )}
              {canManage && c.agreementStatus === 'SENT' && (
                <button className="btn" onClick={() => agreementAction('resend')}>Resend</button>
              )}
              {canManage && !['CONFIRMED', 'ACTIVE', 'SENT'].includes(c.agreementStatus) && (
                <button
                  className="btn btn-primary"
                  onClick={() => agreementAction('send')}
                  disabled={!c.agreementDocument}
                >
                  Send to Client
                </button>
              )}
              {canManage && c.agreementStatus === 'CONFIRMED' && (
                <button className="btn btn-primary" onClick={() => agreementAction('activate')}>Activate Agreement</button>
              )}
            </>
          )}
        >
          <div className="notice amber">
            Generated from TeamLink&apos;s standard agreement template using this client&apos;s own commercial
            terms. The client signs it through the tokenised signing link — no external e-signature or DSC
            provider is connected.
          </div>
          <div className="kv">
            <span className="k">Status</span>
            <span><span className={`status ${agreementBadgeClass(c.agreementStatus)}`}>{status}</span></span>
          </div>
          <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 18, margin: '12px 0', maxHeight: 340, overflowY: 'auto' }}>
            <div style={{ textAlign: 'center', marginBottom: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--navy)' }}>TeamLink Consultants</div>
              <div style={{ fontWeight: 600, fontSize: 13, marginTop: 6 }}>RECRUITMENT / STAFFING SERVICES AGREEMENT</div>
              <div className="small-muted" style={{ fontStyle: 'italic' }}>
                {`Between ${c.name} ("Client") and TeamLink Consultants (OPC) Pvt. Ltd. ("Consultant")`}
              </div>
            </div>
            {c.agreementDocument
              ? (
                <div className="small-muted" style={{ whiteSpace: 'pre-line', fontSize: 12, lineHeight: 1.6 }}>
                  {c.agreementDocument}
                </div>
              )
              : <div className="small-muted">No agreement generated for this client yet.</div>}
          </div>
          <div className="small-muted" style={{ marginBottom: 6 }}>Agreement history</div>
          <div className="kv"><span className="k">Draft</span><span>{protoDate(c.createdAt)}</span></div>
          {c.agreementSentAt && <div className="kv"><span className="k">Sent</span><span>{protoDate(c.agreementSentAt)}</span></div>}
          {c.agreementViewedAt && <div className="kv"><span className="k">Viewed</span><span>{protoDate(c.agreementViewedAt)}</span></div>}
          {c.agreementSignedAt && (
            <div className="kv">
              <span className="k">Signed</span>
              <span>{`${protoDate(c.agreementSignedAt)} · ${c.agreementSignedBy || '—'}${c.agreementSignedByTitle ? ` (${c.agreementSignedByTitle})` : ''}`}</span>
            </div>
          )}
          {c.agreementActivatedAt && <div className="kv"><span className="k">Active</span><span>{protoDate(c.agreementActivatedAt)}</span></div>}
          {signingLink && (
            <div className="section" style={{ marginTop: 12 }}>
              <div className="small-muted">Signing link for the client (they do not need a TeamLink login):</div>
              <input readOnly value={signingLink} onFocus={(e) => e.target.select()} style={{ width: '100%' }} />
            </div>
          )}
          {c.agreementStatus === 'CONFIRMED' && (
            <div className="small-muted" style={{ marginTop: 8 }}>
              The client has signed. Activate the agreement to let requirements for this client go live.
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
