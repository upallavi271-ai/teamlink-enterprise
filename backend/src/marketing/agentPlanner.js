// ---------------------------------------------------------------------------
// AI MARKETING > AI AGENT > THE PLANNER (2026-11-25). A goal in plain words ("Promote my recruitment consultancy for seven days") becomes a structured plan, with PLAIN CODE:
// no AI model, no network, no cost, the same answer every time (the paid AI model's credits are out; an AI polish may come later as an optional, checked extra).
//   1 parse     the goal is read: what kind of goal (promote / Instagram campaign / more enquiries / videos / full strategy / SEO), how many days, which platforms.
//   2 ask       the facts the goal needs (business name, services, audience, contact line ...) are checked against the saved business context (agentContext.js); what is
//               missing is asked once. Nothing is guessed.
//   3 plan      for every day (or video): objective, audience, content type, caption and hashtags per platform, a picture / video prompt, the publishing schedule and the success
//               metrics. Captions are built ONLY from the saved facts: no prices, years, awards, guarantees, rankings or results are ever invented. Every caption is run through the
//               wording check (contentGuard.js); what it finds is shown on the day.
//   4 steps     the plan becomes small executable steps (tasks) for the tools of agentTools.js. The engine (agent.js) runs them only after a person approves.
// SUCCESS METRICS are honest: each says how it is measured and whether TeamLink can measure it today (true), a person types it in ('manual'), or it is not connected yet (false). No
// target number is invented ("+30% reach" does not appear anywhere).
// ---------------------------------------------------------------------------
const Ctx = require('./agentContext');
const Guard = require('./contentGuard');
const Blog = require('./blogPlanner');
const Packs = require('./industryPacks');

const IST = 19800000;
const DAY_MS = 86400000;
const MAX_DAYS = 14;
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const cap1 = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const listText = (a) => (a.length <= 1 ? (a[0] || '') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
const article = (w) => (/^[aeiou]/i.test(w) ? `an ${w}` : `a ${w}`);
const endDot = (s) => (/[.!?…]$/.test(s) ? s : `${s}.`);

// ---- the kinds of goal ---------------------------------------------------------------------------------------------------------------------------------------------------------------
const INTENTS = {
  promote: { label: 'Promote the business', days: 7, platforms: ['instagram', 'facebook'], essentials: ['name', 'services', 'audience', 'contactLine'], optional: ['industry', 'about', 'locations'], goal: 'Awareness', verb: 'Promote' },
  instagram: { label: 'Instagram campaign', days: 7, platforms: ['instagram'], essentials: ['name', 'services', 'audience', 'contactLine'], optional: ['industry', 'about', 'locations'], goal: 'Awareness', verb: 'Instagram campaign for' },
  enquiries: { label: 'Get more enquiries', days: 7, platforms: ['instagram', 'facebook'], essentials: ['name', 'services', 'audience', 'contactLine'], optional: ['industry', 'locations', 'keyMessages'], goal: 'Lead generation', verb: 'More enquiries for' },
  videos: { label: 'Promotional videos', days: 3, platforms: ['instagram', 'facebook'], essentials: ['name', 'services', 'audience'], optional: ['contactLine', 'industry', 'locations'], goal: 'Promotion / offer', verb: 'Promotional videos for' },
  strategy: { label: 'Full marketing strategy', days: 7, platforms: ['instagram', 'facebook', 'linkedin'], essentials: ['name', 'industry', 'services', 'audience', 'locations'], optional: ['contactLine', 'website', 'about'], goal: 'Awareness', verb: 'Marketing strategy for' },
  seo: { label: 'Improve website SEO', days: 0, platforms: [], essentials: ['website', 'name'], optional: ['services', 'locations', 'industry'], goal: 'Awareness', verb: 'Website SEO for' },
};
const EXAMPLES = [
  'Promote my recruitment consultancy', 'Increase enquiries for my digital marketing services', 'Create a 7-day Instagram campaign', 'Generate promotional videos for my business',
  'Plan a complete marketing strategy for my new product', "Improve my website's SEO",
];
const PLATFORM_WORDS = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', x: 'X' };
const PLATFORM_LIMIT = { instagram: 2200, facebook: 3000, linkedin: 3000, x: 280 };
const TAGS_FOR = { instagram: 8, facebook: 3, linkedin: 3, x: 2 };
const NUMS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14 };

