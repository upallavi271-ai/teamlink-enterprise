// ---------------------------------------------------------------------------
// SELLING OUR OWN PRODUCTS - HRMS, ATS, OMNI-CHANNEL (founder 2026-11-17: "naa products ni sale cheyyali ... lead vasthey, first sample demo
// chupinchali, vallu ok ithey meeting conduct cheyyali, ahh meeting antha ai cheyyali, lead ki vunna doubts ni ai clarify cheyyali, lead ok
// anukuntey, qualify chestham, akkadi nunchi remaining process antha jaragaali" + the demo video: "lead yokka req ni batti vundali").
//
//   PRODUCTS     CrmProduct: name, one line, what it is, features, plans (price only when the founder writes one), the demo video (a file of
//                that product's own part, or a link), questions & answers for the AI. Seeded with HRMS, ATS and Omni-Channel.
//   INTEREST     CrmLead.products: which of them the lead wants ("HRMS", "ATS,OMNI" ...).
//   DEMO         a signed link per lead + the products they want: a page with each product's own video and features. Opened / played /
//                "I'm interested" / "Talk to a person" are written on the lead's timeline; "I'm interested" opens the AI meeting.
//   AI MEETING   a signed meeting link: the AI greets, walks through the product (agenda from its features and plans) and answers the
//                lead's questions by text or voice - only from what is written here; never a price that is not written, never a
//                discount. Every line is kept. At the end the lead says Yes / Need time / Not for us, and the AI writes the summary,
//                the open questions and a readiness score (interest, budget, decision maker, need, timeline).
//   QUALIFY      Yes (or a strong score) -> the lead moves to Qualified (crm/sales.js autoStage, "Meeting held"), the owner gets a bell
//                and a follow-up with the open questions; Need time -> a follow-up in 7 days; Not for us -> Lost with the reason.
//   AFTER WON    onWon(): onboarding follow-ups (set up the account, training, go-live check) and the renewal reminder 30 days before
//                a year is up. The proposal -> negotiation -> won -> invoice steps are the CRM's own (crm/extra.js, crm/service.js).
// Raw tables, created on first use (no Prisma migration).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const prisma = require('../db');
const S = require('./service');

const PRODUCT_KEYS = ['HRMS', 'ATS', 'OMNI'];
const SEED = [
  {
    key: 'HRMS', name: 'TeamLink HRMS', sort: 1,
    tagline: 'Every employee, attendance, leave and payroll in one place.',
    about: 'TeamLink HRMS runs the people side of a company: the employee record from joining to exit, attendance (biometric devices, web punch, shifts and weekly offs), leave with approvals, payroll with payslips, assets, onboarding and exit checklists, and a desktop work-monitoring agent. Every employee has a self-service login; HR, team leads and managers see their own teams.',
    features: ['Employee records, documents and history from joining to exit', 'Attendance from biometric devices and web punch, shifts, weekly breaks and late marks', 'Leave types, balances and approvals by team lead and HR', 'Payroll with payslips and statutory deductions', 'Onboarding and exit checklists, offer and joining letters', 'Assets and stationery given to each employee', 'Work monitoring agent: apps and sites used, active and idle time (never mail content)', 'Self-service login for every employee, role-based access for HR, TL and managers', 'Reports and Excel exports for every module'],
    faq: '',
  },
  {
    key: 'ATS', name: 'TeamLink ATS', sort: 2,
    tagline: 'Recruitment from requirement to joining, with AI screening and AI interviews.',
    about: 'TeamLink ATS runs recruitment end to end: client and internal requirements, job posting to the company job portal, website and job boards, candidates with duplicate checks, AI resume screening and AI video interviews, the full pipeline (recruiter, team lead, client manager, client), interview calendar, offers and joining, invoices for placements, and reports for every recruiter, team lead and client. Each role sees only its own work.',
    features: ['Client and internal requirements with approvals and recruiter assignment', 'Jobs go by themselves to your Job Portal, careers website and Google Jobs; for Naukri, Shine and other job boards one button opens the board with the job text ready', 'Candidate database with duplicate detection, resume parsing and source tracking', 'Fit score against each requirement, AI interview with photo verification and recording', 'Pipeline with stage owners: recruiter, team lead, client manager, client', 'Interview calendar, feedback per round, offers, joining and replacement tracking', 'Client portal for shortlisting and feedback', 'WhatsApp, SMS and email to candidates, automatic stage messages', 'Recruiter, team and client reports, targets and Excel exports'],
    faq: '',
  },
  {
    key: 'OMNI', name: 'TeamLink Omni-Channel', sort: 3,
    tagline: 'WhatsApp, SMS, email and social media from one screen, with AI marketing.',
    about: 'TeamLink Omni-Channel brings a company\'s customer messaging into one place: WhatsApp Business (several numbers), SMS, email campaigns, and social media posting (Facebook, Instagram, LinkedIn, Threads), with templates, a shared inbox of replies, opt-out handling, delivery reports and AI Marketing that plans and writes campaigns.',
    features: ['WhatsApp Business inbox and campaigns on several numbers', 'SMS with DLT templates and delivery reports', 'Email campaigns with unsubscribe handling', 'Social media posting to Facebook, Instagram, LinkedIn and Threads', 'AI Marketing: plans, writes and schedules campaigns', 'Templates, contact lists and opt-out across every channel', 'Reports: sent, delivered, read, replied'],
    faq: '',
  },
];
const PLAN_NAMES = ['Starter', 'Growth', 'Enterprise'];
// founder 2026-11-17 "put some plans yourself": starting price list (prices exclude GST; managers change them in Leads > Our products)
const PLANS = {
  HRMS: [
    { name: 'Starter', price: '₹49', unit: 'per employee / month', includes: 'Employee records and documents, web-punch attendance, leave and holidays, self-service login for every employee. Minimum 25 employees.' },
    { name: 'Growth', price: '₹99', unit: 'per employee / month', includes: 'Everything in Starter + payroll with payslips and statutory deductions, biometric device sync, shifts and weekly offs, onboarding and exit checklists, assets, all reports.' },
    { name: 'Enterprise', price: '₹149', unit: 'per employee / month', includes: 'Everything in Growth + work-monitoring agent, performance reviews, several branches, custom roles and approvals, priority support.' },
  ],
  ATS: [
    { name: 'Starter', price: '₹1,499', unit: 'per recruiter / month', includes: 'Requirements, candidate database with duplicate check, pipeline, interview calendar, careers page and job portal posting, email to candidates.' },
    { name: 'Growth', price: '₹2,499', unit: 'per recruiter / month', includes: 'Everything in Starter + AI resume screening and fit score, client portal, WhatsApp and SMS to candidates, offers and joining, recruiter and team reports with targets.' },
    { name: 'Enterprise', price: '₹3,999', unit: 'per recruiter / month', includes: 'Everything in Growth + AI video interviews with photo verification, placement invoices, team lead and manager hierarchy, posting to many job boards, priority support.' },
  ],
  OMNI: [
    { name: 'Starter', price: '₹2,999', unit: 'per month', includes: '1 WhatsApp Business number, email campaigns, templates, delivery reports, up to 3 team users.' },
    { name: 'Growth', price: '₹6,999', unit: 'per month', includes: 'Up to 3 WhatsApp numbers, SMS with DLT templates, social posting to Facebook, Instagram, LinkedIn and Threads, shared inbox, AI Marketing, up to 10 users.' },
    { name: 'Enterprise', price: '₹14,999', unit: 'per month', includes: 'Up to 10 WhatsApp numbers, unlimited users, Ads Manager, keyword research, Search Console and AI visibility, chat bots, dedicated support.' },
  ],
};
// how the ATS really works for a client (founder 2026-11-17): client -> BDE -> BDE TL -> department TL, who picks the recruiters and posts
const ATS_FLOW = [
  'Q: How do clients come into the ATS?\nA: Your BDE adds the client and its agreement in the ATS. Once the client signs the agreement, the client gets its own client-portal login, and from then on it raises its requirements there.',
  'Q: What does a client do in the ATS?\nA: In its client portal the client raises requirements, reviews the candidate profiles sent to it, shortlists or rejects them, gives interview feedback and raises any concern. It also sees for how many days each requirement has been open.',
  'Q: How does a client send a requirement?\nA: The client raises it in its client portal. It goes to the client\'s BDE, then the BDE team lead, then the department team lead, who picks the recruiters and posts the job.',
  'Q: Can the client see the candidates?\nA: Yes, but only the candidates sent to that client, in its client portal, where it can shortlist or reject them and give feedback.',
  'Q: How does job posting work?\nA: A posted job goes by itself to your Job Portal, your careers website and Google Jobs. For Naukri, Shine and other job boards, your team posts with one button that opens the board\'s posting page with the job text ready.',
].join('\n\n');
const EXTRA_COMMON = [
  'Q: What does it cost?\nA: Each product has Starter, Growth and Enterprise plans, shown on the slides; GST at 18% is added. At the end of this meeting you can see your exact price for your team size.',
  'Q: Can we import our Excel data?\nA: Yes. Your existing records can be brought in from Excel sheets, and our team does the first import with you during set-up.',
  'Q: Does it work on mobile?\nA: Yes. It works in the web browser on any phone, tablet or computer; there is no separate app to install.',
].join('\n\n');
const COMMON_FAQ = `Q: Are the prices with GST?\nA: No. GST at 18% is added to the prices shown.\n\nQ: How is it billed?\nA: Yearly in advance. Monthly billing is possible at 10% more.\n\nQ: How long does it take to start?\nA: Usually 3 to 7 working days: we set up the account, import your data and train your team.\n\nQ: Where is our data kept?\nA: On servers in India, with daily backups. Each company sees only its own data.\n\nQ: Can we try it first?\nA: Yes. After this meeting our team can set up a trial account for your company.\n\n${EXTRA_COMMON}`;
const FAQ = {
  HRMS: `Q: Does it work with biometric devices?\nA: Yes. eSSL and ZKTeco devices send punches straight into TeamLink attendance.\n\nQ: Does payroll handle PF, ESI and PT?\nA: Yes. Payroll calculates PF, ESI, professional tax and TDS, and gives payslips to every employee.\n\n${COMMON_FAQ}`,
  ATS: `${ATS_FLOW}\n\nQ: Can our clients see the shortlisted candidates?\nA: Yes. Each client gets a client portal login to shortlist and give feedback.\n\n${COMMON_FAQ}`,
  OMNI: `Q: Are WhatsApp and SMS message charges included?\nA: No. WhatsApp conversation charges are paid at Meta's rates and SMS at the operator's rates, from your wallet in the app.\n\nQ: Do we need our own WhatsApp Business number?\nA: Yes, a number for the official WhatsApp Business API. Our team helps you get it approved.\n\n${COMMON_FAQ}`,
};

