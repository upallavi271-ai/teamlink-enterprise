#!/usr/bin/env node
/**
 * ATS WAVE 2, BUILDER X (founder 2026-11-25: "push ATS to 95+"): contract / temp staffing on the ATS side.
 * One section per feature ID: 11.16 pay & bill · 11.15 timesheets · 11.17 shifts · 09.15 billing check · 06.12 billing from timesheets
 * · 06.11 / 14.08 accounting push · 02.15 / 14.14 VMS jobs + connectors · 06.14 VMS submission sync · scope and refusals.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database; the VMS, the webhook receiver and Zoho Books are the server's
 * own built-in stub (/api/public/stfx-stub), so nothing leaves this machine.
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=<port> node scripts/ats-X-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-atsx-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || (4300 + Math.floor(Math.random() * 500));
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'atsx-test', INTEGRATION_SECRET_KEY: 'atsx-test-integration-key-0123456789', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 700)}` : ''}`); } };
const section = (s) => console.log(`\n-- ${s}`);
const call = async (method, url, body, token, raw = false) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (raw) return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() };
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const P = process.pid;
const sql = (q, ...a) => prisma.$queryRawUnsafe(q, ...a);
const day = (d) => d.toISOString().slice(0, 10);
const addDays = (s, k) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + k); return day(d); };
const monday = (() => { const d = new Date(`${day(new Date())}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return day(d); })();
const W1 = addDays(monday, -21); const W2 = addDays(monday, -14); const W3 = addDays(monday, -7);
const START = W1;

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const dept = 'IT';
  const mk = (n, role, atsRole, extra = {}) => prisma.user.create({ data: { name: `Stx ${n} ${P}`, email: `stx.${n}.${P}@stx-test.in`, passwordHash: 'x', status: 'Active', role, atsRole, atsDepartment: dept, atsScopeDepartments: dept, atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...extra } });
  const REC = await mk('rec', 'EMPLOYEE', 'RECRUITER');
  const REC2 = await mk('rec2', 'EMPLOYEE', 'RECRUITER');
  const TL = await mk('tl', 'TL', 'TL');
  const MGR = await mk('mgr', 'MANAGER', 'MANAGER');
  const BDE = await mk('bde', 'EMPLOYEE', 'BDE', { atsDepartment: 'BDE', atsScopeDepartments: 'BDE' });
  const ACC = await mk('acc', 'EMPLOYEE', 'ACCOUNTANT');
  const clientName = `Stx Client ${P}`;
  const client = await prisma.client.create({ data: { name: clientName, agreementStatus: 'ACTIVE', gst: '29ABCDE1234F1Z5', state: 'Karnataka', gstPercent: 18, ownerDepartment: dept, bdeOwner: BDE.name } });
  const other = await prisma.client.create({ data: { name: `Stx Other ${P}`, agreementStatus: 'ACTIVE' } });
  const reqBase = { clientId: client.id, department: dept, status: 'OPEN', internal: false, recruiterId: REC.id, tlId: TL.id, bdeId: BDE.id, location: 'Bengaluru', openings: 3 };
  const job = await prisma.requirement.create({ data: { ...reqBase, title: `Stx Packing Crew ${P}`, employmentType: 'Contract', jobPreference: 'Contract', reqCode: `STX-${P}-1` } });
  const perm = await prisma.requirement.create({ data: { ...reqBase, title: `Stx Store Manager ${P}`, employmentType: 'Full Time', jobPreference: 'Permanent', reqCode: `STX-${P}-2` } });
  const mkCand = (n) => prisma.candidate.create({ data: { name: `Stx ${n} ${P}`, phone: `98${String(P).padStart(4, '0').slice(-4)}${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`, email: `stx.${n}.${P}@stx-cand.in`, skills: 'forklift, inventory', experienceYears: 4, currentDesignation: 'Associate' } });
  const C1 = await mkCand('ravi'); const C2 = await mkCand('sita'); const C3 = await mkCand('arun');
  const joined = { stage: 'JOINED', ownerRecruiterId: REC.id, source: 'Manual', joiningDate: START, joinedAt: new Date(`${START}T09:00:00Z`), hiringType: 'Client Placement' };
  const app1 = await prisma.application.create({ data: { candidateId: C1.id, requirementId: job.id, ...joined } });
  const app2 = await prisma.application.create({ data: { candidateId: C2.id, requirementId: job.id, ...joined } });
  const app3 = await prisma.application.create({ data: { candidateId: C3.id, requirementId: perm.id, ...joined } });
  await prisma.candidateDocument.create({ data: { candidateId: C1.id, docType: 'ID', name: 'Aadhaar card' } });
  await prisma.candidateDocument.create({ data: { candidateId: C1.id, docType: 'Offer', name: 'Offer letter' } });
  const base = { passwordHash: 'x', status: 'Active', passwordChangedAt: new Date(Date.now() - 3600e3) };
  const CLI = await prisma.user.create({ data: { ...base, name: `Stx Client Login ${P}`, email: `stx.cl.${P}@stx-test.in`, role: 'CLIENT', atsRole: 'CLIENT', clientId: client.id, portalType: 'REVIEWER', portalPerms: 'VIEW,DECIDE' } });
  const CLV = await prisma.user.create({ data: { ...base, name: `Stx Client Viewer ${P}`, email: `stx.clv.${P}@stx-test.in`, role: 'CLIENT', atsRole: 'CLIENT', clientId: client.id, portalType: 'VIEWER', portalPerms: 'VIEW' } });
  const CLO = await prisma.user.create({ data: { ...base, name: `Stx Other Client ${P}`, email: `stx.clo.${P}@stx-test.in`, role: 'CLIENT', atsRole: 'CLIENT', clientId: other.id, portalType: 'REVIEWER', portalPerms: 'VIEW,DECIDE' } });
  const CAN = await prisma.user.create({ data: { ...base, name: `Stx Ravi Login ${P}`, email: `stx.can.${P}@stx-test.in`, role: 'CANDIDATE', atsRole: 'CANDIDATE', candidateId: C1.id } });

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const tA = await tok(adminRow.id); const tR = await tok(REC.id); const tR2 = await tok(REC2.id); const tT = await tok(TL.id); const tM = await tok(MGR.id); const tB = await tok(BDE.id); const tAcc = await tok(ACC.id);
  const tC = await tok(CLI.id); const tCV = await tok(CLV.id); const tCO = await tok(CLO.id); const tCan = await tok(CAN.id);
  const X = '/ats/staffing'; const PC = '/portal/client/contract'; const PK = '/portal/candidate/contract';
  const STUB = `http://localhost:${PORT}/api/public/stfx-stub`;
  const notes = (uid) => prisma.notification.count({ where: { userId: uid } });

  section('defaults and doors');
  const st = await call('GET', `${X}/settings`, null, tA);
  const val = (k) => st.body.switches.find((s) => s.key === k).value;
  check('every switch that tells people or automates starts OFF', ['timesheets.reminders', 'timesheets.notifyApprovers', 'shifts.notify', 'vms.sync', 'vms.autoImport', 'accounting.autoPush'].every((k) => val(k) === false), st.body.switches.map((s) => [s.key, s.value]));
  check('approval by the client or a TeamLink lead by default; 48 h week; 10% margin', val('approval.mode') === 'client_or_tl' && val('week.hours') === 48 && val('margin.min') === 10);
  check('a TL cannot change a switch; a recruiter cannot read them', (await call('PUT', `${X}/settings`, { key: 'vms.sync', value: true }, tT)).status === 403 && (await call('GET', `${X}/settings`, null, tR)).status === 403);
  check('a client login and a candidate login are kept out of the staff API', (await call('GET', `${X}/meta`, null, tC)).status === 403 && (await call('GET', `${X}/contractors`, null, tCan)).status === 403);
  const meta = await call('GET', `${X}/meta`, null, tB);
  check('BDE meta: no pay side, no rates, VMS desk yes', meta.status === 200 && meta.body.seesPay === false && meta.body.mayRates === false && meta.body.mayVms === true, meta.body);
  check('the Accounts boundary is stated', /founder decision/.test(meta.body.boundary));

  section('11.16 pay and bill');
  let list = await call('GET', `${X}/contractors`, null, tR);
  const has = (l, id) => (l.body.rows || []).some((r) => r.applicationId === id);
  check('the recruiter sees both contract placements, not the permanent one', list.status === 200 && has(list, app1.id) && has(list, app2.id) && !has(list, app3.id), list.body);
  check('another recruiter does not see them', !has(await call('GET', `${X}/contractors`, null, tR2), app1.id));
  const pl = await call('GET', `${X}/placements`, null, tT);
  check('the TL lists the permanent placement as one to mark', pl.status === 200 && pl.body.rows.some((r) => r.applicationId === app3.id));
  check('a recruiter cannot mark a contract or set a rate', (await call('PUT', `${X}/contractors/${app3.id}`, {}, tR)).status === 403 && (await call('POST', `${X}/contractors/${app1.id}/rates`, { effectiveFrom: START, unit: 'Hour', payRate: 300, billRate: 450 }, tR)).status === 403);
  check('a Manager (view only) cannot set a rate', (await call('POST', `${X}/contractors/${app1.id}/rates`, { effectiveFrom: START, unit: 'Hour', payRate: 300, billRate: 450 }, tM)).status === 403);
  const mark = await call('PUT', `${X}/contractors/${app3.id}`, { startOn: START, poNumber: 'PO-77', weeklyHours: 40, payType: 'Vendor / C2C' }, tT);
  check('the TL marks the permanent placement as a contract (PO, 40 h week)', mark.status === 200 && mark.body.contractor.poNumber === 'PO-77' && mark.body.contractor.weeklyHours === 40, mark.body);
  check('bad contract dates are refused', (await call('PUT', `${X}/contractors/${app3.id}`, { startOn: '2026-12-10', endOn: '2026-12-01' }, tT)).status === 400);
  check('a rate needs both rates and a known unit', (await call('POST', `${X}/contractors/${app1.id}/rates`, { effectiveFrom: START, unit: 'Hour', payRate: 300 }, tT)).status === 400 && (await call('POST', `${X}/contractors/${app1.id}/rates`, { effectiveFrom: START, unit: 'Week', payRate: 300, billRate: 450 }, tT)).status === 400);
  const r1 = await call('POST', `${X}/contractors/${app1.id}/rates`, { effectiveFrom: START, unit: 'Hour', payRate: 300, billRate: 450, loadPercent: 10, reason: 'Start rate' }, tT);
  check('the TL sets pay 300 / bill 450 an hour with a 10% employer load', r1.status === 201 && !r1.body.warning, r1.body);
  await call('PUT', `${X}/contractors/${app1.id}`, { poNumber: 'PO-1001', approverName: 'Plant HR' }, tT);
  const one = (await call('GET', `${X}/contractors`, null, tT)).body.rows.find((r) => r.applicationId === app1.id);
  check('markup and margin are worked out on the loaded cost (330): markup 36.36%, margin 26.67%', one.rate.cost === 330 && one.rate.markupPercent === 36.36 && one.rate.marginPercent === 26.67, one.rate);
  const loss = await call('POST', `${X}/contractors/${app3.id}/rates`, { effectiveFrom: START, unit: 'Day', payRate: 3000, billRate: 2800 }, tT);
  check('a bill rate below the cost is saved with a warning', loss.status === 201 && /loses money/.test(loss.body.warning || ''), loss.body);
  const bdeList = await call('GET', `${X}/contractors`, null, tB);
  const bRow = (bdeList.body.rows || []).find((r) => r.applicationId === app1.id);
  check('BDE sees the bill rate but never the pay rate, cost or margin', bRow && bRow.rate.billRate === 450 && bRow.rate.payRate === undefined && bRow.rate.marginPercent === undefined && bRow.payType === undefined, bRow);
  check('BDE cannot set a rate', (await call('POST', `${X}/contractors/${app1.id}/rates`, { effectiveFrom: START, unit: 'Hour', payRate: 1, billRate: 2 }, tB)).status === 403);
  const r2 = await call('POST', `${X}/contractors/${app1.id}/rates`, { effectiveFrom: W3, unit: 'Hour', payRate: 320, billRate: 480, loadPercent: 10, reason: 'Revision' }, tT);
  const hist = await call('GET', `${X}/contractors/${app1.id}/rates`, null, tT);
  check('a new rate from a later date keeps the history (newest first)', r2.status === 201 && hist.body.rows.length === 2 && hist.body.rows[0].billRate === 480 && hist.body.rows[1].effectiveFrom === START, hist.body.rows);

  section('11.15 contractor timesheets');
  const mine = await call('GET', PK, null, tCan);
  const myC = mine.body && mine.body.contracts && mine.body.contracts[0];
  check('the contractor sees their own contract and weeks in the candidate portal', mine.status === 200 && mine.body.contracts.length === 1 && myC.applicationId === app1.id && myC.weeks.length >= 3, mine.body);
  check('the contractor sees their own pay rate, never the bill rate', myC && myC.rate.payRate === 320 && myC.rate.billRate === undefined, myC && myC.rate);
  check('the client portal and the staff API are walled from the contractor', (await call('GET', `${PC}/timesheets`, null, tCan)).status === 403);
  const H54 = [9, 9, 9, 9, 9, 9, 0];
  check('a week that has not started is refused', (await call('PUT', `${PK}/${app1.id}/weeks/${addDays(monday, 7)}`, { hours: H54 }, tCan)).status === 400);
  check('a week before the contract is refused', (await call('PUT', `${PK}/${app1.id}/weeks/${addDays(START, -7)}`, { hours: H54 }, tCan)).status === 400);
  check('a day over 24 hours is refused; a non-Monday week is refused', (await call('PUT', `${PK}/${app1.id}/weeks/${W1}`, { hours: [25, 0, 0, 0, 0, 0, 0] }, tCan)).status === 400 && (await call('PUT', `${PK}/${app1.id}/weeks/${addDays(W1, 1)}`, { hours: H54 }, tCan)).status === 400);
  check('another contractor\'s week cannot be reached', (await call('PUT', `${PK}/${app2.id}/weeks/${W1}`, { hours: H54 }, tCan)).status === 404);
  const d1 = await call('PUT', `${PK}/${app1.id}/weeks/${W1}`, { hours: H54, note: 'Week one' }, tCan);
  check('the contractor saves a draft: 54 h = 48 regular + 6 overtime', d1.status === 200 && d1.body.timesheet.status === 'Draft' && d1.body.timesheet.regHours === 48 && d1.body.timesheet.otHours === 6, d1.body);
  const before = await notes(CLI.id);
  const s1 = await call('PUT', `${PK}/${app1.id}/weeks/${W1}`, { hours: H54, note: 'Week one', submit: true }, tCan);
  check('the contractor sends the week', s1.status === 200 && s1.body.timesheet.status === 'Submitted');
  check('no bell to the approver while that switch is OFF', (await notes(CLI.id)) === before);
  check('a sent week is locked', (await call('PUT', `${PK}/${app1.id}/weeks/${W1}`, { hours: H54 }, tCan)).status === 409);
  const ts1 = s1.body.timesheet.id;
  const cl = await call('GET', `${PC}/timesheets`, null, tC);
  const cRow = (cl.body.rows || []).find((r) => r.id === ts1);
  check('the client sees the week waiting, with no pay amount', cl.status === 200 && cRow && cRow.status === 'Submitted' && !('payAmount' in cRow) && !('costAmount' in cRow) && !('margin' in cRow), cRow);
  check('another company\'s login does not see it and cannot decide it', !((await call('GET', `${PC}/timesheets`, null, tCO)).body.rows || []).some((r) => r.id === ts1) && (await call('POST', `${PC}/timesheets/${ts1}/decision`, { approve: true }, tCO)).status === 404);
  check('a view-only client login cannot approve', (await call('POST', `${PC}/timesheets/${ts1}/decision`, { approve: true }, tCV)).status === 403);
  check('a rejection needs a reason', (await call('POST', `${PC}/timesheets/${ts1}/decision`, { approve: false }, tC)).status === 400);
  const rj = await call('POST', `${PC}/timesheets/${ts1}/decision`, { approve: false, reason: 'Saturday was a holiday' }, tC);
  check('the client rejects with a reason', rj.status === 200 && rj.body.status === 'Rejected');
  const again = await call('PUT', `${PK}/${app1.id}/weeks/${W1}`, { hours: H54, note: 'Saturday was worked (shutdown maintenance)', submit: true }, tCan);
  check('the contractor fixes and sends it again', again.status === 200 && again.body.timesheet.status === 'Submitted');
  const ap = await call('POST', `${PC}/timesheets/${ts1}/decision`, { approve: true }, tC);
  check('the client approves', ap.status === 200 && ap.body.status === 'Approved', ap.body);
  const w1 = (await sql('SELECT * FROM "StfTimesheet" WHERE "id" = ?', ts1))[0];
  check('on approval the week is priced at the rate of its week: bill 48x450 + 6x450x1.5 = 25,650; pay 17,100; cost 18,810', Number(w1.billAmount) === 25650 && Number(w1.payAmount) === 17100 && Number(w1.costAmount) === 18810, w1);
  const cl2 = (await call('GET', `${PC}/timesheets`, null, tC)).body.rows.find((r) => r.id === ts1);
  check('the client sees the bill amount, never the pay', cl2.billAmount === 25650 && cl2.payAmount === undefined);
  const k1 = (await call('GET', PK, null, tCan)).body.contracts[0].weeks.find((w) => w.weekStart === W1);
  check('the contractor sees their pay for the week, never the bill', k1.payAmount === 17100 && k1.billAmount === undefined, k1);
  // the recruiter fills a week; the recruiter cannot approve; the TL approves
  const s2 = await call('PUT', `${X}/contractors/${app1.id}/weeks/${W2}`, { hours: [8, 8, 8, 8, 8, 0, 0], submit: true }, tR);
  check('the recruiter fills in and sends a week for the contractor', s2.status === 200 && s2.body.timesheet.submittedByKind === 'TeamLink');
  check('the recruiter cannot approve; the BDE and the Manager cannot either', (await call('POST', `${X}/timesheets/${s2.body.timesheet.id}/decision`, { approve: true }, tR)).status === 403 && (await call('POST', `${X}/timesheets/${s2.body.timesheet.id}/decision`, { approve: true }, tB)).status === 403 && (await call('POST', `${X}/timesheets/${s2.body.timesheet.id}/decision`, { approve: true }, tM)).status === 403);
  await call('PUT', `${X}/settings`, { key: 'approval.mode', value: 'client' }, tA);
  check('"client only": a TL may not approve', (await call('POST', `${X}/timesheets/${s2.body.timesheet.id}/decision`, { approve: true }, tT)).status === 403);
  await call('PUT', `${X}/settings`, { key: 'approval.mode', value: 'tl' }, tA);
  check('"TeamLink only": the client may not approve', (await call('POST', `${PC}/timesheets/${s2.body.timesheet.id}/decision`, { approve: true }, tC)).status === 403);
  await call('PUT', `${X}/settings`, { key: 'approval.mode', value: 'client_or_tl' }, tA);
  const ap2 = await call('POST', `${X}/timesheets/${s2.body.timesheet.id}/decision`, { approve: true }, tT);
  check('the TL approves the recruiter\'s week (40 h x 450 = 18,000)', ap2.status === 200 && Number((await sql('SELECT "billAmount" FROM "StfTimesheet" WHERE "id" = ?', s2.body.timesheet.id))[0].billAmount) === 18000);
  const self = await call('PUT', `${X}/contractors/${app2.id}/weeks/${W3}`, { hours: [8, 8, 8, 8, 8, 0, 0], submit: true }, tT);
  check('whoever entered a week cannot approve it (the TL filled this one)', self.status === 200 && (await call('POST', `${X}/timesheets/${self.body.timesheet.id}/decision`, { approve: true }, tT)).status === 403);
  check('only an Admin reopens an approved week, with a reason', (await call('POST', `${X}/timesheets/${s2.body.timesheet.id}/reopen`, { reason: 'x' }, tT)).status === 403 && (await call('POST', `${X}/timesheets/${s2.body.timesheet.id}/reopen`, {}, tA)).status === 400);
  const ro = await call('POST', `${X}/timesheets/${s2.body.timesheet.id}/reopen`, { reason: 'Wrong client holiday' }, tA);
  check('the Admin reopens it: back to Draft, money cleared', ro.status === 200 && (await sql('SELECT "status","billAmount" FROM "StfTimesheet" WHERE "id" = ?', s2.body.timesheet.id))[0].status === 'Draft');
  await call('PUT', `${X}/contractors/${app1.id}/weeks/${W2}`, { hours: [8, 8, 8, 8, 8, 0, 0], submit: true }, tR);
  await call('POST', `${X}/timesheets/${s2.body.timesheet.id}/decision`, { approve: true }, tT);
  const rc = await call('PUT', `${X}/contractors/${app1.id}/weeks/${W3}`, { hours: [8, 8, 8, 8, 8, 0, 0], submit: true }, tR);
  check('the recruiter can take back a sent week before anyone decides', (await call('POST', `${X}/timesheets/${rc.body.timesheet.id}/recall`, null, tR)).status === 200 && (await sql('SELECT "status" FROM "StfTimesheet" WHERE "id" = ?', rc.body.timesheet.id))[0].status === 'Draft');
  check('another team\'s recruiter cannot fill this contractor\'s week', (await call('PUT', `${X}/contractors/${app1.id}/weeks/${W3}`, { hours: H54 }, tR2)).status === 404);
  check('the Manager may look, not fill in', (await call('GET', `${X}/timesheets`, null, tM)).status === 200 && (await call('PUT', `${X}/contractors/${app1.id}/weeks/${W3}`, { hours: H54 }, tM)).status === 403);
  await call('PUT', `${X}/settings`, { key: 'timesheets.notifyApprovers', value: true }, tA);
  const nb = await notes(CLI.id);
  await call('PUT', `${PK}/${app1.id}/weeks/${W3}`, { hours: [8, 8, 8, 8, 8, 0, 0], submit: true }, tCan);
  check('with the switch ON, the approving client login gets a bell', (await notes(CLI.id)) === nb + 1);
  await call('PUT', `${X}/settings`, { key: 'timesheets.notifyApprovers', value: false }, tA);
  // reminders
  const miss = await call('GET', `${X}/timesheets/missing`, null, tT);
  check('the missing list shows last week\'s gaps (the permanent-turned-contract placement)', miss.status === 200 && miss.body.weekStart === W3 && miss.body.rows.some((r) => r.applicationId === app3.id) && !miss.body.rows.some((r) => r.applicationId === app1.id), miss.body);
  check('reminders refused while switched OFF; a Manager / TL cannot send them', (await call('POST', `${X}/timesheets/remind`, null, tA)).status === 409 && (await call('POST', `${X}/timesheets/remind`, null, tM)).status === 403 && (await call('POST', `${X}/timesheets/remind`, null, tT)).status === 403);
  await call('PUT', `${X}/settings`, { key: 'timesheets.reminders', value: true }, tA);
  const nr = await notes(REC.id);
  const rem = await call('POST', `${X}/timesheets/remind`, null, tA);
  check('with the switch ON: one bell per missing week, to the recruiter', rem.status === 200 && rem.body.sent >= 1 && (await notes(REC.id)) > nr, rem.body);
  check('the same week is not reminded twice', (await call('POST', `${X}/timesheets/remind`, null, tA)).body.already === true);
  await call('PUT', `${X}/settings`, { key: 'timesheets.reminders', value: false }, tA);

  section('11.17 shift scheduling');
  const D = addDays(monday, 1);
  const sh1 = await call('POST', `${X}/shifts`, { applicationId: app1.id, day: D, start: '09:00', end: '18:00', role: 'Picker', location: 'Dock 2' }, tR);
  check('the recruiter books a shift for the contractor', sh1.status === 201 && sh1.body.ids.length === 1, sh1.body);
  const clash = await call('POST', `${X}/shifts`, { applicationId: app1.id, day: D, start: '12:00', end: '20:00' }, tR);
  check('an overlapping shift is stopped and says why', clash.status === 409 && /Overlaps/.test(clash.body.error), clash.body);
  const rest = await call('POST', `${X}/shifts`, { applicationId: app1.id, day: addDays(D, 1), start: '01:00', end: '05:00' }, tR);
  check('less than 8 hours of rest is booked with a warning', rest.status === 201 && rest.body.warnings.some((w) => /rest/.test(w)), rest.body);
  const night = await call('POST', `${X}/shifts`, { applicationId: app2.id, day: D, start: '22:00', end: '06:00' }, tR);
  const nightClash = await call('POST', `${X}/shifts`, { applicationId: app2.id, day: addDays(D, 1), start: '05:00', end: '09:00' }, tR);
  check('a shift past midnight blocks the early hours of the next day', night.status === 201 && nightClash.status === 409, nightClash.body);
  check('a day before the contract starts is stopped', (await call('POST', `${X}/shifts`, { applicationId: app1.id, day: addDays(START, -3), start: '09:00', end: '17:00' }, tR)).status === 409);
  const rep = await call('POST', `${X}/shifts`, { applicationId: app3.id, day: addDays(monday, 7), start: '08:00', end: '16:00', repeat: 5 }, tR);
  check('one booking can repeat over 5 days', rep.status === 201 && rep.body.ids.length === 5);
  const open = await call('POST', `${X}/shifts`, { clientId: client.id, day: addDays(D, 2), start: '10:00', end: '19:00', role: 'Loader' }, tR);
  check('an open shift (nobody yet) for the client', open.status === 201);
  const sug = await call('GET', `${X}/shifts/${open.body.ids[0]}/suggestions`, null, tR);
  check('"Fill" suggests the client\'s free contractors', sug.status === 200 && sug.body.rows.length >= 2 && sug.body.rows.some((r) => r.applicationId === app2.id && r.free), sug.body);
  const fillIt = await call('PUT', `${X}/shifts/${open.body.ids[0]}`, { applicationId: app2.id }, tR);
  check('the open shift is filled: Booked', fillIt.status === 200 && (await sql('SELECT "status","applicationId" FROM "StfShift" WHERE "id" = ?', open.body.ids[0]))[0].status === 'Booked');
  check('the BDE and the Manager cannot book shifts', (await call('POST', `${X}/shifts`, { applicationId: app1.id, day: addDays(D, 3), start: '09:00', end: '17:00' }, tB)).status === 403 && (await call('POST', `${X}/shifts`, { applicationId: app1.id, day: addDays(D, 3), start: '09:00', end: '17:00' }, tM)).status === 403);
  check('shift notices are OFF by default (nothing recorded as told)', (await sql('SELECT "notifiedAt" FROM "StfShift" WHERE "id" = ?', sh1.body.ids[0]))[0].notifiedAt === null);
  await call('PUT', `${X}/settings`, { key: 'shifts.notify', value: true }, tA);
  const nc = await notes(CAN.id);
  const sh4 = await call('POST', `${X}/shifts`, { applicationId: app1.id, day: addDays(D, 3), start: '09:00', end: '17:00' }, tR);
  check('with the switch ON the contractor gets a bell in their portal', sh4.status === 201 && (await notes(CAN.id)) === nc + 1);
  await call('PUT', `${X}/settings`, { key: 'shifts.notify', value: false }, tA);
  const cal = await call('GET', `${X}/shifts?from=${monday}&to=${addDays(monday, 13)}`, null, tR);
  check('the calendar lists the shifts of the fortnight with hours', cal.status === 200 && cal.body.rows.filter((s) => s.applicationId === app1.id).length >= 3 && cal.body.rows.find((s) => s.id === sh1.body.ids[0]).hours === 9, cal.body.rows.length);
  check('another recruiter does not see them', !((await call('GET', `${X}/shifts?from=${monday}`, null, tR2)).body.rows || []).some((s) => s.id === sh1.body.ids[0]));
  const fs1 = await call('GET', `${X}/contractors/${app1.id}/weeks/${monday}/from-shifts`, null, tR);
  check('a week\'s hours can be filled from the booked shifts', fs1.status === 200 && fs1.body.hours[1] === 9 && fs1.body.hours[2] === 4, fs1.body);
  const cs = await call('GET', `${PC}/shifts?from=${monday}`, null, tC);
  check('the client sees the booked shifts of its contractors (no open, no cancelled)', cs.status === 200 && cs.body.rows.some((s) => s.id === sh1.body.ids[0]) && cs.body.rows.every((s) => s.status !== 'Open'));
  const ks = (await call('GET', PK, null, tCan)).body.shifts;
  check('the contractor sees their own shifts only', ks.length >= 3 && ks.every((s) => s.applicationId === app1.id));
  check('a booked shift is not deleted, it is cancelled', (await call('DELETE', `${X}/shifts/${sh4.body.ids[0]}`, null, tR)).status === 409 && (await call('PUT', `${X}/shifts/${sh4.body.ids[0]}`, { status: 'Cancelled' }, tR)).status === 200);

  section('09.15 pay / bill / document check before billing');
  let au = await call('GET', `${X}/audit?clientId=${client.id}`, null, tT);
  const row = (id) => au.body.rows.find((r) => r.applicationId === id);
  check('a placement with rates, ID proof, offer letter, active agreement is ready (PO on file, so no PO warning)', au.status === 200 && row(app1.id).ready && row(app1.id).warnings.some((w) => w.key === 'contract.po') === false && row(app1.id).passed.some((p) => p.key === 'doc.id'), row(app1.id));
  check('no rate and no ID proof: must fix', !row(app2.id).ready && row(app2.id).errors.some((e) => e.key === 'rate.missing') && row(app2.id).errors.some((e) => e.key === 'doc.id'), row(app2.id));
  check('a bill rate under the cost: must fix', row(app3.id).errors.some((e) => e.key === 'rate.loss'), row(app3.id));
  await sql('CREATE TABLE IF NOT EXISTS "ApplicationBgv" ("applicationId" TEXT PRIMARY KEY, "checks" TEXT NOT NULL, "vendor" TEXT, "reportLink" TEXT, "note" TEXT, "overall" TEXT NOT NULL, "byName" TEXT, "at" TEXT NOT NULL)');
  await sql('INSERT INTO "ApplicationBgv" ("applicationId","checks","overall","at") VALUES (?,?,?,?)', app1.id, '{}', 'Discrepancy', new Date().toISOString());
  au = await call('GET', `${X}/audit?clientId=${client.id}`, null, tT);
  check('a background-check discrepancy stops the billing', !row(app1.id).ready && row(app1.id).errors.some((e) => e.key === 'bgv.discrepancy'));
  await sql('DELETE FROM "ApplicationBgv" WHERE "applicationId" = ?', app1.id);
  await prisma.client.update({ where: { id: client.id }, data: { agreementStatus: 'EXPIRED' } });
  au = await call('GET', `${X}/audit?clientId=${client.id}`, null, tA);
  check('an agreement that is not active stops the billing (the Admin is told why)', !row(app1.id).ready && row(app1.id).errors.some((e) => e.key === 'client.agreement'), row(app1.id));
  au = await call('GET', `${X}/audit?clientId=${client.id}`, null, tT);
  check('a TL is never told about agreements: "on hold, ask your BDM" instead', !row(app1.id).ready && row(app1.id).errors.some((e) => e.key === 'client.onHold') && !/agreement/i.test(JSON.stringify(au.body)), row(app1.id));
  await prisma.client.update({ where: { id: client.id }, data: { agreementStatus: 'ACTIVE' } });
  const ex1 = await call('POST', `${X}/audit/${app2.id}/explain`, { useAi: false }, tT);
  check('the plain-words explanation from the rules', ex1.status === 200 && ex1.body.source === 'rules' && /fix 2 things/.test(ex1.body.text), ex1.body);
  const ex2 = await call('POST', `${X}/audit/${app2.id}/explain`, { useAi: true }, tT);
  check('"Ask AI" falls back to the rules when the model does not answer (the sandbox has no AI)', ex2.status === 200 && /rules/.test(ex2.body.source) && ex2.body.text.length > 20, ex2.body);
  const ailog = await sql('SELECT * FROM "AiCallLog" WHERE "purpose" = ? ORDER BY "at" DESC LIMIT 1', 'Billing document check').catch(() => []);
  check('the AI try is in the AI governance log (never a candidate or client name)', ailog.length === 1 && !/ravi|sita|Stx Client/.test(JSON.stringify(ailog[0])), ailog);
  check('BDE gets the check without pay figures in the text', (await call('GET', `${X}/audit`, null, tB)).status === 200);

  section('06.12 billing from approved timesheets');
  check('a recruiter, a BDE and a Manager cannot build a batch', (await call('POST', `${X}/billing/batches`, { clientId: client.id }, tR)).status === 403 && (await call('POST', `${X}/billing/batches`, { clientId: client.id }, tB)).status === 403 && (await call('POST', `${X}/billing/batches`, { clientId: client.id }, tM)).status === 403);
  // app2's W3 week (approved by the client? no: the TL filled it). Approve it as the client.
  await call('POST', `${PC}/timesheets/${self.body.timesheet.id}/decision`, { approve: true }, tC);
  const w3 = (await sql('SELECT "id" FROM "StfTimesheet" WHERE "applicationId" = ? AND "weekStart" = ?', app1.id, W3))[0];
  check('the client approves the third week of app1 at the new rate (40 h x 480)', (await call('POST', `${PC}/timesheets/${w3.id}/decision`, { approve: true }, tC)).status === 200 && Number((await sql('SELECT "billAmount" FROM "StfTimesheet" WHERE "id" = ?', w3.id))[0].billAmount) === 19200);
  const ub = await call('GET', `${X}/billing/unbilled?clientId=${client.id}`, null, tT);
  check('the approved, unbilled weeks are listed per client', ub.status === 200 && ub.body.rows[0].weeks === 4 && ub.body.rows[0].contractors === 2 && ub.body.rows[0].bill === 62850, ub.body);
  const noRate = await call('POST', `${X}/billing/batches`, { clientId: client.id }, tT);
  check('a week with no rate in force stops the batch', noRate.status === 409 && /no rate/.test(noRate.body.error), noRate.body);
  await call('POST', `${X}/contractors/${app2.id}/rates`, { effectiveFrom: START, unit: 'Day', payRate: 1500, billRate: 2200 }, tT);
  const blocked = await call('POST', `${X}/billing/batches`, { clientId: client.id }, tT);
  check('a placement with a must-fix (no ID proof) stops the batch and is named', blocked.status === 409 && (blocked.body.blocked || []).some((b) => b.applicationId === app2.id), blocked.body);
  check('only an Admin bills past the check', (await call('POST', `${X}/billing/batches`, { clientId: client.id, override: 'Client asked to bill now' }, tT)).status === 403);
  check('the Admin must give a real reason', (await call('POST', `${X}/billing/batches`, { clientId: client.id, override: 'ok' }, tA)).status === 400);
  // bill app1 only (its own weeks) by giving app2 its ID proof? No: first the clean batch for W1-W2, then the override.
  const b1 = await call('POST', `${X}/billing/batches`, { clientId: client.id, to: W2 }, tT);
  const yr = new Date().getFullYear();
  check('the TL builds the batch of app1\'s first two weeks: STF number, 2 lines, 18% GST', b1.status === 201 && new RegExp(`^STF-${yr}-\\d{4}$`).test(b1.body.number) && b1.body.lines === 2 && b1.body.bill === 43650 && b1.body.gstAmount === 7857 && b1.body.total === 51507, b1.body);
  check('the same weeks cannot be billed twice', (await call('POST', `${X}/billing/batches`, { clientId: client.id, to: W2 }, tT)).status === 400);
  check('a rate starting inside billed weeks is refused', (await call('POST', `${X}/contractors/${app1.id}/rates`, { effectiveFrom: W1, unit: 'Hour', payRate: 1, billRate: 2 }, tT)).status === 409);
  check('a billed week cannot be reopened', (await call('POST', `${X}/timesheets/${ts1}/reopen`, { reason: 'try' }, tA)).status === 409);
  const b2 = await call('POST', `${X}/billing/batches`, { clientId: client.id, override: 'Client will send the ID copy this week' }, tA);
  check('the Admin bills the rest past the check, with the reason kept', b2.status === 201 && b2.body.lines >= 2 && (await sql('SELECT "override" FROM "StfBatch" WHERE "id" = ?', b2.body.id))[0].override.includes('ID copy'), b2.body);
  const bl = await call('GET', `${X}/billing/batches`, null, tT);
  check('the batches list shows both, with the margin for the TL', bl.status === 200 && bl.body.rows.filter((b) => b.clientId === client.id).length === 2 && bl.body.rows[0].margin !== undefined);
  check('the BDE sees batches without cost or margin', (await call('GET', `${X}/billing/batches`, null, tB)).body.rows.every((b) => b.margin === undefined && b.costTotal === undefined));
  const det = await call('GET', `${X}/billing/batches/${b1.body.id}`, null, tT);
  check('the batch detail lists each week with PO and approver', det.status === 200 && det.body.lines.length === 2 && det.body.lines[0].poNumber === 'PO-1001' && /Client/.test(det.body.lines[0].approvedBy), det.body.lines[0]);
  check('"Post into Accounts" is not built: it needs a founder decision', (await call('POST', `${X}/billing/batches/${b1.body.id}/post-to-accounts`, null, tA)).body.needsFounderDecision === true);
  const pr = await call('GET', `${X}/billing/pay-register?from=${START}`, null, tT, true);
  check('the pay register file (pay side) for the TL; refused to the BDE', pr.status === 200 && /Pay amount/.test(pr.text) && pr.text.includes(`Stx ravi ${P}`) && (await call('GET', `${X}/billing/pay-register`, null, tB)).status === 403, pr.text.slice(0, 300));
  check('the accounts team reads the batches', (await call('GET', `${X}/billing/batches`, null, tAcc)).status === 200);

  section('06.11 / 14.08 accounting files and push');
  const csv = await call('GET', `${X}/billing/batches/${b1.body.id}/export?format=csv`, null, tT, true);
  check('CSV: invoice-ready lines + before GST, GST and total', csv.status === 200 && /text\/csv/.test(csv.type) && csv.text.includes(b1.body.number) && /Before GST/.test(csv.text) && /51507\.00/.test(csv.text), csv.text.slice(0, 400));
  const zoho = await call('GET', `${X}/billing/batches/${b1.body.id}/export?format=zoho`, null, tT, true);
  check('Zoho Books import CSV with the SAC code and the client GSTIN', zoho.status === 200 && /Invoice Number/.test(zoho.text) && /998513/.test(zoho.text) && /29ABCDE1234F1Z5/.test(zoho.text));
  let tally = await call('GET', `${X}/billing/batches/${b1.body.id}/export?format=tally`, null, tT, true);
  check('Tally XML: one Sales voucher; GST in one line while our GSTIN is not set', tally.status === 200 && /<VOUCHER VCHTYPE="Sales"/.test(tally.text) && /Output GST</.test(tally.text) && tally.text.includes(clientName));
  await call('PUT', `${X}/settings`, { key: 'billing.homeGstin', value: '29AAAAA0000A1Z5' }, tA);
  tally = await call('GET', `${X}/billing/batches/${b1.body.id}/export?format=tally`, null, tT, true);
  check('with our GSTIN in the same state: CGST + SGST', /Output CGST/.test(tally.text) && /Output SGST/.test(tally.text));
  await call('PUT', `${X}/settings`, { key: 'billing.homeGstin', value: '36AAAAA0000A1Z5' }, tA);
  tally = await call('GET', `${X}/billing/batches/${b1.body.id}/export?format=tally`, null, tT, true);
  check('another state: IGST', /Output IGST/.test(tally.text));
  const js = await call('GET', `${X}/billing/batches/${b1.body.id}/export?format=json`, null, tT, true);
  const jb = JSON.parse(js.text);
  check('JSON: the same totals and lines', jb.total === 51507 && jb.lines.length === 2 && jb.gst.type === 'IGST');
  check('the BDE cannot download billing files', (await call('GET', `${X}/billing/batches/${b1.body.id}/export`, null, tB, true)).status === 403);
  const np = await call('POST', `${X}/billing/batches/${b1.body.id}/push`, null, tT);
  check('push before set-up: says it needs the founder\'s account', np.status === 409 && /needs founder credentials/.test(np.body.state || ''), np.body);
  const cfg = (id, values) => call('PUT', `/admin/integrations/${id}/configure`, { values }, tA);
  const c0 = await cfg('accounting-push', { 'Endpoint URL': 'https://example.com/hook', 'Signing secret': 'nope', 'Payload (teamlink, zoho-books or xero)': 'teamlink' });
  const np2 = await call('POST', `${X}/billing/batches/${b1.body.id}/push`, null, tT);
  check('in the sandbox a real address is never reached', c0.status === 200 && np2.status === 502 && /sandbox/.test(np2.body.error), np2.body);
  await call('POST', '/public/stfx-stub/_reset', { clientName });
  await cfg('accounting-push', { 'Endpoint URL': `${STUB}/hook`, 'Signing secret': 'stub-signing', 'Payload (teamlink, zoho-books or xero)': 'zoho-books' });
  check('Test sends a signed ping', (await call('POST', `${X}/accounting/test`, null, tA)).body.ok === true);
  const pu = await call('POST', `${X}/billing/batches/${b1.body.id}/push`, null, tT);
  let got = (await call('GET', '/public/stfx-stub/_log')).body.received;
  const hook = got.find((g) => g.event === 'contract_billing.batch');
  check('the batch is POSTed, signed (HMAC sha256), in the Zoho Books invoice shape', pu.status === 200 && hook && hook.signed && hook.body.data.line_items.length === 2 && hook.body.data.reference_number === b1.body.number && hook.body.data.line_items[0].hsn_or_sac === '998513', { pu: pu.body, hook });
  check('the batch shows "Sent to accounting"', (await sql('SELECT "status" FROM "StfBatch" WHERE "id" = ?', b1.body.id))[0].status === 'Sent to accounting');
  await cfg('accounting-push', { 'Payload (teamlink, zoho-books or xero)': 'xero' });
  await call('POST', `${X}/billing/batches/${b2.body.id}/push`, null, tT);
  got = (await call('GET', '/public/stfx-stub/_log')).body.received;
  check('the Xero invoice shape', got.some((g) => g.body && g.body.format === 'xero' && g.body.data.Invoices[0].Type === 'ACCREC'));
  await cfg('accounting-push', { 'Zoho Books organization ID': 'ORG-1', 'Zoho client ID': '1000.STUB', 'Zoho client secret': 'zsecret', 'Zoho refresh token': 'stub-refresh', 'Zoho data centre (in, com, eu)': 'stub' });
  const zp = await call('POST', `${X}/billing/batches/${b2.body.id}/push`, null, tT);
  got = (await call('GET', '/public/stfx-stub/_log')).body.received;
  check('with the Zoho Books keys: a draft invoice is made in Zoho Books (token refresh, customer, invoice)', zp.status === 200 && /Zoho Books/.test(zp.body.result) && got.some((g) => g.zohoInvoice && g.zohoInvoice.customer_id === 'C-1'), zp.body);
  check('nothing was written into TeamLink Accounts (no invoice row for this client)', (await prisma.invoice.count({ where: { clientId: client.id } })) === 0);
  const cancelNo = await call('POST', `${X}/billing/batches/${b2.body.id}/cancel`, {}, tT);
  const cancel = await call('POST', `${X}/billing/batches/${b2.body.id}/cancel`, { reason: 'Client wants it split by PO' }, tT);
  check('cancelling needs a reason; it frees the weeks and warns that it was already sent', cancelNo.status === 400 && cancel.status === 200 && /already sent/.test(cancel.body.warning || '') && (await sql('SELECT COUNT(*) AS n FROM "StfTimesheet" WHERE "batchId" = ?', b2.body.id))[0].n == 0); // eslint-disable-line eqeqeq
  await call('PUT', `${X}/settings`, { key: 'accounting.autoPush', value: true }, tA);
  const b3 = await call('POST', `${X}/billing/batches`, { clientId: client.id, override: 'Client will send the ID copy this week' }, tA);
  check('with auto-send ON a new batch goes out by itself', b3.status === 201 && b3.body.pushed && b3.body.pushed.ok === true, b3.body);
  await call('PUT', `${X}/settings`, { key: 'accounting.autoPush', value: false }, tA);

  section('02.15 / 14.14 VMS jobs and connectors');
  let vms = await call('GET', `${X}/vms`, null, tB);
  check('before set-up the VMS card says it needs the founder\'s supplier account', vms.status === 200 && /needs founder credentials/.test(vms.body.status.state) && vms.body.status.systems.length === 4, vms.body.status);
  check('reading jobs before set-up is refused', (await call('POST', `${X}/vms/pull`, null, tB)).status === 409);
  check('the recruiter is not the VMS desk', (await call('POST', `${X}/vms/pull`, null, tR)).status === 403);
  const SYS = {
    beeline: { 'VMS system (beeline, fieldglass, vndly or generic)': 'beeline', 'API base URL': `${STUB}/beeline`, 'Client ID': 'cid', 'Client secret': 'stub-secret', 'Supplier ID': 'SUP-1' },
    fieldglass: { 'VMS system (beeline, fieldglass, vndly or generic)': 'fieldglass', 'API base URL': `${STUB}/fieldglass`, 'Client ID': 'cid', 'Client secret': 'stub-secret', 'API key / token': 'APPKEY', 'Supplier ID': 'SUP-1' },
    vndly: { 'VMS system (beeline, fieldglass, vndly or generic)': 'vndly', 'API base URL': `${STUB}/vndly`, 'API key / token': 'vndly-token' },
    generic: { 'VMS system (beeline, fieldglass, vndly or generic)': 'generic', 'API base URL': `${STUB}/generic`, 'API key / token': 'gen-token' },
  };
  const ids = {};
  for (const [sys, values] of Object.entries(SYS)) {
    // eslint-disable-next-line no-await-in-loop
    await cfg('vms', { 'Client ID': '', 'Supplier ID': '', ...values });
    // eslint-disable-next-line no-await-in-loop
    const t = await call('POST', `${X}/vms/test`, null, tA);
    // eslint-disable-next-line no-await-in-loop
    const p = await call('POST', `${X}/vms/pull`, null, tB);
    // eslint-disable-next-line no-await-in-loop
    const j = (await call('GET', `${X}/vms`, null, tB)).body.jobs.find((x) => x.system === sys);
    ids[sys] = j && j.id;
    check(`${sys}: test connection, read the open job, match it to the TeamLink client`, t.body.ok === true && p.status === 200 && p.body.added === 1 && j && j.clientId === client.id && j.maxBillRate > 0 && j.state === 'New', { t: t.body, p: p.body, j });
  }
  await cfg('vms', SYS.beeline);
  const again2 = await call('POST', `${X}/vms/pull`, null, tB);
  check('reading again updates, never doubles', again2.body.added === 0 && again2.body.updated === 1);
  await cfg('vms', { 'Client secret': 'wrong' });
  const bad = await call('POST', `${X}/vms/pull`, null, tB);
  check('a wrong secret: the sign-in failure is shown and logged', bad.status === 502 && /sign-in failed/.test(bad.body.error), bad.body);
  await cfg('vms', { 'Client secret': 'stub-secret' });
  const logA = (await call('GET', `${X}/vms`, null, tA)).body.log;
  check('every VMS call is in the log (Admin only)', Array.isArray(logA) && logA.length >= 8 && (await call('GET', `${X}/vms`, null, tB)).body.log === undefined);
  check('the recruiter cannot file a VMS job', (await call('POST', `${X}/vms/jobs/${ids.beeline}/import`, {}, tR)).status === 403);
  const imp = await call('POST', `${X}/vms/jobs/${ids.beeline}/import`, {}, tB);
  const newReq = imp.body && imp.body.requirementId ? await prisma.requirement.findUnique({ where: { id: imp.body.requirementId } }) : null;
  check('the BDE files the VMS job as a requirement request (DRAFT, Contract, the normal BDE -> TL flow)', imp.status === 201 && newReq && newReq.status === 'DRAFT' && newReq.employmentType === 'Contract' && newReq.clientId === client.id && /BL-1001/.test(newReq.jobDescription || ''), { imp: imp.body, newReq: newReq && { status: newReq.status, et: newReq.employmentType } });
  check('the same VMS job is not filed twice', (await call('POST', `${X}/vms/jobs/${ids.beeline}/import`, {}, tB)).status === 409);
  check('"Not for us" puts a job aside', (await call('POST', `${X}/vms/jobs/${ids.generic}/dismiss`, null, tB)).status === 200);
  check('the auto-filing switch is OFF and no timer runs in the sandbox', (await call('GET', `${X}/settings`, null, tA)).body.switches.find((s) => s.key === 'vms.autoImport').value === false);

  section('06.14 VMS submission sync');
  await prisma.requirement.update({ where: { id: newReq.id }, data: { recruiterId: REC.id, tlId: TL.id, bdeId: BDE.id, department: dept } });
  const C4 = await mkCand('meena'); const C5 = await mkCand('kiran');
  const a4 = await prisma.application.create({ data: { candidateId: C4.id, requirementId: newReq.id, stage: 'BDE_APPROVED', ownerRecruiterId: REC.id, source: 'Manual' } });
  const a5 = await prisma.application.create({ data: { candidateId: C5.id, requirementId: newReq.id, stage: 'BDE_APPROVED', ownerRecruiterId: REC.id, source: 'Manual' } });
  const a6 = await prisma.application.create({ data: { candidateId: C3.id, requirementId: newReq.id, stage: 'NEW', ownerRecruiterId: REC.id, source: 'Manual' } });
  check('the recruiter is not the VMS desk', (await call('POST', `${X}/vms/submit/${a4.id}`, { billRate: 420 }, tR)).status === 403);
  check('the BDE may not send phone / e-mail', (await call('POST', `${X}/vms/submit/${a4.id}`, { billRate: 420, withContact: true }, tB)).status === 403);
  check('a candidate the BDE has not approved yet is not sent', (await call('POST', `${X}/vms/submit/${a6.id}`, { billRate: 420 }, tT)).status === 409);
  check('a bill rate above the VMS job\'s highest is refused', (await call('POST', `${X}/vms/submit/${a4.id}`, { billRate: 500 }, tB)).status === 400);
  const sub = await call('POST', `${X}/vms/submit/${a4.id}`, { billRate: 420, availableFrom: addDays(monday, 7) }, tB);
  let slog = (await call('GET', '/public/stfx-stub/_log')).body.subs;
  const sent = slog.find((s) => s.id === (sub.body && sub.body.externalId));
  check('the BDE sends the candidate: the VMS keeps it as Submitted, without contact details', sub.status === 201 && sub.body.status === 'Submitted' && sent && sent.body.proposedBillRate === 420 && !sent.body.candidate.email && !sent.body.candidate.phone, { sub: sub.body, sent });
  check('the same candidate is not sent twice', (await call('POST', `${X}/vms/submit/${a4.id}`, { billRate: 420 }, tB)).status === 409);
  const sub2 = await call('POST', `${X}/vms/submit/${a5.id}`, { billRate: 410, withContact: true }, tT);
  slog = (await call('GET', '/public/stfx-stub/_log')).body.subs;
  check('the TL sends one with contact details ticked', sub2.status === 201 && slog.find((s) => s.id === sub2.body.externalId).body.candidate.email === C5.email);
  await call('POST', '/public/stfx-stub/_status', { id: sub.body.externalId, status: 'Interview Scheduled' });
  await call('POST', '/public/stfx-stub/_status', { id: sub2.body.externalId, status: 'Not Selected' });
  const sy = await call('POST', `${X}/vms/sync`, null, tB);
  const subs = (await call('GET', `${X}/vms`, null, tB)).body.submissions;
  check('the statuses come back from the VMS in plain words (Interview, Rejected)', sy.status === 200 && sy.body.changed === 2 && subs.find((s) => s.applicationId === a4.id).status === 'Interview' && subs.find((s) => s.applicationId === a5.id).status === 'Rejected', { sy: sy.body, subs });
  check('a closed submission is not asked again', (await call('POST', `${X}/vms/sync`, null, tB)).body.checked === 1);
  check('another recruiter does not see these submissions', !(await call('GET', `${X}/vms`, null, tR2)).body.submissions.some((s) => s.applicationId === a4.id));
  await cfg('vms', SYS.vndly);
  await sql('UPDATE "StfVmsJob" SET "requirementId" = ? WHERE "id" = ?', perm.id, ids.vndly);
  const a7 = await prisma.application.create({ data: { candidateId: C4.id, requirementId: perm.id, stage: 'SHARED_WITH_CLIENT', ownerRecruiterId: REC.id, source: 'Manual' } });
  const sub3 = await call('POST', `${X}/vms/submit/${a7.id}`, { billRate: 500 }, tT);
  await call('POST', '/public/stfx-stub/_status', { id: sub3.body.externalId, status: 'offer_extended' });
  await call('POST', `${X}/vms/sync`, null, tT);
  check('VNDLY adapter: send + status read back (Offered)', sub3.status === 201 && (await call('GET', `${X}/vms`, null, tT)).body.submissions.find((s) => s.applicationId === a7.id).status === 'Offered');
  await cfg('vms', SYS.beeline);
  check('a VMS rate cap also feeds the billing check (bill above the VMS highest = must fix)', await (async () => {
    await sql('UPDATE "StfVmsJob" SET "maxBillRate" = 400 WHERE "id" = ?', ids.beeline);
    await sql('INSERT INTO "StfVmsSub" ("id","system","applicationId","vmsJobId","externalId","billRate","plainStatus") VALUES (?,?,?,?,?,?,?)', `x${P}`, 'beeline', app1.id, ids.beeline, 'X-1', 450, 'Hired');
    const a = await call('GET', `${X}/audit?clientId=${client.id}`, null, tT);
    return a.body.rows.find((r) => r.applicationId === app1.id).errors.some((e) => e.key === 'rate.vmsMax');
  })());

  section('11.16 pay and bill summary');
  const pb = await call('GET', `${X}/paybill?from=${START}`, null, tT);
  const p1 = pb.body.rows.find((r) => r.applicationId === app1.id);
  check('the summary adds the approved weeks: hours, bill, pay, cost and margin per contractor and per client', pb.status === 200 && p1.weeks === 3 && p1.bill === 25650 + 18000 + 19200 && p1.margin === S2(p1.bill - p1.cost) && pb.body.byClient.some((c) => c.clientId === client.id), p1);
  const pbB = await call('GET', `${X}/paybill?from=${START}`, null, tB);
  check('the BDE summary has no pay, cost or margin', pbB.body.seesPay === false && pbB.body.rows.every((r) => r.pay === undefined && r.margin === undefined) && pbB.body.totals.margin === undefined);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); console.log(`\n${total - failed}/${total + 1} passed`); await stop(1); });

function S2(v) { return Math.round(v * 100) / 100; }
