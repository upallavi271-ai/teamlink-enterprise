// ---------------------------------------------------------------------------
// RESUME-AWARE MATCHING (resume_ / fit_) — the 3-number Fit in both directions.
//
// Every number comes from the ONE scorer, utils/matching.js computeMatch():
//   overall     the prototype's 12 weighted signals (weights: Admin → Fit
//               settings, else the prototype's W object)
//   resumePct   skills + experience + education, read from the candidate's
//               CURRENT resume (resume text + parsed fields) when one is on
//               file, else from the profile fields
//   locPct      same city 100 / preferred city 90 / nearby-city bands
//               (city names normalised by utils/locationMatch.js)
// Eligible = overall >= the job's minimum (Requirement.minFit, else the Admin
// default, else 50) AND no mandatory skill missing AND location fits
// (matching.js eligibilityOf()).
//
// PUBLIC API (reused by routes/rejections.js — keep stable):
//   currentResumeEvidence(candidateIds)  Map(candidateId -> evidence); also
//                                        refreshes the Admin Fit settings
//   threeNumbers(candidate, requirement, evidence[, threshold])
//   thresholdFor(requirement)            the job's minimum Fit %
//   reasonLine(match)                    "Missing: Physiology, 3 years more experience"
//   listOptions(query) · sortRows(rows, sort)
//   loadFitSettings() · saveFitSettings(value, user) · fitSettingsSupported()
//
// The "current resume" is the newest version that has text, of either kind,
// that is NOT hidden as a wrong file — an edited version saved after the
// latest upload is the recruiter's corrected reading of the same person.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const {
  computeMatch, eligibilityOf, ELIGIBLE_THRESHOLD, WEIGHTS, setActiveWeights, getActiveWeights, SPEC_EXACT_BONUS, setActiveSpecBonus,
  setActiveVersion, getActiveVersion, versionLabel, versionCode,
} = require('./matching');
const semantic = require('./semanticMatch');

const safeParse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// Does the generated Prisma client know this column yet? (The migration is
// run by the main agent; until then the feature quietly stays off.)
let dmmfFields = null;
function hasField(model, field) {
  if (!dmmfFields) {
    dmmfFields = new Map();
    try {
      // eslint-disable-next-line global-require
      const { Prisma } = require('@prisma/client');
      (Prisma.dmmf.datamodel.models || []).forEach((m) => dmmfFields.set(m.name, new Set(m.fields.map((f) => f.name))));
    } catch { /* unknown -> off */ }
  }
  return !!(dmmfFields.get(model) && dmmfFields.get(model).has(field));
}
const hideSupported = () => hasField('CandidateResume', 'hiddenAt');
const minFitSupported = () => hasField('Requirement', 'minFit');
const fitSettingsSupported = () => hasField('AppSetting', 'key');

// --- Admin Fit settings ------------------------------------------------------
// The weights are POINTS (the doc's list: mandatory skills 28, good-to-have 7,
// …); they are scaled to sum to 1 inside computeMatch.
const WEIGHT_LABELS = {
  mand: 'Mandatory skills',
  good: 'Good-to-have skills',
  exp: 'Experience',
  relev: 'Relevant experience',
  edu: 'Education',
  loc: 'Location',
  mode: 'Work mode',
  emp: 'Employment type',
  sal: 'Salary',
  notice: 'Notice period',
  jp: 'Job type (permanent / contract)',
  avail: 'Availability',
};
const DEFAULT_POINTS = Object.fromEntries(Object.entries(WEIGHTS).map(([k, v]) => [k, Math.round(v * 100)]));
const FIT_KEY = 'fit';
// B8: the meaning-based part's default weight in points (the 12 weights sum to 100).
const SEMANTIC_DEFAULT_POINTS = 5;
// B8: the version history lives beside the settings: [{ version, weights,
// specBonus, semantic, at, byName }]. v1 = before versioning (never stored).
const VERSIONS_KEY = 'fit.versions';
// What changes a Fit number (defaultMinFit only changes "Eligible", not the score).
const scoringPart = (v) => ({
  weights: v.weights, specBonus: v.specBonus, semantic: v.semantic && v.semantic.on ? { on: true, weight: v.semantic.weight, engine: v.semantic.engine } : { on: false },
});
const SETTINGS_TTL_MS = 30 * 1000;
let settingsCache = null; // { at, value }

