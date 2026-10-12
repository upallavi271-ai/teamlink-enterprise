// ---------------------------------------------------------------------------
// CANDIDATE DUPLICATES — detection at entry, the flags, and the gate at the first step.
// (user, 2026-10-10: "Duplicate profiles anni first stage lone verify avvali")
//
// THE INDEX   CandidateDupKey(candidateId, kind, value) — the fingerprints of utils/candidateFingerprint.js,
//             indexed on (kind, value). Detection of ONE candidate is a handful of index reads: it never loads
//             the 17k rows. reindex() is called for every entry door by the Prisma hook in db.js (Add candidate,
//             resume upload, Excel / data import, Job Portal, careers / public apply, partner, Naukri / Shine
//             email intake, self-registration …) and again when a phone / e-mail / name / DOB is edited or a
//             resume is stored.
// THE FLAGS   CandidateDupFlag — one row per PAIR. candidateId = the NEWER profile (the one that is held),
//             matchCandidateId = the one it resembles.
//               CERTAIN  same phone or same email
//               LIKELY   same name + date of birth · same resume file · resume text alike + same name
//               POSSIBLE same name + city / college / company (warns only, never holds)
// THE GATE    A candidate with an OPEN (or MERGE_REQUESTED) CERTAIN / LIKELY flag cannot be moved OUT of the first
//             step (New · AI interview · Recruiter review) until the flag is resolved: gateCheck() is called by
//             applyStageMove (every move path) and by "Send to ATS". Moving to Hold or Reject stays possible.
//             The gate looks only at flags that EXIST: with no keys / no flags (before the backfill) nothing is held.
//
// SAFE BY DEFAULT: every function here answers "nothing" (never throws) when the tables are missing or a query fails,
// so a database problem can never stop a candidate being saved or moved.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const FP = require('./candidateFingerprint');
const { nameAgreementOf } = require('./candidateDedupe');

