import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { stageLabel } from '../atsVocab';
import { isAdmin, isClientUser, canManageAccounts, workRoleLabel } from '../permissions';

// ---------------------------------------------------------------------------
// The prototype's viewMainDashboard() (line 2305) fans out to a dashboard per
// role — dashboardAdmin, dashboardEmployee, dashboardRecruiter, dashboardBDE,
// dashboardTL, dashboardAccountant, dashboardClient (lines 2316-2530). Tiles,
// their labels, their order, the two-column layout and the card headings below
// are all the prototype's; the numbers come from this app's real APIs.
// ---------------------------------------------------------------------------

// statusBadge(), prototype line ~2650 — the exact status-class map, keyed here
// by the stage codes this app stores.
const STAGE_BADGE = {
  NEW: 'new', AI_INTERVIEW_REQUIRED: 'new', AI_INTERVIEW_SCHEDULED: 'interview',
  AI_INTERVIEW_COMPLETED: 'interview', RECRUITER_REVIEW: 'review', RECRUITER_APPROVED: 'approved',
  WITH_BDE: 'review', BDE_APPROVED: 'approved', SHARED_WITH_CLIENT: 'review', CLIENT_REVIEW: 'review',
  CLIENT_SHORTLISTED: 'shortlist', INTERVIEW_SCHEDULED: 'interview', INTERVIEW_COMPLETED: 'interview',
  SELECTED: 'selected', OFFER: 'offer', OFFER_ACCEPTED: 'offer', JOINED: 'joined', HIRED: 'joined',
  REJECTED: 'rejected', HOLD: 'hold',
};
function StageBadge({ stage }) {
  return <span className={`status ${STAGE_BADGE[stage] || 'new'}`}>{stageLabel(stage)}</span>;
}

// actionNeeded(), prototype line 2386.
const ACTION_NEEDED = {
  RECRUITER_REVIEW: 'Approve / reject / hold',
  WITH_BDE: 'BDE review',
  SHARED_WITH_CLIENT: 'Awaiting client decision',
};

function Stat({ n, l }) {
  return <div className="statitem"><div className="n">{n}</div><div className="l">{l}</div></div>;
}

function PageHead({ name, role, extra }) {
  return (
    <div className="page-head">
      <div>
        <h1>Dashboard</h1>
        <div className="page-sub">
          Welcome back, {String(name || '').replace(/\(.*\)/, '').trim()} · {role}{extra || ''}
        </div>
      </div>
    </div>
  );
}

function priorityClass(p) {
  return p === 'High' || p === 'Urgent' ? 'rejected' : p === 'Medium' ? 'review' : 'applied';
}

