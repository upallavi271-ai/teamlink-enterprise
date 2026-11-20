#!/usr/bin/env node
/**
 * ATS FILTERS (founder 2026-11-18): the recruiter filters on the candidate lists (CTC, experience, locations, title, skills Any/All,
 * notice bands, work mode, dates, resume, completeness, tags), their counts, scope, the BDE limits, the export, and the filters of
 * the other lists (requirements, clients, interviews, offers, joinings, follow-ups).
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port from TEST_PORT (default 4168).
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/ats-filters-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-filters-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4168);
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'filters-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* not json */ } return { status: r.status, body: j, text };
};
const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const P = process.pid;
const TAG = `Fxq${String(P).replace(/[0-9]/g, (d) => 'abcdefghij'[d])}`; // letters only: a digit run in a search also matches phone numbers
const dayOf = (d) => new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const live = await prisma.requirement.findMany({ where: { status: { in: ['OPEN', 'RECRUITER_ASSIGNED'] }, internal: false, department: { not: null } }, select: { id: true, department: true, clientId: true }, take: 80 });
  const j1 = live[0];
  const j2 = live.find((x) => x.id !== j1.id && x.department === j1.department) || live[1];
  const mkUser = (key, extra) => prisma.user.create({ data: { name: `Fx ${key} ${P}`, email: `fx.${key}.${P}@fx-test.in`, passwordHash: 'x', status: 'Active', role: 'EMPLOYEE', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...extra } });
  const RA = await mkUser('recA', { atsRole: 'RECRUITER', atsDepartment: j1.department });
  const RB = await mkUser('recB', { atsRole: 'RECRUITER', atsDepartment: j1.department });
  const BDE = await mkUser('bde', { atsRole: 'BDE', atsDepartment: 'BDE' });
  await prisma.requirement.update({ where: { id: j1.id }, data: { recruiterId: RA.id, bdeId: BDE.id } });
  await prisma.requirement.update({ where: { id: j2.id }, data: { recruiterId: RB.id } });

  const mk = async (n, d, job, owner) => {
    const c = await prisma.candidate.create({ data: { name: `${TAG} P${n}`, phone: `9${String(P * 10 + n).padStart(9, '3').slice(-9)}`, email: `${TAG}.${n}@fx-test.in`, source: 'Naukri', ...d } });
    await prisma.application.create({ data: { candidateId: c.id, requirementId: job.id, stage: 'CLIENT_REVIEW', ownerRecruiterId: owner.id } });
    return c;
  };
  const base = { preferredWorkMode: null, preferredEmploymentType: null, noticePeriod: null };
  const c1 = await mk(1, { ...base, currentSalary: '3 LPA', expectedSalary: '4 LPA', experienceYears: 2, location: 'Hyderabad, Telangana', preferredLocation: 'Pune, Chennai', currentDesignation: 'Sr. Software Engineer', skills: 'Java, SQL', noticePeriod: '15 Days', preferredWorkMode: 'Remote', preferredEmploymentType: 'Full Time', specialization: 'Radiology', resumeName: 'a.pdf' }, j1, RA);
  const c2 = await mk(2, { ...base, currentSalary: '6 LPA', expectedSalary: '8 LPA', experienceYears: 5, location: 'hyderabad', preferredLocation: 'Hyderabad', currentDesignation: 'Software Engineer', skills: 'java, python', noticePeriod: '30 Days', preferredWorkMode: 'Hybrid', preferredEmploymentType: 'Full Time', resumeName: 'b.pdf' }, j1, RA);
  const c3 = await mk(3, { ...base, currentSalary: '10 LPA', expectedSalary: '12 LPA', experienceYears: 10, location: 'Pune', preferredLocation: 'Mumbai', skills: 'Python', noticePeriod: 'Immediate', preferredWorkMode: 'Hybrid', preferredEmploymentType: 'Contract' }, j1, RA);
  const c4 = await mk(4, { ...base, noticePeriod: 'Serving notice period' }, j1, RA);
  const c5 = await mk(5, { ...base, currentSalary: '25 LPA', expectedSalary: '30 LPA', experienceYears: 12, location: 'Chennai', noticePeriod: '2 months', skills: 'Java' }, j1, RA);
  const c6 = await mk(6, { ...base, currentSalary: '7 LPA', expectedSalary: '9 LPA', experienceYears: 6, location: 'Hyderabad', noticePeriod: '45 Days', skills: 'Go' }, j2, RB);
  // P1 was shared with the client today
  const app1 = await prisma.application.findFirst({ where: { candidateId: c1.id } });
  await prisma.applicationStageEvent.create({ data: { applicationId: app1.id, candidateId: c1.id, fromStage: 'NEW', toStage: 'CLIENT_REVIEW', action: 'Moved to Client Review', actorUserId: RA.id, actorName: RA.name, actorRole: 'RECRUITER' } });
  let dupSeeded = false;
  try {
    await prisma.$executeRawUnsafe('INSERT INTO CandidateDupFlag (id, candidateId, matchCandidateId, pairKey, level, status, reasons, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?)', `fxd${P}`, c3.id, c4.id, `fx${P}`, 'CERTAIN', 'OPEN', '[]', Date.now(), Date.now());
    dupSeeded = true;
  } catch { /* no flag table in this copy */ }
  const nm = (n) => `${TAG} P${n}`;
  const PD = require('../src/utils/candidateProfileDepth');
  await PD.addTag(c1.id, `${TAG}-hot`, adminRow); await PD.addTag(c2.id, `${TAG}-hot`, adminRow); await PD.addTag(c6.id, `${TAG}-hot`, adminRow);

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const tA = await tok(adminRow.id); const tRA = await tok(RA.id); const tRB = await tok(RB.id); const tBde = await tok(BDE.id);

  // the pipeline list as a login sees it, narrowed to the seeded people by name
  const list = async (token, params, view = 'pipeline') => {
    const r = await call('GET', `/candidates?${qs({ paged: '1', view, sub: view === 'master' ? 'all' : 'all', pageSize: '100', search: TAG, ...params })}`, null, token);
    return { status: r.status, names: ((r.body && r.body.rows) || []).map((x) => x.name), total: r.body && r.body.total, body: r.body };
  };
  const names = (...ns) => ns.map(nm);
  const facet = async (token, params, key, view = 'pipeline') => {
    const r = await call('GET', `/ats-io/facets/candidates?${qs({ view, sub: 'all', search: TAG, ...params })}`, null, token);
    return { status: r.status, list: (r.body && r.body.facets && r.body.facets[key]) || null, body: r.body };
  };
  const optCount = (f, v) => { const o = (f.list || []).find((x) => String(x.value).toLowerCase() === String(v).toLowerCase()); return o ? o.count : 0; };

  // ---- baseline + scope
  let l = await list(tA, {});
  check('admin: the six seeded people are listed', same(l.names, names(1, 2, 3, 4, 5, 6)), l);
  l = await list(tRA, {});
  check('recruiter A sees only their own five', same(l.names, names(1, 2, 3, 4, 5)), l);
  l = await list(tRB, {});
  check('recruiter B sees only their own one', same(l.names, names(6)), l);
  for (const [k, v] of [['ctcCurMin', '1'], ['locCur', 'Hyderabad'], ['skillSet', 'go'], ['noticeBand', 'd30,d90'], ['tag', `${TAG}-hot`], ['expMin', '1']]) {
    // eslint-disable-next-line no-await-in-loop
    const x = await list(tRA, { [k]: v });
    check(`scope: recruiter A cannot reach recruiter B's person through ?${k}=`, !x.names.includes(nm(6)), x);
  }

  // ---- CTC (current / expected) ranges, boundaries and buckets
  l = await list(tA, { ctcCurMin: '6' }); check('current CTC min 6 (boundary included)', same(l.names, names(2, 3, 5, 6)), l);
  l = await list(tA, { ctcCurMax: '6' }); check('current CTC max 6 (boundary included)', same(l.names, names(1, 2)), l);
  l = await list(tA, { ctcCurMin: '3', ctcCurMax: '10' }); check('current CTC 3 to 10', same(l.names, names(1, 2, 3, 6)), l);
  l = await list(tA, { ctcCurMin: '30' }); check('current CTC min 30: nobody', l.names.length === 0, l);
  l = await list(tA, { ctcExpMin: '8', ctcExpMax: '12' }); check('expected CTC 8 to 12', same(l.names, names(2, 3, 6)), l);
  l = await list(tA, { ctcCurBucket: '3-6' }); check('current CTC bucket 3-6 holds 3 but not 6', same(l.names, names(1)), l);
  l = await list(tA, { ctcCurBucket: '6-10' }); check('current CTC bucket 6-10 holds 6 but not 10', same(l.names, names(2, 6)), l);
  l = await list(tA, { ctcCurBucket: '25+,none' }); check('bucket 25+ and not given', same(l.names, names(4, 5)), l);
  let f = await facet(tA, {}, 'ctcCurBucket');
  check('facet: current CTC buckets count 3-6=1 6-10=2 10-15=1 25+=1 none=1', optCount(f, '3-6') === 1 && optCount(f, '6-10') === 2 && optCount(f, '10-15') === 1 && optCount(f, '25+') === 1 && optCount(f, 'none') === 1, f.list);
  f = await facet(tA, { ctcCurMin: '6', ctcCurBucket: '6-10' }, 'ctcCurBucket');
  check('facet: a bucket is counted with its own pick left out, the range still on', optCount(f, '6-10') === 2 && optCount(f, '10-15') === 1 && optCount(f, '3-6') === 0, f.list);

  // ---- experience
  l = await list(tA, { expMin: '5', expMax: '10' }); check('experience 5 to 10 years (both ends)', same(l.names, names(2, 3, 6)), l);
  l = await list(tA, { expMax: '2' }); check('experience up to 2', same(l.names, names(1)), l);
  l = await list(tA, { expMin: '5' }, 'master'); check('People list: experience min 5', same(l.names, names(2, 3, 5, 6)), l);

  // ---- locations
  l = await list(tA, { locCur: 'Hyderabad' }); check('current location Hyderabad (city, any spelling)', same(l.names, names(1, 2, 6)), l);
  l = await list(tA, { locCur: 'Pune,Chennai' }); check('current location several', same(l.names, names(3, 5)), l);
  l = await list(tA, { locPref: 'Pune' }); check('preferred location Pune', same(l.names, names(1)), l);
  l = await list(tA, { locPref: 'Hyderabad,Mumbai' }); check('preferred location any of two', same(l.names, names(2, 3)), l);
  f = await facet(tA, {}, 'locCur');
  check('facet: current location counts Hyderabad 3 (all spellings together)', optCount(f, 'Hyderabad') === 3 && optCount(f, 'Pune') === 1, f.list);
  f = await facet(tRA, {}, 'locCur');
  check('facet scope: recruiter A sees Hyderabad 2, not 3', optCount(f, 'Hyderabad') === 2, f.list);

  // ---- title, skills any/all, notice, work mode, employment type
  l = await list(tA, { jobTitle: 'Senior Software Engineer' }); check('standardised job title', same(l.names, names(1)), { l, f: (await facet(tA, {}, 'jobTitle')).list });
  l = await list(tA, { skillSet: 'java,python' }); check('skills Any', same(l.names, names(1, 2, 3, 5)), l);
  l = await list(tA, { skillSet: 'java,python', skillMode: 'all' }); check('skills All', same(l.names, names(2)), l);
  l = await list(tA, { skillSet: 'java,sql', skillMode: 'all' }); check('skills All (two of one person)', same(l.names, names(1)), l);
  f = await facet(tA, {}, 'skillSet'); check('facet: skill counts java=3', optCount(f, 'java') === 3 && optCount(f, 'python') === 2, f.list);
  l = await list(tA, { noticeBand: 'imm' }); check('notice: immediate', same(l.names, names(3)), l);
  l = await list(tA, { noticeBand: 'd15' }); check('notice: up to 15 days holds 15', same(l.names, names(1)), l);
  l = await list(tA, { noticeBand: 'd30' }); check('notice: 16 to 30 holds 30', same(l.names, names(2)), l);
  l = await list(tA, { noticeBand: 'd60' }); check('notice: 31 to 60 holds 2 months and 45 days', same(l.names, names(5, 6)), l);
  l = await list(tA, { noticeBand: 'serving' }); check('notice: serving notice', same(l.names, names(4)), l);
  l = await list(tA, { noticeBand: 'd15,imm' }); check('notice: two bands', same(l.names, names(1, 3)), l);
  l = await list(tA, { workMode: 'Hybrid' }); check('work mode', same(l.names, names(2, 3)), l);
  l = await list(tA, { empType: 'Contract' }); check('employment type', same(l.names, names(3)), l);
  f = await facet(tA, {}, 'noticeBand'); check('facet: notice band counts', optCount(f, 'd60') === 2 && optCount(f, 'imm') === 1 && optCount(f, 'serving') === 1, f.list);

  // ---- tags, dates, resume, completeness
  l = await list(tA, { tag: `${TAG}-hot` }); check('tag filter', same(l.names, names(1, 2, 6)), l);
  f = await facet(tA, {}, 'tag'); const hot = (f.list || []).find((o) => o.value === `${TAG}-hot`);
  check('tag count over everyone the admin may see = 3', hot && hot.count === 3, f.list && f.list.slice(0, 5));
  f = await facet(tRA, {}, 'tag'); const hotA = (f.list || []).find((o) => o.value === `${TAG}-hot`);
  check('tag count for recruiter A is 2 (not the whole database: B\'s person is not counted)', hotA && hotA.count === 2, f.list && f.list.slice(0, 5));
  const tg = await call('GET', '/candidates/profile-tags', null, tRA); const hotRoute = ((tg.body && tg.body.tags) || []).find((o) => o.value === `${TAG}-hot`);
  check('the tag list route is scoped too (A: 2)', hotRoute && hotRoute.count === 2, tg.body);
  const today = dayOf(new Date()); const tomorrow = dayOf(new Date(Date.now() + 86400000));
  l = await list(tA, { addedFrom: today, addedTo: today }); check('added today: all six', same(l.names, names(1, 2, 3, 4, 5, 6)), l);
  l = await list(tA, { addedFrom: tomorrow }); check('added from tomorrow: nobody', l.names.length === 0, l);
  l = await list(tA, { updatedFrom: today }); check('last updated today', l.names.length === 6, l);
  l = await list(tA, { updatedTo: '2020-01-01' }); check('last updated before 2020: nobody', l.names.length === 0, l);
  l = await list(tA, { resume: 'yes' }); check('resume available yes', same(l.names, names(1, 2)), l);
  l = await list(tA, { resume: 'no' }); check('resume available no', same(l.names, names(3, 4, 5, 6)), l);
  l = await list(tA, { scoreMin: '60' }); check('completeness min 60 holds the rich profiles', l.names.includes(nm(1)) && l.names.includes(nm(2)) && !l.names.includes(nm(4)), l);
  l = await list(tA, { scoreMax: '30' }); check('completeness max 30 holds the empty profile', l.names.includes(nm(4)) && !l.names.includes(nm(1)), l);
  l = await list(tA, { sharedFrom: today }); check('shared with client from today: P1 only', same(l.names, names(1)), l);
  l = await list(tA, { sharedTo: '2020-01-01' }); check('shared with client before 2020: nobody', l.names.length === 0, l);
  l = await list(tA, { contactedFrom: today }); check('last contacted from today: nobody (never contacted)', l.names.length === 0, l);
  l = await list(tA, { contactedFrom: today }, 'master'); check('People list: last contacted from today also answers', l.status === 200, l);
  if (dupSeeded) {
    l = await list(tA, { dup: 'yes' }); check('duplicate suspected: the flagged person', same(l.names, names(3)), l);
    l = await list(tA, { dup: 'no' }); check('no duplicate flag', same(l.names, names(1, 2, 4, 5, 6)), l);
  }

  // ---- combinations
  l = await list(tA, { locCur: 'Hyderabad', ctcCurMin: '6', skillSet: 'java' }); check('combination: location + CTC + skill', same(l.names, names(2)), l);
  l = await list(tA, { locCur: 'Hyderabad', noticeBand: 'd15,d30', workMode: 'Hybrid' }); check('combination: location + notice + work mode', same(l.names, names(2)), l);
  l = await list(tRA, { ctcCurMin: '3', ctcCurMax: '10', expMin: '2', tag: `${TAG}-hot` }); check('combination for recruiter A with tag', same(l.names, names(1, 2)), l);

  // ---- BDE: no CTC, no location, no resume/completeness filter; their params are ignored, their counts hidden
  l = await list(tBde, {});
  const bdeAll = l.names.length;
  check('setup: the BDE sees the people of their own requirement', bdeAll >= 5, l);
  const bdeCtc = await list(tBde, { ctcCurMin: '100', ctcExpMax: '0', ctcCurBucket: '25+', maxSalary: '0' });
  check('BDE: CTC parameters are ignored (same list, not an empty one)', bdeCtc.names.length === bdeAll, { bdeAll, got: bdeCtc.names.length });
  const bdeLoc = await list(tBde, { locCur: 'Nowhere', locPref: 'Nowhere', locNative: 'Nowhere', resume: 'yes', scoreMin: '100' });
  check('BDE: location, resume and completeness parameters are ignored', bdeLoc.names.length === bdeAll, { bdeAll, got: bdeLoc.names.length });
  f = await call('GET', `/ats-io/facets/candidates?${qs({ view: 'pipeline', sub: 'all', search: TAG })}`, null, tBde);
  const bf = (f.body && f.body.facets) || {};
  check('BDE facets: no CTC, location, resume or completeness options', !bf.ctcCurBucket && !bf.ctcExpBucket && !bf.locCur && !bf.locPref && !bf.locNative && !bf.resume && !bf.scoreBucket, Object.keys(bf));
  check('BDE facets still offer skills and notice', Array.isArray(bf.skillSet) && Array.isArray(bf.noticeBand), Object.keys(bf));
  const bdeRow = (bdeCtc.body.rows || [])[0] || {};
  check('BDE rows carry no pay, phone or email', !('currentSalary' in bdeRow) && !('expectedSalary' in bdeRow) && !('phone' in bdeRow) && !('email' in bdeRow) && !('fx' in bdeRow), Object.keys(bdeRow));

  // ---- rows never carry the filter facts; discriminatory parameters are refused
  l = await list(tA, {});
  check('rows do not carry the internal filter facts', l.body.rows.every((r) => !('fx' in r)), Object.keys(l.body.rows[0] || {}));
  const g1 = await list(tA, { gender: 'Female', age: '30', dob: '1990-01-01', religion: 'x', caste: 'y', maritalStatus: 'z' });
  check('gender / age / date of birth / religion / caste / marital status filters do not exist (parameters ignored)', g1.names.length === 6, g1);

  // ---- export respects the filters
  const ex = await call('POST', '/ats-io/export/candidates?format=csv', { view: 'pipeline-all', params: { paged: '1', view: 'pipeline', sub: 'all', all: '1', search: TAG, ctcCurMin: '6', locCur: 'Hyderabad' } }, tA);
  const lines = String(ex.text || '').split(/\r?\n/).filter((x) => x.includes(TAG));
  check('export: only the filtered people (CTC >= 6 in Hyderabad = P2, P6)', ex.status === 200 && lines.length === 2 && lines.some((x) => x.includes(nm(2))) && lines.some((x) => x.includes(nm(6))), { status: ex.status, lines: lines.length, head: String(ex.text).slice(0, 200) });
  const exA = await call('POST', '/ats-io/export/candidates?format=csv', { view: 'pipeline-all', params: { paged: '1', view: 'pipeline', sub: 'all', all: '1', search: TAG, locCur: 'Hyderabad' } }, tRA);
  const linesA = String(exA.text || '').split(/\r?\n/).filter((x) => x.includes(TAG));
  check('export scope: recruiter A\'s export never holds recruiter B\'s person', linesA.length === 2 && !linesA.some((x) => x.includes(nm(6))), { status: exA.status, n: linesA.length });

  // =====================================================================================================================
  // THE OTHER LISTS
  // =====================================================================================================================
  const rowsOf = (b) => (b && (b.rows || b.requirements || b.recruitment || (Array.isArray(b) ? b : []))) || [];
  const cl1 = await prisma.client.create({ data: { name: `${TAG} cone`, industry: 'Healthcare', priority: 'High', agreementStatus: 'Signed' } });
  const cl2 = await prisma.client.create({ data: { name: `${TAG} ctwo`, industry: 'IT Services', priority: 'Low', agreementStatus: 'Pending' } });
  const cl3 = await prisma.client.create({ data: { name: `${TAG} cthree`, industry: 'Healthcare', priority: 'Medium', agreementStatus: 'Signed' } });
  const ago = (d) => new Date(Date.now() - d * 86400000);
  const mkReq = (n, client, extra) => prisma.requirement.create({ data: { title: `${TAG} R${n}`, clientId: client.id, department: j1.department, status: 'OPEN', ...extra } });
  const R1 = await mkReq(1, cl1, { openings: 3, salary: '₹10L - ₹15L', workMode: 'Remote', createdAt: ago(40), recruiterId: RA.id });
  const R2 = await mkReq(2, cl1, { openings: 1, salary: '₹4L - ₹6L', workMode: 'Work From Office', createdAt: ago(2), recruiterId: RA.id });
  const R3 = await mkReq(3, cl2, { openings: 2, salary: '₹20L - ₹30L', workMode: 'Hybrid', createdAt: ago(100) });
  const mkApp = (c, r, d) => prisma.application.create({ data: { candidateId: c.id, requirementId: r.id, stage: 'NEW', ...d } });
  await mkApp(c1, R1, { stage: 'JOINED', joinedAt: ago(5), joiningDate: dayOf(ago(5)) });
  // the server was started before these rows: the working copy of the lists catches up by itself
  await new Promise((r) => { setTimeout(r, 1500); });
  const rq = async (token, params) => { const r = await call('GET', `/requirements?${qs({ page: '1', pageSize: '100', view: 'all', search: `${TAG} R`, ...params })}`, null, token); return { status: r.status, names: rowsOf(r.body).map((x0) => x0.title), body: r.body }; };
  const T = (n) => `${TAG} R${n}`;
  let x = await rq(tA, {}); check('requirements: the three seeded jobs are listed', same(x.names, [T(1), T(2), T(3)]), { s: x.status, names: x.names, keys: x.body && Object.keys(x.body) });
  x = await rq(tA, { daysOpenMin: '30' }); check('requirements: days open 30 or more', same(x.names, [T(1), T(3)]), x.names);
  x = await rq(tA, { daysOpenMax: '30' }); check('requirements: days open up to 30', same(x.names, [T(2)]), x.names);
  x = await rq(tA, { daysOpenMin: '30', daysOpenMax: '60' }); check('requirements: days open 30 to 60', same(x.names, [T(1)]), x.names);
  x = await rq(tA, { openLeftMin: '2' }); check('requirements: openings left 2 or more (R1 has 3 openings, 1 joined)', same(x.names, [T(1), T(3)]), x.names);
  x = await rq(tA, { openLeftMax: '1' }); check('requirements: openings left up to 1', same(x.names, [T(2)]), x.names);
  x = await rq(tA, { ctcMin: '12', ctcMax: '25' }); check('requirements: CTC band overlaps 12-25 lakh', same(x.names, [T(1), T(3)]), x.names);
  x = await rq(tA, { ctcMax: '5' }); check('requirements: CTC up to 5 lakh', same(x.names, [T(2)]), x.names);
  x = await rq(tA, { industry: 'Healthcare' }); check('requirements: industry', same(x.names, [T(1), T(2)]), x.names);
  x = await rq(tA, { workMode: 'Remote' }); check('requirements: work mode', same(x.names, [T(1)]), x.names);
  x = await rq(tRA, { daysOpenMin: '30' }); check('requirements scope: recruiter A sees only their own job through the filter', same(x.names, [T(1)]), x.names);
  x = await rq(tRB, { daysOpenMin: '30' }); check('requirements scope: recruiter B sees none', x.names.length === 0, x.names);

  const cls = async (token, params) => { const r = await call('GET', `/clients?${qs(params)}`, null, token); return { status: r.status, names: (Array.isArray(r.body) ? r.body : []).map((c) => c.name).filter((n) => n.startsWith(TAG)), n: Array.isArray(r.body) ? r.body.length : -1 }; };
  const [n1, n2, n3] = [`${TAG} cone`, `${TAG} ctwo`, `${TAG} cthree`];
  x = await cls(tA, {}); check('clients: the three seeded clients are listed', same(x.names, [n1, n2, n3]), x);
  x = await cls(tA, { priority: 'High' }); check('clients: priority', same(x.names, [n1]), x);
  x = await cls(tA, { industry: 'Healthcare' }); check('clients: industry', same(x.names, [n1, n3]), x);
  x = await cls(tA, { agreementStatus: 'Pending' }); check('clients: agreement status', same(x.names, [n2]), x);
  x = await cls(tA, { reqMin: '2' }); check('clients: requirement count 2 or more', same(x.names, [n1]), x);
  x = await cls(tA, { reqMax: '1' }); check('clients: requirement count up to 1 (a client with none counts as 0)', same(x.names, [n2, n3]), x);
  x = await cls(tA, { hasJoinings: 'yes' }); check('clients: has joinings', same(x.names, [n1]), x);
  x = await cls(tA, { hasJoinings: 'no' }); check('clients: no joinings', same(x.names, [n2, n3]), x);
  x = await cls(tA, { createdFrom: dayOf(new Date()), createdTo: dayOf(new Date()) }); check('clients: client added on a date range (today holds the three seeded)', same(x.names, [n1, n2, n3]), x);
  x = await cls(tA, { createdTo: '2020-01-01' }); check('clients: added before 2020 holds none of them', x.names.length === 0, x);
  const rcAll = await cls(tRA, {}); const rcAg = await cls(tRA, { agreementStatus: 'Pending', priority: 'Low', industry: 'zzz' });
  check('clients: a recruiter\'s agreement / priority / industry parameters are ignored (they cannot see those fields)', rcAll.n === rcAg.n && [200, 403].includes(rcAll.status), { a: rcAll.n, b: rcAg.n });

  // interviews
  const mkIv = async (c, at, status, mode, round, who) => { const a = await prisma.application.findFirst({ where: { candidateId: c.id, requirementId: j1.id } }); await prisma.application.update({ where: { id: a.id }, data: { interviewAt: new Date(at), interviewStatus: status, interviewMode: mode, interviewRound: round, interviewer: who } }); };
  await mkIv(c1, '2026-12-01T10:00:00+05:30', 'SCHEDULED', 'Online', 1, 'Ravi Kumar');
  await mkIv(c2, '2026-12-10T10:00:00+05:30', 'COMPLETED', 'In Person', 2, 'Sita Rao');
  await mkIv(c3, '2026-12-20T10:00:00+05:30', 'SCHEDULED', 'Online', 1, 'Ravi Kumar');
  const candName = (y) => (y.candidate && (y.candidate.name || y.candidate)) || y.candidateName || '';
  const iv = async (token, params) => { const r = await call('GET', `/ats/calendar?${qs(params)}`, null, token); return { status: r.status, names: rowsOf(r.body).map(candName).filter((n) => typeof n === 'string' && n.startsWith(TAG)), keys: r.body && Object.keys(r.body) }; };
  x = await iv(tA, {}); check('interviews: the three seeded interviews are listed', same(x.names, names(1, 2, 3)), x);
  x = await iv(tA, { ivFrom: '2026-12-05', ivTo: '2026-12-15' }); check('interviews: date range', same(x.names, names(2)), x);
  x = await iv(tA, { ivStatus: 'SCHEDULED' }); check('interviews: status', same(x.names, names(1, 3)), x);
  x = await iv(tA, { ivRound: '2' }); check('interviews: round', same(x.names, names(2)), x);
  x = await iv(tA, { ivMode: 'Online' }); check('interviews: mode', same(x.names, names(1, 3)), x);
  x = await iv(tA, { ivInterviewer: 'ravi' }); check('interviews: interviewer', same(x.names, names(1, 3)), x);
  x = await iv(tRA, { ivMode: 'Online' }); check('interviews scope: recruiter A sees only their own interviews', same(x.names, names(1, 3)), x);
  x = await iv(tRB, {}); check('interviews scope: recruiter B sees only their own (none of A\'s)', !x.names.includes(nm(1)) && !x.names.includes(nm(2)), x);

  // offers
  const mkOffer = (c, r, ctc, status, day) => mkApp(c, r, { stage: 'OFFER', offerStatus: status, offerDate: day, offeredCtc: ctc, ownerRecruiterId: RA.id });
  await mkOffer(c2, R2, 800000, 'Offer Released', '2026-11-02');
  await mkOffer(c3, R2, 1500000, 'Offer being prepared', '2026-11-12');
  await mkOffer(c5, R2, 2500000, 'Offer Released', '2026-11-22');
  const listOf = async (path, token, params) => { const r = await call('GET', `${path}?${qs({ page: '1', pageSize: '100', window: 'all', q: TAG, ...params })}`, null, token); return { status: r.status, names: rowsOf(r.body).map(candName).filter((n) => typeof n === 'string' && n.startsWith(TAG)), body: r.body }; };
  const of = (token, params) => listOf('/ats/offers', token, params);
  x = await of(tA, {}); check('offers: the seeded offers are listed (P1 is a joined one)', same(x.names, names(1, 2, 3, 5)), { s: x.status, names: x.names, keys: x.body && Object.keys(x.body) });
  x = await of(tA, { offerStatus: 'Offer Released' }); check('offers: status', same(x.names, names(2, 5)), x.names);
  x = await of(tA, { dFrom: '2026-11-10', dTo: '2026-11-20' }); check('offers: date range', same(x.names, names(3)), x.names);
  x = await of(tA, { ctcMin: '10', ctcMax: '20' }); check('offers: CTC range in lakh', same(x.names, names(3)), x.names);
  x = await of(tA, { ctcMin: '8' }); check('offers: CTC boundary (8 lakh is included)', same(x.names, names(2, 3, 5)), x.names);
  x = await of(tA, { bgv: 'Clear' }); check('offers: BGV status (none recorded = Pending, so none are Clear)', x.status === 200 && x.names.length === 0, x.names);
  x = await of(tA, { bgv: 'Pending' }); check('offers: BGV Pending', same(x.names, names(1, 2, 3, 5)), x.names);
  x = await of(tA, { counter: 'pending' }); check('offers: counter-offer pending (none)', x.status === 200 && x.names.length === 0, x.names);
  x = await of(tRA, { ctcMin: '8' }); check('offers scope: recruiter A (if the role may open Offers) sees only their own through the filter', (x.status === 403 || same(x.names, names(2, 3, 5))) && !x.names.includes(nm(6)), { s: x.status, n: x.names });
  x = await of(tRB, {}); check('offers scope: recruiter B sees none of them', x.names.length === 0, x.names);

  // joinings
  await mkApp(c2, R3, { stage: 'JOINED', joinedAt: new Date('2026-10-05T10:00:00+05:30'), joiningDate: '2026-10-05', ownerRecruiterId: RA.id });
  await mkApp(c3, R3, { stage: 'JOINED', joinedAt: new Date('2026-11-05T10:00:00+05:30'), joiningDate: '2026-11-05', ownerRecruiterId: RA.id });
  await prisma.invoice.create({ data: { clientId: cl2.id, candidateId: c3.id, requirementId: R3.id, amount: 1000, status: 'Paid', invoiceDate: '2026-11-06' } }).catch((e) => console.log('  (no invoice row:', String(e.message).slice(-120), ')'));
  const jn = (token, params) => listOf('/ats/joining', token, params);
  x = await jn(tA, {}); check('joinings: the joined people are listed', same(x.names, names(1, 2, 3)), { s: x.status, names: x.names });
  x = await jn(tA, { dFrom: '2026-11-01', dTo: '2026-11-10' }); check('joinings: joining date range (1 to 10 November)', same(x.names, names(3)), x.names);
  x = await jn(tA, { dFrom: '2026-10-05', dTo: '2026-10-05' }); check('joinings: one-day range includes both ends', same(x.names, names(2)), x.names);
  x = await jn(tA, { invoice: 'Paid' }); check('joinings: invoice status (admin)', same(x.names, names(3)), x.names);
  x = await jn(tA, { invoice: 'none' }); check('joinings: no invoice yet', same(x.names, names(1, 2)), x.names);
  x = await jn(tA, { guarantee: 'none,active,ended' }); check('joinings: guarantee status answers', x.status === 200 && x.names.length === 3, x);
  const jr = await jn(tRA, {}); const jr2 = await jn(tRA, { invoice: 'Paid' });
  check('joinings: the invoice filter is ignored for a role that does not see invoices (recruiter)', jr.status === 200 && jr.names.length === jr2.names.length, { a: jr.names.length, b: jr2.names.length });
  x = await jn(tRB, {}); check('joinings scope: recruiter B sees none of them', x.names.length === 0, x.names);

  // follow-ups
  const todayStr = dayOf(new Date());
  const fuFor = async (c, due, mode) => {
    const a = await prisma.application.findFirst({ where: { candidateId: c.id, requirementId: j1.id } });
    await prisma.applicationFollowUp.create({ data: { applicationId: a.id, candidateId: c.id, requirementId: j1.id, ownerUserId: RA.id, ownerName: RA.name, ownerRole: 'Recruiter', dueDate: due, contactMode: mode, nextAction: 'Call back' } });
  };
  await fuFor(c1, todayStr, 'Call'); await fuFor(c2, dayOf(new Date(Date.now() - 3 * 86400000)), 'WhatsApp'); await fuFor(c3, dayOf(new Date(Date.now() + 4 * 86400000)), 'Call');
  const fu = async (token, params) => { const r = await call('GET', `/followups?${qs({ fuRequirement: j1.id, fuCandidate: TAG, ...params })}`, null, token); return { status: r.status, names: (Array.isArray(r.body) ? r.body : []).map((y) => y.candidateName), n: Array.isArray(r.body) ? r.body.length : -1 }; };
  x = await fu(tA, {}); check('follow-ups: candidate + requirement filter lists the seeded people on that job', x.status === 200 && x.names.includes(nm(1)) && x.names.includes(nm(4)) && !x.names.includes(nm(6)), x);
  x = await fu(tA, { fuDue: 'today' }); check('follow-ups: due today', same(x.names, names(1)), x.names);
  x = await fu(tA, { fuDue: 'overdue' }); check('follow-ups: overdue', same(x.names, names(2)), x.names);
  x = await fu(tA, { fuDue: 'week' }); check('follow-ups: due this week (today and the next seven days)', same(x.names, names(1, 3)), x.names);
  x = await fu(tA, { fuType: 'WhatsApp' }); check('follow-ups: type', same(x.names, names(2)), x.names);
  x = await fu(tA, { fuOwner: RA.id, fuType: 'Call' }); check('follow-ups: owner + type', same(x.names, names(1, 3)), x.names);
  x = await fu(tA, { fuOwner: RB.id }); check('follow-ups: another owner', x.names.length === 0, x.names);
  x = await fu(tRB, { fuDue: 'today' }); check('follow-ups scope: recruiter B sees none of recruiter A\'s', x.names.length === 0, x);
  x = await fu(tRA, { fuDue: 'overdue' }); check('follow-ups scope: recruiter A sees their own', same(x.names, names(2)), x);

  // ---- WHOLE HISTORY: a search or a filter drops the default date window (founder 2026-11-20)
  const plainOffers = await call('GET', `/ats/offers?${qs({ page: '1', pageSize: '100' })}`, null, tA);
  check('whole history: with no filter the offers list keeps its open window (allTime false)', plainOffers.status === 200 && plainOffers.body.allTime === false && plainOffers.body.window === 'open', plainOffers.body && { w: plainOffers.body.window, a: plainOffers.body.allTime });
  const searchedOffers = await call('GET', `/ats/offers?${qs({ page: '1', pageSize: '100', q: TAG })}`, null, tA);
  const soNames = rowsOf(searchedOffers.body).map(candName).filter((n) => typeof n === 'string' && n.startsWith(TAG));
  check('whole history: a search reaches the joined (closed) offers too and says allTime', searchedOffers.body.allTime === true && searchedOffers.body.window === 'all' && soNames.includes(nm(1)), { a: searchedOffers.body.allTime, w: searchedOffers.body.window, soNames });
  const filteredJoin = await call('GET', `/ats/joining?${qs({ page: '1', pageSize: '100', dFrom: '2020-01-01' })}`, null, tA);
  check('whole history: a date filter on Joining is all time', filteredJoin.status === 200 && filteredJoin.body.allTime === true && filteredJoin.body.olderCount === 0, filteredJoin.body && { a: filteredJoin.body.allTime, o: filteredJoin.body.olderCount });
  // an old, finished follow-up is outside the 30-day window until a filter is on
  const appOfC4 = await prisma.application.findFirst({ where: { candidateId: c4.id, requirementId: j1.id } });
  await prisma.applicationFollowUp.create({ data: { applicationId: appOfC4.id, candidateId: c4.id, requirementId: j1.id, ownerUserId: RA.id, ownerName: RA.name, ownerRole: 'Recruiter', dueDate: dayOf(new Date(Date.now() - 100 * 86400000)), completedAt: new Date(Date.now() - 99 * 86400000), contactMode: 'Call', nextAction: 'Done' } });
  const fuPaged = async (params) => { const r = await call('GET', `/followups?${qs({ page: '1', pageSize: '200', ...params })}`, null, tA); return { status: r.status, names: ((r.body && r.body.rows) || []).map((y) => y.candidateName), body: r.body }; };
  x = await fuPaged({ fuRequirement: j1.id }); check('whole history: follow-ups with a filter reach the old finished one (P4, 100 days ago)', x.names.includes(nm(4)), { n: x.names.length });
  x = await fuPaged({}); check('whole history: without a filter the old finished follow-up stays outside the 30-day window', !x.names.includes(nm(4)), { n: x.names.length });
  // counts shown beside an option equal what picking it lists, with other filters on
  f = await facet(tA, { locCur: 'Hyderabad' }, 'noticeBand');
  l = await list(tA, { locCur: 'Hyderabad', noticeBand: 'd30' });
  check('facet count (people) equals the people the list shows under the same filters (notice 16-30 days among Hyderabad people)', optCount(f, 'd30') === new Set(l.names).size && new Set(l.names).size === 1, { c: optCount(f, 'd30'), l: l.names });
  f = await facet(tA, { skillSet: 'java', skillMode: 'all', ctcCurMin: '3' }, 'workMode');
  l = await list(tA, { skillSet: 'java', skillMode: 'all', ctcCurMin: '3', workMode: 'Hybrid' });
  check('facet count equals the list (work mode Hybrid, java, CTC from 3)', optCount(f, 'Hybrid') === new Set(l.names).size, { c: optCount(f, 'Hybrid'), l: l.names });

  // ---- TEAM PAGE: results for a date range, scoped to the viewer (founder 2026-11-20)
  const tp = async (token, params) => { const r = await call('GET', `/ats/team/period?${qs(params)}`, null, token); return { status: r.status, body: r.body }; };
  x = await tp(tA, { range: 'this_month' });
  check('team period: this month answers with the range and one row per listed person', x.status === 200 && x.body.range.key === 'this_month' && x.body.rows && x.body.rows[RA.id] && typeof x.body.rows[RA.id].joined === 'number' && typeof x.body.rows[RA.id].target === 'number', x.body && { s: x.status, k: Object.keys(x.body) });
  check('team period: sent to the client is counted for the recruiter who had the person (P1 was shared today)', x.body.rows[RA.id].sent >= 1, x.body.rows[RA.id]);
  check('team period: a person with no joinings has a performance word and a target band', typeof x.body.rows[RB.id].band === 'string' && ['none', 'below', 'half', 'met'].includes(x.body.rows[RB.id].achBand), x.body.rows[RB.id]);
  x = await tp(tA, { range: 'custom', from: '2026-12-01', to: '2026-12-31' });
  check('team period: a custom range counts the interviews booked in it (three for recruiter A)', x.status === 200 && x.body.rows[RA.id].interviews === 3 && x.body.rows[RA.id].joined === 0, x.body && x.body.rows && x.body.rows[RA.id]);
  x = await tp(tA, { range: 'custom', from: '2026-12-31', to: '2026-12-01' });
  check('team period: a reversed custom range is refused or swapped, never a crash', [200, 400].includes(x.status), x.status);
  x = await tp(tA, { range: 'custom', from: 'not-a-date', to: '2026-12-01' });
  check('team period: a bad date is a plain 400', x.status === 400, x.status);
  x = await tp(tRA, { range: 'this_month' });
  check('team period scope: a recruiter sees only their own row (or is refused the Team page)', x.status === 403 || (x.status === 200 && Object.keys(x.body.rows).every((id) => id === RA.id)), x.body && x.body.rows && Object.keys(x.body.rows));
  x = await tp(tRB, { range: 'custom', from: '2026-12-01', to: '2026-12-31' });
  check('team period scope: recruiter B never gets recruiter A\'s numbers', x.status === 403 || (x.status === 200 && !x.body.rows[RA.id]), x.body && x.body.rows && Object.keys(x.body.rows));
  const tv = await call('GET', '/ats/team?shape=v2', null, tA);
  const meRow = ((tv.body && tv.body.rows) || []).find((p) => p.id === RA.id);
  check('team rows carry location, joined-the-company date and HR status for the filters', !!meRow && 'location' in meRow && 'joinedCompanyOn' in meRow && 'employmentStatus' in meRow && 'seat' in meRow, meRow && Object.keys(meRow));

  // =====================================================================================================================
  // CRM LISTS (phase 2): dates, amounts, places; whole history when a filter is on; export with filters; CRM team only
  // =====================================================================================================================
  await call('GET', '/crm/me', null, tA); // the CRM tables are made on first use
  const iso = (d) => new Date(d).toISOString();
  const nowI = iso(Date.now());
  const crmIns = async (table, o) => {
    const cols = Object.keys(o);
    await prisma.$executeRawUnsafe(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((c) => o[c]));
  };
  const own = { ownerId: adminRow.id, ownerName: adminRow.name, createdById: adminRow.id, updatedAt: nowI };
  const crmOk = (await call('GET', '/crm/leads', null, tA)).status === 200;
  check('CRM: the Admin opens the CRM leads', crmOk);
  const CN = (s) => `${TAG} ${s}`;
  try {
    await crmIns('CrmLead', { id: `fl1${P}`, company: CN('L1'), city: 'Hyderabad', industry: 'Hospital', status: 'New', createdAt: nowI, ...own });
    await crmIns('CrmLead', { id: `fl2${P}`, company: CN('L2'), city: 'Pune', industry: 'School', status: 'New', ...own, createdAt: iso('2026-01-10T10:00:00+05:30') });
    await crmIns('CrmLead', { id: `fl3${P}`, company: CN('L3'), city: 'Hyderabad', industry: 'Hospital', status: 'Converted', createdAt: nowI, ...own });
    await crmIns('CrmAccount', { id: `fa1${P}`, name: CN('A1'), city: 'Hyderabad', industry: 'Hospital', source: 'Website', kind: 'Prospect', createdAt: nowI, ...own });
    await crmIns('CrmAccount', { id: `fa2${P}`, name: CN('A2'), city: 'Pune', industry: 'School', source: 'Referral', kind: 'Prospect', ...own, createdAt: iso('2026-01-10T10:00:00+05:30') });
    await crmIns('CrmContact', { id: `fc1${P}`, name: CN('C1'), role: 'HR', createdAt: nowI, ...own });
    await crmIns('CrmContact', { id: `fc2${P}`, name: CN('C2'), role: 'Finance', createdAt: nowI, ...own });
    await crmIns('CrmDeal', { id: `fd1${P}`, title: CN('D1'), stage: 'Proposal sent', value: 500000, expectedClose: '2026-12-15', createdAt: nowI, ...own });
    await crmIns('CrmDeal', { id: `fd2${P}`, title: CN('D2'), stage: 'Prospecting', value: 50000, expectedClose: '2027-01-10', createdAt: nowI, ...own });
    await crmIns('CrmDeal', { id: `fd3${P}`, title: CN('D3'), stage: 'Won', value: 900000, wonAt: iso(ago(100)), createdAt: iso(ago(120)), ...own, updatedAt: iso(ago(100)) });
    await crmIns('CrmInvoice', { id: `fi1${P}`, code: CN('I1'), title: 'x', status: 'Sent', issueDate: '2026-10-01', dueDate: '2026-10-15', amount: 100000, total: 100000, createdAt: nowI, ...own });
    await crmIns('CrmInvoice', { id: `fi2${P}`, code: CN('I2'), title: 'y', status: 'Sent', issueDate: '2026-11-01', dueDate: '2026-11-15', amount: 5000, total: 5000, createdAt: nowI, ...own });
    await crmIns('CrmTask', { id: `ft1${P}`, title: CN('call'), dueDate: dayOf(new Date()), status: 'Open', createdAt: nowI, ...own });
    await crmIns('CrmTask', { id: `ft2${P}`, title: CN('old done'), dueDate: dayOf(ago(100)), status: 'Done', doneAt: iso(ago(100)), createdAt: iso(ago(101)), ...own });
    await crmIns('CrmCampaign', { id: `fm1${P}`, name: CN('Camp'), channel: 'email', body: 'hi', audienceJson: '{}', status: 'Sent', createdAt: nowI, updatedAt: nowI });
  } catch (e) { check(`CRM: the sample rows could be added (${String(e.message).slice(0, 160)})`, false); }
  const crm = async (path, token, params) => { const r = await call('GET', `/crm/${path}?${qs(params || {})}`, null, token); return { status: r.status, body: r.body }; };
  const namesOfRows = (rows, key) => (rows || []).map((y) => y[key]).filter((n) => typeof n === 'string' && n.startsWith(TAG));
  // leads
  x = await crm('leads', tA, {}); check('CRM leads: by default the open lead is listed and the converted one is not', namesOfRows(x.body.rows, 'company').includes(CN('L1')) && !namesOfRows(x.body.rows, 'company').includes(CN('L3')), namesOfRows(x.body.rows, 'company'));
  x = await crm('leads', tA, { city: 'Hyderabad' }); check('CRM leads: city filter reaches the converted lead too (whole history)', same(namesOfRows(x.body.rows, 'company'), [CN('L1'), CN('L3')]), namesOfRows(x.body.rows, 'company'));
  x = await crm('leads', tA, { industry: 'School' }); check('CRM leads: industry', same(namesOfRows(x.body.rows, 'company'), [CN('L2')]), namesOfRows(x.body.rows, 'company'));
  x = await crm('leads', tA, { cFrom: '2026-01-01', cTo: '2026-01-31' }); check('CRM leads: added-on date range', same(namesOfRows(x.body.rows, 'company'), [CN('L2')]), namesOfRows(x.body.rows, 'company'));
  x = await crm('leads', tA, { cFrom: dayOf(new Date()) }); check('CRM leads: added from today', same(namesOfRows(x.body.rows, 'company'), [CN('L1'), CN('L3')]), namesOfRows(x.body.rows, 'company'));
  x = await crm('leads', tA, { page: '1', pageSize: '50', city: 'Pune' }); check('CRM leads: the paged list takes the same filters and says the total', x.status === 200 && x.body.total === 1, x.body && { t: x.body.total });
  // accounts and contacts
  x = await crm('accounts', tA, { city: 'Hyderabad' }); check('CRM accounts: city', same(namesOfRows(x.body.rows, 'name'), [CN('A1')]), namesOfRows(x.body.rows, 'name'));
  x = await crm('accounts', tA, { source: 'Referral' }); check('CRM accounts: source', same(namesOfRows(x.body.rows, 'name'), [CN('A2')]), namesOfRows(x.body.rows, 'name'));
  x = await crm('accounts', tA, { industry: 'School', cTo: '2026-02-01' }); check('CRM accounts: industry + added-on', same(namesOfRows(x.body.rows, 'name'), [CN('A2')]), namesOfRows(x.body.rows, 'name'));
  x = await crm('contacts', tA, { role: 'HR' }); check('CRM contacts: role', same(namesOfRows(x.body.rows, 'name'), [CN('C1')]), namesOfRows(x.body.rows, 'name'));
  // deals
  x = await crm('deals', tA, {}); check('CRM deals: by default a deal won 100 days ago is outside the 30-day window', !namesOfRows(x.body.rows, 'title').includes(CN('D3')) && namesOfRows(x.body.rows, 'title').includes(CN('D1')), namesOfRows(x.body.rows, 'title'));
  x = await crm('deals', tA, { valueMin: '100000' }); check('CRM deals: value from 1 lakh reaches the old won deal (whole history)', same(namesOfRows(x.body.rows, 'title'), [CN('D1'), CN('D3')]), namesOfRows(x.body.rows, 'title'));
  x = await crm('deals', tA, { valueMax: '100000' }); check('CRM deals: value up to 1 lakh', same(namesOfRows(x.body.rows, 'title'), [CN('D2')]), namesOfRows(x.body.rows, 'title'));
  x = await crm('deals', tA, { valueMin: '500000', valueMax: '500000' }); check('CRM deals: value boundaries are included', same(namesOfRows(x.body.rows, 'title'), [CN('D1')]), namesOfRows(x.body.rows, 'title'));
  x = await crm('deals', tA, { stage: 'Prospecting,Proposal sent' }); check('CRM deals: stage (two)', same(namesOfRows(x.body.rows, 'title'), [CN('D1'), CN('D2')]), namesOfRows(x.body.rows, 'title'));
  x = await crm('deals', tA, { closeFrom: '2026-12-01', closeTo: '2026-12-31' }); check('CRM deals: expected-close range', same(namesOfRows(x.body.rows, 'title'), [CN('D1')]), namesOfRows(x.body.rows, 'title'));
  // invoices
  x = await crm('invoices', tA, { amtMin: '50000' }); check('CRM invoices: total from 50,000', same(namesOfRows(x.body.invoices, 'code'), [CN('I1')]), namesOfRows(x.body.invoices, 'code'));
  x = await crm('invoices', tA, { issueFrom: '2026-10-20' }); check('CRM invoices: issued-on range', same(namesOfRows(x.body.invoices, 'code'), [CN('I2')]), namesOfRows(x.body.invoices, 'code'));
  x = await crm('invoices', tA, { dueTo: '2026-10-31' }); check('CRM invoices: due-on range', same(namesOfRows(x.body.invoices, 'code'), [CN('I1')]), namesOfRows(x.body.invoices, 'code'));
  x = await crm('invoices', tA, { q: TAG, amtMax: '5000' }); check('CRM invoices: server search + amount ceiling (boundary included)', same(namesOfRows(x.body.invoices, 'code'), [CN('I2')]), namesOfRows(x.body.invoices, 'code'));
  // follow-ups
  x = await crm('tasks', tA, { when: 'done' }); check('CRM follow-ups: the done list is the last 30 days by default (the old one is not in it)', !(x.body.tasks || []).some((t) => t.id === `ft2${P}`), (x.body.tasks || []).length);
  x = await crm('tasks', tA, { when: 'done', q: TAG }); check('CRM follow-ups: a search reaches the old done follow-up (whole history)', (x.body.tasks || []).some((t) => t.id === `ft2${P}`), (x.body.tasks || []).map((t) => t.title).slice(0, 4));
  x = await crm('tasks', tA, { when: 'open', q: TAG }); check('CRM follow-ups: search finds the open one', same(namesOfRows(x.body.tasks, 'title'), [CN('call')]), namesOfRows(x.body.tasks, 'title'));
  // campaigns
  x = await crm('campaigns', tA, { q: TAG, status: 'Sent' }); check('CRM campaigns: search + status', same(namesOfRows(x.body.rows, 'name'), [CN('Camp')]), namesOfRows(x.body.rows, 'name'));
  x = await crm('campaigns', tA, { q: TAG, channel: 'whatsapp' }); check('CRM campaigns: channel that does not match gives none', namesOfRows(x.body.rows, 'name').length === 0, namesOfRows(x.body.rows, 'name'));
  // export honours the filters; a non-CRM login is refused
  const exAll = await call('GET', '/crm/export/leads', null, tA);
  const exCity = await call('GET', `/crm/export/leads?${qs({ city: 'Pune' })}`, null, tA);
  check('CRM export: unfiltered holds both open leads', exAll.status === 200 && exAll.text.includes(CN('L1')) && exAll.text.includes(CN('L2')), exAll.status);
  check('CRM export: filtered by city holds only that city\'s leads', exCity.status === 200 && exCity.text.includes(CN('L2')) && !exCity.text.includes(CN('L1')), exCity.status);
  const exDeals = await call('GET', `/crm/export/deals?${qs({ valueMin: '800000' })}`, null, tA);
  check('CRM export: deals filtered by value (the old won deal is in, the others out)', exDeals.status === 200 && exDeals.text.includes(CN('D3')) && !exDeals.text.includes(CN('D1')), exDeals.status);
  x = await crm('leads', tRA, {}); check('CRM scope: a recruiter (not in the CRM team) is refused the CRM lists', [401, 403].includes(x.status), x.status);
  x = await crm('deals', tBde, { valueMin: '1' }); check('CRM scope: a BDE is never in the CRM (refused)', [401, 403].includes(x.status), x.status);

  // =====================================================================================================================
  // HRMS (phase 2): the row filters (pure functions the Employees, Payroll and Leave screens use), whole history, exit approvals
  // =====================================================================================================================
  const RF = await import(`file:///${path.resolve(BACK, '..', 'frontend', 'src', 'components', 'ats', 'rowFilters.js').replace(/\\/g, '/')}`);
  const cfg = [
    { id: 'location', type: 'multi', keys: { value: 'location' } },
    { id: 'joined', type: 'daterange', keys: { from: 'jFrom', to: 'jTo' } },
    { id: 'ctc', type: 'range', keys: { min: 'ctcMin', max: 'ctcMax' } },
    { id: 'open', type: 'yesno', keys: { value: 'open' } },
    { id: 'q', type: 'text', keys: { value: 'q' } },
  ];
  const people = [
    { n: 'A', loc: 'Hyderabad', day: '2024-01-10', ctc: 30000, open: true },
    { n: 'B', loc: 'hyderabad', day: '2025-06-30', ctc: 50000, open: false },
    { n: 'C', loc: 'Pune', day: '2025-07-01', ctc: 70000, open: true },
    { n: 'D', loc: null, day: null, ctc: null, open: false },
  ];
  const getp = { location: (r) => r.loc, joined: (r) => r.day, ctc: (r) => r.ctc, open: (r) => r.open, q: (r) => r.n };
  const pick = (values) => RF.filterRows(people, cfg, values, getp).map((r) => r.n).join('');
  check('row filters: a place (case does not matter, several allowed)', pick({ location: 'HYDERABAD' }) === 'AB' && pick({ location: 'Pune,hyderabad' }) === 'ABC');
  check('row filters: a date range includes both ends and leaves out rows with no date', pick({ jFrom: '2025-06-30', jTo: '2025-07-01' }) === 'BC' && pick({ jFrom: '2020-01-01' }) === 'ABC');
  check('row filters: an amount range includes both ends and leaves out rows with no amount', pick({ ctcMin: '30000', ctcMax: '50000' }) === 'AB' && pick({ ctcMin: '50001' }) === 'C' && pick({ ctcMax: '10' }) === '');
  check('row filters: yes / no and text', pick({ open: 'yes' }) === 'AC' && pick({ open: 'no' }) === 'BD' && pick({ q: 'c' }) === 'C');
  check('row filters: combinations', pick({ location: 'Hyderabad', ctcMin: '40000' }) === 'B' && pick({ open: 'yes', jTo: '2024-12-31' }) === 'A');
  const fac = RF.localFacets(people, cfg, { ctcMin: '40000' }, getp).location || [];
  check('row filters: option counts follow the other filters (Hyderabad 1, Pune 1 when CTC is 40,000 or more)', fac.find((o) => o.value.toLowerCase() === 'hyderabad').count === 1 && fac.find((o) => o.value === 'Pune').count === 1, fac);
  const fac2 = RF.localFacets(people, cfg, { location: 'Pune' }, getp).location || [];
  check('row filters: a chosen option keeps its own counts (the location filter leaves itself out)', fac2.find((o) => o.value === 'Pune').count === 1 && fac2.find((o) => o.value.toLowerCase() === 'hyderabad').count === 2, fac2);
  check('whole history: the default status is dropped while searching and kept when moved on purpose', RF.dropDefaultStatus('Active', 'Active', true) === true && RF.dropDefaultStatus('Exited', 'Active', true) === false && RF.dropDefaultStatus('Active', 'Active', false) === false);
  // the employee rows carry what the filters read
  const emp = await call('GET', '/employees/management', null, tA);
  const e0 = ((emp.body && emp.body.rows) || [])[0];
  check('employees: the list rows carry location, the joining day (YYYY-MM-DD), type, manager, team lead and team for the filters', emp.status === 200 && e0 && 'location' in e0 && 'employeeType' in e0 && 'reportingManager' in e0 && 'tl' in e0 && 'team' in e0 && (e0.joiningDay === null || /^\d{4}-\d{2}-\d{2}$/.test(e0.joiningDay)), e0 && Object.keys(e0).slice(0, 40));
  // exit approvals: a filter looks at finished exits too; a date range on the exit
  const exitA = async (params) => { const r = await call('GET', `/resignations/exit/approvals?${qs(params)}`, null, tA); return { status: r.status, n: ((r.body && r.body.rows) || []).length, body: r.body }; };
  const exDef = await exitA({});
  const exitAllV = await exitA({ include: 'all' });
  const exWide = await exitA({ startFrom: '2000-01-01' });
  const exWideAll = await exitA({ startFrom: '2000-01-01', include: 'all' });
  check('exit approvals: answers, and finished exits are only in the "all" view by default', exDef.status === 200 && exitAllV.status === 200 && exitAllV.n >= exDef.n, { d: exDef.n, a: exitAllV.n });
  check('exit approvals: a date filter looks at all exits, finished ones included (same as the all view)', exWide.n === exWideAll.n && exWide.n >= exDef.n, { w: exWide.n, wa: exWideAll.n, d: exDef.n });
  const exNone = await exitA({ lwdFrom: '2099-01-01' });
  check('exit approvals: last-working-day range with nothing in it is empty', exNone.status === 200 && exNone.n === 0, exNone.n);
  const exQ = await exitA({ q: 'zzzz-nobody' });
  check('exit approvals: search finds nobody for a made-up name', exQ.status === 200 && exQ.n === 0, exQ.n);

  // =====================================================================================================================
  // MANY VALUES IN ONE FILTER (founder 2026-11-20): checkboxes everywhere. OR inside one filter, AND across filters; old single links work.
  // =====================================================================================================================
  const MPm = require('../src/utils/multiParam');
  check('parseMulti: trims, de-duplicates, ignores empties, reads a repeated parameter and %2C, caps at 200', JSON.stringify(MPm.parseMulti(' a ,b,,A,c%2Cd ')) === JSON.stringify(['a', 'b', 'c,d']) && JSON.stringify(MPm.parseMulti(['x', 'y,z'])) === JSON.stringify(['x', 'y', 'z']) && MPm.parseMulti(Array.from({ length: 300 }, (_, i) => `v${i}`).join(',')).length === 200 && MPm.parseMulti('').length === 0 && MPm.multiHas('', 'zz') === true);
  check('multiHas: an old single link with a comma inside one value still matches that value only', MPm.multiHas('Hyderabad, Telangana', 'Hyderabad, Telangana') === true && MPm.multiHas('Hyderabad, Telangana', 'Hyderabad') === false && MPm.multiHas('Pune,Chennai', 'Chennai') === true && MPm.multiHas('Hyderabad, Telangana,Pune', 'Pune') === true);
  // candidates, one filter with two and three values
  const U = (a) => [...new Set(a)];
  l = await list(tA, { spec: 'Radiology,none' }); check('multi candidates: two values of Specialization (Radiology + not given) = everybody', same(U(l.names), names(1, 2, 3, 4, 5, 6)), l.names);
  l = await list(tA, { spec: 'Radiology' }); check('multi candidates: one value still works', same(U(l.names), names(1)), l.names);
  l = await list(tA, { notice: '15 Days,30 Days' }); check('multi candidates: two notice periods', same(U(l.names), names(1, 2)), l.names);
  l = await list(tA, { notice: '15 Days,30 Days,Immediate' }); check('multi candidates: three notice periods', same(U(l.names), names(1, 2, 3)), l.names);
  l = await list(tA, { location: 'Pune,Chennai' }); check('multi candidates: two locations', same(U(l.names), names(3, 5)), l.names);
  l = await list(tA, { location: 'Pune,Chennai,hyderabad' }); check('multi candidates: three locations', same(U(l.names), names(2, 3, 5)), l.names);
  l = await list(tA, { location: 'Hyderabad, Telangana' }); check('multi candidates: an OLD single link with a comma inside the value still works', same(U(l.names), names(1)), l.names);
  l = await list(tA, { location: 'Hyderabad%2C Telangana,Pune' }); check('multi candidates: %2C keeps a comma inside one value', same(U(l.names), names(1, 3)), l.names);
  l = await list(tA, { status: 'Active,Rejected' }); check('multi candidates: status two values', same(U(l.names), names(1, 2, 3, 4, 5, 6)), l.names);
  l = await list(tA, { requirementId: `${j1.id},${j2.id}` }); check('multi candidates: two requirements', same(U(l.names), names(1, 2, 3, 4, 5, 6)), l.names);
  l = await list(tA, { requirementId: j1.id }); check('multi candidates: one requirement', same(U(l.names), names(1, 2, 3, 4, 5)), l.names);
  const cj1 = (await prisma.requirement.findUnique({ where: { id: j1.id } })).clientId; const cj2 = (await prisma.requirement.findUnique({ where: { id: j2.id } })).clientId;
  l = await list(tA, { clientId: `${cj1},${cj2}` }); check('multi candidates: two clients', same(U(l.names), names(1, 2, 3, 4, 5, 6)), l.names);
  l = await list(tA, { notice: '15 Days,30 Days', location: 'Hyderabad, Telangana,hyderabad', spec: 'Radiology,none' }); check('multi candidates: three filters, several values each (AND across filters)', same(U(l.names), names(1, 2)), l.names);
  l = await list(tA, { location: 'Pune,Chennai' }, 'master'); check('multi People list: two locations', same(U(l.names), names(3, 5)), l.names);
  l = await list(tRA, { location: 'Hyderabad,Pune,Chennai,Mumbai' }); check('multi scope: recruiter A cannot reach recruiter B\'s person with many values', !l.names.includes(nm(6)) && l.names.length === 4, l.names);
  f = await facet(tA, { spec: 'Radiology' }, 'spec'); check('multi counts: ticking one option still shows the others with their true counts (own filter left out)', optCount(f, 'none') === 5 && optCount(f, 'Radiology') === 1, f.list);
  f = await facet(tA, { noticeBand: 'd15,d30' }, 'noticeBand'); check('multi counts: with two notice bands ticked the other bands keep their counts (own filter left out)', optCount(f, 'imm') === 1 && optCount(f, 'd15') === 1 && optCount(f, 'd30') === 1, f.list);
  f = await facet(tA, { location: 'Pune,Chennai' }, 'noticeBand'); check('multi counts: the counts of another filter follow the ticked values (notice bands among Pune + Chennai)', optCount(f, 'imm') === 1 && optCount(f, 'd60') === 1 && optCount(f, 'd15') === 0, f.list);
  const exMulti = await call('POST', '/ats-io/export/candidates?format=csv', { view: 'pipeline-all', params: { paged: '1', view: 'pipeline', sub: 'all', all: '1', search: TAG, location: 'Pune,Chennai' } }, tA);
  const exMultiLines = String(exMulti.text || '').split(/\r?\n/).filter((x) => x.includes(TAG));
  check('multi export: the Excel / CSV export holds exactly the people the two-value filter lists', exMulti.status === 200 && new Set(exMultiLines.map((x) => (x.match(new RegExp(`${TAG} P[0-9]`)) || [''])[0])).size === 2 && exMultiLines.some((x) => x.includes(nm(3))) && exMultiLines.some((x) => x.includes(nm(5))) && !exMultiLines.some((x) => x.includes(nm(1))), { s: exMulti.status, n: exMultiLines.length });
  // requirements
  x = await rq(tA, { clientId: `${cl1.id},${cl2.id}` }); check('multi requirements: two clients', same(U(x.names), [T(1), T(2), T(3)]), x.names);
  x = await rq(tA, { clientId: cl2.id }); check('multi requirements: one client', same(U(x.names), [T(3)]), x.names);
  x = await rq(tA, { workMode: 'Remote,Hybrid' }); check('multi requirements: two work modes', same(U(x.names), [T(1), T(3)]), x.names);
  x = await rq(tA, { workMode: 'Remote,Hybrid,Work From Office' }); check('multi requirements: three work modes', same(U(x.names), [T(1), T(2), T(3)]), x.names);
  x = await rq(tA, { status: 'OPEN,CLOSED' }); check('multi requirements: Open + Closed together is everything', same(U(x.names), [T(1), T(2), T(3)]), x.names);
  x = await rq(tA, { type: 'client,internal' }); check('multi requirements: Client + Internal together is everything', same(U(x.names), [T(1), T(2), T(3)]), x.names);
  x = await rq(tRA, { clientId: `${cl1.id},${cl2.id}` }); check('multi requirements scope: recruiter A sees only their own jobs with two clients', same(U(x.names), [T(1), T(2)]), x.names);
  // clients, offers, joinings, follow-ups, interviews
  x = await cls(tA, { priority: 'High,Low' }); check('multi clients: two priorities', same(U(x.names), [n1, n2]), x.names);
  x = await cls(tA, { priority: 'High,Low,Medium' }); check('multi clients: three priorities', same(U(x.names), [n1, n2, n3]), x.names);
  x = await cls(tA, { agreementStatus: 'Signed,Pending' }); check('multi clients: two agreement statuses', same(U(x.names), [n1, n2, n3]), x.names);
  const dptJ = (await prisma.requirement.findUnique({ where: { id: R2.id } })).department;
  x = await of(tA, { department: `Zzz-none,${dptJ}` }); check('multi offers: two departments (one that matches nothing)', same(U(x.names), names(1, 2, 3, 5)), x.names);
  x = await of(tA, { recruiter: `${RA.id},${RB.id}` }); check('multi offers: two recruiters (P1 is a joined one on the job of recruiter A)', same(U(x.names), names(1, 2, 3, 5)), x.names);
  x = await of(tA, { offerStatus: 'Offer Released,Offer being prepared' }); check('multi offers: two offer statuses', same(U(x.names), names(2, 3, 5)), x.names);
  x = await jn(tA, { recruiter: `${RA.id},${RB.id}` }); check('multi joinings: two recruiters', same(U(x.names), names(1)), x.names);
  x = await jn(tA, { guarantee: 'none,active,ended' }); check('multi joinings: three guarantee states', x.names.length === 3, x.names);
  x = await fu(tA, { fuDue: 'today,overdue' }); check('multi follow-ups: two due buckets', same(U(x.names), names(1, 2)), x.names);
  x = await fu(tA, { fuType: 'Call,WhatsApp' }); check('multi follow-ups: two types (P4 is the old finished one: whole history)', same(U(x.names), names(1, 2, 3, 4)), x.names);
  x = await fu(tA, { fuOwner: `${RA.id},${RB.id}`, fuType: 'Call,WhatsApp' }); check('multi follow-ups: two owners and two types together', same(U(x.names), names(1, 2, 3, 4)), x.names);
  x = await iv(tA, { ivMode: 'Online,In Person' }); check('multi interviews: two modes', same(U(x.names), names(1, 2, 3)), x.names);
  x = await iv(tA, { ivStatus: 'SCHEDULED,COMPLETED', ivRound: '1,2' }); check('multi interviews: two statuses and two rounds', same(U(x.names), names(1, 2, 3)), x.names);
  x = await iv(tA, { ivClient: `${cj1},${cj2}` }); check('multi interviews: two clients', same(U(x.names), names(1, 2, 3)), x.names);
  // CRM
  x = await crm('leads', tA, { city: 'Hyderabad,Pune' }); check('multi CRM leads: two cities', same(namesOfRows(x.body.rows, 'company'), [CN('L1'), CN('L2'), CN('L3')]), namesOfRows(x.body.rows, 'company'));
  x = await crm('deals', tA, { stage: 'Prospecting,Proposal sent,Won' }); check('multi CRM deals: three stages', same(namesOfRows(x.body.rows, 'title'), [CN('D1'), CN('D2'), CN('D3')]), namesOfRows(x.body.rows, 'title'));
  x = await crm('accounts', tA, { source: 'Website,Referral' }); check('multi CRM accounts: two sources', same(namesOfRows(x.body.rows, 'name'), [CN('A1'), CN('A2')]), namesOfRows(x.body.rows, 'name'));
  x = await crm('contacts', tA, { role: 'HR,Finance' }); check('multi CRM contacts: two roles', same(namesOfRows(x.body.rows, 'name'), [CN('C1'), CN('C2')]), namesOfRows(x.body.rows, 'name'));

  // =====================================================================================================================
  // SEVERAL PEOPLE IN ONE FILTER (founder 2026-11-20): Recruiter / TL / BDE take several id: / name: values; the attribution rule per value, OR-ed
  // =====================================================================================================================
  const V = (a) => [...new Set(a)];
  l = await list(tA, { recruiter: `id:${RA.id}` }); check('people multi: one recruiter by id (attribution)', V(l.names).includes(nm(1)) && !V(l.names).includes(nm(6)), V(l.names));
  l = await list(tA, { recruiter: `id:${RB.id}` }); check('people multi: the other recruiter', V(l.names).includes(nm(6)) && !V(l.names).includes(nm(1)), V(l.names));
  l = await list(tA, { recruiter: `id:${RA.id},id:${RB.id}` }); check('people multi: two recruiters together hold both people', V(l.names).includes(nm(1)) && V(l.names).includes(nm(6)), V(l.names));
  l = await list(tA, { recruiter: `id:${RA.id},id:${RB.id}`, notice: '15 Days,45 Days' }); check('people multi: two recruiters AND two notice periods', same(V(l.names), names(1, 6)), V(l.names));
  l = await list(tA, { recruiter: `name:${RA.name},id:${RB.id}` }); check('people multi: a name and an id can be mixed', V(l.names).includes(nm(1)) && V(l.names).includes(nm(6)), V(l.names));
  l = await list(tA, { recruiter: `id:${RA.id},id:no-such-person` }); check('people multi: an unknown person adds nothing and breaks nothing', V(l.names).includes(nm(1)) && !V(l.names).includes(nm(6)), V(l.names));
  l = await list(tRA, { recruiter: `id:${RA.id},id:${RB.id}` }); check('people multi scope: recruiter A asking for both still sees only their own people', V(l.names).includes(nm(1)) && !V(l.names).includes(nm(6)), V(l.names));
  l = await list(tA, { recruiter: `id:${RA.id},id:${RB.id}` }, 'master'); check('people multi: the People list takes two recruiters too', V(l.names).includes(nm(1)) && V(l.names).includes(nm(6)), V(l.names));
  x = await rq(tA, { recruiterId: `${RA.id},${RB.id}` }); check('people multi: requirements by two recruiters', same(V(x.names), [T(1), T(2)]), x.names);
  x = await rq(tA, { recruiterId: RB.id }); check('people multi: requirements by one recruiter who has none of these', V(x.names).length === 0, x.names);
  x = await fu(tA, { recruiter: `id:${RA.id},id:${RB.id}`, fuDue: 'today,overdue' }); check('people multi: follow-ups of two recruiters and two due buckets', same(V(x.names), names(1, 2)), x.names);
  x = await iv(tA, { recruiter: `id:${RA.id},id:${RB.id}` }); check('people multi: interviews of two recruiters', same(V(x.names), names(1, 2, 3)), x.names);

  // job portal applications and call lists answer their filters
  const jp = await call('GET', `/job-portal/applications?${qs({ jpSource: 'zzz-none' })}`, null, tA);
  check('job portal: a source that matches nothing gives an empty list (200)', jp.status === 200 && rowsOf(jp.body).length === 0, { s: jp.status });
  const cll = await call('GET', `/call-lists?${qs({ source: 'zzz-nothing' })}`, null, tA);
  check('call lists: source filter answers (nothing matches)', cll.status === 200 && (cll.body.lists || []).length === 0, { s: cll.status, b: cll.body });

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
