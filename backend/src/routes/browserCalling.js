// ---------------------------------------------------------------------------
// /api/browser-calling/*  - MANUAL calling from the browser (SIP.js over WSS -> Asterisk -> Synway SIM). NOT the AI calling: it shares nothing
// with calling/* except the AMI client class and the contact-access rule. Every state of a call comes from a real Asterisk event (browsercall/events.js).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const access = require('../outreach/access');
const scope = require('../utils/scope');
const core = require('../utils/messagingCore');
const S = require('../browsercall/schema');
const CFG = require('../browsercall/config');
const prov = require('../browsercall/provision');
const events = require('../browsercall/events');

const router = express.Router();
router.use(requireAuth);

const kindOf = (u) => access.kind(u);
const isAdmin = (u) => kindOf(u) === 'admin';
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const fail = (res, code, error, extra = {}) => res.status(code).json({ error, ...extra });
const LIVE = "('initiated','calling','ringing','connected')";

async function who(user) {
  const s = await CFG.load();
  if (s.mode === 'Off') return { ok: false, code: 403, reason: 'Browser calling is switched Off. An Admin can switch it to Test or Live in Omni-Channel > AI Voice > Browser calling.', s };
  if (!(user.products || {}).ats) return { ok: false, code: 403, reason: 'Your login does not include the recruitment (ATS) area.', s };
  if (!isAdmin(user) && !s.kinds.includes(kindOf(user))) return { ok: false, code: 403, reason: 'Your role is not allowed to call from the browser.', s };
  const CA = require('../utils/contactAccess'); // eslint-disable-line global-require
  const rule = await CA.ruleFor(user, 'candidates');
  if (!rule.allowed) return { ok: false, code: 403, reason: rule.reason || 'Your role does not contact candidates.', s };
  if (rule.mode !== 'direct') return { ok: false, code: 403, reason: 'Your role does not see candidate phone numbers, so it cannot call them.', s };
  return { ok: true, s };
}

router.get('/status', async (req, res) => {
  try {
    const w = await who(req.user);
    const st = events.getStatus();
    res.json({ canCall: w.ok, reason: w.ok ? null : w.reason, mode: w.s.mode, testMode: w.s.mode === 'Test', pbx: { eventsConnected: st.connected, error: isAdmin(req.user) ? st.error : undefined }, wssConfigured: !!CFG.ENV.wssUrl, isAdmin: isAdmin(req.user) });
  } catch (e) { fail(res, 500, 'Could not read the browser calling status.'); }
});

// start a softphone session: the caller's own extension + a fresh one-session password. Never cached, never logged.
router.post('/session', async (req, res) => {
  try {
    const w = await who(req.user);
    if (!w.ok) return fail(res, w.code, w.reason);
    if (!CFG.ENV.wssUrl) return fail(res, 503, 'The phone system address (BROWSER_CALL_WSS_URL) is not set up yet.');
    const s = await prov.startSession(req.user.id);
    res.set('Cache-Control', 'no-store');
    res.json({ wssUrl: CFG.ENV.wssUrl, domain: CFG.ENV.sipDomain, extension: s.extension, authUser: s.extension, password: s.password, expiresAt: s.expiresAt, iceServers: [{ urls: CFG.ENV.stun }], displayName: clip(req.user.name, 40) });
  } catch (e) { console.error('[browser-call] session:', e.message); fail(res, 500, 'Could not start the phone session. Ask an Admin to check the phone system.'); }
});

// place a call: the server picks the number from the candidate record (the browser never chooses it), checks scope / mode / test list,
// and writes the row; the real status then comes from Asterisk.
router.post('/calls', async (req, res) => {
  try {
    const w = await who(req.user);
    if (!w.ok) return fail(res, w.code, w.reason);
    const candidateId = clip(req.body && req.body.candidateId, 60);
    const cand = candidateId ? await prisma.candidate.findFirst({ where: { id: candidateId, ...scope.candidateWhere(req.user) }, select: { id: true, name: true, phone: true } }) : null;
    if (!cand) return fail(res, 404, 'Candidate not found.');
    const n = core.normalizeMobile(cand.phone);
    if (!n.ok) return fail(res, 400, n.reason);
    if (n.cc !== '91') return fail(res, 400, 'Only Indian mobile numbers can be called from here.');
    if (w.s.mode === 'Test' && !w.s.testNumbers.includes(n.national)) return fail(res, 403, "Test mode: only the Admin's test phone numbers can be called.", { code: 'TEST_MODE' });
    const ext = await S.one('SELECT "extension" FROM "BrowserCallExtension" WHERE "userId"=? AND "active"=1', req.user.id);
    if (!ext) return fail(res, 409, 'Start the phone first (no extension for your login yet).');
    const busy = await S.one(`SELECT "id" FROM "BrowserCall" WHERE "userId"=? AND "status" IN ${LIVE} AND "startAt">?`, req.user.id, new Date(Date.now() - 3600000).toISOString());
    if (busy) return fail(res, 409, 'You already have a call in progress.');
    const id = crypto.randomUUID(); const token = crypto.randomBytes(12).toString('hex'); const now = S.nowIso();
    const appId = clip(req.body && req.body.applicationId, 60) || null;
    await S.run('INSERT INTO "BrowserCall" ("id","token","candidateId","applicationId","userId","userName","toNumber","extension","direction","mode","status","startAt","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,\'outbound\',?,\'initiated\',?,?,?)',
      id, token, cand.id, appId, req.user.id, clip(req.user.name, 80), n.national, ext.extension, w.s.mode, now, now, now);
    await logAudit({ userId: req.user.id, action: 'Browser call started', entity: 'Candidate', entityId: cand.id, toValue: `ext ${ext.extension} -> ${core.maskMobile(n.national)}` });
    res.json({ callId: id, token, number: n.national, candidate: { id: cand.id, name: cand.name } });
  } catch (e) { console.error('[browser-call] place:', e.message); fail(res, 500, 'Could not start the call.'); }
});

