# Two-step sign-in (MFA) for Super Admin and Admin: design

Status: NOT BUILT (2026-10-13). It needs three new columns on `User`, and the rule for this task was "migrations only if truly needed". MFA is optional and off by default, so it was written down instead of half-built. Everything below is ready to build once the migration is approved.

## What the user gets (plain words)

- My Profile > "Two-step sign-in" card (Super Admin and Admin only at first).
- Press "Turn on". A QR code and a 16-character setup key appear. Scan it with any authenticator app (Google Authenticator, Microsoft Authenticator, Authy).
- Type the 6-digit code once to prove it works. Only then is it switched on.
- Ten one-time recovery codes are shown ONCE ("Save these somewhere safe"). Each works one time.
- Sign-in then asks: email + password, then the 6-digit code. "Use a recovery code instead" is a small link.
- Company Setup > Security: one switch per role, "Make two-step sign-in compulsory for: Super Admin / Admin / Manager / HR". Default OFF for all. When ON for a role, a login of that role that has not enrolled is sent to the enrolment screen straight after the password and cannot continue until it is done.
- A Super Admin can reset another login's two-step (lost phone). This is audited and the person is told by e-mail.

## How it works (server)

Standard TOTP, RFC 6238: HMAC-SHA1, 30-second step, 6 digits, accept the previous and next step (clock drift). No new dependency is needed: the algorithm is about 25 lines on Node's `crypto` (base32 decode, HMAC, dynamic truncation). If a library is preferred, `otpauth` (small, no native code) can be added to `dependencies`.

### Schema (additive, with rollback)

```sql
-- up
ALTER TABLE "User" ADD COLUMN "totpSecretEnc" TEXT;        -- AES-256-GCM of the secret, key from MFA_ENC_KEY (or derived from JWT_SECRET)
ALTER TABLE "User" ADD COLUMN "totpEnabledAt" DATETIME;    -- null = off
ALTER TABLE "User" ADD COLUMN "totpRecovery" TEXT;         -- JSON array of bcrypt hashes of the unused recovery codes
-- down (SQLite 3.35+)
ALTER TABLE "User" DROP COLUMN "totpSecretEnc";
ALTER TABLE "User" DROP COLUMN "totpEnabledAt";
ALTER TABLE "User" DROP COLUMN "totpRecovery";
```
`schema.prisma`: `totpSecretEnc String?`, `totpEnabledAt DateTime?`, `totpRecovery String?`. The "compulsory per role" switch is one `AppSetting` row (`security.mfaRequiredRoles`, JSON array, default `[]`), so no table is needed.

### Sign-in flow

1. `POST /api/auth/login` checks the password exactly as today. If `totpEnabledAt` is set, it does NOT return the session token. It returns `{ mfaRequired: true, mfaTicket }`. The ticket is a short-lived (5 minutes) signed token that proves "password was correct" and nothing else; it cannot call any other route.
2. `POST /api/auth/mfa/verify { mfaTicket, code }` (or `recoveryCode`) returns the normal token. Wrong codes count toward the SAME lockout counter as wrong passwords (5 tries, then locked), and every attempt is audited.
3. A code (or recovery code) can be used once per time step: the last accepted step is remembered on the ticket / user to stop replay.
4. Enrolment: `POST /api/auth/mfa/start` (needs the password again) returns the secret and an `otpauth://` URI; `POST /api/auth/mfa/confirm { code }` stores the encrypted secret, sets `totpEnabledAt`, returns the recovery codes once. `POST /api/auth/mfa/disable` needs password + current code. A Super Admin can clear another login's MFA at `POST /api/admin/users/:id/mfa-reset` (audited, e-mailed).
5. If the role switch is ON and the login is not enrolled: login returns `{ mfaEnrolmentRequired: true, mfaTicket }` and only the enrolment calls accept that ticket.
6. Act as / View as keep working: they start from an already signed-in Super Admin.
7. Sessions: turning MFA on or off (or a reset) bumps `passwordChangedAt`-style invalidation so old tokens end.

### Tests to write when built

TOTP known-answer vectors (RFC 6238 appendix B), clock-drift window, replay refused, 5 wrong codes lock the login, recovery code works once, ticket cannot call any other route, enrolment needs the password, role switch forces enrolment, Super Admin reset works and Admin cannot reset a Super Admin, audit rows and e-mail alert exist, secret never appears in any response after enrolment.
