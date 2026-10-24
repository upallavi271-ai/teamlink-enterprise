// ---------------------------------------------------------------------------
// tl-target.js — WHICH TeamLink a test script talks to. Require it FIRST, before
// dotenv / @prisma/client / backend/src/db, because it sets DATABASE_URL.
//
//   TL_API=http://localhost:4011 node my-test.js   → the TEST SANDBOX: API on 4011 and
//                                                    Prisma on backend/prisma/sandbox.db
//   (TL_API unset)                                 → DEFAULT_MODE below decides:
//        'legacy'  : real dev server 4010 + dev.db, exactly as before, with a warning
//        'sandbox' : the sandbox if it is up, otherwise an error unless TL_ALLOW_REAL=1
//   TL_API=http://localhost:4010                   → refused unless TL_ALLOW_REAL=1
//
// Start / refresh the sandbox: cd backend && npm run sandbox -- --restart --detach --frontend
// Exports: API ('…/api'), ORIGIN, IC ('…/iclock'), FRONTEND, DATABASE_URL, DB_FILE, sandbox (bool).
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

// 'legacy' keeps scripts already in use by running agents on 4010 + dev.db.
// Flip to 'sandbox' once those agents have finished.
const DEFAULT_MODE = 'legacy';

const BACK = 'C:/Users/user/Desktop/All_Projects/teamlink-enterprise/backend';
const SANDBOX_DB = `${BACK}/prisma/${process.env.TL_TEST_DB || 'sandbox.db'}`; // TL_TEST_DB = name of a private copy in backend/prisma (own server + own copy per run)
const DEV_DB = `${BACK}/prisma/dev.db`;
const SANDBOX = 'http://localhost:4011';
const REAL = 'http://localhost:4010';
const allowReal = /^(1|true|yes)$/i.test(process.env.TL_ALLOW_REAL || '');

function sandboxUp() {
  try {
    const st = JSON.parse(fs.readFileSync(`${SANDBOX_DB}.json`, 'utf8'));
    process.kill(st.pid, 0);
    return true;
  } catch { return false; }
}

function resolve() {
  const set = String(process.env.TL_API || '').trim().replace(/\/+$/, '').replace(/\/api$/, '');
  if (set) {
    const port = (() => { try { return new URL(set).port; } catch { return ''; } })();
    if (port === '4010' && !allowReal) {
      throw new Error('[tl-target] TL_API points at the REAL dev server (4010). Use the sandbox (http://localhost:4011), or set TL_ALLOW_REAL=1 only if the orchestrator said so.');
    }
    return { origin: set, sandbox: port !== '4010' };
  }
  if (DEFAULT_MODE === 'sandbox') {
    if (sandboxUp()) return { origin: SANDBOX, sandbox: true };
    if (!allowReal) throw new Error('[tl-target] The TEST SANDBOX is not running (cd backend && npm run sandbox -- --detach). Set TL_ALLOW_REAL=1 to test on the real 4010 server.');
    return { origin: REAL, sandbox: false };
  }
  if (!process.env.TL_TARGET_QUIET) {
    process.stderr.write('[tl-target] TL_API not set — using the REAL dev server 4010 + dev.db. Prefer TL_API=http://localhost:4011 (sandbox).\n');
  }
  return { origin: REAL, sandbox: false, legacy: true };
}

const t = resolve();
let DATABASE_URL = null;
if (t.sandbox) {
  if (!fs.existsSync(SANDBOX_DB)) throw new Error(`[tl-target] ${SANDBOX_DB} missing — start the sandbox first (cd backend && npm run sandbox -- --detach).`);
  DATABASE_URL = `file:${SANDBOX_DB}`;
  process.env.DATABASE_URL = DATABASE_URL; // dotenv never overrides an existing value
  process.env.TL_SANDBOX = '1';
}

module.exports = {
  API: `${t.origin}/api`,
  ORIGIN: t.origin,
  IC: `${t.origin}/iclock`,
  FRONTEND: t.sandbox ? 'http://localhost:5184' : 'http://localhost:5183',
  DATABASE_URL, // null in legacy/real mode: the script keeps its own
  DB_FILE: t.sandbox ? SANDBOX_DB : DEV_DB,
  sandbox: !!t.sandbox,

};
