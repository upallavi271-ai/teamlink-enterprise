#!/usr/bin/env node
/**
 * CALL LISTS (calllist/service.js, routes/callLists.js) - founder 2026-11-17: "recruiters ki data vastadhi, sheets format lo; aa sheets multiple recruiters ki divide chesi assign
 * chestaru; assign chesaka, recruiters aa data lo unna contacts ni VICIdial nundi call chestaru". A manager uploads the sheet and it is split in equal blocks among the recruiters
 * picked; each recruiter sees only their block, works it one contact at a time (copy the number, dial in VICIdial, say how it went); the manager sees progress and can move what is
 * left. SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4063; nothing is dialled.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/call-lists-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-call-lists-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();

const PORT = 4063;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'call-lists-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const XLSX = require('xlsx');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 420)}` : ''}`); } };
const tokenOf = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
const mkUser = (tag, data) => prisma.user.create({ data: { name: `ZZ ${tag}`, email: `zz.calllist.${tag}.${process.pid}@zz-calllist-test.in`, passwordHash: 'x', status: 'Active', passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
const call = async (method, url, body, token, raw) => {
  const r = await fetch(API + url, { method, headers: { ...(raw ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: raw ? body : (body ? JSON.stringify(body) : undefined) });
  let j = null; let text = null; try { text = await r.text(); j = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: j, text };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
// a sheet like the recruiters get: 10 good contacts, one repeated number, one wrong number, one blank
const sheet = (n = 10) => {
  const rows = [];
  for (let i = 0; i < n; i += 1) rows.push({ 'Candidate Name': `Person ${i + 1}`, 'Mobile Number': `98765${String(10000 + i).slice(-5)}`, 'Alternate Mobile': i === 0 ? '9123456780' : '', City: i % 2 ? 'Hyderabad' : 'Vijayawada', Qualification: 'B.Sc Nursing', 'Batch Code': `B${i}` });
  rows.push({ 'Candidate Name': 'Repeat', 'Mobile Number': '9876510000', 'Alternate Mobile': '', City: '', Qualification: '', 'Batch Code': '' }); // the same number as Person 1
  rows.push({ 'Candidate Name': 'Wrong', 'Mobile Number': '12345', 'Alternate Mobile': '', City: '', Qualification: '', 'Batch Code': '' });
  rows.push({ 'Candidate Name': 'Blank', 'Mobile Number': '', 'Alternate Mobile': '', City: '', Qualification: '', 'Batch Code': '' });
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

(async () => {
  const M = await mkUser('manager', { role: 'SUPER_ADMIN' });
  const R1 = await mkUser('rec1', { role: 'EMPLOYEE', atsRole: 'RECRUITER' });
  const R2 = await mkUser('rec2', { role: 'EMPLOYEE', atsRole: 'RECRUITER' });
  const R3 = await mkUser('rec3', { role: 'EMPLOYEE', atsRole: 'RECRUITER' });
  const OUT = await mkUser('outsider', { role: 'EMPLOYEE', atsRole: 'RECRUITER' });
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tM = await tokenOf(M.id); const t1 = await tokenOf(R1.id); const t2 = await tokenOf(R2.id); const t3 = await tokenOf(R3.id); const tO = await tokenOf(OUT.id);
  const rec = `${R1.id},${R2.id},${R3.id}`;

  console.log('1. Only a manager uploads, and a preview changes nothing');
  check('a recruiter cannot upload a call sheet', (await call('POST', `/call-lists/import?name=a.xlsx&recruiters=${R1.id}`, sheet(), t1, true)).status === 403);
  check('a recruiter cannot see who a sheet can be split among', (await call('GET', '/call-lists/recruiters', null, t1)).status === 403);
  const pick = await call('GET', '/call-lists/recruiters', null, tM);
  check('a manager sees the recruiters to split among', pick.status === 200 && ['rec1', 'rec2', 'rec3'].every((t) => (pick.body.recruiters || []).some((x) => x.name === `ZZ ${t}`)), [pick.status, pick.body && (pick.body.error || (pick.body.recruiters || []).length)]);
  const prev = await call('POST', `/call-lists/import?name=sheet.xlsx&listName=Nursing&recruiters=${rec}&dryRun=1`, sheet(), tM, true);
  check('the preview finds the columns by their headings (name, mobile, alternate, city, qualification)', prev.status === 200 && prev.body.columns.name === 'Candidate Name' && prev.body.columns.phone === 'Mobile Number' && prev.body.columns.phone2 === 'Alternate Mobile' && prev.body.columns.location === 'City' && prev.body.columns.interest === 'Qualification', prev.body);
  check('it says what is usable: 10 contacts, 1 repeated number, 1 wrong number, 1 blank row', prev.body.usable === 10 && prev.body.duplicate === 1 && prev.body.invalid === 1 && prev.body.blank === 1, prev.body);
  check('the other column (Batch Code) is kept as extra information', (prev.body.extraColumns || []).includes('Batch Code'), prev.body.extraColumns);
  check('the split is in equal blocks: 10 contacts / 3 recruiters = 4, 3, 3', prev.body.split.map((x) => x.count).join(',') === '4,3,3', prev.body.split);
  check('a preview creates nothing', ((await call('GET', '/call-lists', null, tM)).body.lists || []).length === 0);
  check('a file with no phone column is refused and the headings are listed', (await (async () => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ A: 1, B: 2 }]), 'S'); const r = await call('POST', '/call-lists/import?name=x.xlsx', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), tM, true); return r.status === 400 && /No phone column/.test(r.body.error) && r.body.headings.length === 2; })()));

  console.log('2. The upload splits the sheet');
  const up = await call('POST', `/call-lists/import?name=sheet.xlsx&listName=Nursing&recruiters=${rec}`, sheet(), tM, true);
  check('the list is made with 10 contacts', up.status === 200 && up.body.id && up.body.usable === 10, up.body);
  const id = up.body.id;
  const det = await call('GET', `/call-lists/${id}`, null, tM);
  const by = Object.fromEntries((det.body.progress || []).map((p) => [p.recruiterName, p.assigned]));
  check('recruiter 1 has 4, recruiter 2 has 3, recruiter 3 has 3', by['ZZ rec1'] === 4 && by['ZZ rec2'] === 3 && by['ZZ rec3'] === 3, by);
  const all1 = await call('GET', `/call-lists/${id}/rows?size=100`, null, tM);
  const firstFour = (all1.body.rows || []).slice(0, 4).map((r) => r.recruiterName);
  check('the blocks follow the sheet order: the first four contacts are recruiter 1\'s', firstFour.every((n) => n === 'ZZ rec1'), firstFour);
  check('the alternate number and the other columns are on the contact', (all1.body.rows[0].phone2 === '9123456780') && all1.body.rows[0].extra && all1.body.rows[0].extra['Batch Code'] === 'B0', all1.body.rows[0]);

  console.log('3. Each recruiter sees only their own block');
  const my1 = await call('GET', `/call-lists/${id}/rows?size=100`, null, t1);
  check('recruiter 1 sees 4 contacts, all theirs', my1.body.total === 4 && my1.body.rows.every((r) => r.recruiterId === R1.id), my1.body.total);
  const sneak = await call('GET', `/call-lists/${id}/rows?recruiter=${R2.id}`, null, t1);
  check('asking for another recruiter\'s block still gives only their own', sneak.body.rows.every((r) => r.recruiterId === R1.id) && sneak.body.total === 4, sneak.body.total);
  check('a recruiter with no block of this list does not see the list at all', (await call('GET', `/call-lists/${id}`, null, tO)).status === 404 && ((await call('GET', '/call-lists', null, tO)).body.lists || []).length === 0);
  const mine = await call('GET', '/call-lists', null, t1);
  check('their list shows 4 assigned (not the whole sheet)', mine.body.lists.length === 1 && mine.body.lists[0].assigned === 4 && mine.body.canManage === false, mine.body);

  console.log('4. Calling: next contact, how it went');
  const n1 = await call('GET', `/call-lists/${id}/next`, null, t1);
  check('next = the first contact of their block, and how many are left (4)', n1.body.row && n1.body.row.seq === 0 && n1.body.left === 4, n1.body);
  const rowA = n1.body.row;
  check('a recruiter cannot write the result of another recruiter\'s contact', (await call('POST', `/call-lists/rows/${rowA.id}/call`, { outcome: 'Answered' }, t2)).status === 404);
  check('an outcome that is not in the list is refused', (await call('POST', `/call-lists/rows/${rowA.id}/call`, { outcome: 'Dreaming' }, t1)).status === 400);
  const done1 = await call('POST', `/call-lists/rows/${rowA.id}/call`, { outcome: 'Interested', note: 'Wants Hyderabad batch' }, t1);
  check('"Interested" is saved with the note and counts as called', done1.status === 200 && done1.body.row.status === 'Interested' && done1.body.row.calledCount === 1 && done1.body.row.note === 'Wants Hyderabad batch', done1.body);
  const n2 = await call('GET', `/call-lists/${id}/next`, null, t1);
  check('the next contact moves on, 3 left', n2.body.row.seq === 1 && n2.body.left === 3, n2.body);
  check('Call back needs a time', (await call('POST', `/call-lists/rows/${n2.body.row.id}/call`, { outcome: 'Call back' }, t1)).status === 400);
  const soon = new Date(Date.now() + 3600e3).toISOString();
  await call('POST', `/call-lists/rows/${n2.body.row.id}/call`, { outcome: 'Call back', callbackAt: soon }, t1);
  const n3 = await call('GET', `/call-lists/${id}/next`, null, t1);
  check('a call-back that is not due yet does not come up; the next fresh contact does', n3.body.row.seq === 2, n3.body.row);
  await call('POST', `/call-lists/rows/${n3.body.row.id}/call`, { outcome: 'Not answered' }, t1);
  const n4 = await call('GET', `/call-lists/${id}/next`, null, t1);
  check('a no-answer is tried again after the fresh ones are done (fresh first)', n4.body.row.seq === 3, n4.body.row);
  await call('POST', `/call-lists/rows/${n4.body.row.id}/call`, { outcome: 'Wrong number' }, t1);
  const n5 = await call('GET', `/call-lists/${id}/next`, null, t1);
  check('then the no-answer comes back; "left" counts the call-back and the no-answer (2)', n5.body.row && n5.body.row.seq === 2 && n5.body.left === 2, n5.body);

  console.log('5. The manager sees progress, moves what is left, downloads the result');
  const pr = await call('GET', `/call-lists/${id}`, null, tM);
  const p1 = pr.body.progress.find((p) => p.recruiterName === 'ZZ rec1');
  check('progress for recruiter 1: 4 given, 4 called, 2 left, 1 interested, 1 call-back', p1.assigned === 4 && p1.called === 4 && p1.remaining === 2 && p1.interested === 1 && p1.callBack === 1, p1);
  const mv = await call('POST', `/call-lists/${id}/reassign`, { fromId: R1.id, toIds: [R2.id, R3.id] }, tM);
  check('what is left of recruiter 1 (2 contacts) is split between recruiters 2 and 3', mv.status === 200 && mv.body.moved === 2 && mv.body.split.map((x) => x.count).join(',') === '1,1', mv.body);
  const my1b = await call('GET', `/call-lists/${id}/rows?size=100`, null, t1);
  check('recruiter 1 keeps only what is finished (2 contacts)', my1b.body.total === 2 && my1b.body.rows.every((r) => !['New', 'Not answered', 'Busy', 'Switched off', 'Call back'].includes(r.status)), my1b.body.total);
  check('a recruiter cannot move contacts', (await call('POST', `/call-lists/${id}/reassign`, { fromId: R2.id, toIds: [R3.id] }, t2)).status === 403);
  const csv = await call('GET', `/call-lists/${id}/export`, null, tM);
  check('the result downloads as CSV with every contact and its status', csv.status === 200 && /Interested/.test(csv.text) && /Wants Hyderabad batch/.test(csv.text) && csv.text.split('\r\n').length === 11, csv.text && csv.text.slice(0, 120));
  check('a recruiter cannot download the result', (await call('GET', `/call-lists/${id}/export`, null, t1)).status === 403);

  console.log('6. A sheet with nobody picked stays unassigned; a manager gives it out later');
  const un = await call('POST', '/call-lists/import?name=late.xlsx&listName=Unassigned', sheet(6), tM, true);
  check('with no recruiter picked the contacts wait, given to no one', un.status === 200 && un.body.split.length === 0, un.body);
  const unRows = await call('GET', `/call-lists/${un.body.id}/rows?recruiter=none`, null, tM);
  check('they show under "not given to anyone yet"', unRows.body.total === 6 && unRows.body.rows.every((r) => !r.recruiterId), unRows.body.total);
  const give = await call('POST', `/call-lists/${un.body.id}/reassign`, { fromId: 'none', toIds: [R1.id, R2.id] }, tM);
  check('the manager gives them out in equal blocks (3 and 3)', give.status === 200 && give.body.moved === 6 && give.body.split.map((x) => x.count).join(',') === '3,3', give.body);
  check('a list can be closed by a manager, and then it is gone from the lists', (await call('DELETE', `/call-lists/${un.body.id}`, null, tM)).status === 200 && !((await call('GET', '/call-lists', null, tM)).body.lists || []).some((l) => l.id === un.body.id));
  check('the screens need a login', (await call('GET', '/call-lists')).status === 401);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
