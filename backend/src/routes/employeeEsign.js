// ---------------------------------------------------------------------------
// eMudhra's reply to an employee's Aadhaar signing (utils/employeeEsign.js). eMudhra posts the reply here from its own page, so this
// route is PUBLIC: it is not signed in, and it trusts nothing in the reply until eMudhra's own API has confirmed the signing.
// Mounted at /api/employee-esign.
// ---------------------------------------------------------------------------
const express = require('express');
const { rateLimit } = require('../utils/publicRateLimit');
const { publicBase } = require('../utils/offerLink');

const router = express.Router();
const limit = rateLimit({ bucket: 'employee-esign', max: 30, windowMs: 10 * 60000 });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

router.post('/emudhra/return/:ref/:kind', limit, express.urlencoded({ extended: false, limit: '30mb' }), async (req, res, next) => {
  try {
    const out = await require('../utils/employeeEsign').finish({
      ref: String(req.params.ref || ''),
      kind: String(req.params.kind || ''),
      body: req.body || {},
      base: publicBase(req),
    });
    if (out.to) return res.redirect(303, out.to);
    return res.status(out.status || 400).type('html').send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>My profile</title>`
      + `<body style="font-family:system-ui,Arial,sans-serif;padding:24px;max-width:560px;margin:auto">${esc(out.why || 'Nothing was changed.')}</body>`,
    );
  } catch (err) { return next(err); }
});

module.exports = router;
