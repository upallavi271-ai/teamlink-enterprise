// ---------------------------------------------------------------------------
// PERSONAL EMAIL AND COMPANY EMAIL (founder 2026-11-06: "personal email ni contact email ga, company email ni login email ga separate cheyyadam").
//
// A person comes in on a personal email: the candidate login before joining, then the employee login made at joining (utils/joining.js, utils/internalOnboarding.js).
// After joining HR gives them a company email (cPanel, or from here: utils/cpanelMail.js) and from then on:
//   Employee.personalEmail   the address they came with. Kept for good: offer, documents, password recovery. Set once, never changed here.
//   Employee.companyEmail    the address HR gave. It is also Employee.email (what every mail, notification and HRMS screen uses) and User.email (the login).
// The User row stays the same row: only its email moves, so attendance, payroll and ATS history stay attached to the person.
//
//   assign(actor, employee, { email, personalEmail })   checks, moves the login(s), signs old sessions out, audits, mails the personal address, ticks the onboarding task
//   movedLogin(typed, password)   a right password on the old personal address: tell them the login moved (a wrong one learns nothing)
//   recoveryLogin(typed)          "Forgot password" with the personal address: the link goes to the personal address
//   emailLocked(employeeId, email)   the profile forms cannot change a company email: only assign() can
//
// The four columns are read and written with plain SQL (like utils/loginAccounts.js), so this works before and after the Prisma client is regenerated.
// ---------------------------------------------------------------------------
const bcrypt = require('bcryptjs');
const { strengthError, passwordEventData } = require('./passwordPolicy');
const prisma = require('../db');
const { logAudit } = require('./audit');
const LA = require('./loginAccounts');
const CP = require('./cpanelMail');
const { LEFT } = require('./leftLogin');

const norm = (e) => LA.normEmail(LA.cleanTyped(e));
const FREE_MAIL = /@(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|rediffmail|icloud|protonmail|aol|zoho)\./i;
const TASK = 'Company email assigned';

// the domains a company email may have: COMPANY_EMAIL_DOMAINS (comma list), else the cPanel domain; none set = any that is not a free mail service
const allowedDomains = () => String(process.env.COMPANY_EMAIL_DOMAINS || CP.domain() || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);

async function columns(employeeId) {
  const rows = await prisma.$queryRawUnsafe('SELECT "personalEmail", "companyEmail", "companyEmailAt", "companyEmailBy" FROM "Employee" WHERE "id" = ?', String(employeeId));
  return rows[0] || null;
}

// every login of this person: the main one and the extra logins on the same record (utils/loginAccounts.js EmployeeLogin)
async function loginIdsOf(employee) {
  const ids = employee.userId ? [employee.userId] : [];
  const extra = await prisma.$queryRawUnsafe('SELECT "userId" FROM "EmployeeLogin" WHERE "employeeId" = ?', employee.id).catch(() => []);
  extra.forEach((r) => { if (r.userId && !ids.includes(r.userId)) ids.push(r.userId); });
  return ids;
}

async function state(employee) {
  const c = (await columns(employee.id)) || {};
  const login = employee.userId ? await prisma.user.findUnique({ where: { id: employee.userId }, select: { email: true } }) : null;
  const domains = allowedDomains();
  const local = CP.suggestLocalPart(employee.name);
  return {
    personalEmail: c.personalEmail || null,
    companyEmail: c.companyEmail || null,
    assignedAt: c.companyEmailAt ? new Date(Number(c.companyEmailAt)).toISOString() : null,
    assignedBy: c.companyEmailBy || null,
    loginEmail: login ? login.email : null,
    // an employee from before this feature whose email is already the company one
    workingEmail: employee.email || null,
    suggestion: local && domains.length === 1 ? `${local}@${domains[0]}` : '',
    domains,
    cpanel: { on: CP.configured(), domain: CP.domain() || null },
    generatedPassword: generatedPassword(employee),
    // where Send credentials goes on its own: their own email from the profile, else their phone
    personalSuggestion: await personalOf(employee, c).catch(() => null),
    phoneMasked: phoneOf(employee) ? `…${phoneOf(employee).slice(-4)}` : null,
  };
}

