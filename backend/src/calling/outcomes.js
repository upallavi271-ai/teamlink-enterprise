// ---------------------------------------------------------------------------
// EXOTEL AI CALLING - WHAT HAPPENS AFTER A CALL.
//
//   applyResult(callId, result, turns)   the assistant's validated result -> call row + ATS timeline + follow-up task + notices
//   afterCompleted(row)                  Exotel says "completed": if no result yet, wait for it (a short while), then record "no result"
//   attemptFailed(row, why, final)       busy / no answer / failed: a line on the candidate's timeline, a task when we give up
//   finalizeStale()                      sweep: a completed call whose result never came
//
// RULES: a call NEVER changes a stage, an interview, a consent record or a candidate's data. A reschedule request is only a
// request: it is written down and the recruiter is told. Each side effect is written ONCE (flags in AiCall.written).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const core = require('../utils/messagingCore');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');
const DB = require('./schema');
const settingsStore = require('./settings');
const D = require('./dialogue');
const P = require('./policy');
const svc = require('./callService');

const AUDIT_ACTOR = 'AI assistant';
const istDay = (d, plus = 0) => new Date(d.getTime() + 330 * 60000 + plus * 86400000).toISOString().slice(0, 10);

async function flagged(row, key) {
  const w = svc.safeJson(row.written) || {};
  return !!w[key];
}
async function mark(id, key, value = true) {
  const row = await svc.getCall(id);
  const w = svc.safeJson(row.written) || {};
  w[key] = value;
  await svc.setRow(id, { written: JSON.stringify(w) });
}

function whoToTell(ctx, row, { bde = false } = {}) {
  const r = ctx.requirement || {};
  return [row.initiatedById, r.recruiterId, r.tlId, ...(bde ? [r.bdeId] : [])].filter(Boolean);
}

// One line on the candidate's timeline (Communications / History). The row says AI call, never a person's call.
async function writeTimeline(row, ctx, { body, status, detail }) {
  await prisma.candidateMessage.create({
    data: {
      candidateId: row.candidateId,
      applicationId: row.applicationId,
      channel: 'Call',
      template: 'AI_CALL',
      templateLabel: `AI call: ${row.purpose}`,
      trigger: 'AI call',
      recipient: row.toMask || '',
      body: String(body || '').slice(0, 1500),
      status,
      statusDetail: String(detail || '').slice(0, 480),
      senderUserId: row.initiatedById || null,
      senderName: `${AUDIT_ACTOR}${row.initiatedByName ? ` (for ${row.initiatedByName})` : ''}`,
      stageFrom: row.stageAtCall || null,
      stageTo: null,
    },
  });
}

async function createFollowUp(row, ctx, { action, due, notes }) {
  const r = ctx.requirement || {};
  const ownerId = row.initiatedById || r.recruiterId || r.tlId || null;
  let ownerName = row.initiatedByName || null;
  if (ownerId && !ownerName) {
    const u = await prisma.user.findUnique({ where: { id: ownerId }, select: { name: true } }).catch(() => null);
    ownerName = u ? u.name : null;
  }
  await prisma.applicationFollowUp.create({
    data: {
      applicationId: row.applicationId,
      candidateId: row.candidateId,
      requirementId: row.requirementId,
      ownerUserId: ownerId,
      ownerName,
      contactMode: 'Call',
      nextAction: String(action).slice(0, 200),
      dueDate: due,
      purpose: 'AI call follow-up',
      notes: String(notes || '').slice(0, 600) || null,
      autoCreated: true,
      createdByName: AUDIT_ACTOR,
    },
  });
}

// The Do-not-call wish of the person, honoured at once for every later AI call.
async function suppress(row, source) {
  const cand = await prisma.candidate.findUnique({ where: { id: row.candidateId }, select: { phone: true } });
  const m = core.normalizeMobile(cand && cand.phone);
  if (!m.ok) return;
  await DB.run('INSERT OR IGNORE INTO "AiCallSuppression" ("id","phone","kind","source","note","createdByName","createdAt") VALUES (?,?,?,?,?,?,?)',
    svc.newId('aisup'), P.phoneKey(m.e164), 'optout', source, 'Asked not to be called again', AUDIT_ACTOR, new Date().toISOString());
  const { OPTOUT_PREFIX } = require('../utils/messageDelivery'); // eslint-disable-line global-require
  const key = `${OPTOUT_PREFIX}Call.${m.e164}`;
  const v = JSON.stringify({ at: new Date().toISOString(), text: 'asked on an AI call' });
  await prisma.appSetting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } }).catch(() => null);
}

