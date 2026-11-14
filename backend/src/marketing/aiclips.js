// ---------------------------------------------------------------------------
// AI MARKETING > AI VIDEO > "MAKE A CLIP WITH AI" (2026-11-14): a short real-motion clip from Google Veo (Gemini API), from a description and optionally an approved
// picture as the first frame. The clip is saved exactly like an uploaded clip (a draft "clip": ask for approval, then mix it into a video in AI Video).
//   key      the SAME Gemini key as AI Images (Administration > Integrations > "AI Images (Google Gemini)"), plus "Video model" and "Clips per person per day".
//   money    Veo is PAID per second and has no free tier; Google bills the key's project. So: a person must confirm the estimated cost each time (the server refuses
//            without confirm), at most N clips per person per day (default 3), one clip at a time per person, and every clip is logged in the AI usage log.
//   jobs     a clip takes Google 1-5 minutes. The job is a DATABASE row (OmniMkClipJob), so a deploy / restart in the middle loses nothing: resume() at boot picks up
//            every job Google already accepted and finishes saving it.
//   API      POST models/<model>:predictLongRunning -> an operation name; GET <operation> until done; the video is downloaded from the returned Google address
//            (only generativelanguage.googleapis.com is accepted) with the key in a header.
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const A = require('../outreach/access');
const AI = require('./ai');
const Cfg = require('./settings');
const sandbox = require('../utils/sandbox');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');

