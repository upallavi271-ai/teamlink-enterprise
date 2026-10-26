'use strict';
// prune-engine.js : removes from a TARGET database the rows that were deleted on localhost.
// Used on the live server by prune-apply.js (through Prisma) and by the tests (through node:sqlite).
// No node:sqlite here: the caller supplies an adapter { all(sql), exec(sql), transaction(fn) }.
//
// Rules (every one of them only ever makes the tool delete LESS):
//   * a row is deleted only if it still looks EXACTLY like it did when the plan was made (fingerprint);
//   * a row that some surviving row still points to is kept (checked again at the moment of deleting);
//   * rows go in small batches, children before parents, so the live app is never blocked for long;
//   * every deleted row is written to the undo list (SQLite quote() text), so --restore can put it back.

const crypto = require('crypto');
const { lit, qid } = require('./lib');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fingerprint = (quoted) => crypto.createHash('md5').update(quoted.join('\u0001')).digest('base64');
const selectQuoted = (cols) => cols.map((c, i) => 'quote(' + qid(c) + ') AS q' + i).join(',');
const pkWhere = (pkCols, pk) => pkCols.map((c, i) => qid(c) + ' = ' + lit(pk[i])).join(' AND ');

// options: { apply, batch, pauseMs, log }
async function applyPrune(adapter, prune, options) {
  options = options || {};
  const apply = !!options.apply;
  const batchSize = options.batch || 200;
  const pauseMs = options.pauseMs === undefined ? 40 : options.pauseMs;
  const log = options.log || (() => {});
  const res = { tables: {}, removed: {}, undo: { format: 1, tables: [] }, aborted: false, errors: [] };
  let errorsInARow = 0;

  if (apply) await adapter.exec('PRAGMA foreign_keys=OFF');
  try {
    for (const t of prune.order) {
      const T = prune.tables[t];
      if (!T) continue;
      const st = res.tables[t] = { planned: T.rows.length, deleted: 0, gone: 0, changed: 0, used: 0, error: 0 };
      const removed = [];
      const undoRows = [];
      const refs = (prune.refs && prune.refs[t]) || [];

      const doBatch = async (db, chunk) => {
        const out = { deleted: [], gone: 0, changed: 0, used: 0, undo: [], removedPk: [] };
        let live = [];
        for (const row of chunk) {
          const r = await db.all('SELECT ' + selectQuoted(T.cols) + ' FROM ' + qid(t) + ' WHERE ' + pkWhere(T.pkCols, row.pk));
          if (!r.length) { out.gone++; out.removedPk.push(row.pk); continue; }
          const q = T.cols.map((c, i) => String(r[0]['q' + i]));
          if (fingerprint(q) !== row.fp) { out.changed++; continue; }
          live.push({ row, q });
        }
        if (apply && live.length && refs.length) {
          // is any surviving row still pointing at one of these rows? (the plan was made minutes ago)
          const blocked = new Set();
          for (const ref of refs) {
            const toIdx = ref.to.map((c) => T.cols.indexOf(c));
            if (toIdx.some((x) => x < 0)) { live.forEach((d, k) => blocked.add(k)); break; }
            if (ref.from.length === 1) {
              const lits = [...new Set(live.map((d) => d.q[toIdx[0]]).filter((v) => v !== 'NULL'))];
              for (let a = 0; a < lits.length; a += 400) {
                const part = lits.slice(a, a + 400);
                const used = await db.all('SELECT DISTINCT quote(' + qid(ref.from[0]) + ') AS v FROM ' + qid(ref.table) + ' WHERE ' + qid(ref.from[0]) + ' IN (' + part.join(',') + ')');
                const usedSet = new Set(used.map((u) => String(u.v)));
                live.forEach((d, k) => { if (usedSet.has(d.q[toIdx[0]])) blocked.add(k); });
              }
            } else {
              for (let k = 0; k < live.length; k++) {
                const vals = toIdx.map((x) => live[k].q[x]);
                if (vals.includes('NULL')) continue;
                const hit = await db.all('SELECT 1 AS x FROM ' + qid(ref.table) + ' WHERE ' + ref.from.map((c, j) => qid(c) + ' = ' + vals[j]).join(' AND ') + ' LIMIT 1');
                if (hit.length) blocked.add(k);
              }
            }
          }
          if (blocked.size) {
            out.used = blocked.size;
            live = live.filter((d, k) => !blocked.has(k));
          }
        }
        if (apply && live.length) {
          if (T.pkCols.length === 1) {
            for (let a = 0; a < live.length; a += 400) {
              const part = live.slice(a, a + 400);
              await db.exec('DELETE FROM ' + qid(t) + ' WHERE ' + qid(T.pkCols[0]) + ' IN (' + part.map((d) => lit(d.row.pk[0])).join(',') + ')');
            }
          } else {
            for (const d of live) await db.exec('DELETE FROM ' + qid(t) + ' WHERE ' + pkWhere(T.pkCols, d.row.pk));
          }
        }
        for (const d of live) { out.deleted.push(d.row.pk); out.removedPk.push(d.row.pk); out.undo.push(d.q); }
        return out;
      };

      for (let i = 0; i < T.rows.length; i += batchSize) {
        const chunk = T.rows.slice(i, i + batchSize);
        let out;
        try {
          out = apply ? await adapter.transaction((db) => doBatch(db, chunk)) : await doBatch(adapter, chunk);
          errorsInARow = 0;
        } catch (e) {
          st.error += chunk.length;
          res.errors.push(t + ': ' + String((e && e.message) || e).split('\n').slice(-1)[0].slice(0, 200));
          if (++errorsInARow >= 3) { res.aborted = true; break; }
          continue;
        }
        st.deleted += out.deleted.length; st.gone += out.gone; st.changed += out.changed; st.used += out.used;
        out.removedPk.forEach((p) => removed.push(p));
        out.undo.forEach((q) => undoRows.push(q));
        if (apply && pauseMs) await sleep(pauseMs);
      }
      res.removed[t] = removed;
      if (apply && undoRows.length) res.undo.tables.push({ table: t, cols: T.cols, pkCols: T.pkCols, rows: undoRows });
      log(t + ': ' + (apply ? 'deleted ' : 'would delete ') + st.deleted + ', already gone ' + st.gone + ', changed on live ' + st.changed + ', still used ' + st.used + (st.error ? ', ERRORS ' + st.error : ''));
      if (res.aborted) break;
    }
  } finally {
    if (apply) await adapter.exec('PRAGMA foreign_keys=ON').catch(() => {});
  }
  return res;
}

