#!/usr/bin/env node
// ---------------------------------------------------------------------------
// "IS THIS COMPANY'S COPY REALLY SEPARATE?" - a read-only check of one company's backend/.env (docs/second-company.md).
//
//   node scripts/company-check.js --env /opt/nishtechnologies/backend/.env --home /opt/nishtechnologies/home
//        [--teamlink-env /opt/teamlink-enterprise/backend/.env]   (compared by fingerprint only; no secret is ever printed)
//        [--port-free]                                            (also asks the machine whether the port is already taken)
//
// It reads a settings file and prints PASS / FAIL lines. Exit 0 = every line passed, 1 = something is shared or unsafe.
// It changes nothing, contacts nothing, and never prints a value that could be a secret.
//
// What it protects against (each one is a way two companies could end up sharing something):
//   - the same database file, the same port, the same secrets (a login of one would open the other)
//   - the same folders for uploaded files / backups / WhatsApp sessions (they default to the Linux user's home folder, which
//     TeamLink also uses, so HOME has to point at this company's own folder)
//   - TeamLink's Omni-Channel (Green Start), Job Portal and AI-calling services (the defaults point at services on the SAME server)
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : ''; };
const has = (f) => argv.includes(f);

// Ports TeamLink and its neighbours use on the same server (and on the PCs).
const TEAMLINK_PORTS = { 4010: 'TeamLink API', 4011: 'TeamLink sandbox', 4020: 'Green Start API', 4323: 'Job Portal', 5183: 'TeamLink web (dev)', 5184: 'TeamLink sandbox web', 5190: 'Green Start entrance', 5436: 'Green Start database', 6379: 'Redis' };
const PLACEHOLDER = /change-this|changeme|example|your[-_ ]|^$/i;
const fingerprint = (s) => crypto.createHash('sha256').update(`company-check:${s}`).digest('hex').slice(0, 12);
const falsy = (v) => /^(0|false|no|off)$/i.test(String(v == null ? '' : v).trim());

function load(file) {
  if (!file) return null;
  try { return dotenv.parse(fs.readFileSync(file)); } catch (e) { throw new Error(`cannot read ${file}: ${e.code || e.message}`); }
}

function portTaken(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}

