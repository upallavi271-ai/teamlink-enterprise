// ---------------------------------------------------------------------------
// AI CALLS FOR OMNI-CHANNEL (GREEN START) CONTACTS (founder 2026-11-04: Voice Calling "Start calling" must use the AI phone line TeamLink already has).
//
// Green Start's campaign engine decides WHO to call and WHEN (calling hours, retries, pacing, the contact's consent). For each due contact it asks
// TeamLink - server to server, signed with the shared one-click-sign-in secret - to make ONE call by the script of the campaign's AI agent:
//
//   POST /api/public/omni-voice/calls        { externalId, toNumber, name, script, scriptLanguage?, scripts?, agentName? }  -> { id } (the call is ringing)
//   GET  /api/public/omni-voice/calls/:id    -> { status, outcome, summary, durationSec, turns[], ended }                    (Green Start waits for ended)
//
// The call is made by the same AI phone line, gateway and script engine as the ATS AI Voice campaigns (voice/sipCall.js dialOmni, scriptDialogue.js),
// but it is not about a candidate: no application, no job, no ATS timeline. The row lives in AiCall with candidateId "omni:<externalId>" and is kept out
// of the ATS lists. Its result is only written on the row; Green Start records it in its own Voice Calling log (so utils/omniVoiceSync.js skips these rows).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const DB = require('./schema');
const svc = require('./callService');
const S = require('./scripts');
const prisma = require('../db');
const { parseScript, ScriptDialogue } = require('./scriptDialogue');
const vacancy = require('./vacancyScript');

const AUD = 'teamlink-voice';
// The ATS agent rules (300 characters, 14 lines, one question, a closing, forbidden words) do not apply to a script from Omni-Channel
const LIMITS = { maxLine: 5000, maxLines: 300, noQuestionOk: true, lenient: true }; // the team's own script, as written (founder 2026-11-04: accept any script, no layout rules)
const seen = new Map(); // jti -> expiry (a signed request is accepted once)

const secret = () => String(process.env.GREENSTART_SSO_SECRET || '');
const configured = () => secret().length >= 32;

