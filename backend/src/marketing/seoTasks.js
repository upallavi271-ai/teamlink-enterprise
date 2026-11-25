// ---------------------------------------------------------------------------
// AI MARKETING > SEO ASSISTANT > RECOMMENDATION TASKS (2026-11-25). The audit's findings turned into a list of work that is REMEMBERED between audits:
//   * every finding of a saved audit (the 23 checks, the cross-page findings and the extra findings of seoExtras.js) becomes ONE task per SEO site (never two for the same problem);
//   * each task has an IMPACT (high / medium / low: the marks it costs, or a fixed weight for the extra findings) and an EFFORT (quick = a text change, medium = needs the web person for a while,
//     bigger = real work), and is sorted by impact for the effort (priority);
//   * most tasks come with a COPY-READY FIX made from the client's real facts (a meta description, the canonical tag, the business schema, a robots.txt ...; seoCopy.js draftsFor) that the client's web
//     person can paste. TeamLink NEVER edits a client's live website: the team marks the task Done when the fix is in;
//   * the next audit CONFIRMS it: a task marked Done that the audit no longer finds becomes "Fixed (confirmed)"; one it still finds is reopened and says so. A task the audit stops finding on its own is
//     confirmed too. A task the team Skips stays skipped. An audit that read fewer pages than the one that found a problem never closes it.
// HONEST BY DESIGN: impact is about what TeamLink's own audit measures, not about rankings: "high impact" never means "will rank higher". Nothing here promises a result.
// saved: table OmniMkSeoTask (one row per site and problem); audit log "Omni-Channel AI Marketing: SEO recommendation ...".
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const Sites = require('./seoSites');
const Site = require('./siteCheck');
const Copy = require('./seoCopy');
const Ev = require('./seoEvents');
const { logAudit } = require('../utils/audit');

const T = 'OmniMkSeoTask';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${T}" ("id" TEXT NOT NULL PRIMARY KEY, "siteId" TEXT NOT NULL, "issue" TEXT NOT NULL, "area" TEXT, "title" TEXT NOT NULL, "detail" TEXT, "fix" TEXT, "pages" TEXT, "impact" TEXT NOT NULL DEFAULT 'low', "effort" TEXT NOT NULL DEFAULT 'medium', "priority" INTEGER NOT NULL DEFAULT 0, "lost" REAL NOT NULL DEFAULT 0, "drafts" TEXT, "status" TEXT NOT NULL DEFAULT 'open', "note" TEXT, "autoNote" TEXT, "firstCheckId" TEXT, "lastCheckId" TEXT, "lastRead" INTEGER NOT NULL DEFAULT 1, "lastSeenAt" DATETIME NOT NULL DEFAULT 0, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0, "doneAt" DATETIME NOT NULL DEFAULT 0, "doneByName" TEXT, "verifiedAt" DATETIME NOT NULL DEFAULT 0)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "${T}_one" ON "${T}"("siteId", "issue")`,
  `CREATE INDEX IF NOT EXISTS "${T}_site" ON "${T}"("siteId", "status")`,
];
let okAt = 0;
async function ensure() { if (okAt && Date.now() - okAt < 600000) return true; try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] seo task schema:', e.message); return false; } } // eslint-disable-line no-await-in-loop, no-console

