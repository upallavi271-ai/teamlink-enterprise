// ---------------------------------------------------------------------------
// Portal login settings (spec B, 2026-10-03 — orchestrator decisions):
//
//   maxClientLogins   how many client logins one client company may hold
//                     (Active + invited). Default 3, configurable.
//   phoneOtpEnabled   one-time codes by SMS. The code path exists but is OFF
//                     until an SMS provider (MSG91 + DLT) is connected and
//                     someone switches this on.
//
// Kept in the existing Integration table as an internal row (the same pattern
// utils/attendanceAlerts.js uses) — no schema change, no credentials here.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const STORE_ID = 'portal-logins';
const DEFAULTS = { maxClientLogins: 3, phoneOtpEnabled: false };

function parse(row) {
  try { return row && row.values ? JSON.parse(row.values) : {}; } catch { return {}; }
}

async function portalSettings() {
  const row = await prisma.integration.findUnique({ where: { id: STORE_ID } }).catch(() => null);
  const v = { ...DEFAULTS, ...parse(row) };
  const max = Math.round(Number(v.maxClientLogins));
  return {
    maxClientLogins: Number.isFinite(max) && max >= 1 && max <= 20 ? max : DEFAULTS.maxClientLogins,
    phoneOtpEnabled: v.phoneOtpEnabled === true,
  };
}

async function savePortalSettings(patch) {
  const cur = await portalSettings();
  const next = { ...cur };
  if (patch.maxClientLogins !== undefined) {
    const n = Math.round(Number(patch.maxClientLogins));
    if (!Number.isFinite(n) || n < 1 || n > 20) return { error: 'Max client logins must be a number from 1 to 20.' };
    next.maxClientLogins = n;
  }
  if (patch.phoneOtpEnabled !== undefined) next.phoneOtpEnabled = patch.phoneOtpEnabled === true;
  const values = JSON.stringify(next);
  await prisma.integration.upsert({
    where: { id: STORE_ID },
    create: { id: STORE_ID, enabled: true, state: 'Internal', values },
    update: { values },
  });
  return { settings: next, before: cur };
}

module.exports = { STORE_ID, DEFAULTS, portalSettings, savePortalSettings };
