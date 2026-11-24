// ---------------------------------------------------------------------------
// THE CRM API FOR OUTSIDE SYSTEMS (CRM wave A 15.01 / 15.03, 2026-11-24). Mounted at /api/crm-api (index.js). No TeamLink login: a CRM API
// key (Authorization: Bearer crmk_... or X-API-Key) made in CRM > Dashboard > Automation > API & AI. A key ACTS AS the person it belongs to:
// the same scope (a salesperson: their own records) and the same rights as on the screen; a "read" key never changes anything.
// Switched off until an Admin turns on "CRM API". The documentation is GET /api/crm-api/v1/openapi.json (OpenAPI 3).
//
// Zapier / Make / n8n: TRIGGERS = REST hooks (POST /v1/hooks {url, event}, DELETE /v1/hooks/:id; the key's person must be a Sales manager
// or Admin) or polling (GET /v1/leads?since=...); ACTIONS = POST /v1/leads, /v1/deals, /v1/activities, /v1/tasks ...
// The private calendar feed of a person's follow-ups is here too: GET /api/crm-api/calendar/<token>.ics (no key; the token is the link).
// ---------------------------------------------------------------------------
const express = require('express');
const { rateLimit } = require('../utils/publicRateLimit');
const S = require('../crm/service');
const C = require('../crm/connect');
const DB = require('../crm/schema');

const router = express.Router();
const limit = rateLimit({ bucket: 'crm-api', max: 600, windowMs: 10 * 60000, message: 'Too many CRM API calls from this address. Wait a few minutes.' });
const send = (res, out) => res.status(out.status).json(out.body);

router.get('/calendar/:token', limit, async (req, res, next) => {
  try {
    const out = await C.feedIcs(req.params.token);
    res.status(out.status).set('Content-Type', out.status === 200 ? 'text/calendar; charset=utf-8' : 'text/plain; charset=utf-8').set('Cache-Control', 'private, max-age=300').send(out.text);
  } catch (e) { next(e); }
});

