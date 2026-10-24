'use strict';
// make-delta.js : DELTA = local database minus baseline, table by table, keyed by primary key.
// Reads both databases READ-ONLY. Writes one JSON file (the delta). Never touches the live site.
//
//   node make-delta.js --baseline baseline.db --local local-copy.db --out delta.json [--config exclusions.json]

const path = require('path');
const L = require('./lib');

const NAME_COLS = ['name', 'fullName', 'candidateName', 'title', 'companyName', 'legalName', 'employeeName', 'docName', 'email', 'employeeCode', 'reqCode', 'clientCode', 'code', 'key', 'fileName', 'label', 'action'];

function makeDelta(opts) {
  const cfg = opts.config || L.loadConfig(opts.configFile);
  const bdb = L.openDb(opts.baseline, true);
  const ldb = L.openDb(opts.local, true);
  const testRe = cfg.testRowPattern ? new RegExp(cfg.testRowPattern, 'i') : null;
  const soft = new Set(cfg.softColumns || []);
  const patterns = (cfg.excludedNamePatterns || []).map((p) => ({ re: new RegExp(p.pattern), reason: p.reason }));
  const always = cfg.alwaysPushTables || {};
  const exTables = cfg.excludedTables || {};
  const appCfg = cfg.appSetting || {};

  const delta = {
    format: 1,
    createdAt: new Date().toISOString(),
    baselineFile: path.basename(opts.baseline),
    localFile: path.basename(opts.local),
    softColumns: [...soft],
    order: [],
    tables: {},
    deletes: [],
    noPrimaryKey: [],
    schemaNotes: [],
    newTablesLocal: [],
    excluded: { tables: {}, rows: {}, appSettings: [], dependsOnExcluded: 0 },
    fileReferences: cfg.fileReferences || [],
    configSummary: {
      excludedTables: exTables, excludedNamePatterns: cfg.excludedNamePatterns || [], alwaysPushTables: always,
      ignoreColumns: cfg.ignoreColumns || {}, softColumns: cfg.softColumns || [], testRowPattern: cfg.testRowPattern,
      appSettingAllowPrefixes: appCfg.allowPrefixes || [], appSettingAllowExact: appCfg.allowExact || [],
      appSettingReasons: appCfg.reasons || {}, configFile: cfg._file,
    },
    counts: { local: {}, baseline: {} },
  };

  const bTables = new Set(L.listTables(bdb));
  const lTables = L.listTables(ldb);
  const infoL = {}; const infoB = {};
  const excludedKeys = {}; // table -> Set(pkKey) of NEW rows that will not travel
  const nameLookupCache = new Map();
  let nextId = 1;

  const tableExcludedReason = (t) => {
    if (always[t]) return null;
    if (exTables[t]) return exTables[t];
    for (const p of patterns) if (p.re.test(t)) return p.reason;
    return null;
  };

  function appSettingAllowed(key) {
    if ((appCfg.allowExact || []).includes(key)) return true;
    return (appCfg.allowPrefixes || []).some((p) => key.startsWith(p));
  }

  function rowExcludedReason(t, rowObj) {
    if (t === 'AppSetting') {
      if (!appSettingAllowed(String(rowObj.key))) return { reason: 'AppSetting key not on the allow list', code: 'appsetting' };
    }
    const f = cfg.rowFilters && cfg.rowFilters[t];
    if (f && f.excludeWhere) {
      const v = rowObj[f.excludeWhere.column];
      if (typeof v === 'string' && new RegExp(f.excludeWhere.regex, 'i').test(v)) return { reason: f.excludeWhere.reason, code: 'filter' };
    }
    if (testRe) {
      for (const k of Object.keys(rowObj)) {
        const v = rowObj[k];
        if (typeof v === 'string' && testRe.test(v)) return { reason: 'test data', code: 'test' };
      }
    }
    return null;
  }

  function labelFor(t, rowObj, fks) {
    for (const c of NAME_COLS) {
      const v = rowObj[c];
      if (typeof v === 'string' && v.trim() && c !== 'action') return v.trim().slice(0, 80);
    }
    // name of a related row (e.g. Attendance -> the employee), found in the LOCAL database
    for (const fk of fks) {
      if (fk.from.length !== 1) continue;
      const val = rowObj[fk.from[0]];
      if (val === null || val === undefined) continue;
      const ck = fk.table + '\u0001' + String(val);
      let nm = nameLookupCache.get(ck);
      if (nm === undefined) {
        nm = null;
        try {
          const pi = infoL[fk.table] || (infoL[fk.table] = L.tableInfo(ldb, fk.table));
          const nc = NAME_COLS.find((c) => pi.cols.some((x) => x.name === c) && c !== 'action');
          if (nc && pi.pkCols.length === 1) {
            const st = ldb.prepare('SELECT ' + L.qid(nc) + ' AS n FROM ' + L.qid(fk.table) + ' WHERE ' + L.qid(pi.pkCols[0]) + ' = ?');
            const r = st.get(val);
            if (r && r.n) nm = String(r.n).slice(0, 60);
          }
        } catch { nm = null; }
        nameLookupCache.set(ck, nm);
      }
      if (nm) {
        const when = ['date', 'month', 'period', 'status', 'type'].map((c) => rowObj[c]).find((v) => typeof v === 'string' && v);
        return nm + (when ? ' / ' + when : '');
      }
    }
    if (t === 'AuditLog' && typeof rowObj.action === 'string') return rowObj.action.slice(0, 80);
    for (const c of ['date', 'createdAt', 'id']) {
      const v = rowObj[c];
      if (v !== null && v !== undefined && typeof v !== 'object') return c + '=' + String(v).slice(0, 40);
    }
    return '';
  }

  const bMigs = new Set(L.migrationNames(bdb));
  const lMigs = L.migrationNames(ldb);
  delta.migrations = { baselineCount: bMigs.size, localCount: lMigs.length, localNotInBaseline: lMigs.filter((m) => !bMigs.has(m)) };

  for (const t of lTables) {
    if (t === '_prisma_migrations') { delta.excluded.tables[t] = { reason: exTables[t], new: 0, changed: 0, deleted: 0 }; continue; }
    const li = L.tableInfo(ldb, t); infoL[t] = li;
    const exReason = tableExcludedReason(t);
    if (!li.pkCols.length) { delta.noPrimaryKey.push(t); continue; }
    const inBase = bTables.has(t);
    const bi = inBase ? L.tableInfo(bdb, t) : { cols: [], pkCols: [] };
    infoB[t] = bi;
    if (inBase && bi.pkCols.join() !== li.pkCols.join()) {
      delta.schemaNotes.push(t + ': primary key differs between baseline and local (' + bi.pkCols.join(',') + ' vs ' + li.pkCols.join(',') + '); table skipped');
      continue;
    }
    if (!inBase) delta.newTablesLocal.push(t);
    const bNames = new Set(bi.cols.map((c) => c.name));
    const lNames = li.cols.map((c) => c.name);
    const ignore = new Set((cfg.ignoreColumns && cfg.ignoreColumns[t]) || []);
    const common = lNames.filter((n) => bNames.has(n));
    if (inBase && (common.length !== lNames.length || common.length !== bNames.size)) {
      delta.schemaNotes.push(t + ': columns differ between baseline and local; only columns in both are compared (new columns of existing rows are not compared)');
    }
    const diffCols = common.filter((n) => !ignore.has(n) && !soft.has(n));
    const softCols = common.filter((n) => soft.has(n) && !ignore.has(n));
    const rowCols = lNames.filter((n) => !ignore.has(n));
    const fks = L.fkList(ldb, t);

    // baseline hash map
    const hashes = new Map();
    if (inBase) {
      const sel = li.pkCols.concat(diffCols).map(L.qid).join(',');
      const st = bdb.prepare('SELECT ' + sel + ' FROM ' + L.qid(t)); st.setReadBigInts(true);
      for (const r of st.iterate()) {
        const pk = li.pkCols.map((c) => L.enc(r[c]));
        hashes.set(L.pkKey(pk), L.rowHash(diffCols.map((c) => r[c])));
      }
    }
    delta.counts.baseline[t] = hashes.size;
    const seen = new Set();
    const ops = []; let nLocal = 0;
    const exCount = { new: 0, changed: 0, deleted: 0 };
    const getBase = inBase ? bdb.prepare('SELECT ' + common.map(L.qid).join(',') + ' FROM ' + L.qid(t) + ' WHERE ' + li.pkCols.map((c) => L.qid(c) + ' = ?').join(' AND ')) : null;
    if (getBase) getBase.setReadBigInts(true);
    const st2 = ldb.prepare('SELECT * FROM ' + L.qid(t)); st2.setReadBigInts(true);
    for (const r of st2.iterate()) {
      nLocal++;
      const pk = li.pkCols.map((c) => L.enc(r[c]));
      const key = L.pkKey(pk);
      seen.add(key);
      const bh = hashes.get(key);
      const isNew = bh === undefined;
      let changed = null;
      if (!isNew) {
        const lh = L.rowHash(diffCols.map((c) => r[c]));
        if (lh === bh) continue;
        const br = getBase.get(...li.pkCols.map((c) => r[c]));
        changed = diffCols.filter((c) => L.canon(r[c]) !== L.canon(br[c]));
        if (!changed.length) continue;
        // soft columns that moved along with a real change
        for (const c of softCols) if (L.canon(r[c]) !== L.canon(br[c])) changed.push(c);
        r.__base = br;
      }
      // exclusion
      const rowObj = {}; for (const c of lNames) rowObj[c] = (typeof r[c] === 'bigint') ? Number(r[c]) : r[c];
      let ex = exReason ? { reason: exReason, code: 'table' } : rowExcludedReason(t, rowObj);
      if (ex) {
        if (isNew) { (excludedKeys[t] || (excludedKeys[t] = new Set())).add(key); exCount.new++; } else exCount.changed++;
        if (ex.code === 'appsetting') delta.excluded.appSettings.push({ key: rowObj.key, state: isNew ? 'new' : 'changed' });
        else if (ex.code !== 'table') { const k = ex.reason + ' (' + t + ')'; delta.excluded.rows[k] = (delta.excluded.rows[k] || 0) + 1; }
        continue;
      }
      const row = {}; for (const c of rowCols) row[c] = L.enc(r[c]);
      const op = { id: nextId++, k: isNew ? 'I' : 'U', pk, row, label: labelFor(t, rowObj, fks) };
      if (!isNew) {
        op.changed = changed;
        op.old = {}; for (const c of changed) op.old[c] = L.enc(r.__base[c]);
      }
      ops.push(op);
    }
    delta.counts.local[t] = nLocal;
    // deletions (REPORT ONLY)
    if (inBase) {
      let nDel = 0;
      const sel = li.pkCols.map(L.qid).join(',');
      const nm = NAME_COLS.find((c) => bi.cols.some((x) => x.name === c) && c !== 'action');
      const st3 = bdb.prepare('SELECT ' + sel + (nm ? ',' + L.qid(nm) + ' AS __n' : '') + ' FROM ' + L.qid(t)); st3.setReadBigInts(true);
      for (const r of st3.iterate()) {
        const pk = li.pkCols.map((c) => L.enc(r[c]));
        if (!seen.has(L.pkKey(pk))) {
          nDel++;
          if (!exReason && !(t === 'AppSetting' && !appSettingAllowed(String(r[li.pkCols[0]])))) {
            delta.deletes.push({ table: t, pk, label: r.__n ? String(r.__n).slice(0, 80) : '' });
          } else if (t === 'AppSetting' && !exReason) {
            delta.excluded.appSettings.push({ key: String(r[li.pkCols[0]]), state: 'deleted-locally' });
          }
        }
      }
      if (exReason) exCount.deleted = nDel;
    }
    if (exReason) {
      if (exCount.new || exCount.changed || exCount.deleted) delta.excluded.tables[t] = { reason: exReason, ...exCount };
      continue;
    }
    if (ops.length) {
      delta.tables[t] = {
        cols: li.cols, pkCols: li.pkCols, fks, ops,
      };
    }
  }

  // ---- drop rows that point to a row that will not travel (cascade) ----
  let again = true;
  while (again) {
    again = false;
    for (const t of Object.keys(delta.tables)) {
      const T = delta.tables[t];
      const keep = [];
      for (const op of T.ops) {
        let dep = false;
        for (const fk of T.fks) {
          const ex = excludedKeys[fk.table];
          if (!ex || !ex.size) continue;
          if (op.k === 'U' && !fk.from.some((c) => op.changed.includes(c))) continue;
          const pinfo = infoL[fk.table];
          if (!pinfo) continue;
          const to = fk.to.map((x) => x || null);
          const target = to.every((x) => x === null) ? pinfo.pkCols : to;
          if (target.join() !== pinfo.pkCols.join()) continue;
          const vals = fk.from.map((c) => op.row[c]);
          if (vals.some((v) => v === null || v === undefined)) continue;
          if (ex.has(L.pkKey(vals))) { dep = true; break; }
        }
        if (dep) {
          delta.excluded.dependsOnExcluded++;
          (delta.dependsKeys || (delta.dependsKeys = [])).push({ table: t, pk: op.pk });
          if (op.k === 'I') (excludedKeys[t] || (excludedKeys[t] = new Set())).add(L.pkKey(op.pk));
          again = true;
        } else keep.push(op);
      }
      T.ops = keep;
      if (!keep.length) delete delta.tables[t];
    }
  }

  // ---- order: parents before children ----
  const names = Object.keys(delta.tables).sort();
  const deps = {};
  for (const t of names) deps[t] = new Set(delta.tables[t].fks.map((f) => f.table).filter((x) => x !== t && delta.tables[x]));
  const done = new Set(); const order = [];
  let guard = names.length + 5;
  while (order.length < names.length && guard-- > 0) {
    for (const t of names) {
      if (done.has(t)) continue;
      if ([...deps[t]].every((d) => done.has(d))) { done.add(t); order.push(t); }
    }
  }
  for (const t of names) if (!done.has(t)) order.push(t);
  delta.order = order;

  // numbers
  delta.summary = { inserts: 0, updates: 0, deletesNotApplied: delta.deletes.length };
  for (const t of order) for (const op of delta.tables[t].ops) { if (op.k === 'I') delta.summary.inserts++; else delta.summary.updates++; }
  bdb.close(); ldb.close();
  if (opts.out) L.writeJson(opts.out, delta);
  return delta;
}

module.exports = { makeDelta };

if (require.main === module) {
  const a = L.parseArgs(process.argv.slice(2));
  if (!a.baseline || !a.local || !a.out) { console.error('Use: node make-delta.js --baseline <file> --local <file> --out <delta.json> [--config <json>]'); process.exit(2); }
  const d = makeDelta({ baseline: a.baseline, local: a.local, out: a.out, configFile: a.config });
  console.log('Delta written: ' + d.summary.inserts + ' new rows, ' + d.summary.updates + ' changed rows, ' + d.summary.deletesNotApplied + ' deleted rows (report only) in ' + d.order.length + ' tables -> ' + a.out);
}
