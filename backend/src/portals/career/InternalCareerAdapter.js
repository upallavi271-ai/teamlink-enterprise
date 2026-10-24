// ---------------------------------------------------------------------------
// INTERNAL CAREER PORTAL adapter: TeamLink's own public careers page (and the Job Portal behind it).
//
// NO BROWSER, NO LOGIN. Publishing here is what already exists:
//   publish    the job is ticked for the Job Portal + Website, set live (portalPublished) through utils/jobPosting.js, and
//              each of those sites is checked by its own connector (utils/jobConnectors.js). "Published" only when the
//              career page's own public list really shows the job (the connector fetches it back).
//   unpublish  the same as "Unpublish" in the Job Portal workspace: portalPublished off, the Job Portal told to close it.
//   update     the same as publish (the page is rebuilt from the job).
// Everything keeps going through the existing audit rows, so the job page's "Posted on" panel stays truthful.
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const { logAudit } = require('../../utils/audit');
const { PORTALS } = require('../../jobPublish/constants');

class InternalCareerAdapter {
  constructor({ portal = 'career', log, ctx = {} } = {}) { this.portal = portal; this.log = log; this.ctx = ctx; this.meta = PORTALS.career; }

  static get meta() { return { ...PORTALS.career, inline: true }; }

  async health() { return { portal: 'career', settingsOk: true, settingsProblems: [], browserFound: null, sessionSaved: false, note: 'No browser or sign-in needed.' }; }

  async run(action, job = {}, ctx = {}) {
    this.ctx = ctx;
    const posting = require('../../utils/jobPosting'); // eslint-disable-line global-require
    const connectors = require('../../utils/jobConnectors'); // eslint-disable-line global-require
    const id = ctx.requirementId;
    const actor = { actorId: ctx.actor && ctx.actor.id, actorName: ctx.actor && ctx.actor.name };
    try {
      if (action === 'VERIFY') return { ok: true, verified: true, note: 'The career page needs no sign-in.', screenshots: [] };
      let r = await prisma.requirement.findUnique({ where: { id } });
      if (!r) return { ok: false, code: 'JOB_NOT_LIVE', reason: 'This job no longer exists.', retryable: false, needsHuman: false, screenshots: [] };
      if (ctx.dryRun) {
        await this.log.info('dry-run', 'DRY RUN: the career page needs no form. Nothing was changed.');
        return { ok: true, dryRun: true, note: 'DRY RUN: nothing was changed', screenshots: [] };
      }
      if (action === 'UNPUBLISH') {
        await prisma.requirement.update({ where: { id }, data: { portalPublished: false, portalUnpublishedAt: new Date(), portalSyncStatus: 'Not Synced' } });
        await logAudit({
          userId: actor.actorId || null, actorName: actor.actorName || null, action: 'Requirement unpublished from job portal', entity: 'Requirement', entityId: id, fromValue: 'Published', toValue: 'Not published',
        });
        await require('../../utils/jobPortalBridge').pushRequirement(id); // eslint-disable-line global-require
        await connectors.syncAll(id, { ...actor, trigger: 'post', only: ['jobportal', 'website', 'google'] });
        const rows = await connectors.rowsOf(id);
        const web = rows.find((x) => x.source === 'website');
        const gone = !web || ['Removed', 'Failed'].includes(web.status);
        await this.log.info('unpublish', gone ? 'The job is off the career page' : `The career page still shows it (${web.status})`);
        return gone ? { ok: true, confirmed: true, verified: true, screenshots: [] }
          : { ok: false, code: 'UNEXPECTED', reason: 'The career page still lists the job. Try again.', retryable: true, needsHuman: false, screenshots: [] };
      }
      // PUBLISH / REPUBLISH / UPDATE: tick the two own sites, set live, check each one fetches the job back
      const ticked = posting.tickedSites(r);
      const want = [...new Set([...ticked, 'jobportal', 'website'])];
      if (want.length !== ticked.length) {
        r = await prisma.requirement.update({ where: { id }, data: { postingSources: posting.postingSourcesFor(r, want) } });
        await logAudit({
          userId: actor.actorId || null, actorName: actor.actorName || null, action: 'Job posting sites changed', entity: 'Requirement', entityId: id, fromValue: ticked.join(', ') || 'None', toValue: want.join(', '),
        });
      }
      await posting.autoPost(id, { ...actor, trigger: 'retry', skipSources: true });
      await connectors.retry(id, { ...actor, trigger: 'post' }, 'website');
      await connectors.retry(id, { ...actor, trigger: 'post' }, 'jobportal');
      const rows = await connectors.rowsOf(id);
      const web = rows.find((x) => x.source === 'website');
      const portal = rows.find((x) => x.source === 'jobportal');
      await this.log.info('career', `Website: ${web ? web.status : 'no row'}; Job Portal: ${portal ? portal.status : 'no row'}`);
      if (web && web.status === 'Posted') {
        return {
          ok: true,
          verified: true,
          confirmed: true,
          portalJobId: web.externalJobId || r.reqCode || id,
          portalUrl: web.externalUrl || (portal && portal.externalUrl) || null,
          note: `Website live. Job Portal: ${portal ? portal.status : 'not checked'}.`,
          screenshots: [],
        };
      }
      return {
        ok: false,
        code: 'UNVERIFIED',
        needsHuman: true,
        retryable: false,
        screenshots: [],
        reason: `The career page does not list the job yet (${web ? web.errorMessage || web.status : 'no answer'}).`,
      };
    } catch (err) {
      return {
        ok: false, code: 'UNEXPECTED', reason: `Something went wrong on the career page: ${String(err.message).split('\n')[0].slice(0, 160)}`, retryable: true, needsHuman: false, screenshots: [],
      };
    }
  }
}
module.exports = InternalCareerAdapter;
