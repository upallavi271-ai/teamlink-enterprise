// ---------------------------------------------------------------------------
// CLIENT HIRING: THE OFFER AND JOINING LETTERS THAT THE CLIENT SENDS (user, 2026-10-13).
//
//   INTERNAL job (TeamLink's own opening): TeamLink prepares and sends the
//   offer (utils/offerLink.js, routes/interviewsJoining.js) — NOT touched here.
//
//   CLIENT job: the CLIENT makes the offer letter. The steps (one record per
//   application, kept as ONE AppSetting row "client-track:<applicationId>" —
//   no schema change; see the report for the optional table later):
//
//     Selected by the client ........ "Waiting for the client's offer letter"
//                                     (a WAITING state; the BDE owns the chase)
//     CLIENT RELEASES THE OFFER ...... client portal (tick OFFERS) or the BDE
//                                     records it on the client's behalf (audited)
//     RECRUITER SHARES WITH CANDIDATE  mail / WhatsApp / SMS through TeamLink, or
//                                     the candidate link (reuses utils/offerLink.js:
//                                     expiry, accept / decline, signature)
//     CANDIDATE ACCEPTS / DECLINES ... everyone is told, the client sees it
//     CLIENT ACKNOWLEDGES ............ (portal button, or the BDE records it)
//     CLIENT RELEASES THE JOINING LETTER, the recruiter shares it, the candidate
//     CONFIRMS joining (public link /joining/<token>), then JOINED -> the Accounts
//     invoice draft (utils/joining.js raiseJoiningInvoice, unchanged).
//
// The legacy Application fields stay the single source for the old screens:
//   stage SELECTED -> OFFER (when SHARED) -> OFFER_ACCEPTED -> JOINED
//   offerStatus 'Offer Released' (= shared with the candidate) / 'Offer Accepted' / 'Offer Declined'
//   joiningStatus 'Joining Scheduled' (set when the joining letter is released)
// The sub-statuses below only add words on top of them.
//
// Never throws out of the hooks (onCandidateAnswer ...): a notice that fails must
// not undo the candidate's answer that already happened.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const { logAudit } = require('./audit');
const { notifyUsers } = require('./notify');
const attachments = require('./attachments');
const J = require('./joining');

const PREFIX = 'client-track:';
const REMINDERS_KEY = 'client-track-reminders';
const keyOf = (appId) => `${PREFIX}${appId}`;

// --- the plain words ----------------------------------------------------------
const STATE_WORDS = {
  WAITING_CLIENT: { label: "Waiting for the client's offer letter", tone: 'amber' },
  OFFER_RELEASED: { label: 'Offer released by the client', tone: 'blue' },
  OFFER_SHARED: { label: 'Offer shared with the candidate', tone: 'blue' },
  OFFER_DECLINED: { label: 'Offer declined', tone: 'red' },
  OFFER_ACCEPTED: { label: 'Offer accepted', tone: 'green' },
  CLIENT_ACKNOWLEDGED: { label: 'Client acknowledged', tone: 'green' },
  JOINING_RELEASED: { label: 'Joining letter released by the client', tone: 'blue' },
  JOINING_SHARED: { label: 'Joining letter shared with the candidate', tone: 'blue' },
  JOINING_CONFIRMED: { label: 'Candidate confirmed joining', tone: 'green' },
  JOINED: { label: 'Joined', tone: 'green' },
};

// --- who is who ---------------------------------------------------------------
const roleSet = (u) => [u && u.role, u && u.atsRole].filter(Boolean);
const isAdmin = (u) => roleSet(u).some((r) => ['SUPER_ADMIN', 'ADMIN'].includes(r));
const isClientUser = (u) => !!u && roleSet(u).includes('CLIENT') && !!u.clientId;
function isBdeTeam(u) {
  if (!u || isClientUser(u)) return false;
  try { return require('./scope').clientViewRole(u) === 'bde'; } catch { return false; } // eslint-disable-line global-require
}
const mayReleaseForClient = (u) => isAdmin(u) || isBdeTeam(u);

function isClientJob(app) {
  const r = (app && app.requirement) || {};
  if (!app || !r) return false;
  if (J.isInternalHire(app, r)) return false;
  if (r.internal) return false;
  if (r.client && r.client.clientType === 'Internal') return false;
  return !!(r.clientId || r.client);
}

const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());
const firstName = (n) => String(n || '').replace(/^ZZTEST\S*\s*/i, '').trim().split(/\s+/)[0] || 'there';

// --- the store ------------------------------------------------------------------
async function getTrack(appId) {
  const row = await prisma.appSetting.findUnique({ where: { key: keyOf(appId) } }).catch(() => null);
  if (!row) return null;
  try { const v = JSON.parse(row.value); return v && typeof v === 'object' ? v : null; } catch { return null; }
}
async function saveTrack(appId, track, user) {
  const who = user && user.id ? { updatedById: user.id, updatedByName: user.name } : {};
  const value = JSON.stringify(track);
  await prisma.appSetting.upsert({
    where: { key: keyOf(appId) },
    create: { key: keyOf(appId), value, ...who },
    update: { value, ...who },
  });
  return track;
}
async function loadAll() {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: PREFIX } }, select: { key: true, value: true } }).catch(() => []);
  const map = new Map();
  rows.forEach((r) => { try { map.set(r.key.slice(PREFIX.length), JSON.parse(r.value)); } catch { /* skip */ } });
  return map;
}
const blank = () => ({ v: 1, offer: null, offerHistory: [], joining: null, notified: {}, reminded: {} });

// --- the state of one record, in plain words ---------------------------------------
function stateOf(app, track) {
  const t = track || {};
  const o = t.offer;
  const j = t.joining;
  if (app && ['JOINED', 'HIRED'].includes(app.stage)) return 'JOINED';
  if (j && j.state === 'CONFIRMED') return 'JOINING_CONFIRMED';
  if (j && j.state === 'SHARED') return 'JOINING_SHARED';
  if (j && j.state === 'RELEASED') return 'JOINING_RELEASED';
  if (o && o.state === 'ACKNOWLEDGED') return 'CLIENT_ACKNOWLEDGED';
  if (o && o.state === 'ACCEPTED') return 'OFFER_ACCEPTED';
  if (app && app.stage === 'OFFER_ACCEPTED') return 'OFFER_ACCEPTED'; // legacy accepted offer
  if (o && o.state === 'DECLINED') return 'OFFER_DECLINED';
  if (o && o.state === 'SHARED') return 'OFFER_SHARED';
  if (o && o.state === 'RELEASED') return 'OFFER_RELEASED';
  return 'WAITING_CLIENT';
}
const wordsOf = (code) => ({ code, ...(STATE_WORDS[code] || STATE_WORDS.WAITING_CLIENT) });

