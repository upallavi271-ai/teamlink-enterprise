// ---------------------------------------------------------------------------
// AI MARKETING > AI AGENT: THE ORCHESTRATION ENGINE (2026-11-25). A goal-oriented layer that CALLS the existing AI Marketing services; it is not a chatbot and it fakes nothing.
//   workflow  goal -> understand (agentPlanner.js) -> business context (agentContext.js) -> ask for what is missing -> PLAN + PREVIEW -> a person presses "Approve and run" ->
//             the approved steps run in the background, one at a time, through the tools (agentTools.js) as the person who approved -> results are tracked -> a performance summary
//             made only of what really happened.
//   state     persistent (tables OmniMkAgentRun / Task / Event / Msg, created on first use): a run is a goal with its plan, a task is one step, every step is in the history. A server restart
//             never loses a plan: queued steps carry on, a step that was running is marked "interrupted: press Retry" (never silently run twice).
//   safety    * NOTHING RUNS WITHOUT AN APPROVAL: typed words never approve (only the button does), and the engine refuses an 'outward' tool (a post, a message, a call, ad spend, a live
//               website change) without a SEPARATE per-task approval. Phase 1 has no outward tool: posting is a step a person does and confirms, and it can only be confirmed once the
//               draft and picture are APPROVED.
//             * PHASE 2: social.post (publish an APPROVED picture on the accounts the person picks, at its scheduled time) and client.review (send the picture to the client's WhatsApp) are the first
//               outward tools. Each is approved step by step: the person sees the exact accounts / recipient, the engine re-checks that the picture is approved and posting is allowed, and the step
//               runs as THAT person, never before its scheduled time, never twice to the same account, and a failed one needs a fresh approval to retry.
//             * a step runs as the approver, with their role and limits; if they lose the right to use AI Marketing the steps stop.
//             * cancel anything that is waiting; a step already running finishes and its results are kept and listed. Retry a failed step. Transient busy errors retry by themselves twice.
//             * every approval, step, failure, retry and cancel is in the history of the run and in the audit log ("Omni-Channel AI Marketing: agent ...").
//   honesty   success metrics say whether TeamLink can measure them; a person types enquiries in; reach / engagement are "not connected yet"; no invented numbers; costs are the real unit
//             costs of the tools (all free today) and the dashboard adds them up.
// Never started in the test sandbox (start()); tests drive it with drain().
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const A = require('../outreach/access');
const Cfg = require('./settings');
const Ctx = require('./agentContext');
const P = require('./agentPlanner');
const Tools = require('./agentTools');
const Blog = require('./blogPlanner');
const Analytics = require('./agentAnalytics');
const { logAudit } = require('../utils/audit');

const R = 'OmniMkAgentRun'; const TK = 'OmniMkAgentTask'; const EV = 'OmniMkAgentEvent'; const MG = 'OmniMkAgentMsg';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${R}" ("id" TEXT NOT NULL PRIMARY KEY, "businessKey" TEXT NOT NULL DEFAULT 'own', "businessName" TEXT NOT NULL DEFAULT '', "goal" TEXT NOT NULL DEFAULT '', "intent" TEXT, "status" TEXT NOT NULL DEFAULT 'needs_info', "params" TEXT, "plan" TEXT, "questions" TEXT, "summary" TEXT, "createdById" TEXT, "createdByName" TEXT, "approvedById" TEXT, "approvedByName" TEXT, "approvedAt" DATETIME, "startedAt" DATETIME, "finishedAt" DATETIME, "cancelledAt" DATETIME, "cancelReason" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0, "deletedAt" DATETIME)`,
  `CREATE INDEX IF NOT EXISTS "${R}_status" ON "${R}"("status", "updatedAt")`,
  `CREATE INDEX IF NOT EXISTS "${R}_biz" ON "${R}"("businessKey", "createdAt")`,
  `CREATE TABLE IF NOT EXISTS "${TK}" ("id" TEXT NOT NULL PRIMARY KEY, "runId" TEXT NOT NULL, "n" INTEGER NOT NULL DEFAULT 0, "day" INTEGER, "tool" TEXT NOT NULL, "title" TEXT NOT NULL DEFAULT '', "status" TEXT NOT NULL DEFAULT 'planned', "deps" TEXT, "input" TEXT, "output" TEXT, "error" TEXT, "errorCode" TEXT, "attempts" INTEGER NOT NULL DEFAULT 0, "approvedById" TEXT, "approvedAt" DATETIME, "cancelRequested" INTEGER NOT NULL DEFAULT 0, "scheduledAt" DATETIME, "remindedAt" DATETIME, "note" TEXT, "startedAt" DATETIME, "finishedAt" DATETIME, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS "${TK}_run" ON "${TK}"("runId", "n")`,
  `CREATE TABLE IF NOT EXISTS "${EV}" ("id" TEXT NOT NULL PRIMARY KEY, "runId" TEXT NOT NULL, "taskId" TEXT, "at" DATETIME NOT NULL DEFAULT 0, "kind" TEXT NOT NULL, "byName" TEXT, "text" TEXT)`,
  `CREATE INDEX IF NOT EXISTS "${EV}_run" ON "${EV}"("runId", "at")`,
  `CREATE TABLE IF NOT EXISTS "${MG}" ("id" TEXT NOT NULL PRIMARY KEY, "runId" TEXT NOT NULL, "at" DATETIME NOT NULL DEFAULT 0, "role" TEXT NOT NULL, "text" TEXT NOT NULL DEFAULT '', "data" TEXT)`,
  `CREATE INDEX IF NOT EXISTS "${MG}_run" ON "${MG}"("runId", "at")`,
];
let okAt = 0;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  try { for (const sql of DDL) await S.run(sql); try { await S.run(`ALTER TABLE "${TK}" ADD COLUMN "args" TEXT`); } catch { /* the column is already there */ } await Ctx.ensure(); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] agent schema:', e.message); return false; } // eslint-disable-line no-console
}

// tests change these (nothing else does)
const config = { backoff: [15000, 45000], taskMs: 90000, imageMs: 180000, maxRunning: 3, maxAttempts: 6, clock: () => Date.now() };

