// ---------------------------------------------------------------------------
// DUPLICATES — who may do what, what is shown to whom, the resolutions and the worklist.
// (utils/candidateDupes.js holds the index / flags / gate; utils/candidateMerge.js the merge engine.)
//
// RESOLUTIONS (a flag leaves OPEN only through one of these, each audited):
//   NOT_DUPLICATE          "Not a duplicate" — a reason is required; the pair is remembered and never flagged again
//   SAME_PERSON_OTHER_JOB  the new profile's applications are added to the existing profile (a merge that keeps both
//                          applications; refused when both applied to the SAME job), the new profile is retired
//   REJECTED               "Reject duplicate" — the new profile's first-step applications are rejected, reason "Duplicate"
//   MERGED                 "Merge into the existing profile" — field-by-field choices, then the merge engine
// MAKER-CHECKER: a recruiter who owns the first step may mark Not a duplicate / Same person, different job / Reject and may
// REQUEST a merge (the flag keeps holding). A TL who covers either profile's team, or an Admin / Super Admin, approves and
// performs the merge. A TL of another team, a BDE, a BDE TL, a Manager (view only), a client or a candidate cannot.
//
// PRIVACY: a BDE / BDE TL (or any login whose Role Catalog switch "Candidate Contact & Salary" is off) is never served a
// phone / e-mail / pay value through these screens — only "matched on phone". A profile outside the viewer's area is
// shown as "a profile exists with the same phone (owner: <name>)", nothing else.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const DUP = require('./candidateDupes');
const FP = require('./candidateFingerprint');
const MERGE = require('./candidateMerge');
const D = require('./candidateDedupe');
const SC = require('./scope');
const PERM = require('./permissions');
const CS = require('./candidateSource');
const { stageLabel } = require('./atsVocab');
const { logAudit } = require('./audit');

const { MergeError } = D;
const res = (status, body) => ({ status, body });

// --- who is asking ----------------------------------------------------------------------------
function actorKind(user) {
  const external = PERM.isExternalLogin(user);
  const role = PERM.stageRoleOf(user);
  const global = !external && PERM.stageGlobal(user);
  const bde = !external && SC.clientViewRole(user) === 'bde'; // BDE and the BDE TL
  const lead = !external && !bde && ['TL', 'STL'].includes(role);
  const doer = !external && !bde && (global || lead || ['RECRUITER', 'HR'].includes(role));
  const viewer = !external && !bde && (doer || ['MANAGER', 'ASSISTANT_MANAGER'].includes(role));
  let hideContact = bde || external;
  try { const f = require('./clientRedact').privacyFlagsFor(user); if (f && f.contact) hideContact = true; } catch { /* default */ } // eslint-disable-line global-require
  return { external, role, global, bde, lead, doer, viewer, hideContact };
}

// The profiles behind a set of flags, straight from the database (NOT the list's big in-memory copy, so the worklist
// opens fast even right after a restart). Rows are kept for a few seconds so a click-through does not re-read them.
const PROFILE_TTL = 3000;
const PROFILE_CACHE = new Map(); // id -> { at, row }
const WORK_SELECT = {
  id: true, name: true, phone: true, email: true, source: true, firstSource: true, createdAt: true,
  applications: {
    include: {
      requirement: {
        include: {
          client: { select: { id: true, name: true } },
          recruiter: { select: { id: true, name: true } },
          bde: { select: { id: true, name: true } },
        },
      },
    },
  },
};
async function profilesFor(ids) {
  const now = Date.now();
  const need = [...new Set(ids)].filter((id) => { const h = PROFILE_CACHE.get(id); return !h || now - h.at > PROFILE_TTL; });
  for (const part of DUP.chunks(need, 300)) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.candidate.findMany({ where: { id: { in: part } }, select: WORK_SELECT });
    const got = new Set();
    rows.forEach((r) => { PROFILE_CACHE.set(r.id, { at: now, row: r }); got.add(r.id); });
    part.forEach((id) => { if (!got.has(id)) PROFILE_CACHE.set(id, { at: now, row: null }); });
  }
  if (PROFILE_CACHE.size > 6000) { const old = [...PROFILE_CACHE.entries()].sort((x, y) => x[1].at - y[1].at).slice(0, 3000); old.forEach(([k]) => PROFILE_CACHE.delete(k)); }
  const byId = new Map();
  ids.forEach((id) => { const h = PROFILE_CACHE.get(id); if (h && h.row) byId.set(id, h.row); });
  return byId;
}

// Is this candidate (by id) inside the viewer's area? `flagRows` are the flags being looked at.
async function areaChecker(user, kind, flagRows) {
  const st = { byId: await profilesFor(flagRows.flatMap((f) => [f.candidateId, f.matchCandidateId])) };
  const memo = new Map();
  const inArea = (id) => {
    if (kind.global) return true;
    if (memo.has(id)) return memo.get(id);
    const c = st.byId.get(id);
    const ok = !!c && (c.applications || []).some((x) => x.requirement && SC.applicationInScope(user, x));
    memo.set(id, ok);
    return ok;
  };
  return { st, inArea };
}

