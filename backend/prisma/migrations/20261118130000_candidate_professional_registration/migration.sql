-- Professional registration of a candidate (ATS audit 2026-11-18, Q274-Q276 / Q280): the medical / nursing / pharmacy / dental council
-- registration a doctor, nurse or pharmacist must hold, and whether TeamLink has verified it. ADD COLUMN only (the SQLite rule in README).
ALTER TABLE "Candidate" ADD COLUMN "registrationCouncil" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "registrationNumber" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "registrationState" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "registrationValidTill" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "registrationStatus" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "registrationVerifiedAt" DATETIME;
ALTER TABLE "Candidate" ADD COLUMN "registrationVerifiedBy" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "registrationNote" TEXT;
