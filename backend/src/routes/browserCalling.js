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
const L = require('../browsercall/lines');
const VD = require('../browsercall/vicidial');
const SIMS = require('../browsercall/sims');
const secrets = require('../utils/secrets');

const router = express.Router();
router.use(requireAuth);

const kindOf = (u) => access.kind(u);
const isAdmin = (u) => kindOf(u) === 'admin';
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const fail = (res, code, error, extra = {}) => res.status(code).json({ error, ...extra });
const LIVE = "('initiated','calling','ringing','connected')";
const TEST_CALL = 'test-call'; // candidateId of an Admin's "Test call" on a line (no candidate)

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
    // the lines this login may call on ("Call using" in the call bar); the built-in office Synway first
    const lines = w.ok ? (await L.usableBy(req.user)).map((l) => ({ id: l.id, name: l.name, type: l.type, typeLabel: l.typeLabel, builtIn: !!l.builtIn, ready: true })) : [];
    // VICIDIAL click to dial (browsercall/vicidial.js): always listed; pickable only when the Admin switched it on and this person has an agent ID
    if (w.ok) { const vr = await VD.readyFor(req.user, kindOf(req.user)).catch(() => ({ ok: false, reason: 'ViciDial is not connected yet.' })); lines.push({ id: VD.LINE_ID, name: VD.LINE_NAME, type: 'vicidial-click', typeLabel: 'ViciDial agent screen', builtIn: false, vicidial: true, ready: !!vr.ok, reason: vr.ok ? null : vr.reason }); }
    const sim = w.ok && SIMS.SIM_KINDS.includes(kindOf(req.user)) ? await SIMS.mineFor(req.user).catch(() => null) : null;
    res.json({ canCall: w.ok, reason: w.ok ? null : w.reason, mode: w.s.mode, testMode: w.s.mode === 'Test', pbx: { eventsConnected: st.connected, error: isAdmin(req.user) ? st.error : undefined }, wssConfigured: !!CFG.ENV.wssUrl, isAdmin: isAdmin(req.user), lines, defaultLine: lines.length ? lines[0].id : null, sim });
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
// find the TeamLink candidate behind a phone number (the Job Portal app knows people by its own ids): only people this login may see, the newest record first
router.get('/lookup', async (req, res) => {
  try {
    const w = await who(req.user);
    if (!w.ok) return fail(res, w.code, w.reason);
    const D = require('../utils/candidateDedupe'); // eslint-disable-line global-require
    const keys = D.phoneKeys(clip(req.query && req.query.phone, 40));
    if (!keys.length) return fail(res, 400, 'That is not a phone number.');
    const rows = await prisma.candidate.findMany({ where: { ...scope.candidateWhere(req.user), OR: keys.map((k) => ({ phone: { contains: k } })) }, select: { id: true, name: true, phone: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 20 });
    const hit = rows.find((c) => D.phoneKeys(c.phone).some((k) => keys.includes(k)));
    if (!hit) return fail(res, 404, 'This person is not in TeamLink yet (or your login may not see them). Add them to the ATS first.');
    res.json({ candidate: { id: hit.id, name: hit.name } });
  } catch (e) { console.error('[browser-call] lookup:', e.message); fail(res, 500, 'Could not look the person up.'); }
});

router.post('/calls', async (req, res) => {
  try {
    const w = await who(req.user);
    if (!w.ok) return fail(res, w.code, w.reason);
    const candidateId = clip(req.body && req.body.candidateId, 60);
    const taskId = clip(req.body && req.body.outreachTaskId, 60);
    let cand = null;
    if (taskId) { // a person of an Omni-Channel call campaign (no ATS candidate): the row is kept as omni:<contact id>
      const t = await require('../outreach/campaigns').callTarget(req.user, taskId); // eslint-disable-line global-require
      if (t.error) return fail(res, t.status || 400, t.error);
      cand = { id: `omni:${t.contactId}`, name: t.name, phone: t.phone };
    } else cand = candidateId ? await prisma.candidate.findFirst({ where: { id: candidateId, ...scope.candidateWhere(req.user) }, select: { id: true, name: true, phone: true } }) : null;
    if (!cand) return fail(res, 404, 'Candidate not found.');
    const n = core.normalizeMobile(cand.phone);
    if (!n.ok) return fail(res, 400, n.reason);
    if (n.cc !== '91') return fail(res, 400, 'Only Indian mobile numbers can be called from here.');
    if (w.s.mode === 'Test' && !w.s.testNumbers.includes(n.national)) return fail(res, 403, "Test mode: only the Admin's test phone numbers can be called.", { code: 'TEST_MODE' });
    const placed = await place(req.user, w, { candidateId: cand.id, applicationId: clip(req.body && req.body.applicationId, 60) || null, number: n.national, lineId: req.body && req.body.lineId });
    if (placed.error) return fail(res, placed.code, placed.error, placed.extra || {});
    await logAudit({ userId: req.user.id, action: 'Browser call started', entity: 'Candidate', entityId: cand.id, toValue: `ext ${placed.extension} -> ${core.maskMobile(n.national)} on ${placed.line.name}` });
    res.json({ callId: placed.id, token: placed.token, number: n.national, candidate: { id: cand.id, name: cand.name }, line: { id: placed.line.id, name: placed.line.name, header: placed.line.header } });
  } catch (e) { console.error('[browser-call] place:', e.message); fail(res, 500, 'Could not start the call.'); }
});

// the row of a call that is about to leave the browser. The SERVER decides the line (exists, switched on, this role may use it, not full)
// and hands back the X-TL-Line header value; the dialplan only trusts a value that exists in [tl-line-route].
async function place(user, w, { candidateId, applicationId, number, lineId }) {
  const ln = await L.resolveForCall(user, lineId);
  if (!ln.ok) return { code: ln.code, error: ln.reason, extra: { code: 'LINE' } };
  // ONE SIM PER RECRUITER (browsercall/sims.js): on the office Synway a person with a port goes out on it while "Port prefix routing" is ON
  // (header p<NN>; the dialplan only lets that person's own extension use it). Without a port, or with the switch OFF: exactly as before.
  if (SIMS.SIM_KINDS.includes(kindOf(user))) { const rt = await SIMS.routeFor(user, ln.line); ln.line = rt.line; }
  const ext = await S.one('SELECT "extension" FROM "BrowserCallExtension" WHERE "userId"=? AND "active"=1', user.id);
  if (!ext) return { code: 409, error: 'Start the phone first (no extension for your login yet).' };
  const hourAgo = new Date(Date.now() - 3600000).toISOString();
  const busy = await S.one(`SELECT "id" FROM "BrowserCall" WHERE "userId"=? AND "direction"='outbound' AND "status" IN ${LIVE} AND "startAt">?`, user.id, hourAgo);
  if (busy) return { code: 409, error: 'You already have a call in progress.' };
  if (ln.line.maxCalls) {
    const used = await S.one(`SELECT COUNT(*) AS n FROM "BrowserCall" WHERE "lineId"=? AND "status" IN ${LIVE} AND "startAt">?`, ln.line.id, hourAgo);
    if (used && Number(used.n) >= ln.line.maxCalls) return { code: 409, error: `All ${ln.line.maxCalls} calls of the line "${ln.line.name}" are in use. Try again in a moment or pick another line.`, extra: { code: 'LINE_FULL' } };
  }
  const id = crypto.randomUUID(); const token = crypto.randomBytes(12).toString('hex'); const now = S.nowIso();
  await S.run('INSERT INTO "BrowserCall" ("id","token","candidateId","applicationId","userId","userName","toNumber","extension","direction","mode","status","startAt","createdAt","updatedAt","lineId","lineName","recordingStatus") VALUES (?,?,?,?,?,?,?,?,\'outbound\',?,\'initiated\',?,?,?,?,?,?)',
    id, token, candidateId, applicationId, user.id, clip(user.name, 80), number, ext.extension, w.s.mode, now, now, now, ln.line.id, ln.line.name, w.s.record ? 'pending' : 'off');
  return { id, token, extension: ext.extension, line: ln.line };
}

// who may PLAY a recording or READ what was said (founder 2026-11-23): only people who may see that candidate - never a BDE (limited view)
// or a Manager / Assistant Manager (view only), even if an Admin lets their role call.
const mayListen = (u) => !!u && !['bde', 'view', 'none'].includes(kindOf(u));
const secsBetween = (a, b) => (a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000)) : null);
const shape = (r, viewer) => {
  const listen = viewer ? mayListen(viewer) : false;
  let summary = null; try { summary = r.summary ? JSON.parse(r.summary) : null; } catch { summary = null; }
  return {
    id: r.id, candidateId: r.candidateId, userId: r.userId, userName: r.userName, number: r.direction === 'inbound' ? SIMS.mask(r.toNumber !== 'unknown' ? r.toNumber : '') : r.toNumber, extension: r.extension, direction: r.direction, status: r.status, startAt: r.startAt, answerAt: r.answerAt, endAt: r.endAt, durationSec: r.durationSec, talkSec: r.talkSec, hangupCause: r.hangupCause, hangupReason: r.hangupReason, asteriskUniqueId: r.asteriskUniqueId, lineId: r.lineId || null, lineName: r.lineName || null, testCall: r.candidateId === TEST_CALL,
    ringSec: r.answerAt ? secsBetween(r.startAt, r.answerAt) : secsBetween(r.startAt, r.endAt),
    recordingStatus: r.recordingStatus || null, recordingSec: r.recordingSec || null, recordingNote: r.recordingNote || null, hasRecording: !!r.recordingPath,
    hasTranscript: !!r.transcript, transcriptNote: r.transcript ? null : (r.transcriptSource || null),
    vicidial: r.lineId === VD.LINE_ID, outcomeNote: r.lineId === VD.LINE_ID ? (r.hangupReason || null) : undefined,
    mayListen: listen, summary: listen ? summary : null, summaryText: listen ? (r.summaryText || null) : null, summarySource: listen ? (r.summarySource || null) : null,
  };
};
// a call whose recording / transcript this login asks for: the call exists, the login may listen, and may see that candidate
async function listenable(req) {
  const w = await who(req.user);
  if (!w.ok) return { code: w.code, error: w.reason };
  if (!mayListen(req.user)) return { code: 403, error: 'Your role may not play call recordings or read what was said.' };
  const r = await S.one('SELECT * FROM "BrowserCall" WHERE "id"=?', clip(req.params.id, 60));
  if (!r) return { code: 404, error: 'Call not found.' };
  if (r.candidateId === TEST_CALL) { if (!isAdmin(req.user)) return { code: 404, error: 'Call not found.' }; return { r }; }
  if (String(r.candidateId).startsWith('omni:')) { if (!isAdmin(req.user) && r.userId !== req.user.id) return { code: 404, error: 'Call not found.' }; return { r }; } // an Omni call-campaign person: the caller or an Admin
  const cand = await prisma.candidate.findFirst({ where: { id: r.candidateId, ...scope.candidateWhere(req.user) }, select: { id: true } });
  if (!cand) return { code: 404, error: 'Call not found.' };
  return { r };
}

