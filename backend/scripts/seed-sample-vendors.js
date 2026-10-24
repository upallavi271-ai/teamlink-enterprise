#!/usr/bin/env node
// ---------------------------------------------------------------------------
// OPTIONAL SAMPLE VENDORS for the Vendor Master (2026-10-14). DRY RUN by default: it only PRINTS what it would add.
//
//   cd backend
//   node scripts/seed-sample-vendors.js                       dry run on prisma/sandbox.db (prints, writes nothing)
//   node scripts/seed-sample-vendors.js --apply               adds the sample vendors to the SANDBOX (sandbox.db)
//   node scripts/seed-sample-vendors.js --db dev.db           dry run against the real database (read only)
//   TL_ALLOW_REAL_APPLY=1 node scripts/seed-sample-vendors.js --db dev.db --apply --really-real
//                                                             the ONLY way it writes to the real database
//
// It adds Vendor Master rows only (name + category + contact), through the app's own rules (VEN code, duplicate
// checks). It does NOT make logins: do that from Administration -> Company Setup -> Vendors -> Logins ->
// "+ Add vendor login" (the secure-link flow), so nobody ever sees a password.
//
// WARNING: "Airtel" is a REAL vendor of the company. The real database should get it BY HAND (with its real GSTIN,
// PAN, contact and bank terms), not from a sample script, so it is skipped for the real database unless you also pass
// --include-airtel. The two "Sample ..." vendors are placeholders you will normally delete again.
// RULE (owner, 2026-10-13): the real database keeps only real data. Never run this on it without meaning to.
// ---------------------------------------------------------------------------
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const dbName = path.basename(val('--db', 'sandbox.db'));
if (!/^[\w.-]+\.db$/.test(dbName)) { console.error('--db must be a file name inside backend/prisma (e.g. sandbox.db or dev.db).'); process.exit(2); }
const isReal = dbName === 'dev.db';
const APPLY = has('--apply');
if (APPLY && isReal && !(has('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: dev.db is the REAL database. To write there you must pass --really-real AND set TL_ALLOW_REAL_APPLY=1. Run the dry run first.');
  process.exit(2);
}
process.env.DATABASE_URL = `file:${path.join(BACK, 'prisma', dbName).replace(/\\/g, '/')}`;

const SAMPLES = [
  { name: 'Sample ID Cards Vendor', category: 'ID Cards', contactPerson: 'ID Cards Contact', email: 'idcards@sample-vendor.test', sample: true },
  { name: 'Airtel', category: 'Airtel SIM / Telecom', contactPerson: 'Airtel Account Manager', email: 'airtel@sample-vendor.test', real: true },
  { name: 'Sample Office Rent Vendor', category: 'Office Rent', contactPerson: 'Rent Contact', email: 'rent@sample-vendor.test', sample: true },
];

(async () => {
  const prisma = require(path.join(BACK, 'src/db'));
  const CFG = require(path.join(BACK, 'src/config/vendorModules'));
  const VM = require(path.join(BACK, 'src/utils/vendorMaster'));
  console.log(`Database: ${dbName}${isReal ? '  (REAL)' : '  (sandbox)'}   Mode: ${APPLY ? 'APPLY' : 'DRY RUN (nothing is written)'}`);
  console.log(`Vendors in it today: ${await prisma.officeVendor.count()}\n`);
  if (isReal) console.log('NOTE: "Airtel" is a REAL vendor. Add it by hand in Vendors -> + Add vendor with its real details. It is skipped here unless you pass --include-airtel.\n');
  let added = 0;
  for (const s of SAMPLES) {
    const modules = CFG.modulesForCategory(CFG.resolveCategory(s.category)).map((k) => CFG.MODULES[k].label).join(', ');
    const skipReal = isReal && s.real && !has('--include-airtel');
    const exists = await prisma.officeVendor.findFirst({ where: { name: s.name } });
    const what = exists ? 'already exists, skipped' : (skipReal ? 'skipped (real vendor: add by hand)' : (APPLY ? 'adding' : 'would add'));
    console.log(`  ${s.name.padEnd(28)} category "${s.category}" -> portal modules: ${modules}   [${what}]`);
    if (exists || skipReal || !APPLY) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const out = await VM.createVendor({ name: s.name, category: s.category, contactPerson: s.contactPerson, email: s.email }, { actor: null, source: 'Admin' });
    if (out.row) { added += 1; console.log(`     added ${out.row.vendorCode}`); } else console.log(`     NOT added: ${JSON.stringify(out.body).slice(0, 160)}`);
  }
  console.log(APPLY ? `\nDone: ${added} vendor(s) added. Now make their logins from the "+ Add vendor login" drawer.` : '\nDry run only. Add --apply to write (sandbox), or see the header for the real database.');
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