// why this address cannot be the company email of this person (null = it can)
async function refusal(employee, email, loginIds) {
  if (!LA.looksLikeEmail(email)) return 'Write the full email, like name@company.com.';
  if (/\.invalid$/i.test(email)) return 'That is not a real email address.';
  const domains = allowedDomains();
  if (domains.length) {
    if (!domains.includes(email.split('@')[1])) return `A company email must end with ${domains.map((d) => `@${d}`).join(' or ')}.`;
  } else if (FREE_MAIL.test(email)) return 'That looks like a personal email. Give the company email here.';
  const accounts = await LA.accountsByEmail(email);
  if (accounts.some((u) => !loginIds.includes(u.id))) return 'Another login already uses this email.';
  const others = await prisma.$queryRawUnsafe(
    'SELECT "name", "employeeCode" FROM "Employee" WHERE "id" != ? AND (lower("email") = ? OR lower("companyEmail") = ? OR lower("personalEmail") = ?) LIMIT 1',
    employee.id, email, email, email,
  );
  if (others.length) return `${others[0].name} (${others[0].employeeCode}) already has this email.`;
  const vendor = await prisma.vendorUser.findUnique({ where: { email } }).catch(() => null);
  if (vendor && !vendor.deletedAt) return 'A vendor login already uses this email.';
  return null;
}

async function tickOnboarding(employee) {
  let tasks = [];
  try { tasks = JSON.parse(employee.onboardingTasks || '[]'); } catch { tasks = []; }
  if (!Array.isArray(tasks)) return;
  const row = tasks.find((t) => t && t.task === TASK);
  if (row) row.completed = true; else tasks.push({ task: TASK, completed: true });
  await prisma.employee.update({ where: { id: employee.id }, data: { onboardingTasks: JSON.stringify(tasks) } });
}

// THE FIRST PASSWORD HR GIVES (founder 2026-11-09: "generate click cheyyagaane Teamlink@<joined month> ... Teamlink@082026"):
// Teamlink@ + the month and year of joining, from the date of joining (this month when none is written). Easy to say on a call,
// so TeamLink asks for a new one at the first sign-in (passwordEventData 'admin').
function generatedPassword(employee) {
  const d = employee && employee.dateOfJoining ? new Date(employee.dateOfJoining) : new Date();
  const ist = new Date((Number.isNaN(d.getTime()) ? Date.now() : d.getTime()) + 330 * 60000);
  return `Teamlink@${String(ist.getUTCMonth() + 1).padStart(2, '0')}${ist.getUTCFullYear()}`;
}
// THEIR OWN EMAIL, FROM THE PROFILE (founder 2026-11-09: "valla personal gmail automatic ga, profile nunchi theeskovali"): the
// personal email on the record, the email they applied with (the candidate they were hired from), the address their login had
// before the company email - the first that is not a company address. null = none, and the details go to their phone.
const companyDomains = (company) => [...new Set([...allowedDomains(), CP.domain(), String(company || '').split('@')[1]].filter(Boolean).map((d) => d.toLowerCase()))];
async function personalOf(employee, c = null) {
  const cols = c || (await columns(employee.id)) || {};
  const own = (e) => { const x = norm(e); return x && LA.looksLikeEmail(x) && !companyDomains(cols.companyEmail || employee.email).includes(x.split('@')[1]) ? x : null; };
  const tries = [{ email: cols.personalEmail, from: 'the profile' }];
  const apps = await prisma.application.findMany({ where: { hrmsEmployeeId: employee.id }, select: { candidate: { select: { email: true } } }, take: 5 }).catch(() => []);
  apps.forEach((a) => tries.push({ email: a.candidate && a.candidate.email, from: 'the candidate record they were hired from' }));
  if (employee.userId) {
    const moved = await prisma.auditLog.findMany({ where: { action: 'Login email changed', entityId: employee.userId }, select: { fromValue: true }, orderBy: { createdAt: 'asc' }, take: 5 }).catch(() => []);
    moved.forEach((m) => tries.push({ email: m.fromValue, from: 'their earlier login' }));
  }
  for (const t of tries) { const e = own(t.email); if (e) return { email: e, from: t.from }; }
  return null;
}
const phoneOf = (employee) => { const m = require('./messagingCore').normalizeMobile(employee && employee.phone); return m.ok ? m.e164 : null; }; // eslint-disable-line global-require
function credentialsText({ name, company, password, webmail }) {
  return `TeamLink sign-in for ${String(name || '').split(' ')[0]}: TeamLink website ${appLink()} | ${webmail ? `Webmail ${webmailLink()} | ` : ''}Login email ${company} | Password ${password} | You will be asked for a new password at the first sign-in. - TeamLink HR`;
}
// THE TWO LINKS IN EVERY SIGN-IN MAIL (founder 2026-11-11: "teamlink website link & webmail link rendu vellali"): the TeamLink website, and the
// webmail sign-in page. The founder's webmail link carried a cPanel session (".../cpsess4633519995/..."), which ends with that sign-in, so the
// stable sign-in page of the same server is sent: WEBMAIL_URL on the server changes it.
const appLink = () => `${require('./passwordReset').baseUrl().replace(/\/+$/, '')}/`; // eslint-disable-line global-require
const webmailLink = () => String(process.env.WEBMAIL_URL || 'https://neo.herosite.pro:2096/').trim();
// the two blocks, the same in both mails
function signInLines(company, password) {
  return [
    'TeamLink website', `  ${appLink()}`, `  Login email: ${company}`, `  Password: ${password}`, '',
    'Webmail', `  ${webmailLink()}`, `  Login email: ${company}`, `  Password: ${password}`,
  ];
}

