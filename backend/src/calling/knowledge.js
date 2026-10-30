// ---------------------------------------------------------------------------
// QUESTIONS THE AI COULD NOT ANSWER, AND THE ANSWERS RECRUITERS GIVE (founder 2026-10-30: "candidates doubt adigithey
// dhanikii telvaaka potrhey ... dhanii telusukonii mikuu chepathanuu anii chepalii").
//
// On a call the assistant answers only from the verified job facts. A question those facts do not answer ("is transport
// given?") is said honestly ("I don't have confirmed information; the team will check and tell you") and kept here, per
// requirement, counted each time it is asked again. A recruiter writes the answer on the AI Calling page (Questions);
// from then on the assistant may use that answer on the next calls of the same requirement. Nothing is learnt by itself:
// only an answer a person wrote is ever used.
// Table AiCallQuestion (calling/schema.js).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const DB = require('./schema');
const S = require('./scripts');

const keyOf = (q) => String(q || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 160);
const iso = () => new Date().toISOString();

// The answered questions of one requirement, for the call's brain: [{ q, a }]
async function forRequirement(requirementId) {
  if (!requirementId) return [];
  const rows = await DB.all('SELECT "question", "answer" FROM "AiCallQuestion" WHERE "requirementId" = ? AND "status" = ? ORDER BY "askedCount" DESC LIMIT 30', requirementId, 'answered');
  return rows.filter((r) => r.answer).map((r) => ({ q: S.clean(r.question, 200), a: S.clean(r.answer, 300) }));
}

// After a call: its unanswered questions are kept (asked again = counted, never a second row).
async function recordPending(row, questions) {
  const list = (Array.isArray(questions) ? questions : []).map((q) => S.clean(q, 200)).filter(Boolean).slice(0, 5);
  let added = 0;
  for (const q of list) { // eslint-disable-line no-restricted-syntax
    const k = keyOf(q); if (!k) continue; // eslint-disable-line no-continue
    const t = iso();
    // eslint-disable-next-line no-await-in-loop
    const had = await DB.one('SELECT "id", "status" FROM "AiCallQuestion" WHERE "requirementId" = ? AND "questionKey" = ?', row.requirementId, k);
    if (had) {
      // eslint-disable-next-line no-await-in-loop
      await DB.run('UPDATE "AiCallQuestion" SET "askedCount" = "askedCount" + 1, "lastCallId" = ?, "lastCandidateId" = ?, "lastAskedAt" = ?, "updatedAt" = ? WHERE "id" = ?', row.id, row.candidateId, t, t, had.id);
    } else {
      // eslint-disable-next-line no-await-in-loop
      await DB.run('INSERT INTO "AiCallQuestion" ("id","requirementId","questionKey","question","status","askedCount","lastCallId","lastCandidateId","lastAskedAt","createdAt","updatedAt") VALUES (?,?,?,?,?,1,?,?,?,?,?)',
        `aiq_${crypto.randomBytes(9).toString('hex')}`, row.requirementId, k, q, 'pending', row.id, row.candidateId, t, t, t);
      added += 1;
    }
  }
  return added;
}

// The list for the AI Calling page (only requirements the login may see)
async function list(user, { status = 'pending', requirementId } = {}) {
  const where = ['1=1']; const args = [];
  if (status && status !== 'all') { where.push('"status" = ?'); args.push(status); }
  if (requirementId) { where.push('"requirementId" = ?'); args.push(requirementId); }
  const rows = await DB.all(`SELECT * FROM "AiCallQuestion" WHERE ${where.join(' AND ')} ORDER BY "status" = 'pending' DESC, "askedCount" DESC, "updatedAt" DESC LIMIT 300`, ...args);
  if (!rows.length) return [];
  const prisma = require('../db'); // eslint-disable-line global-require
  const { requirementWhere } = require('../utils/scope'); // eslint-disable-line global-require
  const reqs = await prisma.requirement.findMany({ where: { AND: [{ id: { in: [...new Set(rows.map((r) => r.requirementId))] } }, requirementWhere(user)] }, select: { id: true, title: true, reqCode: true, internal: true, client: { select: { name: true } } } });
  const byId = new Map(reqs.map((r) => [r.id, r]));
  return rows.filter((r) => byId.has(r.requirementId)).map((r) => {
    const q = byId.get(r.requirementId);
    return { ...r, requirement: { id: q.id, code: q.reqCode || null, title: q.title, client: q.internal ? 'TeamLink' : (q.client && q.client.name) || null } };
  });
}

// A recruiter's answer (or "not for the AI to say": dismissed). Returns the row or null.
async function answer(user, id, { answer: text, dismiss = false } = {}) {
  const row = await DB.one('SELECT * FROM "AiCallQuestion" WHERE "id" = ?', id);
  if (!row) return null;
  const ok = (await list(user, { status: 'all', requirementId: row.requirementId })).some((r) => r.id === id);
  if (!ok) return null;
  const t = iso();
  if (dismiss) {
    await DB.run('UPDATE "AiCallQuestion" SET "status" = ?, "answeredById" = ?, "answeredByName" = ?, "answeredAt" = ?, "updatedAt" = ? WHERE "id" = ?', 'dismissed', user.id, user.name || null, t, t, id);
  } else {
    const a = S.clean(text, 300);
    if (a.length < 2) return { error: 'Write the answer (a short, verified sentence).' };
    if (S.hasForbidden(a)) return { error: 'The answer uses a word the assistant must never say (selected / hired / offer ...). Please rephrase.' };
    await DB.run('UPDATE "AiCallQuestion" SET "answer" = ?, "status" = ?, "answeredById" = ?, "answeredByName" = ?, "answeredAt" = ?, "updatedAt" = ? WHERE "id" = ?', a, 'answered', user.id, user.name || null, t, t, id);
  }
  const { logAudit } = require('../utils/audit'); // eslint-disable-line global-require
  await logAudit({ userId: user.id, action: dismiss ? 'AI call question dismissed' : 'AI call question answered', entity: 'Requirement', entityId: row.requirementId, fromValue: row.question.slice(0, 200), toValue: dismiss ? 'dismissed' : S.clean(text, 200) }).catch(() => {});
  return DB.one('SELECT * FROM "AiCallQuestion" WHERE "id" = ?', id);
}

module.exports = { forRequirement, recordPending, list, answer, keyOf };
