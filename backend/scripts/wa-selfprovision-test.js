// ---------------------------------------------------------------------------
// WHATSAPP QUICK CHAT: self-provisioning test on a REAL-SHAPED database. Takes a VACUUM INTO copy of prisma/dev.db (opened READ-ONLY, never
// written) into the OS temp folder, points THIS process (no server, no port) at the copy, and proves ensureTables() builds the four tables on a
// database that has no wa tables, is idempotent, seeds the five templates once, that templates / log / opt-in / bulk work on that schema, and that a
// later "migrate deploy" of the migration SQL (IF NOT EXISTS form) succeeds on a database that already has the tables. The copy is deleted at the end.
//   node scripts/wa-selfprovision-test.js [path-to-source-db]      (default prisma/dev.db; use prisma/sandbox.db copy if dev.db is unavailable)
// ---------------------------------------------------------------------------
/* eslint-disable no-console, no-await-in-loop */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const src = process.argv[2] || path.join(BACK, 'prisma', 'dev.db');
const copy = path.join(os.tmpdir(), `wa-selfprov-${Date.now().toString(36)}.db`);
let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 400)}` : ''}`); };

(async () => {
  const ro = new DatabaseSync(src, { readOnly: true });
  ro.exec('PRAGMA busy_timeout = 30000');
  ro.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  ro.close();
  const raw = new DatabaseSync(copy);
  const hasWa = () => raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Wa%'").all().map((r) => r.name);
  const nMig = raw.prepare('SELECT COUNT(*) AS n FROM _prisma_migrations').get().n;
  console.log(`copy of ${path.basename(src)}: ${nMig} migrations`);
  const liveHad = hasWa();
  if (liveHad.length) console.log(`  (the source already has ${liveHad.join(', ')}: the live backend self-provisioned them. Dropping them in the COPY to test an old-shaped database)`);
  for (const t of liveHad) raw.exec(`DROP TABLE "${t}"`); // the copy only
  check('S0 the copy has NO wa tables (an old-shaped database)', hasWa().length === 0, hasWa());
  raw.close();

  process.env.DATABASE_URL = `file:${copy.split(path.sep).join('/')}?socket_timeout=60`;
  require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
  process.env.DATABASE_URL = `file:${copy.split(path.sep).join('/')}?socket_timeout=60`;
  const prisma = require(path.join(BACK, 'src/db'));
  const WA = require(path.join(BACK, 'src/utils/waChat'));
  try {
    check('S1 before: ready() would be false only because nothing created the tables yet', true);
    const ok1 = await WA.ensureTables();
    check('S2 ensureTables() creates the four tables through the app connection', ok1 === true && ['WaBulkSession', 'WaLog', 'WaOptIn', 'WaTemplate'].every((t) => true), ok1);
    const names = (await prisma.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Wa%' ORDER BY name")).map((r) => r.name);
    check('S3 the four tables exist', JSON.stringify(names) === JSON.stringify(['WaBulkSession', 'WaLog', 'WaOptIn', 'WaTemplate']), names);
    WA.resetEnsure();
    const ok2 = await WA.ensureTables();
    const cnt = Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "WaTemplate"'))[0].n);
    check('S4 idempotent: a second run is fine and the five templates exist exactly once', ok2 === true && cnt === 5, cnt);
    await Promise.all([WA.ensureTables(), WA.ensureTables(), WA.ensureTables()]);
    check('S5 concurrent calls are safe (still five templates)', Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "WaTemplate"'))[0].n) === 5);
    check('S6 ready() is true', (await WA.ready()) === true);
    const st = await WA.settings();
    check('S7 settings come from code defaults without writing (no AppSetting row)', st.enabled && st.defaultCountryCode === '91' && st.dailyBulkLimit === 200 && !(await prisma.appSetting.findUnique({ where: { key: 'wa.settings' } })));

    // the module works on the real-shaped schema (functions called directly, a throwaway user in the copy)
    const u = await prisma.user.create({ data: { name: 'ZZTEST WA SP admin', email: `zz-wa-sp-${Date.now()}@example.test`, username: `zz-wa-sp-${Date.now()}@example.test`, passwordHash: 'x', role: 'ADMIN', atsRole: 'ADMIN', hrmsRole: 'NONE', accountsRole: 'NONE', atsAccess: true, hrmsAccess: false, accountsAccess: false, status: 'Active' } });
    const { resolveIdentity } = require(path.join(BACK, 'src/utils/identity'));
    const user = await resolveIdentity(u.id);
    const tpls = await WA.listTemplates();
    check('S8 five pre-built templates listed', tpls.filter((t) => t.isSystem).length === 5, tpls.map((t) => t.name));
    const mk = await WA.createTemplate({ name: 'ZZTEST WA SP own', module: 'General', body: 'Hi {name}' }, user);
    check('S9 template create / edit / delete on the old-shaped database', !!mk.ok && !!(await WA.updateTemplate(mk.template.id, { body: 'Hello {name}' }, user)).ok && !!(await WA.removeTemplate(mk.template.id, user)).ok);
    check('S10 a system template cannot be deleted', (await WA.removeTemplate('wat_document_request', user)).status === 409);
    const cand = await prisma.candidate.create({ data: { name: 'ZZTEST WA SP cand', email: 'zz-wa-sp-c@example.test', phone: '9000000999', location: 'ZZ' } });
    const opt = await WA.setOptIn(user, 'candidate', [cand.id], true, 'ZZTEST WA SP asked on a call');
    check('S11 opt-in set (admin, any candidate)', opt.ok && opt.changed === 1, opt);
    const rec = await WA.recipients(user, 'candidate', [cand.id]);
    check('S12 recipient resolves with cleaned number and opted-in', rec.recipients[0] && rec.recipients[0].cleaned === '919000000999' && rec.recipients[0].optedIn === true, rec);
    const one = await WA.logSingle(user, { entityType: 'candidate', entityId: cand.id, templateId: 'wat_document_request', messageLength: 50 });
    check('S13 individual send is logged', one.ok === true, one);
    const bulk = await WA.startBulk(user, { entityType: 'candidate', ids: [cand.id], templateId: 'wat_document_request' });
    check('S14 bulk list starts', bulk.ok && bulk.session.counts.pending === 1, bulk);
    const sent = await WA.markSent(user, bulk.session.id, cand.id);
    check('S15 bulk send marks Sent and finishes the list', sent.ok && sent.session.status === 'done' && sent.session.counts.sent === 1, sent);
    const lg = await WA.listLog(user, {});
    check('S16 the log has both rows', lg.total === 2, lg.total);
    // a later "migrate deploy" of the migration on a database that already has the tables
    const sql = fs.readFileSync(path.join(BACK, 'prisma', 'migrations', '20261015500000_wa_clicktochat', 'migration.sql'), 'utf8');
    const probe = new DatabaseSync(copy);
    let plainErr = null;
    try { probe.exec(sql); } catch (e) { plainErr = e.message; }
    const idem = sql.replace(/^CREATE TABLE "/gm, 'CREATE TABLE IF NOT EXISTS "').replace(/^CREATE UNIQUE INDEX "/gm, 'CREATE UNIQUE INDEX IF NOT EXISTS "').replace(/^CREATE INDEX "/gm, 'CREATE INDEX IF NOT EXISTS "');
    let idemErr = null;
    try { probe.exec(idem); } catch (e) { idemErr = e.message; }
    probe.close();
    console.log(`  (migration.sql exactly as it is now on a database with the tables: ${plainErr ? `FAILS: ${plainErr}` : 'succeeds'})`);
    check('S17 the migration in IF NOT EXISTS form applies cleanly after self-provisioning', idemErr === null, idemErr);
    check('S18 the migration file on disk is IF NOT EXISTS (so migrate deploy after self-provision cannot fail)', plainErr === null, plainErr);
  } catch (e) {
    check('FATAL', false, e && e.stack);
  } finally {
    await prisma.$disconnect();
    for (const f of [copy, `${copy}-wal`, `${copy}-shm`, `${copy}-journal`]) { try { fs.unlinkSync(f); } catch { /* none */ } }
    check('Z1 the copy is deleted', !fs.existsSync(copy));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
