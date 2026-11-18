// ---------------------------------------------------------------------------
// /api/ats - INTERVIEW ROUNDS, per-round feedback, attachments and interviewer ratings (ATS audit 2026-11-18). Rules: utils/interviewRounds.js.
//
//   GET    /interviews/:id/rounds                       every round (type, date, mode, link, panel, feedback, files) + the suggested decision
//   PUT    /interviews/:id/rounds/:round                { roundType?, meetingLink?, linkProvider? }  who may schedule
//   PUT    /interviews/:id/rounds/:round/feedback       typed feedback of ANY round (the current round's usual route is POST /interviews/:id/feedback)
//   POST   /interviews/:id/rounds/:round/attachments    multipart file (+ title) OR json { kind: 'link'|'note', url|note, title }
//   GET    /interview-attachments/:attId/file           download
//   DELETE /interview-attachments/:attId
//   POST   /interviews/:id/rounds/:round/rate-interviewer  { userId?|name, rating 1-5, comment }
//   GET    /interviewer-ratings?userId=&name=            average per interviewer: TL / Manager / Admin only
//   POST   /meeting-link/check                          { url, provider } -> { ok, url, provider } | 400
// The BDE team never reads the internal panel's feedback or the files (P2); a client login has no access here.
// ---------------------------------------------------------------------------
const express = require('express');
const fs = require('fs');
const prisma = require('../db');
const { requireAuth, requireProduct, can } = require('../middleware/auth');
const { applicationWhere, atsScopeOf } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const attachments = require('../utils/attachments');
const IR = require('../utils/interviewRounds');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));

const DENIED = { error: "This action isn't included in your role's permissions" };
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isClient = (u) => [u.role, u.atsRole].includes('CLIENT') || [u.role, u.atsRole].includes('CANDIDATE');
const isBdeView = (u) => { const f = require('../utils/clientRedact').privacyFlagsFor(u); return !!(f && f.bde); }; // eslint-disable-line global-require
const mayReadRatings = (u) => { const s = atsScopeOf(u); return !!s.global || ['TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'].includes(s.atsRole) || ['ADMIN', 'SUPER_ADMIN'].includes(u.role); };

router.use((req, res, next) => (isClient(req.user) ? res.status(403).json(DENIED) : next()));

async function load(req, res) {
  const app = await prisma.application.findFirst({ where: { AND: [{ id: req.params.id }, applicationWhere(req.user)] }, include: { candidate: { select: { name: true } }, requirement: { select: { title: true } } } });
  if (!app || !app.interviewStatus) { res.status(404).json({ error: 'Interview not found' }); return null; }
  return app;
}
const roundNo = (req, res) => {
  const n = Number(req.params.round);
  if (!Number.isInteger(n) || n < 1 || n > 20) { res.status(400).json({ error: 'Round should be a number from 1 to 20.' }); return null; }
  return n;
};

router.get('/interviews/:id/rounds', wrap(async (req, res) => {
  const app = await load(req, res); if (!app) return;
  const bde = isBdeView(req.user);
  let rounds = await IR.roundsOf(app, { withFeedback: !bde, withAttachments: !bde });
  if (bde) rounds = rounds.map((r) => ({ ...r, feedback: null, attachments: [], interviewerRatings: [] }));
  const canFeedback = await can(req.user, 'ats', 'interviews', 'Interview Feedback', 'create');
  res.json({
    applicationId: app.id, candidate: app.candidate && app.candidate.name, requirement: app.requirement && app.requirement.title, currentRound: app.interviewRound || 1, rounds,
    suggested: bde ? null : IR.suggestedDecision(rounds), roundTypes: IR.ROUND_TYPES, providers: IR.PROVIDERS,
    canFeedback, canSchedule: await can(req.user, 'ats', 'interviews', 'Schedule Interview', 'edit'), canRate: canFeedback && !bde, mayReadRatings: mayReadRatings(req.user),
  });
}));

