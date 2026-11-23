// ---------------------------------------------------------------------------
// THE CREDENTIALS VAULT (founder 2026-11-21: "The Naukri logins, Shine logins, HRMS logins, Hostinger etc. that employees have - all
// such login & password credentials must be stored in one place. The data is in an Excel sheet; it must be imported. Any kind of login.")
//
// Administration -> Company Setup -> Credentials vault (frontend pages/admin/CredentialsVault.jsx). Server: routes/credentialVault.js.
//
// SECRETS
//   The password and the extra secrets (2FA recovery codes, PIN, security answers, anything else) are AES-256-GCM ciphertext at rest,
//   written by utils/secrets.js with INTEGRATION_SECRET_KEY - the same crypto the Integrations store uses, no second scheme. Without the
//   key nothing secret can be saved (the save is refused with the variable's name) and nothing can be read back.
//   A secret leaves the server ONLY from reveal() (one value, one credential, after a fresh password check) and from the export WITH
//   passwords (re-auth + the words "I understand"). No list, preview, history, audit row, log line or error message carries one.
//
// WHO
//   Nobody but the real Super Admin by default (not an HR-super delegate, not an Admin). The Super Admin grants it:
//     * per ROLE in Role Catalog: Administration -> "Credentials Vault"
//         view = the list (passwords hidden) · approve = Show / Copy a password · create / edit / delete / assign = manage
//         configure = import from Excel · export = export (with passwords also needs approve)
//     * per PERSON on the vault's own Access tab (CredentialVaultGrant), for one login without changing a whole role.
//   A credential may also say "the assigned employee can see their own" (OFF by default): that employee then sees and may reveal only
//   the credentials assigned to them that carry the switch, nothing else.
//
// TABLES (raw SQL, made on first use): Credential, CredentialAccess (who opened / copied / changed what), CredentialImportBatch,
//   CredentialVaultReauth (5-minute re-auth tickets, hashed), CredentialVaultLock (wrong-password count / 15-minute lock),
//   CredentialVaultGrant (per-person rights).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');
const prisma = require('../db');
const secrets = require('./secrets');
const { parseCameDate } = require('./importDates');

const FEATURE = 'Credentials Vault';
const REAUTH_MS = 5 * 60 * 1000;
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60 * 1000;
const SHOW_SECONDS = 30;
const EXPIRING_DAYS = 30;
const ROTATE_DAYS = 90;
const REVEAL_LIMIT = 30; // reveals per person ...
const REVEAL_WINDOW_MS = 10 * 60 * 1000; // ... in ten minutes
const MAX_ROWS = 2000;
const MAX_BYTES = 5 * 1024 * 1024;
const PREVIEW_TTL_MS = 60 * 60 * 1000;
const CONFIRM_WORDS = 'I understand';
const MASK = '••••••••';

const PLATFORMS = ['Naukri', 'Shine', 'foundit', 'LinkedIn', 'Indeed', 'HRMS', 'Hostinger', 'cPanel', 'Google Workspace', 'Gmail', 'Microsoft 365', 'Zoho',
  'WhatsApp Business', 'Meta', 'Domain registrar', 'Bank portal', 'GST portal', 'Other'];
const PLATFORM_ALIASES = {
  naukricom: 'Naukri', naukri: 'Naukri', shinecom: 'Shine', shine: 'Shine', foundit: 'foundit', founditin: 'foundit', monster: 'foundit', monsterindia: 'foundit',
  linkedin: 'LinkedIn', linkedinrecruiter: 'LinkedIn', indeed: 'Indeed', hrms: 'HRMS', hostinger: 'Hostinger', cpanel: 'cPanel', gmail: 'Gmail',
  googleworkspace: 'Google Workspace', gsuite: 'Google Workspace', google: 'Google Workspace', microsoft365: 'Microsoft 365', office365: 'Microsoft 365', o365: 'Microsoft 365', outlook: 'Microsoft 365',
  zoho: 'Zoho', zohomail: 'Zoho', whatsappbusiness: 'WhatsApp Business', whatsapp: 'WhatsApp Business', meta: 'Meta', facebook: 'Meta', metabusiness: 'Meta',
  domainregistrar: 'Domain registrar', godaddy: 'Domain registrar', bankportal: 'Bank portal', netbanking: 'Bank portal', gstportal: 'GST portal', gst: 'GST portal', other: 'Other',
};

const hkey = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const squash = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const low = (v) => squash(v).toLowerCase();
const nowIso = () => new Date().toISOString();
const newId = (p = 'cv') => `${p}${Date.now().toString(36)}${crypto.randomBytes(8).toString('hex')}`;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const num = (v) => Number(v || 0);
const IST = 330 * 60000;
const todayIst = () => new Date(Date.now() + IST).toISOString().slice(0, 10);
const FAR = Date.parse('2999-01-01T00:00:00Z');

class VaultError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

function canonicalPlatform(raw) {
  const s = squash(raw).slice(0, 80);
  if (!s) return '';
  const k = hkey(s);
  if (PLATFORM_ALIASES[k]) return PLATFORM_ALIASES[k];
  const hit = PLATFORMS.find((p) => hkey(p) === k);
  return hit || s;
}
const platformKeyOf = (p) => hkey(canonicalPlatform(p));
const usernameKeyOf = (u) => low(u);

// ---- tables ----------------------------------------------------------------------------------------------------------
const TABLES = [
  `CREATE TABLE IF NOT EXISTS "Credential" ("id" TEXT PRIMARY KEY, "platform" TEXT NOT NULL, "platformKey" TEXT NOT NULL, "label" TEXT, "loginUrl" TEXT,
    "username" TEXT NOT NULL, "usernameKey" TEXT NOT NULL, "passwordEnc" TEXT, "extraEnc" TEXT, "extraKinds" TEXT, "assignedEmployeeIds" TEXT NOT NULL DEFAULT '[]',
    "department" TEXT, "ownerEmployeeId" TEXT, "ownerName" TEXT, "notes" TEXT, "renewalDate" TEXT, "lastRotatedAt" TEXT, "status" TEXT NOT NULL DEFAULT 'active',
    "employeeCanSee" INTEGER NOT NULL DEFAULT 0, "importBatchId" TEXT, "createdById" TEXT, "createdByName" TEXT, "createdAt" TEXT NOT NULL,
    "updatedById" TEXT, "updatedByName" TEXT, "updatedAt" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "Credential_key" ON "Credential" ("platformKey", "usernameKey")',
  'CREATE INDEX IF NOT EXISTS "Credential_batch" ON "Credential" ("importBatchId")',
  `CREATE TABLE IF NOT EXISTS "CredentialAccess" ("id" TEXT PRIMARY KEY, "credentialId" TEXT, "credentialName" TEXT, "userId" TEXT, "userName" TEXT,
    "action" TEXT NOT NULL, "detail" TEXT, "ip" TEXT, "at" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "CredentialAccess_cred" ON "CredentialAccess" ("credentialId", "at")',
  'CREATE INDEX IF NOT EXISTS "CredentialAccess_at" ON "CredentialAccess" ("at")',
  `CREATE TABLE IF NOT EXISTS "CredentialImportBatch" ("id" TEXT PRIMARY KEY, "byUserId" TEXT NOT NULL, "byName" TEXT, "fileName" TEXT, "createdAt" TEXT NOT NULL,
    "status" TEXT NOT NULL, "totalRows" INTEGER NOT NULL DEFAULT 0, "readyRows" INTEGER NOT NULL DEFAULT 0, "choiceRows" INTEGER NOT NULL DEFAULT 0,
    "refusedRows" INTEGER NOT NULL DEFAULT 0, "createdRows" INTEGER NOT NULL DEFAULT 0, "appliedAt" TEXT, "undoneAt" TEXT, "undoneByName" TEXT,
    "undoneRows" INTEGER NOT NULL DEFAULT 0, "keptRows" INTEGER NOT NULL DEFAULT 0, "payload" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "CredentialVaultReauth" ("tokenHash" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "expiresAt" TEXT NOT NULL, "createdAt" TEXT NOT NULL, "ip" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "CredentialVaultLock" ("userId" TEXT PRIMARY KEY, "failed" INTEGER NOT NULL DEFAULT 0, "lockedUntil" TEXT, "lastFailAt" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "CredentialVaultGrant" ("userId" TEXT PRIMARY KEY, "rights" TEXT NOT NULL, "byName" TEXT, "at" TEXT NOT NULL)`,
];
let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      for (const sql of TABLES) await prisma.$executeRawUnsafe(sql); // eslint-disable-line no-await-in-loop
      return true;
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}
const q = async (sql, ...args) => { await ensure(); return prisma.$queryRawUnsafe(sql, ...args); };
const x = async (sql, ...args) => { await ensure(); return prisma.$executeRawUnsafe(sql, ...args); };

// ---- rights ----------------------------------------------------------------------------------------------------------
const RIGHT_KEYS = ['view', 'reveal', 'create', 'edit', 'delete', 'assign', 'import', 'export'];
const CATALOG_ACTION = { view: 'view', reveal: 'approve', create: 'create', edit: 'edit', delete: 'delete', assign: 'assign', import: 'configure', export: 'export' };
const none = () => ({ ...Object.fromEntries(RIGHT_KEYS.map((k) => [k, false])), settings: false, realSuper: false, ownOnly: false });
const isRealSuper = (u) => !!u && u.role === 'SUPER_ADMIN' && !u.hrSuper;

async function personGrant(userId) {
  const rows = await q('SELECT "rights" FROM "CredentialVaultGrant" WHERE "userId" = ?', userId);
  if (!rows.length) return null;
  try { return JSON.parse(rows[0].rights) || null; } catch { return null; }
}

