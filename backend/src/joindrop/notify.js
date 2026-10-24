// ---------------------------------------------------------------------------
// JOINING & DROP - TELLING PEOPLE (bell + email + task + candidate message).
//
// Three moments (joindrop/settings.js holds one switch per party and way for each):
//   join      a candidate joined  -> client, recruiter, TL, BDE, HR, and the candidate (a welcome)
//   drop      a joined candidate dropped (reported by anyone) -> client (if the report did not come from them), recruiter, TL, BDE, HR,
//             and the candidate (OFF unless an Admin switches it on)
//   decision  the client decided about a replacement -> recruiter, TL, BDE, HR (+ a task: "Find a replacement ..." or "Check the credit note ...")
//   withdrawn a drop was reported by mistake and withdrawn -> the same people as a drop
//
// RULES THIS FILE KEEPS
//   * EMAIL goes through utils/hrmsNotify.js notify(): the "Notification emails" master switch, the plain status words, the 3-step retry of a
//     failed email. Switch OFF = the bell and the tasks still happen and the notice says "emails are switched off".
//   * ONE notice per person per way per event (JoinDropNotice has a unique index on event + way + person); a second try writes nothing.
//   * Every notice is written to JoinDropNotice with the result in plain words. A failure NEVER breaks the action: it is caught, logged, and
//     the person who acted is simply told "saved, but ... could not be sent" by the caller through the returned summary.
//   * The client gets email ONLY at the company's registered contact addresses (Client contact + second contact); the portal logins get the bell.
//   * Never the candidate's phone, email or pay in any notice. The candidate message never names the client (it says "our client").
//   * The candidate message respects consent (doNotContact / consent withdrawn), the STOP list, the "Candidate emails" master switch and
//     the Email / WhatsApp channel being connected. Test people (ZZTEST / example.test) are skipped on the real server.
//   * Wording comes from the Message templates hub (JOINING_CONFIRMED, JOINING_WELCOME, CANDIDATE_DROPPED, DROP_CANDIDATE_NOTICE,
//     REPLACEMENT_DECISION); the starter words are joindrop/messageDefaults.js.
//   * Wording never says "agreement" or "Draft" (the notice filter drops agreement lines for TL / Recruiter / HR; nothing here needs it).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const S = require('./schema');
const V = require('./vocab');
const SET = require('./settings');

const sandbox = () => require('../utils/sandbox').isSandbox(); // eslint-disable-line global-require
const TEST_RE = /zztest|example\.test/i;
const skipTest = (...v) => !sandbox() && TEST_RE.test(v.filter(Boolean).join(' '));
const id = () => `jd${crypto.randomBytes(10).toString('hex')}`;
const lc = (s) => String(s || '').trim().toLowerCase();

const EVENT_KEY = { join: 'joinNotice', drop: 'dropNotice', withdrawn: 'dropNotice', decision: 'replacementDecision', taskCancelled: 'replacementDecision' };
const SETTING_OF = { join: 'join', drop: 'drop', withdrawn: 'drop', decision: 'decision', taskCancelled: 'decision' };
const OPEN = (rec) => `/ats/joining?view=joindrop&record=${rec.id}`;

// --- the people -------------------------------------------------------------------
async function usersByIds(ids) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return [];
  const rows = await prisma.user.findMany({ where: { id: { in: list }, status: 'Active' }, select: { id: true, name: true, email: true } });
  return rows.filter((u) => !skipTest(u.name, u.email)).map((u) => ({ userId: u.id, name: u.name, email: u.email || null }));
}

// "HR" here is the Joining & Drop HR LIST (settings.hrPeople: employee codes, default TL309), not every HR login.
async function hrPeople() {
  const codes = (await SET.get()).hrPeople;
  if (!codes.length) return [];
  const emps = await prisma.employee.findMany({ where: { employeeCode: { in: [...codes, ...codes.map((c) => c.toLowerCase())] } }, select: { userId: true } });
  const ids = emps.map((e) => e.userId).filter(Boolean);
  if (!ids.length) return [];
  const rows = await prisma.user.findMany({ where: { status: 'Active', id: { in: ids } }, select: { id: true, name: true, email: true } });
  return rows.filter((u) => !skipTest(u.name, u.email)).map((u) => ({ userId: u.id, name: u.name, email: u.email || null }));
}

