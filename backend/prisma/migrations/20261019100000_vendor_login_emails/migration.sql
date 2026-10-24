-- Vendor login emails (2026-10-19): the log of every welcome / password-reset / new-address email sent to a vendor (accepted vs delivered kept apart) and the pending email-address changes.
-- ADDITIVE ONLY: two new tables and their indexes; nothing existing is altered. The app also creates them itself with IF NOT EXISTS (src/utils/vendorMailSchema.js), so this file can be applied before or after the first run.
-- The log never holds a link, a token or a password. Undo: rollback.sql.
CREATE TABLE IF NOT EXISTS "VendorMailLog" ("id" TEXT NOT NULL PRIMARY KEY, "vendorUserId" TEXT NOT NULL, "vendorId" TEXT, "kind" TEXT NOT NULL, "attemptNo" INTEGER NOT NULL DEFAULT 1, "dedupeKey" TEXT NOT NULL, "toEmail" TEXT NOT NULL, "subject" TEXT, "status" TEXT NOT NULL DEFAULT 'sending', "failCode" TEXT, "failReason" TEXT, "providerDetail" TEXT, "providerRef" TEXT, "mode" TEXT, "tokenId" TEXT, "changeId" TEXT, "linkExpiresAt" TEXT, "requestedById" TEXT, "requestedByName" TEXT, "requestedVia" TEXT, "templateId" TEXT, "templateVersion" INTEGER, "createdAt" TEXT NOT NULL, "acceptedAt" TEXT, "deliveredAt" TEXT, "bouncedAt" TEXT, "failedAt" TEXT, "updatedAt" TEXT NOT NULL );
CREATE UNIQUE INDEX IF NOT EXISTS "VendorMailLog_dedupe" ON "VendorMailLog"("dedupeKey");
CREATE INDEX IF NOT EXISTS "VendorMailLog_login" ON "VendorMailLog"("vendorUserId", "createdAt");
CREATE INDEX IF NOT EXISTS "VendorMailLog_ref" ON "VendorMailLog"("providerRef");
CREATE TABLE IF NOT EXISTS "VendorEmailChange" ("id" TEXT NOT NULL PRIMARY KEY, "vendorUserId" TEXT NOT NULL, "oldEmail" TEXT NOT NULL, "newEmail" TEXT NOT NULL, "tokenHash" TEXT NOT NULL, "expiresAt" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending', "requestedById" TEXT, "requestedByName" TEXT, "createdAt" TEXT NOT NULL, "confirmedAt" TEXT, "confirmedIp" TEXT, "closedAt" TEXT );
CREATE UNIQUE INDEX IF NOT EXISTS "VendorEmailChange_token" ON "VendorEmailChange"("tokenHash");
CREATE UNIQUE INDEX IF NOT EXISTS "VendorEmailChange_one_pending" ON "VendorEmailChange"("vendorUserId") WHERE "status" = 'pending';
CREATE INDEX IF NOT EXISTS "VendorEmailChange_login" ON "VendorEmailChange"("vendorUserId", "createdAt");
