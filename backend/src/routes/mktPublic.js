// ---------------------------------------------------------------------------
// /api/public/mkt - MARKET WAVE C: the no-login doors (each one guards itself: a signed / random token, a rate limit,
// a webhook signature or a per-person extension key). Nothing here reads a candidate's contact details back out.
//
//   GET  /book/:token                 POST /book/:token { slot }          POST /book/:token/none { note }      (07.03)
//   GET  /test/:token                 POST /test/:token/start              POST /test/:token/submit { answers } (07.15)
//   GET  /t/o/:token.gif              GET  /t/c/:token/:i                                                        (08.04)
//   GET  /cal/:token.ics              GET  /cal-oauth/:provider/callback                                         (07.01)
//   GET  /site?lang=                  GET  /job/:idOrSlug?lang= (server-rendered SEO page)                      (10.18 / 10.02)
//   POST /quick-fill (resume)         POST /alerts/subscribe   GET /alerts/confirm/:t   GET /alerts/stop/:t     (10.04 / 10.14)
//   POST /boards/:board/applications  (X-Signature: sha256=<HMAC of the raw body>)                              (10.07 / 10.09 / 10.10)
//   GET  /feeds/linkedin.xml                                                                                     (10.10)
//   ext: GET /ext/me   GET /ext/check?url=   POST /ext/profile   (header X-TeamLink-Key; mounted at /api/public/mkt/ext) (10.11)
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { rateLimit } = require('../utils/publicRateLimit');
const C = require('../utils/mkt/core');
const IV = require('../utils/mkt/interviews');
const AS = require('../utils/mkt/assess');
const MC = require('../utils/mkt/comms');
const MP = require('../utils/mkt/portal');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const sbx = () => C.isSandbox();
const limit = (bucket, max, min = 10) => rateLimit({ bucket: `mkt-${bucket}`, max: sbx() ? max * 50 : max, windowMs: min * 60000 });
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,Arial,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;color:#111}</style></head><body>${body}</body></html>`;

// ================================================================== 07.03 self-scheduling
router.get('/book/:token', limit('book', 120), wrap(async (req, res) => {
  const row = await IV.selfBookRow(req.params.token);
  if (!row) return res.status(404).json({ error: 'This link is not valid.' });
  const app = await prisma.application.findUnique({ where: { id: row.applicationId }, select: { candidate: { select: { name: true } }, requirement: { select: { title: true, internal: true } } } });
  const meta = C.json(row.slots, {});
  const expired = new Date(row.expiresAt) < new Date();
  res.set('Cache-Control', 'no-store');
  return res.json({
    firstName: String((app && app.candidate.name) || '').split(/\s+/)[0], job: app && app.requirement.title, company: app && app.requirement.internal ? 'TeamLink' : 'our client',
    status: expired && row.status === 'open' ? 'expired' : row.status, minutes: Number(row.minutes), mode: row.mode, round: Number(row.round),
    slots: row.status === 'open' && !expired ? (meta.slots || []).filter((s) => new Date(s).getTime() > Date.now() + 15 * 60000) : [], pickedSlot: row.pickedSlot, expiresAt: row.expiresAt,
  });
}));
router.post('/book/:token', limit('book-pick', 20), wrap(async (req, res) => {
  const row = await IV.selfBookRow(req.params.token);
  if (!row) return res.status(404).json({ error: 'This link is not valid.' });
  const out = await IV.pickSelfBook(row, String((req.body || {}).slot || ''));
  if (out.error) return res.status(out.status).json({ error: out.error });
  return res.json(out);
}));
router.post('/book/:token/none', limit('book-none', 20), wrap(async (req, res) => {
  const row = await IV.selfBookRow(req.params.token);
  if (!row) return res.status(404).json({ error: 'This link is not valid.' });
  const out = await IV.declineSelfBook(row, (req.body || {}).note);
  if (out.error) return res.status(out.status).json({ error: out.error });
  return res.json({ ok: true, message: 'Thank you. The recruiter has been told and will send you new times.' });
}));

// ================================================================== 07.15 tests
router.get('/test/:token', limit('test', 120), wrap(async (req, res) => {
  const row = await AS.sendRow(req.params.token);
  if (!row) return res.status(404).json({ error: 'This test link is not valid.' });
  const out = await AS.publicView(row);
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.set('Cache-Control', 'no-store');
  return res.json(out);
}));
router.post('/test/:token/start', limit('test-start', 30), wrap(async (req, res) => {
  const row = await AS.sendRow(req.params.token);
  if (!row) return res.status(404).json({ error: 'This test link is not valid.' });
  const out = await AS.start(row);
  return out.error ? res.status(out.status).json({ error: out.error }) : res.json(out);
}));
router.post('/test/:token/submit', limit('test-submit', 20), wrap(async (req, res) => {
  const row = await AS.sendRow(req.params.token);
  if (!row) return res.status(404).json({ error: 'This test link is not valid.' });
  const out = await AS.submit(row, (req.body || {}).answers);
  if (out.error) return res.status(out.status).json({ error: out.error });
  return res.json({ ok: true, message: out.late ? 'Sent in (after the time limit - the recruiter will see that).' : 'Thank you, your answers are sent in. The recruiter will get back to you.' });
}));

