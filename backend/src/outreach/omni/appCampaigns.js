// ---------------------------------------------------------------------------
// OMNI-CHANNEL APP CAMPAIGNS (2026-10-17): a campaign made from an app screen - ATS (candidates), Job Portal (applicants), HRMS (employees), Accounts
// (a client's billing contact: invoice reminders and payment follow-ups) - recorded in the Omni module and tracked in Omni-Channel > Campaigns > From other apps.
// The WHO and the WHAT stay in the source systems and keep their own rules; this file adds the campaign life:
//   Save for later (status "Not sent yet") -> Ask for approval (when required) -> Send now or Schedule -> Pause / Resume -> Cancel -> tracking per person.
//   audience   the people picked on the app screen. The server checks again, per kind of person, with the SAME rules as the "Send message" window
//              (utils/contactAccess.js ruleFor + utils/messageContext.js recipientsFor + utils/scope.js): a BDE never gets a candidate's number, Accounts only
//              reaches a client's billing contact with the payment reminder wording, a person outside your scope is counted as "outside your access".
//   template   a message from the shared Template library (outreach/omni/library.js gate()): it must be shared with THIS app, approved, and visible to you.
//              No "write my own words" here: an app campaign always uses a library template.
//   preview    the real plan of utils/bulkMessaging.js buildPlan(): every person's own words with their values filled in, who is left out and why (no consent,
//              WhatsApp template not approved by Meta, channel not set up, quiet hours, daily limit, no address ...). Missing provider set-up is said plainly.
//   sending    TEST MODE FIRST: while "Outreach sending" is off or Test mode is on (the Omni-Channel rule, outreach/communication.js isRehearsal) every row is a
//              rehearsal ("Test message", nothing reaches a provider). Only a switched-on Admin setting hands the queue to the bulk sender (utils/bulkMessaging.js),
//              which retries, paces, records the provider's words and can be paused / cancelled; this file copies its row results into OmniAppCampaignItem.
//   approval   Admin switch "Campaigns from apps need approval" (Template library settings, default off). ON = a campaign by anybody who is not an Admin waits for
//              an approver (ATS / Job Portal: Team Lead, BDE TL; HRMS: HR; Accounts: Admin) who is not the person who asked.
//   see / do   you see the campaigns you made; an Admin all; a Team Lead / manager those of their own department (HR for HRMS ones). Anybody else's id = 404.
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const S = require('../store');
const A = require('../access');
const Comm = require('../communication');
const Schema = require('./schema');
const Lib = require('./library');
const Bulk = require('../../utils/bulkMessaging');
const MT = require('../../utils/messageTemplates');
const access = require('../../utils/contactAccess');
const { logAudit } = require('../../utils/audit');

const APPS = { ATS: ['candidates', 'clients'], 'Job Portal': ['candidates'], HRMS: ['employees'], Accounts: ['clients'] };
const CHANNELS = ['Email', 'SMS', 'WhatsApp'];
const STATUS_WORDS = { not_sent: 'Not sent yet', waiting: 'Waiting for approval', changes: 'Changes needed', approved: 'Approved', scheduled: 'Scheduled', sending: 'Sending', paused: 'Paused', done: 'Done', cancelled: 'Cancelled' };
const ITEM_WORDS = { queued: 'Waiting', sent: 'Sent', delivered: 'Delivered', failed: 'Failed', skipped: 'Left out', blocked: 'Not allowed', rehearsed: 'Test message (nothing sent)' };
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const clip = S.clip;
const isAdmin = (u) => A.isAdmin(u);
const num = S.num;
const MAX = Bulk.LIMIT || 500;

const deptOfUser = (u) => { try { return (A.departmentsOf(u)[0] || '').replace(/^./, (c) => c.toUpperCase()); } catch { return ''; } };

// ---- the input --------------------------------------------------------------------------------------
function clean(b) {
  const app = Object.keys(APPS).includes(b.app) ? b.app : null;
  const audience = ['candidates', 'clients', 'employees'].includes(b.audience) ? b.audience : (app ? APPS[app][0] : 'candidates');
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(String).filter(Boolean))];
  const channels = CHANNELS.filter((c) => (Array.isArray(b.channels) ? b.channels : []).includes(c));
  return {
    app, audience, ids, channels, purposeKey: clip(b.purposeKey, 120) || '', language: MT.languageOrEnglish(b.language),
    perChannel: b.perChannel && typeof b.perChannel === 'object' ? b.perChannel : {}, applicationId: b.applicationId || undefined, requirementId: b.requirementId || undefined,
    name: clip(b.name, 80), note: clip(b.note, 400), waNumberId: clip(b.waNumberId, 60) || undefined,
  };
}
const bulkInput = (c) => ({
  audience: c.audience, ids: c.ids, channels: c.channels, purposeKey: c.purposeKey, language: c.language, perChannel: c.perChannel, applicationId: c.applicationId, requirementId: c.requirementId, kind: 'campaign',
  omniNote: c.note || undefined, waNumberId: c.waNumberId || undefined, // the WhatsApp number chosen when the campaign was made
});

