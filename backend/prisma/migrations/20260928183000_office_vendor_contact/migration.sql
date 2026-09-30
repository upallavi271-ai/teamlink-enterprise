-- Office & Expenses → "Add Vendor". Additive only: six nullable columns on the
-- vendor master, no existing row is changed. The GST / Tax ID reuses "gstin".
ALTER TABLE "OfficeVendor" ADD COLUMN "contactPerson" TEXT;
ALTER TABLE "OfficeVendor" ADD COLUMN "phone" TEXT;
ALTER TABLE "OfficeVendor" ADD COLUMN "email" TEXT;
ALTER TABLE "OfficeVendor" ADD COLUMN "address" TEXT;
ALTER TABLE "OfficeVendor" ADD COLUMN "paymentTerms" TEXT;
ALTER TABLE "OfficeVendor" ADD COLUMN "notes" TEXT;
