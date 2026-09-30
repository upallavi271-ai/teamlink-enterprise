-- Payroll -> Accounts integration (SPEC B). Hand-written and ADDITIVE only:
-- new nullable / defaulted columns and new tables. No existing column is
-- dropped or retyped, and no index is removed, so SalaryStructure keeps its
-- one-row-per-employee UNIQUE and every existing reader keeps working.
--
--   SalaryStructure            stays the CURRENT version (a mirror of the
--                              latest SalaryStructureVersion row).
--   SalaryStructureVersion     every version, effectiveFrom / effectiveTo.
--   PayrollAttendance          HR's per-employee monthly attendance override.
--   EmployeePayrollRun         one payroll record per employee per month,
--                              DRAFT -> PENDING_APPROVAL -> APPROVED ->
--                              SYNCED_TO_ACCOUNTS -> PAID.
--   PayrollSyncLog             HRMS -> Accounts delivery log (retry / errors).
--   LedgerAccount              minimal chart of accounts (Accounts module).
--   JournalEntry / JournalLine the ledger (Accounts module).

-- ---- Salary structure: the current version carries its dates + new components
ALTER TABLE "SalaryStructure" ADD COLUMN "effectiveFrom" TEXT;
ALTER TABLE "SalaryStructure" ADD COLUMN "effectiveTo" TEXT;
ALTER TABLE "SalaryStructure" ADD COLUMN "esiApplicable" BOOLEAN;
ALTER TABLE "SalaryStructure" ADD COLUMN "esiEmployee" REAL NOT NULL DEFAULT 0;
ALTER TABLE "SalaryStructure" ADD COLUMN "esiEmployer" REAL NOT NULL DEFAULT 0;
ALTER TABLE "SalaryStructure" ADD COLUMN "tds" REAL;
ALTER TABLE "SalaryStructure" ADD COLUMN "otherDeductions" REAL NOT NULL DEFAULT 0;
ALTER TABLE "SalaryStructure" ADD COLUMN "currentVersionId" TEXT;

CREATE TABLE "SalaryStructureVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT NOT NULL,
    "effectiveFrom" TEXT NOT NULL,
    "effectiveTo" TEXT,
    "payMode" TEXT NOT NULL DEFAULT 'Package',
    "ctc" REAL NOT NULL DEFAULT 0,
    "stipend" REAL NOT NULL DEFAULT 0,
    "basic" REAL NOT NULL DEFAULT 0,
    "hra" REAL NOT NULL DEFAULT 0,
    "bonus" REAL NOT NULL DEFAULT 0,
    "specialAllowance" REAL NOT NULL DEFAULT 0,
    "employerPf" REAL NOT NULL DEFAULT 0,
    "employeePf" REAL NOT NULL DEFAULT 0,
    "professionalTax" REAL NOT NULL DEFAULT 0,
    "gratuity" REAL NOT NULL DEFAULT 0,
    "esiApplicable" BOOLEAN,
    "esiEmployee" REAL NOT NULL DEFAULT 0,
    "esiEmployer" REAL NOT NULL DEFAULT 0,
    "tds" REAL,
    "otherDeductions" REAL NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SalaryStructureVersion_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SalaryStructureVersion_employeeId_effectiveFrom_key" ON "SalaryStructureVersion"("employeeId", "effectiveFrom");

-- Every existing structure becomes its employee's first (open-ended) version.
INSERT INTO "SalaryStructureVersion" (
    "id", "employeeId", "effectiveFrom", "effectiveTo", "payMode", "ctc", "stipend", "basic", "hra", "bonus",
    "specialAllowance", "employerPf", "employeePf", "professionalTax", "gratuity", "note", "updatedAt"
)
SELECT 'ssv' || lower(hex(randomblob(11))), "employeeId", '2000-01-01', NULL, "payMode", "ctc", "stipend", "basic", "hra", "bonus",
       "specialAllowance", "employerPf", "employeePf", "professionalTax", "gratuity", 'Migrated from the single salary structure', CURRENT_TIMESTAMP
