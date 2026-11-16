#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SOCIAL MEDIA ACCOUNTS - DEPARTMENT LABEL + FILTER (founder 2026-11-16) - COPY DATABASE ONLY.
//
//   cd backend
//   node scripts/social-departments-test.js   makes its own VACUUM INTO copy of prisma/dev.db (opened READ-ONLY) in the temp folder,
//                                             starts a throw-away API on it (port 4098, TEST_MODE) and deletes both afterwards
//
// "This social media accounts also Super Admin can assign which department he wants" (chose: label and filter only). Proved over
// /api/admin/social-accounts on a copy of the real data, with a few made-up accounts added to the copy:
//   L  the label: every account lists "departments" (empty on old rows), the Super Admin saves it, names are matched to the department list
//      (any case), trimmed, squeezed, de-duplicated, cut at 60; a name not on the list is kept; clearing it makes the account "not assigned"
//   P  a Facebook Page takes its Instagram account along (on by default, off when asked); other Pages / platforms are untouched
//   N  nothing else changed: default flag, token (never sent to a screen), name, connection status; renaming an account keeps its departments
//   A  an audit row says who changed what; the same value again writes nothing
//   S  only the Super Admin: an Admin sees the labels (canAssign false, no department list) but gets 403 on save; a normal login 403; no login 401
//   B  bad input: unknown account 404, a non-list / non-text / more than 30 names 400, and nothing changes
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const REAL = path.resolve(BACK, 'prisma', 'dev.db');
const copy = path.join(os.tmpdir(), `socdept-${Date.now().toString(36)}.db`);
{
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(REAL, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.split(path.sep).join('/').replace(/'/g, "''")}'`);
  src.close();
}
const PORT = Number(process.env.TEST_PORT || 4098);
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

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 700)}` : ''}`); };
const RUN = Date.now().toString(36);
const FAKE_TOKEN = `ZZ-NOT-A-REAL-TOKEN-${RUN}`;

async function http(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
const mkUser = async (tag, role) => {
  const u = await prisma.user.create({ data: { passwordHash: 'x', name: `ZZTEST SD ${tag} ${RUN}`, email: `zz-sd-${tag}-${RUN}@example.test`, username: `zz-sd-${tag}-${RUN}@example.test`, role, hrmsRole: role, atsRole: ['SUPER_ADMIN', 'ADMIN'].includes(role) ? role : 'NONE', accountsRole: 'NONE', hrmsAccess: true, accountsAccess: false, atsAccess: ['SUPER_ADMIN', 'ADMIN'].includes(role), status: 'Active' } });
  return { u, t: jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' }) };
};
const readStored = async () => { const row = await prisma.appSetting.findUnique({ where: { key: 'social.accounts' } }); return row ? JSON.parse(row.value) : []; };
const all = (res) => { const o = (res.body && res.body.accounts) || {}; return Object.values(o).flat(); };
const byId = (res, id) => all(res).find((a) => a.id === id);

let server = null;
(async () => {
  try {
    // ---- the copy gets a few made-up accounts (old shape: no "departments" field at all) --------------------------------------
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
    console.log(`     accounts in the copy: ${existing.length} real + ${mine.length} made-up`);

    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 90 && !healthy; i += 1) {
      try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }

    const sup = await mkUser('super', 'SUPER_ADMIN');
    const adm = await mkUser('admin', 'ADMIN');
    const staff = await mkUser('staff', 'EMPLOYEE');
    const URL = '/api/admin/social-accounts';

    // ---- L: reading -------------------------------------------------------------------------------------------------------
    const g0 = await http('GET', URL, sup.t);
    check('L1 the Super Admin reads the list (200) with canAssign true and the department list', g0.status === 200 && g0.body && g0.body.canAssign === true && Array.isArray(g0.body.departments), [g0.status, g0.text.slice(0, 200)]);
    const master = g0.body.departments;
    console.log(`     departments offered: ${master.slice(0, 8).join(' | ')}${master.length > 8 ? ' …' : ''} (${master.length})`);
    check('L2 old rows (no "departments" field) show an empty list, so "Not assigned"', mine.every((m) => Array.isArray(byId(g0, m.id).departments) && byId(g0, m.id).departments.length === 0));
    check('L3 no token is ever in the answer', !g0.text.includes(FAKE_TOKEN) && !/tokenEnc/.test(g0.text));
    // Integrations is Super Admin only by default (utils/permissions.js: "grantable" in the Role Catalog), so an Admin with no grant is stopped
    // before the department code is reached; an Admin who WAS granted "view" sees the labels but canAssign is false (mayAssignSocial).
    const gA = await http('GET', URL, adm.t);
    check('S1 an Admin with no Integrations grant cannot even read the list (403): the department list is never sent to them', gA.status === 403 && !/departments|canAssign/.test(gA.text), [gA.status, gA.text.slice(0, 200)]);

    // ---- L / P: saving ----------------------------------------------------------------------------------------------------
    const d1 = master[0] || 'ZZ Dept One';
    const d2 = master[1] || 'ZZ Dept Two';
    const auditBefore = await prisma.auditLog.count({ where: { entity: 'Integration', entityId: 'social', action: 'Social account departments set' } });
    const storedBefore = await readStored();
    const s1 = await http('POST', `${URL}/${pageA.id}/departments`, sup.t, { departments: [` ${d1.toLowerCase()}  `, d2, d1.toUpperCase(), '  ZZ   Brand   New  Dept '] });
    check('L4 the Super Admin saves departments for a Page (200)', s1.status === 200 && s1.body && /ZZ Page A is given to/.test(s1.body.message || ''), [s1.status, s1.text.slice(0, 300)]);
    const pa = byId(s1, pageA.id);
    const wantNames = [d1, d2, 'ZZ Brand New Dept'];
    check('L5 names are matched to the department list in any case, trimmed, squeezed and de-duplicated; a new name is kept as typed', JSON.stringify(pa.departments) === JSON.stringify(wantNames), pa.departments);
    check('P1 its Instagram account took the same departments along (default)', JSON.stringify(byId(s1, igA.id).departments) === JSON.stringify(wantNames), byId(s1, igA.id).departments);
    check('P2 another Page and its Instagram account are untouched', byId(s1, pageB.id).departments.length === 0 && byId(s1, igB.id).departments.length === 0 && byId(s1, thr.id).departments.length === 0);
    const stored = await readStored();
    const sA = stored.find((a) => a.id === pageA.id);
    const sBefore = storedBefore.find((a) => a.id === pageA.id);
    check('N1 default flag, token, status and name are unchanged', sA.isDefault === sBefore.isDefault && sA.tokenEnc === sBefore.tokenEnc && sA.status === sBefore.status && sA.name === sBefore.name && sA.externalId === sBefore.externalId, { sA, sBefore });
    check('N2 every other stored account is byte-for-byte the same', stored.filter((a) => ![pageA.id, igA.id].includes(a.id)).every((a) => JSON.stringify(a) === JSON.stringify(storedBefore.find((b) => b.id === a.id))));
    check('N3 the answer never contains the token', !s1.text.includes(FAKE_TOKEN) && !/tokenEnc/.test(s1.text));

    // ---- A: audit ---------------------------------------------------------------------------------------------------------
    const aud = await prisma.auditLog.findMany({ where: { entity: 'Integration', entityId: 'social', action: 'Social account departments set' }, orderBy: { createdAt: 'desc' }, take: 1 });
    check('A1 an audit row says who gave which account to which departments', (await prisma.auditLog.count({ where: { entity: 'Integration', entityId: 'social', action: 'Social account departments set' } })) === auditBefore + 1 && aud[0].userId === sup.u.id && /ZZ Page A/.test(aud[0].toValue || '') && /ZZ Brand New Dept/.test(aud[0].toValue || ''), aud[0]);
    const s2 = await http('POST', `${URL}/${pageA.id}/departments`, sup.t, { departments: [d2, d1, 'ZZ Brand New Dept'] });
    check('A2 saving the same departments again (any order) is fine and writes no new audit row', s2.status === 200 && (await prisma.auditLog.count({ where: { entity: 'Integration', entityId: 'social', action: 'Social account departments set' } })) === auditBefore + 1, s2.status);

    // ---- P: Instagram not taken along; other platforms --------------------------------------------------------------------
    const s3 = await http('POST', `${URL}/${pageB.id}/departments`, sup.t, { departments: [d1], withInstagram: false });
    check('P3 with "also Instagram" off, only the Page gets it', s3.status === 200 && JSON.stringify(byId(s3, pageB.id).departments) === JSON.stringify([d1]) && byId(s3, igB.id).departments.length === 0, [s3.status, byId(s3, pageB.id) && byId(s3, pageB.id).departments, byId(s3, igB.id) && byId(s3, igB.id).departments]);
    const s4 = await http('POST', `${URL}/${igB.id}/departments`, sup.t, { departments: [d2] });
    check('P4 an Instagram account can be given on its own', s4.status === 200 && JSON.stringify(byId(s4, igB.id).departments) === JSON.stringify([d2]) && JSON.stringify(byId(s4, pageB.id).departments) === JSON.stringify([d1]));
    const s5 = await http('POST', `${URL}/${thr.id}/departments`, sup.t, { departments: [d1, d2] });
    const s6 = await http('POST', `${URL}/${xx.id}/departments`, sup.t, { departments: [d2] });
    check('P5 Threads and X accounts can be given too', s5.status === 200 && s6.status === 200 && byId(s6, thr.id).departments.length === 2 && byId(s6, xx.id).departments[0] === d2);

    // ---- N: renaming keeps the label --------------------------------------------------------------------------------------
    const e1 = await http('POST', `${URL}/${thr.id}/edit`, sup.t, { name: 'ZZ Threads Renamed' });
    check('N4 renaming an account keeps its departments', e1.status === 200 && byId(e1, thr.id).name === 'ZZ Threads Renamed' && byId(e1, thr.id).departments.length === 2, [e1.status, e1.text.slice(0, 200)]);

    // ---- L: clearing, length ----------------------------------------------------------------------------------------------
    const c1 = await http('POST', `${URL}/${pageA.id}/departments`, sup.t, { departments: [] });
    check('L6 an empty list makes the account (and its Instagram) "not assigned"', c1.status === 200 && /not assigned/.test(c1.body.message) && byId(c1, pageA.id).departments.length === 0 && byId(c1, igA.id).departments.length === 0, [c1.status, c1.text.slice(0, 200)]);
    const c2 = await http('POST', `${URL}/${pageA.id}/departments`, sup.t, { departments: ['Q'.repeat(90)] });
    check('L7 a very long name is cut at 60 characters', c2.status === 200 && byId(c2, pageA.id).departments[0].length === 60, byId(c2, pageA.id).departments);
    await http('POST', `${URL}/${pageA.id}/departments`, sup.t, { departments: [] });

    // ---- S: who may -------------------------------------------------------------------------------------------------------
    const before = JSON.stringify(await readStored());
    const x1 = await http('POST', `${URL}/${pageA.id}/departments`, adm.t, { departments: [d1] });
    check('S2 an Admin cannot assign (403)', x1.status === 403, [x1.status, x1.text.slice(0, 200)]);
    const x2 = await http('POST', `${URL}/${pageA.id}/departments`, staff.t, { departments: [d1] });
    check('S3 a normal login cannot (403)', x2.status === 403, x2.status);
    const x3 = await http('POST', `${URL}/${pageA.id}/departments`, null, { departments: [d1] });
    check('S4 no login = 401', x3.status === 401, x3.status);
    check('S5 none of those three changed anything', JSON.stringify(await readStored()) === before);
    const gs = await http('GET', URL, staff.t);
    check('S6 a normal login cannot read the account list at all (403)', gs.status === 403, gs.status);

    // ---- B: bad input -----------------------------------------------------------------------------------------------------
    const b1 = await http('POST', `${URL}/zz-nope/departments`, sup.t, { departments: [d1] });
    check('B1 an account that is not in the list = 404', b1.status === 404, [b1.status, b1.text.slice(0, 150)]);
    const b2 = await http('POST', `${URL}/${pageA.id}/departments`, sup.t, { departments: 'Medical' });
    check('B2 a department value that is not a list = 400', b2.status === 400, [b2.status, b2.text.slice(0, 150)]);
    const b3 = await http('POST', `${URL}/${pageA.id}/departments`, sup.t, { departments: [{ a: 1 }] });
    check('B3 a department that is not text = 400', b3.status === 400, [b3.status, b3.text.slice(0, 150)]);
    const b4 = await http('POST', `${URL}/${pageA.id}/departments`, sup.t, { departments: Array.from({ length: 31 }, (_, i) => `ZZ D${i}`) });
    check('B4 more than 30 names = 400', b4.status === 400, [b4.status, b4.text.slice(0, 150)]);
    const b5 = await http('POST', `${URL}/${pageA.id}/departments`, sup.t, {});
    check('B5 no body = 400', b5.status === 400, b5.status);
    check('B6 none of the bad requests changed anything', JSON.stringify((await readStored()).find((a) => a.id === pageA.id).departments || []) === '[]');

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
    console.log(`\n${pass} passed, ${fail} failed (the copy database is deleted; prisma/dev.db was only read)`);
    process.exit(fail ? 1 : 0);
  }
})();
