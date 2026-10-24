// ---------------------------------------------------------------------------
// OMNI-CHANNEL "HOW IT WORKS" STRIP (the compact 10-step flow at the top of the Dashboard). Read only.
// One answer: 10 steps, each with who does it, the page it opens, a REAL count, a plain hint of what to do next, and a tone:
//   ok   this step is in place      todo  nothing there yet: do this next      warn  something needs attention
// Every count is held to what THIS login may see (the same helpers as the dashboard: campaigns.visibleRows, contacts.scopeConds, segments.visibleSegments,
// templates.list, credits activity) and to ?dept= (chrome.deptOf: '' = all, a name, or null = not allowed = nothing).
//   1 Contacts arrive  2 Consent per channel  3 Audience (groups)  4 Template  5 Campaign  6 Send queue  7 Replies in the Inbox
//   8 Automations / follow-ups  9 Conversion (reply -> application -> interview -> offer -> JOINED)  10 Analytics / ROI / credits (END)
// ---------------------------------------------------------------------------
const S = require('./store');
const A = require('./access');
const Cr = require('./credits');
const Ov = require('./overview');

const lc = (v) => String(v == null ? '' : v).trim().toLowerCase();
const safe = async (fn, d) => { try { return await fn(); } catch { return d; } };
const nIn = (n) => Number(n || 0).toLocaleString('en-IN');
const plural = (n, one, many) => `${nIn(n)} ${n === 1 ? one : (many || `${one}s`)}`;
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const ph = (n) => new Array(n).fill('?').join(',');
const OPTED_IN_SQL = 'EXISTS (SELECT 1 FROM "OutreachContactChannel" h WHERE h.contactId = c.id AND h.optIn = \'opted_in\')';

