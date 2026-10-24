// ---------------------------------------------------------------------------
// OMNI-CHANNEL REPLY ROUTER (2026-10-17): every reply that arrives from a provider (WhatsApp, SMS, email) goes through here, in this order:
//   begin()    write the provider event to OmniProviderEvent FIRST (UNIQUE provider + event id). The same event arriving again is counted as a duplicate and
//              changes NOTHING (no second message, no second unread). An event whose first try FAILED is allowed to run again (that is the retry).
//   decide()   find who it is: the phone number (or the email address) is compared with candidates, client contacts, employees and vendors. ONE match, or
//              several matches of which exactly one was messaged by us in the last 14 days = a CONFIDENT match. Several matches, or none = NOT confident.
//   finish()   a confident reply is written on the source record (candidate / client / employee conversation, done by utils/messageDelivery.js and
//              utils/imapInbox.js as before) and ONE row in OmniReplyLink keeps the source ids: person, the apps that show it (ATS, Job Portal, HRMS, Accounts),
//              the application and job, and the campaign reference (an app campaign item, or a job / staff campaign message) it answers.
//   park()     a reply that is not confident is NOT written on any record. It waits in "Needs review" (Inbox & Replies) with the people it could be.
//              A person who may see one of them picks the right one (resolve) or dismisses it; only then is the record written.
//   retry      a failed event keeps attempts, the error and a next-try time; retryDue() runs them again (a small loop, and the "Retry" button in Sync health).
// Phone numbers stay on the server: the Needs review list shows them masked (an Admin sees the full number). Provider secrets are never stored here.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../../db');
const S = require('../store');
const A = require('../access');
const Schema = require('./schema');
const core = require('../../utils/messagingCore');
const { logAudit } = require('../../utils/audit');

const DAY = 86400000;
const WINDOW = 14 * DAY;
const MAX_ATTEMPTS = 5;
const clip = S.clip;
const digits = (v) => String(v || '').replace(/\D/g, '');
const tailOf = (v) => { const d = digits(v); return d.length > 10 ? d.slice(-10) : d; };
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const TYPE_WORD = { CANDIDATE: 'Candidate', CLIENT: 'Client contact', EMPLOYEE: 'Employee', VENDOR: 'Vendor' };
const APPS_OF = { CANDIDATE: ['ATS'], CLIENT: ['ATS', 'Accounts'], EMPLOYEE: ['HRMS'], VENDOR: ['Accounts'] };

