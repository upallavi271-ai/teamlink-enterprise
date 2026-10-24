-- Omni-Channel Green Start rebuild, CRM pages (2026-10-17): CRM Fields, All Customers, Segments, Web Forms.
-- Raw-SQL only, no Prisma model. The app also makes everything below itself on first use (outreach/forms.js, outreach/v3schema.js), so this file is safe to run before
-- or after the app has run (CREATE TABLE IF NOT EXISTS only; the two tables already exist from 20261017100000_omni_v3_library_forms and are repeated here so a database that
-- skipped that folder still gets them).
-- COLUMNS ARE NOT IN THIS FILE ON PURPOSE (SQLite has no ADD COLUMN IF NOT EXISTS; the app adds them guarded by PRAGMA table_info, nullable, nothing removed):
--   OmniForm  description TEXT, memberIds TEXT (JSON list of the staff who may open the form's data)     <- outreach/forms.js ensure()
-- Settings kept in AppSetting (no table): omni.customFields (CRM Fields), omni.segmentCounts ("Counted at" snapshots of the Segments cards).
CREATE TABLE IF NOT EXISTS "OmniForm" ("id" TEXT NOT NULL PRIMARY KEY, "token" TEXT NOT NULL, "name" TEXT NOT NULL, "department" TEXT, "industry" TEXT, "fields" TEXT NOT NULL DEFAULT '[]', "channels" TEXT NOT NULL DEFAULT '["whatsapp","email"]', "consentText" TEXT NOT NULL, "thanks" TEXT, "status" TEXT NOT NULL DEFAULT 'on', "createdById" TEXT, "createdByName" TEXT, "createdAt" INTEGER NOT NULL DEFAULT 0, "updatedAt" INTEGER NOT NULL DEFAULT 0, "deletedAt" INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS "OmniForm_token" ON "OmniForm"("token");
CREATE TABLE IF NOT EXISTS "OmniFormSubmission" ("id" TEXT NOT NULL PRIMARY KEY, "formId" TEXT NOT NULL, "contactId" TEXT, "result" TEXT NOT NULL, "at" INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS "OmniFormSubmission_form" ON "OmniFormSubmission"("formId", "at");
CREATE INDEX IF NOT EXISTS "OmniFormSubmission_contact" ON "OmniFormSubmission"("contactId");
