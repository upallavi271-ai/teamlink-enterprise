// ---------------------------------------------------------------------------
// FREE "AI LINK" (user, 2026-10-28: "first completely free, see the workflow, then decide").
//
// The SAME assistant as AI calling - dialogue.js (fixed sentences, the rules, the validated result) and outcomes.js (the
// ATS timeline, follow-up and notices) - over a web page instead of a phone call. No Exotel, no call minutes, ₹0.
//
//   createLink(user, input, base)   recruiter -> one AiCall row (status 'link', initiatedVia 'web-link') + a secret link,
//                                   and a ready WhatsApp message the recruiter sends from their own WhatsApp
//   open(token)                     what the page shows first: the first name, the language, finished or not
//   turn(token, body)               { event: 'start' | 'stop' } or { text } -> { say, done, language }
//
// The candidate's browser turns speech into text and text into speech (free); only TEXT reaches this server. The link
// is <callId>.<secret>; only a hash of the secret is stored. A link works for LINK_DAYS days and for one conversation;
// making a new link for the same candidate and purpose stops the old one. Status 'link' is never dialled by the Exotel
// sweep (reminders.js and hooks.js pick up 'queued' only).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const { logAudit } = require('../utils/audit');
const DB = require('./schema');
const settingsStore = require('./settings');
const svc = require('./callService');
const P = require('./policy');
const S = require('./scripts');
const D = require('./dialogue');

const LINK_DAYS = 7;
const VIA = 'web-link';
const hash = (secret) => crypto.createHash('sha256').update(String(secret)).digest('hex');
const iso = (d) => d.toISOString();
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

// The ready message (the recruiter's own WhatsApp sends it; TeamLink pays nothing).
const INVITE = {
  English: (n, job, link) => `Hello ${n}, this is TeamLink Consultants about your application${job ? ` for ${job}` : ''}. Please open this link and talk to our AI assistant for 2 minutes (English, Telugu or Hindi): ${link}\nTeamLink never asks for money.`,
  Telugu: (n, job, link) => `నమస్తే ${n} గారు, టీమ్‌లింక్ కన్సల్టెంట్స్ నుండి${job ? ` ${job}` : ''} దరఖాస్తు గురించి. ఈ లింక్ ఓపెన్ చేసి మా AI అసిస్టెంట్‌తో 2 నిమిషాలు మాట్లాడండి (తెలుగు, హిందీ లేదా ఇంగ్లీష్): ${link}\nటీమ్‌లింక్ ఎప్పుడూ డబ్బు అడగదు.`,
  Hindi: (n, job, link) => `नमस्ते ${n} जी, टीमलिंक कंसल्टेंट्स से${job ? ` ${job}` : ''} आवेदन के बारे में। कृपया यह लिंक खोलकर हमारे AI असिस्टेंट से 2 मिनट बात करें (हिंदी, तेलुगु या इंग्लिश): ${link}\nटीमलिंक कभी पैसे नहीं माँगता।`,
};

function webOf(row) {
  const j = svc.safeJson(row && row.scriptJson) || {};
  return { fields: j.fields || {}, web: j.web || null, json: j };
}

// token -> the row, or a refusal. Constant-time compare; an unknown id and a wrong secret look the same.
async function rowFor(token) {
  const m = /^(aic_[0-9a-f]{18})\.([A-Za-z0-9_-]{20,64})$/.exec(String(token || ''));
  const bad = { ok: false, status: 404, error: 'This link is not valid. Please ask your recruiter for a new one.' };
  if (!m) return bad;
  const row = await svc.getCall(m[1]);
  const w = row ? webOf(row).web : null;
  if (!row || row.initiatedVia !== VIA || !w || !w.tokenHash) return bad;
  const a = Buffer.from(hash(m[2])); const b = Buffer.from(String(w.tokenHash));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return bad;
  if (row.status === 'cancelled') return { ok: false, status: 410, error: 'This link was replaced or cancelled. Please ask your recruiter for a new one.' };
  if (row.status !== 'completed' && w.expiresAt && new Date(w.expiresAt).getTime() < Date.now()) {
    return { ok: false, status: 410, error: 'This link has expired. Please ask your recruiter for a new one.' };
  }
  return { ok: true, row };
}

