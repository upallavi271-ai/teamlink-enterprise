'use strict';
// engine.js : the ONE rule book that decides what happens to each change on a TARGET database.
// It is used three ways with the same code:
//   * classify-delta.js : dryRun on a read-only copy of the live site (nothing written)
//   * apply-delta.js    : real run on the live site database (one transaction)
//   * update-baseline.js: real run on a copy of the baseline (advance baseline by what was pushed)
// No node:sqlite here: the caller supplies an adapter { all(sql), exec(sql), transaction(fn) }.

const { lit, qid, pkKey, showValue, showQuoted } = require('./lib');

const num = (x) => (x === null || x === undefined ? 0 : Number(x));

class FkError extends Error {
  constructor(list) { super('New foreign-key problems were found after applying the changes.'); this.fkNew = list; }
}

async function loadTarget(db, delta, wantTables) {
  const info = {};
  for (const t of wantTables) {
    const rows = await db.all('PRAGMA table_info(' + qid(t) + ')');
    if (!rows.length) { info[t] = null; continue; }
    const cols = rows.map((r) => ({ name: r.name, notnull: !!num(r.notnull), hasDefault: r.dflt_value !== null && r.dflt_value !== undefined, pk: num(r.pk) }));
    const pkCols = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    const uniques = [];
    const idx = await db.all('PRAGMA index_list(' + qid(t) + ')');
    for (const ix of idx) {
      if (!num(ix.unique) || num(ix.partial) || ix.origin === 'pk') continue;
      const ii = await db.all('PRAGMA index_info(' + qid(ix.name) + ')');
      const names = ii.map((r) => r.name);
      if (names.some((n) => n === null || n === undefined)) continue; // expression index: left to the database
      uniques.push(names);
    }
    info[t] = { cols, names: new Set(cols.map((c) => c.name)), pkCols, uniques };
  }
  return info;
}

function parityProblem(dt, ti) {
  if (!ti) return 'the table does not exist on the target database (run the code deploy first so the database is updated)';
  if (ti.pkCols.join() !== dt.pkCols.join()) return 'primary key differs between the two databases';
  const dnames = new Set(dt.cols.map((c) => c.name));
  for (const c of ti.cols) {
    if (!dnames.has(c.name) && c.notnull && !c.hasDefault && c.pk === 0) return 'the target has a required column "' + c.name + '" that the local database does not have';
  }
  for (const c of dt.cols) {
    if (!ti.names.has(c.name) && c.notnull && !c.hasDefault && c.pk === 0) return 'the local database has a required column "' + c.name + '" that the target does not have';
  }
  return null;
}

async function fkCheckSet(db) {
  const rows = await db.all('PRAGMA foreign_key_check');
  const s = new Map();
  for (const r of rows) s.set([r.table, r.rowid, r.parent, r.fkid].join('|'), { table: r.table, rowid: r.rowid === null || r.rowid === undefined ? null : String(r.rowid), parent: r.parent });
  return s;
}

function pkWhere(dt, pk) { return dt.pkCols.map((c, i) => qid(c) + ' = ' + lit(pk[i])).join(' AND '); }

