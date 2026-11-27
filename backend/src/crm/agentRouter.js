// ---------------------------------------------------------------------------
// THE CRM AGENT - EXACT ANSWERS FIRST (founder 2026-11-27: "crm agent ni kuda proper ga, ye kind of questions adigina answer chesey laaga train cheyyu").
//
// Before, every question went to the language model with a short fact sheet (the top 25 open deals, 25 leads, a few follow-ups): "how many
// leads came from LinkedIn this month", "deals won last month", "pending invoices", "lost reasons", "who has the most deals" could not be
// answered or were guessed. Now the common questions are answered IN CODE from the CRM tables, exact numbers inside the login's own scope
// (service.scopeSql: a salesperson their own records, a Sales manager / Admin everyone's), each record named with a link:
//
//   leads      count / list, new in a period, by stage, source, rating, city, owner; converted        deals      the open pipeline (value, likely),
//   won / lost in a period (value, lost reasons), closing in a period, stuck (nothing for N days), biggest                         customers / contacts
//   follow-ups (today, late, coming, this week) and meetings      activity (calls, mails, WhatsApp, meetings logged, by person)      invoices (raised,
//   unpaid, overdue, collected)      payments      tickets (open, late, by priority)      campaigns      quotes / proposals      products      target
//   leaderboard (who won / added / logged the most)      one lead / deal / customer named in the question
//
// Anything else (advice, a draft, a follow-up like "and the second one?", an open question) goes to the model, which now also gets the
// totals this file reads (factsSummary). The periods and the Telugu / Hindi words are the BDE Agent's (utils/bdeAgentLang.js). READ ONLY.
// ---------------------------------------------------------------------------
const DB = require('./schema');
const S = require('./service');
const SETTINGS = require('./settings');
const L = require('../utils/bdeAgentLang');

