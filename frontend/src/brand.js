// ---------------------------------------------------------------------------
// WHOSE COPY OF THE APPLICATION IS THIS? (2026-11-16, docs/second-company.md)
//
// TeamLink's own build sets nothing, so every value below is exactly what the screens always said. A SEPARATE COMPANY's copy is built
// with its own name, for example   VITE_BRAND_NAME="NISHTECHNOLOGIES INDIA PVT LTD"  npm run build
// and then shows that name (as a text mark, until the company gives a logo) on the sign-in page, the menu and the browser tab,
// and does not offer TeamLink's Job Portal link (that is a separate program with its own database that this copy does not have).
//
//   VITE_BRAND_NAME      the company's name, shown as the mark.            (unset = TeamLink Consultants, the picture logo)
//   VITE_BRAND_PRODUCT   the product line under it / in the tab title.     (unset = TeamLink.Enterprise; with a name: "<name> · Enterprise")
//   VITE_BRAND_JOB_PORTAL=1   this company has its OWN Job Portal (its own database; docs/second-company.md section 11): the menu offers it.
// ---------------------------------------------------------------------------
const env = (import.meta && import.meta.env) || {};
const NAME = String(env.VITE_BRAND_NAME || '').trim();

export const BRAND = Object.freeze({
  // true only in a separate company's build
  separate: !!NAME,
  name: NAME || 'TeamLink Consultants',
  product: String(env.VITE_BRAND_PRODUCT || '').trim() || (NAME ? 'Enterprise' : 'TeamLink.Enterprise'),
  // a separate company's copy offers the Job Portal only when it was built to have its own
  jobPortal: !NAME || /^(1|true|yes|on)$/i.test(String(env.VITE_BRAND_JOB_PORTAL || '').trim()),
  // VITE_ATS_PROFILE=it-staffing (founder 2026-11-25, NISH): the ATS works by hiring type (Contract / Full Time / Contract to Hire) where
  // TeamLink works by department. Unset (TeamLink) = false: every screen is exactly what it was. Backend twin: utils/atsProfile.js.
  itStaffing: /^it[\s_-]*staffing$/i.test(String(env.VITE_ATS_PROFILE || '').trim()),
});

// The hiring types of an IT-staffing ATS (stored in the requirement's employmentType)
export const HIRING_TYPES = ['Contract', 'Full Time', 'Contract to Hire'];

export default BRAND;
