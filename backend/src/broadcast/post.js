// ---------------------------------------------------------------------------
// POST TO ALL SELECTED PLACES: one action over the existing channels. Nothing here posts by itself and nothing is
// faked: every place answers with what really happened (queued / posted / needs your help / not connected / failed).
//   naukri, foundit, shine, linkedin(by hand), career   -> the publishing module (jobPublish/service.publish), which keeps
//                                                         its own queue, safety limits and by-hand tasks
//   indeed, google, website, jobportal                  -> the job feeds (utils/jobPosting.js): ticked on the job; the
//                                                         board reads the feed once the feed is registered with it
//   whatsapp                                            -> a campaign to a contact list (broadcast/campaign.js)
//   email                                               -> not built yet; says so
// The text is the SAME everywhere: the ready template version in use is saved first (broadcast/template.js useVersion).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const A = require('./access');
const T = require('./template');
const C = require('./campaign');
const { logAudit } = require('../utils/audit');

const PUBLISH = ['naukri', 'foundit', 'shine', 'linkedin', 'career', 'telegram', 'facebook']; // telegram / facebook: official API posts, OFF until an Admin switches them on (job distribution 2026-10-14)
const FEEDS = ['indeed', 'google', 'website', 'jobportal'];
const NAMES = { naukri: 'Naukri', foundit: 'Foundit', shine: 'Shine', linkedin: 'LinkedIn (by hand)', career: 'Careers page', telegram: 'Telegram channel', facebook: 'Facebook page', indeed: 'Indeed', google: 'Google Jobs', website: 'Website', jobportal: 'Job Portal', whatsapp: 'WhatsApp contacts', email: 'Email list' };
const PLACES = ['naukri', 'indeed', 'shine', 'foundit', 'linkedin', 'career', 'telegram', 'facebook', 'google', 'whatsapp', 'email'];

function fromPublishRow(row) {
  const base = { place: row.portal, name: NAMES[row.portal] || row.name };
  if (row.mode === 'queued') {
    const done = row.entry && row.entry.status === 'SUCCEEDED';
    return { ...base, state: done ? 'posted' : 'queued', words: done ? 'Posted' : 'Queued: waiting for its turn', queueId: row.queueId || null, detail: row.reason };
  }
  if (row.mode === 'already') return { ...base, state: 'posted', words: 'Already live', detail: row.reason };
  if (row.mode === 'by_hand') {
    const notConnected = /no .* login is saved|switched off|sign-in .* failed/i.test(row.reason || '');
    return { ...base, state: notConnected ? 'not_connected' : 'needs_help', words: notConnected ? 'Not connected: set up in Integrations' : 'Needs your help: post it by hand', detail: row.reason, handPath: row.handPath || null };
  }
  if (row.mode === 'refused' && /switched off|details are saved|token failed/i.test(row.reason || '')) return { ...base, state: 'not_connected', words: 'Not connected: an Admin sets it up in Integrations, Job portals', detail: row.reason };
  return { ...base, state: 'failed', words: 'Not posted', detail: row.reason, retry: false };
}

async function tickFeeds(user, r, wanted) {
  const posting = require('../utils/jobPosting'); // eslint-disable-line global-require
  const have = posting.tickedSites(r);
  const ids = [...new Set([...have, ...wanted])];
  const value = posting.postingSourcesFor(r, ids);
  await prisma.requirement.update({ where: { id: r.id }, data: { postingSources: value } });
  await posting.autoPost(r.id, { actorId: user.id, actorName: user.name, trigger: 'retry', sourceTrigger: 'post', background: true }).catch(() => null);
}

