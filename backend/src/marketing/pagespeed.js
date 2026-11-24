// ---------------------------------------------------------------------------
// AI MARKETING > SEO & VISIBILITY > WEBSITE CHECK > GOOGLE PAGESPEED (2026-11-24). The "mobile-friendliness and page-speed checks" of the services document, with Google's free PageSpeed Insights API
// (it runs Lighthouse, which is open source, on Google's servers): the page is measured on a phone-sized and a desktop run, 0 to 100 for Performance, Accessibility, Best practices and SEO, the five lab
// numbers (first contentful paint, largest contentful paint, total blocking time, layout shift, speed index), what costs the most time, and (when Google has it for the site) what real visitors' browsers saw.
//   key    OPTIONAL. The API works without one at low volume; Google's shared allowance is often used up, so an Admin can add a free key (Administration > Integrations > "Website speed (Google PageSpeed)").
//          The key is only sent to Google; it is never shown to the browser. A refused key or an used-up allowance is said in words.
//   cost   none. Each run is two calls (mobile, desktop) and takes 20 to 50 seconds; 10 runs an hour per person.
// HONEST: the numbers are Google's lab measurement of ONE page at one moment; they change from run to run and are not a ranking. The result can be attached to a saved website check and then appears in the
// monthly report. Nothing is changed on the website.
// ---------------------------------------------------------------------------
const Site = require('./siteCheck');
const { assertSafeUrl } = require('../utils/safeFetch');

const API = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const KEY_LABEL = 'PageSpeed API key';
const CATS = [['performance', 'Performance'], ['accessibility', 'Accessibility'], ['best-practices', 'Best practices'], ['seo', 'SEO']];
const METRICS = [['first-contentful-paint', 'First contentful paint'], ['largest-contentful-paint', 'Largest contentful paint'], ['total-blocking-time', 'Total blocking time'], ['cumulative-layout-shift', 'Layout shift'], ['speed-index', 'Speed index']];
const FIELD = { LARGEST_CONTENTFUL_PAINT_MS: 'Largest contentful paint', CUMULATIVE_LAYOUT_SHIFT_SCORE: 'Layout shift', INTERACTION_TO_NEXT_PAINT: 'Interaction to next paint', FIRST_CONTENTFUL_PAINT_MS: 'First contentful paint' };
const CAT_WORDS = { FAST: 'Good', AVERAGE: 'Needs work', SLOW: 'Poor' };
const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const rate = (score) => (score == null ? 'n/a' : score >= 0.9 ? 'good' : score >= 0.5 ? 'work' : 'poor'); // Lighthouse's own bands for a single score

async function keyOf() {
  if (String(process.env.MK_PAGESPEED_KEY || '').trim()) return String(process.env.MK_PAGESPEED_KEY).trim();
  try { const c = await require('../utils/integrationStore').readConfig('google-pagespeed'); return String((c.values || {})[KEY_LABEL] || '').trim(); } catch { return ''; } // eslint-disable-line global-require
}
const status = async () => ({ keySet: Boolean(await keyOf()) });

