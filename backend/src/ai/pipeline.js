// ---------------------------------------------------------------------------
// THE AGENT PIPELINE (spec 9). Every action, no exceptions, in this order:
//
//   1 Understand        what was said (words, names, dates, amounts, Telugu-English)
//   2 Identify Module   ATS / HRMS / Accounts
//   3 Identify Action   which registry tool (synonyms; a model only when unsure)
//   4 Check Permission  the logged-in user's own can() + scope (ai/permissions.js)
//   5 Validate          every field present and real; people / jobs / clients
//                       resolved inside the user's scope; questions when unsure
//   6 Apply Rules       the business rules (no double move, balances, stage chain ...)
//   7 Confirm           a Confirm card for high-impact (or, by default, every) change
//   8 Execute           the EXISTING backend route, called as the logged-in user
//   9 Verify            re-read through the same service and check it took
//  10 Audit             one audit row: who, tool, parameters, confirmation, result, "via AI"
//  11 Respond           plain words, with what happened
//
// Each step leaves a result object ({ step, label, ok, status, ms, detail }),
// returned to the screen and written into the audit row. The AI NEVER writes
// to the database: the only write path is tool.execute() -> ctx.api -> a route.
// ---------------------------------------------------------------------------

const engine = require('./intent/engine');
const registry = require('./registry');
const confirmations = require('./confirmations');
const perm = require('./permissions');
const { makeReader, makeApi } = require('./lib/http');
const { ymd } = require('./lib/dates');
const { logAudit } = require('../utils/audit');
const aiAccess = require('../utils/aiAccess');

const STEPS = [
  ['understand', 'Understand'],
  ['module', 'Identify module'],
  ['action', 'Identify action'],
  ['permission', 'Check permission'],
  ['validate', 'Validate'],
  ['rules', 'Apply business rules'],
  ['confirm', 'Confirm if required'],
  ['execute', 'Execute (backend route)'],
  ['verify', 'Verify result'],
  ['audit', 'Audit'],
  ['respond', 'Respond'],
];
const LABEL = Object.fromEntries(STEPS);

class Trace {
  constructor(seed = []) { this.steps = seed.slice(); }
  async run(key, fn) {
    const t0 = Date.now();
    let out;
    try {
      out = await fn();
    } catch (err) {
      this.steps.push({ step: key, label: LABEL[key], ok: false, status: 'failed', ms: Date.now() - t0, detail: `Internal problem: ${String((err && err.message) || err).slice(0, 160)}` });
      throw err;
    }
    const rec = {
      step: key, label: LABEL[key], ok: out.ok !== false, status: out.status || (out.ok === false ? 'stopped' : 'ok'), ms: Date.now() - t0, detail: out.detail || '',
    };
    this.steps.push(rec);
    return out;
  }
  add(key, ok, detail, status) {
    this.steps.push({ step: key, label: LABEL[key], ok, status: status || (ok ? 'ok' : 'stopped'), ms: 0, detail: detail || '' });
  }
  skipped(key, why) { this.steps.push({ step: key, label: LABEL[key], ok: true, status: 'skipped', ms: 0, detail: why }); }
}

