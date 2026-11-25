// ---------------------------------------------------------------------------
// AI MARKETING > CLIENT PLANS (2026-11-24). TeamLink Consultants' "AI-Powered Digital Marketing Services & Business Proposal" (the owner's Word document) turned into what the team can use:
//   1 PLANS      Basic 3,999 / Growth 7,999 / Premium 14,999 a month with the monthly quantities of the document (posts, Reels, stories, Google Business Profile posts, SEO blogs),
//                and the subscription offers (3 months 5% off, 6 months 10% off, 9 months 15% off, 12 months for the price of 11). quote() gives the exact price table of the document.
//   2 CLIENTS    a client on a plan (start date, months, what was agreed) and, month by month, how much of each quantity has been DELIVERED (posts, Reels and stories counted from approved work + what the team adds by hand) against the plan.
//   3 GBP AUDIT  the "TeamLink GBP Quality Audit": a score out of 100 with the document's marks (name and category 15, address and contact 15, opening hours 10, description 10,
//                services and products 10, photos 10, reviews and responses 15, posts and activity 10, website and links 5), the findings and the actions to take, saved per client.
// HONEST BY DESIGN (the document's own rules): the audit is TeamLink's OWN score, not a Google score or ranking; it only uses what the team ticks (nothing is read from Google, nothing is
//   invented); no ranking, lead or result is promised anywhere; nothing here sends or posts anything; no paid service is called (all of it is plain calculation).
// audit log: "Omni-Channel AI Marketing: client plan / delivery / GBP audit ...".
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const A = require('../outreach/access');
const { logAudit } = require('../utils/audit');

const TP = 'OmniMkClientPlan'; const TD = 'OmniMkDelivery'; const TG = 'OmniMkGbpAudit';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${TP}" ("id" TEXT NOT NULL PRIMARY KEY, "clientName" TEXT NOT NULL DEFAULT '', "contactName" TEXT, "contactPhone" TEXT, "industry" TEXT, "plan" TEXT NOT NULL, "months" INTEGER NOT NULL DEFAULT 1, "startDate" TEXT NOT NULL, "pricePaid" INTEGER NOT NULL DEFAULT 0, "notes" TEXT, "status" TEXT NOT NULL DEFAULT 'active', "department" TEXT, "createdById" TEXT, "createdByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS "${TP}_status" ON "${TP}"("status", "createdAt")`,
  `CREATE TABLE IF NOT EXISTS "${TD}" ("id" TEXT NOT NULL PRIMARY KEY, "planId" TEXT NOT NULL, "month" TEXT NOT NULL, "item" TEXT NOT NULL, "count" INTEGER NOT NULL DEFAULT 0, "updatedById" TEXT, "updatedAt" DATETIME NOT NULL DEFAULT 0)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "${TD}_one" ON "${TD}"("planId", "month", "item")`,
  `CREATE TABLE IF NOT EXISTS "${TG}" ("id" TEXT NOT NULL PRIMARY KEY, "clientName" TEXT NOT NULL DEFAULT '', "planId" TEXT, "answers" TEXT, "score" INTEGER NOT NULL DEFAULT 0, "band" TEXT, "department" TEXT, "createdById" TEXT, "createdByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS "${TG}_client" ON "${TG}"("clientName", "createdAt")`,
];
let okAt = 0;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } // eslint-disable-line no-await-in-loop
  catch (e) { console.error('[omni-mk] client plans schema:', e.message); return false; } // eslint-disable-line no-console
}

