-- ID Card Vendor Portal (2026-10-19): ADDITIVE ONLY. The same statement utils/idCardVendorSchema.js runs by itself the first time the portal needs it.
-- Which company notices (IdCardOrderEvent rows) a vendor login has read. Nothing existing is altered.

CREATE TABLE IF NOT EXISTS "IdCardVendorNoticeRead" (
  "vendorUserId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "readAt" TEXT NOT NULL,
  PRIMARY KEY ("vendorUserId", "eventId")
);
