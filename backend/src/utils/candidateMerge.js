// ---------------------------------------------------------------------------
// THE CANDIDATE MERGE ENGINE (preview · merge · undo) — one engine for every merge in the app.
//
//   previewFields(master, donor)   field by field: the kept profile's value, the other's value, what is kept by default
//   mergeCandidates({...})         folds the donor profile(s) into the master. EVERYTHING that pointed at a donor moves:
//                                  applications (a same-job pair keeps the more advanced one), pipeline history, follow-ups,
//                                  messages, notes, documents, resumes, certificates, referrals, partner submissions,
//                                  invoices, candidate logins, scheduled messages, the donor's omnichannel conversation,
//                                  audit rows and sync-log references.
//   fieldChoices                   { field: 'master' | 'donor' | <donorId> } — which value is kept. Default: the master's own,
//                                  a blank on the master is filled from the donor. A value that is NOT kept is written to a
//                                  note on the kept profile, so nothing is lost.
//   alias                          the old (donor) id keeps opening the kept profile (CandidateAlias).
//   log + undo                     CandidateMergeLog holds the donors as they were and the id of every row that moved, so
//                                  undoMerge() puts everything back inside the undo window (default 7 days).
// Without the duplicate tables the merge works exactly as before (no log, no alias, no undo).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const D = require('./candidateDedupe');
const DUP = require('./candidateDupes');
const { stageLabel } = require('./atsVocab');

const { MergeError, moreAdvanced } = D;
const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

// Fields offered in the field-by-field preview (label for the screen).
const MERGE_FIELDS = [
  ['name', 'Name'], ['phone', 'Phone'], ['email', 'Email'], ['location', 'Current city'], ['preferredLocation', 'Preferred city'],
  ['currentCompany', 'Current company'], ['currentDesignation', 'Current role'], ['experienceYears', 'Experience (years)'],
  ['relevantExperienceYears', 'Relevant experience'], ['skills', 'Skills'], ['technicalSkills', 'Technical skills'],
  ['education', 'Education'], ['specialization', 'Specialisation'], ['institute', 'College'], ['passingYear', 'Passing year'],
  ['noticePeriod', 'Notice period'], ['currentSalary', 'Current CTC'], ['expectedSalary', 'Expected CTC'],
  ['dob', 'Date of birth'], ['gender', 'Gender'], ['resumeName', 'Resume file'],
];
const SENSITIVE = ['phone', 'email', 'currentSalary', 'expectedSalary', 'dob'];
const CHOICE_FIELDS = MERGE_FIELDS.map(([f]) => f);
// Filled only when blank on the master (never overwritten): the list the engine always had, plus the rest of the fields.
const FILL_ALSO = D.FILLABLE;

const reqText = (a) => (a.requirement
  ? `${a.requirement.title}${a.requirement.internal ? ' · TeamLink Internal' : (a.requirement.client ? ` · ${a.requirement.client.name}` : '')}`
  : a.requirementId);

// --- the field-by-field preview ----------------------------------------------------------
async function previewFields(masterId, donorId, { showSensitive = true } = {}) {
  const rows = await prisma.candidate.findMany({ where: { id: { in: [masterId, donorId] } } });
  const m = rows.find((r) => r.id === masterId); const d = rows.find((r) => r.id === donorId);
  if (!m || !d) throw new MergeError('One of these candidates no longer exists — reload the page.', 409);
  const fields = MERGE_FIELDS.map(([f, label]) => {
    const hide = !showSensitive && SENSITIVE.includes(f);
    const mv = blank(m[f]) ? null : m[f]; const dv = blank(d[f]) ? null : d[f];
    const same = String(mv == null ? '' : mv).trim().toLowerCase() === String(dv == null ? '' : dv).trim().toLowerCase();
    return {
      field: f, label, master: hide ? (mv == null ? null : '(hidden)') : mv, donor: hide ? (dv == null ? null : '(hidden)') : dv,
      same, differs: !same && mv != null && dv != null,
      // by default the kept profile's value, a blank is filled from the other
      keep: mv == null && dv != null ? 'donor' : 'master',
    };
  });
  return { fields };
}

