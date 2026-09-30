-- Payslip layout + Standard Package salary rules (hand-written, additive).

-- Bonus is now a fixed monthly amount (default Rs 1,000).
ALTER TABLE "HrConfig" ADD COLUMN "bonusFixedMonthly" REAL NOT NULL DEFAULT 1000;

-- The payslip prints Days Worked and a Loss of Pay deduction line.
ALTER TABLE "Payslip" ADD COLUMN "workingDays" REAL DEFAULT 0;
ALTER TABLE "Payslip" ADD COLUMN "lopDeduction" REAL DEFAULT 0;

-- Standard Package: Basic is 40% of CTC. Only a row still on the old 50%
-- default is moved; a value HR set deliberately is left alone.
UPDATE "HrConfig" SET "basicPctOfCtc" = 40 WHERE "basicPctOfCtc" = 50;
