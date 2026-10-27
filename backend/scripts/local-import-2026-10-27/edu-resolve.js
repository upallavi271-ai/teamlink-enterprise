// Map the tracker's "Interview College Name" to local clients: the joinings importer's Education rules (+ local name targets), then exact / old names.
const path = require('path');
const BACK = path.resolve(__dirname, '..', '..');
process.chdir(BACK);
const XLSX = require(path.join(BACK, 'node_modules/xlsx'));
const { PrismaClient } = require(path.join(BACK, 'node_modules/@prisma/client'));
const { RULES } = require(path.join(BACK, 'scripts/lib/joinings-2026-10-17/client-rules.js'));
const pack = require(path.join(BACK, 'scripts/lib/joinings-2026-10-17/agreements-pack.json'));
const TARGET = {
  'Avanthi Institute of Engineering & Technology': 'Avanthi Institute Of Engineering & Technology', Ellenki: 'Ellanki college', JBREC: 'Joginpally B.R. Engineering College',
  "Malla Reddy Women's College": 'Malla Reddy Engineering College for Women', 'Malla Reddy University': 'Malla reddy university',
  MLRIT: 'MLRIT(Marry Laxman Reddy Institute of Technology and Science)', mrits: 'Malla Reddy Institute of Technology & science (MRITS)',
  'Vageswari College of Engineering': 'Vageswari', kmit: 'KMIT', 'Mr Cet': 'MRCET', Vbit: 'VBIT',
};
const EXTRA = [ // short names in this tracker that the joinings rules do not cover (checked by hand against the client list)
  [/^sanjee?vani/, 'Sanjivani University'], [/^mrem\b|^st\.? ?peters? ?- ?mrem/, 'Malla Reddy Engineering College & Management Sciences (MREM)'],
  [/^malla ?reddy ?wom|^mallareddy ?wom/, "Malla Reddy Women's College"], [/^brainware/, 'Brainware University'], [/^alamuri|^armiet/, 'ARMIET - Alamuri Ratnamala Institute of Engineering & Technology, Engineering'],
  [/^geet?h?anjali|^geetanjali/, 'Geethanjali College of Engineering & Technology'], [/^sri ?sai\b|^shri ?sai\b/, 'Sri Sai Institute of Technology and Science'],
  [/^jaya ?prakash|^jayaprakash/, 'Jaya Prakash Narayan College of Engineering'], [/^sidh?d?h?artha|^sidhartha/, 'Siddhartha Group of Institutions'],
  [/^(shri|sri) ?sh?akthi/, 'Sri Shakthi Institute of Engineering and Technology'], [/^gsfc/, 'GSFC University'], [/^chandigarh/, 'Chandigarh University'],
  [/^gdmm/, 'GDMM College of Engineering and Technology'], [/^kamala/, 'Kamala Institute of Technology & Science'], [/^gouthami/, 'Gouthami Institute of Technology and Management for Women'],
  [/^nizam/, 'Nizam Institute of Pharmacy'], [/^vikas/, 'Vikas College of Engineering & Technology'], [/^tagore/, 'Tagore institute of engineering and technology'],
  [/^unnamalai/, 'Unnamalai Institute Of Technology'], [/^surya/, 'Surya Engineering College'], [/^amrita ?sai/, 'Amrita Sai Institute of Science and Technology Paritala'],
  [/^audisankara/, 'Audisankara University'], [/^sree ?vahini|^sri ?vahini/, 'Sree Vahini Institute of Science and Technology'], [/^sri ?ramakrishna/, 'Sri Ramakrishna College of Engineering'],
  [/^jagad/, 'Jagadambha College of Engineering & Technology'], [/^anuradha/, 'Anuradha Engineering College, Chikhli'], [/^acharya/, 'Acharya Institutes'],
  [/^chinmaya/, 'CHINMAYA JNANA'], [/^mjr/, 'MJR Institute of Business Management'], [/^pydah/, 'Pydah College of Engineering'], [/^vsb/, 'VSB Engineering College'],
  [/^nec\b|^narasar/, 'Narasaraopeta Engineering College(NEC)'], [/^ntr/, 'NTR Memorial Trust'], [/^suprabh/, 'Suprabhat Institute of Management Studies'],
  [/^mallareddy group|^malla ?reddy group/, 'Mallareddy group of institutions'], [/^vnr/, 'VNR Vignana Jyothi Institute of Engineering and Technology'],
];
const flat = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
(async () => {
  const prisma = new PrismaClient();
  const clients = await prisma.client.findMany({ select: { id: true, name: true, ownerDepartment: true } });
  const byName = new Map(clients.map((c) => [c.name.toLowerCase(), c]));
  const byId = new Map(clients.map((c) => [c.id, c]));
  const was = new Map(); pack.renames.forEach((r) => { if (r.current && byId.has(r.clientId)) was.set(r.current.toLowerCase(), byId.get(r.clientId)); });
  const toClient = (n) => { n = TARGET[n] || n; return byName.get(n.toLowerCase()) || was.get(n.toLowerCase()) || null; };
  const rules = [...EXTRA.map(([re, n]) => ['x', re, n]), ...RULES.filter((r) => r[0] === 'Education')];
  const rows = XLSX.utils.sheet_to_json(XLSX.readFile(process.argv[2]).Sheets.Sheet1, { header: 1, defval: '' }).slice(1).filter((x) => x.some((v) => flat(v)));
  const seen = new Map();
  rows.forEach((x) => { const raw = flat(x[17]); if (!seen.has(raw)) seen.set(raw, 0); seen.set(raw, seen.get(raw) + 1); });
  const out = {}; const miss = [];
  for (const [raw, n] of [...seen].sort((a, b) => b[1] - a[1])) {
    const t = raw.toLowerCase().replace(/[‘’`]/g, "'");
    if (!t) { miss.push(['(blank)', n, '']); continue; }
    const rule = rules.find((r) => r[1].test(t));
    let c = rule ? toClient(rule[2]) : null;
    if (!c) c = byName.get(t) || was.get(t) || null;
    if (c) out[raw] = { id: c.id, name: c.name, n, via: rule ? 'rule' : 'name' }; else miss.push([raw, n, rule ? rule[2] : '']);
  }
  require('fs').writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
  console.log(`college spellings: ${seen.size} | matched: ${Object.keys(out).length} (${Object.values(out).reduce((a, b) => a + b.n, 0)} rows) | NOT matched: ${miss.length} (${miss.reduce((a, b) => a + b[1], 0)} rows)`);
  console.log('\nMATCHED (spelling -> client):'); Object.entries(out).forEach(([k, v]) => console.log(`  ${String(v.n).padStart(3)}  ${k.slice(0, 40).padEnd(40)} -> ${v.name}`));
  console.log('\nNOT MATCHED:'); miss.forEach(([k, n, r]) => console.log(`  ${String(n).padStart(3)}  ${k}${r ? `   (rule says "${r}" - no such client)` : ''}`));
  await prisma.$disconnect();
})();
