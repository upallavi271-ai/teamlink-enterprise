// ---------------------------------------------------------------------------
// ID CARD VENDOR PORTAL - SELF-PROVISIONING TABLE (2026-10-19). Same pattern as vendorMailSchema.js / assetVendorSchema.js:
// raw SQL, CREATE TABLE IF NOT EXISTS, additive only, hand-written migration 20261019160000_idcard_vendor_portal holds the same statement + rollback.
//
//   IdCardVendorNoticeRead   which notices (an IdCardOrderEvent the COMPANY wrote, e.g. "order placed") one vendor login has read.
//                            Primary key (vendorUserId, eventId): a notice can be marked read once, never twice (no duplicates).
// The notices themselves are not stored: they are the existing IdCardOrderEvent rows of the vendor's own orders.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const DDL = [
  `CREATE TABLE IF NOT EXISTS "IdCardVendorNoticeRead" (
    "vendorUserId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "readAt" TEXT NOT NULL,
    PRIMARY KEY ("vendorUserId", "eventId")
  )`,
];

let done = null;
function ensure() {
  if (done) return done;
  done = (async () => {
    for (const sql of DDL) await prisma.$executeRawUnsafe(sql); // eslint-disable-line no-await-in-loop
    return true;
  })().catch((err) => { done = null; console.error('[idcard-vendor-portal] schema:', err.message); return false; });
  return done;
}
const reset = () => { done = null; };
module.exports = { ensure, reset, DDL };
