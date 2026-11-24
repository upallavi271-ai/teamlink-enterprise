// ---------------------------------------------------------------------------
// MARKET WAVE C - INTERVIEWS (07.01 / 07.03 / 07.05 / 07.07 / 07.09 / 07.10 / 07.11 / 07.12 / 07.13)
//   kits        per job and round: the questions to ask, how each is rated (scale 3 / 4 / 5 / 10), a short guide
//   scorecards  each interviewer fills the kit for their round (one card per person per round)
//   briefing    one page for the interviewer: who the person is (no contact, no pay for the BDE team), the kit, the past rounds
//   recordings  a file / link / voice note per round; reviewers comment on it (with the minute)
//   notes       transcript -> AI notes (summary, strengths, concerns, questions asked, next steps); code notes when the model is down
//   summary     every rating, recommendation and note of the interview in one short paragraph
//   slots       free times for the interviewers and the candidate (other interviews + their connected calendar's busy times)
//   replace     who could take an interview when an interviewer declines
//   self-book   a signed link with a few times the candidate picks from (OFF by default; also needs the job's own tick)
//   calendar    a private ICS feed per person (subscribe in Google / Outlook), the .ics of one interview,
//               and the per-person Google / Microsoft calendar connection (OAuth; needs the founder's app keys)
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const C = require('./core');

const { q, x, nowIso, newId, txt, json } = C;
const SCALES = [3, 4, 5, 10];
const QTYPES = ['rating', 'text', 'yesno'];
const RECS = ['Strong yes', 'Yes', 'Maybe', 'No', 'Strong no'];
const IST = '+05:30';

// ---------------------------------------------------------------- kits (07.09)
const skillsOf = (r) => String((r && r.skills) || '').split(',').map((s) => s.trim()).filter(Boolean);
function defaultKit(r, round = 1, roundType = null) {
  const type = roundType || (round === 1 ? 'Technical' : round === 2 ? 'Management' : 'HR');
  const sk = skillsOf(r).slice(0, 4);
  const questions = [];
  if (type === 'HR') {
    questions.push(
      { text: 'Why are you looking for a change now?', type: 'text', competency: 'Motivation', guidance: 'A clear, positive reason; not only money.' },
      { text: 'Notice period, earliest joining date and any offer in hand', type: 'text', competency: 'Availability', guidance: 'Exact days; buy-out possible?' },
      { text: 'Communication and attitude', type: 'rating', competency: 'Communication', guidance: 'Clear, polite, listens.' },
    );
  } else {
    sk.forEach((s) => questions.push({ text: `Tell me about a real piece of work where you used ${s}. What did you do yourself?`, type: 'rating', competency: s, guidance: `Look for hands-on ${s} detail, not only names of tools.` }));
    if (!sk.length) questions.push({ text: 'Walk me through the most relevant work you did for this role.', type: 'rating', competency: 'Role skills', guidance: 'Specific, recent and their own work.' });
    questions.push(
      { text: 'Describe a hard problem you solved at work and how.', type: 'rating', competency: 'Problem solving', guidance: 'Structured thinking; what they would do differently.' },
      { text: 'Communication', type: 'rating', competency: 'Communication', guidance: 'Clear answers, asks good questions.' },
    );
  }
  questions.push({ text: 'Fit for this role overall', type: 'rating', competency: 'Role fit', guidance: `Compare with the job: ${String((r && r.title) || 'this role').slice(0, 80)}.` });
  return { requirementId: r && r.id, round, roundType: type, title: `Round ${round} - ${type}`, questions, scale: 5, guide: 'Rate each question; write one line of evidence for every low or high score.', saved: false };
}
const shapeKit = (row) => ({ id: row.id, requirementId: row.requirementId, round: Number(row.round), roundType: row.roundType, title: row.title, questions: json(row.questions, []), scale: Number(row.scale) || 5, guide: row.guide, updatedAt: row.updatedAt, updatedBy: row.updatedBy, saved: true });

async function kitFor(requirement, round) {
  await C.ensure();
  const rows = await q('SELECT * FROM "MktKit" WHERE "requirementId" = ? AND "round" IN (?, 1) ORDER BY "round" DESC', requirement.id, round);
  const exact = rows.find((r) => Number(r.round) === Number(round));
  if (exact) return shapeKit(exact);
  return defaultKit(requirement, round);
}
async function listKits(requirement) {
  await C.ensure();
  const rows = (await q('SELECT * FROM "MktKit" WHERE "requirementId" = ? ORDER BY "round"', requirement.id)).map(shapeKit);
  const max = Math.max(2, ...rows.map((r) => r.round));
  const out = [];
  for (let n = 1; n <= max; n += 1) out.push(rows.find((r) => r.round === n) || defaultKit(requirement, n));
  return out;
}
function cleanKit(b) {
  const questions = (Array.isArray(b.questions) ? b.questions : []).map((qq) => ({
    text: txt(qq && qq.text, 300), type: QTYPES.includes(qq && qq.type) ? qq.type : 'rating', competency: txt(qq && qq.competency, 60) || null, guidance: txt(qq && qq.guidance, 300) || null,
  })).filter((qq) => qq.text);
  if (!questions.length) return { error: 'Add at least one question.' };
  if (questions.length > 25) return { error: 'At most 25 questions in one kit.' };
  const scale = Number(b.scale) || 5;
  if (!SCALES.includes(scale)) return { error: 'Pick a rating scale of 3, 4, 5 or 10.' };
  return { value: { title: txt(b.title, 120) || null, roundType: txt(b.roundType, 40) || null, questions, scale, guide: txt(b.guide, 1000) || null } };
}
async function saveKit(requirement, round, b, user) {
  await C.ensure();
  const v = cleanKit(b || {});
  if (v.error) return { status: 400, error: v.error };
  const k = v.value; const t = nowIso();
  await x(`INSERT INTO "MktKit" ("id","requirementId","round","roundType","title","questions","scale","guide","updatedAt","updatedBy") VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT("requirementId","round") DO UPDATE SET "roundType"=excluded."roundType","title"=excluded."title","questions"=excluded."questions","scale"=excluded."scale","guide"=excluded."guide","updatedAt"=excluded."updatedAt","updatedBy"=excluded."updatedBy"`,
  newId(), requirement.id, round, k.roundType, k.title, JSON.stringify(k.questions), k.scale, k.guide, t, C.who(user));
  return { kit: await kitFor(requirement, round) };
}
async function removeKit(requirement, round) { await C.ensure(); await x('DELETE FROM "MktKit" WHERE "requirementId" = ? AND "round" = ?', requirement.id, round); }
// AI kit from the JD (the client's name never goes to the model); the code kit when the model is not there
async function suggestKit(requirement, round, roundType) {
  const base = defaultKit(requirement, round, roundType);
  const clientName = requirement.client && requirement.client.name;
  const jd = C.maskPii([requirement.title, requirement.skills, requirement.experience, requirement.jobDescription || requirement.description].filter(Boolean).join('\n'), [clientName]).slice(0, 5000);
  const ai = await C.aiJson('You write interview kits for recruiters in India. Answer JSON only: {"questions":[{"text":"...","type":"rating|text|yesno","competency":"...","guidance":"what a good answer shows"}]}. 5 to 8 questions, short plain English, about the job only, never about age, religion, caste, marriage or health.',
    `Round ${round} (${base.roundType}). Job:\n${jd}`);
  const list = ai && Array.isArray(ai.value.questions) ? ai.value.questions : null;
  if (list && list.length) {
    const v = cleanKit({ questions: list.slice(0, 10), scale: 5 });
    if (v.value) return { kit: { ...base, questions: v.value.questions, source: ai.provider }, ai: true };
  }
  return { kit: { ...base, source: 'TeamLink (from the job skills)' }, ai: false };
}

