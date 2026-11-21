// ---------------------------------------------------------------------------
// SHORT, WRITE-AWARE ANSWER MEMO for the two slow list screens (load test 2026-11-18, 100,000 candidates: Clients took 2.3-3 s and
// the Progress board ~1 s of server time EACH TIME, so 100 people opening them kept the one Node thread busy for minutes).
//
//   router.get('/', memoRoute('clients'), handler)
//
// The answer of a GET is kept 10 s per (login, address, data version) and requests that arrive together share one run.
// "Data version" goes up the moment anything is written:
//   - every API request that is not a GET / HEAD / OPTIONS (before it runs and when it has finished) -> catches raw-SQL writes too,
//   - every Prisma create / update / upsert / delete on a model other than log-like noise (background jobs, imports, webhooks).
// So after someone saves, the next screen is built fresh; the 10 s only ever hides changes made by a raw-SQL background job.
// Only a 200 answer is kept. Never throws: any trouble falls back to running the handler as before.
// ---------------------------------------------------------------------------
const TTL_MS = Number(process.env.ANSWER_MEMO_TTL_MS) || 10000;
const MAX_ENTRIES = 300;
const MAX_BYTES = 120 * 1024 * 1024;
const KEEP_HEADERS = ['x-can-see-invoices'];

let version = 0;
const bump = () => { version += 1; };
const memo = new Map();
const inflight = new Map();
let bytes = 0;

// a write through the API
function writeWatcher() {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') { bump(); res.on('finish', bump); res.on('close', bump); }
    next();
  };
}
// a write made by the server itself (job, import, hook)
const WRITE = /^(create|createMany|update|updateMany|upsert|delete|deleteMany)$/;
const NOISE = /^(AuditLog|AuditEvent|Notification|LoginEvent|Session|UserSession|ApiRequestLog|ActivityLog|PageView|ErrorLog|WebhookDelivery|WebPushSubscription)$/;
function prismaHook() {
  return async (params, next) => {
    const result = await next(params);
    if (params.model && WRITE.test(params.action) && !NOISE.test(params.model)) bump();
    return result;
  };
}

function drop(key) {
  const hit = memo.get(key);
  if (hit) { bytes -= hit.body.length; memo.delete(key); }
}
function store(key, entry) {
  drop(key);
  memo.set(key, entry);
  bytes += entry.body.length;
  for (const [k] of memo) { // oldest first
    if (memo.size <= MAX_ENTRIES && bytes <= MAX_BYTES) break;
    if (k !== key) drop(k);
  }
}
function send(res, entry) {
  Object.entries(entry.headers).forEach(([k, v]) => res.set(k, v));
  res.set('X-TeamLink-Memo', 'hit');
  res.status(200).type('application/json').send(entry.body);
}

function memoRoute(tag, ttlMs = TTL_MS) {
  return (req, res, next) => {
    try {
      if (req.method !== 'GET' || !req.user) return next();
      const key = `${tag}|${req.user.id}|${version}|${req.originalUrl}`;
      const hit = memo.get(key);
      if (hit && Date.now() - hit.at < ttlMs) { memo.delete(key); memo.set(key, hit); return send(res, hit); }
      if (hit) drop(key);
      const running = inflight.get(key);
      if (running) {
        // somebody is already working this out: wait for that answer (or run it ourselves if it did not end in a 200)
        return running.then((entry) => (entry ? send(res, entry) : next()), () => next());
      }
      let settle;
      const job = new Promise((resolve) => { settle = resolve; });
      inflight.set(key, job);
      const finish = (entry) => { if (inflight.get(key) === job) inflight.delete(key); settle(entry || null); };
      // The answer still goes through the res.json wrappers mounted BEFORE this route (utils/agreementPrivacy.js agreementGuard,
      // utils/clientRedact.js, the BDE salary cut): what is kept is the text they finally send, captured at res.send.
      // (audit 2026-11-20: the memo used to send JSON.stringify(body) itself, so TL / STL / Recruiter logins got the agreement
      // fields of the Clients and Jobs lists and the BDE side the salary figures of the board.)
      const orig = res.json.bind(res);
      res.json = (body) => {
        let keep = false;
        try { keep = res.statusCode === 200 && version === Number(key.split('|')[2]); } catch { keep = false; }
        if (!keep) { finish(null); return orig(body); }
        const origSend = res.send;
        res.send = function capture(chunk) {
          res.send = origSend;
          try {
            if (res.statusCode === 200) {
              const text = typeof chunk === 'string' ? chunk : (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : JSON.stringify(chunk));
              const headers = {};
              KEEP_HEADERS.forEach((h) => { const v = res.get(h); if (v !== undefined) headers[h] = v; });
              store(key, { at: Date.now(), body: text, headers });
              finish(memo.get(key));
            } else finish(null);
          } catch { finish(null); }
          return origSend.call(this, chunk);
        };
        return orig(body);
      };
      res.on('close', () => finish(null)); // no 200 was sent (error, closed): waiting requests run themselves
      return next();
    } catch { return next(); }
  };
}

const stats = () => ({ version, entries: memo.size, bytes, running: inflight.size });
module.exports = { memoRoute, writeWatcher, prismaHook, bump, stats };
