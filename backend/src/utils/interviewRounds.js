// ---------------------------------------------------------------------------
// INTERVIEW ROUNDS (founder ATS audit 2026-11-18, items 232 / 235 / 242 / 244 / 247 / 248 / 250).
//
// An application can have Round 1 ... n. Each round has its own TYPE (Technical / HR / Management / Client / Other), date, mode, link,
// panel and its OWN feedback row, with a form that fits the type:
//   Technical    skills (name + 1-5), technical, problem solving, communication
//   HR           attitude 1-5, expectations (Yes / Partly / No), notice period, current CTC, expected CTC
//   Management   culture fit 1-5, leadership 1-5, fit for the team (Yes / No), final note
//   Client/Other the four plain ratings
// InterviewFeedback (one row per application + side) is still written as before and still read by every older screen. The new rows live in
// raw tables (no migration): InterviewRound, InterviewRoundFeedback, InterviewAttachment, InterviewerRating. Old rounds (feedback history rows
// and the one InterviewFeedback row) are brought in LAZILY, the first time an application's rounds are read (importLegacy), never rewritten.
//
// The result of the last round is NOT automatic: the stage owner still decides (POST /ats/interviews/:id/decision). suggestedDecision() only
// proposes one from the ratings and the recommendations.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

const ROUND_TYPES = ['Technical', 'HR', 'Management', 'Client', 'Other'];
const RECS = ['Selected', 'Rejected', 'Hold'];
const PROVIDERS = ['Google Meet', 'Zoom', 'Teams', 'Other'];
const MAX_FILE = 20 * 1024 * 1024;

let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      const ddl = [
        `CREATE TABLE IF NOT EXISTS "InterviewRound" ("applicationId" TEXT NOT NULL, "round" INTEGER NOT NULL, "roundType" TEXT, "scheduledAt" TEXT, "mode" TEXT, "location" TEXT,
          "meetingLink" TEXT, "linkProvider" TEXT, "panel" TEXT, "status" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL, PRIMARY KEY ("applicationId","round"))`,
        `CREATE TABLE IF NOT EXISTS "InterviewRoundFeedback" ("id" TEXT PRIMARY KEY, "applicationId" TEXT NOT NULL, "round" INTEGER NOT NULL, "roundType" TEXT NOT NULL,
          "technical" INTEGER, "communication" INTEGER, "experience" INTEGER, "roleFit" INTEGER, "details" TEXT, "overall" TEXT NOT NULL, "recommendation" TEXT NOT NULL,
          "legacy" INTEGER NOT NULL DEFAULT 0, "byId" TEXT, "byName" TEXT, "at" TEXT NOT NULL, "updatedAt" TEXT NOT NULL)`,
        'CREATE UNIQUE INDEX IF NOT EXISTS "IRF_app_round" ON "InterviewRoundFeedback" ("applicationId","round")',
        `CREATE TABLE IF NOT EXISTS "InterviewAttachment" ("id" TEXT PRIMARY KEY, "applicationId" TEXT NOT NULL, "round" INTEGER NOT NULL, "kind" TEXT NOT NULL, "title" TEXT,
          "url" TEXT, "fileStored" TEXT, "fileName" TEXT, "fileMime" TEXT, "fileSize" INTEGER, "note" TEXT, "byId" TEXT, "byName" TEXT, "at" TEXT NOT NULL)`,
        'CREATE INDEX IF NOT EXISTS "IA_app" ON "InterviewAttachment" ("applicationId","round")',
        `CREATE TABLE IF NOT EXISTS "InterviewerRating" ("id" TEXT PRIMARY KEY, "applicationId" TEXT NOT NULL, "round" INTEGER NOT NULL, "interviewerKey" TEXT NOT NULL, "interviewerId" TEXT,
          "interviewerName" TEXT NOT NULL, "rating" INTEGER NOT NULL, "comment" TEXT, "byId" TEXT, "byName" TEXT, "at" TEXT NOT NULL)`,
        'CREATE UNIQUE INDEX IF NOT EXISTS "IR_one" ON "InterviewerRating" ("applicationId","round","interviewerKey","byId")',
        'CREATE INDEX IF NOT EXISTS "IR_who" ON "InterviewerRating" ("interviewerKey")',
      ];
      for (const s of ddl) await prisma.$executeRawUnsafe(s); // eslint-disable-line no-await-in-loop
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}

