// ---------------------------------------------------------------------------
// CRM > THE AI SALES ASSISTANT (founder 2026-11-09: "mottham automatic ga ai ey matladey laaga chudu. chat conversations, mailings, ai calling").
//
// The automatic follow-through (crm/autopilot.js) reaches a new lead by mail, SMS, WhatsApp and an AI call. When the lead WRITES BACK, this answers
// them in the same channel - a WhatsApp, an SMS or a mail - the way a sales person would: what TeamLink does, what may be said about price, a meeting.
//   respond()   one answer to one message from a lead (autopilot.onReply calls it in the background, so the inbound webhook never waits for the model)
//   handles()   a WhatsApp number of an open lead while this is on: the recruitment WhatsApp agent (omniwa/agent.js) stays quiet on it
//   get/save()  CRM settings > Automatic > AI assistant (Sales manager or Admin)
//
// WHAT IT MAY SAY: only what the managers wrote here (about TeamLink, price, questions and answers) and the lead's own record. The model writes JSON
// {"reply", "action"}; nothing it writes is sent before guard() has checked it: no link but the meeting link, no money figure that is not in the
// text the managers wrote, no promise of a price or a discount. It says it is an AI assistant in its first reply (as every AI call does).
// WHEN A PERSON TAKES OVER: the lead asks for one, haggles, complains, says not interested, the model is unsure or down, or more than maxPerDay
// answers in a day. The lead is told someone will get back, the owner gets a bell and a follow-up, and the AI says nothing more to that lead.
// OFF until a manager switches it on. Every answer is on the lead's timeline, written by "AI assistant".
// ---------------------------------------------------------------------------
const prisma = require('../db');
const DB = require('./schema');
const S = require('./service');
const SALES = require('./sales');
const SETTINGS = require('./settings');

const KEY = 'crm.salesAi';
const AI_NAME = 'AI assistant';
const HANDED = 'AI handed over to a person';
const LIMIT = { WhatsApp: 700, SMS: 320, Email: 1800 };
const WORD = { WhatsApp: 'WhatsApp', SMS: 'SMS', Email: 'mail' };
const KIND = { WhatsApp: 'whatsapp', SMS: 'note', Email: 'email' };
const DEFAULTS = {
  on: false,
  about: 'TeamLink Consultants is a recruitment company. We find and screen candidates for companies in IT, medical, manufacturing and education, and handle the interviews up to joining.',
  pricing: 'Our fee depends on the role and the number of positions; our team shares a proposal after a short call.',
  faq: '',
  maxPerDay: 6,
  useClaude: true, // founder 2026-11-17: these replies and the AI meeting ask Claude (the rest of TeamLink stays on the local model)
};
const HOUR = 3600000;

// ---- settings ----------------------------------------------------------------------------------------------------------
const text = (v, n) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, n);
function clean(v = {}) {
  const per = Number(v.maxPerDay);
  return {
    on: !!v.on,
    about: text(v.about == null ? DEFAULTS.about : v.about, 3000),
    pricing: text(v.pricing == null ? DEFAULTS.pricing : v.pricing, 1500),
    faq: text(v.faq, 4000),
    maxPerDay: Number.isFinite(per) && per >= 1 && per <= 30 ? Math.round(per) : DEFAULTS.maxPerDay,
    useClaude: v.useClaude !== false,
  };
}
async function load() {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  return clean(v);
}
const onlyManagers = (user) => (S.mayAssign(S.roleOf(user)) ? null : S.fail(403, 'The AI assistant is set up by a Sales manager or an Admin.'));
async function get(user) {
  const no = onlyManagers(user); if (no) return no;
  return S.okBody({ settings: await load() });
}
async function save(user, body = {}) {
  const no = onlyManagers(user); if (no) return no;
  const cur = await load();
  const next = clean({ ...cur, ...body });
  if (next.on && !next.about) return S.fail(400, 'Write what TeamLink does first: the AI answers only from what is written here.');
  const value = JSON.stringify(next);
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
  if (next.on !== cur.on) await S.audit(user, next.on ? 'CRM AI assistant turned on' : 'CRM AI assistant turned off', 'AppSetting', KEY, next.on ? 'Answers leads who write back' : 'Off');
  return S.okBody({ ok: true, settings: next });
}