// --- the talk history, turn by turn -----------------------------------------------------------------------------------------------------------------
// Each candidate turn keeps the EXACT words heard (text), how clearly they were heard (heard: clear | unclear | none),
// and SEPARATELY how the assistant read them (understood) - the Talk history never shows the reading as the person's words.
// Only these fields, checked: nothing else from the call state reaches the row.
const UNDERSTOOD = ['yes', 'no', 'mixed', 'maybe', 'repeat', 'cant_hear', 'later', 'reschedule', 'stop', 'human', 'ai_q', 'salary_q', 'info_q', 'other_cand', 'silence', 'unclear', 'not_clear', 'language'];
function historyJson(turns) {
  return JSON.stringify(turns.slice(0, 80).map((x) => {
    const o = { who: x.who === 'assistant' ? 'assistant' : 'candidate', text: String(x.text || '').slice(0, 400) };
    if (o.who === 'candidate') {
      if (['clear', 'unclear', 'none'].includes(x.heard)) o.heard = x.heard;
      if (UNDERSTOOD.includes(x.understood)) o.understood = x.understood;
      if (S_LANGS.includes(x.lang)) o.lang = x.lang;
    }
    if (typeof x.at === 'string' && /^\d{4}-\d\d-\d\dT/.test(x.at)) o.at = x.at.slice(0, 24);
    return o;
  }));
}
// DURING a call on our own line, after every turn (2026-10-29): a dropped line or a server restart keeps what was already
// said. The full, final copy is written again by applyResult. Never throws: a failed write is retried once and logged.
async function saveTurns(callId, turns) {
  if (!Array.isArray(turns) || !turns.length) return false;
  for (let i = 0; i < 2; i += 1) {
    try {
      const row = await svc.getCall(callId); // eslint-disable-line no-await-in-loop
      if (!row || row.deletedAt || !['sip', 'web-link'].includes(row.initiatedVia)) return false;
      const patch = { transcript: historyJson(turns) };
      if (!row.purgeAt) { const s = await settingsStore.load(); patch.purgeAt = new Date(Date.now() + s.transcriptDays * 86400000).toISOString(); } // eslint-disable-line no-await-in-loop
      await svc.setRow(callId, patch); // eslint-disable-line no-await-in-loop
      return true;
    } catch (e) {
      if (i === 1) console.error('[ai-calling] talk history not saved this turn:', e.message); // eslint-disable-line no-console
    }
  }
  return false;
}

