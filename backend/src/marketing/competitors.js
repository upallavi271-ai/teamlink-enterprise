// ---------------------------------------------------------------------------
// AI MARKETING > SEO & VISIBILITY > COMPETITORS (2026-11-24): the "competitor analysis" of the Growth and Premium plans and the "competitor profile comparison" of the Google Business Profile service, as one
// SNAPSHOT: the client's website and up to 3 competitors' websites are each read ONCE, like a visitor (the same 23 checks as the website check, through utils/safeFetch.js), and put side by side:
//   * the website score of each (and its SEO / AEO / GEO marks), who is ahead;
//   * "where competitors are ahead": the checks a competitor passes better than the client, with what to do, and "where the client is ahead";
//   * the Google profile numbers the TEAM types by hand from each public profile (rating, number of reviews, number of photos): nothing is read from Google and nothing is invented;
//   * a plain summary the team can copy, and (saved per client) a section in the monthly report.
// HONEST: it compares what is ON each homepage. It does not show rankings, traffic, customers or anything a competitor keeps private, and it never logs in anywhere. One page and a few links per site; nothing is changed
// on any site. saved: table OmniMkCompetitor; audit log "Omni-Channel AI Marketing: competitor snapshot saved".
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const A = require('../outreach/access');
const Site = require('./siteCheck');
const { logAudit } = require('../utils/audit');

