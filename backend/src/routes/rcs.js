// ---------------------------------------------------------------------------
// /api/rcs — RCS messaging (founder's spec 2026-10-30; provider rcssms.in, utils/rcsService.js; queue utils/rcsQueue.js).
//
//   GET  /status                 settings check (never a secret), proof, queue, last webhook calls          everyone who may send / Admin
//   GET  /settings  PUT /settings   SMS fallback switch + hours, WHO MAY SEND (a per-person checklist)       Admin
//   GET  /people                 the people for that checklist                                             Admin
//   GET  /templates              ?approved=1&module=ATS  (the send screen lists APPROVED only)
//   POST /templates              make a BASIC / RICH template ON rcssms.in -> saved PENDING                Admin
//   POST /templates/register     add a template already made on rcssms.in (e.g. a carousel) by its id    Admin
//   PATCH /templates/:id   DELETE /templates/:id   (delete = only TeamLink's copy)                           Admin
//   POST /test-send              ONE number, the provider's real answer shown; a msgid proves the account   Admin
//   POST /check                  { audience, ids, templateId }  who can get it and why not
//   POST /send                   { audience, ids, templateId, variables | cards, buttonUrl, imageUrl } -> background queue
//   GET  /batches/:id            progress of one send
//   GET  /logs   GET /logs.csv   filters module / status / from / to / q (number)                            Admin: all; others: their own
//   POST /queue/resume  /queue/run  /fallback/run  GET /webhook-raw                                          Admin
//
// WHO MAY SEND: Admin / Super Admin, and the people an Admin ticks in Integrations > RCS > "Who may send RCS" - and even they only to the
// people their role may contact (the Role Catalog switch "Contact (Mail / WhatsApp / SMS / Call)", utils/contactAccess.js) and, for
// more than one person, only with the bulk right. MANY AT ONCE stays locked until one real single test send was accepted (proof).
// PROMOTIONAL templates need consent: a candidate's consent must be "Given". STOP (RCS or SMS) and "do not contact" always win.
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const prisma = require('../db');
const rcs = require('../utils/rcsService');
const Q = require('../utils/rcsQueue');
const T = require('../utils/messageTemplates');
const access = require('../utils/contactAccess');
const ctx = require('../utils/messageContext');
const delivery = require('../utils/messageDelivery');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };
const isAdmin = (u) => T.isAdmin(u);
const adminOnly = (req, res, next) => (isAdmin(req.user) ? next() : res.status(403).json({ error: 'Only an Admin or Super Admin can do this.' }));
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const MODULE_OF = { candidates: 'ATS', employees: 'HRMS' };
const MODULES = ['HRMS', 'ATS', 'Accounts'];
const MAX_PEOPLE = Math.max(1, Number(process.env.RCS_SEND_MAX) || 5000);
const TEST_RECORD = /zztest|example\.test/i;
const PERSON_TOKEN = /\{\s*(name|firstName)\s*\}/i;

// ---- who may send ----------------------------------------------------------------------------------------------------------------
async function mayUse(user) {
  if (!user || user.viewAs) return false;
  if (isAdmin(user)) return true;
  return (await Q.settings()).allowedUserIds.includes(user.id);
}
async function maySendTo(user, audience, count) {
  if (!(await mayUse(user))) return { ok: false, status: 403, error: 'You are not on the list of people who may send RCS. An Admin adds you in Administration > Integrations > RCS.' };
  if (!MODULE_OF[audience]) return { ok: false, status: 400, error: 'Choose candidates or employees.' };
  if (!isAdmin(user)) {
    const rule = await access.ruleFor(user, audience);
    if (!rule.allowed) return { ok: false, status: 403, error: rule.reason || 'Your role may not contact these people.' };
    if (rule.mode === 'masked') return { ok: false, status: 403, error: 'Your role does not see these people\'s numbers, so it cannot send RCS to them.' };
    if (count > 1 && !(await access.bulkAllowed(user, audience))) return { ok: false, status: 403, error: 'Your role may send RCS to one person at a time, not many at once.' };
  }
  return { ok: true };
}

