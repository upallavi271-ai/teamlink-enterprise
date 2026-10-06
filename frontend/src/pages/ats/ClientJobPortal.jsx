import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { can, canDecideAsClient, canSeeClientPortal, isClientUser } from '../../permissions';
import ClientPortal from '../portal/ClientPortal.jsx';
import { Modal } from '../../components/proto.jsx';
import Combo from '../../components/Combo.jsx';
import AtsDataTools from '../../components/AtsDataTools.jsx';
import { REJECTION_REASONS_BY_SIDE } from '../../atsVocab';

// ---------------------------------------------------------------------------
// C. The CLIENT portal view.
//
// A client sees three things and only three things:
//   * their own requirements,
//   * whether each one is published to the job portal,
//   * the candidates SHARED with them, with where each one stands.
//
// What they must NEVER see is not hidden here — it is never selected on the
// server (backend/src/routes/jobPortal.js GET /client). There is no posting
// control, no sync state, no integration setting, no recruiter/TL/BDE name,
// no other client and no internal note anywhere in that payload, so there is
// nothing for this screen to leak even if it tried.
//
// The permission that opens this screen is `requirements` / `Client Job
// Portal`. A client holds that and does NOT hold `Job Portal Workspace`,
// which is exactly why the internal posting/sync workspace is unreachable for
// them — a 403 from the API, not a missing link.
// ---------------------------------------------------------------------------

