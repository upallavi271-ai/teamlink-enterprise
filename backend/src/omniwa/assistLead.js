// ---------------------------------------------------------------------------
// AI WHATSAPP MARKETING ASSISTANT, PHASE 2: LEADS, THE HOT / WARM / COLD SCORE WITH ITS REASONS, THE SUMMARY AND THE HANDOVER (owner 2026-11-25).
//
// When a customer on a marketing number shows interest, the assistant (omniwa/assist.js reply()) asks, one at a time, for: name, the service, what they need, a budget (only
// when prices are part of the business) and the best time to call. The number is the WhatsApp number itself. Nothing here uses an AI model: the fields are read by code, the
// score is a table of plain signals, the summary is built from facts. A person can read every reason.
//   the lead      saved ONCE in the existing CRM (crm/plus/leadIn.createCaptured, source WhatsApp): duplicate check on the phone, owner by the CRM's own rules, first follow-up, bell;
//                 a number already in the CRM gets a note on the existing lead instead of a second one. The CRM's automatic follow-through is paused on it (nobody asked for mails or SMS).
//   the score     chat signals -> 0-100 -> Hot / Warm / Cold with the same limits as CRM > Lead generation (omni.mk.leadgen), written to the same columns (leadScore, leadBand, leadWhy)
//                 so the CRM screens show it; a rating a person set by hand is never overwritten.
//   the summary   requirement, services, main questions, qualification, next recommended action, from facts.
//   the handover  Hot, a call asked for, a person asked for: the lead's owner gets a bell, or when there is none the Admins; the chat goes to Needs human.
// STOP is never touched here: omniwa/agent.js optOut writes every stop list and crm/autopilot.js onReply marks the lead.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const S = require('../outreach/store');
const G = require('./guard');

const clip = (v, n) => S.clip(v, n);
const HOUR = 3600000;
const DEFAULT_TH = { hot: 65, warm: 40 };

// ---- the state of the collecting, kept on the chat (OmniWaConv.collected.assistLead) -----------------------------------------------------------------
const parseJson = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const leadOf = (conv) => parseJson(conv && conv.collected, {}).assistLead || {};
async function saveLead(conv, patch) {
  const all = parseJson(conv.collected, {});
  const next = { ...(all.assistLead || {}), ...patch };
  conv.collected = JSON.stringify({ ...all, assistLead: next });
  await S.run('UPDATE "OmniWaConv" SET collected = ?, updatedAt = ? WHERE id = ?', conv.collected, Date.now(), conv.id);
  return next;
}

