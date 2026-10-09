require('dotenv').config();
// TEST SANDBOX (utils/sandbox.js): only when TEST_MODE=1 / TEAMLINK_SANDBOX=1 —
// refuses the real DB/port, then hard-disables every outbound channel.
const sandbox = require('./utils/sandbox');
sandbox.assertSafe();
sandbox.installGuards();
const path = require('path');
const express = require('express');
const cors = require('cors');

// ASYNC ROUTE ERRORS GO TO THE ERROR HANDLER, NOT THE PROCESS.
// Express 4 never looks at the promise an async handler returns, so a thrown
// database error inside one became an unhandled rejection and Node took the
// whole API down with it (one bad requirement save left every screen dead
// until nodemon saw a file change). Every handler's rejection is now passed to
// next(), which answers that one request with a 500 and keeps serving the
// rest. Patched once, here, before any router is built.
const Layer = require('express/lib/router/layer');
const handleRequest = Layer.prototype.handle_request;
Layer.prototype.handle_request = function handleAsync(req, res, next) {
  if (this.handle.length > 3) return handleRequest.call(this, req, res, next); // error middleware
  try {
    const result = this.handle(req, res, next);
    if (result && typeof result.catch === 'function') result.catch(next);
    return result;
  } catch (err) {
    return next(err);
  }
};

const authRoutes = require('./routes/auth');
const clientRoutes = require('./routes/clients');
const requirementRoutes = require('./routes/requirements');
const jobPortalRoutes = require('./routes/jobPortal');
const candidateRoutes = require('./routes/candidates');
const applicationRoutes = require('./routes/applications');
const followUpRoutes = require('./routes/followups');
const dashboardRoutes = require('./routes/dashboard');
const employeeRoutes = require('./routes/employees');
const employeeFieldRoutes = require('./routes/employeeFields'); // HRMS item 15 — Manage Fields
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
const atsReportRoutes = require('./routes/atsReports');
const officeRoutes = require('./routes/office');
const atsExtrasRoutes = require('./routes/atsExtras');
const interviewsJoiningRoutes = require('./routes/interviewsJoining');
const employeeRecordRouter = require('./routes/employeeRecords');
const shiftPatternRoutes = require('./routes/shiftPatterns');
const helpdeskRoutes = require('./routes/helpdesk');
const assetInventoryRoutes = require('./routes/assetInventory');
const weeklyIdeaRoutes = require('./routes/weeklyIdeas');
const resignationRoutes = require('./routes/resignations');
const dataImportRoutes = require('./routes/dataImport');
const positionRoutes = require('./routes/positions');
const agreementSealRoutes = require('./routes/agreementSeal');
const hrmsDashboardRoutes = require('./routes/hrmsDashboard');
const escalationRoutes = require('./routes/escalation');
const taskRoutes = require('./routes/tasks');
const assistantRoutes = require('./routes/assistant');
const agentRoutes = require('./routes/agent');
const mailWorker = require('./utils/mailWorker');

// hrManagedCreate: only someone with HRMS Employee Management reach may
// create these record types for another employee. Resolved by the permission
// engine at request time (req.user.caps.hrmsManage), not by a role list here.

