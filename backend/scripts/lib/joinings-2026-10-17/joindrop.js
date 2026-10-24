// ---------------------------------------------------------------------------
// JOININGS IMPORT 2026-10-17 - PHASE C: THE DROP SIDE OF "JOINING & DROP".
// Joined people whom the sheets say LEFT ("Drop" with proof of joining, "Joined(Dropped)", a leaving date or month) become a
// Dropped record in the Joining & Drop tables (JoiningRecord / JoiningEvent), the same way the module's own one-time copy of the older
// "Left the job" records does it: nothing is sent, no replacement task is opened, the reason is "Not recorded" unless the sheet
// says more (the sheet's words are kept in the detail). Only when those tables exist. Joined people who did NOT leave get their
// ordinary record from the module's own one-time copy of every Joined application.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const q = async (prisma, sql, ...p) => (await prisma.$queryRawUnsafe(sql, ...p)).map((r) => { const o = {}; Object.keys(r).forEach((k) => { o[k] = typeof r[k] === 'bigint' ? Number(r[k]) : r[k]; }); return o; });
const rid = (p) => `${p}${crypto.randomBytes(10).toString('hex')}`;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dmy = (iso) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : 'Not recorded');
const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

async function planDropRecords({ prisma, L, leftApps }) {
  const out = { planned: 0, skippedExisting: 0, tablesMissing: false, rows: [] };
  const tables = new Set((await q(prisma, "SELECT name FROM sqlite_master WHERE type='table'")).map((r) => r.name));
  if (!tables.has('JoiningRecord') || !tables.has('JoiningEvent')) { out.tablesMissing = true; return out; }
  const have = new Set((await q(prisma, 'SELECT "applicationId" FROM "JoiningRecord"')).map((r) => r.applicationId));
  const now = new Date().toISOString();
  for (const a of leftApps.values()) {
    if (have.has(a.appId)) { out.skippedExisting += 1; continue; }
    const joinedOn = /^\d{4}-\d{2}-\d{2}$/.test(a.joinedOn || '') ? a.joinedOn : null;
    const droppedOn = a.left.on && /^\d{4}-\d{2}-\d{2}$/.test(a.left.on) && (!joinedOn || a.left.on >= joinedOn) && a.left.on <= '2026-10-17' ? a.left.on : null;
    const said = [`The joinings sheet (${a.sheet}, row ${a.rowNo}) says "${a.left.text || 'Drop'}"`];
    if (a.left.month && !droppedOn) said.push(`left in ${a.left.month}`);
    const id = rid('jr');
    const rec = {
      id, applicationId: a.appId, candidateId: a.candidateId, candidateName: a.candidateName, requirementId: a.requirementId, jobTitle: a.jobTitle, jobCode: a.jobCode,
      clientId: a.clientId, clientName: a.clientName, department: a.department, hiringType: 'Client Placement', status: 'Dropped', joinedOn, location: null,
      designation: a.designation, offeredCtc: a.offeredCtc || null, employmentType: null, reportingPerson: null, reportingContact: null,
      recruiterUserId: a.recruiterUserId || null, recruiterName: a.recruiterName || null, tlUserId: a.tlUserId || null, tlName: a.tlName || null, bdeUserId: null, bdeName: null, seat: a.seat || null,
      guaranteeDays: null, guaranteeStartOn: null, guaranteeEndsOn: null, guaranteeSource: null, notes: null,
      recordedById: null, recordedByName: 'Copied from the joinings sheets (import 2026-10-17)', recordedByRole: null, recordedVia: 'Import', backfilled: 1,
      droppedOn, lastWorkingDay: null, dropReason: 'Not recorded', dropReasonDetail: said.join('; ').slice(0, 1000),
      dropReportedById: null, dropReportedByName: 'Joinings sheets (import)', dropReportedByRole: null, dropReportedFrom: 'Import', dropReportedAt: now,
      dropWithinGuarantee: null, dropDaysSinceJoining: joinedOn && droppedOn ? days(joinedOn, droppedOn) : null, dropAfterIncentive: 0,
      replacementDecision: null, replacementComment: null, replacementExpectedOn: null, replacementProfileNotes: null, replacementDecidedAt: null, replacementDecidedById: null, replacementDecidedByName: null,
      replacementOnBehalf: 0, replacementStatus: null, replacementApplicationId: null, replacementLinkedAt: null, createdAt: now, updatedAt: now,
    };
    L.rawCreate('JoiningRecord', rec);
    const ev = (kind, summary, newValue) => ({ id: rid('je'), recordId: id, applicationId: a.appId, candidateId: a.candidateId, at: now, kind, byId: null, byName: null, byRole: null, fromWhere: 'Import', onBehalf: 0, summary: summary.slice(0, 500), oldValue: null, newValue: newValue ? JSON.stringify(newValue).slice(0, 4000) : null, note: null });
    L.rawCreate('JoiningEvent', ev('JOINED', `Copied from the joinings sheets: joined on ${dmy(joinedOn)}. Place not recorded.`, { joinedOn }));
    L.rawCreate('JoiningEvent', ev('DROP_REPORTED', `Copied from the joinings sheets: left${droppedOn ? ` on ${dmy(droppedOn)}` : ' (the day was not recorded)'}. Reason: Not recorded. ${said.join('; ')}.`, { droppedOn }));
    out.planned += 1;
    out.rows.push({ candidate: a.candidateName, client: a.clientName, joinedOn, droppedOn, said: said.join('; '), marker: a.marker });
  }
  return out;
}

module.exports = { planDropRecords };