// ---- the plans, exactly as in the document ----------------------------------------------------------------------------------------------------------------------
const ITEMS = [
  { key: 'posts', label: 'Social media posts / creatives' }, { key: 'reels', label: 'AI-assisted Reels' }, { key: 'stories', label: 'Stories' },
  { key: 'gbpPosts', label: 'Google Business Profile posts' }, { key: 'blogs', label: 'SEO blogs' },
];
const PLANS = {
  basic: {
    key: 'basic', label: 'Basic', price: 3999, suited: 'Small businesses, individual professionals, clinics and new businesses.',
    quotas: { posts: 8, reels: 2, stories: 4, gbpPosts: 4, blogs: 0 },
    includes: ['Facebook and Instagram content management', 'Captions, hashtags and a monthly content calendar', 'Basic Google Business Profile quality audit and business information checks', 'Basic website and online presence review, keyword suggestions and SEO recommendations', 'Basic FAQ research and question-and-answer content (AEO)', 'Basic business information and AI-friendly descriptions (GEO)', 'Monthly content delivery report, basic social media report and basic GBP report'],
  },
  growth: {
    key: 'growth', label: 'Growth', price: 7999, suited: 'Growing businesses, clinics, hospitals and companies looking for stronger online visibility.',
    quotas: { posts: 12, reels: 4, stories: 8, gbpPosts: 8, blogs: 0 },
    includes: ['Facebook and Instagram management', 'GBP optimization checklist, review monitoring and review response drafts', 'Local SEO recommendations, local keyword research, meta title and description recommendations', 'Competitor analysis and local landing-page recommendations', 'FAQ research and generation, website FAQ recommendations (AEO)', 'AI-friendly and location-based content, AI search readiness recommendations (GEO)', 'Monthly SEO and GBP report, social media report, competitor summary and improvement recommendations'],
  },
  premium: {
    key: 'premium', label: 'Premium', price: 14999, suited: 'Established businesses, hospitals, larger clinics and organizations requiring comprehensive digital marketing.',
    quotas: { posts: 16, reels: 8, stories: 12, gbpPosts: 12, blogs: 4 },
    includes: ['Facebook, Instagram, LinkedIn company-page content and YouTube Shorts content', 'Advanced GBP optimization, detailed profile quality audit, category and service recommendations, monthly GBP performance report', 'Advanced website SEO audit, technical and on-page SEO recommendations, keyword research and tracking, competitor analysis, existing website content updates', 'Advanced AEO: FAQ research, structured data recommendations, service and industry content', 'Advanced GEO: AI-friendly website content, doctor and professional profile content, trusted reference recommendations, foundational LLMO, AI search visibility monitoring where reliable data is available', 'Lead tracking, detailed monthly performance report, SEO and keyword report, monthly improvement plan and priority client approval workflow'],
  },
};
const TERMS = [
  { months: 1, label: '1 month', off: 0, pay: 1 }, { months: 3, label: '3 months', off: 5, pay: 3 }, { months: 6, label: '6 months', off: 10, pay: 6 },
  { months: 9, label: '9 months', off: 15, pay: 9 }, { months: 12, label: '12 months (annual)', off: 0, pay: 11 },
];
const OFFER_TERMS = [
  'Offers apply to the selected monthly subscription package.', 'The client must pay the full subscription amount upfront for the selected duration.', 'Annual subscription means 12 months of service with payment for 11 months.',
  'Discounts are calculated on the standard package price.', 'Advertising budgets, LinkedIn licences, premium software and separately agreed services are excluded.', 'GST, if applicable, is charged additionally.', 'Offers cannot be combined with other promotional discounts.',
];
const WEEKS = [
  ['Week 1', 'Client discussion, audit and monthly content plan; keyword research and competitor review'], ['Week 2', 'Social media creatives, captions and video drafts; GBP posts and profile recommendations'],
  ['Week 3', 'SEO / AEO / GEO content work according to the plan; client review and approved publishing'], ['Week 4', 'Performance analysis and monthly report'], ['Month end', "Improvement recommendations and next month's plan"],
];

// the price of a plan for a number of months, as in the document's table (rounded to the nearest rupee). Only 3, 6, 9 and 12 months carry an offer.
function quote(planKey, months) {
  const p = PLANS[planKey]; if (!p) return { error: 'Pick Basic, Growth or Premium.', status: 400 };
  const m = Math.round(Number(months)); if (!Number.isFinite(m) || m < 1 || m > 36) return { error: 'Months must be between 1 and 36.', status: 400 };
  const gross = p.price * m; let off = 0; let payMonths = m;
  if (m === 3) off = 5; else if (m === 6) off = 10; else if (m === 9) off = 15; else if (m === 12) payMonths = 11;
  const total = off ? Math.round(gross * (100 - off) / 100) : p.price * payMonths;
  return { plan: p.key, label: p.label, months: m, monthly: p.price, gross, offPercent: off, freeMonths: m - payMonths, total, saved: gross - total };
}