// ---- storage ----------------------------------------------------------------------------------------------------------------
let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      await require('./schema').ensure(); // eslint-disable-line global-require
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "CrmProduct" ("id" TEXT PRIMARY KEY, "key" TEXT NOT NULL UNIQUE, "name" TEXT NOT NULL, "tagline" TEXT,
        "about" TEXT, "features" TEXT, "plans" TEXT, "faq" TEXT, "videoFile" TEXT, "videoUrl" TEXT, "demoUrl" TEXT, "active" INTEGER NOT NULL DEFAULT 1,
        "sort" INTEGER, "updatedAt" TEXT)`);
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "CrmAiMeeting" ("id" TEXT PRIMARY KEY, "leadId" TEXT NOT NULL, "products" TEXT, "startedAt" TEXT,
        "endedAt" TEXT, "transcript" TEXT, "decision" TEXT, "summary" TEXT, "score" INTEGER, "status" TEXT NOT NULL DEFAULT 'Open', "createdAt" TEXT NOT NULL)`);
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "CrmAiMeeting_lead" ON "CrmAiMeeting" ("leadId","createdAt")');
      await prisma.$executeRawUnsafe('ALTER TABLE "CrmProduct" ADD COLUMN "extraVideos" TEXT').catch((e) => { if (!/duplicate column/i.test(e.message)) throw e; });
      await prisma.$executeRawUnsafe('ALTER TABLE "CrmLead" ADD COLUMN "products" TEXT').catch((e) => { if (!/duplicate column/i.test(e.message)) throw e; });
      await fixWrittenText().catch(() => {});
      for (const p of SEED) {
        // eslint-disable-next-line no-await-in-loop
        await prisma.$executeRawUnsafe('INSERT OR IGNORE INTO "CrmProduct" ("id","key","name","tagline","about","features","plans","faq","active","sort","updatedAt") VALUES (?,?,?,?,?,?,?,?,1,?,?)',
          `prod_${p.key.toLowerCase()}`, p.key, p.name, p.tagline, p.about, JSON.stringify(p.features), JSON.stringify(PLANS[p.key] || PLAN_NAMES.map((n) => ({ name: n, price: '', unit: 'per user / month', includes: '' }))), FAQ[p.key] || p.faq, p.sort, new Date().toISOString());
        // a catalogue made before the price list (every price blank, no Q&A) gets it once; anything a manager wrote is kept
        // eslint-disable-next-line no-await-in-loop
        const [row] = await prisma.$queryRawUnsafe('SELECT "plans","faq" FROM "CrmProduct" WHERE "key" = ?', p.key);
        if (row && PLANS[p.key] && !parse(row.plans, []).some((x) => x && x.price)) {
          // eslint-disable-next-line no-await-in-loop
          await prisma.$executeRawUnsafe('UPDATE "CrmProduct" SET "plans" = ?, "faq" = CASE WHEN "faq" IS NULL OR "faq" = \'\' THEN ? ELSE "faq" END, "updatedAt" = ? WHERE "key" = ?', JSON.stringify(PLANS[p.key]), FAQ[p.key], new Date().toISOString(), p.key);
        }
        // the product's own clip (HRMS.mp4 / ATS.mp4 / OMNI.mp4 in the demo folder) is used by itself once it is there
        // eslint-disable-next-line no-await-in-loop
        try { if (fs.existsSync(path.join(VIDEO_DIR(), `${p.key}.mp4`))) await prisma.$executeRawUnsafe('UPDATE "CrmProduct" SET "videoFile" = ? WHERE "key" = ? AND "videoFile" IS NULL', `${p.key}.mp4`, p.key); } catch { /* no clip yet */ }
      }
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}
const FALSE_POSTING = /[^.\n]*\b(naukri|shine|indeed|linkedin)\b[^.\n]*\b(one[- ]click|automatic(ally)?)\b[^.\n]*\.?|[^.\n]*\b(one[- ]click|automatic(ally)?)\b[^.\n]*\b(naukri|shine|indeed|linkedin)\b[^.\n]*\.?/gi;
async function fixWrittenText() {
  const rows = await prisma.$queryRawUnsafe('SELECT "key","features","faq" FROM "CrmProduct"');
  for (const r of rows) {
    let feats = parse(r.features, []);
    feats = feats.map((f) => (FALSE_POSTING.test(f) ? (FALSE_POSTING.lastIndex = 0, NEW_POSTING_FEATURE) : f)).map((f) => f.replace(/\bvannet search\b/gi, 'Saved searches'));
    FALSE_POSTING.lastIndex = 0;
    let faq = String(r.faq || '');
    const blocks = faq.split(/\n\s*\n/).filter((b) => b.trim());
    let kept = blocks.filter((b) => { const ans = (/\n\s*a[:.)]\s*([\s\S]+)$/i.exec(b) || [])[1] || ''; return !listLike(ans); }) // a menu list is not an answer
      .map((b) => (/^\s*q[:.)]\s*can we post jobs to naukri/i.test(b) ? null : b)).filter(Boolean) // the old false answer: replaced by "How does job posting work?"
      .map((b) => b.replace(/\bvannet search\b/gi, 'saved searches'));
    const has = (q) => kept.some((b) => b.toLowerCase().includes(q.toLowerCase()));
    const add = (text) => text.split('\n\n').forEach((b) => { const q = (/^q[:.)]\s*([^\n]+)/i.exec(b) || [])[1]; if (q && !has(q)) kept.push(b); });
    if (r.key === 'ATS') add(ATS_FLOW);
    if (['HRMS', 'ATS', 'OMNI'].includes(r.key)) add(EXTRA_COMMON);
    const next = kept.join('\n\n');
    const nextFeats = JSON.stringify(feats);
    if (next !== faq || nextFeats !== r.features) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.$executeRawUnsafe('UPDATE "CrmProduct" SET "faq" = ?, "features" = ?, "updatedAt" = ? WHERE "key" = ?', next, nextFeats, new Date().toISOString(), r.key);
    }
    faq = next;
  }
}
const NEW_POSTING_FEATURE = 'Jobs go by themselves to your Job Portal, careers website and Google Jobs; for Naukri, Shine and other job boards one button opens the board with the job text ready';
const parse = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };
const shape = (r) => (r ? { ...r, active: !!r.active, features: parse(r.features, []), plans: parse(r.plans, []), extraVideos: parse(r.extraVideos, []), hasVideo: !!(r.videoFile || r.videoUrl) } : null);
// every product the CRM knows (the three we started with and any added later)
async function productKeys() { return (await products({ all: true })).map((p) => p.key); }
async function products({ all = false } = {}) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "CrmProduct" ${all ? '' : 'WHERE "active" = 1'} ORDER BY "sort", "name"`);
  return rows.map(shape);
}
async function productsByKeys(keys) {
  const all = await products();
  const want = (keys || []).map((k) => String(k).toUpperCase());
  return all.filter((p) => want.includes(p.key));
}
const keysOf = (v) => [...new Set(String(v || '').split(/[\s,]+/).map((k) => k.trim().toUpperCase()).filter(Boolean))];

// ---- managers edit the catalogue ------------------------------------------------------------------------------------------
const isManager = (user) => ['admin', 'tl'].includes(S.roleOf(user));
async function saveProduct(user, key, body = {}) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin can change the products.');
  await ensure();
  const [cur] = await prisma.$queryRawUnsafe('SELECT * FROM "CrmProduct" WHERE "key" = ?', String(key).toUpperCase());
  if (!cur) return S.fail(404, 'No such product.');
  const t = (v, n) => (v == null ? undefined : String(v).trim().slice(0, n));
  const next = {
    name: t(body.name, 120) || cur.name,
    tagline: t(body.tagline, 300) ?? cur.tagline,
    about: t(body.about, 4000) ?? cur.about,
    features: Array.isArray(body.features) ? JSON.stringify(body.features.map((x) => String(x).trim().slice(0, 300)).filter(Boolean).slice(0, 30)) : cur.features,
    plans: Array.isArray(body.plans) ? JSON.stringify(body.plans.slice(0, 6).map((p) => ({ name: String(p.name || '').slice(0, 60), price: String(p.price || '').slice(0, 60), unit: String(p.unit || '').slice(0, 60), includes: String(p.includes || '').slice(0, 600) })).filter((p) => p.name)) : cur.plans,
    faq: t(body.faq, 8000) ?? cur.faq,
    videoUrl: t(body.videoUrl, 500) ?? cur.videoUrl,
    demoUrl: t(body.demoUrl, 500) ?? cur.demoUrl,
    active: body.active === undefined ? cur.active : (body.active ? 1 : 0),
  };
  if (next.videoUrl && !/^https:\/\//i.test(next.videoUrl)) return S.fail(400, 'The video link must start with https://');
  if (next.demoUrl && !/^https:\/\//i.test(next.demoUrl)) return S.fail(400, 'The demo link must start with https://');
  await prisma.$executeRawUnsafe('UPDATE "CrmProduct" SET "name"=?,"tagline"=?,"about"=?,"features"=?,"plans"=?,"faq"=?,"videoUrl"=?,"demoUrl"=?,"active"=?,"updatedAt"=? WHERE "key"=?',
    next.name, next.tagline, next.about, next.features, next.plans, next.faq, next.videoUrl || null, next.demoUrl || null, next.active, new Date().toISOString(), cur.key);
  await S.audit(user, 'CRM product updated', 'CrmProduct', cur.id, next.name);
  return S.okBody({ ok: true, product: shape((await prisma.$queryRawUnsafe('SELECT * FROM "CrmProduct" WHERE "key" = ?', cur.key))[0]) });
}
// the product's own part of the demo video, kept on the server (founder 2026-11-17: one video per product)
const VIDEO_DIR = () => process.env.CRM_DEMO_DIR || path.join(require('../utils/attachments').uploadDir(), 'crm-demo'); // eslint-disable-line global-require
function videoPathOf(p) {
  if (!p || !p.videoFile) return null;
  const f = path.join(VIDEO_DIR(), path.basename(p.videoFile));
  return fs.existsSync(f) ? f : null;
}
// the team watches a product's clip from Leads > Our products (a <video> cannot send the login, so a link signed for 6 hours)
async function staffVideoLink(user, key, extra) {
  await ensure();
  if (String(key).toUpperCase() === 'COMPANY') {
    const st = await require('./productDeals').settings(); // eslint-disable-line global-require
    if (!st.companyVideoFile) return S.fail(404, 'There is no company video yet.');
    return S.okBody({ ok: true, url: `/api/crm-public/product-video/${makeToken('pv', user.id, ['COMPANY'], 0.25)}`, name: st.companyVideoTitle || 'Company video' });
  }
  if (extra != null && extra !== '') {
    const [px] = (await products({ all: true })).filter((x) => x.key === String(key).toUpperCase());
    if (!px || !extraPathOf(px, extra)) return S.fail(404, 'No such video.');
    return S.okBody({ ok: true, url: `/api/crm-public/product-video/${makeToken('pv', user.id, [px.key], 0.25, `x${Number(extra)}`)}`, name: `${px.name} - ${px.extraVideos[Number(extra)].title}` });
  }
  const [p] = (await products({ all: true })).filter((x) => x.key === String(key).toUpperCase());
  if (!p) return S.fail(404, 'No such product.');
  if (!videoPathOf(p) && !p.videoUrl) return S.fail(404, 'This product has no video yet.');
  return S.okBody({ ok: true, url: p.videoUrl && !videoPathOf(p) ? p.videoUrl : `/api/crm-public/product-video/${makeToken('pv', user.id, [p.key], 0.25)}`, name: p.name });
}
// a product added later (founder 2026-11-17: "whatever we sell next"): its own key from its name, no price until a manager sets one
async function addProduct(user, body = {}) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin can add a product.');
  await ensure();
  const name = String(body.name || '').trim().slice(0, 120);
  if (name.length < 2) return S.fail(400, 'Write the product\'s name.');
  const all = await products({ all: true });
  if (all.some((p) => p.name.toLowerCase() === name.toLowerCase())) return S.fail(409, 'A product with this name is there already.');
  const base = name.toUpperCase().replace(/^TEAMLINK\s+/, '').replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'PRODUCT';
  let key = base; let n = 2;
  while (all.some((p) => p.key === key)) { key = `${base.slice(0, 10)}${n}`; n += 1; }
  const sort = Math.max(0, ...all.map((p) => Number(p.sort) || 0)) + 1;
  await prisma.$executeRawUnsafe('INSERT INTO "CrmProduct" ("id","key","name","tagline","about","features","plans","faq","active","sort","updatedAt") VALUES (?,?,?,?,?,?,?,?,1,?,?)',
    `prod_${key.toLowerCase()}_${Date.now().toString(36)}`, key, name, String(body.tagline || '').slice(0, 300), String(body.about || '').slice(0, 4000), '[]', '[]', '', sort, new Date().toISOString());
  await S.audit(user, 'CRM product added', 'CrmProduct', key, name);
  return S.okBody({ ok: true, product: (await products({ all: true })).find((p) => p.key === key) });
}
// more videos for a product, next to its main demo (a feature walk-through, a customer story ...)
async function addExtraVideo(key, file, title) {
  await ensure();
  const [r] = await prisma.$queryRawUnsafe('SELECT "extraVideos" FROM "CrmProduct" WHERE "key" = ?', String(key).toUpperCase());
  if (!r) return;
  const list = parse(r.extraVideos, []);
  list.push({ file, title: String(title || 'Video').slice(0, 120), at: new Date().toISOString() });
  await prisma.$executeRawUnsafe('UPDATE "CrmProduct" SET "extraVideos" = ?, "updatedAt" = ? WHERE "key" = ?', JSON.stringify(list.slice(-12)), new Date().toISOString(), String(key).toUpperCase());
}
async function removeExtraVideo(user, key, n) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin can change the products.');
  await ensure();
  const [r] = await prisma.$queryRawUnsafe('SELECT "extraVideos" FROM "CrmProduct" WHERE "key" = ?', String(key).toUpperCase());
  const list = parse(r && r.extraVideos, []);
  if (!list[Number(n)]) return S.fail(404, 'No such video.');
  const [gone] = list.splice(Number(n), 1);
  await prisma.$executeRawUnsafe('UPDATE "CrmProduct" SET "extraVideos" = ?, "updatedAt" = ? WHERE "key" = ?', JSON.stringify(list), new Date().toISOString(), String(key).toUpperCase());
  await S.audit(user, 'CRM product video removed', 'CrmProduct', String(key).toUpperCase(), gone.title);
  return S.okBody({ ok: true });
}
function extraPathOf(p, n) {
  const x = p && (p.extraVideos || [])[Number(n)];
  if (!x || !x.file) return null;
  const f = path.join(VIDEO_DIR(), path.basename(x.file));
  return fs.existsSync(f) ? f : null;
}
async function setVideoFile(key, fileName) {
  await ensure();
  await prisma.$executeRawUnsafe('UPDATE "CrmProduct" SET "videoFile" = ?, "updatedAt" = ? WHERE "key" = ?', fileName, new Date().toISOString(), String(key).toUpperCase());
}

// ---- the lead's interest ----------------------------------------------------------------------------------------------------
async function leadFor(user, id, { edit = false } = {}) {
  await ensure();
  const r = S.roleOf(user);
  const row = await S.getRow('lead', id);
  if (!row || !(edit ? S.canEditRow(user, r, row) : S.canSeeRow(user, r, row))) return { error: S.fail(404, 'This lead is not there, or it is not yours.') };
  return { row, r };
}
async function setLeadProducts(user, id, keys) {
  const { row, error } = await leadFor(user, id, { edit: true });
  if (error) return error;
  const known = await productKeys();
  const clean = keysOf(Array.isArray(keys) ? keys.join(',') : keys).filter((k) => known.includes(k));
  await S.update('CrmLead', row.id, { products: clean.join(',') || null, updatedAt: new Date().toISOString() });
  return S.okBody({ ok: true, products: clean });
}

// ---- signed links (demo / meeting) ------------------------------------------------------------------------------------------
const key = () => crypto.createHash('sha256').update(`${process.env.JWT_SECRET || 'teamlink'}:crm-product-links-v1`).digest();
const sig = (s) => crypto.createHmac('sha256', key()).update(s).digest('base64url').slice(0, 24);
function makeToken(kind, leadId, products, days = 30, extra = '') {
  const body = Buffer.from(JSON.stringify({ k: kind, l: leadId, p: products, e: Math.floor(Date.now() / 1000) + days * 86400, x: extra })).toString('base64url');
  return `${body}.${sig(body)}`;
}
function readToken(token, kind) {
  const [b, s] = String(token || '').split('.');
  if (!b || !s || sig(b) !== s) return null;
  let v = null; try { v = JSON.parse(Buffer.from(b, 'base64url').toString('utf8')); } catch { return null; }
  if (!v || v.k !== kind || !v.l || v.e < Date.now() / 1000) return null;
  return v;
}
const siteBase = () => String(process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || 'https://teamlink.teamlinks.in').replace(/\/+$/, '');
const demoUrlOf = (t) => `${siteBase()}/api/crm-public/demo/${t}`;
const meetUrlOf = (t) => `${siteBase()}/api/crm-public/meet/${t}`;

async function note(leadId, accountId, kind, subject, text) {
  const now = new Date().toISOString();
  await S.insert('CrmActivity', { id: S.newId('act'), kind, subject: String(subject).slice(0, 200), note: text ? String(text).slice(0, 4000) : null, at: now, leadId, accountId: accountId || null, byId: null, byName: 'AI sales assistant', createdAt: now });
  await S.update('CrmLead', leadId, { updatedAt: now });
}
async function bellOwner(lead, title, message) {
  if (!lead.ownerId) return;
  try { await require('../utils/notify').notifyUsers([lead.ownerId], { title, message: `${message} Open: /crm/leads?open=lead:${lead.id}` }); } catch { /* the timeline still has it */ } // eslint-disable-line global-require
}
async function followUp(lead, title, days) {
  const due = new Date(Date.now() + 5.5 * 3600000 + days * 86400000).toISOString().slice(0, 10);
  const now = new Date().toISOString();
  await S.insert('CrmTask', { id: S.newId('task'), title: String(title).slice(0, 200), dueDate: due, status: 'Open', leadId: lead.id || null, accountId: lead.accountId || null, dealId: lead.dealId || null, ownerId: lead.ownerId || null, ownerName: lead.ownerName || null, createdById: lead.ownerId || null, createdAt: now, updatedAt: now });
}

// ---- the demo ------------------------------------------------------------------------------------------------------------------
async function demoLink(user, id, body = {}) {
  const { row, error } = await leadFor(user, id, { edit: true });
  if (error) return error;
  const known = await productKeys();
  const want = keysOf((body.products && [].concat(body.products).join(',')) || row.products).filter((k) => known.includes(k));
  if (!want.length) return S.fail(400, 'Pick which product the lead wants (HRMS, ATS, Omni-Channel) first.');
  if (!row.products) await S.update('CrmLead', row.id, { products: want.join(',') });
  const url = demoUrlOf(makeToken('demo', row.id, want));
  const names = (await productsByKeys(want)).map((p) => p.name).join(', ');
  const channel = String(body.channel || 'link');
  const text = `Hello ${row.contactName || ''},\n\nHere is a short demo of ${names}: ${url}\n\nWatch it when it suits you. If it looks right for ${row.company || 'you'}, press "I'm interested" on that page and our AI assistant will walk you through it and answer your questions straight away.\n\nTeamLink`.replace('Hello ,', 'Hello,');
  let sent = null;
  if (channel === 'email') {
    if (!row.email) return S.fail(400, 'This lead has no email address.');
    const r = await require('../utils/mailer').sendMail({ to: row.email, subject: `Your ${names} demo`, text, useEmployeeFrom: false, fromName: 'TeamLink' }).catch((e) => ({ ok: false, error: e.message })); // eslint-disable-line global-require
    sent = r && r.ok !== false ? 'email' : null;
    if (!sent) return S.fail(502, `The email could not be sent: ${(r && r.error) || 'mail is not set up'}.`);
  }
  const wa = row.phone ? `https://wa.me/91${String(row.phone).replace(/\D/g, '').slice(-10)}?text=${encodeURIComponent(text)}` : null;
  await note(row.id, row.accountId, channel === 'email' ? 'email' : 'note', `Demo ${sent ? 'sent by email' : 'link made'}: ${names}`, url);
  if (sent) await require('./sales').autoStage(row.id, { kind: 'email' }).catch(() => null); // eslint-disable-line global-require
  return S.okBody({ ok: true, url, whatsappUrl: wa, text, sent });
}
async function demoForToken(token) {
  const v = readToken(token, 'demo');
  if (!v) return null;
  await ensure();
  const lead = await S.getRow('lead', v.l);
  if (!lead) return null;
  return { lead, products: await productsByKeys(v.p), keys: v.p, pick: v.x === 'pick' };
}
// what the lead did on the demo page -> the timeline (and the owner, for the strong signals)
async function demoEvent(token, kind, extra = {}) {
  const d = await demoForToken(token);
  if (!d) return { error: 'This link has expired.' };
  const names = d.products.map((p) => p.name).join(', ');
  const pickedNames = kind === 'interested' && [].concat(extra.products || []).length ? d.products.filter((p) => [].concat(extra.products).map((x) => String(x).toUpperCase()).includes(p.key)).map((p) => p.name).join(', ') : '';
  const words = { open: `Demo opened: ${names}`, play: `Demo video played: ${extra.product || names}`, interested: `Interested after the demo: ${pickedNames || names}`, person: 'Asked to talk to a person (from the demo)', later: 'Will decide later (from the demo)' }[kind];
  if (!words) return { error: 'unknown' };
  // one "opened" per hour is enough
  if (kind === 'open') {
    const recent = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "CrmActivity" WHERE "leadId" = ? AND "subject" = ? AND "at" > ?', d.lead.id, words, new Date(Date.now() - 3600000).toISOString());
    if (Number(recent[0].n)) return { ok: true };
  }
  await note(d.lead.id, d.lead.accountId, 'note', words, extra.seconds ? `Watched about ${Math.round(extra.seconds / 60)} min` : null);
  if (kind === 'interested') {
    // on a demo of every product the lead ticks what they need: that becomes their interest and the meeting's subject
    const picked = keysOf([].concat(extra.products || []).join(',')).filter((k) => d.keys.includes(k));
    if (picked.length) { d.keys = picked; await S.update('CrmLead', d.lead.id, { products: picked.join(',') }); }
    await require('./sales').autoStage(d.lead.id, { kind: 'whatsapp' }).catch(() => null); // eslint-disable-line global-require
    await bellOwner(d.lead, `🎬 ${d.lead.company || 'A lead'} liked the demo`, `${d.lead.contactName || 'The lead'} pressed "I'm interested" on the ${names} demo and is starting the AI meeting.`);
    return { ok: true, meetUrl: meetUrlOf(makeToken('meet', d.lead.id, d.keys, 30)) };
  }
  if (kind === 'person') {
    await bellOwner(d.lead, `📞 ${d.lead.company || 'A lead'} wants to talk to a person`, `${d.lead.contactName || 'The lead'} asked for a call after the ${names} demo.`);
    await followUp(d.lead, `Call ${d.lead.contactName || d.lead.company}: asked for a person after the demo`, 0);
  }
  return { ok: true };
}

