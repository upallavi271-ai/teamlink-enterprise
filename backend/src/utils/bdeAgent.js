// ---------------------------------------------------------------------------
// THE BDE AGENT (founder 2026-11-18: "bde ki matrame oka agent kaavali - bde ki sambandhinchi ey information kavali anna, ey doubts vunna,
// agent ni adigithey ventaney accurate ga answer cheyyali, fast ga quick replies ivvali"; 2026-11-20: "a complete 360-degree research and the
// best, accurate agent that responds quickly").
//
// WHO: a BDE (atsRole BDE), a BDE TL, the Super Admin and Developer logins. Everybody else gets 403 (routes/bdeAgent.js).
// HOW A QUESTION IS ANSWERED (research: docs/BDE-AGENT-RESEARCH.md):
//   1. THE ROUTER IN CODE (utils/bdeAgentRouter.js) answers the common questions at once from exact database numbers in the login's own
//      scope, with a link on every record: agenda, interviews, profiles shared, client feedback, selections, offers, joinings, drops,
//      replacements, invoices, agreements, follow-ups, target, clients, requirements, client health, complaints, NPS, CRM, one client /
//      requirement / candidate (360), "how do I ...". No model is involved, so the numbers cannot be wrong.
//   2. THE FAST MODEL (utils/fastAi.js) only for an open-ended question or advice: it sees a FACTS block built for that question by the code
//      (the router's exact numbers), runs at temperature 0.1, is told to say "not in your data" instead of guessing, and has a hard time
//      limit. An answer that carries a number that is not in the facts is thrown away. When the model is slow, down or refused, the code
//      answer comes back instead: never a 500, never a blank.
// LANGUAGE: the answer is in the language of the question (English, Telugu, Telugu in English letters).
// SPEED: the login's clients / requirements and every code answer are kept 60 s, dropped early when the data changes (utils/bdeAgentRouter.js).
// LIMITED VIEW: a candidate is a name and a step, for every login here; invoice amounts only for the logins that already see them.
// READ-ONLY: it changes nothing.
// ---------------------------------------------------------------------------

const fs = require('fs');
const { isBdeTl } = require('./scope');
const fastAi = require('./fastAi');
const R = require('./bdeAgentRouter');
const L = require('./bdeAgentLang');

// Who may use it: BDE and BDE TL logins, plus (founder 2026-11-18) the Super Admin and Developer logins. Everybody still reads only their
// OWN scope through the scope helpers (a Super Admin sees every client, a Developer only what their login may see).
function isBdeAgentUser(user) {
  if (!user) return false;
  if (String(user.atsRole || '').toUpperCase() === 'BDE') return true;
  if (String(user.role || '').toUpperCase() === 'SUPER_ADMIN' || String(user.atsRole || '').toUpperCase() === 'SUPER_ADMIN') return true;
  if (/develop/i.test(String(user.designation || ''))) return true;
  try { return !!isBdeTl(user); } catch { return false; }
}

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const MODEL_MS = () => Math.max(1000, Number(process.env.BDE_AGENT_MODEL_MS) || 9000);
const MAX_FACT_CHARS = 9000;