// ---- templates -------------------------------------------------------------------------------------------------------------------
const VAR_RE = /\{\{\s*(var\d{1,2})\s*\}\}|\{#\s*(var\d{1,2})\s*#\}|\[(var\d{1,2})\]|\{(var\d{1,2})\}/gi;
const varsIn = (text) => [...new Set([...String(text || '').matchAll(VAR_RE)].map((m) => (m[1] || m[2] || m[3] || m[4]).toLowerCase()))];
function shapeTemplate(t) {
  const b = parse(t.bodyJson, {});
  return {
    id: t.id, templateId: t.templateId, name: t.name, rcsType: t.rcsType, status: t.status, module: t.module || null, createdAt: t.createdAt, updatedAt: t.updatedAt,
    varCount: Number(b.varCount) || 0, cards: Math.max(1, Number(b.cards) || 1), promotional: !!b.promotional,
    title: b.title || null, description: b.description || null, mediaUrl: b.media_url || null, hasButtonLink: !!b.buttonLink, hasImageLink: !!b.imageLink,
    fallback: b.fallback && b.fallback.text ? { text: b.fallback.text, dltTemplateId: b.fallback.dltTemplateId || '' } : null,
    source: b.source || 'teamlink',
  };
}
function bodyExtras(p, base = {}) {
  const b = { ...base };
  if (p.varCount !== undefined) b.varCount = Math.min(20, Math.max(0, Number(p.varCount) || 0));
  if (p.cards !== undefined) b.cards = Math.min(10, Math.max(1, Number(p.cards) || 1));
  if (p.promotional !== undefined) b.promotional = !!p.promotional;
  if (p.buttonLink !== undefined) b.buttonLink = !!p.buttonLink;
  if (p.imageLink !== undefined) b.imageLink = !!p.imageLink;
  if (p.description !== undefined && base.source === 'rcssms') b.description = String(p.description || '').slice(0, 2500);
  if (p.fallback !== undefined) {
    const text = String((p.fallback && p.fallback.text) || '').trim().slice(0, 1000);
    const dlt = String((p.fallback && p.fallback.dltTemplateId) || '').trim();
    if (text && !/^\d{6,25}$/.test(dlt)) return { error: 'The SMS fallback needs the DLT Template ID of that SMS text (digits only).' };
    b.fallback = text ? { text, dltTemplateId: dlt } : null;
  }
  return { body: b };
}
const cleanModule = (m) => (MODULES.includes(m) ? m : null);

// ---- status ------------------------------------------------------------------------------------------------------------------------
router.get('/status', wrap(async (req, res) => {
  const may = await mayUse(req.user);
  const admin = isAdmin(req.user);
  if (!may) return res.json({ may: { send: false, admin: false } });
  const cfg = rcs.publicConfig();
  const [proof, paused, queued, accepted, raw, bad, st] = await Promise.all([
    rcs.proof(), Q.pausedInfo(), prisma.rcsMessageLog.count({ where: { status: 'queued' } }),
    prisma.appSetting.findUnique({ where: { key: 'rcs.accepted' } }).catch(() => null),
    prisma.appSetting.findUnique({ where: { key: require('./rcsWebhook').RAW_KEY } }).catch(() => null), // eslint-disable-line global-require
    prisma.appSetting.findUnique({ where: { key: require('./rcsWebhook').BAD_KEY } }).catch(() => null), // eslint-disable-line global-require
    Q.settings(),
  ]);
  const base = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;
  const rawList = parse(raw && raw.value, []);
  return res.json({
    may: { send: true, admin, bulk: !!proof },
    config: admin ? cfg : { configured: cfg.configured, problems: cfg.configured ? [] : ['RCS is not set up yet. Ask an Admin.'], warnings: [] },
    proven: proof ? { at: proof.at, ref: proof.ref } : null,
    lastAccepted: parse(accepted && accepted.value, null),
    queue: { paused: paused ? { at: paused.at, reason: paused.reason } : null, waiting: queued },
    settings: admin ? { smsFallback: st.smsFallback, fallbackHours: st.fallbackHours, allowedCount: st.allowedUserIds.length } : { smsFallback: st.smsFallback },
    webhook: admin ? { url: `${base}/api/webhooks/rcs?token=<RCS_WEBHOOK_SECRET from backend/.env>`, secretSet: cfg.webhookSecretSet, calls: rawList.length, lastAt: rawList[0] ? rawList[0].at : null, lastRejectedAt: bad ? bad.value : null } : null,
  });
}));

router.get('/settings', adminOnly, wrap(async (_req, res) => res.json(await Q.settings())));
router.put('/settings', adminOnly, wrap(async (req, res) => {
  const b = req.body || {};
  if (b.allowedUserIds !== undefined) {
    const ids = (Array.isArray(b.allowedUserIds) ? b.allowedUserIds : []).map(String);
    const real = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true } }) : [];
    b.allowedUserIds = real.map((u) => u.id);
  }
  const before = await Q.settings();
  const next = await Q.saveSettings(b);
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'RCS settings changed', entity: 'Rcs', entityId: 'settings', fromValue: `SMS fallback ${before.smsFallback ? 'on' : 'off'}, ${before.allowedUserIds.length} sender(s)`, toValue: `SMS fallback ${next.smsFallback ? 'on' : 'off'} (${next.fallbackHours} h), ${next.allowedUserIds.length} sender(s)` });
  res.json(next);
}));
router.get('/people', adminOnly, wrap(async (_req, res) => {
  const users = await prisma.user.findMany({
    where: { status: 'Active', NOT: { role: { in: ['CLIENT', 'CANDIDATE', 'VENDOR'] } } },
    select: { id: true, name: true, role: true, atsRole: true, hrmsRole: true, atsDepartment: true }, orderBy: { name: 'asc' }, take: 3000,
  });
  res.json(users.filter((u) => !TEST_RECORD.test(u.name || '') || require('../utils/sandbox').isSandbox()).map((u) => ({ id: u.id, name: u.name, role: [u.atsRole, u.hrmsRole, u.role].find((r) => r && r !== 'NONE') || '', department: u.atsDepartment || '' }))); // eslint-disable-line global-require
}));

