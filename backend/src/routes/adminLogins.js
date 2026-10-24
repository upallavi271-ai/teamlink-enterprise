// ---------------------------------------------------------------------------
// ADMINISTRATION -> USERS: the extra screens for SEPARATE LOGINS ON ONE EMAIL (founder, 2026-10-21; utils/loginAccounts.js has the story).
// Mounted at /api/admin/logins. Creating a login is still POST /api/admin/users (routes/admin.js); these are the helpers around it.
//   GET  /status                 is "several logins on one email" ON?   (Users: view)
//   POST /upgrade                Super Admin: switch it ON (backup first, one transaction)
//   GET  /by-email?email=&employeeId=   the logins already on that email / of that employee: role, department, employee, status, created  (Users: view)
//   GET  /employees?q=           the employee picker for a login (with how many logins each already has)
//   POST /:id/send-activation    mail ONE login its own single-use "choose your password" link
//   POST /:id/revoke             switch ONE login off and end its open sessions (siblings are never touched)
// Every action is on the selected account id only. No password, hash or token is ever returned.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const LA = require('../utils/loginAccounts');
const roleGuard = require('../utils/roleGuard');

const router = express.Router();
router.use(requireAuth);

const view = requirePerm(null, 'administration', 'Users', 'view');
const edit = requirePerm(null, 'administration', 'Users', 'edit');

router.get('/status', view, async (req, res) => {
  const U = require('../utils/multiLoginUpgrade'); // eslint-disable-line global-require
  const s = await U.inspect();
  res.json({
    multiLoginOn: s.multiLoginOn,
    emailRule: s.emailIndex.kind, // standalone | inline | none
    users: s.users,
    sharedEmailGroups: s.sharedEmailGroups,
    canSwitchOn: req.user.role === 'SUPER_ADMIN' && !s.multiLoginOn && s.emailIndex.kind === 'standalone',
    needsCommand: !s.multiLoginOn && s.emailIndex.kind === 'inline',
    upToDate: s.upToDate,
  });
});

router.post('/upgrade', requirePerm(null, 'administration', 'Users', 'edit'), async (req, res) => {
  if (req.user.role !== 'SUPER_ADMIN') return res.status(403).json({ error: 'Only a Super Admin can switch this on.' });
  const U = require('../utils/multiLoginUpgrade'); // eslint-disable-line global-require
  const out = await U.apply({ who: `${req.user.name} (Users screen)` });
  if (out.needsRebuild) {
    return res.status(409).json({ error: 'This database needs the one-time command from your developer (the rule is built into the User table). Nothing was changed.', code: 'NEEDS_COMMAND' });
  }
  await logAudit({
    userId: req.user.id, action: 'Several logins on one email switched ON', entity: 'Settings', entityId: 'multiLogin',
    toValue: out.alreadyDone ? 'Already on' : 'Backup made first',
  });
  res.json({ ok: true, alreadyDone: !!out.alreadyDone, multiLoginOn: out.after.multiLoginOn });
});

router.get('/by-email', view, async (req, res) => {
  const email = LA.normEmail(req.query.email);
  const employeeId = String(req.query.employeeId || '').trim();
  const [byEmail, st] = await Promise.all([email ? LA.accountsByEmail(email) : [], LA.state({ fresh: true })]);
  let ofEmployee = [];
  let employee = null;
  if (employeeId) {
    employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true, employeeCode: true, name: true, email: true, userId: true } });
    if (employee) {
      const ids = [...new Set([employee.userId, ...(await LA.extraLoginsOf(employee.id))].filter(Boolean))];
      ofEmployee = await LA.usersByIds(ids);
    }
  }
  const all = [...byEmail];
  ofEmployee.forEach((u) => { if (!all.some((x) => x.id === u.id)) all.push(u); });
  let employeesWithEmail = [];
  if (email) {
    employeesWithEmail = (await LA.q('SELECT "id", "employeeCode", "name", "userId" FROM "Employee" WHERE lower(trim("email")) = ?', email))
      .map((e) => ({ id: e.id, employeeCode: e.employeeCode, name: e.name, hasLogin: !!e.userId }));
  }
  res.json({
    email,
    multiLoginOn: st.multiLoginOn,
    count: all.length,
    sameEmail: byEmail.length,
    accounts: await LA.summariesFor(all),
    employee: employee ? { id: employee.id, employeeCode: employee.employeeCode, name: employee.name, hasLogin: !!employee.userId } : null,
    employeesWithEmail,
  });
});

router.get('/employees', view, async (req, res) => {
  const text = String(req.query.q || '').trim().toLowerCase();
  const rows = await prisma.employee.findMany({
    select: { id: true, employeeCode: true, name: true, email: true, department: true, designation: true, employmentStatus: true, userId: true },
    orderBy: { name: 'asc' },
  });
  const extraCounts = new Map();
  try {
    await LA.ensure();
    (await LA.q('SELECT "employeeId", COUNT(*) AS n FROM "EmployeeLogin" GROUP BY "employeeId"')).forEach((r) => extraCounts.set(r.employeeId, r.n));
  } catch { /* none yet */ }
  const list = rows
    .filter((e) => !text || `${e.name} ${e.employeeCode} ${e.email || ''}`.toLowerCase().includes(text))
    .slice(0, 400)
    .map((e) => ({
      id: e.id, employeeCode: e.employeeCode, name: e.name, email: e.email, department: e.department, designation: e.designation,
      employmentStatus: e.employmentStatus, loginCount: (e.userId ? 1 : 0) + (extraCounts.get(e.id) || 0),
    }));
  res.json(list);
});

async function targetOf(req, res) {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) { res.status(404).json({ error: 'Login not found' }); return null; }
  const why = roleGuard.checkPasswordTarget({ actor: req.user, target });
  if (why) { res.status(403).json({ error: 'Only a Super Admin can do this to a Super Admin or an Admin login.' }); return null; }
  return target;
}

router.post('/:id/send-activation', edit, async (req, res) => {
  const target = await targetOf(req, res);
  if (!target) return null;
  if (['CLIENT', 'CANDIDATE'].includes(target.role)) return res.status(400).json({ error: 'Client and candidate logins are invited from their own screens.' });
  if ((target.status || 'Active') !== 'Active') return res.status(409).json({ error: 'This login is switched off. Switch it on first.' });
  const act = await require('../utils/loginActivation').sendActivation({ user: target, byUser: req.user }); // eslint-disable-line global-require
  return res.json({
    ok: true, sent: act.sent, status: act.status, role: act.role, expiresAt: act.expiresAt,
    // The link is returned ONLY when the mail could not be sent, so the Admin can hand it over. Never a password.
    ...(act.sent ? {} : { link: act.link }),
  });
});

router.post('/:id/revoke', edit, async (req, res) => {
  const target = await targetOf(req, res);
  if (!target) return null;
  if (target.id === req.user.id) return res.status(409).json({ error: 'You cannot switch off your own login.' });
  await prisma.user.update({ where: { id: target.id }, data: { status: 'Inactive', setPasswordTokenHash: null, setPasswordExpiresAt: null } });
  await LA.revokeSessions(target.id);
  await require('../utils/passwordReset').invalidateFor(target.id).catch(() => {}); // eslint-disable-line global-require
  await logAudit({ userId: req.user.id, action: 'Login switched off and signed out', entity: 'User', entityId: target.id, fromValue: target.status, toValue: 'Inactive' });
  return res.json({ ok: true, status: 'Inactive' });
});

module.exports = router;
