-- Rollback of 20261019180000_vendor_asset_grants. Deletes only Admin's "assets this vendor can see" choices; no company asset is touched.
-- (After this, an asset vendor sees again only what the asset list itself links to it: Asset.vendorId, the "bought from" name, its repairs.)
DROP TABLE IF EXISTS "VendorAssetGrant";
