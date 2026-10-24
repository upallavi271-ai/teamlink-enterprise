// ---------------------------------------------------------------------------
// FOUNDIT (Monster) adapter. The flow is BasePortal's, driven by src/portals/selectors/foundit.json.
// Particular to Foundit's form: the city is picked from a suggestion list (autocomplete), employment type is a set of
// radio buttons, experience is a min / max pair and the salary is a "min - max" range in lakhs.
// SELECTORS ARE UNVERIFIED until a DRY RUN with the company's own account (docs/job-publishing/PLAYWRIGHT.md).
// ---------------------------------------------------------------------------
const BasePortal = require('../base/BasePortal');
const { PORTALS } = require('../../jobPublish/constants');

class FounditAdapter extends BasePortal {
  static get meta() { return { ...PORTALS.foundit }; }

  fieldValues(p) {
    const v = super.fieldValues(p);
    v.skills = (p.skills || []).slice(0, 20);
    v.experienceMin = p.experience.min == null ? null : Math.floor(p.experience.min);
    v.experienceMax = p.experience.max == null ? (p.experience.min == null ? null : Math.ceil(p.experience.min)) : Math.ceil(p.experience.max);
    v.salary = p.salary.text && p.salary.minLakhs != null ? `${p.salary.minLakhs} - ${p.salary.maxLakhs == null ? p.salary.minLakhs : p.salary.maxLakhs}` : '';
    return v;
  }
}
module.exports = FounditAdapter;
