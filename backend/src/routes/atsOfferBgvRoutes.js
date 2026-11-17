// ---------------------------------------------------------------------------
// Counter-offers, background verification (BGV), the application's industry
// checklist and the industry templates — mounted on routes/interviewsJoining.js
// (/api/ats, the same scope: loadScoped refuses an application outside it).
// The logic and the tables are in utils/atsOfferBgv.js.
//
//   GET  /applications/:id/extras            everything the candidate profile / offer row shows
//   PUT  /applications/:id/checklist/:key    tick / untick one industry checklist item
//   GET  /offers/:id/counter                 the counter-offer history
//   POST /offers/:id/counter                 record the candidate's counter          (Offers · edit)
//   POST /offers/:id/counter/:cid/decide     Accepted / Revised offer / Refused       (Offers · approve)
//   GET  /bgv/:id    PUT /bgv/:id            one application's BGV                    (Offers · view / edit)
//   GET  /bgv-list                           the TL / HR list of BGV in their area    (Offers · view)
//   GET  /industry-templates                 the templates (any internal ATS login)
//   POST /industry-templates  PUT /industry-templates/:tid   Admin only
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { requirePerm, can } = require('../middleware/auth');
const { requireInternal } = require('../utils/permissions');
const { applicationWhere } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const X = require('../utils/atsOfferBgv');

const isAdmin = (u) => ['SUPER_ADMIN', 'ADMIN'].includes(u && u.role);
const money = (n) => (n == null ? '—' : `₹${Number(n).toLocaleString('en-IN')}`);

