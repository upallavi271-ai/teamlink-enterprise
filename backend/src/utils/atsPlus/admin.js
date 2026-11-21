// ---------------------------------------------------------------------------
// ADMINISTRATION (market benchmark 13.02 / 13.03 / 13.07 / 13.12) - Administration -> ATS settings.
//
//   13.02 CUSTOM FORMS AND LAYOUTS  an Admin adds SECTIONS and FIELDS (text, number, date, pick list, yes/no; required or not) to the
//         requirement (job) form and the client form; they show as "More details" on the job / client page, in the order and sections
//         set here. The candidate form already has its own custom fields (Administration -> Candidate fields), linked from the same tab.
//   13.03 BLUEPRINTS                per department (or every department), what must be there before a person ENTERS a step: a comment
//         of N words, a field on the application (offered CTC, joining date, interview date), a document of a kind, consent given, the
//         onboarding checklist complete. Checked inside the one stage-move function (routes/applications.js applyStageMove), so the
//         board, the stage menu, bulk moves and the AI agent all obey it. The steps each department uses / who approves stay in
//         Pipeline & checks (utils/deptPipelines.js).
//   13.07 MULTI-CURRENCY            INR is the base; an Admin keeps the rates of USD / AED / EUR / GBP / SGD ...; any amount is shown
//         converted ("USD 1,200 ≈ ₹99,840") where a job's currency is not INR. Stored amounts never change.
//   13.12 SEATS AND PLAN            licence seats per role, the plan's name, against the active logins of each role and this month's
//         AI use; over-seat roles are flagged (nobody is blocked).
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../../db');
const { requirementWhere, clientWhere } = require('../scope');
const { logAudit } = require('../audit');
const S = require('./store');