// -> { recruiter, tl, bde, hr, client:{ users, emails }, candidate } for a record.
async function peopleFor(record) {
  const req = record.requirementId
    ? await prisma.requirement.findUnique({ where: { id: record.requirementId }, include: { client: true } }).catch(() => null)
    : null;
  const CB = require('../utils/clientBdes'); // eslint-disable-line global-require
  const extraRecruiters = req ? String(req.recruiterIds || '').split(',').map((s) => s.trim()) : [];
  const recruiterIds = record.recruiterUserId ? [record.recruiterUserId] : [req && req.recruiterId, ...extraRecruiters];
  const tlIds = record.tlUserId ? [record.tlUserId] : [req && req.tlId];
  let bdeIds = [record.bdeUserId, ...(req && !req.internal ? await CB.ownerBdeIds(req) : [])];
  const bde = await usersByIds(bdeIds);
  if (!bde.length && req && !req.internal) bdeIds = await CB.bdeTlIds(); // no BDE named on the client: the BDE team lead
  const client = req && !req.internal ? req.client : null;
  const clientUsers = client
    ? (await prisma.user.findMany({ where: { clientId: client.id, status: 'Active', OR: [{ role: 'CLIENT' }, { atsRole: 'CLIENT' }] }, select: { id: true, name: true, email: true } }))
      .filter((u) => !skipTest(u.name, u.email)).map((u) => ({ userId: u.id, name: u.name, email: null }))
    : [];
  const emails = [];
  if (client) {
    [[client.contactName, client.contactEmail], [client.secondaryContactName, client.secondaryContactEmail]].forEach(([n, e]) => {
      const addr = String(e || '').trim();
      if (addr && !emails.some((x) => lc(x.email) === lc(addr)) && !skipTest(client.name, addr)) emails.push({ userId: null, name: n || client.name, email: addr });
    });
  }
  const cand = record.candidateId ? await prisma.candidate.findUnique({ where: { id: record.candidateId } }).catch(() => null) : null;
  let recruiters = await usersByIds(recruiterIds);
  if (!recruiters.length && req) recruiters = await usersByIds([req.recruiterId, ...extraRecruiters]);
  return {
    recruiter: recruiters,
    tl: await usersByIds(tlIds),
    bde: bde.length ? bde : await usersByIds(bdeIds),
    hr: await hrPeople(),
    client: { users: clientUsers, emails },
    candidate: cand,
  };
}

// --- the words --------------------------------------------------------------------
function withinWords(rec) {
  if (rec.dropWithinGuarantee === 1) {
    return `Inside the replacement period (day ${rec.dropDaysSinceJoining != null ? rec.dropDaysSinceJoining : '?'} of ${rec.guaranteeDays || '?'})`;
  }
  if (rec.dropWithinGuarantee === 0) return `After the replacement period${rec.guaranteeEndsOn ? ` (it ended on ${V.dmy(rec.guaranteeEndsOn)})` : ''}`;
  return 'Not known (no replacement period is set for this client)';
}

function tokensFor(rec, person, extra = {}) {
  const abs = (p) => { try { return require('../utils/pendingWork').absolute(p); } catch { return p; } }; // eslint-disable-line global-require
  const dec = V.DECISIONS[rec.replacementDecision];
  return {
    name: person.name || 'there',
    firstName: V.firstName(person.name),
    candidate: rec.candidateName || 'The candidate',
    role: rec.jobTitle || 'the requirement',
    client: extra.clientWord || rec.clientName || 'the client',
    joinedOn: V.dmy(rec.joinedOn),
    joinLocation: rec.location || 'Not recorded',
    droppedOn: V.dmy(rec.droppedOn),
    lastDay: rec.lastWorkingDay ? V.dmy(rec.lastWorkingDay) : 'Not recorded',
    dropReason: rec.dropReason || 'Not recorded',
    dropDetails: rec.dropReasonDetail ? `Details: ${rec.dropReasonDetail}\n` : '',
    withinGuarantee: withinWords(rec),
    reportedBy: [rec.dropReportedByName, rec.dropReportedFrom ? `(${rec.dropReportedFrom})` : ''].filter(Boolean).join(' ') || 'Not recorded',
    decision: dec ? dec.label : 'Not decided yet',
    decisionNote: rec.replacementComment || 'None',
    expectedOn: rec.replacementExpectedOn ? V.dmy(rec.replacementExpectedOn) : 'Not given',
    openLink: extra.openPath ? `Open it in TeamLink: ${abs(extra.openPath)}` : '',
  };
}

