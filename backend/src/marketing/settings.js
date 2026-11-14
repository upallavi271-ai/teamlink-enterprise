// ---------------------------------------------------------------------------
// AI MARKETING SETTINGS + BRAND VOICE (two AppSetting rows, no migration):
//   omni.mk.settings  { aiDailyPerUser, aiMonthlyCap, selfApprove, clientRequired, clientFor[] }   set by an Admin
//     clientRequired (2026-11-14): when ON, only a CLIENT can approve the kinds listed in clientFor ('words', 'pictures', 'videos'; raw clips are never included):
//     the team's Approve / "Ask for approval" are refused for them and the item goes to the client ("Ask the client to approve", clientReview.js mode 'decide').
//   omni.mk.brand     { brandName, about, voice, tone, language, cta, signOff, doWords[], avoidWords[], samples[] }   set by an Admin or Marketing
// ---------------------------------------------------------------------------
const prisma = require('../db');

const SETTINGS_KEY = 'omni.mk.settings';
const BRAND_KEY = 'omni.mk.brand';
const LOGO_KEY = 'omni.mk.brand.logo'; // { dataUrl, name, at } kept apart: it is large and only the brand screen and the image / video makers need it
const CLIENT_KINDS = ['words', 'pictures', 'videos'];
const DEFAULT_SETTINGS = { aiDailyPerUser: 60, aiMonthlyCap: 0, selfApprove: true, clientRequired: false, clientFor: CLIENT_KINDS.slice() };
const DEFAULT_COLORS = { primary: '#0f766e', secondary: '#134e4a', accent: '#f59e0b' };
const DEFAULT_BRAND = {
  brandName: '', about: '', voice: '', tone: 'Warm & confident', language: 'English', cta: '', signOff: '', doWords: [], avoidWords: [], samples: [],
  // the brand kit (2026-11-13): who we talk to, what we always say, how we look, where we are on social media
  tagline: '', website: '', contact: '', audience: '', industries: [], keyMessages: [], hashtags: [], emoji: 'few', disclaimer: '',
  colors: { ...DEFAULT_COLORS }, socials: { facebook: '', instagram: '', linkedin: '', x: '' },
};
const LANGUAGES = ['English', 'Telugu', 'Hindi'];
const EMOJI = ['none', 'few', 'many'];
const LIMITS = { doWords: 20, avoidWords: 30, samples: 3, sampleChars: 300, industries: 10, keyMessages: 6, keyMessageChars: 160, hashtags: 15 };
const LOGO_MAX_BYTES = 300 * 1024;

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
    clientRequired: s.clientRequired === true,
    clientFor: Array.isArray(s.clientFor) ? CLIENT_KINDS.filter((k) => s.clientFor.includes(k)) : CLIENT_KINDS.slice(),
  };
}
// does the company require a CLIENT to approve this kind ('words' | 'pictures' | 'videos')?
const clientNeeded = (set, kind) => !!set && set.clientRequired === true && Array.isArray(set.clientFor) && set.clientFor.includes(kind);
// -> { value } or { error }
function cleanSettings(b, cur) {
  const next = { ...cur };
  if (b.aiDailyPerUser !== undefined) { const n = Number(b.aiDailyPerUser); if (!Number.isFinite(n) || n < 0 || n > 2000) return { error: 'Daily AI requests per person must be a number from 0 to 2000 (0 = nobody can use AI).' }; next.aiDailyPerUser = Math.floor(n); }
  if (b.aiMonthlyCap !== undefined) { const n = Number(b.aiMonthlyCap); if (!Number.isFinite(n) || n < 0 || n > 1000000) return { error: 'The monthly AI limit must be a number (0 = no limit).' }; next.aiMonthlyCap = Math.floor(n); }
  if (b.selfApprove !== undefined) next.selfApprove = b.selfApprove === true;
  if (b.clientRequired !== undefined) next.clientRequired = b.clientRequired === true;
  if (b.clientFor !== undefined) next.clientFor = (Array.isArray(b.clientFor) ? b.clientFor : []).map(String).filter((k, i, a) => CLIENT_KINDS.includes(k) && a.indexOf(k) === i);
  if (next.clientRequired && !(next.clientFor || []).length) return { error: 'Tick at least one thing the client must approve (words, pictures or videos), or switch the rule off.' };
  return { value: next };
}
async function saveSettings(v) { await write(SETTINGS_KEY, v); }

