// ---------------------------------------------------------------------------
// PUBLIC OUTREACH ENDPOINTS (no login). Mounted at /api/public/outreach and at /u/:token.
//   GET  /u/:token   a small page with ONE button. It changes nothing (mail scanners and link previews fetch links; they must not unsubscribe anyone).
//   POST /u/:token   does it: opts the contact out of that channel, writes the history + the do-not-contact hash. Idempotent (a second
//                    press says the same thing and writes no second history row). Also the RFC 8058 one-click target from the
//                    List-Unsubscribe-Post header.
// A bad / tampered / unknown token gets the same plain answer; nothing says whether a person exists. Rate limited per IP.
// ---------------------------------------------------------------------------
const express = require('express');
const { rateLimit } = require('../utils/publicRateLimit');
const L = require('../outreach/links');
const C = require('../outreach/consent');
const S = require('../outreach/store');

const router = express.Router();
const lim = rateLimit({ bucket: 'outreach-unsub', max: 60, windowMs: 10 * 60000 });
const form = express.urlencoded({ extended: false, limit: '4kb' });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const CH = { email: 'emails', whatsapp: 'WhatsApp messages', sms: 'text messages' };

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font-family:system-ui,Segoe UI,Arial,sans-serif;background:#f4f7fb;margin:0;padding:24px;color:#1b2740}main{max-width:460px;margin:8vh auto;background:#fff;border:1px solid #d6dde8;border-radius:12px;padding:24px;text-align:center}h1{font-size:20px;margin:0 0 10px}p{line-height:1.5;margin:8px 0}button{background:#1d5fd1;color:#fff;border:0;border-radius:8px;padding:12px 22px;font-size:16px;cursor:pointer;margin-top:12px}</style></head><body><main>${body}</main></body></html>`;
}
const noStore = (res) => { res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); };

router.get('/u/:token', lim, (req, res) => {
  noStore(res);
  const v = L.verifyUnsubscribe(req.params.token);
  if (!v.ok) return res.status(400).type('html').send(page('Link not valid', '<h1>This link does not work</h1><p>It may be incomplete. If you keep getting messages you do not want, reply STOP or contact the sender.</p>'));
  return res.type('html').send(page('Stop messages', `<h1>Stop these ${esc(CH[v.channel])}?</h1><p>Press the button and we will not send you job ${esc(CH[v.channel])} again.</p><form method="post" action=""><button type="submit">Yes, stop them</button></form>`));
});

async function doIt(req, res) {
  noStore(res);
  const v = L.verifyUnsubscribe(req.params.token);
  const oneClick = req.accepts(['html', 'json']) === 'json' || (req.body && req.body['List-Unsubscribe'] === 'One-Click');
  const bad = () => (oneClick ? res.status(400).json({ ok: false }) : res.status(400).type('html').send(page('Link not valid', '<h1>This link does not work</h1><p>It may be incomplete. Reply STOP to a message or contact the sender.</p>')));
  if (!v.ok) return bad();
  if (!(await S.ready())) return res.status(503).type('html').send(page('Try again', '<h1>Please try again in a little while</h1>'));
  const out = await C.optOut(v.contactId, v.channel, { reason: 'unsubscribe_link', source: 'unsubscribe_link', evidence: 'Used the unsubscribe link', by: null });
  // an unknown contact answers exactly like a known one (nothing to learn from the link)
  if (out.error && out.status !== 404) return bad();
  return oneClick ? res.json({ ok: true }) : res.type('html').send(page('Done', `<h1>Done</h1><p>You will not get job ${esc(CH[v.channel])} from us any more. You can close this page.</p>`));
}
router.post('/u/:token', lim, form, (req, res, next) => { doIt(req, res).catch(next); });

// ---- the short tracked link: /r/<token> (and /api/public/outreach/r/<token>) -----------------------------------------------------------
// Counts the FIRST HUMAN click of that message (a scanner / link preview / HEAD / a click within seconds of the send does not count),
// then 302s to the job portal apply URL. The target is built on the server from the campaign's own job: the address asked for contributes
// the token and nothing else, so this can never be used as an open redirect. A forged / unknown / internal-campaign token gets a plain 404.
const Camp = require('../outreach/campaigns');
const limClick = rateLimit({ bucket: 'outreach-click', max: 240, windowMs: 10 * 60000 });
router.get('/r/:token', limClick, (req, res, next) => {
  noStore(res);
  res.set('X-Robots-Tag', 'noindex');
  Camp.resolveClick(req.params.token, { ua: req.get('user-agent'), method: req.method }).then((r) => {
    if (r.redirect) return res.redirect(302, r.redirect);
    return res.status(404).type('html').send(page('Link not valid', '<h1>This link does not work</h1><p>It may be incomplete or too old. Please open the job from the message again, or ask the sender for a new link.</p>'));
  }).catch(next);
});

module.exports = router;
