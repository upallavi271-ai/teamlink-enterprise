// ---------------------------------------------------------------------------
// CAMPAIGN APPROVAL (2026-10-17, Omni-Channel > Campaigns > "Publish after approval").
//   switch   policy.approval().required: an Admin switch (Configuration, default OFF). ON = a campaign made by a BDE (access kind 'bde') needs a Team Lead /
//            BDE TL / Admin (A.has('mayApprove')) to approve it before it can be sent. OFF = nobody has to; a wizard user may still ask for approval.
//   column   OutreachCampaign.approval (on every channel row of a master campaign): null | 'waiting' | 'approved' | 'changes'.
//            The campaign STATUS stays 'draft' ("Not sent yet"): the screens say "Waiting for approval" / "Changes needed" from this column.
//   flow     creator -> submit (waiting; the approvers get a bell notice) -> approve (the creator gets a notice: now press Send) | reject with a note (the creator
//            gets the note, status "Changes needed", can edit and submit again). Approving does NOT send by itself: nothing goes out unless a person presses Send.
//   who      approvers are people with mayApprove who can SEE the campaign (a Team Lead only for jobs in their own area). Nobody approves their own BDE's
//            campaign outside their area. Admins see everything.
// Notices carry the campaign NAME only (never a phone or an email). Audit rows: ids and words.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const S = require('./store');
const A = require('./access');
const Act = require('./campaignActivity');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');

const STATES = { waiting: 'Waiting for approval', approved: 'Approved', changes: 'Changes needed' };
const isTestUser = (u) => /zztest|example\.test/i.test(`${u.name || ''} ${u.email || ''}`);
const Camp = () => require('./campaigns'); // eslint-disable-line global-require
const stateOf = (row) => (STATES[row && row.approval] ? row.approval : null);

async function required() { try { return (await require('./policy').approval()).required === true; } catch { return false; } } // eslint-disable-line global-require
// does a campaign made by this login need approval before Send?
async function needsApproval(user) { return A.kind(user) === 'bde' && (await required()); }

// null = may send; else the plain sentence why not (used by campaigns.send)
async function blocksSend(user, row) {
  const st = stateOf(row);
  if (st === 'waiting') return 'This campaign is waiting for approval from a Team Lead. It can be sent once it is approved.';
  if (st === 'changes') return 'A reviewer asked for changes. Change the campaign, then ask for approval again.';
  if (st !== 'approved' && (await needsApproval(user))) return 'This campaign needs a Team Lead\'s approval before it can be sent. Press "Ask for approval".';
  return null;
}

// the people who may approve this campaign (and can see it): ids
async function approverIds(row) {
  const out = [];
  try {
    const { resolveIdentity } = require('../utils/identity'); // eslint-disable-line global-require
    const users = await prisma.user.findMany({ where: { status: 'Active', OR: [{ role: { in: ['SUPER_ADMIN', 'ADMIN', 'TL', 'STL'] } }, { atsRole: { in: ['SUPER_ADMIN', 'ADMIN', 'TL', 'STL'] } }] }, select: { id: true, name: true, email: true } });
    const reqs = await Camp().reqRows([row.requirementId]);
    for (const u of users.filter((x) => !isTestUser(x))) {
      let ident = null; try { ident = await resolveIdentity(u.id); } catch { ident = null; } // eslint-disable-line no-await-in-loop
      if (ident && A.has('mayApprove')(ident) && Camp().canSee(ident, row, reqs)) out.push(u.id);
    }
  } catch { /* the notice is a courtesy */ }
  return out;
}

const first = (rows) => rows[0];
async function groupFor(user, id) {
  const rows = await Camp().groupRows(id);
  if (!rows.length) return { error: 'This campaign was not found.', status: 404 };
  const reqs = await Camp().reqRows(rows.map((r) => r.requirementId));
  const vis = rows.filter((r) => Camp().canSee(user, r, reqs));
  if (!vis.length) return { error: 'This campaign was not found.', status: 404 };
  return { rows: vis, reqs };
}
const setApproval = async (rows, state, patch, by) => {
  for (const r of rows) {
    await S.run('UPDATE "OutreachCampaign" SET approval = ?, updatedAt = ? WHERE id = ? AND status = \'draft\'', state, Date.now(), r.id); // eslint-disable-line no-await-in-loop
    await Camp().patchMeta(r.id, { approvalInfo: { state, ...patch, byName: by ? S.clip(by.name, 80) : '', at: Date.now() } }); // eslint-disable-line no-await-in-loop
  }
};

