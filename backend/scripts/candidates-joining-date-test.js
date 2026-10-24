#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE JOINING DATE IN THE CANDIDATE LISTS (founder, 2026-10-22: "it says Joined, but on WHICH date?")  -  COPY DATABASE ONLY.
//
//   cd backend
//   COPY_DB=C:/tmp/jd-copy.db node scripts/candidates-joining-date-test.js      (a VACUUM INTO copy; never prisma/dev.db)
//
// Starts its OWN throw-away API process (TEST_PORT, default 4097, TEST_MODE=1) on the copy and checks, through the real routes:
//   R  real-data numbers (before any fixture): the joined applications with a day in the Candidates & Pipeline Joined list = the ATS Reports
//      Joined list = an independent count from the database; the People list agrees person by person
//   F  ZZTEST fixtures: typed date beats joined-at; joined-at as an India day (midnight edges); the move into Joined as the fallback; "Not recorded"
//      (nothing on file / a nonsense year); several applications: the joined one's day + "Joined X (Requirement, Client)"
//   S  sort by Joining date and the "Joined between" filter run over the WHOLE list (across pages), in People and in Requirement applications
//   E  the Excel / CSV export carries the Joining date column (plain text), and the BDE team's export still has no phone / email / salary
//   M  the BDE team still sees no phone / email / salary in the list; a login without ATS access is still refused
//   D  the profile (candidate detail) carries "Joined on" for a joined application; the Progress board's Joined cards carry the day
//   C  a joining date changed (or removed) shows on the very next read (cache follows the data)
// Every ZZTEST row is removed at the end.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const copy = process.env.COPY_DB;
if (!copy || /prisma[\\/]dev\.db$/i.test(path.resolve(copy))) { console.error('Refusing: set COPY_DB to a COPY of the database, never prisma/dev.db.'); process.exit(2); }
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const BACK = path.resolve(__dirname, '..');
const DB_URL = `file:${path.resolve(copy).split(path.sep).join('/')}?socket_timeout=180`;
const PORT = Number(process.env.TEST_PORT || 4097);
if (PORT === 4010 || PORT === 4045) process.exit(2);
const API = `http://127.0.0.1:${PORT}`;
process.env.DATABASE_URL = DB_URL;
process.env.TEST_MODE = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = DB_URL;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const XLSX = require(path.join(BACK, 'node_modules/xlsx'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 700)}` : ''}`); };
const RUN = Date.now().toString(36);
const NAME = 'ZZTEST JDT';
const made = { users: [], emps: [], clients: [], reqs: [], apps: [], cands: [] };

async function http(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(400000) });
  const buf = Buffer.from(await r.arrayBuffer());
  const text = buf.toString('utf8');
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text, buf, headers: r.headers };
}
const qs = (o) => new URLSearchParams(o).toString();

