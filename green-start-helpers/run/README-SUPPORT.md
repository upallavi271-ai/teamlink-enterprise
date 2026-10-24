# TeamLink Omni-Channel (Green Start): Support Guide

Plain words. Short sentences. Updated 2026-10-22.

Green Start is your own Omni-Channel product. TeamLink now starts it, watches it and restarts it by itself, the same way it does for the Job Portal.

---

## 1. How it starts by itself

1. You start TeamLink as always.
2. About 5 seconds later the TeamLink server begins to start Green Start in the background. No windows open.
3. It starts the parts in this order:
   1. **Database**: a portable PostgreSQL 16, its own database, port 5436.
   2. **Redis**: the message queue (port 6379).
   3. **Database update**: applies new database updates if there are any. On the very first start it also puts in the demo workspace.
   4. **Green Start server** (port 4020) and the **campaign sender** (worker).
   5. **Entrance** (port 5190): the door that TeamLink uses to open Green Start.
4. If a part crashes, TeamLink starts it again after a short wait (5 s, 15 s, 45 s, 2 min). After 5 starts in one hour it stops trying and shows **Crashed**.
5. When TeamLink is closed for real (Ctrl+C), Green Start is closed cleanly with it (the database is stopped properly). If TeamLink dies suddenly, a small watcher closes Green Start after 2 minutes. A normal TeamLink restart (code change) does **not** stop Green Start.
6. If you started parts yourself with `start-green-start.cmd`, TeamLink notices them and leaves them alone.

## 2. How to open it

Click **Omni-Channel** in the left menu (Admin, Manager, Team Lead and HR logins). When everything is ready, the page opens Green Start by itself. Inside, you sign in with **Green Start's own login** (see section 7).

## 3. The five states and what to do

| State on the page | What it means | What to do |
|---|---|---|
| **Running** | All 5 parts are up. | Nothing. Use it. |
| **Starting** (step n of 5) | It is starting. Steps: 1 Database, 2 Redis, 3 Preparing the database, 4 Server and sender, 5 Entrance. | Wait. First start can take 1 to 2 minutes. |
| **Waiting for memory** | The computer has less than 1200 MB free. | Close heavy things (many browser tabs, Excel, builds). It checks again every minute. |
| **Waiting for Redis** | Redis is not on this computer. The server is NOT started (it would hang and waste memory). | Run `green-start-app\run\get-redis.cmd` once (see section 4). |
| **Crashed** | A part stopped many times and TeamLink gave up. The page shows the last 3 messages (private details hidden). | An Admin presses **Show log**, then **Restart**. If it keeps happening, send the log to support. |

Also possible: **Stopped** (an Admin pressed Stop; stays stopped until Start), **Not started (auto-start is off)**, **Not built yet** (the page lists what is missing), **Looked after by another TeamLink backend** (two TeamLink servers are running; use one).

## 4. Redis: the one thing to do once

Double-click:

`C:\Users\user\Desktop\All_Projects\teamlink-enterprise\green-start-app\run\get-redis.cmd`