// ---- the lead and the talk so far ----------------------------------------------------------------------------------------
async function open(l) {
  if (!l || ['Junk', 'Converted'].includes(l.status)) return false;
  return !['Won', 'Lost'].includes(SALES.stageOf(l, SALES.stageNames(await SETTINGS.load())));
}
async function handedOver(leadId) {
  return !!(await DB.one('SELECT "id" FROM "CrmActivity" WHERE "leadId" = ? AND "subject" = ?', leadId, HANDED));
}
// the open lead behind a WhatsApp number, for the recruitment agent to stay out of a sales talk
async function handles(e164) {
  const st = await load();
  if (!st.on) return false;
  if (await require('../omniwa/assist').ownsPhone(e164).catch(() => false)) return false; // the WhatsApp marketing assistant answers this chat (omniwa/assist.js)
  const ph = S.phone10(e164);
  if (ph.length !== 10) return false;
  const rows = (await DB.all('SELECT * FROM "CrmLead" WHERE "phone" LIKE ?', `%${ph.slice(-4)}%`)).filter((l) => S.phone10(l.phone) === ph);
  for (const l of rows) if (await open(l) && !(await handedOver(l.id))) return true; // eslint-disable-line no-await-in-loop
  return false;
}
const istDayStart = (now) => new Date(Date.parse(`${new Date(now + 5.5 * HOUR).toISOString().slice(0, 10)}T00:00:00+05:30`)).toISOString();
async function history(leadId) {
  const rows = await DB.all('SELECT "subject", "note", "byName", "at" FROM "CrmActivity" WHERE "leadId" = ? ORDER BY "at" DESC LIMIT 14', leadId);
  // what the lead wrote is written by autopilot.onReply as "Replied on ..." / "Asked us to stop ..."; everything else is ours
  return rows.reverse().filter((r) => r.note).map((r) => (/^(Replied on|Asked us to stop)/.test(r.subject || '')
    ? { role: 'user', content: S.clip(r.note, 900) }
    : { role: 'assistant', content: S.clip(`${r.subject ? `[${r.subject}] ` : ''}${r.note}`, 900) }));
}
async function note(leadId, subject, body, kind, delivery = null) {
  const now = DB.nowIso();
  await S.insert('CrmActivity', {
    id: S.newId('act'), kind, subject, note: S.clip(body, 2000), at: now, leadId, byName: AI_NAME, createdAt: now,
    ...(delivery ? { providerRef: delivery.providerRef ? String(delivery.providerRef).slice(0, 200) : null, deliveryStatus: delivery.status || null, deliveryDetail: delivery.detail ? S.clip(delivery.detail, 300) : null } : {}),
  }).catch(() => null);
}

// ---- a lead who came for our software products (founder 2026-11-17, lead L-0013): they get the product facts, not the recruitment pitch --------
async function productContext(lead) {
  const PS = require('./productSales'); // eslint-disable-line global-require
  const keys = PS.keysOf(lead.products);
  // the lead picked a product, or itself opened the demo / the AI meeting (a demo link made for it is not enough)
  const fromDemo = keys.length ? null : await DB.one('SELECT "id" FROM "CrmActivity" WHERE "leadId" = ? AND "byName" = \'AI sales assistant\' AND ("subject" LIKE \'Demo opened%\' OR "subject" LIKE \'Interested after the demo%\' OR "subject" LIKE \'AI meeting%\') LIMIT 1', lead.id);
  if (!keys.length && !fromDemo) return null;
  const all = await PS.products();
  const prods = keys.length ? all.filter((x) => keys.includes(x.key)) : all;
  if (!prods.length) return null;
  const names = prods.map((x) => x.name).join(', ');
  const qa = PS.qaOf(prods).map((x) => `Q: ${x.q}\nA: ${x.a}`).join('\n\n');
  return {
    names,
    about: prods.map((x) => `${x.name}: ${x.tagline || ''} ${x.about || ''}\nFeatures: ${(x.features || []).slice(0, 10).join('; ')}`).join('\n\n'),
    pricing: prods.map((x) => `${x.name}: ${(x.plans || []).filter((y) => y.name).map((y) => `${y.name} ${y.price ? `${y.price} ${y.unit || ''}`.trim() : 'price on request'}`).join(', ') || 'price on request'} (GST 18% extra)`).join('\n'),
    faq: qa,
    knowledge: PS.knowledge ? PS.knowledge(prods) : qa,
  };
}

