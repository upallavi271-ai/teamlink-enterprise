// ---------------------------------------------------------------------------
// CLIENT HIRING — the offer / joining letters the CLIENT sends (user, 2026-10-13),
// our (staff) side. Mounted into routes/interviewsJoining.js (/api/ats): same
// login, ATS product gate and scope (loadScoped). The client's own side is in
// routes/portal.js; the candidate's joining page is routes/joiningLink.js.
// All the rules live in utils/clientTrack.js.
//
//   GET  /offers/:id/track                 where this offer stands + the letter details
//   POST /offers/:id/client-release        BDE / Admin records the client's offer letter
//                                          (multipart: file + fields + note) — audited
//                                          "on behalf of the client"
//   POST /offers/:id/share  { via }        share with the candidate: Email | WhatsApp |
//                                          SMS | Link (the candidate link)
//   POST /offers/:id/client-ack { note }   BDE / Admin records "the client confirmed"
//   GET  /offers/:id/client-letter/:kind   the client's letter file (offer | joining)
//   GET  /joining/:id/track
//   POST /joining/:id/client-release       the client's joining letter (same)
//   POST /joining/:id/share  { via }
//   POST /joining/:id/candidate-confirm    the recruiter records "the candidate confirmed"
//   GET|PUT /client-track/reminders        Admin: switch on the offer / joining reminders
//   POST /client-track/reminders/run       Admin: run them now ({ dryRun })
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { requirePerm } = require('../middleware/auth');
const attachments = require('../utils/attachments');
const CT = require('../utils/clientTrack');

const send = (res, err) => {
  if (err instanceof CT.Bad) return res.status(err.status).json({ error: err.message, ...err.extra });
  console.error('[clientTrack]', err); // eslint-disable-line no-console
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
};

async function readUpload(req) {
  try { return await attachments.parseMultipart(req); } catch (err) {
    if (err.code === 'TOO_LARGE') throw new CT.Bad(attachments.MESSAGE.TOO_LARGE);
    if (err.code === 'NOT_MULTIPART') throw new CT.Bad(attachments.MESSAGE.NOT_MULTIPART);
    throw new CT.Bad('The upload could not be read. Please try again.');
  }
}

