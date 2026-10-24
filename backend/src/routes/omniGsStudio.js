// /api/outreach/gs/studio : Content Studio (master message, versions per channel, saved content). Behind login + "may use Omni-Channel" (routes/outreach.js).
// Logic: outreach/studio.js. Nothing here sends or posts anything.
const express = require('express');
const St = require('../outreach/studio');
const Lib = require('../outreach/library');
const { deptOf } = require('../outreach/chrome');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, out) => (out && out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json(out));

router.get('/meta', wrap(async (req, res) => res.json({ channels: St.CHANNELS, voices: St.VOICES, canSave: St.canSave(req.user), canUpload: Lib.mayUpload(req.user) })));
router.get('/content', wrap(async (req, res) => {
  const dept = deptOf(req.user, req.query.dept);
  if (dept === null) return res.json({ items: [], total: 0, canSave: St.canSave(req.user) });
  return res.json(await St.list(req.user, { dept, q: req.query.q }));
}));
router.get('/content/:id', wrap(async (req, res) => {
  const r = await St.get(req.user, req.params.id);
  if (!r) return res.status(404).json({ error: 'This content was not found.' });
  const content = St.view(req.user, r);
  return res.json({ content, media: await Lib.linksFor(content.libraryIds, req.user) });
}));
router.post('/content', wrap(async (req, res) => {
  const b = req.body || {};
  const dept = b.department !== undefined ? b.department : (deptOf(req.user, req.query.dept) || '');
  return send(res, await St.save(req.user, { ...b, department: dept }));
}));
router.put('/content/:id', wrap(async (req, res) => send(res, await St.update(req.user, req.params.id, req.body || {}))));
router.delete('/content/:id', wrap(async (req, res) => send(res, await St.remove(req.user, req.params.id))));
// the rule-based rewrite of the master message for every channel (not AI)
router.post('/adapt', wrap(async (req, res) => {
  const b = req.body || {};
  return res.json({ adaptations: St.adapt(b.master, { name: b.name, cta: b.cta }), method: 'rules' });
}));
router.get('/posts', wrap(async (req, res) => res.json(await St.posts(req.user))));

module.exports = router;
