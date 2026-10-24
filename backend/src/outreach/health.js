// ---------------------------------------------------------------------------
// CAMPAIGN HEALTH (quick wins, T2): why a campaign is not going out, a "Check before sending" step, and the bell notices.
//
//   holdReasons(row, counts, env)   the plain reasons a campaign is stopped / held / paused right now, WORKED OUT LIVE from the settings and the
//                                   queue (so it is always true, even before the notes table exists): sending switched OFF, test mode against a
//                                   live campaign, the channel (email / WhatsApp / SMS) not set up, daily limit reached, a bad / missing webhook secret, paused,
//                                   stopped, failed ... Each reason has the words and the FIX (who does what). Channel-aware (2026-10-17): the words and
//                                   the limits are those of the campaign's own channel. A call campaign has no machine to hold it: only paused / stopped / done.
//   checkBeforeSending(user, body)  the wizard's review step: how many will send, who is left out and why, test mode, the limit left today, when it
//                                   should finish, the stop link, empty message words. Anything wrong BLOCKS the Send button, with a plain sentence.
//   announce(row, kind, text, ...)  one bell notice to the campaign's creator and the Admins (finished / paused / stopped / failed / held). The same
//                                   thing is never announced twice (OutreachCampaignNote.noteKey is UNIQUE). Notices carry the campaign NAME and counts,
//                                   never a person's phone or email.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const S = require('./store');
const Sup = require('./suppress');
const T = require('./templates');
const adapters = require('./adapters');
const Hook = require('./webhook');
const Quiet = require('./quiet');

const IST = 5.5 * 3600 * 1000;
const dayStart = (now) => Math.floor((now + IST) / 86400000) * 86400000 - IST;
const nextDayStart = (now) => dayStart(now) + 86400000;
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;

// ---- what the world looks like right now (read once, used for many campaigns) ---------------------------------------
const WORDS = { email: 'Email', whatsapp: 'WhatsApp', sms: 'SMS', call: 'Call' };
const capOf = (st, ch) => (ch === 'whatsapp' ? st.waDailyCap : (ch === 'sms' ? st.smsDailyCap : st.emailDailyCap));
const perMinOf = (st, ch) => (ch === 'whatsapp' ? st.waPerMinute : (ch === 'sms' ? st.smsPerMinute : st.emailPerMinute));
async function env() {
  const st = await S.settings();
  const email = adapters.get('email');
  const status = await email.status();
  let secretOk = true;
  try { Hook.secret(); } catch { secretOk = false; }
  // the other two channels too (adapter.status() and the day's counts), so a WhatsApp / SMS campaign is explained in its own words
  const chans = { email: { adapter: status, sentTest: await email.sentToday('test'), sentLive: await email.sentToday('live') } };
  for (const ch of ['whatsapp', 'sms']) {
    const a = adapters.get(ch);
    chans[ch] = { adapter: await a.status(), sentTest: await a.sentToday('test'), sentLive: await a.sentToday('live') }; // eslint-disable-line no-await-in-loop
  }
  return { st, adapter: status, sentTest: chans.email.sentTest, sentLive: chans.email.sentLive, chans, secretOk };
}

