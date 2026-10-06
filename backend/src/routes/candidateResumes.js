// ---------------------------------------------------------------------------
// CANDIDATE RESUMES (resume_) — /api/candidate-resumes
//
//   GET  /:id                          versions (originals + edited) + rights
//   GET  /:id/version/:rid             one version's text / sections / parsed
//   GET  /:id/file/:rid?format=&download=1   the bytes (auth + scope checked)
//   POST /:id/upload                   multipart "file": a NEW original
//   POST /:id/edit                     { sections, baseResumeId } -> Edited vN
//   GET  /:id/eligible-requirements    3-number match, candidate -> requirements
//   GET  /requirement/:reqId/matches   3-number match, requirement -> candidates
//
// WHO SEES WHAT
//   * The candidate record's scope is routes/candidates.js loadInScope() —
//     the same rule as the profile itself (a recruiter their own, a TL their
//     team's, a client only profiles SHARED with them). Out of scope = 403.
//   * ORIGINAL files and the extracted/parsed data are INTERNAL. A client is
//     served only the LATEST EDITED version, rendered with phone / e-mail /
//     address removed. A candidate login gets nothing here.
//   * Upload: the edit roles below, or anyone holding Candidate Master edit.
//     Edit: Recruiter (own — i.e. in scope), TL / STL, Manager, Admin,
//     Super Admin (the user's list for this feature).
//   * Originals are immutable: no route here overwrites or deletes one.
//   * Every upload, edit and download is written to the audit log.
// ---------------------------------------------------------------------------
const express = require('express');
const fs = require('fs');
const prisma = require('../db');
const { requireAuth, requirePerm, requireProduct, can } = require('../middleware/auth');
const { roleForProduct } = require('../utils/permissions');
const {
  requirementWhere, candidateWhere, matches, OUT_OF_SCOPE,
} = require('../utils/scope');
const { REQUIREMENT_LIVE_STATUSES, requirementIsLive } = require('../utils/atsVocab');
const store = require('../utils/resumeStore');
const docs = require('../utils/resumeDocs');
const rm = require('../utils/resumeMatch');
const { parseResumeText, resumeOwnerCheck } = require('../utils/resumeParse');
const { logAudit } = require('../utils/audit');
// B8: meaning-based matching (off by default; Admin → Fit settings).
const semantic = require('../utils/semanticMatch');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));

// Lazy: routes/candidates.js is a big module already loaded by index.js.
const cand = () => require('./candidates'); // eslint-disable-line global-require

const EDIT_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'TL', 'STL', 'RECRUITER']);
async function rightsFor(user, kind) {
  if (kind !== 'internal') return { canEdit: false, canUpload: false };
  const role = roleForProduct(user, 'ats');
  const canEdit = EDIT_ROLES.has(role);
  const canUpload = canEdit || await can(user, 'ats', 'candidates', 'Candidate Master', 'edit');
  return { canEdit, canUpload };
}

const META_SELECT = {
  id: true, candidateId: true, kind: true, baseResumeId: true, file: true, fileName: true, mime: true, size: true,
  docxFile: true, parsed: true, parser: true, createdByName: true, createdAt: true,
};
// "Wrong file — hide it" columns (migration 2026-10-03, run by main). Until
// the Prisma client knows them, hiding is simply not offered.
const HIDE_SELECT = { hiddenAt: true, hiddenByName: true, hiddenReason: true };
const metaSelect = () => (rm.hideSupported() ? { ...META_SELECT, ...HIDE_SELECT } : META_SELECT);

// All versions oldest-first, numbered per kind (v1, v2 … by createdAt).
// Hidden ("wrong file") versions keep their number, so "Original v2" always
// means the same file in the audit log.
async function versionsOf(candidateId) {
  const rows = await prisma.candidateResume.findMany({ where: { candidateId }, select: metaSelect(), orderBy: { createdAt: 'asc' } });
  const n = { ORIGINAL: 0, EDITED: 0 };
  return rows.map((r) => {
    n[r.kind] = (n[r.kind] || 0) + 1;
    return { ...r, version: n[r.kind], label: `${r.kind === 'EDITED' ? 'Edited resume' : 'Original'} v${n[r.kind]}` };
  });
}
const visible = (versions) => versions.filter((v) => !v.hiddenAt);

// What the resume says about whose it is, against the profile.
function ownerOf(r, candidate) {
  const parsed = store.safeParse(r.parsed);
  if (!parsed || r.kind !== 'ORIGINAL') return null;
  const chk = resumeOwnerCheck(parsed, candidate);
  return { ok: chk.ok, soft: !!chk.soft, resumeSays: chk.identity };
}