// --- The slots a tool reads ---------------------------------------------------------------------
function slotsOf(a, frame, text) {
  const spans = a.nameSpans || [];
  const slots = {
    names: spans.map((s) => s.text),
    spans,
    dates: a.slots.dates,
    time: a.slots.time,
    times: a.slots.times || [],
    amount: a.slots.amount,
    amounts: a.slots.amounts,
    emails: a.slots.emails,
    phones: a.slots.phones,
    codes: a.slots.codes,
    quoted: a.slots.quoted,
    numbers: a.slots.numbers,
    percents: a.slots.percents,
    channels: a.channels,
    stages: a.stages,
    lang: a.lang,
    answers: {},
  };
  if (frame && frame.slots) {
    const old = frame.slots;
    const need = frame.need;
    const merged = { ...slots };
    // arrays: what was said before stays unless the new message says it again
    ['dates', 'amounts', 'emails', 'phones', 'codes', 'quoted', 'numbers', 'percents', 'channels', 'stages'].forEach((k) => {
      merged[k] = (slots[k] && slots[k].length) ? slots[k] : (old[k] || []);
    });
    merged.time = slots.time || old.time || null;
    merged.times = (slots.times && slots.times.length) ? slots.times : (old.times || []);
    merged.amount = slots.amount != null ? slots.amount : (old.amount != null ? old.amount : null);
    merged.lang = slots.lang !== 'en' ? slots.lang : (old.lang || 'en');
    merged.names = slots.names.length && need === 'person' ? slots.names : (old.names || []);
    merged.spans = slots.names.length && need === 'person' ? spans : (old.spans || []);
    if (slots.names.length && need !== 'person' && need !== 'choice') {
      // more names arrive with a non-person answer (a recruiter, a client): keep both
      merged.names = [...(old.names || []), ...slots.names.filter((n) => !(old.names || []).includes(n))];
      merged.spans = [...(old.spans || []), ...spans.filter((s) => !(old.spans || []).some((o) => o.text === s.text))];
    }
    merged.answers = { ...(old.answers || {}) };
    if (need && String(text || '').trim()) merged.answers[need] = String(text).trim();
    if (need === 'person' && !slots.names.length && String(text || '').trim()) {
      merged.names = [String(text).trim()];
      merged.spans = [{ text: String(text).trim(), prev: '', start: 0 }];
    }
    return merged;
  }
  return slots;
}

function frameOf(toolName, input, need) {
  const s = input.slots;
  return {
    tool: toolName,
    need: need || null,
    slots: {
      names: s.names, spans: s.spans, dates: s.dates, time: s.time, times: s.times, amount: s.amount, amounts: s.amounts, emails: s.emails, phones: s.phones,
      codes: s.codes, quoted: s.quoted, numbers: s.numbers, percents: s.percents, channels: s.channels, stages: s.stages, lang: s.lang, answers: s.answers || {},
    },
    choices: input.choices || {},
    text: input.text,
  };
}

function makeCtx(user, auth, extra = {}) {
  const now = new Date();
  return {
    user, auth, now, today: ymd(now), read: makeReader(auth), api: null, ...extra,
  };
}

// --- What the user may be offered -------------------------------------------------------------------
async function usableTools(user, { viewAs = false } = {}) {
  const out = [];
  for (const tool of registry.allTools()) {
    // eslint-disable-next-line no-await-in-loop
    const g = await perm.checkTool(user, tool, { viewAs });
    if (g.ok) out.push(tool);
  }
  return out;
}

const respond = (kind, message, extra = {}) => ({ kind, message, ...extra });

// Examples to show when nothing was understood.
function exampleOptions(tools, n = 5) {
  const out = [];
  tools.forEach((t) => { if (t.status === 'ready' && t.examples[0]) out.push(t.examples[0]); });
  return out.slice(0, n);
}

