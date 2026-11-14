#!/usr/bin/env node
/**
 * The CRM Follow-ups upgrade (founder 2026-11-14): priority, the Visit type, Done = outcome + note on the timeline + the next follow-up in
 * one call, the tab counts, and the overdue alert to the Sales managers (crm/sales.js escalateOverdue: once per follow-up, one notice per person).
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4048. Nothing real is called.
 *   TEST_SOURCE_DB=<path to sandbox.db> node scripts/crm-followups-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-followups-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();

const PORT = 4048;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'crm-followups-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const SETTINGS = require('../src/crm/settings');
const SALES = require('../src/crm/sales');
const DB = require('../src/crm/schema');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 320)}` : ''}`); } };
const call = async (method, url, body, headers = {}) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, body: j };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const ymd = (offset) => new Date(Date.now() + 5.5 * 3600000 + offset * 86400000).toISOString().slice(0, 10);

(async () => {
  await DB.ensure();
  const admins = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 8 })).filter((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  const adminRow = admins[0];
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const admin = await resolveIdentity(adminRow.id);
  const manager = (await prisma.user.findMany({ where: { status: 'Active', id: { not: adminRow.id }, clientId: null, candidateId: null }, take: 1 }))[0];
  await SETTINGS.load({ fresh: true });
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const token = jwt.sign({ ...tokenPayload(admin), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const auth = { Authorization: `Bearer ${token}` };

  console.log('The lists the screen reads');
  const me = await call('GET', '/crm/me', null, auth);
  check('Visit is a follow-up type', me.body.lists.taskTypes.includes('Visit'), me.body.lists.taskTypes);
  check('priorities are High, Medium, Low', me.body.lists.priorities.join() === 'High,Medium,Low', me.body.lists.priorities);
  check('the outcomes to pick are there', me.body.lists.outcomes.includes('No answer') && me.body.lists.outcomes.includes('Spoke'), me.body.lists.outcomes);
  check('the overdue alert is on by default', me.body.lists.overdueAlertManagers === true, me.body.lists.overdueAlertManagers);

  console.log('Adding follow-ups: type and priority');
  const lead = await call('POST', '/crm/leads', { company: 'Zz Followup Co', contactName: 'Asha', phone: '9000055555' }, auth);
  const leadId = lead.body.lead.id;
  const t1 = await call('POST', '/crm/tasks', { title: 'Visit their office', dueDate: ymd(0), type: 'Visit', priority: 'High', leadId }, auth);
  check('a Visit with High priority is saved', t1.status === 200 && t1.body.task.type === 'Visit' && t1.body.task.priority === 'High', t1.body);
  const t2 = await call('POST', '/crm/tasks', { title: 'Plain call', dueDate: ymd(0), priority: 'Nonsense', leadId }, auth);
  check('a priority that does not exist becomes Medium', t2.body.task.priority === 'Medium' && t2.body.task.type === 'Call', t2.body.task);
  const t3 = await call('POST', '/crm/tasks', { title: 'Low one', dueDate: ymd(0), priority: 'Low', type: 'WhatsApp', leadId }, auth);
  check('a WhatsApp follow-up with Low priority', t3.body.task.priority === 'Low' && t3.body.task.type === 'WhatsApp', t3.body.task);

  console.log('Today: filters and order');
  const today = await call('GET', '/crm/tasks?when=today&all=1', null, auth);
  const mine = today.body.tasks.filter((t) => t.leadId === leadId && !/^First call/.test(t.title)).map((t) => t.priority); // (the lead's own automatic First call is High too)
  check('on the same day High comes before Medium before Low', mine.join() === 'High,Medium,Low', mine);
  const high = await call('GET', '/crm/tasks?when=today&all=1&priority=High', null, auth);
  check('the High filter keeps only High', high.body.tasks.length > 0 && high.body.tasks.every((t) => t.priority === 'High'), high.body.tasks.map((t) => t.priority));
  const med = await call('GET', '/crm/tasks?when=today&all=1&priority=Medium', null, auth);
  check('the Medium filter includes ones with no priority set', med.body.tasks.some((t) => t.id === t2.body.task.id), med.body.tasks.length);
  const visits = await call('GET', '/crm/tasks?when=today&all=1&type=Visit', null, auth);
  check('the type filter works', visits.body.tasks.length > 0 && visits.body.tasks.every((t) => (t.type || 'Call') === 'Visit'));
  const c0 = await call('GET', '/crm/tasks/counts', null, auth);
  check('the tab counts come as numbers', c0.status === 200 && ['overdue', 'today', 'upcoming'].every((k) => Number.isInteger(c0.body.counts[k])), c0.body);
  check('today counts the three just added', c0.body.counts.today >= 3, c0.body.counts);

  console.log('Done: outcome, timeline, next follow-up');
  const bad = await call('POST', `/crm/tasks/${t1.body.task.id}/done`, { outcome: 'Spoke', next: { dueDate: 'tomorrow' } }, auth);
  check('a bad next date is refused', bad.status === 400, bad.body);
  const still = await DB.one('SELECT "status" FROM "CrmTask" WHERE "id" = ?', t1.body.task.id);
  check('and nothing was saved: the follow-up is still open', still.status === 'Open', still);
  const done = await call('POST', `/crm/tasks/${t1.body.task.id}/done`, { note: 'Met the HR head, wants a proposal', outcome: 'Meeting held', next: { dueDate: ymd(3), dueTime: '11:30', title: 'Send the proposal', type: 'Email', priority: 'High' } }, auth);
  check('Done saves the outcome and the note', done.status === 200 && done.body.task.status === 'Done' && done.body.task.outcome === 'Meeting held' && /HR head/.test(done.body.task.doneNote), done.body);
  check('the next follow-up is made, with the time, type and priority', done.body.next && done.body.next.title === 'Send the proposal' && done.body.next.dueTime === '11:30' && done.body.next.type === 'Email' && done.body.next.priority === 'High', done.body.next);
  check('the next follow-up stays on the same lead and owner', done.body.next && done.body.next.leadId === leadId && done.body.next.ownerId === t1.body.task.ownerId, done.body.next);
  const det = await call('GET', `/crm/leads/${leadId}`, null, auth);
  const act = det.body.activities.find((a) => /Visit done: Visit their office/.test(a.subject || ''));
  check('the outcome and note are on the lead timeline', act && act.kind === 'meeting' && /Outcome: Meeting held/.test(act.note) && /HR head/.test(act.note), det.body.activities.map((a) => a.subject));
  check('a reached lead is now Contacted', det.body.lead.status === 'Contacted', det.body.lead.status);
  const again = await call('POST', `/crm/tasks/${t1.body.task.id}/done`, { outcome: 'Spoke', next: { dueDate: ymd(5) } }, auth);
  check('Done twice does not make a second next follow-up', again.status === 200 && !again.body.next, again.body);

  console.log('No answer is not a contact');
  const lead2 = await call('POST', '/crm/leads', { company: 'Zz Silent Co', phone: '9000066666' }, auth);
  const t4 = await call('POST', '/crm/tasks', { title: 'Ring them', dueDate: ymd(0), leadId: lead2.body.lead.id }, auth);
  await call('POST', `/crm/tasks/${t4.body.task.id}/done`, { outcome: 'No answer' }, auth);
  const d2 = await call('GET', `/crm/leads/${lead2.body.lead.id}`, null, auth);
  check('the lead stays New after No answer', d2.body.lead.status === 'New', d2.body.lead.status);
  check('but the No answer is on the timeline', d2.body.activities.some((a) => /Outcome: No answer/.test(a.note || '')), d2.body.activities.map((a) => a.note));
  const old = await call('POST', `/crm/tasks/${(await call('POST', '/crm/tasks', { title: 'Old style', dueDate: ymd(0), leadId: lead2.body.lead.id }, auth)).body.task.id}/done`, { note: 'just a note' }, auth);
  check('a plain note still works (older callers)', old.status === 200 && old.body.task.doneNote === 'just a note' && old.body.task.outcome == null, old.body);

  console.log('Overdue: the red mark and the alert to the managers');
  await SETTINGS.save({ salesTeam: manager ? [{ userId: manager.id, name: manager.name, role: 'manager' }] : [], overdueAlertManagers: true });
  const lateA = await call('POST', '/crm/tasks', { title: 'Late call A', dueDate: ymd(0), priority: 'High', leadId }, auth);
  const lateB = await call('POST', '/crm/tasks', { title: 'Late call B', dueDate: ymd(0), leadId }, auth);
  const fresh = await call('POST', '/crm/tasks', { title: 'Not late yet', dueDate: ymd(0), leadId }, auth);
  for (const t of [lateA, lateB]) await DB.run('UPDATE "CrmTask" SET "dueDate" = ? WHERE "id" = ?', ymd(-3), t.body.task.id);
  const od = await call('GET', '/crm/tasks?when=overdue&all=1', null, auth);
  check('both late ones are in the Overdue tab, not the fresh one', [lateA, lateB].every((t) => od.body.tasks.some((x) => x.id === t.body.task.id)) && !od.body.tasks.some((x) => x.id === fresh.body.task.id), od.body.tasks.length);
  const calls = [];
  const stub = async (ids, msg) => { calls.push({ ids, msg }); };
  const told = await SALES.escalateOverdue({ notify: stub });
  const mine2 = calls.filter((c) => /Late call/.test(c.msg.message));
  check('the managers are told about the late follow-ups', told >= 2 && mine2.length >= 1, { told, calls: calls.length });
  check('one notice per salesperson, listing what is late', mine2.length === 1 && /Late call A/.test(mine2[0].msg.message) && /Late call B/.test(mine2[0].msg.message) && /\[High\]/.test(mine2[0].msg.message), mine2.map((c) => c.msg.message));
  check('the notice goes to the Sales manager, not to the salesperson', manager ? mine2[0].ids.includes(manager.id) && !mine2[0].ids.includes(adminRow.id) : true, mine2[0] && mine2[0].ids);
  check('the follow-up that is not late is not in it', !mine2.some((c) => /Not late yet/.test(c.msg.message)));
  const claimed = await DB.one('SELECT "escalatedAt" FROM "CrmTask" WHERE "id" = ?', lateA.body.task.id);
  check('each late follow-up is marked as told', !!claimed.escalatedAt, claimed);
  const second = await SALES.escalateOverdue({ notify: stub });
  check('a second pass tells nobody again', second === 0 || !calls.slice(mine2.length ? calls.indexOf(mine2[0]) + 1 : 0).some((c) => /Late call/.test(c.msg.message)), second);
  const lateC = await call('POST', '/crm/tasks', { title: 'Late call C', dueDate: ymd(0), leadId }, auth);
  await DB.run('UPDATE "CrmTask" SET "dueDate" = ? WHERE "id" = ?', ymd(-1), lateC.body.task.id);
  await SETTINGS.save({ overdueAlertManagers: false });
  const before = calls.length;
  await SALES.escalateOverdue({ notify: stub });
  check('with the alert switched off nobody is told', !calls.slice(before).some((c) => /Late call C/.test(c.msg.message)));
  const off = await DB.one('SELECT "escalatedAt" FROM "CrmTask" WHERE "id" = ?', lateC.body.task.id);
  check('and the follow-up is not marked, so it is told when the alert is on again', off.escalatedAt == null, off);
  await SETTINGS.save({ overdueAlertManagers: true });
  await SALES.escalateOverdue({ notify: stub });
  check('switched back on, it is told', calls.slice(before).some((c) => /Late call C/.test(c.msg.message)));

  console.log('Snooze');
  const sn = await call('POST', `/crm/tasks/${lateA.body.task.id}/snooze`, { dueDate: ymd(2) }, auth);
  check('snooze moves the day and keeps the time', sn.status === 200 && sn.body.task.dueDate === ymd(2) && sn.body.task.dueTime === lateA.body.task.dueTime, sn.body);
  check('snooze clears the managers\' alert, so a new late day alerts again', sn.body.task.escalatedAt == null && sn.body.task.reminderSentAt == null, sn.body.task);
  check('a snoozed follow-up leaves Overdue', !(await call('GET', '/crm/tasks?when=overdue&all=1', null, auth)).body.tasks.some((x) => x.id === lateA.body.task.id));
  check('the move is on the timeline', (await call('GET', `/crm/leads/${leadId}`, null, auth)).body.activities.some((a) => /Follow-up moved: Late call A/.test(a.subject || '')));
  check('a day in the past is refused', (await call('POST', `/crm/tasks/${lateB.body.task.id}/snooze`, { dueDate: ymd(-1) }, auth)).status === 400);
  check('a bad date is refused', (await call('POST', `/crm/tasks/${lateB.body.task.id}/snooze`, { dueDate: 'soon' }, auth)).status === 400);
  check('a finished follow-up cannot be moved', (await call('POST', `/crm/tasks/${t1.body.task.id}/snooze`, { dueDate: ymd(2) }, auth)).status === 409);
  const nt = await call('POST', `/crm/tasks/${lateB.body.task.id}/snooze`, { dueDate: ymd(1), dueTime: '15:45' }, auth);
  check('a new time can be given too', nt.status === 200 && nt.body.task.dueTime === '15:45', nt.body);

  console.log('The first call of a new lead');
  const nl = await call('POST', '/crm/leads', { company: 'Zz Fresh Lead', contactName: 'Meena', phone: '9000077777' }, auth);
  const ff = nl.body.firstFollowUp;
  check('a new lead comes back with a first follow-up', nl.status === 200 && !!ff, nl.body);
  check('it is "First call: <company>", a High Call, on that lead, for its owner', ff && ff.title === 'First call: Zz Fresh Lead' && ff.type === 'Call' && ff.priority === 'High' && ff.leadId === nl.body.lead.id && ff.ownerId === nl.body.lead.ownerId, ff);
  check('it has a due date and a time', ff && /^\d{4}-\d{2}-\d{2}$/.test(ff.dueDate) && /^\d{2}:\d{2}$/.test(ff.dueTime), ff && [ff.dueDate, ff.dueTime]);
  const own = { id: 'lead_x', ownerId: adminRow.id, ownerName: 'Test', company: 'Zz Clamp Co' };
  const at = (iso) => Date.parse(iso);
  const noon = await SALES.firstFollowUp(own, { now: at('2026-11-20T11:00:00+05:30') });
  check('at 11:00 it is due at 13:00 the same day', noon.dueDate === '2026-11-20' && noon.dueTime === '13:00', [noon.dueDate, noon.dueTime]);
  const night = await SALES.firstFollowUp(own, { now: at('2026-11-20T21:00:00+05:30') });
  check('at 21:00 it waits for 10:00 the next morning', night.dueDate === '2026-11-21' && night.dueTime === '10:00', [night.dueDate, night.dueTime]);
  const dawn = await SALES.firstFollowUp(own, { now: at('2026-11-20T05:00:00+05:30') });
  check('at 05:00 it is due at 10:00 the same day', dawn.dueDate === '2026-11-20' && dawn.dueTime === '10:00', [dawn.dueDate, dawn.dueTime]);
  check('a lead nobody owns yet gets none', (await SALES.firstFollowUp({ id: 'lead_y', company: 'No Owner Co' })) === null);
  await call('PUT', '/crm/settings', { autoFirstFollowUp: false }, auth); // through the server, so its own settings copy changes at once
  const nl2 = await call('POST', '/crm/leads', { company: 'Zz Quiet Lead', phone: '9000088888' }, auth);
  check('switched off, a new lead gets no first follow-up', nl2.status === 200 && !nl2.body.firstFollowUp, nl2.body);
  await call('PUT', '/crm/settings', { autoFirstFollowUp: true }, auth);

  console.log('Needs action = today + overdue');
  const needAct = await call('GET', '/crm/tasks?when=action&all=1', null, auth);
  const todayStr = ymd(0);
  check('Needs action holds only what is due today or late', needAct.status === 200 && needAct.body.tasks.length > 0 && needAct.body.tasks.every((t) => t.dueDate <= todayStr && t.status === 'Open'), needAct.body.tasks && needAct.body.tasks.map((t) => t.dueDate));
  check('it is in date order, so the late ones come first', needAct.body.tasks.every((t, i, a) => i === 0 || a[i - 1].dueDate <= t.dueDate));
  check('nothing due later is in it', !needAct.body.tasks.some((t) => t.dueDate > todayStr));
  const ca = await call('GET', '/crm/tasks/counts', null, auth);
  check('the count for the tab is overdue + today', ca.body.counts.needsAction === ca.body.counts.overdue + ca.body.counts.today && ca.body.counts.needsAction === needAct.body.tasks.length, [ca.body.counts, needAct.body.tasks.length]);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
