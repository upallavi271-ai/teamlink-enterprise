// ---------------------------------------------------------------------------
// CRM > AI ASSISTANT (founder 2026-11-02, from the reference CRM: "Zia - your AI assistant: summarize records, suggest next
// action, predict deals"). Two layers:
//   1. RULES, always there (no model needed, never wrong about the facts): a health score 0-100 for a deal / lead with the
//      reasons, and the next best actions (late follow-up, nothing logged for N days, close date passed, proposal waiting,
//      no decision maker, ...). Shown on every record at once.
//   2. THE LANGUAGE MODEL (utils/ai.js - the local Ollama or Claude, whichever the Admin set up): a short summary of a record,
//      a follow-up email draft, and "Ask AI" questions about my pipeline. Only facts the login may see are sent, and the
//      model is told to use those facts only. When no model is running, the answer says so plainly.
// ---------------------------------------------------------------------------
const DB = require('./schema');
const S = require('./service');
const SETTINGS = require('./settings');

const daysSince = (iso) => (iso ? Math.floor((Date.now() - Date.parse(iso)) / 86400000) : null);

async function recordFacts(user, kind, id) {
  const out = await S.detail(user, kind, id);
  if (out.status !== 200) return { error: out };
  return { d: out.body };
}

// ---- 1. rules ---------------------------------------------------------------------------------------------------------------
function insightOf(kind, d, st) {
  const row = d[kind];
  const today = S.istToday();
  const acts = d.activities || [];
  const open = (d.tasks || []).filter((t) => t.status === 'Open');
  const lateTasks = open.filter((t) => t.dueDate < today);
  const quiet = daysSince(acts[0] ? acts[0].at : row.createdAt);
  const reasons = []; const actions = [];
  let score = 50;
  const add = (pts, why) => { score += pts; reasons.push({ pts, why }); };

  if (kind === 'deal') {
    if (['Won', 'Lost'].includes(row.stage)) {
      return { score: row.stage === 'Won' ? 100 : 0, label: row.stage, reasons: [{ pts: 0, why: `This deal is ${row.stage.toLowerCase()}.` }], actions: row.stage === 'Won' ? [{ text: 'Raise the invoice for this deal (Invoices on the deal) and keep in touch for repeat business.', urgent: false }] : [] };
    }
    score = row.probability || 10;
    reasons.push({ pts: 0, why: `Stage "${row.stage}" starts at ${row.probability}%.` });
    if (quiet != null && quiet <= 3) add(10, `Talked to them ${quiet === 0 ? 'today' : `${quiet} day(s) ago`}.`);
    else if (quiet != null && quiet >= st.staleDays) { add(-20, `Nothing logged for ${quiet} days.`); actions.push({ text: `Call ${d.contact ? d.contact.name : 'the client'} today: nothing has been logged for ${quiet} days.`, urgent: true }); }
    if (lateTasks.length) { add(-10, `${lateTasks.length} follow-up(s) late.`); actions.push({ text: `Do the late follow-up: "${lateTasks[0].title}" (due ${lateTasks[0].dueDate}).`, urgent: true }); }
    if (!open.length) { add(-5, 'No next follow-up set.'); actions.push({ text: 'Set the next follow-up date, so the deal does not go quiet.' }); }
    if (row.expectedClose && row.expectedClose < today) { add(-10, `Expected close (${row.expectedClose}) has passed.`); actions.push({ text: 'Update the expected close date, or move the deal to Won / Lost.', urgent: true }); }
    if (!row.expectedClose) actions.push({ text: 'Add an expected close date (it feeds the forecast).' });
    const dm = (d.contacts || []).some((c) => c.role === 'Decision maker');
    if (dm) add(5, 'A decision maker is in the contacts.'); else { add(-5, 'No decision maker in the contacts.'); actions.push({ text: 'Find and add the decision maker (who signs the agreement) as a contact.' }); }
    if (!row.value) actions.push({ text: 'Fill the deal value: the deal has no value yet.' });
    const stageIdx = SETTINGS.STAGES.indexOf(row.stage);
    if (stageIdx >= 0 && stageIdx < SETTINGS.STAGES.indexOf('Proposal sent') && stageIdx >= SETTINGS.STAGES.indexOf('Requirement discussed')) actions.push({ text: 'The requirement is discussed: send the proposal (Proposals tab) while it is fresh.' });
    if (row.stage === 'Proposal sent') {
      const sentAct = acts.find((a) => /^Proposal .* sent/.test(a.subject || ''));
      const since = sentAct ? daysSince(sentAct.at) : null;
      if (since != null && since >= 3) actions.push({ text: `The proposal went ${since} days ago: call to ask for their decision or questions.`, urgent: since >= 7 });
    }
    if (row.stage === 'Negotiation') actions.push({ text: 'Agree the fee and terms, then mark Won and add them as a client.' });
  } else if (kind === 'lead') {
    if (row.status === 'Converted') return { score: 100, label: 'Converted', reasons: [{ pts: 0, why: 'This lead is a deal now.' }], actions: [] };
    if (row.status === 'Junk') return { score: 0, label: 'Junk', reasons: [{ pts: 0, why: 'Marked junk.' }], actions: [] };
    score = 30;
    if (row.rating === 'Hot') add(25, 'Rated Hot.'); else if (row.rating === 'Warm') add(10, 'Rated Warm.'); else if (row.rating === 'Cold') add(-10, 'Rated Cold.');
    if (row.status === 'Qualified') add(20, 'Qualified.'); else if (row.status === 'Contacted') add(5, 'Contacted.');
    if (row.phone || row.email) add(5, 'Has a phone / email.'); else { add(-10, 'No phone or email.'); actions.push({ text: 'Find the HR / hiring manager\'s phone or email (LinkedIn, the company website).' }); }
    if (['Referral', 'Existing client'].includes(row.source)) add(10, `Came by ${row.source.toLowerCase()}.`);
    if (!acts.length) { actions.push({ text: 'First call: introduce TeamLink and ask about their current hiring.', urgent: true }); } else if (quiet >= st.staleDays) { add(-10, `Nothing logged for ${quiet} days.`); actions.push({ text: `Follow up: last contact was ${quiet} days ago.`, urgent: true }); }
    if (lateTasks.length) { add(-10, `${lateTasks.length} follow-up(s) late.`); actions.push({ text: `Do the late follow-up: "${lateTasks[0].title}".`, urgent: true }); }
    if (row.status === 'Qualified') actions.push({ text: 'They are qualified: convert the lead to a deal and plan the proposal.', urgent: true });
    if (row.status === 'Contacted' && acts.length >= 2) actions.push({ text: 'Two or more conversations: decide Qualified or Junk so the list stays clean.' });
  } else {
    score = 50;
    const openDeals = (d.deals || []).filter((x) => !['Won', 'Lost'].includes(x.stage));
    if (openDeals.length) add(15, `${openDeals.length} open deal(s).`);
    if (row.kind === 'Client') add(15, 'Already a customer.');
    if (quiet != null && quiet >= 30) { add(-15, `Nothing logged for ${quiet} days.`); actions.push({ text: `Check in with ${row.name}: no contact for ${quiet} days - ask about new openings.` }); }
    if (!(d.contacts || []).length) actions.push({ text: 'Add at least one contact (HR / decision maker).' });
    if (row.kind === 'Client' && !openDeals.length) actions.push({ text: 'A client with no open deal: ask about upcoming positions (more business).' });
    if (lateTasks.length) actions.push({ text: `Do the late follow-up: "${lateTasks[0].title}".`, urgent: true });
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  const label = score >= 70 ? 'Strong' : score >= 45 ? 'Fair' : 'At risk';
  return { score, label, reasons, actions: actions.slice(0, 6) };
}

async function insight(user, kind, id) {
  if (!['lead', 'deal', 'account'].includes(kind)) return S.fail(404, 'Nothing to read here.');
  const f = await recordFacts(user, kind, id);
  if (f.error) return f.error;
  const st = await SETTINGS.load();
  let ai = { available: false, provider: null };
  try { const s = await require('../utils/ai').checkStatus(); ai = { available: !!s.available, provider: s.provider, reason: s.available ? null : s.reason }; } catch { /* no model */ } // eslint-disable-line global-require
  return S.okBody({ ...insightOf(kind, f.d, st), ai });
}

// ---- 2. the language model ------------------------------------------------------------------------------------------------------
function factsText(kind, d) {
  const row = d[kind];
  const lines = [];
  if (kind === 'deal') {
    lines.push(`Deal: ${row.title}. Stage: ${row.stage} (${row.probability}%). Value: Rs ${Math.round(row.value || 0)}. Expected close: ${row.expectedClose || 'not set'}. Next step: ${row.nextStep || 'not set'}.`);
    if (d.account) lines.push(`Company: ${d.account.name}${d.account.industry ? `, ${d.account.industry}` : ''}${d.account.city ? `, ${d.account.city}` : ''}.`);
    if (row.openings) lines.push(`Hiring: ${row.openings} openings, average CTC Rs ${row.avgCtc}, our fee ${row.feePercent}%.`);
  } else if (kind === 'lead') {
    lines.push(`Lead: ${row.company}. Status: ${row.status}. Rating: ${row.rating || 'none'}. Source: ${row.source || 'unknown'}. Industry: ${row.industry || '-'}. City: ${row.city || '-'}.`);
    if (row.contactName) lines.push(`Contact: ${row.contactName}${row.designation ? `, ${row.designation}` : ''}.`);
  } else {
    lines.push(`Account: ${row.name} (${row.kind}). Industry: ${row.industry || '-'}. City: ${row.city || '-'}.`);
    (d.deals || []).slice(0, 8).forEach((x) => lines.push(`Deal: ${x.title}, ${x.stage}, Rs ${Math.round(x.value || 0)}.`));
  }
  (d.contacts || []).slice(0, 6).forEach((c) => lines.push(`Person: ${c.name}${c.designation ? `, ${c.designation}` : ''}${c.role ? ` (${c.role})` : ''}.`));
  if (row.notes) lines.push(`Notes: ${String(row.notes).slice(0, 800)}`);
  (d.activities || []).slice(0, 15).forEach((a) => lines.push(`${String(a.at).slice(0, 10)} ${a.kind}: ${a.subject || ''}${a.note ? ` - ${String(a.note).slice(0, 200)}` : ''}`));
  (d.tasks || []).filter((t) => t.status === 'Open').slice(0, 5).forEach((t) => lines.push(`Open follow-up due ${t.dueDate}: ${t.title}`));
  return lines.join('\n');
}

async function askModel(system, question) {
  const ai = require('../utils/ai'); // eslint-disable-line global-require
  try {
    const text = await ai.chat(system, [{ role: 'user', content: question }]);
    return { ok: true, text: String(text || '').trim() };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'The AI is not available right now.' };
  }
}
const RULES = 'You are the sales assistant inside TeamLink CRM (TeamLink Consultants, a recruitment / staffing company in India that earns a fee when candidates it places join a client). Use ONLY the facts given. If something is not in the facts, say you do not know. Be short and practical. Money is in Indian rupees.';

