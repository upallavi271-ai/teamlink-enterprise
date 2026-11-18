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
    // ENGAGEMENT (2026-11-17): what THEY did counts most - wrote back, opened / played the demo, said they are interested, a meeting held -
    // and a lead that has gone silent loses points week by week. Lines TeamLink writes by itself (stage moves, moved follow-ups) are not contact.
    const subj = (a) => String(a.subject || '');
    const recent = (a, days) => daysSince(a.at) != null && daysSince(a.at) <= days;
    const replies = acts.filter((a) => /^Replied on /.test(subj(a)));
    if (replies.length) add(replies.some((a) => recent(a, 30)) ? 15 : 5, `They replied (${replies.length}x, last on ${subj(replies[0]).replace(/^Replied on /, '')}, ${daysSince(replies[0].at) === 0 ? 'today' : `${daysSince(replies[0].at)} day(s) ago`}).`);
    if (acts.some((a) => /^Interested after the demo/.test(subj(a)))) add(10, 'Pressed "I\'m interested" on the demo.');
    if (acts.some((a) => /^Demo video played/.test(subj(a)))) add(5, 'Played the demo video.');
    else if (acts.some((a) => /^Demo opened/.test(subj(a)))) add(5, 'Opened the demo.');
    const met = acts.some((a) => /^AI meeting held/.test(subj(a)) || (a.kind === 'meeting' && /Meeting held/.test(String(a.note || ''))));
    if (met) add(15, 'A meeting was held.'); else if (acts.some((a) => /^Meeting booked/.test(subj(a)))) add(5, 'A meeting is booked.');
    const touches = acts.filter((a) => !/^(Stage:|Follow-up moved:)/.test(subj(a)));
    const lastTouch = touches.length ? touches[0].at : null;
    const silent = daysSince(lastTouch || row.createdAt);
    if (lastTouch && silent <= 3) add(10, `Recent activity: ${silent === 0 ? 'today' : `${silent} day(s) ago`}.`);
    else if (lastTouch && silent <= 7) add(5, `Activity this week (${silent} days ago).`);
    else if (silent != null && silent > 7) add(-Math.min(30, Math.floor((silent - 7) / 7 + 1) * 5), `Silent for ${silent} days (fewer points every week without contact).`);
    if (!acts.length) { actions.push({ text: 'First call: introduce TeamLink and ask about their current hiring.', urgent: true }); } else if (silent >= st.staleDays) { actions.push({ text: `Follow up: last contact was ${silent} days ago.`, urgent: true }); }
    if (replies.length && recent(replies[0], 2)) actions.push({ text: 'They wrote back: answer them today (Conversation tab).', urgent: true });
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

