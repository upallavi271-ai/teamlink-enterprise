#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop */
// ---------------------------------------------------------------------------
// NON IT MEDICAL (founder 2026-10-29: "manufacturing vaallu medical meedha work chesthunnaru, so vaatiki non it medical
// ani name cheyyu ... non it medical - medical (MED) vallaki kanipinchakudadhu, vallaki vellu kanipinchakudadhu").
//
// 1. The Department master gets "Non IT Medical" (active), so it can be picked on a job.
// 2. Every Medical job on a Manufacturing TL's chain (what the MFG team works today - utils/scope.js requirementWhere,
//    run BEFORE the code that drops the Medical exception) becomes department "Non IT Medical". The Medical TL then no
//    longer sees it, and the Manufacturing team sees it as its own.
// Clients, candidates, assignments, stages: untouched (a client keeps its other Medical jobs with the MED team).
//
//   node scripts/non-it-medical-2026-10-29.js                                   DRY RUN
//   TL_ALLOW_REAL_APPLY=1 node scripts/non-it-medical-2026-10-29.js --apply --really-real
// SAFETY: VACUUM INTO backup first; running it twice changes nothing new.
// ---------------------------------------------------------------------------
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
if (APPLY && !(argv.includes('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: this writes to the REAL database. It needs --really-real AND TL_ALLOW_REAL_APPLY=1.');
  process.exit(2);
}
process.chdir(path.resolve(__dirname, '..'));
const prisma = require('../src/db');
const { resolveIdentity } = require('../src/utils/identity');
const scope = require('../src/utils/scope');
const { logAudit } = require('../src/utils/audit');

const NEW_DEPT = 'Non IT Medical';

(async () => {
  try {
    const tls = await prisma.user.findMany({ where: { status: 'Active', atsRole: 'TL', atsDepartment: 'Manufacturing' }, select: { id: true, name: true } });
    console.log('Manufacturing TLs:', tls.map((t) => t.name).join(', ') || '(none)');
    const jobs = new Map();
    for (const t of tls) {
      const me = await resolveIdentity(t.id);
      const rows = await prisma.requirement.findMany({
        where: { AND: [scope.requirementWhere(me), { department: 'Medical' }] },
        select: { id: true, title: true, status: true, client: { select: { name: true } } },
      });
      rows.forEach((r) => jobs.set(r.id, { ...r, tl: t.name }));
    }
    const master = await prisma.department.findUnique({ where: { name: NEW_DEPT } });
    console.log(`Department master "${NEW_DEPT}": ${master ? (master.active ? 'already there' : 'there but off -> switched on') : 'will be added'}`);
    console.log(`Medical jobs the MFG team works -> "${NEW_DEPT}": ${jobs.size}`);
    for (const j of jobs.values()) console.log(`  ${(j.client && j.client.name || '').slice(0, 40).padEnd(40)} | ${j.title.slice(0, 40).padEnd(40)} | ${j.status}`);
    if (!APPLY) { console.log('\nDRY RUN - nothing written. Apply: TL_ALLOW_REAL_APPLY=1 node scripts/non-it-medical-2026-10-29.js --apply --really-real'); return; }

    const bak = path.join(os.homedir(), `db-backup-before-non-it-medical-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    await prisma.$executeRawUnsafe(`VACUUM INTO '${bak.split(path.sep).join('/').replace(/'/g, "''")}'`);
    console.log('backup:', bak);
    if (!master) await prisma.department.create({ data: { name: NEW_DEPT, active: true } });
    else if (!master.active) await prisma.department.update({ where: { id: master.id }, data: { active: true } });
    for (const j of jobs.values()) {
      await prisma.requirement.update({ where: { id: j.id }, data: { department: NEW_DEPT } });
      await logAudit({ actorName: 'Founder request (script non-it-medical-2026-10-29)', action: 'Requirement department changed', entity: 'Requirement', entityId: j.id, fromValue: 'Medical', toValue: `${NEW_DEPT} (worked by the Manufacturing team)` });
    }
    console.log(`\nAPPLIED: ${jobs.size} job(s) now "${NEW_DEPT}".`);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
