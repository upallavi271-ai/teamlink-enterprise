// ---------------------------------------------------------------------------
// OMNI-CHANNEL AUTOMATIONS = SEQUENCES (founder structure plan 2026-10-17). A short list of steps for one person at a time:
//   Applied -> WhatsApp -> (no reply in N hours / days) SMS -> Call task -> Follow-up task
// Each step waits `waitHours` after the step before it. Step kinds:
//   message  channel whatsapp | sms | email, with a template (a hub key "outreach:<id>" / "message:<id>") or its own text
//   task     call | follow_up | ai_call   -> a TASK for the person who owns the run (a plain to-do shown in Automations > Tasks).
//            "ai_call" is PLAN ONLY: it is stored and shown as a normal call task; no AI call is ever made.
// SAFETY (all on by default):
//   * Nothing is sent unless "Outreach sending" is switched on AND Test mode is off. Otherwise a message step is only REHEARSED
//     (written to the log and the credit ledger as a Test message; no provider is called).
//   * A message goes only to a person who agreed to that way (permission "opted in"). Opted out, no permission recorded, or no address = skipped.
//   * Stop on reply (default on): a reply from the person, or an opt-out, ends the run before the next step.
//   * Quiet hours (Settings > Sending rules) hold a message step until they end. Credits: the owner's monthly credits are checked (Admin exempt).
// Tables (self-provisioned, raw SQL; migration 20261016200000_omni_sequences): OmniSequence, OmniSequenceRun, OmniSequenceLog.
// The tick runs inside the API process every minute (started by routes/outreachV2.js) and does nothing for sequences that are off.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const S = require('./store');
const A = require('./access');
const K = require('./contacts');
const Cr = require('./credits');
const Quiet = require('./quiet');
const { logAudit } = require('../utils/audit');

const q = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p);
const run = (sql, ...p) => prisma.$executeRawUnsafe(sql, ...p);
const num = S.num;

const KINDS = { workflow: 'Workflow', followup: 'Auto follow-up', response: 'Auto response', drip: 'Drip campaign' };
const TRIGGERS = { manual: 'I add people myself', applied: 'When a person applies (ATS application matched to a contact)' };
const CHANNEL_WORD = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email' };
const TASK_WORD = { call: 'Call task', follow_up: 'Follow-up task', ai_call: 'AI call (planned: handled as a call task)' };
const MAX_STEPS = 8;

const DDL = [
  'CREATE TABLE IF NOT EXISTS "OmniSequence" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "kind" TEXT NOT NULL DEFAULT \'workflow\', "startOn" TEXT NOT NULL DEFAULT \'manual\', "steps" TEXT NOT NULL DEFAULT \'[]\', "stopOnReply" INTEGER NOT NULL DEFAULT 1, "quiet" INTEGER NOT NULL DEFAULT 1, "status" TEXT NOT NULL DEFAULT \'off\', "department" TEXT, "scanAt" DATETIME, "deletedAt" DATETIME, "createdById" TEXT, "createdByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS "OmniSequenceRun" ("id" TEXT NOT NULL PRIMARY KEY, "sequenceId" TEXT NOT NULL, "contactId" TEXT NOT NULL, "stepIndex" INTEGER NOT NULL DEFAULT 0, "nextAt" DATETIME NOT NULL DEFAULT 0, "status" TEXT NOT NULL DEFAULT \'running\', "stopReason" TEXT, "ownerUserId" TEXT, "startedAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0)',
  'CREATE UNIQUE INDEX IF NOT EXISTS "OmniSequenceRun_once" ON "OmniSequenceRun"("sequenceId", "contactId")',
  'CREATE INDEX IF NOT EXISTS "OmniSequenceRun_due" ON "OmniSequenceRun"("status", "nextAt")',
  'CREATE TABLE IF NOT EXISTS "OmniSequenceLog" ("id" TEXT NOT NULL PRIMARY KEY, "runId" TEXT, "sequenceId" TEXT NOT NULL, "contactId" TEXT, "stepIndex" INTEGER NOT NULL DEFAULT 0, "at" DATETIME NOT NULL DEFAULT 0, "channel" TEXT, "outcome" TEXT NOT NULL, "note" TEXT, "ownerUserId" TEXT, "doneAt" DATETIME)',
  'CREATE INDEX IF NOT EXISTS "OmniSequenceLog_seq" ON "OmniSequenceLog"("sequenceId", "at")',
];
let okAt = 0; let ensuring = null;
async function ensureTables() {
  if (okAt) return true;
  if (!ensuring) {
    ensuring = (async () => {
      try {
        // an earlier build made the time columns plain INTEGER: while the tables are still empty, make them again with DATETIME columns
        const old = await q('PRAGMA table_info("OmniSequence")');
        if (old.some((c) => c.name === 'createdAt' && String(c.type).toUpperCase() === 'INTEGER') && num((await q('SELECT COUNT(*) n FROM "OmniSequence"'))[0].n) === 0 && num((await q('SELECT COUNT(*) n FROM "OmniSequenceRun"'))[0].n) === 0) {
          await run('DROP TABLE "OmniSequenceLog"'); await run('DROP TABLE "OmniSequenceRun"'); await run('DROP TABLE "OmniSequence"');
        }
        for (const sql of DDL) await run(sql); // eslint-disable-line no-await-in-loop
        // an earlier build named the column "trigger" (an SQL word that upsets raw selects on an empty table): rename it once
        const cols = await q('PRAGMA table_info("OmniSequence")');
        if (cols.some((c) => c.name === 'trigger') && !cols.some((c) => c.name === 'startOn')) await run('ALTER TABLE "OmniSequence" RENAME COLUMN "trigger" TO "startOn"');
        okAt = Date.now(); return true;
      } catch (e) { console.error('[omni-sequences] tables:', e.message); return false; } // eslint-disable-line no-await-in-loop, no-console
      finally { ensuring = null; }
    })();
  }
  return ensuring;
}