function metaFor(r, internal) {
  const parsed = store.safeParse(r.parsed) || {};
  const out = {
    id: r.id,
    kind: r.kind,
    version: r.version,
    label: r.label,
    fileName: r.kind === 'EDITED' ? `${r.label}.pdf` : r.fileName,
    mime: r.kind === 'EDITED' ? 'application/pdf' : r.mime,
    format: r.kind === 'EDITED' ? 'pdf' : (r.mime === 'application/pdf' ? 'pdf' : (r.mime === 'application/msword' ? 'doc' : 'docx')),
    size: r.kind === 'EDITED' ? null : r.size,
    hasPdf: r.kind === 'EDITED' ? !!r.file : r.mime === 'application/pdf',
    hasDocx: r.kind === 'EDITED' ? !!r.docxFile : false,
    createdAt: r.createdAt,
  };
  if (!internal) return out;
  return {
    ...out,
    hidden: !!r.hiddenAt,
    hiddenAt: r.hiddenAt || null,
    hiddenByName: r.hiddenByName || null,
    hiddenReason: r.hiddenReason || null,
    baseResumeId: r.baseResumeId,
    createdByName: r.createdByName,
    parser: r.parser,
    extractError: parsed.extractError || null,
    parsed: r.kind === 'ORIGINAL' || r.kind === 'EDITED' ? {
      skills: parsed.skills || [],
      totalExperienceYears: parsed.totalExperienceYears ?? null,
      experienceSource: parsed.experienceSource || null,
      education: parsed.education || [],
      highestEducation: parsed.highestEducation || null,
      location: parsed.location || null,
      emails: parsed.emails || [],
      phones: parsed.phones || [],
      name: parsed.name || null,
    } : null,
  };
}

// Loads the candidate in the viewer's scope (or answers 403/404).
async function load(req, res) {
  const loaded = await cand().loadInScope(req, res);
  if (!loaded) return null;
  const kind = cand().viewerKind(req.user);
  if (kind === 'candidate') {
    res.status(403).json({ error: 'Resumes are managed by TeamLink.' });
    return null;
  }
  return { ...loaded, kind, internal: kind === 'internal' };
}

const latestEdited = (versions) => visible(versions).filter((v) => v.kind === 'EDITED').slice(-1)[0] || null;

const candidateView = requirePerm('ats', 'candidates', 'Candidate List', 'view');

// --- 3-number match: requirement -> candidates ------------------------------
const MATCH_SELECT = {
  id: true, name: true, location: true, preferredLocation: true, experienceYears: true, relevantExperienceYears: true,
  skills: true, education: true, availability: true, currentSalary: true, expectedSalary: true, jobPreference: true,
  noticePeriod: true, preferredEmploymentType: true, preferredWorkMode: true,
  specialisationId: true, // spec D: exact specialisation match bonus
  specialization: true, // fit_: counts as a skill (a job with no skills uses its specialisation)
  // B8 semantic text (never the name / contact details beyond what the list shows)
  technicalSkills: true, goodToHaveSkills: true, currentDesignation: true,
};
router.get('/requirement/:reqId/matches', requirePerm('ats', 'requirements', 'Matching Candidates', 'view'), async (req, res) => {
  if (cand().viewerKind(req.user) !== 'internal') return res.status(403).json({ error: 'Matching is internal to TeamLink.' });
  const requirement = await prisma.requirement.findUnique({ where: { id: req.params.reqId } });
  if (!requirement) return res.status(404).json({ error: 'Requirement not found' });
  if (!matches(requirement, requirementWhere(req.user))) return res.status(403).json(OUT_OF_SCOPE);
  const opts = rm.listOptions(req.query);
  // SCOPED: only candidates this login may see (the earlier leak fix).
  const [candidates, linked] = await Promise.all([
    prisma.candidate.findMany({ where: candidateWhere(req.user), select: MATCH_SELECT }),
    prisma.application.findMany({ where: { requirementId: requirement.id }, select: { candidateId: true } }),
  ]);
  const linkedIds = new Set(linked.map((a) => a.candidateId));
  // REJECTIONS (spec 2026-10-03 §A2, utils/rejections.js): [Matching] is NEW
  // candidates only. Anyone rejected on another requirement is listed under
  // [Previously rejected, but match] (GET /api/rejections/requirement/:id/tabs,
  // the same threeNumbers() scorer). A "Do not use" person is never addable.
  const rjIx = await require('../utils/rejections').index(); // eslint-disable-line global-require
  const pool = candidates.filter((c) => !linkedIds.has(c.id) && !rjIx.byCandidate.has(c.id));
  const evidence = await rm.currentResumeEvidence(pool.map((c) => c.id));
  // AI score = the person's latest AI interview score on any job (shown
  // beside the Fit, NEVER inside it, never mixed with client feedback).
  const aiScores = await rm.latestAiScores(pool.map((c) => c.id));
  // B8: the meaning-based part, only while the Admin has it switched on.
  const sims = rm.semanticOn()
    ? await semantic.similarities(requirement, pool, evidence, { user: req.user, settings: await rm.loadFitSettings() })
    : { engine: 'off', why: null, map: new Map() };
  let rows = pool.map((c) => ({
    aiScore: aiScores.get(c.id) ?? null,
    doNotUse: rjIx.doNotUse.get(c.id) || null,
    blocked: rjIx.doNotUse.get(c.id) === 'approved',
    id: c.id,
    name: c.name,
    location: c.location,
    preferredLocation: c.preferredLocation,
    experienceYears: c.experienceYears,
    hasResume: evidence.has(c.id),
    match: rm.threeNumbers(c, requirement, evidence.get(c.id), undefined, sims.map.get(c.id)),
  })).filter((r) => r.match.overall >= opts.minMatch);
  const eligibleCount = rows.filter((r) => r.match.eligible).length;
  const total = rows.length;
  if (opts.eligibleOnly) rows = rows.filter((r) => r.match.eligible);
  rm.sortRows(rows, opts.sort);
  const canAdd = requirementIsLive(requirement.status) && await can(req.user, 'ats', 'candidates', 'Applications', 'create');
  const canSetMinFit = rm.minFitSupported() && await can(req.user, 'ats', 'requirements', 'Requirement Detail', 'edit');
  return res.json({
    threshold: rm.thresholdFor(requirement),
    minFitIsDefault: requirement.minFit == null,
    canSetMinFit,
    ...opts, total, eligible: eligibleCount, shown: Math.min(rows.length, opts.limit), rows: rows.slice(0, opts.limit), canAdd,
    fitVersion: rm.versionLabel(),
    semantic: { on: sims.engine !== 'off', engine: sims.engine, why: sims.why },
  });
});

