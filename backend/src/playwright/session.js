// ---------------------------------------------------------------------------
// BROWSER SESSIONS (one persistent profile per portal).
//
// The worker reuses the cookies of ONE Chrome profile per portal, so it signs in once and stays signed in. The profile
// folder holds the portal's cookies IN THE CLEAR (Chrome does that; they cannot be encrypted by us), so:
//   * it lives OUTSIDE the repo, in the machine user's own home folder (never committed, never deployed);
//   * on the VPS it is a private folder owned by the worker's user (chmod 700): see docs/job-publishing/SECURITY.md;
//   * `npm run portal-session -- <portal>` is how a PERSON signs in (CAPTCHA, OTP, 2-step): they type everything
//     themselves in a visible Chrome window; the worker then only reuses the cookies.
//
//   TL_PORTAL_PROFILE_DIR   the parent folder (default ~/.teamlink-portal-sessions, in the sandbox ~/.teamlink-sandbox/portal-sessions)
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const sandbox = require('../utils/sandbox');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function profileRoot() {
  if (process.env.TL_PORTAL_PROFILE_DIR) return path.resolve(process.env.TL_PORTAL_PROFILE_DIR);
  const home = os.homedir() || os.tmpdir();
  return sandbox.isSandbox() ? path.join(home, '.teamlink-sandbox', 'portal-sessions') : path.join(home, '.teamlink-portal-sessions');
}
const inside = (child, parent) => { const rel = path.relative(parent, child); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };

function profileDir(portal) {
  if (!/^[a-z0-9_-]{2,30}$/i.test(String(portal || ''))) throw new Error('Bad portal name');
  const dir = path.join(profileRoot(), portal);
  // a browser profile holds cookies: never inside the repository (it would be committed or deployed)
  if (dir === REPO_ROOT || inside(dir, REPO_ROOT)) throw new Error(`The browser profile folder must be outside the repository (${dir}). Set TL_PORTAL_PROFILE_DIR.`);
  return dir;
}
function ensureDir(portal) {
  const dir = profileDir(portal);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
function hasSession(portal) {
  try { return fs.readdirSync(profileDir(portal)).length > 0; } catch { return false; }
}
function clearSession(portal) {
  const dir = profileDir(portal);
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

// What the diagnostics screen shows: is a session saved and when was it last used? (the newest file time in the profile's
// cookie store, else the profile folder). -> { saved, lastUsedAt (ms|null), ageHours }
function info(portal) {
  const out = { saved: false, lastUsedAt: null, ageHours: null };
  try {
    const dir = profileDir(portal);
    if (!fs.existsSync(dir) || !fs.readdirSync(dir).length) return out;
    out.saved = true;
    const cands = [path.join(dir, 'Default', 'Network', 'Cookies'), path.join(dir, 'Default', 'Cookies'), path.join(dir, 'Default', 'Preferences'), dir];
    const times = cands.map((p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }).filter(Boolean);
    out.lastUsedAt = times.length ? Math.max(...times) : null;
    out.ageHours = out.lastUsedAt ? Math.round(((Date.now() - out.lastUsedAt) / 3600000) * 10) / 10 : null;
  } catch { /* unreadable: treated as no session */ }
  return out;
}

module.exports = { profileRoot, profileDir, ensureDir, hasSession, clearSession, info };
