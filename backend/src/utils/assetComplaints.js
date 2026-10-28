// ---------------------------------------------------------------------------
// ASSET COMPLAINTS IN HRMS -> A REPAIR JOB FOR THE ASSETS VENDOR (2026-10-19).
//
// WHAT EXISTED BEFORE (read first, 2026-10-19): HRMS had only (a) the Helpdesk (EmployeeRecord type HELPDESK: Open / In Progress / Resolved,
// no link to an asset, no approval step) and (b) "Asset Approval" (EmployeeRecord type ASSET: an employee ASKS for an asset; HR presses
// Approve / Reject; the API even refused an employee to raise one). There was no way to complain about an asset an employee holds, and
// approving anything never made a repair (AssetRepair had 0 rows). This file is the smallest addition that makes the flow real:
//
//   1. The employee holding an asset raises "Report a problem" on it (kind: Repair | Replacement | Other + what is wrong).
//      The ticket is an ordinary EmployeeRecord (type ASSET, category = the kind, status Open) - so it shows in the EXISTING Asset Approval
//      screen with the existing Approve / Reject buttons. AssetComplaint (this file's side table) links the ticket to the ASSET and keeps a
//      short reference (ATK-0001).
//   2. HR (or the manager / lead who holds the Employee Services "approve" right for that employee - the same rule as every other record
//      there; nobody can decide their own complaint) approves it. ONLY a REPAIR complaint that is APPROVED does anything:
//        - ONE AssetRepair row is made for it (status Reported = "Awaiting repair" in the vendor portal), with the sanitised problem text.
//          AssetComplaint.repairId is UNIQUE and is set with a compare-and-set inside the same transaction, so a double click, a retry or
//          two approvers at once can never make a second repair for one ticket.
//        - the vendor that handles this kind of asset is named on the repair when EXACTLY ONE does (the vendor linked to the asset, else
//          the one vendor Admin ticked or the automatic category map gives it to). With none or several the repair stays unnamed: it is
//          seen by whichever vendor's scope holds the asset (assetHrmsScope: an unnamed repair on an asset in the vendor's own scope).
//        - an append-only repair history line "Repair approved by HR / the manager" (shown to the vendor as "Company").
//      A Replacement / Other complaint, a rejected one, a withdrawn one: nothing becomes visible to any vendor.
//   3. If the approval is later reverted (Rejected / back to Open): a repair the vendor has NOT started (still "Awaiting repair", no cost,
//      no invoice) is withdrawn (status Cancelled, with a history line); one the vendor already started keeps going (a history line says
//      the approval was reverted). Approving it again re-opens a withdrawn repair.
//   4. Catch-up: reconcile() makes the repair for any approved Repair complaint that has none yet (a crash between the two steps). It runs
//      lazily on portal reads; it is idempotent.
//
// The vendor never sees the ticket, the employee's name, HR remarks or the manager's comments: it gets the sanitised problem text, the ticket
// reference and the approval day. NOTHING is posted to Accounts (no ledger entry, never paid): the repair is a plain 'Reported' row.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const DB = require('./vmDb');
const SCH = require('./assetVendorSchema');
const HS = require('./assetHrmsScope');
const VA = require('./vendorAuth');
const { logAudit } = require('./audit');

const KINDS = ['Repair', 'Replacement', 'Other'];
const KIND_HELP = {
  Repair: 'It is broken or not working: the company sends it to the repair vendor once HR or your manager approves.',
  Replacement: 'It cannot be fixed or is lost: ask for a new one.',
  Other: 'Anything else about this asset.',
};
const nowIso = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const newId = () => `are${crypto.randomBytes(12).toString('hex')}`;
const DENY = { error: "This isn't included in your role's permissions" };

// ---- sanitising the problem text for the vendor -------------------------------------------------------------------
// No tags, no e-mail address, no long number (phone), and the employee's own name / code removed. Department is the only personal detail a vendor gets.
function sanitise(text, employee) {
  let t = String(text == null ? '' : text).replace(/<[^>]*>/g, ' ').replace(/[<>]/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ');
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email hidden]');
  t = t.replace(/\+?\d[\d\s-]{8,}\d/g, '[number hidden]');
  const hide = [];
  if (employee) {
    if (employee.name) {
      hide.push(employee.name);
      String(employee.name).split(/\s+/).filter((w) => w.length >= 4).forEach((w) => hide.push(w));
    }
    if (employee.employeeCode) hide.push(employee.employeeCode);
  }
  hide.sort((a, b) => b.length - a.length).forEach((h) => {
    t = t.replace(new RegExp(String(h).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), '[employee]');
  });
  return t.replace(/\s+/g, ' ').trim().slice(0, 500);
}

