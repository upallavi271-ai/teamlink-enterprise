// ---------------------------------------------------------------------------
// KAVYA AS THE CALLING ENGINE (founder 2026-11-12: "ai calling unna prathi chota Kavya ney call cheyyali").
//
// Every AI call of TeamLink - the ATS "Call candidates" screen, the Job Portal list, Omni-Channel AI Voice campaigns - is an ordinary AiCall row that
// callService.dispatch / voice/sipCall.dialQueued place after ALL the rules have passed (role, consent, DND, test numbers, calling hours, daily limits,
// one call at a time). Just before the old engine would ring, those two functions ask handOver(): when Kavya is on (the engine switch), reachable, and
// the purpose is one she speaks (Screening, Job Match: the job pitch), the candidate is added to Kavya's job for that requirement and the row waits as
// "calling". Kavya's own dialer rings (9 am - 6 pm, her lines limit, retries). syncAll() copies what she finished back into the SAME row through
// outcomes.applyResult: outcome, summary, follow-up, timeline line, call-backs - the screens, campaigns and counters never know the difference.
//
//   engine switch   KavyaSetting 'engine': 'kavya' (default) | 'old'  - one switch back to the old engine (Admin: POST /api/kavya/engine)
//   fall back       Kavya off / not reachable / any error here -> handOver() answers false and the old engine places the call exactly as before
//   purposes        Screening, Job Match. Interview notices / reminders, shortlist notices and "AI interview pending" stay on the old engine until Kavya
//                   has those scripts (she would pitch a job instead of confirming an interview)
// The pre-Kavya code is saved: git tag backup/ai-calling-before-kavya-engine-20261112, ~/teamlink-backups/ai-calling-before-kavya-engine-20261112 and
// /root/ai-calling-before-kavya-engine-20261112 on the VPS (code + database copy).
// ---------------------------------------------------------------------------
const DB = require('./schema');
const client = require('./client');
const kavya = require('./service');
const svc = require('../callService');
const P = require('../policy');
const S = require('../scripts');

const PURPOSES = ['Screening', 'Job Match'];
const REUSE_HOURS = 24; // candidates of one requirement join the same Kavya job for a day (her clips are made once per job)
const GIVE_UP_HOURS = 12; // Kavya never reached the candidate in this time: closed as not answered
const log = (...a) => console.log('[kavya-engine]', ...a); // eslint-disable-line no-console
const nowIso = () => new Date().toISOString();
const json = (v, d) => { try { return JSON.parse(v); } catch { return d; } };
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

async function getEngine() {
  const r = await DB.one('SELECT "value" FROM "KavyaSetting" WHERE "key" = ?', 'engine');
  return r && r.value === 'old' ? 'old' : 'kavya';
}
async function setEngine(value) {
  const v = value === 'old' ? 'old' : 'kavya';
  await DB.run('INSERT OR REPLACE INTO "KavyaSetting" ("key","value","updatedAt") VALUES (?,?,?)', 'engine', v, nowIso());
  return v;
}

let healthAt = 0;
let healthOk = false;
async function kavyaUp() {
  if (Date.now() - healthAt < 30000) return healthOk;
  const h = await client.health();
  healthOk = !!h.ok;
  healthAt = Date.now();
  return healthOk;
}
async function wants(purpose) {
  if (!PURPOSES.includes(purpose) || !client.configured()) return false;
  if ((await getEngine()) !== 'kavya') return false;
  return kavyaUp();
}

// one hand-over at a time per requirement, so two candidates of the same requirement never make two Kavya jobs
const chains = new Map();
function inChain(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  chains.set(key, next);
  next.finally(() => { if (chains.get(key) === next) chains.delete(key); }).catch(() => {});
  return next;
}

async function openRun(requirementId) {
  const since = new Date(Date.now() - REUSE_HOURS * 3600000).toISOString();
  return DB.one('SELECT * FROM "KavyaRun" WHERE "source" = ? AND "requirementId" = ? AND "createdAt" > ? AND "status" IN (\'draft\',\'preparing\',\'running\',\'paused\',\'completed\') ORDER BY "createdAt" DESC LIMIT 1', 'engine', requirementId, since);
}

