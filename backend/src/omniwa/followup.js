// ---------------------------------------------------------------------------
// AI WHATSAPP MARKETING ASSISTANT, PHASE 3: FOLLOW-UPS (owner 2026-11-25: "personalised follow-up message drafts; configurable follow-up intervals; STOP follow-ups when the customer opts
// out or answers negatively").
//
// A customer who showed interest (omniwa/assistLead.js) and then went quiet gets a short follow-up, at the intervals the Admin sets (default 4, 48 and 120 hours after the last message
// in the chat). The words are written from what THEY told the assistant (the service, what they need, their name, the call time they gave): code fills a fixed sentence, no model writes it,
// nothing is invented. Each draft ends with "Reply STOP to stop messages from us". By default a team member approves each draft (Follow-ups waiting, in WhatsApp > AI leads); with approval
// off the draft goes by itself, still through the gate.
//   THE GATE (omniwa/gate.js) decides every send: stop lists and the CRM opt-out list, the 24-hour window (free text inside it; outside it only the approved template set here, and only with the
//   customer's recorded consent), quiet hours (the follow-up waits until morning). A draft that cannot go says why and waits; it is never sent "anyway".
//   IT STOPS: at STOP (any stop list), when they say they are not interested or too expensive (the score signal), when they write back (a person or the assistant is talking to them again; the
//   count starts again after the next silence), when a person has the chat (hand-over, Pause), when the CRM lead is Lost / Junk / Converted / Won, after the last step, and when a person presses
//   "Stop follow-ups" on it.
// OFF until an Admin switches it on. The ticker (start()) is never started in the test sandbox; a test calls sweep().
// ---------------------------------------------------------------------------
const prisma = require('../db');
const S = require('../outreach/store');
const { ensure } = require('./schema');

const clip = (v, n) => S.clip(v, n);
const KEY = 'omni.wa.followup';
const HOUR = 3600000;
const DEFAULTS = { enabled: false, approval: true, intervalsHours: [4, 48, 120], template: { name: '', language: 'en', vars: ['name', 'service'] } };
const VAR_KEYS = ['name', 'service', 'requirement', 'business', 'callback'];
const STOP_LINE = 'Reply STOP to stop messages from us.';
const MAX_AGE = 7 * 24 * HOUR; // a draft nobody sent for a week is dropped: the moment has passed
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// ---- settings -----------------------------------------------------------------------------------------------------------------------------------
function clean(v = {}) {
  let hours = (Array.isArray(v.intervalsHours) ? v.intervalsHours : String(v.intervalsHours || '').split(/[\s,;]+/)).map((x) => Math.round(Number(x))).filter((x) => Number.isFinite(x) && x >= 1 && x <= 720);
  hours = hours.length ? hours.slice(0, 5) : DEFAULTS.intervalsHours;
  const t = v.template && typeof v.template === 'object' ? v.template : {};
  const name = clip(t.name, 200).toLowerCase();
  const vars = (Array.isArray(t.vars) ? t.vars : String(t.vars || '').split(/[\s,;]+/)).map((x) => String(x).trim().toLowerCase()).filter((x) => VAR_KEYS.includes(x)).slice(0, 6);
  return { enabled: v.enabled === true, approval: v.approval !== false, intervalsHours: hours, template: { name, language: /^[a-z]{2}(_[A-Z]{2})?$/.test(clip(t.language, 10)) ? clip(t.language, 10) : 'en', vars: vars.length ? vars : DEFAULTS.template.vars } };
}
async function settings() {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  return clean(parse(row && row.value, {}));
}
async function saveSettings(user, b = {}) {
  const cur = await settings();
  const next = clean({ ...cur, ...b, template: { ...cur.template, ...(b.template || {}) } });
  if (b.template && b.template.name && !/^[a-z0-9_]{1,200}$/.test(next.template.name)) return { error: 'The template name is lowercase letters, numbers and underscores only, exactly as it is at Meta (for example tl_followup).', status: 400 };
  if (next.intervalsHours.some((h, i) => i > 0 && h <= next.intervalsHours[i - 1])) return { error: 'Each follow-up comes later than the one before: for example 24, 72, 168 hours.', status: 400 };
  const value = JSON.stringify(next);
  await prisma.appSetting.upsert({ where: { key: KEY }, update: { value }, create: { key: KEY, value } });
  return { ok: true, settings: next, was: cur };
}

