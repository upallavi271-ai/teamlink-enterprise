// ---------------------------------------------------------------------------
// THE ATS's BUSINESS PROFILE (founder 2026-11-25: "nish technologies ... ats lo matramey - vallu only IT staffing recruit chestharu, manaki all
// departments ani filters vunnai, vallaki contract based & full time ani vundali ... teamlink ni em disturb cheyyoddhu").
//
//   ATS_PROFILE unset            TeamLink and every PC: 'departments' - nothing anywhere changes (this file answers exactly what the code did before).
//   ATS_PROFILE=it-staffing      a separate company's copy (NISH: /opt/company-nish/config/.env): the ATS works by HIRING TYPE - Contract /
//                                Full Time / Contract to Hire, the requirement's employmentType - where TeamLink works by department.
//
// The screens read the same switch from their build (VITE_ATS_PROFILE, frontend/src/brand.js).
// ---------------------------------------------------------------------------
const IT = 'it-staffing';
const profile = () => (/^it[\s_-]*staffing$/i.test(String(process.env.ATS_PROFILE || '').trim()) ? IT : 'departments');
const itStaffing = () => profile() === IT;

// The hiring types an IT-staffing requirement is one of (stored in Requirement.employmentType, as TeamLink already stores "Full Time" / "Contract").
const HIRING_TYPES = ['Contract', 'Full Time', 'Contract to Hire'];

// "contract", "Full-time", "C2H", "contract to hire" -> the stored word; anything else stays as it was typed
function hiringTypeOf(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const k = s.toLowerCase().replace(/[\s_-]+/g, ' ');
  if (/^(c2h|contract to hire|contract hire)$/.test(k)) return 'Contract to Hire';
  if (/^(contract|contractual|contract based|c2c)$/.test(k)) return 'Contract';
  if (/^(full time|fulltime|permanent|fte)$/.test(k)) return 'Full Time';
  return s;
}

// ?jobType=Contract,Full Time -> a Prisma `where` on Requirement (null when nothing is asked)
function requirementHiringWhere(csv) {
  const want = String(csv || '').split(',').map(hiringTypeOf).filter(Boolean);
  if (!want.length) return null;
  return { employmentType: { in: want } };
}

module.exports = { profile, itStaffing, IT, HIRING_TYPES, hiringTypeOf, requirementHiringWhere };