async function check({ env, home, tl, checkPort }) {
  const out = [];
  const add = (ok, what, detail) => out.push({ ok: !!ok, what, detail: detail || '' });
  const e = { ...env };
  const homeDir = home || e.HOME || '';

  add(/^[a-z][a-z0-9-]{1,30}$/.test(String(e.COMPANY_KEY || '')), 'COMPANY_KEY is set (the server refuses any database that is not this company\'s)', e.COMPANY_KEY ? '' : 'missing');

  const dbUrl = String(e.DATABASE_URL || '');
  const dbFile = path.basename(dbUrl.replace(/^file:/i, '').replace(/[?#].*$/, '').replace(/["']/g, ''));
  add(/^file:/i.test(dbUrl) && !/^dev\.db$/i.test(dbFile), 'its own database file (not "dev.db", TeamLink\'s name)', dbFile || 'missing');
  if (tl && tl.DATABASE_URL) add(dbUrl !== tl.DATABASE_URL, 'database setting differs from TeamLink\'s');

  const port = Number(e.PORT);
  add(Number.isInteger(port) && port > 1023 && !TEAMLINK_PORTS[port], 'its own port (not one TeamLink or its neighbours use)', TEAMLINK_PORTS[port] ? `${port} is ${TEAMLINK_PORTS[port]}` : String(e.PORT || 'missing'));
  if (checkPort && Number.isInteger(port)) add(!(await portTaken(port)), `port ${port} is free on this machine`);

  for (const k of ['JWT_SECRET', 'INTEGRATION_SECRET_KEY']) {
    const v = String(e[k] || '');
    add(v.length >= 32 && !PLACEHOLDER.test(v), `${k} is its own long random value`, v ? `${v.length} characters` : 'missing');
    if (tl && tl[k]) add(fingerprint(v) !== fingerprint(tl[k]), `${k} differs from TeamLink's (fingerprints compared, nothing printed)`);
  }
  for (const k of ['AGREEMENT_LINK_SECRET', 'OFFER_LINK_SECRET', 'PREP_LINK_SECRET', 'LMS_MEDIA_SECRET', 'PARTNER_JWT_SECRET', 'VENDOR_JWT_SECRET']) {
    if (e[k] && tl && tl[k]) add(fingerprint(e[k]) !== fingerprint(tl[k]), `${k} differs from TeamLink's`);
  }

  const url = String(e.APP_BASE_URL || '');
  add(/^https?:\/\//i.test(url) && !/teamlink\.teamlinks\.in/i.test(url), 'APP_BASE_URL is this company\'s own address (links in mails and password links use it)', url || 'missing');
  if (e.FRONTEND_URL) add(!/teamlink\.teamlinks\.in/i.test(e.FRONTEND_URL), 'FRONTEND_URL is not TeamLink\'s address');
  if (e.CORS_ORIGINS) add(!/teamlink\.teamlinks\.in/i.test(e.CORS_ORIGINS), 'CORS_ORIGINS does not list TeamLink\'s address');
  if (e.GREENSTART_COOKIE_DOMAIN) add(false, 'GREENSTART_COOKIE_DOMAIN is not set (it would hand door passes across companies)', e.GREENSTART_COOKIE_DOMAIN);

  // folders: the default for every one of them is under the Linux user's home folder, which TeamLink shares
  const homeOk = !!homeDir && !/^\/root\/?$/.test(homeDir) && !/\.teamlink/i.test(homeDir);
  add(homeOk, 'HOME points at this company\'s own folder (every default data folder hangs under it)', homeDir || 'not set');
  const dirs = ['UPLOAD_DIR', 'ATS_IO_DIR', 'MESSAGE_JOB_DIR', 'BACKUP_DIR', 'TL_QR_SESSION_DIR', 'AI_VOICE_LIVE_FILE'];
  for (const k of dirs) {
    const v = String(e[k] || '');
    const own = v && !/\.teamlink|\/opt\/teamlink-enterprise|\/tmp\/teamlink/i.test(v) && (!tl || !tl[k] || path.resolve(v) !== path.resolve(tl[k]));
    add(own, `${k} is set to a folder of this company's own`, v || 'not set');
  }

  // neighbours on the same server
  add(falsy(e.GREENSTART_ENABLED) && e.GREENSTART_ENABLED !== undefined, 'TeamLink\'s Omni-Channel (Green Start) is switched off here (GREENSTART_ENABLED=false)', String(e.GREENSTART_ENABLED || 'not set'));
  add(falsy(e.GREENSTART_SUPERVISE) && e.GREENSTART_SUPERVISE !== undefined, 'this server does not start or watch Green Start (GREENSTART_SUPERVISE=false)', String(e.GREENSTART_SUPERVISE || 'not set'));
  add(falsy(e.GREENSTART_AUTOSTART) && e.GREENSTART_AUTOSTART !== undefined, 'Green Start auto-start is off (GREENSTART_AUTOSTART=false)', String(e.GREENSTART_AUTOSTART || 'not set'));
  add(falsy(e.JOB_PORTAL_EMBED) && e.JOB_PORTAL_EMBED !== undefined, 'the embedded Job Portal is off (JOB_PORTAL_EMBED=0)', String(e.JOB_PORTAL_EMBED || 'not set'));
  add(!e.JOB_PORTAL_SYNC_TOKEN && !e.JOB_PORTAL_PUSH_SECRET, 'no Job Portal sync secrets are set (the portal sync stays off)');
  add(!String(e.AI_VOICE_GATEWAY || '').match(/^(1|true|yes|on)$/i), 'the AI phone gateway is off (AI_VOICE_GATEWAY)');
  add(!e.AI_CALL_AUDIOSOCKET_PORT && !e.AI_CALL_OLLAMA_URL && !e.AI_CALL_STT_URL && !e.AI_CALL_TTS_URL, 'no self-hosted AI-calling services are wired in (AI_CALL_*)');
  add(!e.KAVYA_API_KEY_FILE && !e.KAVYA_API_KEY, 'no Kavya AI-calling key is wired in');
  add(!e.JOB_PORTAL_URL && !e.JOB_PORTAL_API_URL, 'no Job Portal address is set');

  // THE COMPANIES MENU (utils/companyBridge.js, docs/second-company.md section 9): TeamLink signs, the company only checks. A company holds TeamLink's
  // PUBLIC key (a file of its own) and a plain link back to TeamLink; it must never be set up to make passes itself.
  if (e.COMPANY_BRIDGE_PUBLIC_KEY_FILE || e.COMPANY_BRIDGE_HOME_URL || e.COMPANY_BRIDGE_DIR) {
    add(!e.COMPANY_BRIDGE_DIR, 'the Companies menu: this company cannot make passes (COMPANY_BRIDGE_DIR is not set; only TeamLink signs)');
    add(!!e.COMPANY_BRIDGE_PUBLIC_KEY_FILE && !/\.teamlink|\/opt\/teamlink-enterprise/i.test(e.COMPANY_BRIDGE_PUBLIC_KEY_FILE), 'the Companies menu: the public key file is this company\'s own copy', e.COMPANY_BRIDGE_PUBLIC_KEY_FILE || 'missing');
  }
  // anything that names TeamLink's own folders or address (COMPANY_BRIDGE_HOME_URL is the one allowed exception: it is only the "Back to TeamLink" link)
  const mentions = Object.entries(e).filter(([k, v]) => !['APP_BASE_URL', 'COMPANY_BRIDGE_HOME_URL'].includes(k) && /\/opt\/teamlink-enterprise|teamlink\.teamlinks\.in|\.teamlink-(uploads|backups|data|sandbox)/i.test(String(v)));
  add(mentions.length === 0, 'no setting names a TeamLink folder or address', mentions.map(([k]) => k).join(', '));
  return out;
}

async function main() {
  const envFile = val('--env');
  if (!envFile) { console.error('usage: node scripts/company-check.js --env <backend/.env of the company> --home <its HOME folder> [--teamlink-env <file>] [--port-free]'); process.exit(2); }
  const out = await check({ env: load(envFile), home: val('--home'), tl: load(val('--teamlink-env')), checkPort: has('--port-free') });
  let bad = 0;
  for (const r of out) {
    if (!r.ok) bad += 1;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.what}${r.detail ? `  [${r.detail}]` : ''}`);
  }
  console.log(bad ? `\n${bad} check(s) FAILED: this copy would share something with TeamLink. Fix them before starting it.` : '\nAll checks passed: nothing is shared with TeamLink.');
  process.exit(bad ? 1 : 0);
}

if (require.main === module) main().catch((e) => { console.error('[company-check]', e.message); process.exit(2); });
module.exports = { check, load };
