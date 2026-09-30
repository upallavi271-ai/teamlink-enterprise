// ---------------------------------------------------------------------------
// DATA IN / DATA OUT — "whenever someone exports or imports, a reminder must
// go to the Super Admin" (the user's rule, 2026-09-29).
//
// ONE helper, used by every export and every import in the app:
//
//   notifyDataIo(req, { kind, module, count, created, updated, skipped, what })
//
//   kind     'export' | 'import' | 'import-request' | 'import-approved' | 'import-rejected'
//   module   the screen, as the user knows it ("Employee Management", "Leave")
//   count    rows exported / rows in the file
//   what     the noun for the rows ("employee records", "leave requests")
//
// For each call it writes
//   * an AuditLog row (entity 'DataIO') — the permanent trail;
//   * an in-app Notification for every active Super Admin (not the actor);
//   * an EMAIL to those Super Admins through the existing mailer — THROTTLED:
//     one person's burst of exports/imports inside a minute produces ONE
//     summary email, sent when the minute is up.
//
// TEST IDENTITIES NEVER REACH A REAL SUPER ADMIN (agent rules, 2026-09-29).
// When the actor's name / email carries ZZTEST or example.test, only Super
// Admins that are themselves test identities are notified, in-app only, and
// no email is ever sent. A real actor is never routed to a test Super Admin.
// DATA_IO_EMAIL=off in the environment switches the email half off entirely.
//
// Never throws: a notification is a side effect of the export, not the export.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');

const THROTTLE_MS = Number(process.env.DATA_IO_EMAIL_WINDOW_MS || 60000);
const TEST_RE = /zztest|example\.test/i;

const ROLE_NAMES = {
  SUPER_ADMIN: 'Super Admin', ADMIN: 'Admin', MANAGER: 'Manager', ASSISTANT_MANAGER: 'Assistant Manager',
  STL: 'STL', TL: 'TL', HR: 'HR', RECRUITER: 'Recruiter', BDE: 'BDE', ACCOUNTANT: 'Accountant',
  EMPLOYEE: 'Employee', CLIENT: 'Client', CANDIDATE: 'Candidate',
};

const isTestIdentity = (u) => !!u && (TEST_RE.test(String(u.name || '')) || TEST_RE.test(String(u.email || '')));

