const prisma = require('../db');

// In-app notification helper — the app's equivalent of the prototype's
// pushNotification(). Writes into the Notification model that the existing
// Administration > Notifications page already reads (see routes/admin.js),
// rather than introducing a second notification store.
async function pushNotification({ userId, title, message }) {
  if (!userId || !title) return null;
  return prisma.notification.create({ data: { userId, title, message } });
}

// Same, for a set of user ids — duplicates and empty ids are dropped, and the
// acting user never gets notified about their own action.
// AGREEMENTS ARE NOT FOR TLs / STLs / RECRUITERS / HR (user, 2026-10-12): a line about an agreement is never
// written for such a login, whoever asked for it (utils/agreementPrivacy.js). The BDE team lead (a TL of the BDE
// department) and the Admins are not among them.
const ABOUT_AGREEMENT = /agreement|\be-?sign/i;
async function dropAgreementBlind(ids, title, message) {
  if (!ids.size || !ABOUT_AGREEMENT.test(`${title || ''} ${message || ''}`)) return;
  const users = await prisma.user.findMany({
    where: { id: { in: [...ids] }, OR: [{ atsRole: { in: ['TL', 'STL', 'RECRUITER', 'HR'] } }, { role: { in: ['TL', 'STL', 'RECRUITER', 'HR'] } }] },
    select: { id: true, role: true, atsRole: true, atsDepartment: true, atsScopeDepartments: true },
  }).catch(() => []);
  users.forEach((u) => {
    const bdeTl = (u.atsRole === 'TL' || u.role === 'TL') && (u.atsDepartment === 'BDE' || /(^|,)\s*BDE\s*(,|$)/.test(u.atsScopeDepartments || ''));
    const admin = ['SUPER_ADMIN', 'ADMIN'].includes(u.role) || ['SUPER_ADMIN', 'ADMIN'].includes(u.atsRole);
    if (!bdeTl && !admin) ids.delete(u.id);
  });
}
async function notifyUsers(userIds, { title, message, exceptUserId } = {}) {
  const ids = new Set((userIds || []).filter(Boolean));
  if (exceptUserId) ids.delete(exceptUserId);
  await dropAgreementBlind(ids, title, message);
  if (ids.size === 0) return [];
  return Promise.all([...ids].map((userId) => pushNotification({ userId, title, message })));
}

module.exports = { pushNotification, notifyUsers };