// ---- templates ---------------------------------------------------------------------------------------------------------------------
router.get('/templates', wrap(async (req, res) => {
  if (!(await mayUse(req.user))) return res.status(403).json({ error: 'You may not send RCS.' });
  const where = {};
  if (req.query.approved === '1' || !isAdmin(req.user)) where.status = 'APPROVED';
  const mod = cleanModule(req.query.module);
  if (mod) where.OR = [{ module: mod }, { module: null }];
  const rows = await prisma.rcsTemplate.findMany({ where, orderBy: { createdAt: 'desc' } });
  return res.json(rows.map(shapeTemplate));
}));

router.post('/templates', adminOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const type = String(b.rcstype || b.type || '').toUpperCase();
  const f = rcs.templateFields(type, b);
  if (f.error) return res.status(400).json({ error: f.error });
  const extras = bodyExtras(b, {});
  if (extras.error) return res.status(400).json({ error: extras.error });
  const r = await rcs.createTemplate(type, b);
  if (!r.ok) return res.status(r.invalid ? 400 : 502).json({ error: r.error, errorCode: r.errorCode || null });
  const vc = varsIn(`${r.fields.title || ''} ${r.fields.description || ''}`).length;
  const body = { ...extras.body, ...r.fields, source: 'teamlink', varCount: extras.body.varCount !== undefined ? extras.body.varCount : vc };
  const row = await prisma.rcsTemplate.upsert({
    where: { templateId: r.templateid },
    create: { templateId: r.templateid, name: r.fields.cname, rcsType: type, bodyJson: JSON.stringify(body), status: r.status, module: cleanModule(b.module), createdById: req.user.id },
    update: { name: r.fields.cname, rcsType: type, bodyJson: JSON.stringify(body), status: r.status, module: cleanModule(b.module) },
  });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'RCS template sent for approval', entity: 'RcsTemplate', entityId: row.id, toValue: `${row.name} (${type}) - rcssms.in id ${row.templateId}, ${row.status}` });
  return res.status(201).json(shapeTemplate(row));
}));

