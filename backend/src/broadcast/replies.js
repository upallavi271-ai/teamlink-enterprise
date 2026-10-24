// ---------------------------------------------------------------------------
// REPLIES TO A JOB BROADCAST, delivery reports, opt-outs, the optional auto reply, "Add as candidate".
//   handle(info)         called from utils/messageDelivery.applyInbound for EVERY inbound message (never throws, never
//                        blocks the normal inbox handling). Matches the sender's number to a contact a campaign sent to
//                        in the last 14 days; anything else is ignored here.
//   statusReport(info)   called from utils/messageDelivery.applyStatus: the row moves sent -> delivered -> read / failed.
//   addAsCandidate()     creates the candidate (or finds the one already on file: the duplicate rules of the candidate
//                        master decide) and the application on the job, Source = "WhatsApp campaign: <list>".
// ---------------------------------------------------------------------------
const prisma = require('../db');
const S = require('./store');
const A = require('./access');
const C = require('./campaign');
const intent = require('./intent');
const delivery = require('../utils/messageDelivery');
const { logAudit } = require('../utils/audit');

const WINDOW = 14 * 86400000;
const RANK = { queued: 0, sending: 1, sent: 2, delivered: 3, read: 4 };
const digits = (v) => delivery.digitsOf(v);

async function recentCampaigns() {
  const out = [];
  for (const k of await S.keys('bc.camp.')) {
    const c = await S.get(k); // eslint-disable-line no-await-in-loop
    if (c && ['RUNNING', 'DONE', 'PAUSED', 'CANCELLED', 'SCHEDULED'].includes(c.status) && c.startedAt && Date.now() - Date.parse(c.endedAt || c.startedAt) < WINDOW + 86400000) out.push(c);
  }
  return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

// the newest sent row for this number
async function findRecipient(e164) {
  for (const c of await recentCampaigns()) {
    const rows = await S.get(C.rowsKey(c.id), []); // eslint-disable-line no-await-in-loop
    const row = rows.find((x) => x.phone === e164 && ['sent', 'delivered', 'read', 'sending'].includes(x.st));
    if (row && Date.now() - Date.parse(row.at || c.startedAt) < WINDOW) return { camp: c, row };
  }
  return null;
}

async function putOptOut(e164, text, at) {
  const key = `${delivery.OPTOUT_PREFIX}WhatsApp.${e164}`;
  const v = JSON.stringify({ at: at.toISOString(), text: String(text).slice(0, 40), by: 'requirement broadcast' });
  await prisma.appSetting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } }).catch(() => {});
  // every list shows the person as "On the STOP list" and every campaign drops what was still waiting for them
  for (const k of await S.keys('bc.contacts.')) {
    const id = k.slice('bc.contacts.'.length);
    await S.update(k, [], (cs) => { let hit = false; cs.forEach((c) => { if (c.phone === e164 && c.status !== 'stop') { c.status = 'stop'; c.why = 'This person asked us to stop (STOP list).'; hit = true; } }); return hit ? cs : undefined; }); // eslint-disable-line no-await-in-loop
    void id; // eslint-disable-line no-void
  }
  for (const k of await S.keys('bc.crow.')) {
    await S.update(k, [], (rows) => { let hit = false; rows.forEach((r) => { if (r.phone === e164 && r.st === 'queued') { r.st = 'skipped'; r.why = 'On the STOP list'; hit = true; } }); return hit ? rows : undefined; }); // eslint-disable-line no-await-in-loop
  }
}

async function bell(camp, count = 1) {
  const key = `bc.bell.${camp.id}`;
  const d = await S.update(key, { last: 0, pending: 0 }, (cur) => { cur.pending += count; return cur; });
  if (Date.now() - d.last < 3600000) return;
  const n = d.pending;
  await S.put(key, { last: Date.now(), pending: 0 });
  try {
    const ids = [camp.createdById, camp.ownerId];
    const r = await prisma.requirement.findUnique({ where: { id: camp.jobId }, select: { tlId: true, bdeId: true } });
    if (r) ids.push(r.tlId, r.bdeId);
    const users = await prisma.user.findMany({ where: { id: { in: ids.filter(Boolean) } }, select: { id: true } });
    await require('../utils/notify').notifyUsers(users.map((u) => u.id), { title: `${n} new ${n === 1 ? 'reply' : 'replies'} to ${camp.jobTitle} campaign`, message: `People wrote back to the requirement message sent to "${camp.listName}". Open Contact lists > Campaigns to read them.` }); // eslint-disable-line global-require
  } catch { /* the bell is a helper */ }
}