async function wording(purpose, channel, tokens) {
  const T = require('../utils/messageTemplates'); // eslint-disable-line global-require
  let tpl = null;
  try { tpl = await T.resolve({ purpose, channel }); } catch { tpl = null; }
  if (!tpl) tpl = require('./messageDefaults').find(purpose, channel) || { subject: '{{candidate}}', body: '{{candidate}}' }; // eslint-disable-line global-require
  const subject = T.render(tpl.subject || '', tokens, { blank: '' }).text.trim();
  const body = T.render(tpl.body || '', tokens, { blank: '' }).text.replace(/\n{3,}/g, '\n\n').trim();
  return { subject: subject || tokens.candidate, body, tpl };
}

function htmlOf(title, body, openPath) {
  try {
    const M = require('../utils/reportMailHtml'); // eslint-disable-line global-require
    const abs = require('../utils/pendingWork').absolute; // eslint-disable-line global-require
    const lines = String(body).split('\n').filter((l) => l.trim() && !/^Open it in TeamLink:/.test(l));
    return M.page(title, lines.map((l) => M.p(l)).join('') + (openPath ? M.button(abs(openPath), 'Open the record') : ''));
  } catch { return null; }
}

// --- the log ------------------------------------------------------------------------
async function logNotice({ recordId, eventId, party, channel, key, name, email, userId, status, detail }) {
  try {
    const n = await S.run(
      'INSERT OR IGNORE INTO "JoinDropNotice" ("id","recordId","eventId","party","channel","recipientKey","recipientName","recipientEmail","userId","status","detail","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      id(), recordId, eventId, party, channel, key, name || null, email || null, userId || null, String(status || '').slice(0, 300), detail ? String(detail).slice(0, 400) : null, V.nowIso(),
    );
    const wrote = Number(n) > 0;
    // EVERY notice that is not a bell (email sent / skipped / failed, candidate message, task) is also in the Audit Log.
    if (wrote && channel !== 'Bell') {
      await require('../utils/audit').logAudit({ // eslint-disable-line global-require
        action: `Joining notice (${party}, ${channel}): ${String(status || '').slice(0, 120)}`.slice(0, 190), entity: 'JoiningRecord', entityId: recordId,
        toValue: `${name || email || ''} · ${String(detail || '').slice(0, 120)}`.slice(0, 300), actorName: 'TeamLink',
      });
    }
    return wrote;
  } catch (e) { console.error('[join-drop] notice log:', e.message); return false; } // eslint-disable-line no-console
}
const alreadyTold = async (eventId, channel, key) => !!(await S.one('SELECT "id" FROM "JoinDropNotice" WHERE "eventId" = ? AND "channel" = ? AND "recipientKey" = ?', eventId, channel, key));

// --- one person -----------------------------------------------------------------------
async function sendOne({
  moment, record, ev, party, person, bell, email, title, shortLine, body, html, openPath, ctx, out,
}) {
  const key = person.userId || lc(person.email);
  if (!key) return;
  const base = { recordId: record.id, eventId: ev.id, party, name: person.name, email: person.email, userId: person.userId };
  // the bell
  if (person.userId) {
    if (!bell) {
      if (!(await alreadyTold(ev.id, 'Bell', key))) await logNotice({ ...base, channel: 'Bell', key, status: 'Switched off for this person in the settings' });
    } else if (!(await alreadyTold(ev.id, 'Bell', key))) {
      let status = 'Delivered';
      try {
        await prisma.notification.create({
          data: {
            userId: person.userId, title, message: `${shortLine}${openPath ? `\nOpen: ${openPath}` : ''}`, channel: 'In-App', recipient: person.name || null, status: 'Delivered',
          },
        });
      } catch (e) { status = `Failed: ${String(e.message).slice(0, 120)}`; }
      await logNotice({ ...base, channel: 'Bell', key, status });
      out.bells += 1;
    }
  }
  // the email
  if (!person.email) {
    if (person.userId && email && !(await alreadyTold(ev.id, 'Email', key))) await logNotice({ ...base, channel: 'Email', key, status: 'Not sent: no email address on this login' });
    return;
  }
  const ekey = lc(person.email);
  if (await alreadyTold(ev.id, 'Email', ekey)) return;
  if (!email) {
    await logNotice({ ...base, channel: 'Email', key: ekey, status: 'Switched off for this person in the settings' });
    return;
  }
  try {
    const HN = require('../utils/hrmsNotify'); // eslint-disable-line global-require
    const hs = await HN.getSettings();
    const evKey = EVENT_KEY[moment];
    const settings = { ...hs, events: { ...hs.events, [evKey]: { inApp: false, email: hs.events[evKey] ? hs.events[evKey].email : true, mode: 'now' } } };
    const r = await HN.notify(evKey, { userId: person.userId || null, name: person.name, email: person.email }, { title, message: body, html }, { settings, ...(ctx.mailer ? { mailer: ctx.mailer } : {}) });
    const status = r.email || 'Already sent today (not sent twice)';
    await logNotice({ ...base, channel: 'Email', key: ekey, status });
    out.emails.push({ to: person.email, status });
  } catch (e) {
    await logNotice({ ...base, channel: 'Email', key: ekey, status: `Failed: ${String(e.message).slice(0, 150)}` });
    out.problems.push(`The email to ${person.name || person.email} could not be sent.`);
  }
}

