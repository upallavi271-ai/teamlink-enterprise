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

module.exports = router;
