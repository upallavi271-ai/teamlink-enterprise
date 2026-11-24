// ---------------------------------------------------------------------------
// MARKET WAVE B - AI & AUTOMATION (09.04 / 09.05 / 09.06 / 09.08 / 09.09 / 09.10 / 09.11 / 09.20) + the background timers.
//
//   09.05 REDISCOVERY      for a job: people already on file who did well before (reached the client, an interview, were selected)
//                          or went quiet, ranked by Fit (utils/matching.js) with a bonus for how far they got. Own data only.
//   09.08 TASK AGENTS      submission (draft notes for people ready to share), follow-up (people with no move in 7 days -> a
//                          follow-up task), data clean-up (spaces / case in names, e-mails, cities). Every agent only PROPOSES;
//                          a person approves each action (or all) and only then it is done. Every step is kept (MktAgentRun / Action).
//   09.09 ORCHESTRATION    a playbook for a job: rediscover -> review -> propose "add to this job" (approval) -> on approval, the
//                          normal add (scope, live job, Do-not-use and the Fit rules all apply). Simple, linear, every step logged.
//   09.10 WORKFLOWS        "when X (and Y) then Z" rules: OFF by default (workflows.on) and each rule OFF until ticked; Dry run lists what
//                          would happen. Actions never message candidates: tag, pool, follow-up task, bell to the owner, review queue.
//   09.11 DATA HEALTH      counts of what is wrong in the data; the nightly run and the safe auto-fix are both OFF by default.
//   09.20 ATTRITION RISK   joined people inside the guarantee period: an explainable score from the facts (pay rise, commute, job
//                          hopping, no contact since joining, the client's past drops). Never the name, gender or age.
//   09.04 / 09.06          outside profile graph / contact finding: needs a paid data provider (founder). A connector stub says so.
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const S = require('./store');

const csv = (s) => String(s || '').split(/[,;|]/).map((x) => x.trim()).filter(Boolean);
const lower = (s) => String(s || '').toLowerCase();
const LATE = ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED'];
const scopeW = (user) => require('../scope').candidateWhere(user); // eslint-disable-line global-require

// ---- 09.05 rediscovery -------------------------------------------------------------------------------------------------------------
async function rediscover(requirement, user, { limit = 25 } = {}) {
  const M = require('../matching'); // eslint-disable-line global-require
  const quiet = new Date(Date.now() - 90 * 864e5);
  const cands = await prisma.candidate.findMany({
    where: { AND: [scopeW(user), { doNotContact: false }, { applications: { none: { requirementId: requirement.id } } }, { OR: [{ applications: { some: { stageEvents: { some: { toStage: { in: LATE } } } } } }, { createdAt: { lt: quiet }, applications: { none: { updatedAt: { gte: quiet } } } }] }] },
    select: { id: true, name: true, location: true, preferredLocation: true, experienceYears: true, relevantExperienceYears: true, skills: true, education: true, availability: true, currentSalary: true, expectedSalary: true, jobPreference: true, noticePeriod: true, preferredEmploymentType: true, preferredWorkMode: true, specialisationId: true, currentDesignation: true, profileStatus: true, applications: { select: { stage: true, requirement: { select: { title: true } }, stageEvents: { select: { toStage: true }, where: { toStage: { in: LATE } } } } } },
    take: 6000,
  });
  const rows = cands.filter((c) => c.profileStatus !== 'Do Not Use').map((c) => {
    const m = M.computeMatch(c, requirement);
    const reached = new Set(c.applications.flatMap((a) => a.stageEvents.map((e) => e.toStage)));
    let bonus = 0; let why = 'Went quiet: no activity for 90+ days';
    if (reached.has('SELECTED') || reached.has('OFFER') || reached.has('OFFER_ACCEPTED')) { bonus = 15; why = 'Was selected before (silver medallist)'; } else if (reached.has('INTERVIEW_SCHEDULED') || reached.has('INTERVIEW_COMPLETED')) { bonus = 10; why = 'Reached a client interview before'; } else if (reached.size) { bonus = 5; why = 'Was shared with a client before'; }
    const last = c.applications.find((a) => a.stageEvents.length);
    return { id: c.id, name: c.name, location: c.location, experienceYears: c.experienceYears, designation: c.currentDesignation, fit: m.overall, score: Math.min(100, m.overall + bonus), why, before: last ? last.requirement.title : null };
  }).filter((r) => r.fit >= M.SUGGESTION_THRESHOLD).sort((a, b) => b.score - a.score);
  return { total: rows.length, rows: rows.slice(0, limit) };
}

