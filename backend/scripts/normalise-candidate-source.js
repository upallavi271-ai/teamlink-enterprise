#!/usr/bin/env node
// ---------------------------------------------------------------------------
// TIDY THE "SOURCE" WORDS ON REAL DATA (user, 2026-10-10) — DRY RUN BY DEFAULT.
//
// The screens already show every stored source through the clean list
// (utils/candidateSource.js) without touching the data. This script is the
// optional second step: write the clean word into Candidate.source and
// Application.source for good, keeping the old word.
//
//   node scripts/normalise-candidate-source.js                  dry run (default): prints the table, writes nothing
//   node scripts/normalise-candidate-source.js --db=<file>      look at / change another database (a copy, the sandbox)
//   node scripts/normalise-candidate-source.js --apply          change the data (backup + undo file first)
//   node scripts/normalise-candidate-source.js --undo=<file>    put every changed word back
//
// SAFETY
//   * the REAL database (prisma/dev.db) is refused for --apply / --undo unless
//     BOTH --really-real AND the environment variable TL_ALLOW_REAL_APPLY=1
//     are given. The dry run only READS.
//   * --apply first makes a full backup (VACUUM INTO) and an undo file listing
//     every row, its old word and its new word.
//   * the OLD word is kept: Candidate.firstSource / Application.firstSource is
//     filled with it where that was empty ("first source is recorded once and
//     never overwritten"), the undo file holds it for every row, and one audit
//     row per change group says what moved.
//   * Application.source values the Job Portal screening depends on
//     ("TeamLink Job Portal", "Job Portal", "HR Sourcing", utils/atsVocab.js
//     PRE_ATS_SOURCES) are NEVER rewritten.
//   * Nothing is deleted. Rows whose word is already the clean word are left alone.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (k) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : ''; };
const slash = (p) => p.split(String.fromCharCode(92)).join('/');

const DB = path.resolve(val('db') || path.join(BACK, 'prisma', 'dev.db'));
const REAL = path.resolve(BACK, 'prisma', 'dev.db');
const isReal = DB.toLowerCase() === REAL.toLowerCase();
const apply = has('--apply');
const undoFile = val('undo');
const asJson = has('--json');

if ((apply || undoFile) && isReal) {
  if (!has('--really-real') || process.env.TL_ALLOW_REAL_APPLY !== '1') {
    console.error('REFUSED: this is the REAL database (prisma/dev.db). Applying or undoing here needs --really-real AND the environment variable TL_ALLOW_REAL_APPLY=1. Look at the dry run first, and try --apply on a copy (--db=<copy>).');
    process.exit(3);
  }
}
if (!fs.existsSync(DB)) { console.error(`No such database: ${DB}`); process.exit(2); }
process.env.DATABASE_URL = `file:${slash(DB)}`;

// eslint-disable-next-line import/order
const { PrismaClient } = require('@prisma/client');
const SRC = require('../src/utils/candidateSource');

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const KEEP_AS_IS = new Set(['teamlink job portal', 'job portal', 'hr sourcing']); // functional Application.source markers
const n = (x) => Number(x || 0);
const pad = (s, w) => String(s).padEnd(w);
const lpad = (s, w) => String(s).padStart(w);
const short = (s, w) => (String(s).length > w ? `${String(s).slice(0, w - 1)}…` : String(s));

async function groups() {
  const [cs, as, cf, af] = await Promise.all([
    prisma.candidate.groupBy({ by: ['source'], _count: { _all: true } }),
    prisma.application.groupBy({ by: ['source'], _count: { _all: true } }),
    prisma.candidate.groupBy({ by: ['firstSource'], _count: { _all: true } }),
    prisma.application.groupBy({ by: ['firstSource'], _count: { _all: true } }),
  ]);
  return { cs, as, cf, af };
}

