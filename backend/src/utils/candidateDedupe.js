// ---------------------------------------------------------------------------
// CANDIDATE DUPLICATES — one Candidate Master, many applications (spec #2 §12).
//
// THE KEYS
//   phone   the last ten digits of every number in the cell ("+91 98765 43210",
//           "98765-43210" and "9876543210" are one number; a cell carrying two
//           numbers yields two keys). Junk numbers (0000000000, 1234567890,
//           nine repeated digits) are never a key.
//   email   the first address-shaped token, lower-cased, trailing dots dropped
//           ("e-mail: Venky@Gmail.com." -> "venky@gmail.com").
//   name    lower-cased, punctuation stripped, tokens SORTED — so "C. Pravalika",
//           "C Pravalika", "C.Pravalika" and "Pravalika C" share one key.
//
// THE RULE
//   A phone or email hit is a DUPLICATE (strong). A name hit on its own is only
//   a POSSIBLE match (weak hint) and never blocks anything, never merges
//   anything by itself. A merge always needs a person to choose the master and
//   confirm the group (routes/candidates.js /duplicates/*, Super Admin / Admin).
//
// THE MERGE (mergeCandidates)
//   * every row that points at a donor moves to the master: applications,
//     pipeline history, follow-ups, messages, notes, documents, invoices,
//     candidate logins, the donor's audit rows, sync-log references;
//   * blanks on the master are filled from the donors — nothing on the master
//     is ever overwritten;
//   * Application is unique per (candidate, requirement): where both applied to
//     the same requirement the MORE ADVANCED application is kept, the other's
//     history / interview events / follow-ups / messages are re-pointed to it,
//     and a note on the master records what the folded application said;
//   * one AuditLog row carries a JSON snapshot of every donor and its
//     applications as they were, plus the counts of what moved.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const { stageIndex } = require('./pipelineView');
const { stageLabel } = require('./atsVocab');

// --- keys ------------------------------------------------------------------
function isJunkPhone(k) {
  if (!k || k.length !== 10) return true;
  if (/^(\d)\1{8,}/.test(k) || /(\d)\1{8,}$/.test(k)) return true; // 9999999999, 0000000001
  if (['1234567890', '0123456789', '9876543210'].includes(k)) return true;
  if (/^0/.test(k)) return true; // a mobile never starts with 0 once +91/0 is dropped
  return false;
}

