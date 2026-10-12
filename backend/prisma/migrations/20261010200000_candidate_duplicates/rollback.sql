-- Undo 20261010200000_candidate_duplicates (drops the six tables and their data; no existing table is touched).
DROP TABLE IF EXISTS "CandidateAlias";
DROP TABLE IF EXISTS "CandidateMergeLog";
DROP TABLE IF EXISTS "CandidateDupFlag";
DROP TABLE IF EXISTS "CandidateDupSig";
DROP TABLE IF EXISTS "CandidateDupKey";
