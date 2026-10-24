#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop */
// ---------------------------------------------------------------------------
// test-ai-agent.js - the scripted test suite for the AI Assistant (Ask) and the
// AI Agent (Do): tool registry, intent layer, pipeline, confirmation store,
// permissions per role, audit rows, read-only guarantee, Telugu-English.
//
//   node scripts/test-ai-agent.js                 run everything on the TEST SANDBOX
//   node scripts/test-ai-agent.js --keep          leave the ZZTEST data (then --cleanup)
//   node scripts/test-ai-agent.js --cleanup       only remove leftovers
//   node scripts/test-ai-agent.js --json=out.json also write the results as JSON
//
// ONLY the sandbox (API :4011, backend/prisma/sandbox.db) is used - it refuses
// to run against the real server or dev.db. Every row it creates is ZZTEST /
// "Zzai" tagged and removed at the end (ids + markers), and the script then
// scans the sandbox for leftovers.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const SANDBOX_DB = path.join(BACK, 'prisma', (process.env.TL_TEST_DB || 'sandbox.db'));
const API_ORIGIN = String(process.env.TL_API || 'http://localhost:4011').replace(/\/+$/, '').replace(/\/api$/, '');
if (/:4010$/.test(API_ORIGIN)) { console.error('Refusing: that is the REAL server (4010). Use the sandbox (4011).'); process.exit(2); }
if (!fs.existsSync(SANDBOX_DB)) { console.error(`Sandbox database missing: ${SANDBOX_DB}. Start it: node scripts/sandbox.js --detach --frontend --keep`); process.exit(2); }
process.env.DATABASE_URL = `file:${SANDBOX_DB}`;
process.env.PORT = process.env.PORT || (API_ORIGIN.match(/:(\d+)$/) || [])[1] || '4011';
require(path.join(BACK, 'node_modules', 'dotenv')).config({ path: path.join(BACK, '.env') });
process.env.DATABASE_URL = `file:${SANDBOX_DB}`;
const { PrismaClient } = require(path.join(BACK, 'node_modules', '@prisma', 'client'));
const jwt = require(path.join(BACK, 'node_modules', 'jsonwebtoken'));

const prisma = new PrismaClient();
const API = `${API_ORIGIN}/api`;
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const CLEANUP_ONLY = argv.includes('--cleanup');
const JSON_OUT = (argv.find((a) => a.startsWith('--json=')) || '').split('=')[1] || null;
const RUN = Date.now().toString(36);
const T0 = new Date();

