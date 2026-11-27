// ---------------------------------------------------------------------------
// AI MARKETING > CLIENT PLANS > LEADS (2026-11-27): "lead tracking" of the Premium plan. Each client on a plan can have ONE enquiry page (a private-looking public link) with a Call button,
// a WhatsApp button and a short enquiry form. The same page is shared with ?s=<where it is shared> (website, Facebook, Instagram, Google profile ...), so every enquiry says where it came from.
//   * LEADS    form enquiries and the ones the team adds by hand (phone calls, walk-ins), with a status (New, Contacted, Became a customer, Not interested) and a note.
//   * PRESSES  the Call and WhatsApp buttons are counted when a person presses them (opening the page counts nothing, so link previews and robots do not inflate anything). A press is not an answered call.
//   * REPORT   the month's counts go into the monthly client report (monthlyReport.js) beside the numbers the team types.
// PRIVACY: these are the CLIENT's enquirers, kept apart from TeamLink's own CRM and contact lists. The form needs a permission tick; the words agreed to are saved with the lead; no IP address
// is stored; a lead can be deleted for good; nothing is sent to the person and nothing leaves TeamLink by itself. The team gets one bell per new form enquiry (without the person's details).
// saved: tables OmniMkLeadPage, OmniMkClientLead, OmniMkLeadPress; audit log "Omni-Channel AI Marketing: client lead ...".
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const S = require('../outreach/store');
const CS = require('./clientServices');
const { logAudit } = require('../utils/audit');

const TPG = 'OmniMkLeadPage'; const TL = 'OmniMkClientLead'; const TPR = 'OmniMkLeadPress';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${TPG}" ("planId" TEXT NOT NULL PRIMARY KEY, "token" TEXT NOT NULL, "isOn" INTEGER NOT NULL DEFAULT 0, "heading" TEXT, "phone" TEXT, "whatsapp" TEXT, "privacyContact" TEXT, "updatedById" TEXT, "updatedAt" DATETIME NOT NULL DEFAULT 0)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "${TPG}_token" ON "${TPG}"("token")`,
  `CREATE TABLE IF NOT EXISTS "${TL}" ("id" TEXT NOT NULL PRIMARY KEY, "planId" TEXT NOT NULL, "at" DATETIME NOT NULL DEFAULT 0, "lastAt" DATETIME NOT NULL DEFAULT 0, "how" TEXT NOT NULL, "source" TEXT NOT NULL, "name" TEXT, "phone" TEXT, "email" TEXT, "message" TEXT, "status" TEXT NOT NULL DEFAULT 'new', "note" TEXT, "times" INTEGER NOT NULL DEFAULT 1, "consentText" TEXT, "consentAt" DATETIME, "addedByName" TEXT)`,
  `CREATE INDEX IF NOT EXISTS "${TL}_plan" ON "${TL}"("planId", "at")`,
  `CREATE TABLE IF NOT EXISTS "${TPR}" ("id" TEXT NOT NULL PRIMARY KEY, "planId" TEXT NOT NULL, "at" DATETIME NOT NULL DEFAULT 0, "button" TEXT NOT NULL, "source" TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS "${TPR}_plan" ON "${TPR}"("planId", "at")`,
];
let okAt = 0;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  if (!(await CS.ensure())) return false;
  try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } // eslint-disable-line no-await-in-loop
  catch (e) { console.error('[omni-mk] client leads schema:', e.message); return false; } // eslint-disable-line no-console
}

