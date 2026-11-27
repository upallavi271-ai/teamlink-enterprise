// ---------------------------------------------------------------------------
// AI MARKETING > SEO assistant > PRINTABLE AUDIT REPORT (2026-11-27, owner's pending list: "printable SEO audit reports"). One page for the client, made from what is saved: the last website audit
// (score and SEO / AEO / GEO parts), how the score moved, what to fix (each with its impact, effort, reason, steps and ready-to-use text), what the audits confirmed as fixed, the technical checks,
// and Google Search Console / Analytics numbers when they were read. Plain HTML the team prints or saves as PDF from the browser; nothing is sent, nothing is invented, no ranking is promised.
// ---------------------------------------------------------------------------
const Sites = require('./seoSites');
const Dash = require('./seoDashboard');
const Tasks = require('./seoTasks');
const Cfg = require('./settings');

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const date = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'long', year: 'numeric' }) : ''; };
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? 'Not available' : Number(v).toLocaleString('en-IN'));
const band = (s) => (s >= 80 ? 'Good' : s >= 60 ? 'Fair: worth improving' : s >= 40 ? 'Weak: several things to fix' : 'Poor: fix the basics first');
const IMPACT = { high: 'High', medium: 'Medium', low: 'Low' };
const word = (v) => { const s = String(v || ''); return IMPACT[s.toLowerCase()] || (s ? s[0].toUpperCase() + s.slice(1) : ''); };
const CSS = 'body{font:14px/1.5 "Segoe UI",Roboto,Arial,sans-serif;color:#0f2a3d;margin:0;background:#fff}.wrap{max-width:820px;margin:0 auto;padding:28px}h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:26px 0 8px;border-bottom:2px solid #0f766e;padding-bottom:4px}h3{font-size:14px;margin:0 0 4px}'
  + 'table{border-collapse:collapse;width:100%}td,th{padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:left;font-size:13px;vertical-align:top}.muted{color:#64748b;font-size:12px}.big{font-size:44px;font-weight:800;color:#0f766e;line-height:1}.bar{background:#e2e8f0;border-radius:6px;height:10px;overflow:hidden;min-width:160px}.bar i{display:block;height:100%;background:#0f766e}'
  + '.fix{border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;margin:0 0 10px;page-break-inside:avoid}.tag{display:inline-block;font-size:11px;border:1px solid #cbd5e1;border-radius:20px;padding:0 8px;margin-right:6px}pre{white-space:pre-wrap;word-break:break-word;background:#f1f5f9;border-radius:6px;padding:8px;font:12px/1.45 Consolas,monospace}@media print{.wrap{max-width:none;padding:0}h2{page-break-after:avoid}}';
