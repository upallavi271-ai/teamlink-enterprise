// ---------------------------------------------------------------------------
// /api/public/job-portal — the TeamLink Job Portal's door into the ATS.
//
//   GET  /config         the portal's public URL, for the sidebar link, the
//                        Job Portal tab and the requirement page's apply links.
//                        Public: the URL is printed on every job ad anyway.
//   POST /applications   an application made on the portal. Server to server,
//                        guarded by the shared secret JOB_PORTAL_PUSH_SECRET in
//                        the x-job-portal-secret header — never a browser call.
//
// The logic lives in utils/jobPortalBridge.js; this file is only the HTTP edge.
// Mounted ahead of routes/public.js, which keeps serving the classic careers
// pages and the jobs.xml / jobs.feed feeds untouched.
// ---------------------------------------------------------------------------
const express = require('express');
const bridge = require('../utils/jobPortalBridge');

const router = express.Router();

router.get('/config', (req, res) => {
  const s = bridge.status();
  res.json({ url: s.url, configured: s.configured });
});

// GET /go/:idOrSlug?src=…  — an old /careers/<id or slug> link (feeds, ads,
// shared links) → that job on the embedded portal, /jobs/?src=…#/job/tl_<id>.
// Public: it only says where a public job page is. Unknown → the job list.
const CRAWLER = /googlebot|google-inspectiontool|bingbot|duckduckbot|yandexbot|baiduspider|slurp|applebot|facebookexternalhit|linkedinbot|twitterbot/i;
const escHtml = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
async function crawlerPage(req, id, to) {
  const prisma = require('../db'); // eslint-disable-line global-require
  const pub = require('./public'); // eslint-disable-line global-require
  const job = await prisma.requirement.findUnique({ where: { id } });
  if (!job || job.internal || !require('./careersPublic').isListed(job)) return null; // eslint-disable-line global-require
  const ld = JSON.stringify(await pub.jobPostingLdSafe(job, pub.publicBase(req))).split('<').join(String.fromCharCode(92) + 'u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escHtml(job.title)} - TeamLink Jobs</title><meta name="viewport" content="width=device-width, initial-scale=1"><script type="application/ld+json">${ld}</script></head><body><h1>${escHtml(job.title)}</h1><p>${escHtml(job.location || '')}</p><p><a href="${escHtml(to)}">Apply for this job</a></p></body></html>`;
}
router.get('/go/:idOrSlug', async (req, res) => {
  const src = typeof req.query.src === 'string' ? req.query.src.slice(0, 60) : '';
  let r = null;
  try {
    // eslint-disable-next-line global-require
    r = await require('../utils/jobSlug').findByIdOrSlug(req.params.idOrSlug, { select: { id: true } });
  } catch { r = null; }
  // b6_: utm_* and ?ref=<code> travel with the link (ATS-100 B6).
  const extra = {};
  ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'ref'].forEach((k) => {
    if (typeof req.query[k] === 'string' && req.query[k].trim()) extra[k] = req.query[k].trim().slice(0, 100);
  });
  const listQs = new URLSearchParams({ ...(src ? { src } : {}), ...extra }).toString();
  // a person (not a crawler) arriving through a site's tracked link: the post there is live (jobDist/signals.js, 2026-11-03)
  if (r && (src || extra.utm_source) && !CRAWLER.test(String(req.get('user-agent') || ''))) require('../jobDist/signals').record(r.id, src || extra.utm_source, 'visit', { referrer: req.get('referer') }).catch(() => {}); // eslint-disable-line global-require
  const to = r ? bridge.jobUrl(r.id, src || null, extra) : `${bridge.portalUrl()}/${listQs ? `?${listQs}` : ''}`;
  // GOOGLE FOR JOBS (job distribution 2026-10-14): the portal's job page is a hash-routed page, so a crawler that follows this
  // link would find no job markup. A crawler is therefore shown a small page with the job's JobPosting markup (the same
  // markup as /api/public/jobs/:id/jsonld) and a link to apply; a person is redirected as before.
  if (r && CRAWLER.test(String(req.get('user-agent') || ''))) {
    try {
      const html = await crawlerPage(req, r.id, to);
      if (html) { res.set('Cache-Control', 'public, max-age=600'); return res.type('html').send(html); }
    } catch { /* fall back to the redirect */ }
  }
  return res.redirect(302, to);
});

router.post('/applications', async (req, res) => {
  if (!bridge.secretMatches(req.get('x-job-portal-secret'))) {
    return res.status(401).json({ error: 'Invalid or missing job portal secret' });
  }
  const out = await bridge.ingestApplication(req.body);
  return res.status(out.status).json(out.body);
});