const mayWrite = (u) => A.has('mayAiMarketing')(u);
const visible = (u, r) => !!r && !r.deletedAt && (A.isAdmin(u) || r.createdById === u.id);
const clip = (s, n) => S.clip(s, n);
const par = (v, d) => S.parse(v, d);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const ids = (p) => S.newId(p);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const TERMINAL = ['done', 'skipped', 'cancelled'];
const RUN_WORDS = { needs_info: 'Needs your answers', preview: 'Plan ready: waiting for your approval', running: 'Running', attention: 'Needs you', done: 'Finished', cancelled: 'Cancelled' };
const TASK_WORDS = { planned: 'Planned', queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed', cancelled: 'Cancelled', waiting: 'Waiting for you', awaiting_approval: 'Needs your approval', skipped: 'Skipped' };

// ---- rows and views ----------------------------------------------------------------------------------------------------------------------------------------------------------------
const runRow = async (id) => (await S.q(`SELECT * FROM "${R}" WHERE id = ?`, String(id || '')))[0] || null;
const tasksOf = async (runId) => (await S.q(`SELECT * FROM "${TK}" WHERE runId = ? ORDER BY n`, runId));
const taskRow = async (id) => (await S.q(`SELECT * FROM "${TK}" WHERE id = ?`, String(id || '')))[0] || null;
async function event(runId, taskId, kind, byName, text) {
  try { await S.run(`INSERT INTO "${EV}" (id, runId, taskId, at, kind, byName, text) VALUES (?,?,?,?,?,?,?)`, ids('age'), runId, taskId || null, Date.now(), kind, clip(byName, 80) || null, clip(text, 1500)); } catch (e) { console.error('[omni-mk] agent event:', e.message); } // eslint-disable-line no-console
}
async function say(runId, role, text, data) {
  try { await S.run(`INSERT INTO "${MG}" (id, runId, at, role, text, data) VALUES (?,?,?,?,?,?)`, ids('agm'), runId, Date.now(), role, clip(text, 3000), data ? JSON.stringify(data) : null); } catch (e) { console.error('[omni-mk] agent message:', e.message); } // eslint-disable-line no-console
}
const touch = (id) => S.run(`UPDATE "${R}" SET updatedAt = ? WHERE id = ?`, Date.now(), id);
const audit = (u, action, r, to) => logAudit({ userId: u && u.id, actorName: u && u.name, action: `Omni-Channel AI Marketing: agent ${action}`, entity: R, entityId: r.id, toValue: clip(to, 400) });

const maskInput = (input) => {
  if (!input || typeof input !== 'object') return input;
  const core = require('../utils/messagingCore'); // eslint-disable-line global-require
  const o = { ...input };
  if (o.contactPhone) o.contactPhone = core.maskMobile(core.normalizeMobile(o.contactPhone).e164 || o.contactPhone) || '••••';
  if (o.contactEmail) o.contactEmail = String(o.contactEmail).replace(/^(.).*(@.*)$/, '$1•••$2');
  delete o.base;
  return o;
};
function taskView(t, plan) {
  const tool = Tools.TOOLS[t.tool] || {}; const out = par(t.output, null);
  const day = plan && t.day ? Tools.dayOf(plan, t.day) : null;
  return {
    id: t.id, n: S.num(t.n), day: t.day == null ? null : S.num(t.day), tool: t.tool, toolLabel: tool.label || t.tool, module: tool.module || '', page: tool.page || '', manual: !!tool.manual, outward: Tools.isOutward(t.tool), gated: Tools.gated(t.tool), title: t.title,
    does: tool.does ? tool.does(t, day, plan) : '', cost: tool.cost ? { ...tool.cost } : null,
    status: t.status, statusWords: TASK_WORDS[t.status] || t.status, deps: par(t.deps, []), input: maskInput(par(t.input, null)), needsDetails: !!tool.prepare, scheduled: !!tool.scheduled, approvedAt: S.iso(t.approvedAt), summary: out ? out.summary || '' : '', refs: out ? out.refs || [] : [], data: out ? out.data || null : null,
    error: t.error || '', errorCode: t.errorCode || '', attempts: S.num(t.attempts), scheduledAt: S.iso(t.scheduledAt), startedAt: S.iso(t.startedAt), finishedAt: S.iso(t.finishedAt), note: t.note || '', cancelRequested: S.num(t.cancelRequested) === 1,
  };
}
function runView(u, r) {
  const plan = par(r.plan, null);
  return {
    id: r.id, businessKey: r.businessKey, businessName: r.businessName, goal: r.goal, intent: r.intent, intentLabel: (P.INTENTS[r.intent] || {}).label || '', status: r.status, statusWords: RUN_WORDS[r.status] || r.status,
    params: par(r.params, {}), plan, questions: par(r.questions, []), summary: par(r.summary, null), createdByName: r.createdByName || '', mine: r.createdById === u.id,
    approvedByName: r.approvedByName || '', approvedAt: S.iso(r.approvedAt), startedAt: S.iso(r.startedAt), finishedAt: S.iso(r.finishedAt), cancelledAt: S.iso(r.cancelledAt), cancelReason: r.cancelReason || '', createdAt: S.iso(r.createdAt), updatedAt: S.iso(r.updatedAt),
    canAct: mayWrite(u) && (A.isAdmin(u) || r.createdById === u.id),
  };
}

// the business facts the steps are built from, saved with the plan so that what runs is what was previewed
const snapshotOf = (biz) => ({
  name: biz.name, industry: (biz.context.industry || ''), audience: biz.context.audience || '', contactLine: biz.context.contactLine || '', tone: biz.context.tone || '', language: biz.context.language || 'English',
  services: biz.context.services || [], locations: biz.context.locations || [], website: biz.context.website || '', colors: biz.context.colors || null, hasLogo: !!biz.context.hasLogo,
  projectId: (biz.info && biz.info.project && biz.info.project.id) || '', industryKey: Blog.guessIndustry(biz.context.industry || ''),
});

// ---- the words the agent says (narration of real state, never invented) --------------------------------------------------------------------------------------------------
function knownLine(biz) {
  const bits = Object.keys(biz.sources || {}).filter((k) => Ctx.FIELDS[k]).map((k) => Ctx.FIELDS[k].label.toLowerCase());
  return bits.length ? `I already know: ${bits.slice(0, 8).join(', ')}.` : 'I do not know anything about this business yet.';
}
function narrate(built, biz) {
  const pr = built.parsed; const where = pr.platforms.length ? ` on ${P.listText(pr.platforms.map((x) => P.PLATFORM_WORDS[x]))}` : '';
  const head = `I read this as: ${pr.label}${pr.intent === 'seo' ? '' : pr.intent === 'videos' ? `, ${plural(pr.days, 'video')}` : `, ${plural(pr.days, 'day')}`}${where}.${pr.clamped ? ` I planned the first ${P.MAX_DAYS} days: ask for the next block afterwards.` : ''} ${knownLine(biz)}`;
  const req = built.questions.filter((q) => q.required); const opt = built.questions.filter((q) => !q.required);
  if (req.length) return `${head}\n\nBefore I can plan I need ${plural(req.length, 'thing')} from you (I save them, so you never explain twice).`;
  const p = built.plan;
  return `${head}\n\nHere is the plan: ${p.title}. Nothing happens until you press "Approve and run". ${p.gaps.length ? `${plural(p.gaps.length, 'thing')} I did not know ${p.gaps.length === 1 ? 'is' : 'are'} listed in the plan.` : ''}${opt.length ? ` You can add ${plural(opt.length, 'more fact')} (optional) to make it better.` : ''}`.trim();
}

// ---- creating tasks from a plan -------------------------------------------------------------------------------------------------------------------------------------------------
async function makeTasks(runId, plan) {
  await S.run(`DELETE FROM "${TK}" WHERE runId = ?`, runId);
  const now = Date.now(); const specs = P.taskSpecs(plan); const rows = [];
  for (const s of specs) {
    const d = s.day ? Tools.dayOf(plan, s.day) : null; const tool = Tools.TOOLS[s.tool];
    const id = ids('agt'); rows.push(id);
    await S.run(`INSERT INTO "${TK}" (id, runId, n, day, tool, title, status, deps, scheduledAt, note, args, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, runId, s.n, s.day || null, s.tool, clip(s.title, 200), 'planned', JSON.stringify(s.deps || []), s.at || (d && tool && (tool.manual || tool.scheduled) ? d.atMs : null), s.note || null, s.args ? JSON.stringify(s.args) : null, now, now); // eslint-disable-line no-await-in-loop
  }
  return specs.length;
}

// ---- preflight: what would stop the plan, what to know first -----------------------------------------------------------------------------------------------------------
async function preflight(u, plan, ctx = {}) {
  const blockers = []; const warnings = [];
  if (!plan) return { blockers: ['There is no plan yet.'], warnings };
  if (!mayWrite(u)) blockers.push('Your login can look at the agent but not run it.');
  for (const t of new Set(P.taskSpecs(plan).map((x) => x.tool))) {
    const tool = Tools.TOOLS[t];
    if (tool && tool.available) { const a = await tool.available({ u, svc: ctx.svc }); if (!a.ok) blockers.push(`${tool.label}: ${a.reason}`); } // eslint-disable-line no-await-in-loop
  }
  if (plan.intent === 'seo' && !(plan.seo && plan.seo.url)) blockers.push('There is no website address to check.');
  const set = await Cfg.getSettings();
  if (plan.days.length && plan.params.approver !== 'client' && Cfg.clientNeeded(set, 'words')) warnings.push('Your company requires the CLIENT to approve words: the "ask the team to approve" step will wait for you to use "Ask client to approve" on the draft.');
  if (plan.days.length && plan.params.approver !== 'client' && plan.params.creative !== 'none' && Cfg.clientNeeded(set, 'pictures')) warnings.push('Your company requires the CLIENT to approve pictures: the picture will wait for "Ask client to approve".');
  if (plan.biz && plan.biz.projectId === '' && plan.businessKey !== Ctx.OWN && plan.params.creative !== 'none') warnings.push('This client has no logo or colours saved (no client project), so banners use TeamLink\'s own brand colours. Make a client project with their logo first, or choose "no pictures".');
  const specs = P.taskSpecs(plan);
  if (specs.some((x) => x.tool === 'social.post') && !set.autoPostAllowed) warnings.push('Posting from TeamLink is switched off (an Admin turns it on in AI usage > Posting to client accounts). The posting steps cannot be approved until then.');
  if (specs.some((x) => x.tool === 'social.post')) warnings.push('Posting steps: nothing goes public until you approve each post, pick its accounts, and the picture is approved. A post goes out at its scheduled time.');
  if (specs.some((x) => x.tool === 'whatsapp.campaign')) { let on = null; try { const st = ctx.svc && ctx.svc.waSettings ? await ctx.svc.waSettings() : await require('../omniwa/assist').settings(); on = !!(st && st.campaignsOn); } catch { on = null; } warnings.push(on === false ? 'WhatsApp campaign: WhatsApp promotions are switched off (an Admin turns them on in Settings > WhatsApp AI > Marketing assistant), so the campaign step cannot be approved yet; a person sends the approved message by hand.' : 'WhatsApp campaign: the agent only saves it as ready after you pick the template and see every person and the exact words; a person presses Send in WhatsApp > Campaigns.'); } // eslint-disable-line global-require
  if (specs.some((x) => x.tool === 'seo.google')) { let on = false; try { on = !!(await (ctx.svc && ctx.svc.googleStatus ? ctx.svc.googleStatus() : require('./googleAuth').status())).configured; } catch { on = false; } if (!on) warnings.push('Google numbers: no Google key is saved yet (Administration > Integrations), so that step will only say so.'); } // eslint-disable-line global-require
  if (specs.some((x) => x.tool === 'calling.sheet')) warnings.push('Call sheet: built when the plan ends (or when you press "Build it now"). It lists leads for your team to call from the CRM: the agent calls nobody.');
  if (specs.some((x) => x.tool === 'client.review')) warnings.push('Client approval: each picture is sent to the client on WhatsApp only after you approve that step and confirm who it goes to.');
  plan.days.forEach((d) => { const stops = (d.flags || []).filter((f) => f.level === 'stop'); if (stops.length) warnings.push(`${d.title.split(':')[0]}: the wording check says "${stops[0].match}" must change before it is posted.`); });
  return { blockers, warnings };
}

// ---- starting, answering, re-planning ------------------------------------------------------------------------------------------------------------------------------------
async function resolveBiz(u, ref, nameHint) { return Ctx.resolve(u, ref, nameHint); }
// what the controls start as: the agent posts only if an Admin allowed posting AND an account is connected; the client approves only for a client when the company requires it
async function defaultsFor(u, biz, opts = {}) {
  let publish = 'manual'; let approver = 'team';
  try {
    const set = await Cfg.getSettings();
    const acc = await (opts.svc && opts.svc.accounts ? opts.svc.accounts(u) : require('./projects').accounts(u)); // eslint-disable-line global-require
    if (set.autoPostAllowed && acc && (acc.accounts || []).length) publish = 'agent';
    if (biz.key !== Ctx.OWN && Cfg.clientNeeded(set, 'pictures')) approver = 'client';
  } catch { /* the defaults stay on the safe side */ }
  return { publish, approver };
}

async function start1(u, { goal, business, businessName, params } = {}, opts = {}) {
  await ensure();
  if (!mayWrite(u)) return { error: 'Your login can look at the agent but not give it goals.', status: 403 };
  const text = clip(goal, 400);
  if (text.length < 6) return { error: 'Type what you want to achieve, for example "Promote my business for seven days".', status: 400 };
  const running = S.num(((await S.q(`SELECT COUNT(*) AS n FROM "${R}" WHERE createdById = ? AND status = 'running' AND deletedAt IS NULL`, u.id))[0] || {}).n);
  if (running >= config.maxRunning) return { error: `You already have ${running} runs working. Wait for one to finish or cancel one.`, status: 429 };
  let biz = await resolveBiz(u, business, businessName);
  // a client is remembered by name from the first goal on (so its facts are found again under the same name)
  if (biz.key !== Ctx.OWN && !biz.saved && biz.name) { const sv = await Ctx.save(u, biz.key, { name: biz.name }, { quiet: true }); if (!sv.error) biz = sv; }
  const built = P.build(text, biz.context, { ...(await defaultsFor(u, biz, opts)), ...(params || {}) }, opts.now || Date.now());
  const id = ids('agr'); const now = Date.now(); const plan = built.plan ? { ...built.plan, businessKey: biz.key, biz: snapshotOf(biz) } : null;
  await S.run(`INSERT INTO "${R}" (id, businessKey, businessName, goal, intent, status, params, plan, questions, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, biz.key, clip(biz.name, 80), text, built.parsed.intent, plan ? 'preview' : 'needs_info', JSON.stringify(plan ? plan.params : P.paramsFor(built.parsed, params || {}, opts.now || now)), plan ? JSON.stringify(plan) : null, JSON.stringify(built.questions), u.id, clip(u.name, 80), now, now);
  await say(id, 'user', text);
  await say(id, 'agent', narrate(built, biz), { questions: built.questions.map((q) => q.key) });
  if (plan) await makeTasks(id, plan);
  await event(id, null, 'created', u.name, plan ? `Plan made: ${plan.title}` : 'Waiting for the answers to the questions');
  await audit(u, 'goal given', { id }, `${built.parsed.label} for ${biz.name}: ${text}`);
  return { run: runView(u, await runRow(id)), ...(await detail(u, id, opts)) };
}

async function mineRun(u, id) { await ensure(); const r = await runRow(id); return visible(u, r) ? r : null; }
async function editable(u, id) {
  const r = await mineRun(u, id);
  if (!r) return { error: 'That run was not found.', status: 404 };
  if (!mayWrite(u) || !(A.isAdmin(u) || r.createdById === u.id)) return { error: 'Only the person who gave the goal, or an Admin, can change it.', status: 403 };
  return { r };
}
const planStage = (r) => ['needs_info', 'preview'].includes(r.status);

// answers: { key: value }, skip: [key]. Saves the facts for the business, then plans again.
async function answer(u, id, { answers, skip, params } = {}, opts = {}) {
  const e = await editable(u, id); if (e.error) return e; const r = e.r;
  if (!planStage(r)) return { error: 'This run has already been approved, so its plan cannot change. Start a new goal instead.', status: 409 };
  const patch = { ...(answers && typeof answers === 'object' ? answers : {}) };
  const skips = (Array.isArray(skip) ? skip : []).map(String);
  if (skips.length) patch.skips = skips;
  let saved = null;
  if (Object.keys(patch).length) {
    saved = await Ctx.save(u, r.businessKey, patch); if (saved.error) return saved;
    await say(r.id, 'user', `${Object.keys(answers || {}).length ? `Answers: ${Object.keys(answers).map((k) => (Ctx.FIELDS[k] || { label: k }).label).join(', ')}.` : ''}${skips.length ? ` Skipped: ${skips.map((k) => (Ctx.FIELDS[k] || { label: k }).label).join(', ')}.` : ''}`.trim());
  }
  return replan(u, r, params, opts);
}
async function replan(u, r, params, opts = {}) {
  const biz = await resolveBiz(u, r.businessKey);
  const given = { ...par(r.params, {}), ...(params && typeof params === 'object' ? params : {}) };
  const built = P.build(r.goal, biz.context, given, opts.now || Date.now());
  const plan = built.plan ? { ...built.plan, businessKey: biz.key, biz: snapshotOf(biz) } : null;
  await S.run(`UPDATE "${R}" SET status = ?, businessName = ?, params = ?, plan = ?, questions = ?, updatedAt = ? WHERE id = ?`, plan ? 'preview' : 'needs_info', clip(biz.name, 80), JSON.stringify(plan ? plan.params : given), plan ? JSON.stringify(plan) : null, JSON.stringify(built.questions), Date.now(), r.id);
  if (plan) await makeTasks(r.id, plan); else await S.run(`DELETE FROM "${TK}" WHERE runId = ?`, r.id);
  await say(r.id, 'agent', narrate(built, biz), { questions: built.questions.map((q) => q.key) });
  await event(r.id, null, 'replanned', u.name, plan ? `Plan made again: ${plan.title}` : 'Still waiting for answers');
  return detail(u, r.id, opts);
}
async function changePlan(u, id, params, opts) {
  const e = await editable(u, id); if (e.error) return e;
  if (!planStage(e.r)) return { error: 'This run has already been approved, so its plan cannot change.', status: 409 };
  return replan(u, e.r, params, opts);
}

// edit one day of the plan before approving: the words per platform, the headline, the date and time
async function editDay(u, id, n, b = {}) {
  const e = await editable(u, id); if (e.error) return e; const r = e.r;
  if (r.status !== 'preview') return { error: 'Days can be edited while the plan is waiting for approval.', status: 409 };
  const plan = par(r.plan, null); const d = plan && Tools.dayOf(plan, Number(n)); if (!d) return { error: 'That day is not in the plan.', status: 404 };
  if (b.texts && typeof b.texts === 'object') {
    for (const pl of d.platforms) {
      if (b.texts[pl] === undefined) continue;
      const t = String(b.texts[pl] || '').replace(/\r/g, '').trim();
      if (!t) return { error: `The ${P.PLATFORM_WORDS[pl]} text cannot be empty.`, status: 400 };
      if (t.length > P.PLATFORM_LIMIT[pl]) return { error: `The ${P.PLATFORM_WORDS[pl]} text is over its limit of ${P.PLATFORM_LIMIT[pl]} letters.`, status: 400 };
      d.texts[pl] = t;
    }
    d.flags = P.flagsOf(d.texts[d.platforms[0]], plan.biz && plan.biz.industry, plan.healthcare);
  }
  if (b.headline !== undefined) { const h = clip(b.headline, 90); if (h.length < 3) return { error: 'The headline needs a few words.', status: 400 }; d.headline = h; d.title = clip(`${d.title.split(':')[0]}: ${h}`, 80); }
  if (b.date !== undefined || b.time !== undefined) {
    const date = b.date !== undefined ? String(b.date) : d.date; const time = b.time !== undefined ? String(b.time) : d.time;
    if (!P.validDay(date)) return { error: 'The date must look like 2026-12-01.', status: 400 };
    if (!P.validTime(time)) return { error: 'The time must look like 10:30.', status: 400 };
    d.date = date; d.time = time; d.atMs = P.atOf(date, time); d.label = `${P.dayWords(date)}, ${time} IST`;
  }
  await S.run(`UPDATE "${R}" SET plan = ?, updatedAt = ? WHERE id = ?`, JSON.stringify(plan), Date.now(), r.id);
  await S.run(`UPDATE "${TK}" SET scheduledAt = ? WHERE runId = ? AND day = ? AND tool IN ('manual.post','manual.video')`, d.atMs, r.id, d.n);
  await event(r.id, null, 'day_edited', u.name, `${d.title} edited before approval`);
  return detail(u, r.id);
}

// free words typed in the chat: an answer when exactly one question is open, a plain change ("make it 5 days", "only Instagram"), never an approval
async function talk(u, id, text, opts = {}) {
  const e = await editable(u, id); if (e.error) return e; const r = e.r;
  const t = clip(text, 600); if (!t) return { error: 'Type a message first.', status: 400 };
  await say(r.id, 'user', t);
  const lower = t.toLowerCase();
  if (/^(yes|ok|okay|go|go ahead|approve|approved|run( it)?|do it|start|proceed|confirm)\b/.test(lower) || /\bapprove (it|the plan|and run)\b/.test(lower)) {
    await say(r.id, 'agent', r.status === 'preview' ? 'I never start from typed words. To run the plan, read it and press the "Approve and run" button: that button is the approval, and it is recorded with your name.' : 'There is nothing waiting for an approval in this run.');
    return detail(u, r.id);
  }
  if (planStage(r)) {
    const open = par(r.questions, []).filter((q) => q.required);
    if (r.status === 'needs_info' && open.length === 1 && !/^(skip|no|none|n\/a)$/i.test(t)) return answer(u, id, { answers: { [open[0].key]: t } }, opts);
    const change = {}; const days = P.parse(t); const given = /\b\d+\s*[- ]?days?\b|\bweek\b|\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen)[- ]days?\b/i.test(t);
    if (given && r.intent !== 'seo') change.days = days.days;
    if (/\bonly\b/i.test(t) && days.platformsGiven) change.platforms = days.platforms; else if (days.platformsGiven && /\badd\b|\balso\b|\band\b/i.test(t)) change.platforms = [...new Set([...(par(r.params, {}).platforms || []), ...days.platforms])];
    if (Object.keys(change).length) return replan(u, r, change, opts);
  }
  await say(r.id, 'agent', planStage(r) ? 'I kept your message with this goal. To change the plan use the days, platforms and picture choices on the plan, or edit a day. I do not change the plan from guesses.' : 'I kept your message with this goal.');
  return detail(u, r.id);
}

// ---- approving, running ------------------------------------------------------------------------------------------------------------------------------------------------------------
async function approve(u, id, opts = {}) {
  const e = await editable(u, id); if (e.error) return e; const r = e.r;
  if (r.status !== 'preview') return { error: r.status === 'running' ? 'This run is already running.' : r.status === 'needs_info' ? 'Answer the questions first: there is no plan yet.' : 'Only a plan that is waiting for approval can be approved.', status: 409 };
  const plan = par(r.plan, null);
  const pf = await preflight(u, plan, opts); if (pf.blockers.length) return { error: `The plan cannot run yet: ${pf.blockers.join(' ')}`, status: 409, code: 'blocked', blockers: pf.blockers };
  const running = S.num(((await S.q(`SELECT COUNT(*) AS n FROM "${R}" WHERE createdById = ? AND status = 'running' AND deletedAt IS NULL`, r.createdById))[0] || {}).n);
  if (running >= config.maxRunning) return { error: `${running} runs are already working. Wait for one to finish.`, status: 429 };
  const tasks = await tasksOf(r.id); if (!tasks.length) return { error: 'The plan has no steps.', status: 409 };
  const now = Date.now();
  for (const t of tasks) {
    const tool = Tools.TOOLS[t.tool]; const d = t.day ? Tools.dayOf(plan, t.day) : null;
    const input = tool && tool.build ? tool.build(plan, d, plan.biz || {}, par(t.args, {})) : {};
    await S.run(`UPDATE "${TK}" SET status = ?, input = ?, updatedAt = ? WHERE id = ?`, tool && tool.manual ? 'waiting' : 'queued', JSON.stringify(input), now, t.id); // eslint-disable-line no-await-in-loop
  }
  await S.run(`UPDATE "${R}" SET status = 'running', approvedById = ?, approvedByName = ?, approvedAt = ?, startedAt = ?, finishedAt = NULL, updatedAt = ? WHERE id = ?`, u.id, clip(u.name, 80), now, now, now, r.id);
  const auto = tasks.filter((t) => !(Tools.TOOLS[t.tool] || {}).manual).length;
  await event(r.id, null, 'approved', u.name, `Plan approved by ${u.name}: ${plural(auto, 'step')} will run, ${plural(tasks.length - auto, 'step')} are for people.`);
  await say(r.id, 'agent', `Approved by ${u.name}. I am running ${plural(auto, 'step')} now (drafts, pictures and approval requests inside TeamLink). Nothing is posted, sent or spent. ${plural(tasks.length - auto, 'step')} wait for you.`);
  await audit(u, 'plan approved', r, `${plan.title}; ${plural(auto, 'step')} to run`);
  kick(r.id, opts);
  return detail(u, r.id);
}

let chain = Promise.resolve(); const queued = new Set(); const again = new Set(); const inflight = new Set(); let runOpts = {};
function kick(runId, opts = {}) {
  runOpts = { ...runOpts, ...opts };
  if (queued.has(runId)) { again.add(runId); return; } // asked again while it is being worked on (a step was approved, or "Build it now" pressed): it looks once more when it finishes
  queued.add(runId);
  chain = chain.then(() => processRun(runId)).catch((e) => { console.error('[omni-mk] agent run:', e.message); }).finally(() => { queued.delete(runId); if (again.delete(runId)) kick(runId); }); // eslint-disable-line no-console
}
async function drain() { let c; do { c = chain; await c; } while (c !== chain); } // tests wait for the background work

async function actorOf(run, opts, userId) {
  if (opts.actorFor) return opts.actorFor(run, userId);
  try {
    const { resolveIdentity } = require('../utils/identity'); // eslint-disable-line global-require
    await A.warm();
    const prisma = require('../db'); // eslint-disable-line global-require
    const row = await prisma.user.findFirst({ where: { id: userId || run.approvedById, status: 'Active' }, select: { id: true } });
    const ident = row ? await resolveIdentity(row.id) : null;
    return ident && mayWrite(ident) ? ident : null;
  } catch { return null; }
}
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => { setTimeout(() => rej(Object.assign(new Error(`${what} took too long (over ${Math.round(ms / 1000)} seconds).`), { code: 'timeout', retryable: true })), ms).unref(); })]);