async function summary(user, kind, id) {
  const f = await recordFacts(user, kind, id);
  if (f.error) return f.error;
  const r = await askModel(`${RULES}\nWrite a summary of this record in 4 short bullet points: where it stands, what was said last, the risk, and the next step.`, `FACTS:\n${factsText(kind, f.d)}`);
  return r.ok ? S.okBody({ text: r.text }) : S.fail(503, r.error);
}

async function draftEmail(user, kind, id, { purpose } = {}) {
  const f = await recordFacts(user, kind, id);
  if (f.error) return f.error;
  const why = S.clip(purpose, 200) || 'a polite follow-up that moves the conversation to the next step';
  const r = await askModel(`${RULES}\nWrite a short professional email from ${user.name || 'the salesperson'} of TeamLink Consultants. Purpose: ${why}. Give a "Subject:" line first, then the email. No made-up numbers or promises.`, `FACTS:\n${factsText(kind, f.d)}`);
  return r.ok ? S.okBody({ text: r.text }) : S.fail(503, r.error);
}

async function ask(user, { question } = {}) {
  const q = S.clip(question, 1000);
  if (!q) return S.fail(400, 'Ask a question.');
  // the facts: what this login may see, summarised
  const ov = await require('./extra').overview(user, { period: 'month' }); // eslint-disable-line global-require
  const o = ov.body;
  const r = S.roleOf(user);
  const own = S.seesAll(r) ? '1=1' : '"ownerId" = ?';
  const p = S.seesAll(r) ? [] : [user.id];
  const deals = await DB.all(`SELECT d."title", d."stage", d."value", d."probability", d."expectedClose", d."ownerName", a."name" AS "account" FROM "CrmDeal" d LEFT JOIN "CrmAccount" a ON a."id" = d."accountId" WHERE ${own.replace('"ownerId"', 'd."ownerId"')} AND d."stage" NOT IN ('Won', 'Lost') ORDER BY d."value" DESC LIMIT 25`, ...p);
  const tasks = await S.tasks(user, { when: 'overdue' });
  const leads = await DB.all(`SELECT "company", "status", "rating", "source" FROM "CrmLead" WHERE ${own} AND "status" NOT IN ('Converted', 'Junk') ORDER BY "updatedAt" DESC LIMIT 25`, ...p);
  const facts = [
    `Today: ${S.istToday()}. Scope: ${S.seesAll(r) ? 'the whole sales team' : `only ${user.name || 'me'}`}.`,
    `This month: ${o.cards.leads.value} leads added, revenue won Rs ${Math.round(o.cards.revenue.value)} in ${o.cards.revenue.deals} deals, target Rs ${Math.round(o.cards.target.value)}${o.cards.target.pct != null ? ` (${o.cards.target.pct}% done)` : ''}.`,
    `Open pipeline: ${o.cards.pipeline.open} deals worth Rs ${Math.round(o.cards.pipeline.value)}, likely Rs ${o.cards.pipeline.weighted}. Follow-ups: ${o.cards.followUps.today} today, ${o.cards.followUps.late} late.`,
    'Open deals:', ...deals.map((d) => `- ${d.title} (${d.account || '-'}), ${d.stage} ${d.probability}%, Rs ${Math.round(d.value || 0)}, close ${d.expectedClose || 'not set'}${S.seesAll(r) ? `, owner ${d.ownerName}` : ''}`),
    'Late follow-ups:', ...tasks.slice(0, 15).map((t) => `- ${t.title} on ${t.recordName || '-'} (due ${t.dueDate}${S.seesAll(r) ? `, ${t.ownerName}` : ''})`),
    'Open leads:', ...leads.map((l) => `- ${l.company}, ${l.status}${l.rating ? `, ${l.rating}` : ''}${l.source ? `, from ${l.source}` : ''}`),
  ].join('\n');
  const res = await askModel(`${RULES}\nAnswer the salesperson's question from these CRM facts:\n${facts}`, q);
  return res.ok ? S.okBody({ text: res.text }) : S.fail(503, res.error);
}

module.exports = { insight, summary, draftEmail, ask, insightOf };
