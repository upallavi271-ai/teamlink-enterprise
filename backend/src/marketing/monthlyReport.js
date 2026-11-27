// ---------------------------------------------------------------------------
// AI MARKETING > CLIENT PLANS > MONTHLY CLIENT REPORT (2026-11-24): the "digital marketing performance report" of the services document (section 11, "How we measure results"). One page per client and month:
//   1 what TeamLink DELIVERED against the plan (counted in Client plans)   2 social media   3 SEO from a Google Search Console CSV (pasted, read here)   4 Google Business Profile numbers + the latest
//   profile audit score   5 business results (enquiries, leads, calls)   6 the latest website check   7 the improvement plan (from the audit, the website check and what is still to deliver) and the team's note.
//   8 (2026-11-25) this month beside the month before: the change in every number given for both months, in what was delivered and in the audit and website check scores (monthCompare.js).
// HONEST BY DESIGN (the document's rule: "TeamLink must not invent views, calls, reviews or performance results"): every number is typed or imported by the team from the real source; a number that was not
// given shows "Not provided", never a guess and never a zero. No ranking or lead is promised. The page is plain HTML the team prints or saves as PDF from the browser; nothing is sent.
// Saved per plan and month (table OmniMkMonthlyMetrics); audit log "Omni-Channel AI Marketing: monthly report saved".
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const CS = require('./clientServices');
const Site = require('./siteCheck');
const Comp = require('./competitors');
const Cmp = require('./monthCompare');
const { logAudit } = require('../utils/audit');

const T = 'OmniMkMonthlyMetrics';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${T}" ("id" TEXT NOT NULL PRIMARY KEY, "planId" TEXT NOT NULL, "month" TEXT NOT NULL, "metrics" TEXT, "notes" TEXT, "updatedById" TEXT, "updatedByName" TEXT, "updatedAt" DATETIME NOT NULL DEFAULT 0)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "${T}_one" ON "${T}"("planId", "month")`,
];
let okAt = 0;
async function ensure() { if (okAt && Date.now() - okAt < 600000) return true; try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] monthly report schema:', e.message); return false; } } // eslint-disable-line no-await-in-loop, no-console

// what the team can enter (the document's lists); every field is optional
const FIELDS = {
  social: { label: 'Social media', items: [['postsPublished', 'Posts published'], ['reach', 'Reach'], ['impressions', 'Impressions'], ['engagement', 'Engagement'], ['followersGained', 'Followers gained'], ['reelViews', 'Reel views']] },
  gbp: { label: 'Google Business Profile', items: [['profileViews', 'Profile views'], ['searches', 'Searches that showed the profile'], ['mapViews', 'Views on Google Maps'], ['calls', 'Calls'], ['directions', 'Direction requests'], ['websiteClicks', 'Website clicks'], ['newReviews', 'New reviews'], ['rating', 'Average rating (out of 5)']] },
  business: { label: 'Business results', items: [['enquiries', 'Enquiries received'], ['leads', 'Leads generated'], ['contactCalls', 'Calls and contact requests'], ['formConversions', 'Website enquiry conversions']] },
};
const num = (v, max) => { if (v == null || String(v).trim() === '') return null; const n = Number(String(v).replace(/,/g, '')); return Number.isFinite(n) && n >= 0 && n <= max ? n : null; };
function cleanMetrics(m) {
  const out = {}; const src = m && typeof m === 'object' ? m : {};
  for (const [g, def] of Object.entries(FIELDS)) { out[g] = {}; for (const [k] of def.items) { const v = num(src[g] && src[g][k], k === 'rating' ? 5 : 1e9); if (v != null) out[g][k] = v; } }
  const s = src.seo; if (s && typeof s === 'object' && Number.isFinite(Number(s.clicks))) out.seo = { clicks: num(s.clicks, 1e9), impressions: num(s.impressions, 1e12), ctr: num(s.ctr, 100), position: num(s.position, 1000), rows: Array.isArray(s.rows) ? s.rows.slice(0, 10).map((r) => ({ label: S.clip(r.label, 120), clicks: num(r.clicks, 1e9), impressions: num(r.impressions, 1e12), ctr: num(r.ctr, 100), position: num(r.position, 1000) })) : [], source: S.clip(s.source, 40) || 'Google Search Console CSV' };
  return out;
}

