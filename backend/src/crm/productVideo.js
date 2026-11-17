// ---------------------------------------------------------------------------
// OUR PRODUCTS: UPLOAD A VIDEO, AND THE CONTENT IS MADE FROM IT (founder 2026-11-17). Leads > Our products (managers):
//   upload            one video with all the products (again whenever it changes), a product's own demo (replaces it), another video for a
//                     product (added next to its demo), or a company / general video (top of every demo page); any product, also one
//                     added later; MP4, MOV, M4V, WebM, MKV, AVI up to 3 GB; sent in 8 MB pieces
//   analyse           the narration is turned into text with times (faster-whisper on the server, the same one the AI calls use);
//                     the narration names each part ("In HRMS ...", "In the ATS ...", "Omni-Channel opens on ...", "The Job Portal's
//                     recruiter desk opens on ..."), so the video is split by those openings, each checked by the words that follow;
//                     the TeamLink intro at the start and the closing lines at the end are kept for every product
//   draft             per product: the parts (start - end, editable, with a preview) and the text written from THAT product's narration
//                     only (tagline, about, features, Q&A; never a price). Nothing changes on the live demo until a manager presses Save.
//   save              text at once; each product's clip is cut part by part (one ffmpeg per part, nice 19, 2 threads) and joined with the
//                     concat demuxer, one product after another in the background. Never one big filter with many trims: that took the
//                     server's memory on 2026-11-17.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const prisma = require('../db');
const S = require('./service');
const PS = require('./productSales');

const CHUNK = 8 * 1024 * 1024;
const KINDS = ['all', 'single', 'extra', 'company'];
const FORMATS = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
async function nameOf(key) {
  if (key === 'COMPANY') return 'the company video';
  const p = (await PS.products({ all: true })).find((x) => x.key === key);
  return p ? p.name.replace(/^TeamLink\s+/i, '') : key;
}
const MAX_SIZE = 3 * 1024 * 1024 * 1024;
const ACTIVE = ['queued', 'analysing', 'cutting'];
const dirOf = () => { const d = PS.VIDEO_DIR(); fs.mkdirSync(path.join(d, 'sources'), { recursive: true }); return d; };
const srcPath = (job) => path.join(dirOf(), 'sources', `${job.id}${path.extname(job.fileName || '.mp4').toLowerCase() || '.mp4'}`);
const partPath = (job) => `${srcPath(job)}.part`;
const nowIso = () => new Date().toISOString();
const parse = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };
const isManager = (user) => ['admin', 'tl'].includes(S.roleOf(user));