// the answer of Google -> the small result the screen shows
function shape(j, strategy) {
  const lr = j && j.lighthouseResult; if (!lr || !lr.categories) return null;
  const A = lr.audits || {}; const scores = CATS.map(([k, label]) => { const c = lr.categories[k]; return { key: k, label, score: c && c.score != null ? Math.round(c.score * 100) : null }; });
  const metrics = METRICS.map(([k, label]) => { const a = A[k] || {}; return { key: k, label, display: clean(a.displayValue, 30) || 'n/a', value: a.numericValue == null ? null : Math.round(a.numericValue * 1000) / 1000, rating: rate(a.score) }; });
  const opportunities = Object.entries(A).filter(([, a]) => a && a.details && a.details.type === 'opportunity' && Number(a.details.overallSavingsMs) > 0).map(([id, a]) => ({ id, title: clean(a.title, 120), display: clean(a.displayValue, 60), savingsMs: Math.round(a.details.overallSavingsMs) })).sort((a, b) => b.savingsMs - a.savingsMs).slice(0, 6);
  const issues = []; for (const [k, label] of CATS) { const c = lr.categories[k]; for (const ref of (c && c.auditRefs) || []) { const a = A[ref.id]; if (a && ref.weight > 0 && a.score != null && a.score < 0.9 && !(a.details && a.details.type === 'opportunity')) issues.push({ category: label, title: clean(a.title, 120), display: clean(a.displayValue, 60), loss: ref.weight * (1 - a.score) }); } }
  issues.sort((a, b) => b.loss - a.loss);
  const le = j.loadingExperience; let field = null;
  if (le && le.metrics && Object.keys(le.metrics).length) field = { overall: CAT_WORDS[le.overall_category] || '', metrics: Object.entries(le.metrics).filter(([k]) => FIELD[k]).map(([k, m]) => ({ label: FIELD[k], value: m.percentile, category: CAT_WORDS[m.category] || m.category || '' })) };
  return { strategy, finalUrl: clean(lr.finalUrl, 300), fetchedAt: lr.fetchTime || null, lighthouse: clean(lr.lighthouseVersion, 20), scores, metrics, opportunities, issues: issues.slice(0, 8).map(({ category, title, display }) => ({ category, title, display })), field, warnings: (lr.runWarnings || []).slice(0, 3).map((w) => clean(w, 200)) };
}
function failure(status, body) {
  const msg = String((body && body.error && body.error.message) || ''); const reason = String((body && body.error && body.error.errors && body.error.errors[0] && body.error.errors[0].reason) || '');
  if (status === 429 || /quota|rate.?limit/i.test(msg + reason)) return { error: "Google's free PageSpeed allowance is used up for now. Try again later, or ask an Admin to add a free key (Administration > Integrations > Website speed).", status: 429, code: 'quota' };
  if (/api key|keyInvalid|API_KEY/i.test(msg + reason) && status < 500) return { error: 'Google refused the PageSpeed key. An Admin should check it in Administration > Integrations > Website speed.', status: 502, code: 'key' };
  if (status === 400 && /lighthouse|document_request|dns|unable to|could not|failed/i.test(msg)) return { error: `Google could not load that page. (Google said: ${clean(msg, 160)})`, status: 502, code: 'page' };
  if (status >= 500) return { error: "Google's PageSpeed service had a problem. Try again in a minute.", status: 502, code: 'google' };
  return { error: `Google answered with an error (${status}).`, status: 502, code: 'other' };
}
async function one(url, strategy, key, opts) {
  const fetchFn = opts.fetchFn || fetch; const q = new URLSearchParams({ url, strategy }); for (const [k] of CATS) q.append('category', k); if (key) q.set('key', key);
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), opts.ms || 55000); let res;
  try { res = await fetchFn(`${API}?${q.toString()}`, { headers: { accept: 'application/json' }, signal: ctl.signal }); }
  catch (e) { return { error: e.name === 'AbortError' ? 'Google did not answer in time (PageSpeed can take up to a minute). Try again.' : 'Google PageSpeed could not be reached right now.', status: 502, code: 'timeout' }; } finally { clearTimeout(timer); }
  let j = null; try { j = await res.json(); } catch { /* not JSON */ }
  if (res.status >= 400) return failure(res.status, j);
  const out = shape(j, strategy); return out || { error: 'Google sent an answer that could not be read.', status: 502, code: 'shape' };
}
// url: the page; mobile and desktop are run together. opts: { fetchFn, ms, assert } (a test answers instead of Google)
async function run(input, opts = {}) {
  const c = Site.cleanUrl(input); if (c.error) return c;
  try { await (opts.assert || assertSafeUrl)(c.url); } catch (e) { return { error: e.message, status: 400 }; }
  const key = await keyOf();
  const [mobile, desktop] = await Promise.all([one(c.url, 'mobile', key, opts), one(c.url, 'desktop', key, opts)]);
  if (mobile.error && desktop.error) return mobile;
  return { url: c.url, keyUsed: Boolean(key), mobile: mobile.error ? { error: mobile.error } : mobile, desktop: desktop.error ? { error: desktop.error } : desktop, ranAt: new Date().toISOString(),
    note: "Google's lab measurement of this one page at this moment (Lighthouse, open source). The numbers change from run to run and are not a ranking." };
}
// the Test button of the card: a real run on a tiny public page, performance only
async function testKey(opts = {}) {
  const key = await keyOf(); if (!key) return { ok: false, text: 'No key is saved. (The tool also works without a key at low volume.)' };
  const r = await one('https://example.com/', 'desktop', key, { ...opts, ms: 55000 });
  return r.error ? { ok: false, text: r.error } : { ok: true, text: `The key works. Google measured example.com (Performance ${(r.scores.find((x) => x.key === 'performance') || {}).score}).` };
}
// a small version of a run, kept with a saved website check and shown in the monthly report
const compact = (r) => ({ ranAt: r.ranAt, ...Object.fromEntries(['mobile', 'desktop'].map((k) => [k, r[k] && !r[k].error ? { scores: r[k].scores, metrics: r[k].metrics.map((m) => ({ label: m.label, display: m.display, rating: m.rating })), issues: r[k].issues.slice(0, 5) } : null])) });
module.exports = { run, status, testKey, shape, compact, failure, KEY_LABEL };
