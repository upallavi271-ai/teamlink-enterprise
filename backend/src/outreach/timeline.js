// ---------------------------------------------------------------------------
// CANDIDATE COMMUNICATION TIMELINE (founder structure plan 2026-10-17): ONE list on the candidate page, read only, newest first:
//   WhatsApp sent, Email sent, SMS sent, Call done, Campaign added, Reply received, Interview scheduled, Offer shared, Joined.
// Merged from: the candidate's messages (CandidateMessage), the one inbox (ConversationMessage: replies, sends, call logs), the follow-up log
// (completed follow-ups by call / message), the ATS step history (interview, offer, joined) and Omni-Channel campaigns (matched by phone / email).
// PRIVACY: only a label and a time. Never an address, never message text, never salary, so it is safe for the BDE team too.
// A login that may not open the candidate gets nothing (the same visibility test as the Inbox).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const S = require('./store');
const K = require('./contacts');

const OKAY = (s) => /^(SENT|DELIVERED|READ|OPENED)/i.test(String(s || ''));
const ICON = { whatsapp: 'whatsapp', email: 'email', sms: 'sms', call: 'call', campaign: 'campaign', reply: 'reply', interview: 'interview', offer: 'offer', joined: 'joined' };
const WAY = { whatsapp: 'WhatsApp', email: 'Email', sms: 'SMS' };
const ms = (v) => (v instanceof Date ? v.getTime() : (Date.parse(v) || 0));

async function candidateTimeline(user, candidateId) {
  const convo = require('../utils/conversations'); // eslint-disable-line global-require
  const vis = await convo.visibleIds(user, 'CANDIDATE', [String(candidateId)]).catch(() => new Set());
  if (!vis.has(String(candidateId))) return null;
  const cand = await prisma.candidate.findUnique({ where: { id: candidateId }, select: { id: true, phone: true, email: true } });
  if (!cand) return null;
  const ev = [];
  const push = (kind, at, text, extra = {}) => { if (at) ev.push({ kind, icon: ICON[kind] || kind, at: new Date(at).toISOString(), text, ...extra }); };

  // messages sent to the candidate (stage mails, bulk, single)
  const cm = await prisma.candidateMessage.findMany({ where: { candidateId }, orderBy: { createdAt: 'desc' }, take: 300, select: { channel: true, templateLabel: true, template: true, status: true, createdAt: true } }).catch(() => []);
  const sentAt = [];
  const conv = []; // call logs (channel Call) are rows of the same table
  cm.forEach((m) => {
    const way = String(m.channel || '').toLowerCase();
    if (String(m.status).toUpperCase() === 'RECEIVED') { push('reply', m.createdAt, `Reply received on ${WAY[way] || m.channel}`); return; }
    if (way === 'call') { if (!/FAIL|BLOCK/i.test(String(m.status))) { push('call', m.createdAt, 'Call done'); conv.push({ channel: 'Call', createdAt: m.createdAt }); } return; }
    if (!WAY[way] || !OKAY(m.status)) return;
    sentAt.push([way, ms(m.createdAt)]);
    push(way, m.createdAt, `${WAY[way]} sent${m.templateLabel ? `: ${m.templateLabel}` : ''}`);
  });
  // the follow-up log: a finished follow-up by call (or by a message)
  const fu = await prisma.applicationFollowUp.findMany({ where: { candidateId, completedAt: { not: null } }, select: { contactMode: true, completedAt: true, lastContactedAt: true }, take: 100 }).catch(() => []);
  fu.forEach((f) => {
    const mode = String(f.contactMode || '').toLowerCase();
    const at = f.lastContactedAt || f.completedAt;
    if (mode === 'call') { if (!conv.some((m) => String(m.channel).toLowerCase() === 'call' && Math.abs(ms(m.createdAt) - ms(at)) < 3600000)) push('call', at, 'Call done (follow-up)'); } else if (WAY[mode] && !sentAt.some(([w, t]) => w === mode && Math.abs(t - ms(at)) < 3600000)) push(mode, at, `${WAY[mode]} sent (follow-up)`);
  });
  // ATS steps: interview booked, offer shared, joined
  const steps = await prisma.applicationStageEvent.findMany({ where: { candidateId, toStage: { in: ['INTERVIEW_SCHEDULED', 'OFFER', 'JOINED', 'HIRED'] } }, orderBy: { createdAt: 'desc' }, take: 60, select: { toStage: true, createdAt: true, application: { select: { requirement: { select: { title: true } } } } } }).catch(() => []);
  steps.forEach((s) => {
    const job = s.application && s.application.requirement ? ` for ${s.application.requirement.title}` : '';
    if (s.toStage === 'INTERVIEW_SCHEDULED') push('interview', s.createdAt, `Interview scheduled${job}`);
    else if (s.toStage === 'OFFER') push('offer', s.createdAt, `Offer shared${job}`);
    else push('joined', s.createdAt, `Joined${job}`);
  });
  // Omni-Channel campaigns that messaged this person (matched by phone / email), only the ones this login may see
  try {
    if (await S.campaignsReady()) {
      const p = K.phoneOf(cand.phone); const e = K.emailOf(cand.email);
      const contacts = await K.findByKeys(p.ok ? p.key : null, e.ok ? e.key : null);
      if (contacts.length) {
        const visible = new Set((await require('./campaigns').visibleRows(user)).map((c) => c.id)); // eslint-disable-line global-require
        const rows = await S.q(`SELECT m.campaignId, m.queuedAt, k.name FROM "OutreachMessage" m JOIN "OutreachCampaign" k ON k.id = m.campaignId WHERE m.contactId IN (${contacts.map(() => '?').join(',')}) AND m.status <> 'skipped' ORDER BY m.queuedAt DESC LIMIT 20`, ...contacts.map((c) => c.id));
        rows.filter((r) => visible.has(r.campaignId)).forEach((r) => push('campaign', S.ms(r.queuedAt), `Added to campaign "${r.name}"`));
      }
    }
  } catch { /* Omni-Channel tables not there */ }
  ev.sort((a, b) => b.at.localeCompare(a.at));
  return { candidateId, items: ev.slice(0, 200), legend: ['whatsapp', 'email', 'sms', 'call', 'campaign', 'reply', 'interview', 'offer', 'joined'].map((k) => ({ kind: k })) };
}

module.exports = { candidateTimeline };