// ------------------------------------------------------------------ 13.02 forms
const FORM_KEY = 'customForms';
const ENTITIES = { Requirement: 'Requirement (job)', Client: 'Client' };
const TYPES = ['text', 'textarea', 'number', 'date', 'select', 'yesno'];
async function forms() { return S.settings.get(FORM_KEY, { Requirement: { sections: [] }, Client: { sections: [] } }); }
function cleanForm(f) {
  const keys = new Set();
  const sections = (Array.isArray(f && f.sections) ? f.sections : []).slice(0, 12).map((s, i) => ({
    title: String(s.title || `Section ${i + 1}`).slice(0, 80),
    fields: (Array.isArray(s.fields) ? s.fields : []).slice(0, 30).map((x) => {
      let key = String(x.key || x.label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
      if (!key || keys.has(key)) key = `${key || 'field'}_${keys.size + 1}`;
      keys.add(key);
      return { key, label: String(x.label || key).slice(0, 80), type: TYPES.includes(x.type) ? x.type : 'text', required: !!x.required, options: x.type === 'select' ? (Array.isArray(x.options) ? x.options : String(x.options || '').split(',')).map((o) => String(o).trim()).filter(Boolean).slice(0, 40) : undefined, hint: String(x.hint || '').slice(0, 160) || undefined };
    }).filter((x) => x.label),
  }));
  return { sections };
}
function checkValue(fd, v) {
  if (v === undefined || v === null || v === '') return fd.required ? `${fd.label} is needed.` : null;
  if (fd.type === 'number' && !Number.isFinite(Number(v))) return `${fd.label}: a number.`;
  if (fd.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return `${fd.label}: a date.`;
  if (fd.type === 'select' && !(fd.options || []).includes(String(v))) return `${fd.label}: pick one of the list.`;
  return null;
}
async function entityInScope(user, entity, id) {
  if (entity === 'Requirement') return prisma.requirement.findFirst({ where: { AND: [{ id: String(id) }, requirementWhere(user)] }, select: { id: true } });
  if (entity === 'Client') return prisma.client.findFirst({ where: { AND: [{ id: String(id) }, clientWhere(user)] }, select: { id: true } });
  return null;
}

// ------------------------------------------------------------------ 13.03 blueprints
const BP_KEY = 'blueprints';
const RULE_KINDS = {
  comment: 'A comment of at least N words on the move',
  offeredCtc: 'The offered CTC is filled', joiningDate: 'The joining date is filled', interviewAt: 'An interview date is set',
  doc: 'A document of this kind is on the profile', consent: 'The candidate has given consent', onboarding: 'The joining checklist is complete',
};
async function blueprints() { return S.settings.get(BP_KEY, { rules: [] }); }
function cleanRules(rules) {
  const V = require('../atsVocab'); // eslint-disable-line global-require
  return (Array.isArray(rules) ? rules : []).slice(0, 100).map((r) => ({
    department: String(r.department || '*').trim().slice(0, 60) || '*', stage: String(r.stage || ''), kind: String(r.kind || ''),
    words: Math.max(1, Math.min(100, Number(r.words) || 5)), docType: String(r.docType || '').slice(0, 30) || null, message: String(r.message || '').slice(0, 200) || null,
  })).filter((r) => V.ALL_STAGE_CODES.includes(r.stage) && RULE_KINDS[r.kind]);
}
const lc = (s) => String(s || '').toLowerCase().trim();
// null = the move may go on; else { error, code, missing: [...] }
async function blueprintCheck(applicationId, stage, body = {}) {
  const { rules } = await blueprints();
  if (!rules || !rules.length) return null;
  const app = await prisma.application.findUnique({ where: { id: String(applicationId) }, select: { id: true, candidateId: true, offeredCtc: true, joiningDate: true, interviewAt: true, requirement: { select: { department: true } } } }).catch(() => null);
  if (!app) return null;
  const dept = lc(app.requirement && app.requirement.department);
  const mine = rules.filter((r) => r.stage === stage && (r.department === '*' || lc(r.department) === dept));
  if (!mine.length) return null;
  const V = require('../atsVocab'); // eslint-disable-line global-require
  const missing = [];
  for (const r of mine) {
    let ok = true;
    if (r.kind === 'comment') ok = String(body.comment || body.note || '').trim().split(/\s+/).filter(Boolean).length >= r.words;
    else if (r.kind === 'offeredCtc') ok = Number(body.offeredCtc || app.offeredCtc) > 0;
    else if (r.kind === 'joiningDate') ok = !!(body.joiningDate || app.joiningDate);
    else if (r.kind === 'interviewAt') ok = !!(body.interviewAt || app.interviewAt);
    else if (r.kind === 'doc') ok = (await prisma.candidateDocument.count({ where: { candidateId: app.candidateId, deletedAt: null, ...(r.docType ? { docType: r.docType } : {}) } })) > 0; // eslint-disable-line no-await-in-loop
    else if (r.kind === 'consent') ok = ((await prisma.candidate.findUnique({ where: { id: app.candidateId }, select: { consentStatus: true } })) || {}).consentStatus === 'GIVEN'; // eslint-disable-line no-await-in-loop
    else if (r.kind === 'onboarding') {
      const O = require('./onboarding'); // eslint-disable-line global-require
      const p = await O.packOf(app.id); // eslint-disable-line no-await-in-loop
      ok = !!p && O.packView(p).progress.pct === 100;
    }
    if (!ok) missing.push(r.message || (r.kind === 'comment' ? `a comment of at least ${r.words} words` : r.kind === 'doc' ? `a ${r.docType || ''} document on the profile`.replace('  ', ' ') : RULE_KINDS[r.kind].toLowerCase()));
  }
  if (!missing.length) return null;
  return { error: `Before ${V.STAGE_LABELS[stage] || stage}${dept ? ` (${app.requirement.department})` : ''}: ${missing.join('; ')}.`, code: 'BLUEPRINT', missing };
}

// ------------------------------------------------------------------ 13.07 currency
const CUR_KEY = 'currency';
const DEFAULT_RATES = { USD: 83.5, AED: 22.7, EUR: 90.5, GBP: 106, SGD: 62, SAR: 22.2, QAR: 22.9, AUD: 55, CAD: 61.5 };
async function currency() { const c = await S.settings.get(CUR_KEY, { base: 'INR', rates: DEFAULT_RATES, updatedAt: null }); return { base: 'INR', ...c, rates: { ...(c.rates || DEFAULT_RATES) } }; }
function convert(cur, amount, from, to = 'INR') {
  const a = Number(amount); if (!Number.isFinite(a)) return null;
  const f = String(from || 'INR').toUpperCase(); const t = String(to || 'INR').toUpperCase();
  const toInr = f === 'INR' ? 1 : cur.rates[f]; const fromInr = t === 'INR' ? 1 : cur.rates[t];
  if (!toInr || !fromInr) return null;
  return Math.round(((a * toInr) / fromInr) * 100) / 100;
}

// ------------------------------------------------------------------ 13.12 seats
const SEAT_KEY = 'seats';
const SEAT_ROLES = [['ADMIN', 'Admins (Super Admin + Admin)'], ['TL', 'Team leads (TL / STL)'], ['RECRUITER', 'Recruiters'], ['BDE', 'BDEs'], ['MANAGER', 'Managers / Assistant Managers'], ['HR', 'HR'], ['CLIENT', 'Client portal logins']];
function seatRoleOf(u) {
  if (['SUPER_ADMIN', 'ADMIN'].includes(u.role)) return 'ADMIN';
  if (u.role === 'CLIENT') return 'CLIENT';
  if (u.role === 'CANDIDATE') return null;
  if (['MANAGER', 'ASSISTANT_MANAGER'].includes(u.role) || ['MANAGER', 'ASSISTANT_MANAGER'].includes(u.atsRole)) return 'MANAGER';
  if (['TL', 'STL'].includes(u.atsRole) || ['TL', 'STL'].includes(u.role)) return 'TL';
  if (u.atsRole === 'BDE') return 'BDE';
  if (u.atsRole === 'RECRUITER') return 'RECRUITER';
  if (u.atsRole === 'HR' || u.hrmsRole === 'HR') return 'HR';
  return null;
}
async function seatUsage() {
  const s = await S.settings.get(SEAT_KEY, { plan: 'TeamLink (own product)', seats: {}, aiMonthly: null });
  const users = await prisma.user.findMany({ where: { status: 'Active' }, select: { role: true, atsRole: true, hrmsRole: true, atsAccess: true } });
  const used = {}; SEAT_ROLES.forEach(([k]) => { used[k] = 0; });
  users.forEach((u) => { const k = seatRoleOf(u); if (k && (k === 'CLIENT' || u.atsAccess !== false)) used[k] += 1; });
  const since = new Date(); since.setDate(1); since.setHours(0, 0, 0, 0);
  const ai = await prisma.auditLog.count({ where: { createdAt: { gte: since }, OR: [{ action: { startsWith: 'AI' } }, { action: { contains: ' AI ' } }] } });
  const rows = SEAT_ROLES.map(([k, label]) => { const seats = Number.isFinite(Number((s.seats || {})[k])) && (s.seats || {})[k] !== null && (s.seats || {})[k] !== '' ? Number(s.seats[k]) : null; return { role: k, label, seats, used: used[k], free: seats === null ? null : seats - used[k], over: seats !== null && used[k] > seats }; });
  return { plan: s.plan, rows, ai: { used: ai, monthly: s.aiMonthly, over: s.aiMonthly ? ai > s.aiMonthly : false }, over: rows.filter((r) => r.over).map((r) => r.label) };
}

// ------------------------------------------------------------------ routes
const router = express.Router();
router.get('/forms', S.internal, S.wrap(async (req, res) => res.json({ entities: ENTITIES, types: TYPES, forms: await forms(), canEdit: S.isAdmin(req.user) && !req.viewAs })));
router.put('/forms/:entity', S.adminOnly, S.wrap(async (req, res) => {
  const ent = req.params.entity; if (!ENTITIES[ent]) return res.status(400).json({ error: 'Requirement or Client.' });
  const all = await forms(); all[ent] = cleanForm(req.body || {});
  await S.settings.set(FORM_KEY, all, req.user);
  await logAudit({ userId: req.user.id, action: `Custom form saved: ${ENTITIES[ent]}`, entity: 'AtsPlusSetting', entityId: FORM_KEY, toValue: all[ent].sections.map((s) => `${s.title} (${s.fields.length})`).join(', ').slice(0, 300) });
  res.json(all[ent]);
}));
router.get('/forms/:entity/:id', S.internal, S.wrap(async (req, res) => {
  const ent = req.params.entity; if (!ENTITIES[ent]) return res.status(400).json({ error: 'Requirement or Client.' });
  if (!(await entityInScope(req.user, ent, req.params.id))) return res.status(404).json({ error: 'Not in your list.' });
  const form = (await forms())[ent] || { sections: [] };
  const [v] = await S.items.list('form-values', { refType: ent, refId: req.params.id });
  const values = (v && v.values) || {};
  const missing = form.sections.flatMap((s) => s.fields).filter((f) => f.required && (values[f.key] === undefined || values[f.key] === '')).map((f) => f.label);
  res.json({ form, values, missing, updatedBy: v ? v.updatedByName || v.createdByName : null, updatedAt: v ? v.updatedAt : null });
}));
router.put('/forms/:entity/:id', S.writer, S.wrap(async (req, res) => {
  const ent = req.params.entity; if (!ENTITIES[ent]) return res.status(400).json({ error: 'Requirement or Client.' });
  if (!(await entityInScope(req.user, ent, req.params.id))) return res.status(404).json({ error: 'Not in your list.' });
  const form = (await forms())[ent] || { sections: [] };
  const raw = (req.body || {}).values || {};
  const values = {}; const errors = [];
  form.sections.flatMap((s) => s.fields).forEach((f) => {
    let v = raw[f.key]; if (f.type === 'yesno' && v !== undefined && v !== '') v = v === true || v === 'yes' ? 'yes' : 'no';
    const e = checkValue(f, v); if (e) errors.push(e); else if (v !== undefined && v !== '') values[f.key] = f.type === 'number' ? Number(v) : String(v).slice(0, 2000);
  });
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });
  const [cur] = await S.items.list('form-values', { refType: ent, refId: req.params.id });
  if (cur) await S.items.update(cur.id, { values, updatedByName: req.user.name }); else await S.items.create('form-values', { refType: ent, refId: req.params.id, values, updatedByName: req.user.name }, req.user);
  await logAudit({ userId: req.user.id, action: `More details saved (${ENTITIES[ent]})`, entity: ent, entityId: req.params.id, toValue: Object.keys(values).join(', ').slice(0, 300) });
  res.json({ ok: true, values });
}));

