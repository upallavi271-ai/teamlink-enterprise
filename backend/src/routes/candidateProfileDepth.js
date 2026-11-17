// ---------------------------------------------------------------------------
// CANDIDATE PROFILE DEPTH routes (founder audit 2026-11-17) — mounted INSIDE routes/candidates.js (/api/candidates/...), ABOVE GET /:id,
// so the router-wide "Candidate List: view" check and the profile's own scope (loadInScope) apply. TeamLink logins only: a client or
// candidate login is refused. Writes need "Candidate Master: edit"; defining custom fields needs Super Admin / Admin.
//
//   GET    /profile-tags                     every tag with its count (the Candidates list's Tag filter)
//   GET    /profile-fields                   the custom fields (?all=1: switched-off ones too, Admin)
//   POST   /profile-fields                   Admin: { label, type: text|number|date|select, options[], required }
//   PUT    /profile-fields/:fid              Admin: any of label / options / required / active
//   GET    /:id/profile-depth                education, employment (+ standard titles), gaps, progression, tags, custom fields,
//                                            the last summary, the parse check
//   POST   /:id/education        PUT/DELETE /:id/education/:rid
//   POST   /:id/employment       PUT/DELETE /:id/employment/:rid
//   POST   /:id/tags { tag }     POST /:id/tags/remove { tag }
//   PUT    /:id/custom-fields { values: { fieldId: value } }
//   POST   /:id/profile-summary { useAi }    AI when it is on, else the rule-based summary
// Every write is audited (entity Candidate).
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requirePerm, can } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { roleForProduct } = require('../utils/permissions');
const PD = require('../utils/candidateProfileDepth');

const router = express.Router();
const cand = () => require('./candidates'); // eslint-disable-line global-require
const EDIT = requirePerm('ats', 'candidates', 'Candidate Master', 'edit');
const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN'];
const isAdmin = (u) => !!u && (ADMIN_ROLES.includes(u.role) || ADMIN_ROLES.includes(roleForProduct(u, 'ats')));
const internalOnly = (req, res) => {
  if (cand().viewerKind(req.user) !== 'internal') { res.status(403).json({ error: 'Only the TeamLink team can see this.' }); return false; }
  return true;
};
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
async function load(req, res) {
  if (!internalOnly(req, res)) return null;
  const loaded = await cand().loadInScope(req, res);
  if (!loaded) return null;
  return loaded;
}
const audit = (req, action, extra = {}) => logAudit({ userId: req.user.id, action, entity: 'Candidate', entityId: req.params.id, ...extra });
const dirty = (id) => { try { require('../utils/candidateListCache').markCandidateDirty(id); } catch { /* the list catches up */ } }; // eslint-disable-line global-require

// ---- shared lists -----------------------------------------------------------------------------------------------
router.get('/profile-tags', wrap(async (req, res) => {
  if (!internalOnly(req, res)) return undefined;
  return res.json({ tags: await PD.allTags() });
}));
router.get('/profile-fields', wrap(async (req, res) => {
  if (!internalOnly(req, res)) return undefined;
  const all = req.query.all === '1' && isAdmin(req.user);
  return res.json({ fields: await PD.fieldDefs({ all }), types: PD.FIELD_TYPES, canDefine: isAdmin(req.user) });
}));
router.post('/profile-fields', wrap(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only a Super Admin or Admin can add candidate fields.' });
  const r = await PD.createField(req.body || {}, req.user);
  if (r.error) return res.status(r.status || 400).json({ error: r.error });
  await logAudit({ userId: req.user.id, action: 'Candidate custom field added', entity: 'CandidateCustomField', entityId: r.id, toValue: `${r.label} (${r.type}${r.required ? ', required' : ''})` });
  return res.status(201).json(r);
}));
router.put('/profile-fields/:fid', wrap(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only a Super Admin or Admin can change candidate fields.' });
  const r = await PD.updateField(req.params.fid, req.body || {});
  if (r.error) return res.status(r.status || 400).json({ error: r.error });
  const f = r.field;
  await logAudit({
    userId: req.user.id, action: f.active ? 'Candidate custom field changed' : 'Candidate custom field switched off', entity: 'CandidateCustomField', entityId: f.id,
    fromValue: `${r.old.label} (${r.old.type}${r.old.required ? ', required' : ''}${r.old.active ? '' : ', off'})`, toValue: `${f.label} (${f.type}${f.required ? ', required' : ''}${f.active ? '' : ', off'})`,
  });
  return res.json(f);
}));