// called by dispatch() and dialQueued() after every rule has passed. true = Kavya has the candidate; false = the old engine places the call.
async function handOver(row, ctx, verdict, opts = {}) {
  try {
    if (!row) return false;
    if (!(await wants(row.purpose))) return false;
    const ph = P.phoneKey(verdict && verdict.e164);
    if (!ph || !ctx || !ctx.candidate || !ctx.requirement) return false;
    const c = ctx.candidate;
    const person = {
      name: clip(c.name, 80), phone: ph, city: clip(c.location, 60), gender: clip(c.gender, 20), role: clip(c.currentDesignation, 80),
      exp: c.experienceYears != null ? String(c.experienceYears) : '',
    };
    const ok = await inChain(ctx.requirement.id, async () => {
      let run = await openRun(ctx.requirement.id);
      let people = run ? json(run.peopleJson, []) : [];
      if (await DB.one('SELECT "callId" FROM "KavyaLink" WHERE "phone" = ? AND "appliedAt" IS NULL AND "callId" <> ?', ph, row.id)) return false; // another unfinished Kavya call to this number
      if (!run) {
        const job = kavya.jobFor(ctx.requirement, { name: row.initiatedByName }, {});
        const created = await client.createJob({ ...job, candidates: [person] });
        if (!created.ok) throw new Error(created.error);
        const kid = created.data.job_id;
        const st = await client.startJob(kid);
        const id = `kr_${require('crypto').randomBytes(8).toString('hex')}`; // eslint-disable-line global-require
        await DB.run(
          'INSERT INTO "KavyaRun" ("id","source","requirementId","title","kavyaJobId","status","total","peopleJson","skippedJson","note","createdById","createdByName","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
          id, 'engine', ctx.requirement.id, clip(ctx.requirement.title, 160), kid, st.ok ? 'preparing' : 'draft', 1, JSON.stringify([{ applicationId: ctx.app.id, candidateId: c.id, phone: ph, name: person.name, callId: row.id }]), '[]', st.ok ? '' : `Saved, but Kavya could not start it: ${st.error}`, row.initiatedById || null, clip(row.initiatedByName, 80), nowIso(),
        );
        run = { id, kavyaJobId: kid };
      } else {
        const add = await client.request('POST', `/api/v1/jobs/${Number(run.kavyaJobId)}/candidates`, { candidates: [person] });
        if (!add.ok) throw new Error(add.error);
        if (['paused', 'draft'].includes(run.status)) await client.startJob(run.kavyaJobId);
        people = people.filter((p) => p.callId !== row.id);
        people.push({ applicationId: ctx.app.id, candidateId: c.id, phone: ph, name: person.name, callId: row.id });
        await DB.run('UPDATE "KavyaRun" SET "peopleJson" = ?, "total" = ?, "status" = CASE WHEN "status" = \'completed\' THEN \'running\' ELSE "status" END WHERE "id" = ?', JSON.stringify(people), people.length, run.id);
      }
      await DB.run('INSERT OR REPLACE INTO "KavyaLink" ("callId","runId","phone","createdAt","appliedAt") VALUES (?,?,?,?,NULL)', row.id, run.id, ph, nowIso());
      return true;
    });
    if (!ok) return false;
    const n = opts.counted ? (Number(row.attempts) || 1) : (Number(row.attempts) || 0) + 1; // opts.counted: place() already made the row and counted the attempt
    const stamp = nowIso();
    if (!opts.counted) await DB.run('INSERT OR IGNORE INTO "AiCallEvent" ("id","callId","eventKey","kind","status","applied","receivedAt") VALUES (?,?,?,?,?,1,?)', svc.newId('aie'), row.id, `attempt:${row.id}:${n}`, 'attempt', 'attempt', stamp);
    // initiatedVia 'sip' rows are swept as "not answered" after 90 s by the old phone line: a Kavya call must not carry it
    await svc.setRow(row.id, { attempts: n, lastAttemptAt: stamp, status: 'calling', nextAttemptAt: null, waitReason: null, failReason: null, startedAt: stamp, endedAt: null, providerStatus: 'kavya', callSid: `kavya:${row.id}`, initiatedVia: row.initiatedVia === 'sip' ? 'recruiter' : row.initiatedVia });
    log(`${row.purpose} call ${row.id} handed to Kavya`);
    return true;
  } catch (err) {
    console.error('[kavya-engine] hand-over failed, the old engine places this call:', err.message); // eslint-disable-line no-console
    return false;
  }
}