// ---- the GBP Quality Audit: the document's marks, split into checks the team ticks ------------------------------------------------------------------------------------
// each check: key, what is asked, points (they add up to the area's marks), the words for the finding when it is not fully met, and what to do. yes = all the points, partly = half, no = none.
const GBP_AREAS = [
  { key: 'name', label: 'Business name and category', marks: 15, checks: [
    { key: 'nameReal', pts: 5, ask: 'The name is exactly the real, public name of the business (no added keywords or slogans)', gap: 'business name not exactly the real name', fix: 'Use the exact name customers see on the board and the website; take out added keywords, slogans or locations.' },
    { key: 'catMain', pts: 5, ask: 'A correct, specific main category is chosen', gap: 'main category missing or too general', fix: 'Choose the one category that says what the business is (for example Hospital, Clinic, Software company, School). Keep the list short and specific.' },
    { key: 'catMore', pts: 5, ask: 'Other categories are added only where the business really offers that', gap: 'secondary categories missing', fix: 'Add secondary categories only for services the business really provides. Do not use categories as keywords.' },
  ] },
  { key: 'contact', label: 'Address and contact information', marks: 15, checks: [
    { key: 'address', pts: 6, ask: 'The address is complete and the same as on the website and the signboard', gap: 'address incomplete or different from the website', fix: 'Write the full address once, the same way everywhere (profile, website, other listings), and check the map pin.' },
    { key: 'area', pts: 4, ask: 'The map pin is right, or the service area is set if the business visits customers', gap: 'map pin or service area not right', fix: 'Move the pin to the real entrance, or set the service area if the team goes to the customer.' },
    { key: 'phone', pts: 5, ask: 'The main phone number is correct and somebody answers it', gap: 'phone number missing, wrong or not answered', fix: 'Add the number that is answered in working hours; test it once from another phone.' },
  ] },
  { key: 'hours', label: 'Opening hours', marks: 10, checks: [
    { key: 'hoursRegular', pts: 5, ask: 'The regular opening hours are set and correct', gap: 'opening hours missing or wrong', fix: 'Set the real opening hours for every day (mark closed days as closed).' },
    { key: 'hoursHoliday', pts: 3, ask: 'Holiday and special hours are set for coming festivals', gap: 'holiday hours not set', fix: 'Add special hours for the coming holidays so customers do not arrive at a closed door.' },
    { key: 'hoursSame', pts: 2, ask: 'The hours are the same on the website and other listings', gap: 'hours differ from the website', fix: 'Make the hours on the website and other listings match the profile.' },
  ] },
  { key: 'about', label: 'Business description', marks: 10, checks: [
    { key: 'aboutWritten', pts: 4, ask: 'A description is written (up to 750 characters)', gap: 'business description missing', fix: 'Write a clear description of up to 750 characters: what the business does, for whom, where, and how long it has been running.' },
    { key: 'aboutFacts', pts: 3, ask: 'It is plain facts: what we do, who for, where (no sales offers, prices or sale words)', gap: 'description is thin or sounds like an advertisement', fix: 'Keep the description about the business itself. Leave prices, offers and sale words out of it.' },
    { key: 'aboutClean', pts: 3, ask: 'It has no links, no HTML and no phone numbers or emails inside the text', gap: 'description contains links or contact details', fix: 'Take links, HTML, phone numbers and emails out of the description text; they belong in their own fields.' },
  ] },
  { key: 'services', label: 'Services and products', marks: 10, checks: [
    { key: 'svcList', pts: 4, ask: 'The main services or products are listed', gap: 'services or products not listed', fix: 'List every main service or product the business really provides.' },
    { key: 'svcText', pts: 3, ask: 'Each one has a short, clear description', gap: 'service descriptions missing', fix: 'Add one or two plain sentences under each service: what it is and who it is for.' },
    { key: 'svcPeople', pts: 3, ask: 'Where it matters, the departments, doctors or key staff are shown on the profile or the website', gap: 'departments or key people not shown', fix: 'Show departments and key professionals (with their permission) on the profile or the linked website.' },
  ] },
  { key: 'photos', label: 'Photos and visual content', marks: 10, checks: [
    { key: 'photoBrand', pts: 3, ask: 'The logo and a cover photo are set', gap: 'logo or cover photo missing', fix: 'Add the logo and a clear cover photo of the place.' },
    { key: 'photoNew', pts: 4, ask: 'There are real photos of the place, the team or the work from the last 6 months', gap: 'business photos outdated', fix: 'Add fresh real photos: the entrance, the inside, the team at work, the equipment. Permission is needed for people in photos, and patient photos need written permission.' },
    { key: 'photoMore', pts: 3, ask: 'There is a good spread of photos (or a short video), not just one or two', gap: 'too few photos', fix: 'Add more photos across the inside, outside, team and services, and a short video if possible.' },
  ] },
  { key: 'reviews', label: 'Reviews and responses', marks: 15, checks: [
    { key: 'revHave', pts: 4, ask: 'The profile has genuine reviews and a rating the business is happy to show', gap: 'few reviews', fix: 'Ask happy customers, one by one and with their consent, to share an honest review. Never buy or write reviews.' },
    { key: 'revReply', pts: 6, ask: 'Every review has a polite reply', gap: 'customer reviews waiting for a reply', fix: 'Reply to every review, thank the person, and answer calmly. TeamLink prepares reply drafts; the client approves them before anything is posted.' },
    { key: 'revSafe', pts: 3, ask: 'Replies never reveal private details (especially patient details) and never argue', gap: 'replies share too much or argue', fix: 'Keep replies short and kind; never confirm that someone was a patient or share any private detail; offer to talk offline.' },
    { key: 'revAsk', pts: 2, ask: 'There is a simple routine to ask happy customers for a review', gap: 'no routine to ask for reviews', fix: 'Share the review link with satisfied customers after a visit, and only with their consent.' },
  ] },
  { key: 'posts', label: 'Posts and activity', marks: 10, checks: [
    { key: 'postRecent', pts: 5, ask: 'There has been a post in the last 30 days', gap: 'limited recent profile posts', fix: 'Post at least every 30 days: an update, an event or a service. TeamLink prepares a monthly posting schedule.' },
    { key: 'postGood', pts: 3, ask: 'Posts have a real photo and a clear next step (call, learn more, book)', gap: 'posts have no photo or no next step', fix: 'Give every post a real photo and one clear button.' },
    { key: 'postMix', pts: 2, ask: 'Posts are a mix of updates, events and services', gap: 'posts are all the same kind', fix: 'Mix updates, events and service posts across the month.' },
  ] },
  { key: 'links', label: 'Website and other links', marks: 5, checks: [
    { key: 'linkSite', pts: 2, ask: 'The website link is correct and the page opens', gap: 'website link missing or broken', fix: 'Add the correct website address and open it to check it works on a phone.' },
    { key: 'linkAct', pts: 2, ask: 'There is a way to book, enquire or WhatsApp from the profile', gap: 'no appointment or enquiry link', fix: 'Add an appointment, enquiry or WhatsApp link so a customer can act at once.' },
    { key: 'linkSocial', pts: 1, ask: 'The social media pages are linked', gap: 'social pages not linked', fix: 'Add the Facebook, Instagram, LinkedIn or YouTube pages that are really used.' },
  ] },
];
const CHECKS = GBP_AREAS.flatMap((a) => a.checks.map((c) => ({ ...c, area: a.key, areaLabel: a.label })));
const FRACTION = { yes: 1, partly: 0.5, no: 0 };
const BANDS = [[80, 'Strong'], [60, 'Good, with clear gaps'], [40, 'Needs attention'], [0, 'Needs a lot of work']];
const DISCLAIMER = "This is TeamLink's own audit score, not an official Google score or Google ranking. It is made only from what the team entered; TeamLink does not read the Google profile without the client's authorised access and does not invent views, calls, reviews or results.";
const NOTE_WORDS = ['yes', 'partly', 'no'];

