// ---------------------------------------------------------------------------
// Sets up the COMPANY SWITCHER on TeamLink's server (utils/companyBridge.js, docs/second-company.md section 9).
//
//   node scripts/company-bridge-setup.js --key nish --name "NISHTECHNOLOGIES INDIA PVT LTD" --url https://nish.teamlinks.in --public-out /tmp/bridge-public.pem
//   node scripts/company-bridge-setup.js --remove nish        (takes the company out of the menu; the key stays)
//   node scripts/company-bridge-setup.js --list
//
// It only creates / edits files in ONE folder (default ~/.teamlink-company-bridge, or --dir): private.pem (TeamLink's signing key, mode 600, made
// once) and companies.json (the menu). It never reads or writes any database and never prints the private key. The PUBLIC key is written to
// --public-out: that file (and only that one) is what the company's server is given.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const val = (n) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const has = (n) => args.includes(n);
const fail = (m) => { console.error(`[company-bridge-setup] ${m}`); process.exit(2); };

const dir = path.resolve(val('--dir') || process.env.COMPANY_BRIDGE_DIR || path.join(os.homedir(), '.teamlink-company-bridge'));
const pemFile = path.join(dir, 'private.pem');
const listFile = path.join(dir, 'companies.json');

function readList() { try { const v = JSON.parse(fs.readFileSync(listFile, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; } }
function writeList(list) { fs.writeFileSync(listFile, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o644 }); }

if (has('--list')) {
  const list = readList();
  console.log(list.length ? list.map((c) => `${c.key}  ${c.name}  ${c.url}`).join('\n') : '(no company is set up)');
  console.log(`private key: ${fs.existsSync(pemFile) ? 'present' : 'not made yet'}   folder: ${dir}`);
  process.exit(0);
}

fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

if (val('--remove')) {
  const key = String(val('--remove')).trim().toLowerCase();
  const list = readList();
  const rest = list.filter((c) => String(c.key).toLowerCase() !== key);
  if (rest.length === list.length) fail(`no company "${key}" in ${listFile}. Nothing changed.`);
  writeList(rest);
  console.log(`[company-bridge-setup] "${key}" is out of the Companies menu. (The key file was not touched.)`);
  process.exit(0);
}

const key = String(val('--key') || '').trim().toLowerCase();
const name = String(val('--name') || '').trim();
const url = String(val('--url') || '').trim().replace(/\/+$/, '');
if (!/^[a-z][a-z0-9-]{1,30}$/.test(key)) fail('--key is required: the company\'s short lower-case key, the same as its COMPANY_KEY (for example nish).');
if (!name) fail('--name is required (what the menu shows).');
if (!/^https:\/\/[^\s/]+$/i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url)) fail('--url is required: the company\'s address, https://... (http only for localhost).');

let madeKey = false;
if (!fs.existsSync(pemFile)) {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(pemFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  try { fs.chmodSync(pemFile, 0o600); } catch { /* Windows */ }
  madeKey = true;
}
const publicPem = crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(pemFile))).export({ type: 'spki', format: 'pem' });
const out = val('--public-out');
if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(path.resolve(out), publicPem, { mode: 0o644 }); }

const list = readList().filter((c) => String(c.key).toLowerCase() !== key);
list.push({ key, name, url });
writeList(list);

console.log(`[company-bridge-setup] ${madeKey ? 'made TeamLink\'s signing key' : 'kept the existing signing key'} (${pemFile}, mode 600; never copy it anywhere).`);
console.log(`[company-bridge-setup] "${name}" (${key}) is in the Companies menu: ${url}`);
console.log(out ? `[company-bridge-setup] the PUBLIC key for the company's server: ${path.resolve(out)}` : '[company-bridge-setup] (no --public-out given: the public key was not written anywhere)');
