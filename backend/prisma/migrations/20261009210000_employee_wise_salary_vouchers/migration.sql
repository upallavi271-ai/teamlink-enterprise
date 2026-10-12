-- ACCOUNTS: EMPLOYEE-WISE SALARY IN THE JOURNAL (user spec 2026-10-09).
-- ADDITIVE ONLY: nullable columns on JournalEntry / JournalLine, two new tables,
-- new indexes. No existing row is rewritten, nothing is dropped or retyped.
-- Undo: rollback.sql in this folder (drops exactly what is added here).
--
--   JournalEntry.voucherType / payrollRunId   Payroll | Payment | Payroll adjustment, and the PayrollRun it belongs to
--   JournalLine.employeeId / employeeName / department / payrollRunId   who a salary line is for
--   PayrollVoucherEmployee   one row per payroll (or adjustment) voucher x employee: the employee-wise table + paid status
--   PayrollVoucherPayment    one row per payment voucher x employee: amount, paid on, mode, UTR / reference

ALTER TABLE "JournalEntry" ADD COLUMN "voucherType" TEXT;
ALTER TABLE "JournalEntry" ADD COLUMN "payrollRunId" TEXT;
CREATE INDEX "JournalEntry_payrollRunId_idx" ON "JournalEntry"("payrollRunId");
CREATE INDEX "JournalEntry_voucherType_idx" ON "JournalEntry"("voucherType");

ALTER TABLE "JournalLine" ADD COLUMN "employeeId" TEXT;
ALTER TABLE "JournalLine" ADD COLUMN "employeeName" TEXT;
ALTER TABLE "JournalLine" ADD COLUMN "department" TEXT;
ALTER TABLE "JournalLine" ADD COLUMN "payrollRunId" TEXT;
CREATE INDEX "JournalLine_employeeId_idx" ON "JournalLine"("employeeId");
CREATE INDEX "JournalLine_payrollRunId_idx" ON "JournalLine"("payrollRunId");

CREATE TABLE "PayrollVoucherEmployee" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "journalEntryId" TEXT NOT NULL,
    "payrollRunId" TEXT,
    "month" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'PAYROLL',
    "employeeId" TEXT NOT NULL,
    "employeeCode" TEXT,
    "employeeName" TEXT NOT NULL,
    "department" TEXT,
    "entryId" TEXT,
    "payslipId" TEXT,
    "fullGross" REAL NOT NULL DEFAULT 0,
    "lossOfPay" REAL NOT NULL DEFAULT 0,
    "earnedGross" REAL NOT NULL DEFAULT 0,
    "pf" REAL NOT NULL DEFAULT 0,
    "esi" REAL NOT NULL DEFAULT 0,
    "tds" REAL NOT NULL DEFAULT 0,
    "professionalTax" REAL NOT NULL DEFAULT 0,
    "otherDeductions" REAL NOT NULL DEFAULT 0,
    "registerDifference" REAL NOT NULL DEFAULT 0,
    "netPay" REAL NOT NULL DEFAULT 0,
    "employerPf" REAL NOT NULL DEFAULT 0,
    "employerEsi" REAL NOT NULL DEFAULT 0,
    "payStatus" TEXT NOT NULL DEFAULT 'UNPAID',
    "paidAmount" REAL NOT NULL DEFAULT 0,
    "paidOn" TEXT,
    "payMode" TEXT,
    "payRef" TEXT,
    "paymentJournalEntryId" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "PayrollVoucherEmployee_journalEntryId_employeeId_key" ON "PayrollVoucherEmployee"("journalEntryId", "employeeId");
CREATE INDEX "PayrollVoucherEmployee_employeeId_month_idx" ON "PayrollVoucherEmployee"("employeeId", "month");
CREATE INDEX "PayrollVoucherEmployee_payrollRunId_idx" ON "PayrollVoucherEmployee"("payrollRunId");
CREATE INDEX "PayrollVoucherEmployee_month_payStatus_idx" ON "PayrollVoucherEmployee"("month", "payStatus");

CREATE TABLE "PayrollVoucherPayment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "journalEntryId" TEXT NOT NULL,
    "accrualEntryId" TEXT,
    "payrollRunId" TEXT,
    "month" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "employeeName" TEXT NOT NULL,
    "amount" REAL NOT NULL DEFAULT 0,
    "paidOn" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'Bank transfer',
    "reference" TEXT,
    "bankAccountId" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "PayrollVoucherPayment_journalEntryId_employeeId_key" ON "PayrollVoucherPayment"("journalEntryId", "employeeId");
CREATE INDEX "PayrollVoucherPayment_employeeId_month_idx" ON "PayrollVoucherPayment"("employeeId", "month");
CREATE INDEX "PayrollVoucherPayment_payrollRunId_idx" ON "PayrollVoucherPayment"("payrollRunId");
