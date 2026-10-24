// ---------------------------------------------------------------------------
// WHO GETS THE ACCOUNTS REMINDERS (founder, 2026-10-19):
// "In Accounts, whichever reminder messages exist, they must go to the Accountant, not to the Admin."
//
// ONE place decides it, so every Accounts reminder / money notice asks the same question:
//   reminderRecipients()   -> { accountants, users, none, alsoAdmin }
//   warnNoAccountant(what) -> ONE visible notice to the Admin when nobody can be told
//
// WHO IS "THE ACCOUNTANT": an ACTIVE login whose Accounts role is ACCOUNTANT (the old `role: ACCOUNTANT` login counts too),
// re-checked against the live permission engine (utils/permissions.js): the Accounts product, an Accounts-desk role and the
// 'view' right on the feature the reminder is about (the Role Catalog may take it away). Admin / Super Admin are NOT recipients.
//
// ADMIN OPT-IN: AppSetting `proofReminders.settings` -> alsoAdmin (default false), the same Accounts -> Dashboard -> Proof
// reminder -> "Who gets the reminder" card. Only when it is switched on do the active Admin / Super Admin accounts receive the
// Accounts reminders as well.
//
// NO ACCOUNTANT: nothing is sent to the Admin in its place. Instead the Admin / Super Admin logins get ONE bell notice
// ("No accountant is set up") that says reminders could not be delivered. It is not repeated while it is unread, and not
// again for 7 days after it was read, so it never nags.
//
// TEST LOGINS (ZZTEST / example.test) never receive a real notice. Only the test sandbox, and only when a test sets
// ACCOUNTS_REMINDERS_ALLOW_TEST=1, lets them take part (so tests can prove who is told).
// ---------------------------------------------------------------------------
const prisma = require('../db');

const SETTINGS_KEY = 'proofReminders.settings';
const NOTICE_TITLE = 'No accountant is set up';
const REPEAT_DAYS = 7;
const TEST_RE = /zztest|example\.test/i;
const isTest = (u) => TEST_RE.test(`${(u && u.name) || ''} ${(u && u.email) || ''}`);

function testAllowed(allowTest) {
  if (allowTest !== undefined && allowTest !== null) return !!allowTest;
  const sandbox = require('./sandbox'); // eslint-disable-line global-require
  return sandbox.isSandbox() && process.env.ACCOUNTS_REMINDERS_ALLOW_TEST === '1';
}

// The founder's opt-in. A failed read is OFF (the safe side).
async function alsoAdmin() {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } });
    const v = row && row.value ? JSON.parse(row.value) : null;
    return !!(v && (v.alsoAdmin === true || v.alsoAdmin === 'true'));
  } catch { return false; }
}

// Active Accountant logins that may act on `feature` (default: Office & Expenses; the proof reminder asks for the Accounts Dashboard).
async function accountants({ allowTest, feature = 'Office & Expenses', product = 'accounts', module = 'accounts' } = {}) {
  const { resolveIdentity } = require('./identity'); // eslint-disable-line global-require
  const { can, roleForProduct, SET } = require('./permissions'); // eslint-disable-line global-require
  const rows = await prisma.user.findMany({
    where: { status: 'Active', OR: [{ accountsRole: 'ACCOUNTANT' }, { role: 'ACCOUNTANT' }] },
    select: { id: true, name: true, email: true, accountsRole: true },
    orderBy: { name: 'asc' },
  });
  const wantTest = testAllowed(allowTest);
  const out = [];
  for (const u of rows) {
    if (!wantTest && isTest(u)) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const id = await resolveIdentity(u.id).catch(() => null);
    if (!id || (id.status && id.status !== 'Active')) continue; // eslint-disable-line no-continue
    const role = roleForProduct(id, 'accounts');
    if (role !== 'ACCOUNTANT' || !SET.ACCOUNTS.includes(role)) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    if (feature && !(await can(id, product, module, feature, 'view').catch(() => false))) continue; // eslint-disable-line no-continue
    out.push({ id: u.id, name: u.name, email: u.email, accountsRole: 'ACCOUNTANT' });
  }
  return out;
}

// Active Admin / Super Admin logins (Accounts side). Used for the opt-in and for the "no accountant" warning.
async function admins({ allowTest } = {}) {
  const rows = await prisma.user.findMany({
    where: { status: 'Active', OR: [{ role: { in: ['SUPER_ADMIN', 'ADMIN'] } }, { accountsRole: { in: ['SUPER_ADMIN', 'ADMIN'] } }] },
    select: { id: true, name: true, email: true, accountsRole: true, role: true },
    orderBy: { name: 'asc' },
  });
  const wantTest = testAllowed(allowTest);
  return rows.filter((u) => wantTest || !isTest(u));
}

