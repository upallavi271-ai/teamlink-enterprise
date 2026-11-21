// ---------------------------------------------------------------------------
// MARKET WAVE, builder C (founder 2026-11-21: "the whole ATS must be 90 to 99 percent complete compared with the market").
// The shared pieces of the Interviews / Communication / Job Portal additions:
//   ensure()          every raw-SQL table of this wave (self-provisioned, never a Prisma migration)
//   settings()        ONE AppSetting row 'ats.market.settings': the Admin switches (all OFF until the founder turns them on),
//                     the careers-site page, the calendar app keys (secrets encrypted)
//   q / x             raw query / execute
//   sign / verify     short HMAC tokens for the public links (self-booking, tests, tracking, alerts)
//   maskPii(text)     what may go to an AI model: no email, phone, long numbers, links
//   aiJson / aiText   utils/fastAi.js at low temperature with a code fallback (the model is never needed for a feature to work)
//   transcribe(buf)   the app's own speech engines (calling/voice: Whisper / VEXYL-STT) when this server has them; else a plain
//                     "paste the transcript" answer
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../../db');

const q = (sql, ...a) => prisma.$queryRawUnsafe(sql, ...a);
const x = (sql, ...a) => prisma.$executeRawUnsafe(sql, ...a);
const nowIso = () => new Date().toISOString();
const newId = () => crypto.randomBytes(12).toString('hex');
const isSandbox = () => require('../sandbox').isSandbox(); // eslint-disable-line global-require
const who = (u) => (u && (u.name || u.email)) || 'System';
const json = (v, d) => { if (v == null || v === '') return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const txt = (v, max = 500) => String(v == null ? '' : v).replace(/\u0000/g, '').trim().slice(0, max);

const DDL = [
  // 07.09 interview kits per job and round, and each interviewer's scorecard
  `CREATE TABLE IF NOT EXISTS "MktKit" ("id" TEXT PRIMARY KEY, "requirementId" TEXT NOT NULL, "round" INTEGER NOT NULL, "roundType" TEXT, "title" TEXT, "questions" TEXT NOT NULL, "scale" INTEGER NOT NULL DEFAULT 5, "guide" TEXT, "updatedAt" TEXT NOT NULL, "updatedBy" TEXT)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "MktKit_req_round" ON "MktKit" ("requirementId","round")',
  `CREATE TABLE IF NOT EXISTS "MktScore" ("id" TEXT PRIMARY KEY, "applicationId" TEXT NOT NULL, "round" INTEGER NOT NULL, "userId" TEXT NOT NULL, "userName" TEXT, "answers" TEXT NOT NULL, "overall" REAL, "recommendation" TEXT, "summary" TEXT, "via" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "MktScore_app_round_user" ON "MktScore" ("applicationId","round","userId")',
  // 07.07 / 07.11 / 07.13 recordings (file, link or a voice note), their transcript and AI notes; reviewers' comments
  `CREATE TABLE IF NOT EXISTS "MktRecording" ("id" TEXT PRIMARY KEY, "applicationId" TEXT NOT NULL, "round" INTEGER NOT NULL DEFAULT 1, "kind" TEXT NOT NULL, "title" TEXT, "fileStored" TEXT, "fileName" TEXT, "fileMime" TEXT, "fileSize" INTEGER, "url" TEXT, "transcript" TEXT, "transcriptSource" TEXT, "notes" TEXT, "createdBy" TEXT, "createdById" TEXT, "createdAt" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "MktRecording_app" ON "MktRecording" ("applicationId")',
  `CREATE TABLE IF NOT EXISTS "MktReview" ("id" TEXT PRIMARY KEY, "recordingId" TEXT NOT NULL, "userId" TEXT, "userName" TEXT, "atSec" INTEGER, "comment" TEXT NOT NULL, "rating" INTEGER, "createdAt" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "MktReview_rec" ON "MktReview" ("recordingId")',
  // 07.03 candidate self-scheduling links; 07.01 calendar feed tokens and the per-user calendar connection
  `CREATE TABLE IF NOT EXISTS "MktSelfBook" ("token" TEXT PRIMARY KEY, "applicationId" TEXT NOT NULL, "round" INTEGER NOT NULL DEFAULT 1, "slots" TEXT NOT NULL, "minutes" INTEGER NOT NULL DEFAULT 45, "mode" TEXT, "status" TEXT NOT NULL DEFAULT 'open', "pickedSlot" TEXT, "pickedAt" TEXT, "createdBy" TEXT, "createdById" TEXT, "createdAt" TEXT NOT NULL, "expiresAt" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "MktSelfBook_app" ON "MktSelfBook" ("applicationId")',
  `CREATE TABLE IF NOT EXISTS "MktCalToken" ("userId" TEXT PRIMARY KEY, "token" TEXT NOT NULL UNIQUE, "createdAt" TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS "MktCalLink" ("userId" TEXT NOT NULL, "provider" TEXT NOT NULL, "account" TEXT, "refreshEnc" TEXT, "state" TEXT, "connectedAt" TEXT, "lastPushAt" TEXT, "lastError" TEXT, PRIMARY KEY ("userId","provider"))`,
  `CREATE TABLE IF NOT EXISTS "MktCalPush" ("applicationId" TEXT NOT NULL, "round" INTEGER NOT NULL, "userId" TEXT NOT NULL, "provider" TEXT NOT NULL, "eventId" TEXT, "pushedAt" TEXT, PRIMARY KEY ("applicationId","round","userId","provider"))`,
  // 07.15 / 07.16 assessments and the links sent to candidates
  `CREATE TABLE IF NOT EXISTS "MktAssessment" ("id" TEXT PRIMARY KEY, "requirementId" TEXT NOT NULL, "title" TEXT NOT NULL, "questions" TEXT NOT NULL, "passMark" INTEGER NOT NULL DEFAULT 60, "minutes" INTEGER NOT NULL DEFAULT 30, "source" TEXT NOT NULL DEFAULT 'manual', "active" INTEGER NOT NULL DEFAULT 1, "createdBy" TEXT, "createdById" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "MktAssessment_req" ON "MktAssessment" ("requirementId")',
  `CREATE TABLE IF NOT EXISTS "MktAssessSend" ("token" TEXT PRIMARY KEY, "assessmentId" TEXT NOT NULL, "applicationId" TEXT NOT NULL, "candidateId" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'sent', "answers" TEXT, "score" REAL, "maxScore" REAL, "percent" REAL, "review" TEXT, "startedAt" TEXT, "submittedAt" TEXT, "createdBy" TEXT, "createdById" TEXT, "createdAt" TEXT NOT NULL, "expiresAt" TEXT NOT NULL, "messageOutcome" TEXT)`,
  'CREATE INDEX IF NOT EXISTS "MktAssessSend_app" ON "MktAssessSend" ("applicationId")',
  // 08.04 email open / click tracking of candidate emails TeamLink sends
  `CREATE TABLE IF NOT EXISTS "MktEmailTrack" ("token" TEXT PRIMARY KEY, "candidateId" TEXT, "toAddress" TEXT, "subject" TEXT, "links" TEXT, "sentAt" TEXT NOT NULL, "openCount" INTEGER NOT NULL DEFAULT 0, "firstOpenAt" TEXT, "lastOpenAt" TEXT, "clickCount" INTEGER NOT NULL DEFAULT 0, "firstClickAt" TEXT, "lastClickAt" TEXT)`,
  'CREATE INDEX IF NOT EXISTS "MktEmailTrack_cand" ON "MktEmailTrack" ("candidateId")',
  // 08.05 / 08.06 multi-step candidate sequences (message steps through the message-schedule engine, LinkedIn / phone steps as tasks)
  `CREATE TABLE IF NOT EXISTS "MktSeq" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "steps" TEXT NOT NULL, "active" INTEGER NOT NULL DEFAULT 1, "createdBy" TEXT, "createdById" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS "MktSeqRun" ("id" TEXT PRIMARY KEY, "sequenceId" TEXT NOT NULL, "candidateId" TEXT NOT NULL, "applicationId" TEXT, "status" TEXT NOT NULL, "steps" TEXT NOT NULL, "startedAt" TEXT NOT NULL, "stoppedAt" TEXT, "stopReason" TEXT, "createdBy" TEXT, "createdById" TEXT)`,
  'CREATE INDEX IF NOT EXISTS "MktSeqRun_cand" ON "MktSeqRun" ("candidateId")',
  // 08.10 call transcripts -> field suggestions the recruiter accepts
  `CREATE TABLE IF NOT EXISTS "MktCallNote" ("id" TEXT PRIMARY KEY, "candidateId" TEXT NOT NULL, "applicationId" TEXT, "transcript" TEXT, "transcriptSource" TEXT, "fileStored" TEXT, "suggestions" TEXT NOT NULL, "summary" TEXT, "createdBy" TEXT, "createdById" TEXT, "createdAt" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "MktCallNote_cand" ON "MktCallNote" ("candidateId")',
  // 08.01 a person's own mailbox (IMAP in, SMTP out)
  `CREATE TABLE IF NOT EXISTS "MktMailbox" ("userId" TEXT PRIMARY KEY, "address" TEXT NOT NULL, "imapHost" TEXT, "imapPort" INTEGER, "smtpHost" TEXT, "smtpPort" INTEGER, "username" TEXT, "secretEnc" TEXT, "status" TEXT NOT NULL DEFAULT 'saved', "checkpoint" INTEGER, "lastCheckAt" TEXT, "lastError" TEXT, "updatedAt" TEXT NOT NULL)`,
  // 10.03 / 07.03 per-job settings: the extra apply-form fields, LinkedIn apply, self-scheduling; the answers given
  `CREATE TABLE IF NOT EXISTS "MktJobForm" ("requirementId" TEXT PRIMARY KEY, "fields" TEXT NOT NULL DEFAULT '[]', "linkedinApply" INTEGER NOT NULL DEFAULT 1, "selfBook" INTEGER NOT NULL DEFAULT 0, "updatedAt" TEXT NOT NULL, "updatedBy" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "MktFormAnswer" ("applicationId" TEXT PRIMARY KEY, "requirementId" TEXT, "answers" TEXT NOT NULL, "createdAt" TEXT NOT NULL)`,
  // 10.10 / 10.11 profile links (LinkedIn) of a candidate: the de-duplication key of the extension and of "apply with LinkedIn"
  `CREATE TABLE IF NOT EXISTS "MktCandLink" ("candidateId" TEXT NOT NULL, "kind" TEXT NOT NULL, "url" TEXT NOT NULL, "createdAt" TEXT NOT NULL, "createdBy" TEXT, PRIMARY KEY ("kind","url"))`,
  'CREATE INDEX IF NOT EXISTS "MktCandLink_cand" ON "MktCandLink" ("candidateId")',
  // 10.14 candidate job alerts
  `CREATE TABLE IF NOT EXISTS "MktAlertSub" ("id" TEXT PRIMARY KEY, "email" TEXT NOT NULL, "name" TEXT, "keywords" TEXT, "location" TEXT, "lang" TEXT, "status" TEXT NOT NULL DEFAULT 'pending', "token" TEXT NOT NULL UNIQUE, "createdAt" TEXT NOT NULL, "confirmedAt" TEXT, "stoppedAt" TEXT, "lastSentAt" TEXT, "sentJobs" TEXT NOT NULL DEFAULT '[]')`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "MktAlertSub_email" ON "MktAlertSub" ("email")',
  // 10.13 SMS job marketing campaigns
  `CREATE TABLE IF NOT EXISTS "MktSmsCampaign" ("id" TEXT PRIMARY KEY, "requirementId" TEXT NOT NULL, "text" TEXT NOT NULL, "audience" TEXT NOT NULL, "status" TEXT NOT NULL, "total" INTEGER NOT NULL DEFAULT 0, "sent" INTEGER NOT NULL DEFAULT 0, "failed" INTEGER NOT NULL DEFAULT 0, "skipped" INTEGER NOT NULL DEFAULT 0, "log" TEXT NOT NULL DEFAULT '[]', "createdBy" TEXT, "createdById" TEXT, "createdAt" TEXT NOT NULL, "finishedAt" TEXT)`,
  // 10.07 / 10.09 / 10.10 applications that came from a job board's API (de-duplication by the board's own id)
  `CREATE TABLE IF NOT EXISTS "MktBoardApp" ("board" TEXT NOT NULL, "externalId" TEXT NOT NULL, "requirementId" TEXT, "applicationId" TEXT, "candidateId" TEXT, "createdAt" TEXT NOT NULL, PRIMARY KEY ("board","externalId"))`,
];

let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => { for (const s of DDL) await x(s); })() // eslint-disable-line no-restricted-syntax, no-await-in-loop
      .catch((e) => { READY = null; throw e; });
  }
  return READY;
}

// ---- settings -----------------------------------------------------------------
const KEY = 'ats.market.settings';
// Everything that messages real people or runs by itself is OFF until an Admin turns it on.
const SWITCHES = {
  selfScheduling: 'Candidates may pick their own interview slot from a link (also needs the job\'s own tick)',
  assessments: 'Send online tests to candidates by link',
  sequences: 'Multi-step candidate sequences (email / SMS / WhatsApp steps with waits, stop on reply)',
  emailTracking: 'Track opens and clicks of candidate emails TeamLink sends',
  smsMarketing: 'SMS job campaigns to a talent pool',
  jobAlerts: 'Email job alerts to candidates who subscribed on the careers site',
  inboxSync: 'Read connected mailboxes for candidate replies (every 5 minutes)',
  calendarPush: 'Put booked interviews in the interviewer\'s connected Google / Microsoft calendar',
};
const DEFAULT_SITE = {
  published: false,
  brand: { name: 'TeamLink', color: '#1f6feb', logoUrl: '' },
  hero: { title: 'Find your next job with us', subtitle: 'Open roles from the companies we hire for. Apply in two minutes.', button: 'See open jobs' },
  about: { title: 'About us', text: 'We are a recruitment agency. We match people to good jobs across India.' },
  jobs: { title: 'Open jobs', max: 30 },
  contact: { title: 'Contact', email: '', phone: '', address: '' },
  sections: ['hero', 'about', 'jobs', 'alerts', 'contact'],
  seo: { description: '', languages: ['en', 'te', 'hi'] },
};

async function settings() {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  const v = json(row && row.value, {}) || {};
  const switches = {};
  Object.keys(SWITCHES).forEach((k) => { switches[k] = !!(v.switches && v.switches[k]); });
  return { switches, site: { ...DEFAULT_SITE, ...(v.site || {}) }, calendarApp: v.calendarApp || {}, boards: v.boards || {}, raw: v };
}
async function saveSettings(patch, user) {
  const cur = (await settings()).raw;
  const next = { ...cur, ...patch };
  await prisma.appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(next), updatedById: user && user.id, updatedByName: who(user) },
    update: { value: JSON.stringify(next), updatedById: user && user.id, updatedByName: who(user) },
  });
  return settings();
}
async function switchOn(name) { return !!(await settings()).switches[name]; }
const SWITCH_OFF = (name) => `This is switched off. An Admin turns it on in Administration > Step timing and alerts > "Add-on switches" (${SWITCHES[name] || name}).`;

// ---- tokens --------------------------------------------------------------------
function secret() {
  return process.env.JWT_SECRET || process.env.INTEGRATION_SECRET_KEY || 'teamlink-mkt';
}
const randToken = (n = 18) => crypto.randomBytes(n).toString('base64url');
function sign(kind, id) {
  const mac = crypto.createHmac('sha256', secret()).update(`${kind}|${id}`).digest('base64url').slice(0, 16);
  return `${Buffer.from(String(id)).toString('base64url')}.${mac}`;
}
function verify(kind, token) {
  const [a, mac] = String(token || '').split('.');
  if (!a || !mac) return null;
  let id; try { id = Buffer.from(a, 'base64url').toString('utf8'); } catch { return null; }
  const want = crypto.createHmac('sha256', secret()).update(`${kind}|${id}`).digest('base64url').slice(0, 16);
  if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
  return id;
}

// ---- secrets (encrypted when the integration key is set; never plain otherwise) ----
function enc(plain) {
  const S = require('../secrets'); // eslint-disable-line global-require
  if (!plain) return '';
  if (!S.secretsConfigured()) { const e = new Error(S.NO_KEY_MESSAGE); e.status = 400; throw e; }
  return S.encryptSecret(plain);
}
function dec(v) { return require('../secrets').decryptSecret(v); } // eslint-disable-line global-require

// ---- PII -----------------------------------------------------------------------
function maskPii(text, names = []) {
  let s = String(text || '');
  s = s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]');
  s = s.replace(/https?:\/\/\S+/gi, '[link]');
  s = s.replace(/(\+?\d[\d\s-]{8,}\d)/g, '[number]');
  s = s.replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[id]'); // PAN
  s = s.replace(/\b\d{4}\s?\d{4}\s?\d{4}\b/g, '[id]'); // Aadhaar
  names.filter((n) => n && String(n).trim().length > 1).forEach((n) => {
    String(n).split(/\s+/).filter((p) => p.length > 2).forEach((p) => { s = s.replace(new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '[name]'); });
  });
  return s;
}

// ---- AI ------------------------------------------------------------------------
// -> parsed JSON object or null (model down / refused / unreadable). The caller always has its own code answer.
async function aiJson(system, user, { maxTokens = 900, timeoutMs = 20000 } = {}) {
  try {
    const r = await require('../fastAi').chat(system, [{ role: 'user', content: String(user).slice(0, 14000) }], { json: true, maxTokens, temperature: 0.1, timeoutMs, deadlineMs: timeoutMs + 5000, fallbackToApp: false }); // eslint-disable-line global-require
    const out = require('../ai').parseJsonLoose(r && r.text); // eslint-disable-line global-require
    return out && typeof out === 'object' ? { value: out, provider: r.provider || 'AI' } : null;
  } catch { return null; }
}
async function aiText(system, user, { maxTokens = 700, timeoutMs = 20000 } = {}) {
  try {
    const r = await require('../fastAi').chat(system, [{ role: 'user', content: String(user).slice(0, 14000) }], { maxTokens, temperature: 0.2, timeoutMs, deadlineMs: timeoutMs + 5000, fallbackToApp: false }); // eslint-disable-line global-require
    const t = String((r && r.text) || '').trim();
    return t ? { text: t, provider: r.provider || 'AI' } : null;
  } catch { return null; }
}

// ---- speech to text ---------------------------------------------------------------
// The app's own engines (calling/voice/engines.js through the gateway). Long recordings are cut into 20-second pieces.
// -> { text, source } | { error }
const SPEECH_MAX = 25 * 1024 * 1024;
async function transcribe(buf, lang = 'en') {
  const NAME = { en: 'English', te: 'Telugu', hi: 'Hindi' };
  if (!Buffer.isBuffer(buf) || buf.length < 1500) return { error: 'The recording is empty.' };
  if (isSandbox()) return { error: 'Speech to text does not run in the test sandbox. Paste the transcript instead.' };
  let E;
  try { E = require('../../calling/voice/gateway').engines(); } catch { E = null; } // eslint-disable-line global-require
  if (!E || !E.stt || !(process.env.AI_VOICE_WHISPER_URL || process.env.AI_VOICE_STT_URL)) {
    return { error: 'This server has no speech-to-text engine switched on (AI_VOICE_WHISPER_URL). Paste the transcript instead.' };
  }
  try {
    const R = require('../../calling/voice/engines'); // eslint-disable-line global-require
    let pcm;
    if (buf.slice(0, 4).toString('ascii') === 'RIFF') { const w = R.wavToPcm(buf); pcm = R.resample(w.pcm, w.rate, 8000); } else pcm = await toPcm8k(buf);
    const CHUNK = 8000 * 2 * 20; // 20 s
    const parts = [];
    for (let at = 0; at < pcm.length && at < CHUNK * 90; at += CHUNK) { // at most 30 minutes
      const piece = pcm.slice(at, at + CHUNK);
      if (piece.length < 8000) break; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const r = await Promise.race([E.stt(piece, NAME[lang] || 'English', 8000), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 60000))]);
      const t = String((r && r.text) || r || '').trim();
      if (t) parts.push(t);
    }
    return { text: parts.join(' ').replace(/\s+/g, ' ').trim(), source: 'TeamLink speech engine (Whisper / VEXYL-STT)' };
  } catch (e) {
    return { error: `The recording could not be turned into text (${String(e.message).slice(0, 80)}). Paste the transcript instead.` };
  }
}
function toPcm8k(buf) {
  const { spawn } = require('child_process'); // eslint-disable-line global-require
  return new Promise((resolve, reject) => {
    const ff = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], { windowsHide: true });
    const out = []; let err = '';
    const t = setTimeout(() => { ff.kill('SIGKILL'); reject(new Error('ffmpeg took too long')); }, 120000);
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => { err += String(d); });
    ff.on('error', (e) => { clearTimeout(t); reject(new Error(`ffmpeg is not available (${e.code || e.message})`)); });
    ff.on('close', (code) => { clearTimeout(t); if (code === 0) resolve(Buffer.concat(out)); else reject(new Error(`ffmpeg failed: ${err.slice(0, 120)}`)); });
    ff.stdin.on('error', () => {});
    ff.stdin.end(buf);
  });
}

function publicBase(req) {
  try { return require('../offerLink').publicBase(req); } catch { return String(process.env.APP_BASE_URL || 'http://localhost:5183').replace(/\/+$/, ''); } // eslint-disable-line global-require
}

module.exports = {
  q, x, nowIso, newId, isSandbox, who, json, txt, ensure, settings, saveSettings, switchOn, SWITCHES, SWITCH_OFF, DEFAULT_SITE,
  sign, verify, randToken, enc, dec, maskPii, aiJson, aiText, transcribe, SPEECH_MAX, publicBase,
};
