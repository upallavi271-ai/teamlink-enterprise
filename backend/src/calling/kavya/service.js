// ---------------------------------------------------------------------------
// KAVYA SERVICE - hand a batch of ATS candidates (ONE requirement) to Kavya, read the results back.
//
// Nothing here dials or talks. Kavya (the Telugu / Hindi / English AI caller on this server) does that through its own dialer. TeamLink keeps
// every rule it already has for AI calling and applies them BEFORE a candidate is handed over:
//   who may call        calling/callService.accessVerdict   (the Admin's role list, the Contact right, the record's scope)
//   who may be called   calling/policy.personVerdict        (Off / Test / Live switch and test numbers, opt-out, DND, consent, phone number)
//   no double calls     a number that is already inside an unfinished Kavya run is skipped
// Kavya's own dialer then keeps its calling hours (9-18 IST by default), its lines limit, retries and its do-not-call list.
// What comes back (outcome, language, seconds, interview slot, why not interested, area + distance) is copied into KavyaCall, and one line is
// written on the candidate's timeline ("Kavya call"). A call NEVER changes a stage or an interview - a recruiter does that.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../../db');
const DB = require('./schema');
const client = require('./client');
const svc = require('../callService');
const P = require('../policy');
const settingsStore = require('../settings');
const core = require('../../utils/messagingCore');
const { logAudit } = require('../../utils/audit');

const ACTIVE = ['draft', 'preparing', 'running', 'paused'];
const MAX_PEOPLE = 200;
const SYNC_EVERY_MS = 20000;
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const newId = () => `kr_${crypto.randomBytes(8).toString('hex')}`;
const fail = (status, code, error, extra) => ({ ok: false, status, code, error, ...(extra || {}) });
const isAdmin = (u) => !!u && ['SUPER_ADMIN', 'ADMIN'].includes(String(u.role || '').toUpperCase());
const json = (v, d) => { try { return JSON.parse(v); } catch { return d; } };

// ---- the requirement, in words Kavya can say -----------------------------------------------------------------------------------
function sayExperience(v) {
  const t = String(v || '').trim();
  const n = t.match(/\d+(?:\.\d+)?/g);
  if (!n) return '';
  if (n.length >= 2) return `${n[0]} to ${n[1]} years`;
  return `${n[0]}${/\+|plus|above/i.test(t) ? ' plus' : ''} years`;
}
function saySalary(v) {
  const t = String(v || '').trim();
  if (!t) return '';
  return t.replace(/[₹]/g, '').replace(/INR/gi, '').replace(/(\d)\s*L\b/gi, '$1 lakhs').replace(/(\d)\s*K\b/gi, '$1 thousand').replace(/\s*-\s*/g, ' to ').replace(/\s+/g, ' ').trim();
}
function jobType(v) {
  const t = String(v || '').toLowerCase();
  if (t.includes('part')) return 'Part time';
  if (t.includes('contract')) return 'Contract hire';
  return 'Full time';
}
function jobFor(requirement, user, extras) {
  const x = extras || {};
  const skills = String(requirement.skills || '').split(',').map((s) => s.trim()).filter(Boolean);
  const edu = String(requirement.qualifications || requirement.education || '').trim();
  const joining = String(requirement.joiningTimeline || '').trim();
  const notice = String(requirement.noticePeriodMax || '').trim();
  const out = {
    job_title: clip(requirement.title, 120),
    client: clip((requirement.client && requirement.client.name) || 'our client', 120),
    job_location: clip(requirement.location || (requirement.client && requirement.client.location) || '', 120),
    salary_range: clip(saySalary(requirement.salary), 160),
    exp_required: sayExperience(requirement.experience),
    relevant_skill: clip(skills[0] || requirement.title, 120),
    job_type: jobType(requirement.employmentType),
    qualification: /^any degree$/i.test(edu) ? '' : clip(edu, 160),
    notice_period: notice ? clip(`up to ${notice.toLowerCase()} notice period`, 160) : '',
    joining: joining ? clip(`Joining ${joining.toLowerCase()}`, 160) : '',
    interview_mode: clip(x.interviewMode || '', 60),
    languages_req: clip(x.languagesRequired || '', 80),
    owner: clip(user && user.name, 80),
    portal: 'api',
    job_kind: 'general',
    client_type: 'it',
  };
  Object.keys(out).forEach((k) => { if (out[k] === '') delete out[k]; });
  return out;
}
const phone10 = (raw) => { const m = core.normalizeMobile(raw); return m.ok ? P.phoneKey(m.e164) : ''; };