router.post('/templates/register', adminOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const templateId = String(b.templateId || '').trim();
  const name = String(b.name || '').trim() || templateId;
  const type = String(b.rcstype || '').toUpperCase();
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(templateId)) return res.status(400).json({ error: 'Type the template id exactly as rcssms.in shows it.' });
  if (!rcs.TYPES.includes(type)) return res.status(400).json({ error: 'Choose the type: BASIC, RICH or Carousel.' });
  const status = ['APPROVED', 'REJECTED', 'PENDING'].includes(String(b.status || '').toUpperCase()) ? String(b.status).toUpperCase() : 'PENDING';
  const extras = bodyExtras({ cards: 1, varCount: varsIn(b.description).length, ...b }, { source: 'rcssms' });
  if (extras.error) return res.status(400).json({ error: extras.error });
  if (await prisma.rcsTemplate.findUnique({ where: { templateId } })) return res.status(409).json({ error: 'This template id is already in the list.' });
  const row = await prisma.rcsTemplate.create({ data: { templateId, name: name.slice(0, 100), rcsType: type, bodyJson: JSON.stringify(extras.body), status, module: cleanModule(b.module), createdById: req.user.id } });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'RCS template added from rcssms.in', entity: 'RcsTemplate', entityId: row.id, toValue: `${row.name} (${type}) id ${templateId}, ${status}${status === 'APPROVED' ? ' (Admin saw it approved on rcssms.in)' : ''}` });
  return res.status(201).json(shapeTemplate(row));
}));

router.patch('/templates/:id', adminOnly, wrap(async (req, res) => {
  const t = await prisma.rcsTemplate.findUnique({ where: { id: req.params.id } });
  if (!t) return res.status(404).json({ error: 'Template not found.' });
  const b = req.body || {};
  const old = parse(t.bodyJson, {});
  const extras = bodyExtras(b, old);
  if (extras.error) return res.status(400).json({ error: extras.error });
  const data = { bodyJson: JSON.stringify(extras.body) };
  if (b.name !== undefined && String(b.name).trim()) data.name = String(b.name).trim().slice(0, 100);
  if (b.module !== undefined) data.module = cleanModule(b.module);
  if (b.status !== undefined) {
    const s = String(b.status).toUpperCase();
    if (!['APPROVED', 'REJECTED', 'PENDING'].includes(s)) return res.status(400).json({ error: 'Status is Approved, Rejected or Pending.' });
    data.status = s;
  }
  const row = await prisma.rcsTemplate.update({ where: { id: t.id }, data });
  if (data.status && data.status !== t.status) await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'RCS template status set by hand', entity: 'RcsTemplate', entityId: t.id, fromValue: t.status, toValue: data.status, reason: 'Admin saw it on rcssms.in' });
  return res.json(shapeTemplate(row));
}));

router.delete('/templates/:id', adminOnly, wrap(async (req, res) => {
  const t = await prisma.rcsTemplate.findUnique({ where: { id: req.params.id } });
  if (!t) return res.status(404).json({ error: 'Template not found.' });
  await prisma.rcsTemplate.delete({ where: { id: t.id } });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'RCS template removed from TeamLink', entity: 'RcsTemplate', entityId: t.id, fromValue: `${t.name} (${t.templateId})`, toValue: 'Removed (still on rcssms.in)' });
  res.json({ ok: true });
}));

