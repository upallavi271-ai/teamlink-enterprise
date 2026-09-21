-- clireq: Clients / Requirements / Agreements module depth.
--
-- HAND-WRITTEN AND DELIBERATELY ADDITIVE. Every statement is a plain
-- `ALTER TABLE ... ADD COLUMN` (plus two unique indexes). SQLite has no
-- ALTER COLUMN, so Prisma implements even a default-value change as a
-- create-new-table / copy / drop-old-table rebuild, and that rebuild silently
-- drops columns added by other migrations in this repo. It has already caused
-- one real data-loss bug here, so this migration never rebuilds a table.

-- ---------------------------------------------------------------------------
-- Client: profile depth for the Client Detail Overview tab.
-- ---------------------------------------------------------------------------
ALTER TABLE "Client" ADD COLUMN "clientCode" TEXT;
ALTER TABLE "Client" ADD COLUMN "billingContactName" TEXT;
ALTER TABLE "Client" ADD COLUMN "billingContactDesignation" TEXT;
ALTER TABLE "Client" ADD COLUMN "billingContactEmail" TEXT;
ALTER TABLE "Client" ADD COLUMN "billingContactPhone" TEXT;
ALTER TABLE "Client" ADD COLUMN "recruitmentContactName" TEXT;
ALTER TABLE "Client" ADD COLUMN "recruitmentContactDesignation" TEXT;
ALTER TABLE "Client" ADD COLUMN "recruitmentContactEmail" TEXT;
ALTER TABLE "Client" ADD COLUMN "recruitmentContactPhone" TEXT;

-- ---------------------------------------------------------------------------
-- Client: agreement workflow depth.
--   Draft -> Sent -> Viewed -> Client Confirmation Pending -> Signed -> Active
--   with Expired and Rejected as terminal states.
-- ---------------------------------------------------------------------------
ALTER TABLE "Client" ADD COLUMN "agreementSource" TEXT DEFAULT 'Generated';
ALTER TABLE "Client" ADD COLUMN "agreementConfirmationRequestedAt" DATETIME;
ALTER TABLE "Client" ADD COLUMN "agreementRejectedAt" DATETIME;
ALTER TABLE "Client" ADD COLUMN "agreementRejectedReason" TEXT;
ALTER TABLE "Client" ADD COLUMN "agreementSignedCopyName" TEXT;
ALTER TABLE "Client" ADD COLUMN "agreementSignedCopyNote" TEXT;

-- Reconcile the status vocabulary in place: CONFIRMED became SIGNED.
UPDATE "Client" SET "agreementStatus" = 'SIGNED' WHERE "agreementStatus" = 'CONFIRMED';

-- ---------------------------------------------------------------------------
-- Requirement: human-readable id, the assignment chain and portal sync.
-- tlId / stlId / recruiterIds are plain TEXT scalars with no foreign key, so
-- this stays ADD COLUMN only.
-- ---------------------------------------------------------------------------
ALTER TABLE "Requirement" ADD COLUMN "reqCode" TEXT;
ALTER TABLE "Requirement" ADD COLUMN "tlId" TEXT;
ALTER TABLE "Requirement" ADD COLUMN "stlId" TEXT;
ALTER TABLE "Requirement" ADD COLUMN "recruiterIds" TEXT;
ALTER TABLE "Requirement" ADD COLUMN "targetDate" TEXT;
ALTER TABLE "Requirement" ADD COLUMN "accountManager" TEXT;
ALTER TABLE "Requirement" ADD COLUMN "portalSyncStatus" TEXT DEFAULT 'Not Synced';

-- Backfill the assignment chain from the names the old form recorded, so the
-- scope filter has something to work with on an existing database.
UPDATE "Requirement"
   SET "tlId" = (SELECT "u"."id" FROM "User" "u" WHERE "u"."name" = "Requirement"."tl" LIMIT 1)
 WHERE "tl" IS NOT NULL AND "tl" <> '' AND "tlId" IS NULL;
UPDATE "Requirement"
   SET "stlId" = (SELECT "u"."id" FROM "User" "u" WHERE "u"."name" = "Requirement"."stl" LIMIT 1)
 WHERE "stl" IS NOT NULL AND "stl" <> '' AND "stlId" IS NULL;

CREATE UNIQUE INDEX "Client_clientCode_key" ON "Client"("clientCode");
CREATE UNIQUE INDEX "Requirement_reqCode_key" ON "Requirement"("reqCode");
