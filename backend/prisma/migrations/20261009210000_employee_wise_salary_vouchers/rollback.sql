-- ROLLBACK for 20261009210000_employee_wise_salary_vouchers (run only after a backup; SQLite >= 3.35).
-- Prisma does not run this file. Apply with the sqlite3 shell or node, then
-- delete the migration's row from _prisma_migrations. Journal entries booked
-- employee-wise keep their lines (the employee columns are lost, the amounts stay).
DROP TABLE IF EXISTS "PayrollVoucherPayment";
DROP TABLE IF EXISTS "PayrollVoucherEmployee";
DROP INDEX IF EXISTS "JournalLine_employeeId_idx";
DROP INDEX IF EXISTS "JournalLine_payrollRunId_idx";
DROP INDEX IF EXISTS "JournalEntry_payrollRunId_idx";
DROP INDEX IF EXISTS "JournalEntry_voucherType_idx";
ALTER TABLE "JournalLine" DROP COLUMN "employeeId";
ALTER TABLE "JournalLine" DROP COLUMN "employeeName";
ALTER TABLE "JournalLine" DROP COLUMN "department";
ALTER TABLE "JournalLine" DROP COLUMN "payrollRunId";
ALTER TABLE "JournalEntry" DROP COLUMN "voucherType";
ALTER TABLE "JournalEntry" DROP COLUMN "payrollRunId";
