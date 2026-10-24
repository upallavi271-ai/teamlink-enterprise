#!/usr/bin/env node
// ---------------------------------------------------------------------------
// OMNI-CHANNEL "ADMINISTRATION" PAGES TEST (Green Start rebuild, 2026-10-17) - COPY DATABASE ONLY.
//   cd backend
//   COPY_DB=C:/tmp/omni-v3-copy.db TEST_PORT=4107 node scripts/omni-gs-admin-test.js
// Makes its OWN working copy (<name>-work.db), starts its OWN API (TEST_MODE), signs tokens for real logins found in the copy, creates ZZTEST rows and
// checks the APIs behind Team & Roles, Billing, Super Admin, Settings and the organisation modal: shape, who may and may not, validations, masking, audit,
// that the word "Draft" never appears, and that NOTHING is sent.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const copy = process.env.COPY_DB;
if (!copy || /prisma[\\/]dev\.db$/i.test(path.resolve(copy))) { console.error('Refusing: set COPY_DB to a COPY of the database, never prisma/dev.db.'); process.exit(2); }
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const BACK = path.resolve(__dirname, '..');
const WORK = path.resolve(copy).replace(/\.db$/i, '-gsadmin-work.db');
fs.copyFileSync(path.resolve(copy), WORK);
const PORT = Number(process.env.TEST_PORT || 4107);
if (PORT === 4010) process.exit(2);
const API = `http://127.0.0.1:${PORT}`;
process.env.DATABASE_URL = `file:${WORK.split(path.sep).join('/')}?socket_timeout=60`;
process.env.TEST_MODE = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${WORK.split(path.sep).join('/')}?socket_timeout=60`;

{
  const db = new DatabaseSync(WORK);
  db.exec('PRAGMA busy_timeout = 30000');
  const has = (n) => !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(n);
  [['OutreachContact', '20261014100000_outreach_core'], ['OutreachCampaign', '20261014200000_outreach_campaigns'], ['OutreachCampaignNote', '20261014900000_outreach_quickwins']].forEach(([t, dir]) => {
    if (!has(t)) db.exec(fs.readFileSync(path.join(BACK, 'prisma', 'migrations', dir, 'migration.sql'), 'utf8'));
  });
  db.close();
}
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 500)}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Date.now().toString(36);
const seen = []; // every response text, scanned for the word "Draft" at the end

async function http(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(120000) });
  const text = Buffer.from(await r.arrayBuffer()).toString('utf8');
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  if (!/csv/.test(r.headers.get('content-type') || '')) seen.push(`${p} ${text}`);
  return { status: r.status, body: json, text, type: r.headers.get('content-type') || '' };
}
const G = '/api/outreach/gs/admin';
const nIn = (x) => Number(x) || 0;

(async () => {
  let server;
  try {
    const A0 = require(path.join(BACK, 'src/outreach/access'));
    const S = require(path.join(BACK, 'src/outreach/store'));
    const Cr = require(path.join(BACK, 'src/outreach/credits'));
    const first = async (where) => prisma.user.findFirst({ where: { status: 'Active', NOT: { email: { contains: 'example.test' } }, ...where } });
    const live = { employee: { is: { employmentStatus: 'Active' } } };
    const sa = await first({ role: 'SUPER_ADMIN' });
    let tl = null;
    for (const c of await prisma.user.findMany({ where: { status: 'Active', atsRole: 'TL', ...live }, take: 12 })) { // eslint-disable-line no-await-in-loop
      if (A0.kind(await resolveIdentity(c.id)) === 'tl') { tl = c; break; } // eslint-disable-line no-await-in-loop
    }
    const bde = await first({ atsRole: 'BDE', ...live });
    const am = await first({ atsRole: 'ASSISTANT_MANAGER' });
    if (am) await prisma.employee.updateMany({ where: { userId: am.id }, data: { employmentStatus: 'Active' } });
    const hr = await first({ atsRole: 'HR', ...live });
    const recEmps = await prisma.employee.findMany({ where: { employmentStatus: 'Active', user: { atsRole: 'RECRUITER', status: 'Active' }, department: { not: null } }, include: { user: true }, take: 60 });
    const rec = recEmps[0];
    check('0 the copy has the people the test needs (Super Admin, TL, BDE, Assistant Manager, HR, a recruiter)', !!(sa && tl && bde && am && hr && rec), { sa: !!sa, tl: !!tl, bde: !!bde, am: !!am, hr: !!hr, rec: !!rec });
    await prisma.user.updateMany({ where: { id: { in: [sa, tl, bde, am, hr, rec.user].filter(Boolean).map((u) => u.id) } }, data: { passwordHash: 'x' } });
    const recU = rec.user;
    const base = { passwordHash: 'x', hrmsAccess: false, atsAccess: true, accountsRole: 'NONE', accountsAccess: false, status: 'Active' };
    const client = await prisma.user.create({ data: { ...base, name: `ZZTEST client ${RUN}`, email: `zz-gsa-client-${RUN}@example.test`, username: `zz-gsa-client-${RUN}@example.test`, role: 'CLIENT', atsRole: 'CLIENT' } });
    const acct = await prisma.user.create({ data: { ...base, name: `ZZTEST accounts ${RUN}`, email: `zz-gsa-acct-${RUN}@example.test`, username: `zz-gsa-acct-${RUN}@example.test`, role: 'EMPLOYEE', atsRole: 'EMPLOYEE', accountsRole: 'ACCOUNTANT', accountsAccess: true } });

    // nothing may be sent: remember the send counters
    await S.ready();
    const sendCount = async () => ({ log: nIn((await S.q('SELECT COUNT(*) n FROM "OutreachSendLog"'))[0].n), msg: (await S.campaignsReady()) ? nIn((await S.q('SELECT COUNT(*) n FROM "OutreachMessage"'))[0].n) : 0 });
    const before = await sendCount();

    // a little real credit activity for the recruiter and the BDE (the credit ledger, the same as a real send writes)
    await Cr.record({ userId: recU.id, channel: 'email', mode: 'live', ok: true, source: 'zztest' });
    await Cr.record({ userId: recU.id, channel: 'whatsapp', mode: 'live', ok: true, source: 'zztest' });
    await Cr.record({ userId: recU.id, channel: 'sms', mode: 'test', ok: true, source: 'zztest' });
    await Cr.record({ userId: bde.id, channel: 'email', mode: 'live', ok: true, source: 'zztest' });

    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 120 && !healthy; i += 1) { try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await sleep(1000); } }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }
    const tokenOf = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const T = { sa: await tokenOf(sa), tl: await tokenOf(tl), bde: await tokenOf(bde), am: await tokenOf(am), hr: await tokenOf(hr), rec: await tokenOf(recU), client: await tokenOf(client), acct: await tokenOf(acct) };
    const me = {}; for (const k of Object.keys(T)) me[k] = await http('GET', '/api/outreach/me', T[k]); // eslint-disable-line no-await-in-loop
    const pg = (k) => (me[k].body && me[k].body.pages) || [];
    console.log(`info  levels: ${Object.keys(T).map((k) => `${k}=${me[k].body && me[k].body.level}`).join(' ')}`);

    // ======================================================== P: pages per role (the server's list)
    check('P1 Admin gets Team, Billing, Super Admin and Settings', ['team', 'billing', 'superadmin', 'settings'].every((p) => pg('sa').includes(p)), pg('sa'));
    check('P2 Department Head (Assistant Manager) and Team Lead get Team and Billing but not Super Admin / Settings', pg('am').includes('team') && pg('tl').includes('team') && pg('am').includes('billing') && !pg('am').includes('superadmin') && !pg('tl').includes('settings'), { am: pg('am'), tl: pg('tl') });
    check('P3 BDE, Recruiter, HR get Billing ("Your credits") but not Team, Super Admin, Settings', [pg('bde'), pg('rec'), pg('hr')].every((l) => l.includes('billing') && !l.includes('team') && !l.includes('superadmin') && !l.includes('settings')));
    check('P4 Finance (Accounts) gets Billing only', pg('acct').join() === 'billing', pg('acct'));
    check('P5 Client login is refused', me.client.status === 403, me.client.status);

    // ======================================================== T: team members
    const memSa = await http('GET', `${G}/team/members`, T.sa);
    const ms = (r) => (r.body && r.body.rows) || [];
    check('T1 Admin sees the members: name, department, role words, credits given / used / left, last activity', memSa.status === 200 && ms(memSa).length > 3 && ms(memSa).every((r) => r.name && 'given' in r && 'used' in r && 'left' in r && 'lastActive' in r && r.levelWords) && memSa.body.totals.people === ms(memSa).length, memSa.text.slice(0, 300));
    const recRow = ms(memSa).find((r) => r.userId === recU.id);
    check('T2 the recruiter\'s credits used = what the ledger holds (email 1 + WhatsApp 1 = 2; the SMS test message is not charged)', recRow && recRow.used === 2 && recRow.sent === 2 && recRow.testSent === 1, recRow);
    check('T3 Admin sees the work email; nobody people-list shows a phone number', ms(memSa).some((r) => r.email) && !/\b\d{10}\b/.test(JSON.stringify(memSa.body.rows.map((r) => ({ ...r, userId: 0, code: 0 })))), memSa.text.slice(0, 200));
    const memTl = await http('GET', `${G}/team/members`, T.tl);
    check('T4 a Team Lead sees only their own team (fewer people than Admin), without email addresses', memTl.status === 200 && ms(memTl).length < ms(memSa).length && ms(memTl).every((r) => !r.email) && ms(memTl).some((r) => r.userId === tl.id), { tl: ms(memTl).length, sa: ms(memSa).length });
    const memAm = await http('GET', `${G}/team/members`, T.am);
    check('T5 a Department Head / Manager gets an answer too (200)', memAm.status === 200 && Array.isArray(ms(memAm)), memAm.status);
    check('T6 BDE, Recruiter, HR, Finance, Client are refused (403)', (await Promise.all(['bde', 'rec', 'hr', 'acct', 'client'].map((k) => http('GET', `${G}/team/members`, T[k])))).every((r) => r.status === 403));
    const recDept = rec.department;
    const memDept = await http('GET', `${G}/team/members?dept=${encodeURIComponent(recDept)}`, T.sa);
    check('T7 picking a department narrows the list to it', memDept.status === 200 && ms(memDept).length > 0 && ms(memDept).every((r) => String(r.department).toLowerCase() === String(recDept).toLowerCase()), memDept.text.slice(0, 200));
    const memQ = await http('GET', `${G}/team/members?q=${encodeURIComponent((recRow || ms(memSa)[0]).name.slice(0, 4))}`, T.sa);
    check('T8 searching by name works', memQ.status === 200 && ms(memQ).length >= 1 && ms(memQ).length <= ms(memSa).length, memQ.text.slice(0, 120));
    const memTlOther = await http('GET', `${G}/team/members?dept=NoSuchDepartment`, T.tl);
    check('T9 a Team Lead asking for a department that is not theirs gets nothing', memTlOther.status === 200 && ms(memTlOther).length === 0, memTlOther.text.slice(0, 160));

    // ======================================================== R: roles
    const roles = await http('GET', `${G}/team/roles`, T.sa);
    const rb = roles.body || {};
    check('R1 the role table is the real one (18 capabilities, 8 role kinds) with the levels\' hubs', roles.status === 200 && rb.table.rows.length >= 18 && rb.table.roles.length === 8 && rb.levels.length === 8 && rb.levels.every((l) => l.hubs && typeof l.hubs.dashboard === 'boolean'), roles.text.slice(0, 200));
    check('R2 pages per level come from real logins (Admin level has Team, Billing, Super Admin, Settings)', ['team', 'billing', 'superadmin', 'settings'].every((p) => (rb.pagesByLevel.admin || []).includes(p)) && rb.canEdit === true, rb.pagesByLevel);
    const rolesTl = await http('GET', `${G}/team/roles`, T.tl);
    check('R3 a Team Lead may read the table but cannot edit', rolesTl.status === 200 && rolesTl.body.canEdit === false);
    check('R4 the approval switch words are plain and the setting starts OFF', rb.approval && rb.approval.required === false && /approve/i.test(rb.approvalWords));

    // ======================================================== S: switches (Admin)
    const sw0 = await http('GET', `${G}/switches`, T.sa);
    check('S1 the real switches are listed: Test mode ON by default, sending master, approval, applied-to-our-job rule, bots', sw0.status === 200 && sw0.body.testMode === true && ['master', 'approvalRequired', 'atsAppliedMeansJobAllowed', 'botsEnabled'].every((k) => typeof sw0.body[k] === 'boolean'), sw0.text.slice(0, 250));
    const swOn = await http('PUT', `${G}/switches`, T.sa, { approvalRequired: true, botsEnabled: true, atsAppliedMeansJobAllowed: true });
    check('S2 Admin switches approval, bots and the "applied to our job" rule on', swOn.status === 200 && swOn.body.approvalRequired === true && swOn.body.botsEnabled === true && swOn.body.atsAppliedMeansJobAllowed === true, swOn.text.slice(0, 250));
    const botRow = await prisma.appSetting.findUnique({ where: { key: 'omni.bots' } });
    check('S3 the bots switch is saved where the bot builder reads it (AppSetting omni.bots {enabled:true})', botRow && JSON.parse(botRow.value).enabled === true, botRow);
    const swOff = await http('PUT', `${G}/switches`, T.sa, { approvalRequired: false, botsEnabled: false, atsAppliedMeansJobAllowed: false });
    check('S4 and off again', swOff.body.approvalRequired === false && swOff.body.botsEnabled === false && swOff.body.atsAppliedMeansJobAllowed === false);
    check('S5 only an Admin can read or change the switches (403 for Team Lead, Manager, BDE)', (await Promise.all([['tl', 'GET'], ['am', 'PUT'], ['bde', 'PUT']].map(([k, m]) => http(m, `${G}/switches`, T[k], m === 'PUT' ? { botsEnabled: true } : undefined)))).every((r) => r.status === 403));
    const tm = await http('PUT', '/api/outreach/settings', T.sa, { emailTestMode: false });
    check('S6 Test mode cannot go live without the "I understand" tick (400, CONFIRM_LIVE) and stays ON', tm.status === 400 && tm.body.code === 'CONFIRM_LIVE' && (await http('GET', `${G}/switches`, T.sa)).body.testMode === true, tm.text.slice(0, 200));

    // ======================================================== A: audit
    const au = await http('GET', `${G}/team/audit?pageSize=50`, T.sa);
    const ar = (r) => (r.body && r.body.rows) || [];
    check('A1 the audit tab shows the Omni-Channel rows (who, what, when) incl. the switch just changed', au.status === 200 && ar(au).length > 0 && ar(au).some((r) => /approval switched/i.test(r.action)) && ar(au).every((r) => r.who && r.at && r.action && (/^(Omni-Channel|Outreach)/.test(r.action))), au.text.slice(0, 300));
    check('A2 no email address and no phone number in any audit row', !/@|\+?\d(?:[\s-]?\d){9,}/.test(JSON.stringify(ar(au).map((r) => ({ a: r.action, d: r.detail, w: r.who })))), ar(au).find((r) => /@/.test(r.detail)));
    await prisma.auditLog.create({ data: { userId: sa.id, actorName: sa.name, action: 'Omni-Channel ZZTEST note', entity: 'ZZ', entityId: RUN, toValue: 'sent to zz.person@example.test and +91 98765 43210 ok' } });
    const au2 = await http('GET', `${G}/team/audit?q=ZZTEST%20note`, T.sa);
    check('A3 a row that carries an address or a number is shown with it hidden; search finds the row', ar(au2).length === 1 && /\[hidden\]/.test(ar(au2)[0].detail) && !/example\.test|98765/.test(ar(au2)[0].detail), au2.text.slice(0, 300));
    const csv = await http('GET', `${G}/team/audit.csv`, T.sa);
    check('A4 Admin can download the audit log as CSV (header + rows) and it is audited', csv.status === 200 && /csv/.test(csv.type) && /^\ufeff?When/.test(csv.text) && csv.text.split('\n').length > 2, csv.text.slice(0, 120));
    const au3 = await http('GET', `${G}/team/audit?q=audit%20log%20downloaded`, T.sa);
    check('A5 the download is in the audit log itself (row count only)', ar(au3).some((r) => /audit log downloaded/i.test(r.action) && /rows/.test(r.detail)));
    check('A6 only an Admin may download (403 for Team Lead and Manager); a Team Lead may read the tab', (await http('GET', `${G}/team/audit.csv`, T.tl)).status === 403 && (await http('GET', `${G}/team/audit.csv`, T.am)).status === 403 && (await http('GET', `${G}/team/audit`, T.tl)).status === 200);
    const auTl = await http('GET', `${G}/team/audit?pageSize=100`, T.tl);
    check('A7 a Team Lead sees only what people of their own team did (never the Admin\'s rows)', ar(auTl).every((r) => r.who !== sa.name || sa.id === tl.id), ar(auTl).slice(0, 3));
    check('A8 BDE / Recruiter / Finance / Client cannot open the audit tab (403)', (await Promise.all(['bde', 'rec', 'acct', 'client'].map((k) => http('GET', `${G}/team/audit`, T[k])))).every((r) => r.status === 403));

    // ======================================================== B: billing
    const bSa = await http('GET', `${G}/billing/summary`, T.sa);
    const bEarly = await http('GET', '/api/outreach/billing/summary', T.sa);
    check('B1 Billing for Admin: the plan card says it is included in TeamLink, "your credits" AND the company view', bSa.status === 200 && bSa.body.plan.name === 'Included in TeamLink' && bSa.body.mine && bSa.body.company && bSa.body.canRecharge === true && bEarly.status === 200, bSa.text.slice(0, 250));
    const bRec = await http('GET', `${G}/billing/summary`, T.rec);
    const mine = bRec.body && bRec.body.mine;
    check('B2 a Recruiter sees "Your credits" only: given, used, left, per channel, Test messages shown apart', bRec.status === 200 && mine && !bRec.body.company && mine.used === 2 && mine.given === mine.used + mine.left && mine.testMessages === 1 && mine.channels.length === 4 && mine.channels.find((c) => c.channel === 'sms').testMessages === 1 && mine.channels.find((c) => c.channel === 'email').messages === 1, bRec.text.slice(0, 400));
    const bAcct = await http('GET', '/api/outreach/billing/summary', T.acct);
    check('B3 Finance (no ATS product) gets the company view and no personal block, through the early route', bAcct.status === 200 && bAcct.body.company && !bAcct.body.mine && bAcct.body.level === 'finance', bAcct.text.slice(0, 200));
    check('B4 a Client login is refused (403)', (await http('GET', '/api/outreach/billing/summary', T.client)).status === 403);
    const bTl = await http('GET', `${G}/billing/summary`, T.tl);
    check('B5 a Team Lead sees only their own credits (no company block, cannot recharge)', bTl.status === 200 && bTl.body.mine && !bTl.body.company && bTl.body.canRecharge === false);
    const co = bSa.body.company;
    check('B6 company view: channels, balance per channel, usage by department and by person, recharges, unit costs (start at 0), call minutes "not recorded"', co && co.channels.length === 4 && co.balance.length === 4 && Array.isArray(co.byDepartment) && Array.isArray(co.byPerson) && Array.isArray(co.recharges) && co.unitCost && co.unitCost.whatsapp === 0 && co.calls.recorded === false && Array.isArray(co.people), JSON.stringify(co).slice(0, 300));
    const rch = await http('POST', '/api/outreach/insights/credits/recharge', T.sa, { channel: 'whatsapp', amount: 1000, costRupees: 700, note: `ZZTEST recharge ${RUN}` });
    await http('PUT', '/api/outreach/credits/settings', T.sa, { unitCost: { whatsapp: 2 } });
    const bSa2 = await http('GET', `${G}/billing/summary`, T.sa);
    const wb = bSa2.body.company.balance.find((b) => b.channel === 'whatsapp'); const wc = bSa2.body.company.channels.find((c) => c.channel === 'whatsapp');
    check('B7 a recorded recharge shows in the history and the balance (bought - used); cost per message x messages = cost', rch.status === 200 && bSa2.body.company.recharges.some((r) => r.note === `ZZTEST recharge ${RUN}`) && wb.bought >= 1000 && wb.left === wb.bought - wb.used && wc.cost === wc.messages * 2 && bSa2.body.company.balanceKnown === true, { wb, wc });
    await http('PUT', '/api/outreach/credits/settings', T.sa, { unitCost: { whatsapp: 0 } });
    check('B8 only an Admin records a recharge or changes the credit rules (403 for Finance, Team Lead)', (await http('POST', '/api/outreach/insights/credits/recharge', T.acct, { channel: 'sms', amount: 5 })).status === 403 && (await http('PUT', '/api/outreach/credits/settings', T.tl, { allowance: 9 })).status === 403);
    const ucsv = await http('GET', `${G}/billing/usage.csv`, T.sa);
    const ucsv2 = await http('GET', '/api/outreach/billing/usage.csv', T.acct);
    check('B9 Export usage: CSV for Admin and Finance, refused for a Team Lead', ucsv.status === 200 && /^\ufeff?Channel,/.test(ucsv.text) && /Email/.test(ucsv.text) && ucsv2.status === 200 && (await http('GET', `${G}/billing/usage.csv`, T.tl)).status === 403, ucsv.text.slice(0, 120));
    const au4 = await http('GET', `${G}/team/audit?q=usage%20downloaded`, T.sa);
    check('B10 the usage download is audited', ar(au4).some((r) => /usage downloaded/i.test(r.action)));
    check('B11 a month that is not a month falls back to this month (no error)', (await http('GET', `${G}/billing/summary?month=garbage`, T.sa)).body.month === Cr.thisMonth());
    // call minutes: only shown when the campaign side records them
    const cols = await S.q('PRAGMA table_info("OutreachMessage")');
    check('B12 call minutes are guarded: no column or no data = "Not recorded" and the page still answers', co.calls.recorded === false || cols.some((c) => c.name === 'callMinutes'), co.calls);

    // ======================================================== O: organisations (modal + Super Admin)
    const org = await http('GET', '/api/outreach/org/overview', T.sa);
    const orows = (r) => (r.body && r.body.rows) || [];
    check('O1 the organisation modal lists every department with people, credits used this month, messages and status', org.status === 200 && orows(org).length >= 5 && orows(org).every((r) => r.name && 'people' in r && 'creditsUsed' in r && 'messages' in r && r.status) && org.body.canCreate === true && org.body.yourRole, org.text.slice(0, 300));
    const orgRec = await http('GET', '/api/outreach/org/overview', T.rec);
    check('O2 a Recruiter sees only their own department there and cannot create one', orgRec.status === 200 && orows(orgRec).length === 1 && orgRec.body.canCreate === false, orgRec.text.slice(0, 250));
    const recOrg = orows(org).find((r) => String(r.name).toLowerCase() === String(recDept).toLowerCase());
    check('O3 credits used by a department = the sum of its people (the recruiter\'s 2 credits are in)', recOrg && recOrg.creditsUsed >= 2 && recOrg.messages >= 2, recOrg);
    const nm = `ZZTEST Org ${RUN}`;
    const mk = await http('POST', '/api/outreach/org', T.sa, { name: nm });
    const org2 = await http('GET', '/api/outreach/org/overview', T.sa);
    check('O4 Create Organization adds a department NAME to the Omni list (shown next time)', mk.status === 200 && orows(org2).some((r) => r.name === nm && r.added === true), mk.text.slice(0, 200));
    const dup = await http('POST', '/api/outreach/org', T.sa, { name: nm.toUpperCase() });
    const short = await http('POST', '/api/outreach/org', T.sa, { name: 'A' });
    const empty = await http('POST', '/api/outreach/org', T.sa, { name: '   ' });
    check('O5 validations: empty, too short, duplicate (any capitals) are refused with the prototype\'s words', empty.status === 400 && /Give the organization a name/.test(empty.body.error) && short.status === 400 && /too short/.test(short.body.error) && dup.status === 400 && /already have an organization called/.test(dup.body.error), { e: empty.body, s: short.body, d: dup.body });
    check('O6 only an Admin can create (403 for Team Lead, BDE, Finance)', (await Promise.all(['tl', 'bde', 'acct'].map((k) => http('POST', '/api/outreach/org', T[k], { name: `ZZTEST x ${k} ${RUN}` })))).every((r) => r.status === 403));
    const wsl = await http('GET', '/api/outreach/workspaces', T.sa);
    check('O7 the new name is also in the top-bar workspace switcher', wsl.body.list.some((w) => w.name === nm), wsl.text.slice(0, 200));
    const sup = await http('GET', `${G}/super/organisations`, T.sa);
    check('O8 Super Admin table: Department | People | Credits used | Messages sent | Credits given | Status + KPIs', sup.status === 200 && orows(sup).length >= 5 && sup.body.kpis.organisations >= 5 && orows(sup).every((r) => 'creditsGiven' in r && r.status), sup.text.slice(0, 300));
    check('O9 Super Admin is Admin only (403 for Team Lead, Manager, Finance)', (await Promise.all(['tl', 'am', 'acct', 'bde'].map((k) => http('GET', `${G}/super/organisations`, T[k])))).every((r) => r.status === 403));
    const scsv = await http('GET', `${G}/super/organisations.csv`, T.sa);
    check('O10 Export organisations CSV (audited)', scsv.status === 200 && /^\ufeff?Organisation,People/.test(scsv.text) && ar(await http('GET', `${G}/team/audit?q=organisations%20downloaded`, T.sa)).length >= 1, scsv.text.slice(0, 120));
    const g1 = await http('POST', `${G}/super/grant`, T.sa, { userId: recU.id, credits: 321, note: 'ZZTEST' });
    check('O11 Grant credits to ONE person sets their monthly credits (shown in the ledger rules) and is audited', g1.status === 200 && (await Cr.allowanceOf(await Cr.settings(), recU.id)) === 321 && ar(await http('GET', `${G}/team/audit?q=credits%20granted`, T.sa)).length >= 1, g1.text.slice(0, 200));
    const g2 = await http('POST', `${G}/super/grant`, T.sa, { department: recDept, credits: 150 });
    const afterG2 = await Cr.allowanceOf(await Cr.settings(), recU.id);
    check('O12 Grant credits to a DEPARTMENT sets every limited person in it (people count answered)', g2.status === 200 && g2.body.people >= 1 && afterG2 === 150, g2.text.slice(0, 200));
    check('O13 grant validations: not a number / negative / nobody chosen are refused (400)', (await http('POST', `${G}/super/grant`, T.sa, { userId: recU.id, credits: 'abc' })).status === 400 && (await http('POST', `${G}/super/grant`, T.sa, { userId: recU.id, credits: -5 })).status === 400 && (await http('POST', `${G}/super/grant`, T.sa, { credits: 10 })).status === 400);
    check('O14 only an Admin can grant (403 for Team Lead, Manager)', (await http('POST', `${G}/super/grant`, T.tl, { userId: recU.id, credits: 5 })).status === 403 && (await http('POST', `${G}/super/grant`, T.am, { userId: recU.id, credits: 5 })).status === 403);
    await Cr.setAllowance(recU.id, null, null, sa);

    // ======================================================== N: settings
    const h = await http('GET', `${G}/settings/health`, T.sa);
    const ids = ((h.body && h.body.rows) || []).map((r) => r.id);
    check('N1 connection health rows: HRMS, ATS, Accounts, Job Portal, Email, WhatsApp, SMS, each green / yellow / red with a detail', h.status === 200 && ['hrms', 'ats', 'accounts', 'portal', 'email', 'whatsapp', 'sms'].every((i) => ids.includes(i)) && h.body.rows.every((r) => ['green', 'yellow', 'red'].includes(r.state) && r.detail), h.text.slice(0, 300));
    const ht = await http('POST', `${G}/settings/health/email/test`, T.sa);
    check('N2 "Test connection" re-reads one row and says nothing was sent; an unknown one is 404', ht.status === 200 && ht.body.row && ht.body.row.id === 'email' && /Nothing was sent/.test(ht.body.note) && (await http('POST', `${G}/settings/health/nope/test`, T.sa)).status === 404, ht.text.slice(0, 200));
    const wn0 = await http('GET', `${G}/settings/wa-numbers`, T.sa);
    check('N3 WhatsApp numbers per department: list + department names + the "routing only" words', wn0.status === 200 && Array.isArray(wn0.body.numbers) && wn0.body.departments.length > 3 && /routing only/i.test(wn0.body.words), wn0.text.slice(0, 250));
    const wnPut = await http('PUT', `${G}/settings/wa-numbers`, T.sa, { numbers: [{ label: 'ZZTEST Medical line', number: '919876500001', departments: ['Medical'] }] });
    const wn1 = await http('GET', `${G}/settings/wa-numbers`, T.sa);
    check('N4 a number is saved, shown masked only, mapped to a department', wnPut.status === 200 && wn1.body.numbers.length === 1 && /\*+0001$/.test(wn1.body.numbers[0].numberMasked) && wn1.body.numbers[0].departments[0] === 'Medical', wn1.text.slice(0, 250));
    const wnBad = await http('PUT', `${G}/settings/wa-numbers`, T.sa, { numbers: [{ label: 'x', number: '123', departments: [] }] });
    check('N5 a number with fewer than 10 digits is refused (400); an empty list clears', wnBad.status === 400 && (await http('PUT', `${G}/settings/wa-numbers`, T.sa, { numbers: [] })).status === 200);
    const sd = await http('PUT', `${G}/settings/sending`, T.sa, { waDailyCap: 123, smsDailyCap: 77, waPerMinute: 11, smsPerMinute: 9 });
    const st = await S.settings();
    check('N6 WhatsApp / SMS day limits and speed are saved (they were not editable before)', sd.status === 200 && st.waDailyCap === 123 && st.smsDailyCap === 77 && st.waPerMinute === 11 && st.smsPerMinute === 9, sd.text.slice(0, 200));
    check('N7 bad limits are refused (400) and nothing changes', (await http('PUT', `${G}/settings/sending`, T.sa, { waPerMinute: 0 })).status === 400 && (await http('PUT', `${G}/settings/sending`, T.sa, { smsDailyCap: 'many' })).status === 400 && (await S.settings()).waPerMinute === 11);
    const oo = await http('GET', `${G}/settings/optouts`, T.sa);
    check('N8 opt-out counts: per way, people, do-not-contact list size', oo.status === 200 && typeof oo.body.people === 'number' && typeof oo.body.doNotContact === 'number' && oo.body.byChannel && typeof oo.body.byChannel === 'object', oo.text.slice(0, 200));
    const ooCsv = await http('GET', `${G}/settings/optouts.csv`, T.sa);
    check('N9 opt-out list CSV for Admin (audited, row count only)', ooCsv.status === 200 && /^\ufeff?Name,Phone,Email,Way/.test(ooCsv.text) && ar(await http('GET', `${G}/team/audit?q=opt-out%20list`, T.sa)).some((r) => !/@/.test(r.detail)), ooCsv.text.slice(0, 120));
    check('N10 every Settings API is Admin only (403 for Team Lead, Manager, BDE, Finance)', (await Promise.all(['tl', 'am', 'bde', 'acct'].map((k) => Promise.all([http('GET', `${G}/settings/health`, T[k]), http('GET', `${G}/settings/optouts.csv`, T[k]), http('PUT', `${G}/settings/sending`, T[k], { waDailyCap: 1 }), http('PUT', `${G}/settings/wa-numbers`, T[k], { numbers: [] })])))).flat().every((r) => r.status === 403));
    check('N11 the existing Settings routes the page reuses still answer for Admin (sender details, sending, channels, consent log, credits rules)', (await Promise.all(['/api/outreach/sender-details', '/api/outreach/sending', '/api/outreach/channels', '/api/outreach/consent-log', '/api/outreach/credits/settings', '/api/outreach/config/meta', '/api/outreach/config/permissions', '/api/outreach/config/people'].map((u) => http('GET', u, T.sa)))).every((r) => r.status === 200));

    // ======================================================== Z: nothing sent, no "Draft", cleanup
    const after = await sendCount();
    check('Z1 NOTHING was sent: no send-log row and no campaign message was added by any call', after.log === before.log && after.msg === before.msg, { before, after });
    check('Z2 the word "Draft" appears in no answer', !seen.some((s) => /\bdraft\b/i.test(s)), seen.find((s) => /\bdraft\b/i.test(s)));
    check('Z3 Test mode is still ON at the end', (await S.settings()).emailTestMode === true);
    await prisma.user.deleteMany({ where: { id: { in: [client.id, acct.id] } } }).catch(() => {});
  } catch (e) {
    fail += 1; console.log('FAIL  unexpected error', e && e.stack);
  } finally {
    if (server) server.kill();
    await prisma.$disconnect().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed.  (working copy: ${WORK} - delete it when done)`);
    process.exit(fail ? 1 : 0);
  }
})();