const stageBadge = (s) => {
  if (s === 'REJECTED') return 'rejected';
  if (s === 'HOLD') return 'hold';
  if (['CLIENT_SHORTLISTED', 'SELECTED', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'].includes(s)) return 'selected';
  if (['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED'].includes(s)) return 'interview';
  if (s === 'OFFER') return 'offer';
  return 'review';
};

const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

// User notes #4 — a CLIENT login gets the full client portal (profile,
// requirements, candidates for review, interviews, selected & joined,
// agreement). Anyone else holding Client Job Portal (Super Admin) keeps the
// cross-client view below.
export default function ClientJobPortalRoute() {
  const { user } = useAuth();
  return isClientUser(user) ? <ClientPortal /> : <ClientJobPortal />;
}

function ClientJobPortal() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  // A client's Reject asks WHY first. The recruiter who has to find this
  // candidate another role needs the reason; a bare 'rejected' tells them nothing.
  const [rejecting, setRejecting] = useState(null);
  const [view, setView] = useState('requirements');

  const load = useCallback(() => {
    api.get('/job-portal/client')
      .then((r) => setData(r.data))
      .catch((e) => setError(e.response?.data?.error || 'Could not load the portal. Please try again.'));
  }, []);
  useEffect(load, [load]);

  // One place for every write, so nothing can reject uncaught.
  //
  // The confirmation must not claim a move that did not happen: Request
  // Interview records the ask and changes no stage, so it says so instead of
  // reading back whatever stage the candidate was already sitting at.
  function decide(app, decision, label, extra) {
    setBusy(app.applicationId); setError(''); setNotice('');
    Promise.resolve(api.post(`/job-portal/client/applications/${app.applicationId}/decision`, { decision, ...(extra || {}) }))
      .then((r) => {
        setNotice(decision === 'REQUEST_INTERVIEW'
          ? `${app.name}: interview asked. The recruiter will book it.`
          : `${app.name}: ${r.data.action} — now at ${r.data.stageLabel}.`);
        load();
      })
      .catch((e) => setError(e.response?.data?.error || `${label} did not work. Please try again.`))
      .finally(() => setBusy(''));
  }

  const requirements = data?.requirements || [];
  const candidates = data?.candidates || [];
  // Whether the Review / Shortlist / Reject / Request Interview buttons appear
  // is the engine's answer, sent with the payload — not a role test here.
  const canDecide = canDecideAsClient(user) && !!data?.permissions?.decide;
  // The candidate record is the client's existing, already-permitted screen —
  // the same can() the API enforces decides whether to offer the link.
  const canOpenCandidate = can(user, 'ats', 'candidates', 'Candidate List', 'view');

  // Same matrix, same refusal wording as everywhere else — typing the URL is
  // not access, and the API refuses the call regardless.
  if (!canSeeClientPortal(user)) {
    return (
      <div>
        <div className="page-head"><div><h1>Job Portal</h1></div></div>
        <div className="notice red">
          This portal is not part of your role.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Job Portal</h1>
          <div className="page-sub">
            {data?.company ? `${data.company} · ` : ''}
            Your jobs and the people shared with you.
          </div>
        </div>
        {/* Export only: the client's own requirements / shared candidates. */}
        <AtsDataTools module="client-portal" kinds={[]} body={() => ({ view: view === 'candidates' ? 'candidates' : 'requirements' })} />
      </div>

      {/* No Clients · Requirements · Agreements · Job Portal strip any more
          (2026-09-29): the Job Portal is candidate intake, not a Requirements
          tab, so this page is simply the client's own portal. */}

      {/* .notice is display:flex — one child, or every phrase becomes a column. */}
      {error && <div className="notice red"><span>{error}</span></div>}
      {notice && <div className="notice"><span>{notice}</span></div>}

      <div className="stat-row" style={{ marginBottom: 16 }}>
        <div className="stat-cell"><div className="v">{requirements.length || '—'}</div><div className="l">Your jobs</div></div>
        <div className="stat-cell"><div className="v">{requirements.filter((r) => r.published).length || '—'}</div><div className="l">Published</div></div>
        <div className="stat-cell"><div className="v">{requirements.filter((r) => r.live).length || '—'}</div><div className="l">Open now</div></div>
        <div className="stat-cell"><div className="v">{candidates.length || '—'}</div><div className="l">People shared with you</div></div>
      </div>

      <div className="tabs" style={{ marginBottom: 12 }}>
        <div className={`tab${view === 'requirements' ? ' active' : ''}`} onClick={() => setView('requirements')}>
          Jobs
        </div>
        <div className={`tab${view === 'candidates' ? ' active' : ''}`} onClick={() => setView('candidates')}>
          People shared with me
        </div>
      </div>

      {view === 'requirements' && (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Job ID</th><th>Job</th><th>Department</th><th>Location</th>
                <th>Openings</th><th>Raised</th><th>Published</th><th>People shared</th>
              </tr>
            </thead>
            <tbody>
              {requirements.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.reqCode || r.id.slice(0, 8)}</b></td>
                  <td>{r.title}</td>
                  <td className="cell-muted">{r.department || '—'}</td>
                  <td className="cell-muted">{r.location || '—'}</td>
                  <td className="cell-muted">{r.openings || 1}</td>
                  <td className="cell-muted">{fmt(r.raisedAt)}</td>
                  <td>
                    {r.published
                      ? <span className="status active">Published{r.publishedAt ? ` · ${fmt(r.publishedAt)}` : ''}</span>
                      : <span className="status pending">Not published yet</span>}
                  </td>
                  <td className="cell-muted">{r.sharedCandidates}</td>
                </tr>
              ))}
              {!requirements.length && (
                <tr><td colSpan="8" className="small-muted" style={{ padding: 16 }}>
                  {data ? 'No jobs for your company yet.' : 'Loading…'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {view === 'candidates' && (
        <>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Candidate</th><th>Experience</th><th>Location</th><th>Key skills</th>
                  <th>For</th><th>Status</th><th>Interview</th><th>Your decision</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => {
                  const req = requirements.find((r) => r.id === c.requirementId);
                  return (
                    <tr key={c.applicationId}>
                      <td><b>{c.name}</b></td>
                      <td className="cell-muted">{c.experienceYears != null ? `${c.experienceYears} yrs` : '—'}</td>
                      <td className="cell-muted">{c.location || '—'}</td>
                      <td className="cell-muted">{c.skills || '—'}</td>
                      <td className="cell-muted">{req ? req.title : '—'}</td>
                      <td><span className={`status ${stageBadge(c.stage)}`}>{c.stageLabel}</span></td>
                      <td className="cell-muted">
                        {c.interviewAt ? `${fmt(c.interviewAt)}${c.interviewStatus ? ` · ${c.interviewStatus}` : ''}` : '—'}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          {canOpenCandidate && (
                            <button className="btn btn-sm" onClick={() => navigate(`/candidates/${c.candidateId}`)}>
                              Review
                            </button>
                          )}
                          {canDecide && c.stage !== 'REJECTED' && (
                            <>
                              {c.stage !== 'CLIENT_SHORTLISTED' && (
                                <button
                                  className="btn btn-sm btn-primary"
                                  disabled={busy === c.applicationId}
                                  onClick={() => decide(c, 'SHORTLIST', 'Shortlist')}
                                >Shortlist</button>
                              )}
                              <button
                                className="btn btn-sm"
                                disabled={busy === c.applicationId}
                                onClick={() => decide(c, 'REQUEST_INTERVIEW', 'Request interview')}
                              >Request interview</button>
                              <button
                                className="btn btn-sm btn-ghost"
                                disabled={busy === c.applicationId}
                                onClick={() => setRejecting({ app: c, reasonCategory: '', reasonDetail: '' })}
                              >Reject</button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!candidates.length && (
                  <tr><td colSpan="8" className="small-muted" style={{ padding: 16 }}>
                    No candidates have been shared with you yet.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 6 }}>
            <strong>Request interview</strong> asks the recruiter to book one for you.
          </div>
        </>
      )}

      {rejecting && (
        <Modal
          title={`Reject — ${rejecting.app.name}`}
          onClose={() => setRejecting(null)}
          footer={(
            <>
              <button className="btn" onClick={() => setRejecting(null)}>Cancel</button>
              <button
                className="btn btn-danger"
                disabled={!rejecting.reasonCategory && !rejecting.reasonDetail.trim()}
                onClick={() => {
                  const r = rejecting;
                  setRejecting(null);
                  decide(r.app, 'REJECT', 'Reject', { reasonCategory: r.reasonCategory, reasonDetail: r.reasonDetail });
                }}
              >Reject candidate</button>
            </>
          )}
        >
          <label className="field">
            <span>Why? *</span>
            <Combo creatable value={rejecting.reasonCategory} onChange={(e) => setRejecting({ ...rejecting, reasonCategory: e.target.value })}>
              <option value="">— Select —</option>
              {REJECTION_REASONS_BY_SIDE.Client.map((x) => <option key={x} value={x}>{x}</option>)}
            </Combo>
          </label>
          <label className="field">
            <span>Anything more specific</span>
            <textarea rows="3" value={rejecting.reasonDetail} onChange={(e) => setRejecting({ ...rejecting, reasonDetail: e.target.value })} />
          </label>
        </Modal>
      )}
    </div>
  );
}
