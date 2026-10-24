// ---------------------------------------------------------------------------
// THE JOB MERGE ENGINE (preview · merge · undo) — one engine for every job merge (the worklist, the bulk "Merge all obvious
// ones", scripts/job-duplicates.js). Nothing is hard-deleted: the extra job is MERGED into the kept job and CLOSED.
//
//   mergeJobs({ keptId, extraId, user, openings })
//     * the extra job's people (applications) move onto the kept job. A person who is on BOTH keeps the further step; the other
//       application is folded into it (its history, interviews, offers, notes, follow-ups, messages move along) and is recreated
//       by Undo. Interviews, offers and the joining details live on the application, so they move with the person.
//     * everything else that points at the extra job moves too: step history, follow-ups, referrals, campus drives, partner
//       submissions / shares, source documents … (found from the database itself, so a table added tomorrow is covered).
//     * INVOICES: a job that has an invoice cannot be merged away (a Joined placement with an invoice never moves silently).
//       Keep the job that has the invoiced people, or merge the other way round. Refused in plain words.
//     * openings: the larger of the two by default ('max'), or the sum ('sum'); the note says which.
//     * the older code stays the code of the kept job; the merged-away job's id and code are an ALIAS that opens the kept job.
//     * the extra job is closed ('Merged into <code>') and taken off every site ONCE (the normal close path); the kept job is not
//       posted again.
//     * the owners of both jobs (BDE, TL, recruiters) get one bell; the audit trail and a merge log keep every moved row id.
//   undoMerge(logId, user)   inside the undo window (7 days) puts everything back.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const D = require('./jobDupes');
const { moreAdvanced } = require('./candidateDedupe');
const { stageLabel } = require('./atsVocab');

class JobMergeError extends Error {
  constructor(message, status = 409, extra = {}) { super(message); this.status = status; this.extra = extra; this.code = extra.code || 'JOB_MERGE'; }
}
const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const nowMs = () => Date.now();

// tables with a requirementId that are NOT simply re-pointed
const REQ_SKIP = new Set(['Application', 'Requirement', 'RequirementPosting', 'PostingQueue', 'PostingLog', 'PortalPosting', 'PartnerJobShare', 'Invoice',
  // AiCallJobSetting has no id (its requirementId is its key): the closed job keeps its own setting row, nothing is re-pointed (found 2026-10-24: its absence of an id made every merge fail)
  'AiCallJobSetting']);
// tables of an application, re-pointed from the folded application to the kept one (the three with a unique key are special)
const APP_CHILD = new Set(['InterviewFeedback', 'OfferVersion', 'PartnerSubmission']);

let SCHEMA = { at: 0, req: [], app: [] };
async function schemaTables() {
  if (SCHEMA.req.length && Date.now() - SCHEMA.at < 600000) return SCHEMA;
  const cols = await D.q("SELECT m.name AS tbl, p.name AS col FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table' AND p.name IN ('requirementId', 'applicationId')");
  SCHEMA = {
    at: Date.now(),
    req: cols.filter((c) => c.col === 'requirementId' && !REQ_SKIP.has(c.tbl)).map((c) => c.tbl),
    app: cols.filter((c) => c.col === 'applicationId' && !APP_CHILD.has(c.tbl) && c.tbl !== 'Application').map((c) => c.tbl),
  };
  return SCHEMA;
}

