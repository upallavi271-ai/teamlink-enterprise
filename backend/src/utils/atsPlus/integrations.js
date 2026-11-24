// ---------------------------------------------------------------------------
// INTEGRATIONS (market benchmark 14.01 / 14.04 / 14.05 / 14.06 / 14.09 / 14.10 / 14.15) - Administration -> ATS settings -> Integrations.
//
//   14.01 OPEN REST API  an Admin makes API keys (shown ONCE; only a SHA-256 is kept) with scopes and a rate limit per minute. A key acts
//         with the scope of the login it is tied to (default: the Admin who made it), so it never reads more than that person can.
//           GET /api/v1/open/jobs  /jobs/:id  /candidates (GET, POST)  /applications  /clients   (index.js turns /api/v1/... into /api/...,
//           so the router sits at /api/open; /api/v1/open/... is the address the docs give)
//         POST /api/v1/candidates goes through the app's own Add candidate route (duplicate check, consent, audit) with the key's login.
//         The documentation: /api/docs (HTML) and /api/docs/openapi.json (OpenAPI 3).
//   14.04 ZAPIER / n8n   WEBHOOKS: a URL is told when something happens (candidate added, step changed, joined, job added, interview
//         booked, offer prepared) - JSON signed with HMAC-SHA256 (header X-TeamLink-Signature). With the API above = "Zapier / n8n ready";
//         the recipes are on the Integrations tab. OFF until an Admin switches webhooks on.
//   14.06 SLACK / TEAMS  the same events as a short message to a Slack or Microsoft Teams incoming-webhook URL, per event. OFF by default.
//         Messages carry names of jobs and steps, never a candidate's phone, e-mail or salary.
//   14.05 GOOGLE / M365  the sign-in (OIDC, utils/atsPlus/sso.js) and "Add to Google Calendar / Outlook" links for every interview;
//         the OAuth app details are typed here (founder's accounts).
//   14.09 / 14.10 CONNECTORS  background-check and assessment vendors: a generic HTTP connector (URL, method, auth header, a JSON body
//         with {{candidate.name}} ...) or "manual" (the team types the result). An order gets a callback link the vendor posts the result
//         to (/api/public/connectors/callback/:order/:token). In the sandbox nothing leaves the machine.
//   14.15 JOB BOARDS     one registry of every board (Naukri, foundit, Shine, LinkedIn, Indeed, Apna, WorkIndia ...) with its real status
//         from the posting module (jobPublish) and what is done by hand.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const prisma = require('../../db');
const { logAudit } = require('../audit');
const { requirementWhere, applicationWhere, candidateWhere, clientWhere } = require('../scope');
const S = require('./store');

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const SCOPES = { 'jobs:read': 'Read open jobs', 'candidates:read': 'Read candidates', 'candidates:write': 'Add candidates', 'applications:read': 'Read applications and their steps', 'clients:read': 'Read client names' };
const EVENTS = {
  'candidate.created': 'A candidate is added', 'application.stage_changed': 'A candidate moves to another step', 'application.joined': 'A candidate joined',
  'requirement.created': 'A job (requirement) is added', 'interview.booked': 'An interview is booked', 'offer.prepared': 'An offer is prepared',
};
const HOOK_KEY = 'webhooks';
async function hookSettings() { return S.settings.get(HOOK_KEY, { enabled: false, chatEnabled: false }); }
function enc(v) { try { const SEC = require('../secrets'); return SEC.secretsConfigured() ? SEC.encryptSecret(v) : null; } catch { return null; } } // eslint-disable-line global-require
function dec(v) { try { return require('../secrets').decryptSecret(v); } catch { return null; } } // eslint-disable-line global-require
const isLoopback = (u) => { try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(u).hostname); } catch { return false; } };

