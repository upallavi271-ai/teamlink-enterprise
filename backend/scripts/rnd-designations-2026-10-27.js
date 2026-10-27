#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop */
// ---------------------------------------------------------------------------
// R&D DESIGNATIONS (founder 2026-10-27): only four R&D designations exist -
//   R&D TL  BANKA MRUDULA          R&D-1  G. V. KEERTHI
//   R&D-2   MANGALAPALLI SRAVANTHI R&D-3  NAGA DURGA
// 1. Each name is matched to ONE working R&D employee (same words / initials / a word's start: "NAGA DURGA" -> "Durga
//    Nagendra"). No match or two matches -> that person is skipped and reported; nobody is created.
// 2. Employee.designation is set. The designation also decides the login's product roles (utils/identity.js reads
//    DesignationRole), so each new designation gets a DesignationRole row COPIED from the role row of the person's
//    designation today (R&D TL = TL's roles, R&D-1/2/3 = Employee's) - permissions do not move. If a row of that name
//    already exists with different roles, that person is skipped and reported.
// 3. Seats: RND-1 / RND-2 (the seats Keerthi and Sravanthi sit in) are renamed R&D-1 / R&D-2 when no requirement,
//    follow-up or stage move carries the old code; the empty RND-3 seat (nobody in it) is switched off, its history kept.
// Name, ID, email, login, password, reporting manager: untouched. No employee or seat is deleted.
//
//   node scripts/rnd-designations-2026-10-27.js                                   DRY RUN
//   TL_ALLOW_REAL_APPLY=1 node scripts/rnd-designations-2026-10-27.js --apply --really-real
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
process.chdir(path.resolve(__dirname, '..'));
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const WANT = [
  { designation: 'R&D TL', name: 'BANKA MRUDULA' },
  { designation: 'R&D-1', name: 'G. V. KEERTHI' },
  { designation: 'R&D-2', name: 'MANGALAPALLI SRAVANTHI' },
  { designation: 'R&D-3', name: 'NAGA DURGA' },
];
const SEAT_RENAME = [['RND-1', 'R&D-1'], ['RND-2', 'R&D-2']];
const SEAT_OFF = ['RND-3'];
const LIVE = ['Active', 'Notice Period'];
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
// every word of the asked name is one of the employee's words: equal, an initial ("g" -> "Gujjula"), or a start of 4+ letters ("naga" -> "nagendra")
const fits = (asked, have) => {
  const pool = [...have];
  return words(asked).every((w) => {
    const i = pool.findIndex((h) => h === w || (w.length === 1 && h[0] === w) || (w.length >= 4 && h.startsWith(w)));
    if (i < 0) return false;
    pool.splice(i, 1);
    return true;
  });
};
const ROLE_KEYS = ['hrmsRole', 'accountsRole', 'atsRole', 'hrms', 'ats', 'accounts', 'landing'];
const sameRoles = (a, b) => ROLE_KEYS.every((k) => (a[k] ?? null) === (b[k] ?? null));

