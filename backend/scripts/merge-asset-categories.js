// ---------------------------------------------------------------------------
// MERGE DUPLICATE ASSET CATEGORIES (founder 2026-10-28: "assets lo konni duplicate category name tho unnai - Mobile and Mobile Phone,
// Headset and Head Set - aa duplicates ni teesesi okate pettu").
//
// Every stored asset category goes to ONE name (utils/assetCategory.js): "Head Set" -> "Headset", "Mobile" -> "Mobile Phone", and
// spellings that differ only in case / spaces / hyphens -> the most-used spelling. What follows the name is moved with it:
//   * Asset.category
//   * vendor logins' category grants (VendorAssetAccess.category; a duplicate grant is dropped)
//   * the vendor category map (AppSetting vendor.assetCategoryMap)
//   * the category's ledgers (Fixed Asset / Accumulated Depreciation / Repairs - <category>): when only the old name has ledgers,
//     they also answer to the new name and are renamed, so the books keep ONE set; when both names already have ledgers, nothing
//     is changed there and it is listed (merging two ledgers is an Accounts decision).
// Nothing is deleted except a repeated vendor grant. Dry run by default; --apply writes after a whole-database backup.
//
//   node scripts/merge-asset-categories.js            DRY RUN
//   node scripts/merge-asset-categories.js --apply
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const prisma = require('../src/db');
const { SAME, categoryKey: key } = require('../src/utils/assetCategory');

const APPLY = process.argv.includes('--apply');

