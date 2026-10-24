// ---------------------------------------------------------------------------
// SHINE adapter. The flow is BasePortal's, driven by src/portals/selectors/shine.json. Particular to Shine's form:
// the form has TWO steps (job details, then candidate profile), salary is a min and a max in lakhs, skills are tags.
// SELECTORS ARE UNVERIFIED until a DRY RUN with the company's own account (docs/job-publishing/PLAYWRIGHT.md).
// ---------------------------------------------------------------------------
const BasePortal = require('../base/BasePortal');
const { PORTALS } = require('../../jobPublish/constants');

class ShineAdapter extends BasePortal {
  static get meta() { return { ...PORTALS.shine }; }

  fieldValues(p) {
    const v = super.fieldValues(p);
    v.skills = (p.skills || []).slice(0, 15);
    v.experienceMin = p.experience.min == null ? null : Math.floor(p.experience.min);
    v.experienceMax = p.experience.max == null ? (p.experience.min == null ? null : Math.ceil(p.experience.min)) : Math.ceil(p.experience.max);
    v.salaryMin = p.salary.text && p.salary.minLakhs != null ? Math.floor(p.salary.minLakhs) : null;
    v.salaryMax = p.salary.text && p.salary.maxLakhs != null ? Math.ceil(p.salary.maxLakhs) : null;
    return v;
  }
}
module.exports = ShineAdapter;