// What this login may do in the vault. Everything not granted here answers 403.
async function rightsFor(user) {
  const out = none();
  if (!user || !user.id || user.formerAccess) return out;
  if (user.status && user.status !== 'Active') return out;
  const { isExternalLogin, can } = require('./permissions'); // eslint-disable-line global-require
  if (isExternalLogin(user) || ['VENDOR', 'PARTNER'].includes(user.role)) return out;
  if (isRealSuper(user)) {
    RIGHT_KEYS.forEach((k) => { out[k] = true; });
    out.settings = true; out.realSuper = true;
    return out;
  }
  // An HR-super delegate is SEEN as a Super Admin by can(): the Role Catalog cannot be asked for them, so only a per-person grant counts.
  if (!user.hrSuper) {
    for (const k of RIGHT_KEYS) {
      // eslint-disable-next-line no-await-in-loop
      out[k] = !!(await can(user, null, 'administration', FEATURE, CATALOG_ACTION[k]).catch(() => false));
    }
  }
  const grant = await personGrant(user.id).catch(() => null);
  if (grant) {
    if (grant.view) out.view = true;
    if (grant.reveal) out.reveal = true;
    if (grant.manage) { out.create = true; out.edit = true; out.delete = true; out.assign = true; }
    if (grant.import) out.import = true;
    if (grant.export) out.export = true;
  }
  // every other right works only on top of seeing the list
  if (!out.view) RIGHT_KEYS.forEach((k) => { out[k] = false; });
  return out;
}

async function ownVisibleCount(user) {
  if (!user || !user.employeeId) return 0;
  const r = await q('SELECT COUNT(*) AS n FROM "Credential" WHERE "employeeCanSee" = 1 AND "status" = \'active\' AND "assignedEmployeeIds" LIKE ?', `%"${user.employeeId}"%`);
  return num(r[0] && r[0].n);
}

// For /auth/me and the menu: may this login open the vault, and as what.
async function menuRightsFor(user) {
  const r = await rightsFor(user);
  if (r.view) return { open: true, own: false, ...r };
  const own = await ownVisibleCount(user).catch(() => 0);
  return own ? { open: true, own: true, ...none(), ownOnly: true } : null;
}

// ---- the access log --------------------------------------------------------------------------------------------------
async function logAccess(user, cred, action, detail, ip) {
  try {
    await x('INSERT INTO "CredentialAccess" ("id","credentialId","credentialName","userId","userName","action","detail","ip","at") VALUES (?,?,?,?,?,?,?,?,?)',
      newId('ca'), cred ? cred.id : null, cred ? nameOf(cred) : null, user ? user.id : null, user ? (user.name || user.email || null) : null,
      action, detail ? String(detail).slice(0, 500) : null, ip ? String(ip).slice(0, 60) : null, nowIso());
  } catch (e) {
    console.error('[vault] could not record access: %s', e && e.message); // eslint-disable-line no-console
  }
  try {
    const { logAudit } = require('./audit'); // eslint-disable-line global-require
    await logAudit({
      userId: user ? user.id : null, actorName: user ? user.name : null, action: `Credentials vault: ${ACTION_WORDS[action] || action}`,
      entity: 'Credential', entityId: cred ? cred.id : null, toValue: [cred ? nameOf(cred) : null, detail, ip ? `IP ${ip}` : null].filter(Boolean).join(' · ').slice(0, 900),
    });
  } catch { /* logAudit never throws; belt and braces */ }
}
const ACTION_WORDS = {
  show_password: 'password shown', copy_password: 'password copied', show_extra: 'extra secret shown', copy_extra: 'extra secret copied',
  create: 'login added', edit: 'login changed', delete: 'login deleted', disable: 'login disabled', enable: 'login enabled', assign: 'login assigned',
  import: 'logins imported', undo_import: 'import undone', export: 'exported (no passwords)', export_with_passwords: 'exported WITH passwords',
  reauth_ok: 'password check passed', reauth_failed: 'wrong password at the vault check', locked: 'reveals locked for 15 minutes', grant: 'access changed',
};
const nameOf = (c) => [c.platform, c.label || c.username].filter(Boolean).join(' - ').slice(0, 200);

// ---- re-auth ---------------------------------------------------------------------------------------------------------
async function lockOf(userId) {
  const rows = await q('SELECT * FROM "CredentialVaultLock" WHERE "userId" = ?', userId);
  const r = rows[0];
  if (!r) return { failed: 0, lockedUntil: null };
  const until = r.lockedUntil && Date.parse(r.lockedUntil) > Date.now() ? r.lockedUntil : null;
  return { failed: until ? num(r.failed) : (r.lockedUntil ? 0 : num(r.failed)), lockedUntil: until };
}
const lockedError = (until) => {
  const mins = Math.max(1, Math.ceil((Date.parse(until) - Date.now()) / 60000));
  return new VaultError(423, `Too many wrong passwords. Showing and copying passwords is locked for ${mins} more minute${mins === 1 ? '' : 's'}.`, { code: 'VAULT_LOCKED', lockedUntil: until });
};

async function reauth(user, password, ip) {
  const lock = await lockOf(user.id);
  if (lock.lockedUntil) throw lockedError(lock.lockedUntil);
  const row = await prisma.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } });
  const ok = !!(password && row && row.passwordHash && await bcrypt.compare(String(password), row.passwordHash).catch(() => false));
  if (!ok) {
    const failed = lock.failed + 1;
    const lockNow = failed >= LOCK_AFTER;
    const until = lockNow ? new Date(Date.now() + LOCK_MS).toISOString() : null;
    await x(`INSERT INTO "CredentialVaultLock" ("userId","failed","lockedUntil","lastFailAt") VALUES (?,?,?,?)
      ON CONFLICT("userId") DO UPDATE SET "failed" = excluded."failed", "lockedUntil" = excluded."lockedUntil", "lastFailAt" = excluded."lastFailAt"`,
    user.id, failed, until, nowIso());
    await logAccess(user, null, 'reauth_failed', `wrong password ${failed} of ${LOCK_AFTER}`, ip);
    if (lockNow) {
      await x('DELETE FROM "CredentialVaultReauth" WHERE "userId" = ?', user.id);
      await logAccess(user, null, 'locked', 'after 5 wrong passwords', ip);
      throw lockedError(until);
    }
    const left = LOCK_AFTER - failed;
    throw new VaultError(401, `That is not your TeamLink password. ${left} ${left === 1 ? 'try' : 'tries'} left before a 15-minute lock.`, { code: 'REAUTH_WRONG', triesLeft: left });
  }
  await x('DELETE FROM "CredentialVaultLock" WHERE "userId" = ?', user.id);
  await x('DELETE FROM "CredentialVaultReauth" WHERE "expiresAt" < ?', nowIso());
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + REAUTH_MS).toISOString();
  await x('INSERT INTO "CredentialVaultReauth" ("tokenHash","userId","expiresAt","createdAt","ip") VALUES (?,?,?,?,?)', sha(token), user.id, expiresAt, nowIso(), ip || null);
  await logAccess(user, null, 'reauth_ok', null, ip);
  return { token, expiresAt, minutes: REAUTH_MS / 60000 };
}

async function checkReauth(user, token) {
  const lock = await lockOf(user.id);
  if (lock.lockedUntil) throw lockedError(lock.lockedUntil);
  const need = () => new VaultError(401, 'Enter your TeamLink password again to show or copy a password (it stays open for 5 minutes).', { code: 'REAUTH_NEEDED' });
  if (!token || typeof token !== 'string' || token.length > 200) throw need();
  const rows = await q('SELECT * FROM "CredentialVaultReauth" WHERE "tokenHash" = ?', sha(token));
  const r = rows[0];
  if (!r || r.userId !== user.id || Date.parse(r.expiresAt) <= Date.now()) throw need();
  return true;
}

// ---- reading / shaping rows -------------------------------------------------------------------------------------------
const parseIds = (s) => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };

async function employeesById(ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  const rows = await prisma.employee.findMany({ where: { id: { in: list } }, select: { id: true, name: true, employeeCode: true, department: true, userId: true, employmentStatus: true } });
  return new Map(rows.map((e) => [e.id, e]));
}

