// ---------------------------------------------------------------------------
// SEPARATE LOGINS ON ONE EMAIL (founder, 2026-10-21).
//
// THE IDEA
//   A login is a User row. Until now two rows could not share an email (User.email was UNIQUE). Now an Admin may add ANOTHER, completely
//   separate login for the same person: its own Login ID, its own password, its own roles and modules. Nothing is shared between siblings
//   except the mailbox the notices go to. The old single login of every employee keeps working exactly as before.
//
// WHAT THIS FILE OWNS (all additive, all safe to run on a database that has never heard of it)
//   * IDENTITY     A person signs in with their EMAIL only (founder's decision, 2026-10-21: no Login ID anywhere a person can see). When several
//                  logins share an email, the password says which one is meant; if two share the same password the person picks by role +
//                  department. User.loginId (and its counter / indexes) stay in the database as an INTERNAL technical column only: nothing shows
//                  it, nothing accepts it, no code depends on it, and it may stay empty.
//   * EMAIL STATE  is the database still forcing one login per email (User_email_key)? -> state().multiLoginOn
//   * EmployeeLogin(userId, employeeId): an extra login points at the SAME Employee record (no duplicate employee). Employee.userId stays
//                  the one primary login; HRMS screens that look an employee up by userId keep using the primary.
//   * SIGN-IN HELPERS  clean typed Login ID / email, find the accounts behind them, the "Choose your account" token (signed, 5 minutes,
//                  single use, bound to the browser), sessions an Admin has ended.
//
// The generated Prisma client does NOT know loginId or these two tables (schema.prisma is documentation until the client is regenerated),
// so everything here is plain SQL with bound parameters.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

const PREFIX = 'TL-LOGIN-';
const FIRST_NUMBER = 101;

const toNum = (v) => (typeof v === 'bigint' ? Number(v) : v);
const q = async (sql, ...p) => (await prisma.$queryRawUnsafe(sql, ...p)).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, toNum(v)])));
const run = (sql, ...p) => prisma.$executeRawUnsafe(sql, ...p);

