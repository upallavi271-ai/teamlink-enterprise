import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useSearchParams } from 'react-router-dom';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  INTERVIEW_NEXT, INTERVIEW_TYPES,
  INTERVIEW_LIFECYCLE, INTERVIEW_EXCEPTIONS,
  INTERVIEW_RECOMMENDATIONS, FEEDBACK_CRITERIA,
  interviewStatusLabel, interviewStatusClass, resultClass, aiStatusClass, stageLabel,
} from '../../atsVocab';
import './InterviewCalendar.css';
import { canActOnPipeline, productRole, can, canRaiseRequirement } from '../../permissions';
// ATS LAYOUT v3 (2026-10-03): filters bar → cards → charts → table, all from
// the shared kit. The calendar is coloured by department (kit palette).
import PageFilterBar, { usePageFilters } from '../../components/ui/PageFilterBar.jsx';
import { BarChart, slotVar } from '../../components/charts';
import './InterviewCalendarV3.css';
import HierarchyFilter, {
  EMPTY_HIERARCHY, toParams, hierarchyChips, useHierarchy,
} from '../../components/HierarchyFilter.jsx';
import {
  StatusTabs, ListToolbar, ListFooter, FacetSelect, PanelField, useLocalFacets,
} from '../../components/ui/ListPageHeader.jsx';
import StatusChip from '../../components/ui/StatusChip.jsx';
import EmptyState from '../../components/ui/EmptyState.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import { HiringTypeChip } from './intjoinShared.jsx';
import Combo from '../../components/Combo.jsx';
import ScheduleInterview from '../../components/ScheduleInterview.jsx';
// Change list §11 (2026-10-03): the short feedback form (with "Did not
// attend" inside it), the Day / Week / Month calendar toggle, late feedback
// in red, and the Admin switch for automatic reminders.
import ShortFeedbackForm from '../../components/interviews/ShortFeedbackForm.jsx';
import InterviewCalendarGrid, { isLateFeedback } from '../../components/interviews/InterviewCalendarGrid.jsx';
import '../../components/interviews/Interviews.css';
import { Modal } from '../../components/proto.jsx';
// B4 (2026-10-06): the interview panel, each person's feedback, meeting links.
import PanelView from '../../components/interviews/PanelView.jsx';
import PanelPicker from '../../components/interviews/PanelPicker.jsx';
import MeetingLinkButton from '../../components/interviews/MeetingLinkButton.jsx';
// A name opens the candidate window right here (checklist §13), not another page.
import CandidateDrawer from '../../components/CandidateDrawer.jsx';

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
// INTERVIEW CALENDAR v4 (2026-10-08): the reference layout, built from the
// shared ATS kit + components/interviews-v4 (presentation only).
import {
  KpiRow, KpiTile, Panel as AkPanel, QuickActions, Pill, Icon, pctChange,
} from '../../components/atskit/AtsKit.jsx';
import WeekGrid from '../../components/interviews-v4/WeekGrid.jsx';
import MiniMonth from '../../components/interviews-v4/MiniMonth.jsx';
import DetailsCard from '../../components/interviews-v4/DetailsCard.jsx';
import {
  viewRange, stepAnchor, startOfDay, groupByDay, statusTone, fmtDay, DAY_MS,
} from '../../components/interviews-v4/calUtils.js';
import '../../components/interviews-v4/iv4.css';

// v4: the left column's quick filters — the list's own views, counted.
const QUICK = [
  ['upcoming', 'Upcoming', 'blue'], ['today', 'Today', 'teal'], ['feedback', 'Feedback pending', 'amber'],
  ['moved', 'Rescheduled / did not attend', 'violet'], ['completed', 'Done', 'green'], ['cancelled', 'Cancelled / no-show', 'red'],
];
// "Completed" for the KPI tile: the interview happened (done, feedback owed or in).
const DONE_STATUSES = ['COMPLETED', 'PENDING_FEEDBACK', 'FEEDBACK_SUBMITTED'];

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
// v3: + This week and Moved / did not attend (the cards).
const VIEW_IDS = ['upcoming', 'today', 'week', 'feedback', 'moved', 'completed', 'cancelled', 'all'];
const AI_VIEW_IDS = ['upcoming', 'today', 'feedback', 'completed', 'cancelled', 'all'];
const CLIENT_VIEW_LABELS = {
  upcoming: 'Upcoming', today: 'Today', week: 'This week', feedback: 'Feedback pending',
  moved: 'Rescheduled / did not attend', completed: 'Done', cancelled: 'Cancelled / no-show', all: 'All',
};
// The AI interview's equivalents: it has a deadline, not a slot, and it is
// "reviewed" by a recruiter rather than given feedback.
const AI_VIEW_LABELS = {
  upcoming: 'Upcoming', today: 'Due today', feedback: 'Waiting for recruiter check',
  completed: 'Done', cancelled: 'Expired', all: 'All',
};
// Four daily chips (checklist §5). Cancelled / no-show is a Step in Filters;
// clicking the chip that is on shows All. ?view=cancelled|all still works.
const BAR_IDS = ['today', 'upcoming', 'feedback', 'completed'];
const CLIENT_EMPTY = {
  today: 'No interviews today.', upcoming: 'No interviews coming up.', feedback: 'No feedback waiting.',
  week: 'No interviews this week.', moved: 'Nothing rescheduled or missed.',
  completed: 'No finished interviews yet.', cancelled: 'No cancelled interviews.', all: 'No interviews yet.',
};
const AI_EMPTY = {
  today: 'No AI interviews due today.', upcoming: 'No AI interviews coming up.', feedback: 'No AI interviews to check.',
  completed: 'No finished AI interviews yet.', cancelled: 'No expired AI interviews.', all: 'No AI interviews yet.',
};
// Shown words only — the status VALUES sent to / read from the API stay as they are.
const AI_STATUS_TEXT = { 'Manual Review Requested': 'Check by recruiter' };
const hireText = (v) => (v === 'TeamLink Internal Hire' ? 'TeamLink hire' : v ? 'Client hire' : '');
const LIVE_SLOT = ['SCHEDULED', 'CONFIRMED', 'STARTED', 'RESCHEDULED'];
// The Filters panel's counted options (spec 2026-10-03 §B). Recruiter is the
// requirement's recruiter (the export's 'Worked By'); Section / TL / BDE stay
// the server's person filters (attributed work, former people included).
const CAL_FIELDS = [
  { key: 'type', get: (r) => r.type },
  { key: 'status', get: (r) => r.status, label: (v) => interviewStatusLabel(v) },
  { key: 'department', get: (r) => r.requirement.department },
  { key: 'clientId', get: (r) => r.requirement.client?.id, label: (v, r) => r.requirement.client.name },
  { key: 'recruiterId', get: (r) => r.requirement.recruiter?.id, label: (v, r) => r.requirement.recruiter.name },
  { key: 'bdeId', get: (r) => r.requirement.bde?.id, label: (v, r) => r.requirement.bde.name },
  { key: 'requirement', get: (r) => r.requirement.title },
  { key: 'candidate', get: (r) => r.candidate.name },
  { key: 'hiringType', get: (r) => r.hiringType },
];
function calPred(r, k, v) {
  switch (k) {
    case 'type': return r.type === v;
    case 'status': return r.status === v;
    case 'department': return r.requirement.department === v;
    case 'clientId': return r.requirement.client?.id === v;
    case 'recruiterId': return r.requirement.recruiter?.id === v;
    case 'bdeId': return r.requirement.bde?.id === v;
    case 'requirement': return r.requirement.title === v;
    case 'candidate': return r.candidate.name === v;
    case 'hiringType': return r.hiringType === v;
    default: return true;
  }
}
// The four page-bar filters, counted locally (the calendar holds its whole
// list) so they cascade: Manufacturing → only Manufacturing clients / people.
const PF_FIELDS = CAL_FIELDS.filter((x) => ['department', 'clientId', 'recruiterId', 'bdeId'].includes(x.key));
// The page bar's date range as the calendar reads it: a WHOLE week / month
// (upcoming days count), not "so far".
const ymdL = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const mondayL = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
function calRange(pf) {
  const t = new Date();
  const today = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  switch (pf.range) {
    case 'today': return { from: ymdL(today), to: ymdL(today) };
    case 'week': { const m = mondayL(today); const e = new Date(m); e.setDate(e.getDate() + 6); return { from: ymdL(m), to: ymdL(e) }; }
    case 'month': return { from: ymdL(new Date(today.getFullYear(), today.getMonth(), 1)), to: ymdL(new Date(today.getFullYear(), today.getMonth() + 1, 0)) };
    case '30d': { const s0 = new Date(today); s0.setDate(s0.getDate() - 29); return { from: ymdL(s0), to: ymdL(today) }; }
    case 'custom': return { from: pf.from || '', to: pf.to || '' };
    default: return { from: '', to: '' };
  }
}
const localDay = (iso) => (iso ? ymdL(new Date(iso)) : null);
const thisWeek = () => { const m = mondayL(new Date()); const e = new Date(m); e.setDate(e.getDate() + 6); return [ymdL(m), ymdL(e)]; };
const AI_FIELDS = [{ key: 'status', get: (r) => r.status, label: (v) => AI_STATUS_TEXT[v] || v }];
const PHASE_LABEL = { ...Object.fromEntries([...INTERVIEW_LIFECYCLE, ...INTERVIEW_EXCEPTIONS]), SHORTLISTED: 'Shortlisted' };
const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN'];
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
    case 'week': { const [a, b] = thisWeek(); const ld = localDay(r.interviewAt); return !!ld && ld >= a && ld <= b && !['CANCELLED', 'NO_SHOW'].includes(r.status); }
    case 'moved': return open && ['RESCHEDULED', 'NO_SHOW'].includes(r.status);
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