function roleLabelOf(user) {
  if (!user) return 'unknown role';
  // The HRMS role answers for HRMS screens; fall back to the account role.
  const code = (user.hrmsRole && user.hrmsRole !== 'NONE' ? user.hrmsRole : null) || user.role || '';
  if (ROLE_NAMES[code]) return ROLE_NAMES[code];
  return String(code).replace(/^CUSTOM_/, '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) || 'unknown role';
}

function whenText(d = new Date()) {
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// "Vasu (HR) exported 42 employee records from Employee Management at 29 Sept 2026, 10:14 am"
function sentence({ actor, role, kind, module, count, created, updated, skipped, what, at }) {
  const n = (v) => Number(v || 0);
  const noun = what || 'records';
  const who = `${actor} (${role})`;
  if (kind === 'export') return `${who} exported ${n(count)} ${noun} from ${module} at ${at}.`;
  if (kind === 'import') {
    return `${who} imported ${noun} into ${module} at ${at} — created ${n(created)}, updated ${n(updated)}`
      + `${skipped ? `, skipped ${n(skipped)}` : ''}.`;
  }
  if (kind === 'import-request') {
    return `${who} requested an import of ${n(count)} ${noun} into ${module} at ${at}. Nothing changes until a Super Admin approves it (Employee Management → Import requests).`;
  }
  if (kind === 'import-approved') {
    return `${who} approved an import request for ${module} at ${at} — created ${n(created)}, updated ${n(updated)}.`;
  }
  if (kind === 'import-rejected') return `${who} rejected an import request for ${module} at ${at}.`;
  return `${who} — ${kind} — ${module} at ${at}.`;
}

const TITLES = {
  export: 'Data export',
  import: 'Data import',
  'import-request': 'Import request waiting',
  'import-approved': 'Import request approved',
  'import-rejected': 'Import request rejected',
};

// Active Super Admins, split by the test rule above.
async function superAdminsFor(actor) {
  const rows = await prisma.user.findMany({
    where: { status: 'Active', OR: [{ role: 'SUPER_ADMIN' }, { hrmsRole: 'SUPER_ADMIN' }] },
    select: { id: true, name: true, email: true },
  });
  const testActor = isTestIdentity(actor);
  return rows.filter((u) => u.id !== (actor && actor.id) && (testActor ? isTestIdentity(u) : !isTestIdentity(u)));
}

// ---- the throttled email ---------------------------------------------------
// actorId -> { lines: [], actor, timer }
const pending = new Map();

async function flush(actorId) {
  const entry = pending.get(actorId);
  pending.delete(actorId);
  if (!entry || !entry.lines.length) return;
  try {
    // eslint-disable-next-line global-require
    const mailer = require('./mailer');
    const recipients = (await superAdminsFor(entry.actor)).filter((u) => u.email && !mailer.isReservedTestAddress(u.email));
    if (!recipients.length) return;
    const one = entry.lines.length === 1;
    const subject = one
      ? `TeamLink: ${entry.lines[0].subject}`
      : `TeamLink: ${entry.actor.name || 'A user'} made ${entry.lines.length} data exports/imports in the last minute`;
    const text = [
      'Data export / import notice from TeamLink.',
      '',
      ...entry.lines.map((l) => `• ${l.text}`),
      '',
      'Every export and import is also recorded in Administration → Audit Logs (entity "DataIO").',
      'This notice is sent to every Super Admin; bursts within one minute are combined into one email.',
    ].join('\n');
    // eslint-disable-next-line no-restricted-syntax
    for (const r of recipients) {
      // eslint-disable-next-line no-await-in-loop
      const sent = await mailer.sendMail({ to: r.email, subject, text, useEmployeeFrom: false });
      // The Notifications screen is the central channel log: record what
      // really happened to the email, honestly.
      // eslint-disable-next-line no-await-in-loop
      await prisma.notification.create({
        data: {
          userId: null,
          title: subject.slice(0, 190),
          message: text.slice(0, 4000),
          channel: 'Email',
          recipient: r.email,
          status: sent.ok ? 'Sent' : (sent.notConfigured ? 'Not sent — no email provider' : `Failed: ${String(sent.error || '').slice(0, 150)}`),
        },
      }).catch(() => {});
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[dataIoNotify] email flush failed: %s', err && err.message);
  }
}

function queueEmail(actor, line) {
  if (String(process.env.DATA_IO_EMAIL || '').toLowerCase() === 'off') return;
  if (isTestIdentity(actor)) return; // tests never email anybody
  const key = actor.id || 'anonymous';
  let entry = pending.get(key);
  if (!entry) {
    entry = { lines: [], actor, timer: null };
    pending.set(key, entry);
    entry.timer = setTimeout(() => { flush(key); }, THROTTLE_MS);
  }
  entry.lines.push(line);
}

/**
 * Record + notify one export/import. Returns { message, notified } and never throws.
 * opts.email === false suppresses the email half for this call (in-app + audit still happen).
 */
async function notifyDataIo(req, opts = {}) {
  try {
    const actor = (req && req.user) || opts.actor || {};
    const kind = opts.kind || 'export';
    const module = opts.module || 'TeamLink';
    const at = whenText();
    const role = roleLabelOf(actor);
    const actorName = actor.name || actor.email || 'Someone';
    const message = sentence({
      actor: actorName, role, kind, module, count: opts.count, created: opts.created, updated: opts.updated,
      skipped: opts.skipped, what: opts.what, at,
    });
    await logAudit({
      userId: actor.id || null,
      actorName,
      action: `Data ${kind} — ${module}`,
      entity: 'DataIO',
      entityId: opts.entityId || null,
      field: kind,
      fieldLabel: opts.format ? String(opts.format).toUpperCase() : null,
      toValue: message,
      reason: opts.detail ? String(opts.detail).slice(0, 1000) : null,
    });
    const admins = await superAdminsFor(actor);
    const title = `${TITLES[kind] || 'Data'} — ${module}`;
    await Promise.all(admins.map((u) => prisma.notification.create({
      data: { userId: u.id, title, message, channel: 'In-App', recipient: u.name || u.email, status: 'Sent' },
    }).catch(() => null)));
    if (opts.email !== false) {
      const subject = kind === 'export'
        ? `${actorName} exported ${Number(opts.count || 0)} ${opts.what || 'records'} from ${module}`
        : `${actorName} — ${TITLES[kind] || kind} — ${module}`;
      queueEmail(actor, { subject, text: message });
    }
    return { message, notified: admins.length };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[dataIoNotify] %s', err && err.message);
    return { message: null, notified: 0 };
  }
}

module.exports = {
  notifyDataIo, isTestIdentity, roleLabelOf, superAdminsFor,
  // for tests only
  _pendingEmails: pending, _flush: flush, _queueEmail: queueEmail,
};