// --- what a job has (the compare card + the blockers) ------------------------------------------
async function statsFor(ids) {
  const out = {};
  ids.forEach((id) => { out[id] = { apps: 0, steps: {}, joined: 0, invoices: 0, postings: [], interviews: 0, offers: 0, followUps: 0 }; });
  if (!ids.length) return out;
  const inList = ids.map(() => '?').join(',');
  (await D.q(`SELECT requirementId AS id, stage, COUNT(*) AS n FROM Application WHERE requirementId IN (${inList}) GROUP BY requirementId, stage`, ...ids)).forEach((r) => {
    const s = out[r.id]; s.apps += r.n; s.steps[r.stage] = (s.steps[r.stage] || 0) + r.n;
    if (['JOINED', 'HIRED'].includes(r.stage)) s.joined += r.n;
  });
  (await D.q(`SELECT requirementId AS id, COUNT(*) AS n FROM Application WHERE requirementId IN (${inList}) AND (interviewAt IS NOT NULL OR interviewStatus IS NOT NULL) GROUP BY requirementId`, ...ids)).forEach((r) => { out[r.id].interviews = r.n; });
  (await D.q(`SELECT requirementId AS id, COUNT(*) AS n FROM Application WHERE requirementId IN (${inList}) AND stage IN ('OFFER','OFFER_ACCEPTED','JOINED','HIRED') GROUP BY requirementId`, ...ids)).forEach((r) => { out[r.id].offers = r.n; });
  (await D.q(`SELECT requirementId AS id, COUNT(*) AS n FROM Invoice WHERE requirementId IN (${inList}) GROUP BY requirementId`, ...ids)).forEach((r) => { out[r.id].invoices = r.n; });
  (await D.q(`SELECT requirementId AS id, source, status FROM RequirementPosting WHERE requirementId IN (${inList}) AND status != 'Removed'`, ...ids)).forEach((r) => { out[r.id].postings.push({ source: r.source, status: r.status }); });
  try {
    (await D.q(`SELECT requirementId AS id, COUNT(*) AS n FROM ApplicationFollowUp WHERE requirementId IN (${inList}) AND completedAt IS NULL GROUP BY requirementId`, ...ids)).forEach((r) => { out[r.id].followUps = r.n; });
  } catch { /* optional */ }
  return out;
}

const blockerText = (kept, extra, st) => {
  const msgs = [];
  if (st[extra.id].invoices) {
    msgs.push(`${extra.reqCode || 'The extra requirement'} already has ${st[extra.id].invoices} invoice${st[extra.id].invoices === 1 ? '' : 's'}. A requirement with an invoice cannot be merged away. Keep ${extra.reqCode || 'that requirement'} instead${st[kept.id].invoices ? ', or ask the Accounts team (both requirements are invoiced)' : ''}.`);
  }
  return msgs;
};

// What would a merge do? (no write)  -> { ok, blockers, willMove, folds, openings, ... }
async function previewMerge(keptId, extraId, { openings } = {}) {
  if (keptId === extraId) throw new JobMergeError('Pick two different requirements.', 400);
  const rows = await prisma.requirement.findMany({ where: { id: { in: [keptId, extraId] } } });
  const kept = rows.find((r) => r.id === keptId); const extra = rows.find((r) => r.id === extraId);
  if (!kept || !extra) throw new JobMergeError('One of these requirements no longer exists. Reload the page.', 404);
  const rule = openings || (await D.settings()).openings;
  const st = await statsFor([keptId, extraId]);
  const [ka, ea] = await Promise.all([
    prisma.application.findMany({ where: { requirementId: keptId }, select: { id: true, candidateId: true, stage: true } }),
    prisma.application.findMany({ where: { requirementId: extraId }, select: { id: true, candidateId: true, stage: true } }),
  ]);
  const kmap = new Map(ka.map((a) => [a.candidateId, a]));
  const folds = ea.filter((a) => kmap.has(a.candidateId)).length;
  const blockers = [];
  if (kept.clientId !== extra.clientId) blockers.push('These two requirements belong to different clients.');
  if (kept.internal !== extra.internal) blockers.push('One is a TeamLink internal opening and the other is a client requirement.');
  if (extra.status === 'CLOSED' && /^Merged into /.test(String(extra.description || '').slice(0, 20))) blockers.push('This requirement is already merged.');
  blockerText(kept, extra, st).forEach((m) => blockers.push(m));
  if (await D.supported()) {
    const al = await D.q('SELECT oldId FROM JobAlias WHERE oldId = ?', extraId);
    if (al.length) blockers.push('This requirement was already merged into another requirement.');
  }
  const o1 = Number(kept.openings || 1); const o2 = Number(extra.openings || 1);
  const newOpenings = rule === 'sum' ? o1 + o2 : Math.max(o1, o2);
  return {
    ok: blockers.length === 0, blockers,
    kept: { id: kept.id, reqCode: kept.reqCode, title: kept.title, status: kept.status, openings: o1 },
    extra: { id: extra.id, reqCode: extra.reqCode, title: extra.title, status: extra.status, openings: o2 },
    willMove: { people: ea.length - folds, folded: folds },
    openings: { rule, from: o1, to: newOpenings, extra: o2 },
    stats: st,
    supported: await D.supported(),
  };
}