router.put('/interviews/:id/rounds/:round', wrap(async (req, res) => {
  if (!(await can(req.user, 'ats', 'interviews', 'Schedule Interview', 'edit'))) return res.status(403).json(DENIED);
  const app = await load(req, res); if (!app) return;
  const round = roundNo(req, res); if (!round) return;
  const b = req.body || {};
  if (b.roundType !== undefined) {
    const out = await IR.setRoundType(app.id, round, b.roundType, req.user);
    if (out.error) return res.status(400).json({ error: out.error });
  }
  if (b.meetingLink !== undefined || b.linkProvider !== undefined) {
    const chk = IR.checkMeetingLink(b.meetingLink, b.linkProvider);
    if (!chk.ok) return res.status(400).json({ error: chk.error });
    await IR.noteBooking(app.id, round, { roundType: b.roundType, scheduledAt: round === (app.interviewRound || 1) ? app.interviewAt : null, mode: app.interviewMode, location: app.interviewLocation, meetingLink: chk.url, linkProvider: chk.provider, panel: app.interviewer, status: app.interviewStatus });
    if (round === (app.interviewRound || 1)) await prisma.application.update({ where: { id: app.id }, data: { interviewMeetingLink: chk.url } });
  }
  await logAudit({ userId: req.user.id, action: `Interview round ${round} details changed`, entity: 'Application', entityId: app.id, toValue: String(b.roundType || b.linkProvider || 'link') });
  res.json({ ok: true, rounds: await IR.roundsOf(app) });
}));

router.put('/interviews/:id/rounds/:round/feedback', wrap(async (req, res) => {
  if (isBdeView(req.user) || !(await can(req.user, 'ats', 'interviews', 'Interview Feedback', 'create'))) return res.status(403).json(DENIED);
  const app = await load(req, res); if (!app) return;
  const round = roundNo(req, res); if (!round) return;
  const rounds = await IR.roundsOf(app, { withFeedback: false, withAttachments: false });
  const meta = rounds.find((r) => r.round === round);
  const type = req.body.roundType || (meta && meta.roundType) || 'Other';
  const out = IR.cleanFeedback(type, req.body || {});
  if (out.error) return res.status(400).json({ error: out.error });
  await IR.saveFeedback(app.id, round, out.value, req.user);
  await require('../utils/feedbackHistory').record(app.id, 'Internal', round, { ...out.value }, req.user).catch(() => {}); // eslint-disable-line global-require
  if (round === (app.interviewRound || 1)) {
    const data = { technical: out.value.technical, communication: out.value.communication, experience: out.value.experience, roleFit: out.value.roleFit, overall: out.value.overall, recommendation: out.value.recommendation, submittedById: req.user.id, submittedBy: req.user.name };
    await prisma.interviewFeedback.upsert({ where: { applicationId_kind: { applicationId: app.id, kind: 'Internal' } }, create: { applicationId: app.id, kind: 'Internal', ...data }, update: data });
  }
  await logAudit({ userId: req.user.id, action: `Interview round ${round} feedback saved (${out.value.roundType}) - ${out.value.recommendation}`, entity: 'Application', entityId: app.id, toValue: out.value.recommendation });
  const all = await IR.roundsOf(app);
  res.json({ ok: true, rounds: all, suggested: IR.suggestedDecision(all) });
}));

const FILE_OPTS = { allowWord: true, allowVideo: true, maxBytes: IR.MAX_FILE };
router.post('/interviews/:id/rounds/:round/attachments', wrap(async (req, res) => {
  if (isBdeView(req.user) || !(await can(req.user, 'ats', 'interviews', 'Interview Feedback', 'create'))) return res.status(403).json(DENIED);
  const app = await load(req, res); if (!app) return;
  const round = roundNo(req, res); if (!round) return;
  const ctype = String(req.headers['content-type'] || '');
  let row;
  if (/multipart\/form-data/i.test(ctype)) {
    let parsed;
    try { parsed = await attachments.parseMultipart(req, { maxBytes: IR.MAX_FILE }); } catch (err) {
      return res.status(err.code === 'TOO_LARGE' ? 413 : 400).json({ error: err.code === 'TOO_LARGE' ? `That file is larger than ${IR.MAX_FILE / 1048576} MB.` : 'Choose a file to upload.' });
    }
    let stored;
    try { stored = attachments.store(parsed.file, FILE_OPTS); } catch (err) {
      const msg = { NO_FILE: 'Choose a file to upload.', TOO_LARGE: `That file is larger than ${IR.MAX_FILE / 1048576} MB.`, BAD_TYPE: 'Attach a PDF, Word file, picture or an mp4 / webm recording.', CONTENT_MISMATCH: "That file's contents do not match its type." }[err.code] || 'The file could not be saved.';
      return res.status(err.code === 'TOO_LARGE' ? 413 : 400).json({ error: msg });
    }
    row = { kind: 'file', title: (parsed.fields && parsed.fields.title) || stored.billName, fileStored: stored.billFile, fileName: stored.billName, fileMime: stored.billMime, fileSize: stored.billSize, note: parsed.fields && parsed.fields.note };
  } else {
    const b = req.body || {};
    if (b.kind === 'note') {
      if (!String(b.note || '').trim()) return res.status(400).json({ error: 'Write the note.' });
      row = { kind: 'note', title: b.title, note: b.note };
    } else {
      const chk = IR.checkAttachmentUrl(b.url);
      if (chk.error) return res.status(400).json({ error: chk.error });
      row = { kind: 'link', title: b.title || 'Recording / notes link', url: chk.url, note: b.note };
    }
  }
  const id = await IR.addAttachment(app.id, round, row, req.user);
  await logAudit({ userId: req.user.id, action: `Interview round ${round}: ${row.kind} attached`, entity: 'Application', entityId: app.id, toValue: String(row.title || row.kind).slice(0, 120) });
  res.status(201).json({ ok: true, id, rounds: await IR.roundsOf(app) });
}));

