// ---------------------------------------------------------------------------
// AI MARKETING > "✨ AI Assist" on the YOUR IDEA OR CONCEPT box of AI Images and AI Video (2026-11-24).
// Owner: "in your idea or concept add an AI Assist button which generates the concept or idea automatically from the title, like the AI Assist in Employee Services > Timesheet >
// checklist; now add it for AI Image and AI Video". The person writes a title (or a few words, or nothing but a client project's brief is open); this writes the one to three
// sentences that go in the idea box, which the studio (autostudio.js plan) then turns into the pictures / the video. It only FILLS THE BOX for the person to read and change: nothing is
// saved, made or sent. It never invents prices, offers, dates, phone numbers or facts. Whatever is already in the box is kept and improved. It goes through the shared AI layer
// (ai.js): the person's daily limit, the company limit, the usage log (module "studio", task "idea") and the plain "AI is not ready" words.
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const A = require('../outreach/access');
const AI = require('./ai');
const Cfg = require('./settings');

const mayWrite = (u) => A.has('mayAiMarketing')(u);
const WHAT = { video: 'a short video', post: 'a picture post' };
const one = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);

// the client project's own name and brief (when the screen is open for a client project): the client, not our company, is who it is for
async function projectOf(id) {
  const pid = S.clip(id, 40);
  if (!pid) return null;
  try { return (await S.q('SELECT clientName, occasion, brief FROM "OmniMkProject" WHERE id = ? AND deletedAt IS NULL', pid))[0] || null; } catch { return null; }
}

// b: { kind: 'video' | 'post', title, heading, content, idea (what is in the box now), clientName (the client chosen for sending), projectId, department }
async function ideaAssist(u, b = {}) {
  if (!mayWrite(u)) return { error: 'Your login can look at AI Marketing but not use it to create.', status: 403 };
  const kind = b.kind === 'post' ? 'post' : 'video';
  const title = one(b.title, 80); const heading = one(b.heading, 80); const content = one(b.content, 300); const own = one(b.idea, 800);
  const project = await projectOf(b.projectId);
  const projectBrief = project ? one(project.brief, 500) : '';
  const topic = title || heading || content || (project ? one(`${project.occasion || ''}`, 120) : '');
  if (topic.length < 2 && own.length < 4 && projectBrief.length < 10) return { error: 'Type a title first (or a few words in the idea box), so the AI knows the topic.', status: 400 };
  const brand = await Cfg.getBrand();
  const who = (project && project.clientName) || one(b.clientName, 120) || brand.brandName || 'our company';
  const what = WHAT[kind];
  const system = [
    `You write the YOUR IDEA OR CONCEPT line for ${what}: the short request a creative team reads before they make it.`,
    'Write one to three plain sentences, under 450 characters: what to make, who it is for, the message and the mood. No headings, no lists, no markdown, no quotation marks around it.',
    'Example of the style: A Diwali offer video for our software clients, friendly and festive.',
    'Build it from the title the person gave. NEVER invent prices, discounts, offers, dates, phone numbers, addresses, awards, statistics or other facts: if something is not given, leave it out.',
    !project && brand.about ? `About the company: ${brand.about}` : '', !project && brand.audience ? `The company talks to: ${brand.audience}.` : '',
    `It is for ${who}${brand.tone && !project ? `; keep a ${brand.tone} tone` : ''}${brand.language && brand.language !== 'English' ? `; write in ${brand.language}` : ''}.`,
    ...(brand.avoidWords && brand.avoidWords.length ? [`Never use these words: ${brand.avoidWords.join(', ')}.`] : []),
    'Answer only as JSON: {"idea": "the text"}.',
  ].filter(Boolean).join('\n');
  const given = [
    title ? `Title: ${title}` : '', heading ? `Heading: ${heading}` : '', content ? `Content the person wrote: ${content}` : '',
    project ? `Client project: ${project.clientName}${project.occasion ? `, ${project.occasion}` : ''}` : '', projectBrief ? `The client's brief: ${projectBrief}` : '',
  ].filter(Boolean).join('\n');
  const prompt = `${given || 'No title was given.'}\nIt is for: ${who}\nThey want: ${what}${own ? `\n\nThe person already wrote this in the idea box (keep its facts, improve and complete it):\n${own}` : ''}`;
  let r;
  try {
    // quickMs: nginx gives up at 60 seconds and the one small model is shared with the WhatsApp assistant (it was live 20 to 50 seconds and sometimes refused while busy), so the AI gets 40 seconds and a miss is said in words, never a gateway error
    r = await AI.generate({ user: u, module: 'studio', task: 'idea', system, prompt, json: true, quickMs: 40000, demo: () => ({ idea: `SAMPLE (test mode, not written by AI): ${what} about ${topic || 'the client\'s brief'} for ${who}, clear and friendly.` }), department: S.clip(b.department, 60) || undefined });
  } catch (e) {
    if (e.code === 'timeout') return { error: 'The AI is slow right now. Try again in a moment, or write the idea yourself.', status: 504, code: 'timeout' };
    return { error: e.message, status: e.status || 503, code: e.code };
  }
  let text = r.result && typeof r.result === 'object' ? (r.result.idea || r.result.text || r.result.concept || '') : String(r.result || '');
  text = String(text).replace(/\*\*|__|^#+\s*/gm, '').replace(/\s*\n+\s*/g, ' ').replace(/^["'“‘]+|["'”’]+$/g, '').replace(/\s+/g, ' ').trim();
  if (text.length < 15) return { error: 'The AI did not write anything useful. Try again, or write the idea yourself.', status: 502, code: 'empty' };
  text = S.clip(text, 780);
  const flags = (brand.avoidWords || []).filter((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(text));
  return { idea: text, demo: !!r.demo, provider: r.provider || '', flags };
}

module.exports = { ideaAssist };