// ---- the words for one person ---------------------------------------------------------------------------------------------------
// values: {var1: 'Hi {name}'} for BASIC / RICH, or cards: [{var1}, {var1}] for a carousel -> [{var1}] per card, the person's name filled in
function fill(values, person) {
  const first = String((person && person.name) || '').trim().split(/\s+/)[0] || '';
  const sub = (s) => String(s == null ? '' : s).replace(/\{\s*name\s*\}/gi, (person && person.name) || '').replace(/\{\s*firstName\s*\}/gi, first);
  return values.map((o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, sub(v)])));
}
function valuesOf(tpl, b) {
  const cards = tpl.rcsType === 'RICHCASOUREL' ? (Array.isArray(b.cards) ? b.cards : []) : [b.variables || {}];
  const list = rcs.cleanVariables(cards);
  const need = tpl.varCount;
  const want = tpl.rcsType === 'RICHCASOUREL' ? tpl.cards : 1;
  if (list.length < want) return { error: `This carousel has ${want} cards: fill in every card.` };
  for (let c = 0; c < want; c += 1) {
    for (let i = 1; i <= need; i += 1) {
      if (!String(list[c][`var${i}`] || '').trim()) return { error: `Fill in blank ${i}${want > 1 ? ` on card ${c + 1}` : ''}.` };
      if (list[c][`var${i}`].length > 500) return { error: `Blank ${i} is too long (500 characters at most).` };
    }
  }
  return { list: list.slice(0, want), personal: list.some((o) => Object.values(o).some((v) => PERSON_TOKEN.test(v))) };
}
const httpsOrEmpty = (u) => { const s = String(u || '').trim(); if (!s) return ''; try { return new URL(s).protocol === 'https:' ? s : null; } catch { return null; } };

