// ---------------------------------------------------------------------------
// "NOW TELL THEM" — the window after an interview is BOOKED, MOVED or CANCELLED (user, 2026-10-10:
// "interview book chesaaka: WhatsApp, Mail, SMS, Call option kuda raavali; recruiter ki, aa TL ki,
// aa BDE ki, candidate ki vellali").
//
//   payload(user, appId, kind)    everything the window needs, for THIS login:
//        candidate   Call / WhatsApp / SMS / Mail, each with its honest state
//                      send      connected: one press sends it through the messaging module
//                      fallback  not connected (or no approved template): open it in your own
//                                WhatsApp / mail app, or copy the words (SMS)
//                      blocked   consent withdrawn, STOP, "Candidate emails" switch off, test record
//                      none      no number / address on file
//                    plus what already went (automatic or by hand) and how it stands now
//        parties     Recruiter, Team lead, Client manager (BDE), Interviewer(s): who was already
//                    told, and whether they can be told by bell / mail
//   sendAll(...)                  "Send on all available channels" for the candidate
//   notify(...)                   bell + mail (+ WhatsApp / SMS when connected and the number is on
//                                 file) to the chosen parties, one or all
//   logCopied(...)                a copy/paste is recorded on the candidate's history
//
// PRIVACY. A BDE (and the BDE team lead, and any login the Role Catalog "Candidate Contact" switch
// is off for) gets `masked`: no number, no address, only a hint like 98••••3210; every send goes
// through the server. The candidate NEVER sees the client's name: the wording says "our client"
// (utils/messageContext.js). Staff texts name the client.
//
// ONE SOURCE OF TRUTH FOR "THE CANDIDATE WAS TOLD". toldSummary() reads the candidate's history
// (CandidateMessage) after the booking event: any message that really went, was queued, was opened
// in the sender's own app, or a call that was logged — by this window, by the Contact button, or by
// an automatic stage message — counts. The reminder sweep's 10-minute safety net (utils/
// interviewEngine.js) and "Send on all channels" both look here, so nobody is told twice.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const IM = require('./interviewMessageDefaults');

const KINDS = ['scheduled', 'rescheduled', 'cancelled'];
const EVENT_STATUS = { scheduled: 'SCHEDULED', rescheduled: 'RESCHEDULED', cancelled: 'CANCELLED' };
const CHANNELS = ['WhatsApp', 'SMS', 'Email'];
// A row in these states means the person WAS reached (or the message is on its way / in their own app).
const TOLD_STATUS = ['SENT', 'DELIVERED', 'READ', 'QUEUED', 'RETRY', 'OPENED_ON_DEVICE', 'LOGGED', 'COPIED', 'RECEIVED'];
const FAILED_STATUS = ['FAILED', 'NOT_SENT_BLOCKED', 'NOT_SENT_NO_PROVIDER', 'NOT_SENT_SWITCHED_OFF'];
const WORD = {
  SENT: 'Sent', DELIVERED: 'Delivered', READ: 'Read', QUEUED: 'On its way', RETRY: 'Trying again', OPENED_ON_DEVICE: 'Opened on your phone',
  LOGGED: 'Call saved', COPIED: 'Copied', FAILED: 'Failed', NOT_SENT_BLOCKED: 'Not sent', NOT_SENT_NO_PROVIDER: 'Not sent', NOT_SENT_SWITCHED_OFF: 'Not sent (switch off)', RECEIVED: 'Replied',
};
const isTest = (s) => /zztest|example\.test/i.test(String(s || ''));

const lazy = {
  IN: () => require('./interviewNotices'), // eslint-disable-line global-require
  access: () => require('./contactAccess'), // eslint-disable-line global-require
  bulk: () => require('./bulkMessaging'), // eslint-disable-line global-require
  omni: () => require('./omniSend'), // eslint-disable-line global-require
  messaging: () => require('./messaging'), // eslint-disable-line global-require
  perm: () => require('./permissions'), // eslint-disable-line global-require
};

