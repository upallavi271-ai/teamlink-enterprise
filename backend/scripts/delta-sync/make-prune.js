'use strict';
// make-prune.js : PLAN for "the live site should lose what was deleted on localhost".
// Reads three things READ-ONLY: the delta (its list of rows deleted locally), the baseline, a copy of the live database.
// Writes prune.json (the plan) and a plain-English report. Never touches any real database.
//
//   node make-prune.js --delta delta-local.json --baseline baseline.db --live live-copy.db --out prune.json
//        [--report report.txt] [--tables A,B,C] [--include-money] [--max-total 40000] [--config exclusions.json]
//
// A row is planned for deletion ONLY if all of these are true:
//   1. it was deleted on localhost (it is in the baseline, and not in localhost any more);
//   2. its table is on the prune list (the ATS tables below; invoices and payments only with --include-money);
//   3. the table is not excluded in exclusions.json (leave, attendance, biometric, WhatsApp, e-mail, SMS, timesheets...);
//   4. on the live site it still looks exactly like in the baseline (nobody has worked on it since);
//   5. no row that stays on the live site still points to it (such a row is kept, with the reason in the report).

const crypto = require('crypto');
const fs = require('fs');
const L = require('./lib');
const { fingerprint, selectQuoted, pkWhere } = require('./prune-engine');

const DEFAULT_TABLES = ['Application', 'ApplicationFollowUp', 'ApplicationStageEvent', 'InterviewEvent', 'Requirement', 'RequirementPosting', 'Client', 'ClientAlias', 'PortalRequest'];
const MONEY_TABLES = ['Invoice', 'InvoicePayment'];

