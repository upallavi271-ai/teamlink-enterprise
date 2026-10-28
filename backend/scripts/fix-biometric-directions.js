// ---------------------------------------------------------------------------
// PUT EVERY DEVICE PUNCH BACK ON THE KEY THAT WAS PRESSED (owner, 2026-10-26).
//
// From 25 Oct a device punch's In / Out was decided by its position in the day
// ("first In, the rest Out", then "intervals"), so a second Check-In press
// showed as a check-out. The rule is now the key pressed on the device
// (utils/biometricDevice.js settledDirections). New punches follow it, and a
// day is re-settled on its next punch — this script settles the days that
// will not get another punch.
//
// For every Biometric punch whose recorded device state says another
// direction than the one stored: the direction is corrected and that person's
// day is re-marked (punch-in / punch-out / Present-Late), exactly as a new
// punch would. Times HR or the Super Admin set by hand still stand.
// Nothing is created or deleted. Dry run by default; --commit writes, audited.
//
//   node scripts/fix-biometric-directions.js [--from YYYY-MM-DD] [--commit]
// ---------------------------------------------------------------------------

const prisma = require('../src/db');
const { logAudit } = require('../src/utils/audit');
const { directionFromState } = require('../src/utils/attendanceMath');
const bio = require('../src/utils/biometricDevice');

const COMMIT = process.argv.includes('--commit');
const fromArg = process.argv.indexOf('--from');
const FROM = fromArg > 0 ? process.argv[fromArg + 1] : null;
const pad = (s, n) => String(s ?? '').padEnd(n);
const KEY_NAME = { 0: 'Check-In', 1: 'Check-Out', 2: 'Break-Out', 3: 'Break-In', 4: 'OT-In', 5: 'OT-Out' };

(async () => {
  console.log(COMMIT ? '*** COMMIT ***\n' : '*** DRY RUN — nothing will be written ***\n');
  const punches = await prisma.attendancePunch.findMany({
    where: { method: 'Biometric', deviceState: { not: null }, ...(FROM ? { date: { gte: FROM } } : {}) },
    select: {
      id: true, employeeId: true, date: true, time: true, clockTime: true, direction: true, deviceState: true,
      employee: { select: { employeeCode: true, name: true } },
    },
    orderBy: [{ date: 'asc' }, { clockTime: 'asc' }],
  });

  // What the device actually sends — if it never sends a Check-Out key (1),
  // nobody is pressing it, and no day will have a punch-out from the device.
  const byKey = new Map();
  punches.forEach((p) => byKey.set(String(p.deviceState), (byKey.get(String(p.deviceState)) || 0) + 1));
  console.log(`DEVICE PUNCHES ${FROM ? `from ${FROM}` : '(all)'}: ${punches.length}`);
  [...byKey.entries()].sort().forEach(([k, n]) => console.log(`  key ${k} ${pad(`(${KEY_NAME[k] || 'other'})`, 13)} ${n}`));

  // 2026-10-28: the day is settled as a whole (bio.settledDirections) - the key pressed, and the evening "Check-In" press of a device left
  // in Check-In mode counts as the check-out. All punches of each person-day are read (a web check-in in the morning counts as "earlier").
  const cfg = await prisma.hrConfig.findFirst().catch(() => null);
  const split = require('../src/utils/attendanceDays').policyTimes(cfg || {}).split; // eslint-disable-line global-require
  const dayKeys = [...new Set(punches.map((p) => `${p.employeeId}|${p.date}`))];
  const wantOf = new Map();
  for (const k of dayKeys) {
    const [employeeId, date] = k.split('|');
    // eslint-disable-next-line no-await-in-loop
    const all = await prisma.attendancePunch.findMany({ where: { employeeId, date }, select: { id: true, time: true, clockTime: true, method: true, direction: true, deviceState: true } });
    bio.settledDirections(all, split).forEach((dir, id) => wantOf.set(id, dir));
  }
  punches.forEach((p) => { p.want = wantOf.get(p.id) || directionFromState(p.deviceState); });
  const wrong = punches.filter((p) => String(p.deviceState).trim() !== '' && p.want !== p.direction);
  console.log(`\nPUNCHES SHOWN THE WRONG WAY (${wrong.length})`);
  console.log('  ' + pad('CODE', 10) + pad('NAME', 26) + pad('DATE', 12) + pad('TIME', 10) + pad('KEY PRESSED', 14) + 'SHOWN -> CORRECT');
  wrong.forEach((p) => console.log('  ' + pad(p.employee && p.employee.employeeCode, 10) + pad(String((p.employee && p.employee.name) || '').slice(0, 24), 26)
    + pad(p.date, 12) + pad(p.clockTime || p.time, 10) + pad(KEY_NAME[p.deviceState] || p.deviceState, 14) + `${p.direction} -> ${p.want}`));

  const days = new Map();
  wrong.forEach((p) => days.set(`${p.employeeId}|${p.date}`, { employeeId: p.employeeId, date: p.date }));
  console.log(`\n  ${days.size} person-day(s) to re-mark.`);

  if (!COMMIT) {
    console.log('\nDRY RUN — re-run with --commit to correct them.');
    process.exit(0);
  }
  for (const p of wrong) {
    const to = p.want;
    // eslint-disable-next-line no-await-in-loop
    await prisma.attendancePunch.update({ where: { id: p.id }, data: { direction: to } });
    // eslint-disable-next-line no-await-in-loop
    await logAudit({
      action: `Device punch direction set by the key pressed (${KEY_NAME[p.deviceState] || p.deviceState})`,
      entity: 'AttendancePunch', entityId: p.id, fromValue: p.direction, toValue: to,
    });
  }
  for (const d of days.values()) {
    // eslint-disable-next-line no-await-in-loop
    await bio.remarkDay(d.employeeId, d.date);
  }
  console.log(`\n${wrong.length} punch(es) corrected, ${days.size} day(s) re-marked.`);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