// ---- who may do what -----------------------------------------------------------------------------------------------------
const mayManage = (u) => ['admin', 'bdetl', 'bde', 'tl', 'marketing', 'hr'].includes(A.kind(u));
function mayRead(u, row) {
  const k = A.kind(u);
  if (k === 'none') return false;
  if (k === 'admin' || k === 'view') return true;
  return row.createdById === u.id || (row.department && A.mayDepartment(u, row.department)) || (!row.department && k === 'hr');
}

// ---- validate -----------------------------------------------------------------------------------------------------------------
function cleanSteps(raw) {
  if (!Array.isArray(raw) || !raw.length) return { error: 'Add at least one step.' };
  if (raw.length > MAX_STEPS) return { error: `A sequence can have at most ${MAX_STEPS} steps.` };
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    const s = raw[i] || {};
    const wait = Math.floor(Number(s.waitHours));
    const waitHours = Number.isFinite(wait) && wait >= 0 ? Math.min(wait, 720) : 0;
    if (s.type === 'task') {
      const kind = ['call', 'follow_up', 'ai_call'].includes(s.kind) ? s.kind : null;
      if (!kind) return { error: `Step ${i + 1}: choose Call, Follow-up or AI call (planned).` };
      out.push({ type: 'task', kind, note: S.clip(s.note, 200), waitHours });
    } else {
      const channel = ['whatsapp', 'sms', 'email'].includes(s.channel) ? s.channel : null;
      if (!channel) return { error: `Step ${i + 1}: choose WhatsApp, SMS or Email.` };
      const templateKey = S.clip(s.templateKey, 80);
      const text = String(s.text || '').slice(0, 1000).trim();
      if (!templateKey && !text) return { error: `Step ${i + 1}: pick a template or type the message.` };
      out.push({ type: 'message', channel, templateKey: templateKey || '', text, subject: S.clip(s.subject, 200), waitHours });
    }
  }
  return { steps: out };
}

const view = (r, counts = {}) => ({
  id: r.id, name: r.name, kind: r.kind, kindWords: KINDS[r.kind] || r.kind, trigger: r.startOn, triggerWords: TRIGGERS[r.startOn] || r.startOn, steps: S.parse(r.steps, []), stopOnReply: !!num(r.stopOnReply), quiet: !!num(r.quiet),
  status: r.status, statusWords: r.status === 'on' ? 'On' : 'Off', department: r.department || '', createdByName: r.createdByName || '', updatedAt: S.iso(r.updatedAt), counts: { running: 0, done: 0, stopped: 0, ...counts },
});

