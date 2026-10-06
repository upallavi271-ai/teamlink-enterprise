-- B8 matching: Fit score version + explanation, override audit, semantic vector cache.
-- ADD COLUMN only + ONE NEW TABLE. No existing table is rebuilt. No data change.

-- 1. Every stored Fit records its scoring version ("fit-v3"; NULL = v1, before
--    versioning) and the explanation (JSON: weights used, reasons, gaps,
--    eligible / why not, minimum Fit, semantic part).
ALTER TABLE "Application" ADD COLUMN "matchVersion" TEXT;
ALTER TABLE "Application" ADD COLUMN "matchDetail" TEXT;

-- 2. "Added by override": an INELIGIBLE candidate added to a job needs a reason.
ALTER TABLE "Application" ADD COLUMN "overrideReason" TEXT;
ALTER TABLE "Application" ADD COLUMN "overrideAt" DATETIME;
ALTER TABLE "Application" ADD COLUMN "overrideById" TEXT;
ALTER TABLE "Application" ADD COLUMN "overrideByName" TEXT;
CREATE INDEX "Application_overrideAt_idx" ON "Application"("overrideAt");

-- 3. Cache of AI embedding vectors (Ollama embeddings, only when the semantic
--    switch is on AND the AI engine is chosen). One row per candidate / job per model;
--    recomputed when the text hash changes. The local (offline) engine needs no rows.
CREATE TABLE "SemanticVector" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "dims" INTEGER NOT NULL,
    "vector" BLOB NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "SemanticVector_kind_refId_model_key" ON "SemanticVector"("kind", "refId", "model");
