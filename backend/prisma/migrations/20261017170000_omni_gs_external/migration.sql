-- Omni-Channel external-service shells (2026-10-17): saved social posts (never published) and campaign plans (nothing created at Meta / Google).
-- Raw-SQL tables, no Prisma model; the app also creates them itself with IF NOT EXISTS (outreach/external.js ensure()).
-- The connection keys are NOT here: they live encrypted in the existing Integration table (ids omni-shopify, omni-meta-social, omni-meta-ads, omni-fb-catalog, omni-google-ads, omni-google-analytics).
CREATE TABLE IF NOT EXISTS "OmniSocialPost" ("id" TEXT NOT NULL PRIMARY KEY, "postNumber" INTEGER NOT NULL DEFAULT 0, "platforms" TEXT NOT NULL DEFAULT '[]', "text" TEXT NOT NULL DEFAULT '', "mediaUrl" TEXT, "organization" TEXT, "settings" TEXT, "status" TEXT NOT NULL DEFAULT 'notsent', "scheduledAt" DATETIME, "department" TEXT, "createdById" TEXT, "createdByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "deletedAt" DATETIME);
CREATE INDEX IF NOT EXISTS "OmniSocialPost_status" ON "OmniSocialPost"("status", "createdAt");
CREATE TABLE IF NOT EXISTS "OmniExtItem" ("id" TEXT NOT NULL PRIMARY KEY, "kind" TEXT NOT NULL, "name" TEXT NOT NULL, "budget" REAL, "data" TEXT, "department" TEXT, "createdById" TEXT, "createdByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "deletedAt" DATETIME);
CREATE INDEX IF NOT EXISTS "OmniExtItem_kind" ON "OmniExtItem"("kind", "createdAt");
