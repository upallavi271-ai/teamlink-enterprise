// /api/outreach/gs/crm : the CRM pages of Omni-Channel (CRM Fields, All Customers, Segments, Web Forms). Behind login + "may use Omni-Channel" (routes/outreach.js).
// Logic: outreach/crmApi.js (fields, customers, detail, export), contacts.js (update), segments.js, forms.js, atsImport.js, import.js (the file import is
// still /api/outreach/import/check|save and /imports: the same engine, now with language / preferred channel / notes / custom fields).
// The server decides who may see and do what (outreach/access.js); the screens only hide buttons. Nothing here sends a message.
const express = require('express');
const S = require('../outreach/store');
const A = require('../outreach/access');
const C = require('../outreach/consent');
const K = require('../outreach/contacts');
const G = require('../outreach/segments');
const R = require('../outreach/rules');
const Pol = require('../outreach/policy');
const I = require('../outreach/import');
const Crm = require('../outreach/crmApi');
const Forms = require('../outreach/forms');
const Ats = require('../outreach/atsImport');
const { deptOf } = require('../outreach/chrome');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => (e instanceof S.OutreachError ? res.status(e.status).json({ error: e.message, code: e.code }) : next(e)));
const send = (res, out) => (out && out.error ? res.status(out.status || 400).json({ error: out.error, ...(out.duplicateId ? { duplicateId: out.duplicateId } : {}) }) : res.json(out));
const typeOf = (v) => (v === 'internal' ? 'internal' : 'candidate_lead');
const needTables = wrap(async (req, res, next) => {
  if (await S.ready()) return next();
  return res.status(503).json({ error: 'Omni-Channel is being set up. Please try again in a little while.', setup: true });
});
const limit = (n = 240) => {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const l = (hits.get(req.user.id) || []).filter((t) => now - t < 60000);
    if (l.length >= n) return res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' });
    l.push(now); hits.set(req.user.id, l);
    return next();
  };
};
const jsonOf = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
router.use(needTables);

// ---- CRM FIELDS -------------------------------------------------------------------------------------------------------------------------------
router.get('/fields', wrap(async (req, res) => res.json(await Crm.fieldsList(req.user))));
router.post('/fields', limit(60), wrap(async (req, res) => send(res, await Crm.fieldCreate(req.user, req.body || {}))));
router.put('/fields/:id', limit(60), wrap(async (req, res) => send(res, await Crm.fieldUpdate(req.user, req.params.id, req.body || {}))));
router.delete('/fields/:id', limit(60), wrap(async (req, res) => send(res, await Crm.fieldDelete(req.user, req.params.id))));

