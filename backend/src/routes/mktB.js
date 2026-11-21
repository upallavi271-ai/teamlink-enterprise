// ---------------------------------------------------------------------------
// MARKET WAVE B API (founder 2026-11-21), mounted at /api/ats/mkt. The features live in utils/mktb/*.js; this file is the doors:
// who may use each one, and the record they may reach (utils/scope.js: candidateWhere / requirementWhere / applicationWhere).
//   Everyone here is a TeamLink staff login with the ATS (client / candidate logins: 403).
//   Manager / Assistant Manager: VIEW ONLY (every change refused).   BDE: no candidate contact or salary (atsPrivacyGuard), no
//   enrichment / update links / salary rules.   Admin switches and global rules: Super Admin / Admin.
// Public doors (no login): routes/mktBPublic.js (the profile-update link, the screening questions of a public job, MCP).
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const { atsPrivacyGuard } = require('../utils/clientRedact');
const scope = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const S = require('../utils/mktb/store');
const G = require('../utils/mktb/gov');
const J = require('../utils/mktb/jobs');
const C = require('../utils/mktb/cands');
const P = require('../utils/mktb/pipe');
const A = require('../utils/mktb/agents');
const MCP = require('../utils/mktb/mcp');

const router = express.Router();
router.use(requireAuth, atsPrivacyGuard);

const roleOf = (u) => scope.atsViewRole(u);
const isAdmin = (u) => roleOf(u) === 'admin';
const isLead = (u) => ['admin', 'tl', 'stl'].includes(roleOf(u)) || scope.isBdeTl(u);
const isBde = (u) => roleOf(u) === 'bde';
const VIEW_ONLY = { error: 'Your ATS login is view only: you can look, not change.' };
const ADMIN_ONLY = { error: 'Only a Super Admin or an Admin changes this.' };
const LEADS_ONLY = { error: 'This is for team leads and above.' };
const NOT_BDE = { error: 'The BDE team does not edit candidate details.' };
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, out, ok = 200) => (out && out.error ? res.status(out.status || 400).json({ error: out.error }) : res.status(ok).json(out));

router.use((req, res, next) => {
  if (['client', 'candidate', 'none'].includes(roleOf(req.user))) return res.status(403).json({ error: 'These ATS tools are for TeamLink staff.' });
  return next();
});
// a change: never a Manager / Assistant Manager (view only), never while viewing as someone
const act = (req, res, next) => {
  if (roleOf(req.user) === 'mgmt' || (req.user.caps && req.user.caps.atsAct === false && !isAdmin(req.user) && !isBde(req.user))) return res.status(403).json(VIEW_ONLY);
  return next();
};
const admin = (req, res, next) => (isAdmin(req.user) ? next() : res.status(403).json(ADMIN_ONLY));
const lead = (req, res, next) => (isLead(req.user) || roleOf(req.user) === 'mgmt' ? next() : res.status(403).json(LEADS_ONLY));
const notBde = (req, res, next) => (isBde(req.user) ? res.status(403).json(NOT_BDE) : next());

async function jobOf(req, res) {
  const r = await prisma.requirement.findFirst({ where: { AND: [scope.requirementWhere(req.user), { id: req.params.id }] }, include: { client: { select: { id: true, name: true } } } });
  if (!r) res.status(404).json({ error: 'Requirement not found (or not in your scope).' });
  return r;
}
async function candOf(req, res, id = req.params.id) {
  const c = await prisma.candidate.findFirst({ where: { AND: [scope.candidateWhere(req.user), { id }] }, select: { id: true, name: true } });
  if (!c) res.status(404).json({ error: 'Candidate not found (or not in your scope).' });
  return c;
}

