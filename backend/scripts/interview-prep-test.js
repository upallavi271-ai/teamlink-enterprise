#!/usr/bin/env node
// ---------------------------------------------------------------------------
// INTERVIEW PREPARATION acceptance tests (2026-10-12). SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/interview-prep-test.js
//
//   A  the card: JD -> pack (template, because the sandbox refuses AI), honest label, cache, edit, conflict, regenerate
//   B  round types: client (the job's stated must-haves) / team / AI interview
//   C  privacy: the candidate-facing text never holds the client's name, the pay, internal notes; a BDE reads only
//   D  sending: the connected channel (mail), logged in the candidate's messages, once per version, consent honoured,
//        the booking message is NOT mistaken for "told" because of it
//   E  the candidate's page (signed link, no login) and the reminder note
// Generator unit tests (AI on / off / bad / slow) are in the scratchpad prep-gen-test.js.
// Builds ZZTEST fixtures in sandbox.db and removes them again.
// ---------------------------------------------------------------------------
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4011 (the sandbox) or another sandbox port 4011-4099, never 4010.'); process.exit(2); }
const SBX = `file:${path.join(BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db').split(path.sep).join('/')}`;
process.env.DATABASE_URL = SBX;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = SBX;
process.env.TEST_MODE = '1';
const realFetch = globalThis.fetch;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const PREP = require(path.join(BACK, 'src/utils/interviewPrep'));

