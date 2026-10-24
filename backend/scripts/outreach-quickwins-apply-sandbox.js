// Applies the quick-wins migration (20261014900000_outreach_quickwins) to the SANDBOX database ONLY (prisma/sandbox.db). Idempotent.
// Never touches dev.db. After a sandbox refresh (the copy comes from dev.db), run this again:  node scripts/outreach-quickwins-apply-sandbox.js
//   node scripts/outreach-quickwins-apply-sandbox.js rollback    (drops the two tables again, sandbox only)
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = path.join(__dirname, '..', 'prisma', 'migrations', '20261014900000_outreach_quickwins');
const db = new DatabaseSync(path.join(__dirname, '..', 'prisma', 'sandbox.db'));
db.exec('PRAGMA busy_timeout = 30000');
const rollback = process.argv[2] === 'rollback';
const has = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'OutreachCampaignNote'").get();
if (has && !rollback) { console.log('already applied to the sandbox'); process.exit(0); }
db.exec(fs.readFileSync(path.join(dir, rollback ? 'rollback.sql' : 'migration.sql'), 'utf8'));
console.log(rollback ? 'rolled back (sandbox)' : 'applied to the sandbox');
