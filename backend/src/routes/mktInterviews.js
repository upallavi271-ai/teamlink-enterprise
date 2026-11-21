// ---------------------------------------------------------------------------
// /api/ats/mkt - MARKET WAVE C: interviews and the per-job kits / tests / apply-form settings (utils/mkt/*.js).
// Mounted ahead of the calendar-gated /api/ats routers. A client or candidate login has no access; the BDE team reads the
// briefing without contact details, pay or the panel's feedback, and never the recordings. Manager / Assistant Manager are
// VIEW ONLY (every write below asks can(... 'create' | 'edit'), which refuses them).
//
//   Kits (07.09)        GET  /jobs/:rid/kits                 PUT /jobs/:rid/kits/:round     DELETE /jobs/:rid/kits/:round
//                       POST /jobs/:rid/kits/:round/suggest  (AI from the JD; code draft when the model is down)
//   Job settings        GET|PUT /jobs/:rid/settings          { selfBook, linkedinApply, fields[] (apply form, 10.03) }
//   Tests (07.15/16)    GET|POST /jobs/:rid/assessments      PUT /assessments/:aid     POST /jobs/:rid/assessments/generate
//                       POST /interviews/:id/assessments/:aid/send { email }   GET /applications/:id/assessments
//                       POST /assessment-results/:token/regrade { i, got }
//   Scorecard           GET /interviews/:id/scorecard?round=  PUT /interviews/:id/scorecard
//   Briefing (07.10)    GET /interviews/:id/briefing
//   Recordings (07.07)  GET|POST /interviews/:id/recordings  GET /recordings/:rid/file  POST /recordings/:rid/reviews
//   Notes (07.11)       POST /recordings/:rid/transcript { text? }   POST /recordings/:rid/notes
//   Voice (07.13)       POST /interviews/:id/voice-feedback (multipart audio + transcript)
//   Summary (07.12)     GET /interviews/:id/feedback-summary
//   Slots (07.05)       POST /interviews/:id/suggest-slots       POST /interviews/:id/replacements { declined }
//   Self-book (07.03)   POST /interviews/:id/self-book            GET /interviews/:id/self-book
//   Calendar (07.01)    GET /interviews/:id/ics   GET /calendar/feed  POST /calendar/feed/reset
//                       GET /calendar/connections   POST /calendar/:provider/connect   DELETE /calendar/:provider   POST /interviews/:id/calendar-push
// ---------------------------------------------------------------------------
const express = require('express');
const fs = require('fs');
const prisma = require('../db');
const { requireAuth, requireProduct, can } = require('../middleware/auth');
const { applicationWhere, requirementWhere, matches } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const attachments = require('../utils/attachments');
const C = require('../utils/mkt/core');
const IV = require('../utils/mkt/interviews');
const AS = require('../utils/mkt/assess');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const DENIED = { error: "This action isn't included in your role's permissions" };
const isClient = (u) => ['CLIENT', 'CANDIDATE', 'VENDOR', 'PARTNER'].some((r) => [u.role, u.atsRole].includes(r)) || require('../utils/permissions').isExternalLogin(u); // eslint-disable-line global-require
const flags = (u) => require('../utils/clientRedact').privacyFlagsFor(u) || {}; // eslint-disable-line global-require
const isBde = (u) => !!flags(u).bde;
router.use((req, res, next) => (isClient(req.user) ? res.status(403).json(DENIED) : next()));

