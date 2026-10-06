// ---------------------------------------------------------------------------
// /api/specialisations — Department -> Qualification -> Specialisation (spec D).
//
//   GET    /tree                       the active master, for every dropdown (any internal login)
//   GET    /master                     the whole master with usage counts       (Admin / Super Admin)
//   POST   /qualifications             add          PUT /qualifications/:id    rename / aliases / (de)activate
//   DELETE /qualifications/:id         only when nothing uses it — otherwise deactivate
//   POST   /items                      add a specialisation (adopts a legacy imported row of the same name)
//   PUT    /items/:id                  rename / move / aliases / (de)activate
//   DELETE /items/:id                  only when nothing uses it — otherwise deactivate
//   GET    /suggest                    one suggestion for free text (?department=&text=&title=&education=)
//   GET    /candidate/:id/suggest      the suggestion for one candidate (old value, designation, resume)
//   PUT    /candidate/:id              set a candidate's qualification / specialisation (candidate edit rights + scope)
//   GET    /suggestions                the back-fill review queue (filters + counts)
//   POST   /suggestions/scan           re-compute the PENDING queue (writes suggestions only)
//   POST   /suggestions/decide         accept / change / skip / reopen rows
//   POST   /suggestions/accept-filter  bulk accept everything a filter matches
//
// WHO: reading the tree is every internal login (it fills the dropdowns).
// Maintaining the master and running the back-fill review is the master-data
// right Admin and Super Admin hold — administration / Company Setup / edit —
// configurable in Role Catalog like every other grant. A requirement's
// specialisation is saved by the requirement form (PUT /requirements/:id),
// a candidate's here, each under that record's own edit right and scope.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { requireInternal } = require('../utils/permissions');
const { logAudit } = require('../utils/audit');
const sp = require('../utils/specialisations');

const router = express.Router();
router.use(requireAuth);
router.use(requireInternal);

const MASTER_VIEW = requirePerm(null, 'administration', 'Company Setup', 'view');
const MASTER_EDIT = requirePerm(null, 'administration', 'Company Setup', 'edit');

const wrap = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.code === 'P2002') return res.status(409).json({ error: 'That name already exists in this department.' });
    return next(err);
  }
  return undefined;
};
const bad = (status, message) => Object.assign(new Error(message), { status });
const cleanName = (v) => String(v || '').replace(/\s+/g, ' ').trim();

// ---- The tree (dropdowns) ---------------------------------------------------------
router.get('/tree', wrap(async (req, res) => {
  const m = await sp.loadMaster();
  const all = req.query.all === '1';
  res.set('Cache-Control', 'private, no-cache');
  res.json({
    departments: m.departments
      .map((d) => ({
        id: d.id,
        name: d.name,
        active: d.active,
        qualifications: d.qualifications.filter((q) => all || q.active).map((q) => ({ id: q.id, name: q.name, active: q.active })),
        specialisations: d.specialisations.filter((s) => all || s.active)
          .map((s) => ({ id: s.id, name: s.name, qualificationId: s.qualificationId, active: s.active, aliases: s.aliases })),
      }))
      .filter((d) => (all || d.active) && (d.qualifications.length || d.specialisations.length)),
  });
}));

