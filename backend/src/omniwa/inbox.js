// ---------------------------------------------------------------------------
// OMNI-CHANNEL > INBOX & REPLIES > WHATSAPP: what the screen reads. The list is the app's existing chat list (utils/waChats.js listChats: the same visibility, the same
// masking, the same WhatsApp-number access) with the AI state on top, plus the leads (numbers with no candidate), which only OmniWaConv knows. Also: the promotion
// log and the "already contacted" check.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const S = require('../outreach/store');
const A = require('../outreach/access');
const { ensure } = require('./schema');

const WEEK = 7 * 86400000;
const DAY = 86400000;

function badgeOf(c) {
  if (!c) return { badge: 'human', word: 'Human' };
  if (c.state === 'stopped') return { badge: 'stopped', word: 'Stopped' };
  if (c.state === 'needs_human') return { badge: 'needs_human', word: 'Needs human' };
  if (c.state === 'not_interested') return { badge: 'not_interested', word: 'Not interested' };
  if (c.mode === 'paused') return { badge: 'paused', word: 'AI paused' };
  if (Number(c.aiTurns) > 0 && c.mode === 'ai') return { badge: 'ai', word: 'AI' };
  return { badge: 'human', word: 'Human' };
}
const aiOf = (c) => ({
  ...badgeOf(c), mode: c ? c.mode : null, state: c ? c.state : null, turns: c ? Number(c.aiTurns) : 0, reason: c ? c.handoffReason : null, pausedBy: c ? c.pausedByName : null,
  campaignId: c ? c.campaignId : null, campaignName: c ? c.campaignName : null, canPause: !!(c && c.mode === 'ai' && c.state === 'active'), canResume: !!(c && c.mode !== 'ai' && c.mode !== 'off') || !!(c && c.state === 'needs_human'),
});

async function leadVisible(user, c, numbers) {
  if (A.level(user) === 'admin') return true;
  if (c.ownerUserId && c.ownerUserId === user.id) return true;
  if (!['depthead', 'teamlead'].includes(A.level(user))) return false;
  return numbers === 'ALL' || (c.numberId && numbers.has(c.numberId));
}