function makePrune(opts) {
  const cfg = L.loadConfig(opts.configFile);
  const delta = L.readJson(opts.delta);
  const bdb = L.openDb(opts.baseline, true);
  const vdb = L.openDb(opts.live, true);
  const wanted = (opts.tables && opts.tables.length) ? opts.tables : DEFAULT_TABLES.slice();
  if (opts.includeMoney) MONEY_TABLES.forEach((t) => { if (!wanted.includes(t)) wanted.push(t); });
  const maxTotal = opts.maxTotal || 40000;
  const soft = new Set(cfg.softColumns || []);
  const exTables = cfg.excludedTables || {};
  const patterns = (cfg.excludedNamePatterns || []).map((p) => new RegExp(p.pattern));
  const always = cfg.alwaysPushTables || {};
  const isExcluded = (t) => !always[t] && (!!exTables[t] || patterns.some((re) => re.test(t)));

  const vTables = L.listTables(vdb);
  const vSet = new Set(vTables);
  const bSet = new Set(L.listTables(bdb));
  const info = {};
  const ti = (db, t, key) => { const k = key + ':' + t; return info[k] || (info[k] = L.tableInfo(db, t)); };
  const rep = {
    skippedTables: {}, perTable: {}, notes: [], used: {}, samples: {}, changedSamples: {},
  };

  // ---- 1. the candidates: rows deleted on localhost ----
  const byTable = {};
  for (const d of delta.deletes || []) (byTable[d.table] || (byTable[d.table] = [])).push(d);
  const cand = {}; // table -> Map(pkKey -> { pk, fp, label })
  for (const t of Object.keys(byTable).sort()) {
    const rows = byTable[t];
    const per = rep.perTable[t] = { deletedLocally: rows.length, gone: 0, changed: 0, usedByOthers: 0, planned: 0 };
    if (isExcluded(t)) { rep.skippedTables[t] = 'protected table (exclusions.json)'; continue; }
    if (!wanted.includes(t)) {
      rep.skippedTables[t] = MONEY_TABLES.includes(t) ? 'money records: kept (use -IncludeMoney to include them)' : 'not on the prune list';
      continue;
    }
    if (!vSet.has(t) || !bSet.has(t)) { rep.skippedTables[t] = 'table missing on one side'; continue; }
    const vi = ti(vdb, t, 'v'); const bi = ti(bdb, t, 'b');
    if (!vi.pkCols.length || vi.pkCols.join() !== bi.pkCols.join()) { rep.skippedTables[t] = 'primary key differs or missing'; continue; }
    const vcols = vi.cols.map((c) => c.name);
    const ignore = new Set((cfg.ignoreColumns && cfg.ignoreColumns[t]) || []);
    const bnames = new Set(bi.cols.map((c) => c.name));
    const cmp = vcols.filter((c) => bnames.has(c) && !ignore.has(c) && !soft.has(c));
    const map = cand[t] = new Map();
    for (const d of rows) {
      const where = ' WHERE ' + pkWhere(vi.pkCols, d.pk);
      const lv = vdb.prepare('SELECT ' + selectQuoted(vcols) + ' FROM ' + L.qid(t) + where).all();
      if (!lv.length) { per.gone++; continue; }
      const q = vcols.map((c, i) => String(lv[0]['q' + i]));
      const bv = bdb.prepare('SELECT ' + selectQuoted(cmp) + ' FROM ' + L.qid(t) + where).all();
      const fpLive = fingerprint(cmp.map((c) => String(lv[0]['q' + vcols.indexOf(c)])));
      const fpBase = bv.length ? fingerprint(cmp.map((c, i) => String(bv[0]['q' + i]))) : null;
      if (fpBase === null || fpLive !== fpBase) {
        per.changed++;
        (rep.changedSamples[t] || (rep.changedSamples[t] = [])).length < 5 && rep.changedSamples[t].push(d.label || JSON.stringify(d.pk));
        continue;
      }
      map.set(L.pkKey(d.pk), { pk: d.pk, fp: fingerprint(q), label: d.label || '' });
    }
  }

  // ---- 2. references: who points at the candidate tables (on the live copy) ----
  const refs = {}; // parent table -> [{ table, from[], to[] }]
  for (const T of vTables) {
    for (const fk of L.fkList(vdb, T)) {
      const P = fk.table;
      if (!cand[P]) continue;
      const pcols = ti(vdb, P, 'v').pkCols;
      const to = fk.to.every((x) => !x) ? pcols : fk.to;
      (refs[P] || (refs[P] = [])).push({ table: T, from: fk.from, to });
    }
  }

  // ---- 3. keep every parent that a surviving row still needs (repeat until nothing changes) ----
  const lookupCache = {};
  const parentLookup = (P, to) => {
    const k = P + '|' + to.join();
    if (lookupCache[k]) return lookupCache[k];
    const pcols = ti(vdb, P, 'v').pkCols;
    const st = vdb.prepare('SELECT ' + pcols.concat(to).map(L.qid).join(',') + ' FROM ' + L.qid(P)); st.setReadBigInts(true);
    const m = new Map();
    for (const r of st.iterate()) m.set(L.pkKey(to.map((c) => L.enc(r[c]))), L.pkKey(pcols.map((c) => L.enc(r[c]))));
    lookupCache[k] = m;
    return m;
  };
  let changedSomething = true; let guard = 0;
  while (changedSomething && guard++ < 60) {
    changedSomething = false;
    for (const P of Object.keys(refs)) {
      if (!cand[P].size) continue;
      const ppk = ti(vdb, P, 'v').pkCols;
      for (const ref of refs[P]) {
        const T = ref.table;
        const tpk = ti(vdb, T, 'v').pkCols;
        const direct = ref.to.join() === ppk.join();
        const lookup = direct ? null : parentLookup(P, ref.to);
        const cT = cand[T];
        const sel = tpk.concat(ref.from).map(L.qid).join(',');
        const st = vdb.prepare('SELECT ' + sel + ' FROM ' + L.qid(T)); st.setReadBigInts(true);
        for (const r of st.iterate()) {
          const fv = ref.from.map((c) => L.enc(r[c]));
          if (fv.some((v) => v === null || v === undefined)) continue;
          const key = L.pkKey(fv);
          const parent = direct ? key : lookup.get(key);
          if (!parent || !cand[P].has(parent)) continue;
          const childKey = tpk.length ? L.pkKey(tpk.map((c) => L.enc(r[c]))) : null;
          if (cT && childKey && cT.has(childKey)) continue; // the child goes away too
          cand[P].delete(parent);
          rep.perTable[P].usedByOthers++;
          const u = rep.used[P] || (rep.used[P] = {});
          u[T] = (u[T] || 0) + 1;
          changedSomething = true;
        }
      }
    }
  }

  // ---- 4. the plan ----
  const planTables = Object.keys(cand).filter((t) => cand[t].size > 0);
  let total = 0;
  const prune = { format: 1, createdAt: new Date().toISOString(), tables: {}, order: [], refs: {}, summary: {} };
  for (const t of planTables) {
    const vi = ti(vdb, t, 'v');
    prune.tables[t] = { cols: vi.cols.map((c) => c.name), pkCols: vi.pkCols, rows: [...cand[t].values()].map((x) => ({ pk: x.pk, fp: x.fp })) };
    rep.perTable[t].planned = cand[t].size;
    rep.samples[t] = [...cand[t].values()].slice(0, 12).map((x) => x.label || JSON.stringify(x.pk));
    total += cand[t].size;
    prune.refs[t] = refs[t] || [];
  }
  // children before parents
  const left = new Set(planTables);
  const order = [];
  let g2 = planTables.length + 5;
  while (left.size && g2-- > 0) {
    for (const t of [...left].sort()) {
      const stillNeeded = [...left].some((o) => o !== t && (refs[t] || []).some((r) => r.table === o));
      if (!stillNeeded) { order.push(t); left.delete(t); }
    }
  }
  for (const t of [...left].sort()) order.push(t);
  prune.order = order;
  prune.summary = { total, tables: planTables.length };
  bdb.close(); vdb.close();
  if (opts.out) L.writeJson(opts.out, prune);
  return { prune, rep, total, maxTotal };
}

