// ---------------------------------------------------------------------------
// DAILY BACKUP + RESTORE TEST (spec section 21 "Backups").
//
// What one backup is — a folder named by date and time, e.g.
//   ~/.teamlink-backups/2026-10-03_0200/
//     teamlink.db      a CONSISTENT copy of the live SQLite database, made with
//                      `VACUUM INTO` (never a raw copy of a file in use, which
//                      can be torn mid-write in WAL mode)
//     files/uploads/   UPLOAD_DIR   (resumes, bills, LMS media …)
//     files/ats-io/    ATS_IO_DIR   (import / export files)
//     files/message-jobs/ MESSAGE_JOB_DIR (bulk message queue)
//     manifest.json    what was copied: row counts, file counts, bytes
//     verify.json      the last restore test of THIS backup
//
// Files that did not change since the previous backup are HARD LINKS to the
// copy in that backup (same disk, no extra space), so every folder is still a
// full, plain copy you can open — but 22 backups of the resume folder do not
// take 22 times the space.
//
// Kept: the newest backup of each of the last 14 days, plus the newest of each
// of the last 8 weeks, plus anything younger than 24 hours. Only folders this
// tool made (manifest.tool === TOOL) are ever removed.
//
// Where: BACKUP_DIR, default ~/.teamlink-backups — OUTSIDE the repository and
// outside any web root. makeBackup() refuses a BACKUP_DIR inside the repo.
//
// The restore test copies the backup's database to a temp file, runs SQLite's
// integrity check on it, opens it with Prisma, counts the key tables and
// compares them with the counts taken at backup time. OK / FAIL is kept in
// status.json and shown on Administration → System.
//
// Nothing here runs by itself. scripts/backup.js is the command line (npm run
// backup / backup:verify); routes/system.js and startSchedule() below run that
// script in a CHILD process, so a backup never blocks the API's event loop.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TOOL = 'teamlink-backup';
const BACKEND = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(BACKEND, '..');
const SET_NAME = /^\d{4}-\d{2}-\d{2}_\d{4}(-\d+)?$/;
const KEEP_DAILY = 14;
const KEEP_WEEKLY = 8;
const LOCK_STALE_MS = 60 * 60 * 1000;

// The tables the restore test counts. Order = order on screen.
const KEY_TABLES = [
  ['User', 'user', 'Logins'],
  ['Employee', 'employee', 'Employees'],
  ['Client', 'client', 'Clients'],
  ['Requirement', 'requirement', 'Jobs'],
  ['Candidate', 'candidate', 'Candidates'],
  ['Application', 'application', 'Applications'],
  ['Attendance', 'attendance', 'Attendance days'],
  ['Invoice', 'invoice', 'Invoices'],
];

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());
const isSandbox = () => truthy(process.env.TEST_MODE) || truthy(process.env.TEAMLINK_SANDBOX);
const home = () => os.homedir() || os.tmpdir();

