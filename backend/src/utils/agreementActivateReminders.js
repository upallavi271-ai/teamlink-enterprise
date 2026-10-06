// ---------------------------------------------------------------------------
// "THE CLIENT SIGNED — MAKE IT ACTIVE" (user, 2026-10-05).
//
//   notifyClientSigned(client)   right when the client signs on the link: the
//                                bell to the owner BDE (+ secondary BDE) and
//                                EVERY active Admin + Super Admin:
//                                "Vcare signed the agreement. Sign & stamp for
//                                TeamLink and make it Active." — opening it
//                                goes to the client's Agreement card.
//   sweepActivateReminders()     while it stays Signed-not-Active: the same
//                                people again at Agreement settings' time
//                                (default 10:00 IST), every N days (default 1),
//                                saying how long it has waited. No repeat to a
//                                person whose previous reminder is unread and
//                                under 24 h old. Stops by itself once Active,
//                                stopped (back to Draft), archived or deleted.
//                                Email to those STAFF only when "Also email
//                                staff" is switched on (off by default) —
//                                never to the client.
// Test logins (ZZTEST / example.test) never receive a reminder about a real
// client (agent-rules LESSON 2026-09-29).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');
const { notifyUsers } = require('./notify');

const REMIND_ACTION = 'Agreement make-Active reminder sent';
const isTestText = (v) => /zztest|example\.test/i.test(String(v || ''));
const cardPath = (id) => `/clients/${id}?tab=agreement`;
const DAY = 86400000;
// Asia/Kolkata (no daylight saving): the IST wall clock of a Date.
const ist = (d) => new Date(d.getTime() + 330 * 60000);
const istDay = (d) => ist(d).toISOString().slice(0, 10);

// The owner BDE (+ secondary BDE) and every active Admin / Super Admin.
async function staffFor(client) {
  const names = [client.bdeOwner, client.secondaryBde].map((n) => String(n || '').trim()).filter(Boolean);
  const rows = await prisma.user.findMany({
    where: {
      status: 'Active',
      OR: [
        { role: { in: ['SUPER_ADMIN', 'ADMIN'] } },
        { atsRole: { in: ['SUPER_ADMIN', 'ADMIN'] } },
        ...(names.length ? [{ name: { in: names } }] : []),
      ],
    },
    select: { id: true, name: true, email: true, role: true, atsRole: true },
  });
  const testClient = isTestText(client.name);
  return rows.filter((u) => testClient || !(isTestText(u.name) || isTestText(u.email)));
}

function signedText(client) {
  return {
    title: `${client.name} signed the agreement`,
    message: `${client.name} signed the agreement. Sign & stamp for TeamLink and make it Active.\nOpen: ${cardPath(client.id)}`,
  };
}

// Right after the client signs (not when it already went Active by itself).
async function notifyClientSigned(client) {
  const staff = await staffFor(client);
  await notifyUsers(staff.map((u) => u.id), signedText(client));
  return staff.length;
}

async function maybeEmail(settings, staff, title, text) {
  if (!settings.activeReminderEmail) return 0;
  // eslint-disable-next-line global-require
  const messaging = require('./messaging');
  let sent = 0;
  // eslint-disable-next-line no-restricted-syntax
  for (const u of staff) {
    if (!u.email) continue;
    // eslint-disable-next-line no-await-in-loop
    const r = await messaging.send('Email', { to: u.email, subject: title, text: text.replace(/\nOpen: (\/\S+)/, ''), fromName: '' });
    if (r.ok) sent += 1;
  }
  return sent;
}

// Once per due day per client. `now` lets a test move the clock.
async function sweepActivateReminders({ now = new Date(), onlyClientIds = null } = {}) {
  // eslint-disable-next-line global-require
  const settings = await require('./agreementSettings').agreementSettings({ fresh: true });
  const [hh, mm] = String(settings.activeReminderTime || '10:00').split(':').map(Number);
  const w = ist(now);
  const out = { checked: 0, reminded: [], skipped: [] };
  if (w.getUTCHours() * 60 + w.getUTCMinutes() < hh * 60 + mm) return { ...out, notYet: true };
  const clients = await prisma.client.findMany({
    where: {
      agreementStatus: 'SIGNED',
      NOT: [{ status: 'Archived' }],
      ...(onlyClientIds ? { id: { in: onlyClientIds } } : {}),
    },
  });
  out.checked = clients.length;
  const every = Math.max(1, Number(settings.activeReminderEveryDays) || 1);
  // eslint-disable-next-line no-restricted-syntax
  for (const c of clients) {
    if (!onlyClientIds && isTestText(c.name)) continue;
    const signedAt = c.agreementSignedAt ? new Date(c.agreementSignedAt) : null;
    // The first reminder is the day after signing (the sign notice went that day).
    if (!signedAt || istDay(signedAt) === istDay(now)) { out.skipped.push({ id: c.id, why: 'signed today' }); continue; }
    // eslint-disable-next-line no-await-in-loop
    const last = await prisma.auditLog.findFirst({ where: { entity: 'Client', entityId: c.id, action: REMIND_ACTION }, orderBy: { createdAt: 'desc' }, select: { toValue: true } });
    if (last && last.toValue) {
      const gap = Math.round((new Date(`${istDay(now)}T00:00:00Z`) - new Date(`${last.toValue}T00:00:00Z`)) / DAY);
      if (gap < every) { out.skipped.push({ id: c.id, why: 'already today' }); continue; }
    }
    // Calendar days in India time since the signing ("waiting 2 days").
    const days = Math.max(1, Math.round((new Date(`${istDay(now)}T00:00:00Z`) - new Date(`${istDay(signedAt)}T00:00:00Z`)) / DAY));
    const title = `${c.name}: signed agreement waiting to be made Active`;
    const message = `${c.name} signed the agreement ${days} day${days === 1 ? '' : 's'} ago (waiting ${days} day${days === 1 ? '' : 's'}). Sign & stamp for TeamLink and make it Active.\nOpen: ${cardPath(c.id)}`;
    // eslint-disable-next-line no-await-in-loop
    const staff = await staffFor(c);
    // Not again to someone whose last reminder is unread and under 24 h old.
    // eslint-disable-next-line no-await-in-loop
    const recent = await prisma.notification.findMany({
      where: { userId: { in: staff.map((u) => u.id) }, title, read: false, createdAt: { gte: new Date(now.getTime() - DAY) } },
      select: { userId: true },
    });
    const skip = new Set(recent.map((r) => r.userId));
    const to = staff.filter((u) => !skip.has(u.id));
    // eslint-disable-next-line no-await-in-loop
    await notifyUsers(to.map((u) => u.id), { title, message });
    // eslint-disable-next-line no-await-in-loop
    const emailed = await maybeEmail(settings, to, title, message);
    // eslint-disable-next-line no-await-in-loop
    await logAudit({ action: REMIND_ACTION, entity: 'Client', entityId: c.id, toValue: istDay(now), reason: `${to.length} person(s) reminded in the app${emailed ? `, ${emailed} by email` : ''} · waiting ${days} day(s)` });
    out.reminded.push({ id: c.id, name: c.name, people: to.length, days });
  }
  return out;
}

module.exports = { notifyClientSigned, sweepActivateReminders, REMIND_ACTION, staffFor, cardPath };