// --- cards -------------------------------------------------------------------------------------
const CARD_SELECT = {
  id: true, name: true, phone: true, email: true, location: true, source: true, firstSource: true, createdAt: true,
  experienceYears: true, currentCompany: true, currentDesignation: true, skills: true, education: true, institute: true, resumeName: true, profileStatus: true,
  applications: {
    include: {
      requirement: {
        include: {
          client: { select: { id: true, name: true } },
          recruiter: { select: { id: true, name: true } },
          bde: { select: { id: true, name: true } },
        },
      },
    },
  },
};
async function loadProfiles(ids) {
  const rows = await prisma.candidate.findMany({ where: { id: { in: [...new Set(ids.filter(Boolean))] } }, select: CARD_SELECT });
  return new Map(rows.map((r) => [r.id, r]));
}
const maskPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 4 ? `${'x'.repeat(Math.max(0, d.length - 4))}${d.slice(-4)}` : null; };

function lastActivityOf(c) {
  const t = [DUP.ms(c.createdAt), ...(c.applications || []).map((a) => DUP.ms(a.updatedAt) || DUP.ms(a.createdAt))].filter(Boolean);
  return t.length ? new Date(Math.max(...t)).toISOString() : null;
}
function ownerOfCandidate(c) {
  const apps = [...(c.applications || [])].sort((a, b) => (DUP.ms(b.createdAt) || 0) - (DUP.ms(a.createdAt) || 0));
  const r = apps[0] && apps[0].requirement;
  return {
    recruiterId: r ? r.recruiterId || null : null,
    recruiter: r && r.recruiter ? r.recruiter.name : null,
    tl: r ? r.tl || null : null,
    tlId: r ? r.tlId || null : null,
    department: r ? r.department || null : null,
  };
}

// One profile as THIS viewer may see it.
function card(c, { user, kind, inArea, reasons = [] }) {
  if (!c) return { id: null, gone: true, text: 'This profile no longer exists.' };
  const own = ownerOfCandidate(c);
  if (!inArea) {
    const why = reasons.map((r) => (FP.REASON_SHORT[r] || r)).filter((r) => ['phone', 'email', 'resume file'].includes(r))[0] || 'details';
    return {
      id: c.id, inScope: false, name: null, owner: own.recruiter || own.tl || 'another team', ownerTl: own.tl, department: own.department,
      text: `A profile exists with the same ${why} (owner: ${own.recruiter || own.tl || 'another team'}).`,
    };
  }
  const apps = (c.applications || []).filter((a) => kind.global || (a.requirement && SC.applicationInScope(user, a)));
  const sorted = [...apps].sort((a, b) => (DUP.ms(b.createdAt) || 0) - (DUP.ms(a.createdAt) || 0));
  const latest = sorted[0] || null;
  const showContact = !kind.hideContact;
  return {
    id: c.id, inScope: true, name: c.name, createdAt: DUP.iso(c.createdAt),
    source: CS.sourceOfPerson(c, latest).key,
    location: c.location || null, experienceYears: c.experienceYears == null ? null : c.experienceYears,
    currentCompany: c.currentCompany || null, currentDesignation: c.currentDesignation || null,
    skills: c.skills ? String(c.skills).slice(0, 120) : null, hasResume: !!c.resumeName,
    phone: showContact ? c.phone || null : null, email: showContact ? c.email || null : null,
    phoneHint: !showContact ? null : undefined,
    stage: latest ? latest.stage : null, stageLabel: latest ? stageLabel(latest.stage) : 'No job yet',
    owner: own.recruiter || null, ownerTl: own.tl, department: own.department,
    lastActivity: lastActivityOf(c),
    applicationCount: (c.applications || []).length,
    otherAreaApplications: (c.applications || []).length - apps.length,
    archived: c.profileStatus === 'Archived',
    applications: sorted.slice(0, 8).map((a) => ({
      id: a.id, requirementId: a.requirementId, title: a.requirement ? a.requirement.title : null,
      client: a.requirement ? (a.requirement.internal ? 'TeamLink Internal' : (a.requirement.client && a.requirement.client.name) || null) : null,
      stage: a.stage, stageLabel: stageLabel(a.stage), createdAt: DUP.iso(a.createdAt),
    })),
  };
}

// What matched, in plain words. Values only where the viewer may see contact details.
function matchedOn(flag, a, b, kind) {
  const out = [];
  flag.reasons.forEach((r) => {
    const it = { kind: r, label: FP.REASON_TEXT[r] || r };
    if (!kind.hideContact && a && b) {
      if (r === 'phone') {
        const pa = FP.normPhones(a.phone); const pb = FP.normPhones(b.phone);
        it.value = pa.find((x) => pb.includes(x)) || null;
      }
      if (r === 'email') it.value = FP.normEmail(a.email) || null;
    }
    out.push(it);
  });
  return out;
}

// --- permissions on ONE flag --------------------------------------------------------------------
// ctx: { kind, subjectIn, matchIn }
function capsFor(user, flag, ctx) {
  const k = ctx.kind;
  const open = DUP.HOLDING.includes(flag.status);
  const mine = flag.enteredById && flag.enteredById === user.id;
  const basic = open && k.doer && (k.global || ctx.subjectIn || mine || (k.lead && ctx.matchIn));
  const merge = open && (k.global || (k.lead && (ctx.subjectIn || ctx.matchIn)));
  return {
    canResolve: !!basic, // not a duplicate · same person different job · reject
    canRequestMerge: !!basic && flag.status === 'OPEN' && !merge,
    canMerge: !!merge,
    canDecline: !!merge && flag.status === 'MERGE_REQUESTED',
  };
}