// ---------------------------------------------------------------- scorecards (07.09)
const shapeScore = (r) => ({ id: r.id, round: Number(r.round), userId: r.userId, userName: r.userName, answers: json(r.answers, []), overall: r.overall == null ? null : Number(r.overall), recommendation: r.recommendation, summary: r.summary, via: r.via, updatedAt: r.updatedAt });
async function scoresOf(applicationId, round = null) {
  await C.ensure();
  const rows = round ? await q('SELECT * FROM "MktScore" WHERE "applicationId" = ? AND "round" = ? ORDER BY "updatedAt"', applicationId, round) : await q('SELECT * FROM "MktScore" WHERE "applicationId" = ? ORDER BY "round","updatedAt"', applicationId);
  return rows.map(shapeScore);
}
async function saveScore(app, round, b, user, via = 'scorecard') {
  await C.ensure();
  const kit = await kitFor(app.requirement, round);
  const given = Array.isArray(b.answers) ? b.answers : [];
  const answers = kit.questions.map((qq, i) => {
    const a = given.find((g) => Number(g && g.i) === i) || given[i] || {};
    let rating = a.rating == null || a.rating === '' ? null : Number(a.rating);
    if (qq.type === 'rating' && rating != null && !(Number.isInteger(rating) && rating >= 1 && rating <= kit.scale)) rating = NaN;
    if (qq.type === 'yesno') rating = a.rating === true || a.rating === 'yes' ? 1 : (a.rating === false || a.rating === 'no' ? 0 : null);
    return { i, q: qq.text, type: qq.type, rating: qq.type === 'text' ? null : rating, note: txt(a.note, 600) || null };
  });
  if (answers.some((a) => Number.isNaN(a.rating))) return { status: 400, error: `Each rating is a whole number from 1 to ${kit.scale}.` };
  const rated = answers.filter((a) => a.type === 'rating' && a.rating != null);
  const rec = RECS.includes(b.recommendation) ? b.recommendation : null;
  if (!rated.length && !rec && !txt(b.summary)) return { status: 400, error: 'Rate at least one question, or give your recommendation.' };
  // overall on a 1-5 scale whatever the kit's scale, so rounds compare
  const overall = rated.length ? Math.round((rated.reduce((s, a) => s + a.rating, 0) / rated.length) * (5 / kit.scale) * 10) / 10 : null;
  const t = nowIso();
  await x(`INSERT INTO "MktScore" ("id","applicationId","round","userId","userName","answers","overall","recommendation","summary","via","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT("applicationId","round","userId") DO UPDATE SET "answers"=excluded."answers","overall"=excluded."overall","recommendation"=excluded."recommendation","summary"=COALESCE(excluded."summary","MktScore"."summary"),"via"=excluded."via","updatedAt"=excluded."updatedAt"`,
  newId(), app.id, round, user.id, C.who(user), JSON.stringify(answers), overall, rec, txt(b.summary, 3000) || null, via, t, t);
  return { score: (await scoresOf(app.id, round)).find((s) => s.userId === user.id), kit };
}

