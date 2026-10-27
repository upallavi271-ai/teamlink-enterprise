#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop */
// ---------------------------------------------------------------------------
// HRMS DASHBOARD DATA FIXES (founder 2026-10-27):
//   1. "reporting manager lo R&D TL Mrudula ledhu add chey" - asked: make her the reporting manager of the 3 R&D people who have none
//      (Durga Nagendra, Gujjula Velangini Keerthi, sravanthi Mangalapalli). Only a person with NO reporting manager is changed; the
//      leave approval chain does not move (it reads the TL name typed on the employee first, then the department's TL).
//   2. "paina unna demo announcements remove chey" - the three demo / test notices on the Announcements page are deleted, with the bell
//      notifications they made: "Diwali Holiday Schedule" and "Updated WFH Policy" (rows from prisma/seed.js: poster text "Vasu (Admin)", no user id) and
//      "[AI-TEST] Office closed Friday". Matched by exact title AND no poster / the [AI-TEST] tag - a real notice is never touched.
//
//   node scripts/hrms-dashboard-fixes-2026-10-27.js                                   DRY RUN
//   TL_ALLOW_REAL_APPLY=1 node scripts/hrms-dashboard-fixes-2026-10-27.js --apply --really-real
// SAFETY: VACUUM INTO backup first; one transaction; running it twice changes nothing new.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
if (APPLY && !(argv.includes('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: this writes to the REAL database. It needs --really-real AND TL_ALLOW_REAL_APPLY=1.');
  process.exit(2);
}
const BACK = path.resolve(__dirname, '..');
process.chdir(BACK);
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const MANAGER = 'Banka Mrudula';
const REPORTS = ['Durga Nagendra', 'Gujjula Velangini Keerthi', 'sravanthi Mangalapalli'];
const DEMO = [
  { title: 'Diwali Holiday Schedule', seed: true },
  { title: 'Updated WFH Policy', seed: true },
  { title: '[AI-TEST] Office closed Friday', seed: false },
];
const LIVE = ['Active', 'Notice Period'];
const lc = (s) => String(s || '').trim().toLowerCase();

(async () => {
  try {
    const mgr = (await prisma.employee.findMany({ where: { department: 'R&D', employmentStatus: { in: LIVE } }, select: { id: true, name: true } }))
      .filter((e) => lc(e.name) === lc(MANAGER));
    if (mgr.length !== 1) { console.log(`Reporting manager: ${mgr.length ? 'more than one' : 'no'} working "${MANAGER}" in R&D - step 1 skipped.`); }
    const people = mgr.length === 1 ? (await prisma.employee.findMany({ where: { department: 'R&D', employmentStatus: { in: LIVE } }, select: { id: true, name: true, reportingManagerId: true } }))
      .filter((e) => REPORTS.some((n) => lc(n) === lc(e.name))) : [];
    const toSet = people.filter((e) => !e.reportingManagerId);
    console.log(`1. ${MANAGER} as reporting manager: ${toSet.length} to set (${toSet.map((e) => e.name).join(', ') || '-'}); already have one: ${people.length - toSet.length}`);

    const anns = await prisma.announcement.findMany({ select: { id: true, title: true, postedById: true, postedBy: true, createdAt: true } });
    const del = anns.filter((a) => DEMO.some((d) => d.title === a.title.trim() && (d.seed ? !a.postedById && (!a.postedBy || a.postedBy === 'Vasu (Admin)') : /^\[AI-TEST\]/.test(a.title))));
    const notes = [];
    for (const a of del) {
      const n = await prisma.notification.findMany({ where: { title: `Announcement: ${a.title}`, createdAt: { gte: new Date(new Date(a.createdAt).getTime() - 60000), lte: new Date(new Date(a.createdAt).getTime() + 10 * 60000) } }, select: { id: true } });
      notes.push(...n.map((x) => x.id));
    }
    console.log(`2. demo announcements to delete: ${del.length} (${del.map((a) => a.title).join(' | ') || '-'}), with ${notes.length} bell notification(s)`);
    if (!APPLY) { console.log('\nDRY RUN: nothing was changed.'); return; }
    if (!toSet.length && !del.length) { console.log('\nNothing to do.'); return; }

    const dir = path.join(os.homedir(), '.teamlink-backups', `hrms-dashboard-fixes-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(dir, { recursive: true });
    const bak = path.join(dir, 'before.db');
    await prisma.$executeRawUnsafe(`VACUUM INTO '${bak.split(path.sep).join('/').replace(/'/g, "''")}'`);
    await prisma.$transaction(async (tx) => {
      for (const e of toSet) {
        await tx.employee.update({ where: { id: e.id }, data: { reportingManagerId: mgr[0].id } });
        await tx.auditLog.create({ data: { action: 'Reporting manager set', entity: 'Employee', entityId: e.id, fromValue: '-', toValue: MANAGER, actorName: 'HRMS dashboard fixes 2026-10-27' } });
      }
      if (notes.length) await tx.notification.deleteMany({ where: { id: { in: notes } } });
      for (const a of del) {
        await tx.announcement.delete({ where: { id: a.id } });
        await tx.auditLog.create({ data: { action: 'Announcement deleted (demo)', entity: 'Announcement', entityId: a.id, fromValue: a.title, actorName: 'HRMS dashboard fixes 2026-10-27' } });
      }
    });
    console.log(`\nDONE: ${toSet.length} reporting manager(s) set, ${del.length} demo announcement(s) and ${notes.length} notification(s) deleted.\nBackup: ${bak}`);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(String(e && e.stack ? e.stack : e).slice(0, 900)); process.exit(1); });
