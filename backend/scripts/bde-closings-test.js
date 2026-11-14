// node scripts/bde-closings-test.js
// BDE closings (founder 2026-11-14): a BDE's joining is a NEW CLIENT whose agreement is signed (utils/recruiterJoinings.js bdeBoardRows). Runs on the SANDBOX
// copy only (refuses any other database), read-only. Checks, month by month: every BDE's joinings against a raw count of signed agreements per owner, the
// target, and that every other row of the board is exactly what it was without the BDE layer.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'file:./sandbox.db';
if (!/sandbox/i.test(process.env.DATABASE_URL)) { console.error('Refusing: this test only runs on the sandbox database.'); process.exit(1); }
process.env.TEST_MODE = '1';
const assert = require('assert');
const prisma = require('../src/db');
const RJ = require('../src/utils/recruiterJoinings');

(async () => {
  const months = (process.env.TEST_MONTHS || '2026-09,2026-10,2026-11').split(',');
  for (const month of months) {
    const [plain, withBde] = await Promise.all([RJ.monthBoard(month, { fresh: true }), RJ.monthBoard(month, { fresh: true, bde: true })]);
    // 1. nothing else moved: every row that is not a BDE-department row is the same in both boards
    const keep = (r) => !RJ.isBdeDept(r.department);
    assert.deepStrictEqual(withBde.rows.filter(keep).map((r) => [r.key, r.joinings, r.target]), plain.rows.filter(keep).map((r) => [r.key, r.joinings, r.target]),
      `${month}: the recruiters' rows are unchanged by the BDE layer`);
    const bdeRows = withBde.rows.filter((r) => RJ.isBdeDept(r.department));
    bdeRows.forEach((r) => { assert.strictEqual(r.kind, 'BDE'); assert.strictEqual(r.target, 4, `${month} ${r.name}: the standard target of 4`); assert.strictEqual(r.joiningList.length, r.joinings); });
    // 2. each BDE's joinings = signed agreements of the month in the raw table, by owner name
    const from = new Date(`${month}-01T00:00:00+05:30`);
    const [y, m] = month.split('-').map(Number);
    const to = new Date(Date.UTC(y, m, 1) - 330 * 60000); // first instant of the next month in India
    const raw = await prisma.client.findMany({ where: { agreementSignedAt: { gte: from, lt: to } }, select: { name: true, bdeOwner: true } });
    const rawBy = new Map();
    raw.filter((c) => !/zztest|example\.test/i.test(c.name)).forEach((c) => { const k = String(c.bdeOwner || '').trim().toLowerCase(); rawBy.set(k, (rawBy.get(k) || 0) + 1); });
    let matched = 0;
    bdeRows.forEach((r) => {
      const want = rawBy.get(String(r.name).trim().toLowerCase()) || 0;
      assert.strictEqual(r.joinings, want, `${month} ${r.name}: ${r.joinings} on the board, ${want} signed agreements in the table`);
      matched += want;
    });
    const unmatched = [...rawBy.entries()].reduce((n, [k, v]) => n + v, 0) - matched;
    assert.strictEqual(withBde.bdeSkipped, unmatched, `${month}: the agreements of owners who are no employee are counted as skipped`);
    console.log(`  ${month}: ${bdeRows.length} BDE rows, ${bdeRows.reduce((n, r) => n + r.joinings, 0)} signed agreements credited (${raw.length} signed in all, ${withBde.bdeSkipped} for nobody)`
      + ` -> ${bdeRows.filter((r) => r.joinings).map((r) => `${r.name} ${r.joinings}`).join(', ') || 'none'}`);
  }
  // 3. the detail of one BDE
  const oct = await RJ.monthBoard('2026-10', { bde: true });
  const some = oct.rows.find((r) => r.kind === 'BDE' && r.joinings > 0);
  if (some) {
    const d = await RJ.personMonthDetail('2026-10', some.key);
    assert.strictEqual(d.kind, 'agreements');
    assert.strictEqual(d.joined.length, some.joinings);
    assert.ok(d.joined.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.joiningDate)), 'each agreement shows the day it was signed');
    console.log(`  detail ${d.name}: ${d.joined.map((x) => `${x.client} (${x.joiningDate})`).join('; ')}`);
  }
  console.log('bde closings: all checks passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