const dayDiff = (day) => Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${todayIst()}T00:00:00Z`)) / 86400000);
function dueOf(row) {
  const out = { renewalState: null, daysLeft: null, rotateDue: false, rotateDays: null };
  if (row.renewalDate && /^\d{4}-\d{2}-\d{2}$/.test(row.renewalDate)) {
    out.daysLeft = dayDiff(row.renewalDate);
    if (out.daysLeft < 0) out.renewalState = 'expired';
    else if (out.daysLeft <= EXPIRING_DAYS) out.renewalState = 'soon';
  }
  const since = row.lastRotatedAt || row.createdAt;
  if (since) {
    out.rotateDays = Math.floor((Date.now() - Date.parse(since)) / 86400000);
    out.rotateDue = row.status === 'active' && !!row.passwordEnc && out.rotateDays >= ROTATE_DAYS;
  }
  return out;
}

// The ONLY shape a credential leaves the server in, outside reveal(). No ciphertext, no plaintext: a mask and two booleans.
function publicRow(row, emp) {
  const ids = parseIds(row.assignedEmployeeIds);
  return {
    id: row.id,
    platform: row.platform,
    label: row.label || '',
    loginUrl: row.loginUrl || '',
    username: row.username,
    hasPassword: !!row.passwordEnc,
    password: row.passwordEnc ? MASK : '',
    hasExtra: !!row.extraEnc,
    extraKinds: row.extraEnc ? (row.extraKinds || 'Extra secret') : '',
    assigned: ids.map((id) => { const e = emp.get(id); return e ? { id, name: e.name, code: e.employeeCode, department: e.department || '' } : { id, name: '(removed employee)', code: '', department: '' }; }),
    department: row.department || '',
    owner: row.ownerEmployeeId ? { id: row.ownerEmployeeId, name: (emp.get(row.ownerEmployeeId) || {}).name || row.ownerName || '' } : (row.ownerName ? { id: null, name: row.ownerName } : null),
    notes: row.notes || '',
    renewalDate: row.renewalDate || '',
    lastRotatedAt: row.lastRotatedAt || '',
    status: row.status,
    employeeCanSee: num(row.employeeCanSee) === 1,
    imported: !!row.importBatchId,
    createdByName: row.createdByName || '', createdAt: row.createdAt,
    updatedByName: row.updatedByName || '', updatedAt: row.updatedAt,
    ...dueOf(row),
  };
}

async function shape(rows) {
  const ids = rows.flatMap((r) => [...parseIds(r.assignedEmployeeIds), r.ownerEmployeeId]);
  const emp = await employeesById(ids);
  return rows.map((r) => publicRow(r, emp));
}

const isOwn = (user, row) => !!user.employeeId && num(row.employeeCanSee) === 1 && row.status === 'active' && parseIds(row.assignedEmployeeIds).includes(user.employeeId);

async function visibleRows(user, rights) {
  if (rights.view) return q('SELECT * FROM "Credential" ORDER BY lower("platform"), lower(coalesce("label", "username"))');
  if (!user.employeeId) return [];
  const rows = await q('SELECT * FROM "Credential" WHERE "employeeCanSee" = 1 AND "status" = \'active\' AND "assignedEmployeeIds" LIKE ? ORDER BY lower("platform")', `%"${user.employeeId}"%`);
  return rows.filter((r) => isOwn(user, r));
}

// The list filters, used by the export (the screen filters the same way in the browser).
function applyFilters(list, f = {}) {
  const set = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : (v ? String(v).split(',').filter(Boolean) : []));
  const platforms = set(f.platform); const depts = set(f.department); const emps = set(f.employee); const statuses = set(f.status);
  const text = low(f.q);
  return list.filter((r) => {
    if (platforms.length && !platforms.includes(r.platform)) return false;
    if (depts.length && !depts.includes(r.department || '(none)')) return false;
    if (emps.length && !r.assigned.some((a) => emps.includes(a.id)) && !(emps.includes('(none)') && !r.assigned.length)) return false;
    if (statuses.length && !statuses.includes(r.status)) return false;
    if (f.expiring && !(r.renewalState || r.rotateDue)) return false;
    if (text) {
      const hay = low([r.platform, r.label, r.username, r.loginUrl, r.department, r.notes, r.owner && r.owner.name, ...r.assigned.map((a) => `${a.name} ${a.code}`)].join(' '));
      if (!hay.includes(text)) return false;
    }
    return true;
  });
}

async function list(user, rights, filters) {
  const rows = await shape(await visibleRows(user, rights));
  return applyFilters(rows, filters || {});
}

async function rowById(id) {
  const rows = await q('SELECT * FROM "Credential" WHERE "id" = ?', String(id || ''));
  return rows[0] || null;
}

async function readable(user, rights, id) {
  const row = await rowById(id);
  if (!row) throw new VaultError(404, 'That login is not in the vault.');
  if (rights.view || isOwn(user, row)) return row;
  throw new VaultError(403, 'You do not have access to this login.');
}

async function detail(user, rights, id) {
  const row = await readable(user, rights, id);
  const [one] = await shape([row]);
  const history = rights.view ? await historyOf(row.id) : [];
  return { credential: one, history };
}

async function historyOf(credentialId, limit = 200) {
  const rows = await q('SELECT "id","userName","action","detail","ip","at" FROM "CredentialAccess" WHERE "credentialId" = ? ORDER BY "at" DESC LIMIT ?', credentialId, limit);
  return rows.map((r) => ({ ...r, what: ACTION_WORDS[r.action] || r.action }));
}

async function accessLog(filters = {}) {
  const where = []; const args = [];
  if (filters.userId) { where.push('"userId" = ?'); args.push(String(filters.userId)); }
  if (filters.credentialId) { where.push('"credentialId" = ?'); args.push(String(filters.credentialId)); }
  if (filters.action) { where.push('"action" = ?'); args.push(String(filters.action)); }
  if (filters.from) { where.push('"at" >= ?'); args.push(`${filters.from}T00:00:00.000Z`); }
  if (filters.to) { where.push('"at" <= ?'); args.push(`${filters.to}T23:59:59.999Z`); }
  const rows = await q(`SELECT * FROM "CredentialAccess"${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY "at" DESC LIMIT 1000`, ...args);
  return rows.map((r) => ({ id: r.id, credentialId: r.credentialId, credentialName: r.credentialName || '', userName: r.userName || '', action: r.action, what: ACTION_WORDS[r.action] || r.action, detail: r.detail || '', ip: r.ip || '', at: r.at }));
}

// ---- reveal ----------------------------------------------------------------------------------------------------------
const revealHits = new Map(); // userId -> [timestamps]
function rateCheck(userId) {
  const now = Date.now();
  const hits = (revealHits.get(userId) || []).filter((t) => now - t < REVEAL_WINDOW_MS);
  if (hits.length >= REVEAL_LIMIT) throw new VaultError(429, `That is ${REVEAL_LIMIT} passwords in ten minutes. Wait a few minutes and try again.`, { code: 'REVEAL_LIMIT' });
  hits.push(now); revealHits.set(userId, hits);
}

async function reveal(user, rights, id, { field = 'password', purpose = 'show' } = {}, ip) {
  if (!['password', 'extra'].includes(field)) throw new VaultError(400, 'Choose the password or the extra secret.');
  if (!['show', 'copy'].includes(purpose)) throw new VaultError(400, 'Choose Show or Copy.');
  const row = await rowById(id);
  if (!row) throw new VaultError(404, 'That login is not in the vault.');
  const allowed = (rights.view && rights.reveal) || isOwn(user, row);
  if (!allowed) throw new VaultError(403, 'Showing passwords is not part of your access. The Super Admin can grant it.');
  const stored = field === 'extra' ? row.extraEnc : row.passwordEnc;
  if (!stored) throw new VaultError(404, field === 'extra' ? 'No extra secret is saved for this login.' : 'No password is saved for this login.');
  rateCheck(user.id);
  const plain = secrets.decryptSecret(stored);
  if (plain === null) throw new VaultError(409, 'This secret cannot be read with the key the server has now (INTEGRATION_SECRET_KEY changed or is missing).', { code: 'KEY_MISMATCH' });
  await logAccess(user, row, `${purpose}_${field}`, null, ip);
  let value = plain;
  if (field === 'extra') { try { value = JSON.parse(plain); } catch { value = { other: plain }; } }
  return { field, value, seconds: SHOW_SECONDS };
}

// ---- writing ---------------------------------------------------------------------------------------------------------
const EXTRA_KEYS = [['recoveryCodes', '2FA recovery codes'], ['pin', 'PIN'], ['securityAnswers', 'Security answers'], ['other', 'Other secret']];
function cleanExtra(extra) {
  if (!extra || typeof extra !== 'object') return null;
  const out = {};
  EXTRA_KEYS.forEach(([k]) => { const v = extra[k] == null ? '' : String(extra[k]).trim(); if (v) out[k] = v.slice(0, 4000); });
  return Object.keys(out).length ? out : null;
}
const kindsOf = (extra) => EXTRA_KEYS.filter(([k]) => extra && extra[k]).map(([, l]) => l).join(', ');

function encOrRefuse(plain) {
  try { return secrets.encryptSecret(plain); } catch (e) {
    if (e.code === 'NO_SECRET_KEY') throw new VaultError(400, secrets.NO_KEY_MESSAGE, { code: 'NO_SECRET_KEY' });
    throw new VaultError(500, 'The secret could not be encrypted.');
  }
}

function cleanUrl(raw) {
  const s = squash(raw).slice(0, 500);
  if (!s) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  let u;
  try { u = new URL(withScheme); } catch { throw new VaultError(400, 'The login address is not a web address (example: https://www.example.com/login).'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new VaultError(400, 'The login address must start with http:// or https://.');
  return u.toString();
}
function cleanDay(raw) {
  if (raw === null || raw === undefined || raw === '') return '';
  const r = parseCameDate(raw, { now: FAR });
  if (r.ok) return r.day;
  if (r.ok === null) return '';
  throw new VaultError(400, 'The renewal date is not a date (use DD-MM-YYYY).');
}

async function checkEmployees(ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))].slice(0, 50);
  const emp = await employeesById(list);
  const missing = list.filter((i) => !emp.has(i));
  if (missing.length) throw new VaultError(400, 'One of the chosen employees is not in TeamLink.');
  return { ids: list, emp };
}

async function findDuplicate(platform, username, exceptId) {
  const rows = await q('SELECT "id" FROM "Credential" WHERE "platformKey" = ? AND "usernameKey" = ? AND "id" <> ?', platformKeyOf(platform), usernameKeyOf(username), exceptId || '');
  return rows[0] ? rows[0].id : null;
}

async function save(user, rights, id, body = {}, ip) {
  const existing = id ? await rowById(id) : null;
  if (id && !existing) throw new VaultError(404, 'That login is not in the vault.');
  if (!existing && !rights.create) throw new VaultError(403, 'Adding logins is not part of your access.');
  if (existing && !rights.edit) throw new VaultError(403, 'Changing logins is not part of your access.');
  const b = body || {};
  const platform = b.platform !== undefined ? canonicalPlatform(b.platform) : existing.platform;
  const username = b.username !== undefined ? squash(b.username).slice(0, 200) : existing.username;
  if (!platform) throw new VaultError(400, 'Choose or type the platform (Naukri, Hostinger, Gmail ...).');
  if (!username) throw new VaultError(400, 'Type the username or e-mail of the login.');
  const dup = await findDuplicate(platform, username, existing && existing.id);
  if (dup) throw new VaultError(409, `There is already a ${platform} login for ${username} in the vault.`, { code: 'DUPLICATE', duplicateId: dup });
  const status = b.status !== undefined ? (b.status === 'disabled' ? 'disabled' : 'active') : (existing ? existing.status : 'active');
  const label = b.label !== undefined ? squash(b.label).slice(0, 150) : (existing ? existing.label : '');
  const loginUrl = b.loginUrl !== undefined ? cleanUrl(b.loginUrl) : (existing ? existing.loginUrl : '');
  const department = b.department !== undefined ? squash(b.department).slice(0, 100) : (existing ? existing.department : '');
  const notes = b.notes !== undefined ? String(b.notes || '').trim().slice(0, 2000) : (existing ? existing.notes : '');
  const renewalDate = b.renewalDate !== undefined ? cleanDay(b.renewalDate) : (existing ? existing.renewalDate : '');
  const employeeCanSee = b.employeeCanSee !== undefined ? (b.employeeCanSee ? 1 : 0) : (existing ? num(existing.employeeCanSee) : 0);
  let assigned = existing ? parseIds(existing.assignedEmployeeIds) : [];
  if (b.assignedEmployeeIds !== undefined) assigned = (await checkEmployees(b.assignedEmployeeIds)).ids;
  let ownerEmployeeId = existing ? existing.ownerEmployeeId : null; let ownerName = existing ? existing.ownerName : null;
  if (b.ownerEmployeeId !== undefined) {
    if (b.ownerEmployeeId) { const { emp } = await checkEmployees([b.ownerEmployeeId]); ownerEmployeeId = String(b.ownerEmployeeId); ownerName = emp.get(ownerEmployeeId).name; } else { ownerEmployeeId = null; ownerName = null; }
  }
  // secrets: a blank box keeps what is stored (the form never receives it); clearPassword / clearExtra remove it.
  let passwordEnc = existing ? existing.passwordEnc : null; let rotated = existing ? existing.lastRotatedAt : null;
  const pw = b.password == null ? '' : String(b.password);
  if (pw.length > 500) throw new VaultError(400, 'That password is too long (500 characters at most).');
  if (pw) { passwordEnc = encOrRefuse(pw); rotated = nowIso(); } else if (b.clearPassword) { passwordEnc = null; }
  let extraEnc = existing ? existing.extraEnc : null; let extraKinds = existing ? existing.extraKinds : null;
  const extra = cleanExtra(b.extra);
  if (extra) { extraEnc = encOrRefuse(JSON.stringify(extra)); extraKinds = kindsOf(extra); } else if (b.clearExtra) { extraEnc = null; extraKinds = null; }
  if (existing && b.assignedEmployeeIds !== undefined && !rights.assign && JSON.stringify(assigned) !== JSON.stringify(parseIds(existing.assignedEmployeeIds))) {
    throw new VaultError(403, 'Assigning logins to employees is not part of your access.');
  }
  const at = nowIso();
  const who = user.name || user.email || null;
  if (!existing) {
    const nid = newId('cr');
    await x(`INSERT INTO "Credential" ("id","platform","platformKey","label","loginUrl","username","usernameKey","passwordEnc","extraEnc","extraKinds","assignedEmployeeIds",
      "department","ownerEmployeeId","ownerName","notes","renewalDate","lastRotatedAt","status","employeeCanSee","importBatchId","createdById","createdByName","createdAt","updatedById","updatedByName","updatedAt")
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    nid, platform, platformKeyOf(platform), label || null, loginUrl || null, username, usernameKeyOf(username), passwordEnc, extraEnc, extraKinds, JSON.stringify(assigned),
    department || null, ownerEmployeeId, ownerName, notes || null, renewalDate || null, passwordEnc ? at : null, status, employeeCanSee, null, user.id, who, at, user.id, who, at);
    const row = await rowById(nid);
    await logAccess(user, row, 'create', null, ip);
    return (await shape([row]))[0];
  }
  const changed = [];
  const cmp = (k, v) => { if (String(existing[k] ?? '') !== String(v ?? '')) changed.push(k); };
  [['platform', platform], ['label', label], ['loginUrl', loginUrl], ['username', username], ['department', department], ['notes', notes], ['renewalDate', renewalDate],
    ['status', status], ['employeeCanSee', employeeCanSee], ['ownerEmployeeId', ownerEmployeeId], ['assignedEmployeeIds', JSON.stringify(assigned)]].forEach(([k, v]) => cmp(k, v));
  if (passwordEnc !== existing.passwordEnc) changed.push(pw ? 'password (new)' : 'password (removed)');
  if (extraEnc !== existing.extraEnc) changed.push(extra ? 'extra secret (new)' : 'extra secret (removed)');
  await x(`UPDATE "Credential" SET "platform"=?,"platformKey"=?,"label"=?,"loginUrl"=?,"username"=?,"usernameKey"=?,"passwordEnc"=?,"extraEnc"=?,"extraKinds"=?,"assignedEmployeeIds"=?,
    "department"=?,"ownerEmployeeId"=?,"ownerName"=?,"notes"=?,"renewalDate"=?,"lastRotatedAt"=?,"status"=?,"employeeCanSee"=?,"updatedById"=?,"updatedByName"=?,"updatedAt"=? WHERE "id"=?`,
  platform, platformKeyOf(platform), label || null, loginUrl || null, username, usernameKeyOf(username), passwordEnc, extraEnc, extraKinds, JSON.stringify(assigned),
  department || null, ownerEmployeeId, ownerName, notes || null, renewalDate || null, rotated, status, employeeCanSee, user.id, who, at, existing.id);
  const row = await rowById(existing.id);
  if (changed.length) {
    const statusOnly = changed.length === 1 && changed[0] === 'status';
    await logAccess(user, row, statusOnly ? (status === 'disabled' ? 'disable' : 'enable') : 'edit', statusOnly ? null : `changed: ${changed.map((c) => c.replace('assignedEmployeeIds', 'assigned employees').replace('ownerEmployeeId', 'owner').replace('employeeCanSee', 'employee can see own')).join(', ')}`, ip);
  }
  return (await shape([row]))[0];
}