// --- who hears about it --------------------------------------------------------------------------
async function ownersOf(...jobs) {
  const ids = new Set();
  jobs.forEach((j) => { [j.bdeId, j.tlId, j.stlId, j.recruiterId, ...csv(j.recruiterIds)].filter(Boolean).forEach((i) => ids.add(i)); });
  if (!ids.size) return [];
  const users = await prisma.user.findMany({ where: { id: { in: [...ids] }, status: { not: 'Inactive' } }, select: { id: true, name: true, email: true } });
  return users.filter((u) => process.env.TEST_MODE || !D.TEST_MARK.test(`${u.name} ${u.email}`));
}

const reviveDates = (row) => {
  const out = {};
  Object.keys(row).forEach((k) => {
    const v = row[k];
    out[k] = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) ? new Date(v) : v;
  });
  return out;
};
const placeholders = (n) => new Array(n).fill('?').join(',');

// ===================================================================================================
async function mergeJobs({ keptId, extraId, user, openings, level = null, door = 'Duplicate requirements', reason = null, notify = true, repost = true }) {
  const useLog = await D.supported();
  if (!useLog) throw new JobMergeError('Merging requirements needs a one-time update of the database. Ask the Super Admin.', 503, { code: 'NEEDS_MIGRATION' });
  const pv = await previewMerge(keptId, extraId, { openings });
  if (!pv.ok) throw new JobMergeError(pv.blockers[0], 409, { code: 'MERGE_BLOCKED', blockers: pv.blockers });
  const sch = await schemaTables();
  const actor = user ? user.name : 'System';
  const undoDays = (await D.settings()).undoDays;
  const logId = D.newId('jm');
  const rule = pv.openings.rule;
  const moved = { apps: [], folded: [], tables: {}, shares: [], aliasesRepointed: [], keptNoteIds: [] };
  const counts = { people: 0, folded: 0, rows: 0 };
  let keptBefore = {}; let extraBefore = null; let kept; let extra;

  await prisma.$transaction(async (tx) => {
    kept = await tx.requirement.findUnique({ where: { id: keptId } });
    extra = await tx.requirement.findUnique({ where: { id: extraId } });
    if (!kept || !extra) throw new JobMergeError('One of these requirements no longer exists. Reload the page.', 404);
    extraBefore = { ...extra };
    const keptApps = await tx.application.findMany({ where: { requirementId: keptId } });
    const extraApps = await tx.application.findMany({ where: { requirementId: extraId } });
    const kmap = new Map(keptApps.map((a) => [a.candidateId, a]));

    /* eslint-disable no-await-in-loop */
    const foldInto = async (loser, winner) => {
      const loserFull = await tx.application.findUnique({ where: { id: loser.id }, include: { interviewFeedbacks: true } });
      const { interviewFeedbacks, ...loserRow } = loserFull;
      const fr = { loserId: loser.id, winnerId: winner.id, row: loserRow, feedbackRows: interviewFeedbacks, feedbackMoved: [], tables: {}, offerRenumbered: [], audit: [], submission: null, noteId: null };
      for (const tbl of sch.app) {
        const ids = (await tx.$queryRawUnsafe(`SELECT id FROM "${tbl}" WHERE applicationId = ?`, loser.id)).map((r) => r.id);
        if (!ids.length) continue;
        await tx.$executeRawUnsafe(`UPDATE "${tbl}" SET applicationId = ? WHERE applicationId = ?`, winner.id, loser.id);
        fr.tables[tbl] = ids;
      }
      // an interview feedback of the same kind (Internal / Client) the winner already has stays with the dropped application
      const winnerKinds = new Set((await tx.interviewFeedback.findMany({ where: { applicationId: winner.id }, select: { kind: true } })).map((f) => f.kind));
      for (const f of interviewFeedbacks) {
        if (winnerKinds.has(f.kind)) continue;
        await tx.interviewFeedback.update({ where: { id: f.id }, data: { applicationId: winner.id } });
        fr.feedbackMoved.push(f.id);
      }
      // offers: the loser's versions follow the winner's, in order
      const lo = await tx.$queryRawUnsafe('SELECT id, version FROM OfferVersion WHERE applicationId = ? ORDER BY version', loser.id);
      if (lo.length) {
        const mx = Number((await tx.$queryRawUnsafe('SELECT MAX(version) AS v FROM OfferVersion WHERE applicationId = ?', winner.id))[0].v || 0);
        let n = mx;
        for (const o of lo) {
          n += 1;
          await tx.$executeRawUnsafe('UPDATE OfferVersion SET applicationId = ?, version = ? WHERE id = ?', winner.id, n, o.id);
          fr.offerRenumbered.push({ id: o.id, was: Number(o.version) });
        }
      }
      // a partner submission is one per application: the winner keeps its own, the other is handed over only when the winner has none
      const ps = await tx.$queryRawUnsafe('SELECT id FROM PartnerSubmission WHERE applicationId = ?', loser.id);
      if (ps.length) {
        const wp = await tx.$queryRawUnsafe('SELECT id FROM PartnerSubmission WHERE applicationId = ?', winner.id);
        if (!wp.length) { await tx.$executeRawUnsafe('UPDATE PartnerSubmission SET applicationId = ? WHERE applicationId = ?', winner.id, loser.id); fr.submission = ps[0].id; } else throw new JobMergeError('The same person is on both requirements and was sent by a partner on both. Merge this one by hand.', 409, { code: 'MERGE_BLOCKED' });
      }
      fr.audit = (await tx.auditLog.findMany({ where: { entity: 'Application', entityId: loser.id }, select: { id: true } })).map((r) => r.id);
      if (fr.audit.length) await tx.auditLog.updateMany({ where: { id: { in: fr.audit } }, data: { entityId: winner.id } });
      const note = await tx.candidateNote.create({
        data: {
          candidateId: loser.candidateId, applicationId: winner.id, authorUserId: user ? user.id : null, authorName: actor, authorRole: 'Merge',
          body: `Requirement merge: this person was on two copies of the same requirement (${kept.reqCode || kept.title}). Kept the further step (${stageLabel(winner.stage)}); the other copy was at ${stageLabel(loser.stage)}. Its history is on this application. Merged by ${actor}.`,
        },
      });
      fr.noteId = note.id; moved.keptNoteIds.push(note.id);
      await tx.application.delete({ where: { id: loser.id } });
      moved.folded.push(fr); counts.folded += 1;
    };

    for (const a of extraApps) {
      const k = kmap.get(a.candidateId);
      if (!k) {
        await tx.application.update({ where: { id: a.id }, data: { requirementId: keptId } });
        moved.apps.push(a.id); counts.people += 1;
        continue;
      }
      const win = moreAdvanced(k, a);
      if (win.id === k.id) await foldInto(a, k);
      else {
        // the extra job's application is the further one: it moves over and the kept job's copy is folded into it
        await foldInto(k, a);
        await tx.application.update({ where: { id: a.id }, data: { requirementId: keptId } });
        moved.apps.push(a.id); counts.people += 1;
      }
    }

    // everything else that points at the extra job
    for (const tbl of sch.req) {
      const ids = (await tx.$queryRawUnsafe(`SELECT id FROM "${tbl}" WHERE requirementId = ?`, extraId)).map((r) => r.id);
      if (!ids.length) continue;
      await tx.$executeRawUnsafe(`UPDATE "${tbl}" SET requirementId = ? WHERE requirementId = ?`, keptId, extraId);
      moved.tables[tbl] = ids; counts.rows += ids.length;
    }
    // partner shares: one per partner and job
    const have = new Set((await tx.$queryRawUnsafe('SELECT partnerId FROM PartnerJobShare WHERE requirementId = ?', keptId)).map((r) => r.partnerId));
    for (const s of await tx.$queryRawUnsafe('SELECT id, partnerId FROM PartnerJobShare WHERE requirementId = ?', extraId)) {
      if (have.has(s.partnerId)) continue;
      await tx.$executeRawUnsafe('UPDATE PartnerJobShare SET requirementId = ? WHERE id = ?', keptId, s.id);
      moved.shares.push(s.id);
    }
    // source documents (the files the job was made from)
    const docs = (await tx.$queryRawUnsafe("SELECT id FROM SourceDocument WHERE target = 'job' AND entityId = ?", extraId).catch(() => [])).map((r) => r.id);
    if (docs.length) { await tx.$executeRawUnsafe("UPDATE SourceDocument SET entityId = ? WHERE target = 'job' AND entityId = ?", keptId, extraId); moved.tables.SourceDocument = docs; }
    /* eslint-enable no-await-in-loop */

    // the kept job: openings, blanks filled from the extra, the people on the chain
    const patch = {};
    const o1 = Number(kept.openings || 1); const o2 = Number(extra.openings || 1);
    const newOpen = rule === 'sum' ? o1 + o2 : Math.max(o1, o2);
    if (newOpen !== o1) patch.openings = newOpen;
    ['location', 'experience', 'salary', 'skills', 'specialisation', 'jobDescription', 'closingDate', 'targetDate', 'goodToHaveSkills', 'education', 'qualifications', 'responsibilities', 'tlId', 'tl', 'recruiterId', 'bdeId', 'stlId', 'stl', 'positionId', 'positionCode'].forEach((f) => {
      if (blank(kept[f]) && !blank(extra[f])) patch[f] = extra[f];
    });
    const rec = [...new Set([...csv(kept.recruiterIds), ...csv(extra.recruiterIds), ...(extra.recruiterId && extra.recruiterId !== kept.recruiterId && !csv(kept.recruiterIds).includes(extra.recruiterId) ? [extra.recruiterId] : [])])].filter((i) => i !== (patch.recruiterId || kept.recruiterId));
    if (rec.join(',') !== csv(kept.recruiterIds).join(',') && rec.length) patch.recruiterIds = rec.join(',');
    Object.keys(patch).forEach((f) => { keptBefore[f] = kept[f] === undefined ? null : kept[f]; });
    if (Object.keys(patch).length) await tx.requirement.update({ where: { id: keptId }, data: patch });
    // the older code is the code of the kept job: when the extra job is the older one, the kept job takes ITS code and the extra job's
    // code moves to the alias (codes are unique, so the extra job lets go of it first)
    const olderCode = D.ts(extra.createdAt) < D.ts(kept.createdAt) && extra.reqCode;
    if (olderCode) {
      await tx.requirement.update({ where: { id: extraId }, data: { reqCode: `${extra.reqCode}~merged${Date.now().toString(36)}` } });
      await tx.requirement.update({ where: { id: keptId }, data: { reqCode: extra.reqCode } });
      keptBefore.reqCode = kept.reqCode;
      moved.codeSwap = { keptHad: kept.reqCode, extraHad: extra.reqCode };
    }
    // close the extra
    await tx.requirement.update({ where: { id: extraId }, data: { status: 'CLOSED' } });

    const t = nowMs();
    await tx.$executeRawUnsafe(
      `INSERT INTO JobMergeLog (id, keptId, extraId, clientId, keptCode, extraCode, summary, level, status, openingsRule, keptBefore, extraBefore, moved,
                                performedById, performedByName, createdAt, undoUntil)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DONE', ?, ?, ?, ?, ?, ?, ?, ?)`,
      logId, keptId, extraId, kept.clientId, olderCode ? extra.reqCode : kept.reqCode, extra.reqCode,
      `${extra.reqCode || extra.title} merged into ${olderCode ? extra.reqCode : kept.reqCode} (${kept.title})${reason ? ` — ${String(reason).slice(0, 200)}` : ''}`,
      level, rule, JSON.stringify(keptBefore), JSON.stringify(extraBefore), JSON.stringify(moved), user ? user.id : null, actor, t, t + undoDays * 86400000,
    );
    await tx.$executeRawUnsafe('INSERT OR REPLACE INTO JobAlias (oldId, oldCode, keptId, mergeLogId, createdAt) VALUES (?, ?, ?, ?, ?)', extraId, extra.reqCode, keptId, logId, t);
    // an older alias that pointed at the extra now points at the kept job
    const older = (await tx.$queryRawUnsafe('SELECT oldId FROM JobAlias WHERE keptId = ? AND oldId != ?', extraId, extraId)).map((r) => r.oldId);
    if (older.length) { await tx.$executeRawUnsafe('UPDATE JobAlias SET keptId = ? WHERE keptId = ?', keptId, extraId); moved.aliasesRepointed = older; await tx.$executeRawUnsafe('UPDATE JobMergeLog SET moved = ? WHERE id = ?', JSON.stringify(moved), logId); }
    // the reqCode alias for the code of a swapped-out job
    if (olderCode) await tx.$executeRawUnsafe('INSERT OR REPLACE INTO JobAlias (oldId, oldCode, keptId, mergeLogId, createdAt) VALUES (?, ?, ?, ?, ?)', `code:${kept.reqCode}`, kept.reqCode, keptId, logId, t);
  }, { timeout: 90000, maxWait: 15000 });

  const keptNow = await prisma.requirement.findUnique({ where: { id: keptId } });
  const { logAudit } = require('./audit'); // eslint-disable-line global-require
  const opText = pv.openings.to !== pv.openings.from ? ` Openings now ${pv.openings.to} (${rule === 'sum' ? 'added together' : 'the larger of the two'}).` : '';
  await logAudit({
    userId: user ? user.id : null, actorName: actor, action: 'Duplicate requirement merged', entity: 'Requirement', entityId: keptId,
    fromValue: `${extra.reqCode || extra.id} · ${extra.title}`, toValue: JSON.stringify({ people: counts.people, folded: counts.folded, rows: counts.rows, mergeLogId: logId }),
    reason: `Merged duplicate ${extra.reqCode || ''} into ${keptNow.reqCode || ''}.${opText}${reason ? ` ${reason}` : ''}`,
  });
  await logAudit({
    userId: user ? user.id : null, actorName: actor, action: 'Requirement closed', entity: 'Requirement', entityId: extraId,
    fromValue: pv.extra.status, toValue: 'CLOSED', reason: `Merged into ${keptNow.reqCode || keptId}`,
  });
  // taken off the sites ONCE (the normal close path); the kept job is not posted again
  if (repost) try {
    const fresh = await prisma.requirement.findUnique({ where: { id: extraId } });
    await require('./jobPosting').autoPost(fresh.id, { actorId: user ? user.id : null, actorName: actor, trigger: 'status', prevStatus: pv.extra.status, background: true }); // eslint-disable-line global-require
  } catch { /* the posting engine reports its own failures */ }
  // one bell for the owners of both jobs
  if (notify) try {
    const people = await ownersOf(kept, extra);
    for (const p of people) {
      if (user && p.id === user.id) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      await prisma.notification.create({
        data: {
          userId: p.id, title: `Two copies of a requirement were joined — ${keptNow.reqCode || ''}`,
          message: `${actor} joined ${extra.reqCode || 'a duplicate requirement'} into ${keptNow.reqCode || 'the kept requirement'} (${kept.title}). ${counts.people + counts.folded} ${counts.people + counts.folded === 1 ? 'person' : 'people'} are now on ${keptNow.reqCode || 'it'}.\nOpen: /requirements/${keptId}`,
          channel: 'In-App', recipient: `job-merge|${logId}|${p.id}`.slice(0, 250), status: 'Sent',
        },
      });
    }
  } catch { /* the bell is a courtesy */ }
  D.bump({ hard: true }); forgetAliases();
  return { logId, keptId, extraId, keptCode: keptNow.reqCode, extraCode: extra.reqCode, moved: counts, openings: pv.openings, undoDays };
}

