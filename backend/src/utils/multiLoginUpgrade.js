// ---------------------------------------------------------------------------
// THE ONE-TIME UPGRADE FOR "SEPARATE LOGINS ON ONE EMAIL" (founder, 2026-10-21).
//
// Until it is done, the database refuses a second login on an email that already has one (User.email is UNIQUE). The upgrade:
//   1. makes a backup copy of the whole database first (VACUUM INTO a new file);
//   2. adds small INTERNAL tables / columns (utils/loginAccounts.js ensure()) that nobody sees;
//   3. in ONE transaction: drops the one-login-per-email rule (when it is a stand-alone index). People sign in with their email only: no
//      number is given to any login;
//   4. writes an UNDO MANIFEST (what was dropped).
// It never deletes a user and never touches a password. Running it again changes nothing. Undo puts the rule back (refused while two logins
// share an email).
//
// When the one-login-per-email rule is written INSIDE the User table definition (not a separate index) SQLite cannot drop it: the table has to
// be rebuilt. That is rebuildUserTable() - it only runs from scripts/multi-login-upgrade.js with the server stopped, never from the web app.
//
// Used by: scripts/multi-login-upgrade.js (the founder's command) and the Super Admin button on Administration -> Users.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const prisma = require('../db');
const LA = require('./loginAccounts');

const BACKEND = path.resolve(__dirname, '..', '..');
const REAL_DB = path.join(BACKEND, 'prisma', 'dev.db');