// --- people -------------------------------------------------------------------------
async function peopleFor(app) {
  const r = app.requirement || {};
  const CB = require('./clientBdes'); // eslint-disable-line global-require
  const recruiters = [r.recruiterId, ...String(r.recruiterIds || '').split(',').map((s) => s.trim())].filter(Boolean);
  const tls = [r.tlId].filter(Boolean);
  const bdes = await CB.ownerBdeIds(r);
  const bdeTls = await CB.bdeTlIds();
  const clientUsers = r.clientId && !r.internal
    ? (await prisma.user.findMany({ where: { clientId: r.clientId, status: 'Active', OR: [{ role: 'CLIENT' }, { atsRole: 'CLIENT' }] }, select: { id: true, name: true, email: true, portalPerms: true, portalType: true } })).filter((u) => !skipTest(u))
    : [];
  return {
    recruiters: [...new Set(recruiters)], tls, bdes, bdeTls, clientUsers,
    staff: [...new Set([...recruiters, ...tls, ...bdes, ...bdeTls])],
  };
}
const TEST_RE = /zztest|example\.test/i;
const skipTest = (u) => !require('./sandbox').isSandbox() && TEST_RE.test(`${u.name} ${u.email}`); // eslint-disable-line global-require

const emailsOn = () => require('./interviewNotices').candidateEmailsOn(); // eslint-disable-line global-require
async function mailTo(to, subject, text) {
  if (!to) return { ok: false, error: 'no address' };
  try {
    const r = await require('./mailer').sendMail({ to, subject, text, useEmployeeFrom: false, fromName: 'TeamLink' }); // eslint-disable-line global-require
    await logAudit({ action: `Email sent: ${subject}`.slice(0, 190), entity: 'ClientTrack', entityId: String(to).slice(0, 120), toValue: r && r.ok ? 'sent' : 'not sent' });
    return r;
  } catch (err) { return { ok: false, error: err.message }; }
}

// One bell per person per event, once: track.notified[key] remembers it. `mail` = also email the
// staff (only while the Admin "Candidate emails" switch is on, like the interview emails).
async function tell(track, key, userIds, { title, message, exceptUserId, mail = true }) {
  if (track.notified && track.notified[key]) return false;
  track.notified = track.notified || {};
  track.notified[key] = new Date().toISOString();
  const wanted = [...new Set((userIds || []).filter(Boolean))].filter((id) => id !== exceptUserId);
  // Only people who exist and are active (a cached id of a removed login must not fail the whole notice).
  const ids = wanted.length ? (await prisma.user.findMany({ where: { id: { in: wanted }, status: 'Active' }, select: { id: true } })).map((u) => u.id) : [];
  if (!ids.length) return true;
  try { await notifyUsers(ids, { title, message }); } catch (err) { console.error('[clientTrack] bell:', err.message); } // eslint-disable-line no-console
  if (mail && (await emailsOn())) {
    const users = await prisma.user.findMany({ where: { id: { in: ids }, status: 'Active' }, select: { id: true, name: true, email: true } });
    for (const u of users) {
      if (!u.email || skipTest(u)) continue;
      // eslint-disable-next-line no-await-in-loop
      await mailTo(u.email, title.replace(/^[^\w]+\s*/, ''), ['Hello,', '', message, '', 'Open TeamLink for the details.', '', '— TeamLink'].join('\n'));
    }
  }
  return true;
}

// A row in the candidate's Pipeline History without a stage move.
async function timeline(user, app, action, comment, side) {
  const r = app.requirement || {};
  try {
    await prisma.applicationStageEvent.create({
      data: {
        applicationId: app.id,
        candidateId: app.candidateId,
        fromStage: app.stage,
        toStage: app.stage,
        action: clean(action, 240),
        comment: comment ? String(comment).slice(0, 2000) : null,
        actorUserId: user && user.id ? user.id : null,
        actorName: (user && user.name) || 'TeamLink',
        actorRole: (user && (user.atsRole || user.role)) || null,
        actorSide: side || (isClientUser(user) ? 'Client' : 'Internal'),
        requirementId: app.requirementId,
        requirementTitle: r.title || null,
        clientId: r.clientId || null,
        clientName: r.internal ? 'TeamLink Internal' : (r.client && r.client.name) || null,
      },
    });
  } catch (err) { console.error('[clientTrack] timeline:', err.message); } // eslint-disable-line no-console
}

const FULL = { candidate: true, requirement: { include: { client: true, recruiter: true, bde: true } } };
const loadApp = (id) => prisma.application.findUnique({ where: { id }, include: FULL });

// --- the letter's fields ------------------------------------------------------------
class Bad extends Error { constructor(msg, status = 400, extra = {}) { super(msg); this.status = status; this.extra = extra; } }

function readFields(kind, f, { allowCtc }) {
  const out = {};
  const b = f || {};
  if (kind === 'offer') {
    out.designation = clean(b.designation, 120);
    out.location = clean(b.location, 120);
    out.validUntil = clean(b.validUntil, 10);
    if (out.validUntil) {
      if (!isDay(out.validUntil)) throw new Bad('"Offer valid until" is not a date.');
      if (out.validUntil < today()) throw new Bad('"Offer valid until" is already past — pick a later day.');
      const y = J.dateYearProblem(out.validUntil, 'offer valid-until date');
      if (y) throw new Bad(y);
    }
  } else {
    out.joiningTime = clean(b.joiningTime, 8);
    if (out.joiningTime && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(out.joiningTime)) throw new Bad('Joining time looks like 09:30.');
    out.place = clean(b.place || b.location, 200);
    out.reportingPerson = clean(b.reportingPerson, 120);
    out.designation = clean(b.designation, 120);
  }
  out.joiningDate = clean(b.joiningDate, 10);
  if (kind === 'joining' && !out.joiningDate) throw new Bad('Say the joining date.');
  if (out.joiningDate) {
    if (!isDay(out.joiningDate)) throw new Bad('The joining date is not a date.');
    const y = J.dateYearProblem(out.joiningDate, 'joining date');
    if (y) throw new Bad(y);
  }
  out.offerNotes = clean(b.notes != null ? b.notes : b.offerNotes, 1000);
  if (allowCtc && b.offeredCtc != null && String(b.offeredCtc).trim() !== '') {
    const n = Number(String(b.offeredCtc).replace(/[, ]/g, ''));
    if (!Number.isFinite(n) || n <= 0 || n > 1e9) throw new Bad('The CTC is not a sensible amount.');
    out.offeredCtc = Math.round(n);
  }
  return out;
}