function formatReport(r, includeMoney) {
  const lines = [];
  const say = (s) => lines.push(s === undefined ? '' : s);
  const pad = (s, n) => String(s).padEnd(n);
  const rpad = (s, n) => String(s).padStart(n);
  say('==============================================================');
  say('  SHRINK THE LIVE SITE TO MATCH LOCALHOST : PLAN');
  say('  (nothing has been deleted yet)');
  say('==============================================================');
  say('');
  say('IN SHORT');
  say(rpad(r.total, 8) + '  rows will be DELETED from the live site');
  let gone = 0; let changed = 0; let used = 0;
  for (const p of Object.values(r.rep.perTable)) { gone += p.gone; changed += p.changed; used += p.usedByOthers; }
  say(rpad(gone, 8) + '  were deleted on localhost but are already gone from the live site');
  say(rpad(changed, 8) + '  KEPT: somebody changed them on the live site after the baseline (live work is never deleted)');
  say(rpad(used, 8) + '  KEPT: a row that stays on the live site still needs them (see KEPT BECAUSE)');
  say('');
  say('PER TABLE');
  say('  ' + pad('Table', 26) + rpad('Deleted-locally', 16) + rpad('WILL DELETE', 13) + rpad('Kept:changed', 14) + rpad('Kept:in use', 13) + rpad('Gone', 7));
  for (const t of Object.keys(r.rep.perTable).sort()) {
    const p = r.rep.perTable[t];
    if (r.rep.skippedTables[t]) continue;
    say('  ' + pad(t, 26) + rpad(p.deletedLocally, 16) + rpad(p.planned, 13) + rpad(p.changed, 14) + rpad(p.usedByOthers, 13) + rpad(p.gone, 7));
  }
  say('');
  const sk = Object.keys(r.rep.skippedTables);
  if (sk.length) {
    say('NEVER TOUCHED (deleted locally, but these tables are protected or not on the prune list)');
    for (const t of sk.sort()) say('  ' + pad(t, 26) + rpad(r.rep.perTable[t].deletedLocally, 8) + '  ' + r.rep.skippedTables[t]);
    say('');
  }
  if (Object.keys(r.rep.used).length) {
    say('KEPT BECAUSE a row that stays on the live site still points to them');
    for (const P of Object.keys(r.rep.used).sort()) {
      say('  ' + P + ':  ' + Object.entries(r.rep.used[P]).map(([t, n]) => n + ' needed by ' + t).join(', '));
    }
    say('');
  }
  if (Object.keys(r.rep.changedSamples).length) {
    say('KEPT BECAUSE the live site changed them after the baseline (examples)');
    for (const t of Object.keys(r.rep.changedSamples).sort()) say('  ' + t + ': ' + r.rep.changedSamples[t].join(' | '));
    say('');
  }
  say('FIRST ROWS THAT WILL BE DELETED (examples)');
  for (const t of r.prune.order) say('  ' + t + ': ' + (r.rep.samples[t] || []).join(' | '));
  say('');
  say('NOT TOUCHED, ALWAYS: leave management, timesheets, attendance and biometric (devices, punches, settings),');
  say('  e-mail / WhatsApp / SMS / integration settings, message templates, users and logins, candidates, employees,');
  say('  uploaded files. ' + (includeMoney ? 'Invoices and payments ARE in this plan (you asked for them).' : 'Invoices and payments are kept.'));
  say('  Candidates are not deleted: only the applications, jobs and clients you deleted on localhost.');
  return lines.join('\n');
}

module.exports = { makePrune, formatReport, DEFAULT_TABLES, MONEY_TABLES };

if (require.main === module) {
  const a = L.parseArgs(process.argv.slice(2));
  if (!a.delta || !a.baseline || !a.live || !a.out) {
    console.error('Use: node make-prune.js --delta <delta-local.json> --baseline <db> --live <copy of live db> --out <prune.json> [--report file] [--tables A,B] [--include-money] [--max-total N]');
    process.exit(2);
  }
  const r = makePrune({
    delta: a.delta, baseline: a.baseline, live: a.live, out: a.out, configFile: a.config,
    tables: a.tables ? String(a.tables).split(',').map((s) => s.trim()).filter(Boolean) : null,
    includeMoney: !!a['include-money'], maxTotal: a['max-total'] ? Number(a['max-total']) : 40000,
  });
  const text = formatReport(r, !!a['include-money']);
  console.log(text);
  if (a.report) fs.writeFileSync(a.report, text);
  console.log('PRUNE_PLAN total=' + r.total + ' tables=' + r.prune.summary.tables);
  if (r.total > r.maxTotal) {
    console.error('REFUSED: the plan deletes ' + r.total + ' rows, more than the safety limit of ' + r.maxTotal + '. Check that the baseline and the paths are right, or raise --max-total.');
    process.exit(4);
  }
}
void crypto;
