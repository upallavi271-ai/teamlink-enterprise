// ---------------------------------------------------------------------------
// MARKET WAVE C - ASSESSMENTS (07.15) and AI-GENERATED ASSESSMENTS (07.16)
// A recruiter builds a short test for a job (one-answer / several-answer questions and short written answers), sends it to a
// candidate as a private link, and TeamLink scores it by itself: choice questions exactly, written answers by the key words
// the recruiter gave (a recruiter can change any written score afterwards). OFF by default (switch "assessments").
// The AI writes a first draft from the job description (no client name, no candidate data); a code draft when it is down.
// ---------------------------------------------------------------------------
const C = require('./core');

const { q, x, nowIso, newId, txt, json } = C;
const TYPES = ['mcq', 'multi', 'short'];

function cleanQuestions(list) {
  const out = [];
  for (const [i, raw] of (Array.isArray(list) ? list : []).entries()) {
    const type = TYPES.includes(raw && raw.type) ? raw.type : 'mcq';
    const text = txt(raw && raw.text, 600);
    if (!text) return { error: `Question ${i + 1} has no text.` };
    const points = Number(raw.points == null ? 1 : raw.points);
    if (!(Number.isFinite(points) && points > 0 && points <= 20)) return { error: `Question ${i + 1}: points are 1 to 20.` };
    const qq = { type, text, points };
    if (type === 'short') {
      qq.keywords = (Array.isArray(raw.keywords) ? raw.keywords : String(raw.keywords || '').split(',')).map((k) => txt(k, 40).toLowerCase()).filter(Boolean).slice(0, 12);
    } else {
      const options = (Array.isArray(raw.options) ? raw.options : []).map((o) => txt(o, 200)).filter(Boolean);
      if (options.length < 2 || options.length > 6) return { error: `Question ${i + 1}: give 2 to 6 choices.` };
      qq.options = options;
      const ans = (Array.isArray(raw.answer) ? raw.answer : [raw.answer]).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < options.length);
      if (!ans.length) return { error: `Question ${i + 1}: tick the right answer.` };
      qq.answer = type === 'mcq' ? [ans[0]] : [...new Set(ans)].sort();
    }
    out.push(qq);
  }
  if (!out.length) return { error: 'Add at least one question.' };
  if (out.length > 40) return { error: 'At most 40 questions in one test.' };
  return { value: out };
}
const shape = (r, { withAnswers = true } = {}) => {
  const qs = json(r.questions, []);
  return {
    id: r.id, requirementId: r.requirementId, title: r.title, passMark: Number(r.passMark), minutes: Number(r.minutes), source: r.source, active: Number(r.active) === 1, createdBy: r.createdBy, createdAt: r.createdAt, updatedAt: r.updatedAt,
    questions: withAnswers ? qs : qs.map((qq) => ({ type: qq.type, text: qq.text, points: qq.points, options: qq.options })),
    totalPoints: qs.reduce((s, qq) => s + Number(qq.points || 1), 0),
  };
};
async function list(requirementId) { await C.ensure(); return (await q('SELECT * FROM "MktAssessment" WHERE "requirementId" = ? ORDER BY "createdAt" DESC', requirementId)).map((r) => shape(r)); }
async function one(id) { await C.ensure(); const r = (await q('SELECT * FROM "MktAssessment" WHERE "id" = ?', String(id)))[0]; return r || null; }
async function save(requirementId, b, user, id = null) {
  await C.ensure();
  const title = txt(b.title, 120);
  if (!title) return { status: 400, error: 'Give the test a name.' };
  const v = cleanQuestions(b.questions);
  if (v.error) return { status: 400, error: v.error };
  const passMark = Math.min(Math.max(Number(b.passMark) || 60, 1), 100);
  const minutes = Math.min(Math.max(Number(b.minutes) || 30, 5), 180);
  const t = nowIso();
  if (id) {
    const had = await one(id);
    if (!had || had.requirementId !== requirementId) return { status: 404, error: 'That test is not on this job.' };
    await x('UPDATE "MktAssessment" SET "title"=?,"questions"=?,"passMark"=?,"minutes"=?,"active"=?,"updatedAt"=? WHERE "id"=?', title, JSON.stringify(v.value), passMark, minutes, b.active === false ? 0 : 1, t, id);
    return { assessment: shape(await one(id)) };
  }
  const nid = newId();
  await x('INSERT INTO "MktAssessment" ("id","requirementId","title","questions","passMark","minutes","source","active","createdBy","createdById","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,1,?,?,?,?)',
    nid, requirementId, title, JSON.stringify(v.value), passMark, minutes, b.source === 'ai' ? 'ai' : 'manual', C.who(user), user.id, t, t);
  return { assessment: shape(await one(nid)) };
}