// 2026-11-18: the free fast model first (utils/fastAi.js: Groq / Gemini / OpenRouter), then the app's own AI - a summary or an answer in
// a second or two instead of minutes on the local model.
async function askModel(system, question, history = []) {
  try {
    const r = await require('../utils/fastAi').chat(system, [...history, { role: 'user', content: question }], { maxTokens: 800 }); // eslint-disable-line global-require
    return { ok: true, text: String(r.text || '').trim(), provider: r.provider, ms: r.ms, note: r.note || '' };
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

// ---- 3. THE MEETING AGENT (2026-11-18): before a client meeting, a prep brief; after it, the notes turned into a summary, next steps
// and a follow-up mail. Both read only the record the login may open (S.detail), and nothing is saved until the person presses Save.
const MEETING_RULES = `${RULES}\nYou are the CRM Meeting Agent for a BDE / salesperson. Reply in the language the person writes in.`;
async function meetingPrep(user, kind, id, { purpose } = {}) {
  const f = await recordFacts(user, kind, id);
  if (f.error) return f.error;
  const st = await SETTINGS.load();
  const ins = insightOf(kind, f.d, st);
  const why = S.clip(purpose, 300);
  const r = await askModel(`${MEETING_RULES}
Write a short MEETING PREP BRIEF for a meeting with this ${kind}${why ? ` (purpose: ${why})` : ''}. Use these headings, each with 1-4 short bullets:
1. Who and where we stand  2. What happened so far  3. Goal for this meeting  4. Questions to ask  5. Objections to expect and how to answer  6. Agenda (10-20 minutes)
Only facts from the record; for advice say it is a suggestion. Never invent a price, number, name or date.`, `FACTS:\n${factsText(kind, f.d)}\nHealth: ${ins.score}/100 (${ins.label}). Suggested actions: ${ins.actions.map((a) => a.text).join(' | ') || 'none'}`);
  return r.ok ? S.okBody({ text: r.text, provider: r.provider, ms: r.ms }) : S.fail(503, r.error);
}

async function meetingNotes(user, kind, id, { notes } = {}) {
  const n = S.clip(notes, 6000);
  if (!n || n.length < 10) return S.fail(400, 'Type or paste what was said in the meeting first.');
  const f = await recordFacts(user, kind, id);
  if (f.error) return f.error;
  let out;
  const fastAi = require('../utils/fastAi'); // eslint-disable-line global-require
  try {
    const r = await fastAi.chat(`${MEETING_RULES}
Turn the salesperson's raw meeting notes into a clean record. Use ONLY what the notes and the facts say; never add a decision, number or date that is not there.
Reply ONLY as JSON: {"summary": "<3-5 short sentences>", "decisions": ["..."], "nextSteps": [{"task": "<what to do>", "due": "YYYY-MM-DD or empty", "owner": "us|client"}], "followUpEmail": "Subject: ...\\n\\n<short email to the client confirming what was agreed>"}
Today is ${S.istToday()}. Turn "next Monday", "in 2 days" etc. into dates from today.

FACTS ABOUT THE RECORD:
${factsText(kind, f.d)}`, [{ role: 'user', content: `MEETING NOTES:\n${n}` }], { json: true, maxTokens: 900 });
    out = require('../utils/ai').parseJsonLoose(r.text); // eslint-disable-line global-require
    if (out) out.provider = r.provider;
  } catch (e) {
    return S.fail(503, (e && e.message) || 'The AI is not available right now.');
  }
  if (!out || typeof out !== 'object') return S.fail(502, 'The AI answer could not be read. Try again.');
  const steps = (Array.isArray(out.nextSteps) ? out.nextSteps : []).slice(0, 8).map((s) => ({
    task: S.clip(s && s.task, 200), due: /^\d{4}-\d{2}-\d{2}$/.test(String(s && s.due)) ? s.due : '', owner: s && s.owner === 'client' ? 'client' : 'us',
  })).filter((s) => s.task);
  return S.okBody({
    summary: S.clip(out.summary, 1500),
    decisions: (Array.isArray(out.decisions) ? out.decisions : []).map((x) => S.clip(x, 300)).filter(Boolean).slice(0, 8),
    nextSteps: steps,
    followUpEmail: S.clip(out.followUpEmail, 3000),
    provider: out.provider,
  });
}

// ---- 4. THE CRM AGENT ("Ask AI", upgraded 2026-11-18): a conversation (the last turns are sent back), today's work, recent activity, and the
// full record of any lead / deal / account the question names - all inside what this login may see.
const ASK_STOP = new Set('which what who when where how many much have has are was were our your you my me all any can please tell show give list about from into this that with the and for deal deals lead leads follow ups follow-ups late today week month year target pipeline open won lost status next last call calls meeting meetings company client clients account accounts value stage should need needs attention far summary summarize enti emi entha ela evaru eppudu cheppu chupinchu kavali undi unnayi'.split(' '));
async function mentionedRecords(user, q) {
  const words = (String(q).toLowerCase().match(/[a-z0-9][a-z0-9&.-]{2,}/g) || []).filter((w) => !ASK_STOP.has(w)).slice(0, 8);
  if (!words.length) return '';
  const hits = [];
  for (const [kind, table, col] of [['lead', 'CrmLead', 'company'], ['account', 'CrmAccount', 'name'], ['deal', 'CrmDeal', 'title']]) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await DB.all(`SELECT "id", "${col}" AS "name" FROM "${table}" WHERE ${words.map(() => `LOWER("${col}") LIKE ?`).join(' OR ')} LIMIT 6`, ...words.map((w) => `%${w}%`)).catch(() => []);
    rows.forEach((x) => { const nm = String(x.name || '').toLowerCase(); hits.push({ kind, id: x.id, s: words.reduce((s, w) => s + (nm.includes(w) ? w.length : 0), 0) }); });
  }
  hits.sort((a, b) => b.s - a.s);
  const out = [];
  for (const h of hits.filter((x) => x.s >= 4).slice(0, 3)) {
    // eslint-disable-next-line no-await-in-loop
    const f = await recordFacts(user, h.kind, h.id); // S.detail: a record this login may not open is skipped
    if (!f.error) out.push(`RECORD (${h.kind}):\n${factsText(h.kind, f.d)}`);
  }
  return out.join('\n\n');
}

async function ask(user, { question, history } = {}) {
  const q = S.clip(question, 1000);
  if (!q) return S.fail(400, 'Ask a question.');
  const hist = (Array.isArray(history) ? history : []).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-8).map((m) => ({ role: m.role, content: S.clip(m.content, 2000) }));
  // the facts: what this login may see, summarised
  const ov = await require('./extra').overview(user, { period: 'month' }); // eslint-disable-line global-require
  const o = ov.body;
  const r = S.roleOf(user);
  const own = S.seesAll(r) ? '1=1' : '"ownerId" = ?';
  const p = S.seesAll(r) ? [] : [user.id];
  const deals = await DB.all(`SELECT d."title", d."stage", d."value", d."probability", d."expectedClose", d."ownerName", a."name" AS "account" FROM "CrmDeal" d LEFT JOIN "CrmAccount" a ON a."id" = d."accountId" WHERE ${own.replace('"ownerId"', 'd."ownerId"')} AND d."stage" NOT IN ('Won', 'Lost') ORDER BY d."value" DESC LIMIT 25`, ...p);
  const tasks = await S.tasks(user, { when: 'overdue' });
  const todayTasks = await S.tasks(user, { when: 'today' }).catch(() => []);
  const upcoming = await S.tasks(user, { when: 'upcoming' }).catch(() => []);
  const leads = await DB.all(`SELECT "company", "contactName", "status", "rating", "source", "city" FROM "CrmLead" WHERE ${own} AND "status" NOT IN ('Converted', 'Junk') ORDER BY "updatedAt" DESC LIMIT 25`, ...p);
  const recent = await DB.all(`SELECT "kind", "subject", "note", "at", "byName" FROM "CrmActivity" WHERE ${own} ORDER BY "at" DESC LIMIT 15`, ...p).catch(() => []);
  const named = await mentionedRecords(user, `${q} ${hist.filter((m) => m.role === 'user').slice(-2).map((m) => m.content).join(' ')}`);
  const facts = [
    `Today: ${S.istToday()}. Scope: ${S.seesAll(r) ? 'the whole sales team' : `only ${user.name || 'me'}`}.`,
    `This month: ${o.cards.leads.value} leads added, revenue won Rs ${Math.round(o.cards.revenue.value)} in ${o.cards.revenue.deals} deals, target Rs ${Math.round(o.cards.target.value)}${o.cards.target.pct != null ? ` (${o.cards.target.pct}% done)` : ''}.`,
    `Open pipeline: ${o.cards.pipeline.open} deals worth Rs ${Math.round(o.cards.pipeline.value)}, likely Rs ${o.cards.pipeline.weighted}. Follow-ups: ${o.cards.followUps.today} today, ${o.cards.followUps.late} late.`,
    'Open deals:', ...deals.map((d) => `- ${d.title} (${d.account || '-'}), ${d.stage} ${d.probability}%, Rs ${Math.round(d.value || 0)}, close ${d.expectedClose || 'not set'}${S.seesAll(r) ? `, owner ${d.ownerName}` : ''}`),
    'Late follow-ups:', ...tasks.slice(0, 15).map((t) => `- ${t.title} on ${t.recordName || '-'} (due ${t.dueDate}${S.seesAll(r) ? `, ${t.ownerName}` : ''})`),
    'Open leads:', ...leads.map((l) => `- ${l.company}${l.contactName ? ` (${l.contactName})` : ''}, ${l.status}${l.rating ? `, ${l.rating}` : ''}${l.source ? `, from ${l.source}` : ''}${l.city ? `, ${l.city}` : ''}`),
    'Follow-ups due today:', ...todayTasks.slice(0, 15).map((t) => `- ${t.dueTime ? `${t.dueTime} ` : ''}${t.title} on ${t.recordName || '-'}${t.type ? ` (${t.type})` : ''}${S.seesAll(r) ? `, ${t.ownerName}` : ''}`),
    'Coming follow-ups and meetings:', ...upcoming.slice(0, 15).map((t) => `- ${t.dueDate}${t.dueTime ? ` ${t.dueTime}` : ''} ${t.title} on ${t.recordName || '-'}${t.type ? ` (${t.type})` : ''}${S.seesAll(r) ? `, ${t.ownerName}` : ''}`),
    'Recent activity:', ...recent.map((a) => `- ${String(a.at || '').slice(0, 10)} ${a.kind}: ${S.clip(a.subject, 100)}${a.note ? ` - ${S.clip(a.note, 140)}` : ''}${S.seesAll(r) && a.byName ? ` (${a.byName})` : ''}`),
    ...(named ? ['', named] : []),
  ].join('\n');
  const res = await askModel(`${RULES}\nYou are the CRM Agent: answer quickly (1-5 short lines or a short list), in the language the salesperson writes in (English, Telugu, Hindi or those written in English letters). For a general sales doubt give short practical advice and say it is general advice.\nAnswer the salesperson's question from these CRM facts:\n${facts}`, q, hist);
  return res.ok ? S.okBody({ text: res.text, provider: res.provider, ms: res.ms, note: res.note }) : S.fail(503, res.error);
}

module.exports = { insight, summary, draftEmail, ask, insightOf, meetingPrep, meetingNotes };