const roleWord = (user) => {
  const r = String((user && (user.hrmsRole && user.hrmsRole !== 'NONE' ? user.hrmsRole : user.role)) || '').toUpperCase();
  if (r === 'HR') return 'HR';
  if (['SUPER_ADMIN', 'ADMIN'].includes(r)) return 'Admin';
  return 'the manager';
};

// ---- raising ------------------------------------------------------------------------------------------------------
async function nextRef() {
  const rows = await DB.q('SELECT "ticketRef" FROM "AssetComplaint"');
  const max = rows.reduce((m, r) => { const x = /^ATK-(\d+)$/.exec(r.ticketRef || ''); return x ? Math.max(m, Number(x[1])) : m; }, 0);
  return `ATK-${String(max + 1).padStart(4, '0')}`;
}

// user = the signed-in staff user (req.user). body = { assetId, kind, issue }.
async function raise(user, body) {
  await SCH.ensure();
  const employee = await prisma.employee.findUnique({ where: { userId: user.id } });
  if (!employee) return { status: 404, body: { error: 'No employee record is linked to this login.' } };
  const b = body && typeof body === 'object' ? body : {};
  const kind = KINDS.find((k) => k.toLowerCase() === str(b.kind).toLowerCase());
  if (!kind) return { status: 400, body: { error: `Pick what you need: ${KINDS.join(', ')}.`, field: 'kind' } };
  const issue = str(b.issue).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  if (/[<>]/.test(issue)) return { status: 400, body: { error: 'Plain words only - no < or > characters.', field: 'issue' } };
  if (issue.length < 5) return { status: 400, body: { error: 'Write what is wrong, in a few words.', field: 'issue' } };
  if (issue.length > 800) return { status: 400, body: { error: 'Keep it under 800 characters.', field: 'issue' } };
  const asset = await prisma.asset.findFirst({ where: { id: str(b.assetId), assignedToId: employee.id, NOT: { status: { in: VA.ARCHIVED } } } });
  if (!asset) return { status: 404, body: { error: 'This asset is not assigned to you.', field: 'assetId' } };
  const open = await DB.q('SELECT c."ticketRef" FROM "AssetComplaint" c JOIN "EmployeeRecord" r ON r."id" = c."ticketId" WHERE c."assetId" = ? AND c."kind" = ? AND r."status" = ?', [asset.id, kind, 'Open']);
  if (open.length) return { status: 409, body: { error: `You already reported this (${open[0].ticketRef}). It is waiting for a decision.` } };
  let created = null;
  for (let i = 0; i < 5 && !created; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      created = await prisma.$transaction(async (tx) => {
        const rec = await tx.employeeRecord.create({
          data: {
            type: 'ASSET', employeeId: employee.id, title: `${asset.name} (${asset.assetCode}) - ${kind}`, detail: issue, category: kind, priority: 'Medium', status: 'Open', notes: '[]',
          },
        });
        const ref = await nextRef();
        const t = nowIso();
        await DB.run('INSERT INTO "AssetComplaint" ("ticketId","ticketRef","assetId","kind","issue","employeeId","raisedAt","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?)', [rec.id, ref, asset.id, kind, issue, employee.id, t, t, t], tx);
        return { rec, ref };
      });
    } catch (err) {
      if (!/UNIQUE/i.test(String(err && err.message)) || i === 4) throw err;
    }
  }
  await logAudit({ userId: user.id, action: 'Asset complaint raised', entity: 'EmployeeRecord', entityId: created.rec.id, toValue: `${created.ref} · ${asset.assetCode} · ${kind}` });
  try {
    await require('./vendorModules').notifyCompany({ // eslint-disable-line global-require
      creatorId: null, title: `Asset complaint ${created.ref}: ${kind}`,
      message: `${employee.name} reported a problem with ${asset.name} (${asset.assetCode}): ${kind}. Open Employee Services > Assets > Asset Approval to decide.`,
    });
  } catch (e) { console.error('[asset-complaint notify]', e && e.message); } // eslint-disable-line no-console
  return { status: 201, body: { id: created.rec.id, ticketRef: created.ref, kind, status: 'Open', message: `Sent (${created.ref}). HR or your manager will decide. You can see the answer here.` } };
}

// The assets the signed-in employee holds right now (what "Report a problem" offers). Nothing else of the asset is sent.
async function myAssets(user) {
  const employee = await prisma.employee.findUnique({ where: { userId: user.id }, select: { id: true } });
  if (!employee) return [];
  return prisma.asset.findMany({ where: { assignedToId: employee.id, NOT: { status: { in: VA.ARCHIVED } } }, select: { id: true, assetCode: true, name: true, category: true }, orderBy: { assetCode: 'asc' } });
}