// ---- the AI meeting ----------------------------------------------------------------------------------------------------------
async function meetingLink(user, id, body = {}) {
  const { row, error } = await leadFor(user, id, { edit: true });
  if (error) return error;
  const known = await productKeys();
  const want = keysOf((body.products && [].concat(body.products).join(',')) || row.products).filter((k) => known.includes(k));
  if (!want.length) return S.fail(400, 'Pick which product the lead wants first.');
  const url = meetUrlOf(makeToken('meet', row.id, want, 30));
  await note(row.id, row.accountId, 'note', 'AI meeting link made', url);
  return S.okBody({ ok: true, url });
}
async function meetingFor(token) {
  const v = readToken(token, 'meet');
  if (!v) return null;
  await ensure();
  const lead = await S.getRow('lead', v.l);
  if (!lead) return null;
  const prods = await productsByKeys(v.p);
  // one open meeting per link (the same link opened again continues it)
  const mid = `aim_${crypto.createHash('sha1').update(token).digest('hex').slice(0, 20)}`;
  let [m] = await prisma.$queryRawUnsafe('SELECT * FROM "CrmAiMeeting" WHERE "id" = ?', mid);
  if (!m) {
    const now = new Date().toISOString();
    const greet = greeting(lead, prods);
    await prisma.$executeRawUnsafe('INSERT INTO "CrmAiMeeting" ("id","leadId","products","startedAt","transcript","status","createdAt") VALUES (?,?,?,?,?,?,?)',
      mid, lead.id, v.p.join(','), now, JSON.stringify([{ who: 'ai', text: greet, at: now }]), 'Open', now);
    await note(lead.id, lead.accountId, 'meeting', `AI meeting started: ${prods.map((p) => p.name).join(', ')}`, null);
    await bellOwner(lead, `🤖 ${lead.company || 'A lead'} is in the AI meeting now`, `${lead.contactName || 'The lead'} joined the AI meeting about ${prods.map((p) => p.name).join(', ')}.`);
    [m] = await prisma.$queryRawUnsafe('SELECT * FROM "CrmAiMeeting" WHERE "id" = ?', mid);
  }
  return { lead, products: prods, meeting: { ...m, transcript: parse(m.transcript, []) } };
}
function greeting(lead, prods) {
  const names = prods.map((p) => p.name).join(' and ');
  return `Hello${lead.contactName ? ` ${String(lead.contactName).split(' ')[0]}` : ''}, I am TeamLink's AI assistant. Thank you for your interest in ${names}. I will walk you through what it does and answer any question you have - type it, or press the microphone and speak. The slides on the side show the main points. What would you like to know first?`;
}
function knowledge(prods) {
  // the written answers first: they are what the managers want said
  return prods.map((p) => {
    const plans = (p.plans || []).filter((x) => x.name).map((x) => `- ${x.name}: ${x.price ? `${x.price} ${x.unit || ''}`.trim() : 'price on request (a person will quote)'}${x.includes ? ` - ${x.includes}` : ''}`).join('\n');
    const qa = qaOf([p]).map((x) => `Q: ${x.q}\nA: ${x.a}`).join('\n\n');
    return `PRODUCT: ${p.name}\n${p.tagline || ''}\n${qa ? `QUESTIONS AND ANSWERS (use these first):\n${qa}\n` : ''}WHAT IT IS: ${p.about || ''}\nFEATURES:\n${(p.features || []).map((f) => `- ${f}`).join('\n')}\nPLANS:\n${plans || '- price on request'}`;
  }).join('\n\n');
}
const MONEY = /(₹|rs\.?|inr|rupees?|\$|usd|\b\d[\d,]*\s*(\/|per)\s*(user|month|year|employee))/i;
// never a price or a number that is not in what the managers wrote; never a discount or a promise
function guardReply(reply, known) {
  let r = String(reply || '').trim().slice(0, 1200);
  if (MONEY.test(r)) {
    const plain = String(known || '').replace(/,/g, '');
    const nums = (r.match(/\d[\d,]*(\.\d+)?/g) || []).map((n) => n.replace(/,/g, '')).filter((n) => n.length >= 2);
    if (nums.some((n) => !plain.includes(n))) r = 'The exact price depends on the number of users and the plan. Our team will send you a quote - I have noted that you asked.';
  }
  if (/discount|free of cost|guarantee|we promise/i.test(r)) r = r.replace(/[^.]*\b(discount|free of cost|guarantee|we promise)\b[^.]*\.?/gi, '').trim() || 'Pricing terms are confirmed by our team in the proposal.';
  return r;
}
// founder 2026-11-17: the AI said "one click to Naukri, Shine, Indeed and LinkedIn" - not true. A job board, app or integration is named only
// when the product text names it, and posting to a job board is never "automatic" or "one click": that is the team's button, by hand.
const POSTING_TRUTH = 'A posted job goes by itself to your Job Portal, your careers website and Google Jobs. For Naukri, Shine and other job boards, your team posts with one button that opens the board\'s posting page with the job text ready.';
const NAMED = ['naukri', 'shine', 'indeed', 'linkedin', 'monster', 'foundit', 'glassdoor', 'google jobs', 'facebook', 'instagram', 'whatsapp', 'telegram', 'threads', 'youtube', 'sap', 'successfactors', 'workday', 'oracle', 'zoho', 'tally', 'quickbooks', 'darwinbox', 'keka', 'greythr', 'bamboohr', 'slack', 'microsoft teams', 'zoom', 'google meet', 'razorpay', 'paytm', 'shopify', 'salesforce', 'hubspot', 'esslsmart', 'essl', 'zkteco', 'aadhaar', 'digilocker', 'outlook', 'gmail'];
const BOARDS = /\b(naukri|shine|indeed|linkedin|monster|foundit|glassdoor)\b/i;
const AUTO = /\b(automatic(ally)?|auto-?post\w*|one[- ]click|directly|instantly|by itself|on its own)\b/i;
function guardClaims(reply, known) {
  const kn = String(known || '').toLowerCase();
  let posting = false;
  const out = [];
  String(reply || '').split(/(?<=[.!?])\s+/).forEach((sentence) => {
    const s = sentence.toLowerCase();
    if (BOARDS.test(s) && AUTO.test(s)) { if (!posting && kn.includes('job portal')) { out.push(POSTING_TRUTH); posting = true; } return; }
    if (NAMED.some((n) => new RegExp(`\\b${n}\\b`).test(s) && !kn.includes(n))) return;
    out.push(sentence);
  });
  return out.join(' ').trim();
}
const commas = (s) => (String(s || '').match(/,/g) || []).length;
// a menu of screen names is not an answer
const listLike = (s) => commas(s) >= 7 || /\b(offers|includes) a (wide )?range of features\b/i.test(String(s || ''));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9ఀ-౿ ]+/g, ' ').replace(/\s+/g, ' ').trim();
// what the lead typed, read for this meeting: "ads" in an ATS meeting is ATS, and the usual speech slips
function readQuestion(q, prods) {
  const keys = prods.map((p) => p.key);
  let t = String(q || '');
  if (keys.includes('ATS') && !keys.includes('OMNI')) t = t.replace(/\b(ads|ats's|a\.t\.s\.?|80s|eighties)\b/gi, 'ATS');
  return t.replace(/\bteam ?link\b/gi, 'TeamLink');
}
// The AI meeting asks Claude itself (founder 2026-11-17: "Yes, use Claude" - fast, natural Telugu) while the rest of TeamLink stays on the
// local model; CRM > Automatic > AI assistant > "Use Claude" turns it off. Answers at low effort (short, quick), the summary at medium.
// Any Claude failure (no key / credit, an error, more than 20 s, a refusal) answers that turn another way, so a meeting never stops.
const CLAUDE = { model: 'claude-opus-5-5', answer: { effort: 'low', timeoutMs: 20000, maxTokens: 400 }, summary: { effort: 'medium', timeoutMs: 60000, maxTokens: 600 } };
async function askAi(system, history, kind, meta = {}, { localOk = true } = {}) {
  const AI = require('../utils/ai'); // eslint-disable-line global-require
  const st = await require('./salesAgent').load().catch(() => ({ useClaude: true })); // eslint-disable-line global-require
  const c = CLAUDE[kind] || CLAUDE.answer;
  if (st.useClaude !== false) {
    try {
      return await AI.chatJson(system, history, { provider: 'claude', model: CLAUDE.model, effort: c.effort, fallbacks: true, timeoutMs: c.timeoutMs, maxTokens: c.maxTokens, meta });
    } catch (e) {
      meta.claudeError = S.clip(`${e.code || ''} ${e.message || e}`.trim(), 160);
      if (!localOk) throw e;
    }
  }
  return AI.chatJson(system, history, { maxTokens: c.maxTokens, meta });
}
const LANGS = { 'en-IN': 'English', 'te-IN': 'Telugu', 'hi-IN': 'Hindi', 'ta-IN': 'Tamil', 'kn-IN': 'Kannada', 'ml-IN': 'Malayalam', 'mr-IN': 'Marathi', 'bn-IN': 'Bengali', 'gu-IN': 'Gujarati' };
async function meetingSay(token, text, lang) {
  const m = await meetingFor(token);
  if (!m) return { error: 'This meeting link has expired. Ask us for a new one.' };
  if (m.meeting.status !== 'Open') return { error: 'This meeting has ended. Thank you!' };
  const q = String(text || '').trim().slice(0, 1000);
  if (!q) return { error: 'Type or say your question.' };
  const tr = m.meeting.transcript;
  if (tr.length > 120) return { error: 'This meeting is long already - please press "End the meeting" and our team will follow up.' };
  const prevAi = [...tr].reverse().find((x) => x.who === 'ai');
  const prevQ = [...tr].reverse().find((x) => x.who === 'lead');
  const now = new Date().toISOString();
  tr.push({ who: 'lead', text: q, at: now });
  const qn = readQuestion(q, m.products);
  const kn = knowledge(m.products);
  const other = LANGS[lang] && lang !== 'en-IN' ? LANGS[lang] : '';
  const NOTED = 'Thank you - that is a good question. A person from our team will confirm it for you; I have noted it. Meanwhile, the slides on the side show the main features and plans.';
  // the same answer to a different question is a miss (founder 2026-11-17: two questions got the same menu list)
  const repeats = (r) => prevAi && norm(r) === norm(prevAi.text) && norm(readQuestion(prevQ && prevQ.text, m.products)) !== norm(qn);
  const bad = (r) => !r || r.trim().length < 12 || /^(unanswered|answered|true|false|null|yes|no|n\/a)\.?$/i.test(r.trim()) || listLike(r) || repeats(r);
  // a question the managers answered in writing gets that answer at once (no AI wait) - English only, other languages go to the AI to translate
  let reply = other ? null : faqMatch(m.products, qn, { strong: true });
  if (reply && repeats(reply)) reply = null;
  let unanswered = false; let wantsHuman = false;
  const meta = reply ? { provider: 'written' } : {};
  // when Claude cannot answer, a written answer is used before the slow local model
  const writtenBackup = faqMatch(m.products, qn, { exclude: prevAi ? [prevAi.text] : [] });
  if (!reply) {
    try {
      const system = `You are TeamLink's AI sales assistant in a live product meeting with ${m.lead.contactName || 'a prospect'} from ${m.lead.company || 'a company'}. You are an AI and say so if asked.
Answer EXACTLY the question asked, in 2 to 4 plain sentences (at most 70 words)${other ? `. You MUST write the reply in ${other}, in ${other} script (product names stay in English)` : ', in the language the person writes in'}. Never answer with a list of screens, menus or feature names. If the QUESTIONS AND ANSWERS below cover the question, give that answer in your own words.
Use ONLY the facts below. Name a job board, app or integration only if the facts name it, and say it works only the way the facts say (if the facts say the team posts by hand, never say automatic or one click). If the facts do not answer the question, say a person from our team will confirm it, and set "unanswered": true. Never invent a price, number, client name or date; never offer a discount. When it fits, end with one short question about their needs (team size, what they use today, timeline, who decides). The person can see their exact price at the end of the meeting.
Reply ONLY as JSON: {"reply": "<your full sentence(s) to the person>", "unanswered": true|false, "wantsHuman": true|false}.

FACTS:
${kn}`;
      const history = tr.slice(-8).map((x) => ({ role: x.who === 'ai' ? 'assistant' : 'user', content: x.text }));
      history[history.length - 1] = { role: 'user', content: `${qn}${other ? `\n(Reply in ${other}.)` : ''}` };
      const tidy = (o) => (o && typeof o.reply === 'string' ? guardClaims(guardReply(o.reply, kn), kn) : '');
      let out = await askAi(system, history, 'answer', meta, { localOk: !writtenBackup || !!other });
      let r = tidy(out);
      if (bad(r)) {
        // one more try, told what was wrong
        const again = [...history, { role: 'assistant', content: String((out && out.reply) || '').slice(0, 600) }, { role: 'user', content: `That did not answer my question. Answer only this, in 2-4 plain sentences, no list: ${qn}${other ? ` (in ${other})` : ''}` }];
        const meta2 = {};
        out = await askAi(system, again, 'answer', meta2, { localOk: !writtenBackup || !!other });
        r = tidy(out);
        meta.retried = true; meta.ms = (meta.ms || 0) + (meta2.ms || 0);
        meta.inputTokens = (meta.inputTokens || 0) + (meta2.inputTokens || 0); meta.outputTokens = (meta.outputTokens || 0) + (meta2.outputTokens || 0);
        if (meta2.provider) meta.provider = meta2.provider;
      }
      if (!bad(r)) { reply = r; unanswered = !!out.unanswered; wantsHuman = !!out.wantsHuman; }
    } catch (e) { meta.error = S.clip(e.message, 160); /* no model: the written answers below */ }
  }
  if (!reply) {
    // no usable answer: the closest written answer (not the one just given), else a person will confirm
    const hit = faqMatch(m.products, qn, { exclude: prevAi ? [prevAi.text] : [] });
    reply = hit && !bad(hit) ? hit : NOTED;
    unanswered = reply === NOTED;
    meta.answeredBy = reply === NOTED ? 'none (a person will confirm)' : 'written';
  }
  // which provider answered, for the team (never shown to the lead: the meeting page reads only who and text)
  tr.push({ who: 'ai', text: reply, at: new Date().toISOString(), unanswered, wantsHuman, meta });
  await prisma.$executeRawUnsafe('UPDATE "CrmAiMeeting" SET "transcript" = ? WHERE "id" = ?', JSON.stringify(tr), m.meeting.id);
  if (wantsHuman) await bellOwner(m.lead, `🙋 ${m.lead.company || 'A lead'} wants a person in the AI meeting`, `${m.lead.contactName || 'The lead'} asked for a person: "${q.slice(0, 120)}"`);
  return { ok: true, reply, unanswered };
}
// the written Q&A of the products, without menu-list answers
function qaOf(prods) {
  const out = [];
  prods.forEach((p) => String(p.faq || '').split(/\n\s*\n|\n(?=q[:.)])/i).forEach((block) => {
    const q = ((/^\s*q[:.)]?\s*([\s\S]*?)(\n\s*a[:.)]|$)/i.exec(block) || [])[1] || '').trim();
    const a = ((/\n\s*a[:.)]\s*([\s\S]+)$/i.exec(block) || [])[1] || '').trim();
    if (q && a && !listLike(a)) out.push({ q, a, product: p.name });
  }));
  return out;
}
// the written answer closest to the question. strong = its QUESTION says what was asked (answer at once); otherwise the answers and the
// features count too (the fallback when the AI cannot answer)
const STOP = new Set(['the', 'and', 'for', 'are', 'our', 'you', 'can', 'how', 'its', 'any', 'has', 'all', 'yes', 'not', 'does', 'with', 'what', 'have', 'your', 'this', 'that', 'there', 'they', 'from', 'will', 'which', 'about', 'when', 'where', 'into', 'work', 'many', 'much', 'please', 'tell', 'teamlink', 'who', 'why', 'get', 'use', 'did', 'was', 'were', 'them', 'then', 'than', 'also', 'just', 'like', 'want', 'need', 'one', 'our', 'out']);
const SYN = { price: 'cost', prices: 'cost', pricing: 'cost', priced: 'cost', charge: 'cost', charges: 'cost', fee: 'cost', fees: 'cost', costs: 'cost', mobiles: 'mobile', phone: 'mobile', phones: 'mobile', android: 'mobile', iphone: 'mobile', excel: 'excel', sheet: 'excel', sheets: 'excel', xlsx: 'excel' };
const stem = (w) => SYN[w] || (w.length > 4 ? w.replace(/(ings|ing|ies|es|s|ed)$/, '') : w);
const SHORT = ['pf', 'hr', 'ai', 'do'];
const wordsOf = (t) => [...new Set((String(t).toLowerCase().match(/[a-z]{2,}/g) || []).filter((w) => !STOP.has(w) && (w.length >= 3 || SHORT.includes(w))).map(stem).filter((w) => !STOP.has(w)))];
const stemsOf = (t) => new Set(wordsOf(t));
function faqMatch(prods, q, { strong = false, exclude = [] } = {}) {
  const words = wordsOf(q);
  if (!words.length) return null;
  const skip = new Set(exclude.map(norm));
  let best = null; let bestN = 0; let bestScore = -1;
  qaOf(prods).forEach((x) => {
    if (skip.has(norm(x.a))) return;
    const qs = stemsOf(x.q); const as = stemsOf(x.a);
    const n = words.filter((w) => qs.has(w) || (!strong && as.has(w))).length;
    // the written question that says the most of what was asked, and the least of anything else
    const score = n - 0.25 * [...qs].filter((w) => !words.includes(w)).length;
    if (n > 0 && score > bestScore) { bestScore = score; bestN = n; best = x.a; }
  });
  if (!strong) prods.forEach((p) => (p.features || []).forEach((f) => { const fs2 = stemsOf(f); const n = words.filter((w) => fs2.has(w)).length; if (n > bestN && !skip.has(norm(`Yes - ${p.name}: ${f}.`))) { bestN = n; best = `Yes - ${p.name}: ${f}.`; } }));
  // one meaningful word ("does it work on mobile?"): only a written question about just that word
  if (words.length === 1) return bestN === 1 && bestScore >= 0.75 ? String(best).slice(0, 600) : null;
  const need = strong ? Math.max(2, Math.ceil(words.length * 0.7)) : 2;
  return bestN >= need ? String(best).slice(0, 600) : null;
}
const DECISIONS = { yes: 'Yes, I want to go ahead', later: 'I need some time', no: 'Not for us right now' };
async function meetingEnd(token, decision) {
  const m = await meetingFor(token);
  if (!m) return { error: 'This meeting link has expired.' };
  if (m.meeting.status !== 'Open') return { ok: true, already: true };
  const d = DECISIONS[decision] ? decision : 'later';
  const tr = m.meeting.transcript;
  const asked = tr.filter((x) => x.who === 'lead').map((x) => x.text);
  const open = tr.filter((x, i) => x.who === 'ai' && x.unanswered && tr[i - 1] && tr[i - 1].who === 'lead').map((x, i, arr) => x && tr[tr.indexOf(x) - 1].text);
  let sum = null;
  let sumMeta = null;
  try {
    sumMeta = {};
    sum = await askAi('Summarise this sales meeting for the sales owner. budget, authority, need and timeline come ONLY from what the LEAD said (never from what the AI said, never our prices); write "unknown" when the lead did not say it. TeamLink gives no discounts in the meeting: never write that a discount is possible. Reply ONLY as JSON: {"summary": "3-5 short lines", "interest": "high|medium|low", "budget": "the lead\'s own words or unknown", "authority": "who decides, as the lead said, or unknown", "need": "the need in a line or unknown", "timeline": "when, as the lead said, or unknown", "objections": ["..."], "nextStep": "one line"}', [{ role: 'user', content: tr.map((x) => `${x.who === 'ai' ? 'AI' : 'LEAD'}: ${x.text}`).join('\n').slice(-12000) }], 'summary', sumMeta, { localOk: true });
  } catch { sum = null; }
  // what only the AI said is not the lead's budget / decision maker / timeline; and no "discount possible"
  const leadSaid = asked.join(' ').toLowerCase().replace(/,/g, '');
  const noDiscount = (v) => (v == null ? v : String(v).replace(/[^.;,]*discount[^.;,]*[.;,]?/gi, '').trim() || 'unknown');
  if (sum) {
    ['budget', 'authority', 'timeline'].forEach((k) => {
      const v = noDiscount(sum[k]);
      const nums = (String(v || '').replace(/,/g, '').match(/\d+/g) || []).filter((n) => n.length >= 2);
      sum[k] = nums.some((n) => !leadSaid.includes(n)) ? 'unknown' : v;
    });
    sum.summary = noDiscount(sum.summary);
    sum.nextStep = noDiscount(sum.nextStep);
  }
  const known = (v) => v && !/^unknown$/i.test(String(v).trim());
  const interest = d === 'yes' ? 'high' : d === 'no' ? 'low' : ((sum && sum.interest) || (asked.length >= 3 ? 'medium' : 'low'));
  const score = Math.min(100, (interest === 'high' ? 40 : interest === 'medium' ? 20 : 0) + (sum && known(sum.budget) ? 15 : 0) + (sum && known(sum.authority) ? 15 : 0) + (sum && known(sum.need) ? 15 : 0) + (sum && known(sum.timeline) ? 15 : 0) + (d === 'yes' ? 20 : 0));
  const summary = {
    decision: DECISIONS[d], interest, score, questions: asked.length, openQuestions: open,
    ai: sumMeta, // which provider wrote the summary (for the team)
    text: (sum && sum.summary) || `${asked.length} question(s) asked. The lead said: ${DECISIONS[d]}.`,
    budget: sum && sum.budget, authority: sum && sum.authority, need: sum && sum.need, timeline: sum && sum.timeline, objections: (sum && sum.objections) || [], nextStep: sum && sum.nextStep,
  };
  const now = new Date().toISOString();
  await prisma.$executeRawUnsafe('UPDATE "CrmAiMeeting" SET "endedAt" = ?, "decision" = ?, "summary" = ?, "score" = ?, "status" = ? WHERE "id" = ?', now, d, JSON.stringify(summary), score, 'Ended', m.meeting.id);
  const names = m.products.map((p) => p.name).join(', ');
  const lines = [`Decision: ${DECISIONS[d]} · readiness ${score}/100 · interest ${interest}`, summary.text, summary.need ? `Need: ${summary.need}` : '', summary.budget ? `Budget: ${summary.budget}` : '', summary.authority ? `Decides: ${summary.authority}` : '', summary.timeline ? `Timeline: ${summary.timeline}` : '', open.length ? `Open questions for the team:\n- ${open.join('\n- ')}` : ''].filter(Boolean).join('\n');
  // the meeting itself on the timeline; the stage follows (crm/sales.js autoStage)
  const S2 = require('./sales'); // eslint-disable-line global-require
  await S.insert('CrmActivity', { id: S.newId('act'), kind: 'meeting', subject: `AI meeting held: ${names}`, note: lines.slice(0, 4000), at: now, leadId: m.lead.id, accountId: m.lead.accountId || null, byId: null, byName: 'AI sales assistant', createdAt: now });
  if (d === 'yes' || (d === 'later' && score >= 60)) {
    await S2.autoStage(m.lead.id, { kind: 'meeting', outcome: 'Meeting held' }).catch(() => null);
    await followUp(m.lead, `${m.lead.company || 'Lead'} is ready: send the proposal for ${names}${open.length ? ' (answer the open questions)' : ''}`, 1);
    await bellOwner(m.lead, `✅ ${m.lead.company || 'A lead'} qualified in the AI meeting`, `${DECISIONS[d]}. Readiness ${score}/100. ${open.length} open question(s).`);
  } else if (d === 'later') {
    await S2.autoStage(m.lead.id, { kind: 'meeting' }).catch(() => null);
    await followUp(m.lead, `Follow up ${m.lead.company || 'the lead'} after the AI meeting (${names})`, 7);
    await bellOwner(m.lead, `🕐 ${m.lead.company || 'A lead'} needs time`, `After the AI meeting: ${DECISIONS[d]}. Readiness ${score}/100.`);
  } else {
    await S2.autoStage(m.lead.id, { kind: 'meeting', outcome: 'Not interested' }).catch(() => null);
    await bellOwner(m.lead, `❌ ${m.lead.company || 'A lead'} said not for now`, `After the AI meeting about ${names}.`);
  }
  return { ok: true, decision: d, score };
}
async function meetingsOf(user, id) {
  const { row, error } = await leadFor(user, id);
  if (error) return error;
  await ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT * FROM "CrmAiMeeting" WHERE "leadId" = ? ORDER BY "createdAt" DESC', row.id);
  return S.okBody({ meetings: rows.map((x) => ({ ...x, transcript: parse(x.transcript, []), summary: parse(x.summary, null) })), products: keysOf(row.products) });
}