const APP_INCLUDE = { candidate: true, requirement: { include: { client: true } } };

function kindOf(app, asked) {
  if (KINDS.includes(asked)) return asked;
  if (app.interviewStatus === 'CANCELLED') return 'cancelled';
  if (app.interviewStatus === 'RESCHEDULED') return 'rescheduled';
  return 'scheduled';
}

// When this booking / move / cancel happened (the start of "since").
async function eventTime(app, kind) {
  const ev = await prisma.interviewEvent.findFirst({ where: { applicationId: app.id, status: EVENT_STATUS[kind] }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }).catch(() => null);
  const at = ev ? ev.createdAt : app.updatedAt;
  // the stage move that books the first interview is written a moment before the event row
  return new Date(new Date(at).getTime() - 2 * 60000);
}

// What already reached the candidate about THIS booking / move / cancel, per channel.
async function toldSummary(app, kind) {
  const since = await eventTime(app, kind);
  const rows = await prisma.candidateMessage.findMany({
    where: { applicationId: app.id, candidateId: app.candidateId, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, channel: true, status: true, template: true, templateLabel: true, trigger: true, createdAt: true, senderName: true, statusDetail: true },
  }).catch(() => []);
  // only messages ABOUT the interview: the interview wording, the stage message, or a call / own words written now
  const about = rows.filter((r) => {
    const label = String(r.templateLabel || '');
    if (label === 'Preparation for your interview') return false; // the "how to prepare" pack (utils/interviewPrep.js) is not the booking message
    if (IM.PURPOSES.some((p) => IM.LABEL_OF[p] === label) || /^Interview/i.test(label)) return true;
    if (/^INTERVIEW_/.test(String(r.template || '')) || r.template === 'MANUAL' || r.template === 'QUICK_LOG' || r.template === 'CALL_THROUGH') return true;
    return /interview/i.test(String(r.trigger || ''));
  });
  const byChannel = {};
  about.forEach((r) => {
    const ch = r.channel === 'Mail' ? 'Email' : r.channel;
    const cur = byChannel[ch];
    // a message that went beats one that did not, whatever the order
    const good = TOLD_STATUS.includes(r.status);
    if (!cur || (good && !cur.told)) {
      byChannel[ch] = {
        channel: ch, status: r.status, word: WORD[r.status] || r.status, told: good, failed: FAILED_STATUS.includes(r.status),
        at: r.createdAt, by: r.senderName || null, automatic: /^Automatic|^Interview:/i.test(String(r.trigger || '')) && !/Manual/.test(r.trigger || ''), detail: r.statusDetail || null,
      };
    }
  });
  const list = Object.values(byChannel);
  return { since, byChannel, told: list.some((x) => x.told), list };
}

// ---- the people on the interview ------------------------------------------------------------------
const split = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

// -> [{ key, userId, name, email, phone, roles:[...], external }]
async function partiesOf(app) {
  const r = app.requirement || {};
  const { withClientBdes } = require('./clientBdes'); // eslint-disable-line global-require
  const PANEL = require('./interviewPanel'); // eslint-disable-line global-require
  const sandbox = require('./sandbox').isSandbox(); // eslint-disable-line global-require
  const want = new Map(); // userId -> roles
  const add = (id, role) => { if (!id) return; const a = want.get(id) || []; if (!a.includes(role)) a.push(role); want.set(id, a); };
  [r.recruiterId, ...split(r.recruiterIds)].forEach((id) => add(id, 'Recruiter'));
  add(r.tlId, 'Team lead');
  const bdes = await withClientBdes([r.bdeId].filter(Boolean), r).catch(() => [r.bdeId].filter(Boolean));
  bdes.forEach((id) => add(id, 'Client manager (BDE)'));
  const panel = await PANEL.panelStaff(app.id, app.interviewRound || 1).catch(() => []);
  panel.forEach((u) => add(u.id, 'Interviewer'));
  const users = want.size
    ? await prisma.user.findMany({ where: { id: { in: [...want.keys()] }, status: 'Active' }, select: { id: true, name: true, email: true, employee: { select: { phone: true, name: true } } } })
    : [];
  const out = users.filter((u) => sandbox || !isTest(`${u.name} ${u.email}`)).map((u) => ({
    key: u.id, userId: u.id, name: (u.employee && u.employee.name) || u.name, email: u.email || null, phone: (u.employee && u.employee.phone) || null, roles: want.get(u.id), external: false,
  }));
  const outside = await PANEL.panelExternal(app.id, app.interviewRound || 1).catch(() => []);
  outside.forEach((x) => out.push({ key: `x:${String(x.email).toLowerCase()}`, userId: null, name: x.name, email: x.email, phone: null, roles: ['Interviewer'], external: true }));
  const order = { Recruiter: 0, 'Team lead': 1, 'Client manager (BDE)': 2, Interviewer: 3 };
  out.sort((a, b) => Math.min(...a.roles.map((x) => order[x])) - Math.min(...b.roles.map((x) => order[x])) || a.name.localeCompare(b.name));
  return out;
}

