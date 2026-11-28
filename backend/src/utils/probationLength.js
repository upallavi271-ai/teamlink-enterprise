// ---------------------------------------------------------------------------
// HOW LONG THE PROBATION IS, for the joining letter (utils/internalOnboarding.js) and the HR letters (utils/hrLetters.js); the offer
// letter has its own two numbers in its editor (utils/offerLetterMail.js, same rule). The separate Probation module (screen, reminders, reviews) was
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

// A Team Lead (the shorter probation): the login's role is TL, or the designation says Team Lead / TL. A Senior Team Lead (STL) is not.
function isLead({ designation, user } = {}) {
  if (user && [user.role, user.hrmsRole].includes('TL')) return true;
  const d = String(designation || '').replace(/\(.*?\)/g, ' ').trim();
  return !/\b(senior|sr|stl)\b/i.test(d) && /\b(team\s*lead(er)?|tl)\b/i.test(d);
}

module.exports = { getSettings, isLead };
