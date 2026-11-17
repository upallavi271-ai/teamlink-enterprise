// ---------------------------------------------------------------------------
// PLANS MEETING > THE DEMO OFFERED BY ITSELF (founder 2026-11-17: "everytime we cant manually add the client no. and share them a demo link ... when a client is looking for our kind of work then they should
// be suggested a demo from our TeamLink Consultants about our plans").
//   * WhatsApp: a NEW person (nobody TeamLink knows: not a candidate, an employee, a vendor, a client contact, a CRM lead in a sales talk) writes to one of the company numbers an Admin ticked
//     (the Digital Marketing number). They get a short friendly message with THEIR OWN demo link, in the 24-hour window their message opened (free text is allowed there). Once per person per 30 days,
//     never after STOP, at most 150 a day. On a ticked number the recruitment assistant ("Are you looking for a job?") stays quiet for people who are not candidates (omniwa/agent.js asks handles()).
//   * Website form: a new CRM website lead with a phone number who wrote about marketing (not about HRMS/ATS: those have their own product demo) gets the same link by the approved template, from the
//     company number (the Admin's second switch).
//   * The team sees each one on the Plans meeting page (made by "WhatsApp (automatic)" or "Website form") and gets a bell; the demo then does the rest (answers, call request, alert, CRM lead).
// Everything is OFF until an Admin switches it on (Plans meeting page > Automatic demo). Nothing here is written by an AI: the messages are fixed words in English, Telugu and Hindi.
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const M = require('./meeting');

const DAY = 86400000;
const digits = (x) => String(x == null ? '' : x).replace(/\D/g, '');
const STOP = /^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*$/i;
// website leads: only someone who wrote about OUR kind of work, and not about the HR products (crm/productDeals.js sends those their own demo)
const KEYWORDS = /market|social media|instagram|facebook|\bads?\b|advertis|poster|reel|youtube|linkedin|\bseo\b|branding|\blogo\b|promot|campaign|content (writing|creation)|post design|creative/i;
const PRODUCT = /\b(hrms|ats|payroll|attendance|recruit\w*|hiring|crm|applicant)\b/i;
const langOf = (text) => (/[ఀ-౿]/.test(String(text || '')) ? 'te' : (/[ऀ-ॿ]/.test(String(text || '')) ? 'hi' : 'en'));
const baseUrl = () => String(process.env.APP_BASE_URL || '').replace(/\/+$/, ''); // this copy's own address (a separate company's copy has its own); without it nothing is offered
const inflight = new Set(); // two messages from the same new person arriving together make one offer

const WHATSAPP_OFFER = {
  en: (n, link) => `Hello${n ? ` ${n}` : ''}! Thank you for writing to TeamLink Digital Marketing. Here is a short automated demo of our plans, prices and offers (about 5 minutes, in English, Telugu or Hindi). You can ask questions in it and ask for a call from our team: ${link}\n\nReply STOP to stop messages from us.`,
  te: (n, link) => `నమస్కారం${n ? ` ${n} గారు` : ''}! టీమ్‌లింక్ డిజిటల్ మార్కెటింగ్‌కు మెసేజ్ చేసినందుకు ధన్యవాదాలు. మా ప్లాన్లు, ధరలు, ఆఫర్ల గురించి చిన్న ఆటోమేటెడ్ డెమో (సుమారు 5 నిమిషాలు, ఇంగ్లీష్, తెలుగు లేదా హిందీలో). అందులో ప్రశ్నలు అడగవచ్చు, మా టీమ్ నుండి కాల్ కూడా కోరవచ్చు: ${link}\n\nమెసేజ్‌లు ఆపడానికి STOP అని పంపండి.`,
  hi: (n, link) => `नमस्ते${n ? ` ${n} जी` : ''}! टीमलिंक डिजिटल मार्केटिंग को लिखने के लिए धन्यवाद। हमारे प्लान, कीमतों और ऑफ़र का एक छोटा ऑटोमैटिक डेमो (करीब 5 मिनट, अंग्रेज़ी, तेलुगु या हिंदी में)। इसमें सवाल पूछ सकते हैं और हमारी टीम से कॉल भी माँग सकते हैं: ${link}\n\nमैसेज बंद करने के लिए STOP भेजें।`,
};