// the library check of every template this campaign would send (the SERVER refuses a template that app may not use)
async function templatesOk(user, c) {
  if (!c.purposeKey) return { error: 'Pick a message from the template library. Writing your own words is not available for a campaign from an app.', status: 400 };
  for (const ch of c.channels) {
    const per = (c.perChannel && c.perChannel[ch]) || {};
    const tpl = await MT.resolve({ purpose: c.purposeKey, channel: ch, language: c.language, templateId: per.templateId });
    if (!tpl || !tpl.id) { return { error: `There is no ${ch} message in the library for "${c.purposeKey}". Pick a template that has ${ch}, or untick ${ch}.`, status: 400, code: 'tpl_missing' }; }
    const g = await Lib.gate(user, `message:${tpl.id}`, c.app);
    if (g) return { error: `${ch}: ${g.error}`, status: g.status, code: g.code, template: tpl.name };
    if (per.body != null || per.subject != null) { // the words may not be changed here: what was approved is what is sent
      if (String(per.body || '').trim() !== String(tpl.body).trim() || (ch === 'Email' && String(per.subject || '').trim() !== String(tpl.subject || '').trim())) return { error: `${ch}: the words of a library template cannot be changed in a campaign. Change the template in the Template library instead.`, status: 400, code: 'tpl_edited' };
    }
  }
  return null;
}
async function check(user, raw) {
  const c = clean(raw);
  if (!c.app) return { error: 'Which app is this campaign for? (ATS, Job Portal, HRMS or Accounts)', status: 400 };
  if (!APPS[c.app].includes(c.audience)) return { error: `A ${c.app} campaign cannot go to ${c.audience}.`, status: 400 };
  if (!c.ids.length) return { error: 'Choose at least one person.', status: 400 };
  if (c.ids.length > MAX) return { error: `At most ${MAX} people per campaign. Narrow the list.`, status: 400 };
  if (!c.channels.length) return { error: 'Choose Email, SMS and/or WhatsApp.', status: 400 };
  const rule = await access.ruleFor(user, c.audience).catch(() => ({ allowed: false, reason: 'Not available to this login.' }));
  if (!rule.allowed) return { error: rule.reason || 'Not available to this login.', status: 403 };
  const bad = await templatesOk(user, c);
  if (bad) return bad;
  return { c, rule };
}

// ---- who sees / controls ------------------------------------------------------------------------------
function canSee(user, row) {
  if (isAdmin(user)) return true;
  if (row.createdById === user.id) return true;
  const lead = ['tl', 'bdetl', 'view'].includes(A.kind(user)) || (A.kind(user) === 'hr' && row.app === 'HRMS');
  return lead && row.app !== 'Accounts' && !!row.department && A.mayDepartment(user, row.department);
}
const canControl = (user, row) => isAdmin(user) || row.createdById === user.id;
function mayApprove(user, row) {
  if (isAdmin(user)) return true;
  if (row.createdById === user.id) return false;
  if (!canSee(user, row)) return false;
  if (row.app === 'HRMS') return A.kind(user) === 'hr';
  if (row.app === 'Accounts') return false;
  return A.has('mayApprove')(user);
}
async function needsApproval(user) { return !isAdmin(user) && (await Lib.settings()).requireCampaignApproval === true; }