// Who of the chosen people can get it, and why not. -> rows [{ id, name, msisdn, number (masked), code, reason }]
async function plan(user, audience, ids, tpl) {
  const people = await ctx.recipientsFor(user, audience, ids, {});
  let consent = new Map();
  if (tpl.promotional && audience === 'candidates') {
    const rows = await prisma.candidate.findMany({ where: { id: { in: people.map((p) => p.id) } }, select: { id: true, consentStatus: true } }).catch(() => []);
    consent = new Map(rows.map((r) => [r.id, r.consentStatus]));
  }
  const seen = new Set();
  const out = [];
  for (const p of people) {
    const n = rcs.normalizeNumber(p.mobile);
    const row = { id: p.id, name: p.name, number: n.ok ? Q.mask(n.msisdn) : null, msisdn: n.ok ? n.msisdn : null, code: 'ok', reason: null };
    if (p.doNotContact) Object.assign(row, { code: 'no_consent', reason: 'Asked not to be contacted' });
    else if (!n.ok) Object.assign(row, { code: 'no_phone', reason: n.reason });
    else if (TEST_RECORD.test(`${p.name || ''}`) && !require('../utils/sandbox').isSandbox()) Object.assign(row, { code: 'test', reason: 'Test record: never messaged' }); // eslint-disable-line global-require
    else if (seen.has(n.msisdn)) Object.assign(row, { code: 'duplicate', reason: 'Same number as someone above' });
    else if (tpl.promotional && audience === 'candidates' && consent.get(p.id) !== 'GIVEN') Object.assign(row, { code: 'no_consent', reason: 'Promotional message: their consent is not recorded as Given' });
    // eslint-disable-next-line no-await-in-loop
    else if (await delivery.optedOut('RCS', n.msisdn) || await delivery.optedOut('SMS', n.msisdn)) Object.assign(row, { code: 'opted_out', reason: 'They replied STOP' });
    if (row.code === 'ok') seen.add(n.msisdn);
    out.push(row);
  }
  const known = new Set(people.map((p) => p.id));
  ids.filter((id) => !known.has(id)).forEach((id) => out.push({ id, name: null, number: null, msisdn: null, code: 'outside', reason: 'Outside your access' }));
  return out;
}
const cleanIds = (ids) => [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
const publicRow = ({ msisdn, ...r }) => r;

async function approvedTemplate(id) {
  const t = id ? await prisma.rcsTemplate.findUnique({ where: { id: String(id) } }) : null;
  if (!t) return { error: 'Choose a template.' };
  if (t.status !== 'APPROVED') return { error: 'This template is not approved yet, so it cannot be sent.' };
  return { tpl: shapeTemplate(t) };
}

router.post('/check', wrap(async (req, res) => {
  const b = req.body || {};
  const ids = cleanIds(b.ids);
  if (!ids.length) return res.status(400).json({ error: 'Tick at least one person.' });
  if (ids.length > MAX_PEOPLE) return res.status(400).json({ error: `At most ${MAX_PEOPLE} people at a time.` });
  const g = await maySendTo(req.user, b.audience, ids.length);
  if (!g.ok) return res.status(g.status).json({ error: g.error });
  const t = await approvedTemplate(b.templateId);
  if (t.error) return res.status(400).json({ error: t.error });
  const rows = await plan(req.user, b.audience, ids, t.tpl);
  const counts = rows.reduce((a, r) => { a[r.code] = (a[r.code] || 0) + 1; return a; }, {});
  const first = rows.find((r) => r.code === 'ok');
  return res.json({ selected: ids.length, canSend: counts.ok || 0, counts, people: rows.map(publicRow), firstName: first ? first.name : null, bulkLocked: (counts.ok || 0) > 1 && !(await rcs.proof()) });
}));

router.post('/send', require('../channels/rateLimit').limiter({ perMinute: 10 }), wrap(async (req, res) => {
  const b = req.body || {};
  const ids = cleanIds(b.ids);
  if (!ids.length) return res.status(400).json({ error: 'Tick at least one person.' });
  if (ids.length > MAX_PEOPLE) return res.status(400).json({ error: `At most ${MAX_PEOPLE} people at a time.` });
  const g = await maySendTo(req.user, b.audience, ids.length);
  if (!g.ok) return res.status(g.status).json({ error: g.error });
  const cfg = rcs.config();
  if (!cfg.configured) return res.status(409).json({ error: `RCS is not set up yet: ${cfg.reason}` });
  const t = await approvedTemplate(b.templateId);
  if (t.error) return res.status(400).json({ error: t.error });
  const { tpl } = t;
  const v = valuesOf(tpl, b);
  if (v.error) return res.status(400).json({ error: v.error });
  const buttonUrl = httpsOrEmpty(b.buttonUrl); const imageUrl = httpsOrEmpty(b.imageUrl);
  if (buttonUrl === null || imageUrl === null) return res.status(400).json({ error: 'A link must start with https://' });
  if (imageUrl && tpl.rcsType !== 'RICH') return res.status(400).json({ error: 'A card image link is only for a RICH template.' });
  if (imageUrl && v.personal) return res.status(400).json({ error: 'A card image works only when everyone gets the same words: take {name} out, or leave the image link empty.' });
  const mode = v.personal ? 'personal' : 'same';
  if (mode === 'same' ? !cfg.sendApiType : !cfg.personalApiType) return res.status(409).json({ error: `Not sent: ${mode === 'same' ? 'RCS_SEND_APITYPE' : 'RCS_PERSONAL_APITYPE'} is not set yet (rcssms.in must confirm apitype 1 or 2).` });
  const rows = await plan(req.user, b.audience, ids, tpl);
  const ok = rows.filter((r) => r.code === 'ok');
  if (!ok.length) return res.status(400).json({ error: 'Nobody of the chosen people can get this message.', people: rows.map(publicRow) });
  // FOUNDER 2026-10-30: no sending to many until one real single test send was accepted by rcssms.in
  if (ok.length > 1 && !(await rcs.proof())) return res.status(409).json({ error: 'Sending to many is locked until one real test RCS is accepted: an Admin sends it from Administration > Integrations > RCS > Test send.', bulkLocked: true });
  const module = MODULE_OF[b.audience];
  const batch = await Q.enqueue({
    user: req.user, module, template: tpl, mode,
    payload: { variables: mode === 'same' ? v.list : undefined, buttonUrl: buttonUrl || undefined, imageUrl: imageUrl || undefined },
    recipients: ok.map((r) => ({ msisdn: r.msisdn, entityId: r.id, personName: r.name, variables: mode === 'personal' ? fill(v.list, r) : undefined })),
  });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: `RCS send queued (${module})`, entity: 'RcsBatch', entityId: batch.id, toValue: `${tpl.name}: ${ok.length} queued, ${rows.length - ok.length} left out` });
  return res.status(202).json({ batchId: batch.id, queued: ok.length, leftOut: rows.length - ok.length, people: rows.map(publicRow) });
}));