// how much work: quick = a text change, medium = the web person for a while, bigger = real work
const EFFORT = {
  title: 'quick', description: 'quick', h1: 'quick', lang: 'quick', viewport: 'quick', canonical: 'quick', robots: 'quick', indexable: 'quick', headingOrder: 'quick', nap: 'quick', sameAs: 'quick',
  altText: 'medium', sitemap: 'medium', brokenLinks: 'medium', faqSchema: 'medium', orgSchema: 'medium', orgDetails: 'medium', faqSection: 'medium', questionHeadings: 'medium', aboutContact: 'medium',
  https: 'bigger', speed: 'bigger', structure: 'bigger',
  'cross:dupTitle': 'medium', 'cross:dupDescription': 'medium', 'cross:dupH1': 'medium', 'cross:thin': 'bigger', 'cross:pageError': 'medium',
  'extra:robotsBlocksAll': 'quick', 'extra:noindexHeader': 'quick', 'extra:noInternalLinks': 'medium', 'extra:fewInternalLinks': 'medium', 'extra:notLinked': 'medium', 'extra:genericLinks': 'quick', 'extra:socialCard': 'quick',
};
const COST = { quick: 1, medium: 2, bigger: 4 };
const LOST = { 'cross:dupTitle': 3, 'cross:dupDescription': 2, 'cross:dupH1': 2, 'cross:thin': 2, 'cross:pageError': 3 }; // marks the cross-page findings are worth (they are not part of the 100)
const IMPACT_LOST = { high: 6, medium: 3, low: 1.5 };
const impactOf = (lost) => (lost >= 5 ? 'high' : lost >= 2.5 ? 'medium' : 'low');
const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const SERIOUS = new Set(['https', 'indexable', 'extra:robotsBlocksAll', 'extra:noindexHeader']); // problems that stop a site being found or trusted: a scheduled audit rings a bell for a new one
const STATUSES = ['open', 'done', 'verified', 'skipped'];
const RANK = { open: 0, done: 1, verified: 2, skipped: 3 };
const dayWords = (t) => new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

// the problems of one audit report as a flat list: { issue, area, title, detail, fix, pages, lost, serious }
function findingsOf(report) {
  const map = new Map(); const put = (f) => { const old = map.get(f.issue); if (!old) { map.set(f.issue, { ...f, n: 1 }); return; } old.pages = [...new Set([...old.pages, ...f.pages])].slice(0, 8); old.n += 1; };
  for (const a of report.actions || []) put({ issue: a.key, area: a.area, title: a.gap, detail: a.key === 'brokenLinks' && report.links && (report.links.list || []).length ? `Links that did not open: ${report.links.list.slice(0, 10).join('; ')}` : '', fix: a.fix, pages: a.pages || [], lost: a.lost, serious: false });
  for (const c of report.cross || []) put({ issue: `cross:${c.key}`, area: 'SEO', title: c.gap, detail: c.detail || '', fix: c.fix, pages: c.pages || [], lost: LOST[`cross:${c.key}`] || 2, serious: false });
  for (const e of (report.extra && report.extra.findings) || []) put({ issue: `extra:${e.key}`, area: e.area || 'SEO', title: cap1(e.gap), detail: e.detail || '', fix: e.fix, pages: e.pages || [], lost: IMPACT_LOST[e.impact] || 1.5, serious: !!e.serious });
  return [...map.values()].map((f) => ({ ...f, title: f.n > 1 ? `${f.title} (and ${f.n - 1} more group${f.n > 2 ? 's' : ''})` : f.title }));
}
// can THIS audit say a problem is gone? (a one-page audit cannot see what only a several-page audit finds)
function canVerify(issue, report) {
  const multi = Boolean(report.crawl);
  if (issue.startsWith('cross:') || ['extra:fewInternalLinks', 'extra:notLinked', 'extra:genericLinks'].includes(issue)) return multi;
  if (issue === 'extra:noInternalLinks') return !multi;
  return true;
}
const draftKey = (issue) => (issue.startsWith('extra:') ? issue.slice(6) : issue.startsWith('cross:') ? '' : issue);
const draftsOf = (site, issue, report) => { const k = draftKey(issue); if (!k) return []; try { return Copy.draftsFor(k, { F: Copy.facts({ ...Sites.factsOut(site.facts), industry: site.industry, website: site.url }), url: (report && report.url) || site.url, report }); } catch { return []; } };
const out = (r) => ({ id: r.id, siteId: r.siteId, issue: r.issue, area: r.area || 'SEO', title: r.title, detail: r.detail || '', fix: r.fix || '', pages: S.parse(r.pages, []) || [], impact: r.impact, effort: r.effort, priority: S.num(r.priority), lost: Math.round(Number(r.lost) * 10) / 10, drafts: S.parse(r.drafts, []) || [], status: r.status, note: r.note || '', autoNote: r.autoNote || '',
  firstCheckId: r.firstCheckId || null, lastCheckId: r.lastCheckId || null, lastSeenAt: S.num(r.lastSeenAt) ? S.iso(r.lastSeenAt) : null, createdAt: S.iso(r.createdAt), doneAt: S.num(r.doneAt) ? S.iso(r.doneAt) : null, doneByName: r.doneByName || '', verifiedAt: S.num(r.verifiedAt) ? S.iso(r.verifiedAt) : null });