function PipelineTable({ rows, cols = 4, empty = 'Nothing pending — all caught up.', withAction = false }) {
  const navigate = useNavigate();
  return (
    <div className="tbl-wrap">
      <table>
        <thead>
          <tr>
            <th>Candidate</th><th>Requirement</th><th>Stage</th>
            {withAction && <th>Action needed</th>}<th />
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr className="row-link" key={a.id} onClick={() => navigate(`/candidates/${a.candidateId}`)}>
              <td>{a.candidate?.name}</td>
              <td>{a.requirement?.title}</td>
              <td><StageBadge stage={a.stage} /></td>
              {withAction && <td className="small-muted">{ACTION_NEEDED[a.stage] || 'Review'}</td>}
              <td>
                <button
                  className="btn btn-sm"
                  onClick={(e) => { e.stopPropagation(); navigate(`/candidates/${a.candidateId}`); }}
                >
                  Open
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={cols + (withAction ? 1 : 0)} className="small-muted" style={{ padding: 16 }}>{empty}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function ActivityTimeline({ items }) {
  return (
    <div className="timeline">
      {items.map((a, i) => (
        <div className="timeline-item" key={i}>
          <div className="timeline-date">{new Date(a.date).toLocaleString()}</div>
          <div className="timeline-label">{a.user} — {a.action} ({a.entity})</div>
        </div>
      ))}
      {items.length === 0 && <div className="small-muted">No activity yet.</div>}
    </div>
  );
}

function rupees(n) { return '₹' + Number(n || 0).toLocaleString('en-IN'); }

// ---------------------------------------------------------------------------

export default function Dashboard() {
  const { user } = useAuth();
  // Which workspace someone lands on comes from their product access and their
  // ATS working role — never from a role they picked at sign-in.
  if (isClientUser(user)) return <ClientDashboard user={user} />;
  if (isAdmin(user)) return <AdminDashboard user={user} />;
  const atsRole = user?.atsRole;
  if (user?.products?.ats && atsRole === 'RECRUITER') return <RecruiterDashboard user={user} />;
  if (user?.products?.ats && atsRole === 'BDE') return <BdeDashboard user={user} />;
  if (user?.products?.ats && ['TL', 'STL', 'ASSISTANT_MANAGER', 'MANAGER'].includes(atsRole)) {
    return <TeamDashboard user={user} />;
  }
  if (user?.products?.accounts && canManageAccounts(user)) return <AccountantDashboard user={user} />;
  if (user?.products?.hrms) return <EmployeeDashboard user={user} />;
  return <AdminDashboard user={user} />;
}

// --- dashboardAdmin (prototype line 2316) ---------------------------------
function AdminDashboard({ user }) {
  const [stats, setStats] = useState(null);
  const [apps, setApps] = useState([]);
  const [reqs, setReqs] = useState([]);

  useEffect(() => {
    api.get('/dashboard').then((r) => setStats(r.data)).catch(() => setStats({}));
    api.get('/applications').then((r) => setApps(r.data)).catch(() => setApps([]));
    api.get('/requirements', { params: { status: 'OPEN' } }).then((r) => setReqs(r.data)).catch(() => setReqs([]));
  }, []);

  if (!stats) return <div className="small-muted">Loading dashboard…</div>;
  const pending = apps.filter((a) => ['RECRUITER_REVIEW', 'WITH_BDE', 'SHARED_WITH_CLIENT'].includes(a.stage)).slice(0, 6);

  return (
    <>
      <PageHead name={user?.name} role={workRoleLabel(user)} />
      <div className="statbar">
        <Stat n={stats.openRequirements} l="Open requirements" />
        <Stat n={stats.recruiterReview} l="Awaiting recruiter review" />
        <Stat n={stats.withBde} l="Awaiting BDE review" />
        <Stat n={stats.clientReview} l="With client" />
        <Stat n={stats.interviewsUpcoming} l="Interviews scheduled" />
        <Stat n={stats.invoicesOverdue} l="Overdue invoices" />
      </div>

      <div className="two-col">
        <div>
          <div className="card section">
            <h3 style={{ fontSize: 14, marginBottom: 10 }}>Pending actions</h3>
            <PipelineTable rows={pending} withAction />
          </div>
          <div className="card section">
            <h3 style={{ fontSize: 14, marginBottom: 10 }}>Recent activity</h3>
            <ActivityTimeline items={stats.recentActivity || []} />
          </div>
        </div>
        <div>
          <div className="card section">
            <h3 style={{ fontSize: 13, marginBottom: 10 }}>Requirement priority</h3>
            {reqs.slice(0, 5).map((r) => (
              <Link className="kv" to={`/requirements/${r.id}`} key={r.id} style={{ display: 'flex' }}>
                <span className="k">{r.title}</span>
                <span className={`status ${priorityClass(r.priority)}`}>{r.priority}</span>
              </Link>
            ))}
            {reqs.length === 0 && <div className="small-muted">No open requirements.</div>}
          </div>
          <div className="card">
            <h3 style={{ fontSize: 13, marginBottom: 10 }}>Job Portal Connection</h3>
            <div className="kv"><span className="k">Status</span><span><span className="conn-dot ok" />Connected</span></div>
            <div className="kv"><span className="k">Public site</span><span>/careers</span></div>
            <div className="kv"><span className="k">Open positions live</span><span>{stats.openRequirements}</span></div>
            <Link className="link-btn" to="/admin/integrations" style={{ display: 'block', marginTop: 8 }}>
              Manage integration →
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}

// --- dashboardRecruiter (prototype line 2432) ------------------------------
function RecruiterDashboard({ user }) {
  const [reqs, setReqs] = useState([]);
  const [apps, setApps] = useState([]);
  useEffect(() => {
    api.get('/requirements').then((r) => setReqs(r.data)).catch(() => setReqs([]));
    api.get('/applications').then((r) => setApps(r.data)).catch(() => setApps([]));
  }, []);

  const myReqs = reqs.filter((r) => r.recruiterId === user?.id);
  const myIds = new Set(myReqs.map((r) => r.id));
  const mine = apps.filter((a) => myIds.has(a.requirementId));
  const pendingAction = mine.filter((a) => ['NEW', 'RECRUITER_REVIEW', 'HOLD'].includes(a.stage));

  return (
    <>
      <PageHead name={user?.name} role="Recruiter" />
      <div className="statbar">
        <Stat n={myReqs.filter((r) => r.status === 'OPEN').length} l="My requirements" />
        <Stat n={pendingAction.length} l="Candidates to review" />
        <Stat n={mine.filter((a) => a.interviewStatus === 'SCHEDULED').length} l="Interviews" />
        <Stat n={mine.filter((a) => a.stage === 'SELECTED').length} l="Selected" />
        <Stat n={mine.filter((a) => ['JOINED', 'HIRED'].includes(a.stage)).length} l="Joined" />
      </div>
      <div className="card section">
        <h3 style={{ fontSize: 14, marginBottom: 10 }}>Candidates needing my review</h3>
        <PipelineTable rows={pendingAction.slice(0, 8)} />
      </div>
      <div className="card">
        <h3 style={{ fontSize: 13, marginBottom: 10 }}>My requirements</h3>
        {myReqs.map((r) => (
          <Link className="kv" to={`/requirements/${r.id}`} key={r.id} style={{ display: 'flex' }}>
            <span className="k">{r.title} — {r.client?.name}</span>
            <span className={`status ${priorityClass(r.priority)}`}>{r.priority}</span>
          </Link>
        ))}
        {myReqs.length === 0 && <div className="small-muted">No requirements assigned.</div>}
      </div>
    </>
  );
}

// --- dashboardBDE (prototype line 2459) ------------------------------------
function BdeDashboard({ user }) {
  const [reqs, setReqs] = useState([]);
  const [apps, setApps] = useState([]);
  useEffect(() => {
    api.get('/requirements').then((r) => setReqs(r.data)).catch(() => setReqs([]));
    api.get('/applications').then((r) => setApps(r.data)).catch(() => setApps([]));
  }, []);

  const myReqs = reqs.filter((r) => r.bdeId === user?.id);
  const myIds = new Set(myReqs.map((r) => r.id));
  const mine = apps.filter((a) => myIds.has(a.requirementId));
  const withBde = mine.filter((a) => a.stage === 'WITH_BDE');

  return (
    <>
      <PageHead name={user?.name} role="BDE" />
      <div className="statbar">
        <Stat n={myReqs.filter((r) => r.status === 'OPEN').length} l="Requirements" />
        <Stat n={withBde.length} l="Candidates with BDE" />
        <Stat n={mine.filter((a) => ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'].includes(a.stage)).length} l="Shared with client" />
        <Stat n={mine.filter((a) => ['CLIENT_SHORTLISTED', 'REJECTED'].includes(a.stage)).length} l="Client responses" />
      </div>
      <div className="card">
        <h3 style={{ fontSize: 14, marginBottom: 10 }}>Pending BDE review</h3>
        <PipelineTable rows={withBde.slice(0, 8)} empty="Nothing pending." />
      </div>
    </>
  );
}

// --- dashboardTL (prototype line 2483) -------------------------------------
function TeamDashboard({ user }) {
  const [stats, setStats] = useState(null);
  const [reqs, setReqs] = useState([]);
  const [apps, setApps] = useState([]);
  useEffect(() => {
    api.get('/dashboard').then((r) => setStats(r.data)).catch(() => setStats({}));
    api.get('/requirements', { params: { status: 'OPEN' } }).then((r) => setReqs(r.data)).catch(() => setReqs([]));
    api.get('/applications').then((r) => setApps(r.data)).catch(() => setApps([]));
  }, []);
  if (!stats) return <div className="small-muted">Loading dashboard…</div>;

  // /requirements is already department-scoped on the server for STL/TL, so
  // scoping the applications to those requirements scopes the whole screen.
  const ids = new Set(reqs.map((r) => r.id));
  const scoped = apps.filter((a) => ids.has(a.requirementId));
  const roleLabel = workRoleLabel(user);

  return (
    <>
      <PageHead name={user?.name} role={roleLabel} extra={user?.atsDepartment ? ` · ${user.atsDepartment} department` : ''} />
      {user?.atsDepartment && (
        <div className="notice">
          Scoped to your assigned department ({user.atsDepartment}) — requirements, candidates and interviews
          outside it are not shown here.
        </div>
      )}
      <div className="statbar">
        <Stat n={reqs.length} l="Team requirements" />
        <Stat n={new Set(scoped.map((a) => a.candidateId)).size} l="Team candidates" />
        <Stat n={scoped.filter((a) => ['RECRUITER_REVIEW', 'WITH_BDE'].includes(a.stage)).length} l="Pending approvals" />
        <Stat n={scoped.filter((a) => a.interviewStatus === 'SCHEDULED').length} l="Interviews" />
        <Stat n={scoped.filter((a) => ['SELECTED', 'JOINED', 'HIRED'].includes(a.stage)).length} l="Selections" />
      </div>
      <div className="card section">
        <h3 style={{ fontSize: 14, marginBottom: 10 }}>Recent team activity</h3>
        <ActivityTimeline items={stats.recentActivity || []} />
      </div>
      <div className="card">
        <h3 style={{ fontSize: 13, marginBottom: 10 }}>Recruiter workload</h3>
        {(stats.recruiterWorkload || []).map((r) => (
          <div className="kv" key={r.name}><span className="k">{r.name}</span><span>{r.requirements} open requirements</span></div>
        ))}
        {(stats.recruiterWorkload || []).length === 0 && <div className="small-muted">No recruiters on file.</div>}
      </div>
    </>
  );
}

// --- dashboardAccountant (prototype line 2503) -----------------------------
function AccountantDashboard({ user }) {
  const [stats, setStats] = useState(null);
  const [acc, setAcc] = useState(null);
  useEffect(() => {
    api.get('/dashboard').then((r) => setStats(r.data)).catch(() => setStats({}));
    api.get('/dashboard/accounts').then((r) => setAcc(r.data)).catch(() => setAcc({}));
  }, []);
  if (!stats || !acc) return <div className="small-muted">Loading dashboard…</div>;

  return (
    <>
      <PageHead name={user?.name} role="Accountant" />
      <div className="statbar">
        <Stat n={stats.hiringOutcomes} l="Client joinings recorded" />
        <Stat n={acc.invoices} l="Invoices" />
        <Stat n={acc.pending} l="Pending payments" />
        <Stat n={acc.overdue} l="Overdue" />
        <Stat n={acc.unreconciled} l="Unreconciled transactions" />
      </div>
      <div className="card section">
        <h3 style={{ fontSize: 14, marginBottom: 10 }}>Invoices needing attention</h3>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Invoice</th><th>Client</th><th>Amount</th><th>Status</th></tr></thead>
            <tbody>
              {(acc.needsAttention || []).map((i) => (
                <tr key={i.id}>
                  <td><Link to={`/invoices/${i.id}`}>{i.invoiceNumber || i.id}</Link></td>
                  <td>{i.client}</td>
                  <td>{rupees(i.total)}</td>
                  <td><span className={`status ${i.status === 'Overdue' ? 'rejected' : 'pending'}`}>{i.status}</span></td>
                </tr>
              ))}
              {(acc.needsAttention || []).length === 0 && (
                <tr><td colSpan="4" className="small-muted" style={{ padding: 14 }}>Nothing pending.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card">
        <h3 style={{ fontSize: 13, marginBottom: 10 }}>Unreconciled bank transactions</h3>
        {(acc.unreconciledTransactions || []).map((t) => (
          <div className="kv" key={t.id}><span className="k">{t.date} · {t.description}</span><span>{rupees(t.amount)}</span></div>
        ))}
        {(acc.unreconciledTransactions || []).length === 0 && <div className="small-muted">All caught up.</div>}
      </div>
    </>
  );
}

// --- dashboardClient (prototype line 2521) ---------------------------------
function ClientDashboard({ user }) {
  const [stats, setStats] = useState(null);
  const [apps, setApps] = useState([]);
  useEffect(() => {
    api.get('/dashboard').then((r) => setStats(r.data)).catch(() => setStats({}));
    api.get('/applications').then((r) => setApps(r.data)).catch(() => setApps([]));
  }, []);
  if (!stats) return <div className="small-muted">Loading dashboard…</div>;

  const mine = apps.filter((a) => a.requirement?.clientId === user?.clientId);
  const awaiting = mine.filter((a) => ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'].includes(a.stage));
  const stage = (code) => (stats.pipelineByStage || []).find((s) => s.stage === code)?.count || 0;

  return (
    <>
      <PageHead name={user?.name} role="Client" />
      <div className="statbar">
        <Stat n={stats.openRequirements} l="Open requirements" />
        <Stat n={stats.clientReview} l="Awaiting your review" />
        <Stat n={stage('CLIENT_SHORTLISTED')} l="Shortlisted" />
        <Stat n={stats.interviewsUpcoming} l="Interviews scheduled" />
        <Stat n={stage('SELECTED') + stage('JOINED')} l="Selected" />
      </div>
      <div className="card">
        <h3 style={{ fontSize: 14, marginBottom: 10 }}>Candidates awaiting your review</h3>
        <PipelineTable rows={awaiting.slice(0, 8)} empty="Nothing pending." />
      </div>
    </>
  );
}

// --- dashboardEmployee (prototype line 2393) -------------------------------
function EmployeeDashboard({ user }) {
  const [attendance, setAttendance] = useState([]);
  const [leave, setLeave] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [courses, setCourses] = useState([]);
  useEffect(() => {
    api.get('/attendance').then((r) => setAttendance(r.data)).catch(() => setAttendance([]));
    api.get('/leave').then((r) => setLeave(r.data)).catch(() => setLeave([]));
    api.get('/helpdesk').then((r) => setTickets(r.data)).catch(() => setTickets([]));
    api.get('/lms/assignments').then((r) => setCourses(r.data)).catch(() => setCourses([]));
  }, []);

  const today = new Date().toISOString().slice(0, 10);
  const todayRec = attendance.find((a) => a.date === today);

  return (
    <>
      <PageHead name={user?.name} role="Employee" />
      <div className="statbar">
        <Stat n={todayRec ? todayRec.status : 'Not marked'} l="Today's attendance" />
        <Stat n={leave.filter((l) => l.status === 'Pending').length} l="Leave pending" />
        <Stat n={tickets.filter((t) => t.status !== 'Resolved').length} l="Open service tickets" />
        <Stat n={courses.filter((c) => !c.completed).length} l="Courses to complete" />
      </div>
      <div className="two-col">
        <div>
          <div className="card section">
            <h3 style={{ fontSize: 14, marginBottom: 10 }}>My recent attendance</h3>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Date</th><th>Status</th></tr></thead>
                <tbody>
                  {attendance.slice(0, 5).map((a) => (
                    <tr key={a.id}>
                      <td>{a.date}</td>
                      <td>
                        <span className={`status ${a.status === 'Present' ? 'active' : a.status === 'Leave' ? 'hold' : 'review'}`}>
                          {a.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {attendance.length === 0 && (
                    <tr><td colSpan="2" className="small-muted" style={{ padding: 14 }}>No records yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <div className="card">
            <h3 style={{ fontSize: 14, marginBottom: 10 }}>My leave</h3>
            {leave.map((l) => (
              <div className="kv" key={l.id}>
                <span className="k">{l.leaveType || l.type} · {l.fromDate}–{l.toDate}</span>
                <span className={`status ${l.status === 'Approved' ? 'active' : l.status === 'Rejected' ? 'rejected' : 'pending'}`}>
                  {l.status}
                </span>
              </div>
            ))}
            {leave.length === 0 && <div className="small-muted">No leave on record.</div>}
          </div>
        </div>
        <div className="card section">
          <h3 style={{ fontSize: 13, marginBottom: 10 }}>My services</h3>
          <Link className="link-btn" to="/attendance" style={{ display: 'block', marginBottom: 8 }}>Attendance &amp; Time →</Link>
          <Link className="link-btn" to="/leave" style={{ display: 'block', marginBottom: 8 }}>Leave →</Link>
          <Link className="link-btn" to="/payroll" style={{ display: 'block', marginBottom: 8 }}>Payroll / Payslips →</Link>
          <Link className="link-btn" to="/employee-services" style={{ display: 'block', marginBottom: 8 }}>Employee Services →</Link>
          <Link className="link-btn" to="/employee-services" style={{ display: 'block' }}>My Learning (LMS) →</Link>
        </div>
      </div>
    </>
  );
}