function table(g) {
  const rows = new Map();
  const add = (raw, key, field) => {
    const w = raw == null ? '' : String(raw);
    if (!rows.has(w)) rows.set(w, { raw: w, cand: 0, app: 0, candFirst: 0, appFirst: 0 });
    rows.get(w)[field] += n(key._count._all);
  };
  g.cs.forEach((x) => add(x.source, x, 'cand'));
  g.as.forEach((x) => add(x.source, x, 'app'));
  g.cf.forEach((x) => add(x.firstSource, x, 'candFirst'));
  g.af.forEach((x) => add(x.firstSource, x, 'appFirst'));
  return [...rows.values()].map((r) => ({ ...r, ...SRC.explain(r.raw), key: SRC.canonicalSource(r.raw) }))
    .sort((a, b) => (b.cand + b.app) - (a.cand + a.app));
}

function printTable(g, t) {
  const L = [];
  L.push(`Database: ${DB}${isReal ? '  (the REAL database: read only)' : ''}`);
  L.push('');
  L.push('Raw word on file -> clean source (why)   |  people (Candidate.source) | applications (Application.source)');
  L.push('-'.repeat(120));
  t.filter((r) => r.cand || r.app).forEach((r) => {
    L.push(`${pad(r.raw === '' ? '(blank)' : JSON.stringify(short(r.raw, 46)), 50)} -> ${pad(r.key, 33)} ${pad(`(${r.rule})`, 44)} ${lpad(r.cand, 7)} ${lpad(r.app, 8)}`);
  });
  const sumBy = (field) => {
    const m = new Map();
    t.forEach((r) => m.set(r.key, (m.get(r.key) || 0) + r[field]));
    return m;
  };
  const cm = sumBy('cand');
  const am = sumBy('app');
  L.push('');
  L.push('TOTALS BY CLEAN SOURCE (stored words only; blank counts as "Imported sheet (unknown origin)")');
  SRC.SOURCES.forEach((s) => L.push(`  ${pad(s, 34)} people ${lpad(cm.get(s) || 0, 7)}   applications ${lpad(am.get(s) || 0, 7)}`));
  const changedC = t.filter((r) => r.raw !== '' && r.raw !== r.key).reduce((s, r) => s + r.cand, 0);
  const changedA = t.filter((r) => r.raw !== '' && r.raw !== r.key && !KEEP_AS_IS.has(r.raw.toLowerCase())).reduce((s, r) => s + r.app, 0);
  const blankC = (t.find((r) => r.raw === '') || {}).cand || 0;
  const blankA = (t.find((r) => r.raw === '') || {}).app || 0;
  L.push('');
  L.push(`--apply WOULD WRITE: ${changedC} people and ${changedA} applications get the clean word (blank stays blank: ${blankC} people, ${blankA} applications; portal markers are never rewritten).`);
  return L.join('\n');
}

