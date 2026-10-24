-- Rollback of 20261019100000_vendor_login_emails (the email log and the pending email changes are deleted; nothing else is touched)
DROP TABLE IF EXISTS "VendorEmailChange";
DROP TABLE IF EXISTS "VendorMailLog";