const KINDS = { leads: 'lead', deals: 'deal', accounts: 'account', contacts: 'contact' };
const spec = () => {
  const rec = (props) => ({ type: 'object', properties: Object.fromEntries(props.map((p) => [p, { type: /value|percent|probability|Value/.test(p) ? 'number' : 'string' }])) });
  const crud = (name, kind, fields) => ({
    [`/${name}`]: {
      get: { summary: `List ${name}`, parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'since', in: 'query', description: 'Only rows added at or after this ISO time (polling triggers)', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 500 } }], responses: { 200: { description: `{ rows: [${kind}] }` } } },
      post: { summary: `Add a ${kind} (write key)`, requestBody: { content: { 'application/json': { schema: rec(fields) } } }, responses: { 200: { description: `{ ok, ${kind} }` }, 409: { description: 'Already in the CRM (send force: true to add anyway)' } } },
    },
    [`/${name}/{id}`]: {
      get: { summary: `One ${kind} with its timeline and follow-ups`, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: kind } } },
      patch: { summary: `Change a ${kind} (write key)`, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: rec(fields) } } }, responses: { 200: { description: `{ ok, ${kind} }` } } },
    },
  });
  return {
    openapi: '3.0.3',
    info: { title: 'TeamLink CRM API', version: '1.0.0', description: 'Leads, deals, customers, contacts, activities and follow-ups. A key acts as the CRM person it belongs to (their scope and rights). Phone and email are returned only on records that person may see. Webhook deliveries are signed: X-TeamLink-Signature = "sha256=" + HMAC-SHA256(body, secret).' },
    servers: [{ url: '/api/crm-api/v1' }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'crmk_... key' }, apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' } } },
    security: [{ bearer: [] }, { apiKey: [] }],
    paths: {
      '/me': { get: { summary: 'Who this key acts as, and its scope', responses: { 200: { description: '{ name, role, scope, rights }' } } } },
      ...crud('leads', 'lead', ['company', 'contactName', 'designation', 'phone', 'email', 'industry', 'city', 'source', 'rating', 'notes', 'expectedValue', 'ownerId']),
      ...crud('deals', 'deal', ['title', 'accountId', 'contactId', 'value', 'discountPercent', 'probability', 'expectedClose', 'nextStep', 'notes', 'ownerId', 'stage']),
      ...crud('accounts', 'account', ['name', 'industry', 'city', 'website', 'phone', 'email', 'source', 'gstin', 'address', 'state', 'pincode', 'tags', 'notes', 'ownerId']),
      ...crud('contacts', 'contact', ['accountId', 'name', 'designation', 'role', 'phone', 'email', 'notes']),
      '/deals/{id}/stage': { post: { summary: 'Move a deal (write key)', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { stage: { type: 'string', enum: S.STAGES }, lostReason: { type: 'string' } } } } } }, responses: { 200: { description: '{ ok, deal }' } } } },
      '/leads/{id}/convert': { post: { summary: 'Convert a lead to account + contact + deal (write key)', responses: { 200: { description: '{ ok, account, contact, deal }' } } } },
      '/activities': { post: { summary: 'Log a call / meeting / email / whatsapp / note (write key)', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { kind: { type: 'string' }, subject: { type: 'string' }, note: { type: 'string' }, leadId: { type: 'string' }, dealId: { type: 'string' }, accountId: { type: 'string' } } } } } }, responses: { 200: { description: '{ ok, activity }' } } } },
      '/tasks': { get: { summary: 'Follow-ups (when = action | upcoming | open | done)', responses: { 200: { description: '{ rows }' } } }, post: { summary: 'Add a follow-up (write key)', responses: { 200: { description: '{ ok, task }' } } } },
      '/tasks/{id}/done': { post: { summary: 'Mark a follow-up done (write key)', responses: { 200: { description: '{ ok, task }' } } } },
      '/pipeline': { get: { summary: 'Open pipeline by stage, won this month', responses: { 200: { description: '{ open, wonThisMonth }' } } } },
      '/hooks': { get: { summary: 'The webhooks (Sales manager / Admin key)' }, post: { summary: 'Subscribe a URL to an event (REST hook; Zapier / Make / n8n)', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { url: { type: 'string' }, event: { type: 'string', enum: C.EVENT_NAMES }, source: { type: 'string', enum: ['zapier', 'make', 'n8n', 'api'] } } } } } } } },
      '/hooks/{id}': { delete: { summary: 'Unsubscribe' } },
      '/samples/{event}': { get: { summary: 'A sample payload of an event (the newest real record of that kind)' } },
    },
    'x-events': C.EVENTS.map(([name, label]) => ({ name, label })),
  };
};
router.get('/v1/openapi.json', (req, res) => res.json(spec()));

// every other /v1 call needs a key
router.use('/v1', limit, async (req, res, next) => {
  try {
    const id = await C.identityOfKey(req);
    if (id.error) return res.status(id.status).json({ error: id.error });
    req.user = id.user; req.apiKey = id.key;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && id.key.scope !== 'write') return res.status(403).json({ error: 'This is a read-only key.' });
    return next();
  } catch (e) { return next(e); }
});
const wrap = (fn) => async (req, res, next) => { try { return send(res, await fn(req)); } catch (e) { return next(e); } };

