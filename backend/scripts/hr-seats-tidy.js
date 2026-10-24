#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// THE HR SEATS (founder, 2026-10-23): "in Add Employee, the HR positions should show the real ones: Divya, Teja K, Bhavani = HR, Purna Chandra Sekhar
// = HR TL" - not 22 empty generic seats "HR seat HR-1 ... HR-22".
//
// WHAT IT DOES (nothing is deleted; every seat keeps its history):
//   * HR-1  is named "HR · Divya"   and T Divya Sri Sivatmika (HR) is put in it when she holds no seat;
//   * HR-2  is named "HR · Teja K"   (empty until Teja K is added);   HR-3 is named "HR · Bhavani" (empty until Bhavani is added);
//   * HR-TL is the team lead seat "HR TL · Purna Chandra Sekhar": made if missing; PurnaChandra Sekhar Koti moves into it from HR-22 (that tenure
//     ends today, the new one starts today);
//   * every OTHER HR seat that nobody holds right now (active or on notice) is switched to INACTIVE (archived: the seat and its tenures stay on file,
//     the pickers stop offering it). A seat someone still holds is left alone.
//   node scripts/hr-seats-tidy.js                                           DRY RUN (default): shows what would change, writes nothing
//   node scripts/hr-seats-tidy.js --apply [--db <copy.db>]                  really writes (on prisma/dev.db it also needs --really-real and TL_ALLOW_REAL_APPLY=1)
//   node scripts/hr-seats-tidy.js --undo <manifest.json> [--db <db>] [--really-real]
// SAFETY: dry run by default; VACUUM INTO backup first; undo manifest; one transaction; running it twice changes nothing more.
// The LIVE site has its own database: run the same script there.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const BACK = path.resolve(__dirname, '..');
const DEV_DB = path.join(BACK, 'prisma', 'dev.db');
const dbArg = path.resolve(val('--db', DEV_DB));
const isReal = dbArg.toLowerCase() === DEV_DB.toLowerCase();
const APPLY = has('--apply');
const UNDO = val('--undo');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(val('--out', path.join(os.tmpdir(), `hr-seats-${STAMP}`)));
const BACKUP_DIR = path.resolve(val('--backup-dir', isReal ? path.join(os.homedir(), '.teamlink-backups', `hr-seats-${STAMP}`) : path.join(OUT, 'backup')));

if ((APPLY || UNDO) && isReal && !(has('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: this would change the REAL database (prisma/dev.db). It needs --really-real AND the environment variable TL_ALLOW_REAL_APPLY=1. Use --db <copy> to try it on a copy first.');
  process.exit(2);
}
if (APPLY && UNDO) { console.error('Use either --apply or --undo, not both.'); process.exit(2); }
process.env.DATABASE_URL = `file:${dbArg.split(path.sep).join('/')}`;
process.chdir(BACK);
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const today = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10); // IST

const NAMED = [
  { code: 'HR-1', name: 'HR · Divya', person: /divya/i },
  { code: 'HR-2', name: 'HR · Teja K', person: null },
  { code: 'HR-3', name: 'HR · Bhavani', person: null },
];
const TL = { code: 'HR-TL', name: 'HR TL · Purna Chandra Sekhar', person: /purna\s*chandra/i };
const LEFT = ['Relieved', 'Exited', 'Terminated'];

