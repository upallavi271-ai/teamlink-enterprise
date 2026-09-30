import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import api from '../api';
import sharedGet from '../utils/sharedGet';
import { useAuth } from '../context/AuthContext.jsx';
import { stageLabel } from '../atsVocab';
import { can, canModule, isClientUser, workRoleLabel } from '../permissions';
import { REPORTS_ITEMS, visibleItems } from '../nav';
import DateRangePicker, { useDateRange, rangeParams, resolveRange } from '../components/DateRangePicker.jsx';
import InsightsPanel from '../components/charts/InsightsPanel.jsx';
import Reminders from './office/Reminders.jsx';
import { canViewOffice } from './office/approval.jsx';
import ListFilterBar, { useListFilters, ListEmpty } from '../components/ui/ListFilters.jsx';
import Pager, { usePaged } from '../components/Pager.jsx';
import DeskBoard from '../components/dashboard/DeskBoard.jsx';

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
//
// THE DATE RANGE in the header (remembered per login in localStorage) is
// passed to every endpoint above that has a dated answer: attendance for the
// range, interviews and joinings in it, and the ATS rows /dashboard/ats labels
// "— <period>". Queues, headcount, pending approvals and the Accounts balances
// are the position right now and are labelled "(now)" / "(all time)"; the
// Accounts Dashboard keeps its own financial-period picker for those.
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

function PageHead({ user, extra, range, setRange }) {
  const name = String(user?.name || '').replace(/\(.*\)/, '').trim();
  return (
    <div className="page-head">
      <div>
        <h1>Dashboard</h1>
        <div className="page-sub">
          Welcome back, {name} · {workRoleLabel(user)}{extra || ''}
        </div>
      </div>
      {range && (
        <div className="filter-row" style={{ marginBottom: 0 }}>
          <DateRangePicker value={range} onChange={setRange} period={resolveRange(range)} />
        </div>
      )}
    </div>
  );
}

