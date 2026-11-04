-- Candidate interested / not interested from the recruiters' import sheets (2026-11-04). Additive only.
-- Rollback: the two columns can stay (nothing reads them when absent from the code).
ALTER TABLE "Candidate" ADD COLUMN "interestStatus" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "interestAt" DATETIME;
