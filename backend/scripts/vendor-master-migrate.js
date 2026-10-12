#!/usr/bin/env node
// ---------------------------------------------------------------------------
// VENDOR MASTER MIGRATION (2026-10-09) - free-text bill vendors -> master rows.
//
//   node scripts/vendor-master-migrate.js --db sandbox.db            (DRY RUN: default, writes nothing)
//   node scripts/vendor-master-migrate.js --db sandbox.db --apply    (backup first, then writes)
//   node scripts/vendor-master-migrate.js --db sandbox.db --undo <manifest.json>
//
//   --db <file>   a file inside backend/prisma (required). dev.db is READ ONLY here:
//                 --apply / --undo on dev.db are refused unless TL_ALLOW_REAL_APPLY=1.
//   --out <dir>   where the report (report.txt, report.json, duplicates.csv) goes.
//
// WHAT IT DECIDES, in plain words
//   * Every distinct OfficeExpense.vendor text (case / extra spaces ignored) is one CANDIDATE.
//   * Blank vendor texts and names that are clearly not a vendor (a bank, "cash", "salary"...)
//     are listed separately as NOT A VENDOR / BLANK: no master row is made for them.
//   * Candidates that look like the same company as another candidate (same name apart from
//     Pvt/Ltd/LLP, one name inside the other, or the same GSTIN on two names) are NEVER merged
//     and NEVER created automatically: they are listed as DUPLICATE GROUPS FOR ADMIN REVIEW.
//   * A candidate that matches an existing master vendor by name is NOT created again; its
//     bills can be linked to that vendor.
//   * --apply creates a master row (source "Migration", VEN-code) for every CLEAR candidate and
//     links that candidate's bills (vendorId + address/PAN snapshot; vendor text and the bill's own
//     GSTIN are left exactly as they were; a bill with no GSTIN takes the vendor's).
//   * Before any write, a full copy of the database is made (VACUUM INTO <db>.bak-vendor-master-<time>)
//     and a manifest lists every row touched, so --undo puts it back.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

const dbArg = opt('--db');
if (!dbArg) { console.error('Give --db <file inside backend/prisma>, e.g. --db sandbox.db'); process.exit(2); }
const dbFile = path.resolve(BACK, 'prisma', path.basename(dbArg));
if (!fs.existsSync(dbFile)) { console.error(`No such database: ${dbFile}`); process.exit(2); }
const isReal = path.basename(dbFile) === 'dev.db';
const APPLY = flag('--apply');
const UNDO = opt('--undo');
if ((APPLY || UNDO) && isReal && process.env.TL_ALLOW_REAL_APPLY !== '1') {
  console.error('REFUSED: dev.db is the real database. Run the dry run, have Admin review the report, then main runs --apply with TL_ALLOW_REAL_APPLY=1.');
  process.exit(3);
}
const outDir = path.resolve(opt('--out') || path.join(BACK, 'backups'));
fs.mkdirSync(outDir, { recursive: true });
// A dry run on the real database reads a private SNAPSHOT of it (VACUUM INTO from a
// read-only handle), never the live file, so not even a connection pragma touches dev.db.
let workDb = dbFile;
if (isReal && !APPLY && !UNDO) {
  const { DatabaseSync } = require('node:sqlite');
  workDb = path.join(outDir, `snapshot-dev-${Date.now()}.db`);
  const ro = new DatabaseSync(dbFile, { readOnly: true });
  ro.exec(`VACUUM INTO '${workDb.replace(/\\/g, '/')}'`);
  ro.close();
  process.on('exit', () => { for (const x of ['', '-wal', '-shm']) { try { fs.unlinkSync(workDb + x); } catch { /* gone */ } } });
}
process.env.DATABASE_URL = `file:${workDb.replace(/\\/g, '/')}`;

const prisma = require(path.join(BACK, 'src/db'));
const VM = require(path.join(BACK, 'src/utils/vendorMaster'));
const { checkGstin } = require(path.join(BACK, 'src/utils/gstin'));

const NOT_VENDOR = [
  /\b(bank|hdfc|icici|sbi|axis|kotak|yes bank|idfc|canara|union bank|bob)\b/i,
  /^(cash|self|salary|salaries|wages|nil|na|n\/a|none|others?|misc|miscellaneous|-+|\.+|owner|director|partner|petty cash)$/i,
  /\b(neft|rtgs|imps|upi|cheque|chq|atm|charges?|interest|emi)\b/i,
];
const looksLikeNotVendor = (name) => NOT_VENDOR.some((re) => re.test(name));
const coreKey = VM.coreKey;

