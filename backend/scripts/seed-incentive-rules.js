#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE FIRST INCENTIVE RULES (user answers, 2026-10-09):
//   BDE, Manufacturing and Education: the SAME rule - a monthly target of 4
//   joinings; when a month falls short the missing ones are carried to the next
//   month's target; the incentive is earned when the month's target is
//   completed. NO AMOUNT is set (Super Admin gives it each time).
//   MEDICAL: no rule (the user will give it later) - nothing is created for it.
//
//   node scripts/seed-incentive-rules.js                 DRY RUN: what would be created
//   node scripts/seed-incentive-rules.js --apply         create them (backup list first)
//   node scripts/seed-incentive-rules.js --undo          remove exactly the rules it created
//   --from YYYY-MM   the month counting starts from (default 2026-10: nothing is carried from before it)
//   --db <file>      another database (default prisma/dev.db)
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
const { PrismaClient } = require('@prisma/client');

const FROM = arg('--from') || '2026-10';
if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(FROM)) { console.error('--from must look like 2026-10'); process.exit(1); }
const DEPARTMENTS = ['Education', 'Manufacturing', 'BDE'];
const prisma = new PrismaClient();
const BACKUPS = path.join(BACK, 'backups');
const TAG = 'Seeded from the user\'s answers 2026-10-09 (scripts/seed-incentive-rules.js)';

async function main() {
  console.log(`Database: ${DB}`);
  if (has('--undo')) {
    const files = fs.existsSync(BACKUPS) ? fs.readdirSync(BACKUPS).filter((f) => /^incentive-rules-seed-.*\.json$/.test(f)).sort() : [];
    const bf = files.length ? path.join(BACKUPS, files[files.length - 1]) : null;
    if (!bf) { console.log('No seed backup found.'); return; }
    const b = JSON.parse(fs.readFileSync(bf, 'utf8'));
    if (path.resolve(b.db) !== DB) { console.log(`That backup belongs to ${b.db}.`); return; }
    const used = await prisma.incentiveAward.count({ where: { ruleId: { in: b.created } } });
    if (used) { console.log(`${used} award(s) were already made under these rules - not removing them (switch the rules off instead).`); return; }
    const r = await prisma.incentiveRule.deleteMany({ where: { id: { in: b.created } } });
    console.log(`UNDONE: ${r.count} rule(s) removed (${path.basename(bf)}).`);
    return;
  }
  const have = await prisma.incentiveRule.findMany({ where: { metric: 'JOININGS', carryForward: true } });
  const plan = DEPARTMENTS.map((d) => ({ department: d, exists: have.some((r) => (r.department || '').toLowerCase() === d.toLowerCase()) }));
  plan.forEach((p) => console.log(`  ${p.department}: ${p.exists ? 'already has this rule - skipped' : `CREATE  target 4 a month, carry the missing ones forward, counting from ${FROM}, amount not set`}`));
  console.log('  Medical: no rule (the user will give it later) - nothing created; the screens say "Rule not set yet: Super Admin will add it".');
  if (!has('--apply')) { console.log('\nDRY RUN - nothing was written. Add --apply to create them (--undo removes exactly those).'); return; }
  const todo = plan.filter((p) => !p.exists);
  if (!todo.length) { console.log('Nothing to create.'); return; }
  const created = [];
  for (const p of todo) {
    // eslint-disable-next-line no-await-in-loop
    const r = await prisma.incentiveRule.create({
      data: {
        name: `${p.department} - 4 joinings a month, missing ones carried forward`, department: p.department, metric: 'JOININGS', basis: 'COMPLETION',
        minAchieved: 0, target: 4, amount: 0, carryForward: true, fromMonth: FROM, active: true, note: TAG, createdByName: 'Seed script',
      },
    });
    created.push(r.id);
    // eslint-disable-next-line no-await-in-loop
    await prisma.auditLog.create({ data: { action: 'Incentive rule added', entity: 'IncentiveRule', entityId: r.id, toValue: `${r.name} (seeded)`, reason: TAG } }).catch(() => {});
  }
  fs.mkdirSync(BACKUPS, { recursive: true });
  const bf = path.join(BACKUPS, `incentive-rules-seed-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(bf, JSON.stringify({ db: DB, at: new Date().toISOString(), created }, null, 2));
  console.log(`\nAPPLIED: ${created.length} rule(s) created. Backup: ${bf}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