// ---- runs and actions ---------------------------------------------------------------------------------------------------------------
async function newRun(kind, requirementId, user, steps) {
  const id = S.newId();
  await S.x('INSERT INTO "MktAgentRun" ("id","kind","requirementId","status","steps","byId","byName","at") VALUES (?,?,?,?,?,?,?,?)', id, kind, requirementId, 'Waiting for approval', JSON.stringify(steps), user.id, user.name, S.now());
  return id;
}
async function addAction(runId, kind, refType, refId, title, payload) {
  const id = S.newId();
  await S.x('INSERT INTO "MktAgentAction" ("id","runId","kind","refType","refId","title","payload") VALUES (?,?,?,?,?,?,?)', id, runId, kind, refType, refId, S.clean(title, 300), JSON.stringify(payload || {}));
  return id;
}
async function runs(user, { limit = 30 } = {}) {
  const rows = await S.q(`SELECT r.*, (SELECT COUNT(*) FROM "MktAgentAction" a WHERE a."runId" = r."id" AND a."status" = 'Proposed') AS open,
    (SELECT COUNT(*) FROM "MktAgentAction" a WHERE a."runId" = r."id") AS total FROM "MktAgentRun" r ${require('../scope').atsViewRole(user) === 'admin' ? '' : 'WHERE r."byId" = ?'} ORDER BY r."at" DESC LIMIT ${Math.min(100, limit)}`, ...(require('../scope').atsViewRole(user) === 'admin' ? [] : [user.id])); // eslint-disable-line global-require
  return rows.map((r) => ({ ...r, steps: S.parse(r.steps, []), open: S.num(r.open), total: S.num(r.total) }));
}
async function runDetail(id, user) {
  const [r] = await S.q('SELECT * FROM "MktAgentRun" WHERE "id" = ?', id);
  if (!r || (r.byId !== user.id && require('../scope').atsViewRole(user) !== 'admin')) return null; // eslint-disable-line global-require
  const actions = await S.q('SELECT * FROM "MktAgentAction" WHERE "runId" = ? ORDER BY "rowid"', id);
  return { ...r, steps: S.parse(r.steps, []), actions: actions.map((a) => ({ ...a, payload: S.parse(a.payload, {}), result: S.parse(a.result, a.result) })) };
}

// the three task agents
async function agentSubmission(requirement, user) {
  const P = require('./pipe'); // eslint-disable-line global-require
  const apps = await prisma.application.findMany({ where: { AND: [require('../scope').applicationWhere(user), { requirementId: requirement.id, stage: { in: ['TL_REVIEW', 'RECRUITER_APPROVED', 'WITH_BDE', 'BDE_APPROVED'] } }] }, include: { candidate: true, requirement: { include: { client: { select: { id: true, name: true } } } } }, take: 30 }); // eslint-disable-line global-require
  const approved = apps.length ? new Set((await S.q(`SELECT "applicationId" FROM "MktPitch" WHERE "status" = 'Approved' AND "applicationId" IN (${apps.map(() => '?').join(',')})`, ...apps.map((a) => a.id))).map((r) => r.applicationId)) : new Set();
  const todo = apps.filter((a) => !approved.has(a.id));
  const runId = await newRun('Submission agent', requirement.id, user, [{ step: 'Find people ready to share without an approved note', at: S.now(), result: `${todo.length} found` }, { step: 'Draft a note for each', at: S.now(), result: 'from the facts (no AI in bulk)' }, { step: 'A person approves each note', at: null, result: 'waiting' }]);
  for (const a of todo) await addAction(runId, 'pitch', 'Application', a.id, `Submission note for ${a.candidate.name}`, { text: P.rulePitch(a) }); // eslint-disable-line no-await-in-loop
  return runId;
}
async function agentFollowUp(requirement, user) {
  const since = new Date(Date.now() - 7 * 864e5);
  const apps = await prisma.application.findMany({ where: { AND: [require('../scope').applicationWhere(user), { ...(requirement ? { requirementId: requirement.id } : {}), stage: { notIn: ['REJECTED', 'JOINED', 'HIRED', 'HOLD', 'DROPPED'] }, updatedAt: { lt: since } }] }, select: { id: true, stage: true, updatedAt: true, candidateId: true, requirementId: true, candidate: { select: { name: true } }, requirement: { select: { title: true } } }, orderBy: { updatedAt: 'asc' }, take: 40 }); // eslint-disable-line global-require
  const runId = await newRun('Follow-up agent', requirement ? requirement.id : null, user, [{ step: 'Find applications with no move in 7 days', at: S.now(), result: `${apps.length} found` }, { step: 'Propose a follow-up task for each', at: S.now(), result: 'proposed' }, { step: 'A person approves', at: null, result: 'waiting' }]);
  for (const a of apps) await addAction(runId, 'followup', 'Application', a.id, `Follow up ${a.candidate.name} (${a.requirement.title}): no move since ${a.updatedAt.toISOString().slice(0, 10)}`, { applicationId: a.id, candidateId: a.candidateId, requirementId: a.requirementId, nextAction: 'Call to check interest and the next step' }); // eslint-disable-line no-await-in-loop
  return runId;
}
const tidyName = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const titleCase = (s) => tidyName(s).toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
function cleanupOf(c) {
  const fix = {};
  if (c.name && tidyName(c.name) !== c.name) fix.name = tidyName(c.name);
  if (c.name && c.name.length > 3 && c.name === c.name.toUpperCase() && /[A-Z]/.test(c.name)) fix.name = titleCase(c.name);
  if (c.email && (c.email !== c.email.trim().toLowerCase())) fix.email = c.email.trim().toLowerCase();
  if (c.location && c.location.length > 2 && (c.location === c.location.toLowerCase() || tidyName(c.location) !== c.location)) fix.location = titleCase(c.location);
  return fix;
}
async function agentCleanup(user) {
  const cands = await prisma.candidate.findMany({ where: scopeW(user), select: { id: true, name: true, email: true, location: true }, take: 20000 });
  const todo = cands.map((c) => ({ c, fix: cleanupOf(c) })).filter((x) => Object.keys(x.fix).length).slice(0, 200);
  const runId = await newRun('Data clean-up agent', null, user, [{ step: 'Look for spaces / case problems in names, e-mails and cities', at: S.now(), result: `${todo.length} people` }, { step: 'A person approves the fixes', at: null, result: 'waiting' }]);
  for (const x of todo) await addAction(runId, 'cleanup', 'Candidate', x.c.id, `${x.c.name}: ${Object.entries(x.fix).map(([k, v]) => `${k} "${x.c[k]}" -> "${v}"`).join('; ')}`, { fix: x.fix }); // eslint-disable-line no-await-in-loop
  return runId;
}
async function agentPlaybook(requirement, user) {
  const C = require('./cands'); // eslint-disable-line global-require
  const found = await rediscover(requirement, user, { limit: 15 });
  const review = found.rows.length ? await C.bulkReview(found.rows.map((r) => r.id), requirement.id, user, { useAi: false }) : { rows: [] };
  const good = (review.rows || []).filter((r) => r.verdict !== 'Not a fit');
  const runId = await newRun('Rediscovery playbook', requirement.id, user, [
    { step: '1. Rediscover past candidates for this job', at: S.now(), result: `${found.rows.length} found` },
    { step: '2. Review each against the job', at: S.now(), result: `${good.length} strong / possible fits` },
    { step: '3. Propose "add to this requirement" (approval)', at: S.now(), result: `${good.length} proposed` },
    { step: '4. On approval: the normal add, with every rule', at: null, result: 'waiting' },
  ]);
  for (const r of good) await addAction(runId, 'add', 'Candidate', r.candidateId, `Add ${r.name} to ${requirement.title} (${r.verdict}, ${r.score}%)`, { candidateId: r.candidateId, requirementId: requirement.id, why: r.summary }); // eslint-disable-line no-await-in-loop
  return runId;
}

