#!/usr/bin/env node
// Applies migrations/20261014800000_vendor_modules/migration.sql to the SANDBOX database only (never dev.db).
//   cd backend && node scripts/vendor-modules-apply-sandbox.js            (add --rollback to undo)
// The REAL database gets the migration the normal way, when the owner says go (it is listed as pending).
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const dbFile = path.join(BACK, 'prisma', 'sandbox.db');
if (!fs.existsSync(dbFile)) { console.error('No sandbox.db: start the sandbox first.'); process.exit(2); }
const rollback = process.argv.includes('--rollback');
const sql = fs.readFileSync(path.join(BACK, 'prisma', 'migrations', '20261014800000_vendor_modules', rollback ? 'rollback.sql' : 'migration.sql'), 'utf8');
const db = new DatabaseSync(dbFile);
db.exec('PRAGMA busy_timeout = 15000');
const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='VendorLoginModule'").all().length === 1;
if (!rollback && has) { console.log('Already applied to the sandbox.'); process.exit(0); }
db.exec(sql);
console.log(rollback ? 'Rolled back on the sandbox.' : 'Applied to the sandbox (sandbox.db only).');
db.close();