// where a shared link is put (?s=) and how a lead added by hand arrived
const LINK_SOURCES = [['website', 'Website'], ['facebook', 'Facebook'], ['instagram', 'Instagram'], ['google', 'Google profile'], ['whatsapp', 'WhatsApp'], ['youtube', 'YouTube'], ['linkedin', 'LinkedIn'], ['poster', 'Poster or QR']];
const HAND_SOURCES = [['phone', 'Phone call'], ['walkin', 'Walk-in'], ['referral', 'Referral'], ['other', 'Other']];
const SOURCE_WORDS = Object.fromEntries([['direct', 'Direct link'], ...LINK_SOURCES, ...HAND_SOURCES]);
const STATUSES = [['new', 'New'], ['contacted', 'Contacted'], ['customer', 'Became a customer'], ['lost', 'Not interested']];
const STATUS_WORDS = Object.fromEntries(STATUSES);
const DAY_CAP_LEADS = 200; const DAY_CAP_PRESSES = 1000; // per client page: a flood cannot fill the database
const linkSource = (v) => (LINK_SOURCES.some(([k]) => k === v) ? v : 'direct');
const monthOk = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
const monthOf = (month) => (monthOk(month) ? month : CS.istMonth());

// a phone number as digits with the country code ("919876543210"), or '' when it is not one. A 10-digit Indian mobile gets 91.
function phoneDigits(v) {
  const raw = String(v == null ? '' : v).trim(); if (!raw || /[^\d\s()+.-]/.test(raw)) return '';
  let d = raw.replace(/\D/g, '').replace(/^00/, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = `91${d}`;
  return d.length >= 11 && d.length <= 15 ? d : '';
}
const emailOk = (v) => /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/.test(v);
const oneLine = (v, n) => S.clip(String(v == null ? '' : v).replace(/\s+/g, ' '), n);

const consentWords = (clientName) => `I agree that ${clientName} may contact me about this enquiry using the details I give here. TeamLink Consultants runs this form for ${clientName}.`;

// ---- the client's page settings ------------------------------------------------------------------------------------------------------------------------------------------
const pageRow = async (planId) => (await S.q(`SELECT * FROM "${TPG}" WHERE planId = ?`, planId))[0] || null;
const pageOut = (r) => ({
  on: !!(r && S.num(r.isOn)), heading: (r && r.heading) || '', phone: (r && r.phone) || '', whatsapp: (r && r.whatsapp) || '', privacyContact: (r && r.privacyContact) || '',
  path: r ? `/api/public/mk-lead/${r.token}` : '',
});
async function savePage(u, planId, b = {}) {
  if (!(await ensure())) return { error: 'The enquiry page could not be saved.', status: 500 };
  const plan = await CS.planRow(u, planId); if (!plan) return { error: 'That client plan was not found.', status: 404 };
  const phoneIn = oneLine(b.phone, 30); const waIn = oneLine(b.whatsapp, 30);
  const phone = phoneIn ? phoneDigits(phoneIn) : ''; const whatsapp = waIn ? phoneDigits(waIn) : '';
  if (phoneIn && !phone) return { error: 'The call number is not a phone number.', status: 400 };
  if (waIn && !whatsapp) return { error: 'The WhatsApp number is not a phone number.', status: 400 };
  const privacyContact = oneLine(b.privacyContact, 120); const heading = oneLine(b.heading, 120); const on = b.on === true ? 1 : 0;
  if (privacyContact && !emailOk(privacyContact) && !phoneDigits(privacyContact)) return { error: 'The privacy contact is a phone number or an email address.', status: 400 };
  if (on && !privacyContact) return { error: 'Add the privacy contact first: the page tells people whom to ask to see or delete their details.', status: 400 };
  if (on && plan.status !== 'active') return { error: 'This plan has ended, so its page cannot be switched on.', status: 409 };
  const old = await pageRow(planId);
  if (old) await S.run(`UPDATE "${TPG}" SET isOn=?, heading=?, phone=?, whatsapp=?, privacyContact=?, updatedById=?, updatedAt=? WHERE planId=?`, on, heading || null, phone || null, whatsapp || null, privacyContact || null, u.id, Date.now(), planId);
  else await S.run(`INSERT INTO "${TPG}" (planId, token, isOn, heading, phone, whatsapp, privacyContact, updatedById, updatedAt) VALUES (?,?,?,?,?,?,?,?,?)`, planId, crypto.randomBytes(16).toString('hex'), on, heading || null, phone || null, whatsapp || null, privacyContact || null, u.id, Date.now());
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: client lead page saved', entity: TPG, entityId: planId, toValue: `${plan.clientName}: ${on ? 'on' : 'off'}` });
  return { page: pageOut(await pageRow(planId)) };
}

// ---- counting ------------------------------------------------------------------------------------------------------------------------------------------------------------
const leadOut = (r) => ({
  id: r.id, at: S.iso(r.at), lastAt: S.iso(r.lastAt), how: r.how, source: r.source, sourceWords: SOURCE_WORDS[r.source] || r.source, name: r.name || '', phone: r.phone || '', email: r.email || '',
  message: r.message || '', status: r.status, statusWords: STATUS_WORDS[r.status] || r.status, note: r.note || '', times: S.num(r.times), addedByName: r.addedByName || '',
});
async function monthRows(planId, month) {
  const [from, to] = CS.monthRange(month);
  const leads = await S.q(`SELECT * FROM "${TL}" WHERE planId = ? AND at >= ? AND at < ? ORDER BY at DESC LIMIT 2000`, planId, from, to);
  const presses = await S.q(`SELECT button, source, COUNT(*) AS n FROM "${TPR}" WHERE planId = ? AND at >= ? AND at < ? GROUP BY button, source`, planId, from, to);
  return { leads, presses };
}
function countsOf({ leads, presses }) {
  const sum = (list) => list.reduce((a, x) => a + S.num(x.n), 0);
  const bySource = {}; for (const l of leads) bySource[l.source] = (bySource[l.source] || 0) + 1;
  return {
    total: leads.length, form: leads.filter((l) => l.how === 'form').length, hand: leads.filter((l) => l.how === 'hand').length,
    waiting: leads.filter((l) => l.status === 'new').length, customers: leads.filter((l) => l.status === 'customer').length,
    callPresses: sum(presses.filter((p) => p.button === 'call')), whatsappPresses: sum(presses.filter((p) => p.button === 'whatsapp')),
    bySource: Object.entries(bySource).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ source: k, words: SOURCE_WORDS[k] || k, count: n })),
  };
}
// for the monthly report: null when this client has no tracking at all in that month (never a column of zeros nobody asked for)
async function reportCounts(planId, month) {
  if (!(await ensure())) return null;
  const c = countsOf(await monthRows(planId, month));
  if (c.total || c.callPresses || c.whatsappPresses) return c;
  const p = await pageRow(planId); const [, to] = CS.monthRange(month);
  return p && S.num(p.isOn) && to > Date.now() ? c : null;
}