// ---- The master, with what uses each value ---------------------------------------------
router.get('/master', MASTER_VIEW, wrap(async (req, res) => {
  const m = await sp.loadMaster({ fresh: true });
  const [rs, cs, rq, cq, legacy, pending] = await Promise.all([
    prisma.requirement.groupBy({ by: ['specialisationId'], where: { specialisationId: { not: null } }, _count: { _all: true } }),
    prisma.candidate.groupBy({ by: ['specialisationId'], where: { specialisationId: { not: null } }, _count: { _all: true } }),
    prisma.requirement.groupBy({ by: ['qualificationId'], where: { qualificationId: { not: null } }, _count: { _all: true } }),
    prisma.candidate.groupBy({ by: ['qualificationId'], where: { qualificationId: { not: null } }, _count: { _all: true } }),
    prisma.specialisation.groupBy({ by: ['departmentId'], where: { isMaster: false }, _count: { _all: true } }),
    prisma.specialisationSuggestion.groupBy({ by: ['specialisationId'], where: { status: 'PENDING' }, _count: { _all: true } }),
  ]);
  const jobsByDept = new Map();
  (await prisma.requirement.groupBy({ by: ['department'], _count: { _all: true } })).forEach((r) => {
    if (!r.department) return;
    const k = r.department.toLowerCase();
    jobsByDept.set(k, (jobsByDept.get(k) || 0) + r._count._all);
  });
  const mapOf = (rows, k) => new Map(rows.map((r) => [r[k], r._count._all]));
  const [reqS, candS, reqQ, candQ, leg, pend] = [mapOf(rs, 'specialisationId'), mapOf(cs, 'specialisationId'),
    mapOf(rq, 'qualificationId'), mapOf(cq, 'qualificationId'), mapOf(legacy, 'departmentId'), mapOf(pending, 'specialisationId')];
  res.json({
    departments: m.departments.map((d) => ({
      id: d.id,
      name: d.name,
      active: d.active,
      jobs: jobsByDept.get(d.name.toLowerCase()) || 0,
      legacyValues: leg.get(d.id) || 0,
      qualifications: d.qualifications.map((q) => ({
        ...q,
        requirements: reqQ.get(q.id) || 0,
        candidates: candQ.get(q.id) || 0,
        specialisations: d.specialisations.filter((s) => s.qualificationId === q.id).length,
      })),
      specialisations: d.specialisations.map((s) => ({
        ...s,
        requirements: reqS.get(s.id) || 0,
        candidates: candS.get(s.id) || 0,
        pendingSuggestions: pend.get(s.id) || 0,
      })),
    })),
  });
}));

// An alias (or a name) may not already mean something else in the department.
async function assertTermsFree(departmentId, terms, { exceptSpecId, exceptQualId, kind }) {
  const m = await sp.loadMaster({ fresh: true });
  const dept = m.departments.find((d) => d.id === departmentId);
  if (!dept) throw bad(400, 'Unknown department.');
  const rows = kind === 'qual' ? dept.qualifications.filter((q) => q.id !== exceptQualId) : dept.specialisations.filter((s) => s.id !== exceptSpecId);
  const taken = new Map();
  rows.forEach((r) => [r.name, ...r.aliases].forEach((t) => taken.set(sp.squash(t), r.name)));
  terms.forEach((t) => {
    const k = sp.squash(t);
    if (k && taken.has(k)) throw bad(409, `"${t}" already means ${taken.get(k)} in ${dept.name}.`);
  });
}

// ---- Qualifications ---------------------------------------------------------------------
router.post('/qualifications', MASTER_EDIT, wrap(async (req, res) => {
  const name = cleanName(req.body.name);
  const departmentId = String(req.body.departmentId || '');
  if (!name) throw bad(400, 'Name is required.');
  const aliases = sp.cleanAliases(req.body.aliases);
  await assertTermsFree(departmentId, [name, ...aliases], { kind: 'qual' });
  const max = await prisma.qualification.aggregate({ where: { departmentId }, _max: { sortOrder: true } });
  const row = await prisma.qualification.create({
    data: { departmentId, name, aliases: JSON.stringify(aliases), sortOrder: (max._max.sortOrder || 0) + 10, updatedAt: new Date() },
  });
  sp.invalidate();
  await logAudit({ userId: req.user.id, action: 'Qualification added', entity: 'Qualification', entityId: row.id, toValue: name });
  res.status(201).json(row);
}));

router.put('/qualifications/:id', MASTER_EDIT, wrap(async (req, res) => {
  const cur = await prisma.qualification.findUnique({ where: { id: req.params.id } });
  if (!cur) throw bad(404, 'Qualification not found.');
  const data = { updatedAt: new Date() };
  if (req.body.name !== undefined) { data.name = cleanName(req.body.name); if (!data.name) throw bad(400, 'Name is required.'); }
  if (req.body.aliases !== undefined) data.aliases = JSON.stringify(sp.cleanAliases(req.body.aliases));
  if (req.body.active !== undefined) data.active = !!req.body.active;
  if (req.body.sortOrder !== undefined) data.sortOrder = Number(req.body.sortOrder) || 0;
  await assertTermsFree(cur.departmentId, [data.name || cur.name, ...sp.parseAliases(data.aliases !== undefined ? data.aliases : cur.aliases)], { exceptQualId: cur.id, kind: 'qual' });
  const row = await prisma.qualification.update({ where: { id: cur.id }, data });
  sp.invalidate();
  const what = data.active === false ? 'deactivated' : data.active === true && !cur.active ? 'reactivated' : 'updated';
  await logAudit({ userId: req.user.id, action: `Qualification ${what}`, entity: 'Qualification', entityId: row.id, fromValue: cur.name, toValue: row.name });
  res.json(row);
}));