// --- undo ---------------------------------------------------------------------------------------------
async function mergeLogOf(id) { return (await D.q('SELECT * FROM JobMergeLog WHERE id = ?', id))[0] || null; }
function undoState(log) {
  if (!log) return null;
  const until = D.ts(log.undoUntil);
  return {
    id: log.id, keptId: log.keptId, extraId: log.extraId, keptCode: log.keptCode, extraCode: log.extraCode, summary: log.summary,
    level: log.level, status: log.status, at: new Date(Number(log.createdAt)).toISOString(), by: log.performedByName,
    undoUntil: new Date(Number(log.undoUntil)).toISOString(), canUndo: log.status === 'DONE' && Date.now() <= Number(log.undoUntil) && until > 0,
  };
}

async function undoMerge(logId, user) {
  const log = await mergeLogOf(logId);
  if (!log) throw new JobMergeError('This merge is not on record.', 404);
  if (log.status !== 'DONE') throw new JobMergeError('This merge was already undone.', 409);
  if (Date.now() > Number(log.undoUntil)) throw new JobMergeError('The undo window for this merge is over.', 409);
  const rec = D.json(log.moved, null); const before = D.json(log.keptBefore, {}); const extraBefore = D.json(log.extraBefore, null);
  if (!rec || !extraBefore) throw new JobMergeError('This merge has no undo information.', 409);
  const actor = user ? user.name : 'System';
  const { keptId, extraId } = log;

  await prisma.$transaction(async (tx) => {
    const kept = await tx.requirement.findUnique({ where: { id: keptId }, select: { id: true } });
    const extra = await tx.requirement.findUnique({ where: { id: extraId }, select: { id: true } });
    if (!kept || !extra) throw new JobMergeError('One of the two requirements is gone, so this cannot be undone.', 409);
    /* eslint-disable no-await-in-loop */
    // codes first (unique): the extra job takes its own code back
    if (rec.codeSwap) {
      await tx.requirement.update({ where: { id: keptId }, data: { reqCode: `${rec.codeSwap.keptHad}~undo${Date.now().toString(36)}` } });
      await tx.requirement.update({ where: { id: extraId }, data: { reqCode: rec.codeSwap.extraHad } });
      await tx.requirement.update({ where: { id: keptId }, data: { reqCode: rec.codeSwap.keptHad } });
    }
    // the moved people go back to the extra job FIRST (a folded copy on the kept job is recreated next: one person, one job)
    if (rec.apps.length) await tx.application.updateMany({ where: { id: { in: rec.apps } }, data: { requirementId: extraId } });
    // the folded applications come back
    for (const fr of rec.folded) {
      const win = await tx.application.findUnique({ where: { id: fr.winnerId }, select: { id: true } });
      if (!win) throw new JobMergeError('A person on the kept requirement was removed since the merge, so this cannot be undone.', 409);
      const { id: _i, ...rest } = reviveDates(fr.row);
      // the folded application belonged to the job its row says
      await tx.application.create({ data: { id: fr.loserId, ...rest } });
      for (const fb of fr.feedbackRows || []) {
        if ((fr.feedbackMoved || []).includes(fb.id)) await tx.interviewFeedback.update({ where: { id: fb.id }, data: { applicationId: fr.loserId } }).catch(() => null);
        else await tx.interviewFeedback.create({ data: reviveDates(fb) }).catch(() => null);
      }
      for (const [tbl, ids] of Object.entries(fr.tables || {})) {
        if (ids.length) await tx.$executeRawUnsafe(`UPDATE "${tbl}" SET applicationId = ? WHERE id IN (${placeholders(ids.length)})`, fr.loserId, ...ids);
      }
      for (const o of fr.offerRenumbered || []) await tx.$executeRawUnsafe('UPDATE OfferVersion SET applicationId = ?, version = ? WHERE id = ?', fr.loserId, o.was, o.id);
      if (fr.submission) await tx.$executeRawUnsafe('UPDATE PartnerSubmission SET applicationId = ? WHERE id = ?', fr.loserId, fr.submission);
      if (fr.audit && fr.audit.length) await tx.auditLog.updateMany({ where: { id: { in: fr.audit } }, data: { entityId: fr.loserId } });
      if (fr.noteId) await tx.candidateNote.deleteMany({ where: { id: fr.noteId } });
    }
    for (const [tbl, ids] of Object.entries(rec.tables || {})) {
      if (!ids.length) continue;
      if (tbl === 'SourceDocument') await tx.$executeRawUnsafe(`UPDATE SourceDocument SET entityId = ? WHERE id IN (${placeholders(ids.length)})`, extraId, ...ids);
      else await tx.$executeRawUnsafe(`UPDATE "${tbl}" SET requirementId = ? WHERE id IN (${placeholders(ids.length)})`, extraId, ...ids);
    }
    if ((rec.shares || []).length) await tx.$executeRawUnsafe(`UPDATE PartnerJobShare SET requirementId = ? WHERE id IN (${placeholders(rec.shares.length)})`, extraId, ...rec.shares);
    // the kept job's own values
    const keptPatch = { ...before }; delete keptPatch.reqCode;
    if (Object.keys(keptPatch).length) await tx.requirement.update({ where: { id: keptId }, data: keptPatch });
    // the extra job as it was (status, posting choices)
    const restore = {};
    ['status', 'postingSources', 'portalPublished', 'portalPublishedAt', 'portalUnpublishedAt', 'portalSyncStatus', 'priority'].forEach((f) => { if (f in extraBefore) restore[f] = extraBefore[f]; });
    const rv = reviveDates(restore);
    if (rv.portalPublishedAt && typeof rv.portalPublishedAt === 'string') rv.portalPublishedAt = new Date(rv.portalPublishedAt);
    await tx.requirement.update({ where: { id: extraId }, data: rv });
    await tx.$executeRawUnsafe('DELETE FROM JobAlias WHERE mergeLogId = ?', logId);
    await tx.$executeRawUnsafe("UPDATE JobMergeLog SET status = 'UNDONE', undoneAt = ?, undoneById = ?, undoneByName = ? WHERE id = ?", nowMs(), user ? user.id : null, actor, logId);
    // an older alias that pointed at the extra goes back to it
    if ((rec.aliasesRepointed || []).length) await tx.$executeRawUnsafe(`UPDATE JobAlias SET keptId = ? WHERE oldId IN (${placeholders(rec.aliasesRepointed.length)})`, extraId, ...rec.aliasesRepointed);
    /* eslint-enable no-await-in-loop */
  }, { timeout: 90000, maxWait: 15000 });

  const { logAudit } = require('./audit'); // eslint-disable-line global-require
  await logAudit({ userId: user ? user.id : null, actorName: actor, action: 'Duplicate requirement merge undone', entity: 'Requirement', entityId: keptId, fromValue: log.summary, toValue: JSON.stringify({ restored: extraId }), reason: 'Merge undone inside the undo window' });
  try {
    const back = await prisma.requirement.findUnique({ where: { id: extraId } });
    if (back && !['CLOSED', 'DRAFT'].includes(back.status)) await require('./jobPosting').autoPost(back.id, { actorId: user ? user.id : null, actorName: actor, trigger: 'status', prevStatus: 'CLOSED', background: true }); // eslint-disable-line global-require
  } catch { /* posting reports its own failures */ }
  D.bump({ hard: true }); forgetAliases();
  return { keptId, restoredId: extraId };
}