// --- tables that point at a candidate ------------------------------------------------------
// [key in the log, prisma delegate, column]
const TABLES = [
  ['stageEvents', 'applicationStageEvent', 'candidateId'],
  ['followUps', 'applicationFollowUp', 'candidateId'],
  ['messages', 'candidateMessage', 'candidateId'],
  ['notes', 'candidateNote', 'candidateId'],
  ['documents', 'candidateDocument', 'candidateId'],
  ['resumes', 'candidateResume', 'candidateId'],
  ['certifications', 'candidateCertification', 'candidateId'],
  ['referrals', 'candidateReferral', 'candidateId'],
  ['partnerSubmissions', 'partnerSubmission', 'candidateId'],
  ['partnerDupOf', 'partnerSubmission', 'duplicateOfCandidateId'],
  ['invoices', 'invoice', 'candidateId'],
  ['users', 'user', 'candidateId'],
  ['portalRequests', 'portalRequest', 'candidateId'],
];
const RAW_TABLES = [['scheduledMessages', 'ScheduledMessage', 'candidateId']];

const idsOf = async (tx, delegate, where) => (await tx[delegate].findMany({ where, select: { id: true } })).map((r) => r.id);
async function rawTableExists(tx, name) {
  try { return (await tx.$queryRawUnsafe('SELECT name FROM sqlite_master WHERE type=\'table\' AND name = ?', name)).length > 0; } catch { return false; }
}

