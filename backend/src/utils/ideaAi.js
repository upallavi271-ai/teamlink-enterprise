// ---------------------------------------------------------------------------
// Weekly idea screening — the AI half of Knowledge Transfer.
//
// Every submitted idea goes through screen(): the model SCREENS IT FOR
// DUPLICATES against ideas already on file, and SCORES the unique ones on five
// named criteria — originality, usefulness, impact, clarity, feasibility.
//
// THE KEY NEVER LEAVES THE SERVER. There is no second key path: the key, the
// cached client, the configured/not-configured check and the per-user rate
// limit all come from utils/aiAgent.js, which reads the encrypted credential
// store. Nothing here logs, returns or otherwise handles the key itself.
//
// NOT CONFIGURED IS A FIRST-CLASS STATE. With no key the screen still works:
// the idea is stored, duplicate screening falls back to the deterministic
// text-similarity check below, and NO SCORES ARE PRODUCED. A fallback result
// is stamped aiMethod='fallback' and carries null scores, so a made-up score
// is not merely avoided — it is unrepresentable.
//
// COST. The model never sees the whole table. It sees a bounded candidate set
// (same department, recent weeks, MAX_CANDIDATES rows, each truncated to
// CANDIDATE_CHARS), it is asked for one small JSON object, and the answer is
// capped at MAX_TOKENS. One call per submitted idea does both jobs.
// ---------------------------------------------------------------------------

const prisma = require('../db');
const { agentConfig, clientFor, rateCheck, apiError } = require('./aiAgent');

const QUOTA = 3; // unique ideas per employee per week

// --- Cost rails ------------------------------------------------------------
const MAX_CANDIDATES = 25;   // rows the model is shown, at most
const CANDIDATE_CHARS = 180; // characters per candidate row
const CANDIDATE_WEEKS = 8;   // how far back the candidate set reaches
const MAX_TOKENS = 400;      // the answer is one small JSON object
const MAX_TITLE = 160;
const MAX_DETAIL = 800;

// Similarity at or above this is called a duplicate by the deterministic
// screen. Chosen so a reworded restatement of the same idea trips it while two
// genuinely different ideas about the same module do not.
const FALLBACK_DUPLICATE_AT = 55;

const CRITERIA = ['originality', 'usefulness', 'impact', 'clarity', 'feasibility'];