// --- plain SQL helpers -----------------------------------------------------------------
const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
function ms(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
const iso = (v) => { const t = ms(v); return t == null ? null : new Date(t).toISOString(); };
const json = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const q = async (sql, ...p) => (await prisma.$queryRawUnsafe(sql, ...p)).map((r) => { const o = {}; Object.keys(r).forEach((k) => { o[k] = num(r[k]); }); return o; });
const ex = (sql, ...p) => prisma.$executeRawUnsafe(sql, ...p);
const newId = (p) => `${p}${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;
const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

// --- constants -----------------------------------------------------------------------
// The first step: New, the AI-interview steps, Recruiter review (utils/atsVocab.js REVIEW_STAGES).
const FIRST_STAGES = ['NEW', 'AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED', 'RECRUITER_REVIEW', 'RECRUITER_APPROVED'];
// Moving to these never needs the duplicate to be resolved (leaving the process, not moving on).
const EXIT_STAGES = ['HOLD', 'REJECTED'];
const HOLDING = ['OPEN', 'MERGE_REQUESTED'];
const BLOCKING_LEVELS = ['CERTAIN', 'LIKELY'];
const STATUS_TEXT = {
  OPEN: 'Waiting to be checked', MERGE_REQUESTED: 'Merge asked — waiting for the TL', NOT_DUPLICATE: 'Checked: not a duplicate',
  MERGED: 'Merged', SAME_PERSON_OTHER_JOB: 'Same person, different job', REJECTED: 'Rejected as duplicate', AUTO_CLOSED: 'Closed: details changed',
};
const TEST_USER = /zztest|example\.test/i;

// --- feature detection ---------------------------------------------------------------
let tableOk = null; let tableAt = 0;
async function supported() {
  if (tableOk === true) return true;
  if (tableOk === false && Date.now() - tableAt < 30000) return false;
  try {
    const r = await q("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('CandidateDupFlag','CandidateDupKey','CandidateDupSig','CandidateMergeLog','CandidateAlias')");
    tableOk = r.length === 5;
  } catch { tableOk = false; }
  tableAt = Date.now();
  return tableOk;
}
function forgetSupport() { tableOk = null; }

// --- settings (AppSetting "candidate-duplicates") -----------------------------------------
//   gate         true (default) — the first-step hold is on. false = detection and flags continue, nothing is held.
//   undoDays     how long a merge can be undone (default 7)
let SET = { at: 0, v: null };
async function settings() {
  if (SET.v && Date.now() - SET.at < 15000) return SET.v;
  let v = {};
  try {
    const r = await q("SELECT value FROM AppSetting WHERE key = 'candidate-duplicates'");
    v = r[0] ? json(r[0].value, {}) : {};
  } catch { v = {}; }
  SET = { at: Date.now(), v: { gate: v.gate !== false, undoDays: Math.min(60, Math.max(1, Number(v.undoDays) || 7)) } };
  return SET.v;
}
async function saveSettings(patch, user) {
  const cur = await settings();
  const next = { ...cur, ...patch };
  const value = JSON.stringify(next);
  await ex(`INSERT INTO AppSetting (key, value, updatedById, updatedByName, updatedAt) VALUES ('candidate-duplicates', ?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedById = excluded.updatedById, updatedByName = excluded.updatedByName, updatedAt = excluded.updatedAt`,
  value, user ? user.id : null, user ? user.name : null, Date.now());
  SET = { at: 0, v: null };
  return next;
}
// Has the one-time backfill (scripts/candidate-dup-backfill.js --apply) been run? Until then a new entry is also
// compared with the candidates that have no keys yet (through the list's in-memory phone / e-mail index).
let BF = { at: 0, v: false };
async function backfilled() {
  if (BF.v) return true;
  if (Date.now() - BF.at < 20000) return false;
  try {
    const r = await q("SELECT value FROM AppSetting WHERE key = 'candidate-duplicates.index'");
    BF = { at: Date.now(), v: !!(r[0] && json(r[0].value, {}).backfilledAt) };
  } catch { BF = { at: Date.now(), v: false }; }
  return BF.v;
}
function forgetBackfill() { BF = { at: 0, v: false }; }

// --- change stamp for the flag memo -----------------------------------------------------
let VERSION = 1;
const bump = () => { VERSION += 1; HOLD_MEMO.clear(); };
const version = () => VERSION;
const HOLD_MEMO = new Map(); // candidateId -> { at, flag }  (short-lived)

// --- reading one candidate ------------------------------------------------------------------
const CAND_COLS = 'id, name, phone, email, dob, location, institute, currentCompany, source, createdAt, profileStatus';
async function candidateRow(id) {
  const r = await q(`SELECT ${CAND_COLS} FROM Candidate WHERE id = ?`, id);
  return r[0] || null;
}
async function resumeInfo(id) {
  const shas = new Set();
  let sig = null; let chars = 0;
  try {
    const rs = await q("SELECT sha256, text FROM CandidateResume WHERE candidateId = ? AND hiddenAt IS NULL AND kind = 'ORIGINAL' ORDER BY createdAt DESC LIMIT 5", id);
    rs.forEach((r) => {
      if (r.sha256) shas.add(String(r.sha256).toLowerCase());
      if (!sig && r.text) { const s = FP.resumeSignature(r.text); if (s) { sig = s.sig; chars = String(r.text).length; } }
    });
  } catch { /* resume tables are optional */ }
  try {
    const ds = await q("SELECT sha256 FROM CandidateDocument WHERE candidateId = ? AND deletedAt IS NULL AND sha256 IS NOT NULL AND docType = 'Resume' LIMIT 5", id);
    ds.forEach((d) => shas.add(String(d.sha256).toLowerCase()));
  } catch { /* optional */ }
  return { shas: [...shas], sig, chars };
}

// Write the keys of one candidate (adds what is new, removes what is gone). Returns the key list.
async function writeKeys(id, fps, resume) {
  const have = await q('SELECT id, kind, value FROM CandidateDupKey WHERE candidateId = ?', id);
  const want = new Map(fps.map((k) => [`${k.kind}\u0001${k.value}`, k]));
  const haveMap = new Map(have.map((k) => [`${k.kind}\u0001${k.value}`, k]));
  const drop = have.filter((k) => !want.has(`${k.kind}\u0001${k.value}`));
  const add = fps.filter((k) => !haveMap.has(`${k.kind}\u0001${k.value}`));
  const now = Date.now();
  for (const part of chunks(drop, 200)) {
    // eslint-disable-next-line no-await-in-loop
    await ex(`DELETE FROM CandidateDupKey WHERE id IN (${part.map(() => '?').join(',')})`, ...part.map((k) => k.id));
  }
  for (const part of chunks(add, 100)) {
    // one statement for all the new keys of a profile
    // eslint-disable-next-line no-await-in-loop
    await ex(`INSERT OR IGNORE INTO CandidateDupKey (id, candidateId, kind, value, createdAt) VALUES ${part.map(() => '(?, ?, ?, ?, ?)').join(',')}`,
      ...part.flatMap((k) => [newId('dk'), id, k.kind, k.value, now]));
  }
  if (resume && (resume.sig || resume.shas.length)) {
    await ex(`INSERT INTO CandidateDupSig (candidateId, resumeSig, resumeSha, resumeChars, updatedAt) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(candidateId) DO UPDATE SET resumeSig = excluded.resumeSig, resumeSha = excluded.resumeSha, resumeChars = excluded.resumeChars, updatedAt = excluded.updatedAt`,
    id, resume.sig || null, resume.shas[0] || null, resume.chars || null, now);
  } else if (resume) {
    await ex('DELETE FROM CandidateDupSig WHERE candidateId = ?', id);
  }
}

// --- finding the other profiles --------------------------------------------------------------
// Returns Map(otherId -> Set(kinds)). Shared / placeholder keys (more sharers than FP.MAX_SHARERS) are ignored.
async function lookup(id, fps) {
  const byKind = new Map();
  fps.forEach((k) => { if (!byKind.has(k.kind)) byKind.set(k.kind, []); byKind.get(k.kind).push(k.value); });
  if (!byKind.size) return new Map();
  const terms = []; const params = [id];
  byKind.forEach((values, kind) => {
    terms.push(`(kind = ? AND value IN (${values.map(() => '?').join(',')}))`);
    params.push(kind, ...values);
  });
  const rows = await q(`SELECT candidateId, kind, value FROM CandidateDupKey WHERE candidateId <> ? AND (${terms.join(' OR ')}) LIMIT 600`, ...params);
  const sharers = new Map();
  rows.forEach((r) => { const k = `${r.kind}\u0001${r.value}`; sharers.set(k, (sharers.get(k) || 0) + 1); });
  const out = new Map();
  rows.forEach((r) => {
    if ((sharers.get(`${r.kind}\u0001${r.value}`) || 0) + 1 > (FP.MAX_SHARERS[r.kind] || 8)) return;
    if (!out.has(r.candidateId)) out.set(r.candidateId, new Set());
    out.get(r.candidateId).add(r.kind);
  });
  return out;
}

// Before the backfill: candidates with no keys yet are found through the list's in-memory phone / e-mail index,
// and get their own keys written on the spot (so the next lookup is a plain index read).
async function legacyLookup(c, into) {
  try {
    const pk = FP.normPhones(c.phone);
    const ek = FP.normEmail(c.email);
    const hits = new Map();
    if (pk.length) {
      const plain = "replace(replace(replace(replace(replace(phone, ' ', ''), '-', ''), '+', ''), '.', ''), '(', '')";
      const rows = await q(
        `SELECT id, phone FROM Candidate WHERE id <> ? AND phone IS NOT NULL AND (${pk.map(() => `${plain} LIKE ?`).join(' OR ')}) LIMIT 40`,
        c.id, ...pk.map((k) => `%${k}%`),
      );
      rows.forEach((r) => { if (FP.normPhones(r.phone).some((k) => pk.includes(k))) hits.set(r.id, new Set(['PHONE'])); });
    }
    if (ek) {
      const local = ek.split('@')[0];
      const rows = await q('SELECT id, email FROM Candidate WHERE id <> ? AND email IS NOT NULL AND lower(email) LIKE ? LIMIT 40', c.id, `%${local.slice(0, 40)}%`);
      rows.forEach((r) => { if (FP.normEmail(r.email) === ek) { const k = hits.get(r.id) || new Set(); k.add('EMAIL'); hits.set(r.id, k); } });
    }
    for (const [id, kinds] of hits) {
      const cur = into.get(id) || new Set();
      kinds.forEach((k) => cur.add(k));
      into.set(id, cur);
      // eslint-disable-next-line no-await-in-loop
      const row = await candidateRow(id);
      // eslint-disable-next-line no-await-in-loop
      const rinfo = row ? await resumeInfo(id) : null;
      // eslint-disable-next-line no-await-in-loop
      if (row) await writeKeys(id, FP.fingerprintsOf(row, rinfo), rinfo);
    }
  } catch { /* the index is a helper, not a requirement */ }
}

const pairKeyOf = (a, b) => [a, b].sort().join('|');

// People a notice should reach for a candidate: the recruiter and TL on their latest application.
async function ownersOf(candidateId) {
  try {
    const a = await prisma.application.findFirst({
      where: { candidateId },
      orderBy: { createdAt: 'desc' },
      select: { requirement: { select: { recruiterId: true, tlId: true, recruiter: { select: { name: true } }, tl: true, title: true, department: true } } },
    });
    const r = a && a.requirement;
    if (!r) return { recruiterId: null, tlId: null, recruiterName: null, tlName: null, department: null };
    return { recruiterId: r.recruiterId || null, tlId: r.tlId || null, recruiterName: r.recruiter ? r.recruiter.name : null, tlName: r.tl || null, department: r.department || null };
  } catch { return { recruiterId: null, tlId: null, recruiterName: null, tlName: null, department: null }; }
}

async function notifyReal(userIds, payload) {
  try {
    const ids = [...new Set((userIds || []).filter(Boolean))];
    if (!ids.length) return;
    const users = await prisma.user.findMany({ where: { id: { in: ids }, status: 'Active' }, select: { id: true, name: true, email: true } });
    // a ZZTEST / example.test login is never picked up by a real flow; the TEST SANDBOX (TEST_MODE=1) is the exception so tests can see their notices
    const ok = users.filter((u) => process.env.TEST_MODE === '1' || !TEST_USER.test(`${u.name} ${u.email}`)).map((u) => u.id);
    if (ok.length) await require('./notify').notifyUsers(ok, payload); // eslint-disable-line global-require
  } catch { /* a notice that could not be sent must not stop anything */ }
}

// Doors that stay silent (a 1,000-row import must not ring 1,000 bells): the flag is raised, nobody is notified.
const QUIET_DOORS = /import|excel|bulk|backfill|sync|batch/i;

// --- detect + write the flags for one candidate ---------------------------------------------------------
// opts: { door, actor: {id,name}, quiet, reindexKeys }
async function reindex(candidateId, opts = {}) {
  if (!candidateId || !(await supported())) return { ok: false, created: 0, flags: [] };
  const t0 = Date.now();
  try {
    const c = await candidateRow(candidateId);
    if (!c) { await removeCandidate(candidateId); return { ok: false, created: 0, flags: [] }; }
    const resume = await resumeInfo(candidateId);
    const fps = FP.fingerprintsOf(c, resume);
    await writeKeys(candidateId, fps, resume);
    const found = await lookup(candidateId, fps);
    if (!(await backfilled())) await legacyLookup(c, found);
    const others = [...found.keys()];
    const names = new Map();
    const sigs = new Map();
    for (const part of chunks(others, 300)) {
      // eslint-disable-next-line no-await-in-loop
      (await q(`SELECT id, name, createdAt, profileStatus FROM Candidate WHERE id IN (${part.map(() => '?').join(',')})`, ...part)).forEach((r) => names.set(r.id, r));
    }
    if (resume.sig) {
      for (const part of chunks(others, 300)) {
        // eslint-disable-next-line no-await-in-loop
        (await q(`SELECT candidateId, resumeSig FROM CandidateDupSig WHERE candidateId IN (${part.map(() => '?').join(',')})`, ...part)).forEach((r) => sigs.set(r.candidateId, r.resumeSig));
      }
    }
    const created = []; const touched = new Set();
    const myCreated = ms(c.createdAt) || 0;
    for (const otherId of others) {
      const o = names.get(otherId);
      if (!o) continue;
      const kinds = new Set(found.get(otherId));
      let similarity = 0;
      if (kinds.has('RESUME_BAND')) {
        similarity = FP.sigSimilarity(resume.sig, sigs.get(otherId));
        if (similarity < 0.75) kinds.delete('RESUME_BAND');
      }
      const agree = nameAgreementOf([c.name, o.name], new Set([FP.normName(c.name), FP.normName(o.name)]));
      const cls = FP.classify(kinds, { nameAgreement: agree, similarity });
      if (!cls) continue;
      touched.add(otherId);
      const oCreated = ms(o.createdAt) || 0;
      // The NEWER profile is the one held. Same moment: the id decides, so the answer never flips.
      const meNewer = myCreated !== oCreated ? myCreated > oCreated : c.id > o.id;
      const subjectId = meNewer ? c.id : o.id;
      const matchId = meNewer ? o.id : c.id;
      const pairKey = pairKeyOf(c.id, o.id);
      const detail = JSON.stringify({ nameAgreement: agree, similarity: similarity ? Math.round(similarity * 100) : undefined });
      const have = (await q('SELECT id, level, status, reasons FROM CandidateDupFlag WHERE pairKey = ?', pairKey))[0];
      const now = Date.now();
      if (!have) {
        const id = newId('df');
        await ex(`INSERT INTO CandidateDupFlag (id, pairKey, candidateId, matchCandidateId, level, reasons, detail, door, status, enteredById, enteredByName, createdAt, updatedAt)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)`,
        id, pairKey, subjectId, matchId, cls.level, JSON.stringify(cls.reasons), detail, opts.door || c.source || null,
        opts.actor ? opts.actor.id : null, opts.actor ? opts.actor.name : null, now, now);
        created.push({ id, pairKey, candidateId: subjectId, matchCandidateId: matchId, level: cls.level, reasons: cls.reasons });
      } else if (HOLDING.includes(have.status) && (FP.LEVEL_RANK[cls.level] > FP.LEVEL_RANK[have.level] || cls.reasons.join() !== json(have.reasons, []).join())) {
        await ex('UPDATE CandidateDupFlag SET level = ?, reasons = ?, detail = ?, updatedAt = ? WHERE id = ?',
          FP.LEVEL_RANK[cls.level] >= FP.LEVEL_RANK[have.level] ? cls.level : have.level, JSON.stringify(cls.reasons), detail, now, have.id);
      }
      // a pair that was ruled on (Not a duplicate, Merged ...) is left exactly as it is — remembered.
    }
    // Open flags of this candidate that no longer match (a phone was corrected …) close themselves.
    const stale = await q(`SELECT id, candidateId, matchCandidateId FROM CandidateDupFlag
                           WHERE status = 'OPEN' AND (candidateId = ? OR matchCandidateId = ?)`, candidateId, candidateId);
    for (const f of stale) {
      const other = f.candidateId === candidateId ? f.matchCandidateId : f.candidateId;
      if (touched.has(other)) continue;
      // eslint-disable-next-line no-await-in-loop
      await ex("UPDATE CandidateDupFlag SET status = 'AUTO_CLOSED', resolution = 'AUTO_CLOSED', reason = ?, resolvedAt = ?, updatedAt = ? WHERE id = ? AND status = 'OPEN'",
        'Details changed — no longer matches', Date.now(), Date.now(), f.id);
    }
    bump();
    const quiet = opts.quiet != null ? opts.quiet : QUIET_DOORS.test(String(opts.door || ''));
    if (created.length && !quiet) await announce(created, opts);
    return { ok: true, created: created.length, flags: created, ms: Date.now() - t0 };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[candidateDupes] could not check ${candidateId}: ${err.message}`);
    return { ok: false, created: 0, flags: [], error: err.message };
  }
}