function credentialsMail({ name, company, password }) {
  return [
    `Hello ${String(name || '').split(' ')[0] || ''},`, '',
    'Your sign-in details:', '',
    ...signInLines(company, password), '',
    'TeamLink asks you for a new password the first time you sign in. Please change the webmail password too, from the webmail settings.',
    'Do not share these details with anyone.', '', '— TeamLink HR',
  ].join('\n');
}

function readyMail({ name, company, personal, mailbox, sameForTeamLink }) {
  const lines = [`Hello ${String(name || '').split(' ')[0] || ''},`, '', `Your company email is ready: ${company}`];
  if (mailbox && sameForTeamLink) {
    // a new mailbox: the TeamLink password was set to the same first password, so both sign-ins go in the mail
    lines.push('', 'Your sign-in details:', '', ...signInLines(company, mailbox.password), '',
      'TeamLink asks you for a new password the first time you sign in. Please change the webmail password too, from the webmail settings.', 'Do not share these details with anyone.');
  } else {
    lines.push('', 'TeamLink website', `  ${appLink()}`, `  Login email: ${company}`, '  Password: the same as before');
    if (mailbox) lines.push('', 'Webmail', `  ${webmailLink()}`, `  Login email: ${company}`, `  Password: ${mailbox.password}`, '', 'Please change this mailbox password the first time you open it.');
  }
  lines.push('', `This address (${personal}) stays on your record for documents and password recovery. If you forget your password, you can use "Forgot password" with either address.`, '', '— TeamLink HR');
  return lines.join('\n');
}

