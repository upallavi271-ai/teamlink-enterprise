// ---------------------------------------------------------------------------
// /api/job-broadcast : the ready template, "Post to all selected places", contact lists and the WhatsApp job broadcast.
// Flow and rules: docs/job-broadcast/FLOW.md. Nothing here sends or posts by itself: every send is a person's click.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requireProduct } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const sandbox = require('../utils/sandbox');
const core = require('../utils/messagingCore');
const S = require('../broadcast/store');
const A = require('../broadcast/access');
const L = require('../broadcast/lists');
const T = require('../broadcast/template');
const C = require('../broadcast/campaign');
const R = require('../broadcast/replies');
const P = require('../broadcast/post');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));
router.use((req, res, next) => {
  if (A.kind(req.user) === 'none') return res.status(403).json({ error: 'Requirement broadcasts are for team leads, client managers, Admins and managers.' });
  return next();
});
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res, next); } catch (e) { next(e); } };
const fail = (res, out) => res.status(out.status || 400).json({ error: out.error, code: out.code || undefined, blockers: out.blockers || undefined });
const send = (res, out) => (out && out.error ? fail(res, out) : res.json(out));
const mustRun = (req, res) => { if (A.mayRun(req.user)) return true; res.status(403).json({ error: 'You can look but not change. A team lead, client manager or Admin does this.' }); return false; };
const baseOf = (req) => process.env.APP_BASE_URL || req.get('origin') || '';

// a small limit per login on the commands
const hits = new Map();
function limit(n = 240) {
  return (req, res, next) => {
    const now = Date.now();
    const list = (hits.get(req.user.id) || []).filter((t) => now - t < 60000);
    if (list.length >= n) return res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' });
    list.push(now); hits.set(req.user.id, list);
    return next();
  };
}

// ---------------------------------------------------------------------------
// A. THE READY TEMPLATE
// ---------------------------------------------------------------------------
async function jobOf(req, res) {
  const r = await T.fromJob(req.params.id);
  if (!r) { res.status(404).json({ error: 'Requirement not found.' }); return null; }
  const access = require('../jobPublish/access'); // eslint-disable-line global-require
  if (!access.inScope(req.user, r)) { res.status(403).json({ error: 'This requirement is not in your area.' }); return null; }
  if (!(await A.mayViewJob(req.user, r))) { res.status(403).json({ error: 'HR can only use internal requirements here.' }); return null; }
  return r;
}
const versionsView = (rec) => (rec ? { current: rec.current, used: rec.used || 0, versions: rec.versions.map((v) => ({ v: v.v, at: v.at, byName: v.byName, label: v.label, edited: v.edited, note: v.note })) } : { current: 0, used: 0, versions: [] });

// from the form (nothing saved yet) or for a saved job
router.post('/ready-template/preview', limit(), wrap(async (req, res) => {
  // Reading only (nothing is saved or posted): the managers who send a job request and HR (internal jobs) may see the preview too.
  if (!A.mayView(req.user)) return res.status(403).json({ error: 'You can not use the requirement preview.' });
  const b = req.body || {};
  let r;
  if (b.requirementId) { req.params.id = b.requirementId; r = await jobOf(req, res); if (!r) return undefined; } else r = await T.fromFields(b.fields || {});
  if (!String(r.title || '').trim()) return res.status(400).json({ error: 'Fill in the requirement title first.' });
  const g = await T.generate(r, { overrides: b.overrides || {}, base: baseOf(req) });
  return res.json({ ...g, ai: await require('../utils/jobText').aiStatus().then((s) => ({ available: s.available, reason: s.available ? null : s.reason })) }); // eslint-disable-line global-require
}));

