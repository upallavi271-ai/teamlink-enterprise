// ---------------------------------------------------------------------------
// AI MARKETING > CLIENT PROJECTS (2026-11-14). The real agency workflow, in one place:
//   1 request   a client asks for a creative (for example "a Diwali video with our logo") by email, WhatsApp, phone or in our portal. The team logs it here, or
//               sends the client a private REQUEST LINK (status 'invited') and the client fills the brief, their social pages and their logo themselves.
//   2 accept    the team accepts the request (it gets an owner) or declines it with a reason.
//   3 work      the team makes pictures / videos in AI Images and AI Video (the project's logo and colours are used) and PICKS several as OPTIONS.
//   4 present   one private link shows ALL the options to the client. The client picks ONE and may add suggestions, or asks for changes with suggestions.
//               The client's pick IS the approval: the chosen picture / video becomes Approved by the client; the others go back to Drafts.
//   5 post      the approved creative is posted on the client's social pages: the caption, the file and the Calendar are ready; "Mark as posted" ends the project.
//   The client's link is one page for the whole life of the project: the request form, then the progress, then the options, then the final result.
// status    invited -> request -> working -> awaiting_client -> approved -> posted     (declined from request / working)
// link      /client-project/<id>.<signature>: HMAC of the id, nothing secret is stored; options are served by option id (never an item id or a file path).
// money     none: nothing here calls a paid service.
// audit     every step is in the audit log ("Omni-Channel AI Marketing: project ...") and in the project's own timeline.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const S = require('../outreach/store');
const A = require('../outreach/access');
const AI = require('./ai');
const Cfg = require('./settings');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');

const T = 'OmniMkProject'; const TO = 'OmniMkProjectOption'; const TE = 'OmniMkProjectEvent';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${T}" ("id" TEXT NOT NULL PRIMARY KEY, "title" TEXT NOT NULL DEFAULT '', "clientId" TEXT, "clientName" TEXT NOT NULL DEFAULT '', "contactName" TEXT, "contactEmail" TEXT, "contactPhone" TEXT, "source" TEXT NOT NULL DEFAULT 'other', "occasion" TEXT, "brief" TEXT, "deliverable" TEXT NOT NULL DEFAULT 'video', "platforms" TEXT NOT NULL DEFAULT '[]', "handles" TEXT, "caption" TEXT, "dueDate" TEXT, "status" TEXT NOT NULL DEFAULT 'request', "logoData" TEXT, "colors" TEXT, "department" TEXT, "ownerId" TEXT, "ownerName" TEXT, "createdById" TEXT, "createdByName" TEXT, "acceptedAt" DATETIME, "acceptedByName" TEXT, "round" INTEGER NOT NULL DEFAULT 0, "linkExpiresAt" DATETIME, "clientMessage" TEXT, "chosenOptionId" TEXT, "decidedAt" DATETIME, "decidedByName" TEXT, "decisionNote" TEXT, "scheduledFor" TEXT, "postUrl" TEXT, "postedAt" DATETIME, "postedByName" TEXT, "declinedNote" TEXT, "views" INTEGER NOT NULL DEFAULT 0, "viewedAt" DATETIME, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0, "deletedAt" DATETIME)`,
  `CREATE INDEX IF NOT EXISTS "${T}_status" ON "${T}"("status", "updatedAt")`,
  `CREATE TABLE IF NOT EXISTS "${TO}" ("id" TEXT NOT NULL PRIMARY KEY, "projectId" TEXT NOT NULL, "round" INTEGER NOT NULL DEFAULT 1, "itemId" TEXT NOT NULL, "label" TEXT NOT NULL DEFAULT '', "sortNo" INTEGER NOT NULL DEFAULT 0, "createdAt" DATETIME NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS "${TO}_project" ON "${TO}"("projectId", "round")`,
  `CREATE TABLE IF NOT EXISTS "${TE}" ("id" TEXT NOT NULL PRIMARY KEY, "projectId" TEXT NOT NULL, "at" DATETIME NOT NULL DEFAULT 0, "kind" TEXT NOT NULL, "byName" TEXT, "text" TEXT)`,
  `CREATE INDEX IF NOT EXISTS "${TE}_project" ON "${TE}"("projectId", "at")`,
];
let okAt = 0;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  try {
    for (const sql of DDL) await S.run(sql); // eslint-disable-line no-await-in-loop
    // the portfolio flags (2026-11-14): "the client agrees we show this work", its public title, and whether the client's name may be shown
    // automatic posting (2026-11-14): on/off, the client's accounts [{accountId, platform, name}], when, its state, what happened per account, the https site address Meta fetches the media from
    for (const col of ['"autoPost" INTEGER NOT NULL DEFAULT 0', '"autoTargets" TEXT', '"autoAt" DATETIME', '"autoState" TEXT', '"autoResult" TEXT', '"autoBase" TEXT']) { try { await S.run(`ALTER TABLE "${T}" ADD COLUMN ${col}`); } catch { /* the column is already there */ } } // eslint-disable-line no-await-in-loop
    // 2026-11-21: the client's permission to post by itself (ticked on the approve form): when, who, and which accounts (ids) it covers
    for (const col of ['"postConsentAt" DATETIME', '"postConsentBy" TEXT', '"postConsentIds" TEXT']) { try { await S.run(`ALTER TABLE "${T}" ADD COLUMN ${col}`); } catch { /* the column is already there */ } } // eslint-disable-line no-await-in-loop
    for (const col of ['"showcase" INTEGER NOT NULL DEFAULT 0', '"showcaseTitle" TEXT', '"showcaseClient" INTEGER NOT NULL DEFAULT 0']) { try { await S.run(`ALTER TABLE "${T}" ADD COLUMN ${col}`); } catch { /* the column is already there */ } } // eslint-disable-line no-await-in-loop
    // 2026-11-21: the client's last answer (approved / rejected, with the reason) so the project shows a clear stage, whichever way the answer came (page, WhatsApp button, email)
    try { await S.run(`ALTER TABLE "${T}" ADD COLUMN "draftPlan" TEXT`); } catch { /* the column is there already */ }
    for (const col of ['"clientAnswer" TEXT', '"clientAnswerNote" TEXT', '"clientAnswerAt" DATETIME']) { try { await S.run(`ALTER TABLE "${T}" ADD COLUMN ${col}`); } catch { /* the column is already there */ } } // eslint-disable-line no-await-in-loop
    for (const col of ['"answer" TEXT', '"answerNote" TEXT', '"answerAt" DATETIME']) { try { await S.run(`ALTER TABLE "${TO}" ADD COLUMN ${col}`); } catch { /* the column is already there */ } } // eslint-disable-line no-await-in-loop -- 2026-11-21: the client's answer per option (approved / rejected, with the reason)
    await AI.ensure(); okAt = Date.now(); return true;
  } catch (e) { console.error('[omni-mk] projects schema:', e.message); return false; } // eslint-disable-line no-console
}

const SOURCES = [{ key: 'email', label: 'Email' }, { key: 'whatsapp', label: 'WhatsApp' }, { key: 'portal', label: 'Client portal' }, { key: 'phone', label: 'Phone call' }, { key: 'link', label: 'Request link' }, { key: 'other', label: 'Other' }];
const DELIVERABLES = [{ key: 'video', label: 'A video' }, { key: 'image', label: 'Pictures' }, { key: 'both', label: 'Video and pictures' }];
const PLATFORM_KEYS = ['facebook', 'instagram', 'linkedin', 'x', 'whatsapp'];
const PLATFORM_LABEL = { facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', x: 'X', whatsapp: 'WhatsApp status' };
const DAY = 86400000;
const MAX_OPTIONS = 8;
const parse = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v == null ? d : v); } catch { return d; } };
const HEX = /^#[0-9a-f]{6}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---- the private link ------------------------------------------------------------------------------------------------------------------------
const secret = () => process.env.MK_PROJECT_SECRET || process.env.JWT_SECRET || 'teamlink-dev';
const sigOf = (id) => crypto.createHmac('sha256', secret()).update(`mk-project:${id}`).digest('base64url').slice(0, 32);
const tokenOf = (id) => `${id}.${sigOf(id)}`;
function idOfToken(token) {
  const m = /^([A-Za-z0-9]{8,40})\.([A-Za-z0-9_-]{32})$/.exec(String(token || ''));
  if (!m) return null;
  const want = Buffer.from(sigOf(m[1])); const got = Buffer.from(m[2]);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? m[1] : null;
}

// ---- who may do what -------------------------------------------------------------------------------------------------------------------------
const mayWrite = (u) => A.has('mayAiMarketing')(u);
function visible(u, r) {
  if (r.deletedAt || !mayWrite(u)) return false;
  if (A.isAdmin(u) || r.createdById === u.id || r.ownerId === u.id) return true;
  return A.mayDepartment(u, r.department || '');
}
// The newest columns are added with ALTER TABLE on first use. Right after that, the database layer can still hand back "SELECT *" rows with the OLD column list
// (found 2026-11-14: a fresh test database returned 46 of 51 fields, so automatic posting looked switched off). So when they are missing they are read by name.
const NEWEST = 'autoPost, autoTargets, autoAt, autoState, autoResult, autoBase, showcase, showcaseTitle, showcaseClient, clientAnswer, clientAnswerNote, clientAnswerAt, postConsentAt, postConsentBy, postConsentIds';
const row = async (id) => {
  const r = (await S.q(`SELECT * FROM "${T}" WHERE id = ?`, String(id || '')))[0] || null;
  if (!r || 'autoPost' in r) return r;
  const x = (await S.q(`SELECT ${NEWEST} FROM "${T}" WHERE id = ?`, r.id))[0];
  return x ? { ...r, ...x } : r;
};
const optionRows = async (projectId) => S.q(`SELECT * FROM "${TO}" WHERE projectId = ? ORDER BY round ASC, sortNo ASC, createdAt ASC`, projectId);
async function event(projectId, kind, byName, text) {
  await S.run(`INSERT INTO "${TE}" (id, projectId, at, kind, byName, text) VALUES (?,?,?,?,?,?)`, S.newId('pe'), projectId, Date.now(), kind, S.clip(byName, 80) || null, S.clip(text, 800) || null);
}
// ---- the stage of a request, in the founder's words (2026-11-21): new, accepted, being made, sent to the client, approved, rejected, posted (+ declined, waiting for the client's form),
// and how many pictures and videos were made for it. `counts` = { images, videos } (raw clips are not counted: they are not a finished creative).
const STAGES = {
  waiting: "Waiting for the client's request", new: 'New request', accepted: 'Accepted', making: 'Being made', sent: 'Sent to the client', approved: 'Approved by the client',
  rejected: 'Rejected by the client', posted: 'Posted', declined: 'Declined',
};
function stageOf(r, counts) {
  const made = (counts ? S.num(counts.images) + S.num(counts.videos) : 0);
  if (r.status === 'invited') return 'waiting';
  if (r.status === 'request') return 'new';
  if (r.status === 'working') return r.clientAnswer === 'rejected' ? 'rejected' : (made > 0 ? 'making' : 'accepted');
  if (r.status === 'awaiting_client') return 'sent';
  return r.status; // approved | posted | declined
}
async function countsFor(ids) { // -> Map projectId -> { images, videos }
  const out = new Map(); (ids || []).forEach((id) => out.set(id, { images: 0, videos: 0 }));
  if (!ids || !ids.length) return out;
  try {
    const rows = await S.q(`SELECT projectId, CASE WHEN mime LIKE 'video/%' THEN 'video' ELSE 'image' END AS k, COUNT(*) AS n FROM "OmniMkImage" WHERE projectId IS NOT NULL AND deletedAt IS NULL AND (style IS NULL OR style <> 'clip') GROUP BY projectId, k`);
    rows.forEach((x) => { const c = out.get(x.projectId); if (c) c[x.k === 'video' ? 'videos' : 'images'] = S.num(x.n); });
  } catch { /* the pictures table is not made yet: no counts */ }
  return out;
}
// STARTER CONTENT (2026-11-23): the moment a client project exists (or its brief changes) TeamLink writes the content for it from the brief: the hook, the useful points, the call to action,
// the caption and hashtags (marketing/briefContent.js: free, instant, no AI service; for a doctor it teaches patients something useful). It is kept with the project, shown on the project page, and
// "Create from your content" in AI Video turns it into the video. Never throws: a project is never stopped by it.
async function makeDraft(id, byName) {
  try {
    const r = (await S.q(`SELECT clientName, occasion, brief FROM "${T}" WHERE id = ?`, id))[0];
    if (!r || String(r.brief || '').trim().length < 10) return null;
    const plan = require('./briefContent').buildPlan({ who: r.clientName, occasion: r.occasion || '', brief: r.brief, n: 4 }); // eslint-disable-line global-require
    await S.run(`UPDATE "${T}" SET draftPlan = ? WHERE id = ?`, JSON.stringify({ ...plan, madeAt: Date.now() }), id);
    await event(id, 'draft', byName || 'TeamLink', 'Starter content written from the brief (open AI Video to make the video from it)');
    return plan;
  } catch { return null; }
}
const draftOf = (r) => { const d = parse(r.draftPlan, null); return d && d.headline ? { headline: d.headline, caption: d.caption, hashtags: d.hashtags || [], cta: d.cta, scenes: (d.scenes || []).map((x) => x.caption), kindOfClient: d.profile || '' } : null; };
const short = (r, counts) => ({
  draft: draftOf(r),
  stage: stageOf(r, counts), stageLabel: STAGES[stageOf(r, counts)] || r.status, counts: { images: counts ? S.num(counts.images) : 0, videos: counts ? S.num(counts.videos) : 0 },
  clientAnswer: r.clientAnswer || '', clientAnswerNote: r.clientAnswerNote || '', clientAnswerAt: S.iso(r.clientAnswerAt),
  id: r.id, title: r.title, clientName: r.clientName, contactName: r.contactName || '', contactEmail: r.contactEmail || '', contactPhone: r.contactPhone || '', source: r.source || 'other',
  occasion: r.occasion || '', brief: r.brief || '', deliverable: r.deliverable || 'video', platforms: parse(r.platforms, []), handles: r.handles || '', caption: r.caption || '', dueDate: r.dueDate || '',
  status: r.status, hasLogo: !!r.logoData, colors: parse(r.colors, null), department: r.department || '', ownerName: r.ownerName || '', createdByName: r.createdByName || '',
  createdAt: S.iso(r.createdAt), updatedAt: S.iso(r.updatedAt), acceptedAt: S.iso(r.acceptedAt), acceptedByName: r.acceptedByName || '', round: S.num(r.round),
  linkExpiresAt: S.iso(r.linkExpiresAt), linkExpired: r.status === 'awaiting_client' && S.num(r.linkExpiresAt) < Date.now(), clientMessage: r.clientMessage || '',
  chosenOptionId: r.chosenOptionId || '', decidedAt: S.iso(r.decidedAt), decidedByName: r.decidedByName || '', decisionNote: r.decisionNote || '', scheduledFor: r.scheduledFor || '',
  postUrl: r.postUrl || '', postedAt: S.iso(r.postedAt), postedByName: r.postedByName || '', declinedNote: r.declinedNote || '', views: S.num(r.views), viewedAt: S.iso(r.viewedAt),
  showcase: S.num(r.showcase) === 1, showcaseTitle: r.showcaseTitle || '', showcaseClient: S.num(r.showcaseClient) === 1,
  autoPost: S.num(r.autoPost) === 1, autoTargets: parse(r.autoTargets, []), autoAt: S.iso(r.autoAt), autoState: r.autoState || '', autoResult: parse(r.autoResult, []),
  postConsent: r.postConsentAt ? { at: S.iso(r.postConsentAt), by: r.postConsentBy || '', accountIds: parse(r.postConsentIds, []) } : null,
  link: `/client-project/${tokenOf(r.id)}`,
});

