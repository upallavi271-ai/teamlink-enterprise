-- Omni-Channel v3 (2026-10-17): the Library (saved files and links), capture Forms (public, with consent text) and their submissions.
-- Raw-SQL tables, no Prisma model; the app also creates them itself with IF NOT EXISTS (outreach/v3schema.js).
-- COLUMNS ARE NOT IN THIS FILE ON PURPOSE: SQLite has no ADD COLUMN IF NOT EXISTS, and the app adds them itself on first use (guarded by PRAGMA table_info),
-- so an ALTER here would fail with "duplicate column" once the app has run. The columns the app adds (all nullable, nothing is removed or changed):
--   OutreachContact   language, preferredChannel, notes, lastReplyAt, customValues
--   OutreachCampaign  meta, approval, perMinute, kind
--   OutreachMessage   repliedAt, callMinutes
--   OutreachSegment   refreshedAt
--   OutreachTemplate  category
CREATE TABLE IF NOT EXISTS "OmniLibrary" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "kind" TEXT NOT NULL DEFAULT 'file', "mime" TEXT, "size" INTEGER NOT NULL DEFAULT 0, "stored" TEXT, "linkUrl" TEXT, "token" TEXT, "department" TEXT, "note" TEXT, "createdById" TEXT, "createdByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "deletedAt" DATETIME);
CREATE UNIQUE INDEX IF NOT EXISTS "OmniLibrary_token" ON "OmniLibrary"("token");
CREATE TABLE IF NOT EXISTS "OmniForm" ("id" TEXT NOT NULL PRIMARY KEY, "token" TEXT NOT NULL, "name" TEXT NOT NULL, "department" TEXT, "industry" TEXT, "fields" TEXT NOT NULL DEFAULT '[]', "channels" TEXT NOT NULL DEFAULT '["whatsapp","email"]', "consentText" TEXT NOT NULL, "thanks" TEXT, "status" TEXT NOT NULL DEFAULT 'on', "createdById" TEXT, "createdByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0, "deletedAt" DATETIME);
CREATE UNIQUE INDEX IF NOT EXISTS "OmniForm_token" ON "OmniForm"("token");
CREATE TABLE IF NOT EXISTS "OmniFormSubmission" ("id" TEXT NOT NULL PRIMARY KEY, "formId" TEXT NOT NULL, "contactId" TEXT, "result" TEXT NOT NULL, "at" DATETIME NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS "OmniFormSubmission_form" ON "OmniFormSubmission"("formId", "at");
