// ---------------------------------------------------------------------------
// AI MARKETING: WHEN A CLIENT WRITES ON WHATSAPP (founder 2026-11-14: "chat with the client in a simple, general way; when the client sends an image or a
// video we answer simply").
//
// A person who is the contact of an AI Marketing client project (OmniMkProject.contactPhone) writes to one of the company numbers. utils/messageDelivery.js
// hands every WhatsApp message here AFTER the app stored it (never throws, never slows the webhook). This is NOT an AI and costs nothing: a short reply made of
// fixed words, chosen by what they sent (a photo / video / file, thanks, hello, "what is the status", "ok / approved") and by the state of their project.
//
//   * the team always hears of it: a line on the project's timeline and a bell to the project's owner (once per 10 minutes per client);
//   * the reply goes from the SAME number the client wrote to, in the 24-hour window the message itself opened (free text is allowed there);
//   * it stays quiet while a person is chatting (a person's WhatsApp message to this number in the last 30 minutes), after STOP, when an Admin switched it
//     off (AI usage > Telling the client), more than once per 10 minutes for the same kind of message, and after 6 replies in a day;
//   * it never decides anything: "approved" only points to the private page, where the client's own press is the approval (the client approves, not staff);
//   * a photo / video is called "received" only when TeamLink really kept the file (the number is on a client record, so utils/waChats.js saved it in that
//     client's WhatsApp chat); otherwise the reply says only that the team was told, and the team's bell says the file was not kept and how to fix it.
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const Cfg = require('./settings');
const P = require('./projects');

const T = 'OmniMkClientChat';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${T}" ("id" TEXT NOT NULL PRIMARY KEY, "e164" TEXT NOT NULL, "projectId" TEXT, "ref" TEXT, "at" BIGINT NOT NULL, "dir" TEXT NOT NULL, "kind" TEXT, "text" TEXT)`,
  `CREATE INDEX IF NOT EXISTS "${T}_e164" ON "${T}"("e164", "at")`,
];
let okAt = 0;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] client chat schema:', e.message); return false; } // eslint-disable-line no-console, no-await-in-loop
}

const MIN = 60000;
const SAME_KIND_GAP = 10 * MIN; // the same kind of automatic reply to one client at most this often
const BELL_GAP = 10 * MIN; // the team's bell for one client at most this often
const PERSON_HOLD = 30 * MIN; // a person wrote to this number this recently: the automatic reply stays quiet
const DAILY_CAP = 6;
const OPEN_STATUSES = ['invited', 'request', 'working', 'awaiting_client', 'changes', 'approved', 'scheduled'];
const digits = (x) => String(x == null ? '' : x).replace(/\D/g, '');
const tail = (x) => digits(x).slice(-10);
const clip = (v, n) => S.clip(v, n);

// ---- what did they send? -----------------------------------------------------------------------------------------------------------------------------------
const NOUN = { image: 'photo', video: 'video', document: 'file', audio: 'audio message', voice: 'voice message', sticker: 'sticker' };
function mediaOf(info) {
  const m = info && info.media;
  if (!m || !m.type) return null;
  const k = m.type === 'audio' && m.voice ? 'voice' : String(m.type);
  return { kind: k, noun: NOUN[k] || 'file' };
}
const STOP = /^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*$/i;
const THANKS = /\b(thanks?|thank\s*(you|u)|thx|tq|dhanyavad(alu)?|shukriya)\b/i;
const HELLO = /^\s*(hi+|hello+|hey+|hai|namaste|namaskaram|good\s*(morning|afternoon|evening|night)|gm)\b/i;
const STATUS = /\b(status|update|progress|ready|done|when|how\s*long|eppudu|kab)\b/i;
const OK = /\b(approve[ds]?|confirm(ed)?|go\s*ahead|looks?\s*good|ok(ay)?|yes|fine|nice|super|perfect)\b/i;
function intentOf(text, media, project) {
  if (media) return 'media';
  const t = String(text || '').trim();
  if (!t) return 'none';
  if (STOP.test(t)) return 'stop';
  if (THANKS.test(t)) return 'thanks';
  if (project && project.status === 'awaiting_client' && OK.test(t)) return 'approve';
  if (STATUS.test(t)) return 'status';
  if (HELLO.test(t)) return 'hello';
  return 'other';
}

// ---- who is it? ------------------------------------------------------------------------------------------------------------------------------------------------------
// the AI Marketing projects whose contact has this mobile number, newest first
async function projectsOf(e164) {
  const t = tail(e164);
  if (t.length < 10) return [];
  await P.ensure();
  const rows = await S.q(`SELECT * FROM "OmniMkProject" WHERE deletedAt IS NULL AND contactPhone IS NOT NULL AND contactPhone != '' ORDER BY updatedAt DESC LIMIT 3000`);
  return rows.filter((r) => tail(r.contactPhone) === t);
}
const pickOpen = (list) => list.find((r) => OPEN_STATUSES.includes(r.status)) || list[0] || null;