function phoneKeys(raw) {
  const out = [];
  String(raw || '').split(/[,;/|]|\s{2,}/).forEach((part) => {
    const d = part.replace(/\D/g, '');
    if (d.length === 20) { out.push(d.slice(0, 10), d.slice(10)); return; } // two numbers, one space
    if (d.length >= 10) out.push(d.slice(-10));
  });
  return [...new Set(out.filter((k) => !isJunkPhone(k)))];
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
function emailKey(raw) {
  const m = String(raw || '').match(EMAIL_RE);
  if (!m) return '';
  const e = m[0].toLowerCase().replace(/\.+$/, '');
  if (/^(na|nil|none|test|abc|xyz|noemail|no-email)@/.test(e)) return '';
  return e;
}

function nameKey(raw) {
  return String(raw || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter(Boolean).sort().join(' ');
}
// Only a name with two or more parts is specific enough to hint at anybody.
const nameIsHintable = (k) => k.split(' ').length >= 2 && k.replace(/ /g, '').length >= 6;

// --- matching a NEW entry (Add Candidate, imports) ---------------------------
// `pool` is [{ id, name, email, phone }] — the list cache's working set. The
// index is memoised per pool array + version so a check costs a Map lookup.
let memo = { key: null, byPhone: null, byEmail: null, byName: null };
function indexOf(pool, version) {
  if (memo.key === version && memo.pool === pool) return memo;
  const byPhone = new Map();
  const byEmail = new Map();
  const byName = new Map();
  const add = (m, k, c) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(c); };
  pool.forEach((c) => {
    phoneKeys(c.phone).forEach((k) => add(byPhone, k, c));
    add(byEmail, emailKey(c.email), c);
    const nk = nameKey(c.name);
    if (nameIsHintable(nk)) add(byName, nk, c);
  });
  memo = { key: version, pool, byPhone, byEmail, byName };
  return memo;
}

// Returns [{ id, reasons: ['phone'|'email'|'name'], strength: 'strong'|'possible' }]
// strongest first. `extra` are candidate rows fetched fresh from the database
// (so a phone edited a second ago is still caught).
function matchEntry({ email, phone, name, excludeId }, pool, version, extra = []) {
  const ix = indexOf(pool, version);
  const pk = phoneKeys(phone);
  const ek = emailKey(email);
  const nk = nameKey(name);
  const hits = new Map();
  const hit = (c, why) => {
    if (!c || c.id === excludeId) return;
    if (!hits.has(c.id)) hits.set(c.id, { id: c.id, reasons: new Set() });
    hits.get(c.id).reasons.add(why);
  };
  pk.forEach((k) => (ix.byPhone.get(k) || []).forEach((c) => hit(c, 'phone')));
  if (ek) (ix.byEmail.get(ek) || []).forEach((c) => hit(c, 'email'));
  extra.forEach((c) => {
    if (pk.length && phoneKeys(c.phone).some((k) => pk.includes(k))) hit(c, 'phone');
    if (ek && emailKey(c.email) === ek) hit(c, 'email');
  });
  // A name agreeing with a phone/email hit is noted on that hit (it makes the
  // hit more certain); a name alone is a possible match, capped — "Sanjay
  // Kumar" alone is dozens of different people and not worth listing.
  if (nameIsHintable(nk)) {
    hits.forEach((h) => {
      const c = pool.find((x) => x.id === h.id) || extra.find((x) => x.id === h.id);
      if (c && nameKey(c.name) === nk) h.reasons.add('name');
    });
    const byName = (ix.byName.get(nk) || []).filter((c) => c.id !== excludeId && !hits.has(c.id));
    if (byName.length && byName.length <= 5) byName.forEach((c) => hit(c, 'name'));
  }
  return [...hits.values()]
    .map((h) => {
      const reasons = [...h.reasons];
      return { id: h.id, reasons, strength: reasons.some((r) => r === 'phone' || r === 'email') ? 'strong' : 'possible' };
    })
    .sort((a, b) => (a.strength === b.strength ? b.reasons.length - a.reasons.length : (a.strength === 'strong' ? -1 : 1)));
}

// --- existing duplicate GROUPS (the review page) ----------------------------
const groupIdOf = (ids) => crypto.createHash('sha1').update(ids.slice().sort().join(',')).digest('hex').slice(0, 12);

// Union-find over phone and email keys: a group is everyone connected by a
// shared number or address. `kind: 'contact'`.
// Name-only groups (`kind: 'name'`) are people sharing a name key where the
// contact details do NOT contradict — at most one distinct phone and one
// distinct email across the group (blanks allowed). A hint, never a merge on
// its own; the page asks for an extra confirmation.
function computeGroups(pool) {
  const parent = new Map();
  const find = (x) => { let r = x; while (parent.get(r) !== r) r = parent.get(r); let y = x; while (parent.get(y) !== r) { const n = parent.get(y); parent.set(y, r); y = n; } return r; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const byId = new Map(pool.map((c) => [c.id, c]));
  pool.forEach((c) => parent.set(c.id, c.id));
  const firstBy = new Map();
  const why = new Map(); // root-independent: id -> Set of shared keys
  pool.forEach((c) => {
    const keys = [...phoneKeys(c.phone).map((k) => `p:${k}`), ...(emailKey(c.email) ? [`e:${emailKey(c.email)}`] : [])];
    keys.forEach((k) => {
      if (firstBy.has(k)) {
        union(c.id, firstBy.get(k));
        [c.id, firstBy.get(k)].forEach((id) => { if (!why.has(id)) why.set(id, new Set()); why.get(id).add(k); });
      } else firstBy.set(k, c.id);
    });
  });
  const buckets = new Map();
  pool.forEach((c) => {
    const r = find(c.id);
    if (!buckets.has(r)) buckets.set(r, []);
    buckets.get(r).push(c.id);
  });
  const contact = [];
  const inContact = new Set();
  buckets.forEach((ids) => {
    if (ids.length < 2) return;
    ids.forEach((id) => inContact.add(id));
    const keys = new Set();
    ids.forEach((id) => (why.get(id) || []).forEach((k) => keys.add(k)));
    const nks = new Set(ids.map((id) => nameKey(byId.get(id).name)));
    contact.push({
      id: groupIdOf(ids),
      kind: 'contact',
      memberIds: ids,
      sharedPhones: [...keys].filter((k) => k.startsWith('p:')).map((k) => k.slice(2)),
      sharedEmails: [...keys].filter((k) => k.startsWith('e:')).map((k) => k.slice(2)),
      nameAgreement: nameAgreementOf(ids.map((id) => byId.get(id).name), nks),
    });
  });

  const byName = new Map();
  pool.forEach((c) => {
    const nk = nameKey(c.name);
    if (!nameIsHintable(nk)) return;
    if (!byName.has(nk)) byName.set(nk, []);
    byName.get(nk).push(c);
  });
  const name = [];
  byName.forEach((members, nk) => {
    if (members.length < 2 || members.length > 6) return; // six "Sanjay Kumar"s are six people
    if (members.every((m) => inContact.has(m.id))) return; // already a contact group
    const phones = new Set(members.flatMap((m) => phoneKeys(m.phone)));
    const emails = new Set(members.map((m) => emailKey(m.email)).filter(Boolean));
    if (phones.size > 1 || emails.size > 1) return; // contradicting contacts: different people
    const ids = members.map((m) => m.id);
    name.push({ id: groupIdOf(ids), kind: 'name', memberIds: ids, nameKey: nk, sharedPhones: [], sharedEmails: [], nameAgreement: 'same' });
  });
  return { contact, name };
}

// Two name tokens that are plausibly the same word: equal, an initial of the
// other ("P" / "Pendyala"), or one spelling slip apart ("Prashanthi" /
// "Prasanthi", "Pratik" / "Prathik").
function editDistanceAtMost1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; let j = 0; let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1; else if (b.length > a.length) j += 1; else { i += 1; j += 1; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
const tokenLike = (x, y) => x === y
  || (x.length === 1 && y.startsWith(x)) || (y.length === 1 && x.startsWith(y))
  || (x.length >= 4 && y.length >= 4 && (editDistanceAtMost1(x, y) || x.includes(y) || y.includes(x)));

function nameAgreementOf(names, keys) {
  if (keys.size === 1) return 'same';
  // "Pratik vijayrao Vaidya" vs "Prathik Vaidya": a shared (or near-same)
  // full word between every pair = a variant of one name.
  // Tokens as written plus the whole name run together ("DeviBai" = "Devi Bai").
  const toks = [...keys].map((k) => [...k.split(' '), k.replace(/ /g, '')]);
  const pairOk = (t, u) => t.some((x) => x.length > 1 && u.some((y) => y.length > 1 && tokenLike(x, y)));
  const overlap = toks.every((t) => toks.every((u) => t === u || pairOk(t, u)));
  return overlap ? 'variant' : 'different';
}

// --- which application is "more advanced" ----------------------------------
function appRank(a) {
  if (['JOINED', 'HIRED'].includes(a.stage)) return 1000;
  if (a.stage === 'HOLD') return -1;
  if (a.stage === 'REJECTED') return -2;
  return stageIndex(a.stage);
}
function moreAdvanced(a, b) {
  const d = appRank(a) - appRank(b);
  if (d !== 0) return d > 0 ? a : b;
  return new Date(a.updatedAt || a.createdAt) >= new Date(b.updatedAt || b.createdAt) ? a : b;
}

// Candidate columns a merge may fill on the master (never overwrite).
const FILLABLE = [
  'email', 'phone', 'skills', 'experienceYears', 'dob', 'gender', 'location', 'preferredLocation',
  'currentCompany', 'currentDesignation', 'relevantExperienceYears', 'currentSalary', 'expectedSalary',
  'noticePeriod', 'availability', 'jobPreference', 'preferredEmploymentType', 'preferredWorkMode',
  'education', 'specialization', 'institute', 'passingYear', 'goodToHaveSkills', 'technicalSkills',
  'softSkills', 'resumeName', 'resumeScore', 'firstSource', 'sourceCampaign', 'externalRef',
];
const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

class MergeError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const APP_SUMMARY_SELECT = {
  id: true, candidateId: true, requirementId: true, stage: true, createdAt: true, updatedAt: true,
  interviewStatus: true, interviewAt: true, interviewResult: true, interviewFeedback: true,
  aiInterviewStatus: true, aiInterviewScore: true, matchScore: true, offerStatus: true, joiningStatus: true,
  requirement: { select: { id: true, title: true, internal: true, client: { select: { name: true } } } },
};

async function loadForMerge(masterId, donorIds, db = prisma) {
  const ids = [masterId, ...donorIds];
  if (!masterId || !donorIds.length) throw new MergeError('Choose the master record and at least one other record to merge into it.');
  if (new Set(ids).size !== ids.length) throw new MergeError('A record cannot be both the master and merged into it.');
  if (ids.length > 10) throw new MergeError('At most ten records per merge.');
  const rows = await db.candidate.findMany({ where: { id: { in: ids } }, include: { applications: { select: APP_SUMMARY_SELECT } } });
  if (rows.length !== ids.length) throw new MergeError('One of these candidates no longer exists — reload the page.', 409);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { master: byId.get(masterId), donors: donorIds.map((id) => byId.get(id)) };
}

const reqText = (a) => (a.requirement
  ? `${a.requirement.title}${a.requirement.internal ? ' · TeamLink Internal' : (a.requirement.client ? ` · ${a.requirement.client.name}` : '')}`
  : a.requirementId);

// What a merge would do, without doing it.
async function previewMerge({ masterId, donorIds }) {
  const { master, donors } = await loadForMerge(masterId, donorIds);
  const masterByReq = new Map(master.applications.map((a) => [a.requirementId, a]));
  const moves = [];
  const conflicts = [];
  donors.forEach((d) => d.applications.forEach((a) => {
    const m = masterByReq.get(a.requirementId);
    if (!m) { moves.push({ applicationId: a.id, requirement: reqText(a), stage: stageLabel(a.stage), from: d.name }); return; }
    const keep = moreAdvanced(m, a);
    conflicts.push({
      requirement: reqText(a),
      master: { applicationId: m.id, stage: stageLabel(m.stage) },
      donor: { applicationId: a.id, stage: stageLabel(a.stage), candidate: d.name },
      keep: keep.id === m.id ? 'master' : 'donor',
      keptStage: stageLabel(keep.stage),
    });
  }));
  const fills = {};
  FILLABLE.forEach((f) => {
    if (!blank(master[f])) return;
    const src = donors.find((d) => !blank(d[f]));
    if (src) fills[f] = { value: src[f], from: src.name };
  });
  const lostRefs = donors.filter((d) => d.externalRef && master.externalRef && d.externalRef !== master.externalRef
    && fills.externalRef?.value !== d.externalRef).map((d) => d.externalRef);
  const [notes, docs, msgs, fus] = await Promise.all([
    prisma.candidateNote.count({ where: { candidateId: { in: donorIds } } }),
    prisma.candidateDocument.count({ where: { candidateId: { in: donorIds } } }),
    prisma.candidateMessage.count({ where: { candidateId: { in: donorIds } } }),
    prisma.applicationFollowUp.count({ where: { candidateId: { in: donorIds } } }),
  ]);
  return {
    master: { id: master.id, name: master.name },
    donors: donors.map((d) => ({ id: d.id, name: d.name, applications: d.applications.length })),
    moves, conflicts, fills, lostRefs,
    counts: { applications: moves.length, conflicts: conflicts.length, notes, documents: docs, messages: msgs, followUps: fus },
  };
}

async function mergeCandidates({ masterId, donorIds, user }) {
  const actor = user ? user.name : 'System';
  const moved = {
    applications: 0, conflicts: 0, stageEvents: 0, followUps: 0, messages: 0, notes: 0, documents: 0,
    invoices: 0, users: 0, auditRows: 0, interviewEvents: 0, feedback: 0,
  };
  const conflictNotes = [];
  let snapshot = null;
  const folded = [];
  let filled = {};

  await prisma.$transaction(async (tx) => {
    const { master, donors } = await loadForMerge(masterId, donorIds, tx);
    // The record of what the donors were, whole, before anything moves.
    const fullDonors = await tx.candidate.findMany({ where: { id: { in: donorIds } }, include: { applications: true } });
    snapshot = fullDonors;

    const masterApps = new Map(master.applications.map((a) => [a.requirementId, a]));
    // Move one application's children onto another (same requirement).
    const fold = async (loser, winner) => {
      // The folded application, whole, with its feedback — into the snapshot.
      folded.push(await tx.application.findUnique({ where: { id: loser.id }, include: { interviewFeedbacks: true } }));
      const ev = await tx.applicationStageEvent.updateMany({ where: { applicationId: loser.id }, data: { applicationId: winner.id, candidateId: masterId } });
      moved.stageEvents += ev.count;
      await tx.applicationFollowUp.updateMany({
        where: { applicationId: loser.id, completedAt: null },
        data: { completedAt: new Date(), completedNote: 'Closed on candidate merge — duplicate application folded into the kept one.' },
      });
      const fu = await tx.applicationFollowUp.updateMany({ where: { applicationId: loser.id }, data: { applicationId: winner.id, candidateId: masterId } });
      moved.followUps += fu.count;
      const ie = await tx.interviewEvent.updateMany({ where: { applicationId: loser.id }, data: { applicationId: winner.id } });
      moved.interviewEvents += ie.count;
      const loserFb = await tx.interviewFeedback.findMany({ where: { applicationId: loser.id } });
      const winnerKinds = new Set((await tx.interviewFeedback.findMany({ where: { applicationId: winner.id }, select: { kind: true } })).map((f) => f.kind));
      for (const f of loserFb) {
        if (winnerKinds.has(f.kind)) continue; // kept in the note + snapshot below
        // eslint-disable-next-line no-await-in-loop
        await tx.interviewFeedback.update({ where: { id: f.id }, data: { applicationId: winner.id } });
        moved.feedback += 1;
      }
      await tx.candidateMessage.updateMany({ where: { applicationId: loser.id }, data: { applicationId: winner.id } });
      await tx.candidateNote.updateMany({ where: { applicationId: loser.id }, data: { applicationId: winner.id } });
      await tx.auditLog.updateMany({ where: { entity: 'Application', entityId: loser.id }, data: { entityId: winner.id } });
      const droppedFb = loserFb.filter((f) => winnerKinds.has(f.kind));
      const line = [
        `Candidate merge: two applications for ${reqText(loser)}. Kept the more advanced one (${stageLabel(winner.stage)}).`,
        `The folded application was at ${stageLabel(loser.stage)}, applied ${new Date(loser.createdAt).toISOString().slice(0, 10)}`,
        loser.aiInterviewScore != null ? `AI score ${loser.aiInterviewScore}` : null,
        loser.interviewResult ? `client interview result ${loser.interviewResult}` : null,
        loser.interviewFeedback ? `interview notes: ${String(loser.interviewFeedback).slice(0, 300)}` : null,
        droppedFb.length ? `${droppedFb.map((f) => `${f.kind} feedback: ${f.recommendation} — ${String(f.overall).slice(0, 200)}`).join('; ')}` : null,
        `Its pipeline history now sits on the kept application. Merged by ${actor}.`,
      ].filter(Boolean).join(' · ');
      await tx.candidateNote.create({
        data: { candidateId: masterId, applicationId: winner.id, body: line, authorUserId: user ? user.id : null, authorName: actor, authorRole: 'Merge' },
      });
      conflictNotes.push(line);
      await tx.application.delete({ where: { id: loser.id } });
      moved.conflicts += 1;
    };

    for (const d of donors) {
      for (const a of d.applications) {
        const m = masterApps.get(a.requirementId);
        if (!m) {
          // eslint-disable-next-line no-await-in-loop
          await tx.application.update({ where: { id: a.id }, data: { candidateId: masterId } });
          masterApps.set(a.requirementId, a);
          moved.applications += 1;
          continue;
        }
        const keep = moreAdvanced(m, a);
        if (keep.id === m.id) {
          // eslint-disable-next-line no-await-in-loop
          await fold(a, m);
        } else {
          // eslint-disable-next-line no-await-in-loop
          await fold(m, a);
          // eslint-disable-next-line no-await-in-loop
          await tx.application.update({ where: { id: a.id }, data: { candidateId: masterId } });
          masterApps.set(a.requirementId, a);
          moved.applications += 1;
        }
      }
      const where = { candidateId: d.id };
      const data = { candidateId: masterId };
      /* eslint-disable no-await-in-loop */
      moved.stageEvents += (await tx.applicationStageEvent.updateMany({ where, data })).count;
      moved.followUps += (await tx.applicationFollowUp.updateMany({ where, data })).count;
      moved.messages += (await tx.candidateMessage.updateMany({ where, data })).count;
      moved.notes += (await tx.candidateNote.updateMany({ where, data })).count;
      moved.documents += (await tx.candidateDocument.updateMany({ where, data })).count;
      // resume_: stored resume versions follow the person (never cascade-deleted).
      await tx.candidateResume.updateMany({ where, data });
      moved.invoices += (await tx.invoice.updateMany({ where, data })).count;
      moved.users += (await tx.user.updateMany({ where, data })).count;
      moved.auditRows += (await tx.auditLog.updateMany({ where: { entity: 'Candidate', entityId: d.id }, data: { entityId: masterId } })).count;
      await tx.syncLog.updateMany({ where: { recordRef: d.id }, data: { recordRef: masterId } });
      /* eslint-enable no-await-in-loop */
    }

    // Blanks on the master only — the master's own values are never touched.
    const fill = {};
    FILLABLE.forEach((f) => {
      if (!blank(master[f])) return;
      const src = fullDonors.find((d) => !blank(d[f]));
      if (src) fill[f] = src[f];
    });
    const leftApps = await tx.application.count({ where: { candidateId: { in: donorIds } } });
    if (leftApps) throw new MergeError('Some applications could not be moved — nothing was changed.', 500);
    await tx.candidate.deleteMany({ where: { id: { in: donorIds } } });
    if (Object.keys(fill).length) await tx.candidate.update({ where: { id: masterId }, data: fill });
    filled = fill;
  }, { timeout: 60000, maxWait: 10000 });

  const { logAudit } = require('./audit'); // eslint-disable-line global-require
  await logAudit({
    userId: user ? user.id : null,
    actorName: actor,
    action: `Candidates merged — ${donorIds.length} duplicate record(s) folded into this one`,
    entity: 'Candidate',
    entityId: masterId,
    fromValue: JSON.stringify({ donors: snapshot, foldedApplications: folded }),
    toValue: JSON.stringify({ moved, filled: Object.keys(filled), conflicts: conflictNotes.length }),
    reason: 'Duplicate candidate merge (confirmed on Candidates > Duplicates)',
  });
  return { masterId, donorIds, moved, filled: Object.keys(filled), conflictNotes };
}

module.exports = {
  phoneKeys, emailKey, nameKey, nameIsHintable, isJunkPhone,
  matchEntry, computeGroups, previewMerge, mergeCandidates, MergeError, moreAdvanced, appRank,
};
