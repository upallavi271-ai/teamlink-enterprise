// ---------------------------------------------------------------------------
// VENDOR LOGIN EMAILS - SELF-PROVISIONING TABLES (2026-10-19).
//
// Same pattern as joindrop/schema.js: raw SQL tables with no Prisma model (no `prisma generate` needed), created with
// CREATE TABLE IF NOT EXISTS the first time anything needs them. The hand-written migration
// 20261019100000_vendor_login_emails holds the same statements and a rollback. Every time column is TEXT (an ISO moment).
//
//   VendorMailLog      one row per EMAIL ATTEMPT to a vendor (welcome / password reset / new-address confirmation):
//                      who it went to, the status in plain terms, the provider's words, and - SEPARATELY - when the mail
//                      server ACCEPTED it (acceptedAt) and when the provider CONFIRMED DELIVERY (deliveredAt).
//                      It never holds the link, the token or a password. (credMark = a keyed fingerprint of that attempt's temporary
//                      password, see ensure(); it cannot be turned back into the password.)
//                      dedupeKey is UNIQUE: that is the "one email per attempt" guard (a double click or an API retry
//                      cannot insert a second row, so it cannot send a second email).
//   VendorEmailChange  an email-address change waiting for the vendor to confirm it (active vendors only). Stores only the
//                      sha256 of the confirmation token. A partial unique index allows ONE pending change per login.
//
// ensure() is cheap after the first call. It never throws: a failure is logged and answered with false.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const DDL = [
  `CREATE TABLE IF NOT EXISTS "VendorMailLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vendorUserId" TEXT NOT NULL,
    "vendorId" TEXT,
    "kind" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL DEFAULT 1,
    "dedupeKey" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT,
    "status" TEXT NOT NULL DEFAULT 'sending',
    "failCode" TEXT,
    "failReason" TEXT,
    "providerDetail" TEXT,
    "providerRef" TEXT,
    "mode" TEXT,
    "tokenId" TEXT,
    "changeId" TEXT,
    "linkExpiresAt" TEXT,
    "requestedById" TEXT,
    "requestedByName" TEXT,
    "requestedVia" TEXT,
    "templateId" TEXT,
    "templateVersion" INTEGER,
    "createdAt" TEXT NOT NULL,
    "acceptedAt" TEXT,
    "deliveredAt" TEXT,
    "bouncedAt" TEXT,
    "failedAt" TEXT,
    "updatedAt" TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "VendorMailLog_dedupe" ON "VendorMailLog"("dedupeKey")',
  'CREATE INDEX IF NOT EXISTS "VendorMailLog_login" ON "VendorMailLog"("vendorUserId", "createdAt")',
  'CREATE INDEX IF NOT EXISTS "VendorMailLog_ref" ON "VendorMailLog"("providerRef")',
  `CREATE TABLE IF NOT EXISTS "VendorEmailChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vendorUserId" TEXT NOT NULL,
    "oldEmail" TEXT NOT NULL,
    "newEmail" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedById" TEXT,
    "requestedByName" TEXT,
    "createdAt" TEXT NOT NULL,
    "confirmedAt" TEXT,
    "confirmedIp" TEXT,
    "closedAt" TEXT
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "VendorEmailChange_token" ON "VendorEmailChange"("tokenHash")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "VendorEmailChange_one_pending" ON "VendorEmailChange"("vendorUserId") WHERE "status" = \'pending\'',
  'CREATE INDEX IF NOT EXISTS "VendorEmailChange_login" ON "VendorEmailChange"("vendorUserId", "createdAt")',
];

let done = null;
function ensure() {
  if (done) return done;
  done = (async () => {
    for (const sql of DDL) await prisma.$executeRawUnsafe(sql); // eslint-disable-line no-await-in-loop
    // 2026-10-19 credMark: a keyed fingerprint (HMAC, not the password) of the temporary password that THIS invitation carried. It lets the
    // sign-in say "this password was replaced by a newer email" to someone who really holds an old one. Added to an existing table here
    // (SQLite has no ADD COLUMN IF NOT EXISTS), so no migration step is needed.
    const cols = await prisma.$queryRawUnsafe('PRAGMA table_info("VendorMailLog")');
    if (!cols.some((c) => c.name === 'credMark')) await prisma.$executeRawUnsafe('ALTER TABLE "VendorMailLog" ADD COLUMN "credMark" TEXT');
    return true;
  })().catch((err) => { done = null; console.error('[vendor-mail] schema:', err.message); return false; });
  return done;
}

// For tests: forget the cached answer.
const reset = () => { done = null; };

module.exports = { ensure, reset, DDL };
