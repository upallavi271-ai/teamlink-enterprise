import { useEffect, useRef, useState } from 'react';
import JobAutoMessages from '../components/automsg/JobAutoMessages.jsx'; // automatic stage messages: this job's setting
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { rowClickProps } from '../utils/rowClick.js';
import { useAuth } from '../context/AuthContext.jsx';
import api from '../api';
import Modal from '../components/Modal.jsx';
import Combo from '../components/Combo.jsx';
import Pager, { usePaged } from '../components/Pager.jsx';
// WORKFLOW ACTIONS ARE NOT VIEW/EDIT. The stages this login OWNS come from
// the permission engine (/auth/me workflow.allowedStages) — seeing the
// pipeline never implied being allowed to move a candidate through it.
import AskChangeJobModal from '../components/jobs/AskChangeJobModal.jsx';
import { can, canMoveToStage, canStartJob, workflowStages } from '../permissions';
import RequirementForm from '../components/RequirementForm.jsx';
import { SpecLabel } from '../components/SpecPicker.jsx'; // spec D
import { useJobPortalUrl, jobPortalJobUrl } from './JobPortalRedirect.jsx';
import { LocationCandidatesPanel } from '../components/jobs/RequirementReach.jsx';
// Change list 2026-10-03 §5: Pause / Close / Delete, and the six posting sites.
import { JobLifecycleBar } from '../components/jobs/JobLifecycle.jsx';
import JobPostingSites from '../components/jobs/JobPostingSites.jsx';
import PostingStatusPanel from '../components/jobs/PostingStatusPanel.jsx'; // Save & Post: what happened on each site, right after saving
import DistributeTab from '../components/jobdist/DistributeTab.jsx'; // job distribution: the "Distribute" tab (Posting Kit, tracked links, Posted tracker)
import JobPostingCard from '../components/jobpublish/JobPostingCard.jsx'; // job publishing engine: status per site + Post this job
import PostingsTab from '../components/jobs/reqsplit/PostingsTab.jsx'; // the Postings tab: portal buttons + Post Status + copy-ready details (2026-10-16)
import PostStepDialog from '../components/jobs/reqsplit/PostStepDialog.jsx'; // Post this job: sites, company logins, dry run, results (2026-10-13)
import PartnerShare from '../components/jobs/PartnerShare.jsx'; // B7: share the job with agencies / freelancers
import {
  PriorityChip, candidatesLink, ageText, slaInfo, lastActivityText, fmtWhen, fmtShort, nf,
} from '../components/jobs/reqFormat.jsx';
import StatusChip from '../components/ui/StatusChip.jsx';
import { useHierarchy } from '../components/HierarchyFilter.jsx';
import { assignCascade } from '../components/jobs/assignCascade.js';
import { TeamPickers } from '../components/jobs/assignPeople.jsx';
import '../components/jobs/jobs.css';
import '../components/jobs/reqrole.css';
import { ClientPausedBadge, ClientPausedBanner } from '../components/clients/ClientLifecycle.jsx';
import { deadlineInfo } from '../components/jobs/deadline.js';
import '../components/jobs/reqSummary.css';
// ATS layout v3 — header facts, the status chain, department-wise assign, a
// clickable mini funnel and "View Pipeline" (the Candidates & Pipeline board).
import { FunnelChart } from '../components/charts';
import { JobStatusChip, jobNoteOf } from '../components/jobs/reqStatus.jsx';
import EditTemplateButton from '../components/jobs/EditTemplateButton.jsx';
import RequirementBulk from '../components/jobs/RequirementBulk.jsx';
import '../components/clients/ccr.css';
// resume_: matching candidates with the 3-number match — shown as the first
// tab of RequirementMatchTabs (components/resume/MatchSplit.jsx inside).
// Rejections (spec 2026-10-03 §A2): [Matching] [Previously rejected, but a good fit] [Rejected on this job].
import RequirementMatchTabs from '../components/rejections/RequirementMatchTabs.jsx';
// docfill_: the JD / e-mail this job was filled from (downloadable, audited).
import SourceDocuments from '../components/ui/SourceDocuments.jsx';
import MultiFacetSelect from '../components/ui/MultiFacetSelect.jsx'; // the Source filter (tick boxes with counts)
import { recordedAs } from '../utils/candidateSource.js';
import { SalaryFitChips } from '../components/SalaryFit.jsx'; // Salary fit column + filter on this job's people
import { JobDupNote } from '../components/jobs/JobDuplicates.jsx'; // "Possible duplicate" note + ask button (2026-10-13)
import SendManyDialog from '../components/messaging/SendMessage.jsx'; // message the people on this job (templates, preview, confirm)
import { RequirementMatchesPanel } from '../components/resume/MatchSplit.jsx'; // fit_: top matches on the Overview
// B8: Similar people (Match by meaning), Fit version, Added by override badge.
import SimilarCandidatesPanel from '../components/match/SimilarCandidates.jsx';
import { OverrideBadge, FitWithVersion } from '../components/match/OverridePrompt.jsx';
import AddCandidateCard from '../components/applications/AddCandidateCard.jsx';
import {
  ALL_STAGE_CODES, stageLabel, stageBadgeClass,
  requirementStatusLabel, requirementBadgeClass, requirementIsLive,
  agreementStatusLabel, agreementBadgeClass,
  PORTAL_SYNC_STATUSES, protoDate,
  REJECTION_REASON_CATEGORIES, HOLD_REASON_CATEGORIES,
  REJECTED_BY_OPTIONS, REJECTION_REASONS_BY_SIDE,
  deptLabel,
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
const TABS = ['overview', 'candidates', 'recruiter', 'client', 'interviews', 'agreement', 'distribute', 'activity'];
const TAB_LABELS = {
  overview: 'Overview', candidates: 'Candidates', recruiter: 'Team', client: 'Client', interviews: 'Interviews', agreement: 'Agreement', distribute: 'Postings', activity: 'Activity',
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
  const linkBusy = useRef(false);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState(null); // 'jd' | 'posting' | 'assign' | 'edit'
  const [askChangeOpen, setAskChangeOpen] = useState(false); // a TL / STL / Recruiter asks the client manager to edit or close (2026-10-13)
  const [postPanel, setPostPanel] = useState(false); // the Save & Post panel (summary + the by-hand tasks)
  const [postStepOpen, setPostStepOpen] = useState(false); // Post this job: the Post step in a window
  const [assign, setAssign] = useState(null);
  const [notice, setNotice] = useState('');
  const [clients, setClients] = useState(null);
  const [decision, setDecision] = useState(null);
  const [pipeFilter, setPipeFilter] = useState(() => (PIPE_FILTERS.some(([k]) => k === searchParams.get('pipe')) ? searchParams.get('pipe') : 'all'));
  const [fitFilter, setFitFilter] = useState(''); // Salary fit: within / slightly / above / missing
  const [fitSort, setFitSort] = useState(''); // '' | 'desc' | 'asc'
  const [srcFilter, setSrcFilter] = useState(''); // Source filter: a comma list of clean sources
  const [msgOpen, setMsgOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false); // the one "Share" button's choices
  // Department-wise assign (RequirementBulk → /requirements/assignable-people?forJobs=<id>).
  const [bulkAssign, setBulkAssign] = useState(null); // 'assign-recruiter' | 'assign-tl'
  // Department → Section → TL → Recruiter for the assignment dialog (§10).
  const tree = useHierarchy();

  function load() {
    return api.get(`/requirements/${id}`)
      .then((res) => setRequirement(res.data))
      .catch((err) => setDenied(err.response?.data?.error || "You can't open this requirement. Ask your team lead."));
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
      setNotice(`Moved to ${stageLabel(stage)}.`);
      refreshAfterChange();
      return true;
    } catch (err) {
      setError(err.response?.data?.error || 'Could not move to that step. Please try again.');
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

  async function linkCandidate(candidateId, personName) {
    if (!candidateId || linkBusy.current) return; // one click = one application (a double click is ignored)
    linkBusy.current = true;
    setError('');
    try {
      await api.post('/applications', { candidateId, requirementId: id });
      const who = personName || linkHits.find((c) => c.id === candidateId)?.name;
      setNotice(who ? `Added ${who}.` : 'Added to this requirement.');
      setLinkQuery('');
      setLinkHits([]);
      setMatching((m) => (m ? { ...m, rows: m.rows.filter((c) => c.id !== candidateId) } : m));
      refreshAfterChange();
      return true;
    } catch (err) {
      if (err.alreadyApplied) {
        // The 'Already on this job' box says where; refresh so the list shows the person.
        setLinkHits((hits) => hits.map((c) => (c.id === candidateId && err.response?.data?.application ? { ...c, onJob: { applicationId: err.response.data.application.id, step: err.response.data.application.step, link: err.response.data.application.link } } : c)));
        refreshAfterChange();
      } else setError(err.response?.data?.error || 'Could not add this person. Please try again.');
      return false;
    } finally {
      linkBusy.current = false;
    }
  }

  async function runAction(path, body) {
    setError('');
    try {
      await api.post(`/requirements/${id}/${path}`, body || {});
      setNotice('Saved.');
      refreshAfterChange();
      return true;
    } catch (err) {
      setError(err.response?.data?.error || 'That did not work. Please try again.');
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
      tlIds: Array.isArray(r.tlIds) && r.tlIds.length ? r.tlIds : [r.tlId, ...(r.extraTlIds || [])].filter(Boolean),
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
  // Source filter, cascading with the Step filter: the Source numbers count the people at the chosen step, the
  // Step numbers count the people from the chosen sources.
  const srcWanted = new Set(String(srcFilter || '').split(',').map((x) => x.trim()).filter(Boolean));
  const srcOk = (a) => !srcWanted.size || srcWanted.has(a.sourceKey);
  const atStep = (a) => !pipeFn || pipeFn(a.stage);
  const fitKeys = (a) => (a.salaryFit && a.salaryFit.keys) || [];
  const fitBase = applications.filter((a) => atStep(a) && srcOk(a));
  const fitOptions = [['within', 'Within budget'], ['slightly', 'Slightly above'], ['above', 'Above budget'], ['missing', 'Salary missing']]
    .map(([k, l]) => [k, l, fitBase.filter((a) => fitKeys(a).includes(k)).length]).filter(([, , n]) => n > 0);
  let pipeRows = fitBase.filter((a) => !fitFilter || fitKeys(a).includes(fitFilter));
  if (fitSort) {
    const pct = (a) => (a.salaryFit && a.salaryFit.pct != null ? a.salaryFit.pct : null);
    pipeRows = [...pipeRows].sort((x, y) => {
      const px = pct(x); const py = pct(y);
      if (px === null && py === null) return 0;
      if (px === null) return 1;
      if (py === null) return -1;
      return fitSort === 'asc' ? px - py : py - px;
    });
  }
  const hasFit = applications.some((a) => a.salaryFit);
  const srcOptions = (() => {
    const m = new Map();
    applications.filter(atStep).forEach((a) => { if (a.sourceKey) m.set(a.sourceKey, (m.get(a.sourceKey) || 0) + 1); });
    return [...m.entries()].map(([value, count]) => ({ value, label: value, count })).sort((x, y) => y.count - x.count || x.label.localeCompare(y.label));
  })();
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
  // A client's job request nobody has opened yet: a Draft client job this login may edit AND open.
  const isNewRequest = r.status === 'DRAFT' && !r.internal && !!p.edit && !!p.approve;
  // Accept first (2026-10-23): a client's request nobody has taken shows ACCEPT; once taken, CREATE REQUIREMENT opens. A draft with no accept row counts as accepted.
  const needsAccept = isNewRequest && r.requestState === 'requested';
  async function acceptRequest() {
    setNotice('');
    try {
      await api.post(`/requirements/${r.id}/accept-request`);
      setNotice('Accepted. Now press Create requirement and fill in the rest.');
      load();
    } catch (e) { setNotice(e.response?.data?.error || 'Could not accept this request. Please try again.'); }
  }
  // §7 Fee / Agreement terms — BDE, Accounts, Admin, Management only.
  // TL / STL / Recruiter / HR get NO agreement info at all (user, 2026-10-12): the server sends them `gate` instead of `agreement`.
  const hideAgr = !!r.gate;
  const showAgreementTab = !hideAgr && (r.internal || !r.sections || !!r.sections.commercial);
  const pct = (v) => (v !== null && v !== undefined && v !== '' ? `${v}%` : null);
  async function deleteRequirement() {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete ${r.reqCode || r.title} for good? It cannot be brought back. A requirement with people or invoices on it cannot be deleted - close it instead.`)) return;
    try {
      await api.delete(`/requirements/${r.id}`);
      navigate('/requirements');
    } catch (e) {
      setNotice(e.response?.data?.error || 'Could not delete this requirement. Please try again.');
    }
  }
  const agreementActive = hideAgr ? true : r.agreementActive; // (for them nothing waits on an agreement; the gate banner below says "on hold")
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
        : { label: 'Not in feed', cls: 'pending', note: 'Publish on the Job Portal first — the website feed lists published requirements only.' };
    }
    // Naukri, Indeed, Shine: no account connection — what a person did.
    const last = logFor(s)[0];
    if (last && last.action === 'Posted manually') {
      const bad = notAListing(last.detail);
      return withApplied({
        label: bad ? 'Posted — check link' : 'Posted',
        cls: bad ? 'pending' : 'active',
        note: `manually by ${last.by || 'someone'} on ${day(last.at)}.`
          + (bad ? ` The saved link is a ${s} recruiter page, not the requirement's listing — Mark as posted again with the requirement's public link.`
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
      setNotice(e.response?.data?.error || 'Could not save that. Please try again.');
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
    setNotice(`Opened ${channel}. The share is saved.`);
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
    const link = prompt(`Paste the requirement's link on ${s} (optional):`, '');
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
  const toCandidatesPage = () => navigate(`/candidates?requirementId=${encodeURIComponent(r.id)}${srcFilter ? `&source=${encodeURIComponent(srcFilter)}` : ''}`);

  // --- tab bodies ------------------------------------------------------------
  const overview = (
    <>
      {/* The status is the chip in the header (no lifecycle strip, 2026-10-03). */}
      <div className="card section">
        {/* Pause (reason + date) / Resume / Close (filled or cancelled) /
            Reopen / Delete (Super Admin, never with people) — the server
            says which this login may press (GET /:id/lifecycle). */}
        <JobLifecycleBar requirementId={r.id} onChanged={refreshAfterChange} onDeleted={() => navigate('/requirements')} />
        {p.approve && !p.closeOnly && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
            {!requirementIsLive(r.status) && !PARKED.includes(r.status) && (
              <button className="btn btn-sm btn-primary" onClick={() => runAction('activate')}>Make it live</button>
            )}
          </div>
        )}
        {jobNoteOf(r) && <div className="small-muted" style={{ marginTop: 8 }}>{jobNoteOf(r)}</div>}
        {p.readOnlyReason && <div className="small-muted" style={{ marginTop: 8 }}>{p.readOnlyReason}</div>}
      </div>

      <div className="two-col">
        <div>
          <div className="card section">
            <h3 style={{ fontSize: 13, marginBottom: 10 }}>Requirement details</h3>
            <div className="grid-2">
              <div>
                <Row k="Requirement ID">{r.reqCode || r.id}</Row>
                <Row k="Requirement">{r.title}</Row>
                <Row k="Client">{clientName}</Row>
                <Row k="Departments">{(Array.isArray(r.departments) && r.departments.length ? r.departments : [r.department]).filter(Boolean).map(deptLabel).join(', ')}</Row>
                <Row k="Location">{r.location}</Row>
                <Row k="Preferred locations">{r.preferredLocation && r.preferredLocation !== 'Any' ? r.preferredLocation : 'Any location'}</Row>
                <Row k="Work Mode">{r.workMode}</Row>
                <Row k="Experience">{[r.experience, r.relevantExperience && `relevant ${r.relevantExperience}`].filter(Boolean).join(' · ')}</Row>
                <Row k="Qualification">{[r.education, r.qualifications].filter(Boolean).join(' · ')}</Row>
                <Row k="Specialization"><SpecLabel qualificationId={r.qualificationId} specialisationId={r.specialisationId} oldValue={r.specialisation} /></Row>
              </div>
              <div>
                <Row k="Openings">{`${r.openings}${r.filled ? ` · ${r.filled} filled` : ''} · ${r.remaining ?? r.openings} left`}</Row>
                <Row k="Priority"><PriorityChip value={r.priority} /></Row>
                <Row k="Salary">{`${r.salary || '—'}${r.salaryType ? ` (${r.salaryType}${r.currency ? `, ${r.currency}` : ''})` : ''}`}</Row>
                <Row k="Notice period">{r.noticePeriodMax}</Row>
                <Row k="Employment type">{[r.employmentType, r.jobPreference].filter(Boolean).join(' · ')}</Row>
                <Row k="Posted">{r.createdAt ? protoDate(r.createdAt) : null}</Row>
                <Row k="Deadline">{r.targetDate || r.closingDate}</Row>
                <Row k="Status"><JobStatusChip job={r} /></Row>
              </div>
            </div>
            <Row k="Skills">
              {list(r.skills).length ? list(r.skills).map((s) => <span className="skillpill match" key={s}>{s}</span>) : null}
            </Row>
            <div className="section-label">Job description</div>
            <div className="small-muted" style={{ whiteSpace: 'pre-line', fontSize: 12.5, lineHeight: 1.7 }}>
              {r.jobDescription || r.description || '—'}
            </div>
          </div>
        </div>
        <div>
          {/* Review #3 §4 — Assigned Team: TL and recruiters with their seat
              ("MED-5 · Medical Team"). */}
          <div className="card section">
            <h3 style={{ fontSize: 13, marginBottom: 8 }}>Team</h3>
            <Row k="Department">{[deptLabel(r.department), r.section].filter(Boolean).join(' · ')}</Row>
            <Row k="Team lead">{[r.tlName || r.tl, seatText(r.seats?.tl)].filter(Boolean).join(' · ')}</Row>
            {(r.extraTlNames || []).length > 0 && <Row k="Also assigned">{r.extraTlNames.join(', ')}</Row>}
            <Row k="Recruiter">{[r.recruiter?.name || r.workedBy, seatText(r.seats?.recruiter) || r.workedByPosition].filter(Boolean).join(' · ')}</Row>
            {(r.coRecruiters || []).map((c) => (
              <Row key={c.id} k="Recruiter">{[c.name, seatText(c.seat)].filter(Boolean).join(' · ')}</Row>
            ))}
            {!r.internal && <Row k="Client manager (BDE)">{r.bde?.name}</Row>}
            <button type="button" className="btn btn-sm" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }} onClick={() => setTab('recruiter')}>
              See team
            </button>
          </div>
          {/* Automatic stage messages: this job's own setting (follow the rules / recruiter approves first / off). */}
          <JobAutoMessages requirementId={r.id} />
          {/* docfill_: the source document (only when there is one). */}
          <SourceDocuments target="job" id={r.id} version={r.updatedAt} />
          {/* Review #3 §4 — Agreement and Job Portal lines of the 360. */}
          {!r.internal && !hideAgr && (
            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 8 }}>Agreement</h3>
              {showAgreementTab && <Row k="Status"><StatusChip status={(r.agreement && r.agreement.label) || agreementStatusLabel(r.client?.agreementStatus)} tone={agreementActive ? 'green' : 'amber'} /></Row>}
              {r.commercial && <Row k="Fee %">{pct(r.commercial.feePercent)}</Row>}
              {r.commercial && <Row k="Guarantee">{r.commercial.guaranteeDays ? (/^\d+$/.test(String(r.commercial.guaranteeDays).trim()) ? `${r.commercial.guaranteeDays} days` : r.commercial.guaranteeDays) : null}</Row>}
              {r.commercial && <Row k="Payment terms">{r.commercial.paymentTerms}</Row>}
              <Row k="Can open?">{r.agreement?.held ? 'Waiting for agreement' : agreementActive ? 'Yes' : 'After agreement is signed'}</Row>
              {showAgreementTab && (
                <button type="button" className="btn btn-sm" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }} onClick={() => setTab('agreement')}>
                  See agreement
                </button>
              )}
            </div>
          )}
          {r.portal && (
            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 8 }}>Job portal</h3>
              <Row k="On the job portal">
                {r.portal.published
                  ? <StatusChip tone="green">{`Yes${r.portal.publishedAt ? ` · ${fmtShort(r.portal.publishedAt)}` : ''}`}</StatusChip>
                  : <StatusChip tone="amber">Not yet</StatusChip>}
              </Row>
              <Row k="Applications">
                {r.portal.applications ? <Link to={candidatesLink(r.id)}>{nf(r.portal.applications)}</Link> : 'None yet'}
              </Row>
            </div>
          )}
          {/* People nearby: the full list is on the Candidates tab. */}
        </div>
      </div>

      {/* fit_ (user, 2026-10-03): the best-fitting people show right below the job, as soon as it opens. */}
      {p.matching && (
        <RequirementMatchesPanel
          requirementId={r.id}
          limit={10}
          onOpenAll={() => setTab('candidates')}
          onAdd={async (candidateId) => { await api.post('/applications', { candidateId, requirementId: r.id }); refreshAfterChange(); }}
        />
      )}
      {p.matching && (
        <SimilarCandidatesPanel
          requirementId={r.id}
          onAdd={async (candidateId) => { await api.post('/applications', { candidateId, requirementId: r.id }); refreshAfterChange(); }}
        />
      )}

      <JobPostingCard jobId={r.id} title={r.title} canPost={can(user, 'ats', 'requirements', 'Job Posting', 'edit')} onChanged={load} onPost={() => setPostStepOpen(true)} />
      {postStepOpen && <PostStepDialog job={{ id: r.id, title: r.title, reqCode: r.reqCode, tlId: r.tlId, recruiterId: r.recruiterId, recruiter: r.recruiter, department: r.department }} sources={String(r.postingSources || '').split(',').map((x) => x.trim()).filter(Boolean)} onClose={() => setPostStepOpen(false)} onChanged={load} />}

      <div className="card section" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ flex: '1 1 420px' }}>
          <b style={{ fontSize: 13 }}>Where it is posted</b>
          {!agreementActive && !r.internal && <div className="small-muted" style={{ fontSize: 12, marginTop: 2, color: 'var(--amber)' }}>Posting starts once the agreement is signed.</div>}
          {r.postingLog
            ? <div style={{ marginTop: 8 }}><JobPostingSites requirementId={r.id} version={r.updatedAt} postingText={postingText} onChanged={load} /></div>
            : null}
          {!r.internal && <PartnerShare requirementId={r.id} onChanged={load} />}
        </div>
        {/* Two buttons: "Job description" (view, preview the post, generate)
            and "Share" (LinkedIn / Facebook / WhatsApp / X, each one saved). */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn btn-sm" onClick={() => setDialog('jd')}>Job description</button>
          {(p.edit || p.share) && <button className="btn btn-sm" aria-expanded={shareOpen} onClick={() => setShareOpen((o) => !o)}>Share</button>}
        </div>
        {shareOpen && (p.edit || p.share) && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', flex: '1 1 100%' }}>
            <span className="small-muted" style={{ fontSize: 12 }}>Share on:</span>
            {SHARE.map(([ch, urlOf]) => (
              <button key={ch} type="button" className="btn btn-sm btn-ghost" onClick={() => share(ch, urlOf)}>{ch}</button>
            ))}
          </div>
        )}
      </div>
    </>
  );

  const candidatesTab = (
    <>
      <div className="card section" id="pipeline">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ fontSize: 14, margin: 0 }}>{applications.length ? `People in process (${nf(applications.length)})` : 'People in process'}</h3>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <label className="small-muted" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
              Show
              <Combo value={pipeFilter} onChange={(e) => setPipeFilter(e.target.value)}>
                {PIPE_FILTERS.map(([k, l, fn]) => (
                  <option key={k} value={k}>{`${l} (${nf(applications.filter((a) => srcOk(a) && (!fn || fn(a.stage))).length)})`}</option>
                ))}
              </Combo>
            </label>
            {hasFit && (fitOptions.length > 0 || fitFilter) && (
              <label className="small-muted" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                Salary fit
                <Combo value={fitFilter} onChange={(e) => setFitFilter(e.target.value)}>
                  <option value="">Any</option>
                  {fitOptions.map(([k, l, n]) => <option key={k} value={k}>{`${l} (${nf(n)})`}</option>)}
                  {fitFilter && !fitOptions.some(([k]) => k === fitFilter) && <option value={fitFilter}>{fitFilter}</option>}
                </Combo>
              </label>
            )}
            {srcOptions.length > 0 && (
              <MultiFacetSelect label="Source" allLabel="All sources" plural="sources" value={srcFilter} onChange={setSrcFilter} options={srcOptions} title="Where the person came from" />
            )}
            <button type="button" className="btn btn-sm" onClick={toCandidatesPage}>Open in Candidates →</button>
            {pipeRows.length > 0 && <button type="button" className="btn btn-sm btn-primary" title="Send an Email, SMS or WhatsApp to the people shown here" onClick={() => setMsgOpen(true)}>Message these {pipeRows.length}</button>}
            {msgOpen && (
              <SendManyDialog
                audience="candidates"
                ids={[...new Set(pipeRows.map((a) => a.candidateId || (a.candidate && a.candidate.id)).filter(Boolean))]}
                requirementId={r.id}
                note={`The message is filled in for the requirement "${r.title}". People who asked not to be contacted are left out.`}
                onClose={() => setMsgOpen(false)}
              />
            )}
          </div>
        </div>
        <div className="tbl-wrap">
          <table>
            {/* Source + Applied (Save & Post spec §20): where each person came from — the site of the apply link (?src=) or how they were added. */}
            <thead><tr><th>Candidate</th><th>Step</th><th>Fit %</th>{hasFit && <th><button type="button" className="link-btn" title="Sort by Salary fit" onClick={() => setFitSort(fitSort === 'desc' ? 'asc' : fitSort === 'asc' ? '' : 'desc')}>{`Salary fit${fitSort === 'desc' ? ' ↓' : fitSort === 'asc' ? ' ↑' : ''}`}</button></th>}<th>Source</th><th>Applied</th><th>Updated</th><th>Move to step</th></tr></thead>
            <tbody>
              {paged.slice.map((a) => (
                <tr key={a.id} {...rowClickProps(() => navigate(`/candidates/${a.candidateId || a.candidate?.id}`), { href: `/candidates/${a.candidateId || a.candidate?.id}` })}>
                  <td>
                    <Link to={`/candidates/${a.candidateId || a.candidate?.id}`}>{a.candidate?.name || a.candidateName}</Link>
                    {(a.candidate?.location || a.candidate?.experienceYears != null) && (
                      <div className="small-muted" style={{ fontSize: 11.5 }}>
                        {[a.candidate?.location, a.candidate?.experienceYears != null ? `${a.candidate.experienceYears} yrs` : null].filter(Boolean).join(' · ')}
                      </div>
                    )}
                    <OverrideBadge reason={a.overrideReason} by={a.overrideByName} at={a.overrideAt} />
                  </td>
                  <td><span className={`status ${stageBadgeClass(a.stage)}`}>{stageLabel(a.stage)}</span></td>
                  <td>{a.matchScore != null ? <FitWithVersion score={a.matchScore} version={a.matchVersion} /> : a.resumeScore != null ? `${a.resumeScore}%` : '—'}</td>
                  {hasFit && <td>{a.salaryFit ? <SalaryFitChips fit={a.salaryFit} compact /> : '—'}</td>}
                  <td className="cell-muted" title={recordedAs(a)}>{a.sourceKey || a.firstSource || a.source || '—'}</td>
                  <td className="cell-muted">{a.createdAt ? protoDate(a.createdAt) : '—'}</td>
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
                <tr><td colSpan="8" className="small-muted" style={{ padding: 16 }}>{applications.length ? (srcWanted.size ? 'No one at this step from these sources.' : 'No one at this step.') : 'No one added yet. Add a candidate below.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <Pager page={paged} noun="candidates" />
      </div>

      {p.pipelineEdit && <AddCandidateCard requirementId={id} onAdd={linkCandidate} />}

      {p.matching && <LocationCandidatesPanel requirementId={r.id} onAdded={refreshAfterChange} />}

      {/* resume_: the 3-number match (Overall · Resume · Location), components/resume/MatchSplit.jsx. */}
      {p.matching && (
        <RequirementMatchTabs
          requirementId={r.id}
          title={r.title}
          clientName={r.internal ? 'TeamLink internal' : r.client?.name}
          onAdd={linkCandidate}
          onChanged={refreshAfterChange}
        />
      )}
    </>
  );

  const recruiterTab = (
    <div className="two-col">
      <div>
        {/* THE ASSIGNMENT CHAIN — this is what drives scope. */}
        <div className="card section">
          <h3 style={{ fontSize: 13, marginBottom: 8 }}>Team</h3>
          <Row k="Team lead">{[r.tlName || r.tl, seatText(r.seats?.tl)].filter(Boolean).join(' · ')}</Row>
          {(r.extraTlNames || []).length > 0 && <Row k="Also assigned">{r.extraTlNames.join(', ')}</Row>}
          <Row k="Recruiter">{[r.recruiter?.name, seatText(r.seats?.recruiter)].filter(Boolean).join(' · ')}</Row>
          <Row k="Co-recruiters">
            {(r.coRecruiters || []).length ? (r.coRecruiters || []).map((c) => [c.name, seatText(c.seat)].filter(Boolean).join(' · ')).join(', ') : null}
          </Row>
          <Row k="Client manager (BDE)">{r.bde?.name}</Row>
          <Row k="Senior team lead">{r.stlName || r.stl}</Row>
          <Row k="Account manager">{r.accountManager || r.client?.accountManager}</Row>
          {!r.recruiter && r.workedBy && <Row k="Worked by">{[r.workedBy, r.workedByPosition].filter(Boolean).join(' · ')}</Row>}
          {p.assign ? (
            <button className="btn btn-sm btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }} onClick={() => openAssign(r)}>
              Change team
            </button>
          ) : (
            <div className="small-muted" style={{ marginTop: 8 }}>Only your team lead can change the team.</div>
          )}
        </div>
      </div>
      <div>
        <div className="card section">
          <h3 style={{ fontSize: 13, marginBottom: 8 }}>Who worked on this requirement</h3>
          {workers === null && <div className="small-muted">Loading…</div>}
          {workers && workers.length === 0 && <div className="small-muted">No one has worked on it yet.</div>}
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
        <div className="small-muted">Internal hiring. No client on this requirement.</div>
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
          {r.sections.clientContact === 'names' && <div className="small-muted" style={{ marginTop: 8 }}>Only the client manager (BDE) sees phone and email.</div>}
          {r.clientLink && <Link className="btn btn-sm" style={{ marginTop: 10 }} to={`/clients/${r.clientId}`}>Open client</Link>}
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
          {!hideAgr && (
            <Row k="Agreement">
              <span className={`status ${agreementBadgeClass(r.client?.agreementStatus)}`}>{agreementStatusLabel(r.client?.agreementStatus)}</span>
            </Row>
          )}
          <Link className="btn btn-sm" style={{ marginTop: 10 }} to={`/clients/${r.clientId}`}>Open client</Link>
        </>
      ) : (
        <>
          <Row k="Client">{r.client?.name}</Row>
          <div className="small-muted" style={{ marginTop: 8 }}>
            Only the client manager (BDE) sees more client details.
          </div>
        </>
      )}
    </div>
  );

  const interviewsTab = (
    <>
      <div className="card section">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ fontSize: 14, margin: 0 }}>{interviewRows.length ? `Interviews (${nf(interviewRows.length)})` : 'Interviews'}</h3>
          <Link className="btn btn-sm" to="/ats/calendar">Interview Calendar</Link>
        </div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Candidate</th><th>Step</th><th>Interview</th><th>When</th><th>Status</th><th>Mode / Interviewer</th><th>Client result</th></tr></thead>
            <tbody>
              {ipaged.slice.map((a) => (
                <tr key={a.id} {...rowClickProps(() => navigate(`/candidates/${a.candidateId}`), { href: `/candidates/${a.candidateId}` })}>
                  <td><Link to={`/candidates/${a.candidateId}`}>{a.candidate?.name}</Link></td>
                  <td><span className={`status ${stageBadgeClass(a.stage)}`}>{stageLabel(a.stage)}</span></td>
                  <td className="cell-muted">{[a.interviewCode, a.interviewType, a.interviewRound ? `Round ${a.interviewRound}` : null].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="cell-muted">{a.interviewAt ? fmtWhen(a.interviewAt) : '—'}</td>
                  <td>{a.interviewStatus ? <span className="status review">{a.interviewStatus}</span> : <span className="cell-muted">—</span>}</td>
                  <td className="cell-muted">{[a.interviewMode, a.interviewer].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="cell-muted">{a.interviewResult || '—'}</td>
                </tr>
              ))}
              {interviewRows.length === 0 && <tr><td colSpan="7" className="small-muted" style={{ padding: 16 }}>No interviews yet. Book one from a candidate.</td></tr>}
            </tbody>
          </table>
        </div>
        <Pager page={ipaged} noun="interviews" />
      </div>
      {/* AI interview kept apart — its score is never mixed with client feedback. */}
      {aiRows.length > 0 && (
        <div className="card section">
          <h3 style={{ fontSize: 14, marginBottom: 4 }}>{`AI interviews (${nf(aiRows.length)})`}</h3>
          <div className="small-muted" style={{ fontSize: 12, marginBottom: 8 }}>AI score is kept apart from client feedback.</div>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Candidate</th><th>AI interview status</th><th>AI score</th></tr></thead>
              <tbody>
                {aiRows.map((a) => (
                  <tr key={a.id} {...rowClickProps(() => navigate(`/candidates/${a.candidateId}`), { href: `/candidates/${a.candidateId}` })}>
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
        <div className="small-muted">Internal hiring. No agreement needed.</div>
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
              <Row k="Agreement date">{r.client?.agreementStart}</Row>
              <Row k="Expiry">{r.client?.agreementEnd}</Row>
            </>
          )}
          <Row k="Can open?">{ag.held ? 'Waiting for agreement' : agreementActive ? 'Yes' : 'After agreement is signed'}</Row>
          <Row k="Next step">{agreementActive ? 'Nothing. The agreement is signed.' : ag.nextStep}</Row>
          {!agreementActive && (
            ag.canOpen ? (
              <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <Link className="btn btn-sm btn-primary" to={`/clients/${r.clientId}?tab=agreements`}>Open agreement</Link>
                {!ag.canManage && <span className="small-muted">Admin finishes the agreement.</span>}
              </div>
            ) : (
              <div className="small-muted" style={{ marginTop: 10 }}>
                {`Ask the client manager (BDE)${r.bde?.name ? `, ${r.bde.name},` : ''} to get it signed.`}
              </div>
            )
          )}
          {agreementActive && ag.canOpen && (
            <Link className="btn btn-sm" style={{ marginTop: 10 }} to={`/clients/${r.clientId}?tab=agreements`}>Open agreement</Link>
          )}
        </>
      )}
    </div>
  );

  const activityTab = (
    <div className="card section">
      <h3 style={{ fontSize: 14, marginBottom: 4 }}>Activity</h3>
      <div className="small-muted" style={{ fontSize: 12, marginBottom: 8 }}>Who did what and when on this requirement.</div>
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
    overview, candidates: candidatesTab, recruiter: recruiterTab, client: clientTab, interviews: interviewsTab, agreement: agreementTab, distribute: <PostingsTab job={r} canPost={can(user, 'ats', 'requirements', 'Job Posting', 'edit')} onChanged={load}><DistributeTab job={r} onChanged={load} /></PostingsTab>, activity: activityTab,
  };
  const tabCount = { candidates: applications.length, interviews: interviewRows.length };

  return (
    <div>
      <Link className="small-muted" to="/requirements">← Requirements</Link>

      {!r.internal && <JobDupNote jobId={r.id} onOpenList={() => navigate('/requirements?tab=duplicates')} />}

      <div className="page-head" style={{ marginTop: 10, marginBottom: 6 }}>
        <div>
          <h1 style={{ fontSize: 20 }}>{`${r.reqCode ? `${r.reqCode} · ` : ''}${r.title}`}</h1>
          <div className="page-sub reqrole" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className={`rr-type ${r.internal ? 'internal' : 'client'}`} style={{ marginTop: 0 }}>{r.internal ? 'Internal' : 'Client'}</span>
            {r.internal
              ? <span className="rr-org-internal">TeamLink (internal)</span>
              : (r.clientLink ? <Link className="rr-client-link" to={`/clients/${r.clientId}`} title="Open client">{clientName}</Link> : <span>{clientName}</span>)}
            {!r.internal && <ClientPausedBadge lifecycle={r.client?.lifecycle} />}
            <span>{[deptLabel(r.department), r.location].filter(Boolean).join(' · ')}</span>
            {requirementIsLive(r.status) && (!r.tlId || (!r.recruiterId && !(r.coRecruiters || []).length)) && <span className="rr-unassigned">{!r.tlId ? 'Needs a team lead' : 'Needs a recruiter'}</span>}
            {r.daysOpen !== null && r.daysOpen !== undefined && <span className={`rr-days${r.daysOpen >= 15 ? ' overdue' : ''}`}>{`Open ${r.daysOpen} days`}</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* EDIT REQUIREMENT opens the same form Create Requirement uses;
              p.edit is resolved on the server with the record-level check. */}
          <JobStatusChip job={r} />
          {/* A CLIENT'S NEW JOB REQUEST (2026-10-09): the BDE / BDE TL fills in the rest and posts it - one main button. */}
          {needsAccept && <button className="btn btn-sm btn-primary" onClick={acceptRequest}>Accept request</button>}
          {isNewRequest && !needsAccept && (
            <button className="btn btn-sm btn-primary" onClick={() => { setNotice(''); ensureClients(); ensurePeople(); setDialog('edit'); }}>
              Create requirement
            </button>
          )}
          {p.edit && !needsAccept && (
            <button className="btn btn-sm" onClick={() => { setNotice(''); ensureClients(); ensurePeople(); setDialog('edit'); }}>
              Edit requirement
            </button>
          )}
          {(p.edit || p.share) && <EditTemplateButton requirementId={r.id} />}
          {p.askChange && !p.edit && (
            <button className="btn btn-sm" title="Requirements are changed or closed by the client manager (BDE) team. Tell them what you need." onClick={() => setAskChangeOpen(true)}>
              Ask the client manager to edit or close this requirement
            </button>
          )}
          {/* B9.4: Copy job → a new job with the same details (dates, sites and the team cleared), opened at once. */}
          {canStartJob(user) && (
            <button
              className="btn btn-sm"
              title="Makes a new requirement with the same requirement details. Dates, posting sites and the team start empty."
              onClick={async () => {
                setError('');
                try {
                  const res = await api.post(`/requirements/${id}/copy`, {});
                  navigate(`/requirements/${res.data.id}`);
                } catch (err) { setError(err.response?.data?.error || 'Could not copy this requirement.'); }
              }}
            >
              Copy requirement
            </button>
          )}
          {/* Department-wise: only this job's department's people are offered. */}
          {p.assign && !r.tlId && <button className="btn btn-sm" onClick={() => setBulkAssign('assign-tl')}>Assign TL</button>}
          {p.assign && <button className="btn btn-sm" onClick={() => setBulkAssign('assign-recruiter')}>Assign recruiter</button>}
          {/* The one main button: add people to this job. */}
          {p.pipelineEdit && <button className={`btn btn-sm${isNewRequest ? '' : ' btn-primary'}`} onClick={() => setTab('candidates')}>Add candidate</button>}
        </div>
      </div>
      {isNewRequest && (
        <div className="notice blue" role="status" style={{ marginBottom: 10 }}>
          <span>
            <b>{`New requirement request from ${clientName}.`}</b>
            {needsAccept
              ? <>{' The client gave the main details. Press '}<b>Accept request</b>{' to take it. Then Create requirement opens.'}</>
              : <>{r.requestAcceptedBy ? ` Accepted by ${r.requestAcceptedBy}.` : ''}{' Press '}<b>Create requirement</b>{', fill in the rest (description, skills, departments, team leads), then press Save & Post.'}</>}
          </span>
        </div>
      )}

      {/* ATS LAYOUT v3 — THE JOB AT A GLANCE: role (the title above), client,
          department, openings, budget, location, urgency, due date, team. */}
      {(() => {
        const dl = deadlineInfo(r);
        const recruiters = [r.recruiter?.name || r.workedBy, ...(r.coRecruiters || []).map((x) => x.name)].filter(Boolean);
        const items = [
          ['Client', clientName],
          ['Department', deptLabel(r.department) || '—'],
          ['Openings', `${nf(r.openings)}${r.filled ? ` · ${nf(r.filled)} filled` : ''} · ${nf(r.remaining ?? r.openings)} left`],
          ['Budget', r.salary ? `${r.salary}${r.salaryType ? ` (${r.salaryType})` : ''}` : 'Not set'],
          ['Location', r.location || '—'],
          ['Urgency', <PriorityChip key="pr" value={r.priority} />],
          ['Due date', <span key="dl" style={dl.overdue ? { color: 'var(--red)', fontWeight: 600 } : undefined}>{dl.text}</span>],
          ['Team', [r.tlName || r.tl ? `TL ${[r.tlName || r.tl, ...(r.extraTlNames || [])].join(', ')}` : 'No TL yet', recruiters.length ? recruiters.join(', ') : 'No recruiter yet'].join(' · ')],
        ];
        return (
          <div className="ccr-jobhead" role="group" aria-label="Requirement summary">
            {items.map(([k, v]) => (
              <div key={k}><span className="k">{k}</span><span className="v">{v}</span></div>
            ))}
          </div>
        );
      })()}

      {/* Mini funnel of THIS job's people per step (click a step → those
          people) + View Pipeline → the Candidates & Pipeline board for this job. */}
      {(() => {
        const pl = r.pipeline || {};
        const steps = (pl.steps || []).map((s) => ({ label: s.label, value: s.count, onClick: () => navigate(candidatesLink(r.id, s.stages)) }));
        const boardLink = `/candidates?view=pipeline&sub=active&requirementId=${encodeURIComponent(r.id)}&layout=board`;
        return (
          <div className="ccr-funnel-row">
            <div className="ccr-chart">
              <h3>{pl.candidates ? `People on this requirement (${nf(pl.candidates)})` : 'People on this requirement'}</h3>
              <div className="ccr-sub">Each step shows how many people are there now. Click a step to see them.</div>
              <FunnelChart steps={steps} title="People on this requirement by step" empty="No one added yet" />
            </div>
            <div className="ccr-chart ccr-side">
              <h3>Progress</h3>
              <Link className="btn btn-primary" to={boardLink}>View Pipeline</Link>
              <Link className="btn btn-sm" to={candidatesLink(r.id)}>{pl.candidates ? `All ${nf(pl.candidates)} people` : 'No one yet'}</Link>
              {pl.hold ? <Link className="btn btn-sm btn-ghost" to={candidatesLink(r.id, ['HOLD'])}>{`${nf(pl.hold)} on hold`}</Link> : null}
              {pl.rejected ? <Link className="btn btn-sm btn-ghost" to={candidatesLink(r.id, ['REJECTED'])}>{`${nf(pl.rejected)} rejected`}</Link> : null}
            </div>
          </div>
        );
      })()}

      {notice && <div className="notice">{notice}</div>}
      {!r.internal && <ClientPausedBanner clientName={clientName} lifecycle={r.client?.lifecycle} />}
      {hideAgr && r.gate.onHold && !r.internal && (
        <div className="notice amber" role="status"><span>{r.gate.message || 'This requirement is on hold. Ask your Business Development manager.'}</span></div>
      )}
      {!agreementActive && !r.internal && tab !== 'agreement' && (
        <div className="notice amber" style={{ alignItems: 'center' }}>
          <span>
            {'Waiting for agreement. This requirement opens once '}
            <b>{clientName}</b>
            {' signs.'}
          </span>
          {showAgreementTab && <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setTab('agreement')}>See agreement</button>}
        </div>
      )}
      {error && <div className="error-text">{error}</div>}

      <div className="tabs reqdet-tabs">
        {tabs.map((t) => (
          <div key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
            {TAB_LABELS[t]}
            {tabCount[t] ? <span className="n" style={{ marginLeft: 4, opacity: 0.75 }}>{nf(tabCount[t])}</span> : null}
          </div>
        ))}
      </div>

      {bodies[tabs.includes(tab) ? tab : 'overview']}

      {dialog === 'assign' && assign && (
        <Modal
          title="Change team"
          onClose={() => setDialog(null)}
          footer={(
            <>
              <button className="btn" onClick={() => setDialog(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={async () => { if (await runAction('assign', assign)) setDialog(null); }}>
                Save
              </button>
            </>
          )}
        >
          <div className="small-muted" style={{ marginBottom: 10 }}>
            This changes who can see the requirement.
          </div>
          {people === null && <div className="small-muted" style={{ marginBottom: 8 }}>Loading people…</div>}
          {/* 2026-10-05: any department's team lead; recruiters = that team lead's team, least busy first. */}
          <TeamPickers job={r} value={assign} onChange={setAssign} fallback={peopleList} />
          <label className="field">
            <span>Client manager (BDE)</span>
            <Combo value={assign.bdeId} onChange={(e) => setAssign({ ...assign, bdeId: e.target.value })}>
              <option value="">— Not assigned —</option>
              {byRole('BDE').map((t) => <option key={t.id} value={t.id}>{t.bdeLabel || t.name}</option>)}
            </Combo>
          </label>
          <label className="field">
            <span>Senior team lead</span>
            <Combo value={assign.stlId} onChange={(e) => setAssign({ ...assign, stlId: e.target.value })}>
              <option value="">— None —</option>
              {byRole('STL').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Combo>
          </label>
          {/* Account manager: unchanged here (sent as it is); edit it in Edit job. */}
        </Modal>
      )}

      {bulkAssign && (
        <RequirementBulk
          kind={bulkAssign}
          items={[{ id: r.id, reqCode: r.reqCode, title: r.title }]}
          onClose={() => setBulkAssign(null)}
          onDone={() => { refreshAfterChange(); }}
        />
      )}

      {dialog === 'jd' && (
        <Modal
          title="Job description"
          size="wide"
          onClose={() => setDialog(null)}
          footer={(
            <>
              <button className="btn" onClick={() => setDialog(null)}>Close</button>
              {p.share && <button className="btn" onClick={async () => { if (await runAction('generate-jd')) setDialog(null); }}>Write it for me</button>}
              <button className="btn btn-primary" onClick={() => setDialog('posting')}>Preview job post</button>
            </>
          )}
        >
          <JobDescription requirement={r} />
        </Modal>
      )}

      {dialog === 'posting' && (
        <Modal
          title="Preview job post"
          size="wide"
          onClose={() => setDialog(null)}
          footer={<button className="btn" onClick={() => setDialog('jd')}>← Back</button>}
        >
          <div className="cell-muted" style={{ fontSize: 12, marginBottom: 10 }}>
            This is what candidates see on every site.
          </div>
          {/* Each site's real status is in "Posting sources" on the job page (stored per site). */}
          <Row k="Sites">{sources.length ? `${sources.join(', ')} — see each site's status under Posting sources.` : 'None picked'}</Row>
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
              <span>Rejected by</span>
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
            <span>Reason Category</span>
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

      {postPanel && <PostingStatusPanel requirementId={r.id} code={r.reqCode} title={r.title} onChanged={load} onClose={() => setPostPanel(false)} />}

      {/* EDIT REQUIREMENT — the Create Requirement form in edit mode.
          `canAssign` comes from the server's per-record permission set, so
          section F is read-only for a login that may edit but not re-assign
          (the server refuses that change too). */}
      {askChangeOpen && <AskChangeJobModal jobId={id} title={r.title} onClose={() => setAskChangeOpen(false)} />}
      {dialog === 'edit' && (
        <RequirementForm
          mode="edit"
          requirement={r}
          clients={clients || []}
          team={peopleList}
          canAssign={!!p.assign}
          canOpen={!!p.approve}
          canFullEdit={!!p.fullEdit}
          onClose={() => setDialog(null)}
          onSaved={(saved, meta) => {
            setDialog(null);
            const changed = (meta && meta.changedFields) || [];
            if (meta && meta.opened) { setNotice(`Saved and opened. ${meta.posting || ''}`.trim()); setPostPanel(true); refreshAfterChange(); return; }
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
