// ---------------------------------------------------------------------------
// BI CONNECTOR (12.15, 2026-11-21) - a READ-ONLY reporting feed for Power BI, Looker Studio, Excel "From web" or any tool
// that reads a web address.
//
//   GET /api/bi/v1/<feed>.json | .csv      feed = jobs | applications | joinings | clients
//   the key: header "X-API-Key: <key>" (or "Authorization: Bearer <key>", or ?key=<key> for tools that only take an address)
//
// An Admin makes a key (Reports -> Build & data -> BI feed); it is shown ONCE and only its SHA-256 hash is stored. A key
// can be limited to some feeds and revoked any time. 120 calls an hour per key. The rows are the company-wide report rows
// (the same counting as Reports) and carry NO candidate name, phone, e-mail, salary or document - ids, steps, dates, sources.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../../db');
const C = require('./core');
const M = require('./metrics');
const { logAudit } = require('../audit');

const FEEDS = ['jobs', 'applications', 'joinings', 'clients'];
const LIMIT = 120;
const WINDOW = 3600000;
const hits = new Map();
const hash = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');

async function list() {
  await C.ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT "id","label","keyTail","feeds","createdByName","createdAt","revokedAt","revokedByName","lastUsedAt","uses" FROM "AtsBiKey" ORDER BY "createdAt" DESC');
  return rows.map((r) => ({ ...r, uses: Number(r.uses || 0), feeds: String(r.feeds || FEEDS.join(',')).split(',').filter(Boolean), active: !r.revokedAt }));
}
async function create(user, body = {}) {
  await C.ensure();
  const label = String(body.label || '').trim().slice(0, 80);
  if (label.length < 3) return { status: 400, error: 'Name the key after the tool or person that uses it (for example "Power BI - founder").' };
  const feeds = (Array.isArray(body.feeds) && body.feeds.length ? body.feeds : FEEDS).filter((f) => FEEDS.includes(f));
  if (!feeds.length) return { status: 400, error: 'Pick at least one feed.' };
  const live = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "AtsBiKey" WHERE "revokedAt" IS NULL');
  if (Number(live[0].n) >= 10) return { status: 400, error: 'There are 10 keys in use. Revoke one first.' };
  const key = `tlbi_${crypto.randomBytes(24).toString('base64url')}`;
  const id = C.newId('bik');
  await prisma.$executeRawUnsafe('INSERT INTO "AtsBiKey" ("id","label","keyHash","keyTail","feeds","createdById","createdByName","createdAt") VALUES (?,?,?,?,?,?,?,?)',
    id, label, hash(key), key.slice(-4), feeds.join(','), user.id, user.name || null, new Date().toISOString());
  await logAudit({ userId: user.id, actorName: user.name, action: 'BI feed key created', entity: 'AtsBiKey', entityId: id, toValue: `${label} - feeds: ${feeds.join(', ')}` });
  return { ok: true, id, key, feeds };
}
async function revoke(user, id) {
  await C.ensure();
  const n = await prisma.$executeRawUnsafe('UPDATE "AtsBiKey" SET "revokedAt" = ?, "revokedByName" = ? WHERE "id" = ? AND "revokedAt" IS NULL', new Date().toISOString(), user.name || null, String(id));
  if (!n) return { status: 404, error: 'That key is gone or already revoked.' };
  await logAudit({ userId: user.id, actorName: user.name, action: 'BI feed key revoked', entity: 'AtsBiKey', entityId: String(id) });
  return { ok: true };
}

// The key on a request -> the key row, or { status, error }.
async function check(req) {
  const h = req.headers || {};
  const auth = String(h.authorization || '');
  const key = String(h['x-api-key'] || (auth.startsWith('Bearer ') ? auth.slice(7) : '') || (req.query && req.query.key) || '').trim();
  if (!key) return { status: 401, error: 'Send the key in the X-API-Key header (or ?key=).' };
  await C.ensure();
  const [row] = await prisma.$queryRawUnsafe('SELECT * FROM "AtsBiKey" WHERE "keyHash" = ?', hash(key));
  if (!row || row.revokedAt) return { status: 401, error: 'This key is not valid or was revoked.' };
  const now = Date.now();
  let hit = hits.get(row.id);
  if (!hit || now - hit.start > WINDOW) { hit = { start: now, n: 0 }; hits.set(row.id, hit); }
  hit.n += 1;
  if (hit.n > LIMIT) return { status: 429, error: `At most ${LIMIT} calls an hour per key. Try again later.`, retry: Math.ceil((hit.start + WINDOW - now) / 1000) };
  await prisma.$executeRawUnsafe('UPDATE "AtsBiKey" SET "lastUsedAt" = ?, "uses" = "uses" + 1 WHERE "id" = ?', new Date().toISOString(), row.id);
  return { row, feeds: String(row.feeds || FEEDS.join(',')).split(',') };
}