async function remove(user, rights, id, ip) {
  if (!rights.delete) throw new VaultError(403, 'Deleting logins is not part of your access.');
  const row = await rowById(id);
  if (!row) throw new VaultError(404, 'That login is not in the vault.');
  await x('DELETE FROM "Credential" WHERE "id" = ?', row.id);
  await logAccess(user, row, 'delete', null, ip);
  return { ok: true };
}

async function bulk(user, rights, body = {}, ip) {
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(String))].slice(0, 1000);
  if (!ids.length) throw new VaultError(400, 'Tick at least one login.');
  const action = String(body.action || '');
  const need = { assign: 'assign', disable: 'edit', enable: 'edit', delete: 'delete' }[action];
  if (!need) throw new VaultError(400, 'Choose what to do with the ticked logins.');
  if (!rights[need]) throw new VaultError(403, 'That is not part of your access.');
  if (action === 'delete' && body.confirm !== true) throw new VaultError(400, 'Confirm the delete first.');
  let emp = null;
  if (action === 'assign') emp = (await checkEmployees(body.employeeIds)).ids;
  let done = 0;
  for (const id of ids) {
    const row = await rowById(id); // eslint-disable-line no-await-in-loop
    if (!row) continue; // eslint-disable-line no-continue
    if (action === 'delete') {
      await x('DELETE FROM "Credential" WHERE "id" = ?', row.id); // eslint-disable-line no-await-in-loop
      await logAccess(user, row, 'delete', 'bulk', ip); // eslint-disable-line no-await-in-loop
    } else if (action === 'assign') {
      const next = body.mode === 'replace' ? emp : [...new Set([...parseIds(row.assignedEmployeeIds), ...emp])];
      await x('UPDATE "Credential" SET "assignedEmployeeIds"=?,"updatedById"=?,"updatedByName"=?,"updatedAt"=? WHERE "id"=?', JSON.stringify(next), user.id, user.name || null, nowIso(), row.id); // eslint-disable-line no-await-in-loop
      await logAccess(user, row, 'assign', `bulk: ${next.length} employee(s)`, ip); // eslint-disable-line no-await-in-loop
    } else {
      const st = action === 'disable' ? 'disabled' : 'active';
      if (row.status === st) continue; // eslint-disable-line no-continue
      await x('UPDATE "Credential" SET "status"=?,"updatedById"=?,"updatedByName"=?,"updatedAt"=? WHERE "id"=?', st, user.id, user.name || null, nowIso(), row.id); // eslint-disable-line no-await-in-loop
      await logAccess(user, row, action, 'bulk', ip); // eslint-disable-line no-await-in-loop
    }
    done += 1;
  }
  return { done };
}

// ---- per-person grants -----------------------------------------------------------------------------------------------
async function grants() {
  const rows = await q('SELECT * FROM "CredentialVaultGrant" ORDER BY "at" DESC');
  const users = rows.length ? await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, name: true, email: true, role: true, status: true } }) : [];
  const by = new Map(users.map((u) => [u.id, u]));
  return rows.map((r) => { let rights = {}; try { rights = JSON.parse(r.rights); } catch { rights = {}; } const u = by.get(r.userId) || {}; return { userId: r.userId, name: u.name || '(removed login)', email: u.email || '', role: u.role || '', status: u.status || '', rights, byName: r.byName, at: r.at }; });
}
async function setGrant(user, targetUserId, rights, ip) {
  const target = await prisma.user.findUnique({ where: { id: String(targetUserId || '') }, select: { id: true, name: true, role: true } });
  if (!target) throw new VaultError(404, 'Choose a TeamLink login.');
  if (['CLIENT', 'CANDIDATE'].includes(target.role)) throw new VaultError(400, 'A client or candidate login can never open the vault.');
  const r = { view: !!(rights && rights.view), reveal: !!(rights && rights.reveal), manage: !!(rights && rights.manage), import: !!(rights && rights.import), export: !!(rights && rights.export) };
  if (!r.view) { r.reveal = false; r.manage = false; r.import = false; r.export = false; }
  if (!Object.values(r).some(Boolean)) await x('DELETE FROM "CredentialVaultGrant" WHERE "userId" = ?', target.id);
  else {
    await x(`INSERT INTO "CredentialVaultGrant" ("userId","rights","byName","at") VALUES (?,?,?,?)
      ON CONFLICT("userId") DO UPDATE SET "rights" = excluded."rights", "byName" = excluded."byName", "at" = excluded."at"`, target.id, JSON.stringify(r), user.name || null, nowIso());
  }
  const words = Object.entries(r).filter(([, v]) => v).map(([k]) => k).join(', ') || 'no access';
  await logAccess(user, null, 'grant', `${target.name}: ${words}`, ip);
  return { userId: target.id, rights: r };
}

