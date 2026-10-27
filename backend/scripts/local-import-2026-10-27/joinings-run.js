/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// LOCAL ONLY (2026-10-27): run the repo's joinings importer (scripts/import-joinings-2026-10-17.js, --only joinings) against the
// local database as it is now. Its name rules were written for the live database, so before it starts:
//   * the 18 joinings-only colleges / companies are created as clients (no agreement), named as the rules / sheets write them;
//   * rule names that the local clients carry under another spelling are pointed at those clients (in memory, the repo is not edited);
//   * Aurora-Uppal / Aurora-Chikadapally go to the two Aurora clients, every other Aurora branch to "Aurora Colleges".
//   node joinings-run.js --db <file> [--create-clients] -- <importer args>
// ---------------------------------------------------------------------------
const path = require('path');

const BACK = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const own = sep >= 0 ? argv.slice(0, sep) : argv;
const rest = sep >= 0 ? argv.slice(sep + 1) : [];
const DB = own.includes('--db') ? path.resolve(own[own.indexOf('--db') + 1]) : path.join(BACK, 'prisma', 'dev.db');
process.chdir(BACK);

const NEW_CLIENTS = [
  ['ACE Engineering College', 'Educational'], ['Aditya University', 'Educational'], ['Aurora Colleges', 'Educational'], ['AVN', 'Educational'],
  ['Bhaskar Engineering College', 'Educational'], ['CMR Institute of Technology', 'Educational'], ['CMR Technical Campus', 'Educational'],
  ['CMR College of Engineering & Technology (CMRCET)', 'Educational'], ['DRK', 'Educational'], ['Godavari Institute of Engineering & Technology (GIET)', 'Educational'],
  ['J.B. Institute of Engineering and Technology (JBIET)', 'Educational'], ['KMIT', 'Educational'], ['Mahaveer', 'Educational'], ['MRCET', 'Educational'],
  ['Sharada College', 'Educational'], ["Sreya's College", 'Educational'], ['VBIT', 'Educational'], ['ReLiv Healthy India Pvt Ltd', 'Medical'],
];
// rule name (as the live database calls it) -> the local client's exact name
const TARGET = {
  'Avanthi Institute of Engineering & Technology': 'Avanthi Institute Of Engineering & Technology',
  Ellenki: 'Ellanki college',
  JBREC: 'Joginpally B.R. Engineering College',
  "Malla Reddy Women's College": 'Malla Reddy Engineering College for Women',
  'Malla Reddy University': 'Malla reddy university',
  MLRIT: 'MLRIT(Marry Laxman Reddy Institute of Technology and Science)',
  mrits: 'Malla Reddy Institute of Technology & science (MRITS)',
  'Vageswari College of Engineering': 'Vageswari',
  'Trr Medical College': 'Trr Medical College, Hyderabad',
  'NEW:Nova Institute of Medical Sciences and Research Center': 'Nova Institute of Medical Sciences and Research Center',
  kmit: 'KMIT', 'Mr Cet': 'MRCET', Vbit: 'VBIT',
};

(async () => {
  const { RULES } = require(path.join(BACK, 'scripts/lib/joinings-2026-10-17/client-rules.js'));
  RULES.forEach((r) => { if (TARGET[r[2]]) r[2] = TARGET[r[2]]; });
  const au = RULES.findIndex((r) => r[0] === 'Education' && String(r[1]) === String(/^aurora/));
  if (au < 0) throw new Error('the Aurora rule was not found');
  RULES.splice(au, 0, ['Education', /^aurora[\s-]*uppal/, 'Aurora College - Uppal'], ['Education', /^aurora[\s-]*chik/, 'Aurora College-Chikadapally']);

  if (own.includes('--create-clients')) {
    process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
    const { PrismaClient } = require(path.join(BACK, 'node_modules/@prisma/client'));
    const prisma = new PrismaClient();
    let made = 0;
    for (const [name, dept] of NEW_CLIENTS) {
      if (await prisma.client.findFirst({ where: { name } })) continue; // eslint-disable-line no-await-in-loop
      await prisma.client.create({ data: { name, legalName: name, ownerDepartment: dept, industry: dept === 'Medical' ? 'Healthcare' : 'Education', status: 'Active', clientType: 'Direct', internalNotes: 'Added from the joinings sheets (local import 2026-10-27, joinings-only: no signed agreement, not on the requirement sheets). Name as the joinings import writes it.' } }); // eslint-disable-line no-await-in-loop
      made += 1;
    }
    await prisma.$disconnect();
    console.log(`[wrapper] clients created: ${made} of ${NEW_CLIENTS.length}`);
  }
  // every rule target must now be a local client (or the importer would park the rows)
  {
    process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
    const { PrismaClient } = require(path.join(BACK, 'node_modules/@prisma/client'));
    const prisma = new PrismaClient();
    const names = new Set((await prisma.client.findMany({ select: { name: true } })).map((c) => c.name));
    await prisma.$disconnect();
    const missing = [...new Set(RULES.map((r) => r[2]))].filter((n) => !names.has(n) && !n.startsWith('NEW:'));
    console.log(`[wrapper] rule names with no local client of that exact name (resolved through the agreement renames, or parked): ${missing.length}`);
    missing.forEach((n) => console.log(`   ${n}`));
  }
  process.argv = [process.argv[0], path.join(BACK, 'scripts/import-joinings-2026-10-17.js'), ...rest];
  require(path.join(BACK, 'scripts/import-joinings-2026-10-17.js'));
})().catch((e) => { console.error(e); process.exit(1); });
