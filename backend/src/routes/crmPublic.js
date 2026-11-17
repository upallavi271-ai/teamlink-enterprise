// ---------------------------------------------------------------------------
// CRM - PUBLIC PAGES (no login, 2026-11-02; redeployed from main the same day, twice, after local copies without the CRM replaced live). Only the unsubscribe link at the foot of a CRM campaign email:
//   GET /api/crm-public/unsubscribe?t=<signed token>   adds the address to CrmOptOut (no more campaign emails) and says so.
// The token is the email signed with the server secret (crm/campaigns.js), so a link cannot be made for somebody else.
// ---------------------------------------------------------------------------
const express = require('express');
const CMP = require('../crm/campaigns');

const router = express.Router();
const page = (title, text) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f7fb;color:#1b2a4a;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px}
.card{background:#fff;border:1px solid #e3e8f0;border-radius:14px;padding:28px 24px;max-width:440px;text-align:center;box-shadow:0 4px 18px rgba(20,40,80,.06)}h1{font-size:20px;margin:0 0 8px}p{color:#5b6474;line-height:1.5;margin:0}</style></head>
<body><div class="card"><h1>${title}</h1><p>${text}</p></div></body></html>`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

router.get('/unsubscribe', async (req, res) => {
  const email = CMP.emailOfToken(req.query.t);
  res.set('Content-Type', 'text/html; charset=utf-8');
  if (!email) return res.status(400).send(page('This link is not valid', 'Please use the unsubscribe link from the email exactly as it came, or simply reply to the email and ask us to stop.'));
  try {
    await CMP.optOut('email', email, { reason: 'unsubscribe link' });
    return res.send(page('You are unsubscribed', `${esc(email)} will not receive TeamLink Consultants campaign emails any more. Replies to your own messages still reach us.`));
  } catch (e) {
    return res.status(500).send(page('Something went wrong', 'Please try the link again in a minute, or reply to the email and ask us to stop.'));
  }
});

// The invoice PDF a customer opens from the WhatsApp message (no login): the link is signed and expires after 30 days (crm/extra.js shareInvoice).
router.get('/invoice/:token', async (req, res) => {
  const X = require('../crm/extra'); // eslint-disable-line global-require
  const id = X.invoiceOfToken(req.params.token);
  if (!id) { res.set('Content-Type', 'text/html; charset=utf-8'); return res.status(404).send(page('This link has expired', 'Please ask us to send the invoice again.')); }
  try {
    const out = await X.invoicePdf(null, id, { signed: true });
    if (!out.pdf) { res.set('Content-Type', 'text/html; charset=utf-8'); return res.status(404).send(page('This invoice is not available', 'Please ask us to send it again.')); }
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${out.name}"`);
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Robots-Tag', 'noindex');
    return res.send(out.pdf);
  } catch (e) {
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.status(500).send(page('Something went wrong', 'Please try the link again in a minute.'));
  }
});

// The customer answers a proposal from the email (founder 2026-11-16). GET only SHOWS the proposal with two buttons (a mail scanner opening the link changes nothing);
// the POST of a button records the answer (crm/extra.js decideByCustomer). The link is signed and expires after 60 days.
const bad = (res) => { res.set('Content-Type', 'text/html; charset=utf-8'); return res.status(404).send(page('This link has expired', 'Please ask us to send the proposal again.')); };
router.get('/proposal/:token/pdf', async (req, res) => {
  const X = require('../crm/extra'); // eslint-disable-line global-require
  const id = X.proposalOfToken(req.params.token);
  if (!id) return bad(res);
  try {
    const out = await X.proposalPdf(null, id, { signed: true });
    if (!out.pdf) return bad(res);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${out.name}"`);
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Robots-Tag', 'noindex');
    return res.send(out.pdf);
  } catch (e) { return bad(res); }
});
const answerPage = (p, token, doneWords) => {
  const head = `Proposal ${esc(p.number)}${p.company ? ` for ${esc(p.company)}` : ''}`;
  if (doneWords) return page(head, doneWords);
  if (['Accepted', 'Declined'].includes(p.status)) return page(head, `This proposal is already marked <b>${esc(p.status)}</b>. To change it, please reply to our email.`);
  const pdf = `/api/crm-public/proposal/${esc(token)}/pdf`;
  return page(head, `${p.toName ? `Dear ${esc(p.toName)}, ` : ''}please read the proposal and tell us what you decide.<br><br><a href="${pdf}" target="_blank" rel="noopener" style="color:#2563eb">Open the proposal (PDF)</a><form method="post" action="/api/crm-public/proposal/${esc(token)}" style="margin-top:18px;display:flex;gap:10px;justify-content:center"><button name="decision" value="accept" style="background:#16a34a;color:#fff;border:0;border-radius:8px;padding:11px 20px;font-size:15px;cursor:pointer">Accept</button><button name="decision" value="decline" style="background:#fff;color:#b91c1c;border:1px solid #fecaca;border-radius:8px;padding:11px 20px;font-size:15px;cursor:pointer">Decline</button></form>`);
};
router.get('/proposal/:token', async (req, res) => {
  const X = require('../crm/extra'); // eslint-disable-line global-require
  const id = X.proposalOfToken(req.params.token);
  const p = id ? await X.proposalForCustomer(id).catch(() => null) : null;
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Robots-Tag', 'noindex');
  if (!p) return bad(res);
  return res.send(answerPage(p, req.params.token));
});
router.post('/proposal/:token', express.urlencoded({ extended: false, limit: '2kb' }), async (req, res) => {
  const X = require('../crm/extra'); // eslint-disable-line global-require
  const id = X.proposalOfToken(req.params.token);
  res.set('Content-Type', 'text/html; charset=utf-8');
  if (!id) return bad(res);
  try {
    const p = await X.proposalForCustomer(id);
    if (!p) return bad(res);
    const out = await X.decideByCustomer(id, String((req.body || {}).decision || ''), { ip: req.ip || (req.headers['x-forwarded-for'] || '') });
    if (out.error) return res.status(400).send(page(`Proposal ${esc(p.number)}`, esc(out.error)));
    if (out.already) return res.send(answerPage({ ...p, status: out.status }, req.params.token));
    return res.send(page(`Proposal ${esc(p.number)}`, out.status === 'Accepted' ? 'Thank you. You have <b>accepted</b> the proposal. Our team will contact you shortly with the next steps.' : 'Thank you for letting us know. You have <b>declined</b> the proposal. We will be in touch to understand how we can help better.'));
  } catch (e) {
    return res.status(500).send(page('Something went wrong', 'Please try again in a minute, or reply to our email.'));
  }
});

// OUR PRODUCTS: the lead's demo page and the AI meeting room (routes/crmProductPages.js, crm/productSales.js)
router.use(require('./crmProductPages')); // eslint-disable-line global-require

module.exports = router;
