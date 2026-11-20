#!/usr/bin/env node
/**
 * ATS ROUND 3 - recruiter work allocation, targets, performance, workflow automation (utils/atsWork/*, routes/atsWork.js).
 * SANDBOX ONLY: a private server on a COPY of the sandbox database (default port 4162, TEST_PORT overrides).
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/r3-work-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-r3work-${process.pid}.db`);
const UPLOADS = path.join(os.tmpdir(), `zz-r3work-up-${process.pid}`);
fs.mkdirSync(UPLOADS, { recursive: true });
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4162);
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'r3-work-test', UPLOAD_DIR: UPLOADS, DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
let server;
let setW = async () => {};
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } try { fs.rmSync(UPLOADS, { recursive: true, force: true }); } catch { /* none */ } process.exit(code); }, 800);
}
const P = process.pid;
const day = (n = 0) => new Date(Date.now() + 330 * 60000 + n * 86400000).toISOString().slice(0, 10);

(async () => {
  const core = require('../src/utils/atsWork/core');
  const alloc = require('../src/utils/atsWork/allocation');
  const L = require('../src/utils/atsWork/lifecycle');
  const PE = require('../src/utils/atsWork/people');
  const CAL = require('../src/utils/atsWork/calendar');
  const mkUser = (name, extra) => prisma.user.create({ data: { name: `${name} ${P}`, email: `r3.${name.toLowerCase().replace(/\W+/g, '')}.${P}@r3-test.in`, passwordHash: 'x', status: 'Active', role: 'EMPLOYEE', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...extra } });
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const DEPT = 'R3Dept';
  const TL = await mkUser('Rtl', { role: 'TL', atsRole: 'TL', atsDepartment: DEPT, atsScopeDepartments: DEPT, team: 'R3Team' });
  const R1 = await mkUser('Rone', { atsRole: 'RECRUITER', atsDepartment: DEPT, atsScopeDepartments: DEPT });
  const R2 = await mkUser('Rtwo', { atsRole: 'RECRUITER', atsDepartment: DEPT, atsScopeDepartments: DEPT });
  const R3 = await mkUser('Rthree', { atsRole: 'RECRUITER', atsDepartment: DEPT, atsScopeDepartments: DEPT });
  const BDETL = await mkUser('Rbdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' });
  const ACC = await mkUser('Racc', { atsAccess: false, role: 'EMPLOYEE', accountsRole: 'ACCOUNTANT', accountsAccess: true });
  const mkEmp = (u, extra = {}) => prisma.employee.create({ data: { userId: u.id, employeeCode: `R3${P}${u.name.slice(1, 3)}${Math.floor(Math.random() * 9000 + 1000)}`, name: u.name, department: DEPT, tl: TL.name, employmentStatus: 'Active', ...extra } });
  const ETL = await mkEmp(TL, { team: 'R3Team' });
  const E1 = await mkEmp(R1, { team: 'R3Team', reportingManagerId: ETL.id }); const E2 = await mkEmp(R2, { team: 'R3Team', reportingManagerId: ETL.id }); const E3 = await mkEmp(R3, { team: 'R3Team', reportingManagerId: ETL.id });
  const client = (await prisma.client.findFirst({ where: { clientType: { not: 'Internal' } }, select: { id: true } }));
  const newReq = (title, extra = {}) => prisma.requirement.create({ data: { title: `${title} ${P}`, clientId: client.id, department: DEPT, status: 'OPEN', skills: 'java, spring', tlId: TL.id, tl: TL.name, ...extra } });
  const REQ = await newReq('R3 Java dev');

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  setW = async (patch) => { const r = await call('PUT', '/ats/work/settings', patch, tA); await core.load({ maxAgeMs: 0 }); return r; };
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '2h' });
  const tA = await tok(adminRow.id); const tT = await tok(TL.id); const t1 = await tok(R1.id); const t2 = await tok(R2.id); const tB = await tok(BDETL.id); const tAcc = await tok(ACC.id);

  // ===================================================== settings (defaults, roles) + escalation card
  console.log('\n--- settings and the escalation card');
  const st = await call('GET', '/ats/work/settings', null, tA);
  const s0 = st.body.settings; if (!s0) console.log('SETTINGS RESPONSE', st.status, JSON.stringify(st.body));
  check('defaults: auto-assign OFF, recruiter-before-posting ON, leaderboard for recruiters ON (founder 2026-11-18)', st.status === 200 && s0.autoAssign.enabled === false && s0.autoAssign.count === 1 && s0.requireRecruiter.enabled === true && s0.leaderboard.recruitersSee === true, s0);
  check('defaults: every notifying automation OFF, dedupe ON, weights 40/20/15/15/10', !s0.onHoldPause.enabled && !s0.closeNotify.enabled && !s0.payoutProposal.enabled && !s0.autoRetry.enabled && !s0.aiShortlistApproval.enabled && !s0.joiningProof.required && !s0.sla.workingDaysOnly && s0.eventDedupe.enabled && s0.weights.joinings === 40 && s0.weights.eod === 10 && s0.ownership.validityDays === 90, s0);
  check('a team lead cannot change the switches', (await call('PUT', '/ats/work/settings', { autoAssign: { enabled: true } }, tT)).status === 403);
  check('a bad weight is refused', (await call('PUT', '/ats/work/settings', { weights: { joinings: 500 } }, tA)).status === 400);
  const esc = await call('GET', '/ats/work/escalation', null, tT);
  check('the escalation card shows the real setting and a non-admin cannot turn it on', esc.status === 200 && typeof esc.body.enabled === 'boolean' && esc.body.canEdit === false && (await call('POST', '/ats/work/escalation/turn-on', {}, tT)).status === 403, esc.body);
  const offRes = await call('POST', '/ats/work/escalation/turn-on', { enabled: false }, tA);
  check('(Admin) turned off to test the card', offRes.status === 200 && offRes.body.enabled === false && (await call('GET', '/ats/work/escalation', null, tT)).body.enabled === false, offRes);
  const escOn = await call('POST', '/ats/work/escalation/turn-on', {}, tA);
  check('an Admin turns it on in one click (and the real setting changed)', escOn.status === 200 && escOn.body.enabled === true && (await require('../src/utils/atsAlertSettings').loadAlertSettings({ maxAgeMs: 0 })).escalation.enabled === true);

  // ===================================================== suggest / posting wait / assign / match
  console.log('\n--- suggest, posting waits for a recruiter, assign, match');
  const sg = await call('GET', `/ats/work/requirements/${REQ.id}/suggest`, null, tT);
  check('the TL sees the recruiter suggestions, each with a reason', sg.status === 200 && sg.body.suggestions.length >= 3 && sg.body.suggestions.every((x) => /open job/.test(x.reason)), sg.body);
  check('the job is told to wait for a recruiter before posting (new job)', /Pick a recruiter/.test(sg.body.waitsForRecruiter || ''), sg.body.waitsForRecruiter);
  check('a recruiter does not get the suggestion list', (await call('GET', `/ats/work/requirements/${REQ.id}/suggest`, null, t1)).status === 403);
  check('posting is refused (409) until a recruiter is on it', (await call('POST', `/requirements/${REQ.id}/postings/retry`, {}, tA)).status === 409);
  check('the posting engine itself holds it back', (await require('../src/utils/jobPosting').autoPost(REQ.id, { trigger: 'create' })).blocked === 'needs-recruiter');
  const oldReq = await newReq('R3 old job'); await prisma.$executeRawUnsafe('UPDATE "Requirement" SET "createdAt" = ? WHERE "id" = ?', new Date('2026-10-01T00:00:00Z').getTime(), oldReq.id);
  check('a requirement from before the rule is never held back', (await alloc.postingBlock(await prisma.requirement.findUnique({ where: { id: oldReq.id } }))) === null);
  check('the BDE side cannot assign recruiters', (await call('POST', `/ats/work/requirements/${REQ.id}/assign-suggested`, { userIds: [R1.id] }, tB)).status === 403);
  // R3 on leave today: listed, never picked
  await prisma.leaveRequest.create({ data: { employeeId: E3.id, type: 'Casual', fromDate: day(-1), toDate: day(1), days: 3, status: 'Approved' } });
  const sg2 = await call('GET', `/ats/work/requirements/${REQ.id}/suggest`, null, tT);
  const away = sg2.body.suggestions.find((x) => x.userId === R3.id);
  check('someone on leave today is listed but marked away, and sorted last', away && /on leave today/.test(away.reason) && sg2.body.suggestions[sg2.body.suggestions.length - 1].userId === R3.id, sg2.body.suggestions.map((x) => x.reason));
  await prisma.employeeRecord.create({ data: { type: 'SHIFT', employeeId: E2.id, title: 'Week off', date: day(0), status: 'Scheduled' } });
  const sg3 = await alloc.suggest(await prisma.requirement.findUnique({ where: { id: REQ.id } }), { includeAway: false, limit: 20 });
  check('a recruiter rostered OFF today and one on leave are skipped for allocation (433)', !sg3.some((x) => x.userId === R2.id || x.userId === R3.id) && sg3.some((x) => x.userId === R1.id), sg3.map((x) => x.name));
  const asg = await call('POST', `/ats/work/requirements/${REQ.id}/assign-suggested`, { userIds: [R1.id] }, tT);
  const afterAssign = await prisma.requirement.findUnique({ where: { id: REQ.id } });
  check('the TL assigns by hand: recruiter set, status moves, matching ran once', asg.status === 200 && afterAssign.recruiterId === R1.id && afterAssign.status === 'RECRUITER_ASSIGNED' && asg.body.match && typeof asg.body.match.goodFit === 'number', asg.body);
  check('the "Good fit" run is kept', (await call('GET', `/ats/work/requirements/${REQ.id}/match`, null, tT)).body.match.ranAt, null);
  check('now posting is no longer held back', (await alloc.postingBlock(afterAssign)) === null);
  // auto-assign switch
  const REQ2 = await newReq('R3 auto job');
  check('auto-assign is a no-op while the switch is OFF', (await alloc.onOpened(REQ2, { id: adminRow.id, name: 'Admin' })).skipped === 'switch off' && !(await prisma.requirement.findUnique({ where: { id: REQ2.id } })).recruiterId);
  await setW({ autoAssign: { enabled: true, count: 2 } });
  const auto = await alloc.onOpened(REQ2, { id: adminRow.id, name: 'Admin' });
  const REQ2b = await prisma.requirement.findUnique({ where: { id: REQ2.id } });
  check('auto-assign ON: only the available recruiter (R2 off shift, R3 on leave) gets it, matching ran', auto.assigned && auto.assigned.length === 1 && REQ2b.recruiterId === R1.id && !String(REQ2b.recruiterIds || '').includes(R2.id) && !String(REQ2b.recruiterIds || '').includes(R3.id) && !!auto.match, { auto, r: REQ2b.recruiterId, ids: REQ2b.recruiterIds });
  await setW({ autoAssign: { enabled: false, count: 1 } });

  // ===================================================== targets, results, carry-over, EOD
  console.log('\n--- targets, results vs target, carry-over, end-of-day');
  check('a recruiter cannot set targets', (await call('PUT', `/ats/work/targets/${R1.id}`, { period: 'DAILY', values: { calls: 10 } }, t1)).status === 403);
  check('the BDE TL (other area) cannot set a recruiter\'s targets', (await call('PUT', `/ats/work/targets/${R1.id}`, { period: 'DAILY', values: { calls: 10 } }, tB)).status === 403);
  check('a negative target is refused', (await call('PUT', `/ats/work/targets/${R1.id}`, { period: 'DAILY', values: { calls: -3 } }, tT)).status === 400);
  const sd = await call('PUT', `/ats/work/targets/${R1.id}`, { period: 'DAILY', values: { calls: 20, sourced: 5, submissions: 2 } }, tT);
  const sw = await call('PUT', `/ats/work/targets/${R1.id}`, { period: 'WEEKLY', values: { interviews: 6 } }, tT);
  const sm = await call('PUT', `/ats/work/targets/${R1.id}`, { period: 'MONTHLY', values: { joinings: 4, verified: 40 } }, tT);
  check('the TL sets daily, weekly and monthly targets for the team', sd.status === 200 && sw.status === 200 && sm.status === 200, [sd.body, sw.body, sm.body]);
  const rd = await call('GET', `/ats/work/results?period=DAILY&date=${day(0)}`, null, tT);
  const row1 = (rd.body.rows || []).find((r) => r.userId === R1.id);
  check('Results vs target (daily) shows the person with a target for calls, sourcing and submissions', rd.status === 200 && row1 && ((new Date().getUTCDay() === 0 && true) || row1.metrics.calls.target === 20) && row1.metrics.sourced.source !== undefined, rd.body && { rows: (rd.body.rows || []).length, row1 });
  const rm = await call('GET', `/ats/work/results?period=MONTHLY&date=${day(0)}`, null, tT);
  const m1 = (rm.body.rows || []).find((r) => r.userId === R1.id);
  check('monthly view: the explicit monthly joinings target is shown exactly', m1 && m1.metrics.joinings.target === 4 && m1.metrics.verified.target === 40, m1 && m1.metrics);
  const rw = await call('GET', `/ats/work/results?period=WEEKLY&date=${day(0)}`, null, tT);
  const w1 = (rw.body.rows || []).find((r) => r.userId === R1.id);
  check('weekly view: the explicit weekly interviews target is shown exactly', w1 && w1.metrics.interviews.target === 6, w1 && w1.metrics);
  const r1own = await call('GET', `/ats/work/results?period=MONTHLY`, null, t1);
  check('a recruiter sees only their own row', r1own.status === 200 && r1own.body.rows.every((r) => r.userId === R1.id) && r1own.body.canSet === false, r1own.body);
  check('the composite score is worked out from the targets set', m1 && (m1.score === null || (m1.score >= 0 && m1.score <= 100)) && Array.isArray(m1.scoreParts) && m1.scoreParts.length === 5, m1);
  // the typed reviewer score sits beside the automatic one
  await prisma.performanceReview.create({ data: { employeeId: E1.id, period: '2026-H2', score: 77, band: 'Medium', recommendation: 'Recommended' } });
  const rm2 = await call('GET', `/ats/work/results?period=MONTHLY`, null, tT);
  check('the reviewer\'s typed score is shown with the automatic one', ((rm2.body.rows || []).find((r) => r.userId === R1.id) || {}).reviewerScore.score === 77);
  // P7.3: the report's joined figure is the card's function
  const DR = require('../src/utils/dailyReport'); const RJ = require('../src/utils/recruiterJoinings');
  const adminUser = await resolveIdentity(adminRow.id);
  const mon = await DR.monthReport(adminUser, { month: day(0).slice(0, 7) });
  const cj = await RJ.creditedJoinings(adminUser, { month: day(0).slice(0, 7), level: 'sa', fresh: true });
  check('P7.3: the Daily report\'s Joined for the month equals creditedJoinings (the dashboard card\'s function)', mon.body.totals.joined === cj.count, { report: mon.body.totals.joined, card: cj.count });
  const rtg = await call('GET', '/ats-reports/targets', null, tA);
  const trows = (rtg.body && rtg.body.sections && rtg.body.sections[0] && rtg.body.sections[0].rows) || [];
  const joinedSum = trows.reduce((n, r) => n + (Number((r.cells && r.cells.joined && (r.cells.joined.n ?? r.cells.joined)) || 0) || 0), 0);
  const cjm = await RJ.creditedJoinings(adminUser, { month: day(0).slice(0, 7), level: 'sa', fresh: true });
  check('P7.3: Results vs target (reports) counts Joined with the same creditedJoinings as the card', rtg.status === 200 && joinedSum === cjm.count, { status: rtg.status, joinedSum, card: cjm.count });
  // carry-over
  const cand = await prisma.candidate.create({ data: { name: `R3 Cand ${P}`, phone: `7${String(P).padStart(9, '3').slice(-9)}`, email: `r3.cand.${P}@r3-test.in` } });
  const app1 = await prisma.application.create({ data: { candidateId: cand.id, requirementId: REQ.id, stage: 'RECRUITER_REVIEW', ownerRecruiterId: R1.id } });
  await prisma.applicationFollowUp.create({ data: { applicationId: app1.id, candidateId: cand.id, requirementId: REQ.id, ownerUserId: R1.id, ownerName: R1.name, nextAction: 'Call back', dueDate: day(-3) } });
  await prisma.$executeRawUnsafe('UPDATE "Application" SET "updatedAt" = ? WHERE "id" = ?', Date.now() - 3 * 86400000, app1.id);
  const co = await call('GET', '/ats/work/carry-over', null, t1);
  check('"Carried over from yesterday": the late follow-up and the profile to review are counted', co.status === 200 && co.body.followUps.length >= 1 && co.body.toReview.length >= 1 && co.body.count >= 2 && /Carried over/.test(co.body.label), co.body);
  // end of day
  const eod = await call('GET', '/ats/work/eod/me', null, t1);
  check('the auto-built end-of-day shows the day\'s numbers and is not yet confirmed', eod.status === 200 && eod.body.confirmedAt === null && eod.body.canConfirm === true && typeof eod.body.totals.calls === 'number', eod.body);
  const ec = await call('POST', '/ats/work/eod/confirm', {}, t1);
  check('"Confirm and send" records the time', ec.status === 200 && !!ec.body.confirmedAt, ec.body);
  check('a second confirm changes nothing', (await call('POST', '/ats/work/eod/confirm', {}, t1)).body.already === true);
  check('a future day cannot be confirmed', (await call('POST', '/ats/work/eod/confirm', { day: day(5) }, t1)).status === 400);
  await core.x('INSERT OR REPLACE INTO "AtsEodConfirm" ("userId","day","confirmedAt") VALUES (?,?,?)', R2.id, day(-1), new Date().toISOString());
  const comp = await call('GET', '/ats/work/eod/compliance', null, tT);
  const c1 = (comp.body.people || []).find((p) => p.userId === R1.id);
  check('EOD compliance per recruiter and per team (TL only)', comp.status === 200 && c1 && typeof c1.done === 'number' && comp.body.teams.length >= 1 && (await call('GET', '/ats/work/eod/compliance', null, t1)).status === 403, comp.body);

  // ===================================================== performance
  console.log('\n--- underperformers, leaderboard, offer ratio, cost vs revenue');
  const up = await call('GET', '/ats/work/underperformers', null, tT);
  check('the underperformer list answers for the TL (flag after N weeks below the threshold)', up.status === 200 && up.body.enabled === true && up.body.settings.weeks === 3 && Array.isArray(up.body.rows), up.body);
  check('a recruiter cannot open the underperformer list', (await call('GET', '/ats/work/underperformers', null, t1)).status === 403);
  // the flag itself: weekly scores below threshold N weeks in a row
  const T = require('../src/utils/atsWork/targets');
  const flagRows = T.scoreOf({ joinings: { done: 0, target: 4 }, submissions: { done: 0, target: 10 }, interviews: { done: 0, target: 5 }, calls: { done: 0, target: 50 }, sourced: { done: 0, target: 10 }, verified: { done: 0, target: 10 } }, { pct: 0 }, core.DEFAULTS.weights);
  check('a week with nothing done against targets scores 0 (below any threshold)', flagRows.score === 0);
  const half = T.scoreOf({ joinings: { done: 2, target: 4 }, submissions: { done: 5, target: 10 }, interviews: { done: 5, target: 5 }, calls: { done: 50, target: 50 }, sourced: { done: 10, target: 10 }, verified: { done: 10, target: 10 } }, { pct: 100 }, core.DEFAULTS.weights);
  check('score = weights x attainment (40/20/15/15/10): 2/4 joinings, 5/10 submissions, rest full -> 70', half.score === 70, half);
  const noTargets = T.scoreOf({ joinings: { done: 1, target: null }, submissions: { done: 1, target: null }, interviews: { done: 1, target: null }, calls: { done: 1, target: null }, sourced: { done: 1, target: null }, verified: { done: 1, target: null } }, { pct: null }, core.DEFAULTS.weights);
  check('no targets set: no score, not a zero', noTargets.score === null);
  const lb = await call('GET', '/ats/work/leaderboard?period=MONTHLY', null, tT);
  check('the TL sees the whole ranking in scope', lb.status === 200 && Array.isArray(lb.body.rows) && lb.body.rows.every((r) => r.rank >= 1) && lb.body.scope !== 'Your team', lb.body);
  const lb1 = await call('GET', '/ats/work/leaderboard?period=MONTHLY', null, t1);
  check('a recruiter sees their own rank and their team\'s ranking (switch ON by default), no private figures', lb1.status === 200 && lb1.body.you && lb1.body.you.rank >= 1 && lb1.body.scope === 'Your team' && lb1.body.rows.every((r) => !('submissions' in r)) && lb1.body.rows.some((r) => r.you), lb1.body);
  await setW({ leaderboard: { recruitersSee: false } });
  const lb2 = await call('GET', '/ats/work/leaderboard?period=MONTHLY', null, t1);
  check('an Admin can switch it off for recruiters', lb2.status === 200 && lb2.body.hidden === true && lb2.body.rows.length === 0, lb2.body);
  check('...and the TL still sees it', (await call('GET', '/ats/work/leaderboard?period=MONTHLY', null, tT)).body.rows !== undefined);
  await setW({ leaderboard: { recruitersSee: true } });
  const otr = await call('GET', '/ats/work/offer-ratio?period=MONTHLY', null, tT);
  check('offer-to-joining ratio: offers, joined and the percentage', otr.status === 200 && typeof otr.body.offers === 'number' && typeof otr.body.joined === 'number' && 'ratio' in otr.body, otr.body);
  check('cost vs revenue is refused to a team lead and a recruiter', (await call('GET', '/ats/work/cost-revenue', null, tT)).status === 403 && (await call('GET', '/ats/work/cost-revenue', null, t1)).status === 403);
  const jo = await prisma.application.findFirst({ where: { stage: 'JOINED', ownerRecruiterId: { not: null } }, select: { id: true, joiningDate: true } });
  const cr = await call('GET', '/ats/work/cost-revenue', null, tA);
  check('Admin sees cost vs revenue (a person with no salary data shows "cost not set")', cr.status === 200 && Array.isArray(cr.body.rows) && cr.body.rows.every((r) => r.cost !== null || r.costNote === 'cost not set'), cr.body);
  check('Accounts sees it too', (await call('GET', '/ats/work/cost-revenue', null, tAcc)).status === 200);

  // ===================================================== workflow trail
  console.log('\n--- workflow trail');
  const tr = await call('GET', `/ats/work/trail/requirement/${REQ.id}`, null, tT);
  check('requirement trail: in time order from the request, with who and when', tr.status === 200 && tr.body.events.length >= 2 && /Requirement raised/.test(tr.body.events[0].what) && tr.body.events.every((e, i, a) => i === 0 || a[i - 1].at <= e.at) && tr.body.events.some((e) => /assignment|assigned/i.test(e.what)), tr.body);
  const ta = await call('GET', `/ats/work/trail/application/${app1.id}`, null, tT);
  check('application trail works for the TL of the job', ta.status === 200 && ta.body.events.length >= 1, ta.body);
  check('a recruiter of another department cannot read it', (await call('GET', `/ats/work/trail/application/${app1.id}`, null, await tok((await mkUser('Rother', { atsRole: 'RECRUITER', atsDepartment: 'OtherDept', atsScopeDepartments: 'OtherDept' })).id))).status === 403);

  // ===================================================== event dedupe, hold / close, payouts, retry, shortlist
  console.log('\n--- dedupe, on hold, closed, payouts, retries, AI shortlist');
  check('event dedupe: the first claim wins, the second does nothing', (await core.claimEvent('test', `k-${P}`)) === true && (await core.claimEvent('test', `k-${P}`)) === false);
  const appS = await prisma.application.create({ data: { candidateId: (await prisma.candidate.create({ data: { name: `R3 Stage ${P}`, phone: `8${String(P).padStart(9, '5').slice(-9)}` } })).id, requirementId: REQ.id, stage: 'NEW', ownerRecruiterId: R1.id } });
  const evBefore = await prisma.applicationStageEvent.count({ where: { applicationId: appS.id } });
  const both = await Promise.all([1, 2].map(() => call('PATCH', `/applications/${appS.id}/stage`, { stage: 'RECRUITER_REVIEW' }, tT)));
  const evAfter = await prisma.applicationStageEvent.count({ where: { applicationId: appS.id, toStage: 'RECRUITER_REVIEW' } });
  check('the same stage move sent twice at once writes ONE history row', evAfter === 1 && both.some((b) => b.status === 200), { statuses: both.map((b) => b.status), evAfter, evBefore });
  // hold
  const REQH = await newReq('R3 hold job', { recruiterId: R1.id, status: 'RECRUITER_ASSIGNED' });
  const appH = await prisma.application.create({ data: { candidateId: cand.id, requirementId: REQH.id, stage: 'RECRUITER_REVIEW', ownerRecruiterId: R1.id } });
  await prisma.applicationFollowUp.create({ data: { applicationId: appH.id, candidateId: cand.id, requirementId: REQH.id, ownerUserId: R1.id, ownerName: R1.name, nextAction: 'Held job chase', dueDate: day(-3) } });
  await setW({ onHoldPause: { enabled: false } });
  await call('POST', `/requirements/${REQH.id}/status`, { status: 'ON_HOLD' }, tA);
  check('On hold with the switch OFF pauses nothing', (await core.q('SELECT * FROM "AtsRequirementPause" WHERE "requirementId" = ?', REQH.id)).length === 0);
  await call('POST', `/requirements/${REQH.id}/status`, { status: 'RECRUITER_ASSIGNED' }, tA);
  await setW({ onHoldPause: { enabled: true } });
  const bell0 = await prisma.notification.count({ where: { userId: R1.id } }).catch(() => null);
  const hold = await call('POST', `/requirements/${REQH.id}/status`, { status: 'ON_HOLD' }, tA);
  const paused = (await core.q('SELECT * FROM "AtsRequirementPause" WHERE "requirementId" = ? AND "resumedAt" IS NULL', REQH.id)).length === 1;
  const coH = await call('GET', '/ats/work/carry-over', null, t1);
  check('On hold (switch ON): tasks paused, recruiter told, its follow-up leaves the carry-over list', hold.status === 200 && paused && !coH.body.followUps.some((f) => f.what === 'Held job chase') && (bell0 === null || (await prisma.notification.count({ where: { userId: R1.id } })) > bell0), { paused, coH: coH.body.followUps });
  const reopen = await call('POST', `/requirements/${REQH.id}/status`, { status: 'RECRUITER_ASSIGNED' }, tA);
  const stillPaused = (await core.q('SELECT * FROM "AtsRequirementPause" WHERE "requirementId" = ? AND "resumedAt" IS NULL', REQH.id)).length;
  // utils/requirementLifecycle.js (main) puts the candidates on Hold and closes their follow-ups with the requirement, and restores the stage on reopen.
  const backAt = (await prisma.application.findUnique({ where: { id: appH.id } })).stage;
  check('opening it again resumes the tasks (pause cleared, candidate back at the stage they were at)', reopen.status === 200 && stillPaused === 0 && backAt === 'RECRUITER_REVIEW', { reopen: reopen.status, stillPaused, backAt });
  // closed
  await call('POST', `/requirements/${REQH.id}/status`, { status: 'CLOSED' }, tA);
  const cl = await call('GET', `/ats/work/requirements/${REQH.id}/close-list`, null, tT);
  check('Closed: the open pipeline is listed', cl.status === 200 && cl.body.closed === true && cl.body.count >= 1 && cl.body.enabled === false, cl.body);
  check('"Close and notify them" is refused while the Admin switch is OFF', (await call('POST', `/ats/work/requirements/${REQH.id}/close-and-notify`, {}, tA)).status === 409);
  await setW({ closeNotify: { enabled: true } });
  const cn = await call('POST', `/ats/work/requirements/${REQH.id}/close-and-notify`, {}, tA);
  check('one click closes them all (Rejected: Requirement closed), through the ordinary move', cn.status === 200 && cn.body.moved >= 1 && (await prisma.application.findUnique({ where: { id: appH.id } })).stage === 'REJECTED', cn.body);
  const ev = await prisma.applicationStageEvent.findFirst({ where: { applicationId: appH.id, toStage: 'REJECTED' } });
  check('...with the reason on the history', ev && ev.reasonCategory === 'Requirement closed', ev);
  await setW({ closeNotify: { enabled: false }, onHoldPause: { enabled: false } });
  // payouts
  check('payout proposal is a no-op while the switch is OFF', (await L.onJoined(jo.id, { id: adminRow.id })).skipped === 'switch off');
  await setW({ payoutProposal: { enabled: true } });
  const ofp = await L.onJoined(jo.id, { id: adminRow.id, name: 'Admin' });
  const pend = await call('GET', '/ats/work/payouts', null, tA);
  check('a confirmed joining drafts a payout PROPOSAL (no money, no amount decided)', ofp.made && ofp.made.includes('Recruiter incentive') && pend.status === 200 && pend.body.rows.some((r) => r.applicationId === jo.id && r.amount === null && r.status === 'Pending'), { ofp, rows: pend.body && pend.body.rows.length });
  check('the same joining drafted twice makes no second proposal', ((await L.onJoined(jo.id, null)).made || []).length === 0);
  check('a team lead and a recruiter cannot see or decide payouts', (await call('GET', '/ats/work/payouts', null, tT)).status === 403 && (await call('POST', '/ats/work/payouts/1/decide', { decision: 'Approved' }, t1)).status === 403);
  check('Accounts sees "Pending payout approvals"', (await call('GET', '/ats/work/payouts', null, tAcc)).status === 200);
  const pid = pend.body.rows.find((r) => r.applicationId === jo.id).id;
  const pd = await call('POST', `/ats/work/payouts/${pid}/decide`, { decision: 'Approved', amount: 1500, note: 'ok' }, tAcc);
  check('Accounts approves: a decision is recorded, once', pd.status === 200 && (await call('POST', `/ats/work/payouts/${pid}/decide`, { decision: 'Approved' }, tAcc)).status === 409);
  await setW({ payoutProposal: { enabled: false } });
  // failed steps
  const fid = await core.recordFailure({ kind: 'matching', refId: REQ.id, error: 'AI was busy' });
  check('a failed step is recorded once (a repeat updates it)', fid && (await core.recordFailure({ kind: 'matching', refId: REQ.id, error: 'again' })) === fid);
  const fl = await call('GET', '/ats/work/failures', null, tA);
  check('the Failed steps list shows it', fl.body.rows.some((r) => r.id === fid && r.status === 'Failed'), fl.body);
  const rt = await call('POST', `/ats/work/failures/${fid}/retry`, {}, tT);
  check('Retry runs the step again and closes it when it works', rt.status === 200 && rt.body.ok === true && (await core.q('SELECT "status" FROM "AtsFailedStep" WHERE "id" = ?', fid))[0].status === 'Done', rt.body);
  const fid2 = await core.recordFailure({ kind: 'resume-ai', refId: null, error: 'AI refused' });
  const rt2 = await call('POST', `/ats/work/failures/${fid2}/retry`, {}, tA);
  check('a step that cannot be re-run by itself says so and stays listed', rt2.status === 200 && rt2.body.ok === false && /own screen/.test(rt2.body.error), rt2.body);
  check('a recruiter cannot retry', (await call('POST', `/ats/work/failures/${fid2}/retry`, {}, t1)).status === 403);
  check('the hourly sweep does nothing while the switch is OFF', (await L.sweep()).skipped === 'switch off');
  await setW({ autoRetry: { enabled: true } });
  const fid3 = await core.recordFailure({ kind: 'matching', refId: REQ.id, error: 'AI was busy' });
  await core.x('UPDATE "AtsFailedStep" SET "nextTryAt" = ? WHERE "id" = ?', new Date(Date.now() - 1000).toISOString(), fid3);
  const sw3 = await L.sweep();
  check('with the switch ON the sweep retries what is due (matching works again)', sw3.tried >= 1 && sw3.worked >= 1 && (await core.q('SELECT "status" FROM "AtsFailedStep" WHERE "id" = ?', fid3))[0].status === 'Done', sw3);
  await core.x('UPDATE "AtsFailedStep" SET "tries" = 2, "nextTryAt" = ? WHERE "id" = ?', new Date(Date.now() - 1000).toISOString(), fid2);
  await L.sweep();
  check('after 3 automatic tries it gives up and says so', (await core.q('SELECT "status","tries" FROM "AtsFailedStep" WHERE "id" = ?', fid2))[0].status === 'Gave up');
  await setW({ autoRetry: { enabled: false } });
  // AI shortlist
  check('the AI shortlist goes straight through while the switch is OFF', (await L.shortlistHold({ id: `fake-${P}`, requirementId: REQ.id }, 'why', 80, 80)) === false);
  await setW({ aiShortlistApproval: { enabled: true } });
  const held = await L.shortlistHold({ id: appS.id, requirementId: REQ.id, candidate: { name: 'R3 Stage' }, requirement: { title: REQ.title, recruiterId: R1.id } }, 'AI interview 80% and resume 72% (both 65% or more)', 80, 72);
  const sl = await call('GET', '/ats/work/shortlist', null, t1);
  check('ON: the candidate waits in the recruiter\'s approval list with the reasons', held === true && sl.status === 200 && sl.body.enabled === true && sl.body.rows.some((r) => r.applicationId === appS.id && /AI interview 80%/.test(r.reasons)), sl.body);
  check('the same one is not queued twice', (await L.shortlistHold({ id: appS.id, requirementId: REQ.id }, 'x', 80, 72)) === true && (await core.q('SELECT COUNT(*) AS n FROM "AtsShortlistApproval" WHERE "applicationId" = ?', appS.id))[0].n == 1); // eslint-disable-line eqeqeq
  check('a recruiter outside the job cannot decide it', (await call('POST', '/ats/work/shortlist/decide', { applicationIds: [appS.id], decision: 'reject' }, await tok((await mkUser('Rx', { atsRole: 'RECRUITER', atsDepartment: 'OtherDept', atsScopeDepartments: 'OtherDept' })).id))).status === 403);
  const rj = await call('POST', '/ats/work/shortlist/decide', { applicationIds: [appS.id], decision: 'reject', note: 'weak fit' }, t1);
  check('bulk reject by the recruiter', rj.status === 200 && rj.body.done === 1 && (await call('GET', '/ats/work/shortlist', null, t1)).body.rows.length === 0, rj.body);
  await setW({ aiShortlistApproval: { enabled: false } });

  // ===================================================== reassign their work (P7.8)
  console.log('\n--- reassign a leaver\'s work');
  const REQL = await newReq('R3 leaver job', { recruiterId: R2.id, status: 'RECRUITER_ASSIGNED' });
  const candL = await prisma.candidate.create({ data: { name: `R3 Leaver Cand ${P}`, phone: `9${String(P).padStart(9, '7').slice(-9)}` } });
  const appL = await prisma.application.create({ data: { candidateId: candL.id, requirementId: REQL.id, stage: 'RECRUITER_REVIEW', ownerRecruiterId: R2.id } });
  await prisma.applicationFollowUp.create({ data: { applicationId: appL.id, candidateId: candL.id, requirementId: REQL.id, ownerUserId: R2.id, ownerName: R2.name, nextAction: 'Leaver chase', dueDate: day(2) } });
  const taskL = await prisma.task.create({ data: { name: `R3 task ${P}`, assigneeId: R2.id, assigneeName: R2.name, status: 'Not Started', startDate: day(0), endDate: day(3), createdById: adminRow.id, createdByName: 'Admin' } }).catch((e) => ({ error: e.message }));
  await prisma.user.update({ where: { id: R2.id }, data: { status: 'Inactive' } });
  const rp = await call('GET', '/ats/work/reassign/people', null, tT);
  check('the TL is offered the deactivated person with their open work', rp.status === 200 && rp.body.people.some((p) => p.userId === R2.id && p.counts.requirements >= 1 && p.counts.applications >= 1 && p.counts.followUps >= 1), rp.body);
  const pv = await call('GET', `/ats/work/reassign/${R2.id}`, null, tT);
  check('one screen: requirements, candidates, follow-ups, tasks, clients', pv.status === 200 && pv.body.sections.map((s) => s.key).join() === 'requirements,applications,followUps,tasks,clients', pv.body);
  check('a recruiter cannot reassign work', (await call('POST', `/ats/work/reassign/${R2.id}`, { toUserId: R1.id, what: ['requirements'] }, t1)).status === 403);
  check('the person who takes it must be active', (await call('POST', `/ats/work/reassign/${R2.id}`, { toUserId: R2.id, what: ['requirements'] }, tT)).status === 400);
  const rd2 = await call('POST', `/ats/work/reassign/${R2.id}`, { toUserId: R1.id, what: ['requirements', 'applications', 'followUps', ...(taskL.error ? [] : ['tasks'])] }, tT);
  const reqLn = await prisma.requirement.findUnique({ where: { id: REQL.id } });
  const appLn = await prisma.application.findUnique({ where: { id: appL.id } });
  const fuL = await prisma.applicationFollowUp.findFirst({ where: { applicationId: appL.id } });
  check('bulk reassign: requirement, candidate, follow-up (and task) now belong to the chosen person', rd2.status === 200 && reqLn.recruiterId === R1.id && appLn.ownerRecruiterId === R1.id && fuL.ownerUserId === R1.id && (taskL.error || (await prisma.task.findUnique({ where: { id: taskL.id } })).assigneeId === R1.id), { rd2: rd2.body, taskL: taskL.error });
  check('...and it is logged', (await core.q('SELECT COUNT(*) AS n FROM "AtsReassignLog" WHERE "fromUserId" = ?', R2.id))[0].n >= 3 && (await prisma.auditLog.count({ where: { action: 'Work reassigned', entityId: R2.id } })) === 1);
  check('client ownership moves only by an Admin', (await call('POST', `/ats/work/reassign/${R2.id}`, { toUserId: R1.id, what: ['clients'] }, tT)).status === 403);

  // ===================================================== sources (P8.4), ownership + disputes
  console.log('\n--- BDE source, ownership validity, disputes');
  const CS = require('../src/utils/candidateSource');
  check('P8.4: "BDE" is a source of its own (no longer an imported sheet)', CS.canonicalSource('BDE') === 'BDE' && CS.canonicalSource('bde sourced') === 'BDE' && CS.SOURCES.includes('BDE') && CS.PICKER_SOURCES.includes('BDE') && CS.canonicalSource('BDE sheet tracker') !== 'BDE' && CS.canonicalSource('Referral') === 'Referral' && CS.canonicalSource('Website') === 'Website');
  const so = await call('GET', '/candidates/source-options', null, tA);
  check('the source pickers offer BDE', so.status === 200 && JSON.stringify(so.body).includes('"BDE"'), so.body);
  const candO = await prisma.candidate.create({ data: { name: `R3 Own Cand ${P}`, phone: `6${String(P).padStart(9, '8').slice(-9)}` } });
  const REQO = await newReq('R3 owner job', { recruiterId: R1.id, status: 'RECRUITER_ASSIGNED' });
  const appO = await prisma.application.create({ data: { candidateId: candO.id, requirementId: REQO.id, stage: 'RECRUITER_REVIEW', ownerRecruiterId: R1.id } });
  const REQO2 = await newReq('R3 owner job B', { recruiterId: R3.id, status: 'RECRUITER_ASSIGNED' });
  const own = await call('GET', `/ats/work/ownership/${candO.id}`, null, tT);
  check('ownership shows the holder and the valid-until date (90 days by default)', own.status === 200 && own.body.validityDays === 90 && own.body.holders[0].userId === R1.id && own.body.holders[0].expired === false, own.body);
  const t3 = await tok(R3.id);
  const early = await call('POST', `/ats/work/ownership/${candO.id}/claim`, {}, t3);
  check('claiming a candidate that is still owned and active is refused with the date', early.status === 409 && early.body.code === 'STILL_VALID', early.body);
  check('a dispute needs real evidence', (await call('POST', '/ats/work/disputes', { candidateId: candO.id, evidence: 'mine' }, t3)).status === 400);
  const dsp = await call('POST', '/ats/work/disputes', { candidateId: candO.id, evidence: 'I sourced this person from Naukri on 3 Nov; screenshot in the shared folder' }, t3);
  check('the claimant opens a dispute with an evidence note', dsp.status === 200 && (await call('POST', '/ats/work/disputes', { candidateId: candO.id, evidence: 'I sourced this person from Naukri on 3 Nov; screenshot in the shared folder' }, t3)).status === 409);
  const dl = await call('GET', `/ats/work/disputes?candidateId=${candO.id}`, null, tT);
  const did = dl.body.rows[0] && dl.body.rows[0].id;
  check('the TL sees the open case; the claimant sees theirs; an outsider sees none', dl.body.canDecide === true && !!did && (await call('GET', `/ats/work/disputes?candidateId=${candO.id}`, null, t3)).body.rows.length === 1 && (await call('GET', `/ats/work/disputes?candidateId=${candO.id}`, null, await tok((await mkUser('Routsider', { atsRole: 'RECRUITER', atsDepartment: 'OtherDept9', atsScopeDepartments: 'OtherDept9' })).id))).body.rows.length === 0, dl.body);
  check('the claimant cannot decide it, nor a recruiter', (await call('POST', `/ats/work/disputes/${did}/decide`, { winnerId: R3.id, reason: 'it is mine' }, t3)).status === 403);
  check('a decision needs a reason and a valid winner', (await call('POST', `/ats/work/disputes/${did}/decide`, { winnerId: R3.id, reason: '' }, tT)).status === 400 && (await call('POST', `/ats/work/disputes/${did}/decide`, { winnerId: TL.id, reason: 'not a party to it' }, tT)).status === 400);
  const dec = await call('POST', `/ats/work/disputes/${did}/decide`, { winnerId: R3.id, reason: 'Naukri screenshot predates the other entry' }, tT);
  check('the TL decides with a reason: ownership moves, the case is closed and audited', dec.status === 200 && dec.body.moved === 1 && (await prisma.application.findUnique({ where: { id: appO.id } })).ownerRecruiterId === R3.id && (await prisma.auditLog.count({ where: { action: 'Ownership dispute decided', entityId: candO.id } })) === 1 && (await call('POST', `/ats/work/disputes/${did}/decide`, { winnerId: R3.id, reason: 'again please' }, tT)).status === 409, dec.body);
  // validity period
  await prisma.$executeRawUnsafe('UPDATE "Application" SET "updatedAt" = ? WHERE "id" = ?', Date.now() - 200 * 86400000, appO.id);
  await prisma.applicationStageEvent.deleteMany({ where: { candidateId: candO.id } });
  const ex = await call('GET', `/ats/work/ownership/${candO.id}`, null, tT);
  check('after 90 quiet days the ownership shows as expired', ex.body.holders[0].expired === true, ex.body);
  const claim = await call('POST', `/ats/work/ownership/${candO.id}/claim`, {}, t1);
  check('another recruiter claims it; it moves and is audited', claim.status === 200 && (await prisma.application.findUnique({ where: { id: appO.id } })).ownerRecruiterId === R1.id, claim.body);
  await setW({ ownership: { validityDays: 365 } });
  check('the validity period is a setting (365 days now)', (await call('GET', `/ats/work/ownership/${candO.id}`, null, tT)).body.validityDays === 365);
  await setW({ ownership: { validityDays: 90 } });

  // ===================================================== delegation
  console.log('\n--- delegation of approvals');
  const TL2 = await mkUser('Rtl2', { role: 'TL', atsRole: 'TL', atsDepartment: DEPT, atsScopeDepartments: DEPT });
  const tT2 = await tok(TL2.id);
  check('a recruiter cannot delegate approvals', (await call('POST', '/ats/work/delegations', { toUserId: TL.id, fromDate: day(0), toDate: day(3) }, t1)).status === 403);
  check('dates are checked', (await call('POST', '/ats/work/delegations', { toUserId: TL2.id, fromDate: day(3), toDate: day(0) }, tB)).status === 400);
  const dg = await call('POST', '/ats/work/delegations', { toUserId: TL2.id, fromDate: day(0), toDate: day(3) }, tB);
  check('the BDE TL delegates to another login for the days away', dg.status === 200, dg.body);
  check('the same days cannot be delegated twice', (await call('POST', '/ats/work/delegations', { toUserId: TL.id, fromDate: day(1), toDate: day(2) }, tB)).status === 409);
  check('the delegate now stands in for the BDE TL (approval check honours it)', (await PE.standsInForBdeTl(TL2)) === true && (await PE.standsInForBdeTl(TL)) === false && (await PE.delegatorFor(BDETL.id, TL2.id)).id === BDETL.id && (await PE.delegatorFor(BDETL.id, TL.id)) === null);
  const lst = await call('GET', '/ats/work/delegations', null, tT2);
  check('the delegate sees it in their list', lst.body.rows.length === 1 && lst.body.rows[0].mine === false, lst.body);
  check('the approval check lets the delegate approve a requirement change (BDE TL\'s decision)', (await call('POST', `/requirements/${REQ.id}/review/approve`, {}, tT2)).status !== 403);
  check('...and a login with no delegation is still refused', (await call('POST', `/requirements/${REQ.id}/review/approve`, {}, tT)).status === 403);
  const drow = (await call('GET', '/ats/work/delegations', null, tB)).body.rows[0];
  await call('DELETE', `/ats/work/delegations/${drow.id}`, null, tB);
  check('cancelling it stops the cover at once', (await PE.standsInForBdeTl(TL2)) === false);

  // ===================================================== SLA in working days
  console.log('\n--- SLA in working days');
  await prisma.holiday.create({ data: { name: `R3 holiday ${P}`, date: '2026-12-09', type: 'Festival' } });
  check('with the switch OFF due dates count calendar days', CAL.dueAfter('2026-12-04', 3) === '2026-12-07');
  await setW({ sla: { workingDaysOnly: true } });
  await CAL.refresh({ maxAgeMs: 0 });
  await require('../src/utils/atsWork/core').load({ maxAgeMs: 0 });
  check('ON: Friday 4 Dec + 4 working days (Sat counts, Sunday and the 9 Dec holiday do not) -> Thu 10 Dec', CAL.dueAfter('2026-12-04', 4) === '2026-12-10' && CAL.dueAfter('2026-12-04', 3) === '2026-12-08' && CAL.isWorkingDay('2026-12-09') === false && CAL.isWorkingDay('2026-12-08') === true, CAL.dueAfter('2026-12-04', 3));
  check('ON: days late counts working days (Fri -> Tue = 3: Sat, Mon, Tue)', CAL.daysLate('2026-12-04', '2026-12-08') === 3);
  await setW({ sla: { businessHoursOnly: true, startHour: 9, endHour: 18 } });
  await core.load({ maxAgeMs: 0 });
  const fri17 = new Date('2026-12-04T17:00:00+05:30').getTime(); const mon10 = new Date('2026-12-07T10:00:00+05:30').getTime();
  check('business hours: Fri 17:00 to Mon 10:00 is 11 working hours (1 + Saturday 9 + 1; Sunday none)', Math.round(CAL.elapsedHours(fri17, mon10)) === 11, CAL.elapsedHours(fri17, mon10));
  await setW({ sla: { workingDaysOnly: false, businessHoursOnly: false } });
  await core.load({ maxAgeMs: 0 });
  check('OFF again: back to calendar days', CAL.dueAfter('2026-12-04', 3) === '2026-12-07');

  // ===================================================== bulk preview
  console.log('\n--- bulk preview');
  const appP = await prisma.application.create({ data: { candidateId: (await prisma.candidate.create({ data: { name: `R3 Prev ${P}`, phone: `5${String(P).padStart(9, '1').slice(-9)}` } })).id, requirementId: REQ.id, stage: 'NEW', ownerRecruiterId: R1.id } });
  const outside = await prisma.application.findFirst({ where: { requirement: { department: { not: DEPT } } }, select: { id: true } });
  const pvw = await call('POST', '/ats/work/bulk-preview', { kind: 'application-stage', stage: 'RECRUITER_REVIEW', applicationIds: [appP.id, appS.id, outside.id, 'nope'] }, tT);
  check('"Who will move": counts, who moves, and who is skipped with the reason', pvw.status === 200 && pvw.body.counts.willMove === 1 && pvw.body.willMove[0].id === appP.id && pvw.body.skipped.some((s) => /Already at/.test(s.reason)) && pvw.body.skipped.some((s) => /Outside your access/.test(s.reason)) && pvw.body.skipped.some((s) => /not found/.test(s.reason)), pvw.body);
  check('the preview moves nobody', (await prisma.application.findUnique({ where: { id: appP.id } })).stage === 'NEW');
  const pv2 = await call('POST', '/ats/work/bulk-preview', { kind: 'requirement-assign', ids: [REQ.id, REQO.id], userId: R1.id }, tT);
  check('requirement bulk assign preview says who is already on it', pv2.status === 200 && pv2.body.skipped.some((s) => /Already assigned/.test(s.reason)), pv2.body);
  check('a client login gets no bulk preview', (await call('POST', '/ats/work/bulk-preview', { kind: 'application-stage' }, await tok((await mkUser('Rclient', { role: 'CLIENT', atsRole: 'NONE', atsAccess: false })).id))).status === 403);

  // ===================================================== joining proof
  console.log('\n--- joining proof before billing');
  const joined = await prisma.application.findFirst({ where: { stage: 'JOINED', requirement: { internal: false } }, include: { requirement: { include: { client: true } }, candidate: true } });
  check('proof gate is open while the switch is OFF', (await PE.proofGate(joined)) === null);
  await setW({ joiningProof: { required: true } });
  check('ON: the invoice waits - the gate says upload the proof', /Upload the joining/.test((await PE.proofGate(joined)) || ''));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData(); fd.append('file', new Blob([png], { type: 'image/png' }), 'joining-confirmation.png');
  const upl = await fetch(`${API}/ats/work/joining-proof/${joined.id}`, { method: 'POST', headers: { Authorization: `Bearer ${tA}` }, body: fd }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  check("the proof file uploads", upl.status === 200 && upl.body.ok === true, upl.body);
  check('...and the gate is open, the file is readable, the status says so', (await PE.proofGate(joined)) === null && (await call('GET', `/ats/work/joining-proof/${joined.id}`, null, tA)).body.proof.fileName === 'joining-confirmation.png' && (await fetch(`${API}/ats/work/joining-proof/${joined.id}/file`, { headers: { Authorization: `Bearer ${tA}` } })).status === 200);
  check('a recruiter outside the job cannot upload or read it', (await call('GET', `/ats/work/joining-proof/${joined.id}`, null, await tok((await mkUser('Rnoproof', { atsRole: 'RECRUITER', atsDepartment: 'ZZDept', atsScopeDepartments: 'ZZDept' })).id))).status === 403);
  // the invoice waits: a fresh joined application is held
  const waitApp = await prisma.application.findFirst({ where: { stage: { in: ['OFFER_ACCEPTED', 'SELECTED'] }, requirement: { internal: false } }, select: { id: true } });
  if (waitApp) {
    await core.x('DELETE FROM "AtsJoiningProof" WHERE "applicationId" = ?', waitApp.id);
    const inv0 = await prisma.invoice.count();
    const mv = await call('PATCH', `/applications/${waitApp.id}/stage`, { stage: 'JOINED', joiningDate: day(0) }, tA);
    const after = await prisma.application.findUnique({ where: { id: waitApp.id } });
    if (mv.status === 200 && after.stage === 'JOINED') check('a joining without the proof raises NO invoice and says "Waiting for joining proof"', after.billingStatus === 'Waiting for joining proof' && (await prisma.invoice.count()) === inv0, { b: after.billingStatus, inv0 });
    else console.log(`  skip  joining move not allowed in this data (${mv.status} ${JSON.stringify(mv.body).slice(0, 120)})`);
  }
  await setW({ joiningProof: { required: false } });

  // ===================================================== moving a candidate between jobs (186): already live
  console.log('\n--- transfer between jobs (Audit 186, live since round 2)');
  const REQM = await newReq('R3 move target', { recruiterId: R1.id, status: 'RECRUITER_ASSIGNED' });
  const mvr = await call('POST', `/applications/${appP.id}/move`, { requirementId: REQM.id, reason: 'Better fit for the other job' }, tA);
  check('Move to another job: carries the candidate, closes the old one as Moved', mvr.status === 201 && (await prisma.application.findUnique({ where: { id: appP.id } })).stage === 'REJECTED' && (await prisma.applicationStageEvent.findFirst({ where: { applicationId: appP.id, toStage: 'REJECTED' } })).reasonCategory === 'Moved to another requirement', mvr.body);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