function cleanFitSettings(input) {
  const v = input && typeof input === 'object' ? input : {};
  const points = { ...DEFAULT_POINTS };
  if (v.weights && typeof v.weights === 'object') {
    Object.keys(DEFAULT_POINTS).forEach((k) => {
      const n = Number(v.weights[k]);
      if (v.weights[k] !== '' && v.weights[k] != null && Number.isFinite(n) && n >= 0 && n <= 100) points[k] = Math.round(n);
    });
  }
  const min = Number(v.defaultMinFit);
  const sb = Number(v.specBonus);
  // B8: "Match by meaning" — OFF by default; a small weight (points, same
  // scale as the 12 above); engine local (offline) or ai (Ollama embeddings).
  const sv = v.semantic && typeof v.semantic === 'object' ? v.semantic : {};
  const sw = Number(sv.weight);
  const semanticPart = {
    on: sv.on === true || sv.on === 'true' || sv.on === 1,
    weight: sv.weight !== '' && sv.weight != null && Number.isFinite(sw) && sw >= 0 && sw <= 30 ? Math.round(sw) : SEMANTIC_DEFAULT_POINTS,
    engine: sv.engine === 'ai' ? 'ai' : 'local',
  };
  return {
    semantic: semanticPart,
    weights: points,
    // Extra Fit points when the job and the person have the SAME specialisation.
    specBonus: v.specBonus !== '' && v.specBonus != null && Number.isFinite(sb) && sb >= 0 && sb <= 50 ? Math.round(sb) : SPEC_EXACT_BONUS,
    defaultMinFit: v.defaultMinFit !== '' && v.defaultMinFit != null && Number.isFinite(min) && min >= 0 && min <= 100 ? Math.round(min) : ELIGIBLE_THRESHOLD,
  };
}

async function loadFitSettings({ fresh = false } = {}) {
  if (!fresh && settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value;
  let value = cleanFitSettings(null);
  let meta = null;
  let version = 2; // B8: the first versioned setup (v1 = before versioning)
  if (fitSettingsSupported()) {
    try {
      const row = await prisma.appSetting.findUnique({ where: { key: FIT_KEY } });
      if (row) {
        const raw = safeParse(row.value) || {};
        value = cleanFitSettings(raw);
        version = Number.isInteger(Number(raw.version)) && Number(raw.version) >= 2 ? Number(raw.version) : 2;
        meta = { updatedByName: row.updatedByName, updatedAt: row.updatedAt };
      }
    } catch { /* table missing -> defaults */ }
  }
  setActiveWeights(value.weights);
  setActiveSpecBonus(value.specBonus);
  setActiveVersion(version);
  const out = {
    ...value, version, versionCode: versionCode(version), versionLabel: versionLabel(version), meta,
  };
  settingsCache = { at: Date.now(), value: out };
  return out;
}

async function saveFitSettings(input, user) {
  if (!fitSettingsSupported()) throw Object.assign(new Error('NOT_READY'), { code: 'NOT_READY' });
  const value = cleanFitSettings(input);
  if (Object.values(value.weights).reduce((a, b) => a + b, 0) <= 0) throw Object.assign(new Error('ALL_ZERO'), { code: 'ALL_ZERO' });
  const who = { updatedById: user ? user.id : null, updatedByName: user ? user.name : null };
  // B8: a change that moves the Fit numbers starts the next scoring version.
  const before = await loadFitSettings({ fresh: true });
  const changed = JSON.stringify(scoringPart(before)) !== JSON.stringify(scoringPart(value));
  const version = changed ? before.version + 1 : before.version;
  if (changed) {
    const history = await fitVersions();
    const entry = (v, n, at, byName) => ({ version: n, ...scoringPart(v), at, byName });
    if (!history.some((h) => h.version === before.version)) {
      history.push(entry(before, before.version, (before.meta && before.meta.updatedAt) || null, (before.meta && before.meta.updatedByName) || null));
    }
    history.push(entry(value, version, new Date().toISOString(), who.updatedByName));
    await prisma.appSetting.upsert({
      where: { key: VERSIONS_KEY },
      create: { key: VERSIONS_KEY, value: JSON.stringify(history), ...who },
      update: { value: JSON.stringify(history), ...who },
    });
  }
  const stored = JSON.stringify({ ...value, version });
  await prisma.appSetting.upsert({
    where: { key: FIT_KEY },
    create: { key: FIT_KEY, value: stored, ...who },
    update: { value: stored, ...who },
  });
  settingsCache = null;
  const out = await loadFitSettings({ fresh: true });
  return { ...out, versionChanged: changed, previousVersion: before.version };
}

// B8: the scoring versions so far, oldest first (v2 …). v1 is implicit.
async function fitVersions() {
  if (!fitSettingsSupported()) return [];
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: VERSIONS_KEY } });
    const list = row ? safeParse(row.value) : null;
    return Array.isArray(list) ? list.filter((x) => x && Number.isInteger(x.version)) : [];
  } catch { return []; }
}