// options: { dryRun, only (Set of op ids or null) }
async function run(adapter, delta, options) {
  options = options || {};
  const dryRun = !!options.dryRun;
  const only = options.only || null;
  const prefer = !!options.prefer; // conflicts on the same row: the incoming value wins (explicitly chosen by the founder)
  // checkParents: a row whose parent row does not exist on the target (and is not being added in this same run) is a
  // CONFLICT of its own. Without this check the final broken-link check rolled back the WHOLE run because of one such row.
  const checkParents = !!options.checkParents;
  const planned = {}; // table -> Set(pkKey) of rows added (or already there) earlier in this run
  const pkCache = {};
  const soft = new Set(delta.softColumns || []);
  const results = [];
  const undo = { format: 1, ops: [] };
  const refused = {};
  const blocked = {}; // table -> Set(pkKey)
  const addBlocked = (t, pk) => { (blocked[t] || (blocked[t] = new Set())).add(pkKey(pk)); };
  const tables = delta.order.filter((t) => delta.tables[t] && delta.tables[t].ops.some((o) => !only || only.has(o.id)));
  const out = { results, undo, refused, dropped: {}, rolledBack: false, fkNew: [] };

  async function parentPkCols(db, P) {
    if (pkCache[P] === undefined) {
      const rows = await db.all('PRAGMA table_info(' + qid(P) + ')');
      pkCache[P] = rows.length ? rows.filter((r) => num(r.pk) > 0).sort((a, b) => num(a.pk) - num(b.pk)).map((r) => r.name) : null;
    }
    return pkCache[P];
  }
  // name of a parent table whose row does not exist on the target, or null
  async function missingParent(db, dt, op) {
    for (const fk of dt.fks) {
      if (op.k === 'U' && !fk.from.some((c) => op.changed.includes(c))) continue;
      const vals = fk.from.map((c) => op.row[c]);
      if (vals.some((v) => v === null || v === undefined)) continue;
      const ppk = await parentPkCols(db, fk.table);
      if (!ppk || !ppk.length) continue;
      const to = fk.to.map((x) => x || null);
      const target = to.every((x) => x === null) ? ppk : to;
      if (target.join() !== ppk.join()) continue; // not a primary-key link: left to the final broken-link check
      if (planned[fk.table] && planned[fk.table].has(pkKey(vals))) continue;
      const hit = await db.all('SELECT 1 AS x FROM ' + qid(fk.table) + ' WHERE ' + ppk.map((c, i) => qid(c) + ' = ' + lit(vals[i])).join(' AND ') + ' LIMIT 1');
      if (!hit.length) return fk.table;
    }
    return null;
  }

  async function process(db) {
    const tinfo = await loadTarget(db, delta, tables);
    for (const t of tables) {
      const dt = delta.tables[t];
      const ti = tinfo[t];
      const prob = parityProblem(dt, ti);
      const ops = dt.ops.filter((o) => !only || only.has(o.id));
      if (prob) {
        refused[t] = prob;
        for (const op of ops) {
          results.push({ id: op.id, table: t, k: op.k, label: op.label, status: 'refused', reason: prob });
          if (op.k === 'I') addBlocked(t, op.pk);
        }
        continue;
      }
      const droppedCols = dt.cols.filter((c) => !ti.names.has(c.name)).map((c) => c.name);
      if (droppedCols.length) out.dropped[t] = droppedCols;

      for (const op of ops) {
        const res = { id: op.id, table: t, k: op.k, label: op.label, status: null, reason: '' };
        results.push(res);
        // --- depends on something we skipped? ---
        let dep = null;
        for (const fk of dt.fks) {
          const bl = blocked[fk.table];
          if (!bl || !bl.size) continue;
          if (op.k === 'U' && !fk.from.some((c) => op.changed.includes(c))) continue;
          const pt = delta.tables[fk.table];
          const pcols = pt ? pt.pkCols : null;
          const to = fk.to.map((x) => x || null);
          if (pcols && !to.every((x) => x === null) && to.join() !== pcols.join()) continue;
          const vals = fk.from.map((c) => op.row[c]);
          if (vals.some((v) => v === null || v === undefined)) continue;
          if (bl.has(pkKey(vals))) { dep = fk.table; break; }
        }
        if (dep) {
          res.status = 'blocked'; res.reason = 'points to a ' + dep + ' row that was not added (see its conflict)';
          if (op.k === 'I') addBlocked(t, op.pk);
          continue;
        }
        if (checkParents) {
          const miss = await missingParent(db, dt, op);
          if (miss) {
            res.status = 'conflict';
            res.reason = 'points to a ' + miss + ' row that does not exist on the target (deleted there, or never copied)';
            res.detail = { parentMissing: miss };
            if (op.k === 'I') addBlocked(t, op.pk);
            continue;
          }
        }
        try {
          if (op.k === 'I') await doInsert(db, dt, ti, op, res); else await doUpdate(db, dt, ti, op, res);
        } catch (e) {
          res.status = 'conflict'; res.reason = 'the database refused it: ' + String(e.message || e).split('\n').slice(-1)[0].slice(0, 200);
          res.detail = { error: true };
          if (op.k === 'I') addBlocked(t, op.pk);
        }
        if (res.status === 'conflict' && op.k === 'I') addBlocked(t, op.pk);
        if (op.k === 'I' && (res.status === 'applied' || res.status === 'already')) (planned[t] || (planned[t] = new Set())).add(pkKey(op.pk));
      }
    }
  }

  async function doInsert(db, dt, ti, op, res) {
    const t = res.table;
    const cols = Object.keys(op.row).filter((c) => ti.names.has(c));
    const cmp = cols.filter((c) => !soft.has(c));
    const sel = cmp.map((c, i) => '(' + qid(c) + ' IS ' + lit(op.row[c]) + ') AS e' + i).concat(cmp.map((c, i) => 'quote(' + qid(c) + ') AS q' + i));
    const found = await db.all('SELECT ' + sel.join(',') + ' FROM ' + qid(t) + ' WHERE ' + pkWhere(dt, op.pk));
    if (found.length) {
      const r = found[0];
      const diffs = [];
      cmp.forEach((c, i) => { if (!num(r['e' + i])) diffs.push({ column: c, local: showValue(op.row[c]), target: showQuoted(r['q' + i]) }); });
      if (!diffs.length) { res.status = 'already'; res.reason = 'already there'; return; }
      if (prefer) {
        const idxs = []; cmp.forEach((c, i) => { if (!num(r['e' + i]) && !dt.pkCols.includes(c)) idxs.push(i); });
        const restore = {}; const expect = {};
        idxs.forEach((i) => { restore[cmp[i]] = r['q' + i]; expect[cmp[i]] = op.row[cmp[i]]; });
        if (!dryRun) {
          await db.exec('UPDATE ' + qid(t) + ' SET ' + idxs.map((i) => qid(cmp[i]) + ' = ' + lit(op.row[cmp[i]])).join(', ') + ' WHERE ' + pkWhere(dt, op.pk));
          undo.ops.push({ k: 'restore', table: t, pk: op.pk, set: restore, expect });
        }
        res.status = 'applied'; res.reason = 'same ID existed but different: overwritten (your choice to prefer this side)';
        res.detail = { columns: diffs.slice(0, 8).map((x) => ({ column: x.column, baseline: x.target, local: x.local, target: x.target })) };
        return;
      }
      res.status = 'conflict'; res.reason = 'a row with the same ID already exists on the target but it is different';
      res.detail = { columns: diffs.slice(0, 8), moreColumns: Math.max(0, diffs.length - 8) };
      return;
    }
    for (const u of ti.uniques) {
      if (!u.every((c) => op.row[c] !== undefined && op.row[c] !== null)) continue;
      const hit = await db.all('SELECT ' + dt.pkCols.map((c) => 'quote(' + qid(c) + ') AS p_' + dt.pkCols.indexOf(c)).join(',') + ' FROM ' + qid(t) + ' WHERE ' + u.map((c) => qid(c) + ' IS ' + lit(op.row[c])).join(' AND ') + ' LIMIT 1');
      if (hit.length) {
        res.status = 'conflict';
        res.reason = 'the same ' + u.join(' + ') + ' (' + u.map((c) => showValue(op.row[c], 40)).join(', ') + ') is already used by another row on the target';
        res.detail = { unique: u };
        return;
      }
    }
    if (!dryRun) {
      await db.exec('INSERT INTO ' + qid(t) + ' (' + cols.map(qid).join(',') + ') VALUES (' + cols.map((c) => lit(op.row[c])).join(',') + ')');
      undo.ops.push({ k: 'del', table: t, pk: op.pk, row: op.row });
    }
    res.status = 'applied'; res.reason = 'added';
  }

  async function doUpdate(db, dt, ti, op, res) {
    const t = res.table;
    const chg = op.changed.filter((c) => ti.names.has(c));
    const hard = chg.filter((c) => !soft.has(c));
    const softC = chg.filter((c) => soft.has(c));
    if (!hard.length) { res.status = 'already'; res.reason = 'nothing to change'; return; }
    const sel = [];
    hard.forEach((c, i) => { sel.push('(' + qid(c) + ' IS ' + lit(op.old[c]) + ') AS b' + i, '(' + qid(c) + ' IS ' + lit(op.row[c]) + ') AS n' + i, 'quote(' + qid(c) + ') AS q' + i); });
    softC.forEach((c, i) => { sel.push('(' + qid(c) + ' IS ' + lit(op.old[c]) + ') AS sb' + i, 'quote(' + qid(c) + ') AS sq' + i); });
    const found = await db.all('SELECT ' + sel.join(',') + ' FROM ' + qid(t) + ' WHERE ' + pkWhere(dt, op.pk));
    if (!found.length) {
      res.status = 'conflict'; res.reason = 'the row does not exist on the target (deleted or never copied there)';
      res.detail = { columns: hard.map((c) => ({ column: c, baseline: showValue(op.old[c]), local: showValue(op.row[c]), target: '(row missing)' })) };
      return;
    }
    const r = found[0];
    const apply = []; const already = []; const bad = [];
    hard.forEach((c, i) => {
      const entry = { column: c, baseline: showValue(op.old[c]), local: showValue(op.row[c]), target: showQuoted(r['q' + i]) };
      if (num(r['b' + i])) apply.push({ c, q: r['q' + i], entry });
      else if (num(r['n' + i])) already.push(entry);
      else bad.push(entry);
    });
    if (bad.length && prefer) {
      bad.forEach((b) => { const c = b.column; const i = hard.indexOf(c); apply.push({ c, q: r['q' + i], entry: b }); });
      bad.length = 0;
    }
    if (bad.length) {
      res.status = 'conflict';
      res.reason = 'the live site changed this too (' + bad.map((b) => b.column).join(', ') + ')';
      res.detail = { columns: bad };
      return;
    }
    if (!apply.length) { res.status = 'already'; res.reason = 'already there'; return; }
    const sets = apply.map((a) => qid(a.c) + ' = ' + lit(op.row[a.c]));
    const restore = {}; const expect = {};
    apply.forEach((a) => { restore[a.c] = a.q; expect[a.c] = op.row[a.c]; });
    softC.forEach((c, i) => { if (num(r['sb' + i])) { sets.push(qid(c) + ' = ' + lit(op.row[c])); restore[c] = r['sq' + i]; expect[c] = op.row[c]; } });
    if (!dryRun) {
      await db.exec('UPDATE ' + qid(t) + ' SET ' + sets.join(', ') + ' WHERE ' + pkWhere(dt, op.pk));
      undo.ops.push({ k: 'restore', table: t, pk: op.pk, set: restore, expect });
    }
    res.status = 'applied';
    res.reason = apply.map((a) => a.c).join(', ') + (already.length ? ' (+' + already.length + ' already there)' : '');
    res.detail = { columns: apply.map((a) => a.entry) };
  }

  if (dryRun) {
    await process(adapter);
  } else {
    await adapter.exec('PRAGMA foreign_keys=OFF');
    try {
      await adapter.transaction(async (db) => {
        try { await db.exec('PRAGMA defer_foreign_keys=ON'); } catch { /* optional belt */ }
        const before = await fkCheckSet(db);
        await process(db);
        const after = await fkCheckSet(db);
        const fresh = [];
        for (const [k, v] of after) if (!before.has(k)) fresh.push(v);
        if (fresh.length) throw new FkError(fresh);
      });
    } catch (e) {
      if (e instanceof FkError) {
        out.rolledBack = true; out.fkNew = e.fkNew.slice(0, 50); out.fkNewCount = e.fkNew.length;
        out.undo.ops.length = 0;
        for (const r of results) if (r.status === 'applied') { r.status = 'rolledback'; r.reason = 'rolled back (foreign-key check failed)'; }
      } else { await adapter.exec('PRAGMA foreign_keys=ON').catch(() => {}); throw e; }
    }
    await adapter.exec('PRAGMA foreign_keys=ON').catch(() => {});
  }
  out.perTable = summarize(results);
  return out;
}