// --- the candidate ----------------------------------------------------------------------
// ONE function for the welcome, the automatic drop notice and the manual "Send notice to the candidate" button.
//   auto   true for the two automatic ones: they send only with a valid reason (drop), a recipient, consent and an APPROVED template
//          (Email: the template is switched on; WhatsApp: its approval status is Approved). Otherwise the message is recorded as
//          NOT SENT with the plain reason.
//   edited { subject, body } the wording a person edited in the preview (manual only)
// Every outcome is a JoinDropNotice row and an Audit Log row.
async function candidateNotice({
  moment, record, ev, cand, channels, edited = null, auto = true, ctx = {}, out,
}) {
  if (!cand) return;
  const purpose = moment === 'join' ? 'JOINING_WELCOME' : 'DROP_CANDIDATE_NOTICE';
  if (!channels.length) return;
  const IN = require('../utils/interviewNotices'); // eslint-disable-line global-require
  const delivery = require('../utils/messageDelivery'); // eslint-disable-line global-require
  const switchedOn = await IN.candidateEmailsOn();
  const tokens = tokensFor(record, { name: cand.name }, { clientWord: 'our client' });
  const stat = await require('../utils/messaging').channelStatus().catch(() => ({})); // eslint-disable-line global-require
  for (const channel of channels) {
    const key = `cand:${channel}`;
    if (await alreadyTold(ev.id, 'Candidate message', key)) continue; // eslint-disable-line no-await-in-loop
    const recipient = channel === 'Email' ? (cand.email || '') : (cand.phone || '');
    const label = purpose === 'JOINING_WELCOME' ? 'Joining welcome' : 'Drop notice';
    // eslint-disable-next-line no-await-in-loop
    const w = await wording(purpose, channel, tokens);
    const subject = edited && edited.subject ? V.clean(edited.subject, 200) : w.subject;
    const body = edited && edited.body ? V.cleanLong(edited.body, channel === 'Email' ? 4000 : 1000) : w.body;
    let blocked = null;
    if (skipTest(cand.name, cand.email)) blocked = 'Not sent: test person, never contacted';
    else if (moment !== 'join' && (!record.dropReason || /^not recorded$/i.test(record.dropReason))) blocked = 'Not sent: there is no valid reason recorded for the drop';
    else if (cand.doNotContact || cand.consentStatus === 'WITHDRAWN') blocked = 'Not sent: the candidate asked not to be contacted';
    else if (!recipient) blocked = `Not sent: no ${channel === 'Email' ? 'email address' : 'phone number'} on the candidate's record`;
    else if (channel !== 'Email' && await delivery.optedOut(channel, recipient).catch(() => null)) blocked = 'Not sent: the candidate replied STOP on this channel'; // eslint-disable-line no-await-in-loop
    else if (auto && channel === 'WhatsApp' && !(w.tpl && w.tpl.waStatus === 'Approved')) blocked = 'Not sent: there is no approved WhatsApp message template for this notice';
    else if (auto && channel === 'Email' && w.tpl && w.tpl.active === false) blocked = 'Not sent: the email template for this notice is switched off';
    else if (!body.trim()) blocked = 'Not sent: the message is empty';
    const live = !blocked && switchedOn && !!(stat[channel] && stat[channel].configured);
    const status = blocked ? 'NOT_SENT_BLOCKED' : (!switchedOn ? IN.SWITCHED_OFF : (live ? 'QUEUED' : 'NOT_SENT_NO_PROVIDER'));
    const detail = blocked || (!switchedOn ? `${IN.SWITCHED_OFF_DETAIL}.` : (live ? 'Queued for sending.' : 'Recorded, not transmitted: this channel is not connected.'));
    try {
      // eslint-disable-next-line no-await-in-loop
      await prisma.candidateMessage.create({
        data: {
          candidateId: cand.id, applicationId: record.applicationId, channel, template: purpose, templateLabel: label, trigger: `Joining and drop: ${label}${auto ? '' : ' (sent by hand)'}`,
          recipient, subject: channel === 'Email' ? subject : null, body, status, statusDetail: detail,
          senderUserId: ev.byId || null, senderName: ev.byName || 'TeamLink',
        },
      });
      const said = blocked || (live ? 'Queued for sending' : detail);
      // eslint-disable-next-line no-await-in-loop
      await logNotice({ recordId: record.id, eventId: ev.id, party: 'candidate', channel: 'Candidate message', key, name: cand.name, userId: null, status: said, detail: channel });
      out.candidate.push({ channel, status: said, sent: live });
      if (live) { try { require('../utils/mailWorker').kick(); } catch { /* the worker's next tick picks it up */ } } // eslint-disable-line global-require
    } catch (e) { out.problems.push(`The ${channel} message to the candidate could not be recorded.`); console.error('[join-drop] candidate message:', e.message); } // eslint-disable-line no-console
  }
}

