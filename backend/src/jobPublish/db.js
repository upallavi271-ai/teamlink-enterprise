// ---------------------------------------------------------------------------
// JOB PUBLISHING: plain-SQL helpers for the five engine tables
// (PostingQueue, PostingLog, PortalCredential, PortalMapping, PortalPosting; migration
// 20261013120000_job_publish_queue). Plain SQL on purpose: it works before and after `prisma generate`, and the
// queue claim needs one atomic UPDATE ... RETURNING that the client API cannot express.
//
// DateTime columns hold epoch MILLISECONDS (the same as every Prisma SQLite DateTime).
// Nothing here starts a timer, a worker or a connection by itself.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
function ms(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
const iso = (v) => { const t = ms(v); return t == null ? null : new Date(t).toISOString(); };
const json = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const newId = (p = '') => `${p}${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;

// rows come back with BigInt for INTEGER columns: turn them into numbers.
const fix = (r) => { const o = {}; Object.keys(r).forEach((k) => { o[k] = num(r[k]); }); return o; };
// SQLite lets one writer in at a time (the API, the worker and other jobs share the file): a busy answer is waited out.
const isBusy = (e) => /database is locked|SQLITE_BUSY|socket timeout/i.test(String((e && e.message) || e));
async function patient(fn) {
  for (let i = 0; ; i += 1) {
    try { return await fn(); } catch (e) {
      if (!isBusy(e) || i >= 8) throw e;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
}
const q = async (sql, ...p) => (await patient(() => prisma.$queryRawUnsafe(sql, ...p))).map(fix);
const q1 = async (sql, ...p) => (await q(sql, ...p))[0] || null;
const ex = (sql, ...p) => patient(() => prisma.$executeRawUnsafe(sql, ...p));

// --- feature detection: the tables exist once main applied the migration -----------------
const TABLES = ['PostingQueue', 'PostingLog', 'PortalCredential', 'PortalMapping', 'PortalPosting'];
let tableOk = null; let tableAt = 0;
async function supported() {
  if (tableOk === true) return true;
  if (tableOk === false && Date.now() - tableAt < 15000) return false;
  try {
    const r = await q(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${TABLES.map(() => '?').join(',')})`, ...TABLES);
    tableOk = r.length === TABLES.length;
  } catch { tableOk = false; }
  tableAt = Date.now();
  return tableOk;
}
const forgetSupport = () => { tableOk = null; };
const NOT_READY = 'Job publishing is not set up in this database yet (the migration 20261013120000_job_publish_queue has not been applied).';

// The database file this process is connected to (for the worker's real-database guard).
function databaseFile() {
  const url = String(process.env.DATABASE_URL || '');
  return url.replace(/^file:/, '').replace(/[?#].*$/, '').replace(/["']/g, '');
}
function usesRealDevDb() {
  const base = require('path').basename(databaseFile());
  return /^dev\.db$/i.test(base);
}

module.exports = {
  prisma, q, q1, ex, ms, iso, json, newId, num, supported, forgetSupport, NOT_READY, TABLES, databaseFile, usesRealDevDb,
};