// ---- a small CSV reader (quotes, commas, line ends) and the Search Console export ---------------------------------------------------------------------------------------
function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false; const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i += 1; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { row.push(cur); cur = ''; } else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i += 1; row.push(cur); cur = ''; if (row.some((c) => c.trim() !== '')) rows.push(row); row = []; } else cur += ch;
  }
  row.push(cur); if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}
const cell = (v) => { const t = String(v == null ? '' : v).trim().replace(/,/g, ''); if (t === '') return null; const n = Number(t.replace('%', '')); return Number.isFinite(n) ? n : null; };
function parseSearchConsole(text) {
  const rows = parseCsv(text); if (rows.length < 2) return { error: 'That does not look like a Search Console export (no rows).', status: 400 };
  const head = rows[0].map((h) => String(h).trim().toLowerCase()); const ix = (re) => head.findIndex((h) => re.test(h));
  const c = ix(/click/); const im = ix(/impression/); const ct = ix(/ctr|click.?through/); const po = ix(/position/);
  if (c < 0 || im < 0) return { error: 'The file needs the columns Clicks and Impressions (export "Queries" or "Pages" from Search Console).', status: 400 };
  const data = []; for (const r of rows.slice(1)) { const clicks = cell(r[c]); const imp = cell(r[im]); if (clicks == null || imp == null) continue; data.push({ label: String(r[0] || '').trim().slice(0, 120), clicks, impressions: imp, ctr: ct >= 0 ? cell(r[ct]) : null, position: po >= 0 ? cell(r[po]) : null }); }
  if (!data.length) return { error: 'No rows with numbers were found in that file.', status: 400 };
  const clicks = data.reduce((a, r) => a + r.clicks, 0); const impressions = data.reduce((a, r) => a + r.impressions, 0);
  const withPos = data.filter((r) => r.position != null && r.impressions > 0); const posW = withPos.reduce((a, r) => a + r.impressions, 0);
  const position = posW ? Math.round((withPos.reduce((a, r) => a + r.position * r.impressions, 0) / posW) * 10) / 10 : null;
  const top = [...data].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, 10);
  return { seo: { clicks, impressions, ctr: impressions ? Math.round((clicks / impressions) * 10000) / 100 : null, position, rows: top, source: 'Google Search Console CSV', rowsRead: data.length } };
}

