-- HRMS spec items 15 + 18 (2026-10-03). ADD COLUMN / CREATE TABLE only — nothing rebuilt, no data touched.
-- Suggested folder: backend/prisma/migrations/20261003160000_hrms_custom_fields_active_masters/migration.sql

-- Item 18: a Department / Team can be switched off (hidden from every dropdown) without deleting it.
ALTER TABLE "Department" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Team" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;

-- Item 15: Employee Management -> Manage Fields. Plain scalars (no FK), like ApprovalStep.
CREATE TABLE "EmployeeField" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "options" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "minValue" REAL,
    "maxValue" REAL,
    "maxLength" INTEGER,
    "helpText" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "EmployeeField_key_key" ON "EmployeeField"("key");

CREATE TABLE "EmployeeFieldValue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fieldId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "value" TEXT,
    "fileStored" TEXT,
    "fileName" TEXT,
    "fileMime" TEXT,
    "fileSize" INTEGER,
    "updatedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "EmployeeFieldValue_fieldId_employeeId_key" ON "EmployeeFieldValue"("fieldId", "employeeId");
CREATE INDEX "EmployeeFieldValue_employeeId_idx" ON "EmployeeFieldValue"("employeeId");