// ---- calls already booked, and what the lead asked for -----------------------------------------------------------------------------
// a call booked with this lead that has not happened yet (by the AI meeting's "Talk to a person", by this assistant or by a person)
async function upcomingCall(leadId, now = Date.now()) {
  const rows = await DB.all('SELECT "id", "title", "dueDate", "dueTime" FROM "CrmTask" WHERE "leadId" = ? AND "status" = \'Open\' AND "dueTime" IS NOT NULL AND ("type" = \'Meeting\' OR "title" LIKE \'%booked by the lead%\') ORDER BY "dueDate", "dueTime"', leadId);
  return rows.find((t) => Date.parse(`${t.dueDate}T${t.dueTime}:00+05:30`) > now) || null;
}
const whenOf = (t) => new Date(Date.parse(`${t.dueDate}T${t.dueTime}:00+05:30`)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
// "ok", "thanks", a thumbs up: an acknowledgement, never a yes to a call
const ACK_ONLY = /^\s*(?:(?:ok+|okay|okk+|k+|fine|done|noted|thanks?|thank\s*you(?:\s*so\s*much)?|thx|ty|tq|great|good|cool|nice|hmm+|alright|all\s*right|got\s*it|ok\s*(?:thanks?|thank\s*you|sir|madam|ma'?am))\s*[.!]*\s*|[\u{1F44D}\u{1F64F}\u{1F44C}\u{2705}\u{1F60A}\u{263A}\u{FE0F}\u{1F642}\s]+)$/iu;
// a time the lead named: "10am", "10:00", "3 pm", "15:30" -> "10:00"
function timeAsked(text) {
  const t = String(text || '').toLowerCase();
  let m = /\b(\d{1,2})(?::|\.)?(\d{2})?\s*(am|pm|a\.m\.|p\.m\.)/.exec(t);
  if (m) { let h = Number(m[1]) % 12; if (/p/.test(m[3])) h += 12; return `${String(h).padStart(2, '0')}:${m[2] || '00'}`; }
  m = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(t);
  if (m) return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
  return null;
}
// the model must never ask "shall we book?" in the same message that says it is booked, nor claim a booking itself: the real line is added after
function tidyBookingWords(reply) {
  return String(reply || '').split(/(?<=[.!?])\s+/).filter((x) => !/\b(would you like|shall (?:we|i)|can (?:we|i)|do you want|may i|should (?:we|i)|let me know if you(?:'d)? like)\b[^.?!]*\b(schedule|book|set up|arrange|fix)\b/i.test(x)
    && !/\bI(?:'ve| have)? (?:booked|scheduled|set up|arranged|fixed)\b|\bmeeting (?:is )?booked\b|\bcall (?:is )?(?:booked|scheduled)\b/i.test(x)).join(' ').trim();
}

// ---- what the model is told, and what it may send -----------------------------------------------------------------------
function prompt(st, lead, channel, owner, ctx = {}) {
  return [
    ctx.product
      ? `You are the AI sales assistant of TeamLink, which sells business software. This lead came from our product demo and is interested in ${ctx.product.names}. Talk only about these products, not about recruitment services. You are answering on ${WORD[channel]}. You are an AI; say so if asked.`
      : `You are the AI sales assistant of TeamLink Consultants, answering a business lead who wrote back on ${WORD[channel]}. You are an AI; say so if asked.`,
    'Use ONLY the facts below. Never invent a price, a discount, a client name, a date or a promise. If the answer is not below, say our team will confirm it.',
    'Goal: answer their question briefly and politely, then move towards a short call with our team. Plain words, no markdown.',
    `Keep it short: ${channel === 'Email' ? 'a few short paragraphs' : 'two or three sentences'}. Write in the language the lead wrote in (English, Telugu or Hindi).`,
    'Reply with JSON only: {"reply": "...", "action": "none" | "meeting" | "handoff" | "not_interested"}.',
    '- "meeting": ONLY when they clearly agree to a call or ask for one. Never for a bare "ok", "thanks" or an emoji. The system books the time and adds it to your reply: never write that you booked anything yourself, and never ask whether to book in the same reply.',
    ctx.booked ? `- A call is ALREADY booked with this lead for ${ctx.booked} (India time). Do not offer or book another one; mention this time if it helps.` : '',
    '- "handoff": they ask for a person, negotiate the price, complain, or you are not sure.',
    '- "not_interested": they say no or not now.',
    '',
    ctx.product ? `OUR PRODUCTS (${ctx.product.names}):\n${ctx.product.about}` : `ABOUT TEAMLINK:\n${st.about}`,
    `WHAT MAY BE SAID ABOUT PRICE:\n${(ctx.product && ctx.product.pricing) || st.pricing || 'Nothing: our team shares a proposal.'}`,
    (ctx.product ? ctx.product.faq : st.faq) ? `QUESTIONS AND ANSWERS:\n${ctx.product ? ctx.product.faq : st.faq}` : '',
    `THE LEAD: ${lead.contactName || ''} of ${lead.company || 'their company'}${lead.city ? `, ${lead.city}` : ''}${lead.notes ? `. Notes: ${S.clip(lead.notes, 300)}` : ''}. Their contact at TeamLink: ${owner || 'our sales team'}.`,
  ].filter(Boolean).join('\n');
}
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s]+/gi;
const MONEY_RE = /(?:₹|rs\.?|inr|rupees?)\s*[\d,.]+|[\d,.]+\s*(?:lakhs?|lacs?|k\b|thousand|crores?|%|percent|rupees?)/gi;
const PROMISE_RE = /\b(guarantee|guaranteed|free of cost|discount|100\s*%)/i;
const digits = (s) => String(s).replace(/[^\d]/g, '');
// -> { ok, reply } or { ok: false, why }
function guard(reply, st, channel, meetingLink) {
  let t = String(reply || '').replace(/\*\*|__|`/g, '').trim();
  if (!t) return { ok: false, why: 'the model wrote nothing' };
  const known = `${st.about}\n${st.pricing}\n${st.faq}`;
  for (const u of t.match(URL_RE) || []) if (!meetingLink || !u.startsWith(meetingLink)) return { ok: false, why: `a link that is not the meeting link (${u})` };
  for (const m of t.match(MONEY_RE) || []) if (!digits(m) || !digits(known).includes(digits(m))) return { ok: false, why: `a money figure that is not in the settings (${m})` };
  if (PROMISE_RE.test(t) && !PROMISE_RE.test(known)) return { ok: false, why: 'a promise the settings do not make' };
  if (t.length > LIMIT[channel]) t = `${t.slice(0, LIMIT[channel] - 1).replace(/\s+\S*$/, '')}…`;
  return { ok: true, reply: t };
}

// ---- sending -----------------------------------------------------------------------------------------------------------------
async function send(channel, lead, body, subject, deps) {
  if (channel === 'Email') {
    if (!lead.email) return { ok: false, error: 'no email on the lead' };
    const mail = deps.sendMail || ((m) => require('../utils/mailer').sendMail({ useEmployeeFrom: false, ...m })); // eslint-disable-line global-require
    const subj = /^re:/i.test(String(subject || '')) ? subject : `Re: ${subject || 'Your message to TeamLink'}`;
    return mail({ to: lead.email, subject: S.clip(subj, 180), text: body });
  }
  if (channel === 'SMS') {
    if (deps.sendSms) return deps.sendSms(lead.phone, body);
    const messaging = require('../utils/messaging'); // eslint-disable-line global-require
    const m = require('../utils/messagingCore').normalizeMobile(lead.phone); // eslint-disable-line global-require
    if (!m.ok) return { ok: false, error: 'the phone number is not usable' };
    // 'bulk' = the SMS channel's Bulk / General DLT template (Administration > Integrations > SMS) and its STOP list; 'text' matched no template
    return messaging.send('SMS', { to: m.e164, kind: 'bulk', text: body, vars: [body] });
  }
  if (deps.sendWa) return deps.sendWa(lead.phone, body);
  // the WhatsApp inbox's own sender: the 24-hour window, opt-outs and the chat screen are all kept (omniwa/agent.js)
  const WA = require('../omniwa/agent'); // eslint-disable-line global-require
  const m = require('../utils/messagingCore').normalizeMobile(lead.phone); // eslint-disable-line global-require
  const conv = m.ok ? await WA.convOf(m.e164.replace(/^\+/, '')) : null;
  if (!conv) return { ok: false, error: 'no WhatsApp chat with this number yet' };
  return WA.sendText(conv, body);
}

// a person takes over: the lead is told, the owner gets a bell and a follow-up, and the AI stays quiet on this lead from now on
async function handoff(lead, channel, why, subject, deps, { tell = true } = {}) {
  const owner = lead.ownerName ? lead.ownerName.split(' ')[0] : 'our team';
  if (tell) {
    const msg = channel === 'Email'
      ? `Hello ${lead.contactName || ''},\n\nThank you for your message. ${owner} from TeamLink will get back to you shortly.\n\nTeamLink Consultants`
      : `Thank you. ${owner} from TeamLink will get back to you shortly.`;
    await send(channel, lead, msg, subject, deps).catch(() => null);
  }
  await note(lead.id, HANDED, why, 'note');
  const to = lead.ownerId ? [lead.ownerId] : (await S.ownerOptions()).filter((o) => o.tl).map((o) => o.id);
  for (const userId of to) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.notification.create({ data: { userId, title: `${lead.company}: the AI passed the talk to you`, message: `${why}\nOpen: /crm/leads?open=lead:${lead.id}`, channel: 'In-App', recipient: `crm-reply|${lead.id}|${Date.now()}`, status: 'Sent' } }).catch(() => {});
  }
  if (lead.ownerId) {
    const iso = new Date(Date.now() + 5.5 * HOUR).toISOString();
    const now = DB.nowIso();
    await S.insert('CrmTask', {
      id: S.newId('task'), title: `Take over from the AI: ${lead.contactName || lead.company}`, dueDate: iso.slice(0, 10), dueTime: iso.slice(11, 16), status: 'Open', type: 'Other',
      notifyApp: 0, notifyWhatsapp: 0, notifySms: 0, notifyLead: 0, remindBefore: 0, reminderSentAt: now, leadId: lead.id, ownerId: lead.ownerId, ownerName: lead.ownerName, createdAt: now, updatedAt: now,
    }).catch(() => null);
  }
  return { handedOver: why };
}

// ---- one answer ----------------------------------------------------------------------------------------------------------
// channel: 'WhatsApp' | 'SMS' | 'Email'; lead: the CrmLead row; message: what they wrote. -> what was done
async function respond({ channel, lead, message, subject }, { deps = {}, now = Date.now() } = {}) {
  const st = await load();
  if (!st.on) return { skipped: 'off' };
  if (!(await open(lead))) return { skipped: 'the lead is not open' };
  if (await handedOver(lead.id)) return { skipped: 'a person has this lead' };
  const today = await DB.one('SELECT COUNT(*) AS n FROM "CrmActivity" WHERE "leadId" = ? AND "byName" = ? AND "at" >= ?', lead.id, AI_NAME, istDayStart(now));
  if (Number(today && today.n) >= st.maxPerDay) return handoff(lead, channel, `More than ${st.maxPerDay} AI answers today: a person should talk now.`, subject, deps);
  const AUTO = require('./autopilot'); // eslint-disable-line global-require
  const auto = await AUTO.load();
  const meetingLink = (auto.meeting && auto.meeting.link) || '';
  const first = !(await DB.one('SELECT "id" FROM "CrmActivity" WHERE "leadId" = ? AND "byName" = ?', lead.id, AI_NAME));
  const booked = await upcomingCall(lead.id, now);
  const product = await productContext(lead).catch(() => null);
  // a bare "ok" / "thanks" / thumbs up: nothing is booked and nothing is pushed; at most a one-line confirmation of the call already booked
  if (ACK_ONLY.test(String(message || ''))) {
    if (!booked) return { skipped: 'an acknowledgement: nothing to answer' };
    const said = await DB.one('SELECT "id" FROM "CrmActivity" WHERE "leadId" = ? AND "byName" = ? AND "note" LIKE ? AND "at" > ?', lead.id, AI_NAME, `%${whenOf(booked)}%`, new Date(now - 6 * HOUR).toISOString());
    if (said) return { skipped: 'an acknowledgement: the booking was already confirmed' };
    const line = channel === 'Email' ? `Hello ${lead.contactName || ''},\n\nThank you. You are booked for ${whenOf(booked)} (India time).\n\nTeamLink` : `Thank you! You are booked for ${whenOf(booked)} (India time).`;
    return deliver(channel, lead, line, subject, deps, 'none');
  }
  let out;
  try {
    // Claude at low effort (short replies, quick), with the refusal fallback; any failure answers with the local model instead
    // (2026-11-23) the same order as the AI meeting (crm/productSales.js askAi): Claude (Integrations > AI Assistant, unless "Use Claude" is off),
    // then the fast AI (Integrations > Fast AI: Groq / Gemini), then the local model - it used to jump from Claude straight to the local model
    const chat = deps.chat || ((sys, msgs) => require('./productSales').askAi(sys, msgs, 'reply')); // eslint-disable-line global-require
    const msgs = await history(lead.id);
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') msgs.push({ role: 'user', content: S.clip(message, 1500) });
    out = await chat(prompt(st, lead, channel, lead.ownerName, { product, booked: booked ? whenOf(booked) : null }), msgs);
  } catch (e) {
    return handoff(lead, channel, `The AI could not answer (${S.clip(e.message, 120)}).`, subject, deps);
  }
  let action = ['meeting', 'handoff', 'not_interested'].includes(out && out.action) ? out.action : 'none';
  if (action === 'handoff') return handoff(lead, channel, `They need a person: "${S.clip(message, 200)}"`, subject, deps);
  if (action === 'not_interested') {
    const g0 = guard(out && out.reply, st, channel, meetingLink);
    if (g0.ok) { await send(channel, lead, g0.reply, subject, deps).catch(() => null); await note(lead.id, `AI answered on ${WORD[channel]}`, g0.reply, KIND[channel]); }
    return handoff(lead, channel, `They said they are not interested: "${S.clip(message, 200)}"`, subject, deps, { tell: false });
  }
  const known = product ? { ...st, about: product.about, pricing: product.pricing, faq: product.faq } : st;
  const g = guard(out && out.reply, known, channel, meetingLink);
  if (!g.ok) return handoff(lead, channel, `The AI answer was not sent: ${g.why}.`, subject, deps);
  // a product lead: a job board, app or integration the product text does not name is not claimed (crm/productSales.js guardClaims)
  const PS = require('./productSales'); // eslint-disable-line global-require
  let body = product ? PS.guardClaims(g.reply, product.knowledge) : g.reply;
  // a product lead asking the price, or a reply that gets GST wrong: the written price answer (exact plan prices, GST 18% on top)
  if (product && (PS.isPriceQuestion(message) || !PS.gstOk(body))) {
    const keys = PS.keysOf(lead.products);
    const prods = (await PS.products()).filter((x) => !keys.length || keys.includes(x.key));
    body = PS.priceAnswer(prods, /[\u0C00-\u0C7F]/.test(String(message || '')) ? 'te-IN' : 'en-IN').replace(/ At the end of this meeting[^.]*\.| ఈ మీటింగ్ చివర్లో[^.]*\.|, and at the end of this meeting you can see the exact price for your team size/g, '');
  }
  const asked = timeAsked(message);
  // one booking at a time: a call already booked is confirmed, never booked again; another time asked for goes to a person to move it
  if (booked && (action === 'meeting' || asked)) {
    body = tidyBookingWords(body);
    if (asked && asked !== booked.dueTime) {
      const stamp = DB.nowIso();
      await S.insert('CrmTask', { id: S.newId('task'), title: `Move the call with ${lead.contactName || lead.company} from ${booked.dueTime} to ${asked} (asked on ${WORD[channel]})`, dueDate: new Date(now + 5.5 * HOUR).toISOString().slice(0, 10), dueTime: new Date(now + 5.5 * HOUR).toISOString().slice(11, 16), status: 'Open', type: 'Call', notifyApp: 1, notifyWhatsapp: 0, notifySms: 0, notifyLead: 0, remindBefore: 0, leadId: lead.id, ownerId: lead.ownerId || null, ownerName: lead.ownerName || null, createdAt: stamp, updatedAt: stamp }).catch(() => null);
      body = `${body} You are booked for ${whenOf(booked)} (India time); I have asked our team to move it to ${asked}, and they will confirm.`.trim();
    } else body = `${body} You are booked for ${whenOf(booked)} (India time).`.trim();
    action = 'none';
  } else if (action === 'meeting') {
    body = tidyBookingWords(body);
    const task = await AUTO.bookMeeting({ leadId: lead.id, name: lead.contactName || lead.company, email: lead.email, ownerId: lead.ownerId, ownerName: lead.ownerName, title: `TeamLink call: ${lead.company}`, at: asked }, auto, now, deps).catch(() => null);
    if (task) body += channel === 'Email' ? `\n\nI have booked a call for ${whenOf(task)}${lead.email ? '; the invite is in your mail' : ''}. If another time suits you better, just reply.` : ` I have booked a call for ${whenOf(task)} (India time). Reply if another time suits you better.`;
  } else body = tidyBookingWords(body) || body;
  if (!body.trim()) body = booked ? `You are booked for ${whenOf(booked)} (India time).` : 'Thank you. Our team will get back to you shortly.';
  if (first) body = channel === 'Email' ? `${body}\n\n(This reply is from TeamLink's AI assistant. A person from our team is copied on everything.)` : `TeamLink's AI assistant: ${body}`;
  if (channel === 'Email') body = `Hello ${lead.contactName || ''},\n\n${body}\n\n${product ? 'TeamLink' : 'TeamLink Consultants'}`;
  return deliver(channel, lead, body, subject, deps, action);
}
// send, and keep the WhatsApp reference so the timeline shows Sent / Delivered / Read / Failed; a failed send is said plainly
async function deliver(channel, lead, body, subject, deps, action) {
  const sent = await send(channel, lead, body, subject, deps).catch((e) => ({ ok: false, error: e.message }));
  if (!sent || !sent.ok) {
    const why = (sent && sent.error) || 'unknown';
    await note(lead.id, `AI answer not sent: ${S.clip(why, 140)}`, body, KIND[channel], { status: 'Failed', detail: why });
    return handoff(lead, channel, `The AI answer could not be sent: ${why}.`, subject, deps, { tell: false });
  }
  await note(lead.id, `AI answered on ${WORD[channel]}`, body, KIND[channel], channel === 'Email' ? null : { providerRef: sent.providerRef || null, status: sent.providerRef ? 'Sent' : null });
  return { answered: true, action, body, providerRef: sent.providerRef || null };
}

module.exports = { DEFAULTS, AI_NAME, HANDED, load, get, save, handles, respond, guard, clean, ACK_ONLY, timeAsked, tidyBookingWords, upcomingCall };
