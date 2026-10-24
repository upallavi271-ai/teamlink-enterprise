#!/usr/bin/env node
// ---------------------------------------------------------------------------
// DUPLICATE JOBS on the real data — dry run first, apply only with the guards (2026-10-13).
//
//   node scripts/job-duplicates.js                      DRY RUN (default): clusters, counts, what would close / move. Reads a COPY of
//                                                       the database (VACUUM INTO a temp file when the target is dev.db) — dev.db is
//                                                       never opened for writing.
//   node scripts/job-duplicates.js --csv [file]         also write every cluster as CSV (default: ./job-duplicates-<date>.csv)
//   node scripts/job-duplicates.js --level CERTAIN      only that level (CERTAIN | LIKELY | POSSIBLE; default all)
//   node scripts/job-duplicates.js --client <id>        only one client      --top 10  how many clients / clusters to print
//   node scripts/job-duplicates.js --db <file>          another database file (the sandbox)
//   node scripts/job-duplicates.js --apply --really-real   with TL_ALLOW_REAL_APPLY=1 in the environment (the real dev.db):
//        backup first (VACUUM INTO backups/), then the CERTAIN clusters that have NO blocker, one cluster at a time (each merge is
//        one transaction, with its own merge log), and an UNDO MANIFEST (backups/job-duplicates-<stamp>.manifest.json).
//        On any other database, --apply needs only itself.
//   node scripts/job-duplicates.js --undo <manifest> [--really-real]   puts every merge of a manifest back (inside the 7-day window)
//
// A cluster is BLOCKED (never applied) when a job that would be merged away has an invoice. The kept job is the one with the
// invoices / joined people, then the most candidates, the furthest step, the oldest.
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const fs = require('fs');
const os = require('os');
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };

const REAL = path.join(BACK, 'prisma', 'dev.db');
const dbFile = path.resolve(val('--db', null) || (process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/^file:/, '').replace(/\?.*$/, '') : REAL));
const norm = (p) => path.resolve(p).toLowerCase().split(path.sep).join('/');
const isReal = norm(dbFile) === norm(REAL);
const apply = flag('--apply'); const undoFile = val('--undo', null);

if ((apply || undoFile) && isReal) {
  if (!flag('--really-real')) { console.error('Refusing: this is the REAL dev.db. Writing needs --really-real and TL_ALLOW_REAL_APPLY=1 (main applies).'); process.exit(2); }
  if (process.env.TL_ALLOW_REAL_APPLY !== '1') { console.error('Refusing: TL_ALLOW_REAL_APPLY=1 is not set (main applies this to the real dev.db).'); process.exit(2); }
}