async function list(user) {
  await ensureTables();
  if (A.kind(user) === 'none') return { sequences: [] };
  const rows = (await q('SELECT * FROM "OmniSequence" WHERE deletedAt IS NULL ORDER BY updatedAt DESC')).filter((r) => mayRead(user, r));
  const cnt = await q('SELECT sequenceId, status, COUNT(*) n FROM "OmniSequenceRun" GROUP BY sequenceId, status');
  const by = {}; cnt.forEach((c) => { (by[c.sequenceId] = by[c.sequenceId] || {})[c.status] = num(c.n); });
  return { sequences: rows.map((r) => view(r, by[r.id])), canManage: mayManage(user), kinds: Object.entries(KINDS).map(([id, words]) => ({ id, words })), triggers: Object.entries(TRIGGERS).map(([id, words]) => ({ id, words })) };
}
async function get(user, id) {
  await ensureTables();
  const r = (await q('SELECT * FROM "OmniSequence" WHERE id = ? AND deletedAt IS NULL', id))[0];
  return r && mayRead(user, r) ? r : null;
}
async function save(user, id, b) {
  await ensureTables();
  if (!mayManage(user)) return { error: 'You can look at automations, but only the BDE team, Team Leads, HR, Marketing and Admins can make them.', status: 403 };
  const cur = id ? await get(user, id) : null;
  if (id && !cur) return { error: 'This automation was not found.', status: 404 };
  if (cur && !(A.isAdmin(user) || cur.createdById === user.id)) return { error: 'Only the person who made it, or an Admin, can change it.', status: 403 };
  const name = S.clip(b.name !== undefined ? b.name : (cur && cur.name), 80);
  if (name.length < 2) return { error: 'Give the automation a name.', status: 400 };
  const kind = KINDS[b.kind !== undefined ? b.kind : (cur && cur.kind)] ? (b.kind !== undefined ? b.kind : cur.kind) : 'workflow';
  const trigger = TRIGGERS[b.trigger !== undefined ? b.trigger : (cur && cur.startOn)] ? (b.trigger !== undefined ? b.trigger : cur.startOn) : 'manual';
  const st = cleanSteps(b.steps !== undefined ? b.steps : (cur && S.parse(cur.steps, [])));
  if (st.error) return { error: st.error, status: 400 };
  const dept = S.clip(b.department !== undefined ? b.department : (cur && cur.department), 60) || null;
  if (dept && !A.mayDepartment(user, dept)) return { error: 'That department is not yours.', status: 403 };
  const stop = b.stopOnReply !== undefined ? (b.stopOnReply ? 1 : 0) : (cur ? num(cur.stopOnReply) : 1);
  const quiet = b.quiet !== undefined ? (b.quiet ? 1 : 0) : (cur ? num(cur.quiet) : 1);
  const now = Date.now();
  if (cur) {
    await run('UPDATE "OmniSequence" SET name = ?, kind = ?, "startOn" = ?, steps = ?, stopOnReply = ?, quiet = ?, department = ?, updatedAt = ? WHERE id = ?', name, kind, trigger, JSON.stringify(st.steps), stop, quiet, dept, now, cur.id);
    await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel automation changed', entity: 'OmniSequence', entityId: cur.id, toValue: name });
    return { sequence: view((await q('SELECT * FROM "OmniSequence" WHERE id = ?', cur.id))[0]) };
  }
  const nid = S.newId('osq');
  await run('INSERT INTO "OmniSequence" (id, name, kind, "startOn", steps, stopOnReply, quiet, status, department, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,\'off\',?,?,?,?,?)', nid, name, kind, trigger, JSON.stringify(st.steps), stop, quiet, dept, user.id, user.name, now, now);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel automation made', entity: 'OmniSequence', entityId: nid, toValue: name });
  return { sequence: view((await q('SELECT * FROM "OmniSequence" WHERE id = ?', nid))[0]) };
}
async function toggle(user, id, on) {
  const r = await get(user, id);
  if (!r) return { error: 'This automation was not found.', status: 404 };
  if (!mayManage(user) || !(A.isAdmin(user) || r.createdById === user.id)) return { error: 'You cannot switch this one.', status: 403 };
  await run('UPDATE "OmniSequence" SET status = ?, scanAt = CASE WHEN ? = 1 THEN ? ELSE scanAt END, updatedAt = ? WHERE id = ?', on ? 'on' : 'off', on ? 1 : 0, Date.now(), Date.now(), id);
  await logAudit({ userId: user.id, actorName: user.name, action: on ? 'Omni-Channel automation switched on' : 'Omni-Channel automation switched off', entity: 'OmniSequence', entityId: id, toValue: r.name });
  return { ok: on ? 'On. Messages are only rehearsed while Test mode is on.' : 'Off.' };
}
async function remove(user, id) {
  const r = await get(user, id);
  if (!r) return { error: 'This automation was not found.', status: 404 };
  if (!mayManage(user) || !(A.isAdmin(user) || r.createdById === user.id)) return { error: 'You cannot remove this one.', status: 403 };
  await run('UPDATE "OmniSequence" SET deletedAt = ?, status = \'off\' WHERE id = ?', Date.now(), id);
  await run('UPDATE "OmniSequenceRun" SET status = \'stopped\', stopReason = \'removed\' WHERE sequenceId = ? AND status = \'running\'', id);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel automation removed', entity: 'OmniSequence', entityId: id, toValue: r.name });
  return { ok: 'Removed. Anything still running was stopped.' };
}

