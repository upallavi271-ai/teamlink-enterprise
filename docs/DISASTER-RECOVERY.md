# TeamLink: backups and disaster recovery (plain words)

Written 2026-11-17. Owner: the founder (decisions, storage account, passphrase) and the developer on duty (restores).

## What is backed up, when, where

| What | When | Where | Encrypted |
|---|---|---|---|
| Full database copy (`VACUUM INTO`, consistent while running) + resumes/uploads | Every day, the hour set on Administration → System (default 02:00) | On the server: `~/.teamlink-backups/<date_time>/`; 14 daily + 8 weekly kept | No (server disk) |
| Restore test of that copy | Right after each backup | Integrity check + row counts vs. backup time; shown on Administration → System | — |
| **Encrypted off-site copy** of the database | Right after a backup passes its test | `~/.teamlink-backups/offsite/*.tlbk` (newest 7) **and** S3-compatible storage once configured | **Yes**: AES-256-GCM, key from `BACKUP_ENC_KEY` (scrypt) |
| **Restore drill** of the encrypted copy | After each encrypted copy; any time with `npm run backup:drill` | Decrypts to a temp file, integrity check, counts vs. manifest | — |
| Database snapshot before every deploy | Every release | `/opt/teamlink-sync/backups/` | No |

## Targets

- **RPO (most data we can lose): 24 hours.** The daily backup is the restore point. A deploy snapshot narrows it on release days.
- **RTO (time to be working again): about 1 hour** on the same server, about 3 hours on a new server (set up the server, restore, point DNS).

## Still needed from the founder

1. **An off-site storage bucket**, for example Cloudflare R2, Backblaze B2, AWS S3 or DigitalOcean Spaces. We need its endpoint, bucket name and an access key limited to that bucket. Until then, the encrypted copy stays on the same server, so a lost server would lose it too.
2. **The backup passphrase** (`BACKUP_ENC_KEY`, at least 16 characters). Set it on the server, then keep it in a password manager and on paper with the founder, **never only on the server**. If the key is lost, the backups cannot be opened.

Settings (server `backend/.env`): `BACKUP_ENC_KEY`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_KEY_ID`, `BACKUP_S3_SECRET`, `BACKUP_S3_REGION` (default `auto`), `BACKUP_S3_PREFIX` (default `teamlink/`).

## How to restore

**A. Bad data, server fine** (someone deleted records, a bad import):
1. Administration → System: pick the backup from before the problem. Note its name, for example `2026-11-17_0200`.
2. On the server: stop the app (`pm2 stop teamlink`). Copy the live `dev.db` aside as `dev.db.before-restore`.
3. Copy `~/.teamlink-backups/<name>/teamlink.db` over `backend/prisma/dev.db` (and `files/uploads` if files were lost).
4. Start the app (`pm2 start teamlink`) and check sign-in, Candidates and Invoices. Record it in the audit trail.

**B. Server lost:**
1. New Ubuntu server: install Node 22, nginx and pm2, then clone the repository (deploy/vps has the scripts).
2. Download the newest `.tlbk` from the bucket. Run:
   `node -e "require('./src/utils/offsiteBackup').decryptFile('<file>.tlbk','prisma/dev.db',process.env.BACKUP_ENC_KEY)"`
3. Restore `.env` (from the founder's secure copy), start the app and point DNS. Uploads come from the bucket too, once file copies are added.

## Drill: every month

Run `npm run backup:drill` on the server, and once a quarter do restore B on a spare machine. Write down the date, the time it took and any problem at the end of this file.

| Date | Drill | Time | Result |
|---|---|---|---|
| | | | |