// ---- the model (a stub in the sandbox when a test asks for one) ---------------------------------------------------------------------
// BDE_AGENT_AI_STUB_FILE (sandbox / TEST_MODE only): the file holds ok | bad | down | slow. The system prompt the model would have been
// sent is written next to it (<file>.last) so a test can check what the model sees.
function stubMode() {
  const f = process.env.BDE_AGENT_AI_STUB_FILE;
  if (!f || !(process.env.TEST_MODE === '1' || process.env.TEAMLINK_SANDBOX === '1')) return null;
  try { return fs.readFileSync(f, 'utf8').trim() || null; } catch { return null; }
}
async function modelChat(system, messages) {
  const mode = stubMode();
  if (!mode) return fastAi.chat(system, messages, { maxTokens: 600, temperature: 0.1, timeoutMs: Math.min(8000, MODEL_MS()), deadlineMs: MODEL_MS(), fallbackToApp: false });
  try { fs.writeFileSync(`${process.env.BDE_AGENT_AI_STUB_FILE}.last`, system); } catch { /* the test reads it */ }
  if (mode === 'down') throw new fastAi.FastAiError('Stub: no fast AI answered.', 503);
  if (mode === 'slow') { await new Promise((r) => { setTimeout(r, MODEL_MS() + 5000); }); return { text: 'too late', provider: 'Stub', model: 'stub' }; }
  const first = (system.split('\nFACTS')[1] || '').split('\n').find((l) => /^## /.test(l)) || '## nothing';
  if (mode === 'bad') return { text: 'You have 987654 interviews today.', provider: 'Stub', model: 'stub' };
  return { text: `From your TeamLink data: ${first.replace(/^## /, '')}.`, provider: 'Stub', model: 'stub' };
}

// a few model questions a minute per login (the code answers are not limited this way)
const modelHits = new Map();
function modelAllowed(userId) {
  const now = Date.now();
  const list = (modelHits.get(userId) || []).filter((t) => now - t < 60000);
  if (list.length >= 15) return false;
  list.push(now);
  modelHits.set(userId, list);
  return true;
}

const SYSTEM = `You are the BDE Agent inside TeamLink (TeamLink Consultants, an Indian recruitment / staffing company). You help one Business Development Executive with their clients, agreements, requirements, candidates, pending client work and payments.
RULES:
- Answer ONLY from the FACTS below. If the answer is not in the facts, say plainly that it is not in their TeamLink data - never guess.
- Never invent or calculate a number, name, date, fee or amount. Copy numbers exactly as they are written in the facts.
- Be quick and practical: the answer first, in 1-4 short lines or a short list; numbers first; name the records exactly as in the facts.
- Reply in the language and style of the question (English, Telugu, or Telugu written in English letters).
- For a general BDE doubt (how to pitch, how to handle an objection, what to say in a follow-up), give short practical advice for Indian recruitment sales, and say it is general advice.
- A candidate is shown to a BDE by name and progress only: never ask for or mention a candidate's phone, e-mail, address or salary.
- You cannot change anything in TeamLink; name the screen to use (Clients, Requirements, Candidates, Joining, Agreements) when they want to do something.
PROCESS: a client raises a requirement in the client portal -> BDE -> BDE TL -> the department TL ticks the response recipients and POSTS it (the TL posts, not the recruiter). Invoices are raised by Accounts after joining.`;

// ---- text of an answer (for copy, for the chat history, and for the model's facts) ---------------------------------------------------
function answerText(a, { items = true } = {}) {
  const out = [a.title, ...(a.lines || [])];
  if (items) (a.items || []).forEach((i) => out.push(`- ${i.label}${i.sub ? ` - ${i.sub}` : ''}`));
  if (items && a.more) out.push(`(+${a.more} more)`);
  return out.filter(Boolean).join('\n');
}
function factsBlock(answers) {
  let text = answers.map((a) => `## ${a.title}\n${[...(a.lines || []), ...(a.items || []).map((i) => `- ${i.label}${i.sub ? ` - ${i.sub}` : ''}`), a.more ? `(+${a.more} more not listed)` : null].filter(Boolean).join('\n')}`).join('\n\n');
  if (text.length > MAX_FACT_CHARS) text = `${text.slice(0, MAX_FACT_CHARS)}\n(...shortened)`;
  return text;
}
// every number in the model's text must be one the facts (or the question) already hold
function numbersOk(text, facts, question) {
  const have = new Set([...(`${facts} ${question}`.match(/\d+(?:[.,]\d+)*/g) || [])].map((n) => n.replace(/,/g, '')));
  const said = (String(text).replace(/^\s*\d+[.)]\s/gm, '').match(/\d+(?:[.,]\d+)*/g) || []).map((n) => n.replace(/,/g, ''));
  return said.every((n) => have.has(n) || Number(n) <= 10);
}

const ADVICE_TIPS = {
  en: [
    'General advice (not from your data):',
    'A client who has not replied: call before you mail; ask one clear question ("Shall I fix interviews for Tuesday?"), not "any update?".',
    'Send a short WhatsApp after the call with the profile names and the slots you proposed, and log it as a follow-up on the client page.',
    'Fee push-back: offer the guarantee and replacement terms first, a lower fee last; never drop the fee in the first call.',
  ],
  tl: [
    'General advice (mee data nundi kaadu):',
    'Client reply ivvakapothe: mail mundu call cheyandi; "any update?" kakunda oka clear question adagandi ("Tuesday interviews fix cheyyana?").',
    'Call tarvata profile names, slots tho chinna WhatsApp pampandi; client page lo follow-up ga log cheyandi.',
    'Fee taggincha mante: mundu guarantee, replacement terms cheppandi; first call lo fee tagginchakandi.',
  ],
};