// a PERSON wrote to this number lately (the team is already talking to them)
async function personActive(e164, now) {
  const since = now - PERSON_HOLD;
  try {
    const a = await S.q('SELECT 1 AS x FROM "OmniWaMessage" WHERE e164 = ? AND direction = \'OUT\' AND aiGenerated = 0 AND senderUserId IS NOT NULL AND at > ? LIMIT 1', digits(e164), since);
    if (a.length) return true;
  } catch { /* that table may not exist yet */ }
  try {
    const b = await S.q('SELECT 1 AS x FROM "ConversationMessage" WHERE channel = \'WhatsApp\' AND direction = \'OUT\' AND senderUserId IS NOT NULL AND address LIKE ? AND createdAt > ? LIMIT 1', `%${tail(e164)}`, since);
    if (b.length) return true;
  } catch { /* nor this one */ }
  return false;
}

// ---- the words ---------------------------------------------------------------------------------------------------------------------------------------------------------
function wordsFor({ intent, media, kept, p, first, brand, link }) {
  const hi = first ? `Hi ${first},` : 'Hi,';
  const occ = p && p.occasion ? ` for ${clip(p.occasion, 80)}` : '';
  const team = `${hi} thank you for your message. Our team has been told and will reply here shortly.`;
  if (intent === 'media') {
    if (!kept) return team;
    return `${hi} thank you! We received your ${media.noun}.${p && p.occasion ? ` We have noted it for your ${clip(p.occasion, 80)} request.` : ''} Our team will look at it and message you here.`;
  }
  if (intent === 'thanks') return `You are welcome${first ? `, ${first}` : ''}! Message us here any time.`;
  if (intent === 'hello') return `${hi} this is ${brand}. How can we help you today? Type your message here and our team will reply.`;
  if (intent === 'approve') return link ? `${hi} thank you! To approve, please open your private page and press the approve button, so it is saved on record: ${link}` : team;
  if (intent === 'status') {
    const s = p ? p.status : '';
    if (s === 'invited') return link ? `${hi} we are waiting for the details of your request. Please fill them in here (about two minutes): ${link}` : `${hi} we are waiting for the details of your request. Our team will send you the link here.`;
    if (s === 'request') return `${hi} we have your request${occ}. Our team will look at it soon and message you here.`;
    if (s === 'working' || s === 'changes') return `${hi} our team is working on your request${occ}. We will message you here as soon as your options are ready.`;
    if (s === 'awaiting_client') return link ? `${hi} your options${occ} are ready. Please open your private page, choose the one you like and add any suggestions: ${link}` : `${hi} your options${occ} are ready. Our team will send you the link here.`;
    if (s === 'approved' || s === 'scheduled') return `${hi} your post${occ} is approved. Our team will post it and message you here.`;
    if (s === 'posted') return `${hi} your post${occ} is already live. Thank you for working with ${brand}!`;
    if (s === 'declined') return `${hi} we could not take up that request. You can send a new one any time, or write here and our team will help.`;
    return team;
  }
  return p && link && ['working', 'changes', 'awaiting_client'].includes(p.status) ? `${team} You can follow your request here: ${link}` : team;
}

