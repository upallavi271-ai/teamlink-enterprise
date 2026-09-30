// ---------------------------------------------------------------------------
// REMOVE THE LEFTOVER LOGINS.
//
// The 292 employees are gone; these 39 accounts are what was left behind —
// seed data (@teamlink.test, @teamlink.com) plus a handful of real addresses.
// They are being cleared so the PulseHRM import starts from nothing.
//
// ONE LOGIN IS KEPT, AND THIS IS NOT NEGOTIABLE.
//
// Deleting every account locks everybody out of the application, including
// whoever is running this script, and there is then no way back in through the
// UI — the only route left is editing the database by hand. So one Super Admin
// survives by default. Pass --keep <email> to choose which; the default is the
// most recently used Super Admin, which is almost always the live session.
//
// Pass --all to delete every login including that one. It refuses unless
// --i-understand-this-locks-me-out is also given, because somebody will
// eventually run it by accident and that is the day it matters.
//
// WHAT HAPPENS TO THE THINGS THAT POINT AT A USER
//   AuditLog    userId is nulled; actorName is already snapshotted on the row,
//               so the trail still says who did what. History is not lost.
//   Notification rows belonging to a deleted user are deleted with them — a
//               notification for somebody who no longer exists is noise.
//   Requirement recruiterId / bdeId are checked first and reported. None are
//               set today, but the check runs anyway rather than assuming.
//
// Dry run by default. --commit writes. Every deleted row is backed up first.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const prisma = require('../src/db');

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const ALL = argv.includes('--all');
const CONFIRMED_LOCKOUT = argv.includes('--i-understand-this-locks-me-out');
const keepArg = (() => {
  const i = argv.indexOf('--keep');
  return i >= 0 ? argv[i + 1] : null;
})();

const pad = (s, n) => String(s).padEnd(n);

(async () => {
  const users = await prisma.user.findMany({
    select: { id: true, email: true, name: true, role: true, lastLoginAt: true },
    orderBy: { lastLoginAt: 'desc' },
  });
  if (!users.length) { console.log('No logins to remove.'); process.exit(0); }

  // ---- decide what survives ------------------------------------------------
  // --keep takes one address or several, comma separated. Keeping more than
  // one matters when it is not certain which account the live session is on:
  // guessing wrong locks somebody out of their own system, and keeping a
  // spare admin for ten minutes costs nothing.
  let kept = [];
  if (!ALL) {
    if (keepArg) {
      const wanted = String(keepArg).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      kept = users.filter((u) => wanted.includes(String(u.email).toLowerCase()));
      const missing = wanted.filter((w) => !kept.some((u) => String(u.email).toLowerCase() === w));
      if (missing.length) {
        console.error(`No login found for: ${missing.join(', ')}. Nothing was changed.`);
        process.exit(1);
      }
    } else {
      const fallback = users.find((u) => u.role === 'SUPER_ADMIN' && u.lastLoginAt)
        || users.find((u) => u.role === 'SUPER_ADMIN')
        || users[0];
      kept = fallback ? [fallback] : [];
    }
    if (!kept.length) {
      console.error('Nothing would survive. Refusing rather than locking you out.');
      process.exit(1);
    }
  } else if (!CONFIRMED_LOCKOUT) {
    console.error('--all deletes EVERY login and locks you out of the application.');
    console.error('Re-run with --i-understand-this-locks-me-out if that is really what you want.');
    process.exit(1);
  }

  const keptIds = new Set(kept.map((u) => u.id));
  const doomed = users.filter((u) => !keptIds.has(u.id));

  console.log(COMMIT ? '*** COMMIT ***\n' : '*** DRY RUN — nothing will be written ***\n');
  console.log(`logins found : ${users.length}`);
  console.log(`will delete  : ${doomed.length}`);
  const keptLabel = kept.length
    ? kept.map((u) => `${u.email}  (${u.role})`).join('\n               ')
    : 'NOTHING — full lockout';
  console.log(`will keep    : ${keptLabel}\n`);

  // ---- what points at them -------------------------------------------------
  const ids = doomed.map((u) => u.id);
  const [reqRecruiter, reqBde, audits, notifs] = await Promise.all([
    prisma.requirement.count({ where: { recruiterId: { in: ids } } }),
    prisma.requirement.count({ where: { bdeId: { in: ids } } }),
    prisma.auditLog.count({ where: { userId: { in: ids } } }),
    prisma.notification.count({ where: { userId: { in: ids } } }),
  ]);
  console.log('REFERENCES TO THE DOOMED LOGINS');
  console.log('  ' + pad('requirements.recruiterId', 30) + String(reqRecruiter).padStart(6) + (reqRecruiter ? '   <- will be cleared' : ''));
  console.log('  ' + pad('requirements.bdeId', 30) + String(reqBde).padStart(6) + (reqBde ? '   <- will be cleared' : ''));
  console.log('  ' + pad('auditLog.userId', 30) + String(audits).padStart(6) + '   <- nulled; actorName keeps the trail');
  console.log('  ' + pad('notification.userId', 30) + String(notifs).padStart(6) + '   <- deleted with the user');

  if (!COMMIT) {
    console.log('\nTO BE DELETED:');
    doomed.forEach((u) => console.log('  ' + pad(u.email, 40) + pad(u.role, 14)
      + (u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('en-GB') : 'never signed in')));
    console.log('\nDRY RUN — re-run with --commit to apply.');
    process.exit(0);
  }

  // ---- back up -------------------------------------------------------------
  const dir = path.join(__dirname, '..', 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `users-before-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({
    takenAt: new Date().toISOString(),
    kept: kept.map((u) => u.email),
    users: await prisma.user.findMany({ where: { id: { in: ids } } }),
    notifications: await prisma.notification.findMany({ where: { userId: { in: ids } } }),
  }, null, 2));
  console.log('\nbackup written: ' + file);

  // ---- detach, then delete -------------------------------------------------
  if (reqRecruiter) await prisma.requirement.updateMany({ where: { recruiterId: { in: ids } }, data: { recruiterId: null } });
  if (reqBde) await prisma.requirement.updateMany({ where: { bdeId: { in: ids } }, data: { bdeId: null } });
  await prisma.auditLog.updateMany({ where: { userId: { in: ids } }, data: { userId: null } });
  await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  const gone = await prisma.user.deleteMany({ where: { id: { in: ids } } });

  console.log(`\ndeleted ${gone.count} login(s).`);
  const left = await prisma.user.findMany({ select: { email: true, role: true } });
  console.log('remaining:');
  left.forEach((u) => console.log('  ' + pad(u.email, 40) + u.role));

  // ---- prove the rest is untouched ----------------------------------------
  console.log('\nUNTOUCHED:');
  for (const m of ['client', 'requirement', 'candidate', 'application', 'invoice', 'auditLog']) {
    console.log('  ' + pad(m, 16) + String(await prisma[m].count()).padStart(7));
  }
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
