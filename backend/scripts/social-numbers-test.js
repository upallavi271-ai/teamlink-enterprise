#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SOCIAL MEDIA ACCOUNTS - META NUMBERS LABEL + FILTER (founder 2026-11-20) - COPY DATABASE ONLY.
//
//   cd backend
//   node scripts/social-numbers-test.js    makes its own VACUUM INTO copy of prisma/dev.db (or prisma/sandbox.db when there is no dev.db; opened
//                                          READ-ONLY) in the temp folder, starts a throw-away API on it (port 4099, TEST_MODE) and deletes both
//
// "Social media connected accounts: which accounts to assign to which Meta numbers, all the options." Like the departments it is a LABEL and a
// FILTER only. Proved over /api/admin/social-accounts on a copy of the data, with made-up accounts (and made-up Meta numbers when the copy has fewer
// than three) added to the copy:
//   G  reading: the list carries every Meta number (id, label, number, portfolio, active, departments, no secret); every account lists "numberIds"
//      (empty on old rows)
//   N  the label: the Super Admin saves it, de-duplicated and trimmed, in the order picked; a number that is not in the list is refused (400);
//      clearing makes the account "not assigned"; the same value again writes nothing
//   P  a Facebook Page takes its Instagram account along (default, off when asked); other Pages / platforms are untouched
//   D  independent of the departments: setting one never changes the other, and the department route still works
//   X  nothing else changed: default flag, token (never sent to a screen), name, status; a number removed from the list later keeps its id on the
//      account (the screen shows "Removed number") and can be unticked, but not picked again
//   A  an audit row says who changed what; the same value again writes none
//   S  only the Super Admin: an ordinary login 403, no login 401
//   B  bad input: unknown account 404, not a list / not text 400, and nothing changes
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const REAL = [path.join(BACK, 'prisma', 'dev.db'), path.join(BACK, 'prisma', 'sandbox.db')].find((p) => fs.existsSync(p));
if (!REAL) { console.error('no prisma/dev.db or prisma/sandbox.db to copy'); process.exit(2); }
const copy = path.join(os.tmpdir(), `socnum-${Date.now().toString(36)}.db`);
{
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(REAL, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.split(path.sep).join('/').replace(/'/g, "''")}'`);
  src.close();
}
const PORT = Number(process.env.TEST_PORT || 4099);
if (PORT === 4010) process.exit(2);
const API = `http://127.0.0.1:${PORT}`;
const DB_URL = `file:${path.resolve(copy).split(path.sep).join('/')}?socket_timeout=60`;
process.env.DATABASE_URL = DB_URL;
process.env.TEST_MODE = '1';
process.env.TEAMLINK_SANDBOX = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = DB_URL;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const { DDL } = require(path.join(BACK, 'src/utils/waNumbers'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 300)}` : ''}`); };
const RUN = Date.now().toString(36);
const FAKE_TOKEN = `ZZ-NOT-A-REAL-TOKEN-${RUN}`;

async function http(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
const mkUser = async (tag, role) => {
  const u = await prisma.user.create({ data: { passwordHash: 'x', name: `ZZTEST SN ${tag} ${RUN}`, email: `zz-sn-${tag}-${RUN}@example.test`, username: `zz-sn-${tag}-${RUN}@example.test`, role, hrmsRole: role, atsRole: ['SUPER_ADMIN', 'ADMIN'].includes(role) ? role : 'NONE', accountsRole: 'NONE', hrmsAccess: true, accountsAccess: false, atsAccess: ['SUPER_ADMIN', 'ADMIN'].includes(role), status: 'Active' } });
  return { u, t: jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' }) };
};
const readStored = async () => { const row = await prisma.appSetting.findUnique({ where: { key: 'social.accounts' } }); return row ? JSON.parse(row.value) : []; };
const all = (res) => { const o = (res.body && res.body.accounts) || {}; return Object.values(o).flat(); };
const byId = (res, id) => all(res).find((a) => a.id === id);

let server = null;
(async () => {
  try {
    // ---- the copy: made-up Meta numbers when it has fewer than three, and made-up accounts ---------------------------------------
    for (const sql of DDL) await prisma.$executeRawUnsafe(sql); // eslint-disable-line no-await-in-loop
    const have = await prisma.$queryRawUnsafe('SELECT "id" FROM "WaNumber" WHERE "removedAt" IS NULL');
    const madeNumbers = [];
    for (let i = have.length; i < 3; i += 1) {
      const id = `zz-wan-${i}-${RUN}`;
      const now = new Date().toISOString();
      await prisma.$executeRawUnsafe('INSERT INTO "WaNumber" ("id","label","displayNumber","displayDigits","phoneNumberId","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?)', id, `ZZ Number ${i}`, `+9199000000${i}0`, `9199000000${i}0`, `zz-phone-${i}-${RUN}`, now, now);
      madeNumbers.push(id);
    }
    console.log(`     Meta numbers in the copy: ${have.length} real + ${madeNumbers.length} made-up`);
    const mk = (platform, externalId, name, extra = {}) => ({ id: `zz-${platform}-${externalId}-${RUN}`, platform, externalId, name, tokenEnc: FAKE_TOKEN, isDefault: false, status: 'Connected', connectedAt: new Date().toISOString(), connectedByName: 'ZZ test', ...extra });
    const pageA = mk('facebook', 'ZZ-FB-A', 'ZZ Page A');
    const pageB = mk('facebook', 'ZZ-FB-B', 'ZZ Page B');
    const igA = mk('instagram', 'ZZ-IG-A', 'ZZ Insta A', { username: 'zz_insta_a', parentId: 'ZZ-FB-A', parentName: 'ZZ Page A' });
    const igB = mk('instagram', 'ZZ-IG-B', 'ZZ Insta B', { username: 'zz_insta_b', parentId: 'ZZ-FB-B', parentName: 'ZZ Page B' });
    const thr = mk('threads', 'ZZ-TH-1', 'ZZ Threads', { username: 'zz_threads' });
    const xx = mk('x', 'ZZ-X-1', 'ZZ X account');
    const existing = await readStored();
    const mine = [pageA, pageB, igA, igB, thr, xx];
    const value = JSON.stringify([...existing, ...mine]);
    await prisma.appSetting.upsert({ where: { key: 'social.accounts' }, update: { value }, create: { key: 'social.accounts', value } });

    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 120 && !healthy; i += 1) {
      try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }

    const sup = await mkUser('super', 'SUPER_ADMIN');
    const staff = await mkUser('staff', 'EMPLOYEE');
    const URL = '/api/admin/social-accounts';

    // ---- G: reading ---------------------------------------------------------------------------------------------------------
    const g0 = await http('GET', URL, sup.t);
    const nums = (g0.body && g0.body.numbers) || [];
    check('G1 the Super Admin reads the list (200) and it carries the Meta numbers', g0.status === 200 && Array.isArray(g0.body.numbers) && nums.length >= 3, [g0.status, nums.length]);
    check('G2 every number has an id, a label, a number, "active" and its departments', nums.every((n) => n.id && n.label && typeof n.displayNumber === 'string' && typeof n.active === 'boolean' && Array.isArray(n.departments)), nums[0]);
    check('G3 no secret about a number is sent (no token, secret or phone-number id)', !/token|secret|phoneNumberId|verify/i.test(JSON.stringify(nums)), JSON.stringify(nums[0]));
    check('G4 old rows (no "numberIds" field) show an empty list, so "Not assigned"', mine.every((m) => Array.isArray(byId(g0, m.id).numberIds) && byId(g0, m.id).numberIds.length === 0));
    check('G5 no account token is ever in the answer', !g0.text.includes(FAKE_TOKEN) && !/tokenEnc/.test(g0.text));
    console.log(`     numbers offered: ${nums.map((n) => n.label).join(' | ')}`);

    // ---- N / P: saving ------------------------------------------------------------------------------------------------------
    const [n1, n2] = [nums[0].id, nums[1].id];
    const auditBefore = await prisma.auditLog.count({ where: { entity: 'Integration', entityId: 'social', action: 'Social account Meta numbers set' } });
    const storedBefore = await readStored();
    const s1 = await http('POST', `${URL}/${pageA.id}/numbers`, sup.t, { numberIds: [` ${n1} `, n2, n1, ''] });
    check('N1 the Super Admin saves numbers for a Page (200) and the message names them', s1.status === 200 && s1.body && /ZZ Page A is given to/.test(s1.body.message || '') && s1.body.message.includes(nums[0].label), [s1.status, s1.text.slice(0, 300)]);
    check('N2 trimmed, de-duplicated, blanks dropped, in the order picked', JSON.stringify(byId(s1, pageA.id).numberIds) === JSON.stringify([n1, n2]), byId(s1, pageA.id).numberIds);
    check('P1 its Instagram account took the same numbers along (default)', JSON.stringify(byId(s1, igA.id).numberIds) === JSON.stringify([n1, n2]), byId(s1, igA.id).numberIds);
    check('P2 another Page, its Instagram account, Threads and X are untouched', [pageB, igB, thr, xx].every((a) => byId(s1, a.id).numberIds.length === 0));
    const stored = await readStored();
    const sA = stored.find((a) => a.id === pageA.id);
    const sBefore = storedBefore.find((a) => a.id === pageA.id);
    check('X1 default flag, token, status, name and departments are unchanged', sA.isDefault === sBefore.isDefault && sA.tokenEnc === sBefore.tokenEnc && sA.status === sBefore.status && sA.name === sBefore.name && JSON.stringify(sA.departments || []) === JSON.stringify(sBefore.departments || []), sA);
    check('X2 every other stored account is byte-for-byte the same', stored.filter((a) => ![pageA.id, igA.id].includes(a.id)).every((a) => JSON.stringify(a) === JSON.stringify(storedBefore.find((b) => b.id === a.id))));
    check('X3 the answer never contains the token', !s1.text.includes(FAKE_TOKEN) && !/tokenEnc/.test(s1.text));

    // ---- A: audit -----------------------------------------------------------------------------------------------------------
    const aud = await prisma.auditLog.findMany({ where: { entity: 'Integration', entityId: 'social', action: 'Social account Meta numbers set' }, orderBy: { createdAt: 'desc' }, take: 1 });
    check('A1 an audit row says who gave which account to which numbers', (await prisma.auditLog.count({ where: { entity: 'Integration', entityId: 'social', action: 'Social account Meta numbers set' } })) === auditBefore + 1 && aud[0].userId === sup.u.id && /ZZ Page A/.test(aud[0].toValue || '') && (aud[0].toValue || '').includes(nums[0].label), aud[0]);
    const s1b = await http('POST', `${URL}/${pageA.id}/numbers`, sup.t, { numberIds: [n2, n1] });
    check('N3 the same numbers again (any order) is fine and writes nothing', s1b.status === 200 && JSON.stringify((await readStored()).find((a) => a.id === pageA.id)) === JSON.stringify(sA));
    check('A2 and no audit row is written for it', (await prisma.auditLog.count({ where: { entity: 'Integration', entityId: 'social', action: 'Social account Meta numbers set' } })) === auditBefore + 1);

    // ---- P: Instagram off, then D: departments are independent --------------------------------------------------------------
    const s2 = await http('POST', `${URL}/${pageB.id}/numbers`, sup.t, { numberIds: [n1], withInstagram: false });
    check('P3 withInstagram=false gives the Page only', s2.status === 200 && JSON.stringify(byId(s2, pageB.id).numberIds) === JSON.stringify([n1]) && byId(s2, igB.id).numberIds.length === 0, [byId(s2, pageB.id).numberIds, byId(s2, igB.id).numberIds]);
    const d1 = await http('POST', `${URL}/${pageA.id}/departments`, sup.t, { departments: ['ZZ Dept One'] });
    check('D1 the department route still works, and saving a department leaves the numbers alone', d1.status === 200 && JSON.stringify(byId(d1, pageA.id).numberIds) === JSON.stringify([n1, n2]) && JSON.stringify(byId(d1, pageA.id).departments) === JSON.stringify(['ZZ Dept One']), byId(d1, pageA.id));
    const s3 = await http('POST', `${URL}/${pageA.id}/numbers`, sup.t, { numberIds: [n2] });
    check('D2 saving numbers leaves the departments alone', s3.status === 200 && JSON.stringify(byId(s3, pageA.id).departments) === JSON.stringify(['ZZ Dept One']) && JSON.stringify(byId(s3, pageA.id).numberIds) === JSON.stringify([n2]));

    // ---- a number removed from the list later -------------------------------------------------------------------------------
    const gone = nums[2].id;
    await http('POST', `${URL}/${thr.id}/numbers`, sup.t, { numberIds: [gone, n1] });
    await prisma.$executeRawUnsafe('UPDATE "WaNumber" SET "removedAt" = ? WHERE "id" = ?', new Date().toISOString(), gone);
    // the number list is cached for up to 30 s inside the API process: wait it out so the answer is the real one
    let g1 = null;
    for (let i = 0; i < 40; i += 1) { g1 = await http('GET', URL, sup.t); if (!(g1.body.numbers || []).some((n) => n.id === gone)) break; await new Promise((r) => setTimeout(r, 1000)); }
    check('X4 a removed number is no longer offered, but the account keeps its id (the screen says "Removed number")', !(g1.body.numbers || []).some((n) => n.id === gone) && byId(g1, thr.id).numberIds.includes(gone), [byId(g1, thr.id).numberIds]);
    const s4 = await http('POST', `${URL}/${thr.id}/numbers`, sup.t, { numberIds: [gone, n1] });
    check('X5 it cannot be picked again (400)', s4.status === 400, [s4.status, s4.text.slice(0, 200)]);
    const s5 = await http('POST', `${URL}/${thr.id}/numbers`, sup.t, { numberIds: [n1] });
    check('X6 but the account can drop it by saving without it', s5.status === 200 && JSON.stringify(byId(s5, thr.id).numberIds) === JSON.stringify([n1]));

    // ---- N: clearing --------------------------------------------------------------------------------------------------------
    const c1 = await http('POST', `${URL}/${pageA.id}/numbers`, sup.t, { numberIds: [] });
    check('N4 clearing makes the Page and its Instagram account "not assigned" (and the message says so)', c1.status === 200 && byId(c1, pageA.id).numberIds.length === 0 && byId(c1, igA.id).numberIds.length === 0 && /not given to any Meta number/.test(c1.body.message || ''), [c1.status, c1.text.slice(0, 200)]);

    // ---- S: who may ---------------------------------------------------------------------------------------------------------
    const p1 = await http('POST', `${URL}/${pageA.id}/numbers`, staff.t, { numberIds: [n1] });
    check('S1 an ordinary login is refused (403)', p1.status === 403, p1.status);
    const p2 = await http('POST', `${URL}/${pageA.id}/numbers`, null, { numberIds: [n1] });
    check('S2 no login is 401', p2.status === 401, p2.status);
    check('S3 and neither changed anything', (await readStored()).find((a) => a.id === pageA.id).numberIds.length === 0);

    // ---- B: bad input -------------------------------------------------------------------------------------------------------
    const b1 = await http('POST', `${URL}/does-not-exist/numbers`, sup.t, { numberIds: [n1] });
    check('B1 an unknown account is 404', b1.status === 404, b1.status);
    const b2 = await http('POST', `${URL}/${pageA.id}/numbers`, sup.t, { numberIds: 'all' });
    check('B2 numbers that are not a list are 400', b2.status === 400, b2.status);
    const b3 = await http('POST', `${URL}/${pageA.id}/numbers`, sup.t, { numberIds: [n1, 42] });
    check('B3 a number that is not text is 400', b3.status === 400, b3.status);
    const b4 = await http('POST', `${URL}/${pageA.id}/numbers`, sup.t, { numberIds: [n1, 'not-a-number-id'] });
    check('B4 a number that is not in the list is 400', b4.status === 400, [b4.status, b4.text.slice(0, 200)]);
    const b5 = await http('POST', `${URL}/${pageA.id}/numbers`, sup.t, {});
    check('B5 no body is 400', b5.status === 400, b5.status);
    check('B6 none of the bad requests changed anything', (await readStored()).find((a) => a.id === pageA.id).numberIds.length === 0);

    // ---- the rest of the screen's API still answers ---------------------------------------------------------------------
    const g9 = await http('GET', URL, sup.t);
    check('M1 the list still loads and still lists every account (real + made-up)', g9.status === 200 && all(g9).length === existing.length + mine.length, [g9.status, all(g9).length, existing.length + mine.length]);
  } catch (err) {
    fail += 1;
    console.error('ERROR', err);
  } finally {
    if (server) server.kill();
    await prisma.$disconnect().catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    [copy, `${copy}-wal`, `${copy}-shm`, `${copy}-journal`].forEach((f) => { try { fs.unlinkSync(f); } catch { /* gone */ } });
    console.log(`\n${pass} passed, ${fail} failed (the copy database is deleted; the real database was only read)`);
    process.exit(fail ? 1 : 0);
  }
})();
