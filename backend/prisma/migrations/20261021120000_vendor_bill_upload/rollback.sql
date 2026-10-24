-- Rollback of 20261021120000_vendor_bill_upload. Deletes the uploaded-bill records, their table rows and their history.
-- Bills that were already APPROVED into Accounts (VendorBillSubmission / OfficeExpense) and repair figures written into AssetRepair are NOT touched.
-- The stored bill files stay in the upload folder.
DROP TRIGGER IF EXISTS "VendorBillUploadEvent_append_only_upd";
DROP TRIGGER IF EXISTS "VendorBillUploadEvent_append_only_del";
DROP TABLE IF EXISTS "VendorBillUploadEvent";
DROP TABLE IF EXISTS "VendorBillUploadLine";
DROP TABLE IF EXISTS "VendorBillUpload";