// ---- Kavya's result -> the AiCall row ------------------------------------------------------------------------------------------------
const LANG = { te: 'Telugu', hi: 'Hindi', en: 'English' };
function resultFor(row, call) {
  const o = String(call.outcome || '');
  let outcome = 'Unclear';
  let interest = null;
  let callbackRequested = false;
  if (o === 'interested') { outcome = 'Interested'; interest = 'yes'; }
  else if (['not_interested', 'not_relevant', 'wants_higher_package'].includes(o)) { outcome = 'Not Interested'; interest = 'no'; }
  else if (o === 'callback') { outcome = 'Call Back Later'; callbackRequested = true; }
  const lang = LANG[call.language] || (S.LANGS.includes(row.language) ? row.language : 'English');
  const bits = [`Kavya (${lang}): ${String(o || 'finished').replace(/_/g, ' ')}.`];
  if (call.slot) bits.push(`Interview time asked: ${clip(call.slot, 100)}.`);
  if (call.reason || call.reasonType) bits.push(`Why not: ${clip(call.reasonType, 20)}${call.reason ? ` - ${clip(call.reason, 100)}` : ''}.`);
  if (call.area) bits.push(`Stays in ${clip(call.area, 40)}${call.distanceKm !== '' && call.distanceKm != null ? ` (about ${call.distanceKm} km from the job)` : ''}.`);
  const ans = json(call.answersJson, {});
  const exp = String(ans.total_exp || '').match(/\d+(?:\.\d+)?/);
  const answers = {};
  if (exp && Number(exp[0]) <= 50) answers.experienceYears = Number(exp[0]);
  if (call.area) answers.currentLocation = clip(call.area, 40);
  if (outcome === 'Interested') answers.willingToProceed = true;
  return {
    purpose: row.purpose, language: lang, outcome, interest, identityConfirmed: true, answers,
    callbackRequested, callbackWhen: callbackRequested ? clip(ans.callback_when || '', 120) : undefined,
    declineReason: outcome === 'Not Interested' ? clip(call.reason || call.reasonType || '', 120) : undefined,
    preferredTime: call.slot ? clip(call.slot, 120) : undefined,
    summary: clip(bits.join(' '), 600), turns: 0,
  };
}

async function applyOne(link, calls) {
  const row = await svc.getCall(link.callId);
  if (!row) { await DB.run('UPDATE "KavyaLink" SET "appliedAt" = ? WHERE "callId" = ?', nowIso(), link.callId); return; }
  if (row.status !== 'calling') { await DB.run('UPDATE "KavyaLink" SET "appliedAt" = ? WHERE "callId" = ?', nowIso(), link.callId); return; } // cancelled meanwhile
  const real = calls.filter((c) => c.outcome && c.outcome !== 'no_answer_from_caller').pop();
  const ageH = (Date.now() - new Date(link.createdAt).getTime()) / 3600000;
  const missed = calls.filter((c) => c.outcome === 'no_answer_from_caller').length;
  const stamp = nowIso();
  if (real) {
    await svc.setRow(row.id, { status: 'completed', endedAt: stamp, durationSec: real.seconds != null ? Number(real.seconds) : null, providerStatus: 'kavya-completed', outcomePending: 1 });
    await require('../outcomes').applyResult(row.id, resultFor(row, real), []); // eslint-disable-line global-require
  } else if (missed >= 2 || (missed >= 1 && ageH > 6) || ageH > GIVE_UP_HOURS) {
    const why = missed ? 'Kavya called, but the candidate did not answer.' : 'Kavya could not reach the candidate in time.';
    await svc.setRow(row.id, { status: 'no-answer', failReason: why, endedAt: stamp, providerStatus: 'kavya-no-answer', nextAttemptAt: null });
    await require('../outcomes').attemptFailed(await svc.getCall(row.id), why, true); // eslint-disable-line global-require
  } else return; // still waiting
  await DB.run('UPDATE "KavyaLink" SET "appliedAt" = ? WHERE "callId" = ?', stamp, link.callId);
  log(`call ${row.id} finished: ${real ? real.outcome : 'no answer'}`);
}

