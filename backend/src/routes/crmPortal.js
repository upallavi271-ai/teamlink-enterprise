// ---------------------------------------------------------------------------
// /api/crm-portal/* - THE CRM CUSTOMER / PARTNER PORTAL API (CRM wave B, 12.01 12.02 12.03 12.04 12.06). The page is /crm-portal (frontend
// pages/CrmPortal.jsx), a login of its own: never a staff login. The session token travels in the X-CRM-Portal header (not Authorization,
// so the staff login checks never see it). Every route after /login and /accept reads the portal user from the session row and fences
// what it returns by that user's own account / partner - nothing in the request chooses whose data it is.
// Closed (403) until an Admin switches on "Customer and partner portal" (CRM > Dashboard > Settings).
// ---------------------------------------------------------------------------
const express = require('express');
const PO = require('../crm/b/portal');
const { rateLimit } = require('../utils/publicRateLimit');

const router = express.Router();
router.use(express.json({ limit: '64kb' }));
const tokenOf = (req) => String(req.get('x-crm-portal') || '');
const send = (res, out) => res.status(out.status).json(out.body);

router.post('/login', rateLimit({ bucket: 'crm-portal-login', max: 20, windowMs: 10 * 60000, message: 'Too many tries. Please wait ten minutes.' }), async (req, res, next) => { try { return send(res, await PO.login(req.body || {})); } catch (e) { return next(e); } });
router.post('/accept', rateLimit({ bucket: 'crm-portal-accept', max: 20, windowMs: 10 * 60000 }), async (req, res, next) => { try { return send(res, await PO.acceptInvite(req.body || {})); } catch (e) { return next(e); } });

// everything below needs a live portal session
router.use(async (req, res, next) => {
  try {
    const u = await PO.sessionUser(tokenOf(req));
    if (!u) return res.status(401).json({ error: 'Please sign in again.' });
    req.portalUser = u;
    res.set('Cache-Control', 'private, no-store');
    return next();
  } catch (e) { return next(e); }
});
const wrap = (fn) => async (req, res, next) => { try { return send(res, await fn(req.portalUser, req)); } catch (e) { return next(e); } };

router.post('/logout', wrap((u, req) => PO.logout(tokenOf(req))));
router.get('/me', wrap((u) => PO.me(u)));
router.get('/quotes', wrap((u) => PO.quotes(u)));
router.post('/quotes/:id/decision', wrap((u, req) => PO.decideQuote(u, req.params.id, req.body || {}, { ip: req.ip })));
router.get('/quotes/:id/pdf', async (req, res, next) => {
  try {
    const p = await PO.quoteOf(req.portalUser, req.params.id);
    if (!p) return res.status(404).json({ error: 'This quote is not there.' });
    const out = await require('../crm/extra').proposalPdf(null, p.id, { signed: true }); // eslint-disable-line global-require
    if (!out.pdf) return res.status(404).json({ error: 'This quote is not available.' });
    await require('../crm/b/mail').docViewed('proposal', p.id, req, { what: `proposal ${p.number} (portal)` }).catch(() => null); // eslint-disable-line global-require
    res.set('Content-Type', 'application/pdf'); res.set('Content-Disposition', `inline; filename="${out.name}"`);
    return res.send(out.pdf);
  } catch (e) { return next(e); }
});
router.get('/invoices', wrap((u) => PO.invoices(u)));
router.get('/invoices/:id/pdf', async (req, res, next) => {
  try {
    const inv = await PO.invoiceOf(req.portalUser, req.params.id);
    if (!inv) return res.status(404).json({ error: 'This invoice is not there.' });
    const out = await require('../crm/extra').invoicePdf(null, inv.id, { signed: true }); // eslint-disable-line global-require
    if (!out.pdf) return res.status(404).json({ error: 'This invoice is not available.' });
    res.set('Content-Type', 'application/pdf'); res.set('Content-Disposition', `inline; filename="${out.name}"`);
    return res.send(out.pdf);
  } catch (e) { return next(e); }
});
router.get('/tickets', wrap((u) => PO.tickets(u)));
router.post('/tickets', wrap((u, req) => PO.raiseTicket(u, req.body || {})));
router.get('/tickets/:id', wrap((u, req) => PO.ticket(u, req.params.id)));
router.post('/tickets/:id/comments', wrap((u, req) => PO.ticketComment(u, req.params.id, req.body || {})));
router.get('/kb', wrap(async (u, req) => ({ status: 200, body: { articles: await PO.kbPublic({ q: req.query.q }) } })));
router.get('/kb/:id', wrap(async (u, req) => { const a = await PO.kbArticle(req.params.id); return a ? { status: 200, body: { article: { id: a.id, title: a.title, category: a.category, body: a.body } } } : { status: 404, body: { error: 'Not found.' } }; }));
router.post('/kb/:id/helpful', wrap(async (u, req) => ({ status: 200, body: { ok: await PO.kbHelpful(req.params.id, !!(req.body || {}).yes) } })));
router.get('/deals', wrap((u) => PO.partnerDeals(u)));
router.post('/deals', wrap((u, req) => PO.registerDeal(u, req.body || {})));

module.exports = router;