/** -> { status, body } */
async function assign(actor, employeeIn, { email: rawEmail, personalEmail: rawPersonal, createMailbox = false, password = '' } = {}) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeIn.id } });
  if (!employee) return { status: 404, body: { error: 'Employee not found' } };
  if (LEFT.includes(employee.employmentStatus)) return { status: 409, body: { error: 'This person has left. A company email is not given.' } };
  const c = (await columns(employee.id)) || {};
  const loginIds = await loginIdsOf(employee);

  let email = norm(rawEmail);
  if (createMailbox && !email) {
    const local = CP.suggestLocalPart(employee.name);
    email = local && CP.domain() ? `${local}@${CP.domain()}` : '';
  }
  if (!email) return { status: 400, body: { error: 'Write the company email.' } };
  if (createMailbox && !CP.configured()) return { status: 409, body: { error: 'cPanel is not connected on this server. Make the mailbox in cPanel and type the address here.' } };
  // the password HR typed or generated for the new mailbox (empty: a random one, as before)
  const typedPassword = String(password || '');
  if (createMailbox && typedPassword) { const weak = strengthError(typedPassword, { email, name: employee.name }); if (weak) return { status: 400, body: { error: weak } }; }
  if (c.companyEmail && norm(c.companyEmail) === email) return { status: 200, body: { ok: true, unchanged: true, message: 'That is already the company email.' } };

  const personalNow = norm(c.personalEmail) || norm(rawPersonal) || (employee.email && !c.companyEmail ? norm(employee.email) : '');
  if (!personalNow) return { status: 400, body: { error: 'Add the personal email first: the person gets the news there.' } };
  if (personalNow === email) return { status: 400, body: { error: 'The company email must be different from the personal email.' } };
  if (!LA.looksLikeEmail(personalNow)) return { status: 400, body: { error: 'The personal email does not look right.' } };
  const no = await refusal(employee, email, loginIds);
  if (no) return { status: 409, body: { error: no } };

  // the mailbox first: when cPanel says no, nothing here has changed
  let mailbox = null;
  if (createMailbox) {
    const made = await CP.createMailbox({ localPart: email.split('@')[0], ...(typedPassword ? { password: typedPassword } : {}) });
    if (!made.ok) return { status: 502, body: { error: made.error } };
    mailbox = made;
    await logAudit({ userId: actor.id, action: 'Company mailbox created in cPanel', entity: 'Employee', entityId: employee.id, toValue: email });
  }

  // ONE FIRST PASSWORD FOR BOTH (founder 2026-11-11: both links with the login email and password in the mail): a mailbox TeamLink made gets
  // the same first password on the TeamLink login, which asks for a new one at the first sign-in. Never on a login HR may not reset.
  let sameForTeamLink = false;
  if (mailbox && employee.userId) {
    const target = await prisma.user.findUnique({ where: { id: employee.userId } });
    const why = target ? require('./roleGuard').checkPasswordTarget({ actor, target }) : 'no login'; // eslint-disable-line global-require
    if (!why) {
      await prisma.user.update({ where: { id: target.id }, data: { passwordHash: await bcrypt.hash(mailbox.password, 10), ...passwordEventData('admin'), setPasswordTokenHash: null, setPasswordExpiresAt: null } });
      const after = await prisma.user.findUnique({ where: { id: target.id } });
      await require('./passwordReset').afterPasswordChange({ user: after, method: 'admin_reset', byUserId: actor.id, byName: actor.name }).catch(() => {}); // eslint-disable-line global-require
      sameForTeamLink = true;
    }
  }
  const oldLogin = employee.userId ? (await prisma.user.findUnique({ where: { id: employee.userId }, select: { email: true } }) || {}).email : null;
  const now = Date.now();
  await prisma.$transaction([
    ...(loginIds.length ? [prisma.user.updateMany({ where: { id: { in: loginIds } }, data: { email, username: email } })] : []),
    prisma.employee.update({ where: { id: employee.id }, data: { email } }),
    prisma.$executeRawUnsafe(
      'UPDATE "Employee" SET "personalEmail" = ?, "companyEmail" = ?, "companyEmailAt" = ?, "companyEmailBy" = ? WHERE "id" = ?',
      personalNow, email, now, String(actor.name || actor.email || actor.id).slice(0, 120), employee.id,
    ),
  ]);
  // sessions on the old address end; the next sign-in is with the company email
  for (const id of loginIds) await LA.revokeSessions(id); // eslint-disable-line no-await-in-loop
  // HR gave this mailbox: it needs no email code to count as proved
  await prisma.emailVerification.create({ data: { email, purpose: 'employee-self-email', codeHash: 'company-email-assigned', expiresAt: new Date(now), verifiedAt: new Date(now) } }).catch(() => {});
  await tickOnboarding(employee).catch(() => {});

  await logAudit({
    userId: actor.id, action: 'Login email changed', entity: 'User', entityId: employee.userId || employee.id, fromValue: oldLogin || employee.email || '', toValue: email, reason: `Company email assigned by ${actor.name || 'HR'} (${employee.employeeCode})`,
  });

  let mailed = { ok: false, error: 'not tried' };
  try {
    // eslint-disable-next-line global-require
    mailed = await require('./mailer').sendMail({
      to: personalNow, subject: `Your company email is ready: ${email}`, text: readyMail({ name: employee.name, company: email, personal: personalNow, mailbox, sameForTeamLink }), useEmployeeFrom: false, fromName: 'TeamLink HR',
    });
  } catch (e) { mailed = { ok: false, error: e.message }; }
  if (employee.userId) await prisma.notification.create({ data: { userId: employee.userId, title: 'Your company email is ready', message: `Sign in with ${email} from now on.`, channel: 'In-App', recipient: `company-email|${employee.id}|${email}`, status: 'Sent' } }).catch(() => {});
  await logAudit({ userId: actor.id, action: `Company email news: ${mailed && mailed.ok ? 'sent' : 'not sent'}`, entity: 'Employee', entityId: employee.id, toValue: personalNow, reason: mailed && mailed.ok ? null : String((mailed && mailed.error) || '').slice(0, 200) });

  const signedOutSelf = loginIds.includes(actor.id);
  return {
    status: 200,
    body: {
      ok: true, email, personalEmail: personalNow, mailed: !!(mailed && mailed.ok), signedOutSelf,
      // shown once, only when the mail could not carry it
      ...(mailbox && !(mailed && mailed.ok) ? { mailboxPassword: mailbox.password } : {}),
      message: `Saved. ${employee.name} now signs in with ${email}.${mailed && mailed.ok ? ` The news went to ${personalNow}.` : ` The mail to ${personalNow} did not go, so please tell them.`}`,
    },
  };
}