const table = (head, rows) => `<table>${head ? `<tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>` : ''}${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;

function html(site, items, by, opp = null) {
  const r = site.report; const open = items.filter((t) => t.status === 'open'); const fixed = items.filter((t) => t.status === 'verified'); const claimed = items.filter((t) => t.status === 'done');
  const out = [`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(site.clientName)}: SEO audit report</title><style>${CSS}</style></head><body><div class="wrap">`];
  out.push(`<h1>${esc(site.clientName)}</h1><div class="muted">Website audit report · ${esc(r.url || site.url)} · checked ${esc(date(r.checkedAt))}${by ? ` · prepared by ${esc(by)}` : ''}</div>`);
  out.push(`<h2>Website score</h2><div class="big">${esc(r.score)}<span class="muted"> / 100</span></div><div><b>${esc(band(Number(r.score)))}</b> · ${esc(r.pagesRead)} page${r.pagesRead === 1 ? '' : 's'} read</div>`);
  const areas = Array.isArray(r.areas) ? r.areas.filter((a) => a && a.marks) : [];
  if (areas.length) out.push(table(null, areas.map((a) => { const p = Math.round((Number(a.got) / Number(a.marks)) * 100); return [`<b>${esc(a.key)}</b><div class="muted">${esc(a.label)}</div>`, `<div class="bar"><i style="width:${Math.max(0, Math.min(100, p))}%"></i></div>`, `${esc(a.got)} of ${esc(a.marks)}`]; })));
  const trend = (site.trend || []).filter((x) => x && x.at);
  if (trend.length > 1) out.push('<h2>How the score moved</h2>', table(['Audit date', 'Score'], trend.map((x) => [esc(date(x.at)), esc(x.score)])));
  out.push(`<h2>What to fix (${open.length})</h2>`);
  if (!open.length) out.push('<p>Nothing is open from this audit.</p>');
  for (const [i, t] of open.entries()) {
    const drafts = (t.drafts || []).filter((d) => d && d.kind !== 'needs' && d.value); const needs = (t.drafts || []).filter((d) => d && d.kind === 'needs');
    out.push(`<div class="fix"><h3>${i + 1}. ${esc(t.title)}</h3><div><span class="tag">${esc(t.area)}</span><span class="tag">Impact: ${esc(word(t.impact))}</span><span class="tag">Effort: ${esc(word(t.effort))}</span></div>`);
    if (t.detail) out.push(`<p>${esc(t.detail)}</p>`);
    if (t.fix) out.push(`<p><b>What to do:</b> ${esc(t.fix)}</p>`);
    if (t.pages && t.pages.length) out.push(`<div class="muted">Pages: ${t.pages.slice(0, 6).map(esc).join(', ')}${t.pages.length > 6 ? ` and ${t.pages.length - 6} more` : ''}</div>`);
    for (const d of drafts.slice(0, 3)) out.push(`<div class="muted" style="margin-top:6px">Ready to use: ${esc(d.label)}</div><pre>${esc(String(d.value).slice(0, 1500))}</pre>`);
    if (needs.length) out.push(`<div class="muted">Needed from the client: ${needs.flatMap((d) => d.needs || []).map(esc).join(', ')}</div>`);
    out.push('</div>');
  }
  if (fixed.length || claimed.length) out.push('<h2>Progress</h2>', table(['Item', 'State'], [...fixed.map((t) => [esc(t.title), 'Fixed: confirmed by a later audit']), ...claimed.map((t) => [esc(t.title), 'Marked done: waiting for the next audit'])]));
  const p = site.performance;
  if (p) {
    const rows = [];
    if (p.responseMs != null) rows.push(['Time to answer', `${num(p.responseMs)} ms`]);
    if (p.robotsOk != null) rows.push(['robots.txt', p.robotsOk ? 'Found and fine' : 'Missing or blocking']);
    if (p.sitemapOk != null) rows.push(['Sitemap', p.sitemapOk ? 'Found' : 'Not found']);
    if (p.links) rows.push(['Links checked', `${num(p.links.checked)}, broken ${num(p.links.bad)}${(p.links.list || []).length ? `<div class="muted">${p.links.list.map((l) => esc(l.url || l.href || l)).join('<br>')}</div>` : ''}`]);
    if (rows.length) out.push('<h2>Technical checks</h2>', table(null, rows));
  }
  const g = site.google || {}; const near = (opp && opp.items) || [];
  if (g.gsc || g.ga4 || near.length) {
    out.push('<h2>Google numbers</h2>');
    const t = g.gsc && g.gsc.totals; const before = (g.gsc && g.gsc.beforeTotals) || {};
    if (t) out.push('<p class="muted">Search Console, 28 days against the 28 days before</p>', table(['Measure', 'Last 28 days', '28 days before'], [['clicks', 'Clicks'], ['impressions', 'Times seen in search'], ['position', 'Average position']].map(([k, label]) => [label, esc(num(t[k])), esc(num(before[k]))])));
    const a = g.ga4 && g.ga4.totals;
    if (a && a.now) out.push('<p class="muted">Google Analytics, 28 days against the 28 days before</p>', table(['Measure', 'Last 28 days', '28 days before'], [['sessions', 'Visits'], ['users', 'Visitors'], ['pageViews', 'Pages viewed']].filter(([k]) => a.now[k] != null).map(([k, label]) => [label, esc(num(a.now[k])), esc(num((a.before || {})[k]))])));
    if (near.length) out.push(`<p class="muted">Searches close to the top of Google (${esc((opp.set && opp.set.label) || 'latest reading')})</p>`, table(['Search', 'Position', 'Times seen', 'Clicks'], near.slice(0, 10).map((x) => [esc(x.query), esc(x.position), esc(num(x.impressions)), esc(num(x.clicks))])));
  }
  out.push(`<p class="muted" style="margin-top:26px">${esc(Dash.HONEST)} A figure marked "Not available" was not read.</p></div></body></html>`);
  return out.join('');
}

// -> { html, title } or { error, status }
async function build(u, siteId) {
  const mine = await Sites.mine(u, siteId); if (!mine) return { error: 'That SEO site was not found.', status: 404 };
  const ov = await Dash.overview(u, { siteId: mine.id }); if (ov.error) return ov;
  const site = ov.site; if (!site) return { error: 'That SEO site was not found.', status: 404 };
  if (!site.report) return { error: 'No audit has been saved for this website yet. Press "Audit now" first.', status: 409 };
  const list = await Tasks.list(u, { siteId: mine.id }); if (list.error) return list;
  const brand = await Cfg.getBrand();
  const opp = await require('./seoKeywords').opportunities(mine.id, 10); // eslint-disable-line global-require
  return { html: html(site, list.items || [], brand.brandName || '', opp), title: `${site.clientName}: SEO audit report` };
}

module.exports = { build, html };