// ---- the report --------------------------------------------------------------------------------------------------------------------------------------------------------
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NP = 'Not provided';
const fmt = (v, k) => (v == null ? NP : k === 'rating' ? `${v} / 5` : Number(v).toLocaleString('en-IN'));
const monthWords = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
// the enquiries TeamLink itself recorded (clientLeads.js): counted, never typed, and kept apart from the team's own figures
function leadSection(c) {
  const n = (v) => Number(v).toLocaleString('en-IN');
  const rows = [['Enquiries recorded', c.total], ['From the enquiry form', c.form], ['Added by the team (calls, walk-ins)', c.hand], ['Call button presses', c.callPresses], ['WhatsApp button presses', c.whatsappPresses], ['Became customers', c.customers], ['Not yet contacted', c.waiting],
    ...c.bySource.map((x) => [`Came from ${x.words}`, x.count])];
  return { key: 'leads', title: 'Enquiries tracked by TeamLink', kind: 'table', rows: rows.map(([label, v]) => ({ label, value: n(v), given: true })) };
}
function sections({ plan, month, metrics, notes, audit, site, comp, cmp, leads }) {
  const m = metrics || {}; const sec = []; const improve = [];
  const prog = plan.progress || []; const done = prog.reduce((a, x) => a + Math.min(x.done, x.quota), 0); const quota = prog.reduce((a, x) => a + x.quota, 0);
  sec.push({ key: 'delivery', title: `What TeamLink delivered in ${monthWords(month)}`, kind: 'bars', rows: prog.map((x) => ({ label: x.label, done: x.done, quota: x.quota, pct: x.pct, over: x.over })), summary: `${done} of ${quota} items of the ${plan.planLabel} plan (${quota ? Math.round((done / quota) * 100) : 0}%). Counted from the work approved in TeamLink plus what the team added by hand.` });
  prog.filter((x) => x.left > 0).forEach((x) => improve.push(`${x.left} ${x.label} still to deliver for this month's plan.`)); // the label as written ("AI-assisted Reels", "Google Business Profile posts"): lowercasing it spoiled AI, Google, SEO
  for (const [g, def] of Object.entries(FIELDS)) sec.push({ key: g, title: def.label, kind: 'table', rows: def.items.map(([k, label]) => ({ label, value: fmt(m[g] && m[g][k], k), given: !!(m[g] && m[g][k] != null) })) });
  if (leads) { sec.push(leadSection(leads)); if (leads.waiting) improve.push(`${leads.waiting} ${leads.waiting === 1 ? 'enquiry is' : 'enquiries are'} still marked New: contact ${leads.waiting === 1 ? 'that person' : 'those people'}.`); }
  const seo = m.seo; sec.splice(2, 0, { key: 'seo', title: 'Search performance (Google Search Console)', kind: 'seo', given: !!seo, rows: seo ? [{ label: 'Search clicks', value: fmt(seo.clicks) }, { label: 'Search impressions', value: fmt(seo.impressions) }, { label: 'Click-through rate', value: seo.ctr == null ? NP : `${seo.ctr}%` }, { label: 'Average search position', value: seo.position == null ? NP : String(seo.position) }] : [], top: seo ? (seo.rows || []).slice(0, 10) : [], source: seo ? seo.source : '' });
  if (cmp && cmp.hasPrev) { sec.push(Cmp.section(cmp)); Cmp.improveLines(cmp).forEach((x) => improve.push(x)); } // this month beside the month before (monthCompare.js)
  if (audit) { sec.push({ key: 'audit', title: 'Google Business Profile quality audit (TeamLink\'s own score)', kind: 'score', score: audit.score, band: audit.band, when: audit.createdAt, note: "TeamLink's own audit score, not an official Google score or ranking." }); (audit.actions || []).slice(0, 3).forEach((a) => improve.push(`Google profile, ${a.area.toLowerCase()}: ${a.fix}`)); }
  if (site) {
    const perf = (s) => { const x = s && s.scores && s.scores.find((c) => c.key === 'performance'); return x && x.score != null ? x.score : null; };
    const ps = site.pagespeed ? ` · Google PageSpeed performance: phone ${perf(site.pagespeed.mobile) == null ? NP.toLowerCase() : perf(site.pagespeed.mobile)}, desktop ${perf(site.pagespeed.desktop) == null ? NP.toLowerCase() : perf(site.pagespeed.desktop)} (out of 100)` : '';
    const many = site.pages > 1; // a check of several pages (siteCrawl.js)
    sec.push({ key: 'site', title: many ? `Website check (what is on ${site.pages} pages)` : 'Website check (what is on the page)', kind: 'score', score: site.score, band: site.areas.map((a) => `${a.key} ${a.got}/${a.marks}`).join(' · ') + ps, when: site.checkedAt, url: site.url, note: `TeamLink's own check of ${many ? `${site.pages} pages of the website` : 'the page'}. It does not measure rankings or traffic.` }); site.actions.slice(0, 3).forEach((a) => improve.push(`Website, ${a.area}: ${a.fix}`)); }
  if (comp && comp.ranking) { // the newest saved competitor snapshot (competitors.js): the websites side by side, the Google numbers the team typed, and where competitors are ahead
    sec.push({ key: 'competitors', title: 'Competitor comparison (what is on each homepage)', kind: 'competitors', rows: comp.ranking.map((r) => ({ name: r.name, score: r.score, isClient: !!r.isClient })), google: (comp.google || []).map((g) => ({ label: g.label, values: g.values })), lines: (comp.summary || []).slice(0, 4), when: comp.createdAt || comp.comparedAt, note: 'TeamLink\'s own comparison of the websites. The Google numbers were typed by the team from each public profile. It does not show rankings or traffic.' });
    (comp.ahead || []).slice(0, 3).forEach((a) => improve.push(`Compared with competitors, ${a.area}: ${a.fix} (better at ${a.who.join(', ')})`));
  }
  return { sections: sec, improve: improve.slice(0, 12), notes: S.clip(notes, 1500) };
}
function html(plan, month, parts) {
  const css = 'body{font:14px/1.5 "Segoe UI",Roboto,Arial,sans-serif;color:#0f2a3d;margin:0;background:#fff}.wrap{max-width:820px;margin:0 auto;padding:28px}h1{font-size:24px;margin:0 0 4px}h2{font-size:16px;margin:22px 0 8px;border-bottom:2px solid #0f766e;padding-bottom:4px}table{border-collapse:collapse;width:100%}td,th{padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:left;font-size:13px}.np{color:#94a3b8}.bar{background:#e2e8f0;border-radius:6px;height:10px;overflow:hidden;min-width:120px}.bar i{display:block;height:100%;background:#0f766e}.big{font-size:34px;font-weight:800;color:#0f766e}.muted{color:#64748b;font-size:12px}ul{margin:6px 0 0;padding-left:20px}@media print{.wrap{padding:0}}';
  const out = [`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(plan.clientName)}: ${esc(monthWords(month))}</title><style>${css}</style></head><body><div class="wrap"><h1>${esc(plan.clientName)}</h1><div class="muted">Digital marketing report · ${esc(monthWords(month))} · ${esc(plan.planLabel)} plan · TeamLink Consultants</div>`];
  for (const s of parts.sections) {
    out.push(`<h2>${esc(s.title)}</h2>`);
    if (s.kind === 'bars') out.push(`<p>${esc(s.summary)}</p><table>${s.rows.map((r) => `<tr><td>${esc(r.label)}</td><td><div class="bar"><i style="width:${r.pct}%"></i></div></td><td>${r.done} of ${r.quota}${r.over ? ` (+${r.over} extra)` : ''}</td></tr>`).join('')}</table>`);
    else if (s.kind === 'table' || s.kind === 'seo') {
      if (s.kind === 'seo' && !s.given) out.push(`<p class="np">${NP}: no Search Console export was added for this month.</p>`);
      else out.push(`<table>${s.rows.map((r) => `<tr><td>${esc(r.label)}</td><td class="${r.value === NP ? 'np' : ''}">${esc(r.value)}</td></tr>`).join('')}</table>`);
      if (s.kind === 'seo' && s.top && s.top.length) out.push(`<p class="muted">Top results by clicks</p><table><tr><th>Query or page</th><th>Clicks</th><th>Impressions</th></tr>${s.top.map((r) => `<tr><td>${esc(r.label)}</td><td>${fmt(r.clicks)}</td><td>${fmt(r.impressions)}</td></tr>`).join('')}</table>`);
    } else if (s.kind === 'compare') out.push(Cmp.renderHtml(s.cmp, esc));
    else if (s.kind === 'score') out.push(`<div class="big">${s.score}<span class="muted"> / 100</span></div><div>${esc(s.band || '')}</div>${s.url ? `<div class="muted">${esc(s.url)}</div>` : ''}<div class="muted">${esc(s.note)}</div>`);
    else if (s.kind === 'competitors') {
      out.push(`<table><tr><th>Business</th><th>Website score</th></tr>${s.rows.map((r) => `<tr><td>${r.isClient ? '<b>' : ''}${esc(r.name)}${r.isClient ? ' (this client)</b>' : ''}</td><td>${r.score} / 100</td></tr>`).join('')}</table>`);
      for (const g of s.google) out.push(`<p class="muted">${esc(g.label)}: ${g.values.map((v) => `${esc(v.name)} ${v.value == null ? NP.toLowerCase() : esc(v.value)}`).join(' · ')}</p>`);
      out.push(`<ul>${s.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><div class="muted">${esc(s.note)}</div>`);
    }
  }
  out.push('<h2>What we will improve next</h2>'); out.push(parts.improve.length ? `<ul>${parts.improve.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="np">Nothing is listed yet. Run the profile audit and the website check to fill this.</p>');
  if (parts.notes) out.push(`<h2>Note from the team</h2><p>${esc(parts.notes).replace(/\n/g, '<br>')}</p>`);
  out.push('<p class="muted" style="margin-top:26px">TeamLink reports measured results from the real sources, not guaranteed rankings or guaranteed leads. A figure marked "Not provided" was not available for this month. Content is delivered subject to client approval and the agreed scope.</p></div></body></html>');
  return out.join('');
}
function text(plan, month, parts) {
  const L = [`${plan.clientName}: digital marketing report, ${monthWords(month)} (${plan.planLabel} plan)`, ''];
  for (const s of parts.sections) {
    L.push(s.title.toUpperCase());
    if (s.kind === 'bars') { L.push(s.summary); s.rows.forEach((r) => L.push(`- ${r.label}: ${r.done} of ${r.quota}`)); }
    else if (s.kind === 'table' || s.kind === 'seo') { if (s.kind === 'seo' && !s.given) L.push(`${NP}.`); else s.rows.forEach((r) => L.push(`- ${r.label}: ${r.value}`)); }
    else if (s.kind === 'compare') Cmp.renderText(s.cmp).forEach((l) => L.push(l));
    else if (s.kind === 'score') L.push(`Score ${s.score}/100. ${s.note}`);
    else if (s.kind === 'competitors') { s.rows.forEach((r) => L.push(`- ${r.name}${r.isClient ? ' (this client)' : ''}: ${r.score}/100`)); s.lines.forEach((l) => L.push(`- ${l}`)); }
    L.push('');
  }
  L.push('WHAT WE WILL IMPROVE NEXT'); (parts.improve.length ? parts.improve : ['Nothing is listed yet.']).forEach((x) => L.push(`- ${x}`));
  if (parts.notes) L.push('', 'NOTE FROM THE TEAM', parts.notes);
  L.push('', 'TeamLink reports measured results, not guaranteed rankings or leads. "Not provided" = not available for this month.');
  return L.join('\n');
}

async function rowFor(planId, month) { return (await S.q(`SELECT * FROM "${T}" WHERE planId = ? AND month = ?`, planId, month))[0] || null; }
async function build(u, planId, month) {
  if (!(await ensure())) return { error: 'The report could not be opened.', status: 500 };
  const m = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || '')) ? month : CS.istMonth();
  const p = await CS.getPlan(u, planId, m); if (p.error) return p; const plan = p.plan;
  const row = await rowFor(planId, m); const metrics = cleanMetrics(S.parse(row && row.metrics, {})); const notes = row ? row.notes || '' : '';
  let audit = null; const al = await CS.listAudits(u, { planId }); if (al.items && al.items[0]) { const a = await CS.getAudit(u, al.items[0].id); if (a.audit) audit = { score: a.audit.score, band: a.audit.report.band, createdAt: a.audit.createdAt, actions: a.audit.report.actions.filter((x) => !x.unchecked) }; }
  let site = null; const sl = await Site.latestFor(u, plan.clientName); if (sl) { const g = await Site.get(u, sl.id); if (g.report) site = { score: g.report.score, areas: g.report.areas, actions: g.report.actions, url: g.report.url, checkedAt: g.report.checkedAt, pages: g.report.crawl ? g.report.crawl.read : 1, pagespeed: g.report.pagespeed || null }; }
  const comp = await Comp.latestFor(u, plan.clientName).catch(() => null);
  const prow = await rowFor(planId, Cmp.prevMonthOf(m)); const prevMetrics = prow ? cleanMetrics(S.parse(prow.metrics, {})) : null; // last month's saved numbers, if any
  const cmp = await Cmp.make(u, plan, m, { metrics, prevMetrics, fields: FIELDS });
  const leads = await require('./clientLeads').reportCounts(planId, m).catch(() => null); // eslint-disable-line global-require
  const parts = sections({ plan, month: m, metrics, notes, audit, site, comp, cmp, leads });
  return { month: m, plan: { id: plan.id, clientName: plan.clientName, planLabel: plan.planLabel }, metrics, notes, fields: FIELDS, comparison: cmp, report: { html: html(plan, m, parts), text: text(plan, m, parts), improve: parts.improve }, saved: !!row, updatedAt: row ? S.iso(row.updatedAt) : null };
}
async function save(u, planId, b = {}) {
  if (!(await ensure())) return { error: 'The report could not be saved.', status: 500 };
  const m = String(b.month || ''); if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) return { error: 'Pick the month.', status: 400 };
  const p = await CS.getPlan(u, planId, m); if (p.error) return p;
  const metrics = cleanMetrics(b.metrics); const notes = S.clip(b.notes, 1500); const ex = await rowFor(planId, m);
  if (ex) await S.run(`UPDATE "${T}" SET metrics=?, notes=?, updatedById=?, updatedByName=?, updatedAt=? WHERE planId=? AND month=?`, JSON.stringify(metrics), notes || null, u.id, S.clip(u.name, 80), Date.now(), planId, m);
  else await S.run(`INSERT INTO "${T}" (id, planId, month, metrics, notes, updatedById, updatedByName, updatedAt) VALUES (?,?,?,?,?,?,?,?)`, S.newId('mrp'), planId, m, JSON.stringify(metrics), notes || null, u.id, S.clip(u.name, 80), Date.now());
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: monthly report saved', entity: T, entityId: planId, toValue: `${p.plan.clientName}: ${m}` });
  return build(u, planId, m);
}
module.exports = { ensure, FIELDS, cleanMetrics, parseCsv, cell, parseSearchConsole, build, save, sections };