const T = 'OmniMkCompetitor';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${T}" ("id" TEXT NOT NULL PRIMARY KEY, "clientName" TEXT NOT NULL DEFAULT '', "snapshot" TEXT, "department" TEXT, "createdById" TEXT, "createdByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS "${T}_client" ON "${T}"("clientName", "createdAt")`,
];
let okAt = 0;
async function ensure() { if (okAt && Date.now() - okAt < 600000) return true; try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] competitor schema:', e.message); return false; } } // eslint-disable-line no-await-in-loop, no-console

const MAX_COMPETITORS = 3;
const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const numOrNull = (v, max) => { if (v == null || String(v).trim() === '') return null; const n = Number(String(v).replace(/,/g, '')); return Number.isFinite(n) && n >= 0 && n <= max ? n : null; };
const GOOGLE = [['rating', 'Google rating (out of 5)', 5], ['reviews', 'Number of Google reviews', 1e7], ['photos', 'Number of photos on the profile', 1e6]];
const CHECK_TEXT = Object.fromEntries(Site.CHECKS.map(([key, area, marks, , gap, fix]) => [key, { area, marks, gap, fix }]));
const cap = (s) => s[0].toUpperCase() + s.slice(1);
// what a PASSED check says in words (the other side of the "gap" of the website check), for "where the client is ahead"
const GOOD = { https: 'is on https', title: 'has a well-sized page title', description: 'has a good meta description', h1: 'has one clear main heading', headingOrder: 'keeps its headings in order', canonical: 'has a canonical link', lang: 'declares its language', viewport: 'has the mobile tag', indexable: 'is open to search engines', altText: 'describes its pictures', sitemap: 'has a sitemap', robots: 'has a robots.txt', brokenLinks: 'has no broken links', speed: 'answers quickly', faqSection: 'has a FAQ section', questionHeadings: 'has question headings', faqSchema: 'has FAQ schema', structure: 'has answer-friendly text', orgSchema: 'has business schema', orgDetails: 'has complete business schema', nap: 'shows name, address and phone', sameAs: 'links its social profiles', aboutContact: 'links an About and a Contact page' };

// the people the team wants compared: { name, url, google: { rating, reviews, photos } }
function cleanParty(p, i) {
  const c = Site.cleanUrl(p && p.url); if (c.error) return { error: `${i === 0 ? 'The client website' : `Competitor ${i}`}: ${c.error}`, status: 400 };
  const g = {}; for (const [k, , max] of GOOGLE) { const v = numOrNull(p.google && p.google[k], max); if (v != null) g[k] = v; }
  return { name: clean(p.name, 80) || hostOf(c.url), url: c.url, google: g };
}
// at most 2 at a time (each is one page, a robots file, a sitemap and a few links)
async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; const work = async () => { while (i < items.length) { const k = i; i += 1; out[k] = await fn(items[k], k); } }; await Promise.all(Array.from({ length: Math.min(n, items.length) }, work)); return out; } // eslint-disable-line no-await-in-loop

// ---- the comparison itself (pure: it takes the reports of the checks) --------------------------------------------------------------------------------------------------
// parties: [{ name, url, google, report | error }], the first one is the client
function compare(parties) {
  const ok = parties.filter((p) => p.report); const client = parties[0];
  if (!client.report) return { error: `The client website could not be checked: ${client.error}`, status: 502 };
  const comps = ok.slice(1); if (!comps.length) return { error: `None of the competitor websites could be checked (${parties.slice(1).map((p) => `${p.name}: ${p.error}`).join('; ')}).`, status: 502 };
  const got = (p, key) => (p.report.checks.find((c) => c.key === key) || { got: 0 }).got;
  const ranking = ok.map((p) => ({ name: p.name, url: p.report.url, score: p.report.score, isClient: p === client, areas: p.report.areas.map((a) => ({ key: a.key, got: a.got, marks: a.marks })) })).sort((a, b) => b.score - a.score);
  const ahead = []; const strengths = [];
  for (const [key, t] of Object.entries(CHECK_TEXT)) {
    const mine = got(client, key); const best = Math.max(...comps.map((p) => got(p, key)));
    if (best > mine) ahead.push({ key, area: t.area, gap: cap(t.gap), fix: t.fix, lost: best - mine, who: comps.filter((p) => got(p, key) === best).map((p) => p.name) });
    else if (mine > best) strengths.push({ key, area: t.area, text: GOOD[key] || key, marks: mine - best, behind: comps.filter((p) => got(p, key) < mine).map((p) => p.name) });
  }
  ahead.sort((a, b) => b.lost - a.lost); strengths.sort((a, b) => b.marks - a.marks);
  const matrix = Object.keys(CHECK_TEXT).map((key) => ({ key, area: CHECK_TEXT[key].area, marks: CHECK_TEXT[key].marks, label: CHECK_TEXT[key].gap, results: ok.map((p) => (p.report.checks.find((c) => c.key === key) || { result: 'no' }).result) }));
  const google = []; for (const [k, label] of GOOGLE) { const vals = parties.map((p) => (p.google[k] != null ? p.google[k] : null)); if (vals[0] != null && vals.slice(1).some((v) => v != null)) google.push({ key: k, label: label.replace(/ \(.*\)$/, ''), values: parties.map((p, i) => ({ name: p.name, value: vals[i] })) }); }
  const lines = []; const top = ranking[0]; const me = ranking.find((r) => r.isClient);
  lines.push(`Website score: ${ranking.map((r) => `${r.name} ${r.score}`).join(', ')}.${top.isClient ? ` ${me.name} is ahead of every competitor checked.` : ` ${top.name} is ahead of ${me.name} by ${top.score - me.score} marks.`}`);
  if (ahead.length) lines.push(`Where competitors are ahead: ${ahead.slice(0, 4).map((a) => `${a.gap.toLowerCase()} (better at ${a.who.join(', ')})`).join('; ')}.`);
  if (strengths.length) lines.push(`Where ${me.name} is ahead: it ${strengths.slice(0, 3).map((s) => s.text).join('; it ')}.`);
  for (const g of google) { const mine = g.values[0].value; const others = g.values.slice(1).filter((v) => v.value != null); if (mine == null || !others.length) continue; const best = others.reduce((a, b) => (b.value > a.value ? b : a)); lines.push(`${g.label}: ${g.values.filter((v) => v.value != null).map((v) => `${v.name} ${v.value}`).join(', ')}.${best.value > mine ? ` ${best.name} has more.` : mine > best.value ? ` ${me.name} has more.` : ''}`); }
  lines.push('This compares what is on each homepage. It does not show rankings, traffic or customers, and no ranking or result is promised.');
  return { client: { name: client.name, url: client.report.url }, competitors: comps.map((p) => ({ name: p.name, url: p.report.url })), failed: parties.slice(1).filter((p) => p.error).map((p) => ({ name: p.name, url: p.url, error: p.error })), ranking, ahead, strengths, matrix, matrixOrder: ok.map((p) => p.name), google, summary: lines, facts: ok.map((p) => ({ name: p.name, ...p.report.facts, responseMs: p.report.responseMs, sitemapOk: p.report.sitemapOk, robotsOk: p.report.robotsOk })) };
}

// b: { client: { name, url, google }, competitors: [{ name, url, google }], clientName, save, department }; opts.fetchFn lets a test answer instead of the internet
async function snapshot(u, b = {}, opts = {}) {
  const list = [b.client || {}, ...(Array.isArray(b.competitors) ? b.competitors : [])].filter((p, i) => i === 0 || clean(p.url, 300));
  if (list.length < 2) return { error: 'Add at least one competitor website.', status: 400 };
  if (list.length > MAX_COMPETITORS + 1) return { error: `At most ${MAX_COMPETITORS} competitors can be compared at once.`, status: 400 };
  const parties = []; for (let i = 0; i < list.length; i += 1) { const p = cleanParty(list[i], i); if (p.error) return p; parties.push(p); }
  const hosts = parties.map((p) => hostOf(p.url)); if (new Set(hosts).size !== hosts.length) return { error: 'The same website is listed twice. Each business needs its own address.', status: 400 };
  const runs = await pool(parties, 2, (p) => Site.runCheck(p.url, opts)); runs.forEach((r, i) => { if (r.error) parties[i].error = r.error; else parties[i].report = r.report; });
  const cmp = compare(parties); if (cmp.error) return cmp;
  const out = { ...cmp, comparedAt: new Date().toISOString() };
  if (!b.save) return { snapshot: out };
  if (!(await ensure())) return { error: 'The snapshot could not be saved.', status: 500 };
  const clientName = clean(b.clientName, 120); if (!clientName) return { error: 'Write the client name to save the snapshot.', status: 400 };
  const dept = clean(b.department, 60) || null; if (dept && !A.mayDepartment(u, dept)) return { error: 'That department is not yours.', status: 403 };
  const id = S.newId('cmp');
  await S.run(`INSERT INTO "${T}" (id, clientName, snapshot, department, createdById, createdByName, createdAt) VALUES (?,?,?,?,?,?,?)`, id, clientName, JSON.stringify(out), dept, u.id, S.clip(u.name, 80), Date.now());
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: competitor snapshot saved', entity: T, entityId: id, toValue: `${clientName}: ${parties.length - 1} competitor(s)` });
  return { snapshot: out, id };
}
async function list(u, o = {}) {
  if (!(await ensure())) return { error: 'The snapshots could not be opened.', status: 500 };
  const rows = (await S.q(`SELECT * FROM "${T}" ORDER BY createdAt DESC LIMIT 200`)).filter((r) => A.mayDepartment(u, r.department || '')).filter((r) => !o.clientName || r.clientName.toLowerCase() === String(o.clientName).toLowerCase());
  return { items: rows.map((r) => { const s = S.parse(r.snapshot, {}); const me = (s.ranking || []).find((x) => x.isClient); return { id: r.id, clientName: r.clientName, createdAt: S.iso(r.createdAt), createdByName: r.createdByName || '', competitors: (s.competitors || []).map((c) => c.name), clientScore: me ? me.score : null, best: s.ranking && s.ranking[0] ? { name: s.ranking[0].name, score: s.ranking[0].score } : null }; }) };
}
async function get(u, id) {
  if (!(await ensure())) return { error: 'The snapshots could not be opened.', status: 500 };
  const r = (await S.q(`SELECT * FROM "${T}" WHERE id = ?`, id))[0]; if (!r || !A.mayDepartment(u, r.department || '')) return { error: 'That snapshot was not found.', status: 404 };
  return { id: r.id, clientName: r.clientName, createdAt: S.iso(r.createdAt), snapshot: S.parse(r.snapshot, null) };
}
// the newest saved snapshot of a client, for the monthly report
async function latestFor(u, clientName) { const l = await list(u, { clientName }); if (!l.items || !l.items[0]) return null; const g = await get(u, l.items[0].id); return g.snapshot ? { id: l.items[0].id, createdAt: g.createdAt, ...g.snapshot } : null; }

module.exports = { ensure, snapshot, compare, list, get, latestFor, cleanParty, MAX_COMPETITORS, GOOGLE };