// Store the uploaded file (PDF / image only, size + type checked, random name on disk).
function storeFile(file) {
  if (!file) throw new Bad("Attach the client's letter (a PDF or a photo of it).");
  try {
    const s = attachments.store(file);
    return { stored: s.billFile, name: s.billName, size: s.billSize, mime: s.billMime };
  } catch (err) {
    throw new Bad(attachments.MESSAGE[err.code] || 'That file could not be saved.');
  }
}

// --- RELEASE (offer or joining letter) ------------------------------------------------
// actor: the logged-in user (client login or staff). onBehalf = staff recording the client's letter.
async function release(kind, app, { actor, fields, file, note }) {
  if (!isClientJob(app)) throw new Bad('This is a TeamLink requirement — TeamLink makes the offer itself.', 409);
  const client = isClientUser(actor);
  const onBehalf = !client;
  if (onBehalf && !mayReleaseForClient(actor)) throw new Bad("Only the client's BDE or an Admin can record the client's letter.", 403);
  if (onBehalf && !clean(note, 500)) throw new Bad("Say how the client sent it (e.g. \"Client emailed it on 13 Oct\").");
  const track = (await getTrack(app.id)) || blank();
  const word = kind === 'offer' ? 'offer' : 'joining';
  if (kind === 'offer') {
    const o = track.offer;
    if (['ACCEPTED', 'ACKNOWLEDGED'].includes(o && o.state) || app.stage === 'OFFER_ACCEPTED' || ['JOINED', 'HIRED'].includes(app.stage)) throw new Bad('This offer is already accepted.', 409);
    if (!['SELECTED', 'OFFER'].includes(app.stage)) throw new Bad(`An offer letter comes after Selected — this candidate is at a different step.`, 409);
  } else if (app.stage !== 'OFFER_ACCEPTED') {
    throw new Bad('The joining letter comes after the candidate accepted the offer.', 409);
  } else if (track.joining && track.joining.state === 'CONFIRMED') {
    throw new Bad('The candidate already confirmed joining.', 409);
  }
  const f = readFields(kind, fields, { allowCtc: true });
  const stored = storeFile(file);
  const now = new Date().toISOString();
  const rec = {
    state: 'RELEASED',
    releasedAt: now,
    releasedById: actor.id || null,
    releasedByName: actor.name || null,
    releasedBy: client ? 'client' : 'staff',
    onBehalf,
    onBehalfNote: onBehalf ? clean(note, 500) : null,
    file: stored,
    ...f,
  };
  const prev = kind === 'offer' ? track.offer : track.joining;
  if (prev) {
    track.offerHistory = track.offerHistory || [];
    track.offerHistory.push({ kind, ...prev, replacedAt: now });
    if (prev.file && prev.file.stored && prev.file.stored !== stored.stored) { /* keep the old file: it is history */ }
  }
  rec.n = ((prev && prev.n) || 0) + 1;
  if (kind === 'offer') track.offer = rec; else track.joining = rec;

  // The application keeps what the old screens read.
  const upd = {};
  if (f.joiningDate) upd.joiningDate = f.joiningDate;
  if (f.offeredCtc) upd.offeredCtc = f.offeredCtc;
  if (kind === 'joining') upd.joiningStatus = 'Joining Scheduled';
  if (kind === 'offer') {
    // A re-release while the old letter is with the candidate withdraws it: its link stops.
    const OL = require('./offerLink'); // eslint-disable-line global-require
    if (OL.ready()) {
      const cur = await OL.currentVersion(app.id);
      if (cur && cur.status === 'Sent') {
        await prisma.offerVersion.update({ where: { id: cur.id }, data: { status: 'Replaced', linkStoppedAt: new Date() } });
        await logAudit({ userId: actor.id || null, action: `Offer v${cur.version} withdrawn — the client released a new letter`, entity: 'OfferVersion', entityId: cur.id, fromValue: 'Sent', toValue: 'Replaced' });
      }
    }
    if (app.offerStatus === 'Offer Released' || ['Offer Declined', 'Offer Expired'].includes(app.offerStatus)) upd.offerStatus = 'Not Issued';
    upd.offerNotes = null;
  }
  if (Object.keys(upd).length) await prisma.application.update({ where: { id: app.id }, data: upd });
  // Joining letter implies the client has seen the acceptance.
  if (kind === 'joining' && track.offer && track.offer.state === 'ACCEPTED') {
    track.offer.state = 'ACKNOWLEDGED';
    track.offer.ackAt = now; track.offer.ackByName = actor.name || null; track.offer.ackKind = 'by sending the joining letter';
  }
  await saveTrack(app.id, track, actor);

  const cand = app.candidate ? app.candidate.name : 'Candidate';
  const r = app.requirement || {};
  const clientName = (r.client && r.client.name) || 'the client';
  const label = kind === 'offer' ? 'offer letter' : 'joining letter';
  await timeline(actor, app, onBehalf ? `${kind === 'offer' ? 'Offer' : 'Joining'} letter recorded on behalf of ${clientName}` : `${clientName} released the ${label}`, onBehalf ? `Recorded by ${actor.name}: ${clean(note, 500)}` : null, onBehalf ? 'Internal' : 'Client');
  await logAudit({
    userId: actor.id || null,
    action: onBehalf ? `Client's ${label} recorded on behalf of the client` : `Client released the ${label} (client portal)`,
    entity: 'Application', entityId: app.id, toValue: kind === 'offer' ? 'Offer released by client' : 'Joining letter released by client',
    reason: onBehalf ? `On behalf of ${clientName} by ${actor.name}: ${clean(note, 500)}` : undefined,
  });
  const people = await peopleFor(app);
  await tell(track, `${word}-released:${rec.n}`, [...people.bdeTls, ...people.bdes, ...people.tls, ...people.recruiters], {
    title: `${kind === 'offer' ? '📄' : '📨'} ${cand} ${word === 'offer' ? 'offer' : 'joining letter'} released by ${clientName}`,
    message: `${r.title || 'Requirement'}${onBehalf ? ` — recorded by ${actor.name} for the client` : ''}. ${kind === 'offer' ? `Next: the recruiter shares the offer with ${firstName(cand)}.` : `Next: the recruiter shares the joining letter with ${firstName(cand)}.`}`,
    exceptUserId: actor.id,
  });
  await saveTrack(app.id, track, actor);
  return track;
}

