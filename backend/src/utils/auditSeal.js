// ---------------------------------------------------------------------------
// TAMPER-EVIDENT AUDIT TRAIL (founder 2026-11-17, "Security first": the audit's "tamper-evident audit" gap).
//
// Every few minutes the new audit rows are SEALED into a hash chain: each row's fingerprint (SHA-256 of its fields + the
// previous row's fingerprint) is kept in "AuditSeal". Change one sealed row, or delete one, and every fingerprint from that
// point on no longer matches - verify() names the first row that breaks. The chain's head is written to the server log
// each day, so even somebody who rewrote the seal table would be caught against those lines.
//
// Size: the live trail is ~2 million rows. Sealing works in batches (2,000 rows per transaction, 20,000 per 5-minute
// tick, so the backlog is sealed over the first hours without holding the database); verify walks the chain page by page.
//   * Administration -> Audit Logs -> "Check for tampering" checks the newest 50,000 sealed rows on the spot (from a sealed
//     anchor) and shows the last FULL check;
//   * the full check of every row runs at night (02:30) and is kept in AppSetting audit.sealCheck.
//
//   seal()                 seals rows not sealed yet (oldest first)
//   verify({ last })       -> { ok, sealed, checked, brokenAt?, head }   (last = only the newest N, from the anchor before them)
//   lastFullCheck()        -> the night check's result
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

