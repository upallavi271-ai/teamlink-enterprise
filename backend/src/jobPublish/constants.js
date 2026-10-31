// ---------------------------------------------------------------------------
// JOB PUBLISHING: the fixed vocabulary (portals, states, actions, error codes) in one place.
// ---------------------------------------------------------------------------

// kind  browser   a Playwright adapter signs in with the company's own account and fills the portal's own form
//       internal  TeamLink's own career page: no browser, no credentials
//       manual    the portal forbids automation: a person posts by hand (the existing by-hand task flow)
//       api       an official free API with a token (Telegram Bot API, Facebook Graph API): no browser, no bot; default switch OFF
const PORTALS = {
  naukri: {
    key: 'naukri', name: 'Naukri', kind: 'browser', automation: true, legacySource: 'naukri', domains: ['naukri.com'],
    note: 'Posts through the recruiter account you save here. Naukri checks every job before it shows (up to 24 hours).',
  },
  foundit: {
    key: 'foundit', name: 'Foundit (Monster)', kind: 'browser', automation: true, legacySource: null, domains: ['foundit.in', 'monsterindia.com'],
    note: 'Posts through the recruiter account you save here.',
  },
  shine: {
    key: 'shine', name: 'Shine', kind: 'browser', automation: true, legacySource: 'shine', domains: ['shine.com'],
    note: 'Posts through the recruiter account you save here.',
  },
  linkedin: {
    key: 'linkedin', name: 'LinkedIn', kind: 'manual', automation: false, legacySource: 'linkedin', domains: ['linkedin.com'],
    note: 'LinkedIn does not allow programs to post jobs. A person posts it by hand: TeamLink prepares the text and keeps the task.',
  },
  telegram: {
    key: 'telegram', name: 'Telegram channel', kind: 'api', automation: true, legacySource: null, domains: ['api.telegram.org'],
    note: 'Posts a short message to your Telegram channel through your own bot (the official Bot API). Nothing is sent until an Admin switches it on.',
  },
  facebook: {
    key: 'facebook', name: 'Facebook page', kind: 'api', automation: true, legacySource: null, domains: ['graph.facebook.com'],
    note: 'Posts to your Facebook Page through the official Graph API with a Page access token. Nothing is sent until an Admin switches it on.',
  },
  instagram: {
    key: 'instagram', name: 'Instagram', kind: 'api', automation: true, noEdit: true, legacySource: null, domains: ['graph.facebook.com'],
    note: 'Posts a picture of the job with the text under it to your Instagram professional account, through the official Graph API (the account linked to your Facebook Page). Nothing is sent until an Admin switches it on.',
  },
  threads: {
    key: 'threads', name: 'Threads', kind: 'api', automation: true, noEdit: true, legacySource: null, domains: ['graph.threads.net'],
    note: 'Posts a short text to your Threads profile through the official Threads API. Nothing is sent until an Admin switches it on.',
  },
  linkedinpost: {
    key: 'linkedinpost', name: 'LinkedIn post', kind: 'api', automation: true, legacySource: null, domains: ['api.linkedin.com'],
    note: 'Posts a short text with the apply link to your LinkedIn profile or Company Page through the official LinkedIn API. (This is a post on the feed, not an entry in LinkedIn Jobs.) Nothing is sent until an Admin switches it on.',
  },
  career: {
    key: 'career', name: 'Career Page', kind: 'internal', automation: true, legacySource: null, legacySources: ['jobportal', 'website'], domains: [],
    note: 'TeamLink\'s own career page and Job Portal. Goes live at once, no sign-in needed.',
  },
};
const PORTAL_KEYS = Object.keys(PORTALS);
// The social channels TeamLink posts to itself through an official API with a token (one list, so no screen forgets one).
const API_PLACES = PORTAL_KEYS.filter((k) => PORTALS[k].kind === 'api');
// The mock portal exists only for the tests (never in a real list).
const portalName = (key) => (PORTALS[key] ? PORTALS[key].name : key);

const ACTIONS = ['PUBLISH', 'REPUBLISH', 'UNPUBLISH', 'UPDATE', 'VERIFY'];
const QUEUE_STATUS = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'NEEDS_HUMAN', 'DEAD', 'CANCELLED'];
const ACTIVE_STATUS = ['QUEUED', 'RUNNING']; // an entry in one of these is "in flight" (idempotency hit)
const TERMINAL_STATUS = ['SUCCEEDED', 'FAILED', 'NEEDS_HUMAN', 'DEAD', 'CANCELLED'];
const PORTAL_STATUS = ['DRAFT', 'QUEUED', 'PUBLISHED', 'FAILED', 'NEEDS_CHECK', 'UNPUBLISHED', 'EXPIRED'];
const CREDENTIAL_STATUS = ['CONNECTED', 'FAILED', 'UNVERIFIED', 'NEEDS_HUMAN', 'DISABLED'];

