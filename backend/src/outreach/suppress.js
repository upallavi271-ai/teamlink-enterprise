// ---------------------------------------------------------------------------
// THE SUPPRESSION ENGINE: ONE place that decides "may this person get this message?". The campaign plan (live counts), the queue
// builder (rows) and the runner (again, just before the send) all call it, so a STOP that arrives while a message waits is honoured.
//
//   decide(input)            PURE: no database. input = { campaign, contact, chan, suppressed, alreadyApplied, recentlyMessaged, atsAllowed }
//                            -> { send: true } | { send: false, reason }
//   evaluate(campaign, ids)  loads what decide() needs in batches and returns [{ contactId, contact, decision }]
//
// Reason codes (every skipped person keeps one) and the plain-words group each one is counted under:
//   internal_contact  Internal   an internal (staff) contact can never be in a job promotion (and a lead never in an internal campaign: not_internal)
//   no_phone          No phone   WhatsApp / SMS / call campaigns need a phone number
//   suppressed        Opted out  the do-not-contact (hash) list, which outlives an erased person
//   opted_out         Opted out  they unsubscribed / replied STOP / an Admin opted them out
//   no_opt_in         No permission   the file or form never said they agreed
//   bad_address       Address problem the address bounced / was marked invalid / complained
//   invalid_email     Address problem no usable email address
//   already_applied   Already applied  they applied to this job (a funnel 'applied' event, or an ATS application with the same phone / email)
//   recently_messaged Messaged recently  the same person was messaged about the SAME job within N days (Admin setting, default 7)
//   gone              Other      the contact was erased / deleted
// Order matters (the first hit wins), exactly as listed above plus the address check right after the internal rule.
//
// CHANNELS (2026-10-17): a campaign has ONE channel: email | whatsapp | sms | call. A CALL campaign is a list of call tasks for a person to ring:
// it needs a phone number and no opt-in, but skips anybody opted out on a phone channel (WhatsApp / SMS) and anybody on the do-not-contact list.
// The OutreachCampaign.channel column only allows email | whatsapp | sms (a table CHECK), so a call campaign keeps 'sms' there and its REAL channel in
// meta.channel: always ask chanOf(campaign), never read .channel directly.
// POLICY (policy.consentRules().atsAppliedMeansJobAllowed, Admin switch, default OFF): a contact copied from ATS (linkedApplicantId) whose consent is
// still 'unknown' MAY get a JOB message (type job_promotion). Never a staff message, never somebody opted out (that always wins).
// ---------------------------------------------------------------------------
const S = require('./store');
const core = require('../utils/messagingCore');
const { phoneKeys, emailKey } = require('../utils/candidateDedupe');

const CHANNELS = ['email', 'whatsapp', 'sms', 'call'];
// the REAL channel of a campaign row / object (meta.channel wins: see the note above)
function chanOf(c) {
  if (!c) return 'email';
  let m = c.meta;
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch { m = null; } }
  const real = (m && m.channel) || c.channelReal || c.channel || 'email';
  return CHANNELS.includes(real) ? real : 'email';
}

const GROUPS = {
  internal_contact: 'internal', not_internal: 'internal',
  suppressed: 'optedOut', opted_out: 'optedOut',
  no_opt_in: 'noPermission',
  bad_address: 'badAddress', invalid_email: 'badAddress',
  no_phone: 'noPhone',
  already_applied: 'alreadyApplied',
  recently_messaged: 'recentlyMessaged',
  gone: 'other',
};
const GROUP_WORDS = {
  internal: 'Internal (staff) contacts', optedOut: 'Opted out', noPermission: 'No permission to message', badAddress: 'Email address problem', noPhone: 'No phone number',
  alreadyApplied: 'Already applied to this requirement', recentlyMessaged: 'Messaged about this requirement recently', other: 'Other',
};
const REASON_WORDS = {
  internal_contact: 'Staff contact (never in a promotion message)', not_internal: 'Not a staff contact', suppressed: 'On the do-not-contact list', opted_out: 'Opted out',
  no_opt_in: 'No permission', bad_address: 'Address does not work', invalid_email: 'No valid email address', no_phone: 'No phone number', already_applied: 'Already applied',
  recently_messaged: 'Messaged about this requirement recently', gone: 'Removed', campaign_stopped: 'Campaign was stopped', daily_cap: 'Daily limit reached',
  interrupted: 'Stopped while sending: not sent again to be safe', gave_up: 'Could not be sent after 3 tries', rejected: 'The channel refused it', hard_bounce: 'Address does not exist',
  complaint: 'Marked as spam', no_address: 'No address to send to', no_answer: 'No answer', skipped_call: 'Skipped by the caller', no_credits: 'Not enough credits', not_connected: 'The channel is not connected',
  soft_bounce: 'Could not be delivered', no_unsubscribe_link: 'The message had no stop link', no_contact: 'Person not found', self_test_only: 'Test messages go to the sender only',
};
const groupOf = (reason) => GROUPS[reason] || 'other';