async function main() {
  const set = await (async () => {
    const cols = await prisma.$queryRawUnsafe('PRAGMA table_info("OfficeVendor")');
    if (!cols.some((c) => c.name === 'vendorCode')) throw new Error('This database does not have migration 20261009190000_vendor_master_v3 yet.');
    return true;
  })();
  if (UNDO) return undo(UNDO);
  const [expenses, masters] = await Promise.all([
    prisma.officeExpense.findMany({
      select: { id: true, expenseCode: true, vendor: true, vendorGstin: true, vendorId: true, monthlyAmount: true, expenseDate: true, entryKind: true },
    }),
    prisma.officeVendor.findMany(),
  ]);
  const masterByKey = new Map(masters.map((m) => [VM.nameKey(m.name), m]));

  const blank = expenses.filter((e) => !String(e.vendor || '').trim());
  const named = expenses.filter((e) => String(e.vendor || '').trim());
  const groups = new Map(); // nameKey -> candidate
  for (const e of named) {
    const k = VM.nameKey(e.vendor);
    const g = groups.get(k) || { key: k, spellings: new Map(), bills: [], gstins: new Map(), amount: 0, first: null, last: null };
    g.spellings.set(e.vendor.trim(), (g.spellings.get(e.vendor.trim()) || 0) + 1);
    g.bills.push(e);
    g.amount += Number(e.monthlyAmount) || 0;
    if (e.vendorGstin) { const gk = String(e.vendorGstin).trim().toUpperCase().replace(/\s+/g, ''); g.gstins.set(gk, (g.gstins.get(gk) || 0) + 1); }
    const d = e.expenseDate || null;
    if (d && (!g.first || d < g.first)) g.first = d;
    if (d && (!g.last || d > g.last)) g.last = d;
    groups.set(k, g);
  }
  const cands = [...groups.values()].map((g) => {
    const display = [...g.spellings.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return { ...g, name: display, bills: g.bills, count: g.bills.length, linked: g.bills.filter((b) => b.vendorId).length };
  }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const notVendor = cands.filter((c) => looksLikeNotVendor(c.name));
  const vendors = cands.filter((c) => !looksLikeNotVendor(c.name));

  // ---- review flags ----------------------------------------------------------
  const flags = new Map(vendors.map((c) => [c.key, []]));
  const addFlag = (c, text, other) => flags.get(c.key).push({ text, other: other ? other.name : null });
  for (let i = 0; i < vendors.length; i += 1) {
    for (let j = i + 1; j < vendors.length; j += 1) {
      const a = vendors[i]; const b = vendors[j];
      const ca = coreKey(a.name); const cb = coreKey(b.name);
      const sameCore = ca.length >= 4 && ca === cb;
      const contains = ca.length >= 5 && cb.length >= 5 && (ca.includes(cb) || cb.includes(ca));
      const sharedGstin = [...a.gstins.keys()].find((g) => b.gstins.has(g));
      if (sameCore) { addFlag(a, 'Same name apart from Pvt / Ltd / LLP as', b); addFlag(b, 'Same name apart from Pvt / Ltd / LLP as', a); }
      else if (contains) { addFlag(a, 'One name is inside the other:', b); addFlag(b, 'One name is inside the other:', a); }
      if (sharedGstin) { addFlag(a, `Same GSTIN ${sharedGstin} as`, b); addFlag(b, `Same GSTIN ${sharedGstin} as`, a); }
    }
  }
  vendors.forEach((c) => {
    if (/\s\/\s|\s\+\s/.test(c.name)) addFlag(c, 'The name may be TWO vendors written together - decide which one(s) to make', null);
  });
  const proposals = vendors.map((c) => {
    const f = flags.get(c.key);
    const existing = masterByKey.get(c.key) || null;
    const gstins = [...c.gstins.keys()];
    const good = gstins.filter((g) => checkGstin(g).ok);
    const notes = [];
    if (gstins.length > 1) notes.push(`${gstins.length} different GSTINs on its bills: ${gstins.join(', ')} - none set`);
    if (gstins.length === 1 && !good.length) notes.push(`GSTIN ${gstins[0]} on its bills fails the checksum - not set`);
    let action;
    if (existing) action = 'LINK-TO-EXISTING';
    else if (f.length || gstins.length > 1) action = 'REVIEW';
    else action = 'CREATE';
    return {
      name: c.name, spellings: [...c.spellings.keys()], bills: c.count, alreadyLinked: c.linked, amount: Math.round(c.amount * 100) / 100,
      first: c.first, last: c.last, gstin: gstins.length === 1 && good.length === 1 ? good[0] : null, gstinsSeen: gstins,
      existingVendor: existing ? `${existing.vendorCode || ''} ${existing.name}`.trim() : null, action, flags: f, notes,
    };
  });

  const summary = {
    database: isReal && !APPLY ? 'dev.db (read-only snapshot)' : path.basename(dbFile), mode: APPLY ? 'APPLY' : 'DRY RUN', billsTotal: expenses.length, billsBlankVendor: blank.length,
    billsWithVendorText: named.length, distinctVendorTexts: cands.length, notVendorTexts: notVendor.length,
    toCreate: proposals.filter((p) => p.action === 'CREATE').length, toLinkToExisting: proposals.filter((p) => p.action === 'LINK-TO-EXISTING').length,
    needReview: proposals.filter((p) => p.action === 'REVIEW').length, mastersAlready: masters.length,
  };
  const report = {
    summary,
    notAVendorOrBlank: [
      { text: '(blank - no vendor typed)', bills: blank.length },
      ...notVendor.map((c) => ({ text: c.name, bills: c.count, amount: Math.round(c.amount * 100) / 100, note: 'looks like a bank / cash / internal entry' })),
    ],
    proposals,
    duplicateGroups: proposals.filter((p) => p.flags.length).map((p) => ({ name: p.name, bills: p.bills, flags: p.flags })),
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(outDir, `vendor-master-${APPLY ? 'apply' : 'dryrun'}-${path.basename(dbFile, '.db')}-${stamp}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
  const lines = [];
  lines.push(`VENDOR MASTER ${summary.mode} - ${summary.database} - ${new Date().toISOString()}`);
  lines.push(`Bills: ${summary.billsTotal} (blank vendor ${summary.billsBlankVendor}, with a vendor text ${summary.billsWithVendorText}); distinct vendor texts ${summary.distinctVendorTexts}`);
  lines.push(`Vendor master rows already: ${summary.mastersAlready}`);
  lines.push(`Would CREATE ${summary.toCreate} | LINK to an existing master vendor ${summary.toLinkToExisting} | NEED ADMIN REVIEW ${summary.needReview} | NOT A VENDOR ${summary.notVendorTexts}`);
  lines.push('', 'NOT A VENDOR / BLANK (no master row is made):');
  report.notAVendorOrBlank.forEach((n) => lines.push(`  - ${n.text}: ${n.bills} bill(s)${n.amount ? `, Rs ${n.amount}` : ''}${n.note ? ` (${n.note})` : ''}`));
  lines.push('', 'CLEAR (created and linked on --apply):');
  proposals.filter((p) => p.action === 'CREATE').forEach((p) => lines.push(`  + ${p.name}: ${p.bills} bill(s), Rs ${p.amount}, ${p.first || '?'}..${p.last || '?'}${p.gstin ? `, GSTIN ${p.gstin}` : ''}${p.spellings.length > 1 ? `, spellings: ${p.spellings.join(' | ')}` : ''}${p.notes.length ? ` [${p.notes.join('; ')}]` : ''}`));
  lines.push('', 'LINK TO AN EXISTING MASTER VENDOR:');
  proposals.filter((p) => p.action === 'LINK-TO-EXISTING').forEach((p) => lines.push(`  = ${p.name} -> ${p.existingVendor}: ${p.bills} bill(s)`));
  lines.push('', 'DUPLICATE REPORT - ADMIN MUST DECIDE (never merged, never created automatically):');
  proposals.filter((p) => p.action === 'REVIEW').forEach((p) => {
    lines.push(`  ? ${p.name}: ${p.bills} bill(s), Rs ${p.amount}`);
    p.flags.forEach((f) => lines.push(`      - ${f.text} ${f.other || ''}`.trimEnd()));
    p.notes.forEach((n) => lines.push(`      - ${n}`));
  });
  fs.writeFileSync(`${base}.txt`, lines.join('\n'));
  const csv = ['name,bills,amount,action,gstin,flags'];
  proposals.forEach((p) => csv.push([p.name, p.bills, p.amount, p.action, p.gstin || '', [...p.flags.map((f) => `${f.text} ${f.other || ''}`), ...p.notes].join(' ; ')].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')));
  fs.writeFileSync(`${base}.csv`, csv.join('\n'));
  console.log(lines.join('\n'));
  console.log(`\nReport files:\n  ${base}.txt\n  ${base}.json\n  ${base}.csv`);

  if (!APPLY) { console.log('\nDRY RUN: nothing was written.'); return; }

  // ---- APPLY: backup, then write ---------------------------------------------
  const { DatabaseSync } = require('node:sqlite');
  const backup = `${dbFile}.bak-vendor-master-${stamp}`;
  const src = new DatabaseSync(dbFile, { readOnly: true });
  src.exec(`VACUUM INTO '${backup.replace(/\\/g, '/')}'`);
  src.close();
  console.log(`\nBackup written: ${backup}`);
  const manifest = { database: path.basename(dbFile), backup, at: new Date().toISOString(), createdVendors: [], linkedExpenses: [] };
  const mpath = `${base}.manifest.json`;
  const save = () => fs.writeFileSync(mpath, JSON.stringify(manifest, null, 2));
  for (const p of proposals.filter((x) => x.action === 'CREATE')) {
    // eslint-disable-next-line no-await-in-loop
    const out = await VM.createVendor({ name: p.name, gstin: p.gstin || '' }, { actor: null, source: 'Migration' });
    if (!out.row) { console.log(`  skipped ${p.name}: ${out.body && out.body.error}`); continue; } // eslint-disable-line no-continue
    manifest.createdVendors.push({ id: out.row.id, code: out.row.vendorCode, name: out.row.name });
    await linkBills(out.row, p, manifest); // eslint-disable-line no-await-in-loop
    save();
  }
  for (const p of proposals.filter((x) => x.action === 'LINK-TO-EXISTING')) {
    const m = masterByKey.get(VM.nameKey(p.name));
    await linkBills(m, p, manifest); // eslint-disable-line no-await-in-loop
    save();
  }
  save();
  console.log(`\nAPPLIED: ${manifest.createdVendors.length} vendor(s) created, ${manifest.linkedExpenses.length} bill(s) linked.\nUndo with: node scripts/vendor-master-migrate.js --db ${path.basename(dbFile)} --undo ${mpath}`);
}

async function linkBills(vendor, p, manifest) {
  const key = VM.nameKey(p.name);
  const bills = await prisma.officeExpense.findMany({ where: { vendorId: null, vendor: { not: null } }, select: { id: true, vendor: true, vendorGstin: true } });
  const mine = bills.filter((b) => VM.nameKey(b.vendor) === key);
  const snap = VM.vendorSnapshot(vendor);
  for (const b of mine) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.officeExpense.update({
      where: { id: b.id },
      data: { vendorId: snap.vendorId, vendorPan: snap.vendorPan, vendorAddress: snap.vendorAddress, ...(b.vendorGstin ? {} : { vendorGstin: snap.vendorGstin }) },
    });
    manifest.linkedExpenses.push({ id: b.id, filledGstin: !b.vendorGstin && !!snap.vendorGstin });
  }
}

async function undo(file) {
  const m = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  if (m.database !== path.basename(dbFile)) throw new Error(`The manifest is for ${m.database}, not ${path.basename(dbFile)}.`);
  let unlinked = 0;
  for (const e of m.linkedExpenses) {
    // eslint-disable-next-line no-await-in-loop
    const r = await prisma.officeExpense.updateMany({ where: { id: e.id }, data: { vendorId: null, vendorPan: null, vendorAddress: null, ...(e.filledGstin ? { vendorGstin: null } : {}) } });
    unlinked += r.count;
  }
  let removed = 0; const kept = [];
  for (const v of m.createdVendors) {
    // eslint-disable-next-line no-await-in-loop
    const [logins, docs, assets, bills, others] = await Promise.all([
      prisma.vendorUser.count({ where: { vendorId: v.id } }), prisma.vendorSharedDocument.count({ where: { vendorId: v.id } }),
      prisma.asset.count({ where: { vendorId: v.id } }), prisma.vendorBillSubmission.count({ where: { vendorId: v.id } }),
      prisma.officeExpense.count({ where: { vendorId: v.id } }),
    ]);
    if (logins || docs || assets || bills || others) { kept.push(`${v.name}: still used (logins ${logins}, documents ${docs}, assets ${assets}, portal bills ${bills}, bills ${others})`); continue; } // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    await prisma.officeVendor.delete({ where: { id: v.id } }); removed += 1;
  }
  console.log(`UNDONE: ${unlinked} bill(s) unlinked, ${removed} vendor(s) removed.${kept.length ? `\nKept (still in use):\n  ${kept.join('\n  ')}` : ''}\nFull backup copy from before the apply: ${m.backup}`);
}

main().then(() => prisma.$disconnect()).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