// ---- the words: a fixed sentence filled with what the customer told us ------------------------------------------------------------------------------
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';
function aboutOf(lead) {
  if (lead.service) return `your ${clip(lead.service, 50)} enquiry`;
  if (lead.requirement) return `your enquiry (${clip(lead.requirement, 50)})`;
  return 'your enquiry';
}
function draftText(step, total, lead = {}) {
  const nm = firstName(lead.name) ? ` ${firstName(lead.name)}` : '';
  const about = aboutOf(lead);
  const svc = lead.service ? ` about ${clip(lead.service, 50)}` : '';
  const when = lead.callback && lead.callback !== 'No preference' ? ` We have noted that you prefer a call ${clip(lead.callback, 40)}.` : '';
  let body;
  if (step >= total && total > 1) body = `Hello${nm}, this is our last message about ${about}. If you would like to talk, reply here at any time.`;
  else if (step === 1) body = `Hello${nm}! We wanted to follow up on ${about}. Would you like us to share more information${svc}?`;
  else body = `Hello${nm}, just checking if you had a chance to think about ${about}.${when} Shall we arrange a call?`;
  return `${body}\n\n${STOP_LINE}`;
}
// the blanks of the approved template: only the listed facts, never a line break or a run of spaces (Meta refuses them)
function templateVars(keys, lead, st, businessName) {
  const val = { name: firstName(lead.name) || 'there', service: lead.service || 'your enquiry', requirement: lead.requirement || 'your enquiry', business: businessName || 'us', callback: lead.callback || 'any time' };
  return keys.map((k) => String(val[k] || '-').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 100) || '-');
}

// ---- the rows ---------------------------------------------------------------------------------------------------------------------------------------
const rowOf = async (id) => (await S.q('SELECT * FROM "OmniWaFollowUp" WHERE id = ?', String(id)))[0] || null;
// a row as the screen gets it: raw SQL gives BIGINT times as BigInt, which JSON cannot carry
const plain = (r) => (r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])) : null);
const openRows = (convId) => S.q('SELECT * FROM "OmniWaFollowUp" WHERE convId = ? AND status IN (\'approval\', \'ready\')', convId);
async function closeOpen(convId, status, reason, now = Date.now()) {
  return S.run('UPDATE "OmniWaFollowUp" SET status = ?, reason = ?, updatedAt = ? WHERE convId = ? AND status IN (\'approval\', \'ready\')', status, clip(reason, 200), now, convId);
}

// ---- the chat changed: the customer wrote -------------------------------------------------------------------------------------------------------------
// called by agent.onInbound after the message is stored: whatever was waiting is dropped, and the count starts again after the next silence
async function onInbound(conv) {
  try {
    await ensure();
    const AL = require('./assistLead'); // eslint-disable-line global-require
    const lead = AL.leadOf(conv);
    if (!lead.interestAt && !lead.followStep) return;
    const n = await closeOpen(conv.id, 'stopped', 'They wrote back.');
    if (n || lead.followStep) await AL.saveLead(conv, { followStep: 0, followAt: null });
  } catch { /* a follow-up is never a reason to lose an incoming message */ }
}