router.get('/v1/me', wrap(async (req) => ({ status: 200, body: { userId: req.user.id, name: req.user.name, role: S.roleOf(req.user), scope: req.apiKey.scope, rights: S.rightsOf(req.user), key: { label: req.apiKey.label, prefix: req.apiKey.prefix } } })));
router.get('/v1/pipeline', wrap(async (req) => ({ status: 200, body: await require('../crm/mcpTools').pipeline(req.user) }))); // eslint-disable-line global-require
router.get('/v1/:kind(leads|deals|accounts|contacts)', wrap(async (req) => {
  const kind = KINDS[req.params.kind];
  const q = { ...req.query };
  if (kind === 'lead' && !q.status) q.status = 'all';
  if (kind === 'deal' && !q.closedDays) q.closedDays = 3650;
  let rows = await S.list(req.user, kind, q);
  const since = String(req.query.since || '');
  if (since && !Number.isNaN(Date.parse(since))) { const t = new Date(since).toISOString(); rows = rows.filter((x) => x.createdAt >= t); }
  rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const n = Math.max(1, Math.min(500, Math.round(Number(req.query.limit) || 100)));
  return { status: 200, body: { rows: rows.slice(0, n), total: rows.length } };
}));
router.get('/v1/:kind(leads|deals|accounts|contacts)/:id', wrap((req) => S.detail(req.user, KINDS[req.params.kind], req.params.id)));
router.post('/v1/:kind(leads|deals|accounts|contacts)', wrap((req) => S.create(req.user, KINDS[req.params.kind], req.body || {})));
router.patch('/v1/:kind(leads|deals|accounts|contacts)/:id', wrap((req) => S.edit(req.user, KINDS[req.params.kind], req.params.id, req.body || {})));
router.post('/v1/deals/:id/stage', wrap((req) => S.moveDeal(req.user, req.params.id, req.body || {})));
router.post('/v1/leads/:id/convert', wrap((req) => S.convertLead(req.user, req.params.id, req.body || {})));
router.post('/v1/activities', wrap((req) => S.addActivity(req.user, req.body || {})));
router.get('/v1/tasks', wrap(async (req) => ({ status: 200, body: { rows: await S.tasks(req.user, { when: String(req.query.when || 'open'), mine: String(req.query.mine || '') === '1' }) } })));
router.post('/v1/tasks', wrap((req) => S.addTask(req.user, req.body || {})));
router.post('/v1/tasks/:id/done', wrap((req) => S.finishTask(req.user, req.params.id, req.body || {})));
router.get('/v1/hooks', wrap((req) => C.listHooks(req.user)));
router.post('/v1/hooks', wrap(async (req) => {
  const b = req.body || {};
  const out = await C.addHook(req.user, { url: b.url || b.target_url || b.hookUrl, events: b.events || b.event, label: b.label || `${b.source || 'api'} hook`, includeContact: b.includeContact === true }, { source: ['zapier', 'make', 'n8n'].includes(b.source) ? b.source : 'api' });
  return out.status === 200 ? { status: 201, body: { id: out.body.hook.id, secret: out.body.secret, hook: out.body.hook } } : out;
}));
router.delete('/v1/hooks/:id', wrap((req) => C.removeHook(req.user, req.params.id)));
router.get('/v1/samples/:event', wrap(async (req) => {
  const ev = String(req.params.event || '');
  if (!C.EVENT_NAMES.includes(ev)) return S.fail(404, 'No such event.');
  const kind = ev.split('.')[0];
  const table = { lead: 'CrmLead', deal: 'CrmDeal', account: 'CrmAccount', contact: 'CrmContact', activity: 'CrmActivity', task: 'CrmTask', invoice: 'CrmInvoice' }[kind];
  const r = S.roleOf(req.user);
  let row = null;
  if (table) {
    const own = ['activity'].includes(kind) ? '"byId"' : '"ownerId"';
    row = S.seesAll(r) ? await DB.one(`SELECT * FROM "${table}" ORDER BY "createdAt" DESC LIMIT 1`) : await DB.one(`SELECT * FROM "${table}" WHERE ${own} = ? ORDER BY "createdAt" DESC LIMIT 1`, req.user.id);
  }
  return { status: 200, body: [{ id: 'sample', event: ev, at: new Date().toISOString(), data: { kind, record: C.shape(kind, row || { id: 'sample' }) } }] };
}));
router.use('/v1', (req, res) => res.status(404).json({ error: 'No such CRM API call. See /api/crm-api/v1/openapi.json' }));
router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[crm-api]', err && err.message); // eslint-disable-line no-console
  res.status(500).json({ error: 'The CRM API could not do that.' });
});

module.exports = router;
