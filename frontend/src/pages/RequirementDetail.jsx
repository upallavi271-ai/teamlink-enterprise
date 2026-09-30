import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import api from '../api';
import Modal from '../components/Modal.jsx';
import Combo from '../components/Combo.jsx';
import Pager, { usePaged } from '../components/Pager.jsx';
// WORKFLOW ACTIONS ARE NOT VIEW/EDIT. The stages this login OWNS come from
// the permission engine (/auth/me workflow.allowedStages) — seeing the
// pipeline never implied being allowed to move a candidate through it.
import { can, canMoveToStage, workflowStages } from '../permissions';
import RequirementForm from '../components/RequirementForm.jsx';
import { useJobPortalUrl, jobPortalJobUrl } from './JobPortalRedirect.jsx';
import { PostedOnPanel, LocationCandidatesPanel } from '../components/jobs/RequirementReach.jsx';
import {
  PriorityChip, PipelineSteps, candidatesLink, ageText, slaInfo, lastActivityText, fmtWhen, fmtShort, nf, reqStatusTone,
} from '../components/jobs/reqFormat.jsx';
import StatusChip from '../components/ui/StatusChip.jsx';
import { useHierarchy } from '../components/HierarchyFilter.jsx';
import { assignCascade } from '../components/jobs/assignCascade.js';
import '../components/jobs/jobs.css';
import '../components/jobs/reqrole.css';
import {
  ALL_STAGE_CODES, stageLabel, stageBadgeClass,
  requirementStatusLabel, requirementBadgeClass, requirementIsLive,
  agreementStatusLabel, agreementBadgeClass,
  PORTAL_SYNC_STATUSES, protoDate,
  REJECTION_REASON_CATEGORIES, HOLD_REASON_CATEGORIES,
  REJECTED_BY_OPTIONS, REJECTION_REASONS_BY_SIDE,
} from '../atsVocab';

// ---------------------------------------------------------------------------
// REQUIREMENT DETAILS — ONE WORKSPACE (ATS review #2 §2, §7, §23, §24).
//
//   header · Priority · Age · SLA · Last activity · counts (Candidates /
//   Shortlisted / Interview / Selected / Joined — the same numbers the list's
//   quick drawer shows)
//   [Overview] [Candidates] [Recruiter] [Client] [Interviews] [Agreement] [Activity]
//
// FAST: the page used to download the whole candidate master twice (once to
// count matches on the server, once for the "Link a candidate" dropdown) —
// about 7 seconds. Now GET /requirements/:id returns the requirement and ITS
// OWN applications only; matching candidates load when asked for (Candidates
// tab), linking a candidate is a search, and the people / client lists load
// only when the assign or edit dialog opens. Activity and "who worked it"
// load when their tab is opened.
//
// Deep links: ?tab=candidates|recruiter|client|interviews|agreement|activity,
// ?action=assign (assignment dialog), ?action=edit (Edit Requirement), and the
// old #pipeline / #matching anchors (→ Candidates tab).
// ---------------------------------------------------------------------------

const list = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);

// The prototype's jobDescriptionHtml() (line 6398): the same document, shown
// internally with the closing date and the client blurb, and candidate-facing
// without them.
function JobDescription({ requirement: r, forCandidate }) {
  const row = (k, v) => (v ? <div className="kv" key={k}><span className="k">{k}</span><span>{v}</span></div> : null);
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 20, background: '#fff' }}>
      <h2 style={{ fontSize: 17, margin: '0 0 4px' }}>{r.title}</h2>
      <div className="small-muted" style={{ marginBottom: 14 }}>
        {[r.internal ? 'Internal TeamLink hiring' : r.client?.name, r.location || '—', r.workMode || '—'].join(' · ')}
      </div>
      <div className="section-label">About the role</div>
      <div className="small-muted" style={{ whiteSpace: 'pre-line', fontSize: 12.5, lineHeight: 1.7 }}>
        {r.jobDescription || r.description || 'No description recorded yet.'}
      </div>
      {r.responsibilities && (
        <>
          <div className="section-label">Responsibilities</div>
          <div className="small-muted" style={{ whiteSpace: 'pre-line', fontSize: 12.5, lineHeight: 1.7 }}>{r.responsibilities}</div>
        </>
      )}
      {r.qualifications && (
        <>
          <div className="section-label">Qualifications</div>
          <div className="small-muted" style={{ whiteSpace: 'pre-line', fontSize: 12.5, lineHeight: 1.7 }}>{r.qualifications}</div>
        </>
      )}
      <div className="section-label">Skills</div>
      <div style={{ marginBottom: 6 }}>
        {list(r.skills).length
          ? list(r.skills).map((s) => <span className="skillpill match" key={s}>{s}</span>)
          : <span className="cell-muted">—</span>}
        <span className="cell-muted" style={{ fontSize: 11.5 }}> mandatory</span>
      </div>
      <div>
        {list(r.goodToHaveSkills).length
          ? list(r.goodToHaveSkills).map((s) => <span className="skillpill" key={s}>{s}</span>)
          : <span className="cell-muted">—</span>}
        <span className="cell-muted" style={{ fontSize: 11.5 }}> good to have</span>
      </div>
      <div className="section-label">Details</div>
      {row('Experience', r.experience)}
      {row('Relevant experience', r.relevantExperience)}
      {row('Education', r.education)}
      {row('Location', r.location)}
      {row('Preferred location', r.preferredLocation)}
      {row('Work mode', r.workMode)}
      {row('Employment type', r.employmentType)}
      {row('Salary range', r.salary)}
      {row('Notice period', r.noticePeriodMax)}
      {row('Joining timeline', r.joiningTimeline)}
      {row('Openings', r.openings)}
      {!forCandidate && row('Closing date', r.closingDate)}
      {!forCandidate && row('Target date', r.targetDate)}
      {!r.internal && r.client && !forCandidate && (
        <>
          <div className="section-label">About the client</div>
          <div className="small-muted" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
            {[r.client.name, r.client.industry, r.client.location].filter(Boolean).join(' · ')}
          </div>
        </>
      )}
      {forCandidate && (
        <div className="notice" style={{ marginTop: 14 }}>
          This is how the opening appears to candidates on the TeamLink Job Portal and external boards.
          Client commercial terms and internal notes are never included.
        </div>
      )}
    </div>
  );
}

function Row({ k, children }) {
  return <div className="kv"><span className="k">{k}</span><span>{children || '—'}</span></div>;
}

// §15 — a seat reads "MED-5 · Medical Team", never a bare code.
const seatText = (seat) => (seat && seat.code ? `${seat.code} · ${seat.department ? `${seat.department} Team` : (seat.name || 'Seat')}` : null);

// The one posting source this app publishes to itself (routes/jobPortal.js).
export const JOB_PORTAL = 'TeamLink Job Portal';

