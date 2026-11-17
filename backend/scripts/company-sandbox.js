#!/usr/bin/env node
// ---------------------------------------------------------------------------
// A SEPARATE COMPANY TO LOOK AT, ON THIS PC ONLY (docs/second-company.md)
//
//   npm run company-sandbox                  a brand-new empty company on http://localhost:4066 (database prisma/company-sandbox.db)
//   npm run company-sandbox -- --keep        reuse the database from the last run
//   npm run company-sandbox -- --port=4066
//
// Same as `npm run sandbox`, but it is NOT a copy of TeamLink's data: it is what a new company starts with (scripts/company-init.js),
// started with COMPANY_KEY like the real one. TEST_MODE: no mail, SMS, WhatsApp or outside call is ever made. The sign-in link for its
// Super Admin is written to prisma/company-sandbox.first-login.txt (open it in a browser and choose a password; it works once).
// The matching screens: in frontend/  npm run company-sandbox   (http://localhost:5185, shows the company's own name).
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const BACKEND = path.resolve(__dirname, '..');
const DB = path.join(BACKEND, 'prisma', 'company-sandbox.db');
const LINK = path.join(BACKEND, 'prisma', 'company-sandbox.first-login.txt');
const argv = process.argv.slice(2);
const PORT = Number((argv.find((a) => a.startsWith('--port=')) || '').split('=')[1]) || 4066;
const FE_PORT = Number(process.env.COMPANY_SANDBOX_WEB_PORT) || 5185;
if ([4010, 4011, 4020].includes(PORT)) { console.error(`[company-sandbox] refusing port ${PORT}: it belongs to another program.`); process.exit(1); }
const FILES = path.join(os.homedir() || os.tmpdir(), '.company-sandbox');

if (!argv.includes('--keep') || !fs.existsSync(DB)) {
  for (const sfx of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(DB + sfx); } catch (e) { if (e.code !== 'ENOENT') { console.error(`[company-sandbox] cannot replace ${DB + sfx}: is it still running?`); process.exit(1); } } }
  try { fs.rmSync(FILES, { recursive: true, force: true }); } catch { /* none */ }
  const r = spawnSync(process.execPath, ['scripts/company-init.js', '--key', 'sandbox', '--name', 'NISHTECHNOLOGIES INDIA PVT LTD', '--admin-name', 'Sandbox Super Admin', '--admin-email', 'admin@sandbox-company.example.test', '--link-file', LINK, '--app-url', `http://localhost:${FE_PORT}`],
    { cwd: BACKEND, env: { ...process.env, DATABASE_URL: 'file:./company-sandbox.db' }, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}

const env = {
  ...process.env, PORT: String(PORT), DATABASE_URL: 'file:./company-sandbox.db', TEST_MODE: '1', TEAMLINK_SANDBOX: '1', NODE_ENV: 'development', COMPANY_KEY: 'sandbox',
  JWT_SECRET: crypto.createHash('sha256').update('company-sandbox-jwt').digest('hex'), INTEGRATION_SECRET_KEY: crypto.createHash('sha256').update('company-sandbox-key').digest('hex'),
  APP_BASE_URL: `http://localhost:${FE_PORT}`, UPLOAD_DIR: path.join(FILES, 'uploads'), ATS_IO_DIR: path.join(FILES, 'ats-io'), MESSAGE_JOB_DIR: path.join(FILES, 'message-jobs'), BACKUP_DIR: path.join(FILES, 'backups'),
  GREENSTART_ENABLED: 'false', GREENSTART_SUPERVISE: 'false', GREENSTART_AUTOSTART: 'false', JOB_PORTAL_EMBED: '0', JOB_PORTAL_SYNC_INTERVAL_MS: '0', MAIL_WORKER_INTERVAL_MS: '0',
};
console.log(`[company-sandbox] company "NISHTECHNOLOGIES INDIA PVT LTD" (sandbox copy) on http://localhost:${PORT}   sign-in link file: ${LINK}`);
const child = spawn(process.execPath, ['src/index.js'], { cwd: BACKEND, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code || 0));
['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => { try { child.kill(); } catch { /* gone */ } process.exit(0); }));