// The words a person reads (simple-UX rule: Job, Step, plain words).
const QUEUE_WORDS = {
  QUEUED: 'Waiting for its turn', RUNNING: 'Posting now', SUCCEEDED: 'Done', FAILED: 'Did not go through',
  NEEDS_HUMAN: 'Needs a person', DEAD: 'Gave up (tried 3 times)', CANCELLED: 'Cancelled',
};
const PORTAL_WORDS = {
  DRAFT: 'Not posted', QUEUED: 'Waiting to post', PUBLISHED: 'Live', FAILED: 'Failed',
  NEEDS_CHECK: 'Please check it on the site', UNPUBLISHED: 'Taken down', EXPIRED: 'Expired',
};

// Error codes the adapters and the runner use. `retry` = the same run may be tried again by the queue.
// A failure AFTER the Submit button was pressed is never retried by the queue (it could post twice).
const ERRORS = {
  NO_BROWSER: { retry: false, human: false, words: 'No Chrome or Edge was found on the worker machine. Install Google Chrome, or set PLAYWRIGHT_CHROME_PATH.' },
  NO_CREDENTIALS: { retry: false, human: false, words: 'No login is saved for this site yet. An Admin saves it under Company Setup, Job portal logins.' },
  NO_SECRET_KEY: { retry: false, human: false, words: 'The server has no encryption key, so a saved login cannot be read.' },
  SWITCHED_OFF: { retry: false, human: true, words: 'Automatic posting is switched off for this site.' },
  KILLED: { retry: true, human: false, words: 'Posting is paused by an Admin.' },
  WRONG_PASSWORD: { retry: false, human: false, words: 'The site did not accept the saved login (wrong username or password). Posting stops until an Admin saves the right login.' },
  CAPTCHA: { retry: false, human: true, words: 'The site is asking for a CAPTCHA.' },
  OTP: { retry: false, human: true, words: 'The site is asking for a one-time code (OTP).' },
  TWO_FACTOR: { retry: false, human: true, words: 'The site is asking for a second sign-in step (2-step verification).' },
  UNUSUAL_ACTIVITY: { retry: false, human: true, words: 'The site says it saw unusual activity on the account.' },
  EMAIL_VERIFY: { retry: false, human: true, words: 'The site is asking to verify the email address.' },
  BLOCKED: { retry: false, human: true, words: 'The site blocked the request.' },
  SELECTOR_MISSING: { retry: false, human: false, words: 'The site\'s page does not look the way TeamLink expects (the site may have changed). An Admin must update the page settings.' },
  TIMEOUT: { retry: true, human: false, words: 'The site was too slow to answer.' },
  NETWORK: { retry: true, human: false, words: 'The site could not be reached.' },
  UNVERIFIED: { retry: false, human: true, words: 'The site accepted the form, but TeamLink could not confirm the requirement is live.' },
  NO_JOB_ID: { retry: false, human: true, words: 'The site accepted the form but gave no job id or link, so TeamLink cannot say it is live.' },
  JOB_NOT_LIVE: { retry: false, human: false, words: 'This requirement is not open, so it cannot be posted.' },
  PORTAL_REJECTED: { retry: false, human: false, words: 'The site rejected the requirement.' },
  UNEXPECTED: { retry: true, human: false, words: 'Something went wrong while posting.' },
  HOST_BLOCKED: { retry: false, human: false, words: 'The browser tried to open an address that is not allowed.' },
  REAL_POSTING_OFF: { retry: false, human: true, words: 'Real posting is not allowed on this computer yet (the server owner has not set TL_ALLOW_REAL_POSTING=1). A Dry run still works.' },
  BAD_TOKEN: { retry: false, human: false, words: 'The token was not accepted (wrong, expired or revoked). Posting stops until an Admin saves a new one.' },
  CHANNEL_NOT_FOUND: { retry: false, human: false, words: 'The channel or page was not found. Check the channel name or the page number.' },
  NOT_ADMIN: { retry: false, human: false, words: 'The bot or token is not allowed to post there. Add the bot as an administrator of the channel (or give the token the posting permission).' },
  RATE_LIMITED: { retry: true, human: false, words: 'The site asked us to slow down. TeamLink tries again after the wait it asked for.' },
  API_ERROR: { retry: false, human: false, words: 'The site refused the post.' },
  MESSAGE_TOO_LONG: { retry: false, human: false, words: 'The message is longer than the site allows.' },
  SELECTORS_UNVERIFIED: { retry: false, human: true, words: 'The page settings for this site have not been checked against the real site yet, so a real post is refused. Run a Dry run and calibrate first (docs/job-publishing/CALIBRATION.md).' },
};