// --- the job's own minimum Fit % (Eligible = Overall >= this) -----------------
// Body { minFit: 0..100 } or { minFit: null } = back to the Admin default.
router.put('/requirement/:reqId/min-fit', requirePerm('ats', 'requirements', 'Requirement Detail', 'edit'), async (req, res) => {
  if (cand().viewerKind(req.user) !== 'internal') return res.status(403).json({ error: 'Only TeamLink staff can change this.' });
  if (!rm.minFitSupported()) return res.status(503).json({ error: 'This setting is being set up. Please try again later.' });
  const requirement = await prisma.requirement.findUnique({ where: { id: req.params.reqId } });
  if (!requirement) return res.status(404).json({ error: 'Job not found' });
  if (!matches(requirement, requirementWhere(req.user))) return res.status(403).json(OUT_OF_SCOPE);
  const raw = req.body ? req.body.minFit : undefined;
  let minFit = null;
  if (raw !== null && raw !== '' && raw !== undefined) {
    minFit = Number(raw);
    if (!Number.isInteger(minFit) || minFit < 0 || minFit > 100) return res.status(400).json({ error: 'Minimum Fit must be a whole number from 0 to 100.' });
  }
  const before = requirement.minFit;
  await prisma.requirement.update({ where: { id: requirement.id }, data: { minFit } });
  await rm.loadFitSettings().catch(() => null);
  const shown = minFit == null ? `${rm.thresholdFor({ minFit: null })}% (default)` : `${minFit}%`;
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: 'Minimum Fit changed', entity: 'Requirement', entityId: requirement.id,
    fromValue: before == null ? 'default' : `${before}%`, toValue: shown,
  });
  return res.json({ ok: true, minFit, threshold: rm.thresholdFor({ minFit }), message: `Saved. Eligible now means Fit ${shown} or more.` });
});

