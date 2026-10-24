-- Rollback of 20261019200000_vendor_import_export_sync. Drops only the complaint-to-repair link and the import-run log.
-- The complaint tickets (EmployeeRecord) and any repair already made from one stay as they are; no company asset is touched.
-- Optional clean-up of Admin's hide choices:  DELETE FROM "VendorAssetGrant" WHERE "kind" IN ('exclude_asset','exclude_category');
DROP TABLE IF EXISTS "AssetComplaint";
DROP TABLE IF EXISTS "VendorImportRun";