// answers: { checkKey: 'yes' | 'partly' | 'no' }. A check left out counts as "not checked yet": it scores nothing and is listed, so a half-filled audit cannot look better than it is.
function scoreGbp(answers) {
  const a = answers && typeof answers === 'object' ? answers : {};
  let total = 0; let asked = 0; const areas = []; const findings = []; const actions = [];
  for (const area of GBP_AREAS) {
    let got = 0; const missing = [];
    for (const c of area.checks) {
      const v = NOTE_WORDS.includes(a[c.key]) ? a[c.key] : null;
      if (v) asked += 1;
      const g = v ? c.pts * FRACTION[v] : 0; got += g;
      if (g < c.pts) { missing.push({ key: c.key, ask: c.ask, answer: v || 'unchecked', lost: c.pts - g }); actions.push({ area: area.label, areaKey: area.key, key: c.key, lost: c.pts - g, unchecked: !v, gap: c.gap, fix: c.fix }); if (v) findings.push(c.gap[0].toUpperCase() + c.gap.slice(1) + (v === 'partly' ? ' (partly done)' : '')); }
    }
    total += got; areas.push({ key: area.key, label: area.label, marks: area.marks, got, missing });
  }
  const score = Math.round(total);
  const band = BANDS.find(([min]) => score >= min)[1];
  actions.sort((x, y) => y.lost - x.lost);
  const top = actions.filter((x) => !x.unchecked).slice(0, 3).map((x) => x.gap.replace(/ (missing|wrong|outdated|not .*|incomplete.*|thin.*)$/, '')).filter(Boolean);
  return {
    score, outOf: 100, band, asked, of: CHECKS.length, complete: asked === CHECKS.length, areas, findings, actions,
    recommendation: top.length ? `Start with: ${top.join('; ')}. Then prepare the review replies and a monthly posting schedule.` : (asked ? 'The profile looks complete on everything checked. Keep posting monthly and replying to every review.' : 'Tick each check first.'),
    disclaimer: DISCLAIMER,
  };
}
const catalog = () => ({
  items: ITEMS, plans: Object.values(PLANS), terms: TERMS, offerTerms: OFFER_TERMS, weeks: WEEKS, gstNote: 'Prices are before GST. Advertising budgets, LinkedIn licences and premium software are separate.',
  gbp: { areas: GBP_AREAS.map((x) => ({ key: x.key, label: x.label, marks: x.marks, checks: x.checks.map((c) => ({ key: c.key, ask: c.ask, pts: c.pts })) })), disclaimer: DISCLAIMER },
});