// ---- 1. the durable event (idempotency) ------------------------------------------------------------------
// info: { provider, id, channel, from (digits or email), text, at, name, kind } -> { id, duplicate, retry } ; never throws ({ id: null } = carry on without)
async function begin(info = {}) {
  try {
    await Schema.ensure();
    const ch = clip(info.channel, 20) || null;
    const provider = clip(info.provider, 60) || (ch ? `${String(ch).toLowerCase()}.inbound` : 'unknown');
    const at = S.ms(info.at) || Date.now();
    const from = String(info.from || '').includes('@') ? String(info.from).trim().toLowerCase() : digits(info.from);
    const eid = info.id ? clip(info.id, 200) : `h:${crypto.createHash('sha1').update(`${provider}|${from}|${clip(info.text, 400)}|${Math.floor(at / 1000)}`).digest('hex').slice(0, 24)}`;
    const id = S.newId('ope');
    const n = await S.run('INSERT OR IGNORE INTO "OmniProviderEvent" (id, provider, providerEventId, kind, channel, fromKey, fromName, bodyText, outcome, attempts, receivedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id, provider, eid, info.kind || 'inbound', ch, from || null, clip(info.name, 80) || null, clip(info.text, 2000) || null, 'received', 1, at);
    if (n > 0) return { id, duplicate: false };
    const ex = (await S.q('SELECT * FROM "OmniProviderEvent" WHERE provider = ? AND providerEventId = ?', provider, eid))[0];
    if (!ex) return { id: null, duplicate: false };
    const stale = ex.outcome === 'received' && Date.now() - (S.ms(ex.receivedAt) || 0) > 2 * 60000;
    if (ex.outcome === 'failed' || stale) {
      await S.run('UPDATE "OmniProviderEvent" SET outcome = \'received\', attempts = attempts + 1, nextRetryAt = NULL WHERE id = ?', ex.id);
      return { id: ex.id, duplicate: false, retry: true };
    }
    await S.run('UPDATE "OmniProviderEvent" SET duplicates = duplicates + 1 WHERE id = ?', ex.id);
    return { id: ex.id, duplicate: true };
  } catch (e) { console.error('[omni-events] begin:', e.message); return { id: null, duplicate: false }; } // eslint-disable-line no-console
}
async function fail(ev, err) {
  try {
    if (!ev || !ev.id) return;
    const row = (await S.q('SELECT attempts FROM "OmniProviderEvent" WHERE id = ?', ev.id))[0];
    const n = row ? S.num(row.attempts) : 1;
    const wait = Math.min(30 * 60000, 30000 * (2 ** Math.max(0, n - 1)));
    await S.run('UPDATE "OmniProviderEvent" SET outcome = \'failed\', lastError = ?, nextRetryAt = ?, processedAt = ? WHERE id = ?', clip(err && err.message ? err.message : err, 300), n >= MAX_ATTEMPTS ? null : Date.now() + wait, Date.now(), ev.id);
  } catch { /* the monitor must never break the reply */ }
}
// a status report (delivered / failed ...): written for the monitor and for duplicate counting. -> { duplicate }
async function beginStatus(info) {
  try {
    const key = `${String(info.providerRef || '').toLowerCase()}:${String(info.status || '').toLowerCase()}`;
    const ev = await begin({ provider: `${String(info.channel || 'channel').toLowerCase()}.status`, id: key, channel: info.channel, kind: 'status', text: info.error || null, at: info.at });
    return ev;
  } catch { return { id: null, duplicate: false }; }
}
async function endStatus(ev, matched) {
  try {
    if (!ev || !ev.id) return;
    await S.run('UPDATE "OmniProviderEvent" SET outcome = ?, reason = ?, processedAt = ? WHERE id = ?', matched ? 'routed' : 'ignored', matched ? null : 'No message of ours has this provider id.', Date.now(), ev.id);
  } catch { /* monitor only */ }
}

// ---- 2. who is it ----------------------------------------------------------------------------------------------
async function deptsOfCandidates(ids) {
  const out = {};
  if (!ids.length) return out;
  const apps = await prisma.application.findMany({ where: { candidateId: { in: ids } }, select: { candidateId: true, source: true, id: true, requirementId: true, requirement: { select: { department: true } } }, take: 400 }).catch(() => []);
  apps.forEach((a) => {
    const o = out[a.candidateId] || (out[a.candidateId] = { depts: new Set(), portal: [] });
    if (a.requirement && a.requirement.department) o.depts.add(String(a.requirement.department).toLowerCase());
    try { if (a.source && a.source === require('../../utils/atsVocab').PORTAL_APPLICATION_SOURCE) o.portal.push({ id: a.id, requirementId: a.requirementId }); } catch { /* none */ } // eslint-disable-line global-require
  });
  return out;
}
// every record this phone number could belong to
async function matchPhone(raw) {
  const tail = tailOf(raw);
  const out = [];
  if (tail.length < 8) return out;
  const like = tail.slice(-8);
  const same = (v) => v && tailOf(v) === tail;
  const cands = await prisma.candidate.findMany({ where: { phone: { contains: like } }, select: { id: true, name: true, phone: true }, take: 20 }).catch(() => []);
  const cm = cands.filter((c) => same(c.phone));
  const dep = await deptsOfCandidates(cm.map((c) => c.id));
  cm.forEach((c) => out.push({ type: 'CANDIDATE', id: c.id, name: c.name, depts: [...((dep[c.id] || {}).depts || [])], portal: (dep[c.id] || {}).portal || [] }));
  const keys = ['contactPhone', 'contactWhatsApp', 'billingContactPhone', 'secondaryContactPhone', 'recruitmentContactPhone'];
  const clients = await prisma.client.findMany({ where: { OR: keys.map((k) => ({ [k]: { contains: like } })) }, select: { id: true, name: true, contactName: true, ownerDepartment: true, ...Object.fromEntries(keys.map((k) => [k, true])) }, take: 20 }).catch(() => []);
  clients.filter((c) => keys.some((k) => same(c[k]))).forEach((c) => out.push({ type: 'CLIENT', id: c.id, name: c.contactName ? `${c.contactName} (${c.name})` : c.name, depts: c.ownerDepartment ? [String(c.ownerDepartment).toLowerCase()] : [], portal: [] }));
  const emps = await prisma.employee.findMany({ where: { phone: { contains: like } }, select: { id: true, name: true, phone: true, department: true }, take: 20 }).catch(() => []);
  emps.filter((e) => same(e.phone)).forEach((e) => out.push({ type: 'EMPLOYEE', id: e.id, name: e.name, depts: e.department ? [String(e.department).toLowerCase()] : [], portal: [] }));
  const vend = await prisma.officeVendor.findMany({ where: { OR: [{ phoneKey: { contains: like } }, { phone: { contains: like } }] }, select: { id: true, name: true, contactPerson: true, phone: true, phoneKey: true }, take: 20 }).catch(() => []);
  vend.filter((v) => same(v.phoneKey) || same(v.phone)).forEach((v) => out.push({ type: 'VENDOR', id: v.id, name: v.contactPerson ? `${v.contactPerson} (${v.name})` : v.name, depts: [], portal: [] }));
  return out;
}
async function matchEmail(raw) {
  const a = String(raw || '').trim().toLowerCase();
  const out = [];
  if (!a.includes('@')) return out;
  const cands = await prisma.candidate.findMany({ where: { email: { contains: a } }, select: { id: true, name: true, email: true }, take: 20 }).catch(() => []);
  const cm = cands.filter((c) => String(c.email || '').trim().toLowerCase() === a);
  const dep = await deptsOfCandidates(cm.map((c) => c.id));
  cm.forEach((c) => out.push({ type: 'CANDIDATE', id: c.id, name: c.name, depts: [...((dep[c.id] || {}).depts || [])], portal: (dep[c.id] || {}).portal || [] }));
  const keys = ['contactEmail', 'secondaryContactEmail', 'billingContactEmail', 'recruitmentContactEmail'];
  const clients = await prisma.client.findMany({ where: { OR: keys.map((k) => ({ [k]: { contains: a } })) }, select: { id: true, name: true, contactName: true, ownerDepartment: true, ...Object.fromEntries(keys.map((k) => [k, true])) }, take: 20 }).catch(() => []);
  clients.filter((c) => keys.some((k) => String(c[k] || '').trim().toLowerCase() === a)).forEach((c) => out.push({ type: 'CLIENT', id: c.id, name: c.contactName ? `${c.contactName} (${c.name})` : c.name, depts: c.ownerDepartment ? [String(c.ownerDepartment).toLowerCase()] : [], portal: [] }));
  const emps = await prisma.employee.findMany({ where: { email: { contains: a } }, select: { id: true, name: true, email: true, department: true }, take: 20 }).catch(() => []);
  emps.filter((e) => String(e.email || '').trim().toLowerCase() === a).forEach((e) => out.push({ type: 'EMPLOYEE', id: e.id, name: e.name, depts: e.department ? [String(e.department).toLowerCase()] : [], portal: [] }));
  const vend = await prisma.officeVendor.findMany({ where: { OR: [{ emailKey: a }, { email: { contains: a } }] }, select: { id: true, name: true, contactPerson: true, email: true, emailKey: true }, take: 20 }).catch(() => []);
  vend.filter((v) => String(v.email || '').trim().toLowerCase() === a || String(v.emailKey || '') === a).forEach((v) => out.push({ type: 'VENDOR', id: v.id, name: v.contactPerson ? `${v.contactPerson} (${v.name})` : v.name, depts: [], portal: [] }));
  return out;
}
// who of these did WE message in the last 14 days (before the reply)? -> Set of "TYPE:id"
async function recentlyMessaged(matches, channel, at) {
  const set = new Set();
  const since = at - WINDOW;
  const ids = (t) => matches.filter((m) => m.type === t).map((m) => m.id);
  try {
    const c = ids('CANDIDATE');
    if (c.length) {
      const rows = await prisma.candidateMessage.findMany({ where: { candidateId: { in: c }, status: { in: ['SENT', 'DELIVERED', 'READ'] }, createdAt: { gte: new Date(since), lte: new Date(at + 60000) } }, select: { candidateId: true, channel: true }, take: 200 });
      rows.forEach((r) => { if (!channel || String(r.channel).toLowerCase() === String(channel).toLowerCase()) set.add(`CANDIDATE:${r.candidateId}`); });
    }
    if (await require('../../utils/conversations').ready()) { // eslint-disable-line global-require
      const o = matches.filter((m) => m.type === 'CLIENT' || m.type === 'EMPLOYEE');
      for (const m of o) {
        const r = await S.q('SELECT 1 x FROM "ConversationMessage" WHERE personType = ? AND personId = ? AND direction = \'OUT\' AND createdAt >= ? LIMIT 1', m.type, m.id, since); // eslint-disable-line no-await-in-loop
        if (r.length) set.add(`${m.type}:${m.id}`);
      }
    }
    await Schema.ensure();
    const all = matches.map((m) => m.id);
    if (all.length) {
      const marks = all.map(() => '?').join(',');
      const rows = await S.q(`SELECT entityId FROM "OmniAppCampaignItem" WHERE entityId IN (${marks}) AND status IN ('sent','delivered') AND sentAt >= ?`, ...all, since);
      rows.forEach((r) => { const m = matches.find((x) => x.id === r.entityId); if (m) set.add(`${m.type}:${m.id}`); });
    }
  } catch { /* a missing table just means no help from it */ }
  return set;
}
// -> { status: 'confident', person, by } | { status: 'ambiguous' | 'none', possible }
async function decide({ phone, email, channel, at } = {}) {
  const when = S.ms(at) || Date.now();
  const matches = email ? await matchEmail(email) : await matchPhone(phone);
  if (!matches.length) return { status: 'none', possible: [] };
  if (matches.length === 1) return { status: 'confident', person: matches[0], by: 'only match' };
  const recent = await recentlyMessaged(matches, channel, when);
  const hit = matches.filter((m) => recent.has(`${m.type}:${m.id}`));
  if (hit.length === 1) return { status: 'confident', person: hit[0], by: 'we messaged only this one lately' };
  return { status: 'ambiguous', possible: matches };
}

// ---- 3. the source ids on a confident reply -----------------------------------------------------------------------
// the campaign this reply most likely answers: { kind, ref, name } or null
async function campaignOf(person, channel, at) {
  const since = at - WINDOW;
  try {
    await Schema.ensure();
    const it = (await S.q('SELECT i.campaignId, i.id, c.name FROM "OmniAppCampaignItem" i JOIN "OmniAppCampaign" c ON c.id = i.campaignId WHERE i.entityId = ? AND i.status IN (\'sent\',\'delivered\') AND i.sentAt >= ? AND i.sentAt <= ? ORDER BY i.sentAt DESC LIMIT 1', person.id, since, at + 60000))[0];
    if (it) { await S.run('UPDATE "OmniAppCampaignItem" SET repliedAt = COALESCE(repliedAt, ?) WHERE id = ?', at, it.id); return { kind: 'app', ref: it.campaignId, name: it.name }; }
    if (person.type === 'CANDIDATE' || person.type === 'EMPLOYEE') {
      const info = person.type === 'CANDIDATE' ? await prisma.candidate.findUnique({ where: { id: person.id }, select: { phone: true, email: true } }) : await prisma.employee.findUnique({ where: { id: person.id }, select: { phone: true, email: true } });
      const K = require('../contacts'); // eslint-disable-line global-require
      const p = K.phoneOf(info && info.phone); const e = K.emailOf(info && info.email);
      const contacts = (p.ok || e.ok) && (await S.ready()) && (await S.campaignsReady()) ? await K.findByKeys(p.ok ? p.key : null, e.ok ? e.key : null) : [];
      for (const c of contacts) {
        const m = (await S.q('SELECT m.campaignId, m.requirementId, k.name, k.type FROM "OutreachMessage" m JOIN "OutreachCampaign" k ON k.id = m.campaignId WHERE m.contactId = ? AND m.status IN (\'sent\',\'delivered\',\'test_captured\') AND COALESCE(m.sentAt, m.queuedAt) >= ? AND COALESCE(m.sentAt, m.queuedAt) <= ? ORDER BY COALESCE(m.sentAt, m.queuedAt) DESC LIMIT 1', c.id, since, at + 60000))[0]; // eslint-disable-line no-await-in-loop
        if (m) return { kind: m.type === 'internal' ? 'staff' : 'job', ref: m.campaignId, name: m.name, requirementId: m.requirementId || null };
      }
    }
  } catch { /* no reference is fine */ }
  return null;
}
async function link(eventId, person, { channel, text, at } = {}) {
  await Schema.ensure();
  const camp = await campaignOf(person, channel, S.ms(at) || Date.now());
  let portal = person.portal;
  if (!Array.isArray(portal)) portal = person.type === 'CANDIDATE' ? (((await deptsOfCandidates([person.id]))[person.id] || {}).portal || []) : [];
  const appl = portal.length === 1 ? portal[0] : null;
  const apps = [...new Set([...(APPS_OF[person.type] || []), ...(portal.length ? ['Job Portal'] : [])])];
  await S.run('INSERT OR IGNORE INTO "OmniReplyLink" (id, eventId, personType, personId, personName, apps, applicationId, requirementId, campaignKind, campaignRef, campaignName, channel, snippet, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    S.newId('orl'), eventId, person.type, person.id, clip(person.name, 120), JSON.stringify(apps), appl ? appl.id : null, (appl && appl.requirementId) || (camp && camp.requirementId) || null, camp ? camp.kind : null, camp ? camp.ref : null, camp ? clip(camp.name, 120) : null, channel || null, clip(String(text || '').replace(/\s+/g, ' '), 140), Date.now());
  return { apps, campaign: camp, applicationId: appl ? appl.id : null };
}
// a confident reply was handled by the caller: keep the source ids
async function finish(ev, person, info = {}) {
  try {
    if (!ev || !ev.id || !person) return null;
    const l = await link(ev.id, person, info);
    await S.run('UPDATE "OmniProviderEvent" SET outcome = \'routed\', matchType = ?, matchId = ?, apps = ?, campaignRef = ?, processedAt = ?, lastError = NULL, nextRetryAt = NULL WHERE id = ?',
      person.type, person.id, JSON.stringify(l.apps), l.campaign ? JSON.stringify(l.campaign) : null, Date.now(), ev.id);
    return l;
  } catch (e) { console.error('[omni-replies] finish:', e.message); return null; } // eslint-disable-line no-console
}
// not confident: nothing is written on any record
async function park(ev, verdict, info = {}) {
  try {
    if (!ev || !ev.id) return;
    const possible = (verdict.possible || []).map((m) => ({ type: m.type, id: m.id, name: m.name, depts: m.depts || [] }));
    const depts = [...new Set(possible.flatMap((m) => m.depts))];
    await S.run('UPDATE "OmniProviderEvent" SET outcome = \'needs_review\', reason = ?, possible = ?, visibleDepts = ?, processedAt = ?, lastError = NULL, nextRetryAt = NULL WHERE id = ?',
      verdict.status === 'ambiguous' ? 'ambiguous' : 'unknown', JSON.stringify(possible), JSON.stringify(depts), Date.now(), ev.id);
    await logAudit({ userId: null, actorName: 'Omni-Channel', action: verdict.status === 'ambiguous' ? 'Reply could not be matched with confidence (sent to Needs review)' : 'Reply from an unknown sender (sent to Needs review)', entity: 'OmniProviderEvent', entityId: ev.id, toValue: `${info.channel || 'message'}; ${possible.length} possible people` });
  } catch (e) { console.error('[omni-replies] park:', e.message); } // eslint-disable-line no-console
}

// ---- 4. Needs review (who sees it, resolve, dismiss) ----------------------------------------------------------------
const isAdmin = (u) => A.isAdmin(u);
function mayReviewKind(u) { return ['admin', 'tl', 'bdetl', 'view', 'hr'].includes(A.kind(u)); }
function mayReview(u, row) {
  if (isAdmin(u)) return true;
  if (!mayReviewKind(u)) return false;
  const poss = parse(row.possible, []);
  const depts = parse(row.visibleDepts, []);
  if (A.kind(u) === 'hr') return poss.some((p) => p.type === 'EMPLOYEE') && (depts.length === 0 || depts.some((d) => A.mayDepartment(u, d)) || A.deptScope(u).all);
  if (!poss.length) return false; // an unknown sender: an Admin looks at it
  if (A.deptScope(u).all) return poss.some((p) => p.type !== 'EMPLOYEE');
  return poss.some((p) => p.type !== 'EMPLOYEE' && p.depts.some((d) => A.mayDepartment(u, d)));
}
const mask = (u, key) => (isAdmin(u) ? (key && !String(key).includes('@') ? `+${key}` : key) : (String(key || '').includes('@') ? core.maskEmail(key) : core.maskMobile(key))) || '';
function shapeRow(u, r) {
  return {
    id: r.id, channel: r.channel, from: mask(u, r.fromKey), fromName: r.fromName || '', text: r.bodyText || '', at: S.iso(r.receivedAt), reason: r.reason, reasonWords: r.reason === 'ambiguous' ? 'This number or address belongs to more than one record.' : 'We found nobody with this number or address.',
    possible: parse(r.possible, []).map((p) => ({ type: p.type, typeWord: TYPE_WORD[p.type] || p.type, id: p.id, name: p.name, depts: p.depts })),
    status: r.outcome === 'needs_review' ? 'open' : (r.outcome === 'dismissed' ? 'dismissed' : 'done'), resolution: r.resolution || '', resolvedByName: r.resolvedByName || '', resolvedAt: r.resolvedAt ? S.iso(r.resolvedAt) : null,
  };
}
// WHATSAPP NUMBERS: a reply that came to a number this login may not use is not listed (the event row remembers the number in payload)
async function numberFilter(user) {
  try {
    const WN = require('../../utils/waNumbers'); // eslint-disable-line global-require
    if (!(await WN.hasNumbers())) return { ok: () => true, label: () => '' };
    const vis = await WN.visibleNumberIds(user);
    const labels = await WN.labelsOf();
    const nid = (r) => { const p = parse(r.payload, null); return p && p.numberId ? p.numberId : null; };
    return { ok: (r) => { const n = nid(r); return !n || vis === 'ALL' || vis.has(n); }, label: (r) => { const n = nid(r); return n ? ((labels.get(n) || {}).label || 'A removed number') : ''; } };
  } catch { return { ok: () => true, label: () => '' }; }
}
async function reviewList(user, { status = 'open', page = 1, pageSize = 25 } = {}) {
  await Schema.ensure();
  const NF = await numberFilter(user);
  const outcomes = status === 'open' ? ['needs_review'] : ['resolved', 'dismissed'];
  const rows = await S.q(`SELECT * FROM "OmniProviderEvent" WHERE outcome IN (${outcomes.map(() => '?').join(',')}) ORDER BY receivedAt DESC LIMIT 400`, ...outcomes);
  const mine = rows.filter((r) => mayReview(user, r) && NF.ok(r));
  const size = Math.max(1, Math.min(100, Number(pageSize) || 25)); const pg = Math.max(1, Number(page) || 1);
  return { rows: mine.slice((pg - 1) * size, pg * size).map((r) => ({ ...shapeRow(user, r), numberLabel: NF.label(r) })), total: mine.length, page: pg, pageSize: size, status };
}
async function reviewCount(user) {
  try {
    if (!mayReviewKind(user)) return 0;
    await Schema.ensure();
    const rows = await S.q('SELECT * FROM "OmniProviderEvent" WHERE outcome = \'needs_review\' ORDER BY receivedAt DESC LIMIT 400');
    const NF = await numberFilter(user);
    return rows.filter((r) => mayReview(user, r) && NF.ok(r)).length;
  } catch { return 0; }
}
// write one reply on a person's records (the same writes utils/messageDelivery.js makes for a confident match). Idempotent by the provider id.
async function deliver(person, { channel, text, providerRef, at, from, stop = false }) {
  const convo = require('../../utils/conversations'); // eslint-disable-line global-require
  const ch = channel === 'SMS' ? 'SMS' : (channel === 'Email' ? 'Email' : 'WhatsApp');
  const when = new Date(S.ms(at) || Date.now());
  if (person.type === 'VENDOR') return { stored: true, linkOnly: true };
  if (person.type === 'CANDIDATE') {
    const again = providerRef ? await prisma.candidateMessage.count({ where: { candidateId: person.id, providerRef, status: 'RECEIVED' } }).catch(() => 0) : 0;
    if (!again) {
      await prisma.candidateMessage.create({ data: { candidateId: person.id, applicationId: person.applicationId || null, channel: ch, template: 'INBOUND', templateLabel: 'Reply received', trigger: 'Reply', recipient: from || null, body: clip(text, 4000), status: 'RECEIVED', statusDetail: `Reply on ${ch} (checked by a person in Needs review)`, providerRef: providerRef || null, sentAt: when } });
    }
  }
  await convo.recordIn({ personType: person.type, personId: person.id, personName: person.name, channel: ch, body: text, providerRef, at: when, address: from || undefined, stop }).catch(() => {});
  return { stored: true };
}
async function resolve(user, eventId, { personType, personId } = {}) {
  await Schema.ensure();
  const r = (await S.q('SELECT * FROM "OmniProviderEvent" WHERE id = ?', String(eventId || '')))[0];
  if (!r || !mayReview(user, r) || !(await numberFilter(user)).ok(r)) return { error: 'This reply was not found.', status: 404 };
  if (r.outcome !== 'needs_review') return { error: 'This reply was already checked.', status: 409 };
  const type = String(personType || '').toUpperCase();
  const pick = parse(r.possible, []).find((p) => p.type === type && p.id === String(personId || ''));
  // a person you may check only among the people this reply could be (a reply can never be pushed onto an unrelated record)
  if (!pick) return { error: 'Pick one of the people shown for this reply.', status: 400 };
  const audience = { CANDIDATE: 'candidates', CLIENT: 'clients', EMPLOYEE: 'employees' }[type];
  if (audience) {
    const rule = await require('../../utils/contactAccess').ruleFor(user, audience); // eslint-disable-line global-require
    if (!rule.allowed) return { error: rule.reason || 'Your login cannot handle this kind of person.', status: 403 };
    const vis = await require('../../utils/conversations').visibleIds(user, type, [pick.id]); // eslint-disable-line global-require
    if (!vis.has(pick.id)) return { error: 'This person is outside your access.', status: 403 };
  } else if (!isAdmin(user)) return { error: 'Only an Admin can match a reply to a vendor.', status: 403 };
  const info = { channel: r.channel, text: r.bodyText, providerRef: r.providerEventId.startsWith('h:') ? null : r.providerEventId, at: S.ms(r.receivedAt), from: r.fromKey ? (String(r.fromKey).includes('@') ? r.fromKey : `+${r.fromKey}`) : null };
  const full = (await matchPhoneOrEmail(r.fromKey)).find((m) => m.type === type && m.id === pick.id) || { ...pick, portal: [] };
  await deliver({ ...full, applicationId: (full.portal || []).length === 1 ? full.portal[0].id : null }, info);
  const l = await link(r.id, full, info);
  await S.run('UPDATE "OmniProviderEvent" SET outcome = \'resolved\', matchType = ?, matchId = ?, apps = ?, campaignRef = ?, resolvedAt = ?, resolvedById = ?, resolvedByName = ?, resolution = ? WHERE id = ? AND outcome = \'needs_review\'',
    type, pick.id, JSON.stringify(l.apps), l.campaign ? JSON.stringify(l.campaign) : null, Date.now(), user.id, user.name, `Matched to ${TYPE_WORD[type]} ${clip(pick.name, 60)}`, r.id);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Reply matched by a person (Needs review)', entity: 'OmniProviderEvent', entityId: r.id, toValue: `${TYPE_WORD[type]} ${pick.id}` });
  return { ok: `Done. The reply is now on ${clip(pick.name, 60)}'s record.`, apps: l.apps };
}
const matchPhoneOrEmail = (key) => (String(key || '').includes('@') ? matchEmail(key) : matchPhone(key));
async function dismiss(user, eventId, reason) {
  await Schema.ensure();
  const r = (await S.q('SELECT * FROM "OmniProviderEvent" WHERE id = ?', String(eventId || '')))[0];
  if (!r || !mayReview(user, r) || !(await numberFilter(user)).ok(r)) return { error: 'This reply was not found.', status: 404 };
  if (r.outcome !== 'needs_review') return { error: 'This reply was already checked.', status: 409 };
  const why = clip(reason, 200);
  if (why.length < 3) return { error: 'Write a few words why (for example: "Not one of ours").', status: 400 };
  await S.run('UPDATE "OmniProviderEvent" SET outcome = \'dismissed\', resolvedAt = ?, resolvedById = ?, resolvedByName = ?, resolution = ? WHERE id = ? AND outcome = \'needs_review\'', Date.now(), user.id, user.name, why, r.id);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Reply dismissed (Needs review)', entity: 'OmniProviderEvent', entityId: r.id, toValue: why });
  return { ok: 'Dismissed.' };
}

// ---- 5. replies on a record, for the source app screens ----------------------------------------------------------------------
// the replies matched to one record. The caller has already checked that this login may see the person.
async function repliesOf(personType, personId, limit = 30) {
  await Schema.ensure();
  const rows = await S.q('SELECT l.*, e.receivedAt, e.outcome FROM "OmniReplyLink" l JOIN "OmniProviderEvent" e ON e.id = l.eventId WHERE l.personType = ? AND l.personId = ? ORDER BY l.createdAt DESC LIMIT ?', String(personType).toUpperCase(), String(personId), limit);
  return rows.map((l) => ({ id: l.id, at: S.iso(l.createdAt), channel: l.channel, snippet: l.snippet, apps: parse(l.apps, []), applicationId: l.applicationId, requirementId: l.requirementId, campaign: l.campaignRef ? { kind: l.campaignKind, ref: l.campaignRef, name: l.campaignName } : null }));
}

// ---- 6. the monitor (Sync health) and the retry ------------------------------------------------------------------------------------
async function health() {
  await Schema.ensure();
  const by = {};
  (await S.q('SELECT outcome, COUNT(*) n, SUM(duplicates) d FROM "OmniProviderEvent" GROUP BY outcome')).forEach((r) => { by[r.outcome] = { n: S.num(r.n), dup: S.num(r.d) }; });
  const total = Object.values(by).reduce((n, x) => n + x.n, 0);
  const dups = Object.values(by).reduce((n, x) => n + x.dup, 0);
  const failed = await S.q('SELECT id, provider, channel, kind, lastError, attempts, nextRetryAt, receivedAt FROM "OmniProviderEvent" WHERE outcome = \'failed\' ORDER BY receivedAt DESC LIMIT 20');
  const pending = await S.q('SELECT COUNT(*) n FROM "OmniProviderEvent" WHERE outcome = \'received\'');
  return {
    total, routed: (by.routed || {}).n || 0, needsReview: (by.needs_review || {}).n || 0, resolved: (by.resolved || {}).n || 0, dismissed: (by.dismissed || {}).n || 0, ignored: (by.ignored || {}).n || 0,
    failed: (by.failed || {}).n || 0, pending: S.num(pending[0].n), duplicatesIgnored: dups,
    failedList: failed.map((f) => ({ id: f.id, provider: f.provider, channel: f.channel, kind: f.kind, error: f.lastError || '', attempts: S.num(f.attempts), nextTry: f.nextRetryAt ? S.iso(f.nextRetryAt) : null, at: S.iso(f.receivedAt), giveUp: S.num(f.attempts) >= MAX_ATTEMPTS })),
  };
}
let retrying = false;
// run the failed events again (due ones; `all` = every failed one, from the Retry button)
async function retryDue({ all = false } = {}) {
  if (retrying) return { skipped: true };
  retrying = true;
  const out = { tried: 0, ok: 0, failedAgain: 0 };
  try {
    await Schema.ensure();
    const rows = await S.q(`SELECT * FROM "OmniProviderEvent" WHERE outcome = 'failed' AND kind = 'inbound' AND attempts < ? ${all ? '' : 'AND (nextRetryAt IS NULL OR nextRetryAt <= ?)'} ORDER BY receivedAt LIMIT 50`, ...(all ? [MAX_ATTEMPTS] : [MAX_ATTEMPTS, Date.now()]));
    const delivery = require('../../utils/messageDelivery'); // eslint-disable-line global-require
    for (const r of rows) {
      out.tried += 1;
      try {
        if (r.channel === 'Email') { await S.run('UPDATE "OmniProviderEvent" SET outcome = \'ignored\', reason = \'The mailbox reader picks this mail up again by itself.\' WHERE id = ?', r.id); out.ok += 1; continue; } // eslint-disable-line no-continue
        await delivery.applyInbound({ channel: r.channel, from: r.fromKey, text: r.bodyText || '', id: r.providerEventId.startsWith('h:') ? r.providerEventId : r.providerEventId, at: S.ms(r.receivedAt), provider: r.provider, name: r.fromName }); // eslint-disable-line no-await-in-loop
        const now = (await S.q('SELECT outcome FROM "OmniProviderEvent" WHERE id = ?', r.id))[0]; // eslint-disable-line no-await-in-loop
        if (now && now.outcome === 'failed') out.failedAgain += 1; else out.ok += 1;
      } catch { out.failedAgain += 1; }
    }
  } catch (e) { console.error('[omni-events] retry:', e.message); } // eslint-disable-line no-console
  finally { retrying = false; }
  return out;
}
let timer = null;
function start() {
  if (timer || process.env.OMNI_EVENT_RETRY_MS === '0') return;
  try { if (require('../../utils/sandbox').isSandbox()) return; } catch { /* not a sandbox */ } // eslint-disable-line global-require
  timer = setInterval(() => { retryDue().catch(() => {}); }, Number(process.env.OMNI_EVENT_RETRY_MS || 60000));
  if (timer.unref) timer.unref();
}

module.exports = { begin, fail, beginStatus, endStatus, decide, finish, park, link, reviewList, reviewCount, resolve, dismiss, repliesOf, health, retryDue, start, mayReview, deliver, matchPhone, matchEmail, tailOf, MAX_ATTEMPTS };
