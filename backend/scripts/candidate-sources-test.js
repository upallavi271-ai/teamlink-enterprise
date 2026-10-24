#!/usr/bin/env node
// ---------------------------------------------------------------------------
// WHERE CANDIDATES COME FROM, AND WHEN (user, 2026-10-13). SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/candidate-sources-test.js [--keep]
//
// ZZTEST people with several sources and dates, hand-counted:
//   Department "Dept" (client C1, jobs J1 / J2): 15 people
//     Naukri 5 (Naukri, naukri.com, NAUKRI RESDEX, Naukri, one with an old-sheet date)  Referral 3  LinkedIn 1  Indeed 1
//     Walk-in 1  Job Portal 1 (applied on the portal)  Not recorded 3 (blank, "Profile screening", an import-day row)
//   Department "Dept2" (client C2, job J3): Naukri 1, Shine 1
//   An internal job for HR: Referral 1, Walk-in 1
//
//   A  counts per source / period / grouping equal the hand-computed table; first / last came; Not recorded
//   B  every tile opens a list of exactly that size (list filter == tile); sort by Came on
//   C  scope per role: recruiter own only (people filters forced), TL team, Manager / Admin all, BDE client-stage counts only
//      (no names / contact / salary anywhere in the answer), HR internal only, client / candidate refused
//   D  cascading filter options with counts (Department narrows Client / Job / Recruiter / TL)
//   E  Excel and PDF exports, re-read, audited
//   F  clean-up suggestions on a messy-sources fixture: preview, confirm, apply, undo, Admin only
//   G  the profile: Came from <source> on <date>, added by <name>
//   H  the People list facet for Source equals the tab
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('SRC');
const XLSX = require(`${Z.BACK}/node_modules/xlsx`);
const CS = require('../src/utils/candidateSource');

const { prisma, call, check, RUN } = Z;
const KEEP = process.argv.includes('--keep');
const DEPT = 'ZZTEST SRC Dept';
const DEPT2 = 'ZZTEST SRC Dept2';
const ist = (offset = 0) => new Date(Date.now() + 330 * 60000 + offset * 86400000).toISOString().slice(0, 10);
const noonIst = (day) => new Date(`${day}T06:30:00Z`); // 12:00 IST of that day
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const monday = (day) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
const BULK_DAY = '2026-09-23'; // a day with thousands of people loaded at once (the real-data copy): "imported"
const q = (o) => new URLSearchParams(o).toString();

