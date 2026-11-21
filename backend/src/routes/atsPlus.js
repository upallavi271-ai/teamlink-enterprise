// ---------------------------------------------------------------------------
// /api/ats-plus - the "market wave" features (founder 2026-11-21), one router per area in utils/atsPlus/*.js.
// Every route here needs a signed-in login; the public pieces (status page, trust page, pre-boarding link, identity check,
// the open REST API and its docs, single sign-on) are mounted by index.js on their own paths.
// No screen of these has a sidebar item: they are tabs inside Reports & Team, Clients, Offers / Joining and Administration.
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
const AREAS = ['people', 'bd', 'offers', 'onboarding', 'admin', 'integrations', 'privacy', 'status', 'idverify', 'sso', 'i18n'];
const fs = require('fs');
const path = require('path');

AREAS.forEach((a) => {
  if (!fs.existsSync(path.join(__dirname, '..', 'utils', 'atsPlus', `${a}.js`))) return;
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const mod = require(`../utils/atsPlus/${a}`);
  if (mod.router) router.use(mod.router);
});

module.exports = router;