async function flow(user, { dept = '' } = {}) {
  await require('./v3schema').ensure(); // eslint-disable-line global-require
  const G = require('./segments'); // eslint-disable-line global-require
  const T = require('./templates'); // eslint-disable-line global-require
  const Ins = require('./insights'); // eslint-disable-line global-require
  const now = Date.now();
  const ready = await S.ready();
  const pages = new Set(A.pagesFor(user));
  const mayRoi = A.hubsFor(user).insights.includes('roi');

  // 1-2 contacts and consent
  const contacts = await safe(() => Ov.countContacts(user, dept), 0);
  const newWeek = await safe(() => Ov.countContacts(user, dept, { extra: 'c.createdAt >= ?', params: [now - 7 * 86400000] }), 0);
  const noConsent = await safe(() => Ov.countContacts(user, dept, { extra: Ov.NO_CONSENT_SQL }), 0);
  const optedIn = await safe(() => Ov.countContacts(user, dept, { extra: OPTED_IN_SQL }), 0);

  // 3 audience
  const kinds = dept ? (await safe(() => S.industries(), [])).filter((i) => lc(i.department || i.name) === lc(dept)).map((i) => i.name) : [];
  let segs = await safe(async () => {
    let l = [];
    for (const type of ['candidate_lead', 'internal']) if (A.mayRead(user, type)) l = l.concat((await G.visibleSegments(user)).filter((s) => s.contactType === type)); // eslint-disable-line no-await-in-loop
    return [...new Map(l.map((s) => [s.id, s])).values()];
  }, []);
  if (dept === null) segs = [];
  else if (dept) segs = segs.filter((s) => (s.rules.industries || []).some((n) => kinds.includes(n)));
  const emptySegs = segs.filter((s) => !(s.rules.industries.length || s.rules.cities.length || s.rules.importIds.length || s.rules.reachable.length)).length;

  // 4 templates (templates have no department of their own: they are shared by everyone who may read them)
  const tpl = await safe(async () => { let l = []; for (const type of ['candidate_lead', 'internal']) l = l.concat(await T.list(user, { type })); return l; }, []); // eslint-disable-line no-await-in-loop
  const wa = tpl.filter((x) => x.channel === 'whatsapp');
  const waPending = wa.filter((x) => x.waApprovalStatus === 'pending').length;
  const waApproved = wa.filter((x) => x.waApprovalStatus === 'approved').length;
  const waRejected = wa.filter((x) => x.waApprovalStatus === 'rejected').length;

  // 5-6 campaigns and the send queue
  const camps = await safe(() => Ov.scopedCampaigns(user, dept), []);
  const ids = camps.map((c) => c.id);
  const byStatus = (list) => camps.filter((c) => list.includes(c.status)).length;
  const live = byStatus(['running', 'preparing']); const scheduled = byStatus(['scheduled']); const notSent = byStatus(['draft']); const paused = byStatus(['paused']);
  const q = { waiting: 0, sent: 0, delivered: 0, failed: 0, rehearsed: 0, skipped: 0 };
  await safe(async () => {
    for (const part of chunk(ids, 400)) {
      // eslint-disable-next-line no-await-in-loop
      (await S.q(`SELECT status, COUNT(*) n FROM "OutreachMessage" WHERE campaignId IN (${ph(part.length)}) GROUP BY status`, ...part)).forEach((r) => {
        const n = S.num(r.n);
        if (['queued', 'sending'].includes(r.status)) q.waiting += n; else if (r.status === 'sent') q.sent += n; else if (r.status === 'delivered') q.delivered += n; else if (r.status === 'test_captured') q.rehearsed += n;
        else if (r.status === 'skipped') q.skipped += n; else if (['failed', 'bounced', 'complained', 'unknown'].includes(r.status)) q.failed += n;
      });
    }
  }, null);
  const queueTotal = q.waiting + q.sent + q.delivered + q.failed + q.rehearsed;

  // 7 replies
  const unread = await safe(async () => (await require('../utils/conversations').unreadCount(user)).conversations || 0, 0); // eslint-disable-line global-require
  let replies30 = 0;
  await safe(async () => {
    for (const part of chunk(ids, 400)) replies30 += S.num((await S.q(`SELECT COUNT(*) n FROM "OutreachMessage" m WHERE m.campaignId IN (${ph(part.length)}) AND (m.repliedAt >= ? OR EXISTS (SELECT 1 FROM "OutreachEvent" e WHERE e.messageId = m.id AND e.type = 'replied' AND e.occurredAt >= ?))`, ...part, now - 30 * 86400000, now - 30 * 86400000))[0].n); // eslint-disable-line no-await-in-loop
  }, null);

  // 8 automations
  const seqs = dept === null ? [] : await safe(async () => (await require('./sequences').list(user)).sequences.filter((s) => !dept || lc(s.department) === lc(dept)), []); // eslint-disable-line global-require
  const seqOn = seqs.filter((s) => s.status === 'on').length;
  const seqRunning = seqs.reduce((n, s) => n + (s.counts.running || 0), 0);
  const tasksOpen = await safe(async () => (await require('./sequences').tasks(user)).tasks.filter((t) => !t.done).length, 0); // eslint-disable-line global-require

  // 9 conversion (campaigns of the last 90 days)
  const recent90 = camps.filter((c) => Ins.campaignDay(c) >= now - 90 * 86400000);
  const link = await safe(() => Ins.linkApplications(recent90, {}), { linkable: 0, applied: 0, interviews: 0, offers: 0, joined: 0 });

  // 10 analytics: credits used this month in this login's scope
  const month = Cr.thisMonth();
  const act = await safe(async () => { const sc = await Ins.scopeOf(user); return Cr.activity(month, Ins.actOpts(sc)); }, null);

  const open = (page, params) => (pages.has(page) ? { page, params: params || {} } : { page: null, params: {} });
  const steps = [
    {
      id: 'contacts', title: 'Contacts arrive', words: 'Import a CSV or Excel file, take applications from forms and the job portal, copy ATS candidates, or sync HRMS staff.', who: 'BDE team, Team Leads and Admin', mine: A.mayRun(user) || A.mayRunInternal(user),
      ...open('customers'), count: contacts, countLabel: contacts === 1 ? 'contact' : 'contacts',
      tone: contacts > 0 ? 'ok' : 'todo', hint: contacts > 0 ? `${plural(contacts, 'contact')}${newWeek ? `, ${nIn(newWeek)} added in the last 7 days` : ''}` : 'No contacts yet: import a file or add a person',
    },
    {
      id: 'consent', title: 'Consent per channel', words: 'Each person says yes on each way (WhatsApp, SMS, Email). Nobody is messaged without it.', who: 'Admin records it; people give it on forms or by replying', mine: A.mayOptIn(user),
      ...open('customers'), count: optedIn, countLabel: 'with consent',
      tone: contacts === 0 ? 'todo' : (noConsent > 0 ? 'warn' : 'ok'), hint: contacts === 0 ? 'Add contacts first' : (noConsent > 0 ? `${nIn(noConsent)} contact${noConsent === 1 ? ' has' : 's have'} no consent yet` : 'Everyone has a consent answer'),
    },
    {
      id: 'audience', title: 'Audience', words: 'Put people into groups (segments) by kind, city, file or consent.', who: 'BDE team, Team Leads and Admin', mine: A.mayRun(user),
      ...open('segments'), count: segs.length, countLabel: segs.length === 1 ? 'group' : 'groups',
      tone: segs.length === 0 ? 'todo' : (emptySegs > 0 ? 'warn' : 'ok'), hint: segs.length === 0 ? 'No groups yet: make one' : (emptySegs > 0 ? `${plural(emptySegs, 'group')} ${emptySegs === 1 ? 'has' : 'have'} no rule and matches nobody` : `${plural(segs.length, 'group')} ready`),
    },
    {
      id: 'template', title: 'Template', words: 'Choose the words of the message. WhatsApp templates must be approved by WhatsApp (Meta) first.', who: 'BDE team, Team Leads, Marketing and Admin', mine: A.has('canEditTemplates')(user),
      ...open('templates'), count: tpl.length, countLabel: tpl.length === 1 ? 'template' : 'templates',
      tone: tpl.length === 0 ? 'todo' : (waPending > 0 || waRejected > 0 ? 'warn' : 'ok'), hint: tpl.length === 0 ? 'No templates yet: write one' : (waPending > 0 ? `${waPending} WhatsApp template${waPending === 1 ? ' waits' : 's wait'} for approval` : (waRejected > 0 ? `${waRejected} WhatsApp template${waRejected === 1 ? ' was' : 's were'} rejected: edit and send again` : `${plural(tpl.length, 'template')}${wa.length ? `, ${waApproved} WhatsApp approved` : ''}`)),
    },
    {
      id: 'campaign', title: 'Campaign', words: 'Pick the requirement, the audience, the way and the template. Set the time and quiet hours, check credits. Test mode keeps it a rehearsal.', who: 'BDE team, Team Leads and Admin', mine: A.mayCampaign(user),
      ...open('campaigns'), count: camps.length, countLabel: camps.length === 1 ? 'campaign' : 'campaigns',
      tone: camps.length === 0 ? 'todo' : 'ok', hint: camps.length === 0 ? 'No campaign yet: create one' : `${live} live, ${scheduled} scheduled, ${notSent} not sent yet${paused ? `, ${paused} paused` : ''}`,
    },
    {
      id: 'queue', title: 'Send queue', words: 'Messages go out one by one: Waiting, Sent, Delivered or Failed, with retries and plain reasons.', who: 'The system (you only watch it)', mine: false,
      ...open('campaigns'), count: queueTotal, countLabel: 'messages',
      tone: q.failed > 0 ? 'warn' : (queueTotal === 0 ? 'todo' : 'ok'), hint: q.failed > 0 ? `${nIn(q.failed)} message${q.failed === 1 ? '' : 's'} failed: see why` : (queueTotal === 0 ? (camps.length ? 'Nothing is in the queue yet: send a campaign' : 'The queue fills when a campaign is sent') : `${nIn(q.waiting)} waiting, ${nIn(q.sent + q.delivered)} sent${q.rehearsed ? `, ${nIn(q.rehearsed)} rehearsed (not real)` : ''}`),
    },
    {
      id: 'replies', title: 'Replies in the Inbox', words: 'Every reply lands in one Inbox, with the person it came from.', who: 'Whoever handles that person', mine: pages.has('inbox'),
      ...open('inbox'), count: unread, countLabel: 'waiting',
      tone: unread > 0 ? 'warn' : (replies30 > 0 ? 'ok' : 'todo'), hint: unread > 0 ? `${unread} repl${unread === 1 ? 'y is' : 'ies are'} waiting` : (replies30 > 0 ? `${plural(replies30, 'reply', 'replies')} in the last 30 days, all read` : 'No replies yet'),
    },
    {
      id: 'automation', title: 'Automations and follow-ups', words: 'No reply in N hours? Send the next way or make a task. A reply stops the follow-up.', who: 'BDE team, Team Leads, HR, Marketing and Admin', mine: require('./sequences').mayManage(user),
      ...open('automation'), count: seqOn, countLabel: 'on',
      tone: seqs.length === 0 ? 'todo' : 'ok', hint: seqs.length === 0 ? 'No automations yet: set up a follow-up' : `${seqOn} on, ${nIn(seqRunning)} people in a follow-up${tasksOpen ? `, ${tasksOpen} task${tasksOpen === 1 ? '' : 's'} open` : ''}`,
    },
    {
      id: 'conversion', title: 'Conversion', words: 'Reply, application, interview, offer, JOINED. Linked only when it can be proven.', who: 'Recruiters and Team Leads move people forward in the ATS', mine: false,
      ...open('analytics', { tab: 'funnel' }), count: link.linkable ? link.applied : null, countLabel: link.linkable ? 'applied' : 'not linked',
      tone: link.linkable ? 'ok' : 'todo', hint: link.linkable ? `${nIn(link.applied)} applied, ${nIn(link.interviews)} interviews, ${nIn(link.joined)} joined (last 90 days)` : 'Not linked yet: it needs a requirement campaign that really sent',
    },
    {
      id: 'analytics', title: 'Analytics, ROI and credits', words: 'See what each campaign, person and department achieved and spent. This is the end of the flow.', who: 'Everyone sees their own; Team Leads, Heads and Admin see more', mine: true, end: true,
      ...open('analytics', mayRoi ? { tab: 'roi' } : {}), count: act ? act.totals.used : null, countLabel: 'credits used this month',
      tone: 'ok', hint: act ? `${nIn(act.totals.used)} credits used this month${act.totals.joinings ? `, ${nIn(act.totals.joinings)} joined` : ''}` : 'Open Analytics',
    },
  ].map((s, i) => ({ n: i + 1, ...s }));
  const next = steps.find((s) => s.tone === 'todo' || s.tone === 'warn') || null;
  return { ready, dept: dept || '', steps, next: next ? { n: next.n, id: next.id, title: next.title, hint: next.hint } : null, testMode: ready ? (await safe(() => S.settings(), { emailTestMode: true })).emailTestMode : true };
}

module.exports = { flow };