// "Authorization: Bearer <HS256 token>" made by Green Start with the shared secret (iss greenstart, aud teamlink-voice, 60 seconds)
function verify(header) {
  if (!configured()) return { ok: false, status: 503, error: 'The shared secret with Omni-Channel is not set up on this server.' };
  const m = /^Bearer\s+([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(String(header || ''));
  if (!m) return { ok: false, status: 401, error: 'Not signed.' };
  const want = crypto.createHmac('sha256', secret()).update(`${m[1]}.${m[2]}`).digest();
  const got = Buffer.from(m[3], 'base64url');
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return { ok: false, status: 401, error: 'Not signed.' };
  let p; try { p = JSON.parse(Buffer.from(m[2], 'base64url').toString('utf8')); } catch { return { ok: false, status: 401, error: 'Not signed.' }; }
  const now = Math.floor(Date.now() / 1000);
  if (!p || p.aud !== AUD || p.iss !== 'greenstart' || !(p.exp > now) || p.exp - now > 300) return { ok: false, status: 401, error: 'The sign-in has expired.' };
  for (const [k, t] of seen) if (t < now) seen.delete(k); // eslint-disable-line no-restricted-syntax
  if (!p.jti || seen.has(p.jti)) return { ok: false, status: 401, error: 'This request was already used.' };
  seen.set(p.jti, p.exp);
  return { ok: true };
}

// ---- THE PERSON'S LANGUAGE (founder 2026-11-04: "english / hindi / telugu - e language matladite aa language ki switch avvali"):
// the call switches to the language the person speaks when the script has that language. A script from Omni-Channel is written in ONE language, so the other two
// are made by the local model (Ollama, free, nothing leaves this server) the first time the script is seen, kept (AppSetting), and used on every call after that.
// They are machine translations (the labels and the {name} slot are kept, a draft that loses a line is refused); a person who writes a better version in the
// Telugu / Hindi box of an ATS agent is not affected. The first call that arrives before the translation is ready simply stays in the script's language.
const hashOf = (t) => crypto.createHash('sha1').update(String(t)).digest('hex').slice(0, 16);
const trKey = (text, lang) => `omni.voice.tr.${hashOf(text)}.${lang}`;
const detectLang = (t) => (/[\u0C00-\u0C7F]/.test(t) ? 'Telugu' : (/[\u0900-\u097F]/.test(t) ? 'Hindi' : 'English'));
const inflight = new Map(); // key -> promise (one translation at a time per script and language)
const failedAt = new Map(); // key -> time (a failed translation is not retried for 10 minutes)

async function cachedVersion(text, lang) {
  try { const r = await prisma.appSetting.findUnique({ where: { key: trKey(text, lang) } }); return r ? String(JSON.parse(r.value).text || '') || null : null; } catch { return null; }
}

let chain = Promise.resolve(); // the translations wait for each other
function warm(text, to, tdeps = {}) {
  const key = trKey(text, to);
  if (inflight.has(key) || (failedAt.get(key) || 0) > Date.now() - 600000) return inflight.get(key) || null;
  const p = (chain = chain.then(async () => {
    const ST = require('./scriptTranslate'); // eslint-disable-line global-require
    const base = ST.ollama();
    const r = await ST.translateScript(text, to, { limits: LIMITS, ...(base ? { config: { ...base, timeoutMs: 600000 } } : {}), ...tdeps });
    if (r.ok) {
      const value = JSON.stringify({ text: r.text, at: new Date().toISOString(), by: 'machine translation (Ollama)' });
      await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
    } else { failedAt.set(key, Date.now()); console.error(`[omni-voice] ${to} version of a script could not be made: ${r.error}`); } // eslint-disable-line no-console
  }).catch((e) => { failedAt.set(key, Date.now()); console.error(`[omni-voice] translation failed: ${e && e.message}`); })).finally(() => { inflight.delete(key); }); // eslint-disable-line no-console
  inflight.set(key, p);
  return p;
}

// the versions the call can switch to: the ones given, else the ones already made; the missing ones are started in the background
async function versionsFor(text, lang, given, tdeps) {
  const out = { ...(given || {}) };
  for (const to of ['Telugu', 'Hindi', 'English']) { // eslint-disable-line no-restricted-syntax
    if (to === lang || out[to]) continue; // eslint-disable-line no-continue
    const c = await cachedVersion(text, to); // eslint-disable-line no-await-in-loop
    if (c) out[to] = c; else warm(text, to, tdeps);
  }
  return out;
}

/** Ask for the other-language versions of a script to be made now (Green Start does it when an agent is saved and when a campaign starts). */
async function prepare(textIn, tdeps) {
  let text = textIn;
  if (vacancy.factsFrom(text)) return { ok: true, language: vacancy.startLanguage(vacancy.factsFrom(text)), ready: ['English', 'Telugu', 'Hindi'], pending: [] }; // built from the facts: nothing to translate
  text = normalizeScript(text);
  const err = checkScript(text, {});
  if (err) return { ok: false, error: err };
  const lang = detectLang(text);
  const out = await versionsFor(text, lang, {}, tdeps);
  const ready = Object.keys(out);
  return { ok: true, language: lang, ready, pending: ['Telugu', 'Hindi', 'English'].filter((l) => l !== lang && !out[l]) };
}

// ---- A SCRIPT PASTED AS ONE BLOCK (founder 2026-11-04: the whole sample script - "Opening", "If yes: Vacancy details", "Interest check", "If interested", "If not interested /
// busy", "Closing", each with its words in quotes - was pasted into one step and the AI said all of it in one breath). Such a block is laid out as the lines of a call:
// the quoted words are the lines, the label before each says what it is. A line with fewer than two quoted pieces is left exactly as written.
const cleanSeg = (t) => String(t).replace(/\[\s*(candidate'?s?\s*name|candidate|name)\s*\]/gi, '{name}').replace(/\s+/g, ' ').trim();
function kindOfLabel(label, text, state) {
  const L = String(label || '').toLowerCase();
  if (/closing|goodbye|farewell|end of (the )?call/.test(L)) return 'Closing';
  if (/convinc|persuad|objection|rebuttal|why not/.test(L)) return 'Convince';
  if (/not interested|declin|refus|busy|not available|\bno\b/.test(L)) return 'Decline';
  if (/opening|greeting|intro/.test(L) || (!L && !state.seen)) return state.hasOpening ? (/[?？]/.test(text) ? 'Ask' : 'Say') : 'Opening';
  if (/^(if\s+)?(interested|yes)\b/.test(L) && !/check|question/.test(L)) return /[?？]/.test(text) ? 'Ask' : 'Say';
  if (/interest/.test(L) && /check|question|ask/.test(L)) return 'Interest';
  return /[?？]/.test(text) ? 'Ask' : 'Say';
}
function normalizeScript(raw) {
  const lines = String(raw == null ? '' : raw).replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const out = [];
  lines.forEach((l) => {
    const m = /^(opening|say|ask|interest|closing|decline|convince|language|ifyes|ifno)\s*[:\-–]\s*(.*)$/i.exec(l);
    const body = m ? m[2] : l;
    const segs = [...body.matchAll(/[“"]([^”"]{2,})[”"]/g)];
    if (segs.length < 2) { out.push(l); return; }
    const state = { hasOpening: out.some((x) => /^opening\s*[:\-–]/i.test(x)), seen: false };
    let prevEnd = 0;
    segs.forEach((s) => {
      const label = body.slice(prevEnd, s.index).replace(/[:\-–\s]+$/, '').trim();
      prevEnd = s.index + s[0].length;
      const text = cleanSeg(s[1]);
      const kind = kindOfLabel(label, text, state);
      if (kind === 'Opening') state.hasOpening = true;
      state.seen = true;
      out.push(`${kind}: ${text}`);
    });
  });
  // one closing, at the end: the first one the script gives (the pasted block's own), not a generic one added after it
  const closings = out.filter((x) => /^closing\s*[:\-–]/i.test(x));
  if (closings.length > 1) return [...out.filter((x) => !/^closing\s*[:\-–]/i.test(x)), closings[0]].join('\n');
  return out.join('\n');
}

/** a phone number the AI may say: digits, spaces, + and - only, 8 to 15 digits; '' otherwise */
function cleanNumber(v) {
  const t = String(v == null ? '' : v).replace(/[^\d+\s-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
  const n = t.replace(/\D/g, '').length;
  return n >= 8 && n <= 15 ? t : '';
}

const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';

// the script of the agent: checked here the same way as an ATS AI Voice agent's (the lines it may not say, one Opening, a Closing, one question)
function checkScript(text, others) {
  const main = parseScript(text, LIMITS);
  if (!main.ok) return main.error;
  const bad = Object.entries(others || {}).find(([, t]) => t && !parseScript(t, LIMITS).ok);
  return bad ? `The ${bad[0]} version of the script cannot be used: ${parseScript(bad[1], LIMITS).error}` : null;
}

// the call's talk, in the shape Green Start shows
function turnsOf(row) {
  const t = svc.safeJson(row.transcript);
  return (Array.isArray(t) ? t : []).map((x) => ({ who: x.who === 'assistant' ? 'assistant' : 'candidate', text: String(x.text || '').slice(0, 600) })).filter((x) => x.text);
}

/** Make the call. Returns { ok:true, id } or { ok:false, code, reason } (nothing was dialled). */
async function create(input, deps = {}) {
  const externalId = String(input.externalId || '').slice(0, 120);
  if (!externalId) return { ok: false, status: 400, code: 'externalId', reason: 'externalId is needed.' };
  // the FACTS of a vacancy (Role / Location / Salary ...): the call is built from them in all three languages, nothing is translated by a model
  // a script that names a job in plain sentences is turned into a human conversation about that job; a script with its own Convince / Decline lines (written objection handling) is kept as written
  const own = /^(convince|decline)\s*[:\-–]/im.test(normalizeScript(input.script));
  const facts = own ? vacancy.parseFacts(input.script) : vacancy.factsFrom(input.script);
  // the recruiter's number (asked for when the campaign is made): said to a candidate who asks where to send the resume
  const contactNumber = cleanNumber(input.contactNumber);
  if (facts && contactNumber && !facts.channel) facts.channel = contactNumber;
  let text; let scriptLang; let scripts;
  if (facts) {
    const built = vacancy.build(facts);
    scriptLang = vacancy.startLanguage(facts);
    text = built[scriptLang];
    scripts = { ...built }; delete scripts[scriptLang];
  } else {
    text = normalizeScript(input.script);
    scriptLang = detectLang(text);
  }
  const err = checkScript(text, scripts || input.scripts);
  if (err) return { ok: false, status: 422, code: 'script', reason: err };
  if (!facts) scripts = await versionsFor(text, scriptLang, input.scripts, deps.translate);
  const dup = await DB.one('SELECT "id" FROM "AiCall" WHERE "dedupeKey" = ? AND "status" <> \'cancelled\'', `omni:${externalId}`);
  if (dup) return { ok: true, id: dup.id, again: true };
  const scriptJson = {
    omni: { name: String(input.name || '').slice(0, 80), externalId },
    fields: {},
    agentScript: { text, language: scriptLang, texts: scripts, facts: facts || null, contactNumber: contactNumber || null, name: String(input.agentName || 'AI agent').slice(0, 60) },
  };
  const r = await require('./voice/sipCall').dialOmni({ externalId, toNumber: input.toNumber, language: scriptLang, scriptJson }, deps); // eslint-disable-line global-require
  return r.ok ? { ok: true, id: r.id } : { ok: false, status: r.code === 'not_ready' || r.code === 'not_dialled' ? 503 : 409, code: r.code, reason: r.reason };
}

/** The call as Green Start needs it. */
async function status(id) {
  let row = await DB.one('SELECT * FROM "AiCall" WHERE "id" = ? AND "candidateId" LIKE \'omni:%\'', String(id));
  if (!row) return null;
  if (String(row.callSid || '').startsWith('kavya-script:') && row.status === 'calling') { // KAVYA script call (2026-11-12): copy her result first
    try { await require('./kavya/engine').syncScriptCall(row); row = (await DB.one('SELECT * FROM "AiCall" WHERE "id" = ?', String(id))) || row; } catch { /* the next read tries again */ } // eslint-disable-line global-require
  }
  const ended =['completed', 'failed', 'busy', 'no-answer', 'cancelled'].includes(row.status);
  return {
    id: row.id, status: row.status, ended, outcome: row.outcome || null, summary: row.summary || null, interest: row.interest || null, language: row.language || null,
    durationSec: Number(row.durationSec) || null, failReason: row.failReason || null, humanFollowUp: !!row.humanFollowUp, turns: ended ? turnsOf(row) : [],
    optOut: row.nextAction === 'do-not-call', callBack: row.nextAction === 'call-back', dropped: row.nextAction === 'dropped', messageSaid: !!((svc.safeJson(row.botStateJson) || {}).messageOnly),
  };
}

/** The dialogue of a call to an Omni contact (webTalk.dialogueFor). */
function dialogueFor(row, s) {
  const j = svc.safeJson(row.scriptJson) || {};
  const a = j.agentScript || {};
  const name = (j.omni && j.omni.name) || '';
  const d = new ScriptDialogue({
    purpose: row.purpose, language: row.language || 'English', data: { name, firstName: firstName(name), jobTitle: '', company: '' }, fields: {},
    recordingNotice: !!(s && (s.recording || s.keepTranscripts)), script: a.text, scriptLanguage: a.language, scripts: a.texts, scriptName: a.name, seed: row.id, limits: LIMITS, facts: a.facts || null, contactNumber: a.contactNumber || null,
  });
  const snap = svc.safeJson(row.botStateJson);
  if (snap && snap.step) d.restore(snap);
  return d;
}

/** The end of the call: the result is only written on the row (no ATS candidate to tell). */
// opts.dropped: the line was cut (the person hung up or the line fell) before the conversation reached its own end: Omni-Channel rings again
async function applyResult(rowId, result, turns, opts = {}) {
  const history = (turns || []).slice(0, 80).map((x) => ({ who: x.who === 'assistant' ? 'assistant' : 'candidate', text: String(x.text || '').slice(0, 400) }));
  await svc.setRow(rowId, {
    outcome: result.outcome || 'Unclear', summary: String(result.summary || '').slice(0, 600), interest: result.interest || null,
    answersJson: JSON.stringify(result.answers || {}), transcript: JSON.stringify(history), humanFollowUp: result.humanFollowUpRequested ? 1 : 0, outcomePending: 0,
    nextAction: result.doNotCallRequested ? 'do-not-call' : (result.callbackRequested ? 'call-back' : (opts.dropped ? 'dropped' : null)),
  });
}

module.exports = { normalizeScript, configured, verify, create, status, dialogueFor, applyResult, checkScript, prepare, detectLang, versionsFor, cachedVersion, trKey };