// What the manual notice would say, and what stops it (shown in the editable preview; nothing is saved or sent).
async function noticePreview(record) {
  const cand = record.candidateId ? await prisma.candidate.findUnique({ where: { id: record.candidateId } }).catch(() => null) : null;
  if (!cand) return { channels: [] };
  const IN = require('../utils/interviewNotices'); // eslint-disable-line global-require
  const delivery = require('../utils/messageDelivery'); // eslint-disable-line global-require
  const stat = await require('../utils/messaging').channelStatus().catch(() => ({})); // eslint-disable-line global-require
  const tokens = tokensFor(record, { name: cand.name }, { clientWord: 'our client' });
  const switchedOn = await IN.candidateEmailsOn();
  const channels = [];
  for (const channel of ['Email', 'WhatsApp']) {
    const recipient = channel === 'Email' ? cand.email : cand.phone;
    // eslint-disable-next-line no-await-in-loop
    const w = await wording('DROP_CANDIDATE_NOTICE', channel, tokens);
    let problem = null;
    if (!record.dropReason || /^not recorded$/i.test(record.dropReason)) problem = 'There is no valid reason recorded for the drop.';
    else if (cand.doNotContact || cand.consentStatus === 'WITHDRAWN') problem = 'The candidate asked not to be contacted.';
    else if (!recipient) problem = `There is no ${channel === 'Email' ? 'email address' : 'phone number'} on the candidate's record.`;
    else if (channel !== 'Email' && await delivery.optedOut(channel, recipient).catch(() => null)) problem = 'The candidate replied STOP on this channel.'; // eslint-disable-line no-await-in-loop
    channels.push({
      channel, subject: channel === 'Email' ? w.subject : '', body: w.body, problem,
      connected: !!(stat[channel] && stat[channel].configured), masterSwitchOn: switchedOn,
      reach: recipient ? (channel === 'Email' ? 'The email address on file' : 'The phone number on file') : null,
    });
  }
  return { channels, masterSwitchOn: switchedOn };
}

// The manual "Send notice to candidate" button: a person (HR / an authorized user) reviews the wording, may edit it, and sends.
async function sendNoticeByHand({
  record, ev, channels, edited, ctx = {},
}) {
  const out = {
    bells: 0, emails: [], candidate: [], problems: [], emailsOn: true,
  };
  const cand = record.candidateId ? await prisma.candidate.findUnique({ where: { id: record.candidateId } }) : null;
  await candidateNotice({ moment: 'drop', record, ev, cand, channels, edited, auto: false, ctx, out });
  return out;
}