// ---- the independent oracle (does NOT use src/utils/joinDay*.js) -------------------------------------------------------------------------
const IST = 330 * 60000;
const istDayOf = (d) => new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10);
const typedOf = (s) => { const m = /^(\d{4})-\d{2}-\d{2}/.exec(String(s || '')); return m && +m[1] >= 2015 && +m[1] <= 2100 ? String(s).slice(0, 10) : null; };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const plain = (iso) => `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const JOINED = ['JOINED', 'HIRED'];

(async () => {
  let server;
  try {
    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 120 && !healthy; i += 1) {
      try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }

    // ---- logins ---------------------------------------------------------------------------------------------------------------------------
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mk = async (tag, extra, empExtra) => {
      const u = await prisma.user.create({ data: { ...base, name: `${NAME} ${tag} ${RUN}`, email: `zz-jdt-${tag}-${RUN}@example.test`, username: `zz-jdt-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id);
      if (empExtra) {
        const e = await prisma.employee.create({ data: { employeeCode: `ZZTEST-JDT-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: extra.atsDepartment || null, email: u.email, ...empExtra } });
        made.emps.push(e.id);
      }
      return u;
    };
    const tokenOf = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const uAdmin = await mk('admin', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
    const DEPT = 'ZZTEST JDT Dept';
    const uBde = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: `BDE,${DEPT}` }, {});
    const uNoAts = await mk('noats', { role: 'EMPLOYEE', atsRole: 'NONE', atsAccess: false }, {});
    const TA = await tokenOf(uAdmin);
    const TB = await tokenOf(uBde);
    const TN = await tokenOf(uNoAts);

    // =============================================================== R: real-data numbers (before any fixture)
    const realJoined = await prisma.application.findMany({ where: { stage: { in: JOINED } }, select: { id: true, candidateId: true, joiningDate: true, joinedAt: true } });
    const realMoves = new Map();
    (await prisma.applicationStageEvent.findMany({ where: { toStage: { in: JOINED } }, orderBy: { createdAt: 'asc' }, select: { applicationId: true, createdAt: true } })).forEach((e) => realMoves.set(e.applicationId, e.createdAt));
    const oracleDay = (a) => typedOf(a.joiningDate) || (a.joinedAt ? istDayOf(a.joinedAt) : null) || (realMoves.get(a.id) ? istDayOf(realMoves.get(a.id)) : null);
    const oracleDated = realJoined.filter((a) => oracleDay(a)).length;
    console.log(`  real data: ${realJoined.length} joined applications, ${oracleDated} with a day (typed ${realJoined.filter((a) => typedOf(a.joiningDate)).length}), ${new Set(realJoined.map((a) => a.candidateId)).size} people`);
    const hasReal = realJoined.length > 0;

    // Requirement applications > Joined: every row, page by page
    const pipeAll = [];
    {
      let page = 1; let pages = 1;
      do {
        const r = await http('GET', `/api/candidates?${qs({ paged: '1', view: 'pipeline', sub: 'joined', pageSize: '100', page: String(page), sort: 'joining', dir: 'desc' })}`, TA);
        if (r.status !== 200) { check('R0 the Joined list answers', false, [r.status, r.text.slice(0, 200)]); break; }
        pipeAll.push(...r.body.rows); pages = r.body.pages; page += 1;
      } while (page <= pages);
    }
    const pipeDated = pipeAll.filter((r) => r.joiningDay).length;
    check(`R1 Requirement applications > Joined lists every joined application (${pipeAll.length} = ${realJoined.length})`, pipeAll.length === realJoined.length, [pipeAll.length, realJoined.length]);
    check(`R2 ... and ${pipeDated} of them carry a joining day = the independent count ${oracleDated}`, pipeDated === oracleDated, [pipeDated, oracleDated]);
    check('R3 each row\'s day equals the independent day of that application', pipeAll.every((r) => (r.joiningDay || null) === (oracleDay(realJoined.find((a) => a.id === r.id) || {}) || null)), pipeAll.filter((r) => (r.joiningDay || null) !== (oracleDay(realJoined.find((a) => a.id === r.id) || {}) || null)).slice(0, 3).map((r) => [r.id, r.joiningDay]));
    // the same list sorted newest first: dated rows first (descending), then the "Not recorded" ones, across all pages
    {
      const days = pipeAll.map((r) => r.joiningDay || null);
      const firstNull = days.findIndex((d) => !d);
      const dated = firstNull < 0 ? days : days.slice(0, firstNull);
      const rest = firstNull < 0 ? [] : days.slice(firstNull);
      check('R4 sorted by Joining date (newest first) over all pages: dated rows descending, then the unknown ones last', dated.every((d, i) => i === 0 || dated[i - 1] >= d) && rest.every((d) => !d) && dated.length === oracleDated, [dated.length, rest.filter(Boolean).length]);
    }

    // ATS Reports > Joining > Joined figure
    {
      const rows = [];
      let total = null;
      for (let off = 0; ; off += 500) {
        const r = await http('GET', `/api/ats-reports/joining/drill?${qs({ section: 'tiles', row: '', col: 'joined', range: 'all', offset: String(off), limit: '500' })}`, TA);
        if (r.status !== 200) { check('R5 the Reports Joined list answers', false, [r.status, r.text.slice(0, 200)]); break; }
        total = r.body.total; rows.push(...r.body.rows);
        if (off + 500 >= total) break;
      }
      const repDated = rows.filter((r) => r.cells.joiningDate && r.cells.joiningDate !== 'Not recorded').length;
      check(`R5 ATS Reports > Joined has ${total} people-applications, ${repDated} with a day`, total === realJoined.length && repDated === oracleDated, [total, repDated, oracleDated]);
      check('R6 the two endpoints give the SAME totals (joined, with a day, without a day)', rows.length === pipeAll.length && repDated === pipeDated && rows.length - repDated === pipeAll.length - pipeDated, [rows.length, pipeAll.length, repDated, pipeDated]);
    }

    // People: one row per person
    {
      const r = await http('GET', `/api/candidates?${qs({ paged: '1', view: 'master', sub: 'all', all: '1' })}`, TA);
      check('R7 the whole People list answers', r.status === 200 && Array.isArray(r.body), [r.status]);
      const rows = Array.isArray(r.body) ? r.body : [];
      const byCand = new Map();
      realJoined.forEach((a) => { if (!byCand.has(a.candidateId)) byCand.set(a.candidateId, []); byCand.get(a.candidateId).push(a); });
      const withJoin = rows.filter((x) => x.joiningDay !== undefined);
      check(`R8 People rows with a joined application = the people who joined (${withJoin.length} = ${byCand.size})`, withJoin.length === byCand.size, [withJoin.length, byCand.size]);
      // the oracle's person-level pick: the primary (highest id) application's own day if joined and dated, else the latest day among the other joined ones
      const allApps = await prisma.application.findMany({ select: { id: true, candidateId: true, stage: true } });
      const primaryOf = new Map();
      allApps.forEach((a) => { const p = primaryOf.get(a.candidateId); if (!p || a.id > p) primaryOf.set(a.candidateId, a.id); });
      let wrong = 0; const bad = [];
      for (const [cid, apps] of byCand) {
        const row = rows.find((x) => x.id === cid);
        const prim = apps.find((a) => a.id === primaryOf.get(cid));
        let want = prim && oracleDay(prim) ? oracleDay(prim) : null;
        if (!want) want = apps.map(oracleDay).filter(Boolean).sort().reverse()[0] || null;
        if (!row || (row.joiningDay || null) !== want) { wrong += 1; if (bad.length < 3) bad.push([cid, row && row.joiningDay, want]); }
      }
      check('R9 each person\'s Joining date equals the independent answer (the shown application\'s own day, else the latest other joined day)', wrong === 0, bad);
      const dated = withJoin.filter((x) => x.joiningDay).length;
      const wantPeopleDated = [...byCand.values()].filter((apps) => apps.some((a) => oracleDay(a))).length;
      check(`R10 people with a day ${dated} = people who have at least one dated joined application ${wantPeopleDated}`, dated === wantPeopleDated, [dated, wantPeopleDated]);
      const f = await http('GET', `/api/candidates?${qs({ paged: '1', view: 'master', sub: 'all', joinedFrom: '2000-01-01', joinedTo: '2100-12-31', pageSize: '25' })}`, TA);
      check('R11 People "Joined between" with a very wide range lists exactly the people with a day (server side, whole list)', f.status === 200 && f.body.total === wantPeopleDated, [f.status, f.body && f.body.total, wantPeopleDated]);
      const f2 = await http('GET', `/api/candidates?${qs({ paged: '1', view: 'pipeline', sub: 'all', joinedFrom: '2000-01-01', joinedTo: '2100-12-31', pageSize: '25' })}`, TA);
      check(`R12 Requirement applications "Joined between" (wide) = the ${oracleDated} dated joined applications (= the Reports figure)`, f2.status === 200 && f2.body.total === oracleDated, [f2.status, f2.body && f2.body.total, oracleDated]);
      // sort across pages in People: the page that holds the boundary between dated and undated people
      const D = wantPeopleDated; const PS = 100;
      const pg = Math.max(1, Math.ceil(D / PS));
      const a1 = await http('GET', `/api/candidates?${qs({ paged: '1', view: 'master', sub: 'all', sort: 'joining', dir: 'desc', pageSize: String(PS), page: '1' })}`, TA);
      const aB = await http('GET', `/api/candidates?${qs({ paged: '1', view: 'master', sub: 'all', sort: 'joining', dir: 'desc', pageSize: String(PS), page: String(pg) })}`, TA);
      const aN = await http('GET', `/api/candidates?${qs({ paged: '1', view: 'master', sub: 'all', sort: 'joining', dir: 'desc', pageSize: String(PS), page: String(pg + 1) })}`, TA);
      const firstPageOk = a1.status === 200 && a1.body.rows.every((x, i, arr) => x.joiningDay && (i === 0 || arr[i - 1].joiningDay >= x.joiningDay));
      const cut = D - (pg - 1) * PS; // dated rows on the boundary page
      const bRows = (aB.body && aB.body.rows) || [];
      const nRows = (aN.body && aN.body.rows) || [];
      check('R13 People sorted newest-joined first: page 1 is all dated and descending', firstPageOk && (!hasReal || a1.body.rows.length > 0), a1.body && a1.body.rows && a1.body.rows.slice(0, 3).map((x) => x.joiningDay));
      check('R14 ... the boundary page switches from dated to undated exactly at the count, and the next page has no day at all', bRows.slice(0, cut).every((x) => x.joiningDay) && bRows.slice(cut).every((x) => !x.joiningDay) && nRows.every((x) => !x.joiningDay), [cut, bRows.length, bRows.slice(Math.max(0, cut - 1), cut + 1).map((x) => x.joiningDay), nRows.slice(0, 2).map((x) => x.joiningDay)]);
      const asc = await http('GET', `/api/candidates?${qs({ paged: '1', view: 'master', sub: 'all', sort: 'joining', dir: 'asc', pageSize: '50', page: '1' })}`, TA);
      check('R15 oldest-joined first lists dated rows ascending (people with no day stay last)', asc.status === 200 && asc.body.rows.every((x, i, arr) => x.joiningDay && (i === 0 || arr[i - 1].joiningDay <= x.joiningDay)), asc.body && asc.body.rows && asc.body.rows.slice(0, 3).map((x) => x.joiningDay));
    }

    // =============================================================== F: fixtures
    const mkClient = async (tag, extra = {}) => {
      const c = await prisma.client.create({ data: { name: `${NAME} Client ${tag} ${RUN}`, location: 'ZZ', ownerDepartment: DEPT, bdeOwner: uBde.name, clientType: 'Client', agreementStatus: 'DRAFT', ...extra } });
      made.clients.push(c.id); return c;
    };
    const mkReq = async (tag, client) => {
      const r = await prisma.requirement.create({ data: { title: `${NAME} Req ${tag} ${RUN}`, clientId: client.id, status: 'OPEN', department: DEPT, openings: 5, bdeId: uBde.id } });
      made.reqs.push(r.id); return r;
    };
    const C1 = await mkClient('C1');
    const C2 = await mkClient('C2');
    const R1 = await mkReq('R1', C1); const R2 = await mkReq('R2', C2); const R3 = await mkReq('R3', C1);
    let seq = 0;
    const mkCand = async (key) => {
      seq += 1;
      const c = await prisma.candidate.create({ data: { name: `${NAME} ${key} ${RUN}`, email: `zz-jdt-${key}-${RUN}@example.test`, phone: `91003${String(seq).padStart(5, '0')}`, location: 'ZZ', currentSalary: '5 LPA', expectedSalary: '6 LPA' } });
      made.cands.push(c.id); return c;
    };
    const mkApp = async (cand, req, stage, data = {}, moves = []) => {
      const a = await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, stage, ...data } });
      made.apps.push(a.id);
      for (const m of moves) await prisma.applicationStageEvent.create({ data: { applicationId: a.id, candidateId: cand.id, toStage: m.to, action: `Moved to ${m.to}`, createdAt: m.at } });
      return a;
    };
    const P = {};
    P.typed = await mkCand('typed'); const aTyped = await mkApp(P.typed, R1, 'JOINED', { joiningDate: '2026-10-12', joinedAt: new Date('2026-10-10T20:00:00Z') });
    P.edge1 = await mkCand('edge1'); const aEdge1 = await mkApp(P.edge1, R1, 'JOINED', { joinedAt: new Date('2026-10-12T20:00:00Z') }); // 13 Oct IST
    P.edge2 = await mkCand('edge2'); const aEdge2 = await mkApp(P.edge2, R1, 'JOINED', { joinedAt: new Date('2026-10-12T18:29:59Z') }); // 12 Oct 23:59:59 IST
    P.edge3 = await mkCand('edge3'); const aEdge3 = await mkApp(P.edge3, R1, 'JOINED', { joinedAt: new Date('2026-10-12T18:30:00Z') }); // 13 Oct 00:00:00 IST
    P.move = await mkCand('move'); const aMove = await mkApp(P.move, R1, 'JOINED', {}, [{ to: 'OFFER', at: new Date('2026-09-20T05:00:00Z') }, { to: 'JOINED', at: new Date('2026-09-30T19:00:00Z') }]); // 1 Oct IST
    P.none = await mkCand('none'); const aNone = await mkApp(P.none, R1, 'JOINED');
    P.junk = await mkCand('junk'); const aJunk = await mkApp(P.junk, R1, 'JOINED', { joiningDate: '2203-05-12' });
    P.hired = await mkCand('hired'); const aHired = await mkApp(P.hired, R1, 'HIRED', { joiningDate: '2026-10-08' });
    // several applications: the older one (smaller id) joined, the newer one (the shown one) is still at interview
    P.multiA = await mkCand('multiA');
    const aMA1 = await mkApp(P.multiA, R1, 'JOINED', { joiningDate: '2026-10-05' });
    const aMA2 = await mkApp(P.multiA, R2, 'INTERVIEW_SCHEDULED');
    // the shown (newer) application joined with its own day; an older one joined earlier -> the shown one's day wins, no "elsewhere" line
    P.multiB = await mkCand('multiB');
    const aMB1 = await mkApp(P.multiB, R1, 'JOINED', { joiningDate: '2026-10-01' });
    const aMB2 = await mkApp(P.multiB, R2, 'JOINED', { joiningDate: '2026-10-20' });
    // the shown application joined but has no day; the older one has -> that day is shown, with where
    P.multiC = await mkCand('multiC');
    const aMC1 = await mkApp(P.multiC, R3, 'JOINED', { joiningDate: '2026-10-02' });
    const aMC2 = await mkApp(P.multiC, R2, 'JOINED');
    // not joined at all, a planned day on file
    P.planned = await mkCand('planned'); const aPlanned = await mkApp(P.planned, R1, 'OFFER_ACCEPTED', { joiningDate: '2026-11-01' });
    // no application at all
    P.noapp = await mkCand('noapp');
    check('F0 fixture ids grow in creation order (the "shown" application is the newest)', aMA1.id < aMA2.id && aMB1.id < aMB2.id && aMC1.id < aMC2.id, [aMA1.id, aMA2.id]);

    const listPeople = async (token, extra = {}) => {
      const r = await http('GET', `/api/candidates?${qs({ paged: '1', view: 'master', sub: 'all', search: `${NAME}`, pageSize: '100', ...extra })}`, token);
      return r;
    };
    const personRow = (rows, key) => rows.find((x) => x.name === `${NAME} ${key} ${RUN}`);
    const pr = await listPeople(TA);
    check('F1 the People list finds the fixtures', pr.status === 200 && pr.body.total === Object.keys(P).length, [pr.status, pr.body && pr.body.total, Object.keys(P).length]);
    const rows = (pr.body && pr.body.rows) || [];
    const day = (k) => (personRow(rows, k) || {}).joiningDay;
    check('F2 a typed joining date wins over the joined-at time (12 Oct 2026)', day('typed') === '2026-10-12', day('typed'));
    check('F3 joined-at 12 Oct 20:00 UTC is 13 Oct in India', day('edge1') === '2026-10-13', day('edge1'));
    check('F4 joined-at 12 Oct 18:29:59 UTC is still 12 Oct in India; 18:30:00 UTC is 13 Oct', day('edge2') === '2026-10-12' && day('edge3') === '2026-10-13', [day('edge2'), day('edge3')]);
    check('F5 no typed day, no joined-at: the day the person moved into Joined (30 Sep 19:00 UTC = 1 Oct India)', day('move') === '2026-10-01', day('move'));
    check('F6 nothing on file: the person is a joined person with the day NOT recorded (null, never today)', personRow(rows, 'none') && personRow(rows, 'none').joiningDay === null, personRow(rows, 'none') && personRow(rows, 'none').joiningDay);
    check('F7 a nonsense typed year (2203) is ignored: Not recorded', personRow(rows, 'junk') && personRow(rows, 'junk').joiningDay === null, personRow(rows, 'junk') && personRow(rows, 'junk').joiningDay);
    check('F8 a HIRED application carries its typed day too', day('hired') === '2026-10-08', day('hired'));
    const mA = personRow(rows, 'multiA');
    check('F9 several applications, the shown one is still at interview: the row says Step = interview and carries the joined application\'s day (5 Oct) + where',
      mA && mA.currentStage === 'INTERVIEW_SCHEDULED' && mA.joiningDay === '2026-10-05' && mA.joinedOther && mA.joinedOther.day === '2026-10-05'
      && mA.joinedOther.requirementTitle === R1.title && mA.joinedOther.clientName === C1.name, mA);
    const mB = personRow(rows, 'multiB');
    check('F10 the shown application joined with its own day: that day (20 Oct), no "elsewhere" note', mB && mB.currentStage === 'JOINED' && mB.joiningDay === '2026-10-20' && !mB.joinedOther, mB && [mB.currentStage, mB.joiningDay, mB.joinedOther]);
    const mC = personRow(rows, 'multiC');
    check('F11 the shown joined application has no day but an older joined one has: that day (2 Oct) with where it was (Requirement R3, Client C1)',
      mC && mC.currentStage === 'JOINED' && mC.joiningDay === '2026-10-02' && mC.joinedOther && mC.joinedOther.requirementTitle === R3.title && mC.joinedOther.clientName === C1.name, mC && [mC.currentStage, mC.joiningDay, mC.joinedOther]);
    const pl = personRow(rows, 'planned'); const na = personRow(rows, 'noapp');
    check('F12 a person who has not joined (or has no application) carries no joining fields at all', pl && na && pl.joiningDay === undefined && na.joiningDay === undefined && pl.joinedOther === undefined, [pl && pl.joiningDay, na && na.joiningDay]);
    check('F13 the response keeps its size: no per-row application lists of joining data (only the three small fields)', rows.every((x) => !('joinedDays' in x)), rows.find((x) => 'joinedDays' in x));

    // pipeline rows
    const pp = await http('GET', `/api/candidates?${qs({ paged: '1', view: 'pipeline', sub: 'all', search: `${NAME}`, pageSize: '100' })}`, TA);
    const prow = (aid) => ((pp.body && pp.body.rows) || []).find((x) => x.id === aid);
    check('F14 Requirement applications: the same days per application (typed 12 Oct, edge 13 Oct, move-in 1 Oct, none = null)',
      prow(aTyped.id).joiningDay === '2026-10-12' && prow(aEdge1.id).joiningDay === '2026-10-13' && prow(aMove.id).joiningDay === '2026-10-01' && prow(aNone.id).joiningDay === null && prow(aJunk.id).joiningDay === null,
      [aTyped, aEdge1, aMove, aNone, aJunk].map((a) => prow(a.id) && prow(a.id).joiningDay));
    check('F15 ... each application of a multi-application person has its OWN day (A1 5 Oct, A2 not joined; B1 1 Oct, B2 20 Oct; C1 2 Oct, C2 none)',
      prow(aMA1.id).joiningDay === '2026-10-05' && prow(aMA2.id).joiningDay === null && prow(aMB1.id).joiningDay === '2026-10-01' && prow(aMB2.id).joiningDay === '2026-10-20' && prow(aMC1.id).joiningDay === '2026-10-02' && prow(aMC2.id).joiningDay === null,
      [aMA1, aMA2, aMB1, aMB2, aMC1, aMC2].map((a) => prow(a.id) && prow(a.id).joiningDay));
    check('F16 ... a not-joined application keeps its planned day apart (OFFER_ACCEPTED, 1 Nov)', prow(aPlanned.id) && prow(aPlanned.id).joiningPlanned === '2026-11-01' && !prow(aPlanned.id).joiningDay, prow(aPlanned.id) && [prow(aPlanned.id).joiningDay, prow(aPlanned.id).joiningPlanned]);

    // =============================================================== S: sort + filter across pages (fixtures + real data)
    {
      // People: filter on the fixtures only (search) by range
      const f = async (from, to, extra = {}) => (await listPeople(TA, { joinedFrom: from, joinedTo: to, ...extra })).body;
      const names = (b) => (b.rows || []).map((x) => x.name.replace(` ${RUN}`, '').replace(`${NAME} `, '')).sort();
      const b13 = await f('2026-10-13', '2026-10-13');
      check('S1 People "Joined between" 13 Oct to 13 Oct = edge1, edge3', JSON.stringify(names(b13)) === JSON.stringify(['edge1', 'edge3']), names(b13));
      const b12 = await f('2026-10-12', '2026-10-12');
      check('S2 12 Oct to 12 Oct = typed, edge2', JSON.stringify(names(b12)) === JSON.stringify(['edge2', 'typed']), names(b12));
      const bOct1to5 = await f('2026-10-01', '2026-10-05');
      check('S3 1 Oct to 5 Oct = move (1 Oct), multiA (5 Oct, its joined application), multiB (its older joined application, 1 Oct), multiC (2 Oct)', JSON.stringify(names(bOct1to5)) === JSON.stringify(['move', 'multiA', 'multiB', 'multiC']), names(bOct1to5));
      const bFrom = await f('2026-10-20', '');
      check('S4 only "from 20 Oct" = multiB (20 Oct)', JSON.stringify(names(bFrom)) === JSON.stringify(['multiB']), names(bFrom));
      const bTo = await f('', '2026-10-01');
      check('S5 only "to 1 Oct" = move, and multiB (its OLDER joined application is on 1 Oct)', JSON.stringify(names(bTo)) === JSON.stringify(['move', 'multiB']), names(bTo));
      const bNone = await f('2030-01-01', '2030-12-31');
      check('S6 a range with nobody in it is empty (and a person with no day is never in a range)', bNone.total === 0, names(bNone));
      // Requirement applications: filter
      const pf = async (from, to) => (await http('GET', `/api/candidates?${qs({ paged: '1', view: 'pipeline', sub: 'all', search: NAME, pageSize: '100', joinedFrom: from, joinedTo: to })}`, TA)).body;
      const p13 = await pf('2026-10-13', '2026-10-13');
      check('S7 Requirement applications "Joined between" 13 Oct = 2 applications (edge1, edge3); a not-yet-joined application with a planned day is not matched', p13.total === 2 && p13.rows.every((x) => x.joiningDay === '2026-10-13'), p13.total);
      // sort across pages: page size 25 lists all fixtures sorted; combine with real data -> use the fixtures' own search with pageSize 25 (one page) and also pageSize ... on the whole list below
      const sorted = await listPeople(TA, { sort: 'joining', dir: 'desc' });
      const sd = sorted.body.rows.map((x) => x.joiningDay || null);
      const lastDated = sd.map((d, i) => (d ? i : -1)).reduce((m, i) => Math.max(m, i), -1);
      check('S8 fixtures sorted newest-joined first: 20 Oct, 13 Oct, 13 Oct, 12 Oct, 12 Oct, 8 Oct, 5 Oct, 2 Oct, 1 Oct, then the not-recorded / not-joined ones',
        JSON.stringify(sd.slice(0, lastDated + 1)) === JSON.stringify(['2026-10-20', '2026-10-13', '2026-10-13', '2026-10-12', '2026-10-12', '2026-10-08', '2026-10-05', '2026-10-02', '2026-10-01']) && sd.slice(lastDated + 1).every((d) => !d), sd);
      // the same with a page size of 25 over the WHOLE list: the newest joined of the whole company is on page 1, including a fixture dated 20 Oct if it is the newest
      const whole = await http('GET', `/api/candidates?${qs({ paged: '1', view: 'master', sub: 'all', sort: 'joining', dir: 'desc', pageSize: '25', page: '1' })}`, TA);
      const top = whole.body.rows.map((x) => x.joiningDay);
      check('S9 the whole list newest first: page 1 holds the newest joining days of EVERYONE (not only this page), descending', whole.status === 200 && top.every((d, i) => d && (i === 0 || top[i - 1] >= d)) && top[0] === [...rows.map((x) => x.joiningDay).filter(Boolean), ...top].sort().reverse()[0], top.slice(0, 4));
      const asc = await listPeople(TA, { sort: 'joining', dir: 'asc' });
      const ad = asc.body.rows.map((x) => x.joiningDay || null).filter(Boolean);
      check('S10 oldest first: 1 Oct, 2 Oct, 5 Oct, 8 Oct, 12 Oct ...', JSON.stringify(ad.slice(0, 5)) === JSON.stringify(['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-08', '2026-10-12']), ad);
    }

    // =============================================================== E: export
    {
      const body = { view: 'master', params: { paged: '1', view: 'master', sub: 'all', search: NAME, all: '1' }, scope: 'view' };
      const ex = await http('POST', '/api/ats-io/export/candidates?format=xlsx', TA, body);
      check('E1 Excel export of the People list answers', ex.status === 200 && ex.buf.length > 1000, [ex.status, ex.text.slice(0, 200)]);
      let sheet = [];
      try { const wb = XLSX.read(ex.buf, { type: 'buffer' }); sheet = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false }); } catch (e) { sheet = []; }
      // the header row is the first row with "Candidate"
      const hi = sheet.findIndex((r) => r.includes('Candidate'));
      const head = sheet[hi] || [];
      const ci = head.indexOf('Joining date'); const ni = head.indexOf('Candidate'); const si = head.indexOf('Stage');
      check('E2 the export has a "Joining date" column right after Pipeline Stage', ci > 0 && head[ci - 1] === 'Pipeline Stage', head);
      const cell = (k) => { const r = sheet.slice(hi + 1).find((x) => String(x[ni] || '').includes(` ${k} `)); return r ? r[ci] : undefined; };
      check('E3 plain text dates in the cells: typed "12 Oct 2026", edge1 "13 Oct 2026", move "1 Oct 2026", none/junk "Not recorded", planned (not joined) blank',
        cell('typed') === '12 Oct 2026' && cell('edge1') === '13 Oct 2026' && cell('move') === '1 Oct 2026' && cell('none') === 'Not recorded' && cell('junk') === 'Not recorded' && (cell('planned') === '' || cell('planned') === undefined) && cell('noapp') !== 'Not recorded',
        ['typed', 'edge1', 'move', 'none', 'junk', 'planned', 'noapp'].map((k) => [k, cell(k)]));
      check('E4 a person whose joined application is not the shown one still exports the joined day (5 Oct 2026)', cell('multiA') === '5 Oct 2026' && cell('multiC') === '2 Oct 2026', [cell('multiA'), cell('multiC')]);
      const csv = await http('POST', '/api/ats-io/export/candidates?format=csv', TA, { view: 'pipeline-all', params: { paged: '1', view: 'pipeline', sub: 'all', search: NAME, all: '1' }, scope: 'view' });
      check('E5 CSV export of Requirement applications has the Joining date column and "Not recorded" / the planned day', csv.status === 200 && /Joining date/.test(csv.text) && /Not recorded/.test(csv.text) && /1 Nov 2026 \(planned\)/.test(csv.text), csv.text.split(/\r?\n/).slice(0, 2));
      // BDE team: the export has the Joining date column but no phone / email / salary columns, and no contact values
      const bx = await http('POST', '/api/ats-io/export/candidates?format=csv', TB, { view: 'pipeline-all', params: { paged: '1', view: 'pipeline', sub: 'all', search: NAME, all: '1' }, scope: 'view' });
      const bhead = (bx.text.split(/\r?\n/).find((l) => /Candidate/.test(l)) || '');
      check('E6 the BDE team\'s export (if their role may export) has Joining date but no Phone / Email / salary column and no fixture phone or email', bx.status === 403 || (/Joining date/.test(bhead) && !/Phone|Email|salary/i.test(bhead) && !/zz-jdt|91003/.test(bx.text)), [bx.status, bhead.slice(0, 300)]);
    }

    // =============================================================== M: masking and refusal
    {
      const b = await http('GET', `/api/candidates?${qs({ paged: '1', view: 'pipeline', sub: 'all', search: NAME, pageSize: '100' })}`, TB);
      const brows = (b.body && b.body.rows) || [];
      check('M1 the BDE team sees the joined fixtures of its client with the joining day', b.status === 200 && brows.some((x) => x.id === aTyped.id && x.joiningDay === '2026-10-12'), [b.status, brows.length]);
      check('M2 ... and still no phone, email or salary on any row (unchanged)', brows.length > 0 && brows.every((x) => !x.phone && !x.email && !x.currentSalary && !x.expectedSalary), brows.slice(0, 1).map((x) => [x.phone, x.email, x.currentSalary, x.expectedSalary]));
      const bm = await http('GET', `/api/candidates?${qs({ paged: '1', view: 'master', sub: 'all', search: NAME, pageSize: '100' })}`, TB);
      const bmr = (bm.body && bm.body.rows) || [];
      check('M3 People list for the BDE team: joining day present, no phone / email / salary (unchanged)', bm.status === 200 && bmr.some((x) => x.joiningDay === '2026-10-12') && bmr.every((x) => !x.phone && !x.email && !x.currentSalary), [bm.status, bmr.length, bmr[0] && [bmr[0].phone, bmr[0].email]]);
      const n1 = await http('GET', `/api/candidates?${qs({ paged: '1', view: 'master', sub: 'all', pageSize: '25' })}`, TN);
      const n2 = await http('GET', `/api/candidates?${qs({ paged: '1', view: 'pipeline', sub: 'joined', pageSize: '25' })}`, TN);
      check('M4 a login without ATS access is still refused (People and Requirement applications)', [401, 403].includes(n1.status) && [401, 403].includes(n2.status), [n1.status, n2.status]);
    }

    // =============================================================== D: the profile and the board
    {
      const d = await http('GET', `/api/candidates/${P.typed.id}`, TA);
      const dapp = d.body && (d.body.applications || []).find((x) => x.id === aTyped.id);
      check('D1 the profile carries joiningDay on the joined application (12 Oct 2026)', d.status === 200 && dapp && dapp.joiningDay === '2026-10-12', [d.status, dapp && dapp.joiningDay]);
      const d2 = await http('GET', `/api/candidates/${P.move.id}`, TA);
      const d2a = d2.body && (d2.body.applications || [])[0];
      check('D2 ... the move-into-Joined fallback works there too (1 Oct)', d2a && d2a.joiningDay === '2026-10-01', d2a && d2a.joiningDay);
      const d3 = await http('GET', `/api/candidates/${P.none.id}`, TA);
      const d3a = d3.body && (d3.body.applications || [])[0];
      check('D3 ... and "Not recorded" is null, never today', d3a && d3a.joiningDay === null, d3a && d3a.joiningDay);
      const d4 = await http('GET', `/api/candidates/${P.multiA.id}`, TA);
      const d4a = d4.body && (d4.body.applications || []);
      check('D4 a multi-application profile: the joined application carries its day, the other carries none', d4a && d4a.find((x) => x.id === aMA1.id).joiningDay === '2026-10-05' && d4a.find((x) => x.id === aMA2.id).joiningDay === undefined, d4a && d4a.map((x) => [x.stage, x.joiningDay]));
      const bd = await http('GET', `/api/candidates/board?${qs({ search: NAME, perColumn: '100' })}`, TA);
      const jcol = bd.body && (bd.body.columns || []).find((c) => c.key === 'joined');
      const card = (id) => jcol && jcol.cards.find((x) => x.id === id);
      check('D5 Progress board: Joined cards carry the day (12 Oct), and "null" when none is on file', bd.status === 200 && card(aTyped.id) && card(aTyped.id).joiningDay === '2026-10-12' && card(aNone.id) && card(aNone.id).joiningDay === null, [bd.status, card(aTyped.id) && card(aTyped.id).joiningDay]);
      const other = bd.body && (bd.body.columns || []).filter((c) => c.key !== 'joined').flatMap((c) => c.cards);
      check('D6 ... cards of other steps carry no joining field', other.every((x) => x.joiningDay === undefined), other.find((x) => x.joiningDay !== undefined));
    }

    // =============================================================== C: the cache follows the data
    {
      await prisma.application.update({ where: { id: aTyped.id }, data: { joiningDate: '2026-10-18' } });
      let r = await listPeople(TA, { search: `${NAME} typed` });
      check('C1 a changed joining date shows on the very next read (People)', r.body.rows[0] && r.body.rows[0].joiningDay === '2026-10-18', r.body.rows[0] && r.body.rows[0].joiningDay);
      let r2 = await http('GET', `/api/candidates?${qs({ paged: '1', view: 'pipeline', sub: 'all', search: `${NAME} typed`, pageSize: '10' })}`, TA);
      check('C2 ... and in Requirement applications', r2.body.rows[0] && r2.body.rows[0].joiningDay === '2026-10-18', r2.body.rows[0] && r2.body.rows[0].joiningDay);
      await prisma.application.update({ where: { id: aTyped.id }, data: { joiningDate: null, joinedAt: null } });
      r = await listPeople(TA, { search: `${NAME} typed` });
      check('C3 a removed joining date goes back to Not recorded (null) at once', r.body.rows[0] && r.body.rows[0].joiningDay === null, r.body.rows[0] && r.body.rows[0].joiningDay);
      await prisma.application.update({ where: { id: aPlanned.id }, data: { stage: 'JOINED', joiningDate: '2026-10-21' } });
      r = await listPeople(TA, { search: `${NAME} planned` });
      check('C4 a person who just moved into Joined shows the typed day at once', r.body.rows[0] && r.body.rows[0].joiningDay === '2026-10-21' && r.body.rows[0].currentStage === 'JOINED', r.body.rows[0] && [r.body.rows[0].currentStage, r.body.rows[0].joiningDay]);
    }
  } finally {
    // clean every ZZTEST row (copy database only)
    try {
      const reqIds = (await prisma.requirement.findMany({ where: { OR: [{ id: { in: made.reqs } }, { title: { contains: NAME } }] }, select: { id: true } })).map((r) => r.id);
      const candIds = (await prisma.candidate.findMany({ where: { OR: [{ id: { in: made.cands } }, { name: { contains: NAME } }] }, select: { id: true } })).map((r) => r.id);
      const appIds = (await prisma.application.findMany({ where: { OR: [{ id: { in: made.apps } }, { requirementId: { in: reqIds } }, { candidateId: { in: candIds } }] }, select: { id: true } })).map((r) => r.id);
      await prisma.applicationFollowUp.deleteMany({ where: { applicationId: { in: appIds } } }).catch(() => {});
      await prisma.applicationStageEvent.deleteMany({ where: { applicationId: { in: appIds } } }).catch(() => {});
      await prisma.application.deleteMany({ where: { id: { in: appIds } } }).catch(() => {});
      await prisma.candidate.deleteMany({ where: { id: { in: candIds } } }).catch(() => {});
      await prisma.requirement.deleteMany({ where: { id: { in: reqIds } } }).catch(() => {});
      const clientIds = (await prisma.client.findMany({ where: { OR: [{ id: { in: made.clients } }, { name: { contains: NAME } }] }, select: { id: true } })).map((r) => r.id);
      await prisma.client.deleteMany({ where: { id: { in: clientIds } } }).catch(() => {});
      const userIds = (await prisma.user.findMany({ where: { OR: [{ id: { in: made.users } }, { name: { contains: NAME } }] }, select: { id: true } })).map((r) => r.id);
      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { entityId: { in: [...appIds, ...candIds, ...reqIds, ...clientIds] } }] } }).catch(() => {});
      await prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
      await prisma.employee.deleteMany({ where: { OR: [{ id: { in: made.emps } }, { userId: { in: userIds } }] } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
      const left = {
        users: await prisma.user.count({ where: { name: { contains: NAME } } }),
        cands: await prisma.candidate.count({ where: { name: { contains: NAME } } }),
        reqs: await prisma.requirement.count({ where: { title: { contains: NAME } } }),
        clients: await prisma.client.count({ where: { name: { contains: NAME } } }),
        apps: await prisma.application.count({ where: { id: { in: appIds } } }),
      };
      check('Z every ZZTEST row is removed', Object.values(left).every((n) => n === 0), left);
    } catch (e) { check('Z clean-up ran', false, e.message); }
    if (server) server.kill();
    await prisma.$disconnect().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