// The plain groups the diagnostics screen sorts failures into (one error code -> one group).
const CATEGORIES = {
  LOGIN: { words: 'Sign-in', codes: ['WRONG_PASSWORD', 'BAD_TOKEN', 'NO_CREDENTIALS', 'NO_SECRET_KEY', 'TWO_FACTOR', 'UNUSUAL_ACTIVITY', 'EMAIL_VERIFY'] },
  OTP: { words: 'One-time code (OTP)', codes: ['OTP'] },
  CAPTCHA: { words: 'CAPTCHA', codes: ['CAPTCHA'] },
  SELECTOR: { words: 'Page changed (selector drift)', codes: ['SELECTOR_MISSING'] },
  VALIDATION: { words: 'The site refused the requirement', codes: ['PORTAL_REJECTED', 'JOB_NOT_LIVE', 'API_ERROR', 'MESSAGE_TOO_LONG', 'CHANNEL_NOT_FOUND', 'NOT_ADMIN'] },
  PORTAL_DOWN: { words: 'Site down, slow or blocking', codes: ['NETWORK', 'TIMEOUT', 'BLOCKED', 'HOST_BLOCKED', 'RATE_LIMITED'] },
  GUARD: { words: 'Held back on purpose', codes: ['REAL_POSTING_OFF', 'SELECTORS_UNVERIFIED', 'SWITCHED_OFF', 'KILLED', 'NO_BROWSER'] },
  OTHER: { words: 'Other', codes: [] },
};
function categoryOf(code) {
  const hit = Object.keys(CATEGORIES).find((k) => CATEGORIES[k].codes.includes(code));
  return hit || 'OTHER';
}

// The result of the last Test connection (login check), in plain words.
const TEST_STATES = {
  NOT_TESTED: 'Not tested yet', TESTING: 'Testing now', CONNECTED: 'Connected: the login works', WRONG_LOGIN: 'The site did not accept this login',
  NEEDS_OTP: 'The site wants a one-time code (OTP)', NEEDS_CAPTCHA: 'The site shows a CAPTCHA: a person must sign in', NEEDS_CHECK: 'The site wants an extra check (2-step, e-mail or unusual activity)',
  NOT_ADMIN: 'Connected, but the bot or token is not allowed to post there', CHANNEL_NOT_FOUND: 'Connected, but the channel or page was not found', BLOCKED: 'The site blocked the request', PORTAL_DOWN: 'The site did not answer in time', PAGE_CHANGED: 'The sign-in page looks different from what TeamLink expects', NO_BROWSER: 'No Chrome or Edge on the worker computer', ERROR: 'The check did not finish',
};
const TEST_STATE_OF = {
  WRONG_PASSWORD: 'WRONG_LOGIN', BAD_TOKEN: 'WRONG_LOGIN', NOT_ADMIN: 'NOT_ADMIN', CHANNEL_NOT_FOUND: 'CHANNEL_NOT_FOUND', RATE_LIMITED: 'PORTAL_DOWN', OTP: 'NEEDS_OTP', CAPTCHA: 'NEEDS_CAPTCHA', TWO_FACTOR: 'NEEDS_CHECK', UNUSUAL_ACTIVITY: 'NEEDS_CHECK', EMAIL_VERIFY: 'NEEDS_CHECK',
  BLOCKED: 'BLOCKED', HOST_BLOCKED: 'BLOCKED', NETWORK: 'PORTAL_DOWN', TIMEOUT: 'PORTAL_DOWN', SELECTOR_MISSING: 'PAGE_CHANGED', NO_BROWSER: 'NO_BROWSER',
};

const DEFAULTS = {
  maxAttempts: 3,
  pollMs: 5000,
  staleLockMs: 5 * 60 * 1000, // a RUNNING entry whose lock is older than this was abandoned (worker died)
  heartbeatMs: 15000,
  globalConcurrency: 1, // one browser at a time: the machine has little RAM
  minGapSeconds: 30, // between two posts on one portal ...
  maxGapSeconds: 45, // ... a fixed value in this window per entry
  perHour: 10,
  perDay: 40,
  backoffBaseMs: 30000, backoffFactor: 2, backoffMaxMs: 30 * 60 * 1000, backoffJitter: 0.25,
  runDeadlineMs: 180000, // one run (login to logout) never takes longer than this (time spent waiting for a person's OTP is not counted)
  otpWaitMs: 5 * 60 * 1000, // how long a run waits, with its browser open, for a person to type the OTP
};

module.exports = {
  PORTALS, PORTAL_KEYS, API_PLACES, portalName, ACTIONS, QUEUE_STATUS, ACTIVE_STATUS, TERMINAL_STATUS, PORTAL_STATUS, CREDENTIAL_STATUS,
  QUEUE_WORDS, PORTAL_WORDS, ERRORS, DEFAULTS, CATEGORIES, categoryOf, TEST_STATES, TEST_STATE_OF,
};