// does this company number offer the demo? (the recruitment assistant asks this and stays quiet on such a number)
async function handles(numberId) {
  if (!numberId) return false;
  try { const o = (await M.readAll()).offer; return !!(o.on && o.numberIds.includes(String(numberId))); } catch { return false; }
}
const tail10 = (x) => digits(x).slice(-10);
// a row removed by hand still counts: a person is never offered the demo twice in 30 days, and a removed row does not give the daily cap back
const recentlyOffered = async (phone, now) => (await S.q(`SELECT id FROM "OmniMkMeeting" WHERE source IN ('inbound', 'website') AND createdAt > ? AND phone LIKE ? LIMIT 1`, now - 30 * DAY, `%${tail10(phone)}`)).length > 0;
const offeredToday = async (now) => S.num((await S.q(`SELECT COUNT(*) AS n FROM "OmniMkMeeting" WHERE source IN ('inbound', 'website') AND createdAt > ?`, now - DAY))[0].n);
const optedOut = async (phone) => { try { return !!(await require('../crm/campaigns').optedOut('whatsapp', phone)); } catch { return false; } }; // eslint-disable-line global-require
async function tellAdmins(title, message) { try { await require('./projects').tellTeam({ ownerId: null, createdById: null }, title, message); } catch { /* the bell is a courtesy */ } } // eslint-disable-line global-require
const failed = async (id, res, now) => { await S.run(`UPDATE "OmniMkMeeting" SET note = ?, updatedAt = ? WHERE id = ?`, S.clip(`The automatic message was not sent: ${res && res.error ? res.error : 'WhatsApp did not take it'}`, 190), now, id); return { sent: false, id }; };

// info: the inbound message (utils/messageDelivery.js applyInbound): { channel, from, text, name, numberId }; out: what applyInbound made of it ({ stored, review, stop, ... })
async function onInbound(info, out, now = Date.now()) {
  let key = '';
  try {
    if (!info || (info.channel && info.channel !== 'WhatsApp')) return null;
    const offer = (await M.readAll()).offer;
    if (!offer.on || !info.numberId || !offer.numberIds.includes(String(info.numberId))) return null;
    const e164 = digits(info.from);
    const text = String(info.text || '').trim();
    if (!e164 || STOP.test(text) || (out && (out.stop || out.stored || out.review))) return null; // STOP, or somebody TeamLink already knows (a candidate, an employee, a vendor, a client contact), or a message waiting for review
    const site = baseUrl(); if (!site) return null;
    if (inflight.has(tail10(e164))) return null; // the same person's other message is being handled right now
    key = tail10(e164);
    inflight.add(key);
    if (await require('./clientChat').handles(e164).catch(() => false)) return null; // eslint-disable-line global-require -- a contact of an AI Marketing project has its own answers
    if (await require('../crm/salesAgent').handles(e164).catch(() => false)) return null; // eslint-disable-line global-require -- an open CRM lead is in a sales talk
    if (await optedOut(e164)) return null;
    await M.ensure();
    if (await recentlyOffered(e164, now)) return null;
    if ((await offeredToday(now)) >= M.OFFER_CAP) return null;
    const lang = langOf(text);
    const P = require('./projects'); // eslint-disable-line global-require
    const made = await M.createOffered({ name: info.name, phone: e164, language: lang, source: 'inbound', createdByName: 'WhatsApp (automatic)', note: text ? `Wrote: ${S.clip(text, 150)}` : 'Wrote to the Digital Marketing number' });
    const body = WHATSAPP_OFFER[lang](P.firstWord(info.name), `${site}/m/${made.id}`);
    const res = await require('../utils/messaging').send('WhatsApp', { to: `+${e164}`, kind: 'text', text: body, vars: [body], numberId: info.numberId, automatic: true, meta: { audience: 'client', purpose: 'AI Marketing: plans demo offered to a new enquiry', module: 'AI Marketing', personName: S.clip(info.name, 80) } }); // eslint-disable-line global-require
    if (!(res && res.ok)) return await failed(made.id, res, now);
    await S.run(`UPDATE "OmniMkMeeting" SET sentAt = ?, sentVia = 'whatsapp (automatic)', updatedAt = ? WHERE id = ?`, now, now, made.id);
    await tellAdmins(`New WhatsApp enquiry: ${S.clip(info.name, 60) || `+${e164}`}`, `${S.clip(info.name, 60) || 'Someone new'} (+${e164}) wrote to the Digital Marketing number and was sent the plans demo by TeamLink. Open AI Marketing > Client projects > Plans meeting to see how far they watch.`);
    return { sent: true, id: made.id };
  } catch (e) { console.error('[omni-mk] demo offer (whatsapp):', e && e.message); return null; } // eslint-disable-line no-console
  finally { if (key) inflight.delete(key); }
}

