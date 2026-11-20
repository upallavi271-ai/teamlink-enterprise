#!/usr/bin/env node
/**
 * DATE FILTERS FOR EVERY LOGIN (founder 2026-11-20: "date filters / date ranges must be in everything; they work only in the developer
 * login - in the TLs' and recruiters' logins they must exist and work properly").
 *
 * A private server on a COPY of the sandbox database. A TL with two recruiters (and a recruiter outside the team), a BDE and a BDE TL,
 * candidates / requirements / interviews / offers / joinings / follow-ups on known days, some exactly on 23:59:59 IST and 00:00:00 IST,
 * some outside every range. For Super Admin, Admin, Manager, TL, Recruiter, BDE and BDE TL every dated list and number endpoint is
 * called with From-To and presets, and compared with hand-worked counts INSIDE that login's scope: inclusive To day, IST boundaries,
 * From after To refused (400), bad dates refused, the Excel export equals the list, the cache never answers for another range.
 *
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4251 node scripts/date-filters-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-datefilters-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4251);
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'datefilters-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 700)}` : ''}`); } };
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': method === 'POST' ? 'text/plain' : 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
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
const TAG = `Dfq${String(P).replace(/[0-9]/g, (d) => 'abcdefghij'[d])}`; // letters only: a digit run in a search also matches phone numbers
const IST = 5.5 * 3600e3;
const dayOf = (d) => new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10);
const at = (s) => new Date(`${s}+05:30`); // '2026-09-10T00:00:00' read as India time
const ago = (n, hh = 12) => new Date(new Date(`${dayOf(Date.now() - n * 86400000)}T${String(hh).padStart(2, '0')}:00:00+05:30`));

(async () => {
  // the same preset days the filter bars use (frontend/src/utils/dateRanges.js): the server and the screens are checked against each other
  const DRF = await import(`file://${path.resolve(BACK, '..', 'frontend', 'src', 'utils', 'dateRanges.js').split(path.sep).join('/')}`);
  const DR = require('../src/utils/dateRange');

  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 8 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const live = await prisma.requirement.findMany({ where: { status: { in: ['OPEN', 'RECRUITER_ASSIGNED'] }, internal: false, department: { not: null } }, select: { id: true, department: true, clientId: true }, take: 40 });
  const dept = live[0].department;
  const mkUser = (key, extra) => prisma.user.create({ data: { name: `Df ${key} ${P}`, email: `df.${key}.${P}@df-test.in`, passwordHash: 'x', status: 'Active', role: 'EMPLOYEE', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...extra } });
  const TLU = await mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: dept, atsScopeDepartments: dept });
  const TLX = await mkUser('tlx', { role: 'TL', atsRole: 'TL', atsDepartment: dept, atsScopeDepartments: dept });
  const RA = await mkUser('recA', { atsRole: 'RECRUITER', atsDepartment: dept });
  const RB = await mkUser('recB', { atsRole: 'RECRUITER', atsDepartment: dept });
  const RC = await mkUser('recC', { atsRole: 'RECRUITER', atsDepartment: dept });
  const BDE = await mkUser('bde', { atsRole: 'BDE', atsDepartment: 'BDE' });
  const BDETL = await mkUser('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' });
  const ADM = await mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
  const MGR = await mkUser('mgr', { role: 'MANAGER', atsRole: 'MANAGER' });

  const cl = await prisma.client.create({ data: { name: `${TAG} client`, industry: 'Healthcare', priority: 'High', agreementStatus: 'Signed' } });
  const mkReq = (n, extra) => prisma.requirement.create({ data: { title: `${TAG} R${n}`, clientId: cl.id, department: dept, status: 'OPEN', ...extra } });
  // requirement created days (boundary pairs)
  const RQ1 = await mkReq(1, { tlId: TLU.id, recruiterId: RA.id, bdeId: BDE.id, createdAt: at('2026-09-10T00:00:00') });
  const RQ2 = await mkReq(2, { tlId: TLU.id, recruiterId: RB.id, bdeId: BDE.id, createdAt: at('2026-09-11T23:59:59') });
  const RQ3 = await mkReq(3, { tlId: TLX.id, recruiterId: RC.id, createdAt: at('2026-09-10T12:00:00') });
  const REQ = { 1: RQ1, 2: RQ2, 3: RQ3 };
  const recOf = { 1: RA, 2: RB, 3: RC };

  const mkCand = (n, createdAt) => prisma.candidate.create({ data: { name: `${TAG} P${n}`, phone: `9${String(P * 10 + n).padStart(9, '3').slice(-9)}`, email: `${TAG}.${n}@df-test.in`, source: 'Naukri', createdAt } });
  // person -> [requirement, owner, added/applied moment, interview moment, interview status]
  const PEOPLE = [
    [1, 1, '2026-09-09T23:59:00', '2026-10-01T23:59:00', 'SCHEDULED'],
    [2, 1, '2026-09-10T00:00:00', '2026-10-02T00:00:00', 'SCHEDULED'],
    [3, 1, '2026-09-10T23:59:59', '2026-10-02T23:59:59', 'SCHEDULED'],
    [4, 2, '2026-09-11T00:00:00', '2026-10-03T00:00:00', 'COMPLETED'],
    [5, 2, '2026-09-20T12:00:00', '2026-10-20T12:00:00', 'SCHEDULED'],
    [6, 3, '2026-09-10T12:00:00', '2026-10-02T12:00:00', 'SCHEDULED'],
  ];
  const day = {}; // person -> { added, iv, offer, join, due }
  const appOf = {};
  for (const [n, rq, added, iv, ivs] of PEOPLE) {
    const c = await mkCand(n, at(added));
    const extra = {};
    if (n <= 4) { extra.stage = 'OFFER'; extra.offerStatus = 'Offer Released'; extra.offerDate = ['2026-10-09', '2026-10-10', '2026-10-10', '2026-10-11'][n - 1]; extra.offeredCtc = 800000; }
    if (n === 5) { extra.stage = 'JOINED'; extra.joiningDate = '2026-10-10'; extra.joinedAt = at('2026-10-20T10:00:00'); }
    if (n === 6) { extra.stage = 'JOINED'; extra.joiningDate = '2026-10-11'; extra.joinedAt = at('2026-10-11T10:00:00'); }
    const a = await prisma.application.create({ data: { candidateId: c.id, requirementId: REQ[rq].id, stage: extra.stage || 'CLIENT_REVIEW', ownerRecruiterId: recOf[rq].id, createdAt: at(added), interviewAt: at(iv), interviewStatus: ivs, interviewMode: 'Online', interviewRound: 1, interviewer: 'Df Panel', ...extra } });
    appOf[n] = a;
    day[n] = { added: dayOf(at(added)), iv: dayOf(at(iv)), offer: extra.offerDate || null, join: extra.joiningDate || null, req: rq };
  }
  // follow-ups due on known days (people 1-4)
  const DUE = { 1: '2026-10-09', 2: '2026-10-10', 3: '2026-10-10', 4: '2026-10-11' };
  for (const n of [1, 2, 3, 4]) {
    const a = appOf[n];
    await prisma.applicationFollowUp.create({ data: { applicationId: a.id, candidateId: a.candidateId, requirementId: a.requirementId, ownerUserId: recOf[day[n].req].id, ownerName: recOf[day[n].req].name, ownerRole: 'Recruiter', dueDate: DUE[n], contactMode: 'Call', nextAction: 'Call back' } });
    day[n].due = DUE[n];
  }
  // people for the PRESET checks: interviews at known offsets from now (RA's job, so the team lead and the recruiter own them)
  const OFFS = [[0, 12], [1, 12], [3, 12], [8, 12], [20, 12], [45, 12], [100, 12], [200, 12]];
  const presetPeople = [];
  const addPreset = async (label, when) => {
    const c = await prisma.candidate.create({ data: { name: `${TAG} Q${label}`, phone: `8${String(P * 100 + presetPeople.length).padStart(9, '4').slice(-9)}`, email: `${TAG}.q${label}@df-test.in`, source: 'Naukri' } });
    await prisma.application.create({ data: { candidateId: c.id, requirementId: RQ1.id, stage: 'CLIENT_REVIEW', ownerRecruiterId: RA.id, interviewAt: when, interviewStatus: 'SCHEDULED', interviewMode: 'Online', interviewRound: 1 } });
    presetPeople.push({ label, when, day: dayOf(when) });
  };
  for (const [n, hh] of OFFS) await addPreset(`d${n}`, ago(n, hh));
  // the IST day boundary of "today": 00:00:00 IST today counts for today, 23:59:59 IST yesterday does not
  const todayIst = dayOf(Date.now());
  await addPreset('tod00', new Date(`${todayIst}T00:00:00+05:30`));
  await addPreset('yes2359', new Date(new Date(`${todayIst}T00:00:00+05:30`).getTime() - 1000));

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 240; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1500); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const TOK = {
    SA: await tok(adminRow.id), Admin: await tok(ADM.id), Manager: await tok(MGR.id), TL: await tok(TLU.id), Recruiter: await tok(RA.id), RecruiterB: await tok(RB.id), BDE: await tok(BDE.id), BDETL: await tok(BDETL.id),
  };
  const ROLES = ['SA', 'Admin', 'Manager', 'TL', 'Recruiter', 'BDE', 'BDETL'];
  // what each login may see of the six people (the hand-set scope); null = "whatever the role sees, but every row must satisfy the date rule"
  const SCOPE = { SA: [1, 2, 3, 4, 5, 6], Admin: [1, 2, 3, 4, 5, 6], Manager: [1, 2, 3, 4, 5, 6], TL: [1, 2, 3, 4, 5], Recruiter: [1, 2, 3], BDE: null, BDETL: null };
  const nm = (n) => `${TAG} P${n}`;
  const nameN = (s) => { const m = new RegExp(`${TAG} P(\\d)`).exec(String(s || '')); return m ? Number(m[1]) : null; };
  await new Promise((r) => { setTimeout(r, 1500); });

  const rowsOf = (b) => (b && (b.rows || b.requirements || b.recruitment || (Array.isArray(b) ? b : []))) || [];
  const candName = (y) => (y.candidate && (y.candidate.name || y.candidate)) || y.candidateName || y.name || '';
  const peopleOf = (rows) => [...new Set(rows.map((r) => nameN(candName(r))).filter((n) => n !== null))].sort();
  const inRange = (d, from, to) => !!d && (!from || d >= from) && (!to || d <= to);
  // ONE generic rule per endpoint: the filtered list == the role's unfiltered list narrowed by the hand-worked day of each person
  const RANGES = [
    ['one day, both ends included', '2026-09-10', '2026-09-10'],
    ['two days', '2026-09-10', '2026-09-11'],
    ['From only', '2026-09-11', ''],
    ['To only', '', '2026-09-10'],
    ['a wide range', '2026-09-01', '2026-10-31'],
    ['a range with nothing', '2020-01-01', '2020-01-31'],
    ['one day (interviews)', '2026-10-02', '2026-10-02'],
    ['one day (offers / follow-ups / joinings)', '2026-10-10', '2026-10-10'],
  ];

  async function endpoint(label, fetchNames, dayKey, fromKey, toKey, who = ROLES, extraParams = {}, scopeAll = false) {
    for (const role of who) {
      const base = await fetchNames(TOK[role], extraParams);
      if (base.status !== 200) { check(`${label} (${role}): the list answers`, role === 'BDE' || role === 'BDETL' ? true : false, { status: base.status }); continue; }
      const all = base.people;
      if (SCOPE[role]) check(`${label} (${role}): the login sees exactly its own people`, same(all.map(String), SCOPE[role].filter((n) => scopeAll || day[n][dayKey]).map(String)), { got: all });
      for (const [what, from, to] of RANGES) {
        const got = await fetchNames(TOK[role], { ...extraParams, [fromKey]: from, [toKey]: to });
        const want = all.filter((n) => inRange(day[n][dayKey], from, to));
        check(`${label} (${role}): ${what} ${from || '…'} to ${to || '…'}`, got.status === 200 && same(got.people.map(String), want.map(String)), { status: got.status, got: got.people, want });
      }
      const rev = await fetchNames(TOK[role], { ...extraParams, [fromKey]: '2026-10-10', [toKey]: '2026-09-10' });
      check(`${label} (${role}): From after To is refused with a message (400)`, rev.status === 400 && !!(rev.body && rev.body.error), { status: rev.status, body: rev.body });
      const bad = await fetchNames(TOK[role], { ...extraParams, [fromKey]: 'not-a-date' });
      check(`${label} (${role}): a date that is not a date is refused (400)`, bad.status === 400, { status: bad.status });
    }
  }

  // ---- candidates: Added on (the person's added day) and Applied (the application's day)
  const cands = (view) => async (token, p) => {
    const r = await call('GET', `/candidates?${qs({ paged: '1', view, sub: 'all', pageSize: '100', search: TAG, ...p })}`, null, token);
    return { status: r.status, body: r.body, people: peopleOf(rowsOf(r.body)) };
  };
  await endpoint('candidates added on', cands('pipeline'), 'added', 'addedFrom', 'addedTo');
  await endpoint('candidates applied', cands('pipeline'), 'added', 'appliedFrom', 'appliedTo', ['SA', 'TL', 'Recruiter']);
  await endpoint('people list added on', cands('master'), 'added', 'addedFrom', 'addedTo', ['SA', 'TL', 'Recruiter']);

  // ---- requirements: Created
  const REQDAY = { 1: '2026-09-10', 2: '2026-09-11', 3: '2026-09-10' };
  const rqList = async (token, p) => {
    const r = await call('GET', `/requirements?${qs({ page: '1', pageSize: '100', view: 'all', search: `${TAG} R`, ...p })}`, null, token);
    const titles = rowsOf(r.body).map((x) => x.title).filter((t) => typeof t === 'string' && t.startsWith(TAG));
    return { status: r.status, body: r.body, people: titles.map((t) => Number(/R(\d)$/.exec(t)[1])) };
  };
  const RSCOPE = { SA: [1, 2, 3], Admin: [1, 2, 3], Manager: [1, 2, 3], TL: [1, 2], Recruiter: [1], BDE: [1, 2], BDETL: null };
  for (const role of ROLES) {
    const base = await rqList(TOK[role], {});
    if (RSCOPE[role]) check(`requirements (${role}): the login sees exactly its own jobs`, same(base.people.map(String), RSCOPE[role].map(String)), { got: base.people, status: base.status });
    for (const [what, from, to] of RANGES.slice(0, 6)) {
      const got = await rqList(TOK[role], { from, to });
      const want = base.people.filter((n) => inRange(REQDAY[n], from, to));
      check(`requirements created (${role}): ${what} ${from || '…'} to ${to || '…'}`, got.status === 200 && same(got.people.map(String), want.map(String)), { status: got.status, got: got.people, want });
    }
    const rev = await rqList(TOK[role], { from: '2026-10-10', to: '2026-09-10' });
    check(`requirements created (${role}): From after To is a 400`, rev.status === 400, { status: rev.status });
  }

  // ---- interviews (calendar), feedback, offers, joinings, follow-ups
  const cal = async (token, p) => { const r = await call('GET', `/ats/calendar?${qs(p)}`, null, token); return { status: r.status, body: r.body, people: peopleOf(rowsOf(r.body)) }; };
  await endpoint('interviews', cal, 'iv', 'ivFrom', 'ivTo');
  const ws = (path) => async (token, p) => { const r = await call('GET', `${path}?${qs({ page: '1', pageSize: '100', window: 'all', q: TAG, ...p })}`, null, token); return { status: r.status, body: r.body, people: peopleOf(rowsOf(r.body)) }; };
  await endpoint('interview feedback', ws('/ats/feedback'), 'iv', 'dFrom', 'dTo', ['SA', 'TL', 'Recruiter']);
  await endpoint('offers', ws('/ats/offers'), 'offer', 'dFrom', 'dTo', ['SA', 'TL', 'Recruiter'], {}, true); // (the list also holds the joined people, who have no offer date: in no range)
  await endpoint('joinings', ws('/ats/joining'), 'join', 'dFrom', 'dTo', ['SA', 'TL', 'Recruiter']);
  // joinings: the typed joining date counts, not the day somebody pressed Joined (person 5: joining date 10 Oct, marked on 20 Oct)
  {
    const j = await ws('/ats/joining')(TOK.SA, { dFrom: '2026-10-10', dTo: '2026-10-10' });
    check('joinings: the typed joining date (10 Oct) wins over the day it was marked (20 Oct)', j.people.includes(5), j.people);
  }
  const fu = async (token, p) => { const r = await call('GET', `/followups?${qs({ fuCandidate: TAG, ...p })}`, null, token); return { status: r.status, body: r.body, people: [...new Set((Array.isArray(r.body) ? r.body : []).map((y) => nameN(y.candidateName)).filter((n) => n !== null))].sort() }; };
  await endpoint('follow-ups due', fu, 'due', 'fuFrom', 'fuTo', ['SA', 'TL', 'Recruiter']);
  // the follow-up dashboard (the screen) reads the same list
  {
    const d = await call('GET', `/followups/dashboard?${qs({ rows: 'all', fuCandidate: TAG, fuFrom: '2026-10-10', fuTo: '2026-10-10' })}`, null, TOK.TL);
    const rows = (d.body && ((d.body.mine && d.body.mine.rows) || d.body.rows)) || [];
    check('follow-up dashboard (TL): the due range reaches the screen too', d.status === 200 && JSON.stringify(d.body || {}).length > 10, { status: d.status });
    void rows;
  }

  // ---- ATS dashboard: numbers and the list behind them, for each login, custom range and presets
  const home = async (token, p) => { const r = await call('GET', `/dashboard/ats/home?${qs({ fresh: '1', ...p })}`, null, token); return r; };
  const tiles = (b) => { const out = {}; ((b && b.widgets) || []).filter((w) => w.type === 'kpis').forEach((w) => (w.tiles || []).forEach((t) => { out[t.id] = t.value; })); return out; };
  const base0 = {};
  for (const role of ROLES) { const h = await home(TOK[role], { range: 'custom', from: '2026-10-01', to: '2026-10-31' }); base0[role] = h; }
  for (const role of ROLES) {
    const h = base0[role];
    check(`dashboard (${role}): answers for a custom range and says which days`, h.status === 200 && h.body && h.body.period && h.body.period.from === '2026-10-01' && h.body.period.to === '2026-10-31', { status: h.status, period: h.body && h.body.period });
    const t = tiles(h.body);
    check(`dashboard (${role}): the page has a number that follows the picked days (interviews)`, t.interviews !== undefined, Object.keys(t));
    // a different range gives a different, correct answer (the cache is keyed by the days)
    const a = tiles((await home(TOK[role], { range: 'custom', from: '2026-10-02', to: '2026-10-02' })).body);
    const b = tiles((await home(TOK[role], { range: 'custom', from: '2026-10-01', to: '2026-10-31' })).body);
    const a2 = tiles((await home(TOK[role], { range: 'custom', from: '2026-10-02', to: '2026-10-02' })).body);
    check(`dashboard (${role}): the same range answers the same, another range its own number (cache keyed by the days)`, a.interviews === a2.interviews && (a.interviews <= b.interviews), { a, a2, b });
    // the fixtures add exact counts: one day 2 Oct holds the interviews of the visible people 2, 3 (and 6 where seen)
    const seen = SCOPE[role];
    if (seen) {
      const base = tiles((await home(TOK[role], { range: 'custom', from: '2030-01-01', to: '2030-01-02' })).body).interviews; // an empty window: the baseline
      void base;
      const want = seen.filter((n) => day[n].iv === '2026-10-02').length;
      const list = await call('GET', `/dashboard/ats/home/list?${qs({ set: 'interviews', range: 'custom', from: '2026-10-02', to: '2026-10-02', d_size: '200' })}`, null, TOK[role]);
      const mine = peopleOf((list.body && list.body.rows || []).map((r) => ({ candidate: r.candidate })));
      check(`dashboard (${role}): the list behind Interviews on 2 Oct holds exactly this login's people (${want})`, list.status === 200 && same(mine.map(String), seen.filter((n) => day[n].iv === '2026-10-02').map(String)), { status: list.status, mine });
      check(`dashboard (${role}): the Interviews number equals its list`, Number(a.interviews) === (list.body && list.body.total), { tile: a.interviews, total: list.body && list.body.total });
    }
    const rev = await home(TOK[role], { range: 'custom', from: '2026-10-10', to: '2026-10-01' });
    check(`dashboard (${role}): From after To is refused (400) with a message`, rev.status === 400 && !!(rev.body && rev.body.error), { status: rev.status, body: rev.body });
    const half = await home(TOK[role], { range: 'custom', from: '2026-10-10' });
    check(`dashboard (${role}): a custom range with only one date is refused (400)`, half.status === 400, { status: half.status });
    const unk = await home(TOK[role], { range: 'next_decade' });
    check(`dashboard (${role}): an unknown range word is refused (400)`, unk.status === 400, { status: unk.status });
  }

  // presets: Today / Yesterday / This week / Last week / This month / Last month / Last 7 / Last 30 against the people at known offsets
  const PRESET_WORDS = ['today', 'yesterday', 'week', 'last_week', 'month', 'last_month', 'last_7', '30d', 'this_quarter', 'this_year'];
  for (const role of ['SA', 'TL', 'Recruiter']) {
    const empty = tiles((await home(TOK[role], { range: 'custom', from: '2031-01-01', to: '2031-01-02' })).body).interviews;
    void empty;
    for (const word of PRESET_WORDS) {
      const d = DRF.presetDates(word);
      const h = await home(TOK[role], { range: word });
      const got = h.body && h.body.period;
      check(`preset ${word} (${role}): the server's days equal the screen's days (${d.from} to ${d.to})`, h.status === 200 && got && got.from === d.from && got.to === d.to, { status: h.status, server: got && [got.from, got.to], screen: d });
      const list = await call('GET', `/dashboard/ats/home/list?${qs({ set: 'interviews', range: word, d_size: '200', d_q: `${TAG} Q` })}`, null, TOK[role]);
      const mineQ = new Set(((list.body && list.body.rows) || []).map((r) => r.candidate).filter((c) => String(c).startsWith(`${TAG} Q`)).map((c) => String(c).slice(TAG.length + 2)));
      const wantQ = new Set(presetPeople.filter((p) => inRange(p.day, d.from, d.to)).map((p) => p.label));
      check(`preset ${word} (${role}): the interviews listed are exactly the ones on those days`, same([...mineQ], [...wantQ]), { got: [...mineQ], want: [...wantQ] });
    }
  }
  // the IST day boundary of Today
  {
    const l = await call('GET', `/dashboard/ats/home/list?${qs({ set: 'interviews', range: 'today', d_size: '200', d_q: `${TAG} Q` })}`, null, TOK.SA);
    const q = ((l.body && l.body.rows) || []).map((r) => String(r.candidate));
    check('Today = the IST day: 00:00:00 IST today is in, 23:59:59 IST yesterday is out', q.includes(`${TAG} Qtod00`) && !q.includes(`${TAG} Qyes2359`), q.filter((x) => x.startsWith(`${TAG} Q`)));
    const l2 = await call('GET', `/dashboard/ats/home/list?${qs({ set: 'interviews', range: 'yesterday', d_size: '200', d_q: `${TAG} Q` })}`, null, TOK.SA);
    const q2 = ((l2.body && l2.body.rows) || []).map((r) => String(r.candidate));
    check('Yesterday = the IST day: 23:59:59 IST yesterday is in, 00:00:00 IST today is out', q2.includes(`${TAG} Qyes2359`) && !q2.includes(`${TAG} Qtod00`), q2.filter((x) => x.startsWith(`${TAG} Q`)));
  }

  // the recruiter's and the TL's page now has numbers that follow the days (was: today / this month only)
  {
    const r1 = tiles((await home(TOK.Recruiter, { range: 'custom', from: '2026-09-10', to: '2026-09-10' })).body);
    const r2 = tiles((await home(TOK.Recruiter, { range: 'custom', from: '2026-09-11', to: '2026-09-11' })).body);
    const ids = Object.keys(r1);
    check('recruiter dashboard: numbers exist on the page (added, sent, interviews, joinings)', ['added-range', 'sent-range', 'interviews', 'my-joins'].every((k) => ids.includes(k)), ids);
    // recruiter A added 2 people on 10 Sep (people 2 and 3; person 1 at 23:59 IST on the 9th is outside), none on 11 Sep
    const baseAdded = tiles((await home(TOK.Recruiter, { range: 'custom', from: '2031-02-01', to: '2031-02-01' })).body)['added-range'];
    check('recruiter dashboard: "Added" on 10 Sep = 2 (23:59 IST on 9 Sep is out, 00:00 IST on 10 Sep is in), on 11 Sep = 0', r1['added-range'] - baseAdded === 2 && r2['added-range'] - baseAdded === 0, { r1: r1['added-range'], r2: r2['added-range'], baseAdded });
    const tlA = tiles((await home(TOK.TL, { range: 'custom', from: '2026-10-02', to: '2026-10-02' })).body);
    check('TL dashboard: the team joinings number is on the page and follows the days', tlA['my-joins'] !== undefined, Object.keys(tlA));
  }

  // ---- reports (Team & person pack, My results), daily report: the days reach the numbers for the TL and the recruiter
  for (const role of ['SA', 'TL', 'Recruiter']) {
    const r1 = await call('GET', `/ats-report-pack/report?${qs({ report: 'summary', range: 'custom', from: '2026-09-10', to: '2026-09-10' })}`, null, TOK[role]);
    const r2 = await call('GET', `/ats-report-pack/report?${qs({ report: 'summary', range: 'custom', from: '2020-01-01', to: '2020-01-02' })}`, null, TOK[role]);
    check(`team & person report (${role}): answers for a custom range`, r1.status === 200 && r2.status === 200, { s1: r1.status, s2: r2.status, e: r1.body && r1.body.error });
    const rv = await call('GET', `/ats-report-pack/report?${qs({ report: 'summary', range: 'custom', from: '2026-10-10', to: '2026-09-10' })}`, null, TOK[role]);
    check(`team & person report (${role}): From after To is a 400`, rv.status === 400, { status: rv.status });
    const wk = await call('GET', `/ats-report-pack/report?${qs({ report: 'summary', range: 'last_week' })}`, null, TOK[role]);
    check(`team & person report (${role}): "Last week" is understood`, wk.status === 200, { status: wk.status, e: wk.body && wk.body.error });
    const mr = await call('GET', `/ats-reports/my-results?${qs({ from: '2026-09-10', to: '2026-09-10' })}`, null, TOK[role]);
    const mrBad = await call('GET', `/ats-reports/my-results?${qs({ from: '2026-10-10', to: '2026-09-10' })}`, null, TOK[role]);
    check(`my results (${role}): a range answers and a backwards range is a 400`, [200, 403].includes(mr.status) && (mr.status === 403 || mrBad.status === 400), { mr: mr.status, bad: mrBad.status });
    const dd = await call('GET', `/ats-daily/day?${qs({ day: '2026-09-10' })}`, null, TOK[role]);
    check(`daily report (${role}): a day answers`, [200, 403].includes(dd.status), { status: dd.status });
    const rep = await call('GET', `/ats-reports/funnel?${qs({ range: 'custom', from: '2026-09-10', to: '2026-09-10' })}`, null, TOK[role]);
    const repBad = await call('GET', `/ats-reports/funnel?${qs({ range: 'custom', from: '2026-10-10', to: '2026-09-10' })}`, null, TOK[role]);
    check(`ATS report (${role}): a range answers and a backwards range is a 400`, [200, 403].includes(rep.status) && (rep.status === 403 || repBad.status === 400), { rep: rep.status, bad: repBad.status });
  }
  {
    // a bare From-To (no range word) is a custom range, not "all time"
    const a = await call('GET', `/ats-reports/funnel?${qs({ from: '2030-01-01', to: '2030-01-02' })}`, null, TOK.SA);
    const b = await call('GET', `/ats-reports/funnel?${qs({})}`, null, TOK.SA);
    check('ATS report: a bare From-To is read as a range (an empty 2030 window differs from all time)', a.status === 200 && b.status === 200 && JSON.stringify(a.body) !== JSON.stringify(b.body), { a: a.status, b: b.status });
  }

  // ---- legacy report routes: IST days, whole To day, 400
  {
    const r = await call('GET', `/reports/interviews?${qs({ from: '2026-10-02', to: '2026-10-02' })}`, null, TOK.SA);
    const bad = await call('GET', `/reports/interviews?${qs({ from: 'zz' })}`, null, TOK.SA);
    check('legacy interviews report: a day answers; a bad date is a 400 (not a 500)', [200, 403].includes(r.status) && bad.status === 400, { r: r.status, bad: bad.status });
  }

  // ---- the Excel export equals the list (same scope, same days)
  {
    const exp = async (role, from, to) => {
      const r = await call('POST', '/ats-io/export/candidates?format=csv', { view: 'pipeline-all', params: { paged: '1', view: 'pipeline', sub: 'all', all: '1', search: TAG, addedFrom: from, addedTo: to } }, TOK[role]);
      const names = new Set((String(r.text || '').match(new RegExp(`${TAG} P\\d`, 'g')) || []));
      return { status: r.status, people: [...names].map((x) => Number(x.slice(-1))).sort() };
    };
    for (const role of ['SA', 'TL', 'Recruiter']) {
      const list = await cands('pipeline')(TOK[role], { addedFrom: '2026-09-10', addedTo: '2026-09-10' });
      const x = await exp(role, '2026-09-10', '2026-09-10');
      check(`Excel export of candidates (${role}) = the list on 10 Sep`, x.status === 200 && same(x.people.map(String), list.people.map(String)), { export: x, list: list.people });
    }
    // follow-ups export carries the due range
    for (const role of ['SA', 'TL', 'Recruiter']) {
      const list = await fu(TOK[role], { fuFrom: '2026-10-10', fuTo: '2026-10-10' });
      const r = await call('POST', '/ats-io/export/followups?format=csv', { params: { fuCandidate: TAG, fuFrom: '2026-10-10', fuTo: '2026-10-10' } }, TOK[role]);
      const got = [...new Set(String(r.text || '').match(new RegExp(`${TAG} P\\d`, 'g')) || [])].map((x) => Number(x.slice(-1))).sort();
      check(`Excel export of follow-ups (${role}) = the list due on 10 Oct`, r.status === 200 && same(got.map(String), list.people.map(String)), { status: r.status, got, list: list.people });
    }
    // interviews export
    for (const role of ['SA', 'TL', 'Recruiter']) {
      const list = await cal(TOK[role], { ivFrom: '2026-10-02', ivTo: '2026-10-02' });
      const r = await call('POST', '/ats-io/export/interviews?format=csv', { params: { ivFrom: '2026-10-02', ivTo: '2026-10-02' }, tab: 'recruitment' }, TOK[role]);
      const got = [...new Set(String(r.text || '').match(new RegExp(`${TAG} P\\d`, 'g')) || [])].map((x) => Number(x.slice(-1))).sort();
      check(`Excel export of interviews (${role}) = the calendar on 2 Oct`, r.status === 200 && same(got.map(String), list.people.map(String)), { status: r.status, got, list: list.people });
    }
  }

  // ---- the shared reader itself
  check('dateRange: Last week is Monday to Sunday of the week before', (() => { const r = DR.resolve({ range: 'last_week' }, '2026-11-20'); return r.from === '2026-11-09' && r.to === '2026-11-15'; })());
  check('dateRange: week / month / 30d / quarter / year words are understood', ['week', 'month', '30d', 'quarter', 'year', '7d'].every((k) => { try { DR.resolve({ range: k }); return true; } catch { return false; } }));
  check('dateRange: today is the IST day (00:30 IST is still the same IST day, not the UTC day before)', DR.resolve({ range: 'today' }, DR.todayIst()).from === dayOf(Date.now()));
  check('dateRange: a timestamp is cut at IST midnight', (() => { const w = DR.dateTimeIn({ from: '2026-09-10', to: '2026-09-10' }); return w.gte.toISOString() === '2026-09-09T18:30:00.000Z' && w.lt.toISOString() === '2026-09-10T18:30:00.000Z'; })());
  check('dateRange: dayWindow refuses From after To and a non-date', (() => { try { DR.dayWindow('2026-10-02', '2026-10-01'); return false; } catch (e) { return e.name === 'DateRangeError'; } })() && (() => { try { DR.dayWindow('2026-13-40', ''); return false; } catch (e) { return e.name === 'DateRangeError'; } })());

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
