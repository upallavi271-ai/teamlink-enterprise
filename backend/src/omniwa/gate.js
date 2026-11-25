// ---------------------------------------------------------------------------
// AI WHATSAPP MARKETING ASSISTANT, PHASE 3: THE ONE SEND GATE (owner 2026-11-25: "respect opt-in, template, messaging-window (24 hours) and opt-out rules").
//
// Every message the assistant sends on ITS OWN (a follow-up; later a campaign) asks check() first. It answers "may go, as text" or "may go, as this template" or "must not go, and here is why":
//   1. opt-out      all of the stop lists (the agent's blockState: msg.optout, OmniWaOptOut, bc.dnc, OutreachSuppression) AND the CRM's opt-out list. Always, for every purpose.
//   2. the window   Meta lets a business write free text only inside 24 hours of the customer's last message, on the number they wrote to (Agent.windowOpen).
//   3. outside it   only an approved template, and only to someone who gave their details after being told how they are used (the CRM consent line "Given, WhatsApp", not withdrawn).
//                   The template must be set (Settings > WhatsApp AI > Marketing assistant > Follow-ups) and approved for the sending number's WhatsApp account (outreach/tplWaba guard).
//   4. quiet hours  the platform's quiet hours (Message templates > Limits, 21:00 to 08:00 by default): the message waits, it is not refused.
// The gate sends nothing and writes nothing. A reply to a customer's own message (the assistant answering) does not come through here: agent.sendText already checks stop lists and the window.
// ---------------------------------------------------------------------------
const S = require('../outreach/store');

const clip = (v, n) => S.clip(v, n);
const no = (code, reason, extra = {}) => ({ ok: false, code, reason, ...extra });

async function crmOptedOut(e164) {
  try { return !!(await require('../crm/campaigns').optedOut('whatsapp', `+${e164}`)); } catch { return false; } // eslint-disable-line global-require
}
// the formal line: a CRM lead of this chat with consent Given for WhatsApp / sales follow-up and no later Withdrawn
async function hasConsent(conv) {
  try {
    const id = require('./assistLead').leadOf(conv).crmLeadId; // eslint-disable-line global-require
    if (!id) return false;
    const DB = require('../crm/schema'); // eslint-disable-line global-require
    await require('../crm/plusSchema').ensure(); // eslint-disable-line global-require
    const rows = await DB.all('SELECT "purpose", "status", "at" FROM "CrmConsent" WHERE "kind" = \'lead\' AND "recordId" = ? ORDER BY "at" DESC', id);
    if (!rows.length) return false;
    const latest = new Map();
    for (const r of rows) if (!latest.has(r.purpose)) latest.set(r.purpose, r.status);
    return [...latest.values()].includes('Given') && ![...latest.values()].includes('Withdrawn');
  } catch { return false; }
}
// the approved-template check of the sending number's WhatsApp account. null = go ahead | a sentence
async function templateProblem(conv, name) {
  try {
    const WN = require('../utils/waNumbers'); // eslint-disable-line global-require
    const row = conv.numberId ? await WN.getRow(conv.numberId).catch(() => null) : await WN.defaultRow().catch(() => null);
    if (!row) return null; // the single old connection: Meta itself answers
    const cfg = await WN.configOf(row).catch(() => null);
    const g = await require('../outreach/tplWaba').guard(cfg, name); // eslint-disable-line global-require
    return g ? (g.reason || 'This template is not approved for the sending number.') : null;
  } catch { return null; }
}

/**
 * conv: an OmniWaConv row. opts: { purpose: 'followup' (default) | 'campaign', template: { name, language, vars } | null, now, quiet (default true) }
 * -> { ok: true, via: 'text' } | { ok: true, via: 'template', template } | { ok: false, code, reason, defer? }
 * codes: OPTED_OUT, CHECK_FAILED, NO_TEMPLATE, TEMPLATE_NOT_APPROVED, NO_CONSENT, QUIET_HOURS
 */
async function check(conv, { purpose = 'followup', template = null, now = Date.now(), quiet = true } = {}) {
  const Agent = require('./agent'); // eslint-disable-line global-require
  let blocked;
  try { blocked = await Agent.blockState(conv.e164); } catch { return no('CHECK_FAILED', 'The stop lists could not be checked just now, so nothing is sent. It is tried again later.', { defer: true }); } // fails closed, never open
  if (blocked.blocked) return no('OPTED_OUT', 'They asked us to stop, or the number is on a stop list. Nothing can be sent.');
  if (await crmOptedOut(conv.e164)) return no('OPTED_OUT', 'They are on the CRM opt-out list. Nothing can be sent.');
  const open = await Agent.windowOpen(conv).catch(() => false);
  let out;
  if (open) out = { ok: true, via: 'text' };
  else {
    if (!template || !template.name) return no('NO_TEMPLATE', 'More than 24 hours since their last message, so only an approved template can go, and no follow-up template is set.');
    if (!(await hasConsent(conv))) return no('NO_CONSENT', 'More than 24 hours since their last message: a template needs their recorded consent (they gave their details after being told how they are used), and there is none.');
    const bad = await templateProblem(conv, template.name);
    if (bad) return no('TEMPLATE_NOT_APPROVED', clip(bad, 300));
    out = { ok: true, via: 'template', template };
  }
  if (quiet) {
    const q = await require('../utils/omniRules').quietNow('CAMPAIGN_FOLLOWUP', { at: new Date(now) }).catch(() => null); // eslint-disable-line global-require
    if (q) return no('QUIET_HOURS', q, { defer: true });
  }
  return out;
}

module.exports = { check, hasConsent, crmOptedOut, templateProblem };
