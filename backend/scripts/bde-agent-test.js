#!/usr/bin/env node
/**
 * THE BDE AGENT (founder 2026-11-20: "whatever information a BDE needs, they search it there and know it ... accurate, quick").
 * A private server on a COPY of the sandbox database with a fixture: two BDEs with their own clients, a BDE TL, a Super Admin, a plain Admin and a
 * recruiter; requirements, shared candidates, interviews today / tomorrow, a selection, an offer, a joining, a drop owing a replacement, invoices paid /
 * overdue, agreements expiring, client follow-ups, a complaint and survey answers. Then:
 *   - a QUESTION BANK (English, Telugu in English letters, Telugu script, typos) with the exact expected facts: accuracy N/N and latency per question
 *   - scope both ways (BDE A never sees BDE B's client or candidate, and the other way), the out-of-scope answer equals the nonsense answer
 *   - the limited view: no candidate phone / e-mail / salary / company / offered CTC in any answer of a BDE or the BDE TL; no invoice amount for a BDE
 *   - the model path with a stub AI: ok (answer from the facts, the model saw no candidate contact), an invented number (thrown away), down, slow
 *   - wrong roles (recruiter, plain Admin) refused; nothing written (read only)
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4520 node scripts/bde-agent-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-bdeagent-${process.pid}.db`);
const STUB = path.join(os.tmpdir(), `zz-bdeagent-stub-${process.pid}.txt`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
fs.writeFileSync(STUB, 'ok');
const PORT = Number(process.env.TEST_PORT) || 4520;
const API = `http://localhost:${PORT}/api`;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'bde-agent-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
  BDE_AGENT_AI_STUB_FILE: STUB, BDE_AGENT_MODEL_MS: '2500',
};
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const L = require('../src/utils/bdeAgentLang');

let failed = 0; let total = 0;
const fails = [];
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; fails.push(name); console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 700)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const t0 = Date.now();
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j, ms: Date.now() - t0 };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } for (const f of [STUB, `${STUB}.last`]) { try { fs.unlinkSync(f); } catch { /* none */ } } process.exit(code); }, 800);
}
const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const T = L.todayIst();
const day = (n) => L.addDays(T, n);
const at = (n, hm = '10:00') => new Date(`${day(n)}T${hm}:00+05:30`);
const inWeek = (d) => d >= L.mondayOf(T) && d <= L.addDays(L.mondayOf(T), 6);
const inMonth = (d) => d.slice(0, 7) === T.slice(0, 7);