const app = express();
// CREDENTIAL MATERIAL NEVER LEAVES THE SERVER (hrms-24 §12). Many routes
// include a related User row (a requirement's recruiter / BDE, an audit
// entry's actor) and res.json() would otherwise serialise its bcrypt hash and
// set-password token hash along with the name. Stripped here, once, for every
// JSON response — no screen reads them.
const NEVER_SERIALISED = new Set(['passwordHash', 'setPasswordTokenHash', 'agreementOtpHash', 'verifyOtpHash', 'codeHash']);
app.set('json replacer', (key, value) => (NEVER_SERIALISED.has(key) ? undefined : value));
// VENDOR PORTAL ISOLATION (utils/vendorAuth.js): a vendor session may reach
// /api/vendor-portal/* and NOTHING else — every other path answers 403.
// First, ahead of every proxy, static mount and router, so none can forget it.
app.use(require('./utils/vendorAuth').vendorSessionGuard);
// PARTNER PORTAL ISOLATION (B7, utils/partnerAuth.js): a partner session may
// reach /api/partner-portal/* and NOTHING else — every other path answers 403.
app.use(require('./utils/partnerAuth').partnerSessionGuard);
// THE TEAMLINK JOB PORTAL at /jobs (utils/jobPortalEmbed.js): the customer's
// portal, unchanged, proxied from its internal port. Ahead of every body
// parser so uploads stream through. JOB_PORTAL_EMBED=0 switches it off.
app.use(require('./utils/jobPortalEmbed').proxy());
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));
// SUPER ADMIN "VIEW AS" IS READ-ONLY (utils/viewAs.js): a View-as token may
// only GET, plus a short allow-list of POSTs that just read. Ahead of every
// router, so no route can forget it.
app.use('/api', require('./utils/viewAs').viewAsGuard);

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
// REPLACED (Sep 2026): the Job Portal is now its own application
// (job-portal-app/, JOB_PORTAL_URL, default http://localhost:4323), synced
// both ways through utils/jobPortalBridge.js. /job-portal on this origin now
// forwards there; the old single-file build above is no longer served.
void JOB_PORTAL_DIR;
// BIOMETRIC DEVICE — the eSSL ADMS / iClock push endpoint (routes/iclock.js).
// No login: only a serial registered under Integrations -> Biometric is served.
app.use('/iclock', require('./routes/iclock'));

app.use('/job-portal', (req, res) => res.redirect(302, `${require('./utils/jobPortalBridge').portalUrl()}/`));

// OMNICHANNEL — the Green Start app (source in omnichannel-web/, built into
// frontend/public/omnichannel/ with --base=/omnichannel/). It routes on the
// path, so any page that is not a file is answered with its index.html.
const OMNICHANNEL_DIR = path.join(__dirname, '..', '..', 'frontend', 'public', 'omnichannel');
app.use('/omnichannel', express.static(OMNICHANNEL_DIR, { index: 'index.html' }));
app.get(/^\/omnichannel(\/.*)?$/, (req, res, next) => {
  if (/\.[a-z0-9]+$/i.test(req.path)) return next();
  return res.sendFile(path.join(OMNICHANNEL_DIR, 'index.html'));
});

