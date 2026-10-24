// ---------------------------------------------------------------------------
// ALERT THE OVERALL-ACCESS PEOPLE when a login link is made for a PARTNER or a
// VENDOR (security fix 2026-10-13) - the same recipients as the staff password
// alerts (utils/passwordReset.js readSetting: Super Admin by default, Admin if
// ticked in Company Setup). Names only, never a link or a password.
// ---------------------------------------------------------------------------
const prisma = require('../db');

async function alertLoginLink({ kind, who, orgName, purpose, by }) {
  try {
    const PR = require('./passwordReset'); // eslint-disable-line global-require
    const setting = await PR.readSetting();
    const people = await prisma.user.findMany({ where: { status: 'Active', role: { in: setting.roles } }, select: { id: true } });
    const { notifyUsers } = require('./notify'); // eslint-disable-line global-require
    await notifyUsers(people.map((p) => p.id), {
      title: `${kind} ${purpose === 'reset' ? 'password reset link' : 'sign-in link'} made`,
      message: `${by && by.name ? by.name : 'An Admin'} made a ${purpose === 'reset' ? 'password reset link' : 'first sign-in link'} for ${kind.toLowerCase()} ${who}${orgName ? ` (${orgName})` : ''}. The ${kind.toLowerCase()} chooses their own password; nobody sees it.`,
      exceptUserId: by && by.id,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[outsideLoginAlert]', e && e.message);
  }
}

module.exports = { alertLoginLink };