const HEX = /^#[0-9a-f]{6}$/i;
const colorsOf = (c) => {
  const v = c && typeof c === 'object' ? c : {};
  return { primary: HEX.test(v.primary) ? v.primary.toLowerCase() : DEFAULT_COLORS.primary, secondary: HEX.test(v.secondary) ? v.secondary.toLowerCase() : DEFAULT_COLORS.secondary, accent: HEX.test(v.accent) ? v.accent.toLowerCase() : DEFAULT_COLORS.accent };
};
const socialsOf = (s) => { const v = s && typeof s === 'object' ? s : {}; return { facebook: clip(v.facebook, 120), instagram: clip(v.instagram, 120), linkedin: clip(v.linkedin, 120), x: clip(v.x, 120) }; };
// hashtags: one word each, always starting with #
const tagSplit = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\s,]+/));
const tagsOf = (v) => words(tagSplit(v), LIMITS.hashtags, 40).map((t) => `#${t.replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '')}`).filter((t) => t.length > 1).filter((t, i, a) => a.findIndex((y) => y.toLowerCase() === t.toLowerCase()) === i);
const linesOf = (v) => (Array.isArray(v) ? v : String(v || '').split(/\n+/)).map((x) => String(x).trim()).filter(Boolean);
const samplesIn = (v) => (Array.isArray(v) ? v : String(v || '').split(/\n{2,}/)).map((x) => String(x).trim()).filter(Boolean);
const urlOk = (u) => !u || /^https?:\/\/[^\s/$.?#][^\s]*$/i.test(u);

async function getBrand() {
  const b = (await read(BRAND_KEY)) || {};
  const logo = await read(LOGO_KEY);
  return {
    brandName: clip(b.brandName, 80), about: clip(b.about, 600), voice: clip(b.voice, 400), tone: clip(b.tone, 40) || DEFAULT_BRAND.tone,
    language: LANGUAGES.includes(b.language) ? b.language : 'English', cta: clip(b.cta, 80), signOff: clip(b.signOff, 80),
    doWords: words(b.doWords, LIMITS.doWords, 40), avoidWords: words(b.avoidWords, LIMITS.avoidWords, 40), samples: (Array.isArray(b.samples) ? b.samples : []).map((x) => clip(x, LIMITS.sampleChars)).filter(Boolean).slice(0, LIMITS.samples),
    tagline: clip(b.tagline, 120), website: urlOk(clip(b.website, 200)) ? clip(b.website, 200) : '', contact: clip(b.contact, 120), audience: clip(b.audience, 300),
    industries: words(b.industries, LIMITS.industries, 40), keyMessages: linesOf(b.keyMessages).map((x) => clip(x, LIMITS.keyMessageChars)).slice(0, LIMITS.keyMessages), hashtags: tagsOf(b.hashtags),
    emoji: EMOJI.includes(b.emoji) ? b.emoji : DEFAULT_BRAND.emoji, disclaimer: clip(b.disclaimer, 300), colors: colorsOf(b.colors), socials: socialsOf(b.socials),
    hasLogo: !!(logo && logo.dataUrl), logoAt: logo && logo.at ? logo.at : null,
    updatedAt: b.updatedAt || null, updatedByName: b.updatedByName || '',
  };
}
// -> { value, notes } or { error }. `notes` says, in plain words, anything that was shortened or left out (nothing is cut silently).
function cleanBrand(b, tones) {
  const brandName = clip(b.brandName, 80);
  if (!brandName) return { error: 'Write the brand name first (for example: TeamLink).' };
  const tone = clip(b.tone, 40) || DEFAULT_BRAND.tone;
  if (tones && !tones.includes(tone)) return { error: 'Pick one of the listed tones.' };
  const language = LANGUAGES.includes(b.language) ? b.language : 'English';
  const website = clip(b.website, 200);
  if (!urlOk(website)) return { error: 'The website must be a full address that starts with https:// (or leave it empty).' };
  for (const k of ['primary', 'secondary', 'accent']) {
    const c = b.colors && b.colors[k];
    if (c && !HEX.test(c)) return { error: `The ${k} colour must look like #0f766e.` };
  }
  const notes = [];
  const count = (v) => words(v, 1000, 40).length;
  if (count(b.doWords) > LIMITS.doWords) notes.push(`Words to use: only the first ${LIMITS.doWords} are kept.`);
  if (count(b.avoidWords) > LIMITS.avoidWords) notes.push(`Never-use words: only the first ${LIMITS.avoidWords} are kept.`);
  const sIn = samplesIn(b.samples);
  if (sIn.length > LIMITS.samples) notes.push(`Examples: only the first ${LIMITS.samples} are kept.`);
  if (sIn.slice(0, LIMITS.samples).some((x) => x.length > LIMITS.sampleChars)) notes.push(`An example was longer than ${LIMITS.sampleChars} characters and was shortened.`);
  const kIn = linesOf(b.keyMessages);
  if (kIn.length > LIMITS.keyMessages) notes.push(`Key messages: only the first ${LIMITS.keyMessages} are kept.`);
  if (kIn.slice(0, LIMITS.keyMessages).some((x) => x.length > LIMITS.keyMessageChars)) notes.push(`A key message was longer than ${LIMITS.keyMessageChars} characters and was shortened.`);
  if (count(b.industries) > LIMITS.industries) notes.push(`Industries: only the first ${LIMITS.industries} are kept.`);
  if (count(tagSplit(b.hashtags)) > LIMITS.hashtags) notes.push(`Hashtags: only the first ${LIMITS.hashtags} are kept.`);
  return {
    notes,
    value: {
      brandName, about: clip(b.about, 600), voice: clip(b.voice, 400), tone, language, cta: clip(b.cta, 80), signOff: clip(b.signOff, 80),
      doWords: words(b.doWords, LIMITS.doWords, 40), avoidWords: words(b.avoidWords, LIMITS.avoidWords, 40),
      samples: sIn.map((x) => clip(x, LIMITS.sampleChars)).slice(0, LIMITS.samples),
      tagline: clip(b.tagline, 120), website, contact: clip(b.contact, 120), audience: clip(b.audience, 300),
      industries: words(b.industries, LIMITS.industries, 40), keyMessages: kIn.map((x) => clip(x, LIMITS.keyMessageChars)).slice(0, LIMITS.keyMessages), hashtags: tagsOf(b.hashtags),
      emoji: EMOJI.includes(b.emoji) ? b.emoji : DEFAULT_BRAND.emoji, disclaimer: clip(b.disclaimer, 300), colors: colorsOf(b.colors), socials: socialsOf(b.socials),
    },
  };
}
async function saveBrand(v, user) { await write(BRAND_KEY, { ...v, updatedAt: new Date().toISOString(), updatedByName: user ? clip(user.name, 80) : '' }); }

// ---- the logo (PNG / JPEG / WebP only: an SVG can carry script) ------------------------------------------------------------------------
async function getLogo() { const l = await read(LOGO_KEY); return l && l.dataUrl ? l : null; }
// -> { value } or { error }
function cleanLogo(b) {
  const m = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String((b && b.dataUrl) || ''));
  if (!m) return { error: 'Upload the logo as a PNG, JPG or WebP picture.' };
  const bytes = Math.floor((m[3].length * 3) / 4);
  if (bytes > LOGO_MAX_BYTES) return { error: `The logo is too big (${Math.round(bytes / 1024)} KB). Use a picture under ${LOGO_MAX_BYTES / 1024} KB.` };
  const buf = Buffer.from(m[3], 'base64');
  const sig = { 'image/png': (x) => x[0] === 0x89 && x[1] === 0x50, 'image/jpeg': (x) => x[0] === 0xff && x[1] === 0xd8, 'image/webp': (x) => x.slice(8, 12).toString('ascii') === 'WEBP' };
  if (!sig[m[1]](buf)) return { error: 'That file is not really a PNG, JPG or WebP picture.' };
  return { value: { dataUrl: `data:${m[1]};base64,${m[3]}`, name: clip(b.name, 120), bytes, at: new Date().toISOString() } };
}
async function saveLogo(v) { await write(LOGO_KEY, v); }
async function removeLogo() { try { await prisma.appSetting.delete({ where: { key: LOGO_KEY } }); } catch { /* nothing to remove */ } }

module.exports = { getSettings, cleanSettings, saveSettings, clientNeeded, CLIENT_KINDS, getBrand, cleanBrand, saveBrand, getLogo, cleanLogo, saveLogo, removeLogo, DEFAULT_SETTINGS, LANGUAGES, EMOJI, LIMITS, clip };