const TABLE = 'OmniMkClipJob';
const CHANNEL = 'ai-gemini';
const API = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'veo-3.1-fast-generate-preview';
const POLL_MS = () => Math.max(50, Number(process.env.MK_CLIP_POLL_MS) || 8000);
const GIVE_UP_MS = 12 * 60000;
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${TABLE}" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "userName" TEXT, "department" TEXT, "status" TEXT NOT NULL DEFAULT 'running', "phase" TEXT NOT NULL DEFAULT 'starting', "prompt" TEXT NOT NULL DEFAULT '', "pictureId" TEXT, "aspect" TEXT, "seconds" INTEGER NOT NULL DEFAULT 8, "model" TEXT, "op" TEXT, "clipId" TEXT, "error" TEXT, "errStatus" INTEGER, "costUsd" REAL, "startedAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0, "endedAt" DATETIME)`,
  `CREATE INDEX IF NOT EXISTS "${TABLE}_user" ON "${TABLE}"("userId", "startedAt")`,
];
let okAt = 0;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  try { for (const sql of DDL) await S.run(sql); await AI.ensure(); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] clip schema:', e.message); return false; } // eslint-disable-line no-await-in-loop, no-console
}
const mayWrite = (u) => A.has('mayAiMarketing')(u);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// ---- the key, the model, the limits (Administration > Integrations) ---------------------------------------------------------------------------
async function config() {
  let c = { values: {}, missingKey: false };
  try { c = await require('../utils/integrationStore').readConfig(CHANNEL); } catch { /* not configured */ } // eslint-disable-line global-require
  const v = c.values || {};
  const num = (x, d) => { const n = Number(String(x == null ? '' : x).trim()); return String(x == null ? '' : x).trim() !== '' && Number.isFinite(n) && n >= 0 ? n : d; };
  return {
    key: String(v['Gemini API key'] || '').trim(), missingKey: !!c.missingKey,
    model: String(v['Video model'] || '').trim() || DEFAULT_MODEL,
    perDay: Math.min(50, Math.floor(num(v['Clips per person per day'], 0))), // OFF until an Admin sets it (video is paid; free clips come from Pexels)
    costPerSec: num(v['Video cost per second in US$ (for the estimate)'], 0.12),
  };
}
const SECONDS = [4, 6, 8];
const ASPECTS = ['9:16', '16:9'];
const estimate = (c, seconds) => Math.round(c.costPerSec * seconds * 100) / 100;
async function usedToday(userId) {
  await ensure();
  return S.num(((await S.q('SELECT COUNT(*) AS n FROM "OmniMkAiUsage" WHERE userId = ? AND module = ? AND at >= ? AND ok = 1', userId, 'clips', AI.dayStart()))[0] || {}).n);
}
async function status() {
  const c = await config();
  const base = { model: c.model, perDay: c.perDay, costPerSec: c.costPerSec, seconds: SECONDS, aspects: ASPECTS };
  if (sandbox.isSandbox() && !sandbox.allowAi()) return { ...base, ready: false, reason: 'The test sandbox makes no outside calls, so no clip is asked from Google here.' };
  if (c.missingKey) return { ...base, ready: false, reason: 'The saved Gemini key cannot be read on this server. An Admin enters it again in Administration > Integrations > AI Images (Google Gemini).' };
  if (!c.key) return { ...base, ready: false, reason: 'No Gemini key yet. An Admin adds it in Administration > Integrations > AI Images (Google Gemini); the same key makes clips (Google bills video separately, see the cost below).' };
  if (c.perDay === 0) return { ...base, ready: false, off: true, reason: 'Paid AI clips are switched off. An Admin can switch them on in Administration > Integrations (Clips per person per day), but Google bills them.' };
  return { ...base, ready: true, reason: '' };
}
async function meta(u) {
  const st = await status();
  const used = await usedToday(u.id);
  const act = (await S.q(`SELECT * FROM "${TABLE}" WHERE userId = ? AND status = 'running' AND updatedAt > ? ORDER BY startedAt DESC`, u.id, Date.now() - 20 * 60000))[0];
  return { ...st, usedToday: used, left: Math.max(0, st.perDay - used), canWrite: mayWrite(u), active: act ? jobView(act) : null };
}

// ---- Google calls (fixed host; key in a header, never in an address or a log) ------------------------------------------------------------------
async function g(url, key, body, ms = 60000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { method: body ? 'POST' : 'GET', headers: { 'x-goog-api-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { json = null; }
    if (!r.ok) {
      const full = (json && json.error && json.error.message) || text.slice(0, 200) || `HTTP ${r.status}`;
      const e = new AI.AiMkError(
        /billing|quota|free[_ ]?tier|exceeded|payment|not available on the free/i.test(full) && [400, 403, 429].includes(r.status)
          ? 'Google will not make video clips on this key: Veo is paid and the key\'s project has no billing (or its quota is used up). Switch on billing for this key\'s project in Google AI Studio (aistudio.google.com > Billing), wait a few minutes, then try again. Nothing was charged.'
          : r.status === 404 ? `Google does not know the video model "${(/models\/([^:/]+)/.exec(url) || [])[1] || ''}" for this key. In Administration > Integrations > AI Images (Google Gemini), press Test: it lists the Veo models this key can use.`
            : `Google said: ${full.slice(0, 300)}`, r.status === 429 ? 429 : 502, 'provider');
      e.httpStatus = r.status;
      throw e;
    }
    return { json: json || {}, text };
  } catch (e) {
    if (e instanceof AI.AiMkError) throw e;
    throw new AI.AiMkError(e.name === 'AbortError' ? 'Google did not answer in time.' : `Google could not be reached: ${e.message}`, 503, 'unreachable');
  } finally { clearTimeout(t); }
}
// Test connection (free): the Veo models this key can use
async function testModel() {
  const c = await config();
  if (!c.key) return { ok: false, text: 'no Gemini key', models: [] };
  if (sandbox.isSandbox() && !sandbox.allowAi()) return { ok: false, text: 'the test sandbox makes no outside calls', models: [] };
  try {
    const { json } = await g(`${API}/models?pageSize=200`, c.key, null, 20000);
    const veo = (json.models || []).map((m) => String(m.name || '').replace(/^models\//, '')).filter((n) => /veo/i.test(n));
    const found = veo.includes(c.model);
    return { ok: found, models: veo, text: found ? `video model ${c.model} found (clips are billed by Google when made)` : (veo.length ? `video model "${c.model}" was not found; this key can use: ${veo.join(', ')}` : `no Veo video model is listed for this key (video may need billing); "${c.model}" is set`) };
  } catch (e) { return { ok: false, models: [], text: `video model not checked (${e.message})` }; }
}

// ---- the job -----------------------------------------------------------------------------------------------------------------------------------
const row = async (id) => (await S.q(`SELECT * FROM "${TABLE}" WHERE id = ?`, String(id || '')))[0] || null;
const jobView = (j) => ({
  id: j.id, status: j.status, phase: j.phase, seconds: Math.round(((S.num(j.endedAt) || Date.now()) - S.num(j.startedAt)) / 1000), want: S.num(j.seconds), aspect: j.aspect,
  clipId: j.clipId || null, error: j.error || null, estimateUsd: j.costUsd == null ? null : Number(j.costUsd),
});
const driving = new Set();
async function patch(id, set) {
  const keys = Object.keys(set);
  await S.run(`UPDATE "${TABLE}" SET ${[...keys.map((k) => `"${k}" = ?`), '"updatedAt" = ?'].join(', ')} WHERE id = ?`, ...keys.map((k) => set[k]), Date.now(), id);
}
async function fail(j, e) {
  const msg = e && e.message ? e.message : 'The clip could not be made.';
  await patch(j.id, { status: 'failed', error: S.clip(msg, 600), errStatus: (e && e.status) || 502, endedAt: Date.now() });
  try { await AI.logUsage({ user: { id: j.userId, name: j.userName }, module: 'clips', task: 'create', provider: 'veo', model: j.model, ok: false, inChars: S.num(String(j.prompt || '').length), ms: Date.now() - S.num(j.startedAt), error: msg, department: j.department }); } catch { /* the log is a courtesy */ }
}
// submit to Google (once), poll until done, download, save as a draft clip
async function drive(id) {
  if (driving.has(id)) return;
  driving.add(id);
  let j = await row(id);
  try {
    if (!j || j.status !== 'running') return;
    const c = await config();
    if (!c.key) throw new AI.AiMkError('The Gemini key is not set any more.', 503, 'not_ready');
    if (!j.op) {
      const inst = { prompt: j.prompt };
      if (j.pictureId) {
        const Img = require('./images'); // eslint-disable-line global-require
        const pic = await Img.rawRow(j.pictureId); const f = pic && Img.rawFile(pic);
        if (!f) throw new AI.AiMkError('The picture to start from is not there any more.', 404, 'gone');
        inst.image = { bytesBase64Encoded: require('fs').readFileSync(f.path).toString('base64'), mimeType: f.mime }; // eslint-disable-line global-require
      }
      const { json } = await g(`${API}/models/${encodeURIComponent(j.model)}:predictLongRunning`, c.key, { instances: [inst], parameters: { aspectRatio: j.aspect, durationSeconds: S.num(j.seconds), resolution: '720p' } });
      if (!json.name) throw new AI.AiMkError('Google did not accept the clip request. Try again.', 502, 'provider');
      await patch(j.id, { op: String(json.name), phase: 'google' });
      j = await row(id);
    }
    // wait for Google (a clip takes 1-5 minutes)
    let out = null;
    while (Date.now() - S.num(j.startedAt) < GIVE_UP_MS) {
      const { json } = await g(`${API}/${String(j.op).replace(/^\/+/, '')}`, c.key, null, 30000); // eslint-disable-line no-await-in-loop
      if (json.error) throw new AI.AiMkError(`Google could not make the clip: ${S.clip(json.error.message || 'unknown reason', 300)}`, 502, 'provider');
      if (json.done) { out = json; break; }
      await sleep(POLL_MS()); // eslint-disable-line no-await-in-loop
      await patch(j.id, {}).catch(() => {}); // eslint-disable-line no-await-in-loop
    }
    if (!out) throw new AI.AiMkError('Google is taking too long (over 12 minutes). Nothing was saved; try again later.', 504, 'timeout');
    const resp = out.response || {}; const gv = resp.generateVideoResponse || resp;
    const sample = ((gv.generatedSamples || gv.generatedVideos || [])[0]) || {};
    const uri = (sample.video && (sample.video.uri || sample.video.url)) || '';
    if (!uri) {
      const why = (gv.raiMediaFilteredReasons || [])[0];
      throw new AI.AiMkError(`Google would not make this clip${why ? ` (${S.clip(why, 160)})` : ''}. Change the description and try again.`, 422, 'refused');
    }
    let host = ''; try { host = new URL(uri).hostname; } catch { host = ''; }
    if (host !== 'generativelanguage.googleapis.com') throw new AI.AiMkError('Google sent the clip from an address that is not allowed.', 502, 'provider');
    await patch(j.id, { phase: 'saving' });
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 120000);
    let buf;
    try { const r = await fetch(uri, { headers: { 'x-goog-api-key': c.key }, signal: ctl.signal, redirect: 'follow' }); if (!r.ok) throw new AI.AiMkError(`The clip could not be downloaded from Google (HTTP ${r.status}).`, 502, 'provider'); buf = Buffer.from(await r.arrayBuffer()); } finally { clearTimeout(t); }
    const { resolveIdentity } = require('../utils/identity'); // eslint-disable-line global-require
    const u = await resolveIdentity(j.userId);
    const title = S.clip(j.prompt.replace(/\s+/g, ' ').split(' ').slice(0, 7).join(' '), 70) || 'AI clip';
    const saved = await require('./images').saveVideo(u, buf, 'video/mp4', { kind: 'clip', model: 'veo', title: `AI clip: ${title}`, aspect: j.aspect, seconds: S.num(j.seconds), department: j.department, about: `AI clip (Google Veo, ${S.num(j.seconds)} s): ${S.clip(j.prompt, 300)}` }); // eslint-disable-line global-require
    if (saved.error) throw new AI.AiMkError(saved.error, saved.status || 502, 'save');
    await patch(j.id, { status: 'done', phase: 'done', clipId: saved.item.id, endedAt: Date.now() });
    await AI.logUsage({ user: { id: j.userId, name: j.userName }, module: 'clips', task: 'create', provider: 'veo', model: j.model, ok: true, inChars: String(j.prompt || '').length, outChars: buf.length, ms: Date.now() - S.num(j.startedAt), department: j.department, itemId: saved.item.id });
    await logAudit({ userId: j.userId, actorName: j.userName, action: 'Omni-Channel AI Marketing: AI video clip made (Google Veo)', entity: TABLE, entityId: j.id, toValue: `${S.num(j.seconds)} s ${j.aspect}${j.pictureId ? ' from a picture' : ''}; about US$${S.num(j.costUsd)}; ${S.clip(j.prompt, 120)}` });
    try { await notifyUsers([j.userId], { title: 'Your AI clip is ready', message: 'Open Omni-Channel > AI Marketing > AI Video > Your clips: ask for approval, then join it into a video.' }); } catch { /* a courtesy */ }
  } catch (e) {
    if (j) await fail(j, e).catch((x) => console.error('[omni-mk] clip fail:', x.message)); // eslint-disable-line no-console
  } finally { driving.delete(id); }
}

async function create(u, b = {}) {
  await ensure();
  if (!mayWrite(u)) return { error: 'Your login can look at clips but not make them.', status: 403 };
  const st = await status();
  if (!st.ready) return { error: `AI clips are not ready: ${st.reason}`, status: 503, code: 'not_ready' };
  const prompt = S.clip(b.prompt, 800);
  if (prompt.length < 8) return { error: 'Describe the clip in a sentence first.', status: 400 };
  const seconds = SECONDS.includes(Number(b.seconds)) ? Number(b.seconds) : 8;
  const aspect = ASPECTS.includes(b.aspect) ? b.aspect : '9:16';
  const c = await config();
  const cost = estimate(c, seconds);
  // the money rule: nothing is asked from Google until the person has seen the cost and confirmed it
  if (b.confirm !== true) return { error: `Confirm the cost first: this clip is billed by Google, about US$${cost.toFixed(2)} (${seconds} seconds).`, status: 409, code: 'confirm', estimateUsd: cost };
  const running = (await S.q(`SELECT id FROM "${TABLE}" WHERE userId = ? AND status = 'running' AND updatedAt > ?`, u.id, Date.now() - 20 * 60000))[0];
  if (running) return { error: 'Your last clip is still being made. Wait for it to finish first.', status: 409, code: 'busy' };
  const used = await usedToday(u.id);
  if (used >= c.perDay) return { error: `You have made your ${c.perDay} AI clip${c.perDay === 1 ? '' : 's'} for today. It resets at midnight (India time), or an Admin can raise the limit in Administration > Integrations.`, status: 429 };
  let pictureId = null;
  if (b.pictureId) {
    const g2 = await require('./images').getRow(u, b.pictureId); // eslint-disable-line global-require
    if (!g2 || g2.r.status !== 'approved' || /^video\//.test(g2.r.mime)) return { error: 'Pick an approved picture to start from (or leave it empty).', status: 400 };
    pictureId = g2.r.id;
  }
  const dept = S.clip(b.department, 60) || (A.departmentsOf(u).length === 1 ? A.departmentsOf(u)[0] : S.clip(u.department, 60));
  const id = S.newId('clj'); const now = Date.now();
  await S.run(`INSERT INTO "${TABLE}" (id, userId, userName, department, status, phase, prompt, pictureId, aspect, seconds, model, costUsd, startedAt, updatedAt) VALUES (?,?,?,?,'running','starting',?,?,?,?,?,?,?,?)`,
    id, u.id, S.clip(u.name, 80), dept || null, prompt, pictureId, aspect, seconds, c.model, cost, now, now);
  drive(id).catch((e) => console.error('[omni-mk] clip drive:', e.message)); // eslint-disable-line no-console
  return { job: jobView(await row(id)) };
}
async function getJob(u, id) {
  await ensure();
  const j = await row(id);
  if (!j || j.userId !== u.id) return { error: 'This clip job was not found. A finished clip is in Your clips.', status: 404 };
  return { job: jobView(j) };
}
// at boot: finish every job Google already accepted; one that never reached Google is closed (nothing was charged)
async function resume() {
  if (!(await ensure())) return;
  const open = await S.q(`SELECT * FROM "${TABLE}" WHERE status = 'running'`);
  for (const j of open) {
    if (Date.now() - S.num(j.startedAt) > GIVE_UP_MS + 60000) { await fail(j, new AI.AiMkError('This clip job took too long and was closed. Try again.', 504, 'timeout')); continue; } // eslint-disable-line no-await-in-loop
    if (!j.op) { await fail(j, new AI.AiMkError('TeamLink restarted before Google accepted the request. Nothing was charged. Press Make the clip again.', 503, 'restarted')); continue; } // eslint-disable-line no-await-in-loop
    drive(j.id).catch((e) => console.error('[omni-mk] clip resume:', e.message)); // eslint-disable-line no-console
  }
}

module.exports = { ensure, status, meta, create, getJob, testModel, resume, SECONDS, ASPECTS };
