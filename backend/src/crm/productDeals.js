// ---------------------------------------------------------------------------
// OUR PRODUCTS: FROM A NEW LEAD TO A PAID CUSTOMER (founder 2026-11-17 "build all"). Next to crm/productSales.js (catalogue, demo, AI meeting):
//   settings          auto demo on/off, the WhatsApp template for the first message, how a customer pays (bank / UPI text + a payment-page link)
//   onNewLead         a new lead (website form or added by hand; not an Excel import) gets the demo by itself, by email and WhatsApp.
//                     The product comes from the form (products=HRMS,ATS) or is guessed from the words (payroll -> HRMS, hiring -> ATS ...);
//                     with none known the demo shows all products and the lead ticks what they need.
//   quotes            plan x people x months + GST 18%, from the AI meeting ("Go ahead") or made by the team; the customer accepts on a
//                     signed page, which converts the lead into a deal (value = the quote before GST, stage Negotiation) and shows how to pay
//   trial             "Request a trial account": a follow-up for the team today + a bell (accounts are set up by a person)
//   slots / book      "Talk to a person": the next 6 working days, 10:00-18:00 in half hours, without the owner's own follow-up times;
//                     the booking is a follow-up at that time + a bell + an email to the lead
//   funnel            demos sent -> opened -> interested -> AI meetings -> go ahead -> quotes -> accepted -> won, per product
// ---------------------------------------------------------------------------
const prisma = require('../db');
const S = require('./service');
const PS = require('./productSales');

