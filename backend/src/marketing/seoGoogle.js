// ---------------------------------------------------------------------------
// AI MARKETING > SEO ASSISTANT > GOOGLE SEARCH CONSOLE AND GOOGLE ANALYTICS 4 (2026-11-25, phase 2). The real numbers, read straight from Google with the service account of googleAuth.js (free APIs, read-only):
//   * SEARCH CONSOLE  the queries people used (clicks, impressions, click-through rate, average position) for the last 28 days: kept as a dated snapshot in the same tables the pasted CSV uses (seoKeywords.js),
//                     so keyword positions, changes and opportunities work the same; the property's own totals for the last 28 days and the 28 days before; the daily clicks and impressions for the chart;
//   * ANALYTICS 4     sessions, users, page views and engaged sessions for the last 28 days and the 28 days before, the sessions and users that came from Organic Search, and the 10 most viewed pages.
// A site names its Search Console property and its GA4 property number (Site and schedule). "Sync now" reads both; a site on an automatic audit schedule is read again after each audit (seoSchedule.js), and
// a bell rings when search clicks fell by 30% or more (and there were at least 50 before).
// HONEST BY DESIGN: every number is what Google answered for a stated period: nothing is estimated, a number Google did not give is left out, a drop is a measurement and never a cause. The data of the last
// 2 days is not final, so the Search Console period ends 3 days ago. Failures are said in words (key refused, API not switched on, the client has not added the service account, quota).
// saved: table OmniMkSeoGoogle (the newest answer per site; the query snapshots are in OmniMkSeoRankSet / OmniMkSeoRank).
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const Sites = require('./seoSites');
const Kw = require('./seoKeywords');
const GA = require('./googleAuth');
const { logAudit } = require('../utils/audit');

const T = 'OmniMkSeoGoogle';
const DDL = [`CREATE TABLE IF NOT EXISTS "${T}" ("siteId" TEXT NOT NULL PRIMARY KEY, "gsc" TEXT, "ga4" TEXT, "gscAt" DATETIME NOT NULL DEFAULT 0, "ga4At" DATETIME NOT NULL DEFAULT 0, "gscError" TEXT, "ga4Error" TEXT)`];
let okAt = 0;
async function ensure() { if (okAt && Date.now() - okAt < 600000) return true; try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] seo google schema:', e.message); return false; } } // eslint-disable-line no-await-in-loop, no-console

const GSC = 'https://www.googleapis.com/webmasters/v3/sites';
const GA4 = 'https://analyticsdata.googleapis.com/v1beta/properties';
const SOURCE = 'Google Search Console API';
const DAY = 86400000;
const DROP_PCT = 30; const DROP_MIN = 50; // a bell when search clicks fell by 30% or more and there were at least 50 clicks before
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const round1 = (n) => Math.round(n * 10) / 10;
const pct = (now, before) => (before != null && before > 0 && now != null ? round1(((now - before) / before) * 100) : null);

// the two 28-day periods: Search Console's ends 3 days ago (the newest 2 days are not final), Analytics' ends yesterday
function periods(kind, nowMs = Date.now()) {
  const end = nowMs - (kind === 'gsc' ? 3 : 1) * DAY; const start = end - 27 * DAY; const bEnd = start - DAY; const bStart = bEnd - 27 * DAY;
  return { now: { start: day(start), end: day(end) }, before: { start: day(bStart), end: day(bEnd) } };
}

