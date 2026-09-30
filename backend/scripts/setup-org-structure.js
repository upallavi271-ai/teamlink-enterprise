// ---------------------------------------------------------------------------
// ORGANISATION STRUCTURE — the user's structure, written onto Position.
//
//   Education      Team A  "EDU TL"  -> EDU-1 … EDU-5
//                  Team B  "EDU-TL"  -> EDU-6 … EDU-10
//   Medical        Team    MED-TL    -> MED-1 … MED-5
//   Manufacturing  Team    MFG-TL    -> MFG-1 … MFG-5
//
// Seats are CONFIGURED here, never staffed: this script does not create,
// close or move a PositionAssignment. Codes are kept as they are ("EDU TL" and
// "EDU-TL" are stamped on history and named by the import scripts); the NAMES
// say which is which.
//
// Extra seats outside the structure (EDU-11…13, MED-6…11, MFG-6…8) are
// retired (active = false) ONLY WHILE VACANT; their history is untouched. A
// held extra seat stays active and is reported; re-run once it is vacated
// (MFG-8: Ruthvija P is moving to EDU-10 via the Education import).
//
// Idempotent. `node scripts/setup-org-structure.js` (add --dry to preview).
// ---------------------------------------------------------------------------
const prisma = require('../src/db');

const DRY = process.argv.includes('--dry');
const range = (prefix, a, b) => Array.from({ length: b - a + 1 }, (_, i) => `${prefix}${a + i}`);

const TEAMS = [
  { department: 'Education', team: 'Team A', tl: 'EDU TL', tlName: 'Education Team A TL', seats: range('EDU-', 1, 5), seatName: (i) => `Education Team A Recruiter ${i}` },
  { department: 'Education', team: 'Team B', tl: 'EDU-TL', tlName: 'Education Team B TL', seats: range('EDU-', 6, 10), seatName: (i) => `Education Team B Recruiter ${i}` },
  { department: 'Medical', team: 'Team', tl: 'MED-TL', tlName: 'Medical TL', seats: range('MED-', 1, 5), seatName: (i) => `Medical Recruiter ${i}` },
  { department: 'Manufacturing', team: 'Team', tl: 'MFG-TL', tlName: 'Manufacturing TL', seats: range('MFG-', 1, 5), seatName: (i) => `Manufacturing Recruiter ${i}` },
];
const EXTRAS = [...range('EDU-', 11, 13), ...range('MED-', 6, 11), ...range('MFG-', 6, 8)];
const RETIRED_NOTE = 'Extra seat outside the organisation structure — retired while vacant (history kept).';
const HELD_NOTE = 'Outside the organisation structure — still held; re-run this script to retire it once vacant.';

function withNote(existing, note) {
  const cur = String(existing || '');
  return cur.includes(note) ? cur : [cur, note].filter(Boolean).join(' ');
}

(async () => {
  const report = { updated: [], retired: [], heldOutsideStructure: [], missing: [] };
  const byCode = new Map((await prisma.position.findMany()).map((p) => [p.code, p]));
  const holderOf = async (id) => prisma.positionAssignment.findFirst({
    where: { positionId: id, toDate: null }, include: { employee: { select: { name: true } } },
  });

  async function set(code, data) {
    const p = byCode.get(code);
    if (!p) { report.missing.push(code); return null; }
    const changed = Object.entries(data).filter(([k, v]) => p[k] !== v);
    if (changed.length) {
      report.updated.push(`${code}: ${changed.map(([k, v]) => `${k}=${v === null ? 'null' : v}`).join(', ')}`);
      if (!DRY) await prisma.position.update({ where: { id: p.id }, data });
    }
    return p;
  }

  for (const t of TEAMS) {
    const tl = await set(t.tl, { kind: 'TL', team: t.team, department: t.department, name: t.tlName, reportsToId: null, active: true });
    for (const [i, code] of t.seats.entries()) {
      await set(code, {
        kind: 'RECRUITER', team: t.team, department: t.department, name: t.seatName(i + 1),
        reportsToId: tl ? tl.id : null, active: true,
      });
    }
  }

  for (const code of EXTRAS) {
    const p = byCode.get(code);
    if (!p) { report.missing.push(code); continue; }
    const holder = await holderOf(p.id);
    if (holder) {
      await set(code, { kind: 'RECRUITER', team: null, reportsToId: null, notes: withNote(p.notes, HELD_NOTE) });
      report.heldOutsideStructure.push(`${code} held by ${holder.employee ? holder.employee.name : '?'} since ${holder.fromDate}`);
    } else {
      await set(code, { kind: 'RECRUITER', team: null, reportsToId: null, active: false, notes: withNote(String(p.notes || '').replace(HELD_NOTE, '').trim(), RETIRED_NOTE) });
      report.retired.push(code);
    }
  }

  console.log(JSON.stringify({ dry: DRY, ...report }, null, 2));
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