const N = (v) => (v == null ? null : Number(v));
const txt = (v, n = 500) => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, n) : null; };
const rate = (v) => { if (v === '' || v == null) return null; const n = Math.round(Number(v)); return Number.isNaN(n) ? null : Math.max(1, Math.min(5, n)); };
const now = () => new Date().toISOString();
const newId = (p) => `${p}${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;

// ----------------------------------------------------------------- meeting links (235)
const PROVIDER_RE = {
  'Google Meet': /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(\?.*)?$/i,
  Zoom: /^https:\/\/([a-z0-9-]+\.)?zoom\.(us|com)\/(j|my|wc\/join)\/[A-Za-z0-9_.-]+(\?.*)?$/i,
  Teams: /^https:\/\/(teams\.microsoft\.com\/(l\/meetup-join|meet)\/|teams\.live\.com\/meet\/)[^\s]+$/i,
};
// -> { ok, url, provider } | { ok:false, error }. A blank link is fine (ok with url null). Provider left out = found from the link.
function checkMeetingLink(raw, provider) {
  const url = String(raw || '').trim();
  if (!url) return { ok: true, url: null, provider: PROVIDERS.includes(provider) ? provider : null };
  if (url.length > 500) return { ok: false, error: 'That link is too long.' };
  if (/\s/.test(url)) return { ok: false, error: 'The link has a space in it. Paste only the link.' };
  let u;
  try { u = new URL(url); } catch { return { ok: false, error: 'That does not look like a link.' }; }
  if (u.protocol !== 'https:' || !u.hostname.includes('.')) return { ok: false, error: 'The meeting link should start with https://.' };
  let want = provider;
  if (want && !PROVIDERS.includes(want)) return { ok: false, error: `Pick one of: ${PROVIDERS.join(', ')}.` };
  if (!want) want = Object.keys(PROVIDER_RE).find((k) => PROVIDER_RE[k].test(url)) || 'Other';
  if (want !== 'Other' && !PROVIDER_RE[want].test(url)) {
    const eg = { 'Google Meet': 'https://meet.google.com/abc-defg-hij', Zoom: 'https://zoom.us/j/123456789', Teams: 'https://teams.microsoft.com/l/meetup-join/...' }[want];
    return { ok: false, error: `That is not a ${want} link. A ${want} link looks like ${eg}.` };
  }
  return { ok: true, url, provider: want };
}

// ----------------------------------------------------------------- feedback by type (242)
// -> { value } | { error }. value: { roundType, technical, communication, experience, roleFit, details, overall, recommendation }
function cleanFeedback(roundType, b) {
  const type = ROUND_TYPES.includes(roundType) ? roundType : 'Other';
  const overall = txt(b.overall || b.feedback, 4000);
  if (!overall) return { error: 'Write the overall feedback.' };
  const recommendation = RECS.find((r) => r.toLowerCase() === String(b.recommendation || '').trim().toLowerCase());
  if (!recommendation) return { error: 'Recommendation must be Selected, Rejected or Hold.' };
  const v = {
    roundType: type, technical: rate(b.technical), communication: rate(b.communication), experience: rate(b.experience), roleFit: rate(b.roleFit), overall, recommendation, details: {},
  };
  if (type === 'Technical') {
    const skills = (Array.isArray(b.skills) ? b.skills : []).slice(0, 20).map((s) => ({ name: txt(s && s.name, 60), rating: rate(s && s.rating) })).filter((s) => s.name && s.rating);
    v.details = { skills, problemSolving: rate(b.problemSolving) };
    if (!skills.length && v.technical == null) return { error: 'Rate at least one skill, or the technical rating.' };
  } else if (type === 'HR') {
    const exp = ['Yes', 'Partly', 'No'].includes(b.expectationsMatch) ? b.expectationsMatch : null;
    v.details = { attitude: rate(b.attitude), expectationsMatch: exp, noticePeriod: txt(b.noticePeriod, 60), currentCtc: txt(b.currentCtc, 40), expectedCtc: txt(b.expectedCtc, 40) };
    if (v.details.attitude == null) return { error: 'Rate the candidate\'s attitude (1 to 5).' };
  } else if (type === 'Management') {
    const fit = ['Yes', 'No'].includes(b.fitForTeam) ? b.fitForTeam : null;
    v.details = { cultureFit: rate(b.cultureFit), leadership: rate(b.leadership), fitForTeam: fit, finalNote: txt(b.finalNote, 1000) };
    if (v.details.cultureFit == null) return { error: 'Rate the culture fit (1 to 5).' };
  }
  return { value: v };
}
// Every rating a row carries -> one average (null when none).
function averageOf(f) {
  if (!f) return null;
  const d = f.details || {};
  const nums = [f.technical, f.communication, f.experience, f.roleFit, d.problemSolving, d.attitude, d.cultureFit, d.leadership, ...((d.skills || []).map((s) => s.rating))]
    .filter((x) => x != null && Number.isFinite(Number(x))).map(Number);
  return nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null;
}
const shapeFeedback = (r) => {
  if (!r) return null;
  let details = {}; try { details = JSON.parse(r.details || '{}') || {}; } catch { details = {}; }
  const f = {
    id: r.id, round: N(r.round), roundType: r.roundType, technical: N(r.technical), communication: N(r.communication), experience: N(r.experience), roleFit: N(r.roleFit), details,
    overall: r.overall, recommendation: r.recommendation, legacy: Number(r.legacy) === 1, byId: r.byId, byName: r.byName, at: r.at, updatedAt: r.updatedAt,
  };
  f.average = averageOf(f);
  return f;
};

// ----------------------------------------------------------------- lazy migration (232 / 248)
// The feedback of old rounds (InterviewFeedbackHistory, else the one Internal InterviewFeedback row) becomes round rows, once.
async function importLegacy(applicationId, currentRound) {
  await ensure();
  const have = await prisma.$queryRawUnsafe('SELECT "round" FROM "InterviewRoundFeedback" WHERE "applicationId" = ?', applicationId);
  const taken = new Set(have.map((r) => N(r.round)));
  let hist = [];
  try { hist = await prisma.$queryRawUnsafe('SELECT * FROM "InterviewFeedbackHistory" WHERE "applicationId" = ? AND "kind" = \'Internal\' ORDER BY "id" ASC', applicationId); } catch { hist = []; }
  const lastPerRound = new Map();
  hist.forEach((h) => lastPerRound.set(N(h.round) || 1, h)); // the latest edit of each round wins
  const list = [...lastPerRound.entries()].map(([round, h]) => ({ round, h }));
  if (!list.length) {
    const cur = await prisma.interviewFeedback.findFirst({ where: { applicationId, kind: 'Internal' } }).catch(() => null);
    if (cur) list.push({ round: currentRound || 1, h: { technical: cur.technical, communication: cur.communication, experience: cur.experience, roleFit: cur.roleFit, overall: cur.overall, recommendation: cur.recommendation, byId: cur.submittedById, byName: cur.submittedBy, at: (cur.updatedAt || cur.createdAt).toISOString() } });
  }
  for (const { round, h } of list) {
    if (taken.has(round) || !h.overall || !h.recommendation) continue;
    // eslint-disable-next-line no-await-in-loop
    await prisma.$executeRawUnsafe('INSERT OR IGNORE INTO "InterviewRoundFeedback" ("id","applicationId","round","roundType","technical","communication","experience","roleFit","details","overall","recommendation","legacy","byId","byName","at","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)',
      newId('irf'), applicationId, round, 'Other', N(h.technical), N(h.communication), N(h.experience), N(h.roleFit), '{}', h.overall, h.recommendation, h.byId || null, h.byName || null, h.at || now(), h.at || now());
  }
}

// ----------------------------------------------------------------- rounds
// Called after a booking: stores the type, link, provider of that round.
async function noteBooking(applicationId, round, data) {
  await ensure();
  const t = now();
  await prisma.$executeRawUnsafe(`INSERT INTO "InterviewRound" ("applicationId","round","roundType","scheduledAt","mode","location","meetingLink","linkProvider","panel","status","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT("applicationId","round") DO UPDATE SET "roundType"=COALESCE(excluded."roundType","roundType"),"scheduledAt"=excluded."scheduledAt","mode"=excluded."mode","location"=excluded."location","meetingLink"=excluded."meetingLink","linkProvider"=excluded."linkProvider","panel"=excluded."panel","status"=excluded."status","updatedAt"=excluded."updatedAt"`,
  applicationId, Number(round), ROUND_TYPES.includes(data.roundType) ? data.roundType : null, data.scheduledAt ? new Date(data.scheduledAt).toISOString() : null, txt(data.mode, 30), txt(data.location, 300),
  txt(data.meetingLink, 500), txt(data.linkProvider, 30), txt(data.panel, 200), txt(data.status, 30) || 'SCHEDULED', t, t);
}
async function setRoundType(applicationId, round, roundType, user) {
  await ensure();
  if (!ROUND_TYPES.includes(roundType)) return { error: `Round type must be one of: ${ROUND_TYPES.join(', ')}.` };
  const t = now();
  await prisma.$executeRawUnsafe('INSERT INTO "InterviewRound" ("applicationId","round","roundType","status","createdAt","updatedAt") VALUES (?,?,?,?,?,?) ON CONFLICT("applicationId","round") DO UPDATE SET "roundType"=excluded."roundType","updatedAt"=excluded."updatedAt"',
    applicationId, Number(round), roundType, 'SCHEDULED', t, t);
  await prisma.$executeRawUnsafe('UPDATE "InterviewRoundFeedback" SET "roundType"=? WHERE "applicationId"=? AND "round"=? AND "legacy"=1', roundType, applicationId, Number(round));
  return { ok: true, by: user && user.name };
}

