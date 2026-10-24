'use strict';
// compare-dbs.js : proves (or honestly disproves) that two databases hold the same data.
// For every table that is allowed to travel it compares: row count + an order-independent hash of the rows
// (only columns both sides have; login counters and time-stamp columns left out, as in the sync itself).
// Everything that is DIFFERENT ON PURPOSE is listed, so "not the same" is always explained.
//
//   node compare-dbs.js --a local.db --b live.db [--dl delta.json --dv delta.json --rl result.json --rv result.json]
//        [--labelA "Localhost" --labelB "Live site"] [--out report.md] [--json out.json]
// Reads both files read-only.

const fs = require('fs');
const crypto = require('crypto');
const L = require('./lib');

function compare(opts) {
  const cfg = opts.config || L.loadConfig(opts.configFile);
  const A = L.openDb(opts.a, true); const B = L.openDb(opts.b, true);
  const soft = new Set(cfg.softColumns || []);
  const exTables = cfg.excludedTables || {};
  const pats = (cfg.excludedNamePatterns || []).map((p) => ({ re: new RegExp(p.pattern), reason: p.reason }));
  const always = cfg.alwaysPushTables || {};
  const appCfg = cfg.appSetting || {};
  const testRe = cfg.testRowPattern ? new RegExp(cfg.testRowPattern, 'i') : null;
  const exReason = (t) => { if (always[t]) return null; if (exTables[t]) return exTables[t]; for (const p of pats) if (p.re.test(t)) return p.reason; return null; };
  const appOk = (k) => (appCfg.allowExact || []).includes(k) || (appCfg.allowPrefixes || []).some((p) => k.startsWith(p));
  const rowOut = (t, o) => {
    if (t === 'AppSetting' && !appOk(String(o.key))) return true;
    const f = cfg.rowFilters && cfg.rowFilters[t];
    if (f && f.excludeWhere && typeof o[f.excludeWhere.column] === 'string' && new RegExp(f.excludeWhere.regex, 'i').test(o[f.excludeWhere.column])) return true;
    if (testRe) for (const k of Object.keys(o)) if (typeof o[k] === 'string' && testRe.test(o[k])) return true;
    return false;
  };

  // keys that are different for a known reason
  const explain = { conflict: new Set(), delete: new Set(), refusedTables: {} };
  const addOps = (deltaFile, resFile) => {
    if (!deltaFile) return;
    const d = L.readJson(deltaFile);
    for (const x of d.dependsKeys || []) explain.delete.add(x.table + '' + L.pkKey(x.pk));
    for (const x of d.deletes || []) explain.delete.add(x.table + '\u0001' + L.pkKey(x.pk));
    if (!resFile) return;
    const r = L.readJson(resFile);
    const byId = new Map();
    for (const t of Object.keys(d.tables)) for (const op of d.tables[t].ops) byId.set(op.id, { t, op });
    for (const s of r.statuses || []) {
      if (s.status === 'conflict' || s.status === 'blocked' || s.status === 'refused' || s.status === 'rolledback') {
        const m = byId.get(s.id); if (m) explain.conflict.add(m.t + '\u0001' + L.pkKey(m.op.pk));
        if (s.status === 'refused') explain.refusedTables[s.table] = s.reason;
      }
    }
  };
  addOps(opts.dl, opts.rl); addOps(opts.dv, opts.rv);

  const ta = new Set(L.listTables(A)); const tb = new Set(L.listTables(B));
  const rows = []; const skippedNoPk = []; const oneSided = [];
  const excludedInfo = [];
  for (const t of [...new Set([...ta, ...tb])].sort()) {
    if (t === '_prisma_migrations') continue;
    const why = exReason(t);
    if (why) {
      const na = ta.has(t) ? A.prepare('SELECT count(*) c FROM ' + L.qid(t)).get().c : null;
      const nb = tb.has(t) ? B.prepare('SELECT count(*) c FROM ' + L.qid(t)).get().c : null;
      excludedInfo.push({ table: t, reason: why, a: na === null ? null : Number(na), b: nb === null ? null : Number(nb) });
      continue;
    }
    if (!ta.has(t) || !tb.has(t)) { oneSided.push({ table: t, only: ta.has(t) ? 'a' : 'b', count: Number((ta.has(t) ? A : B).prepare('SELECT count(*) c FROM ' + L.qid(t)).get().c) }); continue; }
    const ia = L.tableInfo(A, t); const ib = L.tableInfo(B, t);
    if (!ia.pkCols.length || ia.pkCols.join() !== ib.pkCols.join()) { skippedNoPk.push(t); continue; }
    const nb = new Set(ib.cols.map((c) => c.name));
    const ignore = new Set((cfg.ignoreColumns && cfg.ignoreColumns[t]) || []);
    const common = ia.cols.map((c) => c.name).filter((n) => nb.has(n) && !ignore.has(n) && !soft.has(n));
    const onlyA = ia.cols.map((c) => c.name).filter((n) => !nb.has(n));
    const onlyB = ib.cols.map((c) => c.name).filter((n) => !ia.cols.some((x) => x.name === n));
    const load = (db, info) => {
      const m = new Map(); const x = Buffer.alloc(16);
      const st = db.prepare('SELECT * FROM ' + L.qid(t)); st.setReadBigInts(true);
      for (const r of st.iterate()) {
        const o = {}; for (const k of Object.keys(r)) o[k] = typeof r[k] === 'bigint' ? Number(r[k]) : r[k];
        if (rowOut(t, o)) continue;
        const key = L.pkKey(info.pkCols.map((c) => L.enc(r[c])));
        const h = L.rowHash(common.map((c) => r[c]));
        m.set(key, h);
        const dg = crypto.createHash('md5').update(key + h).digest();
        for (let i = 0; i < 16; i++) x[i] ^= dg[i];
      }
      return { m, hash: x.toString('hex') };
    };
    const la = load(A, ia); const lb = load(B, ib);
    const same = la.m.size === lb.m.size && la.hash === lb.hash;
    const rec = { table: t, a: la.m.size, b: lb.m.size, same, onlyA: [], onlyB: [], differ: [], colsOnlyA: onlyA, colsOnlyB: onlyB, explained: 0, unexplained: 0 };
    if (!same) {
      const ex = (key) => explain.conflict.has(t + '\u0001' + key) || explain.delete.has(t + '\u0001' + key);
      for (const [k, h] of la.m) { if (!lb.m.has(k)) rec.onlyA.push(k); else if (lb.m.get(k) !== h) rec.differ.push(k); }
      for (const k of lb.m.keys()) if (!la.m.has(k)) rec.onlyB.push(k);
      for (const k of [...rec.onlyA, ...rec.onlyB, ...rec.differ]) { if (ex(k)) rec.explained++; else rec.unexplained++; }
      if (explain.refusedTables[t]) { rec.explained += rec.unexplained; rec.unexplained = 0; rec.note = 'table refused: ' + explain.refusedTables[t]; }
    }
    rows.push(rec);
  }
  A.close(); B.close();
  const sum = {
    tablesCompared: rows.length, tablesSame: rows.filter((r) => r.same).length,
    tablesDifferExplained: rows.filter((r) => !r.same && r.unexplained === 0).length,
    tablesDifferUnexplained: rows.filter((r) => !r.same && r.unexplained > 0).length,
  };
  sum.allSameOrExplained = sum.tablesDifferUnexplained === 0;
  sum.fullyIdentical = sum.tablesSame === rows.length && !oneSided.length;
  return { rows, oneSided, skippedNoPk, excludedInfo, sum, explainCounts: { conflicts: explain.conflict.size, deletes: explain.delete.size } };
}