// ---------------------------------------------------------------- recordings, peer review, notes, voice (07.07 / 07.11 / 07.13)
const shapeRec = (r, reviews = []) => ({
  id: r.id, round: Number(r.round), kind: r.kind, title: r.title, url: r.url, fileName: r.fileName, fileMime: r.fileMime, fileSize: Number(r.fileSize) || 0, hasFile: !!r.fileStored,
  transcript: r.transcript, transcriptSource: r.transcriptSource, notes: json(r.notes, null), createdBy: r.createdBy, createdById: r.createdById, createdAt: r.createdAt,
  reviews: reviews.filter((v) => v.recordingId === r.id).map((v) => ({ id: v.id, userName: v.userName, userId: v.userId, atSec: v.atSec == null ? null : Number(v.atSec), comment: v.comment, rating: v.rating == null ? null : Number(v.rating), createdAt: v.createdAt })),
});
async function recordingsOf(applicationId) {
  await C.ensure();
  const rows = await q('SELECT * FROM "MktRecording" WHERE "applicationId" = ? ORDER BY "createdAt" DESC', applicationId);
  const reviews = rows.length ? await q(`SELECT * FROM "MktReview" WHERE "recordingId" IN (${rows.map(() => '?').join(',')}) ORDER BY "createdAt"`, ...rows.map((r) => r.id)) : [];
  return rows.map((r) => shapeRec(r, reviews));
}
async function recordingRow(id) { await C.ensure(); return (await q('SELECT * FROM "MktRecording" WHERE "id" = ?', String(id)))[0] || null; }
async function addRecording(appId, row, user) {
  await C.ensure();
  const id = newId();
  await x(`INSERT INTO "MktRecording" ("id","applicationId","round","kind","title","fileStored","fileName","fileMime","fileSize","url","transcript","transcriptSource","notes","createdBy","createdById","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, appId, row.round || 1, row.kind, txt(row.title, 160) || null, row.fileStored || null, row.fileName || null, row.fileMime || null, row.fileSize || null, row.url || null,
    row.transcript ? txt(row.transcript, 200000) : null, row.transcript ? (row.transcriptSource || 'Typed / pasted') : null, null, C.who(user), user.id, nowIso());
  return id;
}
async function addReview(recId, b, user) {
  const comment = txt(b.comment, 2000);
  if (!comment) return { status: 400, error: 'Write your comment.' };
  let atSec = null;
  if (b.at !== undefined && b.at !== null && b.at !== '') {
    const m = /^(\d{1,3}):([0-5]\d)$/.exec(String(b.at).trim());
    atSec = m ? Number(m[1]) * 60 + Number(m[2]) : (Number.isFinite(Number(b.at)) ? Math.max(0, Math.round(Number(b.at))) : null);
    if (atSec === null) return { status: 400, error: 'Write the time in the recording as mm:ss, e.g. 12:30.' };
  }
  const rating = b.rating == null || b.rating === '' ? null : Number(b.rating);
  if (rating !== null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) return { status: 400, error: 'Rating is 1 to 5.' };
  await x('INSERT INTO "MktReview" ("id","recordingId","userId","userName","atSec","comment","rating","createdAt") VALUES (?,?,?,?,?,?,?,?)', newId(), recId, user.id, C.who(user), atSec, comment, rating, nowIso());
  return { ok: true };
}
async function setTranscript(recId, text, source) {
  await x('UPDATE "MktRecording" SET "transcript" = ?, "transcriptSource" = ? WHERE "id" = ?', txt(text, 200000), source, recId);
}

// the notetaker: AI notes from the transcript; the code notes pick the lines that carry the signal
const STRONG = /\b(led|built|designed|delivered|improved|reduced|increased|owned|managed|automated|launched|achieved|solved)\b/i;
const WEAK = /\b(not sure|don't know|do not know|never used|no experience|haven't|have not|struggle|weak|confus)\b/i;
const QUESTION = /\?\s*$/;
function codeNotes(transcript) {
  const sentences = String(transcript || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 12);
  const pick = (re, n) => sentences.filter((s) => re.test(s)).slice(0, n);
  const strengths = pick(STRONG, 5);
  const concerns = pick(WEAK, 5);
  const questions = sentences.filter((s) => QUESTION.test(s)).slice(0, 8);
  const summary = sentences.slice(0, 3).join(' ').slice(0, 600);
  return { summary: summary || 'The transcript is too short for notes.', strengths, concerns, questionsAsked: questions, nextSteps: [], source: 'TeamLink (from the transcript, no AI)' };
}
async function makeNotes(rec, names) {
  const t = String(rec.transcript || '').trim();
  if (t.length < 40) return { status: 400, error: 'Add the transcript first (paste it, or turn the recording into text).' };
  const masked = C.maskPii(t, names).slice(0, 12000);
  const ai = await C.aiJson('You are an interview notetaker. From the transcript write JSON only: {"summary":"3-4 sentences","strengths":["..."],"concerns":["..."],"questionsAsked":["..."],"nextSteps":["..."]}. Facts from the transcript only; do not judge age, gender, religion, caste, accent or health.', masked, { maxTokens: 900 });
  let notes;
  if (ai && ai.value && ai.value.summary) {
    const arr = (v) => (Array.isArray(v) ? v.map((s) => txt(s, 300)).filter(Boolean).slice(0, 8) : []);
    notes = { summary: txt(ai.value.summary, 1500), strengths: arr(ai.value.strengths), concerns: arr(ai.value.concerns), questionsAsked: arr(ai.value.questionsAsked), nextSteps: arr(ai.value.nextSteps), source: `AI (${ai.provider})` };
  } else notes = codeNotes(t);
  // ATS wave 2 Y (07.11): the notes mapped to the round's scorecard questions (utils/atsY/notetaker.js; AI masked, code lines when down)
  try {
    const app = await prisma.application.findUnique({ where: { id: rec.applicationId }, include: { requirement: true } });
    if (app && app.requirement) {
      const m = await require('../atsY/notetaker').mapToKit(t, await kitFor(app.requirement, Number(rec.round) || 1), names); // eslint-disable-line global-require
      if (m.rows.length) { notes.byQuestion = m.rows; notes.byQuestionSource = m.source; }
    }
  } catch { /* the notes stand without the mapping */ }
  notes.madeAt = nowIso();
  await x('UPDATE "MktRecording" SET "notes" = ? WHERE "id" = ?', JSON.stringify(notes), rec.id);
  return { notes };
}

// ---------------------------------------------------------------- feedback summary (07.12)
async function feedbackSummary(app, { names = [] } = {}) {
  const IR = require('../interviewRounds'); // eslint-disable-line global-require
  const rounds = await IR.roundsOf(app).catch(() => []);
  const scores = await scoresOf(app.id);
  const panel = await prisma.interviewPanelist.findMany({ where: { applicationId: app.id } }).catch(() => []);
  const legacy = await prisma.interviewFeedback.findMany({ where: { applicationId: app.id } }).catch(() => []);
  const recs = await recordingsOf(app.id);
  const items = [];
  rounds.forEach((r) => { if (r.feedback) items.push({ round: r.round, who: r.feedback.byName || 'Interviewer', rating: r.feedback.average, rec: r.feedback.recommendation, note: r.feedback.overall }); });
  scores.forEach((s) => items.push({ round: s.round, who: s.userName, rating: s.overall, rec: s.recommendation, note: [s.summary, ...s.answers.filter((a) => a.note).map((a) => `${a.q}: ${a.note}`)].filter(Boolean).join(' | ') }));
  panel.filter((p) => p.feedbackAt).forEach((p) => {
    const vals = [p.technical, p.communication, p.experience, p.roleFit].filter((v) => v != null);
    items.push({ round: p.round || 1, who: p.name, rating: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null, rec: p.recommendation, note: p.overall });
  });
  legacy.filter((l) => l.kind === 'Client').forEach((l) => items.push({ round: app.interviewRound || 1, who: 'Client', rating: null, rec: l.recommendation, note: l.overall }));
  recs.filter((r) => r.notes).forEach((r) => items.push({ round: r.round, who: `Notes of ${r.title || r.kind}`, rating: null, rec: null, note: [r.notes.summary, ...(r.notes.concerns || []).map((c) => `Concern: ${c}`)].join(' ') }));
  if (!items.length) return { summary: null, items: [], text: 'No feedback yet: nothing to sum up.', source: null };
  const ratings = items.map((i) => i.rating).filter((v) => v != null && !Number.isNaN(Number(v))).map(Number);
  const avg = ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null;
  const tally = {};
  items.forEach((i) => { if (i.rec) tally[i.rec] = (tally[i.rec] || 0) + 1; });
  const yes = Object.entries(tally).filter(([k]) => /yes|select|hire|strong/i.test(k) && !/no/i.test(k)).reduce((s, [, n]) => s + n, 0);
  const no = Object.entries(tally).filter(([k]) => /\bno\b|reject|strong no/i.test(k)).reduce((s, [, n]) => s + n, 0);
  const lean = yes > no ? 'leans towards hiring' : (no > yes ? 'leans against hiring' : 'is split / not decided');
  const codeText = `${items.length} feedback entr${items.length === 1 ? 'y' : 'ies'} over ${new Set(items.map((i) => i.round)).size} round(s). Average rating ${avg == null ? 'not given' : `${avg} of 5`}. Recommendations: ${Object.entries(tally).map(([k, n]) => `${k} ${n}`).join(', ') || 'none yet'}. The panel ${lean}.`;
  const facts = items.map((i) => `Round ${i.round}, ${i.who === 'Client' ? 'client' : 'interviewer'}: rating ${i.rating == null ? '-' : i.rating}, recommendation ${i.rec || '-'}. ${C.maskPii(String(i.note || ''), names).slice(0, 500)}`).join('\n');
  const ai = await C.aiText('Summarise interview feedback for a hiring decision in 4-6 short plain-English sentences: where the panel agrees, where it differs, the main strengths and the main concerns. Use only the facts given. Never mention age, gender, religion, caste or health. Do not decide; say what the panel leans to.', `${codeText}\n${facts}`, { maxTokens: 400 });
  return { items: items.map((i) => ({ ...i, note: i.note ? String(i.note).slice(0, 600) : null })), average: avg, tally, lean, codeText, text: ai ? ai.text : codeText, source: ai ? `AI (${ai.provider})` : 'TeamLink (from the ratings, no AI)' };
}

// ---------------------------------------------------------------- slots (07.05)
const istDay = (d) => new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
const atIst = (day, hm) => new Date(`${day}T${hm}:00${IST}`);
async function interviewerKeys(app) {
  const panel = await prisma.interviewPanelist.findMany({ where: { applicationId: app.id, round: app.interviewRound || 1 } }).catch(() => []);
  const ids = panel.map((p) => p.userId).filter(Boolean);
  const names = [...panel.map((p) => p.name), ...String(app.interviewer || '').split(',')].map((s) => String(s || '').trim()).filter(Boolean);
  return { ids: [...new Set(ids)], names: [...new Set(names)] };
}
async function busyTimes(app, { from, to, ids, names }) {
  const LIVE = ['SCHEDULED', 'CONFIRMED', 'STARTED', 'RESCHEDULED'];
  const busy = [];
  const others = await prisma.application.findMany({
    where: { id: { not: app.id }, interviewStatus: { in: LIVE }, interviewAt: { gte: new Date(from.getTime() - 3600e3), lte: to } },
    select: { id: true, candidateId: true, interviewAt: true, interviewer: true, interviewPanelists: { select: { userId: true, name: true } } },
    take: 3000,
  }).catch(async () => prisma.application.findMany({ where: { id: { not: app.id }, interviewStatus: { in: LIVE }, interviewAt: { gte: from, lte: to } }, select: { id: true, candidateId: true, interviewAt: true, interviewer: true }, take: 3000 }));
  const lname = new Set(names.map((n) => n.toLowerCase()));
  others.forEach((o) => {
    const theirNames = [...String(o.interviewer || '').split(','), ...((o.interviewPanelists || []).map((p) => p.name))].map((s) => s.trim().toLowerCase()).filter(Boolean);
    const theirIds = (o.interviewPanelists || []).map((p) => p.userId).filter(Boolean);
    const who = o.candidateId === app.candidateId ? 'the candidate' : (theirIds.some((i) => ids.includes(i)) || theirNames.some((n) => lname.has(n)) ? 'an interviewer' : null);
    if (who) busy.push({ start: new Date(o.interviewAt), end: new Date(new Date(o.interviewAt).getTime() + 60 * 60000), who });
  });
  for (const uid of ids) {
    // eslint-disable-next-line no-await-in-loop
    const cal = await calendarBusy(uid, from, to).catch(() => []);
    cal.forEach((b) => busy.push({ ...b, who: 'an interviewer (calendar)' }));
  }
  return busy;
}
async function suggestSlots(app, { days = 5, minutes = 45, count = 6, from = null } = {}) {
  const mins = [30, 45, 60, 90].includes(Number(minutes)) ? Number(minutes) : 45;
  const start = from ? new Date(from) : new Date(Date.now() + 2 * 3600e3);
  const end = new Date(start.getTime() + Math.min(Math.max(Number(days) || 5, 1), 14) * 86400e3);
  const keys = await interviewerKeys(app);
  const busy = await busyTimes(app, { from: start, to: end, ...keys });
  const out = [];
  const HOURS = ['10:00', '11:00', '12:00', '14:30', '15:30', '16:30', '17:30'];
  for (let d = 0; d < 15 && out.length < count * 3; d += 1) {
    const day = istDay(new Date(start.getTime() + d * 86400e3));
    const wd = new Date(`${day}T12:00:00${IST}`).getUTCDay();
    if (wd === 0) continue; // eslint-disable-line no-continue
    for (const hm of HOURS) {
      const s = atIst(day, hm); const e = new Date(s.getTime() + mins * 60000);
      if (s < start || s > end) continue; // eslint-disable-line no-continue
      const clash = busy.find((b) => s < new Date(b.end.getTime() + 15 * 60000) && e > new Date(b.start.getTime() - 15 * 60000));
      if (clash) continue; // eslint-disable-line no-continue
      // score: sooner is better, late morning and mid afternoon are the most accepted times, Saturday a little less
      const score = 100 - d * 6 - (hm === '10:00' || hm === '17:30' ? 6 : 0) - (wd === 6 ? 10 : 0);
      out.push({ start: s.toISOString(), end: e.toISOString(), day, time: hm, score });
    }
  }
  // spread over days: the best one or two of each day first
  const byDay = {};
  out.sort((a, b) => b.score - a.score).forEach((s) => { (byDay[s.day] = byDay[s.day] || []).push(s); });
  const picked = [];
  for (let round = 0; round < 3 && picked.length < count; round += 1) Object.keys(byDay).sort().forEach((d) => { if (byDay[d][round] && picked.length < count) picked.push(byDay[d][round]); });
  picked.sort((a, b) => a.start.localeCompare(b.start));
  return { slots: picked, minutes: mins, checked: { interviewers: keys.names, busyCount: busy.length }, reason: `Free for ${keys.names.length ? keys.names.join(', ') : 'the interviewer'} and the candidate (other interviews${keys.ids.length ? ' and connected calendars' : ''} checked, 15 minutes kept between).` };
}
// an interviewer declined: who could take it at the same time (staff who interview, not already busy then)
async function replacements(app, { declined = '' } = {}) {
  const at = app.interviewAt ? new Date(app.interviewAt) : null;
  const staff = await prisma.user.findMany({ where: { status: 'Active', role: { notIn: ['CANDIDATE', 'CLIENT'] }, atsAccess: true }, select: { id: true, name: true, atsRole: true, atsDepartment: true }, take: 400 });
  const past = await prisma.interviewPanelist.groupBy({ by: ['userId'], where: { userId: { not: null } }, _count: { _all: true } }).catch(() => []);
  const pastMap = new Map(past.map((p) => [p.userId, p._count._all]));
  const dept = app.requirement && app.requirement.department;
  const keys = await interviewerKeys(app);
  const sameTime = at ? await busyTimes(app, { from: new Date(at.getTime() - 3600e3), to: new Date(at.getTime() + 3600e3), ids: [], names: [] }) : [];
  void sameTime;
  const busyIds = new Set();
  if (at) {
    const near = await prisma.interviewPanelist.findMany({ where: { application: { interviewAt: { gte: new Date(at.getTime() - 3600e3), lte: new Date(at.getTime() + 3600e3) }, interviewStatus: { in: ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED'] } } }, select: { userId: true } }).catch(() => []);
    near.forEach((n) => n.userId && busyIds.add(n.userId));
  }
  const dl = String(declined || '').toLowerCase();
  const rows = staff.filter((u) => !keys.ids.includes(u.id) && !keys.names.map((n) => n.toLowerCase()).includes(String(u.name).toLowerCase()) && String(u.name).toLowerCase() !== dl && !busyIds.has(u.id))
    .map((u) => ({ id: u.id, name: u.name, role: u.atsRole, department: u.atsDepartment, interviewsTaken: pastMap.get(u.id) || 0, score: (u.atsDepartment && u.atsDepartment === dept ? 50 : 0) + Math.min(pastMap.get(u.id) || 0, 40) }))
    .sort((a, b) => b.score - a.score).slice(0, 6)
    .map((r) => ({ ...r, why: [r.department === dept ? `same department (${dept})` : null, r.interviewsTaken ? `has taken ${r.interviewsTaken} interview(s)` : null, 'free at that time'].filter(Boolean).join(', ') }));
  return { at: at && at.toISOString(), rows };
}

// ---------------------------------------------------------------- self-scheduling (07.03)
async function jobSettings(requirementId) {
  await C.ensure();
  const r = (await q('SELECT * FROM "MktJobForm" WHERE "requirementId" = ?', requirementId))[0];
  return { fields: json(r && r.fields, []), linkedinApply: r ? Number(r.linkedinApply) === 1 : true, selfBook: r ? Number(r.selfBook) === 1 : false };
}
async function setJobSetting(requirementId, patch, user) {
  await C.ensure();
  const cur = await jobSettings(requirementId);
  const next = { ...cur, ...patch };
  await x(`INSERT INTO "MktJobForm" ("requirementId","fields","linkedinApply","selfBook","updatedAt","updatedBy") VALUES (?,?,?,?,?,?)
    ON CONFLICT("requirementId") DO UPDATE SET "fields"=excluded."fields","linkedinApply"=excluded."linkedinApply","selfBook"=excluded."selfBook","updatedAt"=excluded."updatedAt","updatedBy"=excluded."updatedBy"`,
  requirementId, JSON.stringify(next.fields || []), next.linkedinApply ? 1 : 0, next.selfBook ? 1 : 0, nowIso(), C.who(user));
  return jobSettings(requirementId);
}
async function createSelfBook(app, b, user) {
  if (!(await C.switchOn('selfScheduling'))) return { status: 409, error: C.SWITCH_OFF('selfScheduling') };
  if (!(await jobSettings(app.requirementId)).selfBook) return { status: 409, error: 'Self-scheduling is off for this job. Tick "Candidates may pick their own interview time" on the requirement (Kits & tests tab).' };
  let slots = (Array.isArray(b.slots) ? b.slots : []).map((s) => new Date(s)).filter((d) => !Number.isNaN(d.getTime()) && d.getTime() > Date.now() + 30 * 60000);
  const minutes = [30, 45, 60, 90].includes(Number(b.minutes)) ? Number(b.minutes) : 45;
  if (!slots.length) slots = (await suggestSlots(app, { minutes })).slots.map((s) => new Date(s.start));
  if (!slots.length) return { status: 400, error: 'No free times were found. Pick the times yourself.' };
  if (slots.length > 12) return { status: 400, error: 'At most 12 times in one link.' };
  const mode = ['Online', 'In Person'].includes(b.mode) ? b.mode : (app.interviewMode || 'Online');
  const interviewer = txt(b.interviewer || app.interviewer, 120);
  if (!interviewer) return { status: 400, error: 'Add who will take the interview first (the panel), so the booking is complete.' };
  await C.ensure();
  await x('UPDATE "MktSelfBook" SET "status" = \'replaced\' WHERE "applicationId" = ? AND "status" = \'open\'', app.id);
  const token = C.randToken(18);
  const exp = new Date(Date.now() + Math.min(Math.max(Number(b.expiresDays) || 3, 1), 14) * 86400e3).toISOString();
  const round = Number(b.round) || (app.interviewStatus === 'FEEDBACK_SUBMITTED' ? (app.interviewRound || 1) + 1 : (app.interviewRound || 1));
  await x('INSERT INTO "MktSelfBook" ("token","applicationId","round","slots","minutes","mode","status","createdBy","createdById","createdAt","expiresAt") VALUES (?,?,?,?,?,?,\'open\',?,?,?,?)',
    token, app.id, round, JSON.stringify({ slots: slots.map((d) => d.toISOString()).sort(), interviewer, location: txt(b.location, 300) || null, meetingLink: txt(b.meetingLink, 500) || null }), minutes, mode, C.who(user), user.id, nowIso(), exp);
  return { token, expiresAt: exp, slots: slots.map((d) => d.toISOString()).sort(), minutes, mode };
}
async function selfBookRow(token) { await C.ensure(); return (await q('SELECT * FROM "MktSelfBook" WHERE "token" = ?', String(token || '').slice(0, 64)))[0] || null; }
async function selfBooksOf(appId) { await C.ensure(); return (await q('SELECT * FROM "MktSelfBook" WHERE "applicationId" = ? ORDER BY "createdAt" DESC LIMIT 10', appId)).map((r) => ({ token: r.token, status: r.status, slots: json(r.slots, {}).slots || [], pickedSlot: r.pickedSlot, pickedAt: r.pickedAt, createdBy: r.createdBy, createdAt: r.createdAt, expiresAt: r.expiresAt, minutes: Number(r.minutes) })); }

// the candidate picked a time: the booking runs through the SAME route a recruiter uses (POST /api/ats/interviews/:id/book or
// /reschedule) as the person who made the link, on this server (loopback), so every rule, message and reminder is the usual one.
async function asUser(userId, method, path, body) {
  const jwt = require('jsonwebtoken'); // eslint-disable-line global-require
  const { resolveIdentity, tokenPayload } = require('../identity'); // eslint-disable-line global-require
  const ident = await resolveIdentity(userId);
  if (!ident) return { status: 403, body: { error: 'The person who sent the link has no login any more.' } };
  const tok = jwt.sign({ ...tokenPayload(ident), tms: Date.now() }, process.env.JWT_SECRET, { expiresIn: '2m' });
  const r = await fetch(`http://127.0.0.1:${process.env.PORT || 4000}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify(body || {}) });
  let j = null; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, body: j };
}
async function pickSelfBook(row, slotIso) {
  if (row.status !== 'open') return { status: 409, error: row.status === 'booked' ? 'This link was already used to book a time.' : 'This link is no longer active. Ask the recruiter for a new one.' };
  if (new Date(row.expiresAt) < new Date()) return { status: 410, error: 'This link has expired. Ask the recruiter for a new one.' };
  const meta = json(row.slots, {});
  const slot = (meta.slots || []).find((s) => s === slotIso);
  if (!slot) return { status: 400, error: 'Pick one of the times shown.' };
  if (new Date(slot).getTime() < Date.now() + 15 * 60000) return { status: 400, error: 'That time is too soon now. Pick a later one.' };
  // claim the link first (two clicks never book twice)
  const n = await x('UPDATE "MktSelfBook" SET "status" = \'booking\' WHERE "token" = ? AND "status" = \'open\'', row.token);
  if (!n) return { status: 409, error: 'This link was already used.' };
  const app = await prisma.application.findUnique({ where: { id: row.applicationId }, select: { id: true, interviewStatus: true, interviewAt: true, stage: true } });
  const ist = new Date(new Date(slot).getTime() + 5.5 * 3600e3).toISOString();
  const live = ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED'].includes(app && app.interviewStatus);
  const res = live
    ? await asUser(row.createdById, 'POST', `/ats/interviews/${row.applicationId}/reschedule`, { interviewAt: slot, reason: 'The candidate picked a new time from the self-scheduling link' })
    : await asUser(row.createdById, 'POST', `/ats/interviews/${row.applicationId}/book`, { date: ist.slice(0, 10), time: ist.slice(11, 16), mode: row.mode === 'In Person' ? 'in person' : 'online', interviewer: meta.interviewer, location: meta.location || undefined, meetingLink: meta.meetingLink || undefined, round: Number(row.round) || undefined });
  if (res.status !== 200) {
    await x('UPDATE "MktSelfBook" SET "status" = \'open\' WHERE "token" = ?', row.token);
    return { status: 409, error: 'That time could not be booked just now. The team has been told and will confirm with you.', detail: res.body && res.body.error };
  }
  await x('UPDATE "MktSelfBook" SET "status" = \'booked\', "pickedSlot" = ?, "pickedAt" = ? WHERE "token" = ?', slot, nowIso(), row.token);
  await require('../audit').logAudit({ userId: row.createdById, action: 'Candidate picked an interview time (self-scheduling link)', entity: 'Application', entityId: row.applicationId, toValue: slot }).catch(() => {}); // eslint-disable-line global-require
  await require('../notify').notifyUsers([row.createdById], { title: 'The candidate picked an interview time', message: `Booked for ${new Date(slot).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`, open: '/ats/interviews' }).catch(() => {}); // eslint-disable-line global-require
  pushToCalendars(row.applicationId).catch(() => {});
  return { ok: true, slot };
}
// "none of these times work": the link closes, the recruiter is told, and new free times are ready for one click (re-book on decline)
async function declineSelfBook(row, note) {
  if (row.status !== 'open') return { status: 409, error: 'This link is no longer active.' };
  await x('UPDATE "MktSelfBook" SET "status" = \'declined\', "pickedAt" = ? WHERE "token" = ?', nowIso(), row.token);
  const app = await prisma.application.findUnique({ where: { id: row.applicationId }, include: { requirement: true } });
  const next = app ? await suggestSlots(app, { from: new Date(Date.now() + 26 * 3600e3), days: 7 }).catch(() => ({ slots: [] })) : { slots: [] };
  await require('../notify').notifyUsers([row.createdById], { title: 'The candidate could not make any of the times', message: `${txt(note, 200) || 'No reason given.'} New free times are ready: open the interview and press "Send new times".`, open: '/ats/interviews' }).catch(() => {}); // eslint-disable-line global-require
  await require('../audit').logAudit({ userId: row.createdById, action: 'Candidate declined the offered interview times', entity: 'Application', entityId: row.applicationId, toValue: txt(note, 200) || '-' }).catch(() => {}); // eslint-disable-line global-require
  return { ok: true, nextSlots: next.slots.length };
}