router.delete('/qualifications/:id', MASTER_EDIT, wrap(async (req, res) => {
  const cur = await prisma.qualification.findUnique({ where: { id: req.params.id } });
  if (!cur) throw bad(404, 'Qualification not found.');
  const [r, c, s] = await Promise.all([
    prisma.requirement.count({ where: { qualificationId: cur.id } }),
    prisma.candidate.count({ where: { qualificationId: cur.id } }),
    prisma.specialisation.count({ where: { qualificationId: cur.id, isMaster: true } }),
  ]);
  if (r || c || s) {
    throw bad(409, `${cur.name} is in use (${r} requirement(s), ${c} candidate(s), ${s} specialisation(s)) — deactivate it instead.`);
  }
  await prisma.specialisationSuggestion.updateMany({ where: { qualificationId: cur.id, status: 'PENDING' }, data: { qualificationId: null } });
  await prisma.qualification.delete({ where: { id: cur.id } });
  sp.invalidate();
  await logAudit({ userId: req.user.id, action: 'Qualification removed (unused)', entity: 'Qualification', entityId: cur.id, fromValue: cur.name });
  res.json({ ok: true });
}));

// ---- Specialisations -------------------------------------------------------------------
async function checkQualification(departmentId, qualificationId) {
  if (!qualificationId) return null;
  const q = await prisma.qualification.findUnique({ where: { id: qualificationId } });
  if (!q || q.departmentId !== departmentId) throw bad(400, 'That qualification is not in this department.');
  return q.id;
}

router.post('/items', MASTER_EDIT, wrap(async (req, res) => {
  const name = cleanName(req.body.name);
  const departmentId = String(req.body.departmentId || '');
  if (!name) throw bad(400, 'Name is required.');
  const qualificationId = await checkQualification(departmentId, req.body.qualificationId || null);
  const aliases = sp.cleanAliases(req.body.aliases);
  await assertTermsFree(departmentId, [name, ...aliases], { kind: 'spec' });
  const max = await prisma.specialisation.aggregate({ where: { departmentId, isMaster: true }, _max: { sortOrder: true } });
  const data = {
    isMaster: true, active: true, qualificationId, aliases: JSON.stringify(aliases),
    sortOrder: (max._max.sortOrder || 0) + 10, updatedAt: new Date(),
  };
  // The data import may already have written this name: adopt that row.
  const legacy = await prisma.specialisation.findFirst({ where: { departmentId, name } });
  const row = legacy
    ? await prisma.specialisation.update({ where: { id: legacy.id }, data })
    : await prisma.specialisation.create({ data: { ...data, departmentId, name } });
  sp.invalidate();
  await logAudit({ userId: req.user.id, action: 'Specialisation added', entity: 'Specialisation', entityId: row.id, toValue: name });
  res.status(201).json(row);
}));