router.get('/batches/:id', wrap(async (req, res) => {
  const bt = await prisma.rcsBatch.findUnique({ where: { id: req.params.id } });
  if (!bt || (!isAdmin(req.user) && bt.createdById !== req.user.id)) return res.status(404).json({ error: 'Not found.' });
  const g = await prisma.rcsMessageLog.groupBy({ by: ['status'], where: { requestRef: bt.id }, _count: { _all: true } });
  const counts = Object.fromEntries(g.map((x) => [x.status, x._count._all]));
  const fails = await prisma.rcsMessageLog.findMany({ where: { requestRef: bt.id, status: 'failed' }, select: { personName: true, errorCode: true, errorText: true }, take: 20 });
  res.json({ id: bt.id, status: bt.status, total: bt.total, counts, lastError: bt.lastError, failed: fails });
}));

// ---- the Admin's single test send (the proof) -----------------------------------------------------------------------------------
router.post('/test-send', adminOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const n = rcs.normalizeNumber(b.number);
  if (!n.ok) return res.status(400).json({ error: n.reason });
  const templateId = String(b.templateId || '').trim();
  const rcstype = String(b.rcstype || '').toUpperCase();
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(templateId)) return res.status(400).json({ error: 'Type the template id exactly as rcssms.in shows it.' });
  if (!rcs.TYPES.includes(rcstype)) return res.status(400).json({ error: 'Choose the template type.' });
  const variables = rcs.cleanVariables(Array.isArray(b.cards) ? b.cards : [b.variables || {}]);
  const imageUrl = httpsOrEmpty(b.imageUrl); const buttonUrl = httpsOrEmpty(b.buttonUrl);
  if (imageUrl === null || buttonUrl === null) return res.status(400).json({ error: 'A link must start with https://' });
  const cfg = rcs.config();
  if (!cfg.configured) return res.status(409).json({ error: `RCS is not set up yet: ${cfg.reason}` });
  const log = await prisma.rcsMessageLog.create({ data: { module: 'Test', msisdn: n.msisdn, templateId, rcsType: rcstype, variablesJson: JSON.stringify(variables), personName: 'Admin test send', sentById: req.user.id, sentByName: req.user.name || null } });
  const r = await rcs.sendChunk({ rcstype, templateid: templateId, numbers: [n.msisdn], variables, buttonUrl, imageUrl });
  const msgId = r.ok ? rcs.idsByNumber([n.msisdn], r.items).get(n.msisdn) : null;
  const row = await prisma.rcsMessageLog.update({
    where: { id: log.id },
    data: msgId ? { status: 'sent', msgId, sentAt: new Date(), attempts: 1 } : { status: 'failed', attempts: 1, errorCode: String(r.errorCode || 'NO_ID').slice(0, 20), errorText: String(r.error || 'rcssms.in did not confirm this number.').slice(0, 500) },
  });
  // the proof is kept FOR THAT ADDRESS only: a sandbox test stub (loopback) can never unlock rcssms.in
  const proves = !!msgId && (!cfg.local || require('../utils/sandbox').isSandbox()); // eslint-disable-line global-require
  if (proves) await rcs.markProven(msgId, r.host);
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'RCS test send', entity: 'RcsMessageLog', entityId: row.id, toValue: msgId ? `Accepted by rcssms.in, msgid ${msgId}` : `Not sent: ${row.errorText}` });
  return res.json({
    ok: !!msgId, msgId, logId: row.id, status: row.status, error: msgId ? null : row.errorText, errorCode: msgId ? null : row.errorCode,
    providerAnswer: r.said || null, proven: proves, number: Q.mask(n.msisdn),
  });
}));