// --- SHARE with the candidate ----------------------------------------------------------
const dd = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : null);

// The letter as the candidate's page and signed PDF show it. The CLIENT'S FILE is the real letter.
function offerLetterText(app, o) {
  const lines = [
    `Dear ${app.candidate ? app.candidate.name : ''},`,
    '',
    'Your offer letter is ready. Please open the letter and read it carefully.',
    '',
    o.designation ? `Requirement: ${o.designation}` : `Requirement: ${(app.requirement && app.requirement.title) || ''}`,
    `Joining date: ${o.joiningDate ? dd(o.joiningDate) : 'to be confirmed'}`,
    o.location ? `Place of work: ${o.location}` : null,
    o.offeredCtc ? `Yearly CTC: ₹${Number(o.offeredCtc).toLocaleString('en-IN')}` : null,
    o.validUntil ? `This offer is valid until ${dd(o.validUntil)}.` : null,
    o.offerNotes ? '' : null,
    o.offerNotes || null,
    '',
    'Please accept or decline this offer on this page.',
    '',
    'Best wishes,',
    'TeamLink',
  ].filter((x) => x !== null);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

const sha = (s) => crypto.createHmac('sha256', process.env.OFFER_LINK_SECRET || process.env.AGREEMENT_LINK_SECRET || process.env.JWT_SECRET || 'teamlink-joining-link').update(s).digest('hex').slice(0, 48);
const joiningToken = (appId, at) => `${appId}.${sha(`joining:${appId}:${new Date(at).getTime()}`)}`;
const joiningUrl = (req, token) => `${require('./offerLink').publicBase(req)}/joining/${token}`; // eslint-disable-line global-require
function joiningTokenOk(token, track) {
  const j = track && track.joining;
  if (!j || !j.sharedAt || j.linkStoppedAt) return false;
  return joiningToken(String(token).split('.')[0], j.sharedAt) === token;
}

async function share(kind, app, { actor, via, req }) {
  const track = await getTrack(app.id);
  const rec = track && (kind === 'offer' ? track.offer : track.joining);
  if (!rec || !['RELEASED', 'SHARED'].includes(rec.state)) throw new Bad(kind === 'offer' ? "The client has not released the offer letter yet." : 'The client has not released the joining letter yet.', 409);
  if (kind === 'joining' && track.joining.state === 'CONFIRMED') throw new Bad('The candidate already confirmed joining.', 409);
  const OL = require('./offerLink'); // eslint-disable-line global-require
  const now = new Date();
  let url = null;
  let version = null;
  if (kind === 'offer') {
    if (!OL.ready()) throw new Bad(OL.NOT_READY, 503);
    if (rec.state === 'RELEASED') {
      const fresh = await loadApp(app.id);
      fresh.offeredCtc = rec.offeredCtc || fresh.offeredCtc || null;
      fresh.offerDate = today();
      fresh.joiningDate = rec.joiningDate || fresh.joiningDate;
      const made = await OL.createVersion(fresh, { letterText: offerLetterText(app, rec), actor });
      version = made.version;
      if (rec.validUntil) {
        const until = new Date(new Date(`${rec.validUntil}T18:29:59Z`).getTime()); // end of that day, India time
        await prisma.offerVersion.update({ where: { id: version.id }, data: { expiresAt: until } });
        version = await prisma.offerVersion.findUnique({ where: { id: version.id } });
      }
      await prisma.application.update({
        where: { id: app.id },
        data: {
          stage: 'OFFER', offerStatus: 'Offer Released', offerDate: today(), hiringType: J.hiringTypeOf(app, app.requirement),
          offerAcceptedAt: null,
          documentsStatus: app.documentsStatus || 'Pending', joiningStatus: app.joiningStatus || 'Not Scheduled', billingStatus: 'Billing Pending',
          ...(rec.joiningDate ? { joiningDate: rec.joiningDate } : {}), ...(rec.offeredCtc ? { offeredCtc: rec.offeredCtc } : {}),
        },
      });
      rec.state = 'SHARED';
      rec.sharedAt = now.toISOString();
      rec.sharedById = actor.id || null;
      rec.sharedByName = actor.name || null;
      rec.versionId = version.id;
      rec.versionNo = version.version;
      if (app.stage !== 'OFFER') {
        // The recruiter's share IS the message the candidate gets: no second automatic mail (silent).
        await require('./stageEvents').recordWorkflowMove({ user: actor, existing: app, toStage: 'OFFER', action: 'Offer shared with the candidate', silent: true }); // eslint-disable-line global-require
      }
      track.offer = rec;
      await saveTrack(app.id, track, actor);
      url = OL.linkUrl(req, made.token);
    } else {
      version = await OL.currentVersion(app.id);
      if (!version || version.status !== 'Sent') throw new Bad('The candidate link is no longer open (the offer expired or was answered). Ask the client for a new offer letter; the BDE records it and you share it again.', 409);
      let token = OL.tokenFor(version);
      if (!token) { const m = await OL.remakeLink(version, actor); token = m.token; version = m.version; }
      url = OL.linkUrl(req, token);
    }
  } else {
    if (rec.state === 'RELEASED' || !rec.sharedAt) {
      rec.sharedAt = now.toISOString();
      rec.state = 'SHARED';
      rec.sharedById = actor.id || null;
      rec.sharedByName = actor.name || null;
      track.joining = rec;
      await saveTrack(app.id, track, actor);
    }
    url = joiningUrl(req, joiningToken(app.id, rec.sharedAt));
  }
  const cand = app.candidate ? app.candidate.name : 'Candidate';
  const first = firstName(cand);
  const until = kind === 'offer' && version && version.expiresAt ? dd(new Date(version.expiresAt).toISOString().slice(0, 10)) : null;
  // NEUTRAL: no other candidate-facing text names the client (the letter itself does).
  const text = kind === 'offer'
    ? [`Hi ${first}, please find your offer letter here:`, url, 'Open it to read, then press Accept or Decline.', until ? `Please answer by ${until}.` : '', `— ${actor.name}, TeamLink`].filter(Boolean).join('\n')
    : [`Hi ${first}, please find your joining letter here:`, url, 'Open it to read, then press Confirm joining.', `— ${actor.name}, TeamLink`].join('\n');
  const subject = kind === 'offer' ? `Your offer letter — ${(app.requirement && app.requirement.title) || 'your requirement'}` : `Your joining letter — ${(app.requirement && app.requirement.title) || 'your requirement'}`;
  const out = { url, text, subject, channel: via, sent: null, attempts: [], version: version ? { id: version.id, version: version.version, expiresAt: version.expiresAt } : null };
  if (['Email', 'WhatsApp', 'SMS'].includes(via)) {
    const omni = await require('./omniSend').send(actor, { // eslint-disable-line global-require
      audience: 'candidates', id: app.candidateId, channel: via, applicationId: app.id, requirementId: app.requirementId, subject, body: text, purpose: kind === 'offer' ? 'Offer letter' : 'Joining letter',
    });
    out.sent = !!(omni && omni.ok);
    out.attempts = (omni && omni.attempts) || [];
    out.error = omni && omni.error ? omni.error : null;
    out.fallback = omni && omni.fallback ? { text: omni.fallback.text, subject: omni.fallback.subject } : null;
  }
  const what = kind === 'offer' ? 'Offer' : 'Joining letter';
  await timeline(actor, app, `${what} shared with the candidate (${via === 'Link' ? 'link copied' : via}${via !== 'Link' ? (out.sent ? ', sent' : ', not sent') : ''})`, null, 'Internal');
  await logAudit({ userId: actor.id || null, action: `${what} shared with the candidate — ${via}`, entity: 'Application', entityId: app.id, toValue: kind === 'offer' ? 'Offer shared with candidate' : 'Joining letter shared with candidate' });
  const r = app.requirement || {};
  const people = await peopleFor(app);
  const t2 = (await getTrack(app.id)) || track;
  await tell(t2, `${kind}-shared:${(t2[kind === 'offer' ? 'offer' : 'joining'] || {}).n || 1}`, [...people.tls, ...people.bdes, ...people.bdeTls], {
    title: `${kind === 'offer' ? '📤' : '📤'} ${cand} — ${what.toLowerCase()} shared with the candidate`,
    message: `${r.title || 'Requirement'} — shared by ${actor.name}. Waiting for ${first}'s answer.`, exceptUserId: actor.id, mail: false,
  });
  await saveTrack(app.id, t2, actor);
  return out;
}

// --- the candidate's ANSWER ------------------------------------------------------------
// Called by every place an offer is accepted / declined (offer link, candidate portal, recruiter
// records it). Safe to call for any job: it only acts on a client job whose offer came from the client.
async function onCandidateAnswer(appId, answer, { via = 'the offer link', reason = null, actorName = null, actor = null } = {}) {
  try {
    const app = await loadApp(appId);
    if (!app || !isClientJob(app)) return null;
    const track = await getTrack(appId);
    if (!track || !track.offer || !['SHARED'].includes(track.offer.state)) return null;
    const o = track.offer;
    const now = new Date().toISOString();
    const cand = app.candidate ? app.candidate.name : 'Candidate';
    const r = app.requirement || {};
    const clientName = (r.client && r.client.name) || 'the client';
    o.answeredAt = now; o.answeredVia = via; o.answeredBy = actorName || (actor && actor.name) || null;
    const people = await peopleFor(app);
    if (answer === 'Accepted') {
      o.state = 'ACCEPTED';
      await saveTrack(appId, track, actor);
      await timeline(actor, app, `${cand} accepted the offer (${via})`, null, 'Internal');
      await tell(track, `offer-accepted:${o.n}`, [...people.recruiters, ...people.tls, ...people.bdes, ...people.bdeTls, ...people.clientUsers.map((u) => u.id)], {
        title: `✅ ${cand} accepted the offer`,
        message: `${r.title || 'Requirement'} — ${clientName}. The client confirms it and sends the joining letter.`, exceptUserId: actor && actor.id,
      });
      // The client's own contact gets one plain mail (only while the Admin "emails" switch is on).
      const contact = r.client && r.client.contactEmail;
      if (contact && (await emailsOn()) && !skipTest({ name: clientName, email: contact })) {
        await mailTo(contact, `${cand} accepted your offer`, ['Hello,', '', 'The candidate has accepted your offer. Please confirm and send the joining letter.', '', `Candidate: ${cand}`, `Requirement: ${r.title || ''}`, '', 'You can confirm it and send the joining letter in your TeamLink portal.', '', '— TeamLink'].join('\n'));
      }
    } else {
      o.state = 'DECLINED';
      o.declineReason = clean(reason, 500) || null;
      await saveTrack(appId, track, actor);
      await timeline(actor, app, `${cand} declined the offer (${via})`, o.declineReason, 'Internal');
      await tell(track, `offer-declined:${o.n}`, [...people.recruiters, ...people.tls, ...people.bdes, ...people.bdeTls, ...people.clientUsers.map((u) => u.id)], {
        title: `🔴 ${cand} declined the offer`,
        message: `${r.title || 'Requirement'} — ${clientName}${o.declineReason ? `: ${o.declineReason}` : ''}.`, exceptUserId: actor && actor.id,
      });
    }
    await saveTrack(appId, track, actor);
    return track;
  } catch (err) {
    console.error('[clientTrack] onCandidateAnswer:', err.message); // eslint-disable-line no-console
    return null;
  }
}

// --- ACKNOWLEDGE (the client checked the acceptance) ----------------------------------------
async function acknowledge(app, { actor, note }) {
  if (!isClientJob(app)) throw new Bad('This is a TeamLink requirement.', 409);
  const client = isClientUser(actor);
  if (!client && !mayReleaseForClient(actor)) throw new Bad("Only the client's BDE or an Admin can record this for the client.", 403);
  const track = await getTrack(app.id);
  if (!track || !track.offer || track.offer.state !== 'ACCEPTED') throw new Bad('There is no accepted offer waiting for the client to confirm.', 409);
  if (!client && !clean(note, 500)) throw new Bad('Say how the client confirmed (e.g. "Client replied on mail").');
  const o = track.offer;
  o.state = 'ACKNOWLEDGED'; o.ackAt = new Date().toISOString(); o.ackByName = actor.name || null; o.ackKind = client ? 'client portal' : `on behalf of the client — ${clean(note, 300)}`;
  await saveTrack(app.id, track, actor);
  const r = app.requirement || {};
  const clientName = (r.client && r.client.name) || 'the client';
  const cand = app.candidate ? app.candidate.name : 'Candidate';
  await timeline(actor, app, client ? `${clientName} acknowledged the acceptance` : `Client's confirmation recorded on behalf of ${clientName}`, client ? null : clean(note, 500), client ? 'Client' : 'Internal');
  await logAudit({ userId: actor.id || null, action: client ? 'Client acknowledged the accepted offer (portal)' : "Client's acknowledgement recorded on behalf of the client", entity: 'Application', entityId: app.id, toValue: 'Client acknowledged', reason: client ? undefined : clean(note, 500) });
  const people = await peopleFor(app);
  await tell(track, `offer-ack:${o.n}`, [...people.bdes, ...people.bdeTls, ...people.recruiters, ...people.tls], {
    title: `👍 ${clientName} acknowledged ${cand}'s acceptance`,
    message: `${r.title || 'Requirement'}. Next: the client sends the joining letter.`, exceptUserId: actor.id, mail: false,
  });
  await saveTrack(app.id, track, actor);
  return track;
}

// --- the candidate CONFIRMS joining ------------------------------------------------------------
async function confirmJoining(app, { via, actor = null, actorName = null }) {
  const track = await getTrack(app.id);
  if (!track || !track.joining || !['SHARED', 'RELEASED'].includes(track.joining.state)) throw new Bad('There is no joining letter waiting for an answer.', 409);
  const j = track.joining;
  j.state = 'CONFIRMED'; j.confirmedAt = new Date().toISOString(); j.confirmedVia = via; j.confirmedByName = actorName || (actor && actor.name) || null;
  await saveTrack(app.id, track, actor);
  const r = app.requirement || {};
  const clientName = (r.client && r.client.name) || 'the client';
  const cand = app.candidate ? app.candidate.name : 'Candidate';
  await timeline(actor, app, `${cand} confirmed joining (${via})`, null, 'Internal');
  await logAudit({ userId: actor && actor.id ? actor.id : null, actorName: actorName || undefined, action: `Candidate confirmed joining (${via})`, entity: 'Application', entityId: app.id, toValue: 'Candidate confirmed joining' });
  const people = await peopleFor(app);
  await tell(track, `joining-confirmed:${j.n}`, [...people.recruiters, ...people.tls, ...people.bdes, ...people.bdeTls, ...people.clientUsers.map((u) => u.id)], {
    title: `✅ ${cand} confirmed joining`,
    message: `${r.title || 'Requirement'} — ${clientName}${j.joiningDate ? `, joining ${dd(j.joiningDate)}` : ''}.`, exceptUserId: actor && actor.id,
  });
  const contact = r.client && r.client.contactEmail;
  if (contact && (await emailsOn()) && !skipTest({ name: clientName, email: contact })) {
    await mailTo(contact, `${cand} confirmed joining`, ['Hello,', '', 'The candidate has confirmed joining.', '', `Candidate: ${cand}`, `Requirement: ${r.title || ''}`, j.joiningDate ? `Joining date: ${dd(j.joiningDate)}` : '', '', '— TeamLink'].filter((x) => x !== null).join('\n'));
  }
  await saveTrack(app.id, track, actor);
  return track;
}

// --- JOINED, confirmed by the client in the portal -------------------------------------------------
async function markJoinedByClient(app, actor) {
  if (!isClientJob(app)) throw new Bad('This is a TeamLink requirement.', 409);
  if (app.stage !== 'OFFER_ACCEPTED') throw new Bad('Only a candidate who accepted can be marked joined.', 409);
  if (app.joiningStatus !== 'Joining Scheduled') throw new Bad('The joining letter comes first.', 409);
  const track = await getTrack(app.id);
  if (!track || !track.joining) throw new Bad('Send the joining letter first.', 409);
  const jd = track.joining.joiningDate || app.joiningDate;
  if (jd && jd > today()) throw new Bad(`The joining date is ${dd(jd)} — you can confirm on that day.`, 409);
  const application = await prisma.application.update({ where: { id: app.id }, data: { stage: 'JOINED', joinedAt: new Date() } });
  await J.onApplicationJoined({ application, existing: app, userId: null, actor, via: 'Client portal' });
  await logAudit({ userId: actor.id || null, action: 'Client confirmed the candidate joined (client portal)', entity: 'Application', entityId: app.id, fromValue: 'Offer Accepted', toValue: 'Joined' });
  await require('./stageEvents').recordWorkflowMove({ user: actor, existing: app, application, toStage: 'JOINED', action: 'Client confirmed joining — handed to Accounts' }); // eslint-disable-line global-require
  return application;
}

// --- Accounts: told ONCE when the joined candidate's invoice draft is made ------------------------------
async function onInvoiceDraft({ application, existing, invoice, userId = null }) {
  try {
    if (!invoice || !existing || !existing.requirement || J.isInternalHire(application, existing.requirement)) return;
    const r = existing.requirement;
    const cand = (existing.candidate && existing.candidate.name) || 'Candidate';
    const clientName = (r.client && r.client.name) || 'the client';
    // Who is told is the Admin's table (Accounts > Dashboard > Proof reminder > Who gets each reminder); the default is the Accountant role.
    const AR = require('./accountsRecipients'); // eslint-disable-line global-require
    const team = await AR.reminderRecipients({ kind: 'invoiceReady', allowTest: require('./sandbox').isSandbox() }); // eslint-disable-line global-require
    if (!team.on) return;
    const ids = team.users.map((u) => u.id);
    if (!ids.length) await AR.warnNoRecipients('invoiceReady', 'an invoice is ready to prepare');
    const track = (await getTrack(existing.id)) || blank();
    const key = `invoice-draft:${invoice.id}`;
    const title = `🧾 Invoice ready: ${cand} joined ${clientName}`;
    const message = `${r.title || 'Requirement'} — joining ${application.joiningDate ? dd(application.joiningDate) : 'date to confirm'}. An invoice is being prepared in Accounts → Invoices.`;
    if (await tell(track, key, ids, { title, message, exceptUserId: userId, mail: team.channels.includes('email') })) await saveTrack(existing.id, track, null);
  } catch (err) { console.error('[clientTrack] onInvoiceDraft:', err.message); } // eslint-disable-line no-console
}

// "Invoice: Not raised / Draft / Sent / Paid" — a status only, no amounts.
async function invoiceChip(app) {
  if (!app || !['JOINED', 'HIRED'].includes(app.stage) || J.isInternalHire(app, app.requirement)) return null;
  const inv = await prisma.invoice.findFirst({ where: { candidateId: app.candidateId, requirementId: app.requirementId }, select: { status: true, invoiceNumber: true } });
  if (!inv) return { label: 'Not raised', tone: 'amber' };
  if (inv.status === 'Paid') return { label: 'Paid', tone: 'green' };
  if (inv.status === 'Cancelled') return { label: 'Cancelled', tone: 'red' };
  if (!inv.invoiceNumber && inv.status === 'Pending') return { label: 'Being prepared', tone: 'blue' };
  return { label: 'Sent', tone: 'blue' };
}

// --- what a viewer is shown --------------------------------------------------------------------------
const fileShape = (f, canOpen) => (f ? { name: f.name, size: f.size, canOpen: !!canOpen } : null);
async function mayOpenFiles(user) {
  if (isClientUser(user) || isAdmin(user)) return true;
  try { return !!(await require('./permissions').can(user, 'ats', 'interviews', 'Offer Letter Files', 'view')); } catch { return false; } // eslint-disable-line global-require
}
function recShape(rec, canOpen) {
  if (!rec) return null;
  return {
    state: rec.state, n: rec.n, releasedAt: rec.releasedAt, releasedByName: rec.releasedByName, releasedBy: rec.releasedBy,
    onBehalf: !!rec.onBehalf, onBehalfNote: rec.onBehalfNote || null,
    designation: rec.designation || null, location: rec.location || null, joiningDate: rec.joiningDate || null, validUntil: rec.validUntil || null,
    joiningTime: rec.joiningTime || null, place: rec.place || null, reportingPerson: rec.reportingPerson || null,
    offerNotes: rec.offerNotes || null, offeredCtc: rec.offeredCtc || null,
    file: fileShape(rec.file, canOpen),
    sharedAt: rec.sharedAt || null, sharedByName: rec.sharedByName || null,
    answeredAt: rec.answeredAt || null, answeredVia: rec.answeredVia || null, declineReason: rec.declineReason || null,
    ackAt: rec.ackAt || null, ackKind: rec.ackKind || null,
    confirmedAt: rec.confirmedAt || null, confirmedVia: rec.confirmedVia || null,
  };
}
// STAFF view: the structured CTC / notes keys keep the names the BDE response guard cuts
// (offeredCtc, offerNotes: utils/clientRedact.js), so a BDE never receives them.
async function shapeFor(user, app, track) {
  if (!isClientJob(app)) return null;
  const t = track === undefined ? await getTrack(app.id) : track;
  const code = stateOf(app, t);
  const canOpen = await mayOpenFiles(user);
  const out = {
    clientJob: true,
    state: wordsOf(code),
    offer: recShape(t && t.offer, canOpen),
    joining: recShape(t && t.joining, canOpen),
    mayRelease: mayReleaseForClient(user),
    mayAckForClient: mayReleaseForClient(user),
  };
  const chip = await invoiceChip(app);
  // Status only, for the BDE team, Managers and Admins (the Accounts amounts are not here).
  if (chip && (isAdmin(user) || isBdeTeam(user) || ['MANAGER', 'ASSISTANT_MANAGER'].includes(require('./permissions').roleForProduct(user, 'ats')))) out.invoice = chip; // eslint-disable-line global-require
  return out;
}
// The CLIENT's own view (portal): its own letters, the acceptance and the joining confirmation.
function shapeForClient(app, t) {
  const code = stateOf(app, t);
  return {
    state: wordsOf(code),
    offer: recShape(t && t.offer, true),
    joining: recShape(t && t.joining, true),
  };
}

// For the Offers / Joining LISTS: each client-job row gets .clientTrack (the same shape, one batch read).
async function attachTo(user, rows) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const all = await loadAll();
  const canOpen = await mayOpenFiles(user);
  const seeInvoice = isAdmin(user) || isBdeTeam(user) || ['MANAGER', 'ASSISTANT_MANAGER'].includes(require('./permissions').roleForProduct(user, 'ats')); // eslint-disable-line global-require
  const joined = rows.filter((r) => ['JOINED', 'HIRED'].includes(r.stage) && r.candidate && r.requirement);
  const invs = seeInvoice && joined.length
    ? await prisma.invoice.findMany({ where: { candidateId: { in: joined.map((r) => r.candidate.id) } }, select: { candidateId: true, requirementId: true, status: true, invoiceNumber: true } })
    : [];
  rows.forEach((r) => {
    const asApp = { ...r, requirement: { ...r.requirement, clientId: r.requirement && r.requirement.client ? r.requirement.client.id : null } };
    if (!isClientJob(asApp)) { r.clientTrack = null; return; }
    const t = all.get(r.id) || null;
    const out = { clientJob: true, state: wordsOf(stateOf(r, t)), offer: recShape(t && t.offer, canOpen), joining: recShape(t && t.joining, canOpen), mayRelease: mayReleaseForClient(user) };
    if (seeInvoice && ['JOINED', 'HIRED'].includes(r.stage) && r.candidate) {
      const inv = invs.find((i) => i.candidateId === r.candidate.id && i.requirementId === (r.requirement && r.requirement.id));
      out.invoice = !inv ? { label: 'Not raised', tone: 'amber' } : inv.status === 'Paid' ? { label: 'Paid', tone: 'green' } : inv.status === 'Cancelled' ? { label: 'Cancelled', tone: 'red' } : (!inv.invoiceNumber && inv.status === 'Pending') ? { label: 'Being prepared', tone: 'blue' } : { label: 'Sent', tone: 'blue' };
    }
    r.clientTrack = out;
  });
  return rows;
}