// --- recruiter: make (or renew) the link ------------------------------------------------------------------------------------
async function createLink(user, input, base) {
  const s = await settingsStore.load({ fresh: true });
  const ctx = await svc.loadContext(input.applicationId);
  if (!ctx) return svc.fail(404, 'scope', 'Application not found.');
  const acc = await svc.accessVerdict(user, ctx, s);
  if (!acc.ok) return acc;
  const purpose = input.purpose;
  if (!S.PURPOSES.includes(purpose)) return svc.fail(400, 'purpose', 'Pick what the conversation is for.');
  // The person rules of AI calling (consent, opt-out, stage, interview) - but not the phone-call switches (Off / Test
  // numbers / calling hours): no call is placed, the candidate opens the link when it suits them.
  const t = new Date();
  const verdict = await P.personVerdict({
    candidate: ctx.candidate, app: ctx.app, requirement: ctx.requirement, purpose, s: { ...s, mode: 'Live' }, now: t, jobSetting: await svc.jobSetting(ctx.requirement.id),
  });
  // DND is about phone calls, and a link is not a call. "No consent on record" does not stop a link either: the page asks
  // for it ("By pressing Start you agree…") and the moment of agreement is kept on the conversation (web.agreedAt).
  // A person who asked NOT to be contacted (opted_out) is still refused.
  if (!verdict.ok && !['dnd', 'no_consent'].includes(verdict.code)) return svc.fail(403, verdict.code, verdict.reason);
  const lang = svc.languageFor({ ...s, languages: S.LANGS }, ctx.candidate, await svc.languagePref(ctx.candidate.id), input.language);
  const secret = crypto.randomBytes(24).toString('base64url');
  const expiresAt = iso(new Date(t.getTime() + LINK_DAYS * 86400000));
  const web = { tokenHash: hash(secret), expiresAt, createdBy: user.name || null };
  const stamp = iso(t);
  // one open link per application + purpose: a new link replaces the old one (the old secret stops working)
  const open = await DB.one(`SELECT * FROM "AiCall" WHERE "initiatedVia" = ? AND "applicationId" = ? AND "purpose" = ? AND "status" IN ('link','calling') ORDER BY "createdAt" DESC LIMIT 1`,
    VIA, ctx.app.id, purpose);
  let id;
  if (open && open.status === 'link') {
    id = open.id;
    await svc.setRow(id, { scriptJson: JSON.stringify({ ...webOf(open).json, web }), language: lang });
  } else {
    if (open) await svc.setRow(open.id, { status: 'cancelled', failReason: 'A new AI link was made', endedAt: stamp });
    id = svc.newId('aic');
    await DB.run(
      `INSERT INTO "AiCall" ("id","mode","purpose","status","applicationId","candidateId","requirementId","campaignId","dedupeKey","scheduleVersion","slot","language","scriptJson",
        "initiatedById","initiatedByName","initiatedVia","toMask","confirmedAt","confirmedById","attempts","maxAttempts","nextAttemptAt","stageAtCall","createdAt","updatedAt")
       VALUES (?,?,?,'link',?,?,?,NULL,?,NULL,NULL,?,?,?,?,?,?,?,?,0,1,NULL,?,?,?)`,
      id, 'live', purpose, ctx.app.id, ctx.candidate.id, ctx.requirement.id, `web:${id}`, lang, JSON.stringify({ fields: {}, web }),
      user.id, user.name || null, VIA, verdict.mask || null, stamp, user.id, ctx.app.stage, stamp, stamp,
    );
  }
  await logAudit({ userId: user.id, action: 'AI link made', entity: 'Application', entityId: ctx.app.id, toValue: `${purpose} (${lang}), free web link, valid ${LINK_DAYS} days` });
  const link = `${String(base || '').replace(/\/+$/, '')}/talk/${id}.${secret}`;
  const digits = String(ctx.candidate.phone || '').replace(/\D/g, '');
  const phone = digits.length === 10 ? `91${digits}` : digits.length === 12 && digits.startsWith('91') ? digits : null;
  return {
    ok: true,
    callId: id,
    link,
    expiresAt,
    language: lang,
    whatsapp: { phone, text: (INVITE[lang] || INVITE.English)(firstName(ctx.candidate.name), ctx.requirement.title, link) },
  };
}

// --- candidate page ----------------------------------------------------------------------------------------------------------
async function open(token) {
  const r = await rowFor(token);
  if (!r.ok) return r;
  const ctx = await svc.loadContext(r.row.applicationId);
  const st = svc.safeJson(r.row.botStateJson) || {};
  return {
    ok: true,
    firstName: firstName(ctx && ctx.candidate && ctx.candidate.name), // the job is told only after the person confirms who they are
    language: st.language || r.row.language || 'English',
    languages: S.LANGS,
    done: r.row.status === 'completed' || !!st.done,
  };
}

