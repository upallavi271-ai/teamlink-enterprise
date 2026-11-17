// ---------------------------------------------------------------------------
// COMPANY SWITCHER ("Companies" menu, founder 2026-11-17: "one Super Admin in TeamLink, the other company has a sub Super Admin,
// and TeamLink must not be touched"). docs/second-company.md section 9.
//
// A separate company (NISH ...) is its OWN copy of this application with its OWN database. The switcher is a ONE-WAY door between them:
//
//   TeamLink (the home)  --signed pass, 60 seconds, once-->  the company
//
//   * TeamLink's Super Admin picks a company in the "Companies" menu. TeamLink signs a short pass (Ed25519) that names the company.
//   * The company checks the signature with TeamLink's PUBLIC key only, checks the pass is for ITS OWN key, not older than 2 minutes and
//     not used before, and then signs that Super Admin in as the company's "TeamLink owner" (a Super Admin of the company, nobody else's login).
//   * The company holds no secret that can make a pass, and TeamLink accepts no pass from anyone: there is no way from a company into TeamLink.
//
// Nothing in TeamLink's database or settings changes. The feature is OFF until two files exist on TeamLink's server (private.pem + companies.json,
// folder ~/.teamlink-company-bridge, or COMPANY_BRIDGE_DIR). On a company's server it is OFF until COMPANY_BRIDGE_PUBLIC_KEY_FILE is set.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PASS_SECONDS = 60;          // how long a pass lives when TeamLink signs it
const MAX_LIFETIME = 120;         // a company refuses a pass that claims to live longer than this
const SKEW_SECONDS = 30;          // clocks of the two programs may differ by this much
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

function bridgeDir() { return path.resolve(process.env.COMPANY_BRIDGE_DIR || path.join(os.homedir(), '.teamlink-company-bridge')); }

// ---- TeamLink's side (the one that signs) --------------------------------------------------------------------------------------------
let cache = { at: 0, v: null };
function readIssuer() {
  if (cache.v && Date.now() - cache.at < 5000) return cache.v;
  let v = { companies: [], privateKey: null };
  try {
    const dir = bridgeDir();
    const pem = path.join(dir, 'private.pem');
    const list = path.join(dir, 'companies.json');
    if (fs.existsSync(pem) && fs.existsSync(list)) {
      const privateKey = crypto.createPrivateKey(fs.readFileSync(pem));
      const raw = JSON.parse(fs.readFileSync(list, 'utf8'));
      const companies = (Array.isArray(raw) ? raw : [])
        .map((c) => ({ key: String(c.key || '').trim().toLowerCase(), name: String(c.name || '').trim(), url: String(c.url || '').trim().replace(/\/+$/, '') }))
        .filter((c) => /^[a-z][a-z0-9-]{1,30}$/.test(c.key) && c.name && /^https?:\/\/[^\s/]+/i.test(c.url));
      v = { companies, privateKey };
    }
  } catch { v = { companies: [], privateKey: null }; }
  cache = { at: Date.now(), v };
  return v;
}
const companiesForMenu = () => readIssuer().companies.map((c) => ({ key: c.key, name: c.name }));
const companyByKey = (key) => readIssuer().companies.find((c) => c.key === String(key || '').trim().toLowerCase()) || null;

// A pass for one company, signed for this one Super Admin. Returns the compact text that rides in the address fragment.
function signPass(company, who, now = Date.now()) {
  const { privateKey } = readIssuer();
  if (!privateKey) throw new Error('The company switcher is not set up on this server.');
  const iat = Math.floor(now / 1000);
  const payload = b64u(JSON.stringify({
    v: 1, iss: 'teamlink', aud: company.key, sub: String(who.id), name: String(who.name || ''), // no e-mail address: the company needs none and TeamLink's logins stay TeamLink's
    iat, exp: iat + PASS_SECONDS, jti: crypto.randomBytes(16).toString('hex'),
  }));
  const sig = crypto.sign(null, Buffer.from(payload), privateKey);
  return `${payload}.${b64u(sig)}`;
}