// Tell the people involved about NEW CERTAIN / LIKELY flags: the owner of the profile it resembles and their TL
// (cross-team), and the owner of the new profile and their TL.
async function announce(created, opts = {}) {
  try {
    for (const f of created.filter((x) => BLOCKING_LEVELS.includes(x.level))) {
      // eslint-disable-next-line no-await-in-loop
      const [sub, mat, subOwner, matOwner] = await Promise.all([
        candidateRow(f.candidateId), candidateRow(f.matchCandidateId), ownersOf(f.candidateId), ownersOf(f.matchCandidateId),
      ]);
      if (!sub || !mat) continue;
      const why = f.reasons.map((r) => FP.REASON_SHORT[r] || r).join(' + ');
      // eslint-disable-next-line no-await-in-loop
      await notifyReal([subOwner.recruiterId, subOwner.tlId, matOwner.recruiterId, matOwner.tlId], {
        title: `Duplicate profile: ${sub.name}`,
        message: `${sub.name} looks like ${mat.name} (same ${why}). Open the profile and press "Check duplicates" — it cannot move on until this is sorted out.`,
        exceptUserId: opts.actor ? opts.actor.id : undefined,
      });
    }
  } catch { /* notices are best effort */ }
}

// A candidate is gone (merged / deleted): its keys, signature and open flags go with it.
async function removeCandidate(id) {
  try {
    if (!(await supported())) return;
    await ex('DELETE FROM CandidateDupKey WHERE candidateId = ?', id);
    await ex('DELETE FROM CandidateDupSig WHERE candidateId = ?', id);
    await ex(`UPDATE CandidateDupFlag SET status = 'AUTO_CLOSED', resolution = 'AUTO_CLOSED', reason = 'Profile no longer exists', resolvedAt = ?, updatedAt = ?
              WHERE status IN ('OPEN','MERGE_REQUESTED') AND (candidateId = ? OR matchCandidateId = ?)`, Date.now(), Date.now(), id, id);
    bump();
  } catch { /* ignore */ }
}