// the draft from the job description (07.16)
async function generate(requirement, { count = 8 } = {}) {
  const n = Math.min(Math.max(Number(count) || 8, 3), 15);
  const jd = C.maskPii([requirement.title, `Skills: ${requirement.skills || ''}`, `Experience: ${requirement.experience || ''}`, requirement.jobDescription || requirement.description || ''].join('\n'), [requirement.client && requirement.client.name]).slice(0, 5000);
  const ai = await C.aiJson(`You write short screening tests for job candidates in India. Answer JSON only: {"questions":[{"type":"mcq","text":"...","options":["a","b","c","d"],"answer":1,"points":1} or {"type":"short","text":"...","keywords":["k1","k2"],"points":2}]}. ${n} questions, mostly mcq, about the job's skills only, plain English, one clearly right answer each.`, jd, { maxTokens: 1800, timeoutMs: 30000 });
  if (ai && Array.isArray(ai.value.questions)) {
    const v = cleanQuestions(ai.value.questions.slice(0, n));
    if (v.value) return { title: `${requirement.title} - screening test`, questions: v.value, source: `AI (${ai.provider})`, ai: true };
  }
  // code draft: one written question per skill (key word = the skill), plus two standard ones
  const skills = String(requirement.skills || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, n - 2);
  const questions = skills.map((s) => ({ type: 'short', text: `In 3-4 lines: how have you used ${s} in your work? Give one real example.`, keywords: [s.toLowerCase()], points: 2 }));
  questions.push({ type: 'mcq', text: 'How many years of hands-on experience do you have in this kind of role?', options: ['Less than 1', '1 to 3', '3 to 6', 'More than 6'], answer: [2], points: 1 });
  questions.push({ type: 'short', text: 'Why does this job fit you? (2-3 lines)', keywords: [], points: 1 });
  return { title: `${requirement.title} - screening test`, questions, source: 'TeamLink draft (from the job skills, no AI) - check the answers before you send it', ai: false };
}

