// /api/outreach/gs/library : the media library (files and links). Behind login + "may use Omni-Channel" (routes/outreach.js). Logic: outreach/library.js.
const express = require('express');
const Lib = require('../outreach/library');
const { deptOf } = require('../outreach/chrome');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, out) => (out && out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json(out));

router.get('/', wrap(async (req, res) => {
  const dept = deptOf(req.user, req.query.dept);
  if (dept === null) return res.json({ items: [], total: 0, counts: {}, canUpload: false });
  return res.json(await Lib.list(req.user, { q: req.query.q, type: req.query.type, dept, mine: req.query.mine === '1', limit: req.query.limit }));
}));
router.post('/upload', wrap(async (req, res) => send(res, await Lib.upload(req.user, req))));
router.post('/link', wrap(async (req, res) => send(res, await Lib.saveLink(req.user, req.body || {}))));
router.post('/links-for', wrap(async (req, res) => res.json({ links: await Lib.linksFor((req.body || {}).ids, req.user) })));
router.put('/:id', wrap(async (req, res) => send(res, await Lib.update(req.user, req.params.id, req.body || {}))));
router.delete('/:id', wrap(async (req, res) => send(res, await Lib.remove(req.user, req.params.id))));

module.exports = router;
