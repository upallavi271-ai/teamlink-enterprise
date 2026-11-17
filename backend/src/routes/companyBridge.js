// ---------------------------------------------------------------------------
// COMPANY SWITCHER routes (utils/companyBridge.js has the whole story).
//
//   TeamLink side (needs ~/.teamlink-company-bridge/private.pem + companies.json, otherwise these answer "nothing set up"):
//     GET  /api/company-bridge/companies   the companies this Super Admin may open ([] when not set up or not a Super Admin)
//     POST /api/company-bridge/open/:key   a signed 60-second pass inside the address to open that company
//
//   Company side (needs COMPANY_KEY + COMPANY_BRIDGE_PUBLIC_KEY_FILE, otherwise 404):
//     POST /api/company-bridge/enter       { pass }  ->  { token }  : signs TeamLink's Super Admin in as the company's "TeamLink owner"
//     GET  /api/company-bridge/status      { viaBridge, homeUrl }   : lets the screens show "Back to TeamLink"
// ---------------------------------------------------------------------------
const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const { resolveIdentity, tokenPayload } = require('../utils/identity');
const { logAudit } = require('../utils/audit');
const { ipOf, rateLimit } = require('../utils/publicRateLimit');
const CB = require('../utils/companyBridge');

const router = express.Router();

// A REAL Super Admin only: not a View-as / Act-as session, not an HR login that is lifted to Super Admin powers.
function realSuperAdmin(req, res, next) {
  const u = req.user;
  if (!u || u.role !== 'SUPER_ADMIN' || u.hrSuper || req.viewAs || req.actingAs) {
    return res.status(403).json({ error: 'Only a Super Admin can open another company.' });
  }
  return next();
}

router.get('/companies', requireAuth, async (req, res) => {
  const u = req.user;
  if (!u || u.role !== 'SUPER_ADMIN' || u.hrSuper || req.viewAs || req.actingAs) return res.json({ companies: [] });
  return res.json({ companies: CB.companiesForMenu() });
});

const openLimit = rateLimit({ bucket: 'company-bridge-open', max: 20, windowMs: 60000 });
router.post('/open/:key', requireAuth, realSuperAdmin, openLimit, async (req, res) => {
  const company = CB.companyByKey(req.params.key);
  if (!company) return res.status(404).json({ error: 'No such company is set up here.' });
  let pass;
  try { pass = CB.signPass(company, req.user); } catch { return res.status(404).json({ error: 'The company switcher is not set up on this server.' }); }
  await logAudit({ userId: req.user.id, action: `Opened company ${company.name} (company switcher)`, entity: 'Company', toValue: company.key, reason: `IP ${ipOf(req)}` });
  return res.json({ url: `${company.url}/bridge#p=${pass}`, company: { key: company.key, name: company.name }, expiresInSeconds: CB.PASS_SECONDS });
});

// ---- the company's side ---------------------------------------------------------------------------------------------------------------
const enterLimit = rateLimit({ bucket: 'company-bridge-enter', max: Number(process.env.COMPANY_BRIDGE_ENTER_MAX || 20), windowMs: 10 * 60000, message: 'Too many tries. Please wait a few minutes.' });
const WRONG = 'This link is not valid any more. Go back to TeamLink and open the company again.';

// The company's login for TeamLink's Super Admin. It is made on first use and is always an Active Super Admin of THIS company only:
// the company's own admin cannot lock the owner out, and nothing of it exists anywhere else.
async function ownerLogin(who) {
  const email = CB.ownerEmail(who.id);
  const name = `${who.name || 'TeamLink Super Admin'} (TeamLink owner)`.slice(0, 120);
  const keep = {
    name, role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', accountsRole: 'SUPER_ADMIN',
    hrmsAccess: true, atsAccess: true, accountsAccess: true, status: 'Active',
    passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null,
  };
  let user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    user = await prisma.user.update({ where: { id: user.id }, data: keep });
  } else {
    const unknown = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10); // nobody knows it: a pass is the only way in
    user = await prisma.user.create({ data: { ...keep, email, username: email, passwordHash: unknown } });
  }
  return user;
}

router.post('/enter', enterLimit, async (req, res) => {
  if (!CB.receiverOn()) return res.status(404).json({ error: 'Not found' });
  const got = CB.checkPass(req.body && req.body.pass);
  if (!got.ok) {
    await logAudit({ action: 'Company switcher: pass refused', entity: 'User', toValue: got.why, reason: `IP ${ipOf(req)}` });
    return res.status(401).json({ error: WRONG });
  }
  const user = await ownerLogin(got.who);
  const identity = await resolveIdentity(user.id, user);
  const sid = await require('../utils/sessions').open({ userId: user.id, ip: ipOf(req), userAgent: req.headers['user-agent'] }).catch(() => null); // eslint-disable-line global-require
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await logAudit({ userId: user.id, action: 'Signed in from TeamLink (company switcher)', entity: 'User', entityId: user.id, toValue: 'TeamLink Super Admin', reason: `IP ${ipOf(req)}` });
  const token = jwt.sign({ ...tokenPayload(identity), tms: Date.now(), ...(sid ? { sid } : {}) }, process.env.JWT_SECRET, { expiresIn: '8h' });
  return res.json({ token, homeUrl: CB.homeUrl() });
});

router.get('/status', requireAuth, (req, res) => {
  const viaBridge = !!(CB.receiverOn() && CB.isOwnerEmail(req.user && req.user.email));
  res.json({ viaBridge, homeUrl: viaBridge ? CB.homeUrl() : null });
});

module.exports = router;
