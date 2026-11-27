// ---------------------------------------------------------------------------
// AI MARKETING > AI AGENT > PERFORMANCE (2026-11-25, phase 3). What really happened, counted from the saved records of the modules the agent called. READ ONLY: nothing is changed, nothing is sent.
//   posts      the posts recorded on the accounts for the run's pictures (the posting table of postItem.js: made by the agent after your approval, by a person's click, or by "post after the client
//              approves"), with their links
//   clients    the answers of the clients the pictures were sent to (clientReview.js): approved, asked for changes, still waiting
//   leads      the NEW CRM leads since the plan started, by band and by source (including the WhatsApp assistant's leads), for the leads THIS login may see. HONEST: they come from all sources:
//              TeamLink cannot tell which lead came from which post, so it says "while the plan ran", never "from the plan"
//   site       the website score now against the score before the plan (the saved audits)
//   google     what Google Search Console / Analytics reported for the client's website, as the SEO assistant last read it (nothing is fetched here); the whole website, not an effect of the plan
// Nothing here is estimated or invented; a part that cannot be read for this login says why instead of showing a zero.
// ---------------------------------------------------------------------------
const S = require('../outreach/store');

const par = (v, d) => S.parse(v, d);
const clip = (s, n) => S.clip(s, n);

// the pictures of a run: the outputs of its picture steps
const picturesOf = (tasks) => tasks.filter((t) => /^image\./.test(t.tool) && t.status === 'done').map((t) => ((par(t.output, {}) || {}).data || {}).itemId).filter(Boolean);

async function postsOf(ids) {
  if (!ids.length) return { total: 0, failed: 0, items: [] };
  try {
    const rows = await S.q(`SELECT platform, accountName, ok, url, error, at FROM "OmniMkItemPost" WHERE itemId IN (${ids.map(() => '?').join(',')}) ORDER BY at`, ...ids);
    const good = rows.filter((r) => S.num(r.ok) === 1);
    return { total: good.length, failed: rows.length - good.length, items: good.slice(0, 30).map((r) => ({ platform: r.platform || '', name: r.accountName || '', url: r.url || '', at: S.iso(r.at) })) };
  } catch { return { total: 0, failed: 0, items: [], unavailable: true }; }
}
async function clientsOf(ids) {
  if (!ids.length) return { sent: 0, approved: 0, changes: 0, waiting: 0 };
  try {
    const rows = await S.q(`SELECT itemId, status, createdAt FROM "OmniMkClientReview" WHERE kind = 'image' AND deletedAt IS NULL AND status != 'revoked' AND itemId IN (${ids.map(() => '?').join(',')}) ORDER BY createdAt`, ...ids);
    const last = new Map(); rows.forEach((r) => last.set(r.itemId, r.status)); // the newest link of each picture
    const c = { sent: last.size, approved: 0, changes: 0, waiting: 0 };
    last.forEach((st) => { if (st === 'approved') c.approved += 1; else if (st === 'changes') c.changes += 1; else c.waiting += 1; });
    return c;
  } catch { return { sent: 0, approved: 0, changes: 0, waiting: 0, unavailable: true }; }
}
// the CRM's own overview (last 30 days, the leads this login may see): fetched once and filtered per run
async function leadsOf(u, svc) {
  try {
    const Lead = (svc && svc.Lead) || require('./leadgen'); // eslint-disable-line global-require
    const o = await Lead.overview(u);
    if (!o || o.error) return { available: false, reason: (o && o.error) || 'The CRM leads could not be read.' };
    return { available: true, leads: (o.leads || []).map((l) => ({ createdAt: l.createdAt, band: l.band || '', source: l.source || 'Not said' })) };
  } catch (e) { return { available: false, reason: 'The CRM leads could not be read.' }; }
}
const leadsSince = (all, fromMs) => {
  if (!all || !all.available) return { available: false, reason: (all && all.reason) || 'The CRM leads could not be read.' };
  const mine = all.leads.filter((l) => Date.parse(l.createdAt) >= fromMs);
  const by = new Map(); mine.forEach((l) => by.set(l.source, (by.get(l.source) || 0) + 1));
  return { available: true, total: mine.length, hot: mine.filter((l) => l.band === 'Hot').length, warm: mine.filter((l) => l.band === 'Warm').length, cold: mine.filter((l) => l.band === 'Cold').length, bySource: [...by.entries()].map(([source, n]) => ({ source, n })).sort((a, b) => b.n - a.n).slice(0, 6), whatsapp: [...by.entries()].filter(([s]) => /whatsapp/i.test(s)).reduce((a, [, n]) => a + n, 0) };
};
// the saved audits of the client, newest first: the score now against the last one saved before the run started
async function siteOf(run, fromMs) {
  try {
    const rows = await S.q('SELECT score, url, createdAt FROM "OmniMkSiteCheck" WHERE lower(clientName) = ? ORDER BY createdAt DESC LIMIT 12', String(run.businessName || '').trim().toLowerCase());
    if (!rows.length) return null;
    const now = rows[0]; const before = rows.find((r) => S.ms(r.createdAt) < fromMs);
    return { score: S.num(now.score), at: S.iso(now.createdAt), url: now.url, before: before ? S.num(before.score) : null, beforeAt: before ? S.iso(before.createdAt) : null };
  } catch { return null; }
}

