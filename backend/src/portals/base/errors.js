// ---------------------------------------------------------------------------
// The errors a portal run raises. BasePortal.run() turns each into the standard result
//   { ok:false, code, reason, retryable, needsHuman }
// so the queue never sees a raw exception.
// ---------------------------------------------------------------------------
const { ERRORS } = require('../../jobPublish/constants');

class PortalError extends Error {
  constructor(code, message, o = {}) {
    super(message || (ERRORS[code] ? ERRORS[code].words : code));
    this.name = 'PortalError';
    this.code = code;
    this.retryable = o.retryable !== undefined ? o.retryable : !!(ERRORS[code] && ERRORS[code].retry);
    this.needsHuman = o.needsHuman !== undefined ? o.needsHuman : !!(ERRORS[code] && ERRORS[code].human);
  }
}

// CAPTCHA, OTP, 2-step, "unusual activity", email check, block page: STOP and ask a person. Never solved, never bypassed.
class NeedsHuman extends PortalError {
  constructor(code, message) {
    super(code, message, { retryable: false, needsHuman: true });
    this.name = 'NeedsHuman';
  }
}

// A kill switch / pause / shutdown asked the run to stop at a safe step: the entry goes back to the queue unchanged.
class RunAborted extends Error {
  constructor(why, reason) {
    super(reason || why);
    this.name = 'RunAborted';
    this.why = why; // KILLED | SHUTDOWN
  }
}

module.exports = { PortalError, NeedsHuman, RunAborted };
