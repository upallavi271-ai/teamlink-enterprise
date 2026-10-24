#!/usr/bin/env node
// Marker-scoped cleaner for the SANDBOX database only. Deletes rows whose text columns contain
// ZZTEST / zztest / example.test (the markers every test fixture uses). Refuses any db that is not sandbox.db.
//   node scripts/qa/zz-clean.js            -> clean sandbox.db
//   node scripts/qa/zz-clean.js --count    -> only count (works on any db copy: DATABASE_URL=file:<copy> ... --count)
const path = require('path');
const BACK = path.resolve(__dirname, '..', '..');
const countOnly = process.argv.includes('--count');
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = `file:${BACK}/prisma/sandbox.db`;
if (!countOnly && !/sandbox\.db/i.test(process.env.DATABASE_URL)) { console.error('[zz-clean] refuses to delete from a database that is not sandbox.db'); process.exit(2); }
const { Prisma } = require(path.join(BACK, 'node_modules/@prisma/client'));
const prisma = require(path.join(BACK, 'src/db'));
const MARKS = ['ZZTEST', 'zztest', 'example.test'];

(async () => {
  const models = Prisma.dmmf.datamodel.models.map((m) => ({
    table: m.dbName || m.name,
    cols: m.fields.filter((f) => f.kind === 'scalar' && f.type === 'String').map((f) => f.dbName || f.name),
  })).filter((m) => m.cols.length);
  const where = (m) => m.cols.map((c) => MARKS.map((k) => `"${c}" LIKE '%${k}%'`).join(' OR ')).join(' OR ');
  const counts = {};
  const countAll = async () => {
    const out = {};
    for (const m of models) {
      try { const r = await prisma.$queryRawUnsafe(`SELECT COUNT(*) n FROM "${m.table}" WHERE ${where(m)}`); const n = Number(r[0].n); if (n) out[m.table] = n; } catch { /* */ }
    }
    return out;
  };
  const before = await countAll();
  if (countOnly) { console.log(JSON.stringify(before)); await prisma.$disconnect(); return; }
  // FK map: child table/column -> parent table/column (from sqlite PRAGMA), used to remove blocking children of marked parents
  const fks = [];
  for (const m of models) { try { const r = await prisma.$queryRawUnsafe(`PRAGMA foreign_key_list("${m.table}")`); for (const x of r) fks.push({ child: m.table, col: x.from, parent: x.table, pcol: x.to || 'id' }); } catch { /* */ } }
  const byTable = Object.fromEntries(models.map((m) => [m.table, m]));
  const delChildren = async (parent, whereSql, depth) => {
    if (depth > 4) return 0; let n = 0;
    for (const fk of fks.filter((x) => x.parent === parent)) {
      const sub = `SELECT "${fk.pcol}" FROM "${parent}" WHERE ${whereSql}`;
      const cw = `"${fk.col}" IN (${sub})`;
      try { n += await prisma.$executeRawUnsafe(`DELETE FROM "${fk.child}" WHERE ${cw}`); }
      catch { n += await delChildren(fk.child, cw, depth + 1); try { n += await prisma.$executeRawUnsafe(`DELETE FROM "${fk.child}" WHERE ${cw}`); } catch { /* */ } }
    }
    return n;
  };
  let removed = 0;
  for (let pass = 0; pass < 10; pass += 1) {
    let changed = 0;
    for (const m of models) {
      try { const n = await prisma.$executeRawUnsafe(`DELETE FROM "${m.table}" WHERE ${where(m)}`); changed += n; removed += n; } catch { const k = await delChildren(m.table, where(m), 0); changed += k; removed += k; }
    }
    if (!changed) break;
  }
  const left = await countAll();
  console.log(`[zz-clean] removed ${removed} rows; left: ${JSON.stringify(left)}`);
  await prisma.$disconnect();
})().catch((e) => { console.error('[zz-clean] ' + e.message); process.exit(1); });