let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      await PS.ensure();
      await prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "CrmProductSettings" ("id" TEXT PRIMARY KEY, "json" TEXT, "updatedAt" TEXT)');
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "CrmQuote" ("id" TEXT PRIMARY KEY, "number" TEXT NOT NULL, "leadId" TEXT NOT NULL, "items" TEXT, "billing" TEXT,
        "subtotal" REAL, "gst" REAL, "total" REAL, "status" TEXT NOT NULL DEFAULT 'Sent', "madeBy" TEXT, "createdAt" TEXT NOT NULL, "decidedAt" TEXT, "dealId" TEXT)`);
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "CrmQuote_lead" ON "CrmQuote" ("leadId","createdAt")');
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}
const parse = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };
const nowIso = () => new Date().toISOString();
const ist = (ms = Date.now()) => new Date(ms + 5.5 * 3600000);

// ---- settings ----------------------------------------------------------------------------------------------------------------
const DEFAULTS = { autoDemo: true, waTemplate: '', waTemplateLang: 'en', paymentText: '', paymentLink: '', quoteValidityDays: 30, companyVideoFile: '', companyVideoTitle: '' };
async function settings() {
  await ensure();
  const [r] = await prisma.$queryRawUnsafe('SELECT "json" FROM "CrmProductSettings" WHERE "id" = \'main\'');
  return { ...DEFAULTS, ...parse(r && r.json, {}) };
}
async function saveSettings(user, body = {}) {
  if (!['admin', 'tl'].includes(S.roleOf(user))) return S.fail(403, 'Only a Sales manager or an Admin can change this.');
  const cur = await settings();
  const t = (v, n) => (v == null ? undefined : String(v).trim().slice(0, n));
  const next = {
    autoDemo: body.autoDemo === undefined ? cur.autoDemo : !!body.autoDemo,
    waTemplate: t(body.waTemplate, 120) ?? cur.waTemplate,
    waTemplateLang: t(body.waTemplateLang, 12) || cur.waTemplateLang,
    paymentText: t(body.paymentText, 2000) ?? cur.paymentText,
    paymentLink: t(body.paymentLink, 500) ?? cur.paymentLink,
    quoteValidityDays: Math.min(180, Math.max(1, Math.round(Number(body.quoteValidityDays) || cur.quoteValidityDays))),
    companyVideoFile: body.companyVideoFile === '' ? '' : cur.companyVideoFile, // only cleared from the screen; set by an upload (crm/productVideo.js)
    companyVideoTitle: t(body.companyVideoTitle, 120) ?? cur.companyVideoTitle,
  };
  if (next.paymentLink && !/^https:\/\//i.test(next.paymentLink)) return S.fail(400, 'The payment link must start with https://');
  await prisma.$executeRawUnsafe('INSERT INTO "CrmProductSettings" ("id","json","updatedAt") VALUES (\'main\',?,?) ON CONFLICT("id") DO UPDATE SET "json" = excluded."json", "updatedAt" = excluded."updatedAt"', JSON.stringify(next), nowIso());
  await S.audit(user, 'CRM product settings changed', 'CrmProductSettings', 'main', next.autoDemo ? 'auto demo on' : 'auto demo off');
  return S.okBody({ ok: true, settings: next });
}

// the company / general video shown at the top of every demo page (from an upload, crm/productVideo.js)
async function setCompanyVideo(file, title) {
  const cur = await settings();
  const next = { ...cur, companyVideoFile: file, companyVideoTitle: String(title || cur.companyVideoTitle || 'About TeamLink').slice(0, 120) };
  await prisma.$executeRawUnsafe('INSERT INTO "CrmProductSettings" ("id","json","updatedAt") VALUES (\'main\',?,?) ON CONFLICT("id") DO UPDATE SET "json" = excluded."json", "updatedAt" = excluded."updatedAt"', JSON.stringify(next), nowIso());
}

// ---- a new lead gets the demo by itself ------------------------------------------------------------------------------------------
const WORDS = {
  HRMS: /\b(hrms|hr software|payroll|attendance|biometric|leave|payslip|employee|hr management|salary|pf|esi)\b/i,
  ATS: /\b(ats|recruit\w*|hiring|hire|candidate\w*|job portal|resume\w*|cv|talent|interview\w*|placement\w*|staffing)\b/i,
  OMNI: /\b(omni\w*|whatsapp|sms|email campaign\w*|campaign\w*|marketing|social media|instagram|facebook|bulk message\w*|chat ?bot)\b/i,
};
// the three we started with by their words; a product added later by its own name ("TeamLink Accounts" -> "accounts")
const nameWords = (name) => String(name || '').replace(/teamlink/ig, '').split(/[^a-z0-9]+/i).filter((w) => w.length >= 3).map((w) => w.toLowerCase());
function guessProducts(text, custom = []) {
  const t = String(text || '');
  const lower = t.toLowerCase();
  const base = Object.keys(WORDS).filter((k) => WORDS[k].test(t));
  const extra = custom.filter((p) => !WORDS[p.key] && nameWords(p.name).some((w) => new RegExp(`\\b${w}\\b`).test(lower))).map((p) => p.key);
  return [...base, ...extra];
}
async function sendWa(lead, text, url, st) {
  // eslint-disable-next-line global-require
  const send = require('../channels/send');
  const meta = { audience: 'crm', personName: lead.contactName || lead.company, purpose: 'CRM product demo' };
  if (st.waTemplate) return send.sendWhatsApp({ to: lead.phone, text, template: { name: st.waTemplate, language: st.waTemplateLang || 'en' }, vars: [lead.contactName || 'there', url], kind: 'bulk', meta });
  return send.sendWhatsApp({ to: lead.phone, text, kind: 'bulk', meta });
}
async function onNewLead(lead, { products, text } = {}, deps = {}) {
  try {
    await ensure();
    if (!lead || !lead.id) return { skip: 'no lead' };
    const catalogue = await PS.products();
    let keys = PS.keysOf(Array.isArray(products) ? products.join(',') : products).filter((k) => catalogue.some((p) => p.key === k));
    if (!keys.length) keys = guessProducts([text, lead.notes, lead.company, lead.industry].filter(Boolean).join(' '), catalogue);
    if (keys.length) await S.update('CrmLead', lead.id, { products: keys.join(',') });
    const st = await settings();
    if (!st.autoDemo) return { skip: 'auto demo is off', keys };
    if (!lead.phone && !lead.email) return { skip: 'no phone or email', keys };
    const active = (await PS.products()).filter((p) => p.hasVideo || p.demoUrl).map((p) => p.key);
    const show = keys.length ? keys : active;
    if (!show.length) return { skip: 'no product to show', keys };
    const url = `${PS.siteBase()}/api/crm-public/demo/${PS.makeToken('demo', lead.id, show, 30, keys.length ? '' : 'pick')}`;
    const names = (await PS.products()).filter((p) => show.includes(p.key)).map((p) => p.name).join(', ');
    const first = lead.contactName ? String(lead.contactName).split(' ')[0] : '';
    const text2 = `Hello${first ? ` ${first}` : ''}, thank you for your interest in TeamLink. Here is a short demo of ${names}: ${url}\nIf it looks right, press "I'm interested" on that page and our AI assistant will take you through it and answer your questions straight away.`;
    const CMP = require('./campaigns'); // eslint-disable-line global-require
    const sent = [];
    if (lead.email && !(await CMP.optedOut('email', lead.email).catch(() => false))) {
      const mail = deps.sendMail || ((m) => require('../utils/mailer').sendMail({ useEmployeeFrom: false, fromName: 'TeamLink', ...m })); // eslint-disable-line global-require
      const r = await mail({ to: lead.email, subject: `Your ${names} demo`, text: `${text2}\n\nTeamLink` }).catch((e) => ({ ok: false, error: e.message }));
      if (r && r.ok !== false) sent.push('email');
    }
    if (lead.phone && !(await CMP.optedOut('whatsapp', lead.phone).catch(() => false))) {
      const r = await (deps.sendWa ? deps.sendWa(lead.phone, text2) : sendWa(lead, text2, url, st)).catch((e) => ({ ok: false, error: e.message }));
      if (r && r.ok) sent.push('WhatsApp');
    }
    await PS.note(lead.id, lead.accountId, sent.includes('email') ? 'email' : (sent.length ? 'whatsapp' : 'note'), sent.length ? `Demo sent automatically by ${sent.join(' and ')}: ${names}` : `Demo link made automatically (could not send it: send it from Products & demo): ${names}`, url);
    return { ok: true, sent, keys, url };
  } catch (e) { return { error: e.message }; }
}

// ---- quotes ----------------------------------------------------------------------------------------------------------------------
const priceNum = (s) => Number(String(s || '').replace(/[^\d.]/g, '')) || 0;
function qtyKindOf(unit) {
  const u = String(unit || '').toLowerCase();
  if (/employee/.test(u)) return 'employees';
  if (/recruiter/.test(u)) return 'recruiters';
  if (/user|seat/.test(u)) return 'users';
  return null;
}
const money = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;
async function priceQuote(items = [], billing = 'yearly') {
  const all = await PS.products({ all: true });
  const yearly = billing !== 'monthly';
  const lines = [];
  for (const it of (Array.isArray(items) ? items : []).slice(0, 6)) {
    const p = all.find((x) => x.key === String(it.key || '').toUpperCase());
    const plan = p && (p.plans || []).find((x) => x.name === it.plan);
    if (!p || !plan) return { error: `Pick a plan for ${p ? p.name : 'each product'}.` };
    const price = priceNum(plan.price);
    if (!price) return { error: `${p.name} ${plan.name} has no price yet - our team will quote it.` };
    const kind = qtyKindOf(plan.unit);
    const min = Number((/minimum\s+(\d+)/i.exec(plan.includes || '') || [])[1]) || 1;
    let qty = kind ? Math.round(Number(it.qty) || 0) : 1;
    if (kind && qty < 1) return { error: `How many ${kind} for ${p.name}?` };
    if (qty > 100000) return { error: 'That number looks too big.' };
    if (kind && qty < min) qty = min;
    const perMonth = price * qty * (yearly ? 1 : 1.1);
    const amount = Math.round(yearly ? perMonth * 12 : perMonth);
    lines.push({ key: p.key, product: p.name, plan: plan.name, price: plan.price, unit: plan.unit, qtyKind: kind, qty, min, months: yearly ? 12 : 1, amount });
  }
  if (!lines.length) return { error: 'Pick at least one product and plan.' };
  const subtotal = lines.reduce((s, x) => s + x.amount, 0);
  const gst = Math.round(subtotal * 0.18);
  return { lines, billing: yearly ? 'yearly' : 'monthly', subtotal, gst, total: subtotal + gst };
}
const quoteUrlOf = (q) => `${PS.siteBase()}/api/crm-public/quote/${PS.makeToken('quote', q.leadId, [], 90, q.id)}`;
async function makeQuote(lead, body, madeBy) {
  await ensure();
  const pq = await priceQuote(body.items, body.billing);
  if (pq.error) return { error: pq.error };
  const ym = ist().toISOString().slice(2, 7).replace('-', '');
  const [{ n }] = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "CrmQuote" WHERE "number" LIKE ?', `TLQ-${ym}-%`);
  const q = { id: S.newId('quote'), number: `TLQ-${ym}-${String(Number(n) + 1).padStart(3, '0')}`, leadId: lead.id, items: JSON.stringify(pq.lines), billing: pq.billing, subtotal: pq.subtotal, gst: pq.gst, total: pq.total, status: 'Sent', madeBy, createdAt: nowIso() };
  await prisma.$executeRawUnsafe('INSERT INTO "CrmQuote" ("id","number","leadId","items","billing","subtotal","gst","total","status","madeBy","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    q.id, q.number, q.leadId, q.items, q.billing, q.subtotal, q.gst, q.total, q.status, q.madeBy, q.createdAt);
  const url = quoteUrlOf(q);
  await PS.note(lead.id, lead.accountId, 'note', `Quote ${q.number}: ${money(q.total)} incl. GST (${pq.lines.map((x) => `${x.product} ${x.plan}${x.qtyKind ? ` x ${x.qty} ${x.qtyKind}` : ''}`).join(', ')}, ${pq.billing})`, url);
  // the lead's stage goes to Proposal when that is ahead of where it is
  try {
    const names = (await require('./settings').load()).leadStages.map((s) => s.name); // eslint-disable-line global-require
    const fresh = await S.getRow('lead', lead.id);
    if (fresh && names.includes('Proposal') && names.indexOf('Proposal') > names.indexOf(fresh.stage || names[0]) && !['Converted', 'Junk'].includes(fresh.status)) {
      await S.update('CrmLead', lead.id, { stage: 'Proposal', status: 'Qualified', updatedAt: nowIso() });
      await PS.note(lead.id, lead.accountId, 'note', `Stage: ${fresh.stage || names[0]} → Proposal`, 'Moved automatically: a quote was sent');
    }
  } catch { /* the quote is made anyway */ }
  return { ok: true, quote: { ...q, items: pq.lines }, url };
}
async function quoteByStaff(user, id, body = {}) {
  const { row, error } = await PS.leadFor(user, id, { edit: true });
  if (error) return error;
  const out = await makeQuote(row, body, user.name || 'Team');
  if (out.error) return S.fail(400, out.error);
  const first = row.contactName ? String(row.contactName).split(' ')[0] : '';
  const text = `Hello${first ? ` ${first}` : ''}, here is your TeamLink quote ${out.quote.number} for ${money(out.quote.total)} (incl. GST): ${out.url}\nYou can accept it on that page.`;
  let sent = null;
  if (body.channel === 'email') {
    if (!row.email) return S.fail(400, 'This lead has no email address.');
    const r = await require('../utils/mailer').sendMail({ to: row.email, subject: `Your TeamLink quote ${out.quote.number}`, text: `${text}\n\nTeamLink`, useEmployeeFrom: false, fromName: 'TeamLink' }).catch((e) => ({ ok: false, error: e.message })); // eslint-disable-line global-require
    if (!r || r.ok === false) return S.fail(502, `The quote is made but the email could not be sent: ${(r && r.error) || 'mail is not set up'}. Copy the link instead.`);
    sent = 'email';
  }
  const wa = row.phone ? `https://wa.me/91${String(row.phone).replace(/\D/g, '').slice(-10)}?text=${encodeURIComponent(text)}` : null;
  return S.okBody({ ...out, whatsappUrl: wa, text, sent });
}
async function quoteByMeeting(token, body = {}) {
  const v = PS.readToken(token, 'meet');
  if (!v) return { error: 'This meeting link has expired.' };
  const lead = await S.getRow('lead', v.l);
  if (!lead) return { error: 'This meeting link has expired.' };
  const out = await makeQuote(lead, body, 'AI meeting');
  if (out.error) return out;
  await PS.bellOwner(lead, `🧾 ${lead.company || 'A lead'} made a quote in the AI meeting`, `${out.quote.number}: ${money(out.quote.total)} incl. GST.`);
  return { ok: true, url: out.url, total: out.quote.total };
}
async function quoteFor(token) {
  const v = PS.readToken(token, 'quote');
  if (!v || !v.x) return null;
  await ensure();
  const [q] = await prisma.$queryRawUnsafe('SELECT * FROM "CrmQuote" WHERE "id" = ? AND "leadId" = ?', v.x, v.l);
  if (!q) return null;
  const lead = await S.getRow('lead', q.leadId);
  const st = await settings();
  const validTill = new Date(new Date(q.createdAt).getTime() + st.quoteValidityDays * 86400000);
  return { quote: { ...q, items: parse(q.items, []) }, lead, settings: st, expired: q.status === 'Sent' && validTill < new Date(), validTill: validTill.toISOString().slice(0, 10) };
}
async function systemUser(lead) {
  const pick = lead && lead.ownerId ? await prisma.user.findUnique({ where: { id: lead.ownerId } }).catch(() => null) : null;
  return pick || prisma.user.findFirst({ where: { status: 'Active', role: 'SUPER_ADMIN' }, orderBy: { createdAt: 'asc' } });
}
async function decideQuote(token, decision, deps = {}) {
  const d = await quoteFor(token);
  if (!d || !d.lead) return { error: 'This link has expired.' };
  if (d.quote.status !== 'Sent') return { ok: true, already: true, status: d.quote.status };
  if (d.expired) return { error: 'This quote has expired. Please ask us for a fresh one.' };
  const accept = decision === 'accept';
  const status = accept ? 'Accepted' : 'Declined';
  await prisma.$executeRawUnsafe('UPDATE "CrmQuote" SET "status" = ?, "decidedAt" = ? WHERE "id" = ? AND "status" = \'Sent\'', status, nowIso(), d.quote.id);
  const lead = d.lead;
  await PS.note(lead.id, lead.accountId, 'note', `Quote ${d.quote.number} ${status.toLowerCase()} by the customer (${money(d.quote.total)})`, null);
  if (!accept) {
    await PS.bellOwner(lead, `Quote declined: ${lead.company || 'a lead'}`, `${d.quote.number} was declined on the quote page.`);
    await PS.followUp(lead, `Call ${lead.contactName || lead.company}: quote ${d.quote.number} declined - ask why`, 1);
    return { ok: true, status };
  }
  // accepted: the lead becomes a deal worth the quote (before GST), in Negotiation, and the team collects the payment and sets up the account
  let dealId = lead.dealId || null;
  try {
    if (lead.status !== 'Converted') {
      const u = await systemUser(lead);
      const names = (await PS.products({ all: true })).filter((p) => d.quote.items.some((x) => x.key === p.key)).map((p) => p.name).join(' + ');
      const cv = u ? await (deps.convert || S.convertLead)(u, lead.id, { value: d.quote.subtotal, dealTitle: `${lead.company} - ${names}` }) : null;
      dealId = cv && cv.body && cv.body.deal ? cv.body.deal.id : dealId;
    }
    if (dealId) {
      const prob = ((await require('./settings').load()).stageProbability || {}).Negotiation || 80; // eslint-disable-line global-require
      await prisma.$executeRawUnsafe('UPDATE "CrmDeal" SET "stage" = \'Negotiation\', "probability" = ?, "value" = ?, "finalValue" = ?, "updatedAt" = ? WHERE "id" = ? AND "stage" NOT IN (\'Won\',\'Lost\')', prob, d.quote.subtotal, d.quote.subtotal, nowIso(), dealId);
      await prisma.$executeRawUnsafe('UPDATE "CrmQuote" SET "dealId" = ? WHERE "id" = ?', dealId, d.quote.id);
    }
  } catch { /* the acceptance is recorded anyway */ }
  await PS.followUp({ ...lead, dealId }, `Quote ${d.quote.number} accepted: collect the payment (${money(d.quote.total)}), then mark the deal Won`, 0);
  await PS.bellOwner(lead, `🎉 ${lead.company || 'A lead'} accepted the quote`, `${d.quote.number}: ${money(d.quote.total)} incl. GST. Collect the payment, then mark the deal Won.`);
  return { ok: true, status, dealId };
}
async function quotesOf(user, id) {
  const { row, error } = await PS.leadFor(user, id);
  if (error) return error;
  await ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT * FROM "CrmQuote" WHERE "leadId" = ? ORDER BY "createdAt" DESC', row.id);
  return S.okBody({ quotes: rows.map((q) => ({ ...q, items: parse(q.items, []), url: quoteUrlOf(q) })) });
}