// --- Admin: Fit weights + the default minimum -----------------------------------
const isAdmin = (user) => ['SUPER_ADMIN', 'ADMIN'].includes(roleForProduct(user, 'ats')) || ['SUPER_ADMIN', 'ADMIN'].includes(user.role);
router.get('/fit-settings', async (req, res) => {
  if (cand().viewerKind(req.user) !== 'internal') return res.status(403).json({ error: 'Only TeamLink staff can see this.' });
  const s = await rm.loadFitSettings({ fresh: true });
  return res.json({
    ...s,
    defaults: { weights: rm.DEFAULT_POINTS, defaultMinFit: rm.ELIGIBLE_THRESHOLD, specBonus: require('../utils/matching').SPEC_EXACT_BONUS }, // eslint-disable-line global-require
    labels: rm.WEIGHT_LABELS,
    canEdit: isAdmin(req.user) && rm.fitSettingsSupported(),
    ready: rm.fitSettingsSupported(),
    // B8: scoring versions (v1 = before versioning) + the meaning-based engine.
    versions: await rm.fitVersions(),
    semanticInfo: await semanticInfo(req.user, s),
  });
});
// B8: which meaning-based engine runs, on this machine and for this login.
async function semanticInfo(user, settings) {
  const [machine, pick, aiAllowed] = await Promise.all([
    semantic.machineStatus(), semantic.engineFor(user, settings), semantic.aiAllowedFor(user),
  ]);
  return {
    machine: {
      ollamaReachable: machine.ollamaReachable, embedModel: machine.embedModel, modelPulled: machine.modelPulled, aiReady: machine.aiReady, summary: machine.summary,
    },
    engineNow: pick.engine,
    why: pick.why,
    youHaveAiAccess: aiAllowed,
    index: semantic.status(),
  };
}
router.put('/fit-settings', async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only an Admin can change the Fit settings.' });
  const before = await rm.loadFitSettings({ fresh: true });
  try {
    // B8: the AI engine sends profile text to the AI model — only an Admin
    // who holds the Role Catalog AI grant for ATS data may choose it.
    const want = (req.body && req.body.semantic) || {};
    if (want.on && want.engine === 'ai' && !(before.semantic && before.semantic.on && before.semantic.engine === 'ai') && !(await semantic.aiAllowedFor(req.user))) {
      return res.status(403).json({ error: 'Your role has no AI access for ATS data (Administration → Role Catalog → AI Assistant & Agent), so you cannot choose the AI engine. The built-in offline engine works without it.' });
    }
    const s = await rm.saveFitSettings(req.body || {}, req.user);
    const pick = ({ weights, defaultMinFit, specBonus, semantic: sem }) => ({ weights, defaultMinFit, specBonus, semantic: sem });
    await logAudit({
      userId: req.user.id, actorName: req.user.name, action: s.versionChanged ? 'Fit settings changed — new scoring version' : 'Fit settings changed', entity: 'AppSetting', entityId: 'fit',
      fromValue: JSON.stringify({ version: `fit-v${s.previousVersion}`, ...pick(before) }),
      toValue: JSON.stringify({ version: s.versionCode, ...pick(s) }),
    });
    // Switching "Match by meaning" on builds the index in the background.
    if (s.semantic && s.semantic.on) semantic.buildIndex({ user: req.user, settings: s }).catch(() => null);
    return res.json({
      ...s,
      versions: await rm.fitVersions(),
      semanticInfo: await semanticInfo(req.user, s),
      message: s.versionChanged
        ? `Saved. New scoring version ${s.versionLabel}: Fit numbers from now on use these settings. Fits saved before keep their own version.`
        : 'Saved. The Fit numbers do not change (same scoring version).',
    });
  } catch (err) {
    if (err.code === 'NOT_READY') return res.status(503).json({ error: 'This setting is being set up. Please try again later.' });
    if (err.code === 'ALL_ZERO') return res.status(400).json({ error: 'At least one weight must be more than 0.' });
    throw err;
  }
});

// --- B8: meaning-based matching -------------------------------------------------
router.get('/semantic/status', async (req, res) => {
  if (cand().viewerKind(req.user) !== 'internal') return res.status(403).json({ error: 'Only TeamLink staff can see this.' });
  const s = await rm.loadFitSettings();
  return res.json({ on: !!(s.semantic && s.semantic.on), ...(await semanticInfo(req.user, s)) });
});
router.post('/semantic/build', async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only an Admin can rebuild the matching index.' });
  const s = await rm.loadFitSettings({ fresh: true });
  if (!s.semantic || !s.semantic.on) return res.status(409).json({ error: 'Turn on "Match by meaning" first.' });
  const st = await semantic.buildIndex({ user: req.user, settings: s });
  return res.json({ ok: true, index: st, message: 'Building in the background. You can keep working.' });
});

