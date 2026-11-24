// ---------------------------------------------------------------------------
// AI INTERVIEW NOTETAKER (ATS wave 2 Y, benchmark 07.11): joins or records the call, writes the notes, maps them to the scorecard.
//
//   1. UPLOAD NOW   a recording uploaded on the interview (Interview tools > Recordings & notes) is turned into text at once through the Groq
//                   Whisper path of the call recordings (utils/atsY/speech.js) and the notes are written (utils/mkt/interviews.js makeNotes).
//   2. MEETING BOT  "Send the notetaker" gives the interview's Meet / Zoom / Teams link to a meeting-bot provider (a Recall.ai style API:
//                   POST /api/v1/bot/, GET /api/v1/bot/<id>/, GET /api/v1/bot/<id>/transcript/, POST /api/v1/bot/<id>/leave_call/). When the
//                   call ends the transcript comes back, becomes a recording of the round and gets its notes. Needs the provider key
//                   (Administration > Integrations > AI interview notetaker) AND the Admin switch "notetakerBot" (OFF by default).
//   3. SCORECARD    mapToKit(): every kit question of the round gets the transcript lines that answer it (AI, masked; the code picks the
//                   lines by the question's own words when the model is down) and, from the AI only, a suggested rating. The interviewer
//                   copies them onto their own scorecard (nothing is rated for them).
// ---------------------------------------------------------------------------
const C = require('./core');

