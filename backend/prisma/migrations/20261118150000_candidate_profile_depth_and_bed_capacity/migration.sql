-- ATS audit 2026-11-18 batch 1 (Q48 / Q53 / Q273 / Q282 / Q285 / Q278): more of the candidate's own details and the hospital bed
-- capacity of a client. ADD COLUMN only (the SQLite rule in README).
ALTER TABLE "Candidate" ADD COLUMN "alternatePhone" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "address" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "nativePlace" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "maritalStatus" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "languagesKnown" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "superSpecialization" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "eligibilityTests" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "machineryExperience" TEXT;
ALTER TABLE "Client" ADD COLUMN "bedCapacity" INTEGER;
