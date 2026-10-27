/* eslint-disable no-console, no-await-in-loop */
// Education TLs by sheet (user, 2026-10-27): Edu - 1 colleges = Team A, Edu - 2 colleges = Team B (TL names given on the command line).
// Sets Requirement.tl (+ tlId = the TL's login) on the Education requirements of those colleges that have NO TL yet. A TL already written on a
// requirement (e.g. the TL recorded on an old joining) is never overwritten. A college on BOTH sheets is left alone and listed.
//   node edu-tl.js <edu1-sheet.xlsx> <edu1-colleges.json> <edu2-clientmap.json> --team-a "<TL>" --team-b "<TL>" [--apply]
const path = require('path');
const fs = require('fs');
const os = require('os');

const BACK = path.resolve(__dirname, '..', '..');
process.chdir(BACK);
const XLSX = require(path.join(BACK, 'node_modules/xlsx'));
const { PrismaClient } = require(path.join(BACK, 'node_modules/@prisma/client'));
const [SHEET1, MAP1, MAP2] = process.argv.slice(2);
const APPLY = process.argv.includes('--apply');
const flat = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const MANUAL = { // the same hand-checked names as the Edu - 1 import
  'CMR College of Engineering & Technology(CMRCET)': 'CMR College of Engineering & Technology (CMRCET)', 'J.B institute of Engineering and Technology(JBIET)': 'J.B. Institute of Engineering and Technology (JBIET)',
  'Malla Reddy Engineering College & Management Science(MREM)': 'Malla Reddy Engineering College & Management Sciences', 'AAR Mahaveer': 'Mahaveer',
  'Mallareddy College of Engineering & Technology(MRCET)': 'MRCET', 'Alamuri Ratnamala Institute of Engineering & Technology': 'ARMIET', 'Audisakara University': 'Audisankara University',
  'Shri Sai College of Engineering and Technology': 'Shri Sai College of Engineering & Technology', 'BVRITW(Womens)': 'BVRITW(Womens)', 'Narsimha Reddy Engineering College (NRCM)': 'Narsimha Reddy Engineering College (NRCM)',
};
const arg = (f) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : null; };
const TEAM = { A: arg('--team-a'), B: arg('--team-b') }; // the two TLs' names exactly as on their logins
if (!TEAM.A || !TEAM.B) { console.error('Give --team-a "<TL of the Edu - 1 colleges>" --team-b "<TL of the Edu - 2 colleges>"'); process.exit(2); }

(async () => {
  const prisma = new PrismaClient();
  const clients = await prisma.client.findMany({ select: { id: true, name: true } });
  const byL = new Map(clients.map((c) => [c.name.toLowerCase(), c]));
  const auto1 = JSON.parse(fs.readFileSync(MAP1, 'utf8'));
  const teamA = new Map(); const teamB = new Map();
  XLSX.utils.sheet_to_json(XLSX.readFile(SHEET1).Sheets.Sheet1, { header: 1, defval: '' }).slice(1).forEach((x) => {
    const n = flat(x[0]); if (!n) return;
    const mk = Object.keys(MANUAL).find((k) => n.startsWith(k));
    const c = mk ? (MANUAL[mk] === 'ARMIET' ? clients.find((k) => k.name.startsWith('ARMIET')) : byL.get(MANUAL[mk].toLowerCase())) : (auto1[n] && { id: auto1[n].id, name: auto1[n].name });
    if (!c) throw new Error(`Edu - 1 college not found: ${n}`);
    teamA.set(c.id, c.name);
  });
  JSON.parse(fs.readFileSync(MAP2, 'utf8')).forEach((o) => teamB.set(o.id, o.name));
  const both = [...teamA.keys()].filter((id) => teamB.has(id));
  const tlUser = {};
  for (const k of ['A', 'B']) { const u = await prisma.user.findFirst({ where: { name: TEAM[k], atsRole: 'TL' }, select: { id: true } }); if (!u) throw new Error(`no TL login for ${TEAM[k]}`); tlUser[k] = u.id; }

  const reqs = await prisma.requirement.findMany({ where: { department: 'Educational' }, select: { id: true, reqCode: true, clientId: true, status: true, tl: true, tlId: true, client: { select: { name: true } } } });
  const plan = []; const kept = []; const bothReqs = []; const neither = [];
  reqs.forEach((r) => {
    const team = both.includes(r.clientId) ? 'BOTH' : teamA.has(r.clientId) ? 'A' : teamB.has(r.clientId) ? 'B' : null;
    if (team === 'BOTH') { bothReqs.push(r); return; }
    if (!team) { neither.push(r); return; }
    if (flat(r.tl)) { kept.push({ r, team }); return; }
    plan.push({ r, team });
  });
  const cnt = (l, f) => l.filter(f).length;
  console.log(`Team A (Edu - 1) colleges ${teamA.size} | Team B (Edu - 2) colleges ${teamB.size} | on BOTH sheets ${both.length}: ${both.map((id) => teamA.get(id)).join('; ')}`);
  console.log(`Education requirements ${reqs.length}:`);
  console.log(`  set TL -> Team A (${TEAM.A}): ${cnt(plan, (p) => p.team === 'A')} (open ${cnt(plan, (p) => p.team === 'A' && p.r.status === 'OPEN')})`);
  console.log(`  set TL -> Team B (${TEAM.B}):  ${cnt(plan, (p) => p.team === 'B')} (open ${cnt(plan, (p) => p.team === 'B' && p.r.status === 'OPEN')})`);
  console.log(`  already have a TL written (kept): ${kept.length} (open ${cnt(kept, (k) => k.r.status === 'OPEN')})`);
  console.log(`  college on both sheets (left alone): ${bothReqs.length} (open ${cnt(bothReqs, (r) => r.status === 'OPEN')})`);
  console.log(`  college on neither sheet: ${neither.length} (open ${cnt(neither, (r) => r.status === 'OPEN')}) ${[...new Set(neither.filter((r) => r.status === 'OPEN').map((r) => r.client.name))].join('; ')}`);
  const openKept = kept.filter((k) => k.r.status === 'OPEN'); if (openKept.length) console.log('  open requirements that keep another TL:', openKept.map((k) => `${k.r.reqCode} ${k.r.client.name} [${k.r.tl}]`).join('; '));
  if (!APPLY) { console.log('\nDRY RUN: nothing was changed.'); await prisma.$disconnect(); return; }

  const dir = path.join(os.homedir(), '.teamlink-backups', `edu-tl-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(dir, { recursive: true });
  await prisma.$executeRawUnsafe(`VACUUM INTO '${path.join(dir, 'before.db').split(path.sep).join('/')}'`);
  await prisma.$transaction(async (tx) => {
    for (const p of plan) await tx.requirement.update({ where: { id: p.r.id }, data: { tl: TEAM[p.team], tlId: tlUser[p.team] } });
    await tx.auditLog.create({ data: { action: `Local: Education TLs set by sheet - Team A (Edu - 1) ${cnt(plan, (p) => p.team === 'A')}, Team B (Edu - 2) ${cnt(plan, (p) => p.team === 'B')} requirements`, entity: 'Requirement', actorName: 'Local update 2026-10-27' } });
  });
  fs.writeFileSync(path.join(dir, 'undo.json'), JSON.stringify(plan.map((p) => ({ id: p.r.id, tl: p.r.tl, tlId: p.r.tlId })), null, 1));
  console.log(`\nDONE: TL set on ${plan.length} requirements. Backup: ${path.join(dir, 'before.db')}`);
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
