#!/usr/bin/env node
// ---------------------------------------------------------------------------
// OMNI-CHANNEL WORKSPACE NAMES (utils/omniWsNames.js + omniDeptLogins.run, founder 2026-11-17) - COPY DATABASE ONLY, NO REAL GREEN START.
//
//   cd backend
//   node scripts/omni-ws-names-test.js     makes its own VACUUM INTO copy of prisma/dev.db (opened READ-ONLY) in the temp folder, replaces
//                                          Green Start by an in-memory stand-in (nothing leaves this process) and deletes the copy after
// Proves:
//   A  names: "<Meta name> · <Dept> dept" with a Meta name, "Teamlink <Dept>" without; "- 2" for a repeat; deptOfName reads every form back
//      (the ad-lead, AI-call and imported-number code relies on it)
//   B  the run: the Medical workspace is renamed to its number's Meta name + department; Education (no Meta name yet) keeps its name;
//      a second Medical number and a Manufacturing number get NEW workspaces named that way; a hand-pinned workspace is never renamed
//   C  a second run changes nothing; a new Meta name renames again; two numbers with one Meta name get "- 2"
//   D  a refused rename (no permission) is told in words, the name stays, and the department logins still come out ready
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const REAL = path.resolve(BACK, 'prisma', 'dev.db');
const copy = path.join(os.tmpdir(), `omniws-${Date.now().toString(36)}.db`);
{
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(REAL, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.split(path.sep).join('/').replace(/'/g, "''")}'`);
  src.close();
}
const DB_URL = `file:${path.resolve(copy).split(path.sep).join('/')}?socket_timeout=60`;
process.env.DATABASE_URL = DB_URL;
process.env.TEST_MODE = '1';
process.env.TEAMLINK_SANDBOX = '1';
const prisma = require(path.join(BACK, 'src/db'));
const W = require(path.join(BACK, 'src/utils/omniWsNames'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 600)}` : ''}`); };
const eq = (n, got, want) => check(n, JSON.stringify(got) === JSON.stringify(want), { got, want });

(async () => {
  try {
    // ---- A. names (pure) -----------------------------------------------------------------------------------------------
    eq('A1 with a Meta name: "<Meta> · <Dept> dept"', W.nameFor({ dept: 'medical', meta: 'Nonit Consultants' }), 'Nonit Consultants · Medical dept');
    eq('A2 no Meta name yet: the name used until now', W.nameFor({ dept: 'medical' }), 'Teamlink Medical');
    eq('A3 a repeat gets "- 2"', [W.nameFor({ dept: 'Medical', meta: 'X Co', index: 2 }), W.nameFor({ dept: 'Medical', index: 3 })], ['X Co · Medical dept - 2', 'Teamlink Medical - 3']);
    eq('A4 short department names stay capitals (BDE, HR)', [W.nameFor({ dept: 'bde' }), W.nameFor({ dept: 'hr', meta: 'Acme' })], ['Teamlink BDE', 'Acme · HR dept']);
    eq('A5 a "·" inside a Meta name cannot break the name', W.nameFor({ dept: 'Medical', meta: 'A · B' }), 'A - B · Medical dept');
    const back = (n) => W.deptOfName(n);
    eq('A6 deptOfName reads every form', [back('Teamlink Medical'), back('Teamlink Education - 2'), back('Nonit Consultants · Medical dept'), back('Nonit Consultants · Medical dept - 2'), back('Teamlink Non IT Medical')],
      ['Medical', 'Education', 'Medical', 'Medical', 'Non IT Medical']);
    eq('A7 a name outside the convention has no department', [back('Main workspace'), back('Sales Desk'), back(''), back(null)], [null, null, null, null]);
    eq('A8 belongs(): the convention and the older looser names', [W.belongs('Teamlink Medical', 'Medical'), W.belongs('X · Medical dept', 'medical'), W.belongs('Medical', 'Medical'), W.belongs('Acme Medical', 'Medical'), W.belongs('Teamlink Education', 'Medical')], [true, true, true, true, false]);

    // ---- B-D. omniDeptLogins.run against an in-memory Green Start --------------------------------------------------------
    const O = require(path.join(BACK, 'src/utils/rcsOmniSync'));
    const GSI = require(path.join(BACK, 'src/utils/greenStartIntegrations'));
    const SSO = require(path.join(BACK, 'src/utils/greenStartSso'));
    const D = require(path.join(BACK, 'src/utils/omniDeptLogins'));
    const COMPANY = 'company@example.test';
    SSO.ssoEmail = async () => COMPANY;
    let gs = [
      { id: 'ws-main', name: 'Main', orgId: 'org1' }, { id: 'ws-med', name: 'Teamlink Medical', orgId: 'org1' },
      { id: 'ws-edu', name: 'Teamlink Education', orgId: 'org1' }, { id: 'ws-hand', name: 'Sales Desk', orgId: 'org1' },
    ];
    let calls = []; let members = {}; let patchFails = false;
    O.signIn = async () => 'tok';
    O.workspacesOf = async () => gs.map((w) => ({ id: w.id, name: w.name, orgId: w.orgId }));
    O.call = async (method, p, { ws, body } = {}) => {
      calls.push(`${method} ${p}`);
      if (method === 'POST' && p === '/workspaces') { const w = { id: `ws-new-${gs.length}`, name: body.name, orgId: body.organizationId }; gs.push(w); return { id: w.id, name: w.name }; }
      if (method === 'PATCH' && /^\/workspaces\//.test(p)) {
        if (patchFails) { const e = new Error('You may not edit this organisation.'); e.status = 403; throw e; }
        const w = gs.find((x) => p.endsWith(x.id)); w.name = body.name; return w;
      }
      if (method === 'POST' && p === '/team/roles/standard') return {};
      if (method === 'GET' && p.startsWith('/team/members')) return { items: members[ws] || [] };
      if (method === 'POST' && p === '/team/members') { (members[ws] = members[ws] || []).push({ id: `m-${ws}-${(members[ws] || []).length}`, email: body.email, roleKey: body.roleKey }); return {}; }
      if (method === 'DELETE' && p.startsWith('/team/members/')) { Object.keys(members).forEach((k) => { members[k] = members[k].filter((m) => !p.endsWith(m.id)); }); return {}; }
      throw new Error(`unexpected Green Start call ${method} ${p}`);
    };
    let nums = [];
    GSI.waMapView = async () => ({ numbers: nums, workspaces: [], map: {} });
    const num = (id, label, dept, verifiedName) => ({ id, label, display: `+91 99999 0000${id.length}`, verifiedName, isDefault: false, departments: dept ? [dept] : [], ready: true, problem: null });
    const setting = async (k, v) => prisma.appSetting.upsert({ where: { key: k }, create: { key: k, value: JSON.stringify(v) }, update: { value: JSON.stringify(v) } });
    const readMap = async () => JSON.parse((await prisma.appSetting.findUnique({ where: { key: 'omni.gs.waMap' } })).value);
    await prisma.appSetting.deleteMany({ where: { key: { in: ['omni.gs.waMap', D.KEY] } } });
    // the Super Admin pinned the Sales number to "Sales Desk" by hand
    await setting('omni.gs.waMap', { n5: { workspaceId: 'ws-hand', auto: false } });
    nums = [
      num('n1', 'WA Med', 'Medical', 'Nonit Consultants'), num('n2', 'WA Edu', 'Education', ''), num('n3', 'WA Med2', 'Medical', 'Nonit Hospitals'),
      num('n4', 'WA Man', 'Manufacturing', 'Nonit Mfg'), num('n5', 'WA Sales', 'Sales', 'Zed Sales'),
    ];
    const names = () => Object.fromEntries(gs.map((w) => [w.id, w.name]));

    const r1 = await D.run({ why: 'test', pushChannels: false });
    const map1 = await readMap();
    const nameOf = (nid) => (gs.find((w) => w.id === map1[nid].workspaceId) || {}).name;
    check('B1 Medical\'s workspace is renamed to its number\'s Meta name + department', names()['ws-med'] === 'Nonit Consultants · Medical dept' && calls.includes('PATCH /workspaces/ws-med'), names());
    check('B2 Education (Meta has not given a name) keeps "Teamlink Education"', names()['ws-edu'] === 'Teamlink Education' && !calls.includes('PATCH /workspaces/ws-edu'), names());
    check('B3 a second Medical number gets its OWN new workspace named after its Meta name', nameOf('n3') === 'Nonit Hospitals · Medical dept' && map1.n3.workspaceId !== map1.n1.workspaceId, [nameOf('n3'), map1]);
    check('B4 a Manufacturing number gets a new workspace named after its Meta name', nameOf('n4') === 'Nonit Mfg · Manufacturing dept', nameOf('n4'));
    check('B5 a number pinned by hand keeps its workspace and its name ("Sales Desk")', names()['ws-hand'] === 'Sales Desk' && map1.n5.workspaceId === 'ws-hand' && map1.n5.auto === false, [names(), map1.n5]);
    check('B6 the map holds each number\'s workspace (n1 = the old Medical workspace, renamed in place)', map1.n1.workspaceId === 'ws-med' && map1.n2.workspaceId === 'ws-edu' && map1.n1.auto === true && map1.n1.dept === 'Medical', map1);
    const rows1 = r1.departments.filter((x) => x.state === 'ready');
    check('B7 the department logins are ready and name the NEW workspace names', rows1.some((x) => x.dept === 'Medical' && /Nonit Consultants · Medical dept/.test(x.workspace) && /Nonit Hospitals · Medical dept/.test(x.workspace)), r1.departments);
    check('B8 the result tells what was renamed', Array.isArray(r1.renamed) && r1.renamed.length === 1 && r1.renamed[0].from === 'Teamlink Medical' && /name now show the Meta name/.test(r1.words), [r1.renamed, r1.words]);
    const saved = JSON.parse((await prisma.appSetting.findUnique({ where: { key: D.KEY } })).value);
    check('B9 the last run is kept with the rename', saved.last && saved.last.renamed && saved.last.renamed.length === 1, saved.last && saved.last.renamed);

    // C. a second run changes nothing
    const before = JSON.stringify(names()); calls = [];
    await D.run({ why: 'again', pushChannels: false });
    check('C1 a second run changes no name and makes / renames nothing', JSON.stringify(names()) === before && !calls.some((c) => c === 'POST /workspaces' || c.startsWith('PATCH /workspaces')), calls.filter((c) => /workspaces/.test(c)));
    // a new Meta name -> renamed again
    nums[0] = num('n1', 'WA Med', 'Medical', 'Nonit Medical Group'); calls = [];
    await D.run({ why: 'meta renamed', pushChannels: false });
    check('C2 when Meta shows a new name, the workspace follows it', names()['ws-med'] === 'Nonit Medical Group · Medical dept', names());
    // a number whose Meta name is the same as another's in the department -> "- 2"
    nums[2] = num('n3', 'WA Med2', 'Medical', 'Nonit Medical Group'); calls = [];
    await D.run({ why: 'same meta name', pushChannels: false });
    const n3ws = (await readMap()).n3.workspaceId;
    check('C3 two numbers with the same Meta name get "- 2" on the later one, never the same name twice', gs.find((w) => w.id === n3ws).name === 'Nonit Medical Group · Medical dept - 2' && new Set(gs.map((w) => w.name.toLowerCase())).size === gs.length, names());

    // D. the Meta name changes but Omni-Channel refuses the rename
    nums[3] = num('n4', 'WA Man', 'Manufacturing', 'Nonit Manufacturing Plant'); patchFails = true;
    const r4 = await D.run({ why: 'refused', pushChannels: false });
    const n4ws = (await readMap()).n4.workspaceId;
    check('D1 a refused rename keeps the name and says so in words', gs.find((w) => w.id === n4ws).name === 'Nonit Mfg · Manufacturing dept' && /could not be changed/.test(r4.words), [r4.words, names()]);
    check('D2 the department logins still come out ready', r4.departments.filter((x) => x.state === 'ready').length >= 3 && r4.departments.every((x) => x.state === 'ready'), r4.departments.map((x) => `${x.dept}:${x.state}`));
    patchFails = false;
  } catch (err) {
    fail += 1;
    console.error('ERROR', err);
  } finally {
    await prisma.$disconnect().catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
    [copy, `${copy}-wal`, `${copy}-shm`, `${copy}-journal`].forEach((f) => { try { fs.unlinkSync(f); } catch { /* gone */ } });
    console.log(`\n${pass} passed, ${fail} failed (the copy database is deleted; prisma/dev.db was only read)`);
    process.exit(fail ? 1 : 0);
  }
})();