// ---- settings / governance (Administration > AI governance) ------------------------------------------------------------------
router.get('/settings', wrap(async (req, res) => {
  if (!isAdmin(req.user) && roleOf(req.user) !== 'mgmt') return res.status(403).json(ADMIN_ONLY);
  res.json({ switches: S.switchList(await S.settings({ fresh: true })), mayEdit: isAdmin(req.user) });
}));
router.put('/settings', admin, wrap(async (req, res) => {
  const { key, value } = req.body || {};
  if (!S.SWITCHES[key]) return res.status(400).json({ error: 'Unknown setting.' });
  const before = (await S.settings())[key];
  const after = await S.saveSetting(key, value, req.user.name);
  await logAudit({ userId: req.user.id, action: `ATS setting: ${S.SWITCHES[key].label}`, entity: 'MktSetting', entityId: key, fromValue: String(before), toValue: String(after) });
  return res.json({ key, value: after });
}));
router.get('/gov/summary', admin, wrap(async (req, res) => res.json(await G.summary())));
router.get('/gov/calls', admin, wrap(async (req, res) => res.json({ rows: await G.callLog({ limit: req.query.limit, purpose: req.query.purpose || null, userId: req.query.userId || null }) })));
router.get('/gov/pledge', wrap(async (req, res) => {
  const demo = G.maskText('Rahul, 9848012345, rahul.k@gmail.com, PAN ABCDE1234F');
  res.json({ pledge: G.PLEDGE, demo: { before: 'Rahul, 9848012345, rahul.k@gmail.com, PAN ABCDE1234F', after: demo.text }, connectors: A.profileGraph.status(), iso42001: { state: 'Not buildable in code', note: 'ISO/IEC 42001 is a certificate a company earns through an external audit of how it manages AI. The product holds the evidence it needs: this call log, the masking, the review queue, the fairness tests and the compliance audits.' } });
}));
router.get('/gov/flags', wrap(async (req, res) => res.json({ rows: await G.flags({ status: req.query.status || null }), kinds: G.FLAG_KINDS })));
router.post('/gov/flags', wrap(async (req, res) => {
  const out = await G.addFlag(req.body || {}, req.user);
  if (!out.error) await logAudit({ userId: req.user.id, action: `AI output flagged: ${out.kind}`, entity: 'AiFlag', entityId: out.id, toValue: String((req.body || {}).feature || '').slice(0, 80) });
  return send(res, out, 201);
}));
router.post('/gov/flags/:id/close', admin, wrap(async (req, res) => send(res, await G.closeFlag(req.params.id, req.user))));
router.get('/gov/reviews', wrap(async (req, res) => {
  const status = ['Pending', 'Confirmed', 'Overturned'].includes(req.query.status) ? req.query.status : 'Pending';
  let rows = await G.reviews({ status });
  if (!isAdmin(req.user)) {
    const appIds = rows.map((r) => r.applicationId).filter(Boolean);
    const candIds = rows.map((r) => r.candidateId).filter(Boolean);
    const okApps = new Set(appIds.length ? (await prisma.application.findMany({ where: { AND: [scope.applicationWhere(req.user), { id: { in: appIds } }] }, select: { id: true } })).map((a) => a.id) : []);
    const okCands = new Set(candIds.length ? (await prisma.candidate.findMany({ where: { AND: [scope.candidateWhere(req.user), { id: { in: candIds } }] }, select: { id: true } })).map((c) => c.id) : []);
    rows = rows.filter((r) => (r.applicationId ? okApps.has(r.applicationId) : (r.candidateId ? okCands.has(r.candidateId) : false)));
  }
  res.json({ rows });
}));
router.post('/gov/reviews/:id', act, wrap(async (req, res) => {
  const [row] = await S.q('SELECT * FROM "AiReview" WHERE "id" = ?', req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  if (!isAdmin(req.user)) {
    const ok = row.applicationId ? await prisma.application.count({ where: { AND: [scope.applicationWhere(req.user), { id: row.applicationId }] } }) : (row.candidateId ? await prisma.candidate.count({ where: { AND: [scope.candidateWhere(req.user), { id: row.candidateId }] } }) : 0);
    if (!ok) return res.status(403).json({ error: 'That item is outside your scope.' });
  }
  const out = await G.decideReview(req.params.id, (req.body || {}).decision, (req.body || {}).note, req.user);
  if (!out.error) await logAudit({ userId: req.user.id, action: `Automatic decision ${out.decision.toLowerCase()}: ${row.kind}`, entity: row.refType || 'AiReview', entityId: row.refId, toValue: String((req.body || {}).note || '').slice(0, 200) });
  return send(res, out);
}));
router.get('/gov/audits', admin, wrap(async (req, res) => res.json({ rows: await G.audits() })));
router.post('/gov/audit', admin, wrap(async (req, res) => res.status(201).json(await G.audit(req.user))));
router.get('/gov/fairness', admin, wrap(async (req, res) => res.json(G.pairedFairness())));

// ---- 02.09 client pipeline ---------------------------------------------------------------------------------------------------
router.get('/client-pipelines', admin, wrap(async (req, res) => res.json({ rows: await J.clientsConfigured() })));
router.get('/clients/:id/pipeline', wrap(async (req, res) => {
  const ok = await prisma.client.count({ where: { AND: [scope.clientPickerWhere(req.user), { id: req.params.id }] } });
  if (!ok && !isAdmin(req.user)) return res.status(404).json({ error: 'Client not found (or not in your scope).' });
  return res.json({ ...(await J.clientPipeline(req.params.id)), mayEdit: isAdmin(req.user) });
}));
router.put('/clients/:id/pipeline', admin, wrap(async (req, res) => {
  const out = await J.saveClientPipeline(req.params.id, req.body || {}, req.user);
  if (!out.error) await logAudit({ userId: req.user.id, action: 'Client pipeline saved', entity: 'Client', entityId: req.params.id, toValue: `not used: ${out.off.join(', ') || 'none'}; approval: ${out.approval.join(', ') || 'none'}; rounds: ${out.rounds.join(' > ') || 'none'}`.slice(0, 300) });
  return send(res, out);
}));

// ---- the requirement page: Hiring tools ---------------------------------------------------------------------------------------
router.get('/jobs/:id/overview', wrap(async (req, res) => {
  const r = await jobOf(req, res); if (!r) return undefined;
  const [sc, watch, rule, rules, proc] = await Promise.all([J.screening(r.id), J.watchState(r.id), J.ruleFor(r), P.autoRules(r.id), r.clientId ? J.clientPipeline(r.clientId) : null]);
  return res.json({ requirement: { id: r.id, title: r.title, skills: r.skills, goodToHaveSkills: r.goodToHaveSkills, clientName: r.client && r.client.name, internal: r.internal }, screening: sc, watch, postingRule: rule, autoRules: rules, autoRejectOn: await S.setting('autoReject.on'), clientProcess: proc && { rounds: proc.rounds, notes: proc.notes, configured: proc.configured }, may: { edit: roleOf(req.user) !== 'mgmt', lead: isLead(req.user) } });
}));
router.put('/jobs/:id/screening', act, wrap(async (req, res) => {
  const r = await jobOf(req, res); if (!r) return undefined;
  const out = await J.saveScreening(r.id, req.body || {}, req.user);
  if (!out.error) await logAudit({ userId: req.user.id, action: `Screening questions saved (${out.questions.length})`, entity: 'Requirement', entityId: r.id, toValue: `${out.questions.filter((q) => q.knockout).length} knockout; on fail: ${out.action}` });
  return send(res, out);
}));
router.get('/jobs/:id/screening/answers', wrap(async (req, res) => {
  const r = await jobOf(req, res); if (!r) return undefined;
  const apps = await prisma.application.findMany({ where: { AND: [scope.applicationWhere(req.user), { requirementId: r.id }] }, select: { id: true, candidate: { select: { id: true, name: true } }, stage: true } });
  const m = await J.answersFor(apps.map((a) => a.id));
  return res.json({ rows: apps.filter((a) => m.has(a.id)).map((a) => ({ applicationId: a.id, candidateId: a.candidate.id, name: a.candidate.name, stage: a.stage, ...m.get(a.id) })) });
}));
router.post('/applications/:id/screening', act, wrap(async (req, res) => {
  const app = await P.appInScope(req.params.id, req.user);
  if (!app) return res.status(404).json({ error: 'Application not found (or not in your scope).' });
  const out = await J.recordAnswers(app, (req.body || {}).answers || {}, { source: 'Recruiter (call)', user: req.user });
  if (out.none) return res.status(400).json({ error: 'This requirement has no screening questions yet.' });
  await logAudit({ userId: req.user.id, action: `Screening answers recorded${out.failed.length ? `: ${out.failed.length} failed` : ''}${out.held ? ', put on hold' : ''}`, entity: 'Application', entityId: app.id });
  return res.json(out);
}));
router.post('/jobs/:id/extract-skills', wrap(async (req, res) => {
  const r = await jobOf(req, res); if (!r) return undefined;
  const text = (req.body && req.body.text) || [r.jobDescription, r.description, r.responsibilities, r.qualifications].filter(Boolean).join('\n');
  return send(res, await J.extractSkills(text, { useAi: (req.body || {}).useAi !== false }));
}));
router.post('/extract-skills', wrap(async (req, res) => send(res, await J.extractSkills((req.body || {}).text, { useAi: (req.body || {}).useAi !== false }))));
router.post('/intake', act, wrap(async (req, res) => send(res, await J.intake((req.body || {}).text, req.user))));
router.get('/jobs/:id/watch', wrap(async (req, res) => {
  const r = await jobOf(req, res); if (!r) return undefined;
  if (isBde(req.user)) return res.status(403).json({ error: 'Matching people is for the recruiting team.' });
  return res.json(await J.watchRun(r, req.user, { markSeen: req.query.seen === '1' }));
}));
router.get('/jobs/:id/rediscover', wrap(async (req, res) => {
  const r = await jobOf(req, res); if (!r) return undefined;
  if (isBde(req.user)) return res.status(403).json({ error: 'Rediscovery is for the recruiting team.' });
  return res.json(await A.rediscover(r, req.user));
}));
router.get('/jobs/:id/posting-rule', wrap(async (req, res) => { const r = await jobOf(req, res); if (!r) return undefined; return res.json(await J.ruleFor(r)); }));

// ---- 02.16 posting rules (Admin) -------------------------------------------------------------------------------------------
router.get('/posting-rules', wrap(async (req, res) => res.json({ rows: await J.postingRules(), mayEdit: isAdmin(req.user) })));
router.post('/posting-rules', admin, wrap(async (req, res) => {
  const out = await J.savePostingRule(req.body || {}, req.user);
  if (!out.error) await logAudit({ userId: req.user.id, action: 'Posting rule saved', entity: 'MktPostingRule', entityId: out.id, toValue: out.sources.join(', ') });
  return send(res, out, 201);
}));
router.delete('/posting-rules/:id', admin, wrap(async (req, res) => { await logAudit({ userId: req.user.id, action: 'Posting rule removed', entity: 'MktPostingRule', entityId: req.params.id }); return res.json(await J.deletePostingRule(req.params.id)); }));

// ---- 03.02 OCR backlog (Admin) -----------------------------------------------------------------------------------------------
router.get('/ocr', admin, wrap(async (req, res) => res.json(await C.ocrBacklog())));
router.post('/ocr/rerun', admin, wrap(async (req, res) => {
  const out = await C.ocrRerun({ limit: (req.body || {}).limit }, req.user);
  if (out.done) await logAudit({ userId: req.user.id, action: `Scanned resumes read again: ${out.read} of ${out.done}`, entity: 'CandidateResume', entityId: 'ocr' });
  return res.json(out);
}));

// ---- 03.05 custom-field parsing agent ----------------------------------------------------------------------------------------
router.get('/field-rules', wrap(async (req, res) => res.json({ ...(await C.fieldRules()), methods: C.FIELD_METHODS, mayEdit: isAdmin(req.user) })));
router.post('/field-rules', admin, wrap(async (req, res) => send(res, await C.saveFieldRule(req.body || {}, req.user), 201)));
router.delete('/field-rules/:id', admin, wrap(async (req, res) => res.json(await C.deleteFieldRule(req.params.id))));
router.get('/candidates/:id/parse-fields', wrap(async (req, res) => { const c = await candOf(req, res); if (!c) return undefined; return res.json(await C.parseFields(c.id, { useAi: req.query.ai !== '0' })); }));
router.post('/candidates/:id/parse-fields/apply', act, notBde, wrap(async (req, res) => {
  const c = await candOf(req, res); if (!c) return undefined;
  const out = await C.applyFields(c.id, (req.body || {}).values || {}, req.user);
  if (!out.error) await logAudit({ userId: req.user.id, action: `Custom fields filled from the resume (${out.changes.length})`, entity: 'Candidate', entityId: c.id, toValue: out.changes.map((x) => `${x.def.label}: ${x.to}`).join('; ').slice(0, 300) });
  return send(res, out.error ? out : { saved: out.changes.length });
}));

// ---- 03.08 / 03.09 search ----------------------------------------------------------------------------------------------------
router.post('/nl-search', wrap(async (req, res) => {
  const text = String((req.body || {}).query || '').trim();
  if (text.length < 3) return res.status(400).json({ error: 'Type what you are looking for, e.g. "java developers in hyderabad 5+ years notice 30 days".' });
  const filters = (req.body || {}).filters && typeof req.body.filters === 'object' ? req.body.filters : await C.parseNl(text);
  const out = await C.search(filters, req.user);
  return res.json({ filters, chips: C.filterChips(filters), ...out, link: C.listLink(filters) });
}));
router.get('/saved-searches', wrap(async (req, res) => res.json({ rows: await C.savedSearches(req.user) })));
router.post('/saved-searches', wrap(async (req, res) => send(res, await C.saveSearch(req.body || {}, req.user), 201)));
router.get('/saved-searches/:id/run', wrap(async (req, res) => send(res, await C.runSaved(req.params.id, req.user))));
router.put('/saved-searches/:id', wrap(async (req, res) => send(res, await C.updateSaved(req.params.id, req.body || {}, req.user))));
router.delete('/saved-searches/:id', wrap(async (req, res) => send(res, await C.deleteSaved(req.params.id, req.user))));

// ---- 03.10 talent pools --------------------------------------------------------------------------------------------------------
router.get('/pools', wrap(async (req, res) => res.json({ rows: await C.pools(req.user) })));
router.post('/pools', act, wrap(async (req, res) => send(res, await C.createPool(req.body || {}, req.user), 201)));
router.put('/pools/:id', act, wrap(async (req, res) => send(res, await C.updatePool(req.params.id, req.body || {}, req.user))));
router.delete('/pools/:id', act, wrap(async (req, res) => send(res, await C.deletePool(req.params.id, req.user))));
router.get('/pools/:id', wrap(async (req, res) => send(res, await C.poolMembers(req.params.id, req.user))));
router.post('/pools/:id/members', act, wrap(async (req, res) => send(res, await C.addMembers(req.params.id, (req.body || {}).candidateIds, req.user))));
router.post('/pools/:id/members/remove', act, wrap(async (req, res) => send(res, await C.removeMembers(req.params.id, (req.body || {}).candidateIds, req.user))));

// ---- the candidate page: Hiring tools ----------------------------------------------------------------------------------------
router.get('/candidates/:id/overview', wrap(async (req, res) => {
  const c = await candOf(req, res); if (!c) return undefined;
  const apps = await prisma.application.findMany({ where: { AND: [scope.applicationWhere(req.user), { candidateId: c.id }] }, select: { id: true, stage: true, requirement: { select: { id: true, title: true, client: { select: { name: true } } } } }, orderBy: { updatedAt: 'desc' }, take: 20 });
  const pitches = apps.length ? await S.q(`SELECT * FROM "MktPitch" WHERE "applicationId" IN (${apps.map(() => '?').join(',')}) ORDER BY "at" DESC`, ...apps.map((a) => a.id)) : [];
  const answers = await J.answersFor(apps.map((a) => a.id));
  const joined = apps.some((a) => ['JOINED', 'HIRED'].includes(a.stage));
  const [pools, fraud, reviews, links, risk] = await Promise.all([C.poolsOfCandidate(c.id, req.user), C.fraudFlags(req.user, { status: 'Open', candidateId: c.id }), C.reviewsOf(c.id), isBde(req.user) ? [] : C.linksOf(c.id), joined ? A.attrition(req.user, { candidateId: c.id }) : null]);
  return res.json({
    candidate: c,
    applications: apps.map((a) => ({ id: a.id, stage: a.stage, title: a.requirement.title, client: a.requirement.client && a.requirement.client.name, pitches: pitches.filter((p) => p.applicationId === a.id).slice(0, 3), screening: answers.get(a.id) || null })),
    pools, fraud, reviews, links, risk: risk ? risk.rows[0] || null : null,
    may: { edit: roleOf(req.user) !== 'mgmt', bde: isBde(req.user), lead: isLead(req.user) },
  });
}));
router.get('/candidates/:id/enrich', notBde, wrap(async (req, res) => { const c = await candOf(req, res); if (!c) return undefined; return send(res, await C.enrichment(c.id)); }));
router.post('/candidates/:id/enrich', act, notBde, wrap(async (req, res) => { const c = await candOf(req, res); if (!c) return undefined; return send(res, await C.applyEnrichment(c.id, (req.body || {}).fields, req.user)); }));
router.post('/candidates/:id/update-link', act, notBde, wrap(async (req, res) => {
  const c = await candOf(req, res); if (!c) return undefined;
  const origin = req.get('origin') || (req.get('referer') ? new URL(req.get('referer')).origin : '');
  const out = await C.createLink(c.id, req.user, origin);
  await logAudit({ userId: req.user.id, action: 'Profile-update link made', entity: 'Candidate', entityId: c.id, toValue: `ends ${out.expiresAt.slice(0, 10)}` });
  return res.status(201).json(out);
}));
router.get('/candidates/:id/client-resume', wrap(async (req, res) => { const c = await candOf(req, res); if (!c) return undefined; return res.json(await C.resumeContent(c.id, { useAi: req.query.ai === '1' })); }));
router.get('/candidates/:id/client-resume.pdf', wrap(async (req, res) => {
  const c = await candOf(req, res); if (!c) return undefined;
  const content = await C.resumeContent(c.id, { useAi: req.query.ai === '1' });
  const buf = await C.resumePdf(content, { brand: process.env.COMPANY_BRAND || 'TeamLink', showName: req.query.name !== '0' });
  await logAudit({ userId: req.user.id, action: 'Client resume (formatted PDF) made', entity: 'Candidate', entityId: c.id, toValue: `summary by ${content.source}` });
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="Profile-${content.ref}.pdf"`);
  return res.send(buf);
}));
router.get('/candidates/:id/doc-expiry', wrap(async (req, res) => { const c = await candOf(req, res); if (!c) return undefined; return res.json({ rows: await C.docExpiry(c.id) }); }));
router.put('/documents/:id/expiry', act, wrap(async (req, res) => {
  const doc = await prisma.candidateDocument.findUnique({ where: { id: req.params.id }, select: { candidateId: true } });
  if (!doc || !(await candOf(req, res, doc.candidateId))) { if (!res.headersSent) res.status(404).json({ error: 'Document not found.' }); return undefined; }
  const out = await C.setDocExpiry(req.params.id, (req.body || {}).expiresOn || null, req.user);
  if (!out.error) await logAudit({ userId: req.user.id, action: out.cleared ? 'Document expiry cleared' : `Document expiry set: ${(req.body || {}).expiresOn}`, entity: 'CandidateDocument', entityId: req.params.id });
  return send(res, out);
}));
router.get('/expiring-docs', wrap(async (req, res) => res.json(await C.expiringDocs(req.user, { days: Number(req.query.days) || 30 }))));
router.get('/stale', wrap(async (req, res) => res.json(await C.staleProfiles(req.user, { days: req.query.days }))));
router.get('/job-changes', wrap(async (req, res) => res.json({ rows: await C.jobChanges(req.user) })));

// ---- 03.20 fraud signals / 04.14 backdoor hires ----------------------------------------------------------------------------------
router.post('/fraud/scan', lead, act, wrap(async (req, res) => {
  const a = await C.fraudScan(); const b = await P.backdoorScan();
  await logAudit({ userId: req.user.id, action: `Fraud / backdoor scan: ${a.added + b.added} new flag(s)`, entity: 'MktFraudFlag', entityId: 'scan' });
  return res.json({ added: a.added + b.added, fraud: a.added, backdoor: b.added });
}));
router.get('/fraud', wrap(async (req, res) => res.json({ rows: await C.fraudFlags(req.user, { status: ['Open', 'Cleared', 'Confirmed'].includes(req.query.status) ? req.query.status : 'Open' }) })));
router.post('/fraud/:id', lead, act, wrap(async (req, res) => {
  const [row] = await S.q('SELECT "candidateId" FROM "MktFraudFlag" WHERE "id" = ?', req.params.id);
  if (!row || !(await candOf(req, res, row.candidateId))) { if (!res.headersSent) res.status(404).json({ error: 'Flag not found.' }); return undefined; }
  const out = await C.decideFraud(req.params.id, (req.body || {}).status, (req.body || {}).note, req.user);
  if (!out.error) await logAudit({ userId: req.user.id, action: `Fraud flag ${String((req.body || {}).status).toLowerCase()}: ${out.kind}`, entity: 'Candidate', entityId: out.candidateId, toValue: String((req.body || {}).note || '').slice(0, 200) });
  return send(res, out);
}));
router.get('/backdoor', lead, wrap(async (req, res) => {
  const rows = await require('../utils/backdoorHire').detect({ months: Number(req.query.months) || 12 }); // eslint-disable-line global-require
  const ok = new Set(rows.length ? (await prisma.application.findMany({ where: { AND: [scope.applicationWhere(req.user), { id: { in: rows.map((r) => r.applicationId) } }] }, select: { id: true } })).map((a) => a.id) : []);
  return res.json({ rows: rows.filter((r) => ok.has(r.applicationId)) });
}));

// ---- 03.21 bulk AI profile review ----------------------------------------------------------------------------------------------
router.post('/bulk-review', wrap(async (req, res) => {
  const b = req.body || {};
  const out = await C.bulkReview(b.candidateIds, b.requirementId || null, req.user, { useAi: !!b.useAi });
  if (!out.error) await logAudit({ userId: req.user.id, action: `Bulk profile review: ${out.rows.length} people`, entity: 'Requirement', entityId: b.requirementId || 'none' });
  return send(res, out);
}));

// ---- 04.05 / 04.06 submission note + packet --------------------------------------------------------------------------------------
router.post('/applications/:id/pitch', act, wrap(async (req, res) => {
  const out = await P.draftPitch(req.params.id, req.user, { useAi: (req.body || {}).useAi !== false });
  if (!out.error) await logAudit({ userId: req.user.id, action: `Submission note drafted (${out.source})`, entity: 'Application', entityId: req.params.id });
  return send(res, out, 201);
}));
router.get('/applications/:id/pitches', wrap(async (req, res) => { if (!(await P.appInScope(req.params.id, req.user))) return res.status(404).json({ error: 'Not found.' }); return res.json({ rows: await P.pitchesOf(req.params.id) }); }));
router.post('/pitches/:id', act, wrap(async (req, res) => {
  const out = await P.decidePitch(req.params.id, (req.body || {}).decision, (req.body || {}).text, req.user);
  if (!out.error) await logAudit({ userId: req.user.id, action: `Submission note ${out.status.toLowerCase()}`, entity: 'Application', entityId: out.applicationId });
  return send(res, out);
}));
router.get('/applications/:id/packet.pdf', wrap(async (req, res) => {
  const out = await P.packet(req.params.id, req.user);
  if (out.error) return send(res, out);
  await logAudit({ userId: req.user.id, action: `Client submission packet made${out.approved ? '' : ' (draft note)'}`, entity: 'Application', entityId: req.params.id });
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${out.fileName}"`);
  return res.send(out.buffer);
}));