router.get('/jobs/:id/ready-template', wrap(async (req, res) => {
  const r = await jobOf(req, res); if (!r) return undefined;
  const { rec, version } = await T.ensure(req.user, r, baseOf(req));
  const g = await T.generate(r, { base: baseOf(req) });
  const jt = require('../utils/jobText'); // eslint-disable-line global-require
  const ai = await jt.aiStatus();
  return res.json({ texts: version.texts, label: version.label, edited: version.edited, version: version.v, ...versionsView(rec), previews: g.previews, sample: g.sample, missing: g.missing, warnings: g.warnings, hidesClient: g.hidesClient, smsChars: g.smsChars, applyLink: g.applyLink, ai: { available: ai.available, reason: ai.available ? null : ai.reason }, canEdit: A.mayRun(req.user) && (await A.mayPostJob(req.user, r)), job: { id: r.id, title: r.title, code: r.reqCode, status: r.status, internal: !!r.internal } });
}));
// save a person's edit (a new version), or write again from the job (regenerate / AI polish)
router.post('/jobs/:id/ready-template', limit(), wrap(async (req, res) => {
  const r = await jobOf(req, res); if (!r) return undefined;
  if (!(await A.mayPostJob(req.user, r))) return res.status(403).json({ error: 'Posting requirements is done by your team lead or the client manager.' });
  const b = req.body || {};
  const cur = await T.ensure(req.user, r, baseOf(req));
  let texts; let label; let edited = false; let note = '';
  if (b.regenerate) {
    const g = await T.generate(r, { base: baseOf(req) });
    texts = g.texts; label = g.label; note = 'Written again from the requirement';
    if (b.ai) {
      const p = await T.aiPolish(r, baseOf(req));
      if (p.error) return fail(res, p);
      texts = { ...texts, jobPost: p.master }; label = p.label; note = 'Long text polished by AI';
    }
  } else if (b.texts && typeof b.texts === 'object') {
    texts = T.cleanTexts(b.texts, cur.version.texts); label = 'Edited by a person'; edited = true; note = String(b.note || '').slice(0, 120);
    const leak = T.hideNames(Object.values(texts).join('\n'), []);
    void leak; // eslint-disable-line no-void
    const bad = Object.values(texts).join('\n').split('\n').filter((l) => T.AGREEMENT.test(l));
    if (bad.length) return res.status(400).json({ error: `Take these lines out first, they are about the agreement or fees and must not go out: "${bad[0].slice(0, 60)}"` });
    const names = [r.client && !r.internal ? r.client.name : null, r.client && !r.internal ? r.client.legalName : null].filter((n) => n && n.length >= 3);
    const joined = Object.values(texts).join('\n').toLowerCase();
    const hit = names.find((n) => joined.includes(n.toLowerCase()));
    if (hit) return res.status(400).json({ error: `The client name "${hit}" is in the text. It must be hidden (write "our client").` });
  } else return res.status(400).json({ error: 'There was no text to save.' });
  const rec = await T.addVersion(r.id, texts, { label, user: req.user, edited, note });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: b.regenerate ? 'Ready template written again' : 'Ready template edited', entity: 'Requirement', entityId: r.id, toValue: `version ${rec.current} · ${label}` });
  return res.json({ ok: 'Saved as a new version. Press "Use this" to make it the text that goes out.', texts, label, version: rec.current, ...versionsView(rec) });
}));
router.post('/jobs/:id/ready-template/use', limit(), wrap(async (req, res) => {
  const r = await jobOf(req, res); if (!r) return undefined;
  if (!(await A.mayPostJob(req.user, r))) return res.status(403).json({ error: 'Posting requirements is done by your team lead or the client manager.' });
  const out = await T.useVersion(req.user, r, (req.body || {}).version);
  if (out.error) return fail(res, out);
  return res.json({ ok: 'Done. Posting and WhatsApp use this text.', ...out, ...versionsView(await T.load(r.id)) });
}));
router.get('/jobs/:id/ready-template/versions/:v', wrap(async (req, res) => {
  const r = await jobOf(req, res); if (!r) return undefined;
  const rec = await T.load(r.id);
  const v = rec && rec.versions.find((x) => x.v === Number(req.params.v));
  return v ? res.json(v) : res.status(404).json({ error: 'That version was not found.' });
}));

