-- Fill from a file (2026-10-06): the uploaded JD / company profile a job or client was filled from. ADDITIVE: one new table.
CREATE TABLE "SourceDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "target" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "file" TEXT NOT NULL,
    "fileName" TEXT,
    "mime" TEXT,
    "size" INTEGER,
    "sha256" TEXT,
    "engine" TEXT,
    "fieldsFound" TEXT,
    "uploadedById" TEXT,
    "uploadedByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "SourceDocument_target_entityId_idx" ON "SourceDocument"("target", "entityId");