// ---- what stops a series -------------------------------------------------------------------------------------------------------------------------------
// -> null (go on) | a sentence (why it stops)
async function stopReason(conv, lead, now) {
  if (lead.followStop) return 'A person stopped the follow-ups for this customer.';
  if (lead.declined) return 'They said they are not interested.';
  if (conv.state === 'stopped') return 'They asked us to stop.';
  if (conv.mode !== 'ai') return 'A person has this chat.';
  const Agent = require('./agent'); // eslint-disable-line global-require
  let blocked;
  try { blocked = (await Agent.blockState(conv.e164)).blocked; } catch { return 'The stop lists could not be checked just now.'; } // fails closed: nothing is drafted or sent on a guess
  if (blocked) return 'They asked us to stop.';
  if (lead.crmLeadId) {
    const crm = await require('../crm/schema').one('SELECT "status", "stage" FROM "CrmLead" WHERE "id" = ?', lead.crmLeadId).catch(() => null); // eslint-disable-line global-require
    if (crm && (['Junk', 'Converted'].includes(crm.status) || ['Won', 'Lost'].includes(String(crm.stage || '')))) return `The CRM lead is ${crm.status === 'Junk' || crm.status === 'Converted' ? crm.status : crm.stage}.`;
  }
  const a = await AL_assess(conv);
  if (a && (a.sig.no || a.sig.dear)) return a.sig.no ? 'They said they are not interested.' : 'They said it is too expensive.';
  return null;
}
async function AL_assess(conv) { try { return await require('./assistLead').assess(conv); } catch { return null; } } // eslint-disable-line global-require

// ---- planning: who is due a follow-up now -----------------------------------------------------------------------------------------------------------
async function plan(now, st) {
  const AL = require('./assistLead'); // eslint-disable-line global-require
  const Asst = require('./assist'); // eslint-disable-line global-require
  const out = { drafted: 0, stopped: 0 };
  const rows = await S.q('SELECT * FROM "OmniWaConv" WHERE personType = \'LEAD\' AND collected LIKE \'%"assistLead"%\' AND state <> \'stopped\' ORDER BY updatedAt DESC LIMIT 300');
  const brand = (await Asst.settings()).businessName;
  for (const conv of rows) {
    const lead = AL.leadOf(conv);
    if (!lead.interestAt || lead.followStop) continue; // eslint-disable-line no-continue
    const stage = Number(lead.followStep) || 0;
    if (stage >= st.intervalsHours.length) continue; // eslint-disable-line no-continue
    if (!(await Asst.ownsChat(conv))) continue; // eslint-disable-line no-continue, no-await-in-loop
    if ((await openRows(conv.id)).length) continue; // eslint-disable-line no-continue, no-await-in-loop
    const last = Math.max(Number(conv.lastInboundAt) || 0, Number(conv.lastAiAt) || 0, Number(lead.followAt) || 0);
    if (!last || now - last < st.intervalsHours[stage] * HOUR) continue; // eslint-disable-line no-continue
    const why = await stopReason(conv, lead, now); // eslint-disable-line no-await-in-loop
    if (why) { if (!lead.followStop && (lead.declined || /not interested|too expensive|CRM lead/.test(why))) { await AL.saveLead(conv, { followStop: true, followStopReason: why }); out.stopped += 1; } continue; } // eslint-disable-line no-await-in-loop, no-continue
    const text = draftText(stage + 1, st.intervalsHours.length, lead);
    const useTpl = !!st.template.name;
    const status = st.approval ? 'approval' : 'ready';
    const id = S.newId('wfu');
    await S.run('INSERT INTO "OmniWaFollowUp" (id, convId, e164, crmLeadId, step, status, mode, body, templateName, vars, dueAt, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', // eslint-disable-line no-await-in-loop
      id, conv.id, conv.e164, lead.crmLeadId || null, stage + 1, status, useTpl ? 'auto' : 'text', text, useTpl ? st.template.name : null, useTpl ? JSON.stringify(templateVars(st.template.vars, lead, st, brand)) : null, now, now, now);
    out.drafted += 1;
    if (st.approval) await AL.tellTeam(conv, `A follow-up for ${lead.name || conv.name || `+${conv.e164}`} waits for you`, `Step ${stage + 1} of ${st.intervalsHours.length}. Open Omni-Channel > Inbox & Replies > WhatsApp > AI leads > Follow-ups waiting.`, { leadOwnerId: null }); // eslint-disable-line no-await-in-loop
  }
  return out;
}

