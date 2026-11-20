#!/usr/bin/env node
/**
 * ATS HISTORY OF PEOPLE (founder 2026-11-20): the recruiter page, the TL (team) page, the candidate page, the people / candidate search and the access rules.
 * A TL with two recruiters (and another team with one) and 10 candidates with known dates are driven through the REAL stage endpoints; then every tile, the
 * month-wise and day-wise numbers, team = sum of members, the dropped-vs-joined rule, the candidate totals / reasons / timeline order, the Excel files, the
 * search and the access rules (both directions) are checked.
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
const COPY = path.join(os.tmpdir(), `zz-history-people-${process.pid}.db`);
const UPLOADS = path.join(os.tmpdir(), `zz-history-people-uploads-${process.pid}`);
fs.mkdirSync(UPLOADS, { recursive: true });
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4221);
const API = `http://localhost:${PORT}/api`;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'history-people-test', UPLOAD_DIR: UPLOADS, DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
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


// ---- the plan: who was added / sent / interviewed / selected / offered / joined / dropped, as days back from today (the expectations are computed from THIS table)
const PLAN = {
  a1: { rec: 'A', req: 'RA', added: -40, shared: -38, int: -36, sel: -34, off: -33, join: -31 },
  a2: { rec: 'A', req: 'RA', added: -40, shared: -38, int: -35, sel: -33, off: -32, join: -30, left: -2 },
  a3: { rec: 'A', req: 'RA', added: -39, tlReject: -37 },
  a4: { rec: 'A', req: 'RA', added: -20, shared: -18 },
  mA: { rec: 'A', req: 'RA', added: -39, shared: -37, int: -35, clientReject: -30 },
  mB: { rec: 'B', req: 'RB', added: -25, shared: -24, int: -22, sel: -20, off: -19, join: -10 },
  b2: { rec: 'B', req: 'RB', added: -26, shared: -24, int: -22, clientReject: -21 },
  b3: { rec: 'B', req: 'RB', added: -26, shared: -23, int: -21, sel: -20, off: -19, declinedDay: 0 }, // the offer decline writes no event of its own: its day is the day it was recorded (today, marked estimated)
  b4: { rec: 'B', req: 'RB', added: -5 },
  c1: { rec: 'C', req: 'RC', added: -15, shared: -14 },
  c2: { rec: 'C', req: 'RC', added: -3 },
};
const plan = (rec) => Object.entries(PLAN).filter(([, p]) => p.rec === rec).map(([k, p]) => ({ k, ...p }));
// expected count of one metric for a set of plan rows between two day offsets (inclusive)
const inWin = (off, lo, hi) => off !== undefined && off >= lo && off <= hi;
const expect = (rows, lo, hi) => ({
  added: rows.filter((p) => inWin(p.added, lo, hi)).length,
  sent: rows.filter((p) => inWin(p.shared, lo, hi)).length,
  interviews: rows.filter((p) => inWin(p.int, lo, hi)).length,
  selected: rows.filter((p) => inWin(p.sel, lo, hi)).length,
  offers: rows.filter((p) => inWin(p.off, lo, hi)).length,
  dropped: rows.filter((p) => inWin(p.left, lo, hi) || inWin(p.tlReject, lo, hi) || inWin(p.clientReject, lo, hi) || inWin(p.declinedDay, lo, hi)).length,
});
const COLS = ['added', 'sent', 'interviews', 'selected', 'offers', 'dropped'];

(async () => {
  const DEPT = 'IT';
  const TEAM = `Hx Team ${RUN}`;
  const sa = await mkUser('sa', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', accountsAccess: true, accountsRole: 'SUPER_ADMIN' });
  const bdeTl = await mkUser('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL', department: 'BDE' });
  const bde = await mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: `BDE,${DEPT}` }, { tl: bdeTl.name, department: 'BDE' });
  const bdeX = await mkUser('bdex', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'Medical' }, { department: 'BDE' });
  const tl = await mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: DEPT, atsScopeDepartments: DEPT, atsScopeTeams: TEAM }, { designation: 'TL', department: DEPT, team: TEAM });
  const tl2 = await mkUser('tltwo', { role: 'TL', atsRole: 'TL', atsDepartment: DEPT, atsScopeDepartments: DEPT, atsScopeTeams: `${TEAM} Two` }, { designation: 'TL', department: DEPT, team: `${TEAM} Two` });
  const recA = await mkUser('reca', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: DEPT, atsScopeDepartments: DEPT }, { tl: tl.name, department: DEPT, team: TEAM });
  const recB = await mkUser('recb', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: DEPT, atsScopeDepartments: DEPT }, { tl: tl.name, department: DEPT, team: TEAM });
  const recC = await mkUser('recc', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: DEPT, atsScopeDepartments: DEPT }, { tl: tl2.name, department: DEPT, team: `${TEAM} Two` });

  const client = await prisma.client.create({
    data: { name: `Hxpeople Orbit Systems ${RUN}`, industry: 'Information Technology', ownerDepartment: DEPT, bdeOwner: bde.name, agreementStatus: 'ACTIVE', guaranteePeriod: '90 Days', agreementFeePercent: 8.33 },
  });
  const mkReq = (title, openings, createdDay, code, recruiter, tlu) => prisma.requirement.create({
    data: { title, clientId: client.id, department: DEPT, openings, status: 'RECRUITER_ASSIGNED', skills: 'Java', reqCode: code, tlId: tlu.id, tl: tlu.name, recruiterId: recruiter.id, bdeId: bde.id, createdAt: noon(createdDay) },
  });
  const R = {
    RA: await mkReq(`Hxpeople Backend Lead ${RUN}`, 2, day(-45), `HP-A${RUN}`.toUpperCase(), recA, tl),
    RB: await mkReq(`Hxpeople Data Analyst ${RUN}`, 2, day(-30), `HP-B${RUN}`.toUpperCase(), recB, tl),
    RC: await mkReq(`Hxpeople Support Engineer ${RUN}`, 1, day(-20), `HP-C${RUN}`.toUpperCase(), recC, tl2),
  };
  const names = ['a1', 'a2', 'a3', 'a4', 'm', 'b2', 'b3', 'b4', 'c1', 'c2'];
  const P0 = {};
  for (const [i, n] of names.entries()) { // eslint-disable-line no-restricted-syntax
    // eslint-disable-next-line no-await-in-loop
    P0[n] = await prisma.candidate.create({
      data: { name: `Hxperson ${n} ${RUN}`, phone: `7${String(RUN.length)}${String(P).slice(-4)}${String(i).padStart(4, '0')}`.slice(0, 10), email: `hxp.${n}.${RUN}@hx-test.in`, currentSalary: '600000', expectedSalary: '800000', experienceYears: 3, skills: 'Java', location: 'Hyderabad', source: 'Naukri' },
    });
  }
  await prisma.candidateDocument.createMany({ data: Object.values(P0).map((c) => ({ candidateId: c.id, docType: 'Resume', name: 'hx-resume.pdf' })) });

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  let up = false;
  for (let i = 0; i < 240; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) { up = true; break; }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  if (!up) { console.log('FAIL  the sandbox server did not answer /api/health (a leftover process may hold the port: set TEST_PORT)'); await stop(1); return; }
  await new Promise((r) => { setTimeout(r, 1100); });
  const T = {};
  for (const [k, u] of Object.entries({ sa, bdeTl, bde, bdeX, tl, tl2, recA, recB, recC })) T[k] = await tokenOf(u.id); // eslint-disable-line no-await-in-loop
  const C = (m, p, who, body) => call(m, p, body, T[who]);

  try {
    // ---------------------------------------------------------------- driving the real endpoints
    const apps = {};
    const addApp = async (key, cand, req, who) => {
      let r = await C('POST', '/applications', who, { candidateId: cand.id, requirementId: req.id });
      if (r.status === 409 && r.body && r.body.code === 'NEEDS_OVERRIDE') r = await C('POST', '/applications', who, { candidateId: cand.id, requirementId: req.id, overrideReason: 'history test fit' });
      const id = r.body && (r.body.id || (r.body.application && r.body.application.id));
      if (!id) throw new Error(`could not add ${key}: ${JSON.stringify(err(r))}`);
      apps[key] = id;
      return id;
    };
    const mv = async (who, id, stage, extra = {}) => {
      const r = await C('PATCH', `/applications/${id}/stage`, who, { stage, comment: 'history test', ...extra });
      if (!ok2(r)) throw new Error(`move to ${stage} by ${who} failed: ${JSON.stringify(err(r))}`);
    };
    const toShare = async (id, rw, tlw) => {
      await mv(rw, id, 'RECRUITER_REVIEW'); await mv(rw, id, 'TL_REVIEW'); await mv(tlw, id, 'WITH_BDE'); await mv('bde', id, 'BDE_APPROVED');
      const sl = await C('GET', `/ats/share-checklist/${id}`, 'bdeTl');
      await mv('bdeTl', id, 'SHARED_WITH_CLIENT', { confirmSameClient: true, shareChecklist: Object.fromEntries(((sl.body && sl.body.items) || []).map((i) => [i.key, true])) });
    };
    const toShortlist = async (id, rw, tlw) => { await toShare(id, rw, tlw); await mv('sa', id, 'CLIENT_SHORTLISTED'); };
    const toInterview = async (id, rw, tlw) => {
      await toShortlist(id, rw, tlw);
      const bk = await C('POST', `/ats/interviews/${id}/book`, 'bde', { date: day(1), time: '11:00', mode: 'online', interviewer: 'Hx Panel', meetingLink: 'https://meet.example.test/hx' });
      if (!ok2(bk)) throw new Error(`book: ${JSON.stringify(err(bk))}`);
      const fb = await C('POST', `/ats/interviews/${id}/feedback`, rw, { feedback: 'Good (history test)', result: 'Selected', score: 8 });
      if (!ok2(fb)) throw new Error(`feedback: ${JSON.stringify(err(fb))}`);
    };
    const toSelected = async (id, rw, tlw) => { await toInterview(id, rw, tlw); await mv('bdeTl', id, 'SELECTED'); };
    const toOffer = async (id, rw, tlw) => {
      await toSelected(id, rw, tlw);
      const fd = new FormData();
      fd.append('note', 'Client offer letter (history test)'); fd.append('designation', 'Engineer');
      fd.append('file', new Blob([Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')], { type: 'application/pdf' }), 'hx-offer.pdf');
      const rl = await fetch(`${API}/ats/offers/${id}/client-release`, { method: 'POST', headers: { Authorization: `Bearer ${T.bde}` }, body: fd });
      if (rl.status >= 300) throw new Error(`client-release: ${rl.status} ${(await rl.text()).slice(0, 200)}`);
      const sh = await C('POST', `/ats/offers/${id}/share`, rw, { via: 'Link' });
      if (!ok2(sh)) throw new Error(`offer share: ${JSON.stringify(err(sh))}`);
    };
    const toAccepted = async (id, rw, tlw) => {
      await toOffer(id, rw, tlw);
      let a = await C('POST', `/ats/offers/${id}/accept`, rw, {});
      if (a.status === 409 && a.body && a.body.code === 'CTC_CONFIRM') a = await C('POST', `/ats/offers/${id}/accept`, rw, { confirmCtc: true });
      if (!ok2(a)) throw new Error(`accept: ${JSON.stringify(err(a))}`);
    };
    const toJoined = async (id, rw, tlw, joinedOn) => {
      await toAccepted(id, rw, tlw);
      let s = await C('POST', `/ats/joining/${id}/schedule`, 'bdeTl', { joiningDate: joinedOn, offeredCtc: 800000 });
      if (s.status === 409 && s.body && s.body.code === 'CTC_CONFIRM') s = await C('POST', `/ats/joining/${id}/schedule`, 'bdeTl', { joiningDate: joinedOn, offeredCtc: 800000, confirmCtc: true });
      if (!ok2(s)) throw new Error(`schedule: ${JSON.stringify(err(s))}`);
      let j = await C('POST', `/ats/joining/${id}/joined`, 'bdeTl', { joinedOn, offeredCtc: 800000 });
      if (j.status === 409 && j.body && j.body.code === 'CTC_CONFIRM') j = await C('POST', `/ats/joining/${id}/joined`, 'bdeTl', { joinedOn, offeredCtc: 800000, confirmCtc: true });
      if (!ok2(j)) throw new Error(`joined: ${JSON.stringify(err(j))}`);
    };

    // team 1
    await addApp('a1', P0.a1, R.RA, 'recA'); await toJoined(apps.a1, 'recA', 'tl', day(PLAN.a1.join));
    await addApp('a2', P0.a2, R.RA, 'recA'); await toJoined(apps.a2, 'recA', 'tl', day(PLAN.a2.join));
    await addApp('a3', P0.a3, R.RA, 'recA'); await mv('recA', apps.a3, 'RECRUITER_REVIEW'); await mv('recA', apps.a3, 'TL_REVIEW');
    await mv('tl', apps.a3, 'REJECTED', { rejectedBy: 'Internal', reasonCategory: 'Profile Not Matching', reasonDetail: 'Skills do not fit' });
    await addApp('a4', P0.a4, R.RA, 'recA'); await toShare(apps.a4, 'recA', 'tl');
    await addApp('mA', P0.m, R.RA, 'recA'); await toInterview(apps.mA, 'recA', 'tl'); await mv('sa', apps.mA, 'REJECTED', { rejectedBy: 'Client', reasonCategory: 'Not Selected', reasonDetail: 'Client chose another profile' });
    await addApp('mB', P0.m, R.RB, 'recB'); await toJoined(apps.mB, 'recB', 'tl', day(PLAN.mB.join));
    await addApp('b2', P0.b2, R.RB, 'recB'); await toInterview(apps.b2, 'recB', 'tl'); await mv('sa', apps.b2, 'REJECTED', { rejectedBy: 'Client', reasonCategory: 'Skills Mismatch', reasonDetail: 'Not strong enough' });
    await addApp('b3', P0.b3, R.RB, 'recB'); await toOffer(apps.b3, 'recB', 'tl');
    const dec = await C('POST', `/ats/offers/${apps.b3}/decline`, 'recB', { reason: 'Took a better offer elsewhere' });
    check('setup: the offer is declined through the real endpoint', ok2(dec), err(dec));
    await addApp('b4', P0.b4, R.RB, 'recB');
    // team 2
    await addApp('c1', P0.c1, R.RC, 'recC'); await toShare(apps.c1, 'recC', 'tl2');
    await addApp('c2', P0.c2, R.RC, 'recC');
    // a2 leaves after joining
    const jd = await C('GET', `/join-drop/application/${apps.a2}`, 'sa');
    const recId = jd.body && jd.body.record && jd.body.record.id;
    const dropRes = recId ? await C('POST', `/join-drop/${recId}/drop`, 'sa', { droppedOn: day(PLAN.a2.left), reason: 'Resigned', reasonDetail: 'Personal' }) : null;
    check('setup: a joined person is reported as left after joining', !!dropRes && ok2(dropRes), dropRes && err(dropRes));

    // known dates: back-date what the endpoints stamped with "now"
    const setEv = async (key, toStage, off) => {
      const evs = await prisma.applicationStageEvent.findMany({ where: { applicationId: apps[key], toStage }, orderBy: { createdAt: 'asc' } });
      if (evs[0]) await prisma.applicationStageEvent.update({ where: { id: evs[0].id }, data: { createdAt: noon(day(off)) } });
    };
    for (const [k, p] of Object.entries(PLAN)) { // eslint-disable-line no-restricted-syntax
      /* eslint-disable no-await-in-loop */
      await prisma.application.update({ where: { id: apps[k] }, data: { createdAt: noon(day(p.added)), ...(p.off !== undefined ? { offerAcceptedAt: noon(day(p.off + 1)) } : {}) } });
      if (p.shared !== undefined) await setEv(k, 'SHARED_WITH_CLIENT', p.shared);
      if (p.int !== undefined) {
        await setEv(k, 'INTERVIEW_SCHEDULED', p.int);
        const ie = await prisma.interviewEvent.findFirst({ where: { applicationId: apps[k], status: 'SCHEDULED' }, orderBy: { createdAt: 'asc' } });
        if (ie) await prisma.interviewEvent.update({ where: { id: ie.id }, data: { createdAt: noon(day(p.int)) } });
      }
      if (p.sel !== undefined) await setEv(k, 'SELECTED', p.sel);
      if (p.off !== undefined) await setEv(k, 'OFFER', p.off);
      if (p.tlReject !== undefined) await setEv(k, 'REJECTED', p.tlReject);
      if (p.clientReject !== undefined) await setEv(k, 'REJECTED', p.clientReject);
      /* eslint-enable no-await-in-loop */
    }
    // a handover, a note, a message (the candidate page's timeline): raw rows exactly as the app writes them
    await prisma.auditLog.create({ data: { userId: sa.id, actorName: sa.name, action: 'Candidate handed over (test)', entity: 'Application', entityId: apps.a4, fromValue: recA.name, toValue: recB.name, reason: 'Workload', createdAt: noon(day(-10)) } });
    await prisma.candidateNote.create({ data: { candidateId: P0.m.id, body: 'Spoke to the candidate: keen on the data role', authorName: recB.name, authorRole: 'RECRUITER', createdAt: noon(day(-26)) } });
    await prisma.candidateMessage.create({ data: { candidateId: P0.m.id, channel: 'Email', template: 'INTERVIEW_SCHEDULED', templateLabel: 'Interview booked', trigger: 'test', recipient: 'x@hx-test.in', status: 'SENT', senderName: recB.name, sentAt: noon(day(-23)) } });

    // what the creditedJoinings rule says: the ground truth for whom a joining belongs to
    const RJ = require('../src/utils/recruiterJoinings');
    const cjAll = await RJ.creditedJoinings(await resolveIdentity(sa.id), { from: day(-60), to: day(0), fresh: true });
    const ownerOf = { a1: recA.id, a2: recA.id, mB: recB.id };
    const creditedTo = {};
    cjAll.list.forEach((x) => { const k = Object.keys(apps).find((kk) => apps[kk] === x.id); if (k) creditedTo[k] = (x.creditedTo && x.creditedTo.userId) || ownerOf[k]; });
    console.log(`      credited joinings: ${JSON.stringify(Object.fromEntries(Object.entries(creditedTo).map(([k, u]) => [k, u === recA.id ? 'recA' : u === recB.id ? 'recB' : u === recC.id ? 'recC' : u])))}`);

    const tile = (body, k) => (body.funnel.find((t) => t.key === k) || {}).count;
    const q = (o) => Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const sameCols = (r, e) => !!r && COLS.every((f) => r[f] === e[f]);

    // ---------------------------------------------------------------- 1. recruiter page
    const RA = await C('GET', `/ats/history/recruiter/${recA.id}`, 'sa');
    check('the Admin opens a recruiter page', RA.status === 200 && !!RA.body.funnel, err(RA));
    const pa = RA.body.person;
    check('header: name, role, department, section, team lead, status, since', pa.name === recA.name && pa.role === 'Recruiter' && pa.department === DEPT && pa.section === TEAM && pa.teamLead === tl.name && pa.active === true && !!pa.since.day, pa);
    const ta = (k) => tile(RA.body, k);
    check('recruiter A tiles: sourced 5, approved 5, sent 4, shortlisted 3, interviews 3, selected 2, offers 2', ta('sourced') === 5 && ta('approved') === 5 && ta('shared') === 4 && ta('shortlisted') === 3 && ta('interviewScheduled') === 3 && ta('selected') === 2 && ta('offerReleased') === 2, RA.body.funnel.map((t) => [t.key, t.count]));
    const expJoinedA = Object.entries(creditedTo).filter(([k, u]) => u === recA.id && k === 'a1').length;
    check('recruiter A: joined (still working) = a1 only; a2 (left after joining) is not in it', ta('joined') === 1 && expJoinedA === 1 && !RA.body.rows.some((r) => r.applicationId === apps.a2 && r.outcome === 'joined'), { joined: ta('joined'), credited: creditedTo });
    check('recruiter A: dropped = a2 (left after joining), a3 (TL reject), m (client reject) = 3; left after joining = 1', ta('dropped') === 3 && ta('left') === 1, RA.body.funnel.map((t) => [t.key, t.count]));
    check('recruiter A: joined + dropped + in process = sourced', ta('joined') + ta('dropped') + ta('inprocess') === ta('sourced'), RA.body.funnel.map((t) => [t.key, t.count]));
    check('recruiter A: the requirement list has RA with its own numbers', RA.body.requirements.some((r) => r.id === R.RA.id && r.numbers.sourced === 5 && r.numbers.shared === 4 && r.client.includes('Hxpeople')), RA.body.requirements);
    const rowA = (k) => RA.body.rows.find((r) => r.applicationId === apps[k]);
    check('recruiter A table: a1 has added, sent, selected, offer and joining dates', rowA('a1') && rowA('a1').added.day === day(-40) && rowA('a1').sent.day === day(-38) && rowA('a1').selected.day === day(-34) && rowA('a1').offer.day === day(-33) && rowA('a1').joinDay === day(-31), rowA('a1'));
    check('recruiter A table: a2 is dropped (left after joining) with date, reason and who', rowA('a2') && rowA('a2').outcome === 'dropped' && rowA('a2').drop.type === 'left_after_joining' && rowA('a2').drop.day === day(-2) && /Resigned/.test(rowA('a2').drop.reason), rowA('a2') && rowA('a2').drop);
    check('recruiter A table: a3 TL reject, m (RA application) client reject with reason', rowA('a3').drop.type === 'tl' && rowA('mA').drop.type === 'client' && /Not Selected/.test(rowA('mA').drop.reason), [rowA('a3').drop, rowA('mA').drop]);
    // day-wise
    const dayWise = await C('GET', `/ats/history/recruiter/${recA.id}?${q({ grain: 'day', from: day(-45), to: day(0) })}`, 'sa');
    const rowsA = plan('A');
    const badDays = [];
    for (let off = -45; off <= 0; off += 1) { const r = dayWise.body.series.rows.find((x) => x.key === day(off)); if (!sameCols(r, expect(rowsA, off, off))) badDays.push([off, r, expect(rowsA, off, off)]); }
    check('recruiter A day-wise table: all 46 days match the plan (added, sent, interviews, selected, offers, dropped)', dayWise.status === 200 && dayWise.body.series.rows.length === 46 && badDays.length === 0, badDays.slice(0, 2));
    const dayTotal = dayWise.body.series.total;
    check('recruiter A day-wise totals equal the funnel (added 5, sent 4, interviews 3, selected 2, offers 2, dropped 3)', dayTotal.added === ta('sourced') && dayTotal.sent === ta('shared') && dayTotal.interviews === ta('interviewScheduled') && dayTotal.selected === ta('selected') && dayTotal.offers === ta('offerReleased') && dayTotal.dropped === ta('dropped'), dayTotal);
    // month-wise
    const monthWise = await C('GET', `/ats/history/recruiter/${recA.id}?${q({ grain: 'month', from: day(-60), to: day(0) })}`, 'sa');
    const ym = (off) => day(off).slice(0, 7);
    const badMonths = [];
    for (const m of new Set([-60, -45, -40, -30, -20, -10, -2, 0].map(ym))) {
      const e = Object.fromEntries(COLS.map((f) => [f, 0]));
      for (let off = -60; off <= 0; off += 1) if (ym(off) === m) { const x = expect(rowsA, off, off); COLS.forEach((f) => { e[f] += x[f]; }); }
      const r = monthWise.body.series.rows.find((x) => x.key === m);
      if (!sameCols(r, e)) badMonths.push([m, r, e]);
    }
    check('recruiter A month-wise table matches the plan for every month', monthWise.status === 200 && badMonths.length === 0, badMonths.slice(0, 2));
    const weekWise = await C('GET', `/ats/history/recruiter/${recA.id}?${q({ grain: 'week', from: day(-45), to: day(0) })}`, 'sa');
    check('recruiter A week-wise table: totals equal the day-wise totals', weekWise.status === 200 && COLS.every((f) => weekWise.body.series.total[f] === dayTotal[f]), weekWise.body && weekWise.body.series.total);
    check('trend rows carry the follow-up and call columns', 'followups' in dayWise.body.series.rows[0] && 'calls' in dayWise.body.series.rows[0]);
    check('targets vs achieved by month: every month has the achieved joinings; they add up to the joined tile', RA.body.targets.length > 0 && RA.body.targets.every((t) => 'achieved' in t && 'target' in t) && RA.body.targets.reduce((n, t) => n + t.achieved, 0) === ta('joined'), RA.body.targets.slice(0, 3));
    check('handovers: A gave one (to B), took none', RA.body.handovers.given.length === 1 && RA.body.handovers.given[0].to === recB.name && RA.body.handovers.taken.length === 0, RA.body.handovers);
    const RBp = await C('GET', `/ats/history/recruiter/${recB.id}`, 'sa');
    check('recruiter B tiles: sourced 4, sent 3, interviews 3, selected 2, offers 2, dropped 2 (client reject, offer declined)', tile(RBp.body, 'sourced') === 4 && tile(RBp.body, 'shared') === 3 && tile(RBp.body, 'interviewScheduled') === 3 && tile(RBp.body, 'selected') === 2 && tile(RBp.body, 'offerReleased') === 2 && tile(RBp.body, 'dropped') === 2, RBp.body.funnel.map((t) => [t.key, t.count]));
    check('recruiter B: handovers taken 1 (a4)', RBp.body.handovers.taken.length === 1 && RBp.body.handovers.taken[0].candidate.includes('a4'), RBp.body.handovers);
    const rowB = (k) => RBp.body.rows.find((r) => r.applicationId === apps[k]);
    check('recruiter B table: b3 declined the offer, b2 client reject, b4 in process', rowB('b3').drop.type === 'declined_offer' && rowB('b2').drop.type === 'client' && rowB('b4').outcome === 'inprocess', [rowB('b3').drop, rowB('b2').drop, rowB('b4').outcome]);
    const fil = await C('GET', `/ats/history/recruiter/${recA.id}?${q({ from: day(-41), to: day(-36) })}`, 'sa');
    check('a date range narrows the recruiter tiles (a1, a2, a3, m were active between -41 and -36)', fil.status === 200 && tile(fil.body, 'sourced') === 4 && tile(fil.body, 'shared') === 3 && tile(fil.body, 'interviewScheduled') === 1 && tile(fil.body, 'dropped') === 1, fil.body.funnel.map((t) => [t.key, t.count]));

    // ---------------------------------------------------------------- 2. TL page
    const TLp = await C('GET', `/ats/history/tl/${tl.id}`, 'sa');
    check('the Admin opens the TL (team) page', TLp.status === 200 && !!TLp.body.members, err(TLp));
    check('TL header: name, department, section; members = recruiter A and B', TLp.body.person.name === tl.name && TLp.body.person.section === TEAM && TLp.body.team.members === 2 && TLp.body.members.filter((m) => m.id).map((m) => m.id).sort().join() === [recA.id, recB.id].sort().join(), TLp.body.team);
    const keys = ['sourced', 'approved', 'shared', 'shortlisted', 'interviewScheduled', 'selected', 'offerReleased', 'joined', 'dropped', 'left', 'inprocess'];
    const sumMembers = Object.fromEntries(keys.map((k) => [k, TLp.body.members.reduce((n, m) => n + m.totals[k], 0)]));
    check('team totals equal the sum of the members (every tile)', keys.every((k) => sumMembers[k] === TLp.body.total[k] && TLp.body.total[k] === tile(TLp.body, k)), { sum: sumMembers, total: TLp.body.total });
    check('team tiles: sourced 9, sent 7, dropped 5 (a2 left, a3, m, b2, b3)', tile(TLp.body, 'sourced') === 9 && tile(TLp.body, 'shared') === 7 && tile(TLp.body, 'dropped') === 5, TLp.body.funnel.map((t) => [t.key, t.count]));
    check('team joined (still working) = recruiter A + recruiter B; the person who left is in Dropped, not Joined', tile(TLp.body, 'joined') === ta('joined') + tile(RBp.body, 'joined') && tile(TLp.body, 'left') === 1 && TLp.body.droppedList.some((r) => r.drop.type === 'left_after_joining') && !TLp.body.joinedList.some((r) => r.applicationId === apps.a2), { joinedList: TLp.body.joinedList.length });
    check('team page does not contain team two (c1, c2, requirement RC)', !JSON.stringify(TLp.body).includes(`Hxperson c1 ${RUN}`) && TLp.body.requirements.every((r) => r.id !== R.RC.id), TLp.body.requirements.map((r) => r.title));
    check('team: requirements handled (RA, RB), one client served with 2 requirements, 5 dropped listed', TLp.body.requirements.length === 2 && TLp.body.clients.length === 1 && TLp.body.clients[0].requirements === 2 && TLp.body.droppedList.length === 5, [TLp.body.requirements.length, TLp.body.clients]);
    const tDay = await C('GET', `/ats/history/tl/${tl.id}?${q({ grain: 'day', from: day(-45), to: day(0) })}`, 'sa');
    const teamPlan = [...plan('A'), ...plan('B')];
    const badT = [];
    for (let off = -45; off <= 0; off += 1) { const r = tDay.body.series.rows.find((x) => x.key === day(off)); if (!sameCols(r, expect(teamPlan, off, off))) badT.push([off, r, expect(teamPlan, off, off)]); }
    check('team day-wise numbers match the plan on every day', tDay.status === 200 && badT.length === 0, badT.slice(0, 2));
    const tMonth = await C('GET', `/ats/history/tl/${tl.id}?${q({ grain: 'month', from: day(-60), to: day(0) })}`, 'sa');
    check('team month-wise totals equal the day-wise totals', tMonth.status === 200 && COLS.every((f) => tMonth.body.series.total[f] === tDay.body.series.total[f]), [tMonth.body.series.total, tDay.body.series.total]);
    const TL2 = await C('GET', `/ats/history/tl/${tl2.id}`, 'sa');
    check('the other team (TL two) has recruiter C only: sourced 2, sent 1', TL2.status === 200 && TL2.body.team.members === 1 && tile(TL2.body, 'sourced') === 2 && tile(TL2.body, 'shared') === 1, TL2.body.funnel && TL2.body.funnel.map((t) => [t.key, t.count]));

    // ---------------------------------------------------------------- 3. candidate page
    const CAs = await C('GET', `/ats/history/candidate/${P0.m.id}`, 'sa');
    check('the Admin opens a candidate page', CAs.status === 200 && !!CAs.body.timeline, err(CAs));
    const cT = CAs.body.totals;
    check('candidate m totals: 2 applications, 1 selected, 1 rejected, 1 offered, 1 joined, 1 dropped, 0 withdrawn', cT.applications === 2 && cT.selected === 1 && cT.rejected === 1 && cT.offered === 1 && cT.joined === 1 && cT.dropped === 1 && cT.withdrawn === 0, cT);
    check('candidate m: the rejection has the reason and who rejected (the client)', CAs.body.rejections.length === 1 && /Not Selected/.test(CAs.body.rejections[0].reason) && CAs.body.rejections[0].by === 'Rejected by the client' && CAs.body.rejectedBy[0].count === 1, CAs.body.rejections);
    check('candidate m: header has name, ID, source, came-on date, phone, email, owners', CAs.body.candidate.name.includes('Hxperson m') && CAs.body.candidate.source === 'Naukri' && !!CAs.body.candidate.cameOn && !!CAs.body.candidate.phone && !!CAs.body.candidate.email && CAs.body.candidate.owners.length >= 1 && !!CAs.body.candidate.code, CAs.body.candidate);
    const apRA = CAs.body.applications.find((x) => x.requirementId === R.RA.id); const apRB = CAs.body.applications.find((x) => x.requirementId === R.RB.id);
    check('candidate m applications: TL, applied, sent, selected, offer, joined, dropped each in its row', apRA && apRB && apRA.tl === tl.name && apRA.added.day === day(-39) && apRA.sent.day === day(-37) && apRA.drop.day === day(-30) && apRB.joinDay === day(-10) && apRB.selected.day === day(-20) && apRB.offer.day === day(-19) && apRB.client.includes('Hxpeople'), [apRA, apRB]);
    const kinds = new Set(CAs.body.timeline.map((e) => e.kind));
    check('candidate m timeline holds sourced, stage moves, interviews, feedback, note, message, document, joined, dropped', ['sourced', 'stage', 'interview', 'feedback', 'note', 'message', 'document', 'joined', 'dropped'].every((k) => kinds.has(k)), [...kinds]);
    const keyOfE = (e) => String(e.at || `${e.day}T12:00:00.000Z`);
    check('candidate timeline is in time order', CAs.body.timeline.every((e, i, a) => i === 0 || keyOfE(a[i - 1]) <= keyOfE(e)), CAs.body.timeline.slice(0, 4));
    const CHo = await C('GET', `/ats/history/candidate/${P0.a4.id}`, 'sa');
    check('a handover appears on the candidate timeline', CHo.status === 200 && CHo.body.timeline.some((e) => e.kind === 'handover' && /Workload/.test(e.text)), CHo.body.timeline && CHo.body.timeline.map((e) => e.kind));
    const CW = await C('GET', `/ats/history/candidate/${P0.b3.id}`, 'sa');
    check('candidate b3: the offer decline is counted as declined (not rejected): declinedOffer 1, rejected 0, dropped 1', CW.body.totals.declinedOffer === 1 && CW.body.totals.rejected === 0 && CW.body.totals.dropped === 1, CW.body.totals);
    const CL = await C('GET', `/ats/history/candidate/${P0.a2.id}`, 'sa');
    check('candidate a2: joined then left: leftAfterJoining 1, joined 0, dropped 1', CL.body.totals.leftAfterJoining === 1 && CL.body.totals.joined === 0 && CL.body.totals.dropped === 1, CL.body.totals);

    // ---------------------------------------------------------------- 4. client page: two big numbers and year / month tables
    const CH = await C('GET', `/ats/history/client/${client.id}`, 'sa');
    check('client: the two big numbers (requirements given 3, joinings)', CH.status === 200 && CH.body.big.requirementsGiven === 3 && CH.body.big.joinings === tile(CH.body, 'joined') && CH.body.big.joinings >= 1, CH.body.big);
    check('client: year table and month table (requirements per month, sent, joined, dropped)', CH.body.breakdown.years.reduce((n, y) => n + y.requirements, 0) === 3 && CH.body.breakdown.months.length >= 2 && CH.body.breakdown.months.reduce((n, m) => n + m.joined, 0) === CH.body.big.joinings && CH.body.breakdown.months.reduce((n, m) => n + m.dropped, 0) === tile(CH.body, 'dropped'), CH.body.breakdown);

    // ---------------------------------------------------------------- 5. Excel
    const dl = async (url, who) => { const r = await fetch(`${API}/ats/history/${url}`, { headers: { Authorization: `Bearer ${T[who]}` } }); return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) }; };
    const xr = await dl(`recruiter/${recA.id}/export?${q({ grain: 'day', from: day(-45), to: day(0) })}`, 'sa');
    const wbR = XLSX.read(xr.buf, { type: 'buffer' });
    check('recruiter Excel: Summary, Funnel, Periods, Targets, Requirements, Candidates', xr.status === 200 && ['Summary', 'Funnel', 'Periods', 'Targets', 'Requirements', 'Candidates'].every((n) => wbR.SheetNames.includes(n)), [xr.status, wbR.SheetNames]);
    const candSheet = XLSX.utils.sheet_to_json(wbR.Sheets.Candidates, { header: 1 });
    check('recruiter Excel: the candidates sheet has one row per candidate (5) with the dates', candSheet.length === 6 && candSheet.some((r) => String(r[0]).includes('Hxperson a1') && r.some((c) => String(c).includes(day(-38)))), candSheet.slice(0, 3));
    const per = XLSX.utils.sheet_to_json(wbR.Sheets.Periods, { header: 1 });
    check('recruiter Excel: the Periods sheet ends with a Total row that equals the page total', per[per.length - 1][0] === 'Total' && per[per.length - 1][2] === dayTotal.sent, per[per.length - 1]);
    const xt = await dl(`tl/${tl.id}/export`, 'sa');
    const wbT = XLSX.read(xt.buf, { type: 'buffer' });
    const mem = XLSX.utils.sheet_to_json(wbT.Sheets.Members, { header: 1 });
    check('TL Excel: the Members sheet lists the members and a Team total row equal to the page', xt.status === 200 && mem[mem.length - 1][0] === 'Team total' && mem[mem.length - 1][1] === TLp.body.total.sourced && mem.length === 4, mem);
    const xc = await dl(`candidate/${P0.m.id}/export`, 'sa');
    const wbC = XLSX.read(xc.buf, { type: 'buffer' });
    check('candidate Excel: Summary, Applications (2 rows), Timeline', xc.status === 200 && ['Summary', 'Applications', 'Timeline'].every((n) => wbC.SheetNames.includes(n)) && XLSX.utils.sheet_to_json(wbC.Sheets.Applications, { header: 1 }).length === 3, [xc.status, wbC.SheetNames]);
    const auditRow = await prisma.auditLog.findFirst({ where: { userId: sa.id, action: { contains: 'exported' }, toValue: { contains: 'row' }, entity: 'AtsReport' }, orderBy: { createdAt: 'desc' } });
    check('downloads are in the export log (audit)', !!auditRow, auditRow);
    check('a recruiter cannot download (403)', (await dl(`recruiter/${recA.id}/export`, 'recA')).status === 403);

    // ---------------------------------------------------------------- 6. search
    const s = async (text, who) => C('GET', `/ats/history/search?q=${encodeURIComponent(text)}`, who);
    const sPeople = await s('hx reca', 'sa');
    check('search a recruiter by name (any case, partial): People group', sPeople.status === 200 && sPeople.body.people.some((p) => p.id === recA.id && p.kind === 'recruiter' && p.department === DEPT), sPeople.body.people);
    const sTl = await s(`HX TL ${RUN}`, 'sa');
    check('search a TL by name: People group, kind tl', sTl.body.people.some((p) => p.id === tl.id && p.kind === 'tl'), sTl.body.people);
    const sSec = await s(TEAM.toLowerCase(), 'sa');
    check('search by section / team name finds its TL and recruiters', [tl.id, recA.id, recB.id].every((id) => sSec.body.people.some((p) => p.id === id)), sSec.body.people.map((p) => p.name));
    const sCand = await s(`hxperson m ${RUN}`, 'sa');
    check('search a candidate by name: Candidates group with counts', sCand.body.candidates.some((c) => c.id === P0.m.id && c.applications === 2 && c.joined === 1), sCand.body.candidates);
    const sPhone = await s(P0.m.phone.slice(-6), 'sa');
    check('search a candidate by part of the phone number', sPhone.body.candidates.some((c) => c.id === P0.m.id), sPhone.body.candidates);
    const sMail = await s(`HXP.M.${RUN}`, 'sa');
    check('search a candidate by part of the email (any case)', sMail.body.candidates.some((c) => c.id === P0.m.id), sMail.body.candidates);
    const sId = await s(P0.m.id.slice(-8).toUpperCase(), 'sa');
    check('search a candidate by candidate ID', sId.body.candidates.some((c) => c.id === P0.m.id), sId.body.candidates);
    const sAll = await s('hxpeople', 'sa');
    check('one search answers all four groups (people, clients, requirements, candidates)', sAll.body.clients.some((c) => c.id === client.id) && sAll.body.requirements.length === 3 && Array.isArray(sAll.body.people) && Array.isArray(sAll.body.candidates), [sAll.body.clients.length, sAll.body.requirements.length]);

    // ---------------------------------------------------------------- 7. access, both directions
    check('recruiter A opens their own page', (await C('GET', `/ats/history/recruiter/${recA.id}`, 'recA')).status === 200);
    check('...but not recruiter B\'s (404, no reason given)', (await C('GET', `/ats/history/recruiter/${recB.id}`, 'recA')).status === 404);
    check('...nor the team lead\'s page', (await C('GET', `/ats/history/tl/${tl.id}`, 'recA')).status === 404);
    check('...nor a candidate of B (404)', (await C('GET', `/ats/history/candidate/${P0.b2.id}`, 'recA')).status === 404);
    const aM = await C('GET', `/ats/history/candidate/${P0.m.id}`, 'recA');
    check('...a shared candidate: only A\'s own application of them (1 of 2)', aM.status === 200 && aM.body.applications.length === 1 && aM.body.applications[0].requirementId === R.RA.id && aM.body.totals.applications === 1, aM.body.totals);
    const sA1 = await s('hx recb', 'recA');
    check('recruiter A searching B\'s name: no result, no leak', sA1.status === 200 && sA1.body.people.length === 0 && !JSON.stringify(sA1.body).includes(recB.name), sA1.body.people);
    const sA2 = await s(`hxperson b2 ${RUN}`, 'recA');
    check('recruiter A searching a candidate outside their scope: no result', sA2.status === 200 && sA2.body.candidates.length === 0, sA2.body.candidates);
    check('recruiter A finds themselves', (await s('hx reca', 'recA')).body.people.some((p) => p.id === recA.id));
    check('the TL opens their own page and both recruiters\' pages', (await C('GET', `/ats/history/tl/${tl.id}`, 'tl')).status === 200 && (await C('GET', `/ats/history/recruiter/${recA.id}`, 'tl')).status === 200 && (await C('GET', `/ats/history/recruiter/${recB.id}`, 'tl')).status === 200);
    check('...but not the other team\'s recruiter or TL (404)', (await C('GET', `/ats/history/recruiter/${recC.id}`, 'tl')).status === 404 && (await C('GET', `/ats/history/tl/${tl2.id}`, 'tl')).status === 404);
    check('...nor the other team\'s candidate (404)', (await C('GET', `/ats/history/candidate/${P0.c1.id}`, 'tl')).status === 404);
    check('...the TL reads a candidate of their own team', (await C('GET', `/ats/history/candidate/${P0.b2.id}`, 'tl')).status === 200);
    const sT = await s('hx rec', 'tl');
    check('TL search: their own recruiters, not the other team\'s', sT.body.people.some((p) => p.id === recA.id) && sT.body.people.some((p) => p.id === recB.id) && !sT.body.people.some((p) => p.id === recC.id), sT.body.people.map((p) => p.name));
    check('TL two cannot open TL one\'s page; opens their own', (await C('GET', `/ats/history/tl/${tl.id}`, 'tl2')).status === 404 && (await C('GET', `/ats/history/tl/${tl2.id}`, 'tl2')).status === 200);
    check('the BDE sees the client history and the requirement history of their desk', (await C('GET', `/ats/history/client/${client.id}`, 'bde')).status === 200 && (await C('GET', `/ats/history/requirement/${R.RA.id}`, 'bde')).status === 200);
    check('...but no recruiter or TL productivity page', (await C('GET', `/ats/history/recruiter/${recA.id}`, 'bde')).status === 404 && (await C('GET', `/ats/history/tl/${tl.id}`, 'bde')).status === 404);
    check('the BDE TL gets no recruiter or TL page either', (await C('GET', `/ats/history/recruiter/${recA.id}`, 'bdeTl')).status === 404 && (await C('GET', `/ats/history/tl/${tl.id}`, 'bdeTl')).status === 404);
    const bM = await C('GET', `/ats/history/candidate/${P0.m.id}`, 'bde');
    check('the BDE gets only the limited candidate view: no phone, email, notes, messages, documents, consent', bM.status === 200 && bM.body.limited === true && bM.body.candidate.phone === undefined && bM.body.candidate.email === undefined && !bM.body.timeline.some((e) => ['note', 'message', 'document', 'consent', 'handover', 'call'].includes(e.kind)) && !JSON.stringify(bM.body).includes(P0.m.email), bM.body.candidate);
    check('a BDE cannot find a candidate by phone', (await s(P0.m.phone.slice(-6), 'bde')).body.candidates.length === 0);
    const sB2 = await s('hx reca', 'bde');
    check('a BDE searching a recruiter name gets no People', sB2.status === 200 && sB2.body.people.length === 0, sB2.body.people);
    check('a BDE of another desk gets nothing of the candidate (404)', (await C('GET', `/ats/history/candidate/${P0.m.id}`, 'bdeX')).status === 404);
    check('billing only for Super Admin / Admin: the Admin sees it, the BDE does not', (await C('GET', `/ats/history/client/${client.id}`, 'sa')).body.billing !== null && (await C('GET', `/ats/history/client/${client.id}`, 'bde')).body.billing === null);
    const clientLogin = await mkUser('clientlogin', { role: 'CLIENT', atsRole: 'CLIENT', clientId: client.id, portalType: 'REVIEWER', portalPerms: 'VIEW' });
    const tCl = await tokenOf(clientLogin.id);
    const clientHits = await Promise.all([`recruiter/${recA.id}`, `tl/${tl.id}`, `candidate/${P0.m.id}`, `client/${client.id}`, `requirement/${R.RA.id}`, 'search?q=hxperson', 'access'].map((u) => fetch(`${API}/ats/history/${u}`, { headers: { Authorization: `Bearer ${tCl}` } }).then((r) => r.status)));
    check('a client login gets none of it (every History address refuses)', clientHits.every((x) => x === 403), clientHits);
    check('no login, no people history (401)', (await call('GET', `/ats/history/recruiter/${recA.id}`, null, null)).status === 401);
    const acc = await C('GET', '/ats/history/access', 'tl');
    check('the access answer tells the screens whom a name may link to', acc.body.kind === 'tl' && acc.body.peopleIds.includes(recA.id) && !acc.body.peopleIds.includes(recC.id), acc.body);
  } catch (e) { failed += 1; total += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 900) : e); }
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
