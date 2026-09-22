import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { stageLabel } from '../atsVocab';
import { can, canModule, isClientUser, workRoleLabel } from '../permissions';
import { REPORTS_ITEMS, visibleItems } from '../nav';

// ---------------------------------------------------------------------------
// THE OVERALL DASHBOARD (§18).
//
// One screen, assembled from one block per product the login actually holds:
//
//   HRMS       Employees | Attendance | Leave | Payroll
//   ATS        Requirements | Candidates | Interviews | Selected | Joined
//   Accounts   Invoices | Payments | Outstanding | Reconciliation
//   Reports    the report screens this login may open
//
// WHICH BLOCKS APPEAR IS THE PERMISSION ENGINE'S ANSWER, NOT A ROLE NAME.
// This screen used to switch on `user.atsRole` and render one of seven
// hand-written layouts, so the matrix and the dashboard could drift apart.
// Every block below is gated on canModule()/can() from ../permissions.js —
// the same matrix /auth/me sends and the API enforces — which is what makes
// §18's narrowing fall out of the matrix rather than out of a role name:
//
//   Super Admin / Admin   all three products, plus the report links
//   Manager               the same categories, scoped, and read-only because
//                         the screens behind the rows are read-only for them
//   STL                   their department; TL their own and their team's
//   Recruiter             their own ATS work
//   HR                    HRMS only            Accountant  Accounts only
//   Employee              their own HRMS records only
//   Client                their own client dashboard, and nothing else
//
// A login that does not hold a product cannot be shown that product's block,
// whatever their role is called.
//
// EVERY NUMBER COMES FROM AN ALREADY-SCOPED ENDPOINT — the same one the list
// behind the row reads. Nothing here is computed from a role, re-filtered in
// the browser, or estimated:
//
//   GET /api/employees            departmentWhere() — a TL's 7, a manager's
//                                 20, an admin's 27, and 403 for the rest
//   GET /api/attendance?date=…    employeeRecordWhere() — the team's day, or
//   GET /api/leave                only your own row if that is all you hold
//   GET /api/payroll?month=…      payslips, yours or your departments'
//   GET /api/helpdesk             your own service requests
//   GET /api/dashboard/ats        the ATS rows, queues and action list, scoped
//                                 by utils/scope.js per ATS role
//   GET /api/dashboard            Selected / Joined, from that same scope
//   GET /api/dashboard/accounts   invoices, received, outstanding, bank
//   GET /api/applications         a client's own shared candidates
//
// The company-wide GET /api/hrms/dashboard is deliberately NOT used here: it
// counts every employee in the company for anyone holding the HRMS Dashboard
// feature, which would print 27 employees on a TL's screen directly under a
// notice saying they are scoped to one department.
//
// AND IT IS ROWS, NOT A KPI WALL: compact "label · figure" rows that link into
// the list the figure was counted from, plus an action list where there is an
// action — the shape the ATS home already uses.
// ---------------------------------------------------------------------------

const STAGE_BADGE = {
  NEW: 'new', AI_INTERVIEW_REQUIRED: 'new', AI_INTERVIEW_SCHEDULED: 'interview',
  AI_INTERVIEW_COMPLETED: 'interview', RECRUITER_REVIEW: 'review', RECRUITER_APPROVED: 'approved',
  WITH_BDE: 'review', BDE_APPROVED: 'approved', SHARED_WITH_CLIENT: 'review', CLIENT_REVIEW: 'review',
  CLIENT_SHORTLISTED: 'shortlist', INTERVIEW_SCHEDULED: 'interview', INTERVIEW_COMPLETED: 'interview',
  SELECTED: 'selected', OFFER: 'offer', OFFER_ACCEPTED: 'offer', JOINED: 'joined', HIRED: 'joined',
  REJECTED: 'rejected', HOLD: 'hold',
};

function rupees(n) { return '₹' + Number(n || 0).toLocaleString('en-IN'); }

// One compact row: label left, figure right, the whole row a link into the
// list the figure was counted from.
function Row({ label, value, to, sub }) {
  const navigate = useNavigate();
  const blank = value === null || value === undefined;
  const zero = blank || value === 0 || value === '0';
  return (
    <div className="assign-row" data-goto="1" onClick={() => navigate(to)}>
      <span>
        {label}
        {sub && <span className="small-muted" style={{ marginLeft: 8 }}>{sub}</span>}
      </span>
      <span className={'row-count' + (zero ? ' row-zero' : '')}>{blank ? '—' : value}</span>
    </div>
  );
}

function Panel({ title, right, children }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>{title}</h3>
        {right ? <span className="small-muted">{right}</span> : null}
      </div>
      {children}
    </div>
  );
}

