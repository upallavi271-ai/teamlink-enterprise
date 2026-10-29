// ---------------------------------------------------------------------------
// ONE NAME FOR R&D (founder 2026-10-28: "R & D untadi, R n D undadu - only maku R & D untadi. R & D TL: Banka Mrudula, R & D 1
// G.V. Keerthi, R & D 2 Mangalapalli Sravanthi, R & D 3 Durga Nagendra").
//
//   * every DEPARTMENT value spelled another way - "R n D", "RnD", "RND", "R and D", "R & D", "r&d" ... - becomes "R&D", in every
//     table that has a department column (employees, seats, requirements, logins, teams ...);
//   * a seat coded "RND-<n>" / "RND TL" becomes "R&D-<n>" / "R&D-TL"; when that code already exists (the seat was re-made under the
//     right name) the old one keeps its history as "R&D-<n>-OLD" and stays switched off;
//   * a second Department row with such a spelling is switched off (the "R&D" row stays);
//   * it prints the four R&D seats and who sits on them, to check against the founder's list.
// Nothing is deleted. Dry run by default; --apply writes (a whole-database backup first).
//
//   node scripts/fix-rnd-name.js            DRY RUN
//   node scripts/fix-rnd-name.js --apply
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const prisma = require('../src/db');

const APPLY = process.argv.includes('--apply');
const RIGHT = 'R&D';
const isRnd = (v) => /^\s*r\s*(?:&|n|and|-|\.)?\s*d\s*\.?\s*$/i.test(String(v || ''));
const q = (s) => `"${String(s).replace(/"/g, '""')}"`;

(async () => {
  console.log(APPLY ? '*** APPLY ***' : '*** DRY RUN - nothing is written ***');
  const tables = (await prisma.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'")).map((r) => r.name);
  const fixes = []; // { table, col, from, n }
  for (const t of tables) {
    // eslint-disable-next-line no-await-in-loop
    const cols = (await prisma.$queryRawUnsafe(`PRAGMA table_info(${q(t)})`)).filter((c) => /text|char/i.test(c.type) && /depart|dept/i.test(c.name));
    for (const c of cols) {
      // eslint-disable-next-line no-await-in-loop
      const vals = await prisma.$queryRawUnsafe(`SELECT ${q(c.name)} AS v, COUNT(*) AS n FROM ${q(t)} WHERE ${q(c.name)} IS NOT NULL GROUP BY ${q(c.name)}`);
      vals.forEach((x) => { if (x.v !== RIGHT && isRnd(x.v)) fixes.push({ table: t, col: c.name, from: x.v, n: Number(x.n) }); });
    }
  }
  const deptRows = await prisma.department.findMany();
  const extraDepts = deptRows.filter((d) => d.name !== RIGHT && isRnd(d.name));
  const hasRightDept = deptRows.some((d) => d.name === RIGHT);
  const seats = await prisma.position.findMany();
  const codes = new Set(seats.map((s) => s.code));
  const seatFixes = seats.filter((s) => /^\s*r\s*(?:n|and)\s*d\s*[-\s]*(\w+)\s*$/i.test(s.code) || /^rnd[-\s]*(\w+)$/i.test(s.code)).map((s) => {
    const tail = (/^\s*r\s*(?:n|and)?\s*d\s*[-\s]*(\w+)\s*$/i.exec(s.code) || [])[1];
    const want = `R&D-${String(tail).toUpperCase()}`;
    return { seat: s, to: codes.has(want) ? `${want}-OLD` : want, old: codes.has(want) };
  });

  console.log(`\nDEPARTMENT VALUES TO "${RIGHT}" (${fixes.length})`);
  fixes.forEach((f) => console.log(`  ${f.table}.${f.col}: "${f.from}" x${f.n}`));
  console.log(`\nSEATS RENAMED (${seatFixes.length})`);
  seatFixes.forEach((s) => console.log(`  ${s.seat.code} -> ${s.to}${s.old ? ' (old seat, history kept, switched off)' : ''}`));
  if (extraDepts.length) console.log(`\nDEPARTMENT ROWS SWITCHED OFF: ${extraDepts.map((d) => d.name).join(', ')}${hasRightDept ? '' : ` (the first one is renamed to "${RIGHT}" instead)`}`);

  const show = async () => {
    const rd = await prisma.position.findMany({ where: { department: RIGHT, active: true }, include: { assignments: { where: { toDate: null }, include: { employee: { select: { employeeCode: true, name: true } } } } }, orderBy: { code: 'asc' } });
    console.log('\nR&D SEATS (active)');
    rd.forEach((s) => console.log(`  ${s.code.padEnd(10)} ${s.assignments.map((a) => `${a.employee.employeeCode} ${a.employee.name}`).join(', ') || '(empty)'}`));
  };
  if (!APPLY) { await show(); console.log('\nDRY RUN - run again with --apply.'); process.exit(0); }

  const dir = path.join(os.homedir(), '.teamlink-backups', `fix-rnd-name-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(dir, { recursive: true });
  const bak = path.join(dir, 'before.db').split(path.sep).join('/');
  await prisma.$executeRawUnsafe(`VACUUM INTO '${bak.replace(/'/g, "''")}'`);
  for (const f of fixes) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.$executeRawUnsafe(`UPDATE ${q(f.table)} SET ${q(f.col)} = ? WHERE ${q(f.col)} = ?`, RIGHT, f.from);
  }
  for (const s of seatFixes) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.position.update({ where: { id: s.seat.id }, data: { code: s.to, name: s.old ? `${s.to.replace(/-OLD$/, '')} (old seat)` : (s.seat.name || '').replace(s.seat.code, s.to) || null, department: RIGHT, ...(s.old ? { active: false } : {}) } });
  }
  for (const [i, d] of extraDepts.entries()) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.department.update({ where: { id: d.id }, data: !hasRightDept && i === 0 ? { name: RIGHT } : { active: false } });
  }
  await prisma.auditLog.create({ data: { action: 'R&D name made one', entity: 'Department', entityId: RIGHT, toValue: RIGHT, reason: `${fixes.reduce((n, f) => n + f.n, 0)} value(s), ${seatFixes.length} seat(s), ${extraDepts.length} department row(s) - fix-rnd-name.js`, actorName: 'fix-rnd-name' } });
  console.log(`\nDONE. Backup: ${bak}`);
  await show();
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
