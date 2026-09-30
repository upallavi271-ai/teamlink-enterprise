-- employee_identity_verification
--
-- THE EMPLOYEE PROVES THEIR OWN MOBILE AND AADHAAR, AFTER THEY SIGN IN.
--
-- HR creates the account with an email and a password; everything else about
-- the person is entered by the person. Verification belongs on the same side
-- of that line: HR typing somebody's Aadhaar number and ticking "verified"
-- verifies nothing.
--
-- THE FULL AADHAAR NUMBER IS NEVER STORED. Section 29 of the Aadhaar Act and
-- the UIDAI circulars forbid an unauthenticated entity retaining it. The same
-- rule the client agreement flow already follows applies here: the number is
-- validated (12 digits, no leading 0/1, Verhoeff checksum), used, and dropped.
-- What is kept is the LAST FOUR DIGITS for display and the eSign provider's
-- TRANSACTION ID, which is what actually proves the signature.
--
-- Employee.aadhaarNumber is left in place because things read it, but nothing
-- writes it any more. It is empty on all 290 existing rows, so no migration of
-- data is needed — only the discipline from here on.
--
-- THE OTP IS HASHED, with an expiry and an attempt counter. A plaintext OTP
-- column would make the database a way to pass verification.
--
-- SQLite has no ALTER COLUMN, so these are plain ADD COLUMNs. Every one is
-- nullable (or defaulted), so existing rows are untouched and valid.

ALTER TABLE "Employee" ADD COLUMN "aadhaarLast4" TEXT;
ALTER TABLE "Employee" ADD COLUMN "aadhaarVerifiedAt" DATETIME;
ALTER TABLE "Employee" ADD COLUMN "aadhaarVerifyRef" TEXT;
ALTER TABLE "Employee" ADD COLUMN "aadhaarVerifyNote" TEXT;
ALTER TABLE "Employee" ADD COLUMN "mobileVerified" TEXT;
ALTER TABLE "Employee" ADD COLUMN "mobileVerifiedAt" DATETIME;
ALTER TABLE "Employee" ADD COLUMN "verifyKind" TEXT;
ALTER TABLE "Employee" ADD COLUMN "verifyTarget" TEXT;
ALTER TABLE "Employee" ADD COLUMN "verifyLast4" TEXT;
ALTER TABLE "Employee" ADD COLUMN "verifyOtpHash" TEXT;
ALTER TABLE "Employee" ADD COLUMN "verifyOtpExpiresAt" DATETIME;
ALTER TABLE "Employee" ADD COLUMN "verifyOtpAttempts" INTEGER NOT NULL DEFAULT 0;