// Everything a round shows. app: { id, interviewRound, interviewAt, interviewMode, interviewLocation, interviewMeetingLink, interviewer, interviewStatus, interviewType }
async function roundsOf(app, { withFeedback = true, withAttachments = true } = {}) {
  await ensure();
  if (withFeedback) await importLegacy(app.id, app.interviewRound || 1);
  const [rounds, fbs, atts, panel, events] = await Promise.all([
    prisma.$queryRawUnsafe('SELECT * FROM "InterviewRound" WHERE "applicationId" = ?', app.id),
    withFeedback ? prisma.$queryRawUnsafe('SELECT * FROM "InterviewRoundFeedback" WHERE "applicationId" = ?', app.id) : [],
    withAttachments ? prisma.$queryRawUnsafe('SELECT * FROM "InterviewAttachment" WHERE "applicationId" = ? ORDER BY "at" ASC', app.id) : [],
    prisma.interviewPanelist.findMany({ where: { applicationId: app.id }, orderBy: { position: 'asc' } }).catch(() => []),
    prisma.interviewEvent.findMany({ where: { applicationId: app.id }, orderBy: { createdAt: 'asc' } }).catch(() => []),
  ]);
  const nums = new Set([app.interviewRound || 1]);
  rounds.forEach((r) => nums.add(N(r.round)));
  fbs.forEach((r) => nums.add(N(r.round)));
  atts.forEach((r) => nums.add(N(r.round)));
  panel.forEach((p) => nums.add(p.round || 1));
  const ratings = await prisma.$queryRawUnsafe('SELECT "round","interviewerKey","interviewerName","rating" FROM "InterviewerRating" WHERE "applicationId" = ?', app.id);
  const out = [...nums].sort((a, b) => a - b).map((round) => {
    const meta = rounds.find((r) => N(r.round) === round) || null;
    const fb = shapeFeedback(fbs.find((r) => N(r.round) === round));
    const current = round === (app.interviewRound || 1);
    const people = panel.filter((p) => (p.round || 1) === round);
    const booked = events.filter((e) => /Round (\d+) booked/.test(e.reason || '') ? Number(/Round (\d+) booked/.exec(e.reason)[1]) === round : (round === 1 && /Interview booked/.test(e.reason || '')));
    return {
      round,
      roundType: (meta && meta.roundType) || (fb && fb.roundType !== 'Other' ? fb.roundType : null) || null,
      scheduledAt: (meta && meta.scheduledAt) || (current && app.interviewAt ? new Date(app.interviewAt).toISOString() : (booked.length && booked[booked.length - 1].toSlot) || null),
      mode: (meta && meta.mode) || (current ? app.interviewMode : null) || null,
      location: (meta && meta.location) || (current ? app.interviewLocation : null) || null,
      meetingLink: (meta && meta.meetingLink) || (current ? app.interviewMeetingLink : null) || null,
      linkProvider: (meta && meta.linkProvider) || null,
      panel: people.map((p) => ({ id: p.id, userId: p.userId, name: p.name })),
      interviewers: people.length ? people.map((p) => p.name) : (current && app.interviewer ? String(app.interviewer).split(',').map((s) => s.trim()).filter(Boolean) : []),
      status: current ? app.interviewStatus : (fb ? 'FEEDBACK_SUBMITTED' : (meta && meta.status) || null),
      current,
      feedback: fb,
      attachments: atts.filter((a) => N(a.round) === round).map((a) => ({ id: a.id, kind: a.kind, title: a.title, url: a.url, fileName: a.fileName, fileSize: N(a.fileSize), hasFile: !!a.fileStored, note: a.note, byName: a.byName, at: a.at })),
      interviewerRatings: ratings.filter((r) => N(r.round) === round).map((r) => ({ key: r.interviewerKey, name: r.interviewerName, rating: N(r.rating) })),
    };
  });
  return out;
}