// Client contact / commercial fields reach the client desk only — see
// utils/clientRedact.js. Mounted ahead of the ATS routers it filters.
app.use([
  '/api/requirements', '/api/job-portal', '/api/candidates', '/api/applications', '/api/followups',
  '/api/dashboard', '/api/reports', '/api/ats-reports', '/api/ats', '/api/assistant', '/api/agent',
], require('./utils/clientRedact').clientFieldGuard);
app.use('/api/auth', authRoutes);
// Single sign-on to the TeamLink Job Portal (routes/sso.js, utils/jobPortalSso.js).
app.use('/api/sso', require('./routes/sso'));
app.use('/api/clients', clientRoutes);
app.use('/api/client-merge', require('./routes/clientMerge')); // Duplicate clients (SA/Admin)
// JOB PORTAL MIRROR. After any successful write to one requirement (edit,
// status change, close, reopen …) a requirement that has ever been published
// is pushed to the Job Portal, so a closed requirement leaves the board at
// once. Fire-and-forget; utils/jobPortalBridge.js never throws.
app.use('/api/requirements/:id', (req, res, next) => {
  if (req.method !== 'GET') {
    const { id } = req.params;
    res.on('finish', () => {
      if (res.statusCode < 400) require('./utils/jobPortalBridge').pushRequirement(id);
    });
  }
  next();
});
app.use('/api/requirements', requirementRoutes);
// The Job Portal WORKSPACE API. Its own mount, but not its own module: every
// route inside is guarded on a feature of `requirements`, which is where the
// Job Portal lives in the navigation too (Jobs / Requirements -> Job Portal).
app.use('/api/job-portal', jobPortalRoutes);
// Client portal + candidate portal (outside logins) and 'Invite to portal'.
app.use('/api/portal', require('./routes/portal'));
app.use('/api/candidates', candidateRoutes);
// resume_: resume files, versions, edits and the 3-number match (routes/candidateResumes.js).
app.use('/api/candidate-resumes', require('./routes/candidateResumes'));
// docfill_: "Fill from a file" for Add job / Add candidate / Add client (routes/docFill.js).
app.use('/api/doc-fill', require('./routes/docFill'));
// Rejections read-back, "Do not use" approvals, the Matching tabs (routes/rejections.js).
app.use('/api/rejections', require('./routes/rejections'));
app.use('/api/applications', applicationRoutes);
// followup_: the follow-up record, one per application. See routes/followups.js.
app.use('/api/followups', followUpRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/employee-fields', employeeFieldRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/leave', leaveRoutes);
app.use('/api/payroll', payrollRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/bank', bankRoutes);
app.use('/api/banks', require('./routes/banks')); // Accounts S4 — bank-wise statements (read only)
// Accounts Journal & Ledger (SPEC B): POST /api/accounts/journal-entries (the
// internal booking API HRMS payroll posts to, service token), the journal,
// ledger and payroll reconciliation. Per-route guards only — it shares
// /api/accounts and must be reachable without a user token for the service call.
app.use('/api/accounts', require('./routes/journal'));
app.use('/api/accounts-import', require('./routes/accountsImport'));
// The new Job Portal's door in: GET /config and the portal's application push.
// Ahead of publicRoutes, which keeps the classic careers pages and feeds.
app.use('/api/public/job-portal', require('./routes/jobPortalBridge'));
// THE JOB PORTAL, BUILT IN (2026-10-05): the public /careers pages read and
// write this database directly — job list, filters, detail, apply + resume.
app.use('/api/public/careers', require('./routes/careersPublic'));
// B9.6: the public jobs sitemap + robots.txt at the site root (same handlers).
app.get('/sitemap.xml', require('./routes/careersPublic').sitemap);
app.get('/robots.txt', require('./routes/careersPublic').robots);
// Job feeds a board pulls (Naukri XML feed mode) — routes/jobFeeds.js (Save & Post).
app.use('/api/public/feeds', require('./routes/jobFeeds'));
app.use('/api/public', publicRoutes);
app.use('/api/performance', performanceRoutes);
// HRMS → Performance & Development → Recruiter joinings + the Super Admin popup (routes/recruiterJoinings.js).
app.use('/api/recruiter-joinings', require('./routes/recruiterJoinings'));
// ATS-100 B6: employee referrals, campus drives, campaign costs (routes/sourcing.js).
app.use('/api/sourcing', require('./routes/sourcing'));
app.use('/api/lms', lmsRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/surveys', surveyRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/announcements', announcementRoutes);
// The shared Send-to picker's options, audience preview and AI Assist.
app.use('/api/audience', require('./routes/audience'));
// The live master lists every dropdown reads (utils/masters.js; frontend utils/masters.js useMasters()).
app.use('/api/masters', require('./routes/masters'));
// Department -> Qualification -> Specialisation master + back-fill review (spec D).
app.use('/api/specialisations', require('./routes/specialisations'));
// Email / SMS / WhatsApp channel status and queued bulk send (utils/bulkMessaging.js).
app.use('/api/messaging', require('./routes/messaging'));
app.use('/api/admin/view-as', require('./routes/viewAs')); // Super Admin read-only View as
app.use('/api/admin/integration-health', require('./routes/integrationHealth')); // Job Portal / Email / eSSL / AI health (read-only + person-pressed retry)
app.use('/api/admin', adminRoutes);
app.use('/api/reports', reportRoutes);
// ATS -> Reports: the ten recruitment reports, their drill-down and exports.
app.use('/api/ats-reports', atsReportRoutes);
// Recruiter daily report, "Who has pending work", report e-mail setting (routes/atsDaily.js).
app.use('/api/ats-daily', require('./routes/atsDaily'));
app.use('/api/office-expenses', officeRoutes);
// Vendor portal (P3): Accounts review of bills vendors sent (routes/vendorBills.js).
app.use('/api/vendor-bills', require('./routes/vendorBills'));
// Admin → Company Setup → Vendor logins (routes/vendorLogins.js).
app.use('/api/vendor-logins', require('./routes/vendorLogins'));
// The vendor portal itself — the only API a vendor token can reach.
app.use('/api/vendor-portal', require('./routes/vendorPortal'));
// B7 agency / freelancer partners: the master + logins + job shares + report
// (routes/partners.js), Accounts payouts (routes/partnerPayouts.js), and the
// partner portal itself — the only API a partner token can reach.
app.use('/api/partners', require('./routes/partners'));
app.use('/api/partner-payouts', require('./routes/partnerPayouts'));
app.use('/api/partner-portal', require('./routes/partnerPortal'));
// Office & Expenses spec A: GET /api/accounts/combined-summary (salary + office
// outflow for a month). Per-route guards only, so it can share /api/accounts.
app.use('/api/accounts', require('./routes/accountsCombined'));
// Everyone who worked ATS records, current and former — every person filter's
// list (utils/workers.js). Ahead of the /api/ats routers, which gate on the
// calendar permission.
app.use('/api/ats/workers', require('./routes/atsWorkers'));
// Department -> Section -> TL -> Recruiter, the dependent filter tree (components/HierarchyFilter.jsx).
app.use('/api/ats/hierarchy', require('./routes/atsHierarchy'));
// The actual workflow with live counts per box (routes/atsWorkflow.js).
app.use('/api/ats/workflow', require('./routes/atsWorkflow'));
app.use('/api/ats', atsExtrasRoutes);
// Interviews & Joining (Interview Feedback, Offers, Joining, Internal Hiring)
// shares the /api/ats prefix with the calendar above.
app.use('/api/ats', interviewsJoiningRoutes);
// The AI Assistant (answers) and AI Agent (proposes, acts only on Confirm).
// One model wrapper behind both — utils/ai.js: local Ollama by default, Claude
// with AI_PROVIDER=claude, whose key stays in the encrypted credential store.
app.use('/api/assistant', assistantRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/hrms/dashboard', hrmsDashboardRoutes);
app.use('/api/hrms/escalation', escalationRoutes);
// hrms-24 §1/§3/§9 — dashboard charts and employee-data exports, every one
// scoped and dated in the query (routes/insights.js).
app.use('/api/insights', require('./routes/insights'));
// ATS: Export / Import / Template on every ATS module (routes/atsIo.js).
app.use('/api/ats-io', require('./routes/atsIo'));
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
// One read endpoint for any request on the approval chain (components/ApprovalChain.jsx).
app.use('/api/approvals', require('./routes/approvals'));
// Administration → System (Super Admin): backups, restore test, uptime alert (routes/system.js).
app.use('/api/system', require('./routes/system'));
app.use('/api/data-import', dataImportRoutes);
// Per-module export / sample / import + import requests (utils/moduleIo.js, src/io/*.js).
app.use('/api/io', require('./routes/dataIo'));
app.use('/api/positions', positionRoutes);
app.use('/api/agreement', agreementSealRoutes);
// B3 (2026-10-06): the candidate's offer letter link — public, by token (routes/offerLink.js).
app.use('/api/offer-link', require('./routes/offerLink'));
app.use('/api/recognition', employeeRecordRouter('RECOGNITION', { createRoles: true }));
// Rewards & Recognition -> NOMINATION (hrms-24 §13): Nominated -> Pending Review
// -> Approved / Rejected -> Awarded. Its own table; see routes/nominations.js.
app.use('/api/recognition-nominations', require('./routes/nominations'));
app.use('/api/disciplinary', employeeRecordRouter('DISCIPLINARY', { createRoles: true }));
app.use('/api/shift-roster', employeeRecordRouter('SHIFT', { denyHrmsRoles: ['TL'] }));
app.use('/api/timesheet', employeeRecordRouter('TIMESHEET'));
app.use('/api/assets', employeeRecordRouter('ASSET', { createRoles: true }));
// Expense & Travel Claims carry a real bill/receipt — the one record type with
// a stored attachment today (see backend/src/utils/attachments.js).
app.use('/api/expenses', employeeRecordRouter('EXPENSE', { attachments: true }));
app.use('/api/helpdesk', helpdeskRoutes);
// Company asset inventory (Employee Services → Assets). /api/assets above stays
// as the employee-raised asset *request* list, which feeds Asset Approval.
app.use('/api/asset-inventory', assetInventoryRoutes);
// Stationery / consumables (Employee Services → Stationery): counted items.
app.use('/api/stationery', require('./routes/stationery'));
app.use('/api/access-requests', employeeRecordRouter('ACCESS_REQUEST'));
// Weekly ideas keep the same EmployeeRecord store (type: 'WEEKLY_IDEA') but
// need AI duplicate screening and scoring on write, plus the quota and
// leaderboard reads Knowledge Transfer shows — so they have their own router
// rather than the generic one.
app.use('/api/weekly-ideas', weeklyIdeaRoutes);
app.use('/api/shift-patterns', shiftPatternRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  // A broken link to another record (Prisma P2003) is the caller's data, not a crash.
  if (err && err.code === 'P2003') {
    return res.status(400).json({ error: 'One of the linked records (client, person or position) no longer exists. Pick it again and retry.' });
  }
  return res.status(500).json({ error: 'Something went wrong' });
});

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => {
  console.log(`TeamLink API listening on http://localhost:${PORT}`);
  // Candidates list / Progress board: build their in-memory copy in the
  // background now, so the first page after a restart is fast. Off in the
  // sandbox unless CANDIDATE_WARMUP=1 (utils/candidateWarmup.js).
  require('./utils/candidateWarmup').start();
  // TEST SANDBOX: no background workers or timers at all (utils/sandbox.js).
  if (sandbox.isSandbox()) { sandbox.banner(PORT); return; }
  // The email sending worker. A no-op until Administration → Integrations has
  // an SMTP channel configured; MAIL_WORKER_INTERVAL_MS=0 switches it off.
  mailWorker.start();
  // The embedded Job Portal (/jobs): started here, kept running, adopted if
  // a nodemon restart left it up (utils/jobPortalEmbed.js).
  require('./utils/jobPortalEmbed').start();
  // Job Portal: a full sync 30s after boot, then hourly (JOB_PORTAL_SYNC_INTERVAL_MS).
  require('./utils/jobPortalBridge').startSchedule();
  // Codes sent but never entered for a day → HR is told (utils/employeeEmailVerification.js).
  require('./utils/employeeEmailVerification').startSweep();
  // Agreements: 30 / 7-day expiry-or-renewal reminders and EXPIRED after an
  // explicit end date — daily (utils/agreementLifecycle.js).
  require('./utils/agreementLifecycle').startExpirySweep();
  // Payroll -> Accounts: retries failed / queued journal syncs with backoff
  // (utils/payrollSync.js; PAYROLL_SYNC_SWEEP_MS, default 5 min, 0 = off).
  require('./utils/payrollSync').startSweep();
  // Attendance: late-login / missing-punch alerts for TODAY only, never
  // backfilled (utils/attendanceAlerts.js; ATTENDANCE_ALERTS_INTERVAL_MS, default 5 min, 0 = off).
  require('./utils/attendanceAlerts').startSweep();
  // Daily report e-mails (7 PM TL / weekly Manager) — does nothing until a
  // Super Admin switches them on; OFF by default (utils/dailyReportMail.js).
  require('./utils/dailyReportMail').startSweep();
  // Candidate portal logins idle for 12 months -> Archived (a new email code
  // re-opens them) — daily (utils/portalLogins.js, spec B2).
  require('./utils/portalLogins').startSweep();
  // ATS late-work escalation (owner → TL → Manager), every 15 min, IN-APP
  // only — does nothing until an Admin switches it on (utils/atsEscalation.js).
  require('./utils/atsEscalation').startSweep();
  // Interview reminders (day before / 1 hour before / feedback missing /
  // guarantee ending), every 15 min — OFF until an Admin switches it on
  // (utils/interviewNotices.js).
  require('./utils/interviewNotices').startSweep();
  // Daily backup of the database + upload folders, then a restore test, in a
  // child process (utils/backup.js; BACKUP_HOUR default 2, BACKUP_SCHEDULE=0 = off).
  require('./utils/backup').startSchedule();
});
// LMS course videos (up to 300 MB, utils/lmsMedia.js) arrive as ONE streamed
// request; Node's default 5-minute requestTimeout would cut a slow upload off.
server.requestTimeout = 30 * 60 * 1000;
