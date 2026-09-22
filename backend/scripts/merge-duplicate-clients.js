// ---------------------------------------------------------------------------
// MERGES CLIENT RECORDS THAT ARE ONE COMPANY WRITTEN TWO WAYS.
//
//   node scripts/merge-duplicate-clients.js            dry run
//   node scripts/merge-duplicate-clients.js --confirm  merge them
//
// The importer now matches a client ignoring punctuation and case, so this
// cannot happen again — but the records already imported were created before
// that fix, and a client whose requirements are split across two records
// reports half its numbers twice over.
//
// TWO NAMES ARE THE SAME COMPANY ONLY IF THEY MATCH ONCE EVERY
// NON-ALPHANUMERIC CHARACTER IS REMOVED. "Shifa Hospital, Tamil Nadu" and
// "Shifa Hospital,Tamil Nadu" differ by one space and merge. "Lalitha
// Hospitals,Gajularamaram" and "Lalitha Hospital, Chevalla" differ in WORDS —
// two real branches — and are left alone. Nothing here guesses at similarity.
const prisma = require('../src/db');

const CONFIRM = process.argv.includes('--confirm');
const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Keep the spelling that is not shouting: ALL CAPS is a paste out of a portal.
const better = (a, b) => {
  const shouty = (s) => s === s.toUpperCase();
  if (shouty(a.name) !== shouty(b.name)) return shouty(a.name) ? b : a;
  return a.name.length >= b.name.length ? a : b;
};

(async () => {
  const clients = await prisma.client.findMany({ select: { id: true, name: true } });
  const groups = {};
  clients.forEach((c) => { (groups[key(c.name)] = groups[key(c.name)] || []).push(c); });
  const dupes = Object.values(groups).filter((g) => g.length > 1);

  if (!dupes.length) { console.log('No duplicate client records.'); await prisma.$disconnect(); return; }
  console.log(CONFIRM ? '=== MERGING ===\n' : '=== DRY RUN ===\n');

  let moved = 0;
  let removed = 0;
  for (const group of dupes) {
    const keep = group.reduce(better);
    const drop = group.filter((c) => c.id !== keep.id);
    console.log(`KEEP  "${keep.name}"`);
    for (const d of drop) {
      // eslint-disable-next-line no-await-in-loop
      const [reqs, invs, users] = await Promise.all([
        prisma.requirement.count({ where: { clientId: d.id } }),
        prisma.invoice.count({ where: { clientId: d.id } }),
        prisma.user.count({ where: { clientId: d.id } }),
      ]);
      console.log(`  merge "${d.name}"  ->  ${reqs} requirements, ${invs} invoices, ${users} portal logins`);
      if (CONFIRM) {
        // eslint-disable-next-line no-await-in-loop
        await prisma.requirement.updateMany({ where: { clientId: d.id }, data: { clientId: keep.id } });
        // eslint-disable-next-line no-await-in-loop
        await prisma.invoice.updateMany({ where: { clientId: d.id }, data: { clientId: keep.id } });
        // eslint-disable-next-line no-await-in-loop
        await prisma.user.updateMany({ where: { clientId: d.id }, data: { clientId: keep.id } });
        // eslint-disable-next-line no-await-in-loop
        await prisma.client.delete({ where: { id: d.id } });
      }
      moved += reqs + invs + users;
      removed += 1;
    }
  }
  console.log(`\n${CONFIRM ? 'Moved' : 'Would move'} ${moved} records and ${CONFIRM ? 'removed' : 'would remove'} ${removed} duplicate client rows.`);
  console.log(`Clients: ${clients.length} -> ${clients.length - removed}`);
  if (!CONFIRM) console.log('\nRe-run with --confirm.');
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); try { await prisma.$disconnect(); } catch {} process.exit(1); });