// ---- the list (employee: own; HR / lead: their scope) -----------------------------------------------------------------
async function list(where) {
  await SCH.ensure();
  const recs = await prisma.employeeRecord.findMany({ where: { type: 'ASSET', ...where }, include: { employee: { select: { name: true, employeeCode: true, department: true } } }, orderBy: { createdAt: 'desc' }, take: 500 });
  if (!recs.length) return [];
  const rows = await DB.q(`SELECT * FROM "AssetComplaint" WHERE "ticketId" IN (${recs.map(() => '?').join(',')})`, recs.map((r) => r.id));
  const by = new Map(rows.map((r) => [r.ticketId, r]));
  const assets = new Map((await prisma.asset.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.assetId))] } }, select: { id: true, assetCode: true, name: true, category: true } })).map((a) => [a.id, a]));
  const reps = new Map((await prisma.assetRepair.findMany({ where: { id: { in: rows.map((r) => r.repairId).filter(Boolean) } }, select: { id: true, repairNo: true, status: true, vendor: true } })).map((r) => [r.id, r]));
  return recs.filter((r) => by.has(r.id)).map((r) => {
    const c = by.get(r.id); const a = assets.get(c.assetId) || {}; const rep = c.repairId ? reps.get(c.repairId) : null;
    return {
      id: r.id, ticketRef: c.ticketRef, kind: c.kind, issue: c.issue, status: r.status, raisedAt: c.raisedAt, decidedAt: c.decidedAt, decidedBy: c.decidedByName, decidedRole: c.decidedRole,
      asset: { id: c.assetId, assetCode: a.assetCode || null, name: a.name || null, category: a.category || null },
      employee: r.employee ? { name: r.employee.name, employeeCode: r.employee.employeeCode, department: r.employee.department } : null,
      repair: rep ? { repairNo: rep.repairNo, status: rep.status, vendor: rep.vendor || null } : null,
    };
  });
}

// ---- deciding -----------------------------------------------------------------------------------------------------
async function complaintOf(ticketId) {
  await SCH.ensure();
  return DB.one('SELECT * FROM "AssetComplaint" WHERE "ticketId" = ?', [String(ticketId || '')]);
}
// Before the status of an ASSET record changes: a complaint can only go Approved / Rejected / back to Open, and nobody decides their own.
async function gate(record, user, newStatus) {
  const c = await complaintOf(record.id);
  if (!c) return null; // a plain asset request: the old rules apply
  if (!['Approved', 'Rejected', 'Open'].includes(newStatus)) return { status: 400, error: 'A complaint can be Approved, Rejected or set back to Open.' };
  if (user.employeeId && record.employeeId === user.employeeId) return { status: 403, error: 'You cannot decide your own complaint. HR or your manager decides it.' };
  return null;
}

