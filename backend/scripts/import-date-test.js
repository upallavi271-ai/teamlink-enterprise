#!/usr/bin/env node
/**
 * THE DATE A PERSON REALLY CAME (founder 2026-11-20: "when I import back-dated candidates, today's date comes. Fix that."):
 *   - the candidate import reads a date column (every format), sets Candidate.createdAt + the came-on date ("From the sheet"), and for a person put on a
 *     requirement the first application's createdAt and the first stage events; unreadable / future / pre-2000 dates are refused with the reason
 *   - one date for every row, or today (marked "original date not known")
 *   - the repair tool ("Fix came-on dates from a sheet"): preview numbers, a system-recorded date is kept without Overwrite, undo of a batch, wrong roles refused
 *   - lists / the Sources tab show the real months
 * SANDBOX ONLY: a private server on a COPY of the sandbox database.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> TEST_PORT=4211 node scripts/import-date-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-import-date-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4211);
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'import-date-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const { istDay } = require('../src/utils/nextAction');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 700)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
const upload = async (url, rows, fields, token, header) => {
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows], { cellDates: true });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: true });
  const fd = new FormData();
  Object.entries(fields || {}).forEach(([k, v]) => fd.append(k, typeof v === 'string' ? v : JSON.stringify(v)));
  fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'sheet.xlsx');
  const r = await fetch(API + url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const P = process.pid;
const serial = (y, m, d) => Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
const day = (d) => istDay(d);
const today = istDay(Date.now());

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const mkUser = (tag, atsRole, dept) => prisma.user.create({ data: { name: `Dt ${tag} ${P}`, email: `dt.${tag}.${P}@dt-test.in`, passwordHash: 'x', status: 'Active', role: atsRole === 'TL' ? 'TL' : 'EMPLOYEE', atsRole, atsDepartment: dept, atsScopeDepartments: dept, atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3) } });
  const REC = await mkUser('rec', 'RECRUITER', 'Medical');
  const TLU = await mkUser('tl', 'TL', 'Medical');
  const BDE = await mkUser('bde', 'BDE', 'BDE');
  const req = await prisma.requirement.findFirst({ where: { status: { in: ['OPEN', 'RECRUITER_ASSIGNED'] }, internal: false, reqCode: { not: null } }, select: { id: true, reqCode: true } });
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  if (!(await fetch(`${API}/health`).then((r) => r.ok).catch(() => false))) { console.log('FAIL  the server did not answer /api/health (a leftover process may hold the port: pick another TEST_PORT)'); return stop(2); }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const tA = await tok(adminRow.id); const tR = await tok(REC.id); const tT = await tok(TLU.id); const tB = await tok(BDE.id);

  // ===== 1. the sheet: every date format, a future date, a bad date, a missing date =====
  const header = ['Full Name', 'Email', 'Phone', 'Current Salary', 'Expected Salary', 'Source', 'Applied date', 'Requirement Code', 'Stage'];
  const ph = (n) => `8${String(P % 1000000).padStart(6, '0')}${String(n).padStart(3, '0')}`;
  const em = (n) => `dt.${n}.${P}@dt-test.in`;
  const sal = ['3 LPA', '4 LPA'];
  const R = (n, date, extra = []) => [`Dt Person ${n} ${P}`, em(n), ph(n), ...sal, 'Naukri', date, ...extra];
  const rows = [
    R(1, '12/03/2026', [req.reqCode, 'NEW']), // dd/mm/yyyy, on a requirement
    R(2, '13-03-2026'), // dd-mm-yyyy
    R(3, '14.03.2026'), // dd.mm.yyyy
    R(4, '2026-03-15'), // yyyy-mm-dd
    R(5, '16 Mar 2026'), // 12 Mar 2026
    R(6, '17-Mar-26'), // 12-Mar-26
    R(7, serial(2026, 3, 18)), // Excel serial number
    R(8, new Date(Date.UTC(2026, 2, 19))), // a real date cell
    R(9, '2026-02-05 14:30', [req.reqCode, 'RECRUITER_REVIEW']), // text with a time
    R(10, '20-03-26'), // two-digit year
    R(11, '25/12/2030'), // the future
    R(12, 'next week sometime'), // not a date
    R(13, ''), // no date
    R(14, '12/03/1998'), // before 2000
  ];
  const mapName = (r) => `Dt Person ${r} ${P}`;
  const marchBefore = (await call('GET', '/candidates/sources?period=custom&from=2026-01-01&to=2026-12-31&group=month', null, tA)).body;
  const monthCount = (d, key) => ((d && d.series) || []).find((s) => s.key === key);
  const mBefore = (monthCount(marchBefore, '2026-03-01') || {}).people || 0;
  const fBefore = (monthCount(marchBefore, '2026-02-01') || {}).people || 0;

  const chk = await upload('/ats-io/import/candidates/check', rows, {}, tA, header);
  check('preview: the "Applied date" column is found by itself and mapped to Date Came', chk.status === 200 && chk.body.dateColumn === 'Applied date' && chk.body.mapping.find((m) => m.header === 'Date Came').column === 6, chk.body && { s: chk.status, dc: chk.body.dateColumn, e: chk.body.error });
  const t = chk.body.totals || {};
  check('preview summary: 10 rows have a date, 1 has none, 3 have a date that cannot be used', t.withDate === 10 && t.noDate === 1 && t.badDate === 3 && t.dateMode === 'sheet', t);
  const byRow = (n) => (chk.body.results || []).find((r) => r.row === n + 1);
  check('preview row shows its parsed date: dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy, yyyy-mm-dd', [byRow(1), byRow(2), byRow(3), byRow(4)].map((r) => r && r.cameOn).join() === '2026-03-12,2026-03-13,2026-03-14,2026-03-15', (chk.body.results || []).slice(0, 4));
  check('preview row shows its parsed date: 12 Mar 2026, 12-Mar-26, Excel serial, date cell', [byRow(5), byRow(6), byRow(7), byRow(8)].map((r) => r && r.cameOn).join() === '2026-03-16,2026-03-17,2026-03-18,2026-03-19', (chk.body.results || []).slice(4, 8));
  check('preview row: text with a time and a two-digit year', byRow(9).cameOn === '2026-02-05' && byRow(10).cameOn === '2026-03-20', [byRow(9), byRow(10)]);
  check('preview flags a future date, an unreadable date and a date before 2000 (error rows, with the reason)', byRow(11).action === 'error' && byRow(11).cameOnFlag === 'future' && /future/.test(byRow(11).message)
    && byRow(12).action === 'error' && byRow(12).cameOnFlag === 'bad' && byRow(14).action === 'error' && byRow(14).cameOnFlag === 'old' && /2000/.test(byRow(14).message), [byRow(11), byRow(12), byRow(14)]);
  check('preview: a row with no date is flagged "none" (it will be marked original date not known)', byRow(13).cameOnFlag === 'none' && byRow(13).action === 'create', byRow(13));
  check('the preview wrote nothing', (await prisma.candidate.count({ where: { name: { contains: ` ${P}` }, email: { contains: 'dt-test.in' } } })) === 0);

  const com = await upload('/ats-io/import/candidates/commit', rows, { partial: 'true' }, tA, header);
  check('commit: 11 people created (10 dated + 1 undated), 3 rows left out', com.status === 200 && com.body.totals.create === 11 && com.body.totals.errorRows === 3, com.body && (com.body.totals || com.body));
  const C = {};
  for (let n = 1; n <= 14; n += 1) C[n] = await prisma.candidate.findFirst({ where: { email: em(n) } });
  const dayOf = (n) => day(C[n].createdAt);
  check('createdAt is the sheet date (dd/mm/yyyy ... two-digit year)', [1, 2, 3, 4, 5, 6, 7, 8, 10].map(dayOf).join() === '2026-03-12,2026-03-13,2026-03-14,2026-03-15,2026-03-16,2026-03-17,2026-03-18,2026-03-19,2026-03-20', [1, 2, 3, 4, 5, 6, 7, 8, 10].map(dayOf));
  check('a time in the cell is kept (14:30 IST); a date alone is 00:00 IST', C[9].createdAt.toISOString() === '2026-02-05T09:00:00.000Z' && C[1].createdAt.toISOString() === '2026-03-11T18:30:00.000Z', [C[9].createdAt, C[1].createdAt]);
  check('refused rows (future, unreadable, before 2000) were not created', !C[11] && !C[12] && !C[14]);
  check('no date: createdAt is today', C[13] && dayOf(13) === today, C[13] && dayOf(13));
  const marks = await prisma.$queryRawUnsafe('SELECT "candidateId","kind" FROM "CandidateDateMark"');
  const kindOfId = (id) => (marks.find((m) => m.candidateId === id) || {}).kind;
  check('marks: dated people are "sheet", the undated one is "unknown"', [1, 2, 9, 10].every((n) => kindOfId(C[n].id) === 'sheet') && kindOfId(C[13].id) === 'unknown', marks.length);
  const prof = async (n, token = tA) => (await call('GET', `/candidates/${C[n].id}`, null, token)).body;
  const p1 = await prof(1); const p13 = await prof(13);
  check('profile: dated person says "From the sheet" with the real day', p1.cameOnKind === 'fromSheet' && p1.cameOnDay === '2026-03-12' && p1.cameOnLabel === 'From the sheet', { k: p1.cameOnKind, d: p1.cameOnDay, l: p1.cameOnLabel });
  check('profile: undated person is "Imported", dated today, label says the original date is not known', p13.cameOnKind === 'imported' && p13.cameOnDay === today && /original date not known/.test(p13.cameOnLabel), { k: p13.cameOnKind, d: p13.cameOnDay, l: p13.cameOnLabel });
  const a1 = await prisma.application.findFirst({ where: { candidateId: C[1].id }, include: { stageEvents: { orderBy: { createdAt: 'asc' } } } });
  check('first application is dated the sheet day, and its first stage event too', a1 && day(a1.createdAt) === '2026-03-12' && a1.stageEvents.length >= 1 && a1.stageEvents[0].fromStage === null && day(a1.stageEvents[0].createdAt) === '2026-03-12', a1 && { c: a1.createdAt, ev: a1.stageEvents.map((e) => [e.fromStage, e.toStage, e.createdAt]) });
  const a9 = await prisma.application.findFirst({ where: { candidateId: C[9].id }, include: { stageEvents: { orderBy: { createdAt: 'asc' } } } });
  check('an application at a later stage: created + stage events both on the sheet day, current stage kept', a9 && a9.stage === 'RECRUITER_REVIEW' && day(a9.createdAt) === '2026-02-05' && a9.stageEvents.length === 2 && a9.stageEvents.every((e) => day(e.createdAt) === '2026-02-05'), a9 && { s: a9.stage, ev: a9.stageEvents.map((e) => [e.fromStage, e.toStage, e.createdAt]) });
  check('ageing does not jump back: the application\'s last movement is the import moment', a1 && Date.now() - a1.updatedAt.getTime() < 3600e3, a1 && a1.updatedAt);
  const list = await call('GET', `/candidates?paged=1&search=${encodeURIComponent(`Dt Person 1 ${P}`)}&pageSize=20`, null, tA);
  const lrow = ((list.body && list.body.rows) || []).find((r) => r.id === C[1].id || r.candidateId === C[1].id);
  check('the candidates list shows the real day and the trust word', lrow && lrow.cameOnDay === '2026-03-12' && lrow.cameOnKind === 'fromSheet', lrow ? { d: lrow.cameOnDay, k: lrow.cameOnKind } : { total: list.body && list.body.total, first: list.body && list.body.rows && list.body.rows[0] && Object.keys(list.body.rows[0]).slice(0, 12) });
  const mAfter = (monthCount((await call('GET', '/candidates/sources?period=custom&from=2026-01-01&to=2026-12-31&group=month', null, tA)).body, '2026-03-01') || {}).people || 0;
  const fAfter = (monthCount((await call('GET', '/candidates/sources?period=custom&from=2026-01-01&to=2026-12-31&group=month', null, tA)).body, '2026-02-01') || {}).people || 0;
  check('sourced per month: March gained the 9 March people, February the 1 February person', mAfter - mBefore === 9 && fAfter - fBefore === 1, { mBefore, mAfter, fBefore, fAfter });
  const audit = await prisma.auditLog.findFirst({ where: { entity: 'AtsImport', entityId: 'candidates' }, orderBy: { createdAt: 'desc' } });
  check('the audit row says how many rows had their own date', audit && /10 with their own date/.test(audit.action), audit && audit.action);
  const ex = await call('GET', '/ats-io/access', null, tA);
  check('access tells the screen who may fix dates (Admin yes)', ex.body && ex.body.viewer && ex.body.viewer.fixDates === true, ex.body && ex.body.viewer);

  // ===== 2. one date for every row, and today =====
  const hdr2 = ['Full Name', 'Email', 'Phone', 'Current Salary', 'Expected Salary', 'Source'];
  const R2 = (n) => [`Dt One ${n} ${P}`, em(`o${n}`), ph(100 + n), ...sal, 'Referral'];
  const oneBad = await upload('/ats-io/import/candidates/check', [R2(1)], { dateMode: 'one', cameOnDate: '2031-01-01' }, tA, hdr2);
  check('one date for all rows: a future date is refused with a plain message', oneBad.status === 400 && /future/.test(oneBad.body.error), oneBad.body);
  const oneNone = await upload('/ats-io/import/candidates/check', [R2(1)], { dateMode: 'one' }, tA, hdr2);
  check('one date for all rows: no date chosen is refused', oneNone.status === 400, oneNone.body);
  const one = await upload('/ats-io/import/candidates/check', [R2(1), R2(2)], { dateMode: 'one', cameOnDate: '2026-01-10' }, tA, hdr2);
  check('one date for all rows: the preview shows that date on every row', one.status === 200 && one.body.results.every((r) => r.cameOn === '2026-01-10') && one.body.totals.withDate === 2, one.body && one.body.totals);
  const oneC = await upload('/ats-io/import/candidates/commit', [R2(1), R2(2)], { dateMode: 'one', cameOnDate: '2026-01-10' }, tA, hdr2);
  const o1 = await prisma.candidate.findFirst({ where: { email: em('o1') } });
  check('one date for all rows: both people are dated 10 Jan 2026 and say From the sheet', oneC.status === 200 && o1 && day(o1.createdAt) === '2026-01-10' && kindOfIdLive(await marksNow(), o1.id) === 'sheet', oneC.body && oneC.body.error);
  const hdr3 = [...hdr2, 'Date came'];
  const R3 = (n) => [`Dt Today ${n} ${P}`, em(`t${n}`), ph(200 + n), ...sal, 'Referral', '05/01/2026'];
  const tod = await upload('/ats-io/import/candidates/commit', [R3(1)], { dateMode: 'today' }, tA, hdr3);
  const t1 = await prisma.candidate.findFirst({ where: { email: em('t1') } });
  const tp = await call('GET', `/candidates/${t1 && t1.id}`, null, tA);
  check('today: the sheet\'s date is ignored, the person is dated today and marked original date not known', tod.status === 200 && t1 && day(t1.createdAt) === today && tp.body.cameOnKind === 'imported', tod.body && tod.body.error);
  const noCol = await upload('/ats-io/import/candidates/commit', [[`Dt NoCol ${P}`, em('n1'), ph(301), ...sal, 'Referral']], {}, tA, hdr2);
  const n1 = await prisma.candidate.findFirst({ where: { email: em('n1') } });
  check('a sheet with no date column at all: today, marked original date not known (never shown as the day they came)', noCol.status === 200 && n1 && day(n1.createdAt) === today && kindOfIdLive(await marksNow(), n1.id) === 'unknown', noCol.body && noCol.body.error);
  // the Applications sheet carries its own date too
  const hdrA = ['Candidate Email or Phone', 'Requirement Code', 'Stage', 'Date received'];
  const req2 = await prisma.requirement.findFirst({ where: { status: { in: ['OPEN', 'RECRUITER_ASSIGNED'] }, internal: false, reqCode: { not: null, notIn: [req.reqCode] } }, select: { id: true, reqCode: true } });
  const ap = await upload('/ats-io/import/applications/commit', [[em('t1'), req2.reqCode, 'NEW', '03-02-2026']], {}, tA, hdrA);
  const ta = t1 && await prisma.application.findFirst({ where: { candidateId: t1.id } });
  check('the Applications sheet: the application is dated the sheet day (the person\'s own date is not touched)', ap.status === 200 && ta && day(ta.createdAt) === '2026-02-03' && day(t1.createdAt) === today, ap.body && (ap.body.error || ap.body.totals));

  // ===== 3. the repair tool =====
  // people ALREADY imported with today's date: the undated rows above (C13, t1, n1) + one typed in by hand (a system date)
  const manual = await call('POST', '/candidates', { name: `Dt Manual ${P}`, email: em('man'), phone: ph(401), currentSalary: '3 LPA', expectedSalary: '4 LPA', source: 'Naukri', skills: 'ICU, Patient care' }, tA);
  const man = await prisma.candidate.findFirst({ where: { email: em('man') } });
  check('setup: a person typed in by hand exists (system-recorded date)', [200, 201].includes(manual.status) && !!man, manual.body);
  // an old import with NO mark at all and an application dated the import day (the state of every import made before this fix)
  const old = await prisma.candidate.create({ data: { name: `Dt Old ${P}`, email: em('old'), phone: ph(402), source: 'Naukri' } });
  const oldApp = await prisma.application.create({ data: { candidateId: old.id, requirementId: req.id, stage: 'NEW', source: 'Naukri' } });
  const fixHdr = ['Phone', 'Email', 'Date came on'];
  const fixRows = [
    [ph(402), '', '04/02/2026'], // old import, matched by phone
    ['', em('n1'), '06-02-2026'], // matched by email (marked unknown)
    [ph(401), '', '07-02-2026'], // typed in by hand: system date
    ['9000000000', 'nobody@nowhere.test', '08-02-2026'], // not found
    [ph(201), '', 'garbage'], // bad date
    ['', em('old'), '09-02-2026'], // the same person again: ambiguous no, duplicate row
  ];
  // give two people the same phone so one row is ambiguous
  await prisma.candidate.create({ data: { name: `Dt Twin A ${P}`, phone: ph(501) } });
  await prisma.candidate.create({ data: { name: `Dt Twin B ${P}`, phone: ph(501) } });
  fixRows.push([ph(501), '', '10-02-2026']);
  const fr = await upload('/ats-io/import/date-fix/check', fixRows, {}, tR, fixHdr);
  check('a recruiter cannot use the repair tool (403)', fr.status === 403, fr.body);
  check('a BDE cannot use the repair tool (403)', (await upload('/ats-io/import/date-fix/check', fixRows, {}, tB, fixHdr)).status === 403);
  const fa = await upload('/ats-io/import/date-fix/apply', fixRows, { confirm: 'true' }, tR, fixHdr);
  check('...nor apply (403), and nothing changed', fa.status === 403 && day((await prisma.candidate.findUnique({ where: { id: old.id } })).createdAt) === today);
  const tl = await upload('/ats-io/import/date-fix/check', fixRows, {}, tT, fixHdr);
  check('a TL may open the tool; people outside their area are not touched or revealed', tl.status === 200 && tl.body.totals.fix === 0, tl.body && tl.body.totals);
  const pv = await upload('/ats-io/import/date-fix/check', fixRows, {}, tA, fixHdr);
  const pt = pv.body.totals || {};
  check('preview numbers: 2 matched, 1 not found, 1 ambiguous, 1 bad date, 1 kept (system date)', pv.status === 200 && pt.fix === 2 && pt.notFound === 1 && pt.ambiguous === 1 && pt.bad === 1 && pt.protected === 1, pt);
  const rowOf = (key) => (pv.body.rows || []).find((r) => r.key === key);
  const old1 = rowOf(ph(402));
  check('preview row: current date -> new date', old1 && old1.status === 'fix' && old1.oldDay === today && old1.newDay === '2026-02-04', old1);
  check('preview: the typed-in person is protected and the reason says so', rowOf(ph(401)).status === 'protected' && /recorded by TeamLink/.test(rowOf(ph(401)).message), rowOf(ph(401)));
  check('preview wrote nothing', day((await prisma.candidate.findUnique({ where: { id: old.id } })).createdAt) === today);
  check('apply without confirm is refused', (await upload('/ats-io/import/date-fix/apply', fixRows, {}, tA, fixHdr)).status === 400);
  const ap1 = await upload('/ats-io/import/date-fix/apply', fixRows, { confirm: 'true' }, tA, fixHdr);
  check('apply: 2 people fixed in one batch', ap1.status === 200 && ap1.body.changed === 2 && /^df-/.test(ap1.body.batchId), ap1.body);
  const oldNow = await prisma.candidate.findUnique({ where: { id: old.id } });
  const oldAppNow = await prisma.application.findUnique({ where: { id: oldApp.id } });
  check('fixed: candidate createdAt and the first application\'s createdAt follow the sheet; the application\'s last movement does not', day(oldNow.createdAt) === '2026-02-04' && day(oldAppNow.createdAt) === '2026-02-04' && oldAppNow.updatedAt.getTime() === oldApp.updatedAt.getTime(), { c: oldNow.createdAt, a: oldAppNow.createdAt });
  const n1Now = await prisma.candidate.findUnique({ where: { id: n1.id } });
  check('the marked-unknown person is fixed by email too', day(n1Now.createdAt) === '2026-02-06');
  const manNow = await prisma.candidate.findUnique({ where: { id: man.id } });
  check('the typed-in person\'s date is untouched without Overwrite', day(manNow.createdAt) === today);
  const po = await call('GET', `/candidates/${old.id}`, null, tA);
  check('profile now says From the sheet with the real day', po.body.cameOnKind === 'fromSheet' && po.body.cameOnDay === '2026-02-04', { k: po.body.cameOnKind, d: po.body.cameOnDay });
  const fixRow = (await prisma.$queryRawUnsafe('SELECT * FROM "CandidateDateFix" WHERE "candidateId" = ?', old.id))[0];
  check('the old date is kept in CandidateDateFix (and the batch, who, when)', fixRow && day(new Date(fixRow.oldCreatedAt)) === today && fixRow.newDay === '2026-02-04' && fixRow.batchId === ap1.body.batchId && fixRow.byName, fixRow);
  const batchAudit = await prisma.auditLog.findFirst({ where: { entity: 'CandidateDateFix', entityId: ap1.body.batchId } });
  check('the batch is audited', !!batchAudit && /2 people/.test(batchAudit.action), batchAudit && batchAudit.action);
  const bl = await call('GET', '/ats-io/import/date-fix/batches', null, tA);
  check('the batch is listed', (bl.body.batches || []).some((b) => b.id === ap1.body.batchId && b.people === 2 && !b.undone), bl.body);
  check('a TL cannot undo a batch somebody else made', (await call('POST', `/ats-io/import/date-fix/batches/${ap1.body.batchId}/undo`, null, tT)).status === 403);
  check('a recruiter cannot undo (403)', (await call('POST', `/ats-io/import/date-fix/batches/${ap1.body.batchId}/undo`, null, tR)).status === 403);
  const un = await call('POST', `/ats-io/import/date-fix/batches/${ap1.body.batchId}/undo`, null, tA);
  const oldBack = await prisma.candidate.findUnique({ where: { id: old.id } });
  const oldAppBack = await prisma.application.findUnique({ where: { id: oldApp.id } });
  check('undo: the old dates are back (candidate and application)', un.status === 200 && un.body.restored === 2 && oldBack.createdAt.getTime() === old.createdAt.getTime() && oldAppBack.createdAt.getTime() === oldApp.createdAt.getTime(), un.body);
  check('undo: the marker is back to what it was (unknown for one, none for the old import)', kindOfIdLive(await marksNow(), n1.id) === 'unknown' && kindOfIdLive(await marksNow(), old.id) === undefined);
  check('undoing twice is refused', (await call('POST', `/ats-io/import/date-fix/batches/${ap1.body.batchId}/undo`, null, tA)).status === 409);
  // Overwrite
  const ow = await upload('/ats-io/import/date-fix/apply', [[ph(401), '', '07-02-2026']], { confirm: 'true', overwrite: 'true' }, tA, fixHdr);
  const manFixed = await prisma.candidate.findUnique({ where: { id: man.id } });
  check('with Overwrite ticked the typed-in person is changed too', ow.status === 200 && ow.body.changed === 1 && day(manFixed.createdAt) === '2026-02-07', ow.body);
  // sheet without the needed columns
  const noKey = await upload('/ats-io/import/date-fix/check', [['a', 'b']], {}, tA, ['Colour', 'Size']);
  check('a sheet with no date / key column says what is missing', noKey.status === 400 || (noKey.body && (noKey.body.ok === false || noKey.body.error)), noKey.body);
  await stop(failed ? 1 : 0);
  return null;

  function kindOfIdLive(list, id) { return (list.find((m) => m.candidateId === id) || {}).kind; }
  async function marksNow() { return prisma.$queryRawUnsafe('SELECT "candidateId","kind" FROM "CandidateDateMark"'); }
})().catch(async (e) => { console.error(e); failed += 1; await stop(1); }).then(() => {
  // the summary prints after stop() has been scheduled
  setTimeout(() => console.log(`\n${total - failed}/${total} passed`), 300);
});