// ---- reading -------------------------------------------------------------------------------------------------
async function rowFor(user, id) {
  await Schema.ensure();
  const row = (await S.q('SELECT * FROM "OmniAppCampaign" WHERE id = ?', String(id || '')))[0];
  if (!row || !canSee(user, row)) return { error: 'This campaign was not found.', status: 404 };
  return { row };
}
async function counts(id) {
  const out = { total: 0, queued: 0, sent: 0, delivered: 0, failed: 0, skipped: 0, blocked: 0, rehearsed: 0, replied: 0, people: 0 };
  (await S.q('SELECT status, COUNT(*) n FROM "OmniAppCampaignItem" WHERE campaignId = ? GROUP BY status', id)).forEach((r) => { out[r.status] = num(r.n); out.total += num(r.n); });
  out.replied = num((await S.q('SELECT COUNT(DISTINCT entityId) n FROM "OmniAppCampaignItem" WHERE campaignId = ? AND repliedAt IS NOT NULL', id))[0].n);
  out.people = num((await S.q('SELECT COUNT(DISTINCT entityId) n FROM "OmniAppCampaignItem" WHERE campaignId = ?', id))[0].n);
  return out;
}
function view(user, row, cnt, st) {
  const ap = parse(row.meta, {});
  const status = row.status === 'not_sent' && row.approval === 'waiting' ? 'waiting' : (row.status === 'not_sent' && row.approval === 'changes' ? 'changes' : (row.status === 'not_sent' && row.approval === 'approved' ? 'approved' : row.status));
  const ctl = canControl(user, row);
  const editable = ctl && row.status === 'not_sent' && row.approval !== 'waiting';
  return {
    id: row.id, app: row.app, name: row.name, audience: row.audience, channels: parse(row.channels, []), purposeKey: row.purposeKey || '', template: row.templateName || row.purposeKey || '', language: row.language || '',
    people: num(row.peopleCount), status, statusWords: STATUS_WORDS[status] || status, approval: row.approval || null, approvalNote: row.approvalNote || '', approvalByName: row.approvalByName || '',
    scheduledAt: row.scheduledAt ? S.iso(row.scheduledAt) : null, startedAt: row.startedAt ? S.iso(row.startedAt) : null, finishedAt: row.finishedAt ? S.iso(row.finishedAt) : null,
    mode: row.mode || null, modeWords: row.mode === 'rehearsal' ? 'Test mode: nothing was sent to anybody' : (row.mode === 'live' ? 'Real messages' : ''),
    createdByName: row.createdByName || '', createdAt: S.iso(row.createdAt), department: row.department || '', counts: cnt, lastError: ap.lastError || '',
    can: {
      edit: editable, ask: ctl && ['not_sent'].includes(row.status) && row.approval !== 'waiting' && row.approval !== 'approved',
      approve: row.status === 'not_sent' && row.approval === 'waiting' && mayApprove(user, row),
      send: ctl && row.status === 'not_sent' && row.approval !== 'waiting' && row.approval !== 'changes' && !(st && st.needsApproval && row.approval !== 'approved'),
      schedule: ctl && row.status === 'not_sent' && row.approval !== 'waiting' && row.approval !== 'changes' && !(st && st.needsApproval && row.approval !== 'approved'),
      pause: ctl && ['scheduled', 'sending'].includes(row.status), resume: ctl && row.status === 'paused', cancel: ctl && ['not_sent', 'scheduled', 'paused', 'sending'].includes(row.status),
      retry: ctl && ['done', 'cancelled'].includes(row.status) && row.mode === 'live' && cnt.failed > 0,
    },
    whySendBlocked: st && st.needsApproval && row.approval !== 'approved' && row.status === 'not_sent' ? 'Campaigns from apps need approval first. Press "Ask for approval".' : (row.approval === 'waiting' ? 'It is waiting for approval.' : (row.approval === 'changes' ? `A reviewer asked for changes: ${row.approvalNote || ''}` : '')),
  };
}

// ---- preview (nothing saved, nothing sent) ----------------------------------------------------------------------------
async function preview(user, raw) {
  const r = await check(user, raw);
  if (r.error) return r;
  const out = await Bulk.preview(user, bulkInput(r.c));
  if (out.error) return out;
  const st = await S.settings();
  return { preview: out.preview, rehearsal: Comm.isRehearsal(st), needsApproval: await needsApproval(user), modeWords: Comm.isRehearsal(st) ? 'Test mode is on, so this will be a rehearsal: nothing is sent to anybody.' : 'Sending is switched on: real messages will go to the people marked "will get it".' };
}

