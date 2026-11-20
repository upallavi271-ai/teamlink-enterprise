#!/usr/bin/env node
/**
 * THE ONE SEARCH (founder 2026-11-20): a search bar on the dashboard; whatever is searched, the complete end-to-end history comes.
 * Candidates, people, clients, requirements, interviews / offers / joinings, invoices / agreements and other records are found by partial, reordered,
 * misspelt and phone-format variants, grouped with counts; every result carries the address of its History; scope is checked both ways; a name outside
 * the scope answers exactly like a nonsense name; the typeahead is timed on 100,000 candidates.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database. Port from TEST_PORT (default 4291).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-dash-search-${process.pid}.db`);
const UPLOADS = path.join(os.tmpdir(), `zz-dash-search-uploads-${process.pid}`);
fs.mkdirSync(UPLOADS, { recursive: true });
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4291);
const API = `http://localhost:${PORT}/api`;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'dash-search-test', UPLOAD_DIR: UPLOADS, DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
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



// phone as it is stored: "+91 98765 43210"
const storedPhone = (d) => `+91 ${d.slice(0, 5)} ${d.slice(5)}`;
const flat = (body) => (body.groups || []).flatMap((g) => g.rows.map((r) => ({ ...r, group: g.id })));

(async () => {
  const DEPT = 'IT';
  const TEAM = `Hs Team ${RUN}`;
  const sa = await mkUser('sa', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', accountsAccess: true, accountsRole: 'SUPER_ADMIN' });
  const bdeTl = await mkUser('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL', department: 'BDE' });
  const bde = await mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: `BDE,${DEPT}` }, { tl: bdeTl.name, department: 'BDE' });
  const bdeX = await mkUser('bdex', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'Medical' }, { department: 'BDE' });
  const tl = await mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: DEPT, atsScopeDepartments: DEPT, atsScopeTeams: TEAM }, { designation: 'TL', department: DEPT, team: TEAM });
  const tl2 = await mkUser('tltwo', { role: 'TL', atsRole: 'TL', atsDepartment: DEPT, atsScopeDepartments: DEPT, atsScopeTeams: `${TEAM} Two` }, { designation: 'TL', department: DEPT, team: `${TEAM} Two` });
  const recA = await mkUser('reca', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: DEPT, atsScopeDepartments: DEPT }, { tl: tl.name, department: DEPT, team: TEAM });
  const recB = await mkUser('recb', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: DEPT, atsScopeDepartments: DEPT }, { tl: tl.name, department: DEPT, team: TEAM });
  const recC = await mkUser('recc', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: DEPT, atsScopeDepartments: DEPT }, { tl: tl2.name, department: DEPT, team: `${TEAM} Two` });
  const acc = await mkUser('acc', { role: 'EMPLOYEE', atsRole: 'ACCOUNTANT', atsAccess: true, accountsAccess: true, accountsRole: 'ACCOUNTANT' });

  const clientPhoneD = `9${String(Date.now()).slice(-9)}`;
  const client = await prisma.client.create({
    data: {
      name: `Zenithcore Dynamics ${RUN}`, industry: 'Information Technology', ownerDepartment: DEPT, bdeOwner: bde.name, agreementStatus: 'SIGNED', agreementId: `AGR-HS${RUN}`.toUpperCase(), guaranteePeriod: '90 Days', clientCode: `ZC-${RUN}`.toUpperCase(),
      contactName: 'Priyanka Venkatesh', contactPhone: storedPhone(clientPhoneD), contactEmail: `priyanka.${RUN}@zenithcore-test.in`, location: 'Hyderabad',
    },
  });
  await prisma.clientAlias.create({ data: { clientId: client.id, alias: `Orbitrex Legacy ${RUN}`, aliasKey: `orbitrexlegacy${RUN}`.toLowerCase() } }).catch(() => null);
  const client2 = await prisma.client.create({ data: { name: `Marlowe Foundry ${RUN}`, industry: 'Manufacturing', ownerDepartment: 'Medical', bdeOwner: bdeX.name, agreementStatus: 'ACTIVE' } });
  const mkReq = (title, code, recruiter, tlu, c, extra = {}) => prisma.requirement.create({
    data: { title, clientId: c.id, department: DEPT, openings: 2, status: 'RECRUITER_ASSIGNED', skills: 'Kubernetes, Go', reqCode: code, tlId: tlu.id, tl: tlu.name, recruiterId: recruiter.id, bdeId: c === client ? bde.id : bdeX.id, location: 'Pune', ...extra },
  });
  const RA = await mkReq(`Kubernetes Platform Engineer ${RUN}`, `HS-A${RUN}`.toUpperCase(), recA, tl, client);
  const RB = await mkReq(`Warehouse Operations Lead ${RUN}`, `HS-B${RUN}`.toUpperCase(), recB, tl, client, { location: 'Nagpur' });
  const RC = await mkReq(`Foundry Process Planner ${RUN}`, `HS-C${RUN}`.toUpperCase(), recC, tl2, client2, { location: 'Coimbatore' });

  const dig = (n) => `8${String(Date.now() + n).slice(-9)}`;
  const phoneD = dig(1);
  const cand = async (name, extra = {}) => prisma.candidate.create({ data: { name, phone: extra.phone || storedPhone(dig(Math.floor(Math.random() * 1e6))), email: extra.email || `hs.${RUN}.${Math.floor(Math.random() * 1e6)}@hs-test.in`, source: 'Naukri', currentSalary: '600000', expectedSalary: '800000', experienceYears: 4, ...extra } });
  const C1 = await cand(`Ravindra Quillfeather ${RUN}`, { phone: storedPhone(phoneD), email: `ravindra.quillfeather.${RUN}@hs-test.in`, skills: 'Kubernetes, Terraform', currentCompany: `Zephyrine Labs ${RUN}`, location: 'Visakhapatnam', currentDesignation: 'DevOps Engineer' });
  const C2 = await cand(`Sushmita Oakenshield ${RUN}`, { skills: 'Warehouse planning' });
  const C3 = await cand('సుష్మిత రెడ్డి', { skills: 'Support' });
  const C4 = await cand(`Ravi Chandrasekhar ${RUN}`, { skills: 'Support' });
  const C5 = await cand(`Gopalakrishna Tltwoperson ${RUN}`, { skills: 'Foundry' });
  const C6 = await cand(`Interviewed Imogen ${RUN}`, {});
  const C7 = await cand(`Offered Octavian ${RUN}`, {});
  const C8 = await cand(`Joined Jorvik ${RUN}`, {});
  const mkApp = (c, req, owner, extra = {}) => prisma.application.create({ data: { candidateId: c.id, requirementId: req.id, ownerRecruiterId: owner.id, stage: 'NEW', ...extra } });
  const A1 = await mkApp(C1, RA, recA, { stage: 'SHARED_WITH_CLIENT' });
  const A2 = await mkApp(C2, RB, recB, { stage: 'SHARED_WITH_CLIENT' });
  const A3 = await mkApp(C3, RA, recA);
  const A4 = await mkApp(C4, RA, recA);
  const A5 = await mkApp(C5, RC, recC, { stage: 'SHARED_WITH_CLIENT' });
  const A6 = await mkApp(C6, RA, recA, { stage: 'INTERVIEW_SCHEDULED', interviewAt: noon(day(3)), interviewStatus: 'Scheduled', interviewer: `Boddapati Interviewer ${RUN}`, interviewRound: 1 });
  const A7 = await mkApp(C7, RB, recB, { stage: 'OFFER', offerStatus: 'Offer Released', offerDate: day(-2) });
  const A8 = await mkApp(C8, RA, recA, { stage: 'JOINED', joiningDate: day(-5), joiningStatus: 'Joined', joinedAt: noon(day(-5)) });
  await prisma.applicationFollowUp.create({ data: { applicationId: A1.id, candidateId: C1.id, ownerUserId: recA.id, ownerName: recA.name, nextAction: `Send Zephyrdocs checklist ${RUN}`, notes: 'chase' } });
  await prisma.candidateDocument.create({ data: { candidateId: C1.id, docType: 'Resume', name: `quillfeather-cv-${RUN}.pdf`, fileName: `quillfeather-cv-${RUN}.pdf` } });
  await prisma.invoice.create({ data: { clientId: client.id, candidateId: C8.id, requirementId: RA.id, amount: 50000, status: 'Pending', invoiceDate: day(-3), invoiceNumber: `HSINV-${RUN}`.toUpperCase() } });
  await prisma.task.create({ data: { name: `Prepare Quillfeather shortlist ${RUN}`, status: 'Not Started', assigneeId: sa.id, assignedById: sa.id, assigneeName: sa.name, assignedByName: sa.name, department: DEPT, startDate: day(0), endDate: day(2) } }).catch((e) => console.log(`      note: task not created (${String(e.message).slice(0, 80)})`));

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
  for (const [k, u] of Object.entries({ sa, bdeTl, bde, bdeX, tl, tl2, recA, recB, recC, acc })) T[k] = await tokenOf(u.id); // eslint-disable-line no-await-in-loop
  const S = (text, who, extra = '') => call('GET', `/ats/history/search?q=${encodeURIComponent(text)}${extra}`, null, T[who]);
  const inGroup = (res, group, id) => (res.body.groups || []).some((g) => g.id === group && g.rows.some((r) => r.id === id || r.candidateId === id));
  const linkOf = (res, id) => { const r = flat(res.body).find((x) => x.id === id || x.applicationId === id); return r ? r.to : null; };

  try {
    // ---------------------------------------------------------------- 1. candidates: every way to type a name / number
    const NAME = `Ravindra Quillfeather ${RUN}`;
    const variants = [
      ['partial', 'quillfea'], ['upper case', 'QUILLFEATHER'], ['full name', NAME.toUpperCase()], ['words in the other order', `quillfeather ravindra`],
      ['one missing letter', 'ravindra quillfeathr'], ['one wrong letter', 'ravindra quillfeether'], ['one extra letter', 'ravindra quillfeaather'], ['first name only', 'ravindra'],
    ];
    for (const [label, text] of variants) { // eslint-disable-line no-restricted-syntax
      // eslint-disable-next-line no-await-in-loop
      const r = await S(text, 'sa');
      check(`candidate found by ${label} ("${text.slice(0, 30)}")`, r.status === 200 && inGroup(r, 'candidates', C1.id), r.body && r.body.groups && r.body.groups.map((g) => [g.id, g.rows.length]));
    }
    const phones = [['plain digits', phoneD], ['stored format', storedPhone(phoneD)], ['with dashes', `+91-${phoneD.slice(0, 5)}-${phoneD.slice(5)}`], ['with 91 and no plus', `91 ${phoneD}`], ['last six digits', phoneD.slice(-6)], ['spaced in threes', `${phoneD.slice(0, 3)} ${phoneD.slice(3, 6)} ${phoneD.slice(6)}`]];
    for (const [label, text] of phones) { // eslint-disable-line no-restricted-syntax
      // eslint-disable-next-line no-await-in-loop
      const r = await S(text, 'sa');
      check(`candidate found by phone ${label}`, r.status === 200 && inGroup(r, 'candidates', C1.id), r.body && r.body.groups && r.body.groups.map((g) => [g.id, g.rows.length]));
    }
    for (const [label, text] of [['email part', `quillfeather.${RUN}@HS-TEST`], ['skill', 'kubernetes terraform'], ['current company', 'zephyrine'], ['location', 'visakha'], ['candidate ID', C1.id.slice(-8).toUpperCase()], ['designation', 'devops']]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await S(text, 'sa');
      check(`candidate found by ${label}`, r.status === 200 && inGroup(r, 'candidates', C1.id), r.body && r.body.groups && r.body.groups.map((g) => [g.id, g.rows.length]));
    }
    const tel = await S('సుష్మిత', 'sa');
    check('a Telugu name is found as typed', inGroup(tel, 'candidates', C3.id), tel.body.groups);
    const tel2 = await S('రవి', 'sa');
    check('a Telugu word also finds the Latin spelling (రవి finds Ravi)', inGroup(tel2, 'candidates', C4.id), tel2.body.groups.map((g) => [g.id, g.rows.map((r) => r.title)]));

    // ---------------------------------------------------------------- 2. people
    const pe = async (text, who = 'sa') => (await S(text, who)).body;
    check('a recruiter is found by name (partial, any case)', (await pe('hx reca')).people.some((p) => p.id === recA.id), null);
    check('a TL is found by name and a recruiter by employee code', (await pe(`HX TL ${RUN}`)).people.some((p) => p.id === tl.id && p.kind === 'tl') && (await pe(`hx-reca-${RUN}`)).people.some((p) => p.id === recA.id), null);
    check('a recruiter is found by a typo in the name', (await pe(`hx reaca ${RUN}`)).people.some((p) => p.id === recA.id), null);
    check('people are found by section / team name', (await pe(TEAM.toLowerCase())).people.some((p) => p.id === tl.id), null);
    check('a BDE is found by name for the Admin', (await pe(`hx bde ${RUN}`)).groups.some((g) => g.id === 'people' && g.rows.some((r) => r.id === bde.id && r.kind === 'bde')), null);
    const pp = flat((await S('hx reca', 'sa')).body).find((r) => r.id === recA.id);
    check('a recruiter result opens the recruiter History page', pp && pp.to === `/ats/history/recruiter/${recA.id}`, pp);
    const pt = flat((await S(`hx tl ${RUN}`, 'sa')).body).find((r) => r.id === tl.id);
    check('a TL result opens the team History page', pt && pt.to === `/ats/history/tl/${tl.id}`, pt);

    // ---------------------------------------------------------------- 3. clients
    const cl = [['name, partial', 'zenithcor'], ['name, reordered', `dynamics zenithcore`], ['name with a typo', `zenithcor dynamcs`], ['an old name', `orbitrex legacy`], ['client code', `zc-${RUN}`], ['contact person', 'priyanka venk'], ['contact e-mail', `priyanka.${RUN}@zenithcore`], ['contact phone', storedPhone(clientPhoneD)], ['contact phone, plain', clientPhoneD], ['location + name', 'hyderabad zenith']];
    for (const [label, text] of cl) { // eslint-disable-line no-restricted-syntax
      // eslint-disable-next-line no-await-in-loop
      const r = await S(text, 'sa');
      check(`client found by ${label}`, r.status === 200 && inGroup(r, 'clients', client.id), r.body && r.body.groups && r.body.groups.map((g) => [g.id, g.rows.length]));
    }
    const cr = flat((await S('zenithcore', 'sa')).body).find((r) => r.id === client.id);
    check('a client result opens the Client History and keeps the plain record one click away', cr && cr.to === `/clients/${client.id}?tab=history` && cr.recordTo === `/clients/${client.id}`, cr);

    // ---------------------------------------------------------------- 4. requirements
    for (const [label, text] of [['title, partial', 'kubernetes platform'], ['title, reordered', 'engineer kubernetes'], ['REQ code, lower case', `hs-a${RUN}`], ['title with a typo', 'kubernetes platforn engineer'], ['location', 'warehouse nagpur'], ['client name', 'zenithcore kubernetes']]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await S(text, 'sa');
      check(`requirement found by ${label}`, r.status === 200 && inGroup(r, 'requirements', text.includes('warehouse') ? RB.id : RA.id), r.body && r.body.groups && r.body.groups.map((g) => [g.id, g.rows.length]));
    }
    const rr = flat((await S(`hs-a${RUN}`, 'sa')).body).find((r) => r.id === RA.id);
    check('a requirement result: client, status, openings, headline numbers, opens the Requirement History', rr && rr.client.includes('Zenithcore') && rr.statusLabel && rr.openings === 2 && rr.headline && rr.to === `/requirements/${RA.id}?tab=history`, rr);

    // ---------------------------------------------------------------- 5. interviews, offers, joinings, invoices, agreements, other
    const ev1 = await S(`boddapati interviewer`, 'sa');
    const ev1r = flat(ev1.body).find((r) => r.type === 'interview' && r.applicationId === A6.id);
    check('an interview is found by the interviewer and opens the candidate History at that event', ev1r && ev1r.to === `/ats/history/candidate/${C6.id}?focus=interview-${A6.id}` && ev1r.recordTo === `/candidates/${C6.id}`, ev1.body.groups.map((g) => [g.id, g.rows.map((r) => r.type)]));
    const ev2 = flat((await S('octavian offered', 'sa')).body).find((r) => r.type === 'offer' && r.applicationId === A7.id);
    check('an offer is found by candidate name and opens its candidate History at the offer', ev2 && ev2.to === `/ats/history/candidate/${C7.id}?focus=offer-${A7.id}`, ev2);
    const ev3 = flat((await S('jorvik zenithcore', 'sa')).body).find((r) => r.type === 'joining' && r.applicationId === A8.id);
    check('a joining is found by candidate + client and opens its candidate History at the joining', ev3 && ev3.to === `/ats/history/candidate/${C8.id}?focus=joining-${A8.id}`, ev3);
    // the clear counts of Interviews, offers & joinings (founder 2026-11-20: "how many offers, how many joined, how many dropped?")
    const zcEv = await S('zenithcore', 'sa');
    const evg = (zcEv.body.groups || []).find((g) => g.id === 'events');
    const bk = (k) => ((evg && evg.breakdown) || []).find((b) => b.key === k) || { count: -1 };
    check('the events group carries the clear counts: offers waiting, joined (still working), dropped, interviews', !!evg && Array.isArray(evg.breakdown) && evg.breakdown.length === 8 && bk('joining:joined').count >= 1, evg && evg.breakdown);
    const onlyJoined = await S('zenithcore', 'sa', '&ev=joining:joined');
    const jRows = flat(onlyJoined.body).filter((r) => r.group === 'events');
    check('?ev=joining:joined shows only joinings that are still working', jRows.length >= 1 && jRows.every((r) => r.type === 'joining' && /joined, still working/.test(r.sub)), jRows.map((r) => r.sub));
    const offerWait = await S('octavian', 'sa', '&ev=offer:released');
    check('?ev=offer:released finds the offer waiting for an answer, and no joining or interview', flat(offerWait.body).some((r) => r.type === 'offer' && r.applicationId === A7.id) && !flat(offerWait.body).some((r) => r.group === 'events' && r.type !== 'offer'));
    const two = await S('zenithcore', 'sa', '&ev=joining:joined,offer:released');
    const twoEv = ((two.body.groups || []).find((g) => g.id === 'events') || { count: 0 });
    check('two ticked statuses add up (joined + offers waiting)', twoEv.count === bk('joining:joined').count + bk('offer:released').count, [twoEv.count, bk('joining:joined').count, bk('offer:released').count]);
    const cg = (zcEv.body.groups || []).find((g) => g.id === 'candidates');
    check('the candidates group carries clear counts too (in process / selected / joined / dropped)', !cg || (Array.isArray(cg.breakdown) && cg.breakdown.length === 4), cg && cg.breakdown);
    const inv = flat((await S(`hsinv-${RUN}`, 'sa')).body).find((r) => r.type === 'invoice');
    check('an invoice is found by its number; it opens the client History at the invoice, the record one click away', inv && inv.to.startsWith(`/clients/${client.id}?tab=history&focus=invoice-`) && inv.recordTo.startsWith('/invoices/'), inv);
    const agr = flat((await S(`agr-hs${RUN}`, 'sa')).body).find((r) => r.type === 'agreement');
    check('an agreement is found by its number and opens the client History at the agreement', agr && agr.to === `/clients/${client.id}?tab=history&focus=agreement`, agr);
    const agr2 = flat((await S(`zenithcore signed`, 'sa')).body).find((r) => r.type === 'agreement');
    check('an agreement is found by client + status word', !!agr2);
    const fu = flat((await S(`zephyrdocs checklist`, 'sa')).body).find((r) => r.type === 'followup');
    check('a follow-up is found by its text and opens the candidate History at it', fu && fu.to.startsWith(`/ats/history/candidate/${C1.id}?focus=followup-`), fu);
    const dc = flat((await S(`quillfeather-cv`, 'sa')).body).find((r) => r.type === 'document');
    check('a document is found by its file name (name only) and opens the candidate History at it', dc && dc.to.startsWith(`/ats/history/candidate/${C1.id}?focus=document-`), dc);
    const tk = flat((await S(`quillfeather shortlist`, 'sa')).body).find((r) => r.type === 'task');
    check('my own task is found by its text', !!tk);

    // ---------------------------------------------------------------- 6. groups, counts, order, typeahead vs full page
    const full = await S('quillfeather', 'sa');
    const ids = full.body.groups.map((g) => g.id);
    check('groups come in the fixed order with counts (full page)', full.status === 200 && ids.join() === ['people', 'clients', 'requirements', 'candidates', 'events', 'money', 'other'].filter((g) => ids.includes(g)).join() && full.body.groups.every((g) => Number.isInteger(g.count) && g.count >= g.rows.length) && full.body.total > 0, full.body.groups.map((g) => [g.id, g.count]));
    const typ = await S('quillfeather', 'sa', '&mode=type');
    check('typeahead answers the same groups with at most 5 rows each and no headline numbers', typ.status === 200 && typ.body.mode === 'type' && typ.body.groups.every((g) => g.rows.length <= 5) && typ.body.groups.some((g) => g.id === 'candidates') && flat(typ.body).filter((r) => r.type === 'requirement').every((r) => r.headline === undefined), typ.body.groups.map((g) => [g.id, g.rows.length]));
    const one = await S('q', 'sa');
    check('one letter answers nothing (no scan of everything)', one.status === 200 && one.body.total === 0 && one.body.groups.length === 0);
    const big = await S('a', 'sa', '&mode=type');
    check('a one-letter typeahead is empty too', big.body.groups.length === 0);
    // filters of the full page
    const fOwner = await S('quillfeather', 'sa', `&owner=${recA.id}`);
    check('filter by owner keeps the owner\'s candidates', inGroup(fOwner, 'candidates', C1.id));
    const fOwner2 = await S('quillfeather', 'sa', `&owner=${recB.id}`);
    check('...and drops other owners\' candidates', !inGroup(fOwner2, 'candidates', C1.id));
    const fDate = await S('quillfeather', 'sa', `&from=${day(-1)}&to=${day(1)}`);
    check('filter by dates (created today) keeps today\'s records', inGroup(fDate, 'candidates', C1.id));
    const fDate2 = await S('quillfeather', 'sa', `&from=${day(-40)}&to=${day(-30)}`);
    check('...and drops records outside the dates', !inGroup(fDate2, 'candidates', C1.id) && !inGroup(fDate2, 'requirements', RA.id));
    const fStatus = await S('hs-b', 'sa', '&status=closed');
    check('filter by status (closed) drops open requirements', !inGroup(fStatus, 'requirements', RB.id));

    // ---------------------------------------------------------------- 7. scope, both directions
    const NONSENSE = 'Zzqxv Plumbonk';
    const nonsense = await S(NONSENSE, 'recA');
    const shape = (r) => JSON.stringify({ t: r.body.total, g: r.body.groups, p: r.body.people, c: r.body.candidates, cl: r.body.clients, rq: r.body.requirements });
    const outA1 = await S('Sushmita Oakenshield', 'recA');
    check('recruiter A searching recruiter B\'s candidate gets exactly what a nonsense name gets', shape(outA1) === shape(nonsense) && outA1.body.total === 0, outA1.body.groups);
    const outA2 = await S(`hx recb`, 'recA');
    check('...B\'s name (a person)', outA2.body.people.length === 0 && !JSON.stringify(outA2.body).includes(recB.name), outA2.body.people);
    const outA3 = await S(`warehouse operations`, 'recA');
    check('...B\'s requirement', shape(outA3) === shape(nonsense), outA3.body.groups);
    const outA4 = await S(`zenithcore`, 'recA');
    check('a recruiter gets no Clients group (client desk only) but sees their own requirement', !outA4.body.groups.some((g) => g.id === 'clients') && inGroup(outA4, 'requirements', RA.id));
    check('a recruiter finds their own candidate by name and phone', inGroup(await S('quillfeather', 'recA'), 'candidates', C1.id) && inGroup(await S(phoneD.slice(-7), 'recA'), 'candidates', C1.id));
    check('a recruiter does not get invoices, agreements or other people\'s follow-ups', !flat((await S(`hsinv-${RUN}`, 'recA')).body).some((r) => r.type === 'invoice') && !flat((await S(`agr-hs${RUN}`, 'recA')).body).some((r) => r.type === 'agreement'));
    const recOwn = await S('hx reca', 'recA');
    check('a recruiter finds only themselves among people', recOwn.body.people.map((p) => p.id).join() === recA.id, recOwn.body.people.map((p) => p.name));
    // TL
    check('the TL finds their team\'s candidates, not the other team\'s', inGroup(await S('quillfeather', 'tl'), 'candidates', C1.id) && inGroup(await S('oakenshield', 'tl'), 'candidates', C2.id) && shape(await S('Gopalakrishna Tltwoperson', 'tl')) === shape(await S(NONSENSE, 'tl')));
    const tlPeople = await S('hx rec', 'tl');
    check('the TL finds their recruiters, not the other team\'s', tlPeople.body.people.some((p) => p.id === recA.id) && tlPeople.body.people.some((p) => p.id === recB.id) && !tlPeople.body.people.some((p) => p.id === recC.id));
    // BDE
    const bQ = await S('quillfeather', 'bde');
    check('a BDE finds a candidate shared with their client by name', inGroup(bQ, 'candidates', C1.id), bQ.body.groups);
    check('...but not by phone, e-mail, company or location (limited view)', !inGroup(await S(phoneD.slice(-7), 'bde'), 'candidates', C1.id) && !inGroup(await S('zephyrine', 'bde'), 'candidates', C1.id) && !inGroup(await S('visakha', 'bde'), 'candidates', C1.id) && !inGroup(await S(`ravindra.quillfeather.${RUN}`, 'bde'), 'candidates', C1.id));
    const bRow = flat(bQ.body).find((r) => r.id === C1.id);
    check('...and the row carries no phone, e-mail or company', bRow && bRow.phone === undefined && bRow.email === undefined && !JSON.stringify(bRow).includes('Zephyrine'), bRow);
    check('a BDE sees their client, requirement and agreement; no recruiter people, no invoices', inGroup(await S('zenithcore', 'bde'), 'clients', client.id) && inGroup(await S('kubernetes platform', 'bde'), 'requirements', RA.id) && (await S('hx reca', 'bde')).body.people.length === 0 && !flat((await S(`hsinv-${RUN}`, 'bde')).body).some((r) => r.type === 'invoice'));
    check('a BDE of another desk finds nothing of that client (same as nonsense)', shape(await S('zenithcore', 'bdeX')) === shape(await S(NONSENSE, 'bdeX')) && shape(await S('Ravindra Quillfeather', 'bdeX')) === shape(await S(NONSENSE, 'bdeX')));
    check('the BDE TL gets no people and no invoices', (await S('hx reca', 'bdeTl')).body.people.length === 0 && !flat((await S(`hsinv-${RUN}`, 'bdeTl')).body).some((r) => r.type === 'invoice'));
    // Accounts
    const aInv = flat((await S(`hsinv-${RUN}`, 'acc')).body).find((r) => r.type === 'invoice');
    check('Accounts finds the invoice; it opens the client History (or the invoice record when the client History is not theirs)', aInv && (aInv.to.startsWith(`/clients/${client.id}?tab=history&focus=invoice-`) || aInv.to.startsWith('/invoices/')) && aInv.recordTo.startsWith('/invoices/'), aInv);
    const accHist = await call('GET', `/ats/history/client/${client.id}`, null, T.acc);
    check('...and where it links to the client History, that History opens for Accounts (with billing)', !aInv || !aInv.to.startsWith('/clients/') || (accHist.status === 200 && accHist.body.billing !== null), [accHist.status]);
    check('Accounts gets no candidates or people', (await S('quillfeather', 'acc')).body.candidates.length === 0 && (await S('hx reca', 'acc')).body.people.length === 0);
    // client login and no login
    const clientLogin = await mkUser('clientlogin', { role: 'CLIENT', atsRole: 'CLIENT', clientId: client.id, portalType: 'REVIEWER', portalPerms: 'VIEW' });
    const tCl = await tokenOf(clientLogin.id);
    check('a client login gets none of it', (await call('GET', '/ats/history/search?q=quillfeather', null, tCl)).status === 403);
    check('no login, no search (401)', (await call('GET', '/ats/history/search?q=quillfeather', null, null)).status === 401);
    check('the Admin\'s answer for a nonsense name is empty with the same shape', (await S(NONSENSE, 'sa')).body.total === 0);


    // ---------------------------------------------------------------- 7b. a client / requirement / recruiter / TL search also lists THEIR candidates
    const candIds = (res) => ((res.body.groups || []).find((g) => g.id === 'candidates') || { rows: [] }).rows.map((r) => r.id).sort().join();
    const candCount = (res) => ((res.body.groups || []).find((g) => g.id === 'candidates') || { count: 0 }).count;
    const want = (...cs) => cs.map((c) => c.id).sort().join();
    const zc = await S('zenithcore', 'sa');
    check('a client search lists every candidate with an application on that client\'s requirements (7 distinct people), and the count is the true one', candCount(zc) === 7 && candIds(zc) === want(C1, C2, C3, C4, C6, C7, C8), [candCount(zc), candIds(zc)]);
    const zcRow = flat(zc.body).find((r) => r.id === C8.id && r.type === 'candidate');
    check('each such row says why it matched, with the step ("via client ... - Joined")', zcRow && zcRow.via.some((x) => /^via client Zenithcore.* · Joined$/.test(x)) && zcRow.matchedBy.includes('client') && zcRow.step === 'Joined', zcRow);
    const zcClientRow = flat(zc.body).find((r) => r.type === 'client');
    check('the Candidates count is never 0 while the client row has applications', zcClientRow && zcClientRow.requirements >= 2 && candCount(zc) > 0, [zcClientRow && zcClientRow.requirements, candCount(zc)]);
    const zcRq = (zc.body.groups.find((g) => g.id === 'requirements') || { rows: [] }).rows.map((r) => r.id);
    check('a client search lists ALL that client\'s requirements (the two of Zenithcore), with their numbers', zcRq.includes(RA.id) && zcRq.includes(RB.id) && !zcRq.includes(RC.id) && flat(zc.body).find((r) => r.id === RA.id).headline.shared >= 1, zcRq);
    const rq = await S('kubernetes platform', 'sa');
    check('a requirement search lists the candidates who applied to it (5)', candIds(rq) === want(C1, C3, C4, C6, C8), [candCount(rq), candIds(rq)]);
    const rqRow = flat(rq.body).find((r) => r.id === C1.id && r.type === 'candidate');
    check('...with "via requirement HS-A..." and the step', rqRow && rqRow.via.some((x) => /^via requirement HS-A/i.test(x)) && rqRow.matchedBy.includes('requirement'), rqRow);
    const rcA = await S('hx reca', 'sa');
    check('a recruiter search lists the candidates that recruiter handles (5), and the recruiter\'s requirements', candIds(rcA) === want(C1, C3, C4, C6, C8) && (rcA.body.groups.find((g) => g.id === 'requirements') || { rows: [] }).rows.some((r) => r.id === RA.id && (r.via || []).some((x) => /recruiter/.test(x))), [candCount(rcA), candIds(rcA)]);
    check('...the row says "recruiter <name>"', flat(rcA.body).find((r) => r.id === C1.id && r.type === 'candidate').via.some((x) => x.startsWith(`recruiter ${recA.name}`)));
    const tlS = await S(`hx-tl-${RUN}`, 'sa'); // the employee code: 'hx tl' alone is also inside the other TL's name
    check('a TL search lists the candidates of that TL\'s team requirements (7) and their requirements', candIds(tlS) === want(C1, C2, C3, C4, C6, C7, C8) && (tlS.body.groups.find((g) => g.id === 'requirements') || { rows: [] }).rows.some((r) => r.id === RB.id), [candCount(tlS)]);
    const cn = await S('quillfeather', 'sa');
    check('a candidate name also lists the requirements they applied to', (cn.body.groups.find((g) => g.id === 'requirements') || { rows: [] }).rows.some((r) => r.id === RA.id && r.matchedBy.includes('candidate')), cn.body.groups.map((g) => g.id));
    const zero = await S('zzqxv plumbonk', 'sa');
    check('Candidates is 0 only when it is truly 0 (a nonsense name has no groups)', zero.body.total === 0 && candCount(zero) === 0);
    // paging: "Show more", nothing cut silently
    const pg1 = await S('zenithcore', 'sa', '&limit=3');
    const pg2 = await S('zenithcore', 'sa', '&group=candidates&offset=3&limit=3');
    const pg3 = await S('zenithcore', 'sa', '&group=candidates&offset=6&limit=3');
    const g1 = pg1.body.groups.find((g) => g.id === 'candidates');
    check('page 1 of the candidates: 3 rows, the true total (7) and "more"', g1 && g1.rows.length === 3 && g1.count === 7 && g1.more === true, g1 && [g1.rows.length, g1.count, g1.more]);
    check('"Show more" returns only that group, the next rows, no overlap; the last page has no more', pg2.body.groups.length === 1 && pg2.body.groups[0].rows.length === 3 && !pg2.body.groups[0].rows.some((r) => g1.rows.some((x) => x.id === r.id)) && pg3.body.groups[0].rows.length === 1 && pg3.body.groups[0].more === false, [pg2.body.groups.map((g) => g.rows.length), pg3.body.groups.map((g) => [g.rows.length, g.more])]);
    // scope, both directions
    const zA = await S('zenithcore', 'recA');
    const zB = await S('zenithcore', 'recB');
    check('a recruiter sees only their OWN candidates of that client (A: 5, B: 2), never the other\'s', candIds(zA) === want(C1, C3, C4, C6, C8) && candIds(zB) === want(C2, C7), [candIds(zA), candIds(zB)]);
    const zBde = await S('zenithcore', 'bde');
    const bdeRows = flat(zBde.body).filter((r) => r.type === 'candidate');
    check('a BDE sees only the limited rows of candidates shared with the client: no phone, e-mail, company; not the unshared ones', bdeRows.length >= 3 && !bdeRows.some((r) => [C3.id, C4.id].includes(r.id)) && bdeRows.every((r) => r.phone === undefined && r.email === undefined) && !JSON.stringify(bdeRows).includes('Zephyrine'), bdeRows.map((r) => r.title));
    check('a BDE of another desk gets nothing for that client (same as nonsense); a client login gets 403', shape(await S('zenithcore', 'bdeX')) === shape(await S(NONSENSE, 'bdeX')) && (await call('GET', '/ats/history/search?q=zenithcore', null, tCl)).status === 403);
    const zTl2 = await S('zenithcore', 'tl2');
    check('the other team\'s TL does not get these candidates', candCount(zTl2) === 0 || !candIds(zTl2).includes(C1.id), candIds(zTl2));

    // ---------------------------------------------------------------- 7c. the filters
    const fType = await S('zenithcore', 'sa', '&type=candidates');
    check('filter Type = Candidates lists only that group, and the facet counts of the other groups stay', fType.body.groups.length === 1 && fType.body.groups[0].id === 'candidates' && fType.body.groups[0].count === 7 && fType.body.facets.type.some((o) => o.value === 'clients' && o.count >= 1), [fType.body.groups.map((g) => g.id), fType.body.facets && fType.body.facets.type]);
    check('facets: counts per status and per "matched by" for the candidates', fType.body.facets.status.find((o) => o.value === 'joined').count === 1 && fType.body.facets.status.reduce((n, o) => n + o.count, 0) === 7 && fType.body.facets.by.find((o) => o.value === 'client').count === 7, fType.body.facets);
    const fJoined = await S('zenithcore', 'sa', '&type=candidates&status=joined');
    check('filter Status = Joined: only the joined (still working) one, and the group count follows the filter', candIds(fJoined) === want(C8) && candCount(fJoined) === 1, [candIds(fJoined)]);
    check('filter Status = Selected / In process', candIds(await S('zenithcore', 'sa', '&type=candidates&status=selected')) === want(C7) && candCount(await S('zenithcore', 'sa', '&type=candidates&status=active')) === 5);
    check('filter Matched by: client keeps all 7, name keeps none (the word is not in any name)', candCount(await S('zenithcore', 'sa', '&type=candidates&by=client')) === 7 && candCount(await S('zenithcore', 'sa', '&type=candidates&by=name')) === 0 && candCount(await S('hx reca', 'sa', '&type=candidates&by=recruiter')) === 5);
    check('filter Owner (recruiter) narrows to that owner\'s candidates', candIds(await S('zenithcore', 'sa', `&type=candidates&owner=${recA.id}`)) === want(C1, C3, C4, C6, C8) && candIds(await S('zenithcore', 'sa', `&type=candidates&owner=${recB.id}`)) === want(C2, C7));
    check('filter Source / Experience / Skills', inGroup(await S('quillfeather', 'sa', '&src=naukri'), 'candidates', C1.id) && !inGroup(await S('quillfeather', 'sa', '&src=zzz'), 'candidates', C1.id)
      && inGroup(await S('quillfeather', 'sa', '&expMin=3&expMax=5'), 'candidates', C1.id) && !inGroup(await S('quillfeather', 'sa', '&expMin=6'), 'candidates', C1.id) && inGroup(await S('quillfeather', 'sa', '&skills=kubernetes'), 'candidates', C1.id) && !inGroup(await S('quillfeather', 'sa', '&skills=cobol'), 'candidates', C1.id));
    check('filter Location and Client', inGroup(await S('quillfeather', 'sa', '&loc=visakha'), 'candidates', C1.id) && !inGroup(await S('quillfeather', 'sa', '&loc=chennai'), 'candidates', C1.id) && inGroup(await S('quillfeather', 'sa', '&client=zenithcore'), 'candidates', C1.id) && !inGroup(await S('quillfeather', 'sa', '&client=marlowe'), 'candidates', C1.id));
    check('filter CTC range (lakh a year) for a login that may see pay', inGroup(await S('quillfeather', 'sa', '&ctcMin=7&ctcMax=9'), 'candidates', C1.id) && !inGroup(await S('quillfeather', 'sa', '&ctcMin=9'), 'candidates', C1.id));
    const bdePay = await S('zenithcore', 'bde', '&ctcMin=99&notice=90');
    check('a BDE gets no pay or notice filters: they are ignored and the answer says it has no pay filters', candCount(bdePay) === candCount(zBde) && bdePay.body.viewer.pay === false && (await S('zenithcore', 'recA')).body.viewer.limited === false);
    check('filter Date (created) keeps today\'s and drops older ones', inGroup(await S('quillfeather', 'sa', `&from=${day(-1)}&to=${day(1)}`), 'candidates', C1.id) && !inGroup(await S('quillfeather', 'sa', `&from=${day(-90)}&to=${day(-60)}`), 'candidates', C1.id));
    // a filter alone (no words) lists the matching records
    const browse1 = await S('', 'sa', `&type=candidates&status=joined&client=zenithcore`);
    check('a filter alone lists the matching records (joined people of Zenithcore)', browse1.status === 200 && candIds(browse1) === want(C8) && candCount(browse1) === 1, [browse1.status, browse1.body.groups]);
    const browse2 = await S('', 'sa', `&type=requirements&dept=${DEPT}&client=zenithcore`);
    check('a filter alone lists requirements too (client + department)', ((browse2.body.groups || []).find((g) => g.id === 'requirements') || { rows: [] }).rows.some((r) => r.id === RA.id), browse2.body.groups);
    check('no words and no filter: nothing', (await S('', 'sa')).body.total === 0);
    check('a recruiter\'s browse is still inside their scope', candIds(await S('', 'recA', '&type=candidates&client=zenithcore')) === want(C1, C3, C4, C6, C8));
    // Excel of the filtered results
    const xr = await fetch(`${API}/ats/history/search/export?q=zenithcore&status=joined&type=candidates`, { headers: { Authorization: `Bearer ${T.sa}` } });
    const xwb = XLSX.read(Buffer.from(await xr.arrayBuffer()), { type: 'buffer' });
    const xrows = xwb.Sheets.Candidates ? XLSX.utils.sheet_to_json(xwb.Sheets.Candidates, { header: 1 }) : [];
    check('Excel of the filtered results: the Candidates sheet holds exactly the filtered rows', xr.status === 200 && xrows.length === 2 && String(xrows[1][0]).includes('Joined Jorvik'), [xr.status, xwb.SheetNames, xrows.length]);
    check('...a recruiter cannot download (403), and the download is in the export log', (await fetch(`${API}/ats/history/search/export?q=zenithcore`, { headers: { Authorization: `Bearer ${T.recA}` } })).status === 403 && !!(await prisma.auditLog.findFirst({ where: { action: { contains: 'exported' }, entity: 'AtsReport', fromValue: null, toValue: { contains: 'row' }, userId: sa.id }, orderBy: { createdAt: 'desc' } })));

    // ---------------------------------------------------------------- 8. speed: 100,000 candidates
    const t0 = Date.now();
    const surnames = ['Reddy', 'Naidu', 'Sharma', 'Kumar', 'Rao', 'Varma', 'Patel', 'Singh', 'Iyer', 'Das'];
    const firsts = ['Anil', 'Bhavana', 'Chaitanya', 'Deepak', 'Esha', 'Farhan', 'Gayatri', 'Harsha', 'Indu', 'Jagan', 'Kiran', 'Lavanya'];
    for (let b = 0; b < 40; b += 1) {
      const rows = [];
      for (let i = 0; i < 2500; i += 1) {
        const n = b * 2500 + i;
        rows.push({ name: `${firsts[n % firsts.length]} ${surnames[(n >> 3) % surnames.length]} ${n}`, phone: `+91 ${String(30000 + (n % 60000))} ${String(10000 + (n % 90000))}`.slice(0, 16), email: `bulk${n}.${RUN}@hs-bulk.in`, skills: n % 7 === 0 ? 'Java, Spring' : 'Support, Excel', currentCompany: `Company ${n % 500}`, location: n % 2 ? 'Hyderabad' : 'Chennai' });
      }
      // eslint-disable-next-line no-await-in-loop
      await prisma.candidate.createMany({ data: rows });
    }
    console.log(`      seeded 100,000 candidates in ${Math.round((Date.now() - t0) / 1000)} s (${await prisma.candidate.count()} candidates in the copy)`);
    const timeIt = async (label, text, who, extra = '&mode=type') => {
      const runs = [];
      for (let i = 0; i < 3; i += 1) { const s0 = Date.now(); const r = await S(text, who, extra); runs.push(Date.now() - s0); if (r.status !== 200) return { label, ms: -1 }; } // eslint-disable-line no-await-in-loop
      runs.sort((a, b) => a - b);
      return { label, ms: runs[1], first: runs[0], all: runs };
    };
    const timings = [];
    timings.push(await timeIt('Admin: a name that is rare', 'quillfeather', 'sa'));
    timings.push(await timeIt('Admin: a common word', 'reddy', 'sa'));
    timings.push(await timeIt('Admin: two words', 'kiran reddy', 'sa'));
    timings.push(await timeIt('Admin: a phone number', phoneD, 'sa'));
    timings.push(await timeIt('Admin: a typo (fuzzy fallback)', 'ravindra quillfeathr', 'sa'));
    timings.push(await timeIt('Admin: nothing matches (fuzzy tried)', 'zzqxvplumbonk', 'sa'));
    timings.push(await timeIt('Recruiter: a rare name', 'quillfeather', 'recA'));
    timings.push(await timeIt('TL: a common word', 'reddy', 'tl'));
    timings.push(await timeIt('Admin: the full results page', 'quillfeather', 'sa', ''));
    timings.forEach((t) => console.log(`      ${t.label}: ${t.ms} ms (runs ${t.all ? t.all.join('/') : '-'})`));
    check('typeahead on 100,000 candidates: every typical query answers in about 300 ms (median under 600 ms, rare / common / phone under 400 ms)', timings.slice(0, 4).every((t) => t.ms >= 0 && t.ms < 400) && timings.every((t) => t.ms >= 0 && t.ms < 900), timings.map((t) => [t.label, t.ms]));
    const stillFound = await S('quillfeather', 'sa', '&mode=type');
    check('the rare candidate is still found among 100,000', inGroup(stillFound, 'candidates', C1.id));
  } catch (e) { failed += 1; total += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 900) : e); }
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