async function feed(name) {
  const sys = await require('../atsWork/targets').systemViewer(); // eslint-disable-line global-require
  if (!sys) return { headers: [], rows: [] };
  const ctx = await C.ctxFor(sys, {});
  const step = (x) => (x.pipe && x.pipe.label) || x.a.stage;
  if (name === 'jobs') {
    const filled = new Map();
    ctx.apps.forEach((x) => { if (x.joined) filled.set(x.req.id, (filled.get(x.req.id) || 0) + 1); });
    const headers = ['requirement_id', 'requirement_code', 'title', 'client', 'department', 'status', 'openings', 'filled', 'location', 'added_on', 'days_open'];
    return { headers, rows: ctx.reqs.map((r) => [r.id, r.reqCode || '', r.title || '', r.clientName, r.department || '', M.LIVE.includes(r.status) ? 'Open' : r.status === 'CLOSED' ? 'Closed' : r.status, Number(r.openings) || 1, filled.get(r.id) || 0, r.location || '', C.istDay(r.createdAt), r.ageDays]) };
  }
  if (name === 'applications') {
    const headers = ['application_id', 'requirement_id', 'requirement_code', 'client', 'department', 'step', 'source', 'recruiter', 'added_on', 'sent_to_client_on', 'interview_on', 'offer_status', 'joining_status', 'joined', 'joined_on'];
    return {
      headers,
      rows: ctx.apps.map((x) => [x.id, x.req.id, x.req.reqCode || '', x.req.clientName, x.req.department || '', step(x), x.source || '', (x.recruiter && x.recruiter.label) || '', C.istDay(x.a.createdAt),
        x.crossedAt && x.crossedAt.shared ? C.istDay(x.crossedAt.shared) : '', C.istDay(x.a.interviewAt) || '', x.a.offerStatus || '', x.a.joiningStatus || '', x.joined ? 'yes' : 'no', C.joinDayOf(x) || '']),
    };
  }
  if (name === 'joinings') {
    const headers = ['application_id', 'requirement_id', 'requirement_code', 'client', 'department', 'recruiter', 'source', 'joined_on', 'days_to_fill', 'days_to_hire'];
    return {
      headers,
      rows: ctx.apps.filter((x) => x.joined).map((x) => {
        const d = C.joinDayOf(x);
        return [x.id, x.req.id, x.req.reqCode || '', x.req.clientName, x.req.department || '', (x.recruiter && x.recruiter.label) || '', x.source || '', d || '',
          d ? C.dayDiff(C.istDay(x.req.createdAt), d) : '', d ? C.dayDiff(C.istDay(x.a.createdAt), d) : ''];
      }),
    };
  }
  if (name === 'clients') {
    const per = new Map();
    ctx.reqs.forEach((r) => { if (r.internal) return; const p = per.get(r.clientId) || { reqs: 0, open: 0, joined: 0 }; p.reqs += 1; if (M.LIVE.includes(r.status)) p.open += 1; per.set(r.clientId, p); });
    ctx.apps.forEach((x) => { if (x.joined && !x.req.internal) { const p = per.get(x.req.clientId); if (p) p.joined += 1; } });
    const cl = await prisma.client.findMany({ select: { id: true, name: true, clientCode: true, industry: true, location: true, status: true, clientType: true, ownerDepartment: true, createdAt: true } });
    const headers = ['client_id', 'client_code', 'name', 'industry', 'location', 'status', 'client_type', 'department', 'added_on', 'requirements', 'open_requirements', 'joined'];
    return { headers, rows: cl.map((c) => { const p = per.get(c.id) || { reqs: 0, open: 0, joined: 0 }; return [c.id, c.clientCode || '', c.name || '', c.industry || '', c.location || '', c.status || '', c.clientType || '', c.ownerDepartment || '', C.istDay(c.createdAt), p.reqs, p.open, p.joined]; }) };
  }
  return null;
}

module.exports = { FEEDS, list, create, revoke, check, feed, LIMIT };