module.exports = function mountClientTrackRoutes(router, { loadScoped }) {
  const trackRoute = (path, feature) => router.get(path, requirePerm('ats', 'interviews', feature, 'view'), async (req, res) => {
    const app = await loadScoped(req, res);
    if (!app) return undefined;
    try { return res.json({ track: await CT.shapeFor(req.user, app) }); } catch (err) { return send(res, err); }
  });
  trackRoute('/offers/:id/track', 'Offers');
  trackRoute('/joining/:id/track', 'Joining');

  const releaseRoute = (kind, path, feature) => router.post(path, requirePerm('ats', 'interviews', feature, 'edit'), async (req, res) => {
    try {
      const app = await loadScoped(req, res);
      if (!app) return undefined;
      const up = await readUpload(req);
      await CT.release(kind, app, { actor: req.user, fields: up.fields, file: up.file, note: up.fields.note });
      const fresh = await CT.loadApp(app.id);
      return res.json({
        track: await CT.shapeFor(req.user, fresh),
        message: kind === 'offer' ? "Saved. The client's offer letter is recorded. The recruiter can share it with the candidate." : "Saved. The client's joining letter is recorded. The recruiter can share it with the candidate.",
      });
    } catch (err) { return send(res, err); }
  });
  releaseRoute('offer', '/offers/:id/client-release', 'Offers');
  releaseRoute('joining', '/joining/:id/client-release', 'Joining');

  const shareRoute = (kind, path, feature) => router.post(path, requirePerm('ats', 'interviews', feature, 'edit'), async (req, res) => {
    try {
      const app = await loadScoped(req, res);
      if (!app) return undefined;
      const via = ['Email', 'WhatsApp', 'SMS', 'Link'].includes((req.body || {}).via) ? req.body.via : null;
      if (!via) return res.status(400).json({ error: 'Choose Email, WhatsApp, SMS or Copy the link.' });
      const out = await CT.share(kind, app, { actor: req.user, via, req });
      const fresh = await CT.loadApp(app.id);
      const words = via === 'Link' ? 'Link ready — copy it and send it to the candidate.' : (out.sent ? `Sent on ${via}.` : `${via} could not be sent${out.error ? ` (${out.error})` : ''} — copy the link instead.`);
      return res.json({ ...out, track: await CT.shapeFor(req.user, fresh), message: `${kind === 'offer' ? 'Offer' : 'Joining letter'} shared. ${words}` });
    } catch (err) { return send(res, err); }
  });
  shareRoute('offer', '/offers/:id/share', 'Offers');
  shareRoute('joining', '/joining/:id/share', 'Joining');

  router.post('/offers/:id/client-ack', requirePerm('ats', 'interviews', 'Offers', 'edit'), async (req, res) => {
    try {
      const app = await loadScoped(req, res);
      if (!app) return undefined;
      await CT.acknowledge(app, { actor: req.user, note: (req.body || {}).note });
      return res.json({ track: await CT.shapeFor(req.user, await CT.loadApp(app.id)), message: "Saved. The client's confirmation is recorded." });
    } catch (err) { return send(res, err); }
  });

  router.post('/joining/:id/candidate-confirm', requirePerm('ats', 'interviews', 'Joining', 'edit'), async (req, res) => {
    try {
      const app = await loadScoped(req, res);
      if (!app) return undefined;
      await CT.confirmJoining(app, { via: `recorded by ${req.user.name}`, actor: req.user });
      return res.json({ track: await CT.shapeFor(req.user, await CT.loadApp(app.id)), message: 'Saved. The candidate confirmed joining.' });
    } catch (err) { return send(res, err); }
  });

  router.get('/offers/:id/client-letter/:kind', requirePerm('ats', 'interviews', 'Offers', 'view'), async (req, res) => {
    const app = await loadScoped(req, res);
    if (!app) return undefined;
    if (!(await CT.mayOpenFiles(req.user))) return res.status(403).json({ error: "Opening the client's letter is not included in your role." });
    const kind = req.params.kind === 'joining' ? 'joining' : 'offer';
    const f = CT.fileOf(await CT.getTrack(app.id), kind);
    if (!f) return res.status(404).json({ error: "The client's letter file was not found." });
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Type', f.mime || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${String(f.name || 'letter').replace(/[^\w.\- ()]/g, '_')}"`);
    return res.sendFile(f.full);
  });

  const adminOnly = (req, res) => {
    if (!CT.isAdmin(req.user)) { res.status(403).json({ error: 'Only an Admin can change this.' }); return false; }
    return true;
  };
  router.get('/client-track/reminders', requirePerm('ats', 'interviews', 'Offers', 'view'), async (req, res) => {
    res.json({ ...(await CT.loadReminders()), canEdit: CT.isAdmin(req.user) });
  });
  router.put('/client-track/reminders', requirePerm('ats', 'interviews', 'Offers', 'approve'), async (req, res) => {
    if (!adminOnly(req, res)) return undefined;
    const s = await CT.saveReminders({ armed: (req.body || {}).armed, offerNudgeDays: (req.body || {}).offerNudgeDays }, req.user);
    await require('../utils/audit').logAudit({ userId: req.user.id, action: `Offer and joining reminders ${s.armed ? 'switched ON' : 'switched OFF'}`, entity: 'AppSetting', entityId: CT.REMINDERS_KEY, toValue: s.armed ? 'on' : 'off' }); // eslint-disable-line global-require
    return res.json({ ...s, canEdit: true, message: s.armed ? 'Saved. Reminders are on.' : 'Saved. Reminders are off.' });
  });
  router.post('/client-track/reminders/run', requirePerm('ats', 'interviews', 'Offers', 'approve'), async (req, res) => {
    if (!adminOnly(req, res)) return undefined;
    const out = await CT.runReminders({ force: true, dryRun: (req.body || {}).dryRun === true });
    return res.json(out);
  });

  void prisma;
};
