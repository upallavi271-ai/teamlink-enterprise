// ---------------------------------------------------------------------------
// AI MARKETING > SEO ASSISTANT > AUDIT RUNNER (2026-11-25). ONE function for "audit this SEO site now", used by the button on the screen and by the scheduler (seoSchedule.js):
//   1 runs the website check (siteCheck.js: the home page, or up to 10 pages of the site when the site is set to read several) and SAVES it for the client (the history the dashboard draws),
//   2 turns the findings into recommendation tasks (seoTasks.js sync: new ones added, fixed ones confirmed, returned ones reopened),
//   3 notes what changed since the last audit in the progress feed (seoEvents.js) and moves the site's next scheduled audit one period ahead.
// It reads the public pages of the client's own website (like a visitor, through the safe fetch: public addresses only) and nothing else; nothing on the website is changed.
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const Sites = require('./seoSites');
const Site = require('./siteCheck');
const Tasks = require('./seoTasks');
const Ev = require('./seoEvents');

// the login a scheduled audit is saved under (the check reads and saves as an Admin of nobody in particular)
const SYS = { id: 'system', name: 'TeamLink (scheduled audit)', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
const sign = (n) => (n > 0 ? `+${n}` : String(n));

// site: the raw SEO site row; opts: { fetchFn (a test answers instead of the internet), now }
async function run(u, site, opts = {}) {
  if (!site) return { error: 'That SEO site was not found.', status: 404 };
  const now = opts.now || Date.now();
  const r = await Site.check(u, { url: site.url, clientName: site.clientName, planId: site.planId, department: site.department || undefined, save: true, pages: S.num(site.pages) || 5 }, opts);
  if (r.error) return r;
  const report = r.report; const prev = site.lastScore == null ? null : S.num(site.lastScore); const delta = prev == null ? null : report.score - prev; const drop = S.num(site.alertDrop) || 5;
  const sync = await Tasks.sync(site, report, { checkId: r.id, at: now });
  const read = report.crawl ? report.crawl.read : 1;
  await Ev.add(site.id, { kind: 'audit', level: delta == null ? 'info' : delta <= -drop ? 'warn' : delta > 0 ? 'good' : 'info', at: now,
    title: delta == null ? `First audit: ${report.score} out of 100` : `Audit: ${prev} to ${report.score} (${delta === 0 ? 'no change' : `${sign(delta)} points`})`, message: `${read === 1 ? 'Home page' : `${read} pages`} read. ${sync.open} open recommendation${sync.open === 1 ? '' : 's'}.` });
  const days = Sites.SCHEDULES[site.schedule] || 0;
  await Sites.setRun(site.id, { lastRunAt: now, lastScore: report.score, lastCheckId: r.id, fails: 0, nextRunAt: days ? now + days * Sites.DAY : 0 });
  return { checkId: r.id, report, score: report.score, prev, delta, tasks: sync };
}

module.exports = { run, SYS };