// Who got a bell about this event already (automatically by the booking, or by Notify).
async function notifiedMap(app, kind, since) {
  const keys = [`interview|${kind}|${app.id}`];
  const rows = await prisma.notification.findMany({
    where: { createdAt: { gte: since }, OR: [{ recipient: { in: keys } }, { recipient: { startsWith: `interview-notify|${kind}|${app.id}|` } }] },
    select: { userId: true, recipient: true, createdAt: true },
  }).catch(() => []);
  const m = new Map();
  rows.forEach((n) => { if (n.userId && (!m.has(n.userId) || m.get(n.userId).at < n.createdAt)) m.set(n.userId, { at: n.createdAt, manual: n.recipient.startsWith('interview-notify|') }); });
  return m;
}

const roleLine = (roles) => roles.join(' and ');

// ---- the staff-facing words --------------------------------------------------------------------------
function staffTitle(kind, name) {
  return ({
    scheduled: `📅 Interview booked: ${name}`, rescheduled: `📅 Interview moved: ${name}`, cancelled: `Interview cancelled: ${name}`,
  })[kind];
}

// ---- payload ------------------------------------------------------------------------------------------
const HARD_BLOCK = /Asked not to be contacted|Candidate emails|replied STOP|Test record|Quiet hours/i;

async function canDo(user, action) {
  const { can } = lazy.perm();
  return can(user, 'ats', 'interviews', 'Schedule Interview', action);
}

// One dry run of the normal one-person send for each channel: the same gates as the real send.
async function channelState(user, app, kind, channel, masked) {
  const purposeKey = IM.PURPOSE_OF[kind];
  const plan = await lazy.bulk().buildPlan(user, {
    audience: 'candidates', ids: [app.candidateId], channels: [channel], kind: 'individual', purposeKey, applicationId: app.id, urgent: true, language: 'English',
  });
  if (plan.error) return { state: 'blocked', reason: plan.error, text: null };
  const r = plan.plan.recipients[0];
  if (!r) return { state: 'blocked', reason: 'Nothing to send.', text: null };
  const base = { text: r.text, subject: r.subject || null, address: masked ? lazy.access().maskAddress(channel, r.address) : r.address };
  if (r.status === 'queued') return { ...base, state: 'send', reason: null };
  const reason = r.reason || 'Cannot be sent.';
  if (/^No (email|mobile)|not a valid|is not a phone|placeholder number/i.test(reason)) return { ...base, state: 'none', reason };
  if (HARD_BLOCK.test(reason)) return { ...base, state: 'blocked', reason };
  // "Missing: ..." (a detail the wording needs) and everything else that is only about the channel: fall back
  return { ...base, state: 'fallback', reason, notSetUp: !!r.notSetUp };
}