// SEND CREDENTIALS (founder 2026-11-09): the password HR typed or generated becomes the person's TeamLink password AND their webmail
// password (cPanel), and one mail to the personal email carries both links with the sign-in details. The password is never kept:
// TeamLink keeps only its hash, the audit says THAT details were sent, and TeamLink asks for a new password at the first sign-in.
/** -> { status, body } */
async function sendCredentials(actor, employeeIn, { password, to: rawTo } = {}) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeIn.id } });
  if (!employee) return { status: 404, body: { error: 'Employee not found' } };
  if (LEFT.includes(employee.employmentStatus)) return { status: 409, body: { error: 'This person has left.' } };
  const c = (await columns(employee.id)) || {};
  const company = norm(c.companyEmail);
  if (!company) return { status: 409, body: { error: 'Give the company email first.' } };
  const pw = String(password || '');
  const weak = strengthError(pw, { email: company, name: employee.name });
  if (weak) return { status: 400, body: { error: weak } };
  // where it goes: the email HR wrote, else their own email from the profile, else their phone (WhatsApp, then SMS)
  const typedTo = norm(rawTo);
  if (typedTo && !LA.looksLikeEmail(typedTo)) return { status: 400, body: { error: 'That email does not look right.' } };
  const found = typedTo ? null : await personalOf(employee, c);
  const to = typedTo || (found && found.email) || null;
  const phone = to ? null : phoneOf(employee);
  if (!to && !phone) return { status: 400, body: { error: 'There is no personal email and no mobile number on the profile. Write where the details should go.' } };
  const user = employee.userId ? await prisma.user.findUnique({ where: { id: employee.userId } }) : null;
  if (!user) return { status: 409, body: { error: 'This person has no TeamLink login yet.' } };
  { const why = require('./roleGuard').checkPasswordTarget({ actor, target: user }); if (why) return { status: 403, body: { error: why } }; } // eslint-disable-line global-require

  // the webmail password first: when cPanel says no, the TeamLink password has not changed either
  const onCpanel = CP.configured() && company.split('@')[1] === CP.domain();
  if (onCpanel) {
    const set = await CP.setMailboxPassword({ email: company, password: pw });
    if (!set.ok) return { status: 502, body: { error: set.error } };
  }
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(pw, 10), ...passwordEventData('admin'), setPasswordTokenHash: null, setPasswordExpiresAt: null } });
  const after = await prisma.user.findUnique({ where: { id: user.id } });
  await require('./passwordReset').afterPasswordChange({ user: after, method: 'admin_reset', byUserId: actor.id, byName: actor.name }).catch(() => {}); // eslint-disable-line global-require

  let mailed = { ok: false, error: 'not tried' };
  let via = 'mail';
  try {
    if (to) {
      // eslint-disable-next-line global-require
      mailed = await require('./mailer').sendMail({ to, subject: 'Your TeamLink and company email sign-in details', text: credentialsMail({ name: employee.name, company, password: pw }), useEmployeeFrom: false, fromName: 'TeamLink HR' });
    } else {
      const M = require('./messaging'); // eslint-disable-line global-require
      const text = credentialsText({ name: employee.name, company, password: pw, webmail: onCpanel });
      via = 'WhatsApp';
      mailed = await M.send('WhatsApp', { to: phone, kind: 'bulk', text, vars: [text] });
      if (!mailed.ok) { via = 'SMS'; mailed = await M.send('SMS', { to: phone, kind: 'bulk', text, vars: [text] }); }
    }
  } catch (e) { mailed = { ok: false, error: e.message }; }
  const where = to || `${via} to …${phone.slice(-4)}`;
  await logAudit({
    userId: actor.id, action: `Sign-in details ${mailed && mailed.ok ? 'sent' : 'set, message not sent'}`, entity: 'Employee', entityId: employee.id, toValue: where,
    reason: `TeamLink password${onCpanel ? ' and webmail password' : ''} set by ${actor.name || 'HR'}; change required at the next sign-in${mailed && mailed.ok ? '' : ` (mail: ${String((mailed && mailed.error) || '').slice(0, 150)})`}`,
  });
  const both = onCpanel ? 'TeamLink and webmail' : 'TeamLink';
  return {
    status: 200,
    body: {
      ok: true, mailed: !!(mailed && mailed.ok), to: where, via: to ? 'mail' : via, webmail: onCpanel,
      message: mailed && mailed.ok
        ? `Done. The ${both} password is set and the details went to ${where}${found ? ` (their email from ${found.from})` : ''}.${onCpanel ? '' : ' The mailbox is not on cPanel here, so its password was not changed.'}`
        : `The ${both} password is set, but the message to ${where} did not go${mailed && mailed.error ? ` (${String(mailed.error).slice(0, 120)})` : ''}. Please give them the details yourself.`,
    },
  };
}

