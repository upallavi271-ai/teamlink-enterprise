// ---------------------------------------------------------------------------
// AI MARKETING > AI IMAGES (2026-11-13, module 8). Marketing pictures from a short description, in the brand colours, with the brand logo when the
// model can take a picture as input. Provider: Google Gemini (Administration > Integrations > "AI Images (Google Gemini)", key encrypted there).
//   models   gemini-*  -> :generateContent (one picture per call; the logo can be sent along as a reference picture)
//            imagen-*  -> :predict (1-4 pictures per call; no reference picture)
//   status   draft -> waiting -> approved | changes (sent back with a note). Only APPROVED pictures get a public link (for the Content Calendar and
//            for posting by hand). Same approvers as AI Content: an Admin, or a Team Lead / BDE TL of the department; nobody approves their own,
//            except an Admin when the AI Marketing switch allows it.
//   files    <UPLOAD_DIR or ~/.teamlink-uploads>/mk-images/<id>.<png|jpg|webp> (outside the repo, inside the daily backup).
//   limits   "Pictures per person per day" on the integration (default 20) + 4 a minute per person. Every call is logged in the AI usage log.
//   sandbox  no call leaves the machine: a plain sample picture in the brand colours is made instead, and it says so.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const S = require('../outreach/store');
const A = require('../outreach/access');
const AI = require('./ai');
const Cfg = require('./settings');
const sandbox = require('../utils/sandbox');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');

