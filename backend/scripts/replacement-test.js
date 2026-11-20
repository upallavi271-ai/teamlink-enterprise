#!/usr/bin/env node
/**
 * REPLACEMENT NAMES + THE DROPPED STEP (founder 2026-11-20: "where a candidate was replaced, the name of that candidate must be clearly visible"; "when a
 * drop is recorded, the candidate's profile STEP must also show Dropped").
 * SANDBOX ONLY: a private server on a COPY of the sandbox database.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> TEST_PORT=4241 node scripts/replacement-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-replacement-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4241;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'replacement-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const JD = require('../src/joindrop/core');
const V = require('../src/joindrop/vocab');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 700)}` : ''}`); } };
const call = async (method, url, body, token, raw = false) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Forwarded-For': `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* none */ }
  return { status: r.status, body: j, text: raw ? text : undefined };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const today = V.todayIst();
const ago = (n) => V.addDays(today, -n);
const RUN = Date.now().toString(36);

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  await JD.ready();
  // ------------------------------------------------------------------ fixtures
  const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
  const mk = async (tag, extra) => prisma.user.create({ data: { ...base, name: `ZZTEST RP ${tag} ${RUN}`, email: `zz-rp-${tag}-${RUN}@example.test`, username: `zz-rp-${tag}-${RUN}@example.test`, ...extra } });
  // the history, candidate-list and search screens leave test names out for everybody except a test login (the dashboard's own rule): this test admin is one
  const uAdm = await mk('adm', { role: 'SUPER_ADMIN', atsRole: 'ADMIN' });
  const uRec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
  const uRecOut = await mk('recout', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' });
  const uTl = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
  const uBde = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' });
  const mkClient = async (tag, extra = {}) => prisma.client.create({ data: { name: `ZZTEST RP Client ${tag} ${RUN}`, location: 'ZZ Town', ownerDepartment: 'Education', bdeOwner: uBde.name, clientType: 'Direct', ...extra } });
  const cA = await mkClient('A', { guaranteePeriod: '90 Days', agreementStatus: 'ACTIVE' });
  const cB = await mkClient('B', { guaranteePeriod: '90 Days', agreementStatus: 'ACTIVE' });
  const uCa = await mk('ca', { role: 'CLIENT', atsRole: 'CLIENT', clientId: cA.id, portalPerms: 'VIEW' });
  const uCb = await mk('cb', { role: 'CLIENT', atsRole: 'CLIENT', clientId: cB.id, portalPerms: 'VIEW' });
  const mkReq = async (c, tag) => prisma.requirement.create({ data: { title: `ZZTEST RP Job ${tag} ${RUN}`, clientId: c.id, status: 'OPEN', department: 'Education', openings: 4, location: 'ZZ Job City', recruiterId: uRec.id, tlId: uTl.id, tl: uTl.name, bdeId: uBde.id } });
  const rA = await mkReq(cA, 'A');
  const rA2 = await mkReq(cA, 'A2');
  const rB = await mkReq(cB, 'B');
  let cn = 0;
  const mkApp = async (req, stage, extra = {}) => {
    cn += 1;
    const c = await prisma.candidate.create({ data: { name: `ZZTEST RP Person${cn} ${RUN}`, email: `zz-rp-c${cn}-${RUN}@example.test`, phone: `91000${String(cn).padStart(5, '0')}`, location: 'ZZ', source: 'ZZ Source' } });
    const a = await prisma.application.create({ data: { candidateId: c.id, requirementId: req.id, stage, hiringType: 'Client Placement', offeredCtc: 480000, ...extra } });
    return { c, a };
  };
  const joinedApp = async (req, daysAgo) => {
    const x = await mkApp(req, 'JOINED', { joiningDate: ago(daysAgo), joinedAt: new Date(Date.now() - daysAgo * 86400000) });
    await JD.recordJoined({ applicationId: x.a.id, actor: { id: uRec.id, name: uRec.name, role: 'EMPLOYEE', atsRole: 'RECRUITER' }, info: { location: 'ZZ Place', joinedOn: ago(daysAgo) }, quiet: true });
    return { ...x, rec: await JD.byApplication(x.a.id) };
  };
  const j1 = await joinedApp(rA, 40); // dropped inside the 90 day period
  const j2 = await joinedApp(rA, 35); // a second joined person at the same client (stays working at first)
  const jB = await joinedApp(rB, 30); // another client's joined person (nobody waits for a replacement there)
  const rep = await mkApp(rA2, 'SELECTED'); // a replacement on ANOTHER requirement of the same client
  const repB = await mkApp(rB, 'SELECTED');
  const repSame = await mkApp(rA, 'SELECTED'); // a replacement on the SAME requirement

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  let up = false;
  for (let i = 0; i < 160 && !up; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    up = await fetch(`${API}/health`).then((r) => r.ok).catch(() => false);
    // eslint-disable-next-line no-await-in-loop
    if (!up) await new Promise((r) => { setTimeout(r, 500); });
  }
  if (!up) { console.log('The server did not answer /api/health: a leftover process may hold the port; pick another TEST_PORT.'); await stop(2); return; }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (u) => jwt.sign({ ...tokenPayload(await resolveIdentity(u.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const tA = await tok(adminRow);
  const tAdm = await tok(uAdm); const tRec = await tok(uRec); const tRecOut = await tok(uRecOut); const tBde = await tok(uBde); const tCa = await tok(uCa); const tCb = await tok(uCb);
  const roll = (appId, v, t = tA) => call('PATCH', `/ats/applications/${appId}/roll-status`, { rollStatus: v }, t);
  const rollOf = async (appId) => (await prisma.application.findUnique({ where: { id: appId }, select: { rollStatus: true } })).rollStatus;
  const reason = V.DROP_REASONS[0];

  // ====================================================================== 1. a drop and the "due" sentence
  const d1 = await call('POST', `/join-drop/${j1.rec.id}/drop`, { droppedOn: ago(3), reason, reasonDetail: 'replacement test' }, tA);
  check('1 the drop is recorded', d1.status === 200 && d1.body.ok, d1);
  const p1 = await call('GET', `/join-drop/${j1.rec.id}`, null, tA);
  check('2 a dropped record with nobody linked says "Replacement due by <date> - not yet replaced" and who owns the task', p1.body.record.replacementState === 'DUE' && /Replacement due by .* not yet replaced/.test(p1.body.record.replacementWords || '') && /with /.test(p1.body.record.replacementWords || ''), p1.body.record);
  const dec = await call('POST', `/join-drop/${j1.rec.id}/decision`, { decision: 'NEEDED' }, tA);
  check('2b the client answer is entered (so the strict link route also works later)', dec.status === 200, dec);

  // ====================================================================== 2. the Roll status "Replacement" is not a bare label
  const nobody = await roll(jB.a.id, 'Replacement');
  check('3 Roll status Replacement with nobody waiting at that client is refused in plain words', nobody.status === 409 && nobody.body.nobodyWaiting === true && /No dropped candidate of this client is waiting for a replacement/.test(nobody.body.error), nobody);
  check('4 ...and the label was not saved', (await rollOf(jB.a.id)) === null);
  const nobody2 = await roll(repB.a.id, 'Replacement');
  check('4b a candidate of another client sees nobody waiting either (client A\'s drop is not offered)', nobody2.status === 409 && nobody2.body.nobodyWaiting === true, nobody2.body);
  const need = await roll(rep.a.id, 'Replacement');
  check('5 with a dropped candidate waiting, choosing Replacement asks WHO first (no bare label)', need.status === 409 && need.body.needsReplacementLink === true && (await rollOf(rep.a.id)) === null, need);

  // ====================================================================== 3. the dialog's list
  const w = await call('GET', `/join-drop/waiting/${rep.a.id}`, null, tA);
  const hit = w.status === 200 && w.body.records.find((x) => x.id === j1.rec.id);
  check('6 the dialog lists the dropped candidate of the SAME client with name, drop day and requirement', !!hit && hit.candidateName === j1.c.name && hit.droppedOn === ago(3) && /ZZTEST RP Job A /.test(hit.jobTitle || ''), w.body);
  check('7 ...another requirement of the client is offered too, flagged as not the same job', hit && hit.sameRequirement === false);
  const wSame = await call('GET', `/join-drop/waiting/${repSame.a.id}`, null, tA);
  check('8 for a candidate on the SAME requirement the dropped one is listed first (sameRequirement)', wSame.body.records[0] && wSame.body.records[0].id === j1.rec.id && wSame.body.records[0].sameRequirement === true, wSame.body);
  const wB = await call('GET', `/join-drop/waiting/${repB.a.id}`, null, tA);
  check('9 client B\'s candidate gets an empty list with the plain sentence', wB.status === 200 && wB.body.records.length === 0 && /No dropped candidate of this client is waiting for a replacement/.test(wB.body.message || ''), wB.body);

  // ====================================================================== 4. permissions around the dialog
  check('10 a recruiter outside the scope cannot open the list', (await call('GET', `/join-drop/waiting/${rep.a.id}`, null, tRecOut)).status === 403);
  check('11 a client login cannot open it', (await call('GET', `/join-drop/waiting/${rep.a.id}`, null, tCa)).status === 403);
  check('12 a client login cannot link', (await call('POST', '/join-drop/replacement-link', { droppedRecordId: j1.rec.id, applicationId: rep.a.id }, tCa)).status === 403);
  check('13 a recruiter outside the scope cannot link', (await call('POST', '/join-drop/replacement-link', { droppedRecordId: j1.rec.id, applicationId: rep.a.id }, tRecOut)).status === 403);
  check('14 a different client\'s candidate cannot be linked to this drop', (await call('POST', '/join-drop/replacement-link', { droppedRecordId: j1.rec.id, applicationId: repB.a.id, setLabel: true }, tA)).status === 409);
  check('15 the same person cannot replace himself', (await call('POST', '/join-drop/replacement-link', { droppedRecordId: j1.rec.id, applicationId: j1.a.id }, tA)).status === 409);

  // ====================================================================== 5. link (the dialog's endpoint)
  const l1 = await call('POST', '/join-drop/replacement-link', { droppedRecordId: j1.rec.id, applicationId: rep.a.id, setLabel: true }, tRec);
  check('16 the recruiter links the new person as the replacement (the dialog)', l1.status === 200 && l1.body.ok && l1.body.message.includes(rep.c.name) && l1.body.message.includes(j1.c.name), l1);
  check('17 the Roll status now says Replacement, and saving the label again is accepted (it links to somebody)', (await rollOf(rep.a.id)) === 'Replacement' && (await roll(rep.a.id, 'Replacement')).status === 200);
  const p2 = await call('GET', `/join-drop/${j1.rec.id}`, null, tA);
  const r2 = p2.body.record;
  check('18 the DROPPED record carries the replacement\'s name (not joined yet)', r2.replacedBy && r2.replacedBy.candidateName === rep.c.name && r2.replacedBy.joined === false && r2.replacementState === 'ADDED' && r2.replacementWords.includes(rep.c.name), r2);
  const rp1 = await call('GET', `/join-drop/application/${rep.a.id}`, null, tA);
  const f0 = rp1.body.replacementFor && rp1.body.replacementFor[0];
  check('19 the REPLACEMENT\'s own side names the dropped candidate, the day, the client and the requirement', f0 && f0.candidateName === j1.c.name && f0.droppedOn === ago(3) && f0.clientName === cA.name && /ZZTEST RP Job A /.test(f0.jobTitle) && /^Replacement for /.test(f0.words), rp1.body);
  const hist1 = (p2.body.history || []).find((e) => e.kind === 'REPLACEMENT_LINKED');
  check('20 the history says who will replace whom', hist1 && hist1.summary.includes(rep.c.name) && hist1.summary.includes('will replace') && hist1.summary.includes(j1.c.name), hist1);
  const aud = await prisma.auditLog.findFirst({ where: { entityId: j1.rec.id, action: 'Replacement candidate linked' }, orderBy: { createdAt: 'desc' } });
  check('21 an audit row names both people', aud && aud.toValue.includes(rep.c.name) && aud.toValue.includes(j1.c.name), aud && aud.toValue);
  const taskRow = (await call('GET', `/join-drop/${j1.rec.id}`, null, tA)).body.record.replacementTask;
  check('22 (the "Find a replacement" task is still open until the replacement joins; the sentence names who owns it)', !!taskRow, taskRow);
  const openList = await call('GET', `/join-drop/open-for-job/${rA.id}`, null, tA);
  check('23 once linked, the dropped person is no longer offered as "waiting"', !(await call('GET', `/join-drop/waiting/${repSame.a.id}`, null, tA)).body.records.some((x) => x.id === j1.rec.id) && !openList.body.records.some((x) => x.id === j1.rec.id));

  // ====================================================================== 6. the replacement joins
  await prisma.application.update({ where: { id: rep.a.id }, data: { stage: 'JOINED', joiningDate: ago(1), joinedAt: new Date(Date.now() - 86400000) } });
  await JD.recordJoined({ applicationId: rep.a.id, actor: { id: uRec.id, name: uRec.name, role: 'EMPLOYEE', atsRole: 'RECRUITER' }, info: { location: 'ZZ Place', joinedOn: ago(1) }, quiet: true });
  const p3 = await call('GET', `/join-drop/${j1.rec.id}`, null, tA);
  const r3 = p3.body.record;
  check('24 after the replacement joined: "Replaced by <name> (joined on <date>, <requirement>)"', r3.replacementState === 'REPLACED' && /^Replaced by .* \(joined on .*ZZTEST RP Job A2/.test(r3.replacementWords) && r3.replacementWords.includes(rep.c.name) && r3.replacedBy.joined === true && r3.replacedBy.daysToReplace === 2, r3);
  const ev3 = (p3.body.history || []).find((e) => e.kind === 'REPLACEMENT_CLOSED');
  check('25 the history line reads "<A> replaced <B>" with the days it took', ev3 && ev3.summary.startsWith(`${rep.c.name} replaced ${j1.c.name}`) && /2 days after the drop/.test(ev3.summary), ev3);
  const repRec = await JD.byApplication(rep.a.id);
  const repPanel = await call('GET', `/join-drop/${repRec.id}`, null, tA);
  check('26 the replacement\'s own record carries "Replacement for <name>" and a history line', repPanel.body.record.replacementFor && repPanel.body.record.replacementFor[0].candidateName === j1.c.name && (repPanel.body.history || []).some((e) => /joined as the replacement for/i.test(e.summary) && e.summary.includes(j1.c.name)), repPanel.body.record.replacementFor);
  const stg = await prisma.applicationStageEvent.findFirst({ where: { applicationId: rep.a.id, action: { startsWith: 'Replacement for' } } });
  check('27 the replacement\'s Pipeline history has a "Replacement for <name>" line', !!stg && stg.action.includes(j1.c.name), stg);

  // ====================================================================== 7. lists, exports, reports
  const list = await call('GET', '/join-drop/list?pageSize=200', null, tA);
  const rowDropped = list.body.rows.find((x) => x.id === j1.rec.id);
  const rowRep = list.body.rows.find((x) => x.id === repRec.id);
  check('28 the Joining & Drop list: the dropped row names the replacement, the replacement row names the dropped one', rowDropped && rowDropped.replacedBy.candidateName === rep.c.name && rowRep && rowRep.replacementFor[0].candidateName === j1.c.name, { d: rowDropped && rowDropped.replacedBy, r: rowRep && rowRep.replacementFor });
  const csv = await call('GET', '/join-drop/export', null, tA, true);
  const lines = (csv.text || '').split(/\r?\n/);
  const head = lines[0] || '';
  const iBy = head.split(',').indexOf('Replaced by'); const iFor = head.split(',').indexOf('Replacement for');
  check('29 the CSV / Excel export has the columns "Replaced by" and "Replacement for" with the names', iBy > 0 && iFor > 0 && lines.some((l) => l.includes(j1.c.name) && l.includes(rep.c.name)) && lines.some((l) => l.includes(`${rep.c.name}`) && l.includes(j1.c.name)), { head, n: lines.length });
  const rep0 = await call('GET', '/join-drop/report', null, tA);
  const tab = rep0.body.replacements && rep0.body.replacements.table.find((t) => t.droppedCandidate === j1.c.name);
  check('30 the report has a Replacement table: dropped -> replacement, client, requirement, dates, days to replace', tab && tab.replacementCandidate === rep.c.name && tab.clientName === cA.name && tab.daysToReplace === 2 && tab.droppedOn === ago(3) && tab.replacementJoinedOn === ago(1), rep0.body.replacements);
  check('31 ...and the counts replaced / pending / expired are there', rep0.body.replacements.replaced >= 1 && 'pending' in rep0.body.replacements && 'expired' in rep0.body.replacements, rep0.body.replacements);
  const rcsv = await call('GET', '/join-drop/report/export', null, tA, true);
  check('32 the report CSV carries the Replacement table too', /Dropped candidate,Replaced by/.test(rcsv.text || '') && (rcsv.text || '').includes(rep.c.name), (rcsv.text || '').slice(-400));
  const ch = await call('GET', `/join-drop/client-history/${cA.id}`, null, tA);
  check('33 the client\'s lifecycle history names both: "<A> replaced <B>"', (ch.body.events || []).some((e) => e.title === `${rep.c.name} replaced ${j1.c.name}`) && ch.body.replacements.replaced >= 1, (ch.body.events || []).filter((e) => e.group === 'Replacement').map((e) => e.title));
  const ah = await call('GET', `/ats/history/client/${cA.id}`, null, tAdm);
  check('34 the ATS client History page has the Replacement table and the chips on the joinings', ah.status === 200 && ah.body.replacements && ah.body.replacements.table.some((t) => t.replacementCandidate === rep.c.name) && (ah.body.joinings || []).some((x) => x.replacedBy && x.replacedBy.candidateName === rep.c.name), ah.body.replacements);
  const rh = await call('GET', `/ats/history/requirement/${rA.id}`, null, tAdm);
  check('35 the requirement History page says Dropped for the dropped person and names the replacement', rh.status === 200 && (rh.body.rows || []).some((x) => x.candidate === j1.c.name && x.stageLabel === 'Dropped' && x.replacedBy && x.replacedBy.candidateName === rep.c.name), (rh.body.rows || []).map((x) => [x.candidate, x.stageLabel]));
  const rhRep = await call('GET', `/ats/history/requirement/${rA2.id}`, null, tAdm);
  check('36 ...and the replacement\'s row on its own requirement carries "Replacement for"', (rhRep.body.rows || []).some((x) => x.candidate === rep.c.name && x.replacementFor && x.replacementFor[0].candidateName === j1.c.name), (rhRep.body.rows || []).map((x) => [x.candidate, !!x.replacementFor]));
  const ahcsv = await call('GET', `/ats/history/requirement/${rA.id}/export?format=csv`, null, tAdm, true);
  check('37 the History export carries "Replaced by"', /Replaced by/.test(ahcsv.text || '') && (ahcsv.text || '').includes(rep.c.name), (ahcsv.text || '').slice(0, 300));

  // ====================================================================== 8. candidate pages and lists: the chip + the Dropped step
  const pg = await call('GET', `/candidates/${rep.c.id}`, null, tAdm);
  const pa = pg.body && (pg.body.applications || []).find((x) => x.id === rep.a.id);
  check('38 the replacement\'s candidate page application carries "Replacement for <dropped name> (dropped on ..., client, requirement)"', pa && pa.replacementFor && pa.replacementFor[0].words.startsWith(`Replacement for ${j1.c.name} (dropped on `) && pa.replacementFor[0].words.includes(cA.name), pa && pa.replacementFor);
  const pgD = await call('GET', `/candidates/${j1.c.id}`, null, tAdm);
  const pd = pgD.body && (pgD.body.applications || []).find((x) => x.id === j1.a.id);
  check('39 the dropped person\'s page says Dropped as the step and names who replaced them', pd && pd.stageLabel === 'Dropped' && pd.left === true && pd.replacedBy && pd.replacedBy.candidateName === rep.c.name && pd.stage === 'JOINED', pd && { l: pd.stageLabel, by: pd.replacedBy });
  const tl = (pgD.body.pipelineHistory || pgD.body.timeline || []);
  check('40 the timeline of the dropped person ends with a Dropped label (the stage code stays Joined)', tl.some((e) => e.applicationId === j1.a.id && e.toStageLabel === 'Dropped'), tl.filter((e) => e.applicationId === j1.a.id).map((e) => [e.action, e.toStageLabel]));
  const cl = await call('GET', `/candidates?paged=1&view=master&search=${encodeURIComponent(j1.c.name)}&pageSize=25`, null, tAdm);
  const crow = (cl.body.rows || cl.body.candidates || []).find((x) => (x.candidateId || x.id) === j1.c.id);
  check('41 the Candidates list row says Dropped (and the replacement by name)', crow && crow.currentStageLabel === 'Dropped' && crow.left === true && crow.replacedBy && crow.replacedBy.candidateName === rep.c.name, crow && { l: crow.currentStageLabel, by: crow.replacedBy });
  const cl2 = await call('GET', `/candidates?paged=1&view=master&search=${encodeURIComponent(rep.c.name)}&pageSize=25`, null, tAdm);
  const crow2 = (cl2.body.rows || cl2.body.candidates || []).find((x) => (x.candidateId || x.id) === rep.c.id);
  check('42 the replacement\'s row carries the chip data', crow2 && crow2.replacementFor && crow2.replacementFor[0].candidateName === j1.c.name, crow2 && crow2.replacementFor);
  const pl = await call('GET', `/candidates?paged=1&view=pipeline&sub=all&search=${encodeURIComponent(j1.c.name)}&pageSize=25`, null, tAdm);
  const prow = (pl.body.rows || []).find((x) => x.applicationId === j1.a.id);
  check('42b the pipeline list (one row per application) says Dropped and names the replacement', prow && prow.currentStageLabel === 'Dropped' && prow.stageDetailLabel === 'Dropped' && prow.left === true && prow.replacedBy && prow.replacedBy.candidateName === rep.c.name, prow && { l: prow.currentStageLabel, by: prow.replacedBy });
  const pl2 = await call('GET', `/candidates?paged=1&view=pipeline&sub=all&search=${encodeURIComponent(rep.c.name)}&pageSize=25`, null, tAdm);
  const prow2 = (pl2.body.rows || []).find((x) => x.applicationId === rep.a.id);
  check('42c ...and the replacement row in the pipeline list carries "Replacement for"', prow2 && prow2.replacementFor && prow2.replacementFor[0].candidateName === j1.c.name, prow2 && prow2.replacementFor);
  const csvC = await call('GET', `/ats-io/export/candidates?format=csv&q=${encodeURIComponent('ZZTEST RP')}`, null, tAdm, true);
  check('43 the candidates export: Stage says Dropped for the dropped person, with the "Replaced by" column', /Replaced by/.test((csvC.text || '').split(/\r?\n/)[0] || '') && (csvC.text || '').split(/\r?\n/).some((l) => l.includes(j1.c.name) && /Dropped/.test(l) && l.includes(rep.c.name)), (csvC.text || '').split(/\r?\n/).filter((l) => l.includes(j1.c.name)));
  const jn = await call('GET', '/ats/joining', null, tAdm);
  const jrow = (Array.isArray(jn.body) ? jn.body : (jn.body.rows || [])).find((x) => x.candidate && x.candidate.id === j1.c.id);
  check('44 the Joining list row says Dropped and names the replacement', jrow && jrow.stageLabel === 'Dropped' && jrow.leftAfterJoining === true && jrow.replacedBy && jrow.replacedBy.candidateName === rep.c.name, jrow && { l: jrow.stageLabel, by: jrow.replacedBy });
  const jrowRep = (Array.isArray(jn.body) ? jn.body : (jn.body.rows || [])).find((x) => x.candidate && x.candidate.id === rep.c.id);
  check('45 ...and the replacement\'s Joining row has the chip data', jrowRep && jrowRep.replacementFor && jrowRep.replacementFor[0].candidateName === j1.c.name, jrowRep && jrowRep.replacementFor);
  const jcsv = await call('GET', '/ats-io/export/joining?format=csv', null, tAdm, true);
  check('46 the Joining export says Dropped in the Stage column and has the two replacement columns', /Replaced by,Replacement for/.test(jcsv.text || '') && (jcsv.text || '').split(/\r?\n/).some((l) => l.includes(j1.c.name) && /Dropped/.test(l)), (jcsv.text || '').split(/\r?\n/)[0]);
  const rq = await call('GET', `/requirements/${rA.id}`, null, tAdm);
  const qa = (rq.body.applications || []).find((x) => x.id === j1.a.id);
  check('47 the requirement\'s pipeline lists the dropped person at Dropped, with the chip data', qa && qa.stageLabel === 'Dropped' && qa.left === true && qa.replacedBy && qa.replacedBy.candidateName === rep.c.name, qa && { l: qa.stageLabel });
  const gs = await call('GET', `/ats/search?q=${encodeURIComponent(j1.c.name)}`, null, tAdm);
  check('48 global search shows Dropped for the dropped person', (gs.body.candidates || []).some((c) => c.id === j1.c.id && c.stageLabel === 'Dropped'), (gs.body.candidates || []).map((c) => [c.name, c.stageLabel]));
  const iv = await call('GET', '/ats/feedback', null, tAdm);
  const irow = (Array.isArray(iv.body) ? iv.body : ((iv.body && iv.body.rows) || [])).find((x) => x.candidate && x.candidate.id === j1.c.id);
  check('49 (interview calendar window / lists) the shared row says Dropped', !irow || irow.stageLabel === 'Dropped', irow && irow.stageLabel);
  const jr = await call('GET', `/ats/joining`, null, tAdm);
  check('50 (Offers list) a dropped person is never shown as Joined', !(await call('GET', '/ats/offers', null, tAdm)).body.rows?.some?.((x) => x.candidate && x.candidate.id === j1.c.id && x.stageLabel === 'Joined') && jr.status === 200);
  const portal = await call('GET', '/portal/client', null, tCa);
  const pc = portal.body && (portal.body.candidates || []).find((x) => x.applicationId === j1.a.id);
  check('51 the client portal shows its own dropped person as Dropped', !pc || pc.status === 'Dropped', pc && pc.status);

  // ====================================================================== 9. permissions on the data
  const pj = await call('GET', '/portal/client/join-drop', null, tCa);
  const pd2 = (pj.body.dropped || []).find((x) => x.id === j1.rec.id);
  check('52 the client\'s own dropped list names the replacement, with no TeamLink person and no candidate id', pd2 && pd2.replacedBy && pd2.replacedBy.candidateName === rep.c.name && !pd2.recruiterName && !pd2.candidateId && !('candidateId' in pd2.replacedBy) && !/phone|email|offeredCtc/i.test(JSON.stringify(pd2)), pd2);
  const pj2 = await call('GET', '/portal/client/join-drop', null, tCb);
  check('53 another client sees none of it', !JSON.stringify(pj2.body).includes(j1.c.name) && !JSON.stringify(pj2.body).includes(rep.c.name));
  const chc = await call('GET', '/portal/client/history', null, tCa);
  check('54 the client\'s own History names both people', (chc.body.events || []).some((e) => e.title === `${rep.c.name} replaced ${j1.c.name}`) && !JSON.stringify(chc.body).includes(uRec.name), (chc.body.events || []).map((e) => e.title).slice(-4));
  const bde = await call('GET', `/join-drop/${j1.rec.id}`, null, tBde);
  check('55 the BDE desk sees both names but never pay, phone or email', bde.status === 200 && bde.body.record.replacedBy.candidateName === rep.c.name && !('offeredCtc' in bde.body.record) && !/"phone"|"email"/.test(JSON.stringify(bde.body)), bde.body.record && Object.keys(bde.body.record));
  const outr = await call('GET', `/join-drop/${j1.rec.id}`, null, tRecOut);
  check('56 a recruiter outside the scope cannot open the record', outr.status === 403, outr.status);
  const own = await call('GET', `/join-drop/${j1.rec.id}`, null, tRec);
  check('57 the recruiter of the job sees the names in scope', own.status === 200 && own.body.record.replacedBy.candidateName === rep.c.name);

  // ====================================================================== 10. withdraw the drop: the link goes, the replacement stays
  const w1 = await call('POST', `/join-drop/${j1.rec.id}/reopen`, { reason: 'reported by mistake in the test' }, tA);
  check('58 withdrawing the drop works even after a replacement was linked', w1.status === 200, w1);
  const after = await call('GET', `/join-drop/${j1.rec.id}`, null, tA);
  check('59 the record is Joined again and carries no replacement link', after.body.record.status === 'Joined' && !after.body.record.replacedBy && !after.body.record.replacementApplicationId);
  const hw = (after.body.history || []).find((e) => e.kind === 'DROP_REOPENED');
  check('60 the history line says the link to the replacement was removed and that the replacement stays', hw && /link to the replacement/i.test(hw.summary) && hw.summary.includes(rep.c.name) && /stays on the job/.test(hw.summary), hw);
  const repAfter = await prisma.application.findUnique({ where: { id: rep.a.id }, select: { stage: true, rollStatus: true } });
  check('61 the replacement person stays (still Joined) and the bare Replacement label is cleared', repAfter.stage === 'JOINED' && repAfter.rollStatus === null, repAfter);
  const repRec2 = await call('GET', `/join-drop/${repRec.id}`, null, tA);
  check('62 the replacement\'s own record has a line saying they are no longer the replacement', (repRec2.body.history || []).some((e) => e.kind === 'REPLACEMENT_UNLINKED' && e.summary.includes(j1.c.name)) && !repRec2.body.record.replacementFor, repRec2.body.history && repRec2.body.history.map((e) => e.kind));
  const pgW = await call('GET', `/candidates/${j1.c.id}`, null, tA);
  const pw = (pgW.body.applications || []).find((x) => x.id === j1.a.id);
  check('63 after the withdrawal the step is Joined again on the candidate page', pw && pw.stageLabel === 'Joined' && !pw.left, pw && pw.stageLabel);
  const clw = await call('GET', `/candidates?paged=1&view=master&search=${encodeURIComponent(j1.c.name)}&pageSize=25`, null, tAdm);
  const crowW = (clw.body.rows || clw.body.candidates || []).find((x) => (x.candidateId || x.id) === j1.c.id);
  check('64 ...and the Candidates list row (its cache) follows at once', crowW && crowW.currentStageLabel === 'Joined' && !crowW.left && !crowW.replacedBy, crowW && crowW.currentStageLabel);

  // ====================================================================== 11. an older bare "Replacement" label can be linked
  await prisma.application.update({ where: { id: rep.a.id }, data: { rollStatus: 'Replacement' } });
  const bare = await call('GET', `/join-drop/replacing/${rep.a.id}`, null, tA);
  check('65 a bare Replacement label (old data) is reported as needing its link', bare.status === 200 && bare.body.needsLink === true, bare.body);
  const d2 = await call('POST', `/join-drop/${j2.rec.id}/drop`, { droppedOn: ago(2), reason, reasonDetail: 'second' }, tA);
  check('66 a second drop at the same client', d2.status === 200);
  const w2 = await call('GET', `/join-drop/waiting/${rep.a.id}`, null, tA);
  check('67 the second dropped person is offered (the client\'s answer is still pending: allowed)', w2.body.records.some((x) => x.id === j2.rec.id), w2.body);
  const l2 = await call('POST', '/join-drop/replacement-link', { droppedRecordId: j2.rec.id, applicationId: rep.a.id }, tA);
  check('68 the bare label is linked with the same dialog; it says the answer was pending in the history', l2.status === 200, l2);
  const bare2 = await call('GET', `/join-drop/replacing/${rep.a.id}`, null, tA);
  check('69 the "Link the replaced person" prompt is gone and the line names the dropped person', bare2.body.needsLink === false && bare2.body.replacementFor[0].candidateName === j2.c.name, bare2.body);
  await call('POST', `/join-drop/${j2.rec.id}/decision`, { decision: 'NOT_NEEDED' }, tA).catch(() => null);
  const j3 = await joinedApp(rA, 20);
  await call('POST', `/join-drop/${j3.rec.id}/drop`, { droppedOn: ago(1), reason }, tA);
  await call('POST', `/join-drop/${j3.rec.id}/decision`, { decision: 'NOT_NEEDED' }, tA);
  const l4 = await call('POST', '/join-drop/replacement-link', { droppedRecordId: j3.rec.id, applicationId: repSame.a.id }, tA);
  check('71 a drop where the client said "no replacement needed" cannot be linked', l4.status === 409 && /no replacement is needed/.test(l4.body.error || ''), l4);
  const j3rec = await call('GET', `/join-drop/${j3.rec.id}`, null, tA);
  check('72 and its sentence says so in words', j3rec.body.record.replacementState === 'DECLINED' && /no replacement is needed/.test(j3rec.body.record.replacementWords), j3rec.body.record.replacementWords);

  // expired: a drop inside the period whose period is over
  const j4 = await joinedApp(rA, 100);
  await prisma.$executeRawUnsafe('UPDATE "JoiningRecord" SET "guaranteeEndsOn" = ? WHERE "id" = ?', ago(5), j4.rec.id);
  await call('POST', `/join-drop/${j4.rec.id}/drop`, { droppedOn: ago(12), reason }, tA);
  await prisma.$executeRawUnsafe('UPDATE "JoiningRecord" SET "dropWithinGuarantee" = 1, "guaranteeEndsOn" = ? WHERE "id" = ?', ago(5), j4.rec.id);
  const j4rec = await call('GET', `/join-drop/${j4.rec.id}`, null, tA);
  check('73 a drop whose replacement period is over without a replacement says "expired" in words', j4rec.body.record.replacementState === 'EXPIRED' && /The replacement period ended on/.test(j4rec.body.record.replacementWords), j4rec.body.record.replacementWords);
  const l3 = await call('POST', '/join-drop/replacement-link', { droppedRecordId: j4.rec.id, applicationId: rep.a.id }, tA);
  check('70 a person cannot be the replacement of two drops', l3.status === 409 && /already the replacement for/.test(l3.body.error || ''), l3);
  const rep9 = await call('GET', '/join-drop/report', null, tA);
  check('74 the report counts expired replacements', rep9.body.replacements.expired >= 1 && rep9.body.totals.replacementsExpired >= 1, rep9.body.replacements);

  // ====================================================================== 12. dashboard lists and the exports of them
  await call('POST', `/join-drop/${j4.rec.id}/reopen`, { reason: 'test clean up reopen' }, tA).catch(() => null);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (err) => { console.error(err); await stop(1); });