// ---- one message -----------------------------------------------------------------------------------------------------------------------------------------------------
// info: what utils/messageDelivery.applyInbound got { from, text, id, at, name, media?, numberId? }; result: what processInbound answered.
async function handle(info, result, now) {
  if ((info.channel || 'WhatsApp') !== 'WhatsApp' || !result || result.duplicate) return null;
  const e164 = digits(info.from);
  if (!e164) return null;
  const projects = await projectsOf(e164);
  if (!projects.length) return null; // not the contact of any AI Marketing project: nothing here (other chats are handled elsewhere)
  if (result.stop) return { skipped: 'stop' };
  if (!(await ensure())) return null;
  const ref = info.id ? clip(info.id, 200) : null;
  if (ref && (await S.q(`SELECT 1 AS x FROM "${T}" WHERE ref = ? LIMIT 1`, ref)).length) return { skipped: 'again' }; // the provider re-sent it: handled once
  const set = await Cfg.getSettings();
  const cn = set.clientNotify || {};
  const p = pickOpen(projects);
  const media = mediaOf(info);
  const text = String(info.text || '').trim();
  const intent = intentOf(media ? '' : text, media, p);
  if (intent === 'none' || intent === 'stop') return { skipped: intent };
  const kept = !!media && result.personType === 'CLIENT'; // the existing chat saved the file
  const first = P.firstWord(p.contactName) || P.firstWord(info.name) || '';
  const label = media ? `a ${media.noun}` : `"${clip(text, 120)}"`;

  // the team always hears of it
  const prevIn = await S.q(`SELECT at FROM "${T}" WHERE e164 = ? AND dir = 'in' ORDER BY at DESC LIMIT 1`, e164);
  await S.run(`INSERT INTO "${T}" (id, e164, projectId, ref, at, dir, kind, text) VALUES (?,?,?,?,?,?,?,?)`, S.newId('mcc'), e164, p.id, ref, now, 'in', media ? media.kind : 'text', clip(media ? `[${media.noun}]` : text, 300));
  await P.event(p.id, 'client_msg', first || p.clientName, media ? `Sent ${label} on WhatsApp${kept ? ' (it is in WhatsApp Chats)' : ' (TeamLink could not keep the file)'}` : `Wrote on WhatsApp: ${label}`);
  if (!prevIn.length || now - Number(prevIn[0].at) > BELL_GAP) {
    const who = p.contactName ? `${p.contactName} (${p.clientName})` : p.clientName;
    const fix = media && !kept ? ' TeamLink did not keep the file because this number is not saved on the client\'s record: open it in the WhatsApp Business app, and add the number to the client (Clients > contact WhatsApp) so the next ones are kept.' : '';
    await P.tellTeam(p, `${who} wrote on WhatsApp`, `${media ? `Sent ${label}.` : `${label}`} Open WhatsApp Chats or Client projects and reply.${fix}`).catch(() => {});
  }

  // the reply
  if (cn.chat === false) return { replied: false, why: 'off' };
  if (await personActive(e164, now)) return { replied: false, why: 'a person is chatting' };
  const kind = intent === 'media' ? 'media' : 'text';
  const recent = await S.q(`SELECT kind, at FROM "${T}" WHERE e164 = ? AND dir = 'auto' AND at > ? ORDER BY at DESC`, e164, now - 24 * 60 * MIN);
  if (recent.length >= DAILY_CAP) return { replied: false, why: 'daily limit' };
  if (recent.some((r) => (r.kind === 'media') === (kind === 'media') && now - Number(r.at) < SAME_KIND_GAP)) return { replied: false, why: 'just answered' };

  const site = P.siteFor('');
  const link = site ? `${site}/client-project/${P.tokenOf(p.id)}` : '';
  const brand = (await Cfg.getBrand()).brandName || 'TeamLink';
  const body = wordsFor({ intent, media, kept, p, first, brand, link });
  const messaging = require('../utils/messaging'); // eslint-disable-line global-require
  const meta = { audience: 'client', personName: clip(p.contactName || p.clientName, 80), purpose: 'AI Marketing: reply to the client\'s WhatsApp', module: 'AI Marketing', automatic: true };
  const res = await messaging.send('WhatsApp', { to: e164, kind: 'text', text: body, vars: [body], ...(info.numberId ? { numberId: info.numberId, automatic: true } : {}), meta });
  if (!res || !res.ok) {
    await P.event(p.id, 'chat_failed', 'TeamLink', `The automatic reply could not be sent: ${clip((res && res.error) || 'the sender refused it', 160)}`);
    return { replied: false, why: 'send failed' };
  }
  await S.run(`INSERT INTO "${T}" (id, e164, projectId, ref, at, dir, kind, text) VALUES (?,?,?,?,?,?,?,?)`, S.newId('mcc'), e164, p.id, null, Date.now(), 'auto', kind, clip(body, 300));
  await P.event(p.id, 'chat_auto', 'TeamLink', `Replied on WhatsApp by itself: ${clip(body, 200)}`);
  if (result.personType === 'CLIENT' && result.personId) { // the client's chat page shows our reply too
    await require('../utils/conversations').recordOut({ personType: 'CLIENT', personId: result.personId, personName: info.name || p.contactName, channel: 'WhatsApp', body, address: `+${e164}`, status: 'SENT', statusDetail: 'Sent by TeamLink (automatic reply)', providerRef: res.providerRef || null, templateLabel: 'Automatic reply', senderName: 'TeamLink (automatic)' }).catch(() => {}); // eslint-disable-line global-require
  }
  return { replied: true, intent, kept };
}

// never throws: the webhook must stay quick and alive
async function onInbound(info, result, now = Date.now()) {
  try { return await handle(info || {}, result || {}, now); } catch (e) { console.error('[omni-mk] client chat:', e && e.message); return null; } // eslint-disable-line no-console
}

module.exports = { onInbound, intentOf, wordsFor, projectsOf, ensure, SAME_KIND_GAP, DAILY_CAP };