async function doAction(a, user) {
  const p = S.parse(a.payload, {});
  if (a.kind === 'pitch') {
    const P = require('./pipe'); // eslint-disable-line global-require
    if (!(await P.appInScope(a.refId, user))) return { ok: false, result: 'Not in your scope' };
    const id = S.newId();
    await S.x('INSERT INTO "MktPitch" ("id","applicationId","text","source","status","byName","at","approvedByName","approvedAt") VALUES (?,?,?,?,\'Approved\',?,?,?,?)', id, a.refId, p.text, 'agent', 'Submission agent', S.now(), user.name, S.now());
    return { ok: true, result: 'Note approved' };
  }
  if (a.kind === 'followup') {
    const app = await require('./pipe').appInScope(p.applicationId, user); // eslint-disable-line global-require
    if (!app) return { ok: false, result: 'Not in your scope' };
    const due = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    await prisma.applicationFollowUp.create({ data: { applicationId: app.id, candidateId: app.candidateId, requirementId: app.requirementId, ownerUserId: user.id, ownerName: user.name, nextAction: p.nextAction, dueDate: due, nextFollowUpAt: due, notes: 'Proposed by the follow-up agent, approved by a person.' } });
    return { ok: true, result: `Follow-up due ${due}` };
  }
  if (a.kind === 'cleanup') {
    const ok = await prisma.candidate.findFirst({ where: { AND: [scopeW(user), { id: a.refId }] }, select: { id: true, name: true, email: true, location: true } });
    if (!ok) return { ok: false, result: 'Not in your scope' };
    const data = {};
    Object.entries(p.fix || {}).forEach(([k, v]) => { if (['name', 'email', 'location'].includes(k) && v) data[k] = v; });
    if (data.email) { const clash = await prisma.candidate.findFirst({ where: { email: data.email, id: { not: ok.id } }, select: { id: true } }); if (clash) delete data.email; }
    if (!Object.keys(data).length) return { ok: false, result: 'Nothing left to fix' };
    await prisma.candidate.update({ where: { id: ok.id }, data });
    try { require('../candidateListCache').markCandidateDirty(ok.id); } catch { /* optional */ } // eslint-disable-line global-require
    await require('../audit').logAudit({ userId: user.id, action: 'Data clean-up (agent, approved)', entity: 'Candidate', entityId: ok.id, fromValue: JSON.stringify(Object.fromEntries(Object.keys(data).map((k) => [k, ok[k]]))), toValue: JSON.stringify(data) }); // eslint-disable-line global-require
    return { ok: true, result: `Fixed ${Object.keys(data).join(', ')}` };
  }
  if (a.kind === 'add') {
    const AR = require('../../routes/applications'); // eslint-disable-line global-require
    const { requirementWhere } = require('../scope'); // eslint-disable-line global-require
    const [candidate, requirement] = await Promise.all([prisma.candidate.findFirst({ where: { AND: [scopeW(user), { id: p.candidateId }] } }), prisma.requirement.findFirst({ where: { AND: [requirementWhere(user), { id: p.requirementId }] }, include: { client: true } })]);
    if (!candidate || !requirement) return { ok: false, result: 'Not in your scope' };
    if (candidate.profileStatus === 'Do Not Use') return { ok: false, result: 'Marked Do not use' };
    const no = await AR.jobRefusalFor(requirement);
    if (no) return { ok: false, result: (no.body && no.body.error) || 'The job takes no candidates now' };
    const fit = await AR.fitAtAdd(user, candidate, requirement);
    if (fit.overrideWhy && fit.overrideWhy.length) return { ok: false, result: `Needs a reason to add (${fit.overrideWhy.join('; ')}): add from the requirement page` };
    try {
      await AR.addApplication(user, { candidate, requirement, comment: `Added from the rediscovery playbook (approved by ${user.name})`, fit, override: null });
    } catch (e) { return { ok: false, result: e.alreadyApplied ? 'Already on this job' : String(e.message).slice(0, 120) }; }
    return { ok: true, result: 'Added to the requirement' };
  }
  return { ok: false, result: 'Unknown action' };
}
async function decideActions(runId, { ids = null, decision }, user) {
  const run = await runDetail(runId, user);
  if (!run) return { error: 'Run not found.', status: 404 };
  if (!['Approved', 'Rejected'].includes(decision)) return { error: 'Approve or reject.' };
  const todo = run.actions.filter((a) => a.status === 'Proposed' && (!ids || ids.includes(a.id)));
  const out = [];
  for (const a of todo) {
    let res = { ok: true, result: 'Rejected by a person' };
    // eslint-disable-next-line no-await-in-loop
    if (decision === 'Approved') res = await doAction({ ...a, payload: JSON.stringify(a.payload) }, user).catch((e) => ({ ok: false, result: String(e.message).slice(0, 120) }));
    const status = decision === 'Rejected' ? 'Rejected' : (res.ok ? 'Done' : 'Failed');
    // eslint-disable-next-line no-await-in-loop
    await S.x('UPDATE "MktAgentAction" SET "status"=?,"decidedByName"=?,"decidedAt"=?,"result"=? WHERE "id"=?', status, user.name, S.now(), JSON.stringify(res.result), a.id);
    out.push({ id: a.id, status, result: res.result });
  }
  const [{ n } = { n: 0 }] = await S.q('SELECT COUNT(*) AS n FROM "MktAgentAction" WHERE "runId" = ? AND "status" = \'Proposed\'', runId);
  const steps = run.steps.map((s) => (s.at ? s : { ...s, at: S.now(), result: `${out.filter((o) => o.status === 'Done').length} done, ${out.filter((o) => o.status === 'Failed').length} failed, ${out.filter((o) => o.status === 'Rejected').length} rejected by ${user.name}` }));
  await S.x('UPDATE "MktAgentRun" SET "status"=?,"steps"=?,"finishedAt"=? WHERE "id"=?', S.num(n) ? 'Waiting for approval' : 'Finished', JSON.stringify(steps), S.num(n) ? null : S.now(), runId);
  return { done: out };
}