// --- the panel for ONE candidate ------------------------------------------------------------------
async function panelFor(user, candidateId, { all = false } = {}) {
  const kind = actorKind(user);
  if (!(await DUP.supported())) return { supported: false, items: [] };
  const flagsAll = await DUP.flagsOfCandidate(candidateId);
  const flags = all ? flagsAll : flagsAll.filter((f) => DUP.HOLDING.includes(f.status));
  const ids = [candidateId, ...flags.flatMap((f) => [f.candidateId, f.matchCandidateId])];
  const profiles = await loadProfiles(ids);
  const area = (id) => {
    const c = profiles.get(id);
    if (!c) return false;
    if (kind.global) return true;
    return (c.applications || []).some((a) => a.requirement && SC.applicationInScope(user, a));
  };
  const items = flags.map((f) => {
    const sub = profiles.get(f.candidateId); const mat = profiles.get(f.matchCandidateId);
    const subjectIn = area(f.candidateId); const matchIn = area(f.matchCandidateId);
    const caps = capsFor(user, f, { kind, subjectIn, matchIn });
    const bothSeen = subjectIn && matchIn;
    return {
      flag: f,
      holds: DUP.BLOCKING_LEVELS.includes(f.level) && DUP.HOLDING.includes(f.status),
      role: f.candidateId === candidateId ? 'new' : 'existing', // is THIS profile the newer one (held) or the older one
      levelText: FP.LEVEL_TEXT[f.level],
      matchedOn: matchedOn(f, bothSeen ? sub : null, bothSeen ? mat : null, kind),
      newer: card(sub, { user, kind, inArea: subjectIn, reasons: f.reasons }),
      existing: card(mat, { user, kind, inArea: matchIn, reasons: f.reasons }),
      caps: kind.bde || kind.external ? { canResolve: false, canRequestMerge: false, canMerge: false, canDecline: false } : caps,
      bothSeen,
    };
  });
  const holds = items.some((i) => i.holds && i.role === 'new');
  const portal = await DUP.alreadyInAts(candidateId);
  return { supported: true, candidateId, holds, items, portal, viewer: { doer: kind.doer, lead: kind.lead, global: kind.global, bde: kind.bde, hideContact: kind.hideContact } };
}

// --- helpers for the resolutions -------------------------------------------------------------------------
async function loadForAction(user, flagId, need) {
  if (!(await DUP.supported())) return { error: res(404, { error: 'Duplicate checking is not switched on yet.' }) };
  const flag = await DUP.getFlag(flagId);
  if (!flag) return { error: res(404, { error: 'This duplicate is no longer on the list.' }) };
  const kind = actorKind(user);
  const profiles = await loadProfiles([flag.candidateId, flag.matchCandidateId]);
  const inArea = (id) => {
    const c = profiles.get(id);
    if (!c) return false;
    if (kind.global) return true;
    return (c.applications || []).some((a) => a.requirement && SC.applicationInScope(user, a));
  };
  const caps = capsFor(user, flag, { kind, subjectIn: inArea(flag.candidateId), matchIn: inArea(flag.matchCandidateId) });
  if (!DUP.HOLDING.includes(flag.status)) {
    return { error: res(409, { error: `This one is already done (${flag.statusText}).` }) };
  }
  if (!kind.doer) return { error: res(403, { error: 'Only the recruiter on this profile, their TL or an Admin can sort out a duplicate.' }) };
  if (need === 'merge' && !caps.canMerge) {
    return { error: res(403, { error: kind.lead || kind.global ? 'This profile belongs to another team. Ask that team\'s TL or an Admin to merge it.' : 'Only a TL of this team or an Admin can merge profiles. Press "Ask TL to merge" and they will be asked.' }) };
  }
  if (need === 'resolve' && !caps.canResolve) return { error: res(403, { error: 'This profile is not in your area, so you cannot decide on it.' }) };
  if (need === 'decline' && !caps.canDecline) return { error: res(403, { error: 'Only a TL of this team or an Admin can answer a merge request.' }) };
  return { flag, kind, profiles, caps, inArea };
}

async function finish(flag, status, user, { reason = null, mergeLogId = null, resolution = null } = {}) {
  const now = Date.now();
  await DUP.ex(`UPDATE CandidateDupFlag SET status = ?, resolution = ?, reason = ?, resolvedAt = ?, resolvedById = ?, resolvedByName = ?, mergeLogId = COALESCE(?, mergeLogId), updatedAt = ? WHERE id = ?`,
    status, resolution || status, reason, now, user.id, user.name, mergeLogId, now, flag.id);
  DUP.bump();
  try { require('./candidateListCache').markCandidateDirty(flag.candidateId); } catch { /* optional */ } // eslint-disable-line global-require
}
const nameOfProfile = (profiles, id) => (profiles.get(id) ? profiles.get(id).name : 'the profile');

async function audit(user, flag, action, toValue, reason, entityId = null) {
  await logAudit({
    userId: user.id, actorName: user.name, action, entity: 'Candidate', entityId: entityId || flag.candidateId,
    fromValue: `${flag.level}: ${flag.reasons.join('+')} (vs ${flag.matchCandidateId})`, toValue, reason: reason ? String(reason).slice(0, 500) : null,
  });
}