(async () => {
  try {
    if (UNDO) {
      const m = JSON.parse(fs.readFileSync(path.resolve(UNDO), 'utf8'));
      await prisma.$transaction(async (tx) => {
        for (const a of m.createdAssignments || []) await tx.positionAssignment.deleteMany({ where: { id: a } });
        for (const a of m.reopened || []) await tx.positionAssignment.update({ where: { id: a.id }, data: { toDate: null } }).catch(() => {});
        for (const p of m.positions || []) await tx.position.update({ where: { id: p.id }, data: { name: p.name, active: p.active, code: p.code } }).catch(() => {});
        for (const id of m.createdPositions || []) await tx.position.deleteMany({ where: { id } });
      });
      console.log('Undone: the HR seats are back as they were.');
      return;
    }
    const seats = await prisma.position.findMany({ where: { department: 'HR' }, orderBy: { code: 'asc' } });
    const open = await prisma.positionAssignment.findMany({ where: { toDate: null, position: { department: 'HR' } }, include: { employee: { select: { id: true, name: true, employmentStatus: true } } } });
    const holderOf = new Map(open.map((a) => [a.positionId, a]));
    const heldNow = (s) => { const a = holderOf.get(s.id); return !!(a && a.employee && !LEFT.includes(a.employee.employmentStatus)); };
    const hr = await prisma.employee.findMany({ where: { department: 'HR', employmentStatus: { in: ['Active', 'On Probation', 'Notice Period'] } }, select: { id: true, name: true, employmentStatus: true } });
    const seatsOfEmp = async (id) => prisma.positionAssignment.findMany({ where: { employeeId: id, toDate: null }, include: { position: true } });
    const plan = [];
    const byCode = new Map(seats.map((s) => [s.code, s]));

    for (const n of NAMED) {
      const s = byCode.get(n.code);
      plan.push({ kind: s ? 'rename' : 'create', code: n.code, name: n.name, from: s ? s.name : null });
    }
    const tlSeat = byCode.get(TL.code);
    plan.push({ kind: tlSeat ? 'rename' : 'create', code: TL.code, name: TL.name, from: tlSeat ? tlSeat.name : null });
    const keep = new Set([...NAMED.map((n) => n.code), TL.code]);
    const archive = seats.filter((s) => !keep.has(s.code) && s.active && !heldNow(s));
    archive.forEach((s) => plan.push({ kind: 'archive', code: s.code, name: s.name }));
    const stillHeld = seats.filter((s) => !keep.has(s.code) && heldNow(s)).map((s) => `${s.code} (${holderOf.get(s.id).employee.name})`);

    const moves = [];
    const divya = hr.find((e) => NAMED[0].person.test(e.name));
    if (divya && !(await seatsOfEmp(divya.id)).length) moves.push({ employee: divya, to: 'HR-1', why: 'she holds no seat' });
    const purna = hr.find((e) => TL.person.test(e.name));
    if (purna) { const cur = await seatsOfEmp(purna.id); if (!cur.some((a) => a.position.code === TL.code)) moves.push({ employee: purna, to: TL.code, from: cur.map((a) => a.position.code), why: 'the team lead seat' }); }

    // a seat somebody moves OUT of (Purna leaves HR-22 for HR-TL) is vacant afterwards: archive it too
    moves.forEach((m) => (m.from || []).forEach((code) => {
      const seat = byCode.get(code);
      if (seat && seat.active && !keep.has(code) && !plan.some((p) => p.kind === 'archive' && p.code === code)) { plan.push({ kind: 'archive', code, name: seat.name }); const i = stillHeld.findIndex((x) => x.startsWith(`${code} `)); if (i >= 0) stillHeld.splice(i, 1); }
    }));
    console.log(`Database: ${dbArg}${isReal ? '  (REAL)' : ''}`);
    console.log('Seats:');
    plan.forEach((p) => console.log(`  ${p.kind.toUpperCase().padEnd(8)} ${p.code.padEnd(6)} ${p.kind === 'archive' ? '(vacant: archived, history kept)' : `"${p.name}"${p.from ? `   (was "${p.from}")` : ''}`}`));
    if (stillHeld.length) console.log(`  KEPT AS THEY ARE (someone holds them): ${stillHeld.join(', ')}`);
    console.log('People:');
    if (!moves.length) console.log('  nobody is moved');
    moves.forEach((m) => console.log(`  ${m.employee.name} -> ${m.to}${m.from && m.from.length ? ` (leaves ${m.from.join(', ')})` : ''}   [${m.why}]`));
    if (!divya) console.log('  note: no active HR employee named Divya was found, HR-1 stays empty');
    if (!purna) console.log('  note: no active HR employee named PurnaChandra / Purna Chandra was found, HR-TL stays empty');
    if (!APPLY) { console.log('\nDRY RUN: nothing was changed.'); return; }

    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const bak = path.join(BACKUP_DIR, 'before.db');
    await prisma.$executeRawUnsafe(`VACUUM INTO '${bak.split(path.sep).join('/').replace(/'/g, "''")}'`);
    const manifest = { at: new Date().toISOString(), db: dbArg, positions: [], createdPositions: [], createdAssignments: [], reopened: [] };
    const t = today();
    await prisma.$transaction(async (tx) => {
      const idOf = new Map();
      for (const p of plan) {
        if (p.kind === 'archive') {
          const s = byCode.get(p.code); manifest.positions.push({ id: s.id, name: s.name, active: s.active, code: s.code });
          await tx.position.update({ where: { id: s.id }, data: { active: false } });
        } else if (p.kind === 'rename') {
          const s = byCode.get(p.code); manifest.positions.push({ id: s.id, name: s.name, active: s.active, code: s.code });
          await tx.position.update({ where: { id: s.id }, data: { name: p.name, active: true } }); idOf.set(p.code, s.id);
        } else {
          const made = await tx.position.create({ data: { code: p.code, name: p.name, department: 'HR', team: null, active: true, kind: 'OTHER' } });
          manifest.createdPositions.push(made.id); idOf.set(p.code, made.id);
        }
      }
      for (const m of moves) {
        const cur = await tx.positionAssignment.findMany({ where: { employeeId: m.employee.id, toDate: null } });
        for (const a of cur) { await tx.positionAssignment.update({ where: { id: a.id }, data: { toDate: t } }); manifest.reopened.push({ id: a.id }); }
        const made = await tx.positionAssignment.create({ data: { positionId: idOf.get(m.to), employeeId: m.employee.id, fromDate: t, note: 'HR seats tidy-up (founder request 2026-10-23)' } });
        manifest.createdAssignments.push(made.id);
      }
      await tx.auditLog.create({ data: { action: 'HR seats tidied: named seats, empty generic seats archived', entity: 'Position', entityId: 'HR', toValue: `${plan.length} seat change(s), ${moves.length} move(s)`, actorName: 'Founder request 2026-10-23' } });
    });
    fs.mkdirSync(OUT, { recursive: true });
    const mf = path.join(OUT, 'undo-manifest.json');
    fs.writeFileSync(mf, JSON.stringify(manifest, null, 1));
    console.log(`\nDONE. Backup: ${bak}\nUndo:   node scripts/hr-seats-tidy.js --undo "${mf}"${isReal ? ' --really-real' : ` --db "${dbArg}"`}`);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(String(e && e.message ? e.message : e).slice(0, 500)); process.exit(1); });
