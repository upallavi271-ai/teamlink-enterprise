// ---------------------------------------------------------------------------
// AI MARKETING > SEO ASSISTANT > DASHBOARD (2026-11-25). One read of everything the assistant knows, for the first screen:
//   * ALL SITES: each client's latest website score and the change since the audit before, open and high-impact recommendations, when the next audit is due, and who needs attention first;
//   * ONE SITE: the score and its trend over the saved audits, the SEO / AEO / GEO marks, technical findings still open, website performance (the home page's answer time, links that did not open,
//     robots.txt and sitemap, and Google PageSpeed when it was run), the recommendations (open, done, confirmed fixed, skipped), the progress feed (score changes, confirmed fixes, alerts), and the
//     keyword and content parts (seoKeywords.js, seoContent.js).
// HONEST BY DESIGN: every number here was measured by a saved audit or typed / imported by the team; "no audit yet" is shown as such, never as a zero. The score is TeamLink's own check of what is on
// the pages: it is not a ranking, and no ranking, traffic or lead is promised.
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const A = require('../outreach/access');
const Sites = require('./seoSites');
const Site = require('./siteCheck');
const Tasks = require('./seoTasks');
const Ev = require('./seoEvents');

const HONEST = "The score is TeamLink's own check of what is on the website's pages. It is not a ranking and not a Google score, and no ranking, traffic or lead is promised. Fixes are made by the client's web person: TeamLink never edits a website.";

// every saved audit this login may see, newest first, grouped by client name (lower case)
async function history(u) {
  if (!(await Site.ensure())) return new Map();
  const rows = (await S.q('SELECT id, clientName, score, pages, department, createdAt FROM "OmniMkSiteCheck" ORDER BY createdAt DESC LIMIT 3000')).filter((r) => A.mayDepartment(u, r.department || ''));
  const m = new Map(); for (const r of rows) { const k = String(r.clientName).trim().toLowerCase(); if (!m.has(k)) m.set(k, []); m.get(k).push({ id: r.id, score: S.num(r.score), pages: S.num(r.pages) || 1, at: S.iso(r.createdAt) }); }
  return m;
}
async function taskCounts() {
  if (!(await Tasks.ensure())) return new Map();
  const m = new Map(); for (const r of await S.q('SELECT siteId, status, impact, COUNT(*) AS n FROM "OmniMkSeoTask" GROUP BY siteId, status, impact')) { const c = m.get(r.siteId) || { open: 0, openHigh: 0, done: 0, verified: 0, skipped: 0 }; const n = S.num(r.n); c[r.status] = (c[r.status] || 0) + n; if (r.status === 'open' && r.impact === 'high') c.openHigh += n; m.set(r.siteId, c); }
  return m;
}

async function overview(u, o = {}) {
  const l = await Sites.list(u); if (l.error) return l;
  const hist = await history(u); const tc = await taskCounts(); const nowMs = Date.now();
  const sites = l.items.map((s) => {
    const h = hist.get(s.clientName.trim().toLowerCase()) || []; const last = h[0] || null; const prev = h[1] || null; const c = tc.get(s.id) || { open: 0, openHigh: 0, done: 0, verified: 0, skipped: 0 };
    const delta = last && prev ? last.score - prev.score : null; const dropped = delta != null && delta <= -s.alertDrop; const due = s.schedule !== 'off' && s.nextRunAt && Date.parse(s.nextRunAt) <= nowMs;
    return { id: s.id, clientName: s.clientName, url: s.url, industryLabel: s.industryLabel, score: last ? last.score : null, prevScore: prev ? prev.score : null, delta, checkedAt: last ? last.at : null, audits: h.length, pages: last ? last.pages : null,
      open: c.open, openHigh: c.openHigh, done: c.done, verified: c.verified, schedule: s.schedule, nextRunAt: s.nextRunAt, due: Boolean(due), dropped, attention: !last || dropped || c.openHigh > 0 };
  });
  const scored = sites.filter((s) => s.score != null);
  const totals = { sites: sites.length, audited: scored.length, average: scored.length ? Math.round(scored.reduce((a, s) => a + s.score, 0) / scored.length) : null, open: sites.reduce((a, s) => a + s.open, 0), openHigh: sites.reduce((a, s) => a + s.openHigh, 0), verified: sites.reduce((a, s) => a + s.verified, 0), dropped: sites.filter((s) => s.dropped).length, neverAudited: sites.filter((s) => !s.audits).length, scheduled: sites.filter((s) => s.schedule !== 'off').length };
  sites.sort((a, b) => Number(b.attention) - Number(a.attention) || (a.score == null ? -1 : b.score == null ? 1 : a.score - b.score) || a.clientName.localeCompare(b.clientName));
  const pick = o.siteId ? l.items.find((s) => s.id === o.siteId) : null; const sel = pick || null;
  return { totals, sites, industries: l.industries, site: sel ? await detail(u, sel, hist.get(sel.clientName.trim().toLowerCase()) || []) : null, honest: HONEST };
}