async function processRun(runId) {
  const opts = runOpts;
  for (let guard = 0; guard < 500; guard += 1) {
    const run = await runRow(runId); if (!run || !['running', 'attention'].includes(run.status)) break; // 'attention' is looked at too: a step approved just as the run was being closed up must not be lost
    const tasks = await tasksOf(runId);
    const byN = new Map(tasks.map((t) => [S.num(t.n), t]));
    let next = null; let changed = false;
    for (const t of tasks) {
      if (t.status !== 'queued') continue;
      const deps = par(t.deps, []).map((n) => byN.get(n)).filter(Boolean);
      if (deps.some((x) => ['failed', 'cancelled', 'skipped'].includes(x.status))) { await S.run(`UPDATE "${TK}" SET status = 'skipped', error = ?, updatedAt = ? WHERE id = ? AND status = 'queued'`, 'A step it needs did not finish.', Date.now(), t.id); await event(runId, t.id, 'task_skipped', null, `${t.title}: skipped, a step it needs did not finish.`); changed = true; break; } // eslint-disable-line no-await-in-loop
      if (deps.some((x) => x.status !== 'done')) continue;
      if (Tools.gated(t.tool) && !t.approvedAt) { await S.run(`UPDATE "${TK}" SET status = 'awaiting_approval', updatedAt = ? WHERE id = ? AND status = 'queued'`, Date.now(), t.id); await event(runId, t.id, 'needs_approval', null, `${t.title}: ${Tools.isOutward(t.tool) ? 'reaches outside TeamLink' : 'freezes who a message will go to and its words'}, so it waits for its own approval.`); changed = true; break; } // eslint-disable-line no-await-in-loop
      if ((Tools.TOOLS[t.tool] || {}).scheduled && S.ms(t.scheduledAt) > config.clock()) continue; // (approved,) but its time has not come: it stays queued and the next sweep looks again
      next = t; break;
    }
    if (changed) continue;
    if (!next) break;
    if (run.status === 'attention') await S.run(`UPDATE "${R}" SET status = 'running', updatedAt = ? WHERE id = ? AND status = 'attention'`, Date.now(), runId); // there is work again
    await runTask(run, next, tasks, opts); // eslint-disable-line no-await-in-loop
  }
  await finishCheck(runId, opts);
}

