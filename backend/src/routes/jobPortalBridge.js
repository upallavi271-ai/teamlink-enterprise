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

router.post('/applications', async (req, res) => {
  if (!bridge.secretMatches(req.get('x-job-portal-secret'))) {
    return res.status(401).json({ error: 'Invalid or missing job portal secret' });
  }
  const out = await bridge.ingestApplication(req.body);
  return res.status(out.status).json(out.body);
});

module.exports = router;
