#!/usr/bin/env node
/**
 * A PERSON WHO DROPPED IS DROPPED, NOT JOINED (founder 2026-11-19: "candidates who dropped are shown in the Dropped list and ALSO again in the
 * Joined list, and are counted under Joined").
 * utils/joinedRule.js: with the Admin switch "Count people who left after joining as Joined" OFF (the default) a person whose Joining & Drop
 * record says Dropped is in NO Joined list and NO Joined number; ON restores the old behaviour; withdrawing the drop brings them back.
 * 3 joined candidates of one recruiter and one client, one dropped: the Joined number is 2 in the dashboard card, the list behind it, the month
 * table, My results, the Joined report, Results vs target, the HRMS "3 of 4", the client history and the Joining screen; the Dropped number is 1.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port TEST_PORT (default 4195).
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> TEST_PORT=4195 node scripts/joined-vs-dropped-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-joinedrule-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4195;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'joinedrule-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const JD = require('../src/joindrop/core');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 700)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Forwarded-For': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const P = process.pid;
const IST = 330 * 60000;
const today = new Date(Date.now() + IST).toISOString().slice(0, 10);
const month = today.slice(0, 7);
const lastDay = (() => { const [y, m] = month.split('-').map(Number); return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; })();
const sorted = (a) => [...a].sort();
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

(async () => {
  const past = new Date(Date.now() - 3600e3);
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const mkUser = (tag, atsRole, role) => prisma.user.create({
    data: {
      name: `Jvd ${tag} ${P}`, email: `jvd.${tag.toLowerCase()}.${P}@jvd-test.in`, passwordHash: 'x', status: 'Active', role, atsRole, atsDepartment: 'IT', atsAccess: true, passwordChangedAt: past,
      ...(atsRole === 'TL' ? { atsScopeDepartments: 'IT' } : {}),
    },
  });
  const R1 = await mkUser('Alpha', 'RECRUITER', 'EMPLOYEE');
  const TL = await mkUser('Lead', 'TL', 'TL');
  const mkEmp = (u, code) => prisma.employee.create({ data: { employeeCode: `JVD-${code}-${P}`, name: u.name, userId: u.id, department: 'IT', employmentStatus: 'Active', dateOfJoining: new Date('2020-01-01T00:00:00Z') } });
  const [E1, ET] = [await mkEmp(R1, 'R1'), await mkEmp(TL, 'TL')];
  const tlSeat = await prisma.position.create({ data: { code: `JVD-TL-${P}`, kind: 'TL', department: 'IT', team: `Jvd team ${P}` } });
  const s1 = await prisma.position.create({ data: { code: `JVD-R1-${P}`, kind: 'RECRUITER', department: 'IT', team: `Jvd team ${P}`, reportsToId: tlSeat.id } });
  for (const [pos, e] of [[tlSeat, ET], [s1, E1]]) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.positionAssignment.create({ data: { positionId: pos.id, employeeId: e.id, fromDate: '2025-01-01' } });
  }
  const client = await prisma.client.findFirst({ where: { NOT: { name: { contains: 'zztest' } } }, select: { id: true } });
  const J1 = await prisma.requirement.create({ data: { title: `Jvd job ${P}`, clientId: client.id, status: 'OPEN', department: 'IT', recruiterId: R1.id, tlId: TL.id } });
  let n = 0;
  const mkApp = async () => {
    n += 1;
    const c = await prisma.candidate.create({ data: { name: `Jvd Person ${n} ${P}`, phone: `6${String(P * 10 + n).padStart(9, '5').slice(-9)}` } });
    const a = await prisma.application.create({ data: { candidateId: c.id, requirementId: J1.id, stage: 'JOINED', joiningDate: today, joinedAt: new Date(), offeredCtc: 300000 } });
    await prisma.applicationFollowUp.create({ data: { applicationId: a.id, candidateId: c.id, ownerUserId: R1.id, ownerName: R1.name, ownerRole: 'Recruiter', nextAction: 'Joining formalities', dueDate: today } });
    return { a, c };
  };
  const people = [await mkApp(), await mkApp(), await mkApp()];
  const all3 = people.map((x) => x.a.id);
  const dropper = people[0];
  await JD.ready();
  for (const x of people) {
    // eslint-disable-next-line no-await-in-loop
    await JD.recordJoined({ applicationId: x.a.id, backfill: true, quiet: true });
  }
  const recOf = async (appId) => JD.byApplication(appId);
  // an invoice raised for the person who will drop: it must stay exactly as it is
  const inv = await prisma.invoice.create({ data: { clientId: client.id, candidateId: dropper.c.id, requirementId: J1.id, amount: 24000, gst: 4320, status: 'Pending', invoiceDate: today, joiningDate: today, invoiceNumber: `JVD-${P}` } });

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const TA = await tok(adminRow.id); const T1 = await tok(R1.id); const TT = await tok(TL.id);

  const meta = await call('GET', '/join-drop/meta', null, TA);
  const reason = meta.body && meta.body.reasons && meta.body.reasons[0];

  // everything the screens say, for one person's scope, in one object
  async function read() {
    const out = {};
    const h1 = await call('GET', '/dashboard/ats/home?fresh=1', null, T1);
    const card1 = (h1.body.widgets || []).find((x) => x.id === 'target');
    out.r1Card = card1 ? card1.value : null; out.r1Left = card1 && card1.left ? card1.left.n : 0; out.r1CardStill = card1 && card1.stillWorking;
    const l1 = await call('GET', '/dashboard/ats/home/list?set=my-joins&d_size=200', null, T1);
    out.r1List = l1.body && l1.body.rows ? l1.body.rows.map((r) => r.id) : [];
    out.r1ListHead = l1.body && l1.body.left ? l1.body.left : null;
    const lf = await call('GET', '/dashboard/ats/home/list?set=my-joins-left&d_size=200', null, T1);
    out.r1LeftList = lf.body && lf.body.rows ? lf.body.rows.map((r) => r.id) : [];
    const hT = await call('GET', '/dashboard/ats/home?fresh=1', null, TT);
    const cardT = (hT.body.top || []).find((x) => x.id === 'my-joins');
    out.tlCard = cardT ? cardT.value : null; out.tlLeft = cardT && cardT.left ? cardT.left.n : 0;
    const lT = await call('GET', '/dashboard/ats/home/list?set=my-joins&d_size=200', null, TT);
    out.tlList = lT.body && lT.body.rows ? lT.body.rows.map((r) => r.id) : [];
    // the company board (Super Admin): the Joined tile, its list, the month table
    const hA = await call('GET', '/dashboard/ats/home?fresh=1&range=this_month', null, TA);
    const tiles = [...(hA.body.top || [])];
    const jt = tiles.find((x) => x.id === 'joined');
    out.adminJoined = jt ? jt.value : null; out.adminLeft = jt && jt.left ? jt.left.n : 0;
    const lA = await call('GET', '/dashboard/ats/home/list?set=joined&d_size=200&range=this_month', null, TA);
    out.adminJoinedList = lA.body && lA.body.rows ? lA.body.rows.map((r) => r.id) : [];
    const widgetsA = [...(hA.body.widgets || []), ...(hA.body.more || []), ...(hA.body.extras || [])];
    const months = widgetsA.find((w) => w.id === 'drops-months');
    const mrow = months && (months.rows || []).find((r) => r.month === month);
    out.monthJoined = mrow ? mrow.joined.n : null; out.monthLeft = mrow ? mrow.left.n : null;
    const dl = await call('GET', '/dashboard/ats/home/list?set=drop-left&d_size=200&range=this_month', null, TA);
    out.adminDropLeftList = dl.body && dl.body.rows ? dl.body.rows.map((r) => r.id) : [];
    // reports
    const my = await call('GET', `/ats-reports/my-results?from=${month}-01&to=${lastDay}`, null, T1);
    out.myResults = my.status === 200 ? ((my.body.cards || []).find((c) => c.key === 'joined') || {}).value : `status ${my.status}`;
    const dly = await call('GET', `/ats-report-pack/report?report=joined&range=custom&from=${month}-01&to=${lastDay}`, null, T1);
    const dcol = dly.body && dly.body.columns ? dly.body.columns.length - 1 : -1;
    out.daily = dcol >= 0 && dly.body.total ? dly.body.total[dcol] : `status ${dly.status}`;
    const sum = await call('GET', '/ats-report-pack/report?report=summary&range=this_month', null, T1);
    const scol = sum.body && sum.body.columns ? sum.body.columns.findIndex((c) => c.key === 'joined') : -1;
    out.summary = scol >= 0 && sum.body.total ? sum.body.total[scol] : `status ${sum.status}`;
    const tg = await call('GET', '/ats-reports/targets', null, TA);
    const sec = tg.body && (tg.body.sections || []).find((s) => s.id === 'targets' || s.key === 'targets');
    const colKeys = sec ? (sec.columns || []).map((c) => c.key) : [];
    const rowsArr = sec ? (Array.isArray(sec.rows) ? sec.rows : Object.values(sec.rows || {})) : [];
    const mine = rowsArr.find((r) => (r.key || r.id) === `u:${R1.id}`);
    const cell = mine ? (Array.isArray(mine.c) ? mine.c[colKeys.indexOf('joined')] : (mine.cells ? mine.cells.joined : null)) : null;
    out.targets = cell && typeof cell === 'object' ? (cell.n ?? cell.value ?? (Array.isArray(cell.ids) ? cell.ids.length : null)) : cell;
    const hr = await call('GET', '/recruiter-joinings/mine', null, T1);
    out.hrms = hr.status === 200 ? hr.body.achieved : `status ${hr.status}`;
    // the client history and the Joining & Drop list
    const ch = await call('GET', `/join-drop/client-history/${client.id}`, null, TA);
    out.clientJoined = ch.body && ch.body.summary ? ch.body.summary.joined : null; out.clientDropped = ch.body && ch.body.summary ? ch.body.summary.dropped : null;
    const ev = ch.body && ch.body.events ? ch.body.events.filter((e) => e.group === 'Joining' && new RegExp(`Jvd Person 1 ${P}`).test(e.title)) : [];
    out.clientJoinEventForDropper = ev.length;
    const jl = await call('GET', '/join-drop/list?pageSize=200', null, TA);
    out.listJoined = jl.body && jl.body.counts ? jl.body.counts.Joined : null; out.listDropped = jl.body && jl.body.counts ? jl.body.counts.Dropped : null;
    const jr = await call('GET', '/join-drop/report', null, TA);
    out.reportJoined = jr.body && jr.body.totals ? jr.body.totals.joined : null; out.reportDropped = jr.body && jr.body.totals ? jr.body.totals.dropped : null;
    // the Joining screen's tabs
    const js = await call('GET', '/ats/joining?view=joined&page=1&pageSize=200&window=all', null, TA);
    out.joiningCounts = js.body && js.body.counts ? js.body.counts : null;
    out.joiningRows = js.body && js.body.rows ? js.body.rows.map((r) => r.id) : [];
    return out;
  }

  const base0 = await read(); // everything counted with all three still working
  check('0 the recruiter\'s card, list, HRMS figure and My results all say 3 before any drop', base0.r1Card === 3 && base0.r1List.length === 3 && same(base0.r1List, all3) && base0.hrms === 3 && base0.myResults === 3 && base0.daily === 3, base0);
  check('0b the TL sees the same 3 for the team', base0.tlCard === 3 && base0.tlList.length === 3, { card: base0.tlCard, list: base0.tlList });
  check('0c the card carries no "left after joining" line while nobody dropped', base0.r1Left === 0 && base0.r1ListHead === null);

  // ---- the drop (switch OFF = the default) ----------------------------------------------------------------------------------------------
  const rec = await recOf(dropper.a.id);
  const d = await call('POST', `/join-drop/${rec.id}/drop`, { droppedOn: today, reason, reasonDetail: 'joined-vs-dropped test' }, TA);
  check('1 the drop is recorded', d.status === 200 && d.body && d.body.ok, d);
  const off = await read();
  check('2 default OFF: the recruiter\'s card says Joined 2', off.r1Card === 2 && off.r1CardStill === 2, { card: off.r1Card, still: off.r1CardStill });
  check('3 the list behind the card has the same 2 people (the dropped one is not in it)', same(off.r1List, [people[1].a.id, people[2].a.id]), off.r1List);
  check('4 the card says "1 left after joining (shown under Dropped)" and opens the dropped person', off.r1Left === 1 && same(off.r1LeftList, [dropper.a.id]) && off.r1ListHead && /1 left after joining/.test(off.r1ListHead.text) && off.r1ListHead.drill === 'my-joins-left', { left: off.r1Left, list: off.r1LeftList, head: off.r1ListHead });
  check('5 the TL sees the same 2 for the team, with the same note', off.tlCard === 2 && off.tlList.length === 2 && off.tlLeft === 1, { card: off.tlCard, list: off.tlList, left: off.tlLeft });
  check('6 the company Joined card is one less and its list does not hold the dropped person', off.adminJoined === base0.adminJoined - 1 && !off.adminJoinedList.includes(dropper.a.id) && off.adminLeft >= 1, { before: base0.adminJoined, after: off.adminJoined, left: off.adminLeft });
  check('7 the month table: Joined is one less, "Left after joining" is one more', off.monthJoined === base0.monthJoined - 1 && off.monthLeft === base0.monthLeft + 1, { before: [base0.monthJoined, base0.monthLeft], after: [off.monthJoined, off.monthLeft] });
  check('8 My results Joined = 2', off.myResults === 2, off.myResults);
  check('9 the Daily report / Joined report = 2 and the summary = 2', off.daily === 2 && off.summary === 2, { daily: off.daily, summary: off.summary });
  check('10 Results vs target Joined = 2 for the recruiter', off.targets === 2, off.targets);
  check('11 the HRMS "3 of 4" figure = 2', off.hrms === 2, off.hrms);
  check('12 the client history: Joined is one less, Dropped is one more, no "joined" line for the dropped person', off.clientJoined === base0.clientJoined - 1 && off.clientDropped === base0.clientDropped + 1 && off.clientJoinEventForDropper === 0, { joined: [base0.clientJoined, off.clientJoined], dropped: [base0.clientDropped, off.clientDropped], ev: off.clientJoinEventForDropper });
  check('13 the Dropped views: the dropped list holds the person, the Joined & Dropped list says Dropped +1 and Still working -1', off.adminDropLeftList.includes(dropper.a.id) && off.listDropped === base0.listDropped + 1 && off.listJoined === base0.listJoined - 1, { dl: off.adminDropLeftList.length, list: [base0.listJoined, off.listJoined, base0.listDropped, off.listDropped] });
  check('14 the Joined & Dropped report: Joined one less, Dropped one more', off.reportJoined === base0.reportJoined - 1 && off.reportDropped === base0.reportDropped + 1, { rep: [base0.reportJoined, off.reportJoined, base0.reportDropped, off.reportDropped] });
  check('15 the Joining screen: the dropped person left the Joined tab and moved to "left / did not join"', !off.joiningRows.includes(dropper.a.id) && off.joiningCounts && base0.joiningCounts && off.joiningCounts.joined === base0.joiningCounts.joined - 1 && off.joiningCounts.dropped === base0.joiningCounts.dropped + 1, { before: base0.joiningCounts, after: off.joiningCounts });
  const invAfter = await prisma.invoice.findUnique({ where: { id: inv.id } });
  check('16 the invoice raised for the dropped person is untouched', invAfter && invAfter.status === 'Pending' && invAfter.amount === 24000 && invAfter.gst === 4320 && invAfter.candidateId === dropper.c.id);
  const invList = await call('GET', '/invoices/register?period=all', null, TA);
  const invRows = Array.isArray(invList.body) ? invList.body : (invList.body && (invList.body.rows || invList.body.invoices)) || [];
  const invRow = invRows.find((x) => x.id === inv.id);
  check('17 Accounts still lists that invoice, tagged "Left after joining"', !!invRow && invRow.leftAfterJoining === true, { status: invList.status, found: !!invRow, keys: invRows[0] && Object.keys(invRows[0]).slice(0, 8) });
  const sw = await call('GET', '/join-drop/settings', null, TA);
  check('18 the Admin screen reads the switch as OFF by default', sw.status === 200 && sw.body.settings && sw.body.settings.joinedCountsDropped === false, sw.body && sw.body.settings && sw.body.settings.joinedCountsDropped);
  const swR = await call('PUT', '/join-drop/settings', { joinedCountsDropped: true }, T1);
  check('19 a recruiter cannot change the switch', swR.status === 403, swR.status);

  // ---- switch ON = today's behaviour exactly ----------------------------------------------------------------------------------------------
  const on1 = await call('PUT', '/join-drop/settings', { joinedCountsDropped: true }, TA);
  check('20 an Admin switches it ON', on1.status === 200 && on1.body.settings.joinedCountsDropped === true, on1.body);
  const on = await read();
  check('21 ON: Joined is 3 again in the card, the list, My results, the HRMS figure and the reports', on.r1Card === 3 && same(on.r1List, all3) && on.myResults === 3 && on.hrms === 3 && on.daily === 3 && on.summary === 3 && on.targets === 3, on);
  check('22 ON: the TL sees 3, the company card and the month table are back, the client history Joined is back', on.tlCard === 3 && on.adminJoined === base0.adminJoined && on.monthJoined === base0.monthJoined && on.clientJoined === base0.clientJoined, { tl: on.tlCard, admin: [base0.adminJoined, on.adminJoined], month: [base0.monthJoined, on.monthJoined], client: [base0.clientJoined, on.clientJoined] });
  check('23 ON: the dropped person is STILL in the Dropped lists and numbers', on.adminDropLeftList.includes(dropper.a.id) && on.listDropped === base0.listDropped + 1 && on.clientDropped === base0.clientDropped + 1, { dl: on.adminDropLeftList.includes(dropper.a.id), listDropped: on.listDropped });
  const off2 = await call('PUT', '/join-drop/settings', { joinedCountsDropped: false }, TA);
  check('24 switched OFF again', off2.status === 200 && off2.body.settings.joinedCountsDropped === false);
  const off3 = await read();
  check('25 OFF again: back to 2 everywhere that was checked', off3.r1Card === 2 && off3.myResults === 2 && off3.hrms === 2 && off3.targets === 2 && off3.tlCard === 2 && off3.clientJoined === base0.clientJoined - 1, off3);

  // ---- withdraw the drop ------------------------------------------------------------------------------------------------------------------
  const re = await call('POST', `/join-drop/${rec.id}/reopen`, { reason: 'reported by mistake in the test' }, TA);
  check('26 "Withdraw the drop" works', re.status === 200, re);
  const back = await read();
  check('27 after the withdrawal Joined is 3 everywhere again, with no "left after joining" note', back.r1Card === 3 && same(back.r1List, all3) && back.r1Left === 0 && back.tlCard === 3 && back.myResults === 3 && back.daily === 3 && back.targets === 3 && back.hrms === 3, back);
  check('28 and the company card, month table, client history and Joining tab are as at the start', back.adminJoined === base0.adminJoined && back.monthJoined === base0.monthJoined && back.monthLeft === base0.monthLeft && back.clientJoined === base0.clientJoined && back.clientDropped === base0.clientDropped && back.joiningCounts.joined === base0.joiningCounts.joined, { admin: [base0.adminJoined, back.adminJoined], month: [base0.monthJoined, back.monthJoined], client: [base0.clientJoined, back.clientJoined], j: back.joiningCounts });

  // ---- drops to double-check -------------------------------------------------------------------------------------------------------------
  const extra = [await mkApp(), await mkApp(), await mkApp()];
  for (const x of extra) {
    // eslint-disable-next-line no-await-in-loop
    await JD.recordJoined({ applicationId: x.a.id, backfill: true, quiet: true });
    // eslint-disable-next-line no-await-in-loop
    const r = await recOf(x.a.id);
    // eslint-disable-next-line no-await-in-loop
    const dd = await call('POST', `/join-drop/${r.id}/drop`, { droppedOn: today, reason, reasonDetail: 'same day, same reason' }, TA);
    check(`29 a drop is recorded for the double-check set (${x.a.id.slice(-4)})`, dd.status === 200, dd);
  }
  const ck = await call('GET', '/join-drop/list?check=same&pageSize=200', null, TA);
  const ckIds = ck.body && ck.body.rows ? ck.body.rows.map((r) => r.applicationId) : [];
  check('30 "Same day and same reason (check)" lists the three drops by the same person on the same day, with the group size', extra.every((x) => ckIds.includes(x.a.id)) && ck.body.rows.every((r) => r.doubleCheck && r.doubleCheck.n >= 3) && ck.body.counts.check >= 3, { n: ckIds.length, counts: ck.body && ck.body.counts });
  const ck1 = await call('GET', '/join-drop/list?check=same&pageSize=200', null, T1);
  check('31 a recruiter does not get the check list', ck1.status !== 200 || ((ck1.body.rows || []).length === 0 && ck1.body.counts.check === undefined), { status: ck1.status, n: ck1.body && ck1.body.rows && ck1.body.rows.length });
  const ckT = await call('GET', '/join-drop/list?pageSize=200', null, TT);
  check('32 a TL gets the check chip count', ckT.status === 200 && ckT.body.counts && ckT.body.counts.check !== undefined, ckT.body && ckT.body.counts);
  const before = await recOf(extra[0].a.id);
  const fixed = await call('PATCH', `/join-drop/${before.id}/drop`, { droppedOn: today, reason: before.dropReason, reasonDetail: 'looked at it', correctionReason: 'checked: day and reason are right' }, TA);
  check('33 "Correct the drop details" is the existing PATCH and it works from the list', fixed.status === 200, fixed);
  const ckAfter = await call('GET', '/join-drop/list?check=same&pageSize=200', null, TA);
  check('34 the check list never changes data by itself (the group is still there after a correction of the details)', ckAfter.body.rows.length >= 3);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