router.put('/items/:id', MASTER_EDIT, wrap(async (req, res) => {
  const cur = await prisma.specialisation.findUnique({ where: { id: req.params.id } });
  if (!cur || !cur.isMaster) throw bad(404, 'Specialisation not found.');
  const data = { updatedAt: new Date() };
  if (req.body.name !== undefined) { data.name = cleanName(req.body.name); if (!data.name) throw bad(400, 'Name is required.'); }
  if (req.body.qualificationId !== undefined) data.qualificationId = await checkQualification(cur.departmentId, req.body.qualificationId || null);
  if (req.body.aliases !== undefined) data.aliases = JSON.stringify(sp.cleanAliases(req.body.aliases));
  if (req.body.active !== undefined) data.active = !!req.body.active;
  if (req.body.sortOrder !== undefined) data.sortOrder = Number(req.body.sortOrder) || 0;
  await assertTermsFree(cur.departmentId, [data.name || cur.name, ...sp.parseAliases(data.aliases !== undefined ? data.aliases : cur.aliases)], { exceptSpecId: cur.id, kind: 'spec' });
  if (data.name && data.name !== cur.name) {
    const clash = await prisma.specialisation.findFirst({ where: { departmentId: cur.departmentId, name: data.name, id: { not: cur.id } } });
    if (clash && clash.isMaster) throw bad(409, `${data.name} already exists in this department.`);
    if (clash) throw bad(409, `"${data.name}" is an imported value in this department — add it as an alias of ${cur.name} instead, or pick another name.`);
  }
  const row = await prisma.specialisation.update({ where: { id: cur.id }, data });
  sp.invalidate();
  const what = data.active === false ? 'deactivated' : data.active === true && !cur.active ? 'reactivated' : 'updated';
  await logAudit({ userId: req.user.id, action: `Specialisation ${what}`, entity: 'Specialisation', entityId: row.id, fromValue: cur.name, toValue: row.name });
  res.json(row);
}));

router.delete('/items/:id', MASTER_EDIT, wrap(async (req, res) => {
  const cur = await prisma.specialisation.findUnique({ where: { id: req.params.id }, include: { department: { select: { name: true } } } });
  if (!cur || !cur.isMaster) throw bad(404, 'Specialisation not found.');
  const [r, c] = await Promise.all([
    prisma.requirement.count({ where: { specialisationId: cur.id } }),
    prisma.candidate.count({ where: { specialisationId: cur.id } }),
  ]);
  if (r || c) throw bad(409, `${cur.name} is in use (${r} requirement(s), ${c} candidate(s)) — deactivate it instead.`);
  await prisma.specialisationSuggestion.deleteMany({ where: { specialisationId: cur.id, status: 'PENDING' } });
  // An imported requirement still spelling this name keeps it as the import's
  // vocabulary (isMaster false); otherwise the row goes.
  const legacyUse = await prisma.requirement.count({ where: { department: cur.department.name, specialisation: cur.name } });
  if (legacyUse) {
    await prisma.specialisation.update({ where: { id: cur.id }, data: { isMaster: false, qualificationId: null, aliases: null, updatedAt: new Date() } });
  } else {
    await prisma.specialisation.delete({ where: { id: cur.id } });
  }
  sp.invalidate();
  await logAudit({ userId: req.user.id, action: 'Specialisation removed (unused)', entity: 'Specialisation', entityId: cur.id, fromValue: cur.name });
  res.json({ ok: true });
}));

// ---- Suggestions for one record ------------------------------------------------------------
router.get('/suggest', wrap(async (req, res) => {
  const q = req.query || {};
  const s = await sp.suggest({
    departmentNames: q.department ? [String(q.department)] : [],
    anyDepartmentFallback: !q.department,
    oldValue: q.text, title: q.title, education: q.education, qualificationsText: q.qualifications,
  });
  res.json({ suggestion: s });
}));

// The candidate side reuses the Candidates screen's own record scope.
function candidatesRoute() {
  // eslint-disable-next-line global-require
  return require('./candidates');
}

router.get('/candidate/:id/suggest', requirePerm('ats', 'candidates', 'Candidate List', 'view'), wrap(async (req, res) => {
  const loaded = await candidatesRoute().loadInScope(req, res);
  if (!loaded) return;
  const c = loaded.candidate;
  const depts = [...new Set((loaded.decorated.applications || []).map((a) => a.requirement && a.requirement.department).filter(Boolean))];
  let resumeText = '';
  try {
    // eslint-disable-next-line global-require
    const { currentResumeEvidence } = require('../utils/resumeMatch');
    const ev = (await currentResumeEvidence([c.id])).get(c.id);
    if (ev && ev.text) resumeText = String(ev.text).slice(0, 20000);
  } catch { /* no resume store: the profile text alone */ }
  const s = await sp.suggest({
    departmentNames: depts, anyDepartmentFallback: true,
    oldValue: c.specialization, title: c.currentDesignation, education: c.education, extra: resumeText,
  });
  const labels = await sp.labelsFor();
  res.json({
    suggestion: s,
    current: {
      qualificationId: c.qualificationId || null,
      qualification: labels.qual(c.qualificationId),
      specialisationId: c.specialisationId || null,
      specialisation: labels.spec(c.specialisationId),
      department: (labels.specRow(c.specialisationId) || labels.qualRow(c.qualificationId) || {}).department || null,
      oldValue: c.specialization || null,
      education: c.education || null,
    },
  });
}));