const { q, x, nowIso, newId, txt, json } = C;
const LABEL = 'AI notetaker';
const STOP = new Set('the a an and or of to in on for with your you how what why when which did does do is are was were be been have has had this that these those about tell me us our we they their there from into at by as it its any can could would should will give explain describe walk through example'.split(' '));
const wordsOf = (s) => C.lower(s).replace(/[^a-z0-9+#. ]/g, ' ').split(/\s+/).map((w) => w.replace(/\.+$/, '')).filter((w) => w.length > 2 && !STOP.has(w));

// ---------------------------------------------------------------- 3. transcript -> the kit's questions
function codeMap(transcript, kit) {
  const sentences = String(transcript || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 12);
  return (kit.questions || []).map((qq, i) => {
    const keys = [...new Set([...wordsOf(qq.text), ...wordsOf(qq.competency || '')])];
    const scored = sentences.map((s) => { const w = new Set(wordsOf(s)); return { s, n: keys.filter((k) => w.has(k)).length }; }).filter((v) => v.n > 0).sort((a, b) => b.n - a.n);
    const evidence = scored.slice(0, 2).map((v) => v.s).join(' ').slice(0, 400);
    return { i, q: qq.text, type: qq.type, evidence: evidence || null, covered: !!evidence, suggestedRating: null };
  });
}
async function mapToKit(transcript, kit, names = []) {
  const base = codeMap(transcript, kit);
  if (!kit || !(kit.questions || []).length) return { rows: [], source: null };
  const masked = C.maskText(require('../mkt/core').maskPii(String(transcript || ''), names)).slice(0, 11000); // eslint-disable-line global-require
  const list = kit.questions.map((qq, i) => `${i}. ${qq.text} (${qq.type === 'rating' ? `rating 1-${kit.scale}` : qq.type})`).join('\n');
  const ai = await require('../mkt/core').aiJson( // eslint-disable-line global-require
    `You map an interview transcript to the interview kit's questions. For each question number give JSON only: {"rows":[{"i":0,"evidence":"the candidate's own words that answer it, or empty","rating":null or a whole number 1-${kit.scale} only when the evidence clearly supports it}]}. Facts from the transcript only. Never judge age, gender, religion, caste, accent or health.`,
    `Questions:\n${list}\n\nTranscript:\n${masked}`, { maxTokens: 900 },
  );
  if (ai && ai.value && Array.isArray(ai.value.rows)) {
    const rows = base.map((b) => {
      const a = ai.value.rows.find((r) => Number(r && r.i) === b.i) || {};
      const ev = txt(a.evidence, 400);
      const rt = Number(a.rating);
      return { ...b, evidence: ev || b.evidence, covered: !!(ev || b.evidence), suggestedRating: b.type === 'rating' && Number.isInteger(rt) && rt >= 1 && rt <= kit.scale ? rt : null };
    });
    return { rows, source: `AI (${ai.provider})` };
  }
  return { rows: base, source: 'TeamLink (lines that use the question\'s words, no AI)' };
}

// ---------------------------------------------------------------- 2. the meeting bot
async function config() { return C.provider('ats-meeting-bot', ['API base URL', 'API key'], LABEL); }
const authOf = (cfg) => ({ authorization: `Token ${String(cfg.values['API key']).trim()}` });
const shapeBot = (r) => ({ id: r.id, applicationId: r.applicationId, round: Number(r.round), meetingUrl: r.meetingUrl, status: r.status, statusText: r.statusText, joinAt: r.joinAt, recordingId: r.recordingId, createdBy: r.createdBy, createdAt: r.createdAt, updatedAt: r.updatedAt });
async function botsOf(applicationId) { await C.ensure(); return (await q('SELECT * FROM "AtsYBot" WHERE "applicationId" = ? ORDER BY "createdAt" DESC LIMIT 20', applicationId)).map(shapeBot); }
async function botRow(id) { await C.ensure(); return (await q('SELECT * FROM "AtsYBot" WHERE "id" = ?', String(id || '')))[0] || null; }
async function state(applicationId) {
  const cfg = await config();
  return { switchOn: await C.switchOn('notetakerBot'), ready: !!cfg.ready, hint: cfg.ready ? null : cfg.hint, provider: cfg.values ? (cfg.values['Provider name'] || null) : null, bots: await botsOf(applicationId) };
}
function meetingOk(u) {
  let url; try { url = new URL(String(u || '').trim()); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  return url.toString().slice(0, 600);
}
async function sendBot(app, round, meetingUrl, user) {
  if (!(await C.switchOn('notetakerBot'))) return C.SWITCH_OFF('notetakerBot');
  const cfg = await config();
  if (!cfg.ready) return C.NEEDS(LABEL, cfg.hint);
  const link = meetingOk(meetingUrl || app.interviewMeetingLink);
  if (!link) return { status: 400, error: 'Give the meeting link (https://meet.google.com/..., https://zoom.us/j/..., or the Teams link).' };
  await C.ensure();
  const open = (await q('SELECT "id" FROM "AtsYBot" WHERE "applicationId" = ? AND "round" = ? AND "status" IN (\'joining\',\'in call\',\'scheduled\')', app.id, round))[0];
  if (open) return { status: 409, error: 'A notetaker is already on its way to this round. Stop it first to send a new one.' };
  const at = app.interviewAt ? new Date(app.interviewAt) : null;
  const joinAt = at && at.getTime() > Date.now() + 10 * 60000 ? new Date(at.getTime() - 60000).toISOString() : null;
  const body = { meeting_url: link, bot_name: txt(cfg.values['Bot name'], 60) || 'TeamLink Notetaker', ...(joinAt ? { join_at: joinAt } : {}), recording_config: { transcript: { provider: { meeting_captions: {} } } }, metadata: { teamlink_interview: app.id, round: String(round) } };
  const r = await C.out(LABEL, C.joinUrl(cfg.values['API base URL'], '/api/v1/bot/'), { method: 'POST', headers: authOf(cfg), json: body, secrets: [cfg.values['API key']] });
  if (!r.ok) return { status: 502, error: r.error };
  const botId = r.body && (r.body.id || r.body.bot_id);
  if (!botId) return { status: 502, error: `${LABEL}: the provider did not give a bot id.` };
  const id = newId(); const t = nowIso();
  await x('INSERT INTO "AtsYBot" ("id","applicationId","round","meetingUrl","providerBotId","status","statusText","joinAt","createdBy","createdById","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    id, app.id, round, link, String(botId), joinAt ? 'scheduled' : 'joining', joinAt ? `Joins at ${joinAt}` : 'On its way to the meeting', joinAt, C.who(user), user.id, t, t);
  return { ok: true, bot: shapeBot(await botRow(id)) };
}
function transcriptText(body) {
  const segs = Array.isArray(body) ? body : (body && (body.transcript || body.segments || body.results)) || [];
  if (typeof segs === 'string') return segs;
  return (Array.isArray(segs) ? segs : []).map((s) => {
    const who = txt((s && (s.speaker || (s.participant && s.participant.name))) || '', 60);
    const words = Array.isArray(s && s.words) ? s.words.map((w) => (w && (w.text || w.word)) || '').join(' ') : txt(s && s.text, 4000);
    return words.trim() ? `${who ? `${who}: ` : ''}${words.replace(/\s+/g, ' ').trim()}` : '';
  }).filter(Boolean).join('\n');
}
const lastCode = (b) => { const ch = (b && (b.status_changes || b.statusChanges)) || []; const last = Array.isArray(ch) && ch.length ? ch[ch.length - 1] : null; return String((last && last.code) || (b && b.status && (b.status.code || b.status)) || ''); };
async function refresh(row, user) {
  if (['done', 'failed', 'stopped'].includes(row.status)) return { ok: true, bot: shapeBot(row) };
  const cfg = await config();
  if (!cfg.ready) return C.NEEDS(LABEL, cfg.hint);
  const base = cfg.values['API base URL'];
  const r = await C.out(LABEL, C.joinUrl(base, `/api/v1/bot/${encodeURIComponent(row.providerBotId)}/`), { headers: authOf(cfg), secrets: [cfg.values['API key']] });
  if (!r.ok) return { status: 502, error: r.error };
  const code = lastCode(r.body);
  const set = async (status, statusText, extra = {}) => {
    const keys = Object.keys(extra);
    await x(`UPDATE "AtsYBot" SET "status" = ?, "statusText" = ?, "updatedAt" = ?${keys.map((k) => `, "${k}" = ?`).join('')} WHERE "id" = ?`, status, txt(statusText, 300), nowIso(), ...keys.map((k) => extra[k]), row.id);
  };
  if (/fatal|error/i.test(code)) { await set('failed', `The provider says: ${code}`); return { ok: true, bot: shapeBot(await botRow(row.id)) }; }
  if (!/done|call_ended|analysis_done|recording_done/i.test(code)) {
    await set(/in_call|recording/i.test(code) ? 'in call' : row.status, code ? `Provider status: ${code}` : row.statusText);
    return { ok: true, bot: shapeBot(await botRow(row.id)) };
  }
  const tr = await C.out(LABEL, C.joinUrl(base, `/api/v1/bot/${encodeURIComponent(row.providerBotId)}/transcript/`), { headers: authOf(cfg), secrets: [cfg.values['API key']] });
  const text = tr.ok ? transcriptText(tr.body) : '';
  if (!text) { await set('done', tr.ok ? 'The call ended but the provider gave no words.' : `The call ended; the transcript could not be read: ${tr.error}`); return { ok: true, bot: shapeBot(await botRow(row.id)) }; }
  const IV = require('../mkt/interviews'); // eslint-disable-line global-require
  const prisma = require('../../db'); // eslint-disable-line global-require
  const video = r.body && (r.body.video_url || (r.body.recording && r.body.recording.url));
  const owner = user || { id: row.createdById, name: row.createdBy };
  const recId = await IV.addRecording(row.applicationId, { kind: 'bot', round: Number(row.round), title: `Notetaker - round ${row.round}`, url: video && /^https:\/\//.test(video) ? String(video).slice(0, 600) : null, transcript: text, transcriptSource: `Meeting notetaker (${txt(cfg.values['Provider name'], 40) || 'provider'})` }, owner);
  const rec = await IV.recordingRow(recId);
  const app = await prisma.application.findUnique({ where: { id: row.applicationId }, include: { candidate: { select: { name: true } } } });
  await IV.makeNotes(rec, [app && app.candidate && app.candidate.name]).catch(() => null);
  await set('done', 'The transcript and the notes are on the recordings of this round.', { recordingId: recId });
  await C.logAudit({ userId: owner.id, action: `Interview notetaker: transcript + notes (round ${row.round})`, entity: 'Application', entityId: row.applicationId });
  return { ok: true, bot: shapeBot(await botRow(row.id)) };
}
async function stop(row) {
  if (['done', 'failed', 'stopped'].includes(row.status)) return { ok: true, bot: shapeBot(row) };
  const cfg = await config();
  if (cfg.ready) await C.out(LABEL, C.joinUrl(cfg.values['API base URL'], `/api/v1/bot/${encodeURIComponent(row.providerBotId)}/leave_call/`), { method: 'POST', headers: authOf(cfg), json: {}, secrets: [cfg.values['API key']] });
  await x('UPDATE "AtsYBot" SET "status" = \'stopped\', "statusText" = \'Stopped by a person\', "updatedAt" = ? WHERE "id" = ?', nowIso(), row.id);
  return { ok: true, bot: shapeBot(await botRow(row.id)) };
}
// every 3 minutes, only with the switch ON and never in the test copy: the bots that are on their way / in a call
let timer = null;
function start() {
  if (timer || C.isSandbox() || /^(1|true)$/i.test(String(process.env.TEST_MODE || ''))) return;
  timer = setInterval(async () => {
    try {
      if (!(await C.switchOn('notetakerBot'))) return;
      await C.ensure();
      const rows = await q('SELECT * FROM "AtsYBot" WHERE "status" IN (\'joining\',\'in call\',\'scheduled\') AND "createdAt" > ? LIMIT 20', new Date(Date.now() - 2 * 86400e3).toISOString());
      for (const r of rows) await refresh(r).catch(() => null); // eslint-disable-line no-await-in-loop
    } catch (e) { console.error('[atsY notetaker]', e.message); } // eslint-disable-line no-console
  }, 3 * 60e3);
  if (timer.unref) timer.unref();
}

module.exports = { mapToKit, codeMap, state, sendBot, refresh, stop, botRow, botsOf, start, transcriptText, json };
