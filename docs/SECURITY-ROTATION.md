# Secrets: what to rotate, what to purge, how (written 2026-10-13)

Nothing here was done for you. No file was deleted, no git history was rewritten, nothing was pushed. Values are never printed in this document; only file NAMES and the KIND of secret.

## 1. What the scan found (names only)

Scan: working tree plus `git ls-files` plus `git log -- <path>` in `teamlink-enterprise` (the repo has a `.git`).

| File (relative to teamlink-enterprise) | Kind | In git now? | In git history? |
|---|---|---|---|
| `backend/integration-key.tmp` | integration encryption key (INTEGRATION_SECRET_KEY copy) | no (ignored) | YES, 2 commits |
| `backend/integration-sync.json` | integration settings export, may hold provider credentials | no (ignored) | YES, 2 commits |
| `backend/vps-employees.json` | employee records pulled from the live server (personal data) | no (ignored) | YES, 2 commits |
| `backend/vps-employees.txt`, `backend/vps-codes.txt` | the same data as text | no (ignored) | not checked individually, treat as YES |
| `backend/prisma/dev.db.before-vps-pull-20261012-224156.bak` | database backup (all real data and password hashes) | no (ignored) | no |
| `backend/.env` | JWT secret, integration key, SMTP / provider keys | no (ignored) | no (0 commits) |
| `deploy-local-to-vps.ps1`, `deploy-local-to-vps-backup-20260928.ps1` | live server address and ssh key path (no password words found) | YES tracked | YES (3 commits) |
| `sync-vps-to-local.ps1` | live server address and ssh key path | untracked (new) | no |
| `backend/update-vps-integration-key.js`, `verify-vps-key.js`, `check-vps-key.js`, `check-vps-key-length.js`, `check-vps-codes.js`, `check-vps-employees.js`, `export-vps-employees.js`, `compare-local-vps-json.js` | one-off scripts that talk to the live server / read the key files (no literal secret found) | YES tracked | YES |
| `backend/scripts/vendor-spec-test.js` | a literal test password (test fixture only, not a real credential) | YES | YES |
| `backups/`, `TeamLink-*-converted.xlsx`, `TeamLink-DATA-NEEDED.xlsx` | real company data (not secrets, but personal data) | no (ignored) | not checked |

Pattern checks for private keys, cloud keys and chat / git tokens found nothing in tracked files.

## 2. Rotate first (the history cannot be trusted until you do)

Anything that was ever committed must be treated as known. Do these on the LIVE site and in your local `.env`, in this order:

1. `INTEGRATION_SECRET_KEY` (the file `integration-key.tmp` held it). Generate a new 32-byte key. Then re-save every integration (Administration > Integrations) so each secret is re-encrypted with the new key. Do NOT just swap the key: stored secrets would become unreadable.
2. Every provider credential that was in an integration (SMTP / mailbox, SMS, WhatsApp, Exotel, e-sign, job boards, AI keys): create new ones at the provider, enter them in Integrations, revoke the old ones at the provider.
3. `JWT_SECRET` on live and local (this signs in everybody again: they sign in once more). Also `PARTNER_JWT_SECRET` / `VENDOR_JWT_SECRET` if you set them.
4. The ssh key used by the deploy scripts: make a new key pair, put the new public key on the server, remove the old one from `authorized_keys`, update the key path in the scripts.
5. Passwords of the real accounts on the live site that still use a starting password: Users screen shows "N accounts still use a starting password"; each person must choose their own at the next sign-in (forced by the app now).
6. The server address in the scripts is not a secret by itself but is now public in history; restrict ssh to your own IPs and use key-only login.

## 3. Remove from git history (after step 2; this rewrites history, so read the warning)

WARNING: this changes every commit id after the first change. Anybody who has a clone must re-clone. Hosted copies (GitHub / GitLab) keep the old objects until their cache is purged, so rotation (section 2) is what actually protects you; the purge only reduces future exposure. Do this on a fresh mirror clone, never in your working folder.

```
# 0. install git-filter-repo (once):  pip install git-filter-repo   (or download the single script)
# 1. mirror clone
git clone --mirror <your-repo-url> teamlink-clean.git
cd teamlink-clean.git
# 2. list of paths to erase from ALL history
#    (put these lines in paths-to-remove.txt, one path per line)
#      backend/integration-key.tmp
#      backend/integration-sync.json
#      backend/vps-employees.json
#      backend/vps-employees.txt
#      backend/vps-codes.txt
#      deploy-local-to-vps.ps1
#      deploy-local-to-vps-backup-20260928.ps1
git filter-repo --invert-paths --paths-from-file paths-to-remove.txt
# 3. check
git log --all --oneline -- backend/integration-key.tmp     # must print nothing
# 4. push the rewritten history (FORCE; this is the destructive step; tell everyone first)
git push --force --mirror <your-repo-url>
# 5. ask the host to purge cached views / run garbage collection; everyone re-clones
```

Then keep the files OUT of git for good:

- add to `.gitignore`: `backend/vps-*`, `*.tmp`, `deploy-local-to-vps*.ps1`, `sync-vps-to-local.ps1`, `backend/*.bak`, `backend/prisma/*.bak`;
- keep the deploy scripts outside the repo, or make them read the host and key path from environment variables;
- `git rm --cached` the tracked one-off `check-vps-*.js` / `*-vps-*.js` scripts if you no longer need them in the repo (listed in section 1; not deleted for you).

## 4. Housekeeping

- The `.bak` database copy and `vps-*.json/txt` hold real personal data: move them off this machine (or encrypt them) once you no longer need them.
- `backups/` and the converted spreadsheets are already ignored; keep them that way.
- After rotation, run the app once and open Administration > Integrations: every channel should show Connected with the new credentials.