// ---- sending one --------------------------------------------------------------------------------------------------------------------------------------
// -> 'sent' | 'waiting' (quiet hours, or it cannot go yet: the reason is on the row) | 'stopped' | 'failed'
async function sendOne(row, st, now, by = null) {
  const AL = require('./assistLead'); // eslint-disable-line global-require
  const Agent = require('./agent'); // eslint-disable-line global-require
  const Gate = require('./gate'); // eslint-disable-line global-require
  const conv = (await S.q('SELECT * FROM "OmniWaConv" WHERE id = ?', row.convId))[0];
  const finish = async (status, reason, extra = {}) => {
    await S.run('UPDATE "OmniWaFollowUp" SET status = ?, reason = ?, decidedByName = COALESCE(?, decidedByName), updatedAt = ? WHERE id = ?', status, clip(reason, 240) || null, by ? by.name || null : null, now, row.id);
    return extra.result || status;
  };
  if (!conv) return finish('stopped', 'The chat is gone.');
  const lead = AL.leadOf(conv);
  if (Number(conv.lastInboundAt) > Number(row.createdAt)) { await closeOpen(conv.id, 'stopped', 'They wrote back.', now); return 'stopped'; }
  const why = await stopReason(conv, lead, now);
  if (why && /could not be checked/.test(why)) { await S.run('UPDATE "OmniWaFollowUp" SET reason = ?, updatedAt = ? WHERE id = ?', why, now, row.id); return 'waiting'; } // tried again later
  if (why) return finish('stopped', why);
  if (now - Number(row.createdAt) > MAX_AGE) return finish('skipped', 'Nobody sent it within a week, so it was dropped.');
  // the template: the one the draft was made with, else the one set now (an Admin may set it after the draft was made)
  const brand = (await require('./assist').settings()).businessName; // eslint-disable-line global-require
  const tName = row.templateName || st.template.name || null;
  const tpl = tName ? { name: tName, language: st.template.language || 'en', vars: row.templateName ? parse(row.vars, []) : templateVars(st.template.vars, lead, st, brand) } : null;
  const g = await Gate.check(conv, { purpose: 'followup', template: tpl, now });
  if (!g.ok) {
    if (g.code === 'OPTED_OUT') return finish('stopped', g.reason);
    await S.run('UPDATE "OmniWaFollowUp" SET reason = ?, updatedAt = ? WHERE id = ?', clip(g.reason, 240), now, row.id); // it stays: the reason is shown, a person can fix it
    return 'waiting';
  }
  let res;
  if (g.via === 'text') {
    res = await Agent.sendText(conv, row.body, { ai: true });
    if (res.ok) await S.run('UPDATE "OmniWaMessage" SET template = ? WHERE providerMessageId = ? AND convId = ?', 'Follow-up', res.providerRef || '', conv.id).catch(() => {});
  } else {
    const Sender = require('../marketing/sender'); // eslint-disable-line global-require
    let pk = await Sender.pick(null, conv.numberId, { trusted: true });
    if (pk.error) pk = await Sender.pick(null, null);
    const r = await Sender.send({ to: `+${conv.e164}`, kind: 'text', text: row.body, template: { name: g.template.name, language: g.template.language }, vars: g.template.vars, meta: { audience: 'leads', personName: clip(conv.name, 80), purpose: 'AI follow-up', module: 'WhatsApp assistant', automatic: true, template: g.template.name }, ...Sender.opts(pk) });
    res = r && r.ok ? { ok: true, providerRef: r.providerRef || null } : { ok: false, error: clip((r && r.error) || 'The sender refused it.', 200) };
    if (res.ok) {
      const t = Date.now();
      await S.run('INSERT OR IGNORE INTO "OmniWaMessage" (id, e164, convId, direction, body, template, status, providerMessageId, aiGenerated, numberId, at, createdAt) VALUES (?,?,?,\'OUT\',?,?,?,?,1,?,?,?)', S.newId('wam'), conv.e164, conv.id, clip(row.body, 4000), g.template.name, 'sent', res.providerRef, conv.numberId || null, t, t);
      await S.run('UPDATE "OmniWaConv" SET lastText = ?, updatedAt = ? WHERE id = ?', clip(row.body, 200), t, conv.id);
    }
  }
  if (!res.ok) {
    await S.run('UPDATE "OmniWaFollowUp" SET status = \'failed\', error = ?, reason = ?, updatedAt = ? WHERE id = ?', clip(res.error, 240), clip(res.error, 240), now, row.id);
    await AL.saveLead(conv, { followStep: Number(row.step), followAt: now }); // counted, so a failing send is not tried again and again
    return 'failed';
  }
  await S.run('UPDATE "OmniWaFollowUp" SET status = \'sent\', mode = ?, sentAt = ?, providerMessageId = ?, decidedByName = COALESCE(?, decidedByName), reason = NULL, updatedAt = ? WHERE id = ?', g.via, now, res.providerRef || null, by ? by.name || null : null, now, row.id);
  await AL.saveLead(conv, { followStep: Number(row.step), followAt: now });
  if (lead.crmLeadId) {
    const DB = require('../crm/schema'); const CS = require('../crm/service'); // eslint-disable-line global-require
    const t = DB.nowIso();
    await CS.insert('CrmActivity', { id: CS.newId('act'), kind: 'whatsapp', subject: `WhatsApp follow-up ${row.step} sent${g.via === 'template' ? ' (approved template)' : ''}`, note: clip(row.body, 1500), at: t, leadId: lead.crmLeadId, byName: by && by.name ? by.name : 'WhatsApp assistant', providerRef: res.providerRef || null, createdAt: t }).catch(() => null);
  }
  require('./live').changed();
  return 'sent';
}