// what Google said, in plain words. api: 'gsc' | 'ga4'
function explain(api, status, j, email) {
  const e = (j && j.error) || {}; const msg = String(e.message || (typeof e === 'string' ? e : '') || ''); const det = JSON.stringify(e.details || e.errors || '').slice(0, 400);
  const who = email || 'the service account'; const name = api === 'gsc' ? 'Google Search Console API' : 'Google Analytics Data API';
  if (status === 401) return { error: 'Google refused the access. The key may have been deleted: make a new JSON key and paste it again in Administration > Integrations.', status: 502, code: 'auth' };
  if (status === 403 && /has not been used|SERVICE_DISABLED|is disabled|accessNotConfigured/i.test(`${msg} ${det}`)) return { error: `The "${name}" is not switched on in the Google Cloud project of the key. Open APIs & Services > Library, search for it, press Enable, wait a few minutes and try again.`, status: 502, code: 'api_off' };
  if (status === 403) return { error: api === 'gsc' ? `Google says ${who} may not read that Search Console property. Ask the client to add it: Search Console > Settings > Users and permissions > Add user, with the email ${who} (Restricted is enough).` : `Google says ${who} may not read that Analytics property. Ask the client to add it: Analytics > Admin > Property access management > Add, with the email ${who} as a Viewer.`, status: 502, code: 'no_access' };
  if (status === 404) return { error: api === 'gsc' ? 'Google does not know that Search Console property. Choose it again from the list.' : 'Google does not know that Analytics property number. Check it in Analytics > Admin > Property settings.', status: 502, code: 'not_found' };
  if (status === 400) return { error: api === 'gsc' ? `Google did not accept the request for that property (${msg.slice(0, 120) || 'bad request'}).` : `Google did not accept the Analytics request (${msg.slice(0, 120) || 'bad request'}). Check the property number.`, status: 502, code: 'bad' };
  if (status === 429) return { error: "Google's free quota is used up for now. Try again in a while.", status: 502, code: 'quota' };
  if (status >= 500) return { error: 'Google had a problem. Try again in a few minutes.', status: 502, code: 'google' };
  return { error: `Google answered with an error (${status}).`, status: 502, code: 'other' };
}
// one call to a Google API with a token. -> the JSON | { error, status, code }
async function call(api, method, url, body, opts = {}) {
  const t = await GA.accessToken(opts); if (t.error) return t;
  const fetchFn = GA.fetchOf(opts); if (!fetchFn) return { error: GA.SANDBOX_WORDS, status: 503, code: 'sandbox' };
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), opts.ms || 40000); let res;
  try { res = await fetchFn(url, { method, headers: { authorization: `Bearer ${t.token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: ctl.signal }); }
  catch (e) { return { error: e.name === 'AbortError' ? 'Google did not answer in time. Try again.' : 'Google could not be reached right now.', status: 502, code: 'net' }; } finally { clearTimeout(timer); }
  let j = null; try { j = await res.json(); } catch { /* not JSON */ }
  if (res.status >= 400) return explain(api, res.status, j, t.email);
  return j || {};
}

// ---- Search Console ---------------------------------------------------------------------------------------------------------------------------------------------
// the properties the service account has been added to (not the unverified ones)
async function properties(opts = {}) {
  const j = await call('gsc', 'GET', GSC, null, opts); if (j.error) return j;
  const items = (j.siteEntry || []).filter((s) => s && s.siteUrl && s.permissionLevel !== 'siteUnverifiedUser').map((s) => ({ property: String(s.siteUrl), level: String(s.permissionLevel || '') })).sort((a, b) => a.property.localeCompare(b.property));
  return { items };
}
// the service account is added by every client, so its list holds every client's property: an Admin sees all of them; anyone else only the properties of websites they may see (their SEO sites, and the address typed in the form)
const hostOfProp = (p) => { if (/^sc-domain:/i.test(p)) return p.slice(10).toLowerCase(); try { return new URL(p).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
async function visibleProperties(u, items, url) {
  if (require('../outreach/access').isAdmin(u)) return items; // eslint-disable-line global-require
  const hosts = new Set(); const add = (x) => { try { hosts.add(new URL(x).hostname.toLowerCase().replace(/^www\./, '')); } catch { /* not an address */ } };
  for (const s of (await Sites.list(u)).items || []) add(s.url);
  if (url) { const c = require('./siteCheck').cleanUrl(url); if (c.url) add(c.url); } // eslint-disable-line global-require
  return items.filter((x) => hosts.has(hostOfProp(x.property)));
}
// the property that fits a website address best: the domain property, else the address with or without www
function suggestProperty(url, items) {
  let host = ''; try { host = new URL(url).hostname.toLowerCase(); } catch { try { host = new URL(require('./siteCheck').cleanUrl(url).url).hostname.toLowerCase(); } catch { return null; } } const bare = host.replace(/^www\./, '');
  const list = (items || []).map((x) => x.property);
  return list.find((p) => p.toLowerCase() === `sc-domain:${bare}`) || list.find((p) => { try { return new URL(p).hostname.toLowerCase().replace(/^www\./, '') === bare; } catch { return false; } }) || null;
}
const gscUrl = (property) => `${GSC}/${encodeURIComponent(property)}/searchAnalytics/query`;
const rowsOf = (j) => (Array.isArray(j.rows) ? j.rows : []);
const total = (r) => (r ? { clicks: num(r.clicks) || 0, impressions: num(r.impressions) || 0, ctr: r.ctr != null ? round1(num(r.ctr) * 100) : null, position: r.position != null ? round1(num(r.position)) : null } : { clicks: 0, impressions: 0, ctr: null, position: null });

// read Search Console for a site: { gsc } | { error }. site: the raw SEO site row; opts: { fetchFn, now, user }
async function syncGsc(u, site, opts = {}) {
  const property = site.gscProperty; if (!property) return { error: 'Choose the Search Console property first (Site and schedule).', status: 400, code: 'no_property' };
  const p = periods('gsc', opts.now); const q = (body) => call('gsc', 'POST', gscUrl(property), { ...body }, opts);
  const queries = await q({ startDate: p.now.start, endDate: p.now.end, dimensions: ['query'], rowLimit: 1000, dataState: 'final' }); if (queries.error) return queries;
  const now = await q({ startDate: p.now.start, endDate: p.now.end, dataState: 'final' }); if (now.error) return now;
  const before = await q({ startDate: p.before.start, endDate: p.before.end, dataState: 'final' }); if (before.error) return before;
  const daily = await q({ startDate: p.now.start, endDate: p.now.end, dimensions: ['date'], rowLimit: 100, dataState: 'final' }); if (daily.error) return daily;
  const rows = rowsOf(queries).map((r) => ({ query: S.clip(r.keys && r.keys[0], 160), clicks: num(r.clicks) || 0, impressions: num(r.impressions) || 0, ctr: r.ctr != null ? round1(num(r.ctr) * 100) : null, position: r.position != null ? round1(num(r.position)) : null })).filter((r) => r.query);
  const totals = total(rowsOf(now)[0]); const prev = total(rowsOf(before)[0]);
  let snapshot = null; if (rows.length) snapshot = await Kw.storeSnapshot(site, u, rows, { label: `Search Console API: ${p.now.start} to ${p.now.end}`, periodEnd: p.now.end, source: SOURCE, clicks: totals.clicks, impressions: totals.impressions, replace: true });
  const series = rowsOf(daily).map((r) => ({ date: String(r.keys && r.keys[0]), clicks: num(r.clicks) || 0, impressions: num(r.impressions) || 0 })).sort((a, b) => a.date.localeCompare(b.date));
  const gsc = { property, period: p.now, before: p.before, totals, beforeTotals: prev, change: { clicks: pct(totals.clicks, prev.clicks), impressions: pct(totals.impressions, prev.impressions) }, series, queries: rows.length, snapshotId: snapshot ? snapshot.id : null, syncedAt: new Date(opts.now || Date.now()).toISOString() };
  await save(site.id, { gsc, gscAt: opts.now || Date.now(), gscError: '' });
  return { gsc };
}

// ---- Analytics 4 -----------------------------------------------------------------------------------------------------------------------------------------------
const METRICS = [['sessions', 'sessions'], ['activeUsers', 'users'], ['screenPageViews', 'pageViews'], ['engagedSessions', 'engagedSessions']];
function metricMap(j, row) { const out = {}; (j.metricHeaders || []).forEach((h, i) => { const m = METRICS.find((x) => x[0] === h.name); if (m) out[m[1]] = num(row.metricValues && row.metricValues[i] && row.metricValues[i].value); }); return out; }
async function syncGa4(site, opts = {}) {
  const id = site.ga4Property; if (!id) return { error: 'Write the Google Analytics property number first (Site and schedule).', status: 400, code: 'no_property' };
  const p = periods('ga4', opts.now); const url = `${GA4}/${encodeURIComponent(id)}:runReport`; const ranges = [{ startDate: p.now.start, endDate: p.now.end, name: 'now' }, { startDate: p.before.start, endDate: p.before.end, name: 'before' }];
  const a = await call('ga4', 'POST', url, { dateRanges: ranges, metrics: METRICS.map((m) => ({ name: m[0] })) }, opts); if (a.error) return a;
  const b = await call('ga4', 'POST', url, { dateRanges: ranges, dimensions: [{ name: 'sessionDefaultChannelGroup' }], metrics: [{ name: 'sessions' }, { name: 'activeUsers' }] }, opts); if (b.error) return b;
  const c = await call('ga4', 'POST', url, { dateRanges: [ranges[0]], dimensions: [{ name: 'pagePath' }], metrics: [{ name: 'screenPageViews' }], orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }], limit: 10 }, opts); if (c.error) return c;
  const totals = { now: {}, before: {} }; const organic = { now: {}, before: {} };
  for (const r of a.rows || []) { const name = r.dimensionValues && r.dimensionValues[r.dimensionValues.length - 1] && r.dimensionValues[r.dimensionValues.length - 1].value; if (name === 'now' || name === 'before') totals[name] = metricMap(a, r); }
  for (const r of b.rows || []) { const dv = r.dimensionValues || []; if (String(dv[0] && dv[0].value) !== 'Organic Search') continue; const name = dv[dv.length - 1] && dv[dv.length - 1].value; if (name === 'now' || name === 'before') organic[name] = metricMap(b, r); }
  const topPages = (c.rows || []).map((r) => ({ path: S.clip(r.dimensionValues && r.dimensionValues[0] && r.dimensionValues[0].value, 160), views: num(r.metricValues && r.metricValues[0] && r.metricValues[0].value) })).filter((x) => x.path && x.views != null);
  const ch = (k, g) => pct(g.now[k] != null ? g.now[k] : null, g.before[k] != null ? g.before[k] : null);
  const ga4 = { property: id, period: p.now, before: p.before, totals, organic, topPages, change: { sessions: ch('sessions', totals), users: ch('users', totals), pageViews: ch('pageViews', totals), organicSessions: ch('sessions', organic) }, syncedAt: new Date(opts.now || Date.now()).toISOString() };
  await save(site.id, { ga4, ga4At: opts.now || Date.now(), ga4Error: '' });
  return { ga4 };
}

// ---- keeping and reading the newest answers ---------------------------------------------------------------------------------------------------------------------
async function save(siteId, p) {
  if (!(await ensure())) return;
  if (!(await S.q(`SELECT siteId FROM "${T}" WHERE siteId = ?`, siteId))[0]) await S.run(`INSERT INTO "${T}" (siteId) VALUES (?)`, siteId);
  const cols = []; const args = [];
  for (const [k, v] of Object.entries(p)) { if (!['gsc', 'ga4', 'gscAt', 'ga4At', 'gscError', 'ga4Error'].includes(k)) continue; cols.push(`${k} = ?`); args.push(k === 'gsc' || k === 'ga4' ? JSON.stringify(v) : v); }
  if (cols.length) await S.run(`UPDATE "${T}" SET ${cols.join(', ')} WHERE siteId = ?`, ...args, siteId);
}
async function stored(siteId) {
  if (!(await ensure())) return null; const r = (await S.q(`SELECT * FROM "${T}" WHERE siteId = ?`, siteId))[0]; if (!r) return null;
  return { gsc: S.parse(r.gsc, null), ga4: S.parse(r.ga4, null), gscAt: S.num(r.gscAt) ? S.iso(r.gscAt) : null, ga4At: S.num(r.ga4At) ? S.iso(r.ga4At) : null, gscError: r.gscError || '', ga4Error: r.ga4Error || '' };
}
// the bell for a fall in search clicks: [{ kind, title, message }] (pure)
function alertsOf(clientName, gsc) {
  if (!gsc || !gsc.beforeTotals || !gsc.totals) return [];
  const b = gsc.beforeTotals.clicks; const n = gsc.totals.clicks; if (b < DROP_MIN || n > b * (1 - DROP_PCT / 100)) return [];
  const drop = Math.round(((b - n) / b) * 100);
  return [{ kind: 'clicks', title: `Search clicks dropped: ${clientName}`, message: `Google Search Console shows ${n} clicks from search for ${clientName} in ${gsc.period.start} to ${gsc.period.end}, against ${b} in the 28 days before (${drop}% fewer). This is what Google reported for the period, not a cause. Open AI Marketing > SEO assistant.` }];
}

// ---- the calls the screen and the scheduler make ----------------------------------------------------------------------------------------------------------------------
// what: 'gsc' | 'ga4' | 'both'. -> { gsc?, ga4?, errors: [{ api, error }] } (an error of one part never hides the other)
async function syncSite(u, site, what = 'both', opts = {}) {
  const out = { errors: [] }; await ensure();
  if ((what === 'gsc' || what === 'both') && site.gscProperty) { const r = await syncGsc(u, site, opts); if (r.error) { out.errors.push({ api: 'gsc', error: r.error, code: r.code }); await save(site.id, { gscError: r.error }); } else out.gsc = r.gsc; }
  if ((what === 'ga4' || what === 'both') && site.ga4Property) { const r = await syncGa4(site, opts); if (r.error) { out.errors.push({ api: 'ga4', error: r.error, code: r.code }); await save(site.id, { ga4Error: r.error }); } else out.ga4 = r.ga4; }
  if (!site.gscProperty && !site.ga4Property) out.errors.push({ api: 'none', error: 'Choose the Search Console property or write the Analytics property number first (Site and schedule).', code: 'no_property' });
  return out;
}
async function manualSync(u, siteId, what, opts = {}) {
  const site = await Sites.mine(u, siteId); if (!site) return { error: 'That SEO site was not found.', status: 404 };
  const st = await GA.status(opts); if (!st.configured) return { error: st.problem || GA.KEY_HELP, status: 400, code: 'nokey' };
  const r = await syncSite(u, site, ['gsc', 'ga4'].includes(what) ? what : 'both', opts);
  if (r.errors.length && !r.gsc && !r.ga4) return { error: r.errors.map((e) => e.error).join(' '), status: 502, code: r.errors[0].code, errors: r.errors };
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: SEO Google data read', entity: 'OmniMkSeoSite', entityId: site.id, toValue: `${site.clientName}: ${[r.gsc ? 'Search Console' : '', r.ga4 ? 'Analytics' : ''].filter(Boolean).join(' and ')}` });
  return { ...r, google: await stored(site.id) };
}
// the card's Test connection: sign in and ask Search Console which properties it can see
async function testConnection(opts = {}) {
  const st = await GA.status(opts); if (!st.configured) return { ok: false, text: st.problem || `No key is saved. ${GA.KEY_HELP}` };
  const r = await properties(opts); if (r.error) return { ok: false, text: r.error };
  return { ok: true, text: `Signed in to Google as ${st.email}. It can read ${r.items.length} Search Console propert${r.items.length === 1 ? 'y' : 'ies'}${r.items.length ? '' : ' (clients have not added this email yet)'}. Analytics properties are checked when a site is read.` };
}
// the Google part of the dashboard: what was read last (nothing is fetched here)
async function dashboardPart(u, site) {
  const st = await GA.status(); const g = await stored(site.id);
  return { google: { configured: st.configured, email: st.email, gscProperty: site.gscProperty || '', ga4Property: site.ga4Property || '', gsc: g && g.gsc, ga4: g && g.ga4, gscAt: g && g.gscAt, ga4At: g && g.ga4At, gscError: (g && g.gscError) || '', ga4Error: (g && g.ga4Error) || '' } };
}

module.exports = { ensure, properties, visibleProperties, suggestProperty, syncGsc, syncGa4, syncSite, manualSync, testConnection, dashboardPart, stored, alertsOf, periods, explain, pct, SOURCE, DROP_PCT, DROP_MIN };