// ---- trial and talking to a person -------------------------------------------------------------------------------------------
async function leadOfAny(token) {
  for (const kind of ['demo', 'meet', 'quote']) {
    const v = PS.readToken(token, kind);
    if (v) { const lead = await S.getRow('lead', v.l); if (lead) return { lead, v }; } // eslint-disable-line no-await-in-loop
  }
  return null;
}
async function requestTrial(token) {
  const t = await leadOfAny(token);
  if (!t) return { error: 'This link has expired.' };
  const { lead, v } = t;
  const [{ n }] = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "CrmTask" WHERE "leadId" = ? AND "title" LIKE ? AND "status" = \'Open\'', lead.id, 'Set up a trial account%');
  if (Number(n)) return { ok: true, already: true };
  const names = PS.keysOf(lead.products || (v.p || []).join(',')).join(', ') || 'our products';
  await PS.followUp(lead, `Set up a trial account for ${lead.company || lead.contactName} (${names}) and send the login`, 0);
  await PS.note(lead.id, lead.accountId, 'note', `Asked for a trial account (${names})`, null);
  await PS.bellOwner(lead, `🧪 ${lead.company || 'A lead'} asked for a trial account`, `Set it up today and send the login (${names}).`);
  return { ok: true };
}
const WORK = { from: 10, to: 18 };
async function slots(token) {
  const t = await leadOfAny(token);
  if (!t) return { error: 'This link has expired.' };
  const own = t.lead.ownerId;
  const out = [];
  let day = ist();
  for (let i = 0; out.length < 6 && i < 14; i += 1) {
    day = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1));
    if (day.getUTCDay() === 0) continue; // eslint-disable-line no-continue
    const ymd = day.toISOString().slice(0, 10);
    // eslint-disable-next-line no-await-in-loop
    const taken = own ? (await prisma.$queryRawUnsafe('SELECT "dueTime" FROM "CrmTask" WHERE "ownerId" = ? AND "dueDate" = ? AND "status" = \'Open\' AND "dueTime" IS NOT NULL', own, ymd)).map((x) => x.dueTime) : [];
    const times = [];
    for (let h = WORK.from; h < WORK.to; h += 1) for (const m of ['00', '30']) { const tm = `${String(h).padStart(2, '0')}:${m}`; if (!taken.includes(tm)) times.push(tm); }
    out.push({ day: ymd, label: day.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }), times });
  }
  return { ok: true, days: out };
}
async function book(token, body = {}) {
  const t = await leadOfAny(token);
  if (!t) return { error: 'This link has expired.' };
  const free = await slots(token);
  const day = (free.days || []).find((x) => x.day === String(body.day || ''));
  const time = String(body.time || '');
  if (!day || !day.times.includes(time)) return { error: 'That time is not free any more - please pick another.' };
  const { lead } = t;
  const phone = String(body.phone || '').replace(/[^\d+]/g, '').slice(0, 15);
  const now = nowIso();
  await S.insert('CrmTask', { id: S.newId('task'), title: `Call ${lead.contactName || lead.company} at ${time} - booked by the lead${phone ? ` (on ${phone})` : ''}`, dueDate: day.day, dueTime: time, status: 'Open', leadId: lead.id, accountId: lead.accountId || null, dealId: lead.dealId || null, ownerId: lead.ownerId || null, ownerName: lead.ownerName || null, createdById: lead.ownerId || null, createdAt: now, updatedAt: now });
  await PS.note(lead.id, lead.accountId, 'note', `Booked a call with a person: ${day.label} ${time}`, phone ? `Call on ${phone}` : null);
  await PS.bellOwner(lead, `📅 ${lead.company || 'A lead'} booked a call`, `${day.label} at ${time}${phone ? ` on ${phone}` : ''}.`);
  if (lead.email) await require('../utils/mailer').sendMail({ to: lead.email, subject: `Your call with TeamLink: ${day.label} ${time}`, text: `Hello${lead.contactName ? ` ${String(lead.contactName).split(' ')[0]}` : ''},\n\nYour call with our team is booked for ${day.label} at ${time} (India time). We will call you${phone ? ` on ${phone}` : ''}.\n\nTeamLink`, useEmployeeFrom: false, fromName: 'TeamLink' }).catch(() => null); // eslint-disable-line global-require
  return { ok: true, day: day.label, time };
}

