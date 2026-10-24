// ---------------------------------------------------------------------------
// WHICH PORTAL DOES THIS VENDOR GET? (2026-10-19) - the one place that decides. Four kinds, exactly one per vendor:
//   'assets'  - the Assets Vendor Portal   (utils/assetVendorPortal.js)
//   'idcards' - the ID Card Vendor Portal  (utils/idCardVendorPortal.js)
//   'telecom' - the Airtel Bills Portal    (utils/airtelBillsPortal.js): Bills, Monthly History, SIMs
//   'finance' - the four finance modules   (Dashboard, Invoices, Payments, Purchase Orders) - everybody else, as before
// Rule: when Admin set the login's modules (VendorLoginModule rows exist), the ticked modules decide: Assets -> assets, else
// ID Card Orders -> idcards (Assets wins when both are ticked), else Airtel Bills -> telecom, else finance. A login with no module rows
// follows the vendor-master CATEGORY: "IT / Hardware / AMC / Service" -> assets, "ID Cards" -> idcards, anything else -> finance.
// The Airtel Bills portal is reached ONLY by the "Airtel Bills" tick (many categories - Internet, Mobile, SIM - would otherwise move finance
// vendors that exist today); a vendor never changes portal because of its category text.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const VA = require('./vendorAuth');
const CFG = require('../config/vendorModules');
const MODS = require('./vendorModules');

async function kindOfRow(vu) {
  const eff = await MODS.effectiveModules(vu);
  if (eff.configured) {
    if (eff.map.has('assets')) return 'assets';
    if (eff.map.has('id_card_orders')) return 'idcards';
    return eff.map.has('airtel_bills') ? 'telecom' : 'finance'; // 2026-10-19: the Airtel Bills portal (Admin ticks "Airtel Bills")
  }
  const vendor = vu.vendor || await prisma.officeVendor.findUnique({ where: { id: vu.vendorId }, select: { category: true } });
  const key = CFG.resolveCategory(vendor && vendor.category);
  if (key === 'it_service') return 'assets';
  return key === 'id_cards' ? 'idcards' : 'finance'; // (telecom is NEVER decided by category: "Internet" / "Mobile" vendors stay on the finance portal; Admin ticks "Airtel Bills")
}
// From a (verified) vendor token, before the session check: the wall only needs to know which portal this vendor belongs to.
async function kindOfToken(token) {
  const c = VA.verifyVendorToken(token);
  if (!c) return null;
  const vu = await prisma.vendorUser.findUnique({ where: { id: c.vuid }, include: { vendor: true } });
  return vu ? kindOfRow(vu) : null;
}
module.exports = { kindOfRow, kindOfToken };