// ---- enrol people ------------------------------------------------------------------------------------------------------------
async function enrolContact(seq, contactId, ownerUserId, now = Date.now()) {
  const steps = S.parse(seq.steps, []);
  if (!steps.length) return false;
  const id = S.newId('osr');
  const n = await run('INSERT OR IGNORE INTO "OmniSequenceRun" (id, sequenceId, contactId, stepIndex, nextAt, status, ownerUserId, startedAt, updatedAt) VALUES (?,?,?,0,?,\'running\',?,?,?)', id, seq.id, contactId, now + (steps[0].waitHours || 0) * 3600000, ownerUserId || null, now, now);
  return n > 0;
}
async function enrol(user, id, contactIds) {
  const seq = await get(user, id);
  if (!seq) return { error: 'This automation was not found.', status: 404 };
  if (!mayManage(user)) return { error: 'You cannot add people to automations.', status: 403 };
  const ids = [...new Set((Array.isArray(contactIds) ? contactIds : []).map(String))].slice(0, 200);
  if (!ids.length) return { error: 'Pick the people to add.', status: 400 };
  let added = 0; let already = 0; let outside = 0;
  for (const cid of ids) {
    const one = await K.getOne(user, cid); // eslint-disable-line no-await-in-loop
    if (!one) { outside += 1; continue; } // eslint-disable-line no-continue
    if (await enrolContact(seq, cid, user.id)) added += 1; else already += 1; // eslint-disable-line no-await-in-loop
  }
  await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel automation: people added', entity: 'OmniSequence', entityId: id, toValue: `${added} added` });
  return { added, already, outside, ok: `${added} added${already ? `, ${already} were already in it` : ''}${outside ? `, ${outside} are not yours to add` : ''}.` };
}

// ---- running ---------------------------------------------------------------------------------------------------------------------
// a reply from this person since the run started: a candidate's reply (CandidateMessage, status RECEIVED) or a reply in the one inbox (ConversationMessage, IN)
async function hasReplied(contact, since) {
  const likes = [];
  if (contact.phoneKey) likes.push(`%${contact.phoneKey}%`);
  if (contact.email) likes.push(`%${contact.email}%`);
  if (!likes.length) return false;
  try {
    const a = await q(`SELECT 1 x FROM "CandidateMessage" WHERE status = 'RECEIVED' AND createdAt >= ? AND (${likes.map(() => 'recipient LIKE ?').join(' OR ')}) LIMIT 1`, since, ...likes);
    if (a.length) return true;
  } catch { /* no candidate messages */ }
  try {
    const b = await q(`SELECT 1 x FROM "ConversationMessage" WHERE direction = 'IN' AND createdAt >= ? AND (${likes.map(() => 'address LIKE ?').join(' OR ')}) LIMIT 1`, since, ...likes);
    return b.length > 0;
  } catch { return false; }
}
function fill(text, c) {
  const first = String(c.name || '').trim().split(/\s+/)[0] || 'there';
  return String(text || '').replace(/\{\{\s*first_name\s*\}\}/g, first).replace(/\{\{\s*name\s*\}\}/g, c.name || 'there').replace(/\{\{\s*company\s*\}\}/g, c.company || '').replace(/\{\{\s*city\s*\}\}/g, c.city || '')
    .replace(/\{\{\s*unsubscribe\s*\}\}/g, 'Reply STOP to stop.').replace(/\{\{\s*apply_link\s*\}\}/g, '').replace(/\{\{[^}]*\}\}/g, '').trim();
}
async function textOf(step, contact) {
  let subject = step.subject || ''; let body = step.text || '';
  if (step.templateKey) {
    const [src, tid] = step.templateKey.split(/:(.*)/s);
    if (src === 'outreach') { const t = (await q('SELECT subject, body FROM "OutreachTemplate" WHERE id = ?', tid))[0]; if (t) { subject = t.subject || subject; body = t.body; } } else if (src === 'message') {
      const t = await prisma.messageTemplate.findUnique({ where: { id: tid } }).catch(() => null); if (t) { subject = t.subject || subject; body = t.body; }
    }
  }
  return { subject: fill(subject, contact), text: fill(body, contact) };
}
const logRow = (r, seqId, stepIndex, channel, outcome, note, owner, now) => run('INSERT INTO "OmniSequenceLog" (id, runId, sequenceId, contactId, stepIndex, at, channel, outcome, note, ownerUserId) VALUES (?,?,?,?,?,?,?,?,?,?)', S.newId('osl'), r ? r.id : null, seqId, r ? r.contactId : null, stepIndex, now, channel || null, outcome, S.clip(note, 200) || null, owner || null);

