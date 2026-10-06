-- Specialisation master (spec_ 2026-10-03). ADD COLUMN / CREATE TABLE only:
-- no existing table is rebuilt.
ALTER TABLE "Specialisation" ADD COLUMN "qualificationId" TEXT;
ALTER TABLE "Specialisation" ADD COLUMN "isMaster" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Specialisation" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Specialisation" ADD COLUMN "aliases" TEXT;
ALTER TABLE "Specialisation" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Specialisation" ADD COLUMN "updatedAt" DATETIME;
CREATE INDEX "Specialisation_qualificationId_idx" ON "Specialisation"("qualificationId");

CREATE TABLE "Qualification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "aliases" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME,
    CONSTRAINT "Qualification_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Qualification_departmentId_name_key" ON "Qualification"("departmentId", "name");

CREATE TABLE "SpecialisationSuggestion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "departmentId" TEXT,
    "qualificationId" TEXT,
    "specialisationId" TEXT,
    "confidence" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "sourceText" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "SpecialisationSuggestion_entityType_entityId_key" ON "SpecialisationSuggestion"("entityType", "entityId");
CREATE INDEX "SpecialisationSuggestion_status_idx" ON "SpecialisationSuggestion"("status");
CREATE INDEX "SpecialisationSuggestion_specialisationId_idx" ON "SpecialisationSuggestion"("specialisationId");

ALTER TABLE "Requirement" ADD COLUMN "qualificationId" TEXT;
ALTER TABLE "Requirement" ADD COLUMN "specialisationId" TEXT;
CREATE INDEX "Requirement_specialisationId_idx" ON "Requirement"("specialisationId");

ALTER TABLE "Candidate" ADD COLUMN "qualificationId" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "specialisationId" TEXT;
CREATE INDEX "Candidate_specialisationId_idx" ON "Candidate"("specialisationId");
