'use strict';
// classify-delta.js : DRY RUN. Opens a copy of the live database READ-ONLY, decides what would
// happen to every change in the delta, and prints the plain report. Writes nothing to any database.
//
//   node classify-delta.js --delta delta.json --target vps-copy.db [--report report.txt] [--json result.json]

const fs = require('fs');
const L = require('./lib');
const engine = require('./engine');
const report = require('./report');

async function classify(delta, targetFile, opts) {
  const db = L.openDb(targetFile, true);
  try {
    return await engine.run(L.nodeAdapter(db), delta, { dryRun: true, prefer: !!(opts && opts.prefer), checkParents: true });
  } finally { db.close(); }
}

module.exports = { classify };

if (require.main === module) {
  (async () => {
    const a = L.parseArgs(process.argv.slice(2));
    if (!a.delta || !a.target) { console.error('Use: node classify-delta.js --delta <delta.json> --target <copy of live db> [--report file] [--json file]'); process.exit(2); }
    const delta = L.readJson(a.delta);
    const out = await classify(delta, a.target, { prefer: !!a.prefer });
    const text = report.format(delta, out, 'dry');
    console.log(text);
    if (a.report) fs.writeFileSync(a.report, text);
    if (a.json) L.writeJson(a.json, { counts: report.counts(out), results: out.results, statuses: out.results.map((r) => ({ id: r.id, table: r.table, k: r.k, status: r.status, reason: r.reason })), perTable: out.perTable, refused: out.refused });
  })().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
}
