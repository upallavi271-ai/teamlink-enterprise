-- Payroll import (2026-10-06): the registers' Conveyance / Arrears lines and the imported breakup. ADDITIVE ONLY (defaulted / nullable columns).
ALTER TABLE "EmployeePayrollRun" ADD COLUMN "conveyance" REAL NOT NULL DEFAULT 0;
ALTER TABLE "EmployeePayrollRun" ADD COLUMN "arrears" REAL NOT NULL DEFAULT 0;
ALTER TABLE "EmployeePayrollRun" ADD COLUMN "importedBreakup" TEXT;
ALTER TABLE "EmployeePayrollRun" ADD COLUMN "importNote" TEXT;
ALTER TABLE "Payslip" ADD COLUMN "conveyance" REAL DEFAULT 0;
ALTER TABLE "Payslip" ADD COLUMN "arrears" REAL DEFAULT 0;
ALTER TABLE "Payslip" ADD COLUMN "importedBreakup" TEXT;
ALTER TABLE "SalaryStructureVersion" ADD COLUMN "conveyance" REAL NOT NULL DEFAULT 0;
ALTER TABLE "SalaryStructure" ADD COLUMN "conveyance" REAL NOT NULL DEFAULT 0;