// --- the moment --------------------------------------------------------------------------
// ev: the JoiningEvent row ({ id, byId, byName, kind, ... }). Returns { bells, emails:[{to,status}], candidate:[], problems:[], emailsOn }.
async function tell({ moment, record, ev, ctx = {} }) {
  const out = {
    bells: 0, emails: [], candidate: [], problems: [], emailsOn: true,
  };
  try {
    const settings = await SET.get();
    const cfg = settings[SETTING_OF[moment]];
    const HN = require('../utils/hrmsNotify'); // eslint-disable-line global-require
    out.emailsOn = (await HN.getSettings()).emailsOn === true;
    const ppl = await peopleFor(record);
    const fromClient = ev.fromWhere === 'Client login';
    const dec = V.DECISIONS[record.replacementDecision];
    const purpose = moment === 'join' ? 'JOINING_CONFIRMED' : (moment === 'decision' ? 'REPLACEMENT_DECISION' : 'CANDIDATE_DROPPED');
    const who = record.candidateName || 'The candidate';
    const clientName = record.clientName || 'the client';
    let title;
    let shortLine;
    if (moment === 'join') {
      title = `${who} joined ${clientName} on ${V.dmy(record.joinedOn)}`;
      shortLine = `${record.jobTitle || 'Requirement'}: joined ${V.dmy(record.joinedOn)}${record.location ? ` at ${record.location}` : ''}.`;
    } else if (moment === 'decision') {
      title = `${clientName}: ${dec ? dec.short : 'decision'} for ${who} (dropped ${V.dmy(record.droppedOn)})`;
      shortLine = `${record.jobTitle || 'Requirement'}: ${dec ? dec.label : 'decision'}${record.replacementComment ? `. Client says: ${record.replacementComment}` : ''}.`;
    } else if (moment === 'withdrawn') {
      title = `Drop withdrawn: ${who} (${clientName}) is still working`;
      shortLine = `${record.jobTitle || 'Requirement'}: the drop reported earlier was a mistake. ${who} is back as Joined.`;
    } else if (moment === 'taskCancelled') {
      title = `Replacement task cancelled: ${who} (${clientName})`;
      shortLine = `${record.jobTitle || 'Requirement'}: the "Find a replacement" task was cancelled by ${ev.byName || 'a team member'}. Reason: ${ev.note || 'not given'}.`;
    } else {
      title = `${who} dropped from ${clientName} (${V.dmy(record.droppedOn)})`;
      shortLine = `${record.jobTitle || 'Requirement'}: reason ${record.dropReason || 'not recorded'}. ${withinWords(record)}.`;
    }
    const staffParties = [['recruiter', ppl.recruiter], ['tl', ppl.tl], ['bde', ppl.bde], ['hr', ppl.hr]];
    for (const [party, people] of staffParties) {
      const sw = cfg[party];
      if (!sw) continue; // eslint-disable-line no-continue
      for (const person of people) {
        if (ev.byId && person.userId === ev.byId) continue; // eslint-disable-line no-continue
        // eslint-disable-next-line no-await-in-loop
        const custom = moment === 'withdrawn' || moment === 'taskCancelled';
        const w = custom
          ? { subject: title, body: `Hi ${V.firstName(person.name)},\n\n${moment === 'withdrawn' ? `The drop reported for ${who} (${record.jobTitle || 'the requirement'}, ${clientName}) was a mistake and has been withdrawn. ${who} is shown as Joined again.` : `The "Find a replacement" task for ${who} (${record.jobTitle || 'the requirement'}, ${clientName}) was cancelled by ${ev.byName || 'a team member'}.`}\n${ev.note ? `Reason: ${ev.note}\n` : ''}\nOpen it in TeamLink: ${require('../utils/pendingWork').absolute(OPEN(record))}\n\n- TeamLink` } // eslint-disable-line global-require
          : await wording(purpose, 'Email', tokensFor(record, person, { openPath: OPEN(record) }));
        // eslint-disable-next-line no-await-in-loop
        await sendOne({
          moment, record, ev, party, person, bell: sw.bell, email: sw.email, title: custom ? title : (w.subject || title), shortLine, body: w.body, html: htmlOf(w.subject || title, w.body, OPEN(record)), openPath: OPEN(record), ctx, out,
        });
      }
    }
    // the client (a drop reported by the client itself is not told back to them; their own decision is not told back either)
    if (moment !== 'decision' && moment !== 'taskCancelled' && cfg.client && !fromClient) {
      const sw = cfg.client;
      const portalPath = '/client-portal?tab=joindrop';
      for (const person of ppl.client.users) {
        // eslint-disable-next-line no-await-in-loop
        await sendOne({
          moment, record, ev, party: 'client', person, bell: sw.bell, email: false, title, shortLine, body: shortLine, html: null, openPath: portalPath, ctx, out,
        });
      }
      for (const person of ppl.client.emails) {
        // eslint-disable-next-line no-await-in-loop
        const w = moment === 'withdrawn'
          ? { subject: title, body: `Hi ${V.firstName(person.name)},\n\nThe drop reported for ${who} (${record.jobTitle || 'the requirement'}) was a mistake and has been withdrawn. ${who} is shown as Joined again.\n\n- TeamLink` }
          : await wording(purpose, 'Email', tokensFor(record, person, { openPath: ppl.client.users.length ? portalPath : '' }));
        // eslint-disable-next-line no-await-in-loop
        await sendOne({
          moment, record, ev, party: 'client', person, bell: false, email: sw.email, title: moment === 'withdrawn' ? title : (w.subject || title), shortLine, body: w.body, html: htmlOf(w.subject || title, w.body, null), openPath: null, ctx, out,
        });
      }
    }
    // the candidate (join: a welcome; drop: only when an Admin switched it on)
    if ((moment === 'join' || moment === 'drop') && cfg.candidate) {
      const chans = [['Email', cfg.candidate.email], ['WhatsApp', cfg.candidate.whatsapp]].filter(([, on]) => on).map(([c]) => c);
      await candidateNotice({ moment, record, ev, cand: ppl.candidate, channels: chans, auto: true, ctx, out });
    }
  } catch (e) {
    console.error('[join-drop] tell:', e.message); // eslint-disable-line no-console
    out.problems.push('Some people could not be told. The record is saved.');
  }
  return out;
}

