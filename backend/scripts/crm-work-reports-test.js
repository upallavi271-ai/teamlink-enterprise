#!/usr/bin/env node
/**
 * THE CRM'S WORK AND REPORTING SIDE (2026-11-17, crm/analytics.js + the score / round robin changes):
 *   follow-up create + the calendar range + reschedule by a date change (and who may move what), the dashboard charts and the weighted forecast
 *   against numbers worked out here by hand, the report tables, Excel only with the export right + the download log, the Leads list paged and
 *   sorted on the server, the conversation thread in time order with the reply that came in, the lead score up after a reply and down after
 *   silence, and the round robin (website leads and a "+ Lead" with no owner) taking turns.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4092. Nothing is really sent: no message goes out from this test.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/crm-work-reports-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-work-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const dbx = new DatabaseSync(COPY);
dbx.exec('DELETE FROM "AppSetting" WHERE "key" IN (\'crm.settings\', \'crm.website\')');
dbx.close();

const PORT = Number(process.env.TEST_PORT) || 4092;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'crm-work-reports-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const XLSX = require('xlsx');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const DB = require('../src/crm/schema');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ''}`); } };
const call = async (method, url, body, token, { binary } = {}) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const type = r.headers.get('content-type') || '';
  if (binary && !/json/.test(type)) return { status: r.status, type, buf: Buffer.from(await r.arrayBuffer()) };
  let j = null; try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, body: j, type };
};
const tokenOf = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
const mkUser = (tag, data) => prisma.user.create({ data: { name: `ZZ Work ${tag}`, email: `zz.crmwork.${tag}.${process.pid}@example.test`, passwordHash: 'x', status: 'Active', passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
const ymd = (offset) => new Date(Date.now() + 5.5 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
const thisM = ymd(0).slice(0, 7);
const addM = (ym, n) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };
const monthStart = new Date(Date.UTC(Number(thisM.slice(0, 4)), Number(thisM.slice(5, 7)) - 1, 1) - 5.5 * 3600000).toISOString();
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;
const phone = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}

(async () => {
  await DB.ensure();
  const A = await mkUser('repA', { role: 'EMPLOYEE' });
  const B = await mkUser('repB', { role: 'EMPLOYEE' });
  const M = await mkUser('mgr', { role: 'EMPLOYEE' });
  const X = await mkUser('admin', { role: 'SUPER_ADMIN' });
  const tk = { A: await tokenOf(A.id), B: await tokenOf(B.id), M: await tokenOf(M.id), X: await tokenOf(X.id) };
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 240; i += 1) { if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break; await new Promise((r) => { setTimeout(r, 1000); }); } // eslint-disable-line no-await-in-loop
  await new Promise((r) => { setTimeout(r, 1000); });

  const own = { create: true, edit: true, delete: false, import: false, export: false, reports: false };
  const put = await call('PUT', '/crm/settings', { salesTeam: [
    { userId: A.id, name: A.name, role: 'rep', rights: own }, { userId: B.id, name: B.name, role: 'rep', rights: own }, { userId: M.id, name: M.name, role: 'manager' },
  ] }, tk.X);
  check('setup: two Salespeople (no export, no reports) and a Sales manager', put.status === 200, put.body);
  const me = (await call('GET', '/crm/me', null, tk.A)).body;
  check('setup: A opens the CRM as a Salesperson without the export right', me && me.role === 'bde' && me.rights.export === false, me && [me.role, me.rights]);
  const prob = me.lists.stageProbability;

  console.log('1. "+ Follow-up", the calendar and moving one by its date');
  const L1 = (await call('POST', '/crm/leads', { company: `ZZ Work One ${process.pid}`, contactName: 'Asha', phone: phone(), source: 'LinkedIn' }, tk.A)).body.lead;
  const L2 = (await call('POST', '/crm/leads', { company: `ZZ Work Two ${process.pid}`, contactName: 'Bala', phone: phone(), source: 'LinkedIn' }, tk.A)).body.lead;
  const L3 = (await call('POST', '/crm/leads', { company: `ZZ Work Three ${process.pid}`, contactName: 'Chitra', phone: phone(), source: 'Referral' }, tk.A)).body.lead;
  check('A adds three leads', L1 && L2 && L3 && L1.ownerId === A.id, [L1, L2, L3].map((l) => l && l.id));
  const fu = await call('POST', '/crm/tasks', { title: 'Demo meeting', leadId: L1.id, dueDate: ymd(2), dueTime: '10:30', type: 'Meeting', priority: 'High', remindBefore: 60 }, tk.A);
  check('a follow-up is added for a picked lead with title, type, date, time, priority and reminder', fu.status === 200 && fu.body.task.type === 'Meeting' && fu.body.task.priority === 'High' && fu.body.task.remindBefore === 60 && fu.body.task.dueTime === '10:30', fu.body);
  const T = fu.body.task;
  const cal = await call('GET', `/crm/tasks/calendar?from=${ymd(0)}&to=${ymd(6)}`, null, tk.A);
  const onCal = cal.body && cal.body.tasks.find((t) => t.id === T.id);
  check('the calendar range holds it on its day, with its record and type', cal.status === 200 && onCal && onCal.dueDate === ymd(2) && onCal.recordKind === 'lead' && onCal.recordId === L1.id && onCal.type === 'Meeting', cal.body && cal.body.tasks.length);
  check('A may drag it (canMove), and it is not late', onCal && onCal.canMove === true && onCal.late === false, onCal);
  check('nothing outside the range comes', cal.body.tasks.every((t) => t.dueDate >= ymd(0) && t.dueDate <= ymd(6)));
  const calB = await call('GET', `/crm/tasks/calendar?from=${ymd(0)}&to=${ymd(6)}`, null, tk.B);
  check('Salesperson B does not see A\'s follow-up on the calendar', calB.status === 200 && !calB.body.tasks.some((t) => t.id === T.id));
  const calX = await call('GET', `/crm/tasks/calendar?from=${ymd(0)}&to=${ymd(6)}&owner=${A.id}`, null, tk.X);
  check('the Admin sees it (owner filter) and may move it too', calX.body.tasks.some((t) => t.id === T.id && t.canMove));
  check('a range of more than two months is refused', (await call('GET', `/crm/tasks/calendar?from=${ymd(0)}&to=${ymd(90)}`, null, tk.A)).status === 400);
  check('B cannot move A\'s follow-up', (await call('POST', `/crm/tasks/${T.id}/snooze`, { dueDate: ymd(4) }, tk.B)).status === 404);
  check('a drop on a past day is refused', (await call('POST', `/crm/tasks/${T.id}/snooze`, { dueDate: ymd(-1) }, tk.A)).status === 400);
  const mv = await call('POST', `/crm/tasks/${T.id}/snooze`, { dueDate: ymd(4) }, tk.A);
  check('dropped on another day: the date changes and the time stays', mv.status === 200 && mv.body.task.dueDate === ymd(4) && mv.body.task.dueTime === '10:30', mv.body);
  const cal2 = await call('GET', `/crm/tasks/calendar?from=${ymd(0)}&to=${ymd(6)}`, null, tk.A);
  check('the calendar shows it on the new day', cal2.body.tasks.find((t) => t.id === T.id).dueDate === ymd(4));
  const mvT = await call('POST', `/crm/tasks/${T.id}/snooze`, { dueDate: ymd(5), dueTime: '15:00' }, tk.A);
  check('dropped on a day and hour in the week view: both change', mvT.body.task.dueDate === ymd(5) && mvT.body.task.dueTime === '15:00', mvT.body.task);
  await DB.run('UPDATE "CrmTask" SET "dueDate" = ? WHERE "id" = ?', ymd(-2), (await call('POST', '/crm/tasks', { title: 'Late one', leadId: L2.id, dueDate: ymd(0) }, tk.A)).body.task.id);
  const cal3 = await call('GET', `/crm/tasks/calendar?from=${ymd(-3)}&to=${ymd(0)}`, null, tk.A);
  check('a late open follow-up is marked late (red)', cal3.body.tasks.some((t) => t.title === 'Late one' && t.late === true));

  console.log('2. Records for the charts and reports (all Salesperson A\'s)');
  await call('POST', '/crm/activities', { kind: 'call', leadId: L1.id, subject: 'Intro call', outcome: 'Spoke' }, tk.A);
  await call('POST', '/crm/activities', { kind: 'meeting', leadId: L2.id, subject: 'Met them', outcome: 'Meeting held' }, tk.A);
  const conv = await call('POST', `/crm/leads/${L3.id}/convert`, { createDeal: true }, tk.A);
  check('L1 Contacted, L2 Qualified, L3 converted', conv.status === 200 && (await call('GET', `/crm/leads/${L2.id}`, null, tk.A)).body.lead.status === 'Qualified' && (await call('GET', `/crm/leads/${L1.id}`, null, tk.A)).body.lead.status === 'Contacted', conv.body);
  const acc = conv.body.account;
  const mkDeal = async (title, value, stage, expectedClose) => (await call('POST', '/crm/deals', { title: `${title} ${process.pid}`, accountId: acc.id, value, stage, expectedClose }, tk.A)).body.deal;
  const d1 = await mkDeal('ZZ D1', 100000, 'Proposal sent', `${addM(thisM, 1)}-15`);
  const d2 = await mkDeal('ZZ D2', 50000, 'Meeting', `${thisM}-28`);
  const d3 = await mkDeal('ZZ D3', 50000, 'Negotiation', `${addM(thisM, -2)}-10`);
  const W = await mkDeal('ZZ Won', 80000, 'Negotiation', `${thisM}-20`);
  const Lo = await mkDeal('ZZ Lost', 30000, 'Prospecting', `${thisM}-20`);
  check('five deals made', [d1, d2, d3, W, Lo].every(Boolean), [d1, d2, d3, W, Lo].map((x) => x && x.id));
  const won = await call('POST', `/crm/deals/${W.id}/stage`, { stage: 'Won' }, tk.A);
  check('a deal is won and its invoice raised', won.status === 200 && won.body.invoice, won.body);
  const lost = await call('POST', `/crm/deals/${Lo.id}/stage`, { stage: 'Lost', lostReason: 'Chose another vendor' }, tk.A);
  check('a deal is lost with its reason', lost.status === 200, lost.body);
  const inv = won.body.invoice;
  const sent = await call('POST', `/crm/invoices/${inv.id}/status`, { status: 'Sent' }, tk.A);
  const paid = await call('POST', `/crm/invoices/${inv.id}/payments`, { amount: 10000, mode: 'UPI' }, tk.A);
  check('the invoice goes out and 10,000 is received', sent.status === 200 && paid.status === 200, [sent.body, paid.body]);

  console.log('3. The dashboard charts vs the numbers worked out by hand');
  const ch = await call('GET', `/crm/charts?period=month&owner=${A.id}`, null, tk.X);
  check('the charts answer for one salesperson', ch.status === 200 && ch.body.scope === 'owner', ch.body);
  const c = ch.body;
  const srcOf = (n) => (c.sources.find((s) => s.name === n) || {}).count;
  check('lead sources: LinkedIn 2, Referral 1, nothing else', srcOf('LinkedIn') === 2 && srcOf('Referral') === 1 && c.sources.length === 2, c.sources);
  const st = (n) => c.pipeline.find((s) => s.stage === n);
  check('pipeline by stage value: Proposal sent 100,000 · Meeting 50,000 · Negotiation 50,000 · Contacted 1 deal of 0', near(st('Proposal sent').value, 100000) && near(st('Meeting').value, 50000) && near(st('Negotiation').value, 50000) && st('Negotiation').count === 1 && st('Contacted').count === 1 && near(st('Contacted').value, 0) && st('Prospecting').count === 0, c.pipeline);
  check('won and lost deals are not in the pipeline', !c.pipeline.some((s) => ['Won', 'Lost'].includes(s.stage)));
  const rev = c.revenue.find((m) => m.month === thisM);
  check('12 months of money, this month last', c.revenue.length === 12 && c.revenue[11].month === thisM && c.revenue[0].month === addM(thisM, -11), c.revenue.map((m) => m.month));
  check('this month: booked 80,000, invoiced = the invoice total with tax, collected 10,000', near(rev.booked, 80000) && near(rev.invoiced, inv.total) && near(rev.collected, 10000), [rev, inv.total]);
  check('the months before are empty for this salesperson', c.revenue.slice(0, 11).every((m) => !m.booked && !m.invoiced && !m.collected));
  const acts = (await DB.one(`SELECT COUNT(*) AS "n" FROM "CrmActivity" WHERE "byId" = ? AND "at" >= ? AND COALESCE("subject", '') NOT LIKE 'Stage:%' AND COALESCE("subject", '') NOT LIKE 'Follow-up moved:%'`, A.id, monthStart)).n;
  const tA = c.team.find((t) => t.ownerId === A.id);
  check(`team: A won 1 for 80,000 and logged ${acts} activities`, tA && tA.won === 1 && near(tA.wonValue, 80000) && tA.activities === Number(acts) && c.team.length === 1, c.team);
  check('lost reasons: 1 deal, "Chose another vendor", 30,000', c.lostReasons.length === 1 && c.lostReasons[0].name === 'Chose another vendor' && c.lostReasons[0].count === 1 && near(c.lostReasons[0].value, 30000), c.lostReasons);
  const fb = (k) => c.forecast.find((b) => b.key === k);
  const expThis = 50000 * prob.Meeting / 100; const expNext = 100000 * prob['Proposal sent'] / 100; const expLate = 50000 * prob.Negotiation / 100;
  check(`forecast this month = 50,000 x ${prob.Meeting}% = ${expThis}`, near(fb(thisM).weighted, expThis) && fb(thisM).count === 1 && near(fb(thisM).value, 50000), fb(thisM));
  check(`forecast next month = 100,000 x ${prob['Proposal sent']}% = ${expNext}`, near(fb(addM(thisM, 1)).weighted, expNext), fb(addM(thisM, 1)));
  check(`close date passed = 50,000 x ${prob.Negotiation}% = ${expLate}`, near(fb('late').weighted, expLate) && fb('late').count === 1, fb('late'));
  check('the converted deal with no close date is in "No close date" at 0', fb('none').count === 1 && near(fb('none').weighted, 0), fb('none'));
  check('the forecast total adds up', near(c.forecastTotal, expThis + expNext + expLate), c.forecastTotal);
  const chA = await call('GET', '/crm/charts?period=month', null, tk.A);
  check('A\'s own charts are the same numbers (a salesperson always sees their own)', chA.status === 200 && chA.body.scope === 'mine' && near(chA.body.forecastTotal, c.forecastTotal) && chA.body.sources.length === 2, chA.body && chA.body.scope);
  const chB = await call('GET', `/crm/charts?period=month&owner=${A.id}`, null, tk.B);
  check('B cannot read A\'s charts by asking for owner=A (B gets B\'s own)', chB.status === 200 && chB.body.scope === 'mine' && !chB.body.sources.length && near(chB.body.forecastTotal, 0), chB.body && [chB.body.scope, chB.body.forecastTotal]);
  const chMine = await call('GET', '/crm/charts?period=month&mine=1', null, tk.X);
  check('"Only mine" for the Admin holds none of A\'s', chMine.body.scope === 'mine' && !chMine.body.team.some((t) => t.ownerId === A.id && t.won));

  console.log('4. Reports, Excel and the download log');
  const rp = await call('GET', `/crm/report-tables?period=month&owner=${A.id}`, null, tk.X);
  check('the report tables come', rp.status === 200 && rp.body.tables.map((t) => t.key).join() === 'owners,funnel,sources,lost,aging', rp.body);
  const tab = (k) => rp.body.tables.find((t) => t.key === k).rows;
  const oa = tab('owners').find((r) => r.ownerId === A.id);
  const overdue = (await DB.one('SELECT COUNT(*) AS "n" FROM "CrmTask" WHERE "ownerId" = ? AND "status" = \'Open\' AND "dueDate" < ?', A.id, ymd(0))).n;
  const dueRows = await DB.all('SELECT "status" FROM "CrmTask" WHERE "ownerId" = ? AND "status" IN (\'Open\', \'Done\') AND "dueDate" >= ? AND "dueDate" <= ?', A.id, `${thisM}-01`, ymd(0));
  const expDone = dueRows.length ? Math.round((dueRows.filter((x) => x.status === 'Done').length / dueRows.length) * 1000) / 10 : null;
  check('by owner: 3 leads, 3 contacted, 2 qualified, 1 converted, 1 won for 80,000', oa && oa.leads === 3 && oa.contacted === 3 && oa.qualified === 2 && oa.converted === 1 && oa.won === 1 && near(oa.wonValue, 80000), oa);
  check(`by owner: ${acts} activities, ${overdue} overdue, completion ${expDone}%`, oa && oa.activities === Number(acts) && oa.overdue === Number(overdue) && oa.completion === expDone, [oa, overdue, expDone, dueRows.length]);
  const fn = tab('funnel');
  check('funnel 3 -> 3 -> 2 -> 1 -> 0 with the conversion from each step', fn.map((x) => x.count).join() === '3,3,2,1,0' && fn[1].fromPrevious === 100 && fn[2].fromPrevious === 66.7 && fn[3].fromPrevious === 50 && fn[4].fromPrevious === 0 && fn[0].fromPrevious == null, fn);
  const so = tab('sources');
  const li = so.find((x) => x.source === 'LinkedIn'); const re = so.find((x) => x.source === 'Referral');
  check('source performance: LinkedIn 2 leads / 1 qualified, Referral 1 lead / 1 converted', li && li.leads === 2 && li.qualified === 1 && li.converted === 0 && re && re.leads === 1 && re.converted === 1 && re.conversion === 0, so);
  const lr = tab('lost');
  check('lost reasons: "Chose another vendor" 1 deal, 30,000', lr.length === 1 && lr[0].reason === 'Chose another vendor' && lr[0].deals === 1 && near(lr[0].dealValue, 30000), lr);
  const ag = tab('aging');
  check('aging: everything open is 0-7 days old: 2 leads, 4 deals worth 200,000', ag[0].bucket === '0-7 days' && ag[0].leads === 2 && ag[0].deals === 4 && near(ag[0].dealValue, 200000) && ag.slice(1).every((x) => !x.leads && !x.deals), ag);
  const rpA = await call('GET', '/crm/report-tables?period=month', null, tk.A);
  check('a Salesperson without the reports right still reads their own', rpA.status === 200 && rpA.body.scope === 'mine' && rpA.body.tables[0].rows.length === 1 && rpA.body.tables[0].rows[0].ownerId === A.id, rpA.body && rpA.body.scope);
  const custom = await call('GET', `/crm/report-tables?from=${ymd(-400)}&to=${ymd(-370)}&owner=${A.id}`, null, tk.X);
  check('a custom range long ago holds none of these leads', custom.status === 200 && custom.body.period === 'custom' && custom.body.tables[1].rows[0].count === 0, custom.body && custom.body.tables && custom.body.tables[1].rows[0]);
  const logBefore = Number((await DB.one('SELECT COUNT(*) AS "n" FROM "CrmExportLog"')).n);
  const noX = await call('GET', '/crm/report-tables/owners/xlsx?period=month', null, tk.A, { binary: true });
  check('Excel is refused without the export right', noX.status === 403, noX.body);
  check('and a refused download writes no log row', Number((await DB.one('SELECT COUNT(*) AS "n" FROM "CrmExportLog"')).n) === logBefore);
  const xl = await call('GET', `/crm/report-tables/sources/xlsx?period=month&owner=${A.id}`, null, tk.M, { binary: true });
  check('the Sales manager downloads the sources report as .xlsx', xl.status === 200 && /spreadsheetml/.test(xl.type) && xl.buf && xl.buf.length > 100, [xl.status, xl.type]);
  const wb = XLSX.read(xl.buf, { type: 'buffer' });
  const sheet = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  check('the Excel file holds the heading and the same rows', sheet[0][0] === 'Source' && sheet.length === so.length + 1 && sheet.some((r) => r[0] === 'LinkedIn' && r[1] === 2), sheet);
  const logRow = await DB.one('SELECT * FROM "CrmExportLog" ORDER BY "at" DESC LIMIT 1');
  check('the download is in the export log: who, what, rows, when', logRow && logRow.byId === M.id && /Source performance/.test(logRow.what) && logRow.format === 'xlsx' && Number(logRow.rows) === so.length && !!logRow.at, logRow);
  const aud = await prisma.auditLog.findFirst({ where: { userId: M.id, action: 'CRM report downloaded' }, orderBy: { createdAt: 'desc' } }).catch(() => null);
  check('and it is audited', !!aud, aud);
  const csv = await call('GET', '/crm/export/leads', null, tk.M, { binary: true });
  const csvLog = await DB.one('SELECT * FROM "CrmExportLog" WHERE "byId" = ? AND "format" = \'csv\' ORDER BY "at" DESC LIMIT 1', M.id);
  check('a CSV list download is logged too', csv.status === 200 && csvLog && csvLog.what === 'List: leads', csvLog);
  const lgM = await call('GET', '/crm/export-log', null, tk.M);
  check('the Sales manager reads the download log', lgM.status === 200 && lgM.body.rows.some((x) => x.id === logRow.id), lgM.body && lgM.body.rows && lgM.body.rows.length);
  check('a Salesperson cannot read it', (await call('GET', '/crm/export-log', null, tk.A)).status === 403);

  console.log('5. One conversation thread per lead');
  const at = (h) => new Date(Date.now() - h * 3600000).toISOString();
  await call('POST', '/crm/activities', { kind: 'whatsapp', leadId: L1.id, subject: 'WhatsApp message sent', note: `To +91${L1.phone}\n\nHello Asha, here are the details`, at: at(3) }, tk.A);
  await call('POST', '/crm/activities', { kind: 'email', leadId: L1.id, subject: 'Email sent: Our proposal', note: 'To asha@example.test\n\nPlease find the proposal', at: at(2) }, tk.A);
  await call('POST', '/crm/activities', { kind: 'note', leadId: L1.id, subject: 'Internal note, not a message', at: at(1.5) }, tk.A);
  const SA = require('../src/crm/salesAgent'); // eslint-disable-line global-require
  const AUTO = require('../src/crm/autopilot'); // eslint-disable-line global-require
  if (!(await SA.load()).on) await AUTO.onReply({ channel: 'WhatsApp', phone: L1.phone, text: 'Yes, call me tomorrow' });
  else await DB.run('INSERT INTO "CrmActivity" ("id", "kind", "subject", "note", "at", "leadId", "byName", "createdAt") VALUES (?, \'whatsapp\', \'Replied on WhatsApp\', \'Yes, call me tomorrow\', ?, ?, \'Autopilot\', ?)', `act_zz${process.pid}`, DB.nowIso(), L1.id, DB.nowIso());
  const th = await call('GET', `/crm/conversation/lead/${L1.id}`, null, tk.A);
  const msgs = (th.body && th.body.messages) || [];
  check('the thread comes, and A may reply', th.status === 200 && th.body.canReply === true, th.body);
  check('oldest first, newest at the bottom', msgs.length >= 4 && msgs.every((m, i) => !i || m.at >= msgs[i - 1].at), msgs.map((m) => m.at));
  check('the call, the WhatsApp, the email and their reply are in it; the internal note is not', msgs.some((m) => m.channel === 'Call') && msgs.some((m) => m.channel === 'WhatsApp' && m.direction === 'out') && msgs.some((m) => m.channel === 'Email' && m.subject === 'Our proposal') && !msgs.some((m) => /Internal note/.test(m.subject)), msgs.map((m) => `${m.channel}/${m.direction}/${m.subject}`));
  const last = msgs[msgs.length - 1];
  check('their reply is last, inbound, with its words', last && last.direction === 'in' && last.channel === 'WhatsApp' && /call me tomorrow/.test(last.text), last);
  const wa = msgs.find((m) => m.channel === 'WhatsApp' && m.direction === 'out');
  check('a sent message shows its words without the "To" line, and says who it went to', wa && wa.text === 'Hello Asha, here are the details' && /^\+91/.test(wa.to), wa);
  check('B cannot read A\'s conversation', (await call('GET', `/crm/conversation/lead/${L1.id}`, null, tk.B)).status === 404);
  const thDeal = await call('GET', `/crm/conversation/deal/${conv.body.deal.id}`, null, tk.A);
  check('a converted lead\'s deal shows the lead\'s thread too', thDeal.status === 200, thDeal.body);

  console.log('6. The lead score: up after a reply, down after silence');
  const S1 = (await call('POST', '/crm/leads', { company: `ZZ Work Score ${process.pid}`, contactName: 'Divya', phone: phone(), source: 'Website' }, tk.A)).body.lead;
  const score = async () => (await call('GET', `/crm/ai/insight/lead/${S1.id}`, null, tk.A)).body;
  const s0 = await score();
  if (!(await SA.load()).on) await AUTO.onReply({ channel: 'WhatsApp', phone: S1.phone, text: 'Interested, send details' });
  else await DB.run('INSERT INTO "CrmActivity" ("id", "kind", "subject", "note", "at", "leadId", "byName", "createdAt") VALUES (?, \'whatsapp\', \'Replied on WhatsApp\', \'Interested\', ?, ?, \'Autopilot\', ?)', `act_zzs${process.pid}`, DB.nowIso(), S1.id, DB.nowIso());
  const s1 = await score();
  check(`a reply raises the score (${s0 && s0.score} -> ${s1 && s1.score})`, s0 && s1 && s1.score > s0.score, [s0, s1]);
  check('"why this score" names the reply and the recent activity', s1.reasons.some((r) => /replied/i.test(r.why) && r.pts > 0) && s1.reasons.some((r) => /Recent activity/.test(r.why)), s1.reasons);
  await call('POST', '/crm/activities', { kind: 'meeting', leadId: S1.id, subject: 'Demo call', outcome: 'Meeting held', note: 'Outcome: Meeting held' }, tk.A);
  const s1b = await score();
  check(`a meeting held raises it again (${s1.score} -> ${s1b.score})`, s1b.score > s1.score && s1b.reasons.some((r) => /meeting was held/i.test(r.why)), s1b.reasons);
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  await DB.run('UPDATE "CrmActivity" SET "at" = ? WHERE "leadId" = ?', old, S1.id);
  await DB.run('UPDATE "CrmLead" SET "createdAt" = ? WHERE "id" = ?', old, S1.id);
  const s2 = await score();
  check(`40 days of silence lowers it (${s1b.score} -> ${s2.score})`, s2.score < s1b.score && s2.reasons.some((r) => /Silent for 40 days/.test(r.why) && r.pts < 0), s2.reasons);
  check('an old reply still counts, but for less', s2.reasons.some((r) => /replied/i.test(r.why) && r.pts === 5), s2.reasons);

  console.log('7. The Leads list paged and sorted on the server');
  const tag = `ZZPAGE${process.pid}`;
  const now = Date.now();
  for (let i = 0; i < 55; i += 1) {
    const t = new Date(now - i * 60000).toISOString();
    // eslint-disable-next-line no-await-in-loop
    await DB.run('INSERT INTO "CrmLead" ("id", "company", "status", "stage", "source", "rating", "expectedValue", "ownerId", "ownerName", "createdAt", "updatedAt") VALUES (?, ?, \'New\', \'New\', \'LinkedIn\', ?, ?, ?, ?, ?, ?)',
      `lead_zzp${process.pid}_${i}`, `${tag} ${String(i).padStart(2, '0')}`, i % 5 === 0 ? 'Hot' : 'Cold', i % 3 === 0 ? null : i * 1000, M.id, M.name, t, t);
  }
  const p1 = await call('GET', `/crm/leads?q=${tag}&page=1&pageSize=50&sort=company&dir=asc`, null, tk.X);
  check('page 1: 50 rows, the total is 55, two pages', p1.status === 200 && p1.body.rows.length === 50 && p1.body.total === 55 && p1.body.pages === 2 && p1.body.page === 1, p1.body && [p1.body.total, p1.body.rows && p1.body.rows.length]);
  check('sorted by company A to Z', p1.body.rows[0].company === `${tag} 00` && p1.body.rows[49].company === `${tag} 49`, [p1.body.rows[0].company, p1.body.rows[49].company]);
  const p2 = await call('GET', `/crm/leads?q=${tag}&page=2&pageSize=50&sort=company&dir=asc`, null, tk.X);
  check('page 2: the last 5', p2.body.rows.length === 5 && p2.body.rows[4].company === `${tag} 54`, p2.body.rows.map((r) => r.company));
  const pv = await call('GET', `/crm/leads?q=${tag}&page=1&sort=value&dir=desc`, null, tk.X);
  const vals = pv.body.rows.map((r) => r.expectedValue);
  const firstNull = vals.indexOf(null);
  check('by value, highest first, the ones with no value last', vals[0] === 53000 && vals.slice(0, firstNull === -1 ? vals.length : firstNull).every((v, i, a) => !i || a[i - 1] >= v) && (firstNull === -1 || vals.slice(firstNull).every((v) => v == null)), vals.slice(0, 5));
  const pc = await call('GET', `/crm/leads?q=${tag}&page=1&sort=created&dir=asc`, null, tk.X);
  check('by created, oldest first', pc.body.rows[0].company === `${tag} 54`, pc.body.rows[0].company);
  const ph = await call('GET', `/crm/leads?q=${tag}&page=1&rating=Hot`, null, tk.X);
  check('the filters still work with paging (11 Hot)', ph.body.total === 11 && ph.body.rows.every((r) => r.rating === 'Hot'), ph.body.total);
  const pA = await call('GET', `/crm/leads?q=${tag}&page=1`, null, tk.A);
  check('a Salesperson pages only their own (none of these)', pA.status === 200 && pA.body.total === 0, pA.body.total);
  const plain = await call('GET', `/crm/leads?q=${tag}`, null, tk.X);
  check('without page= the list is as before (all rows, for the Board)', Array.isArray(plain.body.rows) && plain.body.rows.length === 55 && plain.body.total === undefined, plain.body.rows && plain.body.rows.length);
  const pBig = await call('GET', `/crm/leads?q=${tag}&page=9`, null, tk.X);
  check('a page past the end gives the last page', pBig.body.page === 2 && pBig.body.rows.length === 5, [pBig.body.page, pBig.body.rows.length]);

  console.log('8. Round robin: website leads and a "+ Lead" with no owner take turns');
  const wb2 = await call('PUT', '/crm/website', { autoAssign: true }, tk.X);
  check('website round robin switched on', wb2.status === 200 && wb2.body.autoAssign === true, wb2.body);
  const KEY = wb2.body.key;
  const owners = [];
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await fetch(`${API}/crm/leads/public`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify({ name: `ZZ Web ${i} ${process.pid}`, phone: phone() }) }).then((x) => x.json());
    // eslint-disable-next-line no-await-in-loop
    owners.push(r.id ? (await DB.one('SELECT "ownerId" FROM "CrmLead" WHERE "id" = ?', r.id)).ownerId : null);
  }
  check('three website leads go A / B / A (or B / A / B): to the salespeople in turn', owners.every((o) => [A.id, B.id].includes(o)) && owners[0] !== owners[1] && owners[0] === owners[2], owners);
  const off = await call('POST', '/crm/leads', { company: `ZZ Manual Off ${process.pid}`, phone: phone() }, tk.M);
  check('with the setting off, a manager\'s "+ Lead" with no owner is the manager\'s', off.status === 200 && off.body.lead.ownerId === M.id && !off.body.byTurn, off.body.lead && off.body.lead.ownerId);
  const on = await call('PUT', '/crm/settings', { autoAssignManual: true }, tk.X);
  check('the manual round robin is switched on (CRM settings)', on.status === 200 && on.body.settings.autoAssignManual === true, on.body.settings && on.body.settings.autoAssignManual);
  check('and the screen is told', (await call('GET', '/crm/me', null, tk.M)).body.lists.autoAssignManual === true);
  const m1 = await call('POST', '/crm/leads', { company: `ZZ Manual 1 ${process.pid}`, phone: phone() }, tk.M);
  const m2 = await call('POST', '/crm/leads', { company: `ZZ Manual 2 ${process.pid}`, phone: phone() }, tk.M);
  check('the next "+ Lead" with no owner continues the same turn', m1.body.byTurn === true && m1.body.lead.ownerId === owners[1], [m1.body.lead && m1.body.lead.ownerId, owners]);
  check('and the one after goes to the other salesperson', m2.body.lead.ownerId === owners[0], m2.body.lead && m2.body.lead.ownerId);
  const picked = await call('POST', '/crm/leads', { company: `ZZ Manual Picked ${process.pid}`, phone: phone(), ownerId: B.id }, tk.M);
  check('an owner picked by the manager is kept (no turn taken)', picked.body.lead.ownerId === B.id && !picked.body.byTurn, picked.body.lead && picked.body.lead.ownerId);
  const rep = await call('POST', '/crm/leads', { company: `ZZ Rep Own ${process.pid}`, phone: phone() }, tk.A);
  check('a salesperson\'s own "+ Lead" stays theirs', rep.body.lead.ownerId === A.id && !rep.body.byTurn, rep.body.lead && rep.body.lead.ownerId);
  check('the first call follow-up went to the salesperson whose turn it was', !!(await DB.one('SELECT "id" FROM "CrmTask" WHERE "leadId" = ? AND "ownerId" = ?', m1.body.lead.id, owners[1])));

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