// ---- the ticker ----------------------------------------------------------------------------------------------------------------------------------------
let busy = false;
// opts.force: also in the test sandbox. -> { drafted, sent, waiting, stopped, failed }
async function sweep(now = Date.now(), opts = {}) {
  const out = { drafted: 0, sent: 0, waiting: 0, stopped: 0, failed: 0 };
  if (!opts.force && require('../utils/sandbox').isSandbox()) return { ...out, sandbox: true }; // eslint-disable-line global-require
  if (busy) return { ...out, busy: true };
  busy = true;
  try {
    await ensure();
    const st = await settings();
    if (!st.enabled) return { ...out, off: true };
    const p = await plan(now, st);
    out.drafted = p.drafted; out.stopped += p.stopped;
    for (const row of await S.q('SELECT * FROM "OmniWaFollowUp" WHERE status = \'ready\' AND dueAt <= ? ORDER BY dueAt ASC LIMIT 20', now)) {
      const r = await sendOne(row, st, now).catch((e) => { console.error('[omni-wa] follow-up:', e && e.message); return 'failed'; }); // eslint-disable-line no-console, no-await-in-loop
      out[r] = (out[r] || 0) + 1;
    }
    // a draft waiting for a person that is a week old is dropped
    await S.run('UPDATE "OmniWaFollowUp" SET status = \'skipped\', reason = \'Nobody decided within a week, so it was dropped.\', updatedAt = ? WHERE status = \'approval\' AND createdAt < ?', now, now - MAX_AGE);
  } finally { busy = false; }
  return out;
}