// ---------------------------------------------------------------------------
// TYPED TEXT: tolerant, like the vendor sign-in (utils/vendorConfig.js): spaces, line breaks, zero-width characters, quotes, <angle brackets>.
// ---------------------------------------------------------------------------
const INVISIBLE = new RegExp(`[${String.fromCodePoint(0x200B)}-${String.fromCodePoint(0x200D)}${String.fromCodePoint(0xFEFF)}${String.fromCodePoint(0xAD)}${String.fromCodePoint(0x2060)}]`, 'g');
function cleanTyped(raw) {
  let s = String(raw == null ? '' : raw).replace(INVISIBLE, '').replace(new RegExp(String.fromCodePoint(0xA0), 'g'), ' ').trim();
  s = s.replace(/^[<"'‘“]+/, '').replace(/[>"'’”]+$/, '').trim();
  return s;
}
const normEmail = (raw) => cleanTyped(raw).toLowerCase();
const looksLikeEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 160;

// ---------------------------------------------------------------------------
// SELF-PROVISIONING (additive): column, unique indexes, two small tables. Runs once per process, retried after a failure.
// ---------------------------------------------------------------------------
let ensuring = null;
let failedAt = 0;
let readyFlag = false;

async function doEnsure() {
  const cols = await q('PRAGMA table_info("User")');
  if (!cols.length) throw new Error('The User table does not exist.');
  if (!cols.some((c) => c.name === 'loginId')) await run('ALTER TABLE "User" ADD COLUMN "loginId" TEXT');
  // Unique, and unique when typed in another case: both must hold. NULLs (legacy rows not yet numbered) never clash.
  await run('CREATE UNIQUE INDEX IF NOT EXISTS "User_loginId_key" ON "User"("loginId")');
  await run('CREATE UNIQUE INDEX IF NOT EXISTS "User_loginId_lower_key" ON "User"(lower("loginId"))');
  // Looking an account up by the email it was typed with: a plain (NOT unique) index. Harmless while emails are still unique.
  await run('CREATE INDEX IF NOT EXISTS "User_email_lower_idx" ON "User"(lower(trim("email")))');
  await run('CREATE TABLE IF NOT EXISTS "EmployeeLogin" ("userId" TEXT NOT NULL PRIMARY KEY, "employeeId" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "createdById" TEXT)');
  await run('CREATE INDEX IF NOT EXISTS "EmployeeLogin_employeeId_idx" ON "EmployeeLogin"("employeeId")');
  await run('CREATE TABLE IF NOT EXISTS "LoginIdCounter" ("id" INTEGER NOT NULL PRIMARY KEY, "last" INTEGER NOT NULL)');
  await run(`INSERT OR IGNORE INTO "LoginIdCounter"("id","last") VALUES (1, ${FIRST_NUMBER - 1})`);
  // A restored backup may hold higher numbers than the counter: never hand out a number that is already in use.
  await run(`UPDATE "LoginIdCounter" SET "last" = MAX("last", (SELECT COALESCE(MAX(CAST(SUBSTR("loginId", ${PREFIX.length + 1}) AS INTEGER)), 0) FROM "User" WHERE "loginId" LIKE '${PREFIX}%')) WHERE "id" = 1`);
}

function ensure() {
  if (ensuring) return ensuring;
  if (failedAt && Date.now() - failedAt < 20000) return Promise.reject(new Error('Login set-up is waiting to retry.'));
  ensuring = doEnsure().then(() => { readyFlag = true; failedAt = 0; }).catch((err) => {
    ensuring = null; failedAt = Date.now(); readyFlag = false;
    // eslint-disable-next-line no-console
    console.error('[login-accounts] set-up failed: %s', err && err.message);
    throw err;
  });
  return ensuring;
}
const isReady = () => readyFlag;
// Tests / the upgrade: forget what was learned.
function resetForTests() { ensuring = null; failedAt = 0; readyFlag = false; metaCache.clear(); stateCache = null; }

// ---------------------------------------------------------------------------
// DATABASE STATE: does the database still force one login per email?
// ---------------------------------------------------------------------------
let stateCache = null;
async function emailIndex() {
  const idx = await q('PRAGMA index_list("User")');
  for (const i of idx) {
    if (!i.unique || i.origin === 'pk') continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const cols = await q(`PRAGMA index_info("${String(i.name).replace(/"/g, '')}")`);
    if (cols.length === 1 && cols[0].name === 'email') {
      // origin 'c' = CREATE UNIQUE INDEX (can be dropped); 'u' = UNIQUE written inside CREATE TABLE (the table has to be rebuilt).
      return { unique: true, name: i.name, kind: i.origin === 'u' ? 'inline' : 'standalone' };
    }
  }
  return { unique: false, name: null, kind: 'none' };
}
async function state({ fresh = false } = {}) {
  if (!fresh && stateCache && Date.now() - stateCache.at < 10000) return stateCache.v;
  const index = await emailIndex();
  const v = { multiLoginOn: !index.unique, emailIndex: index };
  stateCache = { at: Date.now(), v };
  return v;
}
const forgetState = () => { stateCache = null; };

// ---------------------------------------------------------------------------
// WHICH ACCOUNT(S) DOES THIS TYPED TEXT POINT AT?
// ---------------------------------------------------------------------------
// Full User rows (the generated client's shape), oldest first.
async function usersByIds(ids) {
  if (!ids.length) return [];
  const rows = await prisma.user.findMany({ where: { id: { in: ids } } });
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows.sort((a, b) => order.get(a.id) - order.get(b.id));
}
async function accountsByEmail(email) {
  const e = normEmail(email);
  if (!e) return [];
  const rows = await q('SELECT "id" FROM "User" WHERE lower(trim("email")) = ? ORDER BY "createdAt", "id"', e);
  return usersByIds(rows.map((r) => r.id));
}
// The accounts an email means, oldest first. (A typed "TL-LOGIN-..." is just an email nobody has.)
async function resolveIdentifier(raw) {
  const identifier = normEmail(raw);
  if (!identifier) return { kind: 'none', identifier: '', accounts: [] };
  return { kind: 'email', identifier, accounts: await accountsByEmail(identifier) };
}

// ---------------------------------------------------------------------------
// LABELS: what an Admin or a person recognises an account by. Role and product only - no name, phone or other email.
// ---------------------------------------------------------------------------
const NO_ROLE = 'NONE';
const named = (v) => (v && v !== NO_ROLE ? v : null);
function roleText(code) {
  // eslint-disable-next-line global-require
  return require('./passwordReset').roleText(code);
}
const PRODUCT_NAME = { ats: 'ATS', hrms: 'HRMS', accounts: 'Accounts' };
// 'Recruiter (ATS)', 'Accountant (Accounts)', 'HR (HRMS)', 'Admin'. A user row (generated client shape) in, text out.
function roleLabelOf(user) {
  if (!user) return '';
  if (['SUPER_ADMIN', 'ADMIN'].includes(user.role)) return roleText(user.role);
  if (['CLIENT', 'CANDIDATE'].includes(user.role)) return roleText(user.role);
  const parts = [];
  [['ats', user.atsAccess, user.atsRole], ['hrms', user.hrmsAccess, user.hrmsRole], ['accounts', user.accountsAccess, user.accountsRole]].forEach(([p, on, role]) => {
    if (!on) return;
    const r = named(role) || user.role;
    if (r) parts.push(`${roleText(r)} (${PRODUCT_NAME[p]})`);
  });
  return parts.length ? parts.join(' + ') : roleText(user.role);
}

// ---------------------------------------------------------------------------
// WHO IS BEHIND THIS ACCOUNT: the Employee record an extra login is linked to. Cached for a few seconds because the identity is resolved on
// every request.
// ---------------------------------------------------------------------------
const metaCache = new Map();
async function metaOf(userId) {
  if (!userId) return { linkedEmployeeId: null };
  const c = metaCache.get(userId);
  if (c && Date.now() - c.at < 20000) return c.v;
  let v = { linkedEmployeeId: null };
  try {
    await ensure();
    const r = (await q('SELECT (SELECT el."employeeId" FROM "EmployeeLogin" el WHERE el."userId" = u."id") AS linkedEmployeeId FROM "User" u WHERE u."id" = ?', userId))[0];
    if (r) v = { linkedEmployeeId: r.linkedEmployeeId || null };
    if (metaCache.size > 5000) metaCache.clear();
    metaCache.set(userId, { at: Date.now(), v });
  } catch { /* the login keeps working without these two extras */ }
  return v;
}
const forget = (userId) => { if (userId) metaCache.delete(userId); else metaCache.clear(); };

async function linkEmployee(userId, employeeId, byId = null) {
  await ensure();
  await run('INSERT OR REPLACE INTO "EmployeeLogin"("userId","employeeId","createdById") VALUES (?,?,?)', userId, employeeId, byId);
  forget(userId);
}
// The extra logins linked to an Employee record (not the primary one).
async function extraLoginsOf(employeeId) {
  try { await ensure(); } catch { return []; }
  return q('SELECT "userId" FROM "EmployeeLogin" WHERE "employeeId" = ?', employeeId).then((r) => r.map((x) => x.userId));
}
async function employeeIdsOfUsers(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  try {
    await ensure();
    const rows = await q(`SELECT "userId", "employeeId" FROM "EmployeeLogin" WHERE "userId" IN (${ids.map(() => '?').join(',')})`, ...ids);
    return new Map(rows.map((r) => [r.userId, r.employeeId]));
  } catch { return new Map(); }
}

// ---------------------------------------------------------------------------
// WHAT AN ADMIN SEES FOR AN EMAIL: role, department, employee, status, created date of every login on it. Admin-only callers.
// (The internal account id is only there so a button acts on the right row.) Oldest first = "Login 1", "Login 2" ...
// ---------------------------------------------------------------------------
const stripProduct = (label) => String(label || '').replace(/ \((ATS|HRMS|Accounts)\)/g, '');
async function summariesFor(users) {
  if (!users.length) return [];
  try { await ensure(); } catch { /* the extra-login links just read as missing */ }
  const ids = users.map((u) => u.id);
  const links = await employeeIdsOfUsers(ids);
  const primary = await prisma.employee.findMany({ where: { userId: { in: ids } }, select: { id: true, userId: true, name: true, employeeCode: true, department: true } });
  const primaryBy = new Map(primary.map((e) => [e.userId, e]));
  const extraEmpIds = [...new Set([...links.values()])];
  const extraEmps = extraEmpIds.length ? await prisma.employee.findMany({ where: { id: { in: extraEmpIds } }, select: { id: true, name: true, employeeCode: true, department: true } }) : [];
  const extraBy = new Map(extraEmps.map((e) => [e.id, e]));
  const rows = users.map((u) => {
    const emp = primaryBy.get(u.id) || extraBy.get(links.get(u.id)) || null;
    return {
      id: u.id,
      role: roleLabelOf(u),
      shortRole: stripProduct(roleLabelOf(u)),
      department: (emp && emp.department) || u.atsDepartment || null,
      employeeName: emp ? emp.name : null,
      employeeCode: emp ? emp.employeeCode : null,
      employeeRecordId: emp ? emp.id : null,
      isPrimary: primaryBy.has(u.id),
      status: u.status || 'Active',
      createdAt: u.createdAt,
    };
  });
  // "Recruiter - Education"; when two logins read the same, "... (Login 1)" / "(Login 2)" by creation order.
  const base = (r) => `${r.role}${r.department ? ` · ${r.department}` : ''}`;
  const count = new Map();
  rows.forEach((r) => count.set(base(r), (count.get(base(r)) || 0) + 1));
  const seen = new Map();
  rows.forEach((r) => {
    const b = base(r);
    const n = (seen.get(b) || 0) + 1; seen.set(b, n);
    r.label = count.get(b) > 1 ? `${b} (Login ${n})` : b;
    const sb = `${r.shortRole}${r.department ? ` (${r.department})` : ''}`;
    r.mailLabel = rows.filter((x) => `${x.shortRole}${x.department ? ` (${x.department})` : ''}` === sb).length > 1 ? `${sb} - Login ${n}` : sb;
  });
  return rows;
}

// ---------------------------------------------------------------------------
// A NON-BLOCKING HINT at set-password time: is this password already the one of another login on the same email? (Then signing in with the
// email would have to ask "which login?".) Only somebody holding that login's own link can ask, and the answer is just yes / no.
// ---------------------------------------------------------------------------
async function passwordUsedByOtherLogin(user, password) {
  const bcrypt = require('bcryptjs'); // eslint-disable-line global-require
  const others = (await accountsByEmail(user.email)).filter((u) => u.id !== user.id);
  for (const o of others) {
    // eslint-disable-next-line no-await-in-loop
    if (await bcrypt.compare(String(password || ''), o.passwordHash)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// "CHOOSE YOUR ACCOUNT" TOKEN. Signed (HMAC), lists only the accounts whose password matched (by position), lasts 5 minutes, works once (the claim is a unique AppSetting row, so a
// restart does not reopen it), and only for the same browser/address that proved the password.
// ---------------------------------------------------------------------------
const SEL_TTL_MS = 5 * 60 * 1000;
const SEL_KEY = 'loginsel:';
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const selKey = () => crypto.createHash('sha256').update(`${process.env.JWT_SECRET || ''}|login-select`).digest();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function bindOf(req) {
  // eslint-disable-next-line global-require
  const ip = require('./clientIp').ipOf(req);
  return sha(`${String((req && req.headers && req.headers['user-agent']) || '').slice(0, 200)}|${ip}`).slice(0, 32);
}
// A short fingerprint of an account's CURRENT password hash: if the password changes (a reset, a change) before the person picks, the choice is void.
const fingerprint = (passwordHash) => crypto.createHmac('sha256', selKey()).update(String(passwordHash || '')).digest('base64url').slice(0, 16);
// entries: [{ id, passwordHash }] in the order they are shown to the person
function makeSelectionToken(entries, req, identifier) {
  const payload = {
    v: 1, jti: crypto.randomBytes(16).toString('hex'), l: entries.map((e) => e.id), f: entries.map((e) => fingerprint(e.passwordHash)),
    b: bindOf(req), i: sha(identifier || '').slice(0, 16), exp: Date.now() + SEL_TTL_MS,
  };
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac('sha256', selKey()).update(body).digest());
  return { token: `${body}.${sig}`, expiresAt: new Date(payload.exp) };
}
function readSelectionToken(token, req) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig || body.length > 2000) return { ok: false, code: 'invalid' };
  const want = crypto.createHmac('sha256', selKey()).update(body).digest();
  let got;
  try { got = Buffer.from(sig, 'base64url'); } catch { return { ok: false, code: 'invalid' }; }
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { ok: false, code: 'invalid' };
  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return { ok: false, code: 'invalid' }; }
  if (!p || p.v !== 1 || !Array.isArray(p.l) || !Array.isArray(p.f) || !p.jti) return { ok: false, code: 'invalid' };
  if (Number(p.exp) < Date.now()) return { ok: false, code: 'expired' };
  if (p.b !== bindOf(req)) return { ok: false, code: 'invalid' };
  return { ok: true, payload: p };
}
// pick = the position (0, 1, ...) of the account in the list shown.
// -> { ok, userId, fp } or { ok:false, code }. Burns the token when it is accepted. The caller compares fp with fingerprint(current hash).
async function redeemSelectionToken(token, pick, req) {
  const read = readSelectionToken(token, req);
  if (!read.ok) return read;
  const at = /^\d{1,2}$/.test(String(pick)) ? Number(pick) : -1;
  if (at < 0 || at >= read.payload.l.length) return { ok: false, code: 'not_in_list' };
  try {
    await prisma.appSetting.create({ data: { key: SEL_KEY + read.payload.jti, value: JSON.stringify({ at: new Date().toISOString() }) } });
  } catch { return { ok: false, code: 'used' }; }
  prisma.appSetting.deleteMany({ where: { key: { startsWith: SEL_KEY }, updatedAt: { lt: new Date(Date.now() - 86400000) } } }).catch(() => {});
  return { ok: true, userId: read.payload.l[at], fp: read.payload.f[at] };
}

// ---------------------------------------------------------------------------
// SESSIONS AN ADMIN HAS ENDED ("Switch off / Sign out this login"). Per account: AppSetting `loginrevoke:<userId>` = the moment.
// A token signed before that moment is refused; signing in again after it works (once the login is switched on).
// ---------------------------------------------------------------------------
const REVOKE_KEY = 'loginrevoke:';
const revokeCache = new Map();
async function revokedAtOf(userId) {
  const c = revokeCache.get(userId);
  if (c && Date.now() - c.at < 10000) return c.t;
  const row = await prisma.appSetting.findUnique({ where: { key: REVOKE_KEY + userId } }).catch(() => null);
  const t = row ? Number(row.value) || 0 : 0;
  if (revokeCache.size > 5000) revokeCache.clear();
  revokeCache.set(userId, { at: Date.now(), t });
  return t;
}
async function tokenIsRevoked(claims) {
  if (!claims || !claims.id || !claims.iat) return false;
  const t = await revokedAtOf(claims.id);
  // Tokens signed by sign-in carry the exact millisecond (tms); older kinds only the second.
  const issued = Number(claims.tms) || claims.iat * 1000;
  return t > 0 && issued < t;
}
async function revokeSessions(userId) {
  const mark = Date.now();
  await prisma.appSetting.upsert({ where: { key: REVOKE_KEY + userId }, create: { key: REVOKE_KEY + userId, value: String(mark) }, update: { value: String(mark) } });
  revokeCache.delete(userId);
  return mark;
}

module.exports = {
  cleanTyped, normEmail, looksLikeEmail,
  ensure, isReady, resetForTests, state, forgetState, emailIndex,
  usersByIds, accountsByEmail, resolveIdentifier,
  roleLabelOf, stripProduct, summariesFor, passwordUsedByOtherLogin,
  metaOf, forget, linkEmployee, extraLoginsOf, employeeIdsOfUsers,
  makeSelectionToken, readSelectionToken, redeemSelectionToken, fingerprint, SEL_TTL_MS,
  tokenIsRevoked, revokeSessions,
  q, run,
};