// --- the merge --------------------------------------------------------------------------------
async function mergeCandidates({
  masterId, donorIds, user, fieldChoices = null, kind = 'MERGE', flagId = null, requestedBy = null, reason = null,
}) {
  const actor = user ? user.name : 'System';
  const useLog = await DUP.supported();
  const undoDays = useLog ? (await DUP.settings()).undoDays : 0;
  const moved = {
    applications: 0, conflicts: 0, stageEvents: 0, followUps: 0, messages: 0, notes: 0, documents: 0,
    invoices: 0, users: 0, auditRows: 0, interviewEvents: 0, feedback: 0,
  };
  const conflictNotes = [];
  let snapshot = null;
  const folded = [];
  let filled = {};
  const logId = useLog ? DUP.newId('ml') : null;
  const rec = { donors: {}, folded: [], masterBefore: {}, conversations: [], aliasesRepointed: [] };

  await prisma.$transaction(async (tx) => {
    const { master, donors } = await loadForMerge(masterId, donorIds, tx);
    const fullDonors = await tx.candidate.findMany({ where: { id: { in: donorIds } }, include: { applications: true } });
    snapshot = fullDonors;
    const scalar = (row) => { const { applications: _a, ...rest } = row; return rest; };
    fullDonors.forEach((d) => { rec.donors[d.id] = { row: scalar(d), apps: [], t: {}, audit: [], sync: [], raw: {} }; });

    const masterApps = new Map(master.applications.map((a) => [a.requirementId, a]));
    const ownerOfApp = new Map();
    fullDonors.forEach((d) => d.applications.forEach((a) => ownerOfApp.set(a.id, d.id)));
    master.applications.forEach((a) => ownerOfApp.set(a.id, masterId));

    const fold = async (loser, winner) => {
      const loserFull = await tx.application.findUnique({ where: { id: loser.id }, include: { interviewFeedbacks: true } });
      folded.push(loserFull);
      const { interviewFeedbacks: _fb, ...loserRow } = loserFull;
      const fr = {
        loserId: loser.id, winnerId: winner.id, ownerId: ownerOfApp.get(loser.id), row: loserRow, feedbackRows: loserFull.interviewFeedbacks,
        stageEvents: await idsOf(tx, 'applicationStageEvent', { applicationId: loser.id }),
        followUps: await idsOf(tx, 'applicationFollowUp', { applicationId: loser.id }),
        closedFollowUps: await idsOf(tx, 'applicationFollowUp', { applicationId: loser.id, completedAt: null }),
        interviewEvents: await idsOf(tx, 'interviewEvent', { applicationId: loser.id }),
        messages: await idsOf(tx, 'candidateMessage', { applicationId: loser.id }),
        notes: await idsOf(tx, 'candidateNote', { applicationId: loser.id }),
        audit: await idsOf(tx, 'auditLog', { entity: 'Application', entityId: loser.id }),
        feedbackMoved: [],
        noteId: null,
      };
      if (fr.stageEvents.length) {
        await tx.applicationStageEvent.updateMany({ where: { id: { in: fr.stageEvents } }, data: { applicationId: winner.id, candidateId: masterId } });
        moved.stageEvents += fr.stageEvents.length;
      }
      if (fr.closedFollowUps.length) {
        await tx.applicationFollowUp.updateMany({
          where: { id: { in: fr.closedFollowUps } },
          data: { completedAt: new Date(), completedNote: 'Closed on candidate merge — duplicate application folded into the kept one.' },
        });
      }
      if (fr.followUps.length) {
        await tx.applicationFollowUp.updateMany({ where: { id: { in: fr.followUps } }, data: { applicationId: winner.id, candidateId: masterId } });
        moved.followUps += fr.followUps.length;
      }
      if (fr.interviewEvents.length) {
        await tx.interviewEvent.updateMany({ where: { id: { in: fr.interviewEvents } }, data: { applicationId: winner.id } });
        moved.interviewEvents += fr.interviewEvents.length;
      }
      const loserFb = loserFull.interviewFeedbacks;
      const winnerKinds = new Set((await tx.interviewFeedback.findMany({ where: { applicationId: winner.id }, select: { kind: true } })).map((f) => f.kind));
      for (const f of loserFb) {
        if (winnerKinds.has(f.kind)) continue;
        // eslint-disable-next-line no-await-in-loop
        await tx.interviewFeedback.update({ where: { id: f.id }, data: { applicationId: winner.id } });
        fr.feedbackMoved.push(f.id);
        moved.feedback += 1;
      }
      if (fr.messages.length) await tx.candidateMessage.updateMany({ where: { id: { in: fr.messages } }, data: { applicationId: winner.id } });
      if (fr.notes.length) await tx.candidateNote.updateMany({ where: { id: { in: fr.notes } }, data: { applicationId: winner.id } });
      if (fr.audit.length) await tx.auditLog.updateMany({ where: { id: { in: fr.audit } }, data: { entityId: winner.id } });
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
      const note = await tx.candidateNote.create({
        data: { candidateId: masterId, applicationId: winner.id, body: line, authorUserId: user ? user.id : null, authorName: actor, authorRole: 'Merge' },
      });
      fr.noteId = note.id;
      conflictNotes.push(line);
      await tx.application.delete({ where: { id: loser.id } });
      moved.conflicts += 1;
      rec.folded.push(fr);
    };

    for (const d of donors) {
      const dr = rec.donors[d.id];
      for (const a of d.applications) {
        const m = masterApps.get(a.requirementId);
        if (!m) {
          // eslint-disable-next-line no-await-in-loop
          await tx.application.update({ where: { id: a.id }, data: { candidateId: masterId } });
          dr.apps.push(a.id);
          masterApps.set(a.requirementId, a);
          ownerOfApp.set(a.id, d.id);
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
          dr.apps.push(a.id);
          masterApps.set(a.requirementId, a);
          moved.applications += 1;
        }
      }
      /* eslint-disable no-await-in-loop */
      for (const [key, delegate, col] of TABLES) {
        const ids = await idsOf(tx, delegate, { [col]: d.id });
        if (!ids.length) continue;
        await tx[delegate].updateMany({ where: { id: { in: ids } }, data: { [col]: masterId } });
        dr.t[key] = ids;
        if (key === 'stageEvents') moved.stageEvents += ids.length;
        if (key === 'followUps') moved.followUps += ids.length;
        if (key === 'messages') moved.messages += ids.length;
        if (key === 'notes') moved.notes += ids.length;
        if (key === 'documents') moved.documents += ids.length;
        if (key === 'invoices') moved.invoices += ids.length;
        if (key === 'users') moved.users += ids.length;
      }
      for (const [key, table, col] of RAW_TABLES) {
        if (!(await rawTableExists(tx, table))) continue;
        const ids = (await tx.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE ${col} = ?`, d.id)).map((r) => r.id);
        if (!ids.length) continue;
        await tx.$executeRawUnsafe(`UPDATE "${table}" SET ${col} = ? WHERE ${col} = ?`, masterId, d.id);
        dr.raw[key] = ids;
      }
      // the donor's omnichannel conversation (a person has ONE conversation)
      if (await rawTableExists(tx, 'Conversation')) {
        const dc = (await tx.$queryRawUnsafe("SELECT * FROM Conversation WHERE personType = 'CANDIDATE' AND personId = ?", d.id))[0];
        if (dc) {
          const mc = (await tx.$queryRawUnsafe("SELECT id FROM Conversation WHERE personType = 'CANDIDATE' AND personId = ?", masterId))[0];
          if (!mc) {
            await tx.$executeRawUnsafe('UPDATE Conversation SET personId = ? WHERE id = ?', masterId, dc.id);
            rec.conversations.push({ donorId: d.id, mode: 'repoint', convId: dc.id });
          } else {
            const msgIds = (await tx.$queryRawUnsafe('SELECT id FROM ConversationMessage WHERE conversationId = ?', dc.id)).map((r) => r.id);
            if (msgIds.length) await tx.$executeRawUnsafe('UPDATE ConversationMessage SET conversationId = ?, personId = ? WHERE conversationId = ?', mc.id, masterId, dc.id);
            const row = {}; Object.keys(dc).forEach((k) => { row[k] = typeof dc[k] === 'bigint' ? Number(dc[k]) : dc[k]; });
            await tx.$executeRawUnsafe('DELETE FROM Conversation WHERE id = ?', dc.id);
            rec.conversations.push({ donorId: d.id, mode: 'merged', convId: dc.id, intoConvId: mc.id, row, messageIds: msgIds });
          }
        }
      }
      dr.audit = await idsOf(tx, 'auditLog', { entity: 'Candidate', entityId: d.id });
      if (dr.audit.length) {
        await tx.auditLog.updateMany({ where: { id: { in: dr.audit } }, data: { entityId: masterId } });
        moved.auditRows += dr.audit.length;
      }
      dr.sync = await idsOf(tx, 'syncLog', { recordRef: d.id });
      if (dr.sync.length) await tx.syncLog.updateMany({ where: { id: { in: dr.sync } }, data: { recordRef: masterId } });
      /* eslint-enable no-await-in-loop */
    }

    // WHICH VALUE IS KEPT. Default: the master's own; a blank on the master is filled from the donors.
    const fill = {}; const notKept = [];
    const choices = fieldChoices && typeof fieldChoices === 'object' ? fieldChoices : {};
    const fillSet = new Set(FILL_ALSO);
    [...new Set([...CHOICE_FIELDS, ...FILL_ALSO])].forEach((f) => {
      const c = choices[f];
      const firstDonorWith = fullDonors.find((d) => !blank(d[f]));
      let pick = null;
      if (c && c !== 'master' && CHOICE_FIELDS.includes(f)) {
        const src = c === 'donor' ? firstDonorWith : fullDonors.find((d) => d.id === c);
        if (src && !blank(src[f])) pick = src;
      } else if (!c && blank(master[f]) && fillSet.has(f) && firstDonorWith) pick = firstDonorWith;
      if (pick && String(pick[f]) !== String(master[f])) {
        fill[f] = pick[f];
        rec.masterBefore[f] = master[f] === undefined ? null : master[f];
        if (!blank(master[f])) notKept.push(`${f}: ${master[f]}`);
      } else if (!pick) {
        fullDonors.forEach((d) => {
          if (CHOICE_FIELDS.includes(f) && !blank(d[f]) && !blank(master[f]) && String(d[f]).trim().toLowerCase() !== String(master[f]).trim().toLowerCase() && !(fill[f] != null)) {
            notKept.push(`${f}: ${d[f]} (from ${d.name})`);
          }
        });
      }
    });
    const leftApps = await tx.application.count({ where: { candidateId: { in: donorIds } } });
    if (leftApps) throw new MergeError('Some applications could not be moved — nothing was changed.', 500);
    await tx.candidate.deleteMany({ where: { id: { in: donorIds } } });
    if (Object.keys(fill).length) await tx.candidate.update({ where: { id: masterId }, data: fill });
    filled = fill;
    if (notKept.length) {
      const n = await tx.candidateNote.create({
        data: {
          candidateId: masterId,
          body: `Merge: details of the merged profile${donorIds.length > 1 ? 's' : ''} that were not kept — ${notKept.join(' · ').slice(0, 1500)}. Merged by ${actor}.`,
          authorUserId: user ? user.id : null, authorName: actor, authorRole: 'Merge',
        },
      });
      rec.keptNoteId = n.id;
    }

    if (useLog) {
      const now = Date.now();
      await tx.$executeRawUnsafe(
        `INSERT INTO CandidateMergeLog (id, masterId, donorIds, summary, kind, status, flagId, fieldChoices, masterBefore, snapshot, moved,
                                         performedById, performedByName, requestedById, requestedByName, createdAt, undoUntil)
         VALUES (?, ?, ?, ?, ?, 'DONE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        logId, masterId, JSON.stringify(donorIds),
        `${fullDonors.map((d) => d.name).join(', ')} merged into ${master.name}${reason ? ` — ${String(reason).slice(0, 200)}` : ''}`,
        kind, flagId, fieldChoices ? JSON.stringify(fieldChoices) : null, JSON.stringify(rec.masterBefore),
        JSON.stringify({ donors: fullDonors, folded }), JSON.stringify(rec),
        user ? user.id : null, actor, requestedBy ? requestedBy.id : null, requestedBy ? requestedBy.name : null, now, now + undoDays * 86400000,
      );
      for (const d of donorIds) {
        // eslint-disable-next-line no-await-in-loop
        await tx.$executeRawUnsafe('INSERT OR REPLACE INTO CandidateAlias (oldId, candidateId, mergeLogId, createdAt) VALUES (?, ?, ?, ?)', d, masterId, logId, now);
      }
      // an alias that pointed at a donor now points at the kept profile (older merges keep working)
      await tx.$executeRawUnsafe(`UPDATE CandidateAlias SET candidateId = ? WHERE candidateId IN (${donorIds.map(() => '?').join(',')})`, masterId, ...donorIds);
    }
  }, { timeout: 60000, maxWait: 10000 });

  const { logAudit } = require('./audit'); // eslint-disable-line global-require
  await logAudit({
    userId: user ? user.id : null,
    actorName: actor,
    action: `Candidates merged — ${donorIds.length} duplicate record(s) folded into this one`,
    entity: 'Candidate',
    entityId: masterId,
    fromValue: JSON.stringify({ donors: snapshot, foldedApplications: folded, mergeLogId: logId }),
    toValue: JSON.stringify({ moved, filled: Object.keys(filled), conflicts: conflictNotes.length }),
    reason: reason || (kind === 'SAME_PERSON_OTHER_JOB' ? 'Same person, different requirement' : 'Duplicate candidate merge (confirmed on Candidates > Duplicates)'),
  });

  // The duplicate bookkeeping AFTER the merge: the donors' keys / flags go, the kept profile is checked again.
  if (useLog) {
    try {
      for (const d of donorIds) await DUP.removeCandidate(d); // eslint-disable-line no-await-in-loop
      await DUP.reindex(masterId, { door: 'Merge', quiet: true });
      try { require('./candidateListCache').markCandidateDirty(masterId); } catch { /* optional */ } // eslint-disable-line global-require
    } catch { /* bookkeeping only */ }
  }
  return { masterId, donorIds, moved, filled: Object.keys(filled), conflictNotes, mergeLogId: logId, undoDays };
}

const { loadForMerge } = D;

// --- UNDO ---------------------------------------------------------------------------------------
async function mergeLogOf(id) {
  const r = (await DUP.q('SELECT * FROM CandidateMergeLog WHERE id = ?', id))[0];
  return r || null;
}
function undoState(log) {
  if (!log) return null;
  const until = DUP.ms(log.undoUntil);
  return {
    id: log.id, masterId: log.masterId, donorIds: DUP.json(log.donorIds, []), summary: log.summary, kind: log.kind, status: log.status,
    at: DUP.iso(log.createdAt), by: log.performedByName, undoUntil: DUP.iso(log.undoUntil),
    canUndo: log.status === 'DONE' && until != null && Date.now() <= until,
  };
}

// Dates in the stored snapshot are ISO strings; the client wants Dates back.
const reviveDates = (row) => {
  const out = {};
  Object.keys(row).forEach((k) => {
    const v = row[k];
    out[k] = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) ? new Date(v) : v;
  });
  return out;
};

async function undoMerge(logId, user) {
  const log = await mergeLogOf(logId);
  if (!log) throw new MergeError('This merge is not on record.', 404);
  if (log.status !== 'DONE') throw new MergeError('This merge was already undone.', 409);
  if (Date.now() > (DUP.ms(log.undoUntil) || 0)) throw new MergeError('The undo window for this merge is over.', 409);
  const rec = DUP.json(log.moved, null); const snap = DUP.json(log.snapshot, null);
  if (!rec || !snap) throw new MergeError('This merge has no undo information.', 409);
  const masterId = log.masterId;
  const donorIds = DUP.json(log.donorIds, []);
  const actor = user ? user.name : 'System';

  await prisma.$transaction(async (tx) => {
    const master = await tx.candidate.findUnique({ where: { id: masterId }, select: { id: true } });
    if (!master) throw new MergeError('The kept profile no longer exists, so this cannot be undone.', 409);
    for (const dId of donorIds) {
      if (await tx.candidate.findUnique({ where: { id: dId }, select: { id: true } })) throw new MergeError('The merged profile already exists again — nothing to undo.', 409); // eslint-disable-line no-await-in-loop
    }
    /* eslint-disable no-await-in-loop */
    // 1. the donors come back, exactly as they were
    for (const dId of donorIds) {
      await tx.candidate.create({ data: reviveDates(rec.donors[dId].row) });
    }
    // 2. their applications go back to them
    for (const dId of donorIds) {
      const dr = rec.donors[dId];
      for (const appId of dr.apps) {
        if (await tx.application.findUnique({ where: { id: appId }, select: { id: true } })) await tx.application.update({ where: { id: appId }, data: { candidateId: dId } });
      }
    }
    // 3. folded (same-job) applications are re-created with their history
    for (const fr of rec.folded) {
      const owner = fr.ownerId;
      const { id: _i, ...rest } = reviveDates(fr.row);
      await tx.application.create({ data: { id: fr.loserId, ...rest, candidateId: owner } });
      for (const fb of fr.feedbackRows || []) {
        if (fr.feedbackMoved.includes(fb.id)) await tx.interviewFeedback.update({ where: { id: fb.id }, data: { applicationId: fr.loserId } }).catch(() => null);
        else await tx.interviewFeedback.create({ data: reviveDates(fb) }).catch(() => null);
      }
      if (fr.stageEvents.length) await tx.applicationStageEvent.updateMany({ where: { id: { in: fr.stageEvents } }, data: { applicationId: fr.loserId, candidateId: owner } });
      if (fr.followUps.length) await tx.applicationFollowUp.updateMany({ where: { id: { in: fr.followUps } }, data: { applicationId: fr.loserId, candidateId: owner } });
      if (fr.closedFollowUps.length) await tx.applicationFollowUp.updateMany({ where: { id: { in: fr.closedFollowUps } }, data: { completedAt: null, completedNote: null, completedById: null } });
      if (fr.interviewEvents.length) await tx.interviewEvent.updateMany({ where: { id: { in: fr.interviewEvents } }, data: { applicationId: fr.loserId } });
      if (fr.messages.length) await tx.candidateMessage.updateMany({ where: { id: { in: fr.messages } }, data: { applicationId: fr.loserId } });
      if (fr.notes.length) await tx.candidateNote.updateMany({ where: { id: { in: fr.notes } }, data: { applicationId: fr.loserId } });
      if (fr.audit.length) await tx.auditLog.updateMany({ where: { id: { in: fr.audit } }, data: { entityId: fr.loserId } });
      if (fr.noteId) await tx.candidateNote.deleteMany({ where: { id: fr.noteId } });
    }
    // 4. everything else that moved goes back to its donor
    for (const dId of donorIds) {
      const dr = rec.donors[dId];
      for (const [key, delegate, col] of TABLES) {
        const ids = dr.t[key] || [];
        if (ids.length) await tx[delegate].updateMany({ where: { id: { in: ids } }, data: { [col]: dId } });
      }
      for (const [key, table, col] of RAW_TABLES) {
        const ids = dr.raw[key] || [];
        if (ids.length) await tx.$executeRawUnsafe(`UPDATE "${table}" SET ${col} = ? WHERE id IN (${ids.map(() => '?').join(',')})`, dId, ...ids);
      }
      if (dr.audit.length) await tx.auditLog.updateMany({ where: { id: { in: dr.audit } }, data: { entityId: dId } });
      if (dr.sync.length) await tx.syncLog.updateMany({ where: { id: { in: dr.sync } }, data: { recordRef: dId } });
    }
    for (const c of rec.conversations || []) {
      if (c.mode === 'repoint') await tx.$executeRawUnsafe('UPDATE Conversation SET personId = ? WHERE id = ?', c.donorId, c.convId);
      else if (c.row) {
        const cols = Object.keys(c.row);
        await tx.$executeRawUnsafe(`INSERT INTO Conversation (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((k) => c.row[k]));
        if ((c.messageIds || []).length) await tx.$executeRawUnsafe(`UPDATE ConversationMessage SET conversationId = ?, personId = ? WHERE id IN (${c.messageIds.map(() => '?').join(',')})`, c.convId, c.donorId, ...c.messageIds);
      }
    }
    // 5. the kept profile's own values come back
    const before = DUP.json(log.masterBefore, {});
    if (Object.keys(before).length) await tx.candidate.update({ where: { id: masterId }, data: before });
    if (rec.keptNoteId) await tx.candidateNote.deleteMany({ where: { id: rec.keptNoteId } });
    for (const dId of donorIds) await tx.$executeRawUnsafe('DELETE FROM CandidateAlias WHERE oldId = ?', dId);
    await tx.$executeRawUnsafe("UPDATE CandidateMergeLog SET status = 'UNDONE', undoneAt = ?, undoneById = ?, undoneByName = ? WHERE id = ?", Date.now(), user ? user.id : null, actor, logId);
    if (log.flagId) {
      await tx.$executeRawUnsafe(`UPDATE CandidateDupFlag SET status = 'OPEN', resolution = NULL, reason = ?, resolvedAt = NULL, resolvedById = NULL, resolvedByName = NULL,
                                  mergeLogId = NULL, requestedAt = NULL, requestedById = NULL, requestedByName = NULL, requestMasterId = NULL, requestChoices = NULL, updatedAt = ? WHERE id = ?`,
      `Merge undone by ${actor}`, Date.now(), log.flagId);
    }
    /* eslint-enable no-await-in-loop */
  }, { timeout: 60000, maxWait: 10000 });

  const { logAudit } = require('./audit'); // eslint-disable-line global-require
  await logAudit({
    userId: user ? user.id : null, actorName: actor, action: 'Candidate merge undone', entity: 'Candidate', entityId: masterId,
    fromValue: log.summary, toValue: JSON.stringify({ restored: donorIds }), reason: 'Merge undone inside the undo window',
  });
  try {
    DUP.bump();
    // the restored profiles first (their keys were removed by the merge), then the kept one: the pair is found again
    for (const d of donorIds) await DUP.reindex(d, { door: 'Undo merge', quiet: true }); // eslint-disable-line no-await-in-loop
    await DUP.reindex(masterId, { door: 'Undo merge', quiet: true });
    const cache = require('./candidateListCache'); // eslint-disable-line global-require
    [masterId, ...donorIds].forEach((i) => cache.markCandidateDirty(i));
  } catch { /* bookkeeping only */ }
  return { masterId, restored: donorIds };
}

module.exports = {
  MERGE_FIELDS, CHOICE_FIELDS, SENSITIVE, previewFields, mergeCandidates, undoMerge, mergeLogOf, undoState,
};