const defaultMinFit = () => (settingsCache && settingsCache.value ? settingsCache.value.defaultMinFit : ELIGIBLE_THRESHOLD);
function thresholdFor(requirement) {
  const n = requirement ? requirement.minFit : null;
  return n !== null && n !== undefined && n !== '' && Number.isFinite(Number(n)) ? Number(n) : defaultMinFit();
}

// --- current resume per candidate --------------------------------------------
// Map(candidateId -> { resumeId, kind, text, lowerText, parsed })
async function currentResumeEvidence(candidateIds = null) {
  await loadFitSettings().catch(() => null);
  const ids = candidateIds ? [...new Set(candidateIds)] : null;
  const where = { text: { not: null } };
  if (hideSupported()) where.hiddenAt = null; // a file hidden as "wrong person" never scores
  // Large id lists are filtered in JS (SQLite's bound-parameter limit).
  if (ids && ids.length <= 500) where.candidateId = { in: ids };
  const heads = await prisma.candidateResume.findMany({
    where, select: { id: true, candidateId: true, createdAt: true }, orderBy: { createdAt: 'desc' },
  });
  const want = ids && ids.length > 500 ? new Set(ids) : null;
  const latest = new Map();
  heads.forEach((h) => {
    if (want && !want.has(h.candidateId)) return;
    if (!latest.has(h.candidateId)) latest.set(h.candidateId, h.id);
  });
  const out = new Map();
  const rowIds = [...latest.values()];
  for (let i = 0; i < rowIds.length; i += 400) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.candidateResume.findMany({
      where: { id: { in: rowIds.slice(i, i + 400) } },
      select: { id: true, candidateId: true, kind: true, text: true, parsed: true },
    });
    rows.forEach((r) => out.set(r.candidateId, {
      resumeId: r.id, kind: r.kind, text: r.text, lowerText: String(r.text || '').toLowerCase(), parsed: safeParse(r.parsed) || {},
    }));
  }
  return out;
}