// --- the assistant's result -------------------------------------------------------------------------------------------------------------------------
async function applyResult(callId, resultIn, turns) {
  const row = await svc.getCall(callId);
  if (!row) return { ok: false, error: 'unknown call' };
  const check = D.validateOutcome(resultIn, row.purpose);
  let res = check.value;
  if (!check.ok) {
    const fb = row.purpose.startsWith('Interview') ? 'No Response' : 'Unclear';
    res = D.validateOutcome({ purpose: row.purpose, language: row.language, outcome: fb, summary: 'The result could not be read safely, so nothing was recorded from this call.' }, row.purpose).value;
  }
  if (row.outcome && !row.outcomePending && await flagged(row, 'result')) return { ok: true, duplicate: true };
  const s = await settingsStore.load();
  const ctx = await svc.loadContext(row.applicationId);
  const t = new Date();
  const wish = res.preferredTime || null;
  let nextAction = null; let due = null;
  if (res.doNotCallRequested) { nextAction = 'Do not call this person with the AI assistant again'; }
  else if (res.wrongPerson) { nextAction = 'Wrong person answered. Check the phone number'; due = istDay(t, 1); }
  else if (res.outcome === 'Reschedule Requested') { nextAction = `Candidate asked to change the interview time${wish ? `: ${wish}` : ''}. Decide and tell the candidate`; due = istDay(t); }
  else if (res.outcome === 'Not Available') { nextAction = 'Candidate cannot attend the interview. Call the candidate'; due = istDay(t); }
  else if (res.humanFollowUpRequested) { nextAction = 'Candidate asked to speak to a recruiter. Call the candidate'; due = istDay(t); }
  else if (res.callbackRequested) { nextAction = `Call the candidate back${res.callbackWhen ? ` (${res.callbackWhen})` : ''}`; due = istDay(t, 1); }
  else if (res.outcome === 'No Response') { nextAction = 'Interview not confirmed. Call the candidate'; due = istDay(t); }
  else if (res.outcome === 'Interested') { nextAction = row.purpose === 'Screening' ? 'Candidate is interested. Take the next step' : 'Candidate wants to go ahead. Share the next steps'; due = istDay(t, 1); }
  else if (res.outcome === 'Unclear') { nextAction = 'The AI call was unclear. Call the candidate yourself'; due = istDay(t, 1); }
  const patch = {
    outcome: res.outcome, outcomePending: 0, interest: res.interest, answersJson: JSON.stringify(res.answers || {}), summary: res.summary.slice(0, 600),
    rescheduleWish: wish, humanFollowUp: res.humanFollowUpRequested ? 1 : 0, nextAction, followUpDate: due,
    botStateJson: JSON.stringify({ turns: res.turns, done: true }),
  };
  // TALK HISTORY (founder 2026-10-29: "call ayyaka timeline lo talk history ... em matladaro mottham kanipinchali"): a call on
  // our own phone line or the free AI link always keeps what was said (the assistant says so at the start); Exotel calls
  // follow the Admin's "Keep what was said" switch as before.
  const ownLine = ['sip', 'web-link'].includes(row.initiatedVia);
  if ((s.keepTranscripts || ownLine) && Array.isArray(turns) && turns.length && !row.deletedAt) {
    patch.transcript = historyJson(turns);
    const keep = new Date(t.getTime() + s.transcriptDays * 86400000).toISOString();
    if (!row.purgeAt || keep < row.purgeAt) patch.purgeAt = keep;
  }
  await svc.setRow(callId, patch);
  if (res.language && S_LANGS.includes(res.language) && res.identityConfirmed && row.language !== res.language) {
    await DB.run('INSERT OR REPLACE INTO "AiCallPref" ("candidateId","language","source","updatedAt") VALUES (?,?,?,?)', row.candidateId, res.language, 'call', t.toISOString());
  }
  const fresh = await svc.getCall(callId);
  if (!(await flagged(fresh, 'timeline'))) {
    await writeTimeline(fresh, ctx, { body: res.summary, status: 'LOGGED', detail: `${fresh.purpose}: ${res.outcome}${fresh.durationSec != null ? ` · ${fresh.durationSec} s` : ''} (Exotel AI call)` });
    await mark(callId, 'timeline');
  }
  if (nextAction && !(await flagged(fresh, 'followup'))) {
    await createFollowUp(fresh, ctx, { action: nextAction, due: due || istDay(t, 1), notes: res.summary });
    await mark(callId, 'followup');
  }
  if (res.doNotCallRequested && !(await flagged(fresh, 'suppress'))) { await suppress(fresh, 'call'); await mark(callId, 'suppress'); }
  const reschedule = res.outcome === 'Reschedule Requested';
  if ((reschedule || res.outcome === 'Not Available' || res.humanFollowUpRequested || res.wrongPerson || res.outcome === 'No Response') && !(await flagged(fresh, 'notice'))) {
    const name = ctx && ctx.candidate ? ctx.candidate.name : 'Candidate';
    const job = ctx && ctx.requirement ? ctx.requirement.title : 'the requirement';
    const title = reschedule ? `AI call: ${name} asked to change the interview time`
      : res.outcome === 'Not Available' ? `AI call: ${name} cannot attend the interview`
        : res.wrongPerson ? `AI call: wrong person answered for ${name}`
          : res.humanFollowUpRequested ? `AI call: ${name} wants to speak to a recruiter` : `AI call: ${name} did not confirm the interview`;
    const message = `${job}. ${res.summary}${reschedule ? ' The interview has NOT been changed. Change it in Interviews if you agree.' : ''}`.slice(0, 480);
    if (ctx) await notifyUsers(whoToTell(ctx, fresh, { bde: reschedule || res.outcome === 'Not Available' }), { title, message });
    await mark(callId, 'notice');
  }
  await logAudit({ userId: null, actorName: AUDIT_ACTOR, action: `AI call result: ${res.outcome}`, entity: 'Application', entityId: fresh.applicationId, toValue: `${fresh.purpose} · ${fresh.initiatedByName || fresh.initiatedVia}`.slice(0, 200) });
  if (ctx && !(await flagged(fresh, 'written'))) {
    try { await require('./notifications').afterCall(fresh, ctx, res, s); } catch (err) { console.error('[ai-calling] written follow-up:', err.message); } // eslint-disable-line global-require, no-console
    await mark(callId, 'written');
  }
  await mark(callId, 'result');
  return { ok: true, outcome: res.outcome };
}
const S_LANGS = ['English', 'Telugu', 'Hindi'];

