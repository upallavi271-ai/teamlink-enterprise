// ---------------------------------------------------------------------------
// AI WHATSAPP MARKETING ASSISTANT, PHASE 5: THE SERVICES THE AI MARKETING AGENT (AND ANY OTHER MODULE) MAY CALL (owner 2026-11-25: "Integrations: ... AI Marketing Agent").
//
// The agent does not copy anything of the assistant, it calls these, as the PERSON it runs as (their role, their access: the same checks as the screens). Every service here is INTERNAL:
// it reads, drafts, checks or previews. NOTHING HERE SENDS A MESSAGE, writes to the knowledge base or approves anything: a campaign saved by campaignCreate is only "ready" and a person presses
// Send in WhatsApp > Campaigns; a follow-up draft is text, a person approves it in AI leads; the knowledge base is changed only by a person (a change would alter what customers are told).
// Same guard rails as the screens: every answer comes from the knowledge base word for word (no model), a price only from a Pricing entry, the gate says whether a message could go.
//
//   call(user, name, input) -> { ...data } | { error, status }       describe() -> the list the agent's registry reads
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const { ensure } = require('./schema');

const clip = (v, n) => S.clip(v, n);
const gone = (message, status = 400) => ({ error: message, status });

function mayChat(user) {
  try { const p = require('../outreach/access').pagesFor(user); return p.includes('whatsapp') || p.includes('waai'); } catch { return false; } // eslint-disable-line global-require
}
const mayCamp = (user) => require('./campaign').mayCampaign(user); // eslint-disable-line global-require
// the knowledge base (prices included) is read like the settings screen reads it: an Admin (the WhatsApp AI settings page) or a login with campaign rights; a recruiter's login is not
const mayKnowledge = (user) => { try { return require('../outreach/access').pagesFor(user).includes('waai') || mayCamp(user); } catch { return false; } }; // eslint-disable-line global-require

// the chat of a lead, for a login that may see it: by the CRM lead id or the WhatsApp number
async function convFor(user, { crmLeadId = null, e164 = null } = {}) {
  await ensure();
  const AL = require('./assistLead'); // eslint-disable-line global-require
  const Inbox = require('./inbox'); // eslint-disable-line global-require
  let c = null;
  if (crmLeadId) c = (await S.q('SELECT * FROM "OmniWaConv" WHERE collected LIKE ? LIMIT 20', `%"crmLeadId":"${String(crmLeadId).replace(/[^\w-]/g, '')}"%`)).find((x) => AL.leadOf(x).crmLeadId === String(crmLeadId)) || null;
  else if (e164) c = (await S.q('SELECT * FROM "OmniWaConv" WHERE e164 = ?', String(e164).replace(/\D/g, '')))[0] || null;
  if (!c) return { error: 'There is no WhatsApp chat for this lead.', status: 404 };
  const numbers = await require('../utils/waNumbers').visibleNumberIds(user); // eslint-disable-line global-require
  if (!(await Inbox.leadVisible(user, c, numbers))) return { error: 'This chat is outside your access.', status: 403 };
  return { conv: c };
}