// what a tool is given: who it runs as, the plan and day it belongs to, the outputs of the day's earlier steps, and the stand-ins a test passes
function toolCtx(u, run, t, tasks, opts, base, query) {
  const plan = par(run.plan, null); const sameDay = tasks.filter((x) => t.day && x.day === t.day);
  return { u, plan, day: t.day && plan ? Tools.dayOf(plan, t.day) : null, run: { id: run.id, goal: run.goal, startedAt: S.ms(run.startedAt) || S.ms(run.approvedAt) || 0 }, task: { id: t.id, n: S.num(t.n), day: t.day }, dayTasks: sameDay.map((x) => ({ tool: x.tool, status: x.status, output: par(x.output, null) })), fetchFn: opts.fetchFn, googleOpts: opts.googleFetch || opts.googleKey ? { fetchFn: opts.googleFetch, key: opts.googleKey } : null, svc: opts.svc, base: base || '', query: query || {} };
}
async function runTask(run, t, tasks, opts) {
  if (Tools.gated(t.tool) && !t.approvedAt) { await S.run(`UPDATE "${TK}" SET status = 'awaiting_approval', updatedAt = ? WHERE id = ?`, Date.now(), t.id); return; } // defence in depth: never without its own approval
  const got = await S.run(`UPDATE "${TK}" SET status = 'running', attempts = attempts + 1, startedAt = ?, error = NULL, errorCode = NULL, updatedAt = ? WHERE id = ? AND status = 'queued'`, Date.now(), Date.now(), t.id);
  if (!got) return;
  inflight.add(t.id);
  const tool = Tools.TOOLS[t.tool]; const attempts = S.num(t.attempts) + 1; const outward = Tools.gated(t.tool);
  await event(run.id, t.id, 'task_started', outward ? null : run.approvedByName, `${t.title}${attempts > 1 ? ` (try ${attempts})` : ''}`);
  const done = async (status, fields = {}) => {
    await S.run(`UPDATE "${TK}" SET status = ?, output = ?, error = ?, errorCode = ?, finishedAt = ?, updatedAt = ? WHERE id = ?`, status, fields.output ? JSON.stringify(fields.output) : null, fields.error || null, fields.code || null, Date.now(), Date.now(), t.id);
    await touch(run.id);
  };
  try {
    // an outward step runs as the person who approved THAT step; every other step as the person who approved the plan
    const u = await actorOf(run, opts, outward ? t.approvedById : null);
    if (!u) { await done('failed', { error: 'The person who approved this can no longer use AI Marketing, so the steps stopped. An Admin can retry them after approving again.', code: 'no_actor' }); await event(run.id, t.id, 'task_failed', null, `${t.title}: stopped, nobody allowed to run it.`); return; }
    if (!tool || !tool.run) throw new Tools.ToolError('That tool is not available.', 'no_tool');
    const fresh0 = await tasksOf(run.id); // the earlier steps of the same day may have finished since `tasks` was read
    const input = par(t.input, {});
    const ctx = toolCtx(u, run, t, fresh0, opts, input.base);
    const out = await withTimeout(tool.run(ctx, input), t.tool === 'image.ai' ? config.imageMs : config.taskMs, tool.label);
    await done('done', { output: out });
    await event(run.id, t.id, 'task_done', outward ? run.approvedByName : run.approvedByName, `${t.title}: ${out.summary || 'done'}`);
    const fresh = await taskRow(t.id);
    if (fresh && S.num(fresh.cancelRequested) === 1) await event(run.id, t.id, 'note', null, `${t.title} had already started when it was cancelled: it finished and its result is kept.`);
  } catch (e) {
    const code = e.code || 'failed'; const msg = clip(e.message || 'It did not work.', 400);
    if (e.waiting) { await S.run(`UPDATE "${TK}" SET status = 'waiting', error = ?, errorCode = ?, finishedAt = ?, updatedAt = ? WHERE id = ?`, msg, code, Date.now(), Date.now(), t.id); await event(run.id, t.id, 'task_waiting', null, `${t.title}: ${msg}`); }
    else if (e.retryable && !outward && attempts <= config.backoff.length) {
      await S.run(`UPDATE "${TK}" SET status = 'queued', error = ?, errorCode = ?, updatedAt = ? WHERE id = ?`, msg, code, Date.now(), t.id);
      await event(run.id, t.id, 'task_retry', null, `${t.title}: ${msg} Trying again in ${Math.round(config.backoff[attempts - 1] / 1000)} seconds.`);
      inflight.delete(t.id); await sleep(config.backoff[attempts - 1]); return;
    } else { await done('failed', { error: msg, code }); await event(run.id, t.id, 'task_failed', null, `${t.title}: ${msg}`); }
  } finally { inflight.delete(t.id); }
}