router.get('/interview-attachments/:attId/file', wrap(async (req, res) => {
  const a = await IR.attachmentRow(req.params.attId);
  if (!a || !a.fileStored || isBdeView(req.user)) return res.status(404).json({ error: 'File not found' });
  const ok = await prisma.application.findFirst({ where: { AND: [{ id: a.applicationId }, applicationWhere(req.user)] }, select: { id: true } });
  if (!ok) return res.status(403).json({ error: 'This record is outside your access scope' });
  const full = attachments.resolveStored(a.fileStored);
  if (!full) return res.status(404).json({ error: 'File not found' });
  res.setHeader('Content-Type', a.fileMime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${String(a.fileName || 'attachment').replace(/[^\w.\- ]/g, '_')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return fs.createReadStream(full).pipe(res);
}));

router.delete('/interview-attachments/:attId', wrap(async (req, res) => {
  const a = await IR.attachmentRow(req.params.attId);
  if (!a) return res.status(404).json({ error: 'Not found' });
  const ok = await prisma.application.findFirst({ where: { AND: [{ id: a.applicationId }, applicationWhere(req.user)] }, select: { id: true } });
  if (!ok) return res.status(403).json({ error: 'This record is outside your access scope' });
  if (!(a.byId === req.user.id || mayReadRatings(req.user))) return res.status(403).json({ error: 'Only the person who added it, a TL or an Admin can remove it.' });
  await IR.removeAttachment(a.id);
  if (a.fileStored) attachments.remove(a.fileStored);
  await logAudit({ userId: req.user.id, action: 'Interview attachment removed', entity: 'Application', entityId: a.applicationId, fromValue: String(a.title || a.kind) });
  res.json({ ok: true });
}));

router.post('/interviews/:id/rounds/:round/rate-interviewer', wrap(async (req, res) => {
  if (isBdeView(req.user) || !(await can(req.user, 'ats', 'interviews', 'Interview Feedback', 'create'))) return res.status(403).json(DENIED);
  const app = await load(req, res); if (!app) return;
  const round = roundNo(req, res); if (!round) return;
  const b = req.body || {};
  let who = { userId: null, name: String(b.name || '').trim() };
  if (b.userId) {
    const u = await prisma.user.findUnique({ where: { id: String(b.userId) }, select: { id: true, name: true } });
    if (!u) return res.status(400).json({ error: 'That interviewer was not found.' });
    who = { userId: u.id, name: u.name };
  }
  // The person rated must have been on that round's panel (or named as its interviewer).
  const rounds = await IR.roundsOf(app, { withFeedback: false, withAttachments: false });
  const rd = rounds.find((r) => r.round === round);
  const named = rd && (rd.panel.some((p) => (who.userId && p.userId === who.userId) || p.name.toLowerCase() === who.name.toLowerCase()) || rd.interviewers.some((n) => n.toLowerCase() === who.name.toLowerCase()));
  if (!named) return res.status(400).json({ error: 'You can only rate someone who took that round.' });
  const out = await IR.rateInterviewer(app.id, round, who, b.rating, b.comment, req.user);
  if (out.error) return res.status(400).json({ error: out.error });
  await logAudit({ userId: req.user.id, action: `Interviewer rated ${out.rating}/5 (round ${round})`, entity: 'Application', entityId: app.id, toValue: who.name });
  res.json({ ok: true, rating: out.rating });
}));

router.get('/interviewer-ratings', wrap(async (req, res) => {
  if (!mayReadRatings(req.user)) return res.status(403).json({ error: 'Interviewer ratings are for TLs, Managers and Admins.' });
  res.json({ rows: await IR.interviewerSummary({ userId: req.query.userId, name: req.query.name }) });
}));

router.post('/meeting-link/check', wrap(async (req, res) => {
  const chk = IR.checkMeetingLink((req.body || {}).url, (req.body || {}).provider);
  if (!chk.ok) return res.status(400).json({ error: chk.error });
  res.json({ ok: true, url: chk.url, provider: chk.provider });
}));

module.exports = router;
