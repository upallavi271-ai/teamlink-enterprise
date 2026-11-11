// ---------------------------------------------------------------------------
// AI MARKETING SETTINGS + BRAND VOICE (two AppSetting rows, no migration):
//   omni.mk.settings  { aiDailyPerUser, aiMonthlyCap, selfApprove }   set by an Admin
//   omni.mk.brand     { brandName, about, voice, tone, language, cta, signOff, doWords[], avoidWords[], samples[] }   set by an Admin or Marketing
// ---------------------------------------------------------------------------
const prisma = require('../db');

const SETTINGS_KEY = 'omni.mk.settings';
const BRAND_KEY = 'omni.mk.brand';
const DEFAULT_SETTINGS = { aiDailyPerUser: 60, aiMonthlyCap: 0, selfApprove: true };
const DEFAULT_BRAND = { brandName: '', about: '', voice: '', tone: 'Warm & confident', language: 'English', cta: '', signOff: '', doWords: [], avoidWords: [], samples: [] };
const LANGUAGES = ['English', 'Telugu', 'Hindi'];

const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
async function read(key) {
  try { const row = await prisma.appSetting.findUnique({ where: { key } }); return row ? JSON.parse(row.value) : null; } catch { return null; }
}
async function write(key, value) {
  const v = JSON.stringify(value);
  await prisma.appSetting.upsert({ where: { key }, update: { value: v }, create: { key, value: v } });
}
const words = (v, max, each) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]+/)).map((x) => clip(x, each)).filter(Boolean).filter((x, i, a) => a.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i).slice(0, max);

async function getSettings() {
  const s = (await read(SETTINGS_KEY)) || {};
  return {
    aiDailyPerUser: Number.isFinite(Number(s.aiDailyPerUser)) && Number(s.aiDailyPerUser) >= 0 ? Math.floor(Number(s.aiDailyPerUser)) : DEFAULT_SETTINGS.aiDailyPerUser,
    aiMonthlyCap: Number.isFinite(Number(s.aiMonthlyCap)) && Number(s.aiMonthlyCap) >= 0 ? Math.floor(Number(s.aiMonthlyCap)) : DEFAULT_SETTINGS.aiMonthlyCap,
    selfApprove: s.selfApprove !== false,
  };
}
// -> { value } or { error }
function cleanSettings(b, cur) {
  const next = { ...cur };
  if (b.aiDailyPerUser !== undefined) { const n = Number(b.aiDailyPerUser); if (!Number.isFinite(n) || n < 0 || n > 2000) return { error: 'Daily AI requests per person must be a number from 0 to 2000 (0 = nobody can use AI).' }; next.aiDailyPerUser = Math.floor(n); }
  if (b.aiMonthlyCap !== undefined) { const n = Number(b.aiMonthlyCap); if (!Number.isFinite(n) || n < 0 || n > 1000000) return { error: 'The monthly AI limit must be a number (0 = no limit).' }; next.aiMonthlyCap = Math.floor(n); }
  if (b.selfApprove !== undefined) next.selfApprove = b.selfApprove === true;
  return { value: next };
}
async function saveSettings(v) { await write(SETTINGS_KEY, v); }

async function getBrand() {
  const b = (await read(BRAND_KEY)) || {};
  return {
    brandName: clip(b.brandName, 80), about: clip(b.about, 600), voice: clip(b.voice, 400), tone: clip(b.tone, 40) || DEFAULT_BRAND.tone,
    language: LANGUAGES.includes(b.language) ? b.language : 'English', cta: clip(b.cta, 80), signOff: clip(b.signOff, 80),
    doWords: words(b.doWords, 20, 40), avoidWords: words(b.avoidWords, 30, 40), samples: (Array.isArray(b.samples) ? b.samples : []).map((x) => clip(x, 300)).filter(Boolean).slice(0, 3),
    updatedAt: b.updatedAt || null, updatedByName: b.updatedByName || '',
  };
}
// -> { value } or { error }
function cleanBrand(b, tones) {
  const brandName = clip(b.brandName, 80);
  if (!brandName) return { error: 'Write the brand name first (for example: TeamLink).' };
  const tone = clip(b.tone, 40) || DEFAULT_BRAND.tone;
  if (tones && !tones.includes(tone)) return { error: 'Pick one of the listed tones.' };
  const language = LANGUAGES.includes(b.language) ? b.language : 'English';
  return {
    value: {
      brandName, about: clip(b.about, 600), voice: clip(b.voice, 400), tone, language, cta: clip(b.cta, 80), signOff: clip(b.signOff, 80),
      doWords: words(b.doWords, 20, 40), avoidWords: words(b.avoidWords, 30, 40),
      samples: (Array.isArray(b.samples) ? b.samples : String(b.samples || '').split(/\n{2,}/)).map((x) => clip(x, 300)).filter(Boolean).slice(0, 3),
    },
  };
}
async function saveBrand(v, user) { await write(BRAND_KEY, { ...v, updatedAt: new Date().toISOString(), updatedByName: user ? clip(user.name, 80) : '' }); }

module.exports = { getSettings, cleanSettings, saveSettings, getBrand, cleanBrand, saveBrand, DEFAULT_SETTINGS, LANGUAGES, clip };