// ---- status ---------------------------------------------------------------------------------------------------------------------
async function status(user) {
  const s = await settingsStore.load();
  const h = client.configured() ? await client.health() : { ok: false, error: 'Kavya is not connected on this server.' };
  return {
    ok: true,
    configured: client.configured(),
    reachable: !!h.ok,
    problem: h.ok ? null : h.error,
    mode: s.mode, // the same Off / Test / Live switch as AI Calling
    testMode: s.mode === 'Test',
    canCall: P.roleAllows(user, s),
    canBulk: P.roleAllows(user, s, true),
    maxPeople: MAX_PEOPLE,
  };
}

// ---- start a run ----------------------------------------------------------------------------------------------------------------
async function createRun(user, input) {
  const b = input || {};
  const ids = [...new Set((Array.isArray(b.applicationIds) ? b.applicationIds : []).map((x) => clip(x, 60)).filter(Boolean))];
  if (!ids.length) return fail(400, 'none', 'Tick at least one candidate.');
  if (ids.length > MAX_PEOPLE) return fail(400, 'too_many', `Kavya takes up to ${MAX_PEOPLE} candidates at a time.`);
  if (!client.configured()) return fail(503, 'not_connected', 'Kavya is not connected on this server.');
  const s = await settingsStore.load({ fresh: true });
  const source = ['ats', 'portal', 'omni'].includes(b.source) ? b.source : 'ats';

  const skipped = [];
  const people = [];
  let requirement = null;
  const active = await DB.all(`SELECT "peopleJson" FROM "KavyaRun" WHERE "status" IN (${ACTIVE.map(() => '?').join(',')})`, ...ACTIVE);
  const busy = new Set();
  active.forEach((r) => json(r.peopleJson, []).forEach((p) => busy.add(p.phone)));

  for (const id of ids) { // eslint-disable-line no-restricted-syntax
    // eslint-disable-next-line no-await-in-loop
    const ctx = await svc.loadContext(id);
    if (!ctx) { skipped.push({ applicationId: id, name: '', reason: 'Application not found.' }); continue; }
    const name = ctx.candidate && ctx.candidate.name;
    // eslint-disable-next-line no-await-in-loop
    const acc = await svc.accessVerdict(user, ctx, s, { bulk: ids.length > 1 });
    if (!acc.ok) {
      if (['login', 'role', 'contact', 'bulk'].includes(acc.code)) return fail(acc.status || 403, acc.code, acc.error);
      skipped.push({ applicationId: id, name, reason: acc.error }); continue;
    }
    if (!requirement) requirement = ctx.requirement;
    if (ctx.requirement.id !== requirement.id) { skipped.push({ applicationId: id, name, reason: 'A different requirement: start a separate run for it.' }); continue; }
    // eslint-disable-next-line no-await-in-loop
    const jset = await svc.jobSetting(requirement.id);
    // eslint-disable-next-line no-await-in-loop
    const v = await P.personVerdict({ candidate: ctx.candidate, app: ctx.app, requirement, purpose: 'Screening', s, now: new Date(), jobSetting: jset });
    if (v && v.ok === false) { skipped.push({ applicationId: id, name, reason: v.reason || 'Not allowed.' }); continue; }
    const ph = phone10(ctx.candidate.phone);
    if (!ph) { skipped.push({ applicationId: id, name, reason: 'No usable phone number.' }); continue; }
    if (busy.has(ph) || people.some((p) => p.phone === ph)) { skipped.push({ applicationId: id, name, reason: 'Already with Kavya (an unfinished run has this number).' }); continue; }
    people.push({
      applicationId: id, candidateId: ctx.candidate.id, phone: ph, name: clip(name, 80),
      city: clip(ctx.candidate.location, 60), gender: clip(ctx.candidate.gender, 20),
      role: clip(ctx.candidate.currentDesignation, 80),
      exp: ctx.candidate.experienceYears != null ? String(ctx.candidate.experienceYears) : '',
    });
  }
  if (!people.length) return fail(422, 'nobody', 'Nobody on the list can be called by Kavya.', { skipped });

  const job = jobFor(requirement, user, b.extras);
  const created = await client.createJob({ ...job, candidates: people.map((p) => ({ name: p.name, phone: p.phone, city: p.city, gender: p.gender, role: p.role, exp: p.exp })) });
  if (!created.ok) return fail(502, 'kavya', created.error);
  const kavyaJobId = created.data.job_id;
  let state = 'draft';
  let note = '';
  if (b.start !== false) {
    const st = await client.startJob(kavyaJobId);
    if (st.ok) state = 'preparing'; else note = `Saved, but Kavya could not start it: ${st.error}`;
  }
  const id = newId();
  const slim = people.map((p) => ({ applicationId: p.applicationId, candidateId: p.candidateId, phone: p.phone, name: p.name }));
  await DB.run(
    'INSERT INTO "KavyaRun" ("id","source","requirementId","title","kavyaJobId","status","total","peopleJson","skippedJson","note","createdById","createdByName","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, source, requirement.id, clip(requirement.title, 160), kavyaJobId, state, people.length, JSON.stringify(slim), JSON.stringify(skipped), note, user.id, clip(user.name, 80), DB.nowIso(),
  );
  await logAudit({ userId: user.id, action: 'Kavya run created', entity: 'KavyaRun', entityId: id, toValue: `${requirement.title}: ${people.length} candidate(s), ${skipped.length} skipped, ${state}`.slice(0, 200) });
  return { ok: true, id, kavyaJobId, status: state, started: people.length, skipped, note };
}