// Candidates deleted behind our back (a bulk delete, a test clean-up, a merge) leave keys / flags with no profile: sweep them.
// Debounced; cheap (index anti-joins).
let sweepTimer = null; let lastSweep = 0;
async function sweepOrphans() {
  try {
    if (!(await supported())) return;
    lastSweep = Date.now();
    await ex('DELETE FROM CandidateDupKey WHERE candidateId NOT IN (SELECT id FROM Candidate)');
    await ex('DELETE FROM CandidateDupSig WHERE candidateId NOT IN (SELECT id FROM Candidate)');
    const n = await ex(`UPDATE CandidateDupFlag SET status = 'AUTO_CLOSED', resolution = 'AUTO_CLOSED', reason = 'Profile no longer exists', resolvedAt = ?, updatedAt = ?
              WHERE status IN ('OPEN','MERGE_REQUESTED') AND (candidateId NOT IN (SELECT id FROM Candidate) OR matchCandidateId NOT IN (SELECT id FROM Candidate))`, Date.now(), Date.now());
    if (n) bump();
  } catch { /* housekeeping */ }
}
function sweepSoon() {
  if (sweepTimer) return;
  sweepTimer = setTimeout(() => { sweepTimer = null; sweepOrphans(); }, 1500);
  if (sweepTimer.unref) sweepTimer.unref();
}
const sweepIfStale = () => { if (Date.now() - lastSweep > 60000) return sweepOrphans(); return null; };

