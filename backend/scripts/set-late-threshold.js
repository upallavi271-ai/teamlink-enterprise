#!/usr/bin/env node
// ---------------------------------------------------------------------------
// LATE COMING threshold = 09:15 AM (user, 2026-10-09).
//
//   node scripts/set-late-threshold.js                 DRY RUN on the real dev.db: shows what would change
//   node scripts/set-late-threshold.js --apply         write it (backs the old values up first)
//   node scripts/set-late-threshold.js --undo          put the backed-up old values back
//   --db <file>   use another database file (e.g. prisma/sandbox.db)
//   --time HH:MM  another time (default 09:15)
//
// What it changes (and nothing else):
//   HrConfig.graceTime            "Late after" clock time   (09:30 -> 09:15)
//   HrConfig.graceTimeMinutes     the older minutes-after-start reading (-> 15)
//   Integration "attendance-alerts" .graceMinutes  the Late-login alert (30 -> 15)
// Attendance rows, punches and payroll records are NOT rewritten: Late is
// worked out when a screen is read, so every screen, KPI and the payroll late
// cut follow the new time from the next read. Payslips already generated keep
// their figures.
// The backup is a small JSON file in backend/backups/ (late-threshold-<time>.json).
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

const TIME = arg('--time') || '09:15';
if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(TIME)) { console.error('--time must look like 09:15'); process.exit(1); }
const [h, m] = TIME.split(':').map(Number);
const MINUTES = h * 60 + m - 540; // minutes after a 09:00 start
const prisma = new PrismaClient();
const BACKUPS = path.join(BACK, 'backups');

async function main() {
  const cfg = await prisma.hrConfig.findFirst();
  const alerts = await prisma.integration.findUnique({ where: { id: 'attendance-alerts' } });
  let alertVals = null;
  try { alertVals = alerts && alerts.values ? JSON.parse(alerts.values) : null; } catch { alertVals = null; }
  console.log(`Database: ${DB}`);
  if (!cfg) { console.log('No HrConfig row - nothing to change.'); return; }

  if (has('--undo')) {
    const files = fs.existsSync(BACKUPS) ? fs.readdirSync(BACKUPS).filter((f) => /^late-threshold-.*\.json$/.test(f)).sort() : [];
    const file = arg('--file') ? path.resolve(arg('--file')) : (files.length ? path.join(BACKUPS, files[files.length - 1]) : null);
    if (!file || !fs.existsSync(file)) { console.log('No backup file found (backend/backups/late-threshold-*.json).'); return; }
    const b = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (path.resolve(b.db) !== DB) { console.log(`That backup belongs to ${b.db}, not this database - refusing.`); return; }
    await prisma.hrConfig.update({ where: { id: cfg.id }, data: { graceTime: b.graceTime, graceTimeMinutes: b.graceTimeMinutes } });
    if (b.alertsValues !== undefined && alerts) await prisma.integration.update({ where: { id: 'attendance-alerts' }, data: { values: b.alertsValues } });
    console.log(`UNDONE from ${path.basename(file)}: graceTime ${cfg.graceTime} -> ${b.graceTime}, graceTimeMinutes ${cfg.graceTimeMinutes} -> ${b.graceTimeMinutes}${b.alertsValues !== undefined ? ', alert grace restored' : ''}.`);
    return;
  }

  const plan = [
    ['HrConfig.graceTime (Late after)', cfg.graceTime, TIME],
    ['HrConfig.graceTimeMinutes', cfg.graceTimeMinutes, MINUTES],
    ['attendance-alerts graceMinutes (Late-login alert)', alertVals ? alertVals.graceMinutes : '(no saved alert settings - default follows graceTime)', alertVals ? MINUTES : '(unchanged)'],
  ];
  plan.forEach(([k, a, b]) => console.log(`  ${k}: ${a} -> ${b}${String(a) === String(b) ? '   (already)' : ''}`));
  if (cfg.graceTime === TIME && cfg.graceTimeMinutes === MINUTES && (!alertVals || alertVals.graceMinutes === MINUTES)) { console.log('Already set - nothing to do.'); return; }
  if (!has('--apply')) { console.log('\nDRY RUN - nothing was written. Add --apply to write it (an --undo restores the old values).'); return; }

  fs.mkdirSync(BACKUPS, { recursive: true });
  const file = path.join(BACKUPS, `late-threshold-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({
    db: DB, at: new Date().toISOString(), graceTime: cfg.graceTime, graceTimeMinutes: cfg.graceTimeMinutes,
    ...(alerts ? { alertsValues: alerts.values } : {}),
  }, null, 2));
  await prisma.hrConfig.update({ where: { id: cfg.id }, data: { graceTime: TIME, graceTimeMinutes: MINUTES } });
  if (alerts && alertVals) await prisma.integration.update({ where: { id: 'attendance-alerts' }, data: { values: JSON.stringify({ ...alertVals, graceMinutes: MINUTES }) } });
  await prisma.auditLog.create({ data: { action: 'Late coming time changed', entity: 'HrConfig', entityId: cfg.id, fromValue: cfg.graceTime, toValue: TIME, reason: 'HRMS spec 2026-10-09 (scripts/set-late-threshold.js)' } }).catch(() => {});
  console.log(`\nAPPLIED. Backup: ${file}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