async function doMessage(seq, runRow, contact, step, st, now) {
  const ch = step.channel;
  const chRow = (await q('SELECT * FROM "OutreachContactChannel" WHERE contactId = ? AND channel = ?', contact.id, ch))[0];
  if (!chRow || chRow.optIn !== 'opted_in') return { outcome: 'skipped', note: chRow && chRow.optIn === 'opted_out' ? 'The person stopped this way' : 'No permission recorded for this way' };
  if (!chRow.address) return { outcome: 'skipped', note: 'No address for this way' };
  const rehearsal = !st.master || st.emailTestMode;
  const { subject, text } = await textOf(step, contact);
  if (!text) return { outcome: 'skipped', note: 'The message is empty' };
  if (rehearsal) {
    await Cr.record({ userId: runRow.ownerUserId, channel: ch, mode: 'test', ok: true, templateLabel: seq.name, source: 'sequence', now });
    return { outcome: 'rehearsed', note: 'Test mode: nothing was sent' };
  }
  const g = await Cr.guard({ userId: runRow.ownerUserId, channel: ch, mode: 'live', now });
  if (!g.ok) return { outcome: 'blocked', note: g.message };
  const res = await require('../utils/messaging').send(CHANNEL_WORD[ch], { to: chRow.address, subject: subject || seq.name, text, vars: [text], kind: 'bulk', actorUserId: runRow.ownerUserId, meta: { template: seq.name, purpose: 'sequence' } }); // eslint-disable-line global-require
  return { outcome: res.ok ? 'sent' : 'failed', note: res.ok ? '' : (res.error || 'The provider did not accept it') };
}

async function processRun(runRow, seq, now, st) {
  const steps = S.parse(seq.steps, []);
  const i = num(runRow.stepIndex);
  const step = steps[i];
  const finish = (status, reason) => run('UPDATE "OmniSequenceRun" SET status = ?, stopReason = ?, updatedAt = ? WHERE id = ?', status, reason || null, now, runRow.id);
  if (!step) { await finish('done'); return 'done'; }
  const contact = (await q('SELECT * FROM "OutreachContact" WHERE id = ?', runRow.contactId))[0];
  if (!contact || contact.status !== 'active') { await finish('stopped', 'person removed'); return 'stopped'; }
  if (num(seq.stopOnReply) && i > 0 && await hasReplied(contact, num(runRow.startedAt))) { await logRow(runRow, seq.id, i, null, 'stopped', 'The person replied', runRow.ownerUserId, now); await finish('stopped', 'replied'); return 'stopped'; }
  if (num(seq.stopOnReply)) {
    const out = (await q('SELECT 1 x FROM "OutreachContactChannel" WHERE contactId = ? AND optIn = \'opted_out\' AND optOutAt >= ?', contact.id, num(runRow.startedAt)))[0];
    if (out) { await logRow(runRow, seq.id, i, null, 'stopped', 'The person asked to stop', runRow.ownerUserId, now); await finish('stopped', 'opted out'); return 'stopped'; }
  }
  if (step.type === 'message' && num(seq.quiet)) {
    const qs = Quiet.state(now, st.quietHours, seq.department && /staff|internal|hr/i.test(seq.department) ? 'internal' : 'job_promotion');
    if (qs.active) { await run('UPDATE "OmniSequenceRun" SET nextAt = ?, updatedAt = ? WHERE id = ?', qs.resumeAt, now, runRow.id); return 'held'; }
  }
  let r;
  if (step.type === 'task') r = { outcome: 'task', note: `${TASK_WORD[step.kind] || 'Task'}: ${step.note || contact.name || 'follow up'}` };
  else r = await doMessage(seq, runRow, contact, step, st, now);
  await logRow(runRow, seq.id, i, step.type === 'message' ? step.channel : step.kind, r.outcome, r.note, runRow.ownerUserId, now);
  const next = steps[i + 1];
  if (!next) await run('UPDATE "OmniSequenceRun" SET stepIndex = ?, status = \'done\', updatedAt = ? WHERE id = ?', i + 1, now, runRow.id);
  else await run('UPDATE "OmniSequenceRun" SET stepIndex = ?, nextAt = ?, updatedAt = ? WHERE id = ?', i + 1, now + (next.waitHours || 0) * 3600000, now, runRow.id);
  return r.outcome;
}