// --- reading flags -------------------------------------------------------------------------------
function flagOut(r) {
  if (!r) return null;
  return {
    id: r.id, pairKey: r.pairKey, candidateId: r.candidateId, matchCandidateId: r.matchCandidateId, level: r.level,
    reasons: json(r.reasons, []), detail: json(r.detail, {}), door: r.door, status: r.status, statusText: STATUS_TEXT[r.status] || r.status,
    enteredById: r.enteredById, enteredByName: r.enteredByName,
    requestedById: r.requestedById, requestedByName: r.requestedByName, requestedAt: iso(r.requestedAt),
    requestMasterId: r.requestMasterId, requestChoices: json(r.requestChoices, null), requestNote: r.requestNote,
    resolvedById: r.resolvedById, resolvedByName: r.resolvedByName, resolvedAt: iso(r.resolvedAt), resolution: r.resolution, reason: r.reason,
    mergeLogId: r.mergeLogId, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
  };
}
async function getFlag(id) {
  if (!(await supported())) return null;
  return flagOut((await q('SELECT * FROM CandidateDupFlag WHERE id = ?', id))[0]);
}
// Every flag that touches this candidate (either side), newest first.
async function flagsOfCandidate(candidateId) {
  if (!(await supported())) return [];
  return (await q('SELECT * FROM CandidateDupFlag WHERE candidateId = ? OR matchCandidateId = ? ORDER BY createdAt DESC LIMIT 100', candidateId, candidateId)).map(flagOut);
}

