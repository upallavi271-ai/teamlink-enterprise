// ---------------------------------------------------------------------------
// INVOICE ON HOLD (ATS audit 752, founder 2026-11-17): a client disputes a bill -> Accounts puts the invoice ON HOLD with the reason.
// The invoice keeps its status (Pending / Overdue ... - every report still adds up); the hold, its reason, who and when are shown
// on the invoice and returned with the register rows (`hold`), audited on and off. Raw table "InvoiceHold" (no migration).
// ---------------------------------------------------------------------------
const prisma = require('../db');

let READY = null;
function ensure() {
  if (!READY) {
    READY = prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "InvoiceHold" ("invoiceId" TEXT PRIMARY KEY, "reason" TEXT NOT NULL, "byName" TEXT, "at" TEXT NOT NULL)')
      .catch((e) => { READY = null; throw e; });
  }
  return READY;
}
async function mapOf(ids) {
  await ensure();
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return new Map();
  const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "InvoiceHold" WHERE "invoiceId" IN (${list.map(() => '?').join(',')})`, ...list);
  return new Map(rows.map((r) => [r.invoiceId, { reason: r.reason, byName: r.byName, at: r.at }]));
}
async function of(id) { return (await mapOf([id])).get(id) || null; }
async function put(id, reason, byName) {
  await ensure();
  await prisma.$executeRawUnsafe('INSERT INTO "InvoiceHold" ("invoiceId","reason","byName","at") VALUES (?,?,?,?) ON CONFLICT("invoiceId") DO UPDATE SET "reason"=excluded."reason","byName"=excluded."byName","at"=excluded."at"',
    String(id), String(reason).trim().slice(0, 500), byName || null, new Date().toISOString());
}
async function release(id) {
  await ensure();
  await prisma.$executeRawUnsafe('DELETE FROM "InvoiceHold" WHERE "invoiceId" = ?', String(id));
}
async function heldIds() {
  await ensure();
  return new Set((await prisma.$queryRawUnsafe('SELECT "invoiceId" FROM "InvoiceHold"')).map((r) => r.invoiceId));
}

module.exports = { ensure, mapOf, of, put, release, heldIds };
