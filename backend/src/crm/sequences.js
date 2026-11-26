// ---------------------------------------------------------------------------
// SALES SEQUENCES (2026-11-26, the CRM money / sales gaps): a named list of steps - "day 0 a mail, day 2 a WhatsApp, day 4 a call follow-up for
// the owner, day 7 an SMS" - that a person PUTS a lead on. Unlike the automatic follow-through (crm/autopilot.js, which every new lead gets
// once it is on) a sequence starts only when somebody enrols the lead, and the same sends are used (crm/autopilot.js runStep: the opt-out
// check, the unsubscribe line in a mail, the WhatsApp / SMS connections).
// It stops by itself the moment the lead REPLIES (autopilot.onReply calls stopFor), is Won / Lost / Junk / Converted, is opted out, or somebody
// presses Stop. Nothing goes in quiet hours (Message templates > Limits). One sequence at a time per lead. Sample records are never contacted.
// A Sales manager / Admin makes and changes the sequences; anybody who can edit a lead can put it on one. tick() runs every minute (routes/crm.js).
// ---------------------------------------------------------------------------

const DB = require('./schema');
const S = require('./service');
const SETTINGS = require('./settings');

const DAY = 24 * 3600000;
const CHANNELS = ['email', 'sms', 'whatsapp', 'task'];
const CHANNEL_WORD = { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp', task: 'Follow-up for the owner' };
const MAX_STEPS = 10;
const MAX_PER_TICK = 20;
const parse = (j) => { try { return j ? JSON.parse(j) : []; } catch { return []; } };

function cleanSteps(raw) {
  if (!Array.isArray(raw) || !raw.length) return { error: 'Add at least one step.' };
  if (raw.length > MAX_STEPS) return { error: `At most ${MAX_STEPS} steps.` };
  const steps = [];
  for (let i = 0; i < raw.length; i += 1) {
    const s = raw[i] || {};
    const channel = String(s.channel || '');
    if (!CHANNELS.includes(channel)) return { error: `Step ${i + 1}: pick Email, SMS, WhatsApp or a follow-up.` };
    const afterDays = Number(s.afterDays);
    if (!(Number.isInteger(afterDays) && afterDays >= 0 && afterDays <= 90)) return { error: `Step ${i + 1}: the day is a whole number from 0 to 90.` };
    if (i > 0 && afterDays < steps[i - 1].afterDays) return { error: `Step ${i + 1} comes before step ${i}: put the steps in day order.` };
    const body = S.clip(String(s.body || '').trim(), 2000);
    if (!body) return { error: `Step ${i + 1}: write the ${channel === 'task' ? 'follow-up' : 'message'}.` };
    const subject = channel === 'email' ? S.clip(String(s.subject || '').trim(), 200) : '';
    if (channel === 'email' && !subject) return { error: `Step ${i + 1}: write the mail subject.` };
    steps.push({ channel, afterDays, subject, body });
  }
  return { steps };
}
const seqOut = (x, counts = {}) => ({ id: x.id, name: x.name, steps: parse(x.stepsJson), active: !!x.active, byName: x.createdByName, updatedAt: x.updatedAt, running: counts[x.id] || 0 });
const onlyManagers = (user) => (S.mayAssign(S.roleOf(user)) ? null : S.fail(403, 'Sequences are made by a Sales manager or an Admin. You can put your leads on one.'));

async function list(user) {
  if (!S.roleOf(user)) return S.fail(403, 'The CRM is for the sales team.');
  const rows = await DB.all('SELECT * FROM "CrmSequence" ORDER BY "active" DESC, "name" ASC');
  const counts = Object.fromEntries((await DB.all('SELECT "sequenceId", COUNT(*) AS "n" FROM "CrmSeqEnrol" WHERE "status" = \'active\' GROUP BY "sequenceId"')).map((c) => [c.sequenceId, Number(c.n)]));
  return S.okBody({ sequences: rows.map((x) => seqOut(x, counts)), canChange: S.mayAssign(S.roleOf(user)), channels: CHANNELS.map((c) => ({ value: c, label: CHANNEL_WORD[c] })) });
}
async function save(user, id, body = {}) {
  const no = onlyManagers(user); if (no) return no;
  const name = S.clip(String(body.name || '').trim(), 80);
  if (!name) return S.fail(400, 'Give the sequence a name.');
  const c = cleanSteps(body.steps);
  if (c.error) return S.fail(400, c.error);
  const now = DB.nowIso();
  if (id) {
    const cur = await DB.one('SELECT * FROM "CrmSequence" WHERE "id" = ?', S.clip(id, 60));
    if (!cur) return S.fail(404, 'This sequence is not there.');
    // leads already on it keep the steps they were given; the change is for the next ones
    const saved = await S.update('CrmSequence', cur.id, { name, stepsJson: JSON.stringify(c.steps), active: body.active === false ? 0 : 1, updatedAt: now });
    await S.audit(user, 'CRM sequence changed', 'CrmSequence', cur.id, `${name}: ${c.steps.length} steps${body.active === false ? ' (switched off)' : ''}`);
    return S.okBody({ ok: true, sequence: seqOut(saved) });
  }
  const saved = await S.insert('CrmSequence', { id: S.newId('seq'), name, stepsJson: JSON.stringify(c.steps), active: 1, createdById: user.id, createdByName: user.name || null, createdAt: now, updatedAt: now });
  await S.audit(user, 'CRM sequence made', 'CrmSequence', saved.id, `${name}: ${c.steps.length} steps`);
  return S.okBody({ ok: true, sequence: seqOut(saved) });
}

async function note(leadId, subject, text, kind = 'note', by = 'Sequence') {
  const now = DB.nowIso();
  await S.insert('CrmActivity', { id: S.newId('act'), kind, subject, note: text || null, at: now, leadId, byName: by, createdAt: now }).catch(() => null);
}
async function forLead(user, leadId) {
  const r = S.roleOf(user);
  const lead = await S.getRow('lead', leadId);
  if (!lead || !S.canSeeRow(user, r, lead)) return S.fail(404, 'This lead is not there.');
  const rows = await DB.all('SELECT e.*, s."name" AS "seqName" FROM "CrmSeqEnrol" e LEFT JOIN "CrmSequence" s ON s."id" = e."sequenceId" WHERE e."leadId" = ? ORDER BY e."createdAt" DESC LIMIT 10', lead.id);
  const steps = rows.length ? await DB.all(`SELECT * FROM "CrmSeqStep" WHERE "enrolId" IN (${rows.map(() => '?').join(',')}) ORDER BY "idx"`, ...rows.map((x) => x.id)) : [];
  return S.okBody({
    enrolments: rows.map((e) => ({ id: e.id, sequenceId: e.sequenceId, name: e.seqName || '(removed)', status: e.status, stopWhy: e.stopWhy, byName: e.byName, createdAt: e.createdAt, steps: steps.filter((s) => s.enrolId === e.id).map((s) => ({ idx: s.idx, dueAt: s.dueAt, status: s.status, result: s.result, sentAt: s.sentAt })) })),
    canEnrol: S.canEditRow(user, r, lead),
  });
}
async function enrol(user, leadId, body = {}) {
  const r = S.roleOf(user);
  const lead = await S.getRow('lead', leadId);
  if (!lead || !S.canSeeRow(user, r, lead)) return S.fail(404, 'This lead is not there.');
  if (!S.canEditRow(user, r, lead)) return S.fail(403, 'You cannot change this lead.');
  if (['Converted', 'Junk'].includes(lead.status)) return S.fail(400, `This lead is ${lead.status}.`);
  if (/^Sample/i.test(lead.company || '')) return S.fail(400, 'Sample records are never contacted.');
  const seq = await DB.one('SELECT * FROM "CrmSequence" WHERE "id" = ? AND "active" = 1', S.clip(body.sequenceId, 60));
  if (!seq) return S.fail(400, 'Pick a sequence that is switched on.');
  if (await DB.one('SELECT 1 AS "x" FROM "CrmSeqEnrol" WHERE "leadId" = ? AND "status" = \'active\'', lead.id)) return S.fail(409, 'This lead is already on a sequence. Stop it first.');
  const steps = parse(seq.stepsJson);
  const needs = [...new Set(steps.map((s) => s.channel))].filter((c) => (c === 'email' && !lead.email) || ((c === 'sms' || c === 'whatsapp') && !lead.phone));
  const now = Date.now(); const iso = DB.nowIso();
  const e = await S.insert('CrmSeqEnrol', { id: S.newId('enr'), sequenceId: seq.id, leadId: lead.id, status: 'active', byId: user.id, byName: user.name || null, createdAt: iso, updatedAt: iso });
  for (let i = 0; i < steps.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await S.insert('CrmSeqStep', { id: S.newId('sst'), enrolId: e.id, leadId: lead.id, idx: i, dueAt: new Date(now + steps[i].afterDays * DAY).toISOString(), status: 'waiting' });
  }
  await note(lead.id, `Put on the sequence "${seq.name}" by ${user.name || 'a person'}`, `${steps.length} steps over ${steps[steps.length - 1].afterDays} days. Stops when they reply.`, 'note', user.name || 'Sequence');
  await S.audit(user, 'CRM lead put on a sequence', 'CrmLead', lead.id, `${lead.company}: ${seq.name}`);
  return S.okBody({ ok: true, enrolId: e.id, warn: needs.length ? `The lead has no ${needs.map((c) => (c === 'email' ? 'email' : 'phone')).filter((v, i, a) => a.indexOf(v) === i).join(' or ')}: those steps will be skipped.` : null });
}
async function stopEnrol(enrolId, why) {
  const n = await DB.run('UPDATE "CrmSeqEnrol" SET "status" = \'stopped\', "stopWhy" = ?, "updatedAt" = ? WHERE "id" = ? AND "status" = \'active\'', S.clip(why, 200), DB.nowIso(), enrolId);
  await DB.run('UPDATE "CrmSeqStep" SET "status" = \'stopped\', "result" = ? WHERE "enrolId" = ? AND "status" = \'waiting\'', S.clip(why, 200), enrolId);
  return Number(n) === 1;
}
async function stop(user, leadId) {
  const r = S.roleOf(user);
  const lead = await S.getRow('lead', leadId);
  if (!lead || !S.canEditRow(user, r, lead)) return S.fail(404, 'This lead is not there, or it is not yours.');
  const e = await DB.one('SELECT * FROM "CrmSeqEnrol" WHERE "leadId" = ? AND "status" = \'active\'', lead.id);
  if (!e) return S.fail(400, 'This lead is not on a sequence.');
  await stopEnrol(e.id, `stopped by ${user.name || 'a person'}`);
  await note(lead.id, `Sequence stopped by ${user.name || 'a person'}`, null, 'note', user.name || 'Sequence');
  return S.okBody({ ok: true });
}
/** A reply from the lead (autopilot.onReply): every sequence it is on stops. -> how many */
async function stopFor(leadId, why) {
  const rows = await DB.all('SELECT "id" FROM "CrmSeqEnrol" WHERE "leadId" = ? AND "status" = \'active\'', leadId).catch(() => []);
  let n = 0;
  for (const e of rows) if (await stopEnrol(e.id, why)) n += 1; // eslint-disable-line no-await-in-loop
  if (n) await note(leadId, `Sequence stopped: ${why}`);
  return n;
}
async function quietNow(now) {
  const R = require('../utils/omniRules'); // eslint-disable-line global-require
  return R.inQuiet(await R.settings(), new Date(now));
}
/** One pass: the steps whose time has come. -> what was done */
async function tick({ now = Date.now(), deps = {} } = {}) {
  const out = { sent: 0, skipped: 0, failed: 0, stopped: 0, tasks: 0, done: 0, quiet: false };
  const due = await DB.all('SELECT * FROM "CrmSeqStep" WHERE "status" = \'waiting\' AND "dueAt" <= ? ORDER BY "dueAt" LIMIT ?', new Date(now).toISOString(), MAX_PER_TICK);
  if (!due.length) return out;
  if (!deps.noQuiet && await quietNow(now)) { out.quiet = true; return out; }
  const AUTO = require('./autopilot'); // eslint-disable-line global-require
  const SALES = require('./sales'); // eslint-disable-line global-require
  const names = SALES.stageNames(await SETTINGS.load());
  for (const row of due) {
    /* eslint-disable no-await-in-loop */
    const claimed = await DB.run('UPDATE "CrmSeqStep" SET "status" = \'sending\' WHERE "id" = ? AND "status" = \'waiting\'', row.id);
    if (Number(claimed) !== 1) continue; // eslint-disable-line no-continue
    const e = await DB.one('SELECT e.*, s."stepsJson", s."name" FROM "CrmSeqEnrol" e LEFT JOIN "CrmSequence" s ON s."id" = e."sequenceId" WHERE e."id" = ?', row.enrolId);
    const lead = await S.getRow('lead', row.leadId);
    const stage = lead ? SALES.stageOf(lead, names) : null;
    const why = !e || e.status !== 'active' ? 'the sequence was stopped' : (!lead ? 'the lead is gone' : (['Converted', 'Junk'].includes(lead.status) ? `the lead is ${lead.status}` : (['Won', 'Lost'].includes(stage) ? `the lead is ${stage}` : null)));
    if (why) {
      await DB.run('UPDATE "CrmSeqStep" SET "status" = \'stopped\', "result" = ? WHERE "id" = ?', why, row.id);
      if (e && e.status === 'active') { await stopEnrol(e.id, why); await note(row.leadId, `Sequence "${e.name}" stopped: ${why}`); }
      out.stopped += 1;
      continue; // eslint-disable-line no-continue
    }
    const step = parse(e.stepsJson)[row.idx];
    let r;
    if (!step) r = { skip: 'the step is no longer in the sequence' };
    else if (step.channel === 'task') {
      const iso = new Date(now + 5.5 * 3600000).toISOString(); const at = DB.nowIso();
      await S.insert('CrmTask', {
        id: S.newId('task'), title: `${e.name}: ${S.clip(step.body, 150)}`, dueDate: iso.slice(0, 10), dueTime: iso.slice(11, 16), status: 'Open', type: /call/i.test(step.body) ? 'Call' : 'Other',
        notifyApp: 1, notifyWhatsapp: 0, notifySms: 0, notifyLead: 0, remindBefore: 0, leadId: lead.id, ownerId: lead.ownerId, ownerName: lead.ownerName, origin: 'sequence', createdAt: at, updatedAt: at,
      }).catch(() => null);
      r = { ok: true, kind: 'note', subject: `Sequence "${e.name}": follow-up made for ${lead.ownerName || 'the owner'}`, text: step.body };
      out.tasks += 1;
    } else r = await AUTO.runStep({ id: row.id }, { ...step, afterHours: step.afterDays * 24 }, lead, {}, deps).catch((x) => ({ fail: x.message }));
    if (r.ok) {
      await DB.run('UPDATE "CrmSeqStep" SET "status" = \'sent\', "sentAt" = ? WHERE "id" = ?', DB.nowIso(), row.id);
      if (step && step.channel !== 'task') out.sent += 1;
      await note(lead.id, step && step.channel === 'task' ? r.subject : `Sequence "${e.name}": ${r.subject}`, r.text, r.kind);
      if (SALES.stageOf(lead, names) === names[0] && step && step.channel !== 'task') {
        await S.update('CrmLead', lead.id, { stage: names[1] || 'Contacted', status: 'Contacted', updatedAt: DB.nowIso() });
        await note(lead.id, `Stage: ${names[0]} → ${names[1] || 'Contacted'}`, 'Reached by a sequence');
      }
    } else {
      await DB.run('UPDATE "CrmSeqStep" SET "status" = ?, "result" = ? WHERE "id" = ?', r.skip ? 'skipped' : 'failed', String(r.skip || r.fail).slice(0, 300), row.id);
      if (r.skip) out.skipped += 1; else { out.failed += 1; await note(lead.id, `Sequence "${e.name}": ${CHANNEL_WORD[step.channel]} did not go`, String(r.fail).slice(0, 300)); }
    }
    // the last step done: the sequence is finished
    const left = await DB.one('SELECT COUNT(*) AS "n" FROM "CrmSeqStep" WHERE "enrolId" = ? AND "status" IN (\'waiting\', \'sending\')', e.id);
    if (!Number(left && left.n)) { await DB.run('UPDATE "CrmSeqEnrol" SET "status" = \'done\', "updatedAt" = ? WHERE "id" = ? AND "status" = \'active\'', DB.nowIso(), e.id); out.done += 1; }
    /* eslint-enable no-await-in-loop */
  }
  return out;
}

module.exports = { CHANNELS, cleanSteps, list, save, forLead, enrol, stop, stopFor, tick };