// "My job templates" (a reusable library; each also appears in Message templates as "Job post: <name>")
const LIB = 'jobtpl.lib.';
router.get('/templates', wrap(async (req, res) => {
  const out = [];
  for (const k of await S.keys(LIB)) { const t = await S.get(k); if (t) out.push({ id: t.id, name: t.name, jobTitle: t.jobTitle, byName: t.byName, at: t.at, mine: t.byId === req.user.id, texts: t.texts }); } // eslint-disable-line no-await-in-loop
  return res.json({ templates: out.sort((a, b) => String(b.at).localeCompare(String(a.at))), canEdit: A.mayRun(req.user) });
}));
router.post('/templates', limit(), wrap(async (req, res) => {
  if (!mustRun(req, res)) return undefined;
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 80);
  if (name.length < 2) return res.status(400).json({ error: 'Give the template a name.' });
  const texts = T.cleanTexts(b.texts || {});
  if (!texts.whatsapp.trim()) return res.status(400).json({ error: 'There is no text to save.' });
  const id = S.newId('jt');
  const purpose = `CUSTOM_JOB_POST_${id.slice(2, 10).toUpperCase()}`;
  const rec = { id, name, jobTitle: String(b.jobTitle || '').slice(0, 120), byId: req.user.id, byName: req.user.name, at: new Date().toISOString(), texts, purpose };
  await S.put(LIB + id, rec, req.user);
  // the same wording in Message templates, category "Job post" (best effort: the library is the master copy)
  try {
    const T0 = require('../utils/messageTemplates'); // eslint-disable-line global-require
    if (T0.supported()) {
      const label = `Job post: ${name}`;
      await T0.create(req.user, { purpose, purposeLabel: label, channel: 'WhatsApp', body: texts.whatsapp.slice(0, 1000), name: label });
      await T0.create(req.user, { purpose, purposeLabel: label, channel: 'SMS', body: texts.sms.slice(0, 1000), name: label });
      await T0.create(req.user, { purpose, purposeLabel: label, channel: 'Email', subject: texts.emailSubject, body: texts.emailBody.slice(0, 4000), name: label });
    }
  } catch { /* the library still works */ }
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Job template saved to the library', entity: 'JobTemplate', entityId: id, toValue: name });
  return res.json({ ok: `Saved as "${name}" in My job templates.`, template: { id, name } });
}));
// RENAME / EDIT a saved template (2026-10-13): the person who saved it, or an Admin; the saved edit is what the next job starts from.
router.put('/templates/:id', limit(), wrap(async (req, res) => {
  if (!mustRun(req, res)) return undefined;
  const t = await S.get(LIB + req.params.id);
  if (!t) return res.status(404).json({ error: 'That template was not found.' });
  if (t.byId !== req.user.id && !A.isAdmin(req.user)) return res.status(403).json({ error: 'Only the person who saved it, or an Admin, can change it.' });
  const b = req.body || {};
  const next = { ...t };
  if (b.name !== undefined) {
    const name = String(b.name || '').trim().slice(0, 80);
    if (name.length < 2) return res.status(400).json({ error: 'Give the template a name.' });
    next.name = name;
  }
  if (b.texts) {
    const texts = T.cleanTexts(b.texts);
    if (!texts.whatsapp.trim()) return res.status(400).json({ error: 'There is no text to save.' });
    next.texts = texts;
  }
  next.editedById = req.user.id; next.editedByName = req.user.name; next.editedAt = new Date().toISOString();
  await S.put(LIB + t.id, next, req.user);
  try { // the same wording in Message templates (best effort: the library is the master copy)
    const rows = await prisma.messageTemplate.findMany({ where: { purpose: t.purpose, builtIn: false } });
    const label = `Job post: ${next.name}`;
    for (const row of rows) { // eslint-disable-line no-restricted-syntax
      const body = row.channel === 'WhatsApp' ? next.texts.whatsapp.slice(0, 1000) : row.channel === 'SMS' ? next.texts.sms.slice(0, 1000) : next.texts.emailBody.slice(0, 4000);
      // eslint-disable-next-line no-await-in-loop
      await prisma.messageTemplate.update({ where: { id: row.id }, data: { name: label, purposeLabel: label, body, ...(row.channel === 'Email' ? { subject: next.texts.emailSubject } : {}) } });
    }
  } catch { /* the library still works */ }
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Job template changed in the library', entity: 'JobTemplate', entityId: t.id, toValue: next.name });
  return res.json({ ok: 'Saved.', template: { id: t.id, name: next.name } });
}));
router.delete('/templates/:id', wrap(async (req, res) => {
  const t = await S.get(LIB + req.params.id);
  if (!t) return res.status(404).json({ error: 'That template was not found.' });
  if (t.byId !== req.user.id && !A.isAdmin(req.user)) return res.status(403).json({ error: 'Only the person who saved it, or an Admin, can remove it.' });
  await S.del(LIB + t.id);
  try {
    const T0 = require('../utils/messageTemplates'); // eslint-disable-line global-require
    const rows = await prisma.messageTemplate.findMany({ where: { purpose: t.purpose, builtIn: false } });
    for (const row of rows) await T0.remove(req.user, row.id); // eslint-disable-line no-await-in-loop
  } catch { /* nothing to remove */ }
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Job template removed from the library', entity: 'JobTemplate', entityId: t.id, toValue: t.name });
  return res.json({ ok: 'Removed.' });
}));