router.get('/blueprints', S.internal, S.wrap(async (req, res) => {
  const V = require('../atsVocab'); // eslint-disable-line global-require
  res.json({ ...(await blueprints()), kinds: RULE_KINDS, stages: V.ALL_STAGE_CODES.map((c) => ({ code: c, label: V.STAGE_LABELS[c] || c })), departments: await require('../deptPipelines').departments().catch(() => []), canEdit: S.isAdmin(req.user) && !req.viewAs }); // eslint-disable-line global-require
}));
router.put('/blueprints', S.adminOnly, S.wrap(async (req, res) => {
  const rules = cleanRules((req.body || {}).rules);
  await S.settings.set(BP_KEY, { rules }, req.user);
  await logAudit({ userId: req.user.id, action: 'Workflow blueprint saved', entity: 'AtsPlusSetting', entityId: BP_KEY, toValue: rules.map((r) => `${r.department}/${r.stage}: ${r.kind}`).join(', ').slice(0, 300) });
  res.json({ rules });
}));
router.post('/blueprints/check', S.internal, S.wrap(async (req, res) => { const b = req.body || {}; res.json({ blocked: await blueprintCheck(b.applicationId, b.stage, b) }); }));

router.get('/currency', S.internal, S.wrap(async (req, res) => res.json({ ...(await currency()), canEdit: S.isAdmin(req.user) && !req.viewAs })));
router.put('/currency', S.adminOnly, S.wrap(async (req, res) => {
  const raw = (req.body || {}).rates || {};
  const rates = {}; Object.entries(raw).forEach(([k, v]) => { const c = String(k).toUpperCase(); const n = Number(v); if (/^[A-Z]{3}$/.test(c) && c !== 'INR' && n > 0 && n < 100000) rates[c] = Math.round(n * 10000) / 10000; });
  if (!Object.keys(rates).length) return res.status(400).json({ error: 'Give at least one rate (rupees for 1 unit).' });
  const next = { base: 'INR', rates, updatedAt: new Date().toISOString(), updatedBy: req.user.name };
  await S.settings.set(CUR_KEY, next, req.user);
  await logAudit({ userId: req.user.id, action: 'Currency rates saved', entity: 'AtsPlusSetting', entityId: CUR_KEY, toValue: JSON.stringify(rates).slice(0, 300) });
  res.json(next);
}));
router.get('/currency/convert', S.internal, S.wrap(async (req, res) => {
  const cur = await currency(); const v = convert(cur, req.query.amount, req.query.from, req.query.to || 'INR');
  if (v === null) return res.status(400).json({ error: 'Unknown currency or amount.' });
  res.json({ amount: Number(req.query.amount), from: String(req.query.from || 'INR').toUpperCase(), to: String(req.query.to || 'INR').toUpperCase(), value: v, rateDate: cur.updatedAt });
}));

router.get('/seats', S.adminOnly, S.wrap(async (req, res) => res.json(await seatUsage())));
router.put('/seats', S.adminOnly, S.wrap(async (req, res) => {
  const b = req.body || {};
  const seats = {}; SEAT_ROLES.forEach(([k]) => { const v = (b.seats || {})[k]; seats[k] = v === '' || v === null || v === undefined ? null : Math.max(0, Math.min(100000, Math.round(Number(v)) || 0)); });
  const next = { plan: String(b.plan || 'TeamLink (own product)').slice(0, 80), seats, aiMonthly: b.aiMonthly ? Math.max(0, Number(b.aiMonthly) || 0) : null };
  await S.settings.set(SEAT_KEY, next, req.user);
  await logAudit({ userId: req.user.id, action: 'Seats and plan saved', entity: 'AtsPlusSetting', entityId: SEAT_KEY, toValue: JSON.stringify(seats).slice(0, 300) });
  res.json(await seatUsage());
}));

module.exports = { router, blueprintCheck, convert, currency, seatUsage, forms };
