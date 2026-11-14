// ---------------------------------------------------------------------------
// AI MARKETING > WORKFLOW AUTOMATION = JOURNEYS (module 5; 2026-11-14). A marketing-to-sales journey for CRM leads: an EVENT starts it, then steps run one after another, with IF / THEN / ELSE branching,
// and one step where the AI WRITES a message for that lead and a PERSON APPROVES it before anything is sent.
//   events     new lead · lead scored Hot (Lead generation) · lead moved to a stage · lead idle for N days (nobody has logged anything). Only leads that match AFTER the journey is switched on are
//              taken (an idle journey looks at open leads that have been quiet for N days, at most 20 a minute and 30 a day).
//   steps      wait N hours/days · IF (up to 3 conditions, all must hold) THEN steps ELSE steps (one level, no IF inside a branch) · make a follow-up task for the owner · tell somebody in the app ·
//              give the lead to somebody (or the next in turn) · set the Hot / Warm / Cold rating · AI message · end. At most 12 steps in all.
//   AI message the AI writes a short WhatsApp / email for THIS lead from what the CRM knows (no invented prices, dates or promises). It becomes a DRAFT shown to the lead's owner (and any manager); the
//              journey WAITS. Approve (you may edit it first) sends it, Reject skips it; a draft nobody answers in 3 days expires and is skipped. NOTHING is ever sent without a person pressing Approve.
//              The send obeys opt-outs (CrmOptOut), needs a real phone or email, and every message ends with "Reply STOP to stop these messages". It is written on the lead's timeline.
//   safety     journeys are OFF until a Sales manager or an Admin switches each one on. A lead that is closed (Won, Lost, Junk, Converted) leaves every journey. A lead is in a journey once, ever.
//              Sample records are never taken. The engine ticks once a minute (never in the test sandbox: a test calls it) and does at most 12 steps for one lead in one pass.
// Tables (self-provisioned): OmniMkJourney, OmniMkJourneyRun, OmniMkJourneyLog, OmniMkJourneyDraft. Every AI call goes through marketing/ai.js (module 'journeys', counted against the journey maker's daily AI limit).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const DB = require('../crm/schema');
const S = require('../crm/service');
const AI = require('./ai');
const Cfg = require('./settings');

