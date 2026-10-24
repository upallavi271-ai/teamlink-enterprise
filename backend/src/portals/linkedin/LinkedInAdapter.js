// ---------------------------------------------------------------------------
// LINKEDIN adapter: STRUCTURE ONLY. AUTOMATION IS OFF, AND STAYS OFF.
//
// LinkedIn forbids programs from signing in or posting (its terms ban automated access), and its Job Posting API is
// closed to new partners. So this adapter never opens a browser and never signs in. Whatever is asked of it, it answers
// "LinkedIn forbids automation: post by hand" with needsHuman = true, so the existing by-hand task flow keeps the job
// (Clients & Requirements > Jobs > the job > Post by hand: TeamLink writes the text, a person pastes it on LinkedIn).
// The credentials screen shows LinkedIn as "Manual only"; no login is stored for it.
//
// The class exists so the registry, the dashboard and the API treat LinkedIn like every other portal (one status row,
// one by-hand task), and so the day LinkedIn offers an approved way, only this file changes.
// ---------------------------------------------------------------------------
const BasePortal = require('../base/BasePortal');
const { PORTALS } = require('../../jobPublish/constants');

const WHY = 'LinkedIn forbids automation: post by hand. TeamLink has prepared the text and kept the task.';

class LinkedInAdapter extends BasePortal {
  static get meta() { return { ...PORTALS.linkedin, automation: false, manualOnly: true }; }

  // Never opens a browser, never signs in.
  async run() {
    await this.log.warn('manual-only', WHY);
    return {
      ok: false, code: 'MANUAL_ONLY', reason: WHY, retryable: false, needsHuman: true, manualOnly: true, screenshots: [], submitted: false,
    };
  }

  async login() { throw new Error(WHY); }

  async isLoggedIn() { return false; }

  async createJob() { throw new Error(WHY); }

  async updateJob() { throw new Error(WHY); }

  async deleteJob() { throw new Error(WHY); }

  async health() {
    return {
      portal: 'linkedin', manualOnly: true, settingsOk: true, settingsProblems: [], browserFound: null, sessionSaved: false, note: WHY,
    };
  }
}
module.exports = LinkedInAdapter;
module.exports.WHY = WHY;
