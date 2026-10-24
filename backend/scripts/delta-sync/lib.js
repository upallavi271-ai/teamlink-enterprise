'use strict';
// Shared helpers for the "changes-only push" tools. CommonJS. No node:sqlite at the top
// (apply-delta.js runs on the live server where the Node version is unknown); node:sqlite
// is loaded lazily, only by the functions that need it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_CONFIG = path.join(__dirname, 'exclusions.json');

function loadConfig(file) {
  const p = file || DEFAULT_CONFIG;
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  cfg._file = p;
  return cfg;
}

// ---- value encoding ------------------------------------------------------
// JSON-safe, exact: null, plain string, plain JSON number (= SQLite INTEGER),
// {r:"1.50"} (= REAL), {i:"9007199254740993"} (big INTEGER), {b:"base64"} (= BLOB).
function enc(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return (v >= -9007199254740991n && v <= 9007199254740991n) ? Number(v) : { i: v.toString() };
  if (typeof v === 'number') return { r: Number.isInteger(v) ? v.toFixed(1) : String(v) };
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return { b: Buffer.from(v).toString('base64') };
  return String(v);
}
function lit(e) {
  if (e === null || e === undefined) return 'NULL';
  if (typeof e === 'number') return String(e);
  if (typeof e === 'string') return "'" + e.replace(/'/g, "''") + "'";
  if (e.i !== undefined) return String(e.i);
  if (e.r !== undefined) { const s = String(e.r); return /[.eEn]/.test(s) ? s : s + '.0'; }
  if (e.b !== undefined) return "X'" + Buffer.from(e.b, 'base64').toString('hex').toUpperCase() + "'";
  throw new Error('bad encoded value');
}
function qid(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }
function showValue(e, max) {
  max = max || 60;
  let s;
  if (e === null || e === undefined) s = '(empty)';
  else if (typeof e === 'number') s = String(e);
  else if (typeof e === 'string') s = "'" + e + "'";
  else if (e.i !== undefined) s = e.i;
  else if (e.r !== undefined) s = String(e.r);
  else if (e.b !== undefined) s = '(binary data)';
  else s = String(e);
  s = s.replace(/\s+/g, ' ');
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}
// quote() output (SQL literal text from SQLite) -> short display text
function showQuoted(q, max) {
  max = max || 60;
  if (q === null || q === undefined) return '(unknown)';
  let s = String(q);
  if (s === 'NULL') s = '(empty)';
  else if (/^X'/.test(s)) s = '(binary data)';
  s = s.replace(/\s+/g, ' ');
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}
const pkKey = (pkEnc) => JSON.stringify(pkEnc);

// canonical string of a RAW node:sqlite value (readBigInts on) for hashing/compare
function canon(v) {
  if (v === null || v === undefined) return 'N';
  if (typeof v === 'bigint') return 'i' + v.toString();
  if (typeof v === 'number') return 'r' + String(v);
  if (typeof v === 'string') return 's' + v.length + ':' + v;
  if (v instanceof Uint8Array) return 'b' + Buffer.from(v).toString('base64');
  return 's' + String(v);
}
function rowHash(vals) {
  const h = crypto.createHash('md5');
  for (const v of vals) { h.update(canon(v)); h.update('|'); }
  return h.digest('base64');
}

// ---- node:sqlite helpers (local tools only) ------------------------------
function openDb(file, readOnly) {
  // eslint-disable-next-line global-require
  const { DatabaseSync } = require('node:sqlite');
  if (!fs.existsSync(file)) throw new Error('Database file not found: ' + file);
  return readOnly ? new DatabaseSync(file, { readOnly: true }) : new DatabaseSync(file);
}
function listTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
}
function tableInfo(db, t) {
  const cols = db.prepare('PRAGMA table_info(' + qid(t) + ')').all().map((c) => ({
    name: c.name, type: c.type, notnull: !!c.notnull, hasDefault: c.dflt_value !== null && c.dflt_value !== undefined, pk: c.pk,
  }));
  const pkCols = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  return { cols, pkCols };
}
function fkList(db, t) {
  const rows = db.prepare('PRAGMA foreign_key_list(' + qid(t) + ')').all();
  const byId = new Map();
  for (const r of rows) {
    if (!byId.has(r.id)) byId.set(r.id, { table: r.table, from: [], to: [] });
    const g = byId.get(r.id); g.from.push(r.from); g.to.push(r.to);
  }
  return [...byId.values()];
}
function migrationNames(db) {
  try { return db.prepare('SELECT migration_name AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL').all().map((r) => r.n); } catch { return []; }
}
function snapshotTo(src, dest, readOnly) {
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  const db = openDb(src, readOnly !== false);
  try { db.exec("VACUUM INTO '" + dest.replace(/'/g, "''") + "'"); } finally { db.close(); }
  const d = openDb(dest, false);
  try { d.exec('PRAGMA journal_mode=DELETE'); } finally { d.close(); }
  for (const s of ['-wal', '-shm']) { try { fs.unlinkSync(dest + s); } catch { /* none */ } }
}

// node:sqlite adapter for engine.js (async interface, sync inside)
function nodeAdapter(db) {
  const a = {
    async all(sql) { return db.prepare(sql).all(); },
    async exec(sql) { db.exec(sql); },
    async transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const r = await fn(a); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch { /* already */ } throw e; }
    },
  };
  return a;
}

function readJson(f) { return JSON.parse(fs.readFileSync(f, 'utf8')); }
function writeJson(f, o) { fs.writeFileSync(f, JSON.stringify(o)); }

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { out[k] = argv[++i]; } else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

module.exports = {
  DEFAULT_CONFIG, loadConfig, enc, lit, qid, showValue, showQuoted, pkKey, canon, rowHash,
  openDb, listTables, tableInfo, fkList, migrationNames, snapshotTo, nodeAdapter, readJson, writeJson, parseArgs,
};
