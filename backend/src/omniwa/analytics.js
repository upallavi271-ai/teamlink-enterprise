// ---------------------------------------------------------------------------
// AI WHATSAPP MARKETING ASSISTANT, PHASE 5: ANALYTICS FROM REAL DATA ONLY (owner 2026-11-25: "messages sent, delivered, read where available, incoming enquiries, response time,
// qualified leads, campaign performance, opt-out rate"; honesty rule: "analytics must show only real delivery numbers").
//
// Everything below is counted from rows that exist (OmniWaMessage with Meta's delivery reports, OmniWaConv, the leads the assistant saved, OmniWaAiRun, OmniWaOptOut and the campaigns).
// A number that cannot be known is null, never zero and never guessed: no percentage without something to divide, no response time without a customer who was answered, "read" only for
// messages Meta reported as read (people whose WhatsApp sends no read receipts never show as read, so read is a floor, and the screen says so).
// Scope: chats on the numbers marked as marketing numbers, plus every campaign message. Who may see it: an Admin, a team lead or a login with campaign rights (counts only: no names, no numbers).
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const { ensure } = require('./schema');

const DAY = 86400000;
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const n = (v) => Number(v) || 0;
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const HANDOFF = ['handoff_tool', 'handoff_asked', 'handoff_abuse', 'handoff_limit', 'call_asked', 'blocked_by_guard', 'model_error', 'send_failed'];
const ANSWERED = ['replied', 'not_interested'];

function mayView(user) {
  try { const A = require('../outreach/access'); const lv = A.level(user); return lv === 'admin' || ['depthead', 'teamlead'].includes(lv) || !!A.has('mayCampaign')(user); } catch { return false; } // eslint-disable-line global-require
}
// how a message we sent is counted
const kindOf = (m) => {
  if (String(m.campaignId || '').startsWith('wmk:')) return 'campaign';
  if (n(m.aiGenerated) === 1) return m.template ? 'followUp' : 'assistant';
  return 'team';
};

/**
 * -> { days, since, empty, messages, enquiries, responseTime, leads, handover, optOuts, campaigns, notes } or { error, status }
 * Times are milliseconds; response time is the wait between a customer's message and the first answer to it.
 */
