// ---------------------------------------------------------------------------
// THE FOUR PERSON FILTERS used across the ATS lists (founder 2026-11-17: "qualification, designation, specialization filters, experience kuda - complete ATS lo,
// anni depts ki, prathi module lo"): Specialization, Qualification, Designation and Experience band of a candidate.
//   specOf / qualOf : the master name when the profile is mapped, else the profile's own words, tidied ("radiology", "Radiology " -> Radiology; CSE stays CSE)
//   desigOf         : the current designation, tidied
//   expBandOf       : 0-1, 1-3, 3-5, 5-10, 10+ years ('none' when not given)
// The same rules as the Candidates list (routes/candidates.js), so a count means the same on every screen.
// ---------------------------------------------------------------------------
function tidy(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.split(' ').map((w) => (w.length <= 4 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(' ').slice(0, 60);
}
const specOf = (c, labels) => (labels && c && c.specialisationId && labels.spec(c.specialisationId)) || tidy(c && c.specialization);
const qualOf = (c, labels) => (labels && c && c.qualificationId && labels.qual(c.qualificationId)) || tidy(c && c.education);
const desigOf = (c) => tidy(c && c.currentDesignation);
const EXP_BANDS = [['0-1', 0, 1], ['1-3', 1, 3], ['3-5', 3, 5], ['5-10', 5, 10], ['10+', 10, Infinity]];
function expBandOf(y) {
  if (y === null || y === undefined || y === '') return 'none';
  const n = Number(y);
  if (!Number.isFinite(n) || n < 0) return 'none';
  const b = EXP_BANDS.find(([, lo, hi]) => n >= lo && n < hi);
  return b ? b[0] : 'none';
}
const BAND_ORDER = ['0-1', '1-3', '3-5', '5-10', '10+', 'none'];
const bandLabel = (v) => (v === 'none' ? 'Not given' : `${v} years`);
async function labels() {
  try { return await require('./specialisations').labelsFor(); } catch { return null; } // eslint-disable-line global-require
}
let cached = null; let cachedAt = 0;
/** The master names without waiting: the last copy read (refreshed in the background every 10 minutes); null at the very start. */
function labelsSync() {
  if (!cached || Date.now() - cachedAt > 10 * 60e3) { cachedAt = Date.now(); labels().then((l) => { cached = l; }).catch(() => {}); }
  return cached;
}
/** The four values of one candidate: { spec, qual, desig, expBand } ('none' where there is nothing). */
function fieldsOf(c, lab) {
  return { spec: specOf(c, lab) || 'none', qual: qualOf(c, lab) || 'none', desig: desigOf(c) || 'none', expBand: expBandOf(c && c.experienceYears) };
}

module.exports = { tidy, specOf, qualOf, desigOf, expBandOf, fieldsOf, labels, labelsSync, BAND_ORDER, bandLabel };