router.put('/candidate/:id', requirePerm('ats', 'candidates', 'Candidate Master', 'edit'), wrap(async (req, res) => {
  const loaded = await candidatesRoute().loadInScope(req, res);
  if (!loaded) return;
  const c = loaded.candidate;
  const m = await sp.loadMaster();
  const specId = req.body.specialisationId || null;
  const qualId = req.body.qualificationId || null;
  const spec = specId ? m.specById.get(specId) : null;
  const qual = qualId ? m.qualById.get(qualId) : null;
  if (specId && !spec) throw bad(400, 'Unknown specialisation.');
  if (qualId && !qual) throw bad(400, 'Unknown qualification.');
  if (spec && qual && spec.departmentId !== qual.departmentId) throw bad(400, 'The qualification and the specialisation are from different departments.');
  const updated = await prisma.candidate.update({
    where: { id: c.id },
    data: { specialisationId: specId, qualificationId: qualId || (spec ? spec.qualificationId : null) },
  });
  try {
    // eslint-disable-next-line global-require
    require('../utils/candidateListCache').markCandidateDirty(c.id);
  } catch { /* the list re-reads on its own schedule */ }
  // A pending back-fill suggestion for this person is answered by this edit.
  await prisma.specialisationSuggestion.updateMany({
    where: { entityType: 'CANDIDATE', entityId: c.id, status: 'PENDING' },
    data: { status: 'ACCEPTED', decidedById: req.user.id, decidedAt: new Date(), specialisationId: specId, qualificationId: updated.qualificationId },
  });
  await logAudit({
    userId: req.user.id, action: 'Candidate specialisation set', entity: 'Candidate', entityId: c.id,
    fromValue: [m.qualById.get(c.qualificationId)?.name, m.specById.get(c.specialisationId)?.name || c.specialization].filter(Boolean).join(' · ') || null,
    toValue: [m.qualById.get(updated.qualificationId)?.name, spec?.name].filter(Boolean).join(' · ') || null,
  });
  res.json({ id: updated.id, qualificationId: updated.qualificationId, specialisationId: updated.specialisationId });
}));

// ---- The back-fill review queue ---------------------------------------------------------------
function queueWhere(q) {
  const and = [{ status: q.status ? String(q.status) : 'PENDING' }];
  if (q.entityType) and.push({ entityType: String(q.entityType) });
  if (q.departmentId) and.push({ departmentId: String(q.departmentId) });
  if (q.specialisationId) and.push({ specialisationId: String(q.specialisationId) });
  if (q.minConfidence !== undefined && q.minConfidence !== '') and.push({ confidence: { gte: Number(q.minConfidence) || 0 } });
  if (q.maxConfidence !== undefined && q.maxConfidence !== '') and.push({ confidence: { lte: Number(q.maxConfidence) || 0 } });
  if (q.search) and.push({ OR: [{ sourceText: { contains: String(q.search) } }, { reason: { contains: String(q.search) } }] });
  return { AND: and };
}

