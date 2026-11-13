#!/usr/bin/env node
// ---------------------------------------------------------------------------
// OMNI-CHANNEL: WHO OPENS GREEN START (2026-11-13) TEST: the Admin's per-kind switch, the fallback to the native pages when a department has no ready login, the "check one person" answer,
// Admin-only rules and the audit row. SANDBOX ONLY: talks to the running sandbox API (:4011) and its database (prisma/sandbox.db); nothing real is sent or contacted.
//   cd backend && node scripts/omni-gs-access-test.js
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const DB = path.resolve(process.env.SANDBOX_DB || path.join(BACK, 'prisma', 'sandbox.db'));
if (!/sandbox\.db$/i.test(DB) || !fs.existsSync(DB)) { console.error('Refusing: this test only runs against prisma/sandbox.db (npm run sandbox).'); process.exit(2); }
const API = process.env.SANDBOX_API || 'http://127.0.0.1:4011';
if (!/^http:\/\/(127\.0\.0\.1|localhost):40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: the sandbox API is on a port from 4011 to 4099, never 4010.'); process.exit(2); }
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}?socket_timeout=60`;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const A0 = require(path.join(BACK, 'src/outreach/access'));
const WN = require(path.join(BACK, 'src/utils/waNumbers'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 400)}` : ''}`); };
const RUN = Date.now().toString(36);
async function http(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload; if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, signal: AbortSignal.timeout(60000) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
const G = '/api/omni-gs';

(async () => {
  const first = async (where) => prisma.user.findFirst({ where: { status: 'Active', NOT: { email: { contains: 'example.test' } }, ...where } });
  const live = { employee: { is: { employmentStatus: 'Active' } } };
  const sa = await first({ role: 'SUPER_ADMIN' });
  let tl = null; let bde = null; let rec = null; let bdetl = null;
  for (const c of await prisma.user.findMany({ where: { status: 'Active', atsRole: { in: ['TL', 'BDE', 'RECRUITER'] }, ...live, NOT: { email: { contains: 'example.test' } } }, take: 200 })) { // eslint-disable-line no-await-in-loop
    const i = await resolveIdentity(c.id); const k = A0.kind(i); // eslint-disable-line no-await-in-loop
    const depts = WN.departmentsOfUser(c);
    if (k === 'tl' && !tl && depts.size) tl = c; else if (k === 'bde' && !bde && depts.size) bde = c; else if (k === 'recruiter' && !rec && depts.size) rec = c; else if (k === 'bdetl' && !bdetl) bdetl = c;
  }
  check('0 the copy has a Super Admin, a Team Lead, a BDE and a recruiter that each have a department', !!(sa && tl && bde && rec), { sa: !!sa, tl: !!tl, bde: !!bde, rec: !!rec });
  await prisma.user.updateMany({ where: { id: { in: [sa, tl, bde, rec, bdetl].filter(Boolean).map((u) => u.id) } }, data: { passwordHash: 'x' } });
  const mkt = await prisma.user.create({ data: { passwordHash: 'x', hrmsAccess: false, atsAccess: true, accountsRole: 'NONE', accountsAccess: false, status: 'Active', name: `ZZTEST gsa mkt ${RUN}`, email: `zz-gsa-mkt-${RUN}@example.test`, username: `zz-gsa-mkt-${RUN}@example.test`, role: 'EMPLOYEE', atsRole: 'EMPLOYEE' } });
  const permRow = await prisma.appSetting.findUnique({ where: { key: 'omni.permissions' } });
  const perm = permRow ? JSON.parse(permRow.value) : {};
  const ids = new Set([...(perm.marketingUserIds || []), mkt.id]);
  await prisma.appSetting.upsert({ where: { key: 'omni.permissions' }, create: { key: 'omni.permissions', value: JSON.stringify({ ...perm, marketingUserIds: [...ids] }) }, update: { value: JSON.stringify({ ...perm, marketingUserIds: [...ids] }) } });
  const keepLogins = await prisma.appSetting.findUnique({ where: { key: 'omni.gs.deptLogins' } });
  const keepAccess = await prisma.appSetting.findUnique({ where: { key: 'omni.gsAccess' } });
  await prisma.appSetting.deleteMany({ where: { key: 'omni.gsAccess' } }); // "never saved"
  // department logins that are READY for the departments of the test people (the marketing login has no department, so it has none)
  const logins = {};
  for (const u of [tl, bde, rec]) for (const d of WN.departmentsOfUser(u)) logins[d] = { dept: d, state: 'ready', email: `zz+omni-${d}@example.test`, workspace: `w-${d}` };
  await prisma.appSetting.upsert({ where: { key: 'omni.gs.deptLogins' }, create: { key: 'omni.gs.deptLogins', value: JSON.stringify({ departments: logins }) }, update: { value: JSON.stringify({ departments: logins }) } });
  await new Promise((r) => setTimeout(r, 11000)); // the server re-reads the Marketing and Green Start lists every 10 seconds
  const tokenOf = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
  const T = { sa: await tokenOf(sa), tl: await tokenOf(tl), bde: await tokenOf(bde), rec: await tokenOf(rec), mkt: await tokenOf(mkt) };
  const gs = async (k) => ((await http('GET', '/api/outreach/me', T[k])).body || {}).greenStart;

  // ============================================================ A: default (never saved) = every kind switched on
  const a0 = await http('GET', `${G}/access`, T.sa);
  check('A1 an Admin sees the seven kinds, all switched on when nothing was ever saved', a0.status === 200 && a0.body.kinds.length === 7 && a0.body.kinds.every((k) => k.on), a0.text.slice(0, 200));
  check('A2 the screen words say what employees get: Team Leader role, no integrations / billing / workspace settings', /Team Leader/.test(a0.body.role) && /no integrations, billing or workspace settings/.test(a0.body.role), a0.body.role);
  check('A3 recruiter, BDE and Marketing are marked "phone numbers hidden in the native pages"; Team Lead is not', ['recruiter', 'bde', 'marketing'].every((k) => a0.body.kinds.find((x) => x.kind === k).masked) && !a0.body.kinds.find((x) => x.kind === 'tl').masked);
  for (const k of ['tl', 'bde', 'rec', 'mkt']) check(`A4 ${k}: only an Admin may read or change this (403)`, (await http('GET', `${G}/access`, T[k])).status === 403 || (await http('GET', `${G}/access`, T[k])).status === 403);
  check('A5 a Team Lead, a BDE and a recruiter whose department has a ready Omni-Channel login all open Green Start', (await gs('tl')) === true && (await gs('bde')) === true && (await gs('rec')) === true, [await gs('tl'), await gs('bde'), await gs('rec')]);
  check('A6 a Marketing login with no department keeps the native pages (never a dead end)', (await gs('mkt')) === false);
  check('A7 the Super Admin opens Green Start', (await gs('sa')) === true);

  // ============================================================ B: the switch
  const bad = await http('PUT', `${G}/access`, T.sa, { kinds: ['recruiter', 'nonsense'] });
  check('B1 an unknown kind is refused (400)', bad.status === 400, bad.text);
  check('B2 a recruiter cannot change it (403)', (await http('PUT', `${G}/access`, T.rec, { kinds: ['recruiter'] })).status === 403);
  const put = await http('PUT', `${G}/access`, T.sa, { kinds: ['tl', 'view', 'hr', 'bde', 'bdetl', 'marketing'] }); // recruiter OFF
  check('B3 the Admin switches recruiters off', put.status === 200 && put.body.kinds.find((k) => k.kind === 'recruiter').on === false && put.body.kinds.filter((k) => k.on).length === 6, put.text.slice(0, 200));
  check('B4 at once: a recruiter sees the native pages, a BDE and a Team Lead still open Green Start', (await gs('rec')) === false && (await gs('bde')) === true && (await gs('tl')) === true, [await gs('rec'), await gs('bde'), await gs('tl')]);
  check('B5 a recruiter is also kept out of the Green Start door (/api/omni-gs/status 403) while a BDE gets in', (await http('GET', `${G}/status`, T.rec)).status === 403 && (await http('GET', `${G}/status`, T.bde)).status !== 403);
  const ppl = await http('GET', `${G}/access/people?q=${encodeURIComponent(String(rec.name).slice(0, 3))}`, T.sa);
  check('B6 the name search finds people (names and role words only)', ppl.status === 200 && ppl.body.people.length >= 1 && Object.keys(ppl.body.people[0]).sort().join() === 'department,id,name,role', ppl.text.slice(0, 200));
  const cRec = await http('GET', `${G}/access/check?userId=${rec.id}`, T.sa);
  check('B7 "check one person": the recruiter sees the native pages and the reason says why in plain words', cRec.status === 200 && cRec.body.opens === 'native' && /not switched on for Green Start/.test(cRec.body.why), cRec.text.slice(0, 300));
  const cBde = await http('GET', `${G}/access/check?userId=${bde.id}`, T.sa);
  check('B8 the BDE opens Green Start as their department login with the Team Leader role', cBde.status === 200 && cBde.body.opens === 'green-start' && !!cBde.body.department && /Team Leader/.test(cBde.body.why), cBde.text.slice(0, 300));
  const cMkt = await http('GET', `${G}/access/check?userId=${mkt.id}`, T.sa);
  check('B9 Marketing with no department: switched on, but no login yet, so the native pages (reason given)', cMkt.status === 200 && cMkt.body.opens === 'native' && /no department|no Omni-Channel/i.test(cMkt.body.why), cMkt.text.slice(0, 300));
  const cSa = await http('GET', `${G}/access/check?userId=${sa.id}`, T.sa);
  check('B10 the Super Admin always opens Green Start', cSa.status === 200 && cSa.body.opens === 'green-start', cSa.text.slice(0, 200));
  check('B11 the check refuses a stranger (404) and a non-Admin (403)', (await http('GET', `${G}/access/check?userId=nobody`, T.sa)).status === 404 && (await http('GET', `${G}/access/check?userId=${rec.id}`, T.rec)).status === 403);

  // ============================================================ C: a department with no ready login
  const dRows = JSON.parse((await prisma.appSetting.findUnique({ where: { key: 'omni.gs.deptLogins' } })).value);
  const bdeDept = [...WN.departmentsOfUser(bde)][0];
  dRows.departments[bdeDept] = { ...dRows.departments[bdeDept], state: 'failed' };
  await prisma.appSetting.update({ where: { key: 'omni.gs.deptLogins' }, data: { value: JSON.stringify(dRows) } });
  const bdeNow = await gs('bde');
  const sameDept = [tl, rec].some((u) => WN.departmentsOfUser(u).has(bdeDept));
  check('C1 a department whose Omni-Channel login did not work: its BDE keeps the native pages (never a dead end)', bdeNow === false, bdeNow);
  const cBde2 = await http('GET', `${G}/access/check?userId=${bde.id}`, T.sa);
  check('C2 and the check says so in words', cBde2.body.opens === 'native' && /Until then this person sees the native Omni-Channel pages/.test(cBde2.body.why), cBde2.text.slice(0, 300));
  void sameDept;

  // ============================================================ D: audit + putting it back
  const back = await http('PUT', `${G}/access`, T.sa, { kinds: ['tl', 'view', 'hr', 'recruiter', 'bde', 'bdetl', 'marketing'] });
  check('D1 switched back on: recruiters open Green Start again', back.status === 200 && (await gs('rec')) === true, back.text.slice(0, 120));
  const aud = await prisma.auditLog.findMany({ where: { action: 'Omni-Channel: who opens Green Start changed', createdAt: { gte: new Date(Date.now() - 600000) } }, orderBy: { createdAt: 'desc' }, take: 5 });
  check('D2 each change is in the audit trail, with the before and after in words', aud.length >= 2 && /Recruiter/.test(aud.map((a) => `${a.fromValue} ${a.toValue}`).join(' ')) && aud.every((a) => !/@/.test(`${a.fromValue}${a.toValue}`)), aud.map((a) => [a.fromValue, a.toValue]));
  const same = await http('PUT', `${G}/access`, T.sa, { kinds: ['tl', 'view', 'hr', 'recruiter', 'bde', 'bdetl', 'marketing'] });
  const aud2 = await prisma.auditLog.count({ where: { action: 'Omni-Channel: who opens Green Start changed', createdAt: { gte: new Date(Date.now() - 600000) } } });
  check('D3 saving the same list again is not logged as a change', same.status === 200 && aud2 === aud.length, [aud2, aud.length]);

  // put the sandbox back as it was
  if (keepLogins) await prisma.appSetting.update({ where: { key: 'omni.gs.deptLogins' }, data: { value: keepLogins.value } }); else await prisma.appSetting.deleteMany({ where: { key: 'omni.gs.deptLogins' } });
  if (keepAccess) await prisma.appSetting.upsert({ where: { key: 'omni.gsAccess' }, create: { key: 'omni.gsAccess', value: keepAccess.value }, update: { value: keepAccess.value } }); else await prisma.appSetting.deleteMany({ where: { key: 'omni.gsAccess' } });
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASHED:', e); process.exit(3); });