function fileOf(track, kind) {
  const rec = track && (kind === 'offer' ? track.offer : track.joining);
  if (!rec || !rec.file || !rec.file.stored) return null;
  const full = attachments.resolveStored(rec.file.stored);
  return full ? { full, name: rec.file.name, mime: rec.file.mime } : null;
}

// --- reminders (OFF by default: inert until an Admin arms them) -------------------------------------------
async function loadReminders() {
  const row = await prisma.appSetting.findUnique({ where: { key: REMINDERS_KEY } }).catch(() => null);
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  const nd = Math.round(Number(v.offerNudgeDays));
  return { armed: v.armed === true, offerNudgeDays: Number.isFinite(nd) && nd >= 1 && nd <= 30 ? nd : 3, lastRunAt: v.lastRunAt || null, updatedByName: row ? row.updatedByName : null };
}
async function saveReminders(patch, user) {
  const cur = await loadReminders();
  const nd = Math.round(Number(patch.offerNudgeDays));
  const next = {
    armed: patch.armed === undefined ? cur.armed : patch.armed === true,
    offerNudgeDays: Number.isFinite(nd) && nd >= 1 && nd <= 30 ? nd : cur.offerNudgeDays,
    lastRunAt: patch.lastRunAt !== undefined ? patch.lastRunAt : cur.lastRunAt,
  };
  const who = user ? { updatedById: user.id, updatedByName: user.name } : {};
  await prisma.appSetting.upsert({ where: { key: REMINDERS_KEY }, create: { key: REMINDERS_KEY, value: JSON.stringify(next), ...who }, update: { value: JSON.stringify(next), ...who } });
  return loadReminders();
}
const dayDiff = (a, b) => Math.round((new Date(`${a}T00:00:00Z`) - new Date(`${b}T00:00:00Z`)) / 86400000);

