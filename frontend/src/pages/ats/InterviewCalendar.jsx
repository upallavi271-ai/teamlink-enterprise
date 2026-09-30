import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useSearchParams } from 'react-router-dom';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  INTERVIEW_STATUS_CODES, INTERVIEW_NEXT, INTERVIEW_TYPES, INTERVIEW_KINDS,
  INTERVIEW_LIFECYCLE, INTERVIEW_EXCEPTIONS,
  INTERVIEW_RECOMMENDATIONS, FEEDBACK_CRITERIA,
  interviewStatusLabel, interviewStatusClass, resultClass, aiStatusClass, stageLabel,
} from '../../atsVocab';
import './InterviewCalendar.css';
import { canActOnPipeline, can, productRole } from '../../permissions';
import HierarchyFilter, { EMPTY_HIERARCHY, toParams, hierarchyChips, useHierarchy } from '../../components/HierarchyFilter.jsx';
import FilterChips from '../../components/FilterChips.jsx';
import MoreFilters from '../../components/ui/MoreFilters.jsx';
import StatusChip from '../../components/ui/StatusChip.jsx';
import EmptyState from '../../components/ui/EmptyState.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import { HiringTypeChip } from './intjoinShared.jsx';
import Combo from '../../components/Combo.jsx';
import ScheduleInterview from '../../components/ScheduleInterview.jsx';
import PeopleFilter from '../../components/PeopleFilter.jsx';

// Review #3 §10 §11 §15 §24:
//   * Department → Section → TL → Recruiter cascade (components/HierarchyFilter)
//     — picking Section A hides Section B's recruiters; the person levels are
//     applied by the SERVER (GET /ats/calendar?recruiter=|tl=|positionCode=)
//   * "My Interviews" is a recruiter's default (recruiter = id:<me>); a TL /
//     lead lands on everything in their scope and can switch
//   * StatusChip colours (one meaning everywhere); AI interviews show
//     "Score N% · Completed <date>" in their own tab, never beside the client
//     interview status
const AI_TONE = {
  Required: 'amber', Scheduled: 'blue', Started: 'amber', Completed: 'green', Expired: 'red', 'Manual Review Requested': 'amber',
};
const shortDay = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const o = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
  return d.toLocaleDateString('en-GB', o);
};
import AtsDataTools from '../../components/AtsDataTools.jsx';

// The prototype's Interview Calendar (calendarView, line 9184): two tabs kept
// deliberately apart, because an AI interview score is never mixed into
// recruitment/client interview feedback.
//
// Recruitment chain: Scheduled -> Confirmed -> Started -> Completed ->
// Pending Feedback. Cancelled, No Show and Rescheduled are tracked separately —
// none of them rejects the candidate.
//
// REVIEW #2 §16 / §17:
//   TYPES      AI Interview (its own tab: AI score / result / status) ·
//              Recruiter Interview · TL Interview · Client Interview (stored in
//              the application's interviewType; older "Internal Panel" rows
//              stay "Internal Panel" unless the interviewer shows which).
//   LIFECYCLE  Client Shortlisted → Scheduled → Confirmed → Started →
//              Completed → Feedback Pending → Selected / Rejected / Hold, with
//              the exceptions (Cancelled · No Show · Rescheduled) counted
//              apart. Each step is a filter; Client Shortlisted lists the
//              shortlisted candidates who have no interview booked yet.
//   AI score and client feedback are never in the same list or column.

// Department, Client, Requirement, Candidate, Recruiter, TL, BDE, Interview
// Type, Status, Hiring Type and a date range — the full Interviews filter set.
// recruiter / tl / bde hold "id:<userId>" or "name:<name>" (PeopleFilter —
// current AND former people) and positionCode a seat; those four are applied
// by the SERVER (GET /ats/calendar?recruiter=…), by who the work is
// attributed to, so a recruiter who has left still finds their interviews.
const EMPTY_FILTERS = {
  q: '', status: '', type: '', date: '', client: '', recruiter: '', tl: '', bde: '', positionCode: '',
  department: '', requirement: '', candidate: '', hiringType: '', from: '', to: '', phase: '',
};

// Roles that may move an interview. Clients watch; the API enforces this too.

// §34 — THE FIVE VIEWS. Upcoming · Today · Pending Feedback · Completed ·
// Cancelled / No Show (plus All). The same five buttons sit on both tabs, but
// each tab answers them from its OWN record — a client interview from its
// status and slot, an AI interview from its status and deadline — so the two
// kinds are never pooled into one list or one number.
const VIEW_IDS = ['upcoming', 'today', 'feedback', 'completed', 'cancelled', 'all'];
const CLIENT_VIEW_LABELS = {
  upcoming: 'Upcoming', today: 'Today', feedback: 'Pending Feedback',
  completed: 'Completed', cancelled: 'Cancelled / No Show', all: 'All',
};
// The AI interview's equivalents: it has a deadline, not a slot, and it is
// "reviewed" by a recruiter rather than given feedback.
const AI_VIEW_LABELS = {
  upcoming: 'Upcoming', today: 'Due Today', feedback: 'Pending Recruiter Review',
  completed: 'Completed', cancelled: 'Expired', all: 'All',
};
const LIVE_SLOT = ['SCHEDULED', 'CONFIRMED', 'STARTED', 'RESCHEDULED'];
const todayIso = () => new Date().toISOString().slice(0, 10);
const dayOf = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : null);