// after a saved audit: add what is new, refresh what is still there, reopen what came back, confirm what is gone. site: the raw SEO site row; meta: { checkId, at }
async function sync(site, report, meta = {}) {
  const res = { created: 0, reopened: 0, verified: 0, open: 0, total: 0, serious: [] };
  if (!(await ensure()) || !report) return res;
  const at = meta.at || Date.now(); const read = report.crawl ? report.crawl.read : 1; const found = findingsOf(report); const foundSet = new Set(found.map((f) => f.issue));
  const rows = await S.q(`SELECT * FROM "${T}" WHERE siteId = ?`, site.id); const byIssue = new Map(rows.map((r) => [r.issue, r]));
  for (const f of found) {
    const effort = EFFORT[f.issue] || 'medium'; const impact = impactOf(f.lost); const priority = Math.round((f.lost * 10) / COST[effort]); const drafts = JSON.stringify(draftsOf(site, f.issue, report)); const old = byIssue.get(f.issue);
    if (!old) {
      await S.run(`INSERT INTO "${T}" (id, siteId, issue, area, title, detail, fix, pages, impact, effort, priority, lost, drafts, status, firstCheckId, lastCheckId, lastRead, lastSeenAt, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'open', ?,?,?,?,?,?)`,
        S.newId('stk'), site.id, f.issue, f.area, S.clip(f.title, 300), S.clip(f.detail, 900), S.clip(f.fix, 900), JSON.stringify(f.pages || []), impact, effort, priority, f.lost, drafts, meta.checkId || null, meta.checkId || null, read, at, at, at);
      res.created += 1; if (SERIOUS.has(f.issue)) res.serious.push(f.title); continue;
    }
    let status = old.status; let autoNote = old.autoNote || '';
    if (old.status === 'done') { status = 'open'; autoNote = `Marked done, but the check of ${dayWords(at)} still found it.`; res.reopened += 1; }
    else if (old.status === 'verified') { status = 'open'; autoNote = `It came back: the check of ${dayWords(at)} found it again.`; res.reopened += 1; if (SERIOUS.has(f.issue)) res.serious.push(f.title); }
    await S.run(`UPDATE "${T}" SET area = ?, title = ?, detail = ?, fix = ?, pages = ?, impact = ?, effort = ?, priority = ?, lost = ?, drafts = ?, status = ?, autoNote = ?, lastCheckId = ?, lastRead = ?, lastSeenAt = ?, updatedAt = ?, doneAt = ?, verifiedAt = ? WHERE id = ?`,
      f.area, S.clip(f.title, 300), S.clip(f.detail, 900), S.clip(f.fix, 900), JSON.stringify(f.pages || []), impact, effort, priority, f.lost, drafts, status, autoNote, meta.checkId || old.lastCheckId, read, at, at, status === 'open' ? 0 : S.num(old.doneAt), status === 'verified' ? S.num(old.verifiedAt) : 0, old.id);
  }
  for (const r of rows) {
    if (foundSet.has(r.issue) || !['open', 'done'].includes(r.status) || !canVerify(r.issue, report) || S.num(r.lastRead) > read) continue;
    await S.run(`UPDATE "${T}" SET status = 'verified', verifiedAt = ?, autoNote = ?, lastCheckId = ?, updatedAt = ? WHERE id = ?`, at, `Not found in the check of ${dayWords(at)} (${read === 1 ? 'home page' : `${read} pages`} read): fixed.`, meta.checkId || r.lastCheckId, at, r.id);
    res.verified += 1;
  }
  const c = await counts(site.id); res.open = c.open; res.total = c.total;
  if (res.verified) await Ev.add(site.id, { kind: 'fixed', level: 'good', title: `${res.verified} recommendation${res.verified === 1 ? '' : 's'} fixed (confirmed by the audit)`, message: 'The audit no longer finds these problems.', at });
  return res;
}
async function counts(siteId) {
  if (!(await ensure())) return { open: 0, done: 0, verified: 0, skipped: 0, total: 0, openHigh: 0, openQuick: 0 };
  const rows = await S.q(`SELECT status, impact, effort, COUNT(*) AS n FROM "${T}" WHERE siteId = ? GROUP BY status, impact, effort`, siteId); const c = { open: 0, done: 0, verified: 0, skipped: 0, total: 0, openHigh: 0, openQuick: 0 };
  for (const r of rows) { const n = S.num(r.n); c[r.status] = (c[r.status] || 0) + n; c.total += n; if (r.status === 'open' && r.impact === 'high') c.openHigh += n; if (r.status === 'open' && r.effort === 'quick') c.openQuick += n; }
  return c;
}
async function list(u, o = {}) {
  if (!(await ensure())) return { error: 'The recommendations could not be opened.', status: 500 };
  const site = await Sites.mine(u, o.siteId); if (!site) return { error: 'That SEO site was not found.', status: 404 };
  let rows = await S.q(`SELECT * FROM "${T}" WHERE siteId = ?`, site.id); if (o.status && STATUSES.includes(o.status)) rows = rows.filter((r) => r.status === o.status);
  rows.sort((a, b) => RANK[a.status] - RANK[b.status] || S.num(b.priority) - S.num(a.priority) || Number(b.lost) - Number(a.lost));
  return { items: rows.map(out), counts: await counts(site.id), site: { id: site.id, clientName: site.clientName } };
}
async function setStatus(u, id, b = {}) {
  if (!(await ensure())) return { error: 'The recommendation could not be saved.', status: 500 };
  const r = (await S.q(`SELECT * FROM "${T}" WHERE id = ?`, S.clip(id, 60)))[0]; const site = r && (await Sites.mine(u, r.siteId)); if (!r || !site) return { error: 'That recommendation was not found.', status: 404 };
  const status = String(b.status || ''); if (!['open', 'done', 'skipped'].includes(status)) return { error: 'Choose Open, Done or Skipped.', status: 400 };
  const note = b.note != null ? S.clip(b.note, 400) : (r.note || ''); const now = Date.now();
  await S.run(`UPDATE "${T}" SET status = ?, note = ?, autoNote = ?, doneAt = ?, doneByName = ?, verifiedAt = 0, updatedAt = ? WHERE id = ?`, status, note, status === 'done' ? 'Waiting for the next audit to confirm it.' : '', status === 'done' ? now : 0, status === 'done' ? S.clip(u.name, 80) : '', now, r.id);
  await logAudit({ userId: u.id, actorName: u.name, action: `Omni-Channel AI Marketing: SEO recommendation marked ${status}`, entity: T, entityId: r.id, toValue: `${site.clientName}: ${r.title}` });
  if (status === 'done') await Ev.add(site.id, { kind: 'done', level: 'good', title: `Marked done: ${r.title}`, message: `By ${S.clip(u.name, 80)}. The next audit confirms it.`, at: now });
  return { item: out((await S.q(`SELECT * FROM "${T}" WHERE id = ?`, r.id))[0]) };
}
// the copy-ready fixes again, after the client's facts changed (or one task, from the newest saved audit)
async function remakeSite(u, siteId) {
  if (!(await ensure())) return { error: 'The recommendations could not be opened.', status: 500 };
  const site = await Sites.mine(u, siteId); if (!site) return { error: 'That SEO site was not found.', status: 404 };
  let report = null; try { const l = await Site.latestFor(u, site.clientName); if (l) report = (await Site.get(u, l.id)).report; } catch { /* no saved audit */ }
  const rows = await S.q(`SELECT id, issue FROM "${T}" WHERE siteId = ? AND status IN ('open','done')`, site.id); let n = 0;
  for (const r of rows) { await S.run(`UPDATE "${T}" SET drafts = ?, updatedAt = ? WHERE id = ?`, JSON.stringify(draftsOf(site, r.issue, report)), Date.now(), r.id); n += 1; } // eslint-disable-line no-await-in-loop
  return { remade: n };
}

module.exports = { ensure, sync, counts, list, setStatus, remakeSite, findingsOf, canVerify, impactOf, EFFORT, COST, STATUSES, SERIOUS };
