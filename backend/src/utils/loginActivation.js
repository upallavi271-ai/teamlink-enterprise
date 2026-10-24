// ---------------------------------------------------------------------------
// THE ACTIVATION MAIL OF A LOGIN (founder, 2026-10-21): "Your Accounts login TL-LOGIN-102 is ready - choose your password".
//
// An Admin never types or sees a password for a separate login. The person gets ONE mail with a single-use link that is bound to THAT account
// (the link's hash sits on that User row; using it can only ever set that row's password). It names the role and department of the login, so a person
// with three logins on one email knows which one they are activating. It never mentions the other logins, and never contains a password.
//
// The token machinery is the existing one (utils/employeeInvite.js issueSetPasswordToken / redeemSetPasswordToken, the public page
// /set-password/:token): no second activation system. A newer link replaces the older one of the SAME account only.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const invite = require('./employeeInvite');
const LA = require('./loginAccounts');
const PR = require('./passwordReset');

const TTL_HOURS = invite.SET_PASSWORD_TTL_HOURS;

function buildActivationEmail({ label, name, link, expiresAt, hasLogo = false }) {
  const subject = `Set your TeamLink password - ${label}`;
  const until = PR.whenText(expiresAt);
  const text = [
    `Hello ${name || ''},`.replace(/\s+,/, ','),
    '',
    `Your ${label} login is ready.`,
    '',
    'Choose your own password with this link. It works once and stops working at the time below:',
    '',
    link,
    '',
    `The link stops working in ${TTL_HOURS} hours (at ${until}).`,
    '',
    'To sign in later, type your email and this password on the TeamLink sign-in page.',
    'If you give more than one of your logins the same password, TeamLink asks which one you want to open. A different password for each login keeps them apart.',
    '',
    "Didn't expect this? Ignore this email: nothing changes unless somebody uses the link.",
    '',
    'We never send passwords by email.',
    '',
    '- TeamLink',
  ].join('\n');
  const inner = [
    PR.para(`Hello ${PR.esc(name || '')},`),
    PR.para(`Your <b>${PR.esc(label)}</b> login is ready.`),
    PR.para('Choose your own password. The button works once.'),
    PR.btn(link, 'Set my password'),
    PR.para(`Button not working? Copy this link into your browser:<br><a href="${PR.esc(link)}" style="color:#1d4ed8;word-break:break-all;font-size:12px">${PR.esc(link)}</a>`),
    PR.para(`<b>The link stops working in ${TTL_HOURS} hours</b> (at ${PR.esc(until)}).`),
    PR.para('To sign in later, type your email and this password on the TeamLink sign-in page. If you give more than one of your logins the same password, TeamLink asks which one to open; a different password for each login keeps them apart.'),
    PR.para("<b>Didn't expect this?</b> Ignore this email. Nothing changes unless somebody uses the link.", 'background:#f0f9ff;border-radius:8px;padding:10px 12px'),
  ].join('');
  return { subject, text, html: PR.shell({ title: subject, inner, hasLogo }) };
}

// -> { sent, status, role, expiresAt, link? }   (link only when the mail could not be sent, so the Admin can pass it on)
async function sendActivation({ user, byUser = null }) {
  const issued = await invite.issueSetPasswordToken(user.id);
  const link = `${PR.baseUrl()}/set-password/${issued.token}`;
  const mine = await LA.accountsByEmail(user.email);
  const sums = await LA.summariesFor(mine.some((m) => m.id === user.id) ? mine : [user]);
  const me = sums.find((x) => x.id === user.id) || { mailLabel: LA.roleLabelOf(user), role: LA.roleLabelOf(user) };
  const label = me.mailLabel;
  const role = me.role;
  const to = String(user.email || '').trim();
  if (!PR.looksLikeEmail(PR.normEmail(to))) {
    return { sent: false, status: 'Not sent: this login has no usable email address.', role, expiresAt: issued.expiresAt, link };
  }
  const res = await PR.deliver({ to, kind: 'login-activation', build: (hasLogo) => buildActivationEmail({ label, name: user.name, link, expiresAt: issued.expiresAt, hasLogo }) });
  const { logAudit } = require('./audit'); // eslint-disable-line global-require
  await logAudit({
    userId: byUser ? byUser.id : null, action: `Activation link ${res.ok ? 'emailed' : 'made (not emailed)'} for the ${label} login`, entity: 'User', entityId: user.id,
    toValue: res.ok ? 'Link emailed' : `Not emailed - ${res.reason}`,
  }).catch(() => {});
// The employee screens show "credentials sent" for the person's MAIN login; keep that line honest.
  try {
    const emp = await prisma.employee.findUnique({ where: { userId: user.id }, select: { id: true } });
    if (emp) {
      await prisma.employee.update({
        where: { id: emp.id },
        data: res.ok
          ? { credentialsSentStatus: `Sent to ${to} (set-password link)`, credentialsSentAt: new Date() }
          : { credentialsSentStatus: `Not sent - ${String(res.reason).slice(0, 200)}`, credentialsSentAt: null },
      });
    }
  } catch { /* a status line is never worth failing the mail */ }
  if (res.ok) return { sent: true, status: `Emailed to ${to}`, role, expiresAt: issued.expiresAt };
  return { sent: false, status: `Not emailed: ${res.reason}`, role, expiresAt: issued.expiresAt, link };
}

module.exports = { sendActivation, buildActivationEmail, TTL_HOURS };