// --- NOT A DUPLICATE ----------------------------------------------------------------------------------------
async function notDuplicate(user, flagId, body = {}) {
  const ctx = await loadForAction(user, flagId, 'resolve');
  if (ctx.error) return ctx.error;
  const reason = String(body.reason || '').trim();
  if (reason.length < 3) return res(400, { error: 'Say why they are different people (a few words).' });
  await finish(ctx.flag, 'NOT_DUPLICATE', user, { reason });
  await audit(user, ctx.flag, 'Duplicate: marked not a duplicate', 'Not a duplicate', reason);
  return res(200, { ok: true, status: 'NOT_DUPLICATE', message: 'Saved. They will not be flagged as duplicates again.' });
}

// --- SAME PERSON, DIFFERENT JOB ----------------------------------------------------------------------------------
let mergeBusy = false;
async function withMergeLock(fn) {
  if (mergeBusy) return res(409, { error: 'Another merge is running — try again in a moment.' });
  mergeBusy = true;
  try { return await fn(); } catch (err) {
    if (err instanceof MergeError) return res(err.status, { error: err.message });
    throw err;
  } finally { mergeBusy = false; }
}
async function sameJobConflicts(masterId, donorId) {
  const rows = await prisma.application.findMany({ where: { candidateId: { in: [masterId, donorId] } }, select: { candidateId: true, requirementId: true } });
  const m = new Set(rows.filter((r) => r.candidateId === masterId).map((r) => r.requirementId));
  return rows.filter((r) => r.candidateId === donorId && m.has(r.requirementId)).length;
}
async function notifyOtherSide(user, flag, profiles, verb) {
  try {
    const [a, b] = await Promise.all([DUP.ownersOf(flag.candidateId), DUP.ownersOf(flag.matchCandidateId)]);
    await DUP.notifyReal([a.recruiterId, a.tlId, b.recruiterId, b.tlId], {
      title: `Duplicate profile ${verb}`,
      message: `${nameOfProfile(profiles, flag.candidateId)} and ${nameOfProfile(profiles, flag.matchCandidateId)} — ${verb} by ${user.name}.`,
      exceptUserId: user.id,
    });
  } catch { /* best effort */ }
}

async function samePersonOtherJob(user, flagId) {
  const ctx = await loadForAction(user, flagId, 'resolve');
  if (ctx.error) return ctx.error;
  const { flag, profiles } = ctx;
  const conflicts = await sameJobConflicts(flag.matchCandidateId, flag.candidateId);
  if (conflicts) {
    return res(409, { error: 'Both profiles applied to the SAME job, so this is not "different job". Press Merge so the further-ahead application is kept, or Reject.', code: 'SAME_JOB' });
  }
  return withMergeLock(async () => {
    const out = await MERGE.mergeCandidates({
      masterId: flag.matchCandidateId, donorIds: [flag.candidateId], user, kind: 'SAME_PERSON_OTHER_JOB', flagId: flag.id,
      reason: 'Same person, different job — the new application was added to the existing profile',
    });
    await finish(flag, 'SAME_PERSON_OTHER_JOB', user, { reason: 'Same person, different job', mergeLogId: out.mergeLogId });
    await audit(user, flag, 'Duplicate: same person, different job', `Added to ${nameOfProfile(profiles, flag.matchCandidateId)}`, 'Same person, different job', flag.matchCandidateId);
    if (!ctx.inArea(flag.matchCandidateId)) await notifyOtherSide(user, flag, profiles, 'joined (same person, different job)');
    return res(200, { ok: true, status: 'SAME_PERSON_OTHER_JOB', masterId: flag.matchCandidateId, mergeLogId: out.mergeLogId, undoDays: out.undoDays, moved: out.moved,
      message: `Done. ${nameOfProfile(profiles, flag.candidateId)}'s application is now on the existing profile.` });
  });
}

// --- REJECT DUPLICATE -----------------------------------------------------------------------------------------------
async function rejectDuplicate(user, flagId, body = {}) {
  const ctx = await loadForAction(user, flagId, 'resolve');
  if (ctx.error) return ctx.error;
  const { flag, profiles } = ctx;
  const { applyStageMove } = require('../routes/applications'); // eslint-disable-line global-require
  const apps = await prisma.application.findMany({ where: { candidateId: flag.candidateId }, select: { id: true, stage: true } });
  const live = apps.filter((a) => DUP.FIRST_STAGES.includes(a.stage) || a.stage === 'HOLD');
  const matchName = nameOfProfile(profiles, flag.matchCandidateId);
  const done = []; const failed = [];
  for (const a of live) {
    // eslint-disable-next-line no-await-in-loop
    const out = await applyStageMove(user, a.id, {
      stage: 'REJECTED', rejectedBy: 'Internal', reasonCategory: 'Duplicate', reasonDetail: `Duplicate of ${matchName}`,
      comment: String(body.reason || `Duplicate of ${matchName}`).slice(0, 500),
    });
    if (out.status === 200) done.push(a.id); else failed.push((out.body && out.body.error) || `Refused (${out.status})`);
  }
  if (live.length && !done.length) return res(409, { error: failed[0] || 'The application could not be rejected.' });
  if (!apps.length) {
    // a profile with no job yet: retire it (hidden from every list; nothing is deleted)
    await prisma.candidate.update({ where: { id: flag.candidateId }, data: { profileStatus: 'Archived' } });
  }
  await finish(flag, 'REJECTED', user, { reason: String(body.reason || 'Duplicate').slice(0, 300) });
  await audit(user, flag, 'Duplicate: rejected as duplicate', `${done.length} application(s) rejected`, body.reason || 'Duplicate');
  return res(200, { ok: true, status: 'REJECTED', rejected: done.length, message: done.length ? `Rejected as a duplicate (${done.length} job application${done.length > 1 ? 's' : ''}).` : 'Marked as a duplicate and hidden from the lists.' });
}