// The flag that HOLDS this candidate at the first step, or null. Only flags that exist count.
async function holdingFlag(candidateId) {
  if (!candidateId) return null;
  const hit = HOLD_MEMO.get(candidateId);
  if (hit && Date.now() - hit.at < 3000) return hit.flag;
  let flag = null;
  try {
    if (await supported()) {
      const s = await settings();
      if (s.gate) {
        const r = await q(`SELECT * FROM CandidateDupFlag WHERE candidateId = ? AND status IN ('OPEN','MERGE_REQUESTED') AND level IN ('CERTAIN','LIKELY')
                           ORDER BY (level = 'CERTAIN') DESC, createdAt ASC LIMIT 1`, candidateId);
        flag = r[0] ? flagOut(r[0]) : null;
      }
    }
  } catch { flag = null; }
  HOLD_MEMO.set(candidateId, { at: Date.now(), flag });
  return flag;
}

// Is this application still at the first step? (A Hold / Reject remembers the step it left from.)
async function inFirstStep(app) {
  if (!app) return false;
  if (FIRST_STAGES.includes(app.stage)) return true;
  if (EXIT_STAGES.includes(app.stage)) {
    try {
      const r = await prisma.applicationStageEvent.findFirst({ where: { applicationId: app.id, toStage: app.stage }, orderBy: { createdAt: 'desc' }, select: { fromStage: true } });
      return !!(r && FIRST_STAGES.includes(r.fromStage));
    } catch { return false; }
  }
  return false;
}