async function nextRepairNo(tx) {
  const rows = await tx.assetRepair.findMany({ select: { repairNo: true } });
  const max = rows.reduce((m, r) => { const x = /^RP-(\d+)$/.exec(r.repairNo || ''); return x ? Math.max(m, Number(x[1])) : m; }, 0);
  return `RP-${String(max + 1).padStart(5, '0')}`;
}
async function eventRow(tx, repair, vendorId, kind, note, actor) {
  await DB.run('INSERT INTO "AssetRepairEvent" ("id","repairId","assetId","vendorId","vendorUserId","kind","field","fromValue","toValue","note","actorKind","actorName","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [newId(), repair.id, repair.assetId, vendorId || null, null, kind, null, null, null, note, 'Company', actor || 'Company', nowIso()], tx);
}

// ONE repair for an approved Repair complaint. Idempotent: the same ticket again returns the repair it already has.
async function ensureRepair(c, actor) {
  await SCH.ensure();
  const asset = await prisma.asset.findUnique({ where: { id: c.assetId } });
  if (!asset || VA.ARCHIVED.includes(asset.status)) return { repair: null, note: 'The asset is not on the books any more, so no repair job was made.' };
  const employee = await prisma.employee.findUnique({ where: { id: c.employeeId }, select: { name: true, employeeCode: true } });
  const who = await HS.vendorsForAsset(asset);
  const issue = sanitise(c.issue, employee) || 'Problem reported by the employee.';
  const by = actor || { id: null, name: 'Company', word: 'HR' };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const out = await prisma.$transaction(async (tx) => {
        const cur = await DB.one('SELECT * FROM "AssetComplaint" WHERE "ticketId" = ?', [c.ticketId], tx);
        if (cur && cur.repairId) return { repair: await tx.assetRepair.findUnique({ where: { id: cur.repairId } }), existed: true };
        const repair = await tx.assetRepair.create({
          data: {
            repairNo: await nextRepairNo(tx), assetId: asset.id, dateReported: today(), issue, repairType: 'Repair', vendor: who.vendor ? who.vendor.name : null, status: 'Reported',
            reportedById: by.id || null, reportedByName: by.name || null, notes: `From asset complaint ${c.ticketRef}`,
          },
        });
        const n = await DB.run('UPDATE "AssetComplaint" SET "repairId" = ?, "updatedAt" = ? WHERE "ticketId" = ? AND "repairId" IS NULL', [repair.id, nowIso(), c.ticketId], tx);
        if (!n) throw Object.assign(new Error('raced'), { raced: true });
        await eventRow(tx, repair, who.vendor ? who.vendor.id : null, 'approved', `Repair approved by ${by.word || 'HR'} (ticket ${c.ticketRef}).`, 'Company');
        return { repair, existed: false, who };
      }, { timeout: 20000 });
      if (!out.existed) {
        await logAudit({ userId: by.id || undefined, action: 'Asset repair logged', entity: 'AssetRepair', entityId: out.repair.id, toValue: `${out.repair.repairNo} · ${asset.assetCode} · Reported · from ${c.ticketRef}` });
      }
      return { repair: out.repair, existed: out.existed, who };
    } catch (err) {
      const msg = String((err && err.message) || '');
      if (err && err.raced) { const cur = await complaintOf(c.ticketId); if (cur && cur.repairId) return { repair: await prisma.assetRepair.findUnique({ where: { id: cur.repairId } }), existed: true, who }; } // eslint-disable-line no-await-in-loop
      if (!(/UNIQUE/i.test(msg) || (err && err.code === 'P2002')) || attempt === 4) throw err;
    }
  }
  return { repair: null };
}

// Did the vendor already start this repair? (then the company can no longer pull it back)
async function started(repair) {
  if (repair.status !== 'Reported') return true;
  if (Number(repair.cost) > 0 || Number(repair.gstPaid) > 0 || repair.invoiceNo) return true;
  const side = await DB.one('SELECT "stage","estimateCost","vendorRemarks","invoiceFile" FROM "AssetRepairVendor" WHERE "repairId" = ?', [repair.id]);
  return !!(side && ((side.stage && side.stage !== 'Awaiting repair') || side.estimateCost != null || side.vendorRemarks || side.invoiceFile));
}
async function withdrawRepair(c, actor) {
  if (!c.repairId) return { withdrawn: false };
  const repair = await prisma.assetRepair.findUnique({ where: { id: c.repairId } });
  if (!repair) return { withdrawn: false };
  const by = actor || { name: 'Company', word: 'HR' };
  if (await started(repair)) {
    if (repair.status !== 'Cancelled') {
      await prisma.$transaction(async (tx) => { await eventRow(tx, repair, null, 'approval reverted', `The approval of ticket ${c.ticketRef} was taken back, but the repair has already started, so it continues.`, by.name); });
    }
    return { withdrawn: false, kept: true };
  }
  if (repair.status === 'Cancelled') return { withdrawn: true };
  await prisma.$transaction(async (tx) => {
    const n = await tx.assetRepair.updateMany({ where: { id: repair.id, status: 'Reported' }, data: { status: 'Cancelled' } });
    if (n.count) await eventRow(tx, repair, null, 'withdrawn', `Withdrawn: the approval of ticket ${c.ticketRef} was taken back before the repair started.`, by.name);
  });
  await logAudit({ userId: by.id || undefined, action: 'Asset repair withdrawn', entity: 'AssetRepair', entityId: repair.id, toValue: `${repair.repairNo} · ${c.ticketRef}` });
  return { withdrawn: true };
}
async function reopenRepair(c, actor) {
  if (!c.repairId) return false;
  const repair = await prisma.assetRepair.findUnique({ where: { id: c.repairId } });
  if (!repair || repair.status !== 'Cancelled') return false;
  const side = await DB.one('SELECT "repairId" FROM "AssetRepairVendor" WHERE "repairId" = ?', [repair.id]);
  if (side) return false; // the vendor had touched it: it stays cancelled (HR can log a new repair)
  const by = actor || { name: 'Company', word: 'HR' };
  await prisma.$transaction(async (tx) => {
    const n = await tx.assetRepair.updateMany({ where: { id: repair.id, status: 'Cancelled' }, data: { status: 'Reported' } });
    if (n.count) await eventRow(tx, repair, null, 'approved', `Repair approved again by ${by.word || 'HR'} (ticket ${c.ticketRef}).`, by.name);
  });
  return true;
}

