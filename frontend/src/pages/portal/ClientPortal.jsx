import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { Modal } from '../../components/proto.jsx';
import EmptyState from '../../components/ui/EmptyState.jsx';
import { REJECTION_REASONS_BY_SIDE } from '../../atsVocab';
import {
  Chip, Tabs, Stat, KV, InterviewLine, fmtDate, fmtDateTime, openFile,
} from './portalUi.jsx';
// Per-role spec 2026-10-03: request a new requirement + own company reports.
import { useAuth } from '../../context/AuthContext.jsx';
import { can } from '../../permissions';
import RequestJobModal from '../../components/jobs/RequestJobModal.jsx';
import OwnResults from '../../components/OwnResults.jsx';

// ---------------------------------------------------------------------------
// THE CLIENT PORTAL (user notes #4, point 3) — what a client login sees.
//
//   Overview      company profile, agreement, what is waiting for them
//   Requirements  their requirements: status, openings, filled, candidates
//   Candidates    profiles SHARED with them: profile + resume, and their
//                 decision — Shortlist / Hold / Reject / Request interview,
//                 each with a note for the TeamLink team
//   Interviews    the interview schedule for their candidates
//   Selected & Joined
//   Agreement     summary + a link to the agreement screen (view / e-sign)
//   Invoices      only when the app gives this login invoice access
//
// Everything comes from GET /api/portal/client, which picks every field by
// name: no recruiter / TL / BDE names, no internal notes, no internal stage
// codes, no AI or match scores, no other client. Decisions go through the
// existing POST /api/job-portal/client/applications/:id/decision.
// ---------------------------------------------------------------------------

const DECISIONS = {
  SHORTLIST: { title: 'Shortlist', verb: 'Shortlist candidate', hint: 'We will arrange the interview with you.' },
  HOLD: { title: 'Keep on hold', verb: 'Put on hold', hint: 'The profile stays with you; tell us what you are waiting for.' },
  REJECT: { title: 'Reject', verb: 'Reject candidate', hint: 'Tell us why, so we can send better-matched profiles.' },
  REQUEST_INTERVIEW: { title: 'Request interview', verb: 'Request interview', hint: 'Suggest days / times — the recruiter will fix the slot.' },
};

// FIRST-LOGIN GUIDE (spec B1): three short lines the first time a client
// signs in, until they press Got it (remembered in this browser only).
const GUIDE = {
  BILLING: ['Here are your invoices from TeamLink.', 'Each line shows the amount, the due date and whether it is paid.', 'Questions about a bill? Reply to the invoice email.'],
  VIEWER: ['Your jobs: the openings TeamLink is filling for you.', 'Candidates: the people we sent you, with their resume.', 'Interviews: dates and times. You can view everything; your colleague with a Reviewer login gives the decisions.'],
  DEFAULT: ['Your jobs: the openings TeamLink is filling for you.', 'Candidates for review: open a person, read the resume, then press Shortlist, Hold or Reject.', 'Interviews: confirm the time, and after the interview tell us how it went.'],
};
function FirstLoginGuide({ user, type }) {
  const key = `tl_client_guide_${user?.id || ''}`;
  const [seen, setSeen] = useState(() => { try { return localStorage.getItem(key) === '1'; } catch { return false; } });
  if (seen || !user) return null;
  const lines = GUIDE[type] || GUIDE.DEFAULT;
  return (
    <div className="tlp-banner" role="note" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
      <b>Welcome! Here is how your portal works:</b>
      <ol style={{ margin: 0, paddingLeft: 18 }}>{lines.map((l) => <li key={l}>{l}</li>)}</ol>
      <button type="button" className="btn btn-sm btn-primary" onClick={() => { try { localStorage.setItem(key, '1'); } catch { /* ignore */ } setSeen(true); }}>Got it</button>
    </div>
  );
}

