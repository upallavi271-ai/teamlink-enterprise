// ---------------------------------------------------------------------------
// WHAT TO DO FOR EACH BOARD — plain words, one place (researched 2026-10-09;
// the full table with sources is TeamLink-Posting-and-Channels-Research.md).
//
// Used by:
//   * the "Post by hand" helper  (utils/jobBoards/manual.js)  -> GUIDE[board].hand*
//   * the Connect card on Administration -> Integrations      -> CONNECT[board]
//
// Rules this file keeps:
//   * never promise something a board does not offer; "not available" is said
//     in words, never hidden;
//   * every claim that could not be verified from the board's own pages says so.
// ---------------------------------------------------------------------------

const { POST_URLS } = require('../../config/postUrls'); // where Post opens each site: one list
const GUIDE = {
  naukri: {
    name: 'Naukri',
    source: 'Naukri', // the ?src= tag on the apply link -> Source = Naukri
    openUrl: POST_URLS.naukri,
    domains: ['naukri.com'],
    skillsLabel: 'Key skills',
    order: ['title', 'type', 'location', 'experience', 'salary', 'skills', 'education', 'openings', 'description', 'apply', 'code'],
    handSteps: [
      'Copy the text from step 1 (the Copy button).',
      'Press "Open Naukri" and sign in to your Naukri recruiter account.',
      'Choose "Post a job", then paste the title, location, experience, salary, skills and the description.',
      'Submit. Naukri checks every job before it shows (it can take up to 24 hours).',
      'Come back here, paste the link of the live job if you have it, and press "I posted it".',
    ],
    handNote: 'You need a Naukri job-posting plan (credits). TeamLink never signs in to Naukri for you.',
  },
  shine: {
    name: 'Shine',
    source: 'Shine',
    openUrl: POST_URLS.shine,
    domains: ['shine.com'],
    skillsLabel: 'Skills',
    order: ['title', 'type', 'location', 'experience', 'salary', 'skills', 'education', 'openings', 'description', 'apply', 'code'],
    handSteps: [
      'Copy the text from step 1 (the Copy button).',
      'Press "Open Shine" and sign in to your Shine recruiter account.',
      'Choose "Post a job", then paste the title, location, experience, salary, skills and the description.',
      'Submit. Come back here, paste the link of the live job if Shine gave you one, and press "I posted it".',
    ],
    handNote: 'You need a Shine recruiter account with a job-posting plan. TeamLink never signs in to Shine for you.',
  },
  indeed: {
    name: 'Indeed',
    source: 'Indeed',
    openUrl: POST_URLS.indeed,
    domains: ['indeed.com', 'indeed.co.in'],
    skillsLabel: 'Skills',
    order: ['title', 'company', 'type', 'mode', 'location', 'salary', 'experience', 'skills', 'description', 'apply', 'code'],
    handSteps: [
      'Copy the text from step 1 (the Copy button).',
      'Press "Open Indeed" and sign in to your Indeed employer account (a free one works).',
      'Choose "Post a job", then paste the title, location, pay and the description.',
      'Submit. Indeed may take a few hours to show it. Come back here, paste the link of the live job and press "I posted it".',
    ],
    handNote: 'A free Indeed employer account can post a job by hand. Free jobs show lower than paid (sponsored) ones.',
  },
  linkedin: {
    name: 'LinkedIn',
    source: 'LinkedIn',
    openUrl: POST_URLS.linkedin,
    domains: ['linkedin.com'],
    skillsLabel: 'Skills',
    order: ['title', 'company', 'mode', 'location', 'type', 'experience', 'skills', 'salary', 'description', 'apply', 'code'],
    handSteps: [
      'Copy the text from step 1 (the Copy button).',
      'Press "Open LinkedIn" and sign in with the account that manages your company page.',
      'Choose "Post a job", then paste the title, location, job type and the description.',
      'Submit. Come back here, paste the link of the live job and press "I posted it".',
    ],
    handNote: 'LinkedIn may ask you to pay or promote the job. TeamLink cannot post to LinkedIn on its own (LinkedIn gives that only to approved partners).',
  },
};

// WHY the app cannot post it by itself — one plain sentence per board (Save & Post panel, 2026-10-10).
// What to do to switch it on is CONNECT[board].ask (who to ask + what to ask) and the Connect card.
const WHY = {
  naukri: 'Naukri does not give posting access to apps. Only companies on a paid Naukri plan with their partner module (Zwayam Amplify) get an access key, and Naukri gives it through your Account Manager.',
  shine: 'Shine has no posting access for apps that we could find. It may give one to partners, so we have to ask them.',
  indeed: 'Indeed lets an app post only after Indeed approves it as a partner. The other way is that Indeed reads our job feed, after your Indeed contact adds our feed link.',
  linkedin: 'LinkedIn has closed automatic posting to new apps. A person has to post it on LinkedIn.',
};

const { CONNECT } = require('./connectText');
module.exports = { GUIDE, CONNECT, WHY };
