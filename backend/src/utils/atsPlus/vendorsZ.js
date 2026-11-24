// ---------------------------------------------------------------------------
// BACKGROUND-VERIFICATION AND ASSESSMENT VENDORS (market benchmark 14.09 / IN-15 and 14.10; ATS wave 2 Z, 2026-11-25).
// The market wave built a generic HTTP connector with a typed body (utils/atsPlus/integrations.js). This is the finished vendor
// connector: the keys are in Administration > Integrations ("Background verification vendor (ATS)", "Assessment vendor (ATS)";
// utils/integrationStore.js, encrypted), the order carries the candidate and the checks / test, and the RESULT COMES BACK ON THE
// RECORD: a background check fills the candidate's BGV card (education / employment / address / criminal / identity -> Clear /
// Discrepancy / In progress, utils/atsOfferBgv.js), a test's score and pass / fail sit on the order beside the person.
//
//   POST /api/ats-plus/vendorsz/:kind/order { applicationId, checks?, testId?, consent }   kind = bgv | assessment
//        a background check needs the recruiter to confirm the candidate's written consent (DPDP Act 2023) - kept on the order
//   GET  /api/ats-plus/vendorsz/orders?applicationId        the orders the caller may see (their own ATS scope)
//   POST /api/ats-plus/vendorsz/orders/:id/check            ask the vendor for the result now (also every 30 minutes, outside the sandbox)
//   GET  /api/ats-plus/vendorsz/status                       is each vendor set up (Set up link for the Admin)
//   POST /api/public/vendorsz/callback/:id/:token           the vendor's result call: the order's own token, and - when a webhook secret
//        is set - an HMAC-SHA256 of the raw body (header X-Signature / X-TeamLink-Signature / X-Hub-Signature-256, "sha256=" optional)
// THE CONTRACT (what the vendor confirms at onboarding; only mapResult() would change):
//   order   POST <API base URL>/orders, Authorization: Bearer <API key>, JSON { reference, callbackUrl, candidate { name, email, phone },
//           job, checks [..] | testId } -> { id | orderId, status, testUrl? }
//   status  GET  <API base URL>/orders/<vendor id> -> the same shape as the callback
//   result  { status | overall | result, checks: [{ type, status }] | { education: 'clear' ... }, score, maxScore, passed, reportUrl }
// In the sandbox only a local stub (localhost) is ever called; real people get nothing from here (the vendor contacts the candidate
// only after a real order, which needs the founder's vendor account).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const express = require('express');
const prisma = require('../../db');
const { logAudit } = require('../audit');
const { applicationWhere, atsViewRole } = require('../scope');
const S = require('./store');

const KINDS = {
  bgv: { channel: 'ats-bgv', label: 'Background check', vendorField: 'Vendor (SpringVerify / AuthBridge / IDfy / OnGrid / Other)' },
  assessment: { channel: 'ats-assessment', label: 'Assessment', vendorField: 'Vendor (HackerEarth / Mercer Mettl / iMocha / HackerRank / Other)' },
};
const CHECKS = ['education', 'employment', 'address', 'criminal', 'identity'];
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const isLoopback = (u) => /^http:\/\/(localhost|127\.0\.0\.1)[:/]/i.test(String(u || ''));
const OB = () => require('../atsOfferBgv'); // eslint-disable-line global-require