// PURE ---------------------------------------------------------------------------------
function decide(input) {
  const { campaign, contact, chan } = input;
  if (!contact || contact.status !== 'active') return { send: false, reason: 'gone' };
  const internalCampaign = campaign.type === 'internal';
  if (!internalCampaign && contact.contactType !== 'candidate_lead') return { send: false, reason: 'internal_contact' }; // THE HARD RULE
  if (internalCampaign && contact.contactType !== 'internal') return { send: false, reason: 'not_internal' };
  const channel = chanOf(campaign);
  if (channel === 'email' && !core.validEmail(contact.email)) return { send: false, reason: 'invalid_email' };
  if (channel !== 'email' && !String(contact.phoneE164 || '').replace(/\D/g, '')) return { send: false, reason: 'no_phone' };
  if (input.suppressed) return { send: false, reason: 'suppressed' };
  if (chan && chan.optIn === 'opted_out') return { send: false, reason: 'opted_out' };
  let basis = null;
  if (channel === 'call') {
    // a person rings: no opt-in needed (opt-outs and the do-not-contact list above still win)
  } else {
    if (chan && ['invalid', 'hard_bounced', 'complained'].includes(chan.health)) return { send: false, reason: 'bad_address' };
    if (!chan || chan.optIn !== 'opted_in') {
      // the Admin switch: somebody copied from ATS who applied to OUR job may get a JOB message while their consent is unknown (never opted out, never staff)
      const unknown = !chan || chan.optIn === 'unknown';
      if (input.atsAllowed && unknown && campaign.type === 'job_promotion' && contact.linkedApplicantId) basis = 'ats_applied';
      else return { send: false, reason: 'no_opt_in' };
    }
  }
  if (!internalCampaign) {
    if (input.alreadyApplied) return { send: false, reason: 'already_applied' };
    if (input.recentlyMessaged) return { send: false, reason: 'recently_messaged' };
  }
  return basis ? { send: true, basis } : { send: true };
}

// DATA ---------------------------------------------------------------------------------
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const ph = (n) => new Array(n).fill('?').join(',');

// keys of people who already applied to this job: Omni funnel 'applied' events (Phase 4 writes them) + ATS applications (phone / email match)
async function appliedSets(requirementId) {
  const contactIds = new Set(); const phones = new Set(); const emails = new Set();
  if (!requirementId) return { contactIds, phones, emails };
  (await S.q('SELECT DISTINCT contactId FROM "OutreachEvent" WHERE type = \'applied\' AND requirementId = ? AND contactId IS NOT NULL', requirementId)).forEach((r) => contactIds.add(r.contactId));
  try {
    const prisma = require('../db'); // eslint-disable-line global-require
    const apps = await prisma.application.findMany({ where: { requirementId }, select: { candidate: { select: { phone: true, email: true } } } });
    apps.forEach((a) => {
      if (!a.candidate) return;
      phoneKeys(a.candidate.phone).forEach((k) => phones.add(k));
      const e = emailKey(a.candidate.email); if (e) emails.add(e);
    });
  } catch { /* the ATS tables are not reachable: the funnel events still apply */ }
  return { contactIds, phones, emails };
}
// contacts messaged about this job inside the window by a LIVE campaign (a rehearsal never counts). excludeCampaignId = the one being built.
// groupId: the other channel rows of the SAME master campaign never count (a master campaign on WhatsApp + SMS reaches a person on both)
async function recentSet(requirementId, days, excludeCampaignId, now = Date.now(), groupId = null) {
  const out = new Set();
  if (!requirementId || !(days > 0)) return out;
  const since = now - days * 86400000;
  const rows = await S.q(`SELECT DISTINCT m.contactId FROM "OutreachMessage" m JOIN "OutreachCampaign" k ON k.id = m.campaignId
    WHERE m.requirementId = ? AND k.mode = 'live' AND m.status IN ('sent','delivered','sending') AND COALESCE(m.sentAt, m.lockedAt, 0) >= ? AND m.campaignId <> ?${groupId && /^[A-Za-z0-9_-]{4,60}$/.test(groupId) ? ' AND (k.meta IS NULL OR k.meta NOT LIKE ?)' : ''}`, requirementId, since, excludeCampaignId || '', ...(groupId && /^[A-Za-z0-9_-]{4,60}$/.test(groupId) ? [`%"groupId":"${groupId}"%`] : []));
  rows.forEach((r) => out.add(r.contactId));
  return out;
}