// ---- the plain reasons ------------------------------------------------------------------------------------------------
// level: 'stop' (nothing goes out) | 'wait' (it will go on by itself) | 'info'.  fix: { who: 'admin' | 'owner' | 'nobody', text, action }
function holdReasons(row, counts, e, note) {
  const out = [];
  const c = counts || { waiting: 0, sent: 0, failed: 0, cancelled: 0, skipped: 0 };
  const st = row.status;
  const add = (code, level, words, fix) => out.push({ code, level, words, fix: fix || null });
  if (st === 'draft') return out;
  if (st === 'stopped') {
    add('stopped', 'stop', note && note.text ? note.text : `Stopped. ${plural(c.cancelled, 'person', 'people')} did not get the message.`, { who: 'nobody', text: 'A stopped campaign cannot start again. Make a new campaign to send more.' });
    return out;
  }
  if (st === 'done') {
    if (c.failed > 0 && c.sent === 0) add('all_failed', 'stop', `Finished, but nothing could be sent: ${plural(c.failed, 'message')} failed.`, { who: 'admin', text: 'Look at the failed rows in the message log (the reason is on each row).' });
    else if (c.failed > 0) add('some_failed', 'info', `Finished. ${c.sent} sent, ${c.failed} failed.`, { who: 'nobody', text: 'Look at the failed rows in the message log.' });
    return out;
  }
  if (st === 'paused') add('paused', 'wait', 'Paused. Nobody else gets a message until someone presses Resume.', { who: 'owner', text: 'Press Resume when you are ready.', action: 'resume' });
  if (st === 'preparing' && row.lastError) add('prepare_failed', 'wait', 'The list of people could not be made fully. It will finish by itself in a moment.', { who: 'nobody', text: 'Nothing to do. If this stays for more than a few minutes, tell an Admin.' });
  const active = ['running', 'scheduled', 'preparing', 'paused'].includes(st);
  if (!active) return out;
  const ch = Sup.chanOf(row);
  if (ch === 'call') { // nothing to hold: a person rings; the list of calls waits for them
    if (c.waiting > 0 && st === 'running') add('to_call', 'info', `${plural(c.waiting, 'person is', 'people are')} waiting for a call.`, { who: 'owner', text: 'Open the campaign and log each call.' });
    return out;
  }
  const W = WORDS[ch] || 'Email';
  const ce = (e.chans && e.chans[ch]) || { adapter: e.adapter, sentTest: e.sentTest, sentLive: e.sentLive };
  const live = row.mode === 'live';
  const queued = st === 'scheduled' ? 1 : c.waiting;
  if (st === 'scheduled') add('scheduled', 'info', `Scheduled. It starts by itself${row.scheduledAt ? ` at ${new Date(S.ms(row.scheduledAt) + IST).toISOString().replace('T', ' ').slice(0, 16)} (India time)` : ''}.`, { who: 'nobody', text: 'You can press Pause to hold it.' });
  if (!e.st.master) add('sending_off', 'stop', 'Outreach sending is switched OFF (the master switch), so nothing goes out, not even a rehearsal.', { who: 'admin', text: 'An Admin switches "Outreach sending" ON (Campaigns > Sending settings).', action: 'sending_settings' });
  if (queued > 0 && e.st.master && st !== 'scheduled') {
    const qs = Quiet.state(e.now || Date.now(), e.st.quietHours, row.type);
    if (qs.active) add('quiet_hours', 'wait', `${qs.words}. ${plural(c.waiting, 'person is', 'people are')} waiting and will get it by themselves.`, { who: 'nobody', text: 'Nothing to do. An Admin can change quiet hours in Settings > Sending rules.' });
  }
  if (live && e.st.emailTestMode) add('test_mode_hold', 'stop', `This campaign is live, but ${W} is in test mode, so it is held and nobody gets a message.`, { who: 'admin', text: `An Admin turns test mode off in the Channels tab (after ${W} is set up), or stops this campaign.`, action: 'channels' });
  if (live && !ce.adapter.ready) add('mail_not_set_up', 'stop', `${W} is not set up, so nothing can be sent. ${ce.adapter.reason || ''}`.trim(), { who: 'admin', text: ch === 'email' ? 'An Admin sets up the mail server in Administration > Integrations.' : `An Admin connects ${W} in Administration > Integrations.`, action: 'channels' });
  if (queued > 0 && e.st.master) {
    const sentToday = live ? ce.sentLive : ce.sentTest;
    const cap = capOf(e.st, ch);
    if (sentToday >= cap) add('daily_cap', 'wait', `The daily limit is reached: ${sentToday} of ${cap} ${ch === 'email' ? 'emails' : 'messages'} today. ${plural(c.waiting, 'person is', 'people are')} waiting and will go out after midnight (India time).`, { who: 'admin', text: 'Nothing to do, it goes on tomorrow. An Admin can raise the daily limit in the Channels tab.', action: 'channels' });
  }
  if (live && ch === 'email' && !e.secretOk) add('webhook_secret', 'info', 'The secret that signs delivery reports is missing, so "delivered" and bounce reports will be refused.', { who: 'admin', text: 'An Admin sets OUTREACH_WEBHOOK_SECRET (or the integration key) on the server.' });
  if (row.lastError && st !== 'preparing') add('last_error', 'info', `The last problem: ${row.lastError}`, { who: 'admin', text: 'Look at the failed rows in the message log.' });
  if (c.failed > 0 && st !== 'paused') add('some_failed', 'info', `${plural(c.failed, 'message')} could not be sent.`, { who: 'nobody', text: 'Look at the failed rows in the message log (the reason is on each row).' });
  return out;
}
// one view of the above for a campaign card: the main reason + all of them
function summarize(reasons) {
  const order = { stop: 0, wait: 1, info: 2 };
  const sorted = [...reasons].sort((a, b) => order[a.level] - order[b.level]);
  return { primary: sorted[0] || null, reasons: sorted };
}
async function lastNote(campaignId) {
  if (!(await S.quickReady())) return null;
  return (await S.q('SELECT * FROM "OutreachCampaignNote" WHERE campaignId = ? AND kind IN (\'stopped\',\'finished\',\'failed\') ORDER BY at DESC LIMIT 1', campaignId))[0] || null;
}