FROM "SalaryStructure";
UPDATE "SalaryStructure" SET
    "effectiveFrom" = '2000-01-01',
    "currentVersionId" = (SELECT v."id" FROM "SalaryStructureVersion" v WHERE v."employeeId" = "SalaryStructure"."employeeId" AND v."effectiveFrom" = '2000-01-01');

-- ---- Statutory settings: ESI and TDS are configurable
ALTER TABLE "HrConfig" ADD COLUMN "esiEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "HrConfig" ADD COLUMN "esiEmployeePct" REAL NOT NULL DEFAULT 0.75;
ALTER TABLE "HrConfig" ADD COLUMN "esiEmployerPct" REAL NOT NULL DEFAULT 3.25;
ALTER TABLE "HrConfig" ADD COLUMN "esiGrossCeiling" REAL NOT NULL DEFAULT 21000;
ALTER TABLE "HrConfig" ADD COLUMN "tdsDefaultPctOfGross" REAL NOT NULL DEFAULT 0;

-- ---- Payslip: the extra deduction lines and the run it came from
ALTER TABLE "Payslip" ADD COLUMN "esiEmployee" REAL DEFAULT 0;
ALTER TABLE "Payslip" ADD COLUMN "esiEmployer" REAL DEFAULT 0;
ALTER TABLE "Payslip" ADD COLUMN "tds" REAL DEFAULT 0;
ALTER TABLE "Payslip" ADD COLUMN "otherDeductions" REAL DEFAULT 0;
ALTER TABLE "Payslip" ADD COLUMN "payrollEntryId" TEXT;

-- ---- Monthly attendance input: HR's override (the default is computed live)
CREATE TABLE "PayrollAttendance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "monthNum" INTEGER NOT NULL,
    "workingDays" REAL NOT NULL DEFAULT 0,
    "daysPresent" REAL NOT NULL DEFAULT 0,
    "daysLop" REAL NOT NULL DEFAULT 0,
    "autoDaysPresent" REAL,
    "autoDaysLop" REAL,
    "reason" TEXT,
    "overriddenBy" TEXT,
    "overriddenByName" TEXT,
    "overriddenAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PayrollAttendance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PayrollAttendance_employeeId_month_key" ON "PayrollAttendance"("employeeId", "month");

-- ---- One payroll record per employee per month
CREATE TABLE "EmployeePayrollRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT NOT NULL,
    "payrollRunId" TEXT,
    "month" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "monthNum" INTEGER NOT NULL,
    "salaryVersionId" TEXT,
    "payMode" TEXT NOT NULL DEFAULT 'Package',
    "workingDays" REAL NOT NULL DEFAULT 0,
    "daysPresent" REAL NOT NULL DEFAULT 0,
    "daysLop" REAL NOT NULL DEFAULT 0,
    "attendanceSource" TEXT NOT NULL DEFAULT 'ATTENDANCE',
    "basic" REAL NOT NULL DEFAULT 0,
    "hra" REAL NOT NULL DEFAULT 0,
    "bonus" REAL NOT NULL DEFAULT 0,
    "specialAllowance" REAL NOT NULL DEFAULT 0,
    "grossPay" REAL NOT NULL DEFAULT 0,
    "lopDeduction" REAL NOT NULL DEFAULT 0,
    "earnedGross" REAL NOT NULL DEFAULT 0,
    "pfEmployee" REAL NOT NULL DEFAULT 0,
    "esiEmployee" REAL NOT NULL DEFAULT 0,
    "professionalTax" REAL NOT NULL DEFAULT 0,
    "tds" REAL NOT NULL DEFAULT 0,
    "otherDeductions" REAL NOT NULL DEFAULT 0,
    "totalDeductions" REAL NOT NULL DEFAULT 0,
    "netPay" REAL NOT NULL DEFAULT 0,
    "pfEmployer" REAL NOT NULL DEFAULT 0,
    "esiEmployer" REAL NOT NULL DEFAULT 0,
    "gratuity" REAL NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "payslipId" TEXT,
    "calculatedBy" TEXT,
    "calculatedAt" DATETIME,
    "submittedBy" TEXT,
    "submittedAt" DATETIME,
    "approvedBy" TEXT,
    "approvedAt" DATETIME,
    "syncedAt" DATETIME,
    "journalEntryId" TEXT,
    "paidBy" TEXT,
    "paidAt" DATETIME,
    "paymentJournalEntryId" TEXT,
    "bankTransactionId" TEXT,
    "paymentReference" TEXT,
    "rejectionReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EmployeePayrollRun_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EmployeePayrollRun_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EmployeePayrollRun_employeeId_month_key" ON "EmployeePayrollRun"("employeeId", "month");