// ---- one candidate ----------------------------------------------------------------------------------------------
async function depthFor(candidate, user) {
  const id = candidate.id;
  const [an, tags, defs, values, summary, resume] = await Promise.all([
    PD.analyse(id), PD.tagsOf(id), PD.fieldDefs(), PD.customValuesOf(id), PD.summaryOf(id),
    prisma.candidateResume.findFirst({ where: { candidateId: id, kind: 'ORIGINAL', hiddenAt: null }, orderBy: { createdAt: 'desc' }, select: { parsed: true, fileName: true, createdAt: true } }).catch(() => null),
  ]);
  let parsed = null;
  try { parsed = resume && resume.parsed ? JSON.parse(resume.parsed) : null; } catch { parsed = null; }
  const check = PD.parseCheck(parsed, candidate);
  return {
    education: an.education,
    employment: an.employment,
    gaps: an.gaps,
    gapRule: `A gap is more than ${PD.GAP_MONTHS} months with no job (between jobs, after education, or since the last job).`,
    progression: an.progression,
    currentTitle: candidate.currentDesignation ? { raw: candidate.currentDesignation, standard: PD.normaliseTitle(candidate.currentDesignation) } : null,
    tags,
    customFields: defs.map((d) => { const v = values.get(d.id); return { ...d, value: v ? v.value : null, updatedByName: v ? v.updatedByName : null, updatedAt: v ? v.updatedAt : null }; }),
    summary,
    parseCheck: check ? { ...check, fileName: resume.fileName, readAt: resume.createdAt } : null,
    canEdit: !!(await can(user, 'ats', 'candidates', 'Candidate Master', 'edit')),
    canDefineFields: isAdmin(user),
  };
}
router.get('/:id/profile-depth', wrap(async (req, res) => {
  const loaded = await load(req, res);
  if (!loaded) return undefined;
  return res.json(await depthFor(loaded.candidate, req.user));
}));

const rowLabel = (r) => [r.degree || r.title, r.specialisation || r.company, r.institute, r.year || [r.fromMonth, r.isCurrent ? 'present' : r.toMonth].filter(Boolean).join(' to ')].filter(Boolean).join(' · ');
function listRoutes(path, { add, update, table, word }) {
  router.post(`/:id/${path}`, EDIT, wrap(async (req, res) => {
    const loaded = await load(req, res);
    if (!loaded) return undefined;
    const r = await add(req.params.id, req.body || {}, req.user);
    if (r.error) return res.status(r.status || 400).json({ error: r.error });
    await audit(req, `${word} added`, { toValue: rowLabel(r) });
    return res.status(201).json(r);
  }));
  router.put(`/:id/${path}/:rid`, EDIT, wrap(async (req, res) => {
    const loaded = await load(req, res);
    if (!loaded) return undefined;
    const r = await update(req.params.id, req.params.rid, req.body || {});
    if (r.error) return res.status(r.status || 400).json({ error: r.error });
    await audit(req, `${word} changed`, { toValue: rowLabel(r) });
    return res.json(r);
  }));
  router.delete(`/:id/${path}/:rid`, EDIT, wrap(async (req, res) => {
    const loaded = await load(req, res);
    if (!loaded) return undefined;
    const old = await PD.removeRow(table, req.params.id, req.params.rid);
    if (!old) return res.status(404).json({ error: 'Not found' });
    await audit(req, `${word} removed`, { fromValue: rowLabel(old) });
    return res.json({ ok: true });
  }));
}
listRoutes('education', { add: PD.addEducation, update: PD.updateEducation, table: 'CandidateEducation', word: 'Education entry' });
listRoutes('employment', { add: PD.addEmployment, update: PD.updateEmployment, table: 'CandidateEmployment', word: 'Employment entry' });

router.post('/:id/tags', EDIT, wrap(async (req, res) => {
  const loaded = await load(req, res);
  if (!loaded) return undefined;
  const r = await PD.addTag(req.params.id, (req.body || {}).tag, req.user);
  if (r.error) return res.status(400).json({ error: r.error });
  if (r.added) { await audit(req, 'Tag added', { toValue: r.tag }); dirty(req.params.id); }
  return res.status(r.added ? 201 : 200).json({ ...r, tags: await PD.tagsOf(req.params.id) });
}));
router.post('/:id/tags/remove', EDIT, wrap(async (req, res) => {
  const loaded = await load(req, res);
  if (!loaded) return undefined;
  const tag = String((req.body || {}).tag || '');
  const r = await PD.removeTag(req.params.id, tag);
  if (r.removed) { await audit(req, 'Tag removed', { fromValue: tag }); dirty(req.params.id); }
  return res.json({ ...r, tags: await PD.tagsOf(req.params.id) });
}));

router.put('/:id/custom-fields', EDIT, wrap(async (req, res) => {
  const loaded = await load(req, res);
  if (!loaded) return undefined;
  const r = await PD.saveCustomValues(req.params.id, (req.body || {}).values || {}, req.user);
  if (r.error) return res.status(400).json({ error: r.error });
  for (const c of r.changes) {
    // eslint-disable-next-line no-await-in-loop
    await audit(req, 'Custom field changed', { field: c.def.id, fieldLabel: c.def.label, fromValue: c.from, toValue: c.to });
  }
  return res.json({ ok: true, changed: r.changes.length });
}));

router.post('/:id/profile-summary', EDIT, wrap(async (req, res) => {
  const loaded = await load(req, res);
  if (!loaded) return undefined;
  const c = loaded.candidate;
  const [an, tags] = await Promise.all([PD.analyse(c.id), PD.tagsOf(c.id)]);
  const r = await PD.writeSummary(c, an.education, an.employment, tags, an, { useAi: (req.body || {}).useAi !== false, user: req.user });
  await audit(req, r.source === 'ai' ? 'Profile summary written (AI)' : 'Profile summary written (from the fields)');
  return res.json(r);
}));

module.exports = router;