// THE PORTAL'S SMS GO THROUGH TEAMLINK'S SMS CHANNEL (founder 2026-11-02): the portal cannot speak the SMS Push Platform, so its SMS provider
// (job-portal-app/embed/teamlink-integration.mjs) hands each message here with the bridge secret. It leaves through TeamLink's own SMS
// gateway - its DLT templates, its opt-out list and its "not proven until a real SMS was delivered" rule - and the answer says what happened.
router.post('/sms', async (req, res) => {
  if (!bridge.secretMatches(req.get('x-job-portal-secret'))) return res.status(401).json({ ok: false, error: 'Invalid or missing job portal secret' });
  const to = String((req.body && req.body.to) || '').trim();
  const text = String((req.body && req.body.text) || '').trim();
  if (!to || !text) return res.status(422).json({ ok: false, error: 'to and text are required' });
  try {
    const out = await require('../utils/smsGateway').sendSms({ to, kind: 'bulk', text }); // eslint-disable-line global-require
    // always 200: the portal reads ok / notConfigured / error (a 5xx would be retried by api.js and send twice)
    return res.json({ ok: !!out.ok, providerRef: out.providerRef || null, provider: out.provider || null, notConfigured: !!out.notConfigured, invalid: !!out.invalid, error: out.ok ? undefined : String(out.error || 'not sent').slice(0, 300) });
  } catch (err) {
    return res.json({ ok: false, error: String((err && err.message) || err).slice(0, 300) });
  }
});

// THE CANDIDATE LOGIN ALSO GOES BY RCS (founder 2026-11-10): the portal's SMS wrapper (job-portal-app/embed/rcs-login.mjs) hands each
// message that carries a NEW temporary password here, server to server with the bridge secret. utils/rcsCandidateLogin.js sends it with
// the approved RCS login template, once per account event, and never stores the password in plain text. Always 200 (see /sms above).
//   POST /rcs-login { to, vars: { candidate_name, login_email, temporary_password, portal_link } } -> { ok, status, msgId?, reason? }
router.post('/rcs-login', async (req, res) => {
  if (!bridge.secretMatches(req.get('x-job-portal-secret'))) return res.status(401).json({ ok: false, error: 'Invalid or missing job portal secret' });
  const b = req.body || {};
  const v = b.vars && typeof b.vars === 'object' && !Array.isArray(b.vars) ? b.vars : {};
  const vars = {};
  ['candidate_name', 'to_name', 'login_email', 'temporary_password', 'portal_link'].forEach((k) => { if (v[k] != null) vars[k] = String(v[k]).slice(0, 300); });
  const out = await require('../utils/rcsCandidateLogin').sendLogin({ to: String(b.to || '').slice(0, 40), vars }); // eslint-disable-line global-require
  return res.json(out);
});

// THE PORTAL'S FORGOT PASSWORD MAIL, WHEN THE PORTAL'S OWN MAIL ACCOUNT CANNOT SEND IT (founder 2026-11-10): job-portal-app/embed/
// teamlink-integration.mjs POST /api/auth/forgot hands the portal's own reset mail here with the bridge secret, and it leaves through
// TeamLink's email account (the one whose test mail reaches Gmail), from the company address. Always 200 with ok / error (no retry storm).
router.post('/email', async (req, res) => {
  if (!bridge.secretMatches(req.get('x-job-portal-secret'))) return res.status(401).json({ ok: false, error: 'Invalid or missing job portal secret' });
  const b = req.body || {};
  const to = String(b.to || '').trim();
  if (!to || !b.subject || !(b.text || b.html)) return res.status(422).json({ ok: false, error: 'to, subject and text are required' });
  try {
    const out = await require('../utils/mailer').sendMail({ to, subject: String(b.subject).slice(0, 200), text: b.text ? String(b.text) : '', html: b.html ? String(b.html) : undefined, useEmployeeFrom: false }); // eslint-disable-line global-require
    return res.json({ ok: !!out.ok, providerRef: out.providerRef || null, notConfigured: !!out.notConfigured, error: out.ok ? null : String(out.error || '').slice(0, 300) });
  } catch (err) {
    return res.json({ ok: false, error: String((err && err.message) || err).slice(0, 300) });
  }
});

// THE PORTAL'S AI INTERVIEW HEARS AND SPEAKS WITH THE AI CALLING VOICES (founder 2026-11-05): utils/interviewVoice.js. Server to server with the
// bridge secret; the audio never leaves this server. Always 200 with ready:false when the engines are not set up, and on a failure: the screen
// then works from the browser alone.
router.post('/interview-voice', express.raw({ type: 'application/octet-stream', limit: '1mb' }), async (req, res) => {
  if (!bridge.secretMatches(req.get('x-job-portal-secret'))) return res.status(401).json({ error: 'Invalid or missing job portal secret' });
  const V = require('../utils/interviewVoice'); // eslint-disable-line global-require
  try {
    if (req.query.op === 'hear') {
      const out = await V.hear(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), req.query.lang);
      console.log('[interview-voice] hear: was', req.query.lang, '->', out.lang, out.changed ? 'CHANGED' : 'same', out.why || '', out.text ? JSON.stringify(String(out.text).slice(0, 60)) : ''); // eslint-disable-line no-console
      return res.json(out);
    }
    const out = await V.say(req.body && req.body.text, req.query.lang);
    if (!out.ready) return res.json({ ready: false });
    res.set('Content-Type', 'audio/wav');
    return res.send(out.wav);
  } catch (err) {
    return res.json({ ready: false, error: String((err && err.message) || err).slice(0, 200) });
  }
});

module.exports = router;