async function payload(user, appId, askedKind) {
  const app = await prisma.application.findUnique({ where: { id: appId }, include: APP_INCLUDE });
  if (!app) return { error: 'No such interview.', status: 404 };
  const kind = kindOf(app, askedKind);
  const IN = lazy.IN();
  const access = lazy.access();
  const rule = await access.ruleFor(user, 'candidates');
  const masked = rule.allowed && rule.mode === 'masked';
  const cand = app.candidate || {};
  const since = await eventTime(app, kind);
  const told = await toldSummary(app, kind);
  const status = await lazy.messaging().channelStatus().catch(() => ({}));
  const gw = await require('./callGateway').callConfig().catch(() => ({ configured: false })); // eslint-disable-line global-require

  const doNotContact = !!(cand.doNotContact || cand.consentStatus === 'WITHDRAWN');
  const candidate = {
    id: cand.id, name: cand.name, allowed: !!rule.allowed, reason: rule.allowed ? null : (rule.reason || 'Your role does not follow up candidates.'),
    masked, doNotContact,
    phone: rule.allowed && !masked ? (cand.phone || '') : undefined,
    email: rule.allowed && !masked ? (cand.email || '') : undefined,
    phoneHint: masked ? access.maskedHint(cand.phone) : undefined,
    emailHint: masked ? access.maskedHint(cand.email) : undefined,
    hasPhone: !!cand.phone, hasEmail: !!cand.email,
    switchOn: await IN.candidateEmailsOn(),
    channels: {},
    told: told.list.map((x) => ({ channel: x.channel, status: x.status, word: x.word, told: x.told, failed: x.failed, at: x.at, by: x.by, automatic: x.automatic })),
    alreadyTold: told.told,
  };
  if (rule.allowed) {
    // Call: a number to dial, or TeamLink rings both sides
    candidate.channels.Call = doNotContact
      ? { state: 'blocked', reason: 'This person asked not to be contacted (consent withdrawn).' }
      : (!cand.phone ? { state: 'none', reason: 'No phone number on file.' }
        : (masked ? (gw.configured ? { state: 'send', reason: null, via: 'teamlink' } : { state: 'fallback', reason: 'Calling through TeamLink is not connected: ask the recruiter to call.', ask: true })
          : { state: 'send', reason: null, via: gw.configured ? 'both' : 'phone' }));
    // the three dry runs side by side (each one is a full "could this go?" check)
    const states = await Promise.all(CHANNELS.map((ch) => channelState(user, app, kind, ch, masked)));
    CHANNELS.forEach((ch, i) => {
      const st = states[i];
      candidate.channels[ch] = { ...st, connected: !!(status[ch] && status[ch].configured) };
      if (masked && st.state === 'fallback') candidate.channels[ch].ask = true; // the number stays hidden: "ask the recruiter"
    });
  }
  const sample = ['WhatsApp', 'Email', 'SMS'].map((c) => candidate.channels[c]).find((c) => c && c.text);
  candidate.preview = sample ? { text: sample.text, subject: sample.subject } : null;

  // the parties
  const notified = await notifiedMap(app, kind, since);
  const mailOk = !!(status.Email && status.Email.configured);
  const people = await partiesOf(app);
  const parties = people.map((p) => {
    const n = p.userId ? notified.get(p.userId) : null;
    return {
      key: p.key, name: p.name, roles: p.roles, roleLine: roleLine(p.roles), external: p.external, you: p.userId === user.id,
      notified: n ? { at: n.at, how: n.manual ? 'You told them' : 'App notice sent automatically' } : null,
      canMail: !!p.email && mailOk, hasPhone: !!p.phone, canBell: !!p.userId,
    };
  });

  const canNotify = (await canDo(user, 'create')) || (await canDo(user, 'edit'));
  const r = app.requirement || {};
  const isStaff = !['CLIENT', 'CANDIDATE'].includes(user.role);
  return {
    kind,
    interview: {
      applicationId: app.id, candidateName: cand.name, job: r.title || '', client: isStaff ? (r.internal ? 'TeamLink' : (r.client && r.client.name) || '') : undefined,
      round: app.interviewRound || 1, when: IN.when(app.interviewAt), at: app.interviewAt, mode: app.interviewMode || '', meetingLink: app.interviewMeetingLink || '',
      location: app.interviewLocation || '', interviewer: app.interviewer || '', status: app.interviewStatus,
    },
    candidate, parties, canNotify,
    channels: { Email: !!(status.Email && status.Email.configured), SMS: !!(status.SMS && status.SMS.configured), WhatsApp: !!(status.WhatsApp && status.WhatsApp.configured) },
    callThrough: !!gw.configured,
    purposeKey: IM.PURPOSE_OF[kind], purposeLabel: IM.LABEL_OF[IM.PURPOSE_OF[kind]],
  };
}

