// ---------------------------------------------------------------------------
// THE CANDIDATE'S JOINING-LETTER LINK — public, by token, no login (client hiring,
// 2026-10-13). Mounted at /api/joining-link. The recruiter shares the CLIENT'S joining
// letter (utils/clientTrack.js share); the candidate opens it here and presses
// "Confirm joining". The token is an HMAC of the application id and the moment it was
// shared (server secret); a copy of the database opens nothing.
//
//   GET  /:token        the letter details + where it stands
//   GET  /:token/file   the client's joining letter file
//   POST /:token/confirm { name, agree:true } -> the candidate confirmed joining
//
// Rate-limited per IP. No other candidate-facing text names the client: the client's
// own letter (the file) does.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { logAudit } = require('../utils/audit');
const { rateLimit } = require('../utils/publicRateLimit');
const CT = require('../utils/clientTrack');

const router = express.Router();
router.use(rateLimit({ bucket: 'joining-link', max: 120, windowMs: 10 * 60000 }));
const confirmLimit = rateLimit({ bucket: 'joining-confirm', max: 20, windowMs: 10 * 60000 });

const TOKEN = /^[A-Za-z0-9_-]{8,40}\.[a-f0-9]{48}$/;

async function byToken(req, res) {
  const token = String(req.params.token || '');
  if (!TOKEN.test(token)) { res.status(404).json({ error: 'This joining link does not work. Ask your recruiter for a new link.' }); return null; }
  const appId = token.split('.')[0];
  const track = await CT.getTrack(appId);
  if (!CT.joiningTokenOk(token, track)) { res.status(404).json({ error: 'This joining link does not work. Ask your recruiter for a new link.' }); return null; }
  const app = await CT.loadApp(appId);
  if (!app) { res.status(404).json({ error: 'This joining link does not work. Ask your recruiter for a new link.' }); return null; }
  return { app, track };
}

function view(app, track) {
  const j = track.joining;
  return {
    candidateName: app.candidate ? app.candidate.name : '',
    job: (app.requirement && app.requirement.title) || '',
    company: 'our client',
    joiningDate: j.joiningDate || null,
    joiningTime: j.joiningTime || null,
    place: j.place || null,
    reportingPerson: j.reportingPerson || null,
    notes: j.offerNotes || null,
    file: j.file ? { name: j.file.name } : null,
    status: j.state === 'CONFIRMED' ? 'Confirmed' : 'Waiting for you',
    open: j.state === 'SHARED',
    confirmedAt: j.confirmedAt || null,
    joined: ['JOINED', 'HIRED'].includes(app.stage),
  };
}

router.get('/:token', async (req, res, next) => {
  try {
    const got = await byToken(req, res);
    if (!got) return undefined;
    return res.json(view(got.app, got.track));
  } catch (err) { return next(err); }
});

router.get('/:token/file', async (req, res, next) => {
  try {
    const got = await byToken(req, res);
    if (!got) return undefined;
    const f = CT.fileOf(got.track, 'joining');
    if (!f) return res.status(404).json({ error: 'The letter file was not found. Ask your recruiter.' });
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Type', f.mime || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${String(f.name || 'joining-letter').replace(/[^\w.\- ()]/g, '_')}"`);
    return res.sendFile(f.full);
  } catch (err) { return next(err); }
});

router.post('/:token/confirm', confirmLimit, async (req, res, next) => {
  try {
    const got = await byToken(req, res);
    if (!got) return undefined;
    const b = req.body || {};
    const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 100);
    if (name.length < 2) return res.status(400).json({ error: 'Type your full name.' });
    if (b.agree !== true) return res.status(400).json({ error: 'Tick "I will join on this date" first.' });
    if (got.track.joining.state !== 'SHARED') return res.status(409).json({ error: got.track.joining.state === 'CONFIRMED' ? 'You already confirmed. Thank you.' : 'This letter is not waiting for an answer.' });
    if (['JOINED', 'HIRED', 'REJECTED', 'HOLD'].includes(got.app.stage) || got.app.joiningStatus === 'Dropped') return res.status(409).json({ error: 'This joining is closed. Please call your recruiter.' });
    await CT.confirmJoining(got.app, { via: 'the joining link', actorName: name });
    await logAudit({ action: 'Joining link: candidate confirmed', entity: 'Application', entityId: got.app.id, reason: `IP ${require('../utils/clientIp').ipOf(req)}` }); // eslint-disable-line global-require
    const fresh = await CT.getTrack(got.app.id);
    return res.json({ ...view(got.app, fresh), message: 'Thank you. Your joining is confirmed.' });
  } catch (err) {
    if (err instanceof CT.Bad) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

void prisma;
module.exports = router;