// "Similar candidates" on the job page: people in this login's area, not on
// the job yet, most similar in MEANING first. Paginated (?page=1&limit=20).
router.get('/requirement/:reqId/similar', requirePerm('ats', 'requirements', 'Matching Candidates', 'view'), async (req, res) => {
  if (cand().viewerKind(req.user) !== 'internal') return res.status(403).json({ error: 'Matching is internal to TeamLink.' });
  const settings = await rm.loadFitSettings();
  if (!settings.semantic || !settings.semantic.on) return res.json({ on: false, rows: [], total: 0 });
  const requirement = await prisma.requirement.findUnique({ where: { id: req.params.reqId } });
  if (!requirement) return res.status(404).json({ error: 'Job not found' });
  if (!matches(requirement, requirementWhere(req.user))) return res.status(403).json(OUT_OF_SCOPE);
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const [candidates, linked] = await Promise.all([
    prisma.candidate.findMany({ where: candidateWhere(req.user), select: { ...MATCH_SELECT, profileStatus: true } }),
    prisma.application.findMany({ where: { requirementId: requirement.id }, select: { candidateId: true } }),
  ]);
  const linkedIds = new Set(linked.map((a) => a.candidateId));
  const rjm = require('../utils/rejections'); // eslint-disable-line global-require
  const pool = candidates.filter((c) => !linkedIds.has(c.id) && c.profileStatus !== rjm.DNU_STATUS);
  const evidence = await rm.currentResumeEvidence(pool.map((c) => c.id));
  const sims = await semantic.similarities(requirement, pool, evidence, { user: req.user, settings });
  const minSim = Math.max(0, Math.min(100, Number(req.query.minSimilar) || 40));
  const ranked = pool.map((c) => ({ c, s: sims.map.get(c.id) })).filter((x) => x.s && x.s.pct >= minSim)
    .sort((a, b) => b.s.sim - a.s.sim);
  const slice = ranked.slice((page - 1) * limit, page * limit);
  const canAdd = requirementIsLive(requirement.status) && await can(req.user, 'ats', 'candidates', 'Applications', 'create');
  return res.json({
    on: true,
    engine: sims.engine,
    why: sims.why,
    page, limit, total: ranked.length, pages: Math.max(1, Math.ceil(ranked.length / limit)), minSimilar: minSim, canAdd,
    rows: slice.map(({ c, s: sim }) => ({
      id: c.id, name: c.name, location: c.location, experienceYears: c.experienceYears, hasResume: evidence.has(c.id),
      similarPct: sim.pct, shared: sim.shared,
      match: rm.threeNumbers(c, requirement, evidence.get(c.id), undefined, sim),
    })),
  });
});

// --- versions -----------------------------------------------------------------
router.get('/:id', candidateView, async (req, res) => {
  const ctx = await load(req, res);
  if (!ctx) return undefined;
  const versions = await versionsOf(req.params.id);
  if (!ctx.internal) {
    const e = latestEdited(versions);
    return res.json({ viewer: 'client', originals: [], edited: e ? [metaFor(e, false)] : [], canEdit: false, canUpload: false });
  }
  const rights = await rightsFor(req.user, ctx.kind);
  const withOwner = (v) => ({ ...metaFor(v, true), owner: ownerOf(v, ctx.candidate) });
  const shown = visible(versions);
  return res.json({
    viewer: 'internal',
    // Newest first. Hidden ("wrong file") versions are listed separately —
    // kept for audit, never current, never shown to a client.
    originals: shown.filter((v) => v.kind === 'ORIGINAL').map(withOwner).reverse(),
    edited: shown.filter((v) => v.kind === 'EDITED').map(withOwner).reverse(),
    hiddenVersions: versions.filter((v) => v.hiddenAt).map(withOwner).reverse(),
    ...rights,
    canHide: rights.canUpload && rm.hideSupported(),
    maxBytes: store.RESUME_MAX_BYTES,
    threshold: rm.ELIGIBLE_THRESHOLD,
  });
});

router.get('/:id/version/:rid', candidateView, async (req, res) => {
  const ctx = await load(req, res);
  if (!ctx) return undefined;
  const versions = await versionsOf(req.params.id);
  const v = versions.find((x) => x.id === req.params.rid);
  if (!v) return res.status(404).json({ error: 'Resume version not found' });
  const row = await prisma.candidateResume.findUnique({ where: { id: v.id }, select: { text: true, sections: true } });
  const name = ctx.candidate.name;
  if (!ctx.internal) {
    const e = latestEdited(versions);
    if (!e || e.id !== v.id) return res.status(403).json({ error: 'Only the edited resume is shared with clients.' });
    const sections = store.safeParse(row.sections) || {};
    return res.json({ ...metaFor(v, false), text: docs.renderPlainText(sections, { name }) });
  }
  const sections = v.kind === 'EDITED' ? docs.cleanSections(store.safeParse(row.sections) || {}) : null;
  return res.json({
    ...metaFor(v, true),
    text: row.text || '',
    sections,
    // What the editor opens with: an edited version's own sections, or the
    // original's text split into sections.
    draftSections: sections || docs.sectionsFromText(row.text || '', store.safeParse(v.parsed) || {}),
    clientText: v.kind === 'EDITED' ? docs.renderPlainText(sections, { name }) : null,
  });
});