// A live slot whose date has passed is not "upcoming" any more — it is owed
// an update, so it is shown under Pending Feedback and marked Overdue.
function slotOverdue(r) {
  const d = dayOf(r.interviewAt);
  return LIVE_SLOT.includes(r.status) && !!d && d < todayIso();
}
// Once the candidate is Selected / Rejected (or past it) a still-open slot is
// history, not something to attend or give feedback on.
const DECIDED_STAGES = ['SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED', 'REJECTED'];
function clientInView(view, r) {
  const d = dayOf(r.interviewAt);
  const open = !DECIDED_STAGES.includes(r.stage);
  switch (view) {
    case 'upcoming': return open && LIVE_SLOT.includes(r.status) && (!d || d >= todayIso());
    case 'today': return d === todayIso() && !['CANCELLED', 'NO_SHOW'].includes(r.status);
    case 'feedback': return open && (['PENDING_FEEDBACK', 'COMPLETED'].includes(r.status) || slotOverdue(r));
    case 'completed': return r.status === 'FEEDBACK_SUBMITTED';
    case 'cancelled': return ['CANCELLED', 'NO_SHOW'].includes(r.status);
    default: return true;
  }
}
// An AI interview is only still "owed" while the candidate is before the
// Recruiter Review; one who was screened manually and moved on is not
// waiting on an AI interview any more.
const AI_OPEN_STAGES = ['NEW', 'AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED'];
function aiInView(view, r) {
  const owed = AI_OPEN_STAGES.includes(r.stage) && ['Required', 'Scheduled', 'Started'].includes(r.status);
  switch (view) {
    case 'upcoming': return owed;
    case 'today': return owed && r.deadline === todayIso();
    case 'feedback': return (r.status === 'Completed' && r.stage === 'AI_INTERVIEW_COMPLETED') || r.status === 'Manual Review Requested';
    case 'completed': return r.status === 'Completed';
    case 'cancelled': return r.status === 'Expired';
    default: return true;
  }
}

// The CLIENT interview's decision is where the pipeline went after it — never
// a score. Selected / Rejected / Hold, or "Decision pending" once feedback is in.
function decisionOf(r) {
  if (['SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'].includes(r.stage)) return 'Selected';
  if (r.stage === 'REJECTED') return 'Rejected';
  if (r.stage === 'HOLD') return 'Hold';
  if (r.status === 'FEEDBACK_SUBMITTED' || r.internalFeedback || r.clientFeedback) return 'Decision pending';
  return null;
}

// §17 — where one client/recruitment interview sits on the lifecycle. The
// exception statuses come first (they are shown apart), then the decision the
// pipeline took, then the interview's own status.
function phaseOf(r) {
  if (['CANCELLED', 'NO_SHOW', 'RESCHEDULED'].includes(r.status)) return r.status;
  const d = decisionOf(r);
  if (d === 'Selected') return 'SELECTED';
  if (d === 'Rejected') return 'REJECTED';
  if (d === 'Hold') return 'HOLD';
  if (['SCHEDULED', 'CONFIRMED', 'STARTED', 'COMPLETED'].includes(r.status)) return r.status;
  return 'FEEDBACK_PENDING'; // Pending Feedback, or feedback in and the decision still to come
}
const PHASE_TONE = {
  SHORTLISTED: 'new', SCHEDULED: 'new', CONFIRMED: 'new', STARTED: 'new', COMPLETED: 'active',
  FEEDBACK_PENDING: 'pending', SELECTED: 'selected', REJECTED: 'rejected', HOLD: 'hold',
  CANCELLED: 'rejected', NO_SHOW: 'rejected', RESCHEDULED: 'pending',
};

function Lifecycle({ counts, phase, setPhase }) {
  const chip = ([id, label], arrow) => (
    <span key={id} className="ivcal-life-step">
      {arrow && <span className="ivcal-life-arrow" aria-hidden="true">→</span>}
      <button
        type="button"
        className={`ivcal-life-b tone-${PHASE_TONE[id] || 'new'}${phase === id ? ' is-on' : ''}${counts[id] ? '' : ' is-zero'}`}
        aria-pressed={phase === id}
        onClick={() => setPhase(phase === id ? '' : id)}
      >
        {label} <b>{(counts[id] || 0).toLocaleString('en-IN')}</b>
      </button>
    </span>
  );
  const main = INTERVIEW_LIFECYCLE.slice(0, 6);
  const outcomes = INTERVIEW_LIFECYCLE.slice(6);
  return (
    <div className="ivcal-life" aria-label="Interview lifecycle">
      <div className="ivcal-life-row">
        {main.map((p, i) => chip(p, i > 0))}
        <span className="ivcal-life-arrow" aria-hidden="true">→</span>
        <span className="ivcal-life-group">{outcomes.map((p) => chip(p, false))}</span>
      </div>
      <div className="ivcal-life-row ivcal-life-exc">
        <span className="small-muted">Exceptions (never a rejection):</span>
        {INTERVIEW_EXCEPTIONS.map((p) => chip(p, false))}
      </div>
    </div>
  );
}