function PageHead({ user, extra }) {
  const name = String(user?.name || '').replace(/\(.*\)/, '').trim();
  return (
    <div className="page-head">
      <div>
        <h1>Dashboard</h1>
        <div className="page-sub">
          Welcome back, {name} · {workRoleLabel(user)}{extra || ''}
        </div>
      </div>
    </div>
  );
}

// The queue as an action list: one row per item, each carrying the single move
// that advances it. Straight from /api/dashboard/ats.
function ActionList({ rows, navigate }) {
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="tbl-wrap" style={{ border: 0, borderRadius: 0 }}>
      <table>
        <thead>
          <tr><th>Candidate</th><th>Requirement</th><th>Stage</th><th>Next action</th><th>Due</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="row-link" onClick={() => navigate(r.to)}>
              <td>{r.candidate}</td>
              <td>
                {r.requirement}
                {r.client && <div className="small-muted">{r.client}</div>}
              </td>
              <td><span className={`status ${STAGE_BADGE[r.stage] || 'new'}`}>{r.stageLabel}</span></td>
              <td><span className="link-btn">{r.nextAction} →</span></td>
              <td>
                {!r.due ? <span className="small-muted">—</span>
                  : r.overdue ? <span className="status overdue">Overdue</span>
                    : r.due === today ? <span className="status pending">Today</span>
                      : <span className="small-muted">{r.due}</span>}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan="5" className="small-muted" style={{ padding: 16 }}>
                Nothing is waiting on you — every item in your scope has moved on.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function Dashboard() {
  const { user } = useAuth();
  // A client is outside this company: their dashboard is their own company's
  // pipeline and nothing else — never an internal product block, even where
  // their login carries a product flag for the portal screens.
  if (isClientUser(user)) return <ClientDashboard user={user} />;
  return <ProductDashboard user={user} />;
}

function ProductDashboard({ user }) {
  const navigate = useNavigate();

  // --- what this login may be shown, straight from the matrix -------------
  const hasHrms = canModule(user, 'hrms');
  // Other people's records, or only your own? Employee Management is the line
  // §15 draws between a lead/HR view and an employee's own corner.
  const seesTeam = can(user, 'hrms', 'hrms', 'Employee Management', 'view');
  const seesAttendance = can(user, 'hrms', 'hrms', 'Attendance & Time', 'view');
  const seesLeave = can(user, 'hrms', 'hrms', 'Leave & Holidays', 'view');
  const seesPayroll = can(user, 'hrms', 'hrms', 'Payroll & Compensation', 'view');
  const seesServices = can(user, 'hrms', 'hrms', 'Employee Services', 'view');

  // There is no module called 'ats': the ATS is requirements + clients +
  // candidates + recruiterbde + interviews. Holding the product is not the
  // same as being given any of them, so both are asked.
  const hasAts = !!(user && user.products && user.products.ats)
    && ['requirements', 'candidates', 'clients', 'interviews', 'recruiterbde']
      .some((m) => canModule(user, m));
  const atsQueues = hasAts && can(user, null, 'dashboard', 'Pending Approvals', 'view');

  const hasAccounts = canModule(user, 'accounts') && can(user, 'accounts', 'accounts', 'Invoices', 'view');
  const seesBank = can(user, 'accounts', 'accounts', 'Bank & Reconciliation', 'view');

  const reportLinks = visibleItems(user, REPORTS_ITEMS);

  const [ats, setAts] = useState(null);      // /dashboard/ats
  const [core, setCore] = useState(null);    // /dashboard
  const [hrms, setHrms] = useState(null);    // the scoped HRMS lists
  const [acc, setAcc] = useState(null);      // /dashboard/accounts
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    // Every request is caught. One refusal, or one slow table, must not take
    // the whole dashboard down — and an unhandled rejection here has history.
    const get = (url, params) => api.get(url, params ? { params } : undefined)
      .then((r) => r.data).catch(() => null);
    const none = Promise.resolve(null);

    Promise.all([
      atsQueues ? get('/dashboard/ats') : none,
      hasAts ? get('/dashboard') : none,
      hasHrms
        ? Promise.all([
          seesTeam ? get('/employees') : none,
          seesAttendance ? get('/attendance', { date: today }) : none,
          seesLeave ? get('/leave') : none,
          seesPayroll ? get('/payroll', { month }) : none,
          seesServices ? get('/helpdesk') : none,
        ]).then(([employees, attendance, leave, payslips, tickets]) => ({
          employees, attendance, leave, payslips, tickets,
        }))
        : none,
      hasAccounts ? get('/dashboard/accounts') : none,
    ])
      .then(([a, c, h, ac]) => {
        if (!alive) return;
        setAts(a); setCore(c); setHrms(h); setAcc(ac); setLoading(false);
      })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user && user.id, user && user.workspace]);

  if (loading) return <div className="small-muted">Loading dashboard…</div>;

  const departments = String(user?.atsScopeDepartments || user?.department || '')
    .split(',').map((d) => d.trim()).filter(Boolean);
  const scoped = !!(ats && ats.scope && !ats.scope.global && departments.length);

  // --- HRMS figures, all from the scoped lists above ----------------------
  const leave = (hrms && hrms.leave) || [];
  const attendance = (hrms && hrms.attendance) || [];
  const payslips = (hrms && hrms.payslips) || [];
  const tickets = (hrms && hrms.tickets) || [];
  const present = attendance.filter((a) => ['Present', 'Late'].includes(a.status)).length;
  const myToday = attendance[0] ? attendance[0].status : 'Not marked';
  const leavePending = leave.filter((l) => l.status === 'Pending').length;
  const ticketsOpen = tickets.filter((t) => !['Resolved', 'Closed'].includes(t.status)).length;

  // --- ATS: Selected and Joined, from /api/dashboard's scoped counts ------
  const stage = (code) => ((core && core.pipelineByStage) || [])
    .find((s) => s.stage === code)?.count || 0;
  const selected = stage('SELECTED') + stage('OFFER') + stage('OFFER_ACCEPTED');
  const joined = core ? core.hiringOutcomes : null;
  // The role-shaped rows /dashboard/ats already writes ("My Requirements",
  // "My Team Candidates", "Department Requirements"…). Selected and Joined are
  // appended only where that set does not already carry them.
  const atsRows = (ats && ats.myWork) || [];
  const carries = (word) => atsRows.some((r) => r.label.toLowerCase().includes(word));

  const nothing = !hasHrms && !hasAts && !hasAccounts && reportLinks.length === 0;

  return (
    <>
      <PageHead user={user} extra={scoped ? ` · ${departments.join(', ')}` : ''} />

      {scoped && (
        <div className="notice">
          Scoped to {departments.length > 1 ? 'your assigned departments' : 'your assigned department'}
          {` (${departments.join(', ')})`} — requirements, candidates, interviews and employee records
          outside it are not counted here.
        </div>
      )}

      {/* --- HRMS ------------------------------------------------------- */}
      {hasHrms && hrms && (
        <Panel
          title="HRMS"
          right={!seesTeam ? 'My own records'
            : scoped ? (departments.length > 1 ? 'Your departments' : 'Your department')
              : 'Today'}
        >
          {seesTeam && (
            <Row
              label="Employees"
              value={hrms.employees ? hrms.employees.length : null}
              sub={hrms.employees
                ? `${hrms.employees.filter((e) => e.employmentStatus === 'Active').length} active`
                : null}
              to="/employees"
            />
          )}
          {seesAttendance && (
            <Row
              label="Attendance"
              value={seesTeam ? present : myToday}
              sub={seesTeam ? 'marked present today' : 'today'}
              to="/attendance"
            />
          )}
          {seesLeave && (
            <Row
              label="Leave"
              value={leavePending}
              sub={seesTeam ? 'awaiting a decision' : 'requests pending'}
              to="/leave"
            />
          )}
          {seesPayroll && (
            <Row label="Payroll" value={payslips.length} sub="payslips this month" to="/payroll" />
          )}
          {!seesTeam && seesServices && (
            <Row label="Employee Services" value={ticketsOpen} sub="open requests" to="/employee-services" />
          )}
        </Panel>
      )}

      {/* --- ATS -------------------------------------------------------- */}
      {hasAts && (
        <Panel
          title={ats ? ats.myWorkTitle : 'ATS'}
          right={ats && ats.scope && ats.scope.global ? 'All departments' : null}
        >
          {atsRows.map((w) => <Row key={w.label} label={w.label} value={w.value} to={w.to} />)}
          {!carries('selected') && (
            <Row label="Selected" value={selected} to="/candidates?stage=SELECTED,OFFER,OFFER_ACCEPTED" />
          )}
          {!carries('joining') && !carries('joined') && (
            <Row label="Joined" value={joined} to="/candidates?stage=JOINED,HIRED" />
          )}
          {atsRows.length === 0 && !core && (
            <div className="empty-mini">Your ATS figures could not be read just now.</div>
          )}
        </Panel>
      )}

      {/* The ATS queues, and then what to do about them. */}
      {atsQueues && ats && (
        <>
          <Panel title="Pending actions" right={String(ats.pendingTotal)}>
            {ats.pendingActions.length === 0 && (
              <div className="empty-mini">No queues are assigned to your role.</div>
            )}
            {ats.pendingActions.map((p) => (
              <Row key={p.id} label={p.label} value={p.count} to={p.to} sub={p.count ? p.action : null} />
            ))}
          </Panel>

          <Panel
            title="What needs an action"
            right={`${ats.queue.length} item${ats.queue.length === 1 ? '' : 's'}`}
          >
            <ActionList rows={ats.queue.slice(0, 8)} navigate={navigate} />
          </Panel>
        </>
      )}

      {/* --- Accounts --------------------------------------------------- */}
      {hasAccounts && acc && (
        <Panel title="Accounts">
          <Row label="Invoices" value={acc.invoices} sub={`${acc.pending} pending`} to="/invoices" />
          <Row label="Payments" value={rupees(acc.received)} sub="received" to="/invoices" />
          <Row label="Outstanding" value={rupees(acc.outstanding)} sub={`${acc.overdue} overdue`} to="/invoices" />
          {seesBank && (
            <Row label="Reconciliation" value={acc.unreconciled} sub="transactions unmatched" to="/bank" />
          )}
        </Panel>
      )}

      {hasAccounts && acc && (acc.needsAttention || []).length > 0 && (
        <Panel title="Invoices needing attention" right={String(acc.needsAttention.length)}>
          <div className="tbl-wrap" style={{ border: 0, borderRadius: 0 }}>
            <table>
              <thead><tr><th>Invoice</th><th>Client</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {acc.needsAttention.map((i) => (
                  <tr key={i.id} className="row-link" onClick={() => navigate(`/invoices/${i.id}`)}>
                    <td>{i.invoiceNumber || i.id}</td>
                    <td>{i.client}</td>
                    <td>{rupees(i.total)}</td>
                    <td>
                      <span className={`status ${i.status === 'Overdue' ? 'rejected' : 'pending'}`}>{i.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* --- Reports ---------------------------------------------------- */}
      {reportLinks.length > 0 && (
        <Panel title="Reports">
          {reportLinks.map((r) => (
            <Row key={r.to} label={`${r.icon ? `${r.icon} ` : ''}${r.label}`} value="Open" to={r.to} />
          ))}
        </Panel>
      )}

      {nothing && (
        <Panel title="Your workspace">
          <div className="empty-mini">
            No product is enabled for your login yet. An administrator grants HRMS, ATS or Accounts
            access in Administration → Users.
          </div>
        </Panel>
      )}
    </>
  );
}

// --- The client's own dashboard (§18: "only their client dashboard") -------
function ClientDashboard({ user }) {
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);
  const [apps, setApps] = useState([]);
  useEffect(() => {
    let alive = true;
    Promise.all([
      api.get('/dashboard').then((r) => r.data).catch(() => ({})),
      api.get('/applications').then((r) => r.data).catch(() => []),
    ]).then(([s, a]) => { if (alive) { setStats(s); setApps(a || []); } });
    return () => { alive = false; };
  }, []);
  if (!stats) return <div className="small-muted">Loading dashboard…</div>;

  const mine = apps.filter((a) => a.requirement?.clientId === user?.clientId);
  const awaiting = mine.filter((a) => ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'].includes(a.stage));
  const stage = (code) => (stats.pipelineByStage || []).find((s) => s.stage === code)?.count || 0;

  return (
    <>
      <PageHead user={user} />
      <Panel title="My company" right="Your requirements only">
        <Row label="Open requirements" value={stats.openRequirements} to="/requirements" />
        <Row label="Awaiting your review" value={stats.clientReview} to="/candidates" />
        <Row label="Shortlisted" value={stage('CLIENT_SHORTLISTED')} to="/candidates" />
        <Row label="Interviews scheduled" value={stats.interviewsUpcoming} to="/ats/calendar" />
        <Row label="Selected" value={stage('SELECTED') + stage('JOINED')} to="/candidates" />
      </Panel>
      <Panel title="Candidates awaiting your review" right={String(awaiting.length)}>
        <div className="tbl-wrap" style={{ border: 0, borderRadius: 0 }}>
          <table>
            <thead><tr><th>Candidate</th><th>Requirement</th><th>Stage</th></tr></thead>
            <tbody>
              {awaiting.slice(0, 8).map((a) => (
                <tr key={a.id} className="row-link" onClick={() => navigate(`/candidates/${a.candidateId}`)}>
                  <td>{a.candidate?.name}</td>
                  <td>{a.requirement?.title}</td>
                  <td><span className={`status ${STAGE_BADGE[a.stage] || 'new'}`}>{stageLabel(a.stage)}</span></td>
                </tr>
              ))}
              {awaiting.length === 0 && (
                <tr><td colSpan="3" className="small-muted" style={{ padding: 16 }}>Nothing pending.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