const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 700)}` : ''}`);
}
async function call(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  for (let i = 0; ; i += 1) {
    try {
      const t0 = Date.now();
      const r = await realFetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(120000) });
      if (Date.now() - t0 > 8000) console.log(`   (slow call ${method} ${p}: ${Date.now() - t0} ms)`);
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, body: json, text };
    } catch (e) { if (i >= 120) throw e; await new Promise((res) => setTimeout(res, 2000)); }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const made = { users: [], emps: [], clients: [], reqs: [], cands: [], apps: [] };
  let switchBefore = null;
  const SWITCH = 'interview-reminders';
  const CLIENT = `ZZTEST Prep Hospital ${RUN}`;
  const CAND_EMAIL = `zz.prep.${RUN}@zzprep-sandbox.in`; // a normal-looking domain: the sandbox mail transport is fake
  const PHONE = '9000000042';
  try {
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mkUser = async (tag, extra, empExtra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST Prep ${tag} ${RUN}`, email: `zz-prep-${tag}-${RUN}@example.test`, username: `zz-prep-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id);
      if (empExtra) {
        const e = await prisma.employee.create({ data: { employeeCode: `ZZTEST-PR-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: extra.atsDepartment || null, phone: '9000000011', ...empExtra } });
        made.emps.push(e.id);
      }
      return u;
    };
    const uAdmin = await mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const uMgr = await mkUser('mgr', { role: 'MANAGER', atsRole: 'MANAGER' });
    const uTl = await mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }, { designation: 'TL' });
    const uRec = await mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }, {});
    const uRecOther = await mkUser('recother', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Manufacturing', atsScopeDepartments: 'Manufacturing' }, {});
    const uBde = await mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Medical' }, {});
    const uBdeOther = await mkUser('bdeother', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Manufacturing' }, {});
    const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    const T = {};
    for (const [k, u] of Object.entries({ admin: uAdmin, mgr: uMgr, tl: uTl, rec: uRec, recOther: uRecOther, bde: uBde, bdeOther: uBdeOther })) T[k] = await mint(u);

    // ---- fixtures: client, job (with salary, the client's name and a tracker note inside the text), candidate, interviews
    const client = await prisma.client.create({ data: { name: CLIENT, location: 'ZZ Town', ownerDepartment: 'Medical', bdeOwner: uBde.name, clientType: 'Client' } });
    made.clients.push(client.id);
    const req = await prisma.requirement.create({
      data: {
        title: `ZZTEST Staff Nurse ICU ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Medical', recruiterId: uRec.id, tlId: uTl.id, bdeId: uBde.id, openings: 2,
        skills: 'Nursing, ICU, Patient care, Ventilator care', goodToHaveSkills: 'BLS, ACLS', experience: '2-5', qualifications: 'GNM or B.Sc Nursing', education: 'B.Sc Nursing',
        workMode: 'Work From Office', location: 'Hyderabad', joiningTimeline: 'Within 15 Days', noticePeriodMax: '30 Days', salary: '₹4L - ₹6L',
        responsibilities: 'Monitor critical patients\nGive medicines on time\nKeep patient records',
        jobDescription: `${CLIENT} needs ICU nurses. Salary: 4L to 6L per year, budget fixed by ${CLIENT}.\nRemarks: client asking to negotiate, follow up on Monday.`,
      },
    });
    made.reqs.push(req.id);
    const cand = await prisma.candidate.create({ data: { name: `ZZTEST Prep Cand ${RUN}`, email: CAND_EMAIL, phone: PHONE, location: 'ZZ', skills: 'Nursing, Patient care, Dialysis', currentSalary: '3L', expectedSalary: '5L' } });
    made.cands.push(cand.id);
    const when = new Date(Date.now() + 26 * 3600000);
    const app1 = await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, stage: 'INTERVIEW_SCHEDULED', interviewStatus: 'SCHEDULED', interviewAt: when, interviewType: 'Client Interview', interviewMode: 'Online', interviewMeetingLink: 'https://meet.example.com/zz-prep', interviewer: 'Dr Zed', interviewRound: 1 } });
    made.apps.push(app1.id);
    await prisma.interviewEvent.create({ data: { applicationId: app1.id, status: 'SCHEDULED', by: 'ZZTEST' } });
    const cand2 = await prisma.candidate.create({ data: { name: `ZZTEST Prep Cand AI ${RUN}`, email: `zz.prep.ai.${RUN}@zzprep-sandbox.in`, phone: '9000000043' } });
    made.cands.push(cand2.id);
    const app2 = await prisma.application.create({ data: { candidateId: cand2.id, requirementId: req.id, stage: 'AI_INTERVIEW_REQUIRED', aiInterviewStatus: 'Required', aiInterviewDeadline: '2026-12-31' } });
    made.apps.push(app2.id);
    // the one "Candidate emails" switch must be ON for the mail to be allowed to go (restored at the end)
    const sw = await prisma.appSetting.findUnique({ where: { key: SWITCH } });
    switchBefore = sw ? { value: sw.value } : null;
    await prisma.appSetting.upsert({ where: { key: SWITCH }, create: { key: SWITCH, value: JSON.stringify({ enabled: true }) }, update: { value: JSON.stringify({ ...(sw ? JSON.parse(sw.value) : {}), enabled: true }) } });

    const P = (id) => `/api/ats/interviews/${id}/prep`;
    const leakIn = (s) => {
      const t = String(s);
      const hits = [];
      if (t.includes(CLIENT) || /ZZTEST Prep Hospital/i.test(t)) hits.push('client name');
      if (/₹|\b4L\b|\b6L\b|4L to 6L|\bLPA\b|\bCTC\b|salary|\bbudget\b/i.test(t)) hits.push('pay');
      if (/negotiate|follow up on Monday|asking to/i.test(t)) hits.push('internal note');
      return hits;
    };

    // =============================== A: the card =====================================
    const g1 = await call('GET', P(app1.id), T.rec);
    const b1 = g1.body || {};
    const qs = (b1.pack ? b1.pack.groups.filter((g) => g.key !== 'ask').flatMap((g) => g.questions) : []);
    check('A1 recruiter opens the card (200)', g1.status === 200 && !!b1.pack, [g1.status, g1.text.slice(0, 200)]);
    check('A2 a client interview is recognised as the "client" round', b1.type === 'client' && b1.pack.typeLabel === 'Client interview', b1.type);
    check('A3 10-15 questions, 5 "Revise:" tips, questions to ask', qs.length >= 10 && qs.length <= 15 && b1.pack.tips.length === 5 && b1.pack.tips.every((t) => /^Revise:/.test(t)) && b1.pack.groups.find((g) => g.key === 'ask').questions.length >= 2, [qs.length, b1.pack && b1.pack.tips.length]);
    check('A4 the sandbox refuses AI, so the label says TEMPLATE (never "by AI") and says why', b1.pack.source === 'template' && b1.pack.sourceLabel === 'Suggested by template' && !!b1.pack.aiNote, [b1.pack.source, b1.pack.sourceLabel, b1.pack.aiNote]);
    check('A5 the questions come from the JD (ICU / nursing / patient)', /ICU|nurs|patient/i.test(JSON.stringify(b1.pack.groups)), b1.pack.groups.map((g) => g.questions[0]));
    const g1b = await call('GET', P(app1.id), T.rec);
    check('A6 cached: the second open is the same pack (same version, same time), nothing rewritten', g1b.body.pack.version === b1.pack.version && g1b.body.pack.generatedAt === b1.pack.generatedAt && g1b.body.generatedNow === false, [g1b.body.pack.generatedAt, b1.pack.generatedAt]);
    check('A7 the recruiter can change and send; the TL and the Admin too', b1.canEdit === true && b1.canSend === true && (await call('GET', P(app1.id), T.tl)).body.canEdit === true && (await call('GET', P(app1.id), T.admin)).body.canEdit === true);
    // edit: remove one, change one, add one
    const groups = Object.fromEntries(b1.pack.groups.map((g) => [g.key, [...g.questions]]));
    const removed = groups.scenario.pop();
    groups.about[0] = 'ZZ my own first question about you?';
    groups.role.push('ZZ added: how do you handle a night shift alone?');
    const e1 = await call('PUT', P(app1.id), T.rec, { type: 'client', groups, tips: b1.pack.tips, version: b1.pack.version });
    check('A8 edit / add / remove saves, version changes, label says edited by the recruiter', e1.status === 200 && e1.body.pack.version !== b1.pack.version && e1.body.pack.edited && /edited by/.test(e1.body.pack.sourceLabel) && /Suggested by template/.test(e1.body.pack.sourceLabel), [e1.status, e1.text.slice(0, 200)]);
    const eq = e1.body.pack.groups.flatMap((g) => g.questions);
    check('A9 the edit is really stored (new question there, removed question gone)', eq.includes('ZZ my own first question about you?') && eq.includes('ZZ added: how do you handle a night shift alone?') && !eq.includes(removed));
    const e2 = await call('PUT', P(app1.id), T.rec, { type: 'client', groups, tips: [], version: b1.pack.version });
    check('A10 an old version is refused (409): nobody overwrites a newer edit', e2.status === 409, e2.status);
    const e3 = await call('PUT', P(app1.id), T.rec, { type: 'client', groups: { about: [`Tell me about ${CLIENT}`], skills: [], scenario: [], role: [], ask: [] }, tips: [], version: e1.body.pack.version });
    check('A11 the client name typed into a question is replaced and the editor is warned', e3.status === 200 && !JSON.stringify(e3.body.pack).includes(CLIENT) && (e3.body.warnings || []).length > 0, [e3.status, e3.body && e3.body.warnings]);
    const rg = await call('POST', `${P(app1.id)}/regenerate`, T.rec, { type: 'client' });
    check('A12 "Write again" replaces the edits with a fresh pack from the job (template label, edited off)', rg.status === 200 && rg.body.pack.edited === false && rg.body.pack.sourceLabel === 'Suggested by template' && rg.body.pack.groups.flatMap((g) => g.questions).length > 10, [rg.status, rg.body && rg.body.pack && rg.body.pack.sourceLabel]);
    // JD changes
    await prisma.requirement.update({ where: { id: req.id }, data: { experience: '3-6' } });
    const g3 = await call('GET', P(app1.id), T.rec);
    check('A13 an UNEDITED pack follows a changed job by itself (new version, not stale)', g3.body.pack.version !== rg.body.pack.version && g3.body.stale === false && /3-6 years/.test(JSON.stringify(g3.body.pack.groups)), [g3.body.pack.version, rg.body.pack.version]);
    const g3g = Object.fromEntries(g3.body.pack.groups.map((g) => [g.key, [...g.questions]]));
    g3g.about.push('ZZ keep this edit?');
    await call('PUT', P(app1.id), T.rec, { type: 'client', groups: g3g, tips: g3.body.pack.tips, version: g3.body.pack.version });
    await prisma.requirement.update({ where: { id: req.id }, data: { experience: '4-7' } });
    const g4 = await call('GET', P(app1.id), T.rec);
    check('A14 an EDITED pack is kept and flagged "the job changed" when the job text changes', g4.body.stale === true && g4.body.pack.edited && JSON.stringify(g4.body.pack.groups).includes('ZZ keep this edit?'), [g4.body.stale]);

    // =============================== B: round types ==================================
    const gt = await call('GET', `${P(app1.id)}?type=team`, T.rec);
    check('B1 the team round has its own pack (separate cache) and no hiring-company must-haves line', gt.body.type === 'team' && gt.body.pack.version !== g4.body.pack.version && !/hiring company expects/i.test(JSON.stringify(gt.body.pack.groups)), gt.body.type);
    const gc = await call('POST', `${P(app1.id)}/regenerate`, T.rec, { type: 'client' });
    const cl = gc.body.pack.groups.find((g) => g.key === 'role').questions.join(' | ');
    check('B2 the client round states the job\'s must-haves (qualification, place, joining time) as "the hiring company", never by name', /hiring company expects/i.test(cl) && /Hyderabad/.test(cl) && /15 days/i.test(cl) && !cl.includes(CLIENT), cl);
    const ga = await call('GET', P(app2.id), T.rec);
    check('B3 an AI-interview application gets an AI-round pack with AI-round advice (camera / deadline), no booking time', ga.body.type === 'ai' && ga.body.pack.typeLabel === 'AI interview' && /camera/i.test(ga.body.candidate.onTheDay.join(' ')) && /2026-12-31/.test(ga.body.candidate.onTheDay.join(' ')), [ga.body.type, ga.body.candidate && ga.body.candidate.onTheDay]);
    check('B4 the AI-round pack is shorter than the client round', ga.body.pack.groups.flatMap((g) => g.questions).length < gc.body.pack.groups.flatMap((g) => g.questions).length);
    const gp = await call('GET', `${P(app1.id)}?type=client`, T.rec);
    check('B5 the candidate\'s own resume skills add "From your resume" lines (not stored in the job pack)', gp.body.candidate.groups.some((g) => g.key === 'cv' && /Nursing|Patient care/.test(g.questions.join(' '))) && !JSON.stringify(gp.body.pack.groups).includes('Your resume shows'), gp.body.candidate.groups.map((g) => g.key));

    // =============================== C: privacy ======================================
    const cand1 = gp.body.candidate;
    check('C1 candidate-facing text: no client name, no pay, no internal note', leakIn(JSON.stringify(cand1)).length === 0, leakIn(JSON.stringify(cand1)));
    check('C2 the generated pack itself (what is stored) holds none of them either', leakIn(JSON.stringify(gp.body.pack)).length === 0, leakIn(JSON.stringify(gp.body.pack)));
    const gb = await call('GET', P(app1.id), T.bde);
    check('C3 the BDE of the client reads the card: 200, read only (cannot edit or send)', gb.status === 200 && gb.body.canEdit === false && gb.body.canSend === false && !!gb.body.pack, [gb.status, gb.body && gb.body.canEdit]);
    check('C4 the BDE view has no mail state, no link to share, no candidate number / address / pay / score', gb.body.email === undefined && gb.body.link === null && (await call('GET', `${P(app1.id)}/channels?type=client`, T.bde)).status === 403 && !gb.text.includes(PHONE) && !gb.text.includes(CAND_EMAIL) && !/currentSalary|expectedSalary|aiInterviewScore|matchScore/i.test(gb.text) && !/"(3L|5L)"/.test(gb.text), [gb.body.email, gb.body.link]);
    check('C5 the BDE view holds no client pay / internal note either', leakIn(gb.text.replace(new RegExp(CLIENT, 'g'), '')).length === 0, leakIn(gb.text));
    const bput = await call('PUT', P(app1.id), T.bde, { type: 'client', groups, tips: [] });
    const bsend = await call('POST', `${P(app1.id)}/send`, T.bde, { type: 'client' });
    const bregen = await call('POST', `${P(app1.id)}/regenerate`, T.bde, {});
    const blink = await call('POST', `${P(app1.id)}/link`, T.bde, {});
    check('C6 a BDE cannot edit, send, rewrite or share a link (403 each)', [bput, bsend, bregen, blink].every((r) => r.status === 403), [bput.status, bsend.status, bregen.status, blink.status]);
    const gm = await call('GET', P(app1.id), T.mgr);
    const mput = await call('PUT', P(app1.id), T.mgr, { type: 'client', groups, tips: [] });
    check('C7 a Manager reads it, cannot change it', gm.status === 200 && gm.body.canEdit === false && mput.status === 403, [gm.status, mput.status]);
    const jb = await call('GET', `/api/ats/jobs/${req.id}/prep?type=client`, T.bde);
    check('C8 the BDE reads the pack of the job of their client (job view)', jb.status === 200 && !!jb.body.pack && jb.body.canEdit === false && !jb.text.includes(PHONE) && !jb.text.includes(CAND_EMAIL), jb.status);
    const jbo = await call('GET', `/api/ats/jobs/${req.id}/prep?type=client`, T.bdeOther);
    const rbo = await call('GET', P(app1.id), T.recOther);
    const bbo = await call('GET', P(app1.id), T.bdeOther);
    check('C9 people outside the job\'s area (another department\'s BDE / recruiter) are refused', [jbo.status, rbo.status, bbo.status].every((s) => s === 403 || s === 404), [jbo.status, rbo.status, bbo.status]);

    // =============================== D: sending ======================================
    const chn = await call('GET', `${P(app1.id)}/channels?type=client`, T.rec);
    const state = (chn.body && chn.body.email) || {};
    const connected = (chn.body && chn.body.connected) || {};
    console.log(`   (mail channel in this sandbox: connected=${connected.Email}, dry run: ${state.state}${state.reason ? ` - ${state.reason}` : ''})`);
    check('D1 the card tells the recruiter honestly whether the mail can go', ['send', 'blocked', 'none'].includes(state.state), state);
    const before = await prisma.candidateMessage.count({ where: { candidateId: cand.id } });
    const s1 = await call('POST', `${P(app1.id)}/send`, T.rec, { type: 'client', channels: ['Email'] });
    const a1 = (s1.body && s1.body.attempts && s1.body.attempts[0]) || {};
    const rows = await prisma.candidateMessage.findMany({ where: { candidateId: cand.id }, orderBy: { createdAt: 'asc' } });
    const prepRow = rows.find((r) => r.templateLabel === PREP.PREP_LABEL);
    if (state.state === 'send') {
      check('D2 send by mail: sent (sandbox fake transport) and logged in the candidate\'s message history', s1.status === 200 && ['sent', 'sending'].includes(a1.status) && !!prepRow && prepRow.channel === 'Email' && ['SENT', 'QUEUED', 'DELIVERED'].includes(prepRow.status), [s1.status, a1, prepRow && prepRow.status]);
      check('D3 the mail text: questions + tips + on-the-day + the page link; NO client name, pay or internal note', !!prepRow && /1\./.test(prepRow.body) && /REVISE BEFORE/.test(prepRow.body) && /ON THE DAY/.test(prepRow.body) && /\/prep\//.test(prepRow.body) && leakIn(prepRow.body + prepRow.subject).length === 0, prepRow && leakIn(prepRow.body + prepRow.subject));
      check('D3b it names the hiring company only as "the hiring company" and shows the interview facts the candidate needs', !!prepRow && /Round 1/.test(prepRow.body) && /Online/.test(prepRow.body) && !/ZZTEST Prep Hospital/i.test(prepRow.body));
      const s2 = await call('POST', `${P(app1.id)}/send`, T.rec, { type: 'client', channels: ['Email'] });
      check('D4 the same version is not sent twice for one interview ("already")', s2.body.attempts[0].status === 'already' && (await prisma.candidateMessage.count({ where: { candidateId: cand.id, templateLabel: PREP.PREP_LABEL } })) === 1, s2.body);
      const cur = (await call('GET', P(app1.id), T.rec)).body;
      check('D5 after sending, the card says so (sent this version, log entry with who and when)', cur.sentThisVersion === true && cur.shares.some((x) => x.channel === 'Email' && x.status === 'sent' && x.byName && x.at), cur.shares);
      const gq = Object.fromEntries(cur.pack.groups.map((g) => [g.key, [...g.questions]]));
      gq.about.push('ZZ one more question after sending?');
      await call('PUT', P(app1.id), T.rec, { type: 'client', groups: gq, tips: cur.pack.tips, version: cur.pack.version });
      const s3 = await call('POST', `${P(app1.id)}/send`, T.rec, { type: 'client', channels: ['Email'] });
      check('D6 after an edit, the new version goes out again', s3.body.attempts[0].status === 'sent' && (await prisma.candidateMessage.count({ where: { candidateId: cand.id, templateLabel: PREP.PREP_LABEL } })) === 2, s3.body);
      const s4 = await call('POST', `${P(app1.id)}/send`, T.rec, { type: 'client', channels: ['Email'], again: true });
      check('D7 "Send again" sends the same version once more on request', s4.body.attempts[0].status === 'sent' && (await prisma.candidateMessage.count({ where: { candidateId: cand.id, templateLabel: PREP.PREP_LABEL } })) === 3);
      const tell = await call('GET', `/api/ats/interviews/${app1.id}/tell?kind=scheduled`, T.rec);
      check('D8 the prep mail is NOT counted as "the candidate was told about the booking" (the booking window / safety net still do their job)', tell.status === 200 && tell.body.candidate && tell.body.candidate.alreadyTold === false, tell.body && tell.body.candidate && tell.body.candidate.told);
    } else {
      check('D2 mail not possible here: honest "not sent" with the reason, nothing logged as sent', s1.status === 200 && s1.body.nothingSent === true && !!a1.reason && !rows.some((r) => r.templateLabel === PREP.PREP_LABEL && r.status === 'SENT'), [s1.status, a1]);
    }
    const sw1 = await call('POST', `${P(app1.id)}/send`, T.rec, { type: 'client', channels: ['WhatsApp'], again: true });
    check('D9 WhatsApp / SMS are used only when connected and allowed - otherwise "not sent" with the reason, never faked', sw1.status === 200 && ['sent', 'sending', 'not sent'].includes(sw1.body.attempts[0].status) && (sw1.body.attempts[0].status !== 'not sent' || !!sw1.body.attempts[0].reason), sw1.body);
    // consent withdrawn
    await prisma.candidate.update({ where: { id: cand.id }, data: { doNotContact: true, consentStatus: 'WITHDRAWN' } });
    const c1 = await call('POST', `${P(app1.id)}/send`, T.rec, { type: 'client', channels: ['Email'], again: true });
    check('D10 consent withdrawn: nothing is sent, the reason says so', c1.body.attempts[0].status === 'not sent' && /not be contacted|consent/i.test(c1.body.attempts[0].reason || ''), c1.body.attempts);
    const gcw = await call('GET', `${P(app1.id)}/channels?type=client`, T.rec);
    check('D11 the card shows the mail as blocked for a withdrawn consent', gcw.body.email && gcw.body.email.state === 'blocked', gcw.body.email);
    await prisma.candidate.update({ where: { id: cand.id }, data: { doNotContact: false, consentStatus: 'GIVEN' } });
    // switch off
    await prisma.appSetting.update({ where: { key: SWITCH }, data: { value: JSON.stringify({ enabled: false }) } });
    const so = await call('POST', `${P(app1.id)}/send`, T.rec, { type: 'client', channels: ['Email'], again: true });
    check('D12 the company "Candidate emails" switch OFF: not sent, says why', so.body.attempts[0].status === 'not sent' && /switch|off/i.test(so.body.attempts[0].reason || ''), so.body.attempts);
    await prisma.appSetting.update({ where: { key: SWITCH }, data: { value: JSON.stringify({ enabled: true }) } });

    // =============================== E: the candidate's page + reminder ==================
    const tok = PREP.tokenFor(app1.id);
    const pg = await call('GET', `/api/public/interview-prep/${tok}`);
    if (state.state === 'send') {
      check('E1 the candidate opens the page with NO login; it shows the questions, tips, on-the-day, recruiter contact', pg.status === 200 && pg.body.groups.length >= 4 && pg.body.tips.length >= 4 && pg.body.onTheDay.length >= 2 && !!pg.body.contact, [pg.status, pg.text.slice(0, 200)]);
      check('E2 the page holds no client name, pay, internal note, candidate contact or score', leakIn(pg.text).length === 0 && !pg.text.includes(CAND_EMAIL) && !pg.text.includes(PHONE) && !/aiInterviewScore|matchScore|currentSalary/i.test(pg.text) && pg.body.company === 'the hiring company', [leakIn(pg.text), pg.body && pg.body.company]);
    }
    const bad = await call('GET', `/api/public/interview-prep/${tok.slice(0, -2)}ab`);
    const junk = await call('GET', '/api/public/interview-prep/not-a-token');
    check('E3 a changed or made-up link opens nothing (404)', bad.status === 404 && junk.status === 404, [bad.status, junk.status]);
    const none = await call('GET', `/api/public/interview-prep/${PREP.tokenFor(app2.id)}`);
    check('E4 an interview nobody shared prep for has nothing to show yet (404, not the unreviewed pack)', none.status === 404, none.status);
    const lk = await call('POST', `${P(app2.id)}/link`, T.rec, {});
    check('E5 "Copy link" returns the page link and counts as shared', lk.status === 200 && /\/prep\//.test(lk.body.link || ''), lk.body);
    const pg2 = await call('GET', `/api/public/interview-prep/${PREP.tokenFor(app2.id)}`);
    check('E6 then the AI-interview page opens (deadline, no client name / pay)', pg2.status === 200 && pg2.body.type === 'ai' && /2026-12-31/.test(pg2.text) && leakIn(pg2.text).length === 0, [pg2.status, pg2.text.slice(0, 160)]);
    const note0 = await PREP.prepNote({ id: 'ZZNOSHARE', candidate: {}, requirement: {} });
    const note1 = await PREP.prepNote(app1);
    check('E7 the reminder note: a link only when a pack was really shared, else a plain line', /^Be ready/.test(note0) && /^How to prepare: .*\/prep\//.test(note1) === (state.state === 'send'), [note0, note1]);
    const IM = require(path.join(BACK, 'src/utils/interviewMessageDefaults'));
    check('E8 the day-before reminder wording carries {{prepNote}} (mail and short text)', IM.list().filter((r) => r.purpose === 'INTERVIEW_REMIND_DAY' && r.channel !== 'Call').every((r) => r.body.includes('{{prepNote}}')));
    const T2 = require(path.join(BACK, 'src/utils/messageTemplates'));
    check('E9 prepNote is a known placeholder (no "unknown placeholder" error)', T2.unknownTokens('x {{prepNote}} y').length === 0 && T2.TOKENS.some((t) => t.key === 'prepNote'));
  } catch (e) {
    fail += 1; console.error('TEST CRASH', e);
  } finally {
    try {
      const appIds = made.apps; const candIds = made.cands; const reqIds = made.reqs;
      if (switchBefore) await prisma.appSetting.update({ where: { key: 'interview-reminders' }, data: { value: switchBefore.value } }).catch(() => {});
      else await prisma.appSetting.deleteMany({ where: { key: 'interview-reminders' } }).catch(() => {});
      await prisma.appSetting.deleteMany({ where: { OR: [...reqIds.map((id) => ({ key: { startsWith: `${PREP.PACK_PREFIX}${id}` } })), ...appIds.map((id) => ({ key: `${PREP.SHARE_PREFIX}${id}` })), { key: { startsWith: `${PREP.PACK_PREFIX}ZZNOSHARE` } }] } }).catch(() => {});
      // the conversation tables are written with raw SQL by the app (no Prisma delegate)
      for (const id of candIds) {
        await prisma.$executeRawUnsafe('DELETE FROM "ConversationMessage" WHERE personId = ?', id).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "Conversation" WHERE personId = ?', id).catch(() => {});
      }
      await prisma.candidateMessage.deleteMany({ where: { candidateId: { in: candIds } } }).catch(() => {});
      await prisma.applicationFollowUp.deleteMany({ where: { OR: [{ applicationId: { in: appIds } }, { candidateId: { in: candIds } }] } }).catch(() => {});
      await prisma.applicationStageEvent.deleteMany({ where: { OR: [{ applicationId: { in: appIds } }, { candidateId: { in: candIds } }] } }).catch(() => {});
      await prisma.interviewEvent.deleteMany({ where: { applicationId: { in: appIds } } }).catch(() => {});
      await prisma.application.deleteMany({ where: { id: { in: appIds } } });
      await prisma.candidate.deleteMany({ where: { id: { in: candIds } } });
      await prisma.requirement.deleteMany({ where: { id: { in: reqIds } } });
      await prisma.client.deleteMany({ where: { id: { in: made.clients } } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: made.users } }, { entityId: { in: [...appIds, ...reqIds, ...candIds, ...made.users] } }] } }).catch(() => {});
      await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: made.users } }, { title: { contains: 'ZZTEST' } }] } }).catch(() => {});
      await prisma.employee.deleteMany({ where: { id: { in: made.emps } } });
      await prisma.user.deleteMany({ where: { id: { in: made.users } } });
      const left = {
        users: await prisma.user.count({ where: { email: { contains: `-${RUN}@example.test` } } }),
        cands: await prisma.candidate.count({ where: { name: { contains: RUN } } }),
        reqs: await prisma.requirement.count({ where: { title: { contains: RUN } } }),
        clients: await prisma.client.count({ where: { name: { contains: RUN } } }),
        msgs: await prisma.candidateMessage.count({ where: { candidateId: { in: made.cands } } }),
        settings: await prisma.appSetting.count({ where: { OR: [{ key: { startsWith: `${PREP.PACK_PREFIX}${made.reqs[0] || 'none'}` } }, { key: { startsWith: `${PREP.SHARE_PREFIX}${made.apps[0] || 'none'}` } }] } }),
      };
      console.log('leftovers after cleanup:', JSON.stringify(left));
      check('Z cleanup: nothing ZZTEST of this run is left in the sandbox', Object.values(left).every((n) => n === 0), left);
    } catch (e) { console.error('cleanup problem:', e.message); }
    console.log(`\nINTERVIEW PREP API TESTS: ${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