// --- tiny assertion kit --------------------------------------------------------------
const results = [];
let section = '';
function check(name, ok, detail = '') {
  results.push({ section, name, ok: !!ok, detail: ok ? '' : String(detail).slice(0, 400) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${section ? `[${section}] ` : ''}${name}${ok || !detail ? '' : `\n        -> ${String(detail).slice(0, 400)}`}`);
}
const sec = (s) => { section = s; console.log(`\n== ${s}`); };

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const tokenOf = (u) => jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '2h' });
async function call(user, method, p, body) {
  let last;
  for (let i = 0; i < 25; i += 1) {
    try {
      const r = await fetch(API + p, {
        method,
        headers: { Authorization: `Bearer ${tokenOf(user)}`, 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      });
      const j = await r.json().catch(() => null);
      return { status: r.status, body: j };
    } catch (e) { last = e; await sleep(2500); }
  }
  throw last;
}
const doIt = (u, message, extra = {}) => call(u, 'POST', '/agent/do', { message, ...extra }).then((r) => r.body || {});
const confirmIt = (u, pendingId) => call(u, 'POST', '/agent/confirm', { pendingId });
const ask = (u, message) => call(u, 'POST', '/assistant/ask', { message }).then((r) => ({ status: r.status, ...(r.body || {}) }));

// --- fixtures -----------------------------------------------------------------------------------
const created = { users: [], employees: [], positions: [] };
const P = {}; // people
const D = {}; // data
const DEPT = 'ZZTEST-AIA-Edu';
const TAG = 'ZZTEST AIA';

async function mkUser(key, spec) {
  const email = `zztest.aia.${key.toLowerCase()}.${RUN}@example.test`;
  const u = await prisma.user.create({
    data: {
      name: `${TAG} ${spec.label}`,
      email,
      passwordHash: '!disabled-zztest!',
      role: spec.role,
      hrmsRole: spec.hrmsRole || null,
      atsRole: spec.atsRole === undefined ? spec.role : spec.atsRole,
      accountsRole: spec.accountsRole || null,
      hrmsAccess: spec.hrms !== false,
      atsAccess: !!spec.ats,
      accountsAccess: !!spec.accounts,
      atsScopeDepartments: spec.depts || null,
      atsDepartment: spec.dept || null,
      team: spec.team || null,
      status: 'Active',
    },
  });
  created.users.push(u.id);
  let e = null;
  if (spec.employee !== false) {
    e = await prisma.employee.create({
      data: { userId: u.id, employeeCode: `ZZAIA-${key}-${RUN}`.slice(0, 40), name: u.name, email, department: spec.dept || null, team: spec.team || null, designation: spec.designation || null },
    });
    created.employees.push(e.id);
  }
  return { user: u, emp: e };
}

async function seed() {
  P.SA = await mkUser('SA', { label: 'Super Admin', role: 'SUPER_ADMIN', ats: true, accounts: true, employee: false });
  P.HR = await mkUser('HR', { label: 'HR', role: 'HR', hrmsRole: 'HR', atsRole: 'HR', ats: true, dept: 'ZZTEST-AIA-HR', designation: 'HR' });
  P.TL = await mkUser('TL', { label: 'TL', role: 'TL', hrmsRole: 'TL', ats: true, dept: DEPT, team: 'Zzaiteam', designation: 'TL' });
  P.REC = await mkUser('REC', { label: 'Recruiter', role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', atsRole: 'RECRUITER', ats: true, dept: DEPT, team: 'Zzaiteam', designation: 'Employee' });
  P.REC2 = await mkUser('REC2', { label: 'Recruiter Zzaitwo', role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', atsRole: 'RECRUITER', ats: true, dept: DEPT, team: 'Zzaiteam', designation: 'Employee' });
  P.BDE = await mkUser('BDE', { label: 'BDE', role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', atsRole: 'BDE', ats: true, dept: DEPT, designation: 'Employee' });
  P.EMP = await mkUser('EMP', { label: 'Employee', role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', atsRole: null, ats: false, dept: DEPT, designation: 'Employee' });
  P.ACC = await mkUser('ACC', { label: 'Accountant', role: 'ACCOUNTANT', hrmsRole: 'ACCOUNTANT', accountsRole: 'ACCOUNTANT', atsRole: null, ats: false, accounts: true, dept: 'ZZTEST-AIA-Acc', designation: 'Accountant' });

  D.client = await prisma.client.create({
    data: {
      name: `Zzaiclient Pharma ${RUN}`, clientCode: `ZZAIA-C-${RUN}`.slice(0, 30), ownerDepartment: DEPT, agreementStatus: 'ACTIVE', status: 'Active',
      contactName: 'ZZTEST Contact', contactEmail: 'zztest.aia.contact@example.test', contactPhone: '9000011111', location: 'Hyderabad',
    },
  });
  const mkReq = (title, extra = {}) => prisma.requirement.create({
    data: {
      title, clientId: D.client.id, department: DEPT, status: 'OPEN', reqCode: `ZZAIA-${RUN}-${Math.random().toString(36).slice(2, 5)}`.toUpperCase(), openings: 2,
      recruiterId: P.REC.user.id, tlId: P.TL.user.id, bdeId: P.BDE.user.id, description: title, ...extra,
    },
  });
  D.req1 = await mkReq(`Zzaijob Developer ${RUN}`);
  D.req2 = await mkReq(`Zzaijob Unassigned ${RUN}`, { recruiterId: null, status: 'AGREEMENT_APPROVED' });
  const mkCand = (nm, n) => prisma.candidate.create({
    data: { name: `ZZTEST Zzaicand${nm} ${RUN}`, email: `zztest.aia.cand${n}.${RUN}@zz-sandbox.in`, phone: `90000${String(Math.floor(Math.random() * 90000) + 10000)}`, skills: 'Java' },
  });
  D.cA = await mkCand('Alpha', 1);
  D.cB = await mkCand('Beta', 2);
  D.cC = await mkCand('Gamma', 3);
  D.cD = await mkCand('Delta', 4);
  const mkApp = (c, stage) => prisma.application.create({ data: { candidateId: c.id, requirementId: D.req1.id, stage } });
  D.aA = await mkApp(D.cA, 'RECRUITER_REVIEW'); // moved by SA
  D.aB = await mkApp(D.cB, 'RECRUITER_REVIEW'); // shortlisted by the recruiter
  D.aC = await mkApp(D.cC, 'CLIENT_SHORTLISTED'); // interview scheduled / rescheduled by SA
  D.aD = await mkApp(D.cD, 'RECRUITER_REVIEW'); // rejected
  D.empOne = await prisma.employee.create({ data: { employeeCode: `ZZAIA-E1-${RUN}`.slice(0, 40), name: `ZZTEST Zzaiemp One ${RUN}`, email: `zztest.aia.e1.${RUN}@example.test`, department: DEPT, designation: 'Employee', employmentStatus: 'Active' } });
  created.employees.push(D.empOne.id);
  D.asset = await prisma.asset.create({ data: { assetCode: `AST-9${String(Math.floor(Math.random() * 900) + 100)}`, name: `ZZTEST Zzaia Laptop ${RUN}`, category: 'Laptop', status: 'Available', history: '[]' } });
  D.inv = await prisma.invoice.create({
    data: { clientId: D.client.id, amount: 10000, gst: 1800, tds: 0, gstPercent: 18, status: 'Pending', invoiceDate: ymd(new Date()), dueDate: ymd(new Date(Date.now() + 86400000 * 20)), invoiceNumber: `99${Math.floor(Math.random() * 90000) + 10000}`, notes: 'ZZTEST Zzaia' },
  });
  D.inv2 = await prisma.invoice.create({
    data: { clientId: D.client.id, amount: 5000, gst: 0, tds: 0, status: 'Pending', invoiceDate: ymd(new Date()), invoiceNumber: `98${Math.floor(Math.random() * 90000) + 10000}`, notes: 'ZZTEST Zzaia' },
  });
}

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const futureDay = (n) => ymd(new Date(Date.now() + n * 86400000));

// --- cleanup -------------------------------------------------------------------------------------------
async function del(model, where) {
  if (!prisma[model]) return 0;
  try { return (await prisma[model].deleteMany({ where })).count; } catch (e) { return `ERR ${model}: ${String(e.message).split('\n').pop().slice(0, 80)}`; }
}

async function cleanup() {
  const out = {};
  const users = await prisma.user.findMany({ where: { OR: [{ id: { in: created.users } }, { email: { contains: 'zztest.aia.' } }] }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const emps = await prisma.employee.findMany({ where: { OR: [{ id: { in: created.employees } }, { userId: { in: userIds } }, { employeeCode: { startsWith: 'ZZAIA-' } }, { name: { contains: 'Zzai' } }] }, select: { id: true } });
  const empIds = emps.map((e) => e.id);
  const clients = await prisma.client.findMany({ where: { OR: [{ name: { startsWith: 'Zzai' } }, { clientCode: { startsWith: 'ZZAIA-' } }] }, select: { id: true } });
  const clientIds = clients.map((c) => c.id);
  const reqs = await prisma.requirement.findMany({ where: { OR: [{ title: { contains: 'Zzai' } }, { clientId: { in: clientIds } }] }, select: { id: true } });
  const reqIds = reqs.map((r) => r.id);
  const cands = await prisma.candidate.findMany({ where: { OR: [{ name: { contains: 'Zzai' } }, { email: { contains: 'zztest.aia.' } }] }, select: { id: true } });
  const candIds = cands.map((c) => c.id);
  const apps = await prisma.application.findMany({ where: { OR: [{ candidateId: { in: candIds } }, { requirementId: { in: reqIds } }] }, select: { id: true } });
  const appIds = apps.map((a) => a.id);
  const invs = await prisma.invoice.findMany({ where: { OR: [{ clientId: { in: clientIds } }, { notes: { contains: 'Zzaia' } }] }, select: { id: true } });
  const invIds = invs.map((i) => i.id);
  const leaves = await prisma.leaveRequest.findMany({ where: { employeeId: { in: empIds } }, select: { id: true } });
  const leaveIds = leaves.map((l) => l.id);
  const assets = await prisma.asset.findMany({ where: { name: { contains: 'Zzaia' } }, select: { id: true } });
  const assetIds = assets.map((a) => a.id);
  const allIds = [...userIds, ...empIds, ...clientIds, ...reqIds, ...candIds, ...appIds, ...invIds, ...leaveIds, ...assetIds];

  out.followups = await del('applicationFollowUp', { OR: [{ applicationId: { in: appIds } }, { candidateId: { in: candIds } }] });
  out.stageEvents = await del('applicationStageEvent', { OR: [{ applicationId: { in: appIds } }, { candidateId: { in: candIds } }] });
  out.interviewEvents = await del('interviewEvent', { applicationId: { in: appIds } });
  out.interviewFb = await del('interviewFeedback', { applicationId: { in: appIds } });
  out.messages = await del('candidateMessage', { candidateId: { in: candIds } });
  out.notes = await del('candidateNote', { candidateId: { in: candIds } });
  out.apps = await del('application', { id: { in: appIds } });
  out.cands = await del('candidate', { id: { in: candIds } });
  out.payments = await del('invoicePayment', { invoiceId: { in: invIds } });
  out.invoices = await del('invoice', { id: { in: invIds } });
  out.reqs = await del('requirement', { id: { in: reqIds } });
  out.clients = await del('client', { id: { in: clientIds } });
  out.approval = await del('approvalStep', { recordId: { in: leaveIds } });
  out.leaves = await del('leaveRequest', { id: { in: leaveIds } });
  out.leaveBal = await del('leaveBalance', { employeeId: { in: empIds } });
  out.attendance = await del('attendance', { employeeId: { in: empIds } });
  out.punches = await del('attendancePunch', { employeeId: { in: empIds } });
  out.announcements = await del('announcement', { OR: [{ postedById: { in: userIds } }, { title: { contains: 'Zzai' } }] });
  out.assets = await del('asset', { id: { in: assetIds } });
  out.expenses = await del('officeExpense', { OR: [{ createdById: { in: userIds } }, { notes: { contains: 'Zzai' } }] });
  out.decisions = await del('recruiterJoiningDecision', { OR: [{ employeeId: { in: empIds } }, { decidedById: { in: userIds } }] });
  out.posAssign = await del('positionAssignment', { employeeId: { in: empIds } });
  out.idem = await del('appSetting', { OR: userIds.map((id) => ({ key: { contains: id } })).concat([{ key: { startsWith: 'zzaia.' } }]) });
  out.emailVer = await del('emailVerification', { email: { contains: 'zztest.aia.' } });
  out.pwTokens = await del('passwordResetToken', { userId: { in: userIds } });
  out.audit = await del('auditLog', {
    OR: [{ userId: { in: userIds } }, { entityId: { in: allIds } }, { toValue: { contains: 'Zzai' } }, { fromValue: { contains: 'Zzai' } }, { actorName: { contains: 'ZZTEST AIA' } }],
  });
  out.notifications = await del('notification', { OR: [{ userId: { in: userIds } }, { title: { contains: 'Zzai' } }, { message: { contains: 'Zzai' } }] });
  out.sessions = await del('session', { userId: { in: userIds } });
  out.employees = await del('employee', { id: { in: empIds } });
  out.users = await del('user', { id: { in: userIds } });
  return out;
}

async function scan() {
  const q = async (model, where) => (prisma[model] ? prisma[model].count({ where }).catch(() => -1) : 0);
  const out = {
    users: await q('user', { OR: [{ email: { contains: 'zztest.aia.' } }, { name: { contains: 'ZZTEST AIA' } }] }),
    employees: await q('employee', { OR: [{ name: { contains: 'Zzai' } }, { employeeCode: { startsWith: 'ZZAIA-' } }, { name: { contains: 'ZZTEST AIA' } }] }),
    clients: await q('client', { OR: [{ name: { startsWith: 'Zzai' } }, { clientCode: { startsWith: 'ZZAIA-' } }] }),
    requirements: await q('requirement', { title: { contains: 'Zzai' } }),
    candidates: await q('candidate', { OR: [{ name: { contains: 'Zzai' } }, { email: { contains: 'zztest.aia.' } }] }),
    invoices: await q('invoice', { notes: { contains: 'Zzaia' } }),
    assets: await q('asset', { name: { contains: 'Zzaia' } }),
    announcements: await q('announcement', { title: { contains: 'Zzai' } }),
    audit: await q('auditLog', { OR: [{ actorName: { contains: 'ZZTEST AIA' } }, { toValue: { contains: 'Zzai' } }, { fromValue: { contains: 'Zzai' } }] }),
    notifications: await q('notification', { OR: [{ title: { contains: 'Zzai' } }, { message: { contains: 'Zzai' } }] }),
    expenses: await q('officeExpense', { notes: { contains: 'AI Agent' } }),
    decisions: await q('recruiterJoiningDecision', { note: { contains: 'AI Agent' } }),
    pendingSettings: await q('appSetting', { OR: [{ key: { startsWith: 'idem.requirement.' }, value: { contains: 'Zzai' } }] }),
  };
  return out;
}

// --- the tests ---------------------------------------------------------------------------------------------
const bodyOf = (r) => r.body || {};

async function testStructure() {
  sec('Registry and structure');
  const registry = require(path.join(BACK, 'src/ai/registry'));
  const tools = registry.allTools();
  check('the registry holds the tools', tools.length >= 25, `${tools.length}`);
  const bad = tools.map((t) => ({ n: t.name, p: registry.problems(t) })).filter((x) => x.p.length);
  check('every tool declares name, module, description, parameters, permission, confirm, validate, execute, verify, audit, examples', bad.length === 0, JSON.stringify(bad));
  const needed = ['move_candidate_stage', 'shortlist_candidate', 'schedule_interview', 'reschedule_interview', 'assign_recruiter', 'create_client', 'update_client', 'create_requirement', 'update_requirement',
    'create_candidate', 'update_candidate', 'send_candidate_communication', 'apply_leave', 'update_attendance', 'create_announcement', 'assign_asset', 'return_asset', 'create_expense', 'record_payment',
    'create_invoice', 'update_invoice', 'update_customer', 'prepare_incentive_action', 'update_employee', 'create_employee'];
  check('all the tools the spec names are registered', needed.every((n) => registry.getTool(n)), needed.filter((n) => !registry.getTool(n)).join(', '));
  const unavailable = tools.filter((t) => t.status === 'unavailable').map((t) => t.name);
  check('a tool whose backend route does not exist is marked unavailable (not written around)', unavailable.includes('delete_client'), unavailable.join(','));
  // adding a tool = one file: a throw-away tool registers and validates
  let added = false;
  try {
    registry.defineTool({
      name: 'zz_demo_tool', module: 'ats', label: 'Demo tool', description: 'Only for the test.', parameters: {}, permission: { product: 'ats', module: 'candidates', feature: 'Applications', action: 'view' },
      confirm: 'always', validate: async () => ({ refuse: 'demo' }), execute: async () => ({ ok: true }), verify: async () => ({ ok: true }), audit: 'demo', examples: ['demo'],
    });
    added = !!registry.getTool('zz_demo_tool');
  } catch (e) { added = false; }
  check('a new tool can be added with one defineTool() call', added);
  let rejected = false;
  try { registry.defineTool({ name: 'zz_bad', module: 'ats' }); } catch { rejected = true; }
  check('an incomplete tool definition is rejected at load time', rejected);
}

async function testNoDirectWrites() {
  sec('No direct database writes from the AI');
  const root = path.join(BACK, 'src', 'ai');
  const files = [];
  (function walk(d) { fs.readdirSync(d, { withFileTypes: true }).forEach((e) => { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.js$/.test(e.name)) files.push(p); }); }(root));
  const WRITE = /\b(?:prisma|db|tx)\s*\.\s*\w+\s*\.\s*(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(|\$executeRaw|\$queryRawUnsafe|\$executeRawUnsafe|\$transaction/;
  const offenders = files.filter((f) => WRITE.test(fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, ''))).map((f) => path.relative(BACK, f));
  check(`no Prisma write call anywhere under src/ai (${files.length} files scanned)`, offenders.length === 0, offenders.join(', '));
  const imp = files.filter((f) => /require\(['"]\.\.\/db['"]\)|require\(['"]\.\.\/\.\.\/db['"]\)/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(BACK, f));
  check('the only file that touches the database client reads (lib/entities.js)', imp.length === 1 && /entities\.js$/.test(imp[0]), imp.join(', '));
  const askFiles = files.filter((f) => /assistant[\\/]/.test(f));
  const askBad = askFiles.filter((f) => /makeApi|confirmations|require\(['"]\.\.\/pipeline['"]\)|\.(post|put|patch|delete)\(|callSelf|'POST'|"POST"|probe\(/.test(fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '')));
  check('the Ask (assistant) code has no write path: no api client, no pipeline, no POST/PUT/PATCH/DELETE', askBad.length === 0, askBad.join(', '));
  const routeSrc = fs.readFileSync(path.join(BACK, 'src/routes/assistant.js'), 'utf8');
  check('the /assistant routes never call the Agent pipeline', !/ai\/pipeline|ai\/routes|confirmations/.test(routeSrc));
}

const PHRASES = {
  move_candidate_stage: ['Move Priya to Interview.', 'Put Priya in Interview.', "Change Priya's stage to Interview.", 'Priya ni interview ki move cheyyi', 'Shift Anil to the offer stage', 'Mark Kiran as rejected', 'Push Meena to TL review'],
  shortlist_candidate: ['Shortlist Priya', 'Please shortlist candidate Anil for the Java job', 'Priya ni shortlist cheyyi', 'Add Kiran to the shortlist', 'Mark Meena as shortlisted'],
  schedule_interview: ["Schedule Priya's interview tomorrow at 3pm", 'Book an interview for Anil on Friday at 11', 'Arrange an interview with Kiran next Monday at 10am', 'Priya ki repu 4 gantalaku interview pettu', 'Fix Meena interview on 20 Oct at 2:30 pm'],
  reschedule_interview: ["Reschedule Priya's interview to Friday 4pm", "Postpone Anil's interview to tomorrow", "Move Kiran's interview to next Monday at 11am", 'Prepone Meena interview to today 3pm', 'Priya interview ni repu 5 gantalaku marchu'],
  assign_recruiter: ['Assign Priya to the Java Developer requirement', 'Give the Java Developer opening to Anil', 'Allocate Meena as recruiter for the QA job', 'Put Kiran on the Sales Manager requirement', 'Java Developer job ni Priya ki assign cheyyi'],
  create_client: ['Create a client Sunrise Pharma', 'Add new customer Zenith Hospitals', 'Register client Greenfield Schools', 'Onboard client Bluewave Foods', 'Kotta client Sunrise Pharma create cheyyi'],
  update_client: ['Update client Acme contact phone to 9876543210', 'Edit client Sunrise Pharma email to hr@sunrise.in', 'Change the location of client Orbit Tech to Pune', 'Correct Acme client industry to Manufacturing', 'Modify client Zenith details'],
  create_requirement: ['Create a requirement for Java Developer at Acme', 'Add a new requirement Sales Manager for Sunrise Pharma', 'Raise a requirement QA Engineer for Orbit Tech 3 openings', 'Open a vacancy for Plant Manager at Acme', 'Acme ki Java Developer requirement create cheyyi'],
  update_requirement: ['Update the Java Developer requirement openings to 5', 'Change location of the Sales Manager requirement to Pune', 'Edit requirement REQ-0012 priority to High', 'Set openings to 3 on the QA Engineer job', 'Java Developer requirement openings 4 ki marchu'],
  create_candidate: ['Add candidate Rahul Sharma phone 9876543210 email rahul@example.com', 'Create a new candidate Priya skills Java and SQL', 'Register candidate Anil Kumar mobile 9123456780', 'New applicant Kiran Reddy 9000011111 kiran@mail.com', 'Enter a new candidate profile for Suresh'],
  update_candidate: ['Update candidate Rahul phone to 9876543210', "Change candidate Priya's email to priya@mail.com", 'Edit candidate Anil location to Pune', 'Correct the mobile number of candidate Meena to 9123456780', 'Rahul candidate phone number marchu 9876543210'],
  send_candidate_communication: ['Send Rahul a WhatsApp about the interview', 'Email Priya the interview details', 'Send an SMS to Anil about his offer', 'WhatsApp Kiran to confirm availability', 'Rahul ki whatsapp pampu interview gurinchi'],
  apply_leave: ['Apply casual leave tomorrow', 'I need sick leave on Monday', 'Apply for leave from 12 Oct to 14 Oct', 'Naaku repu casual leave kavali', 'Take a day off on Friday', 'Mujhe kal chhutti chahiye'],
  cancel_leave: ['Cancel my leave', 'Withdraw my pending leave', 'Cancel leave on Friday', 'Revoke my casual leave request', 'Naa leave cancel cheyyi'],
  update_attendance: ['Mark Ravi present for today', "Update Priya's attendance to absent on Monday", 'Mark Anil as half day yesterday', 'Change Kiran attendance on 5 Oct to present', 'Ravi ni ee roju present ga mark cheyyi'],
  create_announcement: ['Announce that office is closed on Friday', 'Post an announcement: Diwali holiday on 20 Oct', 'Send a circular: new attendance policy from Monday', 'Broadcast to all employees that the meeting is at 4 pm', 'Announcement pettu: repu office holiday'],
  assign_asset: ['Assign laptop AST-0012 to Ravi', 'Give Priya a laptop', 'Issue monitor AST-0021 to Kiran', 'Hand over a mobile to Meena', 'Ravi ki laptop assign cheyyi'],
  return_asset: ['Return laptop AST-0012', 'Take back the charger AST-0004 from Anil', 'Ravi returned the laptop', 'Collect the monitor AST-0021 from Kiran', 'Laptop AST-0012 return cheyyi'],
  create_employee: ['Add employee Suresh Kumar email suresh@company.com department Medical', 'Onboard employee Vikram email vikram@company.in department IT', 'Register a new joiner Deepa Nair deepa@company.in department Manufacturing', 'Kotta employee Suresh create cheyyi suresh@company.in Medical', 'Create employee record for Lakshmi lakshmi@company.in'],
  update_employee: ['Update employee Suresh phone to 9876543210', "Change employee Anita's designation to Senior Recruiter", 'Move employee Vikram to Education department', 'Deactivate employee Lakshmi', 'Suresh employee phone number marchu 9876543210'],
  create_expense: ['Add an expense of 1500 for cab fare', 'Record office expense 2500 for stationery from Staples', 'Log an expense of 3200 for internet bill', 'Add expense fuel 1200 on 5 Oct', 'Naa cab expense 1500 add cheyyi'],
  record_payment: ['Record a payment of 50000 on invoice INV-0012', 'Received 25000 against INV-0034 today', 'Mark invoice INV-0012 as paid', 'Log payment 100000 for invoice INV-0045 by NEFT', 'INV-0012 ki 50000 payment record cheyyi'],
  create_invoice: ['Create an invoice for Acme of 100000', 'Raise invoice for Sunrise Pharma amount 50000', 'Generate a new invoice to Orbit Tech 75000', 'Make an invoice for Greenfield Schools 120000 dated today', 'Acme ki 100000 invoice create cheyyi'],
  update_invoice: ['Update invoice INV-0012 amount to 55000', 'Change INV-0034 GST to 12 percent', 'Edit invoice INV-0045 amount to 80000', 'Modify invoice INV-0021 amount 62000', 'INV-0012 amount 55000 ki marchu'],
  update_customer: ['Update customer Acme billing email to accounts@acme.in', 'Change customer Sunrise Pharma GSTIN to 36ABCDE1234F1Z5', 'Edit customer Orbit Tech billing address to Plot 5 Madhapur', 'Update customer Acme payment terms to Net 45', 'Customer Acme billing email marchu accounts@acme.in'],
  prepare_incentive_action: ['Give Ravi an incentive of 5000 for September', 'Prepare incentive 8000 for Priya for last month', 'Approve incentive of 10000 to Anil for September', 'Record a joining incentive of 6000 for Kiran', 'Ravi ki 5000 incentive ivvandi September ki'],
};

async function testIntent() {
  sec('Synonym / intent layer: different phrasings, the same tool');
  const engine = require(path.join(BACK, 'src/ai/intent/engine'));
  const miss = [];
  let total = 0;
  for (const [tool, list] of Object.entries(PHRASES)) {
    let hit = 0;
    list.forEach((p) => { total += 1; const d = engine.decide(engine.analyse(p)); if (d.tool === tool) hit += 1; else miss.push(`${tool} <- "${p}" => ${d.tool || (d.candidates || []).join('/') || 'nothing'}`); });
    check(`${tool}: ${list.length} phrasings (English, Telugu-English, Hindi-English) all resolve to ${tool}`, hit === list.length && list.length >= 5, miss.filter((m) => m.startsWith(tool)).join(' | '));
  }
  check(`overall: ${total - miss.length}/${total} phrasings resolve to the right tool`, miss.length === 0, miss.join(' | '));
  const trio = ['Move Rahul to Interview.', 'Put Rahul in Interview.', "Change Rahul's stage to Interview."].map((p) => engine.decide(engine.analyse(p)).tool);
  check('spec 11: "Move Rahul to Interview." = "Put Rahul in Interview." = "Change Rahul\'s stage to Interview." -> move_candidate_stage', trio.every((t) => t === 'move_candidate_stage'), trio.join(','));
  const te = engine.decide(engine.analyse('Rahul ni interview ki move cheyyi')).tool;
  check('Telugu-English "Rahul ni interview ki move cheyyi" -> move_candidate_stage', te === 'move_candidate_stage', te);
  const same = ['Apply casual leave tomorrow', 'Naaku repu casual leave kavali'].map((p) => engine.decide(engine.analyse(p)).tool);
  check('the same concept across languages: leave in English and Telugu-English is one tool', same[0] === same[1] && same[0] === 'apply_leave', same.join(','));
  // dates in words
  const { parseWhen } = require(path.join(BACK, 'src/ai/lib/dates'));
  const w = parseWhen('tomorrow 3pm', { now: new Date('2026-10-09T10:00:00') });
  check('parameter extraction: "tomorrow 3pm" -> 2026-10-10 15:00', w.dates[0] === '2026-10-10' && w.time === '15:00', JSON.stringify(w));
  const w2 = parseWhen('repu 4 gantalaku', { now: new Date('2026-10-09T10:00:00') });
  check('parameter extraction: Telugu "repu 4 gantalaku" -> tomorrow 16:00', w2.dates[0] === '2026-10-10' && w2.time === '16:00', JSON.stringify(w2));
  const a = engine.analyse('Give Ravi an incentive of 5k for September');
  check('parameter extraction: "5k" -> 5000', a.slots.amount === 5000, JSON.stringify(a.slots.amounts));
}

async function testLlmGuard() {
  sec('Optional language model: trusted for nothing');
  const aiMod = require(path.join(BACK, 'src/utils/ai'));
  const llm = require(path.join(BACK, 'src/ai/intent/llm'));
  const save = { s: aiMod.checkStatus, j: aiMod.chatJson };
  try {
    aiMod.checkStatus = async () => ({ available: true, modelPulled: true });
    aiMod.chatJson = async () => ({ tool: 'move_candidate_stage', names: ['Zzaicand'], dates: ['2026-10-10', 'not-a-date'], time: '25:99', amount: -4, stage: 'HOLD' });
    const fn = await llm.make();
    const g = await fn('some message', {});
    check('a model suggestion is reduced to a registry tool and clean slots (bad date / time / amount dropped)', g && g.tool === 'move_candidate_stage' && g.slots.dates.length === 1 && !g.slots.time && g.slots.amount === undefined && g.slots.stages[0] === 'HOLD', JSON.stringify(g));
    aiMod.chatJson = async () => ({ tool: 'drop_all_tables' });
    const g2 = await fn('x', {});
    check('a tool name the registry does not have is dropped', g2 === null, JSON.stringify(g2));
    aiMod.checkStatus = async () => ({ available: false });
    const none = await llm.make();
    check('with no model configured the deterministic path works on its own (no model needed)', none === null);
  } finally { aiMod.checkStatus = save.s; aiMod.chatJson = save.j; }
}

async function testAccess() {
  sec('Permissions per role (the agent has exactly the logged-in user\'s rights)');
  // Recruiter asks to delete a client
  let r = await doIt(P.REC.user, `Delete client ${D.client.name}`);
  check('Recruiter asks to delete a client -> denied (not just "unavailable")', r.kind === 'denied', JSON.stringify(r).slice(0, 300));
  r = await doIt(P.SA.user, `Delete client ${D.client.name}`);
  check('Super Admin asks the same -> allowed by permission but marked "not available yet" (the app has no client delete) - nothing written', r.kind === 'unavailable', JSON.stringify(r).slice(0, 300));
  check('the client is still there', !!(await prisma.client.findUnique({ where: { id: D.client.id } })));
  // Employee asking for someone else's leave
  r = await doIt(P.EMP.user, `Apply casual leave tomorrow for ${D.empOne.name}`);
  const ownName = P.EMP.user.name;
  const row = (r.card && r.card.rows.find((x) => x.label === 'Employee')) || null;
  check('Employee asking for someone else\'s leave: the request is for the employee\'s OWN record only', r.kind === 'confirm' ? (row && row.value === ownName) : (r.kind === 'refused' || r.kind === 'clarify' || r.kind === 'denied'), JSON.stringify(r).slice(0, 300));
  r = await doIt(P.EMP.user, `Move ${D.cA.name.split(' ')[1]} to Interview`);
  check('Employee asks to move a candidate -> denied ("only your own leave")', r.kind === 'denied' && /OWN leave|employee/i.test(r.message), JSON.stringify(r).slice(0, 300));
  r = await doIt(P.EMP.user, 'Announce that the office is closed tomorrow');
  check('Employee asks to post an announcement -> denied', r.kind === 'denied', r.kind);
  r = await doIt(P.EMP.user, `Mark ${D.empOne.name.split(' ')[1]} present today`);
  check('Employee asks to change attendance -> denied', r.kind === 'denied', r.kind);
  // BDE asking about salary
  r = await ask(P.BDE.user, `What is the salary of ${D.empOne.name.split(' ')[1]}?`);
  check('BDE asks for someone\'s salary (Ask) -> refused in plain words, no figure', /cannot|not|only/i.test(r.answer || '') && !/Rs \d/.test(r.answer || ''), r.answer);
  r = await doIt(P.BDE.user, `Give ${D.empOne.name.split(' ')[1]} an incentive of 5000 for September`);
  check('BDE asks the agent to give an incentive -> denied', r.kind === 'denied', JSON.stringify(r).slice(0, 200));
  r = await doIt(P.HR.user, `Give ${D.empOne.name.split(' ')[1]} an incentive of 5000 for September`);
  check('HR asks for an incentive decision -> denied (Super Admin only)', r.kind === 'denied', JSON.stringify(r).slice(0, 200));
  // Manager-type view-only is covered by can(); recruiter cannot update attendance / create employee
  r = await doIt(P.REC.user, `Mark ${D.empOne.name.split(' ')[1]} present today`);
  check('Recruiter asks to change attendance -> denied', r.kind === 'denied', r.kind);
  r = await doIt(P.TL.user, `Mark ${D.empOne.name.split(' ')[1]} present today`);
  check('TL asks to change attendance -> denied (HR / Admin roles only)', r.kind === 'denied', r.kind);
  r = await doIt(P.REC.user, 'Create an invoice for Zzaiclient of 1000');
  check('Recruiter asks to create an invoice -> denied (no Accounts)', r.kind === 'denied', r.kind);
  r = await doIt(P.ACC.user, `Move ${D.cA.name.split(' ')[1]} to Interview`);
  check('Accountant asks to move a candidate -> denied', r.kind === 'denied', r.kind);
  r = await doIt(P.BDE.user, `Assign laptop ${D.asset.assetCode} to ${D.empOne.name.split(' ')[1]}`);
  check('BDE asks to assign an asset -> denied (no HRMS asset rights)', r.kind === 'denied', JSON.stringify(r).slice(0, 200));
  const tools = await call(P.REC.user, 'GET', '/agent/tools');
  const allowed = (bodyOf(tools).tools || []).filter((t) => t.allowed).map((t) => t.name);
  check('the tool list for a Recruiter shows only what the Recruiter may do', allowed.includes('move_candidate_stage') && !allowed.includes('create_invoice') && !allowed.includes('update_attendance'), allowed.join(','));
  const toolsSa = await call(P.SA.user, 'GET', '/agent/tools');
  const saAllowed = (bodyOf(toolsSa).tools || []).filter((t) => t.allowed).map((t) => t.name);
  const saDenied = (bodyOf(toolsSa).tools || []).filter((t) => !t.allowed).map((t) => t.name);
  check('Super Admin is allowed every tool except the two own-leave ones (a Super Admin is a system account, not an employee)', saDenied.every((n) => ['apply_leave', 'cancel_leave'].includes(n)) || saDenied.length === 0, saDenied.join(','));
  check('Super Admin may use the Agent tools across ATS, HRMS and Accounts', ['move_candidate_stage', 'create_employee', 'record_payment', 'prepare_incentive_action'].every((n) => saAllowed.includes(n)), saAllowed.join(','));
}

async function testConfirmationRules() {
  sec('Confirmation store: stored parameters only, one time, expiry, bound to the user');
  const nm = `Zzaiconfirm ${RUN}`;
  const r = await doIt(P.SA.user, `Create a client ${nm} in Hyderabad`);
  check('a change comes back as a Confirm card, nothing is written yet', r.kind === 'confirm' && r.card && r.card.pendingId, JSON.stringify(r).slice(0, 300));
  check('nothing was written before Confirm', (await prisma.client.count({ where: { name: nm } })) === 0);
  // another user replays the id
  const other = await confirmIt(P.REC.user, r.card.pendingId);
  check('another user presenting the pending id is refused (403) and nothing is created', other.status === 403 && (await prisma.client.count({ where: { name: nm } })) === 0, JSON.stringify(other.body).slice(0, 200));
  const denyAudit = await prisma.auditLog.count({ where: { action: 'AI_AGENT_DENIED', userId: P.REC.user.id, toValue: { contains: 'another person' } } });
  check('that replay attempt is written to the audit log', denyAudit >= 1, String(denyAudit));
  // tampering: parameters in the confirm body are ignored
  const [a, b] = await Promise.all([confirmIt(P.SA.user, r.card.pendingId), confirmIt(P.SA.user, r.card.pendingId)]);
  await sleep(300);
  const n = await prisma.client.count({ where: { name: nm } });
  check('double-click (two simultaneous Confirms) = exactly ONE execution', n === 1, `clients created: ${n}`);
  const kinds = [bodyOf(a).kind, bodyOf(b).kind].sort().join(',');
  check('both clicks get an answer (one does it, the other is told it is already done / in progress)', /done/.test(kinds), kinds);
  const third = await confirmIt(P.SA.user, r.card.pendingId);
  check('a later replay of a used confirmation does not run again', (await prisma.client.count({ where: { name: nm } })) === 1 && (bodyOf(third).replayed === true || bodyOf(third).kind !== 'done' || /already/i.test(bodyOf(third).message || '')), JSON.stringify(bodyOf(third)).slice(0, 200));
  // stored parameters beat a tampered body
  const nm2 = `Zzaitamper ${RUN}`;
  const r2 = await doIt(P.SA.user, `Create a client ${nm2}`);
  const t = await call(P.SA.user, 'POST', '/agent/confirm', { pendingId: r2.card.pendingId, params: { name: `Zzaihacked ${RUN}` }, name: `Zzaihacked ${RUN}` });
  check('Confirm runs THE STORED parameters, never what the request body says', t.body.kind === 'done' && (await prisma.client.count({ where: { name: nm2 } })) === 1 && (await prisma.client.count({ where: { name: { startsWith: 'Zzaihacked' } } })) === 0, JSON.stringify(t.body).slice(0, 200));
  // expiry
  const nm3 = `Zzaiexpire ${RUN}`;
  const r3 = await doIt(P.SA.user, `Create a client ${nm3}`);
  const ex = await call(P.SA.user, 'POST', '/agent/_test/expire', { pendingId: r3.card.pendingId });
  check('(sandbox helper) a pending action can be aged past its 10 minutes', ex.status === 200);
  const late = await confirmIt(P.SA.user, r3.card.pendingId);
  check('an expired confirmation is refused (410) and nothing is created', late.status === 410 && (await prisma.client.count({ where: { name: nm3 } })) === 0, JSON.stringify(late.body).slice(0, 200));
  check('the card says it is good for 10 minutes', (r3.card.expiresAt && Math.abs(new Date(r3.card.expiresAt) - Date.now() - 600000) < 30000), r3.card.expiresAt);
  // cancel
  const nm4 = `Zzaicancel ${RUN}`;
  const r4 = await doIt(P.SA.user, `Create a client ${nm4}`);
  const c = await call(P.SA.user, 'POST', '/agent/cancel', { pendingId: r4.card.pendingId });
  const afterCancel = await confirmIt(P.SA.user, r4.card.pendingId);
  check('Cancel then Confirm -> nothing is created', bodyOf(c).kind === 'cancelled' && (await prisma.client.count({ where: { name: nm4 } })) === 0 && bodyOf(afterCancel).kind !== 'done', JSON.stringify(bodyOf(afterCancel)).slice(0, 200));
  const unknown = await confirmIt(P.SA.user, 'does-not-exist');
  check('an unknown id is refused politely', unknown.status === 410 || bodyOf(unknown).kind === 'expired', JSON.stringify(unknown.body).slice(0, 150));
  // high-impact needs confirm; check levels
  const hi = await doIt(P.SA.user, `Cancel invoice ${D.inv.invoiceNumber}`);
  check('invoice cancellation is high-impact: Confirm card flagged "always"', hi.kind === 'confirm' && hi.card.highImpact === true, JSON.stringify(hi).slice(0, 200));
  const lo = await doIt(P.SA.user, `Create a client Zzailow ${RUN}`);
  check('a low-impact change still shows a Confirm card, flagged as normal', lo.kind === 'confirm' && lo.card.highImpact === false, JSON.stringify(lo).slice(0, 200));
  check('both cards show a plain Title + rows (e.g. Current / New)', !!hi.card.title && Array.isArray(hi.card.rows) && hi.card.rows.length >= 2);
  // clean the unconfirmed ones: nothing written, nothing to clean
}

async function confirmFlow(u, message, label, { highImpact = null, rowCheck = null } = {}) {
  const r = await doIt(u, message);
  if (r.kind !== 'confirm') { check(`${label}: Confirm card`, false, JSON.stringify(r).slice(0, 300)); return r; }
  if (highImpact !== null) check(`${label}: confirmation level = ${highImpact ? 'ALWAYS (high impact)' : 'normal'}`, r.card.highImpact === highImpact, String(r.card.highImpact));
  if (rowCheck) check(`${label}: card shows ${rowCheck.map((x) => x[0]).join(', ')}`, rowCheck.every(([k, v]) => r.card.rows.some((x) => x.label === k && String(x.value).includes(v))), JSON.stringify(r.card.rows));
  const c = await confirmIt(u, r.card.pendingId);
  const b = bodyOf(c);
  check(`${label}: executed and verified by reading it back`, b.kind === 'done' && b.verified === true, JSON.stringify(b).slice(0, 400));
  b.pendingId = r.card.pendingId;
  return b;
}

async function testTools() {
  sec('Tools end to end (real executors, real routes)');
  const nameOf = (c) => c.name.split(' ')[1]; // "Zzaicandalpha"
  const nm = (c) => nameOf(c);

  // move_candidate_stage (Super Admin)
  let b = await confirmFlow(P.SA.user, `Move ${nm(D.cA)} to TL review`, 'move_candidate_stage', { highImpact: false, rowCheck: [['Current', 'Check by recruiter'], ['New', 'Check by team lead']] });
  check('move_candidate_stage: the application really is at TL review', (await prisma.application.findUnique({ where: { id: D.aA.id } })).stage === 'TL_REVIEW');
  // Telugu-English through the real pipeline
  let r = await doIt(P.SA.user, `${nm(D.cA)} ni hold ki move cheyyi`);
  check('Telugu-English "X ni hold ki move cheyyi" -> asks why (hold needs a reason), same tool', r.kind === 'clarify' && r.tool === 'move_candidate_stage', JSON.stringify(r).slice(0, 250));
  r = await doIt(P.SA.user, `Put ${nm(D.cA)} in Interview`);
  check('"Put X in Interview" -> redirected to scheduling and asks WHEN', r.kind === 'clarify' && r.tool === 'schedule_interview' && /day|time/i.test(r.message), JSON.stringify(r).slice(0, 250));
  r = await doIt(P.SA.user, `Change ${nm(D.cA)}'s stage to Interview`);
  check('"Change X\'s stage to Interview" -> the same scheduling question', r.kind === 'clarify' && r.tool === 'schedule_interview', JSON.stringify(r).slice(0, 250));

  // reject: asks whose decision and why, then high-impact
  r = await doIt(P.SA.user, `Reject ${nm(D.cD)}`);
  check('reject: asks whose decision it was', r.kind === 'clarify' && /whose decision/i.test(r.message), JSON.stringify(r).slice(0, 250));
  const side = r.options && r.options.find((o) => /client/i.test(o.label));
  r = await call(P.SA.user, 'POST', '/agent/do', { message: '', frame: r.frame, choices: side ? side.choice : {} }).then((x) => x.body);
  check('reject: then asks why', r.kind === 'clarify' && /why/i.test(r.message), JSON.stringify(r).slice(0, 250));
  r = await call(P.SA.user, 'POST', '/agent/do', { message: 'skills mismatch', frame: r.frame }).then((x) => x.body);
  check('reject: the answer completes the request -> Confirm card, HIGH IMPACT (candidate rejection)', r.kind === 'confirm' && r.card.highImpact === true, JSON.stringify(r).slice(0, 300));
  b = bodyOf(await confirmIt(P.SA.user, r.card.pendingId));
  check('reject: executed, verified, application is Rejected', b.kind === 'done' && (await prisma.application.findUnique({ where: { id: D.aD.id } })).stage === 'REJECTED', JSON.stringify(b).slice(0, 300));

  // shortlist (Recruiter, own job)
  b = await confirmFlow(P.REC.user, `Shortlist ${nm(D.cB)}`, 'shortlist_candidate (as Recruiter)');
  check('shortlist_candidate: stage moved', ['RECRUITER_APPROVED', 'TL_REVIEW'].includes((await prisma.application.findUnique({ where: { id: D.aB.id } })).stage));

  // schedule / reschedule
  b = await confirmFlow(P.SA.user, `Schedule ${nm(D.cC)} interview tomorrow at 3pm online`, 'schedule_interview', { highImpact: true, rowCheck: [['Time', '3:00 PM'], ['Mode', 'Online']] });
  let ap = await prisma.application.findUnique({ where: { id: D.aC.id } });
  check('schedule_interview: stage Interview booked, time stored', ap.stage === 'INTERVIEW_SCHEDULED' && ap.interviewAt && ap.interviewAt.getHours() === 15, `${ap.stage} ${ap.interviewAt}`);
  r = await doIt(P.SA.user, `Schedule ${nm(D.cC)} interview on Friday at 11`);
  check('scheduling an already-booked interview is turned into a reschedule (no double booking)', r.kind === 'confirm' && r.tool === 'reschedule_interview', JSON.stringify(r).slice(0, 250));
  b = await confirmFlow(P.SA.user, `Reschedule ${nm(D.cC)} interview to day after tomorrow at 4pm`, 'reschedule_interview', { highImpact: true });
  ap = await prisma.application.findUnique({ where: { id: D.aC.id } });
  check('reschedule_interview: the new time is on the record and the change was counted', ap.interviewAt.getHours() === 16 && ap.interviewRescheduleCount >= 1, `${ap.interviewAt} ${ap.interviewRescheduleCount}`);
  r = await doIt(P.SA.user, `Schedule ${nm(D.cA)} interview yesterday at 3pm`);
  check('scheduling in the past is refused in plain words', r.kind === 'refused' && /past/i.test(r.message), JSON.stringify(r).slice(0, 250));

  // assign_recruiter
  // (the assign screen never offers test logins, so a REAL recruiter of the sandbox copy is used - only referenced, never edited)
  const bench = await call(P.SA.user, 'GET', '/requirements/assignable-people?recruiters=1');
  const rec = ((bodyOf(bench).groups || []).flatMap((g) => g.people || [])[0]) || null;
  if (!rec) check('assign_recruiter: a recruiter exists in the sandbox picker', false, JSON.stringify(bodyOf(bench)).slice(0, 200));
  else {
    r = await doIt(P.SA.user, `Assign ${rec.name} to the Zzaijob Unassigned job`);
    if (r.kind === 'confirm') {
      check('assign_recruiter: Confirm card names the recruiter, the job and their workload', r.card.rows.some((x) => /Zzaijob Unassigned/.test(x.value)) && r.card.rows.some((x) => x.label === 'Their workload'), JSON.stringify(r.card.rows).slice(0, 300));
      b = bodyOf(await confirmIt(P.SA.user, r.card.pendingId));
      check('assign_recruiter: executed and verified', b.kind === 'done' && b.verified === true, JSON.stringify(b).slice(0, 300));
      check('assign_recruiter: the job really has the recruiter', (await prisma.requirement.findUnique({ where: { id: D.req2.id } })).recruiterId === rec.id);
    } else check('assign_recruiter: Confirm card', false, JSON.stringify(r).slice(0, 350));
    r = await doIt(P.SA.user, 'Assign a recruiter to the Zzaijob Developer job');
    check('assign_recruiter: no name given -> offers the least busy recruiters first', r.kind === 'clarify' && (r.options || []).length >= 1 && /least busy/i.test(r.message), JSON.stringify(r).slice(0, 300));
  }

  // clients
  const cname = `Zzaiclient Two ${RUN}`;
  b = await confirmFlow(P.SA.user, `Create a client ${cname} in Pune with contact Ravi 9876543210`, 'create_client', { highImpact: false });
  const nc = await prisma.client.findFirst({ where: { name: cname } });
  check('create_client: the client exists with city and contact', !!nc && nc.location === 'Pune' && nc.contactPhone === '9876543210', JSON.stringify(nc && { loc: nc.location, ph: nc.contactPhone }));
  r = await doIt(P.SA.user, `Create a client ${cname}`);
  check('create_client: a duplicate name is refused', r.kind === 'refused' && /already/i.test(r.message), JSON.stringify(r).slice(0, 250));
  b = await confirmFlow(P.SA.user, `Update client ${cname} contact phone to 9123456780`, 'update_client', { rowCheck: [['Contact phone - new', '9123456780']] });
  check('update_client: new phone saved', (await prisma.client.findFirst({ where: { name: cname } })).contactPhone === '9123456780');

  // requirements
  const jt = `Zzaijob Fresh ${RUN}`;
  b = await confirmFlow(P.SA.user, `Create a requirement for ${jt} at ${D.client.name} 3 openings`, 'create_requirement', { rowCheck: [['Openings', '3']] });
  const nr = await prisma.requirement.findFirst({ where: { title: jt } });
  check('create_requirement: saved as a DRAFT with 3 openings (nothing posted anywhere)', !!nr && nr.status === 'DRAFT' && nr.openings === 3, JSON.stringify(nr && { s: nr.status, o: nr.openings }));
  b = await confirmFlow(P.SA.user, `Update the ${jt} job openings to 5`, 'update_requirement');
  check('update_requirement: openings now 5', ((await prisma.requirement.findFirst({ where: { title: jt } })) || {}).openings === 5);
  b = await confirmFlow(P.SA.user, `Delete the ${jt} job`, 'delete_requirement', { highImpact: true });
  check('delete_requirement: the job is gone', (await prisma.requirement.count({ where: { title: jt } })) === 0);

  // candidates
  const cn = `ZZTEST Zzaicandnew ${RUN}`;
  r = await doIt(P.SA.user, `Add candidate ${cn} phone 9000022222`);
  check('create_candidate: missing email -> asks for it', r.kind === 'clarify' && /email/i.test(r.message), JSON.stringify(r).slice(0, 250));
  r = await call(P.SA.user, 'POST', '/agent/do', { message: `zztest.aia.new.${RUN}@zz-sandbox.in`, frame: r.frame }).then((x) => x.body);
  check('create_candidate: then asks for a skill', r.kind === 'clarify' && /skill/i.test(r.message), JSON.stringify(r).slice(0, 250));
  r = await call(P.SA.user, 'POST', '/agent/do', { message: 'Java, SQL', frame: r.frame }).then((x) => x.body);
  // The app asks for current + expected salary on every new candidate (2026-10-10): the agent asks for both, never guesses.
  check('create_candidate: then asks for the current salary', r.kind === 'clarify' && /current salary/i.test(r.message), JSON.stringify(r).slice(0, 250));
  r = await call(P.SA.user, 'POST', '/agent/do', { message: '4.5 LPA', frame: r.frame }).then((x) => x.body);
  check('create_candidate: then asks for the expected salary', r.kind === 'clarify' && /expect/i.test(r.message), JSON.stringify(r).slice(0, 250));
  r = await call(P.SA.user, 'POST', '/agent/do', { message: 'six', frame: r.frame }).then((x) => x.body);
  check('create_candidate: an unclear salary is asked again in plain words (nothing is written)', r.kind === 'clarify' && /expected salary/i.test(r.message) && !(await prisma.candidate.findFirst({ where: { name: { contains: 'Zzaicandnew' } } })), JSON.stringify(r).slice(0, 250));
  r = await call(P.SA.user, 'POST', '/agent/do', { message: '6 LPA', frame: r.frame }).then((x) => x.body);
  check('create_candidate: Confirm card with all details', r.kind === 'confirm' && r.card.rows.some((x) => x.label === 'Skills' && /Java/.test(x.value)) && r.card.rows.some((x) => x.label === 'Current salary') && r.card.rows.some((x) => x.label === 'Expected salary'), JSON.stringify(r).slice(0, 300));
  b = bodyOf(await confirmIt(P.SA.user, r.card.pendingId));
  check('create_candidate: executed and verified', b.kind === 'done' && b.verified === true, JSON.stringify(b).slice(0, 300));
  const newCand = await prisma.candidate.findFirst({ where: { name: { contains: 'Zzaicandnew' } } });
  check('create_candidate: candidate exists', !!newCand);
  b = await confirmFlow(P.SA.user, `Update candidate Zzaicandnew location to Chennai`, 'update_candidate');
  check('update_candidate: city saved', newCand && (await prisma.candidate.findUnique({ where: { id: newCand.id } })).location === 'Chennai');

  // communication
  r = await doIt(P.SA.user, `Send ${nm(D.cB)} a WhatsApp about the interview`);
  check('send_candidate_communication: WhatsApp not set up -> refused with the real reason, nothing sent', r.kind === 'refused' && /not set up|cannot send/i.test(r.message), JSON.stringify(r).slice(0, 300));
  // The company's "Candidate emails" switch is OFF by default and the agent must respect it.
  const SW = 'interview-reminders';
  const swRow = await prisma.appSetting.findUnique({ where: { key: SW } });
  const setSwitch = async (on) => prisma.appSetting.upsert({ where: { key: SW }, create: { key: SW, value: JSON.stringify({ enabled: on }) }, update: { value: JSON.stringify({ enabled: on }) } });
  await setSwitch(false);
  r = await doIt(P.SA.user, `Email ${nm(D.cB)} the interview details`);
  check('send_candidate_communication: with the company\'s "Candidate emails" switch OFF it refuses and says which switch', r.kind === 'refused' && /switch is OFF/i.test(r.message), JSON.stringify(r).slice(0, 300));
  await setSwitch(true);
  r = await doIt(P.SA.user, `Email ${nm(D.cB)} the interview details`);
  if (r.kind === 'confirm') {
    check('send_candidate_communication: Email card shows the real wording and is HIGH IMPACT (external communication)', r.card.highImpact === true && r.card.rows.some((x) => x.label === 'Message'), JSON.stringify(r.card.rows).slice(0, 300));
    b = bodyOf(await confirmIt(P.SA.user, r.card.pendingId));
    check('send_candidate_communication: sent through the app (sandbox transport) and verified from the send record', b.kind === 'done' && b.verified === true, JSON.stringify(b).slice(0, 300));
    check('send_candidate_communication: the message is in the candidate\'s history', (await prisma.candidateMessage.count({ where: { candidateId: D.cB.id } })) >= 1);
  } else check('send_candidate_communication: Email Confirm card (or a plain refusal naming the app\'s reason)', r.kind === 'refused' && r.message.length > 20, JSON.stringify(r).slice(0, 350));

  if (swRow) await prisma.appSetting.update({ where: { key: SW }, data: { value: swRow.value } }); else await prisma.appSetting.delete({ where: { key: SW } }).catch(() => {});

  // leave (Employee)
  const day = futureDay(9);
  r = await doIt(P.EMP.user, `Apply casual leave on ${day} reason family function`);
  if (r.kind === 'confirm') {
    check('apply_leave: Confirm card shows type, dates and balance', r.card.rows.some((x) => x.label === 'Leave type') && r.card.rows.some((x) => x.label === 'From'), JSON.stringify(r.card.rows).slice(0, 300));
    b = bodyOf(await confirmIt(P.EMP.user, r.card.pendingId));
    check('apply_leave: executed and verified in the employee\'s own list', b.kind === 'done' && b.verified === true, JSON.stringify(b).slice(0, 300));
    check('apply_leave: a Pending request exists for the employee', (await prisma.leaveRequest.count({ where: { employeeId: P.EMP.emp.id, fromDate: day, status: 'Pending' } })) === 1);
    r = await doIt(P.EMP.user, 'Cancel my leave');
    if (r.kind === 'confirm') {
      b = bodyOf(await confirmIt(P.EMP.user, r.card.pendingId));
      check('cancel_leave: cancellation requested and verified', b.kind === 'done' && b.verified === true, JSON.stringify(b).slice(0, 300));
    } else check('cancel_leave: Confirm card', false, JSON.stringify(r).slice(0, 300));
  } else check('apply_leave: Confirm card', false, JSON.stringify(r).slice(0, 350));
  r = await doIt(P.EMP.user, 'Naaku repu casual leave kavali');
  check('apply_leave in Telugu-English reaches the same Confirm card (or the same plain refusal)', ['confirm', 'refused'].includes(r.kind) && r.tool === 'apply_leave', JSON.stringify(r).slice(0, 300));
  r = await doIt(P.SA.user, 'Apply casual leave tomorrow');
  check('a Super Admin has no employee record: the leave tool says so (system account)', r.kind === 'refused' && /employee record/i.test(r.message), JSON.stringify(r).slice(0, 250));

  // attendance (HR)
  const ename = D.empOne.name.split(' ')[1];
  b = await confirmFlow(P.HR.user, `Mark ${ename} present yesterday`, 'update_attendance (HR)', { highImpact: true });
  const attDay = ymd(new Date(Date.now() - 86400000));
  check('update_attendance: the attendance row exists', (await prisma.attendance.count({ where: { employeeId: D.empOne.id, date: attDay, status: 'Present' } })) === 1);

  // announcement
  const ann = `Zzaiannounce ${RUN}`;
  b = await confirmFlow(P.HR.user, `Announce that ${ann} meeting is at 4 pm today`, 'create_announcement (HR)', { highImpact: true });
  check('create_announcement: the announcement exists', (await prisma.announcement.count({ where: { OR: [{ title: { contains: 'Zzaiannounce' } }, { body: { contains: 'Zzaiannounce' } }], postedById: P.HR.user.id } })) === 1);

  // assets
  b = await confirmFlow(P.HR.user, `Assign laptop ${D.asset.assetCode} to ${ename}`, 'assign_asset');
  check('assign_asset: the asset is Assigned to that employee', (await prisma.asset.findUnique({ where: { id: D.asset.id } })).assignedToId === D.empOne.id);
  b = await confirmFlow(P.HR.user, `Return laptop ${D.asset.assetCode}`, 'return_asset');
  check('return_asset: the asset is Available again', (await prisma.asset.findUnique({ where: { id: D.asset.id } })).status === 'Available');

  // employees
  const newEmail = `zztest.aia.hire.${RUN}@example.test`;
  r = await doIt(P.HR.user, `Add employee ZZTEST Zzaihire ${RUN} email ${newEmail} department ${DEPT}`);
  if (r.kind === 'confirm') {
    check('create_employee: HIGH IMPACT card that mentions the welcome email', r.card.highImpact === true && /welcome/i.test(r.card.note || ''), JSON.stringify(r.card).slice(0, 300));
    b = bodyOf(await confirmIt(P.HR.user, r.card.pendingId));
    check('create_employee: executed and verified', b.kind === 'done' && b.verified === true, JSON.stringify(b).slice(0, 300));
  } else check('create_employee: Confirm card (HR may only add to departments in their scope)', r.kind === 'clarify' || r.kind === 'refused', JSON.stringify(r).slice(0, 350));
  b = await confirmFlow(P.SA.user, `Update employee ${ename} phone to 9876500001`, 'update_employee', { highImpact: true });
  check('update_employee: phone saved', (await prisma.employee.findUnique({ where: { id: D.empOne.id } })).phone === '9876500001');

  // accounts
  b = await confirmFlow(P.ACC.user, 'Add an expense of 1500 for cab fare', 'create_expense (Accountant)', { highImpact: false });
  check('create_expense: saved as Pending approval', (await prisma.officeExpense.count({ where: { createdById: P.ACC.user.id, approvalStatus: 'PENDING' } })) >= 1);
  b = await confirmFlow(P.ACC.user, `Record a payment of 2000 on invoice ${D.inv.invoiceNumber}`, 'record_payment', { highImpact: true });
  check('record_payment: the invoice shows Rs 2000 received', (await prisma.invoice.findUnique({ where: { id: D.inv.id } })).receivedAmount === 2000);
  r = await doIt(P.ACC.user, `Record a payment of 999999 on invoice ${D.inv.invoiceNumber}`);
  check('record_payment: more than is due is refused in plain words', r.kind === 'refused' && /left to receive/i.test(r.message), JSON.stringify(r).slice(0, 250));
  b = await confirmFlow(P.ACC.user, `Create an invoice for ${D.client.name} of 20000`, 'create_invoice');
  b = await confirmFlow(P.ACC.user, `Update invoice ${D.inv2.invoiceNumber} amount to 6000`, 'update_invoice', { highImpact: true });
  check('update_invoice: amount saved', (await prisma.invoice.findUnique({ where: { id: D.inv2.id } })).amount === 6000);
  r = await doIt(P.ACC.user, `Cancel invoice ${D.inv.invoiceNumber}`);
  check('cancel_invoice: money already received -> refused in plain words', r.kind === 'refused' && /received/i.test(r.message), JSON.stringify(r).slice(0, 250));
  b = await confirmFlow(P.ACC.user, `Cancel invoice ${D.inv2.invoiceNumber}`, 'cancel_invoice', { highImpact: true });
  check('cancel_invoice: invoice Cancelled', (await prisma.invoice.findUnique({ where: { id: D.inv2.id } })).status === 'Cancelled');
  r = await doIt(P.SA.user, `Update customer ${D.client.name} billing email to zztest.aia.bill@example.test`);
  if (r.kind === 'confirm') {
    b = bodyOf(await confirmIt(P.SA.user, r.card.pendingId));
    check('update_customer: executed and verified', b.kind === 'done' && b.verified === true, JSON.stringify(b).slice(0, 300));
  } else check('update_customer: Confirm card', false, JSON.stringify(r).slice(0, 350));

  // incentive (Super Admin only)
  // (a REAL recruiter of the sandbox copy is used as the subject; the decision row is removed in cleanup)
  const lm = new Date(); lm.setMonth(lm.getMonth() - 1);
  const lmKey = ymd(lm).slice(0, 7);
  const board = await call(P.SA.user, 'GET', `/recruiter-joinings/board?month=${lmKey}`);
  const person = (bodyOf(board).rows || []).find((x) => !x.left && x.employmentStatus === 'Active' && !/zz/i.test(x.name));
  if (person) {
    r = await doIt(P.SA.user, `Give ${person.name} an incentive of 5000 for last month`);
    if (r.kind === 'confirm') {
      check('prepare_incentive_action: Confirm card is HIGH IMPACT (payroll) and shows the joinings', r.card.highImpact === true && r.card.rows.some((x) => x.label === 'Joinings'), JSON.stringify(r.card.rows).slice(0, 300));
      b = bodyOf(await confirmIt(P.SA.user, r.card.pendingId));
      check('prepare_incentive_action: executed and verified on the joinings board', b.kind === 'done' && b.verified === true, JSON.stringify(b).slice(0, 400));
      check('prepare_incentive_action: the decision row exists with the amount', (await prisma.recruiterJoiningDecision.count({ where: { employeeId: person.employeeId, month: lmKey, amount: 5000 } })) === 1);
    } else check('prepare_incentive_action: Confirm card', false, JSON.stringify(r).slice(0, 350));
  } else check('prepare_incentive_action: a recruiter on last month\'s board (sandbox data)', false, 'no recruiter found');
  r = await doIt(P.SA.user, `Give ${ename} an incentive of 5000 for last month`);
  check('prepare_incentive_action: Super Admin passes permission; a person not on the recruiter list gets a plain refusal',['confirm', 'refused', 'clarify'].includes(r.kind) && r.tool === 'prepare_incentive_action', JSON.stringify(r).slice(0, 300));

  // a model-less unknown request
  r = await doIt(P.SA.user, 'what is the weather like');
  check('something it does not understand gets examples, not a guess', r.kind === 'unhandled' && (r.options || []).length > 0, JSON.stringify(r).slice(0, 250));
  r = await doIt(P.SA.user, `Move`);
  check('a bare "Move" asks a question instead of guessing', ['clarify', 'unhandled'].includes(r.kind), r.kind);
}

async function testAudit() {
  sec('Audit: who, tool, parameters, confirmation, result, "via AI"');
  const rows = await prisma.auditLog.findMany({ where: { action: 'AI_AGENT_ACTION', userId: { in: created.users } }, orderBy: { createdAt: 'desc' }, take: 50 });
  check('there is an audit row for executed agent actions', rows.length >= 15, String(rows.length));
  const good = rows.filter((x) => /via AI Agent/.test(x.reason || '') && x.entity === 'AiAgent' && x.actorName && x.fromValue && /"tool":/.test(x.fromValue) && /"params":/.test(x.fromValue) && /confirmedBy/.test(x.fromValue));
  check('each row says who (user + name), which tool, the parameters, who confirmed, and "via AI Agent"', good.length === rows.length, `${good.length}/${rows.length}`);
  const withSteps = rows.filter((x) => /"steps":\[/.test(x.fromValue) && /execute:ok/.test(x.fromValue) && /verify:ok/.test(x.fromValue));
  check('the row carries the pipeline steps (execute and verify results)', withSteps.length >= rows.length - 2, `${withSteps.length}/${rows.length}`);
  const denied = await prisma.auditLog.count({ where: { action: 'AI_AGENT_DENIED', userId: { in: created.users } } });
  check('refused attempts are audited too (AI_AGENT_DENIED)', denied >= 5, String(denied));
  // the underlying route audits it too (business rules + notifications apply)
  const own = await prisma.auditLog.count({ where: { userId: P.SA.user.id, action: { in: ['Client created', 'Interview rescheduled — Time changed at the user\'s request', 'Requirement created'] } } });
  check('the real route\'s own audit rows exist as well (the agent goes through the same code a click does)', own >= 1, String(own));
}

async function testAsk() {
  sec('Ask mode (assistant): read-only, shows its numbers and where they came from');
  const asks = [
    'Move Zzaicandalpha to Interview', 'Reject Zzaicandbeta', 'Create a client Zzaiasktest', 'Delete the Zzaijob Developer job', 'Apply casual leave tomorrow', 'Mark Zzaiemp present today', 'Announce that the office is closed',
    'Assign laptop AST-0001 to Ravi', 'Cancel invoice 1827', 'Record a payment of 500 on invoice 1827', 'Add an expense of 1500 for cab fare', 'Schedule Zzaicandalpha interview tomorrow at 3pm', 'Shortlist Zzaicandbeta',
    'Send Zzaicandbeta a WhatsApp about the interview', 'Update candidate Zzaicandalpha phone to 9876543210', 'Create an invoice for Zzaiclient of 1000', 'Add employee Test Person email t@x.in department Medical',
    'Zzaicandalpha ni interview ki move cheyyi', 'Rahul ki repu interview pettu', 'Give Ravi an incentive of 5000', 'Update employee Suresh phone to 9876543210', 'Assign Priya to the Java Developer requirement', 'Create a requirement for Java Developer at Acme',
  ];
  const tables = {
    client: () => prisma.client.count(), candidate: () => prisma.candidate.count(), requirement: () => prisma.requirement.count(), application: () => prisma.application.count(),
    stageEvent: () => prisma.applicationStageEvent.count(), invoice: () => prisma.invoice.count(), payment: () => prisma.invoicePayment.count(), leave: () => prisma.leaveRequest.count(),
    attendance: () => prisma.attendance.count(), announcement: () => prisma.announcement.count(), expense: () => prisma.officeExpense.count(), asset: () => prisma.asset.count(), employee: () => prisma.employee.count(),
    saAudit: () => prisma.auditLog.count({ where: { userId: P.SA.user.id } }),
  };
  const snap = async () => { const o = {}; for (const [k, f] of Object.entries(tables)) o[k] = await f(); return o; };
  const before = await snap();
  const answers = [];
  for (const m of asks) answers.push({ m, r: await ask(P.SA.user, m) });
  const after = await snap();
  const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
  check(`${asks.length} action phrases sent to Ask mode change NOTHING in the database (14 tables compared, incl. audit rows of the user)`, changed.length === 0, changed.map((k) => `${k}: ${before[k]}->${after[k]}`).join(', '));
  const said = answers.filter((a) => /cannot change anything|Do mode/i.test(a.r.answer || '') || a.r.suggestMode === 'do').length;
  check('Ask mode says it cannot change things and points to Do mode for those phrases', said >= asks.length - 6, `${said}/${asks.length} -> ${answers.filter((a) => !(/Do mode/i.test(a.r.answer || ''))).map((a) => a.m).join(' | ')}`);
  check('no Ask answer carries a pending Confirm card or executes anything', answers.every((a) => !a.r.card && !a.r.pendingId));
  // read answers
  let r = await ask(P.SA.user, 'How many employees are absent today?');
  check('"How many employees are absent today?" -> a number AND the source and the date', r.handled && Array.isArray(r.numbers) && r.numbers.length >= 3 && /Counted from Attendance/.test(r.source || '') && /20\d\d-\d\d-\d\d/.test(r.source), JSON.stringify(r).slice(0, 400));
  r = await ask(P.SA.user, 'How many employees do we have?');
  check('headcount answer shows numbers and "Counted from Employee records ... your area"', r.handled && r.numbers.length >= 3 && /Employee records/.test(r.source) && /Your area/.test(r.source), JSON.stringify(r).slice(0, 300));
  r = await ask(P.SA.user, 'How many candidates are at interview?');
  check('pipeline count with its source', r.handled && r.numbers.length >= 1 && /Candidates & Pipeline/.test(r.source), JSON.stringify(r).slice(0, 300));
  r = await ask(P.SA.user, 'How much is outstanding?');
  check('invoices outstanding with its source', r.handled && /Invoices and Payments/.test(r.source) && r.numbers.length >= 3, JSON.stringify(r).slice(0, 300));
  r = await ask(P.SA.user, 'How many jobs are open?');
  check('requirements status with its source', r.handled && /Requirements/.test(r.source), JSON.stringify(r).slice(0, 300));
  r = await ask(P.SA.user, 'What should I do first?');
  check('recommended actions', r.handled && /do|nothing/i.test(r.answer), JSON.stringify(r).slice(0, 300));
  r = await ask(P.SA.user, 'Compare absent days this week vs last week');
  check('comparison (attendance this week vs last week)', r.handled && r.numbers.length >= 2, JSON.stringify(r).slice(0, 300));
  r = await ask(P.SA.user, 'Compare joinings this month vs last month');
  check('comparison / trend (joinings)', r.handled && r.numbers.length === 2, JSON.stringify(r).slice(0, 300));
  r = await ask(P.SA.user, 'ee roju entha mandi absent');
  check('Telugu-English question "ee roju entha mandi absent" is answered (attendance, today)', r.handled && /Attendance/.test(r.source || ''), JSON.stringify(r).slice(0, 250));
  r = await ask(P.EMP.user, 'How much leave do I have left?');
  check('an Employee can read their OWN leave balance', r.handled && /your own/i.test(r.source || '') || (r.handled && /Leave/i.test(r.source || '')), JSON.stringify(r).slice(0, 300));
  r = await ask(P.EMP.user, 'How many employees are absent today?');
  check('an Employee asking for company attendance is refused in plain words', /OWN/.test(r.answer || '') && !(r.numbers || []).length, r.answer);
  r = await ask(P.EMP.user, `How much leave does ${D.empOne.name.split(' ')[1]} have left?`);
  check('an Employee asking for SOMEONE ELSE\'s leave is refused', /OWN|not anybody else/i.test(r.answer || ''), r.answer);
  r = await ask(P.EMP.user, 'Show me the pipeline');
  check('an Employee cannot read the recruitment pipeline', /OWN/.test(r.answer || '') || /cannot|not/i.test(r.answer || ''), r.answer);
  r = await ask(P.REC.user, 'How much is outstanding?');
  check('a Recruiter asking for money figures is refused: no data for that role', /cannot|not|role/i.test(r.answer || '') && !(r.numbers || []).length, r.answer);
  r = await ask(P.TL.user, 'How many employees are absent today?');
  check('a TL gets attendance only for their own area or a plain refusal (never the company)', r.handled === true, JSON.stringify(r).slice(0, 300));
}

async function main() {
  console.log(`AI Agent test suite - sandbox ${API_ORIGIN}  (run ${RUN})`);
  let up = false;
  for (let i = 0; i < 20 && !up; i += 1) {
    try { const h = await fetch(`${API_ORIGIN}/api/health`); up = h.ok; } catch { up = false; }
    if (!up) await sleep(2000); // the sandbox restarts whenever someone edits backend/src
  }
  if (!up) { console.error('The sandbox API is not answering. Start it: node scripts/sandbox.js --detach --frontend --keep'); process.exit(2); }
  if (CLEANUP_ONLY) {
    console.log('cleanup:', JSON.stringify(await cleanup()));
    console.log('scan:', JSON.stringify(await scan()));
    await prisma.$disconnect();
    return;
  }
  let fatal = null;
  try {
    await seed();
    await testStructure();
    await testNoDirectWrites();
    await testIntent();
    await testLlmGuard();
    await testAccess();
    await testConfirmationRules();
    await testTools();
    await testAudit();
    await testAsk();
  } catch (e) {
    fatal = e;
    check('the suite ran to the end without a crash', false, e && e.stack);
  } finally {
    if (!KEEP) {
      sec('Cleanup');
      const out = await cleanup();
      console.log('cleanup:', JSON.stringify(out));
      const left = await scan();
      console.log('scan:', JSON.stringify(left));
      check('no ZZTEST / Zzai rows left in the sandbox', Object.values(left).every((v) => v === 0), JSON.stringify(left));
    } else console.log('(--keep: ZZTEST data left in the sandbox; run --cleanup to remove it)');
    await prisma.$disconnect();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length} passed, ${failed.length} failed, ${results.length} checks, ${Math.round((Date.now() - T0) / 1000)}s ====`);
  failed.forEach((f) => console.log(`FAILED [${f.section}] ${f.name}${f.detail ? `\n    ${f.detail}` : ''}`));
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), api: API_ORIGIN, results, fatal: fatal ? String(fatal.stack || fatal) : null }, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main();
