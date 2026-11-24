// ---------------------------------------------------------------------------
// /api/crm-public/b/* - CRM WAVE B, THE PUBLIC SIDE (no login). Mounted in index.js BEFORE the site-wide CORS, because the chat bubble and the
// visit tracker run on the company's own website (another address); everything else here is a page or a provider callback that proves itself:
//   GET  /t/o/:token.gif   /t/c/:token/:i        a CRM email opened / a link in it clicked (crm/b/mail.js)
//   GET/POST /prefs?t=                            the preference centre (signed per address)
//   GET/POST /p/:slug                             a landing page / web form (a sent form = a lead)
//   GET/POST /e/:slug                             an event / webinar registration page
//   GET/POST /s/:token                            an NPS / CSAT survey
//   GET/POST /kb                                  the public help articles
//   GET  /file/:token                             a deal file shared by a signed link (the opening is written on the deal)
//   GET  /oauth/:provider                         Google / Microsoft send the browser back here after "Connect Gmail / Outlook"
//   POST /mail/inbound?key=  /mail/bounce?key=    a mail provider's inbound-parse and bounce webhooks (the hook key)
//   GET  /call/route?key=&CallFrom=               incoming call: which number to put it through to (Exotel Connect dynamic URL / Asterisk curl)
//   GET  /w/chat.js?k=  /w/t.js?k=               the chat bubble and the visit tracker for the website (k = the public site id)
//   POST /w/chat/start  /w/chat/:id/msg  GET /w/chat/:id    the visitor's side of a chat
//   POST /w/pv  /w/id                             a page view; "this visitor is this email"
//   GET/POST /ads/meta   POST /ads/google         Facebook / Instagram lead ads, Google Ads lead forms
// ---------------------------------------------------------------------------
const express = require('express');
const B = require('../crm/b/schema');
const C = require('../crm/b/common');
const MAIL = require('../crm/b/mail');
const PH = require('../crm/b/phone');
const MK = require('../crm/b/marketing');
const PO = require('../crm/b/portal');
const { rateLimit } = require('../utils/publicRateLimit');

const router = express.Router();
const form = express.urlencoded({ extended: false, limit: '32kb' });
const jsonBody = express.json({ limit: '32kb' });
const textJson = express.text({ type: () => true, limit: '32kb' }); // sendBeacon posts text/plain
const parseLoose = (req) => { if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body; try { return JSON.parse(String(req.body || '{}')); } catch { return {}; } };
const limit = (bucket, max) => rateLimit({ bucket: `crm-b-${bucket}`, max, windowMs: 10 * 60000 });
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const hookOk = async (req) => { const st = await B.settings(); const k = String(req.query.key || req.get('x-hook-key') || ''); return !!st.hookKey && k.length === st.hookKey.length && require('crypto').timingSafeEqual(Buffer.from(k), Buffer.from(st.hookKey)); }; // eslint-disable-line global-require
const ipOf = (req) => String(req.ip || req.headers['x-forwarded-for'] || '').slice(0, 60);