async function list(user, query = {}) {
  await ensure();
  const WC = require('../utils/waChats'); // eslint-disable-line global-require
  const WN = require('../utils/waNumbers'); // eslint-disable-line global-require
  const access = require('../utils/contactAccess'); // eslint-disable-line global-require
  const filter = ['all', 'unread', 'ai', 'human'].includes(query.filter) ? query.filter : 'all';
  const base = await WC.listChats(user, { q: query.q, requirementId: query.requirementId || undefined, numberId: query.numberId || undefined });
  const ids = base.rows.filter((r) => r.personType === 'CANDIDATE').map((r) => r.personId);
  const convs = new Map();
  for (let i = 0; i < ids.length; i += 300) {
    const part = ids.slice(i, i + 300);
    // eslint-disable-next-line no-await-in-loop
    (await S.q(`SELECT * FROM "OmniWaConv" WHERE candidateId IN (${part.map(() => '?').join(',')})`, ...part)).forEach((c) => convs.set(c.candidateId, c));
  }
  const rows = base.rows.map((r) => {
    const c = r.personType === 'CANDIDATE' ? convs.get(r.personId) || null : null;
    return { ...r, ownerUserId: (c && c.ownerUserId) || r.ownerUserId, ownerName: (c && c.ownerName) || r.ownerName, ai: aiOf(c) };
  });
  // leads
  const numbers = await WN.visibleNumberIds(user);
  const text = String(query.q || '').trim().toLowerCase();
  const leadRows = await S.q('SELECT * FROM "OmniWaConv" WHERE personType = \'LEAD\' ORDER BY updatedAt DESC LIMIT 200');
  for (const c of leadRows) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await leadVisible(user, c, numbers))) continue; // eslint-disable-line no-continue
    if (text && !String(c.name || '').toLowerCase().includes(text) && !c.e164.includes(text.replace(/\D/g, '') || '~')) continue; // eslint-disable-line no-continue
    if (query.requirementId && c.requirementId !== query.requirementId) continue; // eslint-disable-line no-continue
    rows.push({
      key: `LEAD:${c.id}`, audience: 'leads', personType: 'LEAD', personId: c.id, name: c.name || 'New number', phoneHint: A.level(user) === 'admin' ? `+${c.e164}` : access.maskedHint(c.e164), requirement: null, step: null,
      last: { at: Number(c.lastInboundAt) || Number(c.updatedAt), direction: 'in', state: 'received', text: c.lastText || '', failed: false }, unread: Number(c.unread) || 0, needsReply: true,
      numbers: [], sendingFrom: null, ownerUserId: c.ownerUserId, ownerName: c.ownerName, intent: null, followUp: null, ai: aiOf(c),
    });
  }
  rows.sort((a, b) => b.last.at - a.last.at);
  const owners = new Map(); const campaigns = new Map();
  rows.forEach((r) => {
    if (r.ownerUserId) owners.set(r.ownerUserId, { id: r.ownerUserId, name: r.ownerName || 'Recruiter' });
    if (r.ai.campaignId) campaigns.set(r.ai.campaignId, { id: r.ai.campaignId, name: r.ai.campaignName || 'Promotion' });
  });
  const byPick = rows.filter((r) => (!query.owner || r.ownerUserId === query.owner) && (!query.campaign || r.ai.campaignId === query.campaign));
  const counts = { all: byPick.length, unread: byPick.filter((r) => r.unread > 0).length, ai: byPick.filter((r) => r.ai.badge === 'ai').length, human: byPick.filter((r) => r.ai.badge === 'needs_human').length };
  const shown = byPick.filter((r) => (filter === 'unread' ? r.unread > 0 : filter === 'ai' ? r.ai.badge === 'ai' : filter === 'human' ? r.ai.badge === 'needs_human' : true));
  return {
    now: Date.now(), rows: shown, counts, requirements: base.requirements, owners: [...owners.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))), campaigns: [...campaigns.values()],
    masked: base.masked, allowed: base.allowed,
  };
}

// who else reached this candidate in the last 7 days. ids -> Map(candidateId -> { byName, at, channel })
async function recentContact(user, ids) {
  const out = new Map();
  const unique = [...new Set((ids || []).map(String))].slice(0, 2000);
  for (let i = 0; i < unique.length; i += 300) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.candidateMessage.findMany({
      where: { candidateId: { in: unique.slice(i, i + 300) }, senderUserId: { not: null, ...(user ? { notIn: [user.id] } : {}) }, createdAt: { gte: new Date(Date.now() - WEEK) }, status: { in: ['SENT', 'DELIVERED', 'READ', 'LOGGED', 'OPENED_ON_DEVICE'] } },
      orderBy: { createdAt: 'asc' }, select: { candidateId: true, senderName: true, channel: true, createdAt: true },
    });
    rows.forEach((r) => out.set(r.candidateId, { byName: r.senderName || 'Another recruiter', at: r.createdAt.getTime(), channel: r.channel }));
  }
  return out;
}