async function backupNow() {
  const root = process.env.BACKUP_DIR || path.join(os.homedir(), '.teamlink-backups');
  fs.mkdirSync(root, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(root, `before-source-tidy-${stamp}.db`);
  await prisma.$queryRawUnsafe(`VACUUM INTO '${slash(file)}'`).catch(() => prisma.$executeRawUnsafe(`VACUUM INTO '${slash(file)}'`));
  return { root, stamp, file };
}

async function doApply() {
  const b = await backupNow();
  console.log(`Backup made: ${b.file}`);
  const undo = { at: new Date().toISOString(), db: DB, backup: b.file, groups: [] };
  const audits = [];
  const t0 = await groups();
  const ids = async (table2, field, raw) => (await prisma[table2].findMany({ where: { [field]: raw }, select: { id: true } })).map((x) => x.id);
  for (const model of ['candidate', 'application']) {
    const g = model === 'candidate' ? t0.cs : t0.as;
    for (const x of g) {
      const raw = x.source;
      if (raw == null || String(raw).trim() === '') continue;
      if (model === 'application' && KEEP_AS_IS.has(String(raw).toLowerCase())) continue;
      const key = SRC.canonicalSource(raw);
      if (key === raw) continue;
      // eslint-disable-next-line no-await-in-loop
      const rowIds = await ids(model, 'source', raw);
      // First source: keep the old word where nothing was recorded.
      // eslint-disable-next-line no-await-in-loop
      const emptyFirst = (await prisma[model].findMany({ where: { id: { in: rowIds }, firstSource: null }, select: { id: true } })).map((r) => r.id);
      undo.groups.push({ model, old: raw, now: key, ids: rowIds, firstSourceFilled: emptyFirst });
      audits.push({ model, raw, key, count: rowIds.length });
    }
  }
  await prisma.$transaction(async (tx) => {
    for (const grp of undo.groups) {
      for (let i = 0; i < grp.ids.length; i += 400) {
        const chunk = grp.ids.slice(i, i + 400);
        const fill = grp.firstSourceFilled.filter((id) => chunk.includes(id));
        // eslint-disable-next-line no-await-in-loop
        if (fill.length) await tx[grp.model].updateMany({ where: { id: { in: fill }, firstSource: null }, data: { firstSource: grp.old } });
        // eslint-disable-next-line no-await-in-loop
        await tx[grp.model].updateMany({ where: { id: { in: chunk }, source: grp.old }, data: { source: grp.now } });
      }
    }
    await tx.auditLog.createMany({
      data: audits.map((a) => ({
        action: 'Source tidied', entity: a.model === 'candidate' ? 'Candidate' : 'Application', entityId: 'bulk',
        fromValue: short(a.raw, 190), toValue: a.key, reason: `Automatic tidy-up of the source word (${a.count} rows, ${undo.at.slice(0, 10)}); the old word is kept in firstSource and in the undo file`, actorName: 'System',
      })),
    });
  }, { timeout: 600000, maxWait: 30000 });
  const file = path.join(b.root, `source-tidy-undo-${b.stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(undo));
  const total = undo.groups.reduce((s, x) => s + x.ids.length, 0);
  console.log(`Changed ${total} rows in ${undo.groups.length} groups.`);
  console.log(`To put them back:  node scripts/normalise-candidate-source.js --db="${DB}" --undo="${file}"${isReal ? ' --really-real (and TL_ALLOW_REAL_APPLY=1)' : ''}`);
}

async function doUndo(file) {
  const u = JSON.parse(fs.readFileSync(file, 'utf8'));
  let rows = 0;
  await prisma.$transaction(async (tx) => {
    for (const grp of u.groups) {
      for (let i = 0; i < grp.ids.length; i += 400) {
        const chunk = grp.ids.slice(i, i + 400);
        // eslint-disable-next-line no-await-in-loop
        rows += (await tx[grp.model].updateMany({ where: { id: { in: chunk }, source: grp.now }, data: { source: grp.old } })).count;
        const fill = grp.firstSourceFilled.filter((id) => chunk.includes(id));
        // eslint-disable-next-line no-await-in-loop
        if (fill.length) await tx[grp.model].updateMany({ where: { id: { in: fill }, firstSource: grp.old }, data: { firstSource: null } });
      }
    }
    await tx.auditLog.create({ data: { action: 'Source tidy undone', entity: 'Candidate', entityId: 'bulk', reason: `Undo of ${path.basename(file)}: ${rows} rows`, actorName: 'System' } });
  }, { timeout: 600000, maxWait: 30000 });
  console.log(`Put back ${rows} rows.`);
}

(async () => {
  try {
    if (undoFile) { await doUndo(undoFile); return; }
    const g = await groups();
    const t = table(g);
    if (asJson) console.log(JSON.stringify(t));
    else console.log(printTable(g, t));
    if (apply) await doApply();
    else console.log('\nDRY RUN: nothing was changed. Add --apply to write the clean words (a backup and an undo file are made first).');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
