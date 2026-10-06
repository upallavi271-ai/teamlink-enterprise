-- Client & candidate portal logins (spec B, 2026-10-03). ADD COLUMN / CREATE TABLE only.
ALTER TABLE "User" ADD COLUMN "portalType" TEXT;
ALTER TABLE "User" ADD COLUMN "portalReviewedAt" DATETIME;
CREATE TABLE "PortalRequest" ("id" TEXT NOT NULL PRIMARY KEY, "kind" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'Pending', "clientId" TEXT, "candidateId" TEXT, "userId" TEXT, "name" TEXT, "email" TEXT, "portalType" TEXT, "reason" TEXT, "requestedById" TEXT, "requestedByName" TEXT, "decidedById" TEXT, "decidedByName" TEXT, "decidedAt" DATETIME, "decisionNote" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL);
CREATE INDEX "PortalRequest_kind_status_idx" ON "PortalRequest"("kind", "status");
CREATE INDEX "PortalRequest_clientId_idx" ON "PortalRequest"("clientId");
CREATE INDEX "PortalRequest_candidateId_idx" ON "PortalRequest"("candidateId");