function contentDisposition(type, name) {
  const ascii = String(name || 'resume').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name || 'resume')}`;
}

router.get('/:id/file/:rid', candidateView, async (req, res) => {
  const ctx = await load(req, res);
  if (!ctx) return undefined;
  const versions = await versionsOf(req.params.id);
  const v = versions.find((x) => x.id === req.params.rid);
  if (!v) return res.status(404).json({ error: 'Resume version not found' });
  if (!ctx.internal) {
    // Clients: the latest EDITED version only — never an original.
    const e = latestEdited(versions);
    if (v.kind !== 'EDITED' || !e || e.id !== v.id) return res.status(403).json({ error: 'Only the edited resume is shared with clients.' });
  }
  const format = String(req.query.format || '').toLowerCase();
  let stored; let mime; let fileName;
  if (v.kind === 'ORIGINAL') {
    stored = v.file; mime = v.mime; fileName = v.fileName;
  } else if (format === 'docx') {
    stored = v.docxFile; mime = store.KINDS.docx.mime; fileName = `${ctx.candidate.name} - ${v.label}.docx`;
  } else {
    stored = v.file; mime = 'application/pdf'; fileName = `${ctx.candidate.name} - ${v.label}.pdf`;
  }
  const full = store.resolveResumeFile(stored);
  if (!full) return res.status(404).json({ error: 'The stored file is missing.' });
  const download = /^(1|true|yes)$/i.test(String(req.query.download || ''));
  if (download || !ctx.internal) {
    await logAudit({
      userId: req.user.id,
      actorName: req.user.name,
      action: `Resume ${download ? 'downloaded' : 'viewed by client'} (${v.label}${v.kind === 'EDITED' ? `, ${format === 'docx' ? 'DOCX' : 'PDF'}` : ''})`,
      entity: 'Candidate',
      entityId: req.params.id,
      toValue: fileName,
    });
  }
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', contentDisposition(download || mime !== 'application/pdf' ? 'attachment' : 'inline', fileName));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return fs.createReadStream(full).pipe(res);
});

// --- upload (a NEW original; nothing is overwritten) ---------------------------
router.post('/:id/upload', candidateView, async (req, res) => {
  const ctx = await load(req, res);
  if (!ctx) return undefined;
  const rights = await rightsFor(req.user, ctx.kind);
  if (!rights.canUpload) return res.status(403).json({ error: 'You cannot upload resumes for this candidate.' });
  let parsedBody;
  try {
    parsedBody = await store.parseResumeUpload(req);
  } catch (err) {
    const code = err && err.code;
    return res.status(code === 'TOO_LARGE' ? 413 : 400).json({ error: store.RESUME_MESSAGE[code] || 'Upload failed.' });
  }
  try {
    const row = await store.saveOriginalResume({ candidateId: req.params.id, file: parsedBody.file, user: req.user });
    const versions = await versionsOf(req.params.id);
    const v = versions.find((x) => x.id === row.id);
    // Wrong-person check (user, 2026-10-03): the resume's phone / e-mail /
    // name against the profile. The file is still stored (nothing is lost);
    // the answer says so loudly and the audit log records it.
    const owner = ownerOf(v, ctx.candidate);
    const ownerMismatch = !!(owner && !owner.ok);
    if (ownerMismatch) {
      const says = owner.resumeSays || {};
      await logAudit({
        userId: req.user.id,
        actorName: req.user.name,
        action: `Resume may belong to someone else (${v.label})`,
        entity: 'Candidate',
        entityId: req.params.id,
        fromValue: [ctx.candidate.name, ctx.candidate.phone, ctx.candidate.email].filter(Boolean).join(' · '),
        toValue: [says.name, says.phone, says.email].filter(Boolean).join(' · ') || v.fileName,
      });
    }
    return res.status(201).json({
      resume: { ...metaFor(v, true), owner },
      extractError: row.extractError || null,
      ownerMismatch,
      resumeSays: ownerMismatch ? owner.resumeSays : undefined,
      canHide: rights.canUpload && rm.hideSupported(),
    });
  } catch (err) {
    const code = err && err.code;
    if (store.RESUME_MESSAGE[code]) return res.status(code === 'TOO_LARGE' ? 413 : 400).json({ error: store.RESUME_MESSAGE[code] });
    throw err;
  }
});

// --- "This is the wrong file — hide it" (and Undo) ------------------------------
// The row and the file on disk are KEPT (audit; originals are never deleted or
// overwritten). A hidden version is not current, never scores a Fit, and is
// never shown to a client. The profile's "Resume" name goes back to the newest
// file still shown.
async function syncResumeName(candidateId) {
  const rows = await prisma.candidateResume.findMany({
    where: { candidateId, kind: 'ORIGINAL', hiddenAt: null }, select: { fileName: true }, orderBy: { createdAt: 'desc' }, take: 1,
  });
  await prisma.candidate.update({ where: { id: candidateId }, data: { resumeName: rows[0] ? rows[0].fileName : null } }).catch(() => null);
  try { require('../utils/candidateListCache').markCandidateDirty(candidateId); } catch { /* optional */ } // eslint-disable-line global-require
}

async function setHidden(req, res, hide) {
  const ctx = await load(req, res);
  if (!ctx) return undefined;
  const rights = await rightsFor(req.user, ctx.kind);
  if (!rights.canUpload) return res.status(403).json({ error: 'You cannot change resumes for this candidate.' });
  if (!rm.hideSupported()) return res.status(503).json({ error: 'Hiding a file is being set up. Please try again later.' });
  const versions = await versionsOf(req.params.id);
  const v = versions.find((x) => x.id === req.params.rid);
  if (!v) return res.status(404).json({ error: 'Resume version not found' });
  if (hide && v.hiddenAt) return res.json({ ok: true, message: `${v.label} is already hidden.` });
  if (!hide && !v.hiddenAt) return res.json({ ok: true, message: `${v.label} is already shown.` });
  const reason = String((req.body && req.body.reason) || 'Wrong file (another person\'s resume)').trim().slice(0, 300);
  await prisma.candidateResume.update({
    where: { id: v.id },
    data: hide
      ? { hiddenAt: new Date(), hiddenById: req.user.id, hiddenByName: req.user.name, hiddenReason: reason }
      : { hiddenAt: null, hiddenById: null, hiddenByName: null, hiddenReason: null },
  });
  if (v.kind === 'ORIGINAL') await syncResumeName(req.params.id);
  await logAudit({
    userId: req.user.id,
    actorName: req.user.name,
    action: hide ? `Resume hidden as wrong file (${v.label})` : `Hidden resume shown again (${v.label})`,
    entity: 'Candidate',
    entityId: req.params.id,
    fromValue: v.fileName,
    toValue: hide ? reason : 'shown',
    reason: hide ? reason : null,
  });
  return res.json({
    ok: true,
    message: hide ? `Hidden. ${v.label} is kept for the record but is no longer this person's resume.` : `${v.label} is shown again.`,
  });
}
router.post('/:id/hide/:rid', candidateView, (req, res) => setHidden(req, res, true));
router.post('/:id/unhide/:rid', candidateView, (req, res) => setHidden(req, res, false));