const mayFeedback = (u) => can(u, 'ats', 'interviews', 'Interview Feedback', 'create');
const maySchedule = async (u) => (await can(u, 'ats', 'interviews', 'Schedule Interview', 'edit')) || can(u, 'ats', 'interviews', 'Schedule Interview', 'create');
// the job's kits / tests / apply form: whoever edits the requirement or books its interviews, and the recruitment TL / STL (the TL posts);
// never a view-only Manager / Assistant Manager
const mayEditJob = async (u) => {
  if (['SUPER_ADMIN', 'ADMIN'].includes(u.role)) return true;
  if (['MANAGER', 'ASSISTANT_MANAGER'].includes(u.atsRole)) return false;
  if (['TL', 'STL'].includes(require('../utils/permissions').stageRoleOf(u))) return true; // eslint-disable-line global-require
  return (await can(u, 'ats', 'requirements', 'Requirement Detail', 'edit')) || (await can(u, 'ats', 'requirements', 'Job Posting', 'edit')) || can(u, 'ats', 'interviews', 'Schedule Interview', 'edit');
};
const maySendTest = (u) => can(u, 'ats', 'candidates', 'Applications', 'edit');

// the interview: in this person's ATS scope, or they sit on its panel
async function loadApp(req, res, { needInterview = true } = {}) {
  const include = { candidate: true, requirement: { include: { client: { select: { id: true, name: true } } } } };
  let app = await prisma.application.findFirst({ where: { AND: [{ id: req.params.id }, applicationWhere(req.user)] }, include });
  if (!app) {
    const onPanel = await prisma.interviewPanelist.findFirst({ where: { applicationId: req.params.id, userId: req.user.id } }).catch(() => null);
    if (onPanel) app = await prisma.application.findUnique({ where: { id: req.params.id }, include });
    if (app) app.viaPanel = true;
  }
  if (!app) { res.status(404).json({ error: 'Interview not found (or not in your scope).' }); return null; }
  if (needInterview && !app.interviewStatus && !app.interviewAt) { res.status(404).json({ error: 'This application has no interview yet.' }); return null; }
  return app;
}
async function loadJob(req, res) {
  const r = await prisma.requirement.findUnique({ where: { id: req.params.rid }, include: { client: { select: { id: true, name: true } } } });
  if (!r || !matches(r, requirementWhere(req.user))) { res.status(404).json({ error: 'Requirement not found (or not in your scope).' }); return null; }
  return r;
}
const roundOf = (v, app) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 20 ? n : (app ? app.interviewRound || 1 : 1); };

// ================================================================== kits (07.09)
router.get('/jobs/:rid/kits', wrap(async (req, res) => {
  const r = await loadJob(req, res); if (!r) return;
  res.json({ kits: await IV.listKits(r), scales: IV.SCALES, types: IV.QTYPES, canEdit: await mayEditJob(req.user) });
}));
router.put('/jobs/:rid/kits/:round', wrap(async (req, res) => {
  const r = await loadJob(req, res); if (!r) return;
  if (!(await mayEditJob(req.user))) return res.status(403).json(DENIED);
  const out = await IV.saveKit(r, roundOf(req.params.round), req.body || {}, req.user);
  if (out.error) return res.status(out.status).json({ error: out.error });
  await logAudit({ userId: req.user.id, action: `Interview kit saved - round ${out.kit.round}`, entity: 'Requirement', entityId: r.id, toValue: `${out.kit.questions.length} questions, scale ${out.kit.scale}` });
  return res.json(out);
}));
router.delete('/jobs/:rid/kits/:round', wrap(async (req, res) => {
  const r = await loadJob(req, res); if (!r) return;
  if (!(await mayEditJob(req.user))) return res.status(403).json(DENIED);
  await IV.removeKit(r, roundOf(req.params.round));
  return res.json({ ok: true, kits: await IV.listKits(r) });
}));
router.post('/jobs/:rid/kits/:round/suggest', wrap(async (req, res) => {
  const r = await loadJob(req, res); if (!r) return;
  if (!(await mayEditJob(req.user))) return res.status(403).json(DENIED);
  res.json(await IV.suggestKit(r, roundOf(req.params.round), (req.body || {}).roundType));
}));