let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      await PS.ensure();
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "CrmVideoJob" ("id" TEXT PRIMARY KEY, "kind" TEXT NOT NULL, "productKey" TEXT, "fileName" TEXT, "size" INTEGER,
        "received" INTEGER NOT NULL DEFAULT 0, "status" TEXT NOT NULL, "step" TEXT, "duration" REAL, "transcript" TEXT, "draft" TEXT, "error" TEXT,
        "createdById" TEXT, "createdByName" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT)`);
      await prisma.$executeRawUnsafe('ALTER TABLE "CrmVideoJob" ADD COLUMN "title" TEXT').catch((e) => { if (!/duplicate column/i.test(e.message)) throw e; });
      await prisma.$executeRawUnsafe('ALTER TABLE "CrmVideoJob" ADD COLUMN "resumes" INTEGER NOT NULL DEFAULT 0').catch((e) => { if (!/duplicate column/i.test(e.message)) throw e; });
      // a restart (a deploy) stops the background work: it starts again by itself, up to 3 times; after that, Retry
      const cut = await prisma.$queryRawUnsafe('SELECT "id", "draft", "resumes" FROM "CrmVideoJob" WHERE "status" IN (\'queued\',\'analysing\',\'cutting\')');
      for (const j of cut) {
        const source = srcPath({ id: j.id, fileName: (await prisma.$queryRawUnsafe('SELECT "fileName" FROM "CrmVideoJob" WHERE "id" = ?', j.id))[0].fileName }); // eslint-disable-line no-await-in-loop
        if (Number(j.resumes) >= 3 || !fs.existsSync(source)) {
          await prisma.$executeRawUnsafe('UPDATE "CrmVideoJob" SET "status" = \'failed\', "error" = \'The server restarted while this was running - press Retry.\' WHERE "id" = ?', j.id); // eslint-disable-line no-await-in-loop
          continue; // eslint-disable-line no-continue
        }
        await prisma.$executeRawUnsafe('UPDATE "CrmVideoJob" SET "status" = \'queued\', "step" = \'Starting again after a server restart\', "resumes" = "resumes" + 1 WHERE "id" = ?', j.id); // eslint-disable-line no-await-in-loop
        const d = parse(j.draft, null);
        queue.push({ id: j.id, task: d && d.apply ? 'cut' : 'analyse' });
      }
      if (queue.length && !running) setImmediate(drain);
      await backfillFullVideo().catch(() => {});
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}
const getJob = async (id) => { await ensure(); const [j] = await prisma.$queryRawUnsafe('SELECT * FROM "CrmVideoJob" WHERE "id" = ?', String(id)); return j || null; };
async function setJob(id, patch) {
  const keys = Object.keys(patch);
  await prisma.$executeRawUnsafe(`UPDATE "CrmVideoJob" SET ${keys.map((k) => `"${k}" = ?`).join(', ')}, "updatedAt" = ? WHERE "id" = ?`, ...keys.map((k) => patch[k]), nowIso(), id);
}
const shapeJob = (j, { full = false } = {}) => (j ? {
  id: j.id, kind: j.kind, productKey: j.productKey, title: j.title, fileName: j.fileName, size: j.size, received: j.received, status: j.status, step: j.step, duration: j.duration,
  error: j.error, createdByName: j.createdByName, createdAt: j.createdAt, updatedAt: j.updatedAt, hasDraft: !!j.draft, usedByCard: !!(FULL_FILE && FULL_FILE === `${j.id}${path.extname(j.fileName || '.mp4').toLowerCase() || '.mp4'}`),
  ...(full ? { draft: parse(j.draft, null), transcript: parse(j.transcript, null), srcUrl: `/api/crm-public/product-video-src/${PS.makeToken('vsrc', j.createdById || 'staff', [], 0.5, j.id)}` } : {}),
} : null);

// ---- running ffmpeg / the speech-to-text quietly -------------------------------------------------------------------------------------
const FFMPEG = () => process.env.FFMPEG_BIN || 'ffmpeg';
function run(bin, args, { timeoutMs = 3 * 3600000, env } = {}) {
  return new Promise((resolve) => {
    const lowPrio = process.platform !== 'win32';
    const p = spawn(lowPrio ? 'nice' : bin, lowPrio ? ['-n', '19', bin, ...args] : args, { stdio: ['ignore', 'pipe', 'pipe'], env: env || process.env });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; if (out.length > 2e6) out = out.slice(-1e6); });
    p.stderr.on('data', (d) => { err += d; if (err.length > 2e5) err = err.slice(-1e5); });
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: `${err}${e.message}` }); });
    p.on('close', (code, signal) => { clearTimeout(t); resolve({ code, signal, out, err }); });
  });
}
async function probe(file) {
  const r = await run(FFMPEG(), ['-hide_banner', '-i', file]);
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(r.err);
  return { duration: m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0, video: /Stream #.*Video:/.test(r.err), audio: /Stream #.*Audio:/.test(r.err) };
}
const STT_PY = `import sys, json, wave
import numpy as np
from faster_whisper import WhisperModel
w = wave.open(sys.argv[1]); a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
m = WhisperModel(sys.argv[3] if len(sys.argv) > 3 else "base.en", device="cpu", compute_type="int8", cpu_threads=2)
segs, info = m.transcribe(a, language="en", vad_filter=True, beam_size=1)
json.dump([{"s": round(s.start, 2), "e": round(s.end, 2), "t": s.text.strip()} for s in segs], open(sys.argv[2], "w"))
`;
async function transcribe(job, file, info) {
  if (process.env.CRM_STT_FAKE_JSON) return parse(fs.readFileSync(process.env.CRM_STT_FAKE_JSON, 'utf8'), []); // the sandbox test
  const py = process.env.CRM_STT_PYTHON || '/opt/ai-agent/venv/bin/python';
  if (!info.audio) return { none: 'The video has no sound, so there is no narration to read.' };
  if (!fs.existsSync(py)) return { none: 'Speech-to-text is not installed on this server.' };
  const wav = `${file}.16k.wav`;
  const json = `${file}.stt.json`;
  const script = path.join(dirOf(), 'stt.py');
  fs.writeFileSync(script, STT_PY);
  try {
    const a = await run(FFMPEG(), ['-v', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-threads', '2', wav]);
    if (a.code !== 0) return { none: `The sound could not be read (${a.err.slice(-200)}).` };
    await setJob(job.id, { step: 'Turning the narration into text' });
    const r = await run(py, [script, wav, json, process.env.CRM_STT_MODEL || 'base.en'], { env: { ...process.env, HF_HOME: process.env.CRM_STT_HF_HOME || '/opt/ai-agent/hf' } });
    if (r.code !== 0 || !fs.existsSync(json)) return { none: `Speech-to-text failed (${r.err.slice(-300)}).` };
    return parse(fs.readFileSync(json, 'utf8'), []);
  } finally { for (const f of [wav, json]) { try { fs.unlinkSync(f); } catch { /* gone */ } } }
}

// ---- which part of the video is which product ----------------------------------------------------------------------------------------
// speech-to-text mishears product names: fix the common ones before reading or writing anything
const FIXES = [[/\b(the )?80s\b|\beighties\b|\ba\.t\.s\.?/gi, 'ATS'], [/\b(a ?me|o ?me|omi|omni) ?-?channel\b|\bomichannel\b|\bomnichannel\b/gi, 'Omni-Channel'], [/\bteam ?link\b/gi, 'TeamLink'],
  [/\bjob (orders|porters?|portals)\b/gi, 'Job Portal'], [/\bEI\b/g, 'AI'], [/\bH\.?R\.?M\.?S\.?\b/gi, 'HRMS'],
  [/\b(vannet|manet) search\b/gi, 'Saved search'], [/\bpunch-lob\b/gi, 'punch log']];
const fix = (t) => FIXES.reduce((s, [re, to]) => s.replace(re, to), String(t || ''));
const BASE_NAMES = [['HRMS', /\bhrms\b/i], ['ATS', /\bats\b/i], ['ATS', /\bjob portal\b/i], ['OMNI', /\bomni-channel\b/i]];
const OTHER_NAMES = ['OTHER', /\b(accounts|crm|admin|administration|control tower)\b/i];
const escRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// a product added later is found by its own name ("TeamLink Accounts" -> "accounts"); its words are its name plus the "other modules" words
const customOf = (catalogue) => (catalogue || []).filter((x) => !['HRMS', 'ATS', 'OMNI'].includes(x.key)).map((x) => {
  const words = String(x.name).replace(/teamlink/ig, '').split(/[^a-z0-9-]+/i).filter((w) => w.length >= 3);
  return words.length ? { key: x.key, re: new RegExp(`\\b(${words.map(escRe).join('|')})\\b`, 'i') } : null;
}).filter(Boolean);
const VOTES = {
  HRMS: /\b(hrms|attendance|biometric|punch\w*|leave|holiday\w*|payroll|pay ?slips?|salar\w+|ctc|incentives?|performance|reward\w*|disciplinary|lms|courses?|help ?desk|assets?|notice board|survey|resignation|relieving|shifts?|timesheets?|time sheets?|expense claims?|regulari[sz]ation|employees?)\b/gi,
  ATS: /\b(ats|candidates?|pipeline|applications?|recruiters?|interviews?|offers?|joining|hiring|talent pool|job portal|job post\w*|requirements?|openings?|shortlist\w*|resumes?|co-?pilot)\b/gi,
  OMNI: /\b(omni-channel|whatsapp|facebook|instagram|sms|rcs|campaigns?|social|marketing|templates?|segments?|bots?|ads|seo|keywords?|search console|ai visibility|content library|ai content|wallet|shopify|reviews?|inbox|reels)\b/gi,
  OTHER: /\b(control tower|accounts|invoices?|gst|tds|reconciliation|ledger|journal|receivables?|revenue|crm|sales|deals?|leads|administration|master lists?|backups?|departments?|positions?|seats?|role catalog|integrations?|organi[sz]ation structure|audit logs?|vendors?|partners?)\b/gi,
};
let CUSTOM = [];
const votesOf = (text) => {
  const v = Object.fromEntries(Object.entries(VOTES).map(([k, re]) => [k, (String(text).match(re) || []).length]));
  CUSTOM.forEach((c) => { v[c.key] = (String(text).match(new RegExp(c.re.source, 'gi')) || []).length * 3 + v.OTHER * 0.5; });
  return v;
};
function openerOf(seg) {
  const t = seg.t.trim();
  if (!/^in\b/i.test(t) && !/\b(opens on|opens with|starts with)\b/i.test(t)) return null;
  const head = t.split(/\s+/).slice(0, 9).join(' ');
  const hit = [...BASE_NAMES, ...CUSTOM.map((c) => [c.key, c.re]), OTHER_NAMES].find(([, re]) => re.test(head));
  return hit ? hit[0] : null;
}
const round1 = (n) => Math.round(n * 10) / 10;
function splitByProduct(segsIn, duration, catalogue) {
  CUSTOM = customOf(catalogue);
  const sold = ['HRMS', 'ATS', 'OMNI', ...CUSTOM.map((c) => c.key)];
  const segs = (segsIn || []).map((x) => ({ s: Number(x.s) || 0, e: Number(x.e) || 0, t: fix(x.t) })).filter((x) => x.e > x.s);
  const notes = [];
  if (!segs.length) return { intro: null, outro: null, products: {}, notes: ['No narration was found: set the parts by hand.'] };
  // the openings, each kept only when the words up to the next opening agree (a sub-part like "In admin" inside Omni-Channel is not a new part)
  const opens = [];
  segs.forEach((x, i) => { const m = openerOf(x); if (m) opens.push({ i, m }); });
  const labels = new Array(segs.length).fill(null);
  let cur = null;
  opens.forEach((o, k) => {
    const end = k + 1 < opens.length ? opens[k + 1].i : segs.length;
    const v = votesOf(segs.slice(o.i, end).map((x) => x.t).join(' '));
    const best = Object.entries(v).sort((a, b) => b[1] - a[1])[0];
    const custom = CUSTOM.some((c) => c.key === o.m);
    const keep = !cur || o.m === cur || (v[o.m] || 0) > (v[cur] || 0) || (custom && (v[o.m] || 0) >= (v[cur] || 0)) || best[0] === o.m;
    if (keep) cur = o.m;
    for (let i = o.i; i < end; i += 1) labels[i] = cur;
  });
  if (!opens.length) {
    // no spoken openings: each sentence by its own words, a run must hold for 2 sentences to count
    let last = null;
    segs.forEach((x, i) => { const v = votesOf(x.t); const best = Object.entries(v).sort((a, b) => b[1] - a[1])[0]; if (best[1] > 0 && (best[0] === last || (i + 1 < segs.length && votesOf(segs[i + 1].t)[best[0]] > 0))) last = best[0]; labels[i] = last; });
    notes.push('The narration does not name the parts, so they were found from the words used: please check them.');
  }
  // the TeamLink intro (the first sentence, when it is short and before any part) and the closing lines (after the last part, no product words)
  const firstLabelled = labels.findIndex((l) => l);
  const intro = firstLabelled !== 0 && segs[0].e <= 15 ? [0, round1(segs[0].e)] : null;
  let k = segs.length - 1;
  while (k > 0 && duration - segs[k].s < 40 && Object.values(votesOf(segs[k].t)).every((n) => n === 0) && !openerOf(segs[k])) { labels[k] = 'END'; k -= 1; }
  const outroStart = labels.indexOf('END');
  const outro = outroStart > 0 ? [round1((segs[outroStart - 1].e + segs[outroStart].s) / 2), round1(duration)] : null;
  // runs of each product: from the middle of the gap before its first sentence to the middle of the gap after its last
  const products = {};
  let i = 0;
  while (i < segs.length) {
    const l = labels[i];
    let j = i;
    while (j + 1 < segs.length && labels[j + 1] === l) j += 1;
    if (sold.includes(l)) {
      const s = i > 0 ? (segs[i - 1].e + segs[i].s) / 2 : 0;
      const e = j + 1 < segs.length ? (segs[j].e + segs[j + 1].s) / 2 : duration;
      if (e - s >= 5) (products[l] = products[l] || { segments: [], text: [] }).segments.push([round1(s), round1(e)]);
      for (let x = i; x <= j; x += 1) (products[l] = products[l] || { segments: [], text: [] }).text.push(segs[x].t);
    }
    i = j + 1;
  }
  (catalogue || []).filter((x) => x.active !== false && !products[x.key]).forEach((x) => notes.push(`${x.name} was not found in this video.`));
  return { intro, outro, products, notes };
}

// ---- the text for a product, from its own narration only ---------------------------------------------------------------------------
function sentencesOf(text) { return String(text).split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 12); }
function plainDraft(name, text) {
  const ss = sentencesOf(text);
  return { tagline: '', about: ss.slice(0, 2).join(' '), features: [...new Set(ss.slice(2, 14))], faq: '', source: 'narration' };
}
async function writeContent(key, text, productName) {
  const name = productName || { HRMS: 'TeamLink HRMS', ATS: 'TeamLink ATS', OMNI: 'TeamLink Omni-Channel' }[key] || key;
  const fb = plainDraft(name, text);
  if (process.env.TEAMLINK_SANDBOX === '1' && !process.env.TEST_ALLOW_AI) return fb;
  try {
    const AI = require('../utils/ai'); // eslint-disable-line global-require
    const out = await AI.chatJson(`You write the product page of ${name} for a sales demo. Use ONLY what the narration of its demo video below says; it comes from speech-to-text, so fix obvious mishearings (product names, words) but add nothing that is not said. Never write a price, a discount, a number of customers or an integration that is not named. Reply ONLY as JSON: {"tagline": "one line, at most 14 words", "about": "2-3 sentences: what it is and who it is for", "features": ["8 to 12 short lines, each one a real screen or ability shown"], "faq": [{"q": "a question a buyer would ask (how something works, who does what)", "a": "1-2 plain sentences from the narration, never a list of screens"}]}`,
      [{ role: 'user', content: `NARRATION OF THE ${name.toUpperCase()} DEMO:\n${String(text).slice(0, 7000)}` }], { maxTokens: 1400, timeoutMs: 6 * 60000 }); // the server's small model on the CPU needs a few minutes for this
    const features = Array.isArray(out && out.features) ? out.features.map((x) => String(x).trim()).filter((x) => x.length > 3).slice(0, 14) : [];
    if (!out || !features.length) return fb;
    const noMoney = (s) => String(s || '').replace(/[^.]*(₹|rs\.?\s?\d|\bper (user|month|employee)\b|discount)[^.]*\.?/gi, '').trim();
    // a question a buyer asks, answered in a sentence or two: never "what features does it offer" with a menu list as the answer
    const faq = (Array.isArray(out.faq) ? out.faq : []).filter((x) => x && x.q && x.a && !PS.listLike(x.a) && !/what features/i.test(x.q)).slice(0, 6).map((x) => `Q: ${noMoney(x.q)}\nA: ${noMoney(x.a)}`).filter((x) => !/\nA: $/.test(x)).join('\n\n');
    return { tagline: noMoney(out.tagline).slice(0, 200), about: noMoney(out.about).slice(0, 1500), features: features.map(noMoney).filter(Boolean), faq, source: 'ai' };
  } catch { return fb; }
}

// ---- the background queue: one job at a time ------------------------------------------------------------------------------------------
const queue = [];
let running = false;
function enqueue(id, task) { queue.push({ id, task }); if (!running) setImmediate(drain); }
async function drain() {
  running = true;
  while (queue.length) {
    const { id, task } = queue.shift();
    try { await (task === 'cut' ? cutJob(id) : analyseJob(id)); } // eslint-disable-line no-await-in-loop
    catch (e) {
      // stopped by a restart: left as it is, so the next start carries on (ensure); anything else is a failure to show
      if (!e.interrupted) await setJob(id, { status: 'failed', error: String(e.message || e).slice(0, 500) }).catch(() => {}); // eslint-disable-line no-await-in-loop
    }
  }
  running = false;
}
async function analyseJob(id) {
  const job = await getJob(id);
  if (!job) return;
  const file = srcPath(job);
  await setJob(id, { status: 'analysing', step: 'Reading the video', error: null });
  const info = await probe(file);
  if (!info.video || !info.duration) { await setJob(id, { status: 'failed', error: 'This file is not a video the server can read.' }); return; }
  await setJob(id, { duration: info.duration, step: 'Taking the sound out' });
  const tr = await transcribe(job, file, info);
  const segs = Array.isArray(tr) ? tr : [];
  await setJob(id, { transcript: JSON.stringify(segs), step: 'Finding each product' });
  let draft;
  const catalogue = await PS.products({ all: true });
  if (job.kind !== 'all') {
    // one video for one thing: the whole of it is the clip (trim it in the draft if needed)
    const text = segs.map((x) => fix(x.t)).join(' ');
    const key = job.kind === 'company' ? 'COMPANY' : job.productKey;
    draft = { duration: info.duration, intro: null, outro: null, target: { kind: job.kind, key, title: job.title || '' }, products: { [key]: { segments: [[0, round1(info.duration)]], narration: text, noText: job.kind !== 'single' } }, notes: tr && tr.none ? [tr.none] : [] };
  } else {
    const sp = splitByProduct(segs, info.duration, catalogue);
    draft = { duration: info.duration, intro: sp.intro, outro: sp.outro, products: {}, notes: [...(tr && tr.none ? [tr.none] : []), ...sp.notes] };
    Object.entries(sp.products).forEach(([k, v]) => { draft.products[k] = { segments: v.segments, narration: v.text.join(' ') }; });
  }
  for (const k of Object.keys(draft.products)) {
    const p = draft.products[k];
    if (p.noText) { Object.assign(p, { tagline: '', about: '', features: [], faq: '', source: 'none' }); continue; } // eslint-disable-line no-continue
    const pr = catalogue.find((x) => x.key === k);
    await setJob(id, { step: `Writing the ${await nameOf(k)} text` }); // eslint-disable-line no-await-in-loop
    Object.assign(p, p.narration ? await writeContent(k, p.narration, pr && pr.name) : { tagline: '', about: '', features: [], faq: '', source: 'none' }); // eslint-disable-line no-await-in-loop
  }
  await setJob(id, { status: 'draft', step: 'Ready to review', draft: JSON.stringify(draft) });
}
async function cutOne(src, parts, out, hasAudio) {
  const tmp = `${out}.parts`;
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const files = [];
    for (let n = 0; n < parts.length; n += 1) {
      const [s, e] = parts[n];
      const d = Math.max(0.5, e - s);
      const fo = Math.max(0, d - 0.35).toFixed(2);
      const f = path.join(tmp, `p${n}.mp4`);
      // eslint-disable-next-line no-await-in-loop
      const r = await run(FFMPEG(), ['-v', 'error', '-y', '-ss', String(s), '-i', src, '-t', d.toFixed(2), '-threads', '2', '-vf', `scale=trunc(iw/2)*2:trunc(ih/2)*2,fade=t=in:st=0:d=0.3,fade=t=out:st=${fo}:d=0.3`,
        ...(hasAudio ? ['-af', `afade=t=in:st=0:d=0.3,afade=t=out:st=${fo}:d=0.35`, '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2'] : ['-an']),
        '-c:v', 'libx264', '-crf', '24', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', '30', f]);
      if (r.code === null) throw Object.assign(new Error(`stopped by ${r.signal || 'a signal'}`), { interrupted: true }); // a deploy stopped it: it starts again after the restart
      if (r.code !== 0) throw new Error(`Cutting ${s}-${e} s failed: ${r.err.slice(-300)}`);
      files.push(f);
    }
    const list = path.join(tmp, 'list.txt');
    fs.writeFileSync(list, files.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    const r = await run(FFMPEG(), ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]);
    if (r.code === null) throw Object.assign(new Error(`stopped by ${r.signal || 'a signal'}`), { interrupted: true });
    if (r.code !== 0) throw new Error(`Joining failed: ${r.err.slice(-300)}`);
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* left */ } }
}
async function cutJob(id) {
  const job = await getJob(id);
  if (!job) return;
  const draft = parse(job.draft, null);
  const plan = (draft && draft.apply) || {};
  const src = srcPath(job);
  const info = await probe(src);
  await setJob(id, { status: 'cutting', error: null });
  const done = [];
  for (const key of Object.keys(plan).filter((k) => plan[k].video)) {
    const p = draft.products[key];
    const parts = [...(draft.intro ? [draft.intro] : []), ...p.segments, ...(draft.outro ? [draft.outro] : [])];
    await setJob(id, { step: `Making the ${await nameOf(key)} clip (${parts.length} part${parts.length > 1 ? 's' : ''})` }); // eslint-disable-line no-await-in-loop
    const kind = (draft.target && draft.target.kind) || job.kind;
    const name = `${key}-${kind === 'extra' ? 'X' : ''}${id.slice(-8)}.mp4`;
    await cutOne(src, parts, path.join(dirOf(), name), info.audio); // eslint-disable-line no-await-in-loop
    const title = (draft.target && draft.target.title) || job.title || '';
    if (kind === 'company') await require('./productDeals').setCompanyVideo(name, title || 'About TeamLink'); // eslint-disable-line global-require, no-await-in-loop
    else if (kind === 'extra') await PS.addExtraVideo(key, name, title || job.fileName); // eslint-disable-line no-await-in-loop
    else await PS.setVideoFile(key, name); // eslint-disable-line no-await-in-loop
    done.push(await nameOf(key)); // eslint-disable-line no-await-in-loop
  }
  await setJob(id, { status: 'done', step: done.length ? `Live: ${done.join(', ')}` : 'Text saved' });
  cleanup().catch(() => {});
}
// keep the last 3 uploaded originals; older ones (and their unfinished pieces) are removed - never the one the full-video card plays
async function cleanup() {
  const rows = await prisma.$queryRawUnsafe('SELECT * FROM "CrmVideoJob" ORDER BY "createdAt" DESC');
  const fv = (await PD().settings()).fullVideo;
  rows.slice(3).forEach((j) => {
    if (ACTIVE.includes(j.status)) return;
    if (!(fv && fv.file === path.basename(srcPath(j)))) { try { fs.unlinkSync(srcPath(j)); } catch { /* gone */ } }
    try { fs.unlinkSync(partPath(j)); } catch { /* gone */ }
  });
}
// ---- THE FULL ALL-PRODUCTS VIDEO CARD (founder 2026-11-17 "add 4th card"): the original of the last all-products upload saved, played whole -----
const PD = () => require('./productDeals'); // eslint-disable-line global-require
const fullPathOf = (fv) => (fv && fv.file ? path.join(dirOf(), 'sources', path.basename(fv.file)) : null);
function oneLineOf(job) {
  const segs = parse(job.transcript, []);
  const first = segs.length ? fix(segs[0].t) : '';
  const mins = Math.round((Number(job.duration) || 0) / 60);
  return `${first || 'Every TeamLink product, module by module, on the real application.'}${mins ? ` (${mins} min)` : ''}`.slice(0, 300);
}
async function pointFullVideoAt(job) {
  const file = path.basename(srcPath(job));
  if (!fs.existsSync(path.join(dirOf(), 'sources', file))) return null;
  return PD().setFullVideo({ jobId: job.id, file, title: 'TeamLink — all products (full demo)', description: oneLineOf(job), duration: Number(job.duration) || null });
}
// a catalogue that had an all-products upload saved before this card existed gets it once
async function backfillFullVideo() {
  if ((await PD().settings()).fullVideo) return;
  const [j] = await prisma.$queryRawUnsafe('SELECT * FROM "CrmVideoJob" WHERE "kind" = \'all\' AND "status" = \'done\' ORDER BY "updatedAt" DESC LIMIT 1');
  if (j) await pointFullVideoAt(j);
}
async function fullVideoFile() {
  const fv = (await PD().settings()).fullVideo;
  const f = fullPathOf(fv);
  return f && fs.existsSync(f) ? { file: f, fv } : null;
}

// ---- what the screen calls ----------------------------------------------------------------------------------------------------------------
async function startUpload(user, body = {}) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin can upload product videos.');
  await ensure();
  const kind = KINDS.includes(body.kind) ? body.kind : 'all';
  const key = String(body.key || '').toUpperCase();
  if (['single', 'extra'].includes(kind) && !(await PS.productKeys()).includes(key)) return S.fail(400, 'Which product is this video for?');
  const name = String(body.name || 'video.mp4').slice(0, 200);
  if (!FORMATS.test(name)) return S.fail(400, 'Upload an MP4, MOV, M4V, WebM, MKV or AVI video.');
  const size = Math.round(Number(body.size) || 0);
  if (size <= 0) return S.fail(400, 'This file is empty.');
  if (size > MAX_SIZE) return S.fail(400, `This video is ${(size / 1073741824).toFixed(1)} GB. The limit is 3 GB: export it smaller (1080p, H.264) and upload again.`);
  try {
    const st = fs.statfsSync(dirOf());
    if (st.bavail * st.bsize < size * 2.5 + 500 * 1048576) return S.fail(507, 'The server does not have enough free space for this video right now. Remove old uploads below, or ask the developer to free space.');
  } catch { /* cannot tell: carry on */ }
  const title = String(body.title || '').trim().slice(0, 120) || (kind === 'company' ? 'About TeamLink' : kind === 'extra' ? name.replace(/\.[a-z0-9]+$/i, '') : '');
  const busy = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "CrmVideoJob" WHERE "status" IN (\'uploading\',\'queued\',\'analysing\',\'cutting\') AND "updatedAt" > ?', new Date(Date.now() - 30 * 60000).toISOString());
  if (Number(busy[0].n) >= 2) return S.fail(409, 'Two videos are being worked on already. Please wait for one to finish.');
  const id = S.newId('vid');
  const now = nowIso();
  await prisma.$executeRawUnsafe('INSERT INTO "CrmVideoJob" ("id","kind","productKey","title","fileName","size","received","status","step","createdById","createdByName","createdAt","updatedAt") VALUES (?,?,?,?,?,?,0,\'uploading\',\'Uploading\',?,?,?,?)',
    id, kind, ['single', 'extra'].includes(kind) ? key : null, title || null, name, size, user.id, user.name || null, now, now);
  fs.writeFileSync(partPath({ id, fileName: name }), '');
  return S.okBody({ ok: true, id, chunkSize: CHUNK });
}
async function putChunk(user, id, offset, buf) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin can upload product videos.');
  const job = await getJob(id);
  if (!job || job.status !== 'uploading') return S.fail(404, 'This upload is not open any more.');
  const part = partPath(job);
  const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (Number(offset) !== have) return S.fail(409, 'The pieces came out of order.', { received: have });
  if (!buf || !buf.length) return S.fail(400, 'This piece is empty.');
  if (have + buf.length > job.size) return S.fail(400, 'More data than the file size.');
  fs.appendFileSync(part, buf);
  const got = have + buf.length;
  await setJob(id, { received: got, step: `Uploading ${Math.floor((got / job.size) * 100)}%` });
  return S.okBody({ ok: true, received: got });
}
async function finishUpload(user, id) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin can upload product videos.');
  const job = await getJob(id);
  if (!job || job.status !== 'uploading') return S.fail(404, 'This upload is not open any more.');
  const part = partPath(job);
  const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (have !== job.size) return S.fail(400, `The upload is not complete (${have} of ${job.size} bytes).`, { received: have });
  fs.renameSync(part, srcPath(job));
  await setJob(id, { status: 'queued', step: 'Waiting to be read' });
  await S.audit(user, 'CRM product video uploaded', 'CrmVideoJob', id, `${job.fileName} (${job.kind === 'single' ? job.productKey : 'all products'})`);
  enqueue(id, 'analyse');
  return S.okBody({ ok: true, job: shapeJob(await getJob(id)) });
}
let FULL_FILE = null; // the file the full-video card plays, for the uploads list ("used by the full-video card")
async function jobs(user) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin can see this.');
  await ensure();
  FULL_FILE = ((await PD().settings()).fullVideo || {}).file || null;
  const rows = await prisma.$queryRawUnsafe('SELECT * FROM "CrmVideoJob" ORDER BY "createdAt" DESC LIMIT 8');
  return S.okBody({ jobs: rows.map((j) => shapeJob(j)) });
}
async function jobDetail(user, id) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin can see this.');
  const j = await getJob(id);
  return j ? S.okBody({ job: shapeJob(j, { full: true }) }) : S.fail(404, 'No such upload.');
}
const num = (v) => { if (typeof v === 'number') return v; const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(String(v || '').trim()); return m ? Number(m[1] || 0) * 60 + Number(m[2]) : NaN; };
function cleanRange(r, dur) {
  if (!Array.isArray(r) || r.length !== 2) return null;
  const s = num(r[0]); const e = num(r[1]);
  if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e <= s || e > dur + 0.5) return 'bad';
  return [round1(s), round1(Math.min(e, dur))];
}
async function applyDraft(user, id, body = {}) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin can change the products.');
  const job = await getJob(id);
  if (!job || !['draft', 'done', 'failed'].includes(job.status) || !job.draft) return S.fail(400, 'There is no draft to save on this upload.');
  const old = parse(job.draft, {});
  const dur = Number(job.duration) || old.duration || 0;
  const inD = body.draft || {};
  const intro = inD.intro == null || inD.intro === '' ? null : cleanRange(inD.intro, dur);
  const outro = inD.outro == null || inD.outro === '' ? null : cleanRange(inD.outro, dur);
  if (intro === 'bad' || outro === 'bad') return S.fail(400, 'The intro or the closing part has a wrong time (start must be before the end, inside the video).');
  const use = body.use || {};
  const products = {};
  const allowed = job.kind === 'company' ? ['COMPANY'] : await PS.productKeys();
  for (const key of Object.keys(inD.products || {}).filter((k) => allowed.includes(k))) {
    const p = (inD.products || {})[key];
    const u = use[key] || {};
    if (!p || (!u.video && !u.text)) continue; // eslint-disable-line no-continue
    const segs = (Array.isArray(p.segments) ? p.segments : []).map((r) => cleanRange(r, dur));
    if (u.video && (!segs.length || segs.includes('bad') || segs.includes(null))) return S.fail(400, `Check the ${await nameOf(key)} parts: each needs a start before its end, inside the video.`);
    if (u.video && segs.reduce((s, r) => s + (r[1] - r[0]), 0) < 3) return S.fail(400, `The ${await nameOf(key)} clip would be shorter than 3 seconds.`);
    if (['extra', 'company'].includes(job.kind)) u.text = false; // a second video or the company video never rewrites a product's text
    products[key] = { ...(old.products || {})[key], segments: segs.filter((r) => Array.isArray(r)), tagline: String(p.tagline || '').slice(0, 300), about: String(p.about || '').slice(0, 4000),
      features: (Array.isArray(p.features) ? p.features : String(p.features || '').split('\n')).map((x) => String(x).trim()).filter(Boolean).slice(0, 30), faq: String(p.faq || '').slice(0, 8000), use: { video: !!u.video, text: !!u.text } };
  }
  if (!Object.keys(products).length) return S.fail(400, 'Tick "Use the video" or "Use the text" for at least one product.');
  // the text goes live at once (through the same rules as editing a product by hand)
  for (const [key, p] of Object.entries(products)) {
    if (!p.use.text) continue; // eslint-disable-line no-continue
    // the new Q&A is added to the written one (never replacing what the managers wrote); prices are never touched here
    const cur = (await PS.products({ all: true })).find((x) => x.key === key) || {}; // eslint-disable-line no-await-in-loop
    const faq = p.faq && !String(cur.faq || '').includes(p.faq.trim()) ? [cur.faq, p.faq.trim()].filter(Boolean).join('\n\n') : '';
    const patch = { ...(p.tagline ? { tagline: p.tagline } : {}), ...(p.about ? { about: p.about } : {}), ...(p.features.length ? { features: p.features } : {}), ...(faq ? { faq } : {}) };
    if (Object.keys(patch).length) { const r = await PS.saveProduct(user, key, patch); if (r.status !== 200) return r; } // eslint-disable-line no-await-in-loop
  }
  const apply = Object.fromEntries(Object.entries(products).map(([k, p]) => [k, p.use]));
  if (inD.title != null && old.target) old.target.title = String(inD.title).slice(0, 120);
  const draft = { ...old, intro, outro, products: { ...(old.products || {}), ...products }, apply };
  const anyVideo = Object.values(apply).some((x) => x.video);
  await setJob(id, { draft: JSON.stringify(draft), status: anyVideo ? 'queued' : 'done', step: anyVideo ? 'Waiting to cut the clips' : 'Text saved', error: null });
  await S.audit(user, 'CRM product video draft saved', 'CrmVideoJob', id, Object.entries(apply).map(([k, a]) => `${k}:${a.video ? 'video' : ''}${a.text ? '+text' : ''}`).join(' '));
  if (anyVideo) enqueue(id, 'cut');
  // a newer all-products video saved: the full-video card plays it from now on
  if (job.kind === 'all') await pointFullVideoAt(job).catch(() => null);
  return S.okBody({ ok: true, job: shapeJob(await getJob(id)) });
}
async function retry(user, id) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin can do this.');
  const job = await getJob(id);
  if (!job || job.status !== 'failed') return S.fail(400, 'Only a failed step can be tried again.');
  if (!fs.existsSync(srcPath(job))) return S.fail(400, 'The uploaded video is not on the server any more. Please upload it again.');
  const d = parse(job.draft, null);
  await setJob(id, { status: 'queued', step: 'Waiting', error: null });
  enqueue(id, d && d.apply ? 'cut' : 'analyse');
  return S.okBody({ ok: true });
}
async function remove(user, id, { removeCard = false } = {}) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin can do this.');
  const job = await getJob(id);
  if (!job) return S.fail(404, 'No such upload.');
  if (ACTIVE.includes(job.status)) return S.fail(400, 'This is being worked on - wait for it to finish.');
  // the full-video card plays this upload's original: removed with it only when the manager says so; else the file stays for the card
  const fv = (await PD().settings()).fullVideo;
  const forCard = !!(fv && fv.file === path.basename(srcPath(job)));
  if (forCard && removeCard) await PD().setFullVideo(null);
  if (!forCard || removeCard) { try { fs.unlinkSync(srcPath(job)); } catch { /* gone */ } }
  try { fs.unlinkSync(partPath(job)); } catch { /* gone */ }
  await prisma.$executeRawUnsafe('DELETE FROM "CrmVideoJob" WHERE "id" = ?', id);
  return S.okBody({ ok: true });
}
async function sourceFile(token) {
  const v = PS.readToken(token, 'vsrc');
  if (!v || !v.x) return null;
  const j = await getJob(v.x);
  const f = j && srcPath(j);
  return f && fs.existsSync(f) ? f : null;
}

module.exports = { ensure, CHUNK, fullVideoFile, backfillFullVideo, startUpload, putChunk, finishUpload, jobs, jobDetail, applyDraft, retry, remove, sourceFile, splitByProduct, fix, drain: () => (running ? new Promise((r) => { const t = setInterval(() => { if (!running) { clearInterval(t); r(); } }, 200); }) : Promise.resolve()) };

// after a restart, an interrupted video job carries on without waiting for someone to open the page (not in the sandbox tests)
if (!process.env.TEST_MODE) setTimeout(() => ensure().catch(() => {}), 15000).unref();