// ---- create / edit (Save for later) ---------------------------------------------------------------------------------------
async function save(user, raw, existing) {
  await Schema.ensure();
  const r = await check(user, raw);
  if (r.error) return r;
  const c = r.c;
  const plan = await Bulk.buildPlan(user, bulkInput(c));
  if (plan.error) return plan;
  const people = plan.plan.entities;
  const first = await MT.resolve({ purpose: c.purposeKey, channel: c.channels[0], language: c.language });
  const name = c.name || `${first ? first.purposeLabel : 'Message'} - ${new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10)}`;
  const req = { audience: c.audience, channels: c.channels, purposeKey: c.purposeKey, language: c.language, perChannel: c.perChannel, applicationId: c.applicationId, requirementId: c.requirementId, note: c.note, waNumberId: c.waNumberId };
  const now = Date.now();
  if (existing) {
    await S.run('UPDATE "OmniAppCampaign" SET name = ?, audience = ?, channels = ?, purposeKey = ?, templateName = ?, language = ?, request = ?, refs = ?, peopleCount = ?, approval = NULL, approvalNote = NULL, updatedAt = ? WHERE id = ? AND status = \'not_sent\'',
      name, c.audience, JSON.stringify(c.channels), c.purposeKey, first ? first.purposeLabel : c.purposeKey, c.language, JSON.stringify(req), JSON.stringify(c.ids), people, now, existing.id);
    await logAudit({ userId: user.id, actorName: user.name, action: 'App campaign changed', entity: 'OmniAppCampaign', entityId: existing.id, toValue: `${c.app}; ${people} people` });
    return { ok: 'Saved.', id: existing.id };
  }
  const id = S.newId('oac');
  await S.run('INSERT INTO "OmniAppCampaign" (id, app, name, audience, channels, purposeKey, templateKey, templateName, language, request, refs, peopleCount, department, status, createdById, createdByName, createdAt, updatedAt, meta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, c.app, name, c.audience, JSON.stringify(c.channels), c.purposeKey, first && first.id ? `message:${first.id}` : null, first ? first.purposeLabel : c.purposeKey, c.language, JSON.stringify(req), JSON.stringify(c.ids), people, deptOfUser(user), 'not_sent', user.id, user.name, now, now, '{}');
  await logAudit({ userId: user.id, actorName: user.name, action: 'App campaign saved for later', entity: 'OmniAppCampaign', entityId: id, toValue: `${c.app}; ${c.channels.join(' + ')}; ${people} people` });
  return { ok: 'Saved. It is not sent yet.', id };
}
const create = (user, raw) => save(user, raw, null);
async function update(user, id, raw) {
  const f = await rowFor(user, id);
  if (f.error) return f;
  if (f.row.status !== 'not_sent') return { error: 'Only a campaign that was never sent can be changed.', status: 409 };
  if (!canControl(user, f.row)) return { error: 'You can look at this campaign, but you cannot change it.', status: 403 };
  if (f.row.approval === 'waiting') return { error: 'It is waiting for approval. Ask for it to be sent back before you change it.', status: 409 };
  // fields the screen did not send keep what is saved (the people are never re-sent by the screen)
  const cur = parse(f.row.request, {});
  return save(user, { ...cur, ids: parse(f.row.refs, []), name: f.row.name, ...raw, ...(Array.isArray(raw.ids) && raw.ids.length ? {} : { ids: parse(f.row.refs, []) }), app: f.row.app }, f.row);
}

// ---- approval -------------------------------------------------------------------------------------------------------------------
async function approverIds(row) {
  const out = [];
  try {
    const { resolveIdentity } = require('../../utils/identity'); // eslint-disable-line global-require
    const users = await prisma.user.findMany({ where: { status: 'Active' }, select: { id: true, name: true, email: true, role: true, atsRole: true } });
    for (const u of users.filter((x) => ['SUPER_ADMIN', 'ADMIN', 'TL', 'STL', 'HR'].some((r) => [x.role, x.atsRole].includes(r)) && !/zztest|example\.test/i.test(`${x.name} ${x.email}`)).slice(0, 80)) {
      let ident = null; try { ident = await resolveIdentity(u.id); } catch { ident = null; } // eslint-disable-line no-await-in-loop
      if (ident && mayApprove(ident, row)) out.push(u.id);
    }
  } catch { /* courtesy */ }
  return out;
}
async function submit(user, id) {
  const f = await rowFor(user, id);
  if (f.error) return f;
  const { row } = f;
  if (!canControl(user, row)) return { error: 'You can look at this campaign, but you cannot ask for approval for it.', status: 403 };
  if (row.status !== 'not_sent') return { error: 'This campaign was already sent.', status: 409 };
  if (row.approval === 'waiting') return { error: 'It is already waiting for approval.', status: 409 };
  await S.run('UPDATE "OmniAppCampaign" SET approval = \'waiting\', approvalNote = NULL, approvalById = NULL, approvalByName = NULL, approvalAt = NULL, updatedAt = ? WHERE id = ?', Date.now(), id);
  const ids = (await approverIds(row)).filter((x) => x !== user.id);
  if (ids.length) { try { await require('../../utils/notify').notifyUsers(ids, { title: `Campaign "${clip(row.name, 60)}" needs your approval`, message: `${clip(user.name, 60)} asked for approval (${row.app}). Open Campaigns > From other apps.` }); } catch { /* courtesy */ } } // eslint-disable-line global-require
  await logAudit({ userId: user.id, actorName: user.name, action: 'App campaign: approval asked', entity: 'OmniAppCampaign', entityId: id, toValue: `${ids.length} approver(s) told` });
  return { ok: 'Sent for approval.', approval: 'waiting', approvers: ids.length };
}
async function decide(user, id, approve, note) {
  const f = await rowFor(user, id);
  if (f.error) return f;
  const { row } = f;
  if (row.approval !== 'waiting' || row.status !== 'not_sent') return { error: 'This campaign is not waiting for approval.', status: 409 };
  if (!mayApprove(user, row)) return { error: row.createdById === user.id && !isAdmin(user) ? 'You asked for this approval yourself. Somebody else has to approve it.' : 'You cannot approve this campaign.', status: 403 };
  const words = clip(note, 300);
  if (!approve && words.length < 5) return { error: 'Write a few words so the person knows what to change.', status: 400 };
  await S.run('UPDATE "OmniAppCampaign" SET approval = ?, approvalNote = ?, approvalById = ?, approvalByName = ?, approvalAt = ?, updatedAt = ? WHERE id = ?', approve ? 'approved' : 'changes', words || null, user.id, user.name, Date.now(), Date.now(), id);
  if (row.createdById && row.createdById !== user.id) { try { await require('../../utils/notify').notifyUsers([row.createdById], approve ? { title: `Campaign "${clip(row.name, 60)}" was approved`, message: 'You can send it now.' } : { title: `Campaign "${clip(row.name, 60)}" needs changes`, message: words }); } catch { /* courtesy */ } } // eslint-disable-line global-require
  await logAudit({ userId: user.id, actorName: user.name, action: approve ? 'App campaign approved' : 'App campaign sent back', entity: 'OmniAppCampaign', entityId: id, toValue: approve ? 'approved' : words });
  return { ok: approve ? 'Approved. The person who made it can send it.' : 'Sent back with your note.', approval: approve ? 'approved' : 'changes' };
}

// ---- send / schedule -------------------------------------------------------------------------------------------------------------
async function blocker(user, row) {
  if (row.status !== 'not_sent') return { error: 'This campaign was already sent.', status: 409 };
  if (!canControl(user, row)) return { error: 'You can look at this campaign, but you cannot send it.', status: 403 };
  if (row.approval === 'waiting') return { error: 'It is waiting for approval. It can be sent once it is approved.', status: 409 };
  if (row.approval === 'changes') return { error: `A reviewer asked for changes: ${row.approvalNote || ''}. Change it, then ask for approval again.`, status: 409 };
  if (row.approval !== 'approved' && (await needsApproval(user))) return { error: 'This campaign needs approval before it can be sent. Press "Ask for approval".', status: 403, code: 'needs_approval' };
  return null;
}
async function send(user, id, { when = 'now', at } = {}) {
  const f = await rowFor(user, id);
  if (f.error) return f;
  const { row } = f;
  const bl = await blocker(user, row);
  if (bl) return bl;
  if (when === 'later') {
    const t = S.ms(at);
    if (!t || t < Date.now() + 30000) return { error: 'Pick a time in the future.', status: 400 };
    // the audience and the template are checked again now, so a schedule is never saved for a campaign that could not go
    const r = await check(user, { ...parse(row.request, {}), ids: parse(row.refs, []), app: row.app, name: row.name });
    if (r.error) return r;
    await S.run('UPDATE "OmniAppCampaign" SET status = \'scheduled\', scheduledAt = ?, updatedAt = ? WHERE id = ? AND status = \'not_sent\'', t, Date.now(), id);
    await logAudit({ userId: user.id, actorName: user.name, action: 'App campaign scheduled', entity: 'OmniAppCampaign', entityId: id, toValue: new Date(t).toISOString() });
    return { ok: 'Scheduled.', status: 'scheduled' };
  }
  return launch(user, row);
}
// builds the person rows (every one, with the reason when left out) and sends or rehearses. `user` = the creator (a scheduled send runs as them)
async function launch(user, row) {
  const claim = await S.run('UPDATE "OmniAppCampaign" SET status = \'sending\', startedAt = ?, updatedAt = ? WHERE id = ? AND status IN (\'not_sent\',\'scheduled\')', Date.now(), Date.now(), row.id);
  if (!claim) return { error: 'This campaign is already going.', status: 409 }; // two presses / two ticks never send twice
  try {
    const req = parse(row.request, {});
    const c = clean({ ...req, ids: parse(row.refs, []), app: row.app });
    const r = await check(user, { ...c, app: row.app });
    if (r.error) throw Object.assign(new Error(r.error), { status: r.status || 400 });
    const st = await S.settings();
    const rehearsal = Comm.isRehearsal(st);
    const plan = await Bulk.buildPlan(user, bulkInput(c));
    if (plan.error) throw Object.assign(new Error(plan.error), { status: plan.status || 400 });
    const rows = plan.plan.recipients;
    const queued = rows.filter((x) => x.status === 'queued');
    const now = Date.now();
    await S.run('DELETE FROM "OmniAppCampaignItem" WHERE campaignId = ?', row.id);
    for (const x of rows) {
      const status = x.status === 'queued' ? (rehearsal ? 'rehearsed' : 'queued') : x.status;
      await S.run('INSERT OR IGNORE INTO "OmniAppCampaignItem" (id, campaignId, entityId, name, channel, status, reason, sentAt, applicationId) VALUES (?,?,?,?,?,?,?,?,?)', // eslint-disable-line no-await-in-loop
        S.newId('oai'), row.id, x.entityId, clip(x.name, 120), String(x.channel).toLowerCase(), status, status === 'rehearsed' ? 'Test mode: nothing was sent.' : clip(x.reason, 300) || null, status === 'rehearsed' ? now : null, x.applicationId || null);
    }
    const people = new Set(queued.map((x) => x.entityId)).size;
    if (rehearsal || !queued.length) {
      await S.run('UPDATE "OmniAppCampaign" SET status = \'done\', mode = ?, finishedAt = ?, totals = ?, updatedAt = ? WHERE id = ?', rehearsal ? 'rehearsal' : 'live', now, JSON.stringify({ people, toSend: queued.length }), now, row.id);
      await logAudit({ userId: user.id, actorName: user.name, action: rehearsal ? 'App campaign rehearsed (Test mode, nothing sent)' : 'App campaign finished (nobody to send to)', entity: 'OmniAppCampaign', entityId: row.id, toValue: `${row.app}; ${queued.length} messages; ${rows.length - queued.length} left out` });
      return { ok: rehearsal ? `Test mode: ${queued.length} messages were rehearsed. Nothing was sent to anybody.` : 'Nobody could be sent to. See the reasons below.', status: 'done', mode: rehearsal ? 'rehearsal' : 'live' };
    }
    const made = await Bulk.createJob(user, { ...bulkInput(c), confirmPeople: people });
    if (made.error) throw Object.assign(new Error(made.error), { status: made.status || 400 });
    await S.run('UPDATE "OmniAppCampaign" SET mode = \'live\', jobId = ?, totals = ?, updatedAt = ? WHERE id = ?', made.job.id, JSON.stringify({ people, toSend: queued.length }), now, row.id);
    await logAudit({ userId: user.id, actorName: user.name, action: 'App campaign started (real messages)', entity: 'OmniAppCampaign', entityId: row.id, toValue: `${row.app}; ${queued.length} messages to ${people} people` });
    return { ok: `Sending ${queued.length} messages to ${people} people.`, status: 'sending', mode: 'live' };
  } catch (e) {
    await S.run('UPDATE "OmniAppCampaign" SET status = \'not_sent\', meta = ?, updatedAt = ? WHERE id = ? AND status = \'sending\'', JSON.stringify({ ...parse(row.meta, {}), lastError: clip(e.message, 300) }), Date.now(), row.id);
    return { error: e.message, status: e.status || 500 };
  }
}

// ---- keep the person rows up to date from the bulk job -------------------------------------------------------------------------
const MAP = { queued: 'queued', sending: 'queued', sent: 'sent', failed: 'failed', skipped: 'skipped', blocked: 'blocked' };
async function sync(row) {
  if (!row || row.mode !== 'live' || !row.jobId || ['done', 'cancelled'].includes(row.status)) return row;
  const job = Bulk.readJob(row.jobId);
  if (!job) return row;
  for (const r of job.recipients) {
    const status = MAP[r.status] || 'queued';
    await S.run('UPDATE "OmniAppCampaignItem" SET status = ?, reason = ?, providerRef = COALESCE(?, providerRef), attempts = ?, sentAt = COALESCE(?, sentAt), failedAt = ? WHERE campaignId = ? AND entityId = ? AND channel = ? AND status NOT IN (\'delivered\')', // eslint-disable-line no-await-in-loop
      status, clip(r.reason, 300) || null, r.providerRef || null, r.attempts || 0, r.sentAt ? Date.parse(r.sentAt) : null, status === 'failed' ? Date.now() : null, row.id, r.entityId, String(r.channel).toLowerCase());
  }
  // a delivery report (a provider status event kept by the reply router) upgrades a sent row to delivered, or marks it failed
  const sentRows = await S.q("SELECT id, providerRef FROM \"OmniAppCampaignItem\" WHERE campaignId = ? AND status = 'sent' AND providerRef IS NOT NULL", row.id);
  for (const it of sentRows) {
    const evs = await S.q("SELECT providerEventId, receivedAt FROM \"OmniProviderEvent\" WHERE kind = 'status' AND providerEventId IN (?,?,?,?)", `${String(it.providerRef).toLowerCase()}:delivered`, `${String(it.providerRef).toLowerCase()}:read`, `${String(it.providerRef).toLowerCase()}:failed`, `${String(it.providerRef).toLowerCase()}:undelivered`); // eslint-disable-line no-await-in-loop
    const bad = evs.find((e) => /:(failed|undelivered)$/.test(e.providerEventId));
    const good = evs.find((e) => /:(delivered|read)$/.test(e.providerEventId));
    if (bad) await S.run("UPDATE \"OmniAppCampaignItem\" SET status = 'failed', reason = 'The provider reported it as not delivered.', failedAt = ? WHERE id = ?", S.ms(bad.receivedAt), it.id); // eslint-disable-line no-await-in-loop
    else if (good) await S.run("UPDATE \"OmniAppCampaignItem\" SET status = 'delivered', deliveredAt = ? WHERE id = ?", S.ms(good.receivedAt), it.id); // eslint-disable-line no-await-in-loop
  }
  let next = row.status;
  if (job.status === 'done') next = 'done'; else if (job.status === 'cancelled') next = 'cancelled'; else if (job.status === 'paused') next = 'paused'; else if (['queued', 'running'].includes(job.status) && row.status === 'paused' && !Bulk.pauseRequested(row.jobId)) next = 'sending';
  if (next !== row.status) await S.run('UPDATE "OmniAppCampaign" SET status = ?, finishedAt = ?, updatedAt = ? WHERE id = ?', next, ['done', 'cancelled'].includes(next) ? Date.now() : null, Date.now(), row.id);
  return { ...row, status: next };
}

// ---- pause / resume / cancel / retry ---------------------------------------------------------------------------------------------------
async function control(user, id, action) {
  const f = await rowFor(user, id);
  if (f.error) return f;
  const row = await sync(f.row);
  if (!canControl(user, row)) return { error: 'You can look at this campaign, but you cannot change it.', status: 403 };
  const touch = (status, extra = '') => S.run(`UPDATE "OmniAppCampaign" SET status = ?, updatedAt = ?${extra} WHERE id = ?`, status, Date.now(), id);
  let said = '';
  if (action === 'pause') {
    if (row.status === 'scheduled') { await touch('paused'); said = 'Paused. It will not go out until you resume it.'; } else if (row.status === 'sending' && row.jobId) { Bulk.pauseJob(row.jobId); await touch('paused'); said = 'Paused after the message that is going now.'; } else return { error: 'Only a scheduled or running campaign can be paused.', status: 409 };
  } else if (action === 'resume') {
    if (row.status !== 'paused') return { error: 'This campaign is not paused.', status: 409 };
    if (row.jobId && row.mode === 'live') { await Bulk.resumeJob(row.jobId); await touch('sending'); said = 'Going on.'; } else { await touch('scheduled'); said = 'Scheduled again.'; }
  } else if (action === 'cancel') {
    if (['done', 'cancelled'].includes(row.status)) return { error: 'This campaign is already finished.', status: 409 };
    if (row.jobId && row.mode === 'live') {
      if (row.status === 'paused') Bulk.cancelPaused(row.jobId); else Bulk.cancelJob(row.jobId);
    }
    await S.run('UPDATE "OmniAppCampaignItem" SET status = \'skipped\', reason = \'Cancelled before sending\' WHERE campaignId = ? AND status = \'queued\'', id);
    await touch('cancelled', ', finishedAt = ' + Date.now());
    said = 'Cancelled. Nothing more will be sent.';
  } else return { error: 'Unknown action.', status: 400 };
  await logAudit({ userId: user.id, actorName: user.name, action: `App campaign ${action === 'cancel' ? 'cancelled' : (action === 'pause' ? 'paused' : 'resumed')}`, entity: 'OmniAppCampaign', entityId: id, toValue: said });
  return { ok: said, status: (await S.q('SELECT status FROM "OmniAppCampaign" WHERE id = ?', id))[0].status };
}
async function retryFailed(user, id) {
  const f = await rowFor(user, id);
  if (f.error) return f;
  const row = await sync(f.row);
  if (!canControl(user, row)) return { error: 'You can look at this campaign, but you cannot change it.', status: 403 };
  if (row.mode !== 'live' || !row.jobId) return { error: 'Only a real send has failed messages to try again.', status: 409 };
  const out = await Bulk.retryFailed(row.jobId, user);
  if (!out || out.error) return { error: (out && out.error) || 'The send was not found.', status: 409 };
  await S.run('UPDATE "OmniAppCampaign" SET status = \'sending\', finishedAt = NULL, updatedAt = ? WHERE id = ?', Date.now(), id);
  return { ok: `${out.retried} failed messages are being tried again.`, retried: out.retried };
}
async function remove(user, id) {
  const f = await rowFor(user, id);
  if (f.error) return f;
  if (f.row.status !== 'not_sent') return { error: 'Only a campaign that was never sent can be deleted. Cancel it instead.', status: 409 };
  if (!canControl(user, f.row)) return { error: 'You cannot delete this campaign.', status: 403 };
  await S.run('DELETE FROM "OmniAppCampaign" WHERE id = ?', id);
  await logAudit({ userId: user.id, actorName: user.name, action: 'App campaign deleted (never sent)', entity: 'OmniAppCampaign', entityId: id, toValue: f.row.name });
  return { ok: 'Deleted.' };
}

// ---- list / detail -----------------------------------------------------------------------------------------------------------------------------
async function list(user, { app = '', status = '', q = '' } = {}) {
  await Schema.ensure();
  const rows = await S.q('SELECT * FROM "OmniAppCampaign" ORDER BY createdAt DESC LIMIT 400');
  const st = { needsApproval: await needsApproval(user) };
  const mine = rows.filter((r) => canSee(user, r) && (!app || r.app === app));
  const out = [];
  for (const r0 of mine.slice(0, 200)) {
    const r = await sync(r0); // eslint-disable-line no-await-in-loop
    const v = view(user, r, await counts(r.id), st); // eslint-disable-line no-await-in-loop
    if (status && v.status !== status) continue; // eslint-disable-line no-continue
    if (q && !`${v.name} ${v.template} ${v.app} ${v.createdByName}`.toLowerCase().includes(String(q).toLowerCase())) continue; // eslint-disable-line no-continue
    out.push(v);
  }
  const waiting = out.filter((v) => v.status === 'waiting' && v.can.approve).length;
  return { campaigns: out, total: out.length, waiting, apps: Object.keys(APPS), statusWords: STATUS_WORDS };
}
async function waitingCount(user) {
  try { return (await list(user, { status: 'waiting' })).campaigns.filter((v) => v.can.approve).length; } catch { return 0; }
}
async function get(user, id, { page = 1, pageSize = 25, status = '' } = {}) {
  const f = await rowFor(user, id);
  if (f.error) return f;
  const row = await sync(f.row);
  const st = { needsApproval: await needsApproval(user) };
  const masked = ['bde', 'bdetl', 'recruiter'].includes(A.kind(user)) && row.audience === 'candidates';
  const size = Math.max(1, Math.min(100, Number(pageSize) || 25)); const pg = Math.max(1, Number(page) || 1);
  const where = status && ITEM_WORDS[status] ? 'campaignId = ? AND status = ?' : 'campaignId = ?';
  const params = status && ITEM_WORDS[status] ? [row.id, status] : [row.id];
  const total = num((await S.q(`SELECT COUNT(*) n FROM "OmniAppCampaignItem" WHERE ${where}`, ...params))[0].n);
  const items = await S.q(`SELECT * FROM "OmniAppCampaignItem" WHERE ${where} ORDER BY name, channel LIMIT ? OFFSET ?`, ...params, size, (pg - 1) * size);
  const audit = await prisma.auditLog.findMany({ where: { entity: 'OmniAppCampaign', entityId: row.id }, orderBy: { createdAt: 'desc' }, take: 30, select: { createdAt: true, actorName: true, action: true, toValue: true } }).catch(() => []);
  return {
    campaign: view(user, row, await counts(row.id), st),
    items: items.map((i) => ({ id: i.id, name: i.name, channel: i.channel, status: i.status, statusWords: ITEM_WORDS[i.status] || i.status, reason: i.reason || '', sentAt: i.sentAt ? S.iso(i.sentAt) : null, repliedAt: i.repliedAt ? S.iso(i.repliedAt) : null, entityId: masked ? undefined : i.entityId })),
    total, page: pg, pageSize: size, itemWords: ITEM_WORDS,
    activity: audit.map((a) => ({ at: a.createdAt, by: a.actorName || 'System', what: a.action, note: a.toValue || '' })),
  };
}

// ---- the loop: scheduled campaigns that are due, and live ones that need their rows updated ------------------------------------
let ticking = false;
async function tick() {
  if (ticking) return { skipped: true };
  ticking = true;
  const out = { started: 0, synced: 0, failed: 0 };
  try {
    await Schema.ensure();
    const { resolveIdentity } = require('../../utils/identity'); // eslint-disable-line global-require
    const due = await S.q('SELECT * FROM "OmniAppCampaign" WHERE status = \'scheduled\' AND scheduledAt <= ? ORDER BY scheduledAt LIMIT 20', Date.now());
    for (const row of due) {
      let creator = null;
      try { creator = await resolveIdentity(row.createdById); } catch { creator = null; } // eslint-disable-line no-await-in-loop
      if (!creator) { await S.run('UPDATE "OmniAppCampaign" SET status = \'not_sent\', meta = ?, updatedAt = ? WHERE id = ?', JSON.stringify({ lastError: 'The person who made this campaign can no longer sign in.' }), Date.now(), row.id); out.failed += 1; continue; } // eslint-disable-line no-await-in-loop, no-continue
      const r = await launch(creator, row); // eslint-disable-line no-await-in-loop
      if (r.error) out.failed += 1; else out.started += 1;
    }
    const live = await S.q('SELECT * FROM "OmniAppCampaign" WHERE mode = \'live\' AND status IN (\'sending\',\'paused\')');
    for (const row of live) { await sync(row); out.synced += 1; } // eslint-disable-line no-await-in-loop
  } catch (e) { console.error('[omni-app-campaigns] tick:', e.message); } // eslint-disable-line no-console
  finally { ticking = false; }
  return out;
}
let timer = null;
function start() {
  if (timer || process.env.OMNI_APP_CAMPAIGN_MS === '0') return;
  try { if (require('../../utils/sandbox').isSandbox()) return; } catch { /* not a sandbox */ } // eslint-disable-line global-require
  timer = setInterval(() => { tick().catch(() => {}); }, Number(process.env.OMNI_APP_CAMPAIGN_MS || 30000));
  if (timer.unref) timer.unref();
}

module.exports = { APPS, STATUS_WORDS, ITEM_WORDS, preview, create, update, submit, decide, send, control, retryFailed, remove, list, get, tick, start, canSee, waitingCount, check, clean };