// Exotel said "completed". The assistant's result may already be here (then everything is written) or arrive in a moment.
async function afterCompleted(row) {
  if (row.outcome && !row.outcomePending) return { ok: true, had: true };
  await svc.setRow(row.id, { outcomePending: 1 });
  return { ok: true, waiting: true };
}

// A completed call whose result never arrived (the Voicebot did not reach us): say so, plainly.
async function finalizeStale({ minutes = 10 } = {}) {
  const cutoff = new Date(svc.now().getTime() - minutes * 60000).toISOString();
  const rows = await DB.all('SELECT * FROM "AiCall" WHERE "status" = \'completed\' AND "outcomePending" = 1 AND "endedAt" <= ? LIMIT 50', cutoff);
  for (const row of rows) { // eslint-disable-line no-restricted-syntax
    const fb = row.purpose.startsWith('Interview') ? 'No Response' : 'Unclear';
    // eslint-disable-next-line no-await-in-loop
    await applyResult(row.id, { purpose: row.purpose, language: row.language, outcome: fb, summary: `AI call (${row.purpose}). The call connected${row.durationSec != null ? ` for ${row.durationSec} seconds` : ''} but the assistant sent no result, so nothing is known about what was said.` }, null);
  }
  return rows.length;
}

// busy / no answer / failed
async function attemptFailed(row, why, final) {
  const ctx = await svc.loadContext(row.applicationId);
  if (!ctx) return;
  const key = `fail${row.attempts}`;
  if (!(await flagged(row, key))) {
    const retry = !final && row.nextAttemptAt ? ` Next try: ${row.nextAttemptAt}.` : '';
    await writeTimeline(row, ctx, { body: `AI call (${row.purpose}), attempt ${row.attempts} of ${row.maxAttempts}: ${why}${final ? ' No more attempts.' : retry}`, status: 'FAILED', detail: `${row.status}${final ? ' (final)' : ''} (Exotel AI call)` });
    await mark(row.id, key);
  }
  if (final && !(await flagged(row, 'giveup'))) {
    const t = new Date();
    await svc.setRow(row.id, { outcome: row.purpose.startsWith('Interview') ? 'No Response' : 'Unclear', summary: `${why} All ${row.maxAttempts} attempts are used.`, nextAction: 'AI call did not connect. Call the candidate yourself', followUpDate: istDay(t) });
    await createFollowUp(row, ctx, { action: 'AI call did not connect. Call the candidate yourself', due: istDay(t), notes: why });
    if (row.purpose.startsWith('Interview')) {
      await notifyUsers(whoToTell(ctx, row), { title: `AI call could not reach ${ctx.candidate.name}`, message: `${ctx.requirement.title}. ${why} The interview is unchanged. Please call the candidate.` });
    }
    await mark(row.id, 'giveup');
  }
}

async function notifyCancelled(row, reason) {
  if (!row.initiatedById || !/interview details changed|Not called/i.test(String(reason))) return;
  await notifyUsers([row.initiatedById], { title: 'An AI call was cancelled', message: String(reason).slice(0, 300) });
}

module.exports = { saveTurns, historyJson, applyResult, afterCompleted, finalizeStale, attemptFailed, notifyCancelled, suppress, writeTimeline, istDay };
