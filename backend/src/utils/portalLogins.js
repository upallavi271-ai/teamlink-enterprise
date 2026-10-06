// ---------------------------------------------------------------------------
// PORTAL LOGINS — the rules shared by routes/portalLogins.js, the candidate
// portal and the joining flow (spec B1 / B2, 2026-10-03).
//
//   CLIENT login   only while the client's agreement is ACTIVE (and not past
//                  its end date). The owner BDE REQUESTS; Super Admin / Admin
//                  (a Manager for their departments' clients) APPROVE and the
//                  login is created with a 48-hour single-use invite link
//                  (utils/employeeInvite.js — only the SHA-256 hash is
//                  stored). At most `maxClientLogins` per company
//                  (utils/portalSettings.js, default 3). Types: REVIEWER /
//                  VIEWER / BILLING (utils/clientPortalTypes.js — enforced in
//                  can()).
//   CANDIDATE login  self-registration by email code, or "Invite to portal"
//                  (owner recruiter / TL / Admin) once an application is at
//                  Interview / Offer / Joining. Joined -> retired. 12 months
//                  without a sign-in -> Archived (a new email code re-opens it).
//
// Nothing here ever returns or mails a password.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');
const { normalizeAgreementStatus } = require('./atsVocab');

const DAY = 86400000;
const REVIEW_EVERY_DAYS = 90; // the quarterly review
const ARCHIVE_AFTER_DAYS = 365; // 12 months without a sign-in
const OFF_STATUSES = ['Inactive', 'Suspended', 'Disabled', 'Retired', 'Archived'];
// Not counted towards the per-company limit, not shown as "has access".
const isOff = (u) => OFF_STATUSES.includes(u.status);

