-- AlterTable: a company that buys only digital marketing (made by AI Marketing > Client plans > Client login) is kept out of every ATS client list
ALTER TABLE "Client" ADD COLUMN "marketingOnly" BOOLEAN NOT NULL DEFAULT false;

-- A company made by that button BEFORE this column existed is a marketing-only record too: hide it from ATS
UPDATE "Client" SET "marketingOnly" = 1
WHERE "id" IN (
  SELECT "entityId" FROM "AuditLog"
  WHERE "entity" = 'Client' AND "action" = 'Client created' AND "toValue" LIKE 'Made from AI Marketing > Client plans%' AND "entityId" IS NOT NULL
);