// ------------------------------------------------------------------ outbound (webhooks, Slack, Teams, connectors)
async function post(url, body, headers = {}) {
  if (S.sandbox() && !isLoopback(url)) return { status: 0, note: 'SANDBOX - not sent' };
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body, signal: AbortSignal.timeout(10000) });
    return { status: r.status, note: r.ok ? 'Delivered' : `Answered ${r.status}` };
  } catch (e) { return { status: 0, note: `Not delivered: ${String(e.message).slice(0, 120)}` }; }
}
function chatText(event, data) {
  const bits = [EVENTS[event] || event];
  if (data.candidate) bits.push(data.candidate);
  if (data.job) bits.push(`for ${data.job}`);
  if (data.client) bits.push(`(${data.client})`);
  if (data.stage) bits.push(`-> ${data.stage}`);
  if (data.by) bits.push(`by ${data.by}`);
  return `TeamLink: ${bits.join(' ')}`;
}
async function deliver(hook, event, data, { test = false } = {}) {
  const payload = JSON.stringify(hook.type === 'slack' ? { text: chatText(event, data) } : hook.type === 'teams' ? { '@type': 'MessageCard', '@context': 'https://schema.org/extensions', summary: EVENTS[event] || event, text: chatText(event, data) } : { event, at: new Date().toISOString(), test, data });
  const secret = hook.secretEnc ? dec(hook.secretEnc) : null;
  const headers = { 'X-TeamLink-Event': event, ...(secret ? { 'X-TeamLink-Signature': `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}` } : {}) };
  const r = await post(hook.url, payload, headers);
  await S.items.create('hook-delivery', { refType: 'Webhook', refId: hook.id, status: r.status >= 200 && r.status < 300 ? 'OK' : (r.note.startsWith('SANDBOX') ? 'SANDBOX' : 'FAILED'), event, code: r.status, note: r.note, attempts: 1, payload: payload.slice(0, 4000), test });
  return r;
}
async function emit(event, data) {
  try {
    const set = await hookSettings();
    if (!set.enabled && !set.chatEnabled) return;
    const hooks = (await S.items.list('webhook', { status: 'ON' })).filter((h) => (h.events || []).includes(event) && ((h.type === 'generic' && set.enabled) || (['slack', 'teams'].includes(h.type) && set.chatEnabled)));
    for (const h of hooks) await deliver(h, event, data); // eslint-disable-line no-await-in-loop
  } catch (e) { console.error('[webhooks]', e.message); }
}
// facts about an application for an event: names and steps only, never contact details or money
async function appFacts(applicationId, by) {
  const a = await prisma.application.findUnique({ where: { id: String(applicationId) }, select: { id: true, stage: true, candidateId: true, requirementId: true, candidate: { select: { name: true } }, requirement: { select: { title: true, reqCode: true, internal: true, client: { select: { name: true } } } } } }).catch(() => null);
  if (!a) return null;
  const V = require('../atsVocab'); // eslint-disable-line global-require
  return { applicationId: a.id, candidateId: a.candidateId, requirementId: a.requirementId, candidate: a.candidate && a.candidate.name, job: a.requirement && a.requirement.title, jobCode: a.requirement && a.requirement.reqCode, client: a.requirement && (a.requirement.internal ? 'TeamLink' : a.requirement.client && a.requirement.client.name), stage: V.STAGE_LABELS[a.stage] || a.stage, stageCode: a.stage, by: by || null };
}
const ROUTES = [
  ['POST', /^\/api\/candidates\/?$/, 'candidate.created'],
  ['PATCH', /^\/api\/applications\/([^/]+)\/stage$/, 'application.stage_changed'],
  ['POST', /^\/api\/candidates\/board\/move$/, 'application.stage_changed'],
  ['POST', /^\/api\/requirements\/?$/, 'requirement.created'],
  ['POST', /^\/api\/ats\/interviews\/([^/]+)\/book$/, 'interview.booked'],
  ['POST', /^\/api\/ats\/offers\/([^/]+)\/prepare$/, 'offer.prepared'],
  ['POST', /^\/api\/ats\/joining\/([^/]+)\/joined$/, 'application.joined'],
];
// index.js: watches the routes above; after a 2xx answer the event is sent (never slows or changes the answer)
function eventMiddleware(req, res, next) {
  const hit = ROUTES.find(([m, re]) => m === req.method && re.test(req.originalUrl.split('?')[0]));
  if (!hit) return next();
  const [, re, event] = hit;
  const m = re.exec(req.originalUrl.split('?')[0]);
  const orig = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 300 && !res.__hookDone) {
      res.__hookDone = true;
      setImmediate(async () => {
        const by = req.user && req.user.name;
        let data = null;
        if (event === 'candidate.created') { const c = body && (body.candidate || body); if (c && c.id) data = { candidateId: c.id, candidate: c.name || null, source: c.source || null, by }; }
        else if (event === 'requirement.created') { const r = body && (body.requirement || body); if (r && r.id) data = { requirementId: r.id, job: r.title, jobCode: r.reqCode || null, department: r.department || null, by }; }
        else {
          const appId = m[1] || (req.body && req.body.applicationId);
          data = appId ? await appFacts(appId, by) : null;
        }
        if (data) await emit(event, data);
      });
    }
    return orig(body);
  };
  return next();
}
let worker = null;
function startWorker() {
  if (worker || S.sandbox()) return;
  // failed deliveries are tried again, up to 3 times, 10 minutes apart
  worker = setInterval(async () => {
    try {
      const failed = (await S.items.list('hook-delivery', { status: 'FAILED' }, { limit: 200 })).filter((d) => (d.attempts || 1) < 3 && Date.now() - new Date(d.updatedAt).getTime() > 10 * 60000);
      for (const d of failed) {
        const h = await S.items.get(d.refId, 'webhook'); if (!h || h.status !== 'ON') continue; // eslint-disable-line no-await-in-loop, no-continue
        const secret = h.secretEnc ? dec(h.secretEnc) : null;
        const r = await post(h.url, d.payload, { 'X-TeamLink-Event': d.event, ...(secret ? { 'X-TeamLink-Signature': `sha256=${crypto.createHmac('sha256', secret).update(d.payload).digest('hex')}` } : {}) }); // eslint-disable-line no-await-in-loop
        await S.items.update(d.id, { status: r.status >= 200 && r.status < 300 ? 'OK' : 'FAILED', code: r.status, note: r.note, attempts: (d.attempts || 1) + 1 }); // eslint-disable-line no-await-in-loop
      }
    } catch (e) { console.error('[webhooks retry]', e.message); }
  }, 10 * 60000);
  if (worker.unref) worker.unref();
}