// the strip above a chat. key = CANDIDATE:<id> | LEAD:<conv id>
async function detail(user, key) {
  await ensure();
  const [type, id] = String(key || '').split(':');
  const convo = require('../utils/conversations'); // eslint-disable-line global-require
  let c = null;
  if (type === 'CANDIDATE') {
    const vis = await convo.visibleIds(user, 'CANDIDATE', [id]);
    if (!vis.has(id)) return { error: 'This person is outside your access.', status: 403 };
    c = (await S.q('SELECT * FROM "OmniWaConv" WHERE candidateId = ?', id))[0] || null;
  } else if (type === 'LEAD') {
    c = (await S.q('SELECT * FROM "OmniWaConv" WHERE id = ? AND personType = \'LEAD\'', id))[0] || null;
    const numbers = await require('../utils/waNumbers').visibleNumberIds(user); // eslint-disable-line global-require
    if (!c || !(await leadVisible(user, c, numbers))) return { error: 'This chat is outside your access.', status: 403 };
  } else return { error: 'Unknown chat.', status: 404 };
  let last = c && c.lastInboundAt ? Number(c.lastInboundAt) : null;
  if (!last && type === 'CANDIDATE') {
    const m = await prisma.candidateMessage.findFirst({ where: { candidateId: id, channel: 'WhatsApp', status: 'RECEIVED' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    last = m ? m.createdAt.getTime() : null;
  }
  const closesAt = last ? last + DAY : null;
  const seen = type === 'CANDIDATE' ? (await recentContact(user, [id])).get(id) || null : null;
  const blocked = c ? (await S.q('SELECT 1 AS x FROM "OmniWaOptOut" WHERE e164 = ?', c.e164)).length > 0 : false;
  let collected = {};
  try { collected = c ? JSON.parse(c.collected || '{}') : {}; } catch { collected = {}; }
  delete collected.applyLinkSentAt;
  ['jobChoices', 'cardShown', 'promoJob', 'promoCardSent', 'intakeOn', 'intakeDone', 'intakeAt', 'chosenJob'].forEach((k) => { delete collected[k]; });
  // the AI WhatsApp Marketing Assistant's lead card: the details it collected, the Hot / Warm / Cold score with its reasons, the summary and the next step (omniwa/assistLead.js)
  let assist = null;
  const AL = require('./assistLead'); // eslint-disable-line global-require
  if (c && Object.keys(AL.leadOf(c)).length) {
    const a = await AL.assess(c, { stopped: blocked });
    const l = a.lead;
    assist = {
      band: a.sc.band, score: a.sc.score, reasons: a.sc.reasons, summary: a.summary, crmLeadId: l.crmLeadId || null, collecting: l.pending || null, done: !!l.done, declined: !!l.declined,
      fields: { name: l.name || null, service: l.service || null, requirement: l.requirement || null, budget: l.budget || null, callback: l.callback || null },
    };
  }
  delete collected.assistLead;
  return { conv: c, view: { key, ai: aiOf(c), window: { open: !!closesAt && closesAt > Date.now(), closesAt }, alreadyContacted: seen, stopped: blocked, collected, ownerName: c ? c.ownerName : null, leadName: type === 'LEAD' && c ? c.name : null, assist } };
}

// the AI WhatsApp Marketing Assistant's leads: the chats where it collected details or scored a customer, each login within its own chats (the same rule as the chat list)
const BAND_RANK = { Hot: 0, Warm: 1, Cold: 2 };
async function assistLeads(user, query = {}) {
  await ensure();
  const AL = require('./assistLead'); // eslint-disable-line global-require
  const access = require('../utils/contactAccess'); // eslint-disable-line global-require
  const numbers = await require('../utils/waNumbers').visibleNumberIds(user); // eslint-disable-line global-require
  const text = String(query.q || '').trim().toLowerCase();
  const band = ['Hot', 'Warm', 'Cold'].includes(query.band) ? query.band : null;
  const all = [];
  for (const c of await S.q(`SELECT * FROM "OmniWaConv" WHERE personType = 'LEAD' AND collected LIKE '%"assistLead"%' ORDER BY updatedAt DESC LIMIT 300`)) {
    if (!(await leadVisible(user, c, numbers))) continue; // eslint-disable-line no-await-in-loop
    const l = AL.leadOf(c);
    all.push({
      key: `LEAD:${c.id}`, name: l.name || c.name || 'New number', phoneHint: A.level(user) === 'admin' ? `+${c.e164}` : access.maskedHint(c.e164), service: l.service || null, requirement: l.requirement || null, budget: l.budget || null,
      callback: l.callback || null, band: l.band || null, score: l.score === undefined ? null : l.score, crmLeadId: l.crmLeadId || null, saved: !!l.crmLeadId, ownerUserId: c.ownerUserId, ownerName: c.ownerName, ai: aiOf(c), updatedAt: Number(c.updatedAt), lastText: c.lastText || '',
    });
  }
  const counts = { all: all.length, Hot: 0, Warm: 0, Cold: 0 };
  all.forEach((r) => { if (r.band) counts[r.band] += 1; });
  const rows = all.filter((r) => (!band || r.band === band) && (!text || `${r.name} ${r.service || ''} ${r.phoneHint}`.toLowerCase().includes(text)))
    .sort((a, b) => (BAND_RANK[a.band] === undefined ? 3 : BAND_RANK[a.band]) - (BAND_RANK[b.band] === undefined ? 3 : BAND_RANK[b.band]) || b.updatedAt - a.updatedAt);
  return { rows: rows.slice(0, 200), counts };
}

async function leadMessages(convId) {
  const rows = await S.q('SELECT id, direction, body, status, aiGenerated, senderName, at FROM "OmniWaMessage" WHERE convId = ? ORDER BY at DESC LIMIT 200', convId);
  return rows.reverse().map((r) => ({ id: r.id, direction: r.direction, text: r.body, state: r.status, ai: !!r.aiGenerated, by: r.senderName, at: Number(r.at) }));
}

// the promotion log: every WhatsApp promotion with its job, campaign, template, recruiter and status, each login within its own people
async function promotions(user, query = {}) {
  await ensure();
  const convo = require('../utils/conversations'); // eslint-disable-line global-require
  const where = ['m.direction = \'OUT\'', 'm.campaignId IS NOT NULL', 'm.aiGenerated = 0'];
  const args = [];
  if (query.campaign) { where.push('m.campaignId = ?'); args.push(String(query.campaign)); }
  if (query.status) { where.push('m.status = ?'); args.push(String(query.status)); }
  const rows = await S.q(`SELECT m.id, m.candidateId, m.requirementId, m.campaignId, m.template, m.status, m.statusDetail, m.senderUserId, m.senderName, m.at, c.name AS campaignName, r.title AS jobTitle, p.name AS candidateName
    FROM "OmniWaMessage" m LEFT JOIN "OmniWaCampaign" c ON c.id = m.campaignId LEFT JOIN "Requirement" r ON r.id = m.requirementId LEFT JOIN "Candidate" p ON p.id = m.candidateId
    WHERE ${where.join(' AND ')} ORDER BY m.at DESC LIMIT 1000`, ...args);
  const vis = await convo.visibleIds(user, 'CANDIDATE', [...new Set(rows.map((r) => r.candidateId).filter(Boolean))]);
  const seen = rows.filter((r) => r.senderUserId === user.id || (r.candidateId && vis.has(r.candidateId))).slice(0, 300);
  const count = (s) => seen.filter((r) => r.status === s).length;
  return { rows: seen.map((r) => ({ ...r, at: Number(r.at) })), counts: { sent: seen.length, delivered: count('delivered') + count('read'), read: count('read'), failed: count('failed') } };
}

async function runs(query = {}) {
  await ensure();
  const rows = await S.q('SELECT r.id, r.input, r.toolCalls, r.output, r.outcome, r.error, r.model, r.ms, r.at, c.name FROM "OmniWaAiRun" r LEFT JOIN "OmniWaConv" c ON c.id = r.convId ORDER BY r.at DESC LIMIT ?', Math.min(Number(query.limit) || 100, 300));
  return rows.map((r) => { let calls = []; try { calls = JSON.parse(r.toolCalls || '[]'); } catch { calls = []; } return { ...r, toolCalls: calls, at: Number(r.at), ms: Number(r.ms) || 0 }; });
}

module.exports = { list, detail, assistLeads, recentContact, promotions, leadMessages, runs, aiOf, leadVisible };
