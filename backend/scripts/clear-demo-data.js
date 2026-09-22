// ---------------------------------------------------------------------------
// REMOVES THE SEEDED DEMO DATA, so real data can take its place.
//
//   node scripts/clear-demo-data.js              dry run — counts only
//   node scripts/clear-demo-data.js --confirm    actually delete
//
// WHAT GOES: the demo ATS and Accounts business data — clients, requirements,
// candidates, applications and invoices, with everything hanging off them
// (stage events, follow-ups, interviews, messages, notes, documents,
// payments).
//
// WHAT STAYS, AND WHY: THE PEOPLE AND THEIR LOGINS.
//
// This is a deliberate decision, not an oversight. The real requirement
// sheets contain clients and jobs — they contain no employees at all. Delete
// the 44 logins to be thorough and there is nobody left who can sign in to
// look at the imported data, including the Super Admin running the import. So
// employees, users, departments, teams and everything attached to a person
// (attendance, leave, approvals, courses) are left exactly as they are, and a
// real employee sheet can replace them later through the same importer.
//
// THE ONE EXCEPTION: the four demo CLIENT logins and two demo CANDIDATE
// logins. Those point at specific demo client and candidate records, so once
// those records are gone the logins address nothing. They are removed with
// the records they belong to rather than left dangling, and real client
// portal logins get created against the real clients.
//
// ALSO REMOVED: the rows the import was tested with (employee codes starting
// IMP-, the importtest.local logins, Zenith Pharma, IMPREQ-/IMPINV-, the
// Pharma department). Those are not the company's data and not the demo
// seed's either — they are test leftovers, and leaving them in would put
// fictional records in front of somebody looking at their own numbers.
// ---------------------------------------------------------------------------

const prisma = require('../src/db');

const CONFIRM = process.argv.includes('--confirm');
const label = CONFIRM ? 'DELETING' : 'would delete';

async function count(model, where) {
  try { return await prisma[model].count(where ? { where } : undefined); } catch { return 0; }
}
async function wipe(model, where) {
  const n = await count(model, where);
  if (n && CONFIRM) {
    try { await prisma[model].deleteMany(where ? { where } : {}); } catch (e) { console.log(`    ! ${model}: ${e.message.split('\n')[0]}`); return n; }
  }
  if (n) console.log(`  ${label.padEnd(12)} ${String(n).padStart(5)}  ${model}`);
  return n;
}

(async () => {
  console.log(CONFIRM ? '=== CLEARING DEMO DATA ===\n' : '=== DRY RUN — nothing will be deleted ===\n');
  let total = 0;

  // --- 1. the test leftovers, by their own markers ------------------------
  console.log('Import-test leftovers:');
  total += await wipe('invoice', { invoiceNumber: { startsWith: 'IMPINV-' } });
  total += await wipe('requirement', { reqCode: { startsWith: 'IMPREQ-' } });
  total += await wipe('candidate', { email: { contains: 'importtest.local' } });
  total += await wipe('client', { name: { startsWith: 'Zenith Pharma' } });
  total += await wipe('employee', { employeeCode: { startsWith: 'IMP-' } });
  total += await wipe('user', { email: { contains: 'importtest.local' } });
  total += await wipe('specialisation', { department: { name: 'Pharma' } });
  total += await wipe('team', { department: { name: 'Pharma' } });
  total += await wipe('department', { name: 'Pharma' });

  // --- 2. the portal logins that address records about to be deleted ------
  console.log('\nDemo portal logins (they point at demo records):');
  total += await wipe('user', { clientId: { not: null } });
  total += await wipe('user', { candidateId: { not: null } });

  // --- 3. the demo ATS and Accounts data, in dependency order -------------
  // Most children cascade from their parent, but deleting them explicitly
  // first keeps this readable and means a missing cascade shows up here
  // rather than as a foreign-key error halfway through.
  console.log('\nATS and Accounts business data:');
  total += await wipe('invoicePayment');
  total += await wipe('invoice');
  total += await wipe('applicationFollowUp');
  total += await wipe('applicationStageEvent');
  total += await wipe('interviewEvent');
  total += await wipe('interviewFeedback');
  total += await wipe('application');
  total += await wipe('candidateMessage');
  total += await wipe('candidateNote');
  total += await wipe('candidateDocument');
  total += await wipe('candidate');
  total += await wipe('requirement');
  total += await wipe('client');

  console.log(`\n${CONFIRM ? 'Deleted' : 'Would delete'} ${total} rows in total.`);

  console.log('\nKEPT, on purpose:');
  console.log(`  ${await count('user')} logins`);
  console.log(`  ${await count('employee')} employees`);
  console.log(`  ${await count('department')} departments, ${await count('team')} teams`);
  console.log(`  ${await count('attendance')} attendance, ${await count('leaveRequest')} leave, ${await count('approvalStep')} approval steps`);
  console.log('  Nobody loses their sign-in. A real employee sheet can replace these through the importer.');

  if (!CONFIRM) console.log('\nRe-run with --confirm to delete.');
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); try { await prisma.$disconnect(); } catch {} process.exit(1); });