(async () => {
  await Z.preclean();
  const extraCands = [];
  try {
    // ---------------------------------------------------------------- fixtures
    const uAdmin = await Z.mkUser('admin', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
    const uMgr = await Z.mkUser('mgr', { role: 'MANAGER', atsRole: 'MANAGER' }, { designation: 'Manager' });
    const uTl = await Z.mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: DEPT, atsScopeDepartments: DEPT }, { designation: 'TL' });
    const rec = (tag, dept = DEPT) => Z.mkUser(tag, { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: dept, atsScopeDepartments: dept }, { tl: uTl.name });
    const rA = await rec('reca');
    const rB = await rec('recb');
    const rC = await rec('recc', DEPT2);
    const uBde = await Z.mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: `BDE,${DEPT}` }, {});
    const uHr = await Z.mkUser('hr', { role: 'EMPLOYEE', atsRole: 'HR', atsDepartment: 'HR', atsScopeDepartments: 'HR' }, {});
    const T = {};
    for (const [k, u] of Object.entries({ admin: uAdmin, mgr: uMgr, tl: uTl, a: rA, b: rB, c: rC, bde: uBde, hr: uHr })) T[k] = await Z.mint(u);

    const mkClient = async (tag, dept, owner) => {
      const c = await prisma.client.create({ data: { name: `ZZTEST SRC Client ${tag} ${RUN}`, location: 'ZZ', ownerDepartment: dept, bdeOwner: owner ? owner.name : null, clientType: 'Client', agreementStatus: 'DRAFT' } });
      Z.made.clients.push(c.id); return c;
    };
    const C1 = await mkClient('C1', DEPT, uBde);
    const C2 = await mkClient('C2', DEPT2, null);
    const mkJob = async (tag, client, dept, extra) => {
      const j = await prisma.requirement.create({ data: { title: `ZZTEST SRC Job ${tag} ${RUN}`, clientId: client ? client.id : null, status: 'OPEN', department: dept, tlId: uTl.id, openings: 3, ...extra } });
      Z.made.reqs.push(j.id); return j;
    };
    const J1 = await mkJob('J1', C1, DEPT, { recruiterId: rA.id });
    const J2 = await mkJob('J2', C1, DEPT, { recruiterId: rB.id });
    const J3 = await mkJob('J3', C2, DEPT2, { recruiterId: rC.id, tlId: null });
    const JH = await mkJob('JH', C2, 'HR', { internal: true, hiringType: 'TeamLink Internal Hire', recruiterId: null, tlId: null });

    let n = 0;
    const FIX = []; // what was created: { key, source, day, job, kind, stage }
    // person: raw source (null = blank), day offset from today (or an absolute 'YYYY-MM-DD'), job, stage, extras
    const mk = async (key, source, when, job, stage, extra = {}) => {
      n += 1;
      const day = typeof when === 'number' ? ist(when) : when;
      const appDay = extra.appDay || day;
      const cand = await prisma.candidate.create({
        data: {
          name: `ZZTEST SRC ${key} ${RUN}`, email: `zz-src-${key}-${RUN}@example.test`, phone: `91000${String(n).padStart(5, '0')}`, location: 'ZZ',
          source, createdAt: noonIst(day), currentSalary: '3 LPA', expectedSalary: '4 LPA',
        },
      });
      Z.made.cands.push(cand.id);
      const app = await prisma.application.create({
        data: { candidateId: cand.id, requirementId: job.id, stage, source: extra.appSource === undefined ? null : extra.appSource, createdAt: noonIst(appDay), updatedAt: noonIst(appDay), ...(stage === 'JOINED' ? { joiningStatus: 'Joined' } : {}) },
      });
      Z.made.apps.push(app.id);
      FIX.push({ key, source, day: extra.cameDay || day, job: job.id, dept: job === J3 ? DEPT2 : job === JH ? 'HR' : DEPT, stage, id: cand.id, appId: app.id, kind: extra.kind || 'entered', canon: source == null ? CS.IMPORTED : CS.canonicalSource(source) });
      return cand;
    };
    // --- Dept, recruiter A / job J1 (8 people)
    await mk('a1', 'Naukri', 0, J1, 'JOINED');
    await mk('a2', 'naukri.com', 0, J1, 'INTERVIEW_SCHEDULED', { appSource: 'naukri.com' });
    await mk('a3', 'NAUKRI RESDEX', -1, J1, 'SHARED_WITH_CLIENT', { appSource: 'NAUKRI RESDEX' });
    await mk('a4', 'Referral', -3, J1, 'RECRUITER_REVIEW');
    await mk('a5', 'Referral', -10, J1, 'RECRUITER_REVIEW');
    await mk('a6', 'LinkedIn', -40, J1, 'RECRUITER_REVIEW');
    await mk('a7', null, -2, J1, 'RECRUITER_REVIEW');
    await mk('a8', 'Profile screening', -5, J1, 'RECRUITER_REVIEW');
    // --- Dept, recruiter B / job J2 (7 people)
    await mk('b1', 'Naukri', -1, J2, 'RECRUITER_REVIEW');
    await mk('b2', 'Indeed', -1, J2, 'RECRUITER_REVIEW');
    await mk('b3', 'Referral', 0, J2, 'RECRUITER_REVIEW');
    await mk('b4', 'Walk-in', -100, J2, 'RECRUITER_REVIEW');
    await mk('b5', 'Job Portal', -7, J2, 'RECRUITER_REVIEW', { appSource: 'TeamLink Job Portal', kind: 'applied' });
    // an old-sheet row: the profile was loaded on the bulk day, the sheet's own date (200 days earlier) lives on the application
    await mk('b6', 'Naukri', BULK_DAY, J2, 'SELECTED', { appDay: addDays(BULK_DAY, -200), cameDay: addDays(BULK_DAY, -200), kind: 'sheet' });
    await mk('b7', 'Profile screening', BULK_DAY, J2, 'RECRUITER_REVIEW', { kind: 'imported' });
    // --- Dept2 (recruiter C)
    await mk('c1', 'Naukri', 0, J3, 'RECRUITER_REVIEW');
    await mk('c2', 'Shine', -2, J3, 'RECRUITER_REVIEW');
    // --- internal hiring (HR)
    await mk('h1', 'Referral', 0, JH, 'RECRUITER_REVIEW');
    await mk('h2', 'Walk-in', -1, JH, 'RECRUITER_REVIEW');
    const inDept = FIX.filter((f) => f.dept === DEPT);

    const sources = (tok, params = {}) => call('GET', `/api/candidates/sources?${q(params)}`, tok);
    const F = { department: DEPT };
    const byLabel = (r) => Object.fromEntries(((r.body && r.body.rows) || []).map((x) => [x.label, x]));
    // hand-made expectations for Dept (literal numbers, counted on paper)
    const HAND = { Naukri: 5, Referral: 3, LinkedIn: 1, Indeed: 1, 'Walk-in': 1, 'Job Portal': 1, 'Not recorded': 3 };

    // =============================================================== A: the numbers
    const all = await sources(T.admin, F);
    check('A0 the endpoint answers (Super Admin)', all.status === 200 && all.body && all.body.ok, [all.status, all.text.slice(0, 200)]);
    const L = byLabel(all);
    check('A1 people per source = the hand count', Object.entries(HAND).every(([k, v]) => L[k] && L[k].people === v) && Object.keys(L).length === Object.keys(HAND).length, Object.fromEntries(Object.entries(L).map(([k, v]) => [k, v.people])));
    check('A2 total 15; tiles: total 15, 6 sources, best source Naukri (5 people)', all.body.total.people === 15 && all.body.tiles.total === 15 && all.body.tiles.sources === 6 && all.body.tiles.best && all.body.tiles.best.source === 'Naukri' && all.body.tiles.best.people === 5, [all.body.tiles, all.body.total.people]);
    const sumShare = all.body.rows.reduce((s, r) => s + r.share, 0);
    check('A3 shares add up to 100 % (within rounding)', Math.abs(sumShare - 100) < 0.6, sumShare);
    check('A4 first / last came: Naukri 10 days before the old-sheet row (-200) to today; Walk-in only -100; Referral -10 to today',
      L.Naukri.first === addDays(BULK_DAY, -200) && L.Naukri.last === ist(0) && L['Walk-in'].first === ist(-100) && L['Walk-in'].last === ist(-100) && L.Referral.first === ist(-10) && L.Referral.last === ist(0),
      [L.Naukri.first, L.Naukri.last, L['Walk-in'].first, L.Referral.first, L.Referral.last]);
    check('A5 "Not recorded" holds the blank, the sheet name and the import-day row (3); an import-only source says so', L['Not recorded'].people === 3 && L['Not recorded'].importedPeople === 1, L['Not recorded']);
    const today = ist(0);
    const wk = monday(today);
    const mo = `${today.slice(0, 7)}-01`;
    const expect = (pred) => inDept.filter(pred).length;
    check('A6 Today / This week / This month columns (independent of the chosen period)',
      all.body.total.today === expect((f) => f.day === today) && all.body.total.week === expect((f) => f.day >= wk && f.day <= today) && all.body.total.month === expect((f) => f.day >= mo && f.day <= today)
      && L.Naukri.today === 2 && L.Referral.today === 1,
      [all.body.total.today, all.body.total.week, all.body.total.month, L.Naukri.today]);
    check('A7 Naukri converted: sent to client 4 (a1 a2 a3 + the SELECTED old-sheet row), interview 3, joined 1; Referral none',
      L.Naukri.sent === 4 && L.Naukri.interview === 3 && L.Naukri.joined === 1 && L.Referral.sent === 0, [L.Naukri.sent, L.Naukri.interview, L.Naukri.joined]);
    check('A8 data quality: 3 with no source, 1 with only an import date, 14 real dates (1 sheet, 1 applied, 12 entered)',
      all.body.quality.noSource === 3 && all.body.quality.importedDate === 1 && all.body.quality.realDate === 14 && all.body.quality.kinds.sheet === 1 && all.body.quality.kinds.applied === 1 && all.body.quality.kinds.entered === 12 && all.body.quality.kinds.imported === 1, all.body.quality);

    // periods (expected from the fixture dates, counted by an independent loop)
    const PER = {
      today: [today, today],
      yesterday: [ist(-1), ist(-1)],
      week: [wk, today],
      month: [mo, today],
      lastmonth: [(() => { const d = new Date(`${mo}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 10); })(), addDays(mo, -1)],
      last3: [(() => { const d = new Date(`${mo}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 2); return d.toISOString().slice(0, 10); })(), today],
      year: [`${today.slice(0, 4)}-01-01`, today],
      custom: [ist(-12), ist(-2)],
    };
    for (const [p, [a, b]] of Object.entries(PER)) {
      const r = await sources(T.admin, { ...F, period: p, ...(p === 'custom' ? { from: a, to: b } : {}) });
      const want = inDept.filter((f) => f.day >= a && f.day <= b).length;
      check(`A9 period ${p} (${a} to ${b}): ${want} people; the tile, the rows and the total agree`, r.status === 200 && r.body.tiles.total === want && r.body.total.people === want && r.body.rows.reduce((s, x) => s + x.people, 0) === want && r.body.period.from === a && r.body.period.to === b, [r.status, r.body && r.body.tiles, want, r.body && r.body.period]);
    }


    // groupings: day / week / month over a custom range, compared with a loop
    {
      const a = ist(-12);
      const r = await sources(T.admin, { ...F, period: 'custom', from: a, to: today, group: 'day' });
      const cols = r.body.overTime.columns.map((c) => c.key);
      const want = cols.map((d) => inDept.filter((f) => f.day === d).length);
      check('A10 day by day: 13 columns, the daily totals equal the hand count, each source row adds up', cols.length === 13 && JSON.stringify(r.body.overTime.totals) === JSON.stringify(want) && r.body.overTime.rows.every((x) => x.values.reduce((s, v) => s + v, 0) === x.total) && r.body.overTime.total === want.reduce((s, v) => s + v, 0), [cols.length, r.body.overTime.totals, want]);
      const nk = r.body.overTime.rows.find((x) => x.label === 'Naukri');
      check('A11 day by day, Naukri row: 2 today, 1 yesterday (a3; b1 is Naukri too: 2)', nk && nk.values[cols.indexOf(today)] === 2 && nk.values[cols.indexOf(ist(-1))] === 2, nk);
      const rw = await sources(T.admin, { ...F, period: 'custom', from: ist(-40), to: today, group: 'week' });
      const wcols = rw.body.overTime.columns;
      const wantW = wcols.map((c) => inDept.filter((f) => f.day >= c.from && f.day <= c.to).length);
      check('A12 week by week (Monday to Sunday): every column equals the hand count; first column starts on a Monday', JSON.stringify(rw.body.overTime.totals) === JSON.stringify(wantW) && new Date(`${wcols[0].from}T00:00:00Z`).getUTCDay() === 1, [rw.body.overTime.totals, wantW]);
      const rm = await sources(T.admin, { ...F, period: 'year', group: 'month' });
      const mcols = rm.body.overTime.columns;
      const wantM = mcols.map((c) => inDept.filter((f) => f.day >= c.from && f.day <= c.to).length);
      check('A13 month by month for this year: every column equals the hand count', JSON.stringify(rm.body.overTime.totals) === JSON.stringify(wantM) && rm.body.group === 'month', [rm.body.overTime.totals, wantM]);
      const rd = await sources(T.admin, { ...F, period: 'all', group: 'day' });
      check('A14 day by day for all time is too many columns: it says it moved to week / month by itself', rd.body.group !== 'day' && !!rd.body.groupNote, [rd.body.group, rd.body.groupNote]);
      const real = await sources(T.admin, { ...F, onlyReal: '1' });
      check('A15 "leave out people loaded by an import": 14 people, Not recorded 2', real.body.tiles.total === 14 && byLabel(real)['Not recorded'].people === 2 && real.body.drill.cameKind === 'sheet,applied,entered', [real.body.tiles.total, real.body.drill]);
    }

    // =============================================================== B: a tile opens a list of exactly that size
    const listTotal = async (tok, params) => {
      const r = await call('GET', `/api/candidates?${q({ paged: '1', view: 'master', sub: 'all', pageSize: '25', ...params })}`, tok);
      return r.status === 200 ? r.body.total : `HTTP ${r.status}`;
    };
    {
      let bad = [];
      for (const [p, [a, b]] of [['all', []], ...Object.entries(PER).filter(([k]) => ['today', 'week', 'month', 'lastmonth', 'custom'].includes(k))]) {
        const r = await sources(T.admin, { ...F, period: p, ...(p === 'custom' ? { from: a, to: b } : {}) });
        const drill = r.body.drill;
        const rg = p === 'all' ? {} : { cameFrom: r.body.period.from, cameTo: r.body.period.to };
        for (const row of r.body.rows) {
          // eslint-disable-next-line no-await-in-loop
          const got = await listTotal(T.admin, { ...drill, ...rg, source: row.source });
          if (got !== row.people) bad.push([p, row.label, row.people, got]);
        }
        // eslint-disable-next-line no-await-in-loop
        const gotAll = await listTotal(T.admin, { ...drill, ...rg });
        if (gotAll !== r.body.tiles.total) bad.push([p, 'ALL', r.body.tiles.total, gotAll]);
      }
      check('B1 for every period and every source: list(source, cameFrom, cameTo, department) = the table number; list(no source) = Total tile', bad.length === 0, bad.slice(0, 6));
      const r = await sources(T.admin, F);
      const t1 = await listTotal(T.admin, { ...F, cameFrom: today, cameTo: today });
      const t2 = await listTotal(T.admin, { ...F, cameFrom: wk, cameTo: today });
      const t3 = await listTotal(T.admin, { ...F, cameFrom: mo, cameTo: today });
      check('B2 Today / This week / This month cells = the list for those days', t1 === r.body.total.today && t2 === r.body.total.week && t3 === r.body.total.month, [t1, r.body.total.today, t2, r.body.total.week, t3, r.body.total.month]);
      const nr = await listTotal(T.admin, { ...F, source: CS.IMPORTED });
      const imp = await listTotal(T.admin, { ...F, cameKind: 'imported' });
      check('B3 "Show them" buttons: no source = 3, only an import date = 1', nr === 3 && imp === 1, [nr, imp]);
      const asc = await call('GET', `/api/candidates?${q({ paged: '1', view: 'master', sub: 'all', pageSize: '25', ...F, sort: 'cameOn', dir: 'asc' })}`, T.admin);
      const desc = await call('GET', `/api/candidates?${q({ paged: '1', view: 'master', sub: 'all', pageSize: '25', ...F, sort: 'cameOn', dir: 'desc' })}`, T.admin);
      const days = inDept.map((f) => f.day).sort();
      check('B4 sort by Came on: oldest first / newest first (the sheet date counts, not the load day)', asc.body.rows[0].cameOnDay === days[0] && desc.body.rows[0].cameOnDay === days[days.length - 1] && asc.body.rows[0].cameOnKind === 'sheet', [asc.body.rows[0] && asc.body.rows[0].cameOnDay, days[0], desc.body.rows[0] && desc.body.rows[0].cameOnDay]);
      const row = (desc.body.rows || []).find((x) => x.name.includes(` b7 `));
      const row6 = (asc.body.rows || []).find((x) => x.name.includes(` b6 `));
      const row5 = (asc.body.rows || []).find((x) => x.name.includes(` b5 `));
      const row7 = (asc.body.rows || []).find((x) => x.name.includes(` a7 `));
      check('B5 list rows carry the source word and the date: import-day row says imported, old-sheet row says sheet, portal row says applied, blank source is the unknown bucket',
        row && row.cameOnKind === 'imported' && row6 && row6.cameOnKind === 'sheet' && row5 && row5.cameOnKind === 'applied' && row7 && row7.sourceKey === CS.IMPORTED, [row && row.cameOnKind, row6 && row6.cameOnKind, row5 && row5.cameOnKind, row7 && row7.sourceKey]);
      const pipe = await call('GET', `/api/candidates?${q({ paged: '1', view: 'pipeline', sub: 'all', pageSize: '50', ...F })}`, T.admin);
      const prow = (pipe.body.rows || []).find((x) => x.name.includes(` a2 `));
      check('B6 the Applications list rows also carry Came on (Source · Came on in Simple view)', prow && prow.cameOnDay === today && prow.cameOnKind === 'entered' && prow.sourceKey === 'Naukri', prow && [prow.cameOnDay, prow.cameOnKind, prow.sourceKey]);
      const pf = await call('GET', `/api/candidates?${q({ paged: '1', view: 'pipeline', sub: 'all', pageSize: '50', ...F, cameFrom: today, cameTo: today })}`, T.admin);
      check('B7 the Applications list also takes the Came on range (today: a1 a2 b3)', pf.status === 200 && pf.body.total === inDept.filter((f) => f.day === today).length, pf.body && pf.body.total);
    }

    // =============================================================== C: who sees what
    {
      const ra = await sources(T.a);
      check('C1 recruiter A: only their own 8 people (period all); the team and the other recruiter are not in the numbers', ra.status === 200 && ra.body.tiles.total === 8 && ra.body.rows.reduce((s, x) => s + x.people, 0) === 8, [ra.status, ra.body && ra.body.tiles]);
      const raAsk = await sources(T.a, { recruiter: `name:${rB.name}`, tl: `name:${uTl.name}` });
      check('C2 recruiter A asking for recruiter B / the team: still only their own 8 (people filters are forced)', raAsk.body.tiles.total === 8 && raAsk.body.drill.recruiter === `id:${rA.id}`, [raAsk.body.tiles, raAsk.body.drill]);
      const raDept = await sources(T.a, { department: DEPT2 });
      check('C2b recruiter A asking for another department: nothing of theirs there (0), nobody else numbers', raDept.body.tiles.total === 0 && !raDept.text.includes('Shine'), raDept.body.tiles);
      check('C3 recruiter A gets no recruiter / team-lead filter lists and no other recruiter name anywhere in the answer', !raAsk.body.facets.recruiter && !raAsk.body.facets.tl && !raAsk.text.includes(rB.name) && !raAsk.text.includes(uTl.name), Object.keys(raAsk.body.facets));
      const listA = await listTotal(T.a, { ...raAsk.body.drill });
      check('C4 recruiter A: the tile equals what the list opens with the forced filter (8)', listA === 8, listA);
      const rb = await sources(T.b);
      check('C5 recruiter B: their own 7', rb.body.tiles.total === 7, rb.body.tiles);
      const rt = await sources(T.tl);
      check('C6 TL: the team, both recruiters (15 in the department)', rt.status === 200 && rt.body.tiles.total === 15 && Object.fromEntries(rt.body.rows.map((x) => [x.label, x.people])).Naukri === 5, [rt.status, rt.body && rt.body.tiles]);
      check('C7 TL gets a recruiter filter (A 8, B 7) but nothing from the other department', rt.body.facets.recruiter.length === 2 && rt.body.facets.department.length === 1 && rt.body.facets.department[0].value === DEPT, [rt.body.facets.recruiter, rt.body.facets.department]);
      const rm = await sources(T.mgr, F);
      const rm2 = await sources(T.mgr);
      check('C8 Manager: sees all (15 in the department; far more without a filter)', rm.body.tiles.total === 15 && rm2.body.tiles.total > 17, [rm.body.tiles.total, rm2.body.tiles.total]);
      const rd2 = await sources(T.admin, { department: DEPT2 });
      check('C9 Admin: the other department too (Naukri 1, Shine 1)', rd2.body.tiles.total === 2 && byLabel(rd2).Shine.people === 1, rd2.body.tiles);
      // BDE: client-stage people only (a1 JOINED, a2 INTERVIEW, a3 SHARED, b6 SELECTED) and counts only
      const rbde = await sources(T.bde);
      check('C10 BDE: only the people who reached the client step (4 of the 15; recruiter-review people are not counted)', rbde.status === 200 && rbde.body.tiles.total === 4, [rbde.status, rbde.body && rbde.body.tiles]);
      const secrets = [`zz-src-`, '91000', 'ZZTEST SRC a', 'ZZTEST SRC b', '@example.test', 'currentSalary', 'expectedSalary', 'phone', 'email', '3 LPA'];
      const leaked = secrets.filter((x) => rbde.text.includes(x));
      check('C11 BDE answer holds counts only: no candidate name, phone, e-mail or salary anywhere', leaked.length === 0, leaked);
      check('C12 BDE gets no recruiter / team-lead filter lists; no clean-up, no people list from here', !rbde.body.facets.recruiter && !rbde.body.facets.tl && rbde.body.can.cleanup === false, [Object.keys(rbde.body.facets), rbde.body.can]);
      const rbdeAll = await sources(T.bde, { recruiter: `name:${rA.name}` });
      check('C13 BDE asking for a recruiter: ignored (still 4)', rbdeAll.body.tiles.total === 4, rbdeAll.body.tiles);
      const rhr = await sources(T.hr);
      const othersInternal = new Set((await prisma.application.findMany({ where: { requirement: { internal: true }, requirementId: { not: JH.id } }, select: { candidateId: true } })).map((x) => x.candidateId)).size;
      check('C14 HR: the people of internal hiring only (my 2: Referral 1, Walk-in 1, plus the ones already in the sandbox internal jobs); no client-job person (no Naukri / LinkedIn / Indeed)', rhr.status === 200 && rhr.body.tiles.total === 2 + othersInternal && byLabel(rhr).Referral.people === 1 && byLabel(rhr)['Walk-in'].people === 1 && !byLabel(rhr).Naukri && !byLabel(rhr).LinkedIn && !byLabel(rhr).Indeed, [rhr.status, rhr.body && rhr.body.tiles, othersInternal]);
      const noTok = await sources(null);
      check('C15 no login: refused', noTok.status === 401, noTok.status);
      // a client login and a candidate login are refused
      const cl = await Z.mkUser('client', { role: 'CLIENT', atsRole: 'CLIENT', clientId: C1.id }, {});
      const cd = await Z.mkUser('candlogin', { role: 'CANDIDATE', atsRole: 'CANDIDATE', candidateId: inDept[0].id }, {});
      const rcl = await sources(await Z.mint(cl));
      const rcd = await sources(await Z.mint(cd));
      check('C16 client login and candidate login: refused (403)', [rcl.status, rcd.status].every((s) => s === 403), [rcl.status, rcd.status]);
      check('C17 only Admin sees the clean-up: Manager / TL / recruiter / BDE / HR are refused on every clean-up call', (await Promise.all(['mgr', 'tl', 'a', 'bde', 'hr'].map((k) => call('GET', '/api/candidates/sources/cleanup', T[k])))).every((r) => r.status === 403), null);
    }

    // =============================================================== D: cascading options with counts
    {
      const r0 = await sources(T.admin);
      const rD = await sources(T.admin, F);
      const rD2 = await sources(T.admin, { department: DEPT2 });
      const clientsD = (rD.body.facets.clientId || []).map((o) => [o.label, o.count]);
      const clientsD2 = (rD2.body.facets.clientId || []).map((o) => [o.label, o.count]);
      check('D1 Department = Dept: the Client list is only Dept clients (C1: 15); Dept2: only C2 (2)', clientsD.length === 1 && clientsD[0][0].includes('Client C1') && clientsD[0][1] === 15 && clientsD2.length === 1 && clientsD2[0][1] === 2, [clientsD, clientsD2]);
      check('D2 no department chosen: the Job list stays empty (thousands of jobs); once a department is chosen it lists its jobs with counts (J1 8, J2 7)', (r0.body.facets.requirementId || []).length === 0 && rD.body.facets.requirementId.length === 2 && rD.body.facets.requirementId.find((o) => o.label.includes('Job J1')).count === 8 && rD.body.facets.requirementId.find((o) => o.label.includes('Job J2')).count === 7, [(r0.body.facets.requirementId || []).length, rD.body.facets.requirementId]);
      const recD = (rD.body.facets.recruiter || []).map((o) => [o.label, o.count]);
      check('D3 Department = Dept: Recruiter list = ZZTEST recruiters of Dept only (A, B), never C', recD.length === 2 && recD.every(([l]) => !l.includes('recc')), recD);
      const rJ = await sources(T.admin, { ...F, requirementId: J1.id });
      check('D4 Job = J1: the numbers narrow to its 8 people; the recruiter list narrows to A (8)', rJ.body.tiles.total === 8 && rJ.body.facets.recruiter.length === 1 && rJ.body.facets.recruiter[0].count === 8, [rJ.body.tiles, rJ.body.facets.recruiter]);
      const deptList = (rD.body.facets.department || []).map((o) => o.value);
      check('D5 the Department list keeps Dept and Dept2 even when Dept is chosen (own filter left out)', deptList.includes(DEPT) && deptList.includes(DEPT2), deptList.slice(0, 8));
      const listJ = await listTotal(T.admin, { ...rJ.body.drill });
      check('D6 Job filter: list = tile (8)', listJ === 8, listJ);
      const rRec = await sources(T.admin, { ...F, recruiter: `name:${rB.name}` });
      const listRec = await listTotal(T.admin, { ...rRec.body.drill });
      check('D7 Recruiter filter: tile = list (same attribution as the People list)', rRec.status === 200 && rRec.body.tiles.total === listRec && listRec > 0, [rRec.body.tiles.total, listRec]);
    }

    // =============================================================== E: exports
    {
      const x = await call('GET', `/api/candidates/sources/export?${q({ ...F, table: 'sources', format: 'xlsx' })}`, T.admin);
      let ok = x.status === 200;
      let sheetRows = [];
      let about = [];
      if (ok) {
        const wb = XLSX.read(x.buf, { type: 'buffer' });
        ok = wb.SheetNames.includes('About') && wb.SheetNames.includes('Sources');
        sheetRows = XLSX.utils.sheet_to_json(wb.Sheets.Sources, { header: 1 });
        about = XLSX.utils.sheet_to_json(wb.Sheets.About, { header: 1 });
      }
      const naukriRow = sheetRows.find((r) => r[0] === 'Naukri');
      const totalRow = sheetRows.find((r) => r[0] === 'Total');
      check('E1 Excel (sources table): About sheet + table; Naukri 5, Total 15, headers as on screen', ok && naukriRow && naukriRow[1] === 5 && totalRow && totalRow[1] === 15 && sheetRows[0][0] === 'Source' && sheetRows[0][1] === 'People', [x.status, sheetRows.slice(0, 3)]);
      const aboutText = about.map((r) => r.join(' ')).join(' | ');
      check('E2 the file says the title, the period, the filters, who made it and when', /Where candidates come from/.test(aboutText) && /All time/.test(aboutText) && aboutText.includes(DEPT) && aboutText.includes(uAdmin.name) && /Generated at/.test(aboutText), aboutText.slice(0, 300));
      const p = await call('GET', `/api/candidates/sources/export?${q({ ...F, table: 'sources', format: 'pdf' })}`, T.admin);
      const pdfText = p.buf.toString('latin1');
      check('E3 PDF (sources table): a real PDF with the title, the filter and the numbers', p.status === 200 && pdfText.startsWith('%PDF') && pdfText.includes('Where candidates come from') && pdfText.includes(DEPT) && /Naukri/.test(pdfText), [p.status, pdfText.slice(0, 20)]);
      const o = await call('GET', `/api/candidates/sources/export?${q({ ...F, period: 'custom', from: ist(-12), to: today, group: 'day', table: 'overtime', format: 'xlsx' })}`, T.admin);
      let overRows = [];
      if (o.status === 200) overRows = XLSX.utils.sheet_to_json(XLSX.read(o.buf, { type: 'buffer' }).Sheets['Over time'], { header: 1 });
      const api = await sources(T.admin, { ...F, period: 'custom', from: ist(-12), to: today, group: 'day' });
      const apiNk = api.body.overTime.rows.find((r) => r.label === 'Naukri');
      const xlNk = overRows.find((r) => r[0] === 'Naukri');
      check('E4 Excel (over-time table): the Naukri row equals the screen, with a Total column and a Total row', o.status === 200 && xlNk && JSON.stringify(xlNk.slice(1, 1 + apiNk.values.length)) === JSON.stringify(apiNk.values) && xlNk[xlNk.length - 1] === apiNk.total && overRows[overRows.length - 1][0] === 'Total', [o.status, xlNk]);
      const op = await call('GET', `/api/candidates/sources/export?${q({ ...F, period: 'all', table: 'overtime', format: 'pdf' })}`, T.admin);
      check('E5 PDF (over-time table, many columns turned on its side): a real PDF', op.status === 200 && op.buf.toString('latin1').startsWith('%PDF'), op.status);
      const au = await prisma.auditLog.findMany({ where: { userId: uAdmin.id, action: { startsWith: 'Sources' } }, select: { action: true, toValue: true } });
      check('E6 every export is audited (4 exports -> 4 rows)', au.filter((a) => /exported/.test(a.action)).length >= 4 && au.every((a) => !a.toValue || a.toValue.length < 400), au.map((a) => a.action));
      const eb = await call('GET', `/api/candidates/sources/export?${q({ table: 'sources', format: 'xlsx' })}`, T.bde);
      const er = await call('GET', `/api/candidates/sources/export?${q({ table: 'sources', format: 'xlsx' })}`, T.a);
      const exA = er.status === 200 ? XLSX.utils.sheet_to_json(XLSX.read(er.buf, { type: 'buffer' }).Sheets.Sources, { header: 1 }) : [];
      const exB = eb.status === 200 ? XLSX.utils.sheet_to_json(XLSX.read(eb.buf, { type: 'buffer' }).Sheets.Sources, { header: 1 }) : [];
      const bText = eb.status === 200 ? JSON.stringify(exB) : '';
      check('E7 BDE export (if the role may export) holds only counts of the client-step people (Total 4, no names); a recruiter exports only their own (Total 8)', (eb.status === 403 || ((exB.find((r) => r[0] === 'Total') || [])[1] === 4 && !/ZZTEST|@example|9100/.test(bText))) && (er.status === 403 || (exA.find((r) => r[0] === 'Total') || [])[1] === 8), [eb.status, er.status, exB.find((r) => r[0] === 'Total'), exA.find((r) => r[0] === 'Total')]);
    }

    // =============================================================== F: clean-up suggestions on a messy-sources fixture
    {
      const m1 = await mk('m1', 'Naukri Resdex ', -2, J1, 'RECRUITER_REVIEW', { appSource: 'Naukri Resdex ' });
      const m2 = await mk('m2', 'naukri.com', -3, J1, 'RECRUITER_REVIEW');
      const m3 = await mk('m3', 'NAUKRI', -4, J1, 'RECRUITER_REVIEW');
      void m1; void m2; void m3;
      const sg = await call('GET', '/api/candidates/sources/cleanup', T.admin);
      const nk = sg.body && (sg.body.groups || []).find((g) => g.target === 'Naukri');
      const w = (word) => nk && nk.words.find((x) => x.word === word);
      check('F1 suggestions: Naukri has the spellings "naukri.com" (a2 + m2 = at least 2), "NAUKRI RESDEX", "Naukri Resdex ", "NAUKRI"; the sheet names sit in their own group',
        sg.status === 200 && nk && nk.kind === 'spelling' && w('naukri.com').people >= 2 && w('NAUKRI RESDEX').people >= 1 && w('Naukri Resdex ').people >= 1 && w('NAUKRI').people >= 1 && (sg.body.groups.find((g) => g.target === CS.IMPORTED) || {}).kind === 'sheet', [sg.status, nk && nk.words.map((x) => [x.word, x.people])]);
      check('F2 the clean word "Naukri" itself is not offered as something to change', nk && !w('Naukri'), nk && nk.words.map((x) => x.word));
      const mine = ['naukri.com', 'NAUKRI RESDEX', 'Naukri Resdex ', 'NAUKRI'];
      const pv = await call('POST', '/api/candidates/sources/cleanup/preview', T.admin, { target: 'Naukri', words: mine });
      const want = FIX.filter((f) => mine.includes(f.source)).length;
      check('F3 preview merge: counts the people (and applications) it would change, shows examples, changes nothing', pv.status === 200 && pv.body.people === want && pv.body.applications >= 3 && pv.body.sample.length > 0 && pv.body.keepsOldWord === true, [pv.status, pv.body]);
      const before = await prisma.candidate.count({ where: { source: { in: mine } } });
      check('F4 after the preview nothing was changed', before === want, [before, want]);
      const noConfirm = await call('POST', '/api/candidates/sources/cleanup/apply', T.admin, { target: 'Naukri', words: mine });
      const wrongTarget = await call('POST', '/api/candidates/sources/cleanup/apply', T.admin, { target: 'Not a source', words: mine, confirm: true });
      const asTl = await call('POST', '/api/candidates/sources/cleanup/apply', T.tl, { target: 'Naukri', words: mine, confirm: true });
      check('F5 apply is refused without confirm (400), for a made-up target (400) and for a non-Admin (403)', noConfirm.status === 400 && wrongTarget.status === 400 && asTl.status === 403 && (await prisma.candidate.count({ where: { source: { in: mine } } })) === want, [noConfirm.status, wrongTarget.status, asTl.status]);
      const rowsBefore = byLabel(await sources(T.admin, F));
      const ap = await call('POST', '/api/candidates/sources/cleanup/apply', T.admin, { target: 'Naukri', words: mine, confirm: true });
      check('F6 apply: ok, the people changed, an undo file name is returned', ap.status === 200 && ap.body.changedPeople === want && !!ap.body.undoId, [ap.status, ap.body]);
      const audit = await prisma.auditLog.findFirst({ where: { action: 'Source tidied (Sources tab)', userId: uAdmin.id } });
      check('F10 the apply is audited (who, the old words, the new word)', !!audit && audit.toValue === 'Naukri' && audit.fromValue.includes('naukri.com'), audit || 'no audit row');
      const after = await prisma.candidate.findMany({ where: { id: { in: FIX.filter((f) => mine.includes(f.source)).map((f) => f.id) } }, select: { source: true, firstSource: true } });
      check('F7 every one of them now says "Naukri", the old word is kept in the first-source box', after.every((c) => c.source === 'Naukri' && mine.includes(c.firstSource)), after.slice(0, 3));
      const appAfter = await prisma.application.findMany({ where: { id: { in: FIX.filter((f) => ['a2', 'a3', 'm1'].includes(f.key)).map((f) => f.appId) } }, select: { source: true, firstSource: true } });
      check('F8 their requirement applications were tidied too', appAfter.every((a) => a.source === 'Naukri' && a.firstSource), appAfter);
      const rowsAfter = byLabel(await sources(T.admin, F));
      check('F9 the Sources numbers do not move when the words are tidied (the screens already read the clean word)', JSON.stringify(Object.fromEntries(Object.entries(rowsBefore).map(([k, v]) => [k, v.people]))) === JSON.stringify(Object.fromEntries(Object.entries(rowsAfter).map(([k, v]) => [k, v.people]))), [rowsBefore.Naukri && rowsBefore.Naukri.people, rowsAfter.Naukri && rowsAfter.Naukri.people]);
      const un = await call('POST', '/api/candidates/sources/cleanup/undo', T.admin, { undoId: ap.body.undoId, confirm: true });
      const back = await prisma.candidate.findMany({ where: { id: { in: FIX.filter((f) => mine.includes(f.source)).map((f) => f.id) } }, select: { source: true, firstSource: true } });
      check('F11 undo puts every word back (and clears the first-source box it filled)', un.status === 200 && back.length === want && back.every((c) => mine.includes(c.source) && c.firstSource === null), [un.status, un.body, back.slice(0, 3)]);
      const un2 = await call('POST', '/api/candidates/sources/cleanup/undo', T.admin, { undoId: ap.body.undoId, confirm: true });
      check('F12 a second undo of the same file finds nothing to do (404)', un2.status === 404, un2.status);
      const badName = await call('POST', '/api/candidates/sources/cleanup/undo', T.admin, { undoId: '../../etc/passwd', confirm: true });
      check('F13 an undo file name with a path in it is refused (400)', badName.status === 400, badName.status);
    }

    // =============================================================== G: the profile header
    {
      const made = await call('POST', '/api/candidates', T.admin, { name: `ZZTEST SRC Made ${RUN}`, email: `zz-src-made-${RUN}@example.test`, phone: '9100099991', source: 'Referral', skills: 'Java', currentSalary: '3 LPA', expectedSalary: '4 LPA', location: 'ZZ' });
      if (made.body && made.body.id) { Z.made.cands.push(made.body.id); extraCands.push(made.body.id); }
      const det = made.body && made.body.id ? await call('GET', `/api/candidates/${made.body.id}`, T.admin) : null;
      check('G1 a person added by hand: detail says Came from Referral, today, kind entered, added by the Admin\'s name', det && det.status === 200 && det.body.sourceKey === 'Referral' && det.body.cameOnDay === today && det.body.cameOnKind === 'entered' && det.body.addedByName === uAdmin.name, det && [det.status, det.body.sourceKey, det.body.cameOnDay, det.body.cameOnKind, det.body.addedByName]);
      const d6 = await call('GET', `/api/candidates/${FIX.find((f) => f.key === 'b6').id}`, T.admin);
      const d7 = await call('GET', `/api/candidates/${FIX.find((f) => f.key === 'b7').id}`, T.admin);
      check('G2 detail: old-sheet row = sheet date; import-day row = imported, source "Imported sheet"', d6.body.cameOnKind === 'sheet' && d6.body.cameOnDay === addDays(BULK_DAY, -200) && d7.body.cameOnKind === 'imported' && d7.body.cameOnDay === BULK_DAY && d7.body.sourceKey === CS.IMPORTED, [d6.body.cameOnKind, d6.body.cameOnDay, d7.body.cameOnKind, d7.body.sourceKey]);
      const dBde = await call('GET', `/api/candidates/${FIX.find((f) => f.key === 'a1').id}`, T.bde);
      check('G3 BDE opening a client-step person gets no phone / e-mail / salary (the existing rule still holds)', dBde.status === 200 && !dBde.body.phone && !dBde.body.email && !dBde.body.currentSalary, dBde.body && [dBde.status, dBde.body.phone, dBde.body.email, dBde.body.currentSalary]);
    }

    // =============================================================== H: the People list facet = the tab
    {
      const fc = await call('GET', `/api/ats-io/facets/candidates?${q({ view: 'master', sub: 'all', paged: '1', ...F })}`, T.admin);
      const srcFacet = Object.fromEntries(((fc.body && fc.body.facets && fc.body.facets.source) || []).map((o) => [o.value, o.count]));
      const rows = (await sources(T.admin, F)).body.rows;
      check('H1 the Source option counts of the People filter equal the Sources tab per source', fc.status === 200 && rows.every((r) => srcFacet[r.source] === r.people) && Object.keys(srcFacet).length === rows.length, [srcFacet, rows.map((r) => [r.source, r.people])]);
      // applications by source (the Candidates page's "Applications by source" panel counts rows of the pipeline): one application per person here, so the same numbers
      const fp = await call('GET', `/api/ats-io/facets/candidates?${q({ view: 'pipeline', sub: 'all', paged: '1', ...F })}`, T.admin);
      const pf = Object.fromEntries(((fp.body && fp.body.facets && fp.body.facets.source) || []).map((o) => [o.value, o.count]));
      check('H2 with one application per person the pipeline panel "Applications by source" shows the same numbers, except people still in the Job Portal screening (they are not pipeline rows yet)', fp.status === 200 && rows.filter((r) => r.source !== 'Job Portal').every((r) => pf[r.source] === r.people) && pf['Job Portal'] === undefined, [pf]);
    }

    // =============================================================== a person added later shows up (the cache follows the data)
    {
      const more = await mk('z1', 'Shine', 0, J2, 'RECRUITER_REVIEW');
      void more;
      const r = await sources(T.admin, F);
      check('I1 a person added after the first look appears at once (no stale cache): Shine 1, total 19', byLabel(r).Shine && byLabel(r).Shine.people === 1 && r.body.tiles.total === 19, [byLabel(r).Shine, r.body.tiles.total]);
    }
  } catch (e) {
    console.log('TEST CRASHED', e && e.stack ? e.stack : e);
    Z.fail += 1;
  } finally {
    if (!KEEP) {
      const left = await Z.cleanup();
      const audit = await prisma.auditLog.deleteMany({ where: { OR: [{ action: { startsWith: 'Source tid' }, actorName: { contains: 'ZZTEST SRC' } }, { action: { startsWith: 'Sources' }, actorName: { contains: 'ZZTEST SRC' } }] } });
      console.log('cleanup:', JSON.stringify(left), 'extra audit rows:', audit.count);
      const scan = await prisma.candidate.count({ where: { name: { contains: 'ZZTEST SRC' } } });
      Z.check('Z0 no ZZTEST SRC people left in the sandbox', scan === 0 && Object.values(left).every((v) => v === 0), [scan, left]);
    }
    await Z.finish();
  }
})();