async function compute(user, { days = 30, now = Date.now() } = {}) {
  await ensure();
  if (!mayView(user)) return { error: 'Analytics are for an Admin, a team lead or a login with campaign rights.', status: 403 };
  const d = [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
  const since = now - d * DAY;
  const Cfg = require('./config'); // eslint-disable-line global-require
  const AL = require('./assistLead'); // eslint-disable-line global-require
  const marketing = await Cfg.marketingNumbers();
  const ph = marketing.map(() => '?').join(',');
  const where = `(${marketing.length ? `numberId IN (${ph}) OR ` : ''}campaignId LIKE 'wmk:%')`;
  const msgs = (await S.q(`SELECT e164, direction, status, aiGenerated, template, campaignId, senderUserId, convId, at FROM "OmniWaMessage" WHERE at >= ? AND at <= ? AND ${where} ORDER BY e164, at ASC LIMIT 20000`, since, now, ...marketing)).map((m) => ({ ...m, at: n(m.at) }));

  // ---- messages we sent, and what Meta reported ----
  const out = msgs.filter((m) => m.direction === 'OUT');
  const by = { assistant: 0, followUp: 0, campaign: 0, team: 0 };
  for (const m of out) by[kindOf(m)] += 1;
  const delivered = out.filter((m) => ['delivered', 'read'].includes(m.status)).length;
  const read = out.filter((m) => m.status === 'read').length;
  const failed = out.filter((m) => m.status === 'failed').length;
  const messages = { sent: out.length, byKind: by, delivered, read, failed, deliveredPct: pct(delivered, out.length), readPct: pct(read, out.length), failedPct: pct(failed, out.length), awaitingReport: out.filter((m) => m.status === 'sent').length };

  // ---- enquiries: customers who began a chat in the window, and what they wrote ----
  const inb = msgs.filter((m) => m.direction === 'IN');
  const writers = new Set(inb.map((m) => m.e164));
  const convs = await S.q(`SELECT id, e164, numberId, createdAt, collected FROM "OmniWaConv" WHERE ${marketing.length ? `numberId IN (${ph})` : '1 = 0'}`, ...marketing);
  const newChats = convs.filter((c) => n(c.createdAt) >= since && n(c.createdAt) <= now);
  const enquiries = { newCustomers: newChats.length, customersWhoWrote: writers.size, messagesReceived: inb.length };

  // ---- response time: the first answer to each message that started a wait ----
  const gaps = { assistant: [], team: [] };
  let cur = null; let waiting = null;
  for (const m of msgs) {
    if (m.e164 !== cur) { cur = m.e164; waiting = null; }
    if (m.direction === 'IN') { if (waiting === null) waiting = m.at; } else if (waiting !== null) {
      const k = kindOf(m);
      if (k === 'assistant' || k === 'team') { gaps[k].push(Math.max(0, m.at - waiting)); waiting = null; } // a follow-up or a campaign is not an answer: the customer is still waiting
    }
  }
  const responseTime = { assistant: { answered: gaps.assistant.length, medianMs: median(gaps.assistant), meanMs: mean(gaps.assistant) }, team: { answered: gaps.team.length, medianMs: median(gaps.team), meanMs: mean(gaps.team) } };

  // ---- leads the assistant saved in the window ----
  const leads = { saved: 0, Hot: 0, Warm: 0, Cold: 0, notScored: 0, qualified: 0, asked: 0 };
  for (const c of await S.q('SELECT collected FROM "OmniWaConv" WHERE collected LIKE \'%"assistLead"%\' LIMIT 5000')) {
    const l = AL.leadOf(c);
    if (l.interestAt && n(l.interestAt) >= since && n(l.interestAt) <= now) leads.asked += 1;
    if (!l.crmLeadId || !l.createdAt || n(l.createdAt) < since || n(l.createdAt) > now) continue; // eslint-disable-line no-continue
    leads.saved += 1; if (l.band) leads[l.band] += 1; else leads.notScored += 1;
  }
  leads.qualified = leads.Hot + leads.Warm;

  // ---- hand-over: what the assistant answered itself and what it passed on ----
  const runs = marketing.length ? await S.q(`SELECT r.outcome FROM "OmniWaAiRun" r JOIN "OmniWaConv" c ON c.id = r.convId WHERE r.at >= ? AND r.at <= ? AND c.numberId IN (${ph})`, since, now, ...marketing) : [];
  const answered = runs.filter((r) => ANSWERED.includes(r.outcome)).length;
  const passed = runs.filter((r) => HANDOFF.includes(r.outcome)).length;
  const handover = { answeredByAssistant: answered, passedToAPerson: passed, passedPct: pct(passed, answered + passed) };

  // ---- opt-outs among the customers we were in touch with ----
  const touched = new Set(msgs.map((m) => m.e164));
  const stops = (await S.q('SELECT e164 FROM "OmniWaOptOut" WHERE at >= ? AND at <= ?', since, now)).map((r) => r.e164).filter((e) => touched.has(e));
  const sentTo = new Set(out.map((m) => m.e164));
  const optOuts = { customersContacted: sentTo.size, optedOut: stops.length, ratePct: pct(stops.length, sentTo.size) };

  // ---- campaigns made in the window ----
  const Camp = require('./campaign'); // eslint-disable-line global-require
  const rows = (await S.q('SELECT id, name, status, createdAt FROM "OmniWaMktCampaign" WHERE createdAt >= ? AND createdAt <= ? ORDER BY createdAt DESC LIMIT 50', since, now)).map((r) => ({ ...r, createdAt: n(r.createdAt) }));
  const list = [];
  const tot = { sent: 0, delivered: 0, read: 0, replied: 0, optedOut: 0, failed: 0 };
  for (const r of rows) { const st = await Camp.stats(r.id); list.push({ id: r.id, name: r.name, status: r.status, createdAt: r.createdAt, sent: st.sent, delivered: st.delivered, read: st.read, replied: st.replied, optedOut: st.optedOut, failed: st.failed, deliveredPct: st.deliveredPct, readPct: st.readPct, repliedPct: st.repliedPct, optedOutPct: st.optedOutPct }); for (const k of Object.keys(tot)) tot[k] += st[k]; } // eslint-disable-line no-await-in-loop
  const campaigns = { count: rows.length, list: list.slice(0, 10), totals: { ...tot, deliveredPct: pct(tot.delivered, tot.sent), readPct: pct(tot.read, tot.sent), repliedPct: pct(tot.replied, tot.sent), optedOutPct: pct(tot.optedOut, tot.sent) } };

  const empty = !msgs.length && !newChats.length && !rows.length;
  return {
    days: d, since, now, empty, marketingNumbers: marketing.length, messages, enquiries, responseTime, leads, handover, optOuts, campaigns,
    notes: [
      'Only chats on numbers marked as marketing numbers, and every campaign message, are counted.',
      'Delivered and read are what Meta reports. "Read" only exists for people whose WhatsApp sends read receipts, so it is a floor, not the whole truth. Messages with no report yet are shown as awaiting a report.',
      'A response time is the wait between a customer\'s message and the first answer to it. Follow-ups and campaigns are not answers. A person\'s answer is counted from the answer typed in this screen.',
      'A figure is empty (a dash) when there is nothing to count it from: nothing is estimated.',
    ],
  };
}

module.exports = { compute, mayView, kindOf, median, pct };