// ---------------------------------------------------------------- calendar (07.01)
async function feedToken(userId, reset = false) {
  await C.ensure();
  const had = (await q('SELECT * FROM "MktCalToken" WHERE "userId" = ?', userId))[0];
  if (had && !reset) return had.token;
  const t = C.randToken(24);
  await x('INSERT INTO "MktCalToken" ("userId","token","createdAt") VALUES (?,?,?) ON CONFLICT("userId") DO UPDATE SET "token" = excluded."token", "createdAt" = excluded."createdAt"', userId, t, nowIso());
  return t;
}
async function userOfFeed(token) { await C.ensure(); const r = (await q('SELECT "userId" FROM "MktCalToken" WHERE "token" = ?', String(token || '').slice(0, 80)))[0]; return r ? r.userId : null; }
const icsEsc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const fold = (l) => { const out = []; let s = l; while (Buffer.byteLength(s) > 74) { out.push(s.slice(0, 70)); s = ` ${s.slice(70)}`; } out.push(s); return out.join('\r\n'); };
// the interviews this person takes, booked or runs - only those in their own ATS scope (the feed is never wider than the screen)
async function feedEvents(user) {
  const { applicationWhere } = require('../scope'); // eslint-disable-line global-require
  const since = new Date(Date.now() - 14 * 86400e3); const until = new Date(Date.now() + 90 * 86400e3);
  const rows = await prisma.application.findMany({
    where: { AND: [applicationWhere(user), { interviewAt: { gte: since, lte: until } }, { interviewStatus: { in: ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED', 'STARTED', 'COMPLETED', 'FEEDBACK_SUBMITTED', 'CANCELLED'] } }] },
    select: { id: true, interviewAt: true, interviewRound: true, interviewStatus: true, interviewMode: true, interviewMeetingLink: true, interviewLocation: true, interviewer: true, interviewCreatedBy: true, ownerRecruiterId: true, candidate: { select: { name: true } }, requirement: { select: { title: true, recruiterId: true } }, interviewPanelists: { select: { userId: true, name: true } } },
    take: 500,
  }).catch(() => []);
  const me = String(user.name || '').toLowerCase();
  return rows.filter((a) => a.ownerRecruiterId === user.id || (a.requirement && a.requirement.recruiterId === user.id) || (a.interviewPanelists || []).some((p) => p.userId === user.id) || String(a.interviewer || '').toLowerCase().includes(me) || String(a.interviewCreatedBy || '').toLowerCase() === me);
}
function icsOf(events, calName = 'TeamLink interviews') {
  const lines = ['BEGIN:VCALENDAR', 'PRODID:-//TeamLink//Interview feed//EN', 'VERSION:2.0', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsEsc(calName)}`];
  events.forEach((a) => {
    const s = new Date(a.interviewAt); const e = new Date(s.getTime() + 60 * 60000);
    lines.push('BEGIN:VEVENT', `UID:interview-${a.id}-r${a.interviewRound || 1}@teamlink`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(s)}`, `DTEND:${stamp(e)}`,
      `SUMMARY:${icsEsc(`Interview: ${(a.candidate && a.candidate.name) || 'candidate'} - ${(a.requirement && a.requirement.title) || ''} (round ${a.interviewRound || 1})`)}`,
      `DESCRIPTION:${icsEsc(`Interviewer: ${a.interviewer || '-'}. Open TeamLink > Interview Calendar for the briefing and the scorecard.`)}`,
      `LOCATION:${icsEsc(a.interviewMode === 'In Person' ? (a.interviewLocation || 'In person') : (a.interviewMeetingLink || 'Online'))}`,
      `STATUS:${a.interviewStatus === 'CANCELLED' ? 'CANCELLED' : 'CONFIRMED'}`, 'END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

// Google / Microsoft per person (OAuth 2.0 authorization code). The app keys are the founder's (Admin saves them once);
// every URL can be pointed at a stub for tests (MKT_*_URL env).
const PROVIDERS = {
  google: {
    label: 'Google Calendar', scope: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy openid email',
    auth: () => process.env.MKT_GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    token: () => process.env.MKT_GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    api: () => process.env.MKT_GOOGLE_API_URL || 'https://www.googleapis.com/calendar/v3',
  },
  microsoft: {
    label: 'Microsoft Outlook / Teams calendar', scope: 'offline_access Calendars.ReadWrite User.Read',
    auth: (tenant) => process.env.MKT_MS_AUTH_URL || `https://login.microsoftonline.com/${tenant || 'common'}/oauth2/v2.0/authorize`,
    token: (tenant) => process.env.MKT_MS_TOKEN_URL || `https://login.microsoftonline.com/${tenant || 'common'}/oauth2/v2.0/token`,
    api: () => process.env.MKT_MS_API_URL || 'https://graph.microsoft.com/v1.0',
  },
};
async function appKeys(provider) {
  const s = await C.settings();
  const a = (s.calendarApp && s.calendarApp[provider]) || {};
  return { clientId: a.clientId || '', secret: a.secretEnc ? C.dec(a.secretEnc) : '', tenant: a.tenant || 'common', saved: !!(a.clientId && a.secretEnc) };
}
const redirectUri = (req, provider) => `${C.publicBase(req)}/api/public/mkt/cal-oauth/${provider}/callback`;
async function connectStart(req, provider) {
  const P = PROVIDERS[provider];
  if (!P) return { status: 404, error: 'Unknown calendar.' };
  const k = await appKeys(provider);
  if (!k.saved) return { status: 409, error: `${P.label} is not set up yet: an Admin adds the app's Client ID and secret (Administration > Step timing and alerts > Add-on switches > Calendar apps). Needs founder credentials.`, needsFounder: true };
  await C.ensure();
  const state = C.randToken(18);
  await x('INSERT INTO "MktCalLink" ("userId","provider","state") VALUES (?,?,?) ON CONFLICT("userId","provider") DO UPDATE SET "state" = excluded."state"', req.user.id, provider, state);
  const u = new URL(P.auth(k.tenant));
  u.searchParams.set('client_id', k.clientId); u.searchParams.set('redirect_uri', redirectUri(req, provider)); u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', P.scope); u.searchParams.set('state', `${provider}.${state}`); u.searchParams.set('access_type', 'offline'); u.searchParams.set('prompt', 'consent');
  return { url: u.toString() };
}
async function connectCallback(req, provider) {
  const P = PROVIDERS[provider];
  const [prov, state] = String(req.query.state || '').split('.');
  if (!P || prov !== provider || !state) return { status: 400, error: 'This sign-in link is not valid.' };
  await C.ensure();
  const row = (await q('SELECT * FROM "MktCalLink" WHERE "provider" = ? AND "state" = ?', provider, state))[0];
  if (!row) return { status: 400, error: 'This sign-in has expired. Press Connect again in TeamLink.' };
  if (req.query.error) { await x('UPDATE "MktCalLink" SET "state" = NULL, "lastError" = ? WHERE "userId" = ? AND "provider" = ?', txt(req.query.error, 200), row.userId, provider); return { status: 400, error: 'The calendar was not connected (the permission was not given).' }; }
  const k = await appKeys(provider);
  const body = new URLSearchParams({ client_id: k.clientId, client_secret: k.secret, code: String(req.query.code || ''), grant_type: 'authorization_code', redirect_uri: redirectUri(req, provider) });
  const r = await fetch(P.token(k.tenant), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }).catch((e) => ({ ok: false, statusText: e.message }));
  const j = r.ok ? await r.json().catch(() => ({})) : {};
  if (!r.ok || !j.refresh_token) { await x('UPDATE "MktCalLink" SET "state" = NULL, "lastError" = ? WHERE "userId" = ? AND "provider" = ?', `Token exchange failed (${r.status || r.statusText || 'error'})`, row.userId, provider); return { status: 502, error: 'The calendar did not give TeamLink access. Please try again.' }; }
  await x('UPDATE "MktCalLink" SET "state" = NULL, "refreshEnc" = ?, "account" = ?, "connectedAt" = ?, "lastError" = NULL WHERE "userId" = ? AND "provider" = ?', C.enc(j.refresh_token), txt(j.email || j.id_token_email || '', 120) || null, nowIso(), row.userId, provider);
  return { ok: true, userId: row.userId };
}
async function connections(userId) {
  await C.ensure();
  const rows = await q('SELECT "provider","account","connectedAt","lastPushAt","lastError","refreshEnc" FROM "MktCalLink" WHERE "userId" = ?', userId);
  const out = {};
  for (const p of Object.keys(PROVIDERS)) {
    const r = rows.find((x2) => x2.provider === p);
    // eslint-disable-next-line no-await-in-loop
    out[p] = { label: PROVIDERS[p].label, connected: !!(r && r.refreshEnc), account: r && r.account, connectedAt: r && r.connectedAt, lastPushAt: r && r.lastPushAt, lastError: r && r.lastError, appReady: (await appKeys(p)).saved };
  }
  return out;
}
async function disconnect(userId, provider) { await C.ensure(); await x('DELETE FROM "MktCalLink" WHERE "userId" = ? AND "provider" = ?', userId, provider); }
async function accessToken(userId, provider) {
  const row = (await q('SELECT * FROM "MktCalLink" WHERE "userId" = ? AND "provider" = ? AND "refreshEnc" IS NOT NULL', userId, provider))[0];
  if (!row) return null;
  const k = await appKeys(provider);
  if (!k.saved) return null;
  const body = new URLSearchParams({ client_id: k.clientId, client_secret: k.secret, refresh_token: C.dec(row.refreshEnc) || '', grant_type: 'refresh_token' });
  const r = await fetch(PROVIDERS[provider].token(k.tenant), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }).catch(() => null);
  const j = r && r.ok ? await r.json().catch(() => ({})) : {};
  if (!j.access_token) { await x('UPDATE "MktCalLink" SET "lastError" = ? WHERE "userId" = ? AND "provider" = ?', 'The calendar refused the saved permission. Connect it again.', userId, provider); return null; }
  return j.access_token;
}
async function calendarBusy(userId, from, to) {
  await C.ensure();
  const out = [];
  for (const provider of Object.keys(PROVIDERS)) {
    // eslint-disable-next-line no-await-in-loop
    const tok = await accessToken(userId, provider).catch(() => null);
    if (!tok) continue; // eslint-disable-line no-continue
    const P = PROVIDERS[provider];
    if (provider === 'google') {
      // eslint-disable-next-line no-await-in-loop
      const r = await fetch(`${P.api()}/freeBusy`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: 'primary' }] }) }).catch(() => null);
      const j = r && r.ok ? await r.json().catch(() => ({})) : {}; // eslint-disable-line no-await-in-loop
      const cal = j.calendars && (j.calendars.primary || Object.values(j.calendars)[0]);
      ((cal && cal.busy) || []).forEach((b) => out.push({ start: new Date(b.start), end: new Date(b.end) }));
    } else {
      // eslint-disable-next-line no-await-in-loop
      const r = await fetch(`${P.api()}/me/calendarView?startDateTime=${encodeURIComponent(from.toISOString())}&endDateTime=${encodeURIComponent(to.toISOString())}&$select=start,end,showAs`, { headers: { Authorization: `Bearer ${tok}`, Prefer: 'outlook.timezone="UTC"' } }).catch(() => null);
      const j = r && r.ok ? await r.json().catch(() => ({})) : {}; // eslint-disable-line no-await-in-loop
      (j.value || []).filter((e) => e.showAs !== 'free').forEach((e) => out.push({ start: new Date(`${String(e.start.dateTime).replace(/Z?$/, 'Z')}`), end: new Date(`${String(e.end.dateTime).replace(/Z?$/, 'Z')}`) }));
    }
  }
  return out;
}
// a booked interview -> the connected calendars of the people on it (OFF by default: switch "calendarPush")
async function pushToCalendars(appId, { force = false, onlyUserId = null } = {}) {
  if (!force && !(await C.switchOn('calendarPush'))) return { pushed: 0, off: true };
  await C.ensure();
  const app = await prisma.application.findUnique({ where: { id: appId }, select: { id: true, interviewAt: true, interviewRound: true, interviewMode: true, interviewMeetingLink: true, interviewLocation: true, interviewer: true, ownerRecruiterId: true, candidate: { select: { name: true } }, requirement: { select: { title: true } }, interviewPanelists: { select: { userId: true } } } });
  if (!app || !app.interviewAt) return { pushed: 0 };
  const users = onlyUserId ? [onlyUserId] : [...new Set([...(app.interviewPanelists || []).map((p) => p.userId), app.ownerRecruiterId].filter(Boolean))];
  let pushed = 0; const errors = [];
  for (const uid of users) {
    // eslint-disable-next-line no-await-in-loop
    const links = await q('SELECT "provider" FROM "MktCalLink" WHERE "userId" = ? AND "refreshEnc" IS NOT NULL', uid);
    for (const { provider } of links) {
      // eslint-disable-next-line no-await-in-loop
      const tok = await accessToken(uid, provider);
      if (!tok) { errors.push(`${provider}: no access`); continue; } // eslint-disable-line no-continue
      const s = new Date(app.interviewAt); const e = new Date(s.getTime() + 3600e3);
      const title = `Interview: ${app.candidate.name} - ${app.requirement.title} (round ${app.interviewRound || 1})`;
      const where = app.interviewMode === 'In Person' ? (app.interviewLocation || 'In person') : (app.interviewMeetingLink || 'Online');
      const had = (await q('SELECT "eventId" FROM "MktCalPush" WHERE "applicationId" = ? AND "round" = ? AND "userId" = ? AND "provider" = ?', app.id, app.interviewRound || 1, uid, provider))[0]; // eslint-disable-line no-await-in-loop
      const P = PROVIDERS[provider];
      const req = provider === 'google'
        ? { url: `${P.api()}/calendars/primary/events${had && had.eventId ? `/${encodeURIComponent(had.eventId)}` : ''}`, method: had && had.eventId ? 'PUT' : 'POST', body: { summary: title, location: where, description: 'Booked in TeamLink. The briefing and scorecard are in Interview Calendar.', start: { dateTime: s.toISOString() }, end: { dateTime: e.toISOString() } } }
        : { url: `${P.api()}/me/events${had && had.eventId ? `/${encodeURIComponent(had.eventId)}` : ''}`, method: had && had.eventId ? 'PATCH' : 'POST', body: { subject: title, location: { displayName: where }, body: { contentType: 'text', content: 'Booked in TeamLink.' }, start: { dateTime: s.toISOString().replace('Z', ''), timeZone: 'UTC' }, end: { dateTime: e.toISOString().replace('Z', ''), timeZone: 'UTC' } } };
      // eslint-disable-next-line no-await-in-loop
      const r = await fetch(req.url, { method: req.method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) }).catch(() => null);
      const j = r && r.ok ? await r.json().catch(() => ({})) : null; // eslint-disable-line no-await-in-loop
      if (!j) { errors.push(`${provider}: ${r ? r.status : 'no answer'}`); continue; } // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      await x('INSERT INTO "MktCalPush" ("applicationId","round","userId","provider","eventId","pushedAt") VALUES (?,?,?,?,?,?) ON CONFLICT("applicationId","round","userId","provider") DO UPDATE SET "eventId" = excluded."eventId", "pushedAt" = excluded."pushedAt"', app.id, app.interviewRound || 1, uid, provider, String(j.id || (had && had.eventId) || ''), nowIso());
      await x('UPDATE "MktCalLink" SET "lastPushAt" = ?, "lastError" = NULL WHERE "userId" = ? AND "provider" = ?', nowIso(), uid, provider); // eslint-disable-line no-await-in-loop
      pushed += 1;
    }
  }
  return { pushed, errors };
}

module.exports = {
  SCALES, QTYPES, RECS, defaultKit, kitFor, listKits, saveKit, removeKit, suggestKit, scoresOf, saveScore,
  recordingsOf, recordingRow, addRecording, addReview, setTranscript, makeNotes, codeNotes, feedbackSummary,
  suggestSlots, replacements, jobSettings, setJobSetting, createSelfBook, selfBookRow, selfBooksOf, pickSelfBook, declineSelfBook,
  feedToken, userOfFeed, feedEvents, icsOf, PROVIDERS, appKeys, connectStart, connectCallback, connections, disconnect, calendarBusy, pushToCalendars,
};