function dbFile() {
  let url = String(process.env.DATABASE_URL || 'file:./dev.db').trim().replace(/^["']|["']$/g, '');
  url = url.replace(/^file:/, '').replace(/[?#].*$/, '');
  // Prisma resolves a relative SQLite path against the schema's folder.
  return path.isAbsolute(url) ? path.resolve(url) : path.resolve(BACKEND, 'prisma', url);
}

function backupRoot() {
  const dir = process.env.BACKUP_DIR
    || (isSandbox() ? path.join(home(), '.teamlink-sandbox', 'backups') : path.join(home(), '.teamlink-backups'));
  return path.resolve(dir);
}

function fileSources() {
  return [
    { key: 'uploads', label: 'Uploaded files and resumes', dir: process.env.UPLOAD_DIR || path.join(home(), '.teamlink-uploads') },
    { key: 'ats-io', label: 'Import / export files', dir: process.env.ATS_IO_DIR || path.join(home(), '.teamlink-data', 'ats-io') },
    { key: 'message-jobs', label: 'Bulk message queue', dir: process.env.MESSAGE_JOB_DIR || path.join(home(), '.teamlink-message-jobs') },
  ].map((s) => ({ ...s, dir: path.resolve(s.dir) }));
}

const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
};

function assertSafeRoot(root) {
  if (inside(root, REPO)) {
    throw new Error(`BACKUP_DIR (${root}) is inside the project folder, which goes to git. Choose a folder outside ${REPO}.`);
  }
}

// --- status.json ------------------------------------------------------------
function statusFile() { return path.join(backupRoot(), 'status.json'); }
function readStatus() {
  try { return JSON.parse(fs.readFileSync(statusFile(), 'utf8')); } catch { return {}; }
}
function writeStatus(patch) {
  const root = backupRoot();
  fs.mkdirSync(root, { recursive: true });
  const next = { ...readStatus(), ...patch };
  const tmp = `${statusFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, statusFile());
  return next;
}

// --- lock (the app's scheduler, the button and `npm run backup` may race) ----
function lockFile() { return path.join(backupRoot(), 'backup.lock'); }
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}
// A lock whose process is gone (killed, crashed, PC restarted) is no lock.
function readLock() {
  try {
    const l = JSON.parse(fs.readFileSync(lockFile(), 'utf8'));
    if (Date.now() - new Date(l.startedAt).getTime() > LOCK_STALE_MS) return null;
    if (l.pid !== process.pid && !pidAlive(l.pid)) return null;
    return l;
  } catch { return null; }
}
function takeLock(what) {
  fs.mkdirSync(backupRoot(), { recursive: true });
  const cur = readLock();
  if (cur) throw Object.assign(new Error(`A ${cur.what || 'backup'} is already running (started ${cur.startedAt}).`), { code: 'EBUSY_BACKUP' });
  // A stale lock (older than LOCK_STALE_MS) is cleared; then 'wx' makes taking
  // it atomic, so two runs started at the same moment cannot both win.
  try { fs.unlinkSync(lockFile()); } catch { /* none */ }
  try {
    fs.writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, what, startedAt: new Date().toISOString() }), { flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') throw Object.assign(new Error('A backup is already running.'), { code: 'EBUSY_BACKUP' });
    throw err;
  }
}
function dropLock() { try { fs.unlinkSync(lockFile()); } catch { /* gone */ } }

// --- sets ---------------------------------------------------------------------
function readManifest(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    return m && m.tool === TOOL ? m : null;
  } catch { return null; }
}
function readVerify(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'verify.json'), 'utf8')); } catch { return null; }
}

function listSets() {
  const root = backupRoot();
  let names = [];
  try { names = fs.readdirSync(root).filter((n) => SET_NAME.test(n)); } catch { return []; }
  return names
    .map((name) => {
      const dir = path.join(root, name);
      const manifest = readManifest(dir);
      return manifest ? { name, dir, manifest, verify: readVerify(dir), createdAt: manifest.createdAt } : null;
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${pad(Math.ceil(((t - y0) / 86400000 + 1) / 7))}`;
}

function newSetName(root, now = new Date()) {
  const base = `${localDay(now)}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  let name = base;
  for (let i = 2; fs.existsSync(path.join(root, name)) || fs.existsSync(path.join(root, `.inprogress-${name}`)); i += 1) name = `${base}-${i}`;
  return name;
}

// Which sets to keep (pure — tested on its own).
function retentionPlan(sets, now = new Date()) {
  const keep = new Set();
  const days = new Set();
  const weeks = new Set();
  const dailyWeeks = new Set();
  // Newest first. Days fill first; the 8 weekly backups are the 8 weeks
  // OLDER than the 14 daily ones (so about 10 weeks of history in all).
  for (const s of [...sets].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))) {
    const at = new Date(s.createdAt);
    if (now - at < 24 * 3600 * 1000) keep.add(s.name);
    const d = localDay(at);
    const w = isoWeek(at);
    if (days.has(d)) continue;
    if (days.size < KEEP_DAILY) { days.add(d); dailyWeeks.add(w); keep.add(s.name); continue; }
    if (!dailyWeeks.has(w) && !weeks.has(w) && weeks.size < KEEP_WEEKLY) { weeks.add(w); keep.add(s.name); }
  }
  // Never remove the newest backup whose restore test passed.
  const lastGood = [...sets].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .find((s) => s.verify && s.verify.ok);
  if (lastGood) keep.add(lastGood.name);
  return { keep: sets.filter((s) => keep.has(s.name)), drop: sets.filter((s) => !keep.has(s.name)) };
}

function prune(log = () => {}) {
  const root = backupRoot();
  const { drop } = retentionPlan(listSets());
  for (const s of drop) {
    // Belt and braces: only a folder this tool made, directly inside the root.
    if (path.dirname(s.dir) !== root || !SET_NAME.test(s.name) || !readManifest(s.dir)) continue;
    fs.rmSync(s.dir, { recursive: true, force: true });
    log(`removed old backup ${s.name}`);
  }
  // Half-finished folders from a crash, older than a day.
  try {
    for (const n of fs.readdirSync(root)) {
      if (!n.startsWith('.inprogress-')) continue;
      const p = path.join(root, n);
      if (Date.now() - fs.statSync(p).mtimeMs > 24 * 3600 * 1000) fs.rmSync(p, { recursive: true, force: true });
    }
  } catch { /* nothing to tidy */ }
  return drop.map((s) => s.name);
}

// --- copying ------------------------------------------------------------------
function walk(dir, skip, out = [], rel = '') {
  let entries = [];
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel ? path.join(rel, e.name) : e.name;
    const abs = path.join(dir, r);
    if (skip.some((s) => inside(abs, s))) continue;
    if (e.isDirectory()) walk(dir, skip, out, r);
    else if (e.isFile()) out.push(r);
  }
  return out;
}

function copyTree(src, dest, prevDest, skip) {
  let files = 0;
  let bytes = 0;
  let linked = 0;
  if (!fs.existsSync(src)) return { files, bytes, linked, missing: true };
  for (const rel of walk(src, skip)) {
    const from = path.join(src, rel);
    const to = path.join(dest, rel);
    let st;
    try { st = fs.statSync(from); } catch { continue; } // deleted while we walked
    fs.mkdirSync(path.dirname(to), { recursive: true });
    let done = false;
    if (prevDest) {
      const prev = path.join(prevDest, rel);
      try {
        const ps = fs.statSync(prev);
        if (ps.size === st.size && Math.abs(ps.mtimeMs - st.mtimeMs) < 2000) {
          fs.linkSync(prev, to);
          linked += 1;
          done = true;
        }
      } catch { /* not in the previous backup, or no hard links here */ }
    }
    if (!done) {
      try {
        fs.copyFileSync(from, to);
        fs.utimesSync(to, st.atime, st.mtime);
      } catch (err) {
        if (err.code === 'ENOENT') continue; // removed mid-copy
        throw err;
      }
    }
    files += 1;
    bytes += st.size;
  }
  return { files, bytes, linked };
}

function treeStats(dir) {
  let files = 0;
  let bytes = 0;
  if (!fs.existsSync(dir)) return { files, bytes };
  for (const rel of walk(dir, [])) {
    try { bytes += fs.statSync(path.join(dir, rel)).size; files += 1; } catch { /* skip */ }
  }
  return { files, bytes };
}

function sqlite() {
  // eslint-disable-next-line global-require
  return require('node:sqlite');
}

function countRows(db) {
  const counts = {};
  for (const [table] of KEY_TABLES) {
    try { counts[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n); } catch { counts[table] = null; }
  }
  return counts;
}

// --- make a backup ------------------------------------------------------------
async function makeBackup({ reason = 'manual', by = null, log = () => {} } = {}) {
  const root = backupRoot();
  assertSafeRoot(root);
  const src = dbFile();
  if (!fs.existsSync(src)) throw new Error(`Database file not found: ${src}`);
  takeLock('backup');
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  writeStatus({ running: { what: 'backup', pid: process.pid, startedAt } });
  let name = null;
  let tmp = null;
  try {
    name = newSetName(root);
    tmp = path.join(root, `.inprogress-${name}`);
    // We hold the lock, so any other half-finished folder is from a run that
    // was stopped (e.g. the PC was switched off). It is never a real backup.
    for (const n of fs.readdirSync(root)) {
      if (n.startsWith('.inprogress-') && path.join(root, n) !== tmp) fs.rmSync(path.join(root, n), { recursive: true, force: true });
    }
    fs.mkdirSync(tmp, { recursive: true });

    // 1. The database: a consistent snapshot, even while the API is writing.
    const { DatabaseSync } = sqlite();
    const out = path.join(tmp, 'teamlink.db');
    let db;
    try { db = new DatabaseSync(src, { readOnly: true }); } catch { db = new DatabaseSync(src); }
    try {
      db.exec('PRAGMA busy_timeout = 15000');
      db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
    } finally { db.close(); }
    const snap = new DatabaseSync(out, { readOnly: true });
    let counts;
    let quickCheck;
    try {
      quickCheck = String(Object.values(snap.prepare('PRAGMA quick_check').get())[0]);
      counts = countRows(snap);
    } finally { snap.close(); }
    if (quickCheck !== 'ok') throw new Error(`The database copy failed its check: ${quickCheck}`);
    log(`database copied (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);

    // 2. The file folders, hard-linking what the previous backup already has.
    const prev = listSets()[0];
    // Never copied: the backups themselves, the project, and the TEST SANDBOX's
    // own files (~/.teamlink-sandbox) unless this IS the sandbox.
    const skip = [root, REPO];
    if (!isSandbox()) skip.push(path.join(home(), '.teamlink-sandbox'));
    const files = {};
    for (const s of fileSources()) {
      // A folder inside the project would be copied from git's tree — never.
      if (inside(s.dir, REPO)) { files[s.key] = { dir: s.dir, label: s.label, files: 0, bytes: 0, skipped: 'inside the project folder' }; continue; }
      const r = copyTree(s.dir, path.join(tmp, 'files', s.key), prev ? path.join(prev.dir, 'files', s.key) : null, skip);
      files[s.key] = { dir: s.dir, label: s.label, ...r };
      log(`${s.key}: ${r.files} files${r.missing ? ' (folder does not exist yet)' : ''}`);
    }

    const manifest = {
      tool: TOOL,
      version: 1,
      name,
      createdAt: new Date().toISOString(),
      reason,
      by,
      host: os.hostname(),
      source: { db: src },
      db: { file: 'teamlink.db', bytes: fs.statSync(out).size, quickCheck, counts },
      files,
      durationMs: Date.now() - t0,
    };
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.renameSync(tmp, path.join(root, name));
    tmp = null;
    const removed = prune(log);
    const sizeBytes = manifest.db.bytes + Object.values(files).reduce((a, f) => a + (f.bytes || 0), 0);
    writeStatus({
      running: null,
      lastBackup: { ok: true, name, at: manifest.createdAt, reason, by, sizeBytes, durationMs: manifest.durationMs, removed },
    });
    return { ok: true, name, manifest, sizeBytes, removed };
  } catch (err) {
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }
    writeStatus({ running: null, lastBackup: { ok: false, at: new Date().toISOString(), reason, by, error: err.message } });
    throw err;
  } finally {
    dropLock();
  }
}

// --- restore test ---------------------------------------------------------------
async function verifyBackup({ name = null, log = () => {} } = {}) {
  const sets = listSets();
  const set = name ? sets.find((s) => s.name === name) : sets[0];
  const checkedAt = new Date().toISOString();
  if (!set) {
    const r = { ok: false, checkedAt, name, problems: [name ? `No backup called ${name}.` : 'There is no backup yet.'] };
    writeStatus({ lastVerify: r });
    return r;
  }
  const problems = [];
  const tmpDb = path.join(os.tmpdir(), `teamlink-restore-test-${process.pid}-${Date.now()}.db`);
  let counts = {};
  let integrity = null;
  try {
    // 1. "Restore" it: copy the backup to a new, separate file.
    fs.copyFileSync(path.join(set.dir, set.manifest.db.file), tmpDb);
    // 2. SQLite's own full integrity check.
    const { DatabaseSync } = sqlite();
    const db = new DatabaseSync(tmpDb, { readOnly: true });
    try { integrity = String(Object.values(db.prepare('PRAGMA integrity_check').get())[0]); } finally { db.close(); }
    if (integrity !== 'ok') problems.push(`Integrity check: ${integrity}`);
    // 3. Open it the way the app does — with Prisma — and count.
    // eslint-disable-next-line global-require
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient({ datasources: { db: { url: `file:${tmpDb.replace(/\\/g, '/')}` } } });
    try {
      for (const [table, model] of KEY_TABLES) {
        // eslint-disable-next-line no-await-in-loop
        counts[table] = await prisma[model].count();
        const want = set.manifest.db.counts ? set.manifest.db.counts[table] : null;
        if (want != null && counts[table] !== want) problems.push(`${table}: ${counts[table]} rows, expected ${want}`);
      }
      if (!counts.User) problems.push('No logins in the copy.');
    } finally { await prisma.$disconnect(); }
  } catch (err) {
    problems.push(`Could not open the copy: ${err.message}`);
  } finally {
    for (const sfx of ['', '-journal', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + sfx); } catch { /* not there */ } }
  }
  // 4. The file folders: same number of files and bytes as recorded.
  const files = {};
  for (const [key, f] of Object.entries(set.manifest.files || {})) {
    const got = treeStats(path.join(set.dir, 'files', key));
    files[key] = got;
    if ((f.files || 0) !== got.files || (f.bytes || 0) !== got.bytes) {
      problems.push(`${key}: ${got.files} files / ${got.bytes} bytes, expected ${f.files || 0} / ${f.bytes || 0}`);
    }
  }
  const r = { ok: problems.length === 0, checkedAt, name: set.name, integrity, counts, files, problems };
  try { fs.writeFileSync(path.join(set.dir, 'verify.json'), JSON.stringify(r, null, 2)); } catch { /* read-only? still report */ }
  writeStatus({ lastVerify: r });
  log(r.ok ? `restore test OK (${set.name})` : `restore test FAILED (${set.name}): ${problems.join('; ')}`);
  return r;
}