function daysIn(t) {
  let m = /(\d{1,2})\s*[- ]?\s*days?\b/.exec(t); if (m) return Number(m[1]);
  m = new RegExp(`\\b(${Object.keys(NUMS).join('|')})[- ]?days?\\b`).exec(t); if (m) return NUMS[m[1]];
  if (/\b(two|2)\s+weeks?\b/.test(t)) return 14;
  if (/\b(a|one|1|the next)\s+week\b|\bweekly\b/.test(t)) return 7;
  return 0;
}
function platformsIn(t) {
  const out = [];
  if (/\binsta(gram)?\b|\big\b|\breels?\b/.test(t)) out.push('instagram');
  if (/\bfacebook\b|\bfb\b/.test(t)) out.push('facebook');
  if (/\blinked-?in\b/.test(t)) out.push('linkedin');
  if (/\btwitter\b|\bx\.com\b|\bon x\b|\bx post/.test(t)) out.push('x');
  return out;
}
function intentOf(t) {
  if (/\bseo\b|search engine|google rank|rank (higher|better|on google)|website.*(optimi[sz]|improve)|improve.*website/.test(t)) return 'seo';
  if (/strateg|marketing plan|plan a complete|complete marketing/.test(t)) return 'strategy';
  if (/\bvideos?\b|\breels?\b|\bshorts?\b/.test(t) && /(generate|create|make|produce|promotional|promo|shoot|need|want)/.test(t)) return 'videos';
  if (/instagram/.test(t)) return 'instagram';
  if (/enquir|inquir|leads?\b|more (customers|clients|calls|sales)|get customers|get clients/.test(t)) return 'enquiries';
  return 'promote';
}
const GENERIC = /^(business|company|brand|product|products|website|site|services?|new|firm|shop|store|work|page)(\s+\w+)?$/i;
function hintOf(text, intent) {
  if (intent === 'seo') return '';
  const m = /\bmy\s+([a-z][a-z &'-]{2,48}?)(?=\s+(?:for|to|on|in|with|by|so|and)\b|[.,!?]|$)/i.exec(text);
  const h = m ? clip(m[1].replace(/\s+services?$/i, ''), 60) : '';
  return h && !GENERIC.test(h) ? h : '';
}
// -> { intent, label, days, platforms, hint, clamped }
function parse(goalText) {
  const text = clip(goalText, 400); const t = text.toLowerCase();
  const intent = intentOf(t); const def = INTENTS[intent];
  let days = daysIn(t); let clamped = false;
  if (intent === 'videos') { days = days && days <= 5 ? days : 0; } // "5 videos" is a count, not days
  if (days > MAX_DAYS) { days = MAX_DAYS; clamped = true; }
  const named = platformsIn(t);
  return { text, intent, label: def.label, days: days || def.days, daysGiven: !!days, platforms: named.length ? named : def.platforms.slice(), platformsGiven: named.length > 0, hint: hintOf(text, intent), clamped };
}

// ---- metrics: how success is measured, and whether TeamLink can measure it today ------------------------------------------------------------------------------------------------
const METRICS = {
  drafted: { key: 'drafted', label: 'Draft made in AI Content', how: 'counted from AI Content', live: true },
  approved: { key: 'approved', label: 'Approved by the team before posting', how: 'the approval status of the items the agent made', live: true },
  posted: { key: 'posted', label: 'Posted on the scheduled day', how: 'marked by the person who posted it (AI Images > Post, or by hand)', live: true },
  enquiries: { key: 'enquiries', label: 'Enquiries received', how: 'typed in by a person under "Add a result": TeamLink does not read enquiries by campaign yet', live: 'manual' },
  reach: { key: 'reach', label: 'Reach and engagement', how: 'comes from the social platform; not connected to the agent yet (a later phase)', live: false },
  siteScore: { key: 'siteScore', label: 'Website score (TeamLink\'s own, out of 100)', how: 'the saved website check; it measures what is on the page, not rankings or traffic', live: true },
  blogs: { key: 'blogs', label: 'Blog briefs planned', how: 'counted from the saved blog plan', live: true },
};
const dayMetrics = (intent) => [METRICS.drafted, METRICS.approved, METRICS.posted, ...(intent === 'enquiries' || intent === 'promote' || intent === 'instagram' ? [METRICS.enquiries] : []), METRICS.reach];

// ---- dates -------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const istDay = (ms) => new Date(ms + IST).toISOString().slice(0, 10);
const validDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && Number.isFinite(Date.parse(`${d}T00:00:00+05:30`));
const validTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));
const addDays = (d, n) => istDay(Date.parse(`${d}T12:00:00+05:30`) + n * DAY_MS);
const atOf = (date, time) => Date.parse(`${date}T${time}:00+05:30`);
const dayWords = (date) => new Date(`${date}T12:00:00+05:30`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

// ---- the facts, ready for the words -------------------------------------------------------------------------------------------------------------------------------------------
function factsOf(ctx) {
  const ind = clip(ctx.industry, 120); const oneInd = ind && !/[,;/&]|\band\b/i.test(ind);
  const svcs = (ctx.services || []).map((s) => clip(s, 60)).filter(Boolean);
  const locs = (ctx.locations || []).map((s) => clip(s, 40)).filter(Boolean);
  const web = clip(ctx.website, 200); const contact = clip(ctx.contactLine, 100);
  const webShort = web.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  const contactBits = [];
  if (contact) contactBits.push(endDot(contact));
  if (web && !contact.toLowerCase().includes(webShort.toLowerCase())) contactBits.push(`Visit ${webShort}.`);
  return {
    name: clip(ctx.name, 80), ind, indL: ind.toLowerCase(), indA: ind ? (oneInd ? article(ind.toLowerCase()) : ind.toLowerCase()) : '', svcs, locs, loc: listText(locs), aud: clip(ctx.audience, 200), about: clip(ctx.about, 400), tagline: clip(ctx.tagline, 120),
    keys: (ctx.keyMessages || []).map((s) => clip(s, 160)).filter(Boolean), web, webShort, contact, cta: contactBits.length ? contactBits.join(' ') : 'Send us a message to know more.', hasContact: !!(contact || web),
    tags: (ctx.hashtags || []).filter(Boolean), avoid: (ctx.avoid || []).filter(Boolean), tone: clip(ctx.tone, 40), language: clip(ctx.language, 20) || 'English',
  };
}
const tagOf = (w) => { const t = `#${clip(w, 40).split(/\s+/).map(cap1).join('').replace(/[^\p{L}\p{N}_]/gu, '')}`; return t.length >= 4 && t.length <= 30 ? t : ''; };
const uniq = (arr) => { const a = arr.filter(Boolean); return a.filter((x, i) => a.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i); };

// ---- the themes of a run of days -------------------------------------------------------------------------------------------------------------------------------------------------
// intro first, contact last, the services in between (main ones first), "why" the day before the contact day. Never more services than the saved ones: gaps are filled with plain
// themes (who we help, where we work, a question), and when even those run out the services come round again with a second angle.
function themesFor(f, n) {
  if (n <= 0) return [];
  if (n === 1) return [{ kind: 'intro' }];
  if (n === 2) return [{ kind: 'intro' }, { kind: 'contact' }];
  const middle = n - 2; const mids = [];
  const why = n >= 5; const slots = middle - (why ? 1 : 0);
  const pool = f.svcs.map((s) => ({ kind: 'service', service: s }));
  if (f.aud) pool.push({ kind: 'audience' });
  f.keys.forEach((m) => pool.push({ kind: 'message', message: m }));
  if (f.locs.length) pool.push({ kind: 'location' });
  f.svcs.forEach((s) => pool.push({ kind: 'question', service: s }));
  if (!f.svcs.length) pool.push({ kind: 'question', service: f.ind || 'what you need' });
  let i = 0; while (mids.length < slots) { mids.push(pool[i % pool.length] || { kind: 'question', service: 'what you need' }); i += 1; }
  const out = [{ kind: 'intro' }, ...mids];
  if (why) out.push({ kind: 'why' });
  out.push({ kind: 'contact' });
  return out.slice(0, n);
}

// words for one theme: headline (on the picture), sub-line, the lines of the caption, the objective, the picture idea
function copyOf(t, f, intent) {
  const enq = intent === 'enquiries';
  const where = f.loc ? ` in ${f.loc}` : '';
  const aud = f.aud ? `your audience (${f.aud})` : 'new people';
  switch (t.kind) {
    case 'intro': return {
      headline: `Meet ${f.name}`, sub: f.ind ? cap1(f.ind) + where : f.tagline,
      lines: [`Meet ${f.name}${f.indA ? `, ${f.indA}${where}` : where}.`, f.about && endDot(f.about), f.aud && `Who we help: ${endDot(f.aud)}`, f.svcs.length && `What we do: ${endDot(listText(f.svcs.slice(0, 4)))}`, 'Follow us to see how we can help.'],
      objective: `Introduce ${f.name} to ${aud} so they know who you are and what you do.`,
      visual: `A friendly, professional scene that welcomes people to ${f.name}${f.ind ? `, ${f.indA}` : ''}.`,
    };
    case 'service': return {
      headline: t.service, sub: `with ${f.name}`,
      lines: [`${t.service} with ${f.name}.`, f.aud && `Who it is for: ${endDot(f.aud)}`, enq ? 'Enquire now.' : `Questions about ${t.service}?`],
      objective: `Show what ${t.service} is and who it is for, and invite questions.`,
      visual: `A simple, realistic picture that stands for ${t.service}.`,
    };
    case 'question': return {
      headline: `Looking for ${t.service}?`, sub: `${f.name} can talk it through`,
      lines: [`Looking for ${t.service}?`, `${f.name} can talk it through with you.`],
      objective: `Start a conversation about ${t.service}.`,
      visual: `A thoughtful person weighing a choice about ${t.service}, calm and friendly mood.`,
    };
    case 'why': return {
      headline: f.indA ? `Why people use ${f.indA}` : `Why choose ${f.name}?`, sub: f.name,
      lines: [f.indA ? `Why do people turn to ${f.indA}?` : `Why choose ${f.name}?`, ...(f.keys.length ? f.keys.slice(0, 3).map((k) => `• ${endDot(k)}`) : [f.svcs.length ? `${f.name} offers ${listText(f.svcs.slice(0, 3))}.` : '']), 'Tell us what you need.'],
      objective: `Explain why people use ${f.indA || 'a specialist'} and invite them to talk.`,
      visual: 'A business owner choosing between doing it alone and getting expert help, trustworthy and calm.',
    };
    case 'audience': return {
      headline: 'Who we work with', sub: f.name,
      lines: [`Who we work with: ${endDot(f.aud)}`, f.svcs.length && `What we do: ${endDot(listText(f.svcs.slice(0, 4)))}`],
      objective: `Show who ${f.name} helps, so the right people recognise themselves.`,
      visual: 'Different people in a simple, respectful group scene that shows who the business helps.',
    };
    case 'message': return {
      headline: clip(t.message, 90), sub: f.name,
      lines: [endDot(t.message), f.svcs.length && `What we do: ${endDot(listText(f.svcs.slice(0, 3)))}`],
      objective: 'Say one of your own key messages, in your own words.',
      visual: `A clean, confident picture that carries the message: ${clip(t.message, 80)}`,
    };
    case 'location': return {
      headline: `Serving ${f.loc}`, sub: f.name,
      lines: [`${f.name} serves ${f.loc}.`, f.svcs.length && `What we do: ${endDot(listText(f.svcs.slice(0, 4)))}`],
      objective: `Tell people in ${f.loc} that ${f.name} serves them.`,
      visual: `A recognisable, friendly street or skyline scene of ${f.loc}, without any real brand names.`,
    };
    default: return { // contact
      headline: `Talk to ${f.name}`, sub: f.hasContact ? '' : 'Send us a message',
      lines: [`Ready to talk? ${f.name} is one message away.`, 'Tell us what you need.', enq ? `Enquire now: ${f.cta}` : f.cta],
      objective: `Turn interest into enquiries: tell people exactly how to reach ${f.name}.`,
      visual: 'A welcoming scene that invites people to get in touch: a phone or message bubble in friendly colours.',
    };
  }
}

// the CTA is part of every caption (a day that has no contact line says "Send us a message")
const withCta = (lines, f, t) => (['service', 'question', 'why'].includes(t.kind) ? [...lines, f.cta] : lines);

function hashtagsFor(f, t, platform) {
  const base = [...f.tags, tagOf(f.name), t.service && tagOf(t.service), f.locs[0] && tagOf(f.locs[0]), f.ind && tagOf(f.ind.split(/[,;/]/)[0]), ...f.svcs.slice(0, 2).map(tagOf)];
  const bad = f.avoid.map((w) => w.toLowerCase());
  return uniq(base).filter((x) => !bad.some((w) => w && x.toLowerCase().includes(w.replace(/\s+/g, '')))).slice(0, TAGS_FOR[platform] || 3);
}
function captionFor(platform, c, f, t) {
  const tags = hashtagsFor(f, t, platform);
  let body = withCta(c.lines.filter(Boolean), f, t).join(platform === 'x' ? ' ' : '\n');
  if (platform === 'x') {
    const tail = tags.length ? ` ${tags.join(' ')}` : '';
    const room = PLATFORM_LIMIT.x - tail.length;
    body = body.length > room ? `${body.slice(0, Math.max(0, room - 1)).trim()}…` : body;
    return { text: `${body}${tail}`.slice(0, PLATFORM_LIMIT.x), tags };
  }
  const full = `${body}${tags.length ? `\n\n${tags.join(' ')}` : ''}`;
  return { text: full.slice(0, PLATFORM_LIMIT[platform] || 3000), tags };
}

// the picture prompt (for AI Images) and the video scenes (for AI Video), in the brand colours, never with text, logos or faces of real people
function promptFor(c, f, ctx, healthcare) {
  const col = ctx.colors || {};
  return clip([
    `A clean, modern marketing picture for ${f.name}${f.ind ? ` (${f.indL})` : ''}.`, c.visual,
    col.primary ? `Use the brand colours ${col.primary}${col.secondary ? ` and ${col.secondary}` : ''}.` : '',
    'Leave empty space for a headline. No words, no logos, no faces of real people.',
    healthcare ? 'No patients, no medical results, no before-and-after.' : '',
  ].filter(Boolean).join(' '), 900);
}
function scenesFor(c, f, t, healthcare) {
  const pts = f.svcs.slice(0, 2);
  const s = [`Scene 1 (hook): ${c.headline}`];
  if (t.kind === 'intro') s.push(`Scene 2: ${f.name}${f.ind ? `, ${f.indA}` : ''}${f.loc ? ` in ${f.loc}` : ''}`);
  else if (t.service) s.push(`Scene 2: ${t.service}${f.aud ? `, for ${f.aud}` : ''}`);
  else s.push(`Scene 2: ${c.sub || f.name}`);
  pts.filter((x) => x !== t.service).forEach((x, i) => s.push(`Scene ${3 + i}: ${x}`));
  s.push(`Scene ${s.length + 1} (call to action): ${f.hasContact ? f.cta : 'Send us a message to know more.'}`);
  return clip(`${s.join('. ')}. Pictures in the brand colours, no real people's faces${healthcare ? ', no patients or medical results' : ''}. Make it in AI Video (Create from a prompt).`, 900);
}

// the wording check (contentGuard.js) on a caption: what it finds that must change (stop) or be checked (review)
function flagsOf(text, industry, healthcare) {
  if (!String(text || '').trim()) return [];
  try {
    const g = Guard.check(text, { industry: Blog.guessIndustry(industry), healthcare: !!healthcare });
    return (g.findings || []).filter((x) => x.level === 'stop' || x.level === 'review').slice(0, 4).map((x) => ({ level: x.level, id: x.id, match: clip(x.match, 60), why: clip(x.why, 160) }));
  } catch { return []; } // the wording check is a courtesy
}

// ---- the days / videos ------------------------------------------------------------------------------------------------------------------------------------------------------------
function buildDays(intent, f, ctx, p, healthcare) {
  const videos = intent === 'videos'; const n = videos ? Math.max(1, Math.min(5, p.count || p.days || 3)) : p.days;
  const themes = themesFor(f, n); const start = p.startDate; const days = []; const step = videos ? 2 : 1;
  themes.forEach((t, i) => {
    const c = copyOf(t, f, intent); const date = addDays(start, i * step); const time = p.time;
    const texts = {}; const tagsAll = [];
    p.platforms.forEach((pl) => { const x = captionFor(pl, c, f, t); texts[pl] = x.text; x.tags.forEach((g) => tagsAll.push(g)); });
    const flags = flagsOf(texts[p.platforms[0]] || '', f.ind, healthcare);
    const size = p.platforms.includes('instagram') || p.platforms.includes('facebook') ? (videos ? '9:16' : '1:1') : '16:9';
    days.push({
      n: i + 1, kind: videos ? 'video' : 'post', date, time, atMs: atOf(date, time), label: `${dayWords(date)}, ${time} IST`,
      theme: t.kind, service: t.service || '', title: clip(videos ? `Video ${i + 1}: ${c.headline}` : `Day ${i + 1}: ${c.headline}`, 80), headline: clip(c.headline, 90), sub: clip(c.sub, 80),
      contentType: videos ? 'Short video (Reel, 20 to 30 seconds)' : (p.platforms.length === 1 && p.platforms[0] === 'x' ? 'Text post with a picture' : 'Image post'),
      objective: c.objective, audience: f.aud || 'People who may need what you offer (no audience saved)', platforms: p.platforms.slice(), texts, hashtags: uniq(tagsAll),
      mediaPrompt: videos ? scenesFor(c, f, t, healthcare) : promptFor(c, f, ctx, healthcare), bannerSize: size,
      metrics: dayMetrics(intent), flags,
    });
  });
  return days;
}

function strategyOf(f, ctx, p, days) {
  const sec = []; const pl = p.platforms.map((x) => PLATFORM_WORDS[x]);
  sec.push({ title: 'Who you are', points: [f.name + (f.ind ? `: ${f.ind}` : ''), f.about, f.tagline && `Tagline: ${f.tagline}`, ...f.keys.map((k) => `Key message: ${k}`)].filter(Boolean) });
  sec.push({ title: 'Who you want to reach', points: [f.aud ? `Audience: ${f.aud}` : 'No audience saved yet.', f.locs.length ? `Where: ${f.loc}` : 'No location saved yet.'] });
  sec.push({ title: 'What you offer (the content pillars)', points: f.svcs.length ? f.svcs.map((s) => `${s}: a post that says what it is and who it is for`) : ['No services saved yet.'] });
  sec.push({ title: 'Where to start (a starting suggestion, to adjust with real results)', points: [`${pl.join(', ')}.`, p.platforms.includes('linkedin') ? 'LinkedIn suits posts aimed at other businesses.' : '', 'Instagram and Facebook suit pictures and short videos.', 'Start with one post a day for a week, then look at what was approved, posted and answered before planning the next block.'].filter(Boolean) });
  sec.push({ title: 'The first week', points: days.map((d) => `${d.label.split(',')[0]}: ${d.headline} (${d.theme})`) });
  sec.push({ title: 'How success is measured', points: ['Today TeamLink counts: drafts made, approved, posted (marked by a person), website score if a check is run.', 'A person types in enquiries received; reach and engagement from the platforms are not connected yet.', 'No target numbers are set here, because TeamLink does not know your past results. Add real numbers under "Add a result" after the week.'] });
  return sec;
}

// ---- the whole plan ---------------------------------------------------------------------------------------------------------------------------------------------------------------
const CONSEQUENCE = {
  contactLine: 'the calls to action say "Send us a message" without a number or address',
  audience: 'captions do not say who the posts are for',
  locations: 'captions do not mention a place',
  about: 'the introduction uses only the name, what you do and your services',
  industry: 'captions do not say what kind of business this is',
  services: 'there is nothing to promote by name',
  keyMessages: 'no key messages are quoted',
};
// defaults for the controls on the preview
function paramsFor(parsed, given = {}, now = Date.now()) {
  const def = INTENTS[parsed.intent];
  const g = given && typeof given === 'object' ? given : {};
  let days = Math.round(Number(g.days)); if (!Number.isFinite(days) || days < 1) days = parsed.days; days = Math.min(MAX_DAYS, Math.max(1, days));
  let platforms = (Array.isArray(g.platforms) ? g.platforms : parsed.platforms).filter((x) => PLATFORM_WORDS[x]).filter((x, i, a) => a.indexOf(x) === i);
  if (!platforms.length) platforms = def.platforms.slice();
  const tomorrow = addDays(istDay(now), 1);
  const startDate = validDay(g.startDate) && g.startDate >= istDay(now) ? g.startDate : tomorrow;
  return {
    days: def.days === 0 ? 0 : days, platforms, startDate, time: validTime(g.time) ? g.time : '10:00',
    creative: ['banner', 'ai', 'none'].includes(g.creative) ? g.creative : 'banner', publish: g.publish === 'agent' ? 'agent' : 'manual', approver: g.approver === 'client' ? 'client' : 'team', count: Math.max(1, Math.min(5, Math.round(Number(g.count)) || (parsed.intent === 'videos' ? parsed.days : 3))),
  };
}

// -> { parsed, questions, plan | null }. questions: required ones block the plan (plan is null); optional ones are listed beside the plan.
function build(goalText, ctxIn, given = {}, now = Date.now()) {
  const parsed = parse(goalText); const def = INTENTS[parsed.intent];
  const ctx = { ...ctxIn };
  const hints = {}; if (parsed.hint) hints.industry = cap1(parsed.hint);
  const askAll = Ctx.missing(ctx, def.essentials, def.optional, hints);
  const questions = askAll;
  const blocked = askAll.some((q) => q.required);
  if (blocked) return { parsed, questions, plan: null };
  const p = paramsFor(parsed, given, now);
  const f = factsOf(ctx);
  const healthcare = Packs.isHealthcare(Blog.guessIndustry(f.ind));
  const gaps = []; const assumptions = [];
  for (const k of [...def.essentials, ...def.optional]) if (!(Array.isArray(ctx[k]) ? ctx[k].length : ctx[k]) && CONSEQUENCE[k]) gaps.push(`${Ctx.FIELDS[k].label} not saved: ${CONSEQUENCE[k]}.`);
  if (healthcare) gaps.push('Healthcare business: a doctor or qualified medical reviewer must read every caption before it is approved. The wording check below is a starting checklist only.');
  if (f.language !== 'English') assumptions.push(`Captions are written in English; ${f.language} is saved for this business, so have them translated and read before approving.`);
  assumptions.push('Every caption is built only from the facts saved for this business. Nothing is added: no prices, years, awards, results or promises.');
  assumptions.push(`The posting time (${p.time} IST) is a suggestion: change it before approving.`);

  const base = { intent: parsed.intent, intentLabel: def.label, goalText: parsed.text, businessName: f.name, params: p, gaps, assumptions, healthcare, goalType: def.goal, clamped: parsed.clamped };
  if (parsed.intent === 'seo') {
    const url = ctx.website;
    return { parsed, questions, plan: { ...base, title: `Improve the website SEO of ${f.name}`, objective: `Find what is missing on ${f.webShort || 'the website'} and plan this month's blog posts, using only what is really on the page.`, days: [], seo: { url, pages: 5 },
      metrics: [METRICS.siteScore, METRICS.blogs, METRICS.reach],
      assumptions: [...assumptions.filter((x) => !/posting time/.test(x)), 'The check reads the website once (up to 5 pages), with plain code. It measures what is on the page, not rankings, traffic or what search engines or AI assistants say.', 'Nothing on the website is changed by the agent: fixes are done by the people who run the website.'], strategy: null } };
  }
  const days = buildDays(parsed.intent, f, ctx, p, healthcare);
  const title = `${def.verb} ${f.name}${parsed.intent === 'videos' ? `: ${days.length} video${days.length === 1 ? '' : 's'}` : `: ${days.length} day${days.length === 1 ? '' : 's'}`}`;
  const objective = {
    promote: `Make ${f.aud ? `your audience (${f.aud})` : 'the right people'} aware of ${f.name} and what it offers, one clear message a day, ending with how to reach you.`,
    instagram: `Run a ${days.length}-day Instagram campaign for ${f.name}: one clear post a day, ending with how to reach you.`,
    enquiries: `Bring in enquiries for ${f.name}: every post ends with exactly how to enquire.`,
    videos: `Prepare ${days.length} short promotional video${days.length === 1 ? '' : 's'} for ${f.name}: script, cover picture and caption for each.`,
    strategy: `A complete starting strategy for ${f.name}, with the first week ready to run.`,
  }[parsed.intent];
  return { parsed, questions, plan: { ...base, title, objective, days, strategy: parsed.intent === 'strategy' ? strategyOf(f, ctx, p, days) : null, metrics: [METRICS.drafted, METRICS.approved, METRICS.posted, METRICS.enquiries, METRICS.reach] } };
}

// ---- the executable steps ---------------------------------------------------------------------------------------------------------------------------------------------------------
// [{ n, day, tool, title, deps: [n] }] in the order they run. Day steps: draft -> creative -> ask for approval (needs the draft) -> a person's step (post / make the video).
const MAX_TASKS = 70;
const SOCIAL = ['instagram', 'facebook', 'x']; // the platforms TeamLink can post to (postItem.js); LinkedIn and the rest are posted by hand
function taskSpecs(plan) {
  const specs = []; const add = (s) => { specs.push({ n: specs.length + 1, day: null, deps: [], ...s }); return specs.length; };
  if (plan.intent === 'seo') {
    const a = add({ tool: 'seo.sitecheck', title: `Check the website ${plan.seo.url} (up to ${plan.seo.pages} pages)` });
    add({ tool: 'seo.blogplan', title: "Plan this month's blog posts (briefs only, nothing is written or posted)" });
    add({ tool: 'manual.note', title: 'Go through the website check with the person who runs the website and agree the fixes', deps: [a], note: 'The agent does not change the live website.' });
    return specs;
  }
  const mode = plan.params.creative; const hasPic = mode !== 'none';
  const clientAsks = plan.params.approver === 'client' && plan.businessKey && plan.businessKey !== 'own' && hasPic; // the client decides on the picture (WhatsApp, after your approval of the step)
  const agentPosts = plan.params.publish === 'agent' && hasPic; // TeamLink posts after your approval of each post
  for (const d of plan.days) {
    const label = d.title.split(':')[0];
    const draft = add({ tool: 'content.draft', day: d.n, title: `${label}: write the draft in AI Content` });
    const pic = hasPic ? add({ tool: mode === 'ai' ? 'image.ai' : 'image.banner', day: d.n, title: `${label}: ${mode === 'ai' ? 'make the picture with AI (free tier)' : 'design the banner (free)'}` }) : 0;
    const ask = clientAsks
      ? add({ tool: 'client.review', day: d.n, deps: [draft, pic], title: `${label}: send the picture and caption to the client to approve (you confirm who it goes to)` })
      : add({ tool: 'approval.request', day: d.n, deps: [draft], title: `${label}: ask the team to approve` });
    if (d.kind === 'video') { add({ tool: 'manual.video', day: d.n, deps: [ask], title: `${label}: make the video in AI Video from the scenes` }); continue; } // eslint-disable-line no-continue
    const social = d.platforms.filter((x) => SOCIAL.includes(x)); const rest = d.platforms.filter((x) => !SOCIAL.includes(x));
    if (agentPosts && social.length) {
      add({ tool: 'social.post', day: d.n, deps: [ask, pic], title: `${label}: post on ${listText(social.map((x) => PLATFORM_WORDS[x]))} at ${d.time} on ${d.date} (after you approve this post)` });
      if (rest.length) add({ tool: 'manual.post', day: d.n, deps: [ask], title: `${label}: post on ${listText(rest.map((x) => PLATFORM_WORDS[x]))} at ${d.time}, after it is approved (by hand)` });
    } else add({ tool: 'manual.post', day: d.n, deps: [ask], title: `${label}: post on ${listText(d.platforms.map((x) => PLATFORM_WORDS[x]))} at ${d.time}, after it is approved (by hand)` });
  }
  return specs.slice(0, MAX_TASKS);
}

module.exports = { SOCIAL, flagsOf, INTENTS, EXAMPLES, METRICS, PLATFORM_WORDS, PLATFORM_LIMIT, MAX_DAYS, parse, build, taskSpecs, factsOf, paramsFor, captionFor, copyOf, themesFor, dayWords, atOf, istDay, validDay, validTime, addDays, listText };