const GENESIS = 'teamlink-audit-genesis';
let READY = null;
function ensure() {
  if (!READY) {
    READY = prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "AuditSeal" ("seq" INTEGER PRIMARY KEY, "auditId" TEXT NOT NULL UNIQUE,
      "createdAt" TEXT NOT NULL, "hash" TEXT NOT NULL, "sealedAt" TEXT NOT NULL)`).catch((e) => { READY = null; throw e; });
  }
  return READY;
}
const FIELDS = ['id', 'userId', 'action', 'entity', 'entityId', 'fromValue', 'toValue', 'field', 'fieldLabel', 'reason', 'approvalStatus', 'approvedByName', 'approvedAt', 'actorName', 'createdAt'];
const iso = (v) => (v instanceof Date ? v.toISOString() : v == null ? '' : String(v));
const fingerprint = (row, prev) => crypto.createHash('sha256').update(`${prev}\u0001${FIELDS.map((f) => iso(row[f])).join('\u0001')}`).digest('hex');

let SEALING = false;
async function seal({ max = 20000, batch = 2000 } = {}) {
  if (SEALING) return { sealed: 0 };
  SEALING = true;
  try {
    await ensure();
    const [last] = await prisma.$queryRawUnsafe('SELECT "seq","hash","createdAt" FROM "AuditSeal" ORDER BY "seq" DESC LIMIT 1');
    let prev = last ? last.hash : GENESIS;
    let seq = last ? Number(last.seq) : 0;
    const since = last ? new Date(last.createdAt) : new Date(0);
    const cutoff = new Date(Date.now() - 5000); // a row being written this very second waits for the next tick
    const rows = await prisma.auditLog.findMany({ where: { createdAt: { gte: since, lte: cutoff } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: max + 500 });
    // rows with the same time as the last sealed one may already be sealed
    const sameTime = last ? new Set((await prisma.$queryRawUnsafe('SELECT "auditId" FROM "AuditSeal" WHERE "createdAt" = ?', iso(since))).map((r) => r.auditId)) : new Set();
    const todo = rows.filter((r) => !sameTime.has(r.id)).slice(0, max);
    const now = new Date().toISOString();
    for (let i = 0; i < todo.length; i += batch) {
      const part = todo.slice(i, i + batch);
      const values = []; const args = [];
      part.forEach((r) => { seq += 1; prev = fingerprint(r, prev); values.push('(?,?,?,?,?)'); args.push(seq, r.id, iso(r.createdAt), prev, now); });
      // eslint-disable-next-line no-await-in-loop
      await prisma.$executeRawUnsafe(`INSERT INTO "AuditSeal" ("seq","auditId","createdAt","hash","sealedAt") VALUES ${values.join(',')}`, ...args);
    }
    return { sealed: todo.length, head: prev, seq };
  } finally { SEALING = false; }
}

async function verify({ last = null, page = 2000 } = {}) {
  await ensure();
  const [top] = await prisma.$queryRawUnsafe('SELECT MAX("seq") AS m FROM "AuditSeal"');
  const maxSeq = Number(top && top.m) || 0;
  let from = 1; let prev = GENESIS;
  if (last && maxSeq > last) {
    from = maxSeq - last + 1;
    const [anchor] = await prisma.$queryRawUnsafe('SELECT "hash" FROM "AuditSeal" WHERE "seq" = ?', from - 1);
    prev = anchor ? anchor.hash : GENESIS;
  }
  let checked = 0;
  for (let s = from; s <= maxSeq; s += page) {
    // eslint-disable-next-line no-await-in-loop
    const seals = await prisma.$queryRawUnsafe('SELECT "seq","auditId","hash" FROM "AuditSeal" WHERE "seq" >= ? AND "seq" < ? ORDER BY "seq"', s, s + page);
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.auditLog.findMany({ where: { id: { in: seals.map((x) => x.auditId) } } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    let expect = s;
    for (const x of seals) {
      if (Number(x.seq) !== expect) return { ok: false, sealed: maxSeq, checked, brokenAt: { seq: expect, why: 'A seal is missing: the chain itself was cut.' } };
      expect += 1;
      const r = byId.get(x.auditId);
      if (!r) return { ok: false, sealed: maxSeq, checked, brokenAt: { seq: Number(x.seq), auditId: x.auditId, why: 'This audit row was deleted after it was sealed.' } };
      const h = fingerprint(r, prev);
      if (h !== x.hash) return { ok: false, sealed: maxSeq, checked, brokenAt: { seq: Number(x.seq), auditId: x.auditId, why: 'This audit row was changed after it was sealed.', action: r.action, at: iso(r.createdAt) } };
      prev = h; checked += 1;
    }
  }
  return { ok: true, sealed: maxSeq, checked, from, head: prev };
}

const CHECK_KEY = 'audit.sealCheck';
async function lastFullCheck() {
  const row = await prisma.appSetting.findUnique({ where: { key: CHECK_KEY } }).catch(() => null);
  try { return row ? JSON.parse(row.value) : null; } catch { return null; }
}
async function fullCheck() {
  const t = Date.now();
  const out = await verify();
  const v = { ...out, at: new Date().toISOString(), seconds: Math.round((Date.now() - t) / 1000) };
  await prisma.appSetting.upsert({ where: { key: CHECK_KEY }, create: { key: CHECK_KEY, value: JSON.stringify(v) }, update: { value: JSON.stringify(v) } });
  if (!out.ok) {
    try {
      const admins = await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, select: { id: true } });
      await require('./notify').notifyUsers(admins.map((a) => a.id), { title: '⚠ The audit trail was changed', message: `The night check found audit row ${out.brokenAt.seq} ${out.brokenAt.why} Open Administration → Audit Logs → Check for tampering.` }); // eslint-disable-line global-require
    } catch { /* the setting row still says it */ }
  }
  return v;
}

let TIMER = null;
function start() {
  if (require('./sandbox').isSandbox() || TIMER) return; // eslint-disable-line global-require
  let lastHeadDay = ''; let lastFullDay = '';
  const tick = async () => {
    try {
      const r = await seal();
      const ist = new Date(Date.now() + 5.5 * 3600000);
      const day = ist.toISOString().slice(0, 10);
      if (r.head && day !== lastHeadDay && r.sealed < 20000) { lastHeadDay = day; console.log(`[audit-seal] chain head ${day}: seq ${r.seq} ${r.head}`); } // eslint-disable-line no-console
      // the full walk once a night after 02:30 IST, when the backlog is sealed
      if (day !== lastFullDay && (ist.getUTCHours() > 2 || (ist.getUTCHours() === 2 && ist.getUTCMinutes() >= 30)) && ist.getUTCHours() < 6 && r.sealed < 20000) {
        lastFullDay = day;
        const v = await fullCheck();
        console.log(`[audit-seal] full check ${v.ok ? 'OK' : 'BROKEN'}: ${v.checked} rows in ${v.seconds}s`); // eslint-disable-line no-console
      }
    } catch (e) { console.error('[audit-seal]', e.message); } // eslint-disable-line no-console
  };
  setTimeout(tick, 90000).unref?.();
  TIMER = setInterval(tick, 5 * 60000);
  if (TIMER.unref) TIMER.unref();
}

module.exports = { seal, verify, fullCheck, lastFullCheck, start, fingerprint };
