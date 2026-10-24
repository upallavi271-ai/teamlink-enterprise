# delta-sync: changes-only sync between localhost and the live site

Plain English. For the daily commands read `TeamLink-Sync-Guide.md` on the Desktop (All_Projects).

## The idea

Three databases take part:

- **Baseline (B)**: a copy of the database as it was when localhost and the live site last matched
  (`C:\Users\user\.teamlink-backups\sync-baseline\baseline.db`).
- **Local (L)**: localhost now (a safe snapshot, `VACUUM INTO`, so the local server can keep running).
- **Live (V)**: a read-only copy of the live database (`sqlite3 .backup`, the live site is never stopped).

`L - B` is what you did locally. `V - B` is what happened on the live site. Each is applied to the OTHER side,
row by row, in one transaction, with the same rules:

- New row, primary key not there: added. There and identical: "already there". There but different: CONFLICT.
- Same ID/unique value (employee code, email...) used by another row: CONFLICT.
- Edited row: only the CHANGED columns are written, and only if the other side still has the baseline value of that column.
  Already has the new value: "already there". Anything else: CONFLICT (nothing written, both versions reported).
  Time-stamp columns (updatedAt...) never cause a conflict.
- Deleted rows: reported, never applied.
- Rows that point to a row that had a conflict wait ("blocked"). After applying, a foreign-key check runs and the
  WHOLE transaction is rolled back if it finds a new broken link.
- Tables/columns that only one side has are skipped for that table and reported (a required column on one side only
  refuses that table, not the whole sync).

After success the baseline moves forward by exactly the applied + "already there" changes (the engine is run on a
copy of the baseline, the old one is kept as `baseline.prev.db`). Conflicts stay different and come back next run.
`-Prefer Local` / `-Prefer VPS` makes the chosen side win every same-cell conflict (overwritten values go to the undo file).

## Files

| File | Job |
|---|---|
| `make-delta.js` | delta = database minus baseline, per table by primary key (read-only) |
| `classify-delta.js` | dry run on a copy of the other side: the plain report |
| `apply-delta.js` | applies a delta in ONE transaction (Prisma client, runs on the live server too); `--revert` undoes |
| `update-baseline.js` | moves the baseline forward by what was applied |
| `compare-dbs.js` | after a sync: per table rows + hash on both sides, explains every difference |
| `engine.js`, `lib.js`, `report.js` | the shared rule book, helpers, plain-English report |
| `helper.js` | small jobs for the PowerShell scripts (snapshot, integrity, schema, count) |
| `exclusions.json` | what NEVER travels (editable, printed in every report) |

## What never travels (`exclusions.json`)

Integration credentials (tables `Integration`, `IntegrationEvent`, `PortalCredential`), login sessions and tokens,
login counters and one-time codes, notifications, message queues and logs, posting-worker state, WhatsApp tables
(`Wa*`, `Conversation*`, `CandidateMessage`), test data (`ZZTEST`, `example.test`) and rows that point to it,
login noise in `AuditLog`. `AppSetting` keys are ALL excluded except the allow-list in the file; excluded keys that differ are
listed in every report so you can opt one in. `AuditLog` rows do travel (insert-only).

## Tests

`node backend/scripts/delta-sync-test.js` (works on copies only, refuses `prisma/dev.db`; Part 2 reads the real local
database read-only and writes `TeamLink-Local-Changes-Since-Pull.md`).

## Limits

Deletes are not synced. Uploaded files are not synced (rows pointing to missing files are counted). Two databases can
differ only in the ways `compare-dbs.js` lists.