// "2026-12-31" / Date / null -> Date at the END of that day, or null.
function endOfDay(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T23:59:59.999+05:30`);
  return d;
}

// The one answer to "may this client have portal logins right now?".
function agreementGate(client) {
  const code = normalizeAgreementStatus(client && client.agreementStatus);
  const end = endOfDay(client && client.agreementEnd);
  const expired = code === 'EXPIRED' || (code === 'ACTIVE' && end && end < new Date());
  const active = code === 'ACTIVE' && !expired;
  let words;
  if (active) words = 'Active';
  else if (expired) words = 'Expired';
  else words = {
    DRAFT: 'Not sent yet', SENT: 'Sent — not signed yet', VIEWED: 'Opened — not signed yet', CLIENT_CONFIRMATION_PENDING: 'Waiting for the client',
    SIGNED: 'Signed — not active yet', CANCELLED: 'Cancelled', REJECTED: 'Rejected',
  }[code] || code;
  return { active, expired, code, words, end: client && client.agreementEnd };
}

// The state a client / candidate login is in, in plain words.
function loginState(u) {
  if (u.status === 'Archived') return { key: 'archived', label: 'Archived (not used for 12 months)', tone: 'orange' };
  if (u.status === 'Retired') return { key: 'retired', label: 'Retired (joined)', tone: 'green' };
  if (isOff(u)) return { key: 'off', label: 'Switched off', tone: 'red' };
  if (u.lastLoginAt) return { key: 'active', label: 'Active', tone: 'green' };
  const live = u.setPasswordTokenHash && u.setPasswordExpiresAt && u.setPasswordExpiresAt > new Date();
  if (live) return { key: 'invited', label: 'Invite sent — waiting for them', tone: 'blue' };
  if (u.passwordChangedAt) return { key: 'active', label: 'Active — not signed in yet', tone: 'green' };
  return { key: 'expired', label: 'Invite link expired', tone: 'orange' };
}

// Quarterly review: due when it was never reviewed and is 90+ days old, or
// the last review is 90+ days old.
function reviewDue(u, now = Date.now()) {
  const since = u.portalReviewedAt || u.createdAt;
  return !isOff(u) && since && (now - new Date(since).getTime()) >= REVIEW_EVERY_DAYS * DAY;
}

// Client logins of one company (every status — the tab shows switched-off
// ones too, so "existing client logins keep working and show in the tab").
async function clientLogins(clientId) {
  return prisma.user.findMany({
    where: { clientId, OR: [{ role: 'CLIENT' }, { atsRole: 'CLIENT' }] },
    select: {
      id: true, name: true, email: true, status: true, portalType: true, portalReviewedAt: true, lastLoginAt: true,
      createdAt: true, setPasswordTokenHash: true, setPasswordExpiresAt: true, passwordChangedAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });
}

// Logins that hold a seat against the limit, + requests still waiting.
async function seatsUsed(clientId) {
  const [logins, pending] = await Promise.all([
    clientLogins(clientId),
    prisma.portalRequest.count({ where: { clientId, kind: 'CLIENT_LOGIN', status: 'Pending' } }),
  ]);
  return { logins: logins.filter((u) => !isOff(u)).length, pending };
}

// ---- Candidate lifecycle --------------------------------------------------
// Joined -> the candidate login retires (one person, one identity). For a
// TeamLink internal hire the person's identity is now the EMPLOYEE record
// (Application.hrmsEmployeeId); their email is freed for the employee login
// that Administration -> Users issues, and the old candidate login is kept
// (retired, renamed) only as history.
async function retireCandidateLogin({ candidateId, employeeId = null, userId = null }) {
  if (!candidateId) return null;
  const u = await prisma.user.findFirst({ where: { candidateId, role: 'CANDIDATE' } });
  if (!u) return null;
  const freedAlready = /@candidate-login\.invalid$/.test(u.email);
  if (u.status === 'Retired' && (!employeeId || freedAlready)) return null;
  const data = { status: 'Retired', setPasswordTokenHash: null, setPasswordExpiresAt: null };
  if (employeeId) {
    const freed = `retired.${u.id}@candidate-login.invalid`;
    data.email = freed;
    data.username = freed;
  }
  await prisma.user.update({ where: { id: u.id }, data });
  await logAudit({
    userId, action: employeeId ? 'Candidate login retired — joined TeamLink (now an employee)' : 'Candidate login retired — joined',
    entity: 'User', entityId: u.id, fromValue: u.email, toValue: employeeId ? `Employee ${employeeId}` : 'Retired',
  });
  return u.id;
}

// 12 months without a sign-in -> Archived. Reversible: a new email code
// (utils/candidatePortalAuth.js) re-opens the login.
async function archiveIdleCandidateLogins({ userId = null } = {}) {
  const cutoff = new Date(Date.now() - ARCHIVE_AFTER_DAYS * DAY);
  const idle = await prisma.user.findMany({
    where: {
      role: 'CANDIDATE',
      status: { in: ['Active', 'Invited'] },
      OR: [{ lastLoginAt: { lt: cutoff } }, { lastLoginAt: null, createdAt: { lt: cutoff } }],
    },
    select: { id: true },
  });
  if (!idle.length) return { archived: 0 };
  await prisma.user.updateMany({ where: { id: { in: idle.map((u) => u.id) } }, data: { status: 'Archived', setPasswordTokenHash: null, setPasswordExpiresAt: null } });
  await logAudit({ userId, action: `Candidate logins archived — 12 months without a sign-in (${idle.length})`, entity: 'User', toValue: String(idle.length) });
  return { archived: idle.length };
}

let timer = null;
function startSweep() {
  if (timer) return;
  const run = () => archiveIdleCandidateLogins()
    .then((r) => { if (r.archived) console.log(`[portal logins] ${r.archived} idle candidate login(s) archived`); })
    .catch((e) => console.error('[portal logins]', e.message));
  const first = setTimeout(run, 240000);
  if (first.unref) first.unref();
  timer = setInterval(run, DAY);
  if (timer.unref) timer.unref();
}

module.exports = {
  REVIEW_EVERY_DAYS, ARCHIVE_AFTER_DAYS, OFF_STATUSES, isOff,
  agreementGate, loginState, reviewDue, clientLogins, seatsUsed,
  retireCandidateLogin, archiveIdleCandidateLogins, startSweep,
};
