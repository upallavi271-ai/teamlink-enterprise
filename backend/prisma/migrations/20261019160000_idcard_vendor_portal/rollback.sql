-- Rollback of 20261019160000_idcard_vendor_portal: forgets which notices were read. No order, line or event is touched.
DROP TABLE IF EXISTS "IdCardVendorNoticeRead";
