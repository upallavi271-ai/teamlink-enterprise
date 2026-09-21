const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const { resolveIdentity, tokenPayload } = require('../utils/identity');
const { effectiveMatrix, allowedStagesFor, STAGE_WORKFLOW_ACTIONS } = require('../utils/permissions');

// Everything the browser needs to render this login: the identity, the
// EFFECTIVE permission matrix (every module resolved against ITS product's
// role — HRMS by hrmsRole, ATS by atsRole, Accounts by accountsRole, the core
// modules against every role the login holds) and the pipeline stages this
// login OWNS, which is the workflow half of §17 and is not implied by being
// able to see a record.
async function sessionPayload(identity) {
  const [access, allowedStages] = await Promise.all([
    effectiveMatrix(identity),
    allowedStagesFor(identity),
  ]);
  return {
    ...identity,
    access,
    workflow: { allowedStages, stageActions: STAGE_WORKFLOW_ACTIONS },
  };
}

const router = express.Router();

// The whole login chain, in order:
//   validate email+password -> identify user -> load Employee / Client /
//   Candidate record -> load product access -> load role -> load
//   department/team/scope -> determine landing page.
// No role is ever asked for: it is derived from the employee's designation.
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const user = await prisma.user.findUnique({ where: { email: String(email).trim().toLowerCase() } })
    || await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

  // A login an admin has disabled on the Users screen is really disabled.
  if (user.status && user.status !== 'Active') {
    return res.status(403).json({ error: `This login is ${user.status.toLowerCase()} — ask an administrator to re-enable it` });
  }

  const identity = await resolveIdentity(user.id, user);
  if (!identity.products.hrms && !identity.products.ats && !identity.products.accounts
      && !['CLIENT', 'CANDIDATE'].includes(identity.role)) {
    // No product names: this is a login screen, and the message is read
    // before we know anything about who is reading it.
    return res.status(403).json({ error: 'This login has no access yet — ask an administrator to grant it' });
  }

  // Stamps the Users screen's "Last Login" column.
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  const token = jwt.sign(tokenPayload(identity), process.env.JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, user: await sessionPayload(identity) });
});

// The resolved identity plus the permission matrix the frontend renders its
// nav and its action buttons from — the SAME matrix the server enforces.
router.get('/me', requireAuth, async (req, res) => {
  res.json(await sessionPayload(req.user));
});

router.put('/me', requireAuth, async (req, res) => {
  const { name, password } = req.body;
  const data = {};
  if (name) data.name = name;
  if (password) data.passwordHash = await bcrypt.hash(password, 10);
  await prisma.user.update({ where: { id: req.user.id }, data });
  const identity = await resolveIdentity(req.user.id);
  res.json(identity);
});

// Workspace switch for a login that carries several products. It records a
// preference — it never changes the user's role or permissions.
router.put('/me/workspace', requireAuth, async (req, res) => {
  const { workspace } = req.body;
  if (!['hrms', 'ats', 'accounts'].includes(workspace)) {
    return res.status(400).json({ error: 'Unknown workspace' });
  }
  if (!req.user.products[workspace]) {
    return res.status(403).json({ error: 'Your login does not include that product' });
  }
  await prisma.user.update({ where: { id: req.user.id }, data: { landingWorkspace: workspace } });
  const identity = await resolveIdentity(req.user.id);
  res.json(await sessionPayload(identity));
});

module.exports = router;
