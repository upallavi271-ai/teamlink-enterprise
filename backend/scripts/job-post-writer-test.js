#!/usr/bin/env node
// ---------------------------------------------------------------------------
// "WRITE THE JOB POSTS" tests (2026-10-10). SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/job-post-writer-test.js
//
//   U  pure helpers (salary, internal notes, extraction, diff, blanks)
//   G  the generator: complete job, thin job, hidden client, internal job,
//      inclusive wording, LinkedIn <= 250 words, Naukri tags, Indeed title, [ ] list
//   A  API: per-role 403 / 200, save / reset / stale, audit, Post by hand, Indeed feed
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
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const W = require(path.join(BACK, 'src/utils/jobPostWriter'));
const JT = require(path.join(BACK, 'src/utils/jobText'));

const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600)}` : ''}`);
}
async function call(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  for (let i = 0; ; i += 1) {
    try {
      const r = await fetch(`${API}${p}`, { method, headers: h, body: payload });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, body: json, text };
    } catch (e) { if (i >= 30) throw e; await new Promise((res) => setTimeout(res, 2000)); }
  }
}
const wc = (t) => String(t || '').trim().split(/\s+/).filter(Boolean).length;
const all = (o) => [o.master.text, ...Object.values(o.boards).map((b) => b.text), o.boards.linkedin.post, o.boards.naukri.title, o.boards.naukri.tags.join(' ')].join('\n');

