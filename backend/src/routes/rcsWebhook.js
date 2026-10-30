// ---------------------------------------------------------------------------
// POST /api/webhooks/rcs?token=<RCS_WEBHOOK_SECRET> — rcssms.in calls US here (founder's spec point 5). Public, no login: the token proves it.
//
//   * The RAW payload is kept FIRST (the last 50, AppSetting rcs.webhook.raw; shown on Administration > Integrations > RCS), because the
//     provider has NOT confirmed its delivery-report format. Read flexibly: JSON, a form or query fields; one object, a list, {data:[...]}.
//   * A template answer {templateid, status} -> rcs_templates.status (APPROVED / REJECTED / PENDING).
//   * A delivery report {msgid, status} -> rcs_message_logs by msgid. delivered / read -> delivered; failed / undelivered / rejected /
//     expired -> failed (+ the SMS fallback when it is switched on). A status never goes backwards: a delivered message stays delivered.
//     The same report twice changes nothing.
//   * ALWAYS answers 200 (a wrong token too: nothing is applied or kept then, only counted).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const express = require('express');
const prisma = require('../db');

const router = express.Router();
const keep = (req, _res, buf) => { req.rawBody = buf; };
router.use(express.json({ limit: '1mb', verify: keep, type: ['application/json', 'application/*+json'] }));
router.use(express.urlencoded({ extended: false, limit: '1mb', verify: keep }));
router.use(express.text({ limit: '1mb', type: () => true, verify: keep }));

const RAW_KEY = 'rcs.webhook.raw';
const BAD_KEY = 'rcs.webhook.rejected';
const RAW_MAX = 50;
const safeEq = (a, b) => {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

const DELIVERED = new Set(['delivered', 'delivrd', 'read', 'seen', 'displayed']);
const FAILED = new Set(['failed', 'fail', 'undelivered', 'undeliv', 'rejected', 'rejectd', 'expired', 'error', 'blocked', 'notdelivered']);
const SENT = new Set(['sent', 'submitted', 'accepted', 'acceptd', 'enroute', 'pending', 'queued', 'success']);
const word = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z]/g, '');
const TPL_STATUS = { approved: 'APPROVED', approve: 'APPROVED', active: 'APPROVED', rejected: 'REJECTED', reject: 'REJECTED', declined: 'REJECTED', pending: 'PENDING', submitted: 'PENDING', inreview: 'PENDING' };

// Every object in the payload that may be a report: the body itself, a list, or a list under data / messages / reports / statuses.
function objectsOf(body, query) {
  let b = body;
  if (typeof b === 'string') {
    let t = b.trim();
    const j = parse(t, null);
    if (typeof j === 'string') t = j.trim(); // a JSON string that holds form fields
    b = j && typeof j === 'object' ? j : Object.fromEntries(new URLSearchParams(t));
  }
  const out = [];
  const take = (x) => {
    if (Array.isArray(x)) { x.forEach(take); return; }
    if (!x || typeof x !== 'object') return;
    const inner = ['data', 'messages', 'reports', 'statuses', 'dlr', 'results'].map((k) => x[k]).find((v) => Array.isArray(v) || (v && typeof v === 'object'));
    if (inner) take(inner);
    out.push(x);
  };
  take(b);
  const q = { ...(query || {}) }; delete q.token;
  if (Object.keys(q).length) out.push(q);
  return out.map((o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [String(k).toLowerCase().replace(/[^a-z0-9]/g, ''), Array.isArray(v) ? v[0] : v])));
}

async function keepRaw(req) {
  const row = await prisma.appSetting.findUnique({ where: { key: RAW_KEY } }).catch(() => null);
  const list = parse(row && row.value, []);
  const text = req.rawBody ? req.rawBody.toString('utf8') : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
  const q = { ...req.query }; delete q.token;
  list.unshift({ at: new Date().toISOString(), contentType: String(req.get('content-type') || '').slice(0, 80), query: Object.keys(q).length ? q : undefined, body: text.slice(0, 4000) });
  const v = JSON.stringify(list.slice(0, RAW_MAX));
  await prisma.appSetting.upsert({ where: { key: RAW_KEY }, create: { key: RAW_KEY, value: v }, update: { value: v } }).catch(() => {});
}