// ------------------------------------------------------------------ 14.01 API keys and the API
let keyCache = { at: 0, rows: [] };
async function keys() { if (Date.now() - keyCache.at < 5000) return keyCache.rows; keyCache = { at: Date.now(), rows: await S.items.list('api-key', {}) }; return keyCache.rows; }
const buckets = new Map(); // key id -> { minute, n }
async function apiAuth(req, res, next) {
  const h = String(req.headers.authorization || '');
  const raw = h.startsWith('Bearer tlk_') ? h.slice(7) : String(req.headers['x-api-key'] || '');
  if (!/^tlk_[A-Za-z0-9_-]{20,80}$/.test(raw)) return res.status(401).json({ error: 'Send an API key: Authorization: Bearer tlk_...' });
  const k = (await keys()).find((x) => x.hash === sha(raw));
  if (!k || k.status !== 'ACTIVE') return res.status(401).json({ error: 'This API key is not valid or was switched off.' });
  const minute = Math.floor(Date.now() / 60000);
  const b = buckets.get(k.id) || { minute, n: 0 };
  if (b.minute !== minute) { b.minute = minute; b.n = 0; }
  b.n += 1; buckets.set(k.id, b);
  const limit = Number(k.rateLimit) || 60;
  res.setHeader('X-RateLimit-Limit', String(limit)); res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - b.n)));
  if (b.n > limit) { res.setHeader('Retry-After', String(60 - (Math.floor(Date.now() / 1000) % 60))); return res.status(429).json({ error: `Rate limit: ${limit} requests a minute for this key.` }); }
  const identity = await require('../identity').resolveIdentity(k.actAsId).catch(() => null); // eslint-disable-line global-require
  if (!identity || identity.status !== 'Active') return res.status(401).json({ error: 'The login this key acts for is no longer active.' });
  req.user = identity; req.apiKey = k;
  S.items.update(k.id, { lastUsedAt: new Date().toISOString(), uses: (k.uses || 0) + 1 }).catch(() => null);
  return next();
}
const need = (scope) => (req, res, next) => ((req.apiKey.scopes || []).includes(scope) ? next() : res.status(403).json({ error: `This key does not have the ${scope} scope.` }));
const LIVE = ['OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE'];
const jobOut = (r) => ({ id: r.id, code: r.reqCode, title: r.title, status: r.status, department: r.department, location: r.location, openings: r.openings, experience: r.experience, skills: r.skills, employmentType: r.employmentType, workMode: r.workMode, client: r.internal ? 'TeamLink' : (r.client && r.client.name) || null, createdAt: r.createdAt, updatedAt: r.updatedAt });
const page = (q) => ({ take: Math.min(Math.max(Number(q.limit) || 50, 1), 200), skip: Math.max(Number(q.offset) || 0, 0) });
const since = (q) => (q.updatedSince && !Number.isNaN(new Date(q.updatedSince).getTime()) ? new Date(q.updatedSince) : null);

const apiRouter = express.Router();
apiRouter.use(apiAuth);
apiRouter.get('/jobs', need('jobs:read'), S.wrap(async (req, res) => {
  const p = page(req.query); const u = since(req.query);
  const where = { AND: [requirementWhere(req.user), req.query.all ? {} : { status: { in: LIVE } }, u ? { updatedAt: { gte: u } } : {}] };
  const [rows, total] = await Promise.all([prisma.requirement.findMany({ where, include: { client: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, ...p }), prisma.requirement.count({ where })]);
  res.json({ data: rows.map(jobOut), total, limit: p.take, offset: p.skip });
}));
apiRouter.get('/jobs/:id', need('jobs:read'), S.wrap(async (req, res) => {
  const r = await prisma.requirement.findFirst({ where: { AND: [{ id: req.params.id }, requirementWhere(req.user)] }, include: { client: { select: { name: true } } } });
  if (!r) return res.status(404).json({ error: 'Not found.' });
  res.json({ data: { ...jobOut(r), description: r.jobDescription || r.description || null } });
}));
apiRouter.get('/candidates', need('candidates:read'), S.wrap(async (req, res) => {
  const p = page(req.query);
  const where = { AND: [candidateWhere(req.user), req.query.q ? { OR: [{ name: { contains: String(req.query.q) } }, { skills: { contains: String(req.query.q) } }] } : {}] };
  const [rows, total] = await Promise.all([prisma.candidate.findMany({ where, select: { id: true, name: true, email: true, phone: true, skills: true, currentCompany: true, location: true, createdAt: true, consentStatus: true }, orderBy: { createdAt: 'desc' }, ...p }), prisma.candidate.count({ where })]);
  // a person who withdrew consent is listed without contact details
  res.json({ data: rows.map((c) => (c.consentStatus === 'WITHDRAWN' ? { ...c, email: null, phone: null } : c)), total, limit: p.take, offset: p.skip });
}));
apiRouter.post('/candidates', need('candidates:write'), S.wrap(async (req, res) => {
  const token = jwt.sign({ ...require('../identity').tokenPayload(req.user), tms: Date.now() }, process.env.JWT_SECRET, { expiresIn: '2m' }); // eslint-disable-line global-require
  const r = await fetch(`http://127.0.0.1:${process.env.PORT || 4000}/api/candidates`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...(req.body || {}), source: (req.body && req.body.source) || `API (${req.apiKey.title})` }) });
  let j = {}; try { j = await r.json(); } catch { /* none */ }
  await logAudit({ userId: req.user.id, action: 'Candidate added through the API', entity: 'Candidate', entityId: (j && (j.id || (j.candidate && j.candidate.id))) || null, reason: `API key ${req.apiKey.prefix}` });
  res.status(r.status).json(r.ok ? { data: j.candidate || j } : j);
}));
apiRouter.get('/applications', need('applications:read'), S.wrap(async (req, res) => {
  const p = page(req.query); const u = since(req.query);
  const where = { AND: [applicationWhere(req.user), req.query.requirementId ? { requirementId: String(req.query.requirementId) } : {}, u ? { updatedAt: { gte: u } } : {}] };
  const [rows, total] = await Promise.all([prisma.application.findMany({ where, select: { id: true, candidateId: true, requirementId: true, stage: true, createdAt: true, updatedAt: true }, orderBy: { updatedAt: 'desc' }, ...p }), prisma.application.count({ where })]);
  res.json({ data: rows, total, limit: p.take, offset: p.skip });
}));
apiRouter.get('/clients', need('clients:read'), S.wrap(async (req, res) => {
  const p = page(req.query);
  const rows = await prisma.client.findMany({ where: clientWhere(req.user), select: { id: true, name: true, industry: true, location: true }, orderBy: { name: 'asc' }, ...p });
  res.json({ data: rows, limit: p.take, offset: p.skip });
}));
apiRouter.use((req, res) => res.status(404).json({ error: 'No such API address. See /api/docs.' }));