(async () => {
  const made = { users: [], clients: [], reqs: [] };
  const CLIENT_NAME = `ZZTEST Hidden Hospital ${RUN}`;
  try {
    // ---------------------------------------------------------------- U: pure helpers
    check('U1 salary band -> LPA', W.formatSalary('₹14L - ₹20L', 'Annual CTC') === '₹14 - ₹20 LPA' && W.formatSalary('₹6L+') === '₹6 LPA and above' && W.formatSalary('up to ₹8L') === 'Up to ₹8 LPA');
    check('U2 plain yearly rupees -> LPA; monthly / Best in industry left alone', W.formatSalary('600000', 'Annual CTC') === '₹6 LPA' && W.formatSalary('25000', 'Monthly') === '25000' && W.formatSalary('Best in industry') === 'Best in industry' && W.formatSalary('—') === '');
    const tracker = 'Bed capacity: 100\nPackage / experience: Experience:1 Year Salary-3LPM to 5LPM (Negotiable and decided after interview) Candidates-All over india\nSpecialization column note: 22-1-25 On Hold from vasu sir because client asking to negotiate the charges\nFollow-up history:\n  • 24-10-24 messaged to sir about requirement\n  • 01-11-2024 Call not Answered\nWe need a staff nurse for a busy ward. The work is in shifts.';
    const pub = W.publishable(tracker);
    check('U3 internal tracker notes dropped, real sentences kept', /staff nurse/.test(pub.text) && !/sir|negotiate|Follow-up|Bed capacity|Package/i.test(pub.text) && pub.dropped.length >= 4, pub);
    const ex = W.extractFromText(tracker);
    check('U4 extraction: experience + salary from the note, with the phrase', ex.experience && ex.experience.value === '1' && ex.salary && /3LPM to 5LPM/.test(ex.salary.value) && ex.salary.phrase, ex);
    const ex2 = W.extractFromText('Package / experience: Experience-2 -3 Years Salary- 18K To 25K Gyanic and pediatric experience Candidates should be North East');
    check('U5 extraction: "2 -3 Years" and "18K To 25K"', ex2.experience && ex2.experience.value === '2-3' && ex2.salary && ex2.salary.value === '18K To 25K', ex2);
    check('U6 extraction finds nothing when the text has nothing', Object.keys(W.extractFromText('Created from the education interview history.')).length === 0);
    check('U7 education + location + skills extraction', (() => { const e = W.extractFromText('Qualification MBBS, MD required. Work location: Pune. Key skills: ICU, BLS, ACLS'); return e.education.value === 'MBBS, MD' && /Pune/.test(e.location.value) && e.skills.value === 'ICU, BLS, ACLS'; })());
    const d = W.lineDiff('a\nb\nc', 'a\nx\nc');
    check('U8 line diff: one removed, one added', d.filter((x) => x.op === 'del').length === 1 && d.filter((x) => x.op === 'add').length === 1 && d[0].op === 'same', d);
    check('U9 stripBlanks removes [ ] lines and empty headings', W.stripBlanks('Benefits:\n• [ ]\n\nDuties\n• Do work\nPay: [ ]') === 'Duties\n• Do work', W.stripBlanks('Benefits:\n• [ ]\n\nDuties\n• Do work\nPay: [ ]'));

    // ---------------------------------------------------------------- fixtures
    const client = await prisma.client.create({ data: { name: CLIENT_NAME, industry: 'Healthcare', status: 'Active', agreementStatus: 'ACTIVE', ownerDepartment: 'Medical' } });
    made.clients.push(client.id);
    const baseU = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mkUser = async (tag, extra) => {
      const u = await prisma.user.create({ data: { ...baseU, name: `ZZTEST JP ${tag} ${RUN}`, email: `zz-jp-${tag}-${RUN}@example.test`, username: `zz-jp-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id); return u;
    };
    const uAdmin = await mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const uBde = await mkUser('bde', { role: 'BDE', atsRole: 'BDE' });
    const uBde2 = await mkUser('bde2', { role: 'BDE', atsRole: 'BDE' });
    const uMgr = await mkUser('mgr', { role: 'MANAGER', atsRole: 'MANAGER' });
    const uEmp = await mkUser('emp', { role: 'EMPLOYEE', atsRole: 'EMPLOYEE' });
    const uCli = await mkUser('client', { role: 'CLIENT', atsRole: 'CLIENT', clientId: client.id });
    const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    const T = {};
    for (const [k, u] of Object.entries({ admin: uAdmin, bde: uBde, bde2: uBde2, mgr: uMgr, emp: uEmp, cli: uCli })) T[k] = await mint(u); // eslint-disable-line no-await-in-loop
    const mkReq = async (data) => { const r = await prisma.requirement.create({ data: { clientId: client.id, status: 'OPEN', bdeId: uBde.id, ...data } }); made.reqs.push(r.id); return r; };
    const full = (id) => prisma.requirement.findUnique({ where: { id }, include: { client: true } });

    // A complete job (every real field filled) — the client's name is inside the title and the text on purpose.
    const rFull = await mkReq({
      title: `Senior Staff Nurse Ninja ${CLIENT_NAME}`, department: 'Medical', specialisation: 'ICU', employmentType: 'Full Time', workMode: 'Work From Office', openings: 3,
      location: 'Hyderabad, Telangana', experience: '2-5', education: 'B.Sc Nursing', salary: '₹4L - ₹6L', salaryType: 'Annual CTC',
      skills: 'ICU, BLS, ACLS, Ventilator care, Patient monitoring, Infection control, Documentation, Medication administration',
      goodToHaveSkills: 'Dialysis, Triage, Electronic records, Mentoring', noticePeriodMax: '30 Days', joiningTimeline: 'Within 15 Days', priority: 'High', reqCode: `ZZJP-${RUN}-1`,
      jobDescription: `${CLIENT_NAME} needs a nurse for its intensive care unit. The team works in rotating shifts and looks after critical patients.`,
      responsibilities: ['Monitor patients in the ICU', 'Give medicines as prescribed', 'Operate and check ventilators', 'Keep patient records up to date', 'Support doctors during procedures', 'Follow infection control rules', 'Talk to families about care plans', 'Train junior nurses', 'Report incidents on time'].join('\n'),
      qualifications: 'Registered nurse with a valid council registration\nBLS certificate',
    });
    const ovFull = { benefits: 'Health insurance\nProvident fund\nShift allowance', contactEmail: 'careers@teamlink-staffing.in', contactName: 'Asha' };
    const gFull = await JT.generate(await full(rFull.id), ovFull, 'https://app.example-host.in');
    const heads = ['ABOUT THE COMPANY', 'ROLE OVERVIEW', 'RESPONSIBILITIES', 'REQUIREMENTS', 'PREFERRED SKILLS', 'BENEFITS', 'HOW TO APPLY'];
    const idx = heads.map((h) => gFull.master.text.indexOf(`\n${h}\n`) >= 0 || gFull.master.text.startsWith(`${h}\n`) ? gFull.master.text.indexOf(h) : -1);
    check('G1 master JD has the 7 sections in order', idx.every((i) => i >= 0) && idx.every((v, i) => i === 0 || v > idx[i - 1]), idx);
    check('G2 complete job: nothing missing, no [ ] anywhere', gFull.missing.length === 0 && !/\[ \]/.test(all(gFull)), { missing: gFull.missing.map((m) => m.key), blanks: all(gFull).match(/.*\[ \].*/g) });
    check('G3 Naukri: 10 to 15 key-skill tags, separate from the text', gFull.boards.naukri.tags.length >= 10 && gFull.boards.naukri.tags.length <= 15, gFull.boards.naukri.tags);
    check('G4 Naukri title is keyword-rich (skills + city) and text is bullets', /ICU/.test(gFull.boards.naukri.title) && /Hyderabad/.test(gFull.boards.naukri.title) && (gFull.boards.naukri.text.match(/^• /gm) || []).length >= 8);
    const shineTop = gFull.boards.shine.text.split('\n').slice(0, 4).join('|');
    check('G5 Shine: salary, experience, location come first', /Salary: ₹4 - ₹6 LPA/.test(shineTop) && /Experience: 2-5 years/.test(shineTop) && /Location: Hyderabad/.test(shineTop), shineTop);
    check('G6 Indeed: plain searchable title (no "Ninja"), separate Pay / Job type / Location / Benefits blocks', !/ninja/i.test(gFull.boards.indeed.title) && /^Job title: /m.test(gFull.boards.indeed.text) && /^Pay: ₹4 - ₹6 LPA/m.test(gFull.boards.indeed.text) && /^Job type: /m.test(gFull.boards.indeed.text) && /^Location: /m.test(gFull.boards.indeed.text) && /^Benefits:/m.test(gFull.boards.indeed.text), gFull.boards.indeed.title);
    const li = gFull.boards.linkedin;
    check('G7 LinkedIn text <= 250 words with 3-5 hashtags and 4-5 duties / needs', wc(li.text) <= 250 && li.hashtags.length >= 3 && li.hashtags.length <= 5 && (li.text.match(/^• /gm) || []).length >= 8 && (li.text.match(/^• /gm) || []).length <= 10, { words: wc(li.text), tags: li.hashtags });
    check('G8 LinkedIn feed post is 3-4 lines', li.post.split('\n').length >= 3 && li.post.split('\n').length <= 4, li.post);
    check('G9 apply link carries ?src= per board', /src=Naukri/.test(gFull.boards.naukri.text) && /src=Shine/.test(gFull.boards.shine.text) && /src=Indeed/.test(gFull.boards.indeed.text) && /src=LinkedIn/.test(li.text) && /https:\/\/app\.example-host\.in\/careers\//.test(li.text));
    check('G10 contact is the typed email + name; no phone', /careers@teamlink-staffing\.in/.test(gFull.master.text) && /Asha/.test(gFull.master.text) && !/\+91/.test(all(gFull)));
    check('G11 client name never appears (title / description scrubbed); company shown as Confidential', !all(gFull).toLowerCase().includes(CLIENT_NAME.toLowerCase()) && gFull.leak.length === 0 && gFull.company.shown === 'Confidential' && gFull.warnings.some((w) => w.phrase === CLIENT_NAME), { leak: gFull.leak, shown: gFull.company.shown });
    check('G12 company line states the sector only (no "leading" claim)', /organisation in the healthcare sector/.test(gFull.master.text) && !/leading|reputed|top/i.test(gFull.master.text));
    check('G13 checklist: 5 points built from the job; nothing to fix on the complete job except the client name was scrubbed', gFull.checklist.length === 5 && gFull.checklist.map((c) => c.key).join() === 'salary,location,contact,experience,wording' && !gFull.checklist.some((c) => c.status === 'fix' && c.key !== 'wording'), gFull.checklist.map((c) => `${c.key}:${c.status}`));
    check('G14 edited-text texts map has every editable key', ['master', 'naukri', 'naukriTitle', 'naukriTags', 'shine', 'indeed', 'indeedTitle', 'linkedin', 'linkedinPost'].every((k) => typeof gFull.texts[k] === 'string' && gFull.texts[k].length > 0));

    // A very long job: LinkedIn must still be <= 250 words
    const rLong = await mkReq({ title: 'ZZTEST Long job', location: 'Pune', experience: '3-6', skills: 'A1, B2, C3', responsibilities: Array.from({ length: 12 }, (_, i) => `Responsibility number ${i} with a very long sentence about the work that goes on for many words to push the text past the limit of two hundred and fifty words easily`).join('\n'), jobDescription: Array.from({ length: 40 }, () => 'This is a long sentence about the job and the team.').join(' ') });
    const gLong = await JT.generate(await full(rLong.id), {}, '');
    check('G15 very long job: LinkedIn text is still <= 250 words', wc(gLong.boards.linkedin.text) <= 250, wc(gLong.boards.linkedin.text));

    // A thin imported job: nothing but title + the tracker notes
    const rThin = await mkReq({
      title: 'Assistant Doctor', bdeId: null, department: 'Medical', location: null, salary: null, experience: null, skills: null, education: 'Any Degree', reqCode: `ZZJP-${RUN}-2`,
      jobDescription: `Bed capacity: 100\nPackage / experience: Experience:1 Year Salary-3LPM to 5LPM (Negotiable) Candidates-All over india\nSpecialization column note: 22-1-25 On Hold from the boss because ${CLIENT_NAME} asking to negotiate the charges\nFollow-up history:\n  • 24-10-24 messaged to sir about requirement but no response`,
    });
    const gThin = await JT.generate(await full(rThin.id), {}, '');
    const need = gThin.missing.filter((m) => !m.optional).map((m) => m.key);
    check('G20 thin job: the [ ] list is exactly what is blank', ['location', 'experience', 'salary', 'skills', 'responsibilities', 'contactEmail'].every((k) => need.includes(k)) && !need.includes('education'), need);
    check('G21 thin job: texts show [ ] for every blank (no invented facts)', /Location: \[ \]/.test(gThin.master.text) && /Salary: \[ \]/.test(gThin.boards.naukri.text) && /Pay: \[ \]/.test(gThin.boards.indeed.text) && /Experience: \[ \]/.test(gThin.boards.shine.text) && !/\d+ ?LPA|years/i.test(gThin.boards.shine.text.replace(/Notice.*/g, '').replace(/Openings.*/g, '')), gThin.boards.shine.text.slice(0, 400));
    check('G22 thin job: internal tracker notes never reach any post', !/Bed capacity|negotiate|Follow-up|sir|no response|Specialization column|Package/i.test(all(gThin)) && gThin.notes.length === 1, gThin.notes);
    check('G23 thin job: the client name inside the notes cannot leak', !all(gThin).toLowerCase().includes(CLIENT_NAME.toLowerCase()) && gThin.leak.length === 0);
    check('G24 thin job: "Fill from the job description" offers experience + salary with the phrase, marked check', (() => { const s = Object.fromEntries(gThin.suggestions.map((x) => [x.key, x])); return s.experience && s.experience.value === '1' && s.salary && /3LPM/.test(s.salary.value) && s.salary.phrase && /Check/.test(s.salary.check); })(), gThin.suggestions);
    check('G25 thin job: tags < 10 come with an honest note; hashtags still 3-5; LinkedIn <= 250 words', gThin.boards.naukri.tags.length < 10 && !!gThin.boards.naukri.tagsNote && gThin.boards.linkedin.hashtags.length >= 3 && wc(gThin.boards.linkedin.text) <= 250, { tags: gThin.boards.naukri.tags, note: gThin.boards.naukri.tagsNote });
    check('G26 thin job checklist: salary, location, contact, experience need fixing', ['salary', 'location', 'contact', 'experience'].every((k) => gThin.checklist.find((c) => c.key === k).status === 'fix'), gThin.checklist.map((c) => `${c.key}:${c.status}`));
    const gThinFilled = await JT.generate(await full(rThin.id), { location: 'Uppal, Hyderabad', salary: '₹3L - ₹5L', experience: '1-3', skills: 'OPD, Prescribing' }, '');
    check('G27 typing the gaps refreshes the text and shrinks the list', /Location: Uppal, Hyderabad/.test(gThinFilled.master.text) && !gThinFilled.missing.some((m) => m.key === 'salary') && /₹3 - ₹5 LPA|₹3L - ₹5L/.test(gThinFilled.boards.indeed.text));
    check('G28 "Best in industry" only when typed', !/Best in industry/i.test(gThin.master.text) && /Best in industry/.test((await JT.generate(await full(rThin.id), { salary: 'Best in industry' }, '')).master.text));

    // Internal (TeamLink's own) job names TeamLink
    const rInt = await mkReq({ title: 'ZZTEST HR Executive', internal: true, location: 'Hyderabad', skills: 'Hiring' });
    const gInt = await JT.generate(await full(rInt.id), {}, '');
    check('G30 internal job: TeamLink Consultants is the company', gInt.company.shown === 'TeamLink Consultants' && /TeamLink Consultants/.test(gInt.master.text) && gInt.company.hidesClient === false);

    // Inclusive wording
    const rBias = await mkReq({ title: 'ZZTEST Receptionist', location: 'Hyderabad', jobDescription: 'We need a young, presentable girl. Male candidates only for the night desk. Age below 30 years. Unmarried preferred. Hindu candidates welcome. Must answer calls well.', responsibilities: 'Answer calls\nWelcome guests; only females please\nKeep the desk tidy', skills: 'Typing, Phone etiquette' });
    const gBias = await JT.generate(await full(rBias.id), {}, '');
    const phrases = gBias.warnings.map((w) => w.phrase.toLowerCase()).join(' | ');
    check('G40 bias: age, gender, marital status, religion and "young" are all flagged with the exact phrase', /age below 30/.test(phrases) && /male/.test(phrases) && /unmarried/.test(phrases) && /hindu/.test(phrases) && /young/.test(phrases) && /females/.test(phrases) && gBias.warnings.every((w) => w.suggest && w.why), phrases);
    check('G41 bias: the flagged phrases are left out of every generated text (flagged, not silently rewritten)', !/age below|unmarried|male candidates|hindu|young|girl|females/i.test(all(gBias)) && /Answer calls/.test(gBias.master.text) && /Must answer calls well/.test(gBias.master.text), gBias.master.text.slice(0, 500));
    check('G42 bias checklist says fix the wording', gBias.checklist.find((c) => c.key === 'wording').status === 'fix');
    const lt = JT.lintTexts({ naukri: 'Great role for men only. Freshers under 25 years old welcome.', indeedTitle: `Nurse at ${CLIENT_NAME}` }, [CLIENT_NAME]);
    check('G43 lint on EDITED text: gender, age and the client name are caught', lt.some((x) => /men/i.test(x.phrase)) && lt.some((x) => /25 years old/i.test(x.phrase)) && lt.some((x) => x.client && x.key === 'indeedTitle'), lt);

    // AI output is checked against the facts
    const f0 = await JT.buildFacts(await full(rFull.id), ovFull, '');
    const v = JT.validateAi({
      master: `ABOUT THE COMPANY\nOur client is a good one.\nWe pay ₹99 LPA\nSalary ${CLIENT_NAME} offers\nOnly young males\nRESPONSIBILITIES\n• Monitor patients`,
      naukri: { title: 'Nurse', text: 'Monitor patients\nWe have 500 beds', tags: ['ICU', 'Blockchain', 'BLS'] },
      shine: { text: 'ok' }, indeed: { title: 'Nurse', text: 'ok' }, linkedin: { text: 'ok', hashtags: ['#Hiring', '#Crypto'], post: 'ok' },
    }, f0);
    check('G50 AI check drops an invented number, a client name, an age phrase and a tag that is not a skill', !/99|500|young|ZZTEST/.test(v.res.master + v.res.naukri.text) && v.res.naukri.tags.join() === 'ICU,BLS' && !v.res.linkedin.hashtags.includes('#Crypto') && v.dropped.length >= 5, v.dropped.map((d) => d.why));

    // ---------------------------------------------------------------- A: the API
    const P = (id, s = '') => `/api/requirements/${id}/job-posts${s}`;
    const aAdmin = await call('GET', P(rFull.id), T.admin);
    check('A1 Admin GET job-posts 200 with texts, 5 checklist points, ai status, nothing saved yet', aAdmin.status === 200 && aAdmin.body.texts && aAdmin.body.checklist.length === 5 && aAdmin.body.saved === null && aAdmin.body.ai && aAdmin.body.ai.available === false, { s: aAdmin.status, ai: aAdmin.body && aAdmin.body.ai });
    check('A2 the API output never carries the client name', !aAdmin.text.toLowerCase().includes(CLIENT_NAME.toLowerCase().replace(/ /g, ' ')) || /"phrase":"ZZTEST/.test(aAdmin.text) === true);
    check('A3 owning BDE GET 200', (await call('GET', P(rFull.id), T.bde)).status === 200);
    const bde2 = await call('GET', P(rFull.id), T.bde2);
    check('A4 another BDE (not on this job) 403', bde2.status === 403, bde2.status);
    check('A5 Employee 403', (await call('GET', P(rFull.id), T.emp)).status === 403);
    check('A6 Client login 403', (await call('GET', P(rFull.id), T.cli)).status === 403);
    const mgr = await call('GET', P(rFull.id), T.mgr);
    check('A7 Manager (view only, cannot post) 403', mgr.status === 403, mgr.status);
    check('A8 no login 401', (await call('GET', P(rFull.id))).status === 401);
    check('A9 job-text (live refresh) has the same rule: BDE2 403, BDE 200', (await call('POST', `/api/requirements/${rFull.id}/job-text`, T.bde2, { overrides: {} })).status === 403 && (await call('POST', `/api/requirements/${rFull.id}/job-text`, T.bde, { overrides: {} })).status === 200);
    check('A10 save is refused for an unrelated BDE and for a bad body', (await call('POST', P(rFull.id), T.bde2, { texts: { naukri: 'x' } })).status === 403 && (await call('POST', P(rFull.id), T.admin, {})).status === 400 && (await call('POST', P(rFull.id), T.admin, { texts: { nonsense: 'x' } })).status === 400);

    // save / reset / stale
    const edited = aAdmin.body.texts.naukri.replace('Key responsibilities', 'What you will do');
    const sv = await call('POST', P(rFull.id), T.bde, { texts: { naukri: edited, shine: aAdmin.body.texts.shine, naukriTags: 'ICU, BLS, Triage' } });
    check('A11 BDE saves an edited Naukri text + tags; the unchanged Shine text is not kept', sv.status === 200 && sv.body.changed.sort().join() === 'naukri,naukriTags' && sv.body.saved && sv.body.saved.byName === uBde.name && sv.body.saved.texts.naukri === edited && !('shine' in sv.body.saved.texts), sv.body);
    const g2 = await call('GET', P(rFull.id), T.admin);
    check('A12 another login sees the saved edit with who and when', g2.body.saved && g2.body.saved.texts.naukri === edited && g2.body.saved.byName === uBde.name && !!g2.body.saved.savedAt && g2.body.saved.keys.naukri.byName === uBde.name, g2.body.saved);
    check('A13 generated text is unchanged by the saved one', g2.body.texts.naukri === aAdmin.body.texts.naukri);
    const aud = await prisma.auditLog.findFirst({ where: { entityId: rFull.id, action: 'Job posts saved' } });
    check('A14 the save is audit-logged with who', !!aud && aud.userId === uBde.id && /naukri/.test(aud.toValue || ''), aud);
    const bh = await call('GET', `/api/requirements/${rFull.id}/posting-sites/naukri/by-hand`, T.admin);
    const descField = bh.body && bh.body.fields && bh.body.fields.find((f) => f.key === 'description');
    check('A15 Post by hand uses the SAVED Naukri text, tags and says who saved it', bh.status === 200 && bh.body.usesSaved === true && descField && descField.value === edited && bh.body.fields.find((f) => f.key === 'skills').value === 'ICU, BLS, Triage' && bh.body.saved && bh.body.saved.by === uBde.name, { s: bh.status, uses: bh.body && bh.body.usesSaved });
    const bhShine = await call('GET', `/api/requirements/${rFull.id}/posting-sites/shine/by-hand`, T.admin);
    check('A16 Post by hand for a board with nothing saved uses the TeamLink text (client hidden, no notes)', bhShine.status === 200 && bhShine.body.usesSaved === false && !JSON.stringify(bhShine.body.fields).toLowerCase().includes(CLIENT_NAME.toLowerCase()), bhShine.body && bhShine.body.usesSaved);
    const bhThin = await call('GET', `/api/requirements/${rThin.id}/posting-sites/naukri/by-hand`, T.admin);
    check('A17 Post by hand on the thin imported job never shows the tracker notes', bhThin.status === 200 && !/Follow-up|negotiate|sir|Bed capacity/i.test(JSON.stringify(bhThin.body.fields)) , bhThin.status);

    // Indeed feed
    await prisma.requirement.update({ where: { id: rFull.id }, data: { portalPublished: true, portalPublishedAt: new Date(), postingSources: 'Indeed' } });
    await prisma.requirement.update({ where: { id: rThin.id }, data: { portalPublished: true, portalPublishedAt: new Date(), postingSources: 'Indeed' } });
    const feedBefore = (await require(path.join(BACK, 'src/utils/jobBoards/indeedFeed')).build('https://app.example-host.in')).xml;
    const jobBlock = (xml, id) => (xml.split('<job>').find((b) => b.includes(`<![CDATA[${id}]]>`)) || '');
    check('A20 Indeed feed: an unsaved job gets its own text WITHOUT tracker notes or the client name', (() => { const b = jobBlock(feedBefore, rThin.id); return b && !/Follow-up|negotiate|Bed capacity|sir/i.test(b) && !b.toLowerCase().includes(CLIENT_NAME.toLowerCase()); })());
    await call('POST', P(rFull.id), T.admin, { texts: { indeed: `Job title: Staff Nurse\nPay: ₹4 - ₹6 LPA\nBenefits:\n• [ ]\n\nJob description\nMY SAVED INDEED VERSION ${CLIENT_NAME}`, indeedTitle: 'Staff Nurse ICU' } });
    const feedAfter = (await require(path.join(BACK, 'src/utils/jobBoards/indeedFeed')).build('https://app.example-host.in')).xml;
    const bAfter = jobBlock(feedAfter, rFull.id);
    check('A21 Indeed feed uses the SAVED Indeed version + title, without [ ] lines and without the client name', /MY SAVED INDEED VERSION/.test(bAfter) && /<title><!\[CDATA\[Staff Nurse ICU\]\]>/.test(bAfter) && !/\[ \]/.test(bAfter.split('<description>')[1].split('</description>')[0]) && !bAfter.toLowerCase().includes(CLIENT_NAME.toLowerCase()), bAfter.slice(0, 600));

    // stale + reset
    await prisma.requirement.update({ where: { id: rFull.id }, data: { location: 'Pune, Maharashtra' } });
    const g3 = await call('GET', P(rFull.id), T.admin);
    check('A30 when the job changes after a save, the saved text is flagged stale (not silently replaced)', g3.body.saved.stale.naukri === true && g3.body.saved.texts.naukri === edited, g3.body.saved && g3.body.saved.stale);
    const rs = await call('POST', P(rFull.id), T.admin, { texts: { naukri: null, naukriTags: null, indeed: null, indeedTitle: null } });
    check('A31 Reset to generated removes the saved texts', rs.status === 200 && rs.body.reset.length === 4 && rs.body.saved === null, rs.body);
    check('A32 the saved row is gone (no leftover)', (await prisma.appSetting.count({ where: { key: W.PREFIX + rFull.id } })) === 0);
    const sameAsGen = await call('POST', P(rFull.id), T.admin, { texts: { shine: g3.body.texts.shine } });
    check('A33 saving the generated text as is keeps nothing', sameAsGen.status === 200 && sameAsGen.body.changed.length === 0 && sameAsGen.body.saved === null);
    const chk = await call('POST', P(rFull.id, '/check'), T.bde, { texts: { shine: 'Only female candidates, age 20 to 30 years old.' } });
    check('A34 /check flags wording in an edited text', chk.status === 200 && chk.body.warnings.length >= 2, chk.body);
    // fill-ins saved into the job need edit rights and keep the audit trail
    const fillSave = await call('POST', `/api/requirements/${rThin.id}/job-text/save`, T.admin, { overrides: { location: 'Uppal, Hyderabad', experience: '1-3' } });
    const thinRow = await prisma.requirement.findUnique({ where: { id: rThin.id } });
    check('A35 "Save these into the requirement" writes the typed gaps into the job', fillSave.status === 200 && thinRow.location === 'Uppal, Hyderabad' && thinRow.experience === '1-3', fillSave.body);
    // AI polish: none configured here -> a plain message, never a fake result
    const ai = await call('POST', `/api/requirements/${rFull.id}/job-text/ai`, T.admin, { overrides: {}, current: {} });
    check('A40 Polish with AI: no AI here -> 409 with a plain sentence, nothing fabricated', ai.status === 409 && typeof ai.body.error === 'string' && ai.body.error.length > 10 && !ai.body.texts, ai.body);
    check('A41 the job-posts payload tells the screen that AI is not available (button says it needs a key)', aAdmin.body.ai.available === false && typeof aAdmin.body.ai.reason === 'string', aAdmin.body.ai);
  } finally {
    try {
      const ids = made.users;
      const keys = made.reqs.flatMap((id) => [`jobposts.saved.${id}`, `jobtext.extra.${id}`]);
      await prisma.appSetting.deleteMany({ where: { key: { in: keys } } });
      await prisma.requirementPosting.deleteMany({ where: { requirementId: { in: made.reqs } } });
      await prisma.requirement.deleteMany({ where: { id: { in: made.reqs } } });
      await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: [...ids, ...made.clients, ...made.reqs] } }] } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
      await prisma.client.deleteMany({ where: { id: { in: made.clients } } });
      const left = await prisma.appSetting.count({ where: { OR: [{ key: { startsWith: 'jobposts.saved.' }, value: { contains: 'ZZTEST' } }] } });
      console.log(`cleanup: leftover saved-post rows with ZZTEST: ${left}`);
    } catch (e) { console.error('cleanup problem:', e.message); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