// People ticked on a screen that mixes requirements (the Job Portal list, Omni-Channel): one Kavya run per requirement.
async function createRuns(user, input) {
  const b = input || {};
  const ids = [...new Set((Array.isArray(b.applicationIds) ? b.applicationIds : []).map((x) => clip(x, 60)).filter(Boolean))];
  if (!ids.length) return fail(400, 'none', 'Tick at least one candidate.');
  if (ids.length > MAX_PEOPLE) return fail(400, 'too_many', `Kavya takes up to ${MAX_PEOPLE} candidates at a time.`);
  const groups = new Map();
  const unknown = [];
  for (const id of ids) { // eslint-disable-line no-restricted-syntax
    // eslint-disable-next-line no-await-in-loop
    const ctx = await svc.loadContext(id);
    if (!ctx) { unknown.push({ applicationId: id, name: '', reason: 'Application not found.' }); continue; }
    const k = ctx.requirement.id;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(id);
  }
  if (!groups.size) return fail(404, 'none', 'None of these applications was found.', { skipped: unknown });
  if (groups.size === 1) {
    const r = await createRun(user, { ...b, applicationIds: [...groups.values()][0] });
    return r.ok ? { ...r, runs: [{ id: r.id, started: r.started }], skipped: [...unknown, ...(r.skipped || [])] } : r;
  }
  const runs = [];
  const skipped = [...unknown];
  let firstFail = null;
  for (const list of groups.values()) { // eslint-disable-line no-restricted-syntax
    // eslint-disable-next-line no-await-in-loop
    const r = await createRun(user, { ...b, applicationIds: list });
    if (r.ok) { runs.push({ id: r.id, started: r.started }); skipped.push(...(r.skipped || [])); } else { firstFail = firstFail || r; skipped.push(...(r.skipped || []), ...(r.skipped ? [] : list.map((id) => ({ applicationId: id, name: '', reason: r.error })))); }
  }
  if (!runs.length) return fail(firstFail ? firstFail.status : 422, firstFail ? firstFail.code : 'nobody', firstFail ? firstFail.error : 'Nobody could be handed to Kavya.', { skipped });
  return { ok: true, id: runs[0].id, runs, started: runs.reduce((a, r) => a + r.started, 0), skipped, note: runs.length > 1 ? `${runs.length} runs were made, one for each requirement.` : '' };
}

// ---- reading ---------------------------------------------------------------------------------------------------------------------
function shapeRun(r, calls) {
  const list = calls || [];
  const by = {};
  list.forEach((c) => { by[c.outcome || '-'] = (by[c.outcome || '-'] || 0) + 1; });
  return {
    id: r.id, source: r.source, requirementId: r.requirementId, title: r.title, kavyaJobId: r.kavyaJobId, status: r.status, total: r.total,
    called: list.length, outcomes: by, skipped: json(r.skippedJson, []), note: r.note, createdByName: r.createdByName, createdAt: r.createdAt, lastSyncAt: r.lastSyncAt,
  };
}
const visible = (user, r) => isAdmin(user) || r.createdById === user.id;

