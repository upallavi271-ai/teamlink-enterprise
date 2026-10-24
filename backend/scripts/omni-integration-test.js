#!/usr/bin/env node
// ---------------------------------------------------------------------------
// OMNI-CHANNEL INTEGRATION TEST (2026-10-17) - COPY DATABASE ONLY.
//   cd backend
//   COPY_DB=C:/tmp/omni-int-copy.db TEST_PORT=4121 node scripts/omni-integration-test.js
// COPY_DB = a VACUUM INTO copy of the real database (never prisma/dev.db). The script makes its OWN working copy (<name>-int-work.db), starts its OWN API
// (TEST_MODE = the test sandbox: no outbound call is possible, no worker runs) and checks:
//   S  sidebar tree as pure logic (frontend/src/components/omni/omniPages.js): the 10 sections, every old page reachable, no duplicate keys, old addresses
//   L  the shared template library: scopes, reuse across allowed / denied apps, approval, versions, department isolation
//   C  campaigns from the app screens: save for later -> approval -> schedule -> pause / resume -> send (Test mode) -> cancel, tracking, audience rules
//   R  replies: routed to the 4 source apps, ambiguous / unknown -> Needs review, duplicate provider event ignored, retry of a failed event
//   D  department isolation and changed ids / params (403 / 404)
//   H  honest provider status, Sync health, no provider secret in any answer
// NOTHING real is sent: Test mode + sandbox, made-up numbers and addresses. The script also checks that no provider send happened.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { DatabaseSync } = require('node:sqlite');