// Offer not answered in N days -> the recruiter, then (after 2N days) the TL; joining T-3 / T-1 / joining day.
async function runReminders({ now = new Date(), force = false, dryRun = false } = {}) {
  const st = await loadReminders();
  if (!st.armed && !force) return { skipped: true, reason: 'Offer and joining reminders are switched off (Admin setting).' };
  const day = new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10);
  const summary = { at: now.toISOString(), offerNudges: 0, joiningReminders: 0, dryRun: !!dryRun, items: [] };
  const all = await loadAll();
  for (const [appId, track] of all) {
    // eslint-disable-next-line no-await-in-loop
    const app = await loadApp(appId);
    if (!app || !isClientJob(app) || ['REJECTED', 'HOLD', 'JOINED', 'HIRED'].includes(app.stage)) continue;
    // eslint-disable-next-line no-await-in-loop
    const people = await peopleFor(app);
    const cand = app.candidate ? app.candidate.name : 'Candidate';
    const o = track.offer;
    if (o && o.state === 'SHARED' && o.sharedAt) {
      const waited = dayDiff(day, new Date(new Date(o.sharedAt).getTime() + 330 * 60000).toISOString().slice(0, 10));
      if (waited >= st.offerNudgeDays) {
        const second = waited >= st.offerNudgeDays * 2;
        const key = `offer-nudge:${o.n}:${second ? 'tl' : 'rec'}`;
        if (!(track.reminded || {})[key]) {
          summary.offerNudges += 1; summary.items.push({ appId, key });
          if (!dryRun) {
            track.reminded = track.reminded || {}; track.reminded[key] = day;
            // eslint-disable-next-line no-await-in-loop
            await notifyUsers(second ? [...people.recruiters, ...people.tls] : people.recruiters, { title: `🟠 ${cand} has not answered the offer`, message: `${(app.requirement || {}).title || 'Requirement'} — shared ${waited} days ago. Call ${firstName(cand)} and ask for a yes or a no.` });
            // eslint-disable-next-line no-await-in-loop
            await saveTrack(appId, track, null);
          }
        }
      }
    }
    const j = track.joining;
    if (j && ['SHARED', 'CONFIRMED', 'RELEASED'].includes(j.state) && j.joiningDate) {
      const left = dayDiff(j.joiningDate, day);
      if ([3, 1, 0].includes(left)) {
        const key = `joining-t${left}:${j.n}`;
        if (!(track.reminded || {})[key]) {
          summary.joiningReminders += 1; summary.items.push({ appId, key });
          if (!dryRun) {
            track.reminded = track.reminded || {}; track.reminded[key] = day;
            const when = left === 0 ? 'today' : left === 1 ? 'tomorrow' : 'in 3 days';
            // eslint-disable-next-line no-await-in-loop
            await notifyUsers([...people.recruiters, ...people.tls, ...people.bdes], { title: `⏰ ${cand} joins ${when}`, message: `${(app.requirement || {}).title || 'Requirement'}${j.joiningTime ? ` at ${j.joiningTime}` : ''}${j.state === 'CONFIRMED' ? '' : ' — the candidate has not confirmed yet'}.` });
            // The candidate: recorded on Communications; mailed only while the Admin switch is on.
            // eslint-disable-next-line no-await-in-loop
            await require('./interviewNotices').queueCandidateEmail(app, { // eslint-disable-line global-require
              template: 'JOINING_REMINDER', label: 'Joining reminder', subject: `Reminder: you join ${when}`,
              body: `Hi ${firstName(cand)}, a reminder that you join ${when}${j.joiningTime ? ` at ${j.joiningTime}` : ''}. Please carry your documents. — TeamLink`, actor: null,
            });
            // eslint-disable-next-line no-await-in-loop
            await saveTrack(appId, track, null);
          }
        }
      }
    }
  }
  if (!dryRun && st.armed) await saveReminders({ lastRunAt: now.toISOString() }, null);
  return summary;
}

module.exports = {
  PREFIX, REMINDERS_KEY, STATE_WORDS, Bad,
  isClientJob, isClientUser, isAdmin, isBdeTeam, mayReleaseForClient, mayOpenFiles,
  getTrack, saveTrack, loadAll, blank, stateOf, wordsOf, peopleFor,
  release, share, onCandidateAnswer, acknowledge, confirmJoining, markJoinedByClient, onInvoiceDraft, invoiceChip,
  shapeFor, shapeForClient, attachTo, fileOf, readFields,
  joiningToken, joiningTokenOk, joiningUrl, timeline,
  loadReminders, saveReminders, runReminders, loadApp, firstName, today,
};