// 'applied' trigger: ATS applications made since the automation was switched on, matched (phone / email) to a contact
async function scanApplied(seq, now) {
  const since = new Date(num(seq.scanAt) || now);
  const apps = await prisma.application.findMany({ where: { createdAt: { gte: since } }, select: { candidate: { select: { phone: true, email: true } } }, take: 300 }).catch(() => []);
  let added = 0;
  for (const a of apps) {
    if (!a.candidate) continue; // eslint-disable-line no-continue
    const p = K.phoneOf(a.candidate.phone); const e = K.emailOf(a.candidate.email);
    // eslint-disable-next-line no-await-in-loop
    const hits = await K.findByKeys(p.ok ? p.key : null, e.ok ? e.key : null);
    for (const h of hits) if (h.contactType === 'candidate_lead' && await enrolContact(seq, h.id, seq.createdById, now)) added += 1; // eslint-disable-line no-await-in-loop
  }
  await run('UPDATE "OmniSequence" SET scanAt = ? WHERE id = ?', now, seq.id);
  return added;
}

async function tick(now = Date.now()) {
  if (!(await ensureTables()) || !(await S.ready())) return { ran: 0 };
  const st = await S.settings();
  const seqs = await q('SELECT * FROM "OmniSequence" WHERE status = \'on\' AND deletedAt IS NULL');
  const byId = new Map(seqs.map((s) => [s.id, s]));
  let enrolled = 0;
  for (const s of seqs) if (s.startOn === 'applied') enrolled += await scanApplied(s, now); // eslint-disable-line no-await-in-loop
  const due = await q('SELECT * FROM "OmniSequenceRun" WHERE status = \'running\' AND nextAt <= ? ORDER BY nextAt LIMIT 50', now);
  const counts = {};
  for (const r of due) {
    const seq = byId.get(r.sequenceId);
    if (!seq) continue; // eslint-disable-line no-continue
    let o = 'error';
    try { o = await processRun(r, seq, now, st); } catch (e) { console.error('[omni-sequences] run:', e.message); } // eslint-disable-line no-await-in-loop, no-console
    counts[o] = (counts[o] || 0) + 1;
  }
  return { ran: due.length, enrolled, counts };
}
let timer = null;
function start() {
  if (timer || process.env.OMNI_SEQUENCES_OFF === '1') return;
  timer = setInterval(() => { tick().catch(() => {}); }, 60000);
  if (timer.unref) timer.unref();
}