// --- Weeks -----------------------------------------------------------------
// The week a submission counts toward is identified by its MONDAY, stored as
// YYYY-MM-DD. Everything about the quota is then an equality test.
function weekStartOf(date) {
  const d = date instanceof Date ? new Date(date.getTime()) : new Date(`${String(date).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return weekStartOf(new Date());
  const dow = d.getDay(); // 0 = Sunday
  const backToMonday = dow === 0 ? 6 : dow - 1;
  d.setDate(d.getDate() - backToMonday);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function weeksBefore(weekStart, n) {
  const d = new Date(`${weekStart}T00:00:00`);
  d.setDate(d.getDate() - n * 7);
  return weekStartOf(d);
}

// --- Deterministic similarity ----------------------------------------------
// Token-set overlap (Dice) blended with character-bigram overlap. The token
// half catches "add a dark mode to the portal" vs "portal should have a dark
// mode"; the bigram half keeps a near-miss on spelling from reading as a
// different idea. No model, no network, same answer every time.
const STOP = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'be', 'we', 'i',
  'it', 'that', 'this', 'with', 'should', 'could', 'would', 'can', 'will', 'so', 'as', 'by',
  'at', 'from', 'our', 'their', 'there', 'all', 'each', 'every', 'more', 'than', 'then',
]);

function words(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

function bigrams(text) {
  const s = String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

function diceOf(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  a.forEach((x) => { if (b.has(x)) shared += 1; });
  return (2 * shared) / (a.size + b.size);
}

// 0-100.
function similarity(a, b) {
  const tokens = diceOf(new Set(words(a)), new Set(words(b)));
  const chars = diceOf(bigrams(a), bigrams(b));
  return Math.round((tokens * 0.7 + chars * 0.3) * 100);
}

function ideaText(idea) {
  return `${idea.title || ''}. ${idea.detail || ''}`.trim();
}

// --- The bounded candidate set ---------------------------------------------
// Recent ideas from the SAME DEPARTMENT, newest first, capped. This is the
// cost control: the model compares against at most MAX_CANDIDATES short rows,
// never against the whole table. Duplicate screening is a within-department
// question anyway — two departments independently asking for the same report
// are two real contributions.
async function candidateSet({ department, excludeId, weekStart }) {
  const since = weeksBefore(weekStart, CANDIDATE_WEEKS);
  const rows = await prisma.employeeRecord.findMany({
    where: {
      type: 'WEEKLY_IDEA',
      id: excludeId ? { not: excludeId } : undefined,
      // Only ideas already accepted as unique are worth comparing against: a
      // duplicate's original is in the set already.
      aiDuplicate: false,
      OR: [{ weekStart: { gte: since } }, { weekStart: null }],
      ...(department ? { employee: { department } } : {}),
    },
    include: { employee: { select: { name: true, department: true } } },
    orderBy: { createdAt: 'desc' },
    take: MAX_CANDIDATES,
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    text: ideaText(r).slice(0, CANDIDATE_CHARS),
    employeeName: r.employee ? r.employee.name : null,
  }));
}

// --- The deterministic screen ----------------------------------------------
// Used when no key is configured, and as the safety net when a configured call
// fails. NEVER produces a score.
// `configured` says WHY there is no score, so the note is accurate in both
// cases: no key at all, or a key whose call did not produce a usable answer.
function fallbackScreen(idea, candidates, reason, configured = false) {
  let best = null;
  candidates.forEach((c) => {
    const pct = similarity(ideaText(idea), c.text);
    if (!best || pct > best.similarity) best = { ...c, similarity: pct };
  });
  const duplicate = !!best && best.similarity >= FALLBACK_DUPLICATE_AT;
  const unscored = configured
    ? 'AI scoring did not run for this submission, so this idea is unscored.'
    : 'AI scoring is not configured, so this idea is unscored.';
  return {
    method: 'fallback',
    model: null,
    duplicate,
    duplicateOf: duplicate ? best.id : null,
    similarity: best ? best.similarity : 0,
    scores: null,
    note: duplicate
      ? `Text-similarity check: ${best.similarity}% match with "${best.title}"${best.employeeName ? ` (${best.employeeName})` : ''}. ${unscored}`
      : `Text-similarity check found no match above ${FALLBACK_DUPLICATE_AT}%${best ? ` (closest ${best.similarity}%)` : ''}. ${unscored}`,
    reason: reason || null,
  };
}

// --- The model call --------------------------------------------------------
const SYSTEM = [
  'You screen employee suggestions for an HR platform\'s weekly idea programme.',
  '',
  'You do exactly two things, in one JSON answer:',
  '1. DUPLICATE SCREENING. Decide whether the new idea is substantially the same proposal as one of the existing ideas you are shown. Rewording, a narrower restatement or the same change described from the user\'s side all count as duplicates. Two different changes to the same screen do NOT.',
  '2. SCORING. If, and only if, the idea is unique, score it 1-10 on each of: originality, usefulness, impact, clarity, feasibility. Use the whole range; 5 is ordinary.',
  '',
  'Answer with ONE JSON object and nothing else — no prose, no code fence:',
  '{"duplicate":boolean,"duplicateOf":"<existing idea id or null>","similarity":<0-100>,"scores":{"originality":n,"usefulness":n,"impact":n,"clarity":n,"feasibility":n}|null,"note":"<one sentence, max 200 chars>"}',
  '',
  'When duplicate is true, scores MUST be null. When duplicate is false, every one of the five scores MUST be an integer 1-10. Never omit a criterion and never invent an id that is not in the list.',
].join('\n');

function userMessage(idea, candidates) {
  const list = candidates.length
    ? candidates.map((c) => `- id=${c.id} :: ${c.text}`).join('\n')
    : '(none — this is the first idea on file for this department)';
  return [
    'EXISTING IDEAS ON FILE:',
    list,
    '',
    'NEW IDEA:',
    `Title: ${String(idea.title || '').slice(0, MAX_TITLE)}`,
    `Detail: ${String(idea.detail || '').slice(0, MAX_DETAIL)}`,
  ].join('\n');
}

function parseJson(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

function intIn(value, lo, hi) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null;
}

// Trust nothing the model returns. A scores object that is not five integers
// in 1-10 is NOT a score, and is thrown away rather than rounded into one.
function normaliseScores(scores) {
  if (!scores || typeof scores !== 'object') return null;
  const out = {};
  for (const key of CRITERIA) {
    const n = intIn(scores[key], 1, 10);
    if (n === null) return null;
    out[key] = n;
  }
  out.total = CRITERIA.reduce((sum, k) => sum + out[k], 0);
  return out;
}

// ---------------------------------------------------------------------------
// screen() — the one entry point. Always returns a usable result: a model
// result when a key is configured and the call worked, the deterministic
// result otherwise.
// ---------------------------------------------------------------------------
async function screen({ user, idea, department, weekStart, excludeId }) {
  const candidates = await candidateSet({ department, excludeId, weekStart });
  const cfg = await agentConfig();
  if (!cfg.configured) return fallbackScreen(idea, candidates, cfg.reason);

  // The SAME per-user hourly/burst budget the AI Assistant uses. Hitting it
  // does not lose the idea — it falls back.
  const limit = rateCheck(user.id, cfg.perHour);
  if (!limit.ok) return fallbackScreen(idea, candidates, limit.message, true);

  let response;
  try {
    response = await clientFor(cfg.apiKey).messages.create({
      model: cfg.model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      messages: [{ role: 'user', content: userMessage(idea, candidates) }],
    });
  } catch (err) {
    return fallbackScreen(idea, candidates, apiError(err), true);
  }

  if (response.stop_reason === 'refusal') {
    return fallbackScreen(idea, candidates, 'The model declined to screen that idea.', true);
  }
  const text = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const parsed = parseJson(text);
  if (!parsed) return fallbackScreen(idea, candidates, 'The model did not return a readable result.', true);

  const duplicate = parsed.duplicate === true;
  // An id the model made up is not a reference to anything.
  const matched = duplicate && candidates.find((c) => c.id === parsed.duplicateOf);
  const scores = duplicate ? null : normaliseScores(parsed.scores);
  // A unique idea the model failed to score properly is not silently given
  // zeros: it is recorded as screened-by-model but unscored, which the UI says.
  return {
    method: 'model',
    model: cfg.model,
    duplicate,
    duplicateOf: matched ? matched.id : null,
    similarity: intIn(parsed.similarity, 0, 100),
    scores,
    note: String(parsed.note || '').slice(0, 200) || (duplicate ? 'Screened as a duplicate.' : 'Screened as unique.'),
    reason: null,
  };
}

// The columns a screening result writes onto the EmployeeRecord row.
function toRecordFields(result) {
  return {
    aiMethod: result.method,
    aiModel: result.model,
    aiDuplicate: !!result.duplicate,
    aiDuplicateOf: result.duplicateOf || null,
    aiSimilarity: result.similarity == null ? null : result.similarity,
    aiNote: result.note || null,
    scoreOriginality: result.scores ? result.scores.originality : null,
    scoreUsefulness: result.scores ? result.scores.usefulness : null,
    scoreImpact: result.scores ? result.scores.impact : null,
    scoreClarity: result.scores ? result.scores.clarity : null,
    scoreFeasibility: result.scores ? result.scores.feasibility : null,
    scoreTotal: result.scores ? result.scores.total : null,
    // A duplicate is recorded, not discarded — it just does not count toward
    // the quota and it is visible as a duplicate in All Ideas.
    status: result.duplicate ? 'Duplicate' : 'Unique',
  };
}

// What the screen shows about AI availability. Carries no key material.
async function aiStatus() {
  const cfg = await agentConfig();
  return {
    configured: cfg.configured,
    model: cfg.configured ? cfg.model : null,
    reason: cfg.configured ? null : cfg.reason,
  };
}

module.exports = {
  QUOTA, CRITERIA, FALLBACK_DUPLICATE_AT, MAX_CANDIDATES, MAX_TOKENS, CANDIDATE_WEEKS,
  weekStartOf, weeksBefore, similarity, screen, toRecordFields, aiStatus, candidateSet,
};