// Who WOULD be told (for the plain "these people will be told" line in the confirm dialog). No names of the candidate's contact details.
async function preview(record, moment, { fromClient = false } = {}) {
  const settings = await SET.get();
  const cfg = settings[SETTING_OF[moment]];
  const ppl = await peopleFor(record);
  const parties = [];
  const add = (party, count, sw) => {
    if (!sw) return;
    const ways = [sw.bell ? 'bell' : null, sw.email ? 'email' : null, sw.whatsapp ? 'WhatsApp' : null].filter(Boolean);
    if (count > 0 && ways.length) parties.push({ party, word: SET.PARTY_WORDS[party], count, ways });
  };
  add('recruiter', ppl.recruiter.length, cfg.recruiter);
  add('tl', ppl.tl.length, cfg.tl);
  add('bde', ppl.bde.length, cfg.bde);
  add('hr', ppl.hr.length, cfg.hr);
  if (moment !== 'decision' && !fromClient) add('client', ppl.client.users.length + ppl.client.emails.length, cfg.client);
  if ((moment === 'join' || moment === 'drop') && cfg.candidate && ppl.candidate) {
    const ways = [cfg.candidate.email ? 'email' : null, cfg.candidate.whatsapp ? 'WhatsApp' : null].filter(Boolean);
    if (ways.length) parties.push({ party: 'candidate', word: SET.PARTY_WORDS.candidate, count: 1, ways });
  }
  const HN = require('../utils/hrmsNotify'); // eslint-disable-line global-require
  return { parties, emailsOn: (await HN.getSettings()).emailsOn === true };
}

// --- tasks -------------------------------------------------------------------------------
// One open task per (name, person): asking twice never doubles the work.
async function makeTask({ name, description, assignee, by, endDate, department, priority = 'High' }) {
  if (!assignee || !assignee.userId) return null;
  const open = await prisma.task.findFirst({
    where: { name, assigneeId: assignee.userId, status: { notIn: ['Completed', 'Cancelled', 'Closed'] } }, select: { id: true },
  });
  if (open) return null;
  const t = await prisma.task.create({
    data: {
      name: String(name).slice(0, 200), department: department || null, description: String(description || '').slice(0, 1500),
      status: 'Not Started', startDate: V.todayIst(), endDate: endDate || null, priority,
      assigneeId: assignee.userId, assigneeName: assignee.name || 'Team member',
      assignedById: (by && by.id) || assignee.userId, assignedByName: (by && by.name) || 'TeamLink (Joining and drop)',
    },
  });
  try { await require('../utils/hrmsNotify').taskAssigned(t, by && by.id ? by : null); } catch { /* the bell for the task is a bonus */ } // eslint-disable-line global-require
  return t;
}

