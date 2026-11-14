#!/usr/bin/env node
// ---------------------------------------------------------------------------
// WHATSAPP NUMBERS - "BUSINESS PORTFOLIO" LABEL (founder 2026-11-14) - COPY DATABASE ONLY.
//
//   cd backend
//   node scripts/wa-portfolio-test.js    makes its own VACUUM INTO copy of prisma/dev.db (opened READ-ONLY) in the temp folder,
//                                        starts a throw-away API on it (port 4097, TEST_MODE) and deletes both afterwards
//
// "How do I separate the numbers of the Medical portfolio from the Nonit portfolio?" -> a plain label on each number (which Meta business
// portfolio owns its WhatsApp Business Account and pays for it). Proved over /api/wa-numbers on a copy of the real data, whose
// WaNumber table was made BEFORE the label existed (so the one new column has to be added on the first save):
//   M  migration: reading works before the column exists; the first save adds it once (idempotent); a fresh table has it
//   L  the label: saved, trimmed and squeezed, cut at 60, cleared with an empty value, shown in the list, listed in "portfolios"
//   N  nothing else on the number changed (name, account id, token saved, departments, default, status), no Meta check was made
//   A  an audit row says who changed it; the same value again writes nothing
//   C  Add WhatsApp Number takes the label too; the Main number's label can be set while its connection details stay locked
//   S  only an Admin can change it; a normal login's /my-numbers shows no portfolio; a non-text label is refused
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const REAL = path.resolve(BACK, 'prisma', 'dev.db');
const copy = path.join(os.tmpdir(), `waport-${Date.now().toString(36)}.db`);
{
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(REAL, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.split(path.sep).join('/').replace(/'/g, "''")}'`);
  src.close();
}
const PORT = Number(process.env.TEST_PORT || 4097);
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
const WN = require(path.join(BACK, 'src/utils/waNumbers'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 700)}` : ''}`); };
const RUN = Date.now().toString(36);

async function http(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
const portfolioCols = async () => (await prisma.$queryRawUnsafe('PRAGMA table_info("WaNumber")')).filter((c) => c.name === 'portfolio').length;
const mkUser = async (tag, role) => {
  const u = await prisma.user.create({ data: { passwordHash: 'x', name: `ZZTEST WP ${tag} ${RUN}`, email: `zz-wp-${tag}-${RUN}@example.test`, username: `zz-wp-${tag}-${RUN}@example.test`, role, hrmsRole: role, atsRole: role === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : 'NONE', accountsRole: 'NONE', hrmsAccess: true, accountsAccess: false, atsAccess: role === 'SUPER_ADMIN', status: 'Active' } });
  return { u, t: jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' }) };
};

let server = null;
(async () => {
  try {
    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 90 && !healthy; i += 1) {
      try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }

    const admin = await mkUser('admin', 'SUPER_ADMIN');
    const staff = await mkUser('staff', 'EMPLOYEE');

    // ---- M: migration -----------------------------------------------------------------------------------------------
    check('M1 the copy of the real data has the old WaNumber table: no "portfolio" column yet', (await portfolioCols()) === 0);
    check('M2 a fresh table (the CREATE statement) has the column', WN.DDL.join(' ').includes('"portfolio" TEXT'));
    const g0 = await http('GET', '/api/wa-numbers', admin.t);
    const real = (g0.body && g0.body.numbers || []).filter((n) => !n.virtual);
    check('M3 the list loads on the old table; every number shows an empty portfolio and no names are listed', g0.status === 200 && real.length >= 2 && real.every((n) => n.portfolio === '') && Array.isArray(g0.body.portfolios) && g0.body.portfolios.length === 0, [g0.status, real.length, g0.body && g0.body.portfolios]);
    check('M4 reading did not add the column (a read never changes the database)', (await portfolioCols()) === 0);
    const ids = real.map((n) => n.id);
    console.log(`     numbers in the copy: ${real.map((n) => `${n.label}${n.isMain ? ' [Main]' : ''}`).join(' | ')}`);

    // ---- L / N / A: the label on a number that exists -----------------------------------------------------------------
    const target = real.find((n) => !n.isMain) || real[0];
    const before = (await http('GET', '/api/wa-numbers', admin.t)).body.numbers.find((n) => n.id === target.id);
    const auditBefore = await prisma.auditLog.count({ where: { entity: 'WaNumber', entityId: target.id } });
    const s1 = await http('PUT', `/api/wa-numbers/${target.id}`, admin.t, { portfolio: '  TeamLink   Medical  Consultancy ', check: false });
    check('L1 PUT with a portfolio is accepted (200) and makes no Meta check', s1.status === 200 && s1.body && s1.body.ok === true && s1.body.status === null, [s1.status, s1.text.slice(0, 200)]);
    check('M5 the first save added the column, once', (await portfolioCols()) === 1);
    const after = (await http('GET', '/api/wa-numbers', admin.t)).body.numbers.find((n) => n.id === target.id);
    check('L2 the list shows it trimmed and with the spaces squeezed', after.portfolio === 'TeamLink Medical Consultancy', after.portfolio);
    const same = ['label', 'displayNumber', 'phoneNumberId', 'wabaId', 'tokenMode', 'tokenSaved', 'tokenSource', 'isDefault', 'active', 'language', 'tplLink', 'tplOtp', 'tplBulk', 'notAssigned', 'everyone'].every((k) => JSON.stringify(before[k]) === JSON.stringify(after[k]));
    check('N1 nothing else on the number changed (name, ids, token source / saved, default, switched on, templates)', same, { before, after });
    check('N2 its departments, people and roles are unchanged', JSON.stringify([before.departments, before.users, before.roles]) === JSON.stringify([after.departments, after.users, after.roles]));
    check('N3 its connection status is unchanged (no check was asked of Meta)', before.status.code === after.status.code && String(before.status.checkedAt) === String(after.status.checkedAt), [before.status, after.status]);
    const g1 = await http('GET', '/api/wa-numbers', admin.t);
    check('L3 "portfolios" lists the name once', JSON.stringify(g1.body.portfolios) === JSON.stringify(['TeamLink Medical Consultancy']), g1.body.portfolios);
    const aud = await prisma.auditLog.findMany({ where: { entity: 'WaNumber', entityId: target.id }, orderBy: { createdAt: 'desc' }, take: 1 });
    check('A1 an audit row says the label changed and who did it', (await prisma.auditLog.count({ where: { entity: 'WaNumber', entityId: target.id } })) === auditBefore + 1 && /portfolio/.test(aud[0].toValue || '') && /Medical/.test(aud[0].toValue || '') && aud[0].userId === admin.u.id, aud[0]);
    const s2 = await http('PUT', `/api/wa-numbers/${target.id}`, admin.t, { portfolio: 'TeamLink Medical Consultancy', check: false });
    check('A2 saving the same value again is fine and writes no new audit row', s2.status === 200 && (await prisma.auditLog.count({ where: { entity: 'WaNumber', entityId: target.id } })) === auditBefore + 1);
    const s3 = await http('PUT', `/api/wa-numbers/${target.id}`, admin.t, { portfolio: 'P'.repeat(90), check: false });
    const long = (await http('GET', '/api/wa-numbers', admin.t)).body.numbers.find((n) => n.id === target.id).portfolio;
    check('L4 a very long name is cut at 60 characters', s3.status === 200 && long.length === 60, long.length);
    const s4 = await http('PUT', `/api/wa-numbers/${target.id}`, admin.t, { portfolio: '   ', check: false });
    const cleared = (await http('GET', '/api/wa-numbers', admin.t)).body;
    check('L5 an empty value clears it, and the name leaves the list', s4.status === 200 && cleared.numbers.find((n) => n.id === target.id).portfolio === '' && cleared.portfolios.length === 0, cleared.portfolios);
    const s5 = await http('PUT', `/api/wa-numbers/${target.id}`, admin.t, { label: `${target.label}`, check: false });
    check('L6 an edit that does not mention the portfolio leaves it alone', s5.status === 200);
    await http('PUT', `/api/wa-numbers/${target.id}`, admin.t, { portfolio: 'TeamLink Medical Consultancy', check: false });
    const s6 = await http('PUT', `/api/wa-numbers/${target.id}`, admin.t, { label: target.label, check: false });
    const keep = (await http('GET', '/api/wa-numbers', admin.t)).body.numbers.find((n) => n.id === target.id).portfolio;
    check('L7 saving the number\'s name again does not wipe the portfolio', s6.status === 200 && keep === 'TeamLink Medical Consultancy', keep);

    // two portfolios across the real numbers, sorted names
    for (let i = 0; i < ids.length; i += 1) {
      const r = await http('PUT', `/api/wa-numbers/${ids[i]}`, admin.t, { portfolio: i % 2 ? 'TeamLink Consultancy Nonit' : 'TeamLink Medical Consultancy', check: false });
      if (r.status !== 200) check(`L8 set ${ids[i]}`, false, r.text);
    }
    const g2 = await http('GET', '/api/wa-numbers', admin.t);
    check('L8 two portfolios across the numbers; the names are listed once each, in A-Z order', JSON.stringify(g2.body.portfolios) === JSON.stringify(['TeamLink Consultancy Nonit', 'TeamLink Medical Consultancy']), g2.body.portfolios);

    // ---- C: Add + Main ----------------------------------------------------------------------------------------------
    const phone = `9${String(Date.now()).slice(-9)}${Math.floor(Math.random() * 10)}`.padEnd(15, '7');
    const add = await http('POST', '/api/wa-numbers', admin.t, { label: `ZZTEST port ${RUN}`, displayNumber: `+9197${String(Date.now()).slice(-8)}`, phoneNumberId: phone, wabaId: '846538861628540', portfolio: 'TeamLink Consultancy Nonit', tokenMode: 'own', token: `ZZTESTTOKEN-${RUN}-${'x'.repeat(40)}`, check: false });
    const addRow = add.body && (await http('GET', '/api/wa-numbers', admin.t)).body.numbers.find((n) => n.id === add.body.id);
    check('C1 Add WhatsApp Number saves the portfolio with the number', add.status === 200 && addRow && addRow.portfolio === 'TeamLink Consultancy Nonit' && addRow.wabaId === '846538861628540', [add.status, add.text.slice(0, 200)]);
    check('C2 the token typed for it is never in the list response', !JSON.stringify((await http('GET', '/api/wa-numbers', admin.t)).body).includes(`ZZTESTTOKEN-${RUN}`));
    const main = real.find((n) => n.isMain);
    if (main) {
      const m1 = await http('PUT', `/api/wa-numbers/${main.id}`, admin.t, { portfolio: 'TeamLink Medical Consultancy', check: false });
      check('C3 the Main number\'s portfolio can be set', m1.status === 200 && (await http('GET', '/api/wa-numbers', admin.t)).body.numbers.find((n) => n.id === main.id).portfolio === 'TeamLink Medical Consultancy', [m1.status, m1.text.slice(0, 200)]);
      const m2 = await http('PUT', `/api/wa-numbers/${main.id}`, admin.t, { phoneNumberId: '123456789012', check: false });
      check('C4 the Main number\'s connection details are still locked (400)', m2.status === 400, [m2.status, m2.text.slice(0, 200)]);
    } else check('C3 (no Main number in this copy: skipped)', true);
    const dup = await http('POST', '/api/wa-numbers', admin.t, { label: `ZZTEST port2 ${RUN}`, displayNumber: `+9196${String(Date.now()).slice(-8)}`, phoneNumberId: `${phone.slice(0, 14)}9`, portfolio: 'x', tokenMode: 'own', token: `ZZTESTTOKEN-${RUN}-${'y'.repeat(40)}`, check: false });
    check('C5 a short one-letter-style name is fine too', dup.status === 200 && (await http('GET', '/api/wa-numbers', admin.t)).body.numbers.find((n) => n.id === dup.body.id).portfolio === 'x', [dup.status, dup.text.slice(0, 200)]);
    const blank = await http('POST', '/api/wa-numbers', admin.t, { label: `ZZTEST port3 ${RUN}`, displayNumber: `+9195${String(Date.now()).slice(-8)}`, phoneNumberId: `${phone.slice(0, 13)}88`, tokenMode: 'own', token: `ZZTESTTOKEN-${RUN}-${'z'.repeat(40)}`, check: false });
    check('C6 Add with no portfolio at all: saved, label empty', blank.status === 200 && (await http('GET', '/api/wa-numbers', admin.t)).body.numbers.find((n) => n.id === blank.body.id).portfolio === '', [blank.status, blank.text.slice(0, 200)]);

    // ---- S: who may -------------------------------------------------------------------------------------------------
    const p1 = await http('PUT', `/api/wa-numbers/${target.id}`, staff.t, { portfolio: 'hacked', check: false });
    check('S1 a normal login cannot change it (403)', p1.status === 403, p1.status);
    const g3 = await http('GET', '/api/wa-numbers', staff.t);
    check('S2 a normal login cannot read the admin list (403)', g3.status === 403, g3.status);
    const mine = await http('GET', '/api/wa-numbers/my-numbers', staff.t);
    check('S3 /my-numbers (what any login gets) shows no portfolio', mine.status === 200 && !/portfolio|Nonit|Medical Consultancy/i.test(mine.text), mine.text.slice(0, 300));
    const anon = await http('PUT', `/api/wa-numbers/${target.id}`, null, { portfolio: 'x' });
    check('S4 no login = 401', anon.status === 401, anon.status);
    const heldBefore = (await http('GET', '/api/wa-numbers', admin.t)).body.numbers.find((n) => n.id === target.id).portfolio;
    const bad = await http('PUT', `/api/wa-numbers/${target.id}`, admin.t, { portfolio: { a: 1 }, check: false });
    const heldAfter = (await http('GET', '/api/wa-numbers', admin.t)).body.numbers.find((n) => n.id === target.id).portfolio;
    check('S5 a label that is not text is refused (400) and nothing changes', bad.status === 400 && heldBefore && heldAfter === heldBefore, [bad.status, bad.text.slice(0, 200), heldBefore, heldAfter]);

    // the column is still exactly one after all those saves
    check('M6 still exactly one "portfolio" column after every save (idempotent)', (await portfolioCols()) === 1);
    // omni-channel dept logins follow a saved number (the route hook): nothing broke
    const g4 = await http('GET', '/api/wa-numbers', admin.t);
    check('M7 the list still loads after all the changes', g4.status === 200 && g4.body.numbers.length >= real.length + 2, [g4.status, g4.body && g4.body.numbers.length]);
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