router.get('/suggestions', MASTER_EDIT, wrap(async (req, res) => {
  const q = req.query || {};
  const where = queueWhere(q);
  const pageSize = [25, 50, 100, 200].includes(Number(q.pageSize)) ? Number(q.pageSize) : 50;
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const [total, rows, byStatus, bySpec, byType] = await Promise.all([
    prisma.specialisationSuggestion.count({ where }),
    prisma.specialisationSuggestion.findMany({
      where, orderBy: [{ confidence: 'desc' }, { createdAt: 'asc' }], skip: (page - 1) * pageSize, take: pageSize,
    }),
    prisma.specialisationSuggestion.groupBy({ by: ['status', 'entityType'], _count: { _all: true } }),
    // Facets: each counted with its own filter left out (cascading).
    prisma.specialisationSuggestion.groupBy({ by: ['departmentId', 'specialisationId'], where: queueWhere({ ...q, specialisationId: '', departmentId: '' }), _count: { _all: true } }),
    prisma.specialisationSuggestion.groupBy({ by: ['entityType'], where: queueWhere({ ...q, entityType: '' }), _count: { _all: true } }),
  ]);
  const m = await sp.loadMaster();
  const reqIds = rows.filter((r) => r.entityType === 'REQUIREMENT').map((r) => r.entityId);
  const candIds = rows.filter((r) => r.entityType === 'CANDIDATE').map((r) => r.entityId);
  const [reqs, cands] = await Promise.all([
    reqIds.length ? prisma.requirement.findMany({
      where: { id: { in: reqIds } },
      select: { id: true, reqCode: true, title: true, department: true, specialisation: true, education: true, status: true, specialisationId: true, client: { select: { name: true } }, internal: true },
    }) : [],
    candIds.length ? prisma.candidate.findMany({
      where: { id: { in: candIds } },
      select: { id: true, name: true, specialization: true, education: true, currentDesignation: true, specialisationId: true },
    }) : [],
  ]);
  const rById = new Map(reqs.map((r) => [r.id, r]));
  const cById = new Map(cands.map((c) => [c.id, c]));
  const deptFacet = new Map();
  const specFacet = new Map();
  bySpec.forEach((x) => {
    deptFacet.set(x.departmentId, (deptFacet.get(x.departmentId) || 0) + x._count._all);
    if (!q.departmentId || x.departmentId === q.departmentId) specFacet.set(x.specialisationId, (specFacet.get(x.specialisationId) || 0) + x._count._all);
  });
  const dName = (id) => (m.deptById.get(id) || {}).name || '—';
  res.json({
    total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)),
    counts: byStatus.map((x) => ({ status: x.status, entityType: x.entityType, count: x._count._all })),
    facets: {
      entityType: byType.map((x) => ({ value: x.entityType, label: x.entityType === 'REQUIREMENT' ? 'Requirements' : 'Candidates', count: x._count._all })),
      departmentId: [...deptFacet.entries()].map(([v, n]) => ({ value: v, label: dName(v), count: n })).sort((a, b) => b.count - a.count),
      specialisationId: [...specFacet.entries()].map(([v, n]) => ({ value: v, label: (m.specById.get(v) || {}).name || '—', count: n })).sort((a, b) => b.count - a.count),
    },
    rows: rows.map((s) => {
      const r = s.entityType === 'REQUIREMENT' ? rById.get(s.entityId) : null;
      const c = s.entityType === 'CANDIDATE' ? cById.get(s.entityId) : null;
      return {
        id: s.id,
        entityType: s.entityType,
        entityId: s.entityId,
        status: s.status,
        record: r ? {
          label: [r.reqCode, r.title].filter(Boolean).join(' · '), sub: r.internal ? 'TeamLink Internal' : (r.client && r.client.name) || '',
          department: r.department, oldValue: r.specialisation, education: r.education, mapped: !!r.specialisationId, link: `/requirements/${r.id}`,
        } : c ? {
          label: c.name, sub: c.currentDesignation || '', department: null, oldValue: c.specialization, education: c.education,
          mapped: !!c.specialisationId, link: `/candidates/${c.id}`,
        } : { label: '(record no longer exists)', missing: true },
        departmentId: s.departmentId,
        department: dName(s.departmentId),
        qualificationId: s.qualificationId,
        qualification: (m.qualById.get(s.qualificationId) || {}).name || null,
        specialisationId: s.specialisationId,
        specialisation: (m.specById.get(s.specialisationId) || {}).name || null,
        confidence: s.confidence,
        reason: s.reason,
        sourceText: s.sourceText,
        decidedAt: s.decidedAt,
      };
    }),
  });
}));