// ---------------------------------------------------------------------------
// B. POST TO ALL SELECTED PLACES
// ---------------------------------------------------------------------------
router.post('/jobs/:id/post-everywhere', limit(60), wrap(async (req, res) => {
  const out = await P.postEverywhere(req.user, req.params.id, req.body || {}, baseOf(req));
  return send(res, out);
}));
router.get('/jobs/:id/post-status', wrap(async (req, res) => send(res, await P.status(req.user, req.params.id))));
router.get('/places', (req, res) => res.json({ places: P.PLACES.map((id) => ({ id, name: P.NAMES[id] })) }));

// ---------------------------------------------------------------------------
// C. CONTACT LISTS
// ---------------------------------------------------------------------------
const raw = express.raw({ type: () => true, limit: '12mb' });
router.get('/lists/template', (req, res) => {
  const XLSX = require('xlsx'); // eslint-disable-line global-require
  const wb = XLSX.utils.book_new();
  const rows = [['Name', 'Phone / WhatsApp', 'Email', 'Company', 'City', 'Skills', 'Experience', 'Tag', 'Permission (yes/no)'], ['Anita Rao', '9876543210', 'anita@example.com', 'City Care Hospital', 'Hyderabad', 'ICU nursing', '3', 'Nurses', 'yes']];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Contacts');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: req.query.format === 'csv' ? 'csv' : 'xlsx' });
  res.set('Content-Disposition', `attachment; filename="contact-list-template.${req.query.format === 'csv' ? 'csv' : 'xlsx'}"`);
  res.type(req.query.format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return res.send(buf);
});
async function parsedUpload(req, res) {
  if (!mustRun(req, res)) return null;
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  const file = L.readFile(buf);
  if (file.error) { res.status(400).json({ error: file.error }); return null; }
  if (file.rows.length > L.MAX_ROWS) { res.status(400).json({ error: `The file has ${file.rows.length} rows. The most for one import is ${L.MAX_ROWS}. Split it into two files.`, code: 'TOO_MANY_ROWS' }); return null; }
  let map = null;
  try { map = req.query.mapping ? JSON.parse(req.query.mapping) : null; } catch { map = null; }
  const auto = L.autoMap(file.headers);
  return { file, map: map && typeof map === 'object' && Object.keys(map).length ? map : auto, auto };
}
router.post('/import/check', limit(120), raw, wrap(async (req, res) => {
  const up = await parsedUpload(req, res); if (!up) return undefined;
  if (up.map.phone === undefined || up.map.phone === null || up.map.phone === '') return res.json({ needsMapping: true, headers: up.file.headers, mapping: up.map, fields: L.FIELD_WORDS, rowCount: up.file.rows.length, error: 'We could not find the phone column. Choose it below.' });
  const out = await L.classify(up.file.rows, up.map);
  const problems = out.contacts.filter((c) => !['valid'].includes(c.status));
  return res.json({
    headers: up.file.headers, mapping: up.map, fields: L.FIELD_WORDS, rowCount: up.file.rows.length, totals: out.totals, canSend: L.sendableCount(out.totals),
    preview: out.contacts.slice(0, 30).map((c) => L.viewContact(c, req.user)), problems: problems.slice(0, 500).map((c) => L.viewContact(c, req.user)), problemCount: problems.length,
    statusWords: L.STATUS_WORDS,
  });
}));
router.post('/import/save', limit(60), raw, wrap(async (req, res) => {
  const up = await parsedUpload(req, res); if (!up) return undefined;
  const name = String(req.query.name || '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'Give the list a name.' });
  if (up.map.phone === undefined || up.map.phone === null || up.map.phone === '') return res.status(400).json({ error: 'Choose the phone column first.' });
  const dupName = (await L.listAll(req.user)).some((l) => l.name.toLowerCase() === name.toLowerCase());
  if (dupName) return res.status(409).json({ error: `You already have a list called "${name}". Pick another name.` });
  const out = await L.classify(up.file.rows, up.map);
  if (!L.sendableCount(out.totals)) return res.status(400).json({ error: 'None of the rows has a number we can message, so nothing was saved. Check the file and try again.', totals: out.totals });
  const meta = await L.saveList(req.user, { name, source: req.query.source, ownerId: req.user.id, ownerName: req.user.name, contacts: out.contacts, totals: out.totals, filename: String(req.query.filename || '') });
  return res.json({ ok: `Saved "${meta.name}": ${L.sendableCount(out.totals)} people can be messaged.`, list: meta, totals: out.totals });
}));
router.get('/lists', wrap(async (req, res) => {
  const lists = await L.listAll(req.user, { includeDeleted: req.query.deleted === '1' });
  return res.json({ lists, canRun: A.mayRun(req.user), masked: A.masked(req.user) });
}));
router.get('/lists/:id', wrap(async (req, res) => {
  const meta = await L.getList(req.user, req.params.id);
  if (!meta) return res.status(404).json({ error: 'This list was not found.' });
  const all = await S.get(`bc.contacts.${meta.id}`, []);
  const counts = {}; all.forEach((c) => { counts[c.status] = (counts[c.status] || 0) + 1; });
  const status = String(req.query.status || ''); const q = String(req.query.q || '').toLowerCase();
  const page = Math.max(1, Number(req.query.page) || 1); const size = 50;
  const rows = all.filter((c) => (!status || c.status === status) && (!q || `${c.name} ${c.company} ${c.city}`.toLowerCase().includes(q)));
  return res.json({ list: meta, counts, statusWords: L.STATUS_WORDS, total: rows.length, page, contacts: rows.slice((page - 1) * size, page * size).map((c) => L.viewContact(c, req.user)), canRun: A.mayRun(req.user), masked: A.masked(req.user) });
}));
router.post('/lists/:id/consent', limit(), wrap(async (req, res) => { if (!mustRun(req, res)) return undefined; if (!(req.body || {}).confirm) return res.status(400).json({ error: 'Tick the box to confirm.' }); return send(res, await L.recordConsent(req.user, req.params.id, req.body || {})); }));
router.put('/lists/:id', limit(), wrap(async (req, res) => {
  if (!mustRun(req, res)) return undefined;
  const meta = await L.getList(req.user, req.params.id);
  if (!meta) return res.status(404).json({ error: 'This list was not found.' });
  const b = req.body || {};
  if (b.retentionDays !== undefined) { const n = Math.floor(Number(b.retentionDays)); if (!(n >= 0 && n <= 3650)) return res.status(400).json({ error: 'Keep the list for 0 to 3650 days (0 = keep until deleted).' }); meta.retentionDays = n; }
  if (typeof b.source === 'string') meta.source = b.source.trim().slice(0, 140);
  await S.put(`bc.list.${meta.id}`, meta, req.user);
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Contact list settings changed', entity: 'ContactList', entityId: meta.id, toValue: `keep ${meta.retentionDays} days` });
  return res.json({ list: meta });
}));
router.delete('/lists/:id', limit(), wrap(async (req, res) => { if (!mustRun(req, res)) return undefined; return send(res, await L.softDelete(req.user, req.params.id)); }));
router.post('/lists/:id/undelete', limit(), wrap(async (req, res) => { if (!mustRun(req, res)) return undefined; return send(res, await L.undelete(req.user, req.params.id)); }));
router.get('/lists/:id/export', limit(60), wrap(async (req, res) => {
  if (!mustRun(req, res)) return undefined;
  if (A.masked(req.user)) return res.status(403).json({ error: 'The phone numbers are hidden from your login, so this list cannot be downloaded.' });
  const meta = await L.getList(req.user, req.params.id);
  if (!meta) return res.status(404).json({ error: 'This list was not found.' });
  const contacts = await S.get(`bc.contacts.${meta.id}`, []);
  const XLSX = require('xlsx'); // eslint-disable-line global-require
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Name', 'Phone', 'Email', 'Company', 'City', 'Skills', 'Tag', 'Status', 'Note'], ...contacts.map((c) => [c.name, c.phone ? `+${c.phone}` : c.rawPhone, c.email, c.company, c.city, c.skills, c.tag, L.STATUS_WORDS[c.status], c.why])]), 'Contacts');
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Contact list exported', entity: 'ContactList', entityId: meta.id, toValue: `${meta.name} · ${contacts.length} rows` });
  res.set('Content-Disposition', `attachment; filename="${meta.name.replace(/[^A-Za-z0-9 _-]/g, '')}.xlsx"`);
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}));

// ---------------------------------------------------------------------------
// D. CAMPAIGNS
// ---------------------------------------------------------------------------
router.get('/channel', wrap(async (req, res) => res.json({ channel: await C.channelState(), settings: await S.settings(), templates: await C.approvedTemplates() })));
router.get('/settings', wrap(async (req, res) => res.json({ settings: await S.settings(), canEdit: A.isAdmin(req.user) })));
router.put('/settings', limit(), wrap(async (req, res) => {
  if (!A.isAdmin(req.user)) return res.status(403).json({ error: 'Only an Admin or Super Admin can change these switches.' });
  const b = req.body || {}; const cur = await S.settings(); const next = { ...cur };
  if (typeof b.master === 'boolean') next.master = b.master;
  if (typeof b.showAddAsCandidate === 'boolean') next.showAddAsCandidate = b.showAddAsCandidate;
  if (b.autoReply) next.autoReply = { on: !!b.autoReply.on, text: String(b.autoReply.text || cur.autoReply.text).slice(0, 600) };
  await S.saveSettings(next, req.user);
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Requirement broadcast settings changed', entity: 'AppSetting', entityId: 'bc.settings', toValue: `broadcasts ${next.master ? 'ON' : 'OFF'} · automatic reply ${next.autoReply.on ? 'ON' : 'OFF'} · Add-as-candidate button ${next.showAddAsCandidate ? 'shown' : 'hidden'}` });
  return res.json({ settings: next });
}));
router.post('/campaigns/plan', limit(), wrap(async (req, res) => { const b = req.body || {}; return send(res, await C.plan(req.user, b.listId, b.jobId, b, baseOf(req))); }));
router.post('/campaigns', limit(), wrap(async (req, res) => { const b = req.body || {}; return send(res, await C.create(req.user, b.listId, b.jobId, b, baseOf(req))); }));
for (const [name, fn] of [['start', C.start], ['pause', C.pause], ['resume', C.resume], ['cancel', C.cancel]]) {
  router.post(`/campaigns/:id/${name}`, limit(), wrap(async (req, res) => send(res, await fn(req.user, req.params.id))));
}
router.get('/campaigns', wrap(async (req, res) => res.json({ campaigns: await C.listCampaigns(req.user, { jobId: req.query.job }) })));
router.get('/campaigns/:id', wrap(async (req, res) => {
  const out = await C.results(req.user, req.params.id, { status: req.query.status, intent: req.query.intent, from: req.query.from, to: req.query.to });
  return out ? res.json(out) : res.status(404).json({ error: 'This campaign was not found.' });
}));
router.post('/campaigns/:id/add-candidates', limit(60), wrap(async (req, res) => send(res, await R.addAsCandidate(req.user, req.params.id, (req.body || {}).all ? 'interested' : (req.body || {}).replyIds))));
router.post('/campaigns/:id/replies/:rid/reply', limit(60), wrap(async (req, res) => send(res, await R.replyTo(req.user, req.params.id, req.params.rid, (req.body || {}).text))));
// tests only: runs one send round at once (the sandbox has no timers)
router.post('/campaigns/tick', wrap(async (req, res) => {
  if (!sandbox.isSandbox()) return res.status(404).json({ error: 'Not found.' });
  return res.json(await C.tick({ ignoreGap: true, ignoreQuiet: !!(req.body || {}).ignoreQuiet, max: (req.body || {}).max, now: (req.body || {}).now }));
}));
router.post('/test/inbound', wrap(async (req, res) => {
  if (!sandbox.isSandbox()) return res.status(404).json({ error: 'Not found.' });
  const b = req.body || {};
  return res.json(await R.handle({ channel: 'WhatsApp', from: b.from, text: b.text, id: b.id || null, at: b.at || new Date().toISOString() }));
}));

router.get('/campaigns/:id/download', limit(60), wrap(async (req, res) => {
  const out = await C.results(req.user, req.params.id, {});
  if (!out) return res.status(404).json({ error: 'This campaign was not found.' });
  const c = out.campaign;
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Requirement broadcast results downloaded', entity: 'Campaign', entityId: c.id, toValue: `${c.jobTitle} to "${c.listName}" (${req.query.format === 'pdf' ? 'PDF' : 'Excel'})` });
  const summary = [['Requirement', `${c.jobTitle}${c.jobCode ? ` (${c.jobCode})` : ''}`], ['List', c.listName], ['Status', c.status], ['Sent', out.tiles.sent.n], ['Delivered', out.tiles.delivered.n], ['Read', out.tiles.read.n], ['Replied', out.tiles.replied.n], ['Interested', out.tiles.interested.n], ['Not interested', out.tiles.not_interested.n], ['Opted out', out.tiles.optout.n], ['Failed', out.tiles.failed.n]];
  if (req.query.format === 'pdf') {
    const PDF = require('pdfkit'); // eslint-disable-line global-require
    const doc = new PDF({ margin: 40 });
    res.set('Content-Disposition', `attachment; filename="campaign-results.pdf"`); res.type('application/pdf'); doc.pipe(res);
    doc.fontSize(16).text('Requirement broadcast results'); doc.moveDown(0.5).fontSize(10);
    summary.forEach(([a, b]) => doc.text(`${a}: ${b}`));
    doc.moveDown().fontSize(12).text('Replies'); doc.fontSize(9);
    out.replies.slice(0, 200).forEach((x) => doc.text(`${new Date(x.at).toLocaleString('en-IN')} · ${x.name || ''} ${x.phone} · ${x.intentWords}: ${String(x.text).slice(0, 120)}`));
    doc.end();
    return undefined;
  }
  const XLSX = require('xlsx'); // eslint-disable-line global-require
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Time', 'Name', 'Phone', 'Reply', 'Meaning'], ...out.replies.map((x) => [x.at, x.name, x.phone, x.text, x.intentWords])]), 'Replies');
  const full = await C.results(req.user, req.params.id, {});
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Name', 'Phone', 'Status', 'Note', 'Replied', 'Meaning'], ...full.rows.map((x) => [x.name, x.phone, x.st, x.why, x.replied ? 'yes' : '', x.intent || ''])]), 'People');
  res.set('Content-Disposition', 'attachment; filename="campaign-results.xlsx"'); res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}));

// the Sources view: how many people came from each broadcast
router.get('/sources', wrap(async (req, res) => {
  const rows = await prisma.candidate.groupBy({ by: ['source'], where: { source: { startsWith: 'WhatsApp campaign:' } }, _count: { _all: true } });
  return res.json({ sources: rows.map((r) => ({ source: r.source, people: r._count._all })) });
}));

void core;
module.exports = router;