// ----------------------------------------------------------------- suggested decision (247)
// A suggestion only. Latest round's recommendation + the average of every rated round.
function suggestedDecision(rounds) {
  const withFb = (rounds || []).filter((r) => r.feedback);
  if (!withFb.length) return null;
  const last = withFb[withFb.length - 1];
  const avgs = withFb.map((r) => r.feedback.average).filter((x) => x != null);
  const average = avgs.length ? Math.round((avgs.reduce((a, b) => a + b, 0) / avgs.length) * 10) / 10 : null;
  const rec = last.feedback.recommendation;
  let decision = 'Hold';
  let why;
  if (rec === 'Rejected' || (average != null && average < 2.5)) { decision = 'Rejected'; why = rec === 'Rejected' ? `Round ${last.round} recommended Rejected` : `average rating ${average} is below 2.5`; }
  else if (rec === 'Selected' && (average == null || average >= 3.5)) { decision = 'Selected'; why = `Round ${last.round} recommended Selected${average != null ? ` and the average rating is ${average}` : ''}`; }
  else why = rec === 'Selected' ? `Round ${last.round} recommended Selected but the average rating ${average} is under 3.5` : `Round ${last.round} recommended Hold`;
  return { decision, average, rounds: withFb.length, basedOnRound: last.round, why: `${why}. This is a suggestion; the stage owner decides.` };
}