// ---- reading what the customer wrote -------------------------------------------------------------------------------------------------------
const QUESTION = /\?|^\s*(what|how|when|where|why|who|which|do|does|did|can|could|is|are|will|would|price|cost|tell me)\b/i;
const INTEREST = /\b(interested|need|needs|want|wants|looking for|looking to|require|required|requirement|get started|sign ?up|book|appointment|demo|trial|quote|quotation|proposal|call ?back|call me|buy|purchase|hire|subscribe|enrol+|register|proceed|go ahead|kavali|chahiye|cheyali)\b/i;
const JUST_ASKING = /\b(?:want|wanted|like|need) to (?:know|ask|check|see|understand|enquire|inquire|find out)\b/i; // "I want to know your timings" is a question, not a purchase
const URGENT = /\b(urgent|urgently|asap|immediately|right now|today|this week|tomorrow|soon|at once)\b/i;
const NOT_INTERESTED = /\b(not interested|no need|don'?t need|do not need|no thanks|not required|not looking|no requirement|stop calling|not now)\b/i;
const TOO_DEAR = /\b(too (?:expensive|costly|high|much)|expensive|costly|out of (?:my )?budget|can'?t afford|cannot afford)\b/i;
const CALL_WORDS = /\b(demo|meeting|appointment|visit|call me|call back|callback|talk on call|phone me)\b/i;
const SKIP = /^\W*(skip|no|nope|not now|later|not sure|don'?t know|do not know|none|n\/a|na|pass|prefer not|rather not)\W*$/i;
const BAD_NAME = /^(yes|no|ok|okay|hi|hello|hey|thanks|thank you|interested|need|want|looking|price|cost|call|later|skip|not|none|nothing|sure|please|name|my|the|i)\b/i;
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s.'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

const isQuestion = (t) => QUESTION.test(String(t || ''));
const showsInterest = (t) => INTEREST.test(String(t || '')) && !NOT_INTERESTED.test(String(t || '')) && !JUST_ASKING.test(String(t || ''));
function nameFrom(text) {
  const t = String(text || '').trim();
  if (!t || /\d/.test(t) || isQuestion(t)) return null;
  const m = /(?:my name is|i am|i'm|im|this is|it'?s|name\s*[:-]?)\s+([\p{L}][\p{L} .'-]{1,40})/iu.exec(t);
  let cand = (m ? m[1] : t).split(/[,.;\n]| and | from | here | speaking | calling /i)[0].trim();
  if (!/^[\p{L}][\p{L} .'-]{1,40}$/u.test(cand) || BAD_NAME.test(cand)) return null;
  if (cand.split(/\s+/).length > 4) return null;
  cand = titleCase(cand);
  return cand;
}
// -> the value, or null when the message is not an answer to that field
function answerFor(field, text, serviceGuess) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (field === 'name') return nameFrom(t);
  if (field === 'service') return isQuestion(t) && !serviceGuess ? null : (serviceGuess || clip(t.replace(/^(i (?:am|'m) )?(?:interested in|looking for|need|want)\s+/i, ''), 80));
  if (field === 'requirement') return t.split(/\s+/).length >= 3 && !isQuestion(t) ? clip(t, 300) : null;
  if (field === 'budget') return SKIP.test(t) ? 'Not decided' : (/\d|lakh|lac|thousand|crore|\bk\b|flexible|open|any/i.test(t) && t.length <= 80 && !isQuestion(t) ? clip(t, 80) : null);
  if (field === 'callback') return SKIP.test(t) ? 'No preference' : (t.length <= 80 && !isQuestion(t) ? clip(t, 80) : null);
  return null;
}
const QUESTIONS = {
  name: 'May I know your name? I will save your details only so our team can follow up on your enquiry.',
  service: 'Which service are you interested in?',
  requirement: 'Please tell me in a line or two what you need.',
  budget: 'Do you have a budget in mind? You can say skip if you are not sure.',
  callback: 'When is a good time for our team to call you? For example: tomorrow after 5 pm.',
};
const ORDER = ['name', 'service', 'requirement', 'budget', 'callback'];
// the field to ask next: not known, not skipped, asked fewer than twice; budget only when prices are part of the business
function nextField(lead, { needsBudget }) {
  for (const f of ORDER) {
    if (lead[f]) continue; // eslint-disable-line no-continue
    if (f === 'budget' && !needsBudget) continue; // eslint-disable-line no-continue
    if ((lead.skipped || []).includes(f) || ((lead.asked || {})[f] || 0) >= 2) continue; // eslint-disable-line no-continue
    return f;
  }
  return null;
}

// ---- the score: a table of plain signals --------------------------------------------------------------------------------------------------
// msgs = every message of the chat, oldest first: { direction: 'IN' | 'OUT', body, at }. intentsOf = assist.intentsOf (what a message is about).
function signals(msgs, lead = {}, intentsOf = () => []) {
  const inb = msgs.filter((m) => m.direction === 'IN' && m.body);
  const text = inb.map((m) => m.body);
  const gaps = [];
  for (let i = 1; i < msgs.length; i += 1) if (msgs[i].direction === 'IN' && msgs[i - 1].direction === 'OUT') gaps.push(Number(msgs[i].at) - Number(msgs[i - 1].at));
  gaps.sort((a, b) => a - b);
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  return {
    messages: inb.length,
    price: text.some((t) => intentsOf(t).includes('pricing')),
    interest: text.filter(showsInterest).length,
    call: text.some((t) => G.wantsCall(t) || CALL_WORDS.test(t)),
    person: text.some((t) => G.wantsHuman(t)),
    urgent: text.some((t) => URGENT.test(t)),
    no: text.some((t) => NOT_INTERESTED.test(t)),
    dear: text.some((t) => TOO_DEAR.test(t)),
    abusive: text.some((t) => G.isAbusive(t)),
    quick: gaps.length >= 2 && median !== null && median < 5 * 60000,
    lead,
  };
}
function score(sig, th = DEFAULT_TH) {
  const reasons = []; let s = 15;
  const add = (pts, why) => { s += pts; reasons.push({ pts, why }); };
  const l = sig.lead || {};
  if (sig.price) add(15, 'Asked what it costs.');
  if (l.service) add(10, `Asked about a specific service: ${clip(l.service, 40)}.`);
  if (sig.interest) add(15, 'Said they need, want or are looking for something.');
  if (l.requirement && String(l.requirement).length >= 25) add(10, 'Described what they need.');
  if (l.budget && l.budget !== 'Not decided') add(15, `Told us their budget: ${clip(l.budget, 30)}.`);
  if (sig.call) add(20, 'Asked for a call, a demo or a meeting.');
  else if (sig.person) add(10, 'Asked to talk to a person.');
  if (l.callback && l.callback !== 'No preference') add(10, `Gave a time to call: ${clip(l.callback, 30)}.`);
  if (sig.urgent) add(15, 'Wants it soon.');
  if (l.name) add(5, 'Gave their name.');
  if (sig.quick) add(5, 'Answers within minutes.');
  if (sig.messages >= 6) add(10, `Kept talking (${sig.messages} messages).`); else if (sig.messages >= 3) add(5, `Wrote ${sig.messages} messages.`);
  if (sig.dear) add(-10, 'Said it is too expensive.');
  if (sig.no) add(-35, 'Said they are not interested.');
  if (sig.abusive) add(-20, 'Wrote abusive words.');
  s = Math.max(0, Math.min(100, Math.round(s)));
  const band = s >= th.hot ? 'Hot' : s >= th.warm ? 'Warm' : 'Cold';
  return { score: s, band, reasons };
}
async function thresholds() {
  try { const st = await require('../marketing/leadgen').settings(); return { hot: st.hot, warm: st.warm }; } catch { return DEFAULT_TH; } // eslint-disable-line global-require
}

// ---- the summary: facts, no model ------------------------------------------------------------------------------------------------------------
function summary({ lead = {}, sig, sc, stopped = false, mentioned = [] }) {
  const questions = (lead.questions || []).slice(0, 5);
  const unanswered = (lead.unanswered || []).slice(0, 3);
  const when = lead.callback && lead.callback !== 'No preference' ? lead.callback : null;
  let next;
  if (stopped) next = 'Do not contact: they asked us to stop.';
  else if (sig.no) next = 'Close the lead: they said they are not interested.';
  else if (sig.call || sig.person) next = `Call ${when ? `at ${when}` : 'today'}: they asked for a call or a person.`;
  else if (unanswered.length) next = `Answer what the assistant could not: "${unanswered[0]}".`;
  else if (sc.band === 'Hot') next = `Call ${when ? `at ${when}` : 'within the hour'}${lead.service ? ` about ${lead.service}` : ''}.`;
  else if (sc.band === 'Warm') next = `Send details${lead.service ? ` about ${lead.service}` : ''} and follow up in two days.`;
  else next = 'No action needed now. The assistant keeps answering; follow up in a week if they write again.';
  const services = [...new Set([lead.service, ...mentioned].filter(Boolean))].slice(0, 4);
  const out = {
    requirement: lead.requirement || null, services, questions, unanswered, qualification: `${sc.band} (${sc.score})`, reasons: sc.reasons.filter((r) => r.pts > 0).slice(0, 3).map((r) => r.why),
    contact: { name: lead.name || null, callback: lead.callback || null, budget: lead.budget || null }, next,
  };
  out.text = [
    out.requirement ? `Requirement: ${out.requirement}` : '', services.length ? `Interested in: ${services.join(', ')}` : '', questions.length ? `Main questions: ${questions.join(' | ')}` : '',
    `Qualification: ${out.qualification}${out.reasons.length ? ` - ${out.reasons.join(' ')}` : ''}`, lead.budget ? `Budget: ${lead.budget}` : '', when ? `Preferred call time: ${when}` : '', `Next: ${next}`,
  ].filter(Boolean).join('\n');
  return out;
}

// ---- the chat's messages and everything computed from them ------------------------------------------------------------------------------------
async function messages(conv) {
  return (await S.q('SELECT direction, body, at FROM "OmniWaMessage" WHERE convId = ? ORDER BY at ASC LIMIT 400', conv.id)).map((m) => ({ direction: m.direction, body: m.body, at: Number(m.at) }));
}
async function assess(conv, { stopped = false, intentsOf } = {}) {
  const lead = leadOf(conv);
  const msgs = await messages(conv);
  const sig = signals(msgs, lead, intentsOf || require('./assist').intentsOf); // eslint-disable-line global-require
  const sc = score(sig, await thresholds());
  return { lead, sig, sc, summary: summary({ lead, sig, sc, stopped, mentioned: lead.mentioned || [] }) };
}

// ---- the team ---------------------------------------------------------------------------------------------------------------------------------
async function adminIds() {
  const rows = await prisma.user.findMany({ where: { status: 'Active', OR: [{ role: { in: ['SUPER_ADMIN', 'ADMIN'] } }, { atsRole: { in: ['SUPER_ADMIN', 'ADMIN'] } }] }, select: { id: true }, take: 10 }).catch(() => []);
  return rows.map((r) => r.id);
}
// the person in charge of this chat (the chat's owner, or the owner of its CRM lead), else the Admins
async function tellTeam(conv, title, message, { leadOwnerId = null } = {}) {
  let ids = [conv.ownerUserId, leadOwnerId].filter(Boolean);
  if (!ids.length) ids = await adminIds();
  if (!ids.length) return 0;
  await require('../utils/notify').notifyUsers([...new Set(ids)], { title, message, open: '/omni-channel-native' }).catch(() => null); // eslint-disable-line global-require
  return ids.length;
}

// ---- the CRM lead ---------------------------------------------------------------------------------------------------------------------------
async function crmNote(leadId, subject, note) {
  const DB = require('../crm/schema'); const CS = require('../crm/service'); // eslint-disable-line global-require
  const now = DB.nowIso();
  await CS.insert('CrmActivity', { id: CS.newId('act'), kind: 'whatsapp', subject: clip(subject, 200), note: clip(note, 2000), at: now, leadId, byName: 'WhatsApp assistant', createdAt: now }).catch(() => null);
}
const phoneNote = (lead) => [
  lead.service ? `Interested in: ${lead.service}` : '', lead.requirement ? `Needs: ${lead.requirement}` : '', lead.budget ? `Budget: ${lead.budget}` : '', lead.callback ? `Preferred call time: ${lead.callback}` : '', 'Came in through the WhatsApp assistant.',
].filter(Boolean).join('. ');
/**
 * Make (or find) the CRM lead of this chat and write the score on it. Called when the details are complete, or earlier when the customer asks for a call or a person.
 * -> { id, created, band, score, owner } or { skipped }
 */
async function ensureLead(conv, { reason = 'details' } = {}) {
  const lead0 = leadOf(conv);
  await require('../marketing/leadgen').ensureColumns().catch(() => null); // the score columns of CrmLead are made on first use (CRM > Lead generation); the score is written there too // eslint-disable-line global-require
  const a = await assess(conv);
  const { lead, sc } = a;
  const LI = require('../crm/plus/leadIn'); // eslint-disable-line global-require
  const CS = require('../crm/service'); const DB = require('../crm/schema'); // eslint-disable-line global-require
  let id = lead0.crmLeadId || null; let created = false; let ownerId = null; let ownerName = null;
  if (!id) {
    const name = lead.name || '';
    const out = await LI.createCaptured('whatsapp', { name, company: name || `WhatsApp lead ${conv.e164.slice(-4)}`, phone: `+${conv.e164}`, notes: phoneNote(lead), products: lead.service || '' });
    if (!out || !out.body || !out.body.id) return { skipped: (out && out.body && out.body.error) || 'the CRM did not take the lead' };
    id = out.body.id; created = !out.body.duplicate; ownerName = out.body.owner || null;
    if (created) await CS.update('CrmLead', id, { autoPaused: 1, updatedAt: DB.nowIso() }).catch(() => null); // nobody asked for mails, SMS or an AI call: a person follows up
    try { await require('../crm/consent').fromWhatsApp(id, { note: 'Gave their details on WhatsApp after the assistant said they are kept only to follow up on the enquiry.' }); } catch { /* the consent line is a record, never a reason to lose a lead */ } // eslint-disable-line global-require
    await saveLead(conv, { crmLeadId: id, createdAt: Date.now(), band: null });
    if (!created) await crmNote(id, 'Wrote to the WhatsApp assistant', phoneNote(lead));
  }
  const row = await DB.one('SELECT * FROM "CrmLead" WHERE "id" = ?', id);
  if (row) { ownerId = row.ownerId || null; ownerName = row.ownerName || ownerName; }
  // the score goes on the lead when it is ours or not scored yet; a rating a person set by hand stays
  const mine = created || !row || !row.leadScoredAt || /WhatsApp assistant/.test(String(row.leadWhy || ''));
  const prev = leadOf(conv).band || null;
  const now = DB.nowIso();
  // the name came after the lead was made (it was saved when they asked for a call): the lead gets it now
  if (row && lead.name && !row.contactName) await CS.update('CrmLead', id, { contactName: lead.name, ...(/^WhatsApp lead /.test(String(row.company || '')) ? { company: lead.name } : {}), updatedAt: now }).catch(() => null);
  if (row && mine) {
    const data = { leadScore: sc.score, leadBand: sc.band, leadWhy: JSON.stringify(sc.reasons.concat([{ pts: 0, why: 'Scored from the WhatsApp assistant chat (WhatsApp assistant).' }])), leadScoredAt: now, updatedAt: now };
    if (!row.rating || Number(row.leadAuto) === 1) { data.rating = sc.band; data.leadAuto = 1; }
    await CS.update('CrmLead', id, data).catch(() => null);
  }
  if (prev !== sc.band || reason === 'details complete') {
    await crmNote(id, prev !== sc.band ? `WhatsApp assistant scored ${sc.band} (${sc.score})` : `WhatsApp details complete (${sc.band}, ${sc.score})`, [...sc.reasons.map((r) => `${r.pts > 0 ? '+' : ''}${r.pts} ${r.why}`), '', a.summary.text].join('\n'));
    await saveLead(conv, { band: sc.band, score: sc.score });
  }
  return { id, created, band: sc.band, score: sc.score, owner: ownerName, ownerId, rose: prev !== 'Hot' && sc.band === 'Hot' };
}

// ---- handing a lead's chat to a team member -------------------------------------------------------------------------------------------------------
// who may receive it: the CRM sales team and the Admins
async function assignees() {
  const CS = require('../crm/service'); // eslint-disable-line global-require
  const team = (await CS.ownerOptions().catch(() => [])).map((t) => ({ id: t.id, name: t.name }));
  const have = new Set(team.map((t) => t.id));
  const extra = (await adminIds()).filter((id) => !have.has(id));
  const admins = extra.length ? await prisma.user.findMany({ where: { id: { in: extra } }, select: { id: true, name: true } }).catch(() => []) : [];
  return [...team, ...admins.map((u) => ({ id: u.id, name: u.name }))].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
/**
 * The chat goes to this person: they own it, the AI steps back (Give back to AI returns it), they get a bell, and the CRM lead follows. Only an Admin, a team lead or the person who has the chat now.
 * -> { ok } or { error, status }
 */
async function assign(actor, conv, toUserId) {
  const A = require('../outreach/access'); // eslint-disable-line global-require
  const level = A.level(actor);
  if (!(level === 'admin' || ['depthead', 'teamlead'].includes(level) || (conv.ownerUserId && conv.ownerUserId === actor.id))) return { error: 'Only an Admin, a team lead or the person who has this chat can hand it over.', status: 403 };
  if (conv.personType !== 'LEAD') return { error: 'Only a customer lead\'s chat is handed over here.', status: 409 };
  const to = (await assignees()).find((u) => u.id === String(toUserId || ''));
  if (!to) return { error: 'Choose a team member from the list.', status: 400 };
  const now = Date.now();
  await S.run('UPDATE "OmniWaConv" SET ownerUserId = ?, ownerName = ?, mode = \'paused\', pausedByName = ?, state = \'needs_human\', handoffReason = ?, pendingAt = NULL, updatedAt = ? WHERE id = ?', to.id, to.name, to.name, clip(`Handed to ${to.name} by ${actor.name || 'a team member'}`, 200), now, conv.id);
  const lead = leadOf(conv);
  if (lead.crmLeadId) {
    const CS = require('../crm/service'); const DB = require('../crm/schema'); // eslint-disable-line global-require
    await CS.update('CrmLead', lead.crmLeadId, { ownerId: to.id, ownerName: to.name, updatedAt: DB.nowIso() }).catch(() => null);
    await crmNote(lead.crmLeadId, `WhatsApp chat handed to ${to.name}`, `${actor.name || 'A team member'} gave the WhatsApp chat to ${to.name}. The assistant has stepped back.`);
  }
  await require('../utils/notify').notifyUsers([to.id], { title: `${conv.name || `+${conv.e164}`} was handed to you on WhatsApp`, message: `${actor.name || 'A team member'} gave you this chat. Answer in Omni-Channel > Inbox & Replies > WhatsApp.`, open: '/omni-channel-native', exceptUserId: actor.id }).catch(() => null); // eslint-disable-line global-require
  return { ok: true, owner: to };
}

module.exports = { assignees, assign, leadOf, saveLead, isQuestion, showsInterest, nameFrom, answerFor, nextField, signals, score, summary, assess, ensureLead, tellTeam, adminIds, thresholds, QUESTIONS, ORDER, SKIP, NOT_INTERESTED, DEFAULT_TH };
