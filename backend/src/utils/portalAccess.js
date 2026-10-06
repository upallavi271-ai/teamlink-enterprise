// ---------------------------------------------------------------------------
// Portal logins for people OUTSIDE the company — a client's contact and a
// candidate. (User notes #4, points 3–4: "what the client login and the
// candidate login show, and when they get a login".)
//
// THE RULE — one identity per person, and nobody is ever emailed a password.
//
//   CLIENT login     created when SA / Admin / the client's BDE presses
//                    "Invite to portal" on the client (Client 360). The Client
//                    360 highlights the button once the agreement is Sent or
//                    Active and there is no login yet. One login per client
//                    contact email, tied to that one client (User.clientId).
//
//   CANDIDATE login  created when
//                      (a) the candidate asks for one — "Get my sign-in link"
//                          on the public My Applications page, using the email
//                          they applied with (POST /api/portal/public/claim),
//                          which only ever MAILS the link to that address; or
//                      (b) their recruiter presses "Invite to portal" on the
//                          candidate (Candidate 360).
//                    One login per Candidate row (User.candidateId).
//
// In every case the person gets a SINGLE-USE, EXPIRING set-password link —
// the same token the employee onboarding uses (utils/employeeInvite.js): 32
// random bytes, only the SHA-256 hash stored, 48 h expiry, burned on use.
// Pressing Invite again re-issues the link (the old one stops working); it
// never makes a second login.
//
// Nothing here sends automatically: an invite is always somebody pressing a
// button (or the candidate asking). Reserved test domains (example.test …) are
// refused by utils/mailer.js and the link is handed back to the inviter.
// ---------------------------------------------------------------------------

const prisma = require('../db');
const { sendMail } = require('./mailer');
const {
  issueSetPasswordToken, unguessablePasswordHash, appBaseUrl, SET_PASSWORD_TTL_HOURS,
} = require('./employeeInvite');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const norm = (e) => String(e || '').trim().toLowerCase();

// The login already linked to this client / candidate, if any.
async function portalLoginFor(kind, recordId) {
  if (!recordId) return null;
  const where = kind === 'client' ? { clientId: recordId, role: 'CLIENT' } : { candidateId: recordId, role: 'CANDIDATE' };
  return prisma.user.findFirst({
    where,
    select: {
      id: true, email: true, name: true, status: true, lastLoginAt: true, createdAt: true,
      setPasswordTokenHash: true, setPasswordExpiresAt: true, setPasswordUsedAt: true, passwordChangedAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });
}

// What the inviter's screen shows — never a hash, never a link.
function loginSummary(u) {
  if (!u) return { exists: false };
  const pendingLink = !!(u.setPasswordTokenHash && u.setPasswordExpiresAt && u.setPasswordExpiresAt > new Date());
  return {
    exists: true,
    email: u.email,
    status: u.status,
    lastLoginAt: u.lastLoginAt,
    invitedAt: u.createdAt,
    // "Invited — waiting for them to set a password" vs "Active — signed in".
    state: u.lastLoginAt ? 'Signed in' : (pendingLink ? 'Invite sent — password not set yet' : 'Invited'),
    linkExpiresAt: pendingLink ? u.setPasswordExpiresAt : null,
  };
}

function inviteText({ kind, name, companyName, link, expiresAt }) {
  const when = expiresAt.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const what = kind === 'client'
    ? 'see your requirements, review the candidates we share with you, give your decisions and follow interviews and joinings'
    : 'see all your applications and their status, your interview details, update your profile and resume, and apply to new jobs';
  return [
    `Hi ${name || 'there'},`,
    '',
    `You now have a ${companyName} portal login. There you can ${what}.`,
    '',
    kind === 'candidate'
      ? `Open this link, confirm your email with the 6-digit code we send to it, and (if you like) choose a password. The link works once and expires on ${when}:`
      : `Choose your own password using this link. It works once and expires on ${when}:`,
    '',
    link,
    '',
    'We never send passwords by email. If you did not expect this message, please ignore it.',
    '',
    `— ${companyName}`,
  ].join('\n');
}

async function companyName() {
  const c = await prisma.company.findFirst({ select: { name: true } }).catch(() => null);
  return (c && c.name) || 'TeamLink';
}

// Creates the login if there is none, then (re)issues the one-time link.
// `send` false = do not mail (the inviter passes the link on themselves).
// Returns { created, user, link?, expiresAt, sent, status }.
async function inviteToPortal({ kind, record, email, name, req, actingUser, send }) {
  const addr = norm(email);
  if (!EMAIL_RE.test(addr)) return { error: 'A valid email address is needed to invite them to the portal.', status: 400 };

  let user = await portalLoginFor(kind, record.id);
  let created = false;
  if (user && norm(user.email) !== addr) {
    return { error: `This ${kind} already has a portal login (${user.email}). Re-send the invite to that address, or change it on Administration → Users.`, status: 409 };
  }
  if (!user) {
    // ONE PERSON, ONE LOGIN. An address that already signs in as somebody
    // else (an employee, another client, another candidate) is never reused.
    const [taken] = await prisma.$queryRaw`SELECT id FROM User WHERE lower(trim(email)) = ${addr} LIMIT 1`;
    if (taken) return { error: 'That email already has a TeamLink login, so a second one cannot be created for it.', status: 409 };
    const u = await prisma.user.create({
      data: {
        name: String(name || record.name || addr).slice(0, 120),
        email: addr,
        username: addr,
        passwordHash: await unguessablePasswordHash(),
        role: kind === 'client' ? 'CLIENT' : 'CANDIDATE',
        atsRole: kind === 'client' ? 'CLIENT' : 'CANDIDATE',
        hrmsRole: 'NONE',
        accountsRole: 'NONE',
        atsAccess: true,
        hrmsAccess: false,
        accountsAccess: false,
        clientId: kind === 'client' ? record.id : null,
        candidateId: kind === 'candidate' ? record.id : null,
        // A candidate's login stays 'Invited' (inert — nobody knows its
        // password) until they prove the email with a one-time code on the
        // invite page (routes/portalPublic.js, spec B2).
        status: kind === 'candidate' ? 'Invited' : 'Active',
      },
    });
    user = u;
    created = true;
  }

  const { token, expiresAt } = await issueSetPasswordToken(user.id);
  const link = `${appBaseUrl(req)}/${kind === 'candidate' ? 'portal-invite' : 'set-password'}/${token}`;
  const company = await companyName();
  let sent = false;
  let status = 'Not sent — the link is shown to you once so you can pass it on.';
  if (send) {
    const r = await sendMail({
      to: addr,
      subject: `${company} — your portal sign-in link`,
      text: inviteText({ kind, name: user.name, companyName: company, link, expiresAt }),
      useEmployeeFrom: false,
      fromName: '',
    }).catch((e) => ({ ok: false, error: e.message }));
    sent = !!(r && r.ok);
    status = sent ? `Sent to ${addr}` : `Not sent — ${(r && r.error) || 'the mail could not be sent'}. The link is shown to you once so you can pass it on.`;
  }
  return {
    created,
    user,
    // The link goes back to the inviter ONLY when it did not go out by mail.
    link: sent ? null : link,
    expiresAt,
    sent,
    status,
    actingUserId: actingUser ? actingUser.id : null,
    ttlHours: SET_PASSWORD_TTL_HOURS,
  };
}

// (The old no-code "claim my login" path is gone: a candidate now proves the
// email with a one-time code — utils/candidatePortalAuth.js.)

module.exports = { portalLoginFor, loginSummary, inviteToPortal };