// --- edit -> Edited vN + TeamLink-format PDF / DOCX ----------------------------
router.post('/:id/edit', candidateView, async (req, res) => {
  const ctx = await load(req, res);
  if (!ctx) return undefined;
  const rights = await rightsFor(req.user, ctx.kind);
  if (!rights.canEdit) return res.status(403).json({ error: 'You cannot edit resumes for this candidate.' });
  const sections = docs.cleanSections(req.body && req.body.sections);
  if (!docs.SECTION_KEYS.some((k) => sections[k])) return res.status(400).json({ error: 'The edited resume is empty.' });
  let baseResumeId = (req.body && req.body.baseResumeId) || null;
  if (baseResumeId) {
    const base = await prisma.candidateResume.findFirst({ where: { id: baseResumeId, candidateId: req.params.id }, select: { id: true, kind: true, baseResumeId: true } });
    if (!base) return res.status(400).json({ error: 'The version you edited from is not on this candidate.' });
    // Always point at the ORIGINAL the edit descends from.
    baseResumeId = base.kind === 'ORIGINAL' ? base.id : (base.baseResumeId || null);
  }
  const versionNo = (await prisma.candidateResume.count({ where: { candidateId: req.params.id, kind: 'EDITED' } })) + 1;
  const label = `Edited resume v${versionNo}`;
  const name = ctx.candidate.name;
  const [pdf, docx] = await Promise.all([
    docs.buildPdf({ name, sections, versionLabel: label }),
    docs.buildDocx({ name, sections, versionLabel: label }),
  ]);
  const fullText = ['headline', 'summary', 'skills', 'experience', 'education', 'other'].map((k) => sections[k]).filter(Boolean).join('\n\n');
  const parsed = await parseResumeText(fullText);
  const pdfName = store.writeStored(pdf, 'pdf');
  const docxName = store.writeStored(docx, 'docx');
  const row = await prisma.candidateResume.create({
    data: {
      candidateId: req.params.id,
      kind: 'EDITED',
      baseResumeId,
      file: pdfName,
      fileName: `${label}.pdf`,
      mime: 'application/pdf',
      size: pdf.length,
      docxFile: docxName,
      text: docs.renderPlainText(sections, { name }),
      sections: JSON.stringify(sections),
      parsed: JSON.stringify(parsed),
      parser: 'free',
      createdById: req.user.id,
      createdByName: req.user.name,
    },
  });
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: `Resume edited (${label})`, entity: 'Candidate', entityId: req.params.id, toValue: `${label} · PDF + DOCX generated`,
  });
  const versions = await versionsOf(req.params.id);
  return res.status(201).json({ resume: metaFor(versions.find((x) => x.id === row.id), true) });
});

