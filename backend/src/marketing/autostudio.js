// ---------------------------------------------------------------------------
// AI MARKETING > CREATE FROM A PROMPT (2026-11-14): "I want a video on this topic for this day". One sentence from a person becomes a ready-made creative:
//   plan()   (this file, the AI writing layer: limits, usage log, labelled sample writer in the test sandbox)
//            -> a title, the headline, tagline and call to action for the video, the post words (caption) and hashtags, and one SCENE per picture: the short text
//               shown on it and a description of the picture to make. The day the person named is kept (and shown as a date) for the Content Calendar.
//   next     the screen makes each scene's picture with AI Images (the same picture service, limits and client-project logo / colours), puts the pictures together
//            into a video in the browser (AI Video), or keeps them as picture posts; everything lands as a DRAFT that still needs approval (team or client).
// Nothing is posted and nothing is approved here. The plan never invents prices, phone numbers, links or dates: it uses only what the prompt says.
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const A = require('../outreach/access');
const AI = require('./ai');
const Cfg = require('./settings');

const mayWrite = (u) => A.has('mayAiMarketing')(u);
const LANGS = ['English', 'Telugu', 'Hindi'];
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dateLabel = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : ''; };
const validDate = (d) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))) return ''; const t = Date.parse(`${d}T00:00:00+05:30`); return Number.isFinite(t) ? d : ''; };
const hashtagsOf = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\s,]+/)).map((x) => `#${String(x).replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '')}`).filter((x) => x.length > 1 && x.length <= 30).filter((x, i, a) => a.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i).slice(0, 10);

// a client project's name and brief (when the creative is made for a client): the client, not our company, is the brand
async function projectOf(id) {
  const pid = S.clip(id, 40);
  if (!pid) return null;
  try { return (await S.q('SELECT clientName, occasion, brief FROM "OmniMkProject" WHERE id = ? AND deletedAt IS NULL', pid))[0] || null; } catch { return null; }
}

function systemFor(brand, who, kind, n, language, day, project) {
  return [
    `You are the creative director of a social media team. You turn one request into a ready-to-use ${kind === 'video' ? `short vertical video of ${n} scenes` : `picture post of ${n} picture${n === 1 ? '' : 's'}`} for ${who}.`,
    !project && brand.about ? `About the company: ${brand.about}` : '', !project && brand.voice ? `Brand voice: ${brand.voice}` : '', !project && brand.audience ? `The company talks to: ${brand.audience}.` : '',
    project && project.brief ? `The client's own brief: ${project.brief}` : '',
    !project && brand.keyMessages && brand.keyMessages.length ? `Key messages: ${brand.keyMessages.join(' | ')}` : '',
    brand.avoidWords && brand.avoidWords.length ? `Never use these words: ${brand.avoidWords.join(', ')}.` : '',
    !project && brand.hashtags && brand.hashtags.length ? `Brand hashtags you may reuse: ${brand.hashtags.join(' ')}.` : '',
    `Write all the words in ${language}.${day ? ` It is for ${dateLabel(day)}: mention the day or festival only if the request names it.` : ''}`,
    'Use ONLY facts that are in the request. Never invent prices, discounts, phone numbers, addresses, links, dates or claims.',
    'Answer with ONLY a JSON object: {"title":"<three to six words>","headline":"<the main line, at most 8 words>","tagline":"<one short line, at most 10 words>","cta":"<a short call to action, at most 4 words>","caption":"<the post words, ready to publish, 2 to 4 short sentences>","hashtags":["#tag", ...up to 8],"scenes":[{"caption":"<text shown on the picture, at most 7 words>","imagePrompt":"<describe ONE picture: the subject, the place, the light, the mood. No text, letters, logos or watermarks in the picture>","search":"<two or three plain ENGLISH words to find a real background photo, for example: office team meeting>"}]}',
    `The "scenes" array must have exactly ${n} items, each a different picture that tells the story in order.`,
  ].filter(Boolean).join('\n');
}
function demoPlan(prompt, who, kind, n, day) {
  const topic = S.clip(prompt.replace(/\s+/g, ' '), 90);
  const words = topic.split(' ').filter((w) => w.length > 3).slice(0, 3);
  const base = ['A warm welcome scene', 'The people behind it', 'The offer in focus', 'A happy customer moment', 'Everything ready for the day', 'A thank-you moment'];
  return {
    title: S.clip(topic.split(' ').slice(0, 5).join(' '), 60), headline: S.clip(topic.split(' ').slice(0, 7).join(' '), 60), tagline: `From ${who}`, cta: 'Contact us',
    caption: `${topic}. Sample caption from the test writer for ${who}${day ? `, for ${dateLabel(day)}` : ''}.`, hashtags: words.map((w) => `#${w}`),
    scenes: Array.from({ length: n }, (_, i) => ({ caption: base[i % base.length], imagePrompt: `${base[i % base.length]} for: ${topic}. Natural light, friendly mood.`, search: ['office team', 'people smiling', 'business handshake', 'city office', 'happy customer', 'team celebration'][i % 6] })),
  };
}
// the words to look for a background photo with: what the AI said, else plain words from the picture description
const searchOf = (s) => {
  const own = String((s && s.search) || '').replace(/[^A-Za-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 4).join(' ');
  if (own.length >= 3) return own.slice(0, 40);
  const words = String((s && s.imagePrompt) || '').replace(/[^A-Za-z ]+/g, ' ').split(' ').filter((w) => w.length > 3).slice(0, 3).join(' ');
  return words || 'office team';
};
function clean(raw, { n, who, prompt, kind, day }) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const fallback = demoPlan(prompt, who, kind, n, day);
  const scenes = (Array.isArray(r.scenes) ? r.scenes : []).map((s) => ({ caption: S.clip(s && s.caption, 80), imagePrompt: S.clip(s && s.imagePrompt, 400), search: searchOf(s) })).filter((s) => s.imagePrompt.length >= 8).slice(0, n);
  while (scenes.length < n) scenes.push(fallback.scenes[scenes.length]);
  return {
    title: S.clip(r.title, 80) || fallback.title, headline: S.clip(r.headline, 80) || fallback.headline, tagline: S.clip(r.tagline, 100) || fallback.tagline, cta: S.clip(r.cta, 30) || fallback.cta,
    caption: String(r.caption || '').replace(/\r/g, '').trim().slice(0, 1800) || fallback.caption, hashtags: hashtagsOf(r.hashtags).length ? hashtagsOf(r.hashtags) : hashtagsOf(fallback.hashtags), scenes,
  };
}
// What the person wrote themselves always wins over the AI: their title, heading, call to action and content are used exactly (cut only to their size); the content is spread over the scenes,
// one part each (a line each, or a sentence each). The AI fills only what was left empty.
function partsOf(content, n) {
  const text = String(content || '').replace(/\r/g, '').trim();
  if (!text) return [];
  let parts = text.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) parts = (text.match(/[^.!?\n]+[.!?]*/g) || [text]).map((x) => x.trim()).filter(Boolean);
  if (parts.length > n) { const head = parts.slice(0, n - 1); head.push(parts.slice(n - 1).join(' ')); parts = head; }
  return parts.map((x) => S.clip(x, 160));
}
function applyMine(p, mine, n) {
  const out = { ...p, scenes: p.scenes.map((s) => ({ ...s })) };
  if (mine.title) out.title = mine.title;
  if (mine.heading) out.headline = mine.heading;
  if (mine.cta) out.cta = mine.cta;
  partsOf(mine.content, n).forEach((t, i) => { if (out.scenes[i]) out.scenes[i].caption = t; });
  return out;
}