// the state of a run from its steps; the summary is rewritten, the person is told once per change
async function finishCheck(runId, opts = {}) {
  const run = await runRow(runId); if (!run || !['running', 'attention', 'done'].includes(run.status)) return;
  const tasks = await tasksOf(runId); if (!tasks.length) return;
  if (tasks.some((t) => ['queued', 'running'].includes(t.status))) { // work is pending (running, or waiting for its time): the run is running
    if (run.status === 'attention') await S.run(`UPDATE "${R}" SET status = 'running', updatedAt = ? WHERE id = ? AND status = 'attention'`, Date.now(), runId);
    return;
  }
  const allEnd = tasks.every((t) => TERMINAL.includes(t.status));
  const next = allEnd ? 'done' : 'attention';
  const summary = await summarize(run, tasks);
  const prev = par(run.summary, null);
  // decided from a snapshot of the steps: the update itself refuses if a step was queued in the meantime (an approval that came in while this was being worked out), and the run is looked at again
  const upd = await S.run(`UPDATE "${R}" SET status = ?, summary = ?, finishedAt = ?, updatedAt = ? WHERE id = ? AND status IN ('running','attention','done') AND NOT EXISTS (SELECT 1 FROM "${TK}" x WHERE x.runId = "${R}".id AND x.status IN ('queued','running'))`, next, JSON.stringify({ ...summary, noticeFor: prev && prev.noticeFor }), allEnd ? Date.now() : null, Date.now(), runId);
  if (!upd) { kick(runId, opts); return; }
  if (!prev || prev.noticeFor !== next) {
    await say(runId, 'agent', `${next === 'done' ? 'All steps are finished.' : 'The steps that could run have run. Some need you.'}\n${summary.lines.join('\n')}`);
    await event(runId, null, next === 'done' ? 'finished' : 'attention', null, summary.lines[0] || next);
    await S.run(`UPDATE "${R}" SET summary = ? WHERE id = ?`, JSON.stringify({ ...summary, noticeFor: next }), runId);
    try {
      const notify = opts.notify || require('../utils/notify').notifyUsers; // eslint-disable-line global-require
      await notify([run.createdById].filter(Boolean), { title: next === 'done' ? `AI Agent finished: ${clip(run.businessName, 40)}` : `AI Agent needs you: ${clip(run.businessName, 40)}`, message: `${clip(run.goal, 80)}. ${summary.lines[0] || ''} Open AI Marketing > AI Agent.` });
    } catch { /* the notice is a courtesy */ }
  }
}

// ---- results: what really happened, from the steps and from the live status of the items they made ---------------------------------------------------------------------
async function liveStatuses(tasks) {
  const want = { content: new Set(), image: new Set() };
  for (const t of tasks) for (const ref of (par(t.output, null) || {}).refs || []) if (want[ref.kind] && ref.id) want[ref.kind].add(ref.id);
  const out = { content: new Map(), image: new Map() };
  for (const [kind, table] of [['content', 'OmniMkContent'], ['image', 'OmniMkImage']]) {
    const list = [...want[kind]]; if (!list.length) continue;
    try { for (const r of await S.q(`SELECT id, status FROM "${table}" WHERE id IN (${list.map(() => '?').join(',')}) AND deletedAt IS NULL`, ...list)) out[kind].set(r.id, r.status); } catch { /* the table is not there */ }
  }
  return out;
}
async function resultsOf(runId) {
  return (await S.q(`SELECT at, byName, text FROM "${EV}" WHERE runId = ? AND kind = 'result' ORDER BY at`, runId)).map((e) => ({ at: S.iso(e.at), by: e.byName || '', ...(par(e.text, {}) || {}) }));
}
async function summarize(run, tasks, perf) {
  const live = await liveStatuses(tasks); const count = (s) => tasks.filter((t) => t.status === s).length;
  const doneOf = (tool) => tasks.filter((t) => t.tool === tool && t.status === 'done');
  const drafts = doneOf('content.draft'); const pics = [...doneOf('image.banner'), ...doneOf('image.ai')];
  const tally = { approved: 0, waiting: 0, changes: 0, draft: 0 };
  const stat = (kind, id) => { const s = live[kind].get(id); if (!s) return; if (s === 'approved') tally.approved += 1; else if (s === 'waiting') tally.waiting += 1; else if (s === 'changes') tally.changes += 1; else tally.draft += 1; };
  for (const t of drafts) stat('content', (par(t.output, {}).data || {}).itemId);
  for (const t of pics) stat('image', (par(t.output, {}).data || {}).itemId);
  const site = doneOf('seo.audit')[0] || doneOf('seo.sitecheck')[0]; const blog = doneOf('seo.blogplan')[0]; const kw = doneOf('seo.keywords')[0]; const seoText = doneOf('seo.content')[0];
  const sheetTask = doneOf('calling.sheet')[0]; const callsTotal = tasks.filter((t) => t.tool === 'manual.calls').length; const callsDone = doneOf('manual.calls').length; const clipCount = doneOf('video.clips').reduce((a, t) => a + (((par(t.output, {}).data || {}).clips) || []).length, 0);
  const waTotal = tasks.filter((t) => t.tool === 'manual.whatsapp').length; const waDone = doneOf('manual.whatsapp').length;
  const posted = doneOf('manual.post').length + doneOf('social.post').length; const postsTotal = tasks.filter((t) => t.tool === 'manual.post' || t.tool === 'social.post').length;
  const toClient = doneOf('client.review').length;
  const videos = doneOf('manual.video').length; const videosTotal = tasks.filter((t) => t.tool === 'manual.video').length;
  const results = await resultsOf(run.id);
  const outwardDone = tasks.filter((t) => Tools.isOutward(t.tool) && t.status === 'done').length;
  const numbers = {
    tasks: { total: tasks.length, done: count('done'), failed: count('failed'), waiting: count('waiting'), awaiting: count('awaiting_approval'), cancelled: count('cancelled'), skipped: count('skipped'), queued: count('queued'), running: count('running') },
    made: { drafts: drafts.length, pictures: pics.length }, approval: tally, posted: { done: posted, of: postsTotal, byAgent: doneOf('social.post').length }, toClient, whatsapp: { done: waDone, of: waTotal }, waCampaign: doneOf('whatsapp.campaign')[0] ? (par(doneOf('whatsapp.campaign')[0].output, {}).data || {}) : null, callSheet: sheetTask ? (par(sheetTask.output, {}).data || {}).rows : null, calls: { done: callsDone, of: callsTotal }, clips: clipCount, keywords: kw ? (par(kw.output, {}).data || {}).kept : null, seoTexts: seoText ? ((par(seoText.output, {}).data || {}).saved || []).length : null, performance: perf || null, videos: { done: videosTotal ? videos : 0, of: videosTotal }, siteScore: site ? (par(site.output, {}).data || {}).score : null, blogBriefs: blog ? (par(blog.output, {}).data || {}).briefs : null, results, outward: outwardDone,
  };
  const lines = [];
  lines.push(`${numbers.tasks.done} of ${plural(numbers.tasks.total, 'step')} done${numbers.tasks.failed ? `, ${numbers.tasks.failed} failed` : ''}${numbers.tasks.waiting ? `, ${numbers.tasks.waiting} waiting for a person` : ''}${numbers.tasks.cancelled ? `, ${numbers.tasks.cancelled} cancelled` : ''}${numbers.tasks.skipped ? `, ${numbers.tasks.skipped} skipped` : ''}.`);
  if (drafts.length || pics.length) lines.push(`Made inside TeamLink: ${plural(drafts.length, 'draft')} in AI Content and ${plural(pics.length, 'picture')} in AI Images.`);
  if (drafts.length || pics.length) lines.push(`Approval right now: ${tally.approved} approved, ${tally.waiting} waiting for the team, ${tally.changes} sent back${tally.draft ? `, ${tally.draft} still drafts` : ''}.`);
  if (toClient) lines.push(`Sent to the client to approve: ${plural(toClient, 'picture')}, each after your approval of that step.`);
  if (postsTotal) lines.push(`Posted: ${posted} of ${postsTotal} posting steps${numbers.posted.byAgent ? ` (${numbers.posted.byAgent} by the agent after your approval of each post, the rest marked by the person who posted)` : ' (marked by the person who posted)'}.`);
  if (videosTotal) lines.push(`Videos made: ${videos} of ${videosTotal} (put together by a person in AI Video).`);
  if (numbers.waCampaign) lines.push(`WhatsApp campaign prepared: ${plural(numbers.waCampaign.people, 'customer')} who agreed to promotions, saved as READY in WhatsApp > Campaigns. Nothing was sent: a person presses Send.`);
  if (numbers.callSheet != null) lines.push(`Call sheet: ${numbers.callSheet} lead${numbers.callSheet === 1 ? '' : 's'} to call (Hot or Warm, new since the plan started). The agent calls nobody: your team calls from the CRM.`);
  if (callsTotal) lines.push(`Calls made by your team: ${callsDone} of ${callsTotal} (marked by a person).`);
  if (clipCount) lines.push(`Stock clips saved: ${clipCount} (raw footage in AI Images: approve before use).`);
  if (waTotal) lines.push(`WhatsApp messages sent: ${waDone} of ${waTotal} (a person sends them from Campaigns after approval: the agent never sends WhatsApp).`);
  if (numbers.keywords != null) lines.push(`Keyword ideas kept in the SEO assistant: ${numbers.keywords} new (no search volumes: TeamLink has no source for them).`);
  if (numbers.seoTexts) lines.push(`Texts for the website kept in the SEO assistant: ${plural(numbers.seoTexts, 'text')} (nothing was changed on the website).`);
  if (numbers.siteScore != null) lines.push(`Website check: ${numbers.siteScore}/100, TeamLink's own score of what is on the page (not rankings or traffic).`);
  if (numbers.blogBriefs != null) lines.push(`Blog plan: ${plural(numbers.blogBriefs, 'brief')} planned (nothing written or posted).`);
  if (results.length) lines.push(`Results typed in by the team: ${results.slice(-4).map((x) => `${x.label}: ${x.value}${x.by ? ` (${x.by})` : ''}`).join('; ')}.`);
  else if (run.intent !== 'seo') lines.push('No results typed in yet: enquiries are added by hand under "Add a result", and reach / engagement are not connected yet.');
  Analytics.lines(perf, run).forEach((l) => lines.push(l)); // real numbers from the posting records, the clients' answers, the CRM and the saved audits
  lines.push(outwardDone ? `${plural(outwardDone, 'outward action')} went outside TeamLink, each with its own approval.` : 'Nothing was posted, sent, called or spent by the agent.');
  return { at: new Date().toISOString(), numbers, lines };
}

