const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const { resolveIdentity, tokenPayload } = require('../utils/identity');
const { accessMatrix } = require('../utils/permissions');

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
    return res.status(403).json({ error: 'This login has no product access — ask an administrator to grant HRMS, ATS or Accounts' });
  }

  // Stamps the Users screen's "Last Login" column.
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  const token = jwt.sign(tokenPayload(identity), process.env.JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, user: { ...identity, access: await accessMatrix(identity.role) } });
});

// The resolved identity plus the permission matrix the frontend renders its
// nav and its action buttons from — the SAME matrix the server enforces.
router.get('/me', requireAuth, async (req, res) => {
  res.json({ ...req.user, access: await accessMatrix(req.user.role) });
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
  res.json({ ...identity, access: await accessMatrix(identity.role) });
});

module.exports = router;
