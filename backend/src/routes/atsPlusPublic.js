// ---------------------------------------------------------------------------
// ATS PLUS - the PUBLIC pieces (market wave 2026-11-21). No staff login: each proves itself (a link token, an API key, a signed SSO
// state) and is rate-limited. Mounted by index.js after the JSON body parser.
//   /api/public/preboarding/:token     the candidate's pre-boarding page (utils/atsPlus/onboarding.js)
//   /api/public/verify/:token          the candidate's identity check by OTP (utils/atsPlus/idverify.js)
//   /api/public/status, /api/public/trust   the status page and the trust centre (utils/atsPlus/status.js)
//   /api/v1/open/* (= /api/open/*) + /api/docs              the open REST API with API keys, and its OpenAPI page (utils/atsPlus/integrations.js)
//   /api/sso/*                          single sign-on: OIDC and SAML 2.0 (utils/atsPlus/sso.js)
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const express = require('express');

const router = express.Router();
const has = (f) => fs.existsSync(path.join(__dirname, '..', 'utils', 'atsPlus', `${f}.js`));
/* eslint-disable global-require */
if (has('onboarding')) router.use('/api/public/preboarding', require('../utils/atsPlus/onboarding').publicRouter);
if (has('idverify')) router.use('/api/public/verify', require('../utils/atsPlus/idverify').publicRouter);
if (has('status')) router.use('/api/public', require('../utils/atsPlus/status').publicRouter);
if (has('integrations')) { const I = require('../utils/atsPlus/integrations'); router.use('/api/open', I.apiRouter); router.use('/api/docs', I.docsRouter); router.use('/api/public/connectors', I.publicRouter); }
if (has('sso')) router.use('/api/sso', require('../utils/atsPlus/sso').publicRouter);
if (has('mobileZ')) router.use(require('../utils/atsPlus/mobileZ').wellKnown); // ATS wave 2 Z: /.well-known/assetlinks.json + apple-app-site-association for the store apps
if (has('vendorsZ')) router.use('/api/public/vendorsz', require('../utils/atsPlus/vendorsZ').publicRouter); // ATS wave 2 Z: BGV / assessment vendor results
/* eslint-enable global-require */

module.exports = router;