(async () => {
  try {
    const rnd = await prisma.employee.findMany({ where: { department: 'R&D', employmentStatus: { in: LIVE } }, select: { id: true, name: true, designation: true, employeeCode: true } });
    const roleRows = await prisma.designationRole.findMany();
    const roleOf = (d) => roleRows.find((r) => String(r.designation).trim().toLowerCase() === String(d || '').trim().toLowerCase()) || null;
    const plan = [];
    const newRoles = [];
    const skipped = [];
    const used = new Set();
    for (const w of WANT) {
      const hits = rnd.filter((e) => fits(w.name, words(e.name)) && !used.has(e.id));
      if (hits.length !== 1) { skipped.push(`${w.name} (${w.designation}): ${hits.length ? `${hits.length} matches (${hits.map((e) => e.name).join(', ')})` : 'no working R&D employee matches'} - check by hand`); continue; }
      const e = hits[0];
      used.add(e.id);
      const target = roleOf(w.designation) || newRoles.find((r) => r.designation === w.designation);
      const source = roleOf(e.designation);
      if (target && source && !sameRoles(target, source)) { skipped.push(`${e.name}: "${w.designation}" already gives other permissions than "${e.designation}" - not changed`); continue; }
      if (!target && source) newRoles.push({ designation: w.designation, ...Object.fromEntries(ROLE_KEYS.map((k) => [k, source[k]])), position: source.position, from: source.designation });
      plan.push({ e, to: w.designation, asked: w.name });
    }
    console.log('1. designations:');
    plan.forEach((p) => console.log(`   ${p.asked} -> ${p.e.name} (${p.e.employeeCode || '-'}): "${p.e.designation || '-'}" -> "${p.to}"${p.e.designation === p.to ? ' (already)' : ''}`));
    skipped.forEach((s) => console.log(`   SKIPPED ${s}`));
    rnd.filter((e) => !used.has(e.id)).forEach((e) => console.log(`   other R&D employee left as is (check): ${e.name} - "${e.designation || '-'}"`));
    console.log(`2. permission rows to add (copied, same roles): ${newRoles.length ? newRoles.map((r) => `${r.designation} = ${r.from}`).join(', ') : 'none'}`);

    const seatOps = [];
    for (const [from, to] of SEAT_RENAME) {
      const p = await prisma.position.findUnique({ where: { code: from } });
      if (!p) continue;
      if (await prisma.position.findUnique({ where: { code: to } })) { console.log(`3. seat ${from}: "${to}" already exists - left as is`); continue; }
      const refs = await prisma.requirement.count({ where: { positionCode: from } })
        + await prisma.applicationFollowUp.count({ where: { ownerPositionCode: from } })
        + await prisma.applicationStageEvent.count({ where: { actorPositionCode: from } });
      if (refs) { console.log(`3. seat ${from}: ${refs} ATS record(s) carry the code - left as is`); continue; }
      seatOps.push({ kind: 'rename', id: p.id, from, to });
    }
    for (const code of SEAT_OFF) {
      const p = await prisma.position.findUnique({ where: { code }, include: { assignments: { where: { toDate: null } } } });
      if (p && p.active && !p.assignments.length) seatOps.push({ kind: 'off', id: p.id, from: code });
    }
    console.log(`3. seats: ${seatOps.length ? seatOps.map((s) => (s.kind === 'rename' ? `${s.from} -> ${s.to}` : `${s.from} switched off (empty)`)).join(', ') : 'nothing to change'}`);

    const changes = plan.filter((p) => p.e.designation !== p.to);
    if (!APPLY) { console.log('\nDRY RUN: nothing was changed.'); return; }
    if (!changes.length && !newRoles.length && !seatOps.length) { console.log('\nNothing to do.'); return; }

    const dir = path.join(os.homedir(), '.teamlink-backups', `rnd-designations-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(dir, { recursive: true });
    const bak = path.join(dir, 'before.db');
    await prisma.$executeRawUnsafe(`VACUUM INTO '${bak.split(path.sep).join('/').replace(/'/g, "''")}'`);
    const actorName = 'R&D designations 2026-10-27';
    await prisma.$transaction(async (tx) => {
      for (const r of newRoles) {
        const { from, ...data } = r;
        await tx.designationRole.create({ data });
        await tx.auditLog.create({ data: { action: 'Designation added (same roles)', entity: 'DesignationRole', entityId: r.designation, fromValue: from, toValue: r.designation, actorName } });
      }
      for (const p of changes) {
        await tx.employee.update({ where: { id: p.e.id }, data: { designation: p.to } });
        await tx.auditLog.create({ data: { action: 'Designation changed', entity: 'Employee', entityId: p.e.id, fromValue: p.e.designation || '-', toValue: p.to, actorName } });
      }
      for (const s of seatOps) {
        if (s.kind === 'rename') await tx.position.update({ where: { id: s.id }, data: { code: s.to, name: `R&D seat ${s.to}` } });
        else await tx.position.update({ where: { id: s.id }, data: { active: false } });
        await tx.auditLog.create({ data: { action: s.kind === 'rename' ? 'Seat renamed' : 'Seat switched off (empty)', entity: 'Position', entityId: s.id, fromValue: s.from, toValue: s.to || 'off', actorName } });
      }
    });
    console.log(`\nDONE: ${changes.length} designation(s) changed, ${newRoles.length} permission row(s) added, ${seatOps.length} seat change(s).\nBackup: ${bak}`);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(String(e && e.stack ? e.stack : e).slice(0, 900)); process.exit(1); });