// ---- the bell ---------------------------------------------------------------------------------------------------------------
const isTestUser = (u) => /zztest|example\.test/i.test(`${u.name || ''} ${u.email || ''}`);
// the creator, plus every active Admin / Super Admin (a test login is never picked up as a real Admin)
async function recipients(row) {
  const ids = new Set();
  if (row.createdById) ids.add(row.createdById);
  try {
    const admins = await prisma.user.findMany({ where: { status: 'Active', OR: [{ role: { in: ['SUPER_ADMIN', 'ADMIN'] } }, { atsRole: { in: ['SUPER_ADMIN', 'ADMIN'] } }] }, select: { id: true, name: true, email: true } });
    admins.filter((u) => !isTestUser(u)).forEach((u) => ids.add(u.id));
  } catch { /* no admin list: the creator still gets it */ }
  return [...ids];
}
const TITLES = { finished: 'finished', paused: 'was paused', stopped: 'was stopped', failed: 'has a problem', held: 'is on hold' };
// kind: finished | paused | stopped | failed | held. key: makes the notice once-only (default: kind + campaign). Returns { announced }.
async function announce(row, kind, text, { key, reason = null, exceptUserId = null, onlyOnce = true } = {}) {
  try {
    const noteKey = key || `${kind}:${row.id}`;
    if (await S.quickReady()) {
      const made = await S.run('INSERT OR IGNORE INTO "OutreachCampaignNote" (id, campaignId, noteKey, kind, reason, text, at) VALUES (?,?,?,?,?,?,?)', S.newId('ocn'), row.id, noteKey, kind, reason, S.clip(text, 300), Date.now());
      if (!made) return { announced: false };
    } else if (kind === 'held' && onlyOnce) return { announced: false }; // without the notes table a repeating hold would repeat the bell
    const ids = (await recipients(row)).filter((id) => id !== exceptUserId);
    if (!ids.length) return { announced: true, to: 0 };
    const { notifyUsers } = require('../utils/notify'); // eslint-disable-line global-require
    await notifyUsers(ids, { title: `Campaign "${S.clip(row.name, 60)}" ${TITLES[kind] || kind}`, message: S.clip(text, 300) });
    return { announced: true, to: ids.length };
  } catch (err) { console.error('[outreach] campaign notice:', err && err.message); return { announced: false, error: true }; } // eslint-disable-line no-console
}

