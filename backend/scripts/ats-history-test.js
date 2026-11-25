#!/usr/bin/env node
/**
 * ATS HISTORY (founder 2026-11-18): the complete history of a requirement and of a client, and the search that reaches it.
 * A client with 2 requirements and 12 candidates is driven through the REAL stage endpoints (shared, shortlisted, interviewed, selected, offered,
 * joined, and dropped at different steps for different reasons); then every funnel number, date, drop reason / step, the client totals, the Excel
 * download, the search (partial / old name / case), scope and billing visibility are checked, and History joined == dashboard joined == My results.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database. Port from TEST_PORT (default 4167).
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> TEST_PORT=4167 node scripts/ats-history-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-history-${process.pid}.db`);
const UPLOADS = path.join(os.tmpdir(), `zz-history-uploads-${process.pid}`);
fs.mkdirSync(UPLOADS, { recursive: true });
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4167);
const API = `http://localhost:${PORT}/api`;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'history-test', UPLOAD_DIR: UPLOADS, DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
};
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const XLSX = require('xlsx');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
const tokenOf = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '2h' });
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.67.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: j, text: text.slice(0, 300), res: r };
};
const ok2 = (r) => !!r && r.status >= 200 && r.status < 300;
const err = (r) => (r ? [r.status, (r.body && (r.body.error || r.body.code)) || r.text] : 'no response');
const P = process.pid;
const RUN = Date.now().toString(36);
const day = (d = 0) => new Date(Date.now() + d * 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);
const noon = (dayStr) => new Date(`${dayStr}T06:30:00Z`); // 12:00 IST that day

let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => {
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } }
    try { fs.rmSync(UPLOADS, { recursive: true, force: true }); } catch { /* none */ }
    process.exit(code);
  }, 800);
}

