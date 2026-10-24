-- Rollback of 20261019150000_assets_vendor_portal. Deletes the vendor-side repair links, the brand / model / condition notes and the vendor repair history.
-- The company's own Asset and AssetRepair rows (including the final cost, GST and invoice no. a vendor entered there) are NOT touched.
DROP TRIGGER IF EXISTS "AssetRepairEvent_append_only_upd";
DROP TRIGGER IF EXISTS "AssetRepairEvent_append_only_del";
DROP TABLE IF EXISTS "AssetRepairEvent";
DROP TABLE IF EXISTS "AssetRepairBill";
DROP TABLE IF EXISTS "AssetRepairVendor";
DROP TABLE IF EXISTS "AssetVendorInfo";
