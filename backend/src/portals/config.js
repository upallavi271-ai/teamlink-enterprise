// ---------------------------------------------------------------------------
// PAGE SETTINGS OF A PORTAL (selectors + URLs + wording), loaded from JSON.
//
// EVERY selector and URL lives in a JSON file, not in code, so a portal that changes its page is fixed by editing a
// file. Where it is looked for, first match wins:
//   1. env TL_PORTAL_SELECTORS_<PORTAL>      a file path (tests point this at the local mock portal's settings)
//   2. <selectors dir>/<portal>.json         env TL_PORTAL_SELECTORS_DIR, or the AppSetting jobpublish.selectorsDir
//   3. src/portals/selectors/<portal>.json   the built-in ones
// A selector entry may be one string or a list of alternatives (the first one that is visible wins).
// "{{MOCK_ORIGIN}}" in a value is replaced by env TL_MOCK_PORTAL_ORIGIN (the local mock portal's address).
// See docs/job-publishing/PLAYWRIGHT.md ("Tuning selectors").
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const S = require('../jobPublish/settings');
const entries = require('../playwright/locate');

const BUILT_IN = path.join(__dirname, 'selectors');

const clone = (o) => JSON.parse(JSON.stringify(o));
function subst(v) {
  if (typeof v === 'string') return v.replace(/\{\{MOCK_ORIGIN\}\}/g, process.env.TL_MOCK_PORTAL_ORIGIN || 'http://127.0.0.1:0');
  if (Array.isArray(v)) return v.map(subst);
  if (v && typeof v === 'object') { const o = {}; Object.keys(v).forEach((k) => { o[k] = subst(v[k]); }); return o; }
  return v;
}

async function locate(portal) {
  const envFile = process.env[`TL_PORTAL_SELECTORS_${String(portal).toUpperCase()}`];
  if (envFile) return { file: path.resolve(envFile), origin: 'env' };
  const dir = await S.selectorsDir().catch(() => null);
  if (dir) {
    const f = path.join(path.resolve(dir), `${portal}.json`);
    if (fs.existsSync(f)) return { file: f, origin: 'folder' };
  }
  return { file: path.join(BUILT_IN, `${portal}.json`), origin: 'built-in' };
}

// Only what a run cannot work without. -> list of problems in plain words
function problems(cfg) {
  const out = [];
  const need = (p, label) => {
    const v = p.split('.').reduce((o, k) => (o ? o[k] : undefined), cfg);
    if (v === undefined || v === null || (Array.isArray(v) && !v.length) || v === '') out.push(label || p);
  };
  ['urls.login', 'urls.postJob', 'login.username', 'login.password', 'login.submit', 'login.loggedInProbe', 'postJob.fields.title', 'postJob.fields.description', 'postJob.submit', 'allowedHosts']
    .forEach((p) => need(p));
  if (cfg.postJob && !cfg.postJob.success) out.push('postJob.success');
  // every selector entry must be a string or a { role | label | text | placeholder | testId | css } object
  stepList(cfg).forEach((st) => { entries.check(st.list, st.key).forEach((p) => out.push(p)); });
  return out;
}

// ---- selector coverage: every step the runner looks for, with how many different ways it has to find it ------------
const FIELD_WORDS = {
  title: 'Job title box', company: 'Company box', skills: 'Skills box', experienceMin: 'Experience from', experienceMax: 'Experience to', location: 'City box', employmentType: 'Job type',
  salaryMin: 'Pay from', salaryMax: 'Pay to', salary: 'Pay', openings: 'Number of openings', industry: 'Industry', functionalArea: 'Department / area', education: 'Education', description: 'Job description box',
  contactEmail: 'Contact e-mail box', workMode: 'Work mode', applyUrl: 'Apply link box',
};
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
// -> [{ key, label, list }]  (the keys are the ones BasePortal records while it runs)
function stepList(cfg) {
  const out = [];
  const add = (key, label, list) => { if (arr(list).length) out.push({ key, label, list: arr(list) }); };
  const L = (cfg && cfg.login) || {};
  add('login.username', 'Sign-in: login name box', L.username);
  add('login.password', 'Sign-in: password box', L.password);
  add('login.submit', 'Sign-in: button', L.submit);
  const P = (cfg && cfg.postJob) || {};
  Object.keys(P.fields || {}).forEach((n) => add(`field.${n}`, `Form: ${FIELD_WORDS[n] || n}`, P.fields[n].selector));
  (P.steps || []).forEach((g, i) => { if (g.next && i < P.steps.length - 1) add(`form.next.${i + 1}`, `Form: "Next" button (page ${i + 1})`, g.next); });
  add('post.submit', 'Form: Post / Submit button', P.submit);
  if (P.submitEdit) add('post.submitEdit', 'Form: Save / Update button', P.submitEdit);
  const U = (cfg && cfg.unpublish) || {};
  add('close.row', 'Take down: the job row', U.rowSelector);
  add('close.button', 'Take down: Close button', U.closeButton);
  return out;
}
// -> [{ key, label, count, families: ['role','css',...], thin, textless, bad }]  thin = fewer than 2 ways;  textless = no role / label / text way
function coverage(cfg) {
  return stepList(cfg).map((st) => {
    const families = [...new Set(st.list.map(entries.family).filter(Boolean))];
    return {
      key: st.key, label: st.label, count: st.list.length, families, thin: st.list.length < 2, textless: !families.some((f) => ['role', 'label', 'text'].includes(f)), bad: entries.check(st.list, st.key).length,
    };
  });
}

// -> { ok, cfg, file, origin, problems }
async function load(portal) {
  const where = await locate(portal);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(where.file, 'utf8')); } catch (err) {
    return { ok: false, portal, file: where.file, origin: where.origin, problems: [`the page settings file cannot be read (${err.code || err.message})`], cfg: null };
  }
  const cfg = subst(clone(raw));
  const probs = problems(cfg);
  return { ok: probs.length === 0, portal, file: where.file, origin: where.origin, problems: probs, cfg, version: cfg.version || null, verified: !!cfg.verified };
}
// the file's coverage without the full load (no settings read): used by the diagnostics screen
function coverageOf(cfg) {
  return coverage(cfg);
}

module.exports = { load, locate, problems, BUILT_IN, stepList, coverage, coverageOf, FIELD_WORDS };