// hideZero (non-admins): a view with nothing in it is not drawn — except the
// one that is selected and All.
function ViewBar({
  view, setView, counts, labels, hideZero = false, also = [], base = BAR_IDS,
}) {
  // The four daily chips, an extra one only while it holds something (AI
  // "Expired"), and the open view when it is not one of them (All / Cancelled).
  const ids = [...base, ...also.filter((id) => counts[id] > 0)];
  if (!ids.includes(view)) ids.push(view);
  return (
    <div className="ivcal-views" role="tablist" aria-label="Interview views">
      {ids.filter((id) => !hideZero || id === view || counts[id] > 0).map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={view === id}
          className={'ivcal-view' + (view === id ? ' active' : '')}
          title={view === id && id !== 'all' ? 'Click again to see all' : undefined}
          onClick={() => setView(view === id && id !== 'all' ? 'all' : id)}
        >
          {labels[id]}{counts[id] > 0 && <> <span className="ivcal-count">{counts[id].toLocaleString('en-IN')}</span></>}
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
  const aiView = (v) => (AI_VIEW_IDS.includes(v) ? v : 'upcoming');
  const [views, setViews] = useState({ recruitment: qsView || 'upcoming', ai: aiView(qsView) });
  useEffect(() => {
    if (qsView) setViews({ recruitment: qsView, ai: aiView(qsView) });
  }, [qsView]);
  const view = views[tab];
  const setView = (v) => setViews((prev) => ({ ...prev, [tab]: v }));
  const [data, setData] = useState({ recruitment: [], ai: [], filterOptions: {} });
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState(null); // { kind, row, ...fields }
  const [openCand, setOpenCand] = useState(null); // { candidateId, applicationId }
  const showCand = (r) => setOpenCand({ candidateId: r.candidate.id, applicationId: r.id });
  // ?schedule=1 (the BDE dashboard's "Schedule Interview") opens the dialog.
  const [scheduling, setScheduling] = useState(() => searchParams.get('schedule') === '1' && canActOnPipeline(user));

  const canAct = canActOnPipeline(user);
  // May this login take the Selected / On hold / Rejected decision right in
  // the feedback form? (The server checks it again.)
  const canDecide = can(user, 'ats', 'interviews', 'Interview Feedback', 'approve');
  // The page filters bar (Department · Date range · Client · Recruiter / BDE),
  // kept in the URL. A chart bar opens its own list: `drill`.
  const [pf, setPf] = usePageFilters();
  const [drill, setDrill] = useState(null); // { label, test(row) }
  const setFilter = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const atsRole = (user && ((user.scopeRoles && user.scopeRoles.ats && user.scopeRoles.ats !== 'NONE' && user.scopeRoles.ats) || productRole(user, 'ats'))) || '';
  const isRecruiter = atsRole === 'RECRUITER';
  // "My Interviews" — a recruiter's default; anyone else starts on their scope.
  const qsMine = searchParams.get('mine');
  const [mine, setMine] = useState(qsMine === '1' ? true : qsMine === '0' ? false : isRecruiter);
  const [hier, setHier] = useState(EMPTY_HIERARCHY);
  const hierTree = useHierarchy();
  const [loaded, setLoaded] = useState(false);
  const isAdmin = !!user && (ADMIN_ROLES.includes(user.role) || ADMIN_ROLES.includes(user.atsRole));
  const [sort, setSort] = useState('');
  const [aiQ, setAiQ] = useState('');
  const [aiStatus, setAiStatus] = useState('');
  const [aiSort, setAiSort] = useState('');
  // List (default) or Calendar — a toggle on the toolbar, not another row.
  const [layout, setLayout] = useState(() => {
    try { return localStorage.getItem('ivcal.layout') === 'calendar' ? 'calendar' : 'list'; } catch { return 'list'; }
  });
  const pickLayout = (v) => { setLayout(v); try { localStorage.setItem('ivcal.layout', v); } catch { /* private mode */ } };
  // v4: the main calendar's size (Day / Week / Month, remembered), the day it
  // shows, its quick filter and the interview open in the details card.
  const [calMode, setCalModeS] = useState(() => {
    try { const v = localStorage.getItem('ivcal.v4.mode'); return ['day', 'week', 'month'].includes(v) ? v : 'week'; } catch { return 'week'; }
  });
  const setCalMode = (v) => { setCalModeS(v); try { localStorage.setItem('ivcal.v4.mode', v); } catch { /* private mode */ } };
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [quick, setQuick] = useState('');
  const [selId, setSelId] = useState(null);
  // Automatic reminders — the Admin switch (OFF until an Admin turns it on).
  const [reminders, setReminders] = useState(null);
  useEffect(() => {
    if (!isAdmin) return;
    api.get('/ats/interview-reminders').then((r) => setReminders(r.data)).catch(() => setReminders(null));
  }, [isAdmin]);
  const flipReminders = () => act(
    async () => { const r = await api.put('/ats/interview-reminders', { enabled: !reminders.enabled }); setReminders(r.data); },
    reminders && reminders.enabled ? 'Candidate emails are off. Messages are still saved on Communications. In-app notices still go.' : 'Candidate emails are on. Step messages, interview messages and offer letters now go out.',
  );

  function serverParams() {
    const params = {};
    const hp = toParams(hier, hierTree.data);
    ['tl', 'recruiter', 'positionCode'].forEach((k) => { if (hp[k]) params[k] = hp[k]; });
    if (mine && user && user.id) { params.recruiter = `id:${user.id}`; delete params.positionCode; }
    return params;
  }
  const personKey = JSON.stringify(serverParams());
  function load() {
    api.get('/ats/calendar', { params: serverParams() })
      .then((res) => { setData(res.data); setError(''); })
      .catch(() => setError('Could not load interviews. Please try again.'))
      .finally(() => setLoaded(true));
  }
  useEffect(load, [personKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const deptFilter = pf.department;

  // The shared list layout (spec 2026-10-03 §B): every filter sits in the
  // Filters panel, its options counted in the browser (the calendar holds its
  // list whole). The non-option filters (search, date range, lifecycle step)
  // come first; calPred() is the ONE match rule for the option filters, used
  // both for the table and for the counts.
  const facetValues = useMemo(() => ({
    type: filters.type,
    status: filters.status,
    department: pf.department,
    clientId: pf.clientId,
    recruiterId: pf.recruiterId,
    bdeId: pf.bdeId,
    requirement: filters.requirement,
    candidate: filters.candidate,
    hiringType: filters.hiringType,
  }), [filters, deptFilter]);
  const pr = calRange(pf);
  const passesBase = (r, skipPhase) => {
    const q = filters.q.trim().toLowerCase();
    if (!skipPhase && filters.phase && filters.phase !== 'SHORTLISTED' && phaseOf(r) !== filters.phase) return false;
    if (filters.date && (!r.interviewAt || new Date(r.interviewAt).toISOString().slice(0, 10) !== filters.date)) return false;
    if (pr.from || pr.to) {
      if (!r.interviewAt) return false;
      const d = localDay(r.interviewAt);
      if (pr.from && d < pr.from) return false;
      if (pr.to && d > pr.to) return false;
    }
    if (q && !`${r.candidate.name} ${r.requirement.title} ${r.interviewCode}`.toLowerCase().includes(q)) return false;
    return true;
  };
  const passesFacets = (r) => Object.keys(facetValues).every((k) => !facetValues[k] || calPred(r, k, facetValues[k]));

  // Filters first, then the view — so each view button can show how many of
  // the FILTERED interviews it holds.
  const filtered = useMemo(
    () => (data.recruitment || []).filter((r) => passesBase(r) && passesFacets(r)),
    [data.recruitment, filters, facetValues, pr.from, pr.to], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // The options are counted over the interviews of the view on screen, so
  // "Orbit Software (12)" is the 12 rows picking it shows.
  const facetRows = useMemo(
    () => (data.recruitment || []).filter((r) => passesBase(r) && clientInView(views.recruitment, r)),
    [data.recruitment, filters, views.recruitment, pr.from, pr.to], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const facets = useLocalFacets(facetRows, CAL_FIELDS, facetValues, calPred);
  // Page-bar options: every interview in your area that passes the other
  // filters (any view), so they cascade and carry counts.
  const pfRows = useMemo(
    () => (data.recruitment || []).filter((r) => passesBase(r)),
    [data.recruitment, filters, pr.from, pr.to], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const pfFacets = useLocalFacets(pfRows, PF_FIELDS, facetValues, calPred);
  // v4: the filter bar's Job / Interview type / Status, counted over every
  // interview in your area (any view) — the same rows the calendar draws.
  // The AI interviews have their own tab — no "opens the AI tab" type option.
  const barFacets = useLocalFacets(pfRows, CAL_FIELDS, facetValues, calPred);
  const barTypeOptions = useMemo(() => (barFacets.type || []).filter((o) => o.value !== 'AI Interview'), [barFacets.type]);
  const pfOptions = useMemo(() => ({
    department: pfFacets.department || [],
    clientId: pfFacets.clientId || [],
    people: [
      ...(pfFacets.recruiterId || []).map((o) => ({ ...o, value: `rec:${o.value}`, group: 'Recruiters' })),
      ...(pfFacets.bdeId || []).map((o) => ({ ...o, value: `bde:${o.value}`, group: 'Client managers (BDE)' })),
    ],
  }), [pfFacets]);
  // §17 — the lifecycle counts, over every filter except the step itself.
  const shortlisted = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    return (data.shortlisted || []).filter((r) => {
      if (pf.clientId && r.requirement.client?.id !== pf.clientId) return false;
      if (deptFilter && r.requirement.department !== deptFilter) return false;
      if (filters.requirement && r.requirement.title !== filters.requirement) return false;
      if (filters.candidate && r.candidate.name !== filters.candidate) return false;
      if (filters.hiringType && r.hiringType !== filters.hiringType) return false;
      if (q && !`${r.candidate.name} ${r.requirement.title}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data.shortlisted, filters, deptFilter, pf.clientId]);
  const phaseCounts = useMemo(() => {
    const out = { SHORTLISTED: shortlisted.length };
    (data.recruitment || []).forEach((r) => {
      // Same filters as the table, minus the step filter itself.
      if (!passesBase(r, true) || !passesFacets(r)) return;
      const p = phaseOf(r);
      out[p] = (out[p] || 0) + 1;
    });
    return out;
  }, [data.recruitment, filters, shortlisted, facetValues]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const setType = (row, interviewType) => act(
    () => api.patch(`/ats/interviews/${row.id}/type`, { interviewType }),
    `${row.candidate.name} — interview type set to ${interviewType}.`,
  );

  const clientCounts = useMemo(() => Object.fromEntries(
    VIEW_IDS.map((id) => [id, filtered.filter((r) => clientInView(id, r)).length]),
  ), [filtered]);
  const rows = useMemo(() => {
    const list = filtered.filter((r) => clientInView(views.recruitment, r) && (!drill || drill.test(r)));
    if (sort === 'candidate') return [...list].sort((a, b) => String(a.candidate.name).localeCompare(String(b.candidate.name)));
    if (sort === 'client') return [...list].sort((a, b) => String(a.requirement.client?.name || 'TeamLink').localeCompare(String(b.requirement.client?.name || 'TeamLink')));
    if (sort === 'round') return [...list].sort((a, b) => (b.round || 1) - (a.round || 1));
    // Default: Upcoming / Today read soonest first; everything else newest first.
    const asc = sort ? sort === 'soonest' : ['upcoming', 'today', 'week'].includes(views.recruitment);
    return [...list].sort((a, b) => {
      const x = a.interviewAt ? new Date(a.interviewAt).getTime() : 0;
      const y = b.interviewAt ? new Date(b.interviewAt).getTime() : 0;
      return asc ? x - y : y - x;
    });
  }, [filtered, views.recruitment, sort, drill]);

  // --- v3 CARDS: Today · This week · Feedback pending · Rescheduled / did not attend
  const cards = useMemo(() => {
    const c = { today: 0, week: 0, feedback: 0, moved: 0, late: 0 };
    filtered.forEach((r) => {
      ['today', 'week', 'feedback', 'moved'].forEach((id) => { if (clientInView(id, r)) c[id] += 1; });
      if (clientInView('feedback', r) && isLateFeedback(r)) c.late += 1;
    });
    return c;
  }, [filtered]);
  const openList = (v, d = null) => {
    setTab('recruitment');
    setViews((prev) => ({ ...prev, recruitment: v }));
    setDrill(d);
    setQuick('');
    if (d) setFilter({ phase: '' });
    pickLayout('list');
    setTimeout(() => {
      const el = document.getElementById('ivv3-list');
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 30);
  };

  // --- v3 CHARTS (max 3; two here) --------------------------------------------
  // 1. Interviews per week: 8 weeks (6 back, this one, next one), or the weeks
  //    of the chosen date range. Cancelled / did not attend are left out.
  const weekBars = useMemo(() => {
    const WEEK = 7 * 86400000;
    let start = mondayL(new Date(Date.now() - 6 * WEEK));
    let n = 8;
    if (pr.from && pr.to) {
      start = mondayL(new Date(`${pr.from}T00:00:00`));
      const end = mondayL(new Date(`${pr.to}T00:00:00`));
      n = Math.max(1, Math.min(12, Math.round((end - start) / WEEK) + 1));
      if (n === 12) start = new Date(end.getTime() - 11 * WEEK);
    }
    const live = filtered.filter((r) => r.interviewAt && !['CANCELLED', 'NO_SHOW'].includes(r.status));
    return Array.from({ length: n }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + 7 * i);
      const e = new Date(d);
      e.setDate(e.getDate() + 6);
      const a = ymdL(d);
      const b = ymdL(e);
      const inWeek = (r) => {
        const ld = localDay(r.interviewAt);
        return !!ld && ld >= a && ld <= b && !['CANCELLED', 'NO_SHOW'].includes(r.status);
      };
      const label = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      return { label, value: live.filter(inWeek).length, onClick: () => openList('all', { label: `Week of ${label}`, test: inWeek }) };
    });
  }, [filtered, pr.from, pr.to]); // eslint-disable-line react-hooks/exhaustive-deps
  // 2. Interview → selected, by client: of the interviews that happened (time
  //    passed, not cancelled / missed), how many ended Selected (or later).
  const ratioBars = useMemo(() => {
    const now = Date.now();
    const held = (r) => !!r.interviewAt && new Date(r.interviewAt).getTime() <= now && !['CANCELLED', 'NO_SHOW'].includes(r.status);
    const nameOf = (r) => r.requirement.client?.name || 'TeamLink (internal)';
    const by = new Map();
    filtered.forEach((r) => {
      if (!held(r)) return;
      const g = by.get(nameOf(r)) || { held: 0, sel: 0 };
      g.held += 1;
      if (decisionOf(r) === 'Selected') g.sel += 1;
      by.set(nameOf(r), g);
    });
    return [...by.entries()]
      .sort((a, b) => b[1].held - a[1].held || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([name, g]) => ({
        label: `${name} (${g.sel} of ${g.held})`,
        value: Math.round((g.sel / g.held) * 100),
        onClick: () => openList('all', { label: `${name}: interviews held`, test: (r) => nameOf(r) === name && held(r) }),
      }));
  }, [filtered]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- v3 CALENDAR COLOURS: one fixed colour per department (the kit's
  // categorical slots, most interviews first; past six, grey "Other").
  const deptColour = useMemo(() => {
    const n = new Map();
    (data.recruitment || []).forEach((r) => { const d = r.requirement.department || ''; n.set(d, (n.get(d) || 0) + 1); });
    const order = [...n.entries()].filter(([d]) => d).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([d]) => d);
    return new Map(order.map((d, i) => [d, slotVar(i, d)]));
  }, [data.recruitment]);
  const colorOf = (r) => deptColour.get(r.requirement.department || '') || 'var(--tlk-other)';
  const calRows = useMemo(() => (drill ? filtered.filter(drill.test) : filtered), [filtered, drill]);
  const legend = useMemo(() => {
    const seen = new Map();
    calRows.forEach((r) => { const d = r.requirement.department || 'No department'; if (!seen.has(d)) seen.set(d, colorOf(r)); });
    return [...seen.entries()].map(([name, color]) => ({ name, color }));
  }, [calRows, deptColour]); // eslint-disable-line react-hooks/exhaustive-deps

  // FEEDBACK (v3): Selected / Next round / On hold / Rejected + comment.
  // Next round books Round + 1 in the Schedule popup. Selected / On hold /
  // Rejected also take the decision when this login may (the shared reject
  // fields ride along for Rejected); the server checks the permission again.
  async function saveFeedback(row, body, rej) {
    setError(''); setNotice('');
    try {
      await api.post(`/ats/interviews/${row.id}/feedback`, body);
    } catch (err) {
      setError(err.response?.data?.error || 'That could not be saved. Please try again.');
      return false;
    }
    const first = String(row.candidate.name || '').replace(/^ZZTEST\S*\s*/i, '').split(/\s+/)[0] || 'The candidate';
    let msg = `Saved. Feedback for ${row.candidate.name} is in.`;
    if (body.nextRound) {
      const next = (Number(row.round) || 1) + 1;
      msg = `Saved. ${first} goes to round ${next}. Pick the time.`;
      setScheduling({ preset: { id: row.id, candidate: row.candidate, job: row.requirement.title, client: row.requirement.client?.name || 'TeamLink', round: next } });
    } else if (canDecide && (body.result !== 'Rejected' || rej)) {
      const dec = body.result === 'Rejected'
        ? {
          decision: 'Rejected',
          rejectedBy: rej.rejectedBy,
          rejectKind: rej.rejectKind,
          reasonCategory: rej.reasonCategory,
          reasonDetail: rej.reasonDetail,
          ...(rej.rejectedBy === 'Client' && String(rej.clientSaid || '').trim() ? { comment: rej.clientSaid.trim() } : {}),
        }
        : { decision: body.result, comment: body.comment, reasonDetail: body.comment };
      try {
        await api.post(`/ats/interviews/${row.id}/decision`, dec);
        msg = body.result === 'Selected' ? `Saved. ${first} is selected. Next: the offer.`
          : body.result === 'Hold' ? `Saved. ${first} is on hold.` : `Saved. ${first} is rejected for this job.`;
      } catch (err) {
        msg = `Feedback saved. The decision was not saved: ${err.response?.data?.error || 'try again on the Feedback tab.'}`;
      }
    }
    setNotice(msg);
    load();
    return true;
  }
  const bookNext = (row) => setScheduling({
    preset: { id: row.id, candidate: row.candidate, job: row.requirement.title, client: row.requirement.client?.name || 'TeamLink', round: (Number(row.round) || 1) + 1 },
  });
  // 25 / 50 / 100 rows per page (list standard §21) — the table was rendering
  // every interview in scope at once.
  const ivPage = usePaged(rows);
  const clearAll = () => { setFilters(EMPTY_FILTERS); setHier(EMPTY_HIERARCHY); setDrill(null); };
  const chips = [
    drill && { key: 'drill', label: 'From the chart', value: drill.label, onRemove: () => setDrill(null) },
    ...hierarchyChips({ ...hier, department: '' }, hierTree.data, setHier),
    { key: 'phase', label: 'Step', value: filters.phase ? (PHASE_LABEL[filters.phase] || filters.phase) : '', onRemove: () => setPhase('') },
    { key: 'status', label: 'Status', value: filters.status ? interviewStatusLabel(filters.status) : '', onRemove: () => setFilter({ status: '' }) },
    { key: 'type', label: 'Type', value: filters.type, onRemove: () => setFilter({ type: '' }) },
    { key: 'req', label: 'Job', value: filters.requirement, onRemove: () => setFilter({ requirement: '' }) },
    { key: 'cand', label: 'Candidate', value: filters.candidate, onRemove: () => setFilter({ candidate: '' }) },
    { key: 'ht', label: 'Hiring type', value: filters.hiringType, onRemove: () => setFilter({ hiringType: '' }) },
    { key: 'date', label: 'Date', value: filters.date ? fmtDate(filters.date) : '', onRemove: () => setFilter({ date: '' }) },
  ].filter((c) => c && c.value);

  // AI interviews: their own search, status and order — never pooled with the list above.
  const aiSearched = useMemo(() => {
    const q = aiQ.trim().toLowerCase();
    return (data.ai || []).filter((r) => !q || `${r.candidate.name} ${r.requirement.title} ${r.aiCode}`.toLowerCase().includes(q));
  }, [data.ai, aiQ]);
  const aiFiltered = useMemo(() => aiSearched.filter((r) => !aiStatus || r.status === aiStatus), [aiSearched, aiStatus]);
  const aiFacetRows = useMemo(() => aiSearched.filter((r) => aiInView(views.ai, r)), [aiSearched, views.ai]);
  const aiValues = useMemo(() => ({ status: aiStatus }), [aiStatus]);
  const aiFacets = useLocalFacets(aiFacetRows, AI_FIELDS, aiValues);
  const aiCounts = useMemo(() => Object.fromEntries(
    VIEW_IDS.map((id) => [id, aiFiltered.filter((r) => aiInView(id, r)).length]),
  ), [aiFiltered]);
  const aiRows = useMemo(() => {
    const list = aiFiltered.filter((r) => aiInView(views.ai, r));
    if (aiSort === 'deadline') {
      const t = (r) => (r.deadline ? new Date(r.deadline).getTime() : Infinity);
      return [...list].sort((a, b) => t(a) - t(b));
    }
    if (aiSort === 'candidate') return [...list].sort((a, b) => String(a.candidate.name).localeCompare(String(b.candidate.name)));
    return list;
  }, [aiFiltered, views.ai, aiSort]);

  // Every action funnels through here so one failure path handles them all.
  async function actOk(fn, msg) {
    setError(''); setNotice('');
    try { await fn(); setNotice(msg); load(); return true; } catch (err) { setError(err.response?.data?.error || 'That could not be saved. Please try again.'); return false; }
  }
  async function act(fn, successMessage) {
    setError(''); setNotice('');
    try {
      await fn();
      setDialog(null);
      if (successMessage) setNotice(successMessage);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save that change. Please try again.');
    }
  }

  const advance = (row, to) => act(
    () => api.patch(`/ats/interviews/${row.id}/advance`, { to }),
    to === 'CONFIRMED' ? 'Saved. Interview confirmed.'
      : to === 'STARTED' ? 'Saved. Interview started.'
        : to === 'COMPLETED' ? `Saved. ${row.candidate.name}'s interview is done — add feedback.`
          : `Saved. Interview ${interviewStatusLabel(to).toLowerCase()}.`,
  );

  // --- v4 LAYOUT (2026-10-08, the reference): header → 5 KPI tiles → filter
  // bar → mini month + quick filters | Day / Week / Month grid | interview
  // details → Today's interviews | Quick actions | Upcoming → charts → the
  // full list (Client & team / AI) → reminder switches. Every number below is
  // counted from the rows GET /ats/calendar returned (the same `filtered`
  // rows the list uses), nothing else.
  const range = viewRange(calMode, anchor);
  const gridRows = useMemo(
    () => (quick ? calRows.filter((r) => clientInView(quick, r)) : calRows),
    [calRows, quick],
  );
  const dayCounts = useMemo(() => {
    const m = new Map();
    groupByDay(gridRows).forEach((list, k) => m.set(k, list.length));
    return m;
  }, [gridRows]);
  const nowMs = Date.now();
  const autoRow = useMemo(() => {
    const a = range.from.getTime();
    const b = range.to.getTime() + DAY_MS;
    const timed = gridRows.filter((r) => r.interviewAt).sort((x, y) => new Date(x.interviewAt) - new Date(y.interviewAt));
    const inRange = timed.filter((r) => { const t = new Date(r.interviewAt).getTime(); return t >= a && t < b; });
    return inRange.find((r) => new Date(r.interviewAt).getTime() >= nowMs)
      || inRange[0]
      || timed.find((r) => new Date(r.interviewAt).getTime() >= nowMs)
      || null;
  }, [gridRows, calMode, anchor]); // eslint-disable-line react-hooks/exhaustive-deps
  const picked = selId ? (data.recruitment || []).find((r) => r.id === selId) || null : null;
  const shownRow = picked || autoRow;
  const focusRow = (r) => {
    setSelId(r.id);
    if (r.interviewAt) setAnchor(startOfDay(new Date(r.interviewAt)));
  };
  const openDay = (d) => { setAnchor(startOfDay(d)); setCalMode('day'); };

  const kpi = useMemo(() => {
    const now = new Date();
    const ms = new Date(now.getFullYear(), now.getMonth(), 1);
    const me = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const ps = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const [wa, wb] = thisWeek();
    const out = { upWeek: 0, doneM: 0, doneP: 0, cxl: 0, moved: 0 };
    filtered.forEach((r) => {
      const ld = localDay(r.interviewAt);
      if (clientInView('upcoming', r) && ld && ld >= wa && ld <= wb) out.upWeek += 1;
      if (r.interviewAt && DONE_STATUSES.includes(r.status)) {
        const t = new Date(r.interviewAt);
        if (t >= ms && t < me) out.doneM += 1;
        else if (t >= ps && t < ms) out.doneP += 1;
      }
      if (['CANCELLED', 'NO_SHOW'].includes(r.status)) out.cxl += 1;
      if (r.status === 'RESCHEDULED') out.moved += 1;
    });
    return out;
  }, [filtered]);
  const inThisWeek = (r) => { const [a, b] = thisWeek(); const ld = localDay(r.interviewAt); return !!ld && ld >= a && ld <= b; };
  const inThisMonth = (r) => {
    if (!r.interviewAt) return false;
    const t = new Date(r.interviewAt);
    const n = new Date();
    return t.getFullYear() === n.getFullYear() && t.getMonth() === n.getMonth();
  };

  const todayRows = useMemo(
    () => filtered.filter((r) => clientInView('today', r)).sort((a, b) => new Date(a.interviewAt) - new Date(b.interviewAt)),
    [filtered],
  );
  const nextRows = useMemo(
    () => filtered
      .filter((r) => clientInView('upcoming', r) && r.interviewAt && new Date(r.interviewAt).getTime() >= Date.now())
      .sort((a, b) => new Date(a.interviewAt) - new Date(b.interviewAt))
      .slice(0, 5),
    [filtered],
  );
  const pickQuick = (id) => {
    const next = quick === id ? '' : id;
    setQuick(next);
    setDrill(null);
    setViews((prev) => ({ ...prev, recruitment: next || 'all' }));
  };
  const quickActions = [
    canAct && { key: 'book', icon: 'plus', label: 'Book interview', sub: 'Pick a candidate, time and panel', onClick: () => setScheduling(true), tone: 'blue' },
    canRaiseRequirement(user) && { key: 'job', icon: 'briefcase', label: 'Post a job', sub: 'Create a new requirement', to: '/requirements?new=1', tone: 'blue' },
    can(user, 'ats', 'candidates', 'Add Candidate', 'create') && { key: 'cand', icon: 'user', label: 'Add candidate', sub: 'Add a candidate by hand', to: '/candidates?add=1', tone: 'violet' },
    can(user, 'ats', 'requirements', 'Requirement List', 'view') && { key: 'jobs', icon: 'list', label: 'View all jobs', sub: 'Every requirement in your area', to: '/requirements', tone: 'green' },
    can(user, 'ats', 'candidates', 'Candidate List', 'view') && { key: 'cands', icon: 'users', label: 'View candidates', sub: 'Search and filter candidates', to: '/candidates', tone: 'amber' },
    can(user, 'ats', 'interviews', 'Interview Feedback', 'view') && { key: 'fb', icon: 'chat', label: 'Interview feedback', sub: 'Decide after the interview', to: '/ats/interview-feedback', tone: 'red' },
  ].filter(Boolean).slice(0, 5);

  return (
    <div className="ivcal-page iv4">
      {/* HEADER — title, the calendar's date range, Day / Week / Month, Book. */}
      <div className="ak-page-head iv4-head">
        <div>
          <h1>Interview Calendar</h1>
          <p>Every interview: who, when, and what is left to do after it.</p>
        </div>
        <div className="ak-page-tools">
          <span className="iv4-range" title="The days the calendar shows">
            <Icon name="calendar" size={16} />
            <span>{fmtDay(range.from, true)}</span>
            <span aria-hidden="true">→</span>
            <span>{fmtDay(range.to, true)}</span>
          </span>
          <div className="iv4-seg" role="tablist" aria-label="Calendar size">
            {[['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={calMode === id} className={calMode === id ? 'is-on' : ''} onClick={() => setCalMode(id)}>{label}</button>
            ))}
          </div>
          {/* The page's primary action ("Book interview") is only shown to a
              login that may schedule (`canAct`, the same matrix answer the API
              enforces) — absent, not greyed out (§3). */}
          {canAct && (
            <button type="button" className="btn btn-primary iv4-book" onClick={() => setScheduling(true)}>
              <Icon name="plus" size={16} /> Book interview
            </button>
          )}
        </div>
      </div>
      {scheduling && (
        <ScheduleInterview
          preset={scheduling && scheduling.preset ? scheduling.preset : null}
          onClose={() => setScheduling(false)}
          onBooked={() => load()}
          onScheduled={(msg) => { setScheduling(false); setError(''); setNotice(msg || 'Interview booked.'); load(); }}
        />
      )}

      {error && <div className="error-text">{error}</div>}
      {notice && <div className="card section iv4-notice" role="status">{notice}</div>}

      {/* KPI ROW — five tiles, each opens its list below. */}
      <KpiRow className="iv4-kpis">
        <KpiTile
          icon="calendar" tone="blue" label="Today's interviews" value={cards.today} loading={!loaded}
          sub={cards.today > 0 ? 'Click to see the list' : (cards.week > 0 ? 'None today — see this week' : 'None today')}
          title="Interviews booked for today"
          onClick={() => openList(cards.today > 0 || !(cards.week > 0) ? 'today' : 'week')}
        />
        <KpiTile
          icon="clock" tone="green" label="Upcoming (this week)" value={kpi.upWeek} loading={!loaded}
          sub={`${cards.week.toLocaleString('en-IN')} in all this week (Mon–Sun)`}
          title="Booked interviews still to happen this week (Monday to Sunday)"
          onClick={() => openList('upcoming', { label: 'Upcoming this week', test: inThisWeek })}
        />
        <KpiTile
          icon="check" tone="teal" label="Completed (this month)" value={kpi.doneM} loading={!loaded}
          delta={pctChange(kpi.doneM, kpi.doneP)} deltaLabel="vs last month"
          sub={kpi.doneP ? undefined : 'Interviews held this month'}
          title="Interviews this month that are done (completed, feedback pending or feedback in)"
          onClick={() => openList('all', { label: 'Completed this month', test: (r) => DONE_STATUSES.includes(r.status) && inThisMonth(r) })}
        />
        <KpiTile
          icon="x" tone="red" label="Cancelled / Rescheduled" value={kpi.cxl + kpi.moved} loading={!loaded}
          sub={`${kpi.cxl.toLocaleString('en-IN')} cancelled / no-show · ${kpi.moved.toLocaleString('en-IN')} moved`}
          title="Cancelled, did not attend, or moved to a new time — none of them rejects the candidate"
          onClick={() => openList('all', { label: 'Cancelled / rescheduled', test: (r) => ['CANCELLED', 'NO_SHOW', 'RESCHEDULED'].includes(r.status) })}
        />
        <KpiTile
          icon="chat" tone="violet" label="Pending feedback" value={cards.feedback} loading={!loaded}
          sub={cards.late > 0 ? `${cards.late.toLocaleString('en-IN')} late (more than a day)` : (cards.feedback ? 'Interview done, feedback not in' : 'All feedback is in')}
          title="The interview is done, but nobody has written what the client said yet"
          onClick={() => openList('feedback')}
        />
      </KpiRow>

      {/* FILTER BAR — Department · Client · Job · Interview type · Status ·
          Date range · Recruiter / BDE · Search (the page's existing filters). */}
      <div className="iv4-filters" role="search">
        <PageFilterBar
          className="iv4-pfb iv4-pfb-a"
          value={pf}
          onChange={(v) => { setPf(v); setDrill(null); }}
          options={pfOptions}
          show={{ department: true, dateRange: false, client: true, people: false }}
        />
        <FacetSelect label="Job / Requirement" value={filters.requirement} onChange={(v) => setFilter({ requirement: v })} options={barFacets.requirement} allLabel="All jobs" />
        <FacetSelect label="Interview type" value={filters.type} onChange={pickType} options={barTypeOptions} allLabel="All types" />
        <FacetSelect label="Status" value={filters.status} onChange={(v) => setFilter({ status: v })} options={barFacets.status} allLabel="All statuses" />
        <PageFilterBar
          className="iv4-pfb iv4-pfb-b"
          value={pf}
          onChange={(v) => { setPf(v); setDrill(null); }}
          options={pfOptions}
          show={{ department: false, dateRange: true, client: false, people: true }}
        />
        <label className="iv4-search">
          <Icon name="search" size={16} />
          <input
            type="search"
            value={filters.q}
            onChange={(e) => setFilter({ q: e.target.value })}
            placeholder="Search name, job or interview ID…"
            aria-label="Search interviews"
          />
        </label>
      </div>

      {/* MAIN — mini month + quick filters | the calendar | interview details. */}
      <div className="iv4-main">
        <aside className="ak-panel iv4-left" aria-label="Month and quick filters">
          <MiniMonth anchor={anchor} from={range.from} to={range.to} counts={dayCounts} onPick={(d) => setAnchor(startOfDay(d))} />
          <div className="iv4-qf">
            <h4>Quick filters</h4>
            <ul>
              {QUICK.map(([id, label, tone]) => (
                <li key={id}>
                  <button type="button" className={quick === id ? 'is-on' : ''} aria-pressed={quick === id} onClick={() => pickQuick(id)}>
                    <i className={`iv4-dot ak-f-${tone}`} aria-hidden="true" />
                    <span>{label}</span>
                    <b>{loaded ? (clientCounts[id] || 0).toLocaleString('en-IN') : '…'}</b>
                  </button>
                </li>
              ))}
              {quick && (
                <li><button type="button" className="iv4-qf-all" onClick={() => pickQuick(quick)}><span>Show all</span><b>{filtered.length.toLocaleString('en-IN')}</b></button></li>
              )}
            </ul>
          </div>
        </aside>
        <WeekGrid
          rows={gridRows}
          mode={calMode}
          anchor={anchor}
          loaded={loaded}
          onStep={(dir) => setAnchor(stepAnchor(calMode, anchor, dir))}
          onToday={() => setAnchor(startOfDay(new Date()))}
          onPickDay={openDay}
          onMore={(d) => {
            const k = ymdL(d);
            openList('all', { label: `Interviews on ${fmtDate(d)}`, test: (r) => localDay(r.interviewAt) === k });
          }}
          selectedId={shownRow ? shownRow.id : null}
          onSelect={(r) => setSelId(r.id)}
        />
        <DetailsCard
          row={shownRow}
          auto={!picked && !!shownRow}
          loaded={loaded}
          onClear={() => setSelId(null)}
          onOpenCandidate={showCand}
          onFull={(r) => setDialog({ kind: 'detail', row: r })}
          actions={shownRow && canAct ? <div className="iv4-det-acts"><Actions row={shownRow} advance={advance} setDialog={setDialog} onNextRound={bookNext} /></div> : null}
        />
      </div>

      {/* BELOW — Today's interviews | Quick actions | Upcoming (next 5). */}
      <div className="iv4-row3">
        <AkPanel
          title={`Today's interviews (${todayRows.length.toLocaleString('en-IN')})`}
          action={todayRows.length > 6 ? { label: 'View all', onClick: () => openList('today') } : null}
          flush
          className="iv4-today"
        >
          {todayRows.length === 0 ? (
            <div className="ak-empty">{loaded ? (cards.week > 0 ? 'No interviews today — see Upcoming.' : 'No interviews today.') : 'Loading…'}</div>
          ) : (
            <table className="ak-table">
              <thead><tr><th>Time</th><th>Candidate</th><th>Job / ID</th><th>Client</th><th>Status</th><th aria-label="Open" /></tr></thead>
              <tbody>
                {todayRows.slice(0, 6).map((r) => (
                  <tr key={r.id} className="ak-row-click" onClick={() => focusRow(r)}>
                    <td className="iv4-nowrap">{fmtTime(r.interviewAt)}</td>
                    <td className="iv4-trunc" title={r.candidate.name}>{r.candidate.name}</td>
                    <td className="iv4-trunc" title={`${r.requirement.title} · ${r.interviewCode}`}>{r.interviewCode}</td>
                    <td className="iv4-trunc" title={r.requirement.client?.name || 'TeamLink (internal)'}>{r.requirement.client?.name || 'TeamLink (internal)'}</td>
                    <td><Pill tone={statusTone(r)}>{r.statusLabel}</Pill></td>
                    <td className="iv4-go" aria-hidden="true">→</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </AkPanel>
        <AkPanel title="Quick actions" className="iv4-quick">
          {quickActions.length ? <QuickActions items={quickActions} /> : <div className="ak-empty">No actions for this login.</div>}
        </AkPanel>
        <AkPanel
          title="Upcoming interviews (next 5)"
          action={clientCounts.upcoming > 5 ? { label: 'View all', onClick: () => openList('upcoming') } : null}
          className="iv4-next"
        >
          {nextRows.length === 0 ? (
            <div className="ak-empty">{loaded ? 'No interviews coming up.' : 'Loading…'}</div>
          ) : (
            <ul className="iv4-nextlist">
              {nextRows.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => focusRow(r)}>
                    <span className="iv4-next-when">{`${fmtDay(new Date(r.interviewAt))}, ${fmtTime(r.interviewAt)}`}</span>
                    <span className="iv4-next-who">
                      <b title={r.candidate.name}>{r.candidate.name}</b>
                      <span title={r.requirement.title}>{`${r.requirement.title} · ${r.interviewCode}`}</span>
                    </span>
                    <Pill tone={statusTone(r)}>{r.statusLabel}</Pill>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </AkPanel>
      </div>

      {/* CHARTS — interviews per week; interview → selected, by client. */}
      {loaded && (
        <div className="iv4-charts">
          <AkPanel title="Interviews per week" sub="Click a bar to see that week's interviews." icon="chart">
            <BarChart title="Interviews per week" data={weekBars} height={180} empty="No interviews in these weeks" />
          </AkPanel>
          <AkPanel title="Interview → selected, by client" sub="Of the interviews that happened, how many were selected." icon="trend" iconTone="green">
            <BarChart title="Interview to selected ratio by client" data={ratioBars} horizontal valueFormat={(v) => `${v}%`} empty="No interviews have happened yet" />
          </AkPanel>
        </div>
      )}

      {/* THE FULL LIST — Client & team interviews / AI interviews, kept apart:
          an AI interview score is never mixed into recruitment / client
          interview feedback. Import / Export / history sit on this card. */}
      <div id="ivv3-list" />
      <section className="ak-panel iv4-listcard" aria-label="All interviews">
        <header className="iv4-list-head">
          <h3>All interviews</h3>
          {/* Import / Export buttons: template · import (interview schedules on
              existing applications — the import never sends an invitation) ·
              export of this tab as filtered. */}
          <div className="iv4-list-tools">
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
          </div>
        </header>
        <StatusTabs
          label="Interview kind"
          tabs={[
            { key: 'recruitment', label: 'Client & team interviews', count: (data.recruitment || []).length },
            { key: 'ai', label: 'AI interviews', count: (data.ai || []).length },
          ]}
          value={tab}
          onChange={setTab}
          hideZero={!isAdmin}
          extra={(
            <label className="ivcal-mine" title={mine ? 'Showing interviews on your own candidates' : (atsRole === 'TL' ? 'Showing your team' : 'Showing everything in your area')}>
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
              Only my interviews
            </label>
          )}
        />

        <div className="tab-content">
          {tab === 'recruitment' ? (
            <>
              {layout === 'list' && <ViewBar view={views.recruitment} setView={(v) => { setDrill(null); setQuick(''); setView(v); }} counts={clientCounts} labels={CLIENT_VIEW_LABELS} hideZero={!isAdmin} base={['upcoming', 'completed', 'all']} />}

              <ListToolbar
                filterCount={chips.length}
                sort={sort}
                sortOptions={[['', 'Best order for this view'], ['soonest', 'Time: soonest first'], ['latest', 'Time: latest first'], ['candidate', 'Candidate A–Z'], ['client', 'Client A–Z'], ['round', 'Round: highest first']]}
                onSort={setSort}
                right={(
                  <div className="ivx-seg" role="tablist" aria-label="List or calendar">
                    <button type="button" role="tab" aria-selected={layout === 'list'} className={layout === 'list' ? 'is-on' : ''} onClick={() => pickLayout('list')}>List</button>
                    <button type="button" role="tab" aria-selected={layout === 'calendar'} className={layout === 'calendar' ? 'is-on' : ''} onClick={() => pickLayout('calendar')} title="Calendar coloured by department">Calendar</button>
                  </div>
                )}
                chips={[...chips, filters.q && { key: 'q', label: 'Search', value: filters.q, onRemove: () => setFilter({ q: '' }) }].filter(Boolean)}
                onClearAll={clearAll}
                panel={(
                  <>
                    <PanelField label="Step">
                      <select value={filters.phase || ''} onChange={(e) => setPhase(e.target.value)}>
                        <option value="">Any step</option>
                        {[...INTERVIEW_LIFECYCLE, ...INTERVIEW_EXCEPTIONS].filter(([id]) => (phaseCounts[id] || 0) > 0 || filters.phase === id).map(([id]) => (
                          <option key={id} value={id}>{`${PHASE_LABEL[id]} (${(phaseCounts[id] || 0).toLocaleString('en-IN')})`}</option>
                        ))}
                      </select>
                    </PanelField>
                    {/* Department, client, job, type, status, dates, recruiter / BDE and search are on the bar above. */}
                    <HierarchyFilter value={{ ...hier, department: pf.department }} onChange={(v) => { setHier({ ...v, department: '' }); if (v.tl) setMine(false); }} show={{ department: false, recruiter: false }} />
                    <FacetSelect label="Candidate" value={filters.candidate} onChange={(v) => setFilter({ candidate: v })} options={facets.candidate} allLabel="All candidates" />
                    <FacetSelect label="Hiring type" value={filters.hiringType} onChange={(v) => setFilter({ hiringType: v })} options={facets.hiringType} allLabel="All hiring types" />
                  </>
                )}
              />

              {layout === 'calendar' && filters.phase !== 'SHORTLISTED' ? (
                <div className="tlk"><InterviewCalendarGrid rows={calRows} colorOf={colorOf} legend={legend} onOpen={(r) => setDialog({ kind: 'detail', row: r })} /></div>
              ) : filters.phase === 'SHORTLISTED' ? (
                <div className="tbl-wrap">
                  <table>
                    <thead>
                      <tr><th>Candidate</th><th>Job</th><th>Client</th><th>Hiring</th><th>Shortlisted</th><th>Next</th></tr>
                    </thead>
                    <tbody>
                      {shortlisted.map((r) => (
                        <tr key={r.id}>
                          <td className="row-link"><a href={`/candidates/${r.candidate.id}`} onClick={(e) => { e.preventDefault(); showCand(r); }}>{r.candidate.name}</a></td>
                          <td className="row-link"><Link to={`/requirements/${r.requirement.id}`}>{r.requirement.title}</Link></td>
                          <td className="small-muted">{r.requirement.client?.name || '—'}</td>
                          <td><HiringTypeChip value={r.hiringType} /></td>
                          <td className="small-muted">{fmtDate(r.shortlistedAt)}</td>
                          <td>
                            {canAct
                              ? (
                                <button
                                  type="button"
                                  className="btn btn-sm btn-primary"
                                  onClick={() => setScheduling({ preset: { id: r.id, candidate: r.candidate, job: r.requirement.title, client: r.requirement.client?.name || '' } })}
                                >
                                  Book interview
                                </button>
                              )
                              : <span className="small-muted">Waiting for a booking</span>}
                          </td>
                        </tr>
                      ))}
                      {shortlisted.length === 0 && (
                        <tr><td colSpan="6" style={{ padding: 0 }}><EmptyState compact icon="✅" title="Nobody shortlisted is waiting for an interview." hint="Shortlisted people show here until you book an interview." /></td></tr>
                      )}
                    </tbody>
                  </table>
                  <ListFooter from={shortlisted.length ? 1 : 0} to={shortlisted.length} total={shortlisted.length} noun="people waiting for an interview" />
                </div>
              ) : (
              <div className="tbl-wrap">
                <table>
                  <thead>
                    <tr>
                      <SortTh label="Time" k="soonest" alt="latest" sort={sort} setSort={setSort} />
                      <SortTh label="Candidate" k="candidate" sort={sort} setSort={setSort} />
                      <SortTh label="Client" k="client" sort={sort} setSort={setSort} />
                      <SortTh label="Round" k="round" sort={sort} setSort={setSort} />
                      <th>Mode</th><th>Status</th><th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ivPage.slice.map((r) => (
                      <tr key={r.id}>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <b>{r.interviewAt ? fmtTime(r.interviewAt) : '—'}</b>
                          <div className="ivv3-sub2">{r.interviewAt ? fmtDate(r.interviewAt) : 'No time yet'}</div>
                          {r.rescheduleCount > 0 && <div className="ivv3-sub2" title="Times rescheduled">{`Moved ${r.rescheduleCount}×`}</div>}
                        </td>
                        {/* The job and the interview ID: small grey text under the name. */}
                        <td className="row-link">
                          <a href={`/candidates/${r.candidate.id}`} onClick={(e) => { e.preventDefault(); showCand(r); }}>{r.candidate.name}</a>
                          <div className="ivv3-sub2" title={r.requirement.title}>
                            <Link to={`/requirements/${r.requirement.id}`}>{r.requirement.title}</Link>
                            {` · ${r.interviewCode}`}
                          </div>
                        </td>
                        <td>
                          {r.requirement.client?.name || 'TeamLink (internal)'}
                          {r.requirement.department && <div className="ivv3-sub2">{r.requirement.department}</div>}
                        </td>
                        <td><span className="ivv3-round">{`Round ${r.round || 1}`}</span></td>
                        <td>
                          {r.mode === 'In Person' ? 'Offline (in person)' : (r.mode || '—')}
                          {r.meetingLink
                            ? <div className="ivv3-sub2"><a href={r.meetingLink} target="_blank" rel="noreferrer" title={r.meetingLink}>Open link</a></div>
                            : r.location && <div className="ivv3-sub2" title={r.location}>{r.location}</div>}
                          {(r.panel && r.panel.length ? r.panel.map((p) => p.name).join(', ') : r.interviewer) && <div className="ivv3-sub2" title={r.panel && r.panel.length > 1 ? 'Interview panel' : 'Interviewer'}>{`With ${r.panel && r.panel.length ? r.panel.map((p) => p.name).join(', ') : r.interviewer}`}</div>}
                        </td>
                        <td>
                          <StatusChip status={r.statusLabel} tone={{ RESCHEDULED: 'yellow', FEEDBACK_SUBMITTED: 'green', NO_SHOW: 'red', CANCELLED: 'grey' }[r.status]} />
                          {isLateFeedback(r) ? <> <StatusChip status="Feedback late" tone="red" /></> : slotOverdue(r) && <> <StatusChip status="Waiting for feedback" tone="yellow" /></>}
                          {r.cancelReason && <div className="ivv3-sub2" title={r.cancelReason}>{r.cancelReason}</div>}
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {!canAct ? <span className="small-muted">—</span> : <Actions row={r} advance={advance} setDialog={setDialog} onNextRound={bookNext} />}
                        </td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr><td colSpan="7" style={{ padding: 0 }}>
                        <EmptyState
                          compact
                          icon="📅"
                          title={loaded ? (drill ? 'No interviews in this part of the chart.' : CLIENT_EMPTY[views.recruitment] || 'No interviews yet.') : 'Loading interviews…'}
                          hint={loaded ? (mine ? "Untick 'Only my interviews' to see your team's." : 'Try Upcoming, or clear the filters.') : undefined}
                        />
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              )}
              {layout === 'list' && filters.phase !== 'SHORTLISTED' && rows.length > 0 && (
                <ListFooter from={ivPage.from} to={ivPage.to} total={rows.length} noun="interviews">
                  <Pager page={ivPage} noun="interviews" />
                </ListFooter>
              )}
            </>
          ) : (
            <>
              <ViewBar view={views.ai} setView={setView} counts={aiCounts} labels={AI_VIEW_LABELS} hideZero={!isAdmin} also={['cancelled']} />
              <ListToolbar
                search={aiQ}
                onSearch={setAiQ}
                placeholder="Search name, job or AI interview ID…"
                filterCount={aiStatus ? 1 : 0}
                sort={aiSort}
                sortOptions={[['', 'Default order'], ['deadline', 'Due soonest'], ['candidate', 'Name A–Z']]}
                onSort={setAiSort}
                chips={[
                  aiStatus && { key: 'aistatus', label: 'Status', value: AI_STATUS_TEXT[aiStatus] || aiStatus, onRemove: () => setAiStatus('') },
                  aiQ && { key: 'q', label: 'Search', value: aiQ, onRemove: () => setAiQ('') },
                ].filter(Boolean)}
                onClearAll={() => { setAiStatus(''); setAiQ(''); }}
                panel={<FacetSelect label="Status" value={aiStatus} onChange={setAiStatus} options={aiFacets.status} allLabel="All statuses" />}
              />
              <AiTab rows={aiRows} canAct={canAct} act={act} emptyLabel={AI_EMPTY[views.ai]} mine={mine} onOpen={showCand} />
            </>
          )}
        </div>
      </section>

      {dialog?.kind === 'reschedule' && <RescheduleForm dialog={dialog} setDialog={setDialog} act={act} error={error} />}
      {dialog?.kind === 'cancel' && <CancelForm dialog={dialog} setDialog={setDialog} act={act} error={error} />}
      {dialog?.kind === 'feedback' && (
        <ShortFeedbackForm
          row={dialog.row}
          existing={dialog.row.internalFeedback}
          allowNoShow={!['FEEDBACK_SUBMITTED', 'CANCELLED', 'NO_SHOW'].includes(dialog.row.status)}
          allowNextRound={!DECIDED_STAGES.includes(dialog.row.stage)}
          rejectForm={canDecide}
          onClose={() => setDialog(null)}
          onSubmit={(body, rej) => saveFeedback(dialog.row, body, rej)}
          onNoShow={(body) => actOk(
            () => api.post(`/ats/interviews/${dialog.row.id}/no-show`, body),
            body.rescheduleAt ? 'Saved. Did not attend. New time booked, everyone told.' : 'Saved. Did not attend. Book a new time when ready.',
          )}
        />
      )}
      {dialog?.kind === 'history' && <HistoryPanel dialog={dialog} setDialog={setDialog} />}
      {dialog?.kind === 'detail' && <DetailPanel row={dialog.row} user={user} canAct={canAct} advance={advance} setDialog={setDialog} onChanged={(fresh) => { setDialog({ kind: 'detail', row: { ...dialog.row, ...fresh } }); load(); }} onNextRound={(r) => { setDialog(null); bookNext(r); }} onOpen={(r) => { setDialog(null); showCand(r); }} />}
      {openCand && (
        <CandidateDrawer
          candidateId={openCand.candidateId}
          applicationId={openCand.applicationId}
          user={user}
          onClose={() => setOpenCand(null)}
          onChanged={load}
        />
      )}

      {isAdmin && reminders && (
        <div className="ivx-admin">
          <span title="One switch for every email to candidates: Rejected, Selected, offer letters, interview booking / changes / reminders. Also interview emails to staff and clients.">
            Candidate emails:{' '}
            <b>{reminders.enabled ? 'On' : 'Off'}</b>
            {' · In-app notices always go'}
            {reminders.lastRunAt ? ` · last sent ${new Date(reminders.lastRunAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}
          </span>
          {reminders.canEdit && (
            <button type="button" className="btn btn-sm" onClick={flipReminders}>{reminders.enabled ? 'Turn off' : 'Turn on'}</button>
          )}
        </div>
      )}
      {isAdmin && reminders && reminders.staff && (
        <div className="ivx-admin">
          <span title="Bell reminders inside TeamLink for the interviewers (panel), the recruiter, the team lead and the client manager (BDE). Separate from Candidate emails.">
            {'Staff reminders (app bell): '}
            <b>{reminders.staff.enabled ? 'On' : 'Off'}</b>
            {reminders.staff.enabled ? ` — ${[reminders.staff.dayBefore ? '1 day before' : null, reminders.staff.hourBefore ? '1 hour before' : null].filter(Boolean).join(' and ') || 'no times picked'}` : ''}
            {' · Candidate reminders: '}
            <b>{reminders.enabled ? 'On' : 'Off'}</b>
            {reminders.enabled ? '' : ' (they follow Candidate emails, which is off — the candidate gets nothing)'}
          </span>
          {reminders.canEdit && (
            <button type="button" className="btn btn-sm" onClick={() => act(async () => { const r = await api.put('/ats/interview-staff-reminders', { enabled: !reminders.staff.enabled }); setReminders({ ...reminders, staff: r.data.staff }); }, reminders.staff.enabled ? 'Staff reminders are off.' : 'Staff reminders are on: a bell 1 day and 1 hour before each interview.')}>
              {reminders.staff.enabled ? 'Turn off' : 'Turn on'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// The prototype's ivActionsHtml(): what you can do depends entirely on where the
// interview currently is.
function Actions({
  row, advance, setDialog, onNextRound = null,
}) {
  const st = row.status;
  const next = INTERVIEW_NEXT[st];
  const nextLabel = next === 'CONFIRMED' ? 'Confirm' : next === 'STARTED' ? 'Start' : 'Complete';
  // The slot has passed: the one next thing is the feedback (where "Did not
  // attend" also lives — there is no No Show button on the row).
  const passed = !!row.interviewAt && new Date(row.interviewAt).getTime() < Date.now()
    && ['SCHEDULED', 'CONFIRMED', 'STARTED', 'RESCHEDULED'].includes(st) && !DECIDED_STAGES.includes(row.stage);
  if (passed) {
    return (
      <>
        <button className="btn btn-sm btn-primary" onClick={() => setDialog({ kind: 'feedback', row })}>Add feedback</button>{' '}
        <button className="btn btn-sm" onClick={() => setDialog({ kind: 'reschedule', row })}>Reschedule</button>
      </>
    );
  }

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
        {/* The decision is taken on the Feedback tab of this same screen. */}
        {decide && <><Link className="btn btn-sm btn-primary" to="/ats/interview-feedback">Decide</Link>{' '}</>}
        {decide && onNextRound && <><button type="button" className="btn btn-sm" onClick={() => onNextRound(row)}>{`Book round ${(Number(row.round) || 1) + 1}`}</button>{' '}</>}
        <button className={'btn btn-sm' + (decide ? '' : ' btn-primary')} onClick={() => setDialog({ kind: 'feedback', row })}>
          {['COMPLETED', 'FEEDBACK_SUBMITTED'].includes(st) ? 'Edit feedback' : 'Add feedback'}
        </button>{' '}
        <button className="btn btn-sm btn-ghost" onClick={() => setDialog({ kind: 'history', row })}>History</button>
      </>
    );
  }
  return (
    <>
      {next && <><button className="btn btn-sm btn-primary" onClick={() => advance(row, next)}>{nextLabel}</button>{' '}</>}
      <button className="btn btn-sm" onClick={() => setDialog({ kind: 'reschedule', row })}>Reschedule</button>{' '}
      <button className="btn btn-sm btn-ghost" onClick={() => setDialog({ kind: 'cancel', row })}>Cancel interview</button>
    </>
  );
}

// One feedback record — the internal panel's, or the client's. Recommendation
// plus who wrote it; the panel's optional 0–100 score is labelled as the
// PANEL score so it can never be read as an AI score.
function FeedbackCell({ fb, score }) {
  if (!fb) return <span className="small-muted">Not in yet</span>;
  return (
    <div>
      <StatusChip status={fb.recommendation} />
      {score != null && <div className="small-muted" style={{ fontSize: 11 }}>Panel score {score}/100</div>}
      {fb.submittedBy && <div className="small-muted" style={{ fontSize: 11 }}>by {fb.submittedBy}</div>}
    </div>
  );
}

// Reschedule / Cancel / History / one interview open as a window over the
// list (the app's Modal), not as a card below the table. A failed save shows
// its error inside the window, where the person is looking.
function Panel({ title, subtitle, children, onClose, error = '' }) {
  return (
    <Modal title={title} onClose={onClose}>
      {subtitle && <div className="ivx-hint" style={{ marginTop: 0, marginBottom: 12 }}>{subtitle}</div>}
      {error && <div className="error-text">{error}</div>}
      {children}
    </Modal>
  );
}

function RescheduleForm({ dialog, setDialog, act, error }) {
  const { row } = dialog;
  const [when, setWhen] = useState('');
  const [reason, setReason] = useState('');
  return (
    <Panel
      title={`Reschedule — ${row.candidate.name}`}
      subtitle={`Now ${fmtDate(row.interviewAt)} ${fmtTime(row.interviewAt)} · ${row.statusLabel}`}
      onClose={() => setDialog(null)}
      error={error}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          act(() => api.post(`/ats/interviews/${row.id}/reschedule`, { interviewAt: when, reason }), `Saved. Moved to ${fmtDate(when)} ${fmtTime(when)}.`);
        }}
      >
        <div className="grid-2">
          <label className="field"><span>New date &amp; time *</span>
            <input required type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
          <label className="field"><span>Reason *</span>
            <input required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is it moving?" /></label>
        </div>
        <button className="btn btn-primary btn-sm" type="submit">Reschedule</button>
      </form>
    </Panel>
  );
}

function CancelForm({ dialog, setDialog, act, error }) {
  const { row } = dialog;
  const [reason, setReason] = useState('');
  return (
    <Panel title={`Cancel interview — ${row.candidate.name}`} onClose={() => setDialog(null)} error={error}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          act(() => api.post(`/ats/interviews/${row.id}/cancel`, { reason }), 'Saved. Interview cancelled. The person stays at their step.');
        }}
      >
        <label className="field" style={{ marginBottom: 10 }}><span>Why? *</span>
          <textarea required rows="2" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <button className="btn btn-primary btn-sm" type="submit">Cancel interview</button>
      </form>
    </Panel>
  );
}

// An interview, opened from the calendar: when, where, who — and the same
// buttons the list row has.
function DetailPanel({
  row, canAct, advance, setDialog, onOpen, onNextRound = null, user = null, onChanged = null,
}) {
  const link = row.meetingLink;
  const [editPanel, setEditPanel] = useState(null);
  const [panelErr, setPanelErr] = useState('');
  const live = ['SCHEDULED', 'CONFIRMED', 'STARTED', 'RESCHEDULED'].includes(row.status);
  async function savePanel() {
    setPanelErr('');
    try {
      const r = await api.put(`/ats/interviews/${row.id}/panel`, { panel: editPanel.map((p) => (p.userId ? { userId: p.userId } : { name: p.name, email: p.email || null })) });
      setEditPanel(null);
      if (onChanged) onChanged(r.data);
    } catch (e) { setPanelErr(e.response?.data?.error || 'Could not save the panel. Please try again.'); }
  }
  return (
    <Panel title={row.candidate.name} subtitle={[row.requirement.title, row.requirement.client?.name, row.interviewCode, hireText(row.hiringType)].filter(Boolean).join(' · ')} onClose={() => setDialog(null)}>
      <div className="grid-2" style={{ marginBottom: 10 }}>
        <div><div className="small-muted">When</div><b>{fmtDate(row.interviewAt)} · {fmtTime(row.interviewAt)}</b></div>
        <div><div className="small-muted">Status</div><StatusChip status={row.statusLabel} />{isLateFeedback(row) && <> <StatusChip status="Feedback late" tone="red" /></>}</div>
        <div><div className="small-muted">Where</div>{link ? <a href={link} target="_blank" rel="noreferrer">{row.mode || 'Online'} — open link</a> : <span>{[row.mode, row.location].filter(Boolean).join(' — ') || '—'}</span>}</div>
        <div><div className="small-muted">{(row.panel || []).length > 1 ? 'Panel' : 'Interviewer'}</div><span>{(row.panel || []).length ? row.panel.map((p) => p.name).join(', ') : (row.interviewer || '—')}</span></div>
        <div><div className="small-muted">Round</div><span className="ivv3-round">{`Round ${row.round || 1}`}</span></div>
        <div><div className="small-muted">Department</div><span>{row.requirement.department || '—'}</span></div>
      </div>
      {canAct && live && !link && String(row.mode || 'Online') !== 'In Person' && (
        <div style={{ marginBottom: 10 }}><MeetingLinkButton applicationId={row.id} onMade={onChanged} /></div>
      )}
      <div style={{ marginBottom: 10 }}>
        <div className="small-muted" style={{ marginBottom: 4 }}>{`Round ${row.round || 1} — each person's feedback`}</div>
        {editPanel ? (
          <div>
            <PanelPicker value={editPanel} onChange={setEditPanel} />
            {panelErr && <div className="error-text">{panelErr}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button type="button" className="btn btn-sm btn-primary" disabled={!editPanel.length} onClick={savePanel}>Save panel</button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditPanel(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <>
            <PanelView row={row} user={user} canAct={canAct} onChanged={onChanged} onLegacyFeedback={() => setDialog({ kind: 'feedback', row })} />
            {canAct && !['CANCELLED', 'NO_SHOW'].includes(row.status) && (
              <button type="button" className="btn btn-sm btn-ghost" style={{ marginTop: 6 }} onClick={() => setEditPanel((row.panel || []).filter((p) => !p.legacy).map((p) => (p.userId ? { userId: p.userId, name: p.name } : { name: p.name, email: p.email })))}>
                {(row.panel || []).some((p) => !p.legacy) ? 'Change panel' : 'Add interviewers (panel)'}
              </button>
            )}
          </>
        )}
      </div>
      <div className="ivx-actions">
        {canAct && <Actions row={row} advance={advance} setDialog={setDialog} onNextRound={onNextRound} />}
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onOpen(row)}>Open candidate</button>
      </div>
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
          <b>{String(h.status).startsWith('REMINDER_') ? 'Reminder sent' : h.status === 'NO_SHOW' ? 'Did not attend' : interviewStatusLabel(h.status)}</b>
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
  if (r.status === 'Expired') return { text: 'Expired', tone: 'rejected' };
  if (r.status === 'Manual Review Requested') return { text: 'Check by recruiter', tone: 'pending' };
  if (r.status !== 'Completed' && !AI_OPEN_STAGES.includes(r.stage)) return { text: 'Skipped', tone: 'new' };
  if (r.status !== 'Completed') return { text: 'Waiting for candidate', tone: 'pending' };
  if (r.stage === 'AI_INTERVIEW_COMPLETED') return { text: 'Check by recruiter', tone: 'pending' };
  if (r.stage === 'REJECTED') return { text: 'Rejected', tone: 'rejected' };
  if (r.stage === 'HOLD') return { text: 'On hold', tone: 'pending' };
  return { text: `Moved on — ${stageLabel(r.stage)}`, tone: 'active' };
}

function AiTab({
  rows, canAct, act, emptyLabel, mine, onOpen,
}) {
  const page = usePaged(rows);
  return (
    <>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th><th>Candidate</th><th>Job</th><th>Score</th><th>Status</th>
              <th>Due by</th><th>Result</th><th>Summary</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {page.slice.map((r) => {
              const expired = r.status === 'Expired';
              const outcome = aiOutcome(r);
              return (
                <tr key={r.id}>
                  <td><b>{r.aiCode}</b></td>
                  <td className="row-link"><a href={`/candidates/${r.candidate.id}`} onClick={(e) => { e.preventDefault(); onOpen(r); }}>{r.candidate.name}</a></td>
                  <td className="small-muted">{r.requirement.title}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {/* "AI Interview · Score 82% · Completed 27 Sep" — its own
                        line, never beside the client interview status. */}
                    {r.status === 'Completed'
                      ? <b>{['Score', r.score != null ? `${r.score}%` : '—'].join(' ')}{` · Completed${r.completedAt ? ` ${shortDay(r.completedAt)}` : ''}`}</b>
                      : <span className="small-muted">{r.score != null ? `Score ${r.score}%` : 'No score yet'}</span>}
                  </td>
                  <td><StatusChip status={AI_STATUS_TEXT[r.status] || r.status} tone={AI_TONE[r.status]} /></td>
                  <td className="small-muted">{r.deadline ? fmtDate(r.deadline) : '—'}</td>
                  <td><StatusChip status={outcome.text} tone={{ rejected: 'red', pending: 'amber', active: 'green', new: 'blue' }[outcome.tone]} /></td>
                  <td className="small-muted">
                    {r.feedback || (r.score != null ? 'See summary on the profile.' : '—')}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {!canAct ? <span className="small-muted">—</span> : (
                      <>
                        {r.stage === 'AI_INTERVIEW_COMPLETED' && (
                          <><button type="button" className="btn btn-sm btn-primary" onClick={() => onOpen(r)}>Check now</button>{' '}</>
                        )}
                        {expired && (
                          <>
                            <button className="btn btn-sm btn-primary" onClick={() => act(() => api.post(`/ats/ai-interviews/${r.id}/extend`, {}), 'Saved. More time given.')}>Give more time</button>{' '}
                          </>
                        )}
                        {r.status !== 'Completed' && AI_OPEN_STAGES.includes(r.stage) && (
                          <><button className="btn btn-sm" onClick={() => act(() => api.post(`/ats/ai-interviews/${r.id}/resend`), 'Invite sent again.')}>Resend</button>{' '}</>
                        )}
                        {expired && (
                          <button className="btn btn-sm" onClick={() => act(() => api.post(`/ats/ai-interviews/${r.id}/manual-review`), 'Saved. A recruiter will check this person.')}>Check by recruiter</button>
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
                  title={emptyLabel || 'No AI interviews yet.'}
                  hint={mine ? "Untick 'Only my interviews' to see your team's." : 'Try Upcoming, or clear the filters.'}
                />
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      {rows.length > 0 && (
        <ListFooter from={page.from} to={page.to} total={rows.length} noun="AI interviews">
          <Pager page={page} noun="AI interviews" />
        </ListFooter>
      )}
    </>
  );
}

// A sortable column heading (layout v3: every table sorts). k = the sort it
// sets; alt = the reverse, set by a second click.
function SortTh({
  label, k, alt = null, sort, setSort,
}) {
  const on = sort === k || (alt && sort === alt);
  const arrow = on ? (sort === alt ? ' ▼' : ' ▲') : '';
  return (
    <th aria-sort={on ? (sort === alt ? 'descending' : 'ascending') : 'none'}>
      <button type="button" className="ivv3-th" title={`Sort by ${label.toLowerCase()}`} onClick={() => setSort(sort === k && alt ? alt : k)}>{label}{arrow}</button>
    </th>
  );
}