// ---- what happened (names only) + the tasks ---------------------------------------------------------------------------------------
async function runs(user, id) {
  const seq = await get(user, id);
  if (!seq) return { error: 'This automation was not found.', status: 404 };
  const rows = await q('SELECT r.id, r.stepIndex, r.status, r.stopReason, r.nextAt, c.name FROM "OmniSequenceRun" r JOIN "OutreachContact" c ON c.id = r.contactId WHERE r.sequenceId = ? ORDER BY r.updatedAt DESC LIMIT 100', id);
  const log = await q('SELECT l.at, l.stepIndex, l.channel, l.outcome, l.note, c.name FROM "OmniSequenceLog" l LEFT JOIN "OutreachContact" c ON c.id = l.contactId WHERE l.sequenceId = ? ORDER BY l.at DESC LIMIT 100', id);
  return { runs: rows.map((r) => ({ id: r.id, name: r.name || '', step: num(r.stepIndex) + 1, status: r.status, stopReason: r.stopReason || '', nextAt: r.status === 'running' ? S.iso(r.nextAt) : null })), log: log.map((l) => ({ at: S.iso(l.at), name: l.name || '', step: num(l.stepIndex) + 1, channel: l.channel || '', outcome: l.outcome, note: l.note || '' })) };
}
async function tasks(user) {
  await ensureTables();
  const rows = await q('SELECT l.id, l.at, l.note, l.doneAt, l.sequenceId, c.name FROM "OmniSequenceLog" l LEFT JOIN "OutreachContact" c ON c.id = l.contactId WHERE l.outcome = \'task\' AND (l.ownerUserId = ? OR ? = 1) ORDER BY (l.doneAt IS NOT NULL), l.at DESC LIMIT 100', user.id, A.isAdmin(user) ? 1 : 0);
  return { tasks: rows.map((r) => ({ id: r.id, at: S.iso(r.at), name: r.name || '', note: r.note || '', done: !!r.doneAt })) };
}
async function doneTask(user, id) {
  await ensureTables();
  const r = (await q('SELECT * FROM "OmniSequenceLog" WHERE id = ? AND outcome = \'task\'', id))[0];
  if (!r || !(r.ownerUserId === user.id || A.isAdmin(user))) return { error: 'This task was not found.', status: 404 };
  await run('UPDATE "OmniSequenceLog" SET doneAt = ? WHERE id = ?', Date.now(), id);
  return { ok: 'Done.' };
}

// ---- Omni-Channel Automations page (additive, 2026-10-17): the list + the four numbers, from the real runs and log ---------------------------------
// dept '' = all the login may see; a name = only automations of that department (or with none).
// Numbers: people now in a journey (running), messages really sent (log outcome "sent"; rehearsals counted apart), the share of people who ran every step
// ("goal" = reached the end without being stopped), and how many stopped because they replied. Nothing is estimated.
async function overview(user, dept = '') {
  const base = await list(user);
  const want = String(dept || '').trim().toLowerCase();
  const seqs = (base.sequences || []).filter((s) => !want || !s.department || String(s.department).toLowerCase() === want);
  const ids = seqs.map((s) => s.id);
  const ph = ids.map(() => '?').join(',');
  const per = {}; ids.forEach((id) => { per[id] = { sent: 0, rehearsed: 0, replied: 0, skipped: 0 }; });
  const k = { running: 0, done: 0, stopped: 0, replied: 0, sent: 0, rehearsed: 0 };
  if (ids.length) {
    const lg = await q(`SELECT sequenceId, outcome, COUNT(*) n FROM "OmniSequenceLog" WHERE sequenceId IN (${ph}) GROUP BY sequenceId, outcome`, ...ids);
    lg.forEach((r) => { const p = per[r.sequenceId]; if (!p) return; if (r.outcome === 'sent') p.sent = num(r.n); else if (r.outcome === 'rehearsed') p.rehearsed = num(r.n); else if (r.outcome === 'skipped') p.skipped = num(r.n); });
    const rep = await q(`SELECT sequenceId, COUNT(*) n FROM "OmniSequenceRun" WHERE sequenceId IN (${ph}) AND stopReason = 'replied' GROUP BY sequenceId`, ...ids);
    rep.forEach((r) => { if (per[r.sequenceId]) per[r.sequenceId].replied = num(r.n); });
  }
  seqs.forEach((s) => {
    s.stats = per[s.id];
    k.running += s.counts.running; k.done += s.counts.done; k.stopped += s.counts.stopped;
    k.replied += per[s.id].replied; k.sent += per[s.id].sent; k.rehearsed += per[s.id].rehearsed;
  });
  const total = k.running + k.done + k.stopped;
  return {
    canManage: base.canManage, kinds: base.kinds, triggers: base.triggers, sequences: seqs,
    kpis: { inFlow: k.running, everIn: total, sent: k.sent, rehearsed: k.rehearsed, finished: k.done, goalRate: total > 0 ? Math.round((k.done / total) * 1000) / 10 : null, replied: k.replied, stopped: k.stopped },
  };
}

module.exports = { KINDS, TRIGGERS, MAX_STEPS, ensureTables, cleanSteps, list, get, save, toggle, remove, enrol, enrolContact, tick, start, runs, tasks, doneTask, mayManage, overview };
