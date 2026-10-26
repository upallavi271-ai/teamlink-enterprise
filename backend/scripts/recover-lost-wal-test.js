#!/usr/bin/env node
// Proves scripts/recover-lost-wal.js on throw-away copies of the sandbox database (never the real one):
//   an "old backend" database in WAL mode gets a new row, a changed row and a removed row that live ONLY in its -wal file;
//   the "kept" copy (dev.db alone, what the buggy deploy carried) becomes the live database; then live changes on its own;
//   the script must put back exactly the lost rows and leave alone the row that changed again after the deploy.
//   cd backend && node scripts/recover-lost-wal-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const SRC = path.join(BACK, 'prisma', 'sandbox.db');
const W = path.join(os.tmpdir(), `rwt-${Date.now().toString(36)}`);
const oldDir = path.join(W, 'old'); const liveDir = path.join(W, 'live');
fs.mkdirSync(oldDir, { recursive: true }); fs.mkdirSync(liveDir, { recursive: true });
let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d !== undefined ? `  -> ${JSON.stringify(d).slice(0, 400)}` : ''}`); };
const url = (p) => `file:${p.split(path.sep).join('/')}?connection_limit=1`;

(async () => {
  const { PrismaClient } = require(path.join(BACK, 'node_modules/@prisma/client'));
  // a clean copy of the sandbox
  const src = new PrismaClient({ datasources: { db: { url: url(SRC) } } });
  await src.$executeRawUnsafe(`VACUUM INTO '${path.join(oldDir, 'dev.db').split(path.sep).join('/')}'`);
  await src.$disconnect();

  // the "running server" on the old database: WAL mode, no automatic checkpoint, three writes that stay in the WAL
  const old = new PrismaClient({ datasources: { db: { url: url(path.join(oldDir, 'dev.db')) } } });
  await old.$queryRawUnsafe('PRAGMA journal_mode=WAL');
  await old.$queryRawUnsafe('PRAGMA wal_autocheckpoint=0');
  await old.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)'); // start from an empty WAL
  const tag = `ZZTEST RWT ${Date.now().toString(36)}`;
  const h1 = await old.holiday.create({ data: { name: `${tag} new`, date: '2099-01-01' } });
  const h2 = await old.holiday.create({ data: { name: `${tag} change-me`, date: '2099-01-02' } });
  const h3 = await old.holiday.create({ data: { name: `${tag} remove-me`, date: '2099-01-03' } });
  const h4 = await old.holiday.create({ data: { name: `${tag} touched-later`, date: '2099-01-04' } });
  await old.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)'); // h2, h3, h4 are now in dev.db itself ("before the deploy")
  await old.holiday.delete({ where: { id: h1.id } });
  const h5 = await old.holiday.create({ data: { name: `${tag} lost-new`, date: '2099-01-05' } }); // only in the WAL
  await old.holiday.update({ where: { id: h2.id }, data: { name: `${tag} changed` } }); // only in the WAL
  await old.holiday.delete({ where: { id: h3.id } }); // only in the WAL
  await old.holiday.update({ where: { id: h4.id }, data: { name: `${tag} touched-in-wal` } }); // only in the WAL
  // THE BUGGY DEPLOY: dev.db alone is carried over (the WAL is not), while the old server still holds the database open
  fs.copyFileSync(path.join(oldDir, 'dev.db'), path.join(liveDir, 'dev.db'));
  check('setup: the WAL really holds the writes', fs.existsSync(path.join(oldDir, 'dev.db-wal')) && fs.statSync(path.join(oldDir, 'dev.db-wal')).size > 0);

  // the new site changes h4 on its own after the deploy -> a conflict the script must not overwrite
  const live = new PrismaClient({ datasources: { db: { url: url(path.join(liveDir, 'dev.db')) } } });
  const lostBefore = await live.holiday.findUnique({ where: { id: h5.id } });
  check('setup: the live copy really lost the new row', !lostBefore);
  await live.holiday.update({ where: { id: h4.id }, data: { name: `${tag} touched-after-deploy` } });
  await live.$disconnect();

  const run = (extra) => spawnSync(process.execPath, [path.join(__dirname, 'recover-lost-wal.js'), '--old', oldDir, '--db', path.join(liveDir, 'dev.db'), '--work', path.join(W, `work-${extra.length}`), ...extra], { encoding: 'utf8', cwd: BACK });
  const dry = run([]);
  check('dry run lists Holiday with 1 new, 2 changed, 1 removed and 1 conflict', dry.status === 0 && /Holiday\s+1 \/\s+2 \/\s+1\s+1 \/\s+1 \/\s+1\s+1/.test(dry.stdout), dry.stdout + dry.stderr);
  const live2 = new PrismaClient({ datasources: { db: { url: url(path.join(liveDir, 'dev.db')) } } });
  check('the dry run wrote nothing', !(await live2.holiday.findUnique({ where: { id: h5.id } })));
  await live2.$disconnect();
  const app = run(['--apply']);
  check('apply succeeds', app.status === 0 && /DONE: 3 row/.test(app.stdout), app.stdout + app.stderr);
  const live3 = new PrismaClient({ datasources: { db: { url: url(path.join(liveDir, 'dev.db')) } } });
  const [r5, r2, r3, r4] = await Promise.all([h5, h2, h3, h4].map((h) => live3.holiday.findUnique({ where: { id: h.id } })));
  check('the lost NEW row is back, exactly', !!r5 && r5.name === `${tag} lost-new` && r5.date === '2099-01-05', r5);
  check('the lost CHANGE is back', !!r2 && r2.name === `${tag} changed`, r2);
  check('the lost REMOVAL is done', !r3, r3);
  check('the row changed again after the deploy is left alone (conflict)', !!r4 && r4.name === `${tag} touched-after-deploy`, r4);
  await live3.$disconnect();
  await old.$disconnect();
  fs.rmSync(W, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL crashed', e.stack.slice(0, 800)); process.exit(1); });