const levelWords = { CERTAIN: 'the same person', LIKELY: 'very likely the same person' };
// THE GATE. Called by applyStageMove(existingApplication, targetStage) and by Send-to-ATS.
// Returns null (go ahead) or { status: 409, body } in plain words.
async function gateCheck(existing, targetStage) {
  try {
    if (!existing || EXIT_STAGES.includes(targetStage) || FIRST_STAGES.includes(targetStage)) return null;
    if (!(await inFirstStep(existing))) return null;
    const f = await holdingFlag(existing.candidateId);
    if (!f) return null;
    return { status: 409, body: gateBody(f, existing.candidate && existing.candidate.name, await nameOf(f.matchCandidateId)) };
  } catch { return null; }
}
async function nameOf(id) {
  try { const r = await q('SELECT name FROM Candidate WHERE id = ?', id); return r[0] ? r[0].name : null; } catch { return null; }
}
function gateBody(f, name, matchName) {
  const why = f.reasons.map((r) => (FP.REASON_TEXT[r] || r).toLowerCase()).join(' and ');
  const requested = f.status === 'MERGE_REQUESTED' ? ' A merge was already asked for — the TL has to approve it.' : '';
  return {
    error: `Duplicate: resolve first. ${name || 'This person'} is ${levelWords[f.level] || 'a duplicate'} as ${matchName || 'another profile'} (${why}). `
      + `Open the profile, press "Check duplicates", and choose Merge, Not a duplicate, Same person – different job, or Reject.${requested}`,
    code: 'DUPLICATE_OPEN',
    duplicateFlagId: f.id,
    candidateId: f.candidateId,
  };
}

// --- the list's chip: one query for the page's candidate ids ----------------------------------------------
// rows: list rows with candidateId or id. Adds row.dup = { level, count, status, flagId } | null.
async function attachFlags(rows, idOf = (r) => r.candidateId || r.id) {
  try {
    if (!rows.length || !(await supported())) return;
    const ids = [...new Set(rows.map(idOf).filter(Boolean))];
    const by = new Map();
    for (const part of chunks(ids, 400)) {
      // eslint-disable-next-line no-await-in-loop
      (await q(`SELECT id, candidateId, level, status FROM CandidateDupFlag WHERE candidateId IN (${part.map(() => '?').join(',')}) AND status IN ('OPEN','MERGE_REQUESTED')`, ...part))
        .forEach((f) => {
          const cur = by.get(f.candidateId);
          const rank = FP.LEVEL_RANK[f.level] || 0;
          if (!cur) by.set(f.candidateId, { level: f.level, count: 1, status: f.status, flagId: f.id, rank });
          else { cur.count += 1; if (rank > cur.rank) Object.assign(cur, { level: f.level, status: f.status, flagId: f.id, rank }); }
        });
    }
    rows.forEach((r) => {
      const d = by.get(idOf(r));
      if (!d) return;
      r.dup = { level: d.level, count: d.count, status: d.status, flagId: d.flagId, holds: BLOCKING_LEVELS.includes(d.level) };
    });
  } catch { /* the chip is a helper */ }
}