// ---- the clients on a plan ------------------------------------------------------------------------------------------------------------------------------------------
const istMonth = (t = Date.now()) => new Date(t + 5.5 * 3600e3).toISOString().slice(0, 7);
const istDay = (t = Date.now()) => new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10);
const okMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
const okDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
function endDay(start, months) { const d = new Date(`${start}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + months); return d.toISOString().slice(0, 10); }
const mayDept = (u, dept) => A.mayDepartment(u, dept || '');

function rowOut(r) {
  const months = S.num(r.months); const start = r.startDate; const end = endDay(start, months);
  const left = Math.ceil((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${istDay()}T00:00:00Z`)) / 86400000);
  return { id: r.id, clientName: r.clientName, contactName: r.contactName || '', contactPhone: r.contactPhone || '', industry: r.industry || '', plan: r.plan, planLabel: (PLANS[r.plan] || {}).label || r.plan, months, startDate: start, endDate: end, daysLeft: left,
    renewal: r.status !== 'active' ? 'ended' : left < 0 ? 'overdue' : left <= 30 ? 'soon' : 'running', pricePaid: S.num(r.pricePaid), notes: r.notes || '', status: r.status, department: r.department || '', createdByName: r.createdByName || '', createdAt: S.iso(r.createdAt) };
}
// ---- what is delivered, counted from the real work (2026-11-24) ------------------------------------------------------------------------------------------------------------
// A picture or a finished video that is APPROVED in the month, in a Client project whose client name is this plan's client name, counts by itself:
//   a picture that is not 9:16 -> a post / creative; a 9:16 picture -> a story; a 9:16 video -> a Reel; any other video -> a post. A raw stock clip, a draft, a picture waiting for approval,
//   a deleted one and another client's work are never counted. The team's + and - buttons ADD to this (work made outside TeamLink, for example in Canva). SEO blogs: a post of the client's plan in
//   SEO & visibility > Blog planner that the team marked PUBLISHED in the month counts as a blog (marketing/blogPlanner.js). GBP posts are not made here, so they stay counted by hand.
//   Nothing is invented: the counted items are listed so anybody can check them.
const AUTO_ITEMS = ['posts', 'reels', 'stories', 'blogs'];
function monthRange(month) { // the month in India time: [from, to) in milliseconds
  const [y, m] = String(month).split('-').map(Number); const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return [Date.parse(`${month}-01T00:00:00+05:30`), Date.parse(`${next}-01T00:00:00+05:30`)];
}
function kindOfItem(r) { const video = /^video\//i.test(String(r.mime || '')); const tall = String(r.aspect || '') === '9:16'; return video ? (tall ? 'reels' : 'posts') : (tall ? 'stories' : 'posts'); }
async function autoCounts(clientName, month) {
  const out = { posts: 0, reels: 0, stories: 0, blogs: 0, items: [] }; const name = String(clientName || '').trim().toLowerCase(); if (!name || !okMonth(month)) return out;
  const [from, to] = monthRange(month);
  try {
    const rows = await S.q(`SELECT i.id, i.title, i.mime, i.aspect, i.decidedAt FROM "OmniMkImage" i JOIN "OmniMkProject" p ON p.id = i.projectId WHERE i.deletedAt IS NULL AND i.status = 'approved' AND (i.style IS NULL OR i.style <> 'clip') AND LOWER(TRIM(p.clientName)) = ? AND i.decidedAt >= ? AND i.decidedAt < ? ORDER BY i.decidedAt`, name, from, to);
    for (const r of rows) { const k = kindOfItem(r); out[k] += 1; if (out.items.length < 40) out.items.push({ id: r.id, title: S.clip(r.title, 80), kind: k, at: S.iso(r.decidedAt) }); }
  } catch { /* the pictures or the projects table is not made yet: nothing is counted from work */ }
  try { // SEO blogs: the posts marked Published in the Blog planner in this month
    for (const r of await S.q('SELECT id, items FROM "OmniMkBlogPlan" WHERE LOWER(TRIM(clientName)) = ?', name)) for (const it of (S.parse(r.items, []) || [])) { const at = Number(it && it.publishedAt); if (it && it.status === 'published' && at >= from && at < to) { out.blogs += 1; out.items.push({ id: `${r.id}-${it.n}`, title: S.clip(it.title, 80), kind: 'blogs', at: S.iso(at) }); } }
  } catch { /* no blog plan was ever saved */ }
  out.items.sort((a, b) => String(a.at).localeCompare(String(b.at))); out.items = out.items.slice(0, 40);
  return out;
}
function progress(planKey, rows, auto) { // what is delivered against what the plan promises, per item: counted from approved work + added by hand
  const p = PLANS[planKey]; const hand = Object.fromEntries(rows.map((r) => [r.item, S.num(r.count)])); const a = auto || {};
  return ITEMS.filter((i) => p && p.quotas[i.key] > 0).map((i) => { const q = p.quotas[i.key]; const man = hand[i.key] || 0; const au = AUTO_ITEMS.includes(i.key) ? S.num(a[i.key]) : 0; const d = man + au; return { item: i.key, label: i.label, quota: q, done: d, left: Math.max(0, q - d), over: Math.max(0, d - q), pct: Math.min(100, Math.round((d / q) * 100)), manual: man, auto: au, counted: AUTO_ITEMS.includes(i.key) ? 'work' : 'hand' }; });
}
function cleanPlanBody(b, old) {
  const o = old || {}; const out = {};
  out.clientName = S.clip(b.clientName != null ? b.clientName : o.clientName, 120); if (!out.clientName) return { error: 'Write the client name.', status: 400 };
  out.plan = String(b.plan != null ? b.plan : o.plan || '').toLowerCase(); if (!PLANS[out.plan]) return { error: 'Pick Basic, Growth or Premium.', status: 400 };
  out.months = Math.round(Number(b.months != null ? b.months : o.months || 1)); if (!(out.months >= 1 && out.months <= 36)) return { error: 'Months must be between 1 and 36.', status: 400 };
  out.startDate = String(b.startDate != null ? b.startDate : o.startDate || istDay()); if (!okDay(out.startDate)) return { error: 'The start date is not a date (use year-month-day).', status: 400 };
  out.contactName = S.clip(b.contactName != null ? b.contactName : o.contactName, 100) || null; out.contactPhone = S.clip(b.contactPhone != null ? b.contactPhone : o.contactPhone, 30) || null;
  out.industry = S.clip(b.industry != null ? b.industry : o.industry, 60) || null; out.notes = S.clip(b.notes != null ? b.notes : o.notes, 1000) || null;
  return out;
}
async function deliveryRows(planId, month) { return S.q(`SELECT item, count FROM "${TD}" WHERE planId = ? AND month = ?`, planId, month); }
async function mine(u, id) { const r = (await S.q(`SELECT * FROM "${TP}" WHERE id = ?`, id))[0]; return r && mayDept(u, r.department) ? r : null; }

async function createPlan(u, b = {}) {
  if (!(await ensure())) return { error: 'The plans could not be opened.', status: 500 };
  const v = cleanPlanBody(b); if (v.error) return v;
  const dept = S.clip(b.department, 60) || (A.departmentsOf(u).length === 1 ? A.departmentsOf(u)[0] : S.clip(u.department, 60));
  if (dept && !mayDept(u, dept)) return { error: 'That department is not yours.', status: 403 };
  const q = quote(v.plan, v.months); const id = S.newId('cpl'); const now = Date.now();
  await S.run(`INSERT INTO "${TP}" (id, clientName, contactName, contactPhone, industry, plan, months, startDate, pricePaid, notes, status, department, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?,?)`,
    id, v.clientName, v.contactName, v.contactPhone, v.industry, v.plan, v.months, v.startDate, q.total, v.notes, dept || null, u.id, S.clip(u.name, 80), now, now);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: client plan started', entity: TP, entityId: id, toValue: `${v.clientName}: ${PLANS[v.plan].label}, ${v.months} month(s), ${q.total}` });
  return getPlan(u, id);
}
async function updatePlan(u, id, b = {}) {
  if (!(await ensure())) return { error: 'The plans could not be opened.', status: 500 };
  const r = await mine(u, id); if (!r) return { error: 'That client plan was not found.', status: 404 };
  const v = cleanPlanBody(b, r); if (v.error) return v;
  const status = b.status != null ? (['active', 'ended'].includes(b.status) ? b.status : null) : r.status; if (!status) return { error: 'Status is active or ended.', status: 400 };
  const q = quote(v.plan, v.months);
  await S.run(`UPDATE "${TP}" SET clientName=?, contactName=?, contactPhone=?, industry=?, plan=?, months=?, startDate=?, pricePaid=?, notes=?, status=?, updatedAt=? WHERE id=?`, v.clientName, v.contactName, v.contactPhone, v.industry, v.plan, v.months, v.startDate, q.total, v.notes, status, Date.now(), id);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: client plan changed', entity: TP, entityId: id, toValue: `${v.clientName}: ${PLANS[v.plan].label}, ${v.months} month(s), ${status}` });
  return getPlan(u, id);
}
async function listPlans(u, o = {}) {
  if (!(await ensure())) return { error: 'The plans could not be opened.', status: 500 };
  const rows = (await S.q(`SELECT * FROM "${TP}" ORDER BY createdAt DESC LIMIT 500`)).filter((r) => mayDept(u, r.department)).filter((r) => !o.status || r.status === o.status);
  const month = okMonth(o.month) ? o.month : istMonth();
  const items = [];
  for (const r of rows) { const p = rowOut(r); const au = await autoCounts(r.clientName, month); const pr = progress(r.plan, await deliveryRows(r.id, month), au); const quota = pr.reduce((a, x) => a + x.quota, 0); const done = pr.reduce((a, x) => a + Math.min(x.done, x.quota), 0); items.push({ ...p, month, deliveredPct: quota ? Math.round((done / quota) * 100) : 0, progress: pr, autoItems: au.items }); } // eslint-disable-line no-await-in-loop
  return { items, month, canWrite: A.has('mayAiMarketing')(u) };
}
async function getPlan(u, id, month) {
  if (!(await ensure())) return { error: 'The plans could not be opened.', status: 500 };
  const r = await mine(u, id); if (!r) return { error: 'That client plan was not found.', status: 404 };
  const m = okMonth(month) ? month : istMonth();
  const au = await autoCounts(r.clientName, m);
  return { plan: { ...rowOut(r), month: m, progress: progress(r.plan, await deliveryRows(id, m), au), autoItems: au.items, quote: quote(r.plan, S.num(r.months)), quotas: PLANS[r.plan].quotas } };
}
// every plan that is running, for the daily reminders (no department filter: the reminder goes to whoever started the plan)
async function activePlans() {
  if (!(await ensure())) return [];
  return (await S.q(`SELECT * FROM "${TP}" WHERE status = 'active' ORDER BY createdAt LIMIT 1000`)).map((r) => ({ raw: r, view: rowOut(r) }));
}
// the team counts what it has delivered: set (count) or add (delta, + or -) for one item in one month. Never below 0.
async function setDelivery(u, id, b = {}) {
  if (!(await ensure())) return { error: 'The plans could not be opened.', status: 500 };
  const r = await mine(u, id); if (!r) return { error: 'That client plan was not found.', status: 404 };
  const month = okMonth(b.month) ? b.month : istMonth(); const item = String(b.item || ''); if (!ITEMS.some((i) => i.key === item)) return { error: 'Pick what was delivered (posts, Reels, stories, GBP posts or blogs).', status: 400 };
  const cur = (await deliveryRows(id, month)).find((x) => x.item === item); const was = cur ? S.num(cur.count) : 0;
  let next = was; if (b.count != null) next = Math.round(Number(b.count)); else if (b.delta != null) next = was + Math.round(Number(b.delta));
  if (!Number.isFinite(next) || next < 0 || next > 999) return { error: 'The number must be between 0 and 999.', status: 400 };
  if (cur) await S.run(`UPDATE "${TD}" SET count=?, updatedById=?, updatedAt=? WHERE planId=? AND month=? AND item=?`, next, u.id, Date.now(), id, month, item);
  else await S.run(`INSERT INTO "${TD}" (id, planId, month, item, count, updatedById, updatedAt) VALUES (?,?,?,?,?,?,?)`, S.newId('dlv'), id, month, item, next, u.id, Date.now());
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: delivery counted', entity: TD, entityId: id, fromValue: String(was), toValue: `${item} ${month}: ${next}` });
  return getPlan(u, id, month);
}

// ---- the saved GBP audits ---------------------------------------------------------------------------------------------------------------------------------------------
async function saveAudit(u, b = {}) {
  if (!(await ensure())) return { error: 'The audits could not be opened.', status: 500 };
  const clientName = S.clip(b.clientName, 120); if (!clientName) return { error: 'Write the client name.', status: 400 };
  const answers = {}; for (const c of CHECKS) if (NOTE_WORDS.includes(b.answers && b.answers[c.key])) answers[c.key] = b.answers[c.key];
  if (!Object.keys(answers).length) return { error: 'Tick at least one check first.', status: 400 };
  let planId = null; let dept = S.clip(b.department, 60) || null;
  if (b.planId) { const r = await mine(u, String(b.planId)); if (!r) return { error: 'That client plan was not found.', status: 404 }; planId = r.id; dept = r.department || dept; }
  if (dept && !mayDept(u, dept)) return { error: 'That department is not yours.', status: 403 };
  const sc = scoreGbp(answers); const id = S.newId('gba');
  await S.run(`INSERT INTO "${TG}" (id, clientName, planId, answers, score, band, department, createdById, createdByName, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)`, id, clientName, planId, JSON.stringify(answers), sc.score, sc.band, dept, u.id, S.clip(u.name, 80), Date.now());
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: GBP audit saved', entity: TG, entityId: id, toValue: `${clientName}: ${sc.score}/100${sc.complete ? '' : ' (not complete)'}` });
  return getAudit(u, id);
}
function auditOut(r) { const answers = S.parse(r.answers, {}); return { id: r.id, clientName: r.clientName, planId: r.planId || null, score: S.num(r.score), band: r.band || '', department: r.department || '', createdByName: r.createdByName || '', createdAt: S.iso(r.createdAt), answers }; }
async function getAudit(u, id) {
  if (!(await ensure())) return { error: 'The audits could not be opened.', status: 500 };
  const r = (await S.q(`SELECT * FROM "${TG}" WHERE id = ?`, id))[0]; if (!r || !mayDept(u, r.department)) return { error: 'That audit was not found.', status: 404 };
  const a = auditOut(r); return { audit: { ...a, report: scoreGbp(a.answers) } };
}
async function listAudits(u, o = {}) {
  if (!(await ensure())) return { error: 'The audits could not be opened.', status: 500 };
  const rows = (await S.q(`SELECT * FROM "${TG}" ORDER BY createdAt DESC LIMIT 300`)).filter((r) => mayDept(u, r.department)).filter((r) => !o.planId || r.planId === o.planId).filter((r) => !o.clientName || r.clientName.toLowerCase() === String(o.clientName).toLowerCase());
  return { items: rows.map((r) => { const a = auditOut(r); delete a.answers; return a; }) };
}

module.exports = { ensure, PLANS, ITEMS, TERMS, GBP_AREAS, CHECKS, catalog, quote, scoreGbp, createPlan, updatePlan, listPlans, getPlan, setDelivery, saveAudit, getAudit, listAudits, istMonth, istDay, autoCounts, monthRange, activePlans, mayDept, AUTO_ITEMS, planRow: mine };
