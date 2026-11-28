-- Who paid an office expense from their own money, and the day it was sent back to them. Both optional.
ALTER TABLE "OfficeExpense" ADD COLUMN "paidByPerson" TEXT;
ALTER TABLE "OfficeExpense" ADD COLUMN "personSettledOn" TEXT;
