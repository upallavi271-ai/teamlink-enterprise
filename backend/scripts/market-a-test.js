#!/usr/bin/env node
/**
 * MARKET WAVE - builder A (Dashboard & Analytics, Reports & MIS), 2026-11-21. One section per feature id:
 * 01.03 01.07 01.09 01.10 01.11 01.12 01.13 01.14 01.15 12.02 12.04 12.06 12.10 12.11 12.12 12.14 12.15 12.16.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database.
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4xxx node scripts/market-a-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-market-a-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4561;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'market-a-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
const section = (s) => console.log(`\n== ${s}`);
const call = async (method, url, body, token, raw = false) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (raw) return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text(), headers: r.headers };
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const P = process.pid;
const pick = async (where) => {
  const LL = require('../src/utils/leftLogin'); // eslint-disable-line global-require
  for (const u of await prisma.user.findMany({ where: { status: 'Active', ...where }, take: 30 })) {
    if (/zztest|example\.test/i.test(`${u.name}${u.email}`)) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const id = await resolveIdentity(u.id);
    if (id && !LL.hasLeft(id)) return u;
  }
  return null;
};

(async () => {
  const adminRow = await pick({ role: 'SUPER_ADMIN' });
  const tlRow = await pick({ role: 'TL', atsRole: 'TL', atsDepartment: 'Education' });
  const amRow = (await pick({ atsRole: 'ASSISTANT_MANAGER' })) || await prisma.user.create({ data: { name: `Mkta am ${P}`, email: `mkta.am.${P}@mkta-test.in`, passwordHash: 'x', status: 'Active', role: 'ASSISTANT_MANAGER', atsRole: 'ASSISTANT_MANAGER', atsDepartment: 'Education', atsScopeDepartments: 'Education', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3) } });
  const recRow = await pick({ role: 'RECRUITER', atsRole: 'RECRUITER', atsDepartment: 'Education' });
  const bdeRow = await pick({ atsRole: 'BDE', atsDepartment: 'BDE' });
  for (const u of [adminRow, tlRow, amRow, recRow, bdeRow].filter(Boolean)) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.user.update({ where: { id: u.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  }
  // a candidate SENT to a client, rejected there, whose current company is now that client (a backdoor suspect)
  // (made here: one Education application is sent to the client and then rejected there)
  let sharedApp = await prisma.application.findFirst({ where: { stage: { in: ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'NEW', 'RECRUITER_REVIEW'] }, requirement: { internal: false, department: 'Education' } }, include: { requirement: { include: { client: true } } } });
  let bdCand = null;
  if (sharedApp) {
    await prisma.applicationStageEvent.create({ data: { applicationId: sharedApp.id, candidateId: sharedApp.candidateId, action: 'Shared with client', fromStage: 'TL_REVIEW', toStage: 'SHARED_WITH_CLIENT', createdAt: new Date(Date.now() - 20 * 86400000) } });
    await prisma.applicationStageEvent.create({ data: { applicationId: sharedApp.id, candidateId: sharedApp.candidateId, action: 'Rejected', fromStage: 'SHARED_WITH_CLIENT', toStage: 'REJECTED', actorSide: 'Client', createdAt: new Date(Date.now() - 10 * 86400000) } });
    sharedApp = await prisma.application.update({ where: { id: sharedApp.id }, data: { stage: 'REJECTED' }, include: { requirement: { include: { client: true } } } });
    bdCand = await prisma.candidate.update({ where: { id: sharedApp.candidateId }, data: { currentCompany: `${sharedApp.requirement.client.name} Pvt Ltd`, phone: `9${String(P).padStart(9, '7').slice(-9)}` } });
  }
  const joinedApp = await prisma.application.findFirst({ where: { stage: 'JOINED', requirement: { internal: false, department: 'Education' } }, select: { id: true } });

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 200; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (u) => (u ? jwt.sign({ ...tokenPayload(await resolveIdentity(u.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' }) : null);
  const tA = await tok(adminRow); const tT = await tok(tlRow); const tM = await tok(amRow); const tR = await tok(recRow); const tB = await tok(bdeRow);

  section('access');
  const acA = await call('GET', '/ats-insights/access', null, tA);
  check('admin opens insights, sees the switches, all OFF by default', acA.status === 200 && acA.body.access.admin && acA.body.switches && !acA.body.switches.alerts && !acA.body.switches.schedules && !acA.body.switches.qoh, acA.body);
  const acR = await call('GET', '/ats-insights/access', null, tR);
  check('a recruiter is own-only here and gets no switches', acR.status === 200 && acR.body.access.ownOnly && acR.body.switches === undefined, acR.body);
  check('no login: refused', (await call('GET', '/ats-insights/access', null, null)).status === 401);

  section('01.03 / 12.06 time to fill by job and client');
  const ttfA = await call('GET', '/ats-insights/ttf', null, tA);
  check('time to fill: by requirement and by client, usual + average + time to hire', ttfA.status === 200 && Array.isArray(ttfA.body.byJob) && ttfA.body.byJob.length > 0 && ttfA.body.byClient.length > 0 && 'medianHire' in ttfA.body.byJob[0] && ttfA.body.tiles.joined > 0, ttfA.body && ttfA.body.tiles);
  const ttfT = await call('GET', '/ats-insights/ttf', null, tT);
  check('a TL counts only their own area (never more than the admin)', ttfT.status === 200 && ttfT.body.tiles.joined <= ttfA.body.tiles.joined, { tl: ttfT.body && ttfT.body.tiles, admin: ttfA.body.tiles });
  const oneClient = ttfA.body.byClient.find((c) => c.clientId);
  const ttfC = await call('GET', `/ats-insights/ttf?client=${oneClient.clientId}`, null, tA);
  check('filter by one client: every requirement row is that client', ttfC.status === 200 && ttfC.body.byJob.every((j) => j.clientId === oneClient.clientId), ttfC.body.byJob.slice(0, 3));
  const ttfX = await call('GET', '/ats-insights/ttf?format=xlsx', null, tA, true);
  check('time to fill downloads as Excel', ttfX.status === 200 && /spreadsheet/.test(ttfX.type), ttfX.type);
  const ttfRX = await call('GET', '/ats-insights/ttf?format=xlsx', null, tR, true);
  check('a recruiter cannot download team reports', ttfRX.status === 403);
  const dash = await call('GET', '/ats-insights/dashboard', null, tT);
  check('dashboard card: time to fill tiles for the last 90 days', dash.status === 200 && dash.body.ttf && dash.body.ttf.window && dash.body.ttf.window.days === 90, dash.body && dash.body.ttf);

  section('01.07 leaderboard');
  const lbA = await call('GET', '/ats-insights/leaderboard', null, tA);
  check('admin: ranked rows with badges, refreshed time', lbA.status === 200 && Array.isArray(lbA.body.rows) && (lbA.body.hidden || (Array.isArray(lbA.body.badges) && lbA.body.refreshedAt)), lbA.body);
  const lbR = await call('GET', '/ats-insights/leaderboard', null, tR);
  check('recruiter: their own team only (or switched off), never an error', lbR.status === 200 && (lbR.body.hidden || lbR.body.scope === 'Your team'), lbR.body);
  check('dashboard carries the leaderboard', !!dash.body.leaderboard);

  section('01.09 pipeline / revenue forecast');
  const fcA = await call('GET', '/ats-insights/forecast', null, tA);
  check('admin: expected joinings by step, client, month, and the expected fee', fcA.status === 200 && typeof fcA.body.expectedJoinings === 'number' && fcA.body.byStep.length === 6 && fcA.body.revenue && typeof fcA.body.revenue.expected === 'number', fcA.body);
  const fcT = await call('GET', '/ats-insights/forecast', null, tT);
  check('a TL (no money rights) gets joinings but no fee', fcT.status === 200 && fcT.body.revenue === null, fcT.body && fcT.body.revenue);
  check('chances are percentages 0-100', fcA.body.byStep.every((s) => s.chance >= 0 && s.chance <= 100));

  section('01.10 closest to fill');
  const rd = await call('GET', '/ats-insights/readiness', null, tA);
  check('open requirements ranked by ready %, each with a next step', rd.status === 200 && rd.body.rows.length > 0 && rd.body.rows.every((r, i, l) => i === 0 || l[i - 1].readiness >= r.readiness) && rd.body.rows.every((r) => r.next && r.left > 0), rd.body.rows && rd.body.rows.slice(0, 2));
  check('dashboard: top 6 closest to fill', Array.isArray(dash.body.readiness.rows) && dash.body.readiness.rows.length <= 6);

  section('01.11 plan my day');
  const pl = await call('POST', '/ats-insights/plan', {}, tT);
  check('a ranked plan with a reason on every task (code order when no AI answers)', pl.status === 200 && Array.isArray(pl.body.tasks) && pl.body.tasks.every((t) => t.why && t.label) && /Ranked/.test(pl.body.via), pl.body && { via: pl.body.via, n: pl.body.tasks && pl.body.tasks.length });
  const plR = await call('POST', '/ats-insights/plan', { ai: false }, tR);
  check('a recruiter gets their own plan', plR.status === 200 && Array.isArray(plR.body.tasks));

  section('01.12 natural-language chart builder');
  const ask = await call('POST', '/ats-insights/ask', { question: 'joinings by client this year' }, tA);
  check('"joinings by client this year" -> joinings grouped by client, this year, a bar chart', ask.status === 200 && ask.body.spec.entity === 'joinings' && ask.body.spec.groupBy === 'client' && ask.body.spec.range === 'thisYear' && ask.body.spec.chart === 'bar' && Array.isArray(ask.body.result.groups), ask.body && ask.body.spec);
  const ask2 = await call('POST', '/ats-insights/ask', { question: 'trend of candidates added month by month in the last 6 months' }, tA);
  check('a trend question -> by month, a line chart', ask2.status === 200 && ask2.body.spec.groupBy === 'addedMonth' && ask2.body.spec.chart === 'line', ask2.body && ask2.body.spec);
  const evil = await call('POST', '/ats-insights/builder/run', { spec: { entity: 'candidates; DROP TABLE User', columns: ['phone', 'email', 'client'], groupBy: 'password', filters: [{ field: 'x', op: 'raw', value: '1=1' }] } }, tA);
  check('anything off the whitelist is dropped (no raw query, no phone / e-mail column)', evil.status === 200 && evil.body.spec.entity === 'applications' && !evil.body.spec.columns.includes('phone') && !evil.body.spec.columns.includes('email') && evil.body.spec.groupBy === null && evil.body.spec.filters.length === 0 && evil.body.dropped.length >= 4, evil.body && { spec: evil.body.spec, dropped: evil.body.dropped });
  check('masked: a phone / e-mail typed in a question never reaches the model', require('../src/utils/insights/builder').maskPii('call 9876543210 or a.b@x.com') === 'call [number] or [email]');
  check('too short a question is refused in plain words', (await call('POST', '/ats-insights/ask', { question: 'hi' }, tA)).status === 400);

  section('12.02 custom report builder');
  const sc = await call('GET', '/ats-insights/builder/schema', null, tR);
  check('schema: four entities, each with fields and operators', sc.status === 200 && sc.body.entities.length === 4 && sc.body.entities.every((e) => e.fields.length > 5));
  const spec = { entity: 'requirements', columns: ['requirement', 'client', 'status', 'openings', 'filled'], filters: [{ field: 'status', op: 'is', value: 'Open' }], groupBy: 'client', measure: { op: 'sum', field: 'openings' }, chart: 'bar' };
  const br = await call('POST', '/ats-insights/builder/run', { spec }, tA);
  check('pick entity, columns, a filter, group by and a sum: grouped values + rows', br.status === 200 && br.body.result.groups.length > 0 && br.body.result.rows.every((r) => r[2] === 'Open') && br.body.result.measure.label.includes('openings'), br.body && br.body.result && { g: br.body.result.groups.slice(0, 2), m: br.body.result.measure });
  const brT = await call('POST', '/ats-insights/builder/run', { spec: { entity: 'applications', columns: ['candidate', 'client'] } }, tT);
  const brAll = await call('POST', '/ats-insights/builder/run', { spec: { entity: 'applications', columns: ['candidate', 'client'] } }, tA);
  check('scope: the TL\'s rows are a part of the admin\'s', brT.status === 200 && brT.body.result.total <= brAll.body.result.total, { tl: brT.body.result && brT.body.result.total, admin: brAll.body.result.total });
  const bx = await fetch(`${API}/ats-insights/builder/export`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tA}` }, body: JSON.stringify({ spec, format: 'xlsx', name: 'open openings' }) });
  check('the built report downloads as Excel', bx.status === 200 && /spreadsheet/.test(bx.headers.get('content-type') || ''));
  const sv = await call('POST', '/ats-insights/reports', { name: `Open openings ${P}`, spec, shared: 'team' }, tT);
  check('a TL saves it and shares it with the team', sv.status === 200 && !!sv.body.id, sv.body);
  const svPriv = await call('POST', '/ats-insights/reports', { name: `Private ${P}`, spec }, tT);
  const recList = await call('GET', '/ats-insights/reports', null, tR);
  check('a teammate sees the shared report, not the private one', recList.status === 200 && recList.body.reports.some((r) => r.id === sv.body.id) && !recList.body.reports.some((r) => r.id === svPriv.body.id), recList.body && recList.body.reports.map((r) => r.name));
  const runR = await call('GET', `/ats-insights/reports/${sv.body.id}/run`, null, tR);
  const runT = await call('GET', `/ats-insights/reports/${sv.body.id}/run`, null, tT);
  check('the shared report runs in the teammate\'s OWN scope', runR.status === 200 && runR.body.result.total <= runT.body.result.total, { rec: runR.body.result && runR.body.result.total, tl: runT.body.result && runT.body.result.total });
  check('someone else cannot change it', (await call('POST', '/ats-insights/reports', { id: sv.body.id, name: 'hijack', spec }, tR)).status === 403);
  check('...or delete it', (await call('DELETE', `/ats-insights/reports/${svPriv.body.id}`, null, tR)).status === 403);
  check('the BDE never sees the private report either', !(await call('GET', '/ats-insights/reports', null, tB)).body.reports.some((r) => r.id === svPriv.body.id));

  section('01.15 custom dashboards (charts pinned to the dashboard)');
  const pinT = await call('POST', '/ats-insights/pins', { reportId: sv.body.id, forTeam: true }, tT);
  check('a TL pins the shared report for the whole team', pinT.status === 200 && !!pinT.body.id, pinT.body);
  const pinsR = await call('GET', '/ats-insights/pins', null, tR);
  check('it is on the teammate\'s dashboard', pinsR.status === 200 && pinsR.body.pins.some((p) => p.reportId === sv.body.id && p.forTeam), pinsR.body);
  check('a recruiter cannot pin for the team', (await call('POST', '/ats-insights/pins', { reportId: sv.body.id, forTeam: true }, tR)).status === 403);
  const pinR = await call('POST', '/ats-insights/pins', { reportId: sv.body.id }, tR);
  check('...but pins it for themselves', pinR.status === 200);
  check('the teammate cannot remove the TL\'s team pin', (await call('DELETE', `/ats-insights/pins/${pinT.body.id}`, null, tR)).status === 404);
  check('dashboard lists the pins', (await call('GET', '/ats-insights/dashboard', null, tR)).body.pins.length >= 1);

  section('01.13 metric alerts (OFF by default)');
  const al = await call('POST', '/ats-insights/alerts', { metric: 'open_jobs', direction: 'above', threshold: 0 }, tT);
  check('a TL sets an alert: open requirements above 0', al.status === 201, al.body);
  check('a bad metric is refused', (await call('POST', '/ats-insights/alerts', { metric: 'salary', threshold: 1 }, tT)).status === 400);
  const ck = await call('POST', '/ats-insights/alerts/check', {}, tT);
  check('"Check now" shows the number, notifies nobody', ck.status === 200 && ck.body.values.length === 1 && ck.body.values[0].crossed === true && ck.body.values[0].notified === false, ck.body);
  const n0 = await prisma.notification.count({ where: { userId: tlRow.id, title: { startsWith: 'Alert:' } } });
  const off = await call('POST', '/ats-insights/run/alerts', {}, tA);
  check('with the switch off the hourly check does nothing', off.status === 200 && /switched off/.test(off.body.skipped || ''), off.body);
  check('only an Admin flips the switches', (await call('PUT', '/ats-insights/switches', { alerts: true }, tT)).status === 403);
  check('...or runs a check', (await call('POST', '/ats-insights/run/alerts', {}, tT)).status === 403);
  await call('PUT', '/ats-insights/switches', { alerts: true }, tA);
  const on1 = await call('POST', '/ats-insights/run/alerts', {}, tA);
  const n1 = await prisma.notification.count({ where: { userId: tlRow.id, title: { startsWith: 'Alert:' } } });
  check('switched on: the crossing puts ONE note in the TL\'s bell', on1.status === 200 && n1 === n0 + 1, { on1: on1.body, n0, n1 });
  await call('POST', '/ats-insights/run/alerts', {}, tA);
  check('the next check while it still holds adds no second note', (await prisma.notification.count({ where: { userId: tlRow.id, title: { startsWith: 'Alert:' } } })) === n1);
  const audSw = await prisma.auditLog.findFirst({ where: { action: 'ATS insights switches changed' }, orderBy: { createdAt: 'desc' } });
  check('the switch change is audited', !!audSw && /alerts: on/.test(audSw.toValue || ''));
  await call('PUT', '/ats-insights/switches', { alerts: false }, tA);

  section('01.14 / 12.04 scheduled dashboard + report e-mails (OFF by default)');
  const rc = await call('GET', '/ats-insights/schedules/recipients', null, tR);
  check('a recruiter may send only to themselves', rc.status === 200 && rc.body.people.length === 1 && rc.body.people[0].id === recRow.id, rc.body);
  check('...so naming the admin is refused', (await call('POST', '/ats-insights/schedules', { kind: 'dashboard', frequency: 'daily', recipientIds: [adminRow.id] }, tR)).status === 403);
  const s1 = await call('POST', '/ats-insights/schedules', { kind: 'dashboard', frequency: 'weekly', weekday: 1, hour: 9 }, tT);
  const s2 = await call('POST', '/ats-insights/schedules', { kind: 'report', reportId: sv.body.id, frequency: 'monthly', monthDay: 1, hour: 8 }, tT);
  check('a TL schedules the dashboard weekly and a saved report monthly', s1.status === 201 && s2.status === 201, { s1: s1.body, s2: s2.body });
  const sl = await call('GET', '/ats-insights/schedules', null, tT);
  check('listed with a plain "when" and the next time', sl.status === 200 && sl.body.schedules.length === 2 && sl.body.schedules.every((s) => /Every|On day/.test(s.when) && s.nextDueAt), sl.body);
  await prisma.$executeRawUnsafe('UPDATE "AtsReportSchedule" SET "nextDueAt" = ? WHERE "userId" = ?', new Date(Date.now() - 60000).toISOString(), tlRow.id);
  const so = await call('POST', '/ats-insights/run/schedules', {}, tA);
  check('switched off: nothing is sent', /switched off/.test(so.body.skipped || ''), so.body);
  await call('PUT', '/ats-insights/switches', { schedules: true }, tA);
  const sOn = await call('POST', '/ats-insights/run/schedules', {}, tA);
  const after = await call('GET', '/ats-insights/schedules', null, tT);
  check('switched on: both due schedules are tried and their result recorded (sandbox mail)', sOn.status === 200 && sOn.body.sent && sOn.body.sent.length === 2 && after.body.schedules.every((s) => s.lastStatus && new Date(s.nextDueAt) > new Date()), { run: sOn.body, after: after.body.schedules.map((s) => s.lastStatus) });
  await call('PUT', '/ats-insights/switches', { schedules: false }, tA);
  const SCH = require('../src/utils/insights/schedules');
  const tlIdent = await resolveIdentity(tlRow.id);
  const mail = await SCH.dashboardMail(tlIdent);
  check('the dashboard mail is built in the recipient\'s own area', !!mail && /Your ATS dashboard/.test(mail.html) && /Closest to being filled/.test(mail.html));
  const rmail = await SCH.reportMail(tlIdent, sv.body.id, 'TL');
  check('the report mail carries an Excel attachment', !!rmail && rmail.attachments.length === 1 && rmail.attachments[0].filename.endsWith('.xlsx'));

  section('12.10 per-opening reporting');
  const op = await call('GET', '/ats-insights/openings', null, tA);
  check('requirements with several openings: one line per opening, filled or open', op.status === 200 && op.body.rows.length > 0 && op.body.rows.every((r) => r.openings > 1 && r.seats.length >= r.openings && r.seats.filter((s) => s.status === 'Filled').length === r.filled), op.body.rows && op.body.rows[0]);
  check('a filled opening names who filled it, when and in how many days', op.body.rows.flatMap((r) => r.seats).filter((s) => s.status === 'Filled').every((s) => s.person && 'daysToFill' in s));
  const opx = await call('GET', '/ats-insights/openings?format=csv', null, tA, true);
  check('downloads as CSV', opx.status === 200 && /text\/csv/.test(opx.type));

  section('12.11 backdoor hiring');
  if (sharedApp) {
    const bd = await call('GET', '/ats-insights/backdoor', null, tA);
    const row = bd.body.rows && bd.body.rows.find((r) => r.candidateId === sharedApp.candidateId);
    check('sent to the client, rejected, now works at that client -> Suspected', bd.status === 200 && row && row.status === 'suspected' && row.signals.some((s) => /Current company/.test(s)), { row, totals: bd.body && bd.body.totals });
    check('no phone or e-mail in the report', !JSON.stringify(bd.body).includes(bdCand.phone));
    check('an Assistant Manager only reads', (await call('POST', '/ats-insights/backdoor/mark', { applicationId: row.applicationId, status: 'suspected' }, tM)).status === 403);
    check('a recruiter cannot confirm', (await call('POST', '/ats-insights/backdoor/mark', { applicationId: row.applicationId, status: 'confirmed', note: 'client said' }, tR)).status === 403);
    check('confirming needs a note on how', (await call('POST', '/ats-insights/backdoor/mark', { applicationId: row.applicationId, status: 'confirmed' }, tA)).status === 400);
    const mk = await call('POST', '/ats-insights/backdoor/mark', { applicationId: row.applicationId, status: 'confirmed', note: 'Client HR confirmed on call' }, tA);
    const bd2 = await call('GET', '/ats-insights/backdoor?status=confirmed', null, tA);
    check('the admin confirms it; it is listed as Confirmed, audited', mk.status === 200 && bd2.body.rows.some((r) => r.candidateId === sharedApp.candidateId && r.status === 'confirmed') && !!(await prisma.auditLog.findFirst({ where: { action: { startsWith: 'Backdoor hire marked' }, entityId: row.applicationId } })), mk.body);
    await prisma.$executeRawUnsafe('DELETE FROM "AtsBackdoorFlag" WHERE "candidateId" = ?', sharedApp.candidateId);
    await prisma.candidate.update({ where: { id: sharedApp.candidateId }, data: { currentCompany: null } });
    const cl = await call('POST', '/ats-insights/backdoor/client-list', { clientId: sharedApp.requirement.clientId, text: `${bdCand.phone}\nSomebody Unknown ${P}` }, tA);
    check('a client-confirmed list is matched by phone: one matched, one not', cl.status === 200 && cl.body.matched.length === 1 && cl.body.notMatched.length === 1, cl.body);
    check('a recruiter cannot record a client list', (await call('POST', '/ats-insights/backdoor/client-list', { clientId: sharedApp.requirement.clientId, text: bdCand.phone }, tR)).status === 403);
  } else check('setup: a candidate shared with a client and rejected exists', false);

  section('12.12 quality-of-hire surveys');
  if (joinedApp) {
    check('an Assistant Manager cannot make a link', (await call('POST', '/ats-insights/qoh/link', { applicationId: joinedApp.id, day: 30 }, tM)).status === 403);
    const lk = await call('POST', '/ats-insights/qoh/link', { applicationId: joinedApp.id, day: 30 }, tA);
    check('the admin makes a 30-day link', lk.status === 200 && /\/api\/public\/qoh\//.test(lk.body.link), lk.body);
    const token = lk.body.link.split('/api/public/qoh/')[1];
    const pg = await call('GET', `/public/qoh/${token}`, null, null, true);
    check('the client opens it without a login: the form, no answer recorded yet', pg.status === 200 && /How is/.test(pg.text) && /name="rating"/.test(pg.text));
    check('a changed token is not valid', (await call('GET', `/public/qoh/${token}x`, null, null, true)).status === 404);
    const post = await fetch(`${API}/public/qoh/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'rating=4&skills=5&attendance=4&rehire=yes&comment=Good' });
    check('the client answers', post.status === 200 && /Thank you/.test(await post.text()));
    const again = await fetch(`${API}/public/qoh/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'rating=1' });
    check('a second answer is not added', /already answered/.test(await again.text()));
    const qr = await call('GET', '/ats-insights/qoh', null, tA);
    check('the report: average rating, would-rehire %, by client and recruiter; automatic sending OFF', qr.status === 200 && qr.body.totals.answered >= 1 && qr.body.totals.rating && qr.body.byClient.length >= 1 && qr.body.automatic === false, qr.body.totals);
    check('the daily sending does nothing while switched off', /switched off/.test((await call('POST', '/ats-insights/run/qoh', {}, tA)).body.skipped || ''));
  } else check('setup: a joined application exists', false);

  section('12.14 compliance reports (India DPDP)');
  const cp = await call('GET', '/ats-insights/compliance', null, tA);
  check('consent status, retention and the access log; says EEO / OFCCP do not apply in India', cp.status === 200 && /DPDP/.test(cp.body.law) && /EEO-1 and OFCCP/.test(cp.body.notApplicable) && cp.body.consent.byStatus.length >= 1 && cp.body.retention.rules.length >= 4 && typeof cp.body.access.views === 'number', cp.body && { law: cp.body.law });
  check('a TL cannot open it', (await call('GET', '/ats-insights/compliance', null, tT)).status === 403);
  const cpx = await call('GET', '/ats-insights/compliance?format=xlsx', null, tA, true);
  check('the pack downloads as one Excel workbook', cpx.status === 200 && /spreadsheet/.test(cpx.type));

  section('12.15 BI connector');
  check('a TL cannot make a BI key', (await call('POST', '/ats-insights/bi/keys', { label: 'tl key' }, tT)).status === 403);
  const key = await call('POST', '/ats-insights/bi/keys', { label: `Power BI ${P}`, feeds: ['jobs', 'joinings', 'applications', 'clients'] }, tA);
  check('the admin makes a key, shown once', key.status === 201 && /^tlbi_/.test(key.body.key), key.body);
  const kl = await call('GET', '/ats-insights/bi/keys', null, tA);
  check('the list never shows the key itself', kl.status === 200 && !JSON.stringify(kl.body).includes(key.body.key) && kl.body.keys.some((k) => k.keyTail === key.body.key.slice(-4)));
  const fj = await fetch(`${API}/bi/v1/joinings.json`, { headers: { 'X-API-Key': key.body.key } });
  const fjb = await fj.json();
  check('joinings feed (JSON) with the key', fj.status === 200 && fjb.feed === 'joinings' && fjb.count > 0 && 'days_to_fill' in fjb.rows[0], { status: fj.status, count: fjb.count });
  const fa = await (await fetch(`${API}/bi/v1/applications.json?key=${encodeURIComponent(key.body.key)}`)).json();
  check('applications feed has no candidate name, phone, e-mail or salary', fa.rows.length > 0 && !Object.keys(fa.rows[0]).some((k) => /phone|email|name|salary|ctc/i.test(k)), Object.keys(fa.rows[0] || {}));
  const fc = await fetch(`${API}/bi/v1/jobs.csv`, { headers: { Authorization: `Bearer ${key.body.key}` } });
  check('jobs feed as CSV for Excel "From web"', fc.status === 200 && /text\/csv/.test(fc.headers.get('content-type') || '') && /requirement_id/.test(await fc.text()));
  check('no key / a wrong key: 401', (await fetch(`${API}/bi/v1/jobs.json`)).status === 401 && (await fetch(`${API}/bi/v1/jobs.json`, { headers: { 'X-API-Key': 'tlbi_wrong' } })).status === 401);
  check('an unknown feed: 404', (await fetch(`${API}/bi/v1/users.json`, { headers: { 'X-API-Key': key.body.key } })).status === 404);
  const lim = await call('POST', '/ats-insights/bi/keys', { label: `Jobs only ${P}`, feeds: ['jobs'] }, tA);
  check('a key limited to jobs cannot read joinings', (await fetch(`${API}/bi/v1/joinings.json`, { headers: { 'X-API-Key': lim.body.key } })).status === 403);
  await call('DELETE', `/ats-insights/bi/keys/${key.body.id}`, null, tA);
  check('a revoked key stops working', (await fetch(`${API}/bi/v1/jobs.json`, { headers: { 'X-API-Key': key.body.key } })).status === 401);

  section('12.16 bottlenecks and forecast');
  const bn = await call('GET', '/ats-insights/bottlenecks', null, tT);
  check('step conversion, where people wait now, six months of trend and next month\'s forecast', bn.status === 200 && bn.body.steps.length === 5 && Array.isArray(bn.body.waiting) && bn.body.trend.length === 6 && typeof bn.body.nextMonth.openings === 'number', bn.body && { steps: bn.body.steps, next: bn.body.nextMonth });
  const bnx = await call('GET', '/ats-insights/bottlenecks?format=xlsx', null, tA, true);
  check('downloads as Excel', bnx.status === 200 && /spreadsheet/.test(bnx.type));

  section('roles');
  if (tB) {
    const bdeDash = await call('GET', '/ats-insights/dashboard', null, tB);
    check('a BDE opens the dashboard cards without candidate contact fields', [200, 403].includes(bdeDash.status) && !/"phone"|"email"/.test(JSON.stringify(bdeDash.body)), bdeDash.status);
  }
  const clientRow = await pick({ role: 'CLIENT' });
  if (clientRow) check('a client login is refused', (await call('GET', '/ats-insights/dashboard', null, await tok(clientRow))).status === 403);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