// ---- CHECK BEFORE SENDING --------------------------------------------------------------------------------------------------
function finishWords(n, perMin, capLeft, cap, start, live) {
  if (n < 1) return { words: 'There is nothing to send.', finishAt: null };
  if (!(perMin > 0)) return { words: 'The sending speed is not set.', finishAt: null };
  const mins = (k) => Math.max(1, Math.ceil(k / perMin));
  const wordsMin = (m) => (m <= 1 ? 'about a minute' : (m < 90 ? `about ${m} minutes` : `about ${Math.round(m / 60)} hours`));
  const sameDay = dayStart(start) === dayStart(Date.now());
  const today = sameDay ? capLeft : cap;
  if (n <= today) { const m = mins(n); return { words: wordsMin(m), finishAt: new Date(start + m * 60000).toISOString() }; }
  if (!(cap > 0)) return { words: 'The daily limit is 0, so nothing can go out until an Admin raises it.', finishAt: null };
  const rest = n - today; const fullDays = Math.ceil(rest / cap);
  const lastCount = rest - (fullDays - 1) * cap;
  const at = nextDayStart(start) + (fullDays - 1) * 86400000 + mins(lastCount) * 60000;
  return { words: `about ${fullDays + (today > 0 ? 1 : 0) > 1 ? plural(fullDays + (today > 0 ? 1 : 0), 'day') : '1 day'} (the daily limit is ${cap}, so the rest goes out each morning)`, finishAt: new Date(at).toISOString() };
}

