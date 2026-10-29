#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// NEERAJA = BDE (BDE-MFG seat), like the other BDEs (founder 2026-10-29: "Neeraja kuda BDE dept ey ... BDE MFG ...
// remaining BDE valla laaganey thanaki kuda vundali").
//
// She already sits in the BDE-MFG seat and her HRMS department is BDE; only her LOGIN still said RECRUITER
// (role RECRUITER, ATS role RECRUITER), so she got the recruiter screens and was left out of the BDE team.
// This sets role EMPLOYEE + ATS role BDE - exactly what Sailaja / Tulasi / Vasavi (BDE-EDU-2 / EDU-1 / MED) have.
// ATS department / scope (BDE), HRMS / Accounts roles, seat, password, email: untouched. Audit row as the Users screen writes.
//
//   node scripts/neeraja-bde-mfg-2026-10-29.js                                   DRY RUN (shows before / after)
//   TL_ALLOW_REAL_APPLY=1 node scripts/neeraja-bde-mfg-2026-10-29.js --apply --really-real
// Running it twice changes nothing new.
// ---------------------------------------------------------------------------
const path = require('path');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
if (APPLY && !(argv.includes('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: this writes to the REAL database. It needs --really-real AND TL_ALLOW_REAL_APPLY=1.');
  process.exit(2);
}
process.chdir(path.resolve(__dirname, '..'));
const prisma = require('../src/db');

const EMAIL = 'neeraja.y@tmlink.in';
const WANT = { role: 'EMPLOYEE', atsRole: 'BDE' };
const SHOW = ['name', 'role', 'atsRole', 'hrmsRole', 'accountsRole', 'atsDepartment', 'atsScopeDepartments', 'status'];
const show = (u) => SHOW.map((k) => `${k}=${u[k] ?? '-'}`).join(' | ');

(async () => {
  try {
    const u = await prisma.user.findFirst({ where: { email: EMAIL } });
    if (!u) { console.log(`No login with ${EMAIL} here. Nothing changed.`); return; }
    const seat = await prisma.positionAssignment.findFirst({ where: { toDate: null, employee: { userId: u.id } }, select: { position: { select: { code: true } } } });
    const peers = await prisma.user.findMany({ where: { status: 'Active', atsRole: 'BDE', atsDepartment: 'BDE' }, select: { name: true, role: true, atsRole: true } });
    console.log('Other BDEs:', peers.map((p) => `${p.name} (${p.role}/${p.atsRole})`).join(', ') || '(none)');
    console.log(`Seat now: ${seat ? seat.position.code : '(none)'}`);
    console.log('BEFORE:', show(u));
    if (u.status !== 'Active') { console.log('This login is not Active. Nothing changed.'); return; }
    const next = { ...u, ...WANT };
    if (u.role === WANT.role && u.atsRole === WANT.atsRole) { console.log('Already a BDE login. Nothing to change.'); return; }
    console.log('AFTER: ', show(next));
    if (!APPLY) { console.log('\nDRY RUN - nothing written. Apply: TL_ALLOW_REAL_APPLY=1 node scripts/neeraja-bde-mfg-2026-10-29.js --apply --really-real'); return; }
    await prisma.user.update({ where: { id: u.id }, data: WANT });
    const actor = { id: null, name: 'Founder request (script neeraja-bde-mfg-2026-10-29)' };
    await require('../src/utils/roleGuard').noteRoleChange({ actor, current: u, next: { ...WANT, atsDepartment: u.atsDepartment }, source: 'BDE-MFG like the other BDEs' }); // eslint-disable-line global-require
    const after = await prisma.user.findUnique({ where: { id: u.id } });
    console.log('\nAPPLIED:', show(after));
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