// Draft → Agreement Check → Open → Recruiter Assigned → Sourcing
//   → Candidates Available → On Hold / Closed
const FLOW = ['DRAFT', 'AGREEMENT_CHECK', 'OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE'];
const PARKED = ['ON_HOLD', 'CLOSED'];
const TABS = ['overview', 'candidates', 'recruiter', 'client', 'interviews', 'agreement', 'activity'];
const TAB_LABELS = {
  overview: 'Overview', candidates: 'Candidates', recruiter: 'Recruiter', client: 'Client', interviews: 'Interviews', agreement: 'Agreement', activity: 'Activity',
};
// Pipeline filter on the Candidates tab — same buckets as the count tiles.
const PIPE_FILTERS = [
  ['all', 'All'],
  ['active', 'Active', (s) => !['REJECTED', 'HOLD'].includes(s)],
  ['shortlisted', 'Shortlisted', (s) => s === 'CLIENT_SHORTLISTED'],
  ['interview', 'Interview', (s) => ['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED'].includes(s)],
  ['selected', 'Selected', (s) => ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'].includes(s)],
  ['joined', 'Joined', (s) => ['JOINED', 'HIRED'].includes(s)],
  ['hold', 'Hold', (s) => s === 'HOLD'],
  ['rejected', 'Rejected', (s) => s === 'REJECTED'],
];
const INTERVIEW_STAGES = ['CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'];

export default function RequirementDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { hash } = useLocation();
  const landed = useRef(false);
  const { user } = useAuth();
  // CLIENT DETAIL IS THE CLIENT DESK'S (Super Admin, Admin, Manager, Asst
  // Manager, BDE). Everyone else is sent the client's name only by the API,
  // so the particulars and the link into the client record are not drawn.
  const clientDesk = can(user, null, 'clients', 'Client List', 'view');
  const portalUrl = useJobPortalUrl();
  const [requirement, setRequirement] = useState(null);
  const [denied, setDenied] = useState('');
  const [tab, setTabState] = useState(() => {
    const t = searchParams.get('tab');
    if (TABS.includes(t)) return t;
    if (hash === '#pipeline' || hash === '#matching') return 'candidates';
    return 'overview';
  });
  const setTab = (t) => {
    setTabState(t);
    const next = new URLSearchParams(searchParams);
    if (t === 'overview') next.delete('tab'); else next.set('tab', t);
    next.delete('action');
    setSearchParams(next, { replace: true });
  };
  const [matching, setMatching] = useState(null); // { rows, total, strong } once asked for
  const [matchingBusy, setMatchingBusy] = useState(false);
  const [activity, setActivity] = useState(null);
  const [workers, setWorkers] = useState(null);
  const [people, setPeople] = useState(null);
  const [linkQuery, setLinkQuery] = useState('');
  const [linkHits, setLinkHits] = useState([]);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState(null); // 'jd' | 'posting' | 'assign' | 'edit'
  const [assign, setAssign] = useState(null);
  const [notice, setNotice] = useState('');
  const [clients, setClients] = useState(null);
  const [decision, setDecision] = useState(null);
  const [pipeFilter, setPipeFilter] = useState('all');
  // Department → Section → TL → Recruiter for the assignment dialog (§10).
  const tree = useHierarchy();

  function load() {
    return api.get(`/requirements/${id}`)
      .then((res) => setRequirement(res.data))
      .catch((err) => setDenied(err.response?.data?.error || 'This record is not available to you'));
  }
  const loadActivity = () => api.get(`/requirements/${id}/activity`).then((res) => setActivity(res.data)).catch(() => setActivity([]));
  useEffect(() => {
    setRequirement(null); setDenied(''); setActivity(null); setWorkers(null); setMatching(null);
    landed.current = false;
    load();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tabs load their own data when first opened.
  useEffect(() => {
    if (tab === 'activity' && activity === null) loadActivity();
    if (tab === 'recruiter' && workers === null) {
      api.get(`/requirements/${id}/workers`).then((res) => setWorkers(res.data)).catch(() => setWorkers([]));
    }
  }, [tab, id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Link a candidate: search as you type (name / phone / email), not the master.
  useEffect(() => {
    const q = linkQuery.trim();
    if (q.length < 2) { setLinkHits([]); return undefined; }
    const t = setTimeout(() => {
      api.get(`/requirements/${id}/candidate-search`, { params: { q } }).then((res) => setLinkHits(res.data)).catch(() => setLinkHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [linkQuery, id]);

  const ensurePeople = () => {
    if (people === null) api.get('/requirements/assignable-people').then((res) => setPeople(res.data)).catch(() => setPeople([]));
  };
  const ensureClients = () => {
    if (clients !== null) return;
    // The client desk gets full client records; everyone else a names-only list.
    api.get('/clients').then((res) => setClients(res.data))
      .catch(() => api.get('/requirements/client-options').then((res) => setClients(res.data)).catch(() => setClients([])));
  };

  function refreshAfterChange() {
    load();
    if (activity !== null) loadActivity();
  }

  async function setStage(applicationId, stage, extra) {
    setError('');
    try {
      await api.patch(`/applications/${applicationId}/stage`, { stage, ...(extra || {}) });
      refreshAfterChange();
      return true;
    } catch (err) {
      setError(err.response?.data?.error || 'Could not change stage');
      return false;
    }
  }

  // REJECTED and HOLD must keep a full record, so they go through a dialog
  // that asks for the reason. Every other stage moves straight through.
  function requestStage(application, stage) {
    if (['REJECTED', 'HOLD'].includes(stage)) {
      setDecision({
        applicationId: application.id,
        candidateName: application.candidate?.name || application.candidateName || 'this candidate',
        fromStage: application.stage,
        stage,
        rejectedBy: '',
        reasonCategory: '',
        reasonDetail: '',
        comment: '',
      });
      return;
    }
    setStage(application.id, stage);
  }

  async function linkCandidate(candidateId) {
    if (!candidateId) return;
    setError('');
    try {
      await api.post('/applications', { candidateId, requirementId: id });
      setLinkQuery('');
      setLinkHits([]);
      setMatching((m) => (m ? { ...m, rows: m.rows.filter((c) => c.id !== candidateId) } : m));
      refreshAfterChange();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add this candidate to the pipeline');
    }
  }

  async function runAction(path, body) {
    setError('');
    try {
      await api.post(`/requirements/${id}/${path}`, body || {});
      refreshAfterChange();
      return true;
    } catch (err) {
      setError(err.response?.data?.error || 'Could not complete that action');
      return false;
    }
  }

  function findMatches() {
    setMatchingBusy(true);
    api.get(`/requirements/${id}/matching-candidates`, { params: { limit: 10 } })
      .then((res) => setMatching(res.data))
      .catch(() => setMatching({ rows: [], total: 0, strong: 0 }))
      .finally(() => setMatchingBusy(false));
  }

  const openAssign = (r) => {
    ensurePeople();
    setAssign({
      tlId: r.tlId || '',
      stlId: r.stlId || '',
      recruiterId: r.recruiterId || '',
      bdeId: r.bdeId || '',
      recruiterIds: (r.coRecruiters || []).map((c) => c.id),
      accountManager: r.accountManager || '',
    });
    setDialog('assign');
  };

  useEffect(() => {
    if (!requirement || landed.current) return;
    landed.current = true;
    const action = searchParams.get('action');
    if (action === 'assign' && requirement.permissions?.assign) openAssign(requirement);
    if (action === 'edit' && requirement.permissions?.edit) { ensureClients(); ensurePeople(); setDialog('edit'); }
    if (action) {
      const next = new URLSearchParams(searchParams);
      next.delete('action');
      setSearchParams(next, { replace: true });
    }
  }, [requirement]); // eslint-disable-line react-hooks/exhaustive-deps

  const applications = (requirement && requirement.applications) || [];
  const pipeFn = (PIPE_FILTERS.find(([k]) => k === pipeFilter) || [])[2];
  const pipeRows = pipeFn ? applications.filter((a) => pipeFn(a.stage)) : applications;
  const paged = usePaged(pipeRows, 25);
  // Interviews tab — client / recruitment interviews only (AI kept apart).
  const interviewRows = applications.filter((a) => a.interviewAt || a.interviewStatus || INTERVIEW_STAGES.includes(a.stage))
    .sort((x, y) => (y.interviewAt ? new Date(y.interviewAt).getTime() : 0) - (x.interviewAt ? new Date(x.interviewAt).getTime() : 0));
  const ipaged = usePaged(interviewRows, 25);

  if (denied) return <div className="notice">{denied}</div>;
  if (!requirement) return <div className="small-muted">Loading requirement…</div>;

  const r = requirement;
  const p = r.permissions || {};
  const movableStages = workflowStages(user);
  const clientName = r.internal ? 'TeamLink (internal)' : r.client?.name || '—';
  // §7 Fee / Agreement terms — BDE, Accounts, Admin, Management only.
  const showAgreementTab = r.internal || !r.sections || !!r.sections.commercial;
  const pct = (v) => (v !== null && v !== undefined && v !== '' ? `${v}%` : null);
  async function deleteRequirement() {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete ${r.reqCode || r.title}? This cannot be undone. A requirement with candidates or invoices cannot be deleted — close it instead.`)) return;
    try {
      await api.delete(`/requirements/${r.id}`);
      navigate('/requirements');
    } catch (e) {
      setNotice(e.response?.data?.error || 'Could not delete this requirement.');
    }
  }
  const agreementActive = r.agreementActive;
  const sources = list(r.postingSources);
  const sla = slaInfo(r.sla);
  // WHERE IT IS REALLY POSTED. Ticking a source only records the intention.
  // The TeamLink Job Portal is the one channel this app actually publishes to
  // (portalPublished); the others have no live connection, so nothing is sent
  // there and the page says so instead of calling it "Posted".
  const day = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const logFor = (s) => (r.postingLog || []).filter((l) => l.source === s);
  // THE PROOF A POSTING IS LIVE: applications that came in through that
  // source's tagged apply link (?src=Shine → application.firstSource).
  const SOCIAL_CHANNELS = ['LinkedIn', 'Facebook', 'WhatsApp', 'X'];
  const appliedVia = (s) => applications.filter((a) => (
    s === 'Social Media' ? SOCIAL_CHANNELS.includes(a.firstSource) : a.firstSource === s
  )).length;
  // A recruiter dashboard, search or login page is not the job's listing.
  const notAListing = (link) => /recruiter\.|advancedsearch|\/search|dashboard|login|\/employer|\/rms/i.test(String(link || ''));
  const withApplied = (st, s) => {
    const k = appliedVia(s);
    return k ? { ...st, label: 'Live', cls: 'active', note: `${k} application${k === 1 ? '' : 's'} came in through ${s}. ${st.note}` } : st;
  };
  const sourceState = (s) => {
    if (s === JOB_PORTAL) {
      return r.portalPublished
        ? { label: 'Published', cls: 'active', note: r.portalPublishedAt ? `on the TeamLink Job Portal since ${day(r.portalPublishedAt)}` : 'on the TeamLink Job Portal', link: jobPortalJobUrl(portalUrl, r.id) }
        : { label: 'Not published', cls: 'pending', note: 'Press Publish to put it on the TeamLink Job Portal.' };
    }
    if (s === 'Social Media') {
      const shares = logFor(s).filter((l) => l.action === 'Shared');
      if (!shares.length) return withApplied({ label: 'Not shared', cls: 'pending', note: 'Share it with the buttons — each share is recorded here.' }, s);
      const channels = [...new Set(shares.map((l) => l.detail).filter(Boolean))];
      return withApplied({ label: 'Shared', cls: 'active', note: `on ${channels.join(', ')} — last by ${shares[0].by || 'someone'}, ${day(shares[0].at)}` }, s);
    }
    if (s === 'TeamLink Website') {
      return r.portalPublished
        ? { label: 'In website feed', cls: 'active', note: 'Listed in the job feed tmlink.in reads — it shows on the website once the "Current openings" section is added there.' }
        : { label: 'Not in feed', cls: 'pending', note: 'Publish on the Job Portal first — the website feed lists published jobs only.' };
    }
    // Naukri, Indeed, Shine: no account connection — what a person did.
    const last = logFor(s)[0];
    if (last && last.action === 'Posted manually') {
      const bad = notAListing(last.detail);
      return withApplied({
        label: bad ? 'Posted — check link' : 'Posted',
        cls: bad ? 'pending' : 'active',
        note: `manually by ${last.by || 'someone'} on ${day(last.at)}.`
          + (bad ? ` The saved link is a ${s} recruiter page, not the job's listing — Mark as posted again with the job's public link.`
            : !last.detail ? ' No listing link saved.' : '')
          + (appliedVia(s) ? '' : ` No applications from ${s} yet — they are counted here as they arrive.`),
        link: last.detail,
      }, s);
    }
    const feed = ['Indeed', 'Shine'].includes(s) && r.portalPublished
      ? ` It is in the job feed — register the feed URL in your ${s} employer account and ${s} collects it.` : '';
    return withApplied({ label: 'Not posted', cls: 'rejected', note: `No ${s} account is connected — copy the posting text, post it on ${s}, then Mark as posted.${feed}` }, s);
  };
  const postedCount = sources.filter((s) => ['Published', 'Posted', 'Posted — check link', 'Shared', 'In website feed', 'Live'].includes(sourceState(s).label)).length;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  // Each source gets its own tagged link, so an applicant is counted against
  // the board or channel they came from (?src= → application.firstSource).
  const applyLink = (src) => jobPortalJobUrl(portalUrl, r.id, src);
  const onLocalhost = /localhost|127\.0\.0\.1/.test(`${origin} ${portalUrl}`);
  async function logPosting(source, action, detail) {
    try {
      const res = await api.post(`/requirements/${r.id}/posting-log`, { source, action, detail });
      setRequirement((prev) => ({ ...prev, postingLog: res.data.postingLog }));
      if (activity !== null) loadActivity();
    } catch (e) {
      setNotice(e.response?.data?.error || 'Could not record that.');
    }
  }
  const SHARE = [
    ['LinkedIn', () => `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(applyLink('LinkedIn'))}`],
    ['Facebook', () => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(applyLink('Facebook'))}`],
    ['WhatsApp', () => `https://wa.me/?text=${encodeURIComponent(`We're hiring: ${r.title} (${r.location || 'India'}). Apply: ${applyLink('WhatsApp')}`)}`],
    ['X', () => `https://twitter.com/intent/tweet?text=${encodeURIComponent(`We're hiring: ${r.title}`)}&url=${encodeURIComponent(applyLink('X'))}`],
  ];
  function share(channel, urlOf) {
    // Opened BEFORE the await so the browser counts it as the click's own tab.
    window.open(urlOf(), '_blank', 'noopener,noreferrer');
    logPosting('Social Media', 'Shared', channel);
  }
  async function copyText(text, done) {
    try { await navigator.clipboard.writeText(text); setNotice(done); } catch { setNotice('Could not copy — select and copy it from Preview Job Posting instead.'); }
  }
  const postingText = (src) => [
    r.title, [r.location, r.experience, r.employmentType].filter(Boolean).join(' · '), '',
    r.jobDescription || r.description || '',
    r.responsibilities ? `\nResponsibilities:\n${r.responsibilities}` : '',
    r.qualifications ? `\nQualifications:\n${r.qualifications}` : '',
    list(r.skills).length ? `\nSkills: ${list(r.skills).join(', ')}` : '',
    `\nApply: ${applyLink(src)}`,
  ].join('\n');
  function markPosted(s) {
    // eslint-disable-next-line no-alert
    const link = prompt(`Paste the link of the JOB's page on ${s} — the one candidates see (not the recruiter dashboard or search page). Leave blank if you don't have it:`, '');
    if (link === null) return;
    logPosting(s, 'Posted manually', link.trim());
  }
  const postingStatus = !sources.length ? 'No sources'
    : postedCount === sources.length ? 'Posted'
      : postedCount ? `Posted on ${postedCount} of ${sources.length}` : 'Not posted yet';
  async function publishToPortal(published = true) {
    setNotice('');
    try {
      const res = await api.post(`/job-portal/jobs/${r.id}/publish`, { published });
      setNotice(res.data?.portalError
        ? `${published ? 'Published' : 'Unpublished'} here, but the TeamLink Job Portal could not be updated yet: ${res.data.portalError}`
        : (published ? 'Published on the TeamLink Job Portal.' : 'Taken off the TeamLink Job Portal.'));
      load();
    } catch (e) {
      setNotice(e.response?.data?.error || 'Could not change the Job Portal posting.');
    }
  }
  const peopleList = people || [];
  const roleOf = (t) => t.atsRole || t.role;
  const byRole = (code) => peopleList.filter((t) => roleOf(t) === code);
  const aiRows = applications.filter((a) => a.aiInterviewScore !== null && a.aiInterviewScore !== undefined);
  const toCandidatesPage = () => navigate(`/candidates?requirementId=${encodeURIComponent(r.id)}`);

  // --- tab bodies ------------------------------------------------------------
  const overview = (
    <>
      {/* Draft → Agreement Check → Open → Recruiter Assigned → Sourcing →
          Candidates Available → On Hold / Closed */}
      <div className="card section">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {FLOW.map((s) => (
            <span
              key={s}
              className={`status ${r.status === s ? requirementBadgeClass(s) : ''}`}
              style={r.status === s ? undefined : { background: 'var(--line-soft)', color: 'var(--ink-soft)' }}
            >
              {requirementStatusLabel(s)}
            </span>
          ))}
          {PARKED.includes(r.status) && (
            <span className={`status ${requirementBadgeClass(r.status)}`}>{requirementStatusLabel(r.status)}</span>
          )}
        </div>
        {/* Role spec §7 — Close / Reopen / Delete: Admin all; a BDE may only
            Close (p.closeOnly); TL, Recruiter, Accounts none. */}
        {p.approve && p.closeOnly && r.status !== 'CLOSED' && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
            <button className="btn btn-sm btn-danger" onClick={() => runAction('status', { status: 'CLOSED' })}>Close</button>
          </div>
        )}
        {p.delete && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
            <button className="btn btn-sm btn-danger" onClick={deleteRequirement}>Delete requirement</button>
          </div>
        )}
        {p.approve && !p.closeOnly && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
            {!requirementIsLive(r.status) && !PARKED.includes(r.status) && (
              <button className="btn btn-sm btn-primary" onClick={() => runAction('activate')}>Activate Requirement</button>
            )}
            {['OPEN', 'ON_HOLD'].includes(r.status) && (
              <button className="btn btn-sm" onClick={() => runAction('status', { status: 'RECRUITER_ASSIGNED' })}>→ Recruiter Assigned</button>
            )}
            {['OPEN', 'RECRUITER_ASSIGNED', 'ON_HOLD'].includes(r.status) && (
              <button className="btn btn-sm" onClick={() => runAction('status', { status: 'SOURCING' })}>→ Sourcing</button>
            )}
            {['SOURCING', 'ON_HOLD'].includes(r.status) && (
              <button className="btn btn-sm" onClick={() => runAction('status', { status: 'CANDIDATES_AVAILABLE' })}>→ Candidates Available</button>
            )}
            {requirementIsLive(r.status) && (
              <button className="btn btn-sm" onClick={() => runAction('status', { status: 'ON_HOLD' })}>Put On Hold</button>
            )}
            {r.status !== 'CLOSED' && (
              <button className="btn btn-sm btn-danger" onClick={() => runAction('status', { status: 'CLOSED' })}>Close</button>
            )}
            {r.status === 'CLOSED' && (
              <button className="btn btn-sm" onClick={() => runAction('status', { status: 'OPEN' })}>Reopen</button>
            )}
          </div>
        )}
        {p.readOnlyReason && <div className="small-muted" style={{ marginTop: 8 }}>{p.readOnlyReason}</div>}
      </div>

      <div className="two-col">
        <div>
          <div className="card section">
            <h3 style={{ fontSize: 13, marginBottom: 10 }}>Requirement</h3>
            <div className="grid-2">
              <div>
                <Row k="Requirement ID">{r.reqCode || r.id}</Row>
                <Row k="Job Title">{r.title}</Row>
                <Row k="Client">{clientName}</Row>
                <Row k="Department">{r.department}</Row>
                <Row k="Location">{r.location}</Row>
                <Row k="Work Mode">{r.workMode}</Row>
                <Row k="Experience">{[r.experience, r.relevantExperience && `relevant ${r.relevantExperience}`].filter(Boolean).join(' · ')}</Row>
                <Row k="Qualification">{[r.education, r.qualifications].filter(Boolean).join(' · ')}</Row>
              </div>
              <div>
                <Row k="Openings">{`${r.openings} · filled ${r.filled ?? 0} · remaining ${r.remaining ?? r.openings}`}</Row>
                <Row k="Priority"><PriorityChip value={r.priority} /></Row>
                <Row k="Salary / CTC Range">{`${r.salary || '—'}${r.salaryType ? ` (${r.salaryType}${r.currency ? `, ${r.currency}` : ''})` : ''}`}</Row>
                <Row k="Notice Period">{r.noticePeriodMax}</Row>
                <Row k="Employment Type">{[r.employmentType, r.jobPreference].filter(Boolean).join(' · ')}</Row>
                <Row k="Created Date">{r.createdAt ? protoDate(r.createdAt) : null}</Row>
                <Row k="Target Date">{r.targetDate || r.closingDate}</Row>
                <Row k="Status"><StatusChip status={requirementStatusLabel(r.status)} tone={reqStatusTone(r.status)} /></Row>
              </div>
            </div>
            <Row k="Skills">
              {list(r.skills).length ? list(r.skills).map((s) => <span className="skillpill match" key={s}>{s}</span>) : null}
            </Row>
            <div className="section-label">Job Description</div>
            <div className="small-muted" style={{ whiteSpace: 'pre-line', fontSize: 12.5, lineHeight: 1.7 }}>
              {r.jobDescription || r.description || '—'}
            </div>
          </div>
        </div>
        <div>
          {/* Review #3 §4 — Assigned Team: TL and recruiters with their seat
              ("MED-5 · Medical Team"). */}
          <div className="card section">
            <h3 style={{ fontSize: 13, marginBottom: 8 }}>Assigned Team</h3>
            <Row k="Department">{[r.department, r.section].filter(Boolean).join(' · ')}</Row>
            <Row k="TL">{[r.tlName || r.tl, seatText(r.seats?.tl)].filter(Boolean).join(' · ')}</Row>
            <Row k="Recruiter">{[r.recruiter?.name || r.workedBy, seatText(r.seats?.recruiter) || r.workedByPosition].filter(Boolean).join(' · ')}</Row>
            {(r.coRecruiters || []).map((c) => (
              <Row key={c.id} k="Co-recruiter">{[c.name, seatText(c.seat)].filter(Boolean).join(' · ')}</Row>
            ))}
            {!r.internal && <Row k="BDE">{r.bde?.name}</Row>}
            <button type="button" className="btn btn-sm" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }} onClick={() => setTab('recruiter')}>
              Assignment details →
            </button>
          </div>
          {/* Review #3 §4 — Agreement and Job Portal lines of the 360. */}
          {!r.internal && (
            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 8 }}>{showAgreementTab ? 'Agreement' : 'Agreement gate'}</h3>
              {showAgreementTab && <Row k="Status"><StatusChip status={(r.agreement && r.agreement.label) || agreementStatusLabel(r.client?.agreementStatus)} tone={agreementActive ? 'green' : 'amber'} /></Row>}
              {r.commercial && <Row k="Fee %">{pct(r.commercial.feePercent)}</Row>}
              {r.commercial && <Row k="Guarantee">{r.commercial.guaranteeDays ? (/^\d+$/.test(String(r.commercial.guaranteeDays).trim()) ? `${r.commercial.guaranteeDays} days` : r.commercial.guaranteeDays) : null}</Row>}
              {r.commercial && <Row k="Payment terms">{r.commercial.paymentTerms}</Row>}
              <Row k="Requirement">{r.agreement?.held ? 'Held at Agreement Check' : agreementActive ? 'May go live' : 'Cannot go live until Active'}</Row>
              {showAgreementTab && (
                <button type="button" className="btn btn-sm" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }} onClick={() => setTab('agreement')}>
                  Agreement details →
                </button>
              )}
            </div>
          )}
          {r.portal && (
            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 8 }}>Job Portal</h3>
              <Row k="Published">
                {r.portal.published
                  ? <StatusChip tone="green">{`Published${r.portal.publishedAt ? ` · ${fmtShort(r.portal.publishedAt)}` : ''}`}</StatusChip>
                  : <StatusChip tone="grey">Not published</StatusChip>}
              </Row>
              <Row k="Applications">
                {r.portal.applications ? <Link to={candidatesLink(r.id)}>{nf(r.portal.applications)}</Link> : '0'}
              </Row>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 12, marginTop: 6 }}>
                {r.portal.published && <a href={jobPortalJobUrl(portalUrl, r.id)} target="_blank" rel="noreferrer">View on Job Portal ↗</a>}
                {r.portal.workspace && <Link to="/candidates?view=job-portal">Job Portal Candidates →</Link>}
              </div>
            </div>
          )}
          {/* User notes #7 / #6 — where it is posted, and who is nearby.
              postingLog is only on an internal payload (never a client's). */}
          {r.postingLog && <PostedOnPanel requirementId={r.id} onChanged={load} />}
          {p.matching && <LocationCandidatesPanel requirementId={r.id} summaryOnly onOpenList={() => setTab('candidates')} />}
          <details className="card">
            <summary style={{ fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Your permissions on this record</summary>
            <div style={{ marginTop: 8 }}>
              {[['View', p.view], ['Edit', p.edit], ['Approve', p.approve], ['Assign', p.assign], ['Share / post', p.share], ['Export', p.export]]
                .map(([label, on]) => (
                  <div className="kv" key={label}>
                    <span className="k">{label}</span>
                    <StatusChip tone={on ? 'green' : 'grey'}>{on ? 'Allowed' : 'Not allowed'}</StatusChip>
                  </div>
                ))}
              <div className="small-muted" style={{ marginTop: 8, fontSize: 11.5 }}>
                Resolved server-side by the permission engine and this record&apos;s own assignment — the API
                refuses anything marked Not allowed, whatever this page renders.
              </div>
            </div>
          </details>
        </div>
      </div>

      <div className="card section" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ flex: '1 1 420px' }}>
          <b style={{ fontSize: 13 }}>Job Posting &amp; Portal Sync</b>
          <div className="small-muted" style={{ fontSize: 12, marginTop: 2 }}>
            {'Posting: '}
            <span className={`status ${postingStatus === 'Posted' ? 'active' : 'pending'}`}>{postingStatus}</span>
            {!agreementActive && <span style={{ color: 'var(--red)' }}> · agreement not Active — posting blocked</span>}
          </div>
          {sources.length > 0 && (
            <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
              {sources.map((s) => {
                const st = sourceState(s);
                return (
                  <div key={s} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5 }}>
                    <b style={{ minWidth: 150 }}>{s}</b>
                    <span className={`status ${st.cls}`}>{st.label}</span>
                    <span className="small-muted" style={{ flex: '1 1 260px' }}>
                      {st.note}
                      {st.link && <> · <a href={/^https?:/i.test(st.link) ? st.link : `https://${st.link}`} target="_blank" rel="noopener noreferrer">open listing</a></>}
                    </span>
                    {(p.edit || p.share) && (
                      <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {/* Publish only where POST /job-portal/jobs/:id/publish will accept it
                            (r.portal.canPublish — review #3 access audit). */}
                        {s === JOB_PORTAL && r.portal && r.portal.canPublish && (r.portalPublished
                          ? <>
                            <a className="btn btn-sm" href={jobPortalJobUrl(portalUrl, r.id)} target="_blank" rel="noreferrer">View on Job Portal ↗</a>
                            <button className="btn btn-sm" onClick={() => publishToPortal(false)}>Unpublish</button>
                          </>
                          : <button className="btn btn-sm btn-primary" onClick={() => publishToPortal(true)}>Publish</button>)}
                        {s === 'Social Media' && SHARE.map(([ch, urlOf]) => (
                          <button key={ch} className="btn btn-sm" onClick={() => share(ch, urlOf)}>Share · {ch}</button>
                        ))}
                        {['Naukri', 'Indeed', 'Shine'].includes(s) && (
                          <>
                            <button className="btn btn-sm" onClick={() => copyText(postingText(s), `Posting text for ${s} copied — paste it into ${s}.`)}>Copy posting text</button>
                            {st.label === 'Posted'
                              ? <button className="btn btn-sm" onClick={() => logPosting(s, 'Removed')}>Mark removed</button>
                              : <button className="btn btn-sm btn-primary" onClick={() => markPosted(s)}>Mark as posted</button>}
                            {['Indeed', 'Shine'].includes(s) && r.portalPublished && (
                              <button className="btn btn-sm" onClick={() => copyText(`${origin}/api/public/jobs.xml`, `Feed URL copied — add it in your ${s} employer account.`)}>Copy feed URL</button>
                            )}
                          </>
                        )}
                        {s === 'TeamLink Website' && (
                          <button className="btn btn-sm" onClick={() => copyText(`${origin}/api/public/jobs.feed`, 'Website feed URL copied — give it to whoever maintains tmlink.in.')}>Copy feed URL</button>
                        )}
                      </span>
                    )}
                  </div>
                );
              })}
              {onLocalhost && (
                <div className="small-muted" style={{ fontSize: 11.5 }}>
                  The app is running on this computer (localhost), so shared links and feed URLs only work here. They work for everyone once the app is online.
                </div>
              )}
            </div>
          )}
          {!sources.length && <div className="small-muted" style={{ fontSize: 12, marginTop: 4 }}>No posting sources selected yet — tick them in Edit Requirement.</div>}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn btn-sm" onClick={() => setDialog('jd')}>View Job Description</button>
          <button className="btn btn-sm" onClick={() => setDialog('posting')}>Preview Job Posting</button>
          {p.share && <button className="btn btn-sm" onClick={() => runAction('generate-jd')}>Generate job description</button>}
          {p.share && (
            <Combo value={r.portalSyncStatus || 'Not Synced'} onChange={(e) => runAction('portal-sync', { portalSyncStatus: e.target.value })}>
              {PORTAL_SYNC_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </Combo>
          )}
        </div>
      </div>
    </>
  );

  const candidatesTab = (
    <>
      <div className="card section" id="pipeline">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ fontSize: 14, margin: 0 }}>{`Candidates on this requirement (${nf(applications.length)})`}</h3>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <label className="small-muted" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
              Show
              <select value={pipeFilter} onChange={(e) => setPipeFilter(e.target.value)}>
                {PIPE_FILTERS.map(([k, l, fn]) => (
                  <option key={k} value={k}>{`${l} (${nf(fn ? applications.filter((a) => fn(a.stage)).length : applications.length)})`}</option>
                ))}
              </select>
            </label>
            <button type="button" className="btn btn-sm" onClick={toCandidatesPage}>Open in Candidates →</button>
          </div>
        </div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Candidate</th><th>Stage</th><th>Score</th><th>Updated</th><th>Move to…</th></tr></thead>
            <tbody>
              {paged.slice.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link to={`/candidates/${a.candidateId || a.candidate?.id}`}>{a.candidate?.name || a.candidateName}</Link>
                    {(a.candidate?.location || a.candidate?.experienceYears != null) && (
                      <div className="small-muted" style={{ fontSize: 11.5 }}>
                        {[a.candidate?.location, a.candidate?.experienceYears != null ? `${a.candidate.experienceYears} yrs` : null].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </td>
                  <td><span className={`status ${stageBadgeClass(a.stage)}`}>{stageLabel(a.stage)}</span></td>
                  <td>{a.matchScore != null ? `${a.matchScore}%` : a.resumeScore != null ? `${a.resumeScore}%` : '—'}</td>
                  <td className="cell-muted">{a.updatedAt ? protoDate(a.updatedAt) : '—'}</td>
                  <td>
                    {/* requestStage() routes Reject/Hold through the reason
                        dialog; the list is the stages this login owns. */}
                    {p.pipelineEdit && movableStages.length ? (
                      <Combo value={a.stage} onChange={(e) => requestStage(a, e.target.value)}>
                        {ALL_STAGE_CODES.filter((s) => s === a.stage || canMoveToStage(user, s))
                          .map((s) => <option key={s} value={s}>{stageLabel(s)}</option>)}
                      </Combo>
                    ) : <span className="cell-muted">—</span>}
                  </td>
                </tr>
              ))}
              {pipeRows.length === 0 && (
                <tr><td colSpan="5" className="small-muted" style={{ padding: 16 }}>{applications.length ? 'No candidates at this point.' : 'No candidates on this requirement yet.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <Pager page={paged} noun="candidates" />
      </div>

      {p.pipelineEdit && (
        <div className="card section">
          <h3 style={{ fontSize: 14, marginBottom: 10 }}>Add a candidate</h3>
          <input
            type="text"
            placeholder="Search your candidates by name, phone or email…"
            value={linkQuery}
            onChange={(e) => setLinkQuery(e.target.value)}
            style={{ maxWidth: 420 }}
          />
          {linkQuery.trim().length >= 2 && (
            <div className="reqbulk-results" style={{ maxWidth: 560 }}>
              {linkHits.map((c) => (
                <div key={c.id} className="reqbulk-row">
                  <span>
                    <b>{c.name}</b>
                    <span className="small-muted">{[c.location, c.experienceYears != null ? `${c.experienceYears} yrs` : null].filter(Boolean).map((x) => ` · ${x}`).join('')}</span>
                  </span>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => linkCandidate(c.id)}>Add to pipeline</button>
                </div>
              ))}
              {linkHits.length === 0 && <div className="reqbulk-row small-muted">No matching candidate in your scope who is not already on this requirement.</div>}
            </div>
          )}
        </div>
      )}

      {p.matching && <LocationCandidatesPanel requirementId={r.id} onAdded={refreshAfterChange} />}

      {p.matching && (
        <div className="card section" id="matching">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
            <div>
              <h3 style={{ fontSize: 14, margin: 0 }}>Suggested matches from the candidate master</h3>
              <div className="small-muted" style={{ fontSize: 12, marginTop: 2 }}>
                Deterministically matched on skills, location, experience and preferences. Recruiter review is required before anyone is shared further.
              </div>
            </div>
            <button type="button" className="btn btn-sm" disabled={matchingBusy} onClick={findMatches}>
              {matchingBusy ? 'Matching…' : matching ? 'Refresh matches' : 'Find matching candidates'}
            </button>
          </div>
          {matching && (
            <>
              <div className="small-muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>
                {`${nf(matching.strong)} at or above ${matching.threshold ?? r.matchThreshold ?? 70}% · ${nf(matching.total)} at 50% or more · showing the top ${matching.rows.length}`}
              </div>
              <div className="tbl-wrap">
                <table>
                  <thead>
                    <tr><th>Candidate</th><th>Location</th><th>Experience</th><th>Matching Skills</th><th>Missing Mandatory</th><th>Score</th><th>Action</th></tr>
                  </thead>
                  <tbody>
                    {matching.rows.map((c) => (
                      <tr key={c.id}>
                        <td>{c.name}</td>
                        <td>{c.location || '—'}</td>
                        <td>{c.experienceYears != null ? `${c.experienceYears} yrs` : '—'}</td>
                        <td>
                          {c.match.matchedSkills.slice(0, 3).length
                            ? c.match.matchedSkills.slice(0, 3).map((s) => <span className="skillpill match" key={s}>{s}</span>)
                            : <span className="cell-muted">—</span>}
                        </td>
                        <td>
                          {c.match.missingSkills.length
                            ? c.match.missingSkills.slice(0, 3).map((s) => <span className="skillpill" key={s}>{s}</span>)
                            : <span className="status active">None</span>}
                        </td>
                        <td><span className="link-btn">{c.match.overall}%</span></td>
                        {/* p.pipelineEdit, not p.pipeline: reading the match
                            list is a view, adding to the pipeline is a write. */}
                        <td>
                          {p.pipelineEdit
                            ? <button className="btn btn-sm btn-primary" onClick={() => linkCandidate(c.id)}>Add to Pipeline</button>
                            : <span className="cell-muted">—</span>}
                        </td>
                      </tr>
                    ))}
                    {matching.rows.length === 0 && (
                      <tr><td colSpan="7" className="small-muted" style={{ padding: 16 }}>No candidate outside this pipeline matches 50% or more right now.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );

  const recruiterTab = (
    <div className="two-col">
      <div>
        {/* THE ASSIGNMENT CHAIN — this is what drives scope. */}
        <div className="card section">
          <h3 style={{ fontSize: 13, marginBottom: 4 }}>Assignment</h3>
          <div className="small-muted" style={{ fontSize: 11.5, marginBottom: 8 }}>
            Requirement → Assigned TL → Assigned Recruiter(s) → BDE → Client
          </div>
          <Row k="Assigned TL">{[r.tlName || r.tl, seatText(r.seats?.tl)].filter(Boolean).join(' · ')}</Row>
          <Row k="Assigned Recruiter">{[r.recruiter?.name, seatText(r.seats?.recruiter)].filter(Boolean).join(' · ')}</Row>
          <Row k="Co-recruiters">
            {(r.coRecruiters || []).length ? (r.coRecruiters || []).map((c) => [c.name, seatText(c.seat)].filter(Boolean).join(' · ')).join(', ') : null}
          </Row>
          <Row k="BDE">{r.bde?.name}</Row>
          <Row k="STL">{r.stlName || r.stl}</Row>
          <Row k="Account Manager">{r.accountManager || r.client?.accountManager}</Row>
          {!r.recruiter && r.workedBy && <Row k="Worked by">{[r.workedBy, r.workedByPosition].filter(Boolean).join(' · ')}</Row>}
          {p.assign ? (
            <button className="btn btn-sm btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }} onClick={() => openAssign(r)}>
              Change assignment
            </button>
          ) : (
            <div className="small-muted" style={{ marginTop: 8 }}>You can view this assignment but not change it — ASSIGN is a separate permission from VIEW.</div>
          )}
        </div>
      </div>
      <div>
        <div className="card section">
          <h3 style={{ fontSize: 13, marginBottom: 4 }}>Who has worked this requirement</h3>
          <div className="small-muted" style={{ fontSize: 11.5, marginBottom: 8 }}>Everyone who moved one of its candidates, newest first.</div>
          {workers === null && <div className="small-muted">Loading…</div>}
          {workers && workers.length === 0 && <div className="small-muted">Nobody has moved a candidate on this requirement yet.</div>}
          {workers && workers.length > 0 && (
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Person</th><th>Role / Seat</th><th>Moves</th><th>Last</th></tr></thead>
                <tbody>
                  {workers.map((w) => (
                    <tr key={`${w.name}-${w.role}-${w.seat}`}>
                      <td>{w.name}</td>
                      <td className="cell-muted">{[w.role, w.seat].filter(Boolean).join(' · ') || '—'}</td>
                      <td className="jobsws-num">{nf(w.moves)}</td>
                      <td className="cell-muted">{w.last ? protoDate(w.last) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const clientTab = (
    <div className="card section" style={{ maxWidth: 760 }}>
      <h3 style={{ fontSize: 13, marginBottom: 10 }}>Client</h3>
      {r.internal ? (
        <div className="small-muted">Internal TeamLink hiring — there is no client on this requirement.</div>
      ) : r.sections && r.sections.clientContact ? (
        <>
          <Row k="Client">{r.clientLink ? <Link to={`/clients/${r.clientId}`}>{r.client?.name}</Link> : r.client?.name}</Row>
          <Row k="Legal name">{r.client?.legalName}</Row>
          <Row k="Industry">{r.client?.industry}</Row>
          <Row k="Location">{r.client?.location}</Row>
          <Row k="Owner department">{r.client?.ownerDepartment}</Row>
          <Row k="Primary contact">{[r.client?.contactName, r.client?.contactDesignation].filter(Boolean).join(' · ')}</Row>
          {r.sections.clientContact === 'full' && <Row k="Contact">{[r.client?.contactPhone, r.client?.contactEmail].filter(Boolean).join(' · ')}</Row>}
          <Row k="Owner BDE">{[r.client?.bdeOwner || r.client?.accountManager, r.bde?.name].filter(Boolean).join(' · ')}</Row>
          {r.sections.clientContact === 'names' && <div className="small-muted" style={{ marginTop: 8 }}>Contact names only — phone and e-mail stay with the client desk.</div>}
          {r.clientLink && <Link className="btn btn-sm" style={{ marginTop: 10 }} to={`/clients/${r.clientId}`}>Open Client 360 →</Link>}
        </>
      ) : !r.sections && clientDesk ? (
        <>
          <Row k="Client">{r.client?.name}</Row>
          <Row k="Legal name">{r.client?.legalName}</Row>
          <Row k="Client code">{r.client?.clientCode}</Row>
          <Row k="Industry">{r.client?.industry}</Row>
          <Row k="Location">{r.client?.location}</Row>
          <Row k="Owner department">{r.client?.ownerDepartment}</Row>
          <Row k="Primary contact">{[r.client?.contactName, r.client?.contactDesignation].filter(Boolean).join(' · ')}</Row>
          <Row k="Contact">{[r.client?.contactPhone, r.client?.contactEmail].filter(Boolean).join(' · ')}</Row>
          <Row k="Account owner / BDE">{[r.client?.accountManager, r.bde?.name].filter(Boolean).join(' · ')}</Row>
          <Row k="Payment terms">{r.client?.paymentTerms}</Row>
          <Row k="Agreement">
            <span className={`status ${agreementBadgeClass(r.client?.agreementStatus)}`}>{agreementStatusLabel(r.client?.agreementStatus)}</span>
          </Row>
          <Link className="btn btn-sm" style={{ marginTop: 10 }} to={`/clients/${r.clientId}`}>Open the client →</Link>
        </>
      ) : (
        <>
          <Row k="Client">{r.client?.name}</Row>
          <div className="small-muted" style={{ marginTop: 8 }}>
            Client details are kept on the Clients module (Admin, Manager and BDE). You see the client&apos;s name and this requirement.
          </div>
        </>
      )}
    </div>
  );

  const interviewsTab = (
    <>
      <div className="card section">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ fontSize: 14, margin: 0 }}>{`Client & recruitment interviews (${nf(interviewRows.length)})`}</h3>
          <Link className="btn btn-sm" to="/ats/calendar">Interview Calendar →</Link>
        </div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Candidate</th><th>Stage</th><th>Interview</th><th>When</th><th>Status</th><th>Mode / Interviewer</th><th>Client result</th></tr></thead>
            <tbody>
              {ipaged.slice.map((a) => (
                <tr key={a.id}>
                  <td><Link to={`/candidates/${a.candidateId}`}>{a.candidate?.name}</Link></td>
                  <td><span className={`status ${stageBadgeClass(a.stage)}`}>{stageLabel(a.stage)}</span></td>
                  <td className="cell-muted">{[a.interviewCode, a.interviewType, a.interviewRound ? `Round ${a.interviewRound}` : null].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="cell-muted">{a.interviewAt ? fmtWhen(a.interviewAt) : '—'}</td>
                  <td>{a.interviewStatus ? <span className="status review">{a.interviewStatus}</span> : <span className="cell-muted">—</span>}</td>
                  <td className="cell-muted">{[a.interviewMode, a.interviewer].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="cell-muted">{a.interviewResult || '—'}</td>
                </tr>
              ))}
              {interviewRows.length === 0 && <tr><td colSpan="7" className="small-muted" style={{ padding: 16 }}>No interviews on this requirement yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <Pager page={ipaged} noun="interviews" />
      </div>
      {/* AI interview kept apart — its score is never mixed with client feedback. */}
      {aiRows.length > 0 && (
        <div className="card section">
          <h3 style={{ fontSize: 14, marginBottom: 4 }}>{`AI interviews (${nf(aiRows.length)})`}</h3>
          <div className="small-muted" style={{ fontSize: 12, marginBottom: 8 }}>The AI interview score is separate from client interview feedback and is never combined with it.</div>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Candidate</th><th>AI interview status</th><th>AI score</th></tr></thead>
              <tbody>
                {aiRows.map((a) => (
                  <tr key={a.id}>
                    <td><Link to={`/candidates/${a.candidateId}`}>{a.candidate?.name}</Link></td>
                    <td className="cell-muted">{a.aiInterviewStatus || '—'}</td>
                    <td className="jobsws-num">{`${a.aiInterviewScore}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );

  const ag = r.agreement || {};
  const agreementTab = (
    <div className="card section" style={{ maxWidth: 760 }}>
      <h3 style={{ fontSize: 13, marginBottom: 10 }}>Agreement</h3>
      {r.internal || ag.internal ? (
        <div className="small-muted">Internal TeamLink hiring — no client agreement applies.</div>
      ) : (
        <>
          <Row k="Client">{clientName}</Row>
          <Row k="Status">
            <span className={`status ${agreementBadgeClass(r.client?.agreementStatus)}`}>{ag.label || agreementStatusLabel(r.client?.agreementStatus)}</span>
          </Row>
          {r.commercial && (
            <>
              <Row k="Fee %">{pct(r.commercial.feePercent)}</Row>
              <Row k="Guarantee period">{r.commercial.guaranteeDays ? (/^\d+$/.test(String(r.commercial.guaranteeDays).trim()) ? `${r.commercial.guaranteeDays} days` : r.commercial.guaranteeDays) : null}</Row>
              <Row k="Payment terms">{r.commercial.paymentTerms}</Row>
              <Row k="Invoice trigger">{r.commercial.invoiceTrigger}</Row>
            </>
          )}
          {r.client?.agreementId !== undefined && (
            <>
              <Row k="Agreement ID">{r.client?.agreementId}</Row>
              <Row k="Agreement Date">{r.client?.agreementStart}</Row>
              <Row k="Expiry">{r.client?.agreementEnd}</Row>
            </>
          )}
          <Row k="Requirement">{ag.held ? 'Held at Agreement Check — not live' : agreementActive ? 'May go live' : 'Cannot go live until the agreement is Active'}</Row>
          <Row k="Next step">{agreementActive ? 'Nothing — the agreement is Active.' : ag.nextStep}</Row>
          {!agreementActive && (
            ag.canOpen ? (
              <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <Link className="btn btn-sm btn-primary" to={`/clients/${r.clientId}?tab=agreements`}>Open the client&apos;s Agreement tab →</Link>
                {!ag.canManage && <span className="small-muted">An Admin completes the agreement itself.</span>}
              </div>
            ) : (
              <div className="small-muted" style={{ marginTop: 10 }}>
                {`Ask the BDE${r.bde?.name ? ` (${r.bde.name})` : ''} or an Admin who owns ${clientName} to complete the agreement. When it is Active, this requirement can be activated.`}
              </div>
            )
          )}
          {agreementActive && ag.canOpen && (
            <Link className="btn btn-sm" style={{ marginTop: 10 }} to={`/clients/${r.clientId}?tab=agreements`}>Open the agreement →</Link>
          )}
        </>
      )}
    </div>
  );

  const activityTab = (
    <div className="card section">
      <h3 style={{ fontSize: 14, marginBottom: 4 }}>Activity</h3>
      <div className="small-muted" style={{ fontSize: 12, marginBottom: 8 }}>Who did what, when and why — on the requirement and on its candidates.</div>
      {activity === null && <div className="small-muted">Loading…</div>}
      {activity && activity.length === 0 && <div className="small-muted">No activity recorded yet.</div>}
      {activity && activity.length > 0 && (
        <ul className="reqdet-feed">
          {activity.map((a) => (
            <li key={a.id}>
              <span className="when" title={fmtWhen(a.createdAt)}>{protoDate(a.createdAt)}</span>
              <span className={`dot ${a.kind}`} aria-hidden="true" />
              <div style={{ minWidth: 0 }}>
                <div>
                  <b>{a.by || 'System'}</b>
                  {a.role ? <span className="small-muted">{` (${a.role})`}</span> : null}
                  {' · '}
                  {a.kind === 'candidate' ? (
                    <>
                      {a.action}
                      {a.candidateName && <>{' — '}<Link to={`/candidates/${a.candidateId}`}>{a.candidateName}</Link></>}
                      {a.fromValue && a.toValue && a.fromValue !== a.toValue ? <span className="small-muted">{` (${a.fromValue} → ${a.toValue})`}</span> : null}
                    </>
                  ) : (
                    <>
                      {a.action}
                      {a.fieldLabel && <span className="small-muted">{` · ${a.fieldLabel}`}</span>}
                      {(a.fromValue || a.toValue) && <span className="small-muted">{`: ${a.fromValue || '—'} → ${a.toValue || '—'}`}</span>}
                    </>
                  )}
                </div>
                {a.reason && <div className="why">{a.reason}</div>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  // Role spec §7 — a section this role may not see is not a tab at all (and
  // the API did not send its data).
  const tabs = TABS.filter((t) => (t !== 'client' || r.internal || !r.sections || !!r.sections.clientContact)
    && (t !== 'agreement' || showAgreementTab));
  const bodies = {
    overview, candidates: candidatesTab, recruiter: recruiterTab, client: clientTab, interviews: interviewsTab, agreement: agreementTab, activity: activityTab,
  };
  const tabCount = { candidates: applications.length, interviews: interviewRows.length };

  return (
    <div>
      <Link className="small-muted" to="/requirements">← Jobs &amp; Requirements</Link>

      <div className="page-head" style={{ marginTop: 10, marginBottom: 6 }}>
        <div>
          <h1 style={{ fontSize: 20 }}>{`${r.reqCode ? `${r.reqCode} · ` : ''}${r.title}`}</h1>
          <div className="page-sub reqrole" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className={`rr-type ${r.internal ? 'internal' : 'client'}`} style={{ marginTop: 0 }}>{r.internal ? 'INTERNAL' : 'CLIENT'}</span>
            {r.internal
              ? <span className="rr-org-internal">Organization: TeamLink (internal)</span>
              : (r.clientLink ? <Link className="rr-client-link" to={`/clients/${r.clientId}`} title="Open Client 360">{clientName}</Link> : <span>{clientName}</span>)}
            <span>{[r.department, r.location].filter(Boolean).join(' · ')}</span>
            {r.unassigned && <span className="rr-unassigned">Unassigned</span>}
            {r.daysOpen !== null && r.daysOpen !== undefined && <span className={`rr-days${r.daysOpen >= 15 ? ' overdue' : ''}`}>{`Open ${r.daysOpen} days`}</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* EDIT REQUIREMENT opens the same form Create Requirement uses;
              p.edit is resolved on the server with the record-level check. */}
          {p.edit && (
            <button className="btn btn-sm" onClick={() => { setNotice(''); ensureClients(); ensurePeople(); setDialog('edit'); }}>
              Edit Requirement
            </button>
          )}
          {p.assign && <button className="btn btn-sm" onClick={() => openAssign(r)}>Assign Recruiter</button>}
          <StatusChip status={requirementStatusLabel(r.status)} tone={reqStatusTone(r.status)} />
        </div>
      </div>

      <div className="reqdet-strip">
        <PriorityChip value={r.priority} />
        <span>{ageText(r.ageDays)}</span>
        {sla ? <span className={`status ${sla.cls}`} title={sla.title}>{sla.text}</span> : <span>No SLA date</span>}
        <span title={r.lastActivity ? `${fmtWhen(r.lastActivity.at)}${r.lastActivity.what ? ` — ${r.lastActivity.what}` : ''}` : undefined}>
          {'Last activity: '}
          <b>{r.lastActivity ? lastActivityText(r.lastActivity) : 'none yet'}</b>
        </span>
        <span>{'Openings '}<b>{nf(r.openings)}</b>{` · filled ${nf(r.filled)} · remaining ${nf(r.remaining)}`}</span>
      </div>

      {/* Review #3 §4 — New → Recruiter Review → TL Review → Client Review →
          Interview → Selected → Joined; the SAME counts the list's drawer shows. */}
      <PipelineSteps requirementId={r.id} pipeline={r.pipeline} />

      {notice && <div className="notice">{notice}</div>}
      {!agreementActive && !r.internal && tab !== 'agreement' && (
        <div className="notice amber" style={{ alignItems: 'center' }}>
          <span>
            {'Agreement gate: '}
            <b>{clientName}</b>
            {"'s agreement is "}
            <b>{showAgreementTab ? agreementStatusLabel(r.client?.agreementStatus) : 'not Active yet'}</b>
            {' — this requirement cannot go live until it is Active.'}
          </span>
          {showAgreementTab && <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setTab('agreement')}>Agreement →</button>}
        </div>
      )}
      {error && <div className="error-text">{error}</div>}

      <div className="tabs reqdet-tabs">
        {tabs.map((t) => (
          <div key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
            {TAB_LABELS[t]}
            {tabCount[t] !== undefined && <span className="n" style={{ marginLeft: 4, opacity: 0.75 }}>{nf(tabCount[t])}</span>}
          </div>
        ))}
      </div>

      {bodies[tabs.includes(tab) ? tab : 'overview']}

      {dialog === 'assign' && assign && (
        <Modal
          title="Change assignment"
          onClose={() => setDialog(null)}
          footer={(
            <>
              <button className="btn" onClick={() => setDialog(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={async () => { if (await runAction('assign', assign)) setDialog(null); }}>
                Save assignment
              </button>
            </>
          )}
        >
          <div className="small-muted" style={{ marginBottom: 10 }}>
            Changing this changes who can see the requirement. A recruiter sees the ones assigned to them,
            a TL the ones they lead plus their team&apos;s, a BDE their clients&apos;.
          </div>
          {people === null && <div className="small-muted" style={{ marginBottom: 8 }}>Loading people…</div>}
          {(() => {
            // §10 — Department (the requirement's) → Section → TL → Recruiter.
            const cas = assignCascade(tree.data, peopleList, {
              department: r.department, section: assign.section || '', tlId: assign.tlId,
              keep: [r.tlId, r.recruiterId, ...(r.coRecruiters || []).map((c) => c.id)].filter(Boolean), keepTlId: r.tlId || '',
            });
            const recFits = (id) => !id || cas.recruiters.some((x) => x.id === id);
            const pickSection = (section) => {
              const next = assignCascade(tree.data, peopleList, { department: r.department, section, tlId: '' });
              const fits = (id) => !id || !section || next.recruiters.some((x) => x.id === id);
              setAssign({
                ...assign,
                section,
                tlId: !section || next.tls.some((t) => t.id === assign.tlId) ? assign.tlId : '',
                recruiterId: fits(assign.recruiterId) ? assign.recruiterId : '',
                recruiterIds: assign.recruiterIds.filter(fits),
              });
            };
            const pickTl = (tlId) => {
              const next = assignCascade(tree.data, peopleList, { department: r.department, section: assign.section || '', tlId });
              const fits = (id) => !id || next.recruiters.some((x) => x.id === id);
              setAssign({
                ...assign,
                tlId,
                recruiterId: fits(assign.recruiterId) ? assign.recruiterId : '',
                recruiterIds: assign.recruiterIds.filter(fits),
              });
            };
            return (
              <>
                {cas.sections.length > 0 && (
                  <label className="field">
                    <span>{`Section · ${r.department}`}</span>
                    <Combo value={cas.section} onChange={(e) => pickSection(e.target.value)}>
                      <option value="">All sections</option>
                      {cas.sections.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                    </Combo>
                  </label>
                )}
                <label className="field">
                  <span>{`Assigned TL${r.department ? ` · ${r.department}` : ''}`}</span>
                  <Combo value={assign.tlId} onChange={(e) => pickTl(e.target.value)}>
                    <option value="">— Not assigned —</option>
                    {cas.tls.map((t) => <option key={t.id} value={t.id}>{`${t.name}${t.seat?.code ? ` · ${t.seat.code}` : ''}`}</option>)}
                  </Combo>
                </label>
                <label className="field">
                  <span>{`Assigned Recruiter${assign.tlId ? ' · this TL\'s team' : ''}`}</span>
                  <Combo value={recFits(assign.recruiterId) ? assign.recruiterId : ''} onChange={(e) => setAssign({ ...assign, recruiterId: e.target.value })}>
                    <option value="">— Not assigned —</option>
                    {cas.recruiters.map((t) => <option key={t.id} value={t.id}>{`${t.name}${t.seat?.code ? ` · ${t.seat.code}` : ''}`}</option>)}
                  </Combo>
                </label>
              </>
            );
          })()}
          <div className="field">
            <span>Co-recruiters</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 4 }}>
              {assignCascade(tree.data, peopleList, {
                department: r.department, section: assign.section || '', tlId: assign.tlId, keep: [...assign.recruiterIds, ...(r.coRecruiters || []).map((c) => c.id)], keepTlId: r.tlId || '',
              }).recruiters.filter((t) => t.id !== assign.recruiterId).map((t) => (
                <label key={t.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 400, fontSize: 12.5 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={assign.recruiterIds.includes(t.id)}
                    onChange={() => setAssign({
                      ...assign,
                      recruiterIds: assign.recruiterIds.includes(t.id)
                        ? assign.recruiterIds.filter((x) => x !== t.id)
                        : [...assign.recruiterIds, t.id],
                    })}
                  />
                  {t.name}
                </label>
              ))}
            </div>
          </div>
          <label className="field">
            <span>BDE</span>
            <Combo value={assign.bdeId} onChange={(e) => setAssign({ ...assign, bdeId: e.target.value })}>
              <option value="">— Not assigned —</option>
              {byRole('BDE').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Combo>
          </label>
          <label className="field">
            <span>STL</span>
            <Combo value={assign.stlId} onChange={(e) => setAssign({ ...assign, stlId: e.target.value })}>
              <option value="">— None —</option>
              {byRole('STL').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Combo>
          </label>
          <label className="field">
            <span>Account Manager</span>
            <input value={assign.accountManager} onChange={(e) => setAssign({ ...assign, accountManager: e.target.value })} />
          </label>
        </Modal>
      )}

      {dialog === 'jd' && (
        <Modal
          title="Job Description"
          size="wide"
          onClose={() => setDialog(null)}
          footer={(
            <>
              <button className="btn" onClick={() => setDialog(null)}>Close</button>
              <button className="btn btn-primary" onClick={() => setDialog('posting')}>Preview Job Posting →</button>
            </>
          )}
        >
          <JobDescription requirement={r} />
        </Modal>
      )}

      {dialog === 'posting' && (
        <Modal
          title="Preview Job Posting"
          size="wide"
          onClose={() => setDialog(null)}
          footer={<button className="btn" onClick={() => setDialog('jd')}>← Back to JD</button>}
        >
          <div className="cell-muted" style={{ fontSize: 12, marginBottom: 10 }}>
            Candidate-facing preview. This is the same JD that goes to the Job Portal and each selected source.
          </div>
          <Row k="Posting status">
            <span className={`status ${postingStatus === 'Posted' ? 'active' : 'pending'}`}>{postingStatus}</span>
          </Row>
          <Row k="Job Portal Sync">{r.portalSyncStatus || 'Not Synced'}</Row>
          <Row k="Sources">{sources.length ? sources.map((s) => `${s} (${sourceState(s).label})`).join(', ') : 'None selected'}</Row>
          <JobDescription requirement={r} forCandidate />
        </Modal>
      )}

      {/* REJECT / HOLD, recorded in full: candidate, requirement, client,
          previous stage, who, their role and side, reason category, detailed
          reason, comments, timestamp — on the ApplicationStageEvent, which is
          never overwritten or deleted. */}
      {decision && (
        <Modal
          title={`${decision.stage === 'REJECTED' ? 'Reject' : 'Put on hold'} — ${decision.candidateName}`}
          onClose={() => setDecision(null)}
          footer={(
            <>
              <button className="btn" onClick={() => setDecision(null)}>Cancel</button>
              <button
                className={`btn ${decision.stage === 'REJECTED' ? 'btn-danger' : 'btn-primary'}`}
                disabled={!decision.reasonCategory || (decision.stage === 'REJECTED' && !decision.rejectedBy)}
                onClick={async () => {
                  const ok = await setStage(decision.applicationId, decision.stage, {
                    rejectedBy: decision.stage === 'REJECTED' ? decision.rejectedBy : undefined,
                    reasonCategory: decision.reasonCategory,
                    reasonDetail: decision.reasonDetail,
                    comment: decision.comment,
                  });
                  if (ok) setDecision(null);
                }}
              >
                {decision.stage === 'REJECTED' ? 'Record rejection' : 'Record hold'}
              </button>
            </>
          )}
        >
          <div className="cell-muted" style={{ fontSize: 12, marginBottom: 10 }}>
            {`Moving from ${stageLabel(decision.fromStage)}. This is kept for ever against the application — `}
            {'the candidate is never removed from the master, and this reasoning is never shown to a client login.'}
          </div>
          {decision.stage === 'REJECTED' && (
            <div className="field">
              <span>Rejected by *</span>
              <div className="contact-methods">
                {REJECTED_BY_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    className={`contact-method${decision.rejectedBy === o.value ? ' is-on' : ''}`}
                    title={o.hint}
                    onClick={() => setDecision({ ...decision, rejectedBy: o.value, reasonCategory: '' })}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              {decision.rejectedBy && (
                <div className="small-muted" style={{ marginTop: 4 }}>
                  {REJECTED_BY_OPTIONS.find((o) => o.value === decision.rejectedBy)?.hint}
                </div>
              )}
            </div>
          )}
          <label className="field">
            <span>Reason Category *</span>
            <Combo
              creatable
              disabled={decision.stage === 'REJECTED' && !decision.rejectedBy}
              value={decision.reasonCategory}
              onChange={(e) => setDecision({ ...decision, reasonCategory: e.target.value })}
            >
              <option value="">
                {decision.stage === 'REJECTED' && !decision.rejectedBy ? 'Choose who rejected first' : '— Select —'}
              </option>
              {(decision.stage === 'REJECTED'
                ? (REJECTION_REASONS_BY_SIDE[decision.rejectedBy] || REJECTION_REASON_CATEGORIES)
                : HOLD_REASON_CATEGORIES)
                .map((x) => <option key={x} value={x}>{x}</option>)}
            </Combo>
          </label>
          <label className="field">
            <span>Detailed Reason</span>
            <textarea rows="3" value={decision.reasonDetail} placeholder="What specifically decided it?" onChange={(e) => setDecision({ ...decision, reasonDetail: e.target.value })} />
          </label>
          <label className="field">
            <span>Comments</span>
            <textarea rows="2" value={decision.comment} placeholder="Anything the next recruiter to open this record should know" onChange={(e) => setDecision({ ...decision, comment: e.target.value })} />
          </label>
          <div className="cell-muted" style={{ fontSize: 11.5 }}>
            {'Who decided, their role and which side they were on (Internal or Client) are recorded from your '}
            {'signed-in identity — they are not typed in and cannot be back-dated.'}
          </div>
        </Modal>
      )}

      {/* EDIT REQUIREMENT — the Create Requirement form in edit mode.
          `canAssign` comes from the server's per-record permission set, so
          section F is read-only for a login that may edit but not re-assign
          (the server refuses that change too). */}
      {dialog === 'edit' && (
        <RequirementForm
          mode="edit"
          requirement={r}
          clients={clients || []}
          team={peopleList}
          canAssign={!!p.assign}
          onClose={() => setDialog(null)}
          onSaved={(saved, meta) => {
            setDialog(null);
            const changed = (meta && meta.changedFields) || [];
            setNotice(changed.length
              ? `Saved. ${changed.length} field(s) updated: ${changed.join(', ')}. The change is in the Activity tab.`
              : 'Nothing changed — no fields were different.');
            refreshAfterChange();
          }}
        />
      )}
    </div>
  );
}