// --- STEPS 1-7 --------------------------------------------------------------------------------------------------
// run({ user, auth, message, frame, choices, voice, viewAs, llm }) -> response
async function run({
  user, auth, message, frame = null, choices = {}, voice = null, viewAs = false, llm = null,
}) {
  const trace = new Trace();
  const text = String(message || '').trim();
  // What the user already picked earlier in this exchange (which person, which side ...) travels in the frame.
  if (frame && frame.choices) {
    const carried = { ...frame.choices };
    delete carried.__tool;
    choices = { ...carried, ...(choices || {}) };
  }

  // 1 UNDERSTAND
  const u = await trace.run('understand', async () => {
    const a = engine.analyse(text || (frame && frame.text) || '');
    const slots = slotsOf(a, frame, text);
    const bits = [];
    if (a.verbs.size) bits.push(`action: ${[...a.verbs].join('/')}`);
    if (a.objects.size) bits.push(`about: ${[...a.objects].join('/')}`);
    if (a.stages.length) bits.push(`step: ${a.stages.map((s) => s.code).join('/')}`);
    if (slots.dates.length || slots.time) bits.push(`when: ${[...slots.dates, slots.time].filter(Boolean).join(' ')}`);
    if (slots.names.length) bits.push(`names: ${slots.names.join(', ')}`);
    if (a.lang !== 'en') bits.push(a.lang === 'te' ? 'Telugu-English mix' : 'Hindi-English mix');
    return { ok: true, a, slots, detail: bits.join(' · ') || 'nothing recognised yet' };
  });

  // 2-3 MODULE and ACTION
  let toolName = null;
  let ambiguous = null;
  let how = 'words';
  const explicitTool = choices && choices.__tool;
  const act = await trace.run('action', async () => {
    if (explicitTool && registry.getTool(explicitTool)) return { ok: true, tool: explicitTool, detail: `chosen by you: ${explicitTool}` };
    if (frame && frame.tool && registry.getTool(frame.tool)) {
      // A new, clearly different request replaces the old half-finished one.
      const d = text ? engine.decide(u.a) : { confident: false };
      const fresh = !frame.redirected && text && d.confident && d.tool !== frame.tool && text.split(/\s+/).length >= 4;
      if (!fresh) return { ok: true, tool: frame.tool, detail: `carrying on with: ${frame.tool}` };
    }
    const d = engine.decide(u.a);
    if (d.confident) return { ok: true, tool: d.tool, detail: `${d.tool} (${d.rows[0].why.join('; ')})` };
    if (d.ambiguous) { ambiguous = d.candidates; return { ok: false, status: 'unsure', detail: `could be ${d.candidates.join(' or ')}` }; }
    return { ok: false, status: 'unsure', detail: d.candidates.length ? `not sure (${d.candidates[0]}?)` : 'no matching action' };
  });
  toolName = act.tool || null;

  // A model is asked only when the words did not decide it (and one is configured).
  if (!toolName && llm && text) {
    try {
      const guess = await llm(text, user);
      if (guess && guess.tool && registry.getTool(guess.tool)) {
        toolName = guess.tool;
        how = 'model';
        if (guess.slots) {
          const s = u.slots;
          const g = guess.slots;
          if (Array.isArray(g.names) && g.names.length) { s.names = g.names; s.spans = g.names.map((n) => ({ text: n, prev: '', start: 0 })); }
          if (Array.isArray(g.dates) && g.dates.length) s.dates = g.dates;
          if (g.time) s.time = g.time;
          if (g.amount != null) s.amount = g.amount;
          if (Array.isArray(g.stages) && g.stages.length) s.stages = g.stages.map((c) => ({ code: c, afterPrep: true }));
        }
        trace.add('action', true, `the language model suggested ${toolName}; it is checked like any other request`);
      }
    } catch { /* the words path already answered */ }
  }

  const usable = async () => usableTools(user, { viewAs });

  if (!toolName) {
    if (ambiguous) {
      const labels = ambiguous.map((n) => registry.getTool(n)).filter(Boolean);
      return respond('clarify', `I am not sure which you mean: ${labels.map((t) => t.label.toLowerCase()).join(' or ')}?`, {
        options: labels.map((t) => ({ label: t.label, choice: { __tool: t.name } })),
        frame: frameOf(null, { slots: u.slots, choices, text }, null),
        steps: trace.steps,
      });
    }
    const tools = await usable();
    const ex = exampleOptions(tools);
    return respond('unhandled', ex.length
      ? 'I did not understand that as something I can do. Here are some things you can ask me to do:'
      : 'I could not find anything I can do for your login yet.', { options: ex.map((e) => ({ label: e, text: e })), steps: trace.steps });
  }

  const tool = registry.getTool(toolName);
  trace.add('module', true, `${tool.module.toUpperCase()} - ${tool.label}`);

  // 4 PERMISSION
  const g = await trace.run('permission', async () => {
    const r = await perm.checkTool(user, tool, { viewAs });
    return { ...r, ok: r.ok, detail: r.ok ? `allowed for ${perm.roleWords(user)}` : r.message };
  });
  if (!g.ok) {
    await auditDenied(user, tool, g, text, trace.steps);
    return respond('denied', g.message, { tool: tool.name, label: tool.label, code: g.code, steps: trace.steps });
  }

  if (tool.status === 'unavailable') {
    trace.add('validate', false, tool.unavailableReason, 'unavailable');
    return respond('unavailable', `${tool.label}: ${tool.unavailableReason}`, { tool: tool.name, label: tool.label, steps: trace.steps });
  }

  // 5 VALIDATE (reads only)
  const ctx = makeCtx(user, auth, { voice, choices, text });
  const input = { text, slots: u.slots, analysis: u.a, choices: choices || {}, frame };
  const v = await trace.run('validate', async () => {
    const out = await tool.validate(ctx, input);
    if (out.ok) return { ...out, detail: out.summary };
    if (out.clarify) return { ok: false, status: 'question', ...out, detail: out.clarify.question };
    if (out.redirect) return { ok: true, status: 'redirected', ...out, detail: `this is really: ${out.redirect.tool}` };
    return { ok: false, status: 'refused', ...out, detail: out.refuse };
  });
  if (v.redirect) {
    if (explicitTool === v.redirect.tool || (frame && frame.redirected)) {
      return respond('refused', 'I could not work out what to do with that. Please say it again with the details.', { steps: trace.steps });
    }
    const again = await run({
      user, auth, message: text, frame: { ...frameOf(v.redirect.tool, input, null), redirected: true }, choices: { ...choices, ...(v.redirect.choices || {}) }, voice, viewAs, llm: null,
    });
    again.steps = [...trace.steps, ...(again.steps || [])];
    return again;
  }
  if (v.clarify) {
    return respond('clarify', v.clarify.question, {
      options: v.clarify.options, tool: tool.name, label: tool.label, frame: frameOf(tool.name, input, v.clarify.need), steps: trace.steps,
    });
  }
  if (v.refuse) return respond('refused', v.refuse, { tool: tool.name, label: tool.label, steps: trace.steps });

  // 6 BUSINESS RULES
  const r = await trace.run('rules', async () => {
    if (!tool.rules) return { ok: true, status: 'skipped', detail: 'no extra rules for this action' };
    const out = await tool.rules(ctx, v.params);
    return { ...out, detail: out.ok ? (out.message || 'rules satisfied') : out.message };
  });
  if (!r.ok) return respond('refused', r.message, { tool: tool.name, label: tool.label, steps: trace.steps });
  const notes = [...(v.notes || []), ...(r.notes || [])];

  // 7 CONFIRM
  const level = registry.confirmLevel(tool, v.params);
  const lowVoice = aiAccess.isLowConfidence(voice);
  const skip = level === 'never' || (level === 'default' && user.ai && user.ai.executeWithoutConfirm && !lowVoice);
  if (!skip) {
    trace.add('confirm', true, level === 'always' ? `needed: ${tool.impact || 'high-impact change'}` : 'needed: asking before any change');
    const rec = confirmations.create({
      user, tool: tool.name, module: tool.module, params: v.params, display: v.display, summary: v.summary, steps: trace.steps, level, voice,
    });
    return respond('confirm', v.summary, {
      tool: tool.name,
      label: tool.label,
      card: {
        pendingId: rec.id,
        title: v.display.title,
        rows: v.display.rows,
        note: [v.display.note, ...notes].filter(Boolean).join(' '),
        highImpact: level === 'always',
        impact: level === 'always' ? (tool.impact || 'This is a high-impact change.') : null,
        expiresAt: new Date(rec.expiresAt).toISOString(),
        module: tool.module,
        confirmLabel: 'Confirm',
        cancelLabel: 'Cancel',
        heardLow: lowVoice,
      },
      steps: trace.steps,
      how,
    });
  }
  trace.add('confirm', true, level === 'never' ? 'not needed for this action' : 'skipped: your role may act without a confirm card');
  const done = await finish({
    user, auth, tool, params: v.params, display: v.display, summary: v.summary, trace, confirmedBy: 'role setting (no confirm card)', pendingId: null, voice,
  });
  return done;
}

