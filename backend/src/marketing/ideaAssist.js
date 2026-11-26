// ---------------------------------------------------------------------------
// AI MARKETING > "✨ AI Assist" on the YOUR IDEA OR CONCEPT box of AI Images and AI Video (2026-11-24).
// Owner: "in your idea or concept add an AI Assist button which generates the concept or idea automatically, like the AI Assist in Employee Services > Timesheet > checklist" and then
// "if we give some content the AI should write the idea from the content, and give me several lines (the topic and the points) so the video is made better".
// So it writes a short DESCRIPTION, not one line:   Topic: ...   Points: (3 to 5 lines)   Mood: ...   Call to action: ...   built from the content the person wrote (else the title / heading, else the
// open client project's brief). The studio (autostudio.js plan) then makes the pictures / the video from that description. It only FILLS THE BOX for the person to read and change: nothing is
// saved, made or sent. It never invents prices, offers, dates, phone numbers or facts. Whatever is already in the box is kept and improved. It goes through the shared AI layer (ai.js): the
// person's daily limit, the company limit, the usage log (module "studio", task "idea") and the plain "AI is not ready" words.
// 2026-11-26 (owner: "why 40 seconds?"): it asks the fast writer first (marketing/fastText.js, the free Cloudflare model the pictures already use): a few seconds. If that fails, the draft from the
// person's own words comes at once; only when there is nothing to lay out (a title alone) is the app's own slower model asked instead.
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const A = require('../outreach/access');
const AI = require('./ai');
const Cfg = require('./settings');
const SP = require('./scriptParse');

const mayWrite = (u) => A.has('mayAiMarketing')(u);
const WHAT = { video: 'a short video', post: 'a picture post' };
const MAX = 780; // the idea box holds 800 characters
const one = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);
// text that keeps its line breaks (the content the person wrote is one line per picture)
const lines = (v, n) => String(v || '').replace(/\r/g, '').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n').slice(0, n);

// the client project's own name and brief (when the screen is open for a client project): the client, not our company, is who it is for
async function projectOf(id) {
  const pid = S.clip(id, 40);
  if (!pid) return null;
  try { return (await S.q('SELECT clientName, occasion, brief FROM "OmniMkProject" WHERE id = ? AND deletedAt IS NULL', pid))[0] || null; } catch { return null; }
}