// ---- sending and taking ------------------------------------------------------------
async function send(app, assessment, user, { req, email = false } = {}) {
  if (!(await C.switchOn('assessments'))) return { status: 409, error: C.SWITCH_OFF('assessments') };
  if (Number(assessment.active) !== 1) return { status: 409, error: 'This test is switched off. Switch it on first.' };
  await C.ensure();
  const token = C.randToken(18);
  const exp = new Date(Date.now() + 7 * 86400e3).toISOString();
  await x('INSERT INTO "MktAssessSend" ("token","assessmentId","applicationId","candidateId","status","createdBy","createdById","createdAt","expiresAt") VALUES (?,?,?,?,\'sent\',?,?,?,?)',
    token, assessment.id, app.id, app.candidateId, C.who(user), user.id, nowIso(), exp);
  const link = `${C.publicBase(req)}/test/${token}`;
  let outcome = 'Link made (copy it and send it yourself)';
  if (email && app.candidate && app.candidate.email) {
    const r = await require('../messaging').send('Email', { // eslint-disable-line global-require
      to: app.candidate.email, subject: `A short test for ${app.requirement ? app.requirement.title : 'your application'}`,
      text: `Hi ${String(app.candidate.name || '').split(/\s+/)[0] || 'there'},\n\nPlease take this short test for your application. It takes about ${assessment.minutes} minutes and the link works for 7 days:\n${link}\n\n- TeamLink`,
      actorUserId: user.id, meta: { audience: 'candidates', personId: app.candidateId, senderUserId: user.id, purpose: 'Assessment link', module: 'ATS' },
    }).catch((e) => ({ outcome: 'Failed', error: e.message }));
    outcome = `Email: ${r.outcome}${r.error ? ` (${r.error})` : ''}`;
    await x('UPDATE "MktAssessSend" SET "messageOutcome" = ? WHERE "token" = ?', outcome, token);
  }
  return { token, link, expiresAt: exp, outcome };
}
async function sendRow(token) { await C.ensure(); return (await q('SELECT * FROM "MktAssessSend" WHERE "token" = ?', String(token || '').slice(0, 64)))[0] || null; }
async function resultsFor(applicationId) {
  await C.ensure();
  const rows = await q('SELECT s.*, a."title", a."passMark", a."minutes" FROM "MktAssessSend" s LEFT JOIN "MktAssessment" a ON a."id" = s."assessmentId" WHERE s."applicationId" = ? ORDER BY s."createdAt" DESC', applicationId);
  return rows.map((r) => ({ token: r.token, title: r.title, status: r.status, score: r.score == null ? null : Number(r.score), maxScore: r.maxScore == null ? null : Number(r.maxScore), percent: r.percent == null ? null : Number(r.percent), passed: r.percent == null ? null : Number(r.percent) >= Number(r.passMark), passMark: Number(r.passMark), sentBy: r.createdBy, sentAt: r.createdAt, startedAt: r.startedAt, submittedAt: r.submittedAt, review: json(r.review, null), outcome: r.messageOutcome }));
}
function scoreAnswers(questions, answers) {
  let score = 0; let max = 0;
  const review = questions.map((qq, i) => {
    const pts = Number(qq.points || 1); max += pts;
    const a = (answers || {})[i];
    let got = 0;
    if (qq.type === 'short') {
      const t = String(a || '').toLowerCase();
      if (qq.keywords && qq.keywords.length) got = Math.round((qq.keywords.filter((k) => t.includes(k)).length / qq.keywords.length) * pts * 10) / 10;
      else got = t.trim().length >= 20 ? pts : 0; // no key words: a real answer gets the points (a recruiter may change it)
    } else {
      const given = (Array.isArray(a) ? a : [a]).map(Number).filter((n) => Number.isInteger(n)).sort();
      got = JSON.stringify([...new Set(given)]) === JSON.stringify(qq.answer) ? pts : 0;
    }
    score += got;
    return { i, got, of: pts, answer: qq.type === 'short' ? txt(a, 2000) : a == null ? null : a };
  });
  return { score: Math.round(score * 10) / 10, max, percent: max ? Math.round((score / max) * 1000) / 10 : 0, review };
}
async function publicView(row) {
  const a = await one(row.assessmentId);
  if (!a) return { status: 404, error: 'This test is not there any more.' };
  const s = shape(a, { withAnswers: false });
  const expired = new Date(row.expiresAt) < new Date();
  return { title: s.title, minutes: s.minutes, count: s.questions.length, status: row.status, expired, questions: row.status === 'submitted' || expired ? [] : s.questions, startedAt: row.startedAt };
}
async function start(row) {
  if (row.status === 'submitted') return { status: 409, error: 'This test was already sent in.' };
  if (new Date(row.expiresAt) < new Date()) return { status: 410, error: 'This link has expired.' };
  if (!row.startedAt) await x('UPDATE "MktAssessSend" SET "status" = \'started\', "startedAt" = ? WHERE "token" = ? AND "startedAt" IS NULL', nowIso(), row.token);
  return { ok: true };
}
async function submit(row, answers) {
  if (row.status === 'submitted') return { status: 409, error: 'This test was already sent in.' };
  if (new Date(row.expiresAt) < new Date()) return { status: 410, error: 'This link has expired.' };
  const a = await one(row.assessmentId);
  const late = row.startedAt && Date.now() > new Date(row.startedAt).getTime() + (Number(a.minutes) + 3) * 60000;
  const r = scoreAnswers(json(a.questions, []), answers && typeof answers === 'object' ? answers : {});
  const n = await x('UPDATE "MktAssessSend" SET "status" = \'submitted\', "answers" = ?, "score" = ?, "maxScore" = ?, "percent" = ?, "review" = ?, "submittedAt" = ?, "startedAt" = COALESCE("startedAt", ?) WHERE "token" = ? AND "status" <> \'submitted\'',
    JSON.stringify(answers || {}), r.score, r.max, r.percent, JSON.stringify({ items: r.review, late: !!late }), nowIso(), nowIso(), row.token);
  if (!n) return { status: 409, error: 'This test was already sent in.' };
  await require('../notify').notifyUsers([row.createdById], { title: 'A candidate finished the test', message: `${a.title}: ${r.percent}% (${r.percent >= Number(a.passMark) ? 'passed' : 'below the pass mark'})${late ? ', after the time limit' : ''}`, open: `/candidates/${row.candidateId}` }).catch(() => {}); // eslint-disable-line global-require
  return { ok: true, late: !!late };
}
async function regrade(token, i, got, user) {
  const row = await sendRow(token);
  if (!row || row.status !== 'submitted') return { status: 404, error: 'No finished test there.' };
  const rv = json(row.review, { items: [] });
  const item = rv.items.find((it) => it.i === Number(i));
  if (!item) return { status: 400, error: 'No such question.' };
  const g = Number(got);
  if (!(Number.isFinite(g) && g >= 0 && g <= item.of)) return { status: 400, error: `Give 0 to ${item.of} points.` };
  item.got = g; item.changedBy = C.who(user);
  const score = Math.round(rv.items.reduce((s, it) => s + Number(it.got), 0) * 10) / 10;
  const max = rv.items.reduce((s, it) => s + Number(it.of), 0);
  await x('UPDATE "MktAssessSend" SET "review" = ?, "score" = ?, "percent" = ? WHERE "token" = ?', JSON.stringify(rv), score, max ? Math.round((score / max) * 1000) / 10 : 0, token);
  return { ok: true, score };
}

module.exports = { TYPES, cleanQuestions, list, one, save, generate, send, sendRow, resultsFor, scoreAnswers, publicView, start, submit, regrade, shape };
