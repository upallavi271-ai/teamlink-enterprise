#!/usr/bin/env node
/**
 * The video cards' first set-up on a server that already has finished uploads (live 2026-11-17: it waited for itself and never finished,
 * so the card table was never made and the Videos list and the uploads list never loaded). SANDBOX ONLY: a COPY of the sandbox database.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/crm-video-cards-backfill-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SOURCE = process.env.TEST_SOURCE_DB || path.resolve(__dirname, '..', 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-vcb-${process.pid}.db`).split(path.sep).join('/');
const VID = path.join(os.tmpdir(), `zz-vcb-vid-${process.pid}`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY}'`);
src.close();
fs.mkdirSync(path.join(VID, 'sources'), { recursive: true });
// what live had: two finished uploads (all products, one product), a company video and an extra video, and no card table yet
const db = new DatabaseSync(COPY);
db.exec('DROP TABLE IF EXISTS "CrmVideoCard"');
db.exec(`CREATE TABLE IF NOT EXISTS "CrmVideoJob" ("id" TEXT PRIMARY KEY, "kind" TEXT NOT NULL, "productKey" TEXT, "fileName" TEXT, "size" INTEGER, "received" INTEGER NOT NULL DEFAULT 0, "status" TEXT NOT NULL,
  "step" TEXT, "duration" REAL, "transcript" TEXT, "draft" TEXT, "error" TEXT, "createdById" TEXT, "createdByName" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT)`);
const now = new Date().toISOString();
db.prepare('INSERT INTO "CrmVideoJob" ("id","kind","productKey","fileName","size","status","duration","createdByName","createdAt") VALUES (?,?,?,?,?,?,?,?,?)').run('vid_all1', 'all', null, 'S2u_X8is3h9d.mp4', 10, 'done', 938.8, 'Developer Team', now);
db.prepare('INSERT INTO "CrmVideoJob" ("id","kind","productKey","fileName","size","status","duration","createdByName","createdAt") VALUES (?,?,?,?,?,?,?,?,?)').run('vid_one1', 'single', 'OMNI', 'omni.mov', 10, 'done', 120, 'Developer Team', now);
db.close();
fs.writeFileSync(path.join(VID, 'sources', 'vid_all1.mp4'), 'x');
fs.writeFileSync(path.join(VID, 'sources', 'vid_one1.mov'), 'x');
Object.assign(process.env, { TEAMLINK_SANDBOX: '1', TEST_MODE: '1', DATABASE_URL: `file:${COPY}`, CRM_DEMO_DIR: VID });
const prisma = require('../src/db');
const VC = require('../src/crm/videoCards');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };

(async () => {
  const done = await Promise.race([VC.ensure().then(() => 'done'), new Promise((r) => { setTimeout(() => r('stuck'), 20000); })]);
  check('1 the first set-up finishes (it used to wait for itself for ever)', done === 'done', done);
  const rows = await prisma.$queryRawUnsafe('SELECT "kind","productKey","title","showOnDemo","duration" FROM "CrmVideoCard" ORDER BY "kind"');
  const full = rows.find((r) => r.kind === 'full'); const orig = rows.find((r) => r.kind === 'original');
  check('2 the finished all-products upload is a card: "S2u_X8is3h9d", 15:38, off the demo pages (longer than 5 minutes)', full && full.title === 'S2u_X8is3h9d' && Math.round(full.duration) === 939 && Number(full.showOnDemo) === 0, rows);
  check('3 the product upload is a card too (Omni-Channel, off: its clip shows)', orig && orig.productKey === 'OMNI' && Number(orig.showOnDemo) === 0, rows);
  const list = await Promise.race([VC.all().then((r) => r.length), new Promise((r) => { setTimeout(() => r('stuck'), 10000); })]);
  check('4 reading the cards afterwards answers at once', list === 2, list);
  await prisma.$disconnect();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } }
  try { fs.rmSync(VID, { recursive: true, force: true }); } catch { /* none */ }
  console.log(`\n${total - failed}/${total} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