// ---- Omni-Channel / Green Start script calls (Kavya SCRIPT MODE) ---------------------------------------------------------------------------
// Green Start asks TeamLink for ONE call by the script of its campaign (omniCalls.create -> sipCall.dialOmni). When the switch 'omniEngine' is 'kavya'
// (default 'old': Admin turns it on in the Kavya tab) and Kavya is reachable, dialOmni hands the script to Kavya instead of ringing the old line; her
// finished call is written on the same AiCall row (omniCalls.applyResult), so Green Start reads it exactly as before. Any problem: the old line rings.
async function omniOn() {
  const r = await DB.one('SELECT "value" FROM "KavyaSetting" WHERE "key" = ?', 'omniEngine');
  return !!r && r.value === 'kavya';
}
async function setOmni(value) {
  const v = value === 'kavya' ? 'kavya' : 'old';
  await DB.run('INSERT OR REPLACE INTO "KavyaSetting" ("key","value","updatedAt") VALUES (?,?,?)', 'omniEngine', v, nowIso());
  return v;
}
async function handOverOmni(row, input, e164) {
  try {
    if (!row || !(await omniOn()) || !client.configured() || !(await kavyaUp())) return false;
    const sj = (input && input.scriptJson) || {};
    const a = sj.agentScript || {};
    if (!a.text) return false;
    const scripts = {};
    Object.entries(a.texts || {}).forEach(([k, v]) => { if (v) scripts[k] = v; });
    const r = await client.request('POST', '/api/v1/script-calls', {
      externalId: String(input.externalId || ''), toNumber: P.phoneKey(e164), name: clip(sj.omni && sj.omni.name, 80), script: a.text, scriptLanguage: a.language || 'English', scripts, agentName: clip(a.name || 'Kavya', 60),
    }, 30000);
    if (!r.ok || !r.data || !r.data.id) return false;
    await svc.setRow(row.id, { providerStatus: 'kavya-script', callSid: `kavya-script:${r.data.id}`, initiatedVia: 'kavya' });
    log(`omni call ${row.id} handed to Kavya (script call ${r.data.id})`);
    return true;
  } catch (err) {
    console.error('[kavya-engine] omni hand-over failed, the old line rings:', err.message); // eslint-disable-line no-console
    return false;
  }
}
// Kavya's finished script call -> the row. Called when Green Start asks for the call, and every 45 s for the ones still open.
async function syncScriptCall(row) {
  const sid = String(row.callSid || '');
  if (!sid.startsWith('kavya-script:') || row.status !== 'calling') return false;
  const kid = Number(sid.split(':')[1]);
  const ageH = (Date.now() - new Date(row.startedAt || row.createdAt).getTime()) / 3600000;
  const r = await client.request('GET', `/api/v1/script-calls/${kid}`);
  const stamp = nowIso();
  if (!r.ok) {
    if (ageH > 3) await svc.setRow(row.id, { status: 'failed', failReason: 'Kavya did not report this call.', endedAt: stamp, providerStatus: 'kavya-lost' });
    return false;
  }
  const c = r.data;
  if (!c.ended) { if (ageH > 3) await svc.setRow(row.id, { status: 'failed', failReason: 'Kavya did not finish this call in 3 hours.', endedAt: stamp, providerStatus: 'kavya-lost' }); return false; }
  const omni = require('../omniCalls'); // eslint-disable-line global-require
  if (c.status === 'no-answer' || c.status === 'failed') {
    await svc.setRow(row.id, { status: c.status === 'failed' ? 'failed' : 'no-answer', failReason: clip(c.failReason || 'The person did not answer.', 250), endedAt: stamp, providerStatus: 'kavya-' + c.status });
    return true;
  }
  const o = String(c.outcome || '');
  const outcome = o === 'interested' ? 'Interested' : (o === 'not_interested' ? 'Not Interested' : (o === 'callback' ? 'Call Back Later' : 'Unclear'));
  const turns = (c.turns || []).map((t) => ({ who: t.who === 'ai' ? 'assistant' : 'candidate', text: t.text }));
  await svc.setRow(row.id, { status: 'completed', endedAt: stamp, durationSec: c.durationSec != null ? Number(c.durationSec) : null, providerStatus: 'kavya-completed', language: ({ te: 'Telugu', hi: 'Hindi', en: 'English' })[c.language] || row.language });
  await omni.applyResult(row.id, {
    outcome, summary: c.summary || '', interest: o === 'interested' ? 'yes' : (o === 'not_interested' ? 'no' : null), humanFollowUpRequested: !!c.humanFollowUp,
    doNotCallRequested: !!c.optOut || o === 'do_not_call', callbackRequested: !!c.callBack || o === 'callback',
  }, turns, { dropped: !!c.dropped });
  if (c.messageSaid) await svc.setRow(row.id, { botStateJson: JSON.stringify({ messageOnly: true, done: true }) });
  log(`omni call ${row.id} finished: ${o || c.status}`);
  return true;
}
async function syncOmniOpen() {
  const rows = await require('../schema').all("SELECT * FROM \"AiCall\" WHERE \"status\" = 'calling' AND \"callSid\" LIKE 'kavya-script:%' LIMIT 100");
  for (const r of rows) { try { await syncScriptCall(r); } catch (err) { console.error('[kavya-engine] omni sync:', err.message); } } // eslint-disable-line no-await-in-loop, no-console
}