// ---- options for the form / filters ----------------------------------------------------------------------------------
async function options() {
  const emps = await prisma.employee.findMany({
    where: { employmentStatus: { notIn: ['Exited', 'Relieved', 'Terminated'] } },
    select: { id: true, name: true, employeeCode: true, department: true }, orderBy: { name: 'asc' }, take: 5000,
  });
  const depts = [...new Set(emps.map((e) => e.department).filter(Boolean))].sort();
  return { platforms: PLATFORMS, employees: emps.map((e) => ({ id: e.id, name: e.name, code: e.employeeCode, department: e.department || '' })), departments: depts, expiringDays: EXPIRING_DAYS, rotateDays: ROTATE_DAYS };
}

// ---- EXPORT ----------------------------------------------------------------------------------------------------------
const EXPORT_HEAD = ['Platform', 'Label', 'Login URL', 'Username / Email', 'Employee (name / code / email)', 'Department', 'Owner', 'Notes', 'Renewal date', 'Last changed', 'Status', 'Employee can see own'];
async function exportBook(user, rights, filters, { withPasswords }) {
  const shaped = await list(user, rights, filters);
  const raw = withPasswords ? new Map((await q('SELECT "id","passwordEnc","extraEnc" FROM "Credential"')).map((r) => [r.id, r])) : null;
  const head = withPasswords ? [...EXPORT_HEAD.slice(0, 4), 'Password', 'Extra secret', ...EXPORT_HEAD.slice(4)] : EXPORT_HEAD;
  const rows = shaped.map((r) => {
    const base = [r.platform, r.label, r.loginUrl, r.username];
    const rest = [r.assigned.map((a) => (a.code ? `${a.name} (${a.code})` : a.name)).join('; '), r.department, r.owner ? r.owner.name : '', r.notes, r.renewalDate, (r.lastRotatedAt || '').slice(0, 10), r.status, r.employeeCanSee ? 'Yes' : 'No'];
    if (!withPasswords) return [...base, ...rest];
    const s = raw.get(r.id) || {};
    const pw = s.passwordEnc ? secrets.decryptSecret(s.passwordEnc) : '';
    let ex = s.extraEnc ? secrets.decryptSecret(s.extraEnc) : '';
    if (ex) { try { const o = JSON.parse(ex); ex = EXTRA_KEYS.filter(([k]) => o[k]).map(([k, l]) => `${l}: ${o[k]}`).join(' | '); } catch { /* keep */ } }
    return [...base, pw === null ? '(cannot read with this key)' : pw, ex === null ? '(cannot read with this key)' : ex, ...rest];
  });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([head, ...rows]);
  ws['!cols'] = head.map((h) => ({ wch: Math.max(12, Math.min(40, h.length + 6)) }));
  XLSX.utils.book_append_sheet(wb, ws, 'Logins');
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), count: rows.length };
}

// ---- IMPORT ----------------------------------------------------------------------------------------------------------
const COLUMNS = [
  { key: 'platform', label: 'Platform', need: true, help: 'Naukri, Shine, foundit, LinkedIn, Indeed, HRMS, Hostinger, cPanel, Gmail, Microsoft 365, Zoho, WhatsApp Business, Meta, a bank or GST portal, or any other name.',
    aliases: ['platform', 'portal', 'site', 'service', 'application', 'app', 'accounttype', 'system', 'tool', 'provider', 'platformname', 'portalname', 'website'] },
  { key: 'label', label: 'Label', help: 'Optional: a short name for this login (Naukri - IT team, Main Hostinger).', aliases: ['label', 'accountname', 'title', 'description', 'purpose', 'loginname', 'for', 'nickname'] },
  { key: 'loginUrl', label: 'Login URL', help: 'Optional: the sign-in page, for example https://www.example.com/login', aliases: ['loginurl', 'url', 'link', 'loginlink', 'weburl', 'portalurl', 'siteurl', 'loginpage', 'websiteurl', 'address'] },
  { key: 'username', label: 'Username / Email', need: true, help: 'The login name or e-mail used to sign in. Must not be empty.',
    aliases: ['usernameemail', 'username', 'user', 'userid', 'loginid', 'login', 'email', 'emailid', 'mailid', 'loginemail', 'useremail', 'id', 'loginusername', 'usernameoremail', 'emailusername'] },
  { key: 'password', label: 'Password', help: 'The password. It is encrypted the moment it reaches the server and is never shown in the preview.', aliases: ['password', 'pass', 'pwd', 'passcode', 'passwd', 'loginpassword', 'pw', 'passwords'] },
  { key: 'employee', label: 'Employee (name / code / email)', help: 'Optional: who uses it, by name, employee code or e-mail as in TeamLink. Several people: separate with ; or ,',
    aliases: ['employeenamecodeemail', 'employee', 'employeename', 'employeecode', 'empcode', 'empname', 'empid', 'employeeid', 'employeeemail', 'assignedto', 'usedby', 'staff', 'person', 'holder', 'whouses', 'givento', 'assignee', 'employees'] },
  { key: 'department', label: 'Department', help: 'Optional: the department or team. Empty = the employee\'s department when one employee is given.', aliases: ['department', 'dept', 'team', 'division'] },
  { key: 'notes', label: 'Notes', help: 'Optional: anything to remember. Do not put passwords here - use Extra secret.', aliases: ['notes', 'note', 'remarks', 'remark', 'comments', 'comment', 'details'] },
  { key: 'renewal', label: 'Renewal date', help: 'Optional: when the plan / domain / subscription renews or expires. 12-03-2027, 12/03/2027 and Excel dates work (day first).',
    aliases: ['renewaldate', 'renewal', 'expiry', 'expirydate', 'expires', 'expireson', 'validtill', 'validupto', 'renewon', 'duedate', 'renewsOn', 'renewson'] },
  { key: 'extra', label: 'Extra secret', help: 'Optional: 2FA recovery codes, a PIN, security answers. Encrypted like the password.',
    aliases: ['extrasecret', 'extra', 'secret', 'pin', 'recoverycodes', '2fa', 'backupcodes', 'securityanswer', 'securityanswers', 'securityquestion', 'mpin', 'tpin', 'secretanswer', 'otherSecret', 'othersecret'] },
];
const GUIDE_SHEETS = ['howtofill', 'instructions', 'readme', 'help', 'guide'];

