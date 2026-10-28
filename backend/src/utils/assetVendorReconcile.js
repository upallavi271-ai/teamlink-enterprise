// ---------------------------------------------------------------------------
// THE 227 RECONCILIATION (Assets Vendor Portal master prompt, Stage B §6.5, 27 Oct 2026) - READ ONLY.
//
// HRMS (table Asset) is the only source: the Assets Vendor Portal keeps no copy, it reads the same rows by id on every request, so there is
// nothing to "sync" - a change an HRMS admin makes is on the vendor's next request (the Assets page also re-reads every 60 seconds).
// This report counts what HRMS has, what one vendor may see, and every gap, with the reason. It never creates, changes or hides a record,
// and it never forces a count to 227.
//
// Founder decisions it follows: SIM cards are in the Airtel Bills portal, not here (27 Oct 2026); archived assets are never shown;
// the vendor sees an asset only through its scope (utils/assetHrmsScope.js) - this report does not widen it.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const HS = require('./assetHrmsScope');
const VA = require('./vendorAuth');

const EXPECTED = 227;
const isSim = (a) => /sim/i.test(String(a.category || ''));
const LEFT = ['Relieved', 'Exited'];

async function reconcile(vendorId) {
  const all = await prisma.asset.findMany({
    select: { id: true, assetCode: true, category: true, status: true, serialNumber: true, assignedToId: true, assignedTo: { select: { employmentStatus: true } } },
    orderBy: { assetCode: 'asc' },
  });
  const v = { vendorId: String(vendorId) };
  const L = await HS.listing(v);
  const seen = L.where === HS.NONE ? [] : await prisma.asset.findMany({ where: L.where, select: { id: true } });
  const seenIds = new Set(seen.map((x) => x.id));
  const archived = (a) => VA.ARCHIVED.includes(a.status);
  const sims = all.filter(isSim);
  const hardware = all.filter((a) => !isSim(a));
  const reasonOut = (a) => {
    if (seenIds.has(a.id)) return null;
    if (isSim(a)) return 'SIM card: shown in the Airtel Bills portal';
    if (archived(a)) return `Archived in HRMS (${a.status})`;
    return 'Not in this vendor\'s scope (not bought from, repaired by, linked to or granted to this vendor, and its category is not one the vendor handles automatically)';
  };
  // duplicates: the same serial number on two assets
  const bySerial = new Map();
  hardware.forEach((a) => { const k = String(a.serialNumber || '').trim().toLowerCase(); if (k) bySerial.set(k, [...(bySerial.get(k) || []), a.assetCode]); });
  const visible = hardware.filter((a) => seenIds.has(a.id));
  const count = (list, f) => list.filter(f).length;
  return {
    generatedAt: new Date().toISOString(),
    sync: { mode: 'live', note: 'No copy is kept: the portal reads HRMS on every request, so the last successful sync is "now". The Assets page re-reads every 60 seconds.' },
    hrmsTotal: all.length,
    expected: EXPECTED,
    differenceFromExpected: all.length - EXPECTED,
    simCards: sims.length,
    hardware: hardware.length,
    archived: count(hardware, archived),
    vendorVisible: visible.length,
    visible: {
      assigned: count(visible, (a) => !!a.assignedToId),
      unassigned: count(visible, (a) => !a.assignedToId),
      inRepair: count(visible, (a) => a.status === 'In Repair'),
      available: count(visible, (a) => a.status === 'Available' && !a.assignedToId),
    },
    gaps: {
      assignedWithoutHolder: hardware.filter((a) => a.status === 'Assigned' && !a.assignedToId).map((a) => a.assetCode),
      holderLeftCompany: hardware.filter((a) => a.assignedTo && LEFT.includes(a.assignedTo.employmentStatus)).map((a) => a.assetCode),
      duplicateSerials: [...bySerial.entries()].filter(([, codes]) => codes.length > 1).map(([serial, codes]) => ({ serial, assets: codes })),
    },
    // record level: every HRMS asset, and whether this vendor sees it (and why not). Asset codes only - no employee details.
    records: all.map((a) => ({ id: a.id, assetCode: a.assetCode, category: a.category, status: a.status, inPortal: seenIds.has(a.id), reason: reasonOut(a) })),
    portalNotInHrms: [], // the portal has no records of its own, so none can be missing from HRMS
  };
}

module.exports = { reconcile, EXPECTED };