// The queue as an action list: one row per item, each carrying the single move
// that advances it. Straight from /api/dashboard/ats.
// The dashboard shows the first 8; "Show all" opens the whole (filtered) list
// with paging. Filters: Search · Stage · Due · Next action (the standard).
const PREVIEW = 8;
function ActionList({ rows: all, navigate }) {
  const today = new Date().toISOString().slice(0, 10);
  const [expanded, setExpanded] = useState(false);
  const dueOf = (r) => (!r.due ? 'none' : r.overdue ? 'overdue' : r.due === today ? 'today' : 'upcoming');
  const lf = useListFilters(all, [
    { key: 'q', type: 'search', placeholder: 'Search candidate or requirement…', minWidth: 200,
      get: (r) => `${r.candidate || ''} ${r.requirement || ''} ${r.client || ''}` },
    { key: 'stage', label: 'Stage', allLabel: 'All stages', primary: true, get: (r) => r.stageLabel },
    { key: 'due', label: 'Due', allLabel: 'Any due date', primary: true, get: dueOf,
      options: [{ value: 'overdue', label: 'Overdue' }, { value: 'today', label: 'Due today' }, { value: 'upcoming', label: 'Upcoming' }, { value: 'none', label: 'No due date' }] },
    { key: 'next', label: 'Next action', allLabel: 'All next actions', get: (r) => r.nextAction },
  ]);
  const page = usePaged(lf.rows);
  const rows = expanded ? page.slice : lf.rows.slice(0, PREVIEW);
  return (
    <>
      {all.length > 0 && <div style={{ padding: '8px 12px 0' }}><ListFilterBar lf={lf} storageKey="dash-action-list" noun="items" /></div>}
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
          {all.length === 0 && (
            <tr>
              <td colSpan="5" className="small-muted" style={{ padding: 16 }}>
                Nothing is waiting on you — every item in your scope has moved on.
              </td>
            </tr>
          )}
          {all.length > 0 && lf.rows.length === 0 && (
            <tr><td colSpan="5"><ListEmpty lf={lf} noun="items" /></td></tr>
          )}
        </tbody>
      </table>
    </div>
      {expanded && <Pager page={page} noun="items" />}
      {lf.rows.length > PREVIEW && (
        <div style={{ padding: '6px 12px 10px' }}>
          <button type="button" className="link-btn" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Show fewer' : `Show all ${lf.rows.length} →`}
          </button>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

export default function Dashboard() {
  const { user } = useAuth();
  // A client is outside this company: their dashboard is their own company's
  // pipeline and nothing else — never an internal product block, even where
  // their login carries a product flag for the portal screens.
  // User notes #4 — an outside login's home IS its portal.
  if (isClientUser(user)) return <Navigate to="/client-portal" replace />;
  if (user && user.role === 'CANDIDATE') return <Navigate to="/my-applications" replace />;
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
  // Reminders (bills and payments due) — the due dates Office & Expenses
  // keeps, for the logins that can open that page (GET /office-expenses/due-dates
  // refuses everyone else).
  const seesOffice = canViewOffice(user);

  const reportLinks = visibleItems(user, REPORTS_ITEMS);
  const adminHome = !!user && ['SUPER_ADMIN', 'ADMIN'].includes(user.role) && can(user, null, 'administration', 'Users', 'view');

  const [ats, setAts] = useState(null);      // /dashboard/ats
  const [core, setCore] = useState(null);    // /dashboard
  const [hrms, setHrms] = useState(null);    // the scoped HRMS lists
  const [acc, setAcc] = useState(null);      // /dashboard/accounts
  // Which reads are still out. Each part of the page draws as soon as its
  // own answer lands, so one slow read (the ATS aggregates, historically)
  // no longer holds the whole dashboard on "Loading…".
  const [pending, setPending] = useState({ ats: true, core: true, hrms: true, acc: true });
  const [range, setRange] = useDateRange('tl_dash_range_home');
  const period = resolveRange(range);

  useEffect(() => {
    let alive = true;
    const dated = rangeParams(range);
    // One day keeps the old ?date= read; a range asks for every mark inside it.
    const attendanceParams = period.days === 1 ? { date: period.from } : { from: period.from, to: period.to };
    // Every request is caught. One refusal, or one slow table, must not take
    // the whole dashboard down — and an unhandled rejection here has history.
    const get = (url, params) => sharedGet(url, params)
      .then((r) => r.data).catch(() => null);
    const none = Promise.resolve(null);

    // The dated reads start empty for a new range, so a figure from the old
    // range is never shown under the new range's labels.
    setAts(null); setCore(null); setHrms(null);
    setPending({ ats: true, core: true, hrms: true, acc: true });
    const land = (key, set) => (value) => {
      if (!alive) return;
      set(value);
      setPending((p) => ({ ...p, [key]: false }));
    };

    (atsQueues ? get('/dashboard/ats', dated) : none).then(land('ats', setAts));
    (hasAts ? get('/dashboard', dated) : none).then(land('core', setCore));
    (hasHrms
        ? Promise.all([
          seesTeam ? get('/employees') : none,
          seesAttendance ? get('/attendance', attendanceParams) : none,
          seesLeave ? get('/leave') : none,
          // hrms-24 §1 — the leave and payroll rows follow the range too,
          // counted on the server (routes/insights.js), not in the browser.
          seesPayroll ? get('/insights/payroll', dated) : none,
          seesServices ? get('/helpdesk') : none,
          seesLeave ? get('/insights/leave', dated) : none,
        ]).then(([employees, attendance, leave, payroll, tickets, leaveInRange]) => ({
          employees, attendance, leave, payroll, tickets, leaveInRange,
        }))
        : none).then(land('hrms', setHrms));
    (hasAccounts ? get('/dashboard/accounts') : none).then(land('acc', setAcc));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user && user.id, user && user.workspace, range.range, range.from, range.to]);

  const departments = String(user?.atsScopeDepartments || user?.department || '')
    .split(',').map((d) => d.trim()).filter(Boolean);
  const scoped = !!(ats && ats.scope && !ats.scope.global && departments.length);

  // --- HRMS figures, all from the scoped lists above ----------------------
  const leave = (hrms && hrms.leave) || [];
  const attendance = (hrms && hrms.attendance) || [];
  // A tile's value from an /insights payload, or null (drawn as —) when the
  // read failed.
  const tileOf = (d, key) => (d && d.tiles ? ((d.tiles.find((t) => t.key === key) || {}).value ?? null) : null);
  const tickets = (hrms && hrms.tickets) || [];
  // Over a range this is marks, not people: present on 20 days counts 20.
  const present = attendance.filter((a) => ['Present', 'Late'].includes(a.status)).length;
  const myToday = attendance[0] ? attendance[0].status : 'Not marked';
  const oneDay = period.days === 1;
  const inP = (label) => `${label} — ${period.name}`;
  const leavePending = leave.filter((l) => l.status === 'Pending').length;
  const ticketsOpen = tickets.filter((t) => !['Resolved', 'Closed'].includes(t.status)).length;

  // --- ATS: Selected and Joined, from /api/dashboard's scoped counts ------
  const stage = (code) => ((core && core.pipelineByStage) || [])
    .find((s) => s.stage === code)?.count || 0;
  const selected = stage('SELECTED') + stage('OFFER') + stage('OFFER_ACCEPTED');
  // Joinings dated inside the range (/api/dashboard `inPeriod`).
  const joined = core && core.inPeriod ? core.inPeriod.joined : null;
  // The role-shaped rows /dashboard/ats already writes ("My Requirements",
  // "My Team Candidates", "Department Requirements"…). Selected and Joined are
  // appended only where that set does not already carry them.
  const atsRows = (ats && ats.myWork) || [];
  const carries = (word) => atsRows.some((r) => r.label.toLowerCase().includes(word));

  const nothing = !hasHrms && !hasAts && !hasAccounts && reportLinks.length === 0;

  return (
    <>
      <PageHead user={user} extra={scoped ? ` · ${departments.join(', ')}` : ''} range={range} setRange={setRange} />

      {/* Super Admin / Admin home (dashboard spec 2026-09-29 §6): users, sync
          and duplicate health, audit, approvals — GET /dashboard/admin-desk. */}
      {adminHome && <DeskBoard url="/dashboard/admin-desk" title="Administration" sub="Not date-filtered · every number opens its list" />}

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
              : period.name}
        >
          {seesTeam && (
            <Row
              label="Employees (now)"
              value={hrms.employees ? hrms.employees.length : null}
              sub={hrms.employees
                ? `${hrms.employees.filter((e) => e.employmentStatus === 'Active').length} active`
                : null}
              to="/employees"
            />
          )}
          {seesAttendance && (
            <Row
              label={inP('Attendance')}
              value={seesTeam || !oneDay ? present : myToday}
              sub={seesTeam
                ? (oneDay ? 'marked present' : 'present marks across the range')
                : (oneDay ? null : 'days present')}
              to="/attendance"
            />
          )}
          {seesLeave && (
            <Row
              label="Leave (now)"
              value={leavePending}
              sub={seesTeam ? 'awaiting a decision' : 'requests pending'}
              to="/leave"
            />
          )}
          {seesLeave && (
            <Row
              label={inP('Leave requests')}
              value={tileOf(hrms.leaveInRange, 'total')}
              sub={hrms.leaveInRange ? `${tileOf(hrms.leaveInRange, 'approved')} approved · ${tileOf(hrms.leaveInRange, 'days')} day(s)` : null}
              to="/leave"
            />
          )}
          {seesPayroll && (
            <Row label={inP('Payroll')} value={tileOf(hrms.payroll, 'payslips')} sub="payslips for months in the range" to="/payroll" />
          )}
          {!seesTeam && seesServices && (
            <Row label="Employee Services (now)" value={ticketsOpen} sub="open requests" to="/employee-services" />
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
          {(pending.ats || pending.core) && atsRows.length === 0 && (
            <div className="small-muted" style={{ padding: '8px 0' }}>Loading…</div>
          )}
          {!pending.core && !carries('selected') && (
            <Row label="Selected (now)" value={selected} to="/candidates?stage=SELECTED,OFFER,OFFER_ACCEPTED" />
          )}
          {!pending.core && !carries('joining') && !carries('joined') && (
            <Row label={inP('Joined')} value={joined} to="/candidates?stage=JOINED,HIRED" />
          )}
          {atsRows.length === 0 && !core && !pending.ats && !pending.core && (
            <div className="empty-mini">Your ATS figures could not be read just now.</div>
          )}
        </Panel>
      )}

      {/* The ATS queues, and then what to do about them. */}
      {atsQueues && ats && (
        <>
          <Panel title="Pending actions (now)" right={String(ats.pendingTotal)}>
            {ats.pendingActions.length === 0 && (
              <div className="empty-mini">No queues are assigned to your role.</div>
            )}
            {ats.pendingActions.map((p) => (
              <Row key={p.id} label={p.label} value={p.count} to={p.to} sub={p.count ? p.action : null} />
            ))}
          </Panel>

          <Panel
            title="What needs an action (now)"
            right={`${ats.queue.length} item${ats.queue.length === 1 ? '' : 's'}`}
          >
            <ActionList rows={ats.queue} navigate={navigate} />
          </Panel>
        </>
      )}

      {/* --- Accounts --------------------------------------------------- */}
      {hasAccounts && acc && (
        // The ledger's standing position — not narrowed by the date range; the
        // Accounts Dashboard has its own financial-period picker for that.
        <Panel title="Accounts" right="Not date-filtered">
          <Row label="Invoices (all time)" value={acc.invoices} sub={`${acc.pending} pending`} to="/invoices" />
          <Row label="Payments (all time)" value={rupees(acc.received)} sub="received" to="/invoices" />
          <Row label="Outstanding (now)" value={rupees(acc.outstanding)} sub={`${acc.overdue} overdue`} to="/invoices" />
          {seesBank && (
            <Row label="Reconciliation (now)" value={acc.unreconciled} sub="transactions unmatched" to="/bank" />
          )}
        </Panel>
      )}

      {hasAccounts && acc && (acc.needsAttention || []).length > 0 && (
        <Panel title="Invoices needing attention (now)" right={String(acc.needsAttention.length)}>
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

      {seesOffice && <Reminders />}

      {/* --- Charts (hrms-24 §9): the same range, the viewer's own scope -- */}
      {((hasHrms && seesAttendance) || hasAts) && (
        <>
          <div className="section-label">{`Charts — ${period.name}`}</div>
          {hasHrms && seesAttendance && <InsightsPanel module="attendance" range={range} tiles={false} only={['att-status', 'att-trend']} />}
          {hasHrms && seesLeave && <InsightsPanel module="leave" range={range} tiles={false} only={['leave-status', 'leave-type']} />}
          {hasAts && <InsightsPanel module="ats" range={range} tiles={false} only={['ats-funnel', 'ats-trend']} />}
        </>
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
  const [range, setRange] = useDateRange('tl_dash_range_home');
  const [expanded, setExpanded] = useState(false);
  const mineAwaiting = apps.filter((a) => a.requirement?.clientId === user?.clientId
    && ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'].includes(a.stage));
  const lf = useListFilters(mineAwaiting, [
    { key: 'q', type: 'search', placeholder: 'Search candidate or requirement…',
      get: (a) => `${a.candidate?.name || ''} ${a.requirement?.title || ''}` },
    { key: 'req', label: 'Requirement', allLabel: 'All requirements', primary: true, get: (a) => a.requirement?.title },
    { key: 'stage', label: 'Stage', allLabel: 'All stages', primary: true, get: (a) => stageLabel(a.stage) },
  ]);
  const awaitingPage = usePaged(lf.rows);
  useEffect(() => {
    let alive = true;
    Promise.all([
      api.get('/dashboard', { params: rangeParams(range) }).then((r) => r.data).catch(() => ({})),
      api.get('/applications').then((r) => r.data).catch(() => []),
    ]).then(([s, a]) => { if (alive) { setStats(s); setApps(a || []); } });
    return () => { alive = false; };
  }, [range]);
  if (!stats) return <div className="small-muted">Loading dashboard…</div>;
  const period = resolveRange(range);

  const mine = apps.filter((a) => a.requirement?.clientId === user?.clientId);
  const awaiting = mine.filter((a) => ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'].includes(a.stage));
  const stage = (code) => (stats.pipelineByStage || []).find((s) => s.stage === code)?.count || 0;

  return (
    <>
      <PageHead user={user} range={range} setRange={setRange} />
      <Panel title="My company" right="Your requirements only">
        <Row label="Open requirements (now)" value={stats.openRequirements} to="/requirements" />
        <Row label="Awaiting your review (now)" value={stats.clientReview} to="/candidates" />
        <Row label="Shortlisted (now)" value={stage('CLIENT_SHORTLISTED')} to="/candidates" />
        <Row label={`Interviews — ${period.name}`} value={stats.inPeriod ? stats.inPeriod.interviews : null} to="/ats/calendar" />
        <Row label="Selected (now)" value={stage('SELECTED') + stage('JOINED')} to="/candidates" />
      </Panel>
      <Panel title="Candidates awaiting your review (now)" right={String(awaiting.length)}>
        {awaiting.length > 0 && <div style={{ padding: '8px 12px 0' }}><ListFilterBar lf={lf} storageKey="dash-client-awaiting" noun="candidates" /></div>}
        <div className="tbl-wrap" style={{ border: 0, borderRadius: 0 }}>
          <table>
            <thead><tr><th>Candidate</th><th>Requirement</th><th>Stage</th></tr></thead>
            <tbody>
              {(expanded ? awaitingPage.slice : lf.rows.slice(0, PREVIEW)).map((a) => (
                <tr key={a.id} className="row-link" onClick={() => navigate(`/candidates/${a.candidateId}`)}>
                  <td>{a.candidate?.name}</td>
                  <td>{a.requirement?.title}</td>
                  <td><span className={`status ${STAGE_BADGE[a.stage] || 'new'}`}>{stageLabel(a.stage)}</span></td>
                </tr>
              ))}
              {awaiting.length === 0 && (
                <tr><td colSpan="3" className="small-muted" style={{ padding: 16 }}>Nothing pending.</td></tr>
              )}
              {awaiting.length > 0 && lf.rows.length === 0 && (
                <tr><td colSpan="3"><ListEmpty lf={lf} noun="candidates" /></td></tr>
              )}
            </tbody>
          </table>
        </div>
        {expanded && <Pager page={awaitingPage} noun="candidates" />}
        {lf.rows.length > PREVIEW && (
          <div style={{ padding: '6px 12px 10px' }}>
            <button type="button" className="link-btn" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Show fewer' : `Show all ${lf.rows.length} →`}
            </button>
          </div>
        )}
      </Panel>
    </>
  );
}