// ---- logs --------------------------------------------------------------------------------------------------------------------------
function logWhere(req) {
  const q = req.query;
  const where = { AND: [] };
  if (!isAdmin(req.user)) where.AND.push({ sentById: req.user.id });
  if (q.module) where.AND.push({ module: String(q.module) });
  if (q.status) where.AND.push({ status: String(q.status) });
  if (q.from) where.AND.push({ createdAt: { gte: new Date(`${q.from}T00:00:00`) } });
  if (q.to) where.AND.push({ createdAt: { lte: new Date(`${q.to}T23:59:59`) } });
  const d = String(q.q || '').replace(/\D/g, '');
  if (d) where.AND.push({ msisdn: { contains: d } });
  return where;
}
const WORD = { queued: 'Queued', sent: 'Sent', delivered: 'Delivered', failed: 'Failed' };
const shapeLog = (l, full) => ({
  id: l.id, at: l.createdAt, module: l.module, person: l.personName, number: full ? l.msisdn : Q.mask(l.msisdn), templateId: l.templateId, rcsType: l.rcsType,
  status: WORD[l.status] || l.status, msgId: l.msgId, errorCode: l.errorCode, error: l.errorText, by: l.sentByName, sentAt: l.sentAt, deliveredAt: l.deliveredAt,
  sms: l.fallbackStatus ? { status: l.fallbackStatus, ref: l.fallbackRef, error: l.fallbackError, at: l.fallbackAt } : null,
});
router.get('/logs', wrap(async (req, res) => {
  if (!(await mayUse(req.user))) return res.status(403).json({ error: 'You may not send RCS.' });
  const where = logWhere(req);
  const page = Math.max(1, Number(req.query.page) || 1); const size = Math.min(100, Math.max(5, Number(req.query.size) || 25));
  const [total, rows, g] = await Promise.all([
    prisma.rcsMessageLog.count({ where }),
    prisma.rcsMessageLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }),
    prisma.rcsMessageLog.groupBy({ by: ['status'], where, _count: { _all: true } }),
  ]);
  return res.json({ total, page, size, counts: Object.fromEntries(g.map((x) => [WORD[x.status] || x.status, x._count._all])), rows: rows.map((l) => shapeLog(l, false)) });
}));
router.get('/logs.csv', wrap(async (req, res) => {
  if (!(await mayUse(req.user))) return res.status(403).json({ error: 'You may not send RCS.' });
  const rows = await prisma.rcsMessageLog.findMany({ where: logWhere(req), orderBy: { createdAt: 'desc' }, take: 50000 });
  const esc = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
  const head = ['Date and time', 'Module', 'Person', 'Number', 'Template id', 'Type', 'Status', 'Message id', 'Error code', 'Error', 'SMS fallback', 'Sent by'];
  const lines = [head.map(esc).join(',')].concat(rows.map((l) => shapeLog(l, false)).map((r) => [new Date(r.at).toLocaleString('en-IN'), r.module, r.person, r.number, r.templateId, r.rcsType, r.status, r.msgId, r.errorCode, r.error, r.sms ? r.sms.status : '', r.by].map(esc).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="rcs-message-log.csv"');
  return res.send(`﻿${lines.join('\r\n')}`);
}));

// ---- queue / fallback / webhook payloads ------------------------------------------------------------------------------------------
router.post('/queue/resume', adminOnly, wrap(async (req, res) => {
  const n = await Q.resume();
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'RCS queue resumed', entity: 'Rcs', entityId: 'queue', toValue: `${n} batch(es) waiting again` });
  res.json({ resumed: n });
}));
router.post('/queue/run', adminOnly, wrap(async (_req, res) => res.json(await Q.kick())));
router.post('/fallback/run', adminOnly, wrap(async (_req, res) => res.json(await Q.sweep())));
router.get('/webhook-raw', adminOnly, wrap(async (_req, res) => {
  const row = await prisma.appSetting.findUnique({ where: { key: require('./rcsWebhook').RAW_KEY } }).catch(() => null); // eslint-disable-line global-require
  res.json(parse(row && row.value, []));
}));

module.exports = router;