// The tasks the client's decision (or an early drop, when the Admin switch is on) opens.
//   NEEDED      recruiter(s): "Find a replacement for <candidate> at <client> by <date>"
//   NOT_NEEDED  and the drop is INSIDE the replacement period: BDE + Accounts: "Check the credit note / refund ..." (a suggestion only: nothing is raised)
async function tasksFor({ kind, record, by, ev }) {
  const made = [];
  try {
    const ppl = await peopleFor(record);
    const who = record.candidateName || 'the candidate';
    const client = record.clientName || 'the client';
    const link = `Open: ${OPEN(record)}`;
    if (kind === 'replacement') {
      const by0 = record.replacementExpectedOn || V.addDays(V.todayIst(), 7);
      for (const person of ppl.recruiter) {
        // eslint-disable-next-line no-await-in-loop
        const t = await makeTask({
          name: `Find a replacement for ${who} at ${client} by ${V.dmy(by0)}`,
          description: `${who} dropped from ${client} (${record.jobTitle || 'job'}) on ${V.dmy(record.droppedOn)}. Reason: ${record.dropReason || 'not recorded'}.${record.replacementComment ? ` Client says: ${record.replacementComment}` : ''}${record.replacementProfileNotes ? ` Profile wanted: ${record.replacementProfileNotes}` : ''}\n${link}`,
          assignee: person, by, endDate: by0, department: record.department,
        });
        if (t) made.push({ taskId: t.id, for: person.name, what: t.name });
      }
    } else if (kind === 'credit') {
      // The Accounts side is the Admin's table (Who gets each reminder; default: the Accountant role). With nobody, the Admin is told once instead of being asked to do it.
      const AR = require('../utils/accountsRecipients'); // eslint-disable-line global-require
      const team = await AR.reminderRecipients({ kind: 'creditNote', allowTest: sandbox() });
      const accountants = team.users.map((u) => ({ userId: u.id, name: u.name }));
      if (team.on && !accountants.length) await AR.warnNoRecipients('creditNote', 'a credit note / refund check after a drop');
      const endDate = V.addDays(V.todayIst(), 7);
      for (const person of [...(team.on && !team.owner ? [] : ppl.bde), ...accountants]) {
        // eslint-disable-next-line no-await-in-loop
        const t = await makeTask({
          name: `Check credit note / refund for ${who} at ${client}`,
          description: `${client} does not want a replacement for ${who}, who dropped on ${V.dmy(record.droppedOn)} inside the replacement period${record.guaranteeDays ? ` (${record.guaranteeDays} days)` : ''}. Please check, as per the replacement terms, whether a credit note or refund is due. Nothing has been raised automatically.\nOpen: /invoices?tab=notes&raise=${record.applicationId}\n${link}`,
          assignee: person, by, endDate, department: record.department, priority: 'Medium',
        });
        if (t) made.push({ taskId: t.id, for: person.name, what: t.name });
      }
    }
  } catch (e) { console.error('[join-drop] tasks:', e.message); } // eslint-disable-line no-console
  if (made.length && ev) {
    for (const m of made) {
      // eslint-disable-next-line no-await-in-loop
      await logNotice({ recordId: record.id, eventId: ev.id, party: 'task', channel: 'Task', key: m.taskId, name: m.for, status: `Task made: ${m.what}`.slice(0, 280) });
    }
  }
  return made;
}

async function logTaskNotice({ record, ev, task, assignee }) {
  await logNotice({ recordId: record.id, eventId: ev.id, party: 'task', channel: 'Task', key: task.id, name: assignee.name, status: `Task made: ${task.name}`.slice(0, 280) });
}

module.exports = {
  peopleFor, tell, preview, tasksFor, makeTask, logTaskNotice, noticePreview, sendNoticeByHand, tokensFor, wording, withinWords, OPEN, EVENT_KEY, logNotice,
};
