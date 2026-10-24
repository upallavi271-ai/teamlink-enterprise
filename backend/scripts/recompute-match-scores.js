#!/usr/bin/env node
// ---------------------------------------------------------------------------
// RECOMPUTE THE STORED FIT NUMBERS after Salary became a real part of the Fit (2026-10-13).
//
// Most Fit numbers are computed when you look (Matching candidates, the profile, the job
// page): nothing to do for them. Only ONE kind is stored: Application.matchScore, written
// when a person is added to a job (routes/applications.js addApplication). This script
// shows what would change for those, and can rewrite them.
//
//   node scripts/recompute-match-scores.js                     DRY RUN on the sandbox copy (default). Writes nothing.
//   node scripts/recompute-match-scores.js --db <file>         DRY RUN on any copy of the database (e.g. a VACUUM INTO copy)
//   node scripts/recompute-match-scores.js --apply             REALLY rewrite (sandbox only unless the guards below)
//   node scripts/recompute-match-scores.js --undo <file>       put the old numbers back from an undo file
//
// SAFETY
//   * Dry run reads only. It prints: how many scores change, the distribution before / after
//     (bands of 10), how many have a salary that is not known (those are left out, not marked
//     down), and the 20 biggest movers.
//   * --apply first makes a BACKUP copy (VACUUM INTO backend/backups/…) and an UNDO file
//     (backend/backups/match-undo-<time>.json with every old matchScore / matchVersion /
//     matchDetail), then updates in small batches. --undo reads that file.
//   * The REAL database (prisma/dev.db) is refused for --apply and --undo unless you pass
//     --really-real AND set TL_ALLOW_REAL_APPLY=1. A dry run on it is allowed but a copy is better.
//   * The number is recomputed the way it is stored: the profile reading (no resume), the
//     current weights (Fit settings), "Match by meaning" off.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

const REAL = path.join(BACK, 'prisma', 'dev.db');
const dbFile = path.resolve(val('--db') || path.join(BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db')); // TL_TEST_DB: a private copy (tests)
const isReal = path.resolve(dbFile).toLowerCase() === REAL.toLowerCase();
const apply = flag('--apply');
const undoFile = val('--undo');
if ((apply || undoFile) && isReal && !(flag('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('Refusing: this is the REAL database. Use --really-real and TL_ALLOW_REAL_APPLY=1 only when the user said go. A dry run (no --apply) is fine.');
  process.exit(2);
}
if (!fs.existsSync(dbFile)) { console.error(`No such database file: ${dbFile}`); process.exit(2); }
const url = `file:${dbFile.split(path.sep).join('/')}`;
process.env.DATABASE_URL = url;

const { PrismaClient } = require(path.join(BACK, 'node_modules/@prisma/client'));
const prisma = new PrismaClient({ datasources: { db: { url } } });
const { computeMatch, setActiveWeights } = require(path.join(BACK, 'src/utils/matching'));

const bucket = (n) => (n == null ? 'none' : `${Math.min(90, Math.floor(n / 10) * 10)}-${Math.min(90, Math.floor(n / 10) * 10) + 9}`.replace('90-99', '90-100'));
const safeParse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

async function loadWeights() {
  // The weights the app is using now: the 'fit' AppSetting, else the defaults.
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: 'fit' } });
    const v = row ? safeParse(row.value) : null;
    if (v && v.weights) { setActiveWeights(v.weights); return 'saved weights'; }
  } catch { /* no table: defaults */ }
  return 'default weights';
}

async function undo() {
  const u = JSON.parse(fs.readFileSync(path.resolve(undoFile), 'utf8'));
  let n = 0;
  for (const r of u.rows) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.application.update({ where: { id: r.id }, data: { matchScore: r.matchScore, ...(r.hasDetail ? { matchVersion: r.matchVersion, matchDetail: r.matchDetail } : {}) } });
    n += 1;
  }
  console.log(`Put back ${n} Fit numbers from ${undoFile}.`);
}