// a model answer in any of its usual shapes -> clean plain lines: the text, a list of lines, or {topic, points[], mood, cta}
function textOf(res) {
  let v = res && typeof res === 'object' && !Array.isArray(res) ? (res.idea ?? res.text ?? res.concept ?? res.description ?? res) : res;
  if (Array.isArray(v)) v = v.map((x) => (typeof x === 'string' ? x : '')).join('\n');
  if (v && typeof v === 'object') {
    const pts = Array.isArray(v.points) ? v.points : (v.points ? [v.points] : []);
    v = [v.topic ? `Topic: ${v.topic}` : '', pts.length ? `Points:\n${pts.map((p) => `- ${p}`).join('\n')}` : '', v.mood ? `Mood: ${v.mood}` : '', v.cta || v.callToAction ? `Call to action: ${v.cta || v.callToAction}` : ''].filter(Boolean).join('\n');
  }
  return String(v || '');
}
function tidy(raw) {
  const out = String(raw).replace(/\r/g, '').replace(/\*\*|__/g, '').split('\n')
    .map((l) => l.replace(/^\s*#+\s*/, '').replace(/^\s*(?:[•·▪●◦*–—]|\d+[.)])\s+/, '- ').replace(/[ \t]+/g, ' ').trim())
    .map((l) => l.replace(/^["'“‘]+|["'”’]+$/g, '').trim()).filter(Boolean);
  let text = out.join('\n').replace(/^(Points:)[ \t]*-[ \t]+/im, '$1\n- '); // the model often puts the first point on the "Points:" line
  if (text.length > MAX) { // cut at the last whole line that fits (never in the middle of a point)
    const keep = []; let n = 0;
    for (const l of out) { if (n + l.length + 1 > MAX) break; keep.push(l); n += l.length + 1; }
    text = keep.length >= 2 ? keep.join('\n') : text.slice(0, MAX);
  }
  return text.trim();
}

// The one small model on this server often ignores the layout and answers in ONE paragraph (live 24 Nov: "At TeamLink, we connect freshers... Send your CV today."). The owner wants several lines (the
// topic and the points), so a paragraph is laid out here: the first sentence is the topic, the other sentences are the points; when there are too few, the points come from the person's own
// content (the voice-over lines of a pasted script, else its lines). Nothing is invented: every word is the model's or the person's.
const hasLayout = (t) => /^Topic:/im.test(t) && /^Points:/im.test(t) && (t.match(/^- /gm) || []).length >= 2;
const stripLabels = (t) => t.replace(/^(?:Topic|Points|Mood|Call to action)\s*:\s*/gim, '');
const sentences = (t) => (String(t).replace(/\s+/g, ' ').match(/[^.!?]+[.!?]*/g) || []).map((s) => s.trim()).filter((s) => s.length > 3);
const noStop = (s) => s.replace(/[.!?\s]+$/, '').slice(0, 110);
function structure(text, content) {
  if (hasLayout(text)) return text;
  const sents = sentences(stripLabels(text).replace(/\n+/g, ' '));
  if (!sents.length) return text;
  const topic = noStop(sents[0]);
  const pts = sents.slice(1, 6).map(noStop);
  if (pts.length < 3 && content) { // too few points: the person's own content gives the rest (a script's titles or voice-over lines, else its lines), each once
    const script = SP.parseScript(content);
    const own = (script ? script.map((s) => s.caption || s.say) : String(content).split('\n').map((l) => SP.plain(l))).map(noStop).filter((l) => l.length > 3);
    const seen = new Set(pts.concat(topic).map((p) => p.toLowerCase()));
    for (const o of own) { if (pts.length >= 5) break; if (!seen.has(o.toLowerCase())) { pts.push(o); seen.add(o.toLowerCase()); } }
  }
  if (pts.length < 2) return text;
  return [`Topic: ${topic}`, 'Points:', ...pts.map((p) => `- ${p}`)].join('\n');
}

// When the AI cannot answer in time (the one small model is shared with the WhatsApp assistant: live 24 Nov it took 20 seconds, 40 seconds, or refused), the person still gets a DRAFT made only
// from their own words: the topic from the title (or the first content line) and the points from their content lines (a pasted script's titles). Said in words, never passed off as AI. Needs
// at least two points of their own: with just a title there is nothing to lay out and the plain "AI is slow" message stays.
function fromOwnWords({ title, heading, content, who, thing }) {
  const script = SP.parseScript(content);
  const own = (script ? script.map((s) => s.caption || s.say) : String(content || '').split('\n').map((l) => SP.plain(l))).map(noStop).filter((l) => l.length > 3);
  const head = noStop(SP.plain(title || heading || ''));
  const topicText = head || own[0] || '';
  const pts = own.filter((l) => l.toLowerCase() !== topicText.toLowerCase()).slice(0, 5);
  if (!topicText || pts.length < 2) return null;
  return [`Topic: A ${thing} about ${topicText}${who && who !== 'our company' ? `, for ${who}` : ''}`, 'Points:', ...pts.map((p) => `- ${p}`)].join('\n');
}

// b: { kind: 'video' | 'post', title, heading, content, idea (what is in the box now), clientName (the client chosen for sending), projectId, department }
async function ideaAssist(u, b = {}) {
  if (!mayWrite(u)) return { error: 'Your login can look at AI Marketing but not use it to create.', status: 403 };
  const kind = b.kind === 'post' ? 'post' : 'video';
  const title = one(b.title, 80); const heading = one(b.heading, 80); const content = lines(b.content, 1200); const own = lines(b.idea, 800);
  const project = await projectOf(b.projectId);
  const projectBrief = project ? one(project.brief, 500) : '';
  const topic = title || heading || one(content, 120) || (project ? one(`${project.occasion || ''}`, 120) : '');
  if (topic.length < 2 && own.length < 4 && projectBrief.length < 10) return { error: 'Write a title or some content first (or a few words in the idea box), so the AI knows the topic.', status: 400 };
  const brand = await Cfg.getBrand();
  const who = (project && project.clientName) || one(b.clientName, 120) || brand.brandName || 'our company';
  const what = WHAT[kind];
  const thing = kind === 'video' ? 'video' : 'post';
  const system = [
    `You write the YOUR IDEA OR CONCEPT text for ${what}: the description that a creative team, and the maker of the ${thing}, read before making it. It is NOT one line: it gives the topic and the main points, so the ${thing} comes out well.`,
    `Write 5 to 8 short lines, under ${MAX - 80} characters in all, plain text (no markdown, no asterisks, no numbering), in exactly this layout:`,
    `Topic: one sentence saying what the ${thing} is about and who it is for.`,
    `Points:`,
    `- three to five short key points the ${thing} should say or show, one per line, each starting with "- "`,
    'Mood: the look and feel in a few words.',
    'Call to action: the one thing the viewer should do (write this line only if it is given or obvious; otherwise leave it out).',
    'Example of the layout, about a different topic (copy the layout, never its words):',
    'Topic: A short video about a weekend cake sale at a neighbourhood bakery, for families nearby.',
    'Points:',
    '- Fresh cakes baked every morning',
    '- Three flavours to choose from',
    '- Come in this Saturday and Sunday',
    'Mood: warm and cheerful',
    'Call to action: Visit the bakery this weekend',
    'Do NOT answer with one paragraph: always use the lines Topic:, Points:, Mood:, as in the example.',
    `If the person wrote CONTENT (the scenes, lines or voice-over), BASE the topic and the points on that content: keep its messages and its order, do not contradict it and do not copy it word for word. With no content, build it from the title.`,
    'NEVER invent prices, discounts, offers, dates, phone numbers, addresses, awards, statistics or other facts: if something is not given, leave it out.',
    !project && brand.about ? `About the company: ${brand.about}` : '', !project && brand.audience ? `The company talks to: ${brand.audience}.` : '',
    `It is for ${who}${brand.tone && !project ? `; keep a ${brand.tone} tone` : ''}${brand.language && brand.language !== 'English' ? `; write in ${brand.language}` : ''}.`,
    ...(brand.avoidWords && brand.avoidWords.length ? [`Never use these words: ${brand.avoidWords.join(', ')}.`] : []),
    'Answer only as JSON: {"idea": "the whole text, with the lines separated by \\n"}.',
  ].filter(Boolean).join('\n');
  const given = [
    title ? `Title: ${title}` : '', heading ? `Heading: ${heading}` : '', content ? `Content the person wrote:\n${content}` : '',
    project ? `Client project: ${project.clientName}${project.occasion ? `, ${project.occasion}` : ''}` : '', projectBrief ? `The client's brief: ${projectBrief}` : '',
  ].filter(Boolean).join('\n');
  const prompt = `${given || 'No title was given.'}\nIt is for: ${who}\nThey want: ${what}${own ? `\n\nThe person already wrote this in the idea box (keep its facts, improve and complete it in the layout above):\n${own}` : ''}`;
  const ask = (more) => AI.generate({ user: u, module: 'studio', task: 'idea', system, prompt, json: true, demo: () => ({ idea: `SAMPLE (test mode, not written by AI)\nTopic: ${what} about ${topic || 'the client\'s brief'} for ${who}.\nPoints:\n- One clear message\n- A friendly, simple tone\n- A clear next step for the viewer` }), department: S.clip(b.department, 60) || undefined, ...more });
  let r;
  try {
    // quickMs: nginx gives up at 60 seconds. The fast writer has 12 seconds; the app's own small model is shared with the WhatsApp assistant (it was live 20 to 50 seconds and sometimes refused while busy), so it gets 40 seconds alone, 35 after a fast miss, and a miss is said in words, never a gateway error
    try { r = await ask({ fast: { plain: 'idea' }, quickMs: 40000 }); } catch (e) {
      if (!e.fast || fromOwnWords({ title, heading, content, who, thing })) throw e;
      r = await ask({ quickMs: 35000 });
    }
  } catch (e) {
    if (e.fast || ((e.code === 'timeout' || e.code === 'failed' || e.code === 'unavailable' || e.code === 'unreadable') && e.status !== 403 && e.status !== 429)) { // a limit or a refused login is shown as it is; a slow or failed AI gives a draft from the person's own words
      const draft = fromOwnWords({ title, heading, content, who, thing });
      const why = e.code === 'provider_daily' ? 'Today\'s free AI allowance is used up' : 'The AI is busy right now';
      if (draft) return { idea: tidy(draft), demo: false, provider: 'own words', flags: [], fallback: true, note: `${why}, so TeamLink laid out your own words (the title and the lines of your content) as the topic and the points. Read it, change anything, or press AI Assist again for the AI to write it.` };
    }
    if (e.code === 'timeout') return { error: 'The AI is slow right now. Try again in a moment, or write the idea yourself.', status: 504, code: 'timeout' };
    return { error: e.message, status: e.status || 503, code: e.code };
  }
  const text = tidy(structure(tidy(textOf(r.result)), content));
  if (text.length < 15) return { error: 'The AI did not write anything useful. Try again, or write the idea yourself.', status: 502, code: 'empty' };
  const flags = (brand.avoidWords || []).filter((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(text));
  return { idea: text, demo: !!r.demo, provider: r.provider || '', flags };
}

module.exports = { ideaAssist, tidy, textOf, structure };