function toMarkdown(c, o) {
  const la = o.labelA || 'Localhost'; const lb = o.labelB || 'Live site';
  const M = [];
  M.push('# TeamLink sync comparison');
  M.push('');
  M.push('Made ' + new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC. ' + (o.title || ''));
  M.push('');
  M.push('**Result:** ' + (c.sum.fullyIdentical ? 'IDENTICAL. Every table that is allowed to travel has the same rows on both sides.'
    : c.sum.allSameOrExplained ? 'SAME EXCEPT FOR THINGS EXPLAINED BELOW. Nothing unexplained differs.'
      : 'NOT THE SAME: ' + c.sum.tablesDifferUnexplained + ' table(s) differ for a reason I cannot explain. See the rows marked UNEXPLAINED.'));
  M.push('');
  M.push('Tables compared: ' + c.sum.tablesCompared + ' | same: ' + c.sum.tablesSame + ' | different but explained: ' + c.sum.tablesDifferExplained + ' | UNEXPLAINED: ' + c.sum.tablesDifferUnexplained);
  M.push('');
  M.push('| Table | ' + la + ' rows | ' + lb + ' rows | Same? |');
  M.push('|---|---:|---:|---|');
  for (const r of c.rows) {
    const verdict = r.same ? 'yes' : (r.unexplained === 0 ? 'no - explained (' + r.explained + ' row(s): conflict or delete)' : 'NO - UNEXPLAINED (' + r.unexplained + ' row(s))');
    M.push('| ' + r.table + ' | ' + r.a + ' | ' + r.b + ' | ' + verdict + ' |');
  }
  M.push('');
  M.push('## Different on purpose or for a known reason');
  M.push('');
  M.push('- Conflicts, rows waiting on a conflict, and rows refused for table differences: ' + c.explainCounts.conflicts + ' row(s). They are untouched on both sides and come back in the next report.');
  M.push('- Rows deleted on one side (deletes are never copied): ' + c.explainCounts.deletes + ' row(s).');
  if (c.oneSided.length) {
    M.push('- Tables that exist on one side only (a database update is pending there; run deploy-local-to-vps.ps1 / the same update locally):');
    c.oneSided.forEach((x) => M.push('  - ' + x.table + ': only on ' + (x.only === 'a' ? la : lb) + ', ' + x.count + ' row(s)'));
  }
  const cols = c.rows.filter((r) => r.colsOnlyA.length || r.colsOnlyB.length);
  if (cols.length) {
    M.push('- Columns that exist on one side only (not compared):');
    cols.forEach((r) => M.push('  - ' + r.table + ': only on ' + la + ' [' + r.colsOnlyA.join(', ') + '], only on ' + lb + ' [' + r.colsOnlyB.join(', ') + ']'));
  }
  if (c.skippedNoPk.length) M.push('- Tables without a usable primary key are not compared: ' + c.skippedNoPk.join(', '));
  M.push('- Never copied by design (secrets, logins, queues, logs, notifications, test data, AppSetting keys that are not on the allow list, login counters, time-stamps):');
  c.excludedInfo.forEach((x) => M.push('  - ' + x.table + ' (' + la + ' ' + (x.a === null ? '-' : x.a) + ' rows, ' + lb + ' ' + (x.b === null ? '-' : x.b) + ' rows): ' + x.reason));
  const bad = c.rows.filter((r) => !r.same && r.unexplained > 0);
  if (bad.length) {
    M.push('');
    M.push('## UNEXPLAINED differences');
    bad.forEach((r) => M.push('- ' + r.table + ': ' + r.onlyA.length + ' only on ' + la + ', ' + r.onlyB.length + ' only on ' + lb + ', ' + r.differ.length + ' different'));
  }
  return M.join('\n');
}

module.exports = { compare, toMarkdown };

if (require.main === module) {
  const a = L.parseArgs(process.argv.slice(2));
  if (!a.a || !a.b) { console.error('Use: node compare-dbs.js --a <db> --b <db> [--dl --dv --rl --rv] [--out report.md]'); process.exit(2); }
  const c = compare({ a: a.a, b: a.b, dl: a.dl, dv: a.dv, rl: a.rl, rv: a.rv, configFile: a.config });
  const md = toMarkdown(c, { labelA: a.labelA, labelB: a.labelB, title: a.title });
  if (a.out) { fs.mkdirSync(require('path').dirname(a.out), { recursive: true }); fs.writeFileSync(a.out, md); }
  if (a.json) L.writeJson(a.json, c.sum);
  console.log(md.split('\n').filter((l) => !l.startsWith('|') || /UNEXPLAINED|no - explained/.test(l)).join('\n'));
  console.log('COMPARE_SUMMARY ' + JSON.stringify(c.sum));
  process.exitCode = c.sum.allSameOrExplained ? 0 : 4;
}
