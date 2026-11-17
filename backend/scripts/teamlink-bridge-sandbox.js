#!/usr/bin/env node
// ---------------------------------------------------------------------------
// A TEAMLINK-STYLE SERVER TO TRY THE "COMPANIES" MENU WITH, ON THIS PC ONLY (docs/second-company.md section 9)
//
//   npm run bridge-sandbox            TeamLink-style demo data (the repo's seed) on http://localhost:4067, with the Companies menu set up
//                                     for the company sandbox (npm run company-sandbox, http://localhost:5185)
//   npm run bridge-sandbox -- --keep  reuse the database from the last run
//
// The screens: frontend/  npm run bridge-sandbox  (http://localhost:5186). Sign in there as admin@teamlink.test (demo data, TEST_MODE:
// nothing is sent anywhere). It touches no real database: it uses prisma/zz-sc-bridge-demo.db and ~/.company-sandbox-bridge.
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const BACKEND = path.resolve(__dirname, '..');
const DB = path.join(BACKEND, 'prisma', 'zz-sc-bridge-demo.db');
const argv = process.argv.slice(2);
const PORT = Number((argv.find((a) => a.startsWith('--port=')) || '').split('=')[1]) || 4067;
const COMPANY_WEB = process.env.COMPANY_SANDBOX_WEB_URL || 'http://localhost:5185';
const BRIDGE = path.join(os.homedir() || os.tmpdir(), '.company-sandbox-bridge');
const FILES = path.join(os.homedir() || os.tmpdir(), '.bridge-sandbox-files');
if ([4010, 4011, 4020].includes(PORT)) { console.error(`[bridge-sandbox] refusing port ${PORT}: it belongs to another program.`); process.exit(1); }

const run = (args, env) => { const r = spawnSync(process.execPath, args, { cwd: BACKEND, env: { ...process.env, ...env }, stdio: 'inherit' }); if (r.status !== 0) process.exit(r.status || 1); };

if (!argv.includes('--keep') || !fs.existsSync(DB)) {
  for (const sfx of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(DB + sfx); } catch (e) { if (e.code !== 'ENOENT') { console.error(`[bridge-sandbox] cannot replace ${DB + sfx}: is it still running?`); process.exit(1); } } }
  try { fs.rmSync(FILES, { recursive: true, force: true }); } catch { /* none */ }
  console.log('[bridge-sandbox] making the demo database (about a minute) ...');
  run([path.join(BACKEND, 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy'], { DATABASE_URL: 'file:./zz-sc-bridge-demo.db' });
  run(['prisma/seed.js'], { DATABASE_URL: 'file:./zz-sc-bridge-demo.db', TEST_MODE: '1' });
}

// the company sandbox's key is `sandbox`: its server checks the pass for that key
run(['scripts/company-bridge-setup.js', '--dir', path.join(BRIDGE, 'teamlink'), '--key', 'sandbox', '--name', 'NISHTECHNOLOGIES INDIA PVT LTD', '--url', COMPANY_WEB, '--public-out', path.join(BRIDGE, 'bridge-public.pem')], {});

const env = {
  ...process.env, PORT: String(PORT), DATABASE_URL: 'file:./zz-sc-bridge-demo.db', TEST_MODE: '1', TEAMLINK_SANDBOX: '1', NODE_ENV: 'development',
  COMPANY_BRIDGE_DIR: path.join(BRIDGE, 'teamlink'),
  JWT_SECRET: crypto.createHash('sha256').update('bridge-sandbox-jwt').digest('hex'), INTEGRATION_SECRET_KEY: crypto.createHash('sha256').update('bridge-sandbox-key').digest('hex'),
  APP_BASE_URL: 'http://localhost:5186', UPLOAD_DIR: path.join(FILES, 'uploads'), ATS_IO_DIR: path.join(FILES, 'ats-io'), MESSAGE_JOB_DIR: path.join(FILES, 'message-jobs'), BACKUP_DIR: path.join(FILES, 'backups'),
  GREENSTART_ENABLED: 'false', GREENSTART_SUPERVISE: 'false', GREENSTART_AUTOSTART: 'false', JOB_PORTAL_EMBED: '0', JOB_PORTAL_SYNC_INTERVAL_MS: '0', MAIL_WORKER_INTERVAL_MS: '0',
};
console.log(`[bridge-sandbox] TeamLink-style demo server on http://localhost:${PORT}  (sign in: admin@teamlink.test, demo data)`);
const child = spawn(process.execPath, ['src/index.js'], { cwd: BACKEND, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code || 0));
['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => { try { child.kill(); } catch { /* gone */ } process.exit(0); }));
