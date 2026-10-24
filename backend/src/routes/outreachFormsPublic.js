// ---------------------------------------------------------------------------
// PUBLIC CAPTURE FORMS (no login). Mounted at /api/public/outreach (index.js), so:
//   GET  /api/public/outreach/forms/:token   the fields + the permission words of one form (JSON). A wrong, switched-off or deleted form: the same plain 404.
//   POST /api/public/outreach/forms/:token   { answers: { key: value }, channels: [..], consent: true, website: '' } -> { ok, message }
// Safe by design: a hidden "website" box (a robot fills it; the answer looks like success but nothing is saved), a limit per IP address, short boxes,
// a required permission tick, the same answer for a new and a known person, never a second contact for the same phone / email, never lifting an opt-out.
// The person's "yes" is saved per way of contact with source 'form' and the form's name + the version of the words as evidence (outreach/forms.js).
// ---------------------------------------------------------------------------
const express = require('express');
const { rateLimit } = require('../utils/publicRateLimit');
const F = require('../outreach/forms');
const S = require('../outreach/store');

const router = express.Router();
const limGet = rateLimit({ bucket: 'omni-form-get', max: 120, windowMs: 10 * 60000 });
const limPost = rateLimit({ bucket: 'omni-form-post', max: 15, windowMs: 10 * 60000, message: 'Too many tries from your network. Please wait a few minutes and try again.' });
const noStore = (res) => { res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); res.set('X-Robots-Tag', 'noindex'); };
const GONE = { error: 'This form is not available. It may be switched off or the link is incomplete.' };

router.get('/forms/:token', limGet, (req, res, next) => {
  (async () => {
    noStore(res);
    if (!(await S.ready())) return res.status(503).json({ error: 'Please try again in a little while.' });
    const r = await F.publicForm(req.params.token);
    if (!r) return res.status(404).json(GONE);
    return res.json({ form: await F.publicShape(r) });
  })().catch(next);
});

router.post('/forms/:token', limPost, (req, res, next) => {
  (async () => {
    noStore(res);
    if (!(await S.ready())) return res.status(503).json({ error: 'Please try again in a little while.' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (JSON.stringify(body).length > 20000) return res.status(413).json({ error: 'That is too much text for one form.' });
    const r = await F.publicForm(req.params.token);
    if (!r) return res.status(404).json(GONE);
    // the honeypot: a person never sees this box
    if (String(body.website || '').trim()) return res.json({ ok: true, message: r.thanks || 'Thank you. We have your details.' });
    const out = await F.publicSubmit(r, body);
    return out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json({ ok: true, message: out.message });
  })().catch(next);
});

module.exports = router;
