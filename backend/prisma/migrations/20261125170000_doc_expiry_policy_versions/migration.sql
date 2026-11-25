-- CreateTable
CREATE TABLE "TrackedDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT NOT NULL,
    "employeeCode" TEXT,
    "employeeName" TEXT NOT NULL,
    "department" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "documentId" TEXT,
    "issuedOn" DATETIME,
    "expiresOn" DATETIME,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "remindState" TEXT,
    "history" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PolicyVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "policyId" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "effectiveOn" DATETIME NOT NULL,
    "requireReack" BOOLEAN NOT NULL DEFAULT false,
    "recordedByName" TEXT,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PolicyRegister" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "policyId" TEXT NOT NULL,
    "reviewEveryMonths" INTEGER,
    "ownerName" TEXT,
    "lastReviewedOn" DATETIME,
    "nextReviewOn" DATETIME,
    "remindState" TEXT,
    "history" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PolicyAckVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "policyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "acknowledgedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "TrackedDocument_employeeId_idx" ON "TrackedDocument"("employeeId");

-- CreateIndex
CREATE INDEX "TrackedDocument_status_expiresOn_idx" ON "TrackedDocument"("status", "expiresOn");

-- CreateIndex
CREATE INDEX "PolicyVersion_policyId_idx" ON "PolicyVersion"("policyId");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyVersion_policyId_versionNo_key" ON "PolicyVersion"("policyId", "versionNo");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyRegister_policyId_key" ON "PolicyRegister"("policyId");

-- CreateIndex
CREATE INDEX "PolicyAckVersion_policyId_idx" ON "PolicyAckVersion"("policyId");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyAckVersion_policyId_employeeId_versionNo_key" ON "PolicyAckVersion"("policyId", "employeeId", "versionNo");