// ---- send on every channel that can go --------------------------------------------------------------------
async function sendAll(user, appId, askedKind, { again = false } = {}) {
  const app = await prisma.application.findUnique({ where: { id: appId }, include: APP_INCLUDE });
  if (!app) return { error: 'No such interview.', status: 404 };
  const kind = kindOf(app, askedKind);
  const rule = await lazy.access().ruleFor(user, 'candidates');
  if (!rule.allowed) return { error: rule.reason || 'Your role does not follow up candidates.', status: 403 };
  const masked = rule.mode === 'masked';
  const told = await toldSummary(app, kind);
  const purposeKey = IM.PURPOSE_OF[kind];
  const attempts = [];
  const fallbacks = [];
  // each channel has its own sending lane, so they go side by side
  const one = async (ch) => {
    const was = told.byChannel[ch];
    if (was && was.told && !again) return { channel: ch, status: 'already', reason: `${was.word} already.` };
    const st = await channelState(user, app, kind, ch, masked);
    if (st.state !== 'send') {
      if (st.state === 'fallback') fallbacks.push({ channel: ch, how: masked ? 'Ask the recruiter to send it.' : ({ WhatsApp: 'Press WhatsApp above: it opens on your phone with the message ready.', Email: 'Press Mail above: it opens your mail app with the message ready.', SMS: 'Press SMS above and copy the message.' })[ch] });
      return { channel: ch, status: st.state === 'fallback' ? 'not connected' : st.state, reason: st.reason };
    }
    const out = await lazy.omni().send(user, {
      audience: 'candidates', id: app.candidateId, channel: ch, applicationId: app.id, purposeKey, purpose: IM.LABEL_OF[purposeKey], urgent: true,
    });
    if (out.ok) return { channel: ch, status: out.stillSending ? 'sending' : 'sent', reason: null, sandbox: !!(out.result && out.result.sandbox) };
    return { channel: ch, status: 'failed', reason: out.error || 'The message could not be sent.' };
  };
  attempts.push(...(await Promise.all(CHANNELS.map(one))));
  const sent = attempts.filter((a) => ['sent', 'sending'].includes(a.status)).length;
  return { ok: true, kind, attempts, fallbacks, sent, nothingSent: sent === 0 };
}

// ---- a copy / paste is a contact too ---------------------------------------------------------------------------
async function logCopied(user, appId, channel, askedKind) {
  const app = await prisma.application.findUnique({ where: { id: appId }, include: APP_INCLUDE });
  if (!app) return { error: 'No such interview.', status: 404 };
  if (!CHANNELS.includes(channel)) return { error: 'Say WhatsApp, SMS or Email.', status: 400 };
  const rule = await lazy.access().ruleFor(user, 'candidates');
  if (!rule.allowed || rule.mode === 'masked') return { error: rule.allowed ? 'The words can be copied only by a login that sees the number.' : rule.reason, status: 403 };
  const kind = kindOf(app, askedKind);
  const purposeKey = IM.PURPOSE_OF[kind];
  const { senderIdentity } = require('./candidateComms'); // eslint-disable-line global-require
  await prisma.candidateMessage.create({
    data: {
      candidateId: app.candidateId, applicationId: app.id, channel, template: 'MANUAL', templateLabel: IM.LABEL_OF[purposeKey], trigger: 'Manual',
      recipient: channel === 'Email' ? (app.candidate.email || '') : (app.candidate.phone || ''), body: 'Message copied by the sender to send from their own phone',
      status: 'COPIED', statusDetail: 'Copied from the booking window - the app cannot see whether it was sent', ...(await senderIdentity(user)),
    },
  });
  return { ok: true };
}