// --- 3-number match: candidate -> requirements ------------------------------
router.get('/:id/eligible-requirements', candidateView, async (req, res) => {
  const ctx = await load(req, res);
  if (!ctx) return undefined;
  if (!ctx.internal) return res.status(403).json({ error: 'This list is internal to TeamLink.' });
  const opts = rm.listOptions(req.query);
  const open = await prisma.requirement.findMany({
    where: { status: { in: REQUIREMENT_LIVE_STATUSES }, ...requirementWhere(req.user) },
    select: {
      id: true, reqCode: true, title: true, internal: true, location: true, status: true,
      skills: true, goodToHaveSkills: true, experience: true, education: true, workMode: true, employmentType: true,
      specialisation: true, // fit_: the must-have when no skills are typed in
      salary: true, joiningTimeline: true, jobPreference: true,
      clientId: true,
      specialisationId: true, // spec D: exact specialisation match bonus
      ...(rm.minFitSupported() ? { minFit: true } : {}), // the job's own minimum Fit %
      client: { select: { name: true } },
      // B8 semantic: the words that say what the job is (read only when it is on)
      department: true, description: true, jobDescription: true, responsibilities: true, qualifications: true,
    },
  });
  // REJECTIONS (spec 2026-10-03 §A2, utils/rejections.js): a requirement this
  // person was REJECTED for stays in the list, flagged and not addable; one
  // whose client rejected them on another job is flagged too.
  const rjm = require('../utils/rejections'); // eslint-disable-line global-require
  const rjIx = await rjm.index();
  const rjRecs = rjIx.byCandidate.get(ctx.candidate.id) || [];
  const rjByReq = new Map(rjRecs.map((x) => [x.requirementId, x]));
  const rjBlocked = ctx.candidate.profileStatus === rjm.DNU_STATUS;
  const linked = new Set((ctx.candidate.applications || []).filter((a) => !(a.stage === 'REJECTED' && rjByReq.has(a.requirementId))).map((a) => a.requirementId));
  const evidence = (await rm.currentResumeEvidence([ctx.candidate.id])).get(ctx.candidate.id);
  const openNew = open.filter((r) => !linked.has(r.id));
  // B8: the meaning-based part, only while the Admin has it switched on.
  const sims = rm.semanticOn()
    ? await semantic.jobSimilarities(ctx.candidate, evidence, openNew, { user: req.user, settings: await rm.loadFitSettings() })
    : { engine: 'off', why: null, map: new Map() };
  let rows = openNew.map((r) => ({
    id: r.id,
    reqCode: r.reqCode,
    title: r.title,
    // Client by NAME only (the binding client-desk rule).
    client: r.internal ? 'TeamLink Internal' : (r.client && r.client.name) || null,
    location: r.location,
    match: rm.threeNumbers(ctx.candidate, r, evidence, undefined, sims.map.get(r.id)),
    ...(() => {
      const here = rjByReq.get(r.id);
      const same = r.internal ? null : rjRecs.find((x) => x.requirementId !== r.id && x.clientId && x.clientId === r.clientId);
      return {
        alreadyRejected: here ? { reason: here.reason, at: here.at, sideLabel: here.sideLabel, byLabel: here.byLabel } : null,
        clientRejected: same ? { clientName: same.clientName, requirementTitle: same.requirementTitle, reason: same.reason, at: same.at, warning: rjm.sameClientWarning(same) } : null,
        blocked: rjBlocked || !!here,
      };
    })(),
  })).filter((r) => r.match.overall >= opts.minMatch);
  const eligibleCount = rows.filter((r) => r.match.eligible).length;
  const total = rows.length;
  if (opts.eligibleOnly) rows = rows.filter((r) => r.match.eligible);
  rm.sortRows(rows, opts.sort);
  const canAdd = await can(req.user, 'ats', 'candidates', 'Applications', 'create');
  return res.json({
    threshold: rm.thresholdFor(null), ...opts, total, eligible: eligibleCount, hasResume: !!evidence, shown: Math.min(rows.length, opts.limit), rows: rows.slice(0, opts.limit), canAdd,
    fitVersion: rm.versionLabel(),
    semantic: { on: sims.engine !== 'off', engine: sims.engine, why: sims.why },
  });
});

module.exports = router;