// ---- 09.10 workflows ---------------------------------------------------------------------------------------------------------------
const TRIGGERS = {
  stage_entered: 'An application moves to a step',
  screening_failed: 'A screening answer fails a knockout',
  no_activity: 'An active application has no move for N days',
  doc_expiring: 'A candidate document expires within N days',
};
const ACTIONS = { add_tag: 'Add a tag to the person', add_to_pool: 'Add the person to a talent pool', follow_up: 'Create a follow-up task for the owner', notify_owner: 'Bell to the owner recruiter', review_queue: 'Put it in the human review queue' };
async function workflows() {
  const rows = await S.q('SELECT * FROM "MktWorkflow" ORDER BY "at" DESC');
  return rows.map((r) => ({ ...r, cond: S.parse(r.cond, {}), action: S.parse(r.action, {}), trigger: S.parse(r.trigger, {}), active: !!S.num(r.active), runs: S.num(r.runs) }));
}
async function saveWorkflow(body, user) {
  const trigger = body.trigger && TRIGGERS[body.trigger.type] ? { type: body.trigger.type, value: S.clean(body.trigger.value, 60) } : null;
  const action = body.action && ACTIONS[body.action.type] ? { type: body.action.type, value: S.clean(body.action.value, 200) } : null;
  if (!trigger) return { error: 'Pick the "when".' };
  if (!action) return { error: 'Pick the "then".' };
  if (trigger.type === 'stage_entered' && !require('../atsVocab').STAGE_CODES.includes(trigger.value)) return { error: 'Pick the step.' }; // eslint-disable-line global-require
  if (['no_activity', 'doc_expiring'].includes(trigger.type) && !(Number(trigger.value) > 0)) return { error: 'Type the number of days.' };
  if (['add_tag', 'add_to_pool'].includes(action.type) && !action.value) return { error: action.type === 'add_tag' ? 'Type the tag.' : 'Pick the pool.' };
  const cond = { department: S.clean(body.cond && body.cond.department, 60), clientId: S.clean(body.cond && body.cond.clientId, 60) };
  const id = body.id || S.newId();
  await S.x('INSERT INTO "MktWorkflow" ("id","name","trigger","cond","action","active","byName","at") VALUES (?,?,?,?,?,?,?,?) ON CONFLICT("id") DO UPDATE SET "name"=excluded."name","trigger"=excluded."trigger","cond"=excluded."cond","action"=excluded."action","active"=excluded."active","byName"=excluded."byName","at"=excluded."at"',
    id, S.clean(body.name, 80) || `${TRIGGERS[trigger.type]} -> ${ACTIONS[action.type]}`, JSON.stringify(trigger), JSON.stringify(cond), JSON.stringify(action), body.active ? 1 : 0, user.name, S.now());
  return { id };
}
async function deleteWorkflow(id) { await S.x('DELETE FROM "MktWorkflow" WHERE "id" = ?', id); return { ok: true }; }
async function matchesOf(wf) {
  const t = wf.trigger; const c = wf.cond || {};
  const since = new Date(Math.max(Date.now() - 7 * 864e5, wf.at ? Date.parse(wf.at) - 864e5 : 0));
  const reqW = { ...(c.department ? { department: c.department } : {}), ...(c.clientId ? { clientId: c.clientId } : {}) };
  if (t.type === 'stage_entered') {
    const ev = await prisma.applicationStageEvent.findMany({ where: { toStage: t.value, createdAt: { gte: since }, application: { requirement: reqW } }, select: { id: true, applicationId: true, candidateId: true, application: { select: { ownerRecruiterId: true, requirementId: true, candidate: { select: { name: true } } } } }, take: 300 });
    return ev.map((e) => ({ refId: e.id, applicationId: e.applicationId, candidateId: e.candidateId, requirementId: e.application.requirementId, ownerId: e.application.ownerRecruiterId, label: e.application.candidate.name }));
  }
  if (t.type === 'screening_failed') {
    const rows = await S.q('SELECT * FROM "MktScreenAnswer" WHERE "failed" <> \'[]\' AND "at" >= ?', since.toISOString());
    const apps = rows.length ? await prisma.application.findMany({ where: { id: { in: rows.map((r) => r.applicationId) }, requirement: reqW }, select: { id: true, candidateId: true, requirementId: true, ownerRecruiterId: true, candidate: { select: { name: true } } } }) : [];
    return apps.map((a) => ({ refId: `sf-${a.id}`, applicationId: a.id, candidateId: a.candidateId, requirementId: a.requirementId, ownerId: a.ownerRecruiterId, label: a.candidate.name }));
  }
  if (t.type === 'no_activity') {
    const cut = new Date(Date.now() - Number(t.value) * 864e5);
    const apps = await prisma.application.findMany({ where: { stage: { notIn: ['REJECTED', 'JOINED', 'HIRED', 'HOLD', 'DROPPED'] }, updatedAt: { lt: cut }, requirement: { ...reqW, status: { in: ['OPEN', 'RECRUITER_ASSIGNED'] } } }, select: { id: true, candidateId: true, requirementId: true, ownerRecruiterId: true, updatedAt: true, candidate: { select: { name: true } } }, take: 300 });
    return apps.map((a) => ({ refId: `na-${a.id}-${a.updatedAt.toISOString().slice(0, 10)}`, applicationId: a.id, candidateId: a.candidateId, requirementId: a.requirementId, ownerId: a.ownerRecruiterId, label: a.candidate.name }));
  }
  if (t.type === 'doc_expiring') {
    const until = new Date(Date.now() + Number(t.value) * 864e5).toISOString().slice(0, 10);
    const rows = await S.q('SELECT * FROM "MktDocExpiry" WHERE "expiresOn" <= ?', until);
    const names = rows.length ? new Map((await prisma.candidate.findMany({ where: { id: { in: rows.map((r) => r.candidateId) } }, select: { id: true, name: true } })).map((x) => [x.id, x.name])) : new Map();
    return rows.map((r) => ({ refId: `de-${r.documentId}-${r.expiresOn}`, candidateId: r.candidateId, label: names.get(r.candidateId) || r.candidateId }));
  }
  return [];
}
async function act(wf, m) {
  const a = wf.action;
  if (a.type === 'add_tag') { await require('../candidateProfileDepth').addTag(m.candidateId, a.value, { name: `Workflow: ${wf.name}` }); return `tag "${a.value}"`; } // eslint-disable-line global-require
  if (a.type === 'add_to_pool') { await S.x('INSERT OR IGNORE INTO "MktPoolMember" ("poolId","candidateId","addedByName","at") VALUES (?,?,?,?)', a.value, m.candidateId, `Workflow: ${wf.name}`, S.now()); return 'added to the pool'; }
  if (a.type === 'follow_up' && m.applicationId) {
    const due = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    await prisma.applicationFollowUp.create({ data: { applicationId: m.applicationId, candidateId: m.candidateId, requirementId: m.requirementId || null, ownerUserId: m.ownerId || null, nextAction: a.value || 'Follow up', dueDate: due, nextFollowUpAt: due, notes: `Created by the workflow "${wf.name}".` } });
    return `follow-up due ${due}`;
  }
  if (a.type === 'notify_owner' && m.ownerId) { await require('../notify').notifyUsers([m.ownerId], { title: wf.name, message: `${a.value || 'Please look at'} ${m.label}.`, open: `/candidates/${m.candidateId}` }); return 'bell sent'; } // eslint-disable-line global-require
  if (a.type === 'review_queue') { await require('./gov').addReview({ kind: `Workflow: ${wf.name}`, refType: 'Workflow', refId: m.refId, candidateId: m.candidateId, applicationId: m.applicationId || null, summary: `${m.label}: ${a.value || wf.name}`, aiDecision: 'Needs a look' }); return 'in the review queue'; } // eslint-disable-line global-require
  return 'nothing to do';
}
async function runWorkflow(wf, { dryRun = true } = {}) {
  const matches = await matchesOf(wf);
  const done = dryRun ? new Set() : new Set((await S.q('SELECT "refId" FROM "MktWorkflowLog" WHERE "workflowId" = ? AND "dryRun" = 0', wf.id)).map((r) => r.refId));
  const todo = matches.filter((m) => !done.has(m.refId)).slice(0, 100);
  const out = [];
  for (const m of todo) {
    let outcome = `would: ${ACTIONS[wf.action.type]}`;
    // eslint-disable-next-line no-await-in-loop
    if (!dryRun) outcome = await act(wf, m).catch((e) => `failed: ${e.message}`);
    // eslint-disable-next-line no-await-in-loop
    if (!dryRun) await S.x('INSERT OR IGNORE INTO "MktWorkflowLog" ("id","workflowId","at","refId","dryRun","outcome") VALUES (?,?,?,?,0,?)', S.newId(), wf.id, S.now(), m.refId, String(outcome).slice(0, 200));
    out.push({ label: m.label, candidateId: m.candidateId, outcome });
  }
  if (!dryRun && out.length) await S.x('UPDATE "MktWorkflow" SET "runs" = COALESCE("runs",0) + ?, "lastRunAt" = ? WHERE "id" = ?', out.length, S.now(), wf.id);
  return { id: wf.id, name: wf.name, dryRun, matched: matches.length, rows: out };
}
async function workflowSweep() {
  if (!(await S.setting('workflows.on'))) return { off: true };
  const list = (await workflows()).filter((w) => w.active);
  const res = [];
  for (const w of list) res.push(await runWorkflow(w, { dryRun: false })); // eslint-disable-line no-await-in-loop
  return { ran: res.length, acted: res.reduce((n, r) => n + r.rows.length, 0) };
}
async function workflowLog(id) {
  return S.q('SELECT * FROM "MktWorkflowLog" WHERE "workflowId" = ? ORDER BY "at" DESC LIMIT 100', id);
}