// the client's SEO site (same business name, one this login may see) and the Google numbers saved for it
async function googleOf(u, run, svc) {
  try {
    const Sites = (svc && svc.Sites) || require('./seoSites'); const Google = (svc && svc.Google) || require('./seoGoogle'); // eslint-disable-line global-require
    const list = await Sites.list(u); const name = String(run.businessName || '').trim().toLowerCase();
    const site = ((list && list.items) || []).find((x) => String(x.clientName).trim().toLowerCase() === name);
    if (!site) return null; const g = await Google.stored(site.id); if (!g || (!g.gsc && !g.ga4)) return null;
    const said = Google.sentences(g);
    return said.length ? { siteId: site.id, gsc: g.gsc || null, ga4: g.ga4 || null, lines: said } : null;
  } catch { return null; }
}

// opts: { svc (a test's stand-ins), leads (the prefetched leadsOf answer, for the dashboard) }
async function performance(u, run, tasks, opts = {}) {
  const fromMs = S.ms(run.startedAt) || S.ms(run.approvedAt) || S.ms(run.createdAt) || Date.now();
  const ids = picturesOf(tasks);
  const all = opts.leads || await leadsOf(u, opts.svc);
  const wantLeads = !['seo'].includes(run.intent);
  return {
    from: S.iso(fromMs), posts: await postsOf(ids), clients: await clientsOf(ids), leads: wantLeads ? leadsSince(all, fromMs) : null,
    site: tasks.some((t) => /^seo\./.test(t.tool)) ? await siteOf(run, fromMs) : null,
    google: await googleOf(u, run, opts.svc),
  };
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
// the sentences for the summary
function lines(perf, run) {
  const out = [];
  if (!perf) return out;
  if (perf.posts.total || perf.posts.failed) out.push(`Posts recorded on the accounts for these pictures: ${perf.posts.total} went public${perf.posts.failed ? `, ${perf.posts.failed} failed` : ''}.`);
  if (perf.clients.sent) out.push(`Clients' answers: ${perf.clients.approved} approved, ${perf.clients.changes} asked for changes, ${perf.clients.waiting} still waiting (of ${plural(perf.clients.sent, 'picture')} sent).`);
  if (perf.leads) {
    if (!perf.leads.available) out.push(`CRM leads: not shown (${perf.leads.reason}).`);
    else out.push(`New CRM leads since the plan started: ${perf.leads.total}${perf.leads.total ? ` (${perf.leads.hot} hot, ${perf.leads.warm} warm, ${perf.leads.cold} cold${perf.leads.whatsapp ? `; ${perf.leads.whatsapp} through the WhatsApp assistant` : ''})` : ''}. They come from every source: TeamLink cannot tell which came from these posts.`);
  }
  if (perf.site && perf.site.before != null && perf.site.at !== perf.site.beforeAt) out.push(`Website score: ${perf.site.score}/100 now, ${perf.site.before}/100 before this plan (TeamLink's own score of what is on the page, not rankings).`);
  if (perf.google) out.push(...perf.google.lines, "Google's figures cover the whole website for those dates: they do not show what this plan caused.");
  return out;
}

module.exports = { performance, leadsOf, leadsSince, lines, picturesOf, postsOf, clientsOf };