(async () => {
  console.log(APPLY ? '*** APPLY ***' : '*** DRY RUN - nothing is written ***');
  const used = await prisma.asset.groupBy({ by: ['category'], _count: { _all: true } });
  // group the spellings: the known twins first, then case / spaces / hyphens
  const groups = new Map(); // group key -> [{ name, n }]
  used.forEach((u) => {
    if (!u.category) return;
    const k = key(SAME[key(u.category)] || u.category);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ name: u.category, n: u._count._all });
  });
  const moves = []; // { from, to, n }
  for (const [k, list] of groups) {
    const fixed = Object.values(SAME).find((v) => key(v) === k);
    const target = fixed || [...list].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))[0].name;
    list.forEach((x) => { if (x.name !== target) moves.push({ from: x.name, to: target, n: x.n }); });
  }
  console.log('\nCATEGORIES NOW');
  used.sort((a, b) => String(a.category).localeCompare(String(b.category))).forEach((u) => console.log(`  ${String(u.category).padEnd(22)} ${u._count._all}`));
  console.log(`\nTO MERGE (${moves.length})`);
  moves.forEach((m) => console.log(`  "${m.from}" (${m.n} asset${m.n === 1 ? '' : 's'}) -> "${m.to}"`));

  // ledgers of a category: the Fixed Asset ledger carries the alias asset-cat:<lowercase name> (utils/assetPosting.js)
  const ledgers = await prisma.ledgerAccount.findMany({ where: { OR: [{ code: { startsWith: '15' } }, { code: { startsWith: '16' } }, { code: { startsWith: '54' } }] } });
  const tagOf = (name) => `asset-cat:${String(name).trim().toLowerCase()}`;
  const faOf = (name) => ledgers.find((a) => a.code.startsWith('15') && String(a.aliases || '').split(',').includes(tagOf(name)));
  const ledgerPlan = [];
  const ledgerBoth = [];
  moves.forEach((m) => {
    const old = faOf(m.from);
    if (!old) return;
    if (faOf(m.to) || ledgerPlan.some((p) => p.to === m.to)) { ledgerBoth.push(m); return; }
    ledgerPlan.push({ ...m, nn: old.code.slice(2) });
  });
  if (ledgerPlan.length) console.log(`\nLEDGERS RENAMED (one set kept): ${ledgerPlan.map((p) => `15${p.nn}/16${p.nn}/54${p.nn} "${p.from}" -> "${p.to}"`).join('; ')}`);
  if (ledgerBoth.length) console.log(`\nBOTH NAMES HAVE LEDGERS - left as they are, for Accounts: ${ledgerBoth.map((m) => `"${m.from}" and "${m.to}"`).join('; ')}`);

  const grants = await prisma.vendorAssetAccess.findMany({ where: { category: { in: moves.map((m) => m.from) } } });
  const mapRow = await prisma.appSetting.findUnique({ where: { key: 'vendor.assetCategoryMap' } });
  if (grants.length) console.log(`\nVENDOR CATEGORY GRANTS MOVED: ${grants.length}`);

  if (!moves.length) { console.log('\nNothing to merge.'); process.exit(0); }
  if (!APPLY) { console.log('\nDRY RUN - run again with --apply to merge.'); process.exit(0); }

  const dir = path.join(os.homedir(), '.teamlink-backups', `merge-asset-categories-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(dir, { recursive: true });
  const bak = path.join(dir, 'before.db').split(path.sep).join('/');
  await prisma.$executeRawUnsafe(`VACUUM INTO '${bak.replace(/'/g, "''")}'`);

  let assets = 0;
  for (const m of moves) {
    // eslint-disable-next-line no-await-in-loop
    const r = await prisma.asset.updateMany({ where: { category: m.from }, data: { category: m.to } });
    assets += r.count;
  }
  let grantsMoved = 0; let grantsDropped = 0;
  for (const g of grants) {
    const to = moves.find((m) => m.from === g.category).to;
    // eslint-disable-next-line no-await-in-loop
    const dup = await prisma.vendorAssetAccess.findFirst({ where: { vendorUserId: g.vendorUserId, category: to } });
    // eslint-disable-next-line no-await-in-loop
    if (dup) { await prisma.vendorAssetAccess.delete({ where: { id: g.id } }); grantsDropped += 1; } else { await prisma.vendorAssetAccess.update({ where: { id: g.id }, data: { category: to } }); grantsMoved += 1; }
  }
  if (mapRow) {
    try {
      const v = JSON.parse(mapRow.value);
      Object.keys(v || {}).forEach((k) => { if (Array.isArray(v[k])) v[k] = [...new Set(v[k].map((c) => (moves.find((m) => m.from === c) || {}).to || c))]; });
      await prisma.appSetting.update({ where: { key: mapRow.key }, data: { value: JSON.stringify(v) } });
    } catch { /* an unreadable map is left alone */ }
  }
  for (const p of ledgerPlan) {
    const pairs = [[`15${p.nn}`, 'Fixed Asset', ''], [`16${p.nn}`, 'Accumulated Depreciation', ':dep'], [`54${p.nn}`, 'Repairs & Maintenance', ':rm']];
    for (const [code, word, sfx] of pairs) {
      const a = ledgers.find((x) => x.code === code);
      if (!a) continue; // eslint-disable-line no-continue
      const aliases = [...new Set([...String(a.aliases || '').split(',').filter(Boolean), `${tagOf(p.to)}${sfx}`])].join(',');
      const name = `${word} — ${p.to}`;
      // eslint-disable-next-line no-await-in-loop
      const clash = await prisma.ledgerAccount.findFirst({ where: { name, NOT: { id: a.id } } });
      // eslint-disable-next-line no-await-in-loop
      await prisma.ledgerAccount.update({ where: { id: a.id }, data: { aliases, ...(clash ? {} : { name }) } });
    }
  }
  for (const m of moves) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.auditLog.create({ data: { action: 'Asset category merged', entity: 'Asset', entityId: m.to, fromValue: m.from, toValue: m.to, reason: `${m.n} asset(s) - duplicate category names made one (merge-asset-categories.js)`, actorName: 'merge-asset-categories' } });
  }
  console.log(`\nDONE: ${assets} asset(s) moved, ${grantsMoved} vendor grant(s) moved, ${grantsDropped} repeated grant(s) dropped, ${ledgerPlan.length} ledger set(s) renamed.\nBackup: ${bak}`);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
