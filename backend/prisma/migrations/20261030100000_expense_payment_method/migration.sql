-- Expense claims: how the employee wants to be paid (founder 2026-10-30: "expense & claims lo payment options add chey QR,
-- Phone Numbers, Bank Details"). Nullable columns on EmployeeRecord: every other record type is unaffected.
--   payMethod            QR | PHONE | BANK
--   payPhone             the UPI / phone number, proved by an SMS code (payPhoneVerifiedAt)
--   payBank              the bank account on the employee's profile when the claim was made, masked for display
--   payQr*               the uploaded UPI QR image (stored like the bill, outside the repository: utils/attachments.js)
ALTER TABLE "EmployeeRecord" ADD COLUMN "payMethod" TEXT;
ALTER TABLE "EmployeeRecord" ADD COLUMN "payPhone" TEXT;
ALTER TABLE "EmployeeRecord" ADD COLUMN "payPhoneVerifiedAt" DATETIME;
ALTER TABLE "EmployeeRecord" ADD COLUMN "payBank" TEXT;
ALTER TABLE "EmployeeRecord" ADD COLUMN "payQrFile" TEXT;
ALTER TABLE "EmployeeRecord" ADD COLUMN "payQrName" TEXT;
ALTER TABLE "EmployeeRecord" ADD COLUMN "payQrMime" TEXT;
ALTER TABLE "EmployeeRecord" ADD COLUMN "payQrSize" INTEGER;