async function postEverywhere(user, jobId, body = {}, base = '') {
  const r = await prisma.requirement.findUnique({ where: { id: String(jobId) }, include: { client: true } });
  if (!r) return { error: 'Requirement not found.', status: 404 };
  const access = require('../jobPublish/access'); // eslint-disable-line global-require
  if (!access.inScope(user, r)) return { error: 'This requirement is not in your area.', status: 403 };
  if (!(await A.mayPostJob(user, r))) return { error: 'Posting requirements is done by your team lead or the client manager.', code: 'POSTING_NOT_YOURS', status: 403 };
  const places = [...new Set((body.places || []).map(String))].filter((p) => PLACES.includes(p));
  if (!places.length) return { error: 'Tick at least one place to post to.', status: 400 };
  // 1. the text: the version in use (or the newest) is the one everyone gets
  const { version } = await T.ensure(user, r, base);
  const used = await T.useVersion(user, r, version.v);
  if (used.error) return used;
  const results = [];
  // 2. the publishing module
  const portals = places.filter((p) => PUBLISH.includes(p));
  if (portals.length) {
    const svc = require('../jobPublish/service'); // eslint-disable-line global-require
    const { supported } = require('../jobPublish/db'); // eslint-disable-line global-require
    if (!(await supported())) portals.forEach((p) => results.push({ place: p, name: NAMES[p], state: 'not_available', words: 'Not available yet: the posting tables are not set up on this server.' }));
    else {
      const out = await svc.publish(user, r.id, portals, { dryRun: !!body.dryRun }); // dryRun: the posting worker only checks the sign-in and the form, nothing is posted
      if (out.error) portals.forEach((p) => results.push({ place: p, name: NAMES[p], state: 'failed', words: out.error }));
      else out.results.forEach((row) => results.push(fromPublishRow(row)));
    }
  }
  // 3. the feeds
  const feeds = places.filter((p) => FEEDS.includes(p));
  if (feeds.length && body.dryRun) feeds.forEach((p) => results.push({ place: p, name: NAMES[p], state: 'not_available', words: 'Dry run: this site was not touched.' }));
  else if (feeds.length) {
    const live = ['OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE'].includes(r.status);
    if (!live) feeds.forEach((p) => results.push({ place: p, name: NAMES[p], state: 'failed', words: 'This requirement is not open yet, so it is not put in the feed.' }));
    else if (r.internal && feeds.some((p) => p === 'indeed' || p === 'google')) feeds.forEach((p) => results.push({ place: p, name: NAMES[p], state: 'failed', words: 'TeamLink internal hiring stays on the careers page.' }));
    else {
      await tickFeeds(user, r, feeds);
      feeds.forEach((p) => results.push({ place: p, name: NAMES[p], state: 'feed', words: p === 'indeed' || p === 'google' ? 'In our job feed: the board shows it once the feed is registered in its employer account' : 'Live on our own page' }));
    }
  }
  // 4. WhatsApp contacts: a campaign to a list
  if (places.includes('whatsapp')) {
    if (!body.listId) results.push({ place: 'whatsapp', name: NAMES.whatsapp, state: 'needs_help', words: 'Choose a contact list to send this requirement to.' });
    else {
      const made = await C.create(user, body.listId, r.id, body.campaign || {}, base);
      if (made.error) results.push({ place: 'whatsapp', name: NAMES.whatsapp, state: 'failed', words: made.error });
      else {
        const started = await C.start(user, made.campaign.id);
        if (started.error) results.push({ place: 'whatsapp', name: NAMES.whatsapp, state: 'needs_help', words: `Ready but not started: ${started.error}`, campaignId: made.campaign.id });
        else results.push({ place: 'whatsapp', name: NAMES.whatsapp, state: started.campaign.status === 'SCHEDULED' ? 'queued' : 'running', words: started.campaign.status === 'SCHEDULED' ? 'Scheduled' : 'Sending to the list', campaignId: made.campaign.id });
      }
    }
  }
  if (places.includes('email')) results.push({ place: 'email', name: NAMES.email, state: 'not_available', words: 'Not available yet: email lists are not built. The email text is ready to copy.' });
  await logAudit({ userId: user.id, actorName: user.name, action: 'Post to all selected places', entity: 'Requirement', entityId: r.id, toValue: results.map((x) => `${x.name}: ${x.state}`).join('; ').slice(0, 480) });
  return { requirementId: r.id, version: version.v, results };
}

const CHIP = { PUBLISHED: 'posted', QUEUED: 'queued', FAILED: 'failed', NEEDS_CHECK: 'needs_help', DRAFT: 'idle', UNPUBLISHED: 'idle', EXPIRED: 'failed' };
// live status chips for the job
async function status(user, jobId) {
  const r = await prisma.requirement.findUnique({ where: { id: String(jobId) } });
  if (!r) return { error: 'Requirement not found.', status: 404 };
  const access = require('../jobPublish/access'); // eslint-disable-line global-require
  if (!access.inScope(user, r)) return { error: 'This requirement is not in your area.', status: 403 };
  const chips = [];
  try {
    const { supported } = require('../jobPublish/db'); // eslint-disable-line global-require
    if (await supported()) {
      const js = await require('../jobPublish/service').jobStatus(user, r); // eslint-disable-line global-require
      (js.portals || []).forEach((p) => {
        const q = p.lastQueue || null;
        let state = CHIP[p.status] || 'idle';
        if (q && q.status === 'RUNNING') state = 'running';
        if (q && ['NEEDS_HUMAN'].includes(q.status)) state = 'needs_help';
        if (p.waitingForPerson) state = 'needs_help';
        if (p.mode === 'by_hand' && state !== 'posted') state = state === 'idle' ? 'idle' : 'needs_help';
        chips.push({ place: p.portal, name: NAMES[p.portal] || p.portalName, state, words: p.statusWords, link: p.portalUrl || null, error: p.lastError || null, queueId: q ? q.id : null, canRetry: !!p.canRetry, mode: p.mode });
      });
    }
  } catch { /* the publishing module is optional here */ }
  const camps = await C.listCampaigns(user, { jobId: r.id });
  camps.forEach((c) => chips.push({ place: 'whatsapp', name: `WhatsApp: ${c.listName}`, state: ['RUNNING'].includes(c.status) ? 'running' : c.status === 'DONE' ? 'posted' : ['SCHEDULED', 'DRAFT'].includes(c.status) ? 'queued' : c.status === 'PAUSED' ? 'needs_help' : 'idle', words: `${c.status.toLowerCase()} · ${c.sent} sent of ${c.total}`, campaignId: c.id, replies: c.replies }));
  return { requirementId: r.id, chips };
}

module.exports = { postEverywhere, status, PLACES, NAMES };