async function forPlan(u, planId, month) {
  if (!(await ensure())) return { error: 'The leads could not be opened.', status: 500 };
  const plan = await CS.planRow(u, planId); if (!plan) return { error: 'That client plan was not found.', status: 404 };
  const m = monthOf(month); const rows = await monthRows(planId, m);
  return {
    month: m, clientName: plan.clientName, page: pageOut(await pageRow(planId)), counts: countsOf(rows), leads: rows.leads.map(leadOut),
    linkSources: LINK_SOURCES, handSources: HAND_SOURCES, statuses: STATUSES,
  };
}

// ---- leads the team adds and works on ------------------------------------------------------------------------------------------------------------------------------------
async function addByHand(u, planId, b = {}) {
  if (!(await ensure())) return { error: 'The lead could not be saved.', status: 500 };
  const plan = await CS.planRow(u, planId); if (!plan) return { error: 'That client plan was not found.', status: 404 };
  const name = oneLine(b.name, 100); const phoneIn = oneLine(b.phone, 30); const phone = phoneIn ? phoneDigits(phoneIn) : '';
  if (phoneIn && !phone) return { error: 'That is not a phone number.', status: 400 };
  if (!name && !phone) return { error: 'Write the name or the phone number.', status: 400 };
  const source = HAND_SOURCES.some(([k]) => k === b.source) || LINK_SOURCES.some(([k]) => k === b.source) ? b.source : 'phone';
  const id = S.newId('cld'); const now = Date.now();
  await S.run(`INSERT INTO "${TL}" (id, planId, at, lastAt, how, source, name, phone, email, message, status, note, times, consentText, consentAt, addedByName) VALUES (?,?,?,?,'hand',?,?,?,NULL,?,'new',NULL,1,NULL,NULL,?)`, id, planId, now, now, source, name || null, phone || null, S.clip(b.message, 600) || null, S.clip(u.name, 80));
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: client lead added', entity: TL, entityId: id, toValue: plan.clientName });
  return { ok: true, id };
}
async function leadOfPlan(u, planId, leadId) {
  const plan = await CS.planRow(u, planId); if (!plan) return null;
  const lead = (await S.q(`SELECT * FROM "${TL}" WHERE id = ? AND planId = ?`, String(leadId), planId))[0]; return lead ? { plan, lead } : null;
}
async function setLead(u, planId, leadId, b = {}) {
  if (!(await ensure())) return { error: 'The lead could not be saved.', status: 500 };
  const g = await leadOfPlan(u, planId, leadId); if (!g) return { error: 'That lead was not found.', status: 404 };
  const status = b.status != null ? (STATUS_WORDS[b.status] ? b.status : null) : g.lead.status; if (!status) return { error: 'Pick a status from the list.', status: 400 };
  const note = b.note != null ? S.clip(b.note, 500) : g.lead.note || '';
  await S.run(`UPDATE "${TL}" SET status = ?, note = ? WHERE id = ?`, status, note || null, g.lead.id);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: client lead changed', entity: TL, entityId: g.lead.id, toValue: `${g.plan.clientName}: ${STATUS_WORDS[status]}` });
  return { ok: true };
}
async function removeLead(u, planId, leadId) { // for good: this is how a person's "delete my details" is done
  if (!(await ensure())) return { error: 'The lead could not be deleted.', status: 500 };
  const g = await leadOfPlan(u, planId, leadId); if (!g) return { error: 'That lead was not found.', status: 404 };
  await S.run(`DELETE FROM "${TL}" WHERE id = ?`, g.lead.id);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: client lead deleted', entity: TL, entityId: g.lead.id, toValue: g.plan.clientName });
  return { ok: true };
}
// a spreadsheet must never run a lead's words as a formula
const csvCell = (v) => { let t = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; return `"${t.replace(/"/g, '""')}"`; };
const istWords = (v) => { const t = S.ms(v); return t ? new Date(t + 5.5 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : ''; };
async function csv(u, planId, month) {
  const d = await forPlan(u, planId, month); if (d.error) return d;
  const head = ['Date and time (India)', 'Came from', 'How', 'Name', 'Phone', 'Email', 'Message', 'Status', 'Note', 'Times enquired'];
  const lines = [head.map(csvCell).join(',')];
  for (const l of d.leads) lines.push([istWords(Date.parse(l.at)), l.sourceWords, l.how === 'form' ? 'Form' : 'Added by team', l.name, l.phone, l.email, l.message, l.statusWords, l.note, l.times].map(csvCell).join(','));
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: client lead list downloaded', entity: TL, entityId: planId, toValue: `${d.clientName}: ${d.month}, ${d.leads.length} lead(s)` });
  const safe = d.clientName.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'client';
  return { csv: `﻿${lines.join('\r\n')}\r\n`, name: `leads-${safe}-${d.month}.csv` };
}

// ---- the public page (no login): routes/mkLeadPublic.js ------------------------------------------------------------------------------------------------------------------
// the page a token opens, or null: unknown token, switched off, or the plan has ended all look the same
async function publicPage(token) {
  if (!/^[a-f0-9]{32}$/.test(String(token || '')) || !(await ensure())) return null;
  const p = (await S.q(`SELECT * FROM "${TPG}" WHERE token = ?`, token))[0]; if (!p || !S.num(p.isOn)) return null;
  const plan = (await S.q('SELECT * FROM "OmniMkClientPlan" WHERE id = ?', p.planId))[0]; if (!plan || plan.status !== 'active') return null;
  return { planId: p.planId, planRow: plan, clientName: plan.clientName, heading: p.heading || plan.clientName, phone: p.phone || '', whatsapp: p.whatsapp || '', privacyContact: p.privacyContact || '', consent: consentWords(plan.clientName) };
}
const dayStart = (now) => Date.parse(`${CS.istDay(now)}T00:00:00+05:30`);
// opts: { notify, recipients } (a test answers these two)
async function publicSubmit(page, source, b = {}, opts = {}) {
  const name = oneLine(b.name, 100); const phone = phoneDigits(oneLine(b.phone, 30)); const email = oneLine(b.email, 150).toLowerCase(); const message = S.clip(b.message, 600);
  if (name.length < 2) return { error: 'Please write your name.', status: 400 };
  if (!phone) return { error: 'Please write your phone number with 10 digits.', status: 400 };
  if (email && !emailOk(email)) return { error: 'Please check the email address, or leave it empty.', status: 400 };
  if (!['yes', 'on', true].includes(b.consent)) return { error: 'Please tick the permission box so we may contact you.', status: 400 };
  const now = Date.now(); const month = CS.istMonth(now); const [from, to] = CS.monthRange(month);
  const old = (await S.q(`SELECT * FROM "${TL}" WHERE planId = ? AND phone = ? AND at >= ? AND at < ? ORDER BY at DESC LIMIT 1`, page.planId, phone, from, to))[0];
  if (old) { // the same person again this month: one lead, counted once; a second sender cannot overwrite what is there
    const more = message && !String(old.message || '').includes(message) ? S.clip([old.message, message].filter(Boolean).join('\n'), 1500) : old.message || '';
    await S.run(`UPDATE "${TL}" SET times = times + 1, lastAt = ?, message = ?, email = COALESCE(email, ?), consentText = ?, consentAt = ? WHERE id = ?`, now, more || null, email || null, page.consent, now, old.id);
    return { ok: true, repeat: true };
  }
  const today = S.num((await S.q(`SELECT COUNT(*) AS n FROM "${TL}" WHERE planId = ? AND how = 'form' AND at >= ?`, page.planId, dayStart(now)))[0].n);
  if (today >= DAY_CAP_LEADS) return { error: 'This form cannot take more enquiries today. Please call instead.', status: 429 };
  const id = S.newId('cld'); const src = linkSource(source);
  await S.run(`INSERT INTO "${TL}" (id, planId, at, lastAt, how, source, name, phone, email, message, status, note, times, consentText, consentAt, addedByName) VALUES (?,?,?,?,'form',?,?,?,?,?,'new',NULL,1,?,?,NULL)`, id, page.planId, now, now, src, name, phone, email || null, message || null, page.consent, now);
  try { // the team's bell: no name or number in it
    const to2 = await (opts.recipients || require('./planReminders').recipients)(page.planRow); // eslint-disable-line global-require
    if (to2.length) await (opts.notify || require('../utils/notify').notifyUsers)(to2, { title: `New enquiry: ${page.clientName}`, message: `Came from: ${SOURCE_WORDS[src]}. Open AI Marketing > Client plans > Leads.` }); // eslint-disable-line global-require
  } catch (e) { console.error('[omni-mk] lead bell:', e.message); } // eslint-disable-line no-console
  return { ok: true };
}
async function press(page, source, button) {
  if (!((button === 'call' && page.phone) || (button === 'whatsapp' && page.whatsapp))) return { ok: false };
  const now = Date.now();
  const today = S.num((await S.q(`SELECT COUNT(*) AS n FROM "${TPR}" WHERE planId = ? AND at >= ?`, page.planId, dayStart(now)))[0].n);
  if (today >= DAY_CAP_PRESSES) return { ok: false };
  await S.run(`INSERT INTO "${TPR}" (id, planId, at, button, source) VALUES (?,?,?,?,?)`, S.newId('clp'), page.planId, now, button, linkSource(source));
  return { ok: true };
}

module.exports = {
  ensure, phoneDigits, linkSource, consentWords, LINK_SOURCES, HAND_SOURCES, STATUSES, SOURCE_WORDS, savePage, forPlan, reportCounts, addByHand, setLead, removeLead, csv, publicPage, publicSubmit, press,
};