// is this new website lead one the plans demo is for? (switch on, a real mobile number, wrote about OUR kind of work and not about the HR products). The CRM product demo (crm/productDeals.js)
// asks the same, so a marketing lead gets the plans demo INSTEAD of the HRMS/ATS one, never both.
async function takesLead(lead, ctx = {}) {
  try {
    const offer = (await M.readAll()).offer;
    if (!offer.website || !lead || !lead.phone || !baseUrl()) return null;
    const nm = require('../utils/messagingCore').normalizeMobile(lead.phone); // eslint-disable-line global-require
    if (!nm.ok) return null;
    const said = `${ctx.text || ''} ${lead.notes || ''}`;
    if (ctx.products || PRODUCT.test(said) || !KEYWORDS.test(said)) return null;
    return { offer, e164: nm.e164, said };
  } catch { return null; }
}

// a new CRM website lead (crm/sales.js capture): lead = the saved CrmLead, ctx = { text: what they wrote, products: the products they ticked }
async function onWebsiteLead(lead, ctx = {}, now = Date.now()) {
  try {
    const t = await takesLead(lead, ctx);
    if (!t) return null;
    const { offer, said } = t;
    const nm = { e164: t.e164 };
    const site = baseUrl();
    if (await optedOut(nm.e164)) return null;
    await M.ensure();
    if (await recentlyOffered(nm.e164, now) || (await offeredToday(now)) >= M.OFFER_CAP) return null;
    const P = require('./projects'); // eslint-disable-line global-require
    const lang = langOf(said);
    const who = lead.contactName || lead.company;
    const made = await M.createOffered({ name: who, phone: nm.e164, language: lang, source: 'website', createdById: lead.ownerId || null, createdByName: lead.ownerName || 'Website form', note: 'A website form lead' });
    const text = M.inviteText(lang, P.firstWord(who), `${site}/m/${made.id}`);
    const Sender = require('./sender'); // eslint-disable-line global-require
    const pk = await Sender.pick(null, (offer.numberIds || [])[0], { trusted: true }); // the company number that offers the demo, else the default one
    const res = pk.error ? { ok: false, error: pk.error } : await require('../utils/messaging').send('WhatsApp', { to: nm.e164, kind: 'bulk', text: `${text}\n\nReply STOP to stop messages from us.`, vars: [text], meta: { audience: 'client', personName: S.clip(who, 80), purpose: 'AI Marketing: plans demo offered to a website lead', module: 'AI Marketing' }, ...Sender.opts(pk) }); // eslint-disable-line global-require
    if (!(res && res.ok)) return await failed(made.id, res, now);
    await S.run(`UPDATE "OmniMkMeeting" SET sentAt = ?, sentVia = 'whatsapp (automatic)', updatedAt = ? WHERE id = ?`, now, now, made.id);
    try { // a line on the lead's timeline
      const DB = require('../crm/schema'); const CS = require('../crm/service'); // eslint-disable-line global-require
      const at = DB.nowIso();
      await CS.insert('CrmActivity', { id: CS.newId('act'), kind: 'whatsapp', subject: 'Plans demo link sent by TeamLink', note: 'The lead asked about marketing on the website form, so TeamLink sent the 5-minute plans demo on WhatsApp.', at, leadId: lead.id, byName: 'Plans meeting', createdAt: at });
    } catch { /* the timeline line is a courtesy */ }
    await tellAdmins(`Website lead sent the plans demo: ${S.clip(who, 60)}`, `${S.clip(who, 60)} (+${nm.e164}) asked about marketing on the website form and was sent the plans demo by TeamLink. Open AI Marketing > Client projects > Plans meeting.`);
    return { sent: true, id: made.id };
  } catch (e) { console.error('[omni-mk] demo offer (website):', e && e.message); return null; } // eslint-disable-line no-console
}

module.exports = { onInbound, onWebsiteLead, takesLead, handles, langOf, KEYWORDS, PRODUCT, DAY };
