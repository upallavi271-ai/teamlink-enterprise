// ---------------------------------------------------------------------------
// HOW LONG THE PROBATION IS, for the HR letters (utils/hrLetters.js). The separate Probation module (screen, reminders, reviews) was
// removed on 2026-11-28 (founder: "remove that probation module, not a separate module: it is mentioned in onboarding / the offer
// letter"). The numbers saved earlier stay where they were (AppSetting "probation.settings": months, leadMonths): 6 months for
// everybody, 3 for Team Leads (founder 2026-11-25). The two old tables (ProbationRecord, ProbationEvent) are kept, unused.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const whole = (v) => Number.isInteger(v) && v >= 1 && v <= 12;
async function getSettings() {
  const row = await prisma.appSetting.findUnique({ where: { key: 'probation.settings' } }).catch(() => null);
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  return {
    months: whole(v.months) ? v.months : (Number(process.env.PROBATION_MONTHS) || 6),
    leadMonths: whole(v.leadMonths) ? v.leadMonths : 3,
  };
}

module.exports = { getSettings };