const shape = (r) => ({ id: r.id, candidateId: r.candidateId, userId: r.userId, userName: r.userName, number: r.toNumber, extension: r.extension, direction: r.direction, status: r.status, startAt: r.startAt, answerAt: r.answerAt, endAt: r.endAt, durationSec: r.durationSec, talkSec: r.talkSec, hangupCause: r.hangupCause, hangupReason: r.hangupReason, asteriskUniqueId: r.asteriskUniqueId });

router.get('/calls/:id', async (req, res) => {
  const r = await S.one('SELECT * FROM "BrowserCall" WHERE "id"=?', clip(req.params.id, 60));
  if (!r || (r.userId !== req.user.id && !isAdmin(req.user))) return fail(res, 404, 'Call not found.');
  res.json({ call: shape(r) });
});

// history on the candidate profile (only candidates this login may see)
router.get('/candidates/:id/calls', async (req, res) => {
  try {
    const w = await who(req.user);
    if (!w.ok) return fail(res, w.code, w.reason);
    const cand = await prisma.candidate.findFirst({ where: { id: clip(req.params.id, 60), ...scope.candidateWhere(req.user) }, select: { id: true } });
    if (!cand) return fail(res, 404, 'Candidate not found.');
    const rows = await S.all('SELECT * FROM "BrowserCall" WHERE "candidateId"=? ORDER BY "startAt" DESC LIMIT 100', cand.id);
    res.json({ rows: rows.map(shape) });
  } catch (e) { fail(res, 500, 'Could not load the call history.'); }
});

// recruiter-wise report. Admin: everyone (optional ?userId). Others: only their own calls.
router.get('/report', async (req, res) => {
  try {
    const w = await who(req.user);
    if (!w.ok) return fail(res, w.code, w.reason);
    const ymd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
    const f = ymd(req.query.from) ? new Date(`${req.query.from}T00:00:00+05:30`).toISOString() : new Date(Date.now() - 30 * 86400000).toISOString();
    const t = ymd(req.query.to) ? new Date(`${req.query.to}T23:59:59+05:30`).toISOString() : new Date(Date.now() + 86400000).toISOString();
    const uid = isAdmin(req.user) ? clip(req.query.userId, 60) : req.user.id;
    const where = `"startAt">=? AND "startAt"<=? AND "status"<>'initiated'${uid ? ' AND "userId"=?' : ''}`;
    const p = uid ? [f, t, uid] : [f, t];
    const byUser = await S.all(`SELECT "userId", MAX("userName") AS "userName", COUNT(*) AS total, SUM("answerAt" IS NOT NULL) AS connected, SUM("status" IN ('failed','busy')) AS failed, SUM("status" IN ('missed','cancelled')) AS missed, COALESCE(SUM("talkSec"),0) AS "talkSec" FROM "BrowserCall" WHERE ${where} GROUP BY "userId" ORDER BY total DESC`, ...p);
    const byCand = await S.all(`SELECT "candidateId", COUNT(*) AS total, SUM("answerAt" IS NOT NULL) AS connected, COALESCE(SUM("talkSec"),0) AS "talkSec", MAX("startAt") AS "lastAt" FROM "BrowserCall" WHERE ${where} GROUP BY "candidateId" ORDER BY total DESC LIMIT 200`, ...p);
    const rows = await S.all(`SELECT * FROM "BrowserCall" WHERE ${where} ORDER BY "startAt" DESC LIMIT 500`, ...p);
    const ids = [...new Set([...byCand.map((r) => r.candidateId), ...rows.map((r) => r.candidateId)])];
    const names = await prisma.candidate.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    const nm = new Map(names.map((c) => [c.id, c.name]));
    res.json({ from: f, to: t, recruiters: byUser, candidates: byCand.map((r) => ({ ...r, name: nm.get(r.candidateId) || null })), calls: rows.map((r) => ({ ...shape(r), candidateName: nm.get(r.candidateId) || null })) });
  } catch (e) { console.error('[browser-call] report:', e.message); fail(res, 500, 'Could not build the report.'); }
});

// Admin: settings
router.get('/admin/config', async (req, res) => {
  if (!isAdmin(req.user)) return fail(res, 403, 'Admin only.');
  const s = await CFG.load();
  res.json({ ...s, testNumbers: s.testNumbers.join(', '), allKinds: ['admin', 'tl', 'recruiter', 'hr', 'bdetl', 'bde'], pbx: events.getStatus(), wssUrl: CFG.ENV.wssUrl || null });
});
router.put('/admin/config', async (req, res) => {
  if (!isAdmin(req.user)) return fail(res, 403, 'Admin only.');
  try {
    const b = req.body || {};
    const s = await CFG.save({ mode: b.mode, testNumbers: b.testNumbers, kinds: b.kinds });
    await logAudit({ userId: req.user.id, action: 'Browser calling settings saved', entity: 'Integration', entityId: 'browser-calling', toValue: `Switch: ${s.mode}` });
    res.json({ ...s, testNumbers: s.testNumbers.join(', ') });
  } catch (e) { fail(res, 400, e.message); }
});

module.exports = router;
