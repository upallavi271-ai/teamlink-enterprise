-- Rollback of 20261017170000_omni_gs_external. The saved posts and campaign plans are deleted. Saved connection keys (Integration rows 'omni-*') are left in place;
-- remove them from the screens with Disconnect first if they should go too.
DROP TABLE IF EXISTS "OmniExtItem";
DROP TABLE IF EXISTS "OmniSocialPost";