// ----------------------------------------------------------------- save feedback / attachments / interviewer rating
async function saveFeedback(applicationId, round, value, user) {
  await ensure();
  const t = now();
  const [old] = await prisma.$queryRawUnsafe('SELECT "id" FROM "InterviewRoundFeedback" WHERE "applicationId" = ? AND "round" = ?', applicationId, Number(round));
  const d = JSON.stringify(value.details || {});
  if (old) {
    await prisma.$executeRawUnsafe('UPDATE "InterviewRoundFeedback" SET "roundType"=?,"technical"=?,"communication"=?,"experience"=?,"roleFit"=?,"details"=?,"overall"=?,"recommendation"=?,"legacy"=0,"byId"=?,"byName"=?,"updatedAt"=? WHERE "id"=?',
      value.roundType, value.technical, value.communication, value.experience, value.roleFit, d, value.overall, value.recommendation, user.id, user.name, t, old.id);
  } else {
    await prisma.$executeRawUnsafe('INSERT INTO "InterviewRoundFeedback" ("id","applicationId","round","roundType","technical","communication","experience","roleFit","details","overall","recommendation","legacy","byId","byName","at","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)',
      newId('irf'), applicationId, Number(round), value.roundType, value.technical, value.communication, value.experience, value.roleFit, d, value.overall, value.recommendation, user.id, user.name, t, t);
  }
  await prisma.$executeRawUnsafe('INSERT INTO "InterviewRound" ("applicationId","round","roundType","status","createdAt","updatedAt") VALUES (?,?,?,?,?,?) ON CONFLICT("applicationId","round") DO UPDATE SET "roundType"=excluded."roundType","updatedAt"=excluded."updatedAt"',
    applicationId, Number(round), value.roundType, 'FEEDBACK_SUBMITTED', t, t);
}
async function addAttachment(applicationId, round, a, user) {
  await ensure();
  const id = newId('iat');
  await prisma.$executeRawUnsafe('INSERT INTO "InterviewAttachment" ("id","applicationId","round","kind","title","url","fileStored","fileName","fileMime","fileSize","note","byId","byName","at") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, applicationId, Number(round), a.kind, txt(a.title, 120), txt(a.url, 500), a.fileStored || null, a.fileName || null, a.fileMime || null, a.fileSize || null, txt(a.note, 2000), user.id, user.name, now());
  return id;
}
async function attachmentRow(id) {
  await ensure();
  const [r] = await prisma.$queryRawUnsafe('SELECT * FROM "InterviewAttachment" WHERE "id" = ?', String(id));
  return r || null;
}
async function removeAttachment(id) {
  await ensure();
  await prisma.$executeRawUnsafe('DELETE FROM "InterviewAttachment" WHERE "id" = ?', String(id));
}
// The recording / notes link must be https.
function checkAttachmentUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) return { error: 'Paste the link.' };
  if (/\s/.test(url) || url.length > 500) return { error: 'That link does not look right.' };
  let u; try { u = new URL(url); } catch { return { error: 'That does not look like a link.' }; }
  if (u.protocol !== 'https:' || !u.hostname.includes('.')) return { error: 'The link should start with https://.' };
  return { url };
}