function summarize(results) {
  const per = {};
  for (const r of results) {
    const p = per[r.table] || (per[r.table] = {
      newAdded: 0, newAlready: 0, newConflict: 0, changedAdded: 0, changedAlready: 0, changedConflict: 0, blocked: 0, refused: 0, rolledback: 0,
    });
    if (r.status === 'blocked') p.blocked++;
    else if (r.status === 'refused') p.refused++;
    else if (r.status === 'rolledback') p.rolledback++;
    else if (r.k === 'I') { if (r.status === 'applied') p.newAdded++; else if (r.status === 'already') p.newAlready++; else p.newConflict++; }
    else if (r.status === 'applied') p.changedAdded++; else if (r.status === 'already') p.changedAlready++; else p.changedConflict++;
  }
  return per;
}

// ---- undo: put the target back exactly as it was before the apply ----
async function runUndo(adapter, undo) {
  const report = { restored: 0, removed: 0, skipped: [] };
  await adapter.exec('PRAGMA foreign_keys=OFF');
  try {
    await adapter.transaction(async (db) => {
      const ops = undo.ops.slice().reverse();
      for (const u of ops) {
        const info = await db.all('PRAGMA table_info(' + qid(u.table) + ')');
        const pkCols = info.filter((c) => num(c.pk) > 0).sort((a, b) => num(a.pk) - num(b.pk)).map((c) => c.name);
        const where = pkCols.map((c, i) => qid(c) + ' = ' + lit(u.pk[i])).join(' AND ');
        if (u.k === 'del') {
          const cols = Object.keys(u.row).filter((c) => !(undo.softIgnore || []).includes(c));
          const cmp = cols.filter((c) => !/^(updatedAt|modifiedAt|lastModifiedAt)$/.test(c));
          const same = await db.all('SELECT ' + cmp.map((c, i) => '(' + qid(c) + ' IS ' + lit(u.row[c]) + ') AS e' + i).join(',') + ' FROM ' + qid(u.table) + ' WHERE ' + where);
          if (!same.length) continue;
          if (cmp.every((c, i) => num(same[0]['e' + i]))) { await db.exec('DELETE FROM ' + qid(u.table) + ' WHERE ' + where); report.removed++; } else report.skipped.push(u.table + ' ' + JSON.stringify(u.pk) + ': changed after the push, not removed');
        } else {
          const cols = Object.keys(u.expect);
          const same = await db.all('SELECT ' + cols.map((c, i) => '(' + qid(c) + ' IS ' + lit(u.expect[c]) + ') AS e' + i).join(',') + ' FROM ' + qid(u.table) + ' WHERE ' + where);
          if (!same.length) { report.skipped.push(u.table + ' ' + JSON.stringify(u.pk) + ': row is gone'); continue; }
          if (!cols.every((c, i) => num(same[0]['e' + i]))) { report.skipped.push(u.table + ' ' + JSON.stringify(u.pk) + ': changed after the push, not restored'); continue; }
          // the stored values are SQL literals written by SQLite's own quote()
          await db.exec('UPDATE ' + qid(u.table) + ' SET ' + cols.map((c) => qid(c) + ' = ' + u.set[c]).join(', ') + ' WHERE ' + where);
          report.restored++;
        }
      }
    });
  } finally { await adapter.exec('PRAGMA foreign_keys=ON').catch(() => {}); }
  return report;
}

module.exports = { run, runUndo, summarize, FkError };