function ViewBar({ view, setView, counts, labels }) {
  return (
    <div className="ivcal-views" role="tablist" aria-label="Interview views">
      {VIEW_IDS.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={view === id}
          className={'ivcal-view' + (view === id ? ' active' : '')}
          onClick={() => setView(id)}
        >
          {labels[id]} <span className="ivcal-count">{(counts[id] || 0).toLocaleString('en-IN')}</span>
        </button>
      ))}
    </div>
  );
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function InterviewCalendar() {
  const { user } = useAuth();
  const [tab, setTab] = useState('recruitment');
  // One view per tab, so switching tabs does not carry "Pending Feedback"
  // across to the AI list (where it means something different).
  // ?view=today|upcoming|feedback|completed|cancelled|all (the dashboard's
  // tiles) opens that view on both tabs; ?mine=1|0 overrides "My Interviews".
  const [searchParams] = useSearchParams();
  const qsView = VIEW_IDS.includes(searchParams.get('view')) ? searchParams.get('view') : '';
  const [views, setViews] = useState({ recruitment: qsView || 'upcoming', ai: qsView || 'upcoming' });
  useEffect(() => {
    if (qsView) setViews({ recruitment: qsView, ai: qsView });
  }, [qsView]);
  const view = views[tab];
  const setView = (v) => setViews((prev) => ({ ...prev, [tab]: v }));
  const [data, setData] = useState({ recruitment: [], ai: [], filterOptions: {} });
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState(null); // { kind, row, ...fields }
  // ?schedule=1 (the BDE dashboard's "Schedule Interview") opens the dialog.
  const [scheduling, setScheduling] = useState(() => searchParams.get('schedule') === '1' && canActOnPipeline(user));

  const canAct = canActOnPipeline(user);
  const setFilter = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const atsRole = (user && ((user.scopeRoles && user.scopeRoles.ats && user.scopeRoles.ats !== 'NONE' && user.scopeRoles.ats) || productRole(user, 'ats'))) || '';
  const isRecruiter = atsRole === 'RECRUITER';
  const clientDesk = can(user, null, 'clients', 'Client List', 'view');
  // "My Interviews" — a recruiter's default; anyone else starts on their scope.
  const qsMine = searchParams.get('mine');
  const [mine, setMine] = useState(qsMine === '1' ? true : qsMine === '0' ? false : isRecruiter);
  const [hier, setHier] = useState(EMPTY_HIERARCHY);
  const hierTree = useHierarchy();
  const [loaded, setLoaded] = useState(false);

  function serverParams() {
    const params = {};
    const hp = toParams(hier, hierTree.data);
    ['tl', 'recruiter', 'positionCode'].forEach((k) => { if (hp[k]) params[k] = hp[k]; });
    if (filters.bde) params.bde = filters.bde;
    if (mine && user && user.id) { params.recruiter = `id:${user.id}`; delete params.positionCode; }
    return params;
  }
  const personKey = JSON.stringify(serverParams());
  function load() {
    api.get('/ats/calendar', { params: serverParams() })
      .then((res) => { setData(res.data); setError(''); })
      .catch(() => setError('Could not load the interview calendar.'))
      .finally(() => setLoaded(true));
  }
  useEffect(load, [personKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const deptFilter = hier.department || filters.department;

  const opts = data.filterOptions || {};

  // Filters first, then the view — so each view button can show how many of
  // the FILTERED interviews it holds.
  const filtered = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    return (data.recruitment || []).filter((r) => {
      if (filters.status && r.status !== filters.status) return false;
      if (filters.type && r.type !== filters.type) return false;
      if (filters.phase && filters.phase !== 'SHORTLISTED' && phaseOf(r) !== filters.phase) return false;
      if (filters.client && r.requirement.client?.name !== filters.client) return false;
      if (deptFilter && r.requirement.department !== deptFilter) return false;
      if (filters.requirement && r.requirement.title !== filters.requirement) return false;
      if (filters.candidate && r.candidate.name !== filters.candidate) return false;
      if (filters.hiringType && r.hiringType !== filters.hiringType) return false;
      if (filters.date && (!r.interviewAt || new Date(r.interviewAt).toISOString().slice(0, 10) !== filters.date)) return false;
      if (filters.from || filters.to) {
        if (!r.interviewAt) return false;
        const d = new Date(r.interviewAt).toISOString().slice(0, 10);
        if (filters.from && d < filters.from) return false;
        if (filters.to && d > filters.to) return false;
      }
      if (q && !`${r.candidate.name} ${r.requirement.title} ${r.interviewCode}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data.recruitment, filters, deptFilter]);
  // §17 — the lifecycle counts, over every filter except the step itself.
  const shortlisted = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    return (data.shortlisted || []).filter((r) => {
      if (filters.client && r.requirement.client?.name !== filters.client) return false;
      if (deptFilter && r.requirement.department !== deptFilter) return false;
      if (filters.requirement && r.requirement.title !== filters.requirement) return false;
      if (filters.candidate && r.candidate.name !== filters.candidate) return false;
      if (filters.hiringType && r.hiringType !== filters.hiringType) return false;
      if (q && !`${r.candidate.name} ${r.requirement.title}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data.shortlisted, filters, deptFilter]);
  const phaseCounts = useMemo(() => {
    const out = { SHORTLISTED: shortlisted.length };
    const q = filters.q.trim().toLowerCase();
    (data.recruitment || []).forEach((r) => {
      // Same filters as the table, minus the step filter itself.
      if (filters.status && r.status !== filters.status) return;
      if (filters.type && r.type !== filters.type) return;
      if (filters.client && r.requirement.client?.name !== filters.client) return;
      if (deptFilter && r.requirement.department !== deptFilter) return;
      if (filters.requirement && r.requirement.title !== filters.requirement) return;
      if (filters.candidate && r.candidate.name !== filters.candidate) return;
      if (filters.hiringType && r.hiringType !== filters.hiringType) return;
      if (filters.date && (!r.interviewAt || new Date(r.interviewAt).toISOString().slice(0, 10) !== filters.date)) return;
      if (filters.from || filters.to) {
        if (!r.interviewAt) return;
        const d = new Date(r.interviewAt).toISOString().slice(0, 10);
        if (filters.from && d < filters.from) return;
        if (filters.to && d > filters.to) return;
      }
      if (q && !`${r.candidate.name} ${r.requirement.title} ${r.interviewCode}`.toLowerCase().includes(q)) return;
      const p = phaseOf(r);
      out[p] = (out[p] || 0) + 1;
    });
    return out;
  }, [data.recruitment, filters, shortlisted, deptFilter]);
  const setPhase = (p) => {
    setFilter({ phase: p });
    // A lifecycle step is its own list — show all of it, not one time view.
    if (p) setViews((prev) => ({ ...prev, recruitment: 'all' }));
  };
  // Picking "AI Interview" as the type opens the AI tab (§16): the AI
  // interview is a separate record, never mixed into this list.
  const pickType = (t) => {
    if (t === 'AI Interview') { setTab('ai'); setFilter({ type: '' }); return; }
    setFilter({ type: t });
  };
  const typeOptions = useMemo(() => {
    const present = new Set((data.recruitment || []).map((r) => r.type));
    return [...INTERVIEW_KINDS, ...[...present].filter((t) => t && !INTERVIEW_KINDS.includes(t))];
  }, [data.recruitment]);
  const setType = (row, interviewType) => act(
    () => api.patch(`/ats/interviews/${row.id}/type`, { interviewType }),
    `${row.candidate.name} — interview type set to ${interviewType}.`,
  );

  const clientCounts = useMemo(() => Object.fromEntries(
    VIEW_IDS.map((id) => [id, filtered.filter((r) => clientInView(id, r)).length]),
  ), [filtered]);
  const rows = useMemo(() => {
    const list = filtered.filter((r) => clientInView(views.recruitment, r));
    // Upcoming / Today read soonest first; everything else newest first.
    const asc = ['upcoming', 'today'].includes(views.recruitment);
    return [...list].sort((a, b) => {
      const x = a.interviewAt ? new Date(a.interviewAt).getTime() : 0;
      const y = b.interviewAt ? new Date(b.interviewAt).getTime() : 0;
      return asc ? x - y : y - x;
    });
  }, [filtered, views.recruitment]);
  // 25 / 50 / 100 rows per page (list standard §21) — the table was rendering
  // every interview in scope at once.
  const ivPage = usePaged(rows);
  const aiCounts = useMemo(() => Object.fromEntries(
    VIEW_IDS.map((id) => [id, (data.ai || []).filter((r) => aiInView(id, r)).length]),
  ), [data.ai]);
  const aiRows = useMemo(() => (data.ai || []).filter((r) => aiInView(views.ai, r)), [data.ai, views.ai]);

  // Every action funnels through here so one failure path handles them all.
  async function act(fn, successMessage) {
    setError(''); setNotice('');
    try {
      await fn();
      setDialog(null);
      if (successMessage) setNotice(successMessage);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'That action could not be completed.');
    }
  }

  const advance = (row, to) => act(
    () => api.patch(`/ats/interviews/${row.id}/advance`, { to }),
    `${row.candidate.name} — interview ${interviewStatusLabel(to === 'COMPLETED' ? 'PENDING_FEEDBACK' : to).toLowerCase()}.`,
  );

  const noShow = (row) => act(
    () => api.post(`/ats/interviews/${row.id}/no-show`),
    'Marked No Show — reschedule, or take a decision on the candidate profile.',
  );

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Interview Calendar</h1>
          <div className="page-sub">
            Interview types: AI Interview · Recruiter Interview · TL Interview · Client Interview. AI Interviews
            (AI score, result and status) are their own list — an AI score is never mixed with client feedback.
          </div>
        </div>
        {/* The page's primary action. It only navigates, but it advertises a
            write this login may not make, so a view-only role (§3) is not
            shown it — the whole point of §3 is that the button is absent, not
            greyed out. `canAct` is the same matrix answer the API enforces. */}
        {/* §8 — this used to be a LINK TO THE CANDIDATES PAGE. Pressing
            "Schedule Interview" and landing on a list is the opposite of what
            the button says it does. It opens the flow now: candidate →
            requirement → type → date & time → mode → interviewer → confirm. */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {/* Template · Import · Export. Export = this tab's interviews as
              filtered (GET /ats/calendar, same person filters); Import =
              interview schedules / outcomes on existing applications. */}
          <AtsDataTools
            module="interviews"
            kinds={['interviews']}
            onImported={load}
            body={() => {
              const params = serverParams();
              const all = data.recruitment || [];
              return {
                params,
                tab: tab === 'ai' ? 'ai' : 'recruitment',
                ids: tab !== 'ai' && rows.length !== all.length ? rows.map((r) => r.id) : null,
              };
            }}
          />
          {canAct && (
            <button className="btn btn-primary" onClick={() => setScheduling(true)}>Schedule Interview</button>
          )}
        </div>
      {scheduling && (
        <ScheduleInterview
          onClose={() => setScheduling(false)}
          onScheduled={() => { setScheduling(false); load(); }}
        />
      )}
      </div>

      {/* §1 — NO WORKSPACE STRIP HERE. Interview Feedback, Offers, Joining
          and Internal Hiring are candidate workflow states, not peers of this
          module; listing them here is what made the ATS look like it had five
          more modules. They are reached from the candidate record and from the
          pipeline tabs that already carry them. */}

      {error && <div className="error-text">{error}</div>}
      {notice && <div className="card section" style={{ marginBottom: 14 }}>{notice}</div>}

      <div className="ivcal-scope" role="group" aria-label="Whose interviews">
        <button type="button" className={mine ? 'active' : ''} aria-pressed={mine} onClick={() => setMine(true)}>My Interviews</button>
        <button type="button" className={!mine ? 'active' : ''} aria-pressed={!mine} onClick={() => setMine(false)}>
          {isRecruiter ? 'All in my scope' : (atsRole === 'TL' ? 'My Team' : 'All in my scope')}
        </button>
        <span className="small-muted">
          {mine ? 'Interviews on candidates attributed to you.' : 'Every interview your access covers — narrow it with Department → Section → TL → Recruiter.'}
        </span>
      </div>

      <div className="tabbar">
        <button className={'tab-btn' + (tab === 'recruitment' ? ' active' : '')} onClick={() => setTab('recruitment')}>
          Recruiter / TL / Client Interviews ({(data.recruitment || []).length.toLocaleString('en-IN')})
        </button>
        <button className={'tab-btn' + (tab === 'ai' ? ' active' : '')} onClick={() => setTab('ai')}>
          AI Interviews ({(data.ai || []).length.toLocaleString('en-IN')})
        </button>
      </div>

      <div className="tab-content">
        {tab === 'recruitment' ? (
          <>
            <Lifecycle counts={phaseCounts} phase={filters.phase} setPhase={setPhase} />
            <ViewBar view={views.recruitment} setView={setView} counts={clientCounts} labels={CLIENT_VIEW_LABELS} />

            <MoreFilters
              storageKey="ivcal"
              activeMore={[filters.requirement, filters.candidate, filters.hiringType, filters.type, filters.date, filters.client, filters.bde, filters.from, filters.to, hier.tl].filter(Boolean).length}
              onClearAll={() => { setFilters(EMPTY_FILTERS); setHier(EMPTY_HIERARCHY); }}
              extra={(
                <span className="small-muted">
                  {filters.phase === 'SHORTLISTED' ? `${shortlisted.length} shortlisted, awaiting an interview` : `${rows.length} interview(s)`}
                  {filters.phase && <> · <button type="button" className="link-btn" onClick={() => setPhase('')}>clear step</button></>}
                </span>
              )}
              primary={(
                <>
                  <input
                    type="text"
                    placeholder="Search candidate, requirement or interview ID…"
                    value={filters.q}
                    onChange={(e) => setFilter({ q: e.target.value })}
                  />
                  <HierarchyFilter value={hier} onChange={(v) => { setHier(v); if (v.recruiter || v.tl) setMine(false); }} show={{ tl: false }} />
                  <Combo value={filters.status} onChange={(e) => setFilter({ status: e.target.value })} title="Status">
                    <option value="">All statuses</option>
                    {INTERVIEW_STATUS_CODES.map((s2) => <option key={s2} value={s2}>{interviewStatusLabel(s2)}</option>)}
                  </Combo>
                </>
              )}
            >
              <HierarchyFilter value={hier} onChange={(v) => { setHier(v); if (v.tl) setMine(false); }} show={{ department: false, section: false, recruiter: false }} />
              <Combo value={filters.requirement} onChange={(e) => setFilter({ requirement: e.target.value })} title="Requirement">
                <option value="">All requirements</option>
                {(opts.requirements || []).map((d) => <option key={d}>{d}</option>)}
              </Combo>
              <Combo value={filters.candidate} onChange={(e) => setFilter({ candidate: e.target.value })} title="Candidate">
                <option value="">All candidates</option>
                {(opts.candidates || []).map((d) => <option key={d}>{d}</option>)}
              </Combo>
              <Combo value={filters.hiringType} onChange={(e) => setFilter({ hiringType: e.target.value })} title="Hiring type">
                <option value="">All hiring types</option>
                {(data.hiringTypes || []).map((d) => <option key={d}>{d}</option>)}
              </Combo>
              <Combo value={filters.type} onChange={(e) => pickType(e.target.value)} title="Interview type">
                <option value="">All types</option>
                {typeOptions.map((t) => <option key={t} value={t}>{t === 'AI Interview' ? 'AI Interview (opens the AI tab)' : t}</option>)}
              </Combo>
              <Combo value={filters.date} onChange={(e) => setFilter({ date: e.target.value })} title="Date">
                <option value="">All dates</option>
                {(opts.dates || []).map((d) => <option key={d} value={d}>{fmtDate(d)}</option>)}
              </Combo>
              {clientDesk && (
                <Combo value={filters.client} onChange={(e) => setFilter({ client: e.target.value })} title="Client">
                  <option value="">All clients</option>
                  {(opts.clients || []).map((c) => <option key={c}>{c}</option>)}
                </Combo>
              )}
              {!isRecruiter && <PeopleFilter role="BDE" department={deptFilter} value={filters.bde} onChange={(v) => setFilter({ bde: v })} />}
              <label className="small-muted">From <input type="date" value={filters.from} onChange={(e) => setFilter({ from: e.target.value })} /></label>
              <label className="small-muted">To <input type="date" value={filters.to} onChange={(e) => setFilter({ to: e.target.value })} /></label>
            </MoreFilters>
            <FilterChips
              onClearAll={() => { setFilters(EMPTY_FILTERS); setHier(EMPTY_HIERARCHY); }}
              filters={[
                ...hierarchyChips(hier, hierTree.data, setHier),
                { key: 'q', label: 'Search', value: filters.q, onRemove: () => setFilter({ q: '' }) },
                { key: 'status', label: 'Status', value: filters.status ? interviewStatusLabel(filters.status) : '', onRemove: () => setFilter({ status: '' }) },
                { key: 'req', label: 'Requirement', value: filters.requirement, onRemove: () => setFilter({ requirement: '' }) },
                { key: 'cand', label: 'Candidate', value: filters.candidate, onRemove: () => setFilter({ candidate: '' }) },
                { key: 'ht', label: 'Hiring type', value: filters.hiringType, onRemove: () => setFilter({ hiringType: '' }) },
                { key: 'type', label: 'Type', value: filters.type, onRemove: () => setFilter({ type: '' }) },
                { key: 'date', label: 'Date', value: filters.date ? fmtDate(filters.date) : '', onRemove: () => setFilter({ date: '' }) },
                { key: 'client', label: 'Client', value: filters.client, onRemove: () => setFilter({ client: '' }) },
                { key: 'bde', label: 'BDE', value: filters.bde ? (filters.bde.startsWith('name:') ? filters.bde.slice(5) : 'selected') : '', onRemove: () => setFilter({ bde: '' }) },
                { key: 'from', label: 'From', value: filters.from, onRemove: () => setFilter({ from: '' }) },
                { key: 'to', label: 'To', value: filters.to, onRemove: () => setFilter({ to: '' }) },
              ]}
            />

            {filters.phase === 'SHORTLISTED' ? (
              <div className="tbl-wrap">
                <table>
                  <thead>
                    <tr><th>Candidate</th><th>Requirement</th><th>Client</th><th>Hiring Type</th><th>Shortlisted</th><th>Next Action</th></tr>
                  </thead>
                  <tbody>
                    {shortlisted.map((r) => (
                      <tr key={r.id}>
                        <td className="row-link"><Link to={`/candidates/${r.candidate.id}`}>{r.candidate.name}</Link></td>
                        <td className="row-link"><Link to={`/requirements/${r.requirement.id}`}>{r.requirement.title}</Link></td>
                        <td className="small-muted">{r.requirement.client?.name || '—'}</td>
                        <td><HiringTypeChip value={r.hiringType} /></td>
                        <td className="small-muted">{fmtDate(r.shortlistedAt)}</td>
                        <td>
                          {canAct
                            ? <button type="button" className="btn btn-sm btn-primary" onClick={() => setScheduling(true)}>Schedule Interview</button>
                            : <span className="small-muted">Schedule Interview</span>}
                        </td>
                      </tr>
                    ))}
                    {shortlisted.length === 0 && (
                      <tr><td colSpan="6" style={{ padding: 0 }}><EmptyState compact icon="✅" title="No shortlisted candidates are waiting for an interview." hint="When a client shortlists a candidate, they appear here until the interview is booked." /></td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            ) : (
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Interview ID</th><th>Candidate</th><th>Requirement</th><th>Client</th>
                    <th>Hiring Type</th><th>Round</th><th>Type</th><th>Interviewer</th><th>Date</th><th>Time</th>
                    <th>Mode</th><th>Meeting / Location</th><th>Status</th><th>Panel Feedback</th>
                    <th>Client Feedback</th><th>Decision</th><th>Created By</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {ivPage.slice.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <b>{r.interviewCode}</b>
                        {r.rescheduleCount > 0 && <> <span className="status pending" title="Times rescheduled">×{r.rescheduleCount}</span></>}
                      </td>
                      <td className="row-link"><Link to={`/candidates/${r.candidate.id}`}>{r.candidate.name}</Link></td>
                      <td className="row-link"><Link to={`/requirements/${r.requirement.id}`}>{r.requirement.title}</Link></td>
                      <td className="small-muted">{r.requirement.client?.name || '—'}</td>
                      <td><HiringTypeChip value={r.hiringType} /></td>
                      <td className="small-muted">{r.round}</td>
                      <td className="small-muted">
                        {r.type}
                        {canAct && !INTERVIEW_TYPES.includes(r.storedType) && !['CANCELLED', 'NO_SHOW'].includes(r.status) && (
                          <select
                            className="ivcal-type-set"
                            value=""
                            aria-label="Set interview type"
                            title="Record which kind of interview this is"
                            onChange={(e) => { if (e.target.value) setType(r, e.target.value); }}
                          >
                            <option value="">Set type…</option>
                            {INTERVIEW_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                          </select>
                        )}
                      </td>
                      <td className="small-muted">{r.interviewer || '—'}</td>
                      <td className="small-muted">{fmtDate(r.interviewAt)}</td>
                      <td className="small-muted">{fmtTime(r.interviewAt)}</td>
                      <td className="small-muted">{r.mode || '—'}</td>
                      <td className="small-muted">{r.meeting || '—'}</td>
                      <td>
                        <StatusChip status={r.statusLabel} tone={{ RESCHEDULED: 'amber', FEEDBACK_SUBMITTED: 'green' }[r.status]} />
                        {slotOverdue(r) && <> <StatusChip status="Overdue" /></>}
                        {r.cancelReason && <div className="small-muted" style={{ fontSize: 11 }}>{r.cancelReason}</div>}
                      </td>
                      <td><FeedbackCell fb={r.internalFeedback} score={r.score} /></td>
                      <td><FeedbackCell fb={r.clientFeedback} /></td>
                      <td>
                        {(() => {
                          const d = decisionOf(r);
                          if (!d) return <span className="small-muted">—</span>;
                          return <StatusChip status={d} />;
                        })()}
                      </td>
                      <td className="small-muted">{r.createdBy || '—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {!canAct ? <span className="small-muted">—</span> : <Actions row={r} advance={advance} noShow={noShow} setDialog={setDialog} />}
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr><td colSpan="18" style={{ padding: 0 }}>
                      <EmptyState
                        compact
                        icon="📅"
                        title={loaded ? `No ${CLIENT_VIEW_LABELS[views.recruitment].toLowerCase()} interviews${filtered.length ? ' for these filters' : ''}.` : 'Loading interviews…'}
                        hint={loaded ? (mine ? 'Nothing on your own candidates here — switch to "All in my scope", or try another view.' : 'Try another view (Upcoming · Today · Pending Feedback …) or clear the filters.') : undefined}
                      />
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
            )}
            {filters.phase !== 'SHORTLISTED' && rows.length > 0 && <Pager page={ivPage} noun="interviews" />}
          </>
        ) : (
          <>
            <ViewBar view={views.ai} setView={setView} counts={aiCounts} labels={AI_VIEW_LABELS} />
            <AiTab rows={aiRows} canAct={canAct} act={act} emptyLabel={AI_VIEW_LABELS[views.ai]} mine={mine} />
          </>
        )}
      </div>

      {dialog?.kind === 'reschedule' && <RescheduleForm dialog={dialog} setDialog={setDialog} act={act} />}
      {dialog?.kind === 'cancel' && <CancelForm dialog={dialog} setDialog={setDialog} act={act} />}
      {dialog?.kind === 'feedback' && <FeedbackForm dialog={dialog} setDialog={setDialog} act={act} />}
      {dialog?.kind === 'history' && <HistoryPanel dialog={dialog} setDialog={setDialog} />}
    </div>
  );
}

// The prototype's ivActionsHtml(): what you can do depends entirely on where the
// interview currently is.
function Actions({ row, advance, noShow, setDialog }) {
  const st = row.status;
  const next = INTERVIEW_NEXT[st];
  const nextLabel = next === 'CONFIRMED' ? 'Confirm' : next === 'STARTED' ? 'Start' : 'Complete';

  if (['CANCELLED', 'NO_SHOW', 'RESCHEDULED'].includes(st)) {
    return (
      <>
        <button className="btn btn-sm btn-primary" onClick={() => setDialog({ kind: 'reschedule', row })}>Reschedule</button>{' '}
        {st === 'RESCHEDULED' && <button className="btn btn-sm" onClick={() => advance(row, 'CONFIRMED')}>Confirm</button>}{' '}
        <button className="btn btn-sm btn-ghost" onClick={() => setDialog({ kind: 'history', row })}>History</button>
      </>
    );
  }
  if (['PENDING_FEEDBACK', 'COMPLETED', 'FEEDBACK_SUBMITTED'].includes(st)) {
    // Feedback in, decision not yet taken: the one next action is the decision.
    const decide = st === 'FEEDBACK_SUBMITTED' && ['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED'].includes(row.stage);
    return (
      <>
        {decide && <><Link className="btn btn-sm btn-primary" to="/ats/interview-feedback">Take Decision →</Link>{' '}</>}
        <button className={'btn btn-sm' + (decide ? '' : ' btn-primary')} onClick={() => setDialog({ kind: 'feedback', row })}>
          {['COMPLETED', 'FEEDBACK_SUBMITTED'].includes(st) ? 'Edit Feedback' : 'Add Feedback'}
        </button>{' '}
        <button className="btn btn-sm btn-ghost" onClick={() => setDialog({ kind: 'history', row })}>History</button>
      </>
    );
  }
  return (
    <>
      {next && <><button className="btn btn-sm btn-primary" onClick={() => advance(row, next)}>{nextLabel}</button>{' '}</>}
      <button className="btn btn-sm" onClick={() => setDialog({ kind: 'reschedule', row })}>Reschedule</button>{' '}
      <button className="btn btn-sm" onClick={() => noShow(row)}>No Show</button>{' '}
      <button className="btn btn-sm btn-ghost" onClick={() => setDialog({ kind: 'cancel', row })}>Cancel</button>
    </>
  );
}

// One feedback record — the internal panel's, or the client's. Recommendation
// plus who wrote it; the panel's optional 0–100 score is labelled as the
// PANEL score so it can never be read as an AI score.
function FeedbackCell({ fb, score }) {
  if (!fb) return <span className="small-muted">Not submitted</span>;
  return (
    <div>
      <StatusChip status={fb.recommendation} />
      {score != null && <div className="small-muted" style={{ fontSize: 11 }}>Panel score {score}/100</div>}
      {fb.submittedBy && <div className="small-muted" style={{ fontSize: 11 }}>by {fb.submittedBy}</div>}
    </div>
  );
}

// Styles.css has no modal; the app's own pattern is an inline card, so these
// open below the table rather than importing the prototype's inline CSS.
function Panel({ title, subtitle, children, onClose }) {
  return (
    <div className="card section" style={{ marginTop: 16 }}>
      <div className="page-head" style={{ marginBottom: 8 }}>
        <div><h3>{title}</h3>{subtitle && <div className="page-sub">{subtitle}</div>}</div>
        <button className="btn btn-sm btn-ghost" onClick={onClose}>Close</button>
      </div>
      {children}
    </div>
  );
}

function RescheduleForm({ dialog, setDialog, act }) {
  const { row } = dialog;
  const [when, setWhen] = useState('');
  const [reason, setReason] = useState('');
  return (
    <Panel
      title={`Reschedule — ${row.candidate.name}`}
      subtitle={`Currently ${fmtDate(row.interviewAt)} ${fmtTime(row.interviewAt)} · ${row.statusLabel}`}
      onClose={() => setDialog(null)}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          act(() => api.post(`/ats/interviews/${row.id}/reschedule`, { interviewAt: when, reason }), `Rescheduled to ${fmtDate(when)}.`);
        }}
      >
        <div className="grid-2">
          <label className="field"><span>New date &amp; time *</span>
            <input required type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
          <label className="field"><span>Reason *</span>
            <input required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is it moving?" /></label>
        </div>
        <div className="small-muted" style={{ marginBottom: 10 }}>
          Every reschedule is kept in the interview&apos;s history — nothing is overwritten silently.
        </div>
        <button className="btn btn-primary btn-sm" type="submit">Reschedule</button>
      </form>
    </Panel>
  );
}

function CancelForm({ dialog, setDialog, act }) {
  const { row } = dialog;
  const [reason, setReason] = useState('');
  return (
    <Panel title={`Cancel interview — ${row.candidate.name}`} onClose={() => setDialog(null)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          act(() => api.post(`/ats/interviews/${row.id}/cancel`, { reason }), 'Interview cancelled — the candidate stays where they were.');
        }}
      >
        <label className="field" style={{ marginBottom: 10 }}><span>Cancellation reason *</span>
          <textarea required rows="2" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <div className="small-muted" style={{ marginBottom: 10 }}>
          A cancelled interview is not a rejection — the candidate stays at their current stage.
        </div>
        <button className="btn btn-primary btn-sm" type="submit">Cancel interview</button>
      </form>
    </Panel>
  );
}

function FeedbackForm({ dialog, setDialog, act }) {
  const { row } = dialog;
  const fb = row.internalFeedback || {};
  const [form, setForm] = useState({
    technical: fb.technical ?? 3,
    communication: fb.communication ?? 3,
    experience: fb.experience ?? 3,
    roleFit: fb.roleFit ?? 3,
    score: row.score ?? '',
    feedback: fb.overall || row.feedback || '',
    result: INTERVIEW_RECOMMENDATIONS.includes(row.result) ? row.result : 'Selected',
  });
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  return (
    <Panel
      title={`Interview feedback — ${row.candidate.name}`}
      subtitle={`${row.interviewCode} · Round ${row.round} · ${row.type}`}
      onClose={() => setDialog(null)}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          act(
            () => api.post(`/ats/interviews/${row.id}/feedback`, form),
            'Feedback submitted — the interview is now Feedback Submitted. Take the decision on Interview Feedback.',
          );
        }}
      >
        <div className="grid-3">
          {FEEDBACK_CRITERIA.map((c) => (
            <label className="field" key={c.key}>
              <span>{c.label} (1–5)</span>
              <Combo value={form[c.key]} onChange={(e) => set({ [c.key]: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
              </Combo>
            </label>
          ))}
          <label className="field"><span>Score (0–100)</span>
            <input type="number" min="0" max="100" value={form.score} onChange={(e) => set({ score: e.target.value })} /></label>
          <label className="field"><span>Recommendation</span>
            <Combo value={form.result} onChange={(e) => set({ result: e.target.value })}>
              {INTERVIEW_RECOMMENDATIONS.map((r) => <option key={r}>{r}</option>)}
            </Combo></label>
        </div>
        <label className="field" style={{ marginBottom: 10 }}><span>Overall Feedback *</span>
          <textarea required rows="3" value={form.feedback} onChange={(e) => set({ feedback: e.target.value })} /></label>
        <div className="small-muted" style={{ marginBottom: 10 }}>
          This is the internal recruitment / client interview record — kept separate from the AI
          Interview score, and from the client&apos;s own feedback record.
        </div>
        <button className="btn btn-primary btn-sm" type="submit">Save feedback</button>
      </form>
    </Panel>
  );
}

function HistoryPanel({ dialog, setDialog }) {
  const { row } = dialog;
  return (
    <Panel title={`History — ${row.interviewCode}`} subtitle={row.candidate.name} onClose={() => setDialog(null)}>
      {(row.history || []).length === 0 && <div className="small-muted">Nothing recorded yet.</div>}
      {(row.history || []).map((h) => (
        <div className="timeline-item" key={h.id}>
          <b>{interviewStatusLabel(h.status)}</b>
          {h.by && <span className="small-muted"> · {h.by}</span>}
          {h.reason && <div className="small-muted">{h.reason}</div>}
          {h.fromSlot && h.toSlot && (
            <div className="small-muted">{fmtDate(h.fromSlot)} {fmtTime(h.fromSlot)} → {fmtDate(h.toSlot)} {fmtTime(h.toSlot)}</div>
          )}
          <div className="timeline-date">{new Date(h.createdAt).toLocaleString()}</div>
        </div>
      ))}
    </Panel>
  );
}

// An expired AI interview does NOT reject the candidate — it can be extended,
// resent, or handed to a recruiter for a manual screen.
//
// §34 — AI interviews carry an AI SCORE, an AI RESULT and an AI STATUS, and
// nothing else: no client feedback, no interview decision. "Result" here is
// what the AI screen led to — awaiting the recruiter's review, reviewed and
// moved on, or expired — never a hiring decision.
function aiOutcome(r) {
  if (r.status === 'Expired') return { text: 'Expired — not a rejection', tone: 'rejected' };
  if (r.status === 'Manual Review Requested') return { text: 'Manual review requested', tone: 'pending' };
  if (r.status !== 'Completed' && !AI_OPEN_STAGES.includes(r.stage)) return { text: 'Not taken — screened by recruiter', tone: 'new' };
  if (r.status !== 'Completed') return { text: 'Awaiting candidate', tone: 'pending' };
  if (r.stage === 'AI_INTERVIEW_COMPLETED') return { text: 'Awaiting Recruiter Review', tone: 'pending' };
  if (r.stage === 'REJECTED') return { text: 'Reviewed — Rejected', tone: 'rejected' };
  if (r.stage === 'HOLD') return { text: 'Reviewed — Hold', tone: 'pending' };
  return { text: `Reviewed — now ${stageLabel(r.stage)}`, tone: 'active' };
}

function AiTab({
  rows, canAct, act, emptyLabel, mine,
}) {
  const page = usePaged(rows);
  return (
    <>
      <div className="small-muted" style={{ marginBottom: 10 }}>
        AI interviews: Required → Scheduled → Started → Completed → AI score → Recruiter Review.
        An expired AI interview never rejects the candidate. AI scores are a screening aid (simulated)
        and are never shown beside client interview feedback.
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>AI Interview ID</th><th>Candidate</th><th>Requirement</th><th>AI Interview</th><th>AI Status</th>
              <th>Deadline</th><th>AI Result</th><th>AI Feedback</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {page.slice.map((r) => {
              const expired = r.status === 'Expired';
              const outcome = aiOutcome(r);
              return (
                <tr key={r.id}>
                  <td><b>{r.aiCode}</b></td>
                  <td className="row-link"><Link to={`/candidates/${r.candidate.id}`}>{r.candidate.name}</Link></td>
                  <td className="small-muted">{r.requirement.title}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {/* "AI Interview · Score 82% · Completed 27 Sep" — its own
                        line, never beside the client interview status. */}
                    {r.status === 'Completed'
                      ? <b>{['Score', r.score != null ? `${r.score}%` : '—'].join(' ')}{` · Completed${r.completedAt ? ` ${shortDay(r.completedAt)}` : ''}`}</b>
                      : <span className="small-muted">{r.score != null ? `Score ${r.score}%` : 'No score yet'}</span>}
                    {r.score != null && <div className="small-muted" style={{ fontSize: 11 }}>Simulated screening score</div>}
                  </td>
                  <td><StatusChip status={r.status} tone={AI_TONE[r.status]} /></td>
                  <td className="small-muted">{r.deadline ? fmtDate(r.deadline) : '—'}</td>
                  <td><StatusChip status={outcome.text} tone={{ rejected: 'red', pending: 'amber', active: 'green', new: 'grey' }[outcome.tone]} /></td>
                  <td className="small-muted">
                    {r.feedback || (r.score != null ? 'AI-generated summary available on the candidate profile.' : '—')}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {!canAct ? <span className="small-muted">—</span> : (
                      <>
                        {r.stage === 'AI_INTERVIEW_COMPLETED' && (
                          <><Link className="btn btn-sm btn-primary" to={`/candidates/${r.candidate.id}`}>Review Candidate →</Link>{' '}</>
                        )}
                        {expired && (
                          <>
                            <button className="btn btn-sm btn-primary" onClick={() => act(() => api.post(`/ats/ai-interviews/${r.id}/extend`, {}), 'Deadline extended — the candidate stays active.')}>Extend Deadline</button>{' '}
                          </>
                        )}
                        {r.status !== 'Completed' && AI_OPEN_STAGES.includes(r.stage) && (
                          <><button className="btn btn-sm" onClick={() => act(() => api.post(`/ats/ai-interviews/${r.id}/resend`), 'AI interview invite resent (Email / WhatsApp / SMS).')}>Resend</button>{' '}</>
                        )}
                        {expired && (
                          <button className="btn btn-sm" onClick={() => act(() => api.post(`/ats/ai-interviews/${r.id}/manual-review`), 'Manual review requested — a recruiter will screen this candidate directly.')}>Manual Review</button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan="9" style={{ padding: 0 }}>
                <EmptyState
                  compact
                  icon="🤖"
                  title={`No AI interviews in ${String(emptyLabel || 'this view').toLowerCase()}.`}
                  hint={mine ? 'Showing your own candidates only — switch to "All in my scope" to see more.' : 'Try another view.'}
                />
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      {rows.length > 0 && <Pager page={page} noun="AI interviews" />}
      <div className="card section" style={{ marginTop: 12 }}>
        An expired AI interview does <b>not</b> reject the candidate — the application stays in its
        current stage and can be extended, resent, or sent for manual review.
      </div>
    </>
  );
}