async function dialogueFor(row) {
  const s = await settingsStore.load();
  const ctx = await svc.loadContext(row.applicationId);
  if (!ctx) return null;
  const { fields } = webOf(row);
  const sc = await svc.scriptFor(ctx, row.purpose, row.language || 'English', fields, s);
  // the AI brain (brain.js, the existing Claude channel) when it is set up and has credits; otherwise the script alone
  const Brain = require('./brain'); // eslint-disable-line global-require
  const brain = (await Brain.available()) ? Brain.think : null;
  const knowledge = await require('./knowledge').forRequirement(row.requirementId).catch(() => []); // eslint-disable-line global-require
  const d = new D.Dialogue({ purpose: row.purpose, language: row.language || 'English', data: sc.data, fields: sc.fields, recordingNotice: s.recording || s.keepTranscripts, brain, knowledge }); // own line / link calls keep the talk history WITHOUT saying it (founder 2026-10-29: 'ilaa cheppakudadhu')
  const snap = svc.safeJson(row.botStateJson);
  if (snap && snap.step) d.restore(snap);
  else {
    // a NEW call about an application that was already called: remember the answers given then (memory, 2026-10-30)
    const prev = await DB.one('SELECT "answersJson", "endedAt" FROM "AiCall" WHERE "applicationId" = ? AND "id" <> ? AND "status" = ? AND "outcome" IS NOT NULL ORDER BY "createdAt" DESC LIMIT 1', row.applicationId, row.id, 'completed').catch(() => null);
    if (prev) d.remember({ answers: svc.safeJson(prev.answersJson) || {}, at: prev.endedAt });
  }
  return d;
}

const talkTime = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)} min ${sec % 60} s` : `${sec} s`);

async function finish(row, d, why) {
  const result = why ? d.hangup(why) : d.outcome();
  const t = new Date();
  const durationSec = row.startedAt ? Math.max(0, Math.round((t - new Date(row.startedAt)) / 1000)) : null;
  // how long they talked: on the call row, and in the summary the ATS timeline shows (user, 2026-10-28)
  if (durationSec != null) result.summary = `${result.summary} Talked for ${talkTime(durationSec)} (free AI link).`.slice(0, 600);
  await svc.setRow(row.id, { botStateJson: JSON.stringify({ ...d.snapshot(), done: true }), status: 'completed', language: d.language, endedAt: iso(t), durationSec, providerStatus: 'web' });
  await require('./outcomes').applyResult(row.id, result, d.transcript()); // eslint-disable-line global-require
  return result;
}

// body: { event: 'start', language? } | { event: 'language', language } | { event: 'stop' } | { text }
async function turn(token, body) {
  const r = await rowFor(token);
  if (!r.ok) return r;
  const { row } = r;
  if (row.status === 'completed') return { ok: true, say: '', done: true };
  const d = await dialogueFor(row);
  if (!d) return { ok: false, status: 404, error: 'This application is no longer open.' };
  const b = body && typeof body === 'object' ? body : {};
  const st = d.snapshot();
  if (b.event === 'stop') {
    if (!st.transcript.length) return { ok: true, say: '', done: false }; // never started: nothing to record
    const res = await finish(row, d, 'candidate left the page');
    return { ok: true, say: '', done: true, outcome: res.outcome };
  }
  let out;
  const pick = S.LANGS.includes(b.language) ? b.language : null;
  if (b.event === 'language') {
    // the person pressed a language button: everything from now on in that language (asked again, nothing else changes)
    if (!st.transcript.length || !pick) return { ok: false, status: 409, error: 'Please press Start first.' };
    d.setLanguage(pick);
    out = { say: d.again(d.P.langSwitched), done: false };
  } else if (b.event === 'start') {
    if (st.transcript.length) out = { say: st.lastAsk, done: false }; // the page was reloaded: repeat the last question
    else {
      if (pick) d.setLanguage(pick); // the language the person chose on the first screen
      out = d.start();
      const at = iso(new Date());
      const w = webOf(row);
      // pressing Start on the page = the person agreed to talk to the AI assistant about this application (kept with the conversation)
      await svc.setRow(row.id, { status: 'calling', startedAt: at, scriptJson: JSON.stringify({ ...w.json, web: { ...w.web, agreedAt: at } }) });
      row.startedAt = at;
    }
  } else {
    const text = String(b.text == null ? '' : b.text).slice(0, 600);
    if (!st.transcript.length) return { ok: false, status: 409, error: 'Please press Start first.' };
    out = await d.hear(text);
  }
  if (out.done) {
    const res = await finish(row, d);
    return { ok: true, say: out.say, done: true, language: d.language, outcome: res.outcome };
  }
  await svc.setRow(row.id, { botStateJson: JSON.stringify({ ...d.snapshot(), done: false }) });
  return { ok: true, say: out.say, done: false, language: d.language };
}

module.exports = { createLink, open, turn, dialogueFor, LINK_DAYS, VIA };