// campaign: { id, type, channel (or meta.channel), requirementId, suppressDays }.  Returns [{ contactId, contact, decision }] in the order of `ids`.
async function evaluate(campaign, ids, { days, now = Date.now() } = {}) {
  const channel = chanOf(campaign);
  const n = days != null ? days : (campaign.suppressDays != null ? campaign.suppressDays : (await S.settings()).suppressDays);
  const applied = campaign.type === 'internal' ? null : await appliedSets(campaign.requirementId);
  const recent = campaign.type === 'internal' ? new Set() : await recentSet(campaign.requirementId, n, campaign.id, now, (() => { let m = campaign.meta; if (typeof m === 'string') { try { m = JSON.parse(m); } catch { m = null; } } return (m && m.groupId) || null; })());
  let atsAllowed = false;
  try { atsAllowed = (await require('./policy').consentRules()).atsAppliedMeansJobAllowed === true; } catch { atsAllowed = false; } // eslint-disable-line global-require
  const chList = channel === 'call' ? ['whatsapp', 'sms', 'call'] : [channel]; // a call looks at the phone channels
  const supList = channel === 'call' ? ['call', '*', 'whatsapp', 'sms'] : [channel, '*'];
  const out = [];
  for (const part of chunk(ids, 400)) {
    const contacts = new Map((await S.q(`SELECT * FROM "OutreachContact" WHERE id IN (${ph(part.length)})`, ...part)).map((c) => [c.id, c])); // eslint-disable-line no-await-in-loop
    const chanRows = await S.q(`SELECT * FROM "OutreachContactChannel" WHERE channel IN (${ph(chList.length)}) AND contactId IN (${ph(part.length)})`, ...chList, ...part); // eslint-disable-line no-await-in-loop
    const chans = new Map();
    chanRows.forEach((r) => {
      if (channel === 'call') { const cur = chans.get(r.contactId); if (!cur || r.optIn === 'opted_out') chans.set(r.contactId, { optIn: r.optIn === 'opted_out' ? 'opted_out' : 'unknown', health: 'ok' }); } else chans.set(r.contactId, r);
    });
    const hashes = new Map();
    part.forEach((id) => { const c = contacts.get(id); if (c && c.status === 'active') { const h = S.hashAddress(channel === 'email' ? 'email' : 'phone', channel === 'email' ? c.email : c.phoneE164); if (h) hashes.set(id, h); } });
    const hs = [...new Set(hashes.values())];
    const sup = new Set();
    for (const hp of chunk(hs, 400)) (await S.q(`SELECT addressHash FROM "OutreachSuppression" WHERE channel IN (${ph(supList.length)}) AND addressHash IN (${ph(hp.length)})`, ...supList, ...hp)).forEach((r) => sup.add(r.addressHash)); // eslint-disable-line no-await-in-loop
    for (const id of part) {
      const c = contacts.get(id);
      let alreadyApplied = false;
      if (applied && c) {
        alreadyApplied = applied.contactIds.has(id) || (c.emailKey && applied.emails.has(c.emailKey)) || (c.phoneKey && applied.phones.has(c.phoneKey));
      }
      const decision = decide({ campaign, contact: c, chan: chans.get(id) || null, suppressed: hashes.has(id) && sup.has(hashes.get(id)), alreadyApplied: !!alreadyApplied, recentlyMessaged: recent.has(id), atsAllowed });
      out.push({ contactId: id, contact: c || null, decision });
    }
  }
  return out;
}

// the members of the chosen groups (one list, no duplicates: a person in two groups is one person). No channel filter here:
// the engine says WHY someone is skipped, so the plan can show it.
async function members(segmentIds, type) {
  const G = require('./segments'); // eslint-disable-line global-require
  const want = type === 'internal' ? 'internal' : 'candidate_lead';
  const ids = []; const seen = new Set(); let dup = 0;
  for (const sid of segmentIds || []) {
    const seg = (await S.q('SELECT * FROM "OutreachSegment" WHERE id = ? AND deletedAt IS NULL', sid))[0];
    if (!seg) throw new S.OutreachError('no_segment', 'A group was not found.', 404);
    if (seg.contactType !== want) throw new S.OutreachError(want === 'candidate_lead' ? 'internal_contact' : 'not_internal', want === 'candidate_lead' ? 'Promotion messages cannot go to an internal group.' : 'This group is not an internal group.', 403);
    const m = G.membersSql(seg);
    const rows = await S.q(`SELECT c.id FROM "OutreachContact" c WHERE ${m.where} AND c.contactType = ?`, ...m.params, want);
    rows.forEach((r) => { if (seen.has(r.id)) dup += 1; else { seen.add(r.id); ids.push(r.id); } });
  }
  return { ids, duplicates: dup };
}

// counts for the plan: { willGet, skipped: { optedOut, ... }, reasons: { code: n } }
function tally(results) {
  const reasons = {}; const skipped = {};
  let willGet = 0;
  results.forEach((r) => {
    if (r.decision.send) { willGet += 1; return; }
    reasons[r.decision.reason] = (reasons[r.decision.reason] || 0) + 1;
    const g = groupOf(r.decision.reason); skipped[g] = (skipped[g] || 0) + 1;
  });
  return { willGet, skipped, reasons };
}

module.exports = { decide, evaluate, members, tally, groupOf, chanOf, CHANNELS, GROUPS, GROUP_WORDS, REASON_WORDS, appliedSets, recentSet };