// ---- a person decides -------------------------------------------------------------------------------------------------------------------------------------
async function mayDecide(user, conv, lead) {
  const A = require('../outreach/access'); // eslint-disable-line global-require
  const level = A.level(user);
  if (level === 'admin' || ['depthead', 'teamlead'].includes(level)) return true;
  if (conv.ownerUserId && conv.ownerUserId === user.id) return true;
  if (lead.crmLeadId) { const crm = await require('../crm/schema').one('SELECT "ownerId" FROM "CrmLead" WHERE "id" = ?', lead.crmLeadId).catch(() => null); return !!(crm && crm.ownerId === user.id); } // eslint-disable-line global-require
  return false;
}
/** body: { approve: true, text? } sends it now (through the gate) | { approve: false, stopAll? } skips it. -> { ok, result, row } or { error, status } */
async function decide(user, id, body = {}, now = Date.now()) {
  await ensure();
  const AL = require('./assistLead'); // eslint-disable-line global-require
  const row = await rowOf(id);
  if (!row) return { error: 'This follow-up is gone.', status: 404 };
  const conv = (await S.q('SELECT * FROM "OmniWaConv" WHERE id = ?', row.convId))[0];
  if (!conv) return { error: 'The chat is gone.', status: 404 };
  const lead = AL.leadOf(conv);
  if (!(await mayDecide(user, conv, lead))) return { error: 'Only an Admin, a team lead or the person who has this lead can decide on its follow-ups.', status: 403 };
  if (!['approval', 'ready'].includes(row.status)) return { error: 'This follow-up was already dealt with.', status: 409 };
  if (body.approve === false) {
    await S.run('UPDATE "OmniWaFollowUp" SET status = \'skipped\', reason = ?, decidedByName = ?, decidedAt = ?, updatedAt = ? WHERE id = ?', body.stopAll ? 'Skipped; follow-ups stopped for this customer.' : 'Skipped.', user.name || null, now, now, row.id);
    await AL.saveLead(conv, body.stopAll ? { followStop: true, followStopReason: `Stopped by ${user.name || 'a team member'}` } : { followStep: Number(row.step), followAt: now });
    return { ok: true, result: 'skipped', row: plain(await rowOf(id)) };
  }
  let text = row.body;
  if (typeof body.text === 'string' && body.text.trim()) {
    text = clip(body.text, 700);
    if (!/reply stop/i.test(text)) text = `${text}\n\n${STOP_LINE}`; // the opt-out line stays, whoever edits
  }
  await S.run('UPDATE "OmniWaFollowUp" SET body = ?, decidedByName = ?, decidedAt = ?, updatedAt = ? WHERE id = ?', text, user.name || null, now, now, row.id);
  const st = await settings();
  const result = await sendOne({ ...row, body: text }, st, now, user);
  return { ok: result === 'sent', result, row: plain(await rowOf(id)), ...(result === 'waiting' ? { error: ((await rowOf(id)) || {}).reason || 'It cannot be sent now.', status: 409 } : {}) };
}

// ---- what the screen reads ------------------------------------------------------------------------------------------------------------------------------------
async function list(user, query = {}) {
  await ensure();
  const AL = require('./assistLead'); // eslint-disable-line global-require
  const Inbox = require('./inbox'); // eslint-disable-line global-require
  const numbers = await require('../utils/waNumbers').visibleNumberIds(user); // eslint-disable-line global-require
  const only = query.status === 'all' ? null : ['approval', 'ready'];
  const rows = await S.q(`SELECT f.*, c.name AS convName, c.ownerUserId, c.numberId, c.id AS cid FROM "OmniWaFollowUp" f JOIN "OmniWaConv" c ON c.id = f.convId ${only ? `WHERE f.status IN ('approval', 'ready')` : ''} ORDER BY f.createdAt DESC LIMIT 200`);
  const out = [];
  for (const r of rows) {
    const conv = (await S.q('SELECT * FROM "OmniWaConv" WHERE id = ?', r.convId))[0]; // eslint-disable-line no-await-in-loop
    if (!conv || !(await Inbox.leadVisible(user, conv, numbers))) continue; // eslint-disable-line no-await-in-loop, no-continue
    const lead = AL.leadOf(conv);
    out.push({ id: r.id, key: `LEAD:${conv.id}`, name: lead.name || conv.name || 'New number', step: Number(r.step), status: r.status, body: r.body, mode: r.mode, templateName: r.templateName, reason: r.reason, error: r.error, createdAt: Number(r.createdAt), sentAt: r.sentAt ? Number(r.sentAt) : null, decidedByName: r.decidedByName, canDecide: await mayDecide(user, conv, lead) }); // eslint-disable-line no-await-in-loop
  }
  return { rows: out, counts: { waiting: out.filter((x) => ['approval', 'ready'].includes(x.status)).length } };
}

let timer = null;
function start() {
  if (timer || process.env.NODE_ENV === 'test' || require('../utils/sandbox').isSandbox()) return; // eslint-disable-line global-require
  timer = setInterval(() => { sweep().catch((e) => console.error('[omni-wa] follow-ups:', e && e.message)); }, 5 * 60000); // eslint-disable-line no-console
  if (timer.unref) timer.unref();
}

module.exports = { settings, saveSettings, clean, draftText, templateVars, plan, sweep, sendOne, decide, list, onInbound, closeOpen, stopReason, start, DEFAULTS, STOP_LINE };