// --- what Administration → System shows -----------------------------------------
function dirBytes(dir) {
  // Hard-linked files are counted once per backup folder, so this is the
  // "if you copied it" size, not the space on disk.
  return treeStats(dir).bytes;
}

function summary() {
  const root = backupRoot();
  const status = readStatus();
  const sets = listSets().map((s) => ({
    name: s.name,
    at: s.createdAt,
    reason: s.manifest.reason,
    dbBytes: s.manifest.db.bytes,
    fileCount: Object.values(s.manifest.files || {}).reduce((a, f) => a + (f.files || 0), 0),
    sizeBytes: s.manifest.db.bytes + Object.values(s.manifest.files || {}).reduce((a, f) => a + (f.bytes || 0), 0),
    verify: s.verify ? { ok: s.verify.ok, checkedAt: s.verify.checkedAt, problems: s.verify.problems } : null,
  }));
  const running = readLock() || (childRunning() ? { what: 'backup', startedAt: new Date(lastStart).toISOString() } : null);
  // Started but its process is gone without saying how it ended: stopped.
  let lastBackup = status.lastBackup || null;
  if (!running && status.running && status.running.startedAt
      && (!lastBackup || String(lastBackup.at) < String(status.running.startedAt))) {
    lastBackup = { ok: false, at: status.running.startedAt, error: 'It was stopped before it finished (the computer or server restarted). Press "Back up now" again.' };
  }
  return {
    folder: root,
    insideRepo: inside(root, REPO),
    schedule: scheduleInfo(),
    running: running ? { what: running.what, startedAt: running.startedAt } : null,
    lastBackup,
    lastVerify: status.lastVerify || null,
    latest: sets[0] || null,
    sets,
    keep: { daily: KEEP_DAILY, weekly: KEEP_WEEKLY },
    sources: fileSources().map((s) => ({ key: s.key, label: s.label, dir: s.dir })),
    keyTables: KEY_TABLES.map(([t, , label]) => ({ table: t, label })),
  };
}

