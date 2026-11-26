// TL PARTNERS (utils/tlPartners.js): on a COPY of a database, never the live one.
//   TEST_SOURCE_DB=<a .db file> node scripts/tl-partners-test.js
// Checks: with no group nothing changes; an Education job made with TL A gets TL B too (and the other way); a job of another
// department does not; RT.setExtras (the "assign TLs" path) keeps the group; nothing is ever removed.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = process.env.TEST_SOURCE_DB;
if (!SRC || !fs.existsSync(SRC)) { console.log('Set TEST_SOURCE_DB to a .db file to copy.'); process.exit(2); }
const COPY = path.join(os.tmpdir(), `tlp-test-${Date.now()}.db`);
fs.copyFileSync(SRC, COPY);
process.env.DATABASE_URL = `file:${COPY.split(path.sep).join('/')}`;

let total = 0; let failed = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 300)}` : ''}`); } };
const tick = () => new Promise((r) => setTimeout(r, 300));

(async () => {
  const prisma = require('../src/db');
  const RT = require('../src/utils/reqTeamLeads');
  const TP = require('../src/utils/tlPartners');
  try {
    const tag = `TLP${Date.now() % 100000}`;
    const mk = (n) => prisma.user.create({ data: { name: `${tag} ${n}`, email: `${tag.toLowerCase()}.${n}@example.test`, passwordHash: '!no-login!', role: 'TL', atsRole: 'TL', status: 'Active' } });
    const [a, b, c] = [await mk('a'), await mk('b'), await mk('c')];
    const client = await prisma.client.findFirst({ select: { id: true } });
    const job = (dept, tlId) => prisma.requirement.create({ data: { title: `${tag} ${dept}`, department: dept, tlId, clientId: client ? client.id : undefined, status: 'OPEN' } });
    const tlsNow = async (id) => { await RT.ensure(true); const r = await prisma.requirement.findUnique({ where: { id }, select: { tlId: true } }); return RT.clean([r.tlId, ...RT.extrasOf(id)]); };

    // no group yet: nothing happens
    await TP.setGroups([]);
    const j0 = await job('Education', a.id); await tick();
    check('no group: an Education job keeps only its own TL', (await tlsNow(j0.id)).join() === a.id);

    await TP.setGroups([{ department: 'Education', tls: [a.id, b.id] }]);
    const j1 = await job('Education', a.id); await tick();
    check('a new Education job with TL A also gets TL B', (await tlsNow(j1.id)).sort().join() === [a.id, b.id].sort().join(), await tlsNow(j1.id));
    const j2 = await job('Education', b.id); await tick();
    check('... and the other way: TL B gets TL A', (await tlsNow(j2.id)).sort().join() === [a.id, b.id].sort().join());
    const j3 = await job('IT', a.id); await tick();
    check('a job of another department is not touched', (await tlsNow(j3.id)).join() === a.id);
    const j4 = await job('education', c.id); await tick();
    check('an Education job whose TL is not in the group is not touched', (await tlsNow(j4.id)).join() === c.id);

    // "Assign TLs" (RT.setExtras replaces the team): moving the job to B alone still brings A back
    await prisma.requirement.update({ where: { id: j1.id }, data: { tlId: b.id } });
    await RT.setExtras(j1.id, b.id, []); await tick();
    check('re-assigning to TL B alone keeps TL A (the group stays together)', (await tlsNow(j1.id)).sort().join() === [a.id, b.id].sort().join(), await tlsNow(j1.id));
    // adding a third TL keeps everyone
    await RT.setExtras(j2.id, b.id, [c.id]); await tick();
    check('adding another TL keeps the group and the new one', (await tlsNow(j2.id)).sort().join() === [a.id, b.id, c.id].sort().join(), await tlsNow(j2.id));
    // the one-time catch-up for an older job (made before the group): syncJob adds the partner
    const added = await TP.syncJob(j0.id);
    check('an older job is brought up to the group by syncJob', added.join() === b.id && (await tlsNow(j0.id)).sort().join() === [a.id, b.id].sort().join());
    // an inactive partner is never added
    await prisma.user.update({ where: { id: b.id }, data: { status: 'Inactive' } });
    const j5 = await job('Education', a.id); await tick();
    check('an inactive partner is not added', (await tlsNow(j5.id)).join() === a.id);
  } catch (e) {
    failed += 1; total += 1; console.log(`FAIL  crashed: ${e.stack || e.message}`);
  } finally {
    await prisma.$disconnect();
    try { fs.unlinkSync(COPY); } catch { /* in use */ }
  }
  console.log(`\n${total - failed}/${total} passed`);
  process.exit(failed ? 1 : 0);
})();