const SHOW = 15;
const rs = (n) => `Rs ${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const inP = (col, p) => ({ sql: `substr(${col}, 1, 10) >= ? AND substr(${col}, 1, 10) <= ?`, params: [p.from, p.to > L.todayIst() ? L.todayIst() : p.to] });
const OPEN_DEAL = 'x."stage" NOT IN (\'Won\', \'Lost\')';
const OPEN_LEAD = 'COALESCE(x."status", \'New\') NOT IN (\'Converted\', \'Junk\')';
const has = (re, t) => re.test(t);

// ---- what the question is about -----------------------------------------------------------------------------------------------------
const T = {
  leads: /\bleads?\b|\bprospects?\b|\benquir\w*\b|\binquir\w*\b/,
  deals: /\bdeals?\b|\bpipeline\b|\bopportunit\w*\b|\bforecast\b/,
  won: /\bwon\b|\bwins?\b|\bclosed won\b|\brevenue\b|\bsales (this|last|in)\b|\bbooked\b|\bclosed deals?\b/,
  lost: /\blost\b|\blos(e|ing)\b|\bloss reasons?\b/,
  customers: /\baccounts?\b|\bcustomers?\b|\bclients?\b|\bcompan(y|ies)\b/,
  contacts: /\bcontacts?\b|\bdecision makers?\b|\bpeople at\b/,
  followups: /\bfollow ?ups?\b|\btasks?\b|\bcall ?backs?\b|\bto ?dos?\b|\breminders?\b|\bpending work\b/,
  meetings: /\bmeetings?\b|\bdemos?\b|\bappointments?\b/,
  activity: /\bactivit\w*\b|\bcalls? (made|done|logged)\b|\bhow many calls\b|\bemails? (sent|logged)\b|\bwhatsapps? sent\b|\blogged\b|\b(enni|how many|number of|count of|total)\b.{0,12}\b(calls?|emails?|mails?|whatsapps?)\b|\b(calls?|emails?|mails?)\b.{0,20}\b(chesam|chesanu|chesaru|pampam|today|yesterday|ninna|this week|last week|this month)\b/,
  invoices: /\binvoices?\b|\bbills?\b|\boutstanding\b|\bdues?\b|\breceivables?\b|\bunpaid\b|\boverdue amount\b/,
  payments: /\bpayments?\b|\bcollected\b|\bcollections?\b|\breceived\b|\bmoney came\b/,
  tickets: /\btickets?\b|\bsupport\b|\bcomplaints?\b|\bissues?\b|\bescalat\w*\b/,
  campaigns: /\bcampaigns?\b|\bbulk (mail|sms|whatsapp)\b/,
  quotes: /\bquotes?\b|\bquotations?\b|\bproposals?\b|\bestimates?\b/,
  products: /\bproducts?\b|\bplans?\b|\bpricing\b/,
  target: /\btargets?\b|\bquota\b|\bachiev\w*\b|\bhow far\b/,
  rank: /\bwho (has|have|is|got|made|won|brought|added|logged|did)\b|\btop (sales|salesperson|performer|bde)\w*\b|\bbest (sales|performer)\w*\b|\bleaderboard\b|\branking\b|\b(by|per) (owner|person|salesperson|bde|member)\b|\b(owner|salesperson|person)[- ]?wise\b|\bmost (deals|leads|calls|revenue|won)\b/,
};
const NOT_FOR_CODE = /\b(write|draft|compose|email to|mail to|message to|pitch|objection|convince|negotiat\w*|tips?|advice|advise|suggest\w*|strategy|improve|why|explain|meaning of|what is a|what are the benefits|how (do|can|should) i (sell|convince|handle|reply|answer|approach|pitch))\b/;
const FOLLOW_ON = /^(and|also|what about|how about|the (first|second|third|last) one|that one|this one|them|it|those|these|more|next)\b|\b(the (first|second|third|last) one|that one|this one)\b/;

// ---- small pieces ---------------------------------------------------------------------------------------------------------------------
function ctxOf(user) {
  const r = S.roleOf(user);
  return { user, r, all: S.seesAll(r), today: L.todayIst(), sc: (alias) => S.scopeSql(user, r, alias) };
}
const leadItem = (x, sub) => ({ kind: 'lead', id: x.id, label: x.company, sub });
const dealItem = (x, sub) => ({ kind: 'deal', id: x.id, label: x.title, sub });
const accItem = (x, sub) => ({ kind: 'account', id: x.id, label: x.name, sub });
const countBy = (rows, key, label = (v) => v || 'Not set') => {
  const m = new Map(); rows.forEach((x) => { const k = label(typeof key === 'function' ? key(x) : x[key]); m.set(k, (m.get(k) || 0) + 1); });
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const line = (title, pairs, max = 8) => (pairs.length ? `${title}: ${pairs.slice(0, max).map(([k, n]) => `${k} ${n}`).join(' · ')}${pairs.length > max ? ` · +${pairs.length - max} more` : ''}` : null);
function out(intent, title, lines = [], items = [], total) {
  const shown = items.slice(0, SHOW);
  const more = Math.max(0, (total == null ? items.length : total) - shown.length);
  const text = [title, ...lines.filter(Boolean), ...shown.map((i) => `• ${i.label}${i.sub ? ` · ${i.sub}` : ''}`), more ? `+ ${more} more (open the list in the CRM)` : null].filter(Boolean).join('\n');
  return { intent, text, items: shown, count: total == null ? items.length : total };
}

// filters the words name: rating, a lead stage / status, a source, a city / industry, an owner
async function filtersOf(ctx, t) {
  const f = {};
  const rating = /\bhot\b/.test(t) ? 'Hot' : /\bwarm\b/.test(t) ? 'Warm' : /\bcold\b(?! call)/.test(t) ? 'Cold' : null;
  if (rating) f.rating = rating;
  const st = await SETTINGS.load();
  const stages = (st.leadStages || []).map((s) => s.name).filter(Boolean);
  const stage = stages.find((s) => new RegExp(`\\b${s.toLowerCase()}\\b`).test(t) && !['won', 'lost'].includes(s.toLowerCase()));
  if (stage) f.stage = stage;
  if (/\bconverted\b/.test(t)) f.converted = true;
  const sources = (st.sources || []);
  const src = sources.find((s) => new RegExp(`\\b${s.toLowerCase().replace(/[^a-z0-9 ]/g, '.')}\\b`).test(t)) || (/\blinked ?in\b/.test(t) ? 'LinkedIn' : /\bwebsite\b|\bweb form\b/.test(t) ? 'Website' : /\breferr?al\b/.test(t) ? 'Referral' : /\bwhats ?app\b/.test(t) ? 'WhatsApp' : null);
  if (src) f.source = src;
  const team = await S.ownerOptions().catch(() => []);
  if (ctx.all) {
    const who = team.find((o) => { const w = String(o.name || '').toLowerCase().split(/\s+/).filter((x) => x.length >= 3); return w.length && w.some((x) => new RegExp(`\\b${x}\\b`).test(t)); });
    if (who) f.owner = who;
  }
  const cities = await DB.all('SELECT DISTINCT LOWER(TRIM("city")) AS c FROM "CrmLead" WHERE "city" IS NOT NULL AND TRIM("city") != \'\' UNION SELECT DISTINCT LOWER(TRIM("city")) FROM "CrmAccount" WHERE "city" IS NOT NULL AND TRIM("city") != \'\'').catch(() => []);
  const city = cities.map((x) => x.c).find((c) => c && c.length >= 3 && new RegExp(`\\b${c.replace(/[^a-z0-9 ]/g, '.')}\\b`).test(t));
  if (city) f.city = city;
  const inds = await DB.all('SELECT DISTINCT LOWER(TRIM("industry")) AS c FROM "CrmLead" WHERE "industry" IS NOT NULL AND TRIM("industry") != \'\'').catch(() => []);
  const ind = inds.map((x) => x.c).find((c) => c && c.length >= 3 && new RegExp(`\\b${c.replace(/[^a-z0-9 ]/g, '.')}\\b`).test(t));
  if (ind) f.industry = ind;
  return f;
}
const fWords = (f) => [f.rating, f.stage, f.source && `from ${f.source}`, f.city && `in ${f.city}`, f.industry, f.owner && `of ${f.owner.name}`].filter(Boolean).join(', ');

// ---- the answers ------------------------------------------------------------------------------------------------------------------------
async function leads(ctx, t, p, f) {
  const s = ctx.sc('x.');
  const where = [s.sql]; const params = [...s.params];
  if (f.rating) { where.push('x."rating" = ?'); params.push(f.rating); }
  if (f.stage) { where.push('COALESCE(x."stage", x."status") = ?'); params.push(f.stage); }
  if (f.source) { where.push('LOWER(x."source") = ?'); params.push(f.source.toLowerCase()); }
  if (f.city) { where.push('LOWER(TRIM(x."city")) = ?'); params.push(f.city); }
  if (f.industry) { where.push('LOWER(TRIM(x."industry")) = ?'); params.push(f.industry); }
  if (f.owner) { where.push('x."ownerId" = ?'); params.push(f.owner.id); }
  let when;
  if (f.converted) { const d = inP('x."convertedAt"', p.named ? p : { from: '2000-01-01', to: ctx.today }); where.push('x."status" = \'Converted\'', d.sql); params.push(...d.params); when = p.named ? p.label('en') : 'All time'; } else if (p.named) { const d = inP('x."createdAt"', p); where.push(d.sql); params.push(...d.params); when = `${p.label('en')} (added)`; } else { where.push(OPEN_LEAD); when = `Now (${L.dm(ctx.today)}) open`; }
  const rows = await DB.all(`SELECT x."id", x."company", x."contactName", x."status", x."stage", x."rating", x."source", x."city", x."ownerName", x."createdAt" FROM "CrmLead" x WHERE ${where.join(' AND ')} ORDER BY x."createdAt" DESC`, ...params);
  const fw = fWords(f);
  return out('leads', `${when}: ${plural(rows.length, f.converted ? 'lead converted' : 'lead', f.converted ? 'leads converted' : 'leads')}${fw ? ` (${fw})` : ''}`,
    [line('By stage', countBy(rows, (x) => x.stage || x.status)), !f.source && line('By source', countBy(rows, 'source')), !f.rating && line('By rating', countBy(rows, 'rating')), ctx.all && !f.owner && line('By owner', countBy(rows, 'ownerName'))],
    rows.map((x) => leadItem(x, [x.stage || x.status, x.rating, x.source, x.city, ctx.all ? x.ownerName : null].filter(Boolean).join(' · '))), rows.length);
}
async function deals(ctx, t, p, f) {
  const s = ctx.sc('x.');
  const st = await SETTINGS.load();
  const where = [s.sql, OPEN_DEAL]; const params = [...s.params];
  if (f.owner) { where.push('x."ownerId" = ?'); params.push(f.owner.id); }
  let title = `Now (${L.dm(ctx.today)}): open pipeline`;
  const closing = /\bclos(e|es|ing)\b|\bdue\b|\bexpected\b/.test(t) && p.named;
  const stuck = /\bstuck\b|\bstale\b|\bno activity\b|\bnot moving\b|\bneed(s)? (my )?attention\b|\bat risk\b|\brisk\b|\bgoing cold\b/.test(t);
  if (closing) { where.push('x."expectedClose" >= ? AND x."expectedClose" <= ?'); params.push(p.from, p.to); title = `${p.label('en')}: deals expected to close`; }
  if (stuck) { where.push('substr(x."updatedAt", 1, 10) <= ?'); params.push(L.addDays(ctx.today, -(st.staleDays || 14))); title = `Now: open deals with nothing for ${st.staleDays || 14}+ days`; }
  const rows = await DB.all(`SELECT x."id", x."title", x."stage", x."value", x."probability", x."expectedClose", x."ownerName", x."updatedAt", a."name" AS "account" FROM "CrmDeal" x LEFT JOIN "CrmAccount" a ON a."id" = x."accountId" WHERE ${where.join(' AND ')} ORDER BY x."value" DESC`, ...params);
  const value = rows.reduce((n, x) => n + (Number(x.value) || 0), 0);
  const likely = rows.reduce((n, x) => n + ((Number(x.value) || 0) * (Number(x.probability) || 0)) / 100, 0);
  return out('deals', `${title}: ${plural(rows.length, 'deal', 'deals')} worth ${rs(value)}${f.owner ? ` (${f.owner.name})` : ''}`,
    [`Likely (value x chance): ${rs(likely)}`, line('By stage', countBy(rows, 'stage'), 10), ctx.all && !f.owner && line('By owner', countBy(rows, 'ownerName'))],
    rows.map((x) => dealItem(x, [x.account, x.stage, rs(x.value), x.expectedClose ? `close ${L.dmy(x.expectedClose)}` : null, ctx.all ? x.ownerName : null].filter(Boolean).join(' · '))), rows.length);
}
async function wonLost(ctx, t, p, f, kind) {
  const s = ctx.sc('x.');
  const col = kind === 'Won' ? 'x."wonAt"' : 'x."lostAt"';
  const d = inP(`COALESCE(${col}, x."updatedAt")`, p);
  const where = [s.sql, 'x."stage" = ?', d.sql]; const params = [...s.params, kind, ...d.params];
  if (f.owner) { where.push('x."ownerId" = ?'); params.push(f.owner.id); }
  const rows = await DB.all(`SELECT x."id", x."title", x."value", x."lostReason", x."ownerName", ${col} AS "at", a."name" AS "account" FROM "CrmDeal" x LEFT JOIN "CrmAccount" a ON a."id" = x."accountId" WHERE ${where.join(' AND ')} ORDER BY COALESCE(${col}, x."updatedAt") DESC`, ...params);
  const value = rows.reduce((n, x) => n + (Number(x.value) || 0), 0);
  return out(kind === 'Won' ? 'won' : 'lost', `${p.label('en')}: ${plural(rows.length, `deal ${kind.toLowerCase()}`, `deals ${kind.toLowerCase()}`)} worth ${rs(value)}${f.owner ? ` (${f.owner.name})` : ''}`,
    [kind === 'Lost' && line('Why', countBy(rows, 'lostReason', (v) => v || 'No reason given'), 10), ctx.all && !f.owner && line('By owner', countBy(rows, 'ownerName'))],
    rows.map((x) => dealItem(x, [x.account, rs(x.value), x.at ? L.dmy(String(x.at).slice(0, 10)) : null, kind === 'Lost' ? x.lostReason : null, ctx.all ? x.ownerName : null].filter(Boolean).join(' · '))), rows.length);
}
async function customers(ctx, t, p, f) {
  const s = ctx.sc('x.');
  const where = [s.sql]; const params = [...s.params];
  if (p.named) { const d = inP('x."createdAt"', p); where.push(d.sql); params.push(...d.params); }
  if (/\bcustomers?\b|\bclients?\b/.test(t) && !/\bprospects?\b/.test(t)) where.push('x."kind" != \'Prospect\'');
  if (f.city) { where.push('LOWER(TRIM(x."city")) = ?'); params.push(f.city); }
  if (f.owner) { where.push('x."ownerId" = ?'); params.push(f.owner.id); }
  const rows = await DB.all(`SELECT x."id", x."name", x."kind", x."industry", x."city", x."ownerName" FROM "CrmAccount" x WHERE ${where.join(' AND ')} ORDER BY x."createdAt" DESC`, ...params);
  return out('customers', `${p.named ? `${p.label('en')} (added)` : `Now (${L.dm(ctx.today)})`}: ${plural(rows.length, 'account', 'accounts')}${fWords(f) ? ` (${fWords(f)})` : ''}`,
    [line('By kind', countBy(rows, 'kind')), line('By industry', countBy(rows, 'industry')), ctx.all && !f.owner && line('By owner', countBy(rows, 'ownerName'))],
    rows.map((x) => accItem(x, [x.kind, x.industry, x.city, ctx.all ? x.ownerName : null].filter(Boolean).join(' · '))), rows.length);
}
async function contacts(ctx, t) {
  const s = ctx.sc('x.');
  const dm = /\bdecision makers?\b/.test(t);
  const rows = await DB.all(`SELECT x."id", x."name", x."designation", x."role", x."accountId", a."name" AS "account" FROM "CrmContact" x LEFT JOIN "CrmAccount" a ON a."id" = x."accountId" WHERE ${s.sql}${dm ? ' AND x."role" = \'Decision maker\'' : ''} ORDER BY x."createdAt" DESC`, ...s.params);
  return out('contacts', `Now: ${plural(rows.length, dm ? 'decision maker' : 'contact', dm ? 'decision makers' : 'contacts')}`, [line('By role', countBy(rows, 'role'))],
    rows.map((x) => ({ kind: x.accountId ? 'account' : 'contact', id: x.accountId || x.id, label: x.name, sub: [x.designation, x.role, x.account].filter(Boolean).join(' · ') })), rows.length);
}
async function followups(ctx, t, p) {
  const when = /\blate\b|\boverdue\b|\bmissed\b|\bpending\b/.test(t) ? 'overdue' : /\btomorrow\b/.test(t) ? 'tomorrow' : /\bthis week\b|\bweek\b|\bcoming\b|\bupcoming\b|\bnext\b/.test(t) ? 'upcoming' : 'today';
  const meet = T.meetings.test(t);
  let rows = await S.tasks(ctx.user, { when: when === 'tomorrow' ? 'upcoming' : when }).catch(() => []);
  if (when === 'tomorrow') rows = rows.filter((x) => x.dueDate === L.addDays(ctx.today, 1));
  if (meet) rows = rows.filter((x) => /meeting|visit|demo/i.test(`${x.type || ''} ${x.title || ''}`));
  const word = meet ? ['meeting', 'meetings'] : ['follow-up', 'follow-ups'];
  const head = { overdue: 'Late (due before today)', today: `Today (${L.dm(ctx.today)})`, tomorrow: `Tomorrow (${L.dm(L.addDays(ctx.today, 1))})`, upcoming: 'Coming up' }[when];
  return out(meet ? 'meetings' : 'followups', `${head}: ${plural(rows.length, word[0], word[1])}`, [ctx.all && line('By owner', countBy(rows, 'ownerName'))],
    rows.map((x) => ({ kind: x.dealId ? 'deal' : x.leadId ? 'lead' : x.accountId ? 'account' : 'task', id: x.dealId || x.leadId || x.accountId || x.id, label: x.title, sub: [x.recordName, `${L.dmy(x.dueDate)}${x.dueTime ? ` ${x.dueTime}` : ''}`, x.type, ctx.all ? x.ownerName : null].filter(Boolean).join(' · ') })), rows.length);
}
async function activity(ctx, t, p) {
  const s = ctx.all ? { sql: '1=1', params: [] } : { sql: 'x."byId" = ?', params: [ctx.user.id] };
  const d = inP('x."at"', p);
  const kind = /\bcalls?\b/.test(t) ? 'call' : /\bwhats ?app\b/.test(t) ? 'whatsapp' : /\bemails?\b|\bmails?\b/.test(t) ? 'email' : /\bmeetings?\b/.test(t) ? 'meeting' : null;
  const rows = await DB.all(`SELECT x."kind", x."subject", x."byName", x."at", x."leadId", x."dealId", x."accountId" FROM "CrmActivity" x WHERE ${s.sql} AND ${d.sql}${kind ? ' AND x."kind" = ?' : ''} AND COALESCE(x."byName", '') NOT IN ('Autopilot', 'Sequence', 'TeamLink') ORDER BY x."at" DESC`, ...s.params, ...d.params, ...(kind ? [kind] : []));
  return out('activity', `${p.label('en')}: ${plural(rows.length, kind ? `${kind} logged` : 'activity logged', kind ? `${kind}s logged` : 'activities logged')}`,
    [!kind && line('By kind', countBy(rows, 'kind')), ctx.all && line('By person', countBy(rows, 'byName'))],
    rows.map((x) => ({ kind: x.dealId ? 'deal' : x.leadId ? 'lead' : 'account', id: x.dealId || x.leadId || x.accountId, label: x.subject || x.kind, sub: [x.kind, L.dmy(String(x.at).slice(0, 10)), ctx.all ? x.byName : null].filter(Boolean).join(' · ') })).filter((i) => i.id), rows.length);
}
async function invoices(ctx, t, p) {
  const s = ctx.sc('x.');
  const rows = await DB.all(`SELECT x.* FROM "CrmInvoice" x WHERE ${s.sql} AND x."status" != 'Cancelled'`, ...s.params);
  const bal = (x) => Math.max(0, S.netTotalOf(x) - (Number(x.paidAmount) || 0) - (Number(x.tdsAmount) || 0));
  const unpaid = rows.filter((x) => ['Sent', 'Partly paid'].includes(x.status) && bal(x) > 0.5);
  const overdue = unpaid.filter((x) => x.dueDate && x.dueDate < ctx.today);
  const raised = p.named ? rows.filter((x) => x.status !== 'Draft' && x.issueDate >= p.from && x.issueDate <= p.to) : null;
  const pickOverdue = /\boverdue\b|\blate\b/.test(t);
  const list = raised && /\braised\b|\bmade\b|\bsent\b|\bissued\b|\bbilled\b/.test(t) ? raised : (pickOverdue ? overdue : unpaid);
  const sum = (xs, fn) => xs.reduce((n, x) => n + fn(x), 0);
  const title = raised && list === raised ? `${p.label('en')}: ${plural(raised.length, 'invoice', 'invoices')} raised, ${rs(sum(raised, S.netTotalOf))}` : pickOverdue ? `Now: ${plural(overdue.length, 'invoice is', 'invoices are')} overdue, ${rs(sum(overdue, bal))} to come` : `Now: ${plural(unpaid.length, 'invoice is', 'invoices are')} unpaid, ${rs(sum(unpaid, bal))} to come`;
  return out('invoices', title, [`Overdue: ${overdue.length} (${rs(sum(overdue, bal))})`, `Drafts not sent: ${rows.filter((x) => x.status === 'Draft').length}`],
    list.map((x) => ({ kind: x.dealId ? 'deal' : 'account', id: x.dealId || x.accountId, label: `${x.code || 'Invoice'} · ${x.accountName || ''}`, sub: [x.status, `balance ${rs(bal(x))}`, x.dueDate ? `due ${L.dmy(x.dueDate)}` : null].filter(Boolean).join(' · ') })).filter((i) => i.id), list.length);
}
async function payments(ctx, t, p) {
  const s = ctx.sc('x.');
  const d = inP('x."paidOn"', p);
  const rows = await DB.all(`SELECT x."amount", x."paidOn", x."mode", x."tdsAmount", x."dealId", x."accountId", i."code", i."accountName" FROM "CrmPayment" x LEFT JOIN "CrmInvoice" i ON i."id" = x."invoiceId" WHERE ${s.sql} AND ${d.sql} ORDER BY x."paidOn" DESC`, ...s.params, ...d.params);
  const total = rows.reduce((n, x) => n + (Number(x.amount) || 0), 0);
  const tds = rows.reduce((n, x) => n + (Number(x.tdsAmount) || 0), 0);
  return out('payments', `${p.label('en')}: ${rs(total)} received in ${plural(rows.length, 'payment', 'payments')}`, [tds ? `TDS deducted by customers: ${rs(tds)}` : null, line('By mode', countBy(rows, 'mode'))],
    rows.map((x) => ({ kind: x.dealId ? 'deal' : 'account', id: x.dealId || x.accountId, label: `${rs(x.amount)} · ${x.accountName || ''}`, sub: [x.code, L.dmy(x.paidOn), x.mode].filter(Boolean).join(' · ') })).filter((i) => i.id), rows.length);
}
async function tickets(ctx, t) {
  const s = ctx.sc('x.');
  const rows = await DB.all(`SELECT x."id", x."number", x."subject", x."priority", x."status", x."dueAt", x."accountId", x."ownerName" FROM "CrmTicket" x WHERE ${s.sql} AND x."status" NOT IN ('Resolved', 'Closed') ORDER BY x."dueAt" ASC`, ...s.params);
  const late = rows.filter((x) => x.dueAt && x.dueAt < new Date().toISOString());
  const list = /\blate\b|\boverdue\b|\bbreach\w*\b/.test(t) ? late : rows;
  return out('tickets', `Now: ${plural(rows.length, 'open ticket', 'open tickets')} (${late.length} past the SLA)`, [line('By priority', countBy(rows, 'priority')), line('By status', countBy(rows, 'status')), ctx.all && line('By owner', countBy(rows, 'ownerName'))],
    list.map((x) => ({ kind: 'ticket', id: x.id, label: `${x.number} ${x.subject}`, sub: [x.priority, x.status, x.dueAt ? `due ${L.dmy(x.dueAt.slice(0, 10))}` : null].filter(Boolean).join(' · ') })), list.length);
}
async function campaigns(ctx) {
  const s = ctx.sc('x.');
  const rows = await DB.all(`SELECT x."id", x."name", x."channel", x."status", x."total", x."sent", x."failed" FROM "CrmCampaign" x WHERE ${s.sql} ORDER BY x."createdAt" DESC`, ...s.params).catch(() => []);
  const sent = rows.reduce((n, x) => n + (Number(x.sent) || 0), 0);
  return out('campaigns', `${plural(rows.length, 'campaign', 'campaigns')}, ${sent} messages sent`, [line('By status', countBy(rows, 'status')), line('By channel', countBy(rows, 'channel'))],
    rows.map((x) => ({ kind: 'campaign', id: x.id, label: x.name, sub: [x.channel, x.status, `${x.sent || 0}/${x.total || 0} sent`, x.failed ? `${x.failed} failed` : null].filter(Boolean).join(' · ') })), rows.length);
}
async function quotes(ctx, t, p) {
  const s = ctx.sc('d.');
  const rows = await DB.all(`SELECT x."id", x."number", x."status", x."sentAt", x."dealId", d."title" FROM "CrmProposal" x JOIN "CrmDeal" d ON d."id" = x."dealId" WHERE ${s.sql} ORDER BY x."createdAt" DESC`, ...s.params).catch(() => []);
  return out('quotes', `${plural(rows.length, 'proposal / quote', 'proposals / quotes')}`, [line('By status', countBy(rows, 'status'))],
    rows.map((x) => dealItem({ id: x.dealId, title: `${x.number} · ${x.title}` }, [x.status, x.sentAt ? `sent ${L.dmy(x.sentAt.slice(0, 10))}` : null].filter(Boolean).join(' · '))), rows.length);
}
async function products() {
  const rows = await DB.all('SELECT "name", "tagline", "active" FROM "CrmProduct" ORDER BY COALESCE("sort", 999), "name"').catch(() => []);
  return out('products', `${plural(rows.length, 'product', 'products')} we sell`, [], rows.map((x) => ({ kind: 'product', id: x.name, label: x.name, sub: [x.tagline, x.active ? null : 'not active'].filter(Boolean).join(' · ') })), rows.length);
}
async function target(ctx) {
  const ov = await require('./extra').overview(ctx.user, { period: 'month' }); // eslint-disable-line global-require
  const c = ov.body.cards;
  return out('target', `This month: ${rs(c.revenue.value)} won in ${plural(c.revenue.deals, 'deal', 'deals')} against a target of ${rs(c.target.value)}${c.target.pct != null ? ` (${c.target.pct}% done)` : ''}`,
    [`Still to win: ${rs(Math.max(0, c.target.value - c.revenue.value))}`, `Open pipeline: ${c.pipeline.open} deals, ${rs(c.pipeline.value)} (likely ${rs(c.pipeline.weighted)})`, `Leads added this month: ${c.leads.value}`, `Follow-ups: ${c.followUps.today} today, ${c.followUps.late} late`]);
}
async function leaderboard(ctx, t, p) {
  if (!ctx.all) return null; // a salesperson sees their own numbers only: the other answers already are
  const metric = /\bleads?\b/.test(t) ? 'leads' : /\bcalls?\b|\bactivit\w*\b|\blogged\b/.test(t) ? 'activity' : /\bopen\b|\bpipeline\b/.test(t) ? 'pipeline' : 'won';
  let rows = [];
  if (metric === 'won') { const d = inP('COALESCE(x."wonAt", x."updatedAt")', p); rows = await DB.all(`SELECT x."ownerName" AS "who", COUNT(*) AS "n", COALESCE(SUM(x."value"), 0) AS "v" FROM "CrmDeal" x WHERE x."stage" = 'Won' AND ${d.sql} GROUP BY x."ownerName" ORDER BY "v" DESC`, ...d.params); }
  if (metric === 'pipeline') rows = await DB.all(`SELECT x."ownerName" AS "who", COUNT(*) AS "n", COALESCE(SUM(x."value"), 0) AS "v" FROM "CrmDeal" x WHERE ${OPEN_DEAL} GROUP BY x."ownerName" ORDER BY "v" DESC`);
  if (metric === 'leads') { const d = inP('x."createdAt"', p); rows = await DB.all(`SELECT x."ownerName" AS "who", COUNT(*) AS "n" FROM "CrmLead" x WHERE ${d.sql} GROUP BY x."ownerName" ORDER BY "n" DESC`, ...d.params); }
  if (metric === 'activity') { const d = inP('x."at"', p); rows = await DB.all(`SELECT x."byName" AS "who", COUNT(*) AS "n" FROM "CrmActivity" x WHERE ${d.sql} AND COALESCE(x."byName", '') NOT IN ('Autopilot', 'Sequence', 'TeamLink', '') GROUP BY x."byName" ORDER BY "n" DESC`, ...d.params); }
  const word = { won: 'deals won', pipeline: 'open pipeline', leads: 'leads added', activity: 'activities logged' }[metric];
  return out('leaderboard', `${metric === 'pipeline' ? `Now (${L.dm(ctx.today)})` : p.label('en')}: ${word} by person`, [],
    rows.map((x, i) => ({ kind: 'person', id: x.who || '-', label: `${i + 1}. ${x.who || 'No owner'}`, sub: [`${x.n}`, x.v != null ? rs(x.v) : null].filter(Boolean).join(' · ') })), rows.length);
}
// one lead / deal / customer the question names
const STOP = new Set('the a an of for to in on at by with from and or is are was were be my me our we you your how many much what which who whom when where why show list give tell me about details status update info of all any this that these those please pls today tomorrow yesterday week month year last next this deal deals lead leads account accounts customer customers client clients company contact contacts follow ups up followups meeting meetings won lost open closed pipeline value stage history 360'.split(' '));
async function namedRecord(ctx, t) {
  const words = (t.match(/[a-z0-9][a-z0-9&.-]{2,}/g) || []).filter((w) => !STOP.has(w)).slice(0, 6);
  if (!words.length) return null;
  const hits = [];
  for (const [kind, table, col] of [['lead', 'CrmLead', 'company'], ['account', 'CrmAccount', 'name'], ['deal', 'CrmDeal', 'title']]) {
    const s = ctx.sc('x.');
    // eslint-disable-next-line no-await-in-loop
    const rows = await DB.all(`SELECT x."id", x."${col}" AS "name" FROM "${table}" x WHERE ${s.sql} AND (${words.map(() => `LOWER(x."${col}") LIKE ?`).join(' OR ')}) LIMIT 8`, ...s.params, ...words.map((w) => `%${w}%`)).catch(() => []);
    rows.forEach((x) => { const nm = String(x.name || '').toLowerCase(); const hit = words.filter((w) => nm.includes(w)); hits.push({ kind, id: x.id, name: x.name, hit: hit.length, s: hit.reduce((n, w) => n + w.length, 0) }); });
  }
  hits.sort((a, b) => b.hit - a.hit || b.s - a.s);
  const best = hits[0];
  if (!best || best.s < 4 || best.hit < Math.min(words.length, 2) * 0.5) return null;
  return best;
}
async function recordAnswer(ctx, rec) {
  const d = await S.detail(ctx.user, rec.kind, rec.id);
  if (d.status !== 200) return null;
  const AI = require('./ai'); // eslint-disable-line global-require
  const facts = AI.factsText(rec.kind, d.body).split('\n').filter(Boolean);
  const ins = AI.insightOf(rec.kind, d.body, await SETTINGS.load());
  return out('record', facts[0] || rec.name, [...facts.slice(1, 14), ins && ins.label ? `Health: ${ins.score}/100 (${ins.label})` : null, ...(ins && ins.actions ? ins.actions.slice(0, 3).map((a) => `Next: ${a.text}`) : [])], [{ kind: rec.kind, id: rec.id, label: `Open ${rec.name}`, sub: rec.kind }], 1);
}

// ---- the router ------------------------------------------------------------------------------------------------------------------------
async function answer(user, question) {
  const q = String(question || '').trim();
  if (!q || q.length > 300) return null;
  const t = L.normalize(q);
  // "why did we lose deals" is a count of the lost reasons, not advice
  const whyLost = /\bwhy\b/.test(t) && T.lost.test(t) && !/\b(write|draft|tips?|advice|improve|strategy|suggest\w*)\b/.test(t);
  if ((NOT_FOR_CODE.test(t) && !whyLost) || FOLLOW_ON.test(t)) return null;
  const ctx = ctxOf(user);
  if (!ctx.r) return null;
  await SETTINGS.load().catch(() => null);
  const topics = Object.keys(T).filter((k) => has(T[k], t));
  const per = (def) => L.periodOf(t, def, ctx.today);
  const f = await filtersOf(ctx, t);
  try {
    if (topics.includes('rank')) { const a = await leaderboard(ctx, t, per('month')); if (a) return a; }
    if (topics.includes('target')) return target(ctx);
    if (topics.includes('lost') && (topics.includes('deals') || !topics.includes('leads'))) return wonLost(ctx, t, per('month'), f, 'Lost');
    if (topics.includes('won') && !topics.includes('leads')) return wonLost(ctx, t, per('month'), f, 'Won');
    if (topics.includes('payments') && !topics.includes('invoices')) return payments(ctx, t, per('month'));
    if (topics.includes('invoices')) return invoices(ctx, t, per('month'));
    if (topics.includes('tickets')) return tickets(ctx, t);
    if (topics.includes('campaigns')) return campaigns(ctx);
    if (topics.includes('quotes')) return quotes(ctx, t, per('month'));
    if (topics.includes('products') && !topics.includes('deals') && !topics.includes('leads')) return products();
    if (topics.includes('activity')) return activity(ctx, t, per('week'));
    if (topics.includes('followups') || (topics.includes('meetings') && !topics.includes('activity'))) return followups(ctx, t, per('today'));
    if (topics.includes('deals')) return deals(ctx, t, per('month'), f);
    if (topics.includes('leads')) return leads(ctx, t, per('month'), f);
    if (topics.includes('contacts')) return contacts(ctx, t);
    // a record named ("tell me about Acme", "status of the Infosys deal")
    const rec = await namedRecord(ctx, t);
    if (rec) { const a = await recordAnswer(ctx, rec); if (a) return a; }
    if (topics.includes('customers')) return customers(ctx, t, per('month'), f);
  } catch (e) {
    console.error('[crm agent]', e.message); // eslint-disable-line no-console
    return null;
  }
  return null;
}

// the totals the model gets for the questions this file does not answer itself
async function factsSummary(user) {
  const ctx = ctxOf(user);
  if (!ctx.r) return '';
  const s = ctx.sc('x.');
  const g = async (sql, ...a) => DB.all(sql, ...a).catch(() => []);
  const fmt = (rows) => rows.map((x) => `${x.k || 'Not set'} ${x.n}`).join(', ');
  const m = L.periodOf('this month', 'month', ctx.today); const lm = L.periodOf('last month', 'month', ctx.today);
  const won = async (p) => (await g(`SELECT COUNT(*) AS n, COALESCE(SUM(x."value"), 0) AS v FROM "CrmDeal" x WHERE ${s.sql} AND x."stage" = 'Won' AND substr(COALESCE(x."wonAt", x."updatedAt"), 1, 10) BETWEEN ? AND ?`, ...s.params, p.from, p.to))[0] || { n: 0, v: 0 };
  const [wm, wl] = [await won(m), await won(lm)];
  const lines = [
    `Leads open by stage: ${fmt(await g(`SELECT COALESCE(x."stage", x."status") AS k, COUNT(*) AS n FROM "CrmLead" x WHERE ${s.sql} AND ${OPEN_LEAD} GROUP BY k ORDER BY n DESC`, ...s.params))}.`,
    `Leads by source (all): ${fmt(await g(`SELECT x."source" AS k, COUNT(*) AS n FROM "CrmLead" x WHERE ${s.sql} GROUP BY k ORDER BY n DESC LIMIT 10`, ...s.params))}.`,
    `Open deals by stage: ${fmt(await g(`SELECT x."stage" AS k, COUNT(*) AS n FROM "CrmDeal" x WHERE ${s.sql} AND ${OPEN_DEAL} GROUP BY k ORDER BY n DESC`, ...s.params))}.`,
    `Won this month: ${wm.n} deals, ${rs(wm.v)}; last month: ${wl.n} deals, ${rs(wl.v)}.`,
    `Lost reasons (all): ${fmt(await g(`SELECT x."lostReason" AS k, COUNT(*) AS n FROM "CrmDeal" x WHERE ${s.sql} AND x."stage" = 'Lost' GROUP BY k ORDER BY n DESC LIMIT 8`, ...s.params))}.`,
    `Accounts by kind: ${fmt(await g(`SELECT x."kind" AS k, COUNT(*) AS n FROM "CrmAccount" x WHERE ${s.sql} GROUP BY k`, ...s.params))}.`,
    `Open tickets by priority: ${fmt(await g(`SELECT x."priority" AS k, COUNT(*) AS n FROM "CrmTicket" x WHERE ${s.sql} AND x."status" NOT IN ('Resolved', 'Closed') GROUP BY k`, ...s.params))}.`,
    `Products: ${(await g('SELECT "name" FROM "CrmProduct" WHERE "active" = 1')).map((x) => x.name).join(', ') || 'none'}.`,
  ];
  if (ctx.all) lines.push(`Open pipeline by owner: ${fmt(await g(`SELECT x."ownerName" AS k, COUNT(*) AS n FROM "CrmDeal" x WHERE ${OPEN_DEAL} GROUP BY k ORDER BY n DESC LIMIT 12`))}.`);
  return lines.join('\n');
}

module.exports = { answer, factsSummary };