router.get('/calls/:id', async (req, res) => {
  const r = await S.one('SELECT * FROM "BrowserCall" WHERE "id"=?', clip(req.params.id, 60));
  if (!r || (r.userId !== req.user.id && !isAdmin(req.user))) return fail(res, 404, 'Call not found.');
  res.json({ call: shape(r, req.user) });
});

// the recording, streamed through this authenticated route (the browser fetches it with its login and plays it)
router.get('/calls/:id/recording', async (req, res) => {
  try {
    const g = await listenable(req);
    if (g.error) return fail(res, g.code, g.error);
    const REC = require('../browsercall/recording'); // eslint-disable-line global-require
    const file = g.r.recordingPath ? REC.resolveStored(g.r.recordingPath) : null;
    if (!file || !require('fs').existsSync(file)) return fail(res, 404, g.r.recordingNote || 'There is no recording of this call.'); // eslint-disable-line global-require
    await logAudit({ userId: req.user.id, action: 'Browser call recording played', entity: 'Candidate', entityId: g.r.candidateId, toValue: g.r.id });
    res.set('Cache-Control', 'private, no-store');
    res.type(file.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav');
    return res.sendFile(file);
  } catch (e) { return fail(res, 500, 'Could not play the recording.'); }
});
// "Show full conversation": the transcript + the summary
router.get('/calls/:id/transcript', async (req, res) => {
  try {
    const g = await listenable(req);
    if (g.error) return fail(res, g.code, g.error);
    const c = shape(g.r, req.user);
    res.set('Cache-Control', 'private, no-store');
    return res.json({ id: c.id, transcript: g.r.transcript || null, transcriptSource: g.r.transcriptSource || null, summary: c.summary, summaryText: c.summaryText, summarySource: c.summarySource });
  } catch (e) { return fail(res, 500, 'Could not load the conversation.'); }
});

// history on the candidate profile (only candidates this login may see)
router.get('/candidates/:id/calls', async (req, res) => {
  try {
    const w = await who(req.user);
    if (!w.ok) return fail(res, w.code, w.reason);
    const cand = await prisma.candidate.findFirst({ where: { id: clip(req.params.id, 60), ...scope.candidateWhere(req.user) }, select: { id: true } });
    if (!cand) return fail(res, 404, 'Candidate not found.');
    const rows = await S.all('SELECT * FROM "BrowserCall" WHERE "candidateId"=? ORDER BY "startAt" DESC LIMIT 100', cand.id);
    res.json({ rows: rows.map((r) => shape(r, req.user)), mayListen: mayListen(req.user) });
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
    const byUser = await S.all(`SELECT "userId", MAX("userName") AS "userName", COUNT(*) AS total, SUM("answerAt" IS NOT NULL) AS connected, SUM("status" IN ('failed','busy')) AS failed, SUM("status" IN ('missed','cancelled')) AS missed, COALESCE(SUM("talkSec"),0) AS "talkSec", SUM("recordingPath" IS NOT NULL) AS recorded FROM "BrowserCall" WHERE ${where} GROUP BY "userId" ORDER BY total DESC`, ...p);
    const byCand = await S.all(`SELECT "candidateId", COUNT(*) AS total, SUM("answerAt" IS NOT NULL) AS connected, COALESCE(SUM("talkSec"),0) AS "talkSec", MAX("startAt") AS "lastAt" FROM "BrowserCall" WHERE ${where} GROUP BY "candidateId" ORDER BY total DESC LIMIT 200`, ...p);
    const rows = await S.all(`SELECT * FROM "BrowserCall" WHERE ${where} ORDER BY "startAt" DESC LIMIT 500`, ...p);
    const ids = [...new Set([...byCand.map((r) => r.candidateId), ...rows.map((r) => r.candidateId)])];
    const names = await prisma.candidate.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    const nm = new Map(names.map((c) => [c.id, c.name]));
    const omniIds = ids.filter((x) => String(x).startsWith('omni:')).map((x) => x.slice(5));
    if (omniIds.length) { const ph = omniIds.map(() => '?').join(','); (await S.all(`SELECT "id","name" FROM "OutreachContact" WHERE "id" IN (${ph})`, ...omniIds)).forEach((c) => nm.set(`omni:${c.id}`, c.name)); }
    const byLine = await S.all(`SELECT COALESCE("lineName", 'Office Synway (SIM)') AS "lineName", COUNT(*) AS total, SUM("answerAt" IS NOT NULL) AS connected, COALESCE(SUM("talkSec"),0) AS "talkSec" FROM "BrowserCall" WHERE ${where} GROUP BY 1 ORDER BY total DESC`, ...p);
    let teamIds = null;
    if (isAdmin(req.user)) teamIds = uid ? [uid] : null;
    else if (kindOf(req.user) === 'tl') { const tm = await require('../utils/atsHistoryPeople').teamOf(req.user.id).catch(() => null); teamIds = [req.user.id, ...((tm && tm.ids) || [])]; } // eslint-disable-line global-require
    else teamIds = [req.user.id];
    const missedRows = await S.all(`SELECT * FROM "BrowserCall" WHERE "direction"='inbound' AND "status"='missed' AND "startAt">=? AND "startAt"<=?${teamIds ? ` AND "userId" IN (${teamIds.map(() => '?').join(',')})` : ''} ORDER BY "startAt" DESC LIMIT 300`, f, t, ...(teamIds || []));
    const seeIds = missedRows.map((r) => r.candidateId).filter((x) => x && x !== 'unknown');
    const seen = seeIds.length ? await prisma.candidate.findMany({ where: { id: { in: [...new Set(seeIds)] }, ...scope.candidateWhere(req.user) }, select: { id: true, name: true } }) : [];
    const seenName = new Map(seen.map((c) => [c.id, c.name]));
    const missed = missedRows.map((r) => ({ id: r.id, startAt: r.startAt, userId: r.userId, userName: r.userName, lineName: r.lineName, reason: r.hangupReason, candidateId: seenName.has(r.candidateId) ? r.candidateId : null, candidateName: seenName.get(r.candidateId) || null, number: SIMS.mask(r.toNumber !== 'unknown' ? r.toNumber : '') }));
    res.json({ from: f, to: t, missed, missedScope: isAdmin(req.user) ? 'all' : (kindOf(req.user) === 'tl' ? 'team' : 'own'), recruiters: byUser, lines: byLine, candidates: byCand.filter((r) => r.candidateId !== TEST_CALL).map((r) => ({ ...r, name: nm.get(r.candidateId) || null })), calls: rows.map((r) => ({ ...shape(r, req.user), candidateName: r.candidateId === TEST_CALL ? 'Test call' : (nm.get(r.candidateId) || null) })) });
  } catch (e) { console.error('[browser-call] report:', e.message); fail(res, 500, 'Could not build the report.'); }
});

// ---------------------------------------------------------------------------- VICIDIAL click to dial (browsercall/vicidial.js)
// The server checks the person may call this candidate (the same rules as a browser call: role, scope, contact rule, Test mode test numbers),
// writes the call row ("ViciDial", recorded in ViciDial, nothing recorded here) and hands back the ONE dial link; the BROWSER opens it in a small
// popup (the office ViciDial is on the office LAN, which this server cannot reach - this server never contacts it). The link carries the API
// password, so it is only in this one answer (no-store) and never in a log line or an audit row.
const KIND_WORD = { admin: 'Admin', tl: 'Team Leader', recruiter: 'Recruiter', hr: 'HR', bdetl: 'BDE TL', bde: 'BDE', view: 'Manager (view only)', marketing: 'Marketing', none: '—' };
async function viciAdminView() {
  const settings = await VD.load();
  const s = await CFG.load();
  const map = await VD.agentsMap();
  const users = await prisma.user.findMany({ where: { status: 'Active', atsAccess: true }, orderBy: { name: 'asc' }, take: 2000 });
  const people = users.map((u) => {
    let k = 'none'; try { k = kindOf(u); } catch { k = 'none'; }
    const may = !VD.REFUSED_KINDS.includes(k) && (k === 'admin' || s.kinds.includes(k));
    const a = map.get(u.id);
    return { userId: u.id, name: u.name, email: u.email, role: KIND_WORD[k] || k, mayCall: may, agentUser: a ? a.agentUser : null };
  }).filter((p) => p.mayCall || p.agentUser);
  return { settings, people, missing: VD.missingFor(settings), browserCallingMode: s.mode, secretsReady: secrets.secretsConfigured() };
}
router.get('/vicidial/admin', async (req, res) => {
  if (!isAdmin(req.user)) return fail(res, 403, 'Admin only.');
  try { res.set('Cache-Control', 'no-store'); return res.json(await viciAdminView()); } catch (e) { console.error('[vicidial] admin:', e.message); return fail(res, 500, 'Could not load the ViciDial settings.'); }
});
router.put('/vicidial/admin', async (req, res) => {
  if (!isAdmin(req.user)) return fail(res, 403, 'Admin only.');
  try {
    const before = await VD.load();
    const b = req.body || {};
    const out = await VD.save({ server: b.server, apiUser: b.apiUser, apiPass: b.apiPass, clearPassword: !!b.clearPassword, phoneCode: b.phoneCode, enabled: b.enabled }, req.user);
    if (out.error) return fail(res, out.status || 400, out.error);
    const st = out.settings;
    const changed = [
      before.enabled !== st.enabled && `switched ${st.enabled ? 'On' : 'Off'}`, before.server !== st.server && `server ${st.server || '(empty)'}`,
      before.apiUser !== st.apiUser && `API user ${st.apiUser || '(empty)'}`, (b.apiPass || b.clearPassword) && (b.clearPassword ? 'API password removed' : 'API password changed'),
      before.phoneCode !== st.phoneCode && `phone code ${st.phoneCode}`,
    ].filter(Boolean);
    await logAudit({ userId: req.user.id, action: 'ViciDial settings saved', entity: 'Integration', entityId: 'vicidial', toValue: changed.join(' · ') || 'no change' });
    res.set('Cache-Control', 'no-store');
    return res.json(await viciAdminView());
  } catch (e) { console.error('[vicidial] save:', e.message); return fail(res, 500, 'Could not save the ViciDial settings.'); }
});
router.put('/vicidial/admin/agents/:userId', async (req, res) => {
  if (!isAdmin(req.user)) return fail(res, 403, 'Admin only.');
  try {
    const before = await VD.agentFor(req.params.userId);
    const out = await VD.setAgent(req.params.userId, req.body && req.body.agentUser, req.user);
    if (out.error) return fail(res, out.status || 400, out.error);
    await logAudit({ userId: req.user.id, action: out.agentUser ? 'ViciDial agent ID set' : 'ViciDial agent ID removed', entity: 'User', entityId: out.user.id, fromValue: before || null, toValue: `${out.user.name}: ${out.agentUser || 'not set'}` });
    return res.json({ userId: out.user.id, agentUser: out.agentUser });
  } catch (e) { console.error('[vicidial] agent:', e.message); return fail(res, 500, 'Could not save the agent ID.'); }
});

router.post('/vicidial/dial', async (req, res) => {
  try {
    const w = await who(req.user);
    if (!w.ok) return fail(res, w.code, w.reason);
    const vr = await VD.readyFor(req.user, kindOf(req.user));
    if (!vr.ok) return fail(res, vr.off || vr.noAgent ? 409 : 403, vr.reason, { code: vr.off ? 'VICIDIAL_OFF' : (vr.noAgent ? 'NO_AGENT_ID' : 'ROLE') });
    // the number comes from the candidate record this login may see - never from the browser
    const cand = await prisma.candidate.findFirst({ where: { id: clip(req.body && req.body.candidateId, 60), ...scope.candidateWhere(req.user) }, select: { id: true, name: true, phone: true } });
    if (!cand) return fail(res, 404, 'Candidate not found.');
    const n = core.normalizeMobile(cand.phone);
    if (!n.ok) return fail(res, 400, n.reason);
    if (n.cc !== '91') return fail(res, 400, 'Only Indian mobile numbers can be called from here.');
    if (w.s.mode === 'Test' && !w.s.testNumbers.includes(n.national)) return fail(res, 403, "Test mode: only the Admin's test phone numbers can be called.", { code: 'TEST_MODE' });
    const sandbox = require('../utils/sandbox'); // eslint-disable-line global-require
    if (sandbox.isSandbox() && !['127.0.0.1', 'localhost', '::1'].includes(VD.hostOf(vr.settings.server))) return fail(res, 409, 'TEST MODE: this computer is a test copy and does not hand out a dial link to a real ViciDial server.', { code: 'SANDBOX' });
    const link = await VD.dialUrl({ agentUser: vr.agent, number: n.national });
    if (link.error) return fail(res, 409, link.error);
    const id = crypto.randomUUID(); const token = crypto.randomBytes(12).toString('hex'); const now = S.nowIso();
    await S.run('INSERT INTO "BrowserCall" ("id","token","candidateId","applicationId","userId","userName","toNumber","extension","direction","mode","status","startAt","createdAt","updatedAt","lineId","lineName","recordingStatus","recordingNote","processedAt") VALUES (?,?,?,?,?,?,?,?,\'outbound\',?,\'requested\',?,?,?,?,?,\'none\',?,?)',
      id, token, cand.id, clip(req.body && req.body.applicationId, 60) || null, req.user.id, clip(req.user.name, 80), n.national, clip(`vici:${vr.agent}`, 60), w.s.mode, now, now, now, VD.LINE_ID, VD.LINE_NAME, 'Recorded in ViciDial', now);
    await logAudit({ userId: req.user.id, action: 'ViciDial dial requested', entity: 'Candidate', entityId: cand.id, toValue: `agent ${vr.agent} -> ${core.maskMobile(n.national)} (${VD.hostOf(vr.settings.server)})` });
    res.set('Cache-Control', 'no-store');
    return res.json({ callId: id, number: n.national, candidate: { id: cand.id, name: cand.name }, line: { id: VD.LINE_ID, name: VD.LINE_NAME }, agentUser: vr.agent, dialUrl: link.url, closeAfterMs: 4000, recording: 'Recorded in ViciDial' });
  } catch (e) { console.error('[vicidial] dial:', VD.maskUrl(e.message)); return fail(res, 500, 'Could not ask ViciDial to dial.'); }
});
// how the call went (the recruiter says it after talking on the ViciDial agent screen): only the person who asked for it, or an Admin
router.post('/vicidial/calls/:id/outcome', async (req, res) => {
  try {
    const r = await S.one('SELECT * FROM "BrowserCall" WHERE "id"=?', clip(req.params.id, 60));
    if (!r || r.lineId !== VD.LINE_ID || (r.userId !== req.user.id && !isAdmin(req.user))) return fail(res, 404, 'Call not found.');
    const outcome = String((req.body && req.body.outcome) || '');
    const status = VD.OUTCOMES[outcome];
    if (!status) return fail(res, 400, `Pick how the call went: ${Object.keys(VD.OUTCOMES).join(', ')}.`);
    const note = String((req.body && req.body.note) || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 240);
    const now = S.nowIso();
    await S.run('UPDATE "BrowserCall" SET "status"=?, "hangupReason"=?, "endAt"=COALESCE("endAt", ?), "updatedAt"=? WHERE "id"=?', status, `${outcome}${note ? ` · ${note}` : ''}`, now, now, r.id);
    await logAudit({ userId: req.user.id, action: 'ViciDial call outcome saved', entity: 'Candidate', entityId: r.candidateId, toValue: `${outcome}${note ? ` · ${note.slice(0, 120)}` : ''}` });
    const row = await S.one('SELECT * FROM "BrowserCall" WHERE "id"=?', r.id);
    return res.json({ call: shape(row, req.user) });
  } catch (e) { console.error('[vicidial] outcome:', e.message); return fail(res, 500, 'Could not save how the call went.'); }
});

// ---------------------------------------------------------------------------- INCOMING on the person's SIM: what the ringing popup shows
// The dialplan puts the call's token (in<digits>) in the caller ID the browser sees; the browser asks here who it is. Only the person whose
// SIM it rang; the candidate only if this login may see them (scope); the caller's number only masked.
router.get('/incoming/:token', async (req, res) => {
  try {
    const w = await who(req.user);
    if (!w.ok) return fail(res, w.code, w.reason);
    const token = clip(req.params.token, 40).replace(/[^a-z0-9]/g, '');
    const r = token ? await S.one('SELECT * FROM "BrowserCall" WHERE "token"=? AND "direction"=\'inbound\'', token) : null;
    if (!r || r.userId !== req.user.id) return fail(res, 404, 'No such incoming call for you (yet).');
    let candidate = null;
    if (r.candidateId && r.candidateId !== 'unknown') {
      const c = await prisma.candidate.findFirst({ where: { id: r.candidateId, ...scope.candidateWhere(req.user) }, select: { id: true, name: true } });
      if (c) {
        const a = await prisma.application.findFirst({ where: { candidateId: c.id, ...scope.applicationWhere(req.user) }, orderBy: { updatedAt: 'desc' }, select: { requirement: { select: { title: true, client: { select: { name: true } } } } } }).catch(() => null);
        candidate = { id: c.id, name: c.name, requirement: a && a.requirement ? `${a.requirement.title}${a.requirement.client ? ` · ${a.requirement.client.name}` : ''}` : null };
      }
    }
    const sim = await SIMS.mineFor(req.user).catch(() => null);
    res.set('Cache-Control', 'no-store');
    return res.json({ callId: r.id, status: r.status, number: SIMS.mask(r.toNumber !== 'unknown' ? r.toNumber : ''), candidate, lineName: r.lineName, sim: sim ? { port: sim.portLabel, number: sim.number } : null });
  } catch (e) { console.error('[browser-call] incoming:', e.message); return fail(res, 500, 'Could not look the caller up.'); }
});

// ---------------------------------------------------------------------------- SIM NUMBERS (Admin): one Synway port per person
async function simsView() {
  // the people a port can be given to: active ATS logins of a kind that calls candidates (never BDE / BDE TL / Manager)
  const users = await prisma.user.findMany({ where: { status: 'Active', atsAccess: true }, orderBy: { name: 'asc' }, take: 2000 });
  const people = users.map((u) => { let k = 'none'; try { k = kindOf(u); } catch { k = 'none'; } return { userId: u.id, name: u.name, role: KIND_WORD[k] || k, kind: k }; }).filter((p) => SIMS.SIM_KINDS.includes(p.kind));
  return { ...(await SIMS.adminView()), people, pbx: L.isPbx(), lastWrite: L.lastWrite() };
}
const simLabel = (x) => `port ${SIMS.pad2(x.port)} · ${SIMS.mask(x.simNumber)}`;
router.get('/admin/sims', async (req, res) => {
  if (!isAdmin(req.user)) return fail(res, 403, 'Admin only.');
  try { return res.json(await simsView()); } catch (e) { console.error('[browser-call] sims:', e.message); return fail(res, 500, 'Could not load the SIM numbers.'); }
});
router.post('/admin/sims', async (req, res) => {
  if (!isAdmin(req.user)) return fail(res, 403, 'Admin only.');
  try {
    const out = await SIMS.create(req.user, req.body || {});
    if (out.error && !out.created) return fail(res, out.status, out.error);
    const cfg = await L.writeConfig();
    const made = out.sim || out.created;
    await logAudit({ userId: req.user.id, action: 'SIM port added', entity: 'Integration', entityId: made.id, toValue: `${simLabel(made)}${made.operator ? ` · ${made.operator}` : ''}${made.userId ? ' · assigned' : ''}` });
    if (out.error) return fail(res, out.status, `The port is saved, but not given to that person: ${out.error}`);
    return res.status(201).json({ ...(await simsView()), message: `Saved. ${applied(cfg)}` });
  } catch (e) { console.error('[browser-call] sim add:', e.message); return fail(res, 500, 'Could not save the SIM port.'); }
});
router.put('/admin/sims/:id', async (req, res) => {
  if (!isAdmin(req.user)) return fail(res, 403, 'Admin only.');
  try {
    const out = await SIMS.update(req.user, req.params.id, req.body || {});
    if (out.error) return fail(res, out.status, out.error);
    const cfg = await L.writeConfig();
    const b = out.before; const a = out.sim;
    const what = b.userId !== a.userId ? (a.userId ? 'SIM port assigned' : 'SIM port taken back') : (b.active !== a.active ? (a.active ? 'SIM port switched on' : 'SIM port switched off') : 'SIM port changed');
    let toWho = '';
    if (a.userId) { const u = await prisma.user.findUnique({ where: { id: a.userId }, select: { name: true } }); toWho = u ? ` -> ${u.name}` : ''; }
    await logAudit({ userId: req.user.id, action: what, entity: 'Integration', entityId: a.id, fromValue: simLabel(b), toValue: `${simLabel(a)}${toWho} · prefix ${a.dialPrefix} · match ${a.matchBy}` });
    return res.json({ ...(await simsView()), message: `Saved. ${applied(cfg)}` });
  } catch (e) { console.error('[browser-call] sim edit:', e.message); return fail(res, 500, 'Could not save the SIM port.'); }
});
router.delete('/admin/sims/:id', async (req, res) => {
  if (!isAdmin(req.user)) return fail(res, 403, 'Admin only.');
  try {
    const out = await SIMS.remove(req.params.id);
    if (out.error) return fail(res, out.status, out.error);
    const cfg = await L.writeConfig();
    await logAudit({ userId: req.user.id, action: 'SIM port removed', entity: 'Integration', entityId: out.sim.id, fromValue: simLabel(out.sim) });
    return res.json({ ...(await simsView()), message: `Removed. ${applied(cfg)}` });
  } catch (e) { return fail(res, 500, 'Could not remove the SIM port.'); }
});
router.put('/admin/sims-settings', async (req, res) => {
  if (!isAdmin(req.user)) return fail(res, 403, 'Admin only.');
  try {
    const b = req.body || {};
    const before = await SIMS.settings();
    const out = await SIMS.saveSettings({ prefixRouting: b.prefixRouting, missedTask: b.missedTask, fallbackUserId: b.fallbackUserId });
    if (out.error) return fail(res, 400, out.error);
    const st = out.settings;
    const cfg = await L.writeConfig();
    const changed = [before.prefixRouting !== st.prefixRouting && `Port prefix routing ${st.prefixRouting ? 'ON' : 'OFF'}`, before.missedTask !== st.missedTask && `"Call back" task for a missed call ${st.missedTask ? 'on' : 'off'}`, before.fallbackUserId !== st.fallbackUserId && `fallback ${st.fallbackUserId ? 'set' : 'nobody'}`].filter(Boolean);
    await logAudit({ userId: req.user.id, action: 'SIM number settings saved', entity: 'Integration', entityId: 'browser-calling-sims', toValue: changed.join(' · ') || 'no change' });
    return res.json({ ...(await simsView()), message: `Saved. ${applied(cfg)}` });
  } catch (e) { console.error('[browser-call] sim settings:', e.message); return fail(res, 500, 'Could not save.'); }
});
// "Check a called number": who would ring for it (the same decision as the generated [tl-from-gateway])
router.get('/admin/sims/route', async (req, res) => {
  if (!isAdmin(req.user)) return fail(res, 403, 'Admin only.');
  try {
    const r = await SIMS.routeInbound(clip(req.query.called, 30));
    let name = null;
    if (r.userId) { const u = await prisma.user.findUnique({ where: { id: r.userId }, select: { name: true } }); name = u ? u.name : null; }
    return res.json({ ...r, userName: name });
  } catch (e) { return fail(res, 500, 'Could not check the number.'); }
});
// the generated phone-system text (what TeamLink writes into extensions_tl_sims.conf and the p<NN> part of extensions_tl_lines.conf)
router.get('/admin/sims/preview', async (req, res) => {
  if (!isAdmin(req.user)) return fail(res, 403, 'Admin only.');
  try { const s = await CFG.load(); const out = await SIMS.renderAll({ record: s.record }); return res.json({ inbound: out.inbound, route: out.routeLines.join('\n').trim(), file: SIMS.simsFile() }); } catch (e) { return fail(res, 500, 'Could not render it.'); }
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
    const before = await CFG.load();
    const s = await CFG.save({ mode: b.mode, testNumbers: b.testNumbers, kinds: b.kinds, record: b.record, keepDays: b.keepDays });
    let config = null;
    if (before.record !== s.record) config = await L.writeConfig(); // the dialplan carries the recording line only while the switch is on
    await logAudit({ userId: req.user.id, action: 'Browser calling settings saved', entity: 'Integration', entityId: 'browser-calling', toValue: `Switch: ${s.mode} · Record calls: ${s.record ? 'on' : 'off'} · keep ${s.keepDays} days` });
    res.json({ ...s, testNumbers: s.testNumbers.join(', '), config });
  } catch (e) { fail(res, 400, e.message); }
});