const shortRow = async (id) => { const r = await row(id); return r ? short(r, (await countsFor([r.id])).get(r.id)) : null; };

// ---- cleaning ----------------------------------------------------------------------------------------------------------------------------------
function cleanFields(b, cur = {}) {
  const pick = (k, n) => (b[k] !== undefined ? S.clip(b[k], n) : (cur[k] || ''));
  const out = {};
  out.clientName = pick('clientName', 120);
  out.contactName = pick('contactName', 120); out.contactPhone = pick('contactPhone', 30); out.contactEmail = pick('contactEmail', 160);
  if (out.contactEmail && !/^\S+@\S+\.\S+$/.test(out.contactEmail)) return { error: 'That email address does not look right.', status: 400 };
  out.occasion = pick('occasion', 120);
  out.brief = b.brief !== undefined ? String(b.brief || '').replace(/\r/g, '').trim().slice(0, 3000) : (cur.brief || '');
  out.handles = b.handles !== undefined ? String(b.handles || '').replace(/\r/g, '').trim().slice(0, 600) : (cur.handles || '');
  out.caption = b.caption !== undefined ? String(b.caption || '').replace(/\r/g, '').trim().slice(0, 3000) : (cur.caption || '');
  out.source = b.source !== undefined ? (SOURCES.some((s) => s.key === b.source) ? b.source : 'other') : (cur.source || 'other');
  out.deliverable = b.deliverable !== undefined ? (DELIVERABLES.some((d) => d.key === b.deliverable) ? b.deliverable : 'video') : (cur.deliverable || 'video');
  out.platforms = (b.platforms !== undefined ? (Array.isArray(b.platforms) ? b.platforms : []) : parse(cur.platforms, [])).map(String).filter((k, i, a) => PLATFORM_KEYS.includes(k) && a.indexOf(k) === i);
  out.dueDate = b.dueDate !== undefined ? S.clip(b.dueDate, 10) : (cur.dueDate || '');
  if (out.dueDate && !DATE.test(out.dueDate)) return { error: 'Pick the date the client needs it by.', status: 400 };
  if (b.colors !== undefined) {
    const c = b.colors && typeof b.colors === 'object' ? b.colors : {};
    out.colors = HEX.test(c.primary || '') || HEX.test(c.secondary || '') ? { primary: HEX.test(c.primary || '') ? c.primary.toLowerCase() : '', secondary: HEX.test(c.secondary || '') ? c.secondary.toLowerCase() : '' } : null;
  } else out.colors = parse(cur.colors, null);
  if (b.logoDataUrl !== undefined) {
    if (!b.logoDataUrl) out.logoData = null;
    else { const l = Cfg.cleanLogo({ dataUrl: b.logoDataUrl, name: b.logoName }); if (l.error) return { error: l.error.replace('The logo is too big', 'The client logo is too big'), status: 400 }; out.logoData = l.value.dataUrl; }
  } else out.logoData = cur.logoData || null;
  return { value: out };
}