// --- run the CLI in a child process ------------------------------------------------
// The backup runs as its OWN process, started through a tiny launcher that
// exits at once. So it is not in the API's process tree: a restart of the API
// (nodemon kills the whole tree with taskkill /T on every code change) or a
// crash does not kill a backup half-way. No window is shown (windowsHide).
// "Is it running?" is the lock file (with a live pid) — plus a few seconds of
// grace after a start, before the new process has taken the lock.
let lastStart = 0;
const childRunning = () => Date.now() - lastStart < 8000;

function runChild(args) {
  const root = backupRoot();
  fs.mkdirSync(root, { recursive: true });
  const log = path.join(root, 'backup.log');
  const script = path.join(BACKEND, 'scripts', 'backup.js');
  const launcher = `
    const { spawn } = require('child_process');
    const fs = require('fs');
    const out = fs.openSync(${JSON.stringify(log)}, 'a');
    const c = spawn(process.execPath, ${JSON.stringify([script, ...args])}, {
      cwd: ${JSON.stringify(BACKEND)}, detached: true, windowsHide: true, stdio: ['ignore', out, out],
    });
    c.unref();
  `;
  lastStart = Date.now();
  const child = spawn(process.execPath, ['-e', launcher], {
    cwd: BACKEND, env: process.env, stdio: 'ignore', windowsHide: true,
  });
  child.on('error', (err) => console.warn(`[backup] could not start: ${err.message}`));
  return child;
}