// The database file DATABASE_URL points at (Prisma resolves a relative path against the folder holding schema.prisma).
function dbFile(url = process.env.DATABASE_URL) {
  const m = /^file:(.*?)(\?.*)?$/.exec(String(url || ''));
  if (!m) return null;
  let p = m[1];
  if (p.startsWith('//')) p = p.slice(2);
  return path.isAbsolute(p) || /^[A-Za-z]:/.test(p) ? path.resolve(p) : path.resolve(BACKEND, 'prisma', p);
}
const isRealDb = (file = dbFile()) => !!file && path.resolve(file).toLowerCase() === REAL_DB.toLowerCase();
const defaultBackupDir = () => process.env.TL_BACKUP_DIR || path.join(os.homedir(), '.teamlink-backups');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const sqlQuote = (v) => String(v).replace(/'/g, "''");

const q = LA.q;

// ---- READ-ONLY: what is the state? (adds nothing to the database) -----------------------------------------------------------------
async function inspect() {
  const cols = await q('PRAGMA table_info("User")');
  const hasCol = cols.some((c) => c.name === 'loginId');
  const tables = new Set((await q("SELECT name FROM sqlite_master WHERE type='table'")).map((r) => r.name));
  const users = (await q('SELECT COUNT(*) AS n FROM "User"'))[0].n;
  const dupGroups = (await q('SELECT COUNT(*) AS n FROM (SELECT lower(trim("email")) AS e FROM "User" GROUP BY e HAVING COUNT(*) > 1)'))[0].n;
  const index = await LA.emailIndex();
  return {
    database: dbFile(),
    isRealDatabase: isRealDb(),
    users,
    sharedEmailGroups: dupGroups,
    emailIndex: index, // { unique, name, kind: 'standalone' | 'inline' | 'none' }
    multiLoginOn: !index.unique,
    loginIdColumn: hasCol,
    employeeLoginTable: tables.has('EmployeeLogin'),
    counterTable: tables.has('LoginIdCounter'),
    upToDate: !index.unique && hasCol && tables.has('EmployeeLogin') && tables.has('LoginIdCounter'),
  };
}

async function backupTo(dir, label) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${label}-${stamp()}.db`);
  await prisma.$executeRawUnsafe(`VACUUM INTO '${sqlQuote(file.split(path.sep).join('/'))}'`);
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (!size) throw new Error('The backup copy could not be written, so nothing was changed.');
  return { file, size };
}

// ---- APPLY ------------------------------------------------------------------------------------------------------------------------
// -> { changed, needsRebuild, backup, manifest, ... }. Idempotent: when nothing is left to do it makes no backup and no change.
async function apply({ backupDir = defaultBackupDir(), manifestDir = null, who = 'upgrade script', skipBackup = false } = {}) {
  const before = await inspect();
  if (before.upToDate) return { changed: false, alreadyDone: true, before, after: before };
  if (before.emailIndex.unique && before.emailIndex.kind === 'inline') {
    return { changed: false, needsRebuild: true, before, after: before };
  }
  const backup = skipBackup ? null : await backupTo(backupDir, 'before-multi-login');
  await LA.ensure();
  const manifest = {
    at: new Date().toISOString(), who, database: before.database, backup: backup ? backup.file : null,
    droppedIndex: null, assigned: [], createdIndexes: ['User_loginId_key', 'User_loginId_lower_key', 'User_email_lower_idx'],
  };
  await prisma.$transaction(async (tx) => {
    const idx = await LA.emailIndex();
    if (idx.unique && idx.kind === 'standalone') {
      const name = String(idx.name).replace(/"/g, '');
      const def = await tx.$queryRawUnsafe('SELECT "sql" FROM sqlite_master WHERE type = \'index\' AND name = ?', name);
      manifest.droppedIndex = { name, sql: (def[0] && def[0].sql) || `CREATE UNIQUE INDEX "${name}" ON "User"("email")` };
      await tx.$executeRawUnsafe(`DROP INDEX "${name}"`);
    }
  }, { timeout: 120000, maxWait: 60000 });
  const mdir = manifestDir || backupDir;
  fs.mkdirSync(mdir, { recursive: true });
  const manifestFile = path.join(mdir, `multi-login-undo-${stamp()}.json`);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  LA.forgetState(); LA.forget();
  require('./shareDedupe').forget(); // eslint-disable-line global-require
  const after = await inspect();
  return { changed: true, backup, manifestFile, manifest, before, after };
}

// ---- UNDO -------------------------------------------------------------------------------------------------------------------------
async function undo(manifestFile) {
  const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const now = await inspect();
  if (m.rebuilt) return { ok: false, reason: 'This upgrade rebuilt the User table. Restore the backup copy instead (see the manifest).' };
  if (m.droppedIndex && now.sharedEmailGroups > 0) {
    return { ok: false, reason: `${now.sharedEmailGroups} email address(es) are used by more than one login now, so the one-login-per-email rule cannot be put back. Change or remove the extra logins first.` };
  }
  await prisma.$transaction(async (tx) => {
    for (const a of m.assigned || []) {
      // eslint-disable-next-line no-await-in-loop
      await tx.$executeRawUnsafe('UPDATE "User" SET "loginId" = NULL WHERE "id" = ? AND "loginId" = ?', a.userId, a.loginId);
    }
    if (m.droppedIndex) await tx.$executeRawUnsafe(m.droppedIndex.sql.replace(/^CREATE UNIQUE INDEX (?!IF NOT EXISTS)/i, 'CREATE UNIQUE INDEX IF NOT EXISTS '));
  }, { timeout: 120000, maxWait: 60000 });
  LA.forgetState(); LA.forget();
  return { ok: true, restoredRule: !!m.droppedIndex, after: await inspect() };
}

// ---- THE INLINE-RULE CASE: rebuild the User table without UNIQUE(email). Server stopped; CLI only. ---------------------------------------
// The documented SQLite procedure (https://www.sqlite.org/lang_altertable.html #7): foreign keys off, one transaction, new table, copy,
// drop, rename, rebuild indexes, foreign_key_check, commit.
function withoutInlineEmailUnique(sql) {
  let out = String(sql);
  // "email" TEXT NOT NULL UNIQUE
  out = out.replace(/("email"\s+TEXT(?:\s+NOT\s+NULL)?)\s+UNIQUE\b/i, '$1');
  // , UNIQUE ("email")   or   , CONSTRAINT "x" UNIQUE ("email")
  out = out.replace(/,\s*(?:CONSTRAINT\s+"?[\w]+"?\s+)?UNIQUE\s*\(\s*"?email"?\s*\)/i, '');
  return out;
}
function rebuildUserTable(file, { newSql = null, backupFile } = {}) {
  const { DatabaseSync } = require('node:sqlite'); // eslint-disable-line global-require
  if (!file || !fs.existsSync(file)) throw new Error('Database file not found.');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 30000');
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='User'").get();
    if (!row) throw new Error('No User table.');
    const oldSql = row.sql;
    const target = newSql || withoutInlineEmailUnique(oldSql);
    if (!newSql && target === oldSql) throw new Error('Could not find the email rule inside the User table definition; nothing was changed.');
    const aux = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='User' AND type IN ('index','trigger') AND sql IS NOT NULL").all().map((r) => r.sql);
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(target.replace(/CREATE TABLE\s+"?User"?/i, 'CREATE TABLE "User_rebuild"'));
      db.exec('INSERT INTO "User_rebuild" SELECT * FROM "User"');
      db.exec('DROP TABLE "User"');
      db.exec('ALTER TABLE "User_rebuild" RENAME TO "User"');
      aux.forEach((s) => db.exec(s));
      const bad = db.prepare('PRAGMA foreign_key_check').all();
      if (bad.length) throw new Error(`Foreign key check failed (${bad.length} problem rows); rolled back.`);
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
    db.exec('PRAGMA foreign_keys = ON');
    return { oldSql, newSql: target, backupFile };
  } finally {
    db.close();
  }
}

module.exports = { inspect, apply, undo, rebuildUserTable, withoutInlineEmailUnique, backupTo, dbFile, isRealDb, defaultBackupDir, REAL_DB };