// ---- cancel, retry, manual steps ----------------------------------------------------------------------------------------------------------------------------------------------
async function cancelRun(u, id, reason) {
  const e = await editable(u, id); if (e.error) return e; const r = e.r;
  if (['cancelled'].includes(r.status)) return { error: 'This run is already cancelled.', status: 409 };
  if (r.status === 'done') return { error: 'This run is finished.', status: 409 };
  const now = Date.now();
  await S.run(`UPDATE "${TK}" SET status = 'cancelled', finishedAt = ?, updatedAt = ? WHERE runId = ? AND status IN ('planned','queued','waiting','awaiting_approval')`, now, now, r.id);
  await S.run(`UPDATE "${TK}" SET cancelRequested = 1, updatedAt = ? WHERE runId = ? AND status = 'running'`, now, r.id);
  await S.run(`UPDATE "${R}" SET status = 'cancelled', cancelledAt = ?, cancelReason = ?, updatedAt = ? WHERE id = ?`, now, clip(reason, 200) || null, now, r.id);
  const tasks = await tasksOf(r.id);
  const kept = tasks.filter((t) => t.status === 'done' && ((par(t.output, {}) || {}).refs || []).length).length;
  await event(r.id, null, 'cancelled', u.name, `Run cancelled by ${u.name}${reason ? `: ${clip(reason, 120)}` : ''}. ${kept ? `${plural(kept, 'finished step')} keep${kept === 1 ? 's' : ''} the draft or picture it made (they stay in AI Content / AI Images).` : ''}`.trim());
  await say(r.id, 'agent', `Cancelled. Steps that were waiting will not run.${tasks.some((t) => t.status === 'running') ? ' One step had already started: it finishes and its result is kept.' : ''}${kept ? ` ${plural(kept, 'draft or picture')} already made stay in AI Content and AI Images; delete them there if you do not want them.` : ''}`);
  await audit(u, 'run cancelled', r, `${r.goal}${reason ? `; ${clip(reason, 120)}` : ''}`);
  return detail(u, r.id);
}
async function discard(u, id) {
  const e = await editable(u, id); if (e.error) return e; const r = e.r;
  if (!['needs_info', 'preview', 'cancelled', 'done'].includes(r.status)) return { error: 'Cancel the run first.', status: 409 };
  await S.run(`UPDATE "${R}" SET deletedAt = ? WHERE id = ?`, Date.now(), r.id);
  await audit(u, 'run removed from the list', r, r.goal);
  return { ok: true };
}
async function taskAction(u, taskId) {
  await ensure(); const t = await taskRow(taskId); if (!t) return { error: 'That step was not found.', status: 404 };
  const e = await editable(u, t.runId); if (e.error) return e;
  return { t, r: e.r };
}
async function cancelTask(u, taskId) {
  const g = await taskAction(u, taskId); if (g.error) return g; const { t, r } = g;
  if (['done', 'cancelled', 'skipped'].includes(t.status)) return { error: `This step is already ${t.status === 'done' ? 'done' : t.status}.`, status: 409 };
  if (t.status === 'running') { await S.run(`UPDATE "${TK}" SET cancelRequested = 1, updatedAt = ? WHERE id = ?`, Date.now(), t.id); await event(r.id, t.id, 'cancel_requested', u.name, `${t.title}: cancel requested. It had already started, so it will finish and its result is kept.`); return detail(u, r.id); }
  await S.run(`UPDATE "${TK}" SET status = 'cancelled', finishedAt = ?, updatedAt = ? WHERE id = ?`, Date.now(), Date.now(), t.id);
  await event(r.id, t.id, 'task_cancelled', u.name, `${t.title}: cancelled by ${u.name}`);
  await audit(u, 'step cancelled', r, t.title);
  await finishCheck(r.id); kick(r.id);
  return detail(u, r.id);
}
async function retryTask(u, taskId, opts = {}) {
  const g = await taskAction(u, taskId); if (g.error) return g; const { t, r } = g;
  if (!['failed', 'skipped'].includes(t.status)) return { error: 'Only a failed or skipped step can be retried.', status: 409 };
  if (['cancelled', 'needs_info', 'preview'].includes(r.status)) return { error: 'This run is not running.', status: 409 };
  if (S.num(t.attempts) >= config.maxAttempts) return { error: `This step was tried ${config.maxAttempts} times. Fix the cause (see the error) or start a new goal.`, status: 409 };
  const now = Date.now();
  if (Tools.gated(t.tool)) { // a failed step that reaches outside TeamLink (or freezes who a message goes to) is never retried on the old approval: it asks again (an account that already got the post is skipped)
    await S.run(`UPDATE "${TK}" SET status = 'awaiting_approval', approvedById = NULL, approvedAt = NULL, error = NULL, errorCode = NULL, finishedAt = NULL, updatedAt = ? WHERE id = ?`, now, t.id);
    await event(r.id, t.id, 'task_retry_by_person', u.name, `${t.title}: ${u.name} asked to try again. It needs a fresh approval.`);
    await audit(u, 'outward step retry asked', r, t.title);
    return detail(u, r.id);
  }
  await S.run(`UPDATE "${TK}" SET status = 'queued', error = NULL, errorCode = NULL, finishedAt = NULL, updatedAt = ? WHERE id = ?`, now, t.id);
  await S.run(`UPDATE "${TK}" SET status = 'queued', error = NULL, updatedAt = ? WHERE runId = ? AND status = 'skipped'`, now, r.id);
  await S.run(`UPDATE "${R}" SET status = 'running', approvedById = ?, approvedByName = ?, updatedAt = ? WHERE id = ?`, u.id, clip(u.name, 80), now, r.id);
  await event(r.id, t.id, 'task_retry_by_person', u.name, `${t.title}: retried by ${u.name}`);
  await audit(u, 'step retried', r, t.title);
  kick(r.id, opts);
  return detail(u, r.id);
}
// an outward step waits for ITS OWN approval: the person sees what would go out (prepareTask), picks the accounts / confirms the recipient, and only then does it become queued.
// env: { base } the site address of the request (never from the body), plus the stand-ins of a test.
async function prepareTask(u, taskId, env = {}) {
  const g = await taskAction(u, taskId); if (g.error) return g; const { t, r } = g;
  const tool = Tools.TOOLS[t.tool];
  if (!tool || !Tools.gated(t.tool)) return { error: 'This step does not need an approval of its own.', status: 409 };
  const tasks = await tasksOf(r.id);
  const prep = tool.prepare ? await tool.prepare(toolCtx(u, r, t, tasks, env, env.base, env.query)) : { ready: true, reason: '' };
  return { task: taskView(t, par(r.plan, null)), ready: t.status === 'awaiting_approval' && prep.ready, status: t.status, ...prep, reason: t.status !== 'awaiting_approval' ? `This step is ${TASK_WORDS[t.status] || t.status}.` : prep.reason };
}
async function approveTask(u, taskId, body = {}, env = {}) {
  const g = await taskAction(u, taskId); if (g.error) return g; const { t, r } = g;
  if (t.status !== 'awaiting_approval') return { error: 'This step is not waiting for an approval.', status: 409 };
  if (r.status === 'cancelled') return { error: 'This run is cancelled.', status: 409 };
  const tool = Tools.TOOLS[t.tool]; const tasks = await tasksOf(r.id);
  const ctx = toolCtx(u, r, t, tasks, env, env.base, body);
  const prep = tool && tool.prepare ? await tool.prepare(ctx) : { ready: true, reason: '' };
  if (!prep.ready) return { error: prep.reason || 'This step is not ready to be approved.', status: 409, code: 'not_ready' };
  const ap = tool && tool.approval ? tool.approval(body || {}, prep, ctx) : { input: {}, summary: 'run it' };
  if (ap.error) return { error: ap.error, status: 400, code: 'details' };
  const now = Date.now(); const input = { ...par(t.input, {}), ...(ap.input || {}) };
  await S.run(`UPDATE "${TK}" SET status = 'queued', approvedById = ?, approvedAt = ?, input = ?, note = ?, updatedAt = ? WHERE id = ?`, u.id, now, JSON.stringify(input), clip(ap.summary, 300), now, t.id);
  await S.run(`UPDATE "${R}" SET status = 'running', updatedAt = ? WHERE id = ? AND status = 'attention'`, now, r.id);
  const later = tool && tool.scheduled && S.ms(t.scheduledAt) > config.clock();
  await event(r.id, t.id, 'task_approved', u.name, `${t.title}: approved by ${u.name} to ${ap.summary}${later ? '. It goes out at its scheduled time.' : '.'}`);
  await audit(u, 'outward step approved', r, `${t.title}: ${ap.summary}`);
  kick(r.id, env);
  return detail(u, r.id);
}
// the same approval for every ready step of one kind in a run (for example the seven client messages of a week), with the same choices; steps that are not ready are listed, not forced
async function approveSteps(u, runId, toolId, body = {}, env = {}) {
  const e = await editable(u, runId); if (e.error) return e;
  const tasks = (await tasksOf(runId)).filter((t) => t.tool === toolId && t.status === 'awaiting_approval');
  if (!tasks.length) return { error: 'No step of that kind is waiting for an approval.', status: 409 };
  const approved = []; const notReady = [];
  for (const t of tasks) { const r = await approveTask(u, t.id, body, env); if (r.error) notReady.push({ taskId: t.id, title: t.title, reason: r.error }); else approved.push(t.id); } // eslint-disable-line no-await-in-loop
  if (!approved.length) return { error: `Nothing was approved. ${notReady[0].reason}`, status: notReady[0].code === 'details' ? 400 : 409, notReady };
  return { ...(await detail(u, runId)), approved: approved.length, notReady };
}
// a scheduled step that only READS (the call sheet) can be run now instead of waiting for its day; a step that reaches outside TeamLink never can (its time is part of what was approved)
async function runNow(u, taskId, env = {}) {
  const g = await taskAction(u, taskId); if (g.error) return g; const { t, r } = g;
  const tool = Tools.TOOLS[t.tool];
  if (!tool || !tool.scheduled || Tools.isOutward(t.tool)) return { error: 'This step cannot be run before its time.', status: 409 };
  if (t.status !== 'queued') return { error: 'This step is not waiting for its time.', status: 409 };
  await S.run(`UPDATE "${TK}" SET scheduledAt = ?, updatedAt = ? WHERE id = ?`, config.clock(), Date.now(), t.id);
  await event(r.id, t.id, 'run_now', u.name, `${t.title}: run now by ${u.name}`);
  kick(r.id, env);
  return detail(u, r.id);
}
const urlOk = (v) => { try { return /^https?:$/.test(new URL(v).protocol); } catch { return false; } };
// a person did the step (posted it, made the video, talked to the website owner), or skips it
async function markManual(u, taskId, b = {}) {
  const g = await taskAction(u, taskId); if (g.error) return g; const { t, r } = g;
  const tool = Tools.TOOLS[t.tool];
  if (!tool || !tool.manual) return { error: 'This step is run by the agent, not by a person.', status: 409 };
  if (t.status !== 'waiting') return { error: 'This step is not waiting for you.', status: 409 };
  if (r.status === 'cancelled') return { error: 'This run is cancelled.', status: 409 };
  const tasks = await tasksOf(r.id); const byN = new Map(tasks.map((x) => [S.num(x.n), x]));
  const skip = b.action === 'skip';
  if (!skip) {
    const open = par(t.deps, []).map((n) => byN.get(n)).filter((x) => x && x.status !== 'done');
    if (open.length) return { error: 'The step before it (asking the team to approve) is not finished yet.', status: 409 };
    if (t.tool === 'manual.post' || t.tool === 'manual.whatsapp') { // only APPROVED words (and pictures, for a post) are posted or sent
      const live = await liveStatuses(tasks.filter((x) => x.day === t.day));
      const not = []; for (const x of tasks.filter((y) => y.day === t.day && y.status === 'done')) for (const ref of (par(x.output, {}) || {}).refs || []) { if (t.tool === 'manual.whatsapp' && ref.kind !== 'content') continue; const s = live[ref.kind] && live[ref.kind].get(ref.id); if (s && s !== 'approved') not.push(`${ref.kind === 'content' ? 'the draft' : 'the picture'} is ${s === 'waiting' ? 'still waiting for approval' : s === 'changes' ? 'sent back with changes' : s}`); }
      if (not.length) return { error: `It cannot be marked as ${t.tool === 'manual.whatsapp' ? 'sent' : 'posted'} yet: ${[...new Set(not)].join(' and ')}. Only approved content is ${t.tool === 'manual.whatsapp' ? 'sent' : 'posted'}.`, status: 409, code: 'not_approved' };
    }
    if (b.url && !urlOk(String(b.url))) return { error: 'The link must start with https://.', status: 400 };
  }
  const note = clip(b.note, 300); const url = clip(b.url, 300);
  await S.run(`UPDATE "${TK}" SET status = ?, output = ?, error = NULL, finishedAt = ?, updatedAt = ? WHERE id = ?`, skip ? 'skipped' : 'done', JSON.stringify({ summary: skip ? `Skipped by ${u.name}${note ? `: ${note}` : ''}.` : `Marked done by ${u.name}${note ? `: ${note}` : ''}.`, refs: url ? [{ kind: 'link', id: url, label: url, page: '' }] : [], data: { by: u.name, url, note } }), Date.now(), Date.now(), t.id);
  await event(r.id, t.id, skip ? 'manual_skipped' : 'manual_done', u.name, `${t.title}: ${skip ? 'skipped' : 'marked done'} by ${u.name}${url ? ` (${url})` : ''}`);
  await audit(u, skip ? 'manual step skipped' : 'manual step done', r, t.title);
  await finishCheck(r.id);
  return detail(u, r.id);
}
// a real number typed in by a person (enquiries received, calls, orders ...): kept with the run and shown in its summary with their name
async function addResult(u, runId, b = {}) {
  const e = await editable(u, runId); if (e.error) return e; const r = e.r;
  if (['needs_info', 'preview'].includes(r.status)) return { error: 'Results can be added after the plan has run.', status: 409 };
  const label = clip(b.label, 60); const value = clip(b.value, 40);
  if (label.length < 2) return { error: 'Say what the number is, for example "Enquiries received".', status: 400 };
  if (!/^\d[\d,.]*\s*%?$/.test(value)) return { error: 'The value must be a number, for example 12.', status: 400 };
  await event(r.id, null, 'result', u.name, JSON.stringify({ label, value, note: clip(b.note, 200) }));
  await audit(u, 'result added', r, `${label}: ${value}`);
  const tasks = await tasksOf(r.id); const summary = await summarize(r, tasks); const prev = par(r.summary, {});
  await S.run(`UPDATE "${R}" SET summary = ?, updatedAt = ? WHERE id = ?`, JSON.stringify({ ...summary, noticeFor: prev && prev.noticeFor }), Date.now(), r.id);
  return detail(u, r.id);
}