const TABLE = 'OmniMkImage';
const CHANNEL = 'ai-gemini';
const DEFAULT_MODEL = 'gemini-2.5-flash-image';
const API = 'https://generativelanguage.googleapis.com/v1beta';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${TABLE}" ("id" TEXT NOT NULL PRIMARY KEY, "title" TEXT NOT NULL DEFAULT '', "prompt" TEXT NOT NULL DEFAULT '', "headline" TEXT, "style" TEXT, "aspect" TEXT, "model" TEXT, "withLogo" INTEGER NOT NULL DEFAULT 0, "file" TEXT NOT NULL, "mime" TEXT NOT NULL, "bytes" INTEGER NOT NULL DEFAULT 0, "demo" INTEGER NOT NULL DEFAULT 0, "status" TEXT NOT NULL DEFAULT 'draft', "note" TEXT, "department" TEXT, "createdById" TEXT, "createdByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0, "submittedAt" DATETIME, "decidedAt" DATETIME, "decidedById" TEXT, "decidedByName" TEXT, "selfApproved" INTEGER NOT NULL DEFAULT 0, "deletedAt" DATETIME)`,
  `CREATE INDEX IF NOT EXISTS "${TABLE}_status" ON "${TABLE}"("status", "createdAt")`,
];
let okAt = 0;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  try { for (const sql of DDL) await S.run(sql); await AI.ensure(); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] images schema:', e.message); return false; } // eslint-disable-line no-await-in-loop, no-console
}
const dir = () => path.join(process.env.UPLOAD_DIR || path.join(os.homedir() || os.tmpdir(), '.teamlink-uploads'), 'mk-images');
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

// ---- choices ------------------------------------------------------------------------------------------------------------------------
const STYLES = {
  photo: 'a natural, realistic photograph with soft light',
  illustration: 'a clean modern flat illustration',
  graphic: 'a bold social-media graphic with simple shapes and plenty of empty space',
  poster: 'a minimal poster layout with one clear focal point',
  '3d': 'a soft 3D render with rounded shapes',
};
const ASPECTS = [
  { key: '1:1', label: 'Square post (1:1)' }, { key: '4:5', label: 'Instagram portrait (4:5)' }, { key: '9:16', label: 'Story / Reel (9:16)' },
  { key: '16:9', label: 'Banner / LinkedIn (16:9)' }, { key: '3:4', label: 'Portrait (3:4)' },
];
const IMAGEN_ASPECTS = ['1:1', '3:4', '4:3', '9:16', '16:9'];

// ---- the key and the model (Administration > Integrations) ---------------------------------------------------------------------------
async function config() {
  let c = { values: {}, missingKey: false };
  try { c = await require('../utils/integrationStore').readConfig(CHANNEL); } catch { /* not configured */ } // eslint-disable-line global-require
  const v = c.values || {};
  const key = String(v['Gemini API key'] || '').trim();
  const model = String(v['Image model'] || '').trim() || DEFAULT_MODEL;
  // empty = the default 20 (the Integrations screen saves the greyed "20" hint as empty); only a typed 0 switches pictures off
  const raw = String(v['Pictures per person per day'] || '').trim();
  const per = raw === '' ? 20 : Number(raw);
  return { key, model, perDay: Number.isFinite(per) && per >= 0 ? Math.min(Math.floor(per), 500) : 20, missingKey: !!c.missingKey };
}
const isImagen = (model) => /^imagen/i.test(model);
// Gemini picture models carry "image" in their name (gemini-2.5-flash-image, gemini-3-pro-image-preview ...). A text model such as gemini-2.5-flash
// exists (so the free check passes) but never returns a picture: say so plainly instead of failing at every press.
const canDraw = (model) => isImagen(model) || /image/i.test(model);
const NOT_DRAW = (model) => `"${model}" is a text model: it cannot make pictures. In Administration > Integrations > AI Images (Google Gemini) leave "Image model" empty (it then uses ${DEFAULT_MODEL}) or type a picture model such as ${DEFAULT_MODEL}.`;
async function status() {
  if (sandbox.isSandbox() && !sandbox.allowAi()) return { ready: true, demo: true, model: 'sample picture maker (test sandbox)', reason: '', logoInput: true };
  const c = await config();
  if (c.missingKey) return { ready: false, model: c.model, reason: 'The saved Gemini key cannot be read on this server (the encryption key changed). An Admin must enter it again in Administration > Integrations > AI Images (Google Gemini).' };
  if (!c.key) return { ready: false, model: c.model, reason: 'No Gemini key yet. An Admin adds it in Administration > Integrations > AI Images (Google Gemini).' };
  if (!canDraw(c.model)) return { ready: false, model: c.model, reason: NOT_DRAW(c.model) };
  return { ready: true, model: c.model, reason: '', logoInput: !isImagen(c.model), perDay: c.perDay };
}

// ---- Google calls (fixed host; key in a header, never in the address or a log) --------------------------------------------------------------
async function call(url, key, body, ms = 120000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { method: body ? 'POST' : 'GET', headers: { 'x-goog-api-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { json = null; }
    if (!r.ok) {
      const msg = (json && json.error && json.error.message) || text.slice(0, 200) || `HTTP ${r.status}`;
      const err = new AI.AiMkError(`Google said: ${msg}`, r.status === 429 ? 429 : 502, r.status === 429 ? 'provider_rate' : 'provider');
      err.httpStatus = r.status;
      throw err;
    }
    return json || {};
  } catch (e) {
    if (e instanceof AI.AiMkError) throw e;
    throw new AI.AiMkError(e.name === 'AbortError' ? 'Google did not answer in time. Try again.' : `Google could not be reached: ${e.message}`, 503, 'unreachable');
  } finally { clearTimeout(t); }
}
async function testConnection() {
  const c = await config();
  if (!c.key) return { ok: false, model: c.model, error: c.missingKey ? 'the saved key cannot be read on this server; enter it again' : 'no Gemini API key saved' };
  if (sandbox.isSandbox() && !sandbox.allowAi()) return { ok: false, model: c.model, error: 'the test sandbox makes no outside calls' };
  if (!canDraw(c.model)) return { ok: false, model: c.model, error: NOT_DRAW(c.model) };
  try { const m = await call(`${API}/models/${encodeURIComponent(c.model)}`, c.key, null, 20000); return { ok: true, model: m.displayName || c.model }; } catch (e) { return { ok: false, model: c.model, error: e.message }; }
}
const refused = (why) => new AI.AiMkError(`Google would not make this picture${why ? ` (${String(why).toLowerCase().replace(/_/g, ' ')})` : ''}. Change the description and try again.`, 422, 'refused');
async function geminiOne(c, prompt, aspect, logo) {
  const parts = [];
  if (logo) parts.push({ inline_data: { mime_type: logo.mime, data: logo.b64 } });
  parts.push({ text: prompt });
  const body = { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: aspect } } };
  let j;
  try { j = await call(`${API}/models/${encodeURIComponent(c.model)}:generateContent`, c.key, body); } catch (e) {
    // an older model without the size setting: ask once more without it (the picture is then square)
    if (e.httpStatus === 400 && /image_?config|aspect/i.test(e.message)) { delete body.generationConfig.imageConfig; j = await call(`${API}/models/${encodeURIComponent(c.model)}:generateContent`, c.key, body); } else throw e;
  }
  if (j.promptFeedback && j.promptFeedback.blockReason) throw refused(j.promptFeedback.blockReason);
  const cand = (j.candidates || [])[0] || {};
  const img = ((cand.content && cand.content.parts) || []).map((p) => p.inlineData || p.inline_data).find((d) => d && d.data);
  if (!img) throw refused(cand.finishReason && cand.finishReason !== 'STOP' ? cand.finishReason : 'no picture came back');
  return [{ mime: img.mimeType || img.mime_type || 'image/png', b64: img.data }];
}
async function imagenMany(c, prompt, aspect, n) {
  // Imagen has no 4:5: the closest portrait size (3:4) keeps an Instagram post a portrait
  const ar = IMAGEN_ASPECTS.includes(aspect) ? aspect : (aspect === '4:5' ? '3:4' : '1:1');
  const j = await call(`${API}/models/${encodeURIComponent(c.model)}:predict`, c.key, { instances: [{ prompt }], parameters: { sampleCount: n, aspectRatio: ar, personGeneration: 'allow_adult' } });
  const out = (j.predictions || []).filter((p) => p && p.bytesBase64Encoded).map((p) => ({ mime: p.mimeType || 'image/png', b64: p.bytesBase64Encoded }));
  if (!out.length) throw refused((j.predictions || [])[0] && (j.predictions[0].raiFilteredReason || 'filtered'));
  return out;
}

// ---- the sample picture of the test sandbox: a gradient in the brand colours (a real PNG, made here) ---------------------------------------
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (buf) => { let c = -1; for (let i = 0; i < buf.length; i += 1) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16) || 0);
function samplePng(aspect, c1, c2) {
  const [aw, ah] = aspect.split(':').map(Number);
  const w = 360; const h = Math.round((w * ah) / aw);
  const a = rgb(c1); const b = rgb(c2);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x += 1) {
      const t = (x / w + y / h) / 2; const o = y * (w * 3 + 1) + 1 + x * 3;
      for (let k = 0; k < 3; k += 1) raw[o + k] = Math.round(a[k] * (1 - t) + b[k] * t);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---- who may do what (the same people as AI Content) ------------------------------------------------------------------------------------
const mayWrite = (u) => A.has('mayAiMarketing')(u);
function canApprove(u, r, set) {
  if (r.createdById === u.id) return A.isAdmin(u) && set.selfApprove;
  if (A.isAdmin(u)) return true;
  return A.has('mayAiApprove')(u) && !!r.department && A.mayDepartment(u, r.department);
}
function visible(u, r, set) {
  if (r.deletedAt) return false;
  if (A.isAdmin(u) || r.createdById === u.id) return true;
  if (A.kind(u) === 'marketing' && A.mayDepartment(u, r.department || '')) return true;
  return canApprove(u, r, set);
}
const mine = (u, r) => A.isAdmin(u) || r.createdById === u.id;

// the public link of an APPROVED picture: /api/mk-image/<id>/<signature>.<ext>. The signature is an HMAC of the id, so links cannot be guessed;
// a picture that is sent back or deleted stops answering at once.
const secret = () => process.env.MK_IMAGE_SECRET || process.env.JWT_SECRET || 'teamlink-dev';
const sign = (id) => crypto.createHmac('sha256', secret()).update(`mk-image:${id}`).digest('base64url').slice(0, 32);
const publicPath = (r) => `/api/mk-image/${r.id}/${sign(r.id)}.${EXT[r.mime] || 'png'}`;

function view(u, r, set) {
  return {
    id: r.id, title: r.title, prompt: r.prompt, headline: r.headline || '', style: r.style || '', aspect: r.aspect || '1:1', model: r.model || '', withLogo: S.num(r.withLogo) === 1,
    bytes: S.num(r.bytes), demo: S.num(r.demo) === 1, status: r.status, note: r.note || '', department: r.department || '', createdByName: r.createdByName || '', mine: r.createdById === u.id,
    createdAt: S.iso(r.createdAt), submittedAt: S.iso(r.submittedAt), decidedAt: S.iso(r.decidedAt), decidedByName: r.decidedByName || '', selfApproved: S.num(r.selfApproved) === 1,
    publicPath: r.status === 'approved' ? publicPath(r) : null,
    canEdit: mayWrite(u) && mine(u, r) && r.status !== 'waiting', canSubmit: mayWrite(u) && mine(u, r) && ['draft', 'changes'].includes(r.status),
    canApprove: r.status === 'waiting' && canApprove(u, r, set), canDelete: mayWrite(u) && mine(u, r) && r.status !== 'waiting',
  };
}
const row = async (id) => (await S.q(`SELECT * FROM "${TABLE}" WHERE id = ?`, String(id || '')))[0] || null;
async function getRow(u, id) { await ensure(); const r = await row(id); const set = await Cfg.getSettings(); return r && visible(u, r, set) ? { r, set } : null; }

async function list(u, { status: st = '' } = {}) {
  await ensure();
  const set = await Cfg.getSettings();
  const rows = (await S.q(`SELECT * FROM "${TABLE}" WHERE deletedAt IS NULL ORDER BY createdAt DESC LIMIT 600`)).filter((r) => visible(u, r, set) && (!st || r.status === st));
  return { items: rows.map((r) => view(u, r, set)), canWrite: mayWrite(u) };
}
async function meta(u) {
  await ensure();
  const st = await status();
  const brand = await Cfg.getBrand();
  const day = AI.dayStart();
  const used = S.num(((await S.q('SELECT COUNT(*) AS n FROM "OmniMkAiUsage" WHERE userId = ? AND module = ? AND at >= ? AND ok = 1', u.id, 'images', day))[0] || {}).n);
  return { ai: st, styles: Object.keys(STYLES), aspects: ASPECTS, usedToday: used, perDay: st.perDay != null ? st.perDay : (await config()).perDay, hasLogo: brand.hasLogo, brandName: brand.brandName, colors: brand.colors, canWrite: mayWrite(u) };
}

// ---- make pictures ---------------------------------------------------------------------------------------------------------------------
const minute = new Map();
function promptFor(b, brand, withLogo) {
  const colors = brand.colors || {};
  return [
    `Create a marketing picture for ${brand.brandName || 'a staffing company'}${brand.about ? ` (${brand.about})` : ''}.`,
    `What it shows: ${b.prompt}.`,
    `Style: ${STYLES[b.style] || STYLES.photo}.`,
    b.useColors ? `Use the brand colours: main ${colors.primary}, second ${colors.secondary}, accent ${colors.accent}.` : '',
    b.headline ? `Write this headline in the picture, spelled exactly, large and easy to read: "${b.headline}". No other words.` : 'Do not put any words, letters or numbers in the picture.',
    withLogo ? 'The first picture is the company logo: place it small and unchanged in one corner. Do not change its shape, letters or colours.' : 'Do not add any logo or brand mark.',
    'Real-looking, respectful, diverse Indian people where people appear. No celebrities, no real brands other than the given logo, no watermarks.',
  ].filter(Boolean).join('\n');
}
// Making pictures takes Google 10-40 seconds each, longer than the live web server waits for an answer (about 60 s). So create() checks the request
// and the limits at once, then makes the pictures in the BACKGROUND and answers { job } straight away; the screen asks GET /images/jobs/:id until
// the job is done. One job at a time per person (a second press while one runs is refused, so nothing is made twice). opts.wait = finish first
// (tests). Jobs live in memory for 30 minutes; the pictures themselves are saved as soon as they arrive, so a restart loses only the job note.
const jobs = new Map(); // id -> { id, userId, status: running|done|failed, n, startedAt, items, error, errStatus, demo, ms, made }
const JOB_KEEP_MS = 30 * 60000;
function sweepJobs(now = Date.now()) { for (const [id, j] of jobs) if (now - j.startedAt > JOB_KEEP_MS) jobs.delete(id); }
function jobView(j) { return { id: j.id, status: j.status, n: j.n, startedAt: new Date(j.startedAt).toISOString(), seconds: Math.round(((j.endedAt || Date.now()) - j.startedAt) / 1000), items: j.items || null, error: j.error || null, note: j.note || null, demo: !!j.demo }; }
function getJob(u, id) {
  sweepJobs();
  const j = jobs.get(String(id || ''));
  if (!j || j.userId !== u.id) return { error: 'This picture job was not found. The pictures that were made are in the list.', status: 404 };
  return { job: jobView(j) };
}
async function create(u, b = {}, opts = {}) {
  await ensure();
  sweepJobs();
  if ([...jobs.values()].some((j) => j.userId === u.id && j.status === 'running')) return { error: 'Your last pictures are still being made. Wait for them to finish first.', status: 409, code: 'busy' };
  if (!mayWrite(u)) return { error: 'Your login can look at AI pictures but not make them.', status: 403 };
  const prompt = S.clip(b.prompt, 1000);
  if (prompt.length < 8) return { error: 'Describe the picture in a sentence first.', status: 400 };
  const aspect = ASPECTS.some((a) => a.key === b.aspect) ? b.aspect : '1:1';
  const style = STYLES[b.style] ? b.style : 'photo';
  const n = Math.max(1, Math.min(4, Number(b.count) || 1));
  const headline = S.clip(b.headline, 80);
  const st = await status();
  if (!st.ready) return { error: `AI pictures are not ready: ${st.reason}`, status: 503, code: 'not_ready' };
  // limits: 4 a minute, and the daily number from the integration
  const now = Date.now();
  const hits = (minute.get(u.id) || []).filter((t) => now - t < 60000);
  if (hits.length >= 4) return { error: 'Too many picture requests in one minute. Wait a moment.', status: 429 };
  hits.push(now); minute.set(u.id, hits);
  const c = await config();
  const used = S.num(((await S.q('SELECT COUNT(*) AS n FROM "OmniMkAiUsage" WHERE userId = ? AND module = ? AND at >= ? AND ok = 1', u.id, 'images', AI.dayStart(now)))[0] || {}).n);
  if (!st.demo && used + n > c.perDay) return { error: c.perDay === 0 ? 'AI pictures are switched off (0 a day). An Admin can change it in Administration > Integrations.' : `That would pass your ${c.perDay} pictures for today (${used} made). Make fewer, or ask an Admin to raise the limit.`, status: 429 };

  const brand = await Cfg.getBrand();
  const logoRow = b.withLogo && st.logoInput ? await Cfg.getLogo() : null;
  const logo = logoRow ? (() => { const m = /^data:([^;]+);base64,(.+)$/.exec(logoRow.dataUrl); return m ? { mime: m[1], b64: m[2] } : null; })() : null;
  const text = promptFor({ ...b, prompt, headline }, brand, !!logo);
  const dept = S.clip(b.department, 60) || (A.departmentsOf(u).length === 1 ? A.departmentsOf(u)[0] : S.clip(u.department, 60));
  const title = S.clip(b.title, 80) || S.clip(prompt.replace(/\s+/g, ' ').split(' ').slice(0, 7).join(' '), 80);
  const job = { id: S.newId('job'), userId: u.id, status: 'running', n, startedAt: Date.now() };
  jobs.set(job.id, job);
  const run = produce(u, { st, c, n, aspect, style, headline, prompt, text, logo, brand, dept, title })
    .then((r) => {
      Object.assign(job, r.error ? { status: 'failed', error: r.error, errStatus: r.status, code: r.code } : { status: 'done', items: r.items, demo: r.demo, ms: r.ms, note: r.note });
      // a request Google refused or failed does not count against the minute limit (only the daily count of pictures really made does)
      if (r.error) { const h = minute.get(u.id) || []; const i = h.indexOf(now); if (i >= 0) { h.splice(i, 1); minute.set(u.id, h); } }
    })
    .catch((e) => { Object.assign(job, { status: 'failed', error: e.message || 'The pictures could not be made.', errStatus: 502 }); })
    .finally(() => { job.endedAt = Date.now(); });
  if (opts.wait) {
    await run;
    return job.status === 'done' ? { items: job.items, demo: !!job.demo, ms: job.ms, note: job.note } : { error: job.error, status: job.errStatus || 502, code: job.code };
  }
  return { job: jobView(job) };
}

// the slow part of create(), run in the background: ask Google (the pictures of one request in PARALLEL), save every picture that came back
async function produce(u, x) {
  const { st, c, n, aspect, style, headline, prompt, text, logo, brand, dept, title } = x;
  const t0 = Date.now();
  let pics = []; let note = null;
  try {
    if (st.demo) pics = Array.from({ length: n }, () => ({ mime: 'image/png', b64: samplePng(aspect, brand.colors.primary, brand.colors.accent).toString('base64') }));
    else if (isImagen(c.model)) pics = await imagenMany(c, text, aspect, n);
    else {
      const res = await Promise.allSettled(Array.from({ length: n }, () => geminiOne(c, text, aspect, logo)));
      pics = res.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
      const bad = res.filter((r) => r.status === 'rejected');
      if (!pics.length) throw bad[0].reason;
      if (bad.length) note = `${pics.length} of ${n} pictures were made. ${bad[0].reason.message}`;
    }
  } catch (e) {
    await AI.logUsage({ user: u, module: 'images', task: 'create', provider: 'gemini', model: c.model, ok: false, inChars: text.length, ms: Date.now() - t0, error: e.message });
    return { error: e.message, status: e.status || 502, code: e.code };
  }
  fs.mkdirSync(dir(), { recursive: true });
  const made = [];
  for (const p of pics) {
    const mime = EXT[p.mime] ? p.mime : 'image/png';
    const buf = Buffer.from(p.b64, 'base64');
    const id = S.newId('img');
    const file = `${id}.${EXT[mime]}`;
    fs.writeFileSync(path.join(dir(), file), buf);
    const ts = Date.now();
    await S.run(`INSERT INTO "${TABLE}" (id, title, prompt, headline, style, aspect, model, withLogo, file, mime, bytes, demo, status, department, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?,?)`, // eslint-disable-line no-await-in-loop
      id, title, prompt, headline || null, style, aspect, st.demo ? 'sample' : c.model, logo ? 1 : 0, file, mime, buf.length, st.demo ? 1 : 0, dept || null, u.id, S.clip(u.name, 80), ts, ts);
    await AI.logUsage({ user: u, module: 'images', task: 'create', provider: st.demo ? 'demo' : 'gemini', model: st.demo ? 'sample' : c.model, ok: true, inChars: text.length, outChars: buf.length, ms: Date.now() - t0, department: dept, itemId: id }); // eslint-disable-line no-await-in-loop
    made.push(id);
  }
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: AI pictures made', entity: TABLE, entityId: made[0], toValue: `${made.length} picture(s); ${title}${st.demo ? '; sandbox sample' : `; ${c.model}`}` });
  const set = await Cfg.getSettings();
  const rows = await Promise.all(made.map((id) => row(id)));
  return { items: rows.map((r) => view(u, r, set)), demo: !!st.demo, ms: Date.now() - t0, note };
}

// ---- the file (signed-in, any status the person may see) ----------------------------------------------------------------------------------
async function file(u, id) {
  const g = await getRow(u, id);
  if (!g) return null;
  const p = path.join(dir(), path.basename(g.r.file));
  return fs.existsSync(p) ? { path: p, mime: g.r.mime, name: `${g.r.title || 'picture'}.${EXT[g.r.mime] || 'png'}` } : null;
}
// the public link: approved pictures only, signature checked in constant time
async function publicFile(id, sig) {
  await ensure();
  const r = await row(id);
  if (!r || r.deletedAt || r.status !== 'approved') return null;
  const want = Buffer.from(sign(r.id)); const got = Buffer.from(String(sig || ''));
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  const p = path.join(dir(), path.basename(r.file));
  return fs.existsSync(p) ? { path: p, mime: r.mime } : null;
}

// ---- rename / delete / approval ----------------------------------------------------------------------------------------------------------
async function update(u, id, b = {}) {
  const g = await getRow(u, id); if (!g) return { error: 'This picture was not found.', status: 404 };
  const { r, set } = g;
  if (!mayWrite(u) || !mine(u, r) || r.status === 'waiting') return { error: r.status === 'waiting' ? 'It is waiting for approval and cannot be changed now.' : 'Only the person who made it, or an Admin, can change it.', status: 403 };
  const title = S.clip(b.title, 80);
  if (!title) return { error: 'Give the picture a name.', status: 400 };
  await S.run(`UPDATE "${TABLE}" SET title = ?, updatedAt = ? WHERE id = ?`, title, Date.now(), r.id);
  return { item: view(u, await row(r.id), set) };
}
async function remove(u, id) {
  const g = await getRow(u, id); if (!g) return { error: 'This picture was not found.', status: 404 };
  const { r } = g;
  if (!mayWrite(u) || !mine(u, r)) return { error: 'Only the person who made it, or an Admin, can delete it.', status: 403 };
  if (r.status === 'waiting') return { error: 'It is waiting for approval. Ask the approver to send it back first.', status: 409 };
  await S.run(`UPDATE "${TABLE}" SET deletedAt = ? WHERE id = ?`, Date.now(), r.id);
  try { fs.unlinkSync(path.join(dir(), path.basename(r.file))); } catch { /* already gone */ }
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: AI picture deleted', entity: TABLE, entityId: r.id, toValue: r.title });
  return { ok: true };
}
async function submit(u, id) {
  const g = await getRow(u, id); if (!g) return { error: 'This picture was not found.', status: 404 };
  const { r, set } = g;
  if (!mayWrite(u) || !mine(u, r)) return { error: 'Only the person who made it, or an Admin, can ask for approval.', status: 403 };
  if (!['draft', 'changes'].includes(r.status)) return { error: r.status === 'waiting' ? 'It is already waiting for approval.' : 'It is already approved.', status: 409 };
  const now = Date.now();
  await S.run(`UPDATE "${TABLE}" SET status = 'waiting', note = NULL, submittedAt = ?, updatedAt = ? WHERE id = ?`, now, now, r.id);
  // the same approvers AI Content tells (marketing/content.js), checked one by one with the picture's own rule
  let ids = [];
  try {
    const prisma = require('../db'); const { resolveIdentity } = require('../utils/identity'); // eslint-disable-line global-require
    const users = await prisma.user.findMany({ where: { status: 'Active', OR: [{ role: { in: ['SUPER_ADMIN', 'ADMIN', 'TL', 'STL'] } }, { atsRole: { in: ['SUPER_ADMIN', 'ADMIN', 'TL', 'STL'] } }] }, select: { id: true }, take: 120 });
    for (const x of users.filter((y) => y.id !== u.id)) { let ident = null; try { ident = await resolveIdentity(x.id); } catch { ident = null; } if (ident && canApprove(ident, r, set)) ids.push(x.id); } // eslint-disable-line no-await-in-loop
  } catch { ids = []; }
  if (ids.length) await notifyUsers(ids, { title: `AI picture "${S.clip(r.title, 60)}" needs your approval`, message: `${S.clip(u.name, 60)} asked for approval. Open Omni-Channel > AI Marketing > Approvals.` });
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: AI picture sent for approval', entity: TABLE, entityId: r.id, toValue: `${r.title}; ${ids.length} approver(s) told` });
  return { ok: ids.length ? 'Sent for approval. The approvers have been told.' : 'Sent for approval. No approver could be told by notice: ask an Admin to open Approvals.', item: view(u, await row(r.id), set) };
}
async function decide(u, id, approve, note) {
  const g = await getRow(u, id); if (!g) return { error: 'This picture was not found.', status: 404 };
  const { r, set } = g;
  if (r.status !== 'waiting') return { error: 'This picture is not waiting for approval.', status: 409 };
  if (!canApprove(u, r, set)) return { error: r.createdById === u.id ? 'You cannot approve your own picture. Another approver has to do it.' : 'Only an Admin, or a Team Lead of this department, can approve this picture.', status: 403 };
  const words = S.clip(note, 300);
  if (!approve && words.length < 5) return { error: 'Write a few words so the person knows what to change.', status: 400 };
  const now = Date.now(); const self = r.createdById === u.id;
  await S.run(`UPDATE "${TABLE}" SET status = ?, note = ?, decidedAt = ?, decidedById = ?, decidedByName = ?, selfApproved = ?, updatedAt = ? WHERE id = ?`, approve ? 'approved' : 'changes', words || null, now, u.id, S.clip(u.name, 80), approve && self ? 1 : 0, now, r.id);
  if (r.createdById && !self) await notifyUsers([r.createdById], approve ? { title: `AI picture "${S.clip(r.title, 60)}" was approved`, message: `${S.clip(u.name, 60)} approved it${words ? `: ${words}` : ''}. It can now be used in the Content Calendar and downloaded for posts.` } : { title: `AI picture "${S.clip(r.title, 60)}" needs changes`, message: `${S.clip(u.name, 60)} sent it back: ${words}` });
  await logAudit({ userId: u.id, actorName: u.name, action: approve ? (self ? 'Omni-Channel AI Marketing: AI picture self-approved by an Admin' : 'Omni-Channel AI Marketing: AI picture approved') : 'Omni-Channel AI Marketing: AI picture sent back', entity: TABLE, entityId: r.id, toValue: approve ? r.title : `${r.title}: ${words}` });
  return { ok: approve ? 'Approved. It can now be used in the Content Calendar.' : 'Sent back with your note.', item: view(u, await row(r.id), set) };
}

module.exports = {
  ensure, STYLES, ASPECTS, status, testConnection, meta, list, create, getJob, file, publicFile, update, remove, submit,
  approve: (u, id, n) => decide(u, id, true, n), reject: (u, id, n) => decide(u, id, false, n), mayWrite, sign, samplePng,
};