// ---------------------------------------------------------------------------- PHONE LINES (Admin): Synway / Dinstar / ViciDial / other SIP by IP
// Secrets never leave the server again after creation (a registering device's password is shown ONCE, in the create / new-password answer).
const lineMeta = () => ({
  types: Object.entries(L.TYPES).map(([id, t]) => ({ id, label: t.label, help: t.help })),
  connects: Object.entries(L.CONNECTS).map(([id, label]) => ({ id, label })),
  formats: Object.entries(L.FORMATS).map(([id, label]) => ({ id, label })),
  allKinds: L.ALL_KINDS,
  register: { server: CFG.ENV.publicIp, port: CFG.ENV.registerPort, transport: 'UDP' },
});
async function adminLines() {
  const rows = (await L.rows()).map(L.shape);
  const s = await CFG.load();
  return { lines: [L.DEFAULT_LINE, ...rows], browserKinds: s.kinds, pbx: L.isPbx(), lastWrite: L.lastWrite(), ...lineMeta() };
}
const applied = (cfg) => (cfg.pbx ? (cfg.reloaded ? 'Asterisk updated and reloaded.' : (cfg.error || 'Asterisk was not reloaded.')) : cfg.note);

router.get('/admin/lines', async (req, res) => {
  if (!isAdmin(req.user)) return fail(res, 403, 'Admin only.');
  try { return res.json(await adminLines()); } catch (e) { console.error('[browser-call] lines:', e.message); return fail(res, 500, 'Could not load the phone lines.'); }
});
router.get('/admin/lines/status', async (req, res) => {
  if (!isAdmin(req.user)) return fail(res, 403, 'Admin only.');
  try { const all = [L.DEFAULT_LINE, ...(await L.rows()).map(L.shape)]; return res.json(await L.statusAll(all)); } catch (e) { return fail(res, 500, 'Could not read the line states.'); }
});
router.post('/admin/lines', async (req, res) => {
  if (!isAdmin(req.user)) return fail(res, 403, 'Admin only.');
  try {
    const out = await L.create(req.user, req.body || {});
    if (out.error) return fail(res, out.status, out.error);
    const cfg = await L.writeConfig();
    await logAudit({ userId: req.user.id, action: 'Phone line added', entity: 'Integration', entityId: out.line.id, toValue: `${out.line.name} · ${out.line.typeLabel} · ${out.line.connectLabel}${out.line.host ? ` · ${out.line.host}${out.line.port ? `:${out.line.port}` : ''}` : ''}` });
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({ line: out.line, setup: out.setup, config: cfg, message: `Saved. ${applied(cfg)}` });
  } catch (e) { console.error('[browser-call] line add:', e.message); return fail(res, 500, 'Could not save the line.'); }
});
router.put('/admin/lines/:id', async (req, res) => {
  if (!isAdmin(req.user)) return fail(res, 403, 'Admin only.');
  if (req.params.id === 'default') return fail(res, 400, 'The built-in office Synway line is managed by its own config on the phone system and cannot be edited here.');
  try {
    const out = await L.update(req.user, req.params.id, req.body || {});
    if (out.error) return fail(res, out.status, out.error);
    const cfg = await L.writeConfig();
    const what = out.before.active !== out.line.active ? (out.line.active ? 'Phone line switched on' : 'Phone line switched off') : 'Phone line changed';
    await logAudit({ userId: req.user.id, action: what, entity: 'Integration', entityId: out.line.id, fromValue: out.before.name, toValue: `${out.line.name} · ${out.line.typeLabel}${out.line.host ? ` · ${out.line.host}` : ''}` });
    return res.json({ line: out.line, config: cfg, message: `Saved. ${applied(cfg)}` });
  } catch (e) { console.error('[browser-call] line edit:', e.message); return fail(res, 500, 'Could not save the line.'); }
});
router.post('/admin/lines/:id/new-password', async (req, res) => {
  if (!isAdmin(req.user)) return fail(res, 403, 'Admin only.');
  try {
    const out = await L.rotatePassword(req.params.id);
    if (out.error) return fail(res, out.status, out.error);
    const cfg = await L.writeConfig();
    await logAudit({ userId: req.user.id, action: 'Phone line: new device password', entity: 'Integration', entityId: out.line.id, toValue: out.line.name });
    res.set('Cache-Control', 'no-store');
    return res.json({ line: out.line, setup: out.setup, config: cfg, message: `New password made. Type it into the device now: it is not shown again. ${applied(cfg)}` });
  } catch (e) { return fail(res, 500, 'Could not make a new password.'); }
});
// "Test call" on a line: the Admin calls one of their own test numbers (Browser calling Test numbers), from the browser, on that line.
router.post('/admin/lines/:id/test-call', async (req, res) => {
  if (!isAdmin(req.user)) return fail(res, 403, 'Admin only.');
  try {
    const w = await who(req.user);
    if (!w.ok) return fail(res, w.code, w.reason);
    const num = String((req.body && req.body.number) || '').replace(/\D/g, '').slice(-10);
    if (!w.s.testNumbers.length) return fail(res, 400, 'Add your own phone number to "Test numbers" above first.');
    if (!w.s.testNumbers.includes(num)) return fail(res, 403, 'A test call only goes to one of the Test numbers above.', { code: 'TEST_MODE' });
    const placed = await place(req.user, w, { candidateId: TEST_CALL, applicationId: null, number: num, lineId: req.params.id });
    if (placed.error) return fail(res, placed.code, placed.error, placed.extra || {});
    await logAudit({ userId: req.user.id, action: 'Phone line test call', entity: 'Integration', entityId: placed.line.id, toValue: `${placed.line.name} -> ${core.maskMobile(num)}` });
    return res.json({ callId: placed.id, token: placed.token, number: num, candidate: { id: TEST_CALL, name: `Test call · ${placed.line.name}` }, line: { id: placed.line.id, name: placed.line.name, header: placed.line.header } });
  } catch (e) { console.error('[browser-call] test call:', e.message); return fail(res, 500, 'Could not start the test call.'); }
});

module.exports = router;