// --- aliases: an old id / code opens the kept job ---------------------------------------------------------
let ALIAS = { at: 0, byId: new Map(), byCode: new Map() };
async function aliases() {
  if (Date.now() - ALIAS.at < 15000) return ALIAS;
  const byId = new Map(); const byCode = new Map();
  try {
    if (await D.supported()) (await D.q('SELECT oldId, oldCode, keptId FROM JobAlias')).forEach((r) => { if (!String(r.oldId).startsWith('code:')) byId.set(r.oldId, r.keptId); if (r.oldCode) byCode.set(String(r.oldCode).toLowerCase(), r.keptId); });
  } catch { /* none */ }
  ALIAS = { at: Date.now(), byId, byCode };
  return ALIAS;
}
const forgetAliases = () => { ALIAS = { at: 0, byId: new Map(), byCode: new Map() }; };
// -> the kept job's id when `idOrCode` is a merged-away job, else null
async function aliasOf(idOrCode) {
  const a = await aliases();
  return a.byId.get(idOrCode) || a.byCode.get(String(idOrCode || '').toLowerCase()) || null;
}

module.exports = { JobMergeError, previewMerge, mergeJobs, undoMerge, undoState, mergeLogOf, statsFor, aliasOf, forgetAliases, ownersOf, blockerText };