module.exports = function atsOfferBgvRoutes(router, { loadScoped }) {
  async function extrasOf(app, user) {
    const industry = await X.requirementExtras(app.requirement);
    const [checklist, bgv, counters, warnings] = await Promise.all([
      X.checklistOf(app.id, industry.template), X.bgvOf(app.id), X.countersOf(app.id), X.joiningWarnings(app),
    ]);
    const criteria = industry.criteria
      ? { ...industry.criteria, ...X.criteriaFlag(industry.criteria, app.candidate), note: 'Shown for the recruiter only — the fit score does not use gender or age.' }
      : null;
    return {
      applicationId: app.id,
      candidate: { id: app.candidate.id, name: app.candidate.name },
      requirement: { id: app.requirement.id, title: app.requirement.title },
      template: industry.template ? { id: industry.template.id, industry: industry.template.industry, name: industry.template.name } : null,
      templateFrom: industry.templateFrom,
      checklist,
      criteria,
      bgvNeeded: industry.bgvNeeded,
      bgv,
      counters,
      warnings,
      bgvChecks: X.BGV_CHECKS.map(([key, label]) => ({ key, label })),
      bgvStates: X.BGV_STATES,
      can: {
        tick: true,
        bgv: can(user, 'ats', 'interviews', 'Offers', 'edit'),
        counter: can(user, 'ats', 'interviews', 'Offers', 'edit'),
        decide: can(user, 'ats', 'interviews', 'Offers', 'approve'),
      },
    };
  }

  router.get('/applications/:id/extras', requireInternal, async (req, res) => {
    const app = await loadScoped(req, res);
    if (!app) return undefined;
    return res.json(await extrasOf(app, req.user));
  });

  router.put('/applications/:id/checklist/:key', requireInternal, async (req, res) => {
    const app = await loadScoped(req, res);
    if (!app) return undefined;
    const ex = await X.requirementExtras(app.requirement);
    const it = ex.template && ex.template.items.find((i) => i.key === req.params.key);
    if (!it) return res.status(404).json({ error: 'That item is not on this job\'s checklist.' });
    const done = !!(req.body && req.body.done);
    await X.tick(app.id, it.key, done, req.body && req.body.note, req.user.name);
    await logAudit({ userId: req.user.id, action: `Checklist: ${it.label} ${done ? 'done' : 'not done'}`, entity: 'Application', entityId: app.id, toValue: done ? 'Done' : 'Not done', reason: (req.body && req.body.note) || undefined });
    return res.json(await extrasOf(app, req.user));
  });

  // ---------------------------------------------------------------- counter-offers
  router.get('/offers/:id/counter', requirePerm('ats', 'interviews', 'Offers', 'view'), async (req, res) => {
    const app = await loadScoped(req, res);
    if (!app) return undefined;
    return res.json({ rows: await X.countersOf(app.id), offeredCtc: app.offeredCtc, joiningDate: app.joiningDate });
  });
  router.post('/offers/:id/counter', requirePerm('ats', 'interviews', 'Offers', 'edit'), async (req, res) => {
    const app = await loadScoped(req, res);
    if (!app) return undefined;
    if (['JOINED', 'HIRED'].includes(app.stage)) return res.status(409).json({ error: 'This person has already joined.' });
    const open = (await X.countersOf(app.id)).find((c) => !c.decision);
    if (open) return res.status(409).json({ error: 'A counter-offer is already waiting for a decision. Decide that one first.' });
    const v = X.cleanCounter(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    const id = await X.addCounter(app.id, v.value, req.user);
    const asked = [v.value.ctcAsked != null && `CTC ${money(v.value.ctcAsked)}`, v.value.joiningAsked && `joining ${v.value.joiningAsked}`, v.value.otherTerms, v.value.competingCompany && `competing offer: ${v.value.competingCompany}${v.value.competingCtc ? ` ${money(v.value.competingCtc)}` : ''}`].filter(Boolean).join('; ');
    await logAudit({ userId: req.user.id, action: 'Counter-offer recorded', entity: 'Application', entityId: app.id, fromValue: app.offeredCtc != null ? `Offered ${money(app.offeredCtc)}` : null, toValue: asked.slice(0, 500) });
    return res.status(201).json({ ok: true, counter: await X.counterById(id), rows: await X.countersOf(app.id) });
  });
  router.post('/offers/:id/counter/:cid/decide', requirePerm('ats', 'interviews', 'Offers', 'approve'), async (req, res) => {
    const app = await loadScoped(req, res);
    if (!app) return undefined;
    const c = await X.counterById(req.params.cid);
    if (!c || c.applicationId !== app.id) return res.status(404).json({ error: 'Counter-offer not found.' });
    if (c.decision) return res.status(409).json({ error: `This counter-offer was already decided (${c.decision}).` });
    const v = X.cleanDecision(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    const after = await X.decideCounter(c.id, v.value, req.user);
    const extra = v.value.decision === 'Revised offer' ? ` — ${[v.value.revisedCtc != null && `new CTC ${money(v.value.revisedCtc)}`, v.value.revisedJoining && `new joining ${v.value.revisedJoining}`].filter(Boolean).join(', ')}` : '';
    await logAudit({ userId: req.user.id, action: `Counter-offer ${v.value.decision.toLowerCase()}${extra}`, entity: 'Application', entityId: app.id, fromValue: 'Waiting for decision', toValue: v.value.decision, reason: v.value.note || undefined });
    return res.json({
      ok: true,
      counter: after,
      rows: await X.countersOf(app.id),
      next: v.value.decision === 'Revised offer' ? 'Now use "Change offer" so the candidate gets the revised letter.' : null,
    });
  });

  // ---------------------------------------------------------------- BGV
  router.get('/bgv/:id', requirePerm('ats', 'interviews', 'Offers', 'view'), async (req, res) => {
    const app = await loadScoped(req, res);
    if (!app) return undefined;
    const ex = await X.requirementExtras(app.requirement);
    return res.json({ bgv: await X.bgvOf(app.id), bgvNeeded: ex.bgvNeeded, checks: X.BGV_CHECKS.map(([key, label]) => ({ key, label })), states: X.BGV_STATES });
  });
  router.put('/bgv/:id', requirePerm('ats', 'interviews', 'Offers', 'edit'), async (req, res) => {
    const app = await loadScoped(req, res);
    if (!app) return undefined;
    const before = await X.bgvOf(app.id);
    const v = X.cleanBgv(req.body || {}, before);
    if (v.error) return res.status(400).json({ error: v.error });
    const after = await X.saveBgv(app.id, v.value, req.user.name);
    const changed = after.checks.filter((c) => !before || (before.checks.find((b) => b.key === c.key) || {}).status !== c.status).map((c) => `${c.label}: ${c.status}`);
    await logAudit({
      userId: req.user.id, action: `Background verification updated${changed.length ? ` — ${changed.join(', ')}` : ''}`, entity: 'Application', entityId: app.id,
      fromValue: before ? before.overall : 'Not started', toValue: after.overall,
    });
    return res.json({ ok: true, bgv: after });
  });
  // The TL / HR list: every application in the viewer's area that has a BGV record, or sits at the offer / joining steps
  // of a job that needs BGV. ?status=Pending|In progress|Clear|Discrepancy|Not needed|Not started|open (default: all).
  router.get('/bgv-list', requirePerm('ats', 'interviews', 'Offers', 'view'), requireInternal, async (req, res) => {
    const [withBgv, needReqs] = await Promise.all([X.bgvApplicationIds(), X.bgvRequirementIds()]);
    const or = [];
    if (withBgv.length) or.push({ id: { in: withBgv.slice(0, 5000) } });
    if (needReqs.length) or.push({ requirementId: { in: needReqs.slice(0, 5000) }, stage: { in: ['SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'] } });
    if (!or.length) return res.json({ rows: [], counts: {} });
    const apps = await prisma.application.findMany({
      where: { AND: [applicationWhere(req.user), { OR: or }] },
      select: { id: true, stage: true, requirementId: true, candidate: { select: { id: true, name: true } }, requirement: { select: { id: true, title: true, client: { select: { id: true, name: true } } } } },
      take: 1000,
      orderBy: { updatedAt: 'desc' },
    });
    const [bgv, needed] = await Promise.all([X.bgvMap(apps.map((a) => a.id)), X.bgvNeededMap(apps.map((a) => a.requirementId))]);
    let rows = apps.map((a) => {
      const b = bgv.get(a.id) || null;
      return {
        id: a.id, stage: a.stage, candidate: a.candidate, requirement: { id: a.requirement.id, title: a.requirement.title, clientName: a.requirement.client ? a.requirement.client.name : null },
        bgvNeeded: needed.has(a.requirementId), overall: b ? b.overall : 'Not started', vendor: b ? b.vendor : null,
        reportLink: b ? b.reportLink : null, checks: b ? b.checks : null, at: b ? b.at : null, byName: b ? b.byName : null,
      };
    });
    const counts = {};
    rows.forEach((r) => { counts[r.overall] = (counts[r.overall] || 0) + 1; });
    const st = String(req.query.status || '');
    if (st === 'open') rows = rows.filter((r) => !['Clear', 'Not needed'].includes(r.overall));
    else if (st) rows = rows.filter((r) => r.overall === st);
    return res.json({ rows, counts });
  });

  // ---------------------------------------------------------------- industry templates (Admin edits)
  router.get('/industry-templates', requireInternal, async (req, res) => {
    res.json({ rows: await X.templates({ all: isAdmin(req.user) }), steps: X.STEPS, canEdit: isAdmin(req.user) });
  });
  async function saveTpl(req, res, id) {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only an Admin can change the industry templates.' });
    const before = id ? await X.template(id) : null;
    if (id && !before) return res.status(404).json({ error: 'Template not found.' });
    const v = X.cleanTemplate(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    const after = await X.saveTemplate(id, v.value, req.user.name);
    await logAudit({
      userId: req.user.id, action: `Industry template ${before ? 'changed' : 'added'} — ${after.name}`, entity: 'IndustryTemplate', entityId: after.id,
      fromValue: before ? before.items.map((i) => `${i.step}: ${i.label}`).join('; ').slice(0, 500) : null, toValue: after.items.map((i) => `${i.step}: ${i.label}`).join('; ').slice(0, 500),
    });
    return res.status(before ? 200 : 201).json({ ok: true, template: after });
  }
  router.post('/industry-templates', requireInternal, (req, res) => saveTpl(req, res, null));
  router.put('/industry-templates/:tid', requireInternal, (req, res) => saveTpl(req, res, req.params.tid));
};