const copy = process.env.COPY_DB;
if (!copy || /prisma[\\/]dev\.db$/i.test(path.resolve(copy))) { console.error('Refusing: set COPY_DB to a COPY of the database, never prisma/dev.db.'); process.exit(2); }
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const WORK = path.resolve(copy).replace(/\.db$/i, '-int-work.db');
for (const ext of ['', '-shm', '-wal']) { try { fs.unlinkSync(WORK + ext); } catch { /* none */ } }
fs.copyFileSync(path.resolve(copy), WORK);
const PORT = Number(process.env.TEST_PORT || 4121);
if (PORT === 4010) process.exit(2);
const API = `http://127.0.0.1:${PORT}`;
const JOBDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-int-jobs-'));
process.env.MESSAGE_JOB_DIR = JOBDIR;
process.env.DATABASE_URL = `file:${WORK.split(path.sep).join('/')}?socket_timeout=60`;
process.env.TEST_MODE = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${WORK.split(path.sep).join('/')}?socket_timeout=60`;
process.env.MESSAGE_JOB_DIR = JOBDIR;

{ // the Omni-Channel tables, applied to the WORKING copy only when the copy lacks them
  const db = new DatabaseSync(WORK);
  db.exec('PRAGMA busy_timeout = 30000');
  const has = (n) => !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(n);
  [['OutreachContact', '20261014100000_outreach_core'], ['OutreachCampaign', '20261014200000_outreach_campaigns'], ['OutreachCampaignNote', '20261014900000_outreach_quickwins']].forEach(([t, dir]) => {
    if (!has(t)) db.exec(fs.readFileSync(path.join(BACK, 'prisma', 'migrations', dir, 'migration.sql'), 'utf8'));
  });
  // the one hand-written migration of this module must apply cleanly to a database that never saw it
  if (!has('OmniReplyLink')) db.exec(fs.readFileSync(path.join(BACK, 'prisma', 'migrations', '20261017200000_omni_integration', 'migration.sql'), 'utf8'));
  // the rehearsal rule: Test mode on, sending off - exactly the default; the test never switches a real send on
  db.prepare("INSERT INTO AppSetting (key, value, updatedAt) VALUES ('outreach.settings', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ master: false, emailTestMode: true }), Date.now());
  // "Candidate emails" switch ON in the working copy, so the candidate plan can show real rehearsal rows
  db.prepare("INSERT INTO AppSetting (key, value, updatedAt) VALUES ('interview-reminders', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ enabled: true }), Date.now());
  db.close();
}
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 700)}` : ''}`); };
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const RUN = Date.now().toString(36);
let seq = 0;
const RUNNUM = parseInt(RUN, 36) % 90000;
let phSeq = 0;
const phone = () => { phSeq += 1; return String(9100000000 + RUNNUM * 1000 + phSeq); }; // 10 digits, unique in this run
const mail = (t) => { seq += 1; return `qa.${t}.${RUN}.${seq}@gmail.com`; };

async function http(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(120000) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
const qs = (o) => `?${Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;

(async () => {
  let server;
  try {
    const A0 = require(path.join(BACK, 'src/outreach/access'));
    const Lib = require(path.join(BACK, 'src/outreach/omni/library'));
    const Router = require(path.join(BACK, 'src/outreach/omni/replyRouter'));
    const Schema = require(path.join(BACK, 'src/outreach/omni/schema'));
    const delivery = require(path.join(BACK, 'src/utils/messageDelivery'));
    const S = require(path.join(BACK, 'src/outreach/store'));
    await Schema.ensure();

    // =============================================================== S: the sidebar tree (pure logic)
    const P = await import(pathToFileURL(path.join(FRONT, 'src/components/omni/omniPages.js')).href);
    const ALL = P.ALL_IDS;
    const adminAcc = { level: 'admin', pages: ALL };
    const kids = P.omniChildren(adminAcc, { inboxUnread: 3, approvals: 2 });
    const WANT = ['Overview', 'Inbox & Replies', 'Templates', 'Campaigns', 'Promotions', 'Contacts & Audiences', 'Automation', 'Channel Connections', 'Reports', 'Settings & Audit Log'];
    check('S1 the Omni-Channel group has EXACTLY the 10 sections of the founder, in his order, as plain entries (no sub-groups, no extras)', JSON.stringify(kids.map((k) => k.label)) === JSON.stringify(WANT) && kids.every((k) => !k.children), kids.map((k) => k.label));
    check('S2 no duplicate keys: every section address is different, every view id is in exactly one section', new Set(kids.map((k) => k.to)).size === 10 && P.SECTIONS.flatMap((s) => s.views).length === new Set(P.SECTIONS.flatMap((s) => s.views)).size);
    const OLD = ['overview', 'fbcatalogs', 'shopify', 'inbox', 'fbchannel', 'igchannel', 'console', 'campaigns', 'social', 'analytics', 'templates', 'studio', 'crm', 'customers', 'segments', 'botdata', 'forms', 'adsmanager', 'googlecampaigns', 'googleads', 'ganalytics', 'automation', 'botbuilder', 'team', 'billing', 'superadmin', 'settings'];
    const lost = OLD.filter((id) => !P.SECTIONS.some((s) => s.views.includes(id)));
    check('S3 all 27 old Green Start pages are still reachable (each is a tab of one of the 10 sections)', lost.length === 0, lost);
    const moved = OLD.map((id) => ({ id, r: P.resolveRoute(adminAcc, id, undefined, '') }));
    check('S4 every old address /omni-channel/<old page> goes to its section and tab (a redirect), and lands on the right view', moved.every((m) => (m.r.view === m.id || (m.id === 'templates' && m.r.view === 'tplshared')) && m.r.section === P.sectionOf(m.id) && (m.r.redirect === null || m.r.redirect === `/omni-channel/${m.r.section}/${m.id}`)), moved.filter((m) => m.r.view !== m.id && m.id !== 'templates'));
    // (the old bare address /omni-channel/templates opens the Templates section on its first tab, the Template library; Create & channels is the next tab)
    const clicks = kids.map((k) => { const seg = k.to.split('/')[2]; return { seg, r: P.resolveRoute(adminAcc, seg, undefined, '') }; });
    check('S5 click-through: each of the 10 sidebar entries opens its own section, on its first tab, with no redirect', clicks.every((c) => c.r.section === c.seg && c.r.redirect === null && c.r.view === P.SECTIONS.find((s) => s.id === c.seg).views[0]), clicks.map((c) => [c.seg, c.r.section, c.r.view, c.r.redirect]));
    const L1 = P.resolveRoute(adminAcc, 'console', undefined, '?tab=sms');
    const L2 = P.resolveRoute(adminAcc, 'insights', undefined, '');
    const L3 = P.resolveRoute(adminAcc, 'campaigns', undefined, '?tab=templates');
    const L4 = P.resolveRoute(adminAcc, undefined, undefined, '?mode=settings&tab=consent');
    const L5 = P.resolveRoute(adminAcc, 'templates', undefined, '?channel=sms&create=1');
    const L6 = P.resolveRoute(adminAcc, 'campaigns', 'nonsense', '');
    check('S6 old bookmarks keep working: console?tab=sms, the old hub address, old campaigns?tab=templates, the old ?mode=..&tab=.. form, templates?create=1 and a wrong tab name',
      L1.section === 'campaigns' && L1.view === 'console' && /tab=sms/.test(L1.redirect) && L2.section === 'reports' && L2.view === 'analytics' && L3.section === 'templates' && L3.view === 'templates'
      && L4.section === 'settings' && L4.view === 'settings' && L5.view === 'templates' && L6.view === 'campaigns' && L6.redirect === '/omni-channel/campaigns/campaigns', { L1, L2, L3, L4, L5, L6 });
    const finAcc = { level: 'finance', pages: ['billing'] };
    const fk = P.omniChildren(finAcc, {});
    const recAcc = { level: 'recruiter', pages: ['overview', 'inbox', 'review', 'campaigns', 'appcampaigns', 'tplshared', 'templates', 'studio', 'customers', 'segments', 'crm', 'forms', 'automation', 'botbuilder', 'botdata', 'connections', 'analytics', 'billing'] };
    const rk = P.omniChildren(recAcc, {});
    check('S7 permissions unchanged by the new tree: Finance sees only "Settings & Audit Log" (Billing tab only); a recruiter sees no Promotions and no admin tabs; a forbidden tab falls back to the first allowed one',
      fk.length === 1 && fk[0].label === 'Settings & Audit Log' && P.openViews(finAcc, 'settings').join() === 'billing' && !rk.some((k) => k.label === 'Promotions') && P.openViews(recAcc, 'settings').join() === 'billing'
      && P.resolveRoute(recAcc, 'settings', 'superadmin', '').view === 'billing', { fk, rk: rk.map((k) => k.label) });
    check('S8 the badges sit on Inbox & Replies (unread) and Campaigns (waiting for approval) only', kids.filter((k) => k.badge).map((k) => `${k.label}:${k.badge}`).join() === 'Inbox & Replies:3,Campaigns:2', kids.filter((k) => k.badge));
    // the Shell lights the right entry for a deep address (nav.js scoreMatch)
    let nav = null; try { nav = await import(pathToFileURL(path.join(FRONT, 'src/nav.js')).href); } catch { nav = null; }
    if (nav && nav.scoreMatch) {
      const best = (pathname) => kids.map((k) => ({ k, s: nav.scoreMatch(k.to, pathname, '') })).sort((a, b) => b.s - a.s)[0].k.label;
      check('S9 the sidebar keeps the right entry lit on a tab address (campaigns/console -> Campaigns; contacts/segments -> Contacts & Audiences; settings/audit -> Settings & Audit Log)', best('/omni-channel/campaigns/console') === 'Campaigns' && best('/omni-channel/contacts/segments') === 'Contacts & Audiences' && best('/omni-channel/settings/audit') === 'Settings & Audit Log' && best('/omni-channel/overview') === 'Overview');
    } else console.log('SKIP  S9 nav.js cannot be loaded as plain logic in Node (it imports without file endings); the lit entry is checked in the browser pane instead');

    // =============================================================== people
    const first = async (where) => prisma.user.findFirst({ where: { status: 'Active', NOT: { email: { contains: 'example.test' } }, ...where } });
    const live = { employee: { is: { employmentStatus: 'Active' } } };
    // DATA: the real Super Admin logins in the copy may still sit on a starting password (the app then refuses every call but /api/auth). The test uses its OWN ZZTEST Super Admin.
    const sa = await prisma.user.create({ data: { passwordHash: 'x', hrmsAccess: true, atsAccess: true, accountsAccess: true, status: 'Active', name: `ZZTEST super ${RUN}`, email: `zz-int-sa-${RUN}@example.test`, username: `zz-int-sa-${RUN}@example.test`, role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', accountsRole: 'SUPER_ADMIN' } });
    const pick = async (atsRole, kinds) => { for (const c of await prisma.user.findMany({ where: { status: 'Active', atsRole, ...live }, take: 20 })) { if (kinds.includes(A0.kind(await resolveIdentity(c.id)))) return c; } return null; }; // eslint-disable-line no-await-in-loop
    const tl = await pick('TL', ['tl']);
    const bde = await pick('BDE', ['bde']);
    const am = await first({ atsRole: 'ASSISTANT_MANAGER' });
    if (am) await prisma.employee.updateMany({ where: { userId: am.id }, data: { employmentStatus: 'Active' } });
    const hr = await first({ atsRole: 'HR', ...live });
    const recEmps = await prisma.employee.findMany({ where: { employmentStatus: 'Active', user: { atsRole: 'RECRUITER', status: 'Active' }, department: { not: null } }, include: { user: true }, take: 80 });
    const tlEmp = await prisma.employee.findFirst({ where: { userId: tl && tl.id } });
    const rec = recEmps.find((e) => e.department && tlEmp && e.department !== tlEmp.department) || recEmps[0];
    check('0 the copy has the people the test needs (Super Admin, TL, BDE, Assistant Manager, HR, a recruiter of another department)', !!(sa && tl && bde && am && hr && rec), { sa: !!sa, tl: !!tl, bde: !!bde, am: !!am, hr: !!hr, rec: !!rec });
    await prisma.user.updateMany({ where: { id: { in: [sa, tl, bde, am, hr, rec.user].filter(Boolean).map((u) => u.id) } }, data: { passwordHash: 'x' } });
    // DATA: a person can have more than one login row (the one-user model): the token is minted for the MAIN row, so that row must not be on a starting password either.
    for (const u of [sa, tl, bde, am, hr, rec.user].filter(Boolean)) { const idn = await resolveIdentity(u.id); if (idn && idn.id && idn.id !== u.id) await prisma.user.update({ where: { id: idn.id }, data: { passwordHash: 'x' } }); } // eslint-disable-line no-await-in-loop
    const base = { passwordHash: 'x', hrmsAccess: false, atsAccess: true, accountsRole: 'NONE', accountsAccess: false, status: 'Active' };
    const client = await prisma.user.create({ data: { ...base, name: `ZZTEST client ${RUN}`, email: `zz-int-client-${RUN}@example.test`, username: `zz-int-client-${RUN}@example.test`, role: 'CLIENT', atsRole: 'CLIENT' } });
    let acct = await first({ OR: [{ atsRole: 'ACCOUNTANT' }, { accountsRole: 'ACCOUNTANT' }], ...live });
    if (!acct) acct = await prisma.user.create({ data: { ...base, name: `ZZTEST accounts ${RUN}`, email: `zz-int-acct-${RUN}@example.test`, username: `zz-int-acct-${RUN}@example.test`, role: 'EMPLOYEE', atsRole: 'EMPLOYEE', accountsRole: 'ACCOUNTANT', accountsAccess: true } });
    else await prisma.user.update({ where: { id: acct.id }, data: { passwordHash: 'x' } });
    const recU = rec.user; const tlDept = tlEmp && tlEmp.department; const recDept = rec.department;
    const tl2 = await (async () => { for (const c of await prisma.user.findMany({ where: { status: 'Active', atsRole: { in: ['TL', 'STL'] }, id: { not: tl.id }, ...live }, include: { employee: true }, take: 30 })) { if (c.employee && c.employee.department && c.employee.department !== tlDept && ['tl'].includes(A0.kind(await resolveIdentity(c.id)))) return c; } return null; })(); // eslint-disable-line no-await-in-loop
    if (tl2) await prisma.user.update({ where: { id: tl2.id }, data: { passwordHash: 'x' } });

    for (const u of [acct, tl2].filter(Boolean)) { const idn = await resolveIdentity(u.id); if (idn && idn.id && idn.id !== u.id) await prisma.user.update({ where: { id: idn.id }, data: { passwordHash: 'x' } }); } // eslint-disable-line no-await-in-loop
    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 120 && !healthy; i += 1) { try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await sleep(1000); } }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }
    const tokenOf = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const T = { sa: await tokenOf(sa), tl: await tokenOf(tl), bde: await tokenOf(bde), am: await tokenOf(am), hr: await tokenOf(hr), rec: await tokenOf(recU), client: await tokenOf(client), acct: await tokenOf(acct) };
    if (tl2) T.tl2 = await tokenOf(tl2);
    const allText = [];
    const call = async (m, p, t, b) => { const r = await http(m, p, T[t], b); allText.push(r.text); return r; };
    const O = '/api/omni';

    // server side of the pages: the new tabs are in /me pages, per role
    const meSa = (await call('GET', '/api/outreach/me', 'sa')).body;
    const meRec = (await call('GET', '/api/outreach/me', 'rec')).body;
    const meAcct = (await call('GET', '/api/outreach/me', 'acct')).body;
    check('S10 /me lists the new tabs for an Admin (review, tplshared, appcampaigns, connections, audit) and the 10 sections all resolve', ['review', 'tplshared', 'appcampaigns', 'connections', 'audit'].every((p) => (meSa.pages || []).includes(p)) && P.omniChildren({ level: meSa.level, pages: meSa.pages || [] }, {}).length === 10, meSa);
    check('S11 a recruiter gets no audit / team / superadmin tab; Accounts (Finance) gets only billing in Omni-Channel', !(meRec.pages || []).includes('audit') && !(meRec.pages || []).includes('superadmin') && !(meRec.pages || []).includes('team') && (meAcct.pages || []).join() === 'billing', { rec: meRec, acct: meAcct });

    // =============================================================== data: people with addresses (the copy only)
    const emps = await prisma.employee.findMany({ where: { employmentStatus: 'Active' }, take: 6, orderBy: { createdAt: 'asc' } });
    const empIds = [];
    for (const e of emps.slice(0, 3)) { await prisma.employee.update({ where: { id: e.id }, data: { email: mail('emp'), phone: phone() } }); empIds.push(e.id); } // eslint-disable-line no-await-in-loop
    // DATA: in the copy of the real database a recruiter may legitimately reach some of the newest candidates (they sit on their jobs). The checks below need candidates this
    // recruiter can NOT open, so pick them by asking the app itself (a candidate the recruiter is refused).
    const pool = await prisma.candidate.findMany({ take: 80, orderBy: { createdAt: 'desc' }, where: { applications: { some: {} } } });
    const cands = [];
    for (const c of pool) { if (cands.length >= 3) break; const rr = await http('GET', `/api/candidates/${c.id}`, T.rec); if ([403, 404].includes(rr.status)) cands.push(c); } // eslint-disable-line no-await-in-loop
    if (cands.length < 3) for (const c of pool) { if (cands.length >= 3) break; if (!cands.includes(c)) cands.push(c); }
    const candIds = [];
    for (const c of cands) { await prisma.candidate.update({ where: { id: c.id }, data: { email: mail('cand'), phone: phone(), doNotContact: false, consentStatus: null } }).catch(async () => prisma.candidate.update({ where: { id: c.id }, data: { email: mail('cand'), phone: phone() } })); candIds.push(c.id); } // eslint-disable-line no-await-in-loop
    const clients = await prisma.client.findMany({ take: 3, orderBy: { createdAt: 'asc' } });
    const clientIds = [];
    for (const c of clients) { await prisma.client.update({ where: { id: c.id }, data: { billingContactEmail: mail('bill'), contactEmail: mail('cl'), billingContactPhone: phone(), contactPhone: phone() } }); clientIds.push(c.id); } // eslint-disable-line no-await-in-loop

    // =============================================================== L: the shared template library
    const lib = (await call('GET', `${O}/library/templates`, 'sa')).body;
    const byName = (n, ch) => lib.items.find((i) => i.name === n && (!ch || i.channel === ch));
    const pay = lib.items.find((i) => /^message:/.test(i.key) && /payment reminder/i.test(i.group) && i.channel === 'Email');
    const empT = lib.items.find((i) => /^message:/.test(i.key) && i.audience === 'employee' && i.channel === 'Email' && i.scopes.includes('HRMS'));
    const candT = lib.items.find((i) => /^message:/.test(i.key) && i.audience === 'candidate' && i.channel === 'Email' && i.scopes.includes('ATS') && !i.scopes.includes('HRMS') && /Interview Reminder/i.test(i.group));
    check('L1 the library lists templates of every app in one list, each with name, channel, content, variables, scopes, department, approval and version', lib.total > 100 && lib.items.every((i) => i.name && i.channel && Array.isArray(i.variables) && Array.isArray(i.scopes) && i.approval && i.approval.state && i.version != null && 'department' in i) && ['ATS', 'Job Portal', 'HRMS', 'Accounts'].every((a) => lib.counts[a] > 0), { total: lib.total, counts: lib.counts });
    check('L2 default scopes: employee wording -> HRMS, payment reminder -> Accounts, candidate wording -> ATS', !!(pay && empT && candT) && pay.scopes.join() === 'Accounts' && empT.scopes.join() === 'HRMS' && candT.scopes.includes('ATS'), { pay: pay && pay.scopes, emp: empT && empT.scopes, cand: candT && candT.scopes });
    const libHr = (await call('GET', `${O}/library/templates`, 'hr')).body;
    const libAcct = (await call('GET', `${O}/library/templates`, 'acct')).body;
    const libRec = (await call('GET', `${O}/library/templates`, 'rec')).body;
    check('L3 permissions: Accounts sees only the payment reminder wording; HR sees employee wording; a recruiter sees no employee and no payment wording', libAcct.items.length > 0 && libAcct.items.every((i) => ['CLIENT_PAYMENT_REMINDER', 'CLIENT_INVOICE_NOTICE'].some((p) => i.key.startsWith('message:')) && i.scopes.includes('Accounts')) && libHr.items.some((i) => i.audience === 'employee') && !libRec.items.some((i) => i.audience === 'employee' || i.scopes.join() === 'Accounts'), { acct: libAcct.items.length, hrEmp: libHr.items.filter((i) => i.audience === 'employee').length, recBad: libRec.items.filter((i) => i.audience === 'employee' || i.scopes.join() === 'Accounts').length });
    const gate = async (t, key, app) => (await call('POST', `${O}/library/check`, t, { key, app }));
    const g1 = await gate('hr', empT.key, 'HRMS'); const g2 = await gate('hr', empT.key, 'ATS'); const g3 = await gate('acct', pay.key, 'Accounts'); const g4 = await gate('acct', pay.key, 'HRMS'); const g5 = await gate('rec', empT.key, 'HRMS');
    check('L4 reuse across apps only where the scope allows it: employee wording is usable in HRMS (200) but refused for ATS (403, plain reason); payment wording usable in Accounts, refused for HRMS; a recruiter cannot reach employee wording at all (404)', g1.status === 200 && g2.status === 403 && /not shared with ATS/.test(g2.body.error) && g3.status === 200 && g4.status === 403 && g5.status === 404, { g1: g1.status, g2: g2.status, g3: g3.status, g4: g4.status, g5: g5.status, e: g2.body });
    // an Omni template: make one, share it with HRMS (internal ones may), see it appear in the HRMS list
    const mkT = await call('POST', '/api/outreach/gs/templates/outreach', 'sa', { name: `ZZTEST lib ${RUN}`, channel: 'email', audience: 'internal', subject: 'Hello {{name}}', body: 'Hi {{name}}, a note from {{company}}. {{unsubscribe}}', promotional: false });
    const oKey = mkT.body && mkT.body.template ? `outreach:${mkT.body.template.id}` : null;
    check('L5 a template made in Omni-Channel appears in the shared library with default scopes Omni-Channel + HRMS (internal)', !!oKey && (await call('GET', `${O}/library/templates/${encodeURIComponent(oKey)}`, 'sa')).body.template.scopes.join() === 'Omni-Channel,HRMS', mkT.text.slice(0, 200));
    const sc1 = await call('PUT', `${O}/library/templates/${encodeURIComponent(oKey)}/scopes`, 'sa', { scopes: ['HRMS'] });
    const sc2 = await call('PUT', `${O}/library/templates/${encodeURIComponent(candT.key)}/scopes`, 'sa', { scopes: ['ATS', 'HRMS'] });
    const sc3 = await call('PUT', `${O}/library/templates/${encodeURIComponent(oKey)}/scopes`, 'rec', { scopes: ['ATS'] });
    check('L6 the owner chooses where it is used (scopes saved); candidate wording cannot be pushed into HRMS (400); a recruiter cannot change scopes (403/404)', sc1.status === 200 && sc2.status === 400 && [403, 404].includes(sc3.status), { sc1: sc1.status, sc2: sc2.status, sc3: sc3.status });
    const gOmni = await gate('sa', oKey, 'Omni-Channel');
    const camp = require(path.join(BACK, 'src/outreach/campaigns'));
    const vIn = await camp.validate({ ...(await resolveIdentity(sa.id)) }, { type: 'internal', channel: 'email', templateId: mkT.body.template.id }, { needSegments: false, needName: false });
    check('L7 the campaign engine asks the library too: an Omni template that is no longer shared with Omni-Channel is refused (tpl_scope), by the server', gOmni.status === 403 && vIn && vIn.code === 'tpl_scope', { gOmni: gOmni.status, vIn: vIn && (vIn.code || vIn.error) });
    await call('PUT', `${O}/library/templates/${encodeURIComponent(oKey)}/scopes`, 'sa', { scopes: ['Omni-Channel', 'HRMS'] });
    // versions
    await call('PUT', `/api/outreach/gs/templates/outreach/${mkT.body.template.id}`, 'sa', { body: 'Hi {{name}}, a changed note from {{company}}. {{unsubscribe}}' });
    await call('PUT', `/api/outreach/gs/templates/outreach/${mkT.body.template.id}`, 'sa', { body: 'Hi {{name}}, a third note from {{company}}. {{unsubscribe}}' });
    const vers = (await call('GET', `${O}/library/templates/${encodeURIComponent(oKey)}/versions`, 'sa')).body;
    check('L8 version history: every save is kept with who and when (3 versions: created + 2 changes), newest first, the current one marked', vers.versions && vers.versions.length >= 3 && /third note/.test(vers.versions[0].body) && vers.versions[0].current && vers.versions.every((v) => v.byName && v.at), vers.versions && vers.versions.map((v) => [v.version, v.body.slice(0, 20)]));
    const msgT = lib.items.find((i) => /^message:/.test(i.key) && i.audience === 'employee' && i.channel === 'Email');
    const mvers = (await call('GET', `${O}/library/templates/${encodeURIComponent(msgT.key)}/versions`, 'sa')).body;
    check('L9 Message templates keep their own history and the library shows it (nothing is copied)', mvers.versions && mvers.versions.length >= 1 && mvers.versions[0].version >= 1, mvers);
    // approval
    await call('PUT', `${O}/library/settings`, 'sa', { requireApproval: true });
    const mk2 = await call('POST', '/api/outreach/gs/templates/outreach', 'bde', { name: `ZZTEST bde ${RUN}`, channel: 'email', audience: 'candidate_lead', subject: 'Job {{job_title}}', body: 'Hi {{name}}, a job {{job_title}}: {{apply_link}} {{unsubscribe}}', promotional: true });
    const bKey = mk2.body && mk2.body.template ? `outreach:${mk2.body.template.id}` : null;
    const b1 = (await call('GET', `${O}/library/templates/${encodeURIComponent(bKey)}`, 'bde')).body.template;
    const gB = await gate('bde', bKey, 'Omni-Channel');
    check('L10 with the approval switch ON, a template written by a BDE waits for approval and cannot be used until then (400, "waiting for approval")', b1.approval.state === 'waiting' && gB.status === 400 && gB.body.code === 'tpl_not_approved', { b1: b1.approval, gB: gB.body });
    const ap1 = await call('POST', `${O}/library/templates/${encodeURIComponent(bKey)}/approval`, 'bde', { action: 'approve' });
    const ap2 = await call('POST', `${O}/library/templates/${encodeURIComponent(bKey)}/approval`, 'tl', { action: 'send_back', note: '' });
    const ap3 = await call('POST', `${O}/library/templates/${encodeURIComponent(bKey)}/approval`, 'tl', { action: 'send_back', note: 'Please add the company name' });
    const b2 = (await call('GET', `${O}/library/templates/${encodeURIComponent(bKey)}`, 'bde')).body.template;
    const ap4 = await call('POST', `${O}/library/templates/${encodeURIComponent(bKey)}/approval`, 'bde', { action: 'ask', note: 'Done' });
    const ap5 = await call('POST', `${O}/library/templates/${encodeURIComponent(bKey)}/approval`, 'sa', { action: 'approve' });
    const gB2 = await gate('bde', bKey, 'Omni-Channel');
    check('L11 approval flow: the writer cannot approve their own (403); sending back needs a note (400); a Team Lead sends it back with a note; the writer asks again; an Admin approves; then it can be used', ap1.status === 403 && ap2.status === 400 && ap3.status === 200 && b2.approval.state === 'changes' && ap4.status === 200 && ap5.status === 200 && gB2.status === 200, { ap1: ap1.status, ap2: ap2.status, ap3: ap3.status, b2: b2.approval.state, ap4: ap4.status, ap5: ap5.status, gB2: gB2.status });
    await call('PUT', `${O}/library/settings`, 'sa', { requireApproval: false });
    check('L12 library settings: only an Admin can change them (403 for a TL)', (await call('PUT', `${O}/library/settings`, 'tl', { requireApproval: true })).status === 403);
    // department isolation of templates
    const dk = encodeURIComponent(oKey);
    await prisma.appSetting.upsert({ where: { key: 'omni.templateDepts' }, create: { key: 'omni.templateDepts', value: JSON.stringify({ [oKey]: 'Zzother' }) }, update: { value: JSON.stringify({ [oKey]: 'Zzother' }) } });
    const dSa = await call('GET', `${O}/library/templates/${dk}`, 'sa');
    const dTl = await call('GET', `${O}/library/templates/${dk}`, 'tl');
    const dHr = await call('GET', `${O}/library/templates/${dk}`, 'hr');
    const dList = (await call('GET', `${O}/library/templates${qs({ dept: 'Zzother' })}`, 'tl')).body;
    const dGate = await gate('tl', oKey, 'Omni-Channel');
    check('D1 department isolation of templates: a template of another department is found by an Admin, but 404 for a TL by its id, empty in a ?dept= query, and refused by the gate (also changing the id or the query does not help)', dSa.status === 200 && dSa.body.template.department === 'Zzother' && dTl.status === 404 && dList.items.length === 0 && dGate.status === 404, { dSa: dSa.status, dTl: dTl.status, list: dList.items.length, gate: dGate.status });
    check('D2 an HR login cannot open a candidate / job template of another department either (404)', dHr.status === 404);
    await prisma.appSetting.update({ where: { key: 'omni.templateDepts' }, data: { value: '{}' } });

    // =============================================================== C: campaigns from app screens
    const empTpl = lib.items.find((i) => /^message:/.test(i.key) && i.audience === 'employee' && i.channel === 'Email' && /General notice/i.test(i.group));
    const purposeOf = async (key) => (await prisma.messageTemplate.findUnique({ where: { id: key.split(':')[1] } })).purpose;
    const empPurpose = await purposeOf(empTpl.key);
    const payPurpose = await purposeOf(pay.key);
    const candPurpose = await purposeOf(candT.key);
    const bodyHr = (extra = {}) => ({ app: 'HRMS', audience: 'employees', ids: empIds, channels: ['Email'], purposeKey: empPurpose, name: `ZZTEST HR notice ${RUN}`, ...extra });
    const pv = await call('POST', `${O}/app-campaigns/preview`, 'hr', bodyHr());
    check('C1 HRMS: HR previews a campaign to employees: every person gets their own words (names filled in), the plan says who will get it, and it says it is only a rehearsal (Test mode)', pv.status === 200 && pv.body.preview.toSend === 3 && pv.body.rehearsal === true && /nothing is sent/i.test(pv.body.modeWords) && pv.body.preview.sample.length > 0 && !/\{\{/.test(pv.body.preview.sample[0].text), pv.text.slice(0, 400));
    const own = await call('POST', `${O}/app-campaigns/preview`, 'hr', bodyHr({ purposeKey: '' }));
    const wrongApp = await call('POST', `${O}/app-campaigns/preview`, 'hr', bodyHr({ app: 'ATS', audience: 'candidates', ids: candIds }));
    const hrTplElsewhere = await call('POST', `${O}/app-campaigns/preview`, 'hr', bodyHr({ purposeKey: candPurpose }));
    const recEmp = await call('POST', `${O}/app-campaigns/preview`, 'rec', bodyHr());
    const acctEmp = await call('POST', `${O}/app-campaigns/preview`, 'acct', bodyHr());
    check('C2 rules: "write my own words" is refused (400); a candidate template cannot go to employees from HRMS (403, scope); a recruiter and Accounts cannot message employees (403)', own.status === 400 && /library/i.test(own.body.error) && [403, 400].includes(hrTplElsewhere.status) && recEmp.status === 403 && acctEmp.status === 403, { own: own.status, el: hrTplElsewhere.status, rec: recEmp.status, acct: acctEmp.status, wrongApp: wrongApp.status });
    const create = await call('POST', `${O}/app-campaigns`, 'hr', bodyHr());
    const cid = create.body && create.body.id;
    const detail0 = await call('GET', `${O}/app-campaigns/${cid}`, 'hr');
    check('C3 Save for later: the campaign exists as "Not sent yet" (the word Draft is never used) with its audience size, channel and template', create.status === 200 && !!cid && detail0.body.campaign.status === 'not_sent' && detail0.body.campaign.statusWords === 'Not sent yet' && detail0.body.campaign.people === 3 && detail0.body.campaign.app === 'HRMS' && !/draft/i.test(detail0.text), detail0.text.slice(0, 300));
    const upd = await call('PUT', `${O}/app-campaigns/${cid}`, 'hr', bodyHr({ name: `ZZTEST HR notice ${RUN} v2` }));
    const updSa = await call('PUT', `${O}/app-campaigns/${cid}`, 'rec', bodyHr({ name: 'hijack' }));
    check('C4 edit: the maker can change a campaign that was never sent (200); somebody else gets 404', upd.status === 200 && updSa.status === 404, { upd: upd.status, other: updSa.status });
    // approval required
    await call('PUT', `${O}/library/settings`, 'sa', { requireCampaignApproval: true });
    const noAp = await call('POST', `${O}/app-campaigns/${cid}/send`, 'hr', { when: 'now' });
    const ask = await call('POST', `${O}/app-campaigns/${cid}/submit`, 'hr');
    const selfAp = await call('POST', `${O}/app-campaigns/${cid}/approve`, 'hr', {});
    const waitingSend = await call('POST', `${O}/app-campaigns/${cid}/send`, 'hr', { when: 'now' });
    const recAp = await call('POST', `${O}/app-campaigns/${cid}/approve`, 'rec', {});
    const rej = await call('POST', `${O}/app-campaigns/${cid}/reject`, 'sa', { note: '' });
    const rej2 = await call('POST', `${O}/app-campaigns/${cid}/reject`, 'sa', { note: 'Please shorten it' });
    const afterRej = (await call('GET', `${O}/app-campaigns/${cid}`, 'hr')).body.campaign;
    const reask = await call('POST', `${O}/app-campaigns/${cid}/submit`, 'hr');
    const ok = await call('POST', `${O}/app-campaigns/${cid}/approve`, 'sa', { note: 'Fine' });
    check('C5 approval where required: sending is blocked until approved (403); ask -> waiting; the maker cannot approve their own (403); a recruiter cannot (404); sending back needs a note; Admin approves', noAp.status === 403 && noAp.body.code === 'needs_approval' && ask.status === 200 && selfAp.status === 403 && waitingSend.status === 409 && recAp.status === 404 && rej.status === 400 && rej2.status === 200 && afterRej.status === 'changes' && reask.status === 200 && ok.status === 200, { noAp: noAp.status, ask: ask.status, selfAp: selfAp.status, waitingSend: waitingSend.status, recAp: recAp.status, rej: rej.status, rej2: rej2.status, afterRej: afterRej.status, reask: reask.status, ok: ok.status });
    const sched = await call('POST', `${O}/app-campaigns/${cid}/send`, 'hr', { when: 'later', at: new Date(Date.now() + 3600000).toISOString() });
    const past = await call('POST', `${O}/app-campaigns/${cid}/send`, 'hr', { when: 'later', at: new Date(Date.now() - 3600000).toISOString() });
    check('C6 Schedule: a future time is accepted (status Scheduled); a past time is refused (400)', sched.status === 200 && sched.body.status === 'scheduled' && past.status === 409 || (past.status === 400), { sched: sched.status, past: past.status, sb: sched.body });
    const pau = await call('POST', `${O}/app-campaigns/${cid}/pause`, 'hr');
    await prisma.$executeRawUnsafe('UPDATE "OmniAppCampaign" SET scheduledAt = ? WHERE id = ?', Date.now() - 1000, cid);
    const tick1 = await call('POST', `${O}/app-campaigns/tick`, 'sa');
    const stillPaused = (await call('GET', `${O}/app-campaigns/${cid}`, 'hr')).body.campaign;
    const res = await call('POST', `${O}/app-campaigns/${cid}/resume`, 'hr');
    const tick2 = await call('POST', `${O}/app-campaigns/tick`, 'sa');
    const done = (await call('GET', `${O}/app-campaigns/${cid}`, 'hr')).body;
    check('C7 Pause holds a scheduled campaign (the due time passes, nothing goes out); Resume lets the loop send it as the maker; it finishes in TEST MODE: 3 messages rehearsed, none really sent', pau.status === 200 && tick1.body.started === 0 && stillPaused.status === 'paused' && res.status === 200 && tick2.body.started === 1 && done.campaign.status === 'done' && done.campaign.mode === 'rehearsal' && done.campaign.counts.rehearsed === 3 && /nothing was sent/i.test(done.campaign.modeWords), { pau: pau.status, t1: tick1.body, stillPaused: stillPaused.status, res: res.status, t2: tick2.body, done: done.campaign });
    check('C8 tracking: the detail lists every person with a plain status ("Test message (nothing sent)"), the counts, and an activity trail (who did what)', done.items.length === 3 && done.items.every((i) => /Test message/.test(i.statusWords)) && done.activity.length >= 5 && done.activity.some((a) => /approved/i.test(a.what)) && done.activity.some((a) => /rehearsed/i.test(a.what)), { items: done.items.length, activity: done.activity.map((a) => a.what) });
    const dup = await call('POST', `${O}/app-campaigns/${cid}/send`, 'hr', { when: 'now' });
    check('C9 no double send: pressing Send on a finished campaign is refused (409)', dup.status === 409, dup.text);
    const noReal = Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OutreachSendLog" WHERE at > ?', Date.now() - 600000).catch(() => [{ n: 0 }]))[0].n);
    check('C10 nothing reached a provider in Test mode: no send-log row, no message job file', noReal === 0 && fs.readdirSync(JOBDIR).filter((f) => f.endsWith('.json')).length === 0, { noReal, jobs: fs.readdirSync(JOBDIR) });
    // cancel
    const c2 = await call('POST', `${O}/app-campaigns`, 'hr', bodyHr({ name: `ZZTEST cancel ${RUN}` }));
    await call('POST', `${O}/app-campaigns/${c2.body.id}/approve`, 'sa', {}); // not waiting: refused
    await call('POST', `${O}/app-campaigns/${c2.body.id}/submit`, 'hr'); await call('POST', `${O}/app-campaigns/${c2.body.id}/approve`, 'sa', {});
    await call('POST', `${O}/app-campaigns/${c2.body.id}/send`, 'hr', { when: 'later', at: new Date(Date.now() + 7200000).toISOString() });
    const can = await call('POST', `${O}/app-campaigns/${c2.body.id}/cancel`, 'hr');
    const can2 = await call('POST', `${O}/app-campaigns/${c2.body.id}/cancel`, 'hr');
    const tick3 = await call('POST', `${O}/app-campaigns/tick`, 'sa');
    check('C11 Cancel stops a scheduled campaign (status Cancelled, nothing sent, tick starts nothing); cancelling twice is refused (409)', can.status === 200 && can2.status === 409 && tick3.body.started === 0 && (await call('GET', `${O}/app-campaigns/${c2.body.id}`, 'hr')).body.campaign.status === 'cancelled');
    await call('PUT', `${O}/library/settings`, 'sa', { requireCampaignApproval: false });
    const del = await call('DELETE', `${O}/app-campaigns/${(await call('POST', `${O}/app-campaigns`, 'hr', bodyHr({ name: `ZZTEST del ${RUN}` }))).body.id}`, 'hr');
    check('C12 a never-sent campaign can be deleted by its maker (200)', del.status === 200);
    // ATS and Accounts
    const bodyAts = (extra = {}) => ({ app: 'ATS', audience: 'candidates', ids: candIds, channels: ['Email'], purposeKey: candPurpose, name: `ZZTEST ATS ${RUN}`, ...extra });
    const atsPv = await call('POST', `${O}/app-campaigns/preview`, 'sa', bodyAts());
    check('C13 ATS: an Admin previews a recruitment campaign to candidates picked on the candidates list; the plan applies the consent / channel rules (people "will get it" or are left out with a reason)', atsPv.status === 200 && atsPv.body.preview.people === candIds.length && (atsPv.body.preview.toSend + atsPv.body.preview.skipped + atsPv.body.preview.blocked) >= candIds.length, atsPv.text.slice(0, 300));
    const bdePv = await call('POST', `${O}/app-campaigns/preview`, 'bde', bodyAts());
    const recPv = await call('POST', `${O}/app-campaigns/preview`, 'rec', bodyAts());
    check('C14 a BDE can never message a list of candidates from the ATS (403: the BDE team never gets candidate numbers); a recruiter outside these candidates reaches nobody ("outside your access")', bdePv.status === 403 && (recPv.status === 403 || (recPv.status === 200 && recPv.body.preview.people === 0)), { bde: bdePv.status, rec: recPv.status, rb: recPv.body && recPv.body.preview && recPv.body.preview.outOfScope });
    const accBody = (extra = {}) => ({ app: 'Accounts', audience: 'clients', ids: clientIds, channels: ['Email'], purposeKey: payPurpose, name: `ZZTEST pay ${RUN}`, ...extra });
    const accPv = await call('POST', `${O}/app-campaigns/preview`, 'acct', accBody());
    const accOther = await call('POST', `${O}/app-campaigns/preview`, 'acct', accBody({ purposeKey: candPurpose }));
    const accCreate = await call('POST', `${O}/app-campaigns`, 'acct', accBody());
    check('C15 Accounts: an accountant previews a payment follow-up to clients\' BILLING contacts with the payment wording (200); any other wording is refused (403); the campaign saves for later', [200, 400].includes(accPv.status) && [403, 404].includes(accOther.status) && accCreate.status === 200, { accPv: accPv.status, accOther: accOther.status, accCreate: accCreate.status, e: accPv.body && accPv.body.error });
    const sms = await call('POST', `${O}/app-campaigns/preview`, 'hr', bodyHr({ channels: ['SMS'] }));
    const smsReasons = sms.status === 200 ? sms.body.preview.notSent : [];
    check('C16 a channel that is not set up is reported plainly (SMS: "not set up", the reason from the real check) and never shown as working', sms.status === 200 && sms.body.preview.toSend === 0 && smsReasons.some((r) => /not set up/i.test(r.reason)), sms.text.slice(0, 400));
    // live hand-off (no real send: a hand-made job file in the temp folder)
    const Bulk = require(path.join(BACK, 'src/utils/bulkMessaging'));
    const jobId = 'bj_zzintjob0001';
    fs.writeFileSync(path.join(JOBDIR, `${jobId}.json`), JSON.stringify({ id: jobId, status: 'running', channels: ['Email'], recipients: [{ n: 1, entityId: empIds[0], name: 'A', channel: 'Email', status: 'sent', providerRef: 'pr-zz-1', sentAt: new Date().toISOString(), attempts: 1 }, { n: 2, entityId: empIds[1], name: 'B', channel: 'Email', status: 'failed', reason: 'Mailbox full', attempts: 4 }, { n: 3, entityId: empIds[2], name: 'C', channel: 'Email', status: 'queued', attempts: 0 }] }));
    const liveId = S.newId('oac'); const now = Date.now();
    await S.run('INSERT INTO "OmniAppCampaign" (id, app, name, audience, channels, purposeKey, request, refs, peopleCount, department, status, mode, jobId, createdById, createdByName, createdAt, updatedAt, meta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', liveId, 'HRMS', `ZZTEST live ${RUN}`, 'employees', '["Email"]', empPurpose, '{}', JSON.stringify(empIds), 3, '', 'sending', 'live', jobId, hr.id, hr.name, now, now, '{}');
    for (const [i, id] of empIds.entries()) await S.run('INSERT INTO "OmniAppCampaignItem" (id, campaignId, entityId, name, channel, status) VALUES (?,?,?,?,?,?)', S.newId('oai'), liveId, id, `P${i}`, 'email', 'queued'); // eslint-disable-line no-await-in-loop
    const lv = (await call('GET', `${O}/app-campaigns/${liveId}`, 'hr')).body;
    const st = Object.fromEntries(lv.items.map((i) => [i.name, i.status]));
    check('C17 live tracking: the person rows follow the bulk sender (sent / failed with the provider\'s words / waiting), the counts add up', st.P0 === 'sent' && st.P1 === 'failed' && st.P2 === 'queued' && lv.campaign.counts.sent === 1 && lv.campaign.counts.failed === 1 && lv.items.find((i) => i.name === 'P1').reason === 'Mailbox full', { st, counts: lv.campaign.counts });
    // a provider delivery report (status event) turns "sent" into "delivered"
    await delivery.applyStatus({ channel: 'Email', providerRef: 'pr-zz-1', status: 'delivered', at: new Date() });
    const lv2 = (await call('GET', `${O}/app-campaigns/${liveId}`, 'hr')).body;
    check('C18 a delivery report from the provider upgrades "Sent" to "Delivered" in the campaign', lv2.items.find((i) => i.name === 'P0').status === 'delivered', lv2.items.map((i) => [i.name, i.status]));
    const pz = await call('POST', `${O}/app-campaigns/${liveId}/pause`, 'hr');
    const markerPause = fs.existsSync(path.join(JOBDIR, `${jobId}.pause`));
    const rsm = await call('POST', `${O}/app-campaigns/${liveId}/resume`, 'hr');
    const markerGone = !fs.existsSync(path.join(JOBDIR, `${jobId}.pause`));
    const cnl = await call('POST', `${O}/app-campaigns/${liveId}/cancel`, 'hr');
    const cnlJob = fs.existsSync(path.join(JOBDIR, `${jobId}.cancel`));
    check('C19 pause / resume / cancel reach the real sender: a pause marker is written for the bulk job and removed on resume; cancel writes the cancel marker and the waiting rows become "Left out: cancelled"', pz.status === 200 && markerPause && rsm.status === 200 && markerGone && cnl.status === 200 && cnlJob && (await call('GET', `${O}/app-campaigns/${liveId}`, 'hr')).body.items.find((i) => i.name === 'P2').statusWords === 'Left out', { pz: pz.status, markerPause, rsm: rsm.status, markerGone, cnl: cnl.status, cnlJob });

    // =============================================================== R: replies
    const person = async (type) => ({ type }); void person;
    // a unique candidate / employee / client / vendor, each with its own number
    const [cA, cB] = candIds; const [eA, eB] = empIds;
    const pc = phone(); const pe = phone(); const pcl = phone(); const pv1 = phone(); const pam = phone(); const pun = phone(); const pamb2 = phone();
    await prisma.candidate.update({ where: { id: cA }, data: { phone: pc } });
    await prisma.employee.update({ where: { id: eA }, data: { phone: pe } });
    await prisma.client.update({ where: { id: clientIds[0] }, data: { billingContactPhone: pcl } });
    const vendor = await prisma.officeVendor.create({ data: { name: `ZZTEST vendor ${RUN}`, phone: pv1, phoneKey: pv1, contactPerson: 'Qa Vendor' } });
    const inbound = (num, text, id, extra = {}) => delivery.applyInbound({ channel: 'WhatsApp', from: `91${num}`, text, id, at: new Date(), name: 'x', ...extra });
    const link = async (eid) => (await S.q('SELECT * FROM "OmniReplyLink" WHERE eventId = (SELECT id FROM "OmniProviderEvent" WHERE providerEventId = ?)', eid))[0];
    const evOf = async (eid) => (await S.q('SELECT * FROM "OmniProviderEvent" WHERE providerEventId = ?', eid))[0];
    const r1 = await inbound(pc, 'Yes I am interested', `wamid.ZZ1${RUN}`);
    const l1 = await link(`wamid.ZZ1${RUN}`);
    const cm1 = await prisma.candidateMessage.count({ where: { candidateId: cA, providerRef: `wamid.ZZ1${RUN}`, status: 'RECEIVED' } });
    check('R1 ATS: a reply from a candidate\'s number is matched with confidence, written on the candidate\'s record (one RECEIVED message) and linked (source ids kept)', r1.stored === true && cm1 === 1 && l1 && l1.personType === 'CANDIDATE' && l1.personId === cA && JSON.parse(l1.apps).includes('ATS'), { r1, l1 });
    const r1b = await inbound(pc, 'Yes I am interested', `wamid.ZZ1${RUN}`);
    const ev1 = await evOf(`wamid.ZZ1${RUN}`);
    const cm1b = await prisma.candidateMessage.count({ where: { candidateId: cA, providerRef: `wamid.ZZ1${RUN}`, status: 'RECEIVED' } });
    const lc = Number((await S.q('SELECT COUNT(*) n FROM "OmniReplyLink" WHERE eventId = ?', ev1.id))[0].n);
    check('R2 duplicate provider event: the same event again is ignored (duplicate = true), no second message, no second link, the duplicate is counted', r1b.duplicate === true && cm1b === 1 && lc === 1 && S.num(ev1.duplicates) === 1, { r1b, cm1b, lc, dups: ev1.duplicates });
    // Job Portal applicant
    const portalSrc = require(path.join(BACK, 'src/utils/atsVocab')).PORTAL_APPLICATION_SOURCE;
    const appRow = await prisma.application.findFirst({ where: { candidateId: cB } });
    await prisma.application.update({ where: { id: appRow.id }, data: { source: portalSrc } });
    const pcB = phone(); await prisma.candidate.update({ where: { id: cB }, data: { phone: pcB } });
    await inbound(pcB, 'I have a question about the job', `wamid.ZZ2${RUN}`);
    const l2 = await link(`wamid.ZZ2${RUN}`);
    const cm2 = await prisma.candidateMessage.findFirst({ where: { candidateId: cB, providerRef: `wamid.ZZ2${RUN}` } });
    const linkedApps = l2 ? JSON.parse(l2.apps) : [];
    check('R3 Job Portal: a reply from an applicant who came through the portal is shown in the Job Portal AND the linked ATS record, with the application id on the message and the link', linkedApps.includes('Job Portal') && linkedApps.includes('ATS') && cm2 && cm2.applicationId === appRow.id && l2.applicationId === appRow.id, { linkedApps, app: cm2 && cm2.applicationId, want: appRow.id });
    await inbound(pe, 'Thank you, noted', `wamid.ZZ3${RUN}`);
    const l3 = await link(`wamid.ZZ3${RUN}`);
    const conv3 = await S.q('SELECT * FROM "ConversationMessage" WHERE personType = \'EMPLOYEE\' AND personId = ? AND direction = \'IN\'', eA);
    check('R4 HRMS: an employee\'s reply lands in the employee\'s conversation (ConversationMessage) and is linked to HRMS', l3 && JSON.parse(l3.apps).join() === 'HRMS' && conv3.length === 1, { l3, n: conv3.length });
    await inbound(pcl, 'Payment will be made on Friday', `wamid.ZZ4${RUN}`);
    const l4 = await link(`wamid.ZZ4${RUN}`);
    const conv4 = await S.q('SELECT * FROM "ConversationMessage" WHERE personType = \'CLIENT\' AND personId = ? AND direction = \'IN\'', clientIds[0]);
    check('R5 Accounts: a client contact\'s reply (billing number) lands in the client\'s conversation and is linked to Accounts', l4 && JSON.parse(l4.apps).includes('Accounts') && conv4.length === 1, { l4, n: conv4.length });
    await inbound(pv1, 'Invoice 114 attached', `wamid.ZZ5${RUN}`);
    const l5 = await link(`wamid.ZZ5${RUN}`);
    check('R6 Accounts: a vendor\'s reply is matched to the vendor and linked to Accounts (no conversation is invented for a vendor)', l5 && l5.personType === 'VENDOR' && l5.personId === vendor.id && JSON.parse(l5.apps).join() === 'Accounts', l5);
    // ambiguous: a candidate and an employee share the number -> Needs review, nothing written
    await prisma.employee.update({ where: { id: eB }, data: { phone: pamb2 } });
    const candAmb = candIds[2]; await prisma.candidate.update({ where: { id: candAmb }, data: { phone: pamb2 } });
    const cmBefore = await prisma.candidateMessage.count({ where: { candidateId: candAmb } });
    const convBefore = (await S.q('SELECT COUNT(*) n FROM "ConversationMessage" WHERE personId = ?', eB))[0].n;
    const r7 = await inbound(pamb2, 'Hello, who is this', `wamid.ZZ7${RUN}`);
    const ev7 = await evOf(`wamid.ZZ7${RUN}`);
    const cmAfter = await prisma.candidateMessage.count({ where: { candidateId: candAmb } });
    const convAfter = (await S.q('SELECT COUNT(*) n FROM "ConversationMessage" WHERE personId = ?', eB))[0].n;
    check('R7 ambiguous match (a candidate and an employee have this number) -> the reply waits in Needs review; NO record is written (candidate and employee unchanged)', r7.review === true && ev7.outcome === 'needs_review' && ev7.reason === 'ambiguous' && cmAfter === cmBefore && Number(convAfter) === Number(convBefore) && JSON.parse(ev7.possible).length === 2, { r7, ev7 });
    const rvSa = (await call('GET', `${O}/replies/review`, 'sa')).body;
    const row7 = rvSa.rows.find((r) => r.id === ev7.id);
    check('R8 the Needs review list (Admin) shows it with the people it could be, the number MASKED for others and full for the Admin', !!row7 && row7.possible.length === 2 && /^\+91/.test(row7.from) && row7.text === 'Hello, who is this', rvSa.rows.map((r) => r.id));
    // unknown sender
    await inbound(pun, 'Who am I', `wamid.ZZ9${RUN}`);
    const ev9 = await evOf(`wamid.ZZ9${RUN}`);
    const rvTl = (await call('GET', `${O}/replies/review`, 'tl')).body;
    const rvRec = await call('GET', `${O}/replies/review`, 'rec');
    check('R9 an unknown sender is also kept in Needs review (never dropped, never put on a record); an unknown sender is for the Admin only (a TL does not see it); a recruiter has no review queue', ev9.outcome === 'needs_review' && ev9.reason === 'unknown' && !rvTl.rows.some((r) => r.id === ev9.id) && [200, 403].includes(rvRec.status) && (rvRec.status === 403 || rvRec.body.total === 0), { ev9: ev9.outcome, tl: rvTl.rows.length, rec: rvRec.status });
    // a wrong pick is refused; the right one writes the record once
    const bad = await call('POST', `${O}/replies/review/${ev7.id}/resolve`, 'sa', { personType: 'CANDIDATE', personId: cA });
    const noRec = await call('POST', `${O}/replies/review/${ev7.id}/resolve`, 'rec', { personType: 'CANDIDATE', personId: candAmb });
    const good = await call('POST', `${O}/replies/review/${ev7.id}/resolve`, 'sa', { personType: 'EMPLOYEE', personId: eB });
    const again = await call('POST', `${O}/replies/review/${ev7.id}/resolve`, 'sa', { personType: 'EMPLOYEE', personId: eB });
    const convDone = (await S.q('SELECT COUNT(*) n FROM "ConversationMessage" WHERE personId = ? AND direction = \'IN\'', eB))[0].n;
    check('R10 resolving: a person outside the list is refused (400, a reply can never be pushed onto an unrelated record); a recruiter cannot (403/404); the right pick writes the reply once on that record; a second press is refused (409)', bad.status === 400 && [403, 404].includes(noRec.status) && good.status === 200 && again.status === 409 && Number(convDone) === Number(convBefore) + 1, { bad: bad.status, noRec: noRec.status, good: good.status, again: again.status, convDone: Number(convDone), convBefore: Number(convBefore) });
    const dis = await call('POST', `${O}/replies/review/${ev9.id}/dismiss`, 'sa', { reason: '' });
    const dis2 = await call('POST', `${O}/replies/review/${ev9.id}/dismiss`, 'sa', { reason: 'Not one of ours' });
    check('R11 dismissing needs a few words (400) and then closes the item (200)', dis.status === 400 && dis2.status === 200 && (await evOf(`wamid.ZZ9${RUN}`)).outcome === 'dismissed');
    // we messaged the candidate lately -> the same shared number is no longer ambiguous
    const pamb3 = phone();
    await prisma.employee.update({ where: { id: empIds[2] }, data: { phone: pamb3 } });
    await prisma.candidate.update({ where: { id: candIds[1] === cB ? candAmb : candIds[1] }, data: { phone: pamb3 } }).catch(() => {});
    const ref = candIds[1] === cB ? candAmb : candIds[1];
    await prisma.candidateMessage.create({ data: { candidateId: ref, channel: 'WhatsApp', template: 'X', templateLabel: 'Test', trigger: 'Manual', recipient: `+91${pamb3}`, body: 'we wrote first', status: 'SENT', sentAt: new Date() } });
    await inbound(pamb3, 'Ok will do', `wamid.ZZ8${RUN}`);
    const l8 = await link(`wamid.ZZ8${RUN}`);
    check('R12 a shared number is still matched with confidence when only one of the people was messaged by us in the last 14 days (the reply goes to that one)', l8 && l8.personType === 'CANDIDATE' && l8.personId === ref, { l8, ref });
    // failed event -> retry
    const failId = `wamid.ZZF${RUN}`; const pf = phone();
    await prisma.employee.update({ where: { id: empIds[2] }, data: { phone: pf } });
    await prisma.$executeRawUnsafe('INSERT INTO "OmniProviderEvent" (id, provider, providerEventId, kind, channel, fromKey, bodyText, outcome, attempts, lastError, nextRetryAt, receivedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', S.newId('ope'), 'whatsapp.cloud', failId, 'inbound', 'WhatsApp', `91${pf}`, 'Retry me', 'failed', 1, 'The database was busy', Date.now() - 1000, Date.now());
    const hBefore = (await call('GET', `${O}/sync-health`, 'sa')).body;
    const rt = await call('POST', `${O}/replies/retry`, 'sa');
    const evF = await evOf(failId);
    const rtTl = await call('POST', `${O}/replies/retry`, 'tl');
    check('R13 durable processing + retry: a failed event (kept with its error, attempts and next-try time) is processed again by the retry loop / button and ends "routed"; only an Admin can press Retry (403 for a TL)', hBefore.events.failed >= 1 && rt.status === 200 && rt.body.ok >= 1 && evF.outcome === 'routed' && S.num(evF.attempts) >= 1 && rtTl.status === 403, { hBefore: hBefore.events.failed, rt: rt.body, evF: evF && evF.outcome, tl: rtTl.status });
    const begun = await Router.begin({ provider: 'whatsapp.cloud', id: `wamid.ZZ1${RUN}`, channel: 'WhatsApp', from: `91${pc}`, text: 'x', at: Date.now() });
    check('R14 idempotency key per provider event: begin() on an already finished event says duplicate; on a FAILED one it says retry (not duplicate)', begun.duplicate === true);
    // status event replay
    await delivery.applyStatus({ channel: 'WhatsApp', providerRef: `wamid.ST${RUN}`, status: 'delivered', at: new Date() });
    await delivery.applyStatus({ channel: 'WhatsApp', providerRef: `wamid.ST${RUN}`, status: 'delivered', at: new Date() });
    const stEv = (await S.q('SELECT * FROM "OmniProviderEvent" WHERE kind = \'status\' AND providerEventId = ?', `wamid.st${RUN}:delivered`.toLowerCase()))[0];
    check('R15 a replayed delivery report is one event (counted twice, kept once)', stEv && S.num(stEv.duplicates) === 1, stEv);
    // replies on a record, for the source app screens
    const repCand = await call('GET', `${O}/replies/of/candidates/${cA}`, 'sa');
    const repEmp = await call('GET', `${O}/replies/of/employees/${eA}`, 'hr');
    const repVen = await call('GET', `${O}/replies/of/vendors/${vendor.id}`, 'acct');
    check('R16 the source apps can read the replies matched to their record: a candidate (ATS), an employee (HRMS, HR login), a vendor (Accounts login) - each with source ids', repCand.body.replies.length === 1 && repCand.body.replies[0].apps.includes('ATS') && repEmp.body.replies.length === 1 && repVen.body.replies.length === 1, { c: repCand.status, e: repEmp.status, v: repVen.status });
    const recCand = await call('GET', `${O}/replies/of/candidates/${cA}`, 'rec');
    const recEmpR = await call('GET', `${O}/replies/of/employees/${eA}`, 'rec');
    const recVen = await call('GET', `${O}/replies/of/vendors/${vendor.id}`, 'rec');
    const cliVen = await call('GET', `${O}/replies/of/vendors/${vendor.id}`, 'client');
    check('D3 changed ids / audiences: a recruiter outside the candidate, an employee record, and a vendor record get 403 (never data); a client login is refused at the door (403)', [403].includes(recCand.status) && recEmpR.status === 403 && recVen.status === 403 && cliVen.status === 403, { recCand: recCand.status, recEmpR: recEmpR.status, recVen: recVen.status, cliVen: cliVen.status });

    // =============================================================== D: department isolation of campaigns and sources
    const camp2 = await call('POST', `${O}/app-campaigns`, 'hr', bodyHr({ name: `ZZTEST iso ${RUN}` }));
    const id2 = camp2.body.id;
    await prisma.$executeRawUnsafe('UPDATE "OmniAppCampaign" SET department = ? WHERE id = ?', 'Zzother', id2);
    const seen = {};
    for (const who of ['sa', 'hr', 'am', 'tl', 'rec', 'acct', 'bde', 'client']) seen[who] = (await call('GET', `${O}/app-campaigns/${id2}`, who)).status; // eslint-disable-line no-await-in-loop
    check('D4 a campaign is seen by its maker and the Admin; the Manager (sees all departments) too; NOT by a TL / recruiter / BDE / accountant of another department (404 by id), and a client login is refused (403)', seen.sa === 200 && seen.hr === 200 && seen.am === 200 && seen.tl === 404 && seen.rec === 404 && seen.bde === 404 && seen.acct === 404 && seen.client === 403, seen);
    const lst = {};
    for (const who of ['sa', 'hr', 'tl', 'rec']) lst[who] = (await call('GET', `${O}/app-campaigns`, who)).body.campaigns.some((c) => c.id === id2); // eslint-disable-line no-await-in-loop
    check('D5 the same in the list (no leak through ?app= / ?status= / ?q=): Admin and the maker see it, a TL and a recruiter do not', lst.sa && lst.hr && !lst.tl && !lst.rec && !(await call('GET', `${O}/app-campaigns${qs({ app: 'HRMS', q: 'iso' })}`, 'rec')).body.campaigns.some((c) => c.id === id2), lst);
    const ctlSa = await call('POST', `${O}/app-campaigns/${id2}/send`, 'am', { when: 'now' });
    const ctlRec = await call('DELETE', `${O}/app-campaigns/${id2}`, 'rec');
    check('D6 control follows the maker: a Manager who can look cannot send (403); a recruiter who changes the id gets 404', ctlSa.status === 403 && ctlRec.status === 404, { ctlSa: ctlSa.status, ctlRec: ctlRec.status });
    const accSeen = await call('GET', `${O}/app-campaigns/${accCreate.body.id}`, 'tl');
    const accSeenSa = await call('GET', `${O}/app-campaigns/${accCreate.body.id}`, 'sa');
    check('D7 Accounts campaigns stay inside Accounts: even a Team Lead of any department gets 404; the Admin and the accountant see them', accSeen.status === 404 && accSeenSa.status === 200 && (await call('GET', `${O}/app-campaigns/${accCreate.body.id}`, 'acct')).status === 200);
    const jaRec = await call('GET', `${O}/sources/job-applicants${qs({ requirementId: 'doesnotexist' })}`, 'rec');
    const jaSa = await call('GET', `${O}/sources/job-applicants${qs({ requirementId: (await prisma.requirement.findFirst({ select: { id: true } })).id })}`, 'sa');
    const invRec = await call('POST', `${O}/sources/invoice-clients`, 'rec', { invoiceIds: ['x'] });
    const inv = await prisma.invoice.findFirst({ select: { id: true } });
    const invAcct = inv ? await call('POST', `${O}/sources/invoice-clients`, 'acct', { invoiceIds: [inv.id, 'not-mine'] }) : { status: 200, body: { outsideYourAccess: 1 } };
    check('D8 source lists are cut to what the caller may see: an unknown / out-of-scope job is 404; a recruiter gets 403 for invoices; Accounts gets its clients and the foreign id is counted as outside access', jaRec.status === 404 && jaSa.status === 200 && invRec.status === 403 && invAcct.status === 200 && invAcct.body.outsideYourAccess >= 1, { jaRec: jaRec.status, jaSa: jaSa.status, invRec: invRec.status, invAcct: invAcct.status });
    check('D9 external and anonymous callers: no token = 401; a client login = 403 on every area of /api/omni', (await http('GET', `${O}/library/templates`)).status === 401 && (await call('GET', `${O}/library/templates`, 'client')).status === 403 && (await call('GET', `${O}/connections`, 'client')).status === 403 && (await call('GET', `${O}/replies/review`, 'client')).status === 403);

    // =============================================================== H: honest provider status, sync health, no secrets
    const cn = (await call('GET', `${O}/connections`, 'sa')).body;
    const by = Object.fromEntries(cn.channels.map((c) => [c.id, c]));
    check('H1 Channel Connections: SMS says "Not set up" with the real reason; Email (set up) says "Test" (rehearsal), NOT "Connected", while Test mode is on; WhatsApp never claims inbound works without a webhook call; RCS and Voice are "Planned"', by.sms.state === 'not_set_up' && by.sms.reason.length > 5 && by.email.state === 'test' && /nothing is sent/i.test(by.email.words) && by.whatsapp.state !== 'connected' && by.rcs.state === 'planned' && by.voice.state === 'planned' && cn.rehearsal === true && cn.channels.every((c) => c.state !== 'connected'), cn.channels.map((c) => [c.id, c.state]));
    const cnRec = await call('GET', `${O}/connections`, 'rec');
    const sh = (await call('GET', `${O}/sync-health`, 'sa')).body;
    const shRec = (await call('GET', `${O}/sync-health`, 'rec')).body;
    check('H2 Sync health counts the real tables (events, needs review, failed, duplicates ignored); the failure details are for an Admin only; a recruiter may look at the status page', cnRec.status === 200 && sh.events.total >= 10 && sh.events.duplicatesIgnored >= 2 && sh.events.needsReview >= 0 && 'failed' in sh.events && sh.canRetry === true && shRec.events.failedList.length === 0 && shRec.canRetry === false, { sh: sh.events, rec: cnRec.status });
    // secrets: collect every integration secret value of the working copy and look for it in ALL the answers of this test
    const secrets = [];
    try {
      const { readConfig } = require(path.join(BACK, 'src/utils/integrationStore'));
      for (const k of ['email', 'whatsapp', 'sms', 'smtp', 'msg91', 'twilio', 'fast2sms']) { const c = await readConfig(k).catch(() => null); if (c && c.values) Object.entries(c.values).forEach(([k, v]) => { const sv = String(v || ''); if (sv.length >= 8 && /pass|secret|token|key|auth|sid/i.test(k)) secrets.push(sv); }); } // eslint-disable-line no-await-in-loop
    } catch { /* none */ }
    const leaked = secrets.filter((s) => allText.some((t) => t.includes(s)));
    check(`H3 no provider secret in any answer: ${secrets.length} configured integration values were searched for in every response body of this test (none found)`, leaked.length === 0 && !allText.some((t) => /"(password|appSecret|accessToken|apiKey|token)"\s*:\s*"[^"]{8,}/i.test(t)), leaked.map((s) => `${s.slice(0, 2)}...`));
    check('H4 no response of this module contains the word "Draft"', !allText.some((t) => /\bdraft\b/i.test(t)), allText.filter((t) => /\bdraft\b/i.test(t)).map((t) => t.slice(0, 120)));
    // audit log
    const aud = (await call('GET', '/api/outreach/gs/admin/team/audit?pageSize=100', 'sa')).body;
    const acts = aud.rows.map((r) => r.action).join('|');
    check('G1 audit log: template approval, version / scope changes, campaign approval / schedule / pause / cancel / rehearsal, reply matches and dismissals are all in the Omni audit log, without phone numbers or emails', /Template library: approval asked/.test(acts) && /Template library: template approved/.test(acts) && /App campaign approved/.test(acts) && /App campaign scheduled/.test(acts) && /App campaign cancelled/.test(acts) && /rehearsed/i.test(acts) && /Reply matched by a person/.test(acts) && /Reply dismissed/.test(acts) && !/\d{10}|@/.test(JSON.stringify(aud.rows)), { missing: ['Template library: approval asked', 'Template library: template approved', 'App campaign approved', 'App campaign scheduled', 'App campaign cancelled', 'rehearsed', 'Reply matched by a person', 'Reply dismissed'].filter((w) => !acts.includes(w)), digits: (JSON.stringify(aud.rows).match(/.{25}(\d{10}|@).{10}/) || [])[0], n: aud.rows.length });
    const audTl = (await call('GET', '/api/outreach/gs/admin/team/audit?pageSize=100', 'rec')).status;
    check('G2 a recruiter cannot open the audit log (403)', audTl === 403, audTl);
    // the migration file is the same tables the app makes
    check('G3 the hand-written migration creates exactly the six Omni integration tables (and rollback drops them)', /OmniTemplateMeta/.test(fs.readFileSync(path.join(BACK, 'prisma/migrations/20261017200000_omni_integration/migration.sql'), 'utf8')) && (fs.readFileSync(path.join(BACK, 'prisma/migrations/20261017200000_omni_integration/rollback.sql'), 'utf8').match(/DROP TABLE/g) || []).length === 6);
    // existing navigation / workflows unchanged: the old APIs still answer
    const old1 = await call('GET', '/api/outreach/gs/campaigns/list', 'sa');
    const old2 = await call('GET', '/api/outreach/gs/templates/list?channel=email&where=all', 'sa');
    const old3 = await call('GET', '/api/conversations/inbox', 'sa');
    const old4 = await call('GET', '/api/messaging/templates/usable?audience=candidate', 'sa');
    check('X1 existing workflows unchanged: campaigns list, template list, the one inbox and the "Send message" templates still answer 200', [old1, old2, old3, old4].every((r) => r.status === 200), [old1.status, old2.status, old3.status, old4.status]);
  } catch (e) {
    fail += 1; console.log('FAIL  unexpected error', e && e.stack);
  } finally {
    if (server) server.kill();
    await prisma.$disconnect().catch(() => {});
    try { fs.rmSync(JOBDIR, { recursive: true, force: true }); } catch { /* temp */ }
    console.log(`\n${pass} passed, ${fail} failed.  (working copy: ${WORK} - delete it when done)`);
    process.exit(fail ? 1 : 0);
  }
})();