(async () => {
  let readFile = dbFile; let tmp = null;
  const { PrismaClient } = require(path.join(BACK, 'node_modules/@prisma/client'));
  const url = (f) => `file:${path.resolve(f).split(path.sep).join('/')}`;
  if (!apply && !undoFile && isReal) {
    // dry run on the real database: read a copy, never the file itself
    tmp = path.join(os.tmpdir(), `job-dup-copy-${Date.now()}.db`);
    const p0 = new PrismaClient({ datasources: { db: { url: `${url(REAL)}?mode=ro` } } });
    await p0.$queryRawUnsafe(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    await p0.$disconnect();
    readFile = tmp;
  }
  process.env.DATABASE_URL = url(readFile);
  const prisma = require(path.join(BACK, 'src/db'));
  const D = require(path.join(BACK, 'src/utils/jobDupes'));
  const M = require(path.join(BACK, 'src/utils/jobMerge'));
  const R = require(path.join(BACK, 'src/utils/jobDupResolve'));

  try {
    // ---------------------------------------------------------------- undo
    if (undoFile) {
      const man = JSON.parse(fs.readFileSync(path.resolve(undoFile), 'utf8'));
      let ok = 0; const bad = [];
      for (const m of [...man.merges].reverse()) {
        try { await M.undoMerge(m.logId, null); ok += 1; } catch (e) { bad.push(`${m.extraCode || m.extraId}: ${e.message}`); } // eslint-disable-line no-await-in-loop
      }
      console.log(`Undone ${ok} of ${man.merges.length} merges.${bad.length ? `\nNot undone:\n  ${bad.join('\n  ')}` : ''}`);
      return;
    }

    // ---------------------------------------------------------------- the analysis
    const only = val('--level', null);
    const oneClient = val('--client', null);
    const top = Number(val('--top', 10)) || 10;
    const t0 = Date.now();
    const data = await D.everything({ force: true });
    let clusters = data.clusters.filter((c) => (!only || c.level === only) && (!oneClient || c.clientId === oneClient));
    const ids = [...new Set(clusters.flatMap((c) => c.jobIds))];
    const st = ids.length ? await M.statsFor(ids) : {};
    const clients = new Map((await prisma.client.findMany({ select: { id: true, name: true } })).map((c) => [c.id, c.name]));
    const rows = clusters.map((c) => {
      const jobs = c.jobIds.map((i) => data.byId.get(i).j).sort((a, b) => D.ts(a.createdAt) - D.ts(b.createdAt));
      const kept = R.suggestKept(jobs, st);
      const extras = jobs.filter((j) => j.id !== kept.id);
      const blockers = extras.filter((j) => (st[j.id] || {}).invoices).map((j) => `${j.reqCode} has an invoice`);
      const move = extras.reduce((n, j) => n + ((st[j.id] || {}).apps || 0), 0);
      return { c, jobs, kept, extras, blockers, move, client: clients.get(c.clientId) || c.clientId };
    });
    const by = (lv) => rows.filter((r) => r.c.level === lv);
    console.log(`Database: ${isReal ? 'REAL dev.db (read from a copy)' : dbFile}`);
    console.log(`Jobs looked at: ${data.jobs}   pairs that matched: ${data.edges}   built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log('\nBy level');
    ['CERTAIN', 'LIKELY', 'POSSIBLE'].forEach((lv) => {
      const r = by(lv);
      console.log(`  ${lv.padEnd(9)} clusters ${String(r.length).padStart(4)}   jobs in them ${String(r.reduce((n, x) => n + x.jobs.length, 0)).padStart(4)}   extra jobs that would close ${String(r.reduce((n, x) => n + x.extras.length, 0)).padStart(4)}   candidate links that would move ${String(r.reduce((n, x) => n + x.move, 0)).padStart(5)}   blocked ${r.filter((x) => x.blockers.length).length}`);
    });
    const blocked = rows.filter((r) => r.blockers.length);
    console.log(`\nBlocked clusters (an invoiced job would be merged away): ${blocked.length}`);
    blocked.slice(0, top).forEach((r) => console.log(`  ${r.client}: ${r.blockers.join('; ')}`));
    const perClient = new Map();
    rows.forEach((r) => { const e = perClient.get(r.client) || { CERTAIN: 0, LIKELY: 0, POSSIBLE: 0, close: 0 }; e[r.c.level] += 1; if (r.c.level === 'CERTAIN') e.close += r.extras.length; perClient.set(r.client, e); });
    console.log(`\nWorst clients (top ${top})`);
    [...perClient.entries()].sort((a, b) => (b[1].CERTAIN * 10 + b[1].LIKELY) - (a[1].CERTAIN * 10 + a[1].LIKELY)).slice(0, top)
      .forEach(([n, e]) => console.log(`  ${n.padEnd(48).slice(0, 48)} certain ${String(e.CERTAIN).padStart(3)}  likely ${String(e.LIKELY).padStart(3)}  maybe ${String(e.POSSIBLE).padStart(3)}  would close ${e.close}`));
    console.log(`\nExamples`);
    ['CERTAIN', 'LIKELY', 'POSSIBLE'].forEach((lv) => {
      console.log(`  -- ${lv}`);
      by(lv).slice(0, 3).forEach((r) => {
        console.log(`  ${r.client} | ${r.c.reasons.join('; ')}`);
        r.jobs.forEach((j) => console.log(`      ${j.id === r.kept.id ? 'KEEP ' : 'merge'} ${j.reqCode || j.id}  ${j.title}  [${j.location || 'no city'}]  ${j.status}  openings ${j.openings}  people ${(st[j.id] || {}).apps || 0}`));
      });
    });
    const certain = by('CERTAIN');
    const apply1 = certain.filter((r) => !r.blockers.length);
    console.log(`\nWhat --apply would do (CERTAIN clusters with no blocker): ${apply1.length} clusters, close ${apply1.reduce((n, r) => n + r.extras.length, 0)} extra jobs, move ${apply1.reduce((n, r) => n + r.move, 0)} candidate links.`);

    if (flag('--csv')) {
      const file = path.resolve(val('--csv', null) || `job-duplicates-${new Date().toISOString().slice(0, 10)}.csv`);
      const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
      const lines = [['level', 'client', 'role', 'code', 'title', 'city', 'specialisation', 'status', 'openings', 'people', 'created', 'evidence', 'blocked'].join(',')];
      rows.forEach((r) => r.jobs.forEach((j) => lines.push([r.c.level, r.client, j.id === r.kept.id ? 'KEEP' : 'MERGE', j.reqCode, j.title, j.location, j.specialisation, j.status, j.openings, (st[j.id] || {}).apps || 0, new Date(j.createdAt).toISOString().slice(0, 10), r.c.reasons.join('; '), r.blockers.join('; ')].map(q).join(','))));
      fs.writeFileSync(file, `﻿${lines.join('\n')}\n`);
      console.log(`CSV written: ${file}`);
    }

    // ---------------------------------------------------------------- apply
    if (apply) {
      if (!(await D.supported())) { console.error('The duplicate-job tables are missing (migration 20261013140000_job_duplicates). Nothing applied.'); process.exitCode = 2; return; }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const bdir = path.join(BACK, 'backups'); fs.mkdirSync(bdir, { recursive: true });
      const backup = path.join(bdir, `before-job-duplicates-${stamp}.db`);
      await prisma.$queryRawUnsafe(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
      console.log(`Backup: ${backup}`);
      const manifest = { at: new Date().toISOString(), db: dbFile, backup, merges: [] };
      const mfile = path.join(bdir, `job-duplicates-${stamp}.manifest.json`);
      let done = 0; const failed = [];
      for (const r of apply1) {
        for (const e of r.extras) {
          try {
            // one merge = one transaction; no bell, no re-post (the extra is taken off the sites by the normal close path)
            // eslint-disable-next-line no-await-in-loop
            const m = await M.mergeJobs({ keptId: r.kept.id, extraId: e.id, user: null, level: 'CERTAIN', door: 'job-duplicates.js', reason: 'Merged by scripts/job-duplicates.js (CERTAIN)', notify: false });
            manifest.merges.push({ logId: m.logId, keptId: m.keptId, extraId: m.extraId, keptCode: m.keptCode, extraCode: m.extraCode, moved: m.moved });
            done += 1;
          } catch (err) { failed.push(`${e.reqCode || e.id}: ${err.message}`); break; }
        }
        fs.writeFileSync(mfile, JSON.stringify(manifest, null, 1));
      }
      console.log(`Applied: ${done} extra jobs merged and closed. Failed clusters: ${failed.length}${failed.length ? `\n  ${failed.slice(0, 20).join('\n  ')}` : ''}`);
      console.log(`Undo manifest: ${mfile}\nUndo: node scripts/job-duplicates.js --undo "${mfile}"${isReal ? ' --really-real   (with TL_ALLOW_REAL_APPLY=1)' : ''}`);
    }
  } finally {
    await prisma.$disconnect();
    if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch { /* temp */ } }
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