(async () => {
  // ------------------------------------------------------------------ the people
  const mk = (tag, name, data) => prisma.user.create({ data: { name, email: `bq.${tag}.${RUN.toLowerCase()}@bq-test.in`, username: `bq.${tag}.${RUN.toLowerCase()}@bq-test.in`, passwordHash: 'x', status: 'Active', hrmsRole: 'NONE', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
  const A = await mk('a', `Anitha Bq${RUN}`, { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE' });
  const B = await mk('b', `Bharath Bq${RUN}`, { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE' });
  const TL = await mk('tl', `Tarun Bq${RUN}`, { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' });
  const SA = await mk('sa', `Sudha Bq${RUN}`, { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', accountsAccess: true, accountsRole: 'SUPER_ADMIN' });
  const AD = await mk('ad', `Arun Bq${RUN}`, { role: 'ADMIN', atsRole: 'ADMIN' });
  const RC = await mk('rc', `Ravi Bq${RUN}`, { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT' });

  // ------------------------------------------------------------------ clients
  const cl = (name, owner, data) => prisma.client.create({ data: { name, bdeOwner: owner.name, ownerDepartment: 'Medical', status: 'Active', clientCode: `BQ${RUN}${name.slice(0, 2).toUpperCase()}`, ...data } });
  const A1 = await cl('Kovida Heartcare Hospital', A, { agreementStatus: 'ACTIVE', agreementStart: day(-345), agreementEnd: day(20), agreementSignedAt: at(-2), agreementFeePercent: 8.33, guaranteePeriod: '90 Days', contactName: 'Dr Meera Rao', contactDesignation: 'HR Head', contactPhone: '9000011111', contactEmail: `meera.${RUN.toLowerCase()}@kovida-test.in` });
  const A2 = await cl('Nelora Polytechnic College', A, { agreementStatus: 'SENT', agreementSentAt: at(-6), ownerDepartment: 'Education' });
  const A3 = await cl('Tarangi Pharma Labs', A, { agreementStatus: 'ACTIVE', agreementStart: day(-290), agreementEnd: day(75), agreementSignedAt: new Date('2025-12-20T10:00:00+05:30'), ownerDepartment: 'Manufacturing', createdAt: new Date(Date.now() - 200 * 86400000) });
  const B1 = await cl('Vishrant Steel Works', B, { agreementStatus: 'ACTIVE', agreementEnd: day(10), agreementSignedAt: new Date('2026-01-10T10:00:00+05:30'), ownerDepartment: 'Manufacturing' });
  const B2 = await cl('Amrutha Diagnostics', B, { agreementStatus: 'SENT', agreementSentAt: at(-3) });

  // ------------------------------------------------------------------ requirements
  let rq = 0;
  const req = (client, title, bde, data) => { rq += 1; return prisma.requirement.create({ data: { title, clientId: client.id, bdeId: bde.id, status: 'OPEN', openings: 1, department: client.ownerDepartment, reqCode: `BQ${RUN}-${rq}`, tl: 'Medical TL', ...data } }); };
  const RA1 = await req(A1, 'Staff Nurse ICU', A, { openings: 3 });
  const RA2 = await req(A1, 'Physiotherapist', A);
  const RA3 = await req(A2, 'Lecturer Mechanical', A, { openings: 2 });
  const RA4 = await req(A3, 'QC Chemist', A, { status: 'CLOSED', createdAt: new Date(Date.now() - 150 * 86400000) });
  const RB1 = await req(B1, 'Welder Fabricator', B, { openings: 5 });
  const RB2 = await req(B2, 'Lab Technician', B, { openings: 2 });

  // ------------------------------------------------------------------ candidates and their steps (events: [toStage, day offset])
  const SECRETS = [];
  let cn = 0;
  const person = async (name, r, stage, events, data = {}) => {
    cn += 1;
    const phone = `98${String(Date.now() + cn).slice(-8)}`;
    const email = `${name.split(' ')[0].toLowerCase()}.${RUN.toLowerCase()}${cn}@bq-cand-test.in`;
    const company = `Zentrix${RUN}${cn} Medicals`;
    SECRETS.push(phone, email, company, `${cn}7.5 LPA`);
    const c = await prisma.candidate.create({ data: { name, phone, email, currentCompany: company, expectedSalary: `${cn}7.5 LPA`, location: `Secretpur${RUN}` } });
    const a = await prisma.application.create({ data: { candidateId: c.id, requirementId: r.id, stage, hiringType: 'Client Placement', ...data } });
    for (const [to, off] of events) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.applicationStageEvent.create({ data: { applicationId: a.id, candidateId: c.id, toStage: to, action: `Moved to ${to}`, createdAt: at(off, '09:30'), requirementId: r.id, requirementTitle: r.title, clientId: r.clientId } });
    }
    return { c, a, events, name };
  };
  const P = {};
  P.c1 = await person('Sravani Kondapalli', RA1, 'SHARED_WITH_CLIENT', [['WITH_BDE', -2], ['SHARED_WITH_CLIENT', -1]]);
  P.c2 = await person('Harika Vemula', RA1, 'SHARED_WITH_CLIENT', [['WITH_BDE', -5], ['SHARED_WITH_CLIENT', -4]]);
  P.c3 = await person('Lakshmi Prasanna', RA1, 'INTERVIEW_SCHEDULED', [['SHARED_WITH_CLIENT', -8], ['CLIENT_SHORTLISTED', -6], ['INTERVIEW_SCHEDULED', -5]], { interviewAt: at(0, '15:00'), interviewStatus: 'SCHEDULED', interviewMode: 'Online' });
  P.c4 = await person('Divya Teja', RA3, 'INTERVIEW_SCHEDULED', [['SHARED_WITH_CLIENT', -9], ['INTERVIEW_SCHEDULED', -3]], { interviewAt: at(1, '11:00'), interviewStatus: 'SCHEDULED' });
  P.c5 = await person('Ramya Sree', RA3, 'INTERVIEW_COMPLETED', [['SHARED_WITH_CLIENT', -12], ['INTERVIEW_SCHEDULED', -6], ['INTERVIEW_COMPLETED', -2]], { interviewAt: at(-2, '12:00'), interviewStatus: 'COMPLETED' });
  P.c6 = await person('Pavani Reddy', RA1, 'SELECTED', [['SHARED_WITH_CLIENT', -14], ['INTERVIEW_COMPLETED', -7], ['SELECTED', -3]]);
  P.c7 = await person('Keerthi Naidu', RA1, 'OFFER', [['SHARED_WITH_CLIENT', -20], ['SELECTED', -6], ['OFFER', -1]], { offerStatus: 'Offer Released', offerDate: day(-1), offeredCtc: 455555 });
  P.c8 = await person('Bhavana Chowdary', RA3, 'OFFER_ACCEPTED', [['SHARED_WITH_CLIENT', -25], ['SELECTED', -9], ['OFFER_ACCEPTED', -4]], { offerStatus: 'Offer Accepted', joiningDate: day(5), offeredCtc: 466666 });
  P.c9 = await person('Swathi Gorantla', RA1, 'JOINED', [['SHARED_WITH_CLIENT', -40], ['SELECTED', -20], ['JOINED', -6]], { joiningDate: day(-6), joinedAt: at(-6), joiningStatus: 'Joined', offeredCtc: 477777 });
  P.c10 = await person('Mounika Pydi', RA1, 'JOINED', [['SHARED_WITH_CLIENT', -50], ['SELECTED', -30], ['JOINED', -15]], { joiningDate: day(-15), joinedAt: at(-15), joiningStatus: 'Replacement Due', rollStatus: 'Dropped', offeredCtc: 488888 });
  P.c11 = await person('Nandini Rao', RA1, 'RECRUITER_REVIEW', [['RECRUITER_REVIEW', -1]]);
  P.c12 = await person('Sirisha Kota', RA4, 'REJECTED', [['SHARED_WITH_CLIENT', -110], ['REJECTED', -100]]);
  P.d1 = await person('Chaitanya Varma', RB1, 'INTERVIEW_SCHEDULED', [['SHARED_WITH_CLIENT', -5], ['INTERVIEW_SCHEDULED', -2]], { interviewAt: at(0, '12:00'), interviewStatus: 'SCHEDULED' });
  P.d2 = await person('Gayathri Bandi', RB2, 'SHARED_WITH_CLIENT', [['SHARED_WITH_CLIENT', -1]]);
  P.d3 = await person('Tejaswini Alla', RB1, 'JOINED', [['SHARED_WITH_CLIENT', -30], ['JOINED', -3]], { joiningDate: day(-3), joinedAt: at(-3), joiningStatus: 'Joined' });
  const A_PEOPLE = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c12'].map((k) => P[k].name);
  const B_PEOPLE = ['d1', 'd2', 'd3'].map((k) => P[k].name);

  // joining & drop records (raw table)
  const JS = require('../src/joindrop/schema');
  await JS.ensure();
  const jr = async (p, r, client, data) => JS.run(`INSERT INTO "JoiningRecord" ("id","applicationId","candidateId","candidateName","requirementId","jobTitle","clientId","clientName","status","joinedOn","offeredCtc","guaranteeDays","guaranteeEndsOn","droppedOn","dropReason","dropWithinGuarantee","createdAt","updatedAt")
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, `jr-${p.a.id}`, p.a.id, p.c.id, p.name, r.id, r.title, client.id, client.name, data.status, data.joinedOn, 499999, 90, data.guaranteeEndsOn || null, data.droppedOn || null, data.dropReason || null, data.within == null ? null : data.within, new Date().toISOString(), new Date().toISOString());
  await jr(P.c9, RA1, A1, { status: 'Joined', joinedOn: day(-6), guaranteeEndsOn: day(84) });
  await jr(P.c10, RA1, A1, { status: 'Dropped', joinedOn: day(-15), guaranteeEndsOn: day(75), droppedOn: day(-2), dropReason: 'Salary issue', within: 1 });
  await jr(P.d3, RB1, B1, { status: 'Joined', joinedOn: day(-3), guaranteeEndsOn: day(87) });

  // invoices (amounts only a Super Admin / Admin / Accounts may read)
  const inv = (n, client, data) => prisma.invoice.create({ data: { invoiceNumber: `BQ${RUN}-0${n}`, clientId: client.id, requirementId: null, amount: 50000, gst: 9000, status: 'Pending', invoiceDate: day(-20), ...data } });
  const I1 = await inv(1, A1, { dueDate: day(-8) });
  const I2 = await inv(2, A1, { status: 'Paid', dueDate: day(-10), paidDate: day(-1), receivedAmount: 59000, invoiceDate: day(-25) });
  const I3 = await inv(3, A2, { dueDate: day(10), amount: 30000, gst: 5400 });
  const I4 = await inv(4, B1, { dueDate: day(-3) });

  // client follow-ups (clientBusiness rows), a complaint, survey answers, credit terms
  const fu = (client, id, data) => prisma.appSetting.create({ data: { key: `clientfu.${client.id}.${id}`, value: JSON.stringify({ id, clientId: client.id, kind: 'followup', status: 'Open', ownerId: A.id, ownerName: A.name, createdAt: new Date(Date.now() - 3 * 86400000).toISOString(), ...data }) } });
  await fu(A1, `a1${RUN.toLowerCase()}`, { title: 'Call Dr Meera about ICU slots', dueDate: T });
  await fu(A2, `a2${RUN.toLowerCase()}`, { title: 'Chase the signed agreement', dueDate: day(-2) });
  await fu(A1, `a3${RUN.toLowerCase()}`, { title: 'Shared two profiles on WhatsApp', dueDate: day(-1), status: 'Done', doneAt: new Date(Date.now() - 86400000).toISOString() });
  await fu(B1, `b1${RUN.toLowerCase()}`, { title: 'Visit the plant', dueDate: T, ownerId: B.id });
  const E = require('../src/utils/atsExperience');
  await E.ensure();
  await E.x('INSERT INTO "AtsComplaint" ("side","clientId","clientName","subject","status","level","createdAt") VALUES (?,?,?,?,?,?,?)', 'client', A1.id, A1.name, 'Late interview feedback', 'Open', 1, new Date().toISOString());
  await E.x('INSERT INTO "AtsComplaint" ("side","clientId","clientName","subject","status","level","createdAt") VALUES (?,?,?,?,?,?,?)', 'client', B1.id, B1.name, 'Wrong profiles', 'Open', 1, new Date().toISOString());
  let sv = 0;
  for (const n of [10, 9, 6]) { sv += 1; await E.x('INSERT INTO "AtsSurvey" ("id","side","event","dedupeKey","clientId","clientName","createdAt","answeredAt","nps") VALUES (?,?,?,?,?,?,?,?,?)', `sv-${RUN}-${sv}`, 'client', 'Quarterly', `sv-${RUN}-${sv}`, A1.id, A1.name, new Date().toISOString(), new Date(Date.now() - sv * 86400000).toISOString(), n); } // eslint-disable-line no-await-in-loop
  const CD = require('../src/utils/clientDepth');
  await CD.ensure();
  await prisma.$executeRawUnsafe('INSERT INTO "ClientCredit" ("clientId","creditDays","creditLimit","byName","at") VALUES (?,?,?,?,?)', A1.id, 30, 500000, 'test', new Date().toISOString());


  // ------------------------------------------------------------------ BDE C: a long book (founder 2026-11-20: "till now", "january 2026 to november 2026", "vcare requirements list")
  // 25 requirements at one client (1 open, 1 paused, 1 request, 22 closed), 130 joinings from Jun 2025 to Oct 2026 (6 left after joining), each with an
  // interview, a share, a selection and an offer before it; 12 invoices; a second client added in March 2026.
  const C = await mk('c', `Chandana Bq${RUN}`, { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE' });
  const VC = await cl('VCare Diagnostics Centre', C, { agreementStatus: 'ACTIVE', agreementEnd: day(400), agreementSignedAt: new Date('2025-05-02T10:00:00+05:30'), createdAt: new Date('2025-05-01T10:00:00+05:30') });
  const SI = await cl('Sitara Eye Care', C, { agreementStatus: 'SENT', createdAt: new Date('2026-03-10T10:00:00+05:30') });
  const VREQ = [];
  VREQ.push({ r: await req(VC, 'Staff Nurse Ward', C, { createdAt: at(-15) }), status: 'OPEN', created: day(-15) });
  for (let i = 0; i < 22; i += 1) {
    const created = L.addDays('2025-07-01', i * 20);
    // eslint-disable-next-line no-await-in-loop
    VREQ.push({ r: await req(VC, `Lab Assistant Batch ${i + 1}`, C, { status: 'CLOSED', createdAt: new Date(`${created}T10:00:00+05:30`) }), status: 'CLOSED', created });
  }
  VREQ.push({ r: await req(VC, 'Radiographer', C, { status: 'ON_HOLD', createdAt: new Date('2026-09-15T10:00:00+05:30') }), status: 'ON_HOLD', created: '2026-09-15' });
  VREQ.push({ r: await req(VC, 'Phlebotomist', C, { status: 'DRAFT', createdAt: new Date('2026-11-01T10:00:00+05:30') }), status: 'DRAFT', created: '2026-11-01' });
  const CJ = []; // { day, left, dropped, shared, selected, offer, interview }
  for (let i = 0; i < 130; i += 1) {
    const jd = L.addDays('2025-06-01', i * 4);
    const left = i % 20 === 10; // 10, 30, 50, 70, 90, 110
    const r = VREQ[1 + (i % 22)].r;
    // eslint-disable-next-line no-await-in-loop
    const cand = await prisma.candidate.create({ data: { name: `Vc${RUN} Person ${String(i + 1).padStart(3, '0')}`, phone: `97${String(Date.now() + 1000 + i).slice(-8)}` } });
    // eslint-disable-next-line no-await-in-loop
    const app = await prisma.application.create({ data: { candidateId: cand.id, requirementId: r.id, stage: 'JOINED', joiningDate: jd, joinedAt: new Date(`${jd}T10:00:00+05:30`), joiningStatus: 'Joined', hiringType: 'Client Placement', interviewAt: new Date(`${L.addDays(jd, -20)}T11:00:00+05:30`), interviewStatus: 'COMPLETED', offerStatus: 'Offer Accepted', offerDate: L.addDays(jd, -10) } });
    const ev = [['SHARED_WITH_CLIENT', L.addDays(jd, -30)], ['SELECTED', L.addDays(jd, -15)], ['OFFER', L.addDays(jd, -10)], ['JOINED', jd]];
    // eslint-disable-next-line no-await-in-loop
    await prisma.applicationStageEvent.createMany({ data: ev.map(([to, d]) => ({ applicationId: app.id, candidateId: cand.id, toStage: to, action: `Moved to ${to}`, createdAt: new Date(`${d}T09:30:00+05:30`), requirementId: r.id, requirementTitle: r.title, clientId: VC.id })) });
    if (left) {
      // eslint-disable-next-line no-await-in-loop
      await JS.run(`INSERT INTO "JoiningRecord" ("id","applicationId","candidateId","candidateName","requirementId","jobTitle","clientId","clientName","status","joinedOn","guaranteeDays","guaranteeEndsOn","droppedOn","dropReason","dropWithinGuarantee","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        `jr-${app.id}`, app.id, cand.id, cand.name, r.id, r.title, VC.id, VC.name, 'Dropped', jd, 90, L.addDays(jd, 90), L.addDays(jd, 20), 'Better offer', 0, new Date().toISOString(), new Date().toISOString());
    }
    CJ.push({ day: jd, left, dropped: left ? L.addDays(jd, 20) : null, shared: L.addDays(jd, -30), selected: L.addDays(jd, -15), offer: L.addDays(jd, -10), interview: L.addDays(jd, -20) });
  }
  const CINV = [];
  for (let i = 0; i < 12; i += 1) {
    const d = new Date('2025-12-05T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + i);
    const invDay = d.toISOString().slice(0, 10);
    const paid = i < 10;
    // eslint-disable-next-line no-await-in-loop
    await prisma.invoice.create({ data: { invoiceNumber: `VC${RUN}-${String(i + 1).padStart(2, '0')}`, clientId: VC.id, amount: 40000, gst: 7200, status: paid ? 'Paid' : 'Pending', invoiceDate: invDay, dueDate: i === 10 ? '2026-10-25' : (i === 11 ? day(10) : L.addDays(invDay, 15)), paidDate: paid ? L.addDays(invDay, 20) : null, receivedAmount: paid ? 47200 : 0 } });
    CINV.push({ invDay, paidDay: paid ? L.addDays(invDay, 20) : null });
  }


  // ------------------------------------------------------------------ TODAY'S WORK for the person / team reports (founder 2026-11-21)
  // BDE A today: 2 client follow-ups + 1 meeting logged, 1 candidate call; BDE B today: 1 client follow-up and a client answer (shortlisted)
  const fuT = (client, id, who, data) => prisma.appSetting.create({ data: { key: `clientfu.${client.id}.${id}`, value: JSON.stringify({ id, clientId: client.id, status: 'Open', ownerId: who.id, ownerName: who.name, createdById: who.id, createdByName: who.name, createdAt: new Date().toISOString(), ...data }) } });
  await fuT(A1, `t1${RUN.toLowerCase()}`, A, { kind: 'followup', title: 'Called Dr Meera about the ICU shortlist', dueDate: day(3) });
  await fuT(A2, `t2${RUN.toLowerCase()}`, A, { kind: 'followup', title: 'Sent the agreement again', dueDate: day(2) });
  await fuT(A1, `t3${RUN.toLowerCase()}`, A, { kind: 'meeting', title: 'Meeting with the ICU head', dueDate: day(4) });
  await fuT(B1, `t4${RUN.toLowerCase()}`, B, { kind: 'followup', title: 'Plant visit fixed', dueDate: day(1) });
  await prisma.applicationFollowUp.create({ data: { applicationId: P.c1.a.id, candidateId: P.c1.c.id, requirementId: RA1.id, ownerUserId: A.id, ownerName: A.name, ownerRole: 'BDE', contactMode: 'Call', purpose: 'Client decision', nextAction: 'Ask Dr Meera for the decision', dueDate: day(2), createdById: A.id, createdByName: A.name } });
  await prisma.client.update({ where: { id: A1.id }, data: { location: `Hanamkonda${RUN}` } });
  P.d4 = await person('Ruchitha Bandaru', RB2, 'CLIENT_SHORTLISTED', []);
  await prisma.applicationStageEvent.createMany({ data: [
    { applicationId: P.d4.a.id, candidateId: P.d4.c.id, fromStage: 'WITH_BDE', toStage: 'SHARED_WITH_CLIENT', action: 'Sent to client', createdAt: at(-2, '09:30'), requirementId: RB2.id, clientId: B2.id },
    { applicationId: P.d4.a.id, candidateId: P.d4.c.id, fromStage: 'SHARED_WITH_CLIENT', toStage: 'CLIENT_SHORTLISTED', action: 'Client shortlisted', createdAt: at(0, '00:30'), requirementId: RB2.id, clientId: B2.id },
  ] });
  B_PEOPLE.push(P.d4.name);

  // ------------------------------------------------------------------ BDE D, whose first name is also three candidates' first name (founder 2026-11-21: "sailaja report"
  // answered "5 records match" with candidates); an Education client with a joining LAST month and nothing this month ("education department joinings" = 0)
  const D = await mk('d', `Zoravati Bq${RUN}`, { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE' });
  const D1 = await cl('Orbita Public School', D, { agreementStatus: 'ACTIVE', ownerDepartment: 'Education' });
  const RD1 = await req(D1, 'PGT Mathematics', D, { openings: 2 });
  P.e1 = await person('Keshav Murthy', RD1, 'JOINED', [['SHARED_WITH_CLIENT', -70], ['JOINED', -40]], { joiningDate: day(-40), joinedAt: at(-40), joiningStatus: 'Joined' });
  P.e2 = await person('Pranitha Goud', RD1, 'INTERVIEW_SCHEDULED', [['SHARED_WITH_CLIENT', -6]], { interviewAt: at(0, '16:00'), interviewStatus: 'SCHEDULED' });
  await fuT(D1, `t5${RUN.toLowerCase()}`, D, { kind: 'followup', title: 'Called the principal', dueDate: day(2) });
  for (const nm of ['Zoravati Kumari', 'Zoravati Rao', 'Zoravati Devi']) await person(nm, RB1, 'WITH_BDE', []); // eslint-disable-line no-await-in-loop

  // ------------------------------------------------------------------ the server
  const stampOf = async () => JSON.stringify(await Promise.all([
    prisma.application.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }), prisma.client.aggregate({ _count: { _all: true } }), prisma.requirement.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
    prisma.invoice.aggregate({ _count: { _all: true }, _sum: { receivedAmount: true } }), prisma.applicationStageEvent.count(), prisma.appSetting.count({ where: { key: { startsWith: 'clientfu.' } } }), prisma.auditLog.count({ where: { entity: { in: ['Client', 'Requirement', 'Application', 'Invoice'] } } }),
  ]));
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  let up = false;
  for (let i = 0; i < 200 && !up; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    up = await fetch(`${API}/health`).then((r) => r.ok).catch(() => false);
    // eslint-disable-next-line no-await-in-loop
    if (!up) await new Promise((r) => { setTimeout(r, 500); });
  }
  if (!up) { console.log(`FAIL  the sandbox server did not answer on port ${PORT} (use another TEST_PORT)`); await stop(1); return; }
  await new Promise((r) => { setTimeout(r, 6000); }); // the server's own start-up jobs (index.js: the drop roll-status heal after 4 s) finish first
  const before = await stampOf();
  const tok = async (u) => jwt.sign({ ...tokenPayload(await resolveIdentity(u.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const tA = await tok(A); const tB = await tok(B); const tC = await tok(C); const tD = await tok(D); const tT = await tok(TL);
  const BDE_LOGINS = (await prisma.user.findMany({ where: { atsRole: 'BDE', status: 'Active' }, select: { name: true, email: true } })).filter((u) => u.name && !/zztest|example\.test/i.test(`${u.name} ${u.email || ''}`)).length; const tS = await tok(SA); const tAD = await tok(AD); const tR = await tok(RC);

  // ------------------------------------------------------------------ who may use it
  check('a recruiter is refused (403)', (await call('POST', '/bde-agent/ask', { question: 'my clients' }, tR)).status === 403);
  check('a plain Admin login may use the BDE Agent (founder 2026-11-20)', (await call('POST', '/bde-agent/ask', { question: 'my clients' }, tAD)).status === 200);
  const ov = await call('GET', '/bde-agent/overview', null, tA);
  check('overview: BDE A has 3 clients, 3 open requirements and role chips', ov.status === 200 && ov.body.clients === 3 && ov.body.openRequirements === 3 && ov.body.chips.includes('My target this month') && ov.body.chips.includes("Today's interviews"), ov.body);
  const ovS = await call('GET', '/bde-agent/overview', null, tS);
  check('overview: the Super Admin gets the "Pending invoice amount" chip, a BDE does not', ovS.status === 200 && ovS.body.chips.includes('Pending invoice amount') && !ov.body.chips.includes('Pending invoice amount'), ovS.body.chips);

  // ------------------------------------------------------------------ expected numbers from the fixture (date math, so any weekday works)
  const evIn = (keys, stage, test) => keys.filter((k) => P[k].events.some(([s, off]) => s === stage && test(day(off)))).length;
  const AK = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c12'];
  const exp = {
    sharedWeek: evIn(AK, 'SHARED_WITH_CLIENT', inWeek), sharedMonth: evIn(AK, 'SHARED_WITH_CLIENT', inMonth), selectedMonth: evIn(AK, 'SELECTED', inMonth),
    ivWeek: [day(0), day(1), day(-2)].filter(inWeek).length, joinMonth: [day(-6), day(-15)].filter(inMonth).length, dropMonth: inMonth(day(-2)) ? 1 : 0, paidMonth: inMonth(day(-1)) ? 1 : 0,
    targetMonth: inMonth(day(-2)) ? 1 : 0,
    ivKovidaWeek: [day(0)].filter(inWeek).length,
  };
  // independent counts for the logins that see the whole sandbox
  const notTest = (n) => !/zztest|example\.test/i.test(n || '');
  const allClients = (await prisma.client.findMany({ select: { name: true, agreementEnd: true, agreementStatus: true } })).filter((c) => notTest(c.name));
  const expTlExpiring = allClients.filter((c) => /^\d{4}-\d{2}-\d{2}/.test(String(c.agreementEnd || '')) && !['CANCELLED', 'REJECTED'].includes(c.agreementStatus) && c.agreementEnd.slice(0, 10) >= T && c.agreementEnd.slice(0, 10) <= day(30)).length;

  const monthsTo = (m0) => { const out = []; for (let m = m0; m <= T.slice(0, 7); m = L.addDays(L.lastOfMonth(`${m}-01`), 1).slice(0, 7)) out.push(m); return out; };
  const evApps = (keys, stages, test) => keys.filter((k) => P[k].events.some(([st, off]) => stages.includes(st) && test(day(off)))).length;
  const wk = {
    shared: evApps(AK, ['SHARED_WITH_CLIENT'], inWeek), selections: evApps(AK, ['SELECTED'], inWeek), offers: evApps(AK, ['OFFER', 'OFFER_ACCEPTED'], inWeek),
    joinings: [day(-6), day(-15)].filter(inWeek).length, drops: inWeek(day(-2)) ? 1 : 0, followupsA: 2 + (inWeek(day(-3)) ? 3 : 0),
  };
  const SAILAJA = ((await prisma.user.findFirst({ where: { atsRole: 'BDE', status: 'Active', name: { startsWith: 'Sailaja' } }, select: { name: true } })) || {}).name || null; // the founder's own example, when the sandbox has her
  const J = (from, to) => CJ.filter((x) => x.day >= from && x.day <= to).length; // BDE C's joinings in a window (all of them, left or not)
  const last3 = (() => { const d = new Date(`${T}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 3); return L.addDays(d.toISOString().slice(0, 10), 1); })();
  // ------------------------------------------------------------------ THE QUESTION BANK
  // [who, question, { intent, count, has: [names in items/title], hasNot: [], text: RegExp, lang }]
  const inv1 = `Invoice BQ${RUN}-01`;
  const BANK = [
    ['A', 'How many clients do I have?', { intent: 'clients', count: 3, has: ['Kovida Heartcare Hospital', 'Nelora Polytechnic College', 'Tarangi Pharma Labs'] }],
    ['A', 'naa clients enni?', { intent: 'clients', count: 3, lang: 'tl' }],
    ['A', 'my cleints list', { intent: 'clients', count: 3 }],
    ['A', 'open requirements', { intent: 'requirements', count: 3, has: ['Staff Nurse ICU', 'Physiotherapist', 'Lecturer Mechanical'], hasNot: ['QC Chemist'] }],
    ['A', 'how many open positions do I have', { intent: 'requirements', count: 3, text: /6 openings/ }],
    ['A', 'requirements with no profiles', { intent: 'requirements_empty', count: 1, has: ['Physiotherapist'] }],
    ['A', "Today's interviews", { intent: 'interviews', count: 1, has: ['Lakshmi Prasanna'] }],
    ['A', 'ee roju interviews enni unnayi', { intent: 'interviews', count: 1, has: ['Lakshmi Prasanna'], lang: 'tl' }],
    ['A', 'interviews tommorow', { intent: 'interviews', count: 1, has: ['Divya Teja'] }],
    ['A', 'repu intervews evi', { intent: 'interviews', count: 1, has: ['Divya Teja'] }],
    ['A', 'upcoming interviews', { intent: 'interviews', count: 2, has: ['Lakshmi Prasanna', 'Divya Teja'] }],
    ['A', 'interviews this week', { intent: 'interviews', count: exp.ivWeek }],
    ['A', 'profiles shared this week', { intent: 'shared', count: exp.sharedWeek }],
    ['A', 'ee vaaram enni profiles share chesam', { intent: 'shared', count: exp.sharedWeek, lang: 'tl' }],
    ['A', 'profiles sent to client this month', { intent: 'shared', count: exp.sharedMonth }],
    ['A', 'pending client feedback', { intent: 'feedback', count: 3, has: ['Sravani Kondapalli', 'Harika Vemula', 'Ramya Sree'] }],
    ['A', 'which profiles has the client not replied to', { intent: 'feedback', count: 3 }],
    ['A', 'feedbak pending', { intent: 'feedback', count: 3 }],
    ['A', 'selected candidates', { intent: 'selections', count: 3, has: ['Pavani Reddy', 'Keerthi Naidu', 'Bhavana Chowdary'] }],
    ['A', 'selections this month', { intent: 'selections', count: exp.selectedMonth }],
    ['A', 'open offers', { intent: 'offers', count: 2, has: ['Keerthi Naidu', 'Bhavana Chowdary'] }],
    ['A', 'offers pending', { intent: 'offers', count: 2 }],
    ['A', 'joinings this month', { intent: 'joinings', count: exp.joinMonth, ...(exp.joinMonth ? { has: ['Swathi Gorantla'] } : {}), text: new RegExp(`^This month \\(${L.monthLabel(T)}\\): ${exp.joinMonth} joining`) }],
    ['A', 'ee nela joinings entha', { intent: 'joinings', count: exp.joinMonth, lang: 'tl' }],
    ['A', 'drops this month', { intent: 'drops', count: exp.dropMonth, ...(exp.dropMonth ? { has: ['Mounika Pydi'] } : {}) }],
    ['A', 'replacements due', { intent: 'replacements', count: 1, has: ['Mounika Pydi'] }],
    ['A', 'replacment due unnaya', { intent: 'replacements', count: 1 }],
    ['A', 'overdue invoices', { intent: 'invoices', count: 1, has: [inv1], hasNot: [`BQ${RUN}-04`] }],
    ['A', 'invoices not paid', { intent: 'invoices', count: 2 }],
    ['A', 'pending invoice amount', { intent: 'invoices', count: 2, text: /Accounts and Admin/ }],
    ['A', 'invoices paid this month', { intent: 'invoices', count: exp.paidMonth }],
    ['A', 'agreements expiring in 30 days', { intent: 'agreements', count: 1, has: ['Kovida Heartcare Hospital'] }],
    ['A', 'agreements not signed', { intent: 'agreements', count: 1, has: ['Nelora Polytechnic College'] }],
    ['A', 'agrement status of Nelora', { intent: 'agreements', text: /Nelora Polytechnic College: Sent/ }],
    ['A', 'credit days for Kovida', { intent: 'agreements', text: /Credit: 30 days, limit Rs 5,00,000/ }],
    ['A', 'follow-ups due', { intent: 'followups', count: 2, text: /Chase the signed agreement/ }],
    ['A', 'follow ups today', { intent: 'followups', count: 2 }],
    ['A', 'my target this month', { intent: 'target', count: exp.targetMonth, text: new RegExp(`${exp.targetMonth} of 4 new clients`) }],
    ['A', 'client complaints', { intent: 'complaints', count: 1, text: /Late interview feedback/ }],
    ['A', 'client NPS', { intent: 'nps', count: 33 }],
    ['A', 'clients with no activity', { intent: 'health', count: 1, has: ['Tarangi Pharma Labs'] }],
    ['A', 'What is pending today?', { intent: 'agenda', text: /Today \(.*\): 1 interviews, 2 follow-ups due, 3 waiting for client feedback/ }],
    ['A', 'Tell me about Kovida Heartcare', { intent: 'client', count: 2, text: /Kovida Heartcare Hospital.*2 open requirements/ }],
    ['A', 'kovida gurinchi cheppu', { intent: 'client', count: 2 }],
    ['A', 'Kovda Heartcare', { intent: 'client', count: 2 }],
    ['A', 'కోవిడా గురించి', { intent: 'client', count: 2, lang: 'te' }],
    ['A', 'Status of Staff Nurse ICU', { intent: 'requirement', text: /Staff Nurse ICU.*Kovida Heartcare Hospital/ }],
    ['A', 'Lecturer Mechanical', { intent: 'requirement', text: /Lecturer Mechanical/ }],
    ['A', 'Where is Sravani Kondapalli?', { intent: 'candidate', text: /Sravani Kondapalli: Sent to client for Staff Nurse ICU/ }],
    ['A', 'sravani', { intent: 'candidate', text: /Sravani Kondapalli/ }],
    ['A', 'Kovida interviews this week', { intent: 'interviews', count: exp.ivKovidaWeek }],
    ['A', 'overdue invoices of Kovida', { intent: 'invoices', count: 1, has: [inv1] }],
    ['A', 'Tell me about Vishrant Steel', { intent: 'not_found', count: 0, hasNot: ['Vishrant Steel Works'] }],
    ['A', 'Tell me about Zorblax Industries', { intent: 'not_found', count: 0 }],
    ['A', 'Where is Chaitanya Varma?', { intent: 'not_found', count: 0, hasNot: ['Welder'] }],
    ['A', 'Nandini Rao', { intent: 'not_found', count: 0 }],
    ['A', 'How do I raise a requirement?', { intent: 'process', text: /team lead posts|The team lead posts/i }],
    ['A', 'how to report a drop', { intent: 'process', text: /Report a drop/ }],
    ['A', 'can i see the candidate phone number?', { intent: 'process', text: /only the name and the progress/ }],
    ['A', 'help', { intent: 'help' }],
    ['A', 'ఈ రోజు ఇంటర్వ్యూలు ఎన్ని', { intent: 'interviews', count: 1, lang: 'te' }],
    ['A', 'interviews today and overdue invoices', { intent: 'interviews+invoices' }],
    ['B', 'how many clients', { intent: 'clients', count: 2, has: ['Vishrant Steel Works', 'Amrutha Diagnostics'] }],
    ['B', "today's interviews", { intent: 'interviews', count: 1, has: ['Chaitanya Varma'] }],
    ['B', 'overdue invoices', { intent: 'invoices', count: 1, has: [`Invoice BQ${RUN}-04`] }],
    ['B', 'Tell me about Kovida Heartcare', { intent: 'not_found', count: 0 }],
    ['B', 'agreements expiring in 30 days', { intent: 'agreements', count: 1, has: ['Vishrant Steel Works'] }],
    ['B', 'Where is Sravani Kondapalli?', { intent: 'not_found', count: 0 }],
    ['TL', 'Tell me about Vishrant Steel', { intent: 'client', text: /Vishrant Steel Works/ }],
    ['TL', 'Tell me about Kovida Heartcare', { intent: 'client', text: /Kovida Heartcare Hospital/ }],
    ['TL', 'agreements expiring in 30 days', { intent: 'agreements', count: expTlExpiring }],
    ['SA', 'overdue invoices of Kovida', { intent: 'invoices', count: 1, text: /Rs 59,000/ }],
    ['SA', 'Nandini Rao', { intent: 'candidate', text: /Nandini Rao: Check by recruiter/ }],
    ['SA', 'how many clients', { intent: 'clients', count: allClients.length }],
    // ---- BDE C: time windows, totals and whole lists (the founder's own questions first)
    ['C', 'how many joinings completed till now', { intent: 'joinings', count: 130, text: new RegExp(`^All time \\(till ${L.dmy(T)}\\): 130 joinings \\(124 still working, 6 left after joining\\)`) }],
    ['C', 'january 2026 to november 2026 joinings list', { intent: 'joinings', count: J('2026-01-01', '2026-11-30'), text: new RegExp(`^Jan 2026 - Nov 2026: ${J('2026-01-01', '2026-11-30')} joinings[\\s\\S]*By month: Jan 2026 ${J('2026-01-01', '2026-01-31')} · Feb 2026 ${J('2026-02-01', '2026-02-28')}`) }],
    ['C', 'vcare requiremnts list', { intent: 'requirements_all', count: 25, text: /: 25 requirements - VCare Diagnostics Centre \(Open 1 · Paused \/ on hold 1 · Request, not live yet 1 · Closed 22\)/, has: ['Staff Nurse Ward', 'Lab Assistant Batch 1 ', 'Lab Assistant Batch 22', 'Radiographer', 'Phlebotomist'], items: 25 }],
    ['C', 'how many requiremnts are there from vcare', { intent: 'requirements_all', count: 25, text: /Open 1 · Paused \/ on hold 1 · Request, not live yet 1 · Closed 22/ }],
    ['C', 'joinings till now', { intent: 'joinings', count: 130, items: 100, more: 30 }],
    ['C', 'ippati varaku enni joinings', { intent: 'joinings', count: 130, lang: 'tl', text: /^Ippati varaku/ }],
    ['C', 'total joinings', { intent: 'joinings', count: 130 }],
    ['C', 'joinings so far', { intent: 'joinings', count: 130 }],
    ['C', 'how many joinings in 2025', { intent: 'joinings', count: J('2025-01-01', '2025-12-31'), text: /^2025: / }],
    ['C', 'ee samvatsaram joinings enni', { intent: 'joinings', count: J(`${T.slice(0, 4)}-01-01`, `${T.slice(0, 4)}-12-31`), lang: 'tl' }],
    ['C', 'gatha samvatsaram joinings', { intent: 'joinings', count: J(`${Number(T.slice(0, 4)) - 1}-01-01`, `${Number(T.slice(0, 4)) - 1}-12-31`) }],
    ['C', 'janavari nundi navambar varaku joinings', { intent: 'joinings', count: J(`${T.slice(0, 4)}-01-01`, `${T.slice(0, 4)}-11-30`), lang: 'tl' }],
    ['C', 'joinings from march to june 2026', { intent: 'joinings', count: J('2026-03-01', '2026-06-30'), text: /^Mar 2026 - Jun 2026: / }],
    ['C', 'joinings between 01/02/2026 and 15/03/2026', { intent: 'joinings', count: J('2026-02-01', '2026-03-15'), text: /^1 Feb 2026 - 15 Mar 2026: / }],
    ['C', 'joinings since august 2026', { intent: 'joinings', count: J('2026-08-01', T) }],
    ['C', 'joinings before june 2026', { intent: 'joinings', count: J('2000-01-01', '2026-05-31'), text: /^Till 31 May 2026: / }],
    ['C', 'joinings in october 2026', { intent: 'joinings', count: J('2026-10-01', '2026-10-31') }],
    ['C', 'jan 2026 joinings', { intent: 'joinings', count: J('2026-01-01', '2026-01-31'), text: /^Jan 2026: / }],
    ['C', 'oct 2025 to feb 2026 joinings', { intent: 'joinings', count: J('2025-10-01', '2026-02-28') }],
    ['C', 'joinings 2026-01-05 to 2026-02-10', { intent: 'joinings', count: J('2026-01-05', '2026-02-10') }],
    ['C', 'joinings last 3 months', { intent: 'joinings', count: J(last3, T) }],
    ['C', 'joinings still working till now', { intent: 'joinings', count: 124 }],
    ['C', 'how many joinings in total for vcare', { intent: 'joinings', count: 130 }],
    ['C', 'జనవరి నుండి నవంబర్ వరకు జాయినింగ్స్', { intent: 'joinings', count: J(`${T.slice(0, 4)}-01-01`, `${T.slice(0, 4)}-11-30`), lang: 'te' }],
    ['C', 'drops till now', { intent: 'drops', count: 6 }],
    ['C', 'drops in 2026', { intent: 'drops', count: CJ.filter((x) => x.dropped && x.dropped.startsWith('2026')).length }],
    ['C', 'profiles shared from march to june 2026', { intent: 'shared', count: CJ.filter((x) => x.shared >= '2026-03-01' && x.shared <= '2026-06-30').length }],
    ['C', 'profiles shared till now', { intent: 'shared', count: 130 }],
    ['C', 'selections in 2025', { intent: 'selections', count: CJ.filter((x) => x.selected.startsWith('2025')).length }],
    ['C', 'offers from january to march 2026', { intent: 'offers', count: CJ.filter((x) => x.offer >= '2026-01-01' && x.offer <= '2026-03-31').length }],
    ['C', 'interviews in august 2025', { intent: 'interviews', count: CJ.filter((x) => x.interview.startsWith('2025-08')).length, text: /^Aug 2025: / }],
    ['C', 'vcare closed requirements', { intent: 'requirements_all', count: 22 }],
    ['C', 'vcare open requirements', { intent: 'requirements', count: 1, has: ['Staff Nurse Ward'] }],
    ['C', 'paused requirements of vcare', { intent: 'requirements_all', count: 1, has: ['Radiographer'] }],
    ['C', 'requirements created this year', { intent: 'requirements_all', count: VREQ.filter((x) => x.created.startsWith(T.slice(0, 4))).length }],
    ['C', 'requirements list', { intent: 'requirements_all', count: 25 }],
    ['C', 'invoices paid from january to june 2026', { intent: 'invoices', count: CINV.filter((x) => x.paidDay && x.paidDay >= '2026-01-01' && x.paidDay <= '2026-06-30').length }],
    ['C', 'invoices raised in 2026', { intent: 'invoices', count: CINV.filter((x) => x.invDay.startsWith('2026')).length }],
    ['C', 'new clients this year', { intent: 'clients', count: 1, has: ['Sitara Eye Care'] }],
    ['C', 'clients added in march 2026', { intent: 'clients', count: 1, has: ['Sitara Eye Care'] }],
    ['C', 'how many clients', { intent: 'clients', count: 2, text: /^Now \(/ }],
    ['C', 'Tell me about VCare', { intent: 'client', text: /Requirements: 25 in all \(Open 1 · Paused \/ on hold 1 · Request, not live yet 1 · Closed 22\)/ }],

    // ---- round 3: people, the team, departments, history, keywords (founder 2026-11-21) --------------------------------------------
    // BDE: own work only
    ['A', 'my report today', { intent: 'person', stats: { followups: 2, meetings: 1, candFollowups: 1, calls: 1, reqsRaised: 3, reqsClosed: 1, shared: 0, interviews: 1, feedbackIn: 0, selections: 0, offers: 0, joinings: 0, drops: 0, newClients: 2, signed: 0, replacementsDue: 1, invOverdue: 1, lateFollowups: 1 }, text: new RegExp(`^Today \\(${L.dm(T)}\\): ${A.name} - 1 interview, 2 client follow-ups`) }],
    ['A', 'My work today', { intent: 'person', stats: { followups: 2, interviews: 1 } }],
    ['A', 'naa report ee roju', { intent: 'person', lang: 'tl', stats: { followups: 2, interviews: 1 } }],
    ['A', 'my report this week', { intent: 'person', stats: { shared: wk.shared, interviews: exp.ivWeek, selections: wk.selections, offers: wk.offers, joinings: wk.joinings, drops: wk.drops, followups: wk.followupsA } }],
    ['A', 'my interviews this week', { intent: 'interviews', count: exp.ivWeek }],
    ['A', 'my joinings month wise', { intent: 'history_joinings', count: 2 }],
    ['A', 'my clients', { intent: 'clients', count: 3 }],
    ['A', 'my pending', { intent: 'pending', stats: { lateFollowups: 1 } }],
    ['A', 'all BDEs report', { intent: 'person', text: /only your own work/, hasNot: [B.name, C.name] }],
    ['A', 'who did most interviews this week', { intent: 'person', hasNot: [B.name, C.name] }],
    ['A', `${B.name} interviews today`, { intent: 'interviews', count: 1, has: ['Lakshmi Prasanna'], hasNot: ['Chaitanya Varma'] }],
    ['B', 'my report today', { intent: 'person', stats: { followups: 1, interviews: 1, feedbackIn: 1, shared: 0 } }],
    ['B', 'team report this month', { intent: 'person', hasNot: [A.name, C.name] }],
    ['C', 'my month', { intent: 'person', stats: { reqsRaised: VREQ.filter((x) => inMonth(x.created)).length, reqsClosed: 22, joinings: J(`${T.slice(0, 7)}-01`, L.lastOfMonth(T)), newClients: 0 } }],
    // BDE TL: one person
    // (2026-11-27) a name / "report" with no period: this month, with today's line on top
    ['TL', A.name.split(' ')[0], { intent: 'person', text: new RegExp(`^This month \\([^)]*\\): ${A.name} - [\\s\\S]*\\nToday \\(${L.dm(T)}\\): 1 interviews, 2 client follow-ups`) }],
    ['TL', `${A.name.split(' ')[0]} today`, { intent: 'person', stats: { followups: 2, meetings: 1, interviews: 1, newClients: 2, reqsRaised: 3 }, text: new RegExp(`^Today \\(${L.dm(T)}\\): ${A.name} - `) }],
    ['TL', 'anita report today', { intent: 'person', stats: { followups: 2, interviews: 1 }, text: new RegExp(A.name) }],
    ['TL', `${A.name.split(' ')[0]} this week`, { intent: 'person', stats: { shared: wk.shared, interviews: exp.ivWeek, selections: wk.selections, offers: wk.offers, joinings: wk.joinings, drops: wk.drops, followups: wk.followupsA } }],
    ['TL', `${B.name.split(' ')[0]} yesterday`, { intent: 'person', stats: { shared: 1, interviews: 0, followups: 0 } }],
    ['TL', `ninna ${B.name.split(' ')[0]} report`, { intent: 'person', lang: 'tl', stats: { shared: 1 } }],
    ['TL', `${C.name} joinings till now`, { intent: 'joinings', count: 130, text: new RegExp(`^All time \\(till ${L.dmy(T)}\\): ${C.name} - 130 joinings`) }],
    ['TL', `clients of ${B.name.split(' ')[0]}`, { intent: 'clients', count: 2, has: ['Vishrant Steel Works', 'Amrutha Diagnostics'], text: new RegExp(B.name) }],
    ['TL', `${A.name.split(' ')[0]} pending`, { intent: 'pending', stats: { lateFollowups: 1 } }],
    ['TL', `${A.name.split(' ')[0]} interviews today`, { intent: 'interviews', count: 1, has: ['Lakshmi Prasanna'] }],
    ['TL', `${C.name.split(' ')[0]} ee nela report`, { intent: 'person', stats: { reqsClosed: 22 } }],
    ['TL', `${A.name.split(' ')[0]} joinings month wise`, { intent: 'history_joinings', count: 2 }],
    ['SA', `${A.name.split(' ')[0]} today`, { intent: 'person', stats: { followups: 2, interviews: 1 } }],
    // BDE TL: the team
    ['TL', 'all BDEs today', { intent: 'team', rows: { [A.name]: { followups: 2, interviews: 1, shared: 0, joinings: 0 }, [B.name]: { followups: 1, interviews: 1 }, [C.name]: { followups: 0, interviews: 0, joinings: 0 } }, nrows: BDE_LOGINS }],
    ['TL', 'all BDEs interviews this week', { intent: 'team_metric', rows: { [A.name]: { interviews: exp.ivWeek }, [B.name]: { interviews: 1 }, [C.name]: { interviews: 0 } }, nrows: BDE_LOGINS }],
    ['TL', 'all BDEs joinings till now', { intent: 'team_metric', rows: { [A.name]: { joinings: 2 }, [B.name]: { joinings: 1 }, [C.name]: { joinings: 130 } } }],
    ['TL', 'all BDEs drops this month', { intent: 'team_metric', rows: { [A.name]: { drops: exp.dropMonth }, [B.name]: { drops: 0 }, [C.name]: { drops: 0 } } }],
    ['TL', 'BDE wise follow-ups today', { intent: 'team_metric', rows: { [A.name]: { followups: 2 }, [B.name]: { followups: 1 } } }],
    ['TL', 'team report this month', { intent: 'team', text: new RegExp(`^This month \\(${L.monthLabel(T)}\\): all BDEs`) }],
    ['TL', 'andaru BDEs report ee roju', { intent: 'team', lang: 'tl', rows: { [A.name]: { interviews: 1 } } }],
    ['TL', 'who did most joinings till now', { intent: 'team_metric', topRow: 'joinings' }],
    ['TL', 'all BDEs offers this week', { intent: 'team_metric', rows: { [A.name]: { offers: wk.offers } } }],
    ['SA', 'all BDEs report', { intent: 'team', rows: { [A.name]: { interviews: 1 } } }],
    ['TL', 'team joinings month wise', { intent: 'history_joinings' }],
    // departments
    ['A', 'Education report', { intent: 'department', stats: { clients: 1, requirements: 1, open: 1 } }],
    ['A', 'Medical requirements', { intent: 'requirements_all', count: 2, has: ['Staff Nurse ICU', 'Physiotherapist'] }],
    ['A', 'edu requirements', { intent: 'requirements_all', count: 1, has: ['Lecturer Mechanical'] }],
    ['A', 'Manufacturing clients', { intent: 'clients', count: 1, has: ['Tarangi Pharma Labs'] }],
    ['A', 'Medical joinings this month', { intent: 'joinings', count: exp.joinMonth }],
    ['A', 'Education interviews this week', { intent: 'interviews', count: [day(1), day(-2)].filter(inWeek).length }],
    ['A', 'department report', { intent: 'department', count: 3 }],
    ['A', 'department wise report', { intent: 'department', count: 3 }],
    ['TL', 'Education report', { intent: 'department', text: new RegExp(`BDEs handling [^\\n]*${A.name}`) }],
    ['TL', 'Manufacturing joinings this month', { intent: 'joinings' }],
    // clients and requirements: who handles them
    ['TL', 'who handles Kovida Heartcare', { intent: 'client', text: new RegExp(`Handled by: BDE ${A.name}`) }],
    ['TL', `status of BQ${RUN}-1`, { intent: 'requirement', text: new RegExp(`Handled by: BDE ${A.name}`) }],
    ['A', 'who handles Nelora', { intent: 'client', text: new RegExp(`Handled by: BDE ${A.name}`) }],
    ['TL', 'Vishrant Steel Works', { intent: 'client', text: new RegExp(`Handled by: BDE ${B.name}`) }],
    // history: month-wise / day-wise
    ['C', `month wise joinings ${T.slice(0, 4)}`, { intent: 'history_joinings', count: J(`${T.slice(0, 4)}-01-01`, `${T.slice(0, 4)}-12-31`), table: monthsTo(`${T.slice(0, 4)}-01`).map((m) => J(`${m}-01`, L.lastOfMonth(`${m}-01`))) }],
    ['C', 'nela vaari joinings', { intent: 'history_joinings', count: 130, tableLen: monthsTo('2025-06').length }],
    ['C', 'drops month wise', { intent: 'history_drops', count: 6 }],
    ['C', `day wise joinings october ${T.slice(0, 4)}`, { intent: 'history_joinings', count: J(`${T.slice(0, 4)}-10-01`, `${T.slice(0, 4)}-10-31`), tableLen: 31 }],
    ['A', 'day wise drops last 30 days', { intent: 'history_drops', count: 1, tableLen: 30 }],
    ['A', 'replacements month wise this year', { intent: 'history_replacements', count: 1, text: /0 given, 1 due/ }],
    ['A', 'joinings roju vaari ee vaaram', { intent: 'history_joinings', count: wk.joinings, tableLen: L.daysBetween(L.mondayOf(T), T) + 1, lang: 'tl' }],
    ['A', 'interviews day wise this week', { intent: 'history_interviews', count: exp.ivWeek }],
    ['C', 'monthly offers 2025', { intent: 'history_offers', count: CJ.filter((x) => x.offer.startsWith('2025')).length }],
    ['C', 'vcare joinings month wise', { intent: 'history_joinings', count: 130 }],
    // any small keyword: the scoped search
    ['SA', `BQ${RUN}-04`, { intent: 'search', has: [`Invoice BQ${RUN}-04`] }],
    ['A', `Hanamkonda${RUN}`, { intent: 'client', has: ['Kovida Heartcare Hospital'] }],
    ['A', 'Kondapalli', { intent: 'candidate', text: /Sravani Kondapalli/ }],
    ['A', `Zentrix${RUN}1`, { intent: 'not_found', count: 0 }],
    ['A', `${B.name.split(' ')[0]} report`, { hasNot: [B.name, 'Vishrant', 'Chaitanya'] }],

    // ---- a BDE's name before candidates of the same name; department names with "department" / "dept" (founder 2026-11-21) -----------------
    ...(SAILAJA ? [['SA', 'sailaja report', { intent: 'person', text: new RegExp(`: ${SAILAJA} - `) }], ['TL', 'sailaja ee roju', { intent: 'person', text: new RegExp(`: ${SAILAJA} - `) }]] : []),
    // (2026-11-27) the BDE's exact name: no "also candidates named" line (it is that person)
    ['TL', 'zoravati report today', { intent: 'person', stats: { interviews: 1, followups: 1 }, hasNot: ['Candidates named "zoravati"'] }],
    ['TL', 'Zoravati report', { intent: 'person', text: new RegExp(`^This month \\([^)]*\\): ${D.name} - [\\s\\S]*\\nToday \\(${L.dm(T)}\\): 1 interviews, 1 client follow-ups`) }],
    ['TL', 'zoravati ee roju', { intent: 'person', lang: 'tl', stats: { interviews: 1, followups: 1 } }],
    ['TL', 'zoravati work', { intent: 'person', stats: { interviews: 1 } }],
    ['TL', 'zoravati today', { intent: 'person', stats: { interviews: 1 } }],
    ['TL', 'zorvati report', { intent: 'person', stats: { interviews: 1 } }],
    ['TL', 'Zoravati interviews today', { intent: 'interviews', count: 1, has: ['Pranitha Goud'], text: new RegExp(D.name) }],
    ['TL', 'zoravati joinings', { intent: 'joinings', count: inMonth(day(-40)) ? 1 : 0, text: /Till now: 1 joining \(1 still working, 0 left after joining\)/ }],
    ['TL', 'zoravati clients', { intent: 'clients', count: 1, has: ['Orbita Public School'] }],
    ['SA', 'zoravati report today', { intent: 'person', stats: { interviews: 1 } }],
    ['TL', 'all BDEs today', { intent: 'team', rows: { [D.name]: { interviews: 1, followups: 1 } } }],
    ['A', 'zoravati report', { intent: 'not_found', hasNot: [D.name, 'Zoravati Kumari'] }],
    ['B', 'zoravati report', { intent: 'choose', count: 3, hasNot: [D.name] }],
    ['D', 'education department joinings', { intent: 'joinings', count: inMonth(day(-40)) ? 1 : 0, text: new RegExp(`^This month \\(${L.monthLabel(T)}\\): ${inMonth(day(-40)) ? 1 : 0} joining[\\s\\S]*Till now: 1 joining`), hasNot: ['Marketing'] }],
    ['D', 'education dept joinings', { intent: 'joinings', count: inMonth(day(-40)) ? 1 : 0, text: /Till now: 1 joining/ }],
    ['D', 'edu joinings till now', { intent: 'joinings', count: 1, has: ['Keshav Murthy'] }],
    ['D', 'education dept interviews this week', { intent: 'interviews', count: 1, has: ['Pranitha Goud'] }],
    ['D', 'education department report', { intent: 'department', stats: { clients: 1, requirements: 1, open: 1 } }],
    ['D', 'my report today', { intent: 'person', stats: { interviews: 1, followups: 1 } }],
    ['A', 'medical dept joinings', { intent: 'joinings', count: exp.joinMonth, text: /Till now: 2 joinings \(1 still working, 1 left after joining\)/ }],
    ['A', 'Medical department joinings till now', { intent: 'joinings', count: 2 }],
    ['A', 'manufacturing department requirements', { intent: 'requirements_all', count: 1, has: ['QC Chemist'] }],
    ['A', 'education department joinings', { intent: 'joinings', count: 0, text: /Till now: 0 joinings/ }],
    ['C', 'medical dept joinings this year', { intent: 'joinings', count: J(`${T.slice(0, 4)}-01-01`, `${T.slice(0, 4)}-12-31`) }],
    ['TL', 'Education department report', { intent: 'department', text: new RegExp(`BDEs handling [^\\n]*${D.name}`) }],
    ['TL', 'education department joinings', { intent: 'joinings', text: /Till now: \d+ joining/ }],
    ['A', `agreements expiring in ${['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'][Number(day(20).slice(5, 7)) - 1]}`, { intent: 'agreements', count: 1, has: ['Kovida Heartcare Hospital'] }],

  ];
  const tokOf = { A: tA, B: tB, C: tC, D: tD, TL: tT, SA: tS };
  const lat = [];
  const answersBy = { A: [], B: [], C: [], D: [], TL: [], SA: [] };
  let right = 0;
  for (const [who, q, e] of BANK) {
    // eslint-disable-next-line no-await-in-loop
    const r = await call('POST', '/bde-agent/ask', { question: q }, tokOf[who]);
    lat.push({ q, ms: r.ms });
    const b = r.body || {};
    answersBy[who].push(JSON.stringify(b));
    const a0 = (b.answers || [])[0] || {};
    const blob = `${b.text || ''}\n${(b.answers || []).flatMap((a) => (a.items || []).map((i) => i.label)).join('\n')}`;
    const why = [];
    if (r.status !== 200) why.push(`status ${r.status}`);
    if (b.source !== 'code') why.push(`source ${b.source}`);
    if (e.intent && b.intent !== e.intent) why.push(`intent ${b.intent}`);
    if (e.count !== undefined && a0.count !== e.count) why.push(`count ${a0.count} (expected ${e.count})`);
    (e.has || []).forEach((n) => { if (!blob.includes(n)) why.push(`missing ${n}`); });
    (e.hasNot || []).forEach((n) => { if (blob.includes(n)) why.push(`should not show ${n}`); });
    if (e.text && !e.text.test(b.text || '')) why.push(`text ${String(b.text || '').slice(0, 160)}`);
    if (e.lang && b.lang !== e.lang) why.push(`lang ${b.lang}`);
    if (e.items !== undefined && (a0.items || []).length !== e.items) why.push(`items ${(a0.items || []).length} (expected ${e.items})`);
    if (e.more !== undefined && a0.more !== e.more) why.push(`more ${a0.more} (expected ${e.more})`);
    Object.entries(e.stats || {}).forEach(([k, v]) => { if (!a0.stats || a0.stats[k] !== v) why.push(`stats.${k} ${a0.stats ? a0.stats[k] : '-'} (expected ${v})`); });
    Object.entries(e.rows || {}).forEach(([nm, vals]) => { const row = ((a0.stats && a0.stats.rows) || []).find((x) => x.name === nm); Object.entries(vals).forEach(([k, v]) => { if (!row || row[k] !== v) why.push(`row ${nm}.${k} ${row ? row[k] : '-'} (expected ${v})`); }); });
    if (e.nrows !== undefined && ((a0.stats && a0.stats.rows) || []).length !== e.nrows) why.push(`rows ${((a0.stats && a0.stats.rows) || []).length} (expected ${e.nrows})`);
    if (e.topRow) { const rows = (a0.stats && a0.stats.rows) || []; const top = rows.reduce((m, x) => (x[e.topRow] > (m ? m[e.topRow] : -1) ? x : m), null); if (!top || !String(a0.title).includes(top.name)) why.push(`top row ${top && top.name}`); }
    if (e.table && JSON.stringify(((a0.stats && a0.stats.table) || []).map((x) => x.n)) !== JSON.stringify(e.table)) why.push(`table ${JSON.stringify(((a0.stats && a0.stats.table) || []).map((x) => x.n))} (expected ${JSON.stringify(e.table)})`);
    if (e.tableLen !== undefined && ((a0.stats && a0.stats.table) || []).length !== e.tableLen) why.push(`table rows ${((a0.stats && a0.stats.table) || []).length} (expected ${e.tableLen})`);
    if (!why.length) right += 1;
    check(`[${who}] "${q}" -> ${e.intent}${e.count !== undefined ? ` ${e.count}` : ''} (${r.ms} ms)`, !why.length, why);
  }
  const ms = lat.map((x) => x.ms).sort((a, b) => a - b);
  const pct = (p) => ms[Math.min(ms.length - 1, Math.floor((p / 100) * ms.length))];
  console.log(`\n  QUESTION BANK: ${right}/${BANK.length} right; latency median ${pct(50)} ms, 95th percentile ${pct(95)} ms, slowest ${ms[ms.length - 1]} ms ("${lat.sort((a, b) => b.ms - a.ms)[0].q}")\n`);
  check(`the question bank is 100% right (${right}/${BANK.length})`, right === BANK.length);
  check(`router answers come back under 1.5 s (95th percentile ${pct(95)} ms)`, pct(95) < 1500);
  const aAll = answersBy.A.join('\n');
  check('scope: no answer to BDE A ever names BDE B or BDE C (team / other-person questions give A only their own work)', !aAll.includes(B.name) && !aAll.includes(C.name));
  check('scope: no answer to BDE B names BDE A or BDE C', !answersBy.B.join('\n').includes(A.name) && !answersBy.B.join('\n').includes(C.name));

  // the founder's questions, as answered now (printed for the report)
  for (const q of ['how many joinings completed till now', 'january 2026 to november 2026 joinings list', 'vcare requiremnts list', 'how many requiremnts are there from vcare', 'joinings till now']) {
    // eslint-disable-next-line no-await-in-loop
    const a = (await call('POST', '/bde-agent/ask', { question: q }, tC)).body.answers[0];
    console.log(`      "${q}" -> ${a.title}${a.lines.length ? ` | ${a.lines.join(' | ').slice(0, 220)}` : ''} | ${a.items.length} lines${a.more ? `, +${a.more} more -> ${a.open && a.open.to}` : ''}`);
  }
  // a list longer than 100: the first 100, the exact count, and a link that opens the same list with the filters
  const longList = (await call('POST', '/bde-agent/ask', { question: 'joinings till now' }, tC)).body.answers[0];
  check('a list longer than 100 lines shows 100, says how many more, and links the same list (Joining > Joined and dropped)', longList.items.length === 100 && longList.more === 30 && longList.open && /^\/ats\/joining\?view=joindrop/.test(longList.open.to), { n: longList.items.length, more: longList.more, open: longList.open });
  const vreq = (await call('POST', '/bde-agent/ask', { question: 'vcare requiremnts list' }, tC)).body.answers[0];
  check('a client\'s requirement list: all 25, the open one first, then by status, newest first inside a status', vreq.items.length === 25 && /Staff Nurse Ward/.test(vreq.items[0].label) && /Closed/.test(vreq.items[24].sub) && /Lab Assistant Batch 22/.test(vreq.items.find((i) => /Closed/.test(i.sub)).label), vreq.items.slice(0, 4).map((i) => `${i.label} | ${i.sub}`));
  const cBlob = answersBy.C.join('\n');
  check('scope: BDE C sees none of BDE A\'s or BDE B\'s clients, and A / B never see VCare', !['Kovida Heartcare Hospital', 'Vishrant Steel Works', ...A_PEOPLE, ...B_PEOPLE].some((n) => cBlob.includes(n)) && ![answersBy.A.join(''), answersBy.B.join('')].some((x) => x.includes('VCare Diagnostics')));

  // links on every record
  const linkAns = await call('POST', '/bde-agent/ask', { question: 'Tell me about Kovida Heartcare' }, tA);
  const items = (linkAns.body.answers[0] || {}).items || [];
  check('a client answer links the client page, its history drawer and each open requirement', items.some((i) => i.to === `/clients/${A1.id}`) && items.some((i) => i.history === `/clients/${A1.id}?tab=history`) && items.some((i) => i.to === `/requirements/${RA1.id}`), items);
  const candLinks = ((await call('POST', '/bde-agent/ask', { question: "Today's interviews" }, tA)).body.answers[0] || {}).items || [];
  check('a candidate links to the candidate history (opens in the drawer), never a recruiter page', candLinks.length && candLinks.every((i) => /^\/ats\/history\/candidate\//.test(i.to)) && !JSON.stringify(candLinks).includes('/ats/history/recruiter'), candLinks);
  check('"How I got this": every answer carries the facts it used', (linkAns.body.facts || []).length >= 2 && /Scope:/.test(linkAns.body.facts.join(' ')), linkAns.body.facts);

  // ------------------------------------------------------------------ scope both ways + limited view
  const aBlob = answersBy.A.join('\n'); const bBlob = answersBy.B.join('\n');
  check('scope: no answer of BDE A names a client or candidate of BDE B', !['Vishrant Steel Works', 'Amrutha Diagnostics', ...B_PEOPLE, 'Welder Fabricator', 'Lab Technician'].some((n) => aBlob.includes(n)), ['Vishrant Steel Works', 'Amrutha Diagnostics', ...B_PEOPLE].filter((n) => aBlob.includes(n)));
  check('scope: no answer of BDE B names a client or candidate of BDE A', !['Kovida Heartcare Hospital', 'Nelora Polytechnic College', 'Tarangi Pharma Labs', ...A_PEOPLE].some((n) => bBlob.includes(n)), ['Kovida Heartcare Hospital', ...A_PEOPLE].filter((n) => bBlob.includes(n)));
  const outA = (await call('POST', '/bde-agent/ask', { question: 'Tell me about Vishrant Steel' }, tA)).body;
  const nonA = (await call('POST', '/bde-agent/ask', { question: 'Tell me about Zorblax Steel' }, tA)).body;
  const shape = (b) => JSON.stringify({ i: b.intent, c: b.answers[0].count, n: b.answers[0].items.length, l: b.answers[0].lines, t: b.text.replace(/"[^"]*"/g, '"x"') });
  check('scope: another BDE\'s client gets exactly the answer a made-up name gets', shape(outA) === shape(nonA), [shape(outA), shape(nonA)]);
  const tlBlob = answersBy.TL.join('\n');
  const leak = (blob) => SECRETS.filter((s) => blob.includes(s)).concat(['455555', '4,55,555', '466666', '488888', '499999', '4,99,999', `Secretpur${RUN}`].filter((s) => blob.includes(s)));
  check('limited view: no candidate phone, e-mail, company, salary, location or offered CTC in any BDE / BDE TL answer', !leak(aBlob + bBlob + tlBlob).length, leak(aBlob + bBlob + tlBlob));
  check('limited view: a BDE never sees an invoice amount (Rs 59,000 / 50,000)', !/59,000|50,000|35,400/.test(aBlob + bBlob), (aBlob.match(/.{40}(59,000|50,000).{20}/) || [])[0]);
  check('...while the Super Admin does', answersBy.SA.join('\n').includes('Rs 59,000'));
  check('limited view: the Super Admin\'s agent answers carry no candidate contact either', !leak(answersBy.SA.join('\n')).length, leak(answersBy.SA.join('\n')));

  // ------------------------------------------------------------------ the model path (a stub AI)
  fs.writeFileSync(STUB, 'ok');
  const m1 = await call('POST', '/bde-agent/ask', { question: 'Any tips for my next call with Kovida Heartcare? They are slow to reply.' }, tA);
  const seen = fs.existsSync(`${STUB}.last`) ? fs.readFileSync(`${STUB}.last`, 'utf8') : '';
  check('model: an advice question goes to the model with the facts built for it', m1.status === 200 && m1.body.source === 'model' && /From your TeamLink data: Kovida Heartcare Hospital/.test(m1.body.text) && /Kovida Heartcare Hospital/.test(seen), { b: m1.body && { s: m1.body.source, t: m1.body.text, fb: m1.body.fallback } });
  check('model: the facts the model saw hold the exact numbers from code (2 open requirements) and no candidate contact', /2 open requirements/.test(seen) && !leak(seen).length && !/Vishrant/.test(seen), leak(seen));
  fs.writeFileSync(STUB, 'bad');
  const m2 = await call('POST', '/bde-agent/ask', { question: 'Give me some tips to convince Nelora to sign' }, tA);
  check('model: an answer with a number that is not in the facts is thrown away; the code answer comes back', m2.status === 200 && m2.body.source === 'code' && m2.body.fallback === 'number-check' && !/987654/.test(m2.body.text) && /Nelora/.test(m2.body.text), m2.body && { s: m2.body.source, f: m2.body.fallback, t: String(m2.body.text).slice(0, 200) });
  fs.writeFileSync(STUB, 'down');
  const m3 = await call('POST', '/bde-agent/ask', { question: 'anything important I am missing this week?' }, tA);
  check('model down: still 200 with the exact numbers (never a 500, never a blank)', m3.status === 200 && m3.body.source === 'code' && String(m3.body.text).length > 40 && /exact numbers/.test(m3.body.text) && /Today \(/.test(m3.body.text), m3.body && { s: m3.body.source, t: String(m3.body.text).slice(0, 200) });
  fs.writeFileSync(STUB, 'slow');
  const m4 = await call('POST', '/bde-agent/ask', { question: 'what should i say to Kovida about the fee?' }, tA);
  check(`model slow: the code answer comes back inside the time limit (${m4.ms} ms)`, m4.status === 200 && m4.body.source === 'code' && m4.ms < 6000 && /General advice/.test(m4.body.text), m4.body && { s: m4.body.source, ms: m4.ms });
  fs.writeFileSync(STUB, 'ok');
  const m5 = await call('POST', '/bde-agent/ask', { question: 'Tips to win back Vishrant Steel Works' }, tA);
  const seen5 = fs.existsSync(`${STUB}.last`) ? fs.readFileSync(`${STUB}.last`, 'utf8') : '';
  check('model: a question naming another BDE\'s client never puts that client in the model\'s facts', m5.status === 200 && !/Vishrant Steel Works/.test(seen5.split('FACTS')[1] || ''), (seen5.split('FACTS')[1] || '').slice(0, 300));

  // ------------------------------------------------------------------ cache + read only
  const c1 = await call('POST', '/bde-agent/ask', { question: 'overdue invoices' }, tA);
  const c2 = await call('POST', '/bde-agent/ask', { question: 'overdue invoices' }, tA);
  check(`a repeated question is served from the 60 s cache (${c2.ms} ms)`, c2.body.cached === true && c2.body.answers[0].count === c1.body.answers[0].count);
  await prisma.invoice.update({ where: { id: I3.id }, data: { dueDate: day(-1) } }); // the data changes: the cache must not hide it
  await new Promise((r) => { setTimeout(r, 1700); });
  const c3 = await call('POST', '/bde-agent/ask', { question: 'overdue invoices' }, tA);
  check('...and a change in the data is seen at once (2 overdue now, not the cached 1)', c3.body.cached !== true && c3.body.answers[0].count === 2, c3.body.answers && c3.body.answers[0].count);
  await prisma.invoice.update({ where: { id: I3.id }, data: { dueDate: day(10) } });
  const beforeEdits = before; void I1; void I2; void I4; void RA2; void RA4; void RB2; void A3; void B2;
  const after = await stampOf();
  const beforeAt = new Date(JSON.parse(beforeEdits)[0]._max.updatedAt);
  const touched = await prisma.application.findMany({ where: { updatedAt: { gt: beforeAt } }, select: { id: true, stage: true, rollStatus: true, joiningStatus: true, updatedAt: true, candidate: { select: { name: true } } } });
  if (touched.length) console.log('      applications changed while the test ran (not by the agent if the agent never writes):', JSON.stringify(touched).slice(0, 600));
  check('read only: the agent wrote nothing (applications, clients, requirements, invoices, stage events, follow-ups, audit unchanged)', JSON.parse(after).slice(0, 7).every((x, i) => i === 3 || JSON.stringify(x) === JSON.stringify(JSON.parse(beforeEdits)[i])), { before: beforeEdits.slice(0, 300), after: after.slice(0, 300) });
  check('an empty question is a 400, not a 500', (await call('POST', '/bde-agent/ask', { question: '  ' }, tA)).status === 400);

  console.log(`\n${total - failed}/${total} passed`);
  if (fails.length) console.log(`failed: ${fails.join(' | ')}`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
