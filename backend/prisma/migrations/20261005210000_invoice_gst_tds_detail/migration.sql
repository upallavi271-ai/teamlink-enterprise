-- P4 Invoices GST & TDS detail (additive, nullable; older invoices keep NULL and are derived on read)
ALTER TABLE "Invoice" ADD COLUMN "gstType" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "tdsBase" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "tdsSection" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "tdsDeductedOn" TEXT;