// the website widgets (open CORS: any site may load and post them)
router.use('/w', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

// ---- email tracking ----------------------------------------------------------------------------------------------------------
router.get('/t/o/:file', async (req, res) => {
  await MAIL.recordOpen(String(req.params.file || '').replace(/\.gif$/, ''), req.get('user-agent')).catch(() => false);
  res.set('Content-Type', 'image/gif'); res.set('Cache-Control', 'no-store, private');
  return res.send(PIXEL);
});
router.all('/t/c/:token/:i', async (req, res) => {
  const url = await MAIL.recordClick(req.params.token, req.params.i, { ua: req.get('user-agent'), method: req.method }).catch(() => null);
  if (!url || !/^https?:\/\//i.test(url)) return C.htmlOut(res, 404, C.page('This link is not available', '<p>Please use the link exactly as it came in the email.</p>'));
  return res.redirect(302, url);
});

// ---- preference centre -------------------------------------------------------------------------------------------------------
router.get('/prefs', async (req, res) => {
  const email = C.unsign('prefs', req.query.t);
  if (!email) return C.htmlOut(res, 400, C.page('This link is not valid', '<p>Please use the link from the email exactly as it came.</p>'));
  return C.htmlOut(res, 200, MK.prefsHtml(await MK.prefsOf(email), req.query.t));
});
router.post('/prefs', form, async (req, res) => {
  const email = C.unsign('prefs', req.query.t);
  if (!email) return C.htmlOut(res, 400, C.page('This link is not valid', '<p>Please use the link from the email exactly as it came.</p>'));
  const p = await MK.savePrefs(email, req.body || {});
  return C.htmlOut(res, 200, MK.prefsHtml(p, req.query.t, true));
});

// ---- landing pages -----------------------------------------------------------------------------------------------------------
const utmOf = (q) => ({ utm_source: C.clip(q.utm_source, 120), utm_medium: C.clip(q.utm_medium, 120), utm_campaign: C.clip(q.utm_campaign, 120) });
router.get('/p/:slug', async (req, res) => {
  const lp = await MK.landingView(req.params.slug);
  if (!lp) return C.htmlOut(res, 404, C.page('Page not found', '<p>This page is not available.</p>'));
  res.removeHeader('X-Frame-Options'); // a web form may sit in an iframe on the company website
  return C.htmlOut(res, 200, MK.landingHtml(lp, { embed: req.query.embed === '1', utm: utmOf(req.query) }));
});
router.post('/p/:slug', limit('lp', 30), form, async (req, res) => {
  const out = await MK.landingSubmit(req.params.slug, { ...utmOf(req.query), ...(req.body || {}) });
  res.removeHeader('X-Frame-Options');
  if (!out.lp) return C.htmlOut(res, 404, C.page('Page not found', '<p>This page is not available.</p>'));
  return C.htmlOut(res, out.error ? out.status || 400 : 200, MK.landingHtml(out.lp, { embed: req.query.embed === '1', sent: !out.error, error: out.error }));
});

// ---- events ------------------------------------------------------------------------------------------------------------------
router.get('/e/:slug', async (req, res) => {
  const ev = await MK.eventOfSlug(req.params.slug);
  if (!ev) return C.htmlOut(res, 404, C.page('Event not found', '<p>This event is not available.</p>'));
  return C.htmlOut(res, 200, MK.eventHtml(ev));
});
router.post('/e/:slug', limit('ev', 30), form, async (req, res) => {
  const out = await MK.register(req.params.slug, req.body || {});
  if (!out.ev) return C.htmlOut(res, out.status || 404, C.page('Registration closed', `<p>${C.esc(out.error)}</p>`));
  return C.htmlOut(res, out.error ? out.status || 400 : 200, MK.eventHtml(out.ev, { done: !out.error, error: out.error, already: out.already }));
});

// ---- surveys -----------------------------------------------------------------------------------------------------------------
router.get('/s/:token', async (req, res) => {
  const s = await PO.surveyOfToken(req.params.token);
  if (!s) return C.htmlOut(res, 404, C.page('This link is not valid', '<p>Please use the link from the email.</p>'));
  return C.htmlOut(res, 200, PO.surveyHtml(s, { already: !!s.answeredAt }));
});
router.post('/s/:token', limit('sv', 30), form, async (req, res) => {
  const out = await PO.answerSurvey(req.params.token, req.body || {});
  if (!out.s) return C.htmlOut(res, 404, C.page('This link is not valid', '<p>Please use the link from the email.</p>'));
  return C.htmlOut(res, out.error ? 400 : 200, PO.surveyHtml(out.s, { done: out.ok, already: out.already, error: out.error }));
});

// ---- help articles -----------------------------------------------------------------------------------------------------------
router.get('/kb', async (req, res) => {
  if (req.query.a) {
    const a = await PO.kbArticle(req.query.a);
    if (!a) return C.htmlOut(res, 404, C.page('Not found', '<p>This article is not available.</p>'));
    return C.htmlOut(res, 200, PO.kbHtml(null, a));
  }
  return C.htmlOut(res, 200, PO.kbHtml(await PO.kbPublic({ q: req.query.q }), null, req.query.q));
});
router.post('/kb', limit('kb', 60), form, async (req, res) => {
  await PO.kbHelpful(req.query.a, String((req.body || {}).yes) === '1');
  return C.htmlOut(res, 200, C.page('Thank you', '<p>Thank you for telling us.</p><p><a href="?">Back to the help articles</a></p>'));
});

// ---- a shared deal file ------------------------------------------------------------------------------------------------------
router.get('/file/:token', async (req, res) => {
  const f = await MAIL.fileOfToken(req.params.token).catch(() => null);
  if (!f) return C.htmlOut(res, 404, C.page('This link has expired', '<p>Please ask us to send the document again.</p>'));
  await MAIL.docViewed('file', f.id, req).catch(() => null);
  res.set('Content-Type', f.mime); res.set('Content-Disposition', `inline; filename="${String(f.name).replace(/"/g, '')}"`);
  res.set('Cache-Control', 'private, no-store'); res.set('X-Robots-Tag', 'noindex'); res.set('X-Content-Type-Options', 'nosniff');
  return res.sendFile(f.full);
});

// ---- Gmail / Outlook come back here ------------------------------------------------------------------------------------------
router.get('/oauth/:provider', async (req, res) => {
  try {
    if (req.query.error) return C.htmlOut(res, 400, C.page('Not connected', `<p>${C.esc(String(req.query.error_description || req.query.error))}</p>`));
    const out = await MAIL.oauthCallback(req.params.provider, { code: req.query.code, state: req.query.state });
    if (out.error) return C.htmlOut(res, 400, C.page('Not connected', `<p>${C.esc(out.error)}</p>`));
    return C.htmlOut(res, 200, C.page('Connected', `<p>${C.esc(out.label)} ${out.email ? `(${C.esc(out.email)}) ` : ''}is connected to the CRM. Its mail is read every 5 minutes while "Read the connected mailboxes" is on. You can close this tab.</p>`));
  } catch (e) { return C.htmlOut(res, 502, C.page('Not connected', `<p>${C.esc(e.message)}</p>`)); }
});

// ---- mail provider webhooks --------------------------------------------------------------------------------------------------
router.post('/mail/inbound', express.text({ type: () => true, limit: '2mb' }), async (req, res) => {
  if (!(await hookOk(req))) return res.status(401).json({ error: 'The key is not right.' });
  if (!(await B.on('mailSync'))) return res.json({ off: true });
  const raw = typeof req.body === 'string' ? req.body : '';
  if (!raw.includes(':')) return res.status(400).json({ error: 'Send the raw mail (MIME) as the body.' });
  const out = await MAIL.ingestRaw(raw, { source: 'webhook', mailbox: C.clip(req.query.mailbox, 200) || '', team: req.query.team === '1' });
  return res.json({ ok: true, result: out.result });
});
router.post('/mail/bounce', jsonBody, async (req, res) => {
  if (!(await hookOk(req))) return res.status(401).json({ error: 'The key is not right.' });
  const list = Array.isArray(req.body) ? req.body : [req.body || {}];
  let n = 0;
  for (const b of list.slice(0, 200)) {
    const email = b.email || b.recipient || (b.mail && b.mail.destination && b.mail.destination[0]);
    const type = /soft|transient|temporary|deferred/i.test(String(b.type || b.bounceType || b.event || '')) ? 'soft' : 'hard';
    // eslint-disable-next-line no-await-in-loop
    if (await MAIL.recordBounce(email, { type, code: b.code || b.status || null, reason: b.reason || b.diagnostic || b.description || null, source: 'webhook' })) n += 1;
  }
  return res.json({ ok: true, recorded: n });
});

// ---- incoming call routing ---------------------------------------------------------------------------------------------------
router.get('/call/route', async (req, res) => {
  if (!(await hookOk(req))) return res.status(401).type('text/plain').send('');
  const out = await PH.routeInbound({ from: req.query.CallFrom || req.query.from, to: req.query.CallTo || req.query.to, callSid: req.query.CallSid || req.query.sid }).catch(() => ({ action: 'default' }));
  if (req.query.format === 'json') return res.json(out);
  // Exotel's Connect applet reads the number to dial as plain text; nothing = its own fallback number
  return res.type('text/plain').send(out.action === 'connect' ? out.number : '');
});

// ---- the website: chat and visits ----------------------------------------------------------------------------------------------
router.get('/w/chat.js', async (req, res) => {
  const st = await B.settings();
  res.type('application/javascript'); res.set('Cache-Control', 'public, max-age=300');
  if (!st.siteId || req.query.k !== st.siteId) return res.send('/* TeamLink chat: unknown site id */');
  return res.send(PH.widgetJs(C.baseUrl(), st.siteId));
});
router.get('/w/t.js', async (req, res) => {
  const st = await B.settings();
  res.type('application/javascript'); res.set('Cache-Control', 'public, max-age=300');
  if (!st.siteId || req.query.k !== st.siteId || !st.webTracking) return res.send('/* TeamLink: visit tracking is off */');
  return res.send(MK.trackerJs(C.baseUrl(), st.siteId));
});
router.post('/w/chat/start', limit('chat', 20), jsonBody, async (req, res) => { const out = await PH.chatStart(req.body || {}, { ip: ipOf(req) }); return res.status(out.status).json(out.body); });
router.post('/w/chat/:id/msg', limit('chatmsg', 120), jsonBody, async (req, res) => { const out = await PH.chatVisitorSay(req.params.id, req.body || {}); return res.status(out.status).json(out.body); });
router.get('/w/chat/:id', limit('chatread', 400), async (req, res) => { const out = await PH.chatVisitorRead(req.params.id, req.query || {}); return res.status(out.status).json(out.body); });
router.post('/w/pv', limit('pv', 300), textJson, async (req, res) => { await MK.trackView(parseLoose(req)).catch(() => null); return res.status(204).end(); });
router.post('/w/id', limit('pvid', 60), textJson, async (req, res) => { await MK.identify(parseLoose(req)).catch(() => null); return res.status(204).end(); });

// ---- ad leads ----------------------------------------------------------------------------------------------------------------
router.get('/ads/meta', async (req, res) => {
  const cfg = await MK.adsConfig();
  if (req.query['hub.mode'] === 'subscribe' && cfg.verifyToken && req.query['hub.verify_token'] === cfg.verifyToken) return res.type('text/plain').send(String(req.query['hub.challenge'] || ''));
  return res.status(403).type('text/plain').send('');
});
router.post('/ads/meta', express.raw({ type: () => true, limit: '256kb' }), async (req, res) => {
  const cfg = await MK.adsConfig();
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!MK.metaSignatureOk(raw, req.get('x-hub-signature-256'), cfg.appSecret)) return res.status(401).json({ error: 'bad signature' });
  let payload = {}; try { payload = JSON.parse(raw.toString('utf8') || '{}'); } catch { payload = {}; }
  const out = await MK.metaLeads(payload).catch((e) => ({ errors: [e.message] }));
  return res.json({ ok: true, ...out }); // always 200 so Facebook does not keep retrying a lead we already have
});
router.post('/ads/google', jsonBody, async (req, res) => { const out = await MK.googleLead(req.body || {}); return res.status(out.status).json(out.body); });

module.exports = router;