// --- ASK FOR A MERGE (recruiter) -------------------------------------------------------------------------------------------
function cleanChoices(c) {
  const out = {};
  if (c && typeof c === 'object') Object.keys(c).forEach((k) => { if (MERGE.CHOICE_FIELDS.includes(k) && c[k] && c[k] !== 'master') out[k] = String(c[k]).slice(0, 60); });
  return out;
}
function masterOf(flag, body) {
  const pick = String((body && body.masterId) || '');
  if (pick && [flag.candidateId, flag.matchCandidateId].includes(pick)) return pick;
  return flag.matchCandidateId; // the existing profile is the default master
}
async function requestMerge(user, flagId, body = {}) {
  const ctx = await loadForAction(user, flagId, 'resolve');
  if (ctx.error) return ctx.error;
  const { flag, profiles } = ctx;
  if (flag.status === 'MERGE_REQUESTED') return res(409, { error: 'A merge was already asked for — the TL has to answer it.' });
  const masterId = masterOf(flag, body);
  const now = Date.now();
  await DUP.ex(`UPDATE CandidateDupFlag SET status = 'MERGE_REQUESTED', requestedById = ?, requestedByName = ?, requestedAt = ?, requestMasterId = ?, requestChoices = ?, requestNote = ?, updatedAt = ? WHERE id = ?`,
    user.id, user.name, now, masterId, JSON.stringify(cleanChoices(body.fieldChoices)), body.note ? String(body.note).slice(0, 500) : null, now, flag.id);
  DUP.bump();
  await audit(user, flag, 'Duplicate: merge asked for', `Keep ${nameOfProfile(profiles, masterId)}`, body.note);
  // the TLs of both teams (and the Admins when no TL is named) are asked
  const [a, b] = await Promise.all([DUP.ownersOf(flag.candidateId), DUP.ownersOf(flag.matchCandidateId)]);
  let to = [a.tlId, b.tlId];
  if (!to.some(Boolean)) {
    to = (await prisma.user.findMany({ where: { status: 'Active', role: { in: ['ADMIN', 'SUPER_ADMIN'] } }, select: { id: true }, take: 10 })).map((u) => u.id);
  }
  await DUP.notifyReal(to, {
    title: `Merge asked: ${nameOfProfile(profiles, flag.candidateId)}`,
    message: `${user.name} asks to merge ${nameOfProfile(profiles, flag.candidateId)} into ${nameOfProfile(profiles, masterId)}. Open Candidates > Duplicates to approve.`,
    exceptUserId: user.id,
  });
  return res(200, { ok: true, status: 'MERGE_REQUESTED', message: 'Asked. Your TL will approve it. Until then this person stays at the first step.' });
}

// --- MERGE (TL / Admin; also approves a request) --------------------------------------------------------------------------------
async function doMerge(user, flagId, body = {}) {
  const ctx = await loadForAction(user, flagId, 'merge');
  if (ctx.error) return ctx.error;
  const { flag, profiles } = ctx;
  if (body.confirm !== true) return res(400, { error: 'Confirm the merge (confirm: true) — nothing was changed.' });
  const requested = flag.status === 'MERGE_REQUESTED';
  const masterId = body.masterId ? masterOf(flag, body) : (requested && flag.requestMasterId) || flag.matchCandidateId;
  const donorId = masterId === flag.candidateId ? flag.matchCandidateId : flag.candidateId;
  const choices = body.fieldChoices ? cleanChoices(body.fieldChoices) : (requested ? flag.requestChoices || {} : {});
  return withMergeLock(async () => {
    const out = await MERGE.mergeCandidates({
      masterId, donorIds: [donorId], user, fieldChoices: choices, kind: 'MERGE', flagId: flag.id,
      requestedBy: requested ? { id: flag.requestedById, name: flag.requestedByName } : null,
      reason: `Duplicate merge approved by ${user.name}${requested ? ` (asked by ${flag.requestedByName})` : ''}`,
    });
    await finish(flag, 'MERGED', user, { reason: 'Merged', mergeLogId: out.mergeLogId });
    await audit(user, flag, 'Duplicate: merged', `${nameOfProfile(profiles, donorId)} merged into ${nameOfProfile(profiles, masterId)}`, null, masterId);
    if (requested && flag.requestedById && flag.requestedById !== user.id) {
      await DUP.notifyReal([flag.requestedById], { title: 'Merge approved', message: `${user.name} merged ${nameOfProfile(profiles, donorId)} into ${nameOfProfile(profiles, masterId)}.` });
    }
    if (!ctx.inArea(masterId) || !ctx.inArea(donorId)) await notifyOtherSide(user, flag, profiles, 'merged');
    return res(200, { ok: true, status: 'MERGED', masterId, mergeLogId: out.mergeLogId, undoDays: out.undoDays, moved: out.moved,
      message: `Merged into ${nameOfProfile(profiles, masterId)}. You can undo this for ${out.undoDays} days.` });
  });
}

