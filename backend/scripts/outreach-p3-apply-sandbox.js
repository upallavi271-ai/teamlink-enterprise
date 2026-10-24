// Applies the Phase 3 migration (20261014200000_outreach_campaigns) to the SANDBOX database ONLY (prisma/sandbox.db). Idempotent.
// Never touches dev.db. After a sandbox refresh (the copy comes from dev.db), run this again:  node scripts/outreach-p3-apply-sandbox.js
//   node scripts/outreach-p3-apply-sandbox.js rollback    (drops the five tables again, sandbox only)
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = path.join(__dirname, '..', 'prisma', 'migrations', '20261014200000_outreach_campaigns');
const db = new DatabaseSync(path.join(__dirname, '..', 'prisma', 'sandbox.db'));
db.exec('PRAGMA busy_timeout = 30000');
const rollback = process.argv[2] === 'rollback';
const has = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'OutreachCampaign'").get();
if (has && !rollback) { console.log('already applied to the sandbox'); process.exit(0); }
db.exec(fs.readFileSync(path.join(dir, rollback ? 'rollback.sql' : 'migration.sql'), 'utf8'));
console.log(rollback ? 'rolled back (sandbox)' : 'applied to the sandbox');