// one site in full. s: the site (seoSites rowOut); h: its saved audits, newest first
async function detail(u, s, h) {
  const out = { id: s.id, clientName: s.clientName, url: s.url, planId: s.planId, department: s.department, facts: s.facts, competitors: s.competitors, industry: s.industry, industryLabel: s.industryLabel, healthcare: s.healthcare, schedule: s.schedule, nextRunAt: s.nextRunAt, lastRunAt: s.lastRunAt, pages: s.pages, alertDrop: s.alertDrop, factsGiven: Object.values(s.facts).filter(Boolean).length,
    audits: h.length, trend: h.slice(0, 12).reverse(), report: null, tasks: await Tasks.counts(s.id), topTasks: [], byArea: [], performance: null, progress: null, events: await Ev.recent(s.id, 12) };
  const tl = await Tasks.list(u, { siteId: s.id }); const open = (tl.items || []).filter((t) => t.status === 'open');
  out.topTasks = open.slice(0, 6).map((t) => ({ id: t.id, title: t.title, impact: t.impact, effort: t.effort, area: t.area, hasFix: t.drafts.some((d) => d.kind !== 'needs') }));
  out.byArea = ['SEO', 'AEO', 'GEO'].map((a) => ({ area: a, open: open.filter((t) => t.area === a).length }));
  out.technical = open.filter((t) => ['https', 'indexable', 'canonical', 'robots', 'sitemap', 'viewport', 'speed', 'brokenLinks', 'lang', 'extra:robotsBlocksAll', 'extra:noindexHeader', 'cross:pageError'].includes(t.issue)).slice(0, 8).map((t) => ({ id: t.id, title: t.title, impact: t.impact }));
  if (h[0]) {
    const g = await Site.get(u, h[0].id); const r = g && g.report;
    if (r) {
      out.report = { id: h[0].id, url: r.url, score: r.score, checkedAt: g.createdAt, areas: r.areas, pagesRead: r.crawl ? r.crawl.read : 1, facts: r.facts, extraCount: (r.extra && r.extra.findings || []).length };
      let ps = r.pagespeed || null; if (!ps) for (const x of h.slice(1, 4)) { try { const gg = await Site.get(u, x.id); if (gg.report && gg.report.pagespeed) { ps = gg.report.pagespeed; break; } } catch { /* next */ } } // eslint-disable-line no-await-in-loop
      out.performance = { responseMs: r.responseMs, links: r.links ? { checked: r.links.checked, bad: r.links.bad, list: (r.links.list || []).slice(0, 5) } : null, robotsOk: r.robotsOk, sitemapOk: r.sitemapOk, pagespeed: ps };
    }
  }
  const first = h.length ? h[h.length - 1] : null;
  out.progress = first && h.length > 1 ? { firstScore: first.score, firstAt: first.at, latestScore: h[0].score, change: h[0].score - first.score, audits: h.length, fixed: out.tasks.verified, done: out.tasks.done } : null;
  for (const part of ['./seoKeywords', './seoContent']) { try { const m = require(part); if (m.dashboardPart) Object.assign(out, await m.dashboardPart(u, s)); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') console.error('[omni-mk] seo dashboard part:', e.message); } } // eslint-disable-line global-require, no-console, no-await-in-loop
  return out;
}

module.exports = { overview, detail, history, HONEST };