// info: { channel, from, text, id, at, name }
async function handle(info) {
  try {
    const e164 = digits(info.from);
    if (!e164) return { matched: false };
    const hit = await findRecipient(e164);
    if (!hit) return { matched: false };
    const { camp, row } = hit;
    const at = info.at ? new Date(info.at) : new Date();
    const text = String(info.text || '').slice(0, 2000);
    const kind = intent.classify(text);
    const ref = info.id ? String(info.id).slice(0, 200) : null;
    let dup = false;
    await S.update(`bc.reply.${camp.id}`, [], (list) => {
      if (ref && list.some((x) => x.ref === ref)) { dup = true; return undefined; }
      list.push({ id: S.newId('rp'), ref, phone: e164, name: row.name, text, at: at.toISOString(), intent: kind });
      return list;
    });
    if (dup) return { matched: true, duplicate: true };
    await C.setRow(camp.id, row.i, { replied: true, intent: kind, st: RANK[row.st] < RANK.delivered ? 'delivered' : row.st });
    if (kind === 'optout') {
      await putOptOut(e164, text, at);
      await logAudit({ userId: null, actorName: 'TeamLink', action: 'Requirement broadcast: contact opted out', entity: 'Campaign', entityId: camp.id, toValue: `${row.name || 'A contact'} wrote "${text.slice(0, 30)}": added to the STOP list` });
    } else {
      await bell(camp);
      const st = await S.settings();
      if (kind === 'interested' && st.autoReply.on && st.master) await autoReply(camp, row, e164);
    }
    return { matched: true, intent: kind, campaignId: camp.id };
  } catch (e) { console.error('[broadcast] reply:', e.message); return { matched: false, error: e.message }; } // eslint-disable-line no-console
}

async function autoReply(camp, row, e164) {
  const st = await S.settings();
  const key = `bc.auto.${camp.id}.${e164}`;
  if (await S.get(key)) return; // once per contact per campaign
  await S.put(key, { at: new Date().toISOString() });
  const r = await prisma.requirement.findUnique({ where: { id: camp.jobId }, include: { client: true } });
  const text = C.merge(st.autoReply.text, row, r, camp.base);
  // the official API allows a plain text inside 24 hours of their message: they just wrote, so the window is open
  const res = await C.transport({ ...camp, templateId: null }, { ...row, phone: e164 }, text, r);
  await S.update(`bc.reply.${camp.id}`, [], (list) => { for (let i = list.length - 1; i >= 0; i -= 1) if (list[i].phone === e164) { list[i].autoReplied = !!res.ok; break; } return list; });
  await logAudit({ userId: null, actorName: 'TeamLink', action: res.ok ? 'Requirement broadcast: automatic reply sent' : 'Requirement broadcast: automatic reply failed', entity: 'Campaign', entityId: camp.id, toValue: res.ok ? `to ${row.name || 'a contact'}` : String(res.error || '').slice(0, 200) });
}

// info: { providerRef, status ('SENT'|'DELIVERED'|'READ'|'FAILED'), error }
async function statusReport(info) {
  try {
    if (!info.providerRef) return 0;
    const map = { SENT: 'sent', DELIVERED: 'delivered', READ: 'read', FAILED: 'failed' };
    const st = map[String(info.status).toUpperCase()];
    if (!st) return 0;
    let n = 0;
    for (const c of await recentCampaigns()) {
      const rows = await S.get(C.rowsKey(c.id), []); // eslint-disable-line no-await-in-loop
      const row = rows.find((x) => x.ref === info.providerRef);
      if (!row) continue; // eslint-disable-line no-continue
      if (st !== 'failed' && (RANK[row.st] || 0) >= RANK[st]) { n += 1; continue; } // eslint-disable-line no-continue
      await C.setRow(c.id, row.i, st === 'failed' ? { st: 'failed', why: String(info.error || 'WhatsApp could not deliver it').slice(0, 200) } : { st, why: '' }); // eslint-disable-line no-await-in-loop
      n += 1;
    }
    return n;
  } catch { return 0; }
}

// ---- Add as candidate ------------------------------------------------------------------------
async function addOne(user, camp, reply, r, list) {
  const core = require('../utils/messagingCore'); // eslint-disable-line global-require
  const contacts = await S.get(`bc.contacts.${camp.listId}`, []);
  const contact = contacts.find((c) => c.phone === reply.phone) || {};
  const tail = reply.phone.slice(-10);
  const found = await prisma.candidate.findMany({ where: { phone: { contains: tail.slice(-8) } }, select: { id: true, name: true, phone: true } });
  let cand = found.find((c) => String(c.phone).replace(/\D/g, '').slice(-10) === tail) || null;
  let created = false;
  const sourceWord = `WhatsApp campaign: ${camp.listName}`.slice(0, 120);
  if (!cand) {
    cand = await prisma.candidate.create({
      data: {
        name: contact.name || reply.name || `WhatsApp contact ${tail.slice(-4)}`, phone: `+${reply.phone}`, email: contact.email || null, location: contact.city || null,
        currentCompany: contact.company || null, skills: contact.skills || null, source: sourceWord, firstSource: sourceWord, sourceCampaign: camp.listName,
      },
    });
    created = true;
  }
  const { addApplication, jobRefusalFor } = require('../routes/applications'); // eslint-disable-line global-require
  const no = await jobRefusalFor(r);
  if (no) return { error: no.body.error, candidateId: cand.id };
  const have = await prisma.application.findFirst({ where: { candidateId: cand.id, requirementId: r.id } });
  let applicationId = have ? have.id : null;
  if (!have) {
    const app = await addApplication(user, { candidate: cand, requirement: r, from: cand, comment: `Said "${reply.text.slice(0, 40)}" to the requirement message sent to "${camp.listName}"` });
    applicationId = app.id;
  }
  if (created) {
    // the reply goes into the new candidate's conversation, so the Inbox shows it
    await prisma.candidateMessage.create({
      data: { candidateId: cand.id, channel: 'WhatsApp', template: 'INBOUND', templateLabel: 'Reply received', trigger: 'Reply', recipient: `+${reply.phone}`, body: reply.text.slice(0, 4000), status: 'RECEIVED', statusDetail: `Reply to the requirement message (campaign "${camp.listName}")`, sentAt: new Date(reply.at) },
    }).catch(() => {});
    await require('../utils/conversations').recordIn({ personType: 'CANDIDATE', personId: cand.id, personName: cand.name, channel: 'WhatsApp', body: reply.text, at: reply.at }).catch(() => {}); // eslint-disable-line global-require
  }
  await logAudit({ userId: user.id, actorName: user.name, action: created ? 'Candidate created from a WhatsApp campaign reply' : 'Existing candidate added to the requirement from a WhatsApp campaign reply', entity: 'Candidate', entityId: cand.id, toValue: `${r.title} · ${sourceWord} · salary not asked yet: the first step asks for it`.slice(0, 480) });
  void core; void list; // eslint-disable-line no-void
  return { candidateId: cand.id, applicationId, created, existing: !created };
}

