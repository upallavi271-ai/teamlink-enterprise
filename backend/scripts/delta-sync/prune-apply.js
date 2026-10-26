'use strict';
// prune-apply.js : runs ON THE LIVE SERVER (plain Node + the backend's own Prisma client).
// Deletes from the live database the rows listed in a plan made by make-prune.js, in small batches.
//
//   node prune-apply.js --prune prune.json                          (look only: check every row, delete nothing)
//   node prune-apply.js --prune prune.json --apply --undo-out undo.json --result-out result.json
//   node prune-apply.js --restore undo.json                         (put the deleted rows back)
//   --db <file>   use a plain database file instead of the backend DATABASE_URL (tests)

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
// One connection (the PRAGMA and the transactions must share it) and patient locks (the live app writes too).
if (process.env.DATABASE_URL && !/socket_timeout=/.test(process.env.DATABASE_URL) && process.env.DATABASE_URL.startsWith('file:')) {
  process.env.DATABASE_URL += (process.env.DATABASE_URL.includes('?') ? '&' : '?') + 'connection_limit=1&socket_timeout=60';
}

const L = require('./lib');
const pe = require('./prune-engine');
const prisma = require('../../src/db');

function prismaAdapter(client) {
  return {
    async all(sql) { return client.$queryRawUnsafe(sql); },
    async exec(sql) { return client.$executeRawUnsafe(sql); },
    async transaction(fn) { return prisma.$transaction(async (tx) => fn(prismaAdapter(tx)), { timeout: 120000, maxWait: 120000 }); },
  };
}

async function main() {
  const ad = prismaAdapter(prisma);
  const dbl = await prisma.$queryRawUnsafe('PRAGMA database_list');
  console.log('Target database: ' + ((dbl[0] && dbl[0].file) || '(unknown)'));

  if (args.restore) {
    const undo = L.readJson(args.restore);
    const r = await pe.restorePrune(ad, undo, { pauseMs: 30 });
    console.log('RESTORE DONE: ' + r.restored + ' row(s) put back, ' + r.existed + ' already there.');
    return;
  }
  if (!args.prune) throw new Error('Use --prune <prune.json> (or --restore <undo.json>)');
  const prune = L.readJson(args.prune);
  const apply = !!args.apply;
  const res = await pe.applyPrune(ad, prune, { apply, batch: 200, pauseMs: 40, log: (s) => console.log('  ' + s) });
  let del = 0; let gone = 0; let changed = 0; let used = 0; let err = 0;
  for (const s of Object.values(res.tables)) { del += s.deleted; gone += s.gone; changed += s.changed; used += s.used; err += s.error; }
  if (apply) {
    if (args['undo-out']) L.writeJson(args['undo-out'], Object.assign({ madeAt: new Date().toISOString() }, res.undo));
    if (args['result-out']) L.writeJson(args['result-out'], { format: 1, applied: true, aborted: res.aborted, removed: res.removed, tables: res.tables, errors: res.errors });
  }
  res.errors.slice(0, 5).forEach((e) => console.log('  ERROR ' + e));
  console.log((apply ? 'PRUNE_SUMMARY' : 'PRUNE_CHECK') + ' deleted=' + del + ' gone=' + gone + ' changed=' + changed + ' used=' + used + ' errors=' + err + ' aborted=' + (res.aborted ? 1 : 0));
  if (res.aborted || err) process.exitCode = 3;
}

main().then(() => prisma.$disconnect()).catch(async (e) => {
  console.error('ERROR: ' + (e && e.message ? e.message : e));
  try { await prisma.$disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
