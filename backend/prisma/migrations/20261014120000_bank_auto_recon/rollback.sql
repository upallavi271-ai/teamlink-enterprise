DROP TABLE IF EXISTS "ReconEvent";
DROP TABLE IF EXISTS "ReconProposal";
DROP TABLE IF EXISTS "ReconRun";
-- SQLite 3.35+: removes the two audit columns on BankImport.
ALTER TABLE "BankImport" DROP COLUMN "originalFile";
ALTER TABLE "BankImport" DROP COLUMN "originalName";