// replyIds: array, or 'interested' = every Interested reply not yet added
async function addAsCandidate(user, campId, replyIds) {
  if (!A.mayRun(user)) return { error: 'Adding people is done by a team lead, a client manager or an Admin.', status: 403 };
  if (!(await A.mayAddCandidate(user))) return { error: 'You are not allowed to add candidates.', status: 403 };
  const camp = await C.getCamp(user, campId);
  if (!camp) return { error: 'This campaign was not found.', status: 404 };
  const r = await prisma.requirement.findUnique({ where: { id: camp.jobId }, include: { client: true } });
  const list = await S.get(`bc.list.${camp.listId}`);
  const replies = await S.get(`bc.reply.${campId}`, []);
  const latest = new Map();
  replies.forEach((x) => latest.set(x.phone, x));
  let pick;
  if (replyIds === 'interested') pick = [...latest.values()].filter((x) => x.intent === 'interested' && !x.added);
  else pick = replies.filter((x) => (replyIds || []).includes(x.id));
  if (!pick.length) return { error: 'There is nobody to add.', status: 400 };
  const results = [];
  const done = new Set();
  for (const rep of pick) {
    if (done.has(rep.phone)) continue; // eslint-disable-line no-continue
    done.add(rep.phone);
    if (rep.intent === 'optout') { results.push({ id: rep.id, name: rep.name, skipped: 'They asked us to stop.' }); continue; } // eslint-disable-line no-continue
    const out = await addOne(user, camp, rep, r, list); // eslint-disable-line no-await-in-loop
    if (out.error) { results.push({ id: rep.id, name: rep.name, error: out.error }); continue; } // eslint-disable-line no-continue
    await S.update(`bc.reply.${campId}`, [], (l) => { l.forEach((x) => { if (x.phone === rep.phone) { x.added = out.created ? 'created' : 'existing'; x.candidateId = out.candidateId; } }); return l; }); // eslint-disable-line no-await-in-loop
    results.push({ id: rep.id, name: rep.name, ...out });
  }
  return { results, added: results.filter((x) => x.candidateId).length };
}

// a one-off reply typed by a person (inside the 24 h window the person opened by writing)
async function replyTo(user, campId, replyId, text) {
  if (!A.mayRun(user)) return { error: 'Not allowed.', status: 403 };
  const camp = await C.getCamp(user, campId);
  if (!camp) return { error: 'This campaign was not found.', status: 404 };
  const body = String(text || '').trim().slice(0, 1000);
  if (!body) return { error: 'Write the reply first.', status: 400 };
  const rep = (await S.get(`bc.reply.${campId}`, [])).find((x) => x.id === replyId);
  if (!rep) return { error: 'That reply was not found.', status: 404 };
  if (rep.intent === 'optout' || (await prisma.appSetting.findUnique({ where: { key: `${delivery.OPTOUT_PREFIX}WhatsApp.${rep.phone}` } }))) return { error: 'They asked us to stop, so nothing is sent.', status: 409 };
  const r = await prisma.requirement.findUnique({ where: { id: camp.jobId }, include: { client: true } });
  const res = await C.transport({ ...camp, templateId: null }, { phone: rep.phone, name: rep.name, i: 0 }, `${body}\n\nReply STOP to stop messages.`, r);
  await logAudit({ userId: user.id, actorName: user.name, action: res.ok ? 'Requirement broadcast: reply sent' : 'Requirement broadcast: reply failed', entity: 'Campaign', entityId: campId, toValue: res.ok ? `to ${rep.name || 'a contact'}` : String(res.error || '').slice(0, 200) });
  return res.ok ? { ok: true } : { error: res.error || 'Could not send.', status: 502 };
}

module.exports = { handle, statusReport, addAsCandidate, replyTo, putOptOut, findRecipient };
