// ---------------------------------------------------------------------------
// JOINED HERE = NOT SELECTED ANYWHERE ELSE (founder 2026-11-28: "kontha mandhi already join ayaru, drop ayyaru, dashboard lo update
// ayayindhi, kaani ikkada update avaledhu ... oka candidate ey step ki move ayina, adhi annitlo update avvali ... duplicates
// vundakudadhu").
//
// When a person is moved to Joined on one requirement, any OTHER application of theirs still waiting at Selected / Offer /
// Offer accepted - selected before that joining - is closed: Rejected, by the candidate, "Joined another requirement" (with which
// one and when), its open follow-ups completed. So the person shows once, as Joined, on every screen (pipeline tabs, dashboard,
// reports). A selection made AFTER the joining (a new placement later) is never touched. Wired as a save hook in db.js, so every
// path that marks someone Joined (the step move, the joining form, an import) does it.
// ---------------------------------------------------------------------------
const WAITING = ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'];
const ACTOR = 'TeamLink (joined another requirement)';
const istDay = (v) => { const t = v ? new Date(v).getTime() : Date.now(); return new Date(t + 330 * 60000).toISOString().slice(0, 10); };
let running = false;

async function closeOthersOnJoin(prisma, joinedAppId, { dryRun = false } = {}) {
  const app = await prisma.application.findUnique({
    where: { id: joinedAppId },
    select: { id: true, candidateId: true, stage: true, joiningDate: true, joinedAt: true, requirement: { select: { reqCode: true, title: true, client: { select: { name: true } } } } },
  });
  if (!app || !['JOINED', 'HIRED'].includes(app.stage)) return [];
  const joinDay = /^\d{4}-\d{2}-\d{2}$/.test(String(app.joiningDate || '')) ? app.joiningDate : istDay(app.joinedAt);
  const others = await prisma.application.findMany({
    where: { candidateId: app.candidateId, id: { not: app.id }, stage: { in: WAITING } },
    select: { id: true, candidateId: true, stage: true, requirementId: true, updatedAt: true, requirement: { select: { title: true, clientId: true, client: { select: { name: true } } } }, stageEvents: { where: { toStage: { in: WAITING } }, orderBy: { createdAt: 'asc' }, take: 1, select: { createdAt: true } } },
  });
  const where = [app.requirement && app.requirement.client && app.requirement.client.name, app.requirement && (app.requirement.reqCode || app.requirement.title)].filter(Boolean).join(' · ');
  const closed = [];
  for (const o of others) {
    const selDay = istDay((o.stageEvents[0] && o.stageEvents[0].createdAt) || o.updatedAt);
    if (selDay > joinDay) continue; // selected after this joining: a new placement, left alone
    closed.push({ id: o.id, from: o.stage, selDay });
    if (dryRun) continue;
    const why = `Joined ${where || 'another requirement'} on ${joinDay}`;
    // eslint-disable-next-line no-await-in-loop
    await prisma.application.update({ where: { id: o.id }, data: { stage: 'REJECTED' } });
    // eslint-disable-next-line no-await-in-loop
    await prisma.applicationStageEvent.create({
      data: {
        applicationId: o.id, candidateId: o.candidateId, fromStage: o.stage, toStage: 'REJECTED', action: 'Closed: joined another requirement',
        comment: why, actorName: ACTOR, actorRole: 'System', actorSide: 'Candidate', reasonCategory: 'Joined elsewhere', reasonDetail: why,
        requirementId: o.requirementId, requirementTitle: o.requirement ? o.requirement.title : null,
        clientId: o.requirement ? o.requirement.clientId : null, clientName: o.requirement && o.requirement.client ? o.requirement.client.name : null,
      },
    });
    // its open follow-ups done (one by one: an import batch can still be undone)
    // eslint-disable-next-line no-await-in-loop
    const open = await prisma.applicationFollowUp.findMany({ where: { applicationId: o.id, completedAt: null }, select: { id: true } });
    for (const f of open) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.applicationFollowUp.update({ where: { id: f.id }, data: { completedAt: new Date(), completedNote: `Closed: ${why}` } });
    }
  }
  return closed;
}

// the save hook (db.js): after an Application is written with stage Joined. Never throws, never blocks the save.
function hook(prisma) {
  prisma.$use(async (params, next) => {
    const result = await next(params);
    if (params.model !== 'Application' || !['update', 'upsert', 'create'].includes(params.action) || running) return result;
    const data = params.action === 'upsert' ? { ...(params.args.create || {}), ...(params.args.update || {}) } : (params.args && params.args.data) || {};
    const st = data.stage && typeof data.stage === 'object' ? data.stage.set : data.stage;
    if (!['JOINED', 'HIRED'].includes(st) || !result || !result.id) return result;
    running = true; // its own writes (Rejected) never come back here
    try {
      await closeOthersOnJoin(prisma, result.id);
    } catch (err) {
      console.error('[joined-elsewhere]', err && err.message); // eslint-disable-line no-console
    } finally { running = false; }
    return result;
  });
}

module.exports = { closeOthersOnJoin, hook, WAITING };