// ================================================================== 08.04 tracking
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
router.get('/t/o/:file', wrap(async (req, res) => {
  const token = String(req.params.file || '').replace(/\.gif$/, '');
  await MC.recordOpen(token, req.get('user-agent')).catch(() => false);
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, max-age=0', 'Content-Length': GIF.length });
  return res.end(GIF);
}));
router.all('/t/c/:token/:i', wrap(async (req, res) => {
  const url = await MC.recordClick(req.params.token, req.params.i, { ua: req.get('user-agent'), method: req.method }).catch(() => null);
  if (!url || !/^https?:\/\//i.test(url)) return res.status(404).type('html').send(page('Link not found', '<p>This link is not valid any more.</p>'));
  return res.redirect(302, url);
}));

// ================================================================== 07.01 calendar feed + OAuth callback
router.get('/cal/:file', limit('cal', 240), wrap(async (req, res) => {
  const uid = await IV.userOfFeed(String(req.params.file || '').replace(/\.ics$/, ''));
  if (!uid) return res.status(404).type('text/plain').send('Not found');
  const { resolveIdentity } = require('../utils/identity'); // eslint-disable-line global-require
  const user = await resolveIdentity(uid);
  if (!user || user.status !== 'Active') return res.status(404).type('text/plain').send('Not found');
  const events = await IV.feedEvents(user);
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, max-age=300' });
  return res.send(IV.icsOf(events, `TeamLink interviews - ${user.name}`));
}));
router.get('/cal-oauth/:provider/callback', wrap(async (req, res) => {
  const out = await IV.connectCallback(req, req.params.provider);
  const back = `${C.publicBase(req)}/ats/interviews`;
  if (out.error) return res.status(out.status).type('html').send(page('Calendar not connected', `<h2>Calendar not connected</h2><p>${out.error}</p><p><a href="${back}">Back to TeamLink</a></p>`));
  return res.type('html').send(page('Calendar connected', `<h2>Your calendar is connected</h2><p>Booked interviews can now go into it, and your busy times are used when TeamLink suggests interview slots.</p><p><a href="${back}">Back to TeamLink</a></p>`));
}));

// ================================================================== 10.18 site, 10.02 SEO job page
router.get('/site', limit('site', 600), wrap(async (req, res) => {
  const out = await MP.publicSite({ lang: req.query.lang });
  res.set('Cache-Control', 'public, max-age=60');
  return res.json(out);
}));
router.get('/job/:idOrSlug', limit('seo', 600), wrap(async (req, res) => {
  const job = await require('../utils/jobSlug').findByIdOrSlug(String(req.params.idOrSlug).slice(0, 160)); // eslint-disable-line global-require
  if (!job || job.internal || !require('./careersPublic').isListed(job)) return res.status(404).type('html').send(page('Job not found', '<p>This job is not open any more.</p>')); // eslint-disable-line global-require
  res.set('Cache-Control', 'public, max-age=600');
  return res.type('html').send(await MP.seoJobPage(req, job, { lang: String(req.query.lang || 'en') }));
}));
router.get('/feeds/linkedin.xml', limit('feed', 120), wrap(async (req, res) => {
  res.set({ 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=900' });
  return res.send(await MP.linkedinFeed(req));
}));

// ================================================================== 10.04 quick apply
router.post('/quick-fill', limit('quick-fill', 20), wrap(async (req, res) => {
  let parsed;
  try { parsed = await require('../utils/resumeStore').parseResumeUpload(req); } catch (err) { return res.status(err.code === 'TOO_LARGE' ? 413 : 400).json({ error: err.code === 'TOO_LARGE' ? 'The resume is too large.' : 'Choose your resume.' }); } // eslint-disable-line global-require
  if (!parsed.file) return res.status(400).json({ error: 'Choose your resume.' });
  try { return res.json(await MP.quickFill(parsed.file)); } catch (err) {
    return res.status(400).json({ error: require('../utils/resumeStore').RESUME_MESSAGE[err.code] || 'Only PDF and Word resumes can be read.' }); // eslint-disable-line global-require
  }
}));

// ================================================================== 10.14 alerts
router.post('/alerts/subscribe', limit('alerts', 10), wrap(async (req, res) => {
  if (String((req.body || {}).website || '').trim()) return res.json({ ok: true, message: 'Saved.' }); // honeypot
  const out = await MP.subscribe(req.body || {}, req);
  if (out.error) return res.status(out.status).json({ error: out.error });
  return res.json(out);
}));
router.get('/alerts/confirm/:token', limit('alerts-c', 60), wrap(async (req, res) => {
  const ok = await MP.confirmAlert(req.params.token);
  return res.type('html').send(page('Job alerts', ok ? '<h2>Done</h2><p>You will get new jobs by email. Every email has a link to stop them.</p>' : '<p>This link is not valid any more.</p>'));
}));
router.get('/alerts/stop/:token', limit('alerts-s', 60), wrap(async (req, res) => {
  const ok = await MP.stopAlert(req.params.token);
  return res.type('html').send(page('Job alerts', ok ? '<h2>Stopped</h2><p>You will not get job alert emails any more.</p>' : '<p>This link is not valid any more.</p>'));
}));

// ================================================================== 10.07 / 10.09 / 10.10 board webhooks (raw body: index.js mounts express.raw first)
router.post('/boards/:board/applications', limit('board', 120, 1), wrap(async (req, res) => {
  const board = req.params.board;
  if (!MP.BOARDS[board]) return res.status(404).json({ error: 'Unknown board.' });
  const cfg = await MP.boardConfig(board);
  if (!cfg.webhookSecret) return res.status(503).json({ error: `${MP.BOARDS[board]} is not set up in TeamLink yet.` });
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
  if (!MP.verifySignature(cfg.webhookSecret, raw, req.get('x-signature') || req.get('x-teamlink-signature'))) return res.status(401).json({ error: 'Bad signature.' });
  let body; try { body = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'The body is not JSON.' }); }
  const list = Array.isArray(body) ? body : (Array.isArray(body.applications) ? body.applications : [body]);
  const out = await MP.ingestMany(board, list);
  return res.status(out.errors.length && !out.added && !out.duplicates ? 422 : 200).json(out);
}));

// ================================================================== 10.11 the browser extension (its own open CORS; the key is the login)
const ext = express.Router();
ext.use((req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-TeamLink-Key', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
});
ext.use(express.json({ limit: '200kb' }));
ext.use(limit('ext', 300));
ext.use(wrap(async (req, res, next) => {
  const uid = await MP.userOfExtKey(req.get('x-teamlink-key'));
  if (!uid) return res.status(401).json({ error: 'The extension key is not valid. Make a new one in TeamLink: Candidates > a candidate > Outreach tools > Browser extension.' });
  const { resolveIdentity } = require('../utils/identity'); // eslint-disable-line global-require
  const user = await resolveIdentity(uid);
  if (!user || user.status !== 'Active') return res.status(401).json({ error: 'This login is not active.' });
  req.user = user;
  return next();
}));
ext.get('/me', wrap(async (req, res) => res.json({ name: req.user.name, mayAdd: await require('../middleware/auth').can(req.user, 'ats', 'candidates', 'Add Candidate', 'create') }))); // eslint-disable-line global-require
ext.get('/check', wrap(async (req, res) => {
  const url = MP.cleanLinkedin(req.query.url);
  if (!url) return res.json({ known: false });
  const cid = await MP.candidateByLink('linkedin', url);
  if (!cid) return res.json({ known: false });
  const { candidateWhere } = require('../utils/scope'); // eslint-disable-line global-require
  const c = await prisma.candidate.findFirst({ where: { AND: [{ id: cid }, candidateWhere(req.user)] }, select: { id: true, name: true } });
  return res.json({ known: true, inScope: !!c, candidate: c ? { id: c.id, name: c.name, url: `${C.publicBase(req)}/candidates/${c.id}` } : null });
}));
ext.post('/profile', wrap(async (req, res) => {
  if (!(await require('../middleware/auth').can(req.user, 'ats', 'candidates', 'Add Candidate', 'create'))) return res.status(403).json({ error: 'Your role cannot add candidates.' }); // eslint-disable-line global-require
  const out = await MP.addFromProfile(req.user, req.body || {});
  if (out.error) return res.status(out.status).json({ error: out.error });
  await require('../utils/audit').logAudit({ userId: req.user.id, action: out.created ? 'Candidate added from LinkedIn (browser extension)' : 'LinkedIn profile matched an existing candidate (extension)', entity: 'Candidate', entityId: out.candidate.id, toValue: out.candidate.name }); // eslint-disable-line global-require
  return res.status(out.status).json({ ...out, url: `${C.publicBase(req)}/candidates/${out.candidate.id}` });
}));

module.exports = router;
module.exports.ext = ext;
