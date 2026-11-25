// ---------------------------------------------------------------------------
// AI MARKETING > CLIENT PLANS > MONTHLY REPORT > "COMPARED WITH LAST MONTH" (2026-11-25). A report that shows only this month cannot show progress. This puts the month beside the month before it:
//   * every number the team typed or imported for BOTH months (social media, Google Business Profile, business results, Search Console clicks / impressions / click-through rate / average position),
//     with the change: up or down by how much, in per cent where that makes sense, and whether it is better or worse (for the average search position LOWER is better);
//   * what was delivered against the plan in both months;
//   * the score of the Google profile audit and of the website check at the end of each month (the newest check saved up to then), so a re-check shows its progress.
// HONEST BY DESIGN: a number missing in either month is never turned into a zero or a guess: it is listed as "not comparable". A fall is shown as a fall, in red, and the improvement plan asks why.
//   If no numbers were saved for last month, the report says so and says how to add them; if the plan began after last month, there is nothing to compare and no section is made. Two website
//   checks that covered a different number of pages are marked as not directly comparable. Plain code on what is already saved: nothing is read from outside, nothing is sent.
// ---------------------------------------------------------------------------
const CS = require('./clientServices');
const Site = require('./siteCheck');

const monthWords = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayWords = (iso) => { try { return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }); } catch { return ''; } };
function prevMonthOf(m) { const [y, mo] = String(m).split('-').map(Number); return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`; }
const r2 = (n) => Math.round(n * 100) / 100;
const present = (v) => v != null && v !== '' && Number.isFinite(Number(v));
const SEO_ROWS = [['clicks', 'Search clicks'], ['impressions', 'Search impressions'], ['ctr', 'Click-through rate'], ['position', 'Average search position']];

function fmtVal(key, v) { if (!present(v)) return 'Not provided'; if (key === 'rating') return `${v} / 5`; if (key === 'ctr') return `${v}%`; if (key === 'position') return String(v); return Number(v).toLocaleString('en-IN'); }
// one number, two months -> the change and whether it is better or worse (average position: lower is better)
function judge(key, before, now) {
  const d = r2(Number(now) - Number(before)); const lowerBetter = key === 'position'; const pctOk = !['rating', 'ctr', 'position'].includes(key) && Number(before) !== 0;
  const pct = pctOk ? Math.round((Math.abs(d) / Math.abs(Number(before))) * 100) : null; const dir = d > 0 ? 'up' : d < 0 ? 'down' : 'same'; const better = d === 0 ? 'same' : (lowerBetter ? d < 0 : d > 0) ? 'better' : 'worse';
  const a = Math.abs(d); const num = Number.isInteger(a) ? a.toLocaleString('en-IN') : String(a);
  const unit = key === 'ctr' ? ' percentage points' : key === 'position' ? (a === 1 ? ' place' : ' places') : '';
  const words = d === 0 ? 'no change' : key === 'position' ? `${better} by ${num}${unit}` : `${dir} ${num}${unit}${pct != null ? ` (${pct}%)` : ''}`;
  const short = d === 0 ? 'No change' : `${d > 0 ? '+' : '−'}${num}${key === 'ctr' ? ' pp' : ''}${pct != null ? ` (${d > 0 ? '+' : '−'}${pct}%)` : ''}${key === 'position' ? ` (${better})` : ''}`;
  return { delta: d, pct, direction: dir, better, words, short };
}
function metricRows(fields, cur, prev, nowW, prevW) {
  const defs = [...Object.entries(fields).flatMap(([g, def]) => def.items.map(([k, label]) => ({ group: g, groupLabel: def.label, key: k, label, get: (m) => m[g] && m[g][k] }))), ...SEO_ROWS.map(([k, label]) => ({ group: 'seo', groupLabel: 'Search performance (Google Search Console)', key: k, label, get: (m) => m.seo && m.seo[k] }))];
  const rows = []; const missing = [];
  for (const d of defs) {
    const a = d.get(prev); const b = d.get(cur); const hasA = present(a); const hasB = present(b); if (!hasA && !hasB) continue;
    if (!hasA || !hasB) { missing.push({ group: d.group, label: d.label, why: !hasB ? `not provided for ${nowW}` : `not provided for ${prevW}` }); continue; }
    rows.push({ group: d.group, groupLabel: d.groupLabel, key: d.key, label: d.label, before: Number(a), now: Number(b), beforeText: fmtVal(d.key, a), nowText: fmtVal(d.key, b), ...judge(d.key, a, b) });
  }
  return { rows, missing };
}

async function scoreRows(u, plan, month) { // the newest audit / website check saved up to the end of each month
  const [start, end] = CS.monthRange(month); const out = []; const notes = []; const pick = (items, limit) => (items || []).find((x) => Date.parse(x.createdAt) < limit) || null;
  const one = (key, label, now, before) => {
    if (!now || !before) return; if (now.id === before.id) { notes.push(`${label}: no new check was saved in this month (the last one is from ${dayWords(now.createdAt)}).`); return; }
    const d = r2(now.score - before.score); out.push({ key, label, now: now.score, before: before.score, delta: d, better: d === 0 ? 'same' : d > 0 ? 'better' : 'worse', nowWhen: now.createdAt, beforeWhen: before.createdAt, words: d === 0 ? 'no change' : `${d > 0 ? 'up' : 'down'} ${Math.abs(d)}`, short: d === 0 ? 'No change' : `${d > 0 ? '+' : '−'}${Math.abs(d)}` });
    if (key === 'site' && (now.pages || 1) !== (before.pages || 1)) notes.push(`The two website checks covered a different number of pages (${before.pages || 1} and ${now.pages || 1}), so their scores are not directly comparable.`);
  };
  try { const al = await CS.listAudits(u, { planId: plan.id }); one('audit', "Google profile audit score (TeamLink's own)", pick(al.items, end), pick(al.items, start)); } catch { /* no audits */ }
  try { const sl = await Site.list(u, { clientName: plan.clientName }); one('site', 'Website check score (TeamLink\'s own)', pick(sl.items, end), pick(sl.items, start)); } catch { /* no checks */ }
  return { rows: out, notes };
}
const totalOf = (prog) => { const quota = prog.reduce((a, x) => a + x.quota, 0); const done = prog.reduce((a, x) => a + Math.min(x.done, x.quota), 0); return { done, quota, pct: quota ? Math.round((done / quota) * 100) : 0 }; };

// plan: the plan as CS.getPlan gives it (for the month shown); extra: { metrics, prevMetrics (null when nothing was saved), fields }
async function make(u, plan, month, extra) {
  const prev = prevMonthOf(month); const nowW = monthWords(month); const prevW = monthWords(prev);
  const base = { month, prevMonth: prev, nowWords: nowW, prevWords: prevW };
  if (!(plan.startDate <= `${prev}-31` && plan.endDate > `${prev}-01`)) return { ...base, hasPrev: false, notes: ['This is the first month of the plan, so there is nothing earlier to compare with.'], rows: [], missing: [], delivery: null, scores: [], lines: [] };
  const notes = []; if (plan.startDate > `${prev}-01`) notes.push(`The plan started on ${plan.startDate}, so ${prevW} was a part month.`);
  let rows = []; let missing = [];
  if (extra.prevMetrics) ({ rows, missing } = metricRows(extra.fields, extra.metrics || {}, extra.prevMetrics, nowW, prevW));
  else notes.push(`No numbers were saved for ${prevW}, so the typed and Search Console numbers cannot be compared. Choose ${prevW} in "Month shown", open Monthly report and save its numbers.`);
  const pp = await CS.getPlan(u, plan.id, prev); const before = pp.plan ? pp.plan.progress : []; const tNow = totalOf(plan.progress || []); const tBefore = totalOf(before);
  const delivery = { total: { before: tBefore, now: tNow, delta: tNow.pct - tBefore.pct }, rows: (plan.progress || []).map((x) => { const b = before.find((y) => y.item === x.item); return { item: x.item, label: x.label, quota: x.quota, now: x.done, before: b ? b.done : null, delta: b ? x.done - b.done : null }; }) };
  const sc = await scoreRows(u, plan, month); notes.push(...sc.notes);
  const lines = [];
  for (const r of rows) lines.push(`${r.label}: ${r.beforeText} in ${prevW}, ${r.nowText} in ${nowW} (${r.words}).`);
  if (missing.length) lines.push(`Not compared, because a number is missing in one of the two months: ${missing.map((x) => `${x.label} (${x.why})`).join('; ')}.`);
  lines.push(`Delivered against the plan: ${tBefore.pct}% in ${prevW}, ${tNow.pct}% in ${nowW}.`);
  for (const s of sc.rows) lines.push(`${s.label}: ${s.before} on ${dayWords(s.beforeWhen)}, ${s.now} on ${dayWords(s.nowWhen)} (${s.words}).`);
  return { ...base, hasPrev: true, metricsSaved: !!extra.prevMetrics, rows, missing, delivery, scores: sc.rows, notes, lines, worse: rows.filter((r) => r.better === 'worse') };
}
// the report section (the data; html() and text() of monthlyReport.js draw it) and the improvement lines for what went down
const section = (c) => ({ key: 'compare', title: `Compared with ${c.prevWords}`, kind: 'compare', cmp: c });
const improveLines = (c) => (c.worse || []).slice(0, 2).map((r) => `${r.label} went down from ${r.beforeText} in ${c.prevWords} to ${r.nowText}. Find out why before next month (what changed on the profile, the website or the posting).`);
function renderHtml(c, esc) {
  const colour = (b) => (b === 'better' ? '#15803d' : b === 'worse' ? '#b91c1c' : '#64748b'); const out = [];
  if (c.notes.length) out.push(`<p class="muted">${c.notes.map(esc).join(' ')}</p>`);
  if (c.rows.length) {
    out.push(`<table><tr><th>Measure</th><th>${esc(c.prevWords)}</th><th>${esc(c.nowWords)}</th><th>Change</th></tr>`);
    let g = ''; for (const r of c.rows) { if (r.groupLabel !== g) { g = r.groupLabel; out.push(`<tr><th colspan="4" style="background:#f1f5f9">${esc(g)}</th></tr>`); } out.push(`<tr><td>${esc(r.label)}</td><td>${esc(r.beforeText)}</td><td>${esc(r.nowText)}</td><td style="color:${colour(r.better)};font-weight:700">${esc(r.short)}</td></tr>`); }
    out.push('</table>');
  }
  if (c.missing.length) out.push(`<p class="muted">Not compared, because a number is missing in one of the two months: ${c.missing.map((x) => `${esc(x.label)} (${esc(x.why)})`).join('; ')}.</p>`);
  if (c.delivery) {
    out.push(`<p>Delivered against the plan: <b>${c.delivery.total.before.pct}%</b> in ${esc(c.prevWords)}, <b>${c.delivery.total.now.pct}%</b> in ${esc(c.nowWords)}.</p>`);
    out.push(`<table><tr><th>Delivered</th><th>${esc(c.prevWords)}</th><th>${esc(c.nowWords)}</th></tr>${c.delivery.rows.map((r) => `<tr><td>${esc(r.label)}</td><td>${r.before == null ? 'Not provided' : `${r.before} of ${r.quota}`}</td><td>${r.now} of ${r.quota}</td></tr>`).join('')}</table>`);
  }
  if (c.scores.length) out.push(`<table><tr><th>TeamLink's own scores</th><th>Before</th><th>Now</th><th>Change</th></tr>${c.scores.map((s) => `<tr><td>${esc(s.label)}</td><td>${s.before} <span class="muted">(${esc(dayWords(s.beforeWhen))})</span></td><td>${s.now} <span class="muted">(${esc(dayWords(s.nowWhen))})</span></td><td style="color:${colour(s.better)};font-weight:700">${esc(s.short)}</td></tr>`).join('')}</table>`);
  out.push('<div class="muted">A figure is compared only when it was given for both months. Changes are shown as they are, up or down. They are measured results, not a promise about next month.</div>');
  return out.join('');
}
function renderText(c) { const L = []; c.notes.forEach((n) => L.push(n)); c.lines.forEach((l) => L.push(`- ${l}`)); return L; }

module.exports = { make, section, improveLines, renderHtml, renderText, judge, metricRows, prevMonthOf, fmtVal };