let busy = false;
async function syncAll() {
  if (busy || !client.configured()) return 0;
  busy = true;
  let done = 0;
  try {
    const links = await DB.all('SELECT * FROM "KavyaLink" WHERE "appliedAt" IS NULL LIMIT 500');
    const byRun = new Map();
    links.forEach((l) => { if (!byRun.has(l.runId)) byRun.set(l.runId, []); byRun.get(l.runId).push(l); });
    for (const [runId, list] of byRun) { // eslint-disable-line no-restricted-syntax
      // eslint-disable-next-line no-await-in-loop
      const run = await DB.one('SELECT * FROM "KavyaRun" WHERE "id" = ?', runId);
      if (!run) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      await kavya.sync(run);
      for (const l of list) { // eslint-disable-line no-restricted-syntax
        // eslint-disable-next-line no-await-in-loop
        const calls = await DB.all('SELECT * FROM "KavyaCall" WHERE "runId" = ? AND "phone" = ? ORDER BY "kavyaCallId"', runId, l.phone);
        // eslint-disable-next-line no-await-in-loop
        try { await applyOne(l, calls); done += 1; } catch (err) { console.error('[kavya-engine] result not applied:', err.message); } // eslint-disable-line no-console
      }
    }
    await syncOmniOpen();
  } catch (err) {
    console.error('[kavya-engine] sync:', err.message); // eslint-disable-line no-console
  } finally { busy = false; }
  return done;
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => { syncAll().catch(() => {}); }, 45 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = { PURPOSES, getEngine, setEngine, wants, handOver, syncAll, start, resultFor, omniOn, setOmni, handOverOmni, syncScriptCall, syncOmniOpen };
