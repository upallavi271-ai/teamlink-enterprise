// ---------------------------------------------------------------------------
// AI MARKETING > SEO & VISIBILITY > WORDING CHECK (2026-11-24): the "special quality and approval policy" of the services document as a checklist the team runs on any post, caption, FAQ answer or review reply
// BEFORE it goes to the client:
//   * for everybody: no guaranteed rankings, leads or results; no "100%" promises; superlatives ("best", "No. 1") need proof;
//   * for healthcare clients: no cure or "no side effects" promises, no naming of patients, no talk about a person's treatment in a reply, before-and-after pictures, testimonials, discounts and
//     free offers and endorsements are flagged for permission or review, and a MEDICAL REVIEWER'S SIGN-OFF is recorded (name, role, note) before publishing.
// levels: stop = change it before publishing · review = needs proof, permission or a second pair of eyes · info = good practice.
// BASIS (a starting checklist, NOT legal advice): the document's own quality policy; the NMC guidelines on ethical advertising and public communication (6 Oct 2026, as reported); the ASCI Code and
// Healthcare Guidelines (superlatives need documentary proof); the Drugs and Magic Remedies (Objectionable Advertisements) Act 1954 (cure claims for serious conditions). The exact texts were not re-read
// line by line here: confirm with the client's legal adviser and the medical reviewer. Plain code: no AI, no network, nothing is sent.
// sign-offs are saved (table OmniMkSignoff) and in the audit log.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const S = require('../outreach/store');
const A = require('../outreach/access');
const Packs = require('./industryPacks');
const { logAudit } = require('../utils/audit');

