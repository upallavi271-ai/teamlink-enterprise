// ---------------------------------------------------------------------------
// THE NAUKRI -> SHINE BY-HAND WORKFLOW: the pure rules (no database, no network; tests: backend/test-fixtures/jobFlow.test.js).
//
// A recruiter posts on Naukri's own recruiter site BY HAND, tells TeamLink "Naukri Posting Completed", and only then does
// Shine's recruiter site open (also by hand). TeamLink cannot see inside another site, so the only thing that moves the
// flow forward is the person's own confirmation. Nothing here ever means "posted by TeamLink".
//
//   one row per (job, platform): status, retry count, times, last error.   platform = 'naukri' | 'shine'
// ---------------------------------------------------------------------------
const STATUS = {
  SAVED: 'Requirements Saved',
  READY_NAUKRI: 'Ready to Open Naukri',
  NAUKRI_OPENED: 'Naukri Portal Opened',
  AWAIT_NAUKRI: 'Awaiting Naukri Completion',
  NAUKRI_CONFIRMED: 'Naukri Completion Confirmed',
  OPENING_SHINE: 'Opening Shine',
  SHINE_OPENED: 'Shine Portal Opened',
  SHINE_PENDING: 'Shine Manual Posting Pending',
  DONE: 'Completed by Recruiter',
  FAILED: 'Failed',
  ACTION: 'Action Required',
};
const ALL = Object.values(STATUS);
const PLATFORMS = ['naukri', 'shine'];

// What a job must have before Naukri is opened (plain words, as the screen shows them).
const REQUIRED = [
  ['title', 'Job title'], ['location', 'Location'], ['experience', 'Experience'], ['skills', 'Skills'], ['employmentType', 'Employment type'], ['description', 'Job description'],
];
function missingFields(job) {
  const j = job || {};
  const has = (v) => String(v == null ? '' : v).trim() !== '';
  const desc = j.jobDescription || j.description;
  return REQUIRED.filter(([k]) => !has(k === 'description' ? desc : j[k])).map(([, label]) => label);
}

// The next status, or null when the move is not allowed. ctx: { naukri: status of the Naukri row, standalone: bool }
// events: start | opened | await | confirm | opening | complete | fail | action | retry | unconfirm
function next(platform, from, event, ctx = {}) {
  const f = from || null;
  if (platform === 'naukri') {
    switch (event) {
      case 'start': return [null, STATUS.SAVED, STATUS.READY_NAUKRI, STATUS.FAILED, STATUS.ACTION].includes(f) ? STATUS.READY_NAUKRI : (f ? f : null);
      case 'opened': return [STATUS.READY_NAUKRI, STATUS.NAUKRI_OPENED, STATUS.AWAIT_NAUKRI, STATUS.FAILED, STATUS.ACTION].includes(f) ? STATUS.NAUKRI_OPENED : null;
      case 'await': return [STATUS.NAUKRI_OPENED, STATUS.AWAIT_NAUKRI].includes(f) ? STATUS.AWAIT_NAUKRI : null;
      // never from "Ready": a tab that was never opened is not a posting
      case 'confirm': return [STATUS.NAUKRI_OPENED, STATUS.AWAIT_NAUKRI, STATUS.NAUKRI_CONFIRMED].includes(f) ? STATUS.NAUKRI_CONFIRMED : null;
      case 'fail': return f === STATUS.NAUKRI_CONFIRMED ? null : STATUS.FAILED;
      case 'action': return f === STATUS.NAUKRI_CONFIRMED ? null : STATUS.ACTION;
      case 'retry': return [STATUS.FAILED, STATUS.ACTION].includes(f) ? STATUS.READY_NAUKRI : null;
      // "I pressed it by mistake": a confirmed step goes back to waiting (the by-hand record is removed by the service)
      case 'unconfirm': return f === STATUS.NAUKRI_CONFIRMED ? STATUS.AWAIT_NAUKRI : null;
      default: return null;
    }
  }
  if (platform === 'shine') {
    const naukriDone = ctx.naukri === STATUS.NAUKRI_CONFIRMED;
    switch (event) {
      // "Open Shine again" must always work (a lost or blocked tab), also when Shine was already marked opened
      case 'opening': return (naukriDone || ctx.standalone) && [null, STATUS.SAVED, STATUS.OPENING_SHINE, STATUS.SHINE_OPENED, STATUS.SHINE_PENDING, STATUS.FAILED, STATUS.ACTION].includes(f) ? STATUS.OPENING_SHINE : null;
      case 'opened': return [STATUS.OPENING_SHINE, STATUS.SHINE_OPENED, STATUS.SHINE_PENDING].includes(f) ? STATUS.SHINE_OPENED : null;
      case 'await': return [STATUS.SHINE_OPENED, STATUS.SHINE_PENDING].includes(f) ? STATUS.SHINE_PENDING : null;
      case 'complete': return [STATUS.SHINE_OPENED, STATUS.SHINE_PENDING, STATUS.DONE].includes(f) ? STATUS.DONE : null;
      case 'fail': return f === STATUS.DONE ? null : STATUS.FAILED;
      case 'action': return f === STATUS.DONE ? null : STATUS.ACTION;
      case 'retry': return [STATUS.FAILED, STATUS.ACTION].includes(f) ? STATUS.OPENING_SHINE : null;
      case 'unconfirm': return f === STATUS.DONE ? STATUS.SHINE_PENDING : null;
      default: return null;
    }
  }
  return null;
}

// Where the screen should be, from the saved rows (so a refresh or a new login resumes in the same place).
//   { step: 'none' | 'naukri' | 'shine' | 'done', needs: 'open' | 'confirm' | 'retry' | 'post' | null }
function resume(rows) {
  const n = (rows || []).find((r) => r.platform === 'naukri');
  const s = (rows || []).find((r) => r.platform === 'shine');
  if (s && s.status === STATUS.DONE) return { step: 'done', needs: null };
  if (s && s.status !== STATUS.SAVED) {
    if ([STATUS.FAILED, STATUS.ACTION].includes(s.status)) return { step: 'shine', needs: 'retry' };
    if (s.status === STATUS.OPENING_SHINE) return { step: 'shine', needs: 'open' };
    return { step: 'shine', needs: 'post' };
  }
  if (n) {
    if (n.status === STATUS.NAUKRI_CONFIRMED) return { step: 'shine', needs: 'open' };
    if ([STATUS.FAILED, STATUS.ACTION].includes(n.status)) return { step: 'naukri', needs: 'retry' };
    if (n.status === STATUS.READY_NAUKRI) return { step: 'naukri', needs: 'open' };
    if ([STATUS.NAUKRI_OPENED, STATUS.AWAIT_NAUKRI].includes(n.status)) return { step: 'naukri', needs: 'confirm' };
  }
  return { step: 'none', needs: null };
}

// plain words for a failure code the screen reports (popup blocked, tab closed ...)
const REASONS = {
  popup_blocked: 'Your browser blocked the new tab. Press the button again to open it, and allow pop-ups for TeamLink.',
  open_failed: 'The site did not open. Check the internet and try again.',
  tab_closed: 'The tab was closed before TeamLink was told the posting is finished.',
  not_logged_in: 'The site asked for a login. Sign in on the site yourself, then continue.',
  not_finished: 'The posting on the site was not finished yet.',
  shine_tab_missing: 'The Shine tab was closed or blocked, so Shine did not open by itself. Press Open Shine to open it now.',
};

module.exports = { STATUS, ALL, PLATFORMS, REQUIRED, missingFields, next, resume, REASONS };
