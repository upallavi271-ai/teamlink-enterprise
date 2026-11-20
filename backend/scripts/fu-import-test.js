#!/usr/bin/env node
/**
 * IMPORT FOLLOW-UPS FROM A SHEET (founder 2026-11-20, the Overall report: "give import & export options").
 * Two TLs with their recruiters, an STL, a Manager, a BDE and HR; candidates inside and outside each team. The template, header variants and
 * the "which column is which" mapping, date formats, every refusal reason, the choices, the scope (TL / recruiter / BDE), duplicates, apply ->
 * the report counts the rows on the sheet date (imported include / exclude / only), undo removes exactly the batch.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database.
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4512 node scripts/fu-import-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-fuimp-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4512;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'fuimp-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const XLSX = require('xlsx');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 900)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
const xlsxOf = (aoa) => XLSX.write((() => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1'); return wb; })(), { type: 'buffer', bookType: 'xlsx' });
const csvOf = (aoa) => Buffer.from(aoa.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(',')).join('\n'));
const upload = async (token, buf, name = 'follow-ups.xlsx', extra = {}) => {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), name);
  Object.entries(extra).forEach(([k, v]) => fd.append(k, typeof v === 'string' ? v : JSON.stringify(v)));
  const r = await fetch(`${API}/followup-report/import/preview`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const P = process.pid;
const old = new Date(Date.now() - 3600e3);
const HEAD = ['Date', 'Recruiter', 'Candidate', 'Requirement', 'What happened', 'Call back on', 'Answer', 'Done'];
const serial = (ymd) => (Date.parse(`${ymd}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000;

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const DEPT = `Fui${P}`;
  const mk = async (tag, role, extra = {}) => {
    const dept = extra.dept || DEPT;
    const u = await prisma.user.create({ data: { name: `Fui ${tag} ${P}`, email: `fui.${tag}.${P}@fui-mail.in`, passwordHash: 'x', status: 'Active', role: extra.sysRole || (role === 'RECRUITER' ? 'EMPLOYEE' : role), atsRole: role, atsDepartment: dept, atsAccess: true, passwordChangedAt: old } });
    const e = await prisma.employee.create({ data: { userId: u.id, employeeCode: `FUI${tag.toUpperCase()}${P}`, name: u.name, department: dept, team: extra.team || null, employmentStatus: 'Active' } });
    return { u, e };
  };
  const seat = async (code, kind, holder, team, reportsToId) => {
    const p = await prisma.position.create({ data: { code: `${code}-${P}`, name: code, department: DEPT, team, kind, reportsToId: reportsToId || null, active: true } });
    if (holder) await prisma.positionAssignment.create({ data: { positionId: p.id, employeeId: holder.e.id, fromDate: '2026-01-01' } });
    return p;
  };
  const stl = await mk('stl', 'STL');
  const tl1 = await mk('tl1', 'TL', { team: 'Team A' }); const tl2 = await mk('tl2', 'TL', { team: 'Team B' });
  const r1a = await mk('r1a', 'RECRUITER', { team: 'Team A' }); const r1b = await mk('r1b', 'RECRUITER', { team: 'Team A' });
  const r2a = await mk('r2a', 'RECRUITER', { team: 'Team B' });
  const mgr = await mk('mgr', 'MANAGER', { sysRole: 'MANAGER' });
  const bde = await mk('bde', 'BDE', { dept: 'BDE' });
  const hr = await mk('hr', 'HR', { dept: 'HR' });
  const sSTL = await seat('STL', 'STL', stl, null);
  const sTL1 = await seat('TL1', 'TL', tl1, 'Team A', sSTL.id); const sTL2 = await seat('TL2', 'TL', tl2, 'Team B', sSTL.id);
  await seat('R1A', 'RECRUITER', r1a, 'Team A', sTL1.id); await seat('R1B', 'RECRUITER', r1b, 'Team A', sTL1.id); await seat('R2A', 'RECRUITER', r2a, 'Team B', sTL2.id);

  const client = await prisma.client.findFirst({});
  const mkReq = (tag, tl, rec) => prisma.requirement.create({ data: { title: `Fui job ${tag} ${P}`, reqCode: `FUI-${tag}-${P}`, clientId: client.id, department: DEPT, status: 'RECRUITER_ASSIGNED', tlId: tl.u.id, recruiterId: rec.u.id, recruiterIds: rec.u.id } });
  const reqA = await mkReq('A', tl1, r1a); const reqB = await mkReq('B', tl1, r1b); const reqA2 = await mkReq('A2', tl1, r1a); const reqC = await mkReq('C', tl2, r2a);
  let n = 0;
  const cand = (tag, name) => { n += 1; return prisma.candidate.create({ data: { name: name || `Fui Person ${tag} ${P}`, phone: `9${String(P).padStart(6, '0').slice(-6)}${String(n).padStart(3, '0')}`, email: `fui.person.${tag}.${P}@fui-mail.in` } }); };
  const app = (c, req, owner, ago = 0) => prisma.application.create({ data: { candidateId: c.id, requirementId: req.id, stage: 'SOURCED', ownerRecruiterId: owner ? owner.u.id : null, updatedAt: new Date(Date.now() - ago * 1000) } });
  const c1 = await cand('one'); const a1 = await app(c1, reqA, r1a);
  const c2 = await cand('two'); const a2a = await app(c2, reqA, r1a, 50); const a2b = await app(c2, reqB, r1b, 10); // two applications, two recruiters
  const c3 = await cand('three'); const a3a = await app(c3, reqA, r1a, 30); const a3b = await app(c3, reqA2, r1a, 5); // two applications, both of R1a
  const cT2 = await cand('teamb'); await app(cT2, reqC, r2a); // TL2's team
  const cNone = await cand('nowhere'); // no application anywhere
  const twinName = `Fui Twin ${P}`;
  const tw1 = await cand('twin1', twinName); const atw1 = await app(tw1, reqA, r1a); const tw2 = await cand('twin2', twinName); const atw2 = await app(tw2, reqB, r1b);
  const c5 = await cand('five'); const a5 = await app(c5, reqB, r1b);
  // an existing follow-up the sheet repeats (duplicate)
  await prisma.applicationFollowUp.create({ data: { applicationId: a1.id, candidateId: c1.id, ownerUserId: r1a.u.id, ownerName: r1a.u.name, createdById: r1a.u.id, createdByName: r1a.u.name, notes: 'Already logged in TeamLink', createdAt: new Date('2026-10-05T06:00:00Z') } });

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  let up = false;
  for (let i = 0; i < 160 && !up; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    up = await fetch(`${API}/health`).then((r) => r.ok).catch(() => false);
    // eslint-disable-next-line no-await-in-loop
    if (!up) await new Promise((r) => { setTimeout(r, 500); });
  }
  if (!up) { console.log('the server did not answer /api/health'); await stop(2); return; }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const T = {};
  for (const [k, u] of Object.entries({ admin: adminRow, stl: stl.u, tl1: tl1.u, tl2: tl2.u, r1a: r1a.u, r1b: r1b.u, mgr: mgr.u, bde: bde.u, hr: hr.u })) T[k] = await tok(u.id); // eslint-disable-line no-await-in-loop
  const byRow = (res) => Object.fromEntries(((res.body && res.body.rows) || []).map((r) => [r.row, r]));

  // ================= the template
  const tr = await fetch(`${API}/followup-report/import/template`, { headers: { Authorization: `Bearer ${T.tl1}` } });
  const twb = XLSX.read(Buffer.from(await tr.arrayBuffer()), { type: 'buffer' });
  const tg = XLSX.utils.sheet_to_json(twb.Sheets[twb.SheetNames[0]], { header: 1, defval: '' });
  check('template: an .xlsx with the eight columns and two example rows, and a "How to fill" sheet', tr.status === 200 && JSON.stringify(tg[0]) === JSON.stringify(HEAD) && tg.length === 3 && twb.SheetNames.includes('How to fill'), tg);
  const tback = await upload(T.tl1, Buffer.from(await (await fetch(`${API}/followup-report/import/template`, { headers: { Authorization: `Bearer ${T.tl1}` } })).arrayBuffer()), 'template.xlsx');
  check('the template sent back untouched: both example rows are skipped, nothing is Ready', tback.status === 200 && tback.body.totals.ready === 0 && tback.body.rows.every((r) => /example/i.test(r.reason)), tback.body);
  check('template: BDE and HR are refused (403)', (await fetch(`${API}/followup-report/import/template`, { headers: { Authorization: `Bearer ${T.bde}` } })).status === 403 && (await fetch(`${API}/followup-report/import/template`, { headers: { Authorization: `Bearer ${T.hr}` } })).status === 403);

  // ================= header variants, the column mapping, date formats
  const variant = [
    ['  follow up DATE ', 'Recruiter Name', 'Mobile', 'Req Code', 'REMARKS', 'Next Follow-up', 'Outcome', 'Completed'],
    ['06/10/2026', r1a.u.name, c1.phone, reqA.reqCode, 'Variant one: dd/mm/yyyy', '', 'Interested', 'yes'],
    ['07-Oct-26', r1a.u.email, `+91 ${c1.phone.slice(0, 5)} ${c1.phone.slice(5)}`, '', 'Variant two: dd-Mon-yy, e-mail recruiter, phone with +91', '', 'not picked', ''],
    [serial('2026-10-08'), r1a.e.employeeCode, c1.email.toUpperCase(), '', 'Variant three: an Excel date number, employee code, candidate e-mail', '', '', 'no'],
    ['2026-10-09', r1a.u.name.toUpperCase(), c1.id, '', 'Variant four: ISO date, candidate ID', '', 'Not Interested', '1'],
  ];
  const pv = await upload(T.tl1, xlsxOf(variant));
  const vm = Object.fromEntries((pv.body.mapping || []).map((m) => [m.key, m.column]));
  check('header variants: "follow up DATE", "Recruiter Name", "Mobile", "Req Code", "REMARKS", "Next Follow-up", "Outcome", "Completed" are all recognised', pv.status === 200 && pv.body.ok && vm.date === 0 && vm.recruiter === 1 && vm.phone === 2 && vm.requirement === 3 && vm.what === 4 && vm.callBack === 5 && vm.answer === 6 && vm.done === 7, pv.body.mapping);
  if (!pv.body.ok) console.log(JSON.stringify(pv.body).slice(0, 1500));
  const vr = byRow(pv);
  check('date formats: 06/10/2026 = 6 Oct (day first), 07-Oct-26, an Excel serial, ISO', vr[2].day === '2026-10-06' && vr[3].day === '2026-10-07' && vr[4].day === '2026-10-08' && vr[5].day === '2026-10-09', [vr[2].day, vr[3].day, vr[4].day, vr[5].day]);
  check('recruiter by name, e-mail, employee code, name in capitals; candidate by phone, +91 phone, e-mail, candidate ID: all Ready on the same application', [2, 3, 4, 5].every((r) => vr[r].status === 'ready' && vr[r].recruiter.id === r1a.u.id && vr[r].candidate.id === c1.id && vr[r].application.id === a1.id), Object.values(vr).map((r) => [r.status, r.reason]));
  check('answers read: Interested, "not picked" = No answer, Not Interested; Done yes / blank (no call-back = done) / no / 1', vr[2].answer === 'Interested' && vr[3].answer === 'No answer' && vr[5].answer === 'Not interested' && vr[2].done === true && vr[3].done === true && vr[4].done === false && vr[5].done === true, Object.values(vr).map((r) => [r.answer, r.done]));
  const csv = await upload(T.tl1, csvOf([HEAD, ['12-03-2026', r1a.u.name, c1.phone, '', 'From a CSV, 12-03-2026 is 12 March', '', '', '']]), 'sheet.csv');
  check('a CSV file works and 12-03-2026 is 12 March 2026', csv.status === 200 && byRow(csv)[2] && byRow(csv)[2].day === '2026-03-12' && byRow(csv)[2].status === 'ready', csv.body && csv.body.rows);
  const odd = [['When', 'Recruiter', 'Candidate', 'Notes'], ['10-10-2026', r1a.u.name, c1.phone, 'Header "When" is not known']];
  const pm = await upload(T.tl1, xlsxOf(odd));
  check('an unknown date header: not ok, says "Date" is missing and lists the file\'s columns to choose from', pm.status === 200 && pm.body.ok === false && pm.body.missing.includes('Date') && pm.body.fileColumns.some((c) => c.name === 'When'), pm.body);
  const pm2 = await upload(T.tl1, xlsxOf(odd), 'x.xlsx', { mapping: { date: 0 } });
  check('"Which column is which": Date = "When" -> the row is read and Ready', pm2.status === 200 && pm2.body.ok && byRow(pm2)[2].day === '2026-10-10' && byRow(pm2)[2].status === 'ready', pm2.body.rows);

  // ================= every refusal reason
  const R = [HEAD,
    ['05-10-2026', r1a.u.name, c1.phone, '', 'Already logged in TeamLink', '', '', ''], // 2 duplicate of an existing follow-up
    ['05-10-2026', r2a.u.name, cT2.phone, '', 'Recruiter of another team', '', '', ''], // 3 recruiter not in your team
    ['05-10-2026', r1a.u.name, '9000000001', '', 'Nobody has this phone', '', '', ''], // 4 candidate not found
    ['05-10-2026', r1a.u.name, cT2.phone, '', 'Candidate of TL2\'s team', '', '', ''], // 5 candidate not in your team
    ['05-10-2026', r1a.u.name, cNone.phone, '', 'Candidate with no application', '', '', ''], // 6 not in your team's work
    ['abc', r1a.u.name, c1.phone, '', 'Bad date', '', '', ''], // 7 bad date
    ['01-01-2099', r1a.u.name, c1.phone, '', 'Future date', '', '', ''], // 8 future
    ['05-10-2026', r1a.u.name, c1.phone, '', '', '', '', ''], // 9 empty note
    ['05-10-2026', r1a.u.name, c1.phone, '', 'Twice in the file', '', '', ''], // 10 first
    ['05-10-2026', r1a.u.name, c1.email, '', '  twice IN the file ', '', '', ''], // 11 duplicate inside the file (same candidate, recruiter, date, text)
    ['05-10-2026', 'Nobody Such Recruiter', c1.phone, '', 'Unknown recruiter', '', '', ''], // 12
    ['05-10-2026', r1a.u.name, c1.phone, '', 'Bad done', '', '', 'maybe'], // 13
    ['05-10-2026', r1a.u.name, c1.phone, '', 'Call back before the date', '01-10-2026', '', ''], // 14
    ['05-10-2026', r1a.u.name, c1.phone, 'FUI-NOPE', 'Requirement not his', '', '', ''], // 15
    ['05-10-2026', '', c1.phone, '', 'No recruiter', '', '', ''], // 16
  ];
  const pr = await upload(T.tl1, xlsxOf(R));
  const rr = byRow(pr);
  const reason = (r) => (rr[r] ? `${rr[r].status}: ${rr[r].reason}` : 'missing');
  check('refused: duplicate of an existing follow-up (same candidate, recruiter, date, text)', /refused: Already in TeamLink/.test(reason(2)), reason(2));
  check('refused: recruiter not in your team', /refused: .*not in your team$/.test(reason(3)), reason(3));
  check('refused: candidate not found', reason(4) === 'refused: Candidate not found', reason(4));
  check('refused: a candidate of another team is not in your team\'s work', /refused: This candidate is not in your team/.test(reason(5)), reason(5));
  check('refused: a candidate with no application', /refused: This candidate is not in your team/.test(reason(6)), reason(6));
  check('refused: bad date', /refused: Bad date/.test(reason(7)), reason(7));
  check('refused: future date', /refused: The date 01-01-2099 is in the future/.test(reason(8)), reason(8));
  check('refused: empty "What happened"', /refused: "What happened" is empty/.test(reason(9)), reason(9));
  check('the first of two equal rows is Ready; the second is refused as a duplicate inside the file', rr[10].status === 'ready' && /refused: Same as row 10 of this file/.test(reason(11)), [reason(10), reason(11)]);
  check('refused: an unknown recruiter, a bad Done, a call-back before the date, a requirement the candidate is not on, no recruiter', /not found/.test(reason(12)) && /Done/.test(reason(13)) && /call-back day is before/.test(reason(14)) && /no application on "FUI-NOPE"/.test(reason(15)) && /No recruiter given/.test(reason(16)), [12, 13, 14, 15, 16].map(reason));
  check('the counts: Ready / Needs a choice / Refused add up', pr.body.totals.rows === 15 && pr.body.totals.ready === 1 && pr.body.totals.refused === 14 && pr.body.totals.choice === 0, pr.body.totals);

  // ================= choices
  const C = [HEAD,
    ['06-10-2026', r1a.u.name, twinName, '', 'Twin by name', '', '', ''], // 2 two candidates of this name -> choose
    ['06-10-2026', r1a.u.name, c3.phone, '', 'Two applications of R1a', '', '', ''], // 3 two applications owned by R1a -> choose
    ['06-10-2026', r1a.u.name, c3.phone, reqA2.reqCode, 'Requirement given picks one', '', '', ''], // 4 the requirement picks
    ['06-10-2026', r1b.u.name, c2.phone, '', 'R1b owns one of the two', '', '', ''], // 5 the recruiter's own application
    ['06-10-2026', tl1.u.name, c2.phone, '', 'TL owns none: the latest', '', '', ''], // 6 the latest application
  ];
  const pc = await upload(T.tl1, xlsxOf(C));
  const cr = byRow(pc);
  check('two candidates with the same name: Needs a choice, both listed', cr[2].status === 'choice' && cr[2].choice.kind === 'application' && cr[2].choice.options.length === 2 && cr[2].choice.options.map((o) => o.id).sort().join() === [atw1.id, atw2.id].sort().join(), cr[2]);
  check('a candidate with two applications of that recruiter: Needs a choice', cr[3].status === 'choice' && cr[3].choice.options.length === 2, cr[3]);
  check('the requirement given picks the application', cr[4].status === 'ready' && cr[4].application.id === a3b.id, cr[4]);
  check('no requirement: the application owned by that recruiter', cr[5].status === 'ready' && cr[5].application.id === a2b.id, cr[5]);
  check('no requirement, the recruiter owns none: the candidate\'s latest application', cr[6].status === 'ready' && cr[6].application.id === a2b.id, cr[6]);
  const ch = await call('POST', '/followup-report/import/check', { batchId: pc.body.batchId, choices: { 2: atw2.id, 3: a3a.id } }, T.tl1);
  check('choices made: both rows are Ready on the chosen applications', ch.status === 200 && byRow(ch)[2].status === 'ready' && byRow(ch)[2].application.id === atw2.id && byRow(ch)[3].application.id === a3a.id && ch.body.totals.ready === 5, ch.body.totals);
  check('a choice that is not one of the options is ignored (still Needs a choice)', byRow(await call('POST', '/followup-report/import/check', { batchId: pc.body.batchId, choices: { 2: a5.id } }, T.tl1))[2].status === 'choice');
  check('somebody else cannot read or apply this preview (403)', (await call('POST', '/followup-report/import/check', { batchId: pc.body.batchId }, T.tl2)).status === 403 && (await call('POST', '/followup-report/import/apply', { batchId: pc.body.batchId }, T.tl2)).status === 403);

  // ================= scope
  const rec = await upload(T.r1a, xlsxOf([HEAD,
    ['07-10-2026', '', c1.phone, '', 'Recruiter own row, recruiter left empty', '', '', ''],
    ['07-10-2026', r1a.u.name, c1.phone, '', 'Recruiter own row, named', '', '', ''],
    ['07-10-2026', r1b.u.name, c5.phone, '', 'Somebody else\'s row', '', '', ''],
    ['07-10-2026', r1a.u.name, c5.phone, '', 'A candidate of R1b', '', '', ''],
    ['07-10-2026', r1a.u.name, cT2.phone, '', 'A candidate of another team', '', '', ''],
  ]));
  const rcr = byRow(rec);
  check('recruiter: their own rows are Ready (an empty Recruiter = themselves)', rec.status === 200 && rcr[2].status === 'ready' && rcr[2].recruiter.id === r1a.u.id && rcr[3].status === 'ready', [rcr[2], rcr[3]].map((x) => x && `${x.status} ${x.reason}`));
  check('recruiter: a row of another recruiter is refused ("only your own")', rcr[4].status === 'refused' && /only your own/.test(rcr[4].reason), rcr[4]);
  check('recruiter: a candidate of another recruiter / another team is refused ("not yours")', rcr[5].status === 'refused' && /not yours/.test(rcr[5].reason) && rcr[6].status === 'refused' && /not yours/.test(rcr[6].reason), [rcr[5].reason, rcr[6].reason]);
  const recNoCol = await upload(T.r1a, xlsxOf([['Date', 'Candidate', 'What happened'], ['07-10-2026', c1.phone, 'No recruiter column at all']]));
  check('recruiter: a sheet with no Recruiter column is fine (all rows are theirs)', recNoCol.status === 200 && recNoCol.body.ok && byRow(recNoCol)[2].status === 'ready');
  const tlNoCol = await upload(T.tl1, xlsxOf([['Date', 'Candidate', 'What happened'], ['07-10-2026', c1.phone, 'No recruiter column']]));
  check('TL: a sheet without a Recruiter column asks which column it is', tlNoCol.status === 200 && tlNoCol.body.ok === false && tlNoCol.body.missing.includes('Recruiter'));
  const tl2p = await upload(T.tl2, xlsxOf([HEAD, ['05-10-2026', r1a.u.name, c1.phone, '', 'TL2 for TL1\'s recruiter', '', '', ''], ['05-10-2026', r2a.u.name, c1.phone, '', 'TL2\'s recruiter, TL1\'s candidate', '', '', ''], ['05-10-2026', r2a.u.name, cT2.phone, '', 'TL2 own team', '', '', '']]));
  const t2r = byRow(tl2p);
  check('TL2 cannot import for TL1\'s recruiter, nor for a candidate of TL1\'s team; their own row is Ready', /not in your team$/.test(t2r[2].reason) && /not in your team/.test(t2r[3].reason) && t2r[4].status === 'ready', [t2r[2].reason, t2r[3].reason, t2r[4].status]);
  const stlp = await upload(T.stl, xlsxOf([HEAD, ['05-10-2026', r2a.u.name, cT2.phone, '', 'STL for a recruiter under one of their TLs', '', '', '']]));
  check('STL: a recruiter of their TLs\' teams is Ready', stlp.status === 200 && byRow(stlp)[2].status === 'ready', byRow(stlp)[2]);
  const mgp = await upload(T.mgr, xlsxOf([HEAD, ['05-10-2026', r2a.u.name, cT2.phone, '', 'Manager for anybody', '', '', ''], ['05-10-2026', r1b.u.name, c5.phone, '', 'Manager again', '', '', '']]));
  check('Manager: any team', mgp.status === 200 && mgp.body.totals.ready === 2, mgp.body.totals);
  check('BDE: refused (403)', (await upload(T.bde, xlsxOf([HEAD, ['05-10-2026', bde.u.name, c1.phone, '', 'BDE', '', '', '']]))).status === 403);
  check('HR: refused (403); no login: 401', (await upload(T.hr, xlsxOf([HEAD]))).status === 403 && (await fetch(`${API}/followup-report/import/preview`, { method: 'POST' })).status === 401);
  const cl = await prisma.user.findFirst({ where: { role: 'CLIENT', status: 'Active' } });
  if (cl) check('a client login is refused', [401, 403].includes((await upload(await tok(cl.id), xlsxOf([HEAD]))).status));

  // ================= limits
  const big = [HEAD, ...Array.from({ length: 5001 }, (_, i) => ['05-10-2026', r1a.u.name, c1.phone, '', `Row ${i}`, '', '', ''])];
  const pb = await upload(T.tl1, xlsxOf(big));
  check('more than 5,000 rows: refused with the reason', pb.status === 400 && /5,000/.test(pb.body.error), pb.body);
  const huge = Buffer.concat([Buffer.from('Date,Recruiter,Candidate,What happened\n'), Buffer.alloc(5 * 1024 * 1024 + 100, 'a')]);
  const ph = await upload(T.tl1, huge, 'big.csv');
  check('a file over 5 MB: refused (413)', ph.status === 413, ph.status);
  const pdf = await upload(T.tl1, Buffer.from('%PDF-1.4 nothing'), 'a.pdf');
  check('a PDF: refused with a plain reason', pdf.status === 400 && /PDF/.test(pdf.body.error));

  // ================= apply -> the report counts the rows on the sheet date
  const DAY = '2026-10-06';
  const sumOf = async (qs = '') => (await call('GET', `/followup-report/summary?from=${DAY}&to=${DAY}&period=day${qs}`, null, T.tl1)).body;
  const M = (s, u) => { const row = (s.rows || []).find((x) => x.id === u.u.id); return row ? { added: row.m[0], done: row.m[1], interested: row.m[8], noAnswer: row.m[10] } : { added: 0, done: 0, interested: 0, noAnswer: 0 }; };
  const before = await sumOf();
  const beforeX = await sumOf('&imported=exclude');
  const A = [HEAD,
    ['06-10-2026', r1a.u.name, c1.phone, '', 'Imported one: interested, done', '', 'Interested', 'yes'],
    ['06-10-2026', r1a.u.name, c3.phone, reqA.reqCode, 'Imported two: no answer, open with a call-back', '20-10-2026', 'No answer', 'no'],
    ['06-10-2026', r1b.u.name, c5.phone, '', 'Imported three: R1b', '', '', ''],
    ['06-10-2026', r1a.u.name, twinName, '', 'Imported four: chosen twin', '', '', 'yes'],
    ['06-10-2026', r2a.u.name, cT2.phone, '', 'Refused: another team', '', '', ''],
  ];
  const pa = await upload(T.tl1, xlsxOf(A), 'old-sheet.xlsx');
  check('preview before apply: 3 Ready, 1 Needs a choice, 1 Refused', pa.body.totals.ready === 3 && pa.body.totals.choice === 1 && pa.body.totals.refused === 1, pa.body.totals);
  const countFu = () => prisma.applicationFollowUp.count({ where: { createdByName: { startsWith: 'Imported - follow-up sheet' } } });
  const n0 = await countFu();
  check('a preview writes nothing', n0 === 0, n0);
  const ap = await call('POST', '/followup-report/import/apply', { batchId: pa.body.batchId, choices: { 5: atw1.id } }, T.tl1);
  check('apply: 4 follow-ups created (3 Ready + the chosen one), the refused one skipped', ap.status === 200 && ap.body.created === 4 && ap.body.skipped.length === 1, ap.body);
  const made = await prisma.applicationFollowUp.findMany({ where: { createdByName: { startsWith: 'Imported - follow-up sheet' } } });
  const one = made.find((f) => /Imported one/.test(f.notes)); const two = made.find((f) => /Imported two/.test(f.notes));
  check('the rows carry the imported marker: no createdById, "Imported - follow-up sheet (TL name)"', made.length === 4 && made.every((f) => !f.createdById && f.createdByName === `Imported - follow-up sheet (${tl1.u.name})`), made.map((f) => f.createdByName));
  check('owner = the recruiter; createdAt = the sheet date at 12:00 IST; completedAt when Done = yes', one.ownerUserId === r1a.u.id && one.createdAt.toISOString() === '2026-10-06T06:30:00.000Z' && one.completedAt && one.completedAt.toISOString() === '2026-10-06T06:30:00.000Z' && one.completedById === r1a.u.id && one.outcome === 'Interested' && one.applicationId === a1.id, one);
  check('Done = no: open, with the call-back as its due date; the requirement picked the application', !two.completedAt && two.dueDate === '2026-10-20' && two.applicationId === a3a.id && two.outcome === 'No answer', two);
  const after = await sumOf();
  const d = (k, u) => M(after, u)[k] - M(before, u)[k];
  check('the report counts them on the sheet date: R1a +3 added, +2 done, +1 interested; R1b +1 added +1 done', d('added', r1a) === 3 && d('done', r1a) === 2 && d('interested', r1a) === 1 && d('added', r1b) === 1 && d('done', r1b) === 1, [M(before, r1a), M(after, r1a), M(before, r1b), M(after, r1b)]);
  const ex = await sumOf('&imported=exclude');
  check('imported = exclude: the numbers are as before the import', JSON.stringify(M(ex, r1a)) === JSON.stringify(M(beforeX, r1a)) && JSON.stringify(M(ex, r1b)) === JSON.stringify(M(beforeX, r1b)), [M(ex, r1a), M(beforeX, r1a)]);
  const on = await sumOf('&imported=only');
  check('imported = only: just the imported ones', M(on, r1a).added === 3 && M(on, r1a).done === 2 && M(on, r1b).added === 1, M(on, r1a));
  const lst = await call('GET', `/followup-report/list?from=${DAY}&to=${DAY}&imported=only&personId=${r1a.u.id}`, null, T.tl1);
  check('the list shows them flagged Imported, dated the sheet date, with what happened', lst.status === 200 && lst.body.rows.length === 3 && lst.body.rows.every((x) => x.imported && x.day === DAY) && lst.body.rows.some((x) => /Imported one/.test(x.what)), lst.body.rows);
  const lstX = await call('GET', `/followup-report/list?from=${DAY}&to=${DAY}&imported=exclude&personId=${r1a.u.id}`, null, T.tl1);
  check('the list with imported = exclude has none of them', lstX.body.rows.every((x) => !x.imported));
  check('apply twice: refused (409)', (await call('POST', '/followup-report/import/apply', { batchId: pa.body.batchId }, T.tl1)).status === 409);
  const again = await upload(T.tl1, xlsxOf(A));
  check('the same sheet again: the imported rows are now duplicates of follow-ups already in TeamLink', byRow(again)[2].status === 'refused' && /Already in TeamLink/.test(byRow(again)[2].reason) && again.body.totals.ready === 0, again.body.totals);
  const audit = await prisma.auditLog.findFirst({ where: { entity: 'FollowUpImport', entityId: pa.body.batchId, action: { startsWith: 'Follow-ups imported' } } });
  check('the import is in the audit log', !!audit && audit.userId === tl1.u.id, audit);

  // ================= the recent imports and undo
  const bl = await call('GET', '/followup-report/import/batches', null, T.tl1);
  check('recent imports: the batch with who, file and how many, with Undo', bl.status === 200 && bl.body.batches[0].id === pa.body.batchId && bl.body.batches[0].created === 4 && bl.body.batches[0].fileName === 'old-sheet.xlsx' && bl.body.batches[0].canUndo, bl.body.batches[0]);
  check('another TL does not see it in their list and cannot undo it (403)', !(await call('GET', '/followup-report/import/batches', null, T.tl2)).body.batches.some((b) => b.id === pa.body.batchId) && (await call('POST', `/followup-report/import/batches/${pa.body.batchId}/undo`, null, T.tl2)).status === 403);
  check('a Manager cannot undo somebody else\'s import (only the importer or an Admin)', (await call('POST', `/followup-report/import/batches/${pa.body.batchId}/undo`, null, T.mgr)).status === 403);
  check('an Admin sees every import', (await call('GET', '/followup-report/import/batches', null, T.admin)).body.batches.some((b) => b.id === pa.body.batchId && b.canUndo));
  // a row edited since the import is kept
  const four = made.find((f) => /Imported four/.test(f.notes));
  await prisma.applicationFollowUp.update({ where: { id: four.id }, data: { notes: 'Imported four: edited by the recruiter afterwards' } });
  const other = await prisma.applicationFollowUp.count();
  const un = await call('POST', `/followup-report/import/batches/${pa.body.batchId}/undo`, null, T.tl1);
  check('undo: 3 removed, the 1 edited since kept, with its row number', un.status === 200 && un.body.removed === 3 && un.body.kept === 1 && un.body.keptRows.join() === '5', un.body);
  const left = await prisma.applicationFollowUp.findMany({ where: { createdByName: { startsWith: 'Imported - follow-up sheet' } } });
  check('undo removed exactly the batch: only the edited one is left, nothing else was touched', left.length === 1 && left[0].id === four.id && (await prisma.applicationFollowUp.count()) === other - 3, [left.length, other]);
  const back = await sumOf();
  check('the report after undo: R1b as before; R1a as before plus the kept one', JSON.stringify(M(back, r1b)) === JSON.stringify(M(before, r1b)) && M(back, r1a).added === M(before, r1a).added + 1, [M(back, r1a), M(before, r1a)]);
  check('undo twice: refused (409)', (await call('POST', `/followup-report/import/batches/${pa.body.batchId}/undo`, null, T.tl1)).status === 409);
  check('the undo is in the audit log', !!(await prisma.auditLog.findFirst({ where: { entity: 'FollowUpImport', entityId: pa.body.batchId, action: { startsWith: 'Follow-up import undone' } } })));
  // an Admin undoes a recruiter's own import
  const rp = await upload(T.r1a, xlsxOf([HEAD, ['08-10-2026', '', c1.phone, '', 'Recruiter imports their own', '', '', '']]));
  const ra = await call('POST', '/followup-report/import/apply', { batchId: rp.body.batchId }, T.r1a);
  check('a recruiter applies their own import', ra.status === 200 && ra.body.created === 1, ra.body);
  const myList = await call('GET', '/followup-report/import/batches', null, T.r1a);
  check('the recruiter sees only their own imports', myList.body.batches.length === 1 && myList.body.batches[0].id === rp.body.batchId);
  const au = await call('POST', `/followup-report/import/batches/${rp.body.batchId}/undo`, null, T.admin);
  check('an Admin can undo somebody else\'s import', au.status === 200 && au.body.removed === 1, au.body);
  const bl2 = await call('GET', '/followup-report/import/batches', null, T.r1a);
  check('the recent list says it was undone, by whom, with no Undo button', bl2.body.batches[0].status === 'UNDONE' && !bl2.body.batches[0].canUndo && bl2.body.batches[0].undoneByName === adminRow.name, bl2.body.batches[0]);
  check('BDE: the recent imports and undo are refused (403)', (await call('GET', '/followup-report/import/batches', null, T.bde)).status === 403);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