async function declineMerge(user, flagId, body = {}) {
  const ctx = await loadForAction(user, flagId, 'decline');
  if (ctx.error) return ctx.error;
  const { flag } = ctx;
  const note = String(body.note || '').trim();
  if (note.length < 3) return res(400, { error: 'Say why the merge is not approved (a few words).' });
  await DUP.ex(`UPDATE CandidateDupFlag SET status = 'OPEN', requestedAt = NULL, requestMasterId = NULL, requestChoices = NULL, reason = ?, updatedAt = ? WHERE id = ?`, `Merge not approved: ${note.slice(0, 300)}`, Date.now(), flag.id);
  DUP.bump();
  await audit(user, flag, 'Duplicate: merge not approved', 'Back to waiting', note);
  if (flag.requestedById) await DUP.notifyReal([flag.requestedById], { title: 'Merge not approved', message: `${user.name}: ${note}`, exceptUserId: user.id });
  return res(200, { ok: true, status: 'OPEN', message: 'Sent back to the recruiter.' });
}

// --- preview (field by field + what moves) ----------------------------------------------------------------------------------------------
async function preview(user, flagId, masterIdIn) {
  if (!(await DUP.supported())) return res(404, { error: 'Duplicate checking is not switched on yet.' });
  const flag = await DUP.getFlag(flagId);
  if (!flag) return res(404, { error: 'This duplicate is no longer on the list.' });
  const kind = actorKind(user);
  if (!kind.doer) return res(403, { error: 'Not available to this login.' });
  const profiles = await loadProfiles([flag.candidateId, flag.matchCandidateId]);
  const inArea = (id) => {
    const c = profiles.get(id);
    return !!c && (kind.global || (c.applications || []).some((a) => a.requirement && SC.applicationInScope(user, a)));
  };
  if (!kind.global && !inArea(flag.candidateId) && !inArea(flag.matchCandidateId)) return res(403, SC.OUT_OF_SCOPE);
  const masterId = masterOf(flag, { masterId: masterIdIn || flag.requestMasterId });
  const donorId = masterId === flag.candidateId ? flag.matchCandidateId : flag.candidateId;
  const both = inArea(masterId) && inArea(donorId);
  const fields = await MERGE.previewFields(masterId, donorId, { showSensitive: !kind.hideContact });
  if (!both) fields.fields.forEach((f) => { if (f.donor != null || f.master != null) { if (!inArea(masterId)) f.master = f.master == null ? null : '(other team)'; if (!inArea(donorId)) f.donor = f.donor == null ? null : '(other team)'; } });
  const plan = await D.previewMerge({ masterId, donorIds: [donorId] });
  return res(200, {
    flag, masterId, donorId,
    master: card(profiles.get(masterId), { user, kind, inArea: inArea(masterId), reasons: flag.reasons }),
    donor: card(profiles.get(donorId), { user, kind, inArea: inArea(donorId), reasons: flag.reasons }),
    fields: fields.fields,
    plan: { moves: plan.moves, conflicts: plan.conflicts, counts: plan.counts },
    requestChoices: flag.requestChoices || {},
    caps: capsFor(user, flag, { kind, subjectIn: inArea(flag.candidateId), matchIn: inArea(flag.matchCandidateId) }),
    hiddenValues: kind.hideContact,
  });
}

// --- undo ----------------------------------------------------------------------------------------------------------------------------------
async function undo(user, mergeLogId) {
  const kind = actorKind(user);
  const log = await MERGE.mergeLogOf(mergeLogId);
  if (!log) return res(404, { error: 'This merge is not on record.' });
  const allowed = kind.global || (kind.lead && (log.performedById === user.id || log.requestedById === user.id)) || (kind.doer && log.performedById === user.id);
  if (!allowed) return res(403, { error: 'Only the person who merged them, or an Admin, can undo a merge.' });
  try {
    const out = await MERGE.undoMerge(mergeLogId, user);
    return res(200, { ok: true, ...out, message: 'Undone. Both profiles are back as they were.' });
  } catch (err) {
    if (err instanceof MergeError) return res(err.status, { error: err.message });
    throw err;
  }
}

// --- the worklist ------------------------------------------------------------------------------------------------------------------------------
const TAB_DEFS = {
  must: 'Must sort out', requests: 'Waiting for the TL', maybe: 'Maybe', older: 'Older ones', done: 'Done',
};

function derive(f, st, user, kind, inArea) {
  const sub = st.byId.get(f.candidateId); const mat = st.byId.get(f.matchCandidateId);
  const apps = sub ? sub.applications || [] : [];
  const inFirst = !apps.length || apps.some((a) => DUP.FIRST_STAGES.includes(a.stage));
  const latest = [...apps].sort((a, b) => (DUP.ms(b.createdAt) || 0) - (DUP.ms(a.createdAt) || 0))[0] || null;
  const matApps = mat ? mat.applications || [] : [];
  const lastMat = [...matApps].sort((a, b) => (DUP.ms(b.createdAt) || 0) - (DUP.ms(a.createdAt) || 0))[0] || null;
  const r = (latest && latest.requirement) || (lastMat && lastMat.requirement) || null;
  return {
    f, sub, mat, inFirst,
    department: r ? r.department || null : null,
    recruiter: r && r.recruiter ? { id: r.recruiter.id, name: r.recruiter.name } : null,
    source: sub ? CS.sourceOfPerson(sub, latest).key : null,
    createdAt: DUP.ms(f.createdAt),
    visible: !!(sub && mat) && (kind.global || inArea(f.candidateId) || inArea(f.matchCandidateId) || (f.enteredById && f.enteredById === user.id)),
  };
}
function tabOf(d) {
  const s = d.f.status;
  if (s === 'MERGE_REQUESTED') return 'requests';
  if (s !== 'OPEN') return 'done';
  if (!DUP.BLOCKING_LEVELS.includes(d.f.level)) return 'maybe';
  return d.inFirst ? 'must' : 'older';
}