// ---- 09.11 data health -------------------------------------------------------------------------------------------------------------
async function dataHealth({ fix = false, user = null } = {}) {
  const cands = await prisma.candidate.findMany({ select: { id: true, name: true, email: true, phone: true, location: true, skills: true, createdAt: true } });
  const withResume = new Set((await prisma.candidateResume.findMany({ where: { kind: 'ORIGINAL', hiddenAt: null }, select: { candidateId: true }, distinct: ['candidateId'] })).map((r) => r.candidateId));
  const count = { people: cands.length, nameSpaces: 0, nameCaps: 0, emailCase: 0, emailInvalid: 0, phoneInvalid: 0, noPhoneNoEmail: 0, noSkills: 0, noLocation: 0, locationCase: 0, noResume: 0 };
  const fixes = [];
  cands.forEach((c) => {
    if (c.name && /\s{2,}|^\s|\s$/.test(c.name)) count.nameSpaces += 1;
    if (c.name && c.name.length > 3 && c.name === c.name.toUpperCase() && /[A-Z]/.test(c.name)) count.nameCaps += 1;
    if (c.email && c.email !== c.email.trim().toLowerCase()) count.emailCase += 1;
    if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c.email.trim())) count.emailInvalid += 1;
    const d = String(c.phone || '').replace(/\D/g, '');
    if (c.phone && !(d.length === 10 || (d.length === 12 && d.startsWith('91')))) count.phoneInvalid += 1;
    if (!c.phone && !c.email) count.noPhoneNoEmail += 1;
    if (!String(c.skills || '').trim()) count.noSkills += 1;
    if (!String(c.location || '').trim()) count.noLocation += 1;
    if (c.location && c.location.length > 2 && c.location === c.location.toLowerCase()) count.locationCase += 1;
    if (!withResume.has(c.id)) count.noResume += 1;
    if (fix) {
      const data = {};
      if (c.name && tidyName(c.name) !== c.name) data.name = tidyName(c.name);
      if (c.email && c.email !== c.email.trim().toLowerCase()) data.email = c.email.trim().toLowerCase();
      if (c.location && (c.location === c.location.toLowerCase() || tidyName(c.location) !== c.location) && c.location.length > 2) data.location = titleCase(c.location);
      if (Object.keys(data).length) fixes.push({ id: c.id, data });
    }
  });
  let fixed = 0;
  for (const f of fixes.slice(0, 2000)) {
    if (f.data.email) { const clash = await prisma.candidate.findFirst({ where: { email: f.data.email, id: { not: f.id } }, select: { id: true } }); if (clash) delete f.data.email; } // eslint-disable-line no-await-in-loop
    if (!Object.keys(f.data).length) continue; // eslint-disable-line no-continue
    await prisma.candidate.update({ where: { id: f.id }, data: f.data }); // eslint-disable-line no-await-in-loop
    fixed += 1;
  }
  const LABELS = { nameSpaces: 'Names with extra spaces', nameCaps: 'Names in CAPITALS', emailCase: 'E-mails with capitals / spaces', emailInvalid: 'E-mails that look wrong', phoneInvalid: 'Phone numbers that are not 10 digits', noPhoneNoEmail: 'No phone and no e-mail', noSkills: 'No skills', noLocation: 'No location', locationCase: 'City in lower case', noResume: 'No resume on file' };
  const result = { at: S.now(), people: count.people, items: Object.entries(LABELS).map(([k, label]) => ({ key: k, label, count: count[k], autoFix: ['nameSpaces', 'emailCase', 'locationCase'].includes(k) })) };
  await S.x('INSERT INTO "MktHealthRun" ("id","at","byName","result","fixed") VALUES (?,?,?,?,?)', S.newId(), S.now(), user ? user.name : 'Nightly check', JSON.stringify(result), fixed);
  if (fixed) await require('../audit').logAudit({ userId: user ? user.id : null, action: `Data-health auto-fix: ${fixed} people tidied`, entity: 'Candidate', entityId: 'many', toValue: 'spaces in names, e-mail case, city case' }); // eslint-disable-line global-require
  return { ...result, fixed };
}
async function healthRuns() {
  const rows = await S.q('SELECT * FROM "MktHealthRun" ORDER BY "at" DESC LIMIT 14');
  return rows.map((r) => ({ at: r.at, byName: r.byName, fixed: S.num(r.fixed), ...(S.parse(r.result, {})) }));
}