// ---- the funnel --------------------------------------------------------------------------------------------------------------------
async function funnel(user, days = 90) {
  if (!S.roleOf(user)) return S.fail(403, 'No CRM access.');
  await ensure();
  const since = new Date(Date.now() - Math.min(730, Math.max(1, Number(days) || 90)) * 86400000).toISOString();
  const prods = await PS.products({ all: true });
  const acts = await prisma.$queryRawUnsafe('SELECT "leadId","subject" FROM "CrmActivity" WHERE "at" > ? AND "byName" = \'AI sales assistant\'', since);
  const meets = await prisma.$queryRawUnsafe('SELECT "leadId","products","status","decision" FROM "CrmAiMeeting" WHERE "createdAt" > ?', since);
  const quotes = await prisma.$queryRawUnsafe('SELECT "leadId","items","status","dealId" FROM "CrmQuote" WHERE "createdAt" > ?', since);
  const won = await prisma.$queryRawUnsafe('SELECT DISTINCT "dealId" FROM "CrmTask" WHERE "title" LIKE \'Onboarding:%\' AND "createdAt" > ?', since);
  const wonIds = new Set(won.map((x) => x.dealId));
  const leadsWith = (test) => new Set(acts.filter(test).map((a) => a.leadId)).size;
  const rows = prods.map((p) => {
    const has = (a) => String(a.subject || '').includes(p.name);
    const ms = meets.filter((m) => String(m.products || '').split(',').includes(p.key));
    const qs = quotes.filter((q) => parse(q.items, []).some((x) => x.key === p.key));
    return {
      key: p.key, name: p.name,
      demosSent: leadsWith((a) => has(a) && /^Demo (sent|link made)/.test(a.subject)),
      opened: leadsWith((a) => has(a) && /^Demo opened/.test(a.subject)),
      interested: leadsWith((a) => has(a) && /^Interested after the demo/.test(a.subject)),
      meetings: new Set(ms.map((m) => m.leadId)).size,
      goAhead: new Set(ms.filter((m) => m.decision === 'yes').map((m) => m.leadId)).size,
      quotes: new Set(qs.map((q) => q.leadId)).size,
      accepted: new Set(qs.filter((q) => q.status === 'Accepted').map((q) => q.leadId)).size,
      won: new Set(qs.filter((q) => q.dealId && wonIds.has(q.dealId)).map((q) => q.leadId)).size,
    };
  });
  return S.okBody({ days: Number(days) || 90, rows });
}

module.exports = { ensure, settings, saveSettings, setCompanyVideo, guessProducts, onNewLead, priceQuote, makeQuote, quoteByStaff, quoteByMeeting, quoteFor, decideQuote, quotesOf, requestTrial, slots, book, funnel };
