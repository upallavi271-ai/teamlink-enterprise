'use strict';
// apply-delta.js : applies the delta to a TARGET database inside ONE transaction.
// Runs ON THE LIVE SERVER (plain Node, no node:sqlite): uses the backend's own Prisma client.
//
//   node apply-delta.js --delta delta.json                       (look only: classify, change nothing)
//   node apply-delta.js --delta delta.json --apply --undo-out undo.json --result-out result.json
//   node apply-delta.js --revert undo.json                       (put the target back as before the apply)
//   --db <file>   use a plain database file instead of the backend DATABASE_URL (tests)

const fs = require('fs');
const os = require('os');
const path = require('path');

const args = (() => {
  const out = {};
  const av = process.argv.slice(2);
  for (let i = 0; i < av.length; i++) {
    if (av[i].startsWith('--')) {
      const k = av[i].slice(2);
      if (i + 1 < av.length && !av[i + 1].startsWith('--')) out[k] = av[++i]; else out[k] = true;
    }
  }
  return out;
})();

const BACKEND = path.resolve(__dirname, '..', '..');
if (args.db) {
  const abs = path.resolve(args.db);
  const real = path.resolve(BACKEND, 'prisma', 'dev.db');
  if (abs.toLowerCase() === real.toLowerCase() && !args['really-this-database']) {
    console.error('REFUSED: --db points at the real prisma/dev.db of this machine.');
    process.exit(2);
  }
  process.env.DATABASE_URL = 'file:' + abs.replace(/\\/g, '/');
}
// One connection and patient locks: the PRAGMA and the transaction must share one connection,
// and the live app may be writing at the same moment.
if (process.env.DATABASE_URL && !/socket_timeout=/.test(process.env.DATABASE_URL) && process.env.DATABASE_URL.startsWith('file:')) {
  process.env.DATABASE_URL += (process.env.DATABASE_URL.includes('?') ? '&' : '?') + 'connection_limit=1&socket_timeout=60';
}

const L = require('./lib');
const engine = require('./engine');
const report = require('./report');
const prisma = require('../../src/db');

function prismaAdapter(client) {
  return {
    async all(sql) { return client.$queryRawUnsafe(sql); },
    async exec(sql) { return client.$executeRawUnsafe(sql); },
    async transaction(fn) { return prisma.$transaction(async (tx) => fn(prismaAdapter(tx)), { timeout: 600000, maxWait: 120000 }); },
  };
}

function uploadDir() {
  if (process.env.UPLOAD_DIR) return process.env.UPLOAD_DIR;
  try {
    const env = fs.readFileSync(path.join(BACKEND, '.env'), 'utf8');
    const m = env.match(/^UPLOAD_DIR=(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch { /* no .env */ }
  return path.join(os.homedir(), '.teamlink-uploads');
}
function indexFiles(dir) {
  const names = new Set();
  const walk = (d, depth) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) { if (depth < 5) walk(path.join(d, e.name), depth + 1); } else names.add(e.name);
    }
  };
  walk(dir, 0);
  return names;
}

async function main() {
  const ad = prismaAdapter(prisma);
  const dbl = await prisma.$queryRawUnsafe('PRAGMA database_list');
  const dbFile = (dbl[0] && dbl[0].file) || '(unknown)';
  console.log('Target database: ' + dbFile);

  if (args.revert) {
    const undo = L.readJson(args.revert);
    const r = await engine.runUndo(ad, undo);
    console.log('UNDO DONE: ' + r.restored + ' edited row(s) put back, ' + r.removed + ' added row(s) removed.');
    r.skipped.forEach((s) => console.log('  not undone: ' + s));
    return;
  }
  if (!args.delta) throw new Error('Use --delta <delta.json> (or --revert <undo.json>)');
  const delta = L.readJson(args.delta);
  const doApply = !!args.apply;
  const out = await engine.run(ad, delta, { dryRun: !doApply, prefer: !!args.prefer });

  // Files: which pushed document rows point to files that are not on this machine?
  const have = indexFiles(uploadDir());
  const okIds = new Set(out.results.filter((r) => r.status === 'applied' || r.status === 'already').map((r) => r.id));
  let fileRows = 0; const missing = [];
  for (const f of delta.fileReferences || []) {
    const T = delta.tables[f.table]; if (!T) continue;
    for (const op of T.ops) {
      if (!okIds.has(op.id)) continue;
      const vals = f.columns.map((c) => op.row[c]).filter((v) => typeof v === 'string' && v);
      if (!vals.length) continue;
      fileRows++;
      const miss = vals.filter((v) => !have.has(path.basename(v.replace(/\\/g, '/'))));
      if (miss.length) missing.push(f.table + ': ' + (op.label || JSON.stringify(op.pk)) + ' -> ' + path.basename(miss[0].replace(/\\/g, '/')));
    }
  }
  const text = report.format(delta, out, doApply ? 'apply' : 'dry', { fileRows, missingFiles: missing.length, missingList: missing });
  console.log(text);
  const c = report.counts(out);

  if (!doApply) console.log('DRY_SUMMARY added=' + c.added + ' changed=' + c.changed + ' already=' + c.already + ' conflicts=' + c.conflicts + ' blocked=' + c.blocked + ' refused=' + c.refused);
  if (doApply) {
    if (args['undo-out']) L.writeJson(args['undo-out'], Object.assign({ madeAt: new Date().toISOString(), database: dbFile }, out.undo));
    if (args['result-out']) {
      L.writeJson(args['result-out'], {
        format: 1, applied: true, rolledBack: out.rolledBack, counts: c, database: dbFile,
        statuses: out.results.map((r) => ({ id: r.id, table: r.table, k: r.k, status: r.status, reason: r.reason })),
      });
    }
    console.log('APPLY_SUMMARY added=' + c.added + ' changed=' + c.changed + ' already=' + c.already + ' conflicts=' + c.conflicts + ' blocked=' + c.blocked + ' refused=' + c.refused + ' rolledback=' + c.rolledback + ' missingfiles=' + missing.length);
    if (out.rolledBack) process.exitCode = 3;
  }
}

main().then(() => prisma.$disconnect()).catch(async (e) => {
  console.error('ERROR: ' + (e && e.message ? e.message : e));
  try { await prisma.$disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