// ---- reading -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
async function detail(u, id, env = {}) {
  const r = await mineRun(u, id); if (!r) return { error: 'That run was not found.', status: 404 };
  const run = runView(u, r); const tasks = await tasksOf(id);
  const live = await liveStatuses(tasks);
  const views = tasks.map((t) => { const v = taskView(t, run.plan); v.refs = v.refs.map((x) => ({ ...x, status: (live[x.kind] && live[x.kind].get(x.id)) || '' })); return v; });
  const messages = (await S.q(`SELECT * FROM "${MG}" WHERE runId = ? ORDER BY at, rowid`, id)).map((m) => ({ id: m.id, at: S.iso(m.at), role: m.role, text: m.text, data: par(m.data, null) }));
  const events = (await S.q(`SELECT * FROM "${EV}" WHERE runId = ? ORDER BY at DESC, rowid DESC LIMIT 200`, id)).map((x) => ({ id: x.id, at: S.iso(x.at), kind: x.kind, byName: x.byName || '', text: x.kind === 'result' ? '' : x.text || '', taskId: x.taskId || '' }));
  const svc = env.svc || runOpts.svc; // (a test's stand-ins; the real services otherwise)
  const pf = run.status === 'preview' ? await preflight(u, run.plan, { svc }) : { blockers: [], warnings: [] };
  const started = run.status === 'running' || run.status === 'attention' || run.status === 'done';
  const perf = started ? await Analytics.performance(u, r, tasks, { svc }) : null;
  const live2 = started ? await summarize(r, tasks, perf) : null;
  return { run, tasks: views, messages, events, results: await resultsOf(id), preflight: pf, live: live2 };
}
async function listRuns(u, { status = '', business = '' } = {}) {
  await ensure();
  const rows = (await S.q(`SELECT * FROM "${R}" WHERE deletedAt IS NULL ORDER BY updatedAt DESC LIMIT 300`)).filter((r) => visible(u, r)).filter((r) => !status || r.status === status).filter((r) => !business || r.businessKey === business);
  const out = [];
  for (const r of rows.slice(0, 100)) {
    const tasks = await S.q(`SELECT status FROM "${TK}" WHERE runId = ?`, r.id); const c = (s) => tasks.filter((t) => t.status === s).length;
    out.push({ ...runView(u, r), plan: undefined, counts: { total: tasks.length, done: c('done'), failed: c('failed'), waiting: c('waiting'), running: c('running') + c('queued') }, title: (par(r.plan, {}) || {}).title || r.goal });
  }
  return { runs: out, canWrite: mayWrite(u) };
}