function facetCounts(rows, keyOf, labelOf) {
  const m = new Map();
  rows.forEach((d) => {
    const k = keyOf(d);
    if (!k) return;
    const cur = m.get(k) || { value: k, label: labelOf ? labelOf(d) : k, count: 0 };
    cur.count += 1; m.set(k, cur);
  });
  return [...m.values()].sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label)));
}

async function worklist(user, q = {}) {
  const kind = actorKind(user);
  if (!kind.viewer) return res(403, { error: 'The duplicates list is for the recruiting team and their TLs.' });
  if (!(await DUP.supported())) return res(200, { supported: false, rows: [], total: 0, counts: {}, facets: {} });
  // flags: everything not long resolved, plus the last 500 resolved
  const open = await DUP.q("SELECT * FROM CandidateDupFlag WHERE status IN ('OPEN','MERGE_REQUESTED') ORDER BY createdAt DESC LIMIT 20000");
  const wantDone = q.tab === 'done';
  const done = wantDone ? await DUP.q("SELECT * FROM CandidateDupFlag WHERE status NOT IN ('OPEN','MERGE_REQUESTED') ORDER BY COALESCE(resolvedAt, updatedAt) DESC LIMIT 500") : [];
  DUP.sweepIfStale();
  const flagRows = [...open, ...done].map(DUP.flagOut);
  const { st, inArea } = await areaChecker(user, kind, flagRows);
  const all = flagRows.map((f) => derive(f, st, user, kind, inArea)).filter((d) => d.visible);

  const text = String(q.search || '').trim().toLowerCase();
  const digits = text.replace(/\D/g, '');
  const from = q.from ? Date.parse(q.from) : null; const to = q.to ? Date.parse(q.to) + 86399999 : null;
  const base = {
    level: (d) => !q.level || d.f.level === q.level,
    department: (d) => !q.department || d.department === q.department,
    recruiter: (d) => !q.recruiter || (d.recruiter && d.recruiter.id === q.recruiter),
    source: (d) => !q.source || d.source === q.source,
    date: (d) => (!from || d.createdAt >= from) && (!to || d.createdAt <= to),
    search: (d) => {
      if (!text) return true;
      const names = `${d.sub ? d.sub.name : ''} ${d.mat ? d.mat.name : ''}`.toLowerCase();
      if (names.includes(text)) return true;
      if (kind.hideContact || digits.length < 4) return false;
      return [d.sub, d.mat].some((c) => c && String(c.phone || '').replace(/\D/g, '').includes(digits));
    },
  };
  const passing = (skip) => all.filter((d) => Object.keys(base).every((k) => k === skip || base[k](d)));
  const scoped = passing(null);
  const counts = { must: 0, requests: 0, maybe: 0, older: 0, done: 0 };
  scoped.forEach((d) => { counts[tabOf(d)] += 1; });
  const tab = TAB_DEFS[q.tab] ? q.tab : 'must';
  const rows = scoped.filter((d) => tabOf(d) === tab);
  const inTab = (skip) => passing(skip).filter((d) => tabOf(d) === tab);
  const facets = {
    level: facetCounts(inTab('level'), (d) => d.f.level, (d) => FP.LEVEL_TEXT[d.f.level]),
    department: facetCounts(inTab('department'), (d) => d.department),
    recruiter: facetCounts(inTab('recruiter'), (d) => (d.recruiter ? d.recruiter.id : null), (d) => d.recruiter.name),
    source: facetCounts(inTab('source'), (d) => d.source),
  };
  const levels = { CERTAIN: 0, LIKELY: 0, POSSIBLE: 0 };
  rows.forEach((d) => { levels[d.f.level] += 1; });
  const pageSize = Math.min(100, Math.max(5, parseInt(q.pageSize, 10) || 25));
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(Math.max(1, parseInt(q.page, 10) || 1), pages);
  const slice = rows.slice((page - 1) * pageSize, page * pageSize);
  const profiles = await loadProfiles(slice.flatMap((d) => [d.f.candidateId, d.f.matchCandidateId]));
  const out = slice.map((d) => {
    const subjectIn = inArea(d.f.candidateId); const matchIn = inArea(d.f.matchCandidateId);
    const both = subjectIn && matchIn;
    return {
      flag: d.f,
      levelText: FP.LEVEL_TEXT[d.f.level],
      holds: DUP.BLOCKING_LEVELS.includes(d.f.level) && DUP.HOLDING.includes(d.f.status),
      matchedOn: matchedOn(d.f, both ? profiles.get(d.f.candidateId) : null, both ? profiles.get(d.f.matchCandidateId) : null, kind),
      newer: card(profiles.get(d.f.candidateId), { user, kind, inArea: subjectIn, reasons: d.f.reasons }),
      existing: card(profiles.get(d.f.matchCandidateId), { user, kind, inArea: matchIn, reasons: d.f.reasons }),
      caps: capsFor(user, d.f, { kind, subjectIn, matchIn }),
      department: d.department, recruiter: d.recruiter ? d.recruiter.name : null, source: d.source,
      inFirstStep: d.inFirst,
    };
  });
  const s = await DUP.settings();
  return res(200, {
    supported: true, tab, tabs: Object.keys(TAB_DEFS).map((k) => ({ key: k, label: TAB_DEFS[k], count: counts[k] })), counts, levels, facets,
    total: rows.length, page, pages, pageSize, rows: out, gate: s.gate, backfilled: await DUP.backfilled(),
    viewer: { doer: kind.doer, lead: kind.lead, global: kind.global, hideContact: kind.hideContact },
  });
}