function template() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    COLUMNS.map((c) => c.label),
    ['Naukri', 'Example - Naukri IT team', 'https://www.example.com/login', 'example.user@example.com', 'Example-Not-A-Real-Password-1', 'Employee name or code or e-mail', 'IT', 'Example row: it is skipped', '31-03-2027', ''],
    ['Hostinger', 'Example - main website', 'https://hpanel.example.com', 'webmaster@example.com', 'Example-Not-A-Real-Password-2', '', 'Admin', 'Example row: it is skipped', '', 'PIN: 0000 (example)'],
  ]);
  ws['!cols'] = [{ wch: 16 }, { wch: 26 }, { wch: 32 }, { wch: 30 }, { wch: 28 }, { wch: 30 }, { wch: 14 }, { wch: 30 }, { wch: 14 }, { wch: 24 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Logins');
  const guide = XLSX.utils.aoa_to_sheet([
    ['Column', 'What to write'],
    ...COLUMNS.map((c) => [c.label + (c.need ? ' (needed)' : ' (optional)'), c.help]),
    [],
    ['Rows', `At most ${MAX_ROWS} rows and 5 MB per file. Rows whose Label starts with "Example" are skipped.`],
    ['Safety', 'The file is read in memory and never saved. Passwords are encrypted before anything is stored and the preview shows them hidden. Delete this file from your computer after the import.'],
    ['Nothing is saved', 'until you check the preview and press Import. Every import can be undone.'],
  ]);
  guide['!cols'] = [{ wch: 30 }, { wch: 120 }];
  XLSX.utils.book_append_sheet(wb, guide, 'How to fill');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function readWorkbook(file) {
  const buf = file && file.data;
  if (!buf || !buf.length) throw new VaultError(400, 'Choose the sheet to import.');
  if (buf.length > MAX_BYTES) throw new VaultError(413, 'That file is over 5 MB. Split it into smaller files.');
  const head = buf.slice(0, 5).toString('latin1');
  if (head.startsWith('%PDF')) throw new VaultError(400, 'That is a PDF. Choose an Excel (.xlsx / .xls) or CSV file - download the template if you need one.');
  const bin = head.startsWith('PK') || buf.slice(0, 4).toString('hex') === 'd0cf11e0';
  try {
    return bin ? XLSX.read(buf, { type: 'buffer', cellDates: false }) : XLSX.read(buf.toString('utf8').replace(/^﻿/, ''), { type: 'string', raw: true });
  } catch {
    throw new VaultError(400, 'That file could not be read as a spreadsheet. Save it as .xlsx or .csv and try again.');
  }
}

function autoMap(cells, override) {
  const keys = cells.map((h) => hkey(h));
  const map = {}; const used = new Set();
  const claim = (k, i) => { map[k] = i; used.add(i); };
  if (override && typeof override === 'object') {
    COLUMNS.forEach((c) => {
      if (!(c.key in override)) return;
      const n = Number(override[c.key]);
      if (override[c.key] === null || override[c.key] === '' || n < 0) { map[c.key] = null; return; }
      if (Number.isInteger(n) && n < cells.length && !used.has(n)) claim(c.key, n);
    });
  }
  COLUMNS.forEach((c) => { if (c.key in map) return; const i = keys.findIndex((k, idx) => k && !used.has(idx) && k === hkey(c.label)); if (i >= 0) claim(c.key, i); });
  COLUMNS.forEach((c) => { if (c.key in map) return; const al = c.aliases.map(hkey); const i = keys.findIndex((k, idx) => k && !used.has(idx) && al.includes(k)); if (i >= 0) claim(c.key, i); });
  return map;
}
const cellText = (v) => (v === null || v === undefined ? '' : squash(v));

function readSheet(file, mapping, asked) {
  const wb = readWorkbook(file);
  const names = wb.SheetNames || [];
  const sheetName = (asked && names.includes(asked)) ? asked : (names.find((n) => hkey(n) === 'logins') || names.find((n) => !GUIDE_SHEETS.includes(hkey(n))) || names[0]);
  const xs = wb.Sheets[sheetName];
  if (!xs || !xs['!ref']) throw new VaultError(400, 'That sheet is empty.');
  const grid = XLSX.utils.sheet_to_json(xs, { header: 1, raw: true, defval: '', blankrows: true });
  let best = { idx: 0, score: -1 };
  for (let i = 0; i < Math.min(15, grid.length); i += 1) {
    const sc = Object.values(autoMap(grid[i] || [], null)).filter((v) => Number.isInteger(v)).length;
    if (sc > best.score) best = { idx: i, score: sc };
  }
  const range = XLSX.utils.decode_range(xs['!ref']);
  const header = (grid[best.idx] || []).map((h) => squash(h));
  const map = autoMap(header, mapping);
  const fileColumns = header.map((name, index) => ({ index, name: name || `Column ${XLSX.utils.encode_col(index)}` }));
  const has = (k) => Number.isInteger(map[k]);
  const missing = COLUMNS.filter((c) => c.need && !has(c.key)).map((c) => c.label);
  const rows = [];
  const firstRow = range.s.r + 1 + best.idx + 1;
  grid.slice(best.idx + 1).forEach((cells, i) => {
    if (!cells || cells.every((v) => cellText(v) === '')) return;
    const get = (k) => (has(k) ? cells[map[k]] : '');
    rows.push({
      row: firstRow + i,
      platform: cellText(get('platform')), label: cellText(get('label')), loginUrl: cellText(get('loginUrl')), username: cellText(get('username')),
      // secrets keep their exact characters (no squashing of inner spaces); a number cell becomes its digits
      password: get('password') === '' || get('password') == null ? '' : String(get('password')).trim(),
      employee: cellText(get('employee')), department: cellText(get('department')), notes: String(get('notes') ?? '').trim(),
      renewalRaw: get('renewal'), extra: get('extra') === '' || get('extra') == null ? '' : String(get('extra')).trim(),
    });
  });
  if (rows.length > MAX_ROWS) throw new VaultError(400, `That sheet has ${rows.length} rows. At most ${MAX_ROWS} at a time - split the file.`);
  return {
    sheet: sheetName, sheets: names, headerRow: range.s.r + 1 + best.idx, fileColumns,
    mapping: COLUMNS.map((c) => ({ key: c.key, label: c.label, need: !!c.need, column: has(c.key) ? map[c.key] : null, columnName: has(c.key) ? fileColumns[map[c.key]].name : null })),
    missing, rows,
  };
}

// ---- SMART IMPORT: a team's own workbook, every sheet at once (founder 2026-11-23) -----------------------------------------
// Teams keep logins as one sheet per platform ("Naukri Logins", "Shine Logins", "Vici Dial Credentials", "GMail Credentials", "Hrms
// Credentials", "Phone's Number"), with the person's name and position, sometimes two logins on one row (a ViciDial phone login and a user
// login, each with its own Password column) and sometimes no header row at all. When the chosen sheet has no Platform column, every sheet
// is read: the platform comes from the sheet's name (or a header such as "VC Dail Logins"), each login column + the Password column right
// after it becomes one login, the person's name is matched to an employee (a name that is not in TeamLink becomes the label instead of
// refusing the row), position / phone numbers / group go into the notes and recovery phone / e-mail into the encrypted extra secret.
// Sheets with no password at all (only phone numbers) are listed as skipped.
const SMART_PLATFORM = [
  [/vici|vcdail|vcdial|dialer|portnumber/, 'ViciDial'], [/naukri/, 'Naukri'], [/shine/, 'Shine'], [/foundit|monster/, 'foundit'], [/linkedin/, 'LinkedIn'],
  [/indeed/, 'Indeed'], [/hrms|teamlink/, 'HRMS'], [/webmail|weblogin|webmails/, 'Webmail'], [/gmail|googlemail|officegmail/, 'Gmail'],
  [/hostinger/, 'Hostinger'], [/cpanel/, 'cPanel'], [/zoho/, 'Zoho'], [/whatsapp/, 'WhatsApp Business'], [/outlook|office365|microsoft/, 'Microsoft 365'],
];
const smartPlatformOf = (...texts) => { for (const t of texts) { const k = hkey(t); const hit = SMART_PLATFORM.find(([re]) => re.test(k)); if (hit) return hit[1]; } return ''; };
const isPwHead = (k) => /^(password|passwords|pass|pwd|passcode|loginpassword)\d*$/.test(k);
const isLoginHead = (k) => /mailid|mailids|emailid|email|account|userlogin|login|logins|username|userid|portnumber|vcdail|vcdial|officemail/.test(k) && !isPwHead(k) && !/recovery/.test(k);
const isNameHead = (k) => /^(name|names|recruiter|recuriter|recruitername|recuritername|recrutiersnames|recruitersnames|recruiterpositionname|employee|employeename|staff)$/.test(k) || (/name/.test(k) && !/user|mail|login|account/.test(k));
const isRecoveryHead = (k) => /recovery/.test(k);
const isPositionHead = (k) => /position|designation|role/.test(k) && !/name/.test(k);
const HEAD_WORDS = /password|mail|name|position|account|login|number|phone|mobile|recovery|website|whatsapp|sim|recruiter|recuriter/;
const looksEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim());
const looksPhone = (v) => /^\+?\d[\d\s-]{8,13}\d$/.test(String(v).trim());
const looksAccountId = (v) => /^[A-Za-z0-9._-]{4,}$/.test(String(v).trim()) && /[A-Za-z]/.test(String(v)) && !looksPhone(v);
const looksPersonName = (v) => /^[A-Za-z][A-Za-z .']{1,60}$/.test(String(v).trim()) && !looksEmail(v);

function smartSheet(sheetName, grid, startRow) {
  const out = [];
  const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
  const rowsAll = grid.map((r) => (r || []).map(text));
  // a header row always names a Password column; a sheet without one is read row by row
  const hdrIdx = rowsAll.slice(0, 5).findIndex((r) => r.filter((c) => c && HEAD_WORDS.test(hkey(c)) && !looksEmail(c)).length >= 2 && r.some((c) => isPwHead(hkey(c))));
  const sheetPlatform = smartPlatformOf(sheetName);
  let n = 0;
  const push = (o) => {
    n += 1;
    const lines = String(o.username || '').split(/[\r\n]+/).map((x) => x.trim()).filter(Boolean);
    const username = lines[0] || '';
    const notes = lines.length > 1 ? `${o.notes}\nAlso in the same cell: ${lines.slice(1).join(", ")}` : o.notes;
    let { platform } = o;
    if (!smartPlatformOf(platform) && !PLATFORMS.includes(platform)) {
      if (/@gmail\.com/i.test(username)) platform = 'Gmail';
      else if (/@tmlink\.in$/i.test(username)) platform = 'Webmail';
    }
    out.push({ ...o, username, notes, platform, row: startRow + n, sheet: sheetName }); // one unique number per login (a row can hold two)
  };
  if (hdrIdx >= 0) {
    const head = rowsAll[hdrIdx]; const keys = head.map(hkey);
    const nameCol = keys.findIndex(isNameHead);
    const posCol = keys.findIndex(isPositionHead);
    const pwCols = keys.map((k, i) => (isPwHead(k) ? i : -1)).filter((i) => i >= 0);
    // each Password column takes the nearest login column on its left that no other Password column took
    const taken = new Set(); const pairs = [];
    pwCols.forEach((pc) => {
      for (let i = pc - 1; i >= 0; i -= 1) {
        if (taken.has(i) || pwCols.includes(i)) continue; // eslint-disable-line no-continue
        if (isLoginHead(keys[i])) { taken.add(i); pairs.push({ u: i, p: pc }); return; }
      }
    });
    const recCols = keys.map((k, i) => (isRecoveryHead(k) ? i : -1)).filter((i) => i >= 0);
    const used = new Set([nameCol, posCol, ...pwCols, ...pairs.map((x) => x.u), ...recCols].filter((i) => i >= 0));
    const noteCols = keys.map((k, i) => (k && !used.has(i) ? i : -1)).filter((i) => i >= 0);
    rowsAll.slice(hdrIdx + 1).forEach((r, ri) => {
      if (!r.some(Boolean)) return;
      const person = nameCol >= 0 ? r[nameCol] : '';
      const notes = [posCol >= 0 && r[posCol] ? `Position: ${r[posCol]}` : '', ...noteCols.map((i) => (r[i] ? `${head[i]}: ${r[i]}` : ''))].filter(Boolean);
      const extra = recCols.map((i) => (r[i] ? `${head[i]}: ${r[i]}` : '')).filter(Boolean).join('\n');
      pairs.forEach(({ u, p }) => {
        const username = r[u]; const password = r[p];
        if (!username && !password) return;
        const platform = smartPlatformOf(head[u], sheetName) || sheetPlatform || canonicalPlatform(sheetName);
        push({
          row: startRow + hdrIdx + 1 + ri, where: `${sheetName} · row ${hdrIdx + 2 + ri}`, platform, label: [(posCol >= 0 && r[posCol]) || person, pairs.length > 1 ? head[u] : ''].filter(Boolean).join(' - ').slice(0, 150), // the sheet's Position ("Edu 1") is the label; the Employee column shows who

          loginUrl: '', username, password, employee: person, department: '', notes: [`From sheet "${sheetName}"`, ...notes].join('\n'), renewalRaw: '', extra, softEmployee: true,
        });
      });
    });
    return { rows: out, skipped: pairs.length ? null : 'no password column' };
  }
  // a sheet WITH a header row (Name / Position ...) but no Password column holds no logins (only phone numbers): skipped, not guessed
  if (rowsAll.slice(0, 5).some((r) => r.filter((c) => c && HEAD_WORDS.test(hkey(c)) && !looksEmail(c)).length >= 2 && r.some((c) => isNameHead(hkey(c)) || isPositionHead(hkey(c))))) return { rows: [], skipped: "no password column" };
  // no header row: each row is read by what its cells look like - a group word, a name, the login (an e-mail or an account id),
  // the password right after it, and a phone number / e-mail after that.
  rowsAll.forEach((r, ri) => {
    const cells = r.map((c, i) => ({ c, i })).filter((x) => x.c);
    if (cells.length < 2) return;
    // the login is the first e-mail of the row; only when there is none, an account id (letters with a digit, _ or .) - a plain name
    // such as "Ragini" is never taken for the login (founder 2026-11-23: the name was read as the login and the e-mail as the password)
    let ui = cells.findIndex((x, j) => j > 0 && looksEmail(x.c) && cells[j + 1]);
    if (ui < 0) ui = cells.findIndex((x, j) => j > 0 && looksAccountId(x.c) && /[\d_.]/.test(x.c) && cells[j + 1]);
    if (ui < 0) return;
    const username = cells[ui].c; const password = cells[ui + 1].c;
    const before = cells.slice(0, ui).map((x) => x.c);
    const person = before.slice().reverse().find((v) => looksPersonName(v) && !smartPlatformOf(v)) || '';
    const group = before.filter((v) => v !== person);
    const after = cells.slice(ui + 2).map((x) => x.c);
    const platform = smartPlatformOf(...group, sheetName) || sheetPlatform || canonicalPlatform(sheetName);
    push({
      row: startRow + ri, where: `${sheetName} · row ${ri + 1}`, platform, label: person.slice(0, 150), loginUrl: '', username, password, employee: person, department: '',
      notes: [`From sheet "${sheetName}"`, group.length ? `Group: ${group.join(', ')}` : '', after.length ? `Contact: ${after.join(', ')}` : ''].filter(Boolean).join('\n'),
      renewalRaw: '', extra: '', softEmployee: true,
    });
  });
  return { rows: out, skipped: out.length ? null : 'no login and password found' };
}

function readAllSheets(file) {
  const wb = readWorkbook(file);
  const names = (wb.SheetNames || []).filter((nm) => !GUIDE_SHEETS.includes(hkey(nm)));
  const rows = []; const sheets = [];
  names.forEach((nm, si) => {
    const xs = wb.Sheets[nm];
    if (!xs || !xs['!ref']) { sheets.push({ name: nm, logins: 0, skipped: 'empty' }); return; }
    const grid = XLSX.utils.sheet_to_json(xs, { header: 1, raw: false, defval: '', blankrows: true });
    const r = smartSheet(nm, grid, (si + 1) * 10000);
    rows.push(...r.rows);
    sheets.push({ name: nm, logins: r.rows.length, skipped: r.skipped });
  });
  if (rows.length > MAX_ROWS) throw new VaultError(400, `That workbook has ${rows.length} logins. At most ${MAX_ROWS} at a time - split the file.`);
  return { rows, sheets, names };
}

async function employeeIndex() {
  const all = await prisma.employee.findMany({ select: { id: true, name: true, employeeCode: true, email: true, department: true, employmentStatus: true, user: { select: { email: true } } } });
  const by = { code: new Map(), email: new Map(), name: new Map() };
  const add = (m, k, e) => { if (!k) return; if (!m.has(k)) m.set(k, []); if (!m.get(k).some((y) => y.id === e.id)) m.get(k).push(e); };
  all.forEach((e) => { add(by.code, low(e.employeeCode), e); add(by.email, low(e.email), e); add(by.email, low(e.user && e.user.email), e); add(by.name, low(e.name), e); });
  by.all = all;
  return by;
}
const LEFT = ['Exited', 'Relieved', 'Terminated'];
// A team sheet writes people short: "B.Sneha", "S.Uma", "sailaja.b", "Ragini" (founder 2026-11-23: the import must find them in HRMS).
// Every word of 3+ letters must be one of the employee's name words, and a single letter must start another of them; a working
// employee wins over one who left, the row's department breaks a tie. Only ONE match counts.
const nameWords = (s) => low(s).replace(/[^a-z. ]/g, ' ').split(/[\s.]+/).filter(Boolean);
function fuzzyEmployees(ix, raw, dept) {
  const t = nameWords(raw); const main = t.filter((x) => x.length >= 3); const inits = t.filter((x) => x.length === 1);
  if (!main.length) return [];
  let hit = (ix.all || []).filter((e) => { const et = nameWords(e.name); return main.every((m) => et.includes(m)) && inits.every((i) => et.some((x) => !main.includes(x) && x.startsWith(i))); });
  if (!hit.length) hit = (ix.all || []).filter((e) => { const et = nameWords(e.name); return main.every((m) => et.some((x) => x.length >= 3 && (x.startsWith(m) || m.startsWith(x)))); });
  const working = hit.filter((e) => !LEFT.includes(e.employmentStatus)); if (working.length) hit = working;
  if (hit.length > 1 && dept) { const d = hit.filter((e) => low(e.department) === low(dept)); if (d.length) hit = d; }
  return hit;
}
function findEmployees(ix, raw) {
  const k = low(raw);
  if (!k) return [];
  const hit = ix.code.get(k) || ix.email.get(k) || ix.name.get(k) || ix.name.get(k.replace(/\s*\(.*\)$/, '')) || [];
  const working = hit.filter((e) => !LEFT.includes(e.employmentStatus));
  return working.length ? working : hit;
}
const empOpt = (e) => ({ id: e.id, name: e.name, code: e.employeeCode, department: e.department || '', status: e.employmentStatus });

// Resolve every row: Ready / Needs a choice / Refused. `rows` carry plaintext secrets only in this function's memory.
async function resolveRows(rows, choices = {}) {
  const ix = await employeeIndex();
  const existing = await q('SELECT "platformKey","usernameKey" FROM "Credential"');
  const known = new Set(existing.map((r) => `${r.platformKey}|${r.usernameKey}`));
  const seen = new Map();
  return rows.map((r) => {
    const out = {
      row: r.row, where: r.where || null, platform: canonicalPlatform(r.platform), label: r.label.slice(0, 150), loginUrl: '', username: r.username.slice(0, 200),
      hasPassword: !!r.password, password: r.password ? MASK : '', hasExtra: !!r.extra, extra: r.extra ? MASK : '',
      employeeText: r.employee, employees: [], department: r.department.slice(0, 100), notes: r.notes.slice(0, 2000), renewalDate: '',
      status: 'ready', reasons: [], choices: [],
    };
    if (/^example\b/i.test(r.label)) { out.status = 'skipped'; out.reasons.push('Example row from the template'); return out; }
    if (!out.platform) out.reasons.push('Platform is empty');
    if (!out.username) out.reasons.push('Username / Email is empty');
    if (r.password.length > 500) out.reasons.push('The password is longer than 500 characters');
    if (r.loginUrl) { try { out.loginUrl = cleanUrl(r.loginUrl); } catch { out.reasons.push('Login URL is not a web address'); } }
    if (r.renewalRaw !== '' && r.renewalRaw != null) {
      const d = parseCameDate(r.renewalRaw, { now: FAR });
      if (d.ok) out.renewalDate = d.day; else if (d.ok === false) out.reasons.push('Renewal date is not a date I can read');
    }
    // employees: one or several, separated by ; or ,
    const tokens = r.employee ? r.employee.split(/[;,]/).map((t) => squash(t)).filter(Boolean).slice(0, 20) : [];
    tokens.forEach((t, i) => {
      const key = `${r.row}:${i}`;
      let found = findEmployees(ix, t);
      if (!found.length && r.softEmployee) { const fz = fuzzyEmployees(ix, t, r.department); if (fz.length === 1) found = fz; }
      if (!found.length) {
        if (r.softEmployee) { out.notes = [`Person: ${t.slice(0, 60)} (no TeamLink employee with this name)`, out.notes].filter(Boolean).join('\n').slice(0, 2000); return; }
        out.reasons.push(`No employee "${t.slice(0, 60)}" in TeamLink`); return;
      }
      if (found.length === 1) { out.employees.push(empOpt(found[0])); return; }
      const picked = choices && choices[key] ? found.find((e) => e.id === String(choices[key])) : null;
      if (picked) { out.employees.push(empOpt(picked)); return; }
      if (r.softEmployee && !(choices && choices[key])) { out.notes = [`Person: ${t.slice(0, 60)} (${found.length} employees with this name - pick one after the import)`, out.notes].filter(Boolean).join('\n').slice(0, 2000); return; }
      out.choices.push({ key, text: t.slice(0, 60), options: found.slice(0, 20).map(empOpt) });
    });
    // no person on the row: the login's own e-mail can be a working employee's (sravanthi.m@tmlink.in)
    if (r.softEmployee && !tokens.length && out.username) {
      const byMail = (ix.email.get(low(out.username)) || []).filter((e) => !LEFT.includes(e.employmentStatus));
      if (byMail.length === 1) out.employees.push(empOpt(byMail[0]));
    }
    if (!out.department && out.employees.length === 1) out.department = out.employees[0].department;
    const k = `${platformKeyOf(out.platform)}|${usernameKeyOf(out.username)}`;
    if (out.platform && out.username) {
      if (known.has(k)) out.reasons.push(`Already in the vault: ${out.platform} login ${out.username}`);
      else if (seen.has(k)) out.reasons.push(`Same platform and username as row ${seen.get(k)} of this file`);
      else seen.set(k, r.row);
    }
    if (out.reasons.length) out.status = 'refused';
    else if (out.choices.length) out.status = 'choice';
    return out;
  });
}
const countsOf = (rows) => ({
  total: rows.filter((r) => r.status !== 'skipped').length, ready: rows.filter((r) => r.status === 'ready').length,
  choice: rows.filter((r) => r.status === 'choice').length, refused: rows.filter((r) => r.status === 'refused').length, skipped: rows.filter((r) => r.status === 'skipped').length,
});

async function purgeStale() {
  // a preview nobody applied: its encrypted payload is dropped after an hour
  await x('UPDATE "CredentialImportBatch" SET "payload" = NULL, "status" = \'expired\' WHERE "status" = \'preview\' AND "createdAt" < ?', new Date(Date.now() - PREVIEW_TTL_MS).toISOString());
}

// The batch keeps what Apply needs. The secrets in it are ciphertext (encrypted here, before the INSERT) and the payload is dropped
// on Apply, after an hour, or when a new preview replaces it. The uploaded file itself is never written anywhere.
function sealRows(rows) {
  return rows.map((r) => ({ ...r, password: r.password ? encOrRefuse(r.password) : '', extra: r.extra ? encOrRefuse(r.extra) : '' }));
}
function openRows(rows) {
  return rows.map((r) => {
    const p = r.password ? secrets.decryptSecret(r.password) : '';
    const e = r.extra ? secrets.decryptSecret(r.extra) : '';
    if (p === null || e === null) throw new VaultError(409, 'This preview cannot be read with the key the server has now. Upload the file again.');
    return { ...r, password: p, extra: e };
  });
}

async function preview(user, file, { mapping, sheet } = {}) {
  await purgeStale();
  let read = readSheet(file, mapping, sheet);
  let smartSheets = null;
  // only a workbook of several sheets, or one sheet named after a platform ("Naukri Logins"), is read the smart way
  const manySheets = (read.sheets || []).filter((nm) => !GUIDE_SHEETS.includes(hkey(nm))).length > 1;
  if (!mapping && ((manySheets && !sheet) || (read.missing.length && smartPlatformOf(read.sheet)))) {
    const all = readAllSheets(file);
    if (all.rows.length) {
      smartSheets = all.sheets;
      read = { ...read, sheet: 'All sheets', missing: [], rows: all.rows };
    }
  }
  if (read.missing.length) {
    return { needsMapping: true, missing: read.missing, fileColumns: read.fileColumns, mapping: read.mapping, sheet: read.sheet, sheets: read.sheets, rows: [], counts: countsOf([]) };
  }
  if (read.rows.some((r) => r.password || r.extra) && !secrets.secretsConfigured()) throw new VaultError(400, secrets.NO_KEY_MESSAGE, { code: 'NO_SECRET_KEY' });
  const sealed = sealRows(read.rows);
  const resolved = await resolveRows(read.rows);
  const id = newId('cb');
  const c = countsOf(resolved);
  await x('UPDATE "CredentialImportBatch" SET "payload" = NULL, "status" = \'expired\' WHERE "byUserId" = ? AND "status" = \'preview\'', user.id);
  await x(`INSERT INTO "CredentialImportBatch" ("id","byUserId","byName","fileName","createdAt","status","totalRows","readyRows","choiceRows","refusedRows","payload")
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, user.id, user.name || null, String((file && file.filename) || 'sheet').slice(0, 150), nowIso(), 'preview', c.total, c.ready, c.choice, c.refused, JSON.stringify({ rows: sealed }));
  return { batchId: id, fileColumns: read.fileColumns, mapping: read.mapping, sheet: read.sheet, sheets: read.sheets, smartSheets, rows: resolved, counts: c };
}

async function batchFor(user, batchId, statusWanted = 'preview') {
  const rows = await q('SELECT * FROM "CredentialImportBatch" WHERE "id" = ?', String(batchId || ''));
  const b = rows[0];
  if (!b) throw new VaultError(404, 'That import is not there any more. Upload the file again.');
  if (b.byUserId !== user.id && !isRealSuper(user)) throw new VaultError(403, 'That import belongs to someone else.');
  if (statusWanted && b.status !== statusWanted) throw new VaultError(409, b.status === 'expired' ? 'That preview is more than an hour old. Upload the file again.' : 'That import was already applied.');
  return b;
}

async function check(user, batchId, choices) {
  const b = await batchFor(user, batchId);
  const plain = openRows(JSON.parse(b.payload || '{"rows":[]}').rows || []);
  const resolved = await resolveRows(plain, choices || {});
  return { batchId: b.id, rows: resolved, counts: countsOf(resolved) };
}

async function apply(user, batchId, choices, ip) {
  const b = await batchFor(user, batchId);
  const plain = openRows(JSON.parse(b.payload || '{"rows":[]}').rows || []);
  const resolved = await resolveRows(plain, choices || {});
  const byRow = new Map(plain.map((r) => [r.row, r]));
  const at = nowIso(); const who = user.name || user.email || null;
  let created = 0;
  for (const r of resolved.filter((y) => y.status === 'ready')) {
    const src = byRow.get(r.row) || {};
    const pwEnc = src.password ? encOrRefuse(src.password) : null;
    const exEnc = src.extra ? encOrRefuse(JSON.stringify({ other: src.extra })) : null;
    // eslint-disable-next-line no-await-in-loop
    await x(`INSERT INTO "Credential" ("id","platform","platformKey","label","loginUrl","username","usernameKey","passwordEnc","extraEnc","extraKinds","assignedEmployeeIds",
      "department","ownerEmployeeId","ownerName","notes","renewalDate","lastRotatedAt","status","employeeCanSee","importBatchId","createdById","createdByName","createdAt","updatedById","updatedByName","updatedAt")
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    newId('cr'), r.platform, platformKeyOf(r.platform), r.label || null, r.loginUrl || null, r.username, usernameKeyOf(r.username), pwEnc, exEnc, exEnc ? 'Other secret' : null,
    JSON.stringify(r.employees.map((e) => e.id)), r.department || null, null, null, r.notes || null, r.renewalDate || null, null, 'active', 0, b.id, user.id, who, at, user.id, who, at);
    created += 1;
  }
  const c = countsOf(resolved);
  await x('UPDATE "CredentialImportBatch" SET "status" = \'applied\', "payload" = NULL, "appliedAt" = ?, "createdRows" = ?, "readyRows" = ?, "choiceRows" = ?, "refusedRows" = ? WHERE "id" = ?',
    at, created, c.ready, c.choice, c.refused, b.id);
  await logAccess(user, null, 'import', `${created} login(s) from ${b.fileName} (batch ${b.id})${c.refused ? `, ${c.refused} refused` : ''}${c.choice ? `, ${c.choice} waiting for a choice` : ''}`, ip);
  return { batchId: b.id, created, refused: c.refused, waiting: c.choice, fileName: b.fileName };
}

async function batches(user) {
  const all = isRealSuper(user);
  const rows = await q(`SELECT "id","byName","fileName","createdAt","status","totalRows","readyRows","choiceRows","refusedRows","createdRows","appliedAt","undoneAt","undoneByName","undoneRows","keptRows"
    FROM "CredentialImportBatch" WHERE "status" IN ('applied','undone')${all ? '' : ' AND "byUserId" = ?'} ORDER BY "createdAt" DESC LIMIT 30`, ...(all ? [] : [user.id]));
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])));
}

