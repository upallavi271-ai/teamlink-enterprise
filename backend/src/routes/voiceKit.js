// ---------------------------------------------------------------------------
// THE VOICE RECORDING KIT (founder 2026-11-11: "One AI Caller = One Consistent Voice Identity across all 3 languages").
// The speaker reads each line (calling/voiceKitSentences.js) on Administration -> AI Voice Recording; every take is kept as a WAV
// (22050 Hz, mono, 16-bit - what a Piper voice is trained on) and exported per language in the LJSpeech layout the training uses:
// wavs/<id>.wav and metadata.csv ("id|text"). Super Admin / Admin only. The live AI calls are not touched by any of this.
//
//   GET  /api/voice-kit/lines?lang=&gender=   the lines, each with its take (if any)
//   PUT  /api/voice-kit/take?lang=&id=&gender=   body: the WAV - saves / replaces the take of a line
//   GET  /api/voice-kit/take?lang=&id=&gender=   the WAV back (to listen)
//   DELETE /api/voice-kit/take?lang=&id=&gender=
//   GET  /api/voice-kit/progress               minutes and lines done per language
//   GET  /api/voice-kit/export?lang=&gender=   a ZIP for training
// ---------------------------------------------------------------------------
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const K = require('../calling/voiceKitSentences');

const router = express.Router();
router.use(requireAuth);
const isAdmin = (u) => !!u && ['SUPER_ADMIN', 'ADMIN'].includes(u.role);
router.use((req, res, next) => (isAdmin(req.user) ? next() : res.status(403).json({ error: 'The voice recording kit is for an Admin or Super Admin.' })));

