// ---------------------------------------------------------------------------
// AI MARKETING > THE FIRST OPTIONS, MADE BY ITSELF (2026-11-21). Owner: "the client gives a project, our AI makes the picture as per the request, and the work goes to the client by itself".
// When a client SENDS a request (marketing/projects.js publicSubmitRequest) and an Admin chose "make the first options by itself" in AI Marketing > AI usage (settings.autoMake):
//   1 plan     the same writer as "Create from a prompt" (autostudio.plan) turns the client's occasion + brief into the post words and up to three scenes
//   2 make     one picture per scene with AI Images (the same limits, the client's logo and colours; a failed picture is skipped, none at all = stop)
//   3 accept   the request is accepted (the client is told, as when a person accepts it)
//   4 options  the pictures become the project's options
//   5 send     only when autoMake is 'send' AND the site's https address is known: the options go to the client exactly as a person's "Send" does (sendApproval); otherwise they wait for the team,
//              who is told in the bell
// Safety: OFF by default. PICTURES ONLY: a request for a video is left to the team (videos are put together in a person's browser). Nothing is posted: the client still chooses (that IS the approval)
// and posting keeps its own switch. Everything is on the project's timeline and in the audit log; the AI limits of the person it runs as are used. Any failure leaves the request as it was, writes
// the reason on the timeline and tells the team: the client already has "we have your request", so they never wait on a silent failure.
// Runs as the project's owner or starter if they may use AI Marketing, else the oldest active Admin. One request at a time (a queue in this process).
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const Cfg = require('./settings');
const { logAudit } = require('../utils/audit');

const T = 'OmniMkProject';
const OPTIONS = 3; // pictures made = options to choose from (a "post" plan has up to three scenes)
const TRIES = 4; const WAIT_MS = 15000; // another picture job of the same person, or the 4-a-minute limit: wait and try again
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const why = (x) => S.clip(String((x && (x.error || x.message)) || x || 'It did not work.'), 300);
const busy = (x) => !!x && (x.code === 'busy' || /Too many picture requests/i.test(String(x.error || '')));

let chain = Promise.resolve(); // one automatic request at a time: the same person cannot run two picture jobs together

// who the automatic steps run as: the person who owns or started the project (if they may use AI Marketing), else the oldest active Admin
async function actorFor(r) {
  const prisma = require('../db'); // eslint-disable-line global-require
  const A = require('../outreach/access'); // eslint-disable-line global-require
  await A.warm();
  const pick = { id: true, name: true, email: true, role: true, atsRole: true };
  for (const id of [r.ownerId, r.createdById].filter(Boolean)) {
    const u = await prisma.user.findFirst({ where: { id, status: 'Active' }, select: pick }).catch(() => null); // eslint-disable-line no-await-in-loop
    if (u && A.has('mayAiMarketing')(u)) return u;
  }
  return prisma.user.findFirst({ where: { status: 'Active', OR: [{ role: { in: ['SUPER_ADMIN', 'ADMIN'] } }, { atsRole: { in: ['SUPER_ADMIN', 'ADMIN'] } }] }, orderBy: { createdAt: 'asc' }, select: pick }).catch(() => null);
}

async function makeOne(Img, u, body) {
  let out = null;
  for (let i = 0; i < TRIES; i += 1) {
    out = await Img.create(u, body, { wait: true }); // eslint-disable-line no-await-in-loop
    if (!busy(out)) return out;
    await sleep(WAIT_MS); // eslint-disable-line no-await-in-loop
  }
  return out;
}