It shows the file name, address and size, and waits for a key press. It downloads one zip (about 5 MB) from the official GitHub page of `tporadowski/redis` (Windows port of Redis 5), checks it is a real zip with `redis-server.exe`, prints its SHA-256 for your records, and unzips it into `green-start-app\run\redis\`. It installs **no** Windows service and changes **no** registry or PATH.

Honest notes:
- The script cannot compare the SHA-256 with the publisher's value because it does not know it. If you copy the hash from the GitHub release page you can run `get-redis.ps1 -Sha256 <hash>` to check it.
- This is Redis 5 (old but stable). Green Start's queue works with it.
- If you already have Memurai or any Redis on port 6379, you do not need this; it is found by itself.

After this TeamLink starts Redis by itself within a minute: only on this computer (127.0.0.1), 256 MB limit, with a random password it keeps for itself. It keeps a small snapshot so scheduled campaigns survive a restart.

## 5. Ports (all on this computer only)

| Port | What | If it clashes |
|---|---|---|
| 5190 | Entrance (what Omni-Channel opens) | Change `GREENSTART_GATE_PORT` in `backend\.env` |
| 4020 | Green Start server | Change `GREENSTART_API_PORT` **and** `PORT` in `green-start-app\gs-api\.env` |
| 5436 | Green Start database | Change `GREENSTART_PG_PORT` **and** the port inside `DATABASE_URL` in `gs-api\.env` |
| 6379 | Redis | If another program holds 6379, TeamLink starts its own Redis on the next free port (6380...) by itself |

TeamLink itself uses 4010 and 5183. The Job Portal uses 4323 and 5434.

## 6. Stop, restart, logs, backups, data

- **Stop / Restart / Start**: Admin or Super Admin, buttons on the Omni-Channel page (also under **Manage** when it is running). Every press is saved in the audit trail. A few presses per minute at most.
- **Show log**: last 80 lines of any part. Private details (passwords, tokens, e-mails, phone numbers, database and Redis addresses) are hidden.
- **Where things are** (folder `C:\Users\user\Desktop\All_Projects\teamlink-enterprise\green-start-app\run\`):
  - Logs: `logs\` (`supervisor.log`, `api.out.log`, `api.err.log`, `pg.*.log`, `worker.*`, `gate.*`, `migrate.log`). Big files are rotated.
  - Running programs: `logs\*.pid`. Lock: `logs\supervisor.lock`.
  - Database files: `pgdata\` (kept between restarts; this is your Green Start data).
  - Redis: `redis\` (program, settings, `redis.secret`) and `redis-data\` (snapshot).
- **Backups**: a full copy of Green Start's database is made every day while it runs, and when an Admin presses **Backup now**. Folder: `%USERPROFILE%\.teamlink-backups\green-start\`. The 7 newest are kept. No backup is made when free disk is below 1500 MB. Files are `greenstart-YYYYMMDD-HHMMSS.ndjson.gz` (a compressed list of every table's rows). To restore into a fresh empty Green Start database: `node green-start-app\run\gs-db.cjs restore <file>` (it refuses if the database already has users).
- **RAM**: about 1 GB when everything runs (database about 100 MB, server up to 512 MB, sender up to 384 MB, Redis up to 256 MB, entrance about 40 MB). Disk: about 800 MB for the program plus your data and backups.

## 7. The second login

Green Start has its **own login**, separate from TeamLink (it has no single sign-on). The demo accounts are written in `green-start-app\gs-api\README.md`, section **Seeded accounts**. They are fake accounts for a local trial. Never use the demo seed on a database with real people.

## 8. What is separate from TeamLink

Green Start has its **own** contacts, templates, campaigns, inbox, credits and STOP (opt-out) list. Nothing is copied between the two. TeamLink's shared templates, department rules and per-person credits do not exist inside Green Start. The page shows "Green Start has its own contacts: N" only as information.

**WhatsApp warning:** do **not** press "Connect with Facebook" or paste the company WhatsApp token inside Green Start. One Meta app can have only one webhook address. If Green Start takes it, replies stop arriving in TeamLink. Until you decide who owns the WhatsApp number, send real messages from ONE system only.

## 9. How to switch things (modify)

Settings go in `backend\.env` (TeamLink) or `green-start-app\gs-api\.env` (Green Start). Restart TeamLink after a change.

| Setting | Default | Meaning |
|---|---|---|
| `GREENSTART_ENABLED` | on | `false` = TeamLink does not look after Green Start at all |
| `GREENSTART_AUTOSTART` | on | `false` = does not start by itself; an Admin presses Start |
| `GREENSTART_SHOW_WINDOWS` | off | `1` = show the console windows (for debugging) |
| `GREENSTART_MIN_FREE_MB` | 1200 | Free memory needed before starting |
| `GREENSTART_MAX_RESTARTS` | 5 | Starts per hour before "Crashed" |
| `GREENSTART_AUTOSEED` | on | `0` = never add the demo workspace to an empty database |
| `GREENSTART_BACKUP_DIR` | `%USERPROFILE%\.teamlink-backups\green-start` | Backup folder |
| `GREENSTART_MIN_DISK_MB` | 1500 | No backup below this much free disk |
| `GREENSTART_ALL_ROLES` | off | `1` = BDE and Recruiter may open Green Start too (it has no phone/email masking) |
| `GREENSTART_*_PORT` | see section 5 | Ports |

Product settings (channels, providers, e-mail) are in `green-start-app\gs-api\.env`. Leave WhatsApp and payment keys empty until the open decisions below are made.

### Updating from a new zip (safe steps)
1. Press **Stop** on the Omni-Channel page. Press **Backup now** first and check a new file appears in the backup folder.
2. Copy the folder `pgdata` and `gs-api\.env` somewhere safe.
3. Extract the new zip into a NEW folder (not over the old one).
4. Compare the new files' SHA-256 with the zip you were given. Do not edit the product source.
5. Install packages and build in the new folder (same steps as the install report), copy `gs-api\.env` and the `run\` folder over.
6. Point TeamLink to the new folder, start TeamLink. The "Preparing the database" step applies the new database updates by itself (they only add; your data stays). If something is wrong, Stop, go back to the old folder and `pgdata` copy.

Do not run the product's own `start-all.ps1`, `watch-sync.ps1` or `auto-sync.ps1` (they push to GitHub on a timer).

## 10. Decisions still open

1. Who can open Green Start (now Admin, Manager, Team Lead, HR).
2. Who owns the WhatsApp webhook and number.
3. Which contacts go into Green Start (nothing is copied now).
4. Whether auto-start should stay on by default.