// After the ticket's status was saved. record = the updated EmployeeRecord. Never throws into the caller's answer for the employee screen:
// the caller already saved the status; a failure here is logged and reconcile() finishes the job.
async function onStatusChange(record, user) {
  const c = await complaintOf(record.id);
  if (!c) return null;
  const actor = { id: user.id, name: user.name || user.email || 'HR', word: roleWord(user) };
  const t = nowIso();
  if (record.status === 'Approved') {
    await DB.run('UPDATE "AssetComplaint" SET "decision" = ?, "decidedById" = ?, "decidedByName" = ?, "decidedRole" = ?, "decidedAt" = ?, "updatedAt" = ? WHERE "ticketId" = ?', ['Approved', user.id, actor.name, actor.word, t, t, c.ticketId]);
    // An approved "Replacement" ticket opens the replacement record (Stage C, 2026-10-28): HR then records the new asset.
    if (c.kind === 'Replacement') { const rx = await require('./assetRepairWork').fromApprovedTicket(c, actor); return { kind: c.kind, repair: null, replacementId: rx.id }; } // eslint-disable-line global-require
    if (c.kind !== 'Repair') return { kind: c.kind, repair: null };
    const fresh = await complaintOf(record.id);
    if (fresh.repairId) { await reopenRepair(fresh, actor); return { kind: c.kind, repairId: fresh.repairId, existed: true }; }
    const r = await ensureRepair(fresh, actor);
    return { kind: c.kind, repairId: r.repair ? r.repair.id : null, repairNo: r.repair ? r.repair.repairNo : null, existed: !!r.existed, vendor: r.who && r.who.vendor ? r.who.vendor.name : null };
  }
  await DB.run('UPDATE "AssetComplaint" SET "decision" = ?, "decidedById" = ?, "decidedByName" = ?, "decidedRole" = ?, "decidedAt" = ?, "updatedAt" = ? WHERE "ticketId" = ?', [record.status === 'Rejected' ? 'Rejected' : null, user.id, actor.name, actor.word, t, t, c.ticketId]);
  if (c.repairId) return { kind: c.kind, ...(await withdrawRepair(c, actor)) };
  return { kind: c.kind, repair: null };
}

// Lazy catch-up (idempotent): approved Repair complaints that have no repair yet. Cheap when there is nothing to do.
let lastReconcile = 0;
async function reconcile({ force = false } = {}) {
  if (!force && Date.now() - lastReconcile < (process.env.TEST_MODE === '1' ? 0 : 15000)) return 0;
  lastReconcile = Date.now();
  try {
    await SCH.ensure();
    const rows = await DB.q('SELECT c.* FROM "AssetComplaint" c JOIN "EmployeeRecord" r ON r."id" = c."ticketId" WHERE c."kind" = ? AND c."repairId" IS NULL AND r."status" = ? LIMIT 50', ['Repair', 'Approved']);
    let n = 0;
    for (const c of rows) {
      // eslint-disable-next-line no-await-in-loop
      const r = await ensureRepair(c, { id: null, name: c.decidedByName || 'Company', word: c.decidedRole || 'HR' });
      if (r.repair && !r.existed) n += 1;
    }
    return n;
  } catch (err) { console.error('[asset-complaints] reconcile:', err && err.message); return 0; } // eslint-disable-line no-console
}
const resetReconcile = () => { lastReconcile = 0; };

// For the vendor portal: ticket reference + approval day of each repair (one read). The vendor gets nothing else of the ticket.
async function ticketsForRepairs(repairIds) {
  if (!repairIds.length) return new Map();
  await SCH.ensure();
  const rows = await DB.q(`SELECT "repairId","ticketRef","decidedAt","decidedRole" FROM "AssetComplaint" WHERE "repairId" IN (${repairIds.map(() => '?').join(',')})`, repairIds);
  return new Map(rows.map((r) => [r.repairId, { ticketRef: r.ticketRef, approvedOn: r.decidedAt ? String(r.decidedAt).slice(0, 10) : null, approvedBy: r.decidedRole || null }]));
}

module.exports = {
  KINDS, KIND_HELP, DENY, sanitise, raise, list, myAssets, complaintOf, gate, onStatusChange, ensureRepair, withdrawRepair, reopenRepair, reconcile, resetReconcile, ticketsForRepairs, roleWord,
};
