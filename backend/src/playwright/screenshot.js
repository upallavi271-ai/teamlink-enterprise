// ---------------------------------------------------------------------------
// SCREENSHOTS (evidence for a person: a CAPTCHA page, a failed step, the DRY RUN form, the confirmation).
//
//   * EVERY publish attempt keeps at least one picture, success or failure (BasePortal.run takes a final one);
//   * saved as PNG in a PRIVATE folder outside the repo (TL_PORTAL_SCREENSHOT_DIR, default ~/.teamlink-portal-shots,
//     folder mode 0700), never in a web-served folder;
//   * password, one-time-code and CAPTCHA inputs are MASKED in every picture. A page that shows a password box is still
//     photographed, but then EVERY input on it is masked (the login name that was just typed is hidden too);
//   * a picture is only served through the API to someone who may see the job's logs (routes/jobPublish.js);
//   * retention: a picture older than `jobpublish.screenshotRetentionDays` (default 30) is deleted by the worker's
//     daily sweep (sweepOld) and its log row loses the link.
// Page-structure snapshots (.txt, see playwright/structure.js) live in the same folder and follow the same rules.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const sandbox = require('../utils/sandbox');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_RETENTION_DAYS = 30;
function root() {
  if (process.env.TL_PORTAL_SCREENSHOT_DIR) return path.resolve(process.env.TL_PORTAL_SCREENSHOT_DIR);
  const home = os.homedir() || os.tmpdir();
  return sandbox.isSandbox() ? path.join(home, '.teamlink-sandbox', 'portal-shots') : path.join(home, '.teamlink-portal-shots');
}
const safe = (s) => String(s || '').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40);
const insideRepo = (dir) => dir === REPO_ROOT || dir.startsWith(`${REPO_ROOT}${path.sep}`);

const ALWAYS_MASK = ['input[type=password]', 'input[autocomplete=one-time-code]', 'input[name*=otp i]', 'input[name*=captcha i]', 'input[name*=pass i]', 'input[name*=pwd i]', 'input[id*=otp i]'];

// -> a path relative to root() (what PostingLog.screenshotPath stores), or null when nothing was taken
async function shot(page, { queueId, portal, step, maskSelectors = [], log = null } = {}) {
  try {
    const dir = root();
    if (insideRepo(dir)) return null; // never inside the repo
    // a visible password box: the page may show what was just typed, so mask EVERY input on it (the picture is still kept).
    const pwVisible = await page.locator('input[type=password]:visible').count().catch(() => 0);
    const rel = path.join(safe(portal), `${safe(queueId)}-${safe(step)}-${Date.now().toString(36)}.png`);
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
    const sels = [...ALWAYS_MASK, ...maskSelectors, ...(pwVisible > 0 ? ['input', 'textarea'] : [])];
    const mask = sels.map((s) => page.locator(s));
    await page.screenshot({ path: abs, mask, maskColor: '#444444', timeout: 8000, fullPage: false });
    return rel.split(path.sep).join('/');
  } catch (err) {
    if (log) log.warn('screenshot', `Screenshot failed: ${String(err && err.message).split('\n')[0].slice(0, 120)}`);
    return null;
  }
}

// A text file (a page-structure snapshot) in the same private folder. -> relative path or null
function saveText({ queueId, portal, step, text }) {
  try {
    const dir = root();
    if (insideRepo(dir) || !text) return null;
    const rel = path.join(safe(portal), `${safe(queueId)}-${safe(step)}-${Date.now().toString(36)}.txt`);
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
    fs.writeFileSync(abs, String(text).slice(0, 80000), { mode: 0o600 });
    return rel.split(path.sep).join('/');
  } catch { return null; }
}

// A stored relative path -> a file inside root(), or null (anything that tries to leave the folder).
function resolve(rel) {
  const base = root();
  const abs = path.resolve(base, String(rel || ''));
  if (!abs.startsWith(base + path.sep)) return null;
  return fs.existsSync(abs) ? abs : null;
}
const kindOfPath = (rel) => (/\.txt$/i.test(String(rel || '')) ? 'structure' : 'image');

// Delete pictures older than `days`. -> { removed, paths: [relative paths] }. The caller clears the log rows.
function sweepOld(days = DEFAULT_RETENTION_DAYS, now = Date.now()) {
  const base = root();
  const out = { removed: 0, paths: [], kept: 0 };
  if (!(days > 0) || insideRepo(base) || !fs.existsSync(base)) return out;
  const cutoff = now - days * 86400000;
  let portals = [];
  try { portals = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
  portals.forEach((d) => {
    let files = [];
    try { files = fs.readdirSync(path.join(base, d.name)); } catch { files = []; }
    files.forEach((f) => {
      if (!/\.(png|txt)$/i.test(f)) return;
      const abs = path.join(base, d.name, f);
      try {
        if (fs.statSync(abs).mtimeMs < cutoff) { fs.unlinkSync(abs); out.removed += 1; out.paths.push(`${d.name}/${f}`); } else out.kept += 1;
      } catch { /* a file that vanished is fine */ }
    });
  });
  return out;
}

// How much is stored (for the diagnostics screen).
function usage() {
  const base = root();
  const out = { files: 0, bytes: 0, oldestAt: null };
  if (!fs.existsSync(base)) return out;
  try {
    fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).forEach((d) => {
      fs.readdirSync(path.join(base, d.name)).forEach((f) => {
        try {
          const st = fs.statSync(path.join(base, d.name, f));
          out.files += 1; out.bytes += st.size;
          if (!out.oldestAt || st.mtimeMs < out.oldestAt) out.oldestAt = st.mtimeMs;
        } catch { /* gone */ }
      });
    });
  } catch { /* unreadable */ }
  return out;
}

module.exports = {
  shot, saveText, resolve, root, kindOfPath, sweepOld, usage, ALWAYS_MASK, DEFAULT_RETENTION_DAYS,
};