// b: { prompt (the idea), title, heading, content, cta (all optional: what the person wrote themselves), kind: 'video' | 'post', scenes, date (YYYY-MM-DD), language, projectId }
async function plan(u, b = {}) {
  if (!mayWrite(u)) return { error: 'Your login can look at AI Marketing but not use it to create.', status: 403 };
  const mine = { title: S.clip(b.title, 80), heading: S.clip(b.heading, 80), cta: S.clip(b.cta, 30), content: String(b.content || '').replace(/\r/g, '').trim().slice(0, 1200) };
  const idea = String(b.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 800);
  const prompt = idea.length >= 8 ? idea : `${mine.title} ${mine.heading} ${mine.content}`.replace(/\s+/g, ' ').trim().slice(0, 800);
  if (prompt.length < 8) return { error: 'Tell the AI what you want in a sentence (the topic, who it is for and the day), or write your own title, heading and content. For example: "A Diwali offer video for our software clients, 20% off, for 12 November."', status: 400 };
  const kind = b.kind === 'post' ? 'post' : 'video';
  const n = kind === 'video' ? clamp(Math.floor(Number(b.scenes)) || 4, 3, 6) : clamp(Math.floor(Number(b.scenes)) || 2, 1, 3);
  const day = validDate(b.date);
  const brand = await Cfg.getBrand();
  const project = await projectOf(b.projectId);
  const who = (project && project.clientName) || brand.brandName || 'our company';
  const language = LANGS.includes(b.language) ? b.language : (LANGS.includes(brand.language) ? brand.language : 'English');
  let r;
  try {
    const given = [mine.title ? `Title: ${mine.title}` : '', mine.heading ? `Heading: ${mine.heading}` : '', mine.cta ? `Call to action: ${mine.cta}` : '', mine.content ? `Content the person wrote (use it as it is, do not change a word): ${mine.content}` : ''].filter(Boolean).join('\n');
    r = await AI.generate({ user: u, module: 'studio', task: kind, system: systemFor(brand, who, kind, n, language, day, project), prompt: `Request: ${prompt}${given ? `\n${given}` : ''}`, json: true, demo: () => demoPlan(prompt, who, kind, n, day), department: S.clip(b.department, 60) || undefined });
  } catch (e) { return { error: e.message, status: e.status || 503, code: e.code }; }
  const p = applyMine(clean(r.result, { n, who, prompt, kind, day }), mine, n);
  const text = `${p.title} ${p.headline} ${p.tagline} ${p.caption} ${p.scenes.map((s) => s.caption).join(' ')}`;
  const flags = (brand.avoidWords || []).filter((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(text));
  return { plan: { ...p, kind, language, date: day, dateLabel: dateLabel(day), who }, flags, demo: !!r.demo, provider: r.provider || '' };
}

module.exports = { plan, dateLabel, clean, partsOf, applyMine }; // clean: exported for the tests (a model answer that is incomplete or too long is repaired, never trusted)