// --- STEPS 8-11 -------------------------------------------------------------------------------------------------
async function finish({
  user, auth, tool, params, display, summary, trace, confirmedBy, pendingId, voice,
}) {
  const ctx = makeCtx(user, auth, { voice });
  ctx.api = makeApi(auth);
  // One key per confirmed action: a route that honours Idempotency-Key (new jobs) can never save it twice.
  ctx.idempotencyKey = `ai-${pendingId || require('crypto').randomBytes(10).toString('hex')}`;

  // 8 EXECUTE - the existing route, as this user
  let exec;
  try {
    exec = await trace.run('execute', async () => {
      const out = await tool.execute(ctx, params);
      return { ...out, ok: !!out.ok, detail: out.message };
    });
  } catch (err) {
    exec = { ok: false, message: 'Something went wrong while doing it. Please check the record before trying again.' };
  }
  // 9 VERIFY - read it back through the same service
  let ver = { ok: false, message: 'Not checked because it did not go through.' };
  if (exec.ok) {
    ctx.api = null; // verification reads only
    try {
      ver = await trace.run('verify', async () => {
        const out = await tool.verify(ctx, params, exec);
        return { ...out, ok: !!out.ok, detail: out.message };
      });
    } catch (err) {
      ver = { ok: false, message: 'I could not read it back to check.' };
    }
  } else {
    trace.skipped('verify', 'nothing to check: the action did not go through');
  }
  // 10 AUDIT
  const auditText = typeof tool.audit === 'function' ? tool.audit(params, exec) : tool.audit;
  await trace.run('audit', async () => {
    await audit({
      user, tool, params, executed: exec.ok, verified: ver.ok, message: exec.message, summary: auditText || summary, confirmedBy, pendingId, steps: trace.steps, voice,
    });
    return { ok: true, detail: 'saved in the audit log as "via AI Agent"' };
  });
  // 11 RESPOND
  const ok = !!exec.ok;
  const verifiedLine = ok ? (ver.ok ? 'I checked it: it is saved.' : `Done, but I could not confirm it by reading it back${ver.message ? ` (${ver.message})` : ''}.`) : '';
  trace.add('respond', true, ok ? 'done' : 'did not go through');
  return respond(ok ? 'done' : 'failed', ok ? `${exec.message || 'Done.'}` : (exec.message || 'That did not go through. Nothing was changed.'), {
    tool: tool.name,
    label: tool.label,
    ok,
    verified: ok ? !!ver.ok : false,
    verifiedMessage: verifiedLine,
    evidence: ver.evidence || null,
    summary,
    display,
    steps: trace.steps,
    pendingId,
    open: exec.open || null,
  });
}