async function work(projectId) {
  const set = await Cfg.getSettings();
  const mode = set.autoMake;
  if (mode !== 'options' && mode !== 'send') return { skipped: 'off' };
  const P = require('./projects'); // eslint-disable-line global-require
  await P.ensure();
  const r = (await S.q(`SELECT * FROM "${T}" WHERE id = ? AND deletedAt IS NULL`, String(projectId || '')))[0];
  if (!r || r.status !== 'request') return { skipped: 'not a new request' };
  if (r.deliverable === 'video') {
    await P.event(r.id, 'auto_skipped', 'Automatic', 'The client asked for a video: the team makes videos, so nothing was made by itself.');
    return { skipped: 'video' };
  }
  const fail = async (reason) => {
    await P.event(r.id, 'auto_failed', 'Automatic', `The first options could not be made by themselves: ${reason}`);
    await P.tellTeam(r, `Automatic pictures need you: "${S.clip(r.title, 60)}"`, `${reason} Open Client projects and make them by hand.`);
    return { error: reason };
  };
  try {
    const u = await actorFor(r);
    if (!u) return await fail('there is no active Admin to run it as.');
    const AS = require('./autostudio'); // eslint-disable-line global-require
    const Img = require('./images'); // eslint-disable-line global-require
    const planned = await AS.plan(u, { prompt: `${r.occasion}. ${r.brief}`, kind: 'post', scenes: OPTIONS, date: r.dueDate || '', projectId: r.id });
    if (planned.error) return await fail(why(planned));
    const p = planned.plan;

    const ids = []; let last = '';
    for (let i = 0; i < p.scenes.length && ids.length < OPTIONS; i += 1) {
      const sc = p.scenes[i];
      const made = await makeOne(Img, u, { prompt: sc.imagePrompt, headline: sc.caption || p.headline, aspect: '1:1', style: 'photo', count: 1, withLogo: !!r.logoData, title: `${p.title} ${i + 1}`, projectId: r.id }); // eslint-disable-line no-await-in-loop
      if (made.error) { last = why(made); if (made.status === 503 || made.status === 403) break; continue; } // not ready / not allowed: the next scene would fail the same way
      if (made.items && made.items[0]) ids.push(made.items[0].id);
    }
    if (!ids.length) return await fail(last || 'No picture came back.');

    const base = P.siteFor('');
    const acc = await P.accept(u, r.id, base);
    if (acc.error) { // somebody took the request while the pictures were being made: the pictures stay in the project's drafts
      await P.event(r.id, 'auto_stopped', 'Automatic', `The pictures are made and kept in Drafts, but the request was already handled by the team (${why(acc)})`);
      return { skipped: 'taken' };
    }
    const opt = await P.setOptions(u, r.id, { items: ids.map((itemId) => ({ itemId })) });
    if (opt.error) return await fail(why(opt));
    await P.event(r.id, 'auto_made', 'Automatic', `${ids.length} picture option${ids.length === 1 ? '' : 's'} made by TeamLink from the client's request${p.language ? ` (${p.language})` : ''}`);
    await logAudit({ userId: u.id, actorName: `Automatic (${S.clip(u.name, 60)})`, action: 'Omni-Channel AI Marketing: first picture options made by themselves', entity: T, entityId: r.id, toValue: `${r.clientName}: ${ids.length} option(s); ${mode === 'send' && base ? 'sent to the client' : 'waiting for the team'}` });

    if (mode === 'send' && base) {
      const words = [p.caption, (p.hashtags || []).join(' ')].filter(Boolean).join('\n\n');
      const sent = await P.send(u, r.id, { caption: words }, base);
      if (sent.error) return await fail(`the options are ready on the project but could not be sent: ${why(sent)}`);
      return { ok: true, options: ids.length, sent: true };
    }
    await P.tellTeam(r, `Options ready to check: "${S.clip(r.title, 60)}"`, `${ids.length} pictures were made by themselves. Open Client projects, look at them and press Send.${mode === 'send' ? ' They were not sent: the site\'s https address is not set.' : ''}`);
    return { ok: true, options: ids.length, sent: false };
  } catch (e) {
    return fail(why(e));
  }
}

// one at a time; never throws (a failed run is on the timeline and in the team's bell)
function run(projectId) {
  chain = chain.then(() => work(projectId)).catch((e) => { console.error('[omni-mk] automatic first options:', e.message); return null; }); // eslint-disable-line no-console
  return chain;
}

module.exports = { run, work, OPTIONS };
