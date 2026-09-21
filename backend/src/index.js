require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const clientRoutes = require('./routes/clients');
const requirementRoutes = require('./routes/requirements');
const jobPortalRoutes = require('./routes/jobPortal');
const candidateRoutes = require('./routes/candidates');
const applicationRoutes = require('./routes/applications');
const followUpRoutes = require('./routes/followups');
const dashboardRoutes = require('./routes/dashboard');
const employeeRoutes = require('./routes/employees');
const attendanceRoutes = require('./routes/attendance');
const leaveRoutes = require('./routes/leave');
const payrollRoutes = require('./routes/payroll');
const invoiceRoutes = require('./routes/invoices');
const bankRoutes = require('./routes/bank');
const publicRoutes = require('./routes/public');
const performanceRoutes = require('./routes/performance');
const lmsRoutes = require('./routes/lms');
const projectRoutes = require('./routes/projects');
const surveyRoutes = require('./routes/surveys');
const documentRoutes = require('./routes/documents');
const announcementRoutes = require('./routes/announcements');
const adminRoutes = require('./routes/admin');
const reportRoutes = require('./routes/reports');
const officeRoutes = require('./routes/office');
const atsExtrasRoutes = require('./routes/atsExtras');
const interviewsJoiningRoutes = require('./routes/interviewsJoining');
const employeeRecordRouter = require('./routes/employeeRecords');
const shiftPatternRoutes = require('./routes/shiftPatterns');
const helpdeskRoutes = require('./routes/helpdesk');
const assetInventoryRoutes = require('./routes/assetInventory');
const weeklyIdeaRoutes = require('./routes/weeklyIdeas');
const resignationRoutes = require('./routes/resignations');
const hrmsDashboardRoutes = require('./routes/hrmsDashboard');
const escalationRoutes = require('./routes/escalation');
const taskRoutes = require('./routes/tasks');
const aiRoutes = require('./routes/ai');
const mailWorker = require('./utils/mailWorker');

// hrManagedCreate: only someone with HRMS Employee Management reach may
// create these record types for another employee. Resolved by the permission
// engine at request time (req.user.caps.hrmsManage), not by a role list here.

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// TeamLink Job Portal — served verbatim as a static asset.
//
// The portal is the customer's own self-contained single-file app. It lives at
// frontend/public/job-portal/index.html (~1.5MB), is never imported by any JS
// module, and is served as-is so that every feature and field behaves exactly
// as it does when the file is opened on its own. It routes on the URL hash, so
// the sub-path mount needs no rewriting.
//
// The frontend dev server / static host serves the same file at the same
// stable route, /job-portal/; this mount makes it reachable from the API
// origin too (e.g. a deployment that fronts only this process).
//
// SYNC SEAM: the portal currently keeps its jobs, candidates, applications and
// resumes in browser local storage (tl_job_portal_state_v1), so nothing it
// records reaches this database. A real Enterprise <-> Portal sync attaches
// here: give the portal an API to read requirements from and to POST
// applications, candidate profiles and resumes back into, then have stage and
// status changes flow out the same way. Nothing below fakes that today, and
// Administration -> Integrations says so on screen.
// ---------------------------------------------------------------------------
const JOB_PORTAL_DIR = path.join(__dirname, '..', '..', 'frontend', 'public', 'job-portal');
// express.static resolves "/job-portal/" to index.html on its own. The bare
// "/job-portal" form needs an explicit redirect, written app-level and matched
// on the exact path so it cannot also match "/job-portal/" and loop (a
// mounted app.get('/job-portal') would match both — Express is not strict
// about the trailing slash).
app.use((req, res, next) => {
  if (req.path === '/job-portal') return res.redirect(302, '/job-portal/');
  return next();
});
app.use('/job-portal', express.static(JOB_PORTAL_DIR, { index: 'index.html' }));

app.use('/api/auth', authRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/requirements', requirementRoutes);
// The Job Portal WORKSPACE API. Its own mount, but not its own module: every
// route inside is guarded on a feature of `requirements`, which is where the
// Job Portal lives in the navigation too (Jobs / Requirements -> Job Portal).
app.use('/api/job-portal', jobPortalRoutes);
app.use('/api/candidates', candidateRoutes);
app.use('/api/applications', applicationRoutes);
// followup_: the follow-up record, one per application. See routes/followups.js.
app.use('/api/followups', followUpRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/leave', leaveRoutes);
app.use('/api/payroll', payrollRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/bank', bankRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/performance', performanceRoutes);
app.use('/api/lms', lmsRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/surveys', surveyRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/office-expenses', officeRoutes);
app.use('/api/ats', atsExtrasRoutes);
// Interviews & Joining (Interview Feedback, Offers, Joining, Internal Hiring)
// shares the /api/ats prefix with the calendar above.
app.use('/api/ats', interviewsJoiningRoutes);
// The AI Assistant. Server-side only: the Anthropic key stays in the encrypted
// credential store (utils/secrets.js) and never reaches the browser.
app.use('/api/ai', aiRoutes);
app.use('/api/hrms/dashboard', hrmsDashboardRoutes);
app.use('/api/hrms/escalation', escalationRoutes);
// Timesheet — tasks, assignment, comments and the Task Reports roll-up. The
// generic /api/timesheet EmployeeRecord router below stays mounted for the
// hour-log rows it already holds.
app.use('/api/tasks', taskRoutes);

// EmployeeRecord-backed HRMS long-tail areas — one generic model, one route per type.
// Helpdesk and Resignation still store EmployeeRecord rows but have their own
// routers, because they carry real workflow (SLA/escalation/CSAT; notice period
// and the employment-status mirror) that the generic CRUD router can't express.
app.use('/api/kt', employeeRecordRouter('KT'));
app.use('/api/targets', employeeRecordRouter('TARGET', { createRoles: true }));
app.use('/api/resignations', resignationRoutes);
app.use('/api/recognition', employeeRecordRouter('RECOGNITION', { createRoles: true }));
app.use('/api/disciplinary', employeeRecordRouter('DISCIPLINARY', { createRoles: true }));
app.use('/api/shift-roster', employeeRecordRouter('SHIFT'));
app.use('/api/timesheet', employeeRecordRouter('TIMESHEET'));
app.use('/api/assets', employeeRecordRouter('ASSET', { createRoles: true }));
// Expense & Travel Claims carry a real bill/receipt — the one record type with
// a stored attachment today (see backend/src/utils/attachments.js).
app.use('/api/expenses', employeeRecordRouter('EXPENSE', { attachments: true }));
app.use('/api/helpdesk', helpdeskRoutes);
// Company asset inventory (Employee Services → Assets). /api/assets above stays
// as the employee-raised asset *request* list, which feeds Asset Approval.
app.use('/api/asset-inventory', assetInventoryRoutes);
app.use('/api/access-requests', employeeRecordRouter('ACCESS_REQUEST'));
// Weekly ideas keep the same EmployeeRecord store (type: 'WEEKLY_IDEA') but
// need AI duplicate screening and scoring on write, plus the quota and
// leaderboard reads Knowledge Transfer shows — so they have their own router
// rather than the generic one.
app.use('/api/weekly-ideas', weeklyIdeaRoutes);
app.use('/api/shift-patterns', shiftPatternRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`TeamLink API listening on http://localhost:${PORT}`);
  // The email sending worker. A no-op until Administration → Integrations has
  // an SMTP channel configured; MAIL_WORKER_INTERVAL_MS=0 switches it off.
  mailWorker.start();
});