// ---- after Won: onboarding and the renewal --------------------------------------------------------------------------------
async function onWon(dealId) {
  try {
    await ensure();
    const deal = await S.getRow('deal', dealId);
    if (!deal) return;
    const [lead] = await prisma.$queryRawUnsafe('SELECT * FROM "CrmLead" WHERE "dealId" = ? LIMIT 1', dealId);
    const keys = keysOf(lead && lead.products);
    if (!keys.length) return; // not one of our software products
    const names = (await productsByKeys(keys)).map((p) => p.name).join(', ');
    const already = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "CrmTask" WHERE "dealId" = ? AND "title" LIKE ?', dealId, 'Onboarding:%');
    if (Number(already[0].n)) return;
    const base = { ...lead, dealId, ownerId: deal.ownerId || (lead && lead.ownerId), ownerName: deal.ownerName || (lead && lead.ownerName) };
    await followUp(base, `Onboarding: set up the ${names} account and the admin login`, 1);
    await followUp(base, `Onboarding: training session for the team (${names})`, 5);
    await followUp(base, `Onboarding: go-live check and first-week review (${names})`, 14);
    await followUp(base, `Renewal: ${names} subscription renews in 30 days - confirm users and plan`, 335);
    await note(lead.id, lead.accountId, 'note', `Won: onboarding and the renewal reminder are planned (${names})`, null);
  } catch { /* the deal is won anyway */ }
}

module.exports = {
  PRODUCT_KEYS, ensure, products, saveProduct, setLeadProducts, demoLink, demoForToken, demoEvent, meetingLink, meetingFor, meetingSay, meetingEnd,
  meetingsOf, onWon, videoPathOf, setVideoFile, staffVideoLink, productKeys, addProduct, addExtraVideo, removeExtraVideo, extraPathOf, readToken, makeToken, VIDEO_DIR, guardReply, keysOf,
  siteBase, note, bellOwner, followUp, leadFor, LANGS, faqMatch, knowledge, guardClaims, readQuestion, qaOf, listLike, fixWrittenText,
};