// ---- tell the staff ----------------------------------------------------------------------------------------------
// who: array of party keys, or 'all'. Bell for a login; mail when the person has an address and mail is connected;
// WhatsApp / SMS only when that channel is connected AND the number is on file (the normal one-person send checks the
// rest: WhatsApp needs an approved wording to start a chat).
async function notify(user, appId, askedKind, who) {
  const app = await prisma.application.findUnique({ where: { id: appId }, include: APP_INCLUDE });
  if (!app) return { error: 'No such interview.', status: 404 };
  if (!((await canDo(user, 'create')) || (await canDo(user, 'edit')))) return { error: "This action isn't included in your role's permissions", status: 403 };
  const kind = kindOf(app, askedKind);
  const IN = lazy.IN();
  const people = await partiesOf(app);
  const chosen = who === 'all' ? people : people.filter((p) => (Array.isArray(who) ? who : []).includes(p.key));
  if (!chosen.length) return { error: 'Pick who to tell.', status: 400 };
  const status = await lazy.messaging().channelStatus().catch(() => ({}));
  const name = app.candidate ? app.candidate.name : 'Candidate';
  const title = staffTitle(kind, name);
  const detail = IN.staffLines(app, kind).join(' · ');
  const mailText = ['Hello,', '', ...IN.staffLines(app, kind), '', 'Open TeamLink → Interviews for the details.', '', '— TeamLink'].join('\n');
  const results = [];
  for (const p of chosen) {
    const line = { key: p.key, name: p.name, bell: false, email: null, whatsapp: null, sms: null };
    if (p.userId && p.userId === user.id) { results.push({ ...line, skipped: 'That is you.' }); continue; } // eslint-disable-line no-continue
    if (p.userId) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.notification.create({ data: { userId: p.userId, title, message: detail, channel: 'In-App', recipient: `interview-notify|${kind}|${app.id}|${p.userId}`, status: 'Sent' } });
      line.bell = true;
    }
    if (p.email) {
      if (p.external && !(await IN.candidateEmailsOn())) line.email = { ok: false, reason: 'Outside people are emailed only while the "Candidate emails" switch is on.' };
      else if (!(status.Email && status.Email.configured)) line.email = { ok: false, reason: 'Company mail is not connected.' };
      else {
        // eslint-disable-next-line no-await-in-loop
        const r = await IN.mailTo(p.email, title.replace(/^[^\w]+\s*/, ''), mailText);
        line.email = r && r.ok ? { ok: true } : { ok: false, reason: (r && r.error) || 'The mail could not be sent.' };
      }
    } else if (!p.external) line.email = { ok: false, reason: 'No email address on file.' };
    // WhatsApp / SMS: only when that channel is connected AND the person's phone is on file (the normal
    // one-person send decides the rest, e.g. WhatsApp needs an approved wording to start a chat).
    if (p.userId && p.phone) {
      const ENGINE = require('./interviewEngine'); // eslint-disable-line global-require
      for (const ch of ['WhatsApp', 'SMS']) {
        if (!(status[ch] && status[ch].configured)) continue; // eslint-disable-line no-continue
        // eslint-disable-next-line no-await-in-loop
        const r = await ENGINE.sendStaffText(app, p, ch, `${title}
${detail}`);
        line[ch === 'WhatsApp' ? 'whatsapp' : 'sms'] = r.ok ? { ok: true } : { ok: false, reason: r.reason };
      }
    }
    results.push(line);
  }
  return { ok: true, kind, results, told: results.filter((r) => r.bell || (r.email && r.email.ok) || (r.whatsapp && r.whatsapp.ok) || (r.sms && r.sms.ok)).length };
}

module.exports = {
  KINDS, kindOf, eventTime, toldSummary, partiesOf, payload, sendAll, logCopied, notify, channelState, staffTitle, TOLD_STATUS, WORD,
};