// --- the in-app daily schedule ---------------------------------------------------------
function backupHour() {
  const h = Number(process.env.BACKUP_HOUR);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 2;
}
function scheduleEnabled() {
  if (isSandbox()) return false;
  return !/^(0|off|false|no)$/i.test(String(process.env.BACKUP_SCHEDULE || '').trim());
}
function scheduleInfo() {
  return {
    enabled: scheduleEnabled(),
    hour: backupHour(),
    why: isSandbox() ? 'Switched off in the test sandbox.' : (scheduleEnabled() ? null : 'Switched off with BACKUP_SCHEDULE=0.'),
  };
}

let timer = null;
function dueNow(now = new Date()) {
  if (now.getHours() < backupHour()) return false;
  const latest = listSets()[0];
  if (latest && localDay(new Date(latest.createdAt)) === localDay(now)) return false;
  if (readLock() || childRunning()) return false;
  // A backup that failed in the last hour is not retried every 10 minutes.
  const last = readStatus().lastBackup;
  if (last && !last.ok && now - new Date(last.at) < 3600 * 1000) return false;
  return true;
}

function startSchedule() {
  if (!scheduleEnabled() || timer) return;
  const tick = () => {
    try {
      if (dueNow()) {
        console.log('[backup] daily backup starting');
        runChild(['--reason', 'daily', '--notify-on-fail']);
      }
    } catch (err) { console.warn(`[backup] schedule check failed: ${err.message}`); }
  };
  // First look two minutes after boot (nodemon restarts often; the "already
  // backed up today" check makes extra looks harmless), then every 10 minutes.
  setTimeout(tick, 2 * 60 * 1000).unref();
  timer = setInterval(tick, 10 * 60 * 1000);
  timer.unref();
}

module.exports = {
  TOOL, KEY_TABLES, dbFile, backupRoot, fileSources, listSets, retentionPlan, prune,
  makeBackup, verifyBackup, summary, runChild, childRunning, readLock, startSchedule, scheduleInfo, dueNow,
  isoWeek, localDay, inside, REPO, BACKEND,
};
