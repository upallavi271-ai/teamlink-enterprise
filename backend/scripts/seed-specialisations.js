#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SEED THE SPECIALIZATION MASTER (spec D, 2026-10-03) — idempotent.
//
//   node scripts/seed-specialisations.js            the database in .env (dev.db)
//   node scripts/seed-specialisations.js --sandbox  backend/prisma/sandbox.db
//   node scripts/seed-specialisations.js --dry      say what it would do, write nothing
//
// Creates the starter Department -> Qualification -> Specialization list
// (utils/specialisations.js SEED: Medical MBBS / MD / MS / BDS / Nursing ->
// Dermatology, Neurology, Cardiology, ENT, Orthodontics, ICU Nursing …;
// Education B.Ed -> Maths, Physics, Commerce …; IT -> Java, .NET, Testing …).
// Only what is missing is created; a value an Admin already renamed or
// switched off is left alone. A value the data import already wrote under the
// same department + name (e.g. Medical > Dermatology) is ADOPTED as the master
// row, so the import keeps validating against it.
//
// It writes ONLY Qualification and Specialisation rows. It never touches a
// requirement, a candidate, or the suggestion queue.
// ---------------------------------------------------------------------------
const path = require('path');

const args = process.argv.slice(2);
if (args.includes('--sandbox')) {
  process.env.DATABASE_URL = `file:${path.join(__dirname, '..', 'prisma', 'sandbox.db').replace(/\\/g, '/')}`;
} else {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); // eslint-disable-line global-require
}
const dry = args.includes('--dry');

// eslint-disable-next-line global-require
const prisma = require('../src/db');
// eslint-disable-next-line global-require
const sp = require('../src/utils/specialisations');

(async () => {
  try {
    console.log(`Database: ${process.env.DATABASE_URL}${dry ? '  (dry run — nothing written)' : ''}`);
    const out = await sp.seedMaster({ dry });
    console.log(`Qualifications created:   ${out.qualificationsCreated}`);
    console.log(`Specializations created:  ${out.specialisationsCreated}`);
    console.log(`Specializations adopted:  ${out.specialisationsAdopted} (imported values with the same name)`);
    if (out.skippedDepartments.length) console.log(`Departments not found (skipped): ${out.skippedDepartments.join(', ')}`);
    const [q, s] = await Promise.all([
      prisma.qualification.count(),
      prisma.specialisation.count({ where: { isMaster: true } }),
    ]);
    console.log(`Now on file: ${q} qualifications, ${s} master specializations.`);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