// ---- the dashboard ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
async function dashboard(u) {
  await ensure();
  const rows = (await S.q(`SELECT * FROM "${R}" WHERE deletedAt IS NULL ORDER BY updatedAt DESC LIMIT 300`)).filter((r) => visible(u, r));
  const idsIn = rows.map((r) => r.id);
  const tasks = idsIn.length ? await S.q(`SELECT * FROM "${TK}" WHERE runId IN (${idsIn.map(() => '?').join(',')})`, ...idsIn) : [];
  const runById = new Map(rows.map((r) => [r.id, r]));
  const c = (s) => tasks.filter((t) => t.status === s).length;
  const month0 = require('./ai').monthStart(); const day0 = require('./ai').dayStart();
  const doneMonth = tasks.filter((t) => t.status === 'done' && S.ms(t.finishedAt) >= month0);
  const counts = {
    activeRuns: rows.filter((r) => r.status === 'running').length, needYou: rows.filter((r) => r.status === 'attention').length, awaitingPlan: rows.filter((r) => r.status === 'preview').length, needAnswers: rows.filter((r) => r.status === 'needs_info').length,
    tasksRunning: c('running'), tasksQueued: c('queued'), tasksWaiting: c('waiting'), tasksAwaiting: c('awaiting_approval'), tasksFailed: c('failed'), doneToday: tasks.filter((t) => t.status === 'done' && S.ms(t.finishedAt) >= day0).length, doneMonth: doneMonth.length, runsTotal: rows.length,
  };
  const short = (r) => ({ id: r.id, goal: r.goal, businessName: r.businessName, status: r.status, statusWords: RUN_WORDS[r.status], title: (par(r.plan, {}) || {}).title || r.goal, updatedAt: S.iso(r.updatedAt), createdByName: r.createdByName || '' });
  const active = rows.filter((r) => ['running', 'attention', 'preview', 'needs_info'].includes(r.status)).slice(0, 12).map(short);
  const failures = tasks.filter((t) => t.status === 'failed').slice(0, 20).map((t) => ({ taskId: t.id, runId: t.runId, runGoal: runById.get(t.runId).goal, title: t.title, error: t.error || '', attempts: S.num(t.attempts), at: S.iso(t.finishedAt) }));
  const live = await liveStatuses(tasks.filter((t) => t.status === 'done'));
  const waitingItems = [];
  for (const t of tasks.filter((x) => x.tool === 'approval.request' && x.status === 'done')) {
    const out = par(t.output, {}) || {};
    for (const ref of out.refs || []) if ((live[ref.kind] && live[ref.kind].get(ref.id)) === 'waiting') waitingItems.push({ runId: t.runId, runGoal: runById.get(t.runId).goal, kind: ref.kind, label: ref.label, id: ref.id, page: ref.page });
  }
  const recent = (idsIn.length ? await S.q(`SELECT * FROM "${EV}" WHERE runId IN (${idsIn.map(() => '?').join(',')}) AND kind IN ('task_done','approved','finished','manual_done','cancelled','result','task_failed') ORDER BY at DESC LIMIT 15`, ...idsIn) : [])
    .map((e) => ({ at: S.iso(e.at), kind: e.kind, byName: e.byName || '', runGoal: (runById.get(e.runId) || {}).goal || '', text: e.kind === 'result' ? (() => { const x = par(e.text, {}) || {}; return `${x.label}: ${x.value}`; })() : e.text || '' }));
  const performance = []; const leadsAll = await Analytics.leadsOf(u, runOpts.svc);
  for (const r of rows.filter((x) => ['running', 'attention', 'done'].includes(x.status)).slice(0, 8)) { const mine = tasks.filter((t) => t.runId === r.id); const s = await summarize(r, mine, await Analytics.performance(u, r, mine, { svc: runOpts.svc, leads: leadsAll })); performance.push({ runId: r.id, goal: r.goal, businessName: r.businessName, status: r.status, numbers: s.numbers, lines: s.lines }); } // eslint-disable-line no-await-in-loop
  // estimated usage and cost: what the finished steps cost per their tool's real unit price (all free today)
  const byTool = new Map();
  for (const t of doneMonth) { const tool = Tools.TOOLS[t.tool]; if (!tool || tool.manual) continue; const x = byTool.get(t.tool) || { tool: t.tool, label: tool.label, kind: tool.cost.kind, unit: tool.cost.unit, rupees: tool.cost.rupees, note: tool.cost.note, count: 0 }; x.count += 1; byTool.set(t.tool, x); }
  const usage = [...byTool.values()].map((x) => ({ ...x, total: x.count * x.rupees })).sort((a, b) => b.count - a.count);
  const aiCalls = S.num(((await S.q(`SELECT COUNT(*) AS n FROM "OmniMkAiUsage" WHERE module = 'agent' AND at >= ? AND ok = 1`, month0).catch(() => []))[0] || {}).n);
  const total = usage.reduce((a, x) => a + x.total, 0);
  const paid = usage.filter((x) => x.kind === 'paid').length; const tier = usage.filter((x) => x.kind === 'free-tier');
  return {
    counts, active, failures, pendingApprovals: { plans: rows.filter((r) => r.status === 'preview').map(short), items: waitingItems.slice(0, 40), needAnswers: rows.filter((r) => r.status === 'needs_info').map(short), outward: tasks.filter((t) => t.status === 'awaiting_approval').map((t) => ({ taskId: t.id, runId: t.runId, title: t.title })) }, recent, performance,
    usage: { month: usage, aiModelCalls: aiCalls, totalRupees: total, note: paid ? 'Some steps use a paid tool: the price per unit is shown beside each.' : tier.length ? `Everything the agent used this month is free or on a free allowance (${tier.map((x) => `${x.count} ${x.unit}${x.count === 1 ? '' : 's'} on the free tier`).join(', ')}). The estimate is ₹0.` : 'Everything the agent has used is free (plain code, no paid service). The estimate is ₹0.' },
  };
}

// ---- the business, for the "Business" tab -------------------------------------------------------------------------------------------------------------------------------------
async function businessView(u, ref, nameHint) {
  await ensure();
  const b = await Ctx.resolve(u, ref, nameHint);
  const history = (await S.q(`SELECT id, goal, status, createdAt, createdByName, createdById FROM "${R}" WHERE businessKey = ? AND deletedAt IS NULL ORDER BY createdAt DESC LIMIT 40`, b.key))
    .filter((r) => A.isAdmin(u) || r.createdById === u.id).slice(0, 15).map((r) => ({ id: r.id, goal: r.goal, status: r.status, statusWords: RUN_WORDS[r.status], at: S.iso(r.createdAt), by: r.createdByName || '' }));
  return { ...b, fields: Object.entries(Ctx.FIELDS).map(([key, d]) => ({ key, label: d.label, kind: d.kind, hint: d.hint || '' })), history, canEdit: Ctx.mayWrite(u) };
}

// ---- keeping time: reminders for steps that are due, restart recovery ------------------------------------------------------------------------------------------------------
async function recover(opts = {}) {
  const now = Date.now(); let n = 0;
  const stuck = await S.q(`SELECT * FROM "${TK}" WHERE status = 'running'`);
  for (const t of stuck) {
    if (inflight.has(t.id)) continue;
    await S.run(`UPDATE "${TK}" SET status = 'failed', error = ?, errorCode = 'interrupted', finishedAt = ?, updatedAt = ? WHERE id = ?`, 'The server restarted while this step was running. It may or may not have finished: check AI Content / AI Images, then press Retry only if nothing was made.', now, now, t.id); // eslint-disable-line no-await-in-loop
    await event(t.runId, t.id, 'task_failed', null, `${t.title}: interrupted by a restart. Press Retry if nothing was made.`); // eslint-disable-line no-await-in-loop
    n += 1;
  }
  for (const r of await S.q(`SELECT id FROM "${R}" WHERE status IN ('running','attention')`)) { kick(r.id, opts); } // eslint-disable-line no-await-in-loop
  return { interrupted: n };
}
// a bell when the time of a "post it" step has come (once), to whoever gave the goal
async function sweep(opts = {}) {
  if (!opts.force && require('../utils/sandbox').isSandbox()) return { sandbox: true }; // eslint-disable-line global-require
  if (!(await ensure())) return {};
  const now = opts.now || Date.now(); const notify = opts.notify || require('../utils/notify').notifyUsers; // eslint-disable-line global-require
  let sent = 0;
  const due = await S.q(`SELECT t.*, r.createdById AS owner, r.goal AS goal, r.businessName AS biz FROM "${TK}" t JOIN "${R}" r ON r.id = t.runId WHERE t.status = 'waiting' AND t.remindedAt IS NULL AND t.scheduledAt IS NOT NULL AND t.scheduledAt <= ? AND r.status IN ('running','attention') AND r.deletedAt IS NULL`, now);
  for (const t of due) {
    const done = par(t.deps, []); const deps = await S.q(`SELECT n, status FROM "${TK}" WHERE runId = ?`, t.runId); // eslint-disable-line no-await-in-loop
    if (done.some((n) => (deps.find((x) => S.num(x.n) === n) || {}).status !== 'done')) continue; // not asked / not approved yet: no reminder
    await notify([t.owner].filter(Boolean), { title: `Time for a step: ${clip(t.biz, 40)}`, message: `${clip(t.title, 140)}. Open AI Marketing > AI Agent.` }); // eslint-disable-line no-await-in-loop
    await S.run(`UPDATE "${TK}" SET remindedAt = ? WHERE id = ?`, now, t.id); // eslint-disable-line no-await-in-loop
    sent += 1;
  }
  const stale = await S.q(`SELECT id FROM "${TK}" WHERE status = 'running' AND startedAt < ?`, now - 15 * 60000);
  if (stale.some((t) => !inflight.has(t.id))) await recover(opts);
  for (const r of await S.q(`SELECT DISTINCT runId FROM "${TK}" WHERE status = 'queued'`)) { const run = await runRow(r.runId); if (run && ['running', 'attention'].includes(run.status)) kick(run.id, opts); } // eslint-disable-line no-await-in-loop
  return { reminded: sent };
}
let timer = null;
function start() {
  if (timer || require('../utils/sandbox').isSandbox()) return; // eslint-disable-line global-require
  setTimeout(() => { recover().catch(() => {}); }, 60 * 1000).unref();
  timer = setInterval(() => { sweep().catch(() => {}); }, 2 * 60 * 1000); if (timer.unref) timer.unref();
}

module.exports = {
  ensure, config, RUN_WORDS, TASK_WORDS, start, recover, sweep, drain, kick, preflight, startRun: start1, answer, changePlan, editDay, talk, approve, approveTask, cancelRun, cancelTask, retryTask, prepareTask, approveSteps, runNow, markManual, addResult, discard,
  detail, listRuns, dashboard, businessView, summarize,
};