// put the deleted rows back (parents first = reverse of the deletion order). Rows that exist again are left alone.
async function restorePrune(adapter, undo, options) {
  options = options || {};
  const out = { restored: 0, existed: 0 };
  await adapter.exec('PRAGMA foreign_keys=OFF');
  try {
    const tables = (undo.tables || []).slice().reverse();
    for (const U of tables) {
      const idx = U.pkCols.map((c) => U.cols.indexOf(c));
      for (let i = 0; i < U.rows.length; i += 300) {
        const chunk = U.rows.slice(i, i + 300);
        const r = await adapter.transaction(async (db) => {
          let restored = 0; let existed = 0;
          for (const q of chunk) {
            const where = U.pkCols.map((c, j) => qid(c) + ' = ' + q[idx[j]]).join(' AND ');
            const have = await db.all('SELECT 1 AS x FROM ' + qid(U.table) + ' WHERE ' + where + ' LIMIT 1');
            if (have.length) { existed++; continue; }
            await db.exec('INSERT OR IGNORE INTO ' + qid(U.table) + ' (' + U.cols.map(qid).join(',') + ') VALUES (' + q.join(',') + ')');
            restored++;
          }
          return { restored, existed };
        });
        out.restored += r.restored; out.existed += r.existed;
        if (options.pauseMs) await sleep(options.pauseMs);
      }
    }
  } finally { await adapter.exec('PRAGMA foreign_keys=ON').catch(() => {}); }
  return out;
}

module.exports = { applyPrune, restorePrune, fingerprint, selectQuoted, pkWhere };