// ---- the company's side (the one that checks) ----------------------------------------------------------------------------------------
const companyKey = () => String(process.env.COMPANY_KEY || '').trim().toLowerCase();
let pubCache = { file: null, at: 0, key: null };
function publicKey() {
  const file = String(process.env.COMPANY_BRIDGE_PUBLIC_KEY_FILE || '').trim();
  if (!file) return null;
  if (pubCache.file === file && pubCache.key && Date.now() - pubCache.at < 5000) return pubCache.key;
  let key = null;
  try { key = crypto.createPublicKey(fs.readFileSync(file)); } catch { key = null; }
  pubCache = { file, at: Date.now(), key };
  return key;
}
// true only on a company's server that was given TeamLink's public key
const receiverOn = () => !!companyKey() && !!publicKey();
const homeUrl = () => String(process.env.COMPANY_BRIDGE_HOME_URL || '').trim().replace(/\/+$/, '') || null;

const used = new Map(); // jti -> expiry (ms): a pass works once
function sweep(now) { for (const [k, exp] of used) if (exp < now) used.delete(k); }

// Returns { ok:true, who } or { ok:false, why } (the why is for the audit log; the person is told one plain sentence).
function checkPass(text, now = Date.now()) {
  const pub = publicKey();
  const mine = companyKey();
  if (!pub || !mine) return { ok: false, why: 'not set up' };
  const parts = String(text || '').split('.');
  if (parts.length !== 2 || parts[0].length > 2000 || parts[1].length > 200) return { ok: false, why: 'malformed' };
  let good = false;
  try { good = crypto.verify(null, Buffer.from(parts[0]), pub, fromB64u(parts[1])); } catch { good = false; }
  if (!good) return { ok: false, why: 'bad signature' };
  let p;
  try { p = JSON.parse(fromB64u(parts[0]).toString('utf8')); } catch { return { ok: false, why: 'malformed' }; }
  if (!p || p.v !== 1 || p.iss !== 'teamlink') return { ok: false, why: 'wrong issuer' };
  if (String(p.aud || '').toLowerCase() !== mine) return { ok: false, why: 'for another company' };
  const t = Math.floor(now / 1000);
  if (!Number.isFinite(p.iat) || !Number.isFinite(p.exp) || p.exp - p.iat > MAX_LIFETIME || p.exp - p.iat <= 0) return { ok: false, why: 'bad lifetime' };
  if (t > p.exp + SKEW_SECONDS || t < p.iat - SKEW_SECONDS) return { ok: false, why: 'expired' };
  if (!p.sub || !p.jti || typeof p.jti !== 'string') return { ok: false, why: 'malformed' };
  sweep(now);
  if (used.has(p.jti)) return { ok: false, why: 'used before' };
  used.set(p.jti, (p.exp + SKEW_SECONDS) * 1000 + 1000);
  if (used.size > 5000) used.clear(); // a flood cannot grow this; a still-valid pass could then be replayed for at most 2 minutes, and only by someone who already holds it
  return { ok: true, who: { id: String(p.sub).slice(0, 80), name: String(p.name || '').slice(0, 120) } };
}

// The login this Super Admin gets INSIDE the company. No Employee record (so the company's headcount and attendance stay its own),
// a password nobody knows (the only way in is a pass), and the address is not a mailbox (@bridge.invalid).
const ownerEmail = (subId) => `teamlink-owner+${String(subId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24).toLowerCase()}@bridge.invalid`;
const isOwnerEmail = (email) => /^teamlink-owner\+[a-z0-9]+@bridge\.invalid$/i.test(String(email || ''));

module.exports = {
  PASS_SECONDS, bridgeDir, companiesForMenu, companyByKey, signPass, checkPass, receiverOn, homeUrl, ownerEmail, isOwnerEmail,
  _reset: () => { cache = { at: 0, v: null }; pubCache = { file: null, at: 0, key: null }; used.clear(); },
};