async function main() {
  if (undoFile) { await undo(); return; }
  const weightsFrom = await loadWeights();
  const probe = await prisma.application.findFirst({ select: { matchVersion: true, matchDetail: true } }).catch(() => null);
  const hasDetail = !!probe;
  const select = { id: true, candidateId: true, requirementId: true, matchScore: true, ...(hasDetail ? { matchVersion: true, matchDetail: true } : {}) };
  const apps = await prisma.application.findMany({ where: { matchScore: { not: null } }, select });
  console.log(`Database: ${dbFile}${isReal ? '  (REAL)' : ''}\nWeights: ${weightsFrom}\nStored Fit numbers found: ${apps.length}`);
  const changes = [];
  const before = {}; const after = {};
  let unknownSalary = 0; let skipped = 0;
  for (let i = 0; i < apps.length; i += 300) {
    const slice = apps.slice(i, i + 300);
    // eslint-disable-next-line no-await-in-loop
    const [cands, reqs] = await Promise.all([
      prisma.candidate.findMany({ where: { id: { in: [...new Set(slice.map((a) => a.candidateId))] } } }),
      prisma.requirement.findMany({ where: { id: { in: [...new Set(slice.map((a) => a.requirementId))] } } }),
    ]);
    const cm = new Map(cands.map((c) => [c.id, c])); const rmap = new Map(reqs.map((r) => [r.id, r]));
    slice.forEach((a) => {
      const c = cm.get(a.candidateId); const r = rmap.get(a.requirementId);
      if (!c || !r) { skipped += 1; return; }
      const m = computeMatch(c, r);
      if (!m.salKnown) unknownSalary += 1;
      before[bucket(a.matchScore)] = (before[bucket(a.matchScore)] || 0) + 1;
      after[bucket(m.overall)] = (after[bucket(m.overall)] || 0) + 1;
      if (m.overall !== a.matchScore) changes.push({ app: a, from: a.matchScore, to: m.overall, salKnown: m.salKnown });
    });
  }
  const order = (o) => Object.keys(o).sort().map((k) => `${k}: ${o[k]}`).join(' | ');
  console.log(`Would change: ${changes.length} of ${apps.length - skipped} (${skipped} skipped: person or job missing)`);
  console.log(`Salary not known for ${unknownSalary} of them (left out of the score, not marked down)`);
  console.log(`Before  ${order(before)}\nAfter   ${order(after)}`);
  changes.sort((x, y) => Math.abs(y.to - y.from) - Math.abs(x.to - x.from));
  console.log('Top movers (application id: before -> after):');
  changes.slice(0, 20).forEach((c) => console.log(`  ${c.app.id}: ${c.from} -> ${c.to}${c.salKnown ? '' : ' (salary not known)'}`));
  if (!apply) { console.log('\nDRY RUN: nothing was written. Add --apply to rewrite (sandbox / a copy; the real database needs the two guards).'); return; }
  if (!changes.length) { console.log('Nothing to change.'); return; }
  // ---- apply: backup + undo file first ----
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(BACK, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const backup = path.join(dir, `${path.basename(dbFile)}.before-recompute-${stamp}.bak`).split(path.sep).join('/');
  await prisma.$queryRawUnsafe(`VACUUM INTO '${backup}'`);
  const undoPath = path.join(dir, `match-undo-${stamp}.json`);
  fs.writeFileSync(undoPath, JSON.stringify({ at: new Date().toISOString(), db: dbFile, hasDetail, rows: changes.map((c) => ({ id: c.app.id, matchScore: c.from, hasDetail, matchVersion: c.app.matchVersion ?? null, matchDetail: c.app.matchDetail ?? null })) }));
  console.log(`Backup: ${backup}\nUndo file: ${undoPath}`);
  let done = 0;
  for (const c of changes) {
    const detail = hasDetail && c.app.matchDetail ? (safeParse(c.app.matchDetail) || null) : null;
    const next = detail ? { ...detail, overall: c.to, recomputed: { at: new Date().toISOString(), from: c.from, to: c.to, formula: 'salary-factor-v2' } } : null;
    // eslint-disable-next-line no-await-in-loop
    await prisma.application.update({ where: { id: c.app.id }, data: { matchScore: c.to, ...(next ? { matchDetail: JSON.stringify(next) } : {}) } });
    done += 1;
  }
  console.log(`Rewrote ${done} Fit numbers. To put them back: node scripts/recompute-match-scores.js --undo ${undoPath}${isReal ? ' --really-real' : ''}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