// ---- 04.09 auto-reject -----------------------------------------------------------------------------------------------------------
router.get('/auto-rules', wrap(async (req, res) => res.json({ rows: await P.autoRules(req.query.scope || null), kinds: Object.entries(P.RULE_KINDS).map(([k, v]) => ({ kind: k, label: v.label })), on: await S.setting('autoReject.on') })));
router.post('/auto-rules', act, wrap(async (req, res) => {
  const b = req.body || {};
  if ((!b.scope || b.scope === 'global') && !isAdmin(req.user)) return res.status(403).json(ADMIN_ONLY);
  if (b.scope && b.scope !== 'global') { if (!isLead(req.user)) return res.status(403).json(LEADS_ONLY); req.params.id = b.scope; if (!(await jobOf(req, res))) return undefined; }
  if (b.kind === 'maxExpectedLakh' && isBde(req.user)) return res.status(403).json({ error: 'The BDE team does not set salary rules.' });
  const out = await P.saveAutoRule(b, req.user);
  if (!out.error) await logAudit({ userId: req.user.id, action: `Auto-reject rule saved: ${b.kind} ${b.value || ''}`, entity: 'MktAutoRule', entityId: out.id, toValue: b.scope || 'global' });
  return send(res, out, 201);
}));
router.delete('/auto-rules/:id', act, wrap(async (req, res) => {
  const [r] = await S.q('SELECT * FROM "MktAutoRule" WHERE "id" = ?', req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found.' });
  if (r.scope === 'global' ? !isAdmin(req.user) : !isLead(req.user)) return res.status(403).json(LEADS_ONLY);
  await logAudit({ userId: req.user.id, action: `Auto-reject rule removed: ${r.kind}`, entity: 'MktAutoRule', entityId: r.id });
  return res.json(await P.deleteAutoRule(r.id));
}));
router.post('/auto-reject/run', lead, wrap(async (req, res) => {
  const b = req.body || {};
  const dryRun = b.dryRun !== false;
  if (!dryRun && !isAdmin(req.user)) return res.status(403).json(ADMIN_ONLY);
  if (b.requirementId) { req.params.id = b.requirementId; if (!(await jobOf(req, res))) return undefined; }
  return send(res, await P.runAutoReject({ dryRun, requirementId: b.requirementId || null, user: req.user }));
}));

// ---- 04.12 / 04.13 placements ---------------------------------------------------------------------------------------------------
router.get('/placements', wrap(async (req, res) => res.json(await P.placements(req.user, { status: req.query.status || null }))));
router.post('/placements/:id', act, wrap(async (req, res) => send(res, await P.decidePlacement(req.params.id, (req.body || {}).decision, (req.body || {}).note, req.user))));
router.get('/contracts', wrap(async (req, res) => res.json({ rows: await P.contracts(req.user), note: 'Billing a conversion fee is an Accounts step: it needs a founder decision. This screen records the conversion only.' })));
router.put('/contracts/:id', act, notBde, wrap(async (req, res) => send(res, await P.saveConversion(req.params.id, req.body || {}, req.user))));

// ---- 09.08 / 09.09 agents ----------------------------------------------------------------------------------------------------
router.post('/agents/run', act, wrap(async (req, res) => {
  const b = req.body || {};
  let r = null;
  if (b.requirementId) { req.params.id = b.requirementId; r = await jobOf(req, res); if (!r) return undefined; }
  let runId;
  if (b.kind === 'submission') { if (!r) return res.status(400).json({ error: 'Pick the requirement.' }); runId = await A.agentSubmission(r, req.user); } else if (b.kind === 'followup') runId = await A.agentFollowUp(r, req.user);
  else if (b.kind === 'cleanup') { if (isBde(req.user)) return res.status(403).json(NOT_BDE); runId = await A.agentCleanup(req.user); } else if (b.kind === 'playbook') { if (!r) return res.status(400).json({ error: 'Pick the requirement.' }); if (isBde(req.user)) return res.status(403).json({ error: 'Rediscovery is for the recruiting team.' }); runId = await A.agentPlaybook(r, req.user); } else return res.status(400).json({ error: 'Pick an agent.' });
  await logAudit({ userId: req.user.id, action: `Agent run: ${b.kind}`, entity: 'MktAgentRun', entityId: runId, toValue: r ? r.title : 'all' });
  return res.status(201).json(await A.runDetail(runId, req.user));
}));
router.get('/agents/runs', wrap(async (req, res) => res.json({ rows: await A.runs(req.user) })));
router.get('/agents/runs/:id', wrap(async (req, res) => { const r = await A.runDetail(req.params.id, req.user); return r ? res.json(r) : res.status(404).json({ error: 'Run not found.' }); }));
router.post('/agents/runs/:id/decide', act, wrap(async (req, res) => {
  const out = await A.decideActions(req.params.id, { ids: Array.isArray((req.body || {}).ids) ? req.body.ids : null, decision: (req.body || {}).decision }, req.user);
  if (!out.error) await logAudit({ userId: req.user.id, action: `Agent actions ${String((req.body || {}).decision).toLowerCase()}: ${out.done.length}`, entity: 'MktAgentRun', entityId: req.params.id });
  return send(res, out);
}));

// ---- 09.10 workflows / 09.11 data health (Admin) ------------------------------------------------------------------------------
router.get('/workflows', admin, wrap(async (req, res) => res.json({ rows: await A.workflows(), triggers: A.TRIGGERS, actions: A.ACTIONS, on: await S.setting('workflows.on') })));
router.post('/workflows', admin, wrap(async (req, res) => {
  const out = await A.saveWorkflow(req.body || {}, req.user);
  if (!out.error) await logAudit({ userId: req.user.id, action: `Workflow saved${(req.body || {}).active ? ' (active)' : ''}`, entity: 'MktWorkflow', entityId: out.id, toValue: String((req.body || {}).name || '').slice(0, 80) });
  return send(res, out, 201);
}));
router.delete('/workflows/:id', admin, wrap(async (req, res) => { await logAudit({ userId: req.user.id, action: 'Workflow removed', entity: 'MktWorkflow', entityId: req.params.id }); return res.json(await A.deleteWorkflow(req.params.id)); }));
router.post('/workflows/:id/run', admin, wrap(async (req, res) => {
  const wf = (await A.workflows()).find((w) => w.id === req.params.id);
  if (!wf) return res.status(404).json({ error: 'Workflow not found.' });
  const dryRun = (req.body || {}).dryRun !== false;
  if (!dryRun && !(await S.setting('workflows.on'))) return res.status(409).json({ error: 'Workflow automations are OFF. Turn them on above, or use Dry run.' });
  const out = await A.runWorkflow(wf, { dryRun });
  if (!dryRun) await logAudit({ userId: req.user.id, action: `Workflow run by hand: ${out.rows.length}`, entity: 'MktWorkflow', entityId: wf.id });
  return res.json(out);
}));
router.get('/workflows/:id/log', admin, wrap(async (req, res) => res.json({ rows: await A.workflowLog(req.params.id) })));
router.get('/data-health', lead, wrap(async (req, res) => res.json({ runs: await A.healthRuns(), autofix: await S.setting('dataHealth.autofix'), schedule: await S.setting('dataHealth.schedule') })));
router.post('/data-health/run', lead, wrap(async (req, res) => {
  const fix = (req.body || {}).fix === true;
  if (fix && !isAdmin(req.user)) return res.status(403).json(ADMIN_ONLY);
  return res.json(await A.dataHealth({ fix, user: req.user }));
}));

// ---- 09.20 attrition risk -------------------------------------------------------------------------------------------------------
router.get('/attrition', wrap(async (req, res) => res.json(await A.attrition(req.user))));

// ---- 09.14 MCP tokens ---------------------------------------------------------------------------------------------------------
router.get('/mcp', wrap(async (req, res) => res.json({ on: await S.setting('mcp.on'), tokens: await MCP.tokens(req.user), tools: MCP.TOOLS.map((t) => ({ name: t.name, description: t.description })), endpoint: '/api/mcp' })));
router.post('/mcp/tokens', act, wrap(async (req, res) => {
  if (!(await S.setting('mcp.on'))) return res.status(409).json({ error: 'The MCP server is switched off (an Admin turns it on first).' });
  const out = await MCP.createToken(req.user, (req.body || {}).label);
  await logAudit({ userId: req.user.id, action: 'MCP token made', entity: 'MktMcpToken', entityId: out.id });
  return res.status(201).json(out);
}));
router.delete('/mcp/tokens/:id', wrap(async (req, res) => { const out = await MCP.revoke(req.params.id, req.user); if (!out.error) await logAudit({ userId: req.user.id, action: 'MCP token revoked', entity: 'MktMcpToken', entityId: req.params.id }); return send(res, out); }));

router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && err.code === 'AI_LIMIT') return res.status(429).json({ error: err.message });
  console.error('[mktb]', err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err); // eslint-disable-line no-console
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

module.exports = router;
