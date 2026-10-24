// ---------------------------------------------------------------------------
// Plain-SQL access to the vendor-module tables (migration 20261014800000_vendor_modules).
// These tables are not in schema.prisma (no `prisma generate` needed to ship them), so every read / write goes
// through $queryRawUnsafe / $executeRawUnsafe with bound parameters (never string-built values).
//   * ready()   feature-detects the tables; until the migration is applied the new modules answer "not set up yet".
//   * times     DATETIME columns hold epoch milliseconds; `toDate` reads any shape back, `now()` writes one.
//   * BigInt    SQLite counts come back as BigInt: `clean` turns them into numbers so JSON works.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

const TABLES = ['VendorLoginModule', 'IdCardOrder', 'IdCardOrderLine', 'IdCardOrderEvent', 'SimConnection', 'SimRequest', 'VendorModuleBill'];

const clean = (v) => {
  if (typeof v === 'bigint') return Number(v);
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object' && !(v instanceof Date)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]));
  return v;
};
// A time as epoch ms, a Date, an ISO string or null -> Date | null.
const toDate = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const d = new Date(typeof v === 'bigint' ? Number(v) : v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const now = () => Date.now();
const newId = () => `vm${crypto.randomBytes(12).toString('hex')}`;

const exec = (c) => c || prisma;
const q = async (sql, params = [], c) => clean(await exec(c).$queryRawUnsafe(sql, ...params));
const one = async (sql, params = [], c) => (await q(sql, params, c))[0] || null;
const run = (sql, params = [], c) => exec(c).$executeRawUnsafe(sql, ...params);

let okCache = false;
let lastCheck = 0;
// True when every vendor-module table exists. A "yes" is remembered; a "no" is re-checked every 20 s (the migration may be applied while the server runs).
async function ready() {
  if (okCache) return true;
  if (Date.now() - lastCheck < 20000 && lastCheck) return false;
  lastCheck = Date.now();
  try {
    const rows = await q("SELECT name FROM sqlite_master WHERE type='table'");
    const have = new Set(rows.map((r) => r.name));
    okCache = TABLES.every((t) => have.has(t));
  } catch { okCache = false; }
  return okCache;
}
// For tests: forget the cached answer.
const resetReady = () => { okCache = false; lastCheck = 0; };

// The next human code: PREFIX-0001 (the max number in the column + 1).
async function nextCode(table, column, prefix, width = 4, c) {
  const rows = await q(`SELECT "${column}" AS code FROM "${table}" WHERE "${column}" LIKE ?`, [`${prefix}-%`], c);
  const max = rows.reduce((m, r) => { const x = new RegExp(`^${prefix}-(\\d+)$`).exec(r.code || ''); return x ? Math.max(m, Number(x[1])) : m; }, 0);
  return `${prefix}-${String(max + 1).padStart(width, '0')}`;
}

const NOT_READY = { error: 'This part of the portal is not set up yet on this server. Ask the company to finish the setup.', notReady: true };

module.exports = { q, one, run, ready, resetReady, clean, toDate, now, newId, nextCode, NOT_READY, TABLES, prisma };