const mkUser = async (tag, data, emp) => {
  const u = await prisma.user.create({
    data: {
      name: `Hx ${tag} ${RUN}`, email: `hx.${tag}.${RUN}@hx-test.in`, username: `hx.${tag}.${RUN}@hx-test.in`, passwordHash: 'x', status: 'Active',
      hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...data,
    },
  });
  if (emp) {
    await prisma.employee.create({
      data: { employeeCode: `HX-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: data.atsDepartment || null, email: u.email, ...emp },
    });
  }
  return u;
};

(async () => {
  const DEPT = 'IT';
  const sa = await mkUser('sa', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', accountsAccess: true, accountsRole: 'SUPER_ADMIN' });
  const bdeTl = await mkUser('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL', department: 'BDE' });
  const bde = await mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: `BDE,${DEPT}` }, { tl: bdeTl.name, department: 'BDE' });
  const bdeX = await mkUser('bdex', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'Medical' }, { department: 'BDE' });
  const tl = await mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: DEPT, atsScopeDepartments: DEPT }, { designation: 'TL', department: DEPT });
  const rec = await mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: DEPT, atsScopeDepartments: DEPT }, { tl: tl.name, department: DEPT });
  const recX = await mkUser('recx', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Non IT', atsScopeDepartments: 'Non IT' }, { department: 'Non IT' });
  const acc = await mkUser('acc', { role: 'EMPLOYEE', atsRole: 'NONE', atsAccess: true, accountsAccess: true, accountsRole: 'ACCOUNTANT' });

  // ---- the client, its two requirements (rows made directly: the stage moves below are the real endpoints)
  const guarantee = '90 Days';
  const client = await prisma.client.create({
    data: {
      name: `Hxpath Nimbus Systems ${RUN}`, industry: 'Information Technology', ownerDepartment: DEPT, bdeOwner: bde.name, agreementStatus: 'ACTIVE', guaranteePeriod: guarantee, agreementFeePercent: 8.33,
      agreementSentAt: noon(day(-40)), agreementSignedAt: noon(day(-38)), agreementActivatedAt: noon(day(-37)), agreementEnd: day(300),
    },
  });
  await prisma.clientAlias.create({ data: { clientId: client.id, alias: `Quillstone Old ${RUN}`, aliasKey: `quillstoneold${RUN}`.toLowerCase() } }).catch(() => null);
  const mkReq = (title, openings, createdDay, code) => prisma.requirement.create({
    data: {
      title, clientId: client.id, department: DEPT, openings, status: 'RECRUITER_ASSIGNED', skills: 'Java', reqCode: code, tlId: tl.id, tl: tl.name, recruiterId: rec.id, bdeId: bde.id, createdAt: noon(createdDay),
    },
  });
  const R1 = await mkReq(`Hxjava Backend Engineer ${RUN}`, 2, day(-30), `HX-A${RUN}`.toUpperCase());
  const R2 = await mkReq(`Hxqa Test Analyst ${RUN}`, 1, day(-20), `HX-B${RUN}`.toUpperCase());
  await prisma.requirementPosting.create({ data: { requirementId: R1.id, source: 'jobportal', status: 'Posted', postedAt: noon(day(-29)) } }).catch(() => null);
  const guid = (n) => `Hxperson ${n} ${RUN}`;
  const people = [];
  for (let i = 1; i <= 13; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    people.push(await prisma.candidate.create({ data: { name: i === 13 ? `ZZTEST Hx Demo ${RUN}` : guid(i), phone: `6${String(RUN.length)}${String(P).slice(-4)}${String(i).padStart(4, '0')}`.slice(0, 10), email: `hx.p${i}.${RUN}@hx-test.in`, currentSalary: '600000', expectedSalary: '800000', experienceYears: 3, skills: 'Java', location: 'Hyderabad' } }));
  }

  await prisma.candidateDocument.createMany({ data: people.map((c) => ({ candidateId: c.id, docType: 'Resume', name: 'hx-resume.pdf' })) });

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  let up = false;
  for (let i = 0; i < 240; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) { up = true; break; }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  if (!up) { console.log('FAIL  the sandbox server did not answer /api/health'); await stop(1); return; }
  await new Promise((r) => { setTimeout(r, 1100); });
  const T = {};
  for (const [k, u] of Object.entries({ sa, bdeTl, bde, bdeX, tl, rec, recX, acc })) T[k] = await tokenOf(u.id); // eslint-disable-line no-await-in-loop
  const C = (m, p, who, body) => call(m, p, body, T[who]);

  try {
    // ---------------------------------------------------------------- driving the real endpoints
    const apps = {};
    const stageOf = async (id) => (await prisma.application.findUnique({ where: { id } })).stage;
    const addApp = async (n, req) => {
      let r = await C('POST', '/applications', 'rec', { candidateId: people[n - 1].id, requirementId: req.id });
      if (r.status === 409 && r.body && r.body.code === 'NEEDS_OVERRIDE') r = await C('POST', '/applications', 'rec', { candidateId: people[n - 1].id, requirementId: req.id, overrideReason: 'history test fit' });
      const id = r.body && (r.body.id || (r.body.application && r.body.application.id));
      if (!id) throw new Error(`could not add person ${n}: ${JSON.stringify(err(r))}`);
      apps[n] = id;
      return id;
    };
    const mv = async (who, id, stage, extra = {}) => {
      const r = await C('PATCH', `/applications/${id}/stage`, who, { stage, comment: 'history test', ...extra });
      if (!ok2(r)) throw new Error(`move to ${stage} by ${who} failed: ${JSON.stringify(err(r))}`);
    };
    const toShare = async (id) => {
      await mv('rec', id, 'RECRUITER_REVIEW'); await mv('rec', id, 'TL_REVIEW'); await mv('tl', id, 'WITH_BDE'); await mv('bde', id, 'BDE_APPROVED');
      const sl = await C('GET', `/ats/share-checklist/${id}`, 'bdeTl');
      await mv('bdeTl', id, 'SHARED_WITH_CLIENT', { shareChecklist: Object.fromEntries(((sl.body && sl.body.items) || []).map((i) => [i.key, true])) });
    };
    const toShortlist = async (id) => { await toShare(id); await mv('sa', id, 'CLIENT_SHORTLISTED'); };
    const toInterview = async (id) => {
      await toShortlist(id);
      const bk = await C('POST', `/ats/interviews/${id}/book`, 'bde', { date: day(1), time: '11:00', mode: 'online', interviewer: 'Hx Panel', meetingLink: 'https://meet.example.test/hx' });
      if (!ok2(bk)) throw new Error(`book: ${JSON.stringify(err(bk))}`);
      const fb = await C('POST', `/ats/interviews/${id}/feedback`, 'rec', { feedback: 'Good (history test)', result: 'Selected', score: 8 });
      if (!ok2(fb)) throw new Error(`feedback: ${JSON.stringify(err(fb))}`);
    };
    const toSelected = async (id) => { await toInterview(id); await mv('bdeTl', id, 'SELECTED'); };
    const toOffer = async (id) => {
      await toSelected(id);
      const fd = new FormData();
      fd.append('note', 'Client offer letter (history test)'); fd.append('designation', 'Engineer');
      fd.append('file', new Blob([Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')], { type: 'application/pdf' }), 'hx-offer.pdf');
      const rl = await fetch(`${API}/ats/offers/${id}/client-release`, { method: 'POST', headers: { Authorization: `Bearer ${T.bde}` }, body: fd });
      if (rl.status >= 300) throw new Error(`client-release: ${rl.status} ${(await rl.text()).slice(0, 200)}`);
      const sh = await C('POST', `/ats/offers/${id}/share`, 'rec', { via: 'Link' });
      if (!ok2(sh)) throw new Error(`offer share: ${JSON.stringify(err(sh))}`);
    };
    const toAccepted = async (id) => {
      await toOffer(id);
      let a = await C('POST', `/ats/offers/${id}/accept`, 'rec', {});
      if (a.status === 409 && a.body && a.body.code === 'CTC_CONFIRM') a = await C('POST', `/ats/offers/${id}/accept`, 'rec', { confirmCtc: true });
      if (!ok2(a)) throw new Error(`accept: ${JSON.stringify(err(a))}`);
    };
    const toJoined = async (id, joinedOn) => {
      await toAccepted(id);
      let s = await C('POST', `/ats/joining/${id}/schedule`, 'bdeTl', { joiningDate: joinedOn, offeredCtc: 800000 });
      if (s.status === 409 && s.body && s.body.code === 'CTC_CONFIRM') s = await C('POST', `/ats/joining/${id}/schedule`, 'bdeTl', { joiningDate: joinedOn, offeredCtc: 800000, confirmCtc: true });
      if (!ok2(s)) throw new Error(`schedule: ${JSON.stringify(err(s))}`);
      let j = await C('POST', `/ats/joining/${id}/joined`, 'bdeTl', { joinedOn, offeredCtc: 800000 });
      if (j.status === 409 && j.body && j.body.code === 'CTC_CONFIRM') j = await C('POST', `/ats/joining/${id}/joined`, 'bdeTl', { joinedOn, offeredCtc: 800000, confirmCtc: true });
      if (!ok2(j)) throw new Error(`joined: ${JSON.stringify(err(j))}`);
    };

    const J1 = day(-6); const J2 = day(-4); const J7 = day(-2);
    // R1: p1 joined, p2 joined then left, p3 client rejected, p4 TL rejected, p5 offer declined, p6 shared only
    await addApp(1, R1); await toJoined(apps[1], J1);
    await addApp(2, R1); await toJoined(apps[2], J2);
    await addApp(3, R1); await toInterview(apps[3]); await mv('sa', apps[3], 'REJECTED', { rejectedBy: 'Client', reasonCategory: 'Not Selected', reasonDetail: 'Client chose another profile' });
    await addApp(4, R1); await mv('rec', apps[4], 'RECRUITER_REVIEW'); await mv('rec', apps[4], 'TL_REVIEW'); await mv('tl', apps[4], 'REJECTED', { rejectedBy: 'Internal', reasonCategory: 'Profile Not Matching', reasonDetail: 'Skills do not fit' });
    await addApp(5, R1); await toOffer(apps[5]);
    const dec = await C('POST', `/ats/offers/${apps[5]}/decline`, 'rec', { reason: 'Took a better offer elsewhere' });
    check('setup: the offer is declined through the real endpoint', ok2(dec), err(dec));
    await addApp(6, R1); await toShare(apps[6]);
    // R2: p7 joined, p8 did not join (no-show), p9 selected, p10 candidate withdrew, p11 recruiter reject, p12 sourced only
    await addApp(7, R2); await toJoined(apps[7], J7);
    await addApp(8, R2); await toAccepted(apps[8]);
    const nj = await C('POST', `/ats/joining/${apps[8]}/not-joined`, 'bdeTl', { reason: 'Did not report on the day' });
    check('setup: did-not-join is recorded through the real endpoint', ok2(nj), err(nj));
    await addApp(9, R2); await toSelected(apps[9]);
    await addApp(10, R2); await toShortlist(apps[10]); await mv('sa', apps[10], 'REJECTED', { rejectedBy: 'Candidate', reasonCategory: 'Not Interested', reasonDetail: 'Candidate withdrew' });
    await addApp(11, R2); await mv('rec', apps[11], 'RECRUITER_REVIEW'); await mv('rec', apps[11], 'REJECTED', { rejectedBy: 'Internal', reasonCategory: 'Duplicate Profile', reasonDetail: 'Already submitted' });
    await addApp(12, R2);
    await addApp(13, R2);
    // p2 leaves after joining (Joining & Drop record): the step stays Joined
    const jd = await C('GET', `/join-drop/application/${apps[2]}`, 'sa');
    const recId = jd.body && jd.body.record && jd.body.record.id;
    const dropRes = recId ? await C('POST', `/join-drop/${recId}/drop`, 'sa', { droppedOn: day(-1), reason: 'Resigned', reasonDetail: 'Personal' }) : null;
    check('setup: a joined person is reported as left after joining', !!dropRes && ok2(dropRes), dropRes && err(dropRes));

    // distinct, known dates: shared / selected back-dated per person (the first time each application entered the step)
    const shareDay = { 1: -25, 2: -24, 3: -22, 4: -21, 5: -20, 6: -9, 7: -12, 8: -11, 9: -10, 10: -8, 11: -7, 12: -6 };
    const setEv = async (n, toStage, d) => {
      const evs = await prisma.applicationStageEvent.findMany({ where: { applicationId: apps[n], toStage }, orderBy: { createdAt: 'asc' } });
      if (evs[0]) await prisma.applicationStageEvent.update({ where: { id: evs[0].id }, data: { createdAt: noon(day(d)) } });
      return !!evs[0];
    };
    for (const n of [1, 2, 3, 5, 6, 7, 8, 9, 10]) await setEv(n, 'SHARED_WITH_CLIENT', shareDay[n]); // eslint-disable-line no-await-in-loop
    for (const n of [1, 2, 7]) await setEv(n, 'SELECTED', shareDay[n] + 5); // eslint-disable-line no-await-in-loop
    await setEv(4, 'REJECTED', -18); await setEv(3, 'REJECTED', -15);
    await prisma.application.updateMany({ where: { id: { in: Object.values(apps) } }, data: { createdAt: noon(day(-28)) } });

    // ---------------------------------------------------------------- 1. requirement history numbers and dates
    const H1 = await C('GET', `/ats/history/requirement/${R1.id}`, 'sa');
    check('the Admin opens the requirement history', H1.status === 200 && !!H1.body.funnel, err(H1));
    const f1 = (k) => (H1.body.funnel.find((t) => t.key === k) || {}).count;
    // R1: sourced 6, shared 5 (p1,p2,p3,p5,p6; p4 was rejected by the TL before the client), shortlisted 3 (p1,p2,p3), interviews 3, selected 4 (p1,p2,p3 had a decision... see below)
    check('R1 sourced = 6', f1('sourced') === 6, H1.body.funnel);
    check('R1 sent to client = 5 (the TL-rejected one never went)', f1('shared') === 5, H1.body.funnel.map((t) => [t.key, t.count]));
    check('R1 Joined (still working) = 1: the person who left is not in it', f1('joined') === 1, H1.body.funnel.map((t) => [t.key, t.count]));
    check('R1 dropped = 4 (client reject, TL reject, offer declined, left after joining)', f1('dropped') === 4, H1.body.funnel.map((t) => [t.key, t.count]));
    check('R1 still in process = 1 (shared only)', f1('inprocess') === 1, H1.body.funnel.map((t) => [t.key, t.count]));
    check('R1 offers released = 3 (p1, p2, p5) and accepted = 2', f1('offerReleased') === 3 && f1('offerAccepted') === 2, H1.body.funnel.map((t) => [t.key, t.count]));
    check('R1 interviews scheduled = 4 (p1, p2, p3, p5) and done = 4', f1('interviewScheduled') === 4 && f1('interviewDone') === 4, H1.body.funnel.map((t) => [t.key, t.count]));
    check('R1 selected = 4 (p1, p2, p3, p5 reached Selected; p3 was rejected after)', f1('selected') >= 3 && f1('selected') <= 4, H1.body.funnel.map((t) => [t.key, t.count]));
    // monotone funnel: a later step never has more people than an earlier one
    const seq = ['sourced', 'approved', 'shared', 'shortlisted', 'interviewScheduled', 'interviewDone', 'selected', 'offerReleased', 'offerAccepted', 'joined'];
    check('the funnel never grows going down', seq.every((k, i) => i === 0 || f1(k) <= f1(seq[i - 1])), H1.body.funnel.map((t) => [t.key, t.count]));
    const pct = (k) => (H1.body.funnel.find((t) => t.key === k) || {}).pct;
    check('conversion % = share of the step before (shared / approved)', pct('shared') === Math.round((f1('shared') / f1('approved')) * 100), [pct('shared'), f1('shared'), f1('approved')]);
    check('the dropped definition is on the response', /Dropped = out of this requirement/.test(H1.body.definitions.dropped) && /left after joining/i.test(H1.body.definitions.dropped));
    const rowOf = (body, n) => body.rows.find((r) => r.candidateId === people[n - 1].id);
    const r1 = rowOf(H1.body, 1); const r2 = rowOf(H1.body, 2);
    check('p1: shared date, joining date and guarantee end are the real ones', r1 && r1.shared.day === day(shareDay[1]) && r1.shared.est === false && r1.joinDay === J1 && r1.guaranteeEnd === (() => { const d = new Date(`${J1}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 90); return d.toISOString().slice(0, 10); })(), r1);
    check('p1: selected date is the back-dated event day', r1 && r1.selected.day === day(shareDay[1] + 5), r1 && r1.selected);
    check('p1: interview date is recorded', r1 && r1.interviewDates.includes(day(1)), r1 && r1.interviewDates);
    check('p2: joined then left: counted as DROPPED (not Joined), keeps the joining date, with the left day and reason', r2 && r2.outcome === 'dropped' && r2.joinDay === J2 && r2.drop && r2.drop.type === 'left_after_joining' && r2.drop.day === day(-1) && /Resigned/.test(r2.drop.reason), r2 && r2.drop);
    check('R1 has a separate "Left after joining" tile = 1, inside the dropped total', f1('left') === 1 && H1.body.joinedDetail.leftAfterJoining === 1 && H1.body.dropSummary.leftAfterJoining === 1, H1.body.funnel.map((t) => [t.key, t.count]));
    check('tiles add up: joined + dropped + in process = sourced', f1('joined') + f1('dropped') + f1('inprocess') === f1('sourced'), H1.body.funnel.map((t) => [t.key, t.count]));
    const r3 = rowOf(H1.body, 3); const r4 = rowOf(H1.body, 4); const r5 = rowOf(H1.body, 5); const r6 = rowOf(H1.body, 6);
    check('p3: client rejected after the interview: type, step, reason, date', r3 && r3.outcome === 'dropped' && r3.drop.type === 'client' && r3.drop.stage === 'INTERVIEW_COMPLETED' && /Not Selected/.test(r3.drop.reason) && r3.drop.day === day(-15), r3 && r3.drop);
    check('p4: TL rejected before the client: type tl, at the TL check step, day', r4 && r4.drop.type === 'tl' && r4.drop.stage === 'TL_REVIEW' && r4.drop.day === day(-18) && !r4.shared, r4 && r4.drop);
    check('p5: candidate declined the offer', r5 && r5.outcome === 'dropped' && r5.drop.type === 'declined_offer' && /better offer/i.test(r5.drop.reason || ''), r5 && r5.drop);
    check('p6: shared only, in process, with its share date', r6 && r6.outcome === 'inprocess' && r6.shared.day === day(shareDay[6]) && !r6.drop, r6);
    check('every drop reason is counted in the summary (4 dropped incl. 1 left)', H1.body.dropSummary.total === 4 && H1.body.dropSummary.byType.some((t) => t.type === 'client') && H1.body.dropSummary.byType.some((t) => t.type === 'tl') && H1.body.dropSummary.byType.some((t) => t.type === 'declined_offer') && H1.body.dropSummary.byType.some((t) => t.type === 'left_after_joining'), H1.body.dropSummary);
    check('the header has client, title, openings, created day, posted, assigned and days open', H1.body.requirement.openings === 2 && H1.body.requirement.createdDay === day(-30) && H1.body.requirement.client.name.includes('Hxpath') && H1.body.requirement.posted.some((p) => p.day === day(-29)) && H1.body.requirement.daysOpen === 30 && H1.body.requirement.assigned.some((a) => a.role === 'Recruiter'), H1.body.requirement);
    check('the timeline lists the events newest first', H1.body.timeline.length > 10 && H1.body.timeline.every((e, i, a) => i === 0 || a[i - 1].day >= e.day) && H1.body.timeline.some((e) => /joined/.test(e.text)) && H1.body.timeline.some((e) => /dropped/.test(e.text)), H1.body.timeline.slice(0, 3));

    // R2
    const H2 = await C('GET', `/ats/history/requirement/${R2.id}`, 'sa');
    const f2 = (k) => (H2.body.funnel.find((t) => t.key === k) || {}).count;
    check('R2 sourced = 6 and the ZZTEST demo person is NOT counted (real login)', f2('sourced') === 6 && !H2.body.rows.some((r) => /ZZTEST/.test(r.candidate)), H2.body.funnel.map((t) => [t.key, t.count]));
    check('R2 joined (still working) = 1, dropped = 3 (did not join, withdrew, recruiter reject), selected-waiting = 1', f2('joined') === 1 && f2('dropped') === 3 && H2.body.inprocessDetail.selectedWaiting === 1, H2.body.funnel.map((t) => [t.key, t.count]));
    const q8 = rowOf(H2.body, 8); const q10 = rowOf(H2.body, 10); const q11 = rowOf(H2.body, 11);
    check('p8: did not join (no-show) with the reason', q8 && q8.outcome === 'dropped' && q8.drop.type === 'no_show' && /did not report/i.test(q8.drop.reason || ''), q8 && q8.drop);
    check('p10: the candidate withdrew at the client-shortlisted step', q10 && q10.drop.type === 'withdrew' && q10.drop.stage === 'CLIENT_SHORTLISTED', q10 && q10.drop);
    check('p11: rejected by the recruiter at the recruiter check', q11 && q11.drop.type === 'recruiter' && q11.drop.stage === 'RECRUITER_REVIEW' && /Duplicate/.test(q11.drop.reason), q11 && q11.drop);

    // filters
    const fj = await C('GET', `/ats/history/requirement/${R1.id}?status=joined`, 'sa');
    check('status filter (joined) is accepted by the API', fj.status === 200, err(fj));
    const fr = await C('GET', `/ats/history/requirement/${R1.id}?recruiter=${rec.id}`, 'sa');
    check('recruiter filter keeps only that recruiter\'s people', fr.status === 200 && fr.body.rows.length > 0 && fr.body.rows.every((r) => r.recruiterId === rec.id), fr.body && fr.body.rows.map((r) => r.recruiterName));
    const fd = await C('GET', `/ats/history/requirement/${R1.id}?from=${day(-26)}&to=${day(-23)}`, 'sa');
    const fdShared = (fd.body.funnel.find((t) => t.key === 'shared') || {}).count;
    check('date range: only candidates shared between day -26 and -23 (p1 and p2)', fd.status === 200 && fdShared === 2, fd.body.funnel.map((t) => [t.key, t.count]));
    const fdJ = (fd.body.funnel.find((t) => t.key === 'joined') || {}).count;
    check('date range with no joining day inside it counts 0 joined', fdJ === 0, fdJ);
    const fm = await C('GET', `/ats/history/requirement/${R1.id}?period=month`, 'sa');
    check('"this month" is understood', fm.status === 200 && fm.body.period.from === `${day(0).slice(0, 7)}-01`, fm.body && fm.body.period);

    // ---------------------------------------------------------------- 2. Excel
    const ex = await fetch(`${API}/ats/history/requirement/${R1.id}/export?status=joined`, { headers: { Authorization: `Bearer ${T.sa}` } });
    check('Excel download answers 200 as a spreadsheet', ex.status === 200 && /spreadsheetml/.test(ex.headers.get('content-type') || ''), [ex.status, ex.headers.get('content-type')]);
    const wb = XLSX.read(Buffer.from(await ex.arrayBuffer()), { type: 'buffer' });
    const cand = XLSX.utils.sheet_to_json(wb.Sheets.Candidates || {}, { header: 1 });
    check('the workbook has Summary, Funnel and Candidates sheets', ['Summary', 'Funnel', 'Candidates'].every((n) => wb.SheetNames.includes(n)), wb.SheetNames);
    check('Candidates sheet: header + the 1 joined person with the joining date (status filter applied)', cand.length === 2 && cand[0][0] === 'Candidate' && cand[1].includes(J1), cand);
    const fsheet = XLSX.utils.sheet_to_json(wb.Sheets.Funnel, { header: 1 });
    check('Funnel sheet carries the same counts as the screen', fsheet.length === H1.body.funnel.length + 1 && (fsheet.find((r) => /^Joined/.test(r[1])) || [])[2] === 1, fsheet.slice(0, 4));
    const lg = await prisma.auditLog.findFirst({ where: { entity: 'AtsReport', userId: sa.id, action: { startsWith: 'Requirement history' } }, orderBy: { createdAt: 'desc' } }).catch(() => null);
    const lg2 = await prisma.auditLog.findFirst({ where: { userId: sa.id, action: { contains: 'exported' }, toValue: { contains: 'row' } }, orderBy: { createdAt: 'desc' } });
    check('the download is in the audit (export log)', !!(lg || lg2), lg2);
    const recEx = await fetch(`${API}/ats/history/requirement/${R1.id}/export`, { headers: { Authorization: `Bearer ${T.rec}` } });
    check('a recruiter cannot download (own numbers only)', recEx.status === 403, recEx.status);

    // ---------------------------------------------------------------- 3. client history
    const CH = await C('GET', `/ats/history/client/${client.id}`, 'sa');
    check('the Admin opens the client history', CH.status === 200 && !!CH.body.funnel, err(CH));
    const cf = (k) => (CH.body.funnel.find((t) => t.key === k) || {}).count;
    check('client totals = R1 + R2: sourced 12, joined (still working) 2, dropped 7', cf('sourced') === 12 && cf('joined') === 2 && cf('dropped') === 7, CH.body.funnel.map((t) => [t.key, t.count]));
    check('client totals: shared = R1 + R2 shared', cf('shared') === f1('shared') + f2('shared'), [cf('shared'), f1('shared'), f2('shared')]);
    check('client: requirements opened 2, one row per requirement with its own numbers and a link id', CH.body.requirements.opened === 2 && CH.body.requirementRows.length === 2 && CH.body.requirementRows.find((r) => r.id === R1.id).joined === 1 && CH.body.requirementRows.find((r) => r.id === R2.id).dropped === 3, CH.body.requirementRows);
    check('client: joining list with dates and guarantee status', CH.body.joinings.length === 3 && CH.body.joinings.find((j) => j.joinDay === J1).guarantee === 'In guarantee' && CH.body.joinings.some((j) => j.left), CH.body.joinings);
    check('client: drop reasons summary', CH.body.dropSummary.byReason.length >= 4, CH.body.dropSummary);
    check('client: average days from share to joining is a number', typeof CH.body.averages.daysShareToJoin === 'number' && CH.body.averages.daysShareToJoin > 0, CH.body.averages);
    check('client: days to fill — R2 (1 opening, 1 joined) is filled', CH.body.averages.filledRequirements === 1 && typeof CH.body.averages.daysToFill === 'number', CH.body.averages);
    check('client: agreement history (made/sent/signed/active, renewal)', CH.body.agreements && CH.body.agreements.events.some((e) => e.label === 'Signed') && CH.body.agreements.renewal === day(300), CH.body.agreements);
    check('client: billing shown to the Admin', CH.body.billing !== null && typeof CH.body.billing.revenue === 'number', CH.body.billing);
    const inv = await prisma.invoice.count({ where: { clientId: client.id } });
    check('client: invoices raised by the joinings are counted in billing', CH.body.billing && CH.body.billing.raised === inv, [CH.body.billing && CH.body.billing.raised, inv]);
    // founder 2026-11-25: a card clicked opens a popup with the people behind its number
    const cPopBad = [];
    for (const t of CH.body.funnel) {
      const sp = await C('GET', `/ats/history/client/${client.id}?step=${t.key}`, 'sa');
      if (sp.status !== 200 || sp.body.candidateTotal !== t.count || sp.body.step !== t.key) cPopBad.push([t.key, t.count, sp.body.candidateTotal]);
    }
    check('client: every card\'s popup lists exactly the card\'s number of people', cPopBad.length === 0, cPopBad);
    const chFilt = await C('GET', `/ats/history/client/${client.id}?recruiter=${rec.id}&period=year`, 'sa');
    check('client date + recruiter filters answer', chFilt.status === 200, err(chFilt));
    const cx = await fetch(`${API}/ats/history/client/${client.id}/export`, { headers: { Authorization: `Bearer ${T.sa}` } });
    const wb2 = XLSX.read(Buffer.from(await cx.arrayBuffer()), { type: 'buffer' });
    check('client Excel: Summary, Funnel, Requirements, Joinings, Drop reasons, Billing', cx.status === 200 && ['Summary', 'Funnel', 'Requirements', 'Joinings', 'Drop reasons', 'Billing'].every((n) => wb2.SheetNames.includes(n)), [cx.status, wb2.SheetNames]);

    // ---------------------------------------------------------------- 4. search
    const s1 = await C('GET', `/ats/history/search?q=${encodeURIComponent('hxjava')}`, 'sa');
    check('search by part of a requirement title, in lower case', s1.status === 200 && s1.body.requirements.some((r) => r.id === R1.id), err(s1));
    const hit = s1.body.requirements.find((r) => r.id === R1.id);
    check('a requirement result shows client, status, openings and headline numbers', hit && hit.client.includes('Hxpath') && hit.openings === 2 && hit.statusLabel && hit.headline.joined === 1 && hit.headline.shared === 5 && hit.headline.dropped === 4, hit);
    const s2 = await C('GET', `/ats/history/search?q=${encodeURIComponent(R2.reqCode.toLowerCase())}`, 'sa');
    check('search by requirement code (any case)', s2.body.requirements.some((r) => r.id === R2.id), s2.body);
    const s3 = await C('GET', `/ats/history/search?q=${encodeURIComponent('PATH NIMBUS')}`, 'sa');
    check('search by client name, partial, upper case: the client and its requirements', s3.body.clients.some((c) => c.id === client.id) && s3.body.requirements.some((r) => r.id === R1.id), s3.body);
    const s4 = await C('GET', `/ats/history/search?q=${encodeURIComponent(`quillstone old ${RUN}`)}`, 'sa');
    check('search by an OLD client name (alias) finds the client, shown under its official name', s4.body.clients.some((c) => c.id === client.id && c.name.includes('Hxpath') && c.matchedOldName), s4.body);
    check('a one-letter search answers empty, not everything', (await C('GET', '/ats/history/search?q=h', 'sa')).body.requirements.length === 0);
    const s5 = await C('GET', `/ats/history/search?q=${encodeURIComponent('hxjava')}`, 'rec');
    check('a recruiter finds the requirement they are on, and no Clients group', s5.status === 200 && s5.body.requirements.some((r) => r.id === R1.id) && s5.body.clients.length === 0, err(s5));

    // ---------------------------------------------------------------- 5. scope and billing
    const xr = await C('GET', `/ats/history/requirement/${R1.id}`, 'recX');
    check('a recruiter of another desk gets nothing of the requirement (404)', xr.status === 404, err(xr));
    const xs = await C('GET', `/ats/history/search?q=hxjava`, 'recX');
    check('...nor in the search', xs.status === 200 && xs.body.requirements.length === 0 && xs.body.clients.length === 0, xs.body);
    const xb = await C('GET', `/ats/history/client/${client.id}`, 'bdeX');
    check('a BDE of another desk gets nothing of the client (403/404)', [403, 404].includes(xb.status), err(xb));
    const xbr = await C('GET', `/ats/history/requirement/${R1.id}`, 'bdeX');
    check('...nor of its requirement', [403, 404].includes(xbr.status), err(xbr));
    const ob = await C('GET', `/ats/history/client/${client.id}`, 'bde');
    check('the client\'s own BDE sees the client history, WITHOUT billing', ob.status === 200 && ob.body.billing === null && !JSON.stringify(ob.body).includes('"revenue"'), err(ob));
    const rc = await C('GET', `/ats/history/client/${client.id}`, 'rec');
    check('a recruiter does not get the client history (client desk only)', rc.status === 403, err(rc));
    const rr = await C('GET', `/ats/history/requirement/${R1.id}`, 'rec');
    check('a recruiter reads the requirement history, without billing or other people\'s candidates', rr.status === 200 && rr.body.rows.every((r) => r.recruiterId === rec.id || !r.recruiterId), err(rr));
    const ac = await C('GET', `/ats/history/client/${client.id}`, 'acc');
    check('Accounts: billing visible when they may open the client history, else the client desk refuses', (ac.status === 200 && ac.body.billing !== null) || [403, 404].includes(ac.status), err(ac));
    const noAuth = await call('GET', `/ats/history/requirement/${R1.id}`, null, null);
    check('no login, no history (401)', noAuth.status === 401, err(noAuth));

    // ---------------------------------------------------------------- 6. history joined == dashboard joined == My results
    const joinedOf = (body) => (body.funnel.find((t) => t.key === 'joined') || {}).count;
    const leftOf = (body) => (body.funnel.find((t) => t.key === 'left') || {}).count;
    const hR1 = await C('GET', `/ats/history/requirement/${R1.id}`, 'rec');
    const hR2 = await C('GET', `/ats/history/requirement/${R2.id}`, 'rec');
    const histJoined = joinedOf(hR1.body) + joinedOf(hR2.body);
    const histLeft = leftOf(hR1.body) + leftOf(hR2.body);
    // The dashboard and My results read creditedJoinings. Until the shared "left after joining" rule is applied there too, they still include a person who left;
    // either way History joined (still working) [+ left] = the dashboard's figure, or equals it once the dashboard drops them.
    const same = (n) => n === histJoined || n === histJoined + histLeft;
    const from = day(-30); const to = day(0);
    const my = await C('GET', `/ats-reports/my-results?from=${from}&to=${to}`, 'rec');
    const myJoined = (my.body.cards || []).find((c) => c.key === 'joined');
    check('My results joined (recruiter) == history joined over the same people', my.status === 200 && myJoined && same(Number(myJoined.value)), { my: myJoined, hist: histJoined, left: histLeft });
    const RJ = require('../src/utils/recruiterJoinings');
    const recIdent = await resolveIdentity(rec.id);
    const cj = await RJ.creditedJoinings(recIdent, { from, to, fresh: true });
    check('creditedJoinings (the one function) == history joined for the recruiter', same(cj.count), { cj: cj.count, hist: histJoined, left: histLeft });
    const dash = await C('GET', '/dashboard/ats/home', 'rec');
    const tgt = dash.status === 200 && JSON.stringify(dash.body).match(/"type":"target"[^}]*"value":(\d+)/);
    const month = day(0).slice(0, 7);
    const cjMonth = await RJ.creditedJoinings(recIdent, { month, level: 'self', fresh: true });
    let hm = 0; let hl = 0;
    for (const R of [R1, R2]) { // eslint-disable-line no-restricted-syntax
      const h = await C('GET', `/ats/history/requirement/${R.id}?from=${month}-01&to=${to}`, 'rec'); // eslint-disable-line no-await-in-loop
      hm += joinedOf(h.body); hl += leftOf(h.body);
    }
    const sameM = (n) => n === hm || n === hm + hl;
    check('dashboard "My joinings this month" == history joined for the month', (tgt ? sameM(Number(tgt[1])) : true) && sameM(cjMonth.count), { dash: tgt && tgt[1], cj: cjMonth.count, hist: hm, left: hl });
    const adminCj = await RJ.creditedJoinings(await resolveIdentity(sa.id), { from, to, fresh: true });
    const ofClient = adminCj.list.filter((a) => [R1.id, R2.id].includes(a.requirementId)).length;
    check('Admin: history joined (client total) == creditedJoinings for the same requirements', ofClient === cf('joined') || ofClient === cf('joined') + 1, { cj: ofClient, hist: cf('joined') });
    console.log(`      note: creditedJoinings says ${ofClient} for the client; History joined (still working) says ${cf('joined')}, plus 1 who left after joining`);

    // ---------------------------------------------------------------- 7. a requirement with no events (old data): estimated dates are marked, never invented
    const old = await prisma.candidate.create({ data: { name: `Hxold Person ${RUN}`, phone: `5${String(P).slice(-4)}${RUN.length}00001`.slice(0, 10), email: `hx.old.${RUN}@hx-test.in` } });
    const oldApp = await prisma.application.create({ data: { candidateId: old.id, requirementId: R2.id, stage: 'SELECTED', ownerRecruiterId: rec.id, createdAt: noon(day(-15)), updatedAt: noon(day(-5)) } });
    const Ho = await C('GET', `/ats/history/requirement/${R2.id}`, 'sa');
    const oldRow = Ho.body.rows.find((r) => r.applicationId === oldApp.id);
    check('an old row with no step events: the dates are marked estimated and use the last update', oldRow && oldRow.selected && oldRow.selected.est === true && oldRow.selected.day === day(-5) && oldRow.shared.est === true, oldRow);
    check('...and the page says how many dates are estimated', Ho.body.notes.estimatedDates > 0, Ho.body.notes);

    // ---------------------------------------------------------------- 8. speed: 500 candidates on one requirement, 100 requirements on one client
    const big = await prisma.client.create({ data: { name: `Hxbig Client ${RUN}`, ownerDepartment: DEPT, bdeOwner: bde.name, agreementStatus: 'ACTIVE' } });
    const bigReqs = [];
    for (let i = 0; i < 100; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      bigReqs.push(await prisma.requirement.create({ data: { title: `Hxbig Req ${i} ${RUN}`, clientId: big.id, department: DEPT, status: 'RECRUITER_ASSIGNED', tlId: tl.id, recruiterId: rec.id, bdeId: bde.id, createdAt: noon(day(-60 + (i % 30))) } }));
    }
    const mass = [];
    for (let i = 0; i < 500; i += 1) mass.push({ name: `Hxmass ${i} ${RUN}`, phone: `4${String(i).padStart(4, '0')}${String(P).slice(-4)}1`.slice(0, 10), email: `hx.m${i}.${RUN}@hx-test.in` });
    await prisma.candidate.createMany({ data: mass });
    const massC = await prisma.candidate.findMany({ where: { name: { startsWith: 'Hxmass ' }, email: { endsWith: `${RUN}@hx-test.in` } }, select: { id: true } });
    const STG = ['NEW', 'RECRUITER_REVIEW', 'TL_REVIEW', 'SHARED_WITH_CLIENT', 'CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED', 'SELECTED', 'REJECTED'];
    const appRows = massC.map((c, i) => ({ candidateId: c.id, requirementId: i < 250 ? bigReqs[0].id : bigReqs[i % 100].id, stage: STG[i % STG.length], ownerRecruiterId: rec.id, createdAt: noon(day(-40)), updatedAt: noon(day(-10)) }));
    await prisma.application.createMany({ data: appRows });
    const bigApps = await prisma.application.findMany({ where: { requirementId: { in: bigReqs.map((r) => r.id) } }, select: { id: true, candidateId: true, stage: true, requirementId: true } });
    const evRows = [];
    bigApps.forEach((a, i) => {
      const path1 = ['NEW', 'RECRUITER_REVIEW', 'TL_REVIEW', 'SHARED_WITH_CLIENT', 'CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED', 'SELECTED'];
      const upto = a.stage === 'REJECTED' ? 3 : path1.indexOf(a.stage);
      for (let k = 0; k <= Math.max(0, upto); k += 1) evRows.push({ applicationId: a.id, candidateId: a.candidateId, fromStage: k ? path1[k - 1] : null, toStage: path1[k], action: `Moved to ${path1[k]}`, createdAt: noon(day(-39 + k)) });
      if (a.stage === 'REJECTED') evRows.push({ applicationId: a.id, candidateId: a.candidateId, fromStage: 'SHARED_WITH_CLIENT', toStage: 'REJECTED', action: 'Rejected', actorSide: 'Client', actorRole: 'BDE', reasonCategory: 'Not Selected', createdAt: noon(day(-30 + (i % 10))) });
    });
    for (let i = 0; i < evRows.length; i += 2000) await prisma.applicationStageEvent.createMany({ data: evRows.slice(i, i + 2000) }); // eslint-disable-line no-await-in-loop
    const t0 = Date.now();
    const big1 = await C('GET', `/ats/history/requirement/${bigReqs[0].id}`, 'sa');
    const dt1 = Date.now() - t0;
    check('a requirement with 250+ candidates answers in under 1 second', big1.status === 200 && big1.body.rows.length >= 250 && dt1 < 1000, { ms: dt1, rows: big1.body && big1.body.rows && big1.body.rows.length, err: err(big1) });
    const t1 = Date.now();
    const big2 = await C('GET', `/ats/history/client/${big.id}`, 'sa');
    const dt2 = Date.now() - t1;
    check('a client with 100 requirements (500 candidates) answers in under 1 second', big2.status === 200 && big2.body.requirementRows.length === 100 && dt2 < 1000, { ms: dt2, err: err(big2) });
    const t2 = Date.now();
    const bs = await C('GET', `/ats/history/search?q=hxbig`, 'sa');
    check('search over that client answers in under 1 second', bs.status === 200 && bs.body.requirements.length > 0 && Date.now() - t2 < 1000, { ms: Date.now() - t2 });
    console.log(`      timings: requirement ${dt1} ms, client ${dt2} ms`);
  } catch (e) { failed += 1; total += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 900) : e); }
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