const SERVICES = {
  'assistant.answer': {
    does: 'What a customer would be told for a question, from the knowledge base alone (word for word; a price only from a Pricing entry; "not known" when nothing fits). Nothing is sent.', needs: 'an Admin or campaign rights',
    async run(user, { question, numberId = null } = {}) {
      if (!mayKnowledge(user)) return gone('The knowledge base is for an Admin or a login with campaign rights.', 403);
      const q = clip(question, 500);
      return q ? require('./assist').testQuestion(q, numberId) : gone('Give the question.'); // eslint-disable-line global-require
    },
  },
  'lead.summary': {
    does: 'A lead\'s Hot / Warm / Cold with every reason, what the customer told the assistant, the summary and the next step. Read only.', needs: 'access to that chat',
    async run(user, input = {}) {
      const f = await convFor(user, input); if (f.error) return f;
      const a = await require('./assistLead').assess(f.conv); // eslint-disable-line global-require
      return { band: a.sc.band, score: a.sc.score, reasons: a.sc.reasons, fields: { name: a.lead.name || null, service: a.lead.service || null, requirement: a.lead.requirement || null, budget: a.lead.budget || null, callback: a.lead.callback || null }, summary: a.summary, crmLeadId: a.lead.crmLeadId || null };
    },
  },
  'followup.draft': {
    does: 'The words of follow-up number N for this customer, written from what they told the assistant, and how it would go (text inside 24 hours, otherwise the approved template). Nothing is made or sent.', needs: 'access to that chat',
    async run(user, input = {}) {
      const f = await convFor(user, input); if (f.error) return f;
      const FU = require('./followup'); // eslint-disable-line global-require
      const st = await FU.settings(); const lead = require('./assistLead').leadOf(f.conv); // eslint-disable-line global-require
      const step = Math.max(1, Math.min(st.intervalsHours.length, Math.round(Number(input.step)) || (Number(lead.followStep) || 0) + 1));
      return { step, of: st.intervalsHours.length, text: FU.draftText(step, st.intervalsHours.length, lead), templateSet: !!st.template.name, note: 'A person approves it in WhatsApp > AI leads > Follow-ups waiting; after 24 hours it can only go as the approved template.' };
    },
  },
  'message.canSend': {
    does: 'Whether a message to this customer could go now, and how: the gate\'s answer (stop lists, the 24-hour window, the approved template, consent, quiet hours) with the reason. Nothing is sent.', needs: 'access to that chat',
    async run(user, input = {}) {
      const f = await convFor(user, input); if (f.error) return f;
      const FU = require('./followup'); // eslint-disable-line global-require
      const st = await FU.settings();
      const purpose = input.purpose === 'campaign' ? 'campaign' : 'followup';
      const name = clip(input.templateName, 200).toLowerCase() || st.template.name;
      const g = await require('./gate').check(f.conv, { purpose, template: name ? { name, language: st.template.language || 'en', vars: [] } : null }); // eslint-disable-line global-require
      return { ok: g.ok, via: g.via || null, code: g.code || null, reason: g.reason || null, defer: !!g.defer };
    },
  },
  'campaign.templates': {
    does: 'The WhatsApp templates a campaign may use: approved by Meta, with their words and how many blanks they have.', needs: 'campaign rights',
    async run(user) { return mayCamp(user) ? { templates: await require('./campaign').templates() } : gone('Campaign rights are needed.', 403); }, // eslint-disable-line global-require
  },
  'campaign.audience': {
    does: 'Who a campaign could go to now (only customers whose consent for promotions is recorded) and everyone left out with the reason. Numbers are masked. Nothing is saved.', needs: 'campaign rights',
    async run(user, input = {}) {
      if (!mayCamp(user)) return gone('Campaign rights are needed.', 403);
      const a = await require('./campaign').audience({ bands: input.bands, gapDays: input.gapDays, max: input.max }); // eslint-disable-line global-require
      return { people: a.people.map((p) => ({ leadId: p.leadId, name: p.name, phoneHint: p.phoneHint, band: p.band })), skipped: a.skipped, samples: a.samples, considered: a.considered };
    },
  },
  'campaign.preview': {
    does: 'Every person a campaign would reach with the exact words each would read, and everyone left out with the reason. Nothing is saved or sent.', needs: 'campaign rights',
    async run(user, draft = {}) { return require('./campaign').preview(user, draft); }, // eslint-disable-line global-require
  },
  'campaign.create': {
    does: 'Saves the campaign as READY (the people and their words are frozen as in the preview). NOTHING IS SENT: a person presses Send now or schedules it in WhatsApp > Campaigns.', needs: 'campaign rights, WhatsApp promotions switched on',
    async run(user, draft = {}) { return require('./campaign').create(user, draft); }, // eslint-disable-line global-require
  },
  'analytics.summary': {
    does: 'Real numbers for the last 7, 30 or 90 days: messages sent, delivered, read, enquiries, response times, qualified leads, hand-overs, opt-outs, campaign results. Counts only.', needs: 'an Admin, a team lead or campaign rights',
    async run(user, { days = 30 } = {}) { return require('./analytics').compute(user, { days }); }, // eslint-disable-line global-require
  },
};

/** The list the agent's registry reads: every service is internal (nothing here reaches a real person). */
function describe() { return Object.entries(SERVICES).map(([name, s]) => ({ name, risk: 'internal', does: s.does, needs: s.needs })); }
/** call(user, 'lead.summary', { crmLeadId }) -> data, or { error, status } (never throws) */
async function call(user, name, input = {}) {
  const s = SERVICES[name];
  if (!s) return gone(`There is no WhatsApp assistant service called "${clip(name, 60)}".`, 404);
  if (!user) return gone('A service runs as a person.', 401);
  try { return await s.run(user, input || {}); } catch (e) { return gone(clip((e && e.message) || 'The service failed.', 200), 500); }
}

module.exports = { describe, call, SERVICES };