async function listRuns(user) {
  const rows = await DB.all('SELECT * FROM "KavyaRun" ORDER BY "createdAt" DESC LIMIT 100');
  const mine = rows.filter((r) => visible(user, r));
  const out = [];
  for (const r of mine) { // eslint-disable-line no-restricted-syntax
    // eslint-disable-next-line no-await-in-loop
    const calls = await DB.all('SELECT "outcome" FROM "KavyaCall" WHERE "runId" = ?', r.id);
    out.push(shapeRun(r, calls));
  }
  return { ok: true, runs: out };
}

const OUTCOME_WORD = {
  interested: 'interested', not_interested: 'not interested', not_relevant: 'not relevant', no_answer_from_caller: 'no answer from the candidate',
  wants_other_opening: 'wants another opening', callback: 'asked for a call back', no_clear_response: 'no clear response', keep_profile: 'keep the profile',
  wants_higher_package: 'wants a higher package',
};
const outcomeWord = (o) => OUTCOME_WORD[o] || String(o || 'finished').replace(/_/g, ' ');

async function timelineLine(run, person, call, user) {
  if (!person || !person.candidateId) return;
  const bits = [`Kavya call: ${outcomeWord(call.outcome)}`];
  if (call.seconds != null) bits.push(`${call.seconds} s`);
  if (call.language) bits.push(call.language);
  if (call.slot) bits.push(`interview time asked: ${clip(call.slot, 120)}`);
  if (call.reason) bits.push(`reason: ${clip(call.reason, 120)}`);
  if (call.area) bits.push(`stays in ${clip(call.area, 60)}${call.distanceKm !== '' && call.distanceKm != null ? ` (about ${call.distanceKm} km from the job)` : ''}`);
  try {
    await prisma.candidateMessage.create({
      data: {
        candidateId: person.candidateId,
        applicationId: person.applicationId || null,
        channel: 'Call',
        template: 'KAVYA_CALL',
        templateLabel: 'Kavya call',
        trigger: 'AI call',
        recipient: `xxxxxx${String(person.phone || '').slice(-4)}`,
        body: clip(bits.join(' · '), 1500),
        status: 'LOGGED',
        statusDetail: clip(`${run.title}: ${outcomeWord(call.outcome)}`, 480),
        senderUserId: run.createdById || null,
        senderName: `AI assistant (Kavya${run.createdByName ? `, for ${run.createdByName}` : ''})`,
        stageFrom: null,
        stageTo: null,
      },
    });
  } catch (err) { console.error('[kavya] timeline:', err.message); } // eslint-disable-line no-console
  void user;
}

// copy new results from Kavya into KavyaCall (+ the timeline once per call)
async function sync(run) {
  if (!run.kavyaJobId) return run;
  const people = json(run.peopleJson, []);
  const byPhone = new Map(people.map((p) => [p.phone, p]));
  const res = await client.jobResults(run.kavyaJobId);
  const st = await client.jobStatus(run.kavyaJobId);
  if (res.ok) {
    for (const c of res.data.calls || []) { // eslint-disable-line no-restricted-syntax
      const id = `${run.id}:${c.call_id}`;
      // eslint-disable-next-line no-await-in-loop
      if (await DB.one('SELECT "id" FROM "KavyaCall" WHERE "id" = ?', id)) continue;
      const ph = String(c.phone || '').replace(/\D/g, '').slice(-10);
      const person = byPhone.get(ph) || null;
      const row = {
        outcome: c.outcome || '', language: c.language || '', seconds: c.seconds != null ? Number(c.seconds) : null, slot: c.interview_slot || '',
        reason: c.not_interested_reason || '', reasonType: c.reason_type || '', area: c.candidate_area || '', distanceKm: c.distance_to_job_km === '' || c.distance_to_job_km == null ? '' : String(c.distance_to_job_km),
      };
      // eslint-disable-next-line no-await-in-loop
      await DB.run(
        'INSERT OR IGNORE INTO "KavyaCall" ("id","runId","kavyaCallId","applicationId","candidateId","phone","name","outcome","language","seconds","slot","reasonType","reason","area","distanceKm","answersJson","calledAt","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id, run.id, c.call_id, person && person.applicationId, person && person.candidateId, ph, clip(c.name || (person && person.name), 80), row.outcome, row.language, row.seconds, row.slot, row.reasonType, row.reason, row.area, row.distanceKm,
        JSON.stringify(c.answers || {}).slice(0, 20000), c.ts || null, DB.nowIso(),
      );
      // eslint-disable-next-line no-await-in-loop
      await timelineLine(run, person, row);
    }
  }
  let status = run.status;
  if (st.ok && st.data && st.data.job) {
    const js = st.data.job.status;
    const left = Object.entries(st.data.candidates_by_status || {}).filter(([k]) => ['queued', 'calling'].includes(k)).reduce((a, [, n]) => a + n, 0);
    if (js === 'running' && left === 0) status = 'completed';
    else if (['running', 'preparing', 'paused', 'draft'].includes(js)) status = js;
    if (js === 'draft' && run.status === 'preparing' && st.data.job.msg && /could not/i.test(st.data.job.msg)) run.note = clip(st.data.job.msg, 300);
  }
  await DB.run('UPDATE "KavyaRun" SET "status" = ?, "note" = ?, "lastSyncAt" = ? WHERE "id" = ?', status, run.note || '', DB.nowIso(), run.id);
  return { ...run, status, lastSyncAt: DB.nowIso() };
}

