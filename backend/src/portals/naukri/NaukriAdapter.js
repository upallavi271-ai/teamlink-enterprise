// ---------------------------------------------------------------------------
// NAUKRI adapter. The whole flow (sign in, fill, preview, submit, capture the id, verify, close) is BasePortal's,
// driven by src/portals/selectors/naukri.json. This file only holds what is particular to Naukri's form:
//   * key skills are TAGS (at most 15), typed one by one
//   * experience is a minimum and a maximum in whole years
//   * Naukri checks every job before it shows (up to 24 hours): the portal id is captured at once, but "live" is only
//     claimed when the listing page confirms it (verifyPosted), otherwise the job is "please check it on the site".
// SELECTORS ARE UNVERIFIED until a DRY RUN with the company's own account (docs/job-publishing/PLAYWRIGHT.md).
// ---------------------------------------------------------------------------
const BasePortal = require('../base/BasePortal');
const { PORTALS } = require('../../jobPublish/constants');

class NaukriAdapter extends BasePortal {
  static get meta() { return { ...PORTALS.naukri }; }

  fieldValues(p) {
    const v = super.fieldValues(p);
    v.skills = (p.skills || []).slice(0, 15);
    v.experienceMin = p.experience.min == null ? null : Math.floor(p.experience.min);
    v.experienceMax = p.experience.max == null ? (p.experience.min == null ? null : Math.ceil(p.experience.min)) : Math.ceil(p.experience.max);
    v.description = String(p.description || '').slice(0, 10000);
    return v;
  }
}
module.exports = NaukriAdapter;