// Map(candidateId -> the latest AI interview score on any of their
// applications). Shown BESIDE the Fit; it is never part of Overall and never
// mixed with a client's interview feedback (agent-rules).
async function latestAiScores(candidateIds) {
  const want = new Set(candidateIds || []);
  const out = new Map();
  if (!want.size) return out;
  const rows = await prisma.application.findMany({
    where: { aiInterviewScore: { not: null } },
    select: { candidateId: true, aiInterviewScore: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
  });
  rows.forEach((r) => { if (want.has(r.candidateId) && !out.has(r.candidateId)) out.set(r.candidateId, r.aiInterviewScore); });
  return out;
}

const yrs = (n) => `${n} ${n === 1 ? 'year' : 'years'}`;
const title = (s) => String(s || '').replace(/\b\w/g, (c) => c.toUpperCase());
// One short line under the score. Not eligible: what is missing. Otherwise:
// what fits.
function reasonLine(m) {
  const miss = m.missingSkills || m.missingMandatory || [];
  const missing = miss.slice(0, 3).map(title);
  if (miss.length > 3) missing.push(`${miss.length - 3} more skill${miss.length - 3 > 1 ? 's' : ''}`);
  if (m.expShortYears > 0) missing.push(`${yrs(m.expShortYears)} more experience`);
  else if (m.expNeedMin > 0 && m.expYears == null) missing.push('experience not known');
  const parts = [];
  if (missing.length) parts.push(`Missing: ${missing.join(', ')}`);
  if (m.locationMatched === false) parts.push('Location is far');
  if (!parts.length && m.mandatoryCount === 0 && m.specMatch !== 'exact') return 'Cannot check skills: the job lists no must-have skills yet';
  if (!parts.length) {
    const good = [];
    if ((m.matchedSkills || []).length) good.push('has all must-have skills');
    if (m.expYears != null && m.expNeedMin != null) good.push(`${yrs(m.expYears)} experience fits`);
    if (m.locationMatched) good.push('location fits');
    return good.length ? `Good fit: ${good.join(', ')}` : 'Good fit';
  }
  return parts.join(' · ');
}

// B8: the computeMatch semantic option for one person, or null while "Match
// by meaning" is off (then every number is exactly the old one).
//   sim = { pct, shared } from utils/semanticMatch.js similarities(); without
//   it only the same-meaning skill folding applies.
function semanticOpts(sim) {
  const st = settingsCache && settingsCache.value;
  if (!st || !st.semantic || !st.semantic.on) return null;
  const pts = Object.values(st.weights || {}).reduce((a, b) => a + (Number(b) || 0), 0) || 100;
  return {
    canonical: semantic.canonicalSkill,
    variantsOf: semantic.variantsOf,
    share: sim ? (Number(st.semantic.weight) || 0) / pts : 0,
    pct: sim ? sim.pct : null,
    shared: sim ? sim.shared : [],
  };
}
const semanticOn = () => !!(settingsCache && settingsCache.value && settingsCache.value.semantic && settingsCache.value.semantic.on);

function threeNumbers(candidate, requirement, evidence, threshold, sim) {
  const so = semanticOpts(sim);
  const m = computeMatch(candidate, requirement, { ...(evidence ? { resume: evidence } : {}), ...(so ? { semantic: so } : {}) });
  const min = threshold != null ? threshold : thresholdFor(requirement);
  const el = eligibilityOf(m, min);
  return {
    overall: m.overall,
    // B8: the version that produced this number, the meaning-based part.
    fitVersion: m.fitVersion,
    versionLabel: versionLabel(getActiveVersion()),
    semanticPct: m.semanticPct,
    sameMeaningSkills: m.sameMeaningSkills,
    reasons: m.reasons,
    gaps: m.gaps,
    resumePct: m.resumePct,
    locationPct: m.locPct,
    resumeSource: m.resumeSource,
    locationReason: m.locReason,
    matchedSkills: m.matchedSkills,
    missingMandatory: m.missingSkills,
    expReason: m.expReason,
    eduReason: m.eduReason,
    minFit: min,
    eligible: el.eligible,
    notEligibleBecause: el.why,
    reason: reasonLine(m),
  };
}

// ?minMatch / ?sort / ?eligibleOnly shared by both list endpoints.
function listOptions(query) {
  const minMatch = query.minMatch !== undefined && query.minMatch !== '' ? Math.max(0, Math.min(100, Number(query.minMatch) || 0)) : defaultMinFit();
  const sort = ['overall', 'resume', 'location', 'ai', 'name'].includes(query.sort) ? query.sort : 'overall';
  const eligibleOnly = /^(1|true|yes)$/i.test(String(query.eligibleOnly || ''));
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
  return { minMatch, sort, eligibleOnly, limit };
}

const SORT_KEY = { overall: 'overall', resume: 'resumePct', location: 'locationPct' };
function sortRows(rows, sort) {
  // AI score (people without one last) and name live on the row, not in .match.
  if (sort === 'ai') return rows.sort((a, b) => ((b.aiScore ?? -1) - (a.aiScore ?? -1)) || (b.match.overall - a.match.overall));
  if (sort === 'name') return rows.sort((a, b) => String(a.name || a.title || '').localeCompare(String(b.name || b.title || '')));
  const k = SORT_KEY[sort] || 'overall';
  return rows.sort((a, b) => (b.match[k] - a.match[k]) || (b.match.overall - a.match.overall) || (Number(b.match.eligible) - Number(a.match.eligible)));
}

// B8: what is STORED with a Fit on an application — the version, the weights
// used, the explanation and the eligibility at that moment.
function scoreSnapshot(match, extra = {}) {
  const st = (settingsCache && settingsCache.value) || {};
  return {
    version: match.fitVersion || versionCode(getActiveVersion()),
    weights: st.weights || DEFAULT_POINTS,
    specBonus: st.specBonus != null ? st.specBonus : SPEC_EXACT_BONUS,
    semantic: st.semantic && st.semantic.on ? { on: true, weight: st.semantic.weight, engine: extra.engine || st.semantic.engine, pct: match.semanticPct ?? null } : { on: false },
    overall: match.overall,
    resumeSource: match.resumeSource || null,
    reasons: (match.reasons || []).slice(0, 12),
    gaps: (match.gaps || []).slice(0, 12),
    eligible: match.eligible,
    notEligibleBecause: match.notEligibleBecause || [],
    minFit: match.minFit,
    at: new Date().toISOString(),
    ...extra,
  };
}
const versionFields = () => hasField('Application', 'matchVersion');

module.exports = {
  semanticOpts, semanticOn, scoreSnapshot, versionFields, fitVersions, SEMANTIC_DEFAULT_POINTS,
  versionLabel: (n) => versionLabel(n === undefined ? getActiveVersion() : n), versionCode: (n) => versionCode(n === undefined ? getActiveVersion() : n), getActiveVersion,
  currentResumeEvidence, latestAiScores, threeNumbers, thresholdFor, reasonLine, listOptions, sortRows, ELIGIBLE_THRESHOLD,
  loadFitSettings, saveFitSettings, cleanFitSettings, fitSettingsSupported, hideSupported, minFitSupported, hasField,
  WEIGHT_LABELS, DEFAULT_POINTS, getActiveWeights,
};