// ---- the Job Portal side -----------------------------------------------------------------------------------
// An applicant who arrives from the portal and is ALREADY in the ATS is added to that profile (no copy is made); the
// bridge calls this so the profile says so: "Already in ATS (matched by phone)".
async function noteAlreadyInAts({ candidate, email, phone, portalApplicationId }) {
  const pk = FP.normPhones(phone); const ek = FP.normEmail(email);
  const byPhone = pk.length && FP.normPhones(candidate.phone).some((k) => pk.includes(k));
  const byEmail = ek && FP.normEmail(candidate.email) === ek;
  const how = byPhone ? 'phone' : (byEmail ? 'email' : 'contact details');
  await require('./audit').logAudit({ // eslint-disable-line global-require
    userId: null, actorName: 'Job Portal', action: 'Job Portal applicant already in ATS', entity: 'Candidate', entityId: candidate.id,
    fromValue: `portal application ${portalApplicationId || ''}`.trim(), toValue: how, reason: `Matched by ${how}`,
  });
}
async function alreadyInAts(candidateId) {
  try {
    const r = await q("SELECT toValue, createdAt FROM AuditLog WHERE entity = 'Candidate' AND entityId = ? AND action = 'Job Portal applicant already in ATS' ORDER BY createdAt DESC LIMIT 1", candidateId);
    return r[0] ? { matchedBy: r[0].toValue, at: iso(r[0].createdAt), text: `Already in ATS (matched by ${r[0].toValue})` } : null;
  } catch { return null; }
}

// Rows (Job Portal list) get row.alreadyInAts = { matchedBy, text } when the applicant was already in the ATS.
async function attachAlreadyInAts(rows, idOf = (r) => r.candidateId) {
  try {
    if (!rows.length || !(await supported())) return;
    const ids = [...new Set(rows.map(idOf).filter(Boolean))];
    const by = new Map();
    for (const part of chunks(ids, 400)) {
      // eslint-disable-next-line no-await-in-loop
      (await q(`SELECT entityId, toValue FROM AuditLog WHERE entity = 'Candidate' AND action = 'Job Portal applicant already in ATS' AND entityId IN (${part.map(() => '?').join(',')}) ORDER BY createdAt ASC`, ...part))
        .forEach((r) => by.set(r.entityId, r.toValue));
    }
    rows.forEach((r) => { const how = by.get(idOf(r)); if (how) r.alreadyInAts = { matchedBy: how, text: `Already in ATS (matched by ${how})` }; });
  } catch { /* helper */ }
}

// The Job Portal screening's "Duplicate check": same answer as the flags, in the shape that screen reads.
async function findForScreening(candidate) {
  if (!(await supported())) return null;
  await reindex(candidate.id, { door: 'Job Portal check', quiet: true });
  const rows = await q(`SELECT f.*, c.name AS otherName, c.id AS otherId FROM CandidateDupFlag f
                        JOIN Candidate c ON c.id = CASE WHEN f.candidateId = ? THEN f.matchCandidateId ELSE f.candidateId END
                        WHERE (f.candidateId = ? OR f.matchCandidateId = ?) AND f.status IN ('OPEN','MERGE_REQUESTED') LIMIT 40`, candidate.id, candidate.id, candidate.id);
  const mk = (r, strength) => ({ id: r.otherId, name: r.otherName, strength, reasons: json(r.reasons, []).map((x) => (FP.REASON_TEXT[x] || x).toLowerCase()) });
  return {
    strong: rows.filter((r) => BLOCKING_LEVELS.includes(r.level)).map((r) => mk(r, 'strong')),
    possible: rows.filter((r) => !BLOCKING_LEVELS.includes(r.level)).map((r) => mk(r, 'possible')),
  };
}

// ---- alias (a merged-away id still opens the kept profile) ------------------------------------------------
async function resolveAlias(oldId) {
  try {
    if (!oldId || !(await supported())) return null;
    const r = await q('SELECT candidateId FROM CandidateAlias WHERE oldId = ?', oldId);
    return r[0] ? r[0].candidateId : null;
  } catch { return null; }
}

module.exports = {
  supported, forgetSupport, settings, saveSettings, backfilled, forgetBackfill, version, bump,
  q, ex, newId, chunks, ms, iso, json, num,
  FIRST_STAGES, EXIT_STAGES, HOLDING, BLOCKING_LEVELS, STATUS_TEXT, QUIET_DOORS, TEST_USER,
  candidateRow, resumeInfo, writeKeys, lookup, reindex, removeCandidate, pairKeyOf, ownersOf, notifyReal,
  flagOut, getFlag, flagsOfCandidate, holdingFlag, inFirstStep, gateCheck, gateBody, attachFlags, resolveAlias, announce, nameOf,
  noteAlreadyInAts, alreadyInAts, attachAlreadyInAts, findForScreening, sweepOrphans, sweepSoon, sweepIfStale,
};