// ================================================================== per-job settings (07.03 self-book tick, 10.03 apply form, 10.10 LinkedIn apply)
const FIELD_TYPES = ['text', 'number', 'yesno', 'choice', 'date', 'url'];
function cleanFields(list) {
  const out = [];
  for (const f of (Array.isArray(list) ? list : []).slice(0, 15)) {
    const label = C.txt(f && f.label, 120);
    if (!label) continue; // eslint-disable-line no-continue
    const type = FIELD_TYPES.includes(f.type) ? f.type : 'text';
    const options = type === 'choice' ? (Array.isArray(f.options) ? f.options : String(f.options || '').split(',')).map((o) => C.txt(o, 60)).filter(Boolean).slice(0, 12) : undefined;
    if (type === 'choice' && (!options || options.length < 2)) return { error: `"${label}": give at least two choices.` };
    const key = (C.txt(f.key, 40) || label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || `q${out.length + 1}`;
    if (out.some((o) => o.key === key)) return { error: `Two questions have the same name: "${label}".` };
    out.push({ key, label, type, required: !!f.required, options, knockout: type === 'yesno' && ['yes', 'no'].includes(f.knockout) ? f.knockout : undefined });
  }
  return { value: out };
}
router.get('/jobs/:rid/settings', wrap(async (req, res) => {
  const r = await loadJob(req, res); if (!r) return;
  const s = await C.settings();
  res.json({ ...(await IV.jobSettings(r.id)), selfSchedulingSwitch: s.switches.selfScheduling, assessmentsSwitch: s.switches.assessments, smsSwitch: s.switches.smsMarketing, fieldTypes: FIELD_TYPES, canEdit: await mayEditJob(req.user) });
}));
router.put('/jobs/:rid/settings', wrap(async (req, res) => {
  const r = await loadJob(req, res); if (!r) return;
  if (!(await mayEditJob(req.user))) return res.status(403).json(DENIED);
  const b = req.body || {};
  const patch = {};
  if (b.selfBook !== undefined) patch.selfBook = !!b.selfBook;
  if (b.linkedinApply !== undefined) patch.linkedinApply = !!b.linkedinApply;
  if (b.fields !== undefined) { const v = cleanFields(b.fields); if (v.error) return res.status(400).json({ error: v.error }); patch.fields = v.value; }
  const out = await IV.setJobSetting(r.id, patch, req.user);
  await logAudit({ userId: req.user.id, action: 'Job page / interview settings changed', entity: 'Requirement', entityId: r.id, toValue: JSON.stringify(patch).slice(0, 280) });
  return res.json(out);
}));

// ================================================================== assessments (07.15 / 07.16)
router.get('/jobs/:rid/assessments', wrap(async (req, res) => {
  const r = await loadJob(req, res); if (!r) return;
  res.json({ rows: await AS.list(r.id), switchOn: await C.switchOn('assessments'), canEdit: await mayEditJob(req.user), canSend: await maySendTest(req.user) });
}));
router.post('/jobs/:rid/assessments', wrap(async (req, res) => {
  const r = await loadJob(req, res); if (!r) return;
  if (!(await mayEditJob(req.user))) return res.status(403).json(DENIED);
  const out = await AS.save(r.id, req.body || {}, req.user);
  if (out.error) return res.status(out.status).json({ error: out.error });
  await logAudit({ userId: req.user.id, action: 'Assessment created', entity: 'Requirement', entityId: r.id, toValue: out.assessment.title });
  return res.status(201).json(out);
}));
router.post('/jobs/:rid/assessments/generate', wrap(async (req, res) => {
  const r = await loadJob(req, res); if (!r) return;
  if (!(await mayEditJob(req.user))) return res.status(403).json(DENIED);
  res.json(await AS.generate(r, req.body || {}));
}));
router.put('/assessments/:aid', wrap(async (req, res) => {
  const a = await AS.one(req.params.aid);
  if (!a) return res.status(404).json({ error: 'Test not found.' });
  req.params.rid = a.requirementId;
  const r = await loadJob(req, res); if (!r) return;
  if (!(await mayEditJob(req.user))) return res.status(403).json(DENIED);
  const out = await AS.save(r.id, req.body || {}, req.user, a.id);
  if (out.error) return res.status(out.status).json({ error: out.error });
  return res.json(out);
}));
router.post('/interviews/:id/assessments/:aid/send', wrap(async (req, res) => {
  const app = await loadApp(req, res, { needInterview: false }); if (!app) return;
  if (app.viaPanel || isBde(req.user) || !(await maySendTest(req.user))) return res.status(403).json(DENIED);
  const a = await AS.one(req.params.aid);
  if (!a || a.requirementId !== app.requirementId) return res.status(404).json({ error: 'That test is not on this job.' });
  const out = await AS.send(app, a, req.user, { req, email: !!(req.body || {}).email });
  if (out.error) return res.status(out.status).json({ error: out.error });
  await logAudit({ userId: req.user.id, action: 'Assessment sent', entity: 'Application', entityId: app.id, toValue: `${a.title} - ${out.outcome}` });
  return res.status(201).json(out);
}));
router.get('/applications/:id/assessments', wrap(async (req, res) => {
  const app = await loadApp(req, res, { needInterview: false }); if (!app) return;
  const tests = await AS.list(app.requirementId);
  res.json({ rows: await AS.resultsFor(app.id), tests: tests.filter((t) => t.active).map((t) => ({ id: t.id, title: t.title, minutes: t.minutes, count: t.questions.length })), switchOn: await C.switchOn('assessments'), canSend: !isBde(req.user) && await maySendTest(req.user) });
}));
router.post('/assessment-results/:token/regrade', wrap(async (req, res) => {
  const row = await AS.sendRow(req.params.token);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  req.params.id = row.applicationId;
  const app = await loadApp(req, res, { needInterview: false }); if (!app) return;
  if (isBde(req.user) || !(await maySendTest(req.user))) return res.status(403).json(DENIED);
  const out = await AS.regrade(row.token, (req.body || {}).i, (req.body || {}).got, req.user);
  if (out.error) return res.status(out.status).json({ error: out.error });
  return res.json(out);
}));

// ================================================================== scorecard + briefing (07.09 / 07.10)
router.get('/interviews/:id/scorecard', wrap(async (req, res) => {
  const app = await loadApp(req, res); if (!app) return;
  const round = roundOf(req.query.round, app);
  const kit = await IV.kitFor(app.requirement, round);
  const all = await IV.scoresOf(app.id, round);
  const bde = isBde(req.user);
  res.json({ round, kit, mine: all.find((s) => s.userId === req.user.id) || null, others: bde ? [] : all.filter((s) => s.userId !== req.user.id), recs: IV.RECS, canFill: !bde && (app.viaPanel || await mayFeedback(req.user)) });
}));
router.put('/interviews/:id/scorecard', wrap(async (req, res) => {
  const app = await loadApp(req, res); if (!app) return;
  if (isBde(req.user) || !(app.viaPanel || await mayFeedback(req.user))) return res.status(403).json(DENIED);
  const round = roundOf((req.body || {}).round, app);
  const out = await IV.saveScore(app, round, req.body || {}, req.user);
  if (out.error) return res.status(out.status).json({ error: out.error });
  await logAudit({ userId: req.user.id, action: `Interview scorecard - round ${round}`, entity: 'Application', entityId: app.id, toValue: `${out.score.overall == null ? '-' : out.score.overall}/5 ${out.score.recommendation || ''}` });
  return res.json(out);
}));
router.get('/interviews/:id/briefing', wrap(async (req, res) => {
  const app = await loadApp(req, res); if (!app) return;
  const f = flags(req.user);
  const c = app.candidate; const r = app.requirement;
  const round = app.interviewRound || 1;
  const IR = require('../utils/interviewRounds'); // eslint-disable-line global-require
  const rounds = f.bde ? [] : await IR.roundsOf(app).catch(() => []);
  const resume = await prisma.candidateResume.findFirst({ where: { candidateId: c.id }, orderBy: { createdAt: 'desc' }, select: { id: true, fileName: true } }).catch(() => null);
  res.json({
    candidate: {
      name: c.name, currentDesignation: c.currentDesignation, currentCompany: c.currentCompany, experienceYears: c.experienceYears, relevantExperienceYears: c.relevantExperienceYears,
      location: c.location, skills: c.skills, education: c.education, noticePeriod: c.noticePeriod,
      // pay and contact never for the BDE team or a login without "Candidate Contact & Salary"
      ...(f.bde || f.contact ? {} : { currentSalary: c.currentSalary, expectedSalary: c.expectedSalary, email: c.email, phone: c.phone }),
      resume: resume ? { fileName: resume.fileName } : null,
    },
    job: { title: r.title, department: r.department, experience: r.experience, skills: r.skills, location: r.location, client: f.bde || r.internal ? undefined : (r.client && r.client.name) },
    interview: { round, at: app.interviewAt, mode: app.interviewMode, link: app.interviewMeetingLink, location: app.interviewLocation, interviewer: app.interviewer, status: app.interviewStatus },
    kit: await IV.kitFor(r, round),
    pastRounds: rounds.filter((x) => x.round < round || x.feedback).map((x) => ({ round: x.round, roundType: x.roundType, interviewers: x.interviewers, recommendation: x.feedback && x.feedback.recommendation, average: x.feedback && x.feedback.average, comments: x.feedback && x.feedback.overall })),
    pastScores: f.bde ? [] : (await IV.scoresOf(app.id)).filter((s) => s.round < round).map((s) => ({ round: s.round, by: s.userName, overall: s.overall, recommendation: s.recommendation, summary: s.summary })),
    limited: !!(f.bde || f.contact),
    limitedNote: f.bde ? 'BDE view: contact details, pay and the panel\'s feedback are hidden.' : (f.contact ? 'Contact details and pay are hidden for your role.' : null),
  });
}));

// ================================================================== recordings, reviews, notes, voice (07.07 / 07.11 / 07.13)
const REC_MAX = 60 * 1024 * 1024;
const recOk = async (req, res, app) => {
  if (isBde(req.user)) { res.status(403).json({ error: 'The BDE team does not open interview recordings.' }); return false; }
  if (!(app.viaPanel || await mayFeedback(req.user))) { res.status(403).json(DENIED); return false; }
  return true;
};
async function readUpload(req, res, { audioOnly = false } = {}) {
  let parsed;
  try { parsed = await attachments.parseMultipart(req, { maxBytes: REC_MAX }); } catch (err) {
    res.status(err.code === 'TOO_LARGE' ? 413 : 400).json({ error: err.code === 'TOO_LARGE' ? 'That file is larger than 60 MB. Upload it to Drive / OneDrive and add the link instead.' : 'Choose a file to upload.' }); return null;
  }
  if (!parsed.file) return { fields: parsed.fields || {}, stored: null };
  if (!/^(audio|video)\//.test(String(parsed.file.contentType || '')) || (audioOnly && !/^audio\//.test(parsed.file.contentType) && parsed.file.contentType !== 'video/webm')) {
    res.status(400).json({ error: audioOnly ? 'Send an audio recording (webm, ogg, mp3, wav or m4a).' : 'Upload an audio or video recording (mp3, wav, m4a, ogg, webm or mp4).' }); return null;
  }
  let stored;
  try { stored = attachments.store(parsed.file, { maxBytes: REC_MAX, allowAudio: true, allowVideo: !audioOnly }); } catch (err) {
    const msg = { NO_FILE: 'Choose a file to upload.', TOO_LARGE: 'That file is larger than 60 MB.', BAD_TYPE: audioOnly ? 'Send an audio recording (webm, ogg, mp3, wav or m4a).' : 'Upload an audio or video recording (mp3, wav, m4a, ogg, webm or mp4).', CONTENT_MISMATCH: "That file's contents do not match its type." }[err.code] || 'The file could not be saved.';
    res.status(err.code === 'TOO_LARGE' ? 413 : 400).json({ error: msg }); return null;
  }
  return { fields: parsed.fields || {}, stored, buffer: parsed.file.data };
}
router.get('/interviews/:id/recordings', wrap(async (req, res) => {
  const app = await loadApp(req, res); if (!app) return;
  if (isBde(req.user)) return res.json({ rows: [], hidden: true });
  res.json({ rows: await IV.recordingsOf(app.id), canAdd: app.viaPanel || await mayFeedback(req.user), maxMb: REC_MAX / 1048576, speech: !!(process.env.AI_VOICE_WHISPER_URL || process.env.AI_VOICE_STT_URL) && !C.isSandbox() });
}));
router.post('/interviews/:id/recordings', wrap(async (req, res) => {
  const app = await loadApp(req, res); if (!app) return;
  if (!(await recOk(req, res, app))) return;
  let row;
  if (/multipart\/form-data/i.test(String(req.headers['content-type'] || ''))) {
    const up = await readUpload(req, res); if (!up) return;
    if (!up.stored) return res.status(400).json({ error: 'Choose the recording file.' });
    row = { kind: 'file', round: roundOf(up.fields.round, app), title: up.fields.title || up.stored.billName, fileStored: up.stored.billFile, fileName: up.stored.billName, fileMime: up.stored.billMime, fileSize: up.stored.billSize, transcript: up.fields.transcript };
  } else {
    const b = req.body || {};
    let u; try { u = new URL(String(b.url || '')); } catch { u = null; }
    if (!u || !/^https?:$/.test(u.protocol)) return res.status(400).json({ error: 'Paste the full link to the recording (https://...).' });
    row = { kind: 'link', round: roundOf(b.round, app), title: b.title || 'Recording link', url: u.toString().slice(0, 600), transcript: b.transcript };
  }
  const id = await IV.addRecording(app.id, row, req.user);
  await logAudit({ userId: req.user.id, action: `Interview recording added (${row.kind})`, entity: 'Application', entityId: app.id, toValue: String(row.title).slice(0, 120) });
  return res.status(201).json({ ok: true, id, rows: await IV.recordingsOf(app.id) });
}));
async function loadRec(req, res) {
  const rec = await IV.recordingRow(req.params.rid);
  if (!rec) { res.status(404).json({ error: 'Recording not found.' }); return null; }
  req.params.id = rec.applicationId;
  const app = await loadApp(req, res); if (!app) return null;
  if (!(await recOk(req, res, app))) return null;
  return { rec, app };
}
router.get('/recordings/:rid/file', wrap(async (req, res) => {
  const l = await loadRec(req, res); if (!l) return;
  const p = attachments.resolveStored(l.rec.fileStored);
  if (!p) return res.status(404).json({ error: 'The file is not on the server.' });
  res.set('Content-Type', l.rec.fileMime || 'application/octet-stream');
  res.set('Content-Disposition', `inline; filename="${String(l.rec.fileName || 'recording').replace(/[^\w.\- ]/g, '_')}"`);
  return fs.createReadStream(p).pipe(res);
}));
router.post('/recordings/:rid/reviews', wrap(async (req, res) => {
  const l = await loadRec(req, res); if (!l) return;
  const out = await IV.addReview(l.rec.id, req.body || {}, req.user);
  if (out.error) return res.status(out.status).json({ error: out.error });
  return res.status(201).json({ ok: true, rows: await IV.recordingsOf(l.app.id) });
}));
router.post('/recordings/:rid/transcript', wrap(async (req, res) => {
  const l = await loadRec(req, res); if (!l) return;
  const text = C.txt((req.body || {}).text, 200000);
  if (text) { await IV.setTranscript(l.rec.id, text, 'Typed / pasted'); return res.json({ ok: true, source: 'Typed / pasted', rows: await IV.recordingsOf(l.app.id) }); }
  const p = attachments.resolveStored(l.rec.fileStored);
  if (!p) return res.status(400).json({ error: 'This is a link, not a file on TeamLink: paste the transcript (most meeting tools give one).' });
  const t = await C.transcribe(fs.readFileSync(p), (req.body || {}).lang || 'en');
  if (t.error) return res.status(409).json({ error: t.error, needsTranscript: true });
  await IV.setTranscript(l.rec.id, t.text, t.source);
  return res.json({ ok: true, source: t.source, rows: await IV.recordingsOf(l.app.id) });
}));
router.post('/recordings/:rid/notes', wrap(async (req, res) => {
  const l = await loadRec(req, res); if (!l) return;
  const out = await IV.makeNotes(l.rec, [l.app.candidate && l.app.candidate.name]);
  if (out.error) return res.status(out.status).json({ error: out.error });
  return res.json({ ok: true, notes: out.notes, rows: await IV.recordingsOf(l.app.id) });
}));
// voice feedback: the browser records it (and writes the words when the phone can); the server keeps the sound, tries its own
// speech engine when no words came, and the words become this person's scorecard summary for the round.
router.post('/interviews/:id/voice-feedback', wrap(async (req, res) => {
  const app = await loadApp(req, res); if (!app) return;
  if (!(await recOk(req, res, app))) return;
  const up = await readUpload(req, res, { audioOnly: true }); if (!up) return;
  const round = roundOf(up.fields.round, app);
  let transcript = C.txt(up.fields.transcript, 20000); let source = transcript ? 'Browser speech recognition' : null;
  if (!transcript && up.buffer) { const t = await C.transcribe(up.buffer, up.fields.lang || 'en'); if (t.text) { transcript = t.text; source = t.source; } }
  if (!up.stored && !transcript) return res.status(400).json({ error: 'Record your feedback first.' });
  const id = await IV.addRecording(app.id, { kind: 'voice', round, title: `Voice feedback - ${C.who(req.user)}`, ...(up.stored ? { fileStored: up.stored.billFile, fileName: up.stored.billName, fileMime: up.stored.billMime, fileSize: up.stored.billSize } : {}), transcript, transcriptSource: source }, req.user);
  if (transcript) {
    const cur = (await IV.scoresOf(app.id, round)).find((s) => s.userId === req.user.id);
    await IV.saveScore(app, round, { answers: cur ? cur.answers : [], recommendation: cur ? cur.recommendation : (IV.RECS.includes(up.fields.recommendation) ? up.fields.recommendation : null), summary: transcript }, req.user, 'voice');
  }
  await logAudit({ userId: req.user.id, action: `Voice feedback - round ${round}`, entity: 'Application', entityId: app.id, toValue: (transcript || '(sound only)').slice(0, 120) });
  return res.status(201).json({ ok: true, id, transcript, source: source || (up.stored ? 'Sound saved; no words yet (no speech engine on this server). Type a line or paste the words.' : null) });
}));
router.get('/interviews/:id/feedback-summary', wrap(async (req, res) => {
  const app = await loadApp(req, res); if (!app) return;
  if (isBde(req.user)) return res.status(403).json({ error: "The BDE team does not read the panel's feedback." });
  res.json(await IV.feedbackSummary(app, { names: [app.candidate && app.candidate.name] }));
}));

// ================================================================== slots, replacement, self-booking (07.05 / 07.03)
router.post('/interviews/:id/suggest-slots', wrap(async (req, res) => {
  const app = await loadApp(req, res, { needInterview: false }); if (!app) return;
  if (!(await maySchedule(req.user))) return res.status(403).json(DENIED);
  const b = req.body || {};
  res.json(await IV.suggestSlots(app, { days: b.days, minutes: b.minutes, count: b.count }));
}));
router.post('/interviews/:id/replacements', wrap(async (req, res) => {
  const app = await loadApp(req, res); if (!app) return;
  if (!(await maySchedule(req.user))) return res.status(403).json(DENIED);
  res.json(await IV.replacements(app, req.body || {}));
}));
router.get('/interviews/:id/self-book', wrap(async (req, res) => {
  const app = await loadApp(req, res, { needInterview: false }); if (!app) return;
  const s = await C.settings();
  res.json({ rows: await IV.selfBooksOf(app.id), switchOn: s.switches.selfScheduling, jobOn: (await IV.jobSettings(app.requirementId)).selfBook, canCreate: !isBde(req.user) && await maySchedule(req.user), base: C.publicBase(req) });
}));
router.post('/interviews/:id/self-book', wrap(async (req, res) => {
  const app = await loadApp(req, res, { needInterview: false }); if (!app) return;
  if (isBde(req.user) || !(await maySchedule(req.user))) return res.status(403).json(DENIED);
  const out = await IV.createSelfBook(app, req.body || {}, req.user);
  if (out.error) return res.status(out.status).json({ error: out.error });
  const link = `${C.publicBase(req)}/book/${out.token}`;
  let sent = null;
  if ((req.body || {}).email && app.candidate.email) {
    const r = await require('../utils/messaging').send('Email', { // eslint-disable-line global-require
      to: app.candidate.email, subject: `Pick your interview time - ${app.requirement.title}`,
      text: `Hi ${String(app.candidate.name || '').split(/\s+/)[0]},\n\nPlease pick the interview time that suits you (the link works until ${new Date(out.expiresAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}):\n${link}\n\nIf none of the times work, press "None of these work" on the page and we will send new ones.\n\n- TeamLink`,
      actorUserId: req.user.id, meta: { audience: 'candidates', personId: app.candidateId, senderUserId: req.user.id, purpose: 'Self-scheduling link', module: 'ATS' },
    }).catch((e) => ({ outcome: 'Failed', error: e.message }));
    sent = r.outcome;
  }
  await logAudit({ userId: req.user.id, action: 'Self-scheduling link made', entity: 'Application', entityId: app.id, toValue: `${out.slots.length} times${sent ? `, email ${sent}` : ''}` });
  return res.status(201).json({ ...out, link, sent });
}));

// ================================================================== calendar (07.01)
router.get('/interviews/:id/ics', wrap(async (req, res) => {
  const app = await loadApp(req, res); if (!app) return;
  if (!app.interviewAt) return res.status(404).json({ error: 'No time booked yet.' });
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="interview-${app.id.slice(-6)}.ics"`);
  return res.send(IV.icsOf([{ ...app, interviewPanelists: [] }], 'TeamLink interview'));
}));
router.get('/calendar/feed', wrap(async (req, res) => {
  const t = await IV.feedToken(req.user.id);
  res.json({ url: `${C.publicBase(req)}/api/public/mkt/cal/${t}.ics`, note: 'Private to you: anyone with this address sees your interview times and candidate names. Reset it if it was shared by mistake.' });
}));
router.post('/calendar/feed/reset', wrap(async (req, res) => {
  const t = await IV.feedToken(req.user.id, true);
  await logAudit({ userId: req.user.id, action: 'Calendar feed address reset', entity: 'User', entityId: req.user.id });
  res.json({ url: `${C.publicBase(req)}/api/public/mkt/cal/${t}.ics` });
}));
router.get('/calendar/connections', wrap(async (req, res) => {
  res.json({ rows: await IV.connections(req.user.id), pushSwitch: await C.switchOn('calendarPush') });
}));
router.post('/calendar/:provider/connect', wrap(async (req, res) => {
  const out = await IV.connectStart(req, req.params.provider);
  if (out.error) return res.status(out.status).json(out);
  return res.json(out);
}));
router.delete('/calendar/:provider', wrap(async (req, res) => {
  await IV.disconnect(req.user.id, req.params.provider);
  res.json({ ok: true, rows: await IV.connections(req.user.id) });
}));
router.post('/interviews/:id/calendar-push', wrap(async (req, res) => {
  const app = await loadApp(req, res); if (!app) return;
  const out = await IV.pushToCalendars(app.id, { force: true, onlyUserId: req.user.id });
  res.json({ ...out, message: out.pushed ? `Put in your calendar (${out.pushed}).` : `Nothing was put in a calendar${out.errors && out.errors.length ? `: ${out.errors.join('; ')}` : ': connect Google or Microsoft first.'}` });
}));

module.exports = router;