const J = 'OmniMkJourney'; const R = 'OmniMkJourneyRun'; const G = 'OmniMkJourneyLog'; const D = 'OmniMkJourneyDraft';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${J}" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "triggerKind" TEXT NOT NULL, "triggerOpt" TEXT NOT NULL DEFAULT '{}', "steps" TEXT NOT NULL DEFAULT '[]', "status" TEXT NOT NULL DEFAULT 'off', "armedAt" TEXT, "createdById" TEXT, "createdByName" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL, "deletedAt" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "${R}" ("id" TEXT NOT NULL PRIMARY KEY, "journeyId" TEXT NOT NULL, "leadId" TEXT NOT NULL, "cursor" TEXT NOT NULL DEFAULT '[0]', "nextAt" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'running', "stopReason" TEXT, "tries" INTEGER NOT NULL DEFAULT 0, "startedAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "${R}_once" ON "${R}"("journeyId", "leadId")`,
  `CREATE INDEX IF NOT EXISTS "${R}_due" ON "${R}"("status", "nextAt")`,
  `CREATE TABLE IF NOT EXISTS "${G}" ("id" TEXT NOT NULL PRIMARY KEY, "runId" TEXT, "journeyId" TEXT, "leadId" TEXT, "at" TEXT NOT NULL, "kind" TEXT NOT NULL, "text" TEXT)`,
  `CREATE INDEX IF NOT EXISTS "${G}_run" ON "${G}"("runId", "at")`,
  `CREATE TABLE IF NOT EXISTS "${D}" ("id" TEXT NOT NULL PRIMARY KEY, "runId" TEXT NOT NULL, "journeyId" TEXT NOT NULL, "leadId" TEXT NOT NULL, "channel" TEXT NOT NULL, "subject" TEXT, "body" TEXT NOT NULL, "goal" TEXT, "forUserId" TEXT, "status" TEXT NOT NULL DEFAULT 'waiting', "aiNote" TEXT, "result" TEXT, "createdAt" TEXT NOT NULL, "decidedAt" TEXT, "decidedByName" TEXT)`,
  `CREATE INDEX IF NOT EXISTS "${D}_open" ON "${D}"("status", "forUserId")`,
];
let ensured = null;
// the lead-score columns of CrmLead (a journey reads the score band) are made by Lead generation; make sure they exist before anything here runs
const ensure = () => { if (!ensured) ensured = (async () => { await DB.ensure(); await require('./leadgen').ensureColumns(); for (const sql of DDL) await DB.run(sql); return true; })().catch((e) => { ensured = null; throw e; }); return ensured; }; // eslint-disable-line no-await-in-loop, global-require

const TRIGGERS = {
  new_lead: 'A new lead arrives', hot_lead: 'A lead is scored Hot', stage_change: 'A lead moves to a stage', idle_lead: 'A lead has had no activity for some days',
};
const MAX_STEPS = 12; const MAX_PER_TICK = 20; const DAILY_CAP = 30; const DRAFT_DAYS = 3; const MAX_TRIES = 6;
const STEP_KINDS = ['wait', 'if', 'task', 'notify', 'assign', 'rate', 'ai_message', 'end'];
const FIELDS = { band: 'The score is', score: 'The score is at least', source: 'The source contains', stage: 'The stage is', owner: 'The lead', phone: 'The phone number', email: 'The email address', touched: 'Somebody has logged work on it', industry: 'The industry contains', city: 'The city is', age: 'It is older than (days)' };
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const iso = () => new Date().toISOString();
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const digits = (s) => String(s || '').replace(/\D/g, '');
const sourceOf = (l) => `${l.utmSource || ''} ${l.source || ''}`.trim().toLowerCase();
const isSample = (l) => /^sample\b/i.test(String(l.company || ''));
const closed = (l) => !l || ['Junk', 'Converted'].includes(l.status) || ['Won', 'Lost'].includes(l.stage);
const manager = (u) => S.mayAssign(S.roleOf(u));

// ---- cleaning what a person builds ------------------------------------------------------------------------------------------------------------------------------
function cleanConds(raw) {
  const out = [];
  for (const c of (Array.isArray(raw) ? raw : []).slice(0, 3)) {
    const field = String(c && c.field); if (!FIELDS[field]) continue; // eslint-disable-line no-continue
    const value = clip(c && c.value, 80);
    if (['band'].includes(field) && !['Hot', 'Warm', 'Cold'].includes(value)) continue; // eslint-disable-line no-continue
    if (['score', 'age'].includes(field) && !Number.isFinite(Number(value))) continue; // eslint-disable-line no-continue
    if (['owner'].includes(field) && !['has', 'none'].includes(value)) continue; // eslint-disable-line no-continue
    if (['phone', 'email'].includes(field) && !['yes', 'no'].includes(value)) continue; // eslint-disable-line no-continue
    if (['touched'].includes(field) && !['yes', 'no'].includes(value)) continue; // eslint-disable-line no-continue
    if (['source', 'stage', 'industry', 'city'].includes(field) && !value) continue; // eslint-disable-line no-continue
    out.push({ field, value });
  }
  return out;
}
function cleanStep(s, inBranch) {
  const kind = String(s && s.kind);
  if (!STEP_KINDS.includes(kind) || (inBranch && kind === 'if')) return null;
  if (kind === 'wait') { const h = Number(s.hours); return Number.isFinite(h) && h > 0 && h <= 24 * 60 ? { kind, hours: Math.round(h * 10) / 10 } : { error: 'A wait needs a time between a little and 60 days.' }; }
  if (kind === 'if') {
    const conds = cleanConds(s.conds);
    if (!conds.length) return { error: 'An IF step needs at least one condition.' };
    const sub = (a) => (Array.isArray(a) ? a : []).map((x) => cleanStep(x, true));
    const bad = [...sub(s.then), ...sub(s.else)].find((x) => x && x.error); if (bad) return bad;
    const then = sub(s.then).filter(Boolean); const els = sub(s.else).filter(Boolean);
    if (!then.length && !els.length) return { error: 'An IF step needs something to do in THEN or in ELSE.' };
    return { kind, conds, then, else: els };
  }
  if (kind === 'task') { const title = clip(s.title, 120); if (title.length < 3) return { error: 'A follow-up task needs a title.' }; const d = Math.max(0, Math.min(30, Math.floor(Number(s.dueDays)) || 0)); return { kind, title, dueDays: d, type: ['Call', 'WhatsApp', 'Email', 'Meeting', 'Visit', 'Other'].includes(s.type) ? s.type : 'Call', priority: ['High', 'Medium', 'Low'].includes(s.priority) ? s.priority : 'Medium' }; }
  if (kind === 'notify') { const msg = clip(s.message, 300); if (msg.length < 3) return { error: 'A notice needs words.' }; return { kind, to: clip(s.to, 60) || 'owner', message: msg }; }
  if (kind === 'assign') return { kind, to: clip(s.to, 60) || 'turn', onlyIfEmpty: s.onlyIfEmpty !== false };
  if (kind === 'rate') return ['Hot', 'Warm', 'Cold'].includes(s.rating) ? { kind, rating: s.rating, onlyIfEmpty: s.onlyIfEmpty === true } : { error: 'Pick Hot, Warm or Cold.' };
  if (kind === 'ai_message') { const goal = clip(s.goal, 300); if (goal.length < 8) return { error: 'Tell the AI what the message should do (at least a few words), for example: thank them and ask for a good time to talk.' }; return { kind, goal, channel: ['whatsapp', 'email', 'auto'].includes(s.channel) ? s.channel : 'auto' }; }
  return { kind: 'end' };
}
function cleanSteps(raw) {
  const out = [];
  for (const s of (Array.isArray(raw) ? raw : []).slice(0, MAX_STEPS)) {
    const c = cleanStep(s, false);
    if (!c) continue; // eslint-disable-line no-continue
    if (c.error) return { error: c.error };
    out.push(c);
  }
  if (!out.length) return { error: 'Add at least one step.' };
  const count = out.reduce((n, s) => n + 1 + (s.kind === 'if' ? s.then.length + s.else.length : 0), 0);
  if (count > MAX_STEPS) return { error: `A journey can have ${MAX_STEPS} steps in all (including the ones inside IF). This one has ${count}.` };
  return { steps: out };
}
function cleanTrigger(kind, opt = {}) {
  if (!TRIGGERS[kind]) return { error: 'Pick what starts the journey.' };
  const o = {};
  if (kind === 'new_lead' || kind === 'hot_lead') o.sources = (Array.isArray(opt.sources) ? opt.sources : String(opt.sources || '').split(',')).map((x) => clip(x, 40)).filter(Boolean).slice(0, 8);
  if (kind === 'stage_change') { o.stage = clip(opt.stage, 40); if (!o.stage) return { error: 'Pick the stage that starts the journey.' }; }
  if (kind === 'idle_lead') { const d = Math.floor(Number(opt.days)); if (!Number.isFinite(d) || d < 1 || d > 90) return { error: 'Quiet days must be from 1 to 90.' }; o.days = d; }
  return { kind, opt: o };
}

// ---- conditions ---------------------------------------------------------------------------------------------------------------------------------------------------
async function touched(leadId) { return !!(await DB.one('SELECT "id" FROM "CrmActivity" WHERE "leadId" = ? AND "byName" NOT IN (\'Lead scoring\', \'Journey\', \'Website form\') LIMIT 1', leadId)); }
async function holds(lead, conds) {
  for (const c of conds) {
    const v = String(c.value).toLowerCase(); let ok = false;
    switch (c.field) {
      case 'band': ok = String(lead.leadBand || lead.rating || '') === c.value; break;
      case 'score': ok = lead.leadScore != null && Number(lead.leadScore) >= Number(c.value); break;
      case 'source': ok = sourceOf(lead).includes(v); break;
      case 'stage': ok = String(lead.stage || '').toLowerCase() === v; break;
      case 'owner': ok = c.value === 'has' ? !!lead.ownerId : !lead.ownerId; break;
      case 'phone': ok = (digits(lead.phone).length >= 10) === (c.value === 'yes'); break;
      case 'email': ok = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(lead.email || '')) === (c.value === 'yes'); break;
      case 'touched': ok = (await touched(lead.id)) === (c.value === 'yes'); break; // eslint-disable-line no-await-in-loop
      case 'industry': ok = String(lead.industry || '').toLowerCase().includes(v); break;
      case 'city': ok = String(lead.city || '').toLowerCase() === v; break;
      case 'age': ok = Date.now() - Date.parse(lead.createdAt) >= Number(c.value) * 86400000; break;
      default: ok = false;
    }
    if (!ok) return false;
  }
  return true;
}

// ---- the cursor: [3] is top-level step 3; [2, 'then', 1] is the second step in THEN of step 2 ------------------------------------------------------------------------
const stepAt = (steps, cur) => (cur.length === 1 ? steps[cur[0]] : (steps[cur[0]] && steps[cur[0]][cur[1]] ? steps[cur[0]][cur[1]][cur[2]] : undefined));
function nextCursor(steps, cur) {
  if (cur.length === 1) return [cur[0] + 1];
  const branch = steps[cur[0]][cur[1]];
  return cur[2] + 1 < branch.length ? [cur[0], cur[1], cur[2] + 1] : [cur[0] + 1];
}
const done = (steps, cur) => cur[0] >= steps.length;
const fill = (text, lead, owner) => String(text || '').replace(/\{\{\s*(company|name|owner)\s*\}\}/g, (m, k) => ({ company: lead.company || '', name: String(lead.contactName || '').trim().split(/\s+/)[0] || 'there', owner: owner || lead.ownerName || 'our team' }[k]));
const logIt = (run, kind, text) => DB.run(`INSERT INTO "${G}" ("id", "runId", "journeyId", "leadId", "at", "kind", "text") VALUES (?,?,?,?,?,?,?)`, S.newId('jl'), run.id, run.journeyId, run.leadId, iso(), kind, clip(text, 500));

// ---- the AI draft -------------------------------------------------------------------------------------------------------------------------------------------------------
function demoDraft(lead, step, brand, channel) {
  const name = String(lead.contactName || '').trim().split(/\s+/)[0] || 'there';
  const co = brand.brandName || 'TeamLink';
  return { subject: `Following up, ${name}`, text: `Hi ${name}, this is ${co}. ${step.goal.charAt(0).toUpperCase()}${step.goal.slice(1)}${/[.!?]$/.test(step.goal) ? '' : '.'} ${channel === 'email' ? 'Reply to this email' : 'Reply here'} and we will take it from there.` };
}
async function writeDraft(journey, lead, step, channel) {
  const brand = await Cfg.getBrand();
  const system = [
    `You write one short ${channel === 'email' ? 'email' : 'WhatsApp message'} from ${brand.brandName || 'TeamLink'}, a staffing company, to ONE sales lead. A person will read it and approve it before it is sent.`,
    brand.about ? `About the company: ${brand.about}` : '', brand.voice ? `Brand voice: ${brand.voice}` : '', `Tone: ${brand.tone}. Write in ${brand.language}.`,
    brand.avoidWords && brand.avoidWords.length ? `Never use these words: ${brand.avoidWords.join(', ')}.` : '',
    'Use ONLY facts that are in the lead details. Never invent a price, discount, date, phone number, link or promise. Do not add an opt-out line (it is added). Under 70 words. Greet the person by first name.',
    'Answer with ONLY a JSON object: {"subject":"<email subject, at most 60 characters, or empty>","text":"<the message>"}',
  ].filter(Boolean).join('\n');
  const prompt = [
    `Lead: ${lead.company}${lead.contactName ? `, contact ${lead.contactName}` : ''}${lead.designation ? ` (${lead.designation})` : ''}.`,
    `Industry: ${lead.industry || 'not known'}. City: ${lead.city || 'not known'}. Source: ${lead.utmSource || lead.source || 'not known'}. Stage: ${lead.stage || lead.status}. Score: ${lead.leadBand || lead.rating || 'not scored'}.`,
    lead.notes ? `What they wrote: ${clip(lead.notes, 400)}` : '', `What this message must do: ${step.goal}`,
  ].filter(Boolean).join('\n');
  const made = await AI.generate({ user: { id: journey.createdById || 'journeys', name: journey.createdByName || 'Journey' }, module: 'journeys', task: 'write', system, prompt, json: true, demo: () => demoDraft(lead, step, brand, channel), itemId: journey.id });
  const r = made.result && typeof made.result === 'object' ? made.result : {};
  const text = clip(r.text, 1500);
  if (text.length < 10) throw new AI.AiMkError('The AI did not write a usable message.', 502, 'unreadable');
  return { subject: channel === 'email' ? (clip(r.subject, 100) || `About ${lead.company}`) : '', body: text, aiNote: made.demo ? 'sample writer' : (made.provider || 'AI') };
}
function channelFor(lead, want) {
  const phone = digits(lead.phone).slice(-10).length === 10 && /^[6-9]/.test(digits(lead.phone).slice(-10)) && !/^(\d)\1{9}$/.test(digits(lead.phone).slice(-10));
  const mail = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(lead.email || ''));
  if (want === 'whatsapp') return phone ? 'whatsapp' : null;
  if (want === 'email') return mail ? 'email' : null;
  return phone ? 'whatsapp' : (mail ? 'email' : null);
}

// ---- running one step ----------------------------------------------------------------------------------------------------------------------------------------------------
async function pickOwner(lead, to) {
  const all = await S.ownerOptions();
  if (to && to !== 'turn') { const o = all.find((x) => x.id === to); if (o) return o; }
  const reps = all.filter((o) => !o.tl); const list = reps.length ? reps : all;
  if (!list.length) return null;
  const cur = parse((await prisma.appSetting.findUnique({ where: { key: 'omni.mk.journeys.turn' } }).catch(() => null) || {}).value, {});
  const i = list.findIndex((o) => o.id === cur.last);
  const o = list[(i + 1) % list.length];
  const value = JSON.stringify({ last: o.id });
  await prisma.appSetting.upsert({ where: { key: 'omni.mk.journeys.turn' }, create: { key: 'omni.mk.journeys.turn', value }, update: { value } });
  return o;
}
// -> 'go' (carry on with the next step now) | 'wait' (the run's nextAt was set) | 'pause' (waiting for a person) | 'end'
async function execStep(run, journey, lead, step, steps) {
  const owner = lead.ownerName || '';
  const move = async (cursor, extra = {}) => { run.cursor = JSON.stringify(cursor); await DB.run(`UPDATE "${R}" SET "cursor" = ?, "updatedAt" = ?${extra.nextAt ? ', "nextAt" = ?' : ''}${extra.tries !== undefined ? ', "tries" = ?' : ''} WHERE "id" = ?`, ...[JSON.stringify(cursor), iso(), ...(extra.nextAt ? [extra.nextAt] : []), ...(extra.tries !== undefined ? [extra.tries] : []), run.id]); };
  const cur = parse(run.cursor, [0]);
  const adv = () => nextCursor(steps, cur);
  switch (step.kind) {
    case 'wait': { await logIt(run, 'wait', `Waiting ${step.hours >= 24 ? `${Math.round(step.hours / 2.4) / 10} day(s)` : `${step.hours} hour(s)`}.`); await move(adv(), { nextAt: new Date(Date.now() + step.hours * 3600000).toISOString() }); return 'wait'; }
    case 'if': {
      const yes = await holds(lead, step.conds);
      const branch = yes ? step.then : step.else;
      await logIt(run, 'if', `${yes ? 'Yes' : 'No'}: ${step.conds.map((c) => `${FIELDS[c.field]} ${c.value}`).join(' and ')}. Going to ${yes ? 'THEN' : 'ELSE'}${branch.length ? '' : ' (nothing to do)'}.`);
      await move(branch.length ? [cur[0], yes ? 'then' : 'else', 0] : [cur[0] + 1]); return 'go';
    }
    case 'task': {
      if (!lead.ownerId) { await logIt(run, 'skipped', 'No follow-up task: the lead has no owner yet.'); await move(adv()); return 'go'; }
      const day = new Date(Date.now() + 5.5 * 3600000 + step.dueDays * 86400000).toISOString().slice(0, 10);
      const stamp = iso();
      await S.insert('CrmTask', { id: S.newId('task'), title: fill(step.title, lead, owner).slice(0, 160), dueDate: day, dueTime: '10:00', ...(await require('../crm/sales').taskExtras({ type: step.type, priority: step.priority })), status: 'Open', leadId: lead.id, accountId: null, dealId: null, ownerId: lead.ownerId, ownerName: lead.ownerName || null, createdById: null, createdAt: stamp, updatedAt: stamp }); // eslint-disable-line global-require
      await logIt(run, 'task', `Follow-up task for ${owner || 'the owner'}: ${fill(step.title, lead, owner)} (${day}).`); await move(adv()); return 'go';
    }
    case 'notify': {
      const to = step.to === 'owner' ? lead.ownerId : step.to;
      if (!to) await logIt(run, 'skipped', 'Nobody to tell: the lead has no owner yet.');
      else { await prisma.notification.create({ data: { userId: to, title: `Journey: ${journey.name}`, message: `${fill(step.message, lead, owner)}\nOpen: /crm/leads?open=lead:${lead.id}`, channel: 'In-App', recipient: `journey|${run.id}`, status: 'Sent' } }).catch(() => {}); await logIt(run, 'notify', `Told ${step.to === 'owner' ? (owner || 'the owner') : 'a team member'}.`); }
      await move(adv()); return 'go';
    }
    case 'assign': {
      if (lead.ownerId && step.onlyIfEmpty) { await logIt(run, 'skipped', `Kept the owner (${owner}).`); await move(adv()); return 'go'; }
      const o = await pickOwner(lead, step.to);
      if (!o) await logIt(run, 'skipped', 'Nobody on the sales team to give it to.');
      else { await S.update('CrmLead', lead.id, { ownerId: o.id, ownerName: o.name, updatedAt: iso() }); lead.ownerId = o.id; lead.ownerName = o.name; await logIt(run, 'assign', `Given to ${o.name}.`); }
      await move(adv()); return 'go';
    }
    case 'rate': {
      if (step.onlyIfEmpty && lead.rating) await logIt(run, 'skipped', `Kept the rating (${lead.rating}).`);
      else { await S.update('CrmLead', lead.id, { rating: step.rating, updatedAt: iso() }); lead.rating = step.rating; await logIt(run, 'rate', `Rating set to ${step.rating}.`); }
      await move(adv()); return 'go';
    }
    case 'ai_message': {
      const channel = channelFor(lead, step.channel);
      if (!channel) { await logIt(run, 'skipped', 'No message: the lead has no real phone number or email for that way.'); await move(adv()); return 'go'; }
      let draft;
      try { draft = await writeDraft(journey, lead, step, channel); } catch (e) {
        const tries = (Number(run.tries) || 0) + 1;
        if (tries >= MAX_TRIES) { await logIt(run, 'skipped', `The AI could not write it after ${tries} tries (${clip(e.message, 120)}): skipped.`); await move(adv(), { tries: 0 }); return 'go'; }
        await logIt(run, 'retry', `The AI could not write it just now (${clip(e.message, 120)}). Trying again in 30 minutes.`);
        await DB.run(`UPDATE "${R}" SET "nextAt" = ?, "tries" = ?, "updatedAt" = ? WHERE "id" = ?`, new Date(Date.now() + 30 * 60000).toISOString(), tries, iso(), run.id); return 'wait';
      }
      await DB.run(`INSERT INTO "${D}" ("id", "runId", "journeyId", "leadId", "channel", "subject", "body", "goal", "forUserId", "status", "aiNote", "createdAt") VALUES (?,?,?,?,?,?,?,?,?, 'waiting', ?, ?)`, S.newId('jd'), run.id, journey.id, lead.id, channel, draft.subject || null, draft.body, step.goal, lead.ownerId || null, draft.aiNote, iso());
      await DB.run(`UPDATE "${R}" SET "status" = 'waiting', "tries" = 0, "updatedAt" = ? WHERE "id" = ?`, iso(), run.id);
      await logIt(run, 'draft', `The AI wrote a ${channel === 'email' ? 'email' : 'WhatsApp message'} for ${owner || 'a manager'} to approve. The journey waits.`);
      if (lead.ownerId) await prisma.notification.create({ data: { userId: lead.ownerId, title: `Approve a message to ${lead.company}`, message: `The AI wrote a ${channel === 'email' ? 'email' : 'WhatsApp message'}. Nothing is sent until you approve it. Open: /omni-channel-native/aimarketing/mkjourneys`, channel: 'In-App', recipient: `journey-draft|${run.id}`, status: 'Sent' } }).catch(() => {});
      return 'pause';
    }
    default: await logIt(run, 'end', 'The journey ended.'); return 'end';
  }
}

async function finish(run, status, reason) { await DB.run(`UPDATE "${R}" SET "status" = ?, "stopReason" = ?, "updatedAt" = ? WHERE "id" = ?`, status, reason || null, iso(), run.id); if (reason) await logIt(run, status === 'done' ? 'end' : 'stop', reason); }
// run one lead's journey until it must wait, pause or end (at most 12 steps)
async function advance(run, journey) {
  const steps = parse(journey.steps, []);
  for (let n = 0; n < 12; n += 1) {
    const lead = await S.getRow('lead', run.leadId);
    if (closed(lead)) { await finish(run, 'stopped', 'The lead is closed (won, lost, junk or converted): it left the journey.'); return 'stopped'; }
    const cur = parse(run.cursor, [0]);
    if (done(steps, cur)) { await finish(run, 'done', 'The journey finished.'); return 'done'; }
    const step = stepAt(steps, cur);
    if (!step) { await finish(run, 'done', 'The journey finished.'); return 'done'; }
    const out = await execStep(run, journey, lead, step, steps); // eslint-disable-line no-await-in-loop
    if (out === 'end') { await finish(run, 'done', null); return 'done'; }
    if (out === 'wait' || out === 'pause') return out;
    if (done(steps, parse(run.cursor, [0]))) { await finish(run, 'done', 'The journey finished.'); return 'done'; }
  }
  await DB.run(`UPDATE "${R}" SET "nextAt" = ?, "updatedAt" = ? WHERE "id" = ?`, new Date(Date.now() + 60000).toISOString(), iso(), run.id); // a very long chain: carry on next minute
  return 'wait';
}

// ---- enrolling (events) ----------------------------------------------------------------------------------------------------------------------------------------------
const OPEN = '"status" NOT IN (\'Junk\', \'Converted\') AND COALESCE("stage", \'\') NOT IN (\'Won\', \'Lost\') AND "company" NOT LIKE \'Sample%\'';
async function candidates(j, limit) {
  const opt = parse(j.triggerOpt, {}); const armed = j.armedAt;
  const notIn = `NOT EXISTS (SELECT 1 FROM "${R}" r WHERE r."journeyId" = ? AND r."leadId" = l."id")`;
  let rows = [];
  if (j.triggerKind === 'new_lead') rows = await DB.all(`SELECT l.* FROM "CrmLead" l WHERE ${OPEN} AND l."createdAt" >= ? AND ${notIn} ORDER BY l."createdAt" ASC LIMIT ?`, armed, j.id, limit * 3);
  else if (j.triggerKind === 'hot_lead') rows = await DB.all(`SELECT l.* FROM "CrmLead" l WHERE ${OPEN} AND l."leadBand" = 'Hot' AND l."leadScoredAt" >= ? AND ${notIn} ORDER BY l."leadScoredAt" ASC LIMIT ?`, armed, j.id, limit * 3);
  else if (j.triggerKind === 'stage_change') rows = await DB.all(`SELECT l.* FROM "CrmLead" l WHERE ${OPEN} AND LOWER(COALESCE(l."stage", '')) = LOWER(?) AND EXISTS (SELECT 1 FROM "CrmActivity" a WHERE a."leadId" = l."id" AND a."subject" LIKE ? AND a."createdAt" >= ?) AND ${notIn} ORDER BY l."updatedAt" ASC LIMIT ?`, opt.stage || '', `Stage:%→ ${opt.stage || ''}`, armed, j.id, limit * 3);
  else if (j.triggerKind === 'idle_lead') {
    const cut = new Date(Date.now() - (opt.days || 7) * 86400000).toISOString();
    rows = await DB.all(`SELECT l.* FROM "CrmLead" l WHERE ${OPEN} AND l."ownerId" IS NOT NULL AND l."createdAt" <= ? AND l."updatedAt" <= ? AND NOT EXISTS (SELECT 1 FROM "CrmActivity" a WHERE a."leadId" = l."id" AND a."at" > ? AND a."byName" NOT IN ('Lead scoring', 'Journey')) AND ${notIn} ORDER BY l."updatedAt" ASC LIMIT ?`, cut, cut, cut, j.id, limit * 3);
  }
  const src = (opt.sources || []).map((x) => String(x).toLowerCase()).filter(Boolean);
  if (src.length) rows = rows.filter((l) => src.some((s) => sourceOf(l).includes(s)));
  return rows.slice(0, limit);
}
async function enrol(j) {
  const today = new Date().toISOString().slice(0, 10);
  const used = Number((await DB.one(`SELECT COUNT(*) AS n FROM "${R}" WHERE "journeyId" = ? AND "startedAt" >= ?`, j.id, `${today}T00:00:00`) || {}).n || 0);
  const room = Math.min(MAX_PER_TICK, DAILY_CAP - used);
  if (room <= 0) return 0;
  let n = 0;
  for (const l of await candidates(j, room)) {
    const ins = await DB.run(`INSERT OR IGNORE INTO "${R}" ("id", "journeyId", "leadId", "cursor", "nextAt", "status", "startedAt", "updatedAt") VALUES (?,?,?, '[0]', ?, 'running', ?, ?)`, S.newId('jr'), j.id, l.id, iso(), iso(), iso()); // eslint-disable-line no-await-in-loop
    if (Number(ins) === 1) { n += 1; const run = await DB.one(`SELECT * FROM "${R}" WHERE "journeyId" = ? AND "leadId" = ?`, j.id, l.id); await logIt(run, 'start', `Started: ${TRIGGERS[j.triggerKind]}.`); } // eslint-disable-line no-await-in-loop
  }
  return n;
}

// the tick: enrol, run what is due, expire drafts nobody answered
let ticking = false;
async function tick() {
  if (ticking) return { busy: true };
  ticking = true;
  try {
    await ensure();
    const out = { enrolled: 0, ran: 0, expired: 0 };
    for (const j of await DB.all(`SELECT * FROM "${J}" WHERE "status" = 'on' AND "deletedAt" IS NULL AND "armedAt" IS NOT NULL`)) out.enrolled += await enrol(j); // eslint-disable-line no-await-in-loop
    const stale = new Date(Date.now() - DRAFT_DAYS * 86400000).toISOString();
    for (const d of await DB.all(`SELECT * FROM "${D}" WHERE "status" = 'waiting' AND "createdAt" < ?`, stale)) { // eslint-disable-line no-restricted-syntax
      await DB.run(`UPDATE "${D}" SET "status" = 'expired', "decidedAt" = ? WHERE "id" = ? AND "status" = 'waiting'`, iso(), d.id); // eslint-disable-line no-await-in-loop
      await resume(d.runId, 'The message was not approved in 3 days: it was skipped.'); out.expired += 1; // eslint-disable-line no-await-in-loop
    }
    // a lead that closed (won, lost, junk, converted) while its AI message was waiting leaves the journey at once and the draft can no longer be sent
    for (const w of await DB.all(`SELECT * FROM "${R}" WHERE "status" = 'waiting' ORDER BY "updatedAt" ASC LIMIT 100`)) { // eslint-disable-line no-restricted-syntax
      if (!closed(await S.getRow('lead', w.leadId))) continue; // eslint-disable-line no-continue, no-await-in-loop
      await DB.run(`UPDATE "${D}" SET "status" = 'expired', "decidedAt" = ?, "result" = 'the lead closed' WHERE "runId" = ? AND "status" = 'waiting'`, iso(), w.id); // eslint-disable-line no-await-in-loop
      await finish(w, 'stopped', 'The lead is closed (won, lost, junk or converted): it left the journey and its message was not sent.'); // eslint-disable-line no-await-in-loop
    }
    const due = await DB.all(`SELECT * FROM "${R}" WHERE "status" = 'running' AND "nextAt" <= ? ORDER BY "nextAt" ASC LIMIT 40`, iso());
    for (const run of due) {
      const j = await DB.one(`SELECT * FROM "${J}" WHERE "id" = ?`, run.journeyId); // eslint-disable-line no-await-in-loop
      if (!j || j.deletedAt || j.status !== 'on') continue; // eslint-disable-line no-continue
      try { await advance(run, j); out.ran += 1; } catch (e) { console.error('[omni-mk] journey step:', e.message); await DB.run(`UPDATE "${R}" SET "nextAt" = ?, "updatedAt" = ? WHERE "id" = ?`, new Date(Date.now() + 10 * 60000).toISOString(), iso(), run.id); } // eslint-disable-line no-console, no-await-in-loop
    }
    return out;
  } finally { ticking = false; }
}
function start() {
  if (require('../utils/sandbox').isSandbox()) return; // eslint-disable-line global-require
  setInterval(() => { tick().catch((e) => console.error('[omni-mk] journeys:', e.message)); }, 60 * 1000).unref(); // eslint-disable-line no-console
}
// after a decision (or an expiry) the journey carries on from the step after the AI message
async function resume(runId, note) {
  const run = await DB.one(`SELECT * FROM "${R}" WHERE "id" = ?`, runId);
  if (!run || run.status !== 'waiting') return;
  const j = await DB.one(`SELECT * FROM "${J}" WHERE "id" = ?`, run.journeyId);
  const steps = parse(j && j.steps, []);
  const next = nextCursor(steps, parse(run.cursor, [0]));
  await DB.run(`UPDATE "${R}" SET "status" = 'running', "cursor" = ?, "nextAt" = ?, "updatedAt" = ? WHERE "id" = ?`, JSON.stringify(next), iso(), iso(), runId);
  if (note) await logIt(run, 'note', note);
}

// ---- approving a draft (the only way a journey sends anything) -------------------------------------------------------------------------------------------------------
const STOP_LINE = '\n\nReply STOP to stop these messages.';
async function decide(u, draftId, b = {}) {
  await ensure();
  const d = await DB.one(`SELECT * FROM "${D}" WHERE "id" = ?`, String(draftId || ''));
  const r = S.roleOf(u);
  if (!d || !r) return { error: 'This message was not found.', status: 404 };
  const lead = await S.getRow('lead', d.leadId);
  if (!lead || !(manager(u) || (lead.ownerId && lead.ownerId === u.id))) return { error: 'This message is for the lead\'s owner or a manager.', status: 403 };
  if (d.status !== 'waiting') return { error: d.status === 'sent' ? 'It was already approved and sent.' : 'It was already decided.', status: 409 };
  if (b.approve !== true) {
    await DB.run(`UPDATE "${D}" SET "status" = 'rejected', "decidedAt" = ?, "decidedByName" = ? WHERE "id" = ?`, iso(), clip(u.name, 80), d.id);
    await resume(d.runId, `${clip(u.name, 60)} did not approve the message: it was skipped.`);
    return { ok: 'Not sent. The journey carries on with the next step.' };
  }
  const subject = clip(b.subject === undefined ? d.subject : b.subject, 120);
  let body = clip(b.body === undefined ? d.body : b.body, 1500);
  if (body.length < 10) return { error: 'The message is too short.', status: 400 };
  if (!/\bSTOP\b/i.test(body)) body += STOP_LINE;
  if (closed(lead)) { await DB.run(`UPDATE "${D}" SET "status" = 'expired', "decidedAt" = ? WHERE "id" = ?`, iso(), d.id); await resume(d.runId, 'The lead is closed: nothing was sent.'); return { error: 'This lead is closed, so nothing was sent.', status: 409 }; }
  const messaging = require('../utils/messaging'); // eslint-disable-line global-require
  const core = require('../utils/messagingCore'); // eslint-disable-line global-require
  const CMP = require('../crm/campaigns'); // eslint-disable-line global-require
  let res; let to = '';
  if (d.channel === 'whatsapp') {
    const nm = core.normalizeMobile(lead.phone);
    if (!nm.ok) return { error: 'The lead\'s phone number does not look right. Fix it in the CRM, then approve again.', status: 400 };
    if ((await CMP.optedOut('whatsapp', nm.e164).catch(() => false)) || (await CMP.optedOut('sms', nm.e164).catch(() => false))) { await DB.run(`UPDATE "${D}" SET "status" = 'rejected', "decidedAt" = ?, "decidedByName" = ?, "result" = 'opted out' WHERE "id" = ?`, iso(), clip(u.name, 80), d.id); await resume(d.runId, 'The lead opted out: nothing was sent.'); return { error: 'This person opted out of messages, so nothing was sent.', status: 409 }; }
    to = core.maskMobile(nm.e164);
    const meta = { audience: 'lead', personName: clip(lead.contactName || lead.company, 80), purpose: 'CRM journey', module: 'AI Marketing', senderUserId: u.id, senderName: clip(u.name, 80) };
    // the official WhatsApp number sends free text only within 24 hours of the person's last message: with an approved "journey" template set (AI usage), the approved words go in as its last blank
    const tpl = require('./waTemplates').payload((await Cfg.getSettings()).waTemplates, 'journey', { name: String(lead.contactName || '').trim().split(/\s+/)[0] || 'there', brand: (await Cfg.getBrand()).brandName || 'TeamLink', message: body.replace(STOP_LINE, '').replace(/\n+/g, ' ') }); // eslint-disable-line global-require
    res = await messaging.send('WhatsApp', tpl ? { to: nm.e164, kind: 'text', text: body, template: tpl.template, vars: tpl.vars, meta: { ...meta, template: tpl.template.name } } : { to: nm.e164, kind: 'bulk', text: body, vars: [body.replace(STOP_LINE, '').replace(/\n+/g, ' ')], meta }); // no template of its own: the company's general "bulk / general" template (Integrations) if one is saved, else free text
  } else {
    const em = String(lead.email || '').trim();
    if (await CMP.optedOut('email', em).catch(() => false)) { await DB.run(`UPDATE "${D}" SET "status" = 'rejected', "decidedAt" = ?, "decidedByName" = ?, "result" = 'opted out' WHERE "id" = ?`, iso(), clip(u.name, 80), d.id); await resume(d.runId, 'The lead opted out: nothing was sent.'); return { error: 'This person opted out of emails, so nothing was sent.', status: 409 }; }
    to = core.maskEmail(em);
    res = await messaging.send('Email', { to: em, subject: subject || `About ${lead.company}`, text: body, meta: { audience: 'lead', purpose: 'CRM journey', module: 'AI Marketing', senderUserId: u.id, senderName: clip(u.name, 80) } });
  }
  const ok = !!(res && res.ok);
  const why = ok ? '' : clip((res && (res.notConfigured || res.outcome === 'Not configured') ? `It is not connected: ${res.error || 'ask an Admin to connect it in Administration > Integrations'}` : String((res && res.error) || 'The sender refused it.')).replace(/(\+?\d[\d\s-]{8,}\d)/g, 'a number'), 200);
  await DB.run(`UPDATE "${D}" SET "status" = ?, "subject" = ?, "body" = ?, "result" = ?, "decidedAt" = ?, "decidedByName" = ? WHERE "id" = ?`, ok ? 'sent' : 'failed', subject || null, body, ok ? `Sent to ${to}` : why, iso(), clip(u.name, 80), d.id);
  if (ok) await S.insert('CrmActivity', { id: S.newId('act'), kind: d.channel === 'email' ? 'email' : 'whatsapp', subject: `Journey message${subject ? `: ${subject}` : ''}`.slice(0, 160), note: body.slice(0, 1500), at: iso(), leadId: lead.id, byId: u.id, byName: clip(u.name, 80), createdAt: iso() }).catch(() => null);
  await resume(d.runId, ok ? `${clip(u.name, 60)} approved it and it was sent by ${d.channel === 'email' ? 'email' : 'WhatsApp'} (${to}).` : `${clip(u.name, 60)} approved it but it could not be sent: ${why}`);
  return ok ? { ok: `Sent by ${d.channel === 'email' ? 'email' : 'WhatsApp'} to ${to}. The journey carries on.` } : { error: `It could not be sent: ${why} The journey carries on without it.`, status: 502 };
}

// ---- the page --------------------------------------------------------------------------------------------------------------------------------------------------------------
function describe(steps) {
  return steps.map((s) => {
    if (s.kind === 'wait') return `wait ${s.hours >= 24 ? `${Math.round((s.hours / 24) * 10) / 10} day(s)` : `${s.hours} h`}`;
    if (s.kind === 'if') return `IF ${s.conds.map((c) => `${FIELDS[c.field].toLowerCase()} ${c.value}`).join(' and ')} THEN ${s.then.length} step(s) ELSE ${s.else.length}`;
    if (s.kind === 'task') return `task "${s.title}"`;
    if (s.kind === 'notify') return 'tell someone';
    if (s.kind === 'assign') return 'give the lead';
    if (s.kind === 'rate') return `rate ${s.rating}`;
    if (s.kind === 'ai_message') return 'AI writes, a person approves';
    return 'end';
  }).join(' → ');
}
async function counts(id) {
  const rows = await DB.all(`SELECT "status", COUNT(*) AS n FROM "${R}" WHERE "journeyId" = ? GROUP BY "status"`, id);
  const o = { running: 0, waiting: 0, done: 0, stopped: 0 }; rows.forEach((r) => { o[r.status] = Number(r.n); });
  return o;
}
const jview = async (j) => ({ id: j.id, name: j.name, trigger: { kind: j.triggerKind, words: TRIGGERS[j.triggerKind], opt: parse(j.triggerOpt, {}) }, steps: parse(j.steps, []), summary: describe(parse(j.steps, [])), status: j.status, armedAt: j.armedAt, counts: await counts(j.id), createdByName: j.createdByName || '', updatedAt: j.updatedAt });
async function overview(u) {
  const r = S.roleOf(u);
  if (!r) return { error: 'Your login is not on the CRM list. Ask a Sales manager or an Admin.', status: 403 };
  await ensure();
  const js = await DB.all(`SELECT * FROM "${J}" WHERE "deletedAt" IS NULL ORDER BY "updatedAt" DESC LIMIT 100`);
  const journeys = []; for (const j of js) journeys.push(await jview(j)); // eslint-disable-line no-await-in-loop
  const owners = await S.ownerOptions(); const st = await require('../crm/settings').load(); // eslint-disable-line global-require
  return { journeys, canManage: S.mayAssign(r), triggers: TRIGGERS, fields: FIELDS, owners: owners.map((o) => ({ id: o.id, name: o.name, tl: o.tl })), stages: (st.leadStages || []).map((x) => x.name), sources: st.sources || [], approvals: (await drafts(u)).length, limits: { maxSteps: MAX_STEPS, perDay: DAILY_CAP, draftDays: DRAFT_DAYS } };
}
async function drafts(u) {
  const r = S.roleOf(u); if (!r) return [];
  const rows = manager(u) ? await DB.all(`SELECT d.*, j."name" AS "journeyName" FROM "${D}" d JOIN "${J}" j ON j."id" = d."journeyId" WHERE d."status" = 'waiting' ORDER BY d."createdAt" ASC LIMIT 100`) : await DB.all(`SELECT d.*, j."name" AS "journeyName" FROM "${D}" d JOIN "${J}" j ON j."id" = d."journeyId" WHERE d."status" = 'waiting' AND d."forUserId" = ? ORDER BY d."createdAt" ASC LIMIT 100`, u.id);
  const out = [];
  for (const d of rows) { const l = await S.getRow('lead', d.leadId); out.push({ id: d.id, journeyName: d.journeyName, channel: d.channel, subject: d.subject || '', body: d.body, goal: d.goal, aiNote: d.aiNote || '', createdAt: d.createdAt, lead: l ? { id: l.id, company: l.company, contactName: l.contactName || '', band: l.leadBand || l.rating || '', ownerName: l.ownerName || '', source: sourceOf(l) } : null }); } // eslint-disable-line no-await-in-loop
  return out;
}
async function draftList(u) { if (!S.roleOf(u)) return { error: 'Your login is not on the CRM list.', status: 403 }; await ensure(); return { drafts: await drafts(u) }; }
async function runs(u, id) {
  const r = S.roleOf(u); if (!r) return { error: 'Your login is not on the CRM list.', status: 403 };
  await ensure();
  const j = await DB.one(`SELECT * FROM "${J}" WHERE "id" = ? AND "deletedAt" IS NULL`, String(id));
  if (!j) return { error: 'This journey was not found.', status: 404 };
  const rows = await DB.all(`SELECT r.*, l."company", l."ownerId", l."ownerName" FROM "${R}" r LEFT JOIN "CrmLead" l ON l."id" = r."leadId" WHERE r."journeyId" = ? ORDER BY r."updatedAt" DESC LIMIT 60`, j.id);
  const out = [];
  for (const x of rows) { // eslint-disable-line no-restricted-syntax
    if (!manager(u) && x.ownerId !== u.id) continue; // eslint-disable-line no-continue
    const log = await DB.all(`SELECT "at", "kind", "text" FROM "${G}" WHERE "runId" = ? ORDER BY "at" ASC LIMIT 40`, x.id); // eslint-disable-line no-await-in-loop
    out.push({ id: x.id, leadId: x.leadId, company: x.company || '—', ownerName: x.ownerName || '', status: x.status, stopReason: x.stopReason || '', startedAt: x.startedAt, log });
  }
  return { name: j.name, runs: out };
}
async function save(u, b = {}) {
  const r = S.roleOf(u);
  if (!r) return { error: 'Your login is not on the CRM list.', status: 403 };
  if (!S.mayAssign(r)) return { error: 'Only a Sales manager or an Admin can make or change journeys.', status: 403 };
  await ensure();
  const name = clip(b.name, 80); if (name.length < 3) return { error: 'Give the journey a name.', status: 400 };
  const t = cleanTrigger(b.triggerKind, b.triggerOpt || {}); if (t.error) return { error: t.error, status: 400 };
  const s = cleanSteps(b.steps); if (s.error) return { error: s.error, status: 400 };
  const now = iso();
  if (b.id) {
    const cur = await DB.one(`SELECT * FROM "${J}" WHERE "id" = ? AND "deletedAt" IS NULL`, String(b.id));
    if (!cur) return { error: 'This journey was not found.', status: 404 };
    const inUse = Number((await DB.one(`SELECT COUNT(*) AS n FROM "${R}" WHERE "journeyId" = ? AND "status" IN ('running','waiting')`, cur.id) || {}).n || 0);
    if (inUse && (cur.triggerKind !== t.kind || JSON.stringify(parse(cur.steps, [])) !== JSON.stringify(s.steps))) return { error: `${inUse} lead${inUse === 1 ? ' is' : 's are'} in this journey right now, so its steps cannot change. Switch it off and let them finish, or make a new journey.`, status: 409 };
    await DB.run(`UPDATE "${J}" SET "name" = ?, "triggerKind" = ?, "triggerOpt" = ?, "steps" = ?, "updatedAt" = ? WHERE "id" = ?`, name, t.kind, JSON.stringify(t.opt), JSON.stringify(s.steps), now, cur.id);
    await S.audit(u, 'Journey changed', J, cur.id, name);
    return { ok: 'Saved.', journey: await jview(await DB.one(`SELECT * FROM "${J}" WHERE "id" = ?`, cur.id)) };
  }
  const id = S.newId('jy');
  await DB.run(`INSERT INTO "${J}" ("id", "name", "triggerKind", "triggerOpt", "steps", "status", "createdById", "createdByName", "createdAt", "updatedAt") VALUES (?,?,?,?,?, 'off', ?,?,?,?)`, id, name, t.kind, JSON.stringify(t.opt), JSON.stringify(s.steps), u.id, clip(u.name, 80), now, now);
  await S.audit(u, 'Journey made', J, id, name);
  return { ok: 'Saved. It is OFF: switch it on when you are ready.', journey: await jview(await DB.one(`SELECT * FROM "${J}" WHERE "id" = ?`, id)) };
}
async function setOn(u, id, on) {
  const r = S.roleOf(u);
  if (!r || !S.mayAssign(r)) return { error: 'Only a Sales manager or an Admin can switch a journey on or off.', status: 403 };
  await ensure();
  const j = await DB.one(`SELECT * FROM "${J}" WHERE "id" = ? AND "deletedAt" IS NULL`, String(id));
  if (!j) return { error: 'This journey was not found.', status: 404 };
  if (on) await DB.run(`UPDATE "${J}" SET "status" = 'on', "armedAt" = ?, "updatedAt" = ? WHERE "id" = ?`, j.status === 'on' && j.armedAt ? j.armedAt : iso(), iso(), j.id);
  else await DB.run(`UPDATE "${J}" SET "status" = 'off', "updatedAt" = ? WHERE "id" = ?`, iso(), j.id);
  await S.audit(u, on ? 'Journey switched on' : 'Journey switched off', J, j.id, j.name);
  return { ok: on ? 'Switched on. Leads that match from now on are taken in (an idle journey looks at open leads that have been quiet that long).' : 'Switched off. Leads already in it stay where they are until it is switched on again.', journey: await jview(await DB.one(`SELECT * FROM "${J}" WHERE "id" = ?`, j.id)) };
}
async function remove(u, id) {
  const r = S.roleOf(u);
  if (!r || !S.mayAssign(r)) return { error: 'Only a Sales manager or an Admin can remove a journey.', status: 403 };
  await ensure();
  const j = await DB.one(`SELECT * FROM "${J}" WHERE "id" = ? AND "deletedAt" IS NULL`, String(id));
  if (!j) return { error: 'This journey was not found.', status: 404 };
  await DB.run(`UPDATE "${J}" SET "status" = 'off', "deletedAt" = ?, "updatedAt" = ? WHERE "id" = ?`, iso(), iso(), j.id);
  await DB.run(`UPDATE "${R}" SET "status" = 'stopped', "stopReason" = 'The journey was removed.', "updatedAt" = ? WHERE "journeyId" = ? AND "status" IN ('running','waiting')`, iso(), j.id);
  await DB.run(`UPDATE "${D}" SET "status" = 'expired', "decidedAt" = ? WHERE "journeyId" = ? AND "status" = 'waiting'`, iso(), j.id);
  await S.audit(u, 'Journey removed', J, j.id, j.name);
  return { ok: 'Removed. Leads in it left it; nothing waiting for approval will be sent.' };
}

module.exports = { TRIGGERS, FIELDS, ensure, tick, start, cleanSteps, cleanTrigger, holds, nextCursor, overview, draftList, runs, decide, save, setOn, remove, describe };