async function undo(user, batchId, ip) {
  const b = await batchFor(user, batchId, 'applied');
  const rows = await q('SELECT * FROM "Credential" WHERE "importBatchId" = ?', b.id);
  // a login somebody changed after the import is kept
  const untouched = rows.filter((r) => r.updatedAt === r.createdAt);
  for (const r of untouched) await x('DELETE FROM "Credential" WHERE "id" = ?', r.id); // eslint-disable-line no-await-in-loop
  const kept = rows.length - untouched.length;
  await x('UPDATE "CredentialImportBatch" SET "status" = \'undone\', "undoneAt" = ?, "undoneByName" = ?, "undoneRows" = ?, "keptRows" = ? WHERE "id" = ?', nowIso(), user.name || null, untouched.length, kept, b.id);
  await logAccess(user, null, 'undo_import', `${untouched.length} removed${kept ? `, ${kept} kept (changed since)` : ''} (batch ${b.id}, ${b.fileName})`, ip);
  return { batchId: b.id, removed: untouched.length, kept };
}

module.exports = {
  FEATURE, VaultError, CONFIRM_WORDS, MAX_BYTES, SHOW_SECONDS, REAUTH_MS, LOCK_AFTER, LOCK_MS, PLATFORMS, COLUMNS,
  readAllSheets, smartSheet, fuzzyEmployees,
  ensure, rightsFor, menuRightsFor, isRealSuper, reauth, checkReauth, list, detail, reveal, save, remove, bulk, historyOf, accessLog,
  grants, setGrant, options, exportBook, logAccess, template, preview, check, apply, batches, undo, canonicalPlatform, applyFilters,
};
