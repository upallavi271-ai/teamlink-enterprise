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
  res.redirect(302, to);
});

router.post('/applications', async (req, res) => {
  if (!bridge.secretMatches(req.get('x-job-portal-secret'))) {
    return res.status(401).json({ error: 'Invalid or missing job portal secret' });
  }
  const out = await bridge.ingestApplication(req.body);
  return res.status(out.status).json(out.body);
});

module.exports = router;
