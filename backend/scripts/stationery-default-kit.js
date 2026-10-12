#!/usr/bin/env node
// ---------------------------------------------------------------------------
// DEFAULT STATIONERY KIT for the people who are ACTIVE now (user, 2026-10-09:
// "every active employee gets one notepad and one pen").
//
//   node scripts/stationery-default-kit.js                 DRY RUN: who would get what; writes nothing
//   node scripts/stationery-default-kit.js --apply         give it (backup of the new rows first)
//   node scripts/stationery-default-kit.js --undo          remove exactly the rows the last --apply made
//   --db <file>   another database (default prisma/dev.db)
//   --list        also print every name
//
// The kit is the setting on Employee Services -> Stationery (default Notepad 1 +
// Pen 1). ACTIVE = status Active or On Probation; Notice Period / Exit Process /
// Relieved / Exited are left out; the system Super Admin is not an employee;
// test logins are left out. Idempotent: a person who already has a kit row
// ("default-kit" marker) for an item is skipped, so running it twice adds
// nothing. Stock is NOT touched or invented: the tiles will say "issued, stock
// not entered yet" until the real quantity is added.
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const BACK = path.resolve(__dirname, '..');
const DB = path.resolve(arg('--db') || path.join(BACK, 'prisma', 'dev.db'));
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
process.chdir(BACK);
const prisma = require('../src/db');
const KIT = require('../src/utils/stationeryKit');
const BACKUPS = path.join(BACK, 'backups');

async function main() {
  console.log(`Database: ${DB}`);
  if (has('--undo')) {
    const files = fs.existsSync(BACKUPS) ? fs.readdirSync(BACKUPS).filter((f) => /^stationery-kit-.*\.json$/.test(f)).sort() : [];
    const bf = files.length ? path.join(BACKUPS, files[files.length - 1]) : null;
    if (!bf) { console.log('No backup found.'); return; }
    const b = JSON.parse(fs.readFileSync(bf, 'utf8'));
    if (path.resolve(b.db) !== DB) { console.log(`That backup belongs to ${b.db}.`); return; }
    const taken = await prisma.stationeryIssue.count({ where: { kind: 'RETURN', employeeId: { in: [...new Set(b.rows.map((r) => r.employeeId))] }, createdAt: { gte: new Date(b.at) } } });
    if (taken) { console.log(`${taken} of those kits were taken back since - undo refused (nothing changed).`); return; }
    const r = await prisma.stationeryIssue.deleteMany({ where: { id: { in: b.rows.map((x) => x.id) } } });
    await prisma.auditLog.deleteMany({ where: { entityId: KIT.BATCH, reason: `script run ${b.at}` } });
    console.log(`UNDONE: ${r.count} kit row(s) removed (${path.basename(bf)}).`);
    return;
  }
  const kit = await KIT.getKit({ create: has('--apply') });
  const p = await KIT.missingPlan({ peek: !has('--apply') });
  console.log(`Kit: ${p.what || '(no usable item)'}  -  setting is ${kit.on ? 'ON' : 'OFF'}`);
  console.log(`Active people (not counting test logins): ${p.people}`);
  console.log(`  ${p.need.length} will get the kit, ${p.already} already have it.`);
  const left = await prisma.employee.groupBy({ by: ['employmentStatus'], _count: { _all: true } });
  console.log(`  Not included (status): ${left.filter((x) => !KIT.ACTIVE.includes(x.employmentStatus)).map((x) => `${x.employmentStatus} ${x._count._all}`).join(', ')}`);
  if (has('--list')) p.need.forEach((e) => console.log(`    ${e.person.employeeCode || '-'}  ${e.person.name}  (${e.person.department || '-'})  <- ${e.lines.map((l) => `${l.quantity} ${l.name}`).join(' + ')}`));
  const stock = await prisma.stationeryStock.groupBy({ by: ['itemId'], _sum: { quantity: true } });
  console.log(`  Stock entered so far: ${stock.length ? stock.map((s) => `${s._sum.quantity}`).join(', ') : 'none'} (the tiles will warn "stock not entered yet" until the real quantity is added).`);
  if (!has('--apply')) { console.log('\nDRY RUN - nothing was written. Add --apply to give it (backup first; --undo removes exactly those rows).'); return; }
  if (!kit.on) { console.log('The kit is switched OFF - switch it on in the app first.'); return; }
  if (!p.need.length) { console.log('Nothing to give.'); return; }
  const at = new Date().toISOString();
  const ids = await KIT.giveTo(p.need, { id: null, name: 'Default kit (backfill script)' });
  const rows = await prisma.stationeryIssue.findMany({ where: { id: { in: ids } }, select: { id: true, employeeId: true, itemId: true, quantity: true } });
  fs.mkdirSync(BACKUPS, { recursive: true });
  const bf = path.join(BACKUPS, `stationery-kit-${at.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(bf, JSON.stringify({ db: DB, at, rows }, null, 2));
  await prisma.auditLog.createMany({ data: p.need.map((e) => ({ actorName: 'Default kit (backfill script)', action: 'Stationery default kit given', entity: 'StationeryIssue', entityId: KIT.BATCH, toValue: `${e.lines.map((l) => `${l.quantity} ${l.name}`).join(' + ')} to ${e.person.name}`, reason: `script run ${at}` })) }).catch(() => {});
  console.log(`\nAPPLIED: ${rows.length} kit row(s) for ${p.need.length} people. Backup: ${bf}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