async function apply(objs) {
  const done = { templates: 0, delivered: 0, failed: 0, unchanged: 0, unknown: 0 };
  const failedIds = [];
  for (const o of objs) {
    const msgid = String(o.msgid || o.messageid || o.msgidd || o.mid || o.requestid || '').split(',')[0].trim();
    const tplId = String(o.templateid || o.templatecode || '').trim();
    const st = word(o.dlrstatus ?? o.deliverystatus ?? o.status ?? o.event ?? o.state ?? o.templatestatus);
    if (!msgid && tplId) {
      const status = TPL_STATUS[st];
      if (!status) { done.unknown += 1; continue; } // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const r = await prisma.rcsTemplate.updateMany({ where: { templateId: tplId, NOT: { status } }, data: { status } });
      if (r.count) done.templates += r.count; else done.unchanged += 1;
      continue; // eslint-disable-line no-continue
    }
    if (!msgid) { done.unknown += 1; continue; } // eslint-disable-line no-continue
    const to = DELIVERED.has(st) ? 'delivered' : FAILED.has(st) ? 'failed' : SENT.has(st) ? 'sent' : null;
    if (!to) { done.unknown += 1; continue; } // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const logs = await prisma.rcsMessageLog.findMany({ where: { msgId: msgid } });
    if (!logs.length) { done.unknown += 1; continue; } // eslint-disable-line no-continue
    const number = String(o.msisdn || o.mobile || o.number || o.to || '').replace(/\D/g, '');
    for (const l of logs) {
      // a report naming another number is not this message's
      if (number && !l.msisdn.endsWith(number.slice(-10))) { done.unknown += 1; continue; } // eslint-disable-line no-continue
      if (l.status === 'delivered' || l.status === to || to === 'sent') { done.unchanged += 1; continue; } // eslint-disable-line no-continue
      const reason = String(o.reason || o.errordesc || o.description || o.error || '').slice(0, 300) || null;
      const code = o.errorcode || o.code || null;
      // eslint-disable-next-line no-await-in-loop
      await prisma.rcsMessageLog.update({
        where: { id: l.id },
        data: to === 'delivered'
          ? { status: 'delivered', deliveredAt: new Date(), errorCode: null, errorText: null }
          : { status: 'failed', errorCode: code ? String(code).slice(0, 20) : 'DLR', errorText: `rcssms.in report: ${reason || st}`.slice(0, 500) },
      });
      if (to === 'delivered') done.delivered += 1; else { done.failed += 1; failedIds.push(l.id); }
    }
  }
  if (failedIds.length) require('../utils/rcsQueue').fallbackFor(failedIds, 'RCS report: not delivered').catch(() => {}); // eslint-disable-line global-require
  return done;
}

const hits = [];
function rateOk() {
  const now = Date.now();
  while (hits.length && now - hits[0] > 60000) hits.shift();
  hits.push(now);
  return hits.length <= (Number(process.env.RCS_WEBHOOK_PER_MINUTE) || 1200);
}

async function handle(req, res) {
  try {
    const secret = String(process.env.RCS_WEBHOOK_SECRET || '').trim();
    if (!rateOk()) return res.status(200).json({ ok: false, reason: 'busy' });
    if (!secret || !safeEq(req.query.token, secret)) {
      await prisma.appSetting.upsert({ where: { key: BAD_KEY }, create: { key: BAD_KEY, value: new Date().toISOString() }, update: { value: new Date().toISOString() } }).catch(() => {});
      return res.status(200).json({ ok: false });
    }
    await keepRaw(req);
    const done = await apply(objectsOf(req.body, req.query));
    return res.status(200).json({ ok: true, ...done });
  } catch (e) {
    console.error('[rcs-webhook]', String(e && e.message).slice(0, 200)); // eslint-disable-line no-console
    return res.status(200).json({ ok: false });
  }
}
router.post('/', handle);
// a body the parsers cannot read (bad JSON, wrong content type) is still kept and read as text: the provider always gets 200
router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  req.body = req.rawBody ? req.rawBody.toString('utf8') : '';
  return handle(req, res);
});
router.get('/', handle); // some providers call a report address with GET and query fields

module.exports = router;
module.exports.RAW_KEY = RAW_KEY;
module.exports.BAD_KEY = BAD_KEY;
module.exports.objectsOf = objectsOf;