// ---- ALL CUSTOMERS ---------------------------------------------------------------------------------------------------------------------------
const listQuery = (req) => {
  const q = req.query;
  const dept = deptOf(req.user, q.dept);
  return { type: typeOf(q.type), q: q.q, page: q.page, pageSize: q.pageSize, sort: q.sort, dir: q.dir, filters: jsonOf(q.filters) || {}, form: q.form, dept, cols: String(q.cols || '').split(',').map((x) => x.trim()).filter(Boolean) };
};
router.get('/customers', limit(), wrap(async (req, res) => res.json(await Crm.customers(req.user, listQuery(req)))));
router.get('/customers/export', limit(20), wrap(async (req, res) => {
  const out = await Crm.exportXlsx(req.user, listQuery(req));
  if (out.error) return send(res, out);
  res.set('Content-Disposition', `attachment; filename="customers-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.set('X-Customer-Count', String(out.count));
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return res.send(out.buffer);
}));
router.post('/customers', limit(60), wrap(async (req, res) => send(res, await Crm.addCustomer(req.user, req.body || {}))));
router.get('/customers/:id', limit(), wrap(async (req, res) => {
  const d = await Crm.detail(req.user, req.params.id);
  return d ? res.json(d) : res.status(404).json({ error: 'This person was not found.' });
}));
router.put('/customers/:id', limit(240), wrap(async (req, res) => send(res, await Crm.editCustomer(req.user, req.params.id, req.body || {}))));
router.post('/customers/:id/opt-out', limit(120), wrap(async (req, res) => {
  const one = await K.getOne(req.user, req.params.id);
  if (!one) return res.status(404).json({ error: 'This person was not found.' });
  if (!A.mayOptOut(req.user) || !A.mayWrite(req.user, one.row.contactType)) return res.status(403).json({ error: 'You cannot change who is opted out.' });
  const why = S.clip((req.body || {}).reason, 300);
  if (why.length < 5) return res.status(400).json({ error: 'Write in a few words why (for example: "Asked us on the phone to stop").' });
  const out = await C.optOut(req.params.id, (req.body || {}).channel || 'all', { reason: A.isAdmin(req.user) ? 'admin' : 'manual', source: 'screen', evidence: why, by: req.user });
  return send(res, out.error ? out : { ok: out.changed.length ? 'Opted out. They will not get messages on that channel.' : 'They were already opted out.', changed: out.changed });
}));
router.post('/customers/:id/opt-in', limit(60), wrap(async (req, res) => {
  if (!A.mayOptIn(req.user)) return res.status(403).json({ error: 'Only an Admin can record permission.' });
  const one = await K.getOne(req.user, req.params.id);
  if (!one) return res.status(404).json({ error: 'This person was not found.' });
  const out = await C.optIn(req.params.id, (req.body || {}).channel || 'all', { reason: (req.body || {}).reason, by: req.user });
  return send(res, out.error ? out : { ok: out.changed.length ? 'Permission recorded (the history is kept).' : 'Nothing changed.', changed: out.changed });
}));

// ---- IMPORT (the file import itself is /api/outreach/import/*; here: the sample file) ----------------------------------------------------------------
router.get('/import/sample.csv', wrap(async (req, res) => {
  const customs = await I.importFields();
  const rows = I.templateRows(typeOf(req.query.type), customs);
  const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  res.set('Content-Disposition', 'attachment; filename="customer_import_sample.csv"');
  res.type('text/csv; charset=utf-8');
  return res.send(`﻿${rows.map((r) => r.map(q).join(',')).join('\r\n')}\r\n`);
}));
router.get('/import/fields', wrap(async (req, res) => res.json({ fields: I.wordsFor(await I.importFields()) })));

// ---- IMPORT FROM ATS (Admin and Team Lead) ---------------------------------------------------------------------------------------------------
router.get('/ats/options', limit(60), wrap(async (req, res) => {
  if (!A.has('mayImportAts')(req.user)) return res.status(403).json({ error: 'Only an Admin or a Team Lead can copy candidates from the ATS.' });
  return res.json(await Ats.options(req.user));
}));
router.post('/ats/preview', limit(60), wrap(async (req, res) => send(res, await Ats.preview(req.user, req.body || {}))));
router.post('/ats/import', limit(20), wrap(async (req, res) => send(res, await Ats.run(req.user, req.body || {}))));

// ---- SEGMENTS ----------------------------------------------------------------------------------------------------------------------------------
async function segView(user, list) {
  const defs = await Pol.customFields();
  const ids = [...new Set(list.flatMap((s) => s.rules.importIds || []))];
  const names = ids.length ? await S.q(`SELECT id, fileName, source FROM "OutreachImport" WHERE id IN (${R.ph(ids.length)})`, ...ids) : [];
  const imports = Object.fromEntries(names.map((n) => [n.id, n.source || n.fileName || 'an import']));
  return list.map((s) => ({
    id: s.id, name: s.name, contactType: s.contactType, rules: s.rules, summary: G.describeRules(s.rules, { imports, fields: defs }), kinds: s.rules.industries || [], counts: s.counts, countedAt: s.countedAt || s.refreshedAt || s.createdAt,
    createdByName: s.createdByName, createdAt: s.createdAt, canEdit: A.mayWrite(user, s.contactType) && (A.isAdmin(user) || s.createdById === user.id),
  }));
}
router.get('/segments', limit(), wrap(async (req, res) => {
  const type = typeOf(req.query.type);
  const dept = deptOf(req.user, req.query.dept);
  if (dept === null) return res.json({ segments: [], canCreate: false, canUse: false });
  let list = await G.listWithSnapshots(req.user, { type });
  if (dept && type !== 'internal') {
    const inds = await S.industries();
    const kinds = inds.filter((i) => String(i.department || i.name).toLowerCase() === dept.toLowerCase()).map((i) => i.name);
    list = list.filter((s) => !(s.rules.industries || []).length || s.rules.industries.some((k) => kinds.includes(k)));
  }
  return res.json({ segments: await segView(req.user, list), canCreate: A.mayWrite(req.user, type), canUse: A.mayCampaign(req.user), type });
}));
router.get('/segments/meta', wrap(async (req, res) => res.json(await Crm.segmentMeta(req.user, typeOf(req.query.type)))));
router.post('/segments/preview', limit(120), wrap(async (req, res) => {
  const type = typeOf((req.body || {}).contactType);
  if (!A.mayRead(req.user, type)) return res.status(403).json({ error: 'You cannot look at this kind of contact.' });
  const rules = R.cleanRules((req.body || {}).rules);
  const d = await G.describe({ filterRules: JSON.stringify(rules), contactType: type }, await K.scopeConds(req.user, type));
  return res.json({ counts: d.counts, people: d.people, warning: d.warning });
}));
router.get('/segments/:id/preview', limit(), wrap(async (req, res) => {
  const seg = await G.get(req.user, req.params.id);
  if (!seg) return res.status(404).json({ error: 'This segment was not found.' });
  const d = await G.describe({ filterRules: JSON.stringify(seg.rules), contactType: seg.contactType }, await K.scopeConds(req.user, seg.contactType));
  return res.json({ name: seg.name, counts: d.counts, people: d.people, warning: d.warning });
}));
router.post('/segments/:id/refresh', limit(60), wrap(async (req, res) => {
  const seg = await G.get(req.user, req.params.id);
  if (!seg) return res.status(404).json({ error: 'This segment was not found.' });
  const snap = await G.snapshot(seg, { force: true });
  return res.json({ counts: snap.counts, countedAt: snap.countedAt });
}));
router.post('/segments/:id/duplicate', limit(60), wrap(async (req, res) => {
  const out = await G.duplicate(req.user, req.params.id, S.clip((req.body || {}).name, 80));
  return out.error ? send(res, out) : res.json({ ok: `"${out.segment.name}" created.`, id: out.segment.id });
}));
router.post('/segments', limit(60), wrap(async (req, res) => {
  const out = await G.create(req.user, req.body || {});
  return out.error ? send(res, out) : res.json({ ok: `"${out.segment.name}" created.`, id: out.segment.id });
}));
router.put('/segments/:id', limit(60), wrap(async (req, res) => {
  const out = await G.update(req.user, req.params.id, req.body || {});
  return out.error ? send(res, out) : res.json({ ok: `"${out.segment.name}" updated.`, id: out.segment.id });
}));
router.delete('/segments/:id', limit(60), wrap(async (req, res) => send(res, await G.remove(req.user, req.params.id))));

// ---- WEB FORMS --------------------------------------------------------------------------------------------------------------------------------
router.get('/forms', limit(), wrap(async (req, res) => res.json(await Forms.list(req.user))));
router.get('/forms/submissions', limit(), wrap(async (req, res) => res.json(await Forms.submissions(req.user, { formId: req.query.formId, limit: req.query.limit }))));
router.post('/forms', limit(60), wrap(async (req, res) => {
  const dept = deptOf(req.user, req.query.dept);
  const out = await Forms.create(req.user, req.body || {}, dept || '');
  return out.error ? send(res, out) : res.json({ ok: 'Form created.', form: out.form });
}));
router.put('/forms/:id', limit(60), wrap(async (req, res) => {
  const out = await Forms.update(req.user, req.params.id, req.body || {});
  return out.error ? send(res, out) : res.json({ ok: 'Form updated.', form: out.form });
}));
router.delete('/forms/:id', limit(60), wrap(async (req, res) => send(res, await Forms.remove(req.user, req.params.id))));

module.exports = router;