// ---- 09.20 attrition risk ---------------------------------------------------------------------------------------------------------
const lakh = (v) => { const n = Number(String(v || '').replace(/[^\d.]/g, '')); if (!Number.isFinite(n) || !n) return null; return n > 1000 ? n / 100000 : n; };
const days = (s) => { const m = String(s || '').match(/(\d+)\s*(day|month|year)?/i); if (!m) return 90; const n = Number(m[1]); return /month/i.test(m[2] || '') ? n * 30 : /year/i.test(m[2] || '') ? n * 365 : n; };
// pure: facts in, score + factors out (the fairness test runs it on name / gender pairs)
function riskScore({ candidate: c, app = {}, job = {}, jobs = [], clientDropRate = null, lastContactDays = null }) {
  const factors = [];
  const add = (points, factor, detail) => { factors.push({ factor, detail, points }); };
  const cur = lakh(c.currentSalary); const off = app.offeredCtc ? app.offeredCtc / 100000 : null;
  if (cur && off) { const rise = (off - cur) / cur; if (rise < 0.1) add(20, 'Small pay rise', `Offered ${off.toFixed(1)} L vs ${cur.toFixed(1)} L now (${Math.round(rise * 100)}%)`); else if (rise > 0.8) add(10, 'Very large pay jump', `${Math.round(rise * 100)}% more: expectations may be high`); }
  const jl = lower(String(job.location || '').split(',')[0]);
  if (jl && !/any|remote/.test(jl) && c.location && !lower(`${c.location} ${c.preferredLocation || ''}`).includes(jl)) add(20, 'Long commute / relocation', `Lives in ${c.location}; the job is in ${job.location}`);
  const spans = (jobs || []).map((j) => { const a = String(j.fromMonth || '').match(/^(\d{4})-(\d{2})/); const b = j.isCurrent ? [0, String(new Date().getFullYear()), String(new Date().getMonth() + 1).padStart(2, '0')] : String(j.toMonth || '').match(/^(\d{4})-(\d{2})/); return a && b ? (Number(b[1]) * 12 + Number(b[2])) - (Number(a[1]) * 12 + Number(a[2])) : null; }).filter((n) => n != null && n >= 0);
  if (spans.length >= 2) { const avg = spans.reduce((s, n) => s + n, 0) / spans.length / 12; if (avg < 1.5) add(25, 'Short stays before', `${spans.length} jobs, about ${avg.toFixed(1)} years each`); }
  if (lastContactDays != null && lastContactDays > 14) add(10, 'No contact since joining', `Last contact ${lastContactDays} days ago`);
  if (clientDropRate != null && clientDropRate >= 0.2) add(15, 'This client loses people', `${Math.round(clientDropRate * 100)}% of past joiners there dropped or left`);
  if (/immediate|serving/i.test(c.noticePeriod || '') && c.experienceYears > 3) add(5, 'Left the last job quickly', `Notice "${c.noticePeriod}" with ${c.experienceYears} years`);
  const score = Math.min(100, factors.reduce((s, f) => s + f.points, 0));
  return { score, level: score >= 50 ? 'High' : score >= 25 ? 'Medium' : 'Low', factors };
}
async function attrition(user, { candidateId = null } = {}) {
  const { applicationWhere } = require('../scope'); // eslint-disable-line global-require
  const apps = await prisma.application.findMany({
    where: { AND: [applicationWhere(user), { stage: { in: ['JOINED', 'HIRED'] } }, ...(candidateId ? [{ candidateId }] : [{ OR: [{ joinedAt: { gte: new Date(Date.now() - 400 * 864e5) } }, { updatedAt: { gte: new Date(Date.now() - 400 * 864e5) } }] }])] },
    include: { candidate: true, requirement: { select: { id: true, title: true, location: true, clientId: true, internal: true, client: { select: { name: true, guaranteePeriod: true } } } } },
    take: 400,
  });
  const PD = require('../candidateProfileDepth'); // eslint-disable-line global-require
  const clientIds = [...new Set(apps.map((a) => a.requirement.clientId))];
  const allJoined = clientIds.length ? await prisma.application.findMany({ where: { requirement: { clientId: { in: clientIds } }, OR: [{ stage: { in: ['JOINED', 'HIRED'] } }, { joiningStatus: 'Dropped' }] }, select: { joiningStatus: true, requirement: { select: { clientId: true } } } }) : [];
  const rate = new Map();
  clientIds.forEach((id) => { const list = allJoined.filter((a) => a.requirement.clientId === id); rate.set(id, list.length >= 3 ? list.filter((a) => a.joiningStatus === 'Dropped').length / list.length : null); });
  const out = [];
  for (const a of apps) {
    const joined = a.joinedAt || (a.joiningDate ? new Date(a.joiningDate) : null);
    const guard = days(a.requirement.client && a.requirement.client.guaranteePeriod);
    const since = joined && !Number.isNaN(joined.getTime()) ? Math.floor((Date.now() - joined.getTime()) / 864e5) : null;
    if (!candidateId && since != null && since > guard) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const [jobs, last] = await Promise.all([PD.employmentOf(a.candidateId).catch(() => []), prisma.applicationFollowUp.findFirst({ where: { applicationId: a.id, lastContactedAt: { not: null } }, orderBy: { lastContactedAt: 'desc' }, select: { lastContactedAt: true } }).catch(() => null)]);
    const lastDays = last && last.lastContactedAt ? Math.floor((Date.now() - last.lastContactedAt.getTime()) / 864e5) : (since != null ? since : null);
    const r = riskScore({ candidate: a.candidate, app: a, job: a.requirement, jobs: jobs.filter((j) => !j.isCurrent || true), clientDropRate: rate.get(a.requirement.clientId), lastContactDays: lastDays });
    out.push({ applicationId: a.id, candidateId: a.candidateId, name: a.candidate.name, requirement: a.requirement.title, client: a.requirement.client && a.requirement.client.name, joined, daysSinceJoining: since, guaranteeDays: guard, ...r });
  }
  out.sort((x, y) => y.score - x.score);
  return { rows: out, note: 'A score from the facts only (pay rise, commute, past job lengths, contact since joining, the client\'s past drops). It never uses name, gender or age. Use it to decide whom to call first.' };
}