// the creator (or somebody who controls it) asks for approval
async function submit(user, id) {
  const g = await groupFor(user, id);
  if (g.error) return g;
  const head = first(g.rows);
  if (!(await Camp().canControl(user, head, g.reqs))) return { error: 'You can look at this campaign, but you cannot ask for approval for it.', status: 403 };
  if (g.rows.some((r) => r.status !== 'draft')) return { error: 'This campaign was already sent.', status: 409 };
  if (stateOf(head) === 'waiting') return { error: 'It is already waiting for approval.', status: 409 };
  await setApproval(g.rows, 'waiting', { note: '' }, user);
  const ids = (await approverIds(head)).filter((x) => x !== user.id);
  const name = S.clip(metaName(head), 60);
  if (ids.length) await notifyUsers(ids, { title: `Campaign "${name}" needs your approval`, message: `${S.clip(user.name, 60)} asked for approval. Open Campaigns > Waiting for approval.` });
  await Act.log(head, 'submitted', `${S.clip(user.name, 60)} asked for approval.`, user);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Outreach campaign: approval asked', entity: 'OutreachCampaign', entityId: head.id, toValue: `${g.rows.length} channel(s); ${ids.length} approver(s) told` });
  return { ok: 'Sent for approval. A Team Lead will look at it.', approvers: ids.length, approval: 'waiting' };
}
const metaName = (row) => { const m = S.parse(row.meta, {}); return (m && m.groupName) || row.name; };

async function decide(user, id, approve, note) {
  if (!A.has('mayApprove')(user)) return { error: 'Only a Team Lead, a BDE TL or an Admin can approve a campaign.', status: 403 };
  const g = await groupFor(user, id);
  if (g.error) return g;
  const head = first(g.rows);
  if (stateOf(head) !== 'waiting') return { error: 'This campaign is not waiting for approval.', status: 409 };
  if (g.rows.some((r) => r.status !== 'draft')) return { error: 'This campaign was already sent.', status: 409 };
  const words = S.clip(note, 300);
  if (!approve && words.length < 5) return { error: 'Write a few words so the person knows what to change.', status: 400 };
  await setApproval(g.rows, approve ? 'approved' : 'changes', { note: words }, user);
  const name = S.clip(metaName(head), 60);
  if (head.createdById && head.createdById !== user.id) {
    await notifyUsers([head.createdById], approve
      ? { title: `Campaign "${name}" was approved`, message: `${S.clip(user.name, 60)} approved it${words ? `: ${words}` : ''}. You can press Send now.` }
      : { title: `Campaign "${name}" needs changes`, message: `${S.clip(user.name, 60)} sent it back: ${words}` });
  }
  await Act.log(head, approve ? 'approved' : 'changes', approve ? `Approved by ${S.clip(user.name, 60)}${words ? `: ${words}` : ''}.` : `Sent back by ${S.clip(user.name, 60)}: ${words}`, user);
  await logAudit({ userId: user.id, actorName: user.name, action: approve ? 'Outreach campaign approved' : 'Outreach campaign sent back', entity: 'OutreachCampaign', entityId: head.id, toValue: approve ? 'approved' : 'changes needed' });
  return { ok: approve ? 'Approved. The person who made it can press Send.' : 'Sent back with your note.', approval: approve ? 'approved' : 'changes' };
}
const approve = (user, id, note) => decide(user, id, true, note);
const reject = (user, id, note) => decide(user, id, false, note);

// campaigns (master campaigns, not channel rows) waiting for THIS login to approve, newest first
async function pendingList(user) {
  if (!A.has('mayApprove')(user)) return [];
  const rows = await S.q('SELECT * FROM "OutreachCampaign" WHERE approval = \'waiting\' AND status = \'draft\' ORDER BY createdAt DESC');
  if (!rows.length) return [];
  const reqs = await Camp().reqRows(rows.map((r) => r.requirementId));
  const seen = new Set(); const out = [];
  rows.filter((r) => Camp().canSee(user, r, reqs)).forEach((r) => {
    const gid = S.parse(r.meta, {}).groupId || r.id;
    if (seen.has(gid)) return;
    seen.add(gid);
    out.push({ id: gid, name: metaName(r), createdByName: r.createdByName || '', createdAt: S.iso(r.createdAt) });
  });
  return out;
}
// the number on the sidebar badge (chrome.js badges)
async function pendingCount(user) {
  try { if (!(await S.campaignsReady())) return 0; await require('./v3schema').ensure(); return (await pendingList(user)).length; } catch { return 0; } // eslint-disable-line global-require
}

module.exports = { STATES, stateOf, required, needsApproval, blocksSend, approverIds, submit, approve, reject, pendingList, pendingCount };