async function runDetail(user, id) {
  let r = await DB.one('SELECT * FROM "KavyaRun" WHERE "id" = ?', clip(id, 60));
  if (!r || !visible(user, r)) return fail(404, 'none', 'Run not found.');
  const stale = !r.lastSyncAt || Date.now() - new Date(r.lastSyncAt).getTime() > SYNC_EVERY_MS;
  if (stale && ACTIVE.includes(r.status)) r = await sync(r);
  else if (stale && r.status === 'completed' && !r.lastSyncAt) r = await sync(r);
  const calls = await DB.all('SELECT * FROM "KavyaCall" WHERE "runId" = ? ORDER BY "kavyaCallId"', r.id);
  const people = json(r.peopleJson, []);
  const called = new Set(calls.map((c) => c.phone));
  return {
    ok: true,
    run: shapeRun(r, calls),
    calls: calls.map((c) => ({ id: c.id, applicationId: c.applicationId, name: c.name, phone: `xxxxxx${String(c.phone || '').slice(-4)}`, outcome: c.outcome, language: c.language, seconds: c.seconds, slot: c.slot, reasonType: c.reasonType, reason: c.reason, area: c.area, distanceKm: c.distanceKm, calledAt: c.calledAt })),
    waiting: people.filter((p) => !called.has(p.phone)).map((p) => ({ applicationId: p.applicationId, name: p.name })),
  };
}

async function control(user, id, action) {
  const r = await DB.one('SELECT * FROM "KavyaRun" WHERE "id" = ?', clip(id, 60));
  if (!r || !visible(user, r)) return fail(404, 'none', 'Run not found.');
  if (!r.kavyaJobId) return fail(409, 'state', 'This run has no Kavya job.');
  if (action === 'pause') {
    const x = await client.pauseJob(r.kavyaJobId);
    if (!x.ok) return fail(502, 'kavya', x.error);
    await DB.run('UPDATE "KavyaRun" SET "status" = ? WHERE "id" = ?', 'paused', r.id);
  } else if (action === 'start') {
    const s = await settingsStore.load({ fresh: true });
    if (s.mode === 'Off') return fail(409, 'off', 'AI calling is switched off. An Admin turns it on in Administration > Integrations > AI Calling.');
    const x = await client.startJob(r.kavyaJobId);
    if (!x.ok) return fail(502, 'kavya', x.error);
    await DB.run('UPDATE "KavyaRun" SET "status" = ? WHERE "id" = ?', 'preparing', r.id);
  } else return fail(400, 'action', 'Unknown action.');
  await logAudit({ userId: user.id, action: `Kavya run: ${action}`, entity: 'KavyaRun', entityId: r.id, toValue: clip(r.title, 120) });
  return { ok: true, status: action === 'pause' ? 'paused' : 'preparing' };
}

module.exports = { status, createRun, createRuns, listRuns, runDetail, control, sync, jobFor, sayExperience, saySalary, jobType, phone10 };