async function vendorConfig(kind) {
  const K = KINDS[kind];
  const { readConfig } = require('../integrationStore'); // eslint-disable-line global-require
  const c = await readConfig(K.channel).catch(() => ({ values: {} }));
  const v = c.values || {};
  const hintVendor = kind === 'bgv' ? 'SpringVerify' : 'HackerEarth';
  const base = String(v['API base URL'] || '').trim().replace(/\/+$/, '');
  const realBase = base && base !== 'https://api.vendor.example/v1' ? base : '';
  return {
    kind, vendor: String(v[K.vendorField] || '').trim() || hintVendor, base: realBase, key: String(v['API key'] || '').trim(), secret: String(v['Webhook secret (checks the vendor result calls)'] || '').trim(),
    checks: String(v['Checks to order (comma list)'] || '').split(',').map((x) => x.trim().toLowerCase()).filter((x) => CHECKS.includes(x)),
    testId: String(v['Default test ID'] || '').trim(), ready: !!(realBase && String(v['API key'] || '').trim()), missingKey: !!c.missingKey,
  };
}
async function call(cfg, method, path, body) {
  const url = `${cfg.base}${path}`;
  if (!/^https:\/\//i.test(url) && !(S.sandbox() && isLoopback(url))) return { ok: false, status: 0, note: 'The vendor address must start with https://' };
  if (S.sandbox() && !isLoopback(url)) return { ok: false, status: 0, note: 'SANDBOX - not sent' };
  try {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${cfg.key}` }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    let j = null; try { j = await r.json(); } catch { j = null; }
    return { ok: r.ok, status: r.status, body: j, note: r.ok ? 'Sent to the vendor' : `The vendor answered ${r.status}` };
  } catch (e) { return { ok: false, status: 0, note: `Not sent: ${String(e.message).slice(0, 120)}` }; }
}

// ------------------------------------------------------------------ the vendor's words -> ours
function bgvWord(w) {
  const s = String(w || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (!s) return null;
  if (/^(clear|green|verified|completed_clear|passed|positive|no_record|completed)$/.test(s)) return 'Clear';
  if (/(discrep|^red$|unverified|negative|record_found|failed|mismatch|fake)/.test(s)) return 'Discrepancy';
  if (/(not_needed|not_applicable|na|n_a|skipped)/.test(s)) return 'Not needed';
  if (/(insufficient|amber|unable|inconclusive|on_hold|awaiting|pending|progress|initiated|processing|ordered|open|wip)/.test(s)) return 'In progress';
  return null;
}
function mapResult(kind, b) {
  const body = b && typeof b === 'object' ? (b.data && typeof b.data === 'object' && !Array.isArray(b.data) ? { ...b, ...b.data } : b) : {};
  const overallRaw = body.overall || body.result || body.status || body.verdict;
  const reportUrl = [body.reportUrl, body.report_url, body.report].find((x) => /^https?:\/\//.test(String(x || ''))) || null;
  if (kind === 'bgv') {
    const checks = {};
    const list = Array.isArray(body.checks) ? body.checks : (body.checks && typeof body.checks === 'object' ? Object.entries(body.checks).map(([type, status]) => ({ type, status: typeof status === 'object' ? (status.status || status.result) : status })) : []);
    list.forEach((c) => {
      const t = String(c.type || c.name || c.check || '').toLowerCase();
      const key = CHECKS.find((k) => t.includes(k) || (k === 'employment' && /employ|work|experience/.test(t)) || (k === 'identity' && /id|pan|aadhaar|passport/.test(t)) || (k === 'criminal' && /court|police|crim/.test(t)));
      const st = bgvWord(c.status || c.result);
      if (key && st) checks[key] = st;
    });
    const overall = bgvWord(overallRaw);
    const vals = Object.values(checks);
    const done = (overall && overall !== 'In progress') || (vals.length > 0 && vals.every((x) => x !== 'In progress'));
    const verdict = vals.includes('Discrepancy') || overall === 'Discrepancy' ? 'Discrepancy' : done ? (overall === 'Not needed' ? 'Clear' : (overall || 'Clear')) : 'Pending';
    return { done: !!done, verdict: verdict === 'In progress' ? 'Pending' : verdict, checks, reportUrl, note: String(body.note || body.remarks || '').slice(0, 500) || null };
  }
  const num = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const score = num(body.score ?? body.percentage ?? (body.result && body.result.score));
  const maxScore = num(body.maxScore ?? body.max_score ?? body.total) || (score !== null ? 100 : null);
  const word = String(overallRaw || '').toLowerCase();
  let passed = typeof body.passed === 'boolean' ? body.passed : (/pass|qualif|selected/.test(word) ? true : (/fail|reject|not_qualif/.test(word) ? false : null));
  const done = passed !== null || score !== null || /complet|finish|submitted|evaluated/.test(word);
  if (passed === null && score !== null && body.cutoff !== undefined) passed = score >= Number(body.cutoff);
  return { done, verdict: !done ? 'Pending' : passed === false ? 'Failed' : passed === true ? 'Passed' : 'Completed', score, maxScore, passed, reportUrl, testUrl: body.testUrl || body.inviteUrl || body.test_url || null };
}

// ------------------------------------------------------------------ result -> the record
async function applyResult(order, raw, by) {
  const m = mapResult(order.kind, raw);
  const patch = { status: m.done ? 'DONE' : 'IN_PROGRESS', result: { ...m, at: new Date().toISOString(), by }, lastCheckAt: new Date().toISOString() };
  if (order.kind === 'bgv' && Object.keys(m.checks).length) {
    const before = await OB().bgvOf(order.refId);
    const cur = Object.fromEntries(((before && before.checks) || []).map((c) => [c.key, c.status]));
    const checks = { ...cur, ...m.checks };
    const v = OB().cleanBgv({ checks, vendor: order.vendor, reportLink: m.reportUrl || (before && before.reportLink) || undefined, note: m.note || (before && before.note) || undefined }, before);
    if (!v.error) await OB().saveBgv(order.refId, v.value, `${order.vendor} (vendor)`);
  }
  const out = await S.items.update(order.id, patch);
  if (m.done && order.status !== 'DONE') await logAudit({ userId: null, actorName: by, action: `${KINDS[order.kind].label} result: ${m.verdict}`, entity: 'Application', entityId: order.refId, toValue: `${order.vendor}${m.score !== undefined && m.score !== null ? ` · score ${m.score}${m.maxScore ? `/${m.maxScore}` : ''}` : ''}` });
  return out;
}

async function placeOrder(req, kind, b) {
  const cfg = await vendorConfig(kind);
  if (!cfg.ready) return { status: 409, error: `${KINDS[kind].label} vendor is not set up: an Admin adds the vendor's API address and key in Administration > Integrations (needs the founder's vendor account).`, needsFounder: true };
  const app = await prisma.application.findFirst({ where: { AND: [{ id: String(b.applicationId || '') }, applicationWhere(req.user)] }, select: { id: true, candidateId: true, candidate: { select: { name: true, email: true, phone: true } }, requirement: { select: { title: true } } } });
  if (!app) return { status: 404, error: 'That person is not in your list.' };
  if (kind === 'bgv' && b.consent !== true) return { status: 400, error: 'Tick that the candidate agreed in writing to the background check (DPDP Act 2023).' };
  const checks = kind === 'bgv' ? ((Array.isArray(b.checks) ? b.checks.map((x) => String(x).toLowerCase()).filter((x) => CHECKS.includes(x)) : []).length ? b.checks.map((x) => String(x).toLowerCase()).filter((x) => CHECKS.includes(x)) : (cfg.checks.length ? cfg.checks : CHECKS)) : null;
  const testId = kind === 'assessment' ? String(b.testId || cfg.testId || '').trim().slice(0, 80) : null;
  if (kind === 'assessment' && !testId) return { status: 400, error: 'Which test? Type the vendor\'s test ID (or set a default one in Administration > Integrations).' };
  const open = (await S.items.list('vendor-order', { refType: 'Application', refId: app.id, status: ['ORDERED', 'IN_PROGRESS'] })).find((o) => o.kind === kind);
  if (open) return { status: 409, error: `A ${KINDS[kind].label.toLowerCase()} is already running for this person (${open.vendor}).` };
  const token = crypto.randomBytes(18).toString('base64url');
  const order = await S.items.create('vendor-order', { refType: 'Application', refId: app.id, ownerId: req.user.id, status: 'ORDERED', title: `${KINDS[kind].label}: ${app.candidate.name}`, kind, vendor: cfg.vendor, checks, testId, candidateId: app.candidateId, tokenHash: sha(token), consent: kind === 'bgv' ? { by: req.user.name, at: new Date().toISOString(), note: String(b.consentNote || '').slice(0, 200) || null } : null }, req.user);
  const base = require('../offerLink').publicBase(req); // eslint-disable-line global-require
  const callbackUrl = `${base}/api/public/vendorsz/callback/${order.id}/${token}`;
  const r = await call(cfg, 'POST', '/orders', { reference: order.id, callbackUrl, candidate: app.candidate, job: app.requirement.title, ...(checks ? { checks } : {}), ...(testId ? { testId } : {}) });
  const vid = r.body && (r.body.id || r.body.orderId || r.body.referenceId || (r.body.data && (r.body.data.id || r.body.data.orderId)));
  const saved = await S.items.update(order.id, { status: r.ok ? 'IN_PROGRESS' : (r.note.startsWith('SANDBOX') ? 'ORDERED' : 'FAILED'), externalId: vid ? String(vid).slice(0, 120) : null, note: r.note, testUrl: r.body ? mapResult(kind, r.body).testUrl || null : null });
  if (r.ok && kind === 'bgv') {
    const before = await OB().bgvOf(app.id);
    const v = OB().cleanBgv({ checks: Object.fromEntries(checks.map((c) => [c, 'In progress'])), vendor: cfg.vendor }, before);
    if (!v.error) await OB().saveBgv(app.id, v.value, req.user.name);
  }
  await logAudit({ userId: req.user.id, action: `${KINDS[kind].label} ordered from ${cfg.vendor}`, entity: 'Application', entityId: app.id, toValue: `${r.note}${checks ? ` · ${checks.join(', ')}` : ''}${testId ? ` · test ${testId}` : ''}${kind === 'bgv' ? ' · consent confirmed' : ''}` });
  return { status: r.ok ? 201 : 502, order: shape(saved), note: r.note, ...(r.ok ? {} : { error: `The order did not reach ${cfg.vendor}: ${r.note}` }) };
}
const shape = (o) => (o ? { id: o.id, kind: o.kind, vendor: o.vendor, applicationId: o.refId, title: o.title, status: o.status, checks: o.checks, testId: o.testId, externalId: o.externalId || null, result: o.result || null, testUrl: o.testUrl || null, note: o.note || null, consent: o.consent || null, at: o.createdAt, lastCheckAt: o.lastCheckAt || null } : null);

async function checkNow(order) {
  const cfg = await vendorConfig(order.kind);
  if (!cfg.ready || !order.externalId) return { status: 409, error: 'The vendor is not set up, or the order has no vendor id yet.' };
  const r = await call(cfg, 'GET', `/orders/${encodeURIComponent(order.externalId)}`);
  if (!r.ok) return { status: 502, error: r.note };
  return { status: 200, order: shape(await applyResult(order, r.body, `${order.vendor} (vendor)`)) };
}
let timer = null;
function startWorker() {
  if (timer || S.sandbox()) return;
  timer = setInterval(async () => {
    try {
      const open = await S.items.list('vendor-order', { status: 'IN_PROGRESS' }, { limit: 500 });
      for (const o of open) if (o.externalId && Date.now() - new Date(o.lastCheckAt || o.createdAt).getTime() > 25 * 60000) await checkNow(o).catch(() => null); // eslint-disable-line no-await-in-loop
    } catch (e) { console.error('[vendors]', e.message); }
  }, 30 * 60000);
  if (timer.unref) timer.unref();
}

// ------------------------------------------------------------------ routes (/api/ats-plus)
const router = express.Router();
router.get('/vendorsz/status', S.internal, S.wrap(async (req, res) => {
  const out = {};
  for (const k of Object.keys(KINDS)) { const c = await vendorConfig(k); out[k] = { label: KINDS[k].label, vendor: c.vendor, ready: c.ready, checks: c.checks.length ? c.checks : CHECKS, testId: c.testId || null, setUpLink: `/admin/integrations?tab=connections&channel=${KINDS[k].channel}` }; } // eslint-disable-line no-await-in-loop
  res.json({ vendors: out, allChecks: CHECKS, canOrder: !S.viewOnly(req.user) && !req.viewAs && atsViewRole(req.user) !== 'bde', canSetUp: S.isAdmin(req.user) && !req.viewAs });
}));
router.post('/vendorsz/:kind/order', S.writer, S.wrap(async (req, res) => {
  if (!KINDS[req.params.kind]) return res.status(404).json({ error: 'Background check or assessment.' });
  if (atsViewRole(req.user) === 'bde') return res.status(403).json({ error: 'The BDE team does not order checks on candidates.' });
  const r = await placeOrder(req, req.params.kind, req.body || {});
  res.status(r.status).json(r);
}));
router.get('/vendorsz/orders', S.internal, S.wrap(async (req, res) => {
  const where = req.query.applicationId ? { refType: 'Application', refId: String(req.query.applicationId) } : {};
  const rows = await S.items.list('vendor-order', where, { limit: 500 });
  const ok = rows.length ? new Set((await prisma.application.findMany({ where: { AND: [applicationWhere(req.user), { id: { in: [...new Set(rows.map((o) => o.refId))] } }] }, select: { id: true } })).map((a) => a.id)) : new Set();
  res.json({ rows: rows.filter((o) => ok.has(o.refId)).map(shape) });
}));
router.post('/vendorsz/orders/:id/check', S.writer, S.wrap(async (req, res) => {
  const o = await S.items.get(req.params.id, 'vendor-order'); if (!o) return res.status(404).json({ error: 'Not found.' });
  if (!(await prisma.application.findFirst({ where: { AND: [{ id: o.refId }, applicationWhere(req.user)] }, select: { id: true } }))) return res.status(404).json({ error: 'Not in your list.' });
  const r = await checkNow(o);
  res.status(r.status).json(r);
}));

// the vendor's result call (public; the raw body is kept by index.js for the signature)
const publicRouter = express.Router();
const { rateLimit } = require('../publicRateLimit');
publicRouter.post('/callback/:id/:token', rateLimit({ bucket: 'vendor-callback', max: 120, windowMs: 10 * 60000 }), S.wrap(async (req, res) => {
  const o = await S.items.get(req.params.id, 'vendor-order');
  if (!o || o.tokenHash !== sha(req.params.token)) return res.status(404).json({ error: 'Unknown order.' });
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
  const cfg = await vendorConfig(o.kind);
  if (cfg.secret) {
    const sent = String(req.get('x-signature') || req.get('x-teamlink-signature') || req.get('x-hub-signature-256') || '').replace(/^sha256=/i, '').trim();
    const want = crypto.createHmac('sha256', cfg.secret).update(raw).digest('hex');
    if (!sent || sent.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(want))) return res.status(401).json({ error: 'The signature does not match.' });
  }
  let body; try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { return res.status(400).json({ error: 'Send JSON.' }); }
  await applyResult(o, body, `${o.vendor} (vendor)`);
  return res.json({ ok: true });
}));

module.exports = { router, publicRouter, mapResult, vendorConfig, startWorker, CHECKS };
