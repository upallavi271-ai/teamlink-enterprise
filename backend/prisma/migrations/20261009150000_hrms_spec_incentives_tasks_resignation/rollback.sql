-- Undo of 20261009150000_hrms_spec_incentives_tasks_resignation (values in the new columns / tables are lost).
DROP TABLE IF EXISTS "IncentiveAward";
DROP TABLE IF EXISTS "IncentiveRule";
DROP INDEX IF EXISTS "Task_priority_idx";
DROP INDEX IF EXISTS "Task_endDate_idx";
ALTER TABLE "Task" DROP COLUMN "priority";
ALTER TABLE "Task" DROP COLUMN "overdueRemindedOn";
ALTER TABLE "ResignationDetail" DROP COLUMN "resignationTime";
ALTER TABLE "ResignationDetail" DROP COLUMN "source";
ALTER TABLE "ResignationDetail" DROP COLUMN "importBatch";