// 244: rate an interviewer after a round (1-5 + comment). One rating per rater per interviewer per round (a second one replaces it).
async function rateInterviewer(applicationId, round, who, rating, comment, user) {
  await ensure();
  const r = Number(rating);
  if (!Number.isInteger(r) || r < 1 || r > 5) return { error: 'Give a rating from 1 to 5.' };
  const key = who.userId ? `u:${who.userId}` : `n:${String(who.name || '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
  if (!who.name) return { error: 'Say which interviewer.' };
  await prisma.$executeRawUnsafe(`INSERT INTO "InterviewerRating" ("id","applicationId","round","interviewerKey","interviewerId","interviewerName","rating","comment","byId","byName","at") VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT("applicationId","round","interviewerKey","byId") DO UPDATE SET "rating"=excluded."rating","comment"=excluded."comment","at"=excluded."at"`,
  newId('irt'), applicationId, Number(round), key, who.userId || null, String(who.name).slice(0, 120), r, txt(comment, 500), user.id, user.name, now());
  return { ok: true, key, rating: r };
}
// Average per interviewer: [{ key, interviewerId, name, average, count, recent:[{rating, comment, by, at}] }], or one person's.
async function interviewerSummary({ userId, name } = {}) {
  await ensure();
  const key = userId ? `u:${userId}` : (name ? `n:${String(name).toLowerCase().replace(/\s+/g, ' ').trim()}` : null);
  const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "InterviewerRating" ${key ? 'WHERE "interviewerKey" = ?' : ''} ORDER BY "at" DESC`, ...(key ? [key] : []));
  const by = new Map();
  rows.forEach((r) => {
    const g = by.get(r.interviewerKey) || { key: r.interviewerKey, interviewerId: r.interviewerId, name: r.interviewerName, sum: 0, count: 0, recent: [] };
    g.sum += N(r.rating); g.count += 1;
    if (g.recent.length < 5) g.recent.push({ rating: N(r.rating), comment: r.comment, by: r.byName, at: r.at });
    by.set(r.interviewerKey, g);
  });
  return [...by.values()].map((g) => ({ key: g.key, interviewerId: g.interviewerId, name: g.name, average: Math.round((g.sum / g.count) * 10) / 10, count: g.count, recent: g.recent }))
    .sort((a, b) => b.count - a.count);
}

module.exports = {
  ROUND_TYPES, RECS, PROVIDERS, MAX_FILE, ensure, checkMeetingLink, cleanFeedback, averageOf, importLegacy, noteBooking, setRoundType, roundsOf, suggestedDecision,
  saveFeedback, addAttachment, attachmentRow, removeAttachment, checkAttachmentUrl, rateInterviewer, interviewerSummary,
};