const T = 'OmniMkSignoff';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${T}" ("id" TEXT NOT NULL PRIMARY KEY, "clientName" TEXT NOT NULL DEFAULT '', "textHash" TEXT NOT NULL, "textPreview" TEXT, "reviewerName" TEXT NOT NULL, "reviewerRole" TEXT, "note" TEXT, "department" TEXT, "createdById" TEXT, "createdByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS "${T}_hash" ON "${T}"("textHash", "createdAt")`,
];
let okAt = 0;
async function ensure() { if (okAt && Date.now() - okAt < 600000) return true; try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] sign-off schema:', e.message); return false; } } // eslint-disable-line no-await-in-loop, no-console

const SERIOUS = '(cancer|tumou?rs?|diabet\\w*|sugar|heart (?:disease|attack|block|failure)|cardiac|blood pressure|hypertension|\\bbp\\b|epilep\\w*|\\bfits\\b|paralysis|stroke|obesity|cataract|blindness|hiv|aids|kidney (?:failure|disease)|asthma|arthritis|infertility|impotence|leprosy|hepatitis|tuberculosis|\\btb\\b|thyroid|migraine|piles|psoriasis|vitiligo|leucoderma)';
const CURE = '(cure[sd]?|curing|permanent(?:ly)? (?:cure|relief|solution)|complete(?:ly)? cure[d]?|totally cured|reverse[sd]?|eliminate[sd]? (?:the )?disease)';
// level, scope ('all' | 'health'), id, pattern, why, what to do
const RULES = [
  ['stop', 'all', 'rank-promise', /\b(first page of google|page one of google|rank(?:ing)? (?:#|no\.? ?)?1\b|top of google|guaranteed (?:leads?|rankings?|traffic|results?|sales|enquiries))\b/i, 'A guaranteed ranking, lead or result cannot be promised.', 'Say what the service does and what will be reported, not what it will win.'],
  ['stop', 'all', 'guarantee', /\bguarantee[ds]?\b/i, 'A guarantee is a promise of a result.', 'Take out "guarantee". Describe the effort and the way results are reported.', true],
  ['review', 'all', 'hundred', /\b100\s?%/i, '"100%" is an absolute claim that needs proof.', 'Use the real number with its source, or leave it out.'],
  ['review', 'all', 'superlative', /\b(no\.? ?1|number one|#1|the best|best (?:in|of)|world[- ]class|leading|top[- ]rated|top[- ]ranked|most trusted|unmatched|unbeatable|finest|greatest)\b/i, 'A superlative needs documentary proof (ASCI).', 'Keep it only with proof you can show; otherwise state a plain fact (years of service, departments, real accreditations).'],
  ['info', 'all', 'compare', /\b(better than|unlike (?:other|others)|cheaper than)\b/i, 'A comparison with others must be provable.', 'Compare only with proof, and never name a competitor.'],
  ['stop', 'health', 'cure-serious', null, 'Never promise the cure of a serious condition (Drugs and Magic Remedies Act, ASCI).', 'Say what the department treats or helps with, not that it cures.'],
  ['review', 'health', 'cure', new RegExp(`\\b${CURE}\\b`, 'i'), 'A cure claim is a promise of a result.', 'Say what the service does ("treats", "helps manage") and leave the promise out.'],
  ['stop', 'health', 'miracle', /\b(miracle|magic(?:al)?|risk[- ]free|no side[- ]effects?|painless|without pain|safe for everyone|zero risk|no risk|100\s?% safe)\b/i, 'A no-risk, no-pain or miracle claim is misleading.', 'Describe the care in plain facts. Every treatment has risks.'],
  ['review', 'health', 'before-after', /\bbefore\s*(?:and|&|\/|-)\s*after\b/i, 'Before-and-after pictures need the patient\'s written permission and may be restricted for promotion.', 'Leave them out unless the medical reviewer and the legal adviser confirm it is allowed.'],
  ['review', 'health', 'testimonial', /\b(testimonials?|patient (?:said|says|story|stories|review|speaks)|our patients (?:say|love|trust)|success stor(?:y|ies)|happy patients?)\b/i, 'Patient testimonials need written permission and may be restricted.', 'Leave patient words out of promotion unless permission and the rules allow it.'],
  ['review', 'health', 'inducement', /\b(free (?:consultation|check[- ]?up|checkup|treatment|surgery|camp)|\d+\s?%\s?(?:off|discount)|discount(?:ed)?|special price|cashback|offer)\b/i, 'Free offers and discounts on medical services may be restricted.', 'Check the rule that applies to this client before publishing an offer.'],
  ['review', 'health', 'endorsement', /\b(endorsed by|celebrity|brand ambassador)\b/i, 'Endorsements by celebrities may be restricted for medical services.', 'Leave them out unless the rules allow it.'],
  ['stop', 'health', 'patient-name', /\b(?:[Pp]atient|[Mm]r\.?|[Mm]rs\.?|[Mm]s\.?|[Mm]aster|[Bb]aby)\s+[A-Z][a-z]{2,}\b/, 'A patient must not be named.', 'Take the name out. Never name or describe a patient.'],
  ['stop', 'health', 'your-treatment', /\byour (?:surgery|treatment|operation|diagnosis|report|reports|scan|test|tests|procedure|prescription|medication|medicine|condition|illness|disease|admission|discharge)\b/i, 'Talking about a person\'s treatment confirms that they are a patient.', 'Thank them for the feedback and invite them to call. Never mention treatment, reports or admission.'],
  ['review', 'health', 'visit', /\byou (?:visited|were admitted|were treated|came to us|had (?:a|an|your))\b/i, 'This confirms the person was a patient.', 'Use "thank you for your feedback" without saying what they did here.'],
  ['review', 'health', 'advice', /\b(?:you should (?:take|stop|start|avoid)|(?:take|stop taking) (?:this|the) (?:medicine|tablet|drug|pill))\b/i, 'Medical advice must not be given in a public post or reply.', 'Invite them to consult the doctor.'],
];
const NEG = /(?:\b(?:no|not|never|without|cannot|can't|doesn't|does not|do not|don't|nor)\s+(?:\w+\s+){0,2})$/i;

function snippet(text, i, len) { const a = Math.max(0, i - 24); const b = Math.min(text.length, i + len + 24); return `${a > 0 ? '…' : ''}${text.slice(a, b).replace(/\s+/g, ' ')}${b < text.length ? '…' : ''}`; }
// text: the words to check; opts: { industry, healthcare } (a healthcare industry switches the health rules on)
function check(text, opts = {}) {
  const t = String(text == null ? '' : text).slice(0, 8000); if (!t.trim()) return { error: 'Paste the words to check.', status: 400 };
  const health = Boolean(opts.healthcare) || Packs.isHealthcare(opts.industry); const findings = [];
  for (const [level, scope, id, re, why, fix, negatable] of RULES) {
    if (scope === 'health' && !health) continue;
    if (id === 'cure-serious') { const rx = new RegExp(`\\b${CURE}\\b[^.!?\\n]{0,70}\\b${SERIOUS}\\b|\\b${SERIOUS}\\b[^.!?\\n]{0,70}\\b${CURE}\\b`, 'ig'); let m; while ((m = rx.exec(t))) findings.push({ level, id, match: m[0].slice(0, 90), context: snippet(t, m.index, m[0].length), why, fix }); continue; }
    const rx = new RegExp(re.source, `${re.flags.replace('g', '')}g`); let m;
    while ((m = rx.exec(t))) { if (negatable && NEG.test(t.slice(Math.max(0, m.index - 24), m.index))) continue; findings.push({ level, id, match: m[0], context: snippet(t, m.index, m[0].length), why, fix }); if (findings.length > 60) break; }
  }
  const stops = findings.filter((f) => f.level === 'stop').length; const reviews = findings.filter((f) => f.level === 'review').length;
  const verdict = stops ? 'Needs changes' : reviews ? 'Needs a check' : 'No problems found by this checklist';
  return { verdict, level: stops ? 'stop' : reviews ? 'review' : 'ok', stops, reviews, findings, healthcare: health, needsSignoff: health,
    note: health ? 'Healthcare: a doctor or qualified medical reviewer must read this and sign it off before it is published. Patient information never goes into public AI tools.' : 'This checklist finds common problems only; read the words once more before they go to the client.', basis: 'The document\'s quality policy, the NMC advertising guidelines, the ASCI Code and Healthcare Guidelines, and the Drugs and Magic Remedies Act 1954. A starting checklist, not legal advice: confirm with the client\'s legal adviser.' };
}

// ---- the medical reviewer's sign-off ---------------------------------------------------------------------------------------------------------------------------------
const hashOf = (text) => crypto.createHash('sha256').update(String(text || '').replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex');
async function signoff(u, b = {}) {
  if (!(await ensure())) return { error: 'The sign-off could not be saved.', status: 500 };
  const text = String(b.text || '').trim(); if (!text) return { error: 'Paste the exact words that were reviewed.', status: 400 };
  const reviewer = S.clip(b.reviewerName, 100); if (!reviewer) return { error: "Write the medical reviewer's name.", status: 400 };
  const clientName = S.clip(b.clientName, 120); if (!clientName) return { error: 'Write the client name.', status: 400 };
  const dept = S.clip(b.department, 60) || null; if (dept && !A.mayDepartment(u, dept)) return { error: 'That department is not yours.', status: 403 };
  const c = check(text, { industry: b.industry, healthcare: true }); if (c.stops) return { error: 'The words still have problems marked "change it". Fix them first, then record the sign-off.', status: 400, findings: c.findings.filter((f) => f.level === 'stop') };
  const id = S.newId('sgn');
  await S.run(`INSERT INTO "${T}" (id, clientName, textHash, textPreview, reviewerName, reviewerRole, note, department, createdById, createdByName, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, clientName, hashOf(text), S.clip(text, 160), reviewer, S.clip(b.reviewerRole, 80) || null, S.clip(b.note, 400) || null, dept, u.id, S.clip(u.name, 80), Date.now());
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: medical reviewer sign-off recorded', entity: T, entityId: id, toValue: `${clientName}: reviewed by ${reviewer}` });
  return { id, hash: hashOf(text), reviewerName: reviewer };
}
async function signoffs(u, o = {}) {
  if (!(await ensure())) return { error: 'The sign-offs could not be opened.', status: 500 };
  const rows = (await S.q(`SELECT * FROM "${T}" ORDER BY createdAt DESC LIMIT 300`)).filter((r) => A.mayDepartment(u, r.department || '')).filter((r) => !o.clientName || r.clientName.toLowerCase() === String(o.clientName).toLowerCase()).filter((r) => !o.text || r.textHash === hashOf(o.text));
  return { items: rows.map((r) => ({ id: r.id, clientName: r.clientName, textPreview: r.textPreview || '', reviewerName: r.reviewerName, reviewerRole: r.reviewerRole || '', note: r.note || '', createdByName: r.createdByName || '', createdAt: S.iso(r.createdAt) })) };
}
module.exports = { ensure, check, signoff, signoffs, hashOf, RULES };
