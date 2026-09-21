-- Knowledge Transfer -> AI Weekly Idea Contribution.
--
-- Plain ADD COLUMNs, hand-written. Prisma implements a column change on SQLite
-- as a table rebuild from its own fixed column list, which silently drops the
-- columns other hand-written migrations added — that has already bitten this
-- repository once. Nothing here rebuilds a table.

-- The Monday of the week the idea counts toward, so the weekly quota is a
-- straight equality filter rather than a date range computed per query.
ALTER TABLE "EmployeeRecord" ADD COLUMN "weekStart" TEXT;

-- How the idea was screened and scored. 'model' = the Anthropic model from
-- Administration -> Integrations; 'fallback' = the deterministic
-- text-similarity screen used when no key is configured. A fallback row never
-- carries scores, so the two can never be confused.
ALTER TABLE "EmployeeRecord" ADD COLUMN "aiMethod" TEXT;
ALTER TABLE "EmployeeRecord" ADD COLUMN "aiModel" TEXT;

-- Duplicate screening result.
ALTER TABLE "EmployeeRecord" ADD COLUMN "aiDuplicate" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "EmployeeRecord" ADD COLUMN "aiDuplicateOf" TEXT;
ALTER TABLE "EmployeeRecord" ADD COLUMN "aiSimilarity" INTEGER;

-- The five named criteria, plus their sum. NULL means "not scored" and the UI
-- renders it as such — never as a zero.
ALTER TABLE "EmployeeRecord" ADD COLUMN "scoreOriginality" INTEGER;
ALTER TABLE "EmployeeRecord" ADD COLUMN "scoreUsefulness" INTEGER;
ALTER TABLE "EmployeeRecord" ADD COLUMN "scoreImpact" INTEGER;
ALTER TABLE "EmployeeRecord" ADD COLUMN "scoreClarity" INTEGER;
ALTER TABLE "EmployeeRecord" ADD COLUMN "scoreFeasibility" INTEGER;
ALTER TABLE "EmployeeRecord" ADD COLUMN "scoreTotal" INTEGER;