export default function ClientPortal() {
  const { user } = useAuth();
  const mayRequest = can(user, 'ats', 'requirements', 'Requirement Request', 'create');
  const mayReports = can(user, null, 'reports', 'Client Reports', 'view');
  const [requesting, setRequesting] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState('overview');
  const [deciding, setDeciding] = useState(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [reqFilter, setReqFilter] = useState('');
  const [show, setShow] = useState('waiting');

  const load = useCallback(() => {
    api.get('/portal/client')
      .then((r) => { setData(r.data); setError(''); })
      .catch((e) => setError(e.response?.data?.error || 'Could not load your portal.'));
  }, []);
  useEffect(load, [load]);

  const candidates = data?.candidates || [];
  const shownCandidates = useMemo(() => candidates.filter((c) => {
    if (show === 'waiting' && !c.canDecide) return false;
    if (reqFilter && c.requirementId !== reqFilter) return false;
    if (q && !`${c.name} ${c.skills || ''} ${c.currentRole || ''} ${c.location || ''}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  }), [candidates, show, reqFilter, q]);

  function submitDecision() {
    const d = deciding;
    if (d.decision === 'REJECT' && !d.reasonCategory && !d.note.trim()) return;
    setBusy(true); setError(''); setNotice('');
    api.post(`/job-portal/client/applications/${d.c.applicationId}/decision`, {
      decision: d.decision,
      comment: d.note.trim() || undefined,
      reasonCategory: d.decision === 'REJECT' ? (d.reasonCategory || undefined) : undefined,
      reasonDetail: d.decision === 'REJECT' ? (d.note.trim() || undefined) : undefined,
    })
      .then(() => {
        setNotice(`${d.c.name}: ${DECISIONS[d.decision].title.toLowerCase()} — recorded. The TeamLink team has been told.`);
        setDeciding(null);
        load();
      })
      .catch((e) => setError(e.response?.data?.error || 'That decision could not be saved.'))
      .finally(() => setBusy(false));
  }

  if (error && !data) return <div className="tlp"><div className="notice red"><span>{error}</span></div></div>;
  if (!data) return <div className="tlp small-muted">Loading your portal…</div>;

  // BILLING login (spec B1): invoices only — the server sends nothing else.
  if (data.billingOnly) {
    return (
      <div className="tlp">
        <div className="page-head">
          <div>
            <h1 className="tlp-hello">{data.company.name}</h1>
            <div className="tlp-sub">Your invoices from TeamLink</div>
          </div>
        </div>
        <FirstLoginGuide user={user} type="BILLING" />
        {data.invoices.length ? (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Invoice</th><th>Date</th><th>Due</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {data.invoices.map((v) => (
                  <tr key={v.id}>
                    <td><b>{v.invoiceNumber || v.id.slice(-6).toUpperCase()}</b></td>
                    <td>{v.invoiceDate || '—'}</td>
                    <td>{v.dueDate || '—'}</td>
                    <td>₹{Number((v.amount || 0) + (v.gst || 0)).toLocaleString('en-IN')}</td>
                    <td><Chip label={v.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState icon="🧾" title="No invoices yet" hint="When TeamLink raises an invoice for your company, it shows here." />}
      </div>
    );
  }

  const { company, requirements, interviews, hires, agreement, invoices, totals, permissions } = data;
  const canDecide = !!permissions?.decide;
  const upcoming = interviews.filter((i) => i.upcoming);
  const past = interviews.filter((i) => !i.upcoming);

  return (
    <div className="tlp">
      <div className="page-head">
        <div>
          <h1 className="tlp-hello">{company.name}</h1>
          <div className="tlp-sub">Your TeamLink client portal — requirements, candidates, interviews and joinings in one place</div>
        </div>
        {mayRequest && (
          <button type="button" className="btn btn-primary" onClick={() => setRequesting(true)}>Request a new requirement</button>
        )}
      </div>
      {requesting && (
        <RequestJobModal
          endpoint="/portal/client/requirement-requests"
          onClose={() => setRequesting(false)}
          onSent={(r) => { setRequesting(false); setNotice(r?.message || 'Request sent — TeamLink will review it.'); }}
        />
      )}

      {agreement?.needsYou && (
        <div className="tlp-banner amber">
          <span>Your service agreement is waiting for you: <b>{agreement.status}</b>.</span>
          {agreement.signPath
            ? <a className="btn btn-sm btn-primary" href={agreement.signPath}>Review, sign &amp; stamp →</a>
            : <Link className="btn btn-sm btn-primary" to={agreement.viewPath}>Review &amp; sign →</Link>}
        </div>
      )}
      {/* 2026-10-05: one obvious way to the agreement (view + download the PDF). */}
      {agreement && !agreement.needsYou && (
        <div style={{ margin: '0 0 10px' }}>
          <Link className="btn btn-sm" to={agreement.viewPath}>📄 View my agreement</Link>
        </div>
      )}
      {error && <div className="notice red"><span>{error}</span></div>}
      {notice && <div className="notice"><span>{notice}</span></div>}
      <FirstLoginGuide user={user} type={data.portalType} />

      <div className="tlp-stats">
        <Stat value={totals.openRequirements} label="Open requirements" onClick={() => setTab('requirements')} />
        <Stat value={totals.openings} label="Openings still to fill" onClick={() => setTab('requirements')} />
        <Stat value={totals.waitingForYou} label="Candidates waiting for your review" onClick={() => { setShow('waiting'); setTab('candidates'); }} />
        <Stat value={totals.upcomingInterviews} label="Upcoming interviews" onClick={() => setTab('interviews')} />
        <Stat value={totals.selected} label="Selected" onClick={() => setTab('hires')} />
        <Stat value={totals.joined} label="Joined" onClick={() => setTab('hires')} />
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'requirements', label: 'My Requirements', count: requirements.length },
          { id: 'candidates', label: 'Candidates for Review', count: candidates.length },
          { id: 'interviews', label: 'Interviews', count: interviews.length },
          { id: 'hires', label: 'Selected & Joined', count: hires.length },
          { id: 'agreement', label: 'Agreement' },
          invoices ? { id: 'invoices', label: 'Invoices', count: invoices.length } : null,
          mayReports ? { id: 'reports', label: 'Reports' } : null,
        ]}
      />

      {tab === 'reports' && mayReports && (
        <OwnResults
          endpoint="/portal/client/reports"
          title="Company report"
          sub="Your requirements and the candidates sent to you"
          mayExport={can(user, null, 'reports', 'Client Reports', 'export')}
          compact
        />
      )}

      {tab === 'overview' && (
        <div className="tlp-grid">
          <div className="tlp-card">
            <h3>Company profile</h3>
            <KV rows={[
              ['Company', company.name],
              ['Legal name', company.legalName],
              ['Client ID', company.clientCode],
              ['Industry', company.industry],
              ['Address', company.address],
              ['Website', company.website],
              ['GSTIN', company.gst],
              ['PAN', company.pan],
              ['Contact person', [company.contact.name, company.contact.designation].filter(Boolean).join(' · ')],
              ['Contact email', company.contact.email],
              ['Contact phone', company.contact.phone],
            ]}
            />
            <div className="tlp-muted" style={{ marginTop: 10 }}>Something wrong here? Tell your TeamLink contact and we will correct it.</div>
          </div>
          <div className="tlp-card">
            <h3>Waiting for you</h3>
            {candidates.filter((c) => c.canDecide).slice(0, 6).map((c) => (
              <div key={c.applicationId} className="tlp-item-top" style={{ padding: '6px 0', borderBottom: '1px solid #f1f5f9' }}>
                <div>
                  <div className="tlp-item-title">{c.name}</div>
                  <div className="tlp-meta">{c.requirement} · shared {fmtDate(c.sharedAt)}</div>
                </div>
                <button className="btn btn-sm" type="button" onClick={() => { setShow('waiting'); setTab('candidates'); setQ(c.name); }}>Review →</button>
              </div>
            ))}
            {!candidates.some((c) => c.canDecide) && <EmptyState compact icon="🎉" title="Nothing waiting for you" hint="New profiles appear here as soon as we share them." />}
            {upcoming.length > 0 && (
              <>
                <h3 style={{ marginTop: 14 }}>Next interview</h3>
                <div className="tlp-meta"><b>{upcoming[0].candidate}</b> · {upcoming[0].requirement}</div>
                <InterviewLine iv={upcoming[0]} />
              </>
            )}
          </div>
          <div className="tlp-card">
            <h3>Agreement</h3>
            {agreement ? (
              <>
                <KV rows={[['Agreement', agreement.id], ['Status', <Chip key="s" label={agreement.status} />], ['Valid from', agreement.start], ['Valid to', agreement.end], ['Signed on', agreement.signedAt ? fmtDate(agreement.signedAt) : null]]} />
                <div className="tlp-actions"><Link className="btn btn-sm" to={agreement.viewPath}>Open agreement →</Link></div>
              </>
            ) : <div className="tlp-muted">Your agreement is being prepared. You will get a link to review and sign it.</div>}
          </div>
        </div>
      )}

      {tab === 'requirements' && (
        requirements.length ? (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Req ID</th><th>Job</th><th>Location</th><th>Openings</th><th>Status</th>
                  <th>Profiles shared</th><th>Waiting for you</th><th>Interviews</th><th>Selected</th><th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {requirements.map((r) => (
                  <tr key={r.id}>
                    <td><b>{r.reqCode || r.id.slice(-6).toUpperCase()}</b></td>
                    <td>{r.title}<div className="tlp-meta">{[r.department, r.experience ? (/yr/i.test(r.experience) ? r.experience : `${r.experience} yrs`) : null, r.workMode].filter(Boolean).join(' · ')}</div></td>
                    <td className="cell-muted">{r.location || '—'}</td>
                    <td>{r.openings}<div className="tlp-meta">{r.filled} filled · {r.openLeft} left</div></td>
                    <td><Chip label={r.status} /></td>
                    <td>{r.shared}</td>
                    <td>{r.waitingForYou ? <button type="button" className="btn btn-sm" onClick={() => { setReqFilter(r.id); setShow('waiting'); setTab('candidates'); }}>{r.waitingForYou} →</button> : 0}</td>
                    <td>{r.interviews}</td>
                    <td>{r.selected}</td>
                    <td>{r.joined}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState title="No requirements yet" hint="Share a new requirement with your TeamLink contact and it will appear here." />
      )}

      {tab === 'candidates' && (
        <>
          <div className="tlp-filters">
            <input placeholder="Search name, skill, role or location…" value={q} onChange={(e) => setQ(e.target.value)} />
            <select value={reqFilter} onChange={(e) => setReqFilter(e.target.value)}>
              <option value="">All requirements</option>
              {requirements.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
            </select>
            <select value={show} onChange={(e) => setShow(e.target.value)}>
              <option value="waiting">Waiting for your decision</option>
              <option value="all">All shared with you</option>
            </select>
            {(q || reqFilter || show !== 'waiting') && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setQ(''); setReqFilter(''); setShow('waiting'); }}>Clear all</button>
            )}
          </div>
          <div className="tlp-list">
            {shownCandidates.map((c) => (
              <div className="tlp-item" key={c.applicationId}>
                <div className="tlp-item-top">
                  <div>
                    <div className="tlp-item-title">{c.name}</div>
                    <div className="tlp-meta">
                      {[c.currentRole, c.experienceYears != null ? `${c.experienceYears} yrs experience` : null, c.location].filter(Boolean).join(' · ') || '—'}
                    </div>
                    <div className="tlp-meta">For: <b>{c.requirement || '—'}</b> · shared {fmtDate(c.sharedAt)}</div>
                  </div>
                  <Chip label={c.status} tone={c.tone} />
                </div>
                <div className="tlp-box">
                  <KV rows={[
                    ['Key skills', c.skills],
                    ['Education', c.education],
                    ['Notice period', c.noticePeriod],
                  ]}
                  />
                </div>
                <InterviewLine iv={c.interview} />
                {c.yourDecisions.length > 0 && (
                  <div className="tlp-box">
                    <b>Your decisions</b>
                    {c.yourDecisions.map((d, i) => (
                      // eslint-disable-next-line react/no-array-index-key
                      <div key={i} className="tlp-meta">{fmtDate(d.at)} — {d.label}{d.note ? `: “${d.note}”` : ''}</div>
                    ))}
                  </div>
                )}
                {c.yourFeedback && (
                  <div className="tlp-box"><b>Your interview feedback:</b> {c.yourFeedback.recommendation}{c.yourFeedback.comment ? ` — ${c.yourFeedback.comment}` : ''}</div>
                )}
                <div className="tlp-actions">
                  {c.resume?.downloadable && (
                    <button type="button" className="btn btn-sm" onClick={() => openFile(`/portal/client/resume/${c.applicationId}`).catch((e) => setError(e.response?.status === 404 ? 'No resume file has been shared for this candidate yet.' : 'Could not open the resume.'))}>
                      📄 Resume
                    </button>
                  )}
                  {!c.resume?.downloadable && c.resume?.name && <span className="tlp-muted">Resume: {c.resume.name} (ask your TeamLink contact for the file)</span>}
                  {canDecide && c.canDecide && (
                    <>
                      {c.canShortlist && <button type="button" className="btn btn-sm btn-primary" onClick={() => setDeciding({ c, decision: 'SHORTLIST', note: '', reasonCategory: '' })}>Shortlist</button>}
                      {c.canShortlist && <button type="button" className="btn btn-sm" onClick={() => setDeciding({ c, decision: 'HOLD', note: '', reasonCategory: '' })}>Hold</button>}
                      <button type="button" className="btn btn-sm" onClick={() => setDeciding({ c, decision: 'REQUEST_INTERVIEW', note: '', reasonCategory: '' })}>Request interview</button>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDeciding({ c, decision: 'REJECT', note: '', reasonCategory: '' })}>Reject</button>
                    </>
                  )}
                </div>
              </div>
            ))}
            {!shownCandidates.length && (
              <EmptyState
                icon={show === 'waiting' ? '🎉' : '🗂️'}
                title={show === 'waiting' ? 'No candidates waiting for your decision' : 'No candidates shared with you yet'}
                hint={show === 'waiting' ? 'Switch to "All shared with you" to see earlier profiles.' : 'Profiles appear here as soon as TeamLink shares them with you.'}
              />
            )}
          </div>
        </>
      )}

      {tab === 'interviews' && (
        interviews.length ? (
          <div className="tlp-list">
            {[['Coming up', upcoming], ['Earlier', past]].map(([title, rows]) => rows.length > 0 && (
              <div key={title}>
                <div className="section-label" style={{ margin: '6px 0' }}>{title}</div>
                {rows.map((i) => (
                  <div className="tlp-item" key={`${i.applicationId}-${i.at}`} style={{ marginBottom: 8 }}>
                    <div className="tlp-item-title">{i.candidate}</div>
                    <div className="tlp-meta">{i.requirement}</div>
                    <InterviewLine iv={i} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : <EmptyState icon="📅" title="No interviews yet" hint="Shortlist a candidate or request an interview — the slot will show here once it is fixed." />
      )}

      {tab === 'hires' && (
        hires.length ? (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Candidate</th><th>Requirement</th><th>Status</th><th>Joining date</th></tr></thead>
              <tbody>
                {hires.map((h) => (
                  <tr key={h.applicationId}>
                    <td><b>{h.candidate}</b></td>
                    <td>{h.requirement || '—'}</td>
                    <td><Chip label={h.status} /></td>
                    <td>{h.joinedAt ? `Joined ${fmtDate(h.joinedAt)}` : (h.joiningDate || '—')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState icon="🤝" title="No one selected yet" hint="Candidates you select, and their joining dates, will be listed here." />
      )}

      {tab === 'agreement' && (
        <div className="tlp-card" style={{ maxWidth: 560 }}>
          <h3>Service agreement</h3>
          {agreement ? (
            <>
              <KV rows={[['Agreement', agreement.id], ['Status', <Chip key="s" label={agreement.status} />], ['Valid from', agreement.start], ['Valid to', agreement.end], ['Signed on', agreement.signedAt ? fmtDate(agreement.signedAt) : null], ['Active since', agreement.activatedAt ? fmtDate(agreement.activatedAt) : null]]} />
              <div className="tlp-actions">
                <Link className="btn btn-sm btn-primary" to={agreement.viewPath}>{agreement.needsYou ? 'Review & sign →' : 'Open agreement →'}</Link>
              </div>
            </>
          ) : <div className="tlp-muted">Your agreement is being prepared. You will receive a link to review and sign it.</div>}
        </div>
      )}

      {tab === 'invoices' && invoices && (
        invoices.length ? (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Invoice</th><th>Date</th><th>Due</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {invoices.map((v) => (
                  <tr key={v.id}>
                    <td><b>{v.invoiceNumber || v.id.slice(-6).toUpperCase()}</b></td>
                    <td>{v.invoiceDate || '—'}</td>
                    <td>{v.dueDate || '—'}</td>
                    <td>₹{Number((v.amount || 0) + (v.gst || 0)).toLocaleString('en-IN')}</td>
                    <td><Chip label={v.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState icon="🧾" title="No invoices yet" />
      )}

      {deciding && (
        <Modal
          title={`${DECISIONS[deciding.decision].title} — ${deciding.c.name}`}
          onClose={() => setDeciding(null)}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setDeciding(null)}>Cancel</button>
              <button
                type="button"
                className={`btn ${deciding.decision === 'REJECT' ? 'btn-danger' : 'btn-primary'}`}
                disabled={busy || (deciding.decision === 'REJECT' && !deciding.reasonCategory && !deciding.note.trim())}
                onClick={submitDecision}
              >{busy ? 'Saving…' : DECISIONS[deciding.decision].verb}</button>
            </>
          )}
        >
          <div className="tlp-muted" style={{ marginBottom: 10 }}>{DECISIONS[deciding.decision].hint}</div>
          {deciding.decision === 'REJECT' && (
            <label className="field">
              <span>Reason *</span>
              <select value={deciding.reasonCategory} onChange={(e) => setDeciding({ ...deciding, reasonCategory: e.target.value })}>
                <option value="">— Select —</option>
                {(REJECTION_REASONS_BY_SIDE.Client || []).map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </label>
          )}
          <label className="field">
            <span>{deciding.decision === 'REQUEST_INTERVIEW' ? 'Preferred days / times' : 'Your feedback for the TeamLink team'}</span>
            <textarea rows="3" value={deciding.note} onChange={(e) => setDeciding({ ...deciding, note: e.target.value })} />
          </label>
        </Modal>
      )}
      <div className="tlp-muted" style={{ marginTop: 16 }}>Last updated {fmtDateTime(new Date())}.</div>
    </div>
  );
}