// The header badge: "N duplicates waiting" (CERTAIN / LIKELY at the first step), quick.
async function waitingCount(user) {
  const kind = actorKind(user);
  if (!kind.viewer) return { supported: true, waiting: 0, requests: 0, show: false };
  if (!(await DUP.supported())) return { supported: false, waiting: 0, requests: 0, show: false };
  const openRows = (await DUP.q("SELECT * FROM CandidateDupFlag WHERE status IN ('OPEN','MERGE_REQUESTED') AND level IN ('CERTAIN','LIKELY') LIMIT 20000")).map(DUP.flagOut);
  const { st, inArea } = await areaChecker(user, kind, openRows);
  let waiting = 0; let requests = 0; let older = 0;
  openRows.forEach((f) => {
    const d = derive(f, st, user, kind, inArea);
    if (!d.visible) return;
    if (f.status === 'MERGE_REQUESTED') requests += 1;
    if (!d.inFirst) older += 1; else waiting += 1;
  });
  return { supported: true, waiting, requests, older, show: true, canAct: kind.doer };
}

// --- bulk -------------------------------------------------------------------------------------------------------------------------------------------
async function bulk(user, body = {}) {
  const ids = [...new Set((Array.isArray(body.flagIds) ? body.flagIds : []).map(String))].slice(0, 100);
  if (!ids.length) return res(400, { error: 'Pick at least one.' });
  const action = String(body.action || '');
  const fn = { 'not-duplicate': notDuplicate, 'request-merge': requestMerge, merge: (u, id, b) => doMerge(u, id, { ...b, confirm: true }) }[action];
  if (!fn) return res(400, { error: 'Unknown action.' });
  if (action === 'not-duplicate' && String(body.reason || '').trim().length < 3) return res(400, { error: 'Say why they are different people (a few words).' });
  const results = [];
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const out = await fn(user, id, { reason: body.reason, note: body.reason });
    results.push({ flagId: id, ok: out.status === 200, error: out.status === 200 ? undefined : out.body.error });
  }
  const ok = results.filter((r) => r.ok).length;
  return res(200, { ok: true, total: results.length, done: ok, failed: results.length - ok, results,
    message: `${ok} of ${results.length} done.${ok < results.length ? ' The rest need a look — see the list.' : ''}` });
}

// --- "auto-merge obvious" PROPOSALS (never applied without a TL's OK) ---------------------------------------------------------------------------------------
async function autoMergeProposals(user) {
  const kind = actorKind(user);
  if (!kind.viewer) return res(403, { error: 'Not available to this login.' });
  if (!(await DUP.supported())) return res(200, { supported: false, proposals: [] });
  const rows = (await DUP.q("SELECT * FROM CandidateDupFlag WHERE status = 'OPEN' AND level = 'CERTAIN' ORDER BY createdAt ASC LIMIT 20000")).map(DUP.flagOut)
    .filter((f) => f.reasons.includes('phone') && f.detail && f.detail.nameAgreement === 'same');
  const { st, inArea } = await areaChecker(user, kind, rows);
  const out = [];
  for (const f of rows) {
    const d = derive(f, st, user, kind, inArea);
    if (!d.visible || !d.sub || !d.mat) continue;
    const subReq = new Set((d.sub.applications || []).map((a) => a.requirementId));
    const clash = (d.mat.applications || []).some((a) => subReq.has(a.requirementId));
    if (clash) continue;
    out.push({
      flagId: f.id, keep: { id: d.mat.id, name: d.mat.name }, merge: { id: d.sub.id, name: d.sub.name },
      applicationsMoved: (d.sub.applications || []).length, inFirstStep: d.inFirst,
      department: d.department, recruiter: d.recruiter ? d.recruiter.name : null,
      canApprove: capsFor(user, f, { kind, subjectIn: inArea(f.candidateId), matchIn: inArea(f.matchCandidateId) }).canMerge,
    });
    if (out.length >= 300) break;
  }
  return res(200, { supported: true, proposals: out, note: 'Same phone, same name, different jobs. Nothing is merged until a TL or Admin approves.' });
}

async function mergesList(user) {
  const kind = actorKind(user);
  if (!kind.viewer) return res(403, { error: 'Not available to this login.' });
  if (!(await DUP.supported())) return res(200, { merges: [] });
  const rows = await DUP.q("SELECT * FROM CandidateMergeLog ORDER BY createdAt DESC LIMIT 100");
  const mine = kind.global ? rows : rows.filter((r) => r.performedById === user.id || r.requestedById === user.id);
  return res(200, { merges: mine.map(MERGE.undoState) });
}

module.exports = {
  actorKind, panelFor, notDuplicate, samePersonOtherJob, rejectDuplicate, requestMerge, doMerge, declineMerge, preview, undo,
  worklist, waitingCount, bulk, autoMergeProposals, mergesList, capsFor, card,
};