// b: the same body as /campaigns/plan (channel: email | whatsapp | sms | call; default email), plus when ('now' | 'at') and at.
// -> { ok, blocked, checks[], willSend, willSkip, skipReasons, ... } or { error, status }
async function checkBeforeSending(user, b = {}, pre = null) { // pre = a plan already made for this very body (the wizard review does one plan per channel)
  const Camp = require('./campaigns'); // eslint-disable-line global-require
  const checks = [];
  const add = (id, status, label, detail, fix) => checks.push({ id, status, label, detail: detail || '', fix: fix || '' });
  const p = pre || await Camp.plan(user, b);
  if (p.error) {
    if ([401, 403, 404, 429, 503].includes(p.status)) return p; // not allowed: that is an error, not a "check"
    const probs = p.problems && p.problems.length ? p.problems : [p.error];
    const isTemplate = p.code === 'template' || /message|template|unsubscribe|apply link/i.test(p.error);
    probs.forEach((x) => add(isTemplate ? 'message' : 'setup', 'block', isTemplate ? 'The message is not ready' : 'Something is missing', x, isTemplate ? 'Fix the message in the "Message templates" tab, then come back.' : 'Go back and fix this step.'));
    return { ok: false, blocked: true, checks, willSend: 0, willSkip: 0, skipReasons: [] };
  }
  const ch = p.channel || 'email';
  const W = WORDS[ch] || 'Email';
  const unit = ch === 'email' ? 'emails' : (ch === 'call' ? 'calls' : 'messages');
  const st = await S.settings();
  const adapter = await adapters.get(ch).status();
  const mode = st.emailTestMode ? 'test' : 'live';
  const cap = ch === 'call' ? 0 : capOf(st, ch);
  const perMin = ch === 'call' ? 0 : perMinOf(st, ch);
  const sentToday = ch === 'call' ? 0 : await adapters.get(ch).sentToday(mode);
  const capLeft = Math.max(0, cap - sentToday);
  const skipReasons = Object.entries(p.reasons || {}).map(([reason, n]) => ({ reason, words: Sup.REASON_WORDS[reason] || reason, n }));

  // 1 people
  if (p.willGet < 1) add('people', 'block', 'Nobody would get it', `${p.people} ${p.people === 1 ? 'person is' : 'people are'} in the groups you picked, but every one is left out.`, 'Go back and pick another group, or check the permission of the people.');
  else add('people', 'ok', ch === 'call' ? `${plural(p.willGet, 'person', 'people')} will be on the call list` : `${plural(p.willGet, 'person', 'people')} will get it`, p.skippedTotal > 0 ? `${plural(p.skippedTotal, 'person', 'people')} will be left out.` : 'Nobody is left out.');
  if (p.skippedTotal > 0) add('skips', 'ok', 'Who is left out, and why', skipReasons.map((r) => `${r.words}: ${r.n}`).join(' · '));

  // 2 the message: stop link, empty words
  let tpl = null;
  if (b.templateId && ch !== 'call') tpl = (await S.q('SELECT * FROM "OutreachTemplate" WHERE id = ?', String(b.templateId)))[0] || null;
  if (tpl) {
    const used = T.VARS.filter((v) => new RegExp(`\\{\\{\\s*${v}\\s*\\}\\}`).test(`${tpl.body} ${tpl.subject || ''}`));
    if (ch === 'email') {
      if (!used.includes('unsubscribe')) add('stop_link', 'block', 'The stop link is missing', 'People must be able to stop these emails.', 'Add {{unsubscribe}} to the message.');
      else add('stop_link', 'ok', 'Every message has the stop link');
    } else if (used.includes('unsubscribe') || /\breply\s+stop\b|\bsend\s+stop\b|\btype\s+stop\b/i.test(tpl.body)) add('stop_link', 'ok', 'Every message ends with "Reply STOP to opt out"');
    else add('stop_link', 'block', 'The STOP line is missing', 'People must be able to stop these messages.', 'Add {{unsubscribe}} or the words "Reply STOP to opt out" to the message.');
    if (ch === 'whatsapp') add('wa_template', tpl.waApprovalStatus === 'approved' ? 'ok' : 'block', tpl.waApprovalStatus === 'approved' ? 'WhatsApp has approved this message' : 'WhatsApp has not approved this message', tpl.waApprovalStatus === 'approved' ? `Template "${tpl.waTemplateName || ''}" goes out with its variables in order.` : 'Only a Meta-approved template can be sent.', tpl.waApprovalStatus === 'approved' ? '' : 'Pick an approved message, or wait for Meta.');
    if (ch === 'sms') add('dlt', tpl.dltTemplateId && tpl.senderId ? 'ok' : 'block', tpl.dltTemplateId && tpl.senderId ? 'DLT template and sender ID are set' : 'The DLT template or sender ID is missing', tpl.dltTemplateId && tpl.senderId ? '' : 'Indian SMS needs both.', 'Add them to the message in Manage Templates.');
    const empties = [];
    if (used.includes('job_title') && !(p.job && S.clip(p.job.title, 200))) empties.push('the job title is empty');
    if (used.includes('apply_link') && b.type !== 'internal') {
      const rq = b.requirementId ? await prisma.requirement.findUnique({ where: { id: String(b.requirementId) }, select: { portalPublished: true } }) : null;
      if (!rq || !rq.portalPublished) empties.push('the apply link would not open a job page (the job is not on the Job Portal yet)');
    }
    if (empties.length) add('words', 'block', 'The message has words that would be empty', `${empties.join('; ')}.`, 'Publish the job on the Job Portal, then come back.');
    else add('words', 'ok', 'Every word in the message gets filled in');
    if (used.includes('name')) {
      const m = await Sup.members(b.segmentIds, b.type === 'internal' ? 'internal' : 'job_promotion');
      let noName = 0;
      for (let i = 0; i < m.ids.length; i += 400) { const part = m.ids.slice(i, i + 400); noName += S.num((await S.q(`SELECT COUNT(*) n FROM "OutreachContact" WHERE id IN (${part.map(() => '?').join(',')}) AND (name IS NULL OR TRIM(name) = '')`, ...part))[0].n); } // eslint-disable-line no-await-in-loop
      if (noName > 0) add('names', 'warn', `${plural(noName, 'person has', 'people have')} no name`, 'They will see "Hi there" instead of their name.');
    }
  }

  // 3 can it go out
  if (ch === 'call') add('calls', 'ok', 'A person makes each call', 'Nothing is sent by the machine. Each person becomes a call task ("To call"); log it as Called, No answer or Skip.');
  else if (st.emailTestMode) add('test_mode', 'warn', 'Test mode is ON: this will be a rehearsal', 'Everything is made (the list, the logs, the links) but nothing is really sent. An Admin turns test mode off in the Channels tab.');
  else if (!adapter.ready) add('mail', 'block', `${W} is not set up`, adapter.reason || `${W} is not set up.`, ch === 'email' ? 'An Admin sets up the mail server in Administration > Integrations.' : `An Admin connects ${W} in Administration > Integrations.`);
  else add('mail', 'ok', `${W} is live and set up`, `Real people will get real ${unit}.`);
  if (ch !== 'call') {
    if (!st.master) add('switch', 'warn', 'Outreach sending is switched OFF', 'You can still save and send this. It waits, and starts when an Admin switches "Outreach sending" on.', 'Ask an Admin to switch it on.');
    else add('switch', 'ok', 'Outreach sending is ON');
  }
  // credits: needed vs left (Test mode costs nothing; an exempt login has no limit)
  if (p.credits) {
    const cr = p.credits;
    if (cr.testMode) add('credits', 'ok', 'Credits: a rehearsal costs nothing');
    else if (!cr.cost) add('credits', 'ok', `Credits: ${W} costs nothing per message`);
    else if (cr.exempt || !cr.enforce) add('credits', 'ok', `Credits: this needs ${cr.needed}`, 'Your login has no credit limit.');
    else if (!cr.enough) add('credits', 'block', `Not enough credits: this needs ${cr.needed}, you have ${cr.left}`, 'A live send is blocked when the credits are not enough.', 'Ask an Admin for more credits, or pick a smaller group.');
    else add('credits', 'ok', `Credits: this needs ${cr.needed} of your ${cr.left}`);
  }
  if (ch !== 'call') {
    if (capLeft < 1) add('cap', 'warn', 'The daily limit is already reached today', `${sentToday} of ${cap} ${unit} are used today. This goes out from tomorrow.`, 'An Admin can raise the daily limit in the Channels tab.');
    else if (p.willGet > capLeft) add('cap', 'warn', `Only ${capLeft} more can go out today`, `The daily limit is ${cap}. The rest goes out on the next days, by itself.`);
    else add('cap', 'ok', `${capLeft} of today's ${cap} ${unit} are left`, `${plural(p.willGet, ch === 'email' ? 'email' : 'message')} will use ${p.willGet} of them.`);
    const qType = b.type === 'internal' ? 'internal' : 'job_promotion';
    if (Quiet.applies(st.quietHours, qType)) {
      const qn = Quiet.normalize(st.quietHours);
      const picked = b.when === 'at' && b.at ? Date.parse(b.at) : NaN;
      const mv = Number.isFinite(picked) ? Quiet.moveOutOfQuiet(picked, qn, qType) : { moved: false };
      if (mv.moved) add('quiet', 'warn', 'The time you picked is inside quiet hours', `It will start at ${qn.end} (India time) instead.`);
      else if (!(b.when === 'at' && b.at) && Quiet.state(Date.now(), qn, qType).active) add('quiet', 'warn', 'Quiet hours are on right now', `Messages wait until ${qn.end} (India time), then go out by themselves.`);
      else add('quiet', 'ok', `Quiet hours: nothing is sent from ${qn.start} to ${qn.end}`, 'India time.');
    }
    const start = b.when === 'at' && b.at ? (Date.parse(b.at) || Date.now()) : Date.now();
    const speed = Number.isFinite(Math.floor(Number(b.perMinute))) && Math.floor(Number(b.perMinute)) > 0 ? Math.min(Math.floor(Number(b.perMinute)), perMin) : perMin;
    const fin = finishWords(p.willGet, speed, capLeft, cap, start, !st.emailTestMode);
    add('finish', 'ok', `It should be finished in ${fin.words}`, `Speed: ${speed} ${unit} a minute.`);
    const blocked0 = checks.some((c) => c.status === 'block');
    return { ok: !blocked0, blocked: blocked0, checks, channel: ch, willSend: p.willGet, willSkip: p.skippedTotal, skipReasons, testMode: st.emailTestMode, sendingOn: st.master, capLeft, capTotal: cap, sentToday, credits: p.credits || null, estimate: { words: fin.words, finishAt: fin.finishAt, perMinute: speed }, job: p.job };
  }
  const blocked = checks.some((c) => c.status === 'block');
  return { ok: !blocked, blocked, checks, channel: ch, willSend: p.willGet, willSkip: p.skippedTotal, skipReasons, testMode: false, sendingOn: st.master, credits: p.credits || null, estimate: { words: 'Calls are made by a person, one by one.', finishAt: null, perMinute: null }, job: p.job };
}

module.exports = { env, holdReasons, summarize, lastNote, announce, recipients, checkBeforeSending, finishWords, dayStart, nextDayStart };