// -> { accountants, users, none, alsoAdmin }. `users` = who gets the reminder now. `none` = nobody can be told.
async function reminderRecipients({ allowTest, feature, kind } = {}) {
  // A named reminder kind reads the Admin's table (utils/accountsReminderSettings.js); with no kind it is the plain default (Accountants).
  if (kind) {
    const r = await require('./accountsReminderSettings').resolve(kind, { allowTest }); // eslint-disable-line global-require
    return { accountants: r.accountants, users: r.users, none: r.none, alsoAdmin: r.alsoAdmin, on: r.on, channels: r.channels, owner: r.owner, custom: r.custom, peopleCustom: r.peopleCustom, timing: r.timing, skipped: r.skipped };
  }
  const team = await accountants({ allowTest, feature });
  const opted = await alsoAdmin();
  let users = team.slice();
  if (opted) {
    const seen = new Set(users.map((u) => u.id));
    (await admins({ allowTest })).forEach((a) => { if (!seen.has(a.id)) { seen.add(a.id); users.push({ id: a.id, name: a.name, email: a.email, accountsRole: a.accountsRole || a.role }); } });
  }
  users = users.filter((u, i, a) => a.findIndex((x) => x.id === u.id) === i);
  return { accountants: team, users, none: users.length === 0, alsoAdmin: opted, on: true };
}

// ONE notice at a time. Serialised, so two reminders that find nobody at the same moment still write one row per Admin.
let chain = Promise.resolve();
function warnNoAccountant(what, opts = {}) {
  return warnTitled(NOTICE_TITLE, defaultMessage(what), opts);
}
// A kind that is ON but resolves to nobody: the default row keeps the 'No accountant is set up' notice, a row the Admin changed says 'No one will receive <reminder>'.
async function warnNoRecipients(kind, what, opts = {}) {
  const RS = require('./accountsReminderSettings'); // eslint-disable-line global-require
  const def = RS.kindDef(kind);
  const st = await RS.effective(kind);
  if (!def || !st.on) return { notified: 0, reason: 'off' };
  if (!st.peopleCustom) return warnNoAccountant(what, opts);
  return warnTitled(`No one will receive: ${def.title}`, `Nobody is chosen (or every chosen person is switched off), so this reminder could not be delivered and was not sent to anyone else. Open Accounts, Dashboard, Proof reminder, Who gets each reminder, and choose people.${what ? ` Waiting now: ${String(what).slice(0, 120)}.` : ''}`, opts);
}
function warnTitled(title, message, opts = {}) {
  const job = chain.then(() => warn(title, message, opts));
  chain = job.catch(() => null);
  return job.catch((err) => { console.error('[accounts-reminders] no-accountant notice:', err && err.message); return { notified: 0 }; }); // eslint-disable-line no-console
}
const defaultMessage = (what) => `Accounts reminders could not be delivered, because nobody is set to receive them: no active login has the Accountant role and the named person (Purna Chandra) is not active either. Nothing was sent to the Admin instead. Give someone the Accountant role (Administration > Users) or choose people in Accounts, Dashboard, Who gets each reminder.${what ? ` Waiting now: ${String(what).slice(0, 120)}.` : ''}`;
async function warn(title, message, { allowTest } = {}) {
  const to = await admins({ allowTest });
  if (!to.length) return { notified: 0, reason: 'no admin to tell' };
  const since = new Date(Date.now() - REPEAT_DAYS * 86400000);
  const prior = await prisma.notification.findMany({
    where: { title, userId: { in: to.map((u) => u.id) } },
    select: { userId: true, read: true, createdAt: true },
  });
  const blocked = new Set(prior.filter((p) => !p.read || p.createdAt > since).map((p) => p.userId));
  const fresh = to.filter((u) => !blocked.has(u.id));
  if (!fresh.length) return { notified: 0, reason: 'already told' };
  await prisma.notification.createMany({
    data: fresh.map((u) => ({
      userId: u.id, title, message,
    })),
  });
  return { notified: fresh.length };
}

module.exports = {
  accountants, admins, reminderRecipients, warnNoAccountant, warnNoRecipients, testAllowed, alsoAdmin, NOTICE_TITLE, SETTINGS_KEY, isTest,
};
