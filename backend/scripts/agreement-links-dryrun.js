#!/usr/bin/env node
// ---------------------------------------------------------------------------
// AGREEMENT DRIVE LINKS - CHECK YOUR SHEET BEFORE USING THE SCREEN (user, 2026-10-12). READ-ONLY.
//
//   cd backend && node scripts/agreement-links-dryrun.js my-links.csv
//   cd backend && node scripts/agreement-links-dryrun.js my-links.xlsx --db C:\path\to\copy-of-dev.db
//
// Takes the same list you would paste into "Add agreement links (many at once)" (CSV, Excel, or text with TABs)
// and prints how every line would match against the real clients:
//
//     Matched / Close match (Did you mean X?) / Not found / Bad link / Bad date / Duplicate line / Already has a link
//
// It NEVER writes. It does not open dev.db at all: it first copies prisma/dev.db (and its -wal / -shm) into a temp folder
// and reads that COPY (or the copy you give with --db). It never opens, fetches or tests a link: the links are checked
// by their text only. It sees every client (no login), so "Not yours" cannot show here - that depends on who is logged in.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const dbFlag = args.indexOf('--db');
const dbArg = dbFlag >= 0 ? args.splice(dbFlag, 2)[1] : null;
const file = args[0];
if (!file || !fs.existsSync(file)) {
  console.error('Usage: node scripts/agreement-links-dryrun.js <list.csv|list.xlsx|list.txt> [--db <copy of dev.db>]');
  process.exit(2);
}

const BACK = path.resolve(__dirname, '..');
let dbFile = dbArg ? path.resolve(dbArg) : null;
let madeDir = null; // the temp copy this script made (removed again at the end)
if (!dbFile) {
  const src = path.join(BACK, 'prisma', 'dev.db');
  if (!fs.existsSync(src)) { console.error(`No ${src}. Pass a copy with --db.`); process.exit(2); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamlink-dryrun-'));
  madeDir = dir;
  dbFile = path.join(dir, 'dev-copy.db');
  fs.copyFileSync(src, dbFile);
  ['-wal', '-shm'].forEach((x) => { if (fs.existsSync(src + x)) fs.copyFileSync(src + x, dbFile + x); });
  console.log(`Reading a COPY of the database: ${dbFile}`);
}
if (path.basename(dbFile).toLowerCase() === 'dev.db' && path.resolve(dbFile) === path.join(BACK, 'prisma', 'dev.db')) {
  console.error('Refusing to open the real dev.db. Use the copy this script makes, or pass --db <a copy>.');
  process.exit(2);
}
process.env.DATABASE_URL = `file:${dbFile.split(path.sep).join('/')}`;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${dbFile.split(path.sep).join('/')}`;

const DL = require(path.join(BACK, 'src/utils/agreementDriveLinks'));
const prisma = require(path.join(BACK, 'src/db'));

(async () => {
  const buf = fs.readFileSync(file);
  let text;
  try { text = DL.fileToText(buf).text; } catch (e) { console.error(e.userMessage || e.message); process.exit(2); }
  const lines = DL.parseText(text);
  if (!lines.length) { console.error('No lines found in the file.'); process.exit(2); }
  const rows = await prisma.client.findMany({ where: { NOT: { clientType: 'Internal' } }, select: DL.CLIENT_FIELDS });
  const idx = DL.indexFromRows(rows, () => true);
  const have = new Set();
  try { (await DL.docsWithMeta({})).filter(DL.isActive).forEach((x) => have.add(x.doc.clientId)); } catch { /* the table may not have any */ }

  const seen = new Map();
  const out = lines.map((l) => {
    const issues = [];
    const r = DL.resolveRef(l.ref, idx);
    let status = 'Matched'; let detail = '';
    if (r.kind === 'ok' || r.kind === 'notyours') { detail = `${r.client.name} (${r.client.code})`; } else if (r.kind === 'close') { status = 'Close match'; detail = `Did you mean ${(r.suggestions || []).map((s) => `${s.name} (${s.code})`).join(' / ')}?`; } else { status = 'Not found'; }
    const lk = DL.validateLink(l.link);
    if (!lk.ok) issues.push(['Bad link', lk.text]);
    if (!DL.parseDate(l.agreementDate).ok || !DL.parseDate(l.endDate).ok) issues.push(['Bad date', 'The date does not look right (use 31-03-2026).']);
    if (r.kind === 'ok') {
      if (seen.has(r.client.id)) issues.push(['Duplicate line', `same client as line ${seen.get(r.client.id)}`]); else seen.set(r.client.id, l.row);
      if (have.has(r.client.id)) issues.push(['Already has a link', 'the screen will ask: Replace or Keep']);
    }
    return { row: l.row, typed: l.ref, status, detail, issues };
  });
  const pad = (s, n) => String(s).slice(0, n).padEnd(n);
  console.log(`\n${pad('Line', 5)}${pad('You wrote', 34)}${pad('Result', 13)}Details`);
  console.log('-'.repeat(100));
  out.forEach((o) => {
    console.log(`${pad(o.row, 5)}${pad(o.typed, 34)}${pad(o.status, 13)}${o.detail}`);
    o.issues.forEach(([k, t]) => console.log(`${' '.repeat(52)}! ${k}: ${t}`));
  });
  const n = (f) => out.filter(f).length;
  const good = n((o) => o.status === 'Matched' && !o.issues.some(([k]) => ['Bad link', 'Bad date', 'Duplicate line'].includes(k)));
  console.log('-'.repeat(100));
  console.log(`${out.length} lines: ${good} ready, ${n((o) => o.status === 'Close match')} close matches to confirm, ${n((o) => o.status === 'Not found')} not found, `
    + `${n((o) => o.issues.some(([k]) => k === 'Bad link'))} bad links, ${n((o) => o.issues.some(([k]) => k === 'Duplicate line'))} duplicates, ${n((o) => o.issues.some(([k]) => k === 'Already has a link'))} already have a link.`);
  console.log('Nothing was saved. Nothing was opened. This was a check only.');
  await prisma.$disconnect();
  if (madeDir) { try { fs.rmSync(madeDir, { recursive: true, force: true }); } catch { /* temp folder, cleaned by the system later */ } }
})().catch((e) => { console.error(e && e.message); process.exit(1); });