CREATE INDEX "EmployeePayrollRun_month_status_idx" ON "EmployeePayrollRun"("month", "status");

-- ---- HRMS -> Accounts delivery log
CREATE TABLE "PayrollSyncLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL DEFAULT 'ACCRUAL',
    "employeePayrollRunId" TEXT NOT NULL,
    "employeeId" TEXT,
    "month" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastAttemptAt" DATETIME,
    "nextAttemptAt" DATETIME,
    "payload" TEXT,
    "journalEntryId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "PayrollSyncLog_idempotencyKey_key" ON "PayrollSyncLog"("idempotencyKey");
CREATE INDEX "PayrollSyncLog_status_idx" ON "PayrollSyncLog"("status");

-- ---- Accounts: chart of accounts + journal
CREATE TABLE "LedgerAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "aliases" TEXT,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "LedgerAccount_code_key" ON "LedgerAccount"("code");
CREATE UNIQUE INDEX "LedgerAccount_name_key" ON "LedgerAccount"("name");

INSERT INTO "LedgerAccount" ("id", "code", "name", "type", "aliases", "description", "isSystem") VALUES
    ('la_bank',        '1100', 'Bank',                    'ASSET',     NULL,                        'Company bank account(s) — salary disbursements are credited here', true),
    ('la_payable_emp', '2100', 'Payable to Employee',     'LIABILITY', 'Bank/Payable to Employee',  'Net salary owed to employees until the bank payment is made', true),
    ('la_pf',          '2210', 'PF Payable',              'LIABILITY', NULL,                        'Employee + employer provident fund due to EPFO', true),
    ('la_esi',         '2220', 'ESI Payable',             'LIABILITY', NULL,                        'Employee + employer ESI due to ESIC', true),
    ('la_tds',         '2230', 'TDS Payable',             'LIABILITY', NULL,                        'Tax deducted at source from salaries (Sec 192)', true),
    ('la_pt',          '2240', 'PT Payable',              'LIABILITY', NULL,                        'Professional tax due to the state', true),
    ('la_other_ded',   '2250', 'Other Deductions Payable','LIABILITY', NULL,                        'Other salary deductions / recoveries held for settlement', true),
    ('la_salary_exp',  '5100', 'Salary Expense',          'EXPENSE',   NULL,                        'Earned gross salary plus employer PF / ESI', true);

CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "narration" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "referenceType" TEXT,
    "referenceId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "employeeId" TEXT,
    "employeeName" TEXT,
    "totalDebit" REAL NOT NULL DEFAULT 0,
    "totalCredit" REAL NOT NULL DEFAULT 0,
    "payload" TEXT,
    "createdBy" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "JournalEntry_idempotencyKey_key" ON "JournalEntry"("idempotencyKey");
CREATE INDEX "JournalEntry_month_idx" ON "JournalEntry"("month");
CREATE INDEX "JournalEntry_referenceType_referenceId_idx" ON "JournalEntry"("referenceType", "referenceId");

CREATE TABLE "JournalLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "journalEntryId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL DEFAULT 0,
    "accountId" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "debit" REAL NOT NULL DEFAULT 0,
    "credit" REAL NOT NULL DEFAULT 0,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "memo" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JournalLine_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "JournalLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LedgerAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "JournalLine_journalEntryId_idx" ON "JournalLine"("journalEntryId");
CREATE INDEX "JournalLine_accountCode_idx" ON "JournalLine"("accountCode");