// ---- AI help for THE BRIEF of a client request (2026-11-23) ------------------------------------------------------------
// Owner: "in THE BRIEF add AI assist so the AI generates the content from the title / topic and the company name". The person writes the client's company and what it is for (the topic); this writes the
// brief for the team who will make the picture / video. It never invents facts: prices, dates, offers and numbers the person did not give are left to be confirmed with the client. Whatever the person had
// already typed in the box is kept and completed. It goes through the shared AI layer (marketing/ai.js): the person's daily limit, the company limit, the usage log and the plain "AI is not ready" words.
const BRIEF_WHAT = { video: 'a video', image: 'pictures', both: 'a video and pictures' };
async function briefAssist(u, b = {}) {
  await ensure();
  if (!mayWrite(u)) return { error: 'Your login cannot open client projects.', status: 403 };
  const client = S.clip(b.clientName, 120).trim();
  const topic = S.clip(b.occasion, 120).trim();
  if (client.length < 2) return { error: 'Write the client\'s company name first, so the AI knows who it is for.', status: 400 };
  if (topic.length < 2) return { error: 'Write what it is for first (for example Diwali offer), so the AI knows the topic.', status: 400 };
  const what = BRIEF_WHAT[b.deliverable] || BRIEF_WHAT.video;
  const places = (Array.isArray(b.platforms) ? b.platforms : []).map((k) => PLATFORM_LABEL[k]).filter(Boolean).join(', ');
  const own = S.clip(b.brief, 1200).trim();
  const brand = await Cfg.getBrand();
  const system = [
    `You write the BRIEF of a creative request for a marketing team: the note the team reads before making ${what} for a client.`,
    'Write it as the client\'s request in plain words: what they want, the message, the key points or offer, the mood and look, and what to avoid. Three to six short lines or sentences, under 700 characters, no headings, no markdown.',
    'Use the client\'s company name. NEVER invent prices, discounts, dates, phone numbers, addresses, awards or facts: where something is not given, write that it is to be confirmed with the client.',
    `The team belongs to ${brand.brandName || 'the agency'}${brand.tone ? `; keep a ${brand.tone} tone` : ''}${brand.language && brand.language !== 'English' ? `; write in ${brand.language}` : ''}.`,
    ...(brand.avoidWords && brand.avoidWords.length ? [`Never use these words: ${brand.avoidWords.join(', ')}.`] : []),
    'Answer only as JSON: {"brief": "the text"}.',
  ].join('\n');
  const prompt = `Client (company): ${client}\nWhat it is for: ${topic}\nThey want: ${what}${places ? `\nTo be posted on: ${places}` : ''}${own ? `\n\nThe team already wrote this (keep its facts, complete and improve it):\n${own}` : ''}`;
  let r;
  try {
    r = await AI.generate({ user: u, module: 'projects', task: 'brief', system, prompt, json: true, demo: () => ({ brief: `SAMPLE (test mode, not written by AI): ${client} would like ${what} for ${topic}. Message, offer and look: to be confirmed with the client.` }), department: u.department });
  } catch (e) { return { error: e.message, status: e.status || 503, code: e.code }; }
  let text = r.result && typeof r.result === 'object' ? (r.result.brief || r.result.text || '') : String(r.result || '');
  text = String(text).replace(/\*\*|__|^#+\s*/gm, '').replace(/[ \t]+\n/g, '\n').trim();
  if (text.length < 10) return { error: 'The AI did not write anything useful. Try again, or write the brief yourself.', status: 502, code: 'empty' };
  text = S.clip(text, 1500);
  const flags = (brand.avoidWords || []).filter((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(text));
  return { brief: text, demo: !!r.demo, provider: r.provider || '', flags };
}

// ---- staff: log a request, invite, list, open, change ---------------------------------------------------------------------------------------------
async function create(u, b = {}) {
  await ensure();
  if (!mayWrite(u)) return { error: 'Your login can look at client projects but not start them.', status: 403 };
  const c = cleanFields(b);
  if (c.error) return c;
  const v = c.value;
  if (v.clientName.length < 2) return { error: 'Write the client\'s name (the company).', status: 400 };
  if (v.occasion.length < 2) return { error: 'Say what it is for (for example Diwali offer, Independence Day).', status: 400 };
  if (v.brief.length < 10) return { error: 'Write the brief the client gave, in a sentence or two.', status: 400 };
  const dept = S.clip(b.department, 60) || (A.departmentsOf(u).length === 1 ? A.departmentsOf(u)[0] : S.clip(u.department, 60));
  if (dept && !A.mayDepartment(u, dept)) return { error: 'That department is not yours.', status: 403 };
  const id = S.newId('prj'); const now = Date.now(); const accept = b.accept === true;
  await S.run(`INSERT INTO "${T}" (id, title, clientId, clientName, contactName, contactEmail, contactPhone, source, occasion, brief, deliverable, platforms, handles, caption, dueDate, status, logoData, colors, department, ownerId, ownerName, createdById, createdByName, acceptedAt, acceptedByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, S.clip(b.title, 120) || `${v.clientName}: ${v.occasion}`, S.clip(b.clientId, 40) || null, v.clientName, v.contactName || null, v.contactEmail || null, v.contactPhone || null, v.source, v.occasion, v.brief, v.deliverable,
    JSON.stringify(v.platforms), v.handles || null, v.caption || null, v.dueDate || null, accept ? 'working' : 'request', v.logoData, v.colors ? JSON.stringify(v.colors) : null, dept || null,
    accept ? u.id : null, accept ? S.clip(u.name, 80) : null, u.id, S.clip(u.name, 80), accept ? now : null, accept ? S.clip(u.name, 80) : null, now, now);
  await event(id, 'request', u.name, `Request logged (${(SOURCES.find((s) => s.key === v.source) || {}).label || 'Other'}): ${v.occasion}`);
  if (accept) await event(id, 'accepted', u.name, 'Accepted: the team starts work');
  await makeDraft(id, u.name);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: client project started', entity: T, entityId: id, toValue: `${v.clientName}: ${v.occasion}; ${v.source}${accept ? '; accepted' : ''}` });
  return { project: (await shortRow(id)) };
}
// a private REQUEST LINK: the client writes the brief and adds the logo themselves (this is the "request in our portal" without a login)
async function invite(u, b = {}) {
  await ensure();
  if (!mayWrite(u)) return { error: 'Your login can look at client projects but not start them.', status: 403 };
  const clientName = S.clip(b.clientName, 120);
  if (clientName.length < 2) return { error: 'Write the client\'s name (the company).', status: 400 };
  const email = S.clip(b.contactEmail, 160);
  if (email && !/^\S+@\S+\.\S+$/.test(email)) return { error: 'That email address does not look right.', status: 400 };
  const dept = S.clip(b.department, 60) || (A.departmentsOf(u).length === 1 ? A.departmentsOf(u)[0] : S.clip(u.department, 60));
  const id = S.newId('prj'); const now = Date.now();
  await S.run(`INSERT INTO "${T}" (id, title, clientId, clientName, contactName, contactEmail, contactPhone, source, status, department, ownerId, ownerName, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,'link','invited',?,?,?,?,?,?,?)`,
    id, `${clientName}: new request`, S.clip(b.clientId, 40) || null, clientName, S.clip(b.contactName, 120) || null, email || null, S.clip(b.contactPhone, 30) || null, dept || null, u.id, S.clip(u.name, 80), u.id, S.clip(u.name, 80), now, now);
  await event(id, 'invited', u.name, `Request link made for ${clientName}`);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: client request link made', entity: T, entityId: id, toValue: clientName });
  return { project: (await shortRow(id)) };
}
async function list(u, { status = '', q = '' } = {}) {
  await ensure();
  if (!mayWrite(u)) return { error: 'Your login cannot open client projects.', status: 403 };
  const rows = (await S.q(`SELECT * FROM "${T}" WHERE deletedAt IS NULL ORDER BY updatedAt DESC LIMIT 600`)).filter((r) => visible(u, r));
  const needle = String(q || '').trim().toLowerCase();
  const counts = { all: 0 }; rows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; counts.all += 1; });
  const shown = rows.filter((r) => (!status || r.status === status) && (!needle || `${r.title} ${r.clientName} ${r.occasion}`.toLowerCase().includes(needle)));
  const cmap = await countsFor(shown.map((r) => r.id));
  return { projects: shown.map((r) => short(r, cmap.get(r.id))), counts, canWrite: true };
}
async function getVisible(u, id) {
  await ensure();
  if (!mayWrite(u)) return { error: 'Your login cannot open client projects.', status: 403 };
  const r = await row(id);
  if (!r || !visible(u, r)) return { error: 'This project was not found.', status: 404 };
  return { r };
}
async function itemInfo(r) { // a picture / video row as the team sees it
  if (!r) return null;
  return { id: r.id, title: r.title, kind: /^video\//.test(r.mime || '') ? 'video' : 'image', aspect: r.aspect || '1:1', status: r.status, style: r.style || '' };
}
async function get(u, id) {
  const g = await getVisible(u, id); if (g.error) return g;
  const { r } = g;
  const Img = require('./images'); // eslint-disable-line global-require
  await Img.ensure();
  const opts = await optionRows(r.id);
  const withItem = [];
  for (const o of opts) { // eslint-disable-line no-restricted-syntax
    const it = await itemInfo(await Img.rawRow(o.itemId)); // eslint-disable-line no-await-in-loop
    withItem.push({ id: o.id, round: S.num(o.round), label: o.label, itemId: o.itemId, item: it, chosen: r.chosenOptionId === o.id });
  }
  const events = (await S.q(`SELECT * FROM "${TE}" WHERE projectId = ? ORDER BY at ASC`, r.id)).map((e) => ({ id: e.id, at: S.iso(e.at), kind: e.kind, byName: e.byName || '', text: e.text || '' }));
  const made = (await S.q('SELECT id, title, mime, aspect, status, style FROM "OmniMkImage" WHERE projectId = ? AND deletedAt IS NULL ORDER BY createdAt DESC LIMIT 60', r.id).catch(() => [])).map((x) => ({ id: x.id, title: x.title, kind: /^video\//.test(x.mime || '') ? 'video' : 'image', aspect: x.aspect || '1:1', status: x.status, style: x.style || '' }));
  const cur = S.num(r.round);
  // everything sent to this client for the pictures / videos of the project: when, to which number, and what the client answered
  let sent = [];
  try { const ids = [...new Set([...made.map((x) => x.id), ...opts.map((o) => o.itemId)])]; const kinds = new Map(made.map((x) => [x.id, x.kind])); sent = (await require('./clientReview').forItems(ids)).map((x) => ({ ...x, kind: kinds.get(x.itemId) || 'image' })); } catch { sent = []; } // eslint-disable-line global-require
  return { sent, project: short(r, (await countsFor([r.id])).get(r.id)), logo: r.logoData || null, options: withItem.map((o) => ({ ...o, stage: o.round === cur + 1 ? 'staged' : o.round === cur ? 'presented' : 'earlier' })), events, made, clientAccountIds: await rememberedFor(r) };
}
async function update(u, id, b = {}) {
  const g = await getVisible(u, id); if (g.error) return g;
  const { r } = g;
  if (['posted', 'declined'].includes(r.status)) return { error: 'This project is finished. Its record stays as it is.', status: 409 };
  const c = cleanFields(b, r);
  if (c.error) return c;
  const v = c.value;
  if (v.clientName.length < 2) return { error: 'Write the client\'s name (the company).', status: 400 };
  await S.run(`UPDATE "${T}" SET clientName = ?, contactName = ?, contactEmail = ?, contactPhone = ?, source = ?, occasion = ?, brief = ?, deliverable = ?, platforms = ?, handles = ?, caption = ?, dueDate = ?, logoData = ?, colors = ?, title = ?, updatedAt = ? WHERE id = ?`,
    v.clientName, v.contactName || null, v.contactEmail || null, v.contactPhone || null, v.source, v.occasion || null, v.brief || null, v.deliverable, JSON.stringify(v.platforms), v.handles || null, v.caption || null, v.dueDate || null, v.logoData, v.colors ? JSON.stringify(v.colors) : null,
    b.title !== undefined ? (S.clip(b.title, 120) || r.title) : r.title, Date.now(), r.id);
  if ((v.brief || '') !== (r.brief || '') || (v.occasion || '') !== (r.occasion || '')) await makeDraft(r.id, u.name); // the brief changed: the starter content follows it
  return { project: (await shortRow(r.id)) };
}

// ---- telling the CLIENT (2026-11-14) -----------------------------------------------------------------------------------------------------------------------
// The client's private link, and each step of their project, reach them by WhatsApp and email through the platform's ONE sender (utils/messaging.js: the WhatsApp / mail
// connection an Admin set up in Administration > Integrations). Before this, TeamLink only OPENED the team's own WhatsApp with the words typed in, so a message reached the client
// only when a person also pressed Send there. Steps that tell the client by themselves (an Admin can switch it off, AI usage): accepted, options ready, declined, posted.
// The "invite" link is sent by a person's click. Every try, sent or not, is written on the project's timeline with the client's number masked and the reason when it failed;
// a failed automatic notice also tells the team, so nobody waits for a message that never went. Nothing here can stop the step itself.
const NOTICE_MANUAL = ['invite', 'accepted', 'options'];
const firstWord = (n) => String(n || '').trim().split(/\s+/)[0] || '';
const dayWords = (ms) => { try { return new Date(Number(ms)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }); } catch { return ''; } };
const siteFor = (base) => { const b = String(base || '').replace(/\/+$/, ''); if (baseOk(b)) return b; const e = String(process.env.APP_BASE_URL || '').replace(/\/+$/, ''); return baseOk(e) ? e : ''; };
async function noticeFor(kind, r, { base = '', urls = [] } = {}) {
  const brand = (await Cfg.getBrand()).brandName || 'TeamLink';
  const hi = firstWord(r.contactName) ? `Hello ${firstWord(r.contactName)},` : 'Hello,';
  const occ = r.occasion ? ` for ${S.clip(r.occasion, 80)}` : '';
  const site = siteFor(base);
  const link = site ? `${site}/client-project/${tokenOf(r.id)}` : '';
  const need = (what) => (link ? null : { error: `The ${what} needs the site's https address: open this page on the live site and try again.` });
  // the details a Meta-approved WhatsApp template is filled with (marketing/waTemplates.js has the contract: which blank is which)
  const shown = urls.filter((x) => /^https:\/\//i.test(x)).slice(0, 4);
  const values = { name: firstWord(r.contactName) || 'there', brand, occasion: S.clip(r.occasion, 80) || 'your request', link, reason: S.clip(r.declinedNote, 300) || 'we are not able to help with this one', links: shown.join(' ') || 'on our page' };
  if (kind === 'invite') {
    const n = need('request link'); if (n) return n;
    return { values, subject: `${brand}: please tell us what you need`, text: `${hi} this is ${brand}. Please tell us what you need${occ} (it takes about two minutes) on your private page: ${link}` };
  }
  if (kind === 'accepted') return { values, subject: `${brand}: we have started your request`, text: `${hi} thank you for your request${occ}. ${brand} has accepted it and our team has started work. We will message you again as soon as your options are ready.${link ? ` You can follow it here: ${link}` : ''}` };
  if (kind === 'options') {
    const n = need('options link'); if (n) return n;
    const till = S.num(r.linkExpiresAt) > Date.now() ? ` The link works until ${dayWords(r.linkExpiresAt)}.` : '';
    return { values, subject: `${brand}: your options are ready`, text: `${hi} your options${occ} are ready. Please open your private page, choose the one you like and add any suggestions: ${link}${till}` };
  }
  if (kind === 'declined') return { values, subject: `${brand}: about your request`, text: `${hi} thank you for your request${occ}. We are sorry, we cannot take it up this time: ${S.clip(r.declinedNote, 300)}${link ? ` Details: ${link}` : ''}` };
  if (kind === 'posted') return { values, subject: `${brand}: your post is live`, text: `${hi} your post${occ} is live${shown.length ? `: ${shown.join(' ')}` : ''}. Thank you for working with ${brand}.` };
  return { error: 'Unknown message.' };
}
// -> { sent: [{ way, ok, to, error }], note }   never throws. opts: { by (a person: their click) | null (automatic), base, urls, ways: ['whatsapp','email'] (manual choice), auto: true }
async function tellClient(r, kind, opts = {}) {
  const out = { sent: [], note: '' };
  try {
    const set = await Cfg.getSettings();
    const cn = set.clientNotify || { auto: true, whatsapp: true, email: true };
    const by = opts.by || null;
    if (!by && cn.auto !== true) return { ...out, note: 'Telling the client by itself is switched off.' };
    const ways = (Array.isArray(opts.ways) && opts.ways.length ? opts.ways : ['whatsapp', 'email']).filter((w) => ['whatsapp', 'email'].includes(w) && (by || cn[w] !== false));
    const msg = await noticeFor(kind, r, opts);
    if (msg.error) return { ...out, note: msg.error };
    const messaging = require('../utils/messaging'); // eslint-disable-line global-require
    const core = require('../utils/messagingCore'); // eslint-disable-line global-require
    const who = by ? by.name : 'TeamLink';
    const Sender = require('./sender'); // eslint-disable-line global-require -- the WhatsApp number: the default company number unless one is chosen (marketing/sender.js)
    const pk = await Sender.pick(by || opts.actor || null, opts.numberId);
    const meta = { audience: 'client', personName: S.clip(r.contactName || r.clientName, 80), purpose: `AI Marketing client project: ${kind}`, module: 'AI Marketing', senderUserId: by ? by.id : undefined, senderName: by ? S.clip(by.name, 80) : undefined, automatic: !by };
    for (const way of ways) { // eslint-disable-line no-restricted-syntax
      const label = way === 'whatsapp' ? 'WhatsApp' : 'Email';
      let res; let to = '';
      if (way === 'whatsapp') {
        if (!String(r.contactPhone || '').trim()) { if (by) out.sent.push({ way: label, ok: false, local: true, to: '', error: 'No WhatsApp number is saved for this client. Add it in Edit.' }); continue; } // eslint-disable-line no-continue
        const nm = core.normalizeMobile(r.contactPhone);
        if (!nm.ok) { out.sent.push({ way: label, ok: false, local: true, to: '', error: 'The client\'s number does not look right. Fix it in Edit.' }); continue; } // eslint-disable-line no-continue
        to = core.maskMobile(nm.e164);
        if (pk.error) { out.sent.push({ way: label, ok: false, local: true, to: '', error: pk.error }); continue; } // eslint-disable-line no-continue
        // the official WhatsApp number can send free text only within 24 hours of the person's last message: with an approved template set for this kind (AI usage), the template goes instead
        const tpl = require('./waTemplates').payload(set.waTemplates, kind, msg.values); // eslint-disable-line global-require
        res = await Sender.send(tpl
          ? { to: nm.e164, kind: 'text', text: msg.text, template: tpl.template, vars: tpl.vars, meta: { ...meta, template: tpl.template.name }, ...Sender.opts(pk) }
          // no template of its own for this kind: the company's ONE general template ("bulk / general", Administration > Integrations > WhatsApp Business: its blank {{1}} is the whole message) carries it, if an Admin saved one; with none, free text as before
          : { to: nm.e164, kind: 'bulk', text: `${msg.text}\n\nReply STOP to stop messages about this request.`, vars: [msg.text], meta, ...Sender.opts(pk) }); // eslint-disable-line no-await-in-loop
      } else {
        if (!String(r.contactEmail || '').trim()) { if (by) out.sent.push({ way: label, ok: false, local: true, to: '', error: 'No email address is saved for this client. Add it in Edit.' }); continue; } // eslint-disable-line no-continue
        to = core.maskEmail(r.contactEmail);
        res = await messaging.send('Email', { to: String(r.contactEmail).trim(), subject: msg.subject, text: msg.text, meta }); // eslint-disable-line no-await-in-loop
      }
      const ok = !!(res && res.ok);
      const why = ok ? '' : plainWhy(res);
      out.sent.push({ way: label, ok, to, error: why, from: way === 'whatsapp' ? Sender.fromWords(res).trim() : '' });
      if (ok && way === 'whatsapp' && kind === 'options') await require('./remind').schedule({ kind: 'project', refId: r.id, phone: r.contactPhone, name: firstWord(r.contactName), clientName: r.clientName, by: by || null, numberId: pk.numberId || null }); // eslint-disable-line no-await-in-loop, global-require -- ONE reminder after 24 hours if the client does not answer
      const viaTpl = way === 'whatsapp' && ok && (!!require('./waTemplates').payload(set.waTemplates, kind, msg.values) || (res && res.mode === 'template')); // eslint-disable-line global-require
      await event(r.id, ok ? 'told' : 'told_failed', who, ok ? `Told the client by ${label}${way === 'whatsapp' ? Sender.fromWords(res) : ''}${viaTpl ? ' (approved template)' : ''} (${to})` : `The client could not be told by ${label}${to ? ` (${to})` : ''}: ${why}`); // eslint-disable-line no-await-in-loop
    }
    const bad = out.sent.filter((x) => !x.ok);
    if (!by && bad.length) await tellTeam(r, `The client was not told: "${S.clip(r.title, 60)}"`, `${bad.map((x) => `${x.way}: ${x.error}`).join(' ').slice(0, 300)} Send them the link yourself from Client projects.`);
    const good = out.sent.filter((x) => x.ok);
    out.note = good.length ? `The client was told by ${good.map((x) => (x.from ? `${x.way} ${x.from}` : x.way)).join(' and ')}.` : (bad.length ? `The client could not be told: ${bad.map((x) => `${x.way}: ${x.error}`).join(' ')}` : '');
  } catch (e) { console.error('[omni-mk] tell client:', e.message); } // eslint-disable-line no-console
  return out;
}
// the sender's own words, made plain (a provider answer is never shown as it came)
function plainWhy(res) {
  if (!res) return 'No answer from the sender.';
  if (res.notConfigured || res.outcome === 'Not configured') return `It is not connected: ${S.clip(res.error || 'ask an Admin to connect it in Administration > Integrations', 160)}`;
  return S.clip(String(res.error || 'The sender refused it.').replace(/(\+?\d[\d\s-]{8,}\d)/g, 'a number'), 200);
}
// the manual buttons: the team presses "Send the link" / "Tell the client" (a person's click: it may use any way the client has)
async function tell(u, id, b = {}, base = '') {
  const g = await getVisible(u, id); if (g.error) return g;
  const { r } = g;
  const kind = String(b.kind || '');
  if (!NOTICE_MANUAL.includes(kind)) return { error: 'Pick what to send: the request link, "we have started", or the options link.', status: 400 };
  if (kind === 'invite' && r.status !== 'invited') return { error: 'The request link is only for a client who has not sent the request yet.', status: 409 };
  if (kind === 'accepted' && !['working', 'awaiting_client'].includes(r.status)) return { error: 'The team has not started this project yet.', status: 409 };
  if (kind === 'options' && r.status !== 'awaiting_client') return { error: 'The options are not with the client.', status: 409 };
  const ways = (Array.isArray(b.ways) ? b.ways : []).map(String).filter((w, i, a) => ['whatsapp', 'email'].includes(w) && a.indexOf(w) === i);
  if (!ways.length) return { error: 'Pick WhatsApp or Email.', status: 400 };
  const told = kind === 'options' ? await sendApproval(r, { by: u, base, ways, numberId: b.numberId }) : await tellClient(r, kind, { by: u, base, ways, numberId: b.numberId });
  if (!told.sent.length) return { error: told.note || 'Nothing could be sent: add the client\'s number or email in Edit.', status: 400 };
  const any = told.sent.some((x) => x.ok);
  if (!any && told.sent.every((x) => x.local)) return { error: told.sent.map((x) => x.error).join(' '), status: 400 }; // nothing was tried: the client has no such number / address on file
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: client told', entity: T, entityId: r.id, toValue: `${r.clientName}: ${kind}; ${told.sent.map((x) => `${x.way} ${x.ok ? 'sent' : 'failed'}`).join(', ')}` });
  return { ok: any ? told.note : '', error: any ? undefined : told.note, sent: told.sent, project: (await shortRow(r.id)), ...(any ? {} : { status: 502 }) };
}
// what the Admin switch and the buttons need: is each way connected, and is telling by itself on
async function notifyStatus() {
  const set = await Cfg.getSettings();
  const cn = set.clientNotify || { auto: true, whatsapp: true, email: true };
  let st = {};
  try { st = await require('../utils/messaging').channelStatus(); } catch { st = {}; } // eslint-disable-line global-require
  const way = (k, on) => ({ on: on !== false, ready: !!(st[k] && st[k].configured), via: (st[k] && (st[k].via || st[k].detail)) || '', reason: st[k] && !st[k].configured ? (st[k].reason || 'Not connected') : '' });
  // the approved WhatsApp templates set for each kind of message, and what TeamLink knows of each at Meta (from the templates it already has: approved / waiting / rejected / not known)
  const WT = require('./waTemplates'); // eslint-disable-line global-require
  const templates = {};
  for (const k of WT.KEYS) { // eslint-disable-line no-restricted-syntax
    const t = (set.waTemplates || {})[k];
    let known = 'none';
    if (t && t.name) {
      const row = (await S.q('SELECT "waApprovalStatus" FROM "OutreachTemplate" WHERE "waTemplateName" = ? AND "channel" = \'whatsapp\' AND "status" = \'active\' ORDER BY "updatedAt" DESC LIMIT 1', t.name).catch(() => []))[0]; // eslint-disable-line no-await-in-loop
      known = row ? (row.waApprovalStatus || 'draft') : 'unknown';
    }
    templates[k] = { name: t ? t.name : '', language: t ? t.language : 'en', known };
  }
  return { auto: cn.auto === true, whatsapp: way('WhatsApp', cn.whatsapp), email: way('Email', cn.email), templates, suggestions: WT.suggestions() };
}

// ---- accept / decline ------------------------------------------------------------------------------------------------------------------------------
async function accept(u, id, base = '') {
  const g = await getVisible(u, id); if (g.error) return g;
  const { r } = g;
  if (r.status !== 'request') return { error: r.status === 'invited' ? 'The client has not sent the request yet.' : 'This request was already handled.', status: 409 };
  const now = Date.now();
  await S.run(`UPDATE "${T}" SET status = 'working', ownerId = ?, ownerName = ?, acceptedAt = ?, acceptedByName = ?, updatedAt = ? WHERE id = ?`, u.id, S.clip(u.name, 80), now, S.clip(u.name, 80), now, r.id);
  await event(r.id, 'accepted', u.name, 'Accepted: the team starts work');
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: client project accepted', entity: T, entityId: r.id, toValue: `${r.clientName}: ${r.occasion}` });
  const told = await tellClient(await row(r.id), 'accepted', { base });
  return { ok: `Accepted. You own this project now.${told.note ? ` ${told.note}` : ''}`, told: told.sent, project: (await shortRow(r.id)) };
}
async function decline(u, id, note, base = '') {
  const g = await getVisible(u, id); if (g.error) return g;
  const { r } = g;
  if (!['request', 'working'].includes(r.status)) return { error: 'Only a new request, or one being worked on, can be declined.', status: 409 };
  const why = S.clip(note, 400);
  if (why.length < 5) return { error: 'Write a few words for the client: why it is declined.', status: 400 };
  await releaseItems(r, 'draft');
  await S.run(`UPDATE "${T}" SET status = 'declined', declinedNote = ?, updatedAt = ? WHERE id = ?`, why, Date.now(), r.id);
  await event(r.id, 'declined', u.name, why);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: client project declined', entity: T, entityId: r.id, toValue: `${r.clientName}: ${why}` });
  const told = await tellClient(await row(r.id), 'declined', { base });
  return { ok: `Declined. The client sees the reason on their page.${told.note ? ` ${told.note}` : ''}`, told: told.sent, project: (await shortRow(r.id)) };
}

// ---- options: pick what to show the client, then present it ----------------------------------------------------------------------------------------
const letter = (i) => `Option ${String.fromCharCode(65 + i)}`;
async function setOptions(u, id, b = {}) {
  const g = await getVisible(u, id); if (g.error) return g;
  const { r } = g;
  if (r.status !== 'working') return { error: r.status === 'request' ? 'Accept the request first.' : 'Options can be changed only while the team is working on it.', status: 409 };
  const Img = require('./images'); // eslint-disable-line global-require
  const list = (Array.isArray(b.items) ? b.items : []).slice(0, MAX_OPTIONS + 1);
  if (!list.length) { // clearing the options is allowed (only SENDING needs at least one)
    await S.run(`DELETE FROM "${TO}" WHERE projectId = ? AND round = ?`, r.id, S.num(r.round) + 1);
    await S.run(`UPDATE "${T}" SET updatedAt = ? WHERE id = ?`, Date.now(), r.id);
    return { ok: 'The options were cleared.' };
  }
  if (list.length > MAX_OPTIONS) return { error: `Show the client at most ${MAX_OPTIONS} options: fewer, better ones are easier to choose from.`, status: 400 };
  const seen = new Set(); const clean = [];
  for (let i = 0; i < list.length; i += 1) {
    const itemId = String((list[i] && list[i].itemId) || '');
    if (seen.has(itemId)) return { error: 'The same picture or video was picked twice.', status: 400 };
    seen.add(itemId);
    const got = await Img.getRow(u, itemId); // eslint-disable-line no-await-in-loop
    if (!got) return { error: 'One of the pictures or videos was not found.', status: 404 };
    if (got.r.style === 'clip') return { error: 'A raw clip cannot be shown to a client: make a video from it first.', status: 400 };
    if (!['draft', 'changes', 'approved'].includes(got.r.status)) return { error: `"${got.r.title}" is already waiting for somebody's approval.`, status: 409 };
    clean.push({ itemId, label: S.clip(list[i].label, 40) || letter(i) });
  }
  const round = S.num(r.round) + 1; const now = Date.now();
  await S.run(`DELETE FROM "${TO}" WHERE projectId = ? AND round = ?`, r.id, round);
  for (let i = 0; i < clean.length; i += 1) {
    await S.run(`INSERT INTO "${TO}" (id, projectId, round, itemId, label, sortNo, createdAt) VALUES (?,?,?,?,?,?,?)`, S.newId('po'), r.id, round, clean[i].itemId, clean[i].label, i, now); // eslint-disable-line no-await-in-loop
    await S.run('UPDATE "OmniMkImage" SET projectId = ? WHERE id = ? AND projectId IS NULL', r.id, clean[i].itemId); // eslint-disable-line no-await-in-loop
  }
  await S.run(`UPDATE "${T}" SET updatedAt = ? WHERE id = ?`, now, r.id);
  return { ok: `${clean.length} option${clean.length === 1 ? '' : 's'} ready to send.` };
}
// the items of the presented round go back to Drafts (the client's answer, a cancelled link): only the ones the client was holding
async function releaseItems(r, to = 'draft') {
  const Img = require('./images'); // eslint-disable-line global-require
  const opts = (await optionRows(r.id)).filter((o) => S.num(o.round) === S.num(r.round));
  for (const o of opts) { // eslint-disable-line no-restricted-syntax
    const it = await Img.rawRow(o.itemId); // eslint-disable-line no-await-in-loop
    if (it && it.status === 'waiting' && to === 'draft') await Img.backToDraft(o.itemId); // eslint-disable-line no-await-in-loop
  }
}
async function send(u, id, b = {}, base = '') {
  const g = await getVisible(u, id); if (g.error) return g;
  const { r } = g;
  if (r.status !== 'working') return { error: r.status === 'awaiting_client' ? 'The options are already with the client.' : 'Options can be sent only while the team is working on it.', status: 409 };
  const Img = require('./images'); // eslint-disable-line global-require
  const round = S.num(r.round) + 1;
  const opts = (await optionRows(r.id)).filter((o) => S.num(o.round) === round);
  if (!opts.length) return { error: 'Pick the pictures or videos to show the client first.', status: 400 };
  const days = Math.max(1, Math.min(30, Number(b.days) || 14)); const now = Date.now();
  for (const o of opts) { // eslint-disable-line no-restricted-syntax
    const it = await Img.rawRow(o.itemId); // eslint-disable-line no-await-in-loop
    if (!it || it.deletedAt) return { error: 'One of the options was deleted. Pick the options again.', status: 409 };
    if (['draft', 'changes'].includes(it.status)) await Img.holdForClient(u, it); // eslint-disable-line no-await-in-loop
  }
  const message = S.clip(b.message, 500);
  await S.run(`UPDATE "${T}" SET status = 'awaiting_client', clientAnswer = NULL, clientAnswerNote = NULL, clientAnswerAt = NULL, round = ?, linkExpiresAt = ?, clientMessage = ?, caption = ?, updatedAt = ? WHERE id = ?`, round, now + days * DAY, message || null, b.caption !== undefined ? (S.clip(b.caption, 3000) || null) : r.caption, now, r.id);
  await event(r.id, 'options_sent', u.name, `${opts.length} option${opts.length === 1 ? '' : 's'} sent to the client (round ${round})${message ? `: ${message}` : ''}`);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: project options sent to the client', entity: T, entityId: r.id, toValue: `${r.clientName}: ${opts.length} option(s); link valid ${days} day(s)` });
  await armPosting(u, r, b || {}, base); // 2026-11-21: posting by itself after the client approves (the remembered accounts of this client, or the ones ticked in the Send box)
  const told = await sendApproval(await row(r.id), { by: u, base, numberId: b && b.numberId, ways: Array.isArray(b && b.ways) && b.ways.length ? b.ways : null });
  return { ok: told.sent.some((x) => x.ok) ? `The options are with the client. ${told.note}` : `The options are with the client. ${told.note || 'Share the private link.'}${told.note ? ' Share the private link yourself.' : ''}`, told: told.sent, project: (await shortRow(r.id)) };
}
async function cancelPresentation(u, id) {
  const g = await getVisible(u, id); if (g.error) return g;
  const { r } = g;
  if (r.status !== 'awaiting_client') return { error: 'The options are not with the client.', status: 409 };
  await releaseItems(r);
  await S.run(`UPDATE "${T}" SET status = 'working', round = ?, linkExpiresAt = NULL, updatedAt = ? WHERE id = ?`, Math.max(0, S.num(r.round) - 1), Date.now(), r.id); // the same options are staged again
  await event(r.id, 'cancelled', u.name, 'The link was cancelled; the options are back with the team');
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: project options taken back', entity: T, entityId: r.id, toValue: r.clientName });
  return { ok: 'The link no longer shows the options. They are back with you.', project: (await shortRow(r.id)) };
}
async function extend(u, id, days) {
  const g = await getVisible(u, id); if (g.error) return g;
  const { r } = g;
  if (r.status !== 'awaiting_client') return { error: 'Only a link that is waiting for an answer can be extended.', status: 409 };
  const d = Math.max(1, Math.min(30, Number(days) || 14));
  await S.run(`UPDATE "${T}" SET linkExpiresAt = ?, updatedAt = ? WHERE id = ?`, Date.now() + d * DAY, Date.now(), r.id);
  await event(r.id, 'extended', u.name, `The link works for ${d} more day${d === 1 ? '' : 's'}`);
  return { ok: `The link works for ${d} more day${d === 1 ? '' : 's'}.`, project: (await shortRow(r.id)) };
}

// ---- after the client approved: schedule, post -------------------------------------------------------------------------------------------------------
async function scheduled(u, id, b = {}) {
  const g = await getVisible(u, id); if (g.error) return g;
  const { r } = g;
  if (r.status !== 'approved') return { error: 'Only an approved project can be scheduled.', status: 409 };
  const date = S.clip(b.date, 10);
  if (!DATE.test(date)) return { error: 'Pick the day it will be posted.', status: 400 };
  await S.run(`UPDATE "${T}" SET scheduledFor = ?, updatedAt = ? WHERE id = ?`, date, Date.now(), r.id);
  await event(r.id, 'scheduled', u.name, `Planned in the Content Calendar for ${date}`);
  return { project: (await shortRow(r.id)) };
}
async function posted(u, id, b = {}) {
  const g = await getVisible(u, id); if (g.error) return g;
  const { r } = g;
  if (r.status !== 'approved') return { error: r.status === 'posted' ? 'It is already marked as posted.' : 'Only an approved project can be marked as posted.', status: 409 };
  const url = S.clip(b.postUrl, 500);
  if (url && !/^https?:\/\//i.test(url)) return { error: 'The post link must start with https://', status: 400 };
  const now = Date.now();
  await S.run(`UPDATE "${T}" SET status = 'posted', postUrl = ?, postedAt = ?, postedByName = ?, updatedAt = ? WHERE id = ?`, url || null, now, S.clip(u.name, 80), now, r.id);
  await event(r.id, 'posted', u.name, `Posted on the client's page${url ? `: ${url}` : ''}`);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: client project posted', entity: T, entityId: r.id, toValue: `${r.clientName}: ${r.occasion}${url ? `; ${url}` : ''}` });
  const told = await tellClient(await row(r.id), 'posted', { urls: url ? [url] : [] });
  return { ok: `Marked as posted. The client sees it on their page.${told.note ? ` ${told.note}` : ''}`, told: told.sent, project: (await shortRow(r.id)) };
}

// ---- SENDING THE OPTIONS TO THE CLIENT AS REAL MEDIA WITH APPROVE / REJECT (2026-11-21, marketing/approvalSend.js) ------------------------------------------------------
// The client gets the video / picture itself (WhatsApp media message with Approve and Reject buttons; email with the file attached and the two buttons), never a message that is only a link.
async function roundItems(r) {
  const Img = require('./images'); // eslint-disable-line global-require
  const opts = (await optionRows(r.id)).filter((o) => S.num(o.round) === S.num(r.round));
  const items = [];
  for (const o of opts) { // eslint-disable-line no-restricted-syntax
    const it = await Img.rawRow(o.itemId); // eslint-disable-line no-await-in-loop
    if (it && !it.deletedAt) items.push({ optionId: o.id, label: o.label, item: it, answered: o.answer || '' });
  }
  return items;
}
async function sendApproval(r, opts = {}) {
  const out = { sent: [], note: '' };
  try {
    const AS = require('./approvalSend'); // eslint-disable-line global-require
    const set = await Cfg.getSettings();
    const cn = set.clientNotify || { auto: true, whatsapp: true, email: true };
    const by = opts.by || null;
    const want = (Array.isArray(opts.ways) && opts.ways.length ? opts.ways : ['whatsapp', 'email']).filter((w) => ['whatsapp', 'email'].includes(w));
    const ways = want.filter((w) => (opts.ways ? true : cn[w] !== false));
    if (!by && cn.auto !== true) return { ...out, note: 'Telling the client by itself is switched off.' };
    const items = (await roundItems(r)).filter((x) => !x.answered);
    if (!items.length) return { ...out, note: 'There is nothing to send.' };
    const Sender = require('./sender'); // eslint-disable-line global-require
    const pk = await Sender.pick(by, opts.numberId);
    const got = await AS.sendProject(r, items, { by, base: opts.base, ways, pk, set });
    const who = by ? by.name : 'TeamLink';
    const labelOf = (x) => (x.label && items.length > 1 ? ' (' + x.label + ')' : '');
    for (const x of got.sent) { // eslint-disable-line no-restricted-syntax
      const how = x.mode === 'held' ? 'a short note (no link): the video goes the moment the client replies' : (x.mode === 'template' ? 'as an approved template with the video and the Approve / Reject buttons' : (x.mode === 'attached' ? 'attached, with Approve / Reject buttons' : 'the video / picture itself with Approve / Reject buttons'));
      await event(r.id, x.ok ? 'told' : 'told_failed', who, x.ok ? 'Sent to the client by ' + x.way + labelOf(x) + ': ' + how + ' (' + (x.to || '') + ')' : 'The client could not be sent it by ' + x.way + labelOf(x) + (x.to ? ' (' + x.to + ')' : '') + ': ' + (x.error || '')); // eslint-disable-line no-await-in-loop
    }
    if (got.sent.some((x) => x.way === 'WhatsApp' && x.ok)) {
      try { await require('./remind').schedule({ kind: 'project', refId: r.id, phone: r.contactPhone, name: firstWord(r.contactName), clientName: r.clientName, by: by || null, numberId: pk.numberId || null }); } catch { /* the reminder is a courtesy */ } // eslint-disable-line global-require
    }
    const bad = got.sent.filter((x) => !x.ok); const good = got.sent.filter((x) => x.ok);
    if (!by && bad.length) await tellTeam(r, 'The client was not sent the video: "' + S.clip(r.title, 60) + '"', bad.map((x) => x.way + ': ' + x.error).join(' ').slice(0, 300));
    out.sent = got.sent.map((x) => ({ way: x.way, ok: x.ok, to: x.to || '', error: x.error || '', local: !!x.local, mode: x.mode || '', from: x.from || '' }));
    out.note = good.length ? 'The client was sent ' + (good.some((x) => x.mode === 'held') && !good.some((x) => x.mode !== 'held') ? 'a note; the video goes when they reply' : 'the video / picture itself with Approve and Reject buttons') + ' by ' + [...new Set(good.map((x) => x.way))].join(' and ') + '.' : (bad.length ? 'The client could not be sent it: ' + bad.map((x) => x.way + ': ' + x.error).join(' ') : '');
  } catch (e) { console.error('[omni-mk] send approval:', e.message); out.note = 'The client could not be sent it: ' + e.message; } // eslint-disable-line no-console
  return out;
}
// a held delivery: the client replied on WhatsApp, so the files go now with their buttons
async function deliverHeld(projectId, fromPhone, numberId) {
  const r = await row(projectId);
  if (!r || r.status !== 'awaiting_client') return { note: 'nothing to deliver: the project is not waiting for the client' };
  const AS = require('./approvalSend'); // eslint-disable-line global-require
  const items = (await roundItems(r)).filter((x) => !x.answered);
  const got = await AS.sendProject(r, items, { by: null, base: '', ways: ['whatsapp'], pk: { numberId: numberId || null }, set: null });
  for (const x of got.sent) await event(r.id, x.ok ? 'told' : 'told_failed', 'TeamLink', x.ok ? 'The client replied, so the video / picture went to them on WhatsApp with Approve / Reject buttons' : 'The held video could not be sent: ' + x.error); // eslint-disable-line no-await-in-loop
  return { note: got.sent.every((x) => x.ok) ? 'delivered' : 'delivery failed: ' + got.sent.filter((x) => !x.ok).map((x) => x.error).join(' ') };
}

// ---- the client's answer, from any way (the page, a WhatsApp button, an email button) ---------------------------------------------------------------------------
const clientApprove = (token, b = {}) => publicChoose(token, { ...b, name: b.name }, b.via || '');
// Reject ONE option (b.optionId) with a reason (b.comment, may come a moment later from WhatsApp). The project is Rejected when no option is left to choose from.
async function clientReject(token, b = {}) {
  const r = await load(token);
  if (!r) return GONE;
  if (r.status !== 'awaiting_client') return { error: ['approved', 'posted'].includes(r.status) ? 'You already chose one. Thank you.' : GONE.error, status: 409 };
  if (S.num(r.linkExpiresAt) < Date.now()) return { error: 'This link has expired. Please ask the sender for a new one.', status: 410 };
  const name = clientName(b);
  if (name.length < 2) return { error: 'Please write your name.', status: 400 };
  const comment = S.clip(b.comment, 800);
  if (b.needReason === true && comment.length < 5) return { error: 'Please tell us what you would like changed (a few words).', status: 400 };
  const opts = (await optionRows(r.id)).filter((o) => S.num(o.round) === S.num(r.round));
  const opt = opts.find((o) => o.id === String(b.optionId || ''));
  if (!opt) return { error: 'Pick one of the options.', status: 400 };
  const now = Date.now();
  await S.run(`UPDATE "${TO}" SET answer = 'rejected', answerNote = ?, answerAt = ? WHERE id = ?`, comment || null, now, opt.id);
  const left = opts.filter((o) => o.id !== opt.id && o.answer !== 'rejected');
  const via = b.via ? ' (' + b.via + ')' : '';
  if (left.length) {
    await event(r.id, 'client_rejected_option', name + ' (client: ' + r.clientName + ')', 'Rejected ' + opt.label + via + (comment ? ': ' + comment : ''));
    await tellTeam(r, 'Client rejected ' + opt.label + ': "' + S.clip(r.title, 60) + '"', name + ' rejected ' + opt.label + (comment ? ': ' + S.clip(comment, 200) : '') + '. ' + left.length + ' option(s) are still with them.');
    return { ok: 'Thank you. We have noted it.' };
  }
  await releaseItems(r);
  const all = (await optionRows(r.id)).filter((o) => S.num(o.round) === S.num(r.round));
  const note = all.map((o) => (o.id === opt.id ? comment : (o.answerNote || ''))).filter(Boolean).join(' | ');
  await S.run(`UPDATE "${T}" SET status = 'working', linkExpiresAt = NULL, clientAnswer = 'rejected', clientAnswerNote = ?, clientAnswerAt = ?, updatedAt = ? WHERE id = ? AND status = 'awaiting_client'`, note || null, now, now, r.id);
  await event(r.id, 'client_changes', name + ' (client: ' + r.clientName + ')', 'Rejected' + via + (note ? ': ' + note : ' (no reason yet)'));
  await tellTeam(r, 'Client rejected "' + S.clip(r.title, 60) + '"', name + ' (' + S.clip(r.clientName, 60) + ') rejected it' + (note ? ': ' + S.clip(note, 240) : ' (the reason may follow)') + '. Open Omni-Channel > AI Marketing > Client projects.');
  await logAudit({ userId: r.createdById, actorName: name + ' (client: ' + r.clientName + ')', action: 'Omni-Channel AI Marketing: client rejected a project', entity: T, entityId: r.id, toValue: r.title + (note ? ': ' + S.clip(note, 200) : '') + '; ' + S.clip(b.via || '', 60) });
  return { ok: 'Thank you. We will make the changes and show you again.' };
}
// the words that follow a WhatsApp Reject tap
async function clientRejectReason(projectId, optionId, text) {
  const r = await row(projectId);
  const why = S.clip(text, 800);
  if (!r || !why) return { error: 'nothing to update' };
  if (optionId) await S.run(`UPDATE "${TO}" SET answerNote = ? WHERE id = ? AND projectId = ?`, why, optionId, r.id);
  if (r.clientAnswer === 'rejected') await S.run(`UPDATE "${T}" SET clientAnswerNote = ?, updatedAt = ? WHERE id = ?`, why, Date.now(), r.id);
  await event(r.id, 'client_changes', 'Client: ' + r.clientName, 'Reason for the rejection: ' + why);
  await tellTeam(r, 'Why the client rejected: "' + S.clip(r.title, 60) + '"', S.clip(why, 280));
  return { ok: true };
}
// the page / email Reject button: one option with a reason
const publicReject = (token, b = {}) => clientReject(token, { ...b, needReason: true, via: b.via || 'client page' });

// items the client is deciding on right now (marketing/clientReview.js adds them to the "only the client can approve" set)
async function heldIds() {
  await ensure();
  const rows = await S.q(`SELECT o.itemId AS itemId FROM "${TO}" o JOIN "${T}" p ON p.id = o.projectId WHERE p.status = 'awaiting_client' AND p.deletedAt IS NULL AND p.linkExpiresAt > ? AND o.round = p.round`, Date.now());
  return new Set(rows.map((x) => x.itemId));
}

// ---- AUTOMATIC POSTING to the client's connected Facebook Page / Instagram account (marketing/publisher.js) ------------------------------------------------
// Safety, because this publishes in public: (1) an Admin must switch "Allow automatic posting" on (settings.autoPostAllowed, off by default); (2) a project posts only
// after the CLIENT approved it; (3) if the client added SUGGESTIONS with the pick, nothing is posted by itself: the team reads them and presses "Post now";
// (4) the team chooses the exact accounts per project; (5) a failure never marks the project posted: it says why, per account, and "Retry" posts only the ones that failed;
// (6) only https site addresses are accepted, because Meta fetches the picture / video from our public link. LinkedIn, X and WhatsApp stay "post by hand".
const running = new Set();
// the approved picture / video the client chose, as the publisher needs it: public https links (Facebook, Instagram fetch them) and the local file (X uploads it)
async function mediaOf(r, base) {
  const Img = require('./images'); // eslint-disable-line global-require
  const o = (await S.q(`SELECT * FROM "${TO}" WHERE id = ? AND projectId = ?`, r.chosenOptionId, r.id))[0];
  const it = o ? await Img.rawRow(o.itemId) : null;
  if (!it || it.deletedAt || it.status !== 'approved') return { error: 'The approved picture or video is not available any more.', status: 409 };
  const video = Img.isVideoRow(it);
  const file = Img.rawFile(it);
  const url = base ? `${base}${Img.publicPathOf(it)}` : '';
  return { media: { type: video ? 'video' : 'image', url, jpgUrl: base && !video && /^image\/(png|webp)$/.test(it.mime || '') ? `${base}${Img.publicJpegPath(it)}` : url, path: file ? file.path : '', mime: it.mime } };
}
const HTTPS_BASE = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/;
const baseOk = (b) => HTTPS_BASE.test(String(b || '')) || (process.env.MK_PUBLISH_ALLOW_HTTP === '1' && /^http:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(String(b || '')));
async function accounts(u) {
  if (!mayWrite(u)) return { error: 'Your login cannot open client projects.', status: 403 };
  const SA = require('../utils/socialAccounts'); // eslint-disable-line global-require
  const all = await SA.list();
  const set = await Cfg.getSettings();
  const pick = (p) => (all[p] || []).filter((a) => a.status !== 'Removed').map((a) => ({ id: a.id, platform: a.platform, name: a.name, username: a.username || '', parentName: a.parentName || '', status: a.status, error: a.error || '' }));
  return { allowed: set.autoPostAllowed === true, accounts: [...pick('facebook'), ...pick('instagram'), ...pick('x')] };
}
// 2026-11-21: automatic posting only goes out with the client's own tick ("I allow you to post this on my page"), saved with their name and time, and only for the accounts it named.
const consentCovers = (r, targets) => { const ids = parse(r.postConsentIds, []); return !!r.postConsentAt && targets.length > 0 && targets.every((t) => ids.includes(t.accountId)); };
async function setAutopost(u, id, b = {}, base = '') {
  const g = await getVisible(u, id); if (g.error) return g;
  const { r } = g;
  if (!['working', 'awaiting_client', 'approved'].includes(r.status)) return { error: r.status === 'posted' ? 'It is already posted.' : 'Automatic posting can be set for a project that is being worked on, with the client, or approved.', status: 409 };
  if (b.enabled !== true) {
    await S.run(`UPDATE "${T}" SET autoPost = 0, autoState = NULL, updatedAt = ? WHERE id = ?`, Date.now(), r.id);
    await event(r.id, 'autopost_off', u.name, 'Automatic posting switched off for this project');
    return { ok: 'Automatic posting is off for this project.', project: (await shortRow(r.id)) };
  }
  const set = await Cfg.getSettings();
  if (!set.autoPostAllowed) return { error: 'An Admin has to allow automatic posting first (AI Marketing > AI usage).', status: 409, code: 'auto_off' };
  const SA = require('../utils/socialAccounts'); // eslint-disable-line global-require
  const ids = (Array.isArray(b.accountIds) ? b.accountIds : []).map(String).filter((x, i, a) => a.indexOf(x) === i).slice(0, 12);
  if (!ids.length) return { error: 'Pick at least one of the client\'s accounts to post on.', status: 400 };
  const targets = [];
  for (const aid of ids) { // eslint-disable-line no-restricted-syntax
    const got = await SA.withToken(aid); // eslint-disable-line no-await-in-loop
    if (!got) return { error: 'One of those accounts is not connected any more. Connect it in Administration > Integrations > Social Media.', status: 404 };
    if (!['facebook', 'instagram', 'x'].includes(got.account.platform)) return { error: `${got.account.name}: only Facebook Pages, Instagram and X accounts can be posted to from here. Post the others by hand.`, status: 400 };
    targets.push({ accountId: aid, platform: got.account.platform, name: got.account.name });
  }
  let at = null;
  if (b.date) {
    at = Date.parse(`${S.clip(b.date, 10)}T${/^\d{2}:\d{2}$/.test(String(b.time || '')) ? b.time : '10:00'}:00+05:30`);
    if (!Number.isFinite(at)) return { error: 'Pick a valid day and time.', status: 400 };
    if (at < Date.now() - 60000) return { error: 'That time has already passed. Pick a time ahead, or leave it empty to post as soon as the client approves.', status: 400 };
  }
  const site = baseOk(base) ? base : (baseOk(r.autoBase) ? r.autoBase : '');
  if (!site) return { error: 'Automatic posting needs this page opened on the site\'s https address (Meta fetches the picture or video from it).', status: 400 };
  const heldNoConsent = r.status === 'approved' && !consentCovers(r, targets); // approved earlier without the client's tick for these accounts
  const state = heldNoConsent ? 'consent' : (r.status === 'approved' && r.decisionNote ? 'review' : 'scheduled');
  await S.run(`UPDATE "${T}" SET autoPost = 1, autoTargets = ?, autoAt = ?, autoState = ?, autoBase = ?, autoResult = NULL, updatedAt = ? WHERE id = ?`, JSON.stringify(targets), at, state, site, Date.now(), r.id);
  await event(r.id, 'autopost_on', u.name, `Will be posted automatically on ${targets.map((t) => `${t.name} (${t.platform === 'instagram' ? 'Instagram' : 'Facebook'})`).join(', ')}${at ? ` at ${new Date(at + 19800000).toISOString().slice(0, 16).replace('T', ' ')} IST` : ' as soon as the client approves'}`);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: automatic posting set for a client project', entity: T, entityId: r.id, toValue: `${r.clientName}: ${targets.map((t) => t.name).join(', ')}${at ? `; ${new Date(at).toISOString()}` : ''}` });
  if (heldNoConsent) return { ok: 'Saved, but the client has not given permission to post on these accounts, so it will NOT post by itself. Ask the client, or press Post now when you have their permission.', project: (await shortRow(r.id)) };
  return { ok: 'Done. It will be posted automatically after the client approves.', project: (await shortRow(r.id)) };
}
// ---- POSTING BY ITSELF, FOR EVERY PROJECT OF A CLIENT (2026-11-21) -------------------------------------------------------------------------------------
// setAutopost (above) is per project: the team would pick the client's accounts every time. Here the accounts are picked in the Send box and can be REMEMBERED for that client: every later project
// of the client then arms automatic posting by itself when its options are sent, so the client's approval (the page, a WhatsApp or an email button) posts right away. Same safeguards as setAutopost
// (it is what runs): an Admin must allow it in AI usage, only Facebook / Instagram / X, only an https site address, and suggestions from the client stop it (the team reads them, then presses Post).
// Remembered in the AppSetting 'omni.mk.clientAccounts', by client id (else the lower-case company name). Nothing is posted until the client approves.
const clientKeyOf = (r) => (r.clientId ? `c:${r.clientId}` : `n:${String(r.clientName || '').trim().toLowerCase()}`);
async function rememberedFor(r) { const m = await Cfg.getClientAccounts(); const x = m[clientKeyOf(r)]; return x && Array.isArray(x.accountIds) ? x.accountIds : []; }
// b.autoAccountIds: the accounts ticked in the Send box (absent = untouched: the remembered ones; an empty list = none for this project); b.remember === true keeps the ticked accounts for the client (an empty list forgets them)
async function armPosting(u, r, b, base) {
  try {
    const key = clientKeyOf(r);
    const picked = Array.isArray(b.autoAccountIds) ? b.autoAccountIds.map(String).filter((x, i, a) => x && a.indexOf(x) === i).slice(0, 12) : null;
    if (picked && b.remember === true) {
      const m = await Cfg.getClientAccounts();
      if (picked.length) m[key] = { accountIds: picked, by: S.clip(u.name, 80), at: new Date().toISOString() }; else delete m[key];
      await Cfg.saveClientAccounts(m);
      await event(r.id, 'autopost_remembered', u.name, picked.length ? `The accounts to post on were remembered for ${r.clientName}'s next projects` : `The remembered accounts of ${r.clientName} were cleared`);
    }
    const ids = picked || await rememberedFor(r);
    if (!ids.length) return;
    const out = await setAutopost(u, r.id, { enabled: true, accountIds: ids }, siteFor(base));
    if (out.error) {
      await event(r.id, 'autopost_skipped', u.name, `Posting by itself was not set: ${out.error}`);
      if (out.code !== 'auto_off') await tellTeam(r, `Posting by itself needs you: "${S.clip(r.title, 60)}"`, `${out.error} Post it yourself after the client approves.`);
    }
  } catch (e) { console.error('[omni-mk] arm posting:', e.message); } // eslint-disable-line no-console
}
// the post itself. force = a person pressed "Post now" (also for a project not set to post by itself, and after the client's suggestions were read)
async function autoRun(id, { by = null, force = false } = {}) {
  await ensure();
  if (running.has(id)) return { error: 'It is being posted right now.', status: 409 };
  running.add(id);
  try {
    const r = await row(id);
    if (!r || r.deletedAt) return { error: 'This project was not found.', status: 404 };
    if (r.status !== 'approved') return { error: r.status === 'posted' ? 'It is already posted.' : 'Only a project the client approved can be posted.', status: 409 };
    if (!force && (S.num(r.autoPost) !== 1 || r.autoState !== 'scheduled')) return { skipped: true, why: `id=${String(id)} rowId=${String(r.id)} keys=${Object.keys(r).length} autoPost=${String(r.autoPost)} (${typeof r.autoPost}), autoState=${String(r.autoState)}, status=${r.status}` };
    const set = await Cfg.getSettings();
    if (!set.autoPostAllowed) return { error: 'Automatic posting is switched off. An Admin can allow it in AI usage.', status: 409, code: 'auto_off' };
    const targets = parse(r.autoTargets, []);
    if (!targets.length) return { error: 'Pick the client\'s accounts to post on first.', status: 400 };
    if (!force && !consentCovers(r, targets)) { await S.run(`UPDATE "${T}" SET autoState = 'consent', updatedAt = ? WHERE id = ?`, Date.now(), r.id); return { skipped: true, why: 'the client has not given permission to post on these accounts' }; }
    if (!baseOk(r.autoBase)) return { error: 'Automatic posting needs the site\'s https address: set it again from the project page on the live site.', status: 400 };
    const mo = await mediaOf(r, r.autoBase);
    if (mo.error) return mo;
    const { media } = mo;
    const prev = parse(r.autoResult, []).filter((x) => x.ok); // a retry posts only the accounts that did not work
    const todo = targets.filter((t) => !prev.some((x) => x.accountId === t.accountId));
    await S.run(`UPDATE "${T}" SET autoState = 'posting', updatedAt = ? WHERE id = ?`, Date.now(), r.id);
    const results = todo.length ? await require('./publisher').publish(todo, media, r.caption || '') : []; // eslint-disable-line global-require
    const all = [...prev, ...results];
    const okAll = targets.every((t) => all.some((x) => x.accountId === t.accountId && x.ok));
    const now = Date.now();
    await S.run(`UPDATE "${T}" SET autoResult = ?, autoState = ?, updatedAt = ? WHERE id = ?`, JSON.stringify(all), okAll ? 'done' : 'failed', now, r.id);
    const who = by ? by.name : 'Automatic posting';
    for (const x of results) await event(r.id, x.ok ? 'autoposted' : 'autopost_failed', who, x.ok ? `Posted on ${x.name} (${x.platform === 'instagram' ? 'Instagram' : 'Facebook'})${x.url ? `: ${x.url}` : ''}` : `${x.name}: ${x.error}`); // eslint-disable-line no-await-in-loop
    if (okAll) {
      const first = (all.find((x) => x.url) || {}).url || null;
      await S.run(`UPDATE "${T}" SET status = 'posted', postUrl = ?, postedAt = ?, postedByName = ?, updatedAt = ? WHERE id = ?`, first, now, S.clip(who, 80), now, r.id);
      await event(r.id, 'posted', who, `Posted on ${targets.length} account${targets.length === 1 ? '' : 's'}`);
      await tellTeam(r, `Posted: "${S.clip(r.title, 60)}"`, `It is live on ${targets.map((t) => t.name).join(', ')}.`);
      await tellClient(await row(r.id), 'posted', { urls: all.filter((x) => x.ok && x.url).map((x) => x.url), base: r.autoBase || '' });
      await logAudit({ userId: by ? by.id : r.createdById, actorName: who, action: 'Omni-Channel AI Marketing: client project posted automatically', entity: T, entityId: r.id, toValue: `${r.clientName}: ${targets.map((t) => t.name).join(', ')}` });
    } else {
      const bad = results.filter((x) => !x.ok);
      await tellTeam(r, `Posting needs you: "${S.clip(r.title, 60)}"`, `${bad.map((x) => `${x.name}: ${x.error}`).join(' ').slice(0, 300)} Open Client projects to retry.`);
      await logAudit({ userId: by ? by.id : r.createdById, actorName: who, action: 'Omni-Channel AI Marketing: automatic posting failed', entity: T, entityId: r.id, toValue: `${r.clientName}: ${bad.map((x) => x.name).join(', ')}` });
    }
    return { ok: okAll ? 'Posted.' : 'Some accounts could not be posted. See why, then retry.', results: all, posted: okAll };
  } finally { running.delete(id); }
}
async function postNow(u, id, b = {}, base = '') {
  const g = await getVisible(u, id); if (g.error) return g;
  const { r } = g;
  if (r.status !== 'approved') return { error: r.status === 'posted' ? 'It is already posted.' : 'Only a project the client approved can be posted.', status: 409 };
  if (b.confirm !== true) return { error: 'Confirm that you want to post it now: it goes public on the client\'s accounts.', status: 400, code: 'confirm' };
  if (!parse(r.autoTargets, []).length) return { error: 'Pick the client\'s accounts to post on first.', status: 400 };
  if (!baseOk(r.autoBase) && baseOk(base)) await S.run(`UPDATE "${T}" SET autoBase = ? WHERE id = ?`, base, r.id);
  await event(r.id, 'post_now', u.name, 'Post now pressed');
  const out = await autoRun(r.id, { by: u, force: true });
  return out.error ? out : { ...out, project: (await shortRow(r.id)) };
}
// THE "SEND" BUTTONS: post the approved picture / video on ONE platform now (Facebook, Instagram or X), on the accounts the person picked. A person presses it, after the client
// approved: that click is the decision (with a confirmation: it goes public on the client's account). The project becomes Posted once every platform the client asked for
// (that can be posted from here) has a post; anything else (LinkedIn, WhatsApp) is posted by hand and finished with "Mark as posted".
async function postTo(u, id, b = {}, base = '') {
  const g = await getVisible(u, id); if (g.error) return g;
  const { r } = g;
  if (r.status !== 'approved') return { error: r.status === 'posted' ? 'It is already posted.' : 'Only a project the client approved can be posted.', status: 409 };
  const platform = String(b.platform || '');
  if (!['facebook', 'instagram', 'x'].includes(platform)) return { error: 'Pick Facebook, Instagram or X. The others are posted by hand.', status: 400 };
  if (b.confirm !== true) return { error: 'Confirm that you want to post it now: it goes public on the client\'s account.', status: 400, code: 'confirm' };
  const set = await Cfg.getSettings();
  if (!set.autoPostAllowed) return { error: 'An Admin has to allow posting from TeamLink first (AI Marketing > AI usage).', status: 409, code: 'auto_off' };
  const SA = require('../utils/socialAccounts'); // eslint-disable-line global-require
  const ids = (Array.isArray(b.accountIds) ? b.accountIds : []).map(String).filter((x, i, a) => a.indexOf(x) === i).slice(0, 12);
  if (!ids.length) return { error: 'Pick the account to post on.', status: 400 };
  const targets = [];
  for (const aid of ids) { // eslint-disable-line no-restricted-syntax
    const got = await SA.withToken(aid); // eslint-disable-line no-await-in-loop
    if (!got) return { error: 'That account is not connected any more. Connect it in Administration > Integrations > Social Media.', status: 404 };
    if (got.account.platform !== platform) return { error: `${got.account.name} is not a ${platform === 'x' ? 'X' : platform === 'instagram' ? 'Instagram' : 'Facebook'} account.`, status: 400 };
    targets.push({ accountId: aid });
  }
  const site = baseOk(base) ? base : (baseOk(r.autoBase) ? r.autoBase : '');
  if (platform !== 'x' && !site) return { error: 'Posting to Facebook or Instagram needs this page opened on the site\'s https address (Meta fetches the picture or video from it).', status: 400 };
  if (running.has(r.id)) return { error: 'It is being posted right now.', status: 409 };
  running.add(r.id);
  try {
    const mo = await mediaOf(r, site);
    if (mo.error) return mo;
    await event(r.id, 'post_click', u.name, `Posting on ${platform === 'x' ? 'X' : platform === 'instagram' ? 'Instagram' : 'Facebook'}`);
    const results = await require('./publisher').publish(targets, mo.media, r.caption || ''); // eslint-disable-line global-require
    const all = [...parse(r.autoResult, []).filter((x) => !results.some((n) => n.accountId === x.accountId)), ...results];
    const now = Date.now();
    await S.run(`UPDATE "${T}" SET autoResult = ?, autoBase = ?, updatedAt = ? WHERE id = ?`, JSON.stringify(all), site || r.autoBase || null, now, r.id);
    for (const x of results) await event(r.id, x.ok ? 'autoposted' : 'autopost_failed', u.name, x.ok ? `Posted on ${x.name} (${platform === 'x' ? 'X' : platform === 'instagram' ? 'Instagram' : 'Facebook'})${x.url ? `: ${x.url}` : ''}` : `${x.name}: ${x.error}`); // eslint-disable-line no-await-in-loop
    const needed = parse(r.platforms, []).filter((k) => ['facebook', 'instagram', 'x'].includes(k));
    const have = new Set(all.filter((x) => x.ok).map((x) => x.platform));
    const finished = needed.length > 0 && needed.every((k) => have.has(k));
    if (finished) {
      const first = (all.find((x) => x.ok && x.url) || {}).url || null;
      await S.run(`UPDATE "${T}" SET status = 'posted', postUrl = ?, postedAt = ?, postedByName = ?, autoState = 'done', updatedAt = ? WHERE id = ?`, first, now, S.clip(u.name, 80), now, r.id);
      await event(r.id, 'posted', u.name, `Posted on ${needed.length} platform${needed.length === 1 ? '' : 's'}`);
      await tellClient(await row(r.id), 'posted', { urls: all.filter((x) => x.ok && x.url).map((x) => x.url), base: site });
    }
    await logAudit({ userId: u.id, actorName: u.name, action: results.every((x) => x.ok) ? 'Omni-Channel AI Marketing: client project posted by a click' : 'Omni-Channel AI Marketing: posting by a click failed', entity: T, entityId: r.id, toValue: `${r.clientName}: ${results.map((x) => `${x.name} ${x.ok ? 'ok' : 'failed'}`).join(', ')}` });
    return { ok: results.every((x) => x.ok) ? (finished ? 'Posted. The project is finished.' : 'Posted.') : 'It could not be posted. See why below, then try again.', results, posted: finished, project: (await shortRow(r.id)) };
  } finally { running.delete(r.id); }
}
async function autoSweep() {
  await ensure();
  const rows = await S.q(`SELECT id FROM "${T}" WHERE deletedAt IS NULL AND status = 'approved' AND autoPost = 1 AND autoState = 'scheduled' AND (autoAt IS NULL OR autoAt <= ?) ORDER BY updatedAt ASC LIMIT 20`, Date.now());
  let n = 0;
  for (const x of rows) { try { const out = await autoRun(x.id); if (out && !out.skipped) n += 1; } catch (e) { console.error('[omni-mk] auto post:', e.message); } } // eslint-disable-line no-await-in-loop, no-console
  return n;
}
let sweeping = null;
function startAutoPost() {
  if (sweeping || require('../utils/sandbox').isSandbox()) return; // eslint-disable-line global-require
  sweeping = setInterval(() => { autoSweep().catch((e) => console.error('[omni-mk] auto post sweep:', e.message)); }, 120000); // eslint-disable-line no-console
  if (sweeping.unref) sweeping.unref();
}

// ---- OUR WORK: the track record and the portfolio that new and existing clients can see (no login) -----------------------------------------------------
// What is shown: (1) numbers over ALL finished projects, with no names: how fast the first options came, how often the client chose from the first set
// (our "accuracy"), how often we posted by the date the client needed it; a percentage appears only once there are 3 projects behind it. (2) the projects the
// team marked "the client agrees we show this work": the chosen picture / video, what it was for, and its timeline. The client's name stays hidden unless
// the team ticked it. Files are served by a signed key of the chosen option, and only while the project is marked to be shown.
const MIN_SAMPLE = 3;
const workSig = (optionId) => crypto.createHmac('sha256', secret()).update(`mk-work:${optionId}`).digest('base64url').slice(0, 32);
function optionIdOfKey(key) {
  const m = /^([A-Za-z0-9]{8,40})\.([A-Za-z0-9_-]{32})$/.exec(String(key || ''));
  if (!m) return null;
  const want = Buffer.from(workSig(m[1])); const got = Buffer.from(m[2]);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? m[1] : null;
}
const istDay = (ms) => new Date(S.num(ms) + 19800000).toISOString().slice(0, 10);
async function setShowcase(u, id, b = {}) {
  const g = await getVisible(u, id); if (g.error) return g;
  const { r } = g;
  if (!['approved', 'posted'].includes(r.status) || !r.chosenOptionId) return { error: 'Only a project the client has approved can be shown in our portfolio.', status: 409 };
  const show = b.show === true;
  if (show && b.consent !== true) return { error: 'Tick that the client agrees we may show this work.', status: 400 };
  const title = S.clip(b.title, 80) || r.occasion || r.title;
  await S.run(`UPDATE "${T}" SET showcase = ?, showcaseTitle = ?, showcaseClient = ?, updatedAt = ? WHERE id = ?`, show ? 1 : 0, title, show && b.showName === true ? 1 : 0, Date.now(), r.id);
  await event(r.id, 'showcase', u.name, show ? `Shown in our portfolio${b.showName === true ? ' with the client\'s name' : ' without the client\'s name'}` : 'Taken out of our portfolio');
  await logAudit({ userId: u.id, actorName: u.name, action: show ? 'Omni-Channel AI Marketing: client project shown in the portfolio' : 'Omni-Channel AI Marketing: client project taken out of the portfolio', entity: T, entityId: r.id, toValue: `${r.clientName}: ${title}${show ? (b.showName === true ? '; name shown' : '; anonymous') : ''}` });
  return { ok: show ? 'It is in our portfolio now.' : 'It is out of our portfolio.', project: (await shortRow(r.id)) };
}
async function trackRecord() {
  await ensure();
  const rows = await S.q(`SELECT id, status, round, dueDate, createdAt, postedAt FROM "${T}" WHERE deletedAt IS NULL AND status IN ('approved', 'posted')`);
  const first = {}; (await S.q(`SELECT projectId, MIN(at) AS at FROM "${TE}" WHERE kind = 'options_sent' GROUP BY projectId`)).forEach((e) => { first[e.projectId] = S.num(e.at); });
  const approved = rows.length; const delivered = rows.filter((r) => r.status === 'posted').length;
  const hours = rows.map((r) => (first[r.id] ? (first[r.id] - S.num(r.createdAt)) / 3600000 : null)).filter((x) => x != null && x >= 0);
  const due = rows.filter((r) => r.status === 'posted' && r.dueDate);
  const pct = (a, b) => Math.round((100 * a) / b);
  return {
    approved, delivered, minSample: MIN_SAMPLE,
    avgHoursToOptions: hours.length >= MIN_SAMPLE ? Math.round((hours.reduce((a, b) => a + b, 0) / hours.length) * 10) / 10 : null,
    firstRoundPct: approved >= MIN_SAMPLE ? pct(rows.filter((r) => S.num(r.round) === 1).length, approved) : null,
    onTimePct: due.length >= MIN_SAMPLE ? pct(due.filter((r) => istDay(r.postedAt) <= r.dueDate).length, due.length) : null,
  };
}
async function showcaseItems() {
  await ensure();
  const Img = require('./images'); // eslint-disable-line global-require
  const rows = await S.q(`SELECT * FROM "${T}" WHERE deletedAt IS NULL AND showcase = 1 AND status IN ('approved', 'posted') AND chosenOptionId IS NOT NULL ORDER BY COALESCE(postedAt, decidedAt) DESC LIMIT 12`);
  const out = [];
  for (const r of rows) { // eslint-disable-line no-restricted-syntax
    const o = (await S.q(`SELECT * FROM "${TO}" WHERE id = ? AND projectId = ?`, r.chosenOptionId, r.id))[0]; // eslint-disable-line no-await-in-loop
    const it = o ? await Img.rawRow(o.itemId) : null; // eslint-disable-line no-await-in-loop
    if (!it || it.deletedAt) continue; // eslint-disable-line no-continue
    const sent = (await S.q(`SELECT MIN(at) AS at FROM "${TE}" WHERE projectId = ? AND kind = 'options_sent'`, r.id))[0]; // eslint-disable-line no-await-in-loop
    const h = (ms) => (ms ? Math.max(0, Math.round(((S.num(ms) - S.num(r.createdAt)) / 3600000) * 10) / 10) : null);
    out.push({
      key: `${o.id}.${workSig(o.id)}`, title: r.showcaseTitle || r.occasion || 'A client project', client: S.num(r.showcaseClient) === 1 ? r.clientName : 'A client', occasion: r.occasion || '',
      platforms: parse(r.platforms, []).map((k) => PLATFORM_LABEL[k] || k), type: /^video\//.test(it.mime || '') ? 'video' : 'image', aspect: it.aspect || '1:1', rounds: S.num(r.round),
      hoursToOptions: sent && sent.at ? h(sent.at) : null, hoursToApproved: h(r.decidedAt), hoursToPosted: r.status === 'posted' ? h(r.postedAt) : null, when: S.iso(r.postedAt || r.decidedAt),
    });
  }
  return out;
}
async function publicWork() { return { brand: await ourBrand(), stats: await trackRecord(), items: await showcaseItems() }; }
async function publicWorkFile(key) {
  await ensure();
  const oid = optionIdOfKey(key);
  if (!oid) return null;
  const o = (await S.q(`SELECT * FROM "${TO}" WHERE id = ?`, oid))[0];
  const p = o && (await S.q(`SELECT * FROM "${T}" WHERE id = ? AND deletedAt IS NULL AND showcase = 1 AND status IN ('approved', 'posted') AND chosenOptionId = ?`, o.projectId, o.id))[0];
  if (!p) return null;
  const Img = require('./images'); // eslint-disable-line global-require
  const it = await Img.rawRow(o.itemId);
  return it && !it.deletedAt ? Img.rawFile(it) : null;
}

// ---- the client's side (no login) ------------------------------------------------------------------------------------------------------------------
const GONE = { error: 'This link does not work any more. Please ask the sender for a new one.', status: 404 };
async function load(token) {
  await ensure();
  const id = idOfToken(token);
  if (!id) return null;
  const r = await row(id);
  return r && !r.deletedAt ? r : null;
}
async function ourBrand() { const b = await Cfg.getBrand(); return { name: b.brandName || 'TeamLink', colors: b.colors, tagline: b.tagline || '' }; }
async function publicView(token) {
  const r = await load(token);
  if (!r) return GONE;
  await S.run(`UPDATE "${T}" SET viewedAt = ?, views = views + 1 WHERE id = ?`, Date.now(), r.id);
  const now = Date.now();
  const out = {
    brand: await ourBrand(),
    project: { status: r.status, clientName: r.clientName, occasion: r.occasion || '', brief: r.brief || '', deliverable: r.deliverable || 'video', platforms: parse(r.platforms, []), dueDate: r.dueDate || '', message: r.clientMessage || '', caption: r.caption || '', postingHeld: S.num(r.autoPost) === 1 && r.autoState === 'consent', expiresAt: S.iso(r.linkExpiresAt), expired: r.status === 'awaiting_client' && S.num(r.linkExpiresAt) < now, declinedNote: r.declinedNote || '', decidedByName: r.decidedByName || '', decidedAt: S.iso(r.decidedAt), decisionNote: r.decisionNote || '', postUrl: r.postUrl || '', postedAt: S.iso(r.postedAt), contactName: r.contactName || '', contactEmail: r.contactEmail || '', contactPhone: r.contactPhone || '', handles: r.handles || '', colors: parse(r.colors, null), hasLogo: !!r.logoData },
    // the tick on the approve form names the accounts (public Page / account names only, nothing else)
    posting: S.num(r.autoPost) === 1 && r.status === 'awaiting_client' ? { accounts: parse(r.autoTargets, []).map((t) => ({ platform: t.platform, name: t.name })) } : null,
    options: [],
    suggestions: (await S.q(`SELECT at, byName, text FROM "${TE}" WHERE projectId = ? AND kind = 'client_changes' ORDER BY at ASC`, r.id)).map((e) => ({ at: S.iso(e.at), byName: e.byName || '', text: e.text || '' })),
  };
  const Img = require('./images'); // eslint-disable-line global-require
  const cur = S.num(r.round);
  let opts = (await optionRows(r.id)).filter((o) => S.num(o.round) === cur);
  if (['approved', 'posted'].includes(r.status)) opts = opts.filter((o) => o.id === r.chosenOptionId);
  if (!['awaiting_client', 'approved', 'posted'].includes(r.status)) opts = [];
  for (const o of opts) { // eslint-disable-line no-restricted-syntax
    const it = await Img.rawRow(o.itemId); // eslint-disable-line no-await-in-loop
    if (it && !it.deletedAt) out.options.push({ id: o.id, label: o.label, type: /^video\//.test(it.mime || '') ? 'video' : 'image', aspect: it.aspect || '1:1', chosen: r.chosenOptionId === o.id, answer: o.answer || '' });
  }
  return out;
}
async function publicOptionFile(token, optionId) {
  const r = await load(token);
  if (!r) return null;
  const o = (await S.q(`SELECT * FROM "${TO}" WHERE id = ? AND projectId = ?`, String(optionId || ''), r.id))[0];
  if (!o || S.num(o.round) !== S.num(r.round)) return null;
  const live = r.status === 'awaiting_client' || (['approved', 'posted'].includes(r.status) && r.chosenOptionId === o.id);
  if (!live) return null;
  const it = await require('./images').rawRow(o.itemId); // eslint-disable-line global-require
  return it && !it.deletedAt ? require('./images').rawFile(it) : null; // eslint-disable-line global-require
}
async function publicLogo(token) { const r = await load(token); return r && r.logoData ? r.logoData : null; }
async function tellTeam(r, title, message) {
  let ids = [r.ownerId, r.createdById].filter(Boolean);
  if (!ids.length) { try { const prisma = require('../db'); ids = (await prisma.user.findMany({ where: { status: 'Active', OR: [{ role: { in: ['SUPER_ADMIN', 'ADMIN'] } }, { atsRole: { in: ['SUPER_ADMIN', 'ADMIN'] } }] }, select: { id: true }, take: 10 })).map((x) => x.id); } catch { ids = []; } } // eslint-disable-line global-require
  if (ids.length) await notifyUsers([...new Set(ids)], { title, message });
}
// the client sends the request through the REQUEST LINK
async function publicSubmitRequest(token, b = {}) {
  const r = await load(token);
  if (!r) return GONE;
  if (r.status !== 'invited') return { error: 'This request was already sent. Thank you.', status: 409 };
  const via = r.source === 'portal' ? 'portal' : 'link'; // a request started from the client's own login stays "Client portal"
  const c = cleanFields({ ...b, clientName: r.clientName, source: via }, r);
  if (c.error) return c;
  const v = c.value;
  if (v.occasion.length < 2) return { error: 'Say what it is for (for example Diwali offer).', status: 400 };
  if (v.brief.length < 10) return { error: 'Tell us what you would like, in a sentence or two.', status: 400 };
  if (v.contactName.length < 2) return { error: 'Please write your name.', status: 400 };
  if (!v.platforms.length) return { error: 'Pick where it will be posted.', status: 400 };
  const now = Date.now();
  await S.run(`UPDATE "${T}" SET title = ?, contactName = ?, contactEmail = ?, contactPhone = ?, occasion = ?, brief = ?, deliverable = ?, platforms = ?, handles = ?, dueDate = ?, logoData = ?, colors = ?, source = ?, status = 'request', createdAt = ?, updatedAt = ? WHERE id = ? AND status = 'invited'`,
    `${r.clientName}: ${v.occasion}`, v.contactName, v.contactEmail || null, v.contactPhone || null, v.occasion, v.brief, v.deliverable, JSON.stringify(v.platforms), v.handles || null, v.dueDate || null, v.logoData, v.colors ? JSON.stringify(v.colors) : null, via, now, now, r.id);
  await event(r.id, 'request', `${v.contactName} (client: ${r.clientName})`, `Request sent by the client: ${v.occasion}`);
  await makeDraft(r.id, 'TeamLink');
  await tellTeam(r, `New client request: ${S.clip(r.clientName, 60)}`, `${v.contactName} asked for "${S.clip(v.occasion, 80)}". Open Omni-Channel > AI Marketing > Client projects to accept it.`);
  await logAudit({ userId: r.createdById, actorName: `${v.contactName} (client: ${r.clientName})`, action: 'Omni-Channel AI Marketing: client sent a request', entity: T, entityId: r.id, toValue: v.occasion });
  // 2026-11-21: with "Make the first options by itself" on (AI usage), TeamLink starts the first picture options in the background (marketing/autocreate.js). The client's answer never waits for it.
  setImmediate(() => { require('./autocreate').run(r.id).catch((e) => console.error('[omni-mk] automatic first options:', e.message)); }); // eslint-disable-line global-require, no-console
  return { ok: 'Thank you. We have your request and will come back to you.' };
}
const clientName = (b) => S.clip(b.name, 80);
async function publicChoose(token, b = {}, ip = '') {
  const r = await load(token);
  if (!r) return GONE;
  if (r.status !== 'awaiting_client') return { error: ['approved', 'posted'].includes(r.status) ? 'You already chose one. Thank you.' : GONE.error, status: 409 };
  if (S.num(r.linkExpiresAt) < Date.now()) return { error: 'This link has expired. Please ask the sender for a new one.', status: 410 };
  const name = clientName(b);
  if (name.length < 2) return { error: 'Please write your name.', status: 400 };
  const opts = (await optionRows(r.id)).filter((o) => S.num(o.round) === S.num(r.round));
  const chosen = opts.find((o) => o.id === String(b.optionId || ''));
  if (!chosen) return { error: 'Pick one of the options.', status: 400 };
  const comment = S.clip(b.comment, 800);
  const Img = require('./images'); // eslint-disable-line global-require
  const now = Date.now();
  for (const o of opts) { // eslint-disable-line no-restricted-syntax
    const it = await Img.rawRow(o.itemId); // eslint-disable-line no-await-in-loop
    if (!it || it.deletedAt || it.status !== 'waiting') continue; // eslint-disable-line no-continue
    if (o.id === chosen.id) await Img.clientDecision(o.itemId, true, name, r.clientName, comment); // eslint-disable-line no-await-in-loop
    else await Img.backToDraft(o.itemId); // eslint-disable-line no-await-in-loop
  }
  await S.run(`UPDATE "${T}" SET status = 'approved', chosenOptionId = ?, decidedAt = ?, decidedByName = ?, decisionNote = ?, clientAnswer = 'approved', clientAnswerNote = ?, clientAnswerAt = ?, updatedAt = ? WHERE id = ? AND status = 'awaiting_client'`, chosen.id, now, name, comment || null, comment || null, now, now, r.id);
  await event(r.id, 'client_chose', `${name} (client: ${r.clientName})`, `Chose ${chosen.label}${comment ? `. Suggestions: ${comment}` : ''}`);
  // automatic posting needs the client's tick ("I allow you to post this on my page"): saved with their name and time. No tick (or an answer by a WhatsApp button, which has no tick) = it is NOT posted by itself.
  // With suggestions the team reads them first ("Post now"); without, it goes out now or at the time set (the sweep posts a later time)
  let autoNote = '';
  if (S.num(r.autoPost) === 1) {
    const targets = parse(r.autoTargets, []);
    const allowed = b.allowPosting === true && targets.length > 0;
    if (allowed) {
      await S.run(`UPDATE "${T}" SET postConsentAt = ?, postConsentBy = ?, postConsentIds = ? WHERE id = ?`, now, S.clip(name, 80), JSON.stringify(targets.map((t) => t.accountId)), r.id);
      await event(r.id, 'post_consent', `${name} (client: ${r.clientName})`, `Allowed posting on ${targets.map((t) => t.name).join(', ')}`);
    }
    if (!allowed) { await S.run(`UPDATE "${T}" SET autoState = 'consent' WHERE id = ?`, r.id); autoNote = ' The client did NOT tick permission to post, so it is NOT posted by itself: ask the client, or press Post now when you have their permission.'; }
    else if (comment) { await S.run(`UPDATE "${T}" SET autoState = 'review' WHERE id = ?`, r.id); autoNote = ' The client allowed posting but added suggestions, so it is NOT posted by itself: read them, then press Post now.'; }
    else if (!r.autoAt || S.num(r.autoAt) <= Date.now()) { setImmediate(() => { autoRun(r.id).then((out) => { if (out && (out.error || out.skipped)) console.error('[omni-mk] auto post did not run:', out.error || out.why || 'skipped'); }).catch((e) => console.error('[omni-mk] auto post:', e.message)); }); autoNote = ' The client allowed posting. It is being posted automatically.'; } // eslint-disable-line no-console
    else autoNote = ' The client allowed posting. It will be posted automatically at the time you set.';
  }
  await tellTeam(r, `Client approved "${S.clip(r.title, 60)}"`, `${name} (${S.clip(r.clientName, 60)}) chose ${chosen.label}${comment ? `: ${S.clip(comment, 200)}` : ''}. It is Approved.${autoNote || ' Schedule and post it from Client projects.'}`);
  await logAudit({ userId: r.createdById, actorName: `${name} (client: ${r.clientName})`, action: 'Omni-Channel AI Marketing: client chose an option (approved)', entity: T, entityId: r.id, toValue: `${r.title}; ${chosen.label}${comment ? `: ${S.clip(comment, 200)}` : ''}; ${S.clip(ip, 60)}` });
  return { ok: 'Thank you. Your choice has been recorded and we will go ahead.' };
}
async function publicChanges(token, b = {}, ip = '') {
  const r = await load(token);
  if (!r) return GONE;
  if (r.status !== 'awaiting_client') return { error: ['approved', 'posted'].includes(r.status) ? 'You already chose one. Thank you.' : GONE.error, status: 409 };
  if (S.num(r.linkExpiresAt) < Date.now()) return { error: 'This link has expired. Please ask the sender for a new one.', status: 410 };
  const name = clientName(b);
  if (name.length < 2) return { error: 'Please write your name.', status: 400 };
  const comment = S.clip(b.comment, 800);
  if (comment.length < 5) return { error: 'Please tell us what you would like changed (a few words).', status: 400 };
  await releaseItems(r);
  const now = Date.now();
  await S.run(`UPDATE "${T}" SET status = 'working', linkExpiresAt = NULL, clientAnswer = 'rejected', clientAnswerNote = ?, clientAnswerAt = ?, updatedAt = ? WHERE id = ? AND status = 'awaiting_client'`, comment, now, now, r.id);
  await event(r.id, 'client_changes', `${name} (client: ${r.clientName})`, comment);
  await tellTeam(r, `Client suggested changes: "${S.clip(r.title, 60)}"`, `${name} (${S.clip(r.clientName, 60)}): ${S.clip(comment, 240)}. Open Omni-Channel > AI Marketing > Client projects.`);
  await logAudit({ userId: r.createdById, actorName: `${name} (client: ${r.clientName})`, action: 'Omni-Channel AI Marketing: client asked for changes on a project', entity: T, entityId: r.id, toValue: `${r.title}: ${S.clip(comment, 200)}; ${S.clip(ip, 60)}` });
  return { ok: 'Thank you. We will make the changes and show you again.' };
}

// ---- the client's LOGIN (the Client Portal, 2026-11-14) ---------------------------------------------------------------------------------------------------
// A client person who signs in to TeamLink (a login with the CLIENT role and the "Approve our creative work and send us requests" tick) sees the creative projects of THEIR company, and
// starts a new one from their own account: it opens the same request form as the private link, then waits for the team to accept it. The private link of each project is handed out
// here only, to a login that belongs to that company (a project matches by the client record, or by the company name when it was made before a record was picked). The page the
// client works in is the same one the private link opens (ClientProjectPage), so choosing the option you like IS the approval, signed by the person's own login name.
const STATUS_WORDS = { invited: 'Tell us what you need', request: 'We have your request', working: 'We are working on it', awaiting_client: 'Waiting for your choice', approved: 'You chose: we will post it', posted: 'Posted', declined: 'Not taken up' };
async function clientRecordOf(u) {
  if (!u || !u.clientId) return null;
  const prisma = require('../db'); // eslint-disable-line global-require
  return prisma.client.findUnique({ where: { id: u.clientId }, select: { id: true, name: true } }).catch(() => null);
}
async function portalList(u) {
  await ensure();
  const c = await clientRecordOf(u);
  if (!c) return { error: 'Your company record was not found: contact TeamLink.', status: 404 };
  const rows = await S.q(`SELECT * FROM "${T}" WHERE deletedAt IS NULL AND (clientId = ? OR (clientId IS NULL AND LOWER(clientName) = LOWER(?))) ORDER BY updatedAt DESC LIMIT 100`, c.id, c.name);
  const projects = rows.map((r) => ({
    id: r.id, title: r.occasion ? `${r.occasion}` : 'New request', occasion: r.occasion || '', status: r.status, words: STATUS_WORDS[r.status] || r.status,
    needsYou: ['invited', 'awaiting_client'].includes(r.status) && !(r.status === 'awaiting_client' && S.num(r.linkExpiresAt) < Date.now()),
    dueDate: r.dueDate || '', updatedAt: S.iso(r.updatedAt), token: tokenOf(r.id), decidedByName: r.decidedByName || '',
  }));
  // words / pictures / videos the team sent this company for approval one by one (marketing/clientReview.js): the same private pages, handed out here to a login of the company
  let reviews = [];
  try {
    const CR = require('./clientReview'); // eslint-disable-line global-require
    await CR.ensure();
    const rr = await S.q(`SELECT * FROM "OmniMkClientReview" WHERE (clientId = ? OR (clientId IS NULL AND LOWER(clientName) = LOWER(?))) ORDER BY createdAt DESC LIMIT 40`, c.id, c.name);
    reviews = rr.map((r) => {
      const status = r.status === 'sent' && S.num(r.expiresAt) < Date.now() ? 'expired' : r.status;
      return { id: r.id, title: r.itemTitle || 'For your approval', kind: r.kind === 'content' ? 'words' : 'picture or video', status, needsYou: status === 'sent', decide: r.mode === 'decide', decidedByName: r.decidedByName || '', decidedAt: S.iso(r.decidedAt), sentAt: S.iso(r.createdAt), token: CR.tokenOf(r.id) };
    });
  } catch (e) { console.error('[omni-mk] portal reviews:', e.message); } // eslint-disable-line no-console
  return { company: c.name, projects, reviews, waiting: projects.filter((p) => p.needsYou).length + reviews.filter((x) => x.needsYou).length };
}
// "New request" from the client's own account: the request form (status 'invited') opens at once. A request that was started and not sent is reused, never piled up.
async function portalStart(u) {
  await ensure();
  const c = await clientRecordOf(u);
  if (!c) return { error: 'Your company record was not found: contact TeamLink.', status: 404 };
  const open = (await S.q(`SELECT * FROM "${T}" WHERE deletedAt IS NULL AND status = 'invited' AND source = 'portal' AND clientId = ? ORDER BY createdAt DESC LIMIT 1`, c.id))[0];
  if (open) return { token: tokenOf(open.id), id: open.id, reused: true };
  const id = S.newId('prj'); const now = Date.now();
  await S.run(`INSERT INTO "${T}" (id, title, clientId, clientName, contactName, contactEmail, source, status, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?, 'portal', 'invited', ?, ?, ?)`,
    id, `${c.name}: new request`, c.id, c.name, S.clip(u.name, 120) || null, S.clip(u.email, 160) || null, `${S.clip(u.name, 70)} (client login)`, now, now);
  await event(id, 'invited', `${S.clip(u.name, 60)} (client: ${c.name})`, 'Request started from the client\'s own account');
  await logAudit({ userId: u.id, actorName: `${S.clip(u.name, 60)} (client: ${c.name})`, action: 'Omni-Channel AI Marketing: client started a request from their login', entity: T, entityId: id, toValue: c.name });
  return { token: tokenOf(id), id, reused: false };
}

module.exports = {
  portalList, portalStart, makeDraft,
  ensure, SOURCES, DELIVERABLES, PLATFORM_KEYS, PLATFORM_LABEL, create, invite, briefAssist, list, get, update, accept, decline, setOptions, send, cancelPresentation, extend, scheduled, posted, heldIds,
  publicView, publicOptionFile, publicLogo, publicSubmitRequest, publicChoose, publicChanges, clientApprove, clientReject, clientRejectReason, publicReject, plainWhy, deliverHeld, sendApproval, tokenOf, idOfToken, mayWrite, tell, tellClient, notifyStatus,
  setShowcase, trackRecord, showcaseItems, publicWork, publicWorkFile, accounts, setAutopost, postNow, postTo, autoRun, autoSweep, startAutoPost,
  event, tellTeam, siteFor, firstWord, // marketing/clientChat.js: the timeline line, the team's bell, the https site address, the first name
};