// the employee whose PERSONAL address this is, once their login has moved to the company email
async function movedEmployee(typed) {
  const e = norm(typed);
  if (!e || !LA.looksLikeEmail(e)) return null;
  const rows = await prisma.$queryRawUnsafe('SELECT "id", "userId", "companyEmail", "personalEmail" FROM "Employee" WHERE lower("personalEmail") = ? AND "companyEmail" IS NOT NULL AND "userId" IS NOT NULL LIMIT 1', e).catch(() => []);
  return rows[0] || null;
}

// a right password on the old address: the company email is said; a wrong password gets the same answer as an address nobody has
async function movedLogin(typed, password) {
  const row = await movedEmployee(typed);
  if (!row) return null;
  const user = await prisma.user.findUnique({ where: { id: row.userId }, select: { passwordHash: true, status: true } });
  if (!user || !user.passwordHash || !(await bcrypt.compare(String(password || ''), user.passwordHash))) return null;
  return row.companyEmail;
}

// "Forgot password" typed with the personal address: the link goes to that address
async function recoveryLogin(typed) {
  const row = await movedEmployee(typed);
  if (!row) return null;
  const [user] = await LA.usersByIds([row.userId]);
  return user ? { user, to: row.personalEmail } : null;
}

// the profile forms send the email back with every save: the same address is fine, another one is refused while a company email is set
async function emailLocked(employeeId, email) {
  if (email === undefined) return null;
  const c = await columns(employeeId).catch(() => null);
  if (!c || !c.companyEmail || norm(email) === norm(c.companyEmail)) return null;
  return `This is the company email and the login. HR changes it under Login & company email on the employee page.`;
}

module.exports = {
  readyMail, credentialsMail,
  TASK, state, assign, sendCredentials, generatedPassword, movedLogin, recoveryLogin, emailLocked, allowedDomains,
};