// Press Confirm. ONLY the stored parameters run.
async function confirm({ user, auth, pendingId, viewAs = false }) {
  const claim = confirmations.claim(user, pendingId);
  if (!claim.ok) {
    if (claim.code === 'other_user' && claim.rec) {
      await logAudit({
        userId: user.id, actorName: user.name || user.email || null, action: 'AI_AGENT_DENIED', entity: 'AiAgent', entityId: claim.rec.id,
        toValue: `Tried to confirm another person's pending action (${claim.rec.tool})`, reason: 'via AI Agent - confirmation replay refused',
      });
    }
    // A repeat of a finished confirm gets the first answer back, once more, without running anything.
    if (claim.code === 'already' && claim.rec && claim.rec.result) {
      return { ...claim.rec.result, replayed: true, message: `${claim.rec.result.message || ''} (This was already done - it was not run a second time.)`.trim() };
    }
    return respond(claim.code === 'other_user' ? 'denied' : 'expired', claim.message, { code: claim.code });
  }
  const rec = claim.rec;
  const tool = registry.getTool(rec.tool);
  const trace = new Trace(rec.steps);
  trace.add('confirm', true, 'confirmed by you');
  try {
    if (!tool || tool.status === 'unavailable') {
      confirmations.settle(rec, false, respond('failed', 'That action is not available.'));
      return respond('failed', 'That action is not available.', { steps: trace.steps });
    }
    // Permission and rules are checked AGAIN now: a role or a record may have changed since the card was made.
    const g = await perm.checkTool(user, tool, { viewAs });
    if (!g.ok) {
      const out = respond('denied', g.message, { tool: tool.name, label: tool.label, steps: trace.steps });
      await auditDenied(user, tool, g, `(confirm of ${rec.id})`, trace.steps);
      confirmations.settle(rec, false, out);
      return out;
    }
    const ctx = makeCtx(user, auth);
    const rr = tool.rules ? await tool.rules(ctx, rec.params) : { ok: true };
    if (!rr.ok) {
      const out = respond('refused', rr.message, { tool: tool.name, label: tool.label, steps: trace.steps });
      confirmations.settle(rec, false, out);
      return out;
    }
    const out = await finish({
      user, auth, tool, params: rec.params, display: rec.display, summary: rec.summary, trace, confirmedBy: 'the user pressed Confirm', pendingId: rec.id, voice: rec.voice,
    });
    confirmations.settle(rec, out.kind === 'done', out);
    return out;
  } catch (err) {
    const out = respond('failed', 'Something went wrong. Please check the record before trying again.', { steps: trace.steps });
    confirmations.settle(rec, false, out);
    return out;
  }
}