const RATE = 22050;
const DIR = path.join(process.env.UPLOAD_DIR || path.join(os.homedir() || os.tmpdir(), '.teamlink-uploads'), 'voice-kit');
const GENDERS = ['female', 'male'];
let ready = null;
function table() {
  if (!ready) {
    ready = prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "VoiceKitTake" (
      "key" TEXT PRIMARY KEY, "lang" TEXT NOT NULL, "gender" TEXT NOT NULL, "lineId" TEXT NOT NULL, "text" TEXT NOT NULL,
      "file" TEXT NOT NULL, "durationMs" INTEGER NOT NULL, "peak" REAL, "rms" REAL, "byName" TEXT, "createdAt" TEXT NOT NULL)`).catch((e) => { ready = null; throw e; });
  }
  return ready;
}
const pick = (q) => {
  const lang = K.LANGS.includes(q.lang) ? q.lang : null;
  const gender = GENDERS.includes(q.gender) ? q.gender : 'female';
  return { lang, gender };
};
const fileOf = (lang, gender, id) => path.join(DIR, `${lang.toLowerCase()}-${gender}`, `${id.replace(/[^a-z0-9-]/gi, '')}.wav`);

// a WAV the kit made: RIFF/WAVE, PCM 16-bit, mono, 22050 Hz; -> { ms, peak, rms }
function readWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12; let fmt = null; let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4); const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === 'data') { data = buf.subarray(off + 8, Math.min(buf.length, off + 8 + size)); break; }
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data || fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== RATE || fmt.bits !== 16) return null;
  const n = Math.floor(data.length / 2); let peak = 0; let sum = 0;
  for (let i = 0; i < n; i += 1) { const v = Math.abs(data.readInt16LE(i * 2)) / 32768; if (v > peak) peak = v; sum += v * v; }
  return { ms: Math.round((n / RATE) * 1000), peak: Math.round(peak * 1000) / 1000, rms: n ? Math.round(Math.sqrt(sum / n) * 10000) / 10000 : 0 };
}

router.get('/lines', async (req, res) => {
  const { lang, gender } = pick(req.query);
  if (!lang) return res.status(400).json({ error: 'Pick English, Telugu or Hindi.' });
  await table();
  const takes = await prisma.$queryRawUnsafe('SELECT "lineId", "durationMs", "peak", "rms", "createdAt" FROM "VoiceKitTake" WHERE "lang" = ? AND "gender" = ?', lang, gender);
  const byId = new Map(takes.map((t) => [t.lineId, t]));
  const lines = K.sentencesFor(lang, gender).map((l, i) => ({ ...l, n: i + 1, take: byId.get(l.id) ? { ms: Number(byId.get(l.id).durationMs), peak: byId.get(l.id).peak, rms: byId.get(l.id).rms, at: byId.get(l.id).createdAt } : null }));
  return res.json({ lang, gender, lines, rate: RATE });
});

router.put('/take', express.raw({ type: () => true, limit: '6mb' }), async (req, res) => {
  const { lang, gender } = pick(req.query);
  const line = lang ? K.sentencesFor(lang, gender).find((l) => l.id === String(req.query.id || '')) : null;
  if (!line) return res.status(400).json({ error: 'That line is not in the kit.' });
  const w = readWav(req.body);
  if (!w) return res.status(400).json({ error: 'The recording must be a 22050 Hz mono WAV made by the kit.' });
  if (w.ms < 500 || w.ms > 30000) return res.status(400).json({ error: 'The recording must be between half a second and 30 seconds.' });
  await table();
  const file = fileOf(lang, gender, line.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, req.body);
  await prisma.$executeRawUnsafe(`INSERT OR REPLACE INTO "VoiceKitTake" ("key","lang","gender","lineId","text","file","durationMs","peak","rms","byName","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    `${lang}|${gender}|${line.id}`, lang, gender, line.id, line.text, file, w.ms, w.peak, w.rms, (req.user && req.user.name) || null, new Date().toISOString());
  return res.json({ ok: true, take: { ms: w.ms, peak: w.peak, rms: w.rms } });
});

router.get('/take', async (req, res) => {
  const { lang, gender } = pick(req.query);
  if (!lang) return res.status(400).json({ error: 'Pick English, Telugu or Hindi.' });
  const file = fileOf(lang, gender, String(req.query.id || ''));
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not recorded yet.' });
  res.set('Content-Type', 'audio/wav'); res.set('Cache-Control', 'no-store');
  return fs.createReadStream(file).pipe(res);
});

router.delete('/take', async (req, res) => {
  const { lang, gender } = pick(req.query);
  if (!lang) return res.status(400).json({ error: 'Pick English, Telugu or Hindi.' });
  await table();
  const id = String(req.query.id || '');
  try { fs.unlinkSync(fileOf(lang, gender, id)); } catch { /* already gone */ }
  await prisma.$executeRawUnsafe('DELETE FROM "VoiceKitTake" WHERE "key" = ?', `${lang}|${gender}|${id}`);
  return res.json({ ok: true });
});

router.get('/progress', async (req, res) => {
  await table();
  const rows = await prisma.$queryRawUnsafe('SELECT "lang", "gender", COUNT(*) AS n, SUM("durationMs") AS ms FROM "VoiceKitTake" GROUP BY "lang", "gender"');
  const out = {};
  K.LANGS.forEach((l) => GENDERS.forEach((g) => {
    const r = rows.find((x) => x.lang === l && x.gender === g);
    out[`${l}|${g}`] = { lang: l, gender: g, lines: K.sentencesFor(l, g).length, done: r ? Number(r.n) : 0, minutes: r ? Math.round((Number(r.ms) / 60000) * 10) / 10 : 0 };
  }));
  return res.json({ progress: Object.values(out), goalMinutes: 25 });
});

const README = (lang, gender, n, minutes) => `TeamLink AI voice - ${lang} (${gender} speaker)
${n} recordings, ${minutes} minutes. Made on ${new Date().toISOString().slice(0, 10)}.

Layout: LJSpeech - wavs/<id>.wav (22050 Hz, mono, 16-bit) and metadata.csv (id|text, UTF-8).

Training a Piper voice from this (the plan: one speaker, the same person in English, Telugu and Hindi):
  1. Start from a Piper checkpoint of the same language (English, Telugu, Hindi - medium quality) and fine-tune; do not train from zero.
  2. On a GPU (Google Colab works when a free GPU is given): pip install piper-train, then
       python -m piper_train.preprocess --language <en-us|te|hi> --input-dir <this folder> --output-dir work --dataset-format ljspeech --single-speaker --sample-rate 22050
       python -m piper_train --dataset-dir work --accelerator gpu --devices 1 --batch-size 16 --validation-split 0.0 --num-test-examples 0 --max_epochs <checkpoint epochs + 1000> --resume_from_checkpoint <checkpoint.ckpt> --checkpoint-epochs 1 --precision 32 --quality medium
       python -m piper_train.export_onnx <last.ckpt> ${lang.toLowerCase()}.onnx  (and copy the checkpoint's .onnx.json next to it)
  3. Before it goes live: native speakers listen to the three voices side by side; the voice goes in behind a setting (AI_VOICE_PIPER_${lang.toUpperCase()}) only after that.
Licence: the recordings belong to TeamLink and the speaker who agreed to record them; check the base checkpoint's licence before commercial use.
`;

router.get('/export', async (req, res) => {
  const { lang, gender } = pick(req.query);
  if (!lang) return res.status(400).json({ error: 'Pick English, Telugu or Hindi.' });
  await table();
  const takes = await prisma.$queryRawUnsafe('SELECT "lineId", "text", "file", "durationMs" FROM "VoiceKitTake" WHERE "lang" = ? AND "gender" = ? ORDER BY "createdAt"', lang, gender);
  const have = takes.filter((t) => fs.existsSync(t.file));
  if (!have.length) return res.status(404).json({ error: 'Nothing recorded yet in this language.' });
  const archiver = require('archiver'); // eslint-disable-line global-require
  const name = `teamlink-voice-${lang.toLowerCase()}-${gender}-${new Date().toISOString().slice(0, 10)}.zip`;
  res.set('Content-Type', 'application/zip'); res.set('Content-Disposition', `attachment; filename="${name}"`);
  const zip = archiver('zip', { zlib: { level: 1 } });
  zip.on('error', () => { try { res.end(); } catch { /* closed */ } });
  zip.pipe(res);
  const minutes = Math.round((have.reduce((s, t) => s + Number(t.durationMs), 0) / 60000) * 10) / 10;
  zip.append(have.map((t) => `${t.lineId}|${String(t.text).replace(/[|\r\n]+/g, ' ')}`).join('\n') + '\n', { name: 'metadata.csv' });
  zip.append(README(lang, gender, have.length, minutes), { name: 'README.txt' });
  have.forEach((t) => zip.file(t.file, { name: `wavs/${t.lineId}.wav` }));
  await require('../utils/audit').logAudit({ userId: req.user.id, actorName: req.user.name, action: 'AI voice recordings exported', entity: 'System', toValue: `${lang} (${gender}): ${have.length} recordings, ${minutes} min` }).catch(() => {}); // eslint-disable-line global-require
  return zip.finalize();
});

module.exports = router;