// ---- 09.04 / 09.06 the outside profile data connector (stub) -----------------------------------------------------------------------
// ATS wave 2 Y (2026-11-25): the connector is built (utils/atsY/people.js): the graph from our own data works now; the outside search,
// contact finding and enrichment wait for the founder's provider account + the Admin switch "outsideLookups".
const profileGraph = {
  status() { return { configured: false, state: 'Built: own-data graph working; outside look-ups need a provider account from the founder', note: 'The candidate profile graph (same employer, worked together, same college, referrals, who in TeamLink knows them) and contact finding from our own records work now. Searching outside profiles, verified contact finding and enrichment use the "People & company data provider" card in Administration > Integrations once the founder adds the key of a licensed provider, and only while an Admin has "Outside look-ups" on.' }; },
  async find(user, filters) { return require('../atsY/people').searchOutside(user, filters || {}); }, // eslint-disable-line global-require
};

// ---- the timers -------------------------------------------------------------------------------------------------------------------
let started = false;
function start() {
  if (started || /^(1|true)$/i.test(String(process.env.TEST_MODE || '')) || require('../sandbox').isSandbox()) return; // eslint-disable-line global-require
  started = true;
  const safe = (name, fn) => () => fn().catch((e) => console.error(`[mktb:${name}]`, e.message)); // eslint-disable-line no-console
  const every = (ms, name, fn, first = 5 * 60e3) => { setTimeout(safe(name, fn), first).unref(); setInterval(safe(name, fn), ms).unref(); };
  every(2 * 60e3, 'workflows', workflowSweep);
  every(10 * 60e3, 'auto-reject', async () => { if (await S.setting('autoReject.on')) await require('./pipe').runAutoReject({ dryRun: false }); }); // eslint-disable-line global-require
  every(6 * 3600e3, 'job-watch', () => require('./jobs').watchSweep(), 20 * 60e3); // eslint-disable-line global-require
  every(6 * 3600e3, 'saved-search', () => require('./cands').savedSweep(), 25 * 60e3); // eslint-disable-line global-require
  every(6 * 3600e3, 'doc-expiry', () => require('./cands').docExpirySweep(), 30 * 60e3); // eslint-disable-line global-require
  every(7 * 24 * 3600e3, 'stale-profiles', () => require('./cands').staleSweep(), 2 * 3600e3); // eslint-disable-line global-require
  every(24 * 3600e3, 'data-health', async () => { if (await S.setting('dataHealth.schedule')) await dataHealth({ fix: !!(await S.setting('dataHealth.autofix')) }); }, 60 * 60e3);
  every(24 * 3600e3, 'fraud-scan', async () => { await require('./cands').fraudScan(); await require('./pipe').backdoorScan(); }, 90 * 60e3); // eslint-disable-line global-require
}

module.exports = {
  rediscover, runs, runDetail, agentSubmission, agentFollowUp, agentCleanup, agentPlaybook, decideActions, cleanupOf,
  TRIGGERS, ACTIONS, workflows, saveWorkflow, deleteWorkflow, runWorkflow, workflowSweep, workflowLog,
  dataHealth, healthRuns, riskScore, attrition, profileGraph, start,
};