function cancel({ user, pendingId }) {
  const c = confirmations.cancel(user, pendingId);
  if (!c.ok) return respond(c.code === 'other_user' ? 'denied' : 'expired', c.message);
  return respond('cancelled', 'Cancelled. Nothing was changed.', { pendingId });
}

// --- Audit rows ------------------------------------------------------------------------------------------------------
function brief(obj, max = 1400) {
  let s;
  try { s = JSON.stringify(obj); } catch { s = String(obj); }
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

async function audit({
  user, tool, params, executed, verified, message, summary, confirmedBy, pendingId, steps, voice,
}) {
  await logAudit({
    userId: user.id,
    actorName: user.name || user.email || null,
    action: executed ? 'AI_AGENT_ACTION' : 'AI_AGENT_FAILED',
    entity: 'AiAgent',
    entityId: pendingId || tool.name,
    fromValue: brief({
      tool: tool.name, module: tool.module, params, confirmedBy, verified, voice: voice ? { lang: voice.lang, confidence: voice.confidence } : undefined,
      steps: (steps || []).map((s) => `${s.step}:${s.status}`),
    }),
    toValue: String(summary || message || '').slice(0, 500),
    reason: `via AI Agent - ${tool.label} - ${executed ? 'done' : 'did not go through'}${verified ? ', verified' : ''} - ${confirmedBy}${message ? ` - ${String(message).slice(0, 200)}` : ''}`,
  });
}

async function auditDenied(user, tool, g, text, steps) {
  await logAudit({
    userId: user.id,
    actorName: user.name || user.email || null,
    action: 'AI_AGENT_DENIED',
    entity: 'AiAgent',
    entityId: tool.name,
    fromValue: brief({ tool: tool.name, asked: String(text || '').slice(0, 300), code: g.code, steps: (steps || []).map((s) => `${s.step}:${s.status}`) }),
    toValue: String(g.message || '').slice(0, 400),
    reason: `via AI Agent - refused (${g.code})`,
  });
}

module.exports = {
  run, confirm, cancel, usableTools, STEPS, slotsOf, makeCtx,
};