function openapi(base) {
  const list = (desc, scope, params = []) => ({ get: { summary: desc, security: [{ apiKey: [] }], 'x-scope': scope, parameters: params.map((n) => ({ name: n, in: 'query', schema: { type: 'string' } })), responses: { 200: { description: 'OK' }, 401: { description: 'No or a wrong key' }, 403: { description: 'The key lacks the scope' }, 429: { description: 'Rate limit' } } } });
  return {
    openapi: '3.0.3', info: { title: 'TeamLink ATS API', version: '1.0', description: 'Read jobs, candidates, applications and clients, and add candidates. A key acts with the scope of the login it is tied to. Webhooks tell you when something happens (see the Integrations tab).' },
    servers: [{ url: `${base}/api/v1/open` }],
    components: { securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'tlk_...' } } },
    paths: {
      '/jobs': list('Open jobs (all=1 for every status)', 'jobs:read', ['limit', 'offset', 'updatedSince', 'all']),
      '/jobs/{id}': { get: { summary: 'One job with its description', 'x-scope': 'jobs:read', security: [{ apiKey: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'OK' }, 404: { description: 'Not found' } } } },
      '/candidates': { ...list('Candidates (q = name or skill)', 'candidates:read', ['limit', 'offset', 'q']), post: { summary: 'Add a candidate (the app\'s duplicate check and rules apply)', 'x-scope': 'candidates:write', security: [{ apiKey: [] }], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['name', 'phone'], properties: { name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' }, skills: { type: 'string' }, source: { type: 'string' } } } } } }, responses: { 201: { description: 'Added' }, 409: { description: 'Already there (duplicate)' } } } },
      '/applications': list('Applications and their current step', 'applications:read', ['limit', 'offset', 'requirementId', 'updatedSince']),
      '/clients': list('Client names', 'clients:read', ['limit', 'offset']),
    },
    'x-webhooks': Object.fromEntries(Object.entries(EVENTS).map(([k, v]) => [k, v])),
  };
}
const docsRouter = express.Router();
docsRouter.get('/openapi.json', (req, res) => res.json(openapi(`${req.protocol}://${req.get('host')}`)));
docsRouter.get('/', (req, res) => {
  const spec = openapi(`${req.protocol}://${req.get('host')}`);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = Object.entries(spec.paths).flatMap(([p, ops]) => Object.entries(ops).map(([m, o]) => `<tr><td><code>${m.toUpperCase()}</code></td><td><code>/api/v1/open${esc(p)}</code></td><td>${esc(o.summary)}</td><td><code>${esc(o['x-scope'] || '')}</code></td><td>${esc((o.parameters || []).map((x) => x.name).join(', '))}</td></tr>`)).join('');
  const hooks = Object.entries(EVENTS).map(([k, v]) => `<tr><td><code>${k}</code></td><td>${esc(v)}</td></tr>`).join('');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TeamLink ATS API</title>
<style>body{font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#1f2937}table{border-collapse:collapse;width:100%;margin:10px 0}td,th{border:1px solid #e5e7eb;padding:6px 8px;text-align:left;font-size:14px;vertical-align:top}th{background:#f3f4f6}code{background:#f3f4f6;padding:1px 4px;border-radius:4px}pre{background:#111827;color:#f9fafb;padding:12px;border-radius:8px;overflow:auto}</style></head><body>
<h1>TeamLink ATS API</h1><p>${esc(spec.info.description)}</p>
<h2>Sign in</h2><p>Every request sends the key an Admin made (Administration &rarr; ATS settings &rarr; Integrations): <code>Authorization: Bearer tlk_...</code>. Each key has scopes and a limit of requests a minute (answer 429 with <code>Retry-After</code> above it).</p>
<pre>curl -H "Authorization: Bearer tlk_YOUR_KEY" ${esc(spec.servers[0].url)}/jobs?limit=20</pre>
<h2>Addresses</h2><table><tr><th>Method</th><th>Address</th><th>What</th><th>Scope</th><th>Query</th></tr>${rows}</table>
<p>Lists answer <code>{ data, total, limit, offset }</code>; <code>limit</code> is at most 200.</p>
<h2>Webhooks (Zapier, n8n, Make)</h2><p>A webhook URL gets a POST with JSON <code>{ event, at, data }</code> and the header <code>X-TeamLink-Signature: sha256=&lt;HMAC of the body with your secret&gt;</code>.</p><table><tr><th>Event</th><th>When</th></tr>${hooks}</table>
<p>Machine-readable: <a href="/api/docs/openapi.json">openapi.json</a> (OpenAPI 3).</p></body></html>`);
});

// ------------------------------------------------------------------ 14.15 job boards
async function boards() {
  const C = require('../../jobPublish/constants'); // eslint-disable-line global-require
  const creds = await prisma.portalCredential.findMany({ select: { portal: true, status: true, enabled: true, lastVerifiedAt: true } }).catch(() => []);
  const since = new Date(Date.now() - 30 * 86400000);
  const posts = await prisma.portalPosting.groupBy({ by: ['portal'], where: { createdAt: { gte: since }, status: 'PUBLISHED' }, _count: { _all: true } }).catch(() => []);
  const postsOf = new Map(posts.map((p) => [p.portal, p._count._all]));
  const rows = Object.values(C.PORTALS || {}).map((p) => {
    const c = creds.find((x) => x.portal === p.key);
    const status = p.kind === 'internal' ? 'Built in' : p.kind === 'manual' ? 'By hand (TeamLink prepares the text)' : !c ? 'Not set up' : c.status === 'CONNECTED' ? (c.enabled ? 'Connected, posting ON' : 'Connected, posting OFF') : `Needs attention (${c.status})`;
    return { key: p.key, name: p.name, how: { browser: 'Posts through your saved recruiter account', api: 'Official API with your token', manual: 'A person posts; TeamLink keeps the task', internal: 'Your own career page' }[p.kind] || p.kind, status, ready: /Connected|Built in/.test(status), postedLast30: postsOf.get(p.key) || 0, note: p.note || null };
  });
  const OTHER = [['indeed', 'Indeed', 'Indeed has no open posting API for agencies in India: post on the site; responses come in by mail import.'], ['apna', 'apna.co', 'Post on apna; import the applicants with the spreadsheet import.'], ['workindia', 'WorkIndia', 'Post on WorkIndia; import the applicants with the spreadsheet import.'], ['hirist', 'Hirist / Instahyre', 'Post on the site; responses by mail import.']];
  OTHER.forEach(([key, name, note]) => { if (!rows.some((r) => r.key === key)) rows.push({ key, name, how: 'By hand', status: 'No connector (partner account needed)', ready: false, postedLast30: 0, note }); });
  return rows;
}

// ------------------------------------------------------------------ 14.09 / 14.10 connectors
function fillTpl(tpl, ctx) {
  return String(tpl || '').replace(/\{\{\s*([a-zA-Z.]+)\s*\}\}/g, (_, k) => { const v = k.split('.').reduce((o, x) => (o ? o[x] : undefined), ctx); return v === undefined || v === null ? '' : String(v).replace(/["\\]/g, ''); });
}
async function orderCheck(user, conn, applicationId) {
  const app = await prisma.application.findFirst({ where: { AND: [{ id: String(applicationId) }, applicationWhere(user)] }, select: { id: true, candidateId: true, candidate: { select: { name: true, email: true, phone: true } }, requirement: { select: { title: true } } } });
  if (!app) return { status: 404, error: 'That person is not in your list.' };
  const token = crypto.randomBytes(18).toString('base64url');
  const order = await S.items.create('conn-order', { refType: 'Application', refId: app.id, ownerId: user.id, status: 'ORDERED', title: `${conn.title}: ${app.candidate.name}`, connectorId: conn.id, connectorType: conn.type, candidateId: app.candidateId, tokenHash: sha(token), log: [] }, user);
  const callback = `/api/public/connectors/callback/${order.id}/${token}`;
  let note = 'Manual: type the result when the vendor sends it.';
  if (conn.mode === 'http' && conn.url) {
    const ctx = { candidate: app.candidate, job: { title: app.requirement.title }, order: { id: order.id, callback } };
    const body = conn.bodyTemplate ? fillTpl(conn.bodyTemplate, ctx) : JSON.stringify({ orderId: order.id, callback, candidate: app.candidate, job: app.requirement.title });
    const auth = conn.authEnc ? dec(conn.authEnc) : null;
    const r = await post(conn.url, body, auth ? { [conn.authHeader || 'Authorization']: auth } : {});
    note = r.note;
    await S.items.update(order.id, { status: r.status >= 200 && r.status < 300 ? 'IN_PROGRESS' : (r.note.startsWith('SANDBOX') ? 'ORDERED' : 'FAILED'), log: [{ at: new Date().toISOString(), note }] });
  }
  await logAudit({ userId: user.id, action: `${conn.type === 'bgv' ? 'Background check' : 'Assessment'} ordered (${conn.title})`, entity: 'Application', entityId: app.id, toValue: note.slice(0, 200) });
  return { status: 201, order: await S.items.get(order.id), callback, note };
}
const VERDICTS = ['Clear', 'Discrepancy', 'Insufficient', 'Passed', 'Failed', 'Pending'];
async function setResult(order, b, by) {
  const verdict = VERDICTS.includes(b.verdict) ? b.verdict : null;
  if (!verdict) return { status: 400, error: `Verdict: ${VERDICTS.join(', ')}.` };
  const score = b.score === undefined || b.score === '' ? null : Number(b.score);
  const out = await S.items.update(order.id, { status: verdict === 'Pending' ? 'IN_PROGRESS' : 'DONE', result: { verdict, score: Number.isFinite(score) ? score : null, reportUrl: /^https?:\/\//.test(String(b.reportUrl || '')) ? String(b.reportUrl).slice(0, 500) : null, notes: String(b.notes || '').slice(0, 2000) || null, by, at: new Date().toISOString() } });
  await logAudit({ userId: null, action: `${order.connectorType === 'bgv' ? 'Background check' : 'Assessment'} result: ${verdict}`, entity: 'Application', entityId: order.refId, toValue: `${order.title}${score !== null ? ` · score ${score}` : ''}`, actorName: by });
  return { status: 200, order: out };
}

// ------------------------------------------------------------------ routes (staff)
const router = express.Router();
router.get('/integrations/overview', S.internal, S.wrap(async (req, res) => {
  const set = await hookSettings();
  const W = require('./calendarZ'); // eslint-disable-line global-require
  const gk = await W.workspaceKeys('google'); const mk = await W.workspaceKeys('microsoft');
  res.json({ webhooks: set, scopes: SCOPES, events: EVENTS, google: { clientId: gk.clientId || '', hasSecret: !!gk.secret, calendarLinks: true }, microsoft: { tenantId: mk.tenant === 'common' && !mk.clientId ? '' : mk.tenant, clientId: mk.clientId || '', hasSecret: !!mk.secret, calendarLinks: true }, canEdit: S.isAdmin(req.user) && !req.viewAs, docs: '/api/docs' });
}));
router.put('/integrations/webhook-settings', S.adminOnly, S.wrap(async (req, res) => {
  const b = req.body || {}; const cur = await hookSettings();
  const next = { enabled: 'enabled' in b ? !!b.enabled : cur.enabled, chatEnabled: 'chatEnabled' in b ? !!b.chatEnabled : cur.chatEnabled };
  await S.settings.set(HOOK_KEY, next, req.user);
  await logAudit({ userId: req.user.id, action: `Webhooks ${next.enabled ? 'ON' : 'OFF'}, Slack / Teams ${next.chatEnabled ? 'ON' : 'OFF'}`, entity: 'AtsPlusSetting', entityId: HOOK_KEY });
  res.json(next);
}));
router.put('/integrations/workspace', S.adminOnly, S.wrap(async (req, res) => {
  // ATS wave 2 Z: the keys go to the ONE credential store (Administration > Integrations > "Google Workspace / Microsoft 365 (ATS)",
  // utils/integrationStore.js, secrets encrypted); the calendar connection (utils/mkt/interviews.js appKeys) reads them from there.
  const b = req.body || {};
  const ST = require('../integrationStore'); // eslint-disable-line global-require
  const incoming = {};
  if ('googleClientId' in b) incoming['Google client ID'] = String(b.googleClientId || '').trim().slice(0, 200);
  if ('msClientId' in b) incoming['Microsoft app (client) ID'] = String(b.msClientId || '').trim().slice(0, 200);
  if ('msTenantId' in b) incoming['Microsoft tenant ID (common = any)'] = String(b.msTenantId || '').trim().slice(0, 200);
  if (b.googleSecret) incoming['Google client secret'] = String(b.googleSecret);
  if (b.msSecret) incoming['Microsoft client secret'] = String(b.msSecret);
  let written;
  try { written = await ST.writeValues('ats-workspace', incoming); } catch (e) { if (e && e.code === 'NO_SECRET_KEY') return res.status(400).json({ error: 'Set the encryption key on the server first (secrets are never stored in plain text).' }); throw e; }
  await ST.integrationRow('ats-workspace');
  await prisma.integration.update({ where: { id: 'ats-workspace' }, data: { values: JSON.stringify(written.values), ...(written.filled ? { enabled: true, connected: true, state: 'Connected', connectedAt: new Date(), error: null } : {}) } });
  await ST.recordEvent('ats-workspace', { action: 'Connected', by: req.user.name, result: 'App details saved (encrypted at rest)' });
  await logAudit({ userId: req.user.id, action: 'Google / Microsoft 365 app details saved', entity: 'Integration', entityId: 'ats-workspace' });
  res.json({ ok: true });
}));
// API keys
router.get('/integrations/api-keys', S.adminOnly, S.wrap(async (req, res) => res.json({ rows: (await S.items.list('api-key', {})).map((k) => ({ id: k.id, title: k.title, prefix: k.prefix, scopes: k.scopes, rateLimit: k.rateLimit, status: k.status, actAsName: k.actAsName, lastUsedAt: k.lastUsedAt || null, uses: k.uses || 0, createdAt: k.createdAt, createdByName: k.createdByName })), scopes: SCOPES })));
router.post('/integrations/api-keys', S.adminOnly, S.wrap(async (req, res) => {
  const b = req.body || {};
  const title = String(b.name || '').trim(); if (title.length < 3) return res.status(400).json({ error: 'Name the key (who or what uses it).' });
  const scopes = (Array.isArray(b.scopes) ? b.scopes : []).filter((s) => SCOPES[s]);
  if (!scopes.length) return res.status(400).json({ error: 'Tick at least one scope.' });
  let actAs = req.user;
  if (b.actAsId) { const u = await prisma.user.findUnique({ where: { id: String(b.actAsId) }, select: { id: true, name: true, status: true } }); if (!u || u.status !== 'Active') return res.status(400).json({ error: 'That login is not active.' }); actAs = u; }
  const raw = `tlk_${crypto.randomBytes(24).toString('base64url')}`;
  const k = await S.items.create('api-key', { title: title.slice(0, 80), status: 'ACTIVE', hash: sha(raw), prefix: raw.slice(0, 10), scopes, rateLimit: Math.max(1, Math.min(600, Number(b.rateLimit) || 60)), actAsId: actAs.id, actAsName: actAs.name }, req.user);
  keyCache.at = 0;
  await logAudit({ userId: req.user.id, action: 'API key made', entity: 'ApiKey', entityId: k.id, toValue: `${title} · ${scopes.join(', ')} · acts as ${actAs.name}` });
  res.status(201).json({ id: k.id, key: raw, message: 'Copy the key now. It is shown only this once.' });
}));
router.post('/integrations/api-keys/:id/revoke', S.adminOnly, S.wrap(async (req, res) => {
  const k = await S.items.get(req.params.id, 'api-key'); if (!k) return res.status(404).json({ error: 'Not found.' });
  await S.items.update(k.id, { status: 'REVOKED', revokedAt: new Date().toISOString() }); keyCache.at = 0;
  await logAudit({ userId: req.user.id, action: 'API key switched off', entity: 'ApiKey', entityId: k.id, toValue: k.title });
  res.json({ ok: true });
}));
// webhooks / Slack / Teams
router.get('/integrations/webhooks', S.adminOnly, S.wrap(async (req, res) => {
  const hooks = await S.items.list('webhook', {});
  const del = await S.items.list('hook-delivery', {}, { limit: 100 });
  res.json({ rows: hooks.map((h) => ({ id: h.id, title: h.title, type: h.type, url: h.url.replace(/(\/\/[^/]+\/).{6,}$/, '$1…'), events: h.events, status: h.status, hasSecret: !!h.secretEnc })), deliveries: del.map((d) => ({ id: d.id, webhookId: d.refId, event: d.event, status: d.status, code: d.code, note: d.note, at: d.createdAt, test: !!d.test })), events: EVENTS, settings: await hookSettings(), recipes: RECIPES });
}));
router.post('/integrations/webhooks', S.adminOnly, S.wrap(async (req, res) => {
  const b = req.body || {};
  const type = ['generic', 'slack', 'teams'].includes(b.type) ? b.type : 'generic';
  const url = String(b.url || '').trim();
  if (!/^https:\/\//.test(url) && !(S.sandbox() && isLoopback(url))) return res.status(400).json({ error: 'The address must start with https://' });
  if (type === 'slack' && !/hooks\.slack\.com|localhost|127\.0\.0\.1/.test(url)) return res.status(400).json({ error: 'A Slack incoming-webhook address starts with https://hooks.slack.com/' });
  const events = (Array.isArray(b.events) ? b.events : []).filter((e) => EVENTS[e]);
  if (!events.length) return res.status(400).json({ error: 'Tick at least one event.' });
  const secret = type === 'generic' ? crypto.randomBytes(20).toString('hex') : null;
  const h = await S.items.create('webhook', { title: String(b.name || type).slice(0, 80), type, url: url.slice(0, 500), events, status: 'ON', secretEnc: secret ? enc(secret) : null }, req.user);
  await logAudit({ userId: req.user.id, action: `Webhook added (${type})`, entity: 'Webhook', entityId: h.id, toValue: `${events.join(', ')}` });
  res.status(201).json({ id: h.id, secret, message: secret ? 'Copy the signing secret now: it is shown only this once.' : 'Added.' });
}));
router.post('/integrations/webhooks/:id/test', S.adminOnly, S.wrap(async (req, res) => {
  const h = await S.items.get(req.params.id, 'webhook'); if (!h) return res.status(404).json({ error: 'Not found.' });
  const r = await deliver(h, h.events[0], { test: true, candidate: 'Test Candidate', job: 'Test job', stage: 'Shortlisted', by: req.user.name }, { test: true });
  res.json(r);
}));
router.post('/integrations/webhooks/:id/status', S.adminOnly, S.wrap(async (req, res) => {
  const h = await S.items.get(req.params.id, 'webhook'); if (!h) return res.status(404).json({ error: 'Not found.' });
  const st = (req.body || {}).on ? 'ON' : 'OFF';
  await S.items.update(h.id, { status: st });
  res.json({ ok: true, status: st });
}));
// Google / Outlook calendar links for an interview (no account needed)
router.get('/integrations/calendar-links/:applicationId', S.internal, S.wrap(async (req, res) => {
  const a = await prisma.application.findFirst({ where: { AND: [{ id: req.params.applicationId }, applicationWhere(req.user)] }, select: { interviewAt: true, interviewMode: true, candidate: { select: { name: true } }, requirement: { select: { title: true, location: true } } } }).catch(() => null);
  if (!a || !a.interviewAt) return res.status(404).json({ error: 'No interview booked for this person.' });
  const st = new Date(a.interviewAt); const en = new Date(st.getTime() + 60 * 60000);
  const f = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const title = `Interview: ${a.candidate.name} - ${a.requirement.title}`;
  res.json({
    google: `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${f(st)}/${f(en)}&location=${encodeURIComponent(a.requirement.location || '')}`,
    outlook: `https://outlook.office.com/calendar/0/deeplink/compose?subject=${encodeURIComponent(title)}&startdt=${encodeURIComponent(st.toISOString())}&enddt=${encodeURIComponent(en.toISOString())}&location=${encodeURIComponent(a.requirement.location || '')}`,
  });
}));
// connectors
router.get('/integrations/connectors', S.internal, S.wrap(async (req, res) => {
  const rows = (await S.items.list('connector', {})).map((c) => ({ id: c.id, title: c.title, type: c.type, mode: c.mode, url: c.url ? c.url.replace(/(\/\/[^/]+\/).{4,}$/, '$1…') : null, status: c.status, hasAuth: !!c.authEnc }));
  const orders = await S.items.list('conn-order', {}, { limit: 300 });
  const apps = orders.length ? new Set((await prisma.application.findMany({ where: { AND: [applicationWhere(req.user), { id: { in: orders.map((o) => o.refId) } }] }, select: { id: true } })).map((a) => a.id)) : new Set();
  res.json({ rows, orders: orders.filter((o) => apps.has(o.refId)).map((o) => ({ id: o.id, title: o.title, type: o.connectorType, applicationId: o.refId, status: o.status, result: o.result || null, at: o.createdAt })), verdicts: VERDICTS, canEdit: S.isAdmin(req.user) && !req.viewAs });
}));
router.post('/integrations/connectors', S.adminOnly, S.wrap(async (req, res) => {
  const b = req.body || {};
  const type = ['bgv', 'assessment'].includes(b.type) ? b.type : null; if (!type) return res.status(400).json({ error: 'Background check or assessment.' });
  const title = String(b.name || '').trim(); if (title.length < 2) return res.status(400).json({ error: 'The vendor name.' });
  const mode = b.mode === 'http' ? 'http' : 'manual';
  const url = String(b.url || '').trim();
  if (mode === 'http' && !/^https:\/\//.test(url) && !(S.sandbox() && isLoopback(url))) return res.status(400).json({ error: 'The vendor address must start with https://' });
  let authEnc = null; if (b.auth) { authEnc = enc(String(b.auth)); if (!authEnc) return res.status(400).json({ error: 'Set the encryption key on the server first (secrets are never stored in plain text).' }); }
  const c = await S.items.create('connector', { title: title.slice(0, 80), type, mode, url: mode === 'http' ? url.slice(0, 500) : null, authHeader: String(b.authHeader || 'Authorization').slice(0, 60), authEnc, bodyTemplate: String(b.bodyTemplate || '').slice(0, 4000) || null, status: 'ON' }, req.user);
  await logAudit({ userId: req.user.id, action: `${type === 'bgv' ? 'Background-check' : 'Assessment'} connector added`, entity: 'Connector', entityId: c.id, toValue: `${title} (${mode})` });
  res.status(201).json({ id: c.id });
}));
router.post('/integrations/connectors/:id/order', S.writer, S.wrap(async (req, res) => {
  const c = await S.items.get(req.params.id, 'connector'); if (!c || c.status !== 'ON') return res.status(404).json({ error: 'That connector is not there.' });
  const r = await orderCheck(req.user, c, (req.body || {}).applicationId);
  res.status(r.status).json(r);
}));
router.post('/integrations/orders/:id/result', S.writer, S.wrap(async (req, res) => {
  const o = await S.items.get(req.params.id, 'conn-order'); if (!o) return res.status(404).json({ error: 'Not found.' });
  if (!(await prisma.application.findFirst({ where: { AND: [{ id: o.refId }, applicationWhere(req.user)] }, select: { id: true } }))) return res.status(404).json({ error: 'Not in your list.' });
  const r = await setResult(o, req.body || {}, req.user.name);
  res.status(r.status).json(r);
}));
router.get('/integrations/job-boards', S.internal, S.wrap(async (req, res) => res.json({ rows: await boards() })));

// the vendor's result (public): /api/public/connectors/callback/:order/:token
const publicRouter = express.Router();
const { rateLimit } = require('../publicRateLimit');
publicRouter.post('/callback/:id/:token', rateLimit({ bucket: 'connector-callback', max: 60, windowMs: 10 * 60000 }), S.wrap(async (req, res) => {
  const o = await S.items.get(req.params.id, 'conn-order');
  if (!o || o.tokenHash !== sha(req.params.token)) return res.status(404).json({ error: 'Unknown order.' });
  const r = await setResult(o, req.body || {}, `Vendor (${o.title.split(':')[0]})`);
  res.status(r.status).json(r.error ? r : { ok: true });
}));

const RECIPES = [
  { tool: 'Zapier', title: 'New joining -> a row in Google Sheets', steps: ['Zapier: Webhooks by Zapier -> Catch Hook, copy its URL', 'TeamLink: add a webhook with that URL, tick "A candidate joined"', 'Zapier: add Google Sheets -> Create Spreadsheet Row, map candidate, job, client'] },
  { tool: 'Zapier', title: 'Open jobs -> your website every hour', steps: ['Zapier: Schedule -> Every Hour', 'Webhooks by Zapier -> GET https://<your site>/api/v1/jobs with the header Authorization: Bearer <API key with jobs:read>', 'Send the list to your website builder'] },
  { tool: 'n8n', title: 'Candidate from a web form -> TeamLink', steps: ['n8n: Webhook node receives the form', 'HTTP Request node: POST /api/v1/candidates with name, phone, email, skills (API key with candidates:write)', 'TeamLink checks duplicates and keeps the source "API (<key name>)"'] },
  { tool: 'n8n', title: 'Step changes -> Slack thread per client', steps: ['n8n: Webhook node, copy the URL into a TeamLink webhook ("moves to another step")', 'Check the X-TeamLink-Signature with your secret (Crypto node, HMAC SHA256)', 'Slack node: post to the channel of data.client'] },
];

module.exports = { router, apiRouter, docsRouter, publicRouter, eventMiddleware, emit, startWorker, boards, EVENTS, SCOPES };
