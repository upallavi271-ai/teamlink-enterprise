-- agreement_seal_and_esign
--
-- THE AGREEMENT IS EXECUTED BY BOTH SIDES, AND THE CLIENT'S SIGNATURE IS
-- VERIFIED BEFORE IT COUNTS.
--
--   we prepare it  -> apply OUR stamp and signature
--   send           -> mail / WhatsApp / SMS link (already built)
--   client reads   -> uploads THEIR stamp and signature
--   client clicks Done -> chooses how to verify:
--        Aadhaar  — Aadhaar number, eSign, mobile OTP
--        Alternative — mobile OTP against the contact on record
--   verified       -> the executed agreement is visible to the BDE, the Super
--                     Admin, the Admin, the Client and the Accountant
--
-- THE FULL AADHAAR NUMBER IS NEVER STORED, and this is not a preference.
-- Section 29 of the Aadhaar Act and the UIDAI circulars forbid an
-- unauthenticated entity retaining the number; what is kept is the LAST FOUR
-- DIGITS for display and the eSign provider's TRANSACTION ID, which is what
-- actually proves the signature and is what an auditor asks for. The number
-- goes to the licensed eSign provider and nowhere else.
--
-- THE OTP IS STORED HASHED, with an expiry and an attempt counter, exactly as
-- utils/employeeAdmin.js already does for employee email verification. A
-- plaintext OTP column would make the database a way to sign an agreement.
--
-- Plain ADD COLUMNs, all nullable — every client already on the system stays
-- valid and simply has nothing recorded against these.

-- --- Our side: the company seal applied before sending ---------------------
ALTER TABLE "Client" ADD COLUMN "agreementCompanyStampFile" TEXT;
ALTER TABLE "Client" ADD COLUMN "agreementCompanyStampName" TEXT;
ALTER TABLE "Client" ADD COLUMN "agreementCompanySignFile"  TEXT;
ALTER TABLE "Client" ADD COLUMN "agreementCompanySignName"  TEXT;
ALTER TABLE "Client" ADD COLUMN "agreementCompanySignedBy"  TEXT;
ALTER TABLE "Client" ADD COLUMN "agreementCompanySealedAt"  DATETIME;

-- --- The client's side: their seal, uploaded on the signing page -----------
ALTER TABLE "Client" ADD COLUMN "agreementClientStampFile" TEXT;
ALTER TABLE "Client" ADD COLUMN "agreementClientStampName" TEXT;
ALTER TABLE "Client" ADD COLUMN "agreementClientSignFile"  TEXT;
ALTER TABLE "Client" ADD COLUMN "agreementClientSignName"  TEXT;
ALTER TABLE "Client" ADD COLUMN "agreementClientSealedAt"  DATETIME;

-- --- Verification ----------------------------------------------------------
-- AADHAAR | ALTERNATIVE
ALTER TABLE "Client" ADD COLUMN "agreementVerifyMethod"    TEXT;
-- Last four digits ONLY. See the note above.
ALTER TABLE "Client" ADD COLUMN "agreementAadhaarLast4"    TEXT;
-- The licensed eSign provider's transaction reference — what actually proves
-- the signature. Null while no provider is connected.
ALTER TABLE "Client" ADD COLUMN "agreementEsignTxnId"      TEXT;
ALTER TABLE "Client" ADD COLUMN "agreementEsignProvider"   TEXT;
-- The mobile the OTP went to, masked for display (••••••1234).
ALTER TABLE "Client" ADD COLUMN "agreementVerifyMobile"    TEXT;
ALTER TABLE "Client" ADD COLUMN "agreementVerifiedAt"      DATETIME;
-- Hashed, expiring, attempt-counted. Never the OTP itself.
ALTER TABLE "Client" ADD COLUMN "agreementOtpHash"         TEXT;
ALTER TABLE "Client" ADD COLUMN "agreementOtpExpiresAt"    DATETIME;
ALTER TABLE "Client" ADD COLUMN "agreementOtpAttempts"     INTEGER NOT NULL DEFAULT 0;
-- Recorded so a reader can tell a real provider signature from a flow that
-- ran with no provider connected. Honest beats impressive.
ALTER TABLE "Client" ADD COLUMN "agreementVerifyNote"      TEXT;