router.post('/suggestions/scan', MASTER_EDIT, wrap(async (req, res) => {
  const out = await sp.scanSuggestions();
  await logAudit({ userId: req.user.id, action: 'Specialisation suggestions re-scanned', entity: 'Specialisation', toValue: `${out.suggestions} suggestion(s)` });
  res.json(out);
}));

// Writes the accepted suggestions to their records — the ONLY place the
// back-fill touches a requirement or a candidate.
async function applyAccepted(items, user) {
  const m = await sp.loadMaster({ fresh: true });
  const groups = new Map(); // type|spec|qual -> ids
  const valid = [];
  items.forEach((s) => {
    const spec = m.specById.get(s.specialisationId);
    if (!spec || !spec.active) return;
    const qual = s.qualificationId ? m.qualById.get(s.qualificationId) : null;
    const qualId = qual && qual.departmentId === spec.departmentId ? qual.id : (spec.qualificationId || null);
    const key = `${s.entityType}|${spec.id}|${qualId || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s.entityId);
    valid.push({ ...s, qualificationId: qualId });
  });
  let requirements = 0;
  let candidates = 0;
  for (const [key, ids] of groups) {
    const [type, specId, qualId] = key.split('|');
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const data = { specialisationId: specId, qualificationId: qualId || null };
      if (type === 'REQUIREMENT') {
        // eslint-disable-next-line no-await-in-loop
        requirements += (await prisma.requirement.updateMany({ where: { id: { in: chunk } }, data })).count;
      } else {
        // eslint-disable-next-line no-await-in-loop
        candidates += (await prisma.candidate.updateMany({ where: { id: { in: chunk } }, data })).count;
      }
    }
  }
  if (candidates) {
    try {
      // eslint-disable-next-line global-require
      const cache = require('../utils/candidateListCache');
      valid.filter((v) => v.entityType === 'CANDIDATE').forEach((v) => cache.markCandidateDirty(v.entityId));
    } catch { /* re-read on its own schedule */ }
  }
  const now = new Date();
  for (const v of valid) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.specialisationSuggestion.update({
      where: { id: v.id },
      data: { status: 'ACCEPTED', decidedById: user.id, decidedAt: now, specialisationId: v.specialisationId, qualificationId: v.qualificationId },
    });
  }
  return { requirements, candidates, accepted: valid.length, ignored: items.length - valid.length };
}

// items: [{ id, action: 'accept' | 'change' | 'skip' | 'reopen', specialisationId?, qualificationId? }]
router.post('/suggestions/decide', MASTER_EDIT, wrap(async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 1000) : [];
  if (!items.length) throw bad(400, 'Nothing to decide.');
  const rows = await prisma.specialisationSuggestion.findMany({ where: { id: { in: items.map((i) => String(i.id)) } } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const toAccept = [];
  let skipped = 0;
  let reopened = 0;
  for (const it of items) {
    const s = byId.get(String(it.id));
    if (!s) continue;
    if (it.action === 'skip') {
      // eslint-disable-next-line no-await-in-loop
      await prisma.specialisationSuggestion.update({ where: { id: s.id }, data: { status: 'SKIPPED', decidedById: req.user.id, decidedAt: new Date() } });
      skipped += 1;
    } else if (it.action === 'undo') {
      // Undo an Accept: the record goes back to "not mapped" — only while it
      // still holds exactly what this suggestion wrote (a later hand edit wins).
      if (s.status === 'ACCEPTED' && s.specialisationId) {
        const model = s.entityType === 'REQUIREMENT' ? prisma.requirement : prisma.candidate;
        // eslint-disable-next-line no-await-in-loop
        const n = await model.updateMany({ where: { id: s.entityId, specialisationId: s.specialisationId }, data: { specialisationId: null, qualificationId: null } });
        // eslint-disable-next-line no-await-in-loop
        await prisma.specialisationSuggestion.update({ where: { id: s.id }, data: { status: 'PENDING', decidedById: null, decidedAt: null } });
        if (n.count && s.entityType === 'CANDIDATE') {
          try { require('../utils/candidateListCache').markCandidateDirty(s.entityId); } catch { /* re-read later */ } // eslint-disable-line global-require
        }
        reopened += 1;
      } else if (s.status === 'SKIPPED') {
        // eslint-disable-next-line no-await-in-loop
        await prisma.specialisationSuggestion.update({ where: { id: s.id }, data: { status: 'PENDING', decidedById: null, decidedAt: null } });
        reopened += 1;
      }
    } else if (it.action === 'reopen') {
      if (s.status === 'SKIPPED') {
        // eslint-disable-next-line no-await-in-loop
        await prisma.specialisationSuggestion.update({ where: { id: s.id }, data: { status: 'PENDING', decidedById: null, decidedAt: null } });
        reopened += 1;
      }
    } else if (it.action === 'accept' || it.action === 'change') {
      if (s.status === 'ACCEPTED') continue;
      toAccept.push({
        ...s,
        specialisationId: it.action === 'change' ? String(it.specialisationId || '') : s.specialisationId,
        qualificationId: it.action === 'change' ? (it.qualificationId || null) : s.qualificationId,
      });
    }
  }
  const applied = toAccept.length ? await applyAccepted(toAccept, req.user) : { requirements: 0, candidates: 0, accepted: 0, ignored: 0 };
  await logAudit({
    userId: req.user.id, action: 'Specialisation suggestions reviewed', entity: 'Specialisation',
    toValue: `accepted ${applied.accepted} (requirements ${applied.requirements}, candidates ${applied.candidates}), skipped ${skipped}, reopened ${reopened}`,
  });
  res.json({ ...applied, skipped, reopened });
}));

// Bulk accept by filter. The screen shows the count and asks first; the
// server re-counts and refuses when it no longer matches (`expect`).
router.post('/suggestions/accept-filter', MASTER_EDIT, wrap(async (req, res) => {
  const filter = { ...(req.body.filter || {}), status: 'PENDING' };
  const where = queueWhere(filter);
  const rows = await prisma.specialisationSuggestion.findMany({ where });
  if (req.body.expect !== undefined && Number(req.body.expect) !== rows.length) {
    throw bad(409, `The list changed (${rows.length} now match, ${req.body.expect} expected) — refresh and try again.`);
  }
  if (!rows.length) return res.json({ requirements: 0, candidates: 0, accepted: 0, ignored: 0 });
  const applied = await applyAccepted(rows, req.user);
  await logAudit({
    userId: req.user.id, action: 'Specialisation suggestions bulk accepted', entity: 'Specialisation',
    toValue: `accepted ${applied.accepted} (requirements ${applied.requirements}, candidates ${applied.candidates}); filter ${JSON.stringify(req.body.filter || {})}`.slice(0, 500),
  });
  return res.json(applied);
}));

// ---- The simple master lists: Sources, Reject reasons, Priorities, Locations ----------------
// (utils/listMasters.js). GET /lists fills every dropdown (any internal login);
// /lists/admin carries the "used by" counts; POST /lists/:list makes one change.
const lm = require('../utils/listMasters');

router.get('/lists', wrap(async (req, res) => {
  res.set('Cache-Control', 'private, no-cache');
  res.json(await lm.publicLists());
}));

router.get('/lists/admin', MASTER_VIEW, wrap(async (req, res) => {
  res.json(await lm.adminLists());
}));

const LIST_WORD = { sources: 'Source', rejectReasons: 'Reject reason', priorities: 'Priority', locations: 'Location' };
const ACTION_WORD = { add: 'added', rename: 'renamed', off: 'switched off', on: 'switched on', remove: 'removed (unused)', sides: 'sides changed' };
router.post('/lists/:list', MASTER_EDIT, wrap(async (req, res) => {
  const done = await lm.change(req.params.list, req.body || {}, req.user);
  await logAudit({
    userId: req.user.id,
    action: `${LIST_WORD[done.list] || 'Master value'} ${ACTION_WORD[done.action] || done.action}`,
    entity: 'MasterList',
    entityId: done.list,
    fromValue: done.name || null,
    toValue: done.newName || (req.body && Array.isArray(req.body.sides) ? req.body.sides.join(', ') : null),
  });
  res.json({ ok: true, ...done, lists: await lm.adminLists() });
}));

module.exports = router;