async function ask(user, { question, history, fresh } = {}) {
  const q = clip(question, 1000);
  if (!q) return { status: 400, body: { error: 'Ask a question.' } };
  const t0 = Date.now();
  let routed;
  try {
    routed = await R.route(user, q, { fresh: !!fresh });
  } catch (err) {
    console.error('[bde-agent] route', err); // eslint-disable-line no-console
    return { status: 200, body: { text: 'I could not read your data just now. Please ask again in a moment.', answers: [], facts: [], source: 'code', intent: 'error', ms: Date.now() - t0 } };
  }
  const lang = routed.lang || L.langOf(q);
  if (routed.kind === 'code') {
    return { status: 200, body: { text: routed.answers.map((a) => answerText(a)).join('\n\n'), answers: routed.answers, facts: routed.answers.flatMap((a) => a.facts || []), source: 'code', intent: routed.answers.map((a) => a.intent).join('+'), lang, cached: !!routed.cached, ms: Date.now() - t0 } };
  }

  // open-ended / advice: the facts for THIS question, built by the code
  const ctx = await R.contextOf(user);
  const support = [];
  if (routed.record && routed.record.x && !routed.record.ties) {
    const rec = routed.record;
    const a = rec.kind === 'client' ? await R.client360(ctx, rec.x, lang) : rec.kind === 'requirement' ? await R.requirement360(ctx, rec.x, lang) : await R.candidate360(ctx, rec.x.id, lang);
    if (a) support.push(a);
  }
  const norm = L.normalize(q);
  for (const t of (routed.topics || []).slice(0, 2)) { // eslint-disable-line no-restricted-syntax
    const [fn, def] = R.RUN[t];
    const f = routed.record && routed.record.kind === 'client' ? { clientId: routed.record.x.id, name: routed.record.x.name } : null;
    // eslint-disable-next-line no-await-in-loop
    support.push(await fn(ctx, L.periodOf(norm, def, ctx.today), lang, t === 'clients' ? null : f, norm));
  }
  const summary = support.length >= 2 ? [] : await R.summaryFacts(ctx, lang);
  const used = [...support, ...summary];
  const facts = factsBlock(used);
  const head = `Today: ${ctx.today} (India time). Asking: ${user.name || 'a BDE'} (${{ admin: 'Super Admin, the whole company', bdetl: 'BDE team lead, every client', bde: 'BDE, their own clients', other: 'their own scope' }[ctx.role]}). Money in Indian rupees.`;
  const system = `${SYSTEM}\n\n${head}\nFACTS (exact numbers from TeamLink):\n${facts}`;
  const hist = (Array.isArray(history) ? history : []).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-6).map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }));
  const factLines = [...used.flatMap((a) => a.facts || [])].filter((v, i, arr) => arr.indexOf(v) === i);
  const codeFallback = (why) => {
    const lead = routed.kind === 'advice' ? (ADVICE_TIPS[lang] || ADVICE_TIPS.en) : [];
    const shown = support.length ? support : summary.slice(0, 1);
    const note = { en: 'The AI could not give a longer answer just now; here are your exact numbers.', tl: 'AI ippudu pedda answer ivvaledu; mee exact numbers ivi.', te: 'AI ఇప్పుడు పెద్ద సమాధానం ఇవ్వలేదు; మీ ఖచ్చితమైన సంఖ్యలు ఇవి.' };
    return {
      status: 200,
      body: {
        text: [...lead, L.say(lang, note), ...shown.map((a) => answerText(a))].join('\n\n'), lead, note: L.say(lang, note), answers: shown, facts: factLines, source: 'code', fallback: why, intent: routed.kind, lang, ms: Date.now() - t0,
      },
    };
  };
  if (!modelAllowed(user.id)) return codeFallback('limit');
  try {
    const r = await Promise.race([
      modelChat(system, [...hist, { role: 'user', content: q }]),
      new Promise((_, rej) => { setTimeout(() => rej(Object.assign(new Error('The AI took too long.'), { status: 504 })), MODEL_MS()); }),
    ]);
    const text = String((r && r.text) || '').trim();
    if (!text) return codeFallback('empty');
    if (!numbersOk(text, `${head}\n${facts}`, q)) return codeFallback('number-check');
    return {
      status: 200,
      body: {
        text, answers: support.map((a) => ({ ...a, lines: [], title: a.title })), facts: factLines, factsText: facts, source: 'model', provider: r.provider, model: r.model, note: r.note || '', intent: routed.kind, lang, ms: Date.now() - t0,
      },
    };
  } catch (err) {
    return codeFallback((err && err.message) || 'model');
  }
}

// the panel's header numbers and the question chips for this login
async function overview(user) {
  const ctx = await R.contextOf(user);
  const LIVE = require('./atsVocab').REQUIREMENT_LIVE_STATUSES; // eslint-disable-line global-require
  const st = await fastAi.status().catch(() => ({ ready: false }));
  const unsigned = ctx.clients.filter((c) => !require('./atsVocab').agreementIsSigned(c.agreementStatus)).length; // eslint-disable-line global-require
  const chips = [
    "What is pending today?", "Today's interviews", 'Pending client feedback', 'Profiles shared this week', 'Follow-ups due', 'Joinings this month',
    'Replacements due', 'Overdue invoices', 'Agreements expiring in 30 days', 'Agreements not signed',
    ...(ctx.role === 'bde' ? ['My target this month'] : ['Clients with no activity']),
    ...(ctx.billing ? ['Pending invoice amount'] : []),
    'How do I raise a requirement?',
  ];
  return {
    status: 200,
    body: {
      clients: ctx.clients.length, openRequirements: ctx.reqs.filter((r) => LIVE.includes(r.status)).length, unsignedAgreements: unsigned,
      role: ctx.role, chips, aiReady: !!st.ready || !!stubMode(), fastReady: !!st.fastReady || !!stubMode(),
    },
  };
}

// kept for callers of the old helper: the exact summary facts the model is given for an open-ended question
async function factsFor(user) {
  const ctx = await R.contextOf(user);
  return { at: ctx.at, facts: factsBlock(await R.summaryFacts(ctx, 'en')) };
}

module.exports = { isBdeAgentUser, ask, overview, factsFor, answerText, numbersOk };
